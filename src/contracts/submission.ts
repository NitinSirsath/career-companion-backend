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
