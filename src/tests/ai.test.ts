import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiProvider } from '../services/ai/gemini/GeminiProvider';
import { TerminalAIError, RetryableAIError, SchemaValidationFailure } from '../services/ai/errors';
import { AI_CONTRACT_VERSIONS } from '../services/ai/contracts';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function() {
    return {
      models: {
        generateContent: mockGenerateContent,
      }
    };
  })
}));

describe('AI Provider Abstraction (COM-26)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test_key';
    process.env.GEMINI_RELEVANCE_MODEL = 'test-relevance-model';
    process.env.GEMINI_EXTRACTION_MODEL = 'test-extraction-model';
  });

  describe('Configuration', () => {
    it('fails safely when GEMINI_API_KEY is missing', () => {
      delete process.env.GEMINI_API_KEY;
      expect(() => new GeminiProvider()).toThrowError(TerminalAIError);
      expect(() => new GeminiProvider()).toThrow('GEMINI_API_KEY is not configured');
    });

    it('uses configured models', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ isJobSearchRelated: true, reasoning: 'test' })
      });
      
      const provider = new GeminiProvider();
      await provider.classifyRelevance('test body');
      
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-relevance-model'
        })
      );
    });
  });

  describe('Structured Output & Schema Validation', () => {
    it('accepts valid structured response', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ isJobSearchRelated: true, reasoning: 'test reasoning' })
      });
      
      const provider = new GeminiProvider();
      const result = await provider.classifyRelevance('test body');
      
      expect(result.version).toBe(AI_CONTRACT_VERSIONS.CLASSIFICATION);
      expect(result.data.isJobSearchRelated).toBe(true);
    });

    it('rejects malformed response (invalid JSON)', async () => {
      mockGenerateContent.mockResolvedValue({
        text: 'not json'
      });
      
      const provider = new GeminiProvider();
      await expect(provider.classifyRelevance('test body')).rejects.toThrowError(TerminalAIError);
      await expect(provider.classifyRelevance('test body')).rejects.toThrow('invalid JSON');
    });

    it('rejects schema-invalid response with SchemaValidationFailure', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ isJobSearchRelated: 'not-a-boolean' })
      });
      
      const provider = new GeminiProvider();
      await expect(provider.classifyRelevance('test body')).rejects.toThrowError(SchemaValidationFailure);
    });
  });

  describe('Errors Classification', () => {
    it('classifies rate limits and timeouts as retryable', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit 429 exceeded'));
      
      const provider = new GeminiProvider();
      await expect(provider.classifyRelevance('test body')).rejects.toThrowError(RetryableAIError);
    });

    it('classifies unknown errors as terminal', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Unknown configuration failure'));
      
      const provider = new GeminiProvider();
      await expect(provider.classifyRelevance('test body')).rejects.toThrowError(TerminalAIError);
    });
  });

  describe('Security & Privacy', () => {
    it('does not log sensitive email content or api keys during errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API failed'));
      
      const provider = new GeminiProvider();
      const sensitiveBody = 'SECRET_EMAIL_BODY_123';
      
      try {
        await provider.classifyRelevance(sensitiveBody);
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const errorString = err instanceof Error ? err.message + ' ' + ((err.cause as Error)?.message || '') : String(err);
        expect(errorString).not.toContain(sensitiveBody);
        expect(errorString).not.toContain('test_key');
      }
    });
  });
});
