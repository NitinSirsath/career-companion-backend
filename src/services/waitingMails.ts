/**
 * Job mails that wait for an application are matched again when one appears for their company
 * (owner, 26 Nov 2026): after a link by hand, when NorthList Apply reports the job, and once an
 * hour for everyone. Matching otherwise runs once, when a mail is read, so a confirmation read
 * before its job was saved, or before a matching rule got better, stayed unlinked for ever.
 *
 * The matcher's own rules decide every time, and no AI call is made: mass outreach, a career
 * contact and a fake offer are never linked; a mail the user linked or unlinked by hand is never
 * touched; and when two applications fit, the mail is not linked but waits for the user's choice.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logError, logEvent } from '../utils/log';
import { companyKey, sameCompany } from './companyName';
import { conversationWhere } from './conversationQuery';
import { matchEmailToApplication } from './matcher';

/** How many waiting mails of one user are looked at, newest first. */
const SWEEP_LIMIT = 1000;

/** A job mail with a company that nothing linked and the user did not decide on. */
const WAITING = {
  relevanceState: 'RELEVANT',
  matchState: 'UNMATCHED',
  matchConfirmedBy: null,
  aiProcessingResult: { companyName: { not: null } },
} satisfies Prisma.EmailWhereInput;

/** The user's waiting mails with the company the AI read, newest first. */
async function waitingMailsOf(userId: string, exceptKey?: string) {
  const mails = await prisma.email.findMany({
    where: { userId, ...WAITING, ...(exceptKey ? { NOT: conversationWhere(exceptKey) } : {}) },
    select: { id: true, aiProcessingResult: { select: { companyName: true } } },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: SWEEP_LIMIT,
  });
  return mails.map((mail) => ({
    id: mail.id,
    company: mail.aiProcessingResult?.companyName ?? '',
  }));
}

/** Oldest first, so the application's timeline records the mails in the order they arrived. */
async function matchOldestFirst(newestFirst: { id: string }[]) {
  for (const mail of [...newestFirst].reverse()) await matchEmailToApplication(mail.id);
  return newestFirst.length;
}

/**
 * Runs the matcher again on the user's waiting mails of this company. `exceptKey` leaves one
 * conversation out: the one just linked by hand. Returns how many mails were checked.
 */
export async function matchWaitingMails(userId: string, companyName: string, exceptKey?: string) {
  const waiting = await waitingMailsOf(userId, exceptKey);
  return matchOldestFirst(waiting.filter((mail) => sameCompany(mail.company, companyName)));
}

/**
 * The hourly second look, for every user: waiting mails whose company the user has an active
 * application at go through the matcher again. So a rule that got better (a job title with extra
 * words, a company with "Limited") also links the mails read before it. A user with no such mail
 * costs one query. One user's failure is logged and never stops the others. Returns how many
 * mails were tried and how many are linked now.
 */
export async function matchAllWaitingMails() {
  const users = await prisma.user.findMany({
    where: { emails: { some: WAITING }, applications: { some: { archivedAt: null } } },
    select: {
      id: true,
      applications: { where: { archivedAt: null }, select: { companyName: true } },
    },
  });
  let tried = 0;
  let linked = 0;
  for (const user of users) {
    try {
      const companies = new Set(user.applications.map((app) => companyKey(app.companyName)));
      const waiting = (await waitingMailsOf(user.id)).filter(
        (mail) => !!companyKey(mail.company) && companies.has(companyKey(mail.company)),
      );
      tried += await matchOldestFirst(waiting);
      linked += await prisma.email.count({
        where: { id: { in: waiting.map((mail) => mail.id) }, matchState: 'MATCHED' },
      });
    } catch (err) {
      logError('waiting_mails_match_failed', { userId: user.id }, err);
    }
  }
  if (linked) logEvent('waiting_mails_linked', { tried, linked });
  return { tried, linked };
}
