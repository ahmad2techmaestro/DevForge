#!/usr/bin/env node
// End-to-end browser crawl: boots the real stack, drives every page, fails on console errors or 4xx/5xx.
// Usage: (cd client && npm run build) && node scripts/crawl.mjs
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
const KEY = 'crawl-internal-key';
const work = mkdtempSync(join(tmpdir(), 'devforge-crawl-'));
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

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

async function main() {
  start('redis-server', ['--port', String(P.redis), '--save', '', '--appendonly', 'no', '--dir', work]);
  await sleep(500);
  start(join(root, 'ai-service/.venv/bin/uvicorn'), ['app.main:app', '--port', String(P.agent), '--log-level', 'warning'], { cwd: join(root, 'ai-service'), env: { ...process.env, INTERNAL_KEY: KEY, LLM_PROVIDER: 'mock', SANDBOX: 'subprocess', MCP_ALLOW_STDIO: 'true', WORKDIR: join(work, 'agent') } });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${P.agent}/health`)).ok, 'agent');
  start(join(root, 'server/node_modules/.bin/tsx'), ['src/server.ts'], { cwd: join(root, 'server'), env: { ...process.env, PORT: String(P.api), DB_DRIVER: 'memory', REDIS_URL: `redis://127.0.0.1:${P.redis}`, AGENT_URL: `http://127.0.0.1:${P.agent}`, API_PUBLIC_URL: API, INTERNAL_KEY: KEY, ALLOW_LOCAL_REPOS: 'true', BCRYPT_COST: '4', RATE_LIMIT_API_PER_MIN: '5000', RATE_LIMIT_AUTH_PER_MIN: '100', LOG_LEVEL: 'silent', CORS_ORIGINS: WEB } });
  await waitFor(async () => (await fetch(`${API}/api/health`)).ok, 'api');
  start(join(root, 'client/node_modules/.bin/vite'), ['preview', '--port', String(P.web), '--host', '127.0.0.1'], { cwd: join(root, 'client') });
  await waitFor(async () => (await fetch(WEB)).ok, 'web preview');

  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let bad = [];
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/favicon')) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  const clean = async (name, fn) => {
    bad = [];
    try { await fn(); await sleep(400); check(name, bad.length === 0, bad.join(' | ')); }
    catch (e) { check(name, false, `${e.message.split('\n')[0]} ${bad.join(' | ')}`); }
  };

  // 1. Real sign-up through the form, then sign out and sign back in.
  const email = 'crawl@devforge.dev', password = 'correct horse battery';
  await clean('sign up via form', async () => {
    await page.goto(`${WEB}/register`, { waitUntil: 'networkidle' });
    await page.fill('#name', 'Crawl User'); await page.fill('#email', email); await page.fill('#password', password);
    await page.locator('button[type=submit]').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/register'), { timeout: 15000 });
  });
  const auth = await page.evaluate(() => JSON.parse(localStorage.getItem('df-auth') || 'null'));
  const token0 = auth?.token;
  check('session stored after sign up', !!token0);
  await clean('sign out', async () => {
    await page.getByRole('button', { name: /sign out/i }).first().click();
    await page.waitForURL((u) => /login|welcome/.test(u.pathname), { timeout: 10000 });
  });
  await clean('sign in via form', async () => {
    await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    await page.fill('#email', email); await page.fill('#password', password);
    await page.locator('button[type=submit]').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  });
  await page.getByRole('button', { name: /sign out/i }).first().click();
  await page.waitForURL((u) => /login|welcome/.test(u.pathname), { timeout: 10000 });
  bad = [];
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', email); await page.fill('#password', 'wrong password!!');
  await page.locator('button[type=submit]').click();
  await sleep(1200);
  check('wrong password is rejected', /login/.test(page.url()) && bad.some((b) => b.startsWith('401')));

  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', email); await page.fill('#password', password);
  await page.locator('button[type=submit]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  const token2 = await page.evaluate(() => JSON.parse(localStorage.getItem('df-auth') || 'null')?.token);

  const token = token2;
  // 2. Connect a repo, seed work through the real API.
  const repo = await call('POST', '/api/repos', { localPath: demoRepo() }, token);
  await waitFor(async () => (await call('GET', `/api/repos/${repo.id}`, undefined, token)).status === 'ready', 'repo ready');
  check('repo indexed to ready', true);
  const approveNext = async (taskId, kind) => {
    const a = await waitFor(async () => (await call('GET', `/api/tasks/${taskId}`, undefined, token)).approvals.find((x) => x.kind === kind && x.status === 'pending'), `${kind} approval`, 120000);
    await call('POST', `/api/tasks/${taskId}/approvals/${a.approvalId}`, { decision: 'approve' }, token);
  };
  const t = await call('POST', `/api/repos/${repo.id}/tasks`, { kind: 'tests', title: 'Add tests for inventory.in_stock', description: 'Cover the empty-stock case.' }, token);
  await approveNext(t.id, 'plan'); await approveNext(t.id, 'changes');
  await waitFor(async () => (await call('GET', `/api/tasks/${t.id}`, undefined, token)).task.status === 'completed', 'task completed', 120000);
  check('task ran plan -> approve -> changes -> approve -> completed', true);
  const t2 = await call('POST', `/api/repos/${repo.id}/tasks`, { kind: 'feature', title: 'Reject negative quantities', description: 'place() raises ValueError for qty <= 0.' }, token);
  await waitFor(async () => (await call('GET', `/api/tasks/${t2.id}`, undefined, token)).task.status === 'awaiting_approval', 'plan pending', 120000);

  // 3. MCP: register DevForge's own MCP server over stdio and make sure tools are discovered.
  const py = join(root, 'ai-service/.venv/bin/python');
  const srv = await call('POST', '/api/mcp', { name: 'devforge', transport: 'stdio', command: py, args: ['-m', 'app.mcp.server', '--repo', join(work, 'shop-api')] }, token);
  check('MCP server connects and lists tools', srv.lastCheck?.ok === true && (srv.tools?.length ?? 0) >= 5, JSON.stringify(srv).slice(0, 200));

  // 4. Visit every page; no console errors, no failed requests.
  const pages = ['/', '/repos', `/repos/${repo.id}`, ...['files', 'chat', 'search', 'impact', 'graph', 'health', 'bugs', 'security', 'issues', 'reviews', 'ci', 'memory', 'tasks'].map((s) => `/repos/${repo.id}/${s}`), '/tasks', `/tasks/${t.id}`, `/tasks/${t2.id}`, '/board', '/activity', '/mcp', '/benchmarks', '/audit', '/settings', '/welcome'];
  for (const p of pages) {
    await clean(`page ${p.replace(repo.id, ':repo').replace(t.id, ':done').replace(t2.id, ':pending')}`, async () => {
      await page.goto(`${WEB}${p}`, { waitUntil: 'networkidle' });
      const text = await page.locator('body').innerText();
      if (/something went wrong|page not found/i.test(text)) throw new Error('error screen shown');
      if (text.trim().length < 40) throw new Error('page is empty');
    });
  }

  // 5. Interactions.
  await clean('MCP page lists the server', async () => { await page.goto(`${WEB}/mcp`, { waitUntil: 'networkidle' }); await page.getByText('devforge').first().waitFor({ timeout: 8000 }); });
  await clean('connect a local folder pasted with quotes', async () => {
    await page.goto(`${WEB}/repos`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /connect repository/i }).first().click();
    await page.getByRole('radio', { name: /local path/i }).click();
    await page.fill('#local-path', `"${join(work, 'shop-api')}"`);
    await page.getByRole('button', { name: /^connect$/i }).click();
    await page.waitForURL(/\/repos\/[0-9a-f-]{36}$/, { timeout: 15000 });
    const id = page.url().split('/').pop();
    await waitFor(async () => (await call('GET', `/api/repos/${id}`, undefined, token)).status === 'ready', 'quoted-path repo ready', 60000);
  });
  await clean('a missing folder fails with a clear reason', async () => {
    const r = await call('POST', '/api/repos', { localPath: '/definitely/not/here/WeatherX' }, token);
    const failed = await waitFor(async () => { const x = await call('GET', `/api/repos/${r.id}`, undefined, token); return x.status === 'error' ? x : null; }, 'index error', 30000);
    if (!/Folder not found/.test(failed.error ?? '')) throw new Error(`unclear error: ${failed.error}`);
    await page.goto(`${WEB}/repos/${r.id}`, { waitUntil: 'networkidle' });
    await page.getByText(/Folder not found/).first().waitFor({ timeout: 8000 });
  });
  await clean('benchmarks: run is disabled with the demo model and says why', async () => {
    await page.goto(`${WEB}/benchmarks`, { waitUntil: 'networkidle' });
    await page.getByText(/Add a provider and API key/).waitFor({ timeout: 8000 });
    if (!(await page.getByRole('button', { name: /quick run/i }).isDisabled())) throw new Error('run button should be disabled');
  });
  await clean('settings explains the local-process sandbox', async () => {
    await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle' });
    await page.getByText('Local process (no isolation)').waitFor({ timeout: 8000 });
    await page.getByText(/install and start Docker Desktop/).waitFor({ timeout: 8000 });
  });
  await clean('ask the codebase (chat)', async () => {
    await page.goto(`${WEB}/repos/${repo.id}/chat`, { waitUntil: 'networkidle' });
    await page.getByLabel('Message').fill('Where is the order total calculated?');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText(/pricing/i).first().waitFor({ timeout: 20000 });
  });
  await clean('semantic search returns hits', async () => {
    await page.goto(`${WEB}/repos/${repo.id}/search?q=order+total`, { waitUntil: 'networkidle' });
    await page.getByText(/pricing\.py|orders\.py/).first().waitFor({ timeout: 15000 });
  });
  await clean('security audit runs', async () => {
    await page.goto(`${WEB}/repos/${repo.id}/security`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /run security audit/i }).click();
    await page.getByText('Fix with agent').first().waitFor({ timeout: 20000 });
  });
  await clean('Cmd+K palette opens and searches', async () => {
    await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').waitFor({ timeout: 5000 });
    await page.keyboard.type('board');
    await sleep(300);
    await page.keyboard.press('Escape');
  });
  await clean('approve pending plan in the UI', async () => {
    await page.goto(`${WEB}/tasks/${t2.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^approve/i }).first().click();
    await waitFor(async () => (await call('GET', `/api/tasks/${t2.id}`, undefined, token)).approvals.some((a) => a.kind === 'plan' && a.status === 'approved'), 'plan approved', 20000);
  });
  await clean('settings page saves nothing broken', async () => { await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle' }); });
  await clean('unknown route shows 404 page', async () => { await page.goto(`${WEB}/no-such-page`, { waitUntil: 'networkidle' }); await page.getByText(/not found|404/i).first().waitFor({ timeout: 5000 }); });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; } finally { for (const p of procs) p.kill('SIGTERM'); await sleep(400); process.exit(process.exitCode ?? 0); }
