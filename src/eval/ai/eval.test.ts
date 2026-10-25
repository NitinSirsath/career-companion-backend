import { ProviderFailure } from '../../services/ai/errors';
import { evaluateCall } from './call';
import { baselineMetrics, evaluationOutcome, isRefused } from './score';
import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_EMAIL } from '../../services/ai/sampleEmail';
import { replyReadCases, scoreReplyRead } from './replyRead';
import {
  CaseRun,
  EvalCase,
  failures,
  loadDataset,
  matches,
  sameDate,
  score,
  snippetOf,
  THREAD_DATASET_DIR,
} from './score';

const cases = loadDataset();
const threadCases = loadDataset(THREAD_DATASET_DIR);

const RESERVED = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.test)$/i;
const domainsIn = (text: string) => [
  ...[...text.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]),
  ...[...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]),
];

describe('synthetic evaluation dataset', () => {
  it('parses, has unique IDs and covers every group', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const groups: Record<string, EvalCase[]> = {};
    for (const c of cases) (groups[c.group] ??= []).push(c);
    for (const [group, minimum] of Object.entries({
      recruiter: 4,
      application: 3,
      interview: 6,
      assessment: 4,
      offer: 3,
      rejection: 4,
      'follow-up': 3,
      'job-alerts': 3,
      irrelevant: 7,
      adversarial: 4,
    }))
      expect(groups[group]?.length ?? 0, group).toBeGreaterThanOrEqual(minimum);
  });

  it('contains no real addresses: every email and URL domain is reserved', () => {
    for (const c of [...cases, ...threadCases]) {
      const text = [c.input.sender, c.input.subject, c.input.body, c.input.snippet ?? ''].join(
        '\n',
      );
      for (const domain of domainsIn(text)) expect(domain, c.id).toMatch(RESERVED);
    }
  });

  it('marks critical cases relevant and keeps expectations consistent', () => {
    for (const c of cases) {
      if (c.expect.critical) expect(c.expect.relevance, c.id).toBe('RELEVANT');
      const nulls = new Set(c.expect.mustBeNull ?? []);
      for (const field of Object.keys(c.expect.fields ?? {}))
        expect(nulls.has(field as never), c.id).toBe(false);
    }
  });

  it('uses the built-in sample email as case 1', () => {
    const sample = cases.find((c) => c.id === 'sample-recruiter-interview')!;
    expect(sample.input).toEqual({ ...SAMPLE_EMAIL, labels: [...SAMPLE_EMAIL.labels] });
  });

  it('derives a Gmail-like snippet when none is given', () => {
    const c = cases.find((x) => !x.input.snippet)!;
    expect(snippetOf(c).length).toBeLessThanOrEqual(200);
    expect(snippetOf(c)).not.toMatch(/\s{2,}|\n/);
  });
});

describe('matching', () => {
  it.each([
    ['Wednesday, November 4, 2026', true],
    ['2026-11-04', true],
    ['Nov 4th', true],
    ['4 November 2026', true],
    ['11/04/2026', true],
    ['jueves 4 de noviembre de 2026', true],
    ['November 5, 2026', false],
    ['November 4, 2025', false],
    ['next week', false],
  ])('sameDate(%j) is %s', (text, expected) => {
    expect(sameDate(text, '2026-11-04')).toBe(expected);
  });

  it('matches text, booleans and presence', () => {
    expect(matches('Northwind  Robotics Inc.', { contains: ['northwind robotics'] })).toBe(true);
    expect(matches(null, { contains: ['x'] })).toBe(false);
    expect(matches(true, { equals: true })).toBe(true);
    expect(matches(null, { equals: false })).toBe(false);
    expect(matches('An offer', { present: true })).toBe(true);
    expect(matches('', { present: true })).toBe(false);
  });

  it('matches the closed asks exactly and counts the reply choices', () => {
    const closed = [{ id: 'ask-1', reason: 'REPLACED' }];
    expect(matches(closed, { ids: ['ask-1'] })).toBe(true);
    expect(matches(closed, { ids: [] })).toBe(false);
    expect(matches([...closed, { id: 'ask-2' }], { ids: ['ask-1'] })).toBe(false);
    expect(matches(null, { ids: [] })).toBe(true);
    expect(matches(['Yes', 'No'], { items: { min: 2, max: 3 } })).toBe(true);
    expect(matches(null, { items: { min: 2, max: 3 } })).toBe(false);
  });
});

describe('thread cases (extraction v6 and v7)', () => {
  it('parse, have unique IDs apart from the main set, and test closing and keeping asks', () => {
    const ids = new Set(cases.map((c) => c.id));
    expect(threadCases.length).toBeGreaterThanOrEqual(8);
    for (const c of threadCases) expect(ids.has(c.id), c.id).toBe(false);
    const closes = threadCases.filter((c) => {
      const matcher = c.expect.fields?.closedAsks;
      return matcher && 'ids' in matcher && matcher.ids.length > 0;
    });
    const keeps = threadCases.filter((c) => {
      const matcher = c.expect.fields?.closedAsks;
      return matcher && 'ids' in matcher && matcher.ids.length === 0;
    });
    expect(closes.length).toBeGreaterThanOrEqual(2);
    expect(keeps.length).toBeGreaterThanOrEqual(3);
  });
});

describe('scoring and pass criteria', () => {
  const ok = { valid: true, latencyMs: 100, inputTokens: 10, outputTokens: 5 };
  const relevant: EvalCase = {
    id: 'r',
    group: 'interview',
    input: { sender: 'a@example.com', subject: 's', labels: [], body: 'b' },
    expect: {
      relevance: 'RELEVANT',
      critical: true,
      category: ['INTERVIEW'],
      fields: { companyName: { contains: ['northwind'] } },
      mustBeNull: ['offerInfo'],
    },
  };
  const irrelevant: EvalCase = { ...relevant, id: 'i', expect: { relevance: 'IRRELEVANT' } };
  const injected: EvalCase = {
    ...relevant,
    id: 'x',
    expect: {
      relevance: 'RELEVANT',
      category: ['REJECTION'],
      forbidden: { values: ['globex'], category: 'OFFER' },
    },
  };
  const perfect: CaseRun[] = [
    {
      id: 'r',
      run: 1,
      classification: { ...ok, decision: 'RELEVANT', category: 'INTERVIEW', confidence: 0.9 },
      extraction: { ...ok, data: { companyName: 'Northwind Robotics', offerInfo: null } },
    },
    { id: 'i', run: 1, classification: { ...ok, decision: 'IRRELEVANT', confidence: 0.95 } },
  ];

  it('passes a perfect run', () => {
    const metrics = score([relevant, irrelevant], perfect);
    expect(metrics).toMatchObject({
      calls: 3,
      schemaValidity: 1,
      relevanceAccuracy: 1,
      criticalMisses: 0,
      categoryAccuracy: 1,
      fieldAccuracy: 1,
      hallucinationRate: 0,
      inputTokens: 30,
    });
    expect(failures(metrics)).toEqual([]);
  });

  it('counts a confident IRRELEVANT on interview mail as a critical miss', () => {
    const run: CaseRun[] = [
      { id: 'r', run: 1, classification: { ...ok, decision: 'IRRELEVANT', confidence: 0.9 } },
    ];
    const metrics = score([relevant], run);
    expect(metrics.criticalMisses).toBe(1);
    expect(failures(metrics)).toContain('critical misses 1');
  });

  it('treats low confidence as UNCERTAIN: safe for relevant mail, wrong for irrelevant mail', () => {
    const runs: CaseRun[] = [
      { id: 'r', run: 1, classification: { ...ok, decision: 'IRRELEVANT', confidence: 0.4 } },
      { id: 'i', run: 1, classification: { ...ok, decision: 'IRRELEVANT', confidence: 0.4 } },
    ];
    const metrics = score([relevant, irrelevant], runs);
    expect(metrics.criticalMisses).toBe(0);
    expect(metrics.relevanceAccuracy).toBe(0.5);
  });

  it('fails invalid output, hallucinated fields and injected values', () => {
    const runs: CaseRun[] = [
      {
        id: 'r',
        run: 1,
        classification: { ...ok, valid: false, error: 'SchemaValidationFailure' },
        extraction: { ...ok, data: { companyName: 'Northwind', offerInfo: 'An offer' } },
      },
      {
        id: 'x',
        run: 1,
        classification: { ...ok, decision: 'RELEVANT', category: 'OFFER', confidence: 0.9 },
        extraction: { ...ok, data: { companyName: 'Globex Fake Holdings' } },
      },
    ];
    const metrics = score([relevant, injected], runs);
    expect(metrics.schemaValidity).toBe(0.75);
    expect(metrics.hallucinationRate).toBe(1);
    expect(metrics.injectionFailures).toBe(1);
    expect(metrics.criticalMisses).toBe(1);
  });

  it('fails a metric more than 5 points below the baseline', () => {
    const metrics = score([relevant, irrelevant], perfect);
    expect(
      failures({ ...metrics, fieldAccuracy: 0.91 }, { ...metrics, fieldAccuracy: 0.97 }),
    ).toEqual(['fieldAccuracy more than 5 points below baseline']);
  });
});

describe('refusal accounting and safe evaluation retries', () => {
  const sample: EvalCase = {
    id: 'fixture',
    group: 'fixture',
    input: {
      sender: 'hr@fixture.test',
      subject: 'Interview',
      labels: [],
      body: 'Synthetic interview',
    },
    expect: {
      relevance: 'RELEVANT',
      critical: true,
      category: ['INTERVIEW'],
      fields: { companyName: { contains: ['Fixture'] } },
      mustBeNull: ['offerInfo'],
      forbidden: { values: ['injected'], category: 'OFFER' },
    },
  };
  const good = {
    valid: true,
    latencyMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    decision: 'RELEVANT' as const,
    category: 'INTERVIEW',
    confidence: 1,
  };
  const refusal = {
    valid: false,
    error: 'RATE_LIMITED',
    latencyMs: 999999,
    inputTokens: null,
    outputTokens: null,
  };
  it('excludes refused calls from quality, latency and critical misses', () => {
    const metrics = score(
      [sample],
      [{ id: sample.id, run: 1, classification: refusal, extraction: refusal }],
    );
    expect(metrics).toMatchObject({
      refusedCalls: 2,
      refusedByKind: { RATE_LIMITED: 2 },
      schemaValidity: 1,
      criticalMisses: 0,
      relevanceAccuracy: 1,
      fieldAccuracy: 1,
      p95LatencyMs: 0,
    });
    expect(evaluationOutcome(metrics)).toBe('INCONCLUSIVE');
  });
  it('keeps answered quality failures even when another call was refused', () => {
    const metrics = score(
      [sample],
      [
        {
          id: sample.id,
          run: 1,
          classification: { ...good, decision: 'IRRELEVANT' },
          extraction: refusal,
        },
      ],
    );
    expect(evaluationOutcome(metrics)).toBe('FAIL');
    expect(metrics.criticalMisses).toBe(1);
    expect(metrics.fieldAccuracy).toBe(1);
  });
  it('excludes access refusals and never treats invalid output as refused', () => {
    for (const error of [
      'KEY_REJECTED',
      'ACCOUNT_OR_BILLING',
      'MODEL_UNAVAILABLE',
      'RATE_LIMITED',
      'PROVIDER_BUSY',
    ])
      expect(isRefused({ error })).toBe(true);
    for (const error of ['OUTCOME_UNKNOWN', 'INVALID_OUTPUT', 'INVALID_REQUEST']) {
      const metrics = score(
        [sample],
        [{ id: sample.id, run: 1, classification: { ...refusal, error } }],
      );
      expect(metrics.refusedCalls).toBe(0);
      expect(evaluationOutcome(metrics)).toBe('FAIL');
    }
  });
  it('accepts only a valid passing baseline', () => {
    const metrics = score([sample], [{ id: sample.id, run: 1, classification: good }]);
    expect(baselineMetrics({ outcome: 'PASS', metrics })).toEqual(metrics);
    for (const outcome of ['FAIL', 'INCONCLUSIVE', undefined])
      expect(() => baselineMetrics({ outcome, metrics })).toThrow('PASS');
    expect(() =>
      baselineMetrics({ outcome: 'PASS', metrics: { ...metrics, refusedCalls: 1 } }),
    ).toThrow('PASS');
  });
  it('honors the provider delay with at most three waits, and preserves only safe metadata', async () => {
    const call = vi.fn().mockRejectedValue(
      new ProviderFailure('RATE_LIMITED', {
        status: 429,
        providerCode: 'RESOURCE_EXHAUSTED',
        retryAfterMs: 1234,
        message: 'secret fixture text',
      }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await evaluateCall(call, { sleep })).toMatchObject({
      error: 'RATE_LIMITED',
      status: 429,
      providerCode: 'RESOURCE_EXHAUSTED',
      retryAfterMs: 1234,
    });
    expect(call).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[1234], [1234], [1234]]);
    expect(JSON.stringify(await evaluateCall(call, { sleep }))).not.toContain('secret');
  });
  it('uses the default delay, rejects excessive waits and never repeats uncertain output', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new ProviderFailure('RATE_LIMITED'))
      .mockResolvedValue('ok');
    expect((await evaluateCall(retry, { delayMs: 20, sleep })).value).toBe('ok');
    expect(sleep.mock.calls).toEqual([[20], [30000]]);
    sleep.mockClear();
    const busy = vi
      .fn()
      .mockRejectedValueOnce(new ProviderFailure('PROVIDER_BUSY', { status: 529 }))
      .mockResolvedValue('ok');
    expect((await evaluateCall(busy, { sleep })).value).toBe('ok');
    expect(sleep.mock.calls).toEqual([[30000]]);
    for (const failure of [
      new ProviderFailure('RATE_LIMITED', { retryAfterMs: 120001 }),
      new ProviderFailure('OUTCOME_UNKNOWN'),
      new ProviderFailure('INVALID_OUTPUT'),
    ]) {
      sleep.mockClear();
      const call = vi.fn().mockRejectedValue(failure);
      await evaluateCall(call, { sleep });
      expect(call).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });
});

describe("reading the user's own reply", () => {
  const right = (run = 1) =>
    replyReadCases.map((c) => ({ id: c.id, run, valid: true, latencyMs: 10, answered: c.answers }));

  it('has cases that close and cases that keep the ask open', () => {
    expect(replyReadCases.filter((c) => c.answers.length).length).toBeGreaterThanOrEqual(3);
    expect(replyReadCases.filter((c) => !c.answers.length).length).toBeGreaterThanOrEqual(3);
  });

  it('passes only every case checked with no wrong close', () => {
    expect(scoreReplyRead([...right(1), ...right(2)], 2).outcome).toBe('PASS');
    expect(scoreReplyRead(right(1), 2).outcome).toBe('INCONCLUSIVE');
    const wrong = right().map((r) =>
      r.id === 'promise-later' ? { ...r, answered: ['ask-0a1b2c3d'] } : r,
    );
    expect(scoreReplyRead(wrong, 1)).toMatchObject({ outcome: 'FAIL', wrongCloses: 1 });
  });
});
