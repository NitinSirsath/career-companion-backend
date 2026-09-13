import { z } from 'zod';

export const AmbiguousMatchResponseSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  receivedAt: z.string().nullable(), // ISO string or Date, we'll format as ISO
  aiProcessingResult: z.object({
    companyName: z.string().nullable(),
    jobTitle: z.string().nullable(),
    confidence: z.number().nullable(),
    category: z.string().nullable(),
  }).nullable(),
});

export type AmbiguousMatchResponse = z.infer<typeof AmbiguousMatchResponseSchema>;

export const ResolveAmbiguityRequestSchema = z.object({
  applicationId: z.string().nullable(), // null means "Ignore this email, no match"
});

export type ResolveAmbiguityRequest = z.infer<typeof ResolveAmbiguityRequestSchema>;
