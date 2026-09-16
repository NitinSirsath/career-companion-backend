const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  await prisma.gmailConnection.updateMany({ data: { syncStatus: 'IDLE' } });
  console.log("Reset syncStatus to IDLE");
}
run();
