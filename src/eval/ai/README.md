# AI provider evaluation

Synthetic evaluation of a provider/model pair against Career Companion's AI contracts (BYO AI plan §7).

```bash
AI_EVAL_API_KEY=<key> npm run ai:eval -- --provider <gemini|openai|anthropic> --fast <catalog model> --detailed <catalog model> [--runs 2] [--baseline <report.json>]
```

- `dataset/` holds synthetic emails only. Use fictitious people and companies and reserved domains (`example.com`, `example.org`, `example.net`, `*.test`). The dataset test enforces the domains.
- `score.ts` holds the metrics and pass criteria. `eval.test.ts` covers them in CI, with no network.
- `run.ts` is the manual runner. It uses the production adapters and contracts and touches no database, Gmail or ledger.
- `reports/` holds committed run reports: synthetic data, metrics and error kinds only.

Never put a real key in a file. Results and the certification checklist live in the docs repo: `docs/ai/provider-evaluation.md`.

Evaluation reports distinguish `PASS`, `FAIL` and `INCONCLUSIVE` (exit 0/1/2).
Quota/access refusals are counted separately and excluded from quality and latency;
invalid output and unknown outcomes still fail quality. An unanswered call ends
the run after at most three rate-limit waits (each no longer than 120 seconds).
`--delay-ms 0..120000` paces calls. Unknown/invalid paid outcomes are never repeated.
Only a valid PASS report with zero refused calls can be a baseline. Reports have
unique timestamp filenames and cannot overwrite prior evidence.
