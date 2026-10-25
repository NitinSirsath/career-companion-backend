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
  | 'askKind'
>;

/**
 * The next step shown for a job mail that asks for money or bank, card or ID details. It replaces
 * the mail's own request, which is never shown and never becomes an application action.
 */
export const FAKE_OFFER_NEXT_STEP = "Don't pay. Check this job on the company's own careers site.";

const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply)([._+-]|$)/i;

/** False for a no-reply sender, read from the From address: a reply would reach nobody. */
export function canReplyTo(sender: string | null): boolean {
  const address = sender?.match(/<([^>]+)>/)?.[1] ?? sender ?? '';
  const local = address.trim().split('@')[0];
  return !!local && !NO_REPLY.test(local);
}

/**
 * An ask done outside mail, from a sender who can get a reply, also says to tell them (owner,
 * 24 Oct 2026): that reply is what closes it.
 */
function withTellThem(text: string | null, result: RequestFields, sender: string | null) {
  if (!text?.trim() || result.askKind !== 'OUTSIDE_MAIL' || !canReplyTo(sender)) return text;
  return `${text.trim().replace(/[.!\s]+$/, '')}, then tell them you did`;
}

/**
 * What a job email asks the user to do, read from its AI result. null when it asks for nothing.
 * The one home for this rule: application actions and the conversation list both use it.
 * `sender` is the mail's From address.
 */
export function requestOf(result: RequestFields, receivedAt: Date | null, sender: string | null) {
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
    text: result.actionRequired ? withTellThem(result.requestedAction, result, sender) : null,
    deadlineText,
    deadline: parseActionDeadline(deadlineText, receivedAt),
  };
}
