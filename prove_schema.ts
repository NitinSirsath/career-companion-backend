import { zodToJsonSchema } from 'zod-to-json-schema';
import { EmailRelevanceSchema } from './src/services/ai/contracts';

const result = zodToJsonSchema(EmailRelevanceSchema as any, { target: 'jsonSchema7' });
console.log("Original result:");
console.log(JSON.stringify(result, null, 2));

const copy = { ...result };
delete (copy as any).$schema;
console.log("After deleting $schema:");
console.log(JSON.stringify(copy, null, 2));
