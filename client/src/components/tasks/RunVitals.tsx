import { Coins, FileDiff, Gauge, Timer, Wrench } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { RunEvent } from '../../types/index';
import { formatCost, formatDuration, formatNumber } from '../../utils/format';

function Vital({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="min-w-0"><p className="flex items-center gap-1.5 text-xs text-muted"><span className="text-accent2">{icon}</span>{label}</p><p className="mt-0.5 truncate text-lg font-semibold tabular-nums">{value}</p></div>;
}

/** Live numbers for a run, all derived from its events: tokens over time, tool calls, files, elapsed time. */
export function RunVitals({ events, maxTokens }: { events: RunEvent[]; maxTokens?: number }) {
  const v = useMemo(() => {
    const series: number[] = [];
    let cost = 0, tools = 0, files = new Set<string>();
    for (const e of events) {
      if (e.type === 'usage') { series.push(e.data.inputTokens + e.data.outputTokens); cost = e.data.costUsd; }
      else if (e.type === 'tool.call') tools += 1;
      else if (e.type === 'file.changed') files = new Set(files).add(e.data.path);
    }
    const first = events[0] ? Date.parse(events[0].ts) : 0;
    const last = events.length ? Date.parse(events[events.length - 1].ts) : 0;
    return { series, cost, tools, files: files.size, ms: Math.max(0, last - first) };
  }, [events]);

  const tokens = v.series.at(-1) ?? 0;
  const max = Math.max(...v.series, 1);
  const W = 160, H = 36;
  const path = v.series.length > 1 ? v.series.map((n, i) => `${i === 0 ? 'M' : 'L'}${(i / (v.series.length - 1)) * W},${H - (n / max) * (H - 4) - 2}`).join(' ') : '';
  const pct = maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : null;

  return (
    <section aria-label="Run vitals" className="panel grid grid-cols-2 items-center gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
      <Vital icon={<Gauge className="h-3.5 w-3.5" />} label="Tokens used" value={formatNumber(tokens)} />
      <Vital icon={<Coins className="h-3.5 w-3.5" />} label="Cost" value={formatCost(v.cost)} />
      <Vital icon={<Wrench className="h-3.5 w-3.5" />} label="Tool calls" value={String(v.tools)} />
      <Vital icon={<FileDiff className="h-3.5 w-3.5" />} label="Files changed" value={String(v.files)} />
      <Vital icon={<Timer className="h-3.5 w-3.5" />} label="Elapsed" value={formatDuration(v.ms)} />
      <div className="col-span-2 sm:col-span-1">
        {path ? <svg viewBox={`0 0 ${W} ${H}`} className="h-9 w-full" role="img" aria-label="Tokens over time"><path d={path} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg> : <p className="text-xs text-faint">Waiting for usage…</p>}
        {pct !== null && <div className="mt-1 h-1 overflow-hidden rounded-full bg-fg/10" aria-label={`${Math.round(pct)}% of the token budget`}><div className={pct > 85 ? 'h-full bg-warn' : 'h-full bg-accent'} style={{ width: `${pct}%` }} /></div>}
      </div>
    </section>
  );
}
