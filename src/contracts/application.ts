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

export const CreateApplicationRequestSchema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  jobTitle: z.string().optional(),
  location: z.string().optional(),
  appliedAt: z.string().datetime().optional().or(z.date().optional()),
});

export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequestSchema>;

export const ApplicationResponseSchema = z.object({
  id: z.string(),
  companyName: z.string(),
  jobTitle: z.string().nullable(),
  location: z.string().nullable(),
  aiStatus: ApplicationStatusSchema.nullable(),
  userStatus: ApplicationStatusSchema.nullable(),
  userStatusSetAt: z.date().nullable(),
  appliedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ApplicationResponse = z.infer<typeof ApplicationResponseSchema>;

export const ListApplicationsResponseSchema = z.array(ApplicationResponseSchema);
export type ListApplicationsResponse = z.infer<typeof ListApplicationsResponseSchema>;
