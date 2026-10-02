// MCP-02: integration tokens (ADR-0002 decision 10): service and session REST routes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { ListIntegrationTokensResponseSchema, CreateIntegrationTokenResponseSchema } from '../contracts';
import { verifyIntegrationToken } from '../services/integrationTokens';

const DOMAIN = '@mcp-tokens.test';
const ALICE = `alice${DOMAIN}`;
const BOB = `bob${DOMAIN}`;
let alice: string;
let bob: string;

const as = (email: string) => ({ 'X-Development-User': email });
const create = (email: string, body: Record<string, unknown> = { name: 'Laptop' }) =>
  request(app).post('/api/integration-tokens').set(as(email)).send(body);

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
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  alice = (await prisma.user.create({ data: { email: ALICE } })).id;
  bob = (await prisma.user.create({ data: { email: BOB } })).id;
});
beforeEach(async () => {
  await prisma.integrationToken.deleteMany({ where: { userId: { in: [alice, bob] } } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('POST /api/integration-tokens', () => {
  it('returns the plaintext once and stores only its hash and display prefix', async () => {
    const res = await create(ALICE);
    expect(res.status).toBe(201);
    const body = CreateIntegrationTokenResponseSchema.parse(res.body);
    expect(body.plaintextToken).toMatch(/^ccmcp_[A-Za-z0-9_-]{43}$/);
    expect(body.integrationToken).toMatchObject({
      name: 'Laptop',
      displayPrefix: body.plaintextToken.slice(0, 12),
      scope: 'submissions:write',
      status: 'active',
      lastUsedAt: null,
      revokedAt: null,
    });
    const days = (Date.parse(body.integrationToken.expiresAt) - Date.parse(body.integrationToken.createdAt)) / 86_400_000;
    expect(days).toBe(90);
    const row = await prisma.integrationToken.findUniqueOrThrow({ where: { id: body.integrationToken.id } });
    expect(row.tokenHash).toBe(crypto.createHash('sha256').update(body.plaintextToken).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(body.plaintextToken);
    expect(JSON.stringify(row)).not.toContain(body.plaintextToken.slice(12));
  });

  it('generates a different token every time', async () => {
    const [a, b] = [await create(ALICE), await create(ALICE)];
    expect(a.body.plaintextToken).not.toBe(b.body.plaintextToken);
  });

  it.each([
    [{ name: '' }],
    [{ name: '   ' }],
    [{ name: 'x'.repeat(101) }],
    [{ name: 'ok', expiresInDays: 0 }],
    [{ name: 'ok', expiresInDays: 366 }],
    [{ name: 'ok', expiresInDays: 1.5 }],
    [{ name: 'ok', scope: 'admin' }],
    [{}],
  ])('rejects invalid input %j', async (body) => {
    const res = await create(ALICE, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.integrationToken.count({ where: { userId: alice } })).toBe(0);
  });

  it('accepts a custom expiry up to 365 days and trims the name', async () => {
    const res = await create(ALICE, { name: '  CI laptop ', expiresInDays: 365 });
    expect(res.status).toBe(201);
    expect(res.body.integrationToken.name).toBe('CI laptop');
    const { createdAt, expiresAt } = res.body.integrationToken;
    expect((Date.parse(expiresAt) - Date.parse(createdAt)) / 86_400_000).toBe(365);
  });

  it('allows at most 5 active tokens; revoked and expired tokens do not count', async () => {
    for (let i = 0; i < 5; i++) expect((await create(ALICE)).status).toBe(201);
    const sixth = await create(ALICE);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('TOKEN_LIMIT_REACHED');
    const [first, second] = await prisma.integrationToken.findMany({ where: { userId: alice }, take: 2 });
    await request(app).delete(`/api/integration-tokens/${first.id}`).set(as(ALICE)).expect(200);
    await prisma.integrationToken.update({
      where: { id: second.id },
      data: { createdAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await create(ALICE)).status).toBe(201);
    expect((await create(ALICE)).status).toBe(201);
    expect((await create(ALICE)).status).toBe(409);
    expect((await create(BOB)).status).toBe(201); // per user
  });

  it('enforces the limit under concurrent creation', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => create(ALICE)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await prisma.integrationToken.count({ where: { userId: alice } })).toBe(5);
  });

  it('requires a session', async () => {
    const res = await request(app).post('/api/integration-tokens').send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/integration-tokens', () => {
  it('lists only the owner’s tokens, newest first, with status and no secret material', async () => {
    const older = (await create(ALICE, { name: 'older' })).body;
    const newer = (await create(ALICE, { name: 'newer' })).body;
    await create(BOB, { name: 'bob' });
    await prisma.integrationToken.update({
      where: { id: older.integrationToken.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await request(app).delete(`/api/integration-tokens/${newer.integrationToken.id}`).set(as(ALICE));

    const res = await request(app).get('/api/integration-tokens').set(as(ALICE));
    expect(res.status).toBe(200);
    const body = ListIntegrationTokensResponseSchema.parse(res.body);
    expect(body.items.map((t) => [t.name, t.status])).toEqual([
      ['newer', 'revoked'],
      ['older', 'active'],
    ]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain(older.plaintextToken);
    expect(text).not.toContain(newer.plaintextToken);
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ['createdAt', 'displayPrefix', 'expiresAt', 'id', 'lastUsedAt', 'name', 'revokedAt', 'scope', 'status'].sort(),
    );
  });

  it('paginates with the existing offset envelope and reports expired tokens', async () => {
    for (let i = 0; i < 3; i++) await create(ALICE, { name: `t${i}` });
    const t = await prisma.integrationToken.findFirstOrThrow({ where: { userId: alice, name: 't0' } });
    await prisma.integrationToken.update({
      where: { id: t.id },
      data: { createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 1000) },
    });
    const page = await request(app).get('/api/integration-tokens?limit=2').set(as(ALICE));
    expect(page.body.metadata).toEqual({ limit: 2, offset: 0, nextOffset: 2 });
    const rest = await request(app).get('/api/integration-tokens?limit=2&offset=2').set(as(ALICE));
    expect(rest.body.items.map((x: { name: string; status: string }) => [x.name, x.status])).toEqual([['t0', 'expired']]);
    expect(rest.body.metadata.nextOffset).toBeNull();
  });
});

describe('DELETE /api/integration-tokens/:id', () => {
  it('revokes immediately and keeps the row; a second revoke returns it unchanged', async () => {
    const { integrationToken, plaintextToken } = (await create(ALICE)).body;
    expect(await verifyIntegrationToken(plaintextToken)).not.toBeNull();
    const first = await request(app).delete(`/api/integration-tokens/${integrationToken.id}`).set(as(ALICE));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('revoked');
    expect(await verifyIntegrationToken(plaintextToken)).toBeNull();
    const second = await request(app).delete(`/api/integration-tokens/${integrationToken.id}`).set(as(ALICE));
    expect(second.status).toBe(200);
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
    expect(await prisma.integrationToken.count({ where: { id: integrationToken.id } })).toBe(1);
  });

  it('returns 404 for unknown and foreign tokens, without revoking the foreign one', async () => {
    const bobs = (await create(BOB)).body;
    const foreign = await request(app).delete(`/api/integration-tokens/${bobs.integrationToken.id}`).set(as(ALICE));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
    expect(await verifyIntegrationToken(bobs.plaintextToken)).not.toBeNull();
    const unknown = await request(app).delete(`/api/integration-tokens/${crypto.randomUUID()}`).set(as(ALICE));
    expect(unknown.status).toBe(404);
  });
});

describe('verifyIntegrationToken', () => {
  it('returns the owner and expiry and records lastUsedAt', async () => {
    const { integrationToken, plaintextToken } = (await create(BOB)).body;
    const verified = await verifyIntegrationToken(plaintextToken);
    expect(verified).toEqual({
      tokenId: integrationToken.id,
      userId: bob,
      scope: 'submissions:write',
      expiresAt: new Date(integrationToken.expiresAt),
    });
    const row = await prisma.integrationToken.findUniqueOrThrow({ where: { id: integrationToken.id } });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('rejects malformed values before any database lookup', async () => {
    const lookup = vi.spyOn(prisma.integrationToken, 'findUnique');
    for (const value of ['', 'Bearer x', 'ccmcp_short', `ccmcp_${'a'.repeat(44)}`, `xxmcp_${'a'.repeat(43)}`, `ccmcp_${'a'.repeat(42)}=`])
      expect(await verifyIntegrationToken(value)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects unknown, expired and revoked tokens', async () => {
    expect(await verifyIntegrationToken(`ccmcp_${'A'.repeat(43)}`)).toBeNull();
    const expired = (await create(ALICE)).body;
    await prisma.integrationToken.update({
      where: { id: expired.integrationToken.id },
      data: { createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 1) },
    });
    expect(await verifyIntegrationToken(expired.plaintextToken)).toBeNull();
    const revoked = (await create(ALICE)).body;
    await prisma.integrationToken.update({ where: { id: revoked.integrationToken.id }, data: { revokedAt: new Date() } });
    expect(await verifyIntegrationToken(revoked.plaintextToken)).toBeNull();
  });
});

describe('no plaintext in logs or later responses', () => {
  it('never logs the plaintext or its secret part across create, list, verify and revoke', async () => {
    let plaintext = '';
    let id = '';
    const logs = await captureLogs(async () => {
      const res = await create(ALICE);
      plaintext = res.body.plaintextToken;
      id = res.body.integrationToken.id;
      await request(app).get('/api/integration-tokens').set(as(ALICE));
      await verifyIntegrationToken(plaintext);
      await request(app).delete(`/api/integration-tokens/${id}`).set(as(ALICE));
      await verifyIntegrationToken(plaintext);
    });
    expect(logs).toContain('integration_token_created');
    expect(logs).toContain('integration_token_revoked');
    expect(logs).not.toContain(plaintext);
    expect(logs).not.toContain(plaintext.slice(12));
  });
});
