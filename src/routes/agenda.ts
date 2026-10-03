import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AgendaQuerySchema, UpdateAgendaSchema } from '../contracts/agenda';
import { readAgenda, updateAgenda } from '../services/agenda';
import { getPaginationParams } from '../utils/pagination';
export const agendaRouter = Router();
agendaRouter.use(requireAuth);
agendaRouter.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = getPaginationParams(req.query);
    res.json(
      await readAgenda(req.auth!.user.id, AgendaQuerySchema.parse(req.query), limit, offset),
    );
  } catch (error) {
    next(error);
  }
});
agendaRouter.patch('/:id', async (req, res, next) => {
  try {
    res.json(
      await updateAgenda(
        req.auth!.user.id,
        z.uuid().parse(req.params.id),
        UpdateAgendaSchema.parse(req.body),
      ),
    );
  } catch (error) {
    next(error);
  }
});
