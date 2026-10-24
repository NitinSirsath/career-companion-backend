/**
 * "Read waiting mails now": the user asks for a new try instead of waiting for a pause to end.
 */
import type { ReadWaitingMailResponse } from '../../contracts/ai';
import { getAccessState } from './access';
import { isFreeAIPause } from './freeAI';
import { offerTestMail, reofferPendingEmails } from './offer';
import { readSettings } from './settings';
import { logEvent } from '../../utils/log';

/**
 * Asks for a new try of the user's waiting mail, then returns the AI settings.
 *
 * While a model is paused, one waiting mail that needs it goes first as a test: only that mail
 * may use the paused model until the model answers. If it works, that pause ends and the other
 * mail follows by itself. If the model is still busy, the pause starts again from that answer but
 * does not get longer, and the test's result is kept. With no mail waiting for a paused model,
 * the waiting mail is offered again. Every try is a real call and counts toward the daily safety
 * limit. Nothing is offered while a test mail waits for its answer, access needs the user (key,
 * billing, model), the daily safety limit is reached, or Career Companion has paused AI. The free
 * AI's shared pause is not tested: its waiting mail is offered again and waits for it.
 */
export async function readWaitingNow(userId: string): Promise<ReadWaitingMailResponse> {
  const access = await getAccessState(userId);
  // One test at a time: another click (a second tab, a page not yet updated) sends nothing.
  const running = access.pauses.find((pause) => pause.testEmailId);
  if (running) {
    logEvent('ai_read_waiting_requested', {
      userId,
      testEmailId: running.testEmailId,
      alreadyTesting: true,
    });
    return readSettings(userId);
  }
  // The free AI's shared pause has no test: it ends by itself for everyone on it.
  const own = access.pauses.filter((pause) => !isFreeAIPause(pause.reason));
  const testEmailId =
    access.state === 'READY' && own.length ? await offerTestMail(userId, own) : null;
  if (testEmailId)
    logEvent('ai_read_waiting_requested', {
      userId,
      testEmailId,
      pausedModels: access.pauses.map((pause) => pause.model),
    });
  else
    logEvent('ai_read_waiting_requested', {
      userId,
      offered: await reofferPendingEmails(userId),
    });
  return readSettings(userId);
}
