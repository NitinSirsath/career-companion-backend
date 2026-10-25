import { describe, expect, it } from 'vitest';
import { DraftDocSchema } from '../contracts';
import { formatDraft } from '../services/draftFormat';

const draft = (text: string) => {
  const formatted = formatDraft(text);
  DraftDocSchema.parse(formatted.doc);
  return formatted;
};

describe('an AI draft in the small Markdown set (owner, 25 Oct 2026)', () => {
  it('keeps paragraphs, line breaks, bold, italic and links', () => {
    const { text, doc } = draft(
      'Hi Priya,\n\nThank you, **Tuesday** works _well_.\nSee [my portfolio](https://nitin.example/work).\n\nBest,\nNitin',
    );
    expect(text).toBe(
      'Hi Priya,\n\nThank you, Tuesday works well.\nSee my portfolio (https://nitin.example/work).\n\nBest,\nNitin',
    );
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Hi Priya,' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Thank you, ' },
          { type: 'text', text: 'Tuesday', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' works ' },
          { type: 'text', text: 'well', marks: [{ type: 'italic' }] },
          { type: 'text', text: '.' },
          { type: 'hardBreak' },
          { type: 'text', text: 'See ' },
          {
            type: 'text',
            text: 'my portfolio',
            marks: [{ type: 'link', attrs: { href: 'https://nitin.example/work' } }],
          },
          { type: 'text', text: '.' },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Best,' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Nitin' },
        ],
      },
    ]);
  });

  it('makes bullet and numbered lists, and writes them as lines in the text', () => {
    const { text, doc } = draft(
      'I am free:\n- **Tuesday** after 3 PM\n- Wednesday morning\n\n1. CV\n2. Portfolio',
    );
    expect(text).toBe(
      'I am free:\n\n- Tuesday after 3 PM\n- Wednesday morning\n\n1. CV\n2. Portfolio',
    );
    expect(doc.content.map((block) => block.type)).toEqual([
      'paragraph',
      'bulletList',
      'orderedList',
    ]);
    expect(doc.content[1]).toMatchObject({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Tuesday', marks: [{ type: 'bold' }] },
                { type: 'text', text: ' after 3 PM' },
              ],
            },
          ],
        },
        { type: 'listItem' },
      ],
    });
    expect(doc.content[2]).toMatchObject({ type: 'orderedList', attrs: { start: 1 } });
  });

  it('turns headings, code, quotes and images into plain text', () => {
    const { text, doc } = draft(
      '# Hello\n> quoted\n```\ncode line\n```\n`x` and ![logo](https://x.example/a.png)',
    );
    expect(text).toBe('Hello\nquoted\ncode line\nx and logo');
    expect(JSON.stringify(doc)).not.toMatch(/"type":"(heading|codeBlock|code|blockquote|image)"/);
  });

  it('drops bad links and leaves no format marks in the text', () => {
    const { text, doc } = draft(
      'Click [here](javascript:alert(1)) or [mail me](mailto:me@nitin.example) or [x](ftp://x.example)',
    );
    expect(text).toBe('Click here or mail me (me@nitin.example) or x');
    expect(text).not.toMatch(/\*\*|\]\(/);
    expect(JSON.stringify(doc)).not.toContain('javascript:');
    expect(JSON.stringify(doc)).toContain('mailto:me@nitin.example');
  });

  it('keeps lone marks and placeholders as written', () => {
    expect(draft('Rate: 5 * 3 and [your free times]').text).toBe(
      'Rate: 5 * 3 and [your free times]',
    );
    expect(draft('snake_case_name stays').text).toBe('snake_case_name');
  });

  it('drops a bad link whose address holds brackets, with no stray bracket left', () => {
    const { text, doc } = draft('3. Please do not click [this](javascript:alert(1))');
    expect(text).toBe('3. Please do not click this');
    expect(JSON.stringify(doc)).not.toContain('javascript:');
    expect(JSON.stringify(doc)).not.toContain(')');
  });

  it('turns strike, which is not in the set, into plain text', () => {
    const { text, doc } = draft('some code and ~~strike~~ and pic');
    expect(text).toBe('some code and strike and pic');
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'some code and strike and pic' }] },
    ]);
  });
});
