import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, emit, newTask, readyRepo, signup, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(() => env.close());

describe('dashboard & ops', () => {
  it('aggregates stats per user', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const done = await newTask(env, s, repoId, 'review');
    const broke = await newTask(env, s, repoId, 'bugfix');
    await newTask(env, s, repoId, 'tests');
    await emit(env, done.runId, 1, 'usage', { inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
    await emit(env, done.runId, 2, 'run.completed', { status: 'completed', summary: 'ok' });
    await emit(env, broke.runId, 1, 'run.failed', { error: 'nope' });

    const { body } = await env.http.get('/api/stats').set(s.auth).expect(200);
    expect(body.repos).toBe(1);
    expect(body.tasks.total).toBe(3);
    expect(body.tasks.byStatus).toMatchObject({ completed: 1, failed: 1 });
    expect(body.successRate).toBeCloseTo(0.5);
    expect(body.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(body.usage.costUsd).toBeCloseTo(0.25);
    expect(body.daily).toHaveLength(14);
    expect(body.daily.at(-1)).toMatchObject({ tasks: 3 });
    expect(body.recent).toHaveLength(3);
    expect(body.byKind).toMatchObject({ review: { count: 1, completed: 1, costUsd: 0.25 }, bugfix: { count: 1, failed: 1 }, tests: { count: 1 } });
    expect(typeof body.avgDurationSec).toBe('number');

    const empty = await signup(env);
    expect((await env.http.get('/api/stats').set(empty.auth)).body).toMatchObject({ repos: 0, successRate: 0, tasks: { total: 0 } });
  });

  it('lists cross-task activity newest first, only for the owner', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const t = await newTask(env, s, repoId);
    await emit(env, t.runId, 1, 'tool.call', { name: 'read_file', args: { path: 'a.py' } });
    await emit(env, t.runId, 2, 'file.changed', { path: 'a.py', additions: 2, deletions: 1 });
    await emit(env, t.runId, 3, 'log', { level: 'info', message: 'noise' });
    const { body } = await env.http.get('/api/activity?limit=10').set(s.auth).expect(200);
    expect(body.items.map((e: { type: string }) => e.type)).toEqual(['file.changed', 'tool.call']);
    expect(body.items[0]).toMatchObject({ taskId: t.id, taskTitle: 'Add feature', data: { path: 'a.py' } });
    const other = await signup(env);
    expect((await env.http.get('/api/activity').set(other.auth)).body.items).toEqual([]);
    await env.http.get('/api/activity').expect(401);
  });

  it('paginates and filters tasks, and lists audit entries newest first', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    for (let i = 0; i < 3; i++) await newTask(env, s, repoId);
    const p1 = await env.http.get('/api/tasks?limit=2').set(s.auth);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBe('2');
    const p2 = await env.http.get('/api/tasks?limit=2&cursor=2').set(s.auth);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect((await env.http.get('/api/tasks?status=failed').set(s.auth)).body.items).toEqual([]);
    expect((await env.http.get('/api/tasks?status=bogus').set(s.auth)).status).toBe(400);

    const audit = await env.http.get('/api/audit?limit=100').set(s.auth);
    const actions = audit.body.items.map((a: { action: string }) => a.action);
    expect(actions).toContain('task.create');
    expect(actions).toContain('repo.connect');
    expect(actions.at(-1)).toBe('auth.register');
  });

  it('exposes health and Prometheus metrics', async () => {
    const health = await env.http.get('/api/health');
    expect(health.body).toMatchObject({ status: 'ok', db: 'memory', redis: true, agent: true });
    const res = await env.http.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'devforge_http_requests_total{method="GET",route="/api/health",status="200"}',
      'devforge_http_request_duration_seconds_bucket',
      'devforge_tasks_total{status="queued"}',
      'devforge_ws_connections',
      'devforge_queue_depth',
    ]) {
      expect(res.text).toContain(name);
    }
  });

  it('returns the contract error shape for unknown routes and bad JSON', async () => {
    const s = await signup(env);
    expect((await env.http.get('/api/nope').set(s.auth)).body.error.code).toBe('not_found');
    const bad = await env.http.post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
  });
});
