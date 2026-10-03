// MCP-04: the /mcp endpoint against the real app, with the official SDK client (ADR-0002).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { Server } from 'http';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { createIntegrationToken } from '../services/integrationTokens';
import { createMcpRouter } from '../mcp/router';
import { ADVERTISED_INPUT_SCHEMA } from '../mcp/server';
import { RecordApplicationSubmissionInputSchema } from '../services/externalSubmission';
import express from 'express';
import { ApplicationResponseSchema, ListApplicationsResponseSchema, ListApplicationEventsResponseSchema } from '../contracts';

const DOMAIN = '@mcp-endpoint.test';
const OWNER = `owner${DOMAIN}`;
let owner: string;
let token: string;
let tokenId: string;
let server: Server;
let baseUrl: string;

const submission = {
  sourceRecordRef: '2026-10-01/11:00:00',
  platform: 'linkedin',
  company: 'Endpoint Co',
  jobTitle: 'Platform Engineer',
  submittedAt: '2026-10-01T11:00:00+05:30',
  confirmationText: 'Your application was sent',
};
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};
const mcp = () => request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');

async function connect(bearer = token, mode: 'legacy' | 'auto' = 'legacy') {
  const client = new Client({ name: 'cc-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
}
const call = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'record_application_submission', arguments: args });
/** express-session's signed cookie value (cookie-signature's format). */
const signSid = (sid: string, secret: string) =>
  `${sid}.${crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')}`;
const errorBody = (result: Awaited<ReturnType<typeof call>>) =>
  JSON.parse((result.content as { type: string; text: string }[])[0].text);

/** Captures console output while `run` executes. */
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
const requestLogs = (lines: string[]) =>
  lines.filter((l) => l.includes('"mcp_request"')).map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  delete process.env.MCP_DAILY_SUBMISSION_LIMIT;
  await prisma.externalSubmission.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  await prisma.integrationToken.deleteMany({ where: { userId: owner } });
  const created = await createIntegrationToken(owner, { name: 'laptop' });
  token = created.plaintextToken;
  tokenId = created.integrationToken.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  delete process.env.MCP_DAILY_SUBMISSION_LIMIT;
  await new Promise((r) => server.close(r));
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('official SDK client', () => {
  it('flows from SDK intake through PostgreSQL into session-authenticated discovery, history and archive/restore', async () => {
    const foreign = await prisma.user.create({ data: { email: `discovery-foreign${DOMAIN}` } });
    const sessions: string[] = [];
    const sessionCookie = async (userId: string) => {
      const sid = crypto.randomUUID();
      sessions.push(sid);
      await prisma.session.create({ data: {
        sid, sess: { cookie: { originalMaxAge: 86_400_000, httpOnly: true, path: '/' }, userId },
        expire: new Date(Date.now() + 2 * 86_400_000),
      } });
      return `cc_session=${encodeURIComponent(`s:${signSid(sid, process.env.SESSION_SECRET!)}`)}`;
    };
    const ownCookie = await sessionCookie(owner);
    const otherCookie = await sessionCookie(foreign.id);
    const client = await connect();
    const read = (path: string, cookie = ownCookie) => request(app).get(path).set('Cookie', cookie);
    const filters = '?q=endpoint&submittedVia=AUTOMATION&sort=applied_desc';
    try {
      const first = await call(client, submission);
      expect(first.structuredContent).toMatchObject({ result: 'created' });
      expect((await call(client, submission)).structuredContent).toEqual({
        ...(first.structuredContent as object), result: 'already_recorded',
      });
      const listing = await read('/api/applications' + filters + '&effectiveStatus=UNKNOWN');
      expect(listing.status).toBe(200);
      const [application] = ListApplicationsResponseSchema.parse(listing.body).items;
      expect(listing.body.items).toHaveLength(1);
      expect(application).toMatchObject({
        companyName: submission.company, jobTitle: submission.jobTitle,
        aiStatus: null, userStatus: null, effectiveStatus: null, submittedVia: 'AUTOMATION',
        appliedAt: '2026-10-01T05:30:00.000Z',
      });
      expect((await read('/api/applications' + filters + '&effectiveStatus=APPLIED')).body.items).toEqual([]);
      const detail = await read('/api/applications/' + application.id);
      expect(detail.status).toBe(200);
      expect(ApplicationResponseSchema.parse(detail.body)).toEqual(application);
      const events = ListApplicationEventsResponseSchema.parse((await read(`/api/applications/${application.id}/events`)).body);
      expect(events.items).toHaveLength(1);
      expect(events.items[0]).toMatchObject({
        type: 'AUTOMATION_SUBMITTED', sourceEmail: null, analyzedBy: null,
        sourceSubmission: { confirmationText: submission.confirmationText, submittedAt: application.appliedAt },
      });
      expect(JSON.stringify(listing.body)).not.toMatch(/sourceRecordRef|tokenId|confirmationText.*ccmcp_/);
      expect((await read('/api/applications' + filters, otherCookie)).body.items).toEqual([]);
      expect((await read('/api/applications/' + application.id, otherCookie)).status).toBe(404);
      expect((await read(`/api/applications/${application.id}/events`, otherCookie)).status).toBe(403);
      expect((await request(app).get('/api/applications' + filters).set('Authorization', `Bearer ${token}`)).status).toBe(401);

      const updated = await request(app).patch(`/api/applications/${application.id}/status`).set('Cookie', ownCookie)
        .send({ userStatus: 'INTERVIEW', expectedUserStatusRevision: 0 });
      expect(updated.status).toBe(200);
      const linked = await call(client, { ...submission, sourceRecordRef: '2026-10-01/12:00:00', submittedAt: '2026-10-01T12:00:00+05:30' });
      expect(linked.structuredContent).toMatchObject({ result: 'linked' });
      const advanced = ListApplicationsResponseSchema.parse((await read('/api/applications' + filters + '&effectiveStatus=INTERVIEW')).body);
      expect(advanced.items).toHaveLength(1);
      expect(advanced.items[0]).toMatchObject({ id: application.id, appliedAt: application.appliedAt, userStatus: 'INTERVIEW', submittedVia: 'AUTOMATION' });

      expect((await request(app).patch(`/api/applications/${application.id}/archive`).set('Cookie', ownCookie)
        .send({ archived: true, expectedArchiveRevision: 0 })).status).toBe(200);
      expect((await read('/api/applications' + filters)).body.items).toEqual([]);
      expect((await read('/api/applications' + filters + '&archive=archived')).body.items).toHaveLength(1);
      expect((await call(client, submission)).structuredContent).toEqual({
        ...(first.structuredContent as object), result: 'already_recorded',
      });
      // A new archived-only candidate waits for review; it is not another application.
      const pending = await call(client, { ...submission, sourceRecordRef: '2026-10-01/13:00:00' });
      expect(pending.structuredContent).toMatchObject({ result: 'needs_review' });
      expect((await read('/api/submissions/pending')).body.items).toHaveLength(1);
      expect((await read('/api/applications' + filters + '&archive=all')).body.items).toHaveLength(1);
      expect((await request(app).patch(`/api/applications/${application.id}/archive`).set('Cookie', ownCookie)
        .send({ archived: false, expectedArchiveRevision: 1 })).status).toBe(200);
      const receiptId = (pending.structuredContent as { recordId: string }).recordId;
      expect((await request(app).post(`/api/submissions/${receiptId}/resolve`).set('Cookie', ownCookie)
        .send({ action: 'link', applicationId: application.id })).status).toBe(200);
      expect((await read('/api/submissions/pending')).body.items).toHaveLength(0);
      expect((await read('/api/applications' + filters)).body.items).toHaveLength(1);
      expect((await read(`/api/applications/${application.id}/events`)).body.items).toHaveLength(3);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['record_application_submission']);
    } finally {
      await client.close();
      await prisma.session.deleteMany({ where: { sid: { in: sessions } } });
      await prisma.user.delete({ where: { id: foreign.id } });
    }
  });

  it('lists exactly one write-only, idempotent tool with a strict input schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['record_application_submission']);
    const [tool] = tools;
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['sourceRecordRef', 'platform', 'company', 'jobTitle', 'submittedAt']),
    });
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
      ['company', 'confirmationText', 'destinationHost', 'discoverySource', 'jobTitle', 'jobUrl', 'location', 'platform', 'portalJobId', 'sourceRecordRef', 'submittedAt', 'workMode'].sort(),
    );
    expect(tool.outputSchema).toBeDefined();
    // Portable for hosts that pass schemas to model APIs: no null unions, type arrays or look-aheads.
    const advertised = JSON.stringify(tool.inputSchema);
    expect(advertised).not.toMatch(/anyOf|oneOf|"null"|\$schema|\(\?[=!]/);
    for (const property of Object.values(tool.inputSchema.properties ?? {})) expect(typeof (property as { type: unknown }).type).toBe('string');
    expect(tool.description).toMatch(/only after the site showed a submission confirmation/);
    await client.close();
  });

  it.each(['legacy', 'auto'] as const)('records a submission, then answers a replay with already_recorded (%s negotiation)', async (mode) => {
    const client = await connect(token, mode);
    const first = await call(client, submission);
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toEqual({ result: 'created', recordId: expect.any(String) });
    const replay = await call(client, submission);
    expect(replay.structuredContent).toEqual({ result: 'already_recorded', recordId: (first.structuredContent as { recordId: string }).recordId });
    const record = await prisma.externalSubmission.findFirstOrThrow({ where: { userId: owner } });
    expect(record.tokenId).toBe(tokenId);
    expect((await prisma.integrationToken.findUniqueOrThrow({ where: { id: tokenId } })).lastUsedAt).not.toBeNull();
    await client.close();
  });

  it('negotiates the 2026-07-28 protocol in auto mode', async () => {
    const client = await connect(token, 'auto');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await client.close();
  });

  it('rejects an unknown key as invalid_input naming the field, not its value', async () => {
    const client = await connect();
    const result = await call(client, { ...submission, salaryAnswer: 'SECRET-SALARY-123' });
    expect(result.isError).toBe(true);
    expect(errorBody(result)).toEqual({ code: 'invalid_input', fields: ['salaryAnswer'], retry: 'Do not retry until the entry is fixed.' });
    expect(JSON.stringify(result)).not.toContain('SECRET-SALARY-123');
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(0);
    await client.close();
  });

  it('reports invalid values of known fields by name', async () => {
    const client = await connect();
    const result = await call(client, { ...submission, platform: 'we_work_remotely', submittedAt: 'yesterday' });
    expect(errorBody(result)).toMatchObject({ code: 'invalid_input', fields: ['platform', 'submittedAt'] });
    expect(JSON.stringify(result)).not.toContain('we_work_remotely');
    await client.close();
  });

  it('returns rate_limited past the daily cap', async () => {
    process.env.MCP_DAILY_SUBMISSION_LIMIT = '1';
    const client = await connect();
    await call(client, submission);
    const result = await call(client, { ...submission, sourceRecordRef: '2026-10-01/11:05:00' });
    expect(result.isError).toBe(true);
    expect(errorBody(result)).toEqual({ code: 'rate_limited', retry: 'Retry the next UTC day.' });
    await client.close();
  });

  it('maps an unexpected failure to unavailable without details', async () => {
    process.env.MCP_DAILY_SUBMISSION_LIMIT = 'not-a-number';
    const client = await connect();
    const result = await call(client, submission);
    expect(errorBody(result)).toEqual({ code: 'unavailable', retry: 'Retry later.' });
    await client.close();
  });

  it('takes the user from the token only', async () => {
    const other = await prisma.user.create({ data: { email: `other${DOMAIN}` } });
    const otherToken = (await createIntegrationToken(other.id, { name: 'x' })).plaintextToken;
    const client = await connect(otherToken);
    await call(client, { ...submission, userId: owner });
    await call(client, submission);
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.externalSubmission.count({ where: { userId: other.id } })).toBe(1);
    await client.close();
  });
});

describe('advertised schema matches the validated contract', () => {
  const shape = RecordApplicationSubmissionInputSchema.shape;
  it('has the same fields, required fields and enums', () => {
    expect(Object.keys(ADVERTISED_INPUT_SCHEMA.properties).sort()).toEqual(Object.keys(shape).sort());
    const required = Object.entries(shape).filter(([, field]) => !field.safeParse(undefined).success).map(([k]) => k);
    expect([...ADVERTISED_INPUT_SCHEMA.required].sort()).toEqual(required.sort());
    expect(ADVERTISED_INPUT_SCHEMA.properties.platform.enum).toEqual(shape.platform.options);
    expect(ADVERTISED_INPUT_SCHEMA.properties.workMode.enum).toEqual(shape.workMode.unwrap().unwrap().options);
  });

  it('advertises the same reference pattern the contract enforces', () => {
    const pattern = new RegExp(ADVERTISED_INPUT_SCHEMA.properties.sourceRecordRef.pattern);
    for (const ref of ['2026-10-01/09:15:00', '2026-10-01 09:15:00', '2026-10-01/9:15:00', 'x2026-10-01/09:15:00'])
      expect(pattern.test(ref)).toBe(shape.sourceRecordRef.safeParse(ref).success);
  });
});

describe('HTTP boundary', () => {
  it.each([
    ['missing', undefined],
    ['malformed', 'Bearer not-a-token'],
    ['wrong scheme', `Basic ${'x'}`],
    ['unknown', `Bearer ccmcp_${'A'.repeat(43)}`],
  ])('401 for a %s token, with a Bearer challenge', async (_label, header) => {
    const req = mcp().send(initialize);
    if (header) req.set('Authorization', header);
    const res = await req;
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(res.body).toMatchObject({ error: 'invalid_token' });
  });

  it('401 for expired and revoked tokens', async () => {
    await prisma.integrationToken.update({ where: { id: tokenId }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 1000) } });
    expect((await mcp().set('Authorization', `Bearer ${token}`).send(initialize)).status).toBe(401);
    const fresh = await createIntegrationToken(owner, { name: 'fresh' });
    expect((await mcp().set('Authorization', `Bearer ${fresh.plaintextToken}`).send(initialize)).status).toBe(200);
    await prisma.integrationToken.update({ where: { id: fresh.integrationToken.id }, data: { revokedAt: new Date() } });
    expect((await mcp().set('Authorization', `Bearer ${fresh.plaintextToken}`).send(initialize)).status).toBe(401);
  });

  it('401 for a token in the query string', async () => {
    const res = await request(app).post(`/mcp?access_token=${token}`).send(initialize);
    expect(res.status).toBe(401);
  });

  it('rejects a valid session cookie alone, and the development header', async () => {
    const sid = crypto.randomUUID();
    await prisma.session.create({
      // expire is a local-time column: a day ahead stays valid in any server time zone.
      data: { sid, sess: { cookie: { originalMaxAge: 86_400_000, httpOnly: true, path: '/' }, userId: owner }, expire: new Date(Date.now() + 2 * 86_400_000) },
    });
    const cookie = `cc_session=${encodeURIComponent(`s:${signSid(sid, process.env.SESSION_SECRET!)}`)}`;
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200); // the session is real
    expect((await mcp().set('Cookie', cookie).send(initialize)).status).toBe(401);
    expect((await mcp().set('X-Development-User', OWNER).send(initialize)).status).toBe(401);
    await prisma.session.delete({ where: { sid } });
  });

  it('a valid integration token gets 401 on /api routes', async () => {
    for (const path of ['/api/applications', '/api/integration-tokens', '/api/auth/me'])
      expect((await request(app).get(path).set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('405 for GET, DELETE and other methods', async () => {
    for (const method of ['get', 'delete', 'put'] as const) {
      const res = await request(app)[method]('/mcp').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  it('403 for a Host not on the allowlist, before authentication', async () => {
    const res = await mcp().set('Host', 'evil.example').set('Authorization', `Bearer ${token}`).send(initialize);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('evil.example');
  });

  it('403 for an Origin not on the allowlist; no Origin passes', async () => {
    const withOrigin = await mcp().set('Origin', 'https://evil.example').set('Authorization', `Bearer ${token}`).send(initialize);
    expect(withOrigin.status).toBe(403);
    expect((await mcp().set('Authorization', `Bearer ${token}`).send(initialize)).status).toBe(200);
  });

  it('honours configured Host and Origin allowlists', async () => {
    const configured = express().use('/mcp', createMcpRouter({ allowedHosts: ['cc.example.com'], allowedOrigins: ['ide.example'] }));
    const post = () => request(configured).post('/mcp').set('Accept', 'application/json, text/event-stream').set('Authorization', `Bearer ${token}`);
    expect((await post().set('Host', 'cc.example.com:443').send(initialize)).status).toBe(200);
    expect((await post().set('Host', 'localhost').send(initialize)).status).toBe(403);
    expect((await post().set('Host', 'cc.example.com').set('Origin', 'vscode-webview://ide.example').send(initialize)).status).toBe(200);
    expect((await post().set('Host', 'cc.example.com').set('Origin', 'null').send(initialize)).status).toBe(403);
  });

  it('413 JSON for a body over 32 KB, without a stack trace', async () => {
    const res = await mcp()
      .set('Authorization', `Bearer ${token}`)
      .send({ ...initialize, params: { ...initialize.params, padding: 'x'.repeat(33 * 1024) } });
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.text).not.toMatch(/at .*\.js|PayloadTooLargeError|<html/i);
  });

  it('accepts a body under 32 KB that the global 100 KB parser would also accept', async () => {
    const res = await mcp()
      .set('Authorization', `Bearer ${token}`)
      .send({ ...initialize, params: { ...initialize.params, padding: 'x'.repeat(30 * 1024) } });
    expect(res.status).toBe(200);
  });

  it('400 JSON-RPC parse error for malformed JSON, without a stack trace', async () => {
    const res = await mcp().set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/json').send('{"jsonrpc":');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
    expect(res.text).not.toMatch(/SyntaxError|at /);
  });

  it('adds no CORS headers', async () => {
    const res = await mcp().set('Authorization', `Bearer ${token}`).send(initialize);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('logging', () => {
  it('logs one line per request, including validation failures, without payload values or token material', async () => {
    let client: Client | undefined;
    const lines = await captureLogs(async () => {
      client = await connect();
      await call(client, { ...submission, company: 'SecretCompanyName', salaryAnswer: 'SECRET-SALARY-123' });
      await call(client, submission);
      await mcp().send(initialize); // unauthenticated
      await mcp().set('Authorization', `Bearer ${token}x`).send(initialize);
    });
    await client?.close();
    const all = lines.join('\n');
    for (const secret of ['SECRET-SALARY-123', 'SecretCompanyName', 'salaryAnswer', 'Endpoint Co', 'Platform Engineer', token, token.slice(12)])
      expect(all).not.toContain(secret);
    const logs = requestLogs(lines);
    const toolCalls = logs.filter((l) => l.tool === 'record_application_submission');
    expect(toolCalls.map((l) => l.outcome)).toEqual(['invalid_input', 'created']);
    expect(toolCalls[0]).toMatchObject({ userId: owner, tokenId, status: 200, rpcMethod: 'tools/call', invalidFields: [], unknownKeyCount: 1 });
    expect(typeof toolCalls[0].durationMs).toBe('number');
    expect(logs.filter((l) => l.outcome === 'unauthorized')).toHaveLength(2);
    expect(logs.filter((l) => l.outcome === 'unauthorized').every((l) => l.status === 401 && !l.userId)).toBe(true);
  });

  it('logs the hostname of a rejected Host or Origin, so the allowlist can be configured', async () => {
    const lines = await captureLogs(async () => {
      await mcp().set('Host', 'Edge.Example.com:8443').set('Authorization', `Bearer ${token}`).send(initialize);
      await mcp().set('Origin', 'vscode-webview://ide-123.example').set('Authorization', `Bearer ${token}`).send(initialize);
      await mcp().set('Origin', 'null').set('Authorization', `Bearer ${token}`).send(initialize);
    });
    const logs = requestLogs(lines);
    expect(logs.map((l) => [l.outcome, l.rejectedHost ?? l.rejectedOriginHost])).toEqual([
      ['host_not_allowed', 'edge.example.com'],
      ['origin_not_allowed', 'ide-123.example'],
      ['origin_not_allowed', 'unparseable'],
    ]);
  });

  it('logs whether a replay differed from the stored record', async () => {
    const client = await connect();
    await call(client, submission);
    const lines = await captureLogs(() => call(client, { ...submission, location: 'Changed' }));
    await client.close();
    expect(requestLogs(lines).find((l) => l.tool)).toMatchObject({ outcome: 'already_recorded', payloadDiffered: true });
  });
});
