import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const emails = await prisma.email.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { aiProcessingResult: true, events: true, actions: true }
  });
  console.log(JSON.stringify(emails, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
