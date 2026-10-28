import { DASHBOARD_TIP_JOB, DashboardTipJobData } from '../services/enqueue';
import { getQueue } from '../services/queue';
import { makeDashboardTip } from '../services/dashboard';
import { logDebug } from '../utils/log';

/** Makes the Dashboard's AI tip from the user's numbers. */
export async function startDashboardTipWorker() {
  const queue = await getQueue();
  await queue.work(DASHBOARD_TIP_JOB, async (jobs: { id: string; data: DashboardTipJobData }[]) => {
    const { userId, timeZone } = jobs[0].data;
    await makeDashboardTip(userId, timeZone);
  });
  logDebug('worker_registered', { queue: DASHBOARD_TIP_JOB });
}
