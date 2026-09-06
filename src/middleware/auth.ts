import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db/prisma';

export async function developmentAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (process.env.ENABLE_DEV_AUTH !== 'true') {
      throw { name: 'UnauthorizedError', message: 'Development auth is not enabled in this environment' };
    }

    const devUserEmail = req.header('X-Development-User');
    if (!devUserEmail) {
      throw { name: 'UnauthorizedError', message: 'Missing X-Development-User header' };
    }

    const user = await prisma.user.findUnique({
      where: { email: devUserEmail },
    });

    if (!user) {
      throw { name: 'UnauthorizedError', message: 'Development user not found' };
    }

    req.auth = {
      user: {
        id: user.id,
      },
    };

    next();
  } catch (err) {
    next(err);
  }
}
