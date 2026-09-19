import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) {
    console.log("No user found.");
    return;
  }
  
  const existing = await prisma.application.findFirst({
    where: { companyName: 'Acme Technologies', jobTitle: 'Frontend Engineer' }
  });
  
  if (existing) {
    console.log("Already exists.");
  } else {
    await prisma.application.create({
      data: {
        userId: user.id,
        companyName: 'Acme Technologies',
        jobTitle: 'Frontend Engineer',
        aiStatus: 'APPLIED'
      }
    });
    console.log("Created Acme Technologies Application.");
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
