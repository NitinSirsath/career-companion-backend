import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const user = await prisma.user.findFirst();
  if (!user) return;
  
  const app = await prisma.application.create({
    data: { userId: user.id, companyName: 'Action Corp', jobTitle: 'Engineer' }
  });
  
  await prisma.action.create({
    data: {
      applicationId: app.id,
      type: 'INTERVIEW_PREP',
      description: 'Prepare for technical screen',
      status: 'PENDING',
      deadline: new Date(Date.now() + 86400000)
    }
  });
  
  await prisma.action.create({
    data: {
      applicationId: app.id,
      type: 'OFFER_DEADLINE',
      description: 'Accept or decline',
      status: 'PENDING',
      deadline: new Date(Date.now() - 86400000) // Yesterday (Overdue)
    }
  });
  
  await prisma.email.create({
    data: { 
      userId: user.id, 
      gmailMessageId: 'msg123', 
      subject: 'Next Steps', 
      sender: 'hr@ambiguous.com', 
      receivedAt: new Date(),
      matchState: 'AMBIGUOUS' 
    }
  });
  
  console.log('Seeded states');
}
main().finally(() => prisma.$disconnect());
