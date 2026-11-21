// Portal accounts (owner, 21 Nov 2026; ADR-0002 amendment 2026-11-21): NorthList Apply sends the
// company-portal account it used, password included. Through the real /mcp endpoint with the
// official SDK client and the session-authenticated routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { Server } from 'http';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { createIntegrationToken } from '../services/integrationTokens';
import {
  ListApplicationSubmissionsResponseSchema,
  PortalPasswordResponseSchema,
} from '../contracts';
import { ADVERTISED_INPUT_SCHEMA } from '../mcp/server';
import { PortalAccountInputSchema, openPortalPassword } from '../services/portalAccount';
import { validatePortalCredentialKey, validateRequiredSecrets } from '../utils/config';

const DOMAIN = '@portal-accounts.test';
const KEY = 'a1'.repeat(32);
const PASSWORD = 'Nl-portal!7qR2x';
let owner: string;
let foreign: string;
let ownCookie: string;
let otherCookie: string;
let server: Server;
let client: Client;

const account = {
  signInUrl: 'https://user:pw@acme.wd5.myworkdayjobs.com/en-US/careers/login#top',
  loginEmail: 'Owner@Example.com',
  password: PASSWORD,
  emailVerified: true,
  madeBy: 'northlist_apply',
  createdOn: '2026-11-21',
};
const submission = (n: number, extra: Record<string, unknown> = {}) => ({
  sourceRecordRef: \`2026-11-21/10:00:0\${n}\`,
  platform: 'workday',
  company: 'Acme Corp',
  jobTitle: \`Engineer \${n}\`,
  submittedAt: '2026-11-21T10:00:00+05:30',
  portalAccount: account,
  ...extra,
});

const signSid = (sid: string, secret: string) =>
  \`\${sid}.\${crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')}\`;
async function sessionCookie(userId: string) {
  const sid = crypto.randomUUID();
  await prisma.session.create({
    data: {
      sid,
      sess: { cookie: { originalMaxAge: 86_400_000, httpOnly: true, path: '/' }, userId },
      expire: new Date(Date.now() + 2 * 86_400_000),
    },
  });
  return \`cc_session=\${encodeURIComponent(\`s:\${signSid(sid, process.env.SESSION_SECRET!)}\`)}\`;
}
const record = (args: Record<string, unknown>) =>
  client.callTool({ name: 'record_application_submission', arguments: args });
const errorOf = (result: Awaited<ReturnType<typeof record>>) =>
  JSON.parse((result.content as { text: string }[])[0].text);
const detailsOf = async (applicationId: string) => {
  const res = await request(app)
    .get(\`/api/applications/\${applicationId}/submissions\`)
    .set('Cookie', ownCookie);
  expect(res.status).toBe(200);
  return ListApplicationSubmissionsResponseSchema.parse(res.body).items;
};
const reveal = (accountId: string, cookie = ownCookie) =>
  request(app).post(\`/api/submissions/portal-accounts/\${accountId}/password\`).set('Cookie', cookie);
/**
 * The application behind an entry. A second job at the same company waits for review (matching
 * rule), so it is resolved by creating its own application, as the user would.
 */
async function appOf(ref: string) {
  const sub = await prisma.externalSubmission.findFirstOrThrow({
    where: { userId: owner, sourceRecordRef: ref },
  });
  if (sub.applicationId) return sub.applicationId;
  const res = await request(app)
    .post(\`/api/submissions/\${sub.id}/resolve\`)
    .set('Cookie', ownCookie)
    .send({ action: 'create' });
  expect(res.status).toBe(200);
  return res.body.applicationId as string;
}

/** Captures console output while \`run\` executes. */
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
  return lines;
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: \`owner\${DOMAIN}\` } })).id;
  foreign = (await prisma.user.create({ data: { email: \`foreign\${DOMAIN}\` } })).id;
  ownCookie = await sessionCookie(owner);
  otherCookie = await sessionCookie(foreign);
  const token = (await createIntegrationToken(owner, { name: 'laptop' })).plaintextToken;
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const baseUrl = \`http://127.0.0.1:\${(server.address() as AddressInfo).port}\`;
  client = new Client({ name: 'cc-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(\`\${baseUrl}/mcp\`), {
      requestInit: { headers: { Authorization: \`Bearer \${token}\` } },
    }),
  );
});
beforeEach(async () => {
  process.env.PORTAL_CREDENTIAL_ENCRYPTION_KEY = KEY;
  await prisma.externalSubmission.deleteMany({ where: { userId: { in: [owner, foreign] } } });
  await prisma.portalAccount.deleteMany({ where: { userId: { in: [owner, foreign] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, foreign] } } });
});
afterAll(async () => {
  process.env.PORTAL_CREDENTIAL_ENCRYPTION_KEY = '';
  await client.close();
  await new Promise((r) => server.close(r));
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('recording a portal account', () => {
  it('stores the account with the password sealed, and links it to the submission', async () => {
    const result = await record(submission(1));
    expect(result.structuredContent).toMatchObject({ result: 'created' });
    // The tool answer never carries the account or its password.
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    const stored = await prisma.portalAccount.findFirstOrThrow({ where: { userId: owner } });
    expect(stored).toMatchObject({
      company: 'Acme Corp',
      companyKey: 'acme',
      signInUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/login',
      signInHost: 'acme.wd5.myworkdayjobs.com',
      loginEmail: 'owner@example.com',
      emailVerified: true,
      madeBy: 'NORTHLIST_APPLY',
    });
    expect(stored.createdOn?.toISOString().slice(0, 10)).toBe('2026-11-21');
    expect(stored.passwordSealed).toMatch(/^v1:/);
    expect(stored.passwordSealed).not.toContain(PASSWORD);
    expect(openPortalPassword(owner, stored.passwordSealed!)).toBe(PASSWORD);
    // Bound to its owner: the same sealed value does not open for another user.
    expect(() => openPortalPassword(foreign, stored.passwordSealed!)).toThrow();
    const sub = await prisma.externalSubmission.findFirstOrThrow({ where: { userId: owner } });
    expect(sub.portalAccountId).toBe(stored.id);
  });

  it('reuses one account for the same portal and company, and a newer password wins', async () => {
    await record(submission(1));
    await record(
      submission(2, {
        company: 'ACME Corp.',
        portalAccount: { ...account, password: 'Newer-pass-9', emailVerified: null },
      }),
    );
    const accounts = await prisma.portalAccount.findMany({ where: { userId: owner } });
    expect(accounts).toHaveLength(1);
    expect(openPortalPassword(owner, accounts[0].passwordSealed!)).toBe('Newer-pass-9');
    // A value not sent keeps the stored one.
    expect(accounts[0].emailVerified).toBe(true);
    await appOf('2026-11-21/10:00:01');
    const items = await detailsOf(await appOf('2026-11-21/10:00:02'));
    expect(items[0].portalAccount).toMatchObject({ otherApplications: 1, hasPassword: true });
  });

  it('keeps a different company on the same portal host apart', async () => {
    await record(submission(1));
    await record(submission(2, { company: 'Globex' }));
    expect(await prisma.portalAccount.count({ where: { userId: owner } })).toBe(2);
  });

  it('records an account the user made, with no password', async () => {
    await record(
      submission(1, { portalAccount: { ...account, password: undefined, madeBy: 'user' } }),
    );
    const [item] = await detailsOf(await appOf('2026-11-21/10:00:01'));
    expect(item.portalAccount).toMatchObject({ madeBy: 'USER', hasPassword: false });
  });

  it('records the account without its password when the server has no key', async () => {
    process.env.PORTAL_CREDENTIAL_ENCRYPTION_KEY = '';
    expect((await record(submission(1))).structuredContent).toMatchObject({ result: 'created' });
    const stored = await prisma.portalAccount.findFirstOrThrow({ where: { userId: owner } });
    expect(stored.passwordSealed).toBeNull();
  });

  it('links an account sent again with a repeat of an entry that had none', async () => {
    await record(submission(1, { portalAccount: undefined }));
    expect((await record(submission(1))).structuredContent).toMatchObject({
      result: 'already_recorded',
    });
    const sub = await prisma.externalSubmission.findFirstOrThrow({ where: { userId: owner } });
    expect(sub.portalAccountId).not.toBeNull();
  });

  it.each([
    [{ ...account, note: 'x' }],
    [{ ...account, signInUrl: 'ftp://acme.example.com/login' }],
    [{ ...account, loginEmail: 'not-an-email' }],
    [{ ...account, password: '' }],
    [{ ...account, password: 'p'.repeat(201) }],
    [{ ...account, madeBy: 'robot' }],
    [{ ...account, createdOn: '21 Nov 2026' }],
    [{ signInUrl: account.signInUrl }],
  ])('refuses a portal account in a wrong shape, naming the field only', async (bad) => {
    let result: Awaited<ReturnType<typeof record>> | undefined;
    const lines = await captureLogs(async () => {
      result = await record(submission(1, { portalAccount: bad }));
    });
    expect(result!.isError).toBe(true);
    expect(errorOf(result!)).toMatchObject({ code: 'invalid_input', fields: ['portalAccount'] });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(lines.join('\n')).not.toContain(PASSWORD);
    expect(await prisma.portalAccount.count({ where: { userId: owner } })).toBe(0);
  });

  it('never writes the password to the logs', async () => {
    const lines = await captureLogs(() => record(submission(1)));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });
});

describe('showing the account', () => {
  it('lists the account on the application without the password', async () => {
    await record(submission(1));
    const res = await request(app)
      .get(\`/api/applications/\${await appOf('2026-11-21/10:00:01')}/submissions\`)
      .set('Cookie', ownCookie);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain('passwordSealed');
    const [item] = ListApplicationSubmissionsResponseSchema.parse(res.body).items;
    expect(item.portalAccount).toEqual({
      id: expect.any(String),
      company: 'Acme Corp',
      signInUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/login',
      loginEmail: 'owner@example.com',
      hasPassword: true,
      emailVerified: true,
      madeBy: 'NORTHLIST_APPLY',
      createdOn: '2026-11-21',
      otherApplications: 0,
    });
  });

  it('shows null when no account was sent', async () => {
    await record(submission(1, { portalAccount: undefined }));
    const [item] = await detailsOf(await appOf('2026-11-21/10:00:01'));
    expect(item.portalAccount).toBeNull();
  });

  it('opens the password for its owner only, never cached', async () => {
    await record(submission(1));
    const id = (await prisma.portalAccount.findFirstOrThrow({ where: { userId: owner } })).id;
    const res = await reveal(id);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(PortalPasswordResponseSchema.parse(res.body)).toEqual({ password: PASSWORD });
    expect((await reveal(id, otherCookie)).status).toBe(404);
    expect((await reveal('not-a-uuid')).status).toBe(404);
    expect(
      (await request(app).post(\`/api/submissions/portal-accounts/\${id}/password\`)).status,
    ).toBe(401);
  });

  it('says so when no password is stored, or it cannot be opened', async () => {
    process.env.PORTAL_CREDENTIAL_ENCRYPTION_KEY = '';
    await record(submission(1));
    const id = (await prisma.portalAccount.findFirstOrThrow({ where: { userId: owner } })).id;
    expect((await reveal(id)).status).toBe(404);
    process.env.PORTAL_CREDENTIAL_ENCRYPTION_KEY = KEY;
    await record(submission(2));
    // The key changed after sealing: the password cannot be opened.
    process.env.PORTAL_CREDENTIAL_ENCRYPTION_KEY = 'b2'.repeat(32);
    const res = await reveal(id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PASSWORD_UNREADABLE');
  });

  it('removes an account with the last application that used it', async () => {
    await record(submission(1));
    await record(submission(2));
    const first = await appOf('2026-11-21/10:00:01');
    const second = await appOf('2026-11-21/10:00:02');
    const del = (id: string) =>
      request(app).delete(\`/api/applications/\${id}\`).set('Cookie', ownCookie);
    expect((await del(first)).status).toBeLessThan(300);
    expect(await prisma.portalAccount.count({ where: { userId: owner } })).toBe(1);
    expect((await del(second)).status).toBeLessThan(300);
    expect(await prisma.portalAccount.count({ where: { userId: owner } })).toBe(0);
  });
});

describe('contract and configuration', () => {
  it('advertises the same portal account fields the contract enforces', () => {
    const advertised = ADVERTISED_INPUT_SCHEMA.properties.portalAccount;
    expect(Object.keys(advertised.properties).sort()).toEqual(
      Object.keys(PortalAccountInputSchema.shape).sort(),
    );
    const required = Object.entries(PortalAccountInputSchema.shape)
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([k]) => k);
    expect([...advertised.required].sort()).toEqual(required.sort());
    expect(advertised.properties.madeBy.enum).toEqual(
      PortalAccountInputSchema.shape.madeBy.unwrap().unwrap().options,
    );
  });

  it('accepts a missing key, refuses a bad or reused one', () => {
    const base = {
      GMAIL_TOKEN_ENCRYPTION_KEY: 'c3'.repeat(32),
      AI_CREDENTIAL_ENCRYPTION_KEY: 'd4'.repeat(32),
    };
    expect(() => validatePortalCredentialKey({ ...base })).not.toThrow();
    expect(() =>
      validatePortalCredentialKey({ ...base, PORTAL_CREDENTIAL_ENCRYPTION_KEY: '' }),
    ).not.toThrow();
    expect(() =>
      validatePortalCredentialKey({ ...base, PORTAL_CREDENTIAL_ENCRYPTION_KEY: KEY }),
    ).not.toThrow();
    expect(() =>
      validatePortalCredentialKey({ ...base, PORTAL_CREDENTIAL_ENCRYPTION_KEY: 'short' }),
    ).toThrow(/64 hex/);
    expect(() =>
      validatePortalCredentialKey({ ...base, PORTAL_CREDENTIAL_ENCRYPTION_KEY: 'C3'.repeat(32) }),
    ).toThrow(/differ from GMAIL_TOKEN_ENCRYPTION_KEY/);
    expect(() =>
      validateRequiredSecrets({ ...base, PORTAL_CREDENTIAL_ENCRYPTION_KEY: 'd4'.repeat(32) }),
    ).toThrow(/differ from AI_CREDENTIAL_ENCRYPTION_KEY/);
  });
});
