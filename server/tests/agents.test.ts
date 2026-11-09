import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kindFromIssue } from '../src/services/issues.js';
import { GH_TOKEN, createEnv, emit, newTask, readyRepo, signup, waitFor, type Env } from './helpers.js';

const SECRET = 'webhook-secret-123';
let env: Env;
beforeAll(async () => {
  env = await createEnv({ GITHUB_WEBHOOK_SECRET: SECRET });
});
afterAll(() => env.close());

const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const runsFor = (taskTitle?: string) => env.agent.calls.filter((c) => c.method === 'POST' && c.path === '/runs' && (!taskTitle || (c.body as { task: { title: string } }).task.title === taskTitle));

describe('security auditor', () => {
  it('proxies the agent report, records usage and requires a ready repo', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const res = await env.http.post(`/api/repos/${repoId}/security`).set(s.auth).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ score: 61, grade: 'C' });
    const other = await signup(env);
    expect((await env.http.post(`/api/repos/${repoId}/security`).set(other.auth).send({})).status).toBe(404);
    const audit = await env.http.get('/api/audit').set(s.auth);
    expect(audit.body.items.some((a: { action: string }) => a.action === 'repo.security_audit')).toBe(true);
  });
});

describe('repo memory', () => {
  it('supports manual notes, dedups, isolates users and deletes', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const add = await env.http.post(`/api/repos/${repoId}/memory`).set(s.auth).send({ text: '  Use   pytest fixtures  ' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ text: 'Use pytest fixtures', source: 'manual' });
    await env.http.post(`/api/repos/${repoId}/memory`).set(s.auth).send({ text: 'Use pytest fixtures' });
    const list = await env.http.get(`/api/repos/${repoId}/memory`).set(s.auth);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('userId');

    const other = await signup(env);
    expect((await env.http.get(`/api/repos/${repoId}/memory`).set(other.auth)).status).toBe(404);
    expect((await env.http.delete(`/api/repos/${repoId}/memory/${add.body.id}`).set(other.auth)).status).toBe(404);
    expect((await env.http.post(`/api/repos/${repoId}/memory`).set(s.auth).send({ text: 'x'.repeat(301) })).status).toBe(400);
    expect((await env.http.delete(`/api/repos/${repoId}/memory/${add.body.id}`).set(s.auth)).status).toBe(200);
    expect((await env.http.get(`/api/repos/${repoId}/memory`).set(s.auth)).body.items).toHaveLength(0);
  });

  it('sends notes with the run and learns from rejection feedback and completed work', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    await env.http.post(`/api/repos/${repoId}/memory`).set(s.auth).send({ text: 'Never touch the migrations folder' });
    const task = await newTask(env, s, repoId);
    const run = await waitFor(() => runsFor('Add feature').find((c) => (c.body as { runId: string }).runId === task.runId));
    expect((run.body as { memory: string[] }).memory).toEqual(['Never touch the migrations folder']);

    await emit(env, task.runId, 1, 'run.started', { kind: 'feature' });
    await emit(env, task.runId, 2, 'approval.requested', { approvalId: 'a1', kind: 'plan', summary: 'plan', payload: {} });
    const rejected = await env.http.post(`/api/tasks/${task.id}/approvals/a1`).set(s.auth).send({ decision: 'reject', feedback: 'Too many files, keep it small' });
    expect(rejected.status).toBe(200);
    await emit(env, task.runId, 3, 'run.completed', { status: 'completed', summary: 'done' });

    const notes = (await env.http.get(`/api/repos/${repoId}/memory`).set(s.auth)).body.items as { text: string; source: string }[];
    expect(notes.find((n) => n.source === 'feedback')?.text).toContain('Too many files, keep it small');
    expect(notes.find((n) => n.source === 'outcome')?.text).toBe('Completed feature: Add feature');

    const next = await newTask(env, s, repoId);
    const run2 = await waitFor(() => runsFor().find((c) => (c.body as { runId: string }).runId === next.runId));
    const sent = (run2.body as { memory: string[] }).memory;
    expect(sent[0]).toBe('Never touch the migrations folder'); // manual notes come first
    expect(sent.length).toBe(3);
  });
});

describe('issue to PR autopilot', () => {
  it('lists open issues (not PRs) with an inferred task type and starts a gated task', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const list = await env.http.get(`/api/repos/${repoId}/issues`).set(s.auth);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { number: number; kind: string }) => [i.number, i.kind])).toEqual([[12, 'bugfix'], [13, 'feature']]);

    const run = await env.http.post(`/api/repos/${repoId}/issues/12/run`).set(s.auth).send({});
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ kind: 'bugfix', autoApprove: false, issue: { number: 12 } });
    expect(run.body.title).toBe('#12 Login crashes on empty password');
    const sent = await waitFor(() => runsFor().find((c) => (c.body as { runId: string }).runId === run.body.runId));
    expect((sent.body as { options: { autoApprove: boolean } }).options.autoApprove).toBe(false);

    const again = await env.http.post(`/api/repos/${repoId}/issues/12/run`).set(s.auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('issue_already_running');
    expect((await env.http.post(`/api/repos/${repoId}/issues/999/run`).set(s.auth).send({})).status).toBeGreaterThanOrEqual(400);
    const after = await env.http.get(`/api/repos/${repoId}/issues`).set(s.auth);
    expect(after.body.items[0].taskId).toBe(run.body.id);
  });

  it('webhook: verifies the HMAC, ignores noise and starts a task for the trigger label', async () => {
    const s = await signup(env);
    const repoId = await readyRepo(env, s);
    const payload = JSON.stringify({
      action: 'labeled', label: { name: 'devforge' },
      issue: { number: 13, title: 'Add dark mode', body: 'please', html_url: 'https://github.com/octo/demo/issues/13', labels: [{ name: 'enhancement' }] },
      repository: { full_name: 'octo/demo' },
    });
    const post = (body: string, headers: Record<string, string>) =>
      env.http.post('/webhooks/github').set('Content-Type', 'application/json').set(headers).send(body);

    expect((await post(payload, { 'X-GitHub-Event': 'issues' })).status).toBe(401);
    expect((await post(payload, { 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    const tampered = await post(payload.replace('dark', 'DARK'), { 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': sign(payload) });
    expect(tampered.status).toBe(401);

    const other = JSON.stringify({ action: 'labeled', label: { name: 'wontfix' }, issue: { number: 13, title: 't', body: '', html_url: 'u' }, repository: { full_name: 'octo/demo' } });
    const ignored = await post(other, { 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': sign(other) });
    expect(ignored.status).toBe(200);
    expect(ignored.body.status).toBe('ignored');

    const ok = await post(payload, { 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': sign(payload) });
    expect(ok.status).toBe(202);
    expect(ok.body.status).toBe('started');
    const mine = await waitFor(async () => {
      const tasks = (await env.http.get(`/api/tasks?repoId=${repoId}`).set(s.auth)).body.items as { issue?: { number: number } }[];
      return tasks.find((t) => t.issue?.number === 13);
    });
    expect(mine).toMatchObject({ kind: 'feature', autoApprove: false, issue: { number: 13 } });

    const dup = await post(payload, { 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': sign(payload) });
    expect(dup.status).toBe(200);
    expect(dup.body.reason).toBe('already running');
    const ping = JSON.stringify({ zen: 'hi' });
    expect((await post(ping, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sign(ping) })).body.reason).toBe('ping');
  });

  it('webhook is disabled without a secret', async () => {
    const plain = await createEnv();
    try {
      const res = await plain.http.post('/webhooks/github').set('X-GitHub-Event', 'ping').send({ zen: 'x' });
      expect(res.status).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('infers the task type from labels and title', () => {
    expect(kindFromIssue(['Bug'], 'x')).toBe('bugfix');
    expect(kindFromIssue(['documentation'], 'x')).toBe('explain');
    expect(kindFromIssue([], 'Fix crash on save')).toBe('bugfix');
    expect(kindFromIssue([], 'Improve onboarding')).toBe('feature');
    expect(kindFromIssue(['needs-tests'], 'x')).toBe('tests');
  });
});

void GH_TOKEN;
