import { Request, Response, NextFunction } from 'express';
import type { User } from '@prisma/client';
import { prisma } from '../db/prisma';
import { devAuthEnabled, isAdminEmail } from '../utils/config';

/**
 * Who a route lets in:
 * - `active`: a signed-in account that is not suspended (every app route);
 * - `allowSuspended`: any signed-in account, also a suspended one (the profile and the resume request);
 * - `admin`: an account in ADMIN_EMAILS that is not suspended. Anyone else gets 404, also when signed
 *   out, so the Admin page does not show that it exists.
 */
type Access = 'active' | 'allowSuspended' | 'admin';

/** "Last active" is written at most once an hour per account (owner, 18 Nov 2026). */
const LAST_ACTIVE_STEP_MS = 60 * 60_000;

function refuse(res: Response, access: Access, message: string) {
  if (access === 'admin')
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  return res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
}

async function touchLastActive(user: User, now = new Date()) {
  if (user.lastActiveAt && now.getTime() - user.lastActiveAt.getTime() < LAST_ACTIVE_STEP_MS)
    return;
  await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [
        { lastActiveAt: null },
        { lastActiveAt: { lt: new Date(now.getTime() - LAST_ACTIVE_STEP_MS) } },
      ],
    },
    data: { lastActiveAt: now },
  });
}

async function admit(
  req: Request,
  res: Response,
  next: NextFunction,
  { user, access }: { user: User; access: Access },
) {
  await touchLastActive(user);
  if (access === 'admin' && (!isAdminEmail(user.email) || user.suspendedAt))
    return refuse(res, access, 'Not found');
  if (access === 'active' && user.suspendedAt) {
    return res.status(403).json({
      error: { code: 'ACCOUNT_SUSPENDED', message: 'Your account is suspended.' },
    });
  }
  req.auth = { user: { id: user.id, email: user.email, name: user.name } };
  next();
}

async function developmentAuth(req: Request, res: Response, next: NextFunction, access: Access) {
  if (!devAuthEnabled())
    return refuse(res, access, 'Development auth is available only in automated tests');
  const devUserEmail = req.header('X-Development-User');
  if (!devUserEmail) return refuse(res, access, 'Missing X-Development-User header');
  const user = await prisma.user.findUnique({ where: { email: devUserEmail } });
  if (!user) return refuse(res, access, 'Development user not found');
  return admit(req, res, next, { user, access });
}

export async function developmentAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    await developmentAuth(req, res, next, 'active');
  } catch (err) {
    next(err);
  }
}

function signedIn(access: Access) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (devAuthEnabled() && req.header('X-Development-User'))
        return await developmentAuth(req, res, next, access);
      if (!req.session?.userId) return refuse(res, access, 'Not authenticated');
      const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
      // Session exists but user deleted from DB
      if (!user) return refuse(res, access, 'User not found');
      await admit(req, res, next, { user, access });
    } catch (err) {
      next(err);
    }
  };
}

/** A signed-in account that is not suspended: suspended ones get 403 ACCOUNT_SUSPENDED. */
export const requireAuth = signedIn('active');
/** Any signed-in account, also a suspended one. */
export const requireSignedIn = signedIn('allowSuspended');
/** An admin (ADMIN_EMAILS) that is not suspended; anyone else, signed in or not, gets 404. */
export const requireAdmin = signedIn('admin');
