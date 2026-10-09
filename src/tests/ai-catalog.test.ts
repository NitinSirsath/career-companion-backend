import { describe, expect, it } from 'vitest';
import {
  AI_CATALOG,
  AI_PROVIDER_IDS,
  AI_ROLES,
  CatalogProvider,
  catalogDay,
  getCatalogProvider,
  isRetired,
  modelsForRole,
  recommendedModel,
  resolveModel,
} from '../contracts/aiCatalog';

const today = catalogDay();

describe('AI provider and model catalog', () => {
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

  it('offers a provider as supported only with approved disclosure and evaluated, current models', () => {
    for (const provider of AI_CATALOG.filter((p) => p.status === 'supported')) {
      expect(provider.disclosure.reviewedOn, provider.id).not.toBeNull();
      for (const model of provider.models) {
        expect(model.evaluation, model.id).not.toBeNull();
        expect(isRetired(model, today), `${model.id} is past retirement`).toBe(false);
      }
    }
  });

  it('resolves recommended, selected and retired selections', () => {
    const gemini = getCatalogProvider('gemini')!;
    expect(resolveModel(gemini, 'fast', null, today)).toEqual({
      model: recommendedModel(gemini, 'fast'),
      source: 'RECOMMENDED',
    });
    expect(resolveModel(gemini, 'fast', 'gemini-2.5-flash', today).source).toBe('SELECTED');
    // A model that does not serve the role, or is unknown, is never used for it.
    expect(resolveModel(gemini, 'detailed', 'gemini-2.5-flash-lite', today).source).toBe(
      'REPLACED_RETIRED',
    );
    expect(resolveModel(gemini, 'fast', 'free-form-model', today).source).toBe('REPLACED_RETIRED');

    const retiring: CatalogProvider = {
      ...gemini,
      models: gemini.models.map((m) =>
        m.id === 'gemini-2.5-flash' ? { ...m, retiresOn: '2026-01-01' } : m,
      ),
    };
    expect(modelsForRole(retiring, 'fast', '2026-01-02').map((m) => m.id)).toEqual([
      'gemini-2.5-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);
    expect(resolveModel(retiring, 'fast', 'gemini-2.5-flash', '2026-01-01').source).toBe(
      'SELECTED',
    );
    expect(resolveModel(retiring, 'fast', 'gemini-2.5-flash', '2026-01-02')).toMatchObject({
      model: { id: 'gemini-2.5-flash-lite' },
      source: 'REPLACED_RETIRED',
    });
  });

  it('offers Gemini 3 models for new keys without changing the recommended ones', () => {
    const gemini = getCatalogProvider('gemini')!;
    expect(recommendedModel(gemini, 'fast').id).toBe('gemini-2.5-flash-lite');
    expect(recommendedModel(gemini, 'detailed').id).toBe('gemini-2.5-flash');
    expect(resolveModel(gemini, 'fast', 'gemini-3.5-flash-lite', today).source).toBe('SELECTED');
    expect(resolveModel(gemini, 'fast', 'gemini-3.8-flash', today).source).toBe('SELECTED');
    expect(resolveModel(gemini, 'detailed', 'gemini-3.8-flash', today).source).toBe('SELECTED');
    expect(resolveModel(gemini, 'detailed', 'gemini-3.5-flash-lite', today).source).toBe(
      'REPLACED_RETIRED',
    );
  });

  it('has no provider that is unknown to the catalog', () => {
    expect(getCatalogProvider('custom')).toBeUndefined();
  });
});
