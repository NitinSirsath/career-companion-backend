/**
 * "Write with AI" (owner, 24 and 25 Oct 2026): a reply draft from the whole conversation, read
 * live from Gmail, both sides, the newest mail winning, on the user's own AI setup. One call per
 * click, toward the daily limit. The draft is never stored or logged, and nothing is sent: the
 * user edits it in the reply box and sends it as any reply.
 */
import { getCatalogProvider } from '../contracts/aiCatalog';
import type { MailMessage } from '../contracts/mailbox';
import { MAIL_REPLY_TEXT_LIMIT } from '../contracts/mailbox';
import type { ReplyDraftRequest, ReplyDraftResponse } from '../contracts/conversation';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { AIAccessError, SchemaValidationFailure, TerminalAIError } from './ai/errors';
import { REPLY_DRAFT_CONTRACT, type DraftMessage } from './ai/replyDraft';
import { unavailable } from './ai/settings';
import { runUserCall } from './ai/userCall';
import { getConversation } from './conversation';
import { formatDraft } from './draftFormat';
import { readMailThread } from './mailbox';
import { ownText } from './replyReading';

/** How much of the conversation goes in: the newest message in full, older ones cut short. */
const NEWEST_LIMIT = 6000;
const OLDER_LIMIT = 1000;
const THREAD_LIMIT = 12_000;

const NO_RECIPIENT = 'There is no mail from someone else in this conversation to reply to.';
const DRAFT_FAILED = 'The AI could not write a draft. Try again, or write it yourself.';

/** A message's own text: the plain part, else the HTML part's words; quoted mail removed. */
function textOf(message: MailMessage): string {
  const plain =
    message.text ??
    (message.html ?? '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
  return ownText(plain);
}

/** "Priya Nair <priya@x.example>" → "Priya Nair". */
const nameOf = (from: string | null) =>
  from
    ?.replace(/<[^>]*>/, '')
    .replace(/"/g, '')
    .trim() || null;

/** The conversation as the AI reads it, oldest first, within the size limit. */
export function draftMessages(messages: MailMessage[]): DraftMessage[] {
  const out: DraftMessage[] = [];
  let used = 0;
  for (const [index, message] of [...messages].reverse().entries()) {
    const text = textOf(message).slice(0, index === 0 ? NEWEST_LIMIT : OLDER_LIMIT);
    if (!text) continue;
    if (used + text.length > THREAD_LIMIT) break;
    used += text.length;
    out.unshift({
      from: message.sentByUser ? 'you' : 'them',
      name: nameOf(message.from),
      sentAt: message.date,
      text,
    });
  }
  return out;
}

const modelName = (provider: string, model: string) =>
  getCatalogProvider(provider)?.models.find((candidate) => candidate.id === model)?.displayName ??
  model;

export async function writeReplyDraft(
  userId: string,
  key: string,
  request: ReplyDraftRequest,
): Promise<ReplyDraftResponse> {
  const { conversation } = await getConversation(userId, key);
  if (!conversation.threadId) throw new AppError(409, 'MAIL_REPLY_NO_RECIPIENT', NO_RECIPIENT);
  const thread = await readMailThread(userId, conversation.threadId);
  const messages = draftMessages(thread.messages);
  if (!thread.replyTo || !messages.some((message) => message.from === 'them'))
    throw new AppError(409, 'MAIL_REPLY_NO_RECIPIENT', NO_RECIPIENT);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  try {
    const { data, provider, model } = await runUserCall({
      userId,
      purpose: 'reply-draft',
      contract: REPLY_DRAFT_CONTRACT,
      call: (ai) =>
        ai.replies.write({
          messages,
          choice: request.choice ?? null,
          hint: request.hint ?? null,
          userName: user?.name?.trim().split(/\s+/)[0] || null,
        }),
    });
    const { text, doc } = formatDraft(data.draft);
    if (!text) throw new AppError(502, 'AI_DRAFT_FAILED', DRAFT_FAILED);
    return { text: text.slice(0, MAIL_REPLY_TEXT_LIMIT), doc, model: modelName(provider, model) };
  } catch (err) {
    if (err instanceof AIAccessError) throw unavailable(err, null);
    if (err instanceof SchemaValidationFailure || err instanceof TerminalAIError)
      throw new AppError(502, 'AI_DRAFT_FAILED', DRAFT_FAILED);
    throw err;
  }
}
