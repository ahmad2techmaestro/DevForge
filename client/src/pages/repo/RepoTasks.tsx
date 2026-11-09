import { ListChecks } from 'lucide-react';
import { useTasks } from '../../hooks/useApi';
import { TaskList } from '../../components/tasks/TaskList';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { useRepoContext } from './RepoLayout';

export function RepoTasks() {
  const repo = useRepoContext();
  const tasks = useTasks({ repoId: repo.id });
  const items = tasks.data?.pages.flatMap((p) => p.items) ?? [];
  if (tasks.isError) return <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />;
  if (tasks.isLoading) return <Skeleton className="h-48" />;
  if (items.length === 0) return <EmptyState icon={<ListChecks className="h-5 w-5" />} title="No tasks for this repository" body="Start one from the Overview tab." />;
  return (
    <>
      <TaskList tasks={items} />
      {tasks.hasNextPage && <div className="mt-4 flex justify-center"><Button loading={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>Load more</Button></div>}
    </>
  );
}
