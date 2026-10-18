import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CATALOG,
  AI_PROVIDER_IDS,
  AI_ROLES,
  CatalogProvider,
  getCatalogProvider,
  isRetired,
  modelsForRole,
  recommendedModel,
  resolveModel,
} from '../contracts/aiCatalog';

describe('AI provider and model catalog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists each known provider once, with unique model IDs', () => {
    expect(AI_CATALOG.map((p) => p.id).sort()).toEqual([...AI_PROVIDER_IDS].sort());
    for (const provider of AI_CATALOG)
      expect(new Set(provider.models.map((m) => m.id)).size, provider.id).toBe(
        provider.models.length,
      );
  });

  it('has exactly one recommended model per role, and it serves that role', () => {
    for (const provider of AI_CATALOG)
      for (const role of AI_ROLES) {
        const recommended = provider.models.filter((m) => m.recommendedFor.includes(role));
        expect(recommended, `${provider.id}/${role}`).toHaveLength(1);
        expect(recommended[0].roles).toContain(role);
      }
  });

  it('uses fixed HTTPS endpoints and links only', () => {
    for (const provider of AI_CATALOG) {
      const base = new URL(provider.baseUrl);
      expect(base.protocol).toBe('https:');
      expect(base.search + base.hash + base.username + base.password).toBe('');
      for (const link of Object.values(provider.links))
        expect(new URL(link).protocol).toBe('https:');
    }
  });

  it('keeps per-model request settings within safe bounds', () => {
    for (const model of AI_CATALOG.flatMap((p) => p.models)) {
      expect(model.timeoutMs).toBeGreaterThanOrEqual(5_000);
      expect(model.timeoutMs).toBeLessThanOrEqual(120_000);
      if (model.temperature !== null) expect(model.temperature).toBeLessThanOrEqual(1);
      for (const role of model.recommendedFor) expect(model.roles).toContain(role);
    }
  });

  it('gives each model only the thinking control and answer format its protocol reads', () => {
    // Every protocol must be listed: a new one needs its own rules here.
    const thinkingKeys: Record<CatalogProvider['protocol'], string[]> = {
      gemini: ['thinkingBudget', 'thinkingLevel'],
      openai: ['reasoningEffort'],
      anthropic: [],
      openrouter: ['enabled', 'effort'],
    };
    const answerFormats: Record<CatalogProvider['protocol'], string[]> = {
      gemini: ['gemini_schema'],
      openai: ['openai_json_schema'],
      anthropic: ['anthropic_native', 'anthropic_tool'],
      openrouter: ['openai_json_schema'],
    };
    for (const provider of AI_CATALOG)
      for (const model of provider.models) {
        for (const key of Object.keys(model.reasoning ?? {}))
          expect(thinkingKeys[provider.protocol], `${model.id}: ${key}`).toContain(key);
        expect(answerFormats[provider.protocol], model.id).toContain(model.structuredOutput);
        // Only the OpenRouter adapter reads it.
        if (model.noOutputLimit) expect(provider.protocol, model.id).toBe('openrouter');
      }
  });

  it('names OpenRouter models by their exact ID: no alias and no variant', () => {
    // An alias such as "~…-latest" or a variant such as ":free" can change the model without an
    // evaluation.
    for (const model of getCatalogProvider('openrouter')!.models)
      expect(model.id).toMatch(/^[a-z0-9-]+\/[a-z0-9._-]+$/);
  });

  it('writes retirement days as YYYY-MM-DD', () => {
    for (const model of AI_CATALOG.flatMap((p) => p.models))
      if (model.retiresOn !== null)
        expect(model.retiresOn, model.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('offers a provider as supported only with approved disclosure and evaluated, current models', () => {
    for (const provider of AI_CATALOG.filter((p) => p.status === 'supported')) {
      expect(provider.disclosure.reviewedOn, provider.id).not.toBeNull();
      for (const model of provider.models) {
        expect(model.evaluation, model.id).not.toBeNull();
        expect(isRetired(model), `${model.id} is past retirement`).toBe(false);
      }
    }
  });

  it('resolves recommended, selected and retired selections', () => {
    const gemini = getCatalogProvider('gemini')!;
    expect(resolveModel(gemini, 'fast', null)).toEqual({
      model: recommendedModel(gemini, 'fast'),
      source: 'RECOMMENDED',
    });
    expect(resolveModel(gemini, 'fast', 'gemini-2.5-flash').source).toBe('SELECTED');
    // A model that does not serve the role, or is unknown, is never used for it.
    expect(resolveModel(gemini, 'detailed', 'gemini-2.5-flash-lite').source).toBe(
      'REPLACED_RETIRED',
    );
    expect(resolveModel(gemini, 'fast', 'free-form-model').source).toBe('REPLACED_RETIRED');

    const retiring: CatalogProvider = {
      ...gemini,
      models: gemini.models.map((m) =>
        m.id === 'gemini-2.5-flash' ? { ...m, retiresOn: '2026-01-01' } : m,
      ),
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(modelsForRole(retiring, 'fast').map((m) => m.id)).toEqual([
      'gemini-2.5-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);
    vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
    expect(resolveModel(retiring, 'fast', 'gemini-2.5-flash').source).toBe('SELECTED');
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(resolveModel(retiring, 'fast', 'gemini-2.5-flash')).toMatchObject({
      model: { id: 'gemini-3.5-flash-lite' },
      source: 'REPLACED_RETIRED',
    });
  });

  it('recommends the Gemini 3 models, which a new key can use, and still offers the 2.5 models', () => {
    const gemini = getCatalogProvider('gemini')!;
    expect(recommendedModel(gemini, 'fast').id).toBe('gemini-3.5-flash-lite');
    expect(recommendedModel(gemini, 'detailed').id).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, 'fast', 'gemini-2.5-flash-lite').source).toBe('SELECTED');
    expect(resolveModel(gemini, 'fast', 'gemini-2.5-flash').source).toBe('SELECTED');
    expect(resolveModel(gemini, 'detailed', 'gemini-2.5-flash').source).toBe('SELECTED');
    expect(resolveModel(gemini, 'detailed', 'gemini-3.5-flash-lite').source).toBe(
      'REPLACED_RETIRED',
    );
  });

  it('has no provider that is unknown to the catalog', () => {
    expect(getCatalogProvider('custom')).toBeUndefined();
  });
});
