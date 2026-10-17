import type { AIFailure } from '../../../contracts/ai';
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

/**
 * Check that a key authenticates and can use the given models. It never sends anything of the
 * user's: a model lookup, or a fixed tiny request where a lookup proves nothing. A check that
 * failed says which model, what the provider answered and how long it waited (`failure`).
 */
export type VerifyResult =
  | { result: 'VERIFIED' }
  | {
      result: 'REJECTED';
      kind: 'KEY_REJECTED' | 'ACCOUNT_OR_BILLING' | 'MODEL_UNAVAILABLE';
      modelId?: string;
      failure?: AIFailure;
      /** Dev mode only: the provider's own error text, cleaned and short; for the log only. */
      providerMessage?: string;
    }
  | { result: 'INCONCLUSIVE'; failure?: AIFailure; providerMessage?: string };

export interface ProviderClient {
  /**
   * Throws ProviderFailure for anything the provider or the connection did. An error in our own
   * code, such as building the answer format, is thrown as it is.
   */
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
  /** Never throws. */
  verifyModels(modelIds: readonly string[]): Promise<VerifyResult>;
}

export const VERIFY_TIMEOUT_MS = 10_000;
