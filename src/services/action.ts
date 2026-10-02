import { prisma } from '../db/prisma';
import { ActionWithContextResponse } from '../contracts';

export class ActionService {
  static async getUserActions(
    userId: string,
    status?: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<ActionWithContextResponse[]> {
    const actions = await prisma.action.findMany({
      where: {
        application: {
          userId,
        },
        ...(status ? { status } : {}),
      },
      take: limit + 1,
      skip: offset,
      orderBy: [
        { status: 'desc' }, // Pending work comes before resolved actions.
        { deadline: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      include: {
        application: {
          select: {
            companyName: true,
            jobTitle: true,
          },
        },
        email: {
          select: {
            subject: true,
            sender: true,
            threadId: true,
            gmailMessageId: true,
          },
        },
      },
    });

    return actions.map((action) => ({
      id: action.id,
      applicationId: action.applicationId,
      emailId: action.emailId,
      type: action.type,
      description: action.description,
      deadline: action.deadline ? action.deadline.toISOString() : null,
      deadlinePrecision: action.deadlinePrecision,
      status: action.status,
      createdAt: action.createdAt.toISOString(),
      application: {
        companyName: action.application.companyName,
        jobTitle: action.application.jobTitle,
      },
      email: action.email
        ? {
            subject: action.email.subject,
            sender: action.email.sender,
            threadId: action.email.threadId,
            gmailMessageId: action.email.gmailMessageId,
          }
        : null,
    }));
  }

  static async updateActionStatus(
    userId: string,
    actionId: string,
    status: string,
  ): Promise<ActionWithContextResponse | null> {
    // 1. Verify ownership (cannot mutate another user's action)
    const existingAction = await prisma.action.findFirst({
      where: {
        id: actionId,
        application: {
          userId,
        },
      },
    });

    if (!existingAction) {
      return null; // Return null to indicate 404/403
    }

    // 2. Update idempotently
    if (existingAction.status === status) {
      // It's already the requested status, we just return the full object.
      // We'll refetch via a generic method or just re-run the query.
    } else {
      await prisma.action.update({
        where: { id: actionId },
        data: { status },
      });
    }

    // 3. Return the updated action with context
    const updatedAction = await prisma.action.findUnique({
      where: { id: actionId },
      include: {
        application: {
          select: {
            companyName: true,
            jobTitle: true,
          },
        },
        email: {
          select: {
            subject: true,
            sender: true,
            threadId: true,
            gmailMessageId: true,
          },
        },
      },
    });

    if (!updatedAction) return null;

    return {
      id: updatedAction.id,
      applicationId: updatedAction.applicationId,
      emailId: updatedAction.emailId,
      type: updatedAction.type,
      description: updatedAction.description,
      deadline: updatedAction.deadline ? updatedAction.deadline.toISOString() : null,
      deadlinePrecision: updatedAction.deadlinePrecision,
      status: updatedAction.status,
      createdAt: updatedAction.createdAt.toISOString(),
      application: {
        companyName: updatedAction.application.companyName,
        jobTitle: updatedAction.application.jobTitle,
      },
      email: updatedAction.email
        ? {
            subject: updatedAction.email.subject,
            sender: updatedAction.email.sender,
            threadId: updatedAction.email.threadId,
            gmailMessageId: updatedAction.email.gmailMessageId,
          }
        : null,
    };
  }
}
