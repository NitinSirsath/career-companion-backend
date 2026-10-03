import { z } from 'zod';
import { TemporalInputSchema, TemporalValueSchema, CalendarDateSchema } from './temporal';
import { WorkspaceQuerySchema } from './workspace';
import { createPaginatedResponseSchema } from './pagination';

export const AgendaQuerySchema = z
  .object({
    view: z.enum(['upcoming', 'past', 'review', 'history']).default('upcoming'),
    timeZone: WorkspaceQuerySchema.shape.timeZone,
    from: CalendarDateSchema.optional(),
    to: CalendarDateSchema.optional(),
    archive: z.enum(['active', 'archived', 'all']).optional(),
    applicationId: z.uuid().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.view === 'review' && (q.from || q.to))
      ctx.addIssue({ code: 'custom', message: 'Review cannot filter uncertain dates' });
    if (
      Boolean(q.from) !== Boolean(q.to) ||
      (q.from && q.to && (q.to <= q.from || Date.parse(q.to) - Date.parse(q.from) > 90 * 86400000))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Use an inclusive from and exclusive to range of at most 90 days',
      });
  });
export type AgendaQuery = z.infer<typeof AgendaQuerySchema>;
export const UpdateAgendaSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    state: z.enum(['CONFIRMED', 'CANCELLED', 'COMPLETED']).optional(),
    timing: TemporalInputSchema.optional(),
  })
  .refine((q) => q.state !== undefined || q.timing !== undefined, 'No change supplied');
export type UpdateAgenda = z.infer<typeof UpdateAgendaSchema>;
export const AgendaItemSchema = z.object({
  applicationArchived: z.boolean(),
  id: z.uuid(),
  applicationId: z.uuid(),
  emailId: z.uuid(),
  candidateKey: z.string(),
  extractionVersion: z.string(),
  suggestion: TemporalInputSchema.extend({
    kind: z.enum(['INTERVIEW', 'ASSESSMENT_DUE']),
    change: z.enum(['SCHEDULED', 'RESCHEDULED', 'CANCELLED']),
    rawWhen: z.string(),
    evidence: z.string().nullable(),
    temporal: TemporalValueSchema,
    key: z.string(),
  }),
  timing: TemporalValueSchema,
  state: z.enum(['TENTATIVE', 'CONFIRMED', 'CANCELLED', 'COMPLETED']),
  revision: z.number().int().nonnegative(),
  decisionSourceId: z.uuid().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  retiredReason: z.enum(['EMAIL_MOVED', 'EMAIL_UNLINKED']).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  application: z.object({ companyName: z.string(), jobTitle: z.string().nullable() }),
  email: z.object({ subject: z.string().nullable(), threadId: z.string().nullable() }),
});
export type AgendaItem = z.infer<typeof AgendaItemSchema>;
export const AgendaResponseSchema = createPaginatedResponseSchema(AgendaItemSchema).extend({
  generatedAt: z.iso.datetime(),
  timeZone: z.string(),
  extractionEnabled: z.boolean(),
});
