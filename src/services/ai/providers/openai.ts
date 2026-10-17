import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import type { CatalogProvider } from '../../../contracts/aiCatalog';
import { ProviderFailure } from '../errors';
import { retryAfterMs } from './headers';
import { nullsToAbsent, strictJsonSchema } from './jsonSchema';
import { droppedConnection, libraryConnectionFailure, unansweredFailure } from './network';
import { ProviderClient, VERIFY_TIMEOUT_MS } from './types';
import { checkModels } from './verify';

/** An account with no credit or no active billing. */
const BILLING_CODES = ['insufficient_quota', 'billing_not_active', 'billing_hard_limit_reached'];

/** OpenAI's short server errors and a conflict (409): busy, so the mail waits and uses no try. */
const BUSY_STATUSES = [409, 500, 502, 503, 504];

/** The text of OpenAI's error body (`{ error: { message } }`); cleaned by ProviderFailure. */
function errorText(err: APIError): string | undefined {
  const body = err.error as { message?: unknown } | undefined;
  return typeof body?.message === 'string' ? body.message : undefined;
}

/**
 * OpenAI-compatible error mapping (plan §3.6). Starting table; each row must be confirmed with a
 * real key before the provider is offered in production. Unrecognized → no answer in time.
 */
export function classifyOpenAIError(err: unknown): ProviderFailure {
  if (err instanceof ProviderFailure) return err;
  if (err instanceof APIConnectionError)
    return unansweredFailure(
      libraryConnectionFailure(err, err instanceof APIConnectionTimeoutError),
    );
  const dropped = droppedConnection(err);
  if (dropped) return unansweredFailure(dropped);
  if (!(err instanceof APIError) || typeof err.status !== 'number')
    return new ProviderFailure('OUTCOME_UNKNOWN', { failureCause: 'UNCLASSIFIED' });
  const status = err.status;
  const code = typeof err.code === 'string' ? err.code : err.type;
  const details = {
    status,
    providerCode: code ?? undefined,
    retryAfterMs: retryAfterMs(err.headers),
    providerRequestId: err.requestID ?? undefined,
    providerMessage: errorText(err),
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

/** Why an unusable answer stopped early (for example `length`), or that the model refused. */
function stoppedEarly(choice: OpenAI.ChatCompletion.Choice | undefined): string | undefined {
  if (choice?.message.refusal) return 'refusal';
  return choice?.finish_reason === 'stop' ? undefined : choice?.finish_reason;
}

export function createOpenAIClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  // No hidden retries (a retry could repeat a charged call). The endpoint is the catalog's, and
  // organization/project are never taken from the server's environment.
  const client = new OpenAI({
    apiKey,
    baseURL: provider.baseUrl,
    maxRetries: 0,
    organization: null,
    project: null,
  });
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
      const usage = {
        inputTokens: completion.usage?.prompt_tokens ?? null,
        outputTokens: completion.usage?.completion_tokens ?? null,
      };
      const choice = completion.choices[0];
      const text = choice?.message?.content;
      if (!choice || choice.finish_reason !== 'stop' || choice.message.refusal || !text)
        throw new ProviderFailure('INVALID_OUTPUT', { usage, stopReason: stoppedEarly(choice) });
      try {
        return { data: nullsToAbsent(JSON.parse(text), contract.schema), usage };
      } catch {
        throw new ProviderFailure('INVALID_OUTPUT', {
          message: 'AI provider returned invalid JSON',
          usage,
        });
      }
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
