import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Container } from '../config/container.js';
import { parse, uid } from '../middleware/http.js';
import { isProvider } from '../services/oauth.js';
import { AppError } from '../utils/errors.js';
import { toUser } from '../models/mappers.js';

const Credentials = z.object({ email: z.string().email().max(200), password: z.string().min(8).max(200) });
const Register = Credentials.extend({ name: z.string().trim().min(1).max(100) });

export function authRoutes(c: Container, limiter: RequestHandler): Router {
  const r = Router();
  r.post('/register', limiter, async (req, res) => {
    const { token, user } = await c.auth.register(parse(Register, req.body));
    res.status(201).json({ token, user: toUser(user) });
  });
  r.post('/login', limiter, async (req, res) => {
    const { token, user } = await c.auth.login(parse(Credentials, req.body));
    res.json({ token, user: toUser(user) });
  });
  r.get('/providers', (_req, res) => {
    res.json(c.oauth.enabled());
  });
  r.get('/oauth/:provider/start', limiter, (req, res) => {
    const p = String(req.params.provider);
    if (!isProvider(p)) throw new AppError(404, 'not_found', 'Unknown provider');
    res.redirect(c.oauth.authorizeUrl(p));
  });
  r.get('/oauth/:provider/callback', limiter, async (req, res) => {
    const p = String(req.params.provider);
    if (!isProvider(p)) throw new AppError(404, 'not_found', 'Unknown provider');
    const { code, state, error } = req.query;
    if (error || typeof code !== 'string' || typeof state !== 'string') return res.redirect(c.oauth.failureUrl('Sign-in was cancelled'));
    try {
      const done = await c.oauth.complete(p, code, state);
      res.redirect(c.oauth.successUrl(done.token, done.connected));
    } catch (err) {
      res.redirect(c.oauth.failureUrl(err instanceof AppError ? err.message : 'Sign-in failed. Please try again.'));
    }
  });
  return r;
}

export function accountRoutes(c: Container): Router {
  const r = Router();
  r.get('/me', async (req, res) => {
    const user = await c.auth.getUser(uid(req));
    const [github, agent] = await Promise.all([c.account.githubStatus(user), c.account.agentStatus()]);
    res.json({ user: toUser(user), github, agent });
  });
  r.get('/github/oauth-url', (req, res) => {
    res.json({ url: c.oauth.authorizeUrl('github', uid(req)) });
  });
  r.post('/github/connect', async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(500) }), req.body);
    res.json(await c.account.connectGithub(uid(req), token));
  });
  r.delete('/github/connect', async (req, res) => {
    await c.account.disconnectGithub(uid(req));
    res.json({ ok: true });
  });
  r.get('/github/repos', async (req, res) => {
    const token = await c.account.requireToken(uid(req));
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    res.json({ items: await c.github.listRepos(token, query) });
  });
  return r;
}
