import { CalendarDateSchema } from './temporal';
import { z } from 'zod';
import { ApplicationActionResponseSchema } from './application';

export const ActionWithContextResponseSchema = ApplicationActionResponseSchema.extend({
  application: z.object({
    companyName: z.string(),
    jobTitle: z.string().nullable(),
  }),
  email: z
    .object({
      subject: z.string().nullable(),
      sender: z.string().nullable(),
      threadId: z.string().nullable().optional(),
      gmailMessageId: z.string().optional(),
    })
    .nullable(),
});

export type ActionWithContextResponse = z.infer<typeof ActionWithContextResponseSchema>;

export const UpdateActionRequestSchema = z.strictObject({
  expectedActionRevision: z.number().int().nonnegative().optional(),
  status: z.enum(['PENDING', 'COMPLETED', 'DISMISSED']),
});
export type UpdateActionRequest = z.infer<typeof UpdateActionRequestSchema>;

export const PersonalDeadlineSchema = z
  .union([
    z.strictObject({ precision: z.literal('DATE'), value: CalendarDateSchema }),
    z.strictObject({ precision: z.literal('DATETIME'), value: z.iso.datetime({ offset: true }) }),
  ])
  .nullable();
export const CreateFollowUpSchema = z.strictObject({
  clientRequestId: z.uuid(),
  description: z.string().trim().min(1).max(500),
  deadline: PersonalDeadlineSchema,
});
export type CreateFollowUp = z.infer<typeof CreateFollowUpSchema>;
export const EditFollowUpSchema = z.strictObject({
  expectedActionRevision: z.number().int().nonnegative(),
  description: z.string().trim().min(1).max(500),
  deadline: PersonalDeadlineSchema,
});
export type EditFollowUp = z.infer<typeof EditFollowUpSchema>;
export const SnoozeActionSchema = z.strictObject({
  expectedActionRevision: z.number().int().nonnegative(),
  snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
});
export type SnoozeAction = z.infer<typeof SnoozeActionSchema>;
