import { PrismaClient } from '@prisma/client';
import { encryptToken } from './src/utils/gmailTokenEncryption';

const prisma = new PrismaClient();

async function main() {
  const email = 'test-user@example.com';
  let user = await prisma.user.findUnique({ where: { email } });
  
  await prisma.gmailConnection.update({
    where: { userId: user!.id },
    data: { 
      status: 'CONNECTED', 
      syncStatus: 'IDLE',
      accessToken: encryptToken('invalid_but_encrypted_token'),
    }
  });
  console.log('Token updated');
}
main().catch(console.error).finally(() => prisma.$disconnect());
