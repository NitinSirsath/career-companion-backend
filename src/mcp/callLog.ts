import { AsyncLocalStorage } from 'async_hooks';

/**
 * One structured log line per /mcp request (ADR-0002 decision 13), written when the response
 * finishes, so requests rejected before the tool handler are logged too. It holds identifiers and
 * outcomes only: never payload values, the Authorization header or any part of a presented token.
 */
export interface McpCallRecord {
  startedAt: number;
  userId?: string;
  tokenId?: string;
  rpcMethod?: string;
  tool?: string;
  /** created | linked | needs_review | already_recorded | invalid_input | rate_limited | unavailable | a rejection reason */
  outcome?: string;
  payloadDiffered?: boolean;
  invalidFields?: string[];
  unknownKeyCount?: number;
  errorCategory?: string;
  /** Only on host_not_allowed / origin_not_allowed: the rejected hostname, to configure the allowlist. */
  rejectedHost?: string;
  rejectedOriginHost?: string;
}

const storage = new AsyncLocalStorage<McpCallRecord>();

export const runWithCall = <T>(record: McpCallRecord, fn: () => T) => storage.run(record, fn);
export const currentCall = () => storage.getStore();

/** A JSON-RPC method name for the log: protocol identifiers only, anything else is summarised. */
export function rpcMethodOf(body: unknown): string | undefined {
  if (Array.isArray(body)) return 'batch';
  if (!body || typeof body !== 'object') return undefined;
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' && /^[A-Za-z/_]{1,64}$/.test(method) ? method : 'invalid';
}

export function writeCallLog(record: McpCallRecord, status: number) {
  const { startedAt, ...fields } = record;
  console.log(JSON.stringify({ event: 'mcp_request', status, durationMs: Date.now() - startedAt, ...fields }));
}
