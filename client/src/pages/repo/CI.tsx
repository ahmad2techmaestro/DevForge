import { CircleAlert, ExternalLink, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Switch } from '../../components/ui/Switch';
import { keys, useCiRuns, useMe } from '../../hooks/useApi';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { toast } from '../../store/ui';
import { timeAgo } from '../../utils/format';
import { useRepoContext } from './RepoLayout';

export function CiTab() {
  const repo = useRepoContext();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const connected = !!me.data?.github.connected;
  const runs = useCiRuns(repo.id, connected && !!repo.fullName);
  const [busy, setBusy] = useState<number | null>(null);
  const [auto, setAuto] = useState(!!repo.autoFixCi);

  if (!repo.fullName) return <EmptyState icon={<Wrench className="h-5 w-5" />} title="Not a GitHub repository" body="CI autopilot needs a repository connected from GitHub (owner/name)." />;
  if (!connected) return <EmptyState icon={<Wrench className="h-5 w-5" />} title="Connect GitHub first" body="A GitHub connection is needed to read workflow runs." action={<Link to="/settings"><Button variant="primary">Open settings</Button></Link>} />;

  const fix = async (id: number) => {
    setBusy(id);
    try {
      const r = await api.ciFix(repo.id, id);
      await qc.invalidateQueries({ queryKey: keys.ci(repo.id) });
      toast.success('Fix task created', r.summary);
      if (r.taskId) navigate(`/tasks/${r.taskId}`);
    } catch (err) {
      toast.error('Could not analyse the run', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (v: boolean) => {
    setAuto(v);
    try {
      await api.repoSettings(repo.id, { autoFixCi: v });
    } catch (err) {
      setAuto(!v);
      toast.error('Could not change the setting', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-5">
      <section className="panel flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="max-w-xl">
          <h2 className="text-base">Fix failing CI</h2>
          <p className="mt-1 text-sm text-muted">DevForge reads the logs of a failed GitHub Actions run, explains the cause and opens a bug-fix task. You still approve the plan and the changes.</p>
        </div>
        <label className="flex items-center gap-2.5 text-sm"><Switch checked={auto} onChange={(v) => void toggle(v)} label="Fix failures automatically" />Create a task when the default branch fails</label>
      </section>

      {runs.isError ? <ErrorState error={runs.error} onRetry={() => void runs.refetch()} /> : !runs.data ? <Skeleton className="h-40" /> : runs.data.length === 0 ? (
        <EmptyState icon={<CircleAlert className="h-5 w-5" />} title="No failing runs" body="Recent GitHub Actions runs on this repository have not failed." />
      ) : (
        <ul className="panel divide-y divide-line">
          {runs.data.map(({ run, handled }) => (
            <li key={run.id} className="flex flex-wrap items-center gap-3 p-4">
              <CircleAlert className="h-4 w-4 shrink-0 text-bad" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{run.name} <span className="font-mono text-xs text-faint">#{run.id}</span></p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>{run.branch} · {timeAgo(run.createdAt)}</span>
                  <a href={run.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent2 hover:underline">GitHub<ExternalLink className="h-3 w-3" aria-hidden /></a>
                </p>
                {handled && <p className="mt-1 text-xs text-muted">{handled.summary}</p>}
              </div>
              {handled ? (
                handled.taskId ? <Link to={`/tasks/${handled.taskId}`}><Button size="sm">View task</Button></Link> : <Badge tone="ok">Analysed</Badge>
              ) : (
                <Button size="sm" variant="primary" icon={<Wrench className="h-3.5 w-3.5" />} loading={busy === run.id} onClick={() => void fix(run.id)}>Analyse and fix</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
