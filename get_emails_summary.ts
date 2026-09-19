import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const emails = await prisma.email.findMany({
    select: {
      subject: true,
      sender: true,
      relevanceState: true,
      processingState: true,
      matchState: true
    }
  });
  console.table(emails);
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
