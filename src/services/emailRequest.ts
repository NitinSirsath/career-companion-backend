import type { AIProcessingResult } from '@prisma/client';
import { parseActionDeadline } from '../utils/actionDeadline';
import { canReplyTo } from './mailSender';

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

export { canReplyTo };

/** The words an ask done outside mail ends with, while its sender can get a reply. */
export const TELL_THEM = ', then tell them you did';

/**
 * An ask done outside mail, from a sender who can get a reply, also says to tell them (owner,
 * 24 Oct 2026): that reply is what closes it.
 */
function withTellThem(text: string | null, result: RequestFields, canReply: boolean) {
  if (!text?.trim() || result.askKind !== 'OUTSIDE_MAIL' || !canReply) return text;
  return `${text.trim().replace(/[.!\s]+$/, '')}${TELL_THEM}`;
}

/** `Automatic reply: …`, `Auto-reply`, `Out of office`: a mailbox answered, not a person. */
const AUTO_REPLY =
  /^(?:automatic reply|auto[- ]?reply|auto[- ]?response|out of (?:the )?office)\b/i;

/** True for an automatic or out-of-office reply, read from the subject. */
export const isAutoReply = (subject: string | null | undefined) =>
  AUTO_REPLY.test(subject?.trim() ?? '');

type AskRead = Pick<AIProcessingResult, 'actionRequired' | 'followUpRequired' | 'followUpDate'> &
  Partial<Pick<AIProcessingResult, 'askKind' | 'replyChoices'>>;
type AskChange = Partial<
  Pick<
    AIProcessingResult,
    | 'actionRequired'
    | 'requestedAction'
    | 'actionDeadline'
    | 'followUpRequired'
    | 'followUpDate'
    | 'askKind'
    | 'replyChoices'
  >
>;

/**
 * The app's own rules on the request the AI read from a mail (owner, 26 Nov 2026), as the changes
 * to keep on its AI result; empty when the read stands. They are saved with the read, so every
 * view of "does this mail ask for something" agrees.
 * - An automatic or out-of-office reply never asks for anything.
 * - Neither does mass outreach (`isMassOutreach`): a mailing is an advert, not a request.
 * - A "follow up" counts only with a date the app can read: with none there is nothing to do now
 *   and no day to do it, and an application nobody answers already shows under "gone quiet".
 */
export function askRules(
  read: AskRead,
  mail: { subject: string | null; receivedAt: Date | null; massOutreach?: boolean },
): AskChange {
  if (isAutoReply(mail.subject) || mail.massOutreach) {
    if (!read.actionRequired && !read.followUpRequired) return {};
    return {
      actionRequired: false,
      requestedAction: null,
      actionDeadline: null,
      followUpRequired: false,
      followUpDate: null,
      // Only a read that says how the request is done has these two.
      ...('askKind' in read ? { askKind: null, replyChoices: [] } : {}),
    };
  }
  const plainFollowUp = !!read.followUpRequired && !read.actionRequired;
  if (plainFollowUp && !parseActionDeadline(read.followUpDate, mail.receivedAt).deadline)
    return { followUpRequired: false };
  return {};
}

/**
 * What a job email asks the user to do, read from its AI result. null when it asks for nothing.
 * The one home for this rule: application actions and the conversation list both use it.
 * `sender` is the mail's From address; `saidNoReply` holds the addresses whose mails said nobody
 * reads a reply (`noReplySenders`), where the text is shown or kept.
 */
export function requestOf(
  result: RequestFields,
  receivedAt: Date | null,
  sender: string | null,
  saidNoReply?: ReadonlySet<string>,
) {
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
    text: result.actionRequired
      ? withTellThem(result.requestedAction, result, canReplyTo(sender, saidNoReply))
      : null,
    deadlineText,
    deadline: parseActionDeadline(deadlineText, receivedAt),
  };
}
