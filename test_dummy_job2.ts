import { PrismaClient } from '@prisma/client';
import { getQueue } from './src/services/queue';
import { startEmailProcessingWorker, enqueueEmailProcessingJob } from './src/jobs/emailProcessingJob';

const prisma = new PrismaClient();

async function main() {
  const connection = await prisma.gmailConnection.findFirst({
    where: { status: 'CONNECTED' }
  });
  if (!connection) throw new Error('No connected user found');
  const user = await prisma.user.findUnique({ where: { id: connection.userId }});
  
  // Create dummy email
  const dummyEmail = await prisma.email.create({
    data: {
      userId: user!.id,
      gmailMessageId: `dummy2-${Date.now()}`,
      subject: 'Interview Invitation: Software Engineer at DummyCorp',
      sender: 'recruiting@dummycorp.com',
      receivedAt: new Date(),
      relevanceState: 'UNPROCESSED',
      processingState: 'PENDING',
      matchState: 'UNMATCHED',
    }
  });

  console.log(`Created dummy email: ${dummyEmail.id}`);

  // Start worker
  await startEmailProcessingWorker();
  console.log('Worker started');

  // Enqueue job
  await enqueueEmailProcessingJob(user!.id, dummyEmail.id);
  console.log('Job enqueued');

  // Poll for completion
  let attempts = 0;
  while (attempts < 20) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const emailCheck = await prisma.email.findUnique({
      where: { id: dummyEmail.id },
      include: { aiProcessingResult: true }
    });
    
    if (emailCheck && emailCheck.processingState !== 'PENDING' && emailCheck.processingState !== 'PROCESSING') {
      console.log('Processing finished!');
      console.log(JSON.stringify(emailCheck, null, 2));
      break;
    }
    attempts++;
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
