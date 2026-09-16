const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const conn = await prisma.gmailConnection.findFirst();
  console.log("Status:", conn.syncStatus);
}
run();
