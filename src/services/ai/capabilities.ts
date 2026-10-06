import type { CatalogModel } from '../../contracts/aiCatalog';
import {
  AIContract,
  AIResult,
  AIRole,
  AI_CONTRACT_VERSIONS,
  RelevanceBatchEnvelopeSchema,
  classificationContractFor,
  relevanceBatchContractFor,
  EXTRACTION_CONTRACT,
  EXTRACTION_V3_CONTRACT,
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
      classifyRelevanceBatch: async (inputs, version = AI_CONTRACT_VERSIONS.RELEVANCE_BATCH) => {
        const contract = relevanceBatchContractFor(version);
        const model = models[contract.role];
        const { data, usage } = await client.generateStructured({
          contract: contract as AIContract<unknown>,
          model,
          input: JSON.stringify(inputs),
        });
        // The provider is held to the strict item schema. Only the envelope is checked here; each
        // item is checked by mapBatchResults, so one bad item never fails the whole batch.
        const parsed = RelevanceBatchEnvelopeSchema.safeParse(data);
        if (!parsed.success) throw new ProviderFailure('INVALID_OUTPUT', { usage });
        return { version: contract.version, data: parsed.data, model: model.id, usage };
      },
      classifyRelevance: (input, version = AI_CONTRACT_VERSIONS.CLASSIFICATION) => {
        const contract = classificationContractFor(version);
        return run(client, contract, models[contract.role], JSON.stringify(input));
      },
    },
    analyzer: {
      extractJobData: (body, options) =>
        options?.version === 'extraction/v3'
          ? run(
              client,
              EXTRACTION_V3_CONTRACT,
              models.detailed,
              JSON.stringify({ receivedAt: options.receivedAt, body }),
            )
          : run(client, EXTRACTION_CONTRACT, models[EXTRACTION_CONTRACT.role], body),
    },
  };
}
