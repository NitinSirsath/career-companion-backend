import { z } from 'zod';
import { MailCategorySchema } from './conversation';
import { splitMailAddresses } from './mailbox';

// ─── Mail sandbox (dev mode only; 404 in prod) ───────────────────────────────
// A dev-mode user's sandbox mailbox stands in for their Gmail account. A mail sent here reaches
// the app only when a sync pulls it, as real Gmail mail does. Nothing ever leaves the app.
// Shared with the frontend. Keep this file free of ES2021+ APIs (no replaceAll, no .at()).

const IsoDateTime = z.iso.datetime({ offset: true });

/** Sandbox message and thread IDs look like Gmail's: 16 hex characters. */
export const SandboxIdSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** A typed mail address, with or without a name: `Priya Raman <priya@acme.example>` or `priya@acme.example`. */
export function parseSandboxAddress(value: string): { name: string | null; email: string } | null {
  const text = value.trim();
  const named = /^([^<>]*)<([^<>\s]+)>$/.exec(text);
  const email = (named ? named[2] : text).trim();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) return null;
  const name = named
    ? named[1]
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim()
    : '';
  return { name: name || null, email };
}

export const SandboxAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .refine((value) => parseSandboxAddress(value) !== null, {
    message: 'Use a mail address, with or without a name.',
  });

/** More people than any test of a reply to all needs. */
export const SANDBOX_CC_LIMIT = 10;

/** The typed Cc line as its addresses. Null when a part is not a mail address or there are too many. */
export function parseSandboxCc(value: string): string[] | null {
  const addresses = splitMailAddresses(value);
  const valid = addresses.every((address) => parseSandboxAddress(address) !== null);
  return valid && addresses.length <= SANDBOX_CC_LIMIT ? addresses : null;
}

export const SandboxCcSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => parseSandboxCc(value) !== null, {
    message: `Use mail addresses with commas between them, at most ${SANDBOX_CC_LIMIT}.`,
  });

const Body = z.string().trim().min(1).max(8000);

// POST /api/sandbox/messages
/** A new mail from anyone to the user. It starts a conversation in the user's sandbox inbox. */
export const SendSandboxMailRequestSchema = z.strictObject({
  from: SandboxAddressSchema,
  /** Other people on the mail, so a reply to all can be tried. Left out or empty: nobody. */
  cc: SandboxCcSchema.optional(),
  subject: z.string().trim().max(300),
  body: Body,
});
export type SendSandboxMailRequest = z.infer<typeof SendSandboxMailRequestSchema>;

// POST /api/sandbox/threads/:threadId/replies
export const ReplySandboxMailRequestSchema = z.strictObject({
  /** `me`: the user answers. `them`: the other person of the conversation writes again. */
  as: z.enum(['me', 'them']),
  body: Body,
});
export type ReplySandboxMailRequest = z.infer<typeof ReplySandboxMailRequestSchema>;

export const SandboxSentResponseSchema = z.object({ id: z.string(), threadId: z.string() });
export type SandboxSentResponse = z.infer<typeof SandboxSentResponseSchema>;

/**
 * What the app did with one sandbox mail.
 * - NOT_SYNCED: no sync has pulled it yet.
 * - WAITING_FOR_AI / AI_KEY_MISSING / AI_FAILED: synced, not read yet, and why.
 * - NOT_JOB_MAIL / JOB_MAIL: read.
 * - REPLY_RECORDED: the user's own mail, noted as their reply.
 */
export const SandboxMailStateSchema = z.enum([
  'NOT_SYNCED',
  'WAITING_FOR_AI',
  'AI_KEY_MISSING',
  'AI_FAILED',
  'NOT_JOB_MAIL',
  'JOB_MAIL',
  'REPLY_RECORDED',
]);
export type SandboxMailState = z.infer<typeof SandboxMailStateSchema>;

export const SandboxMailResultSchema = z.object({
  state: SandboxMailStateSchema,
  /** AI_FAILED only: the failure category the app keeps. */
  failure: z.string().nullable(),
  /** JOB_MAIL only: what the AI read, and where the mail went. */
  job: z
    .object({
      category: MailCategorySchema.nullable(),
      company: z.string().nullable(),
      role: z.string().nullable(),
      requestedAction: z.string().nullable(),
      /** Opens the conversation on the Mails page. */
      conversationKey: z.string(),
      application: z
        .object({ id: z.uuid(), companyName: z.string(), jobTitle: z.string().nullable() })
        .nullable(),
    })
    .nullable(),
});
export type SandboxMailResult = z.infer<typeof SandboxMailResultSchema>;

export const SandboxFolderSchema = z.enum(['inbox', 'sent']);
export type SandboxFolder = z.infer<typeof SandboxFolderSchema>;

// GET /api/sandbox/threads?folder=inbox|sent&pageToken=
export const ListSandboxThreadsQuerySchema = z.object({
  folder: SandboxFolderSchema.default('inbox'),
  pageToken: z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .optional(),
});

export const SandboxThreadSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  /** The other person of the conversation, as typed. */
  party: z.string(),
  /** Newest mail of the folder in this conversation. */
  snippet: z.string(),
  date: IsoDateTime,
  messageCount: z.number().int().positive(),
  /** How many mails of the conversation no sync has pulled yet. */
  notSynced: z.number().int().nonnegative(),
  /** State of the newest mail of the folder in this conversation. */
  state: SandboxMailStateSchema,
});
export type SandboxThread = z.infer<typeof SandboxThreadSchema>;

export const ListSandboxThreadsResponseSchema = z.object({
  /** The user's sandbox mail address. */
  mailbox: z.string(),
  items: z.array(SandboxThreadSchema),
  nextPageToken: z.string().nullable(),
  /** Across the whole mailbox, not only this page. */
  notSyncedTotal: z.number().int().nonnegative(),
  counts: z.object({
    inbox: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
  }),
});
export type ListSandboxThreadsResponse = z.infer<typeof ListSandboxThreadsResponseSchema>;

export const SandboxMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  /** The other people on the mail. Null when there are none. */
  cc: z.string().nullable(),
  date: IsoDateTime,
  sentByUser: z.boolean(),
  /** The whole text, with the earlier mail quoted below a reply. */
  text: z.string(),
  result: SandboxMailResultSchema,
});
export type SandboxMessage = z.infer<typeof SandboxMessageSchema>;

// GET /api/sandbox/threads/:threadId
export const SandboxThreadDetailSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  party: z.string(),
  /** Oldest first, both sides. */
  messages: z.array(SandboxMessageSchema),
});
export type SandboxThreadDetail = z.infer<typeof SandboxThreadDetailSchema>;

// GET /api/sandbox/senders
/** Addresses used as sender before, newest first, for the "From" selector. */
export const SandboxSendersResponseSchema = z.object({ senders: z.array(z.string()) });
export type SandboxSendersResponse = z.infer<typeof SandboxSendersResponseSchema>;

// POST /api/sandbox/reset
export const ResetSandboxRequestSchema = z.strictObject({ confirm: z.literal('RESET') });
export type ResetSandboxRequest = z.infer<typeof ResetSandboxRequestSchema>;
export const ResetSandboxResponseSchema = z.object({
  deletedMessages: z.number().int(),
  deletedEmails: z.number().int(),
  deletedApplications: z.number().int(),
});
export type ResetSandboxResponse = z.infer<typeof ResetSandboxResponseSchema>;
