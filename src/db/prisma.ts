import { PrismaClient } from '@prisma/client';
import { logLevel } from '../utils/config';

// Prevent multiple instances of Prisma Client in development
declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    // Every query only on request: printing them by default buries the lines that matter.
    log: logLevel() === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
