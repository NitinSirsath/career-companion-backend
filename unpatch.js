const fs = require('fs');
const path = './src/services/gmailSync.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace("console.log('Updating syncStatus to SYNCING'); ", "");
code = code.replace(" console.log('Gmail client created');", "");
code = code.replace("console.log('Calling messages.list...'); ", "");
code = code.replace(" console.log(`Got ${messages.length} messages`);", "");
code = code.replace("let idx = 0; for (const msg of messages) { idx++; console.log(`Processing message ${idx}/${messages.length}`);", "for (const msg of messages) {");
code = code.replace(" console.log('nextPageToken:', pageToken);", "");

fs.writeFileSync(path, code);
