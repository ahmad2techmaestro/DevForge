import { useMutation } from '@tanstack/react-query';
import { Code2, Search as SearchIcon, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SegmentedControl } from '../../components/ui/Tabs';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { toast } from '../../store/ui';
import { useRepoContext } from './RepoLayout';
import { Link } from 'react-router-dom';

const MODES = [
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'semantic', label: 'Meaning' },
  { value: 'bm25', label: 'Keywords' },
];

export function SearchTab() {
  const repo = useRepoContext();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [mode, setMode] = useState('hybrid');
  const [rerank, setRerank] = useState(false);
  const search = useMutation({ mutationFn: () => api.semanticSearch(repo.id, q.trim(), mode, rerank), onError: (e) => toast.error('Search failed', e instanceof ApiError ? e.message : undefined) });

  const auto = useRef(false);
  useEffect(() => {
    if (!auto.current && params.get('q')?.trim()) {
      auto.current = true;
      search.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) search.mutate();
  };

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="panel flex flex-wrap items-center gap-3 p-3">
        <div className="relative min-w-[16rem] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input className="field pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask in your own words: where do we verify the user's password?" aria-label="Search the codebase" />
        </div>
        <SegmentedControl value={mode} onChange={setMode} options={MODES} label="Search mode" />
        <label className="flex items-center gap-2 text-sm text-muted" title="A second pass re-orders the top hits by how well they answer your question"><input type="checkbox" className="accent-[rgb(var(--accent))]" checked={rerank} onChange={(e) => setRerank(e.target.checked)} />Rerank</label>
        <Button type="submit" variant="primary" loading={search.isPending} icon={<Sparkles className="h-4 w-4" />}>Search</Button>
      </form>

      {!search.data && !search.isPending && (
        <EmptyState icon={<Code2 className="h-5 w-5" />} title="Search by meaning, not just keywords" body="Hybrid search combines keyword matching with code embeddings, so a question finds the function that does the job even when the words differ." />
      )}

      {search.data && (
        <>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {search.data.results.length} result{search.data.results.length === 1 ? '' : 's'}
            <Badge tone="info">{search.data.mode}</Badge>
            <Badge>embeddings: {search.data.embedder}</Badge>
            {search.data.reranker && <Badge tone="accent">reranked: {search.data.reranker}</Badge>}
          </p>
          <ul className="space-y-3">
            {search.data.results.map((r, i) => (
              <li key={`${r.path}:${r.line}:${i}`} className="panel overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                  <Link to={`/repos/${repo.id}/files?path=${encodeURIComponent(r.path)}`} className="min-w-0 truncate font-mono text-sm font-medium hover:underline">
                    {r.path}<span className="text-faint">:{r.line}{r.endLine ? `-${r.endLine}` : ''}</span>
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    {r.symbol && <Badge tone="accent">{r.symbol}</Badge>}
                    <span className={clsx('font-mono text-xs', r.score > 0.5 ? 'text-ok' : 'text-faint')}>{r.score.toFixed(3)}</span>
                  </div>
                </div>
                <pre className="max-h-44 overflow-auto bg-raised/50 px-4 py-3 font-mono text-xs leading-5 text-muted">{r.snippet}</pre>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
