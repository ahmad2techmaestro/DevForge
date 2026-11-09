import { CircleDot, ExternalLink, Play } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { useIssues, useMe, useRunIssue } from '../../hooks/useApi';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { KIND_LABEL, timeAgo } from '../../utils/format';
import { toast } from '../../store/ui';
import { useRepoContext } from './RepoLayout';

export function IssuesTab() {
  const repo = useRepoContext();
  const me = useMe();
  const connected = !!me.data?.github.connected;
  const issues = useIssues(repo.id, connected && !!repo.fullName);
  const run = useRunIssue(repo.id);
  const navigate = useNavigate();

  const start = async (n: number) => {
    try {
      const task = await run.mutateAsync(n);
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      toast.error('Could not start task', err instanceof ApiError ? err.message : undefined);
    }
  };

  if (!repo.fullName) return <EmptyState icon={<CircleDot className="h-5 w-5" />} title="Not a GitHub repository" body="Issue autopilot needs a repository connected from GitHub (owner/name)." />;
  if (!connected) return <EmptyState icon={<CircleDot className="h-5 w-5" />} title="Connect GitHub first" body="A GitHub token is needed to read issues." action={<Link to="/settings"><Button variant="primary">Open settings</Button></Link>} />;
  if (issues.isError) return <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />;
  if (!issues.data) return <Skeleton className="h-48" />;

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">
        Pick an open issue and an agent crew works it end to end: plan, code, test, review. You still approve the plan and the changes before anything is pushed.
        To start tasks automatically, label an issue <code className="rounded bg-fg/5 px-1.5 py-0.5 font-mono text-xs text-accent2">devforge</code> once a GitHub webhook is set up (see the README).
      </p>
      {issues.data.length === 0 ? (
        <EmptyState icon={<CircleDot className="h-5 w-5" />} title="No open issues" body="This repository has no open issues." />
      ) : (
        <ul className="panel divide-y divide-line">
          {issues.data.map((i) => (
            <li key={i.number} className="flex flex-wrap items-center gap-3 p-4">
              <CircleDot className="h-4 w-4 shrink-0 text-ok" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">#{i.number} {i.title}</p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>{i.author} · {timeAgo(i.updatedAt)}</span>
                  {i.labels.slice(0, 4).map((l) => <Badge key={l}>{l}</Badge>)}
                  <a href={i.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent2 hover:underline">GitHub<ExternalLink className="h-3 w-3" aria-hidden /></a>
                </p>
              </div>
              <Badge tone="accent">{KIND_LABEL[i.kind]}</Badge>
              {i.taskId ? (
                <Link to={`/tasks/${i.taskId}`}><Button size="sm">View task</Button></Link>
              ) : (
                <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={run.isPending && run.variables === i.number} onClick={() => void start(i.number)}>Run agents</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
