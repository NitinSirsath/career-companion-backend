import { describe, expect, it } from 'vitest';
import {
  appliedDate,
  automationRows,
  funnel,
  goneQuiet,
  interviewClock,
  interviewDay,
  localDay,
  mailType,
  median,
  mondayOf,
  reachedAt,
  reachedRank,
  series,
  topReasons,
  totals,
  trendWeeks,
  upcomingInterviews,
  usualReplyDays,
  type DashApp,
  type InterviewMail,
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

  it('the series adds up to the totals, day by day in the user time zone', () => {
    const { bucket, points } = series(apps, [], LAST_30, 'Asia/Kolkata');
    expect(bucket).toBe('day');
    // 30 days back from noon UTC is a part day, so the period touches 31 calendar days.
    expect(points).toHaveLength(31);
    expect(points[0].start).toBe(localDay(daysAgo(30), 'Asia/Kolkata'));
    expect(points.at(-1)?.start).toBe('2026-10-27');
    const sum = (key: 'applicationsSent' | 'replies' | 'interviews') =>
      points.reduce((total, point) => total + point[key], 0);
    expect(sum('applicationsSent')).toBe(3);
    expect(sum('replies')).toBe(2);
    expect(sum('interviews')).toBe(1);
    // A job counts its reply once, on its first answer in the period.
    expect(points.find((p) => p.start === localDay(daysAgo(12), 'Asia/Kolkata'))?.replies).toBe(1);
    expect(points.find((p) => p.start === localDay(daysAgo(6), 'Asia/Kolkata'))?.replies).toBe(0);
  });

  it('a long period goes week by week', () => {
    const year = { start: daysAgo(200), end: NOW };
    const { bucket, points } = series([job({ appliedAt: daysAgo(150) })], [], year, 'UTC');
    expect(bucket).toBe('week');
    expect(points.every((p) => mondayOf(p.start) === p.start)).toBe(true);
    expect(points.reduce((total, p) => total + p.applicationsSent, 0)).toBe(1);
  });

  it('job mails of the period by kind; a fake offer is never a reply', () => {
    const mails = [
      { receivedAt: daysAgo(2), category: 'RECRUITER' as const, fakeOffer: false },
      { receivedAt: daysAgo(2), category: 'OFFER' as const, fakeOffer: true },
      { receivedAt: daysAgo(2), category: 'ASSESSMENT' as const, fakeOffer: false },
      { receivedAt: daysAgo(2), category: 'REJECTION' as const, fakeOffer: false },
      { receivedAt: daysAgo(2), category: 'FOLLOW_UP' as const, fakeOffer: false },
      { receivedAt: daysAgo(40), category: 'RECRUITER' as const, fakeOffer: false },
    ];
    expect(mails.map(mailType)).toEqual([
      'replyMails',
      'otherMails',
      'interviewMails',
      'rejectionMails',
      'otherMails',
      'replyMails',
    ]);
    const { points } = series([], mails, LAST_30, 'UTC');
    expect(points.find((p) => p.start === localDay(daysAgo(2), 'UTC'))).toMatchObject({
      replyMails: 1,
      interviewMails: 1,
      rejectionMails: 1,
      otherMails: 2,
    });
    expect(points.reduce((total, p) => total + p.replyMails, 0)).toBe(1);
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

  it('are the last 12, oldest first, with all five numbers', () => {
    const list = trendWeeks(
      [
        job({ appliedAt: new Date('2026-10-26T03:00:00Z') }),
        job({
          appliedAt: daysAgo(40),
          aiStatus: 'REJECTED',
          changes: [
            { toStatus: 'OFFER', changedAt: new Date('2026-10-20T10:00:00Z') },
            { toStatus: 'REJECTED', changedAt: new Date('2026-10-27T08:00:00Z') },
          ],
          mails: [{ receivedAt: new Date('2026-10-20T10:00:00Z'), category: 'OFFER' }],
        }),
      ],
      NOW,
      'Asia/Kolkata',
    );
    expect(list).toHaveLength(12);
    expect(list[0].weekStart).toBe('2026-08-10');
    expect(list[10]).toEqual({
      weekStart: '2026-10-19',
      applicationsSent: 0,
      replies: 1,
      interviews: 1,
      offers: 1,
      rejections: 0,
    });
    expect(list[11]).toEqual({
      weekStart: '2026-10-26',
      applicationsSent: 1,
      replies: 0,
      interviews: 0,
      offers: 0,
      rejections: 1,
    });
  });
});

describe('the usual reply time', () => {
  it('is the median days from applied to the first answer, for first answers in the period', () => {
    const days = usualReplyDays(
      [
        job({ appliedAt: daysAgo(10), mails: [{ receivedAt: daysAgo(8), category: 'RECRUITER' }] }),
        job({ appliedAt: daysAgo(25), mails: [{ receivedAt: daysAgo(5), category: 'REJECTION' }] }),
        job({
          appliedAt: daysAgo(80),
          mails: [{ receivedAt: daysAgo(60), category: 'RECRUITER' }],
        }),
      ],
      LAST_30,
    );
    expect(days).toBe(11);
    expect(usualReplyDays([], LAST_30)).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
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

describe('interviews coming up', () => {
  const mailDay = new Date('2026-10-30T09:00:00Z');

  it('reads a booked day off the AI date text', () => {
    expect(interviewDay('2026-11-05', mailDay)).toBe('2026-11-05');
    expect(interviewDay('Thursday, November 5, 2026', mailDay)).toBe('2026-11-05');
    expect(interviewDay('Nov. 16th, 2026', mailDay)).toBe('2026-11-16');
    expect(interviewDay('16 November 2026', mailDay)).toBe('2026-11-16');
    // No year: the mail's year, or the next one when that would be long before the mail.
    expect(interviewDay('Thursday, 5 November', mailDay)).toBe('2026-11-05');
    expect(interviewDay('January 8', mailDay)).toBe('2027-01-08');
  });

  it('a range, a choice of days or no clear date is not a booked interview', () => {
    expect(interviewDay('November 2-6, 2026 (choose a slot)', mailDay)).toBeNull();
    expect(interviewDay('5 or 6 November', mailDay)).toBeNull();
    expect(interviewDay('November 5 and November 9, 2026', mailDay)).toBeNull();
    expect(interviewDay('next week', mailDay)).toBeNull();
    expect(interviewDay('February 30, 2027', mailDay)).toBeNull();
    expect(interviewDay(null, mailDay)).toBeNull();
  });

  it('reads the time as HH:mm', () => {
    expect(interviewClock('10:00 AM IST')).toBe('10:00');
    expect(interviewClock('2:30 pm')).toBe('14:30');
    expect(interviewClock('12 PM')).toBe('12:00');
    expect(interviewClock('12:15 a.m.')).toBe('00:15');
    expect(interviewClock('14:00 CET')).toBe('14:00');
    expect(interviewClock('morning')).toBeNull();
    expect(interviewClock(null)).toBeNull();
  });

  const mail = (over: Partial<InterviewMail>): InterviewMail => ({
    conversationKey: 'thread-1',
    receivedAt: mailDay,
    applicationId: 'app-1',
    companyName: 'Harbor Analytics',
    jobTitle: 'Designer',
    interviewDate: 'Thursday, November 5, 2026',
    interviewTime: '10:00 AM',
    jobClosed: false,
    ...over,
  });
  const now = new Date('2026-11-03T10:00:00Z');

  it('counts from today on, each interview once, the earliest first', () => {
    const result = upcomingInterviews(
      [
        mail({}),
        // The same interview, confirmed in a second conversation.
        mail({ conversationKey: 'thread-2' }),
        mail({
          conversationKey: 'thread-3',
          applicationId: 'app-2',
          companyName: 'Quill Health',
          interviewDate: '2026-11-09',
          interviewTime: null,
        }),
        mail({ conversationKey: 'thread-4', applicationId: 'app-3', interviewDate: '2026-11-02' }),
        mail({ conversationKey: 'thread-5', applicationId: 'app-4', jobClosed: true }),
        mail({ conversationKey: 'thread-6', applicationId: 'app-5', interviewDate: 'next week' }),
      ],
      now,
      'Asia/Kolkata',
    );
    expect(result).toEqual({
      count: 2,
      next: {
        applicationId: 'app-1',
        companyName: 'Harbor Analytics',
        jobTitle: 'Designer',
        conversationKey: 'thread-1',
        date: '2026-11-05',
        time: '10:00',
      },
    });
  });

  it('a conversation counts its newest date: a moved interview counts once', () => {
    const result = upcomingInterviews(
      [
        mail({ interviewDate: '2026-11-05' }),
        mail({ receivedAt: new Date('2026-11-01T09:00:00Z'), interviewDate: '2026-11-12' }),
      ],
      now,
      'UTC',
    );
    expect(result.count).toBe(1);
    expect(result.next?.date).toBe('2026-11-12');
  });

  it("today's interview still counts, in the user time zone", () => {
    const late = new Date('2026-11-04T20:00:00Z'); // already 5 November in India
    const result = upcomingInterviews([mail({})], late, 'Asia/Kolkata');
    expect(result.count).toBe(1);
    expect(
      upcomingInterviews([mail({})], new Date('2026-11-05T20:00:00Z'), 'Asia/Kolkata').count,
    ).toBe(0);
  });
});
