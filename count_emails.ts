import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const count = await prisma.email.count();
  console.log(`Total emails: ${count}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
