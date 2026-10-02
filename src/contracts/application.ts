import { createPaginatedResponseSchema, PaginatedResponse } from './pagination';
import { SourceSubmissionSchema, SubmittedViaSchema } from './submission';
import { z } from 'zod';

export const ApplicationStatusSchema = z.enum([
  'APPLIED',
  'RECRUITER_CONTACT',
  'ASSESSMENT',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'CLOSED',
]);

export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const CreateApplicationRequestSchema = z.object({
  companyName: z.string().trim().min(1, 'Company name is required').max(200),
  jobTitle: z.string().optional(),
  location: z.string().optional(),
  appliedAt: z.string().datetime().optional().or(z.date().optional()),
});

export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequestSchema>;

// ─── Source email evidence (S6-02) ─────────────────────────────────────────
// Owned, bounded metadata only. null means the evidence is unavailable, not an error.

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** AI provenance: which provider and model produced a result. `deterministic` = rule-based filter. */
export const AnalyzedBySchema = z.object({ provider: z.string(), model: z.string() });
export type AnalyzedBy = z.infer<typeof AnalyzedBySchema>;

export const SourceEmailSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  receivedAt: IsoDateTimeSchema.nullable(), // "Email date"; not a verified event time
});
export type SourceEmail = z.infer<typeof SourceEmailSchema>;

// ─── Recent event summary (embedded in list response) ──────────────────────

export const RecentEventSchema = z.object({
  type: z.string(),
  createdAt: z.union([z.date(), z.string()]),
  recordedAt: IsoDateTimeSchema, // same instant as createdAt: when the app recorded it
  sourceEmail: SourceEmailSchema.nullable(),
  /** Set only for AUTOMATION_SUBMITTED (ADR-0002); null otherwise. */
  sourceSubmission: SourceSubmissionSchema.nullable(),
});
export type RecentEvent = z.infer<typeof RecentEventSchema>;

// ─── Canonical status (S6-01) ─────────────────────────────────────────────

export const StatusSourceSchema = z.enum(['USER', 'AI', 'UNKNOWN']);
export type StatusSource = z.infer<typeof StatusSourceSchema>;

/** Domain rule: effective status is userStatus ?? aiStatus. Derived, never persisted. */
export function deriveStatus(aiStatus: ApplicationStatus | null, userStatus: ApplicationStatus | null) {
  return {
    effectiveStatus: userStatus ?? aiStatus,
    statusSource: (userStatus ? 'USER' : aiStatus ? 'AI' : 'UNKNOWN') as StatusSource,
    hasStatusConflict: userStatus !== null && aiStatus !== null && userStatus !== aiStatus,
  };
}

// ─── ApplicationResponse (create + list + detail + status PATCH) ───────────

const ApplicationResponseObjectSchema = z.object({
  id: z.string(),
  companyName: z.string(),
  jobTitle: z.string().nullable(),
  location: z.string().nullable(),
  aiStatus: ApplicationStatusSchema.nullable(),
  userStatus: ApplicationStatusSchema.nullable(),
  userStatusSetAt: z.union([z.date(), z.string()]).nullable(),
  userStatusRevision: z.number().int().nonnegative(),
  effectiveStatus: ApplicationStatusSchema.nullable(),
  statusSource: StatusSourceSchema,
  hasStatusConflict: z.boolean(),
  appliedAt: z.union([z.date(), z.string()]).nullable(),
  createdAt: z.union([z.date(), z.string()]),
  updatedAt: z.union([z.date(), z.string()]),
  // Intelligence enrichment
  recentEvent: RecentEventSchema.nullable(),
  pendingActionCount: z.number(),
  /** 'AUTOMATION' when a linked or created automation submission exists (ADR-0002). Never a status. */
  submittedVia: SubmittedViaSchema.nullable(),
});

export const ApplicationResponseSchema = ApplicationResponseObjectSchema.superRefine((app, ctx) => {
  const expected = deriveStatus(app.aiStatus, app.userStatus);
  if (
    app.effectiveStatus !== expected.effectiveStatus ||
    app.statusSource !== expected.statusSource ||
    app.hasStatusConflict !== expected.hasStatusConflict
  ) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent derived application status' });
  }
});

export type ApplicationResponse = z.infer<typeof ApplicationResponseSchema>;

export const ListApplicationsResponseSchema =
  createPaginatedResponseSchema(ApplicationResponseSchema);
export type ListApplicationsResponse = z.infer<typeof ListApplicationsResponseSchema>;

// ─── Manual status correction (S6-01) ───────────────────────────────────────

/** null clears the user's override; the persisted AI status (or unknown) becomes effective. */
export const UpdateApplicationStatusRequestSchema = z.strictObject({
  userStatus: ApplicationStatusSchema.nullable(),
  expectedUserStatusRevision: z.number().int().nonnegative(),
});
export type UpdateApplicationStatusRequest = z.infer<typeof UpdateApplicationStatusRequestSchema>;

// ─── ApplicationEvent ────────────────────────────────────────────────────────
// Ordered by recording time (createdAt/recordedAt, then id); not a recruitment chronology.

export const ApplicationEventResponseSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  emailId: z.string().nullable(),
  type: z.string(),
  oldState: ApplicationStatusSchema.nullable(), // AI status only
  newState: ApplicationStatusSchema.nullable(), // AI status only
  description: z.string().nullable(),
  provenance: z.string().nullable(),
  createdAt: z.union([z.date(), z.string()]),
  recordedAt: IsoDateTimeSchema,
  sourceEmail: SourceEmailSchema.nullable(),
  /** Provider and model that produced the AI result behind this event (ADR-0001), when owned and known. */
  analyzedBy: AnalyzedBySchema.nullable(),
  /** What the automation reported, for AUTOMATION_SUBMITTED only (ADR-0002); null otherwise. */
  sourceSubmission: SourceSubmissionSchema.nullable(),
});

export type ApplicationEventResponse = z.infer<typeof ApplicationEventResponseSchema>;
export const ListApplicationEventsResponseSchema = createPaginatedResponseSchema(
  ApplicationEventResponseSchema,
);
export type ListApplicationEventsResponse = PaginatedResponse<ApplicationEventResponse>;

// ─── Action ─────────────────────────────────────────────────────────────────

export const ApplicationActionResponseSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  emailId: z.string().nullable(),
  type: z.string(),
  description: z.string().nullable(),
  deadline: z.union([z.date(), z.string()]).nullable(),
  deadlinePrecision: z.enum(['DATE', 'DATETIME']).nullable(),
  status: z.string(),
  createdAt: z.union([z.date(), z.string()]),
});

export type ApplicationActionResponse = z.infer<typeof ApplicationActionResponseSchema>;
export type ListApplicationActionsResponse = PaginatedResponse<ApplicationActionResponse>;
