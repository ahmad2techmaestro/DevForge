import { Rocket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { useCreateTask, useTasks } from '../../hooks/useApi';
import type { TaskKind } from '../../types/index';
import { TaskList } from '../../components/tasks/TaskList';
import { Button } from '../../components/ui/Button';
import { Ring } from '../../components/ui/Ring';
import { Switch } from '../../components/ui/Switch';
import { KIND_LABEL, formatNumber } from '../../utils/format';
import { toast } from '../../store/ui';
import { LanguageBar } from '../Repos';
import { useRepoContext } from './RepoLayout';

const KINDS: TaskKind[] = ['feature', 'bugfix', 'refactor', 'tests', 'review', 'explain'];
const HINT: Record<TaskKind, string> = {
  feature: 'Describe the behaviour you want. The agent plans it, you approve, then it builds and tests.',
  bugfix: 'Describe the bug and how to reproduce it.',
  refactor: 'Say what to restructure and what must stay the same.',
  tests: 'Say which module or behaviour needs test coverage.',
  review: 'Ask for a code review of the current code or a path.',
  explain: 'Ask how something works. No code is changed.',
};

export function Overview() {
  const repo = useRepoContext();
  const create = useCreateTask(repo.id);
  const navigate = useNavigate();
  const recent = useTasks({ repoId: repo.id });
  const [kind, setKind] = useState<TaskKind>('feature');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [auto, setAuto] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const task = await create.mutateAsync({ kind, title: title.trim(), description: description.trim(), autoApprove: auto });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      toast.error('Could not start task', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <form onSubmit={submit} className="panel p-5">
          <h2 className="mb-4 text-base">New task</h2>
          <div className="mb-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Task type">
            {KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`rounded-full border px-3 py-1 text-xs font-medium transition ${kind === k ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line-strong text-muted hover:text-fg'}`}>{KIND_LABEL[k]}</button>
            ))}
          </div>
          <label className="label" htmlFor="t-title">Title</label>
          <input id="t-title" className="field" required maxLength={120} placeholder="Add rate limiting to the login endpoint" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="label mt-4" htmlFor="t-desc">Details</label>
          <textarea id="t-desc" className="field min-h-[110px] resize-y" required placeholder={HINT[kind]} value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-3 text-sm text-muted">
              <Switch checked={auto} onChange={setAuto} label="Auto-approve" />
              Auto-approve plan and changes <span className="text-xs text-faint">(skips the human gate)</span>
            </label>
            <Button type="submit" variant="primary" icon={<Rocket className="h-4 w-4" />} loading={create.isPending}>Run agent</Button>
          </div>
        </form>

        <section>
          <h2 className="mb-3 text-sm">Recent tasks</h2>
          {recent.data?.pages[0]?.items.length ? <TaskList tasks={recent.data.pages[0].items.slice(0, 5)} /> : <p className="panel p-6 text-center text-sm text-muted">No tasks yet.</p>}
        </section>
      </div>

      <aside className="space-y-4">
        <div className="panel p-5">
          <h2 className="mb-3 text-sm">About</h2>
          <p className="text-sm text-muted">{repo.summary ?? 'No summary available.'}</p>
          {repo.stats && (
            <>
              <p className="mt-4 text-xs text-faint">{formatNumber(repo.stats.fileCount)} files · {formatNumber(repo.stats.totalLines)} lines</p>
              <div className="mt-3"><LanguageBar languages={repo.stats.languages} /></div>
            </>
          )}
        </div>
        {repo.health && (
          <div className="panel flex items-center gap-4 p-5">
            <Ring score={repo.health.score} grade={repo.health.grade} size={56} />
            <div>
              <p className="text-sm font-medium">Health {repo.health.score}/100</p>
              <p className="text-xs text-muted">See the Health tab for details.</p>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
