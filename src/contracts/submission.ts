/**
 * Automation submissions (ADR-0002): review API and timeline evidence. Shared with the frontend by
 * sync-contracts. Every field comes from the user's automation and is untrusted: render as plain
 * text. The integration token behind a submission is never exposed.
 */
import { z } from 'zod';
import { createPaginatedResponseSchema } from './pagination';

const IsoDateTime = z.iso.datetime({ offset: true });

// ─── GET /api/submissions/pending ───────────────────────────────────────────

export const PendingSubmissionSchema = z.object({
  id: z.string(),
  sourceRecordRef: z.string(),
  platform: z.string(),
  company: z.string(),
  jobTitle: z.string(),
  /** When the automation says the site confirmed the submission. */
  submittedAt: IsoDateTime,
  /** When Career Companion recorded it. */
  receivedAt: IsoDateTime,
  /** Stored http/https URL, without fragment, credentials or tracking parameters. */
  jobUrl: z.string().nullable(),
  portalJobId: z.string().nullable(),
  destinationHost: z.string().nullable(),
  discoverySource: z.string().nullable(),
  location: z.string().nullable(),
  workMode: z.string().nullable(),
  confirmationText: z.string().nullable(),
});
export type PendingSubmission = z.infer<typeof PendingSubmissionSchema>;

export const ListPendingSubmissionsResponseSchema =
  createPaginatedResponseSchema(PendingSubmissionSchema);
export type ListPendingSubmissionsResponse = z.infer<typeof ListPendingSubmissionsResponseSchema>;

// ─── POST /api/submissions/:id/resolve ──────────────────────────────────────

/** Final in v1: link to an owned application, create one from the submission, or ignore it. */
export const ResolveSubmissionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('link'), applicationId: z.uuid() }),
  z.strictObject({ action: z.literal('create') }),
  z.strictObject({ action: z.literal('ignore') }),
]);
export type ResolveSubmissionRequest = z.infer<typeof ResolveSubmissionRequestSchema>;

export const ResolveSubmissionResponseSchema = z.object({
  id: z.string(),
  matchState: z.enum(['LINKED', 'CREATED', 'IGNORED']),
  applicationId: z.string().nullable(),
});
export type ResolveSubmissionResponse = z.infer<typeof ResolveSubmissionResponseSchema>;

// ─── Timeline evidence ──────────────────────────────────────────────────────

/** Bounded, owner-checked evidence behind an AUTOMATION_SUBMITTED event, as reported by the automation. */
export const SourceSubmissionSchema = z.object({
  platform: z.string(),
  destinationHost: z.string().nullable(),
  submittedAt: IsoDateTime,
  confirmationText: z.string().nullable(),
});
export type SourceSubmission = z.infer<typeof SourceSubmissionSchema>;

export const SubmittedViaSchema = z.enum(['AUTOMATION']);
export type SubmittedVia = z.infer<typeof SubmittedViaSchema>;

// ─── Automation details on applications ─────────────────────────────────────

/** The table's facts for an automation application: from its newest linked or created submission. */
export const ApplicationAutomationSchema = z.object({
  platform: z.string(),
  /** Stored http/https URL of the job post. */
  jobUrl: z.string().nullable(),
  submittedAt: IsoDateTime,
});
export type ApplicationAutomation = z.infer<typeof ApplicationAutomationSchema>;

/** One screening question and the answer the automation gave, as written in its daily file. */
export const SubmittedAnswerSchema = z.object({ question: z.string(), answer: z.string() });
export type SubmittedAnswer = z.infer<typeof SubmittedAnswerSchema>;

/**
 * The company-portal account the automation used (owner, 21 Nov 2026). Never carries the password:
 * `hasPassword` says whether one is stored; the owner opens it with the reveal route below.
 */
export const PortalAccountSchema = z.object({
  id: z.string(),
  company: z.string(),
  /** Stored http/https URL of the portal's sign-in page. */
  signInUrl: z.string(),
  loginEmail: z.string(),
  hasPassword: z.boolean(),
  emailVerified: z.boolean().nullable(),
  /** Who made the account: the automation, or the user in the browser. */
  madeBy: z.enum(['NORTHLIST_APPLY', 'USER']).nullable(),
  /** YYYY-MM-DD from the automation's account record. */
  createdOn: z.iso.date().nullable(),
  /** How many other applications used this account. */
  otherApplications: z.number().int().min(0),
});
export type PortalAccount = z.infer<typeof PortalAccountSchema>;

/** Everything the automation reported for one submission behind an application. */
export const ApplicationSubmissionSchema = PendingSubmissionSchema.extend({
  matchState: z.enum(['LINKED', 'CREATED']),
  /** Full http/https URL of the page where the form was submitted. */
  applyUrl: z.string().nullable(),
  resumeFilename: z.string().nullable(),
  submittedAnswers: z.array(SubmittedAnswerSchema),
  portalAccount: PortalAccountSchema.nullable(),
});
export type ApplicationSubmission = z.infer<typeof ApplicationSubmissionSchema>;

// GET /api/applications/:id/submissions — newest first; not paginated (a few per application).
export const ListApplicationSubmissionsResponseSchema = z.object({
  items: z.array(ApplicationSubmissionSchema),
});
export type ListApplicationSubmissionsResponse = z.infer<
  typeof ListApplicationSubmissionsResponseSchema
>;

// ─── POST /api/submissions/portal-accounts/:id/password ─────────────────────

/** The owner's saved portal password, opened on request. Never cached or logged. */
export const PortalPasswordResponseSchema = z.object({ password: z.string() });
export type PortalPasswordResponse = z.infer<typeof PortalPasswordResponseSchema>;

// ─── GET /api/submissions/not-submitted ─────────────────────────────────────

/** A job the automation looked at but did not apply to. Never an application. */
export const NotSubmittedJobSchema = z.object({
  id: z.string(),
  sourceRecordRef: z.string(),
  outcome: z.enum(['SKIPPED', 'NEEDS_USER']),
  platform: z.string(),
  company: z.string(),
  jobTitle: z.string(),
  jobUrl: z.string().nullable(),
  /** Why it was skipped, or the question or step that needs the user. */
  reason: z.string(),
  /** When the automation wrote the entry. */
  loggedAt: IsoDateTime,
  receivedAt: IsoDateTime,
});
export type NotSubmittedJob = z.infer<typeof NotSubmittedJobSchema>;

export const ListNotSubmittedJobsResponseSchema =
  createPaginatedResponseSchema(NotSubmittedJobSchema);
export type ListNotSubmittedJobsResponse = z.infer<typeof ListNotSubmittedJobsResponseSchema>;

// ─── GET /api/submissions/tasks ─────────────────────────────────────────────

/**
 * One plan item of a NorthList Apply run (owner, 25 Nov 2026): how many jobs the user asked for and
 * how many were sent. `planned` is null for a site the run sent to that was not in its plan (a
 * job source's job that ended on another site's form).
 */
export const ApplyTaskPlanItemSchema = z.object({
  site: z.string(),
  planned: z.number().int().min(0).nullable(),
  sent: z.number().int().min(0),
});
export type ApplyTaskPlanItem = z.infer<typeof ApplyTaskPlanItemSchema>;

/**
 * One NorthList Apply run: from the user's `ready` to the end of that session. Named by its start
 * time in the user's own time (`startedAt` plus `utcOffsetMinutes`). Time taken runs from
 * `startedAt` to `lastAt`, the newest entry of the run; null while it has none.
 */
export const ApplyTaskSchema = z.object({
  id: z.string(),
  startedAt: IsoDateTime,
  /** The user's UTC offset when the run started, in minutes (330 for +05:30). */
  utcOffsetMinutes: z.number().int(),
  lastAt: IsoDateTime.nullable(),
  /** Applications the run sent (every confirmed submission except ones the user ignored). */
  sent: z.number().int().min(0),
  /** Jobs the run tried but did not apply to. */
  notSent: z.number().int().min(0),
  plan: z.array(ApplyTaskPlanItemSchema),
});
export type ApplyTask = z.infer<typeof ApplyTaskSchema>;

/** Totals over every run, and how many Apply applications came before runs were sent. */
export const ApplyTaskSummarySchema = z.object({
  tasks: z.number().int().min(0),
  sent: z.number().int().min(0),
  /** Time taken by all runs together, in whole minutes. */
  minutes: z.number().int().min(0),
  /** NorthList Apply applications that belong to no run (sent by an older Apply version). */
  earlier: z.number().int().min(0),
});
export type ApplyTaskSummary = z.infer<typeof ApplyTaskSummarySchema>;

export const ListApplyTasksResponseSchema = createPaginatedResponseSchema(ApplyTaskSchema).extend({
  summary: ApplyTaskSummarySchema,
});
export type ListApplyTasksResponse = z.infer<typeof ListApplyTasksResponseSchema>;
