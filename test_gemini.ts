import { z } from 'zod';
import { geminiSchema } from './src/services/ai/providers/gemini';
const schema = z.object({ foo: z.string() });
console.log(geminiSchema(schema));
