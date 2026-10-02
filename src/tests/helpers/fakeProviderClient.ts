import { vi } from 'vitest';
import type { StructuredRequest, VerifyResult } from '../../services/ai/providers';

type Response = unknown | ((input: string) => unknown | Promise<unknown>);

/** Deterministic provider client: answers each contract with fixed data. Never calls a network. */
export function fakeProviderClient(responses: { classification?: Response; extraction?: Response }) {
  const answer = async (response: Response, input: string) =>
    typeof response === 'function' ? response(input) : response;
  const generateStructured = vi.fn(async ({ contract, input }: StructuredRequest) => ({
    data: await answer(
      contract.schemaName === 'email_relevance' ? responses.classification : responses.extraction,
      input,
    ),
    usage: { inputTokens: 10, outputTokens: 5 },
  }));
  const calls = (schemaName: 'email_relevance' | 'job_extraction') =>
    generateStructured.mock.calls.filter(([request]) => request.contract.schemaName === schemaName);
  const verifyModels = vi.fn(async (): Promise<VerifyResult> => ({ result: 'VERIFIED' }));
  return { generateStructured, verifyModels, calls };
}
