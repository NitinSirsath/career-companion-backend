import { z } from 'zod';
import { ActionWithContextResponseSchema } from './action';
import { createPaginatedResponseSchema } from './pagination';

export const WorkspaceBucketSchema = z.enum([
  'all',
  'overdue',
  'today',
  'later',
  'undated',
  'snoozed',
]);
export type WorkspaceBucket = z.infer<typeof WorkspaceBucketSchema>;
export const WorkspaceQuerySchema = z.object({
  bucket: WorkspaceBucketSchema.default('all'),
  timeZone: z
    .string()
    .max(100)
    .refine((zone) => {
      if (zone !== 'UTC' && !zone.includes('/')) return false;
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, 'Use a valid IANA timezone')
    .default('Asia/Kolkata'),
});
const count = z.number().int().nonnegative();
export const WorkspaceActionsResponseSchema = createPaginatedResponseSchema(
  ActionWithContextResponseSchema,
).extend({
  generatedAt: z.iso.datetime(),
  timeZone: z.string(),
  nextTransitionAt: z.iso.datetime().nullable(),
  counts: z.object({
    overdue: count,
    today: count,
    later: count,
    undated: count,
    totalPending: count,
    snoozed: count,
  }),
});
export type WorkspaceActionsResponse = z.infer<typeof WorkspaceActionsResponseSchema>;
export const WorkspaceReviewResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  unmatched: count,
  ambiguous: count,
  pendingSubmissions: count,
});
export type WorkspaceReviewResponse = z.infer<typeof WorkspaceReviewResponseSchema>;
