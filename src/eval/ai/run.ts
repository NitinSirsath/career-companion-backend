import { temporalCases, scoreTemporal } from './temporal';
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
  mapBatchResults,
  EXTRACTION_BODY_LIMIT,
} from '../../services/ai/contracts';
import { evaluateCall } from './call';
import { createProviderClient } from '../../services/ai/providers';
import {
  CaseRun,
  THRESHOLDS,
  baselineMetrics,
  evaluationOutcome,
  isRefused,
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

async function main() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('The AI evaluation runner never runs in production');
  const providerId = option('provider') ?? '';
  const provider = getCatalogProvider(providerId);
  const fast = option('fast');
  const detailed = option('detailed');
  const runs = Number(option('runs') ?? 2);
  const delayMs = Number(option('delay-ms') ?? 0);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 120000)
    throw new Error('--delay-ms must be 0-120000');
  const timed = <T>(call: () => Promise<T>) => evaluateCall(call, { delayMs });
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
  const baseline = baselineFile
    ? baselineMetrics(JSON.parse(fs.readFileSync(baselineFile, 'utf8')))
    : undefined;

  const triageMode = option('triage') ?? 'single';
  if (!['single', 'batch'].includes(triageMode))
    throw new Error('--triage must be single or batch');
  const batchSize = Number(option('batch-size') ?? 20);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 25)
    throw new Error('--batch-size must be 1-25');

  const extractionVersion = option('extraction-version') ?? 'extraction/v2';
  if (!['extraction/v2', 'extraction/v3'].includes(extractionVersion))
    throw new Error('Unsupported extraction version');
  const cases = [...loadDataset(), ...(extractionVersion === 'extraction/v3' ? temporalCases : [])];
  const models = { fast: catalogModel('fast', fast), detailed: catalogModel('detailed', detailed) };
  const ai = bindCapabilities(createProviderClient(provider, apiKey), models);
  const results: CaseRun[] = [];
  if (triageMode === 'batch') {
    evaluation: for (let run = 1; run <= runs; run++) {
      const ordered = [...cases];
      let seed = (125 + run) >>> 0;
      for (let i = ordered.length - 1; i > 0; i--) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
      for (let offset = 0; offset < ordered.length; offset += batchSize) {
        const group = ordered.slice(offset, offset + batchSize);
        const classified = await timed(() =>
          ai.classifier.classifyRelevanceBatch({
            items: group.map((c, index) => ({
              key: `e${index + 1}`,
              sender: c.input.sender.slice(0, LIMITS.sender),
              subject: c.input.subject.slice(0, LIMITS.subject),
              labels: c.input.labels.slice(0, LIMITS.labels),
              snippet: snippetOf(c).slice(0, LIMITS.snippet),
            })),
          }),
        );
        const mapped = classified.value
          ? mapBatchResults(
              group.map((_c, index) => `e${index + 1}`),
              classified.value.data.results,
            )
          : null;
        for (let index = 0; index < group.length; index++) {
          const c = group[index];
          const item = mapped?.decided.get(`e${index + 1}`);
          results.push({
            id: c.id,
            run,
            classification: {
              valid: !!item,
              error: classified.error,
              status: classified.status,
              providerCode: classified.providerCode,
              retryAfterMs: classified.retryAfterMs,
              latencyMs: classified.latencyMs,
              inputTokens: classified.value?.usage.inputTokens ?? null,
              outputTokens: classified.value?.usage.outputTokens ?? null,
              decision: item?.decision,
              category: item?.category ?? undefined,
              confidence: item?.confidence,
            },
          });
        }
        if (classified.error) break evaluation;
      }
    }
  } else {
    evaluation: for (let run = 1; run <= runs; run++) {
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
            status: classified.status,
            providerCode: classified.providerCode,
            retryAfterMs: classified.retryAfterMs,
            latencyMs: classified.latencyMs,
            inputTokens: classified.value?.usage.inputTokens ?? null,
            outputTokens: classified.value?.usage.outputTokens ?? null,
            decision: classified.value?.data.decision,
            category: classified.value?.data.category,
            confidence: classified.value?.data.confidence,
          },
        };
        if (isRefused(result.classification)) {
          results.push(result);
          break evaluation;
        }
        if (c.expect.relevance !== 'IRRELEVANT') {
          const extracted = await timed(() =>
            ai.analyzer.extractJobData(c.input.body.slice(0, EXTRACTION_BODY_LIMIT), {
              version: extractionVersion,
              receivedAt: c.input.receivedAt ?? null,
            }),
          );
          result.extraction = {
            valid: !!extracted.value,
            error: extracted.error,
            status: extracted.status,
            providerCode: extracted.providerCode,
            retryAfterMs: extracted.retryAfterMs,
            latencyMs: extracted.latencyMs,
            inputTokens: extracted.value?.usage.inputTokens ?? null,
            outputTokens: extracted.value?.usage.outputTokens ?? null,
            data: extracted.value?.data,
          };
        }
        results.push(result);
        if (result.extraction && isRefused(result.extraction)) break evaluation;
        process.stdout.write('.');
      }
    }
  }
  process.stdout.write('\n');

  const metrics = score(cases, results);
  const failed = failures(metrics, baseline);
  const temporal = extractionVersion === 'extraction/v3' ? scoreTemporal(results, runs) : null;
  const baseOutcome = evaluationOutcome(metrics, baseline);
  const outcome =
    baseOutcome === 'INCONCLUSIVE' || temporal?.outcome === 'INCONCLUSIVE'
      ? 'INCONCLUSIVE'
      : baseOutcome === 'FAIL' || temporal?.outcome === 'FAIL'
        ? 'FAIL'
        : 'PASS';
  const createdAt = new Date().toISOString();
  const report = {
    createdAt,
    provider: provider.id,
    models: { fast: models.fast.id, detailed: models.detailed.id },
    runs,
    cases: cases.length,
    contractVersions: { ...AI_CONTRACT_VERSIONS, EXTRACTION: extractionVersion },
    temporal,
    thresholds: THRESHOLDS,
    baseline: baselineFile ? path.basename(baselineFile) : null,
    metrics,
    outcome,
    passed: outcome === 'PASS',
    failures: failed,
    results,
  };
  const safe = (value: string) => value.replace(/[^a-z0-9.-]+/gi, '_');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(
    REPORTS_DIR,
    `${createdAt.replace(/[:.]/g, '-')}_${safe(provider.id)}_${safe(models.fast.id)}_${safe(models.detailed.id)}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.table(metrics);
  console.log(
    `${outcome}: ${metrics.refusedCalls} calls refused (${JSON.stringify(metrics.refusedByKind)})${failed.length ? '; ' + failed.join('; ') : ''}`,
  );
  console.log(`Report: ${path.relative(process.cwd(), file)}`);
  process.exitCode = outcome === 'PASS' ? 0 : outcome === 'FAIL' ? 1 : 2;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Evaluation failed');
  process.exitCode = 1;
});
