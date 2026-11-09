import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GH_TOKEN, createEnv, emit, newTask, readyRepo, signup, waitFor, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(() => env.close());

describe('repositories', () => {
  it('indexes a GitHub repo in the background and flips to ready', async () => {
    const s = await signup(env);
    await env.http.post('/api/github/connect').set(s.auth).send({ token: GH_TOKEN });
    const created = await env.http.post('/api/repos').set(s.auth).send({ fullName: 'octo/demo' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'demo', fullName: 'octo/demo', source: 'github', status: 'indexing' });

    const ready = await waitFor(async () => {
      const r = await env.http.get(`/api/repos/${created.body.id}`).set(s.auth);
      return r.body.status === 'ready' ? r.body : false;
    });
    expect(ready).toMatchObject({ commit: 'abc1234', branch: 'main', stats: { fileCount: 3, totalLines: 42 }, summary: 'A demo repository' });
    const indexCall = env.agent.calls.findLast((c) => c.path === '/repos/index');
    expect(indexCall?.body).toMatchObject({ repoId: created.body.id, cloneUrl: 'https://github.com/octo/demo.git', token: GH_TOKEN });
    expect(indexCall?.headers['x-internal-key']).toBe('test-internal-key');
  });

  it('records indexing failures, validates input and gates local paths', async () => {
    const s = await signup(env);
    env.agent.failIndex = true;
    const bad = await env.http.post('/api/repos').set(s.auth).send({ cloneUrl: 'https://example.com/team/missing.git' });
    const failed = await waitFor(async () => {
      const r = await env.http.get(`/api/repos/${bad.body.id}`).set(s.auth);
      return r.body.status === 'error' ? r.body : false;
    });
    env.agent.failIndex = false;
    expect(failed.error).toBe('repository not found');

    expect((await env.http.post('/api/repos').set(s.auth).send({ fullName: 'a/b', cloneUrl: 'https://x.test/a/b' })).status).toBe(400);
    expect((await env.http.post('/api/repos').set(s.auth).send({ cloneUrl: 'https://user:pw@example.com/a/b.git' })).status).toBe(400);
    expect((await env.http.post('/api/repos').set(s.auth).send({ cloneUrl: 'ssh://example.com/a/b' })).status).toBe(400);
    const local = await env.http.post('/api/repos').set(s.auth).send({ localPath: '/srv/code/app' });
    expect(local.status).toBe(403);
    expect(local.body.error.code).toBe('local_repos_disabled');
  });

  it('isolates users from each other', async () => {
    const a = await signup(env);
    const b = await signup(env);
    const repoId = await readyRepo(env, a);
    const task = await newTask(env, a, repoId);
    expect((await env.http.get(`/api/repos/${repoId}`).set(b.auth)).status).toBe(404);
    expect((await env.http.get(`/api/repos/${repoId}/tree`).set(b.auth)).status).toBe(404);
    expect((await env.http.get(`/api/tasks/${task.id}`).set(b.auth)).status).toBe(404);
    expect((await env.http.delete(`/api/repos/${repoId}`).set(b.auth)).status).toBe(404);
    expect((await env.http.get('/api/repos').set(b.auth)).body.items).toEqual([]);
  });

  it('proxies intelligence endpoints, caches health and records usage', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    expect((await env.http.get(`/api/repos/${repoId}/tree`).set(s.auth)).body.files[0].path).toBe('app.py');
    expect((await env.http.get(`/api/repos/${repoId}/file?path=app.py`).set(s.auth)).body.content).toBe('print(1)\n');
    expect((await env.http.get(`/api/repos/${repoId}/file`).set(s.auth)).status).toBe(400);
    expect((await env.http.get(`/api/repos/${repoId}/health`).set(s.auth)).body.grade).toBe('B');
    expect((await env.http.get(`/api/repos/${repoId}`).set(s.auth)).body.health).toEqual({ score: 82, grade: 'B' });
    await env.http.post(`/api/repos/${repoId}/explain`).set(s.auth).send({ path: 'app.py' }).expect(200);
    const stats = await env.http.get('/api/stats').set(s.auth);
    expect(stats.body.usage.costUsd).toBeCloseTo(0.01);
  });

  it('persists chat threads with citations', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const first = await env.http.post(`/api/repos/${repoId}/chat`).set(s.auth).send({ message: 'What does app.py do?' }).expect(200);
    expect(first.body.messages).toHaveLength(2);
    expect(first.body.messages[1]).toMatchObject({ role: 'assistant', citations: [{ path: 'app.py', line: 1 }] });
    const second = await env.http.post(`/api/repos/${repoId}/chat`).set(s.auth).send({ threadId: first.body.threadId, message: 'And more?' }).expect(200);
    expect(second.body.messages).toHaveLength(4);
    const chatCall = env.agent.calls.findLast((c) => c.path.endsWith('/chat'));
    expect((chatCall?.body as { messages: unknown[] }).messages).toHaveLength(3);
    expect((await env.http.get(`/api/repos/${repoId}/chats`).set(s.auth)).body.items).toHaveLength(1);
  });
});

describe('task lifecycle', () => {
  it('queues, dispatches to the agent, ingests events and walks both approvals to a PR', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const task = await newTask(env, s, repoId);
    expect(task.status).toBe('queued');

    const runCall = await waitFor(() => env.agent.calls.find((c) => c.path === '/runs' && (c.body as { taskId: string }).taskId === task.id), 5000, 'agent run');
    expect(runCall.body).toMatchObject({
      runId: task.runId,
      repoId,
      task: { kind: 'feature', title: 'Add feature' },
      callbackUrl: `http://api.test/internal/runs/${task.runId}/events`,
      options: { autoApprove: false },
    });

    expect((await emit(env, task.runId, 1, 'run.started', { kind: 'feature' })).status).toBe(201);
    const planApproval = { approvalId: 'ap-plan', kind: 'plan', summary: 'Plan', payload: { steps: [] } };
    await emit(env, task.runId, 2, 'approval.requested', planApproval);
    let detail = (await env.http.get(`/api/tasks/${task.id}`).set(s.auth)).body;
    expect(detail.task.status).toBe('awaiting_approval');
    expect(detail.approvals).toMatchObject([{ approvalId: 'ap-plan', status: 'pending', kind: 'plan' }]);

    // PR is refused until the work is done and approved
    expect((await env.http.post(`/api/tasks/${task.id}/pr`).set(s.auth).send({})).status).toBe(409);

    const decided = await env.http.post(`/api/tasks/${task.id}/approvals/ap-plan`).set(s.auth).send({ decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(decided.body.approval.status).toBe('approved');
    expect(env.agent.calls.findLast((c) => c.path === `/runs/${task.runId}/approve`)?.body).toEqual({ approvalId: 'ap-plan', decision: 'approve' });
    expect((await env.http.post(`/api/tasks/${task.id}/approvals/ap-plan`).set(s.auth).send({ decision: 'approve' })).status).toBe(409);

    await emit(env, task.runId, 3, 'approval.resolved', { approvalId: 'ap-plan', decision: 'approve' });
    await emit(env, task.runId, 4, 'usage', { inputTokens: 100, outputTokens: 50, costUsd: 0.12 });
    await emit(env, task.runId, 5, 'diff.ready', { files: [], risk: { score: 40, level: 'medium', reasons: ['touches auth'] } });
    await emit(env, task.runId, 6, 'approval.requested', { approvalId: 'ap-chg', kind: 'changes', summary: 'Changes', payload: {} });
    await emit(env, task.runId, 7, 'pr.draft', { title: 'feat: add feature', body: 'Does the thing', branch: 'devforge/abc' });
    await env.http.post(`/api/tasks/${task.id}/approvals/ap-chg`).set(s.auth).send({ decision: 'approve' }).expect(200);
    await emit(env, task.runId, 8, 'run.completed', { status: 'completed', summary: 'All done' });

    detail = (await env.http.get(`/api/tasks/${task.id}`).set(s.auth)).body;
    expect(detail.task).toMatchObject({
      status: 'completed',
      summary: 'All done',
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.12 },
      risk: { level: 'medium' },
      finishedAt: expect.any(String),
    });
    expect(detail.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const pr = await env.http.post(`/api/tasks/${task.id}/pr`).set(s.auth).send({});
    expect(pr.status).toBe(200);
    expect(pr.body.pr).toEqual({ url: 'https://github.com/octo/demo/pull/7', number: 7, branch: 'devforge/abc' });
    expect(JSON.stringify(pr.body)).not.toContain(GH_TOKEN);
    expect(env.agent.calls.findLast((c) => c.path.endsWith('/commit'))?.body).toMatchObject({ branch: 'devforge/abc', message: 'feat: add feature' });
    expect(env.agent.calls.findLast((c) => c.path.endsWith('/push'))?.body).toMatchObject({ branch: 'devforge/abc', token: GH_TOKEN, cloneUrl: 'https://github.com/octo/demo.git' });
    const ghPr = env.github.calls.findLast((c) => c.method === 'POST');
    expect(ghPr?.body).toMatchObject({ head: 'devforge/abc', base: 'main', draft: true, title: 'feat: add feature' });
    expect((await env.http.post(`/api/tasks/${task.id}/pr`).set(s.auth).send({})).body.error.code).toBe('pr_exists');
    expect((await env.http.get('/api/audit').set(s.auth)).body.items.map((a: { action: string }) => a.action)).toContain('pr.create');
  });

  it('ignores duplicate events and does not leave a terminal state', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const task = await newTask(env, s, repoId);
    expect((await emit(env, task.runId, 1, 'run.started')).body.duplicate).toBe(false);
    const dup = await emit(env, task.runId, 1, 'run.started');
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    await emit(env, task.runId, 2, 'run.failed', { error: 'sandbox crashed' });
    await emit(env, task.runId, 3, 'run.started');
    const { task: t, events } = (await env.http.get(`/api/tasks/${task.id}`).set(s.auth)).body;
    expect(t).toMatchObject({ status: 'failed', error: 'sandbox crashed' });
    expect(events).toHaveLength(3);
  });

  it('protects the internal endpoint', async () => {
    expect((await env.http.post('/internal/runs/x/events').send({ seq: 1, type: 'log', ts: 't', data: {} })).status).toBe(401);
    expect((await emit(env, 'unknown-run', 1, 'log')).status).toBe(404);
    const bad = await env.http.post('/internal/runs/x/events').set('X-Internal-Key', 'test-internal-key').send({ seq: 0, type: '', data: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('cancels queued and running tasks and refuses to cancel finished ones', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const task = await newTask(env, s, repoId);
    await waitFor(() => env.agent.calls.find((c) => c.path === '/runs' && (c.body as { taskId: string }).taskId === task.id));
    await emit(env, task.runId, 1, 'run.started');
    const cancelled = await env.http.post(`/api/tasks/${task.id}/cancel`).set(s.auth);
    expect(cancelled.body.status).toBe('cancelled');
    expect(env.agent.calls.some((c) => c.path === `/runs/${task.runId}/cancel`)).toBe(true);
    expect((await env.http.post(`/api/tasks/${task.id}/cancel`).set(s.auth)).status).toBe(409);
  });

  it('refuses PRs for non-GitHub repos, analysis tasks and unapproved changes', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const review = await newTask(env, s, repoId, 'review', true);
    await emit(env, review.runId, 1, 'run.completed', { status: 'completed', summary: 'ok' });
    expect((await env.http.post(`/api/tasks/${review.id}/pr`).set(s.auth).send({})).body.error.code).toBe('no_changes');

    const feature = await newTask(env, s, repoId, 'feature');
    await emit(env, feature.runId, 1, 'run.completed', { status: 'completed', summary: 'ok' });
    expect((await env.http.post(`/api/tasks/${feature.id}/pr`).set(s.auth).send({})).body.error.code).toBe('changes_not_approved');
  });
});

describe('queue resilience', () => {
  it('retries when the agent is down and marks the task failed after the last attempt', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);

    env.agent.failRuns = 2;
    const flaky = await newTask(env, s, repoId);
    await waitFor(() => env.agent.calls.filter((c) => c.path === '/runs' && (c.body as { taskId: string }).taskId === flaky.id).length >= 3, 5000, 'third attempt');
    expect((await env.http.get(`/api/tasks/${flaky.id}`).set(s.auth)).body.task.status).toBe('queued');

    env.agent.failRuns = 99;
    const doomed = await newTask(env, s, repoId);
    const failed = await waitFor(async () => {
      const t = (await env.http.get(`/api/tasks/${doomed.id}`).set(s.auth)).body.task;
      return t.status === 'failed' ? t : false;
    }, 8000, 'failed task');
    env.agent.failRuns = 0;
    expect(failed.error).toContain('Could not start the agent run');
  });
});
