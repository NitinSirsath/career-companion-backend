import { z } from 'zod';
import { ApplicationStatusSchema } from './application';
import { WorkspaceQuerySchema } from './workspace';

// GET /api/dashboard: the user's job search in numbers (owner, 27 Oct 2026; reworked 3 Nov 2026).

export const DashboardPeriodSchema = z.enum(['7d', '30d', '90d', 'all']);
export type DashboardPeriod = z.infer<typeof DashboardPeriodSchema>;

export const DashboardQuerySchema = z.object({
  period: DashboardPeriodSchema.default('30d'),
  timeZone: WorkspaceQuerySchema.shape.timeZone,
});
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

const count = z.number().int().nonnegative();
const IsoDateTime = z.iso.datetime();

/** A share with the count it rests on. The page shows the share only from 5 applications. */
const RateSchema = z.object({ count, of: count });

/** The five numbers for one stretch of time. */
const TotalsSchema = z.object({
  applicationsSent: count,
  repliesReceived: count,
  interviewsReached: count,
  offers: count,
  rejections: count,
});

const QuietJobSchema = z.object({
  applicationId: z.string(),
  companyName: z.string(),
  jobTitle: z.string().nullable(),
  status: ApplicationStatusSchema.nullable(),
  daysQuiet: count,
});

const SiteRowSchema = z.object({
  /** The automation's platform name, such as `linkedin`; null for jobs not sent by it. */
  platform: z.string().nullable(),
  sent: count,
  answered: count,
  interviews: count,
});

const WorkModeRowSchema = z.object({
  /** remote, hybrid or onsite as the automation reported it; null when it gave none. */
  workMode: z.string().nullable(),
  sent: count,
  answered: count,
});

const CountWithPeriod = z.object({ total: count, inPeriod: count });

/** The next interview: what the page shows and where the tile leads. */
const InterviewSchema = z.object({
  applicationId: z.string().nullable(),
  companyName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  /** The Mails conversation of the mail that gave the date: its thread ID, or the email's own ID. */
  conversationKey: z.string(),
  date: z.iso.date(),
  /** HH:mm as the mail gave it, or null when it gave no clear time. */
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
});

/** One day (or week) of the period. Applications, replies and interviews add up to the totals. */
const SeriesPointSchema = z.object({
  start: z.iso.date(),
  applicationsSent: count,
  replies: count,
  interviews: count,
  /** Job mails received, by kind: Recruiter or Offer; Interview or Assessment; Rejection; other. */
  replyMails: count,
  interviewMails: count,
  rejectionMails: count,
  otherMails: count,
});

export const DashboardResponseSchema = z.object({
  generatedAt: IsoDateTime,
  period: DashboardPeriodSchema,
  timeZone: z.string(),
  /** The first day the numbers can cover; null when there is no job data yet. */
  dataStartsAt: IsoDateTime.nullable(),
  /** What needs the user now, whatever the period. The counts match the Mails page. */
  now: z.object({
    /** Conversations not opened yet; `today` = those whose newest mail came today. */
    newJobMails: z.object({ count, today: count }),
    /** Open requests (Mails "Needs action"); `waitingOverADay` = answers by mail waiting > 24 h. */
    needsAction: z.object({ count, waitingOverADay: count }),
    /** Interviews from today on, by the dates the AI read off job mails. */
    interviews: z.object({ count, next: InterviewSchema.nullable() }),
  }),
  /** The period, and the same length of time just before it (null for "all"). */
  totals: z.object({ current: TotalsSchema, previous: TotalsSchema.nullable() }),
  /** The last 12 weeks, oldest first, Monday start in the user's time zone, whatever the period. */
  trend: z.object({
    weeks: z.array(
      z.object({
        weekStart: z.iso.date(),
        applicationsSent: count,
        replies: count,
        interviews: count,
        offers: count,
        rejections: count,
      }),
    ),
  }),
  /** The period day by day; week by week when it is longer than 120 days. */
  series: z.object({ bucket: z.enum(['day', 'week']), points: z.array(SeriesPointSchema) }),
  /** Applications sent in the period, by the furthest step they reached. */
  funnel: z.object({
    applied: count,
    answered: count,
    recruiterContact: count,
    assessment: count,
    interview: count,
    offer: count,
  }),
  rates: z.object({ response: RateSchema, interview: RateSchema, offer: RateSchema }),
  /** Median days from applied to the first answer, for first answers in the period. */
  usualReplyDays: z.number().nullable(),
  goneQuiet: z.object({ count, jobs: z.array(QuietJobSchema) }),
  mailbox: z.object({
    /** Inbox mails the sync took in, all time and in the period (whole UTC days). */
    scanned: CountWithPeriod,
    /** Job mails, all time and received in the period. */
    jobMails: CountWithPeriod,
    notLinked: count,
    fakeOffers: count,
  }),
  automation: z.object({
    /** The user has sent at least one application through the automation, ever. */
    used: z.boolean(),
    sites: z.array(SiteRowSchema),
    workModes: z.array(WorkModeRowSchema),
    lookedAt: count,
    sent: count,
    skipped: count,
    needsYou: count,
    topSkipReasons: z.array(z.object({ reason: z.string(), count })),
  }),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
