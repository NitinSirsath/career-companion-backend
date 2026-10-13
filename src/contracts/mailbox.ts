/**
 * The user's Gmail read live: nothing in these shapes is stored by Career Companion. Message
 * text is fetched from Gmail when the user opens a thread and is never kept or logged. The text
 * of a reply the user sends from here goes to Gmail and is not kept or logged either.
 */
import { z } from 'zod';

const IsoDateTime = z.iso.datetime({ offset: true });

export const MailboxThreadSchema = z.object({
  threadId: z.string(),
  subject: z.string().nullable(),
  /** Sender of the newest message. */
  from: z.string().nullable(),
  date: IsoDateTime.nullable(),
  snippet: z.string(),
  messageCount: z.number().int().nonnegative(),
  unread: z.boolean(),
  /** Set when this thread is one of the user's job-mail conversations. */
  conversationKey: z.string().nullable(),
});
export type MailboxThread = z.infer<typeof MailboxThreadSchema>;

/** Gmail pages by token, not by offset: `nextPageToken` is null on the last page. */
export const ListMailboxThreadsResponseSchema = z.object({
  items: z.array(MailboxThreadSchema),
  nextPageToken: z.string().nullable(),
});
export type ListMailboxThreadsResponse = z.infer<typeof ListMailboxThreadsResponseSchema>;

export const MailboxQuerySchema = z.object({ pageToken: z.string().min(1).max(500).optional() });

export const MailAttachmentSchema = z.object({
  /** Position of the attachment inside the message; stable for one message. */
  partId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});
export type MailAttachment = z.infer<typeof MailAttachmentSchema>;

export const MailMessageSchema = z.object({
  id: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  cc: z.string().nullable(),
  date: IsoDateTime.nullable(),
  subject: z.string().nullable(),
  /** Gmail label names, ready to show. */
  labels: z.array(z.string()),
  sentByUser: z.boolean(),
  text: z.string().nullable(),
  /** The sender's HTML as Gmail holds it. Show it only inside a sandboxed frame. */
  html: z.string().nullable(),
  /** True when the text or HTML was cut at the size limit. */
  truncated: z.boolean(),
  attachments: z.array(MailAttachmentSchema),
});
export type MailMessage = z.infer<typeof MailMessageSchema>;

export const MailThreadSchema = z.object({
  threadId: z.string(),
  subject: z.string().nullable(),
  /** Oldest first, the user's own messages included. */
  messages: z.array(MailMessageSchema),
  /**
   * Who a reply sent from the app goes to: the newest mail from someone else, its Reply-To when
   * it has one. Null when nobody else wrote in this thread, so there is nothing to reply to.
   */
  replyTo: z.string().nullable(),
});
export type MailThread = z.infer<typeof MailThreadSchema>;

// ─── POST /api/mailbox/threads/:threadId/replies ────────────────────────────

/** A reply is plain text. Far above any written reply; a longer text is refused, not cut. */
export const MAIL_REPLY_TEXT_LIMIT = 20_000;

export const SendMailReplyRequestSchema = z.strictObject({
  /** Made by the page for this one reply. The same ID never sends a second mail. */
  replyId: z.uuid(),
  text: z.string().trim().min(1).max(MAIL_REPLY_TEXT_LIMIT),
});
export type SendMailReplyRequest = z.infer<typeof SendMailReplyRequestSchema>;

export const SendMailReplyResponseSchema = z.object({
  /** Gmail's ID of the sent message. */
  id: z.string(),
  threadId: z.string(),
  sentAt: IsoDateTime,
});
export type SendMailReplyResponse = z.infer<typeof SendMailReplyResponseSchema>;

/** Gmail IDs are short URL-safe tokens. */
export const MailIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const MailPartIdSchema = z.string().regex(/^[0-9]+(\.[0-9]+){0,9}$/);
