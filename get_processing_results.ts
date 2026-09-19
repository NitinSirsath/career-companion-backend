import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const results = await prisma.aIProcessingResult.findMany({
    include: {
      email: true
    }
  });
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
