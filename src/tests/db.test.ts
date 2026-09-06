import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../db/prisma';

describe('Database Persistence Foundation', () => {
  beforeAll(async () => {
    // Clear the database for clean tests
    await prisma.application.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('database configuration can be initialized', () => {
    expect(prisma).toBeDefined();
  });

  it('User can be persisted', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'test-user@example.com',
      },
    });
    expect(user.id).toBeDefined();
    expect(user.email).toBe('test-user@example.com');
  });

  it('Application can be persisted for a User (ownership relationship works)', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'test-user@example.com' } });
    expect(user).toBeDefined();

    const application = await prisma.application.create({
      data: {
        userId: user!.id,
        companyName: 'Test Company',
        jobTitle: 'Software Engineer',
      },
    });

    expect(application.id).toBeDefined();
    expect(application.userId).toBe(user!.id);
    expect(application.companyName).toBe('Test Company');
  });

  it('required companyName constraint works (fails without it)', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'test-user@example.com' } });
    
    await expect(
      prisma.application.create({
        data: {
          userId: user!.id,
          jobTitle: 'No Company',
        } as any,
      })
    ).rejects.toThrow();
  });

  it('duplicate (userId, companyName, jobTitle) values are allowed', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'test-user@example.com' } });
    
    // Create first
    await prisma.application.create({
      data: {
        userId: user!.id,
        companyName: 'Duplicate Inc',
        jobTitle: 'Duplicate Role',
      },
    });

    // Create second identical
    const app2 = await prisma.application.create({
      data: {
        userId: user!.id,
        companyName: 'Duplicate Inc',
        jobTitle: 'Duplicate Role',
      },
    });

    expect(app2.id).toBeDefined();
  });

  it('deterministic seed behavior does not create duplicate development users', async () => {
    const devEmail = 'dev@career-companion.local';
    
    // First run (simulate seed)
    await prisma.user.upsert({
      where: { email: devEmail },
      update: {},
      create: { email: devEmail },
    });

    // Second run
    await prisma.user.upsert({
      where: { email: devEmail },
      update: {},
      create: { email: devEmail },
    });

    // Verify only one user exists
    const users = await prisma.user.findMany({ where: { email: devEmail } });
    expect(users.length).toBe(1);
  });
});
