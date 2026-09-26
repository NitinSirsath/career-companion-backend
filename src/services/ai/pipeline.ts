import { prisma } from '../../db/prisma';
import { GeminiProvider } from './gemini/GeminiProvider';
import { GmailFetcherService } from '../gmailFetcher';
import { MatcherService } from '../matcher';
import { AI_CONTRACT_VERSIONS, EmailRelevanceSchema, JobExtractionSchema } from './contracts';
import { TerminalAIError } from './errors';
import { runOperation } from './operations';

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
    const provider = deterministic ? null : GeminiProvider.getInstance();
    const relevance = deterministic
      ? { decision: 'IRRELEVANT' as const, confidence: 1, category: undefined }
      : await runOperation(
          userId,
          emailId,
          'classification',
          AI_CONTRACT_VERSIONS.CLASSIFICATION,
          EmailRelevanceSchema,
          async () =>
            (
              await provider!.classifyRelevance({
                sender: email.sender?.slice(0, 512),
                subject: email.subject?.slice(0, 1000),
                labels: labels.slice(0, 30),
                snippet: gmail.snippet?.slice(0, 1000),
              })
            ).data,
        );
    const decision = relevance.confidence < threshold ? 'UNCERTAIN' : relevance.decision;
    const data = {
      provider: provider?.getProviderName() ?? 'deterministic',
      model: provider?.getRelevanceModel() ?? 'none',
      contractVersion: deterministic ? 'deterministic/v1' : AI_CONTRACT_VERSIONS.CLASSIFICATION,
      relevanceDecision: decision,
      confidence: relevance.confidence,
      category: relevance.category ?? null,
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
      const extraction = await runOperation(
        userId,
        emailId,
        'extraction',
        AI_CONTRACT_VERSIONS.EXTRACTION,
        JobExtractionSchema,
        async () => (await provider!.extractJobData(body.slice(0, 8000))).data,
      );
      await prisma.aIProcessingResult.update({
        where: { emailId },
        data: {
          ...extraction,
          model: provider!.getExtractionModel(),
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
      },
    });
  }
}
