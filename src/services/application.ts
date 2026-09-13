import { prisma } from '../db/prisma';
import {
  CreateApplicationRequest,
  ApplicationResponse,
  ApplicationEventResponse,
  ApplicationActionResponse,
} from '../contracts';

export class ApplicationService {
  static async createApplication(
    userId: string,
    data: CreateApplicationRequest
  ): Promise<ApplicationResponse> {
    const application = await prisma.application.create({
      data: {
        userId,
        companyName: data.companyName,
        jobTitle: data.jobTitle,
        location: data.location,
        appliedAt: data.appliedAt ? new Date(data.appliedAt as string) : null,
      },
    });

    return this.mapToResponse(application, null, 0);
  }

  static async listApplications(userId: string): Promise<ApplicationResponse[]> {
    const applications = await prisma.application.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        events: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { type: true, createdAt: true },
        },
        actions: {
          where: { status: 'PENDING' },
          select: { id: true },
        },
      },
    });

    return applications.map((app) =>
      this.mapToResponse(
        app,
        app.events[0] ?? null,
        app.actions.length
      )
    );
  }

  /**
   * Returns the timeline events for a specific application.
   * Verifies that the application belongs to the requesting user.
   * Ordered by createdAt ASC for deterministic chronological display.
   */
  static async getApplicationEvents(
    userId: string,
    applicationId: string
  ): Promise<ApplicationEventResponse[] | null> {
    // Verify ownership before returning any data
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { userId: true },
    });

    if (!app) return null;
    if (app.userId !== userId) return null; // caller should return 403

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'asc' }, // deterministic chronological order
      select: {
        id: true,
        applicationId: true,
        emailId: true,
        type: true,
        oldState: true,
        newState: true,
        description: true,
        provenance: true,
        createdAt: true,
      },
    });

    return events.map((e) => ({
      id: e.id,
      applicationId: e.applicationId,
      emailId: e.emailId,
      type: e.type,
      oldState: e.oldState as ApplicationEventResponse['oldState'],
      newState: e.newState as ApplicationEventResponse['newState'],
      description: e.description,
      provenance: e.provenance,
      createdAt: e.createdAt,
    }));
  }

  /**
   * Returns the actions for a specific application.
   * Verifies that the application belongs to the requesting user.
   * Ordered by deadline ASC (PENDING first), then createdAt ASC.
   */
  static async getApplicationActions(
    userId: string,
    applicationId: string
  ): Promise<ApplicationActionResponse[] | null> {
    // Verify ownership
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { userId: true },
    });

    if (!app) return null;
    if (app.userId !== userId) return null;

    const actions = await prisma.action.findMany({
      where: { applicationId },
      orderBy: [
        { status: 'asc' }, // PENDING sorts before others alphabetically
        { deadline: 'asc' },
        { createdAt: 'asc' },
      ],
      select: {
        id: true,
        applicationId: true,
        emailId: true,
        type: true,
        description: true,
        deadline: true,
        status: true,
        createdAt: true,
      },
    });

    return actions.map((a) => ({
      id: a.id,
      applicationId: a.applicationId,
      emailId: a.emailId,
      type: a.type,
      description: a.description,
      deadline: a.deadline,
      status: a.status,
      createdAt: a.createdAt,
    }));
  }

  private static mapToResponse(
    app: import('@prisma/client').Application,
    recentEvent: { type: string; createdAt: Date } | null,
    pendingActionCount: number
  ): ApplicationResponse {
    return {
      id: app.id,
      companyName: app.companyName,
      jobTitle: app.jobTitle,
      location: app.location,
      aiStatus: app.aiStatus as unknown as ApplicationResponse['aiStatus'],
      userStatus: app.userStatus as unknown as ApplicationResponse['userStatus'],
      userStatusSetAt: app.userStatusSetAt,
      appliedAt: app.appliedAt,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      recentEvent: recentEvent
        ? { type: recentEvent.type, createdAt: recentEvent.createdAt }
        : null,
      pendingActionCount,
    };
  }
}
