import { DomainError } from './agenda';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import {
  CreateApplicationRequest,
  ApplicationFilters,
  ApplicationResponse,
  ApplicationEventResponse,
  ApplicationActionResponse,
  SourceEmail,
  SourceSubmission,
  UpdateApplicationStatusRequest,
  deriveStatus,
} from '../contracts';
import { logError } from '../utils/log';

export class ApplicationNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('Application not found');
    this.name = 'ApplicationNotFoundError';
  }
}

export class StatusConflictError extends Error {
  readonly code = 'STATUS_CONFLICT';
  constructor() {
    super('The application status was changed elsewhere. Reload it before saving again.');
    this.name = 'StatusConflictError';
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

// Bounded evidence selection: only these fields, plus the owner needed to enforce ownership.
const sourceEmailSelect = {
  select: { id: true, userId: true, subject: true, sender: true, receivedAt: true },
} as const;

// Bounded submission evidence (ADR-0002), plus the owner needed to enforce ownership.
const sourceSubmissionSelect = {
  select: {
    id: true,
    userId: true,
    platform: true,
    destinationHost: true,
    submittedAt: true,
    confirmationText: true,
  },
} as const;
const AUTOMATION_SUBMITTED = 'AUTOMATION_SUBMITTED';

const enrichment = {
  _count: {
    select: {
      actions: { where: { status: 'PENDING', retiredAt: null } },
      // submittedVia: a linked or created automation submission (never a status).
      externalSubmissions: { where: { matchState: { in: ['LINKED', 'CREATED'] } } },
    },
  },
} satisfies Prisma.ApplicationInclude;

type EnrichedApplication = Prisma.ApplicationGetPayload<{ include: typeof enrichment }>;
type SourceRow = {
  id: string;
  userId: string;
  subject: string | null;
  sender: string | null;
  receivedAt: Date | null;
} | null;
type SubmissionRow = {
  id: string;
  userId: string;
  platform: string;
  destinationHost: string | null;
  submittedAt: Date;
  confirmationText: string | null;
} | null;
type RecentEventRow = {
  id: string;
  applicationId: string;
  type: string;
  createdAt: Date;
  email: SourceRow;
  submission: SubmissionRow;
};

/**
 * Latest recorded event per application (createdAt DESC, id DESC) with its source email.
 * The LATERAL ... LIMIT 1 bounds the read to at most one event, and then at most one email,
 * per application (S6-02); history is never loaded just to pick its newest row.
 */
async function loadRecentEvents(db: Db, applicationIds: string[]) {
  const recent = new Map<string, RecentEventRow>();
  if (!applicationIds.length) return recent;
  const events = await db.$queryRaw<
    {
      id: string;
      applicationId: string;
      type: string;
      createdAt: Date;
      emailId: string | null;
      externalSubmissionId: string | null;
    }[]
  >`
    SELECT e.id, e."applicationId", e.type, e."createdAt", e."emailId", e."externalSubmissionId"
    FROM unnest(${applicationIds}::uuid[]) AS a(id)
    CROSS JOIN LATERAL (
      SELECT id, "applicationId", type, "createdAt", "emailId", "externalSubmissionId"
      FROM application_events
      WHERE "applicationId" = a.id AND "retiredAt" IS NULL
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1
    ) e`;
  const emailIds = events.flatMap((e) => (e.emailId ? [e.emailId] : []));
  const emails = emailIds.length
    ? await db.email.findMany({ where: { id: { in: emailIds } }, ...sourceEmailSelect })
    : [];
  const byId = new Map(emails.map((email) => [email.id, email]));
  const submissionIds = events.flatMap((e) =>
    e.externalSubmissionId ? [e.externalSubmissionId] : [],
  );
  const submissions = submissionIds.length
    ? await db.externalSubmission.findMany({
        where: { id: { in: submissionIds } },
        ...sourceSubmissionSelect,
      })
    : [];
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));
  for (const event of events)
    recent.set(event.applicationId, {
      id: event.id,
      applicationId: event.applicationId,
      type: event.type,
      createdAt: event.createdAt,
      email: event.emailId ? (byId.get(event.emailId) ?? null) : null,
      submission: event.externalSubmissionId
        ? (submissionById.get(event.externalSubmissionId) ?? null)
        : null,
    });
  return recent;
}

/**
 * Returns owned source metadata, or null when unavailable. A source owned by someone else can
 * only exist through inconsistent legacy data; it is never disclosed (not even its ID).
 */
function toSourceEmail(
  userId: string,
  source: SourceRow,
  context: { applicationId: string; eventId: string },
): { sourceEmail: SourceEmail | null; foreign: boolean } {
  if (!source) return { sourceEmail: null, foreign: false };
  if (source.userId !== userId) {
    logError('evidence_ownership_mismatch', { ...context });
    return { sourceEmail: null, foreign: true };
  }
  return {
    sourceEmail: {
      id: source.id,
      subject: source.subject,
      sender: source.sender,
      receivedAt: source.receivedAt ? source.receivedAt.toISOString() : null,
    },
    foreign: false,
  };
}

/**
 * What the automation reported behind an AUTOMATION_SUBMITTED event, owner-checked like
 * toSourceEmail. null for every other event type, or when the evidence is unavailable.
 */
function toSourceSubmission(
  userId: string,
  type: string,
  source: SubmissionRow,
  context: { applicationId: string; eventId: string },
): SourceSubmission | null {
  if (type !== AUTOMATION_SUBMITTED || !source) return null;
  if (source.userId !== userId) {
    logError('evidence_ownership_mismatch', { kind: 'submission', ...context });
    return null;
  }
  return {
    platform: source.platform,
    destinationHost: source.destinationHost,
    submittedAt: source.submittedAt.toISOString(),
    confirmationText: source.confirmationText,
  };
}

export class ApplicationService {
  static async createApplication(
    userId: string,
    data: CreateApplicationRequest,
  ): Promise<ApplicationResponse> {
    const application = await prisma.application.create({
      data: {
        userId,
        companyName: data.companyName,
        jobTitle: data.jobTitle,
        location: data.location,
        appliedAt: data.appliedAt ? new Date(data.appliedAt as string) : null,
      },
      include: enrichment,
    });

    return this.mapToResponse(userId, application, null); // a new application has no history
  }

  static async listApplications(
    userId: string,
    limit: number = 20,
    offset: number = 0,
    filters: ApplicationFilters = {},
  ): Promise<ApplicationResponse[]> {
    // Prisma's PostgreSQL contains operator uses LIKE: preserve literal %, _ and backslash.
    const search = filters.q?.replace(/[\\%_]/g, '\\$&');
    const orderBy: Prisma.ApplicationOrderByWithRelationInput[] =
      filters.sort === 'applied_desc' || filters.sort === 'applied_asc'
        ? [{ appliedAt: { sort: filters.sort === 'applied_desc' ? 'desc' : 'asc', nulls: 'last' } }, { id: 'desc' }]
        : filters.sort === 'company_asc'
          ? [{ companyName: 'asc' }, { id: 'desc' }]
          : [{ createdAt: 'desc' }, { id: 'desc' }];
    const applications = await prisma.application.findMany({
      where: {
        userId,
        ...(filters.archive === 'all' ? {} : { archivedAt: filters.archive === 'archived' ? { not: null } : null }),
        ...(filters.submittedVia ? {
          externalSubmissions: { some: { userId, matchState: { in: ['LINKED', 'CREATED'] } } },
        } : {}),
        AND: [
          ...(search
            ? [
                {
                  OR: [
                    { companyName: { contains: search, mode: 'insensitive' as const } },
                    { jobTitle: { contains: search, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
          ...(filters.effectiveStatus
            ? filters.effectiveStatus === 'UNKNOWN'
              ? [{ userStatus: null, aiStatus: null }]
              : [
                {
                  OR: [
                    { userStatus: filters.effectiveStatus },
                    { userStatus: null, aiStatus: filters.effectiveStatus },
                  ],
                },
              ]
            : []),
        ],
      },
      take: limit + 1,
      skip: offset,
      orderBy,
      include: enrichment,
    });

    const recent = await loadRecentEvents(
      prisma,
      applications.map((app) => app.id),
    );
    return applications.map((app) => this.mapToResponse(userId, app, recent.get(app.id) ?? null));
  }

  static async getApplication(
    userId: string,
    id: string,
    db: Db = prisma,
  ): Promise<ApplicationResponse | null> {
    const app = await db.application.findFirst({ where: { id, userId }, include: enrichment });
    if (!app) return null;
    const recent = await loadRecentEvents(db, [app.id]);
    return this.mapToResponse(userId, app, recent.get(app.id) ?? null);
  }

  /**
   * Owned manual status correction. One transaction locks the application row by id AND owner,
   * compares the manual revision BEFORE no-op detection, then writes only manual fields.
   * Locks no email (compatible with matcher's email → application order), makes no external call,
   * enqueues nothing and never touches aiStatus, events, actions or AI operation/budget records.
   */
  static async updateUserStatus(
    userId: string,
    id: string,
    request: UpdateApplicationStatusRequest,
  ): Promise<{ application: ApplicationResponse; changed: boolean }> {
    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { userStatus: string | null; userStatusRevision: number; archivedAt: Date | null }[]
      >`
        SELECT "userStatus", "userStatusRevision", "archivedAt" FROM applications
        WHERE id = ${id}::uuid AND "userId" = ${userId}::uuid
        FOR UPDATE`;
      if (!locked.length) throw new ApplicationNotFoundError();
      const current = locked[0];
      if (current.archivedAt) throw new DomainError('APPLICATION_ARCHIVED');
      if (current.userStatusRevision !== request.expectedUserStatusRevision)
        throw new StatusConflictError();

      const changed = current.userStatus !== request.userStatus;
      if (changed) {
        await tx.application.update({
          where: { id },
          data: {
            userStatus: request.userStatus,
            userStatusSetAt: request.userStatus === null ? null : new Date(),
            userStatusRevision: { increment: 1 },
          },
        });
      }
      // Same transaction snapshot as the acknowledged write.
      const application = await this.getApplication(userId, id, tx);
      if (!application) throw new ApplicationNotFoundError();
      return { application, changed };
    });
  }

  /**
   * Returns the timeline events for a specific application.
   * Verifies that the application belongs to the requesting user.
   * Ordered by recording time (createdAt ASC, then id ASC) — not a recruitment chronology.
   */
  static async getApplicationEvents(
    userId: string,
    applicationId: string,
    limit = 20,
    offset = 0,
  ): Promise<ApplicationEventResponse[] | null> {
    // Verify ownership before returning any data
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { userId: true },
    });

    if (!app) return null;
    if (app.userId !== userId) return null; // caller should return 403

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId },
      take: limit + 1,
      skip: offset,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // deterministic recording order
      select: {
        id: true,
        retiredAt: true,
        retiredReason: true,
        applicationId: true,
        emailId: true,
        type: true,
        oldState: true,
        newState: true,
        description: true,
        provenance: true,
        createdAt: true,
        email: sourceEmailSelect, // one bounded relation query for the page
        externalSubmission: sourceSubmissionSelect, // AUTOMATION_SUBMITTED evidence only
      },
    });

    // Provenance of the AI result behind each event: one bounded query, owned source emails only.
    const owned = events.flatMap((e) => (e.email && e.email.userId === userId ? [e.email.id] : []));
    const provenance = new Map(
      (owned.length
        ? await prisma.aIProcessingResult.findMany({
            where: { emailId: { in: owned } },
            select: { emailId: true, provider: true, model: true },
          })
        : []
      ).map((r) => [r.emailId, { provider: r.provider, model: r.model }]),
    );

    return events.map((e) => {
      const { sourceEmail, foreign } = toSourceEmail(userId, e.email, {
        applicationId,
        eventId: e.id,
      });
      return {
        id: e.id,
        retiredAt: e.retiredAt?.toISOString() ?? null,
        retiredReason: e.retiredReason,
        applicationId: e.applicationId,
        emailId: foreign ? null : e.emailId,
        type: e.type,
        oldState: e.oldState as ApplicationEventResponse['oldState'],
        newState: e.newState as ApplicationEventResponse['newState'],
        description: e.description,
        provenance: e.provenance,
        createdAt: e.createdAt,
        recordedAt: e.createdAt.toISOString(),
        sourceEmail,
        analyzedBy: sourceEmail ? (provenance.get(sourceEmail.id) ?? null) : null,
        sourceSubmission: toSourceSubmission(userId, e.type, e.externalSubmission, {
          applicationId,
          eventId: e.id,
        }),
      };
    });
  }

  /**
   * Returns the actions for a specific application.
   * Verifies that the application belongs to the requesting user.
   * Ordered by deadline ASC (PENDING first), then createdAt ASC.
   */
  static async getApplicationActions(
    userId: string,
    applicationId: string,
    limit = 20,
    offset = 0,
  ): Promise<ApplicationActionResponse[] | null> {
    // Verify ownership
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { userId: true },
    });

    if (!app) return null;
    if (app.userId !== userId) return null;

    const actions = await prisma.action.findMany({
      where: { applicationId, retiredAt: null },
      take: limit + 1,
      skip: offset,
      orderBy: [
        { status: 'desc' }, // PENDING before DISMISSED and COMPLETED
        { deadline: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      select: {
        id: true,
        applicationId: true,
        emailId: true,
        type: true,
        description: true,
        deadline: true,
        deadlinePrecision: true,
        origin: true, actionRevision: true, clientRequestId: true, snoozedUntil: true,
        status: true,
        createdAt: true,
      },
    });

    return actions.map((a) => ({
      id: a.id,
      applicationId: a.applicationId,
      emailId: a.emailId,
      type: a.type,
      description: a.description,
      deadline: a.deadline,
      deadlinePrecision: a.deadlinePrecision,
      origin: a.origin === 'USER' ? 'USER' : a.emailId ? 'EMAIL' : null, actionRevision: a.actionRevision, clientRequestId: a.clientRequestId, snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
      status: a.status,
      createdAt: a.createdAt,
    }));
  }

  /** The single response mapper for create, list, detail and status PATCH. */
  private static mapToResponse(
    userId: string,
    app: EnrichedApplication,
    recent: RecentEventRow | null,
  ): ApplicationResponse {
    const aiStatus = app.aiStatus as ApplicationResponse['aiStatus'];
    const userStatus = app.userStatus as ApplicationResponse['userStatus'];
    return {
      id: app.id,
      archivedAt: app.archivedAt?.toISOString() ?? null,
      archiveRevision: app.archiveRevision,
      companyName: app.companyName,
      jobTitle: app.jobTitle,
      location: app.location,
      aiStatus,
      userStatus,
      userStatusSetAt: app.userStatusSetAt,
      userStatusRevision: app.userStatusRevision,
      ...deriveStatus(aiStatus, userStatus),
      appliedAt: app.appliedAt,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      recentEvent: recent
        ? {
            type: recent.type,
            createdAt: recent.createdAt,
            recordedAt: recent.createdAt.toISOString(),
            sourceEmail: toSourceEmail(userId, recent.email, {
              applicationId: app.id,
              eventId: recent.id,
            }).sourceEmail,
            sourceSubmission: toSourceSubmission(userId, recent.type, recent.submission, {
              applicationId: app.id,
              eventId: recent.id,
            }),
          }
        : null,
      pendingActionCount: app._count.actions,
      submittedVia: app._count.externalSubmissions > 0 ? 'AUTOMATION' : null,
    };
  }
}
