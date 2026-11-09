import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../config/container.js';
import { TASK_KINDS, TASK_STATUSES } from '../models/domain.js';
import { badRequest } from '../utils/errors.js';
import { pageParams, parse, uid } from '../middleware/http.js';
import { toMemory, toRepo, toTask } from '../models/mappers.js';

const CreateRepo = z.object({
  fullName: z.string().max(200).optional(),
  cloneUrl: z.string().max(500).optional(),
  localPath: z.string().max(500).optional(),
  branch: z.string().max(200).optional(),
});
const CreateTask = z.object({
  kind: z.enum(TASK_KINDS),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8000),
  autoApprove: z.boolean().optional(),
});

export function repoRoutes(c: Container): Router {
  const r = Router();

  r.post('/', async (req, res) => {
    const repo = await c.repos.create(uid(req), parse(CreateRepo, req.body));
    res.status(201).json(toRepo(repo));
  });
  r.get('/', async (req, res) => {
    res.json({ items: (await c.repos.list(uid(req))).map(toRepo) });
  });
  r.get('/:id', async (req, res) => {
    res.json(toRepo(await c.repos.get(uid(req), req.params.id)));
  });
  r.delete('/:id', async (req, res) => {
    await c.repos.remove(uid(req), req.params.id);
    res.json({ ok: true });
  });
  r.post('/:id/reindex', async (req, res) => {
    res.json(toRepo(await c.repos.reindex(uid(req), req.params.id)));
  });

  // ---- read-only proxies to the agent (ownership + readiness checked first) ----
  r.get('/:id/tree', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    res.json(await c.agent.tree(req.params.id));
  });
  r.get('/:id/file', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!path) throw badRequest('validation_error', 'path is required');
    res.json(await c.agent.file(req.params.id, path));
  });
  r.get('/:id/graph', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    res.json(await c.agent.graph(req.params.id));
  });
  r.get('/:id/health', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    const report = await c.agent.repoHealth(req.params.id);
    await c.repos.cacheHealth(req.params.id, report);
    res.json(report);
  });
  r.post('/:id/search', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    const { query } = parse(z.object({ query: z.string().trim().min(1).max(500) }), req.body);
    res.json(await c.agent.search(req.params.id, { query }));
  });
  r.post('/:id/explain', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    const body = parse(z.object({ path: z.string().min(1).max(500), question: z.string().max(2000).optional() }), req.body);
    const out = await c.agent.explain(req.params.id, body);
    await c.repos.recordUsage(req.params.id, out.usage);
    res.json(out);
  });
  r.post('/:id/bugs', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    const body = parse(z.object({ paths: z.array(z.string().max(500)).max(200).optional() }), req.body ?? {});
    const out = await c.agent.bugs(req.params.id, body);
    await c.repos.recordUsage(req.params.id, out.usage);
    await c.audit.record(uid(req), 'repo.bug_scan', req.params.id);
    res.json(out);
  });

  r.post('/:id/security', async (req, res) => {
    await c.repos.ready(uid(req), req.params.id);
    const out = await c.agent.security(req.params.id);
    await c.repos.recordUsage(req.params.id, out.usage);
    await c.audit.record(uid(req), 'repo.security_audit', req.params.id);
    res.json(out);
  });

  // ---- code intelligence ----
  r.get('/:id/semantic-search', async (req, res) => {
    await c.repos.ready(uid(req), String(req.params.id));
    const q = parse(z.object({ q: z.string().trim().min(1).max(500), mode: z.enum(['hybrid', 'bm25', 'semantic']).default('hybrid'), limit: z.coerce.number().int().min(1).max(50).default(10), rerank: z.enum(['true', 'false']).default('false') }), req.query);
    res.json(await c.agent.semanticSearch(String(req.params.id), q.q, q.mode, q.limit, q.rerank === 'true'));
  });
  r.get('/:id/symbols', async (req, res) => {
    await c.repos.ready(uid(req), String(req.params.id));
    const { path } = parse(z.object({ path: z.string().max(500).optional() }), req.query);
    res.json(await c.agent.symbols(String(req.params.id), path));
  });
  r.get('/:id/impact', async (req, res) => {
    await c.repos.ready(uid(req), String(req.params.id));
    const q = parse(z.object({ path: z.string().min(1).max(500), symbol: z.string().max(200).optional() }), req.query);
    res.json(await c.agent.impact(String(req.params.id), q.path, q.symbol));
  });
  r.get('/:id/callgraph', async (req, res) => {
    await c.repos.ready(uid(req), String(req.params.id));
    const { path } = parse(z.object({ path: z.string().max(500).optional() }), req.query);
    res.json(await c.agent.callgraph(String(req.params.id), path));
  });

  // ---- automation settings, PR reviews, CI autopilot ----
  r.patch('/:id/settings', async (req, res) => {
    const body = parse(z.object({ autoReview: z.boolean().optional(), autoFixCi: z.boolean().optional() }), req.body);
    res.json(toRepo(await c.repos.updateSettings(uid(req), String(req.params.id), body)));
  });
  r.get('/:id/reviews', async (req, res) => {
    await c.repos.get(uid(req), String(req.params.id));
    res.json({ items: await c.reviews.list(uid(req), String(req.params.id)) });
  });
  r.post('/:id/reviews', async (req, res) => {
    const body = parse(z.object({ number: z.number().int().min(1), post: z.boolean().default(false) }), req.body);
    res.status(201).json(await c.reviews.review(uid(req), String(req.params.id), body.number, { post: body.post, trigger: 'manual' }));
  });
  r.get('/:id/ci', async (req, res) => {
    res.json({ items: await c.ci.list(uid(req), String(req.params.id)) });
  });
  r.post('/:id/ci/:runId/fix', async (req, res) => {
    const runId = Number(req.params.runId);
    if (!Number.isInteger(runId) || runId < 1) throw badRequest('validation_error', 'runId must be a positive integer');
    res.status(201).json(await c.ci.fix(uid(req), String(req.params.id), runId));
  });

  // ---- issues (Issue -> PR autopilot) ----
  r.get('/:id/issues', async (req, res) => {
    res.json({ items: await c.issues.list(uid(req), req.params.id) });
  });
  r.post('/:id/issues/:number/run', async (req, res) => {
    const number = parse(z.coerce.number().int().min(1), req.params.number);
    res.status(201).json(toTask(await c.issues.run(uid(req), req.params.id, number)));
  });

  // ---- repo memory ----
  r.get('/:id/memory', async (req, res) => {
    res.json({ items: (await c.memory.list(uid(req), req.params.id)).map(toMemory) });
  });
  r.post('/:id/memory', async (req, res) => {
    await c.repos.get(uid(req), req.params.id);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(300) }), req.body);
    const note = await c.memory.add(uid(req), req.params.id, text, 'manual');
    res.status(201).json(note ? toMemory(note) : null);
  });
  r.delete('/:id/memory/:noteId', async (req, res) => {
    await c.memory.remove(uid(req), req.params.id, req.params.noteId);
    res.json({ ok: true });
  });
  r.delete('/:id/memory', async (req, res) => {
    res.json({ deleted: await c.memory.clear(uid(req), req.params.id) });
  });

  // ---- chat ----
  r.post('/:id/chat', async (req, res) => {
    const body = parse(z.object({ threadId: z.string().optional(), message: z.string().trim().min(1).max(4000) }), req.body);
    res.json(await c.repos.chat(uid(req), req.params.id, body.threadId, body.message));
  });
  r.get('/:id/chats', async (req, res) => {
    res.json({ items: await c.repos.chats(uid(req), req.params.id) });
  });
  r.get('/:id/chats/:threadId', async (req, res) => {
    res.json(await c.repos.thread(uid(req), req.params.id, req.params.threadId));
  });

  // ---- tasks for a repo ----
  r.post('/:id/tasks', async (req, res) => {
    const task = await c.tasks.create(uid(req), req.params.id, parse(CreateTask, req.body));
    res.status(201).json(toTask(task));
  });

  return r;
}

export const TaskListQuery = z.object({
  repoId: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
});
export { pageParams };
