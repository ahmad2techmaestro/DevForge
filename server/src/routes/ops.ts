import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../config/container.js';
import { safeEqual } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { pageParams, parse, uid } from '../middleware/http.js';
import { toAudit, toMcp } from '../models/mappers.js';
import { verifySignature } from '../services/issues.js';

export function opsRoutes(c: Container): Router {
  const r = Router();
  r.get('/budget', async (req, res) => {
    res.json(await c.budget.status(uid(req)));
  });
  r.put('/budget', async (req, res) => {
    const { budgetUsd } = parse(z.object({ budgetUsd: z.number().min(0).max(100000).nullable() }), req.body);
    await c.audit.record(uid(req), 'budget.set', String(budgetUsd));
    res.json(await c.budget.set(uid(req), budgetUsd));
  });
  r.get('/notifications', async (req, res) => {
    res.json(await c.notify.get(uid(req)));
  });
  r.put('/notifications', async (req, res) => {
    const body = parse(z.object({ slackUrl: z.string().max(300).nullable().optional(), discordUrl: z.string().max(300).nullable().optional(), events: z.array(z.string().max(50)).max(20).optional() }), req.body);
    res.json(await c.notify.set(uid(req), body));
  });
  r.post('/notifications/test', async (req, res) => {
    res.json(await c.notify.test(uid(req)));
  });
  const mcpBody = z.object({
    name: z.string().min(1).max(40),
    transport: z.enum(['stdio', 'http']),
    command: z.string().max(300).optional(),
    args: z.array(z.string().max(500)).max(40).optional(),
    url: z.string().max(500).optional(),
    secrets: z.record(z.string().max(80), z.string().max(2000)).optional(),
  });
  r.get('/mcp', async (req, res) => {
    res.json({ items: (await c.mcp.list(uid(req))).map(toMcp) });
  });
  r.post('/mcp', async (req, res) => {
    const doc = await c.mcp.create(uid(req), parse(mcpBody, req.body));
    res.status(201).json(toMcp(await c.mcp.test(uid(req), doc.id)));
  });
  r.patch('/mcp/:id', async (req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    res.json(toMcp(await c.mcp.setEnabled(uid(req), req.params.id, enabled)));
  });
  r.post('/mcp/:id/test', async (req, res) => {
    res.json(toMcp(await c.mcp.test(uid(req), req.params.id)));
  });
  r.delete('/mcp/:id', async (req, res) => {
    await c.mcp.remove(uid(req), req.params.id);
    res.status(204).end();
  });
  r.get('/llm/check', async (_req, res) => {
    res.json(await c.agent.llmCheck());
  });
  r.get('/eval/latest', async (_req, res) => {
    res.json(await c.agent.evalLatest());
  });
  r.post('/eval/run', async (req, res) => {
    const limit = Number((req.body as { limit?: unknown } | undefined)?.limit);
    res.status(202).json(await c.agent.evalRun(Number.isInteger(limit) && limit > 0 ? limit : undefined));
  });
  r.get('/eval/status', async (_req, res) => {
    res.json(await c.agent.evalStatus());
  });
  r.get('/activity', async (req, res) => {
    const limit = Number(req.query.limit ?? 60);
    res.json({ items: await c.stats.activity(uid(req), Number.isFinite(limit) ? limit : 60) });
  });
  r.get('/stats', async (req, res) => {
    res.json(await c.stats.forUser(uid(req)));
  });
  r.get('/audit', async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const page = await c.audit.list(uid(req), limit, offset);
    res.json({ items: page.items.map(toAudit), nextCursor: page.nextCursor });
  });
  return r;
}

export function publicRoutes(c: Container): Router {
  const r = Router();
  r.get('/api/health', async (_req, res) => {
    const [db, redis, agent] = await Promise.all([c.store.ping(), c.bus.ping(), c.agent.reachable()]);
    res.status(db && redis ? 200 : 503).json({
      status: db && redis ? 'ok' : 'degraded',
      db: c.store.kind,
      redis,
      agent,
      uptimeSec: Math.round((Date.now() - c.startedAt) / 1000),
    });
  });
  // GitHub webhook: HMAC-verified, no JWT. Disabled (404) unless GITHUB_WEBHOOK_SECRET is set.
  r.post('/webhooks/github', async (req, res) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const event = req.header('x-github-event');
    if (event === 'pull_request' || event === 'workflow_run') {
      const secret = c.config.githubWebhookSecret;
      if (!secret) throw new AppError(404, 'webhooks_disabled', 'Webhooks are not enabled');
      if (!verifySignature(secret, raw, req.header('x-hub-signature-256'))) throw new AppError(401, 'bad_signature', 'Invalid webhook signature');
      const b = req.body as { action?: string; number?: number; pull_request?: { number?: number; draft?: boolean }; repository?: { full_name?: string }; workflow_run?: { id?: number; conclusion?: string | null; head_branch?: string } };
      const fullName = b.repository?.full_name;
      const out =
        event === 'pull_request'
          ? await c.reviews.handlePullRequest(b.action, { number: b.number ?? b.pull_request?.number, fullName, draft: b.pull_request?.draft })
          : await c.ci.handleWorkflowRun({ action: b.action, conclusion: b.workflow_run?.conclusion, runId: b.workflow_run?.id, fullName, branch: b.workflow_run?.head_branch });
      res.status(out.status === 'ignored' ? 200 : 202).json(out);
      return;
    }
    const out = await c.issues.handleWebhook(event, raw, req.header('x-hub-signature-256'), req.body);
    res.status(out.status === 'started' ? 202 : 200).json(out);
  });
  r.get('/metrics', async (_req, res) => {
    res.set('Content-Type', c.metrics.registry.contentType).send(await c.metrics.registry.metrics());
  });
  return r;
}

const EventBody = z.object({
  seq: z.number().int().min(1),
  type: z.string().min(1).max(100),
  ts: z.string().min(1).max(40),
  data: z.record(z.string(), z.unknown()),
});

export function internalRoutes(c: Container): Router {
  const r = Router();
  r.post('/runs/:runId/events', async (req, res) => {
    if (!safeEqual(req.header('x-internal-key') ?? '', c.config.internalKey)) {
      throw new AppError(401, 'unauthorized', 'Invalid internal key');
    }
    const result = await c.tasks.ingest(req.params.runId, parse(EventBody, req.body));
    res.status(result.duplicate ? 200 : 201).json({ ok: true, duplicate: result.duplicate });
  });
  return r;
}
