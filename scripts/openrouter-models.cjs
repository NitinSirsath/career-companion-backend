// `npm run ai:openrouter-models [model IDs…]`: checks the catalog's OpenRouter models, and any
// candidate IDs given, against OpenRouter's public lists before a model is added or kept (owner
// decision, 17 Oct 2026: models change only through the catalog plus an evaluation run). It reads
// /models, /endpoints/zdr and /providers: no key, no cost, no user data. It needs the network, so
// it is not part of CI. Exit 1: a model is not listed, no private server takes our request, or an
// ID is an alias (`~`) or a variant (`:`). Exit 2: a network error or an unexpected answer.
require('ts-node').register({ transpileOnly: true });
const { AI_CATALOG } = require('../src/contracts/aiCatalog');
const { requiredParameters } = require('../src/services/ai/providers/openrouter');

const MIN_SERVERS = 3;
const MIN_CONTEXT = 32_000;
const MIN_OUTPUT = 4_096;
const TIMEOUT_MS = 30_000;
/** Without these a server cannot answer in our strict JSON format at all. */
const JSON_OUTPUT = ['response_format', 'structured_outputs'];
const THINKING_TEXT = {
  none: 'cannot think',
  optional: 'can think, and it can be turned off',
  always: 'always thinks',
};

const openrouter = AI_CATALOG.find((provider) => provider.id === 'openrouter');

class NetworkError extends Error {}
class UnexpectedAnswer extends Error {}

/** One public list: anything but a 200 answer with a `data` list is unexpected. */
async function publicList(path) {
  let res;
  try {
    res = await fetch(`${openrouter.baseUrl}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new NetworkError(`${path}: ${error.cause?.message ?? error.message}`);
  }
  if (!res.ok) throw new UnexpectedAnswer(`${path} answered ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body?.data)) throw new UnexpectedAnswer(`${path} has no data list`);
  return body.data;
}

async function readLists() {
  const [models, servers, providers] = await Promise.all([
    publicList('/models'),
    publicList('/endpoints/zdr'),
    publicList('/providers'),
  ]);
  return {
    models: models.filter((model) => typeof model?.id === 'string'),
    // Every server on this list keeps nothing (zero data retention).
    servers: servers.filter(
      (server) =>
        typeof server?.model_id === 'string' && Array.isArray(server.supported_parameters),
    ),
    providers,
  };
}

/** A price per token as OpenRouter writes it, shown per 1 million tokens. */
function perMillion(price) {
  const value = Number(price) * 1_000_000;
  return Number.isFinite(value) ? `$${+value.toPrecision(3)}` : 'unknown';
}

function dayBefore(date) {
  const day = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function thinkingOf(listed) {
  const facts = listed.reasoning;
  if (!facts) return { kind: 'none', efforts: [] };
  const efforts = Array.isArray(facts.supported_efforts) ? facts.supported_efforts : [];
  return { kind: facts.mandatory ? 'always' : 'optional', efforts };
}

/** For a candidate: the catalog entry we would write, with thinking kept at the minimum. */
function candidateModel(id, thinking) {
  const reasoning = { none: null, optional: { enabled: false }, always: { effort: 'low' } };
  return { id, temperature: null, reasoning: reasoning[thinking.kind] };
}

/** Whether the catalog's thinking setting fits what the model does. */
function thinkingWarnings(setting, thinking) {
  if (!setting)
    return thinking.kind === 'none'
      ? []
      : ['the catalog sends no thinking setting, but the model can think'];
  if (thinking.kind === 'none')
    return ['the catalog sends a thinking setting, but the model cannot think'];
  if ('enabled' in setting && thinking.kind === 'always')
    return ["the catalog turns thinking off, but the model always thinks: use { effort: 'low' }"];
  if ('effort' in setting && thinking.efforts.length && !thinking.efforts.includes(setting.effort))
    return [`the catalog asks for effort '${setting.effort}', which the model does not offer`];
  return [];
}

function expiryWarnings(listed, catalogModel) {
  if (!listed.expiration_date) return [];
  const retiresOn = dayBefore(listed.expiration_date);
  if (catalogModel?.retiresOn && catalogModel.retiresOn <= retiresOn) return [];
  return [`OpenRouter retires it on ${listed.expiration_date}: set retiresOn to ${retiresOn}`];
}

/** A dated slug is the ID plus a date; anything else means the ID points at another model. */
function slugWarnings(listed) {
  const slug = listed.canonical_slug;
  if (!slug || slug.replace(/-\d{4,8}$/, '') === listed.id) return [];
  return [`the dated slug ${slug} is not this ID plus a date`];
}

function countryOf(server, providers) {
  const known = providers.find((provider) => provider.name === server.provider_name);
  if (!known?.headquarters) return 'country unknown';
  const servers = Array.isArray(known.datacenters) ? known.datacenters : [];
  return `based in ${known.headquarters}${servers.length ? `, servers in ${servers.join(', ')}` : ''}`;
}

function serverLine(server, request, providers) {
  const missing = request.filter((name) => !server.supported_parameters.includes(name));
  const parts = [
    `${server.provider_name} (${server.tag})`,
    countryOf(server, providers),
    `in ${perMillion(server.pricing?.prompt)} / out ${perMillion(server.pricing?.completion)} per 1M tokens`,
    `context ${server.context_length ?? '?'}, output ${server.max_completion_tokens ?? '?'}`,
    missing.length ? `does not take ${missing.join(', ')}` : 'takes our request',
  ];
  if (server.status) parts.push(`status ${server.status}`);
  return `    - ${parts.join(' · ')}`;
}

/** Servers that take the request but are too small for our prompts or answers. */
function sizeWarnings(takers) {
  return takers.flatMap((server) =>
    server.context_length < MIN_CONTEXT || server.max_completion_tokens < MIN_OUTPUT
      ? [`${server.provider_name} (${server.tag}) has under 32k context or 4,096 output tokens`]
      : [],
  );
}

function serverReport(model, lists, report) {
  const request = requiredParameters(model);
  const servers = lists.servers.filter(
    (server) =>
      server.model_id === model.id &&
      JSON_OUTPUT.every((name) => server.supported_parameters.includes(name)),
  );
  const takers = servers.filter((server) =>
    request.every((name) => server.supported_parameters.includes(name)),
  );
  report.lines.push(`  our request: ${request.join(', ')}`);
  report.lines.push(
    `  private servers with JSON output: ${servers.length}, ${takers.length} take our request`,
  );
  report.lines.push(...servers.map((server) => serverLine(server, request, lists.providers)));
  if (!takers.length) report.failures.push('no private server takes our request');
  else if (takers.length < MIN_SERVERS)
    report.warnings.push(`only ${takers.length} servers take our request (want ${MIN_SERVERS})`);
  report.warnings.push(...sizeWarnings(takers));
}

function roleText(catalogModel) {
  if (!catalogModel) return 'candidate';
  const recommended = catalogModel.recommendedFor.length
    ? `; recommended for ${catalogModel.recommendedFor.join(', ')}`
    : '';
  return `catalog: ${catalogModel.roles.join(', ')}${recommended}`;
}

function checkModel(id, lists) {
  const catalogModel = openrouter.models.find((model) => model.id === id);
  const report = {
    title: `${id} (${roleText(catalogModel)})`,
    lines: [],
    warnings: [],
    failures: [],
  };
  if (/[~:]/.test(id)) report.failures.push('an alias (~) or a variant (:): use an exact model ID');
  const listed = lists.models.find((model) => model.id === id);
  if (!listed) {
    report.failures.push('not listed on OpenRouter');
    return report;
  }
  const thinking = thinkingOf(listed);
  const efforts = thinking.efforts.length ? ` (efforts: ${thinking.efforts.join(', ')})` : '';
  report.lines.push(
    `  listed · dated slug ${listed.canonical_slug ?? 'none'} · ` +
      `${listed.expiration_date ? `expires ${listed.expiration_date}` : 'no expiry date'} · ` +
      `${THINKING_TEXT[thinking.kind]}${efforts}`,
  );
  serverReport(catalogModel ?? candidateModel(id, thinking), lists, report);
  if (catalogModel) report.warnings.push(...thinkingWarnings(catalogModel.reasoning, thinking));
  report.warnings.push(...expiryWarnings(listed, catalogModel), ...slugWarnings(listed));
  return report;
}

function print(report) {
  console.log(`\n${report.title}`);
  for (const line of report.lines) console.log(line);
  for (const warning of report.warnings) console.log(`  ! ${warning}`);
  for (const failure of report.failures) console.log(`  ✗ ${failure}`);
}

async function main() {
  const ids = [
    ...new Set([...openrouter.models.map((model) => model.id), ...process.argv.slice(2)]),
  ];
  const lists = await readLists();
  console.log(
    `OpenRouter models, checked against OpenRouter's public lists on ${new Date().toISOString()}`,
  );
  const reports = ids.map((id) => checkModel(id, lists));
  reports.forEach(print);
  const failed = reports.filter((report) => report.failures.length).length;
  const warned = reports.filter((report) => report.warnings.length).length;
  console.log(`\n${reports.length} models checked: ${failed} failed, ${warned} with warnings.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  if (error instanceof NetworkError)
    console.error(`openrouter-models: network error: ${error.message}`);
  else if (error instanceof UnexpectedAnswer)
    console.error(`openrouter-models: unexpected answer: ${error.message}`);
  else console.error(error);
  process.exitCode = 2;
});
