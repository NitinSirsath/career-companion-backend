import { describe, expect, it } from 'vitest';
import { EXTRACTION_BODY_LIMIT } from '../services/ai/contracts';
import { bindCapabilities, type BoundModels } from '../services/ai/capabilities';
import { boundedBody, splitQuoted } from '../services/mailText';
import { fakeProviderClient } from './helpers/fakeProviderClient';

const QUOTE = 'On Mon, Nov 16, 2026 at 9:00 AM Priya <priya@xyz.example> wrote:';

describe('what the AI reads of a long mail (owner, 17 Nov 2026)', () => {
  it('reads a mail that fits as it is, quoted lines and all', () => {
    const body = `> Can you do Tuesday?\nYes, Tuesday works.\n\n${QUOTE}\n> Hello`;
    expect(boundedBody(body, EXTRACTION_BODY_LIMIT)).toEqual({ body, cut: false });
  });

  it('puts the own text first and lets the quoted mail fill only the room left', () => {
    const own = 'Please send your notice period.';
    const quoted = `${QUOTE}\n${'> old line\n'.repeat(2000)}`;
    const read = boundedBody(`${own}\n\n${quoted}`, 200);
    expect(read.cut).toBe(false);
    expect(read.body.startsWith(`${own}\n\n${QUOTE}`)).toBe(true);
    expect(read.body.length).toBeLessThanOrEqual(200);
  });

  it('says the mail was cut when its own text is longer than the limit', () => {
    const own = Array.from({ length: 1200 }, (_, i) => `Line ${i + 1} of the role.`).join('\n');
    const read = boundedBody(`${own}\n\n${QUOTE}\n> old`, EXTRACTION_BODY_LIMIT);
    expect(read).toEqual({ body: own.slice(0, EXTRACTION_BODY_LIMIT), cut: true });
  });

  it('splits a reply into its own text and the quoted mail', () => {
    expect(splitQuoted(`Done, thanks!\n> old line\n${QUOTE}\n> earlier`)).toEqual({
      own: 'Done, thanks!',
      quoted: `> old line\n${QUOTE}\n> earlier`,
    });
  });
});

describe('the newest extraction versions are told about the cut', () => {
  const model = { id: 'test-model', timeoutMs: 1000 } as BoundModels['detailed'];
  const models = { fast: model, detailed: model } as BoundModels;

  it('sends bodyCut to v8 and v9 only', async () => {
    const client = fakeProviderClient({ extraction: {} });
    const ai = bindCapabilities(client, models);
    const thread = { senderCanReply: true, openAsks: [] };
    for (const version of ['extraction/v8', 'extraction/v9', 'extraction/v6'])
      await ai.analyzer
        .extractJobData('body', { version, receivedAt: null, thread, bodyCut: true })
        .catch(() => undefined);
    const inputs = client.generateStructured.mock.calls.map(([call]) => JSON.parse(call.input));
    expect(inputs[0]).toMatchObject({ body: 'body', bodyCut: true, openAsks: [] });
    expect(inputs[1]).toMatchObject({ bodyCut: true });
    expect(inputs[2]).not.toHaveProperty('bodyCut');
  });
});
