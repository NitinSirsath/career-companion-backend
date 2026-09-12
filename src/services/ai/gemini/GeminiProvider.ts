import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { 
  RelevanceClassifier, 
  EmailAnalyzer,
  RelevanceClassifierInput,
  EmailRelevanceSchema, 
  EmailRelevanceResult,
  JobExtractionSchema,
  JobExtractionResult,
  AI_CONTRACT_VERSIONS
} from '../contracts';
import { 
  RetryableAIError, 
  TerminalAIError, 
  SchemaValidationFailure 
} from '../errors';

const PROMPTS = {
  [AI_CONTRACT_VERSIONS.CLASSIFICATION]: `
You are an AI assistant that determines if an email is related to a user's job search.
Analyze the provided email metadata (sender, subject, labels, snippet).
Classify if it is RELEVANT, IRRELEVANT, or UNCERTAIN.
Provide a confidence score (0 to 1).
If RELEVANT, categorize it into one of: RECRUITER, INTERVIEW, ASSESSMENT, OFFER, REJECTION, FOLLOW_UP, NEWSLETTER, SPAM.
Return your decision as a structured JSON object according to the schema.
  `.trim(),

  [AI_CONTRACT_VERSIONS.EXTRACTION]: `
You are an AI assistant that extracts structured job application data from an email body.
Extract all requested fields. If information is missing, use null.
Do not invent or assume information.
Provide an extractionConfidence score (0 to 1).
Return your findings as a structured JSON object according to the schema.
  `.trim()
};

export class GeminiProvider implements RelevanceClassifier, EmailAnalyzer {
  private client: GoogleGenAI;
  private relevanceModel: string;
  private extractionModel: string;
  private static instance: GeminiProvider;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new TerminalAIError('GEMINI_API_KEY is not configured');
    }

    this.client = new GoogleGenAI({ apiKey });
    this.relevanceModel = process.env.GEMINI_RELEVANCE_MODEL || 'gemini-2.5-flash-lite';
    this.extractionModel = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-flash';
  }
  
  static getInstance(): GeminiProvider {
    if (!this.instance) {
      this.instance = new GeminiProvider();
    }
    return this.instance;
  }

  private mapError(err: unknown): never {
    if (err instanceof TerminalAIError || err instanceof RetryableAIError) {
      throw err;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    
    const retryableKeywords = ['429', '503', '504', 'timeout', 'quota', 'rate limit'];
    const isRetryable = retryableKeywords.some(kw => errorMsg.toLowerCase().includes(kw));

    if (isRetryable) {
      throw new RetryableAIError('Transient AI provider error', err);
    }
    
    throw new TerminalAIError(`Terminal AI provider error: ${errorMsg}`, err);
  }

  private async generateStructuredOutput<T>(
    model: string, 
    systemInstruction: string, 
    input: string, 
    schema: z.ZodSchema<T>
  ): Promise<T> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonSchema = zodToJsonSchema(schema as any, { target: 'jsonSchema7' }) as any;
      delete jsonSchema.$schema;

      const response = await this.client.models.generateContent({
        model,
        contents: input,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: jsonSchema,
          temperature: 0.1,
        }
      });

      const text = response.text;
      if (!text) {
        throw new TerminalAIError('AI provider returned empty response');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        throw new TerminalAIError('AI provider returned invalid JSON', parseErr);
      }

      const validationResult = schema.safeParse(parsed);
      if (!validationResult.success) {
        throw new SchemaValidationFailure(
          'AI provider returned malformed structured data',
          validationResult.error.format()
        );
      }

      return validationResult.data;
    } catch (err) {
      this.mapError(err);
    }
  }

  async classifyRelevance(input: RelevanceClassifierInput): Promise<{ version: string; data: EmailRelevanceResult }> {
    const version = AI_CONTRACT_VERSIONS.CLASSIFICATION;
    const content = JSON.stringify(input);
    const data = await this.generateStructuredOutput(
      this.relevanceModel,
      PROMPTS[version],
      content,
      EmailRelevanceSchema
    );

    return { version, data };
  }

  async extractJobData(emailBody: string): Promise<{ version: string; data: JobExtractionResult }> {
    const version = AI_CONTRACT_VERSIONS.EXTRACTION;
    const data = await this.generateStructuredOutput(
      this.extractionModel,
      PROMPTS[version],
      emailBody,
      JobExtractionSchema
    );

    return { version, data };
  }
  
  getProviderName(): string {
    return 'gemini';
  }
  
  getRelevanceModel(): string {
    return this.relevanceModel;
  }
  
  getExtractionModel(): string {
    return this.extractionModel;
  }
}
