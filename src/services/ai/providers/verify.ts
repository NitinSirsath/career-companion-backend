import { ACCESS_FAILURE_KINDS, FailureKind, ProviderFailure } from '../errors';
import { failureRecord } from '../failures';
import { VERIFY_TIMEOUT_MS, VerifyResult } from './types';

type AccessKind = (typeof ACCESS_FAILURE_KINDS)[number];
const isAccessKind = (kind: FailureKind): kind is AccessKind =>
  (ACCESS_FAILURE_KINDS as readonly string[]).includes(kind);

/**
 * A key check: checks each model once, in order, and stops at the first that fails. A key, account
 * or model the provider refuses is REJECTED; anything else (busy, no answer in time) cannot
 * decide. The failure says which model, what the provider answered and how long the check waited.
 * Never throws.
 */
export async function checkModels(
  provider: string,
  modelIds: readonly string[],
  check: (modelId: string) => Promise<unknown>,
  classify: (err: unknown) => ProviderFailure,
): Promise<VerifyResult> {
  for (const modelId of new Set(modelIds)) {
    const startedAt = new Date();
    try {
      await check(modelId);
    } catch (err) {
      const error = classify(err);
      const failure = failureRecord(error, {
        provider,
        model: modelId,
        startedAt,
        failedAt: new Date(),
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      const { providerMessage } = error;
      return isAccessKind(error.kind)
        ? { result: 'REJECTED', kind: error.kind, modelId, failure, providerMessage }
        : { result: 'INCONCLUSIVE', failure, providerMessage };
    }
  }
  return { result: 'VERIFIED' };
}
