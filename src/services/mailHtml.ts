/**
 * Plain text and HTML for the mail the app writes. The answered mail is quoted from its text, also
 * when it came as HTML only, and every text the app puts into HTML is escaped, so no HTML from
 * another mail ever passes through the app.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Text as HTML text: nothing in it can become a tag or end an attribute. */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** `&amp;`, `&#233;` and `&#xe9;` as the characters they stand for; unknown names stay. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole;
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Where a block of the HTML starts or ends, and where a paragraph does, while lines are made:
 * characters of the private use area, which no mail text holds.
 */
const LINE = '\ue000';
const PARAGRAPH = '\ue001';

/**
 * The words of an HTML mail as plain text, with its line breaks and list items: what a mail
 * program quotes when a mail has no plain-text part. Styles, scripts and comments are left out.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/[\ue000\ue001]/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Line breaks in the source are only spaces on screen; the tags make the lines.
    .replace(/\s+/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, PARAGRAPH)
    .replace(/<li\b[^>]*>/gi, `${LINE}- `)
    .replace(/<\/?(div|tr|li|h[1-6]|blockquote|ul|ol|table)\b[^>]*>/gi, LINE)
    .replace(/<[^>]*>/g, '')
    // Blocks next to each other start one new line; a paragraph leaves an empty line.
    .replace(/[\ue000\ue001]+/g, (run) => (run.includes(PARAGRAPH) ? '\n\n' : '\n'));
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
