import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const emails = await prisma.email.findMany({
    include: {
      aiProcessingResult: true,
      application: true,
      events: true,
      actions: true
    }
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
