import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, emit, newTask, openSocket, readyRepo, signup, waitFor, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(() => env.close());

describe('websocket hub', () => {
  it('closes with 4401 on a bad token', async () => {
    const { closed } = await openSocket(env, 'not-a-token');
    expect(await closed).toBe(4401);
  });

  it('streams subscribed task events and pushes task/repo updates to the owner only', async () => {
    const owner = await signup(env);
    const other = await signup(env);
    const ownerSock = await openSocket(env, owner.token);
    const otherSock = await openSocket(env, other.token);
    await waitFor(() => ownerSock.messages.some((m) => m.type === 'hello'));

    const repoId = await readyRepo(env, owner);
    await waitFor(() => ownerSock.messages.some((m) => m.type === 'repo.updated' && (m.repo as { status: string }).status === 'ready'), 5000, 'repo.updated');
    const task = await newTask(env, owner, repoId);

    ownerSock.ws.send(JSON.stringify({ type: 'subscribe', taskId: task.id }));
    await waitFor(() => ownerSock.messages.some((m) => m.type === 'subscribed'));
    otherSock.ws.send(JSON.stringify({ type: 'subscribe', taskId: task.id }));
    await waitFor(() => otherSock.messages.some((m) => m.type === 'error'));
    expect(otherSock.messages.find((m) => m.type === 'error')).toMatchObject({ code: 'forbidden', taskId: task.id });

    await emit(env, task.runId, 1, 'run.started', { kind: 'feature' });
    const evt = await waitFor(() => ownerSock.messages.find((m) => m.type === 'event'), 5000, 'event message');
    expect(evt).toMatchObject({ type: 'event', taskId: task.id, event: { seq: 1, type: 'run.started' } });
    expect(evt).not.toHaveProperty('userId');
    await waitFor(() => ownerSock.messages.some((m) => m.type === 'task.updated' && (m.task as { status: string }).status === 'running'));

    expect(otherSock.messages.some((m) => m.type === 'event' || m.type === 'task.updated' || m.type === 'repo.updated')).toBe(false);

    ownerSock.ws.send(JSON.stringify({ type: 'unsubscribe', taskId: task.id }));
    ownerSock.ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => ownerSock.messages.some((m) => m.type === 'pong'));
    const seen = ownerSock.messages.filter((m) => m.type === 'event').length;
    await emit(env, task.runId, 2, 'log', { level: 'info', message: 'later' });
    await new Promise((r) => setTimeout(r, 150));
    expect(ownerSock.messages.filter((m) => m.type === 'event')).toHaveLength(seen);

    ownerSock.ws.close();
    otherSock.ws.close();
  });
});
