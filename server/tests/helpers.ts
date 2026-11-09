import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import supertest from 'supertest';
import { inject } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { buildContainer, type Container } from '../src/config/container.js';
import { createLogger } from '../src/config/logger.js';

export const INTERNAL_KEY = 'test-internal-key';
export const GH_TOKEN = 'ghp_testtoken_0123456789abcdef';

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeAgent {
  url: string;
  calls: Call[];
  /** Number of upcoming POST /runs calls that should fail with 500. */
  failRuns: number;
  failIndex: boolean;
  server: Server;
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

export async function startFakeAgent(): Promise<FakeAgent> {
  const app = express();
  app.use(express.json());
  const state = { calls: [] as Call[], failRuns: 0, failIndex: false };
  app.use((req, _res, next) => {
    state.calls.push({ method: req.method, path: req.originalUrl, body: req.body, headers: req.headers });
    next();
  });
  app.get('/health', (_q, r) => r.json({ status: 'ok', provider: 'mock', model: 'mock-1', sandbox: 'subprocess', dockerAvailable: false, version: '1.0.0' }));
  app.post('/repos/index', (q, r) => {
    if (state.failIndex) return void r.status(404).json({ error: { code: 'clone_failed', message: 'repository not found' } });
    r.json({ repoId: q.body.repoId, commit: 'abc1234', branch: 'main', fileCount: 3, totalLines: 42, languages: { python: { files: 3, lines: 42 } }, summary: 'A demo repository' });
  });
  app.delete('/repos/:id', (_q, r) => r.json({ deleted: true }));
  app.get('/repos/:id/tree', (_q, r) => r.json({ files: [{ path: 'app.py', size: 10, language: 'python', lines: 3 }] }));
  app.get('/repos/:id/file', (q, r) => r.json({ path: q.query.path, content: 'print(1)\n', language: 'python', lines: 1, truncated: false }));
  app.get('/repos/:id/graph', (_q, r) => r.json({ nodes: [], edges: [] }));
  app.get('/repos/:id/health', (_q, r) => r.json({ score: 82, grade: 'B', metrics: {}, findings: [] }));
  app.post('/repos/:id/search', (_q, r) => r.json({ results: [] }));
  app.post('/repos/:id/explain', (_q, r) => r.json({ explanation: 'It prints.', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }));
  app.post('/repos/:id/bugs', (_q, r) => r.json({ findings: [], usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.005 } }));
  app.post('/repos/:id/security', (_q, r) =>
    r.json({ score: 61, grade: 'C', counts: { high: 1 }, dependencies: { npm: 2 }, findings: [{ path: 'app.py', line: 2, severity: 'high', rule: 'tls-verify-disabled', title: 'TLS verification disabled', detail: 'x' }], summary: '1 finding', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } }),
  );
  app.post('/repos/:id/chat', (_q, r) =>
    r.json({ answer: 'See app.py', citations: [{ path: 'app.py', line: 1 }], usage: { inputTokens: 3, outputTokens: 3, costUsd: 0.002 } }),
  );
  app.get('/repos/:id/semantic-search', (q, r) => r.json({ mode: q.query.mode, rerankParam: q.query.rerank, embedder: 'hash-512', results: [{ path: 'app.py', line: 1, endLine: 3, score: 0.9, snippet: 'print(1)', symbol: null }] }));
  app.get('/repos/:id/symbols', (_q, r) => r.json({ engine: 'tree-sitter', symbols: [{ name: 'main', kind: 'function', path: 'app.py', line: 1, endLine: 3 }] }));
  app.get('/repos/:id/impact', (q, r) => r.json({ engine: 'tree-sitter', target: q.query.path, direct: ['b.py'], transitive: [], tests: ['test_b.py'], risk: 'low', summary: 'ok' }));
  app.get('/repos/:id/callgraph', (_q, r) => r.json({ engine: 'tree-sitter', nodes: [], edges: [], truncated: false }));
  app.post('/reviews/pr', (q, r) =>
    r.json({ summary: `Reviewed: ${q.body.title}`, verdict: 'comment', riskScore: 'medium', stats: { files: 1, additions: 2, deletions: 0 },
      comments: [{ path: 'app.py', line: 2, side: 'RIGHT', severity: 'medium', body: 'Possible None dereference' }], usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.01 } }),
  );
  app.post('/ci/analyze', (_q, r) =>
    r.json({ summary: 'pytest: 1 test failed', failureKind: 'test', failingTests: ['tests/test_x.py::test_y'], errorLines: [], suspectedFiles: ['x.py'], suggestedTask: { title: 'Fix test_y', description: 'test_y fails with AssertionError' } }),
  );
  app.post('/mcp/inspect', (q, r) => {
    if (q.body.command === 'bad') return void r.status(502).json({ error: { code: 'mcp_unavailable', message: 'cannot start bad' } });
    r.json({ ok: true, server: { name: 'fake' }, tools: [{ name: 'echo', description: 'Echo', readOnly: true }, { name: 'add', description: 'Add', readOnly: false }] });
  });
  app.get('/llm/check', (_q, r) => r.json({ ok: true, provider: 'mock', model: 'mock' }));
  app.get('/eval/latest', (_q, r) => r.json({ available: false }));
  app.post('/eval/run', (q, r) => r.status(202).json({ status: 'running', done: 0, total: q.body?.limit ?? 14, current: '', error: '' }));
  app.get('/eval/status', (_q, r) => r.json({ status: 'idle', done: 0, total: 0, current: '', error: '' }));
  app.post('/runs', (_q, r) => {
    if (state.failRuns > 0) {
      state.failRuns -= 1;
      return void r.status(500).json({ error: { code: 'boom', message: 'agent exploded' } });
    }
    r.status(202).json({ runId: _q.body.runId, status: 'running' });
  });
  app.post('/runs/:id/approve', (_q, r) => r.json({ ok: true }));
  app.post('/runs/:id/cancel', (_q, r) => r.json({ ok: true }));
  app.get('/runs/:id/diff', (_q, r) => r.json({ diff: 'diff --git a/x b/x', files: [] }));
  app.post('/runs/:id/commit', (q, r) => r.json({ branch: q.body.branch, commit: 'deadbeef', files: [] }));
  app.post('/runs/:id/push', (q, r) => r.json({ pushed: true, branch: q.body.branch }));
  const { server, url } = await listen(app);
  return Object.defineProperties({ url, server } as FakeAgent, {
    calls: { get: () => state.calls },
    failRuns: { get: () => state.failRuns, set: (v: number) => (state.failRuns = v) },
    failIndex: { get: () => state.failIndex, set: (v: boolean) => (state.failIndex = v) },
  });
}

export interface FakeGithub {
  url: string;
  calls: Call[];
  server: Server;
}

export async function startFakeGithub(): Promise<FakeGithub> {
  const app = express();
  app.use(express.json());
  const calls: Call[] = [];
  app.use((req, res, next) => {
    calls.push({ method: req.method, path: req.originalUrl, body: req.body, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return void res.status(401).json({ message: 'Bad credentials' });
    next();
  });
  app.get('/user', (_q, r) => r.json({ login: 'octo', avatar_url: 'https://avatars.test/octo.png' }));
  app.get('/user/repos', (_q, r) =>
    r.json([
      { full_name: 'octo/demo', private: false, default_branch: 'main', description: 'Demo repo', language: 'Python', updated_at: '2026-10-01T00:00:00Z', clone_url: 'https://github.com/octo/demo.git' },
      { full_name: 'octo/other', private: true, default_branch: 'dev', description: null, language: null, updated_at: '2026-09-01T00:00:00Z', clone_url: 'https://github.com/octo/other.git' },
    ]),
  );
  const ISSUES = [
    { number: 12, title: 'Login crashes on empty password', body: 'Steps: submit empty form', html_url: 'https://github.com/octo/demo/issues/12', labels: [{ name: 'bug' }], user: { login: 'alice' }, updated_at: '2026-10-02T00:00:00Z' },
    { number: 13, title: 'Add dark mode', body: null, html_url: 'https://github.com/octo/demo/issues/13', labels: [{ name: 'enhancement' }], user: { login: 'bob' }, updated_at: '2026-10-03T00:00:00Z' },
    { number: 14, title: 'A pull request', body: '', html_url: 'https://github.com/octo/demo/pull/14', labels: [], user: null, updated_at: '2026-10-04T00:00:00Z', pull_request: {} },
  ];
  app.get('/repos/:owner/:repo/issues', (_q, r) => r.json(ISSUES));
  app.get('/repos/:owner/:repo/issues/:n', (q, r) => {
    const found = ISSUES.find((i) => String(i.number) === q.params.n);
    return found ? r.json(found) : void r.status(404).json({ message: 'Not Found' });
  });
  app.get('/repos/:owner/:repo/pulls/:n', (q, r) => {
    if (String(q.headers.accept).includes('diff')) {
      return void r.type('text/plain').send('diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,1 +1,3 @@\n print(1)\n+x = None\n+x.foo()\n');
    }
    r.json({ number: Number(q.params.n), title: 'Add x', body: 'desc', html_url: `https://github.com/${q.params.owner}/${q.params.repo}/pull/${q.params.n}`, head: { sha: 'abc123', ref: 'feat' }, base: { ref: 'main' }, state: 'open', draft: false });
  });
  app.post('/repos/:owner/:repo/pulls/:n/reviews', (q, r) => r.status(200).json({ html_url: `https://github.com/${q.params.owner}/${q.params.repo}/pull/${q.params.n}#pullrequestreview-1` }));
  app.get('/repos/:owner/:repo/actions/runs', (_q, r) =>
    r.json({ workflow_runs: [{ id: 555, name: 'CI', head_branch: 'main', html_url: 'https://github.com/octo/demo/actions/runs/555', conclusion: 'failure', head_sha: 'abc', created_at: '2026-10-05T00:00:00Z' }] }),
  );
  app.get('/repos/:owner/:repo/actions/runs/:id', (q, r) =>
    r.json({ id: Number(q.params.id), name: 'CI', head_branch: 'main', html_url: `https://github.com/octo/demo/actions/runs/${q.params.id}`, conclusion: 'failure', head_sha: 'abc', created_at: '2026-10-05T00:00:00Z' }),
  );
  app.get('/repos/:owner/:repo/actions/runs/:id/jobs', (_q, r) => r.json({ jobs: [{ id: 9, name: 'test', conclusion: 'failure' }] }));
  app.get('/repos/:owner/:repo/actions/jobs/:id/logs', (_q, r) => r.type('text/plain').send('FAILED tests/test_x.py::test_y - AssertionError\n'));
  app.post('/repos/:owner/:repo/pulls', (q, r) => r.status(201).json({ html_url: `https://github.com/${q.params.owner}/${q.params.repo}/pull/7`, number: 7 }));
  const { server, url } = await listen(app);
  return { url, calls, server };
}

export interface Env {
  container: Container;
  server: Server;
  port: number;
  agent: FakeAgent;
  github: FakeGithub;
  http: ReturnType<typeof supertest>;
  close(): Promise<void>;
}

export async function createEnv(overrides: Record<string, string> = {}): Promise<Env> {
  const agent = await startFakeAgent();
  const github = await startFakeGithub();
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'memory',
    REDIS_URL: inject('redisUrl'),
    AGENT_URL: agent.url,
    GITHUB_API_URL: github.url,
    API_PUBLIC_URL: 'http://api.test',
    INTERNAL_KEY,
    BCRYPT_COST: '4',
    QUEUE_NAME: `q-${randomUUID()}`,
    QUEUE_BACKOFF_MS: '20',
    QUEUE_ATTEMPTS: '3',
    ...overrides,
  });
  const container = await buildContainer(config, createLogger(config));
  const app = createApp(container);
  const { server } = await listen(app);
  container.hub.attach(server);
  const port = (server.address() as AddressInfo).port;
  return {
    container,
    server,
    port,
    agent,
    github,
    http: supertest(server),
    async close() {
      await container.close();
      for (const s of [server, agent.server, github.server]) s.close();
    },
  };
}

export interface Session {
  token: string;
  userId: string;
  auth: { Authorization: string };
}

export async function signup(env: Env, email = `u${randomUUID().slice(0, 8)}@example.com`): Promise<Session> {
  const res = await env.http.post('/api/auth/register').send({ email, password: 'correct horse battery', name: 'Test User' });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.user.id, auth: { Authorization: `Bearer ${res.body.token}` } };
}

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null> | T | false | undefined | null, ms = 5000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Connects a GitHub token, creates a repo and waits until it is indexed. */
export async function readyRepo(env: Env, s: Session): Promise<string> {
  await env.http.post('/api/github/connect').set(s.auth).send({ token: GH_TOKEN }).expect(200);
  const created = await env.http.post('/api/repos').set(s.auth).send({ fullName: 'octo/demo' }).expect(201);
  await waitFor(async () => (await env.http.get(`/api/repos/${created.body.id}`).set(s.auth)).body.status === 'ready', 5000, 'repo ready');
  return created.body.id as string;
}

export async function newTask(env: Env, s: Session, repoId: string, kind = 'feature', autoApprove = false) {
  const res = await env.http.post(`/api/repos/${repoId}/tasks`).set(s.auth).send({ kind, title: 'Add feature', description: 'Do the thing', autoApprove });
  if (res.status !== 201) throw new Error(`task create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; runId: string; status: string };
}

/** Plays the agent: posts a RunEvent to the internal endpoint. */
export function emit(env: Env, runId: string, seq: number, type: string, data: Record<string, unknown> = {}) {
  return env.http.post(`/internal/runs/${runId}/events`).set('X-Internal-Key', INTERNAL_KEY).send({ seq, type, ts: new Date().toISOString(), data });
}

export function openSocket(env: Env, token: string): Promise<{ ws: WebSocket; messages: Record<string, unknown>[]; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws?token=${encodeURIComponent(token)}`);
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages, closed }));
    ws.once('error', reject);
  });
}
