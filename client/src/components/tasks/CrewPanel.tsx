import clsx from 'clsx';
import { motion } from 'framer-motion';
import { ArrowRight, Bot, ClipboardCheck, FlaskConical, Hammer, Rocket, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { RunEvent, TaskStatus } from '../../types/index';
import { deriveCrew, type AgentId, type AgentState } from '../../utils/crew';

const ICON: Record<AgentId, ReactNode> = {
  planner: <ClipboardCheck className="h-4 w-4" aria-hidden />,
  engineer: <Hammer className="h-4 w-4" aria-hidden />,
  qa: <FlaskConical className="h-4 w-4" aria-hidden />,
  reviewer: <Bot className="h-4 w-4" aria-hidden />,
  release: <Rocket className="h-4 w-4" aria-hidden />,
};

const LABEL: Record<AgentState, string> = { idle: 'Idle', working: 'Working', waiting: 'Needs you', done: 'Done', failed: 'Failed' };
const RING: Record<AgentState, string> = {
  idle: 'border-line text-faint',
  working: 'border-accent/60 text-accent shadow-glow',
  waiting: 'border-warn/60 text-warn',
  done: 'border-ok/40 text-ok',
  failed: 'border-bad/50 text-bad',
};

export function CrewPanel({ events, status }: { events: RunEvent[]; status: TaskStatus }) {
  const finished = status === 'completed' || status === 'failed' || status === 'cancelled' ? status : null;
  const crew = useMemo(() => deriveCrew(events, finished), [events, finished]);
  return (
    <section className="panel overflow-hidden" aria-label="Agent crew">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-sm">Agent crew</h2>
        <span className="text-xs text-muted">{crew.focus ? `${crew.agents.find((a) => a.meta.id === crew.focus)!.meta.name} is up` : 'No agent active'}</span>
      </div>
      <ul className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-5">
        {crew.agents.map((a) => (
          <li key={a.meta.id} className="bg-surface p-4">
            <div className="flex items-center gap-3">
              <span className={clsx('relative flex h-9 w-9 items-center justify-center rounded-xl border bg-raised', RING[a.state])}>
                {ICON[a.meta.id]}
                {a.state === 'working' && <motion.span className="absolute inset-0 rounded-xl border border-accent/60" animate={{ opacity: [0.8, 0], scale: [1, 1.25] }} transition={{ repeat: Infinity, duration: 1.4 }} />}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{a.meta.name}</p>
                <p className={clsx('text-xs', a.state === 'waiting' ? 'text-warn' : a.state === 'failed' ? 'text-bad' : 'text-muted')}>{LABEL[a.state]}</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">{a.meta.role}</p>
            {a.stats.length > 0 && <p className="mt-2 flex flex-wrap gap-1.5">{a.stats.map((s) => <span key={s} className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-muted">{s}</span>)}</p>}
            {a.activity.length > 0 && (
              <ul className="mt-3 space-y-1 border-l border-line pl-3 font-mono text-[11px] leading-4 text-faint">
                {a.activity.map((line, i) => <li key={`${i}-${line}`} className="break-words">{line}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {crew.handoffs.length > 0 && (
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-4 py-3 text-xs text-muted" aria-label="Handoffs">
          {crew.handoffs.slice(-8).map((h) => (
            <li key={h.seq} className="inline-flex items-center gap-1.5">
              {h.from === 'You' && <UserRound className="h-3 w-3 text-warn" aria-hidden />}
              <span className="text-fg">{h.from}</span>
              <ArrowRight className="h-3 w-3" aria-hidden />
              <span className="text-fg">{h.to}</span>
              <span className="text-faint">({h.note})</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
