import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { CatalogProvider } from '../../../contracts/aiCatalog';
import { ACCESS_FAILURE_KINDS, ProviderFailure } from '../errors';
import { retryAfterMs } from './headers';
import { nullsToAbsent, strictJsonSchema } from './jsonSchema';
import { ProviderClient, VERIFY_TIMEOUT_MS, VerifyResult } from './types';

/**
 * OpenAI-compatible error mapping (plan §3.6). Starting table; each row must be confirmed with a
 * real key before the provider is offered in production. Unrecognized → unknown outcome (held).
 */
export function classifyOpenAIError(err: unknown): ProviderFailure {
  if (err instanceof ProviderFailure) return err;
  if (err instanceof APIConnectionError || err instanceof APIUserAbortError) return new ProviderFailure('OUTCOME_UNKNOWN');
  if (!(err instanceof APIError) || typeof err.status !== 'number') return new ProviderFailure('OUTCOME_UNKNOWN');
  const status = err.status;
  const code = typeof err.code === 'string' ? err.code : err.type;
  const details = { status, providerCode: code ?? undefined, retryAfterMs: retryAfterMs(err.headers) };
  if (status === 401) return new ProviderFailure('KEY_REJECTED', details);
  if (status === 429 && code === 'insufficient_quota') return new ProviderFailure('ACCOUNT_OR_BILLING', details);
  if (status === 403) return new ProviderFailure('ACCOUNT_OR_BILLING', details);
  if (status === 404 || code === 'model_not_found') return new ProviderFailure('MODEL_UNAVAILABLE', details);
  if (status === 429 || status === 503) return new ProviderFailure('RATE_LIMITED', details);
  if (status === 408 || status >= 500) return new ProviderFailure('OUTCOME_UNKNOWN', details);
  return new ProviderFailure('INVALID_REQUEST', details);
}

export function createOpenAIClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  // No hidden retries (a retry could repeat a charged call). The endpoint is the catalog's, and
  // organization/project are never taken from the server's environment.
  const client = new OpenAI({ apiKey, baseURL: provider.baseUrl, maxRetries: 0, organization: null, project: null });
  return {
    async generateStructured({ contract, model, input }) {
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
              json_schema: { name: contract.schemaName, schema: strictJsonSchema(contract.schema), strict: true },
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
      const usage = {
        inputTokens: completion.usage?.prompt_tokens ?? null,
        outputTokens: completion.usage?.completion_tokens ?? null,
      };
      const choice = completion.choices[0];
      const text = choice?.message?.content;
      if (!choice || choice.finish_reason !== 'stop' || choice.message.refusal || !text)
        throw new ProviderFailure('INVALID_OUTPUT', { usage });
      try {
        return { data: nullsToAbsent(JSON.parse(text), contract.schema), usage };
      } catch {
        throw new ProviderFailure('INVALID_OUTPUT', { message: 'AI provider returned invalid JSON', usage });
      }
    },

    async verifyModels(modelIds): Promise<VerifyResult> {
      for (const modelId of new Set(modelIds)) {
        try {
          await client.models.retrieve(modelId, { timeout: VERIFY_TIMEOUT_MS });
        } catch (err) {
          const { kind } = classifyOpenAIError(err);
          return (ACCESS_FAILURE_KINDS as readonly string[]).includes(kind)
            ? { result: 'REJECTED', kind: kind as (typeof ACCESS_FAILURE_KINDS)[number], modelId }
            : { result: 'INCONCLUSIVE' };
        }
      }
      return { result: 'VERIFIED' };
    },
  };
}
