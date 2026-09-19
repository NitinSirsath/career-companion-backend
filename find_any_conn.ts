import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const connections = await prisma.gmailConnection.findMany({ include: { user: true } });
  console.log(connections);
}
main().finally(() => prisma.$disconnect());
