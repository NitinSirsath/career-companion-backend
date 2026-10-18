import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import type { z } from 'zod';
import type { CatalogProvider } from '../../../contracts/aiCatalog';
import type { AIUsage } from '../contracts';
import { ProviderFailure } from '../errors';
import { fromStrictDialect } from './jsonSchema';
import { droppedConnection, libraryConnectionFailure, unansweredFailure } from './network';
import type { StructuredResponse } from './types';

/**
 * What the OpenAI and OpenRouter adapters share: both speak OpenAI's chat completions through the
 * `openai` library. The one place for the client settings, the first sorting of an error and the
 * rule for a usable answer.
 */

/**
 * No hidden retries (a retry could repeat a charged call). The endpoint is the catalog's, and
 * organization/project are never taken from the server's environment.
 */
export function openaiLibraryClient(provider: CatalogProvider, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: provider.baseUrl,
    maxRetries: 0,
    organization: null,
    project: null,
  });
}

/** An HTTP answer: the library sets a status only when the provider answered. */
type HttpAnswer = APIError & { status: number };
const hasStatus = (err: APIError): err is HttpAnswer => typeof err.status === 'number';

/**
 * The provider's HTTP answer, for the adapter's own table, or the failure of a call that got no
 * answer. An error we cannot sort is no answer in time, which the operation fails as our own bug.
 */
export function httpAnswerOf(err: unknown): ProviderFailure | HttpAnswer {
  if (err instanceof ProviderFailure) return err;
  if (err instanceof APIConnectionError)
    return unansweredFailure(
      libraryConnectionFailure(err, err instanceof APIConnectionTimeoutError),
    );
  const dropped = droppedConnection(err);
  if (dropped) return unansweredFailure(dropped);
  if (!(err instanceof APIError) || !hasStatus(err))
    return new ProviderFailure('OUTCOME_UNKNOWN', { failureCause: 'UNCLASSIFIED' });
  return err;
}

/** The text of an error body (`{ message }`); cleaned by ProviderFailure. */
export function errorMessageOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

export function replyUsage(completion: Pick<OpenAI.ChatCompletion, 'usage'>): AIUsage {
  return {
    inputTokens: completion.usage?.prompt_tokens ?? null,
    outputTokens: completion.usage?.completion_tokens ?? null,
  };
}

/** Why an unusable answer stopped early (for example `length`), or that the model refused. */
function stoppedEarly(choice: OpenAI.ChatCompletion.Choice | undefined): string | undefined {
  if (choice?.message.refusal) return 'refusal';
  return choice?.finish_reason === 'stop' ? undefined : choice?.finish_reason;
}

/**
 * The answer's data, when it is usable: the model stopped by itself, did not refuse and wrote
 * JSON. Anything else is unusable output, with the usage and why it stopped.
 */
export function usableReply(
  completion: OpenAI.ChatCompletion,
  schema: z.ZodType,
): StructuredResponse {
  const usage = replyUsage(completion);
  const choice = completion.choices[0];
  const text = choice?.message?.content;
  if (!choice || choice.finish_reason !== 'stop' || choice.message.refusal || !text)
    throw new ProviderFailure('INVALID_OUTPUT', { usage, stopReason: stoppedEarly(choice) });
  try {
    return { data: fromStrictDialect(JSON.parse(text), schema), usage };
  } catch {
    throw new ProviderFailure('INVALID_OUTPUT', {
      message: 'AI provider returned invalid JSON',
      usage,
    });
  }
}
