import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AIProviderError, RetryableAIError, TerminalAIError } from './errors';

const MAX_ATTEMPTS = 3;

export function dailyCallLimit(): number {
  const value = Number(process.env.AI_DAILY_CALL_LIMIT ?? 100);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) {
    throw new TerminalAIError('Invalid AI_DAILY_CALL_LIMIT');
  }
  return value;
}

/** Durable external-effect boundary. Never replay a call with an unknown outcome. */
export async function runOperation<T>(
  userId: string,
  emailId: string,
  operation: string,
  version: string,
  schema: z.ZodType<T>,
  call: () => Promise<T>,
): Promise<T> {
  const owned = await prisma.email.findFirst({
    where: { id: emailId, userId },
    select: { id: true },
  });
  if (!owned) throw new TerminalAIError('Email unavailable');
  const key = { emailId, operation, version };
  await prisma.aIOperation.createMany({ data: [key], skipDuplicates: true });
  const existing = await prisma.aIOperation.findUniqueOrThrow({
    where: { emailId_operation_version: key },
  });
  if (existing.status === 'COMPLETED') {
    console.log(JSON.stringify({ event: 'ai_result_reused', emailId, operation, version }));
    return schema.parse(existing.result);
  }
  if (
    ['PROCESSING', 'UNKNOWN', 'FAILED'].includes(existing.status) ||
    existing.attempts >= MAX_ATTEMPTS
  ) {
    console.warn(
      JSON.stringify({
        event: 'ai_call_blocked',
        emailId,
        operation,
        version,
        status: existing.status,
        attempts: existing.attempts,
      }),
    );
    throw new TerminalAIError(`AI operation requires review: ${existing.status}`);
  }
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const limit = dailyCallLimit();
  await prisma.$transaction(async (tx) => {
    const claim = await tx.aIOperation.updateMany({
      where: {
        id: existing.id,
        status: { in: ['PENDING', 'RETRYABLE'] },
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
      },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, startedAt: now, errorCode: null },
    });
    if (claim.count !== 1) throw new RetryableAIError('AI operation not ready');
    await tx.aICallBudget.upsert({ where: { day }, create: { day }, update: {} });
    const reservation = await tx.aICallBudget.updateMany({
      where: {
        day,
        calls: { lt: limit },
        OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
      },
      data: { calls: { increment: 1 } },
    });
    if (!reservation.count) {
      console.warn(
        JSON.stringify({
          event: 'ai_call_deferred',
          emailId,
          operation,
          version,
          reason: 'budget_or_cooldown',
        }),
      );
      throw new RetryableAIError('AI daily budget or provider cooldown reached');
    }
  });
  console.log(
    JSON.stringify({
      event: 'ai_call_started',
      emailId,
      operation,
      version,
      attempt: existing.attempts + 1,
    }),
  );
  let result: T;
  try {
    result = schema.parse(await call());
  } catch (err) {
    const retryable = err instanceof AIProviderError && err.isRetryable;
    const retryAfter = retryable ? new Date(Date.now() + 60_000 * 2 ** existing.attempts) : null;
    // Network timeouts may have incurred a charge. Only an explicit rejection
    // classified as retryable by the adapter can release the claim for retry.
    await prisma.$transaction(async (tx) => {
      await tx.aIOperation.update({
        where: { id: existing.id },
        data: {
          status: retryable ? 'RETRYABLE' : err instanceof TerminalAIError ? 'FAILED' : 'UNKNOWN',
          errorCode: err instanceof AIProviderError ? err.name : 'OutcomeUnknown',
          retryAfter,
        },
      });
      if (retryAfter)
        await tx.aICallBudget.update({ where: { day }, data: { cooldownUntil: retryAfter } });
    });
    throw err;
  }
  // Deliberately outside the catch: persistence failure leaves PROCESSING.
  // Retrying the job cannot submit again when the provider succeeded but this write failed.
  await prisma.aIOperation.update({
    where: { id: existing.id },
    data: {
      status: 'COMPLETED',
      result: result as Prisma.InputJsonValue,
      completedAt: new Date(),
      retryAfter: null,
    },
  });
  console.log(
    JSON.stringify({
      event: 'ai_call_completed',
      emailId,
      operation,
      version,
      durationMs: Date.now() - now.getTime(),
    }),
  );
  return result;
}
