/**
 * The MCP server: one write-only, idempotent tool, `record_application_submission` (ADR-0002
 * decision 3 and the v1 tool contract). No resources, no prompts, no read tools.
 *
 * Input is validated inside the handler with the strict intake schema, so every failure reaches
 * the client as `isError` with code `invalid_input` and the failing field names (never values).
 * The SDK is given a pass-through schema that advertises a plain JSON Schema of the same contract.
 */
import { AuthInfo, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  SUBMISSION_PLATFORMS,
  SubmissionIntakeError,
  SubmissionResult,
  loggableFields,
  recordSubmission,
} from '../services/externalSubmission';
import { currentCall } from './callLog';

export const TOOL_NAME = 'record_application_submission';

export const ToolOutputSchema = z.object({
  result: z.enum(['created', 'linked', 'needs_review', 'already_recorded']),
  recordId: z.string(),
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
    sourceRecordRef: {
      type: 'string',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{2}:[0-9]{2}:[0-9]{2}$',
      description:
        'YYYY-MM-DD/HH:MM:SS: the daily file folder date and the entry heading time, copied verbatim',
    },
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
    jobUrl: {
      type: 'string',
      format: 'uri',
      maxLength: 2048,
      description: 'http or https job URL',
    },
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
  },
  required: ['sourceRecordRef', 'platform', 'company', 'jobTitle', 'submittedAt'],
  additionalProperties: false,
};

const advertisedInput: StandardSchemaWithJSON<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'career-companion',
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => ADVERTISED_INPUT_SCHEMA, output: () => ADVERTISED_INPUT_SCHEMA },
  },
};

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
  'Send only the listed fields, copied from that entry. Never send submitted answers, resume content, credentials, or skipped or needs_user entries.',
  'Idempotent on sourceRecordRef: a repeat returns already_recorded. On invalid_input do not retry until the entry is fixed.',
].join(' ');

/** The user and token always come from the verified bearer token, never from tool input. */
export function identityOf(authInfo: AuthInfo | undefined) {
  const extra = authInfo?.extra as { userId?: unknown; tokenId?: unknown } | undefined;
  if (typeof extra?.userId !== 'string' || typeof extra?.tokenId !== 'string') return null;
  return { userId: extra.userId, tokenId: extra.tokenId };
}

export function createMcpServer(authInfo: AuthInfo | undefined) {
  const server = new McpServer({ name: 'career-companion', version: '1.0.0' });
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Record application submission',
      description: DESCRIPTION,
      inputSchema: advertisedInput,
      outputSchema: ToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: unknown) => {
      const call = currentCall();
      if (call) call.tool = TOOL_NAME;
      const identity = identityOf(authInfo);
      if (!identity) {
        if (call) call.outcome = 'unavailable';
        return toolError('unavailable');
      }
      try {
        const outcome = await recordSubmission(identity.userId, identity.tokenId, args);
        if (call) {
          call.outcome = outcome.result;
          if (outcome.payloadDiffered !== undefined) call.payloadDiffered = outcome.payloadDiffered;
        }
        const structuredContent: { result: SubmissionResult; recordId: string } = {
          result: outcome.result,
          recordId: outcome.recordId,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      } catch (err) {
        if (err instanceof SubmissionIntakeError) {
          if (call) {
            call.outcome = err.code;
            if (err.code === 'invalid_input') Object.assign(call, loggableFields(err.fields));
          }
          return toolError(err.code, err.fields);
        }
        if (call) {
          call.outcome = 'unavailable';
          call.errorCategory = err instanceof Error ? err.name : 'UnknownError';
        }
        return toolError('unavailable');
      }
    },
  );
  return server;
}
