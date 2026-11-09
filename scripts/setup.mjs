#!/usr/bin/env node
// One-time install: Node dependencies for client and server, plus the Python virtualenv for ai-service.
import { existsSync } from 'node:fs';
import { c, dirs, findPython, has, npmCmd, run, spawnSync, step, venvBin } from './lib.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(c.red(`Node 22 or newer is required (found ${process.versions.node}). Install it from https://nodejs.org`));
  process.exit(1);
}
const python = findPython();
if (!python) {
  console.error(c.red('Python 3.12+ is required for ai-service. Install it from https://python.org'));
  process.exit(1);
}

step('Installing server dependencies');
run(npmCmd, ['ci'], { cwd: dirs.server });
step('Installing client dependencies');
run(npmCmd, ['ci'], { cwd: dirs.client });
step('Creating the Python virtual environment for ai-service');
if (!existsSync(venvBin('python'))) run(python, python === 'py' ? ['-3', '-m', 'venv', '.venv'] : ['-m', 'venv', '.venv'], { cwd: dirs.ai });
run(venvBin('python'), ['-m', 'pip', 'install', '-e', '.[dev]'], { cwd: dirs.ai });
// Optional: tree-sitter grammars for deeper code intelligence. The app falls back to simpler parsers if this fails.
const intel = spawnSync(venvBin('python'), ['-m', 'pip', 'install', '-e', '.[intel]'], { cwd: dirs.ai, stdio: 'inherit' });
if (intel.status !== 0) console.log('Optional tree-sitter packages could not be installed; using the built-in fallback parsers.');

console.log(`\n${c.green('Setup complete.')} Start everything with: ${c.cyan('npm run dev')}`);
if (!has('redis-server')) {
  console.log(c.yellow('\nRedis is also needed. If you do not have it installed, run it with Docker:'));
  console.log('  docker run -d --name devforge-redis -p 6379:6379 redis:7-alpine');
}
