/**
 * Manual provider/model evaluation (BYO AI plan §7). Runs the synthetic dataset through the same
 * contracts, adapters and validation as production. No database, ledger, queue or Gmail access.
 *
 *   AI_EVAL_API_KEY=… npm run ai:eval -- --provider gemini --fast <model> --detailed <model> [--runs 2] [--baseline <report.json>]
 *
 * The key comes from the shell only. Reports contain synthetic data, metrics and error class names
 * (never provider text) and are written to src/eval/ai/reports/.
 */
import fs from 'fs';
import path from 'path';
import { AIRole, getCatalogProvider } from '../../contracts/aiCatalog';
import { bindCapabilities } from '../../services/ai/capabilities';
import {
  AI_CONTRACT_VERSIONS,
  CLASSIFICATION_INPUT_LIMITS as LIMITS,
  EXTRACTION_BODY_LIMIT,
} from '../../services/ai/contracts';
import { ProviderFailure } from '../../services/ai/errors';
import { createProviderClient } from '../../services/ai/providers';
import {
  CallOutcome,
  CaseRun,
  Metrics,
  THRESHOLDS,
  failures,
  loadDataset,
  score,
  snippetOf,
} from './score';

const REPORTS_DIR = path.join(__dirname, 'reports');

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function timed<T>(call: () => Promise<T>): Promise<{ value?: T } & Omit<CallOutcome, 'valid' | 'inputTokens' | 'outputTokens'>> {
  const started = Date.now();
  try {
    return { value: await call(), latencyMs: Date.now() - started };
  } catch (err) {
    const error = err instanceof ProviderFailure ? err.kind : err instanceof Error ? err.name : 'UnknownError';
    return { error, latencyMs: Date.now() - started };
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The AI evaluation runner never runs in production');
  const providerId = option('provider') ?? '';
  const provider = getCatalogProvider(providerId);
  const fast = option('fast');
  const detailed = option('detailed');
  const runs = Number(option('runs') ?? 2);
  const apiKey = process.env.AI_EVAL_API_KEY;
  if (!provider) throw new Error('--provider must be a catalog provider');
  // Only catalog models are evaluated: candidates are added as hidden catalog entries first.
  const catalogModel = (role: AIRole, id?: string) => {
    const model = provider.models.find((m) => m.id === id && m.roles.includes(role));
    if (!model) throw new Error(`--${role} must be a ${provider.id} catalog model for that role`);
    return model;
  };
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('--runs must be 1-5');
  if (!apiKey) throw new Error('Set AI_EVAL_API_KEY in the shell (never in an .env file)');
  const baselineFile = option('baseline');
  const baseline: Metrics | undefined = baselineFile
    ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')).metrics
    : undefined;

  const cases = loadDataset();
  const models = { fast: catalogModel('fast', fast), detailed: catalogModel('detailed', detailed) };
  const ai = bindCapabilities(createProviderClient(provider, apiKey), models);
  const results: CaseRun[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const c of cases) {
      const classified = await timed(() =>
        ai.classifier.classifyRelevance({
          sender: c.input.sender.slice(0, LIMITS.sender),
          subject: c.input.subject.slice(0, LIMITS.subject),
          labels: c.input.labels.slice(0, LIMITS.labels),
          snippet: snippetOf(c).slice(0, LIMITS.snippet),
        }),
      );
      const result: CaseRun = {
        id: c.id,
        run,
        classification: {
          valid: !!classified.value,
          error: classified.error,
          latencyMs: classified.latencyMs,
          inputTokens: classified.value?.usage.inputTokens ?? null,
          outputTokens: classified.value?.usage.outputTokens ?? null,
          decision: classified.value?.data.decision,
          category: classified.value?.data.category,
          confidence: classified.value?.data.confidence,
        },
      };
      // Extraction quality is measured independently of the classification outcome.
      if (c.expect.relevance !== 'IRRELEVANT') {
        const extracted = await timed(() => ai.analyzer.extractJobData(c.input.body.slice(0, EXTRACTION_BODY_LIMIT)));
        result.extraction = {
          valid: !!extracted.value,
          error: extracted.error,
          latencyMs: extracted.latencyMs,
          inputTokens: extracted.value?.usage.inputTokens ?? null,
          outputTokens: extracted.value?.usage.outputTokens ?? null,
          data: extracted.value?.data,
        };
      }
      results.push(result);
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');

  const metrics = score(cases, results);
  const failed = failures(metrics, baseline);
  const createdAt = new Date().toISOString();
  const report = {
    createdAt,
    provider: provider.id,
    models: { fast: models.fast.id, detailed: models.detailed.id },
    runs,
    cases: cases.length,
    contractVersions: AI_CONTRACT_VERSIONS,
    thresholds: THRESHOLDS,
    baseline: baselineFile ? path.basename(baselineFile) : null,
    metrics,
    passed: failed.length === 0,
    failures: failed,
    results,
  };
  const safe = (value: string) => value.replace(/[^a-z0-9.-]+/gi, '_');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(
    REPORTS_DIR,
    `${createdAt.slice(0, 10)}_${safe(provider.id)}_${safe(models.fast.id)}_${safe(models.detailed.id)}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.table(metrics);
  console.log(failed.length ? `FAIL: ${failed.join('; ')}` : 'PASS');
  console.log(`Report: ${path.relative(process.cwd(), file)}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Evaluation failed');
  process.exitCode = 1;
});
