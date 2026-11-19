/**
 * Reanalyze's agenda dates (owner, 19 Nov 2026), for the read versions that find interview and
 * assessment times. Dates are matched by kind and time, never by position: found again, kept;
 * new, added for review; gone (or from a fake offer), retired, unless the user confirmed,
 * changed, cancelled or completed it. The mail's saved list keeps the agenda rows' keys, so a
 * later move carries the dates as before. With the agenda switch off, nothing here runs.
 */
import { Prisma } from '@prisma/client';
import type { Application } from '@prisma/client';
import { CandidateEnvelopeSchema } from './ai/temporal';
import type { MailRead, SnapMail } from './reanalysisReplay';

type Envelope = ReturnType<typeof CandidateEnvelopeSchema.parse>;
type EnvelopeCandidate = Envelope['candidates'][number];

/** At most this many dates in a mail's saved list (the list's own limit). */
const MOST_DATES = 5;

interface DatesInput {
  mail: SnapMail;
  read: MailRead;
  /** The mail's application; null when it has none (no agenda, only the saved list). */
  app: Application | null;
  runId: string;
  now: Date;
  fake: boolean;
}

/** Saves the mail's dates after matching them with its agenda. Returns how many changed. */
export async function saveDates(tx: Prisma.TransactionClient, input: DatesInput) {
  const envelope = (input.read.fields as { scheduleCandidates?: Envelope }).scheduleCandidates;
  if (!envelope) return 0;
  const { candidates, changed } = input.app
    ? await matchDates(tx, { ...input, app: input.app }, envelope)
    : { candidates: envelope.candidates, changed: 0 };
  await tx.aIProcessingResult.update({
    where: { emailId: input.mail.id },
    data: {
      scheduleCandidates: { version: envelope.version, candidates } as Prisma.InputJsonValue,
    },
  });
  return changed;
}

async function matchDates(
  tx: Prisma.TransactionClient,
  { mail, read, app, runId, now, fake }: DatesInput & { app: Application },
  envelope: Envelope,
) {
  const rows = await tx.agendaItem.findMany({
    where: { applicationId: app.id, emailId: mail.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const live = rows.filter((row) => !row.retiredAt);
  const touched = (row: (typeof rows)[number]) =>
    row.state !== 'TENTATIVE' || row.userTiming !== null;
  const used = new Set<string>();
  const kept: EnvelopeCandidate[] = [];
  const added: EnvelopeCandidate[] = [];
  for (const [index, candidate] of (fake ? [] : envelope.candidates).entries()) {
    const row = live.find((r) => !used.has(r.id) && dateKey(r.suggestion) === dateKey(candidate));
    if (row) {
      used.add(row.id);
      kept.push({ ...candidate, key: row.candidateKey });
    } else added.push({ ...candidate, key: `rr${runId.slice(0, 8)}:${index}` });
  }
  const held = live.filter((row) => !used.has(row.id) && touched(row));
  const created = added.slice(0, Math.max(0, MOST_DATES - held.length - kept.length));
  let changed = 0;
  for (const row of live) {
    if (used.has(row.id) || touched(row)) continue;
    await tx.agendaItem.update({
      where: { id: row.id },
      data: { retiredAt: now, retiredReason: 'REANALYZED', revision: { increment: 1 } },
    });
    changed++;
  }
  for (const candidate of created) {
    await tx.agendaItem.create({
      data: {
        userId: mail.userId,
        applicationId: app.id,
        emailId: mail.id,
        candidateKey: candidate.key,
        extractionVersion: read.version,
        suggestion: candidate as unknown as Prisma.InputJsonValue,
        state: 'TENTATIVE',
        precision: candidate.temporal.precision,
        date: candidate.temporal.date,
        instant: candidate.temporal.instant ? new Date(candidate.temporal.instant) : null,
      },
    });
    changed++;
  }
  const heldCandidates = held.map((row) => ({
    ...(row.suggestion as Prisma.JsonObject),
    key: row.candidateKey,
  }));
  // A date the user holds stays in the agenda even when the saved list is full.
  return { candidates: [...kept, ...created, ...heldCandidates].slice(0, MOST_DATES), changed };
}

/** A date's identity across reads: its kind and its time, or its words when it has no time. */
function dateKey(candidate: unknown): string {
  const c = candidate as {
    kind?: string;
    rawWhen?: string;
    temporal?: { date?: string | null; instant?: string | null };
  };
  const when = c.temporal?.instant ?? c.temporal?.date ?? (c.rawWhen ?? '').trim().toLowerCase();
  return `${c.kind ?? ''}|${when}`;
}
