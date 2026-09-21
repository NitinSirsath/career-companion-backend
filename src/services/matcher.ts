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
        orderBy: { receivedAt: 'desc' }
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
      await prisma.email.update({
        where: { id: email.id },
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
    // 1. Mark Email as matched
    const email = await prisma.email.update({
      where: { id: emailId },
      data: {
        applicationId,
        matchState: EmailMatchState.MATCHED,
        matchConfirmedBy: source
      }
    });

    const app = await prisma.application.findUnique({
      where: { id: applicationId }
    });
    if (!app) return;

    // 2. Infer State
    const newState = this.inferState(aiResult);
    let finalState = app.aiStatus;

    if (newState) {
      if (this.canTransition(app.aiStatus, newState)) {
        finalState = newState;
        await prisma.application.update({
          where: { id: applicationId },
          data: { aiStatus: finalState }
        });
      }
    }

    // 3. Create Event (Idempotent: check if event from this email exists)
    const existingEvent = await prisma.applicationEvent.findFirst({
      where: { applicationId, emailId: email.id }
    });

    if (!existingEvent) {
      let description = "Received relevant email";
      if (newState) {
        description += ` suggesting state ${newState}`;
      }
      
      await prisma.applicationEvent.create({
        data: {
          applicationId,
          emailId: email.id,
          type: 'EMAIL_PROCESSED',
          oldState: app.aiStatus,
          newState: finalState,
          description,
          provenance: aiResult.provenance
        }
      });
    }

    // 4. Create Action (Idempotent)
    if (aiResult.actionRequired || aiResult.followUpRequired) {
      const existingAction = await prisma.action.findFirst({
        where: { applicationId, emailId: email.id }
      });

      if (!existingAction) {
        let type = '';
        let desc = '';
        let deadline = null;

        if (aiResult.actionRequired) {
          type = 'ACTION_REQUIRED';
          desc = aiResult.requestedAction || 'Action required';
          deadline = aiResult.actionDeadline ? new Date(aiResult.actionDeadline) : null;
        } else if (aiResult.followUpRequired) {
          type = 'FOLLOW_UP_REQUIRED';
          desc = 'Follow up required';
          deadline = aiResult.followUpDate ? new Date(aiResult.followUpDate) : null;
        }

        // Only create if we have a valid deadline or if we don't care about NaN.
        // Let's just create it.
        const createdAction = await prisma.action.create({
          data: {
            applicationId,
            emailId: email.id,
            type,
            description: desc,
            deadline: deadline && !isNaN(deadline.getTime()) ? deadline : null
          }
        });
        
        try {
          // Fire-and-forget enqueue to avoid failing the transaction/process
          await enqueueNotificationJob(createdAction.id);
        } catch (jobErr) {
          console.error('[Matcher] Failed to enqueue notification job', jobErr);
        }
      }
    }
  }

  public static async getAmbiguousMatches(userId: string) {
    return prisma.email.findMany({
      where: {
        userId,
        matchState: EmailMatchState.AMBIGUOUS
      },
      include: {
        aiProcessingResult: true
      },
      orderBy: {
        receivedAt: 'desc'
      }
    });
  }

  /**
   * Get relevant emails that had zero candidate applications during matching.
   * These need user-driven resolution to link them to an existing application.
   */
  public static async getUnmatchedEmails(userId: string) {
    return prisma.email.findMany({
      where: {
        userId,
        relevanceState: EmailRelevanceState.RELEVANT,
        matchState: EmailMatchState.UNMATCHED,
      },
      include: {
        aiProcessingResult: true,
      },
      orderBy: {
        receivedAt: 'desc',
      },
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
      await prisma.email.update({
        where: { id: emailId },
        data: {
          matchState: EmailMatchState.IGNORED,
          matchConfirmedBy: MatchConfirmationSource.USER_CONFIRMED
        }
      });
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
