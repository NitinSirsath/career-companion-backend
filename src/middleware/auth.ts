import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db/prisma';
import { devAuthEnabled } from '../utils/config';

export async function developmentAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (!devAuthEnabled()) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Development auth is available only in automated tests',
        },
      });
    }

    const devUserEmail = req.header('X-Development-User');
    if (!devUserEmail) {
      return res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', message: 'Missing X-Development-User header' } });
    }

    const user = await prisma.user.findUnique({
      where: { email: devUserEmail },
    });

    if (!user) {
      return res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', message: 'Development user not found' } });
    }

    req.auth = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };

    next();
  } catch (err) {
    next(err);
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (devAuthEnabled() && req.header('X-Development-User')) {
      return developmentAuthMiddleware(req, res, next);
    }

    if (!req.session?.userId) {
      return res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
    });

    if (!user) {
      // Session exists but user deleted from DB
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
    }

    req.auth = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
    next();
  } catch (err) {
    next(err);
  }
}
