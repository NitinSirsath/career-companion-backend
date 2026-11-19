import { vi } from 'vitest';
import type { EmailCategory, RequestClosedReason } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { createProviderClient } from '../../services/ai/providers';
import { fetchMessageBody, fetchMessageMetadata } from '../../services/gmailFetcher';

/** Every field of a detailed read, empty: answers set only what they need. */
export const EMPTY_READ = {
  companyName: 'Brightwave',
  jobTitle: 'Frontend Engineer',
  recruiterName: null,
  recruiterEmail: null,
  interviewStage: null,
  interviewType: null,
  interviewDate: null,
  interviewTime: null,
  assessmentInfo: null,
  assessmentDeadline: null,
  offerInfo: null,
  rejectionInfo: null,
  actionRequired: false,
  requestedAction: null,
  actionDeadline: null,
  followUpRequired: false,
  followUpDate: null,
  extractionConfidence: 0.9,
  provenance: null,
  fakeOfferWarning: null,
  askKind: null,
  closedAsks: [] as { id: string; reason: 'REPLACED' | 'CONFIRMED_DONE' }[],
  replyChoices: [] as string[],
};

interface ReadInput {
  body: string;
  openAsks: { id: string; ask: string }[];
}
interface ReplyInput {
  reply: string;
  openAsks: { id: string; ask: string }[];
}

/** What the made-up AI answers: the mail type by its preview, the read by its text, the reply. */
export interface Answers {
  type?: (snippet: string) => EmailCategory | 'NOT_JOB' | null;
  read?: (input: ReadInput) => Record<string, unknown> | Promise<Record<string, unknown>>;
  reply?: (input: ReplyInput) => {
    asks: { id: string; outcome: 'ANSWERED' | 'DECLINED' | 'ASKED_BACK' | 'NOT_ANSWERED' }[];
    leavesJob: boolean;
  };
}

/** Puts a made-up AI behind the user's AI access, and returns its calls. */
export function fakeAI(answers: Answers) {
  const generateStructured = vi.fn(
    async ({ contract, input }: { contract: { schemaName: string }; input: string }) => {
      const parsed = JSON.parse(input);
      let data: unknown;
      if (contract.schemaName === 'email_relevance') {
        const type = answers.type?.(parsed.snippet) ?? 'INTERVIEW';
        data =
          type === 'NOT_JOB'
            ? { decision: 'IRRELEVANT', confidence: 0.9, reasoning: 'made up' }
            : {
                decision: 'RELEVANT',
                confidence: 0.95,
                reasoning: 'made up',
                ...(type ? { category: type } : {}),
              };
      } else if (contract.schemaName === 'reply_read_v2')
        data = answers.reply?.(parsed) ?? { asks: [], leavesJob: false };
      else data = { ...EMPTY_READ, ...((await answers.read?.(parsed)) ?? {}) };
      return { data, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  );
  vi.mocked(createProviderClient).mockReturnValue({
    generateStructured,
    verifyModels: vi.fn(),
  } as never);
  return generateStructured;
}

/** The made-up mailbox: each message's text, or the error Gmail answers for it. */
export const mailbox = new Map<string, string | Error>();

export const gmailError = (status: number) =>
  Object.assign(new Error('Gmail request failed'), { status });

export function fakeGmail() {
  mailbox.clear();
  const read = async (id: string) => {
    const text = mailbox.get(id);
    if (text instanceof Error) throw text;
    return text ?? '';
  };
  vi.mocked(fetchMessageBody).mockImplementation((_userId, id) => read(id));
  vi.mocked(fetchMessageMetadata).mockImplementation(async (_userId, id) => ({
    labelIds: ['INBOX'],
    snippet: await read(id),
  }));
}

let counter = 0;

export interface MailOptions {
  applicationId?: string;
  ask?: string;
  askKind?: 'REPLY_BY_MAIL' | 'OUTSIDE_MAIL';
  category?: EmailCategory;
  offerInfo?: string;
  companyName?: string;
  version?: string;
  text?: string;
  closed?: { reason: RequestClosedReason; by: string | null; at: Date };
  requestUserState?: 'DONE' | 'OPEN';
  requestUserStateAt?: Date;
}

/** A job mail the AI read before Reanalyze, with its ledger row. */
export async function jobMail(
  userId: string,
  threadId: string,
  receivedAt: Date,
  o: MailOptions = {},
) {
  const gmailMessageId = `ra-${++counter}`;
  mailbox.set(gmailMessageId, o.text ?? `mail ${gmailMessageId}`);
  const version = o.version ?? 'extraction/v6';
  return prisma.email.create({
    data: {
      userId,
      gmailMessageId,
      threadId,
      subject: 'Interview',
      sender: 'Priya Nair <priya@brightwave.example>',
      receivedAt,
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      matchState: o.applicationId ? 'MATCHED' : 'UNMATCHED',
      applicationId: o.applicationId ?? null,
      requestClosedReason: o.closed?.reason ?? null,
      requestClosedByMessageId: o.closed?.by ?? null,
      requestClosedAt: o.closed?.at ?? null,
      requestUserState: o.requestUserState ?? null,
      requestUserStateAt: o.requestUserStateAt ?? null,
      aiProcessingResult: {
        create: {
          provider: 'gemini',
          model: 'old-model',
          contractVersion: version,
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          category: o.category ?? 'INTERVIEW',
          companyName: o.companyName ?? 'Brightwave',
          offerInfo: o.offerInfo ?? null,
          actionRequired: !!o.ask,
          requestedAction: o.ask ?? null,
          askKind: o.ask ? (o.askKind ?? 'REPLY_BY_MAIL') : null,
        },
      },
      aiOperations: {
        create: {
          operation: 'extraction',
          version,
          status: 'COMPLETED',
          result: { old: true },
          provider: 'gemini',
          model: 'old-model',
          startedAt: receivedAt,
          completedAt: receivedAt,
        },
      },
    },
  });
}

/** A reply the user sent, read before (or not) as the state says. */
export async function sentReply(
  userId: string,
  threadId: string,
  sentAt: Date,
  o: { text?: string; state?: 'READ' | 'NOT_READ' | 'ASKED_BACK' | 'WAITING' | null } = {},
) {
  const gmailMessageId = `ra-sent-${++counter}`;
  mailbox.set(gmailMessageId, o.text ?? 'Thanks, that works for me.');
  return prisma.outgoingEmail.create({
    data: {
      userId,
      gmailMessageId,
      threadId,
      sentAt,
      replyReadState: o.state === undefined ? 'READ' : o.state,
    },
  });
}

/** An application's to-do from a mail, as the matcher made it. */
export const toDo = (
  applicationId: string,
  emailId: string,
  description: string,
  status: 'PENDING' | 'COMPLETED' | 'DISMISSED' = 'PENDING',
) =>
  prisma.action.create({
    data: {
      applicationId,
      emailId,
      origin: 'EMAIL',
      type: 'ACTION_REQUIRED',
      description,
      status,
    },
  });
