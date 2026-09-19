import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const counts = await prisma.email.groupBy({
    by: ['processingState', 'relevanceState', 'matchState'],
    _count: true
  });
  console.log(JSON.stringify(counts, null, 2));
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
