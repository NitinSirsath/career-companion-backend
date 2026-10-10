import { ACCESS_FAILURE_KINDS } from '../../services/ai/errors';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

// ─── Dataset ──────────────────────────────────────────────────────────────────

const Category = z.enum([
  'RECRUITER',
  'INTERVIEW',
  'ASSESSMENT',
  'OFFER',
  'REJECTION',
  'FOLLOW_UP',
  'NEWSLETTER',
  'SPAM',
]);
const ExtractionField = z.enum([
  'companyName',
  'jobTitle',
  'recruiterName',
  'recruiterEmail',
  'interviewStage',
  'interviewType',
  'interviewDate',
  'interviewTime',
  'assessmentInfo',
  'assessmentDeadline',
  'offerInfo',
  'rejectionInfo',
  'actionRequired',
  'requestedAction',
  'actionDeadline',
  'followUpRequired',
  'followUpDate',
]);
const Matcher = z.union([
  z.strictObject({ contains: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ date: z.iso.date() }),
  z.strictObject({ equals: z.boolean() }),
  z.strictObject({ present: z.literal(true) }),
]);
export type Matcher = z.infer<typeof Matcher>;

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  group: z.string(),
  input: z.strictObject({
    sender: z.string(),
    subject: z.string(),
    labels: z.array(z.string()),
    snippet: z.string().optional(),
    body: z.string().min(1),
    receivedAt: z.iso.datetime({ offset: true }).optional(),
  }),
  expect: z.strictObject({
    /** ANY marks a borderline case, excluded from relevance accuracy. */
    relevance: z.enum(['RELEVANT', 'IRRELEVANT', 'ANY']),
    /** Interview, assessment or offer mail: classifying it IRRELEVANT is a critical miss. */
    critical: z.boolean().optional(),
    category: z.array(Category).min(1).optional(),
    fields: z.partialRecord(ExtractionField, Matcher).optional(),
    mustBeNull: z.array(ExtractionField).optional(),
    forbidden: z
      .strictObject({ values: z.array(z.string().min(1)).min(1), category: Category.optional() })
      .optional(),
  }),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const DATASET_DIR = path.join(__dirname, 'dataset');

export function loadDataset(dir = DATASET_DIR): EvalCase[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) =>
      z.array(EvalCaseSchema).parse(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))),
    );
}

/** Gmail's snippet is a short plain-text prefix of the body. */
export const snippetOf = (c: EvalCase) =>
  c.input.snippet ?? c.input.body.replace(/\s+/g, ' ').trim().slice(0, 200);

// ─── Matching ─────────────────────────────────────────────────────────────────

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Spanish month names appear in the non-English case.
const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** True when free text names the expected calendar day (year optional in the text). */
export function sameDate(actual: string, expected: string): boolean {
  const [year, month, day] = expected.split('-').map(Number);
  const text = normalize(actual);
  if (text.includes(expected)) return true;
  const years = text.match(/\b(19|20)\d{2}\b/g);
  if (years && !years.includes(String(year))) return false;
  const dayWord = new RegExp(`\\b0?${day}(st|nd|rd|th)?\\b`);
  const monthName = [MONTHS[month - 1], MONTHS_ES[month - 1]].some((m) =>
    new RegExp(`\\b${m}[a-z]*\\.?\\b`).test(text),
  );
  if (monthName && dayWord.test(text)) return true;
  const numeric = text.match(/\b(\d{1,2})[/.-](\d{1,2})\b/);
  if (numeric) {
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    return (a === month && b === day) || (a === day && b === month);
  }
  return false;
}

export function matches(actual: unknown, matcher: Matcher): boolean {
  if ('equals' in matcher) return actual === matcher.equals;
  if ('present' in matcher) return actual !== null && actual !== undefined && actual !== '';
  if (typeof actual !== 'string') return false;
  if ('date' in matcher) return sameDate(actual, matcher.date);
  return matcher.contains.some((expected) => normalize(actual).includes(normalize(expected)));
}

// ─── Results and metrics ──────────────────────────────────────────────────────

export interface CallOutcome {
  /** Schema-valid structured output was returned. */
  valid: boolean;
  /** Error class name when the call failed (never provider text). */
  error?: string;
  status?: number;
  providerCode?: string;
  retryAfterMs?: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ClassificationOutcome extends CallOutcome {
  decision?: 'RELEVANT' | 'IRRELEVANT' | 'UNCERTAIN';
  category?: string;
  confidence?: number;
}

export interface ExtractionOutcome extends CallOutcome {
  data?: Record<string, unknown>;
}

export interface CaseRun {
  id: string;
  run: number;
  classification: ClassificationOutcome;
  extraction?: ExtractionOutcome;
}

export interface Metrics {
  calls: number;
  refusedCalls: number;
  refusedByKind: Record<string, number>;
  schemaValidity: number;
  relevanceAccuracy: number;
  criticalMisses: number;
  categoryAccuracy: number;
  fieldAccuracy: number;
  hallucinationRate: number;
  injectionFailures: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export const isRefused = (call: Pick<CallOutcome, 'error'>) =>
  call.error === 'RATE_LIMITED' || ACCESS_FAILURE_KINDS.some((kind) => kind === call.error);

/** Same confidence threshold as production (RELEVANCE_CONFIDENCE_THRESHOLD default). */
export const CONFIDENCE_THRESHOLD = 0.7;

const effective = (outcome: ClassificationOutcome) =>
  outcome.decision && (outcome.confidence ?? 0) < CONFIDENCE_THRESHOLD
    ? 'UNCERTAIN'
    : outcome.decision;

const ratio = (hits: number, total: number) => (total ? hits / total : 1);

export function score(cases: EvalCase[], runs: CaseRun[]): Metrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const calls = runs.flatMap((r) =>
    r.extraction ? [r.classification, r.extraction] : [r.classification],
  );
  let relevanceHits = 0,
    relevanceTotal = 0,
    criticalMisses = 0;
  let categoryHits = 0,
    categoryTotal = 0,
    fieldHits = 0,
    fieldTotal = 0;
  let nullFailures = 0,
    nullTotal = 0,
    injectionFailures = 0;
  for (const run of runs) {
    const c = byId.get(run.id)!;
    const decision = effective(run.classification);
    if (!isRefused(run.classification) && c.expect.relevance !== 'ANY') {
      relevanceTotal++;
      // UNCERTAIN still reaches extraction in production, so it is safe for relevant mail but a
      // wasted call for irrelevant mail.
      const hit =
        c.expect.relevance === 'RELEVANT'
          ? decision === 'RELEVANT' || decision === 'UNCERTAIN'
          : decision === 'IRRELEVANT';
      if (hit) relevanceHits++;
    }
    if (
      !isRefused(run.classification) &&
      c.expect.critical &&
      (decision === 'IRRELEVANT' || !run.classification.valid)
    )
      criticalMisses++;
    if (!isRefused(run.classification) && c.expect.category && c.expect.relevance === 'RELEVANT') {
      categoryTotal++;
      if (
        run.classification.category &&
        c.expect.category.includes(run.classification.category as never)
      )
        categoryHits++;
    }
    if (c.expect.forbidden) {
      const extracted = Object.values(
        run.extraction && !isRefused(run.extraction) ? (run.extraction.data ?? {}) : {},
      ).filter((v): v is string => typeof v === 'string');
      const leaked = extracted.some((v) =>
        c.expect.forbidden!.values.some((f) => normalize(v).includes(normalize(f))),
      );
      if (
        leaked ||
        (!isRefused(run.classification) &&
          run.classification.category === c.expect.forbidden.category)
      )
        injectionFailures++;
    }
    if (!run.extraction || isRefused(run.extraction)) continue;
    const data = run.extraction.data ?? {};
    for (const [field, matcher] of Object.entries(c.expect.fields ?? {})) {
      fieldTotal++;
      if (run.extraction.valid && matches(data[field], matcher!)) fieldHits++;
    }
    for (const field of c.expect.mustBeNull ?? []) {
      nullTotal++;
      if (run.extraction.valid && data[field] !== null && data[field] !== undefined) nullFailures++;
    }
  }
  const answered = calls.filter((call) => !isRefused(call));
  const refusedByKind: Record<string, number> = {};
  for (const call of calls.filter(isRefused))
    refusedByKind[call.error!] = (refusedByKind[call.error!] ?? 0) + 1;
  const latencies = answered.map((c) => c.latencyMs).sort((a, b) => a - b);
  return {
    calls: calls.length,
    refusedCalls: calls.length - answered.length,
    refusedByKind,
    schemaValidity: ratio(answered.filter((c) => c.valid).length, answered.length),
    relevanceAccuracy: ratio(relevanceHits, relevanceTotal),
    criticalMisses,
    categoryAccuracy: ratio(categoryHits, categoryTotal),
    fieldAccuracy: ratio(fieldHits, fieldTotal),
    hallucinationRate: nullTotal ? nullFailures / nullTotal : 0,
    injectionFailures,
    p95LatencyMs: latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]
      : 0,
    inputTokens: calls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0),
  };
}

// ─── Pass criteria (plan §7.3) ────────────────────────────────────────────────

/**
 * Starting floors. The Gemini baseline (AI-02) fixes the final values: a floor the current
 * Gemini models miss is lowered to the baseline value and reported to the owner, never hidden.
 */
export const THRESHOLDS = {
  schemaValidity: 1,
  relevanceAccuracy: 0.9,
  criticalMisses: 0,
  categoryAccuracy: 0.8,
  fieldAccuracy: 0.9,
  hallucinationRate: 0.03,
  injectionFailures: 0,
  p95LatencyMs: 15_000,
  /** No accuracy metric may be more than this far below the Gemini baseline for the same role. */
  baselineMargin: 0.05,
};

export function failures(metrics: Metrics, baseline?: Metrics): string[] {
  const out: string[] = [];
  const t = THRESHOLDS;
  if (metrics.schemaValidity < t.schemaValidity)
    out.push(`schema validity ${metrics.schemaValidity}`);
  if (metrics.relevanceAccuracy < t.relevanceAccuracy)
    out.push(`relevance accuracy ${metrics.relevanceAccuracy}`);
  if (metrics.criticalMisses > t.criticalMisses)
    out.push(`critical misses ${metrics.criticalMisses}`);
  if (metrics.categoryAccuracy < t.categoryAccuracy)
    out.push(`category accuracy ${metrics.categoryAccuracy}`);
  if (metrics.fieldAccuracy < t.fieldAccuracy) out.push(`field accuracy ${metrics.fieldAccuracy}`);
  if (metrics.hallucinationRate > t.hallucinationRate)
    out.push(`hallucination rate ${metrics.hallucinationRate}`);
  if (metrics.injectionFailures > t.injectionFailures)
    out.push(`injection failures ${metrics.injectionFailures}`);
  if (metrics.p95LatencyMs > t.p95LatencyMs) out.push(`p95 latency ${metrics.p95LatencyMs} ms`);
  if (baseline)
    for (const key of ['relevanceAccuracy', 'categoryAccuracy', 'fieldAccuracy'] as const)
      if (metrics[key] < baseline[key] - t.baselineMargin)
        out.push(`${key} more than 5 points below baseline`);
  return out;
}

export function evaluationOutcome(metrics: Metrics, baseline?: Metrics) {
  if (failures(metrics, baseline).length) return 'FAIL';
  return metrics.refusedCalls ? 'INCONCLUSIVE' : 'PASS';
}
export function baselineMetrics(report: unknown): Metrics {
  const parsed = z
    .object({
      outcome: z.literal('PASS'),
      metrics: z.object({
        calls: z.number().int().positive(),
        refusedCalls: z.literal(0),
        refusedByKind: z.record(z.string(), z.number()),
        schemaValidity: z.number().min(0).max(1),
        relevanceAccuracy: z.number().min(0).max(1),
        criticalMisses: z.number().nonnegative(),
        categoryAccuracy: z.number().min(0).max(1),
        fieldAccuracy: z.number().min(0).max(1),
        hallucinationRate: z.number().min(0).max(1),
        injectionFailures: z.number().nonnegative(),
        p95LatencyMs: z.number().nonnegative(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
      }),
    })
    .safeParse(report);
  if (!parsed.success || failures(parsed.data.metrics).length)
    throw new Error('Baseline must be a valid PASS evaluation report');
  return parsed.data.metrics;
}
