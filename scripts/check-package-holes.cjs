// Fails when a package the live app uses has a known high or critical hole (`npm audit`, dev-only
// packages left out). Run by the Security workflow. A hole that cannot be fixed yet is listed in
// ACCEPTED with its reason; remove its line once the fix lands.
const { spawnSync } = require('node:child_process');

const ACCEPTED = {
  // deepmerge-ts inside Prisma 6's config loader: only our own config file reaches it. Fixed in
  // Prisma 7, which is a large upgrade of its own.
  'https://github.com/advisories/GHSA-ggr8-5vv4-36mx': 'Prisma 7 upgrade',
};

const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('npm audit gave no readable answer:', run.stderr.trim());
  process.exit(1);
}

const holes = new Map();
for (const [name, entry] of Object.entries(report.vulnerabilities ?? {}))
  for (const via of entry.via)
    if (typeof via === 'object' && ['high', 'critical'].includes(via.severity))
      holes.set(via.url, `${via.severity} ${name}: ${via.title} (${via.url})`);

const open = [...holes].filter(([url]) => !ACCEPTED[url]);
for (const [url, line] of holes) if (ACCEPTED[url]) console.log(`accepted: ${line}`);
for (const [, line] of open) console.error(`open: ${line}`);
if (open.length) {
  console.error(`${open.length} high or critical hole(s) in live-app packages. Update them.`);
  process.exit(1);
}
console.log('No open high or critical holes in live-app packages.');
