/**
 * The user's Gmail read live: nothing in these shapes is stored by Career Companion. Message
 * text is fetched from Gmail when the user opens a thread and is never kept or logged.
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
});
export type MailThread = z.infer<typeof MailThreadSchema>;

/** Gmail IDs are short URL-safe tokens. */
export const MailIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const MailPartIdSchema = z.string().regex(/^[0-9]+(\.[0-9]+){0,9}$/);
