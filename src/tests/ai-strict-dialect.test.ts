import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_CONTRACT,
  EXTRACTION_CONTRACT,
  JobExtractionSchema,
  RELEVANCE_BATCH_CONTRACT,
} from '../services/ai/contracts';
import { fromStrictDialect } from '../services/ai/providers/jsonSchema';

/** What a small model wrote for full confidence: 1 plus a rounding error. */
const ALMOST_ONE = 1.0000000000000002;
const relevance = (confidence: number) => ({
  decision: 'RELEVANT',
  confidence,
  reasoning: 'An interview invitation.',
  category: 'INTERVIEW',
});

describe('reading an answer written in the strict dialect', () => {
  it('reads a confidence a rounding error past a bound as the bound', () => {
    const schema = CLASSIFICATION_CONTRACT.schema;
    expect(fromStrictDialect(relevance(ALMOST_ONE), schema)).toEqual(relevance(1));
    expect(fromStrictDialect(relevance(-1e-12), schema)).toEqual(relevance(0));
    expect(schema.safeParse(fromStrictDialect(relevance(ALMOST_ONE), schema)).success).toBe(true);
  });

  it('leaves a number really out of range for the contract to refuse', () => {
    const schema = CLASSIFICATION_CONTRACT.schema;
    for (const confidence of [1.5, 1.001, -0.01]) {
      const read = fromStrictDialect(relevance(confidence), schema);
      expect(read).toEqual(relevance(confidence));
      expect(schema.safeParse(read).success).toBe(false);
    }
  });

  it('reaches numbers in a list and in a nullable field', () => {
    const batch = fromStrictDialect(
      {
        results: [
          { key: 'e1', decision: 'RELEVANT', confidence: ALMOST_ONE, category: null },
          { key: 'e2', decision: 'IRRELEVANT', confidence: 0.4, category: null },
        ],
      },
      RELEVANCE_BATCH_CONTRACT.schema,
    );
    expect(batch).toEqual({
      results: [
        { key: 'e1', decision: 'RELEVANT', confidence: 1, category: null },
        { key: 'e2', decision: 'IRRELEVANT', confidence: 0.4, category: null },
      ],
    });
    expect(RELEVANCE_BATCH_CONTRACT.schema.safeParse(batch).success).toBe(true);

    const allNull = Object.fromEntries(
      Object.keys(JobExtractionSchema.shape).map((k) => [k, null]),
    );
    const extraction = fromStrictDialect(
      { ...allNull, extractionConfidence: ALMOST_ONE },
      EXTRACTION_CONTRACT.schema,
    );
    expect(extraction).toMatchObject({ extractionConfidence: 1 });
    expect(EXTRACTION_CONTRACT.schema.safeParse(extraction).success).toBe(true);
  });

  it('still turns a null optional field into an absent one, and leaves other values as they are', () => {
    expect(
      fromStrictDialect({ ...relevance(0.9), category: null }, CLASSIFICATION_CONTRACT.schema),
    ).toEqual({ decision: 'RELEVANT', confidence: 0.9, reasoning: 'An interview invitation.' });
    expect(fromStrictDialect('not an object', CLASSIFICATION_CONTRACT.schema)).toBe(
      'not an object',
    );
    expect(fromStrictDialect(null, CLASSIFICATION_CONTRACT.schema)).toBeNull();
  });
});
