import { candidateEnvelope, verifiedCandidates } from './temporal';
import type { EmailCategory, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { fetchMessageBody, fetchMessageMetadata } from '../gmailFetcher';
import { matchEmailToApplication } from '../matcher';
import { AIAccess, resolveAIAccess } from './access';
import {
  AI_CONTRACT_VERSIONS,
  CLASSIFICATION_VERSIONS,
  LEGACY_CONTRACT_VERSIONS,
  RELEVANCE_BATCH_VERSIONS,
  classificationContractFor,
  CLASSIFICATION_INPUT_LIMITS as LIMITS,
  EXTRACTION_BODY_LIMIT,
  EXTRACTION_CONTRACT,
  EXTRACTION_V3_CONTRACT,
  JobExtractionSchema,
  JobExtractionV3Schema,
  AIContract,
  JobExtractionResult,
  RelevanceClassifierInput,
} from './contracts';
import { TerminalAIError } from './errors';
import { runOperation } from './operations';
import { agendaExtractionV3Enabled } from '../../utils/config';
import { autoIrrelevant, classifyOne, triageBatchEnabled, relevanceThreshold } from './triage';

type RelevanceOutcome = {
  data: {
    decision: 'RELEVANT' | 'IRRELEVANT' | 'UNCERTAIN';
    confidence: number;
    category: EmailCategory | null;
  };
  provider: string | null;
  model: string | null;
  version: string;
};

/** Ledger rows from before provenance was recorded carry no model; keep the stored one. */
function provenance(
  produced: { provider: string | null; model: string | null },
  stored: { provider: string; model: string } | null,
) {
  return {
    provider: produced.provider ?? stored?.provider ?? 'gemini',
    model: produced.model ?? stored?.model ?? 'unknown',
  };
}

type Decision = RelevanceOutcome['data']['decision'];
type EmailWithResult = Prisma.EmailGetPayload<{ include: { aiProcessingResult: true } }>;

/** What every step of one email's processing needs. */
interface EmailRun {
  userId: string;
  email: EmailWithResult;
  options: { signal?: AbortSignal };
  /** Resolved once, and only when a step really calls the provider. */
  access: () => Promise<AIAccess>;
}

export async function processEmail(
  userId: string,
  emailId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const email = await prisma.email.findUnique({
    where: { id: emailId, userId },
    include: { aiProcessingResult: true },
  });
  if (!email) throw new TerminalAIError('Email unavailable');
  const result = email.aiProcessingResult;
  // Adopt existing completed work; neither a deployment nor a sync is reprocessing consent.
  const extracted = ['extraction/v2', 'extraction/v3'].includes(result?.contractVersion ?? '');
  if (result && (result.processingStatus === 'COMPLETED' || extracted)) {
    await finishEmail(userId, emailId, result.relevanceDecision);
    return;
  }
  const plan = await classificationPlan(email);
  let resolved: Promise<AIAccess> | undefined;
  const access = () => (resolved ??= resolveAIAccess(userId));
  const run: EmailRun = { userId, email, options, access };

  const decision = plan.batchDecision ?? (await classify(run, plan));
  if (decision !== 'IRRELEVANT') await extract(run);
  await finishEmail(userId, emailId, decision);
}

/** How this email's relevance is checked, read from the classification rows it already has. */
async function classificationPlan(email: EmailWithResult) {
  const result = email.aiProcessingResult;
  const ledger = await prisma.aIOperation.findMany({
    where: { emailId: email.id, operation: 'classification' },
    select: { version: true },
  });
  const hasBatchRow = ledger.some((row) => RELEVANCE_BATCH_VERSIONS.includes(row.version));
  const perEmailVersion = ledger.find((row) =>
    CLASSIFICATION_VERSIONS.includes(row.version),
  )?.version;
  // New mails only: an email that started on the legacy rules finishes on them.
  const strictRules = !ledger.some((row) =>
    (Object.values(LEGACY_CONTRACT_VERSIONS) as string[]).includes(row.version),
  );
  const useBatch = hasBatchRow || (triageBatchEnabled() && !perEmailVersion);

  const operations = await prisma.aIOperation.count({ where: { emailId: email.id } });
  if (result && !operations)
    throw new TerminalAIError('Legacy partial AI result requires reconciliation');

  // The batched check already decided this email; only extraction is left.
  const batchDecision =
    result && hasBatchRow && RELEVANCE_BATCH_VERSIONS.includes(result.contractVersion)
      ? result.relevanceDecision
      : null;
  return { batchDecision, useBatch, perEmailVersion, strictRules };
}
type ClassificationPlan = Awaited<ReturnType<typeof classificationPlan>>;

/** Decides relevance for one email and saves the decision. */
async function classify(run: EmailRun, plan: ClassificationPlan): Promise<Decision> {
  const { email } = run;
  // Metadata/body are transient and fetched before reserving a provider call.
  const gmail = await fetchMessageMetadata(run.userId, email.gmailMessageId, run.options);
  const labels = gmail.labelIds ?? [];
  const deterministic = autoIrrelevant(labels, email.sender, plan.strictRules);
  const threshold = relevanceThreshold();
  const input = {
    sender: email.sender?.slice(0, LIMITS.sender) ?? null,
    subject: email.subject?.slice(0, LIMITS.subject) ?? null,
    labels: labels.slice(0, LIMITS.labels),
    snippet: gmail.snippet?.slice(0, LIMITS.snippet) ?? null,
  };
  const relevance = deterministic ? DETERMINISTIC_IRRELEVANT : await askRelevance(run, plan, input);

  const decision = relevance.data.confidence < threshold ? 'UNCERTAIN' : relevance.data.decision;
  const data = {
    // Provenance comes from the operation that produced the result, so a result reused after a
    // provider switch keeps its own provider and model.
    ...provenance(relevance, email.aiProcessingResult),
    contractVersion: relevance.version,
    relevanceDecision: decision,
    confidence: relevance.data.confidence,
    category: relevance.data.category ?? null,
    deterministic,
    processingStatus: decision === 'IRRELEVANT' ? ('COMPLETED' as const) : ('PROCESSING' as const),
    errorCategory: null,
    errorDetails: null,
  };
  await prisma.aIProcessingResult.upsert({
    where: { emailId: email.id },
    create: { emailId: email.id, ...data },
    update: data,
  });
  return decision;
}

const DETERMINISTIC_IRRELEVANT: RelevanceOutcome = {
  data: { decision: 'IRRELEVANT', confidence: 1, category: null },
  provider: 'deterministic',
  model: 'none',
  version: 'deterministic/v1',
};

/** Asks the provider, on the path (batched or per-email) this email already started on. */
async function askRelevance(
  run: EmailRun,
  plan: ClassificationPlan,
  input: RelevanceClassifierInput,
): Promise<RelevanceOutcome> {
  const { userId, email } = run;
  if (plan.useBatch) {
    const one = await classifyOne(userId, email.id, input, { signal: run.options.signal });
    return {
      data: {
        decision: one.decision,
        confidence: one.confidence,
        category: (one.category ?? null) as EmailCategory | null,
      },
      provider: one.provider,
      model: one.model,
      version: one.version,
    };
  }
  const contract = classificationContractFor(
    plan.perEmailVersion ?? AI_CONTRACT_VERSIONS.CLASSIFICATION,
  );
  const r = await runOperation({
    userId,
    emailId: email.id,
    operation: 'classification',
    contract,
    access: run.access,
    call: (ai) => ai.classifier.classifyRelevance(input, contract.version),
  });
  return {
    data: {
      decision: r.data.decision,
      confidence: r.data.confidence,
      category: r.data.category ?? null,
    },
    provider: r.provider,
    model: r.model,
    version: contract.version,
  };
}

/** Reads the job details from the email body and saves them on the result. */
async function extract(run: EmailRun) {
  const { userId, email } = run;
  const emailId = email.id;
  const body = await fetchMessageBody(userId, email.gmailMessageId, run.options);
  const contract = await selectExtractionContract(userId, emailId);
  const extraction = await runOperation({
    userId,
    emailId,
    operation: 'extraction',
    contract,
    access: run.access,
    call: async (ai) => {
      const bounded = body.slice(0, EXTRACTION_BODY_LIMIT);
      const output = await ai.analyzer.extractJobData(bounded, {
        version: contract.version,
        receivedAt: email.receivedAt?.toISOString() ?? null,
      });
      if (contract.version === 'extraction/v3') {
        const parsed = JobExtractionV3Schema.parse(output.data);
        return {
          ...output,
          data: {
            ...parsed,
            scheduleCandidates: verifiedCandidates(parsed.scheduleCandidates, bounded),
          },
        };
      }
      return output;
    },
  });
  await prisma.aIProcessingResult.update({
    where: { emailId },
    data: {
      ...JobExtractionSchema.parse(extraction.data),
      ...(contract.version === 'extraction/v3'
        ? {
            scheduleCandidates: candidateEnvelope(
              JobExtractionV3Schema.parse(extraction.data).scheduleCandidates,
            ),
          }
        : {}),
      ...provenance(extraction, email.aiProcessingResult),
      contractVersion: contract.version,
      processingStatus: 'COMPLETED',
    },
  });
}

async function finishEmail(userId: string, emailId: string, decision: string | null) {
  if (!decision) throw new TerminalAIError('Completed result has no relevance decision');
  if (decision !== 'IRRELEVANT') await matchEmailToApplication(emailId);
  await prisma.email.updateMany({
    where: { id: emailId, userId },
    data: {
      processingState: 'COMPLETED',
      relevanceState: decision === 'IRRELEVANT' ? 'IRRELEVANT' : 'RELEVANT',
      processingErrorCategory: null,
      processingErrorDetails: null,
      processingErrorStage: null,
      processingRetryable: null,
      processingFailedAt: null,
    },
  });
}

/** Pin the version with the first durable extraction row, under the email lock. Existing held,
 * pending or completed rows win over enable/disable changes and concurrent workers. */
export async function selectExtractionContract(
  userId: string,
  emailId: string,
): Promise<AIContract<JobExtractionResult>> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM emails WHERE id = ${emailId}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`;
    if (!(await tx.email.findFirst({ where: { id: emailId, userId } })))
      throw new TerminalAIError('Email unavailable');
    const rows = await tx.aIOperation.findMany({ where: { emailId, operation: 'extraction' } });
    if (
      rows.length > 1 ||
      rows.some((row) => !['extraction/v2', 'extraction/v3'].includes(row.version))
    )
      throw new TerminalAIError('Extraction version requires reconciliation');
    const version =
      rows[0]?.version ?? (agendaExtractionV3Enabled() ? 'extraction/v3' : 'extraction/v2');
    if (!rows.length)
      await tx.aIOperation.create({ data: { emailId, operation: 'extraction', version } });
    return version === 'extraction/v3' ? EXTRACTION_V3_CONTRACT : EXTRACTION_CONTRACT;
  });
}
