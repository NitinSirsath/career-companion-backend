/**
 * Career Companion's curated AI provider and model catalog (ADR-0001 decision 2).
 *
 * Code-defined and changed only through a release. Shared with the frontend by the contract sync,
 * so there is no catalog endpoint. Users choose only from this list: no free-form model names,
 * endpoints, base URLs or headers. A provider is offered in production only when `status` is
 * `supported`, which requires a passing evaluation for each offered model and an owner-approved
 * data-use disclosure (`disclosure.reviewedOn`). Hidden providers are usable in development and
 * tests so they can be built and evaluated.
 */

export const AI_ROLES = ['fast', 'detailed'] as const;
/** `fast` runs relevance screening; `detailed` runs job-data extraction. */
export type AIRole = (typeof AI_ROLES)[number];

export const AI_PROVIDER_IDS = ['gemini', 'openai', 'anthropic'] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface CatalogModel {
  id: string;
  displayName: string;
  roles: readonly AIRole[];
  recommendedFor: readonly AIRole[];
  /** null = the model does not accept a temperature; the adapter omits it. */
  temperature: number | null;
  /** Reasoning or thinking kept at the minimum the model allows. */
  reasoning:
    | { thinkingBudget: number }
    | { thinkingLevel: 'minimal' | 'low' }
    | { reasoningEffort: 'minimal' | 'low' }
    | null;
  structuredOutput: 'gemini_schema' | 'openai_json_schema' | 'anthropic_native' | 'anthropic_tool';
  timeoutMs: number;
  /** YYYY-MM-DD. After this day the model is no longer offered or used. */
  retiresOn: string | null;
  /** Passing evaluation report; required for every model of a supported provider. */
  evaluation: { date: string; report: string } | null;
}

export interface CatalogProvider {
  id: AIProviderId;
  displayName: string;
  protocol: 'gemini' | 'openai' | 'anthropic';
  /** Fixed endpoint. No user input ever decides where a key or email content is sent. */
  baseUrl: string;
  status: 'supported' | 'hidden';
  costModel: 'FREE_TIER_AVAILABLE' | 'PAID_ONLY';
  recommendedNote: string;
  links: { apiKeys: string; billing: string; dataUse: string };
  setupSteps: readonly string[];
  disclosure: {
    /** Recorded with each user's consent. Change it whenever the text changes. */
    version: string;
    summary: string;
    training: string;
    residency: string;
    /** Date the owner approved this text against the provider's current terms; null = draft. */
    reviewedOn: string | null;
  };
  models: readonly CatalogModel[];
}

export const AI_SUBSCRIPTION_NOTE =
  'A ChatGPT, Claude or Gemini app subscription is not an API key. Each provider issues API keys separately; the setup steps link to the right page.';

/** What Career Companion sends to the chosen provider (shown before consent). */
export const AI_DATA_SENT_SUMMARY =
  'For each new email: sender, subject, Gmail labels and a short preview (up to 1,000 characters). For job-related emails, also the email text (up to 8,000 characters). Nothing else from your mailbox is sent.';

export const AI_CATALOG: readonly CatalogProvider[] = [
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    status: 'hidden',
    costModel: 'FREE_TIER_AVAILABLE',
    recommendedNote: 'Quickest start: a free tier is available.',
    links: {
      apiKeys: 'https://aistudio.google.com/apikey',
      billing: 'https://ai.google.dev/gemini-api/docs/billing',
      dataUse: 'https://ai.google.dev/gemini-api/terms',
    },
    setupSteps: [
      'Sign in to Google AI Studio with your Google account.',
      'Choose "Create API key" and copy the key.',
      'Paste the key below. Career Companion stores it encrypted and never shows it again.',
      'Optional: turn on billing in Google AI Studio to move from the free tier to paid usage.',
    ],
    disclosure: {
      version: 'gemini-draft-2026-10',
      // DRAFT pending owner approval against Google's current Gemini API terms.
      summary:
        'Your emails are processed by Google under your own Gemini API account and its terms.',
      training:
        'On the free tier, Google may use what is sent to improve its products, and people may review it. With billing turned on, Google says it does not use it for that purpose.',
      residency:
        'Processed on Google infrastructure; Google does not offer a choice of region for this API.',
      reviewedOn: null,
    },
    models: [
      {
        id: 'gemini-2.5-flash-lite',
        displayName: 'Gemini 2.5 Flash-Lite',
        roles: ['fast'],
        recommendedFor: ['fast'],
        temperature: 0.1,
        reasoning: { thinkingBudget: 0 },
        structuredOutput: 'gemini_schema',
        timeoutMs: 30_000,
        retiresOn: null,
        evaluation: null,
      },
      {
        id: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        roles: ['fast', 'detailed'],
        recommendedFor: ['detailed'],
        temperature: 0.1,
        reasoning: { thinkingBudget: 0 },
        structuredOutput: 'gemini_schema',
        timeoutMs: 30_000,
        retiresOn: null,
        evaluation: null,
      },
      // Google limits 2.5 models to projects that used them before; new keys need these.
      // Gemini 3 models keep their default temperature and cannot turn thinking off.
      {
        id: 'gemini-3.5-flash-lite',
        displayName: 'Gemini 3.5 Flash-Lite',
        roles: ['fast'],
        recommendedFor: [],
        temperature: null,
        reasoning: { thinkingLevel: 'minimal' },
        structuredOutput: 'gemini_schema',
        timeoutMs: 30_000,
        retiresOn: null,
        evaluation: null,
      },
      {
        id: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        roles: ['fast', 'detailed'],
        recommendedFor: [],
        temperature: null,
        reasoning: { thinkingLevel: 'low' },
        structuredOutput: 'gemini_schema',
        timeoutMs: 60_000,
        retiresOn: null,
        evaluation: null,
      },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    status: 'hidden',
    costModel: 'PAID_ONLY',
    recommendedNote: 'Good if you already pay for the OpenAI API.',
    links: {
      apiKeys: 'https://platform.openai.com/api-keys',
      billing: 'https://platform.openai.com/settings/organization/billing/overview',
      dataUse: 'https://platform.openai.com/docs/guides/your-data',
    },
    setupSteps: [
      'Sign in to the OpenAI Platform. This is separate from a ChatGPT subscription.',
      'Add a payment method or credit under Billing.',
      'Create a secret key under "API keys" and copy it.',
      'Paste the key below. Career Companion stores it encrypted and never shows it again.',
    ],
    disclosure: {
      version: 'openai-draft-2026-10',
      // DRAFT pending owner approval against OpenAI's current API data-use terms.
      summary: 'Your emails are processed by OpenAI under your own API account and its terms.',
      training:
        'OpenAI says it does not use API data to train its models unless you opt in. It may keep it for a limited time to monitor abuse.',
      residency:
        'Processed by OpenAI in the United States by default; regional processing is offered to some business accounts.',
      reviewedOn: null,
    },
    // Candidates pending evaluation (AI-15): small current models with strict structured output.
    models: [
      {
        id: 'gpt-5-nano',
        displayName: 'GPT-5 nano',
        roles: ['fast'],
        recommendedFor: ['fast'],
        temperature: null,
        reasoning: { reasoningEffort: 'minimal' },
        structuredOutput: 'openai_json_schema',
        timeoutMs: 30_000,
        retiresOn: null,
        evaluation: null,
      },
      {
        id: 'gpt-5-mini',
        displayName: 'GPT-5 mini',
        roles: ['fast', 'detailed'],
        recommendedFor: ['detailed'],
        temperature: null,
        reasoning: { reasoningEffort: 'minimal' },
        structuredOutput: 'openai_json_schema',
        timeoutMs: 45_000,
        retiresOn: null,
        evaluation: null,
      },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    status: 'hidden',
    costModel: 'PAID_ONLY',
    recommendedNote: 'Good if you already pay for the Claude API.',
    links: {
      apiKeys: 'https://console.anthropic.com/settings/keys',
      billing: 'https://console.anthropic.com/settings/billing',
      dataUse: 'https://www.anthropic.com/legal/commercial-terms',
    },
    setupSteps: [
      'Sign in to the Anthropic Console. This is separate from a Claude app subscription.',
      'Add credit or a payment method under Billing.',
      'Create an API key under "API keys" and copy it.',
      'Paste the key below. Career Companion stores it encrypted and never shows it again.',
    ],
    disclosure: {
      version: 'anthropic-draft-2026-10',
      // DRAFT pending owner approval against Anthropic's current commercial and API data terms.
      summary: 'Your emails are processed by Anthropic under your own API account and its terms.',
      training:
        'Anthropic says it does not train its models on API data by default. It may keep it for a limited time for safety monitoring.',
      residency:
        "Processed on Anthropic's infrastructure; see Anthropic's terms for where data is processed.",
      reviewedOn: null,
    },
    // Candidates pending evaluation (AI-15).
    models: [
      {
        id: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        roles: ['fast', 'detailed'],
        recommendedFor: ['fast', 'detailed'],
        temperature: 0.1,
        reasoning: null,
        structuredOutput: 'anthropic_tool',
        timeoutMs: 30_000,
        retiresOn: null,
        evaluation: null,
      },
      {
        id: 'claude-sonnet-5-5',
        displayName: 'Claude Sonnet 5.5',
        roles: ['detailed'],
        recommendedFor: [],
        temperature: null,
        reasoning: null,
        structuredOutput: 'anthropic_native',
        timeoutMs: 60_000,
        retiresOn: null,
        evaluation: null,
      },
    ],
  },
];

export function getCatalogProvider(id: string): CatalogProvider | undefined {
  return AI_CATALOG.find((provider) => provider.id === id);
}

/** Today's date (UTC) in the catalog's YYYY-MM-DD form. */
export const catalogDay = (now: Date = new Date()) => now.toISOString().slice(0, 10);

export const isRetired = (model: CatalogModel, day: string) =>
  model.retiresOn !== null && day > model.retiresOn;

/** The models a user may choose for a role: current, catalog-defined, never free-form. */
export function modelsForRole(
  provider: CatalogProvider,
  role: AIRole,
  day: string,
): CatalogModel[] {
  return provider.models.filter((model) => model.roles.includes(role) && !isRetired(model, day));
}

export function recommendedModel(provider: CatalogProvider, role: AIRole): CatalogModel {
  const model = provider.models.find((m) => m.recommendedFor.includes(role));
  if (!model) throw new Error(`Catalog provider ${provider.id} has no recommended ${role} model`);
  return model;
}

export type ModelSource = 'RECOMMENDED' | 'SELECTED' | 'REPLACED_RETIRED';

/**
 * The model a configuration uses for a role. null follows the recommendation. A selection that
 * left the catalog or is past retirement falls back to the recommendation and says so; the
 * provider itself never changes without the user.
 */
export function resolveModel(
  provider: CatalogProvider,
  role: AIRole,
  selectedId: string | null,
  day: string,
): { model: CatalogModel; source: ModelSource } {
  if (selectedId === null)
    return { model: recommendedModel(provider, role), source: 'RECOMMENDED' };
  const selected = modelsForRole(provider, role, day).find((m) => m.id === selectedId);
  return selected
    ? { model: selected, source: 'SELECTED' }
    : { model: recommendedModel(provider, role), source: 'REPLACED_RETIRED' };
}
