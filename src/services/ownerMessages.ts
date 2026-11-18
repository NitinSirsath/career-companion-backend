/**
 * Messages from the Admin page (owner, 18 Nov 2026). A message goes to one account, or to every
 * account that existed when it was sent. It shows at the top of the app until the user closes it
 * (kept per user, so it stays closed on every device) or the owner removes it. Plain text only.
 * An optional push alert goes to the devices with alerts on; suspended accounts get none.
 */
import type { PushDevice } from '@prisma/client';
import type {
  AdminMessagesResponse,
  AdminSentMessage,
  MyMessagesResponse,
  SendOwnerMessageRequest,
} from '../contracts/messages';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { logEvent } from '../utils/log';
import { sendToDevice } from './notifications/webPush';

/** Shown to a user at most at once; older ones show after these are closed. */
const SHOWN_AT_ONCE = 5;
const SENT_LISTED = 10;
const ALERT_BODY_MAX = 120;

const notFound = () => new AppError(404, 'NOT_FOUND', 'This message does not exist.');

/** The messages this user may see, not removed: their own, and those to everyone sent after they joined. */
function visibleTo(user: { id: string; createdAt: Date }) {
  return {
    removedAt: null,
    OR: [{ userId: user.id }, { userId: null, createdAt: { gte: user.createdAt } }],
  };
}

export async function listMyMessages(userId: string): Promise<MyMessagesResponse> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, createdAt: true },
  });
  const rows = await prisma.ownerMessage.findMany({
    where: { ...visibleTo(user), dismissals: { none: { userId } } },
    orderBy: { createdAt: 'desc' },
    take: SHOWN_AT_ONCE,
    select: { id: true, text: true, createdAt: true },
  });
  return {
    messages: rows.map((row) => ({
      id: row.id,
      text: row.text,
      sentAt: row.createdAt.toISOString(),
    })),
  };
}

/** Closes the message for this user on every device. Closing it again changes nothing. */
export async function dismissMessage(userId: string, messageId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, createdAt: true },
  });
  const message = await prisma.ownerMessage.findFirst({
    where: { id: messageId, ...visibleTo(user) },
    select: { id: true },
  });
  if (!message) throw notFound();
  await prisma.ownerMessageDismissal.upsert({
    where: { messageId_userId: { messageId, userId } },
    create: { messageId, userId },
    update: {},
  });
}

const sentSelect = {
  id: true,
  text: true,
  createdAt: true,
  alertsSent: true,
  removedAt: true,
  user: { select: { email: true } },
} as const;

function toSent(row: {
  id: string;
  text: string;
  createdAt: Date;
  alertsSent: number | null;
  removedAt: Date | null;
  user: { email: string } | null;
}): AdminSentMessage {
  return {
    id: row.id,
    text: row.text,
    toEmail: row.user?.email ?? null,
    sentAt: row.createdAt.toISOString(),
    alertsSent: row.alertsSent,
    removedAt: row.removedAt?.toISOString() ?? null,
  };
}

export async function adminListMessages(): Promise<AdminMessagesResponse> {
  const [rows, devices] = await Promise.all([
    prisma.ownerMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: SENT_LISTED,
      select: sentSelect,
    }),
    prisma.pushDevice.groupBy({
      by: ['userId'],
      where: { user: { suspendedAt: null } },
      _count: { _all: true },
    }),
  ]);
  return {
    messages: rows.map(toSent),
    alertDevices: Object.fromEntries(devices.map((row) => [row.userId, row._count._all])),
  };
}

/** The devices that get the alert: the account's own, or every account's that existed at `sentAt`. */
function alertDevices(to: string | null, sentAt: Date): Promise<PushDevice[]> {
  return prisma.pushDevice.findMany({
    where: {
      user: { suspendedAt: null, ...(to ? { id: to } : { createdAt: { lte: sentAt } }) },
    },
  });
}

const alertBody = (text: string) =>
  text.length <= ALERT_BODY_MAX ? text : `${text.slice(0, ALERT_BODY_MAX - 1).trimEnd()}…`;

export async function sendOwnerMessage(input: SendOwnerMessageRequest): Promise<AdminSentMessage> {
  const to = input.to === 'EVERYONE' ? null : input.to;
  if (to && !(await prisma.user.findUnique({ where: { id: to }, select: { id: true } })))
    throw new AppError(404, 'NOT_FOUND', 'This account does not exist.');
  const message = await prisma.ownerMessage.create({ data: { userId: to, text: input.text } });
  let alertsSent: number | null = null;
  if (input.alsoAlert) {
    const devices = await alertDevices(to, message.createdAt);
    const outcomes = await Promise.all(
      devices.map((device) =>
        sendToDevice(device, {
          title: 'NorthList',
          body: alertBody(input.text),
          url: '/',
          tag: `owner-${message.id}`,
        }),
      ),
    );
    alertsSent = outcomes.filter((outcome) => outcome === 'sent').length;
    await prisma.ownerMessage.update({ where: { id: message.id }, data: { alertsSent } });
  }
  logEvent('owner_message_sent', { messageId: message.id, everyone: !to, alertsSent });
  const row = await prisma.ownerMessage.findUniqueOrThrow({
    where: { id: message.id },
    select: sentSelect,
  });
  return toSent(row);
}

/** Stops showing the message; it stays in the Sent list as removed. */
export async function removeOwnerMessage(messageId: string): Promise<AdminSentMessage> {
  const { count } = await prisma.ownerMessage.updateMany({
    where: { id: messageId, removedAt: null },
    data: { removedAt: new Date() },
  });
  const row = await prisma.ownerMessage.findUnique({
    where: { id: messageId },
    select: sentSelect,
  });
  if (!row) throw notFound();
  if (count) logEvent('owner_message_removed', { messageId });
  return toSent(row);
}
