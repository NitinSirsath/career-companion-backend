import { z } from 'zod';

export const AI_CONTRACT_VERSIONS = {
  CLASSIFICATION: 'classification/v1',
  EXTRACTION: 'extraction/v1',
} as const;

export const EmailRelevanceSchema = z.object({
  isJobSearchRelated: z.boolean().describe('True if the email is related to the users job search (e.g. application confirmation, interview invite, rejection, recruiter outreach).'),
  reasoning: z.string().describe('A brief explanation of why the email was classified as relevant or not relevant.'),
});

export type EmailRelevanceResult = z.infer<typeof EmailRelevanceSchema>;

export const JobExtractionSchema = z.object({
  companyName: z.string().describe('The name of the company the application is for.'),
  jobTitle: z.string().optional().describe('The job title applied for, if found.'),
  status: z.enum(['APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'UNKNOWN']).describe('The inferred status of the application based on the email content.'),
  reasoning: z.string().describe('Explanation of how the data was extracted and status inferred.'),
});

export type JobExtractionResult = z.infer<typeof JobExtractionSchema>;

export interface RelevanceClassifier {
  classifyRelevance(emailBody: string): Promise<{ version: string; data: EmailRelevanceResult }>;
}

export interface EmailAnalyzer {
  extractJobData(emailBody: string): Promise<{ version: string; data: JobExtractionResult }>;
}
