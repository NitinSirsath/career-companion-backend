import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  await prisma.application.deleteMany({});
  console.log('Deleted all apps');
}
main().finally(() => prisma.$disconnect());
