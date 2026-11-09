import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { RiskLevel, Severity, TaskStatus, RepoStatus } from '../../types/index';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent';

const tones: Record<Tone, string> = {
  neutral: 'bg-fg/5 text-muted border-line',
  ok: 'bg-ok/10 text-ok border-ok/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  bad: 'bg-bad/10 text-bad border-bad/25',
  info: 'bg-info/10 text-info border-info/25',
  accent: 'bg-accent/10 text-accent border-accent/30',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium leading-4', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone, live }: { tone: Tone; live?: boolean }) {
  const color = { neutral: 'bg-faint', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', accent: 'bg-accent' }[tone];
  return (
    <span className="relative inline-flex h-1.5 w-1.5">
      {live && <span className={clsx('absolute inset-0 rounded-full animate-pulse-ring', color)} />}
      <span className={clsx('relative h-1.5 w-1.5 rounded-full', color)} />
    </span>
  );
}

const statusMeta: Record<TaskStatus, { tone: Tone; label: string; live?: boolean }> = {
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'accent', label: 'Running', live: true },
  awaiting_approval: { tone: 'warn', label: 'Needs approval', live: true },
  completed: { tone: 'ok', label: 'Completed' },
  failed: { tone: 'bad', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const m = statusMeta[status];
  return (
    <Badge tone={m.tone}>
      <Dot tone={m.tone} live={m.live} />
      {m.label}
    </Badge>
  );
}

export function RepoStatusBadge({ status }: { status: RepoStatus }) {
  const tone: Tone = status === 'ready' ? 'ok' : status === 'error' ? 'bad' : 'accent';
  const label = status === 'ready' ? 'Ready' : status === 'error' ? 'Index failed' : 'Indexing';
  return (
    <Badge tone={tone}>
      <Dot tone={tone} live={status === 'indexing'} />
      {label}
    </Badge>
  );
}

export function RiskBadge({ level, score }: { level: RiskLevel; score?: number }) {
  const tone: Tone = level === 'low' ? 'ok' : level === 'medium' ? 'warn' : 'bad';
  return (
    <Badge tone={tone}>
      {level[0].toUpperCase() + level.slice(1)} risk{score !== undefined && <span className="font-mono opacity-80">{score}</span>}
    </Badge>
  );
}

const severityTone: Record<Severity, Tone> = { info: 'neutral', low: 'info', medium: 'warn', high: 'bad', critical: 'bad' };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={severityTone[severity]}>{severity}</Badge>;
}
