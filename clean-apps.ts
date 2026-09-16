import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  await prisma.application.deleteMany({
    where: { companyName: { in: ['Final Verification Corp', 'Puppeteer Test Corp'] } }
  });
  console.log('Cleaned up test apps');
}
main().finally(() => prisma.$disconnect());
