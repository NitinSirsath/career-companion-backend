import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const apps = await prisma.application.findMany({
    where: { companyName: 'Acme Technologies' }
  });
  console.log(`Found ${apps.length} applications for Acme Technologies.`);
  console.log(apps);
}

main().catch(console.error).finally(() => prisma.$disconnect());
