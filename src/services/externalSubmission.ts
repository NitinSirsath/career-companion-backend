import { DomainError } from './agenda';
/**
 * Automation submission intake and review (ADR-0002 decisions 5–8; MCP-03, MCP-05).
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
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const JOB_URL_QUERY_ALLOWLIST = new Set(['jk', 'currentJobId', 'gh_jid', 'jobId']);
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'pvt', 'private', 'corp', 'corporation', 'co', 'plc', 'gmbh',
]);
const DEFAULT_DAILY_SUBMISSION_LIMIT = 500;

// Optional fields may be omitted or null; both mean "not reported".
const optionalText = (max: number) => z.string().trim().max(max).nullish();

/**
 * The tool contract (ADR-0002, v1). Strict: unknown keys are rejected, so there is no field for
 * answers, resume data or credentials. Required strings are trimmed before their length check.
 */
export const RecordApplicationSubmissionInputSchema = z.strictObject({
  sourceRecordRef: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}\/\d{2}:\d{2}:\d{2}$/)
    .describe('YYYY-MM-DD/HH:MM:SS from the daily file folder and the entry heading time, copied verbatim'),
  platform: z
    .enum(SUBMISSION_PLATFORMS)
    .describe('The application workflow actually used (workday whenever a Workday form was used); never the discovery source'),
  company: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().min(1).max(200),
  submittedAt: z.iso
    .datetime({ offset: true })
    .describe('ISO 8601 with UTC offset, when the site confirmed the submission'),
  jobUrl: z.url({ protocol: /^https?$/ }).max(2048).nullish(),
  portalJobId: optionalText(200),
  destinationHost: z.hostname().max(253).nullish(),
  discoverySource: optionalText(100),
  location: optionalText(200),
  workMode: z.enum(['remote', 'hybrid', 'onsite']).nullish(),
  confirmationText: z
    .string()
    .nullish()
    .describe('The confirmation the site showed; longer text is truncated to 300 characters'),
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
}

const KNOWN_FIELDS = new Set(Object.keys(RecordApplicationSubmissionInputSchema.shape));

/** Field names of a failed validation. Unknown keys are reported by name; values never are. */
function invalidFields(issues: z.core.$ZodIssue[]): string[] {
  const fields = new Set<string>();
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') issue.keys.forEach((k) => fields.add(k));
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
    throw new SubmissionIntakeError('invalid_input', 'The submission does not match the tool contract.', invalidFields(parsed.error.issues));
  const input = parsed.data;
  const submittedAt = new Date(input.submittedAt);
  if (submittedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS)
    throw new SubmissionIntakeError('invalid_input', 'submittedAt is in the future.', ['submittedAt']);
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
    confirmationText: confirmation ? Array.from(confirmation).slice(0, CONFIRMATION_TEXT_LIMIT).join('') : null,
  };
}

// ─── Matching keys (ADR-0002 decision 7 plus the MCP-03 edge-case rules) ────

/** The existing normalization, shared with the Gmail matcher's behaviour: lowercase a–z and 0–9 only. */
export const titleKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Like titleKey, after dropping trailing legal-suffix words (always keeping the first word). */
export function companyKey(name: string): string {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join('');
}

type Candidate = { id: string; companyName: string; jobTitle: string | null };
export type MatchDecision = { state: 'CREATED' } | { state: 'LINKED'; applicationId: string } | { state: 'NEEDS_REVIEW' };

/**
 * C = same company key; E = those in C with the same title key; N = those in C with no title.
 * C empty → CREATED. Exactly one in E and N empty → LINKED. Anything else → NEEDS_REVIEW.
 * An empty submission key never matches and goes to review.
 */
export function decideMatch(submission: Pick<CanonicalSubmission, 'company' | 'jobTitle'>, applications: Candidate[]): MatchDecision {
  const company = companyKey(submission.company);
  const title = titleKey(submission.jobTitle);
  if (!company || !title) return { state: 'NEEDS_REVIEW' };
  const sameCompany = applications.filter((app) => companyKey(app.companyName) === company);
  if (!sameCompany.length) return { state: 'CREATED' };
  const untitled = sameCompany.filter((app) => !app.jobTitle || !titleKey(app.jobTitle));
  const sameTitle = sameCompany.filter((app) => app.jobTitle && titleKey(app.jobTitle) === title);
  if (sameTitle.length === 1 && !untitled.length) return { state: 'LINKED', applicationId: sameTitle[0].id };
  return { state: 'NEEDS_REVIEW' };
}

// ─── Shared create/link effects (automatic path and user review) ────────────

type Tx = Prisma.TransactionClient;

async function createApplicationFrom(tx: Tx, userId: string, submission: Pick<ExternalSubmission, 'company' | 'jobTitle' | 'location' | 'submittedAt'>) {
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
async function linkApplication(tx: Tx, userId: string, applicationId: string, submittedAt: Date, explicit = false) {
  const locked = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`
    SELECT id, "archivedAt" FROM applications WHERE id = ${applicationId}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`;
  if (!locked.length) return false;
  if (locked[0].archivedAt) { if (explicit) throw new DomainError('APPLICATION_ARCHIVED'); return false; }
  await tx.application.updateMany({ where: { id: applicationId, appliedAt: null }, data: { appliedAt: submittedAt } });
  return true;
}

const addEvent = (tx: Tx, applicationId: string, externalSubmissionId: string) =>
  tx.applicationEvent.create({ data: { applicationId, type: AUTOMATION_SUBMITTED, externalSubmissionId } });

// ─── Intake ─────────────────────────────────────────────────────────────────

/** New records per user per UTC day (0–5000, default 500; 0 stops all new submissions). */
export function submissionDailyLimit(): number {
  const raw = process.env.MCP_DAILY_SUBMISSION_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_SUBMISSION_LIMIT;
  if (!/^\d+$/.test(raw) || Number(raw) > 5000) throw new Error('Invalid MCP_DAILY_SUBMISSION_LIMIT');
  return Number(raw);
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const STORED_FIELDS = [
  'platform', 'company', 'jobTitle', 'jobUrl', 'portalJobId', 'destinationHost', 'discoverySource', 'location', 'workMode', 'confirmationText',
] as const;
function payloadDiffers(stored: ExternalSubmission, incoming: CanonicalSubmission) {
  return (
    stored.submittedAt.getTime() !== incoming.submittedAt.getTime() ||
    STORED_FIELDS.some((field) => (stored[field] ?? null) !== (incoming[field] ?? null))
  );
}

export interface IntakeOutcome {
  result: SubmissionResult;
  recordId: string;
  /** Only for already_recorded: whether the repeat differed from the stored record (logged, never returned to the client). */
  payloadDiffered?: boolean;
}

const RESULT_OF = { CREATED: 'created', LINKED: 'linked', NEEDS_REVIEW: 'needs_review' } as const;
const TX_OPTIONS = { maxWait: 5000, timeout: 10000 };

/**
 * Records one confirmed submission for the token's user. Idempotent on
 * (user, AUTOMATION, sourceRecordRef): the first write wins and a repeat returns already_recorded.
 */
export async function recordSubmission(userId: string, tokenId: string | null, raw: unknown, now = new Date()): Promise<IntakeOutcome> {
  const submission = parseSubmissionInput(raw, now);
  const limit = submissionDailyLimit();
  const ref = { userId, source: 'AUTOMATION' as const, sourceRecordRef: submission.sourceRecordRef };
  const existing = async (db: Tx | typeof prisma): Promise<IntakeOutcome | null> => {
    const stored = await db.externalSubmission.findUnique({ where: { userId_source_sourceRecordRef: ref } });
    return stored && { result: 'already_recorded', recordId: stored.id, payloadDiffered: payloadDiffers(stored, submission) };
  };
  try {
    return await prisma.$transaction(async (tx) => {
      await lockUser(tx, LOCK_NAMESPACE.externalSubmissions, userId);
      // Checked before insert: a unique violation inside an interactive transaction aborts it.
      const repeat = await existing(tx);
      if (repeat) return repeat;
      const today = await tx.externalSubmission.count({ where: { userId, receivedAt: { gte: startOfUtcDay(now) } } });
      if (today >= limit) throw new SubmissionIntakeError('rate_limited', 'The daily submission limit is reached. Retry the next UTC day.');

      const candidates = await tx.application.findMany({ where: { userId }, select: { id: true, companyName: true, jobTitle: true, archivedAt: true } });
      const active = candidates.filter(app=>!app.archivedAt);
      let decision = decideMatch(submission, active);
      // An archived company candidate cannot become a silently duplicated new application.
      if (decision.state === 'CREATED' && candidates.some(app=>app.archivedAt && companyKey(app.companyName)===companyKey(submission.company))) decision={state:'NEEDS_REVIEW'};
      let applicationId: string | null = null;
      if (decision.state === 'CREATED') applicationId = await createApplicationFrom(tx, userId, submission);
      if (decision.state === 'LINKED') {
        // The application can disappear between the read and the lock; then a person decides.
        if (await linkApplication(tx, userId, decision.applicationId, submission.submittedAt)) applicationId = decision.applicationId;
        else decision = { state: 'NEEDS_REVIEW' };
      }
      const settled = decision.state !== 'NEEDS_REVIEW';
      const record = await tx.externalSubmission.create({
        data: {
          ...ref,
          ...submission,
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

// ─── Review (MCP-05) ────────────────────────────────────────────────────────

export type ResolveAction = { action: 'link'; applicationId: string } | { action: 'create' } | { action: 'ignore' };

/** Expected review outcomes, mapped to the email resolve route's codes. */
export class SubmissionReviewError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'NOT_RESOLVABLE' | 'APPLICATION_NOT_FOUND') {
    super(reason);
    this.name = 'SubmissionReviewError';
  }
}

/**
 * Final user resolution of a NEEDS_REVIEW submission, under the same per-user lock as intake.
 * link → LINKED (appliedAt only if empty), create → CREATED (as the automatic path), ignore → IGNORED.
 */
export async function resolveSubmission(userId: string, submissionId: string, resolution: ResolveAction, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.externalSubmissions, userId);
    const submission = await tx.externalSubmission.findFirst({ where: { id: submissionId, userId } });
    if (!submission) throw new SubmissionReviewError('NOT_FOUND');
    if (submission.matchState !== 'NEEDS_REVIEW') throw new SubmissionReviewError('NOT_RESOLVABLE');

    let applicationId: string | null = null;
    if (resolution.action === 'create') applicationId = await createApplicationFrom(tx, userId, submission);
    if (resolution.action === 'link') {
      if (await tx.application.findFirst({where:{id:resolution.applicationId,userId,archivedAt:{not:null}}})) throw new DomainError('APPLICATION_ARCHIVED');
      if (!(await linkApplication(tx, userId, resolution.applicationId, submission.submittedAt, true)))
        throw new SubmissionReviewError('APPLICATION_NOT_FOUND');
      applicationId = resolution.applicationId;
    }
    const matchState = ({ link: 'LINKED', create: 'CREATED', ignore: 'IGNORED' } as const)[resolution.action];
    // Conditional on the state read under the lock: a resolution is final.
    const updated = await tx.externalSubmission.updateMany({
      where: { id: submissionId, userId, matchState: 'NEEDS_REVIEW' },
      data: { matchState, resolvedBy: 'USER', resolvedAt: now, applicationId },
    });
    if (updated.count !== 1) throw new SubmissionReviewError('NOT_RESOLVABLE');
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
