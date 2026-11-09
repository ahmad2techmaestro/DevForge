// Shared helpers for the root scripts (cross-platform: Windows, macOS, Linux).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const isWin = process.platform === 'win32';
export const dirs = { client: join(root, 'client'), server: join(root, 'server'), ai: join(root, 'ai-service') };
export const venvBin = (name) => join(dirs.ai, '.venv', isWin ? 'Scripts' : 'bin', isWin ? `${name}.exe` : name);
export const npmCmd = isWin ? 'npm.cmd' : 'npm';

export const c = { cyan: (s) => `\x1b[36m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` };
export const step = (msg) => console.log(`${c.cyan('▸')} ${msg}`);

/** Runs a command to completion with inherited output. Exits the process on failure. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin && cmd.endsWith('.cmd'), ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(c.red(`\n✗ "${cmd} ${args.join(' ')}" failed (exit ${r.status})`));
    process.exit(r.status ?? 1);
  }
}

export function has(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

export function findPython() {
  for (const name of isWin ? ['py', 'python', 'python3'] : ['python3', 'python']) if (has(name)) return name;
  return null;
}

export const ready = existsSync;
export { spawn, spawnSync };

/** Minimal .env reader (KEY=VALUE, # comments, optional quotes). Returns {} when the file is missing. */
export function readEnvFile(file = join(root, '.env')) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (val !== '') out[key] = val;
  }
  return out;
}
