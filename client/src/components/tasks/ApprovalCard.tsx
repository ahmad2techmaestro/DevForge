import { Check, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import type { Approval, PlanStep, Risk } from '../../types/index';
import { RiskBadge } from '../ui/Badge';
import { SpecBlock } from './SpecBlock';
import { Button } from '../ui/Button';

interface Props {
  approval: Approval;
  plan?: { steps: PlanStep[]; summary: string; risk: Risk; requirements?: string[]; design?: string };
  busy: boolean;
  onResolve: (decision: 'approve' | 'reject', opts: { feedback?: string; editedPlan?: PlanStep[] }) => void;
}

export function ApprovalCard({ approval, plan, busy, onResolve }: Props) {
  const isPlan = approval.kind === 'plan';
  const [feedback, setFeedback] = useState('');
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const steps = plan?.steps ?? [];
  const toggle = (id: string) => setSkipped((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const approve = () => {
    const kept = steps.filter((s) => !skipped.has(s.id));
    onResolve('approve', { feedback: feedback.trim() || undefined, editedPlan: isPlan && skipped.size > 0 ? kept : undefined });
  };

  return (
    <section aria-labelledby="approval-title" className="relative overflow-hidden rounded-xl border border-warn/40 bg-warn/[0.06] p-5 shadow-[0_0_0_1px_rgb(var(--warn)/0.1),0_8px_40px_-12px_rgb(var(--warn)/0.35)]">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldAlert className="h-5 w-5 text-warn" aria-hidden />
        <h2 id="approval-title" className="text-base">{isPlan ? 'Approve the plan' : 'Approve the changes'}</h2>
        {plan && <RiskBadge level={plan.risk.level} score={plan.risk.score} />}
      </div>
      <p className="mt-2 text-sm text-muted">{approval.summary}</p>

      {isPlan && <SpecBlock requirements={plan?.requirements} design={plan?.design} />}

      {isPlan && steps.length > 0 && (
        <ol className="mt-4 space-y-2">
          {steps.map((s, i) => (
            <li key={s.id} className={`flex gap-3 rounded-lg border border-line bg-surface/70 p-3 ${skipped.has(s.id) ? 'opacity-45' : ''}`}>
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]" checked={!skipped.has(s.id)} onChange={() => toggle(s.id)} aria-label={`Include step ${i + 1}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{i + 1}. {s.title}</p>
                <p className="text-sm text-muted">{s.detail}</p>
                {s.files.length > 0 && <p className="mt-1 flex flex-wrap gap-1.5">{s.files.map((f) => <code key={f} className="rounded bg-fg/5 px-1.5 py-0.5 text-xs text-accent2">{f}</code>)}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {plan && plan.risk.reasons.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-muted">{plan.risk.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}

      <label className="label mt-4" htmlFor="approval-feedback">{isPlan ? 'Feedback (used if you reject)' : 'Feedback for the agent (optional)'}</label>
      <textarea id="approval-feedback" className="field min-h-[64px] resize-y" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Tell the agent what to change" />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="danger" icon={<X className="h-4 w-4" />} disabled={busy} onClick={() => onResolve('reject', { feedback: feedback.trim() || undefined })}>Reject</Button>
        <Button variant="primary" icon={<Check className="h-4 w-4" />} loading={busy} disabled={isPlan && steps.length > 0 && skipped.size === steps.length} onClick={approve}>
          {skipped.size > 0 ? `Approve ${steps.length - skipped.size} of ${steps.length} steps` : 'Approve'}
        </Button>
      </div>
    </section>
  );
}
