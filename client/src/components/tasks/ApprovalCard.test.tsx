import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard';

const plan = {
  summary: 'sum',
  risk: { score: 10, level: 'low' as const, reasons: [] },
  steps: [
    { id: 's1', title: 'One', detail: 'd1', files: ['a.ts'] },
    { id: 's2', title: 'Two', detail: 'd2', files: [] },
  ],
};
const approval = { approvalId: 'a1', kind: 'plan' as const, summary: 'Review', payload: {} };

describe('ApprovalCard', () => {
  it('approves with an edited plan when a step is unchecked', async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={approval} plan={plan} busy={false} onResolve={onResolve} />);
    await userEvent.click(screen.getByLabelText('Include step 2'));
    await userEvent.click(screen.getByRole('button', { name: /approve 1 of 2/i }));
    expect(onResolve).toHaveBeenCalledWith('approve', { feedback: undefined, editedPlan: [plan.steps[0]] });
  });
  it('rejects with feedback', async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={approval} plan={plan} busy={false} onResolve={onResolve} />);
    await userEvent.type(screen.getByLabelText(/feedback/i), 'too broad');
    await userEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(onResolve).toHaveBeenCalledWith('reject', { feedback: 'too broad' });
  });
});
