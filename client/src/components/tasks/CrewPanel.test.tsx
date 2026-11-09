import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../types/index';
import { CrewPanel } from './CrewPanel';

const ev = (seq: number, type: string, data: unknown): RunEvent => ({ seq, type, ts: '2026-01-01T00:00:00Z', data }) as RunEvent;

describe('CrewPanel', () => {
  it('shows all five agents and highlights who needs the human', () => {
    render(<CrewPanel status="awaiting_approval" events={[ev(1, 'node.started', { node: 'plan' }), ev(2, 'approval.requested', { approvalId: 'a', kind: 'plan', summary: '', payload: {} })]} />);
    for (const n of ['Planner', 'Engineer', 'QA', 'Reviewer', 'Release']) expect(screen.getAllByText(n).length).toBeGreaterThan(0);
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.getByText(/Planner is up/)).toBeInTheDocument();
    expect(screen.getByLabelText('Handoffs')).toHaveTextContent('Planner');
  });
});
