import type { CatalogProvider } from '../../../contracts/aiCatalog';
import { ProviderFailure } from '../errors';
import { errorMessageOf, httpAnswerOf, openaiLibraryClient, usableReply } from './chatCompletions';
import { retryAfterMs } from './headers';
import { strictJsonSchema } from './jsonSchema';
import { ProviderClient, VERIFY_TIMEOUT_MS } from './types';
import { checkModels } from './verify';

/** An account with no credit or no active billing. */
const BILLING_CODES = ['insufficient_quota', 'billing_not_active', 'billing_hard_limit_reached'];

/** OpenAI's short server errors and a conflict (409): busy, so the mail waits and uses no try. */
const BUSY_STATUSES = [409, 500, 502, 503, 504];

/**
 * OpenAI-compatible error mapping (plan §3.6). Starting table; each row must be confirmed with a
 * real key before the provider is offered in production. Unrecognized → no answer in time.
 */
export function classifyOpenAIError(err: unknown): ProviderFailure {
  const answer = httpAnswerOf(err);
  if (answer instanceof ProviderFailure) return answer;
  const status = answer.status;
  const code = typeof answer.code === 'string' ? answer.code : answer.type;
  const details = {
    status,
    providerCode: code ?? undefined,
    retryAfterMs: retryAfterMs(answer.headers),
    providerRequestId: answer.requestID ?? undefined,
    providerMessage: errorMessageOf(answer.error),
  };
  if (status === 401) return new ProviderFailure('KEY_REJECTED', details);
  if (status === 403 || (code && BILLING_CODES.includes(code)))
    return new ProviderFailure('ACCOUNT_OR_BILLING', details);
  if (status === 404 || code === 'model_not_found')
    return new ProviderFailure('MODEL_UNAVAILABLE', details);
  if (status === 429) return new ProviderFailure('RATE_LIMITED', details);
  if (BUSY_STATUSES.includes(status)) return new ProviderFailure('PROVIDER_BUSY', details);
  if (status === 408 || status >= 500) return new ProviderFailure('OUTCOME_UNKNOWN', details);
  return new ProviderFailure('INVALID_REQUEST', details);
}

export function createOpenAIClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  const client = openaiLibraryClient(provider, apiKey);
  return {
    async generateStructured({ contract, model, input }) {
      // Built before the call: an error in our own code is never taken for the provider's answer.
      const schema = strictJsonSchema(contract.schema);
      let completion;
      try {
        completion = await client.chat.completions.create(
          {
            model: model.id,
            messages: [
              { role: 'system', content: contract.instructions },
              { role: 'user', content: input },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: contract.schemaName,
                schema,
                strict: true,
              },
            },
            max_completion_tokens: contract.maxOutputTokens,
            ...(model.temperature === null ? {} : { temperature: model.temperature }),
            ...(model.reasoning && 'reasoningEffort' in model.reasoning
              ? { reasoning_effort: model.reasoning.reasoningEffort }
              : {}),
            // Do not keep this completion in the provider's stored-completions feature.
            store: false,
          },
          { timeout: model.timeoutMs },
        );
      } catch (err) {
        throw classifyOpenAIError(err);
      }
      return usableReply(completion, contract.schema);
    },

    verifyModels: (modelIds) =>
      checkModels(
        provider.id,
        modelIds,
        (modelId) => client.models.retrieve(modelId, { timeout: VERIFY_TIMEOUT_MS }),
        classifyOpenAIError,
      ),
  };
}
