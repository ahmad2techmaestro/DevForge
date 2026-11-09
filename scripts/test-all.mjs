#!/usr/bin/env node
// Runs every test suite: ai-service (pytest + ruff), server (typecheck + vitest), client (typecheck + vitest + build).
import { dirs, npmCmd, run, step, venvBin, c } from './lib.mjs';

step('ai-service: ruff'); run(venvBin('ruff'), ['check', '.'], { cwd: dirs.ai });
step('ai-service: pytest'); run(venvBin('python'), ['-m', 'pytest', '-q'], { cwd: dirs.ai });
step('server: typecheck'); run(npmCmd, ['run', 'typecheck'], { cwd: dirs.server });
step('server: tests'); run(npmCmd, ['test'], { cwd: dirs.server });
step('client: typecheck'); run(npmCmd, ['run', 'typecheck'], { cwd: dirs.client });
step('client: tests'); run(npmCmd, ['test'], { cwd: dirs.client });
step('client: build'); run(npmCmd, ['run', 'build'], { cwd: dirs.client });
console.log(`\n${c.green('All suites passed.')}`);
