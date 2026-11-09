import { Brain, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../services/api/client';
import { useMemoryMutations, useMemoryNotes } from '../../hooks/useApi';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { timeAgo } from '../../utils/format';
import { toast } from '../../store/ui';
import { useRepoContext } from './RepoLayout';

const SOURCE = { manual: { label: 'You', tone: 'accent' }, feedback: { label: 'Learned from feedback', tone: 'warn' }, outcome: { label: 'Past work', tone: 'neutral' } } as const;

export function MemoryTab() {
  const repo = useRepoContext();
  const notes = useMemoryNotes(repo.id);
  const { add, remove } = useMemoryMutations(repo.id);
  const [text, setText] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await add.mutateAsync(text);
      setText('');
    } catch (err) {
      toast.error('Could not save note', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm text-muted">
        Repo memory is what the agents remember about this codebase. Your notes are treated as instructions, and DevForge also learns from the feedback you give when you reject a plan or a diff.
        Up to 30 notes are sent with every run, so keep them short.
      </p>
      <form onSubmit={submit} className="panel flex flex-wrap gap-3 p-4">
        <label className="sr-only" htmlFor="memory-text">New memory note</label>
        <input id="memory-text" className="field min-w-[16rem] flex-1" maxLength={300} placeholder="e.g. We use pytest fixtures, never unittest.TestCase" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!text.trim()} loading={add.isPending}>Remember</Button>
      </form>
      {notes.isError ? <ErrorState error={notes.error} onRetry={() => void notes.refetch()} /> : !notes.data ? <Skeleton className="h-32" /> : notes.data.length === 0 ? (
        <EmptyState icon={<Brain className="h-5 w-5" />} title="Nothing remembered yet" body="Add a convention above, or reject a plan with feedback and DevForge will remember why." />
      ) : (
        <ul className="panel divide-y divide-line">
          {notes.data.map((n) => (
            <li key={n.id} className="flex items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{n.text}</p>
                <p className="mt-1 flex items-center gap-2 text-xs text-faint"><Badge tone={SOURCE[n.source].tone}>{SOURCE[n.source].label}</Badge>{timeAgo(n.createdAt)}</p>
              </div>
              <Button variant="ghost" size="sm" aria-label="Forget this note" icon={<Trash2 className="h-4 w-4" />} loading={remove.isPending && remove.variables === n.id} onClick={() => remove.mutate(n.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
