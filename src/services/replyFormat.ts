/**
 * A formatted reply (owner, 25 Oct 2026): the rich text editor's structure, checked, turned into
 * the mail's plain text and HTML. The page never sends HTML; the server writes it from a fixed set
 * of tags, and every text in it is escaped.
 */
import type {
  DraftBlock,
  DraftDoc,
  DraftInline,
  DraftMark,
  DraftParagraph,
} from '../contracts/conversation';
import { SAFE_LINK, docText } from './draftFormat';
import { escapeHtml } from './mailHtml';

/** A mark the reply keeps: a link only with a safe address, each kind once. */
function keptMarks(marks: DraftMark[] = []): DraftMark[] {
  const kept: DraftMark[] = [];
  for (const mark of marks) {
    if (kept.some((other) => other.type === mark.type)) continue;
    if (mark.type !== 'link') kept.push({ type: mark.type });
    else if (mark.attrs && SAFE_LINK.test(mark.attrs.href))
      kept.push({ type: 'link', attrs: { href: mark.attrs.href } });
  }
  return kept;
}

const safeInline = (nodes: DraftInline[] = []): DraftInline[] =>
  nodes.map((node) => {
    if (node.type === 'hardBreak') return node;
    const marks = keptMarks(node.marks);
    return marks.length
      ? { type: 'text', text: node.text, marks }
      : { type: 'text', text: node.text };
  });

const safeParagraph = (paragraph: DraftParagraph): DraftParagraph =>
  paragraph.content?.length
    ? { type: 'paragraph', content: safeInline(paragraph.content) }
    : { type: 'paragraph' };

/** The reply with every link that is not https://, http:// or mailto: turned into plain words. */
export function safeDoc(doc: DraftDoc): DraftDoc {
  return {
    type: 'doc',
    content: doc.content.map((block): DraftBlock => {
      if (block.type === 'paragraph') return safeParagraph(block);
      const content = block.content.map((item) => ({
        type: 'listItem' as const,
        content: item.content.map(safeParagraph),
      }));
      return block.type === 'bulletList' ? { type: 'bulletList', content } : { ...block, content };
    }),
  };
}

/** The reply as plain text, as mail programs that show no HTML read it. */
export const replyText = (doc: DraftDoc): string => docText(doc).replace(/\n{3,}/g, '\n\n');

const TAGS: [DraftMark['type'], string][] = [
  ['underline', 'u'],
  ['italic', 'em'],
  ['bold', 'strong'],
];

function inlineHtml(nodes: DraftInline[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '<br>';
      let html = escapeHtml(node.text);
      for (const [type, tag] of TAGS)
        if (node.marks?.some((mark) => mark.type === type)) html = `<${tag}>${html}</${tag}>`;
      const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href;
      return href ? `<a href="${escapeHtml(href)}">${html}</a>` : html;
    })
    .join('');
}

function blockHtml(block: DraftBlock): string {
  if (block.type === 'paragraph') return `<p>${inlineHtml(block.content) || '<br>'}</p>`;
  const items = block.content
    .map((item) => `<li>${item.content.map((p) => inlineHtml(p.content)).join('<br>')}</li>`)
    .join('');
  if (block.type === 'bulletList') return `<ul>${items}</ul>`;
  const start = block.attrs?.start ?? 1;
  return start === 1 ? `<ol>${items}</ol>` : `<ol start="${start}">${items}</ol>`;
}

/** The reply as HTML: only p, br, strong, em, u, ul, ol, li and a href. */
export const replyHtml = (doc: DraftDoc): string => doc.content.map(blockHtml).join('');
