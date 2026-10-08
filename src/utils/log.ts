/**
 * The one way to write a log line. Production and tests get one JSON line per event; a developer's
 * terminal gets a short readable line. Lines below LOG_LEVEL are skipped.
 *
 * Log events, not data: IDs, counts and outcomes. Fields named like secrets or email content are
 * replaced with "[redacted]" whatever the caller passes.
 */
import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import { logLevel, readableLogs } from './config';
import { errorCategory } from './errorCategory';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keys, tokens and credentials, whatever their prefix (`apiKey`, `refreshToken`, …). */
const SECRET_NAME = /(apikey|token|password|secret|authorization|cookie)$/i;
/** Email content. */
const CONTENT_FIELDS = new Set(['body', 'html', 'text', 'snippet', 'subject']);

const requestIds = new AsyncLocalStorage<string>();

/** Runs `fn` so that every line it logs carries `requestId`. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIds.run(requestId, fn);
}

export function logDebug(event: string, fields?: Fields): void {
  write('debug', event, fields);
}

export function logEvent(event: string, fields?: Fields): void {
  write('info', event, fields);
}

export function logWarn(event: string, fields?: Fields): void {
  write('warn', event, fields);
}

/** With `error`, the line also says what broke and where. */
export function logError(event: string, fields?: Fields, error?: unknown): void {
  write('error', event, error === undefined ? fields : { ...fields, ...describe(error) });
}

function write(level: Level, event: string, fields: Fields = {}): void {
  if (RANK[level] < RANK[logLevel()]) return;
  const requestId = requestIds.getStore();
  const record = { event, level, ...(requestId ? { requestId } : {}), ...redact(fields) };
  const line = readableLogs() ? readable(record) : JSON.stringify(record);
  // Looked up on every call, so tests that spy on console see every line.
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.log(line);
}

function redact(fields: Fields): Fields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SECRET_NAME.test(key) || CONTENT_FIELDS.has(key) ? '[redacted]' : value,
    ]),
  );
}

/**
 * Category, code and our own file:line always. The message and stack only on a developer's machine:
 * provider and driver messages can carry connection strings or request details.
 */
function describe(error: unknown): Fields {
  const stack = error instanceof Error ? error.stack : undefined;
  const where = ourFrame(stack);
  return {
    ...errorCategory(error),
    ...(where ? { where } : {}),
    ...(readableLogs() && error instanceof Error ? { message: error.message, stack } : {}),
  };
}

const isOurs = (frame: string) =>
  /[/\\](src|dist)[/\\]/.test(frame) && !frame.includes('node_modules');

/** The first stack frame in our code, as `src/…/file.ts:line`. */
function ourFrame(stack: string | undefined): string | undefined {
  const frame = stack?.split('\n').find(isOurs);
  const match = frame?.match(/\(?([^\s()]+):(\d+):\d+\)?$/);
  return match ? `${path.relative(process.cwd(), match[1])}:${match[2]}` : undefined;
}

function readable({ event, level, stack, ...fields }: Fields): string {
  const time = new Date().toTimeString().slice(0, 8);
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  const line = [time, String(level).toUpperCase().padEnd(5), event, ...pairs].join(' ');
  if (typeof stack !== 'string') return line;
  return [line, ...shortStack(stack)].join('\n');
}

/** Frames in our code with short paths, or the top 3 frames when none are ours. */
function shortStack(stack: string): string[] {
  const frames = stack.split('\n').slice(1);
  const ours = frames.filter(isOurs);
  return (ours.length ? ours : frames.slice(0, 3)).map((frame) =>
    frame.replace(process.cwd() + path.sep, ''),
  );
}
