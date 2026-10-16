/**
 * Google's deadline and ours, through the real Gemini library: only fetch is replaced, and it holds
 * each request open until the library stops it or the test answers. Google is told the model's own
 * time limit, once; our timer stops the call 15 seconds later, so Google's own 504 normally comes
 * first. Nothing is sent anywhere.
 */
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCatalogProvider } from '../contracts/aiCatalog';
import { CLASSIFICATION_CONTRACT } from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { createGeminiClient } from '../services/ai/providers/gemini';

const gemini = getCatalogProvider('gemini')!;
const model = (id: string) => gemini.models.find((m) => m.id === id)!;

interface HeldRequest {
  headers: Headers;
  answer: (response: Response) => void;
}

/** Like fetch, but nothing leaves: a request waits for an answer or for its signal to abort. */
function holdRequests() {
  const requests: HeldRequest[] = [];
  const fetch = vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({ headers: new Headers(init?.headers), answer: resolve });
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}

const classify = (id: string) =>
  createGeminiClient(gemini, 'test_key')
    .generateStructured({
      contract: CLASSIFICATION_CONTRACT,
      model: model(id),
      input: 'Synthetic mail',
    })
    .then(
      () => {
        throw new Error('expected a failure');
      },
      (err: ProviderFailure) => err,
    );

describe("Google's deadline and our timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ['gemini-3.8-flash', '60', 75_000],
    ['gemini-3.5-flash-lite', '30', 45_000],
  ])(
    '%s: Google is told %s seconds, once, and we stop waiting at %i ms',
    async (id, seconds, stopAt) => {
      const { fetch, requests } = holdRequests();
      let settled = false;
      const pending = classify(id).finally(() => (settled = true));

      await vi.advanceTimersByTimeAsync(stopAt - 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      // Headers joins a header sent twice ("60, 60"), so this also shows it was sent once.
      expect(requests[0].headers.get('X-Server-Timeout')).toBe(seconds);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ kind: 'OUTCOME_UNKNOWN', failureCause: 'TIMEOUT' });
    },
  );

  it("takes Google's own 504 at its deadline, before our timer, and clears our timer", async () => {
    const { requests } = holdRequests();
    const pending = classify('gemini-3.8-flash');
    await vi.advanceTimersByTimeAsync(60_000);
    requests[0].answer(
      Response.json(
        {
          error: {
            code: 504,
            message: 'Deadline expired before operation could complete.',
            status: 'DEADLINE_EXCEEDED',
          },
        },
        { status: 504 },
      ),
    );
    const failure = await pending;
    expect(failure).toMatchObject({
      kind: 'OUTCOME_UNKNOWN',
      status: 504,
      providerCode: 'DEADLINE_EXCEEDED',
      failureCause: 'PROVIDER_DEADLINE',
    });
    expect(failure.networkCode).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the key check on its own short limit of 10 seconds', async () => {
    const { requests } = holdRequests();
    let settled = false;
    const pending = createGeminiClient(gemini, 'test_key')
      .verifyModels(['gemini-3.8-flash'])
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requests[0].headers.get('X-Server-Timeout')).toBe('10');
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ result: 'INCONCLUSIVE' });
  });
});

describe("the network layer's own limits", () => {
  type Internals = Record<symbol, unknown>;
  /** An undici field, found by its symbol's name as the Gemini library itself does. */
  const field = (target: unknown, name: string) => {
    const own = target as Internals;
    const key = Object.getOwnPropertySymbols(own).find((symbol) => symbol.description === name);
    return key === undefined ? undefined : own[key];
  };

  /**
   * The header and body limits of the connections Node's fetch (undici) opened to one origin:
   * the global Agent keeps a Pool per origin, and the Pool its Clients.
   */
  function undiciLimits(origin: string) {
    const agent = (globalThis as unknown as Internals)[Symbol.for('undici.globalDispatcher.1')];
    const pools = field(agent, 'clients') as Map<string, { dispatcher: unknown }>;
    const clients = field(pools.get(origin)?.dispatcher, 'clients') as unknown[];
    return clients.map((client) => ({
      headersTimeout: field(client, 'headers timeout'),
      bodyTimeout: field(client, 'body timeout'),
    }));
  }

  it('waits longer for headers and body than our longest Gemini wait of 75 seconds', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // The Gemini call no longer sets the library's `timeout`, so the library leaves undici's
      // limits as they are: undici's defaults (300 seconds each in Node 24).
      await (await fetch(`${origin}/`)).text();
      const longestWait = Math.max(...gemini.models.map((m) => m.timeoutMs)) + 15_000;
      expect(longestWait).toBe(75_000);
      const limits = undiciLimits(origin);
      expect(limits.length).toBeGreaterThan(0);
      for (const { headersTimeout, bodyTimeout } of limits) {
        expect(headersTimeout).toBeGreaterThanOrEqual(longestWait);
        expect(bodyTimeout).toBeGreaterThanOrEqual(longestWait);
      }
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
