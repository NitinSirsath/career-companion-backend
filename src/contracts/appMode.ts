import { z } from 'zod';

/**
 * How the app runs. `dev` is manual testing with made-up mail on its own database; it never runs
 * on live data. Shared with the frontend, which has no mode setting of its own.
 */
export const AppModeSchema = z.enum(['dev', 'prod']);
export type AppMode = z.infer<typeof AppModeSchema>;

// GET /api/app-mode
export const AppModeResponseSchema = z.object({ mode: AppModeSchema });
export type AppModeResponse = z.infer<typeof AppModeResponseSchema>;
