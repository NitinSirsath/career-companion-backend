import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { getQueue } from './src/services/queue';
import { startEmailProcessingWorker, enqueueEmailProcessingJob } from './src/jobs/emailProcessingJob';

const prisma = new PrismaClient();

async function main() {
  const email = await prisma.email.findFirst({
    where: { 
      processingState: 'PENDING',
      relevanceState: 'UNPROCESSED'
    }
  });
  
  if (!email) throw new Error('No pending email found');
  
  console.log(`Selected email: ${email.id} / ${email.subject}`);

  // Start worker
  await startEmailProcessingWorker();
  console.log('Worker started');

  // Enqueue job
  await enqueueEmailProcessingJob(email.userId, email.id);
  console.log('Job enqueued');

  // Poll for completion
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const emailCheck = await prisma.email.findUnique({
      where: { id: email.id },
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
