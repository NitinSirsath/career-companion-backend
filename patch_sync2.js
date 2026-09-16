const fs = require('fs');
const path = './src/services/gmailSync.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  "pageToken = listRes.data.nextPageToken || undefined;",
  "pageToken = listRes.data.nextPageToken || undefined; console.log('nextPageToken:', pageToken);"
);

fs.writeFileSync(path, code);
console.log('Patched');
