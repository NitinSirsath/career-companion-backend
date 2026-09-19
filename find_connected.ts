import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const connection = await prisma.gmailConnection.findFirst({
    where: { status: 'CONNECTED' },
    include: { user: true }
  });
  console.log(connection);
}
main().finally(() => prisma.$disconnect());
