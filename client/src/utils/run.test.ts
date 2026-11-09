import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../types/index';
import { deriveRun, mergeEvent } from './run';

const ev = (seq: number, type: string, data: unknown = {}): RunEvent => ({ seq, type, ts: '2026-01-01T00:00:00Z', data }) as RunEvent;

describe('mergeEvent', () => {
  it('ignores duplicates and keeps order', () => {
    let list: RunEvent[] = [];
    list = mergeEvent(list, ev(2, 'log', { level: 'info', message: 'b' }));
    list = mergeEvent(list, ev(1, 'log', { level: 'info', message: 'a' }));
    list = mergeEvent(list, ev(2, 'log', { level: 'info', message: 'b' }));
    expect(list.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('deriveRun', () => {
  it('tracks nodes, approval and failure', () => {
    const view = deriveRun([
      ev(1, 'node.started', { node: 'plan' }),
      ev(2, 'node.finished', { node: 'plan' }),
      ev(3, 'approval.requested', { approvalId: 'a1', kind: 'plan', summary: 's', payload: {} }),
    ]);
    expect(view.nodes.plan).toBe('done');
    expect(view.pendingApproval?.approvalId).toBe('a1');
    const after = deriveRun([
      ev(3, 'approval.requested', { approvalId: 'a1', kind: 'plan', summary: 's', payload: {} }),
      ev(4, 'approval.resolved', { approvalId: 'a1', decision: 'approve' }),
      ev(5, 'run.failed', { error: 'boom' }),
    ]);
    expect(after.pendingApproval).toBeUndefined();
    expect(after).toMatchObject({ finished: true, error: 'boom' });
  });
});
