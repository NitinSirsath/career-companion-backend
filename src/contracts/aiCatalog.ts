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

export const AI_PROVIDER_IDS = [
  'gemini',
  'openai',
  'anthropic',
  'openrouter',
  'career-companion',
] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface CatalogModel {
  id: string;
  displayName: string;
  roles: readonly AIRole[];
  recommendedFor: readonly AIRole[];
  /** null = the model does not accept a temperature; the adapter omits it. */
  temperature: number | null;
  /**
   * Reasoning or thinking kept at the minimum the model allows. OpenRouter: `{ enabled: false }`
   * turns optional thinking off; `{ effort: 'low' }` is for a model that always thinks.
   */
  reasoning:
    | { thinkingBudget: number }
    | { thinkingLevel: 'minimal' | 'low' }
    | { reasoningEffort: 'minimal' | 'low' }
    | { enabled: false }
    | { effort: 'low' }
    | null;
  structuredOutput: 'gemini_schema' | 'openai_json_schema' | 'anthropic_native' | 'anthropic_tool';
  timeoutMs: number;
  /** YYYY-MM-DD. After this day the model is no longer offered or used. */
  retiresOn: string | null;
  /** Passing evaluation report; required for every model of a supported provider. */
  evaluation: { date: string; report: string } | null;
  /**
   * OpenRouter only: the model's private servers take no output limit, so none is sent. The model
   * stops by itself; the strict JSON answer keeps it short.
   */
  noOutputLimit?: true;
}

export interface CatalogProvider {
  id: AIProviderId;
  displayName: string;
  protocol: 'gemini' | 'openai' | 'anthropic' | 'openrouter';
  /** Fixed endpoint. No user input ever decides where a key or email content is sent. */
  baseUrl: string;
  status: 'supported' | 'hidden';
  /**
   * `user`: the user's own key (ADR-0001). `career_companion`: the free AI, which runs on Career
   * Companion's own OpenRouter key (owner, 24 Oct 2026); the user has no key and no model choice.
   */
  keyOwner: 'user' | 'career_companion';
  costModel: 'FREE_TIER_AVAILABLE' | 'PAID_ONLY' | 'FREE';
  recommendedNote: string;
  /** No key or billing page for the free AI. */
  links: { apiKeys: string | null; billing: string | null; dataUse: string };
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

/**
 * What Career Companion sends to the chosen provider (shown before consent). The sentence on the
 * user's own replies and drafts is new (owner, 24 Oct 2026: the text changes, no new consent
 * prompt). Since 1 Nov 2026 the draft part also names the hint, the reply choice and the first
 * name a draft sends (`services/replyDraft.ts`), under the same rule.
 */
export const AI_DATA_SENT_SUMMARY =
  'For each new email: sender, subject, Gmail labels and a short preview (up to 1,000 characters). For job-related emails, also the email text (up to 8,000 characters). When a conversation still needs something from you, also the new text of your own replies in it. When you ask the AI to write a reply, the whole conversation, any hint you type or reply choice you click, and your first name. Nothing else from your mailbox is sent.';

const GPT_6_LUNA: CatalogModel = {
  id: 'openai/gpt-6-luna',
  displayName: 'GPT-6 Luna',
  roles: ['fast', 'detailed'],
  recommendedFor: ['fast', 'detailed'],
  temperature: null,
  reasoning: { enabled: false },
  structuredOutput: 'openai_json_schema',
  timeoutMs: 60_000,
  retiresOn: null,
  evaluation: {
    date: '2026-10-22',
    report:
      'src/eval/ai/reports/2026-10-22T19-22-12-192Z_openrouter_openai_gpt-6-luna_openai_gpt-6-luna.json',
  },
  noOutputLimit: true,
};

export const AI_CATALOG: readonly CatalogProvider[] = [
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    status: 'hidden',
    keyOwner: 'user',
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
      'Paste the key below. NorthList stores it encrypted and never shows it again.',
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
        recommendedFor: [],
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
        recommendedFor: [],
        temperature: 0.1,
        reasoning: { thinkingBudget: 0 },
        structuredOutput: 'gemini_schema',
        timeoutMs: 30_000,
        retiresOn: null,
        evaluation: null,
      },
      // Google serves the 2.5 models only to keys that used them before: a new key gets "not
      // found" for both, so the Gemini 3 models are the recommended ones.
      // Gemini 3 models keep their default temperature and cannot turn thinking off.
      {
        id: 'gemini-3.5-flash-lite',
        displayName: 'Gemini 3.5 Flash-Lite',
        roles: ['fast'],
        recommendedFor: ['fast'],
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
        recommendedFor: ['detailed'],
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
    keyOwner: 'user',
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
      'Paste the key below. NorthList stores it encrypted and never shows it again.',
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
    keyOwner: 'user',
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
      'Paste the key below. NorthList stores it encrypted and never shows it again.',
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
    // Candidates pending evaluation (AI-15). Native JSON output (Sonnet) allows at most 16 fields
    // that may be empty, fewer than extraction's 20: its evaluation must show it takes the schema.
    // A forced tool call (Haiku) is not strict, so that limit does not apply there.
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
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    status: 'supported',
    keyOwner: 'user',
    costModel: 'PAID_ONLY',
    recommendedNote:
      'One key for several small, low-cost models. Prepaid credit; small amounts work.',
    links: {
      apiKeys: 'https://openrouter.ai/settings/keys',
      billing: 'https://openrouter.ai/settings/credits',
      dataUse: 'https://openrouter.ai/privacy',
    },
    setupSteps: [
      'Sign in at openrouter.ai and add credit under Credits.',
      'Under Keys, create an API key (not a Management key). Give it a credit limit of at least $5, or none: GPT-6 Sol needs about $1.50 of the limit free for each request.',
      'Keep "Input & Output Logging" (workspace Observability) and the "1% data discount" (Privacy) turned off.',
      'Paste the key below. NorthList stores it encrypted and never shows it again.',
    ],
    disclosure: {
      version: 'openrouter-2026-10-23',
      summary:
        'Your emails go to OpenRouter under your own account. OpenRouter passes each request to one server that runs the model you chose.',
      training:
        'NorthList asks OpenRouter to use only servers that keep nothing, so they cannot train on it. OpenRouter says it does not train on it and keeps only usage numbers, unless you turn on prompt logging in your OpenRouter account.',
      residency:
        'OpenRouter is based in the US. Claude Haiku 5.5 and Gemini 3.8 Flash run on Google servers, and GPT-6 Luna and GPT-6 Sol on Microsoft Azure servers, in the US or Europe. OpenRouter picks the server for each request.',
      reviewedOn: '2026-10-23',
    },
    // Certified 2026-10-23 (owner decisions, docs/ai/provider-evaluation.md). Exact IDs only: an alias such
    // as "~…-latest" can move to another model without an evaluation. Haiku screens only: Anthropic's
    // JSON output allows at most 16 fields that may be empty, and extraction has 20. These private
    // servers take no temperature. Luna is recommended for both steps (owner, 2026-10-23): in a 49-mail
    // sandbox test it read the same mails right as Haiku + Gemini at a sixth of the cost, and Haiku let a
    // fake job offer through.
    models: [
      {
        id: 'anthropic/claude-haiku-5.5',
        displayName: 'Claude Haiku 5.5',
        roles: ['fast'],
        recommendedFor: [],
        temperature: null,
        reasoning: { enabled: false },
        structuredOutput: 'openai_json_schema',
        timeoutMs: 45_000,
        retiresOn: null,
        evaluation: {
          date: '2026-10-22',
          report:
            'src/eval/ai/reports/2026-10-22T19-22-55-385Z_openrouter_anthropic_claude-haiku-5.5_google_gemini-3.8-flash.json',
        },
      },
      // GPT-6 Luna and Sol run on Azure's private servers. They take no output limit, so none is
      // sent; OpenRouter then holds the worst case on the key's credit limit before each call (about
      // $0.07 for Luna, $1.30 for Sol). Azure's safety filter blocks an email that tries to give the
      // AI orders: the answer is unusable and the mail waits for the user (owner exception).
      GPT_6_LUNA,
      // Detailed only. It always thinks; under 60 s it sometimes gave no answer in time.
      {
        id: 'google/gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        roles: ['detailed'],
        recommendedFor: [],
        temperature: null,
        reasoning: { effort: 'low' },
        structuredOutput: 'openai_json_schema',
        timeoutMs: 90_000,
        retiresOn: null,
        evaluation: {
          date: '2026-10-22',
          report:
            'src/eval/ai/reports/2026-10-22T19-22-55-385Z_openrouter_anthropic_claude-haiku-5.5_google_gemini-3.8-flash.json',
        },
      },
      {
        id: 'openai/gpt-6-sol',
        displayName: 'GPT-6 Sol',
        roles: ['fast', 'detailed'],
        recommendedFor: [],
        temperature: null,
        reasoning: { enabled: false },
        structuredOutput: 'openai_json_schema',
        timeoutMs: 60_000,
        retiresOn: null,
        evaluation: {
          date: '2026-10-21',
          report:
            'src/eval/ai/reports/2026-10-21T12-02-39-117Z_openrouter_openai_gpt-6-sol_openai_gpt-6-sol.json',
        },
        noOutputLimit: true,
      },
    ],
  },
  // The free AI (owner, 24 Oct 2026): OpenRouter on Career Companion's own key, offered only while
  // that key is set and the free AI is switched on. GPT-6 Luna for both steps, with no choice.
  {
    id: 'career-companion',
    displayName: 'NorthList free AI',
    protocol: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    status: 'supported',
    keyOwner: 'career_companion',
    costModel: 'FREE',
    recommendedNote: 'Free, runs on OpenRouter. Shared by everyone, so it can be slow sometimes.',
    links: { apiKeys: null, billing: null, dataUse: 'https://openrouter.ai/privacy' },
    setupSteps: [],
    disclosure: {
      version: 'career-companion-free-2026-10-24',
      summary:
        "Your emails go to OpenRouter on NorthList's account. OpenRouter passes each request to GPT-6 Luna.",
      training:
        'NorthList asks OpenRouter to use only servers that keep nothing, so they cannot train on your mail.',
      residency:
        'OpenRouter is based in the US. GPT-6 Luna runs on Microsoft Azure servers in the US or Europe. OpenRouter picks the server for each request.',
      reviewedOn: '2026-10-24',
    },
    models: [GPT_6_LUNA],
  },
];

export function getCatalogProvider(id: string): CatalogProvider | undefined {
  return AI_CATALOG.find((provider) => provider.id === id);
}

/** True once today's UTC date is past the model's retiresOn day. */
export const isRetired = (model: CatalogModel) =>
  model.retiresOn !== null && new Date().toISOString().slice(0, 10) > model.retiresOn;

/** The models a user may choose for a role: current, catalog-defined, never free-form. */
export function modelsForRole(provider: CatalogProvider, role: AIRole): CatalogModel[] {
  return provider.models.filter((model) => model.roles.includes(role) && !isRetired(model));
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
): { model: CatalogModel; source: ModelSource } {
  if (selectedId === null)
    return { model: recommendedModel(provider, role), source: 'RECOMMENDED' };
  const selected = modelsForRole(provider, role).find((m) => m.id === selectedId);
  return selected
    ? { model: selected, source: 'SELECTED' }
    : { model: recommendedModel(provider, role), source: 'REPLACED_RETIRED' };
}
