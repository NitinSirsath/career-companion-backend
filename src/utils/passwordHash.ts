/**
 * Password hashing for sign-in with email and password: scrypt from Node's own crypto, with a
 * random salt per password. The stored text carries its cost settings, so they can be raised
 * later without breaking older hashes. A password or hash is never logged or returned.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

// OWASP's scrypt setting with the smallest memory use (about 32 MB per hash).
const COST = { N: 2 ** 15, r: 8, p: 3 };
const KEY_BYTES = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

/**
 * At most two hashes at a time; the others wait their turn. Each takes about 32 MB and one thread
 * of Node's small pool, which the rest of the app needs too (DNS, files), so a burst of sign-ins
 * cannot take it all.
 */
const AT_ONCE = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  while (running >= AT_ONCE) await new Promise<void>((wake) => waiting.push(wake));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, cost: typeof COST, bytes: number): Promise<Buffer> {
  return inTurn(
    () =>
      new Promise((resolve, reject) => {
        scrypt(password, salt, bytes, { ...cost, maxmem: MAX_MEMORY }, (err, key) =>
          err ? reject(err) : resolve(key),
        );
      }),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, KEY_BYTES);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join(
    '$',
  );
}

/** False for a wrong password and for stored text that is not one of our hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  try {
    const actual = await derive(password, Buffer.from(salt, 'base64'), cost, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
