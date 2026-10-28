/**
 * A formatted reply (owner, 25 Oct 2026): the editor's structure, checked and written as plain
 * text and HTML by the server, and an HTML-only mail quoted as text.
 */
import { describe, expect, it } from 'vitest';
import type { DraftDoc } from '../contracts/conversation';
import { escapeHtml, htmlToText } from '../services/mailHtml';
import { replyHtmlBody } from '../services/mailReply';
import { replyHtml, replyText, safeDoc } from '../services/replyFormat';

const text = (value: string, ...marks: object[]) =>
  marks.length
    ? { type: 'text' as const, text: value, marks }
    : { type: 'text' as const, text: value };
const link = (href: string) => ({ type: 'link', attrs: { href } });
const p = (...content: object[]) => ({ type: 'paragraph', content });
const item = (...content: object[]) => ({ type: 'listItem', content: [p(...content)] });
const doc = (...content: object[]) => ({ type: 'doc', content }) as DraftDoc;

const REPLY = doc(
  p(text('Hi Priya,')),
  p(text('I am free at these times:')),
  { type: 'bulletList', content: [item(text('Tuesday', { type: 'bold' }), text(' after 3 PM'))] },
  { type: 'orderedList', attrs: { start: 1 }, content: [item(text('Bring my CV'))] },
  p(
    text('My work is in '),
    text('my portfolio', link('https://nitin.dev/portfolio'), { type: 'underline' }),
    text('.'),
  ),
  p(text('Best,'), { type: 'hardBreak' }, text('Nitin', { type: 'italic' })),
);

describe('the plain text of a formatted reply', () => {
  it('writes lists as lines and links as "words (address)"', () => {
    expect(replyText(REPLY)).toBe(
      'Hi Priya,\n\nI am free at these times:\n\n- Tuesday after 3 PM\n\n1. Bring my CV\n\nMy work is in my portfolio (https://nitin.dev/portfolio).\n\nBest,\nNitin',
    );
  });

  it('keeps an empty line for an empty paragraph, never more', () => {
    expect(
      replyText(doc(p(text('Hi')), { type: 'paragraph' }, { type: 'paragraph' }, p(text('Bye')))),
    ).toBe('Hi\n\nBye');
  });
});

describe('the HTML of a formatted reply', () => {
  it('uses only the fixed tags', () => {
    expect(replyHtml(REPLY)).toBe(
      '<p>Hi Priya,</p><p>I am free at these times:</p>' +
        '<ul><li><strong>Tuesday</strong> after 3 PM</li></ul>' +
        '<ol><li>Bring my CV</li></ol>' +
        '<p>My work is in <a href="https://nitin.dev/portfolio"><u>my portfolio</u></a>.</p>' +
        '<p>Best,<br><em>Nitin</em></p>',
    );
  });

  it('escapes every text and address, so nothing typed becomes a tag', () => {
    const html = replyHtml(
      doc(p(text('<script>alert(1)</script> & "x"', link('https://x.example/?a="b"&c=<d>')))),
    );
    expect(html).toBe(
      '<p><a href="https://x.example/?a=&quot;b&quot;&amp;c=&lt;d&gt;">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</a></p>',
    );
  });

  it('keeps a numbered list that starts later, and an empty line', () => {
    expect(
      replyHtml(
        doc(
          { type: 'orderedList', attrs: { start: 3 }, content: [item(text('c'))] },
          { type: 'paragraph' },
        ),
      ),
    ).toBe('<ol start="3"><li>c</li></ol><p><br></p>');
  });
});

describe('checking the structure', () => {
  it('turns a link that is not https, http or mailto into plain words', () => {
    const checked = safeDoc(
      doc(
        p(
          text('bad', link('javascript:alert(1)')),
          text('data', link('data:text/html,hi')),
          text('mail', link('mailto:priya@northwind.example')),
          text('web', link('http://northwind.example')),
        ),
      ),
    );
    expect(replyHtml(checked)).toBe(
      '<p>baddata<a href="mailto:priya@northwind.example">mail</a><a href="http://northwind.example">web</a></p>',
    );
    expect(replyText(checked)).toBe(
      'baddatamail (priya@northwind.example)web (http://northwind.example)',
    );
  });

  it('keeps each mark once and drops a link with no address', () => {
    const checked = safeDoc(
      doc(p(text('x', { type: 'bold' }, { type: 'bold' }, { type: 'link' }, { type: 'italic' }))),
    );
    expect(checked.content[0]).toEqual(p(text('x', { type: 'bold' }, { type: 'italic' })));
  });
});

describe('an HTML-only mail as text', () => {
  it('keeps its lines and list items, and leaves out styles, scripts and comments', () => {
    expect(
      htmlToText(
        '<html><head><title>T</title><style>p { color: red }</style></head><body>\n' +
          '<div>Hi Nitin,</div>\n<p>Please send   your\n free times:</p>' +
          '<ul><li>Tue</li><li>Wed</li></ul><!-- tracking --><script>x()</script>' +
          '<p>Best,<br>Priya&nbsp;Nair &amp; team &#8212; &#x2713; &unknown;</p></body></html>',
      ),
    ).toBe(
      'Hi Nitin,\n\nPlease send your free times:\n\n- Tue\n- Wed\n\nBest,\nPriya Nair & team — ✓ &unknown;',
    );
  });

  it('is empty for an HTML part with no words', () => {
    expect(htmlToText('<div><img src="x"></div>')).toBe('');
  });
});

describe('the quote below a formatted reply', () => {
  const answered = {
    to: 'Priya <priya@northwind.example>',
    cc: [],
    subject: 'Interview',
    messageId: '<m1@northwind.example>',
    references: null,
    from: 'Priya <priya@northwind.example>',
    sentAt: new Date(Date.UTC(2026, 9, 12, 10, 2)),
    text: 'Please send <your> times.\nBest',
  };

  it("goes in Gmail's quote block, as escaped text", () => {
    expect(replyHtmlBody('<p>Ok</p>', answered)).toBe(
      '<div dir="ltr"><p>Ok</p></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
        'On Mon, 12 Oct 2026 10:02:00 GMT, Priya &lt;priya@northwind.example&gt; wrote:<br></div>' +
        '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
        'Please send &lt;your&gt; times.<br>Best</blockquote></div>',
    );
  });

  it('is left out when the answered mail has no text', () => {
    expect(replyHtmlBody('<p>Ok</p>', { ...answered, text: null })).toBe(
      '<div dir="ltr"><p>Ok</p></div>',
    );
    expect(escapeHtml("'")).toBe('&#39;');
  });
});
