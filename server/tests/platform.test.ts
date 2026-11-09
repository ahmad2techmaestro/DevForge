import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateHook } from '../src/services/notify.js';
import { cleanLocalPath } from '../src/services/repos.js';
import { createEnv, readyRepo, signup, waitFor, type Env } from './helpers.js';

const SECRET = 'webhook-secret-456';
let env: Env;
beforeAll(async () => {
  env = await createEnv({ GITHUB_WEBHOOK_SECRET: SECRET });
});
afterAll(() => env.close());
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const hook = (event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  return env.http.post('/webhooks/github').set('Content-Type', 'application/json').set({ 'X-GitHub-Event': event, 'X-Hub-Signature-256': sign(body) }).send(body);
};

describe('code intelligence proxy', () => {
  it('forwards semantic search, symbols, impact and call graph for a ready repo', async () => {
    const s = await signup(env);
    const id = await readyRepo(env, s);
    const search = await env.http.get(`/api/repos/${id}/semantic-search?q=login&mode=semantic`).set(s.auth);
    expect(search.body).toMatchObject({ mode: 'semantic', embedder: 'hash-512', rerankParam: 'false' });
    expect((await env.http.get(`/api/repos/${id}/semantic-search?q=login&rerank=true`).set(s.auth)).body.rerankParam).toBe('true');
    expect((await env.http.get(`/api/repos/${id}/semantic-search?q=login&rerank=maybe`).set(s.auth)).status).toBe(400);
    expect((await env.http.get(`/api/repos/${id}/symbols`).set(s.auth)).body.engine).toBe('tree-sitter');
    expect((await env.http.get(`/api/repos/${id}/impact?path=app.py`).set(s.auth)).body.tests).toEqual(['test_b.py']);
    expect((await env.http.get(`/api/repos/${id}/callgraph`).set(s.auth)).status).toBe(200);
    expect((await env.http.get(`/api/repos/${id}/impact`).set(s.auth)).status).toBe(400);
    const other = await signup(env);
    expect((await env.http.get(`/api/repos/${id}/symbols`).set(other.auth)).status).toBe(404);
  });
});

describe('PR review bot', () => {
  it('reviews a pull request and posts it as a COMMENT review with inline comments', async () => {
    const s = await signup(env);
    const id = await readyRepo(env, s);
    const res = await env.http.post(`/api/repos/${id}/reviews`).set(s.auth).send({ number: 5, post: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: 5, verdict: 'comment', riskScore: 'medium', posted: true });
    const posted = env.github.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls/5/reviews'));
    expect(posted?.body).toMatchObject({ event: 'COMMENT', commit_id: 'abc123' });
    expect((posted?.body as { comments: unknown[] }).comments).toHaveLength(1);
    const agentCall = env.agent.calls.find((c) => c.path === '/reviews/pr');
    expect((agentCall?.body as { diff: string }).diff).toContain('x.foo()');
    const list = await env.http.get(`/api/repos/${id}/reviews`).set(s.auth);
    expect(list.body.items).toHaveLength(1);
    const dry = await env.http.post(`/api/repos/${id}/reviews`).set(s.auth).send({ number: 6, post: false });
    expect(dry.body.posted).toBe(false);
  });

  it('webhook reviews only when auto review is on for the repo', async () => {
    const s = await signup(env);
    const id = await readyRepo(env, s);
    const payload = { action: 'opened', number: 9, pull_request: { number: 9, draft: false }, repository: { full_name: 'octo/demo' } };
    expect((await hook('pull_request', payload)).body.status).toBe('ignored');
    const on = await env.http.patch(`/api/repos/${id}/settings`).set(s.auth).send({ autoReview: true });
    expect(on.body.autoReview).toBe(true);
    const ok = await hook('pull_request', payload);
    expect(ok.status).toBe(202);
    await waitFor(async () => (await env.http.get(`/api/repos/${id}/reviews`).set(s.auth)).body.items.some((r: { number: number; trigger: string }) => r.number === 9 && r.trigger === 'webhook'));
    expect((await hook('pull_request', { ...payload, pull_request: { number: 9, draft: true } })).body.reason).toBe('draft pull request');
    expect((await hook('pull_request', { ...payload, action: 'closed' })).body.reason).toBe('not a review trigger');
    const bad = await env.http.post('/webhooks/github').set('Content-Type', 'application/json').set('X-GitHub-Event', 'pull_request').send(JSON.stringify(payload));
    expect(bad.status).toBe(401);
  });
});

describe('CI failure autopilot', () => {
  it('lists failing runs and creates a gated bug-fix task from the logs', async () => {
    const s = await signup(env);
    const id = await readyRepo(env, s);
    const list = await env.http.get(`/api/repos/${id}/ci`).set(s.auth);
    expect(list.body.items[0].run.id).toBe(555);
    const fix = await env.http.post(`/api/repos/${id}/ci/555/fix`).set(s.auth).send({});
    expect(fix.status).toBe(201);
    expect(fix.body).toMatchObject({ failureKind: 'test', failingTests: ['tests/test_x.py::test_y'] });
    const task = (await env.http.get(`/api/tasks/${fix.body.taskId}`).set(s.auth)).body.task;
    expect(task).toMatchObject({ kind: 'bugfix', autoApprove: false, ci: { runId: 555 } });
    expect(task.title).toBe('Fix test_y');
    expect((await env.http.post(`/api/repos/${id}/ci/555/fix`).set(s.auth).send({})).status).toBe(409);
    const after = await env.http.get(`/api/repos/${id}/ci`).set(s.auth);
    expect(after.body.items[0].handled.taskId).toBe(fix.body.taskId);
  });

  it('webhook starts a task only for failures on the default branch with auto fix on', async () => {
    const s = await signup(env);
    const id = await readyRepo(env, s);
    const payload = { action: 'completed', repository: { full_name: 'octo/demo' }, workflow_run: { id: 777, conclusion: 'failure', head_branch: 'main' } };
    expect((await hook('workflow_run', payload)).body.status).toBe('ignored');
    await env.http.patch(`/api/repos/${id}/settings`).set(s.auth).send({ autoFixCi: true }).expect(200);
    expect((await hook('workflow_run', { ...payload, workflow_run: { ...payload.workflow_run, head_branch: 'feat' } })).body.status).toBe('ignored');
    const ok = await hook('workflow_run', payload);
    expect(ok.status).toBe(202);
    expect(ok.body.taskIds).toHaveLength(1);
    expect((await hook('workflow_run', { ...payload, workflow_run: { id: 778, conclusion: 'success', head_branch: 'main' } })).body.status).toBe('ignored');
  });
});

describe('budget and notifications', () => {
  it('blocks new tasks once the monthly budget is reached', async () => {
    const s = await signup(env);
    const id = await readyRepo(env, s);
    expect((await env.http.get('/api/budget').set(s.auth)).body).toMatchObject({ budgetUsd: null, spentUsd: 0 });
    await env.http.put('/api/budget').set(s.auth).send({ budgetUsd: 0 }).expect(200);
    const blocked = await env.http.post(`/api/repos/${id}/tasks`).set(s.auth).send({ kind: 'feature', title: 't', description: 'd' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('budget_exceeded');
    await env.http.put('/api/budget').set(s.auth).send({ budgetUsd: null }).expect(200);
    expect((await env.http.post(`/api/repos/${id}/tasks`).set(s.auth).send({ kind: 'feature', title: 't', description: 'd' })).status).toBe(201);
    expect((await env.http.put('/api/budget').set(s.auth).send({ budgetUsd: -1 })).status).toBe(400);
  });

  it('stores chat webhooks encrypted, validates hosts and never returns the URL', async () => {
    const s = await signup(env);
    expect(() => validateHook('slack', 'http://169.254.169.254/latest')).toThrow();
    expect(() => validateHook('slack', 'https://evil.example.com/services/T/B/X')).toThrow();
    expect((await env.http.put('/api/notifications').set(s.auth).send({ slackUrl: 'https://internal.local/x' })).status).toBe(400);
    const url = 'https://hooks.slack.com/services/T000/B000/abcdef123456';
    const res = await env.http.put('/api/notifications').set(s.auth).send({ slackUrl: url, events: ['task.completed', 'bogus'] });
    expect(res.body).toEqual({ slack: true, discord: false, events: ['task.completed'] });
    expect(JSON.stringify(res.body)).not.toContain('hooks.slack.com');
    const user = await env.container.store.findOne<{ notify: { slackEnc: string } }>('users', { id: s.userId });
    expect(user?.notify.slackEnc).not.toContain('hooks.slack.com');
    const off = await env.http.put('/api/notifications').set(s.auth).send({ slackUrl: null });
    expect(off.body.slack).toBe(false);
    expect((await env.http.post('/api/notifications/test').set(s.auth)).status).toBe(400);
  });

  it('exposes the provider check and benchmark status', async () => {
    const s = await signup(env);
    expect((await env.http.get('/api/llm/check').set(s.auth)).body.ok).toBe(true);
    expect((await env.http.get('/api/eval/latest').set(s.auth)).body.available).toBe(false);
  });

  it('starts a benchmark run and reports its status', async () => {
    const s = await signup(env);
    const started = await env.http.post('/api/eval/run').set(s.auth).send({ limit: 3 });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: 'running', total: 3 });
    expect((await env.http.get('/api/eval/status').set(s.auth)).body.status).toBe('idle');
  });

  it('cleans pasted local paths and routes links to clone URLs', async () => {
    expect(cleanLocalPath('  "C:\\Users\\me\\WeatherX"  ')).toBe('C:\\Users\\me\\WeatherX');
    expect(cleanLocalPath('file:///C:/Users/me/My%20App')).toBe('C:/Users/me/My App');
    const local = await createEnv({ ALLOW_LOCAL_REPOS: 'true' });
    try {
      const s = await signup(local);
      const link = await local.http.post('/api/repos').set(s.auth).send({ localPath: 'https://github.com/someone/WeatherX' });
      expect(link.status).toBe(201);
      expect(link.body.source).not.toBe('local');
      const win = await local.http.post('/api/repos').set(s.auth).send({ localPath: '"C:\\Users\\me\\WeatherX"' });
      expect(win.status).toBe(201);
      expect(win.body.name).toBe('WeatherX');
    } finally {
      await local.close();
    }
  });
});

describe('MCP servers', () => {
  it('stores servers with encrypted secrets, tests them, and sends them to runs', async () => {
    const s = await signup(env);
    const res = await env.http.post('/api/mcp').set(s.auth).send({ name: 'My Tools', transport: 'stdio', command: 'node', args: ['srv.js'], secrets: { API_TOKEN: 'super-secret-token' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'my_tools', secretKeys: ['API_TOKEN'], enabled: true });
    expect(res.body.lastCheck.ok).toBe(true);
    expect(res.body.tools.map((t: { name: string }) => t.name)).toEqual(['echo', 'add']);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-token');
    const stored = (await env.http.get('/api/mcp').set(s.auth)).body.items;
    expect(JSON.stringify(stored)).not.toContain('super-secret-token');
    const inspect = env.agent.calls.filter((c) => c.path === '/mcp/inspect').at(-1);
    expect(inspect?.body).toMatchObject({ name: 'my_tools', env: { API_TOKEN: 'super-secret-token' } });

    const id = await readyRepo(env, s);
    const runs = () => env.agent.calls.filter((c) => c.path === '/runs').length;
    const before = runs();
    await env.http.post(`/api/repos/${id}/tasks`).set(s.auth).send({ kind: 'feature', title: 't', description: 'd' });
    await waitFor(() => runs() > before);
    const run = env.agent.calls.filter((c) => c.path === '/runs').at(-1);
    expect((run?.body as { mcpServers: unknown[] }).mcpServers[0]).toMatchObject({ name: 'my_tools', command: 'node', env: { API_TOKEN: 'super-secret-token' } });

    const off = await env.http.patch(`/api/mcp/${res.body.id}`).set(s.auth).send({ enabled: false });
    expect(off.body.enabled).toBe(false);
    const before2 = runs();
    await env.http.post(`/api/repos/${id}/tasks`).set(s.auth).send({ kind: 'feature', title: 't2', description: 'd' });
    await waitFor(() => runs() > before2);
    expect((env.agent.calls.filter((c) => c.path === '/runs').at(-1)?.body as { mcpServers: unknown[] }).mcpServers).toEqual([]);
  });

  it('reports a failed connection, validates input, isolates users and deletes', async () => {
    const s = await signup(env);
    const bad = await env.http.post('/api/mcp').set(s.auth).send({ name: 'broken', transport: 'stdio', command: 'bad' });
    expect(bad.status).toBe(201);
    expect(bad.body.lastCheck).toMatchObject({ ok: false });
    expect(bad.body.lastCheck.error).toContain('cannot start');
    expect((await env.http.post('/api/mcp').set(s.auth).send({ name: 'broken', transport: 'stdio', command: 'x' })).status).toBe(400);
    expect((await env.http.post('/api/mcp').set(s.auth).send({ name: 'w', transport: 'http', url: 'ftp://x' })).status).toBe(400);
    expect((await env.http.post('/api/mcp').set(s.auth).send({ name: 'w', transport: 'stdio' })).status).toBe(400);
    const other = await signup(env);
    expect((await env.http.get('/api/mcp').set(other.auth)).body.items).toEqual([]);
    expect((await env.http.delete(`/api/mcp/${bad.body.id}`).set(other.auth)).status).toBe(404);
    expect((await env.http.delete(`/api/mcp/${bad.body.id}`).set(s.auth)).status).toBe(204);
    expect((await env.http.get('/api/mcp').set(s.auth)).body.items).toEqual([]);
    expect((await env.http.get('/api/mcp')).status).toBe(401);
  });
});
