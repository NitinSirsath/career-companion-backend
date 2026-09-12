import { prisma } from '../../db/prisma';
import { GeminiProvider } from './gemini/GeminiProvider';
import { GmailFetcherService } from '../gmailFetcher';
import { AIProviderError } from './errors';
import { AIRelevanceDecision, EmailCategory } from '@prisma/client';

export class EmailAIPipeline {
  private static getConfidenceThreshold(): number {
    const val = process.env.RELEVANCE_CONFIDENCE_THRESHOLD;
    if (val !== undefined) {
      const parsed = parseFloat(val);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        return parsed;
      }
    }
    return 0.7;
  }

  static async processEmail(userId: string, emailId: string): Promise<void> {
    const email = await prisma.email.findUnique({
      where: { id: emailId, userId },
      include: { aiProcessingResult: true } // to check idempotency?
    });

    if (!email) {
      console.warn(`Terminal failure: Email ${emailId} not found for user ${userId}`);
      return;
    }

    // idempotency check: if already COMPLETED, maybe skip?
    // "Reprocessing the same Email must not create duplicate current AI results. Define what constitutes the current/latest AI result. Use appropriate database uniqueness/indexing."
    // Prisma schema has aiProcessingResult with unique emailId. We use upsert.

    const provider = GeminiProvider.getInstance();
    const threshold = this.getConfidenceThreshold();
    const providerName = provider.getProviderName();
    
    // update processing state
    await prisma.aIProcessingResult.upsert({
      where: { emailId },
      create: {
        emailId,
        provider: providerName,
        model: provider.getRelevanceModel(),
        contractVersion: 'started',
        processingStatus: 'PROCESSING'
      },
      update: {
        provider: providerName,
        model: provider.getRelevanceModel(),
        contractVersion: 'started',
        processingStatus: 'PROCESSING',
        errorCategory: null,
        errorDetails: null
      }
    });

    try {
      // 1. Fetch metadata & deterministic filter
      const gmailMsg = await GmailFetcherService.fetchMessageMetadata(userId, email.gmailMessageId);
      
      const labels = gmailMsg.labelIds || [];
      const isPromo = labels.includes('CATEGORY_PROMOTIONS');
      const isSocial = labels.includes('CATEGORY_SOCIAL');
      const isSpam = labels.includes('SPAM');

      if (isPromo || isSocial || isSpam) {
        // Deterministic IRRELEVANT
        await prisma.aIProcessingResult.update({
          where: { emailId },
          data: {
            processingStatus: 'COMPLETED',
            relevanceDecision: AIRelevanceDecision.IRRELEVANT,
            deterministic: true,
            contractVersion: 'deterministic/v1',
            category: isSpam ? EmailCategory.SPAM : undefined // or just none
          }
        });
        return;
      }

      // 2. Relevance Classifier
      const { version: relVersion, data: relData } = await provider.classifyRelevance({
        sender: email.sender,
        subject: email.subject,
        labels: gmailMsg.labelIds || undefined,
        snippet: gmailMsg.snippet
      });

      let finalDecision = relData.decision;
      if (relData.confidence < threshold) {
        finalDecision = AIRelevanceDecision.UNCERTAIN;
      }
      
      // Update with relevance result
      await prisma.aIProcessingResult.update({
        where: { emailId },
        data: {
          relevanceDecision: finalDecision,
          category: relData.category,
          confidence: relData.confidence,
          contractVersion: relVersion,
          deterministic: false
        }
      });

      if (finalDecision === AIRelevanceDecision.IRRELEVANT) {
        // Stop here
        await prisma.aIProcessingResult.update({
          where: { emailId },
          data: { processingStatus: 'COMPLETED' }
        });
        return;
      }

      // 3. Email Analyzer (for RELEVANT or UNCERTAIN)
      const body = await GmailFetcherService.fetchMessageBody(userId, email.gmailMessageId);
      // Ensure max 8,000 chars - fetchMessageBody might already do this, but let's enforce
      const boundedBody = body.substring(0, 8000);

      const { version: extVersion, data: extData } = await provider.extractJobData(boundedBody);

      // 4. Persist extraction
      await prisma.aIProcessingResult.update({
        where: { emailId },
        data: {
          model: provider.getExtractionModel(),
          contractVersion: extVersion,
          processingStatus: 'COMPLETED',
          
          companyName: extData.companyName,
          jobTitle: extData.jobTitle,
          recruiterName: extData.recruiterName,
          recruiterEmail: extData.recruiterEmail,
          interviewStage: extData.interviewStage,
          interviewType: extData.interviewType,
          interviewDate: extData.interviewDate,
          interviewTime: extData.interviewTime,
          assessmentInfo: extData.assessmentInfo,
          assessmentDeadline: extData.assessmentDeadline,
          offerInfo: extData.offerInfo,
          rejectionInfo: extData.rejectionInfo,
          actionRequired: extData.actionRequired,
          requestedAction: extData.requestedAction,
          actionDeadline: extData.actionDeadline,
          followUpRequired: extData.followUpRequired,
          followUpDate: extData.followUpDate,
          
          extractionConfidence: extData.extractionConfidence,
          provenance: extData.provenance,
        }
      });
      
    } catch (err) {
      
      const errorCategory = err instanceof AIProviderError ? err.name : 'UnknownError';
      const errorDetails = err instanceof Error ? err.message : String(err);
      
      await prisma.aIProcessingResult.update({
        where: { emailId },
        data: {
          processingStatus: 'FAILED',
          errorCategory,
          errorDetails
        }
      });
      
      throw err;
    }
  }
}
