const fs = require('fs');
const path = './src/services/gmailSync.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  "const updateResult = await prisma.gmailConnection.updateMany({",
  "console.log('Updating syncStatus to SYNCING'); const updateResult = await prisma.gmailConnection.updateMany({"
);

code = code.replace(
  "const gmail = google.gmail({ version: 'v1', auth: oauth2Client });",
  "const gmail = google.gmail({ version: 'v1', auth: oauth2Client }); console.log('Gmail client created');"
);

code = code.replace(
  "const listRes: any = await gmail.users.messages.list({",
  "console.log('Calling messages.list...'); const listRes: any = await gmail.users.messages.list({"
);

code = code.replace(
  "const messages = listRes.data.messages || [];",
  "const messages = listRes.data.messages || []; console.log(`Got ${messages.length} messages`);"
);

code = code.replace(
  "for (const msg of messages) {",
  "let idx = 0; for (const msg of messages) { idx++; console.log(`Processing message ${idx}/${messages.length}`);"
);

fs.writeFileSync(path, code);
console.log('Patched');
