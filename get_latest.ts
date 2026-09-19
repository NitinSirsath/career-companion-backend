import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const latest = await prisma.email.findMany({ orderBy: { createdAt: 'desc' }, take: 2 });
  console.log(latest);
}
main().finally(() => prisma.$disconnect());
