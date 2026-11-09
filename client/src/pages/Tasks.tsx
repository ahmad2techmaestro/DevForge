import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useRepos, useTasks } from '../hooks/useApi';
import type { TaskStatus } from '../types/index';
import { TaskList } from '../components/tasks/TaskList';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';

const FILTERS: { value: TaskStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'awaiting_approval', label: 'Needs you' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

export function AllTasks() {
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const tasks = useTasks(filter === 'all' ? {} : { status: filter });
  const repos = useRepos();
  const items = tasks.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title="Tasks" description="Every agent run across your repositories." />
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)} className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${filter === f.value ? 'border-transparent bg-fg text-bg shadow-panel' : 'border-white/70 bg-surface/60 text-muted hover:text-fg dark:border-white/10'}`}>{f.label}</button>
        ))}
      </div>
      {tasks.isError ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /> : tasks.isLoading ? <Skeleton className="h-64" /> : items.length === 0 ? (
        <EmptyState icon={<ListChecks className="h-5 w-5" />} title="Nothing here" body={filter === 'all' ? 'Open a repository and start a task to see it here.' : 'No tasks with this status.'} />
      ) : (
        <>
          <TaskList tasks={items} repoName={(id) => repos.data?.find((r) => r.id === id)?.name} />
          {tasks.hasNextPage && <div className="mt-4 flex justify-center"><Button loading={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>Load more</Button></div>}
        </>
      )}
    </>
  );
}