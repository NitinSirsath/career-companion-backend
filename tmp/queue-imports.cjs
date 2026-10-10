// One-time codemod: points every import and test mock at the new home of the queue functions.
// Run from the repository root, then run Prettier. Not kept in the repo.
const fs = require('fs');
const path = require('path');

const ENQUEUE = 'src/services/enqueue';
const OFFER = 'src/services/ai/offer';
/** old module → [new module, the names that moved there] */
const MOVED = {
  'src/jobs/emailProcessingJob': [
    ENQUEUE,
    [
      'EMAIL_PROCESSING_JOB',
      'EMAIL_RETRY_LIMIT',
      'EmailProcessingJobData',
      'emailJobOptions',
      'enqueueEmailProcessingJob',
    ],
  ],
  'src/jobs/relevanceTriageJob': [
    ENQUEUE,
    [
      'RELEVANCE_TRIAGE_JOB',
      'RelevanceTriageJobData',
      'relevanceTriageJobOptions',
      'enqueueRelevanceTriage',
    ],
  ],
  'src/jobs/notificationJob': [
    ENQUEUE,
    ['NOTIFICATION_JOB', 'NotificationJobData', 'enqueueNotificationJob'],
  ],
  'src/services/gmailSync': [OFFER, ['reofferPendingEmails', 'REOFFER_LIMIT']],
};

function tsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function convert(file) {
  const dir = path.dirname(file);
  const moduleOf = (from) => path.join(dir, from).split(path.sep).join('/');
  const pathTo = (module) => {
    const relative = path.relative(dir, module).split(path.sep).join('/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  };
  const before = fs.readFileSync(file, 'utf8');

  // Test mocks of a job file only ever replace its enqueue function. They become a partial mock
  // of the enqueue module, so its other functions stay real, as they were before.
  let text = before
    .replace(/typeof import\('([^']+)'\)/g, (whole, from) => {
      const moved = MOVED[moduleOf(from)];
      return moved && moved[0] === ENQUEUE ? `typeof import('${pathTo(ENQUEUE)}')` : whole;
    })
    .replace(/vi\.mock\('([^']+)', (\(\) => \(\{)?/g, (whole, from, plainFactory) => {
      const moved = MOVED[moduleOf(from)];
      if (!moved || moved[0] !== ENQUEUE) return whole;
      const to = pathTo(ENQUEUE);
      if (!plainFactory) return `vi.mock('${to}', `;
      return `vi.mock('${to}', async (importOriginal) => ({ ...(await importOriginal<typeof import('${to}')>()),`;
    });

  // Imports: names that moved are imported from their new module, once per module.
  const added = new Map();
  text = text.replace(/import (type )?\{([^}]*)\} from '([^']+)';\n/g, (whole, type, names, from) => {
    const moved = MOVED[moduleOf(from)];
    if (!moved || moduleOf(from) === file.replace(/\.ts$/, '')) return whole;
    const [target, movedNames] = moved;
    const all = names.split(',').map((name) => name.trim()).filter(Boolean);
    const going = all.filter((name) => movedNames.includes(name.replace(/^type /, '')));
    if (!going.length) return whole;
    const first = !added.has(target);
    added.set(target, [...(added.get(target) ?? []), ...going.map((name) => (type ? `type ${name}` : name))]);
    const staying = all.filter((name) => !going.includes(name));
    const kept = staying.length ? `import ${type ?? ''}{ ${staying.join(', ')} } from '${from}';\n` : '';
    return kept + (first ? `/*moved:${target}*/\n` : '');
  });
  for (const [target, names] of added) {
    const to = pathTo(target);
    const existing = new RegExp(`import \\{([^}]*)\\} from '${to.replace(/[.]/g, '\\\\.')}';\\n`);
    const already = text.match(existing);
    if (already) {
      const merged = [...already[1].split(',').map((name) => name.trim()).filter(Boolean), ...names];
      text = text
        .replace(existing, `import { ${merged.join(', ')} } from '${to}';\n`)
        .replace(`/*moved:${target}*/\n`, '');
    } else {
      text = text.replace(`/*moved:${target}*/\n`, `import { ${names.join(', ')} } from '${to}';\n`);
    }
  }
  if (text !== before) fs.writeFileSync(file, text);
}

for (const file of tsFiles('src')) convert(file);
