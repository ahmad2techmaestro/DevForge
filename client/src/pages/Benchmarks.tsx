import { FlaskConical, Play } from 'lucide-react';
import clsx from 'clsx';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBenchStatus, useBenchmark, useMe, useRunBenchmark } from '../hooks/useApi';
import { ApiError } from '../services/api/client';
import { toast } from '../store/ui';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { formatCost } from '../utils/format';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}

function RunControls() {
  const me = useMe();
  const status = useBenchStatus();
  const run = useRunBenchmark();
  const qc = useQueryClient();
  const st = status.data;
  const running = st?.status === 'running';
  const agent = me.data?.agent;
  const hasModel = !!agent && agent.provider !== 'mock' && agent.reachable;
  const was = useRef(st?.status);

  // When a run finishes, load the new result.
  useEffect(() => {
    if (was.current === 'running' && st?.status && st.status !== 'running') {
      void qc.invalidateQueries({ queryKey: ['benchmark'] });
      if (st.status === 'done') toast.success('Benchmark finished', 'The new result is shown below.');
    }
    was.current = st?.status;
  }, [st?.status, qc]);

  const start = (limit?: number) =>
    run.mutate(limit, { onError: (err) => toast.error('Could not start the benchmark', err instanceof ApiError ? err.message : undefined) });

  if (running) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    return (
      <div className="panel mb-6 p-4" role="status" aria-live="polite">
        <div className="flex items-center justify-between text-sm"><span className="font-medium">Running {st.done} of {st.total} tasks</span><span className="tabular-nums text-muted">{pct}%</span></div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-fg/10"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(pct, 4)}%` }} /></div>
        <p className="mt-2 truncate font-mono text-xs text-muted">{st.current ? `Working on ${st.current}` : 'Starting…'}</p>
      </div>
    );
  }
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <Button variant="primary" icon={<Play className="h-4 w-4" />} disabled={!hasModel} loading={run.isPending} onClick={() => start(3)}>Quick run (3 tasks)</Button>
      <Button disabled={!hasModel} onClick={() => start()}>Full run (14 tasks)</Button>
      <p className="text-xs text-muted">
        {hasModel ? `Uses ${agent.model} and a few thousand tokens per task from your API quota.` : 'Add a provider and API key in .env first. The offline demo model cannot solve tasks.'}
      </p>
      {st?.status === 'error' && <p role="alert" className="w-full whitespace-pre-wrap rounded-xl bg-bad/10 px-3 py-2 font-mono text-xs text-bad">Last run failed: {st.error}</p>}
    </div>
  );
}

export function BenchmarksPage() {
  const bench = useBenchmark();
  const me = useMe();
  const d = bench.data;
  const current = me.data?.agent;
  const stale = !!d?.meta && !!current && d.meta.provider !== 'mock' && current.provider !== 'mock' && (d.meta.provider !== current.provider || d.meta.model !== current.model);
  return (
    <>
      <PageHeader title="Benchmarks" description="DevForge-Bench: 14 small coding tasks checked by hidden tests. Pass@1 is the share solved on the first attempt." />
      <RunControls />
      {bench.isError ? <ErrorState error={bench.error} onRetry={() => void bench.refetch()} /> : bench.isLoading ? <Skeleton className="h-64" /> : !d?.available || !d.summary ? (
        <EmptyState icon={<FlaskConical className="h-5 w-5" />} title="No benchmark run yet" body="Start a quick run above. DevForge solves the tasks with your configured model and checks each fix against hidden tests." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Pass@1" value={`${Math.round(d.summary.pass_at_1 * 100)}%`} hint={`${d.summary.solved} of ${d.summary.ran} solved`} />
            <Stat label="Cost" value={formatCost(d.summary.cost_usd)} hint={`${(d.summary.input_tokens + d.summary.output_tokens).toLocaleString()} tokens`} />
            <Stat label="Mean time" value={`${d.summary.seconds_mean.toFixed(1)}s`} hint={`${d.summary.seconds_total.toFixed(0)}s total`} />
            <Stat label="Model" value={d.meta?.model ?? '—'} hint={d.meta ? `${d.meta.provider} · ${d.meta.sandbox}` : undefined} />
          </div>
          {d.meta?.provider === 'mock' && (
            <p role="note" className="panel border-warn/40 p-3 text-sm text-warn">This result was recorded with the offline demo model, which cannot solve tasks. Run the benchmark above to replace it with a score from {current && current.provider !== 'mock' ? current.model : 'a real model'}.</p>
          )}
          {stale && (
            <p role="note" className="panel p-3 text-sm text-muted">This result is from {d?.meta?.model} ({d?.meta?.provider}). Your agents now use {current?.model}. Run the benchmark again to compare.</p>
          )}
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="px-4 py-2.5 font-medium">Task</th><th className="px-4 py-2.5 font-medium">Language</th><th className="px-4 py-2.5 font-medium">Result</th><th className="px-4 py-2.5 font-medium">Time</th><th className="px-4 py-2.5 font-medium">Cost</th></tr></thead>
              <tbody className="divide-y divide-line">
                {(d.tasks ?? []).map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-2.5 font-mono text-xs">{t.id}</td>
                    <td className="px-4 py-2.5 text-muted">{t.language}</td>
                    <td className={clsx('px-4 py-2.5', t.verified ? 'text-ok' : 'text-bad')}>{t.verified ? 'Solved' : t.status === 'skipped' ? 'Skipped' : 'Not solved'}</td>
                    <td className="px-4 py-2.5 tabular-nums text-muted">{t.seconds.toFixed(1)}s</td>
                    <td className="px-4 py-2.5 tabular-nums text-muted">{formatCost(t.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.meta?.note && <p className="text-xs text-faint">{d.meta.note}</p>}
        </div>
      )}
    </>
  );
}
