import { Router, Request, Response, NextFunction } from 'express';
import { CreateApplicationRequestSchema } from '../contracts';
import { ApplicationService } from '../services/application';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = CreateApplicationRequestSchema.parse(req.body);
    const userId = req.auth!.user.id;

    const application = await ApplicationService.createApplication(userId, data);
    res.status(201).json(application);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;

    const applications = await ApplicationService.listApplications(userId);
    res.status(200).json(applications);
  } catch (err) {
    next(err);
  }
});

export const applicationRouter = router;
