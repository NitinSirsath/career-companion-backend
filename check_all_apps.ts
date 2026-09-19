import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const apps = await prisma.application.findMany();
  console.log(`Total applications: ${apps.length}`);
  console.log(apps);
}

main().catch(console.error).finally(() => prisma.$disconnect());
