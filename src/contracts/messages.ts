import { z } from 'zod';

// ─── Messages from the Admin page (owner, 18 Nov 2026) ───────────────────────
// The owner writes a short plain-text message to one account or to every account. It shows at the
// top of the app until the user closes it, and can also go out as a push alert.

export const OWNER_MESSAGE_MAX_LENGTH = 500;

/** A message as the user sees it. */
export const OwnerMessageSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  sentAt: z.iso.datetime(),
});
export type OwnerMessage = z.infer<typeof OwnerMessageSchema>;

// GET /api/messages: the messages still shown to the signed-in user, newest first.
export const MyMessagesResponseSchema = z.object({ messages: z.array(OwnerMessageSchema) });
export type MyMessagesResponse = z.infer<typeof MyMessagesResponseSchema>;

/** A sent message on the Admin page. */
export const AdminSentMessageSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  /** Null: every account that existed when it was sent. */
  toEmail: z.string().nullable(),
  sentAt: z.iso.datetime(),
  /** Devices that took the push alert; null when no alert was asked for. */
  alertsSent: z.number().int().nonnegative().nullable(),
  removedAt: z.iso.datetime().nullable(),
});
export type AdminSentMessage = z.infer<typeof AdminSentMessageSchema>;

// GET /api/admin/messages
export const AdminMessagesResponseSchema = z.object({
  /** The last 10 sent, newest first. */
  messages: z.array(AdminSentMessageSchema),
  /** Devices with alerts on, per account (accounts with none left out; suspended accounts too). */
  alertDevices: z.record(z.string(), z.number().int().positive()),
});
export type AdminMessagesResponse = z.infer<typeof AdminMessagesResponseSchema>;

// POST /api/admin/messages
export const SendOwnerMessageRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(OWNER_MESSAGE_MAX_LENGTH),
  /** "EVERYONE", or one account's id. */
  to: z.union([z.literal('EVERYONE'), z.uuid()]),
  alsoAlert: z.boolean(),
});
export type SendOwnerMessageRequest = z.infer<typeof SendOwnerMessageRequestSchema>;

// POST /api/admin/messages and /api/admin/messages/:id/remove answer with the message.
export const AdminSentMessageResponseSchema = z.object({ message: AdminSentMessageSchema });
export type AdminSentMessageResponse = z.infer<typeof AdminSentMessageResponseSchema>;
