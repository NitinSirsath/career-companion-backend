import { z } from 'zod';
import {
  TemporalInputSchema,
  TemporalValueSchema,
  resolveTemporal,
} from '../../contracts/temporal';

export const ScheduleCandidateSchema = TemporalInputSchema.extend({
  kind: z.enum(['INTERVIEW', 'ASSESSMENT_DUE']),
  change: z.enum(['SCHEDULED', 'RESCHEDULED', 'CANCELLED']),
  rawWhen: z.string().max(200),
  evidence: z.string().max(280).nullable(),
});
export const CandidateEnvelopeSchema = z.object({
  version: z.literal('agenda/v1'),
  candidates: z
    .array(ScheduleCandidateSchema.extend({ key: z.string(), temporal: TemporalValueSchema }))
    .max(5),
});
const whitespace = (value: string) => value.replace(/\s+/g, ' ').trim();
export function verifiedCandidates(
  candidates: z.infer<typeof ScheduleCandidateSchema>[],
  body: string,
) {
  const source = whitespace(body);
  return candidates.map((candidate) => ({
    ...candidate,
    evidence:
      candidate.evidence && source.includes(whitespace(candidate.evidence))
        ? whitespace(candidate.evidence)
        : null,
  }));
}
export function candidateEnvelope(candidates: z.infer<typeof ScheduleCandidateSchema>[]) {
  return CandidateEnvelopeSchema.parse({
    version: 'agenda/v1',
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      key: `v3:${index}`,
      temporal: resolveTemporal(candidate),
    })),
  });
}
