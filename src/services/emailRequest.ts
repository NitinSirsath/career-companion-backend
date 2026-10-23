import type { AIProcessingResult } from '@prisma/client';
import { parseActionDeadline } from '../utils/actionDeadline';

type RequestFields = Pick<
  AIProcessingResult,
  | 'actionRequired'
  | 'followUpRequired'
  | 'requestedAction'
  | 'actionDeadline'
  | 'followUpDate'
  | 'fakeOfferWarning'
>;

/**
 * The next step shown for a job mail that asks for money or bank, card or ID details. It replaces
 * the mail's own request, which is never shown and never becomes an application action.
 */
export const FAKE_OFFER_NEXT_STEP = "Don't pay. Check this job on the company's own careers site.";

/**
 * What a job email asks the user to do, read from its AI result. null when it asks for nothing.
 * The one home for this rule: application actions and the conversation list both use it.
 */
export function requestOf(result: RequestFields, receivedAt: Date | null) {
  if (result.fakeOfferWarning)
    return {
      kind: 'ACTION' as const,
      text: FAKE_OFFER_NEXT_STEP,
      deadlineText: null,
      deadline: parseActionDeadline(null, receivedAt),
    };
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
