import { prisma } from '../../db/prisma';
import { TerminalAIError } from '../ai/errors';
import { testToolsEnabled } from '../../utils/config';

/**
 * Stored content of a test-inbox email, read in place of Gmail (`gmailFetcher.ts`). Refused when
 * test tools are off, so such an email fails once and is never sent to Gmail.
 */
export async function readSimulatedEmail(userId: string, gmailMessageId: string) {
  if (!testToolsEnabled()) throw new TerminalAIError('Test email unavailable: test tools are off');
  const content = await prisma.simulatedEmailContent.findFirst({
    where: { userId, email: { userId, gmailMessageId } },
    select: { labels: true, body: true },
  });
  if (!content) throw new TerminalAIError('Test email unavailable');
  return content;
}

/** Like Gmail's snippet: the start of the body on one line. */
export const simulatedSnippet = (body: string): string =>
  body.replace(/\s+/g, ' ').trim().slice(0, 200);
