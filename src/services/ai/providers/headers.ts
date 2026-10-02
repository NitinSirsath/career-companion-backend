/** Retry-After as milliseconds: `retry-after-ms`, or `retry-after` in seconds or as an HTTP date. */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
  const ms = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
