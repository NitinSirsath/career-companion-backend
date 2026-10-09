import { candidateEnvelope, verifiedCandidates } from './temporal';
import type { EmailCategory } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { GmailFetcherService } from '../gmailFetcher';
import { MatcherService } from '../matcher';
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
} from './contracts';
import { TerminalAIError } from './errors';
import { runOperation } from './operations';
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

export class EmailAIPipeline {
  static async processEmail(
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
    const batched =
      !!result &&
      RELEVANCE_BATCH_VERSIONS.includes(result.contractVersion) &&
      result.relevanceDecision !== null;
    if (result && (result.processingStatus === 'COMPLETED' || extracted)) {
      await this.finish(userId, emailId, result.relevanceDecision);
      return;
    }
    const classificationLedger = await prisma.aIOperation.findMany({
      where: { emailId, operation: 'classification' },
      select: { version: true },
    });
    const hasBatchClassification = classificationLedger.some((row) =>
      RELEVANCE_BATCH_VERSIONS.includes(row.version),
    );
    const perEmailRow = classificationLedger.find((row) =>
      CLASSIFICATION_VERSIONS.includes(row.version),
    );
    const hasPerEmailClassification = !!perEmailRow;
    // New mails only: an email that started on the legacy rules finishes on them.
    const strictRules = !classificationLedger.some((row) =>
      (Object.values(LEGACY_CONTRACT_VERSIONS) as string[]).includes(row.version),
    );
    const useBatch = hasBatchClassification || (triageBatchEnabled() && !hasPerEmailClassification);
    const batchClassified = batched && hasBatchClassification;

    const operations = await prisma.aIOperation.count({ where: { emailId } });
    if (result && !operations)
      throw new TerminalAIError('Legacy partial AI result requires reconciliation');

    let resolved: Promise<AIAccess> | undefined;
    const access = () => (resolved ??= resolveAIAccess(userId));
    let decision: 'RELEVANT' | 'IRRELEVANT' | 'UNCERTAIN';

    let relevance: RelevanceOutcome;
    if (batchClassified) {
      decision = result!.relevanceDecision!;
    } else {
      // Metadata/body are transient and fetched before reserving a provider call.
      const gmail = await GmailFetcherService.fetchMessageMetadata(
        userId,
        email.gmailMessageId,
        options,
      );
      const labels = gmail.labelIds ?? [];
      const deterministic = autoIrrelevant(labels, email.sender, strictRules);
      const threshold = relevanceThreshold();
      const boundedInput = {
        sender: email.sender?.slice(0, LIMITS.sender) ?? null,
        subject: email.subject?.slice(0, LIMITS.subject) ?? null,
        labels: labels.slice(0, LIMITS.labels),
        snippet: gmail.snippet?.slice(0, LIMITS.snippet) ?? null,
      };

      if (deterministic) {
        relevance = {
          data: { decision: 'IRRELEVANT', confidence: 1, category: null },
          provider: 'deterministic',
          model: 'none',
          version: 'deterministic/v1',
        };
      } else if (useBatch) {
        const one = await classifyOne(userId, emailId, boundedInput, {
          signal: options.signal,
        });
        relevance = {
          data: {
            decision: one.decision,
            confidence: one.confidence,
            category: (one.category ?? null) as EmailCategory | null,
          },
          provider: one.provider,
          model: one.model,
          version: one.version,
        };
      } else {
        const contract = classificationContractFor(
          perEmailRow?.version ?? AI_CONTRACT_VERSIONS.CLASSIFICATION,
        );
        const r = await runOperation({
          userId,
          emailId,
          operation: 'classification',
          contract,
          access,
          call: (ai) => ai.classifier.classifyRelevance(boundedInput, contract.version),
        });
        relevance = {
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

      decision = relevance.data.confidence < threshold ? 'UNCERTAIN' : relevance.data.decision;
      const data = {
        // Provenance comes from the operation that produced the result, so a result reused after a
        // provider switch keeps its own provider and model.
        ...provenance(relevance, result),
        contractVersion: relevance.version,
        relevanceDecision: decision,
        confidence: relevance.data.confidence,
        category: relevance.data.category ?? null,
        deterministic,
        processingStatus:
          decision === 'IRRELEVANT' ? ('COMPLETED' as const) : ('PROCESSING' as const),
        errorCategory: null,
        errorDetails: null,
      };
      await prisma.aIProcessingResult.upsert({
        where: { emailId },
        create: { emailId, ...data },
        update: data,
      });
    }
    if (decision !== 'IRRELEVANT') {
      const body = await GmailFetcherService.fetchMessageBody(
        userId,
        email.gmailMessageId,
        options,
      );
      const contract = await selectExtractionContract(userId, emailId);
      const extraction = await runOperation({
        userId,
        emailId,
        operation: 'extraction',
        contract,
        access,
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
          ...provenance(extraction, result),
          contractVersion: contract.version,
          processingStatus: 'COMPLETED',
        },
      });
    }
    await this.finish(userId, emailId, decision);
  }

  private static async finish(userId: string, emailId: string, decision: string | null) {
    if (!decision) throw new TerminalAIError('Completed result has no relevance decision');
    if (decision !== 'IRRELEVANT') await MatcherService.matchEmailToApplication(emailId);
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
      rows[0]?.version ??
      (process.env.AGENDA_EXTRACTION_V3_ENABLED === 'true' ? 'extraction/v3' : 'extraction/v2');
    if (!rows.length)
      await tx.aIOperation.create({ data: { emailId, operation: 'extraction', version } });
    return version === 'extraction/v3' ? EXTRACTION_V3_CONTRACT : EXTRACTION_CONTRACT;
  });
}
