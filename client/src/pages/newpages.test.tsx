import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunVitals } from '../components/tasks/RunVitals';
import { SpecBlock } from '../components/tasks/SpecBlock';
import type { ActivityItem, RunEvent } from '../types/index';
import { describeActivity } from './Activity';
import { splitArgs } from './Mcp';

describe('splitArgs', () => {
  it('splits on spaces and keeps quoted groups', () => {
    expect(splitArgs('-y @scope/server "/my folder" \'a b\'')).toEqual(['-y', '@scope/server', '/my folder', 'a b']);
    expect(splitArgs('')).toEqual([]);
  });
});

describe('describeActivity', () => {
  const item = (type: string, data: Record<string, unknown>): ActivityItem => ({ taskId: 't', taskTitle: 'T', seq: 1, type, ts: new Date().toISOString(), data });
  it('describes edits, tests and MCP tool calls', () => {
    expect(describeActivity(item('file.changed', { path: 'a.py', additions: 3, deletions: 1 })).text).toBe('Edited a.py (+3 −1)');
    expect(describeActivity(item('tests.result', { ok: false, passed: 1, total: 4 })).text).toBe('Tests failed (1/4)');
    expect(describeActivity(item('tool.call', { name: 'mcp__gh__search', args: { query: 'bug' } })).text).toBe('mcp__gh__search bug');
    expect(describeActivity(item('mystery', {})).text).toBe('mystery');
  });
});

describe('SpecBlock', () => {
  it('renders requirements and design, and nothing when empty', () => {
    const { container, rerender } = render(<SpecBlock requirements={['WHEN x THEN y']} design="Edit app.py only" />);
    expect(screen.getByText('WHEN x THEN y')).toBeTruthy();
    expect(screen.getByText('Edit app.py only')).toBeTruthy();
    rerender(<SpecBlock />);
    expect(container.firstChild).toBeNull();
  });
});

describe('RunVitals', () => {
  it('derives tokens, tools and files from events', () => {
    const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const events = [
      { seq: 1, ts: ts(0), type: 'tool.call', data: { name: 'read_file', args: {} } },
      { seq: 2, ts: ts(2), type: 'file.changed', data: { path: 'a.py', additions: 1, deletions: 0 } },
      { seq: 3, ts: ts(3), type: 'file.changed', data: { path: 'a.py', additions: 1, deletions: 0 } },
      { seq: 4, ts: ts(5), type: 'usage', data: { inputTokens: 1000, outputTokens: 234, costUsd: 0.5 } },
    ] as unknown as RunEvent[];
    render(<RunVitals events={events} />);
    expect(screen.getByText('1.2k')).toBeTruthy();
    expect(screen.getByText('$0.500')).toBeTruthy();
    expect(screen.getByText('Files changed').nextSibling?.textContent).toBe('1');
    expect(screen.getByText('Tool calls').nextSibling?.textContent).toBe('1');
  });
});
