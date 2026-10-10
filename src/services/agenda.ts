import { Prisma, AgendaItem as Row, Email, Application, AIProcessingResult } from '@prisma/client';
import { prisma } from '../db/prisma';
import { AgendaItemSchema, AgendaQuery, UpdateAgenda } from '../contracts/agenda';
import { TemporalValueSchema, resolveTemporal } from '../contracts/temporal';
import { CandidateEnvelopeSchema } from './ai/temporal';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { createPaginatedResponse } from '../utils/pagination';
import { AppError, CHANGE_REJECTED } from '../errors';
import { agendaExtractionV3Enabled } from '../utils/config';

const context = {
  application: { select: { companyName: true, jobTitle: true, archivedAt: true } },
  email: { select: { subject: true, threadId: true } },
} as const;
function serialize(
  row: Row & {
    application: { companyName: string; jobTitle: string | null; archivedAt: Date | null };
    email: { subject: string | null; threadId: string | null };
  },
) {
  const suggestion = AgendaItemSchema.shape.suggestion.parse(row.suggestion);
  return AgendaItemSchema.parse({
    ...row,
    applicationArchived: row.application.archivedAt !== null,
    suggestion,
    timing: row.userTiming ? TemporalValueSchema.parse(row.userTiming) : suggestion.temporal,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Called inside the existing match transaction and lock order. No queue or provider activity. */
export async function projectAgenda(
  tx: Prisma.TransactionClient,
  email: Email,
  app: Application,
  result: AIProcessingResult,
  reactivate = false,
  carried: Row[] = [],
) {
  if (!result.scheduleCandidates) return;
  const envelope = CandidateEnvelopeSchema.parse(result.scheduleCandidates);
  for (const candidate of envelope.candidates) {
    const existing = await tx.agendaItem.findUnique({
      where: {
        applicationId_emailId_candidateKey: {
          applicationId: app.id,
          emailId: email.id,
          candidateKey: candidate.key,
        },
      },
    });
    if (existing) {
      if (existing.retiredAt && reactivate)
        await tx.agendaItem.update({
          where: { id: existing.id },
          data: { retiredAt: null, retiredReason: null, revision: { increment: 1 } },
        });
      continue;
    }
    // Feature disable stops NEW projections, but never erases or strands existing decisions.
    const source = carried.find((row) => row.candidateKey === candidate.key);
    if (!agendaExtractionV3Enabled() && !source) continue;
    const timing = source?.userTiming
      ? TemporalValueSchema.parse(source.userTiming)
      : candidate.temporal;
    await tx.agendaItem.create({
      data: {
        userId: email.userId,
        applicationId: app.id,
        emailId: email.id,
        candidateKey: candidate.key,
        extractionVersion: result.contractVersion,
        suggestion: candidate,
        ...(source?.userTiming ? { userTiming: source.userTiming } : {}),
        state: source?.state ?? 'TENTATIVE',
        decisionSourceId: source?.id ?? null,
        precision: timing.precision,
        date: timing.date,
        instant: timing.instant ? new Date(timing.instant) : null,
      },
    });
  }
}

export async function updateAgenda(userId: string, id: string, request: UpdateAgenda) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const initial = await tx.agendaItem.findFirst({ where: { id, userId } });
    if (!initial) throw new AppError(404, 'NOT_FOUND', 'Not found');
    await tx.$queryRaw`SELECT id FROM emails WHERE id=${initial.emailId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM applications WHERE id=${initial.applicationId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM agenda_items WHERE id=${id}::uuid FOR UPDATE`;
    const app = await tx.application.findUniqueOrThrow({ where: { id: initial.applicationId } });
    if (app.archivedAt) throw new AppError(409, 'APPLICATION_ARCHIVED', CHANGE_REJECTED);
    const row = await tx.agendaItem.findUniqueOrThrow({
      where: { id },
      include: {
        ...context,
        email: { select: { subject: true, threadId: true, applicationId: true, matchState: true } },
      },
    });
    if (row.revision !== request.expectedRevision)
      throw new AppError(409, 'REVISION_CONFLICT', CHANGE_REJECTED);
    if (
      row.retiredAt ||
      row.email.applicationId !== row.applicationId ||
      row.email.matchState !== 'MATCHED'
    )
      throw new AppError(409, 'AGENDA_RETIRED', CHANGE_REJECTED);
    const current = serialize(row);
    const timing = request.timing ? resolveTemporal(request.timing) : current.timing;
    const state = request.state ?? row.state;
    if (request.timing && timing.precision === 'UNRESOLVED')
      throw new AppError(400, 'TIMING_UNRESOLVED', CHANGE_REJECTED);
    if (['CONFIRMED', 'COMPLETED'].includes(state) && timing.precision === 'UNRESOLVED')
      throw new AppError(400, 'TIMING_UNRESOLVED', CHANGE_REJECTED);
    if (state === 'COMPLETED' && row.state !== 'CONFIRMED' && row.state !== 'COMPLETED')
      throw new AppError(409, 'CONFIRM_FIRST', CHANGE_REJECTED);
    if (state === row.state && JSON.stringify(timing) === JSON.stringify(current.timing))
      return current;
    return serialize(
      await tx.agendaItem.update({
        where: { id },
        data: {
          state,
          ...(request.timing ? { userTiming: timing } : {}),
          precision: timing.precision,
          date: timing.date,
          instant: timing.instant ? new Date(timing.instant) : null,
          revision: { increment: 1 },
        },
        include: context,
      }),
    );
  });
}

const ARCHIVE_FILTERS = {
  all: Prisma.empty,
  archived: Prisma.sql`AND app."archivedAt" IS NOT NULL`,
  active: Prisma.sql`AND app."archivedAt" IS NULL`,
};

export async function readAgenda(
  userId: string,
  q: AgendaQuery,
  limit: number,
  offset: number,
  now = new Date(),
) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: q.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const shift = (days: number) =>
    new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
  const from = q.from ?? (q.view === 'past' ? shift(-30) : today);
  const to = q.to ?? (q.view === 'past' ? shift(1) : shift(30));
  const archiveFilter = ARCHIVE_FILTERS[q.archive ?? 'active'];
  const extra = q.applicationId
    ? Prisma.sql`AND a."applicationId"=${q.applicationId}::uuid`
    : Prisma.empty;
  const effectiveDate = Prisma.sql`CASE WHEN a.precision='DATETIME' THEN (a.instant AT TIME ZONE 'UTC' AT TIME ZONE ${q.timeZone})::date ELSE a.date::date END`;
  const viewFilter = () => {
    if (q.view === 'review') return Prisma.sql`a.state='TENTATIVE' AND a."retiredAt" IS NULL`;
    if (q.view === 'history')
      return q.from
        ? Prisma.sql`(a."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${q.timeZone})::date >= ${from}::date AND (a."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${q.timeZone})::date < ${to}::date`
        : Prisma.sql`TRUE`;
    const state =
      q.view === 'upcoming'
        ? Prisma.sql`a.state='CONFIRMED' AND (CASE WHEN a.precision='DATETIME' THEN a.instant >= ${now} ELSE a.date >= ${today} END)`
        : Prisma.sql`a.state IN ('CONFIRMED','COMPLETED') AND (CASE WHEN a.precision='DATETIME' THEN a.instant < ${now} ELSE a.date < ${today} END)`;
    return Prisma.sql`a."retiredAt" IS NULL AND ${effectiveDate} >= ${from}::date AND ${effectiveDate} < ${to}::date AND ${state}`;
  };
  const filtering = viewFilter();
  const ordering = ['review', 'history'].includes(q.view)
    ? Prisma.sql`a."createdAt" DESC, a.id DESC`
    : Prisma.sql`${effectiveDate}, CASE WHEN a.precision='DATETIME' THEN 0 ELSE 1 END, a.instant ASC NULLS LAST, a.id`;
  const items = await prisma.$transaction(
    async (tx) => {
      const ids = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT a.id FROM agenda_items a JOIN applications app ON app.id=a."applicationId" WHERE a."userId"=${userId}::uuid ${extra} ${archiveFilter} AND (${filtering}) ORDER BY ${ordering} LIMIT ${limit + 1} OFFSET ${offset}`,
      );
      const rows = await tx.agendaItem.findMany({
        where: { userId, id: { in: ids.map((row) => row.id) } },
        include: context,
      });
      const lookup = new Map(rows.map((row) => [row.id, row]));
      return ids.map((row) => serialize(lookup.get(row.id)!));
    },
    { isolationLevel: 'RepeatableRead' },
  );
  return {
    ...createPaginatedResponse(items, limit, offset),
    generatedAt: now.toISOString(),
    timeZone: q.timeZone,
    extractionEnabled: agendaExtractionV3Enabled(),
  };
}
