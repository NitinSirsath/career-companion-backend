/**
 * A mail's own new text and the quoted earlier mail under it, as mail apps write them. Used to
 * read the user's replies, and to fit a long mail into what the AI reads (owner, 17 Nov 2026).
 */

/** The first line of the quoted earlier mail, as Gmail and other mail apps write it. */
const QUOTE_START = [
  /^On .+ wrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^From: .+/,
  /^_{5,}\s*$/,
];

/**
 * Splits a body into its own text (above the quoted earlier mail, without ">" lines) and the
 * quoted part (the rest, and the ">" lines). Neither is cut.
 */
export function splitQuoted(body: string): { own: string; quoted: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex((line) => QUOTE_START.some((start) => start.test(line.trim())));
  const above = end === -1 ? lines : lines.slice(0, end);
  const below = end === -1 ? [] : lines.slice(end);
  const isQuote = (line: string) => line.trimStart().startsWith('>');
  return {
    own: above
      .filter((line) => !isQuote(line))
      .join('\n')
      .trim(),
    quoted: [...above.filter(isQuote), ...below].join('\n').trim(),
  };
}

/**
 * The part of a mail the AI reads, at most `limit` characters. A mail that fits is read as it is.
 * A longer one: its own text first, and the quoted earlier mail only in the room left. `cut` is
 * true when the mail's own text did not fit, so the AI knows the end of it is missing; a quoted
 * part that did not fit is not a cut.
 */
export function boundedBody(body: string, limit: number): { body: string; cut: boolean } {
  if (body.length <= limit) return { body, cut: false };
  const { own, quoted } = splitQuoted(body);
  if (own.length >= limit) return { body: own.slice(0, limit), cut: own.length > limit };
  const room = limit - own.length - 2;
  const rest = room > 0 ? quoted.slice(0, room) : '';
  return { body: rest ? `${own}\n\n${rest}` : own, cut: false };
}
