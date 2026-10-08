import { AsyncLocalStorage } from 'async_hooks';
import { logEvent } from '../utils/log';

export interface McpCallRecord {
  startedAt: number;
  userId?: string;
  tokenId?: string;
  rpcMethod?: string;
  tool?: string;
  outcome?: string;
  payloadDiffered?: boolean;
  invalidFields?: string[];
  unknownKeyCount?: number;
  errorCategory?: string;
  rejectedHost?: string;
  rejectedOriginHost?: string;
}

const storage = new AsyncLocalStorage<McpCallRecord>();

export const runWithCall = <T>(record: McpCallRecord, fn: () => T) => storage.run(record, fn);
export const currentCall = () => storage.getStore();

export function rpcMethodOf(body: unknown): string | undefined {
  if (Array.isArray(body)) return 'batch';
  if (!body || typeof body !== 'object') return undefined;
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' && /^[A-Za-z/_]{1,64}$/.test(method) ? method : 'invalid';
}

export function writeCallLog(record: McpCallRecord, status: number) {
  const { startedAt, ...fields } = record;
  logEvent('mcp_request', { status, durationMs: Date.now() - startedAt, ...fields });
}
