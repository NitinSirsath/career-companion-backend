import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { runUserCall } from '../services/ai/userCall';
import { getAccessState } from '../services/ai/access';
import { enqueueDashboardTip } from '../services/enqueue';
import {
  aiTipForPage,
  aiTipInput,
  makeAITip,
  ruleTips,
  type DashboardNumbers,
} from '../services/dashboardTips';

vi.mock('../services/ai/userCall', () => ({ runUserCall: vi.fn() }));
vi.mock('../services/ai/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai/access')>()),
  getAccessState: vi.fn(),
}));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueDashboardTip: vi.fn(),
}));

const NOW = new Date('2026-10-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function numbers(over: Partial<DashboardNumbers> = {}): DashboardNumbers {
  const totalsZero = {
    applicationsSent: 0,
    repliesReceived: 0,
    interviewsReached: 0,
    offers: 0,
    rejections: 0,
  };
  return {
    generatedAt: NOW.toISOString(),
    period: '30d',
    timeZone: 'Asia/Kolkata',
    dataStartsAt: '2026-09-01T00:00:00.000Z',
    data: { jobMailsRead: 0, notLinked: 0, waitingForAI: 0, fakeOffers: 0 },
    totals: { current: totalsZero, previous: totalsZero },
    rightNow: { APPLIED: 0, RECRUITER_CONTACT: 0, ASSESSMENT: 0, INTERVIEW: 0, OFFER: 0 },
    funnel: { applied: 0, answered: 0, recruiterContact: 0, assessment: 0, interview: 0, offer: 0 },
    rejectedAfter: { noAnswer: 0, recruiterContact: 0, assessment: 0, interview: 0 },
    weeks: [],
    goneQuiet: { count: 0, jobs: [] },
    answerSpeed: { answered: 0, medianDays: null, p80Days: null, slowest: [] },
    keepingUp: {
      replied: 0,
      medianReplyHours: null,
      waitingOverADay: 0,
      closed: { yourReply: 0, youSaidDone: 0, newerMail: 0, applicationClosed: 0 },
      openNow: 0,
    },
    automation: {
      used: false,
      sites: [],
      workModes: [],
      lookedAt: 0,
      sent: 0,
      skipped: 0,
      needsYou: 0,
      topSkipReasons: [],
    },
    rates: {
      response: { count: 0, of: 0 },
      interview: { count: 0, of: 0 },
      offer: { count: 0, of: 0 },
    },
    ...over,
  };
}

describe('rule tips', () => {
  it('none when nothing is true', () => {
    expect(ruleTips(numbers(), NOW)).toEqual([]);
  });

  it('jobs gone quiet', () => {
    const tips = ruleTips(numbers({ goneQuiet: { count: 4, jobs: [] } }), NOW);
    expect(tips).toEqual([{ kind: 'GONE_QUIET', count: 4 }]);
  });

  it('reply time from 3 replies, or mails waiting more than a day', () => {
    const keep = numbers().keepingUp;
    expect(
      ruleTips(numbers({ keepingUp: { ...keep, replied: 2, medianReplyHours: 5 } }), NOW),
    ).toEqual([]);
    expect(
      ruleTips(numbers({ keepingUp: { ...keep, replied: 3, medianReplyHours: 9 } }), NOW),
    ).toEqual([{ kind: 'REPLY_TIME', medianReplyHours: 9, waitingOverADay: 0 }]);
    expect(
      ruleTips(
        numbers({ keepingUp: { ...keep, replied: 1, medianReplyHours: 2, waitingOverADay: 2 } }),
        NOW,
      ),
    ).toEqual([{ kind: 'REPLY_TIME', medianReplyHours: null, waitingOverADay: 2 }]);
  });

  it('a site that answers clearly more often, both with 5 or more applications', () => {
    const automation = numbers().automation;
    const sites = [
      { platform: 'linkedin', sent: 12, answered: 5, interviews: 3 },
      { platform: 'naukri', sent: 8, answered: 2, interviews: 1 },
      { platform: 'wellfound', sent: 3, answered: 3, interviews: 1 },
      { platform: null, sent: 9, answered: 0, interviews: 0 },
    ];
    expect(ruleTips(numbers({ automation: { ...automation, used: true, sites } }), NOW)).toEqual([
      {
        kind: 'SITE_ANSWERS_MORE',
        site: 'linkedin',
        percent: 42,
        otherSite: 'naukri',
        otherPercent: 25,
      },
    ]);
    const close = [sites[0], { platform: 'naukri', sent: 10, answered: 4, interviews: 1 }];
    expect(
      ruleTips(numbers({ automation: { ...automation, used: true, sites: close } }), NOW),
    ).toEqual([]);
  });

  it('early days in the first week', () => {
    const tips = ruleTips(
      numbers({ dataStartsAt: new Date(NOW.getTime() - 5 * 24 * HOUR).toISOString() }),
      NOW,
    );
    expect(tips).toEqual([{ kind: 'EARLY_DAYS', medianDays: null }]);
  });

  it('at most three', () => {
    const n = numbers({
      goneQuiet: { count: 2, jobs: [] },
      dataStartsAt: NOW.toISOString(),
      keepingUp: { ...numbers().keepingUp, waitingOverADay: 1 },
      automation: {
        ...numbers().automation,
        sites: [
          { platform: 'linkedin', sent: 10, answered: 6, interviews: 1 },
          { platform: 'naukri', sent: 10, answered: 1, interviews: 0 },
        ],
      },
    });
    expect(ruleTips(n, NOW).map((t) => t.kind)).toEqual([
      'GONE_QUIET',
      'REPLY_TIME',
      'SITE_ANSWERS_MORE',
    ]);
  });
});

it('the AI reads counts only, never a company', () => {
  const input = aiTipInput(
    numbers({
      goneQuiet: {
        count: 1,
        jobs: [
          {
            applicationId: 'x',
            companyName: 'Acme',
            jobTitle: 'Dev',
            status: 'APPLIED',
            daysQuiet: 30,
          },
        ],
      },
      answerSpeed: {
        answered: 1,
        medianDays: 4,
        p80Days: 4,
        slowest: [{ companyName: 'Acme', days: 4 }],
      },
    }),
  );
  expect(JSON.stringify(input)).not.toContain('Acme');
  expect(input.jobsGoneQuiet).toBe(1);
});

describe('the AI tip', () => {
  let userId: string;
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { email: 'dashboard-tips@fixture.test' } })).id;
  });
  beforeEach(async () => {
    vi.mocked(runUserCall).mockReset();
    vi.mocked(enqueueDashboardTip).mockReset();
    vi.mocked(getAccessState).mockResolvedValue({ state: 'READY' } as Awaited<
      ReturnType<typeof getAccessState>
    >);
    await prisma.dashboardAITip.deleteMany({ where: { userId } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const answer = (tip: string) =>
    vi
      .mocked(runUserCall)
      .mockResolvedValue({ data: { tip }, provider: 'gemini', model: 'gemini-2.5-flash' });

  it('is made once a day, and again only when the numbers changed', async () => {
    answer('Send more to remote roles.');
    await makeAITip(userId, numbers(), NOW);
    await makeAITip(
      userId,
      numbers({ goneQuiet: { count: 3, jobs: [] } }),
      new Date(NOW.getTime() + HOUR),
    );
    expect(runUserCall).toHaveBeenCalledTimes(1);

    await makeAITip(userId, numbers(), new Date(NOW.getTime() + 25 * HOUR));
    expect(runUserCall).toHaveBeenCalledTimes(1);
    expect((await prisma.dashboardAITip.findUniqueOrThrow({ where: { userId } })).text).toBe(
      'Send more to remote roles.',
    );

    await makeAITip(
      userId,
      numbers({ goneQuiet: { count: 3, jobs: [] } }),
      new Date(NOW.getTime() + 50 * HOUR),
    );
    expect(runUserCall).toHaveBeenCalledTimes(2);
  });

  it('a failed try waits for the next day and keeps no text', async () => {
    vi.mocked(runUserCall).mockRejectedValue(new Error('busy'));
    await makeAITip(userId, numbers(), NOW);
    await makeAITip(userId, numbers(), new Date(NOW.getTime() + HOUR));
    expect(runUserCall).toHaveBeenCalledTimes(1);
    expect(await aiTipForPage(userId, 'Asia/Kolkata', new Date(NOW.getTime() + HOUR))).toBeNull();
  });

  it('the page shows the latest tip with the model name and queues a new one after a day', async () => {
    answer('Keep going.');
    await makeAITip(userId, numbers(), NOW);
    const tip = await aiTipForPage(userId, 'Asia/Kolkata', new Date(NOW.getTime() + HOUR));
    expect(tip).toMatchObject({ text: 'Keep going.' });
    expect(tip?.modelName).not.toBe('');
    expect(enqueueDashboardTip).not.toHaveBeenCalled();
    await aiTipForPage(userId, 'Asia/Kolkata', new Date(NOW.getTime() + 25 * HOUR));
    expect(enqueueDashboardTip).toHaveBeenCalledTimes(1);
  });

  it('no AI tip and no call while the AI is paused or not set up', async () => {
    answer('Keep going.');
    await makeAITip(userId, numbers(), NOW);
    vi.mocked(getAccessState).mockResolvedValue({ state: 'LIMITED' } as Awaited<
      ReturnType<typeof getAccessState>
    >);
    expect(
      await aiTipForPage(userId, 'Asia/Kolkata', new Date(NOW.getTime() + 25 * HOUR)),
    ).toBeNull();
    expect(enqueueDashboardTip).not.toHaveBeenCalled();
  });
});
