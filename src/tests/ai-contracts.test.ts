import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { Schema, Type } from '@google/genai';
import { z } from 'zod';
import {
  AI_CONTRACT_VERSIONS,
  AIContract,
  CLASSIFICATION_CONTRACT,
  EXTRACTION_CONTRACT,
} from '../services/ai/contracts';
import { geminiSchema } from '../services/ai/providers/gemini';

// Verbatim copies of the prompts and hand-written Gemini schemas that lived in
// services/ai/gemini/GeminiProvider.ts before the provider-neutral seam (BYO AI, AI-01).
const PROMPTS = {
  [AI_CONTRACT_VERSIONS.CLASSIFICATION]: `
You are an AI assistant that determines if an email is related to a user's job search.
Analyze the provided email metadata (sender, subject, labels, snippet).
Classify if it is RELEVANT, IRRELEVANT, or UNCERTAIN.
Provide a confidence score (0 to 1).
If RELEVANT, categorize it into one of: RECRUITER, INTERVIEW, ASSESSMENT, OFFER, REJECTION, FOLLOW_UP, NEWSLETTER, SPAM.

IMPORTANT DECISION RULES:
- LinkedIn, Glassdoor, and Indeed job alerts, sponsored job emails, and recruiter outreach MUST be classified as RELEVANT.
- OTPs (e.g. Upstox OTP), banking/security notifications, generic newsletters, and personal/transactional noise MUST be classified as IRRELEVANT.
- Do not classify something as IRRELEVANT merely because it is not an explicit job application. Job alerts and opportunities are RELEVANT.

Return your decision as a structured JSON object according to the schema.
  `.trim(),

  [AI_CONTRACT_VERSIONS.EXTRACTION]: `
You are an AI assistant that extracts structured job application data from an email body.
Extract all requested fields. If information is missing, use null.
Do not invent or assume information.
Provide an extractionConfidence score (0 to 1).
Return your findings as a structured JSON object according to the schema.
  `.trim(),
};

const nativeEmailRelevanceSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      description: 'Classification of the email relevance for job searching.',
      enum: ['RELEVANT', 'IRRELEVANT', 'UNCERTAIN'],
    },
    category: {
      type: Type.STRING,
      description: 'The category of the email if it is relevant.',
      enum: [
        'RECRUITER',
        'INTERVIEW',
        'ASSESSMENT',
        'OFFER',
        'REJECTION',
        'FOLLOW_UP',
        'NEWSLETTER',
        'SPAM',
      ],
    },
    confidence: {
      type: Type.NUMBER,
      description: 'Confidence score between 0 and 1 for this classification.',
    },
    reasoning: {
      type: Type.STRING,
      description:
        'A brief explanation of why the email was classified as relevant or not relevant.',
    },
  },
  required: ['decision', 'confidence', 'reasoning'],
};

const nativeJobExtractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    companyName: {
      type: Type.STRING,
      nullable: true,
      description: 'The name of the company the application is for.',
    },
    jobTitle: {
      type: Type.STRING,
      nullable: true,
      description: 'The job title applied for, if found.',
    },
    recruiterName: {
      type: Type.STRING,
      nullable: true,
      description: 'Recruiter or contact name if explicitly present.',
    },
    recruiterEmail: {
      type: Type.STRING,
      nullable: true,
      description: 'Recruiter or contact email if explicitly present.',
    },
    interviewStage: {
      type: Type.STRING,
      nullable: true,
      description: 'Interview stage, e.g., First Round, Onsite, Final.',
    },
    interviewType: {
      type: Type.STRING,
      nullable: true,
      description: 'Interview type, e.g., Phone, Video, In-person.',
    },
    interviewDate: {
      type: Type.STRING,
      nullable: true,
      description: 'Interview date if available.',
    },
    interviewTime: {
      type: Type.STRING,
      nullable: true,
      description: 'Interview time if available.',
    },
    assessmentInfo: {
      type: Type.STRING,
      nullable: true,
      description: 'Information about any required assessment or take-home assignment.',
    },
    assessmentDeadline: {
      type: Type.STRING,
      nullable: true,
      description: 'Deadline for the assessment if specified.',
    },
    offerInfo: {
      type: Type.STRING,
      nullable: true,
      description: 'Information regarding a job offer.',
    },
    rejectionInfo: {
      type: Type.STRING,
      nullable: true,
      description: 'Information regarding a rejection.',
    },
    actionRequired: {
      type: Type.BOOLEAN,
      nullable: true,
      description: 'Whether user action is required based on the email.',
    },
    requestedAction: {
      type: Type.STRING,
      nullable: true,
      description: 'The specific action requested from the user.',
    },
    actionDeadline: {
      type: Type.STRING,
      nullable: true,
      description: 'The deadline for the requested action.',
    },
    followUpRequired: {
      type: Type.BOOLEAN,
      nullable: true,
      description: 'Whether a follow-up is required or suggested.',
    },
    followUpDate: { type: Type.STRING, nullable: true, description: 'Suggested follow-up date.' },
    extractionConfidence: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Confidence score between 0 and 1 for the extraction.',
    },
    provenance: {
      type: Type.STRING,
      nullable: true,
      description: 'Source indication or reasoning for extracted fields.',
    },
  },
  required: [
    'companyName',
    'jobTitle',
    'recruiterName',
    'recruiterEmail',
    'interviewStage',
    'interviewType',
    'interviewDate',
    'interviewTime',
    'assessmentInfo',
    'assessmentDeadline',
    'offerInfo',
    'rejectionInfo',
    'actionRequired',
    'requestedAction',
    'actionDeadline',
    'followUpRequired',
    'followUpDate',
    'extractionConfidence',
    'provenance',
  ],
};

// A version always means the same instructions and schema for every provider. Adding a new
// contract version adds a row here; changing an existing row is a contract break.
const FINGERPRINTS: Record<string, string> = {
  'classification/v2': '8a9118222ad635794c226677775f917c897a8a220872b73c15c05e0bab6a3239',
  'extraction/v2': '2919427b2419d8601aba25567f970f3b708072e3609fbf356e32c199ed02d7b5',
};
const fingerprint = (contract: AIContract<unknown>) =>
  createHash('sha256')
    .update(`${contract.version}\n${contract.instructions}\n${JSON.stringify(z.toJSONSchema(contract.schema))}`)
    .digest('hex');

describe('provider-neutral AI contracts', () => {
  it('moved the prompts byte-for-byte with unchanged versions', () => {
    expect(CLASSIFICATION_CONTRACT.version).toBe('classification/v2');
    expect(EXTRACTION_CONTRACT.version).toBe('extraction/v2');
    expect(CLASSIFICATION_CONTRACT.instructions).toBe(PROMPTS[AI_CONTRACT_VERSIONS.CLASSIFICATION]);
    expect(EXTRACTION_CONTRACT.instructions).toBe(PROMPTS[AI_CONTRACT_VERSIONS.EXTRACTION]);
  });

  it('derives the Gemini schema equal to the former hand-written copy', () => {
    // Zod's minimum/maximum on confidence scores are dropped from the Gemini dialect and still
    // enforced by Zod validation; nothing else differs.
    expect(geminiSchema(CLASSIFICATION_CONTRACT.schema)).toEqual(nativeEmailRelevanceSchema);
    expect(geminiSchema(EXTRACTION_CONTRACT.schema)).toEqual(nativeJobExtractionSchema);
  });

  it.each([CLASSIFICATION_CONTRACT, EXTRACTION_CONTRACT])(
    'keeps $version bound to one prompt and schema',
    (contract) => {
      expect(fingerprint(contract as AIContract<unknown>)).toBe(FINGERPRINTS[contract.version]);
    },
  );
});
