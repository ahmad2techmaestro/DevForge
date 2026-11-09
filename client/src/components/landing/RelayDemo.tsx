import clsx from 'clsx';
import { Check, Hand } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CREW, type AgentId } from '../../utils/crew';

type RowId = AgentId | 'gate-plan' | 'gate-diff';
interface Step { row: RowId; text: string; detail: string; ms: number }

/** A scripted run of a real task. Same agents, gates and wording as the product. */
const SCRIPT: Step[] = [
  { row: 'planner', text: 'Reading the repository', detail: 'shop/orders.py, shop/pricing.py', ms: 1500 },
  { row: 'planner', text: 'Plan ready', detail: '3 steps, low risk', ms: 900 },
  { row: 'gate-plan', text: 'Approve the plan', detail: 'You decide before any code changes', ms: 2300 },
  { row: 'engineer', text: 'Editing', detail: 'shop/orders.py  +6 −1', ms: 1500 },
  { row: 'qa', text: 'Running tests', detail: '1 failed, 3 passed', ms: 1300 },
  { row: 'engineer', text: 'Fixing the failing test', detail: 'shop/pricing.py  +2', ms: 1200 },
  { row: 'qa', text: 'Tests passed', detail: '4 passed in the sandbox', ms: 1000 },
  { row: 'reviewer', text: 'Reviewing the diff', detail: '1 comment, low risk', ms: 1400 },
  { row: 'gate-diff', text: 'Approve the changes', detail: 'Nothing is pushed until you say so', ms: 2300 },
  { row: 'release', text: 'Draft pull request ready', detail: 'branch devforge/reject-negative-qty', ms: 3200 },
];

const ORDER: RowId[] = ['planner', 'gate-plan', 'engineer', 'qa', 'reviewer', 'gate-diff', 'release'];
const NAME = Object.fromEntries(CREW.map((a) => [a.id, a.name])) as Record<AgentId, string>;
const GATE_NAME: Record<string, string> = { 'gate-plan': 'Plan approval', 'gate-diff': 'Diff approval' };

export function RelayDemo() {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [step, setStep] = useState(reduced ? SCRIPT.length - 1 : 0);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % SCRIPT.length), SCRIPT[step]!.ms);
    return () => clearTimeout(t);
  }, [step, reduced]);

  useEffect(() => {
    setApproved(false);
    if (reduced || !SCRIPT[step]!.row.startsWith('gate')) return;
    const t = setTimeout(() => setApproved(true), 1100);
    return () => clearTimeout(t);
  }, [step, reduced]);

  const rows = useMemo(
    () =>
      ORDER.map((id) => {
        const idx = SCRIPT.map((s, i) => (s.row === id ? i : -1)).filter((i) => i >= 0);
        const first = idx[0]!;
        const last = idx[idx.length - 1]!;
        const seen = idx.filter((i) => i <= step);
        const latest = seen.length ? SCRIPT[seen[seen.length - 1]!]! : null;
        const state: 'idle' | 'active' | 'done' = step < first ? 'idle' : step > last ? 'done' : step === last && id === 'release' ? 'done' : 'active';
        return { id, state, latest };
      }),
    [step],
  );
  const doneCount = rows.filter((r) => r.state === 'done').length;

  return (
    <div role="img" aria-label="Animated example of a DevForge run: five agents hand work to each other, with two human approval gates" className="panel relative overflow-hidden rounded-hero shadow-lift">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          <p className="truncate font-display text-[15px] font-semibold">Reject orders with negative quantities</p>
          <p className="truncate text-xs text-muted">Feature task on shop-api</p>
        </div>
        <span className={clsx('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', step === SCRIPT.length - 1 ? 'bg-ok/12 text-ok' : SCRIPT[step]!.row.startsWith('gate') && !approved ? 'bg-warn/12 text-warn' : 'bg-fg/[0.06] text-muted')}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', step === SCRIPT.length - 1 ? 'bg-ok' : SCRIPT[step]!.row.startsWith('gate') && !approved ? 'bg-warn' : 'bg-faint')} />
          {step === SCRIPT.length - 1 ? 'Ready for review' : SCRIPT[step]!.row.startsWith('gate') && !approved ? 'Needs you' : 'Running'}
        </span>
      </div>

      <ol className="relative px-5 py-4">
        {rows.map(({ id, state, latest }, i) => {
          const gate = id.startsWith('gate');
          const hue = gate ? 'var(--warn)' : `var(--crew-${id})`;
          const waiting = gate && state === 'active' && !approved;
          return (
            <li key={id} className="relative flex gap-4 pb-5 last:pb-0">
              {i < rows.length - 1 && (
                <span aria-hidden className="absolute left-[15px] top-8 bottom-0 w-0.5 rounded-full bg-fg/10">
                  <span className="absolute inset-x-0 top-0 rounded-full transition-[height] duration-700 ease-out" style={{ height: state === 'done' ? '100%' : '0%', background: `rgb(${hue})` }} />
                </span>
              )}
              <span
                className={clsx('relative z-10 mt-0.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center border text-xs font-semibold transition-all duration-500', gate ? 'rotate-45 rounded-[8px]' : 'rounded-full')}
                style={{
                  borderColor: state === 'idle' ? 'rgb(var(--line) / 0.17)' : `rgb(${hue})`,
                  background: state === 'done' ? `rgb(${hue})` : state === 'active' ? `rgb(${hue} / 0.14)` : 'rgb(var(--surface))',
                  color: state === 'done' ? 'rgb(var(--surface))' : `rgb(${hue})`,
                }}
              >
                <span className={clsx(gate && '-rotate-45')}>
                  {state === 'done' ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden /> : gate ? <Hand className="h-3.5 w-3.5" aria-hidden /> : <span className={clsx('h-2 w-2 rounded-full', state === 'active' && 'animate-pulse')} style={{ background: state === 'idle' ? 'rgb(var(--faint))' : `rgb(${hue})` }} />}
                </span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className={clsx('text-sm font-medium transition-colors', state === 'idle' ? 'text-faint' : 'text-fg')}>{gate ? GATE_NAME[id] : NAME[id as AgentId]}</p>
                  {gate && state !== 'idle' && (
                    <span className={clsx('rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors', waiting ? 'bg-warn/15 text-warn' : 'bg-ok/12 text-ok')}>{waiting ? 'Waiting for you' : 'You approved'}</span>
                  )}
                </div>
                <p className={clsx('mt-0.5 min-h-[2.4rem] text-[13px] leading-5 transition-opacity', state === 'idle' ? 'opacity-0' : 'text-muted')}>
                  {latest && (
                    <>
                      <span className="text-fg/80">{latest.text}</span>
                      <span className="block font-mono text-xs text-faint">{latest.detail}</span>
                    </>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="relative h-1 bg-fg/10"><div className="relay-bg absolute inset-y-0 left-0 transition-[width] duration-700" style={{ width: `${(doneCount / ORDER.length) * 100}%` }} /></div>
    </div>
  );
}
