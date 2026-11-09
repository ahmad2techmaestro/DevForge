import { useHealth } from '../../hooks/useApi';
import { ErrorState } from '../../components/ui/EmptyState';
import { Ring } from '../../components/ui/Ring';
import { SeverityBadge } from '../../components/ui/Badge';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatNumber } from '../../utils/format';
import { useRepoContext } from './RepoLayout';
import { Link } from 'react-router-dom';

export function HealthTab() {
  const repo = useRepoContext();
  const health = useHealth(repo.id);
  if (health.isError) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  if (!health.data) return <Skeleton className="h-64" />;
  const h = health.data;
  const m = h.metrics;
  const tiles: [string, string][] = [
    ['Files', formatNumber(m.files)],
    ['Lines', formatNumber(m.lines)],
    ['Test files', `${m.testFiles} (${Math.round(m.testRatio * 100)}%)`],
    ['TODO / FIXME', String(m.todoCount)],
    ['Avg file size', `${Math.round(m.avgFileLines)} lines`],
    ['Large files', String(m.largeFiles)],
    ['Long functions', String(m.longFunctions)],
    ['Secrets found', String(m.secretsFound)],
  ];
  return (
    <div className="space-y-6">
      <div className="panel flex flex-wrap items-center gap-6 p-5">
        <Ring score={h.score} grade={h.grade} size={84} stroke={7} />
        <div>
          <p className="text-3xl font-semibold tabular-nums">{h.score}<span className="text-lg text-muted"> / 100</span></p>
          <p className="text-sm text-muted">Heuristic health score. Based on tests, file size, TODOs and leaked secrets.</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([k, v]) => (
          <div key={k} className="panel p-4">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <section>
        <h2 className="mb-3 text-sm">Findings ({h.findings.length})</h2>
        {h.findings.length === 0 ? <p className="panel p-6 text-center text-sm text-muted">No issues found.</p> : (
          <ul className="panel divide-y divide-line">
            {h.findings.map((f, i) => (
              <li key={i} className="flex flex-wrap items-start gap-3 p-4">
                <SeverityBadge severity={f.severity} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{f.title}</p>
                  <p className="text-sm text-muted">{f.detail}</p>
                  <Link to={`/repos/${repo.id}/files?path=${encodeURIComponent(f.path)}&line=${f.line}`} className="font-mono text-xs text-accent2 hover:underline">{f.path}:{f.line}</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
