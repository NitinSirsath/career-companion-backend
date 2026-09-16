import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export * from './application';
export * from './gmail';
export * from './email';
export * from './action';
