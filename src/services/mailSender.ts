/**
 * Who sent a mail, whether a reply to them would reach anybody, and whether it went to many
 * people at once (owner, 26 Nov 2026). One home for these: the reading AI, the request rules, the
 * matcher and the reply box all ask here.
 */
import type { EmailCategory, Prisma } from '@prisma/client';
import { senderDomain } from '../contracts/blockedSender';
import { mailAddressOf } from '../contracts/mailbox';
import { prisma } from '../db/prisma';
import { splitQuoted } from './mailText';

type Db = Prisma.TransactionClient | typeof prisma;

/** The name shown for the sender, as in `Name <address>`; null when there is only an address. */
export function senderName(sender: string | null | undefined): string | null {
  const name = /^(.*)<[^<>]+>\s*$/.exec(sender ?? '')?.[1];
  return (
    name
      ?.trim()
      .replace(/^"(.*)"$/, '$1')
      .trim() || null
  );
}

/** "no-reply", "noreply", "do-not-reply": a word of its own anywhere before the @, as in `jobs-noreply`. */
const NO_REPLY = /(^|[._+-])(no[-_.]?reply|do[-_.]?not[-_.]?reply)([._+-]|$)/i;

/** Mailboxes that only report a mail that could not be delivered. */
const DELIVERY_MAILBOXES = ['mailer-daemon', 'postmaster'];

/**
 * Mail systems of applicant-tracking sites that send for many companies and whose own address
 * nobody reads. Subdomains count. Never a company's own domain, and never a system that passes a
 * reply on to the recruiter. A sender missing here is caught when its own mail says so
 * (`saysNoReply`).
 */
export const SYSTEM_SENDER_DOMAINS: readonly string[] = ['myworkday.com'];

const isSystemDomain = (domain: string) =>
  SYSTEM_SENDER_DOMAINS.some((system) => domain === system || domain.endsWith(`.${system}`));

/** Words that may stand before "monitored": "not actively monitored", "not being regularly checked". */
const HOW =
  '(?:(?:being|actively|regularly|currently|routinely|constantly|continuously|frequently|closely|normally|usually|always)\\s+){0,2}';
/** What a mail calls the place a reply would go to. */
const MAILBOX =
  '(?:mailbox|mail\\s+box|inbox|e-?mail(?:\\s+(?:address|account|id|box|inbox|alias))?|mail\\s?id|address|account|alias)';
/** "this automated email", "this system-generated message". */
const KIND =
  '(?:(?:automated|automatic|auto-?generated|system[- ]generated|computer[- ]generated|notification|no-?reply)\\s+)?';
const DO_NOT = "(?:do\\s+not|don['’]t)";
const ARE_NOT =
  "(?:are\\s+not|aren['’]t|will\\s+not\\s+be|won['’]t\\s+be|cannot\\s+be|can['’]t\\s+be)";

/**
 * How a mail says that nobody reads a reply to it. An out-of-office note says none of these, and
 * neither does an automatic "we received your mail": those mailboxes are read.
 */
const NO_REPLY_WORDS = [
  // "Please do not reply to this email", "Don't respond to this automated message"
  `\\b${DO_NOT}\\s+(?:reply|respond)\\s+(?:directly\\s+)?to\\s+this\\s+${KIND}(?:e-?mail|mail|message|address|mailbox|notification)\\b`,
  // "This is a system-generated email. Please do not reply."
  `\\b(?:system|computer|auto(?:matically)?)[- ]generated\\b.{0,80}?\\b${DO_NOT}\\s+reply\\b`,
  // "This mailbox is not actively monitored", "this email address is no longer monitored"
  `\\bthis\\s+${MAILBOX}\\s+(?:is\\s+(?:not|no\\s+longer)|isn['’]t)\\s+${HOW}(?:monitored|read|checked|attended|reviewed)\\b`,
  // "This mailbox is unmonitored", "sent from an unmonitored mailbox", "not a monitored mailbox"
  `\\bthis\\s+${MAILBOX}\\s+is\\s+${HOW}(?:unmonitored|unattended)\\b`,
  `\\b(?:unmonitored|unattended|non-?monitored|not\\s+an?\\s+${HOW}monitored)\\s+${MAILBOX}\\b`,
  // "Replies to this email are not actively monitored", "replies to this address will not be read"
  `\\breplies\\s+to\\s+this\\s+${KIND}(?:e-?mail|mail|message|address|mailbox)\\s+${ARE_NOT}\\s+${HOW}(?:monitored|read|answered|received|reviewed|seen)\\b`,
].map((words) => new RegExp(words, 'i'));

/** Where a mail that someone passed on begins: its words are the first sender's, not theirs. */
const FORWARDED = /^(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/im;

/**
 * True when the mail's own text (not the earlier mail it quotes or passes on) says nobody reads a
 * reply to it. Kept as a yes or no on the mail's AI result (`saysNoReply`); the text itself is
 * never kept.
 */
export function saysNoReply(body: string): boolean {
  const own = splitQuoted(body).own.split(FORWARDED)[0].replace(/\s+/g, ' ');
  return NO_REPLY_WORDS.some((words) => words.test(own));
}

/** The addresses whose job mails told this user that nobody reads a reply (`saysNoReply`). */
export async function noReplySenders(db: Db, userId: string): Promise<Set<string>> {
  const mails = await db.email.findMany({
    where: { userId, sender: { not: null }, aiProcessingResult: { saysNoReply: true } },
    select: { sender: true },
    distinct: ['sender'],
  });
  return new Set(mails.map((mail) => mailAddressOf(mail.sender ?? '')));
}

/**
 * False when a reply would reach nobody: a no-reply or delivery mailbox, an applicant-tracking
 * system's own address, or an address whose mail said so (`saidNoReply`, from `noReplySenders`).
 * `sender` is a From or Reply-To value.
 */
export function canReplyTo(sender: string | null, saidNoReply?: ReadonlySet<string>): boolean {
  const address = mailAddressOf(sender ?? '');
  const local = address.split('@')[0];
  if (!local || NO_REPLY.test(local) || DELIVERY_MAILBOXES.includes(local)) return false;
  const domain = senderDomain(address);
  if (domain && isSystemDomain(domain)) return false;
  return !saidNoReply?.has(address);
}

/**
 * Mass outreach: a mail sent as a mailing (`bulkMail`) that the sorting step typed as a recruiter
 * or a career contact reaching out. It never asks the user for anything, and the app never links
 * it to an application by itself. A mail about the user's own application (a confirmation, a
 * rejection, an interview, a test, an offer) is never one, however it was sent: job sites send
 * those as mailings too.
 */
export const isMassOutreach = (mail: { bulkMail: boolean; category: EmailCategory | null }) =>
  mail.bulkMail && (mail.category === 'RECRUITER' || mail.category === 'CAREER_CONTACT');
