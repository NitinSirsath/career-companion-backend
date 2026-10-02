import type { CatalogModel } from '../../contracts/aiCatalog';
import {
  AIContract,
  AIResult,
  AIRole,
  CLASSIFICATION_CONTRACT,
  EXTRACTION_CONTRACT,
  EmailAnalyzer,
  RelevanceClassifier,
} from './contracts';
import { ProviderFailure } from './errors';
import type { ProviderClient } from './providers';

export type BoundModels = Record<AIRole, CatalogModel>;

export interface AICapabilities {
  classifier: RelevanceClassifier;
  analyzer: EmailAnalyzer;
}

async function run<T>(
  client: ProviderClient,
  contract: AIContract<T>,
  model: CatalogModel,
  input: string,
): Promise<AIResult<T>> {
  const { data, usage } = await client.generateStructured({
    contract: contract as AIContract<unknown>,
    model,
    input,
  });
  const parsed = contract.schema.safeParse(data);
  // Validated output is the only thing kept; Zod issues (which can quote values) are dropped.
  if (!parsed.success) throw new ProviderFailure('INVALID_OUTPUT', { usage });
  return { version: contract.version, data: parsed.data, model: model.id, usage };
}

/** Feature-facing capabilities bound to one provider client and the models for each role. */
export function bindCapabilities(client: ProviderClient, models: BoundModels): AICapabilities {
  return {
    classifier: {
      classifyRelevance: (input) =>
        run(client, CLASSIFICATION_CONTRACT, models[CLASSIFICATION_CONTRACT.role], JSON.stringify(input)),
    },
    analyzer: {
      extractJobData: (body) =>
        run(client, EXTRACTION_CONTRACT, models[EXTRACTION_CONTRACT.role], body),
    },
  };
}
