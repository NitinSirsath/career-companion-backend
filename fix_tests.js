const fs = require('fs');

let c = fs.readFileSync('src/tests/gmail.test.ts', 'utf8');
c = c.replace('request: {} as any,\n              })', 'request: {} as any,\n              } as any)');
fs.writeFileSync('src/tests/gmail.test.ts', c);

let c2 = fs.readFileSync('src/tests/gmailSync.test.ts', 'utf8');
c2 = c2.replace('request: {} as any,\n      });', 'request: {} as any,\n      } as any);');
c2 = c2.replace('request: {} as any,\n      });', 'request: {} as any,\n      } as any);');
fs.writeFileSync('src/tests/gmailSync.test.ts', c2);

