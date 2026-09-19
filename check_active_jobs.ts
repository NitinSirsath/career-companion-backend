import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const jobs = await prisma.$queryRaw`SELECT state, count(*) as cnt FROM pgboss.job WHERE name = 'email-processing-job' GROUP BY state;`;
  console.log(JSON.stringify(jobs, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  , 2));
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
