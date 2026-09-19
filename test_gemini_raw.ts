import * as dotenv from 'dotenv';
dotenv.config();
import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EmailRelevanceSchema } from './src/services/ai/contracts';

async function main() {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const jsonSchema = zodToJsonSchema(EmailRelevanceSchema as any, { target: 'jsonSchema7' }) as any;
  delete jsonSchema.$schema;
  
  const response = await client.models.generateContent({
    model: process.env.GEMINI_RELEVANCE_MODEL || 'gemini-3.5-flash-lite',
    contents: JSON.stringify({
      sender: 'News from Google <thekeyword-noreply@google.com>',
      subject: 'Android 17: new screen reactions, security upgrades & more',
      labels: [],
      snippet: 'New stuff in Android 17'
    }),
    config: {
      systemInstruction: `You are an AI assistant that determines if an email is related to a user's job search.
Analyze the provided email metadata (sender, subject, labels, snippet).
Classify if it is RELEVANT, IRRELEVANT, or UNCERTAIN.
Provide a confidence score (0 to 1).
If RELEVANT, categorize it into one of: RECRUITER, INTERVIEW, ASSESSMENT, OFFER, REJECTION, FOLLOW_UP, NEWSLETTER, SPAM.
Return your decision as a structured JSON object according to the schema.`,
      responseMimeType: 'application/json',
      responseSchema: jsonSchema,
      temperature: 0.1,
    }
  });
  
  console.log("Raw output text:", response.text);
}

main().catch(console.error);
