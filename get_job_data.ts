import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const jobs = await prisma.$queryRaw`SELECT id, name, data, state, output FROM pgboss.job WHERE name = 'email-processing-job' LIMIT 1;`;
  console.log(JSON.stringify(jobs, null, 2));
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
