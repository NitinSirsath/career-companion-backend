import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const emails = await prisma.email.findMany({
    where: {
      OR: [
        { subject: { contains: 'Dummy', mode: 'insensitive' } },
        { sender: { contains: 'Dummy', mode: 'insensitive' } },
        { subject: { contains: 'Interview', mode: 'insensitive' } }
      ]
    },
    include: {
      aiProcessingResult: true
    },
    take: 10
  });
  console.log(JSON.stringify(emails, null, 2));
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
