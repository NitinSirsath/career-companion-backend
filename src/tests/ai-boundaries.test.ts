import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
const sources = (dir = SRC): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
const using = (pattern: RegExp) =>
  sources()
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file))
    .sort();

describe('credential boundaries (BYO AI plan §8)', () => {
  it('opens a sealed key only where a provider call or verification needs it', () => {
    expect(using(/\bopenApiKey\b/)).toEqual(['services/ai/access.ts', 'services/ai/credentials.ts', 'services/ai/settings.ts']);
  });

  it('reads the sealed key column only in those same modules', () => {
    expect(using(/\bencryptedApiKey\b/)).toEqual(['services/ai/access.ts', 'services/ai/settings.ts']);
  });

  it('builds provider clients only through the single seam', () => {
    expect(using(/from '\.\/(gemini|openai|anthropic)'|providers\/(gemini|openai|anthropic)'/)).toEqual(['services/ai/providers/index.ts']);
  });

  it('keeps provider SDKs inside the adapters', () => {
    expect(using(/from '(openai|@anthropic-ai\/sdk|@google\/genai)'/)).toEqual([
      'services/ai/providers/anthropic.ts',
      'services/ai/providers/gemini.ts',
      'services/ai/providers/openai.ts',
    ]);
  });
});
