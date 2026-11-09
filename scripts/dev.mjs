#!/usr/bin/env node
// Starts the whole stack for local development: Redis (if needed), ai-service, server and client.
// On Windows uvicorn --reload forces a loop without subprocess support, so auto-reload is off there.
// Uses the in-memory database and the offline mock model, so no MongoDB or API key is required.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { c, dirs, readEnvFile, root, has, isWin, npmCmd, spawn, step, venvBin } from './lib.mjs';

const PORTS = { redis: 6379, ai: 8000, server: 4000, client: 5173 };
const KEY = 'dev-internal-key';
const children = [];

// Values from the root .env that apply to dev. Docker-only settings (SANDBOX, hosts, internal key) are ignored on purpose.
const fileEnv = readEnvFile();
const pick = (...names) => Object.fromEntries(names.filter((n) => fileEnv[n] !== undefined).map((n) => [n, fileEnv[n]]));
const aiFromFile = pick('LLM_PROVIDER', 'LLM_FAST_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GROQ_API_KEY', 'GROQ_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OLLAMA_MODEL', 'OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_MODEL', 'EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'OTLP_ENDPOINT', 'MCP_ALLOW_STDIO', 'MCP_ALLOW_PRIVATE', 'RERANK_PROVIDER', 'RERANK_BASE_URL', 'RERANK_API_KEY', 'RERANK_MODEL');
const serverFromFile = pick('JWT_SECRET', 'ENCRYPTION_KEY', 'GITHUB_WEBHOOK_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET');

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });

function start(name, color, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, shell: isWin && cmd.endsWith('.cmd'), stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = color(name.padEnd(10));
  const pipe = (stream) => stream.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`${tag} ${l}`)));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', (code) => { if (!shuttingDown) { console.log(c.red(`${name} stopped (exit ${code}). Shutting down.`)); shutdown(1); } });
  children.push(p);
  return p;
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const p of children) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => process.exit(code), 400);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ---- preflight ----
if (!existsSync(dirs.server + '/node_modules') || !existsSync(dirs.client + '/node_modules') || !existsSync(venvBin('uvicorn'))) {
  console.error(c.red('Dependencies are not installed yet. Run: npm run setup'));
  process.exit(1);
}
for (const [name, port] of [['ai-service', PORTS.ai], ['server', PORTS.server], ['client', PORTS.client]]) {
  if (await portOpen(port)) { console.error(c.red(`Port ${port} is already in use (${name}). Stop the other process first.`)); process.exit(1); }
}

// ---- redis ----
if (!(await portOpen(PORTS.redis))) {
  if (has('redis-server')) {
    step('Starting Redis');
    start('redis', c.dim, 'redis-server', ['--port', String(PORTS.redis), '--save', '', '--appendonly', 'no']);
    await new Promise((r) => setTimeout(r, 600));
  } else {
    console.error(c.red('Redis is not running on port 6379 and redis-server is not installed.'));
    console.error('Start it with Docker, then re-run:\n  docker run -d --name devforge-redis -p 6379:6379 redis:7-alpine');
    process.exit(1);
  }
} else {
  step('Using the Redis already running on port 6379');
}

step('Starting ai-service (Docker sandbox when Docker is running, otherwise a local process)');
start('ai-service', c.yellow, venvBin('uvicorn'), ['app.main:app', '--port', String(PORTS.ai), ...(isWin ? [] : ['--reload'])], {
  cwd: dirs.ai,
  env: { ...aiFromFile, ...process.env, INTERNAL_KEY: KEY, LLM_PROVIDER: process.env.LLM_PROVIDER ?? aiFromFile.LLM_PROVIDER ?? 'mock', MCP_ALLOW_STDIO: process.env.MCP_ALLOW_STDIO ?? aiFromFile.MCP_ALLOW_STDIO ?? 'true', MCP_ALLOW_PRIVATE: process.env.MCP_ALLOW_PRIVATE ?? aiFromFile.MCP_ALLOW_PRIVATE ?? 'true', SANDBOX: process.env.SANDBOX ?? aiFromFile.SANDBOX ?? 'auto', WORKDIR: process.env.WORKDIR ?? './data' },
});
if (Object.keys(fileEnv).length) step(`Loaded settings from .env${serverFromFile.GITHUB_OAUTH_CLIENT_ID ? ' (GitHub sign-in on)' : ''}${serverFromFile.GOOGLE_CLIENT_ID ? ' (Google sign-in on)' : ''}`);
step('Starting server (file-backed dev database)');
start('server', c.cyan, npmCmd, ['run', 'dev'], {
  cwd: dirs.server,
  env: { ...serverFromFile, ...process.env, DB_DRIVER: process.env.DB_DRIVER ?? 'memory', ALLOW_LOCAL_REPOS: 'true', INTERNAL_KEY: KEY, AGENT_URL: `http://127.0.0.1:${PORTS.ai}`, API_PUBLIC_URL: `http://127.0.0.1:${PORTS.server}`, REDIS_URL: `redis://127.0.0.1:${PORTS.redis}`, LOG_LEVEL: 'warn', DB_FILE: process.env.DB_FILE ?? join(root, '.devdata', 'db.json'), WEB_ORIGIN: `http://127.0.0.1:${PORTS.client}`, CORS_ORIGINS: `http://127.0.0.1:${PORTS.client},http://localhost:${PORTS.client}` },
});
step('Starting client');
start('client', c.green, npmCmd, ['run', 'dev', '--', '--host', '127.0.0.1'], { cwd: dirs.client, env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${PORTS.server}` } });

for (const [name, port] of [['server', PORTS.server], ['client', PORTS.client]]) {
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await portOpen(port))) { console.error(c.red(`${name} did not start`)); shutdown(1); }
}
step('Checking the agent service');
let agentOk = false;
for (let i = 0; i < 60 && !agentOk; i++) {
  try { agentOk = (await fetch(`http://127.0.0.1:${PORTS.ai}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* still starting */ }
  if (!agentOk) await new Promise((r) => setTimeout(r, 500));
}
if (!agentOk) console.error(c.red(`The agent service on port ${PORTS.ai} is not answering. Settings will show "Unreachable". Read the ai-service lines above for the error.`));
console.log(`\n${c.green('DevForge is running')}\n  App    ${c.cyan(`http://127.0.0.1:${PORTS.client}`)}\n  API    http://127.0.0.1:${PORTS.server}/api/health\n  Press Ctrl+C to stop.\n`);
