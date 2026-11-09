import { useQuery } from '@tanstack/react-query';
import { FlaskConical, GitPullRequestArrow, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Badge, type Tone } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { useTree } from '../../hooks/useApi';
import { api } from '../../services/api/endpoints';
import { rank } from '../../utils/fuzzy';
import { useRepoContext } from './RepoLayout';

const RISK: Record<string, Tone> = { low: 'ok', medium: 'warn', high: 'bad' };
const CODE = /\.(py|js|jsx|ts|tsx|go|java)$/;

function FileList({ title, files, tone }: { title: string; files: string[]; tone?: Tone }) {
  return (
    <section className="panel p-4">
      <h3 className="flex items-center justify-between text-sm">{title}<Badge tone={tone}>{files.length}</Badge></h3>
      {files.length === 0 ? <p className="mt-3 text-sm text-faint">None</p> : (
        <ul className="mt-3 max-h-64 space-y-1 overflow-auto font-mono text-xs">
          {files.map((f) => <li key={f} className="truncate text-muted">{f}</li>)}
        </ul>
      )}
    </section>
  );
}

export function ImpactTab() {
  const repo = useRepoContext();
  const tree = useTree(repo.id, true);
  const [path, setPath] = useState('');
  const [filter, setFilter] = useState('');
  const [symbol, setSymbol] = useState('');
  const files = useMemo(() => (tree.data ?? []).map((f) => f.path).filter((p) => CODE.test(p)), [tree.data]);
  const shown = useMemo(() => (filter ? rank(files, filter, (f) => f, 80).map((r) => r.item) : files.slice(0, 80)), [files, filter]);

  const syms = useQuery({ queryKey: ['symbols', repo.id, path], queryFn: () => api.symbols(repo.id, path), enabled: !!path, retry: false });
  const impact = useQuery({ queryKey: ['impact', repo.id, path, symbol], queryFn: () => api.impact(repo.id, path, symbol || undefined), enabled: !!path, retry: false });

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <aside className="panel flex max-h-[34rem] flex-col p-3">
        <input className="field" placeholder="Pick a file to change…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />
        <ul className="mt-3 flex-1 space-y-0.5 overflow-auto">
          {tree.isPending && <Skeleton className="h-24" />}
          {shown.map((f) => (
            <li key={f}>
              <button type="button" onClick={() => { setPath(f); setSymbol(''); }} className={clsx('w-full truncate rounded-md px-2.5 py-1.5 text-left font-mono text-xs transition', f === path ? 'bg-fg text-bg' : 'text-muted hover:bg-fg/5 hover:text-fg')}>{f}</button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="space-y-5">
        {!path ? (
          <EmptyState icon={<GitPullRequestArrow className="h-5 w-5" />} title="See what a change would touch" body="Choose a file to find every file and symbol that depends on it, which tests reach it, and how risky editing it is." />
        ) : impact.isPending ? <Skeleton className="h-48" /> : impact.isError ? <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">Could not analyse this file.</p> : (
          <>
            <section className="panel p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="truncate font-mono text-base">{impact.data.target}</h2>
                <div className="flex items-center gap-2">
                  <Badge tone={RISK[impact.data.risk] ?? 'neutral'}><ShieldAlert className="h-3 w-3" aria-hidden />{impact.data.risk} risk</Badge>
                  <Badge>engine: {impact.data.engine}</Badge>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted">{impact.data.summary}</p>
              {syms.data && syms.data.symbols.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-faint">Narrow to a symbol:</span>
                  <button type="button" onClick={() => setSymbol('')} className={clsx('rounded-full border px-2.5 py-0.5 text-xs', !symbol ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:border-fg/40')}>whole file</button>
                  {syms.data.symbols.slice(0, 24).map((s) => (
                    <button key={`${s.name}:${s.line}`} type="button" onClick={() => setSymbol(s.name)} className={clsx('rounded-full border px-2.5 py-0.5 font-mono text-xs', symbol === s.name ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:border-fg/40')}>{s.name}</button>
                  ))}
                </div>
              )}
            </section>
            <div className="grid gap-5 md:grid-cols-3">
              <FileList title="Direct dependents" files={impact.data.direct} />
              <FileList title="Indirect dependents" files={impact.data.transitive} />
              <section className="panel p-4">
                <h3 className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-1.5"><FlaskConical className="h-4 w-4" aria-hidden />Tests that reach it</span><Badge tone={impact.data.tests.length ? 'ok' : 'warn'}>{impact.data.tests.length}</Badge></h3>
                {impact.data.tests.length === 0 ? <p className="mt-3 text-sm text-warn">No test reaches this code.</p> : (
                  <ul className="mt-3 max-h-64 space-y-1 overflow-auto font-mono text-xs">{impact.data.tests.map((t) => <li key={t} className="truncate text-muted">{t}</li>)}</ul>
                )}
              </section>
            </div>
            {impact.data.symbolCallers.length > 0 && (
              <section className="panel p-4">
                <h3 className="text-sm">Callers of <span className="font-mono">{symbol}</span></h3>
                <ul className="mt-3 space-y-1 font-mono text-xs text-muted">{impact.data.symbolCallers.map((c) => <li key={`${c.path}:${c.symbol}`}>{c.path} <span className="text-faint">in</span> {c.symbol}</li>)}</ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
