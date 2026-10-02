import type { CatalogProvider } from '../../../contracts/aiCatalog';
import { createAnthropicClient } from './anthropic';
import { createGeminiClient } from './gemini';
import { createOpenAIClient } from './openai';
import type { ProviderClient } from './types';

export type { ProviderClient, StructuredRequest, StructuredResponse, VerifyResult } from './types';

/** The single place a provider client is built. Tests and the smoke harness replace it. */
export function createProviderClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  switch (provider.protocol) {
    case 'gemini':
      return createGeminiClient(provider, apiKey);
    case 'openai':
      return createOpenAIClient(provider, apiKey);
    case 'anthropic':
      return createAnthropicClient(provider, apiKey);
  }
}
