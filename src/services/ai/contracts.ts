import { z } from 'zod';
import { EmailCategory } from '@prisma/client';

export const AI_CONTRACT_VERSIONS = {
  CLASSIFICATION: 'classification/v2',
  EXTRACTION: 'extraction/v2',
} as const;

export const EmailRelevanceSchema = z.object({
  decision: z.enum(['RELEVANT', 'IRRELEVANT', 'UNCERTAIN']).describe('Classification of the email relevance for job searching.'),
  category: z.nativeEnum(EmailCategory).optional().describe('The category of the email if it is relevant.'),
  confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for this classification.'),
  reasoning: z.string().describe('A brief explanation of why the email was classified as relevant or not relevant.'),
});

export type EmailRelevanceResult = z.infer<typeof EmailRelevanceSchema>;

export const JobExtractionSchema = z.object({
  companyName: z.string().nullable().describe('The name of the company the application is for.'),
  jobTitle: z.string().nullable().describe('The job title applied for, if found.'),
  recruiterName: z.string().nullable().describe('Recruiter or contact name if explicitly present.'),
  recruiterEmail: z.string().nullable().describe('Recruiter or contact email if explicitly present.'),
  interviewStage: z.string().nullable().describe('Interview stage, e.g., First Round, Onsite, Final.'),
  interviewType: z.string().nullable().describe('Interview type, e.g., Phone, Video, In-person.'),
  interviewDate: z.string().nullable().describe('Interview date if available.'),
  interviewTime: z.string().nullable().describe('Interview time if available.'),
  assessmentInfo: z.string().nullable().describe('Information about any required assessment or take-home assignment.'),
  assessmentDeadline: z.string().nullable().describe('Deadline for the assessment if specified.'),
  offerInfo: z.string().nullable().describe('Information regarding a job offer.'),
  rejectionInfo: z.string().nullable().describe('Information regarding a rejection.'),
  actionRequired: z.boolean().nullable().describe('Whether user action is required based on the email.'),
  requestedAction: z.string().nullable().describe('The specific action requested from the user.'),
  actionDeadline: z.string().nullable().describe('The deadline for the requested action.'),
  followUpRequired: z.boolean().nullable().describe('Whether a follow-up is required or suggested.'),
  followUpDate: z.string().nullable().describe('Suggested follow-up date.'),
  extractionConfidence: z.number().min(0).max(1).nullable().describe('Confidence score between 0 and 1 for the extraction.'),
  provenance: z.string().nullable().describe('Source indication or reasoning for extracted fields.'),
});

export type JobExtractionResult = z.infer<typeof JobExtractionSchema>;

export interface RelevanceClassifierInput {
  sender?: string | null;
  subject?: string | null;
  labels?: string[];
  snippet?: string | null;
}

export interface RelevanceClassifier {
  classifyRelevance(input: RelevanceClassifierInput): Promise<{ version: string; data: EmailRelevanceResult }>;
}

export interface EmailAnalyzer {
  extractJobData(emailBody: string): Promise<{ version: string; data: JobExtractionResult }>;
}
