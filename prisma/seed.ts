import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Do not run the development seed in production.');
    process.exit(1);
  }

  const devEmail = 'dev@career-companion.local';

  console.log(`Upserting development user: ${devEmail}`);

  const user = await prisma.user.upsert({
    where: { email: devEmail },
    update: {},
    create: {
      email: devEmail,
      applications: {
        create: [
          {
            companyName: 'Linear',
            jobTitle: 'Frontend Engineer',
            location: 'Remote',
            userStatus: 'APPLIED',
            appliedAt: new Date(),
          },
          {
            companyName: 'Notion',
            jobTitle: 'Backend Engineer',
            location: 'San Francisco, CA',
            userStatus: 'RECRUITER_CONTACT',
          }
        ]
      }
    },
  });

  console.log(`Seed complete. Development user ID: ${user.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
