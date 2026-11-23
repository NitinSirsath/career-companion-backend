// One-click setup of NorthList Apply (owner, 23 Nov 2026): setup codes in "Open in …" links.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import {
  CreateSetupCodeResponseSchema,
  INTEGRATION_TOKEN_MAX_ACTIVE,
  RedeemSetupCodeResponseSchema,
} from '../contracts';
import { verifyIntegrationToken } from '../services/integrationTokens';
import { SETUP_CODE_REFUSED, createSetupCode, redeemSetupCode } from '../services/setupCodes';

const DOMAIN = '@setup-codes.test';
const ALICE = `alice${DOMAIN}`;
let alice: string;
const savedHosts = process.env.MCP_ALLOWED_HOSTS;

const as = (email: string) => ({ 'X-Development-User': email });
const makeCode = (body: Record<string, unknown> = { name: 'MacBook' }) =>
  request(app).post('/api/integration-tokens/setup-codes').set(as(ALICE)).send(body);
const redeem = (code: string) => request(app).post('/api/setup-codes/redeem').send({ code });

/** Captures everything written to the console while `run` executes. */
async function captureLogs(run: () => Promise<unknown>) {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  try {
    await run();
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return lines.join('\n');
}

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  process.env.MCP_ALLOWED_HOSTS = 'api.northlist.test';
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  alice = (await prisma.user.create({ data: { email: ALICE } })).id;
});
beforeEach(async () => {
  await prisma.setupCode.deleteMany({ where: { userId: alice } });
  await prisma.integrationToken.deleteMany({ where: { userId: alice } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  process.env.MCP_ALLOWED_HOSTS = savedHosts;
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('POST /api/integration-tokens/setup-codes', () => {
  it('needs a signed-in user', async () => {
    const res = await request(app)
      .post('/api/integration-tokens/setup-codes')
      .send({ name: 'MacBook' });
    expect(res.status).toBe(401);
  });

  it('gives a code that works for 10 minutes and stores only its hash', async () => {
    const res = await makeCode();
    expect(res.status).toBe(201);
    const body = CreateSetupCodeResponseSchema.parse(res.body);
    expect(body.code).toMatch(/^NL-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const minutes = (Date.parse(body.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9.5);
    expect(minutes).toBeLessThanOrEqual(10);
    const [row] = await prisma.setupCode.findMany({ where: { userId: alice } });
    expect(row.name).toBe('MacBook');
    expect(JSON.stringify(row)).not.toContain(body.code);
    expect(JSON.stringify(row)).not.toContain(body.code.replace(/-/g, ''));
  });

  it('keeps one live code per user: a new code ends the older one', async () => {
    const first = CreateSetupCodeResponseSchema.parse((await makeCode()).body).code;
    await makeCode();
    expect(await prisma.setupCode.count({ where: { userId: alice } })).toBe(1);
    expect((await redeem(first)).status).toBe(400);
  });

  it('wants a name', async () => {
    expect((await makeCode({ name: ' ' })).status).toBe(400);
  });
});

describe('POST /api/setup-codes/redeem', () => {
  it('swaps a code for a working token, without a sign-in', async () => {
    const { code } = CreateSetupCodeResponseSchema.parse((await makeCode()).body);
    const res = await redeem(code);
    expect(res.status).toBe(200);
    const body = RedeemSetupCodeResponseSchema.parse(res.body);
    expect(body).toMatchObject({ serverAddress: 'https://api.northlist.test', name: 'MacBook' });
    const verified = await verifyIntegrationToken(body.plaintextToken);
    expect(verified?.userId).toBe(alice);
    const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(365);
  });

  it('works once', async () => {
    const { code } = CreateSetupCodeResponseSchema.parse((await makeCode()).body);
    expect((await redeem(code)).status).toBe(200);
    const again = await redeem(code);
    expect(again.status).toBe(400);
    expect(again.body.error).toMatchObject({
      code: 'SETUP_CODE_REFUSED',
      message: SETUP_CODE_REFUSED,
    });
  });

  it('never lets two swaps of the same code both succeed', async () => {
    const { code } = await createSetupCode(alice, { name: 'MacBook' });
    const results = await Promise.allSettled([
      redeemSetupCode({ code }),
      redeemSetupCode({ code }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.integrationToken.count({ where: { userId: alice } })).toBe(1);
  });

  it('refuses an old code, a made-up code and a malformed one with the same words', async () => {
    const past = new Date(Date.now() - 11 * 60_000);
    const { code } = await createSetupCode(alice, { name: 'MacBook' }, past);
    for (const tried of [code, 'NL-AAAA-BBBB-CCCC', 'hello']) {
      const res = await redeem(tried);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(SETUP_CODE_REFUSED);
    }
  });

  it('reads the code without caring about case, spaces or dashes', async () => {
    const { code } = CreateSetupCodeResponseSchema.parse((await makeCode()).body);
    const typed = ` ${code.toLowerCase().replace(/-/g, ' ')} `;
    expect((await redeem(typed)).status).toBe(200);
  });

  it('lets the code work again when no token could be made', async () => {
    for (let i = 0; i < INTEGRATION_TOKEN_MAX_ACTIVE; i++)
      await request(app)
        .post('/api/integration-tokens')
        .set(as(ALICE))
        .send({ name: `Old ${i}` });
    const { code } = CreateSetupCodeResponseSchema.parse((await makeCode()).body);
    expect((await redeem(code)).body.error.code).toBe('TOKEN_LIMIT_REACHED');
    const oldest = await prisma.integrationToken.findFirst({
      where: { userId: alice },
      orderBy: { createdAt: 'asc' },
    });
    await request(app).delete(`/api/integration-tokens/${oldest!.id}`).set(as(ALICE));
    expect((await redeem(code)).status).toBe(200);
  });

  it('never writes the code or the token to the logs', async () => {
    let code = '';
    let token = '';
    const logs = await captureLogs(async () => {
      code = CreateSetupCodeResponseSchema.parse((await makeCode()).body).code;
      token = RedeemSetupCodeResponseSchema.parse((await redeem(code)).body).plaintextToken;
    });
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(token);
  });
});
