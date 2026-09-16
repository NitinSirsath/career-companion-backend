import { GmailSyncService } from './src/services/gmailSync';
import { prisma } from './src/db/prisma';

async function run() {
  console.log("Starting sync...");
  const user = await prisma.user.findFirst();
  try {
    const res = await GmailSyncService.syncUser(user!.id);
    console.log("Sync complete:", res);
  } catch (e) {
    console.error("Sync error:", e);
  }
}

run().finally(() => process.exit(0));
