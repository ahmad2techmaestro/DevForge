import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../types/index';
import { deriveCrew } from './crew';

let n = 0;
const ev = (type: string, data: unknown = {}): RunEvent => ({ seq: ++n, type, ts: '2026-01-01T00:00:00Z', data }) as RunEvent;
const node = (name: string, ...inner: RunEvent[]) => [ev('node.started', { node: name }), ...inner, ev('node.finished', { node: name })];

describe('deriveCrew', () => {
  it('tracks the active agent and records handoffs', () => {
    n = 0;
    const view = deriveCrew([...node('classify'), ev('node.started', { node: 'plan' }), ev('log', { level: 'info', message: 'reading files' })]);
    const planner = view.agents.find((a) => a.meta.id === 'planner')!;
    expect(planner.state).toBe('working');
    expect(planner.activity).toContain('reading files');
    expect(view.focus).toBe('planner');
  });

  it('shows who waits on the human and what happens after approval', () => {
    n = 0;
    const waiting = deriveCrew([ev('node.started', { node: 'plan' }), ev('approval.requested', { approvalId: 'a', kind: 'plan', summary: '', payload: {} })]);
    expect(waiting.agents[0].state).toBe('waiting');
    expect(waiting.focus).toBe('planner');
    expect(waiting.handoffs.at(-1)).toMatchObject({ from: 'Planner', to: 'You' });

    n = 0;
    const done = deriveCrew([
      ev('node.started', { node: 'plan' }),
      ev('approval.requested', { approvalId: 'a', kind: 'plan', summary: '', payload: {} }),
      ev('approval.resolved', { approvalId: 'a', decision: 'approve' }),
      ev('node.started', { node: 'implement' }),
    ]);
    expect(done.agents[0].state).toBe('done');
    expect(done.agents[1].state).toBe('working');
    expect(done.handoffs.map((h) => `${h.from}>${h.to}`)).toEqual(['Planner>You', 'You>Planner', 'Planner>Engineer']);
  });

  it('counts fix loops, edits and test results', () => {
    n = 0;
    const view = deriveCrew([
      ...node('implement', ev('file.changed', { path: 'a.py', additions: 1, deletions: 0 })),
      ...node('test', ev('tests.result', { passed: 1, failed: 1, total: 2, ok: false, output: '', durationMs: 1, sandbox: 's', framework: 'pytest' })),
      ...node('fix'),
    ]);
    const by = Object.fromEntries(view.agents.map((a) => [a.meta.id, a]));
    expect(by.engineer.stats).toEqual(['1 file edit', '1 fix pass']);
    expect(by.qa.stats).toEqual(['1/2 passed']);
    expect(view.handoffs.some((h) => h.note.includes('tests failed'))).toBe(true);
  });

  it('settles every agent when the run finishes', () => {
    n = 0;
    const events = [ev('node.started', { node: 'implement' })];
    expect(deriveCrew(events, 'completed').agents[1].state).toBe('done');
    expect(deriveCrew(events, 'failed').agents[1].state).toBe('failed');
    expect(deriveCrew(events, 'cancelled').agents[1].state).toBe('idle');
    expect(deriveCrew(events, 'cancelled').focus).toBeNull();
  });
});
