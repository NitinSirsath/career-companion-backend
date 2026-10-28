/**
 * Companies whose new mail the app does not read (owner, 26 Oct 2026). A block covers a whole
 * company domain, such as infosys.com, and only official company mail can be blocked: LinkedIn and
 * mail providers anyone can use never carry a company's sensitive details, so they stay readable.
 * The rule lives here so the server (sync, block requests) and the app (whether to offer a block)
 * agree.
 */
import { z } from 'zod';

const IsoDateTime = z.iso.datetime({ offset: true });

/** Mail providers anyone can sign up to, and LinkedIn. Never blocked. */
export const SHARED_MAIL_DOMAINS: readonly string[] = [
  'linkedin.com',
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.in',
  'ymail.com',
  'rocketmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'zohomail.in',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'rediffmail.com',
];

/** Endings where a company's own domain has three parts, as in tcs.co.in. */
const TWO_PART_ENDINGS = new Set([
  'co.in',
  'org.in',
  'net.in',
  'ac.in',
  'gov.in',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'co.nz',
  'co.jp',
  'com.br',
  'com.sg',
  'com.my',
  'co.za',
  'com.mx',
]);

/** The address's domain, in lower case: `"Priya" <priya@careers.acme.com>` → careers.acme.com. */
export function senderDomain(sender: string | null | undefined): string | null {
  const text = sender?.trim();
  if (!text) return null;
  const address = text.match(/<([^<>]+)>\s*$/)?.[1] ?? text;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

/** The company's own domain: careers.acme.com → acme.com, mail.tcs.co.in → tcs.co.in. */
export function companyDomain(domain: string): string {
  const parts = domain.split('.');
  const keep = TWO_PART_ENDINGS.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/** The company domain a block from this sender would cover, or null when it cannot be blocked. */
export function blockableDomain(sender: string | null | undefined): string | null {
  const domain = senderDomain(sender);
  if (!domain) return null;
  const company = companyDomain(domain);
  return SHARED_MAIL_DOMAINS.includes(company) || SHARED_MAIL_DOMAINS.includes(domain)
    ? null
    : company;
}

/** True when the sender's company is one of the blocked domains. */
export function isBlockedSender(
  sender: string | null | undefined,
  blocked: readonly string[],
): boolean {
  const domain = blockableDomain(sender);
  return !!domain && blocked.includes(domain);
}

export const BlockSourceSchema = z.enum(['DELETE', 'MENU']);

export const BlockedSenderSchema = z.object({
  id: z.uuid(),
  /** The whole company domain, such as infosys.com. */
  domain: z.string(),
  /** DELETE: chosen while deleting a conversation. MENU: from a mail's "…" menu. */
  source: BlockSourceSchema,
  createdAt: IsoDateTime,
});
export type BlockedSender = z.infer<typeof BlockedSenderSchema>;

export const ListBlockedSendersResponseSchema = z.object({
  items: z.array(BlockedSenderSchema),
});
export type ListBlockedSendersResponse = z.infer<typeof ListBlockedSendersResponseSchema>;

/** Blocks the company of a conversation's newest job mail. */
export const BlockSenderRequestSchema = z.strictObject({
  conversationKey: z.string().min(1).max(200),
});
export type BlockSenderRequest = z.infer<typeof BlockSenderRequestSchema>;

/** Deletes a conversation from the app; `block` also blocks its company's new mail. */
export const DeleteConversationRequestSchema = z.strictObject({
  block: z.boolean().default(false),
});
export type DeleteConversationRequest = z.infer<typeof DeleteConversationRequestSchema>;

export const DeleteConversationResponseSchema = z.object({
  /** How many stored mails the conversation had. */
  deleted: z.number().int().nonnegative(),
  /** The company domain now blocked, or null. */
  blocked: z.string().nullable(),
});
export type DeleteConversationResponse = z.infer<typeof DeleteConversationResponseSchema>;
