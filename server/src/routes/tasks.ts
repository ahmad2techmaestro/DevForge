import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../config/container.js';
import { pageParams, parse, uid } from '../middleware/http.js';
import { toApproval, toTask } from '../models/mappers.js';
import { TaskListQuery } from './repos.js';

const Decision = z.object({
  decision: z.enum(['approve', 'reject']),
  feedback: z.string().max(4000).optional(),
  editedPlan: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
});
const PrInput = z.object({
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(20_000).optional(),
  draft: z.boolean().optional(),
  branch: z.string().regex(/^[\w./-]{1,100}$/).optional(),
});

export function taskRoutes(c: Container): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const filter = parse(TaskListQuery, { repoId: req.query.repoId, status: req.query.status });
    const { limit, offset } = pageParams(req.query);
    const page = await c.tasks.list(uid(req), filter, limit, offset);
    res.json({ items: page.items.map(toTask), nextCursor: page.nextCursor });
  });
  r.get('/:id', async (req, res) => {
    const { task, events, approvals } = await c.tasks.detail(uid(req), req.params.id);
    res.json({ task: toTask(task), events, approvals: approvals.map(toApproval) });
  });
  r.post('/:id/cancel', async (req, res) => {
    res.json(toTask(await c.tasks.cancel(uid(req), req.params.id)));
  });
  r.post('/:id/approvals/:approvalId', async (req, res) => {
    const out = await c.tasks.decide(uid(req), req.params.id, req.params.approvalId, parse(Decision, req.body));
    res.json({ task: toTask(out.task), approval: toApproval(out.approval) });
  });
  r.get('/:id/diff', async (req, res) => {
    const task = await c.tasks.get(uid(req), req.params.id);
    res.json(await c.agent.diff(task.runId));
  });
  r.post('/:id/pr', async (req, res) => {
    const out = await c.tasks.createPr(uid(req), req.params.id, parse(PrInput, req.body ?? {}));
    res.json({ task: toTask(out.task), pr: out.pr });
  });

  return r;
}
