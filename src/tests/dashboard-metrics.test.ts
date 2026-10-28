import { describe, expect, it } from 'vitest';
import {
  answerSpeed,
  appliedDate,
  automationRows,
  funnel,
  goneQuiet,
  localDay,
  median,
  mondayOf,
  percentile80,
  reachedAt,
  reachedRank,
  rejectedAfter,
  replyHours,
  rightNow,
  topReasons,
  totals,
  weeks,
  type DashApp,
} from '../services/dashboardMetrics';

const NOW = new Date('2026-10-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const LAST_30 = { start: daysAgo(30), end: NOW };

let next = 0;
function job(over: Partial<DashApp> = {}): DashApp {
  next += 1;
  return {
    id: `app-${next}`,
    companyName: `Company ${next}`,
    jobTitle: 'Engineer',
    aiStatus: null,
    userStatus: null,
    userStatusSetAt: null,
    appliedAt: null,
    createdAt: daysAgo(5),
    archivedAt: null,
    changes: [],
    mails: [],
    ...over,
  };
}

describe('the applied date', () => {
  it('is appliedAt, else the first linked mail, else when the application was made', () => {
    expect(
      appliedDate(
        job({ appliedAt: daysAgo(9), mails: [{ receivedAt: daysAgo(8), category: 'FOLLOW_UP' }] }),
      ),
    ).toEqual(daysAgo(9));
    expect(
      appliedDate(
        job({
          mails: [
            { receivedAt: daysAgo(4), category: 'RECRUITER' },
            { receivedAt: daysAgo(8), category: 'FOLLOW_UP' },
          ],
        }),
      ),
    ).toEqual(daysAgo(8));
    expect(appliedDate(job({ createdAt: daysAgo(3) }))).toEqual(daysAgo(3));
  });
});

describe('the furthest step reached', () => {
  it('keeps the step a rejected job got to', () => {
    const rejected = job({
      aiStatus: 'REJECTED',
      changes: [
        { toStatus: 'INTERVIEW', changedAt: daysAgo(10) },
        { toStatus: 'REJECTED', changedAt: daysAgo(2) },
      ],
    });
    expect(reachedRank(rejected)).toBe(3);
    expect(reachedAt(rejected, 3)).toEqual(daysAgo(10));
  });

  it("the user's own open status wins over the AI", () => {
    const corrected = job({
      aiStatus: 'INTERVIEW',
      userStatus: 'APPLIED',
      changes: [{ toStatus: 'INTERVIEW', changedAt: daysAgo(10) }],
    });
    expect(reachedRank(corrected)).toBe(0);
    expect(reachedAt(corrected, 3)).toBeNull();
  });

  it('a job with no status counts as applied', () => {
    expect(reachedRank(job())).toBe(0);
  });
});

describe('the numbers for a period', () => {
  const apps = [
    job({
      appliedAt: daysAgo(20),
      aiStatus: 'APPLIED',
      mails: [{ receivedAt: daysAgo(20), category: 'FOLLOW_UP' }],
    }),
    job({
      appliedAt: daysAgo(15),
      aiStatus: 'INTERVIEW',
      changes: [
        { toStatus: 'RECRUITER_CONTACT', changedAt: daysAgo(12) },
        { toStatus: 'INTERVIEW', changedAt: daysAgo(6) },
      ],
      mails: [
        { receivedAt: daysAgo(12), category: 'RECRUITER' },
        { receivedAt: daysAgo(6), category: 'INTERVIEW' },
      ],
    }),
    job({
      appliedAt: daysAgo(10),
      aiStatus: 'REJECTED',
      changes: [{ toStatus: 'REJECTED', changedAt: daysAgo(3) }],
      mails: [{ receivedAt: daysAgo(3), category: 'REJECTION' }],
    }),
    job({ appliedAt: daysAgo(45) }),
  ];

  it('counts what happened in the period only', () => {
    expect(totals(apps, LAST_30)).toEqual({
      applicationsSent: 3,
      repliesReceived: 2,
      interviewsReached: 1,
      offers: 0,
      rejections: 1,
    });
  });

  it('a follow-up mail is not an answer', () => {
    expect(funnel(apps, LAST_30)).toEqual({
      applied: 3,
      answered: 2,
      recruiterContact: 1,
      assessment: 1,
      interview: 1,
      offer: 0,
    });
  });

  it('a job rejected straight away ended before any answer', () => {
    expect(rejectedAfter(apps, LAST_30)).toEqual({
      noAnswer: 1,
      recruiterContact: 0,
      assessment: 0,
      interview: 0,
    });
  });

  it('right now counts active jobs by step, whatever the period', () => {
    expect(rightNow([...apps, job({ aiStatus: 'OFFER', archivedAt: daysAgo(1) })])).toEqual({
      APPLIED: 2,
      RECRUITER_CONTACT: 0,
      ASSESSMENT: 0,
      INTERVIEW: 1,
      OFFER: 0,
    });
  });
});

describe('gone quiet', () => {
  it('21 days at Applied with no answer, or 14 days in a later step with no new mail', () => {
    const quiet = goneQuiet(
      [
        job({ companyName: 'Applied 22', appliedAt: daysAgo(22) }),
        job({ companyName: 'Applied 20', appliedAt: daysAgo(20) }),
        job({
          companyName: 'Interview 15',
          aiStatus: 'INTERVIEW',
          appliedAt: daysAgo(40),
          changes: [{ toStatus: 'INTERVIEW', changedAt: daysAgo(15) }],
          mails: [{ receivedAt: daysAgo(15), category: 'INTERVIEW' }],
        }),
        job({
          companyName: 'Interview 13',
          aiStatus: 'INTERVIEW',
          appliedAt: daysAgo(40),
          mails: [{ receivedAt: daysAgo(13), category: 'INTERVIEW' }],
        }),
        job({ companyName: 'Rejected', aiStatus: 'REJECTED', appliedAt: daysAgo(60) }),
      ],
      NOW,
    );
    expect(quiet.jobs.map((j) => [j.companyName, j.daysQuiet])).toEqual([
      ['Applied 22', 22],
      ['Interview 15', 15],
    ]);
    expect(quiet.count).toBe(2);
  });
});

describe('weeks', () => {
  it('start on Monday in the user time zone', () => {
    expect(mondayOf('2026-10-27')).toBe('2026-10-26');
    expect(mondayOf('2026-10-26')).toBe('2026-10-26');
    // Sunday 20:00 in UTC is already Monday in India.
    const sunday = new Date('2026-10-25T20:00:00Z');
    expect(localDay(sunday, 'UTC')).toBe('2026-10-25');
    expect(mondayOf(localDay(sunday, 'Asia/Kolkata'))).toBe('2026-10-26');
  });

  it('are the last 12, oldest first', () => {
    const list = weeks([job({ appliedAt: new Date('2026-10-26T03:00:00Z') })], NOW, 'Asia/Kolkata');
    expect(list).toHaveLength(12);
    expect(list[0].weekStart).toBe('2026-08-10');
    expect(list[11]).toEqual({
      weekStart: '2026-10-26',
      applicationsSent: 1,
      answers: 0,
      interviews: 0,
    });
  });
});

describe('how fast companies answer', () => {
  it('days from applied to the first answer, for first answers in the period', () => {
    const speed = answerSpeed(
      [
        job({
          companyName: 'Fast',
          appliedAt: daysAgo(10),
          mails: [{ receivedAt: daysAgo(8), category: 'RECRUITER' }],
        }),
        job({
          companyName: 'Slow',
          appliedAt: daysAgo(25),
          mails: [{ receivedAt: daysAgo(5), category: 'REJECTION' }],
        }),
        job({
          companyName: 'Old',
          appliedAt: daysAgo(80),
          mails: [{ receivedAt: daysAgo(60), category: 'RECRUITER' }],
        }),
      ],
      LAST_30,
    );
    expect(speed).toEqual({
      answered: 2,
      medianDays: 11,
      p80Days: 20,
      slowest: [
        { companyName: 'Slow', days: 20 },
        { companyName: 'Fast', days: 2 },
      ],
    });
  });

  it('median and the 8-in-10 value', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(percentile80([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(8);
  });
});

describe('sites and work modes', () => {
  it('come from automation submissions; other jobs are one row', () => {
    const linked = job({ appliedAt: daysAgo(5), aiStatus: 'INTERVIEW' });
    const plain = job({ appliedAt: daysAgo(4) });
    const rows = automationRows(
      [linked, plain],
      [
        {
          platform: 'linkedin',
          workMode: 'Remote',
          submittedAt: daysAgo(5),
          applicationId: linked.id,
        },
        {
          platform: 'linkedin',
          workMode: 'remote',
          submittedAt: daysAgo(5),
          applicationId: linked.id,
        },
        { platform: 'naukri', workMode: null, submittedAt: daysAgo(50), applicationId: plain.id },
      ],
      { start: daysAgo(30), end: NOW },
    );
    expect(rows.sites).toEqual([{ platform: 'linkedin', sent: 1, answered: 1, interviews: 1 }]);
    expect(rows.workModes).toEqual([{ workMode: 'remote', sent: 1, answered: 1 }]);
  });

  it('jobs never sent by the automation are one row', () => {
    const rows = automationRows([job({ appliedAt: daysAgo(3) })], [], LAST_30);
    expect(rows.sites).toEqual([{ platform: null, sent: 1, answered: 0, interviews: 0 }]);
  });

  it('top skip reasons', () => {
    expect(topReasons(['Too senior', 'Location', ' Too senior ', '', 'Pay'], 2)).toEqual([
      { reason: 'Too senior', count: 2 },
      { reason: 'Location', count: 1 },
    ]);
  });
});

describe('reply time', () => {
  it('hours from a mail to the first reply after it in the same thread', () => {
    expect(
      replyHours(
        [
          { threadId: 't1', receivedAt: new Date('2026-10-20T08:00:00Z') },
          { threadId: 't2', receivedAt: new Date('2026-10-20T08:00:00Z') },
          { threadId: null, receivedAt: new Date('2026-10-20T08:00:00Z') },
        ],
        [
          { threadId: 't1', sentAt: new Date('2026-10-19T08:00:00Z') },
          { threadId: 't1', sentAt: new Date('2026-10-20T17:00:00Z') },
          { threadId: 't1', sentAt: new Date('2026-10-21T08:00:00Z') },
        ],
      ),
    ).toEqual([9]);
  });
});
