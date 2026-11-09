import { Activity, Bug, GitPullRequest, Search, Waypoints, Wrench, CircleDot, FileCode2, GitBranch, Brain, ShieldAlert, LayoutDashboard, ListChecks, MessageSquare, Network, RefreshCw, Trash2 } from 'lucide-react';
import { Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useState } from 'react';
import { ApiError } from '../../services/api/client';
import { useDeleteRepo, useReindexRepo, useRepo } from '../../hooks/useApi';
import type { Repo } from '../../types/index';
import { Button } from '../../components/ui/Button';
import { RepoStatusBadge } from '../../components/ui/Badge';
import { ErrorState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { Skeleton } from '../../components/ui/Skeleton';
import { RouteTabs } from '../../components/ui/Tabs';
import { toast } from '../../store/ui';

export function useRepoContext(): Repo {
  return useOutletContext<{ repo: Repo }>().repo;
}

export function RepoLayout() {
  const { repoId = '' } = useParams();
  const repo = useRepo(repoId);
  const reindex = useReindexRepo();
  const del = useDeleteRepo();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);

  if (repo.isError) return <ErrorState error={repo.error} onRetry={() => void repo.refetch()} />;
  if (!repo.data) return <Skeleton className="h-40" />;
  const r = repo.data;
  const base = `/repos/${r.id}`;

  const remove = async () => {
    try {
      await del.mutateAsync(r.id);
      toast.success('Repository removed', r.name);
      navigate('/repos', { replace: true });
    } catch (err) {
      toast.error('Could not remove repository', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl">{r.fullName ?? r.name}</h1>
            <RepoStatusBadge status={r.status} />
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
            <GitBranch className="h-3.5 w-3.5" aria-hidden />
            {r.branch}
            {r.commit && <span className="font-mono text-faint">· {r.commit.slice(0, 7)}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={<RefreshCw className="h-4 w-4" />} loading={reindex.isPending || r.status === 'indexing'} onClick={() => reindex.mutate(r.id)}>
            Re-index
          </Button>
          <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm(true)} aria-label="Remove repository" />
        </div>
      </div>

      {r.status === 'error' && <p role="alert" className="mb-4 rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">Indexing failed: {r.error}</p>}

      <RouteTabs
        id="repo-tabs"
        tabs={[
          { to: base, label: 'Overview', icon: <LayoutDashboard className="h-4 w-4" />, end: true },
          { to: `${base}/files`, label: 'Files', icon: <FileCode2 className="h-4 w-4" /> },
          { to: `${base}/chat`, label: 'Ask', icon: <MessageSquare className="h-4 w-4" /> },
          { to: `${base}/search`, label: 'Search', icon: <Search className="h-4 w-4" /> },
          { to: `${base}/impact`, label: 'Impact', icon: <Waypoints className="h-4 w-4" /> },
          { to: `${base}/graph`, label: 'Graph', icon: <Network className="h-4 w-4" /> },
          { to: `${base}/health`, label: 'Health', icon: <Activity className="h-4 w-4" /> },
          { to: `${base}/bugs`, label: 'Bugs', icon: <Bug className="h-4 w-4" /> },
          { to: `${base}/security`, label: 'Security', icon: <ShieldAlert className="h-4 w-4" /> },
          { to: `${base}/issues`, label: 'Issues', icon: <CircleDot className="h-4 w-4" /> },
          { to: `${base}/reviews`, label: 'Reviews', icon: <GitPullRequest className="h-4 w-4" /> },
          { to: `${base}/ci`, label: 'CI', icon: <Wrench className="h-4 w-4" /> },
          { to: `${base}/memory`, label: 'Memory', icon: <Brain className="h-4 w-4" /> },
          { to: `${base}/tasks`, label: 'Tasks', icon: <ListChecks className="h-4 w-4" /> },
        ]}
      />
      <div className="pt-6">
        {r.status === 'indexing' ? (
          <div className="panel flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-lg">Indexing your codebase…</p>
            <p className="text-sm text-muted">Cloning, scanning files and building the import graph.</p>
            <Skeleton className="mt-4 h-2 w-64" />
          </div>
        ) : (
          <Outlet context={{ repo: r }} />
        )}
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Remove repository?" description="This deletes the local clone and its tasks. Your GitHub repository is not touched.">
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" loading={del.isPending} onClick={() => void remove()}>Remove</Button>
        </div>
      </Modal>
    </>
  );
}
