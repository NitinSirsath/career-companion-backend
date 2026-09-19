import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.$queryRaw`SELECT * FROM users`;
  console.log('users:', users);
  
  const gcs = await prisma.$queryRaw`SELECT * FROM gmail_connections`;
  console.log('gcs:', gcs);
}
main().finally(() => prisma.$disconnect());
