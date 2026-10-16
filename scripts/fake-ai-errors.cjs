// `npm run fake-ai-errors -- <fault>`: starts dev mode with every AI call answered by one chosen
// fake error, to test the AI error screens without a provider. Nothing is sent to any AI
// provider. `npm run devmode` itself stays real AI only. See README, "Testing AI error screens".
const path = require('node:path');
// Loading devmode.cjs also lets this script read the TypeScript sources.
const { runDevMode } = require('./devmode.cjs');
const { FAKE_AI_ERRORS, isFakeAiError } = require('../src/tests/helpers/fakeAiErrors');

function stop(message) {
  console.error(`fake-ai-errors: ${message}`);
  process.exit(1);
}

const fault = process.argv[2];
if (!isFakeAiError(fault)) {
  const faults = Object.entries(FAKE_AI_ERRORS).map(
    ([name, what]) => `  ${name.padEnd(15)}${what}`,
  );
  stop(['choose one fault: npm run fake-ai-errors -- <fault>', ...faults].join('\n'));
}
// Dev mode checks .env.dev, and the server checks the app mode again before it fakes anything.
if (process.env.NODE_ENV === 'production')
  stop('refused: NODE_ENV is production. Fake AI errors never run in prod.');

process.env.FAKE_AI_ERROR = fault;
runDevMode(path.join(__dirname, 'fake-ai-errors-preload.cjs')).catch((err) => stop(err.message));
