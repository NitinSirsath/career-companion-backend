// NorthList Apply runs as tasks (owner, 25 Nov 2026): the `task` field on both tools, the run
// list with its totals, and the applications filter per run.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { ListApplyTasksResponseSchema } from '../contracts';
import { ADVERTISED_INPUT_SCHEMA, ADVERTISED_NOT_SUBMITTED_SCHEMA } from '../mcp/server';
import {
  ApplyTaskInputSchema,
  offsetMinutes,
  parseTaskInput,
  planCounts,
} from '../services/applyTask';
import { recordSubmission } from '../services/externalSubmission';
import { recordNotSubmittedJob } from '../services/notSubmittedJob';

const DOMAIN = '@apply-tasks.test';
const OWNER = `owner${DOMAIN}`;
const OTHER = `other${DOMAIN}`;
let owner: string;
let other: string;
const as = (email: string) => ({ 'X-Development-User': email });

const NIGHT = '2026-11-20T21:02:10+05:30';
const MORNING = '2026-11-21T10:15:00+05:30';
const nightTask = {
  startedAt: NIGHT,
  plan: [
    { site: 'linkedin', planned: 10 },
    { site: 'the_reliable_jobs', planned: 2 },
  ],
};

let n = 0;
/** One confirmed application; each call is a new entry and a new company. */
function submit(task: unknown, overrides: Record<string, unknown> = {}, userId = owner) {
  n += 1;
  const minute = String(n % 60).padStart(2, '0');
  return recordSubmission(userId, null, {
    sourceRecordRef: `2026-11-20/21:${minute}:00`,
    platform: 'linkedin',
    company: `Company ${n}`,
    jobTitle: 'Frontend Engineer',
    submittedAt: `2026-11-20T21:${minute}:00+05:30`,
    ...(task === undefined ? {} : { task }),
    ...overrides,
  });
}

function notSubmitted(task: unknown, loggedAt = '2026-11-20T22:06:00+05:30', userId = owner) {
  n += 1;
  return recordNotSubmittedJob(userId, null, {
    sourceRecordRef: `2026-11-20/22:${String(n % 60).padStart(2, '0')}:30`,
    outcome: 'skipped',
    platform: 'linkedin',
    company: `Skipped ${n}`,
    jobTitle: 'UI Engineer',
    loggedAt,
    reason: 'No answer in 5 min: sign-in',
    ...(task === undefined ? {} : { task }),
  });
}

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  const users = { userId: { in: [owner, other] } };
  await prisma.externalSubmission.deleteMany({ where: users });
  await prisma.notSubmittedJob.deleteMany({ where: users });
  await prisma.applyTask.deleteMany({ where: users });
  await prisma.application.deleteMany({ where: users });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('parseTaskInput', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  it('keeps the start, the offset and the plan in order', () => {
    expect(parseTaskInput(nightTask, now)).toEqual({
      startedAt: new Date('2026-11-20T15:32:10Z'),
      utcOffsetMinutes: 330,
      plan: nightTask.plan,
    });
    expect(offsetMinutes('2026-11-20T21:02:10Z')).toBe(0);
    expect(offsetMinutes('2026-11-20T09:02:10-04:00')).toBe(-240);
  });
  it('drops a malformed run or one in the future, never throws', () => {
    expect(parseTaskInput(undefined, now)).toBeNull();
    expect(parseTaskInput({ startedAt: NIGHT }, now)).toBeNull();
    expect(parseTaskInput({ startedAt: '24 Nov 9 pm', plan: [] }, now)).toBeNull();
    expect(parseTaskInput({ ...nightTask, extra: 1 }, now)).toBeNull();
    expect(parseTaskInput({ startedAt: '2026-11-26T09:00:00Z', plan: [] }, now)).toBeNull();
  });
  it('keeps the first number of a repeated plan item', () => {
    const plan = [
      { site: 'linkedin', planned: 10 },
      { site: 'linkedin', planned: 3 },
    ];
    expect(parseTaskInput({ startedAt: NIGHT, plan }, now)?.plan).toEqual([plan[0]]);
  });
});

describe('planCounts', () => {
  it('counts a job source by its source, other sites by platform, and adds sites outside the plan', () => {
    expect(
      planCounts(nightTask.plan, [
        { platform: 'linkedin', discoverySource: null },
        { platform: 'workday', discoverySource: 'the_reliable_jobs' },
        { platform: 'naukri', discoverySource: null },
      ]),
    ).toEqual([
      { site: 'linkedin', planned: 10, sent: 1 },
      { site: 'the_reliable_jobs', planned: 2, sent: 1 },
      { site: 'naukri', planned: null, sent: 1 },
    ]);
  });
});

describe('the task field on the tools', () => {
  it('makes the run on its first entry and reuses it for the next ones', async () => {
    const first = await submit(nightTask);
    const second = await submit(nightTask);
    const skipped = await notSubmitted(nightTask);
    const tasks = await prisma.applyTask.findMany({ where: { userId: owner } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].utcOffsetMinutes).toBe(330);
    const linked = await prisma.externalSubmission.findMany({
      where: { id: { in: [first.recordId, second.recordId] } },
      select: { taskId: true },
    });
    expect(linked.map((s) => s.taskId)).toEqual([tasks[0].id, tasks[0].id]);
    expect(
      (await prisma.notSubmittedJob.findUnique({ where: { id: skipped.recordId } }))?.taskId,
    ).toBe(tasks[0].id);
  });

  it('keeps the newest plan sent', async () => {
    await submit(nightTask);
    await submit({ ...nightTask, plan: [{ site: 'linkedin', planned: 12 }] });
    const task = await prisma.applyTask.findFirstOrThrow({ where: { userId: owner } });
    expect(task.plan).toEqual([{ site: 'linkedin', planned: 12 }]);
  });

  it('records the entry without a run when the run is malformed', async () => {
    const outcome = await submit({ startedAt: 'tonight', plan: 'linkedin 10' });
    expect(outcome.result).toBe('created');
    const stored = await prisma.externalSubmission.findUniqueOrThrow({
      where: { id: outcome.recordId },
    });
    expect(stored.taskId).toBeNull();
    expect((await notSubmitted({ startedAt: NIGHT })).result).toBe('recorded');
    expect(await prisma.applyTask.count({ where: { userId: owner } })).toBe(0);
  });

  it('adds the run to an entry first sent without one, and never moves it', async () => {
    const entry = {
      sourceRecordRef: '2026-11-20/21:30:00',
      platform: 'linkedin',
      company: 'Replay Co',
      jobTitle: 'Engineer',
      submittedAt: '2026-11-20T21:30:00+05:30',
    };
    await recordSubmission(owner, null, entry);
    const repeat = await recordSubmission(owner, null, { ...entry, task: nightTask });
    expect(repeat.result).toBe('already_recorded');
    const task = await prisma.applyTask.findFirstOrThrow({ where: { userId: owner } });
    const read = () =>
      prisma.externalSubmission.findUniqueOrThrow({ where: { id: repeat.recordId } });
    expect((await read()).taskId).toBe(task.id);
    await recordSubmission(owner, null, { ...entry, task: { startedAt: MORNING, plan: [] } });
    expect((await read()).taskId).toBe(task.id);
  });

  it('keeps runs per user', async () => {
    await submit(nightTask);
    await submit(nightTask, {}, other);
    expect(await prisma.applyTask.count({ where: { userId: owner } })).toBe(1);
    expect(await prisma.applyTask.count({ where: { userId: other } })).toBe(1);
  });
});

describe('GET /api/submissions/tasks', () => {
  it('lists runs newest first with counts, time taken and totals', async () => {
    await submit(nightTask, { submittedAt: '2026-11-20T21:10:00+05:30' });
    await submit(nightTask, {
      platform: 'workday',
      discoverySource: 'the_reliable_jobs',
      submittedAt: '2026-11-20T21:40:00+05:30',
    });
    await notSubmitted(nightTask, '2026-11-20T22:06:10+05:30');
    const ignored = await submit(nightTask);
    await prisma.externalSubmission.update({
      where: { id: ignored.recordId },
      data: { matchState: 'IGNORED' },
    });
    const morning = { startedAt: MORNING, plan: [{ site: 'workday', planned: 3 }] };
    await submit(morning, {
      platform: 'workday',
      submittedAt: '2026-11-21T10:47:00+05:30',
      sourceRecordRef: '2026-11-21/10:47:00',
    });
    await submit(undefined); // an older Apply version: no run
    await submit(nightTask, {}, other);

    const res = await request(app).get('/api/submissions/tasks').set(as(OWNER)).expect(200);
    const body = ListApplyTasksResponseSchema.parse(res.body);
    expect(body.items.map((t) => t.startedAt)).toEqual([
      '2026-11-21T04:45:00.000Z',
      '2026-11-20T15:32:10.000Z',
    ]);
    const [first, night] = body.items;
    expect(first).toMatchObject({ sent: 1, notSent: 0, lastAt: '2026-11-21T05:17:00.000Z' });
    expect(night).toMatchObject({
      utcOffsetMinutes: 330,
      sent: 2,
      notSent: 1,
      lastAt: '2026-11-20T16:36:10.000Z',
      plan: [
        { site: 'linkedin', planned: 10, sent: 1 },
        { site: 'the_reliable_jobs', planned: 2, sent: 1 },
      ],
    });
    // 32 min (morning) + 64 min (night)
    expect(body.summary).toEqual({ tasks: 2, sent: 3, minutes: 96, earlier: 1 });
  });

  it('pages and stays empty for a user with no runs', async () => {
    await submit(nightTask);
    await submit({ startedAt: MORNING, plan: [] });
    const page = await request(app).get('/api/submissions/tasks?limit=1').set(as(OWNER));
    expect(page.body.items).toHaveLength(1);
    expect(page.body.metadata.nextOffset).toBe(1);
    const none = await request(app).get('/api/submissions/tasks').set(as(OTHER)).expect(200);
    expect(none.body.items).toEqual([]);
    expect(none.body.summary).toEqual({ tasks: 0, sent: 0, minutes: 0, earlier: 0 });
  });

  it('needs a signed-in user', async () => {
    await request(app).get('/api/submissions/tasks').expect(401);
  });
});

describe('GET /api/applications?applyTask=', () => {
  it('lists one run’s applications, or the Apply applications that belong to none', async () => {
    await submit(nightTask, { company: 'Night Co' });
    await submit({ startedAt: MORNING, plan: [] }, { company: 'Morning Co' });
    await submit(undefined, { company: 'Old Co' });
    await prisma.application.create({ data: { userId: owner, companyName: 'By Hand Co' } });
    const night = await prisma.applyTask.findFirstOrThrow({
      where: { userId: owner, utcOffsetMinutes: 330, startedAt: new Date(NIGHT) },
    });
    const names = async (applyTask: string) =>
      (
        await request(app)
          .get(`/api/applications?archive=all&submittedVia=AUTOMATION&applyTask=${applyTask}`)
          .set(as(OWNER))
          .expect(200)
      ).body.items.map((a: { companyName: string }) => a.companyName);
    expect(await names(night.id)).toEqual(['Night Co']);
    expect(await names('none')).toEqual(['Old Co']);
    await request(app).get('/api/applications?applyTask=tonight').set(as(OWNER)).expect(400);
  });

  it('never shows another user’s run', async () => {
    await submit(nightTask, {}, other);
    const theirs = await prisma.applyTask.findFirstOrThrow({ where: { userId: other } });
    const res = await request(app)
      .get(`/api/applications?applyTask=${theirs.id}`)
      .set(as(OWNER))
      .expect(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('advertised task schema', () => {
  it('matches the validated contract on both tools', () => {
    for (const schema of [ADVERTISED_INPUT_SCHEMA, ADVERTISED_NOT_SUBMITTED_SCHEMA]) {
      const task = schema.properties.task;
      expect(Object.keys(task.properties).sort()).toEqual(
        Object.keys(ApplyTaskInputSchema.shape).sort(),
      );
      expect(task.required).toEqual(['startedAt', 'plan']);
      expect(
        new RegExp(task.properties.plan.items.properties.site.pattern).test('the_reliable_jobs'),
      ).toBe(true);
    }
  });
});
