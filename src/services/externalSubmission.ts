import { AppError, CHANGE_REJECTED } from '../errors';
/**
 * Automation submission intake and review (ADR-0002 decisions 5–8).
 *
 * Domain only: no MCP code. The automation reports one confirmed submission per call, keyed by
 * `sourceRecordRef`. Each call runs as one transaction under a per-user advisory lock: check the
 * ref, check the daily cap, then insert, match and create or link together with the
 * AUTOMATION_SUBMITTED event. Matching is conservative and separate from the Gmail matcher:
 * anything uncertain goes to review. aiStatus and userStatus are never written.
 */
import { ExternalSubmission, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { LOCK_NAMESPACE, lockUser } from '../utils/advisoryLock';
import { submissionDailyLimit } from '../utils/config';

export const SUBMISSION_PLATFORMS = [
  'linkedin',
  'indeed',
  'naukri',
  'wellfound',
  'instahyre',
  'workday',
  'company_direct',
  'discovery',
] as const;
export const AUTOMATION_SUBMITTED = 'AUTOMATION_SUBMITTED';
const CONFIRMATION_TEXT_LIMIT = 300;
export const SUBMITTED_ANSWERS_LIMIT = 50;
const QUESTION_LIMIT = 500;
const ANSWER_LIMIT = 2000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const JOB_URL_QUERY_ALLOWLIST = new Set(['jk', 'currentJobId', 'gh_jid', 'jobId']);
const LEGAL_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'ltd',
  'limited',
  'pvt',
  'private',
  'corp',
  'corporation',
  'co',
  'plc',
  'gmbh',
]);

// Optional fields may be omitted or null; both mean "not reported".
const optionalText = (max: number) => z.string().trim().max(max).nullish();

const httpUrl = () =>
  z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullish();

/**
 * The tool contract (ADR-0002, v1, amended 21 Oct 2026 with the apply page link, the resume file
 * name and the submitted answers). Strict: unknown keys are rejected, so there is no field for
 * resume content or credentials. Required strings are trimmed before their length check.
 */
export const RecordApplicationSubmissionInputSchema = z.strictObject({
  sourceRecordRef: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}\/\d{2}:\d{2}:\d{2}$/)
    .describe(
      'YYYY-MM-DD/HH:MM:SS from the daily file folder and the entry heading time, copied verbatim',
    ),
  platform: z
    .enum(SUBMISSION_PLATFORMS)
    .describe(
      'The application workflow actually used (workday whenever a Workday form was used); never the discovery source',
    ),
  company: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().min(1).max(200),
  submittedAt: z.iso
    .datetime({ offset: true })
    .describe('ISO 8601 with UTC offset, when the site confirmed the submission'),
  jobUrl: httpUrl(),
  portalJobId: optionalText(200),
  destinationHost: z.hostname().max(253).nullish(),
  discoverySource: optionalText(100),
  location: optionalText(200),
  workMode: z.enum(['remote', 'hybrid', 'onsite']).nullish(),
  confirmationText: z
    .string()
    .nullish()
    .describe('The confirmation the site showed; longer text is truncated to 300 characters'),
  applyUrl: httpUrl().describe('Full http or https URL of the page where the form was submitted'),
  resumeFilename: optionalText(255).describe('File name of the resume used, never its content'),
  submittedAnswers: z
    .array(
      z.strictObject({
        question: z.string().trim().min(1).max(QUESTION_LIMIT),
        answer: z.string().trim().max(ANSWER_LIMIT),
      }),
    )
    .max(SUBMITTED_ANSWERS_LIMIT)
    .nullish()
    .describe('Every screening question and the answer given, as written in the daily file'),
});

export type SubmissionResult = 'created' | 'linked' | 'needs_review' | 'already_recorded';

/** Expected intake outcomes. `fields` holds field names only, never submitted values. */
export class SubmissionIntakeError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'rate_limited',
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
    this.name = 'SubmissionIntakeError';
  }
}

/** The stored form of one submission: trimmed, canonical, empty optional values as null. */
export interface CanonicalSubmission {
  sourceRecordRef: string;
  platform: (typeof SUBMISSION_PLATFORMS)[number];
  company: string;
  jobTitle: string;
  submittedAt: Date;
  jobUrl: string | null;
  portalJobId: string | null;
  destinationHost: string | null;
  discoverySource: string | null;
  location: string | null;
  workMode: string | null;
  confirmationText: string | null;
  applyUrl: string | null;
  resumeFilename: string | null;
  /** null when none were reported. */
  submittedAnswers: { question: string; answer: string }[] | null;
}

const KNOWN_FIELDS = new Set(Object.keys(RecordApplicationSubmissionInputSchema.shape));

/** Field names of a failed validation. Unknown keys are reported by name; values never are. */
function invalidFields(issues: z.core.$ZodIssue[]): string[] {
  const fields = new Set<string>();
  for (const issue of issues) {
    // A nested unknown key (inside an answer) is reported by its top-level field.
    if (issue.code === 'unrecognized_keys' && !issue.path.length)
      issue.keys.forEach((k) => fields.add(k));
    else fields.add(issue.path.length ? String(issue.path[0]) : '(input)');
  }
  return [...fields];
}

/** Field names safe to log: known schema fields, with unknown keys counted rather than named. */
export function loggableFields(fields: string[]) {
  return {
    invalidFields: fields.filter((f) => KNOWN_FIELDS.has(f) || f === '(input)'),
    unknownKeyCount: fields.filter((f) => !KNOWN_FIELDS.has(f) && f !== '(input)').length,
  };
}

/** Keeps the full address, query included, but drops the fragment and any user name or password. */
export function canonicalApplyUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString();
}

/** Drops the fragment and any user name or password, and keeps only the job-ID query parameters. */
export function canonicalJobUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.username = '';
  url.password = '';
  const kept = [...url.searchParams].filter(([key]) => JOB_URL_QUERY_ALLOWLIST.has(key));
  url.search = kept.length ? new URLSearchParams(kept).toString() : '';
  return url.toString();
}

const blankToNull = (value: string | null | undefined) => (value ? value : null);

export function parseSubmissionInput(raw: unknown, now = new Date()): CanonicalSubmission {
  const parsed = RecordApplicationSubmissionInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new SubmissionIntakeError(
      'invalid_input',
      'The submission does not match the tool contract.',
      invalidFields(parsed.error.issues),
    );
  const input = parsed.data;
  const submittedAt = new Date(input.submittedAt);
  if (submittedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS)
    throw new SubmissionIntakeError('invalid_input', 'submittedAt is in the future.', [
      'submittedAt',
    ]);
  const confirmation = input.confirmationText?.trim();
  return {
    sourceRecordRef: input.sourceRecordRef,
    platform: input.platform,
    company: input.company,
    jobTitle: input.jobTitle,
    submittedAt,
    jobUrl: input.jobUrl ? canonicalJobUrl(input.jobUrl) : null,
    portalJobId: blankToNull(input.portalJobId),
    destinationHost: input.destinationHost ? input.destinationHost.toLowerCase() : null,
    discoverySource: blankToNull(input.discoverySource),
    location: blankToNull(input.location),
    workMode: input.workMode ?? null,
    // Truncated, never rejected; by code point so a character is never split.
    confirmationText: confirmation
      ? Array.from(confirmation).slice(0, CONFIRMATION_TEXT_LIMIT).join('')
      : null,
    applyUrl: input.applyUrl ? canonicalApplyUrl(input.applyUrl) : null,
    resumeFilename: blankToNull(input.resumeFilename),
    submittedAnswers: input.submittedAnswers?.length ? input.submittedAnswers : null,
  };
}

// ─── Matching keys (ADR-0002 decision 7 plus the edge-case rules below) ─────

/** The existing normalization, shared with the Gmail matcher's behaviour: lowercase a–z and 0–9 only. */
export const titleKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Like titleKey, after dropping trailing legal-suffix words (always keeping the first word). */
export function companyKey(name: string): string {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join('');
}

type Candidate = { id: string; companyName: string; jobTitle: string | null };
export type MatchDecision =
  { state: 'CREATED' } | { state: 'LINKED'; applicationId: string } | { state: 'NEEDS_REVIEW' };

/**
 * C = same company key; E = those in C with the same title key; N = those in C with no title.
 * C empty → CREATED. Exactly one in E and N empty → LINKED. Anything else → NEEDS_REVIEW.
 * An empty submission key never matches and goes to review.
 */
export function decideMatch(
  submission: Pick<CanonicalSubmission, 'company' | 'jobTitle'>,
  applications: Candidate[],
): MatchDecision {
  const company = companyKey(submission.company);
  const title = titleKey(submission.jobTitle);
  if (!company || !title) return { state: 'NEEDS_REVIEW' };
  const sameCompany = applications.filter((app) => companyKey(app.companyName) === company);
  if (!sameCompany.length) return { state: 'CREATED' };
  const untitled = sameCompany.filter((app) => !app.jobTitle || !titleKey(app.jobTitle));
  const sameTitle = sameCompany.filter((app) => app.jobTitle && titleKey(app.jobTitle) === title);
  if (sameTitle.length === 1 && !untitled.length)
    return { state: 'LINKED', applicationId: sameTitle[0].id };
  return { state: 'NEEDS_REVIEW' };
}

// ─── Shared create/link effects (automatic path and user review) ────────────

type Tx = Prisma.TransactionClient;

async function createApplicationFrom(
  tx: Tx,
  userId: string,
  submission: Pick<ExternalSubmission, 'company' | 'jobTitle' | 'location' | 'submittedAt'>,
) {
  const app = await tx.application.create({
    data: {
      userId,
      companyName: submission.company,
      jobTitle: submission.jobTitle,
      location: submission.location,
      appliedAt: submission.submittedAt,
    },
    select: { id: true },
  });
  return app.id;
}

/** Locks the owned application; false when it no longer exists for this user. Sets appliedAt only if empty. */
async function linkApplication(
  tx: Tx,
  userId: string,
  applicationId: string,
  submittedAt: Date,
  explicit = false,
) {
  const locked = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`
    SELECT id, "archivedAt" FROM applications WHERE id = ${applicationId}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`;
  if (!locked.length) return false;
  if (locked[0].archivedAt) {
    if (explicit) throw new AppError(409, 'APPLICATION_ARCHIVED', CHANGE_REJECTED);
    return false;
  }
  await tx.application.updateMany({
    where: { id: applicationId, appliedAt: null },
    data: { appliedAt: submittedAt },
  });
  return true;
}

const addEvent = (tx: Tx, applicationId: string, externalSubmissionId: string) =>
  tx.applicationEvent.create({
    data: { applicationId, type: AUTOMATION_SUBMITTED, externalSubmissionId },
  });

// ─── Intake ─────────────────────────────────────────────────────────────────

const startOfUtcDay = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const STORED_FIELDS = [
  'platform',
  'company',
  'jobTitle',
  'jobUrl',
  'portalJobId',
  'destinationHost',
  'discoverySource',
  'location',
  'workMode',
  'confirmationText',
  'applyUrl',
  'resumeFilename',
] as const;
/** Optional fields a repeat may fill while they are still empty. */
const FILLABLE_FIELDS = [
  'jobUrl',
  'portalJobId',
  'destinationHost',
  'discoverySource',
  'location',
  'workMode',
  'confirmationText',
  'applyUrl',
  'resumeFilename',
] as const;
function payloadDiffers(stored: ExternalSubmission, incoming: CanonicalSubmission) {
  return (
    stored.submittedAt.getTime() !== incoming.submittedAt.getTime() ||
    STORED_FIELDS.some((field) => (stored[field] ?? null) !== (incoming[field] ?? null)) ||
    answersKey(stored.submittedAnswers) !== answersKey(incoming.submittedAnswers)
  );
}

/** Answers as [question, answer] pairs: the database may store an object's keys in another order. */
const answersKey = (answers: unknown) =>
  JSON.stringify(
    Array.isArray(answers)
      ? answers.map((a: { question?: unknown; answer?: unknown }) => [a.question, a.answer])
      : null,
  );

/** What a repeat adds: only fields that are empty in the stored record. Saved values never change. */
export function fillEmptyFields(stored: ExternalSubmission, incoming: CanonicalSubmission) {
  const fill: Prisma.ExternalSubmissionUpdateInput = {};
  for (const field of FILLABLE_FIELDS)
    if (stored[field] === null && incoming[field] !== null) fill[field] = incoming[field];
  if (stored.submittedAnswers === null && incoming.submittedAnswers)
    fill.submittedAnswers = incoming.submittedAnswers;
  return fill;
}

export interface IntakeOutcome {
  result: SubmissionResult;
  recordId: string;
  /** Only for already_recorded: whether the repeat differed from the stored record (logged, never returned to the client). */
  payloadDiffered?: boolean;
}

/** A repeat of a stored entry: fills its empty fields; null when the entry is new. */
async function repeatOf(
  db: Tx | typeof prisma,
  ref: { userId: string; source: 'AUTOMATION'; sourceRecordRef: string },
  submission: CanonicalSubmission,
): Promise<IntakeOutcome | null> {
  const stored = await db.externalSubmission.findUnique({
    where: { userId_source_sourceRecordRef: ref },
  });
  if (!stored) return null;
  const fill = fillEmptyFields(stored, submission);
  if (Object.keys(fill).length)
    await db.externalSubmission.update({ where: { id: stored.id }, data: fill });
  return {
    result: 'already_recorded',
    recordId: stored.id,
    payloadDiffered: payloadDiffers(stored, submission),
  };
}

const RESULT_OF = { CREATED: 'created', LINKED: 'linked', NEEDS_REVIEW: 'needs_review' } as const;
const TX_OPTIONS = { maxWait: 5000, timeout: 10000 };

/**
 * Records one confirmed submission for the token's user. Idempotent on
 * (user, AUTOMATION, sourceRecordRef): a repeat returns already_recorded and only fills fields
 * that are still empty; a saved value is never changed and the match is never redone.
 */
export async function recordSubmission(
  userId: string,
  tokenId: string | null,
  raw: unknown,
  now = new Date(),
): Promise<IntakeOutcome> {
  const submission = parseSubmissionInput(raw, now);
  const limit = submissionDailyLimit();
  const ref = {
    userId,
    source: 'AUTOMATION' as const,
    sourceRecordRef: submission.sourceRecordRef,
  };
  const existing = (db: Tx | typeof prisma) => repeatOf(db, ref, submission);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockUser(tx, LOCK_NAMESPACE.externalSubmissions, userId);
      // Checked before insert: a unique violation inside an interactive transaction aborts it.
      const repeat = await existing(tx);
      if (repeat) return repeat;
      const today = await tx.externalSubmission.count({
        where: { userId, receivedAt: { gte: startOfUtcDay(now) } },
      });
      if (today >= limit)
        throw new SubmissionIntakeError(
          'rate_limited',
          'The daily submission limit is reached. Retry the next UTC day.',
        );

      const candidates = await tx.application.findMany({
        where: { userId },
        select: { id: true, companyName: true, jobTitle: true, archivedAt: true },
      });
      const active = candidates.filter((app) => !app.archivedAt);
      let decision = decideMatch(submission, active);
      // An archived company candidate cannot become a silently duplicated new application.
      if (
        decision.state === 'CREATED' &&
        candidates.some(
          (app) => app.archivedAt && companyKey(app.companyName) === companyKey(submission.company),
        )
      )
        decision = { state: 'NEEDS_REVIEW' };
      let applicationId: string | null = null;
      if (decision.state === 'CREATED')
        applicationId = await createApplicationFrom(tx, userId, submission);
      if (decision.state === 'LINKED') {
        // The application can disappear between the read and the lock; then a person decides.
        if (await linkApplication(tx, userId, decision.applicationId, submission.submittedAt))
          applicationId = decision.applicationId;
        else decision = { state: 'NEEDS_REVIEW' };
      }
      const settled = decision.state !== 'NEEDS_REVIEW';
      const { submittedAnswers, ...fields } = submission;
      const record = await tx.externalSubmission.create({
        data: {
          ...ref,
          ...fields,
          submittedAnswers: submittedAnswers ?? Prisma.DbNull,
          receivedAt: now,
          tokenId,
          matchState: decision.state,
          resolvedBy: settled ? 'AUTOMATIC' : null,
          resolvedAt: settled ? now : null,
          applicationId,
        },
        select: { id: true },
      });
      if (applicationId) await addEvent(tx, applicationId, record.id);
      return { result: RESULT_OF[decision.state], recordId: record.id };
    }, TX_OPTIONS);
  } catch (err) {
    // Defensive: the lock makes this unreachable, but a duplicate ref is always a replay.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const repeat = await existing(prisma);
      if (repeat) return repeat;
    }
    throw err;
  }
}

// ─── Review ─────────────────────────────────────────────────────────────────

export type ResolveAction =
  { action: 'link'; applicationId: string } | { action: 'create' } | { action: 'ignore' };

// Same codes and messages as the email resolve route.
const notResolvable = () =>
  new AppError(400, 'BAD_REQUEST', 'Submission is not in a resolvable state.');

/**
 * Final user resolution of a NEEDS_REVIEW submission, under the same per-user lock as intake.
 * link → LINKED (appliedAt only if empty), create → CREATED (as the automatic path), ignore → IGNORED.
 */
export async function resolveSubmission(
  userId: string,
  submissionId: string,
  resolution: ResolveAction,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.externalSubmissions, userId);
    const submission = await tx.externalSubmission.findFirst({
      where: { id: submissionId, userId },
    });
    if (!submission) throw new AppError(404, 'NOT_FOUND', 'Submission not found.');
    if (submission.matchState !== 'NEEDS_REVIEW') throw notResolvable();

    let applicationId: string | null = null;
    if (resolution.action === 'create')
      applicationId = await createApplicationFrom(tx, userId, submission);
    if (resolution.action === 'link') {
      if (
        await tx.application.findFirst({
          where: { id: resolution.applicationId, userId, archivedAt: { not: null } },
        })
      )
        throw new AppError(409, 'APPLICATION_ARCHIVED', CHANGE_REJECTED);
      if (
        !(await linkApplication(tx, userId, resolution.applicationId, submission.submittedAt, true))
      )
        throw new AppError(403, 'FORBIDDEN', 'Application not found or access denied.');
      applicationId = resolution.applicationId;
    }
    const matchState = ({ link: 'LINKED', create: 'CREATED', ignore: 'IGNORED' } as const)[
      resolution.action
    ];
    // Conditional on the state read under the lock: a resolution is final.
    const updated = await tx.externalSubmission.updateMany({
      where: { id: submissionId, userId, matchState: 'NEEDS_REVIEW' },
      data: { matchState, resolvedBy: 'USER', resolvedAt: now, applicationId },
    });
    if (updated.count !== 1) throw notResolvable();
    if (applicationId) await addEvent(tx, applicationId, submissionId);
    return { id: submissionId, matchState, applicationId };
  }, TX_OPTIONS);
}

export async function listPendingSubmissions(userId: string, limit: number, offset: number) {
  return prisma.externalSubmission.findMany({
    where: { userId, matchState: 'NEEDS_REVIEW' },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    skip: offset,
    select: {
      id: true,
      sourceRecordRef: true,
      platform: true,
      company: true,
      jobTitle: true,
      submittedAt: true,
      receivedAt: true,
      jobUrl: true,
      portalJobId: true,
      destinationHost: true,
      discoverySource: true,
      location: true,
      workMode: true,
      confirmationText: true,
    },
  });
}

/** Everything the automation reported behind one owned application, newest first; null if not owned. */
export async function listApplicationSubmissions(userId: string, applicationId: string) {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, userId },
    select: { id: true },
  });
  if (!app) return null;
  return prisma.externalSubmission.findMany({
    where: { userId, applicationId, matchState: { in: ['LINKED', 'CREATED'] } },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      sourceRecordRef: true,
      matchState: true,
      platform: true,
      company: true,
      jobTitle: true,
      submittedAt: true,
      receivedAt: true,
      jobUrl: true,
      applyUrl: true,
      portalJobId: true,
      destinationHost: true,
      discoverySource: true,
      location: true,
      workMode: true,
      confirmationText: true,
      resumeFilename: true,
      submittedAnswers: true,
    },
  });
}
