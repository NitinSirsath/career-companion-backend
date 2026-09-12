import { MatcherService } from '../services/matcher';
import { prisma } from '../db/prisma';
import { ApplicationStatus, EmailMatchState } from '@prisma/client';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

describe('MatcherService', () => {
  let user: { id: string, email: string, googleId: string | null };

  beforeAll(async () => {
    user = await prisma.user.create({
      data: {
        email: 'test-matcher@example.com',
        googleId: 'matcher-123'
      }
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: user.id } });
  });

  afterEach(async () => {
    await prisma.applicationEvent.deleteMany();
    await prisma.action.deleteMany();
    await prisma.email.deleteMany();
    await prisma.application.deleteMany();
  });

  it('Tier 1: Exact Gmail thread match', async () => {
    const app = await prisma.application.create({
      data: { userId: user.id, companyName: 'Google', jobTitle: 'SWE' }
    });
    
    // Existing matched email in the same thread
    await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg1',
        threadId: 'threadA',
        matchState: EmailMatchState.MATCHED,
        applicationId: app.id
      }
    });

    // New email to process
    const newEmail = await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg2',
        threadId: 'threadA',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1',
            companyName: 'SomeOtherCompany' // Shouldn't matter for thread match
          }
        }
      }
    });

    await MatcherService.matchEmailToApplication(newEmail.id);

    const updatedEmail = await prisma.email.findUnique({ where: { id: newEmail.id } });
    expect(updatedEmail?.applicationId).toBe(app.id);
    expect(updatedEmail?.matchState).toBe(EmailMatchState.MATCHED);
    expect(updatedEmail?.matchConfirmedBy).toBe('AI_AUTO');
  });

  it('Tier 2: Company + Role match', async () => {
    const app = await prisma.application.create({
      data: { userId: user.id, companyName: 'Microsoft', jobTitle: 'Backend Engineer' }
    });

    const newEmail = await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg3',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1',
            companyName: 'Microsoft ',
            jobTitle: ' Backend  Engineer ' // Testing normalization
          }
        }
      }
    });

    await MatcherService.matchEmailToApplication(newEmail.id);

    const updatedEmail = await prisma.email.findUnique({ where: { id: newEmail.id } });
    expect(updatedEmail?.applicationId).toBe(app.id);
    expect(updatedEmail?.matchState).toBe(EmailMatchState.MATCHED);
  });

  it('Multiple candidates -> AMBIGUOUS', async () => {
    await prisma.application.create({
      data: { userId: user.id, companyName: 'Apple', jobTitle: 'Engineer' }
    });
    await prisma.application.create({
      data: { userId: user.id, companyName: 'Apple', jobTitle: 'Engineer' } // duplicate
    });

    const newEmail = await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg4',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1',
            companyName: 'Apple',
            jobTitle: 'Engineer'
          }
        }
      }
    });

    await MatcherService.matchEmailToApplication(newEmail.id);

    const updatedEmail = await prisma.email.findUnique({ where: { id: newEmail.id } });
    expect(updatedEmail?.applicationId).toBeNull();
    expect(updatedEmail?.matchState).toBe(EmailMatchState.AMBIGUOUS);
  });

  it('State Inference: Offer -> ApplicationStatus.OFFER', async () => {
    const app = await prisma.application.create({
      data: { userId: user.id, companyName: 'Netflix', aiStatus: ApplicationStatus.INTERVIEW }
    });

    const newEmail = await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg5',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1',
            companyName: 'Netflix',
            offerInfo: 'Offer details here',
            category: 'OFFER'
          }
        }
      }
    });

    await MatcherService.matchEmailToApplication(newEmail.id);

    const updatedApp = await prisma.application.findUnique({ where: { id: app.id } });
    expect(updatedApp?.aiStatus).toBe(ApplicationStatus.OFFER);

    // Event should be created
    const event = await prisma.applicationEvent.findFirst({ where: { applicationId: app.id } });
    expect(event).not.toBeNull();
    expect(event?.newState).toBe(ApplicationStatus.OFFER);
    expect(event?.emailId).toBe(newEmail.id);
  });

  it('Does not regress application state', async () => {
    const app = await prisma.application.create({
      data: { userId: user.id, companyName: 'Amazon', aiStatus: ApplicationStatus.OFFER }
    });

    // Email suggests INTERVIEW, but current state is OFFER
    const newEmail = await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg6',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1',
            companyName: 'Amazon',
            interviewStage: 'Onsite'
          }
        }
      }
    });

    await MatcherService.matchEmailToApplication(newEmail.id);

    const updatedApp = await prisma.application.findUnique({ where: { id: app.id } });
    expect(updatedApp?.aiStatus).toBe(ApplicationStatus.OFFER); // Should not regress

    // Event should still be created but with newState = OFFER
    const event = await prisma.applicationEvent.findFirst({ where: { applicationId: app.id } });
    expect(event).not.toBeNull();
    expect(event?.oldState).toBe(ApplicationStatus.OFFER);
    expect(event?.newState).toBe(ApplicationStatus.OFFER);
  });

  it('Idempotency: Reprocessing creates no duplicate events', async () => {
    const app = await prisma.application.create({
      data: { userId: user.id, companyName: 'Meta' }
    });

    const newEmail = await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg7',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1',
            companyName: 'Meta',
            actionRequired: true,
            requestedAction: 'Sign docs'
          }
        }
      }
    });

    await MatcherService.matchEmailToApplication(newEmail.id);
    await MatcherService.matchEmailToApplication(newEmail.id); // Process again

    const events = await prisma.applicationEvent.findMany({ where: { applicationId: app.id } });
    expect(events.length).toBe(1); // Only 1 event

    const actions = await prisma.action.findMany({ where: { applicationId: app.id } });
    expect(actions.length).toBe(1); // Only 1 action
  });
  
  it('User isolation: Cannot match another user application', async () => {
    const user2 = await prisma.user.create({
      data: {
        email: 'user2@example.com',
        googleId: 'u2'
      }
    });
    
    // user2 has an application
    await prisma.application.create({
      data: { userId: user2.id, companyName: 'Stripe' }
    });

    // user1 receives email about Stripe
    const newEmail = await prisma.email.create({
      data: {
        userId: user.id,
        gmailMessageId: 'msg8',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1',
            companyName: 'Stripe',
          }
        }
      }
    });

    await MatcherService.matchEmailToApplication(newEmail.id);

    const updatedEmail = await prisma.email.findUnique({ where: { id: newEmail.id } });
    expect(updatedEmail?.applicationId).toBeNull(); // Should not match user2's app
    expect(updatedEmail?.matchState).toBe(EmailMatchState.UNMATCHED);
    
    await prisma.user.delete({ where: { id: user2.id } });
  });
});
