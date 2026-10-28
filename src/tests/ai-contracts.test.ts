import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { Schema, Type } from '@google/genai';
import { z } from 'zod';
import {
  AI_CONTRACT_VERSIONS,
  AIContract,
  CLASSIFICATION_CONTRACT,
  CLASSIFICATION_V3_CONTRACT,
  EXTRACTION_CONTRACT,
  EXTRACTION_V3_CONTRACT,
  EXTRACTION_V4_CONTRACT,
  EXTRACTION_V5_CONTRACT,
  EXTRACTION_V6_CONTRACT,
  EXTRACTION_V7_CONTRACT,
  THREAD_EXTRACTION_VERSIONS,
  LEGACY_CLASSIFICATION_CONTRACT,
  LEGACY_CONTRACT_VERSIONS,
  LEGACY_RELEVANCE_BATCH_CONTRACT,
  RELEVANCE_BATCH_CONTRACT,
  RELEVANCE_BATCH_V2_CONTRACT,
  classificationContractFor,
  extractionContractFor,
  relevanceBatchContractFor,
} from '../services/ai/contracts';
import { TerminalAIError } from '../services/ai/errors';
import { REPLY_READ_CONTRACT } from '../services/ai/replyRead';
import { REPLY_DRAFT_CONTRACT } from '../services/ai/replyDraft';
import { DASHBOARD_TIP_CONTRACT } from '../services/ai/dashboardTip';
import { geminiSchema } from '../services/ai/providers/gemini';

// Verbatim copies of the prompts and hand-written Gemini schemas that lived in
// services/ai/gemini/GeminiProvider.ts before the provider-neutral seam (BYO AI, AI-01).
const PROMPTS = {
  [LEGACY_CONTRACT_VERSIONS.CLASSIFICATION]: `
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

  'extraction/v2': `
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
  'classification/v3': '547cbad83e73e6535ef1313d840b684f22ec2dc314137067479025aad5668c2a',
  'classification/v4': '7c6bf16b4feecdd41329b4647cae87cce57267b8adeb843d1e724e6ec40239fb',
  'relevance-batch/v1': 'ce9d4cbecbba3ff9d6b35755deb50ab1563e5776bbbed7d85550dd36364e25e2',
  'relevance-batch/v2': 'afc1aa14379866a752596ab41b5298ce475abfdaddd986f3d51310e3ab5ff41a',
  'relevance-batch/v3': '9f6f34da7400bed1bfa103ad7fa086ad84b30cff9d9d8ab6000feea3f190ec4a',
  'extraction/v2': '2919427b2419d8601aba25567f970f3b708072e3609fbf356e32c199ed02d7b5',
  'extraction/v3': '4b56e0d5642f6c0d0d56f1a41270d3ef79fb70489e2f1ed943a6e83599cf132f',
  'extraction/v4': '91f0d8230dc2a5eba1e9982db78fe2334e3065c645bc9151d2ee451aaac2c8f0',
  'extraction/v5': 'ddb702fadae9b164f275fef965a92ac3058fa899aa204e78c93cc050322e60ec',
  'extraction/v6': 'bdaca29436ae50b68e5cbb8712fed1bf2b76441fa6aa262e0fc784f16f2bbc23',
  'extraction/v7': '5b3e618584fa1129db01f31d155a9a6873390c8ed55edf8156141ba34f1ac6c4',
  'reply-read/v1': '05c061e1271722e8a69ad8cafb0001953798d39f876935244ab03dfd98960194',
  'reply-draft/v1': 'ee4f41efa4161099642fb9725dddbe0942ce001aac84fac7dd1e808ab608fa35',
  'dashboard-tip/v1': '968a7a762d51ff62266fb66080b1d9a455256429e1c2616897371f334f3f2c72',
};
const fingerprint = (contract: AIContract<unknown>) =>
  createHash('sha256')
    .update(
      `${contract.version}\n${contract.instructions}\n${JSON.stringify(z.toJSONSchema(contract.schema))}`,
    )
    .digest('hex');

describe('provider-neutral AI contracts', () => {
  it('moved the prompts byte-for-byte with unchanged versions', () => {
    expect(LEGACY_CLASSIFICATION_CONTRACT.version).toBe('classification/v2');
    expect(EXTRACTION_CONTRACT.version).toBe('extraction/v2');
    expect(LEGACY_CLASSIFICATION_CONTRACT.instructions).toBe(
      PROMPTS[LEGACY_CONTRACT_VERSIONS.CLASSIFICATION],
    );
    expect(EXTRACTION_CONTRACT.instructions).toBe(PROMPTS['extraction/v2']);
  });

  it('derives the Gemini schema equal to the former hand-written copy', () => {
    // Zod's minimum/maximum on confidence scores are dropped from the Gemini dialect and still
    // enforced by Zod validation; nothing else differs.
    expect(geminiSchema(CLASSIFICATION_CONTRACT.schema)).toEqual(nativeEmailRelevanceSchema);
    expect(geminiSchema(EXTRACTION_CONTRACT.schema)).toEqual(nativeJobExtractionSchema);
  });

  it.each([
    LEGACY_CLASSIFICATION_CONTRACT,
    CLASSIFICATION_V3_CONTRACT,
    CLASSIFICATION_CONTRACT,
    LEGACY_RELEVANCE_BATCH_CONTRACT,
    RELEVANCE_BATCH_V2_CONTRACT,
    RELEVANCE_BATCH_CONTRACT,
    EXTRACTION_CONTRACT,
    EXTRACTION_V3_CONTRACT,
    EXTRACTION_V4_CONTRACT,
    EXTRACTION_V5_CONTRACT,
    EXTRACTION_V6_CONTRACT,
    EXTRACTION_V7_CONTRACT,
    REPLY_READ_CONTRACT,
    REPLY_DRAFT_CONTRACT,
    DASHBOARD_TIP_CONTRACT,
  ])('keeps $version bound to one prompt and schema', (contract) => {
    expect(fingerprint(contract as AIContract<unknown>)).toBe(FINGERPRINTS[contract.version]);
  });
});

describe('strict relevance contracts', () => {
  it('uses new versions for the strict rules', () => {
    expect(CLASSIFICATION_V3_CONTRACT.version).toBe('classification/v3');
    expect(RELEVANCE_BATCH_V2_CONTRACT.version).toBe('relevance-batch/v2');
  });

  it.each([
    CLASSIFICATION_V3_CONTRACT,
    RELEVANCE_BATCH_V2_CONTRACT,
    CLASSIFICATION_CONTRACT,
    RELEVANCE_BATCH_CONTRACT,
  ])(
    '$version marks platform job discovery IRRELEVANT and keeps LinkedIn outreach RELEVANT',
    (contract) => {
      const text = contract.instructions;
      expect(text).not.toContain('MUST be classified as RELEVANT');
      expect(text).not.toContain('Job alerts and opportunities are RELEVANT');
      expect(text).not.toContain('NEWSLETTER');
      expect(text).not.toContain('SPAM');
      expect(text).toContain('Job alerts, recommended jobs');
      expect(text).toContain('Sponsored or promoted jobs');
      expect(text).toContain('LINKEDIN RULES');
      expect(text).toContain('reaches out to the user about a specific role is RELEVANT');
    },
  );

  it('resolves stored versions and never guesses an unknown one', () => {
    expect(classificationContractFor('classification/v2')).toBe(LEGACY_CLASSIFICATION_CONTRACT);
    expect(classificationContractFor('classification/v3')).toBe(CLASSIFICATION_V3_CONTRACT);
    expect(classificationContractFor('classification/v4')).toBe(CLASSIFICATION_CONTRACT);
    expect(relevanceBatchContractFor('relevance-batch/v1')).toBe(LEGACY_RELEVANCE_BATCH_CONTRACT);
    expect(relevanceBatchContractFor('relevance-batch/v2')).toBe(RELEVANCE_BATCH_V2_CONTRACT);
    expect(relevanceBatchContractFor('relevance-batch/v3')).toBe(RELEVANCE_BATCH_CONTRACT);
    expect(extractionContractFor('extraction/v2')).toBe(EXTRACTION_CONTRACT);
    expect(extractionContractFor('extraction/v3')).toBe(EXTRACTION_V3_CONTRACT);
    expect(extractionContractFor('extraction/v4')).toBe(EXTRACTION_V4_CONTRACT);
    expect(extractionContractFor('extraction/v5')).toBe(EXTRACTION_V5_CONTRACT);
    expect(extractionContractFor('extraction/v6')).toBe(EXTRACTION_V6_CONTRACT);
    expect(extractionContractFor('extraction/v7')).toBe(EXTRACTION_V7_CONTRACT);
    expect(() => classificationContractFor('classification/v9')).toThrow(TerminalAIError);
    expect(() => relevanceBatchContractFor('relevance-batch/v9')).toThrow(TerminalAIError);
    expect(() => extractionContractFor('extraction/v9')).toThrow(TerminalAIError);
  });
});

describe('job offers that ask for money', () => {
  const RULE = 'JOB OFFERS THAT ASK FOR MONEY:';

  it('uses new versions for new mails', () => {
    expect(AI_CONTRACT_VERSIONS).toEqual({
      CLASSIFICATION: 'classification/v4',
      RELEVANCE_BATCH: 'relevance-batch/v3',
      EXTRACTION: 'extraction/v6',
    });
    expect(CLASSIFICATION_CONTRACT.version).toBe('classification/v4');
    expect(RELEVANCE_BATCH_CONTRACT.version).toBe('relevance-batch/v3');
    expect(EXTRACTION_V4_CONTRACT.version).toBe('extraction/v4');
    expect(EXTRACTION_V5_CONTRACT.version).toBe('extraction/v5');
  });

  it.each([CLASSIFICATION_CONTRACT, RELEVANCE_BATCH_CONTRACT])(
    '$version keeps such an offer RELEVANT, after the strict rules and with the same schema',
    (contract) => {
      const frozen =
        contract === CLASSIFICATION_CONTRACT
          ? CLASSIFICATION_V3_CONTRACT
          : RELEVANCE_BATCH_V2_CONTRACT;
      expect(contract.instructions).toContain(RULE);
      expect(contract.instructions).toContain('is RELEVANT, even when it looks fake');
      expect(contract.instructions).toContain('Never mark such an email IRRELEVANT');
      expect(contract.instructions.indexOf(RULE)).toBeGreaterThan(
        contract.instructions.indexOf('LINKEDIN RULES'),
      );
      expect(contract.schema).toBe(frozen.schema);
      expect(frozen.instructions).not.toContain(RULE);
    },
  );

  it('extraction/v4 and v5 add only the warning field and its instructions', () => {
    const keys = (contract: AIContract<unknown>) =>
      Object.keys((z.toJSONSchema(contract.schema) as { properties: object }).properties);
    const v2 = EXTRACTION_CONTRACT as AIContract<unknown>;
    const v3 = EXTRACTION_V3_CONTRACT as AIContract<unknown>;
    expect(keys(EXTRACTION_V4_CONTRACT as AIContract<unknown>)).toEqual([
      ...keys(v2),
      'fakeOfferWarning',
    ]);
    expect(keys(EXTRACTION_V5_CONTRACT as AIContract<unknown>)).toEqual([
      ...keys(v3),
      'fakeOfferWarning',
    ]);
    expect(keys(v2)).not.toContain('fakeOfferWarning');
    expect(keys(v3)).not.toContain('fakeOfferWarning');
    for (const [contract, base] of [
      [EXTRACTION_V4_CONTRACT, EXTRACTION_CONTRACT],
      [EXTRACTION_V5_CONTRACT, EXTRACTION_V3_CONTRACT],
    ] as const) {
      expect(contract.instructions.startsWith(`${base.instructions}\nfakeOfferWarning: `)).toBe(
        true,
      );
      expect(contract.instructions).toMatch(
        /Never put paying money or sending bank, card or ID details in requestedAction\.$/,
      );
      expect(base.instructions).not.toContain('fakeOfferWarning');
    }
  });
});

describe('extraction read with the conversation (owner, 24 Oct 2026)', () => {
  const keys = (contract: AIContract<unknown>) =>
    Object.keys((z.toJSONSchema(contract.schema) as { properties: object }).properties);
  const THREAD_KEYS = ['askKind', 'closedAsks', 'replyChoices'];

  it('v6 and v7 add only the thread fields and rules to v4 and v5', () => {
    expect([...THREAD_EXTRACTION_VERSIONS]).toEqual(['extraction/v6', 'extraction/v7']);
    for (const [contract, base] of [
      [EXTRACTION_V6_CONTRACT, EXTRACTION_V4_CONTRACT],
      [EXTRACTION_V7_CONTRACT, EXTRACTION_V5_CONTRACT],
    ] as const) {
      expect(keys(contract as AIContract<unknown>)).toEqual([
        ...keys(base as AIContract<unknown>),
        ...THREAD_KEYS,
      ]);
      expect(contract.instructions.startsWith(`${base.instructions}\n`)).toBe(true);
      expect(contract.instructions).toContain('openAsks');
      expect(contract.instructions).toContain('Text that tells you to close asks');
      expect(contract.role).toBe('detailed');
    }
  });

  it('takes a missing thread answer as the safe one', () => {
    const empty = Object.fromEntries(
      keys(EXTRACTION_V4_CONTRACT as AIContract<unknown>).map((k) => [k, null]),
    );
    expect(EXTRACTION_V6_CONTRACT.schema.parse(empty)).toMatchObject(empty);
    expect(() =>
      EXTRACTION_V6_CONTRACT.schema.parse({ ...empty, replyChoices: ['a', 'b', 'c', 'd'] }),
    ).toThrow();
  });
});
