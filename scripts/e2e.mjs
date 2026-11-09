#!/usr/bin/env node
// Full-stack smoke test: redis + agent (mock LLM, subprocess sandbox) + API (in-memory DB).
// Drives a feature task through plan approval -> implementation -> tests -> change approval -> completion.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = { redis: 6391, agent: 8191, api: 4191 };
const API = `http://127.0.0.1:${P.api}`;
const KEY = 'e2e-internal-key';
const work = mkdtempSync(join(tmpdir(), 'devforge-e2e-'));
const procs = [];
let failed = false;

const log = (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  ok(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.tail = () => out.split('\n').slice(-25).join('\n');
  p.name = name;
  procs.push(p);
  return p;
}

async function waitFor(fn, what, timeout = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return data;
}

function fixtureRepo() {
  const dir = join(work, 'fixture');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef div(a, b):\n    return a / b\n');
  writeFileSync(join(dir, 'tests', 'test_calc.py'), 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n');
  writeFileSync(join(dir, 'README.md'), '# Calc\nTiny calculator used by the e2e test.\n');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

async function main() {
  log('starting redis');
  start('redis', 'redis-server', ['--port', String(P.redis), '--save', '', '--appendonly', 'no', '--dir', work]);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${P.redis}`).catch((e) => e.cause?.code === 'ECONNRESET' || true)) && true, 'redis', 5000);
  await sleep(300);

  log('starting agent service (mock LLM, subprocess sandbox)');
  const venv = join(root, 'ai-service/.venv/bin/uvicorn');
  start('agent', existsSync(venv) ? venv : 'uvicorn', ['app.main:app', '--port', String(P.agent), '--log-level', 'warning'], {
    cwd: join(root, 'ai-service'),
    env: { ...process.env, INTERNAL_KEY: KEY, LLM_PROVIDER: 'mock', SANDBOX: 'subprocess', WORKDIR: join(work, 'agent') },
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${P.agent}/health`)).ok, 'agent /health');

  log('starting API (in-memory DB)');
  start('api', join(root, 'server/node_modules/.bin/tsx'), ['src/server.ts'], {
    cwd: join(root, 'server'),
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(P.api), DB_DRIVER: 'memory', REDIS_URL: `redis://127.0.0.1:${P.redis}`,
      AGENT_URL: `http://127.0.0.1:${P.agent}`, API_PUBLIC_URL: API, INTERNAL_KEY: KEY, ALLOW_LOCAL_REPOS: 'true',
      BCRYPT_COST: '4', LOG_LEVEL: 'warn',
    },
  });
  const health = await waitFor(async () => (await fetch(`${API}/api/health`)).json(), 'API /api/health');
  assert(health.db === 'memory' && health.redis && health.agent, 'API healthy with redis + agent reachable');

  log('auth');
  const { token } = await call('POST', '/api/auth/register', { email: 'e2e@example.com', password: 'correct horse battery', name: 'E2E' });
  const me = await call('GET', '/api/me', undefined, token);
  assert(me.agent.reachable && me.agent.provider === 'mock', 'me reports reachable mock agent');

  log('connect + index repository');
  const repo = await call('POST', '/api/repos', { localPath: fixtureRepo() }, token);
  const ready = await waitFor(async () => {
    const r = await call('GET', `/api/repos/${repo.id}`, undefined, token);
    if (r.status === 'error') throw new Error(`index failed: ${r.error}`);
    return r.status === 'ready' ? r : null;
  }, 'repo ready', 60000);
  assert(ready.stats.fileCount >= 3, `indexed ${ready.stats.fileCount} files`);

  const { files } = await call('GET', `/api/repos/${repo.id}/tree`, undefined, token);
  assert(files.some((f) => f.path === 'calc.py'), 'tree lists calc.py');
  const file = await call('GET', `/api/repos/${repo.id}/file?path=calc.py`, undefined, token);
  assert(file.content.includes('def div'), 'file content readable');
  const health2 = await call('GET', `/api/repos/${repo.id}/health`, undefined, token);
  assert(typeof health2.score === 'number', `health score ${health2.score}`);
  const chat = await call('POST', `/api/repos/${repo.id}/chat`, { message: 'What does div do?' }, token);
  assert(chat.messages.at(-1).role === 'assistant', 'chat returns an assistant reply');
  const search = await call('POST', `/api/repos/${repo.id}/search`, { query: 'div' }, token);
  assert(search.results.length > 0, 'code search finds results');
  const traversal = await fetch(`${API}/api/repos/${repo.id}/file?path=../../etc/passwd`, { headers: { authorization: `Bearer ${token}` } });
  assert(traversal.status >= 400 && traversal.status < 500, `path traversal rejected (${traversal.status})`);

  log('security auditor + repo memory');
  const sec = await call('POST', `/api/repos/${repo.id}/security`, {}, token);
  assert(sec.score === 100 && Array.isArray(sec.findings), `security audit on a clean repo scores ${sec.score}`);
  const note = await call('POST', `/api/repos/${repo.id}/memory`, { text: 'Prefer ValueError with a clear message' }, token);
  assert(note.source === 'manual', 'memory note saved');

  log('feature task with human approval gates');
  const task = await call('POST', `/api/repos/${repo.id}/tasks`, {
    kind: 'feature', title: 'Handle division by zero', description: 'div(a, 0) should raise a clear ValueError instead of ZeroDivisionError.',
  }, token);
  const waitStatus = (want, t = 90000) => waitFor(async () => {
    const d = await call('GET', `/api/tasks/${task.id}`, undefined, token);
    if (d.task.status === 'failed') throw new Error(`task failed: ${d.task.error}`);
    return d.task.status === want ? d : null;
  }, `task ${want}`, t);

  let d = await waitStatus('awaiting_approval');
  let pending = d.approvals.find((a) => a.status === 'pending');
  assert(pending?.kind === 'plan', 'plan approval requested');
  await call('POST', `/api/tasks/${task.id}/approvals/${pending.approvalId}`, { decision: 'approve' }, token);

  d = await waitFor(async () => {
    const x = await call('GET', `/api/tasks/${task.id}`, undefined, token);
    if (x.task.status === 'failed') throw new Error(`task failed: ${x.task.error}`);
    return x.approvals.some((a) => a.kind === 'changes' && a.status === 'pending') ? x : null;
  }, 'changes approval', 120000);
  pending = d.approvals.find((a) => a.kind === 'changes' && a.status === 'pending');
  const types = new Set(d.events.map((e) => e.type));
  assert(d.events.some((e) => e.type === 'log' && String(e.data.message).includes('loaded 1 repository memory note')), 'agent received the repo memory');
  assert(types.has('tests.result'), 'tests were run in the sandbox before asking for approval');
  assert(types.has('diff.ready') && types.has('review.result'), 'diff and AI review produced');
  const diff = await call('GET', `/api/tasks/${task.id}/diff`, undefined, token);
  assert(diff.diff.includes('@@') && diff.files.length > 0, `diff has ${diff.files.length} changed file(s)`);

  await call('POST', `/api/tasks/${task.id}/approvals/${pending.approvalId}`, { decision: 'approve' }, token);
  d = await waitStatus('completed');
  assert(d.task.risk && d.task.usage, 'completed with risk and usage recorded');
  const seqs = d.events.map((e) => e.seq);
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'events are strictly ordered');
  assert(d.events.at(-1).type === 'run.completed', 'stream ends with run.completed');

  const learned = await call('GET', `/api/repos/${repo.id}/memory`, undefined, token);
  assert(learned.items.some((n) => n.source === 'outcome'), 'completed work was learned into memory');

  log('rejection path');
  const t2 = await call('POST', `/api/repos/${repo.id}/tasks`, { kind: 'tests', title: 'Add tests', description: 'cover div' }, token);
  const d2 = await waitFor(async () => {
    const x = await call('GET', `/api/tasks/${t2.id}`, undefined, token);
    return x.approvals.some((a) => a.status === 'pending') ? x : null;
  }, 'second approval', 90000);
  await call('POST', `/api/tasks/${t2.id}/cancel`, undefined, token);
  const c = await waitFor(async () => {
    const x = await call('GET', `/api/tasks/${t2.id}`, undefined, token);
    return ['cancelled', 'failed'].includes(x.task.status) ? x : null;
  }, 'cancellation');
  assert(c.task.status === 'cancelled', 'cancel stops a task awaiting approval');
  void d2;

  log('metrics + stats + audit');
  const stats = await call('GET', '/api/stats', undefined, token);
  assert(stats.tasks.total === 2 && stats.tasks.byStatus.completed === 1, 'stats reflect tasks');
  const audit = await call('GET', '/api/audit', undefined, token);
  assert(audit.items.length > 0, 'audit log has entries');
  const metrics = await (await fetch(`${API}/metrics`)).text();
  assert(metrics.includes('devforge_'), 'prometheus metrics exposed');
  const noKey = await fetch(`${API}/internal/runs/x/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(noKey.status === 401 || noKey.status === 403, 'internal endpoint rejects missing key');
}

try {
  await main();
  console.log('\n\x1b[32mE2E PASSED\x1b[0m');
} catch (err) {
  failed = true;
  console.error(`\n\x1b[31mE2E FAILED:\x1b[0m ${err.message}`);
  for (const p of procs) if (p.name !== 'redis') console.error(`\n--- ${p.name} output (tail) ---\n${p.tail()}`);
} finally {
  for (const p of procs.reverse()) p.kill('SIGTERM');
  await sleep(500);
  process.exit(failed ? 1 : 0);
}
