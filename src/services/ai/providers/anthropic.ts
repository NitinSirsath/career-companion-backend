import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { CatalogProvider } from '../../../contracts/aiCatalog';
import { ACCESS_FAILURE_KINDS, ProviderFailure } from '../errors';
import { nullsToAbsent, strictJsonSchema } from './jsonSchema';
import { retryAfterMs } from './headers';
import { ProviderClient, VERIFY_TIMEOUT_MS, VerifyResult } from './types';

/** Anthropic error bodies: `{ type: 'error', error: { type, message } }`. Read in memory only. */
function errorBody(err: APIError): { type?: string; message?: string } {
  const body = err.error as { error?: { type?: unknown; message?: unknown } } | undefined;
  return {
    type: typeof body?.error?.type === 'string' ? body.error.type : (err.type ?? undefined),
    message: typeof body?.error?.message === 'string' ? body.error.message : undefined,
  };
}

/**
 * Anthropic error mapping (plan §3.6). Starting table; each row must be confirmed with a real key
 * before Claude is offered in production. Unrecognized → unknown outcome (held, never replayed).
 */
export function classifyAnthropicError(err: unknown): ProviderFailure {
  if (err instanceof ProviderFailure) return err;
  if (err instanceof APIConnectionError || err instanceof APIUserAbortError)
    return new ProviderFailure('OUTCOME_UNKNOWN');
  if (!(err instanceof APIError) || typeof err.status !== 'number')
    return new ProviderFailure('OUTCOME_UNKNOWN');
  const status = err.status;
  const { type, message } = errorBody(err);
  const details = { status, providerCode: type, retryAfterMs: retryAfterMs(err.headers) };
  if (type === 'authentication_error' || status === 401)
    return new ProviderFailure('KEY_REJECTED', details);
  // An empty credit balance has been reported as a 400 invalid_request_error; the text is only
  // inspected here, never kept.
  if (
    type === 'billing_error' ||
    status === 402 ||
    (status === 400 && message && /credit balance/i.test(message))
  )
    return new ProviderFailure('ACCOUNT_OR_BILLING', details);
  if (type === 'permission_error' || status === 403)
    return new ProviderFailure('ACCOUNT_OR_BILLING', details);
  if (type === 'not_found_error' || status === 404)
    return new ProviderFailure('MODEL_UNAVAILABLE', details);
  if (
    type === 'rate_limit_error' ||
    type === 'overloaded_error' ||
    status === 429 ||
    status === 529 ||
    status === 503
  )
    return new ProviderFailure('RATE_LIMITED', details);
  if (status === 408 || status >= 500) return new ProviderFailure('OUTCOME_UNKNOWN', details);
  return new ProviderFailure('INVALID_REQUEST', details);
}

export function createAnthropicClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  // No hidden retries; the endpoint is the catalog's; no token or base URL from the environment.
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: provider.baseUrl,
    maxRetries: 0,
  });
  return {
    async generateStructured({ contract, model, input }) {
      const schema = strictJsonSchema(contract.schema);
      const native = model.structuredOutput === 'anthropic_native';
      let message;
      try {
        message = await client.messages.create(
          {
            model: model.id,
            max_tokens: contract.maxOutputTokens,
            system: contract.instructions,
            messages: [{ role: 'user', content: input }],
            ...(model.temperature === null ? {} : { temperature: model.temperature }),
            // Native JSON-schema output where the model supports it; otherwise a forced tool call
            // whose input is the contract's schema. Thinking stays off (not requested).
            ...(native
              ? { output_config: { format: { type: 'json_schema' as const, schema } } }
              : {
                  tools: [
                    {
                      name: contract.schemaName,
                      description: 'Record the result in exactly this structure.',
                      input_schema: schema as Anthropic.Tool.InputSchema,
                    },
                  ],
                  tool_choice: { type: 'tool' as const, name: contract.schemaName },
                }),
          },
          { timeout: model.timeoutMs },
        );
      } catch (err) {
        throw classifyAnthropicError(err);
      }
      const usage = {
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
      };
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'refusal')
        throw new ProviderFailure('INVALID_OUTPUT', { usage });
      let data: unknown;
      if (native) {
        const text = message.content.find((block) => block.type === 'text');
        if (!text || text.type !== 'text') throw new ProviderFailure('INVALID_OUTPUT', { usage });
        try {
          data = JSON.parse(text.text);
        } catch {
          throw new ProviderFailure('INVALID_OUTPUT', {
            message: 'AI provider returned invalid JSON',
            usage,
          });
        }
      } else {
        const call = message.content.find(
          (block) => block.type === 'tool_use' && block.name === contract.schemaName,
        );
        if (!call || call.type !== 'tool_use')
          throw new ProviderFailure('INVALID_OUTPUT', { usage });
        data = call.input;
      }
      return { data: nullsToAbsent(data, contract.schema), usage };
    },

    async verifyModels(modelIds): Promise<VerifyResult> {
      for (const modelId of new Set(modelIds)) {
        try {
          await client.models.retrieve(modelId, {}, { timeout: VERIFY_TIMEOUT_MS });
        } catch (err) {
          const { kind } = classifyAnthropicError(err);
          return (ACCESS_FAILURE_KINDS as readonly string[]).includes(kind)
            ? { result: 'REJECTED', kind: kind as (typeof ACCESS_FAILURE_KINDS)[number], modelId }
            : { result: 'INCONCLUSIVE' };
        }
      }
      return { result: 'VERIFIED' };
    },
  };
}
