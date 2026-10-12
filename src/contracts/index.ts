import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export * from './appMode';
export * from './application';
export * from './auth';
export * from './gmail';
export * from './email';
export * from './action';
export * from './pagination';
export * from './aiCatalog';
export * from './ai';
export * from './integrationToken';
export * from './submission';

export * from './workspace';

export * from './agenda';
export * from './temporal';
export * from './conversation';
export * from './mailbox';
