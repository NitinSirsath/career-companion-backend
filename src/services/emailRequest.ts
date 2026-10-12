import type { AIProcessingResult } from '@prisma/client';
import { parseActionDeadline } from '../utils/actionDeadline';

type RequestFields = Pick<
  AIProcessingResult,
  'actionRequired' | 'followUpRequired' | 'requestedAction' | 'actionDeadline' | 'followUpDate'
>;

/**
 * What a job email asks the user to do, read from its AI result. null when it asks for nothing.
 * The one home for this rule: application actions and the conversation list both use it.
 */
export function requestOf(result: RequestFields, receivedAt: Date | null) {
  if (!result.actionRequired && !result.followUpRequired) return null;
  const deadlineText = result.actionRequired ? result.actionDeadline : result.followUpDate;
  return {
    kind: result.actionRequired ? ('ACTION' as const) : ('FOLLOW_UP' as const),
    /** The sender's request in the AI's words; null for a plain follow-up. */
    text: result.actionRequired ? result.requestedAction : null,
    deadlineText,
    deadline: parseActionDeadline(deadlineText, receivedAt),
  };
}
