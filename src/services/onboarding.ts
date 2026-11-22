/**
 * The guided first run (owner, 22 Nov 2026): shown once per account, right after the first sign-in.
 * The app saves each step the user reaches, so leaving halfway continues there on any device, and
 * finishing or skipping it ends it for good. Accounts made before it existed were marked done by
 * the migration and never see it.
 */
import { OnboardingStepSchema, type OnboardingStep } from '../contracts/auth';
import { prisma } from '../db/prisma';
import { logEvent } from '../utils/log';

/** The step to open, or null when the run is done. An unknown stored step starts again. */
export function onboardingOf(user: {
  onboardingStep: string;
  onboardingDoneAt: Date | null;
}): { step: OnboardingStep } | null {
  if (user.onboardingDoneAt) return null;
  const step = OnboardingStepSchema.safeParse(user.onboardingStep);
  return { step: step.success ? step.data : 'welcome' };
}

/** Remembers the step the user reached; a finished run stays finished. */
export async function saveOnboardingStep(userId: string, step: OnboardingStep) {
  await prisma.user.updateMany({
    where: { id: userId, onboardingDoneAt: null },
    data: { onboardingStep: step },
  });
}

/** Ends the first run: finished, or skipped from any step. Doing it twice changes nothing. */
export async function finishOnboarding(userId: string) {
  const { count } = await prisma.user.updateMany({
    where: { id: userId, onboardingDoneAt: null },
    // The step stays as it was: where the user finished or skipped.
    data: { onboardingDoneAt: new Date() },
  });
  if (count) logEvent('onboarding_finished', { userId });
}
