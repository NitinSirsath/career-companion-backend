import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiProvider } from '../services/ai/gemini/GeminiProvider';
import { SchemaValidationFailure } from '../services/ai/errors';
import { AI_CONTRACT_VERSIONS } from '../services/ai/contracts';
import { EmailAIPipeline } from '../services/ai/pipeline';
import { GmailFetcherService } from '../services/gmailFetcher';
import { prisma } from '../db/prisma';
import { AIRelevanceDecision } from '@prisma/client';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    GoogleGenAI: vi.fn().mockImplementation(function() {
      return {
        models: {
          generateContent: mockGenerateContent,
        }
      };
    })
  };
});

vi.mock('../services/gmailFetcher', () => ({
  GmailFetcherService: {
    fetchMessageMetadata: vi.fn(),
    fetchMessageBody: vi.fn(),
  }
}));

vi.mock('../db/prisma', () => ({
  prisma: {
    email: {
      findUnique: vi.fn(),
    },
    aIProcessingResult: {
      upsert: vi.fn(),
      update: vi.fn(),
    }
  }
}));

describe('AI Pipeline & Provider (COM-27)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test_key';
    process.env.GEMINI_RELEVANCE_MODEL = 'test-relevance-model';
    process.env.GEMINI_EXTRACTION_MODEL = 'test-extraction-model';
    process.env.RELEVANCE_CONFIDENCE_THRESHOLD = '0.7';
    // reset GeminiProvider singleton instance
    // @ts-expect-error reset instance
    GeminiProvider.instance = undefined;
  });

  describe('GeminiProvider Contracts', () => {
    it('uses configured models', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ decision: 'RELEVANT', confidence: 0.9, reasoning: 'test' })
      });
      
      const provider = GeminiProvider.getInstance();
      await provider.classifyRelevance({ sender: 'a@b.com', subject: 'test' });
      
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-relevance-model'
        })
      );
    });

    it('accepts valid structured response', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ decision: 'RELEVANT', confidence: 0.8, reasoning: 'test reasoning', category: 'RECRUITER' })
      });
      
      const provider = GeminiProvider.getInstance();
      const result = await provider.classifyRelevance({ sender: 'a' });
      
      expect(result.version).toBe(AI_CONTRACT_VERSIONS.CLASSIFICATION);
      expect(result.data.decision).toBe('RELEVANT');
      expect(result.data.category).toBe('RECRUITER');
    });

    it('rejects schema-invalid response with SchemaValidationFailure', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ decision: 'NOT_A_DECISION' })
      });
      
      const provider = GeminiProvider.getInstance();
      await expect(provider.classifyRelevance({ sender: 'test' })).rejects.toThrowError(SchemaValidationFailure);
    });
    
    it('extracts missing fields as null', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ 
          companyName: 'TestCo',
          jobTitle: null,
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
          actionRequired: null,
          requestedAction: null,
          actionDeadline: null,
          followUpRequired: null,
          followUpDate: null,
          extractionConfidence: 0.9,
          provenance: 'body'
        })
      });
      
      const provider = GeminiProvider.getInstance();
      const result = await provider.extractJobData('test body');
      
      expect(result.data.companyName).toBe('TestCo');
      expect(result.data.jobTitle).toBeNull();
    });
  });

  describe('EmailAIPipeline', () => {
    const mockEmail = {
      id: 'e1',
      userId: 'u1',
      gmailMessageId: 'g1',
      sender: 'hr@company.com',
      subject: 'Interview',
    };

    beforeEach(() => {
      vi.mocked(prisma.email.findUnique).mockResolvedValue(mockEmail as never);
      vi.mocked(prisma.aIProcessingResult.upsert).mockResolvedValue({} as never);
      vi.mocked(prisma.aIProcessingResult.update).mockResolvedValue({} as never);
    });

    it('stops at deterministic pre-filter for promotions', async () => {
      vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
        labelIds: ['CATEGORY_PROMOTIONS'],
        snippet: 'buy now',
      });

      await EmailAIPipeline.processEmail('u1', 'e1');

      // Verify relevance classifier wasn't called
      expect(mockGenerateContent).not.toHaveBeenCalled();

      // Verify db update
      expect(prisma.aIProcessingResult.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            processingStatus: 'COMPLETED',
            relevanceDecision: AIRelevanceDecision.IRRELEVANT,
            deterministic: true
          })
        })
      );
    });

    it('stops if relevance classifier says IRRELEVANT with high confidence', async () => {
      vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
        labelIds: ['INBOX'],
        snippet: 'just catching up',
      });

      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ decision: 'IRRELEVANT', confidence: 0.9, reasoning: 'personal email' })
      });

      await EmailAIPipeline.processEmail('u1', 'e1');

      // Verify body fetch wasn't called
      expect(GmailFetcherService.fetchMessageBody).not.toHaveBeenCalled();

      expect(prisma.aIProcessingResult.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            relevanceDecision: AIRelevanceDecision.IRRELEVANT,
            confidence: 0.9,
            deterministic: false
          })
        })
      );
    });

    it('fetches body and extracts if RELEVANT with high confidence', async () => {
      vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
        labelIds: ['INBOX'],
        snippet: 'interview tomorrow',
      });
      vi.mocked(GmailFetcherService.fetchMessageBody).mockResolvedValue('full email body here');

      // First call: Classification
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ decision: 'RELEVANT', confidence: 0.8, reasoning: 'interview', category: 'INTERVIEW' })
      });
      
      // Second call: Extraction
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          companyName: 'TechCorp',
          jobTitle: null, recruiterName: null, recruiterEmail: null,
          interviewStage: 'First Round', interviewType: null, interviewDate: null,
          interviewTime: null, assessmentInfo: null, assessmentDeadline: null,
          offerInfo: null, rejectionInfo: null, actionRequired: null,
          requestedAction: null, actionDeadline: null, followUpRequired: null,
          followUpDate: null, extractionConfidence: 0.9, provenance: 'body'
        })
      });

      await EmailAIPipeline.processEmail('u1', 'e1');

      expect(GmailFetcherService.fetchMessageBody).toHaveBeenCalled();
      
      // Verify final extraction save
      expect(prisma.aIProcessingResult.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            processingStatus: 'COMPLETED',
            companyName: 'TechCorp',
            interviewStage: 'First Round'
          })
        })
      );
    });

    it('treats RELEVANT as UNCERTAIN and extracts if confidence below threshold', async () => {
      vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
        labelIds: ['INBOX'],
        snippet: 'maybe an interview',
      });
      vi.mocked(GmailFetcherService.fetchMessageBody).mockResolvedValue('full email body here');

      // First call: Classification with low confidence
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ decision: 'RELEVANT', confidence: 0.5, reasoning: 'unsure', category: 'INTERVIEW' })
      });
      
      // Second call: Extraction should happen
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          companyName: 'TechCorp', jobTitle: null, recruiterName: null, recruiterEmail: null,
          interviewStage: null, interviewType: null, interviewDate: null, interviewTime: null,
          assessmentInfo: null, assessmentDeadline: null, offerInfo: null, rejectionInfo: null,
          actionRequired: null, requestedAction: null, actionDeadline: null, followUpRequired: null,
          followUpDate: null, extractionConfidence: 0.9, provenance: 'body'
        })
      });

      await EmailAIPipeline.processEmail('u1', 'e1');

      expect(GmailFetcherService.fetchMessageBody).toHaveBeenCalled();
      
      expect(prisma.aIProcessingResult.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            relevanceDecision: AIRelevanceDecision.UNCERTAIN
          })
        })
      );
    });
    
    it('sets FAILED status on AI provider error', async () => {
      vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
        labelIds: ['INBOX'],
        snippet: 'snippet',
      });
      
      mockGenerateContent.mockRejectedValueOnce(new Error('API rate limit 429'));
      
      await expect(EmailAIPipeline.processEmail('u1', 'e1')).rejects.toThrow();
      
      expect(prisma.aIProcessingResult.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            processingStatus: 'FAILED',
            errorCategory: 'RetryableAIError',
          })
        })
      );
    });
  });
});

describe('Security & Privacy', () => {
  it('does not log sensitive email content or api keys during errors', async () => {
    vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX'],
      snippet: 'SECRET_EMAIL_BODY_123',
    });
    
    mockGenerateContent.mockRejectedValue(new Error('API failed'));
    
    try {
      await EmailAIPipeline.processEmail('u1', 'e1');
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const errorString = err instanceof Error ? err.message + ' ' + ((err.cause as Error)?.message || '') : String(err);
      expect(errorString).not.toContain('SECRET_EMAIL_BODY_123');
      expect(errorString).not.toContain('test_key');
    }
  });
});
