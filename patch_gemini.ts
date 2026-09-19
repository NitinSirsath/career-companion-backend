import * as fs from 'fs';
import * as path from 'path';

const providerPath = path.join(__dirname, 'src/services/ai/gemini/GeminiProvider.ts');
let content = fs.readFileSync(providerPath, 'utf8');

// Replace imports
content = content.replace(
  "import { GoogleGenAI } from '@google/genai';",
  "import { GoogleGenAI, Type, Schema } from '@google/genai';"
);

// Remove zodToJsonSchema import
content = content.replace(
  "import { zodToJsonSchema } from 'zod-to-json-schema';\n",
  ""
);

// Add EmailCategory to imports from @prisma/client if not there? Wait, the schema keys can just be hardcoded or extracted. Let's hardcode the enums.

// Replace generateStructuredOutput signature
content = content.replace(
  "schema: z.ZodSchema<T>\n  ): Promise<T> {",
  "schema: z.ZodSchema<T>,\n    nativeSchema: Schema\n  ): Promise<T> {"
);

// Replace zodToJsonSchema logic
const oldSchemaLogic = `      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonSchema = zodToJsonSchema(schema as any, { target: 'jsonSchema7' }) as any;
      delete jsonSchema.$schema;`;

content = content.replace(oldSchemaLogic, "");

// Replace responseSchema: jsonSchema
content = content.replace(
  "responseSchema: jsonSchema,",
  "responseSchema: nativeSchema,"
);

// We need to inject the schemas and update classifyRelevance and extractJobData
const nativeEmailRelevanceSchema = `
const nativeEmailRelevanceSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      description: 'Classification of the email relevance for job searching.',
      enum: ['RELEVANT', 'IRRELEVANT', 'UNCERTAIN']
    },
    category: {
      type: Type.STRING,
      description: 'The category of the email if it is relevant.',
      enum: ['RECRUITER', 'INTERVIEW', 'ASSESSMENT', 'OFFER', 'REJECTION', 'FOLLOW_UP', 'NEWSLETTER', 'SPAM']
    },
    confidence: {
      type: Type.NUMBER,
      description: 'Confidence score between 0 and 1 for this classification.'
    },
    reasoning: {
      type: Type.STRING,
      description: 'A brief explanation of why the email was classified as relevant or not relevant.'
    }
  },
  required: ['decision', 'confidence', 'reasoning']
};
`;

const nativeJobExtractionSchema = `
const nativeJobExtractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    companyName: { type: Type.STRING, nullable: true, description: 'The name of the company the application is for.' },
    jobTitle: { type: Type.STRING, nullable: true, description: 'The job title applied for, if found.' },
    recruiterName: { type: Type.STRING, nullable: true, description: 'Recruiter or contact name if explicitly present.' },
    recruiterEmail: { type: Type.STRING, nullable: true, description: 'Recruiter or contact email if explicitly present.' },
    interviewStage: { type: Type.STRING, nullable: true, description: 'Interview stage, e.g., First Round, Onsite, Final.' },
    interviewType: { type: Type.STRING, nullable: true, description: 'Interview type, e.g., Phone, Video, In-person.' },
    interviewDate: { type: Type.STRING, nullable: true, description: 'Interview date if available.' },
    interviewTime: { type: Type.STRING, nullable: true, description: 'Interview time if available.' },
    assessmentInfo: { type: Type.STRING, nullable: true, description: 'Information about any required assessment or take-home assignment.' },
    assessmentDeadline: { type: Type.STRING, nullable: true, description: 'Deadline for the assessment if specified.' },
    offerInfo: { type: Type.STRING, nullable: true, description: 'Information regarding a job offer.' },
    rejectionInfo: { type: Type.STRING, nullable: true, description: 'Information regarding a rejection.' },
    actionRequired: { type: Type.BOOLEAN, nullable: true, description: 'Whether user action is required based on the email.' },
    requestedAction: { type: Type.STRING, nullable: true, description: 'The specific action requested from the user.' },
    actionDeadline: { type: Type.STRING, nullable: true, description: 'The deadline for the requested action.' },
    followUpRequired: { type: Type.BOOLEAN, nullable: true, description: 'Whether a follow-up is required or suggested.' },
    followUpDate: { type: Type.STRING, nullable: true, description: 'Suggested follow-up date.' },
    extractionConfidence: { type: Type.NUMBER, nullable: true, description: 'Confidence score between 0 and 1 for the extraction.' },
    provenance: { type: Type.STRING, nullable: true, description: 'Source indication or reasoning for extracted fields.' }
  },
  required: [
    'companyName', 'jobTitle', 'recruiterName', 'recruiterEmail', 'interviewStage', 
    'interviewType', 'interviewDate', 'interviewTime', 'assessmentInfo', 'assessmentDeadline', 
    'offerInfo', 'rejectionInfo', 'actionRequired', 'requestedAction', 'actionDeadline', 
    'followUpRequired', 'followUpDate', 'extractionConfidence', 'provenance'
  ]
};
`;

// Insert the schemas before the class definition
content = content.replace(
  "export class GeminiProvider",
  nativeEmailRelevanceSchema + "\n" + nativeJobExtractionSchema + "\nexport class GeminiProvider"
);

// Update classifyRelevance
content = content.replace(
  "EmailRelevanceSchema\n    );",
  "EmailRelevanceSchema,\n      nativeEmailRelevanceSchema\n    );"
);

// Update extractJobData
content = content.replace(
  "JobExtractionSchema\n    );",
  "JobExtractionSchema,\n      nativeJobExtractionSchema\n    );"
);

fs.writeFileSync(providerPath, content);
console.log('Patched GeminiProvider.ts');
