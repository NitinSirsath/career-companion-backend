const fs = require('fs');

let c = fs.readFileSync('src/tests/gmail.test.ts', 'utf8');
c = c.replace('} as any)', '// eslint-disable-next-line @typescript-eslint/no-explicit-any\n              } as any)');
fs.writeFileSync('src/tests/gmail.test.ts', c);

let c2 = fs.readFileSync('src/tests/gmailSync.test.ts', 'utf8');
c2 = c2.replace(/} as any\);/g, '// eslint-disable-next-line @typescript-eslint/no-explicit-any\n      } as any);');
c2 = c2.replace('import { describe, it, expect, vi, beforeEach } from \'vitest\';', 'import { describe, it, expect, vi } from \'vitest\';');
fs.writeFileSync('src/tests/gmailSync.test.ts', c2);

