/**
 * Reanalyze (owner, 19 Nov 2026): the AI reads a conversation's job mails and the user's replies
 * again with today's rules, in time order, and the app saves the new reading only when every read
 * worked. Started from the mail page or the application page. No mail text in any of these shapes.
 *
 *   GET  /api/conversations/:key/reanalyze  what it would read, and the newest run with it
 *   POST /api/conversations/:key/reanalyze  start it (202)
 *   GET  /api/applications/:id/reanalyze    the same for the application's conversations
 *   POST /api/applications/:id/reanalyze
 */
import { z } from 'zod';
import { AnalyzedBySchema } from './application';

const IsoDateTime = z.iso.datetime({ offset: true });

/** Why a run stopped. Nothing of the conversation it was reading changed. */
export const ReanalysisStopReasonSchema = z.enum([
  /** A new mail or reply came in, or the user changed something, while it was reading. */
  'NEW_ACTIVITY',
  'GMAIL_DISCONNECTED',
  'GMAIL_FAILED',
  /** The AI was busy or paused. */
  'AI_BUSY',
  /** The AI's daily limit was reached. */
  'AI_LIMIT',
  /** The AI is not set up, or its key stopped working. */
  'AI_UNAVAILABLE',
  /** It took longer than 10 minutes. */
  'TOO_SLOW',
  /** The server restarted while it was reading. */
  'INTERRUPTED',
  'SUSPENDED',
  'FAILED',
]);
export type ReanalysisStopReason = z.infer<typeof ReanalysisStopReasonSchema>;

/** Why it cannot start now; the answer to POST is 409 with the same code. */
export const ReanalysisBlockSchema = z.enum([
  /** No job mail the AI finished reading. */
  'NOTHING_TO_READ',
  /** A mail or reply of it is still being read. */
  'STILL_READING',
  /** Another Reanalyze of the user is running. */
  'RUN_OPEN',
  /** Saved less than 10 minutes ago: see `retryAt`. */
  'REANALYZED_RECENTLY',
  'APPLICATION_ARCHIVED',
  /** More than 20 mails and replies. */
  'TOO_LONG',
  'AI_UNAVAILABLE',
  /** Not enough AI reads left today, after the ones kept free for new mail. */
  'AI_RESERVE',
  'GMAIL_DISCONNECTED',
]);
export type ReanalysisBlock = z.infer<typeof ReanalysisBlockSchema>;

export const ReanalysisRunSchema = z.object({
  id: z.uuid(),
  state: z.enum(['QUEUED', 'RUNNING', 'SAVED', 'STOPPED']),
  stopReason: ReanalysisStopReasonSchema.nullable(),
  /** Conversations it reads, and how many of them it saved. */
  conversations: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
  /** How many things the saves changed: "Reanalyzed. 2 things changed". */
  changed: z.number().int().nonnegative(),
  /** Mails or replies no longer in Gmail; they kept their old read. */
  gone: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type ReanalysisRun = z.infer<typeof ReanalysisRunSchema>;

/** What a Reanalyze would read now, for the confirm. */
export const ReanalysisPreviewSchema = z.object({
  conversations: z.number().int().nonnegative(),
  mails: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  /** The most AI reads it can use: 2 per mail, 1 per reply. */
  maxReads: z.number().int().nonnegative(),
  /** AI reads left today; null when the AI is not set up. */
  readsLeft: z.number().int().nonnegative().nullable(),
  /** Reads always kept free today for new mail. */
  reserve: z.number().int().nonnegative(),
  /** The model that would read, as the AI is set up now. */
  reader: AnalyzedBySchema.nullable(),
  /** The application's conversations left out: saved in the last 10 minutes, or over the cap. */
  leftOut: z.number().int().nonnegative(),
  /** Mails the AI never finished (they wait for the user's OK): not read again. */
  unfinishedMails: z.number().int().nonnegative(),
  blocked: ReanalysisBlockSchema.nullable(),
  /** For REANALYZED_RECENTLY: when it may run again. */
  retryAt: IsoDateTime.nullable(),
});
export type ReanalysisPreview = z.infer<typeof ReanalysisPreviewSchema>;

/** `?preview=1` adds what a new run would read (the confirm); without it only the run comes. */
export const ReanalysisQuerySchema = z.strictObject({ preview: z.enum(['0', '1']).optional() });

/** The newest run that reads this conversation (or was started from this application), and,
 * when asked and none is open, what a new one would read. */
export const ReanalysisStatusSchema = z.object({
  run: ReanalysisRunSchema.nullable(),
  preview: ReanalysisPreviewSchema.nullable(),
});
export type ReanalysisStatus = z.infer<typeof ReanalysisStatusSchema>;
