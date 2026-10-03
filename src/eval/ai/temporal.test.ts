import { expect, it } from 'vitest';
import { scoreTemporal } from './temporal';
import { JobExtractionSchema } from '../../services/ai/contracts';
const legacy = Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((key) => [key, null]));
it('never qualifies a partial or refused temporal run', () => {
  expect(scoreTemporal([], 2).outcome).toBe('INCONCLUSIVE');
});
it('detects invented instants and unsafe event mutation fields', () => {
  const result = {
    id: 'temporal-missing-zone',
    run: 1,
    classification: { valid: true, latencyMs: 0, inputTokens: null, outputTokens: null },
    extraction: {
      valid: true,
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      data: {
        ...legacy,
        scheduleCandidates: [
          {
            kind: 'INTERVIEW',
            change: 'SCHEDULED',
            rawWhen: '14:30',
            date: '2026-10-04',
            time: '14:30',
            sourceTimeZone: 'UTC',
            evidence: null,
            state: 'CONFIRMED',
          },
        ],
      },
    },
  };
  expect(scoreTemporal([result], 2)).toMatchObject({
    checked: 1,
    failed: 1,
    outcome: 'INCONCLUSIVE',
  });
});
