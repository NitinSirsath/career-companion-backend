import { prisma } from '../db/prisma';
import { ApplicationStatus, EmailMatchState, EmailRelevanceState, AIProcessingResult, MatchConfirmationSource } from '@prisma/client';
import { enqueueNotificationJob } from '../jobs/notificationJob';

export class MatcherService {
  /**
   * Run the matching logic for an email.
   * Returns the applicationId if matched, or undefined.
   */
  static async matchEmailToApplication(emailId: string): Promise<void> {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: { aiProcessingResult: true }
    });

    if (!email || !email.aiProcessingResult) {
      return;
    }

    const { aiProcessingResult, userId, matchConfirmedBy, applicationId } = email;

    if (matchConfirmedBy === MatchConfirmationSource.USER_CONFIRMED && !applicationId) return;

    if (matchConfirmedBy === MatchConfirmationSource.USER_CONFIRMED && applicationId) {
      // Re-apply the match using the existing user-confirmed application to allow 
      // new AI data (e.g. actions/state) to be recorded, but PRESERVE the user's decision.
      await this.applyMatch(email.id, applicationId, aiProcessingResult, MatchConfirmationSource.USER_CONFIRMED);
      return;
    }

    // 1. Thread Match
    if (email.threadId) {
      const threadMatch = await prisma.email.findFirst({
        where: {
          userId,
          threadId: email.threadId,
          matchState: EmailMatchState.MATCHED,
          applicationId: { not: null },
          id: { not: email.id }
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }]
      });

      if (threadMatch && threadMatch.applicationId) {
        await this.applyMatch(email.id, threadMatch.applicationId, aiProcessingResult, MatchConfirmationSource.AI_AUTO);
        return;
      }
    }

    // 2. Company + Role Match
    const companyName = aiProcessingResult.companyName;
    const role = aiProcessingResult.jobTitle;

    if (!companyName) {
      // If we don't have a company name, we can't do a deterministic match
      return;
    }

    // Normalize
    const normalizedCompany = this.normalize(companyName);
    const normalizedRole = role ? this.normalize(role) : null;

    // Find candidate applications for this user
    const applications = await prisma.application.findMany({
      where: { userId }
    });

    const candidates = applications.filter(app => {
      const appCompany = this.normalize(app.companyName);
      if (appCompany !== normalizedCompany) return false;

      if (normalizedRole && app.jobTitle) {
        const appRole = this.normalize(app.jobTitle);
        if (appRole !== normalizedRole) return false;
      }

      return true;
    });

    if (candidates.length === 1) {
      // Exact match
      await this.applyMatch(email.id, candidates[0].id, aiProcessingResult, MatchConfirmationSource.AI_AUTO);
    } else if (candidates.length > 1) {
      // Ambiguous
      await prisma.email.updateMany({
        where: { id: email.id, OR: [{ matchConfirmedBy: null }, { matchConfirmedBy: { not: MatchConfirmationSource.USER_CONFIRMED } }] },
        data: { matchState: EmailMatchState.AMBIGUOUS }
      });
    }
  }

  private static normalize(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  public static async applyMatch(
    emailId: string, 
    applicationId: string, 
    aiResult: AIProcessingResult,
    source: MatchConfirmationSource
  ) {
    const actionId = await prisma.$transaction(async tx => {
      // Serialize domain effects for this email and application, inside the DB transaction.
      await tx.$queryRaw`SELECT id FROM emails WHERE id = ${emailId}::uuid FOR UPDATE`;
      const email = await tx.email.findUnique({ where: { id: emailId } });
      if (!email || aiResult.emailId !== emailId) throw new Error('EMAIL_NOT_FOUND');
      if (source === MatchConfirmationSource.AI_AUTO && email.matchConfirmedBy === MatchConfirmationSource.USER_CONFIRMED) return null;
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid AND "userId" = ${email.userId}::uuid FOR UPDATE`;
      const app = await tx.application.findFirst({ where: { id: applicationId, userId: email.userId } });
      if (!app) throw new Error('APPLICATION_NOT_FOUND');
      // A concurrent manual resolution wins once; do not move already created domain effects.
      if (source === MatchConfirmationSource.USER_CONFIRMED && email.matchConfirmedBy === source && email.applicationId !== applicationId) throw new Error('INVALID_MATCH_STATE');
      await tx.email.update({ where: { id: emailId }, data: {
        applicationId, matchState: EmailMatchState.MATCHED, matchConfirmedBy: source,
      } });
      const newState = this.inferState(aiResult);
      const finalState = newState && this.canTransition(app.aiStatus, newState) ? newState : app.aiStatus;
      if (finalState !== app.aiStatus) await tx.application.update({ where: { id: applicationId }, data: { aiStatus: finalState } });
      const existingEvent = await tx.applicationEvent.findFirst({ where: { applicationId, emailId, type: 'EMAIL_PROCESSED' } });
      if (!existingEvent) await tx.applicationEvent.create({ data: {
        applicationId, emailId, type: 'EMAIL_PROCESSED', oldState: app.aiStatus, newState: finalState,
        description: newState ? `Received relevant email suggesting state ${newState}` : 'Received relevant email',
        provenance: aiResult.provenance,
      } });
      if (!aiResult.actionRequired && !aiResult.followUpRequired) return null;
      const existingAction = await tx.action.findFirst({ where: { applicationId, emailId } });
      if (existingAction) return existingAction.id;
      const deadlineText = aiResult.actionRequired ? aiResult.actionDeadline : aiResult.followUpDate;
      const deadline = deadlineText ? new Date(deadlineText) : null;
      const action = await tx.action.create({ data: {
        applicationId, emailId,
        type: aiResult.actionRequired ? 'ACTION_REQUIRED' : 'FOLLOW_UP_REQUIRED',
        description: aiResult.actionRequired ? aiResult.requestedAction || 'Action required' : 'Follow up required',
        deadline: deadline && !isNaN(deadline.getTime()) ? deadline : null,
      } });
      return action.id;
    });
    if (actionId) {
      try { await enqueueNotificationJob(actionId); }
      catch { console.error(JSON.stringify({ event: 'notification_enqueue_failed', actionId })); }
    }
  }

  public static async getAmbiguousMatches(userId: string, limit: number = 20, offset: number = 0) {
    return prisma.email.findMany({
      where: {
        userId,
        matchState: EmailMatchState.AMBIGUOUS
      },
      take: limit + 1,
      skip: offset,
      include: {
        aiProcessingResult: true
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }]
    });
  }

  /**
   * Get relevant emails that had zero candidate applications during matching.
   * These need user-driven resolution to link them to an existing application.
   */
  public static async getUnmatchedEmails(userId: string, limit: number = 20, offset: number = 0) {
    return prisma.email.findMany({
      where: {
        userId,
        relevanceState: EmailRelevanceState.RELEVANT,
        matchState: EmailMatchState.UNMATCHED,
      },
      take: limit + 1,
      skip: offset,
      include: {
        aiProcessingResult: true,
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Resolve an email that needs human-in-the-loop matching.
   * Supports both AMBIGUOUS (multiple candidates) and UNMATCHED (zero candidates) emails.
   *
   * For AMBIGUOUS: applicationId can be null (→ IGNORED) or a valid application ID.
   * For UNMATCHED: applicationId must be non-null (linking to an application is mandatory).
   */
  public static async resolveEmailMatch(userId: string, emailId: string, applicationId: string | null): Promise<void> {
    const email = await prisma.email.findUnique({
      where: { id: emailId, userId }, // isolation check
      include: { aiProcessingResult: true }
    });

    if (!email) {
      throw new Error('EMAIL_NOT_FOUND');
    }

    // Validate match state — only AMBIGUOUS and UNMATCHED can be resolved
    if (email.matchState !== EmailMatchState.AMBIGUOUS && email.matchState !== EmailMatchState.UNMATCHED) {
      throw new Error('INVALID_MATCH_STATE');
    }

    // UNMATCHED emails require an applicationId (linking is mandatory)
    if (email.matchState === EmailMatchState.UNMATCHED && !applicationId) {
      throw new Error('APPLICATION_REQUIRED_FOR_UNMATCHED');
    }

    if (!applicationId) {
      // No match — only valid for AMBIGUOUS emails
      const ignored = await prisma.email.updateMany({
        where: { id: emailId, userId, matchState: 'AMBIGUOUS' },
        data: {
          matchState: EmailMatchState.IGNORED,
          matchConfirmedBy: MatchConfirmationSource.USER_CONFIRMED
        }
      });
      if (!ignored.count) throw new Error('INVALID_MATCH_STATE');
      return;
    }

    // Ownership check for application
    const app = await prisma.application.findUnique({
      where: { id: applicationId, userId } // isolation check
    });

    if (!app) {
      throw new Error('APPLICATION_NOT_FOUND');
    }

    if (!email.aiProcessingResult) {
      throw new Error('NO_AI_RESULT');
    }

    await this.applyMatch(email.id, applicationId, email.aiProcessingResult, MatchConfirmationSource.USER_CONFIRMED);
  }

  private static inferState(aiResult: AIProcessingResult): ApplicationStatus | null {
    if (aiResult.rejectionInfo || aiResult.category === 'REJECTION') return ApplicationStatus.REJECTED;
    if (aiResult.offerInfo || aiResult.category === 'OFFER') return ApplicationStatus.OFFER;
    if (aiResult.interviewStage || aiResult.interviewDate || aiResult.category === 'INTERVIEW') return ApplicationStatus.INTERVIEW;
    if (aiResult.assessmentInfo || aiResult.category === 'ASSESSMENT') return ApplicationStatus.ASSESSMENT;
    if (aiResult.recruiterName || aiResult.category === 'RECRUITER') return ApplicationStatus.RECRUITER_CONTACT;
    return null;
  }

  private static canTransition(current: ApplicationStatus | null, next: ApplicationStatus): boolean {
    if (!current) return true;
    
    const stateOrder: Record<ApplicationStatus, number> = {
      APPLIED: 0,
      RECRUITER_CONTACT: 1,
      ASSESSMENT: 2,
      INTERVIEW: 3,
      OFFER: 4,
      REJECTED: 5,
      CLOSED: 6
    };

    return stateOrder[next] >= stateOrder[current];
  }
}
