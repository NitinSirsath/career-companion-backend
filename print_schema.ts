import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

const TestSchema = z.object({
  decision: z.enum(['RELEVANT', 'IRRELEVANT', 'UNCERTAIN'])
});
console.log(JSON.stringify(zodToJsonSchema(TestSchema), null, 2));
