/**
 * The Dashboard's AI tip (owner, 27 Oct 2026): one short tip from the user's own numbers of the
 * last 30 days. Only counts, rates and site names go in: never mail text, names, companies or
 * addresses. A version always means exactly these instructions and this schema.
 */
import { z } from 'zod';
import type { AIContract } from './contracts';

/** The longest tip taken from the AI. */
export const DASHBOARD_TIP_LIMIT = 400;

export const DashboardTipAnswerSchema = z.object({
  tip: z.string().max(DASHBOARD_TIP_LIMIT).describe('One tip, at most two short sentences.'),
});
export type DashboardTipAnswer = z.infer<typeof DashboardTipAnswerSchema>;

export const DASHBOARD_TIP_CONTRACT: AIContract<DashboardTipAnswer> = {
  version: 'dashboard-tip/v1',
  role: 'fast',
  schemaName: 'dashboard_tip',
  schema: DashboardTipAnswerSchema,
  maxOutputTokens: 300,
  instructions: `
You give one practical tip to a person looking for a job, from the numbers of their own job search over the last 30 days.
Input is JSON: the totals for the 30 days and the 30 days before, the funnel (applications sent and how many reached each step), the rates, where rejected jobs ended, how fast companies answer (days), how fast the person answers (hours), how many jobs went quiet, and, when they use an automation, applications and answers per job site and per work mode.
Write one tip of at most two short sentences, in plain English, speaking to the person as "you".
Base it only on the numbers given. Name a number when it helps. Do not repeat a number without saying what to do about it.
When the numbers are too few to show a pattern (fewer than 5 applications), say what to keep doing instead of guessing a pattern.
Never invent facts, companies, benchmarks or averages of other people. No greeting, no lists, no emojis.
`.trim(),
};
