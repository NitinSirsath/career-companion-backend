/**
 * An AI draft's small Markdown set (owner, 25 Oct 2026) turned into what the reply box takes:
 * plain text, and the editor's structure (Tiptap / ProseMirror JSON). Only paragraphs, line
 * breaks, bullet and numbered lists, bold, italic and links are kept; everything else (headings,
 * code, quotes, images, tables, strike) becomes plain text. Links count only for https://, http:// and
 * mailto:.
 */
import type {
  DraftBlock,
  DraftDoc,
  DraftInline,
  DraftMark,
  DraftParagraph,
} from '../contracts/conversation';

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const SAFE_LINK = /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i;

/** What a line holds once Markdown that is not kept is reduced to its text. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/~~(?=\S)(.*?\S)~~/g, '$1');
}

const sameMarks = (a: DraftMark[], b: DraftMark[]) => JSON.stringify(a) === JSON.stringify(b);

/** Adds text with its marks, joined to the text before it when the marks are the same. */
function push(out: DraftInline[], text: string, marks: DraftMark[]) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text' && sameMarks(last.marks ?? [], marks)) last.text += text;
  else out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
}

/** Bold (`**`), italic (`_` or `*`) and links, in any nesting; anything else stays text. */
function inline(text: string, marks: DraftMark[] = [], out: DraftInline[] = []): DraftInline[] {
  let rest = text;
  while (rest) {
    // The address may hold one level of brackets, as in `javascript:alert(1)`.
    const link = rest.match(/^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/);
    if (link) {
      const href = link[2];
      inline(
        link[1],
        SAFE_LINK.test(href) ? [...marks, { type: 'link', attrs: { href } }] : marks,
        out,
      );
      rest = rest.slice(link[0].length);
      continue;
    }
    const bold = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/);
    if (bold) {
      inline(bold[1], [...marks, { type: 'bold' }], out);
      rest = rest.slice(bold[0].length);
      continue;
    }
    const italic = rest.match(/^(?:_(?=\S)([\s\S]*?\S)_(?![a-z0-9])|\\\*(?=\S)([^\*]*?\S)\\\*)/i);
    if (italic) {
      inline(italic[1] ?? italic[2], [...marks, { type: 'italic' }], out);
      rest = rest.slice(italic[0].length);
      continue;
    }
    // Plain text up to the next possible mark; a lone mark character stays as it is.
    const next = rest.slice(1).search(/[[\*_]/);
    const take = next === -1 ? rest.length : next + 1;
    push(out, rest.slice(0, take), marks);
    rest = rest.slice(take);
  }
  return out;
}

/** The text of inline nodes, links written as "text (address)" when the text is not the address. */
function textOf(nodes: DraftInline[]): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      text += '\n';
      continue;
    }
    const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href;
    text +=
      href && href !== node.text ? ${{node.text} ({href.replace(/^mailto:/i, '')})` : node.text;
  }
  return text;
}

/** A paragraph of lines that belong together, with line breaks between them. */
function paragraph(lines: string[]): DraftParagraph {
  const content: DraftInline[] = [];
  lines.forEach((line, index) => {
    if (index) content.push({ type: 'hardBreak' });
    inline(plainLine(line).trim(), [], content);
  });
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** Parses the draft into blocks: paragraphs and lists, split by empty lines and list markers. */
function blocks(draft: string): DraftBlock[] {
  const out: DraftBlock[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.some((line) => line.trim() && !/^\s*```/.test(line)))
      out.push(paragraph(lines.filter((line) => !/^\s*```/.test(line))));
    lines = [];
  };
  for (const line of draft.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = line.match(BULLET);
    const numbered = line.match(NUMBERED);
    if (!bullet && !numbered) {
      if (line.trim()) lines.push(line);
      else flush();
      continue;
    }
    flush();
    const kind = bullet ? 'bulletList' : 'orderedList';
    const item = {
      type: 'listItem' as const,
      content: [paragraph([(bullet ?? numbered)!.at(-1)!])],
    };
    const last = out[out.length - 1];
    if (last?.type === kind) last.content.push(item);
    else if (kind === 'bulletList') out.push({ type: 'bulletList', content: [item] });
    else out.push({ type: 'orderedList', attrs: { start: Number(numbered![1]) }, content: [item] });
  }
  flush();
  return out;
}

/** The plain text of the blocks: paragraphs apart by an empty line, list items one per line. */
function plainText(content: DraftBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'paragraph') return textOf(block.content ?? []);
      return block.content
        .map((item, index) => {
          const start = block.type === 'orderedList' ? (block.attrs?.start ?? 1) : 1;
          const marker = block.type === 'bulletList' ? '-' : ${{start + index}.`;
          return ${{marker} ${{item.content.map((p) => textOf(p.content ?? [])).join('\n')}`;
        })
        .join('\n');
    })
    .join('\n\n');
}

/** The draft as plain text and as the editor's structure. */
export function formatDraft(draft: string): { text: string; doc: DraftDoc } {
  const content = blocks(draft.trim());
  return { text: plainText(content).trim(), doc: { type: 'doc', content } };
}
