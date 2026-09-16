import { z } from 'zod';
import { ApplicationActionResponseSchema } from './application';

export const ActionWithContextResponseSchema = ApplicationActionResponseSchema.extend({
  application: z.object({
    companyName: z.string(),
    jobTitle: z.string().nullable(),
  }),
  email: z.object({
    subject: z.string().nullable(),
    sender: z.string().nullable(),
  }).nullable(),
});

export type ActionWithContextResponse = z.infer<typeof ActionWithContextResponseSchema>;

export const UpdateActionRequestSchema = z.object({
  status: z.enum(['PENDING', 'COMPLETED', 'DISMISSED']),
});
export type UpdateActionRequest = z.infer<typeof UpdateActionRequestSchema>;
