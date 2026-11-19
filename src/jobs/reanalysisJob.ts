import { REANALYSIS_JOB, ReanalysisJobData } from '../services/enqueue';
import { getQueue } from '../services/queue';
import { runReanalysis } from '../services/reanalysis';
import { stopInterruptedRuns } from '../services/reanalysisRuns';
import { logDebug } from '../utils/log';

/**
 * Reanalyze runs (owner, 19 Nov 2026), one at a time, so a run never floods the AI. Runs a
 * restart left marked as running stop first, as interrupted: no job holds them now.
 */
export async function startReanalysisWorker() {
  await stopInterruptedRuns();
  const queue = await getQueue();
  await queue.work(
    REANALYSIS_JOB,
    { batchSize: 1 },
    async (jobs: { id: string; data: ReanalysisJobData }[]) => {
      const { userId, runId } = jobs[0].data;
      await runReanalysis(userId, runId);
    },
  );
  logDebug('worker_registered', { queue: REANALYSIS_JOB });
}
