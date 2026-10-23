/**
 * Job-mail conversations: one row per Gmail thread of job-related email, with what the sender
 * asks for and the application it belongs to. No email body is part of any of these shapes.
 */
import { z } from 'zod';
import {
  AnalyzedBySchema,
  ApplicationResponseSchema,
  ApplicationStatusSchema,
} from './application';
import { createPaginatedResponseSchema } from './pagination';

const IsoDateTime = z.iso.datetime({ offset: true });

export const MailCategorySchema = z.enum([
  'RECRUITER',
  'INTERVIEW',
  'ASSESSMENT',
  'OFFER',
  'REJECTION',
  'FOLLOW_UP',
  'NEWSLETTER',
  'SPAM',
]);
export type MailCategory = z.infer<typeof MailCategorySchema>;

/**
 * Where the newest request of a conversation stands. REPLIED is derived: the user sent a message
 * in the conversation after the request arrived.
 */
export const RequestStateSchema = z.enum(['OPEN', 'REPLIED', 'DONE']);
export type RequestState = z.infer<typeof RequestStateSchema>;

export const ConversationRequestSchema = z.object({
  /** The email that makes the request. */
  emailId: z.uuid(),
  state: RequestStateSchema,
  kind: z.enum(['ACTION', 'FOLLOW_UP']),
  /**
   * The request in the AI's words; null for a plain follow-up or when the AI gave none. For a mail
   * with a fake offer warning, the safe next step, with no deadline.
   */
  text: z.string().nullable(),
  deadline: IsoDateTime.nullable(),
  deadlinePrecision: z.enum(['DATE', 'DATETIME']).nullable(),
  /** The user's newest message after the request; null when there is none. */
  repliedAt: IsoDateTime.nullable(),
});
export type ConversationRequest = z.infer<typeof ConversationRequestSchema>;

/** How the conversation stands with applications. */
export const ConversationLinkSchema = z.enum(['LINKED', 'UNLINKED', 'NEEDS_REVIEW', 'IGNORED']);
export type ConversationLink = z.infer<typeof ConversationLinkSchema>;

export const ConversationSchema = z.object({
  /** The Gmail thread ID, or the email's own ID when Gmail gave no thread. */
  key: z.string(),
  threadId: z.string().nullable(),
  /** Subject and sender of the newest job email. */
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  lastReceivedAt: IsoDateTime.nullable(),
  mailCount: z.number().int().nonnegative(),
  /** The user's own messages recorded in this conversation. */
  sentCount: z.number().int().nonnegative(),
  /** True until the user opens the conversation. */
  isNew: z.boolean(),
  category: MailCategorySchema.nullable(),
  /** Company and role as the AI read them from the newest email that names them. */
  company: z.string().nullable(),
  role: z.string().nullable(),
  /** The interview date and time as written in the email; not a verified calendar time. */
  interview: z.object({ date: z.string().nullable(), time: z.string().nullable() }).nullable(),
  assessmentDeadline: z.string().nullable(),
  request: ConversationRequestSchema.nullable(),
  /**
   * Set when a received mail of the conversation looks like a fake job offer that asks for money
   * or bank, card or ID details: the newest such warning, in the AI's words. `request` then holds
   * the safe next step, never the mail's own request.
   */
  fakeOfferWarning: z.string().nullable(),
  link: ConversationLinkSchema,
  application: z
    .object({
      id: z.uuid(),
      companyName: z.string(),
      jobTitle: z.string().nullable(),
      effectiveStatus: ApplicationStatusSchema.nullable(),
      archived: z.boolean(),
    })
    .nullable(),
  analyzedBy: AnalyzedBySchema.nullable(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ListConversationsResponseSchema = createPaginatedResponseSchema(ConversationSchema);
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;

export const ConversationSortSchema = z.enum(['attention', 'newest']);

/** Query filters of GET /api/conversations. */
export const ConversationFiltersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  /** `none`: conversations that ask for nothing. */
  request: z.enum(['open', 'replied', 'done', 'none']).optional(),
  category: MailCategorySchema.optional(),
  /** `any`: linked to an application; `none`: not linked; or one application's ID. */
  application: z.union([z.enum(['any', 'none']), z.uuid()]).optional(),
  unseen: z.literal('true').optional(),
  /** `attention` (default) lists open requests first; both then go newest first. */
  sort: ConversationSortSchema.optional(),
});
export type ConversationFilters = z.infer<typeof ConversationFiltersSchema>;

/** One job email of a conversation with what the AI read from it. */
export const ConversationMailSchema = z.object({
  id: z.uuid(),
  gmailMessageId: z.string(),
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  receivedAt: IsoDateTime.nullable(),
  category: MailCategorySchema.nullable(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  recruiterName: z.string().nullable(),
  recruiterEmail: z.string().nullable(),
  interviewStage: z.string().nullable(),
  interviewType: z.string().nullable(),
  interviewDate: z.string().nullable(),
  interviewTime: z.string().nullable(),
  assessmentInfo: z.string().nullable(),
  assessmentDeadline: z.string().nullable(),
  offerInfo: z.string().nullable(),
  rejectionInfo: z.string().nullable(),
  /** For a mail with `fakeOfferWarning`, the safe next step instead of the mail's request. */
  requestedAction: z.string().nullable(),
  actionDeadline: z.string().nullable(),
  followUpDate: z.string().nullable(),
  /** Set when the mail looks like a fake job offer that asks for money: the signs the AI saw. */
  fakeOfferWarning: z.string().nullable(),
  analyzedBy: AnalyzedBySchema.nullable(),
});
export type ConversationMail = z.infer<typeof ConversationMailSchema>;

export const ConversationDetailSchema = z.object({
  conversation: ConversationSchema,
  /** Oldest first. */
  mails: z.array(ConversationMailSchema),
  /** When the user's own recorded messages were sent, oldest first. */
  sentAt: z.array(IsoDateTime),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

/** `emailId` names the request the user saw, so an answer never lands on a newer one. */
export const SetRequestStateSchema = z.strictObject({
  emailId: z.uuid(),
  state: z.enum(['DONE', 'OPEN']),
});
export type SetRequestState = z.infer<typeof SetRequestStateSchema>;

/**
 * Gives a conversation its application. An empty body creates one from the company and role the
 * AI read; `companyName` and `jobTitle` replace what the AI read; `applicationId` joins an
 * application the user already has.
 */
export const LinkConversationSchema = z.union([
  z.strictObject({ applicationId: z.uuid() }),
  z.strictObject({
    companyName: z.string().trim().min(1).max(200).optional(),
    jobTitle: z.string().trim().min(1).max(200).optional(),
  }),
]);
export type LinkConversation = z.infer<typeof LinkConversationSchema>;

export const LinkConversationResponseSchema = z.object({
  application: ApplicationResponseSchema,
  conversation: ConversationSchema,
  /** False when the conversation joined an application the user already had. */
  created: z.boolean(),
});
export type LinkConversationResponse = z.infer<typeof LinkConversationResponseSchema>;

/** Details of 409 APPLICATION_CHOICE_REQUIRED: the applications the conversation may belong to. */
export const ApplicationChoiceDetailsSchema = z.object({
  candidates: z.array(
    z.object({ id: z.uuid(), companyName: z.string(), jobTitle: z.string().nullable() }),
  ),
});
export type ApplicationChoiceDetails = z.infer<typeof ApplicationChoiceDetailsSchema>;

export const ConversationSeenResponseSchema = z.object({ seen: z.literal(true) });
