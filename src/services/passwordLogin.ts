/**
 * Sign-in with email and password, next to Google sign-in (services/googleOAuth.ts).
 *
 * Guessing is slowed down by counting failed tries per email and per network address over a
 * short window. A wrong email and a wrong password get the same answer and take the same time.
 * Passwords and hashes are never logged.
 */
import { randomBytes } from 'crypto';
import type { PasswordLoginRequest, RegisterRequest, SetPasswordRequest } from '../contracts/auth';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { hashPassword, verifyPassword } from '../utils/passwordHash';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES_PER_EMAIL = 5;
const MAX_TRIES_PER_ADDRESS = 20;

/** Emails differ in letter case between providers; sign-in must not. */
const findByEmail = (email: string) =>
  prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

/** When a full set of recent tries stops blocking: once its oldest one leaves the window. */
const blockedUntil = (tries: { createdAt: Date }[], limit: number): number =>
  tries.length >= limit ? tries[limit - 1].createdAt.getTime() + WINDOW_MS : 0;

const recentTries = (where: { email: string } | { ip: string }, limit: number) =>
  prisma.loginAttempt.findMany({
    where: { ...where, createdAt: { gt: new Date(Date.now() - WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { createdAt: true },
  });

/** Refuses with 429 while this email or network address has used up its tries. */
async function assertNotBlocked(email: string, ip: string) {
  const [byEmail, byAddress] = await Promise.all([
    recentTries({ email }, MAX_TRIES_PER_EMAIL),
    recentTries({ ip }, MAX_TRIES_PER_ADDRESS),
  ]);
  const until = Math.max(
    blockedUntil(byEmail, MAX_TRIES_PER_EMAIL),
    blockedUntil(byAddress, MAX_TRIES_PER_ADDRESS),
  );
  const retryAfterSeconds = Math.ceil((until - Date.now()) / 1000);
  if (retryAfterSeconds <= 0) return;
  const minutes = Math.ceil(retryAfterSeconds / 60);
  throw new AppError(
    429,
    'TOO_MANY_ATTEMPTS',
    `Too many tries. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    { retryAfterSeconds },
  );
}

async function recordFailedTry(email: string, ip: string) {
  // The app's clock, not the database's: the window above is measured with the same one.
  await prisma.loginAttempt.create({ data: { email, ip, createdAt: new Date() } });
  // Tries older than the window count for nothing: dropping them here keeps the table small.
  await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - WINDOW_MS) } },
  });
}

// Checked when there is no password to check, so an unknown email takes as long as a known one.
let decoy: Promise<string> | undefined;
const decoyHash = () => (decoy ??= hashPassword(randomBytes(32).toString('hex')));

/** The user's ID for a correct email and password; the same 401 for every other case. */
export async function loginWithPassword(input: PasswordLoginRequest, ip: string): Promise<string> {
  await assertNotBlocked(input.email, ip);
  const user = await findByEmail(input.email);
  const correct = await verifyPassword(input.password, user?.passwordHash ?? (await decoyHash()));
  if (!user?.passwordHash || !correct) {
    await recordFailedTry(input.email, ip);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is wrong.');
  }
  await prisma.loginAttempt.deleteMany({ where: { email: input.email } });
  return user.id;
}

/**
 * Sets the first password, or changes it. A change needs the current password and signs the user
 * out everywhere else, so it also ends a session that someone else may hold.
 */
export async function setPassword(
  userId: string,
  input: SetPasswordRequest,
  request: { ip: string; sessionId: string },
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.passwordHash) {
    const email = user.email.toLowerCase();
    await assertNotBlocked(email, request.ip);
    const correct =
      input.currentPassword !== undefined &&
      (await verifyPassword(input.currentPassword, user.passwordHash));
    if (!correct) {
      await recordFailedTry(email, request.ip);
      throw new AppError(403, 'WRONG_PASSWORD', 'Current password is wrong.');
    }
  }
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
  if (!user.passwordHash) return;
  await prisma.session.deleteMany({
    where: { sid: { not: request.sessionId }, sess: { path: ['userId'], equals: userId } },
  });
}

/** A new user with a password. Only dev mode offers it: in prod, Google sign-in creates users. */
export async function registerUser(input: RegisterRequest): Promise<string> {
  if (await findByEmail(input.email))
    throw new AppError(409, 'EMAIL_TAKEN', 'A user with this email already exists.');
  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name ?? null,
      passwordHash: await hashPassword(input.password),
    },
  });
  return user.id;
}
