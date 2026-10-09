import type { CatalogModel } from '../../../contracts/aiCatalog';
import type { AIContract, AIUsage } from '../contracts';

/**
 * Provider boundary (ADR-0001 decision 3). One implementation per API protocol. Implementations
 * translate a Career Companion contract into their protocol and never see users, the database or
 * email states. Thrown errors carry only application-written text: provider messages can echo
 * the key or email content, so they are never copied.
 */
export interface StructuredRequest {
  contract: AIContract<unknown>;
  model: CatalogModel;
  input: string;
}

/** `data` is parsed but unvalidated; the AI layer validates it against the contract schema. */
export interface StructuredResponse {
  data: unknown;
  usage: AIUsage;
}

/** Content-free check that a key authenticates and can use the given models (no tokens). */
export type VerifyResult =
  | { result: 'VERIFIED' }
  | {
      result: 'REJECTED';
      kind: 'KEY_REJECTED' | 'ACCOUNT_OR_BILLING' | 'MODEL_UNAVAILABLE';
      modelId?: string;
    }
  | { result: 'INCONCLUSIVE' };

export interface ProviderClient {
  /** Throws ProviderFailure only. */
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
  /** Never throws. */
  verifyModels(modelIds: readonly string[]): Promise<VerifyResult>;
}

export const VERIFY_TIMEOUT_MS = 10_000;
