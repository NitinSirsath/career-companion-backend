import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = 'test-user@example.com';
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({ data: { email, name: 'Test User' } });
  }

  const connection = await prisma.gmailConnection.findUnique({ where: { userId: user.id } });
  if (!connection) {
    await prisma.gmailConnection.create({
      data: {
        userId: user.id,
        gmailEmail: email,
        status: 'CONNECTED',
        syncStatus: 'IDLE',
        accessToken: 'mock_encrypted_token',
      }
    });
  } else {
    await prisma.gmailConnection.update({
      where: { userId: user.id },
      data: { status: 'CONNECTED', syncStatus: 'IDLE' }
    });
  }
  console.log('Dev user seeded');
}
main().catch(console.error).finally(() => prisma.$disconnect());
