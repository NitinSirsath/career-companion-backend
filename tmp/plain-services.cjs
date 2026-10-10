// One-time codemod: turns the 6 static-method service classes into plain exported functions and
// updates every caller. Run from the repository root, then run Prettier. Not kept in the repo.
const fs = require('fs');
const path = require('path');

/** class name → [file, name used for `import * as <name>` in tests that spy on the module] */
const SERVICES = {
  GmailSyncService: ['src/services/gmailSync.ts', 'gmailSync'],
  ApplicationService: ['src/services/application.ts', 'applications'],
  ActionService: ['src/services/action.ts', 'actions'],
  MatcherService: ['src/services/matcher.ts', 'matcher'],
  GmailFetcherService: ['src/services/gmailFetcher.ts', 'gmailFetcher'],
  EmailAIPipeline: ['src/services/ai/pipeline.ts', 'aiPipeline'],
};
/** Method names that are unclear without the class name in front. */
const RENAMES = {
  'ActionService.byRequest': 'getActionByRequest',
  'ActionService.snooze': 'snoozeAction',
  'EmailAIPipeline.finish': 'finishEmail',
};
/** Test titles that still name a class. */
const TITLES = [
  ["describe('MatcherService', ", "describe('matcher', "],
  ["describe('GmailSyncService Helpers', ", "describe('gmailSync helpers', "],
];

const newName = (cls, method) => RENAMES[`${cls}.${method}`] ?? method;

function convertService(cls, file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.indexOf(`export class ${cls} {`);
  const end = lines.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error(`class ${cls} not found in ${file}`);
  const methods = [];
  const body = lines.slice(start + 1, end).map((line) => {
    const dedented = line.startsWith('  ') ? line.slice(2) : line;
    const header = dedented.match(/^(?:(public|private) )?static (async )?(\w+)\(/);
    if (!header) return dedented;
    const [whole, access, isAsync = '', method] = header;
    methods.push(method);
    const exported = access === 'private' ? '' : 'export ';
    return `${exported}${isAsync}function ${newName(cls, method)}(${dedented.slice(whole.length)}`;
  });
  const text = [...lines.slice(0, start), ...body, ...lines.slice(end + 1)]
    .join('\n')
    .replace(/\bthis\.(\w+)/g, (whole, method) => {
      if (!methods.includes(method)) throw new Error(`${file}: unknown ${whole}`);
      return newName(cls, method);
    });
  fs.writeFileSync(file, text);
}

function tsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function convertCaller(file) {
  let text = fs.readFileSync(file, 'utf8');
  const before = text;
  for (const [cls, [, namespace]] of Object.entries(SERVICES)) {
    if (!new RegExp(`\\b${cls}\\b`).test(text)) continue;
    // A file that spies on the module reaches all of it through one namespace import.
    const spies = text.includes(`spyOn(${cls}, `);
    const used = new Set();
    text = text
      .replace(new RegExp(`spyOn\\(${cls}, '(\\w+)'`, 'g'), (_, method) => {
        return `spyOn(${namespace}, '${newName(cls, method)}'`;
      })
      .replace(new RegExp(`\\b${cls}\\.(\\w+)`, 'g'), (_, method) => {
        used.add(newName(cls, method));
        return spies ? `${namespace}.${newName(cls, method)}` : newName(cls, method);
      })
      .replace(/import \{([^}]*)\} from '([^']+)';/g, (whole, names, from) => {
        const kept = names.split(',').map((name) => name.trim());
        if (!kept.includes(cls)) return whole;
        const rest = kept.filter((name) => name && name !== cls);
        if (!spies) rest.push(...[...used].sort());
        return [
          rest.length ? `import { ${rest.join(', ')} } from '${from}';` : '',
          spies ? `import * as ${namespace} from '${from}';` : '',
        ]
          .filter(Boolean)
          .join('\n');
      });
  }
  for (const [from, to] of TITLES) text = text.replace(from, to);
  if (text !== before) fs.writeFileSync(file, text);
}

for (const [cls, [file]] of Object.entries(SERVICES)) convertService(cls, file);
for (const file of tsFiles('src')) convertCaller(file);