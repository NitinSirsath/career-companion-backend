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

/** Everything the automation reported for one submission behind an application. */
export const ApplicationSubmissionSchema = PendingSubmissionSchema.extend({
  matchState: z.enum(['LINKED', 'CREATED']),
  /** Full http/https URL of the page where the form was submitted. */
  applyUrl: z.string().nullable(),
  resumeFilename: z.string().nullable(),
  submittedAnswers: z.array(SubmittedAnswerSchema),
});
export type ApplicationSubmission = z.infer<typeof ApplicationSubmissionSchema>;

// GET /api/applications/:id/submissions — newest first; not paginated (a few per application).
export const ListApplicationSubmissionsResponseSchema = z.object({
  items: z.array(ApplicationSubmissionSchema),
});
export type ListApplicationSubmissionsResponse = z.infer<
  typeof ListApplicationSubmissionsResponseSchema
>;

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
