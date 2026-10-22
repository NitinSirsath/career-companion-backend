/**
 * A path inside this app: one `/` first, then printable ASCII without a backslash. A browser
 * reads `//host` and `/\host` as another site, and drops tabs and line breaks, so none of these
 * may pass. A real page path, query and fragment are already percent-encoded and always fit.
 */
const IN_APP_PATH = /^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/;

/**
 * Where a Google flow sends the user back to. The value comes from the browser, so it is kept
 * only when it is a path inside this app (and matches `only`, for a flow with a narrower rule);
 * anything else becomes `fallback`. The result can never lead to another site.
 */
export function returnPath(value: unknown, fallback: string, only?: RegExp): string {
  if (typeof value !== 'string' || !IN_APP_PATH.test(value)) return fallback;
  return only === undefined || only.test(value) ? value : fallback;
}
