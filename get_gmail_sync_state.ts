import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const sync = await prisma.gmailConnection.findFirst();
  console.log(JSON.stringify(sync, null, 2));
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
