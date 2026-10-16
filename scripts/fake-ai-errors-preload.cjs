// Loaded by `npm run fake-ai-errors` into the dev-mode server, before the app. It swaps the AI
// libraries' calls for fakes that answer with the chosen error (src/tests/helpers/fakeAiErrors.ts)
// and blocks every request to an AI provider, so nothing is sent. The app's own code is unchanged.
// It refuses to load unless the app mode is dev.
const { appMode } = require('../src/utils/config');

function refuse(message) {
  console.error(`fake-ai-errors: ${message}`);
  process.exit(1);
}

if (appMode() !== 'dev')
  refuse('refused: the app is not in dev mode. Fake AI errors never run in prod.');

const {
  blockProviderRequests,
  fakeAiAnswers,
  isFakeAiError,
} = require('../src/tests/helpers/fakeAiErrors');

const fault = process.env.FAKE_AI_ERROR;
if (!isFakeAiError(fault)) refuse(`unknown fault "${fault}". Start with npm run fake-ai-errors.`);

globalThis.fetch = blockProviderRequests(globalThis.fetch);
const answers = fakeAiAnswers(fault);

// Gemini sets its calls on each client, so every new client gets the fake call.
const genai = require('@google/genai');
const { GoogleGenAI } = genai;
genai.GoogleGenAI = class FakeGoogleGenAI extends GoogleGenAI {
  constructor(options) {
    super(options);
    this.models.generateContent = answers.gemini.generateContent;
  }
};
// OpenAI and Anthropic keep their calls on shared classes.
const { OpenAI } = require('openai');
OpenAI.Chat.Completions.prototype.create = answers.openai.create;
OpenAI.Models.prototype.retrieve = answers.openai.retrieve;
const { Anthropic } = require('@anthropic-ai/sdk');
Anthropic.Messages.prototype.create = answers.anthropic.create;
Anthropic.Models.prototype.retrieve = answers.anthropic.retrieve;

console.log(
  `fake-ai-errors: every AI call answers "${fault}". Nothing is sent to any AI provider.`,
);
