import { prisma } from '../db/prisma';
import { CreateApplicationRequest, ApplicationResponse } from '../contracts';

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
        appliedAt: data.appliedAt ? new Date(data.appliedAt) : null,
      },
    });

    return this.mapToResponse(application);
  }

  static async listApplications(userId: string): Promise<ApplicationResponse[]> {
    const applications = await prisma.application.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return applications.map(this.mapToResponse);
  }

  private static mapToResponse(app: import('@prisma/client').Application): ApplicationResponse {
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
    };
  }

}
