import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

/** Starts a throwaway redis-server for the whole test run (no external services needed). */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = await freePort();
  const proc: ChildProcess = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], {
    stdio: 'ignore',
  });
  const url = `redis://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (!(await canConnect(port))) {
    if (Date.now() > deadline) throw new Error('redis-server did not start (is it installed?)');
    await new Promise((r) => setTimeout(r, 100));
  }
  project.provide('redisUrl', url);
  return async () => {
    proc.kill('SIGTERM');
  };
}
