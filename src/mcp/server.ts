/**
 * The MCP server: two write-only, idempotent tools (ADR-0002 decision 3, amended 21 Oct 2026):
 * `record_application_submission` for a confirmed application and `record_not_submitted_job` for
 * a job the automation did not apply to. No resources, no prompts, no read tools.
 *
 * Input is validated inside the handler with the strict intake schema, so every failure reaches
 * the client as `isError` with code `invalid_input` and the failing field names (never values).
 * The SDK is given a pass-through schema that advertises a plain JSON Schema of the same contract.
 */
import { AuthInfo, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  SUBMISSION_PLATFORMS,
  SUBMITTED_ANSWERS_LIMIT,
  SubmissionIntakeError,
  loggableFields,
  recordSubmission,
} from '../services/externalSubmission';
import {
  REASON_LIMIT,
  loggableNotSubmittedFields,
  recordNotSubmittedJob,
} from '../services/notSubmittedJob';
import { currentCall } from './callLog';

export const TOOL_NAME = 'record_application_submission';
export const NOT_SUBMITTED_TOOL_NAME = 'record_not_submitted_job';

export const ToolOutputSchema = z.object({
  result: z.enum(['created', 'linked', 'needs_review', 'already_recorded']),
  recordId: z.string(),
});
export const NotSubmittedToolOutputSchema = z.object({
  result: z.enum(['recorded', 'already_recorded']),
  recordId: z.string(),
});

const SOURCE_RECORD_REF = {
  type: 'string',
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{2}:[0-9]{2}:[0-9]{2}$',
  description:
    'YYYY-MM-DD/HH:MM:SS: the daily file folder date and the entry heading time, copied verbatim',
};
const HTTP_URL = (description: string) => ({
  type: 'string',
  format: 'uri',
  maxLength: 2048,
  description,
});

const text = (maxLength: number, description?: string) => ({
  type: 'string',
  maxLength,
  ...(description ? { description } : {}),
});

/**
 * The tool contract as advertised to clients: one plain JSON Schema object. Deliberately portable
 * (no null unions, type arrays, look-ahead patterns or $schema), because some MCP hosts pass tool
 * schemas to model APIs that accept only a subset of JSON Schema. The handler still validates with
 * the strict intake schema, which also accepts null for an optional field. A test keeps both in step.
 */
export const ADVERTISED_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    sourceRecordRef: SOURCE_RECORD_REF,
    platform: {
      type: 'string',
      enum: [...SUBMISSION_PLATFORMS],
      description:
        'The application workflow actually used (workday whenever a Workday form was used); never the discovery source',
    },
    company: { type: 'string', minLength: 1, maxLength: 200 },
    jobTitle: { type: 'string', minLength: 1, maxLength: 200 },
    submittedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'ISO 8601 with a UTC offset, for example 2026-10-01T09:15:00+05:30; when the site confirmed the submission',
    },
    jobUrl: HTTP_URL('http or https job URL'),
    portalJobId: text(200),
    destinationHost: text(
      253,
      'Hostname of the application destination only, for example jobs.lever.co',
    ),
    discoverySource: text(100, 'Where the job was found, for example we_work_remotely'),
    location: text(200),
    workMode: { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
    confirmationText: {
      type: 'string',
      description: 'The confirmation the site showed; longer text is truncated to 300 characters',
    },
    applyUrl: HTTP_URL('Full http or https URL of the page where the form was submitted'),
    resumeFilename: text(255, 'File name of the resume used, never its content'),
    submittedAnswers: {
      type: 'array',
      maxItems: SUBMITTED_ANSWERS_LIMIT,
      description: 'Every screening question and the answer given, as written in the daily file',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 500 },
          answer: { type: 'string', maxLength: 2000 },
        },
        required: ['question', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['sourceRecordRef', 'platform', 'company', 'jobTitle', 'submittedAt'],
  additionalProperties: false,
};

/** The not-submitted tool contract as advertised; same portability rules as above. */
export const ADVERTISED_NOT_SUBMITTED_SCHEMA = {
  type: 'object',
  properties: {
    sourceRecordRef: SOURCE_RECORD_REF,
    outcome: {
      type: 'string',
      enum: ['skipped', 'needs_user'],
      description: 'The entry status in the daily file',
    },
    platform: {
      type: 'string',
      enum: [...SUBMISSION_PLATFORMS],
      description: 'The platform or workflow the job belongs to; never the discovery source',
    },
    company: { type: 'string', minLength: 1, maxLength: 200 },
    jobTitle: { type: 'string', minLength: 1, maxLength: 200 },
    loggedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the entry was written, ISO 8601 with a UTC offset',
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: REASON_LIMIT,
      description: 'The skip reason, or the unanswered question or next action, from the entry',
    },
    jobUrl: HTTP_URL('http or https job URL'),
  },
  required: ['sourceRecordRef', 'outcome', 'platform', 'company', 'jobTitle', 'loggedAt', 'reason'],
  additionalProperties: false,
};

const advertised = (schema: Record<string, unknown>): StandardSchemaWithJSON<unknown, unknown> => ({
  '~standard': {
    version: 1,
    vendor: 'career-companion',
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => schema, output: () => schema },
  },
});

const RETRY = {
  invalid_input: 'Do not retry until the entry is fixed.',
  rate_limited: 'Retry the next UTC day.',
  unavailable: 'Retry later.',
} as const;
type ToolErrorCode = keyof typeof RETRY;

function toolError(code: ToolErrorCode, fields?: string[]) {
  const body = { code, ...(fields?.length ? { fields } : {}), retry: RETRY[code] };
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: true };
}

const DESCRIPTION = [
  "Record one job application that the user's own automation has just submitted, so it appears in Career Companion.",
  'Call it once per submission, only after the site showed a submission confirmation and the applied entry was appended to the daily file.',
  'Send only the listed fields, copied from that entry, including the resume file name and every submitted question and answer. Never send resume content, credentials, or skipped or needs_user entries.',
  'Idempotent on sourceRecordRef: a repeat returns already_recorded and only fills fields that are still empty. On invalid_input do not retry until the entry is fixed.',
].join(' ');

const NOT_SUBMITTED_DESCRIPTION = [
  "Record one job the user's own automation looked at but did not apply to (a skipped or needs_user entry in its daily file), with the reason.",
  'It never becomes an application. Call it at the end of a session for each such entry, with values copied from the entry. Never send credentials or resume content.',
  'Idempotent on sourceRecordRef: a repeat returns already_recorded. On invalid_input do not retry until the entry is fixed.',
].join(' ');

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Runs one tool call: identity from the token, the intake, and one log record; errors as `isError`. */
async function runTool<R extends { result: string; recordId: string; payloadDiffered?: boolean }>(
  tool: string,
  authInfo: AuthInfo | undefined,
  intake: (userId: string, tokenId: string) => Promise<R>,
  loggable: (fields: string[]) => object,
) {
  const call = currentCall();
  if (call) call.tool = tool;
  const identity = identityOf(authInfo);
  if (!identity) {
    if (call) call.outcome = 'unavailable';
    return toolError('unavailable');
  }
  try {
    const outcome = await intake(identity.userId, identity.tokenId);
    if (call) {
      call.outcome = outcome.result;
      if (outcome.payloadDiffered !== undefined) call.payloadDiffered = outcome.payloadDiffered;
    }
    const structuredContent = { result: outcome.result, recordId: outcome.recordId };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (err) {
    if (err instanceof SubmissionIntakeError) {
      if (call) {
        call.outcome = err.code;
        if (err.code === 'invalid_input') Object.assign(call, loggable(err.fields));
      }
      return toolError(err.code, err.fields);
    }
    if (call) {
      call.outcome = 'unavailable';
      call.errorCategory = err instanceof Error ? err.name : 'UnknownError';
    }
    return toolError('unavailable');
  }
}

/** The user and token always come from the verified bearer token, never from tool input. */
export function identityOf(authInfo: AuthInfo | undefined) {
  const extra = authInfo?.extra as { userId?: unknown; tokenId?: unknown } | undefined;
  if (typeof extra?.userId !== 'string' || typeof extra?.tokenId !== 'string') return null;
  return { userId: extra.userId, tokenId: extra.tokenId };
}

export function createMcpServer(authInfo: AuthInfo | undefined) {
  const server = new McpServer({ name: 'career-companion', version: '1.1.0' });
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Record application submission',
      description: DESCRIPTION,
      inputSchema: advertised(ADVERTISED_INPUT_SCHEMA),
      outputSchema: ToolOutputSchema,
      annotations: ANNOTATIONS,
    },
    (args: unknown) =>
      runTool(
        TOOL_NAME,
        authInfo,
        (userId, tokenId) => recordSubmission(userId, tokenId, args),
        loggableFields,
      ),
  );
  server.registerTool(
    NOT_SUBMITTED_TOOL_NAME,
    {
      title: 'Record a job not submitted',
      description: NOT_SUBMITTED_DESCRIPTION,
      inputSchema: advertised(ADVERTISED_NOT_SUBMITTED_SCHEMA),
      outputSchema: NotSubmittedToolOutputSchema,
      annotations: ANNOTATIONS,
    },
    (args: unknown) =>
      runTool(
        NOT_SUBMITTED_TOOL_NAME,
        authInfo,
        (userId, tokenId) => recordNotSubmittedJob(userId, tokenId, args),
        loggableNotSubmittedFields,
      ),
  );
  return server;
}
