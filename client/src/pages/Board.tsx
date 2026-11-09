import clsx from 'clsx';
import { KanbanSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, RiskBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { useRepos, useTasks } from '../hooks/useApi';
import type { Task, TaskStatus } from '../types/index';
import { KIND_LABEL, formatCost, formatTokens, timeAgo } from '../utils/format';

const COLUMNS: { id: string; title: string; hint: string; statuses: TaskStatus[]; dot: string }[] = [
  { id: 'queued', title: 'Queued', hint: 'Waiting for a free agent', statuses: ['queued'], dot: 'bg-faint' },
  { id: 'running', title: 'Agents working', hint: 'Live', statuses: ['running'], dot: 'bg-mint animate-pulse' },
  { id: 'approval', title: 'Needs you', hint: 'Approve or reject', statuses: ['awaiting_approval'], dot: 'bg-warn' },
  { id: 'done', title: 'Done', hint: 'Completed', statuses: ['completed'], dot: 'bg-ok' },
  { id: 'failed', title: 'Failed or cancelled', hint: '', statuses: ['failed', 'cancelled'], dot: 'bg-bad' },
];

function Card({ t, repo }: { t: Task; repo?: string }) {
  const live = t.status === 'running';
  return (
    <Link to={`/tasks/${t.id}`} className={clsx('panel group relative block overflow-hidden rounded-[18px] p-3.5 transition hover:-translate-y-1 hover:shadow-lift', t.status === 'awaiting_approval' && 'ring-2 ring-peach/70')}>
      {live && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 animate-sweep bg-[linear-gradient(90deg,transparent,rgb(var(--accent)),transparent)] bg-[length:200%_100%]" />}
      <div className="mb-2 flex items-center gap-2"><Badge tone="accent">{KIND_LABEL[t.kind] ?? t.kind}</Badge>{t.risk && <RiskBadge level={t.risk.level} score={t.risk.score} />}</div>
      <p className="line-clamp-2 text-sm font-medium">{t.title}</p>
      <p className="mt-2 flex items-center justify-between gap-2 text-xs text-muted"><span className="truncate">{repo ?? 'Repository'}</span><span className="shrink-0">{timeAgo(t.createdAt)}</span></p>
      <p className="mt-1 flex items-center justify-between font-mono text-[11px] text-faint"><span>{formatTokens(t.usage)} tokens</span><span>{formatCost(t.usage.costUsd)}</span></p>
    </Link>
  );
}

export function BoardPage() {
  const tasks = useTasks();
  const repos = useRepos();
  const items = tasks.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title="Board" description="Every task across your repositories, moving through the crew's pipeline in real time." />
      {tasks.isError ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /> : tasks.isLoading ? <Skeleton className="h-96" /> : items.length === 0 ? (
        <EmptyState icon={<KanbanSquare className="h-5 w-5" />} title="No tasks yet" body="Open a repository and start a task. It will appear here and move across the board as agents work." />
      ) : (
        <>
          <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-4 md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0">
            {COLUMNS.map((col) => {
              const list = items.filter((t) => col.statuses.includes(t.status));
              return (
                <section key={col.id} aria-label={col.title} className="min-w-[250px] md:min-w-0">
                  <header className="mb-3 flex items-center gap-2 px-1"><span className={clsx('h-2 w-2 rounded-full', col.dot)} aria-hidden /><h2 className="text-sm">{col.title}</h2><span className="ml-auto rounded-full bg-fg/5 px-2 py-0.5 text-xs tabular-nums text-muted">{list.length}</span></header>
                  <div className="space-y-2.5 rounded-[24px] border border-white/60 bg-white/35 p-2.5 backdrop-blur dark:border-white/5 dark:bg-white/[0.03]">
                    {list.length === 0 ? <p className="px-2 py-6 text-center text-xs text-faint">{col.hint || 'Nothing here'}</p> : list.map((t) => <Card key={t.id} t={t} repo={repos.data?.find((r) => r.id === t.repoId)?.name} />)}
                  </div>
                </section>
              );
            })}
          </div>
          {tasks.hasNextPage && <div className="flex justify-center"><Button loading={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>Load older tasks</Button></div>}
        </>
      )}
    </>
  );
}
