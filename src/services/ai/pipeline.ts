import { prisma } from '../../db/prisma';
import { GmailFetcherService } from '../gmailFetcher';
import { MatcherService } from '../matcher';
import { AIAccess, resolveAIAccess } from './access';
import {
  AI_CONTRACT_VERSIONS,
  CLASSIFICATION_CONTRACT,
  CLASSIFICATION_INPUT_LIMITS as LIMITS,
  EXTRACTION_BODY_LIMIT,
  EXTRACTION_CONTRACT,
} from './contracts';
import { TerminalAIError } from './errors';
import { runOperation } from './operations';

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
  static async processEmail(userId: string, emailId: string): Promise<void> {
    const email = await prisma.email.findUnique({
      where: { id: emailId, userId },
      include: { aiProcessingResult: true },
    });
    if (!email) throw new TerminalAIError('Email unavailable');
    const result = email.aiProcessingResult;
    // Adopt existing completed work; neither a deployment nor a sync is reprocessing consent.
    const extracted = result?.contractVersion === AI_CONTRACT_VERSIONS.EXTRACTION;
    if (result && (result.processingStatus === 'COMPLETED' || extracted)) {
      await this.finish(userId, emailId, result.relevanceDecision);
      return;
    }
    const operations = await prisma.aIOperation.count({ where: { emailId } });
    if (result && !operations)
      throw new TerminalAIError('Legacy partial AI result requires reconciliation');

    // Metadata/body are transient and fetched before reserving a provider call.
    const gmail = await GmailFetcherService.fetchMessageMetadata(userId, email.gmailMessageId);
    const labels = gmail.labelIds ?? [];
    const deterministic = labels.some((label) =>
      ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM'].includes(label),
    );
    const threshold = Number(process.env.RELEVANCE_CONFIDENCE_THRESHOLD ?? 0.7);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      throw new TerminalAIError('Invalid relevance threshold');
    // The user's own AI access is resolved lazily, at most once per job, and only when a provider
    // call is about to be claimed: promotions and reused results need no key.
    let resolved: Promise<AIAccess> | undefined;
    const access = () => (resolved ??= resolveAIAccess(userId));
    const relevance = deterministic
      ? { data: { decision: 'IRRELEVANT' as const, confidence: 1, category: undefined }, provider: 'deterministic', model: 'none' }
      : await runOperation({
          userId,
          emailId,
          operation: 'classification',
          contract: CLASSIFICATION_CONTRACT,
          access,
          call: (ai) =>
            ai.classifier.classifyRelevance({
              sender: email.sender?.slice(0, LIMITS.sender),
              subject: email.subject?.slice(0, LIMITS.subject),
              labels: labels.slice(0, LIMITS.labels),
              snippet: gmail.snippet?.slice(0, LIMITS.snippet),
            }),
        });
    const decision = relevance.data.confidence < threshold ? 'UNCERTAIN' : relevance.data.decision;
    const data = {
      // Provenance comes from the operation that produced the result, so a result reused after a
      // provider switch keeps its own provider and model.
      ...provenance(relevance, result),
      contractVersion: deterministic ? 'deterministic/v1' : AI_CONTRACT_VERSIONS.CLASSIFICATION,
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
    if (decision !== 'IRRELEVANT') {
      const body = await GmailFetcherService.fetchMessageBody(userId, email.gmailMessageId);
      const extraction = await runOperation({
        userId,
        emailId,
        operation: 'extraction',
        contract: EXTRACTION_CONTRACT,
        access,
        call: (ai) => ai.analyzer.extractJobData(body.slice(0, EXTRACTION_BODY_LIMIT)),
      });
      await prisma.aIProcessingResult.update({
        where: { emailId },
        data: {
          ...extraction.data,
          ...provenance(extraction, result),
          contractVersion: AI_CONTRACT_VERSIONS.EXTRACTION,
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
