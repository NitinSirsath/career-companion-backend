import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiProvider } from '../services/ai/gemini/GeminiProvider';
import { SchemaValidationFailure } from '../services/ai/errors';
import { AI_CONTRACT_VERSIONS } from '../services/ai/contracts';
import { GoogleGenAI } from '@google/genai';

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
    it('disables hidden SDK retries and bounds a provider request', async () => {
      mockGenerateContent.mockResolvedValue({ text: JSON.stringify({ decision: 'IRRELEVANT', confidence: 1, reasoning: 'other' }) });
      await GeminiProvider.getInstance().classifyRelevance({ subject: 'bounded' });
      expect(GoogleGenAI).toHaveBeenCalledWith(expect.objectContaining({
        httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } },
      }));
      expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }),
      }));
    });

    it.each([[429, true], [503, true], [401, false], [500, false], [undefined, false]])(
      'sanitizes status %s and only retries explicit transient rejections', async (status, retryable) => {
        mockGenerateContent.mockRejectedValue({ status, message: 'private email body and provider credential' });
        const error = await GeminiProvider.getInstance().classifyRelevance({ subject: 'private' }).catch(err => err);
        expect(error.isRetryable).toBe(retryable);
        expect(error.message).not.toContain('private');
        expect(error.cause).toBeUndefined();
      },
    );

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

});
