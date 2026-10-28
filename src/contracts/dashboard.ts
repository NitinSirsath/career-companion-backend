import { z } from 'zod';
import { ApplicationStatusSchema } from './application';
import { WorkspaceQuerySchema } from './workspace';

// GET /api/dashboard: the user's job search in numbers (owner, 27 Oct 2026).

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

/**
 * A tip from fixed rules, at most three, only when true. The page writes the words; the backend
 * gives the facts, so the site names and the wording have one home.
 */
export const DashboardTipSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('GONE_QUIET'), count }),
  z.object({
    kind: z.literal('REPLY_TIME'),
    medianReplyHours: z.number().nullable(),
    waitingOverADay: count,
  }),
  z.object({
    kind: z.literal('SITE_ANSWERS_MORE'),
    site: z.string(),
    percent: count,
    otherSite: z.string(),
    otherPercent: count,
  }),
  z.object({ kind: z.literal('EARLY_DAYS'), medianDays: z.number().nullable() }),
]);
export type DashboardTip = z.infer<typeof DashboardTipSchema>;

export const DashboardAITipSchema = z.object({
  text: z.string(),
  /** The model's name in words, for "AI tip by …". */
  modelName: z.string(),
  createdAt: IsoDateTime,
});

export const DashboardResponseSchema = z.object({
  generatedAt: IsoDateTime,
  period: DashboardPeriodSchema,
  timeZone: z.string(),
  /** The first day the numbers can cover; null when there is no job data yet. */
  dataStartsAt: IsoDateTime.nullable(),
  data: z.object({
    jobMailsRead: count,
    notLinked: count,
    waitingForAI: count,
    fakeOffers: count,
  }),
  /** The period, and the same length of time just before it (null for "all"). */
  totals: z.object({ current: TotalsSchema, previous: TotalsSchema.nullable() }),
  /** Active applications by the status the user sees, whatever the period. */
  rightNow: z.object({
    APPLIED: count,
    RECRUITER_CONTACT: count,
    ASSESSMENT: count,
    INTERVIEW: count,
    OFFER: count,
  }),
  /** Applications sent in the period, by the furthest step they reached. */
  funnel: z.object({
    applied: count,
    answered: count,
    recruiterContact: count,
    assessment: count,
    interview: count,
    offer: count,
  }),
  /** Rejections in the period, by the step the job had reached. */
  rejectedAfter: z.object({
    noAnswer: count,
    recruiterContact: count,
    assessment: count,
    interview: count,
  }),
  /** The last 12 weeks, oldest first, each starting on a Monday in the user's time zone. */
  weeks: z.array(
    z.object({
      weekStart: z.iso.date(),
      applicationsSent: count,
      answers: count,
      interviews: count,
    }),
  ),
  goneQuiet: z.object({ count, jobs: z.array(QuietJobSchema) }),
  answerSpeed: z.object({
    /** Applications whose first answer came in the period. */
    answered: count,
    medianDays: z.number().nullable(),
    p80Days: z.number().nullable(),
    slowest: z.array(z.object({ companyName: z.string(), days: count })),
  }),
  keepingUp: z.object({
    /** Mails in the period that asked for an answer by mail and got one from the user. */
    replied: count,
    medianReplyHours: z.number().nullable(),
    waitingOverADay: count,
    closed: z.object({
      yourReply: count,
      youSaidDone: count,
      newerMail: count,
      applicationClosed: count,
    }),
    openNow: count,
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
  rates: z.object({ response: RateSchema, interview: RateSchema, offer: RateSchema }),
  tips: z.array(DashboardTipSchema),
  aiTip: DashboardAITipSchema.nullable(),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
