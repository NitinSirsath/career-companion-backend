import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const email = await prisma.email.findFirst({
    where: { subject: { contains: 'Dummy', mode: 'insensitive' } }
  });
  console.log(JSON.stringify(email, null, 2));
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
