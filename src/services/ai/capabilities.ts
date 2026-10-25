import type { CatalogModel } from '../../contracts/aiCatalog';
import {
  AIContract,
  AIResult,
  AIRole,
  AI_CONTRACT_VERSIONS,
  RelevanceBatchEnvelopeSchema,
  classificationContractFor,
  relevanceBatchContractFor,
  extractionContractFor,
  SCHEDULE_EXTRACTION_VERSIONS,
  THREAD_EXTRACTION_VERSIONS,
  NO_THREAD,
  EmailAnalyzer,
  RelevanceClassifier,
} from './contracts';
import { ProviderFailure } from './errors';
import { REPLY_READ_CONTRACT, type ReplyRead, type ReplyReadInput } from './replyRead';
import { REPLY_DRAFT_CONTRACT, type ReplyDraft, type ReplyDraftInput } from './replyDraft';
import type { ProviderClient } from './providers';

export type BoundModels = Record<AIRole, CatalogModel>;

/** What the AI does with the user's own side of a conversation. */
export interface ReplyCapabilities {
  /** Which open asks the user's reply settles. */
  read(input: ReplyReadInput): Promise<AIResult<ReplyRead>>;
  /** A draft of the user's reply, from the whole conversation. */
  write(input: ReplyDraftInput): Promise<AIResult<ReplyDraft>>;
}

export interface AICapabilities {
  classifier: RelevanceClassifier;
  analyzer: EmailAnalyzer;
  replies: ReplyCapabilities;
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

/**
 * The versions that read times also get the received time, and the thread versions also the
 * conversation's open asks; the others get the body only.
 */
function extractionInput(
  body: string,
  contract: AIContract<unknown>,
  options: Parameters<EmailAnalyzer['extractJobData']>[1],
): string {
  const receivedAt = options?.receivedAt ?? null;
  if (THREAD_EXTRACTION_VERSIONS.includes(contract.version))
    return JSON.stringify({ receivedAt, body, ...(options?.thread ?? NO_THREAD) });
  if (SCHEDULE_EXTRACTION_VERSIONS.includes(contract.version))
    return JSON.stringify({ receivedAt, body });
  return body;
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
      extractJobData: (body, options) => {
        const contract = extractionContractFor(options?.version ?? AI_CONTRACT_VERSIONS.EXTRACTION);
        return run(
          client,
          contract,
          models[contract.role],
          extractionInput(body, contract, options),
        );
      },
    },
    replies: {
      read: (input) =>
        run(client, REPLY_READ_CONTRACT, models[REPLY_READ_CONTRACT.role], JSON.stringify(input)),
      write: (input) =>
        run(client, REPLY_DRAFT_CONTRACT, models[REPLY_DRAFT_CONTRACT.role], JSON.stringify(input)),
    },
  };
}
