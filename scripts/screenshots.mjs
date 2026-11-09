#!/usr/bin/env node
// Regenerates docs/images/*.png from a real running stack (mock LLM, in-memory DB).
// Usage: (cd client && npm run build) && node scripts/screenshots.mjs
// If Playwright cannot find its browser, set PW_CHROMIUM=/path/to/chrome.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, 'client/package.json'))('playwright');
const P = { redis: 6392, agent: 8000, api: 4000, web: 4173 };
const API = `http://127.0.0.1:${P.api}`;
const WEB = `http://127.0.0.1:${P.web}`;
const KEY = 'screens-internal-key';
const work = mkdtempSync(join(tmpdir(), 'devforge-shots-'));
const out = process.env.SHOT_OUT ?? join(root, 'docs/images');
const THEME = process.env.SHOT_THEME ?? 'light';
mkdirSync(out, { recursive: true });
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const start = (cmd, args, opts) => {
  const p = spawn(cmd, args, { ...opts, stdio: 'ignore' });
  procs.push(p);
  return p;
};
async function waitFor(fn, what, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`timeout: ${what}`);
}
async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function demoRepo() {
  const dir = join(work, 'shop-api');
  const w = (p, c) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('README.md', '# Shop API\nA small order-management service used for the DevForge demo.\n');
  w('shop/__init__.py', '');
  w('shop/pricing.py', 'from shop.models import Item\n\n\ndef total(items: list[Item], discount: float = 0.0) -> float:\n    subtotal = sum(i.price * i.qty for i in items)\n    return round(subtotal * (1 - discount), 2)\n');
  w('shop/models.py', 'from dataclasses import dataclass\n\n\n@dataclass\nclass Item:\n    sku: str\n    price: float\n    qty: int = 1\n');
  w('shop/orders.py', 'import subprocess\nimport requests\nfrom shop.pricing import total\nfrom shop.models import Item\n\nAPI_KEY = "sk-live-' + 'x9f2k1m4p7q8r3t6v0w5y2z1a4b7c9d3' + '"\n\n\ndef place(items: list[Item], note: str):\n    subprocess.run("echo " + note, shell=True)\n    requests.post("https://pay.example.com/charge", json={"amount": total(items)}, verify=False)\n    return {"total": total(items)}\n\n\ndef refund(order_id, reason=[]):\n    try:\n        return order_id\n    except:\n        pass\n');
  w('shop/inventory.py', 'from shop.models import Item\n\n\ndef in_stock(item: Item, stock: dict) -> bool:\n    # TODO: handle reservations\n    return stock.get(item.sku, 0) >= item.qty\n');
  w('tests/test_pricing.py', 'from shop.models import Item\nfrom shop.pricing import total\n\n\ndef test_total():\n    assert total([Item("a", 2.5, 2)]) == 5.0\n');
  w('requirements.txt', 'flask\nrequests\npytest==8.3.2\n');
  w('Dockerfile', 'FROM python:latest\nCOPY . /app\nCMD ["python", "-m", "shop"]\n');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'demo@example.com'); git('config', 'user.name', 'demo');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  return dir;
}

async function main() {
  start('redis-server', ['--port', String(P.redis), '--save', '', '--appendonly', 'no', '--dir', work]);
  await sleep(500);
  const uv = join(root, 'ai-service/.venv/bin/uvicorn');
  start(uv, ['app.main:app', '--port', String(P.agent), '--log-level', 'warning'], { cwd: join(root, 'ai-service'), env: { ...process.env, INTERNAL_KEY: KEY, LLM_PROVIDER: 'mock', SANDBOX: 'subprocess', WORKDIR: join(work, 'agent') } });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${P.agent}/health`)).ok, 'agent');
  start(join(root, 'server/node_modules/.bin/tsx'), ['src/server.ts'], { cwd: join(root, 'server'), env: { ...process.env, PORT: String(P.api), DB_DRIVER: 'memory', REDIS_URL: `redis://127.0.0.1:${P.redis}`, AGENT_URL: `http://127.0.0.1:${P.agent}`, API_PUBLIC_URL: API, INTERNAL_KEY: KEY, ALLOW_LOCAL_REPOS: 'true', BCRYPT_COST: '4', LOG_LEVEL: 'silent', CORS_ORIGINS: WEB } });
  await waitFor(async () => (await fetch(`${API}/api/health`)).ok, 'api');
  start(join(root, 'client/node_modules/.bin/vite'), ['preview', '--port', String(P.web), '--host', '127.0.0.1'], { cwd: join(root, 'client') });
  await waitFor(async () => (await fetch(WEB)).ok, 'web preview');

  const { token, user } = await call('POST', '/api/auth/register', { email: 'demo@devforge.dev', password: 'correct horse battery', name: 'Shah Ahmad Raza' });
  const repo = await call('POST', '/api/repos', { localPath: demoRepo() }, token);
  await waitFor(async () => (await call('GET', `/api/repos/${repo.id}`, undefined, token)).status === 'ready', 'repo ready');
  await call('POST', `/api/repos/${repo.id}/memory`, { text: 'Use pytest fixtures; never touch the payments module without tests' }, token);
  await call('POST', `/api/repos/${repo.id}/memory`, { text: 'Prefer small, reviewable diffs (max 3 files per task)' }, token);
  await call('POST', `/api/repos/${repo.id}/chat`, { message: 'Where is the order total calculated?' }, token);

  const approveNext = async (taskId, kind) => {
    const a = await waitFor(async () => (await call('GET', `/api/tasks/${taskId}`, undefined, token)).approvals.find((x) => x.kind === kind && x.status === 'pending'), `${kind} approval`, 120000);
    await call('POST', `/api/tasks/${taskId}/approvals/${a.approvalId}`, { decision: 'approve' }, token);
  };
  const done = await call('POST', `/api/repos/${repo.id}/tasks`, { kind: 'tests', title: 'Add tests for inventory.in_stock', description: 'Cover stock reservations and the empty-stock case.' }, token);
  await approveNext(done.id, 'plan'); await approveNext(done.id, 'changes');
  await waitFor(async () => (await call('GET', `/api/tasks/${done.id}`, undefined, token)).task.status === 'completed', 'completed', 120000);
  const pending = await call('POST', `/api/repos/${repo.id}/tasks`, { kind: 'feature', title: 'Reject orders with negative quantities', description: 'place() should raise ValueError when any item has qty <= 0.' }, token);
  await waitFor(async () => (await call('GET', `/api/tasks/${pending.id}`, undefined, token)).task.status === 'awaiting_approval', 'plan pending', 120000);
  await approveNext(pending.id, 'plan');
  await waitFor(async () => (await call('GET', `/api/tasks/${pending.id}`, undefined, token)).approvals.some((a) => a.kind === 'changes' && a.status === 'pending'), 'changes pending', 120000);

  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: THEME });
  await ctx.addInitScript(([t, u, th]) => { try { localStorage.setItem('df-auth', JSON.stringify({ token: t, user: u })); localStorage.setItem('df-theme-v2', th); } catch { /* ignore */ } }, [token, user, THEME]);
  const page = await ctx.newPage();
  const shot = async (name, url, prep) => {
    await page.goto(`${WEB}${url}`, { waitUntil: 'networkidle' });
    if (prep) await prep();
    await sleep(900);
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log('  saved', name);
  };
  await shot('dashboard', '/');
  await shot('repository', `/repos/${repo.id}`);
  await shot('graph', `/repos/${repo.id}/graph`, () => sleep(2500));
  await shot('security', `/repos/${repo.id}/security`, async () => { await page.getByRole('button', { name: /run security audit/i }).click(); await page.getByText('Fix with agent').first().waitFor(); });
  await shot('memory', `/repos/${repo.id}/memory`);
  await shot('task-approval', `/tasks/${pending.id}`);
  await shot('task-completed', `/tasks/${done.id}`);
  await shot('impact', `/repos/${repo.id}/impact`);
  await shot('search', `/repos/${repo.id}/search`);
  await shot('settings', '/settings');
  await shot('benchmarks', '/benchmarks');
  await shot('board', '/board');
  await shot('activity', '/activity');
  await shot('mcp', '/mcp');
  await page.screenshot({ path: join(out, 'task-full.png'), fullPage: true });
  await browser.close();
}

try { await main(); console.log('done'); } catch (e) { console.error(e); process.exitCode = 1; } finally { for (const p of procs) p.kill('SIGTERM'); await sleep(400); process.exit(process.exitCode ?? 0); }
