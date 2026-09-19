import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://career_companion:career_companion_password@127.0.0.1:5432/career_companion_db?schema=public"
    }
  }
});

async function main() {
  const users = await prisma.$queryRaw`SELECT * FROM users`;
  console.log('127.0.0.1 users:', users);
  
  const gcs = await prisma.$queryRaw`SELECT * FROM gmail_connections`;
  console.log('127.0.0.1 gcs:', gcs);
}
main().finally(() => prisma.$disconnect());
