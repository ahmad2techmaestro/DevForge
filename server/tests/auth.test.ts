import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, signup, type Env } from './helpers.js';

describe('auth & account', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv();
  });
  afterAll(() => env.close());

  it('registers, logs in and reads /api/me without leaking secrets', async () => {
    const reg = await env.http.post('/api/auth/register').send({ email: 'Ann@Example.com', password: 'supersecret1', name: 'Ann' });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toEqual({ id: expect.any(String), email: 'ann@example.com', name: 'Ann', createdAt: expect.any(String) });
    expect(JSON.stringify(reg.body)).not.toContain('passwordHash');

    const login = await env.http.post('/api/auth/login').send({ email: 'ann@example.com', password: 'supersecret1' });
    expect(login.status).toBe(200);
    const me = await env.http.get('/api/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.github).toEqual({ connected: false });
    expect(me.body.agent).toMatchObject({ reachable: true, provider: 'mock', sandbox: 'subprocess' });
  });

  it('rejects duplicate emails, bad credentials, bad input and missing tokens', async () => {
    await signup(env, 'dup@example.com');
    const dup = await env.http.post('/api/auth/register').send({ email: 'dup@example.com', password: 'supersecret1', name: 'D' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('email_taken');

    const bad = await env.http.post('/api/auth/login').send({ email: 'dup@example.com', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect((await env.http.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'whatever12' })).body.error.code).toBe('invalid_credentials');

    const invalid = await env.http.post('/api/auth/register').send({ email: 'not-an-email', password: 'short', name: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation_error');

    expect((await env.http.get('/api/me')).status).toBe(401);
    expect((await env.http.get('/api/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });

  it('connects GitHub, stores the token encrypted and never returns it', async () => {
    const s = await signup(env);
    const bad = await env.http.post('/api/github/connect').set(s.auth).send({ token: 'ghp_wrongtoken_00000000' });
    expect(bad.status).toBe(401);

    const ok = await env.http.post('/api/github/connect').set(s.auth).send({ token: 'ghp_testtoken_0123456789abcdef' });
    expect(ok.body).toEqual({ login: 'octo', avatarUrl: 'https://avatars.test/octo.png' });
    const stored = await env.container.store.findOne<{ github: { tokenEnc: string } }>('users', { id: s.userId });
    expect(stored?.github.tokenEnc).not.toContain('ghp_testtoken');

    const me = await env.http.get('/api/me').set(s.auth);
    expect(me.body.github).toEqual({ connected: true, login: 'octo', avatarUrl: 'https://avatars.test/octo.png' });
    expect(JSON.stringify(me.body)).not.toContain('ghp_');

    const repos = await env.http.get('/api/github/repos?query=demo').set(s.auth);
    expect(repos.body.items.map((r: { fullName: string }) => r.fullName)).toEqual(['octo/demo']);

    await env.http.delete('/api/github/connect').set(s.auth).expect(200);
    expect((await env.http.get('/api/github/repos').set(s.auth)).status).toBe(409);
  });
});

describe('auth rate limiting', () => {
  it('returns 429 after too many attempts', async () => {
    const env = await createEnv({ RATE_LIMIT_AUTH_PER_MIN: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await env.http.post('/api/auth/login').send({ email: 'x@example.com', password: 'wrong-password' })).status);
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally {
      await env.close();
    }
  });
});

describe('social login', () => {
  it('reports providers as disabled without keys and refuses to start', async () => {
    const env = await createEnv();
    const res = await env.http.get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ google: false, github: false });
    expect((await env.http.get('/api/auth/oauth/google/start')).status).toBe(501);
    expect((await env.http.get('/api/auth/oauth/bogus/start')).status).toBe(404);
    await env.close();
  });
});
