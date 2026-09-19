const { zodToJsonSchema } = require('zod-to-json-schema');
const { z } = require('zod');

const TestSchema = z.object({
  decision: z.enum(['RELEVANT', 'IRRELEVANT', 'UNCERTAIN'])
});
console.log(JSON.stringify(zodToJsonSchema(TestSchema), null, 2));
