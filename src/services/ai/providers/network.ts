import { ProviderFailure, ProviderFailureDetails } from '../errors';

type FailurePlace = Pick<ProviderFailureDetails, 'failureCause' | 'networkCode'>;

/** Codes of a connection that failed before the request left: the provider never saw it. */
const NEVER_SENT = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * The system or undici code of a failed connection, from the error or its causes: fetch rejects
 * with a TypeError whose cause carries it, and the OpenAI and Anthropic libraries wrap that again.
 */
function connectionCode(err: unknown): string | undefined {
  let current = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Where a connection failed. Only a code that shows the request never left counts as NETWORK;
 * anything else may have reached the provider.
 */
export function connectionFailure(err: unknown): FailurePlace {
  const networkCode = connectionCode(err);
  const neverSent = networkCode !== undefined && NEVER_SENT.has(networkCode);
  return { failureCause: neverSent ? 'NETWORK' : 'NETWORK_AFTER_SEND', networkCode };
}

/**
 * A connection that failed under the library: fetch rejects with a TypeError whose cause is the
 * connection's error, also when the line drops while the answer is read (undici's "terminated",
 * which the OpenAI and Anthropic libraries pass on as it is).
 */
export function droppedConnection(err: unknown): FailurePlace | undefined {
  return err instanceof TypeError && err.cause !== undefined
    ? connectionFailure(err.cause)
    : undefined;
}

/**
 * A connection error of the OpenAI or Anthropic library. Its own timer gives a timeout error with
 * no connection code; a timeout with a code (for example undici's connect timeout) is the network.
 * The Anthropic library drops the cause of every timeout, so its connect timeout is logged as
 * TIMEOUT.
 */
export function libraryConnectionFailure(err: Error, timedOut: boolean): FailurePlace {
  const failure = connectionFailure(err.cause);
  return timedOut && failure.networkCode === undefined ? { failureCause: 'TIMEOUT' } : failure;
}

/**
 * A call that got no answer. A request that never left is a busy provider: nothing reached it, so
 * it waits and uses no try. Anything else (our timer, a connection that dropped after sending) is
 * no answer in time, as is an error we cannot sort, which the operation then fails as our own bug.
 */
export function unansweredFailure(place: FailurePlace): ProviderFailure {
  return new ProviderFailure(
    place.failureCause === 'NETWORK' ? 'PROVIDER_BUSY' : 'OUTCOME_UNKNOWN',
    place,
  );
}
