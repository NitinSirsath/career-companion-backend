import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const connection = await prisma.gmailConnection.findFirst({
    where: { status: 'CONNECTED' },
    include: { user: true }
  });
  
  if (!connection) {
    console.log("No connected Gmail user found.");
    return;
  }
  
  console.log(`Connected User ID: ${connection.userId}`);
  console.log(`Connected User Email: ${connection.user.email}`);
  
  const apps = await prisma.application.findMany({
    where: { userId: connection.userId, companyName: 'Acme Technologies', jobTitle: 'Frontend Engineer' }
  });
  
  console.log(`Found ${apps.length} Acme Technologies applications for this user.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
