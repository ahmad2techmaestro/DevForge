import { useMutation } from '@tanstack/react-query';
import { FileCode2, Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { useFile, useTree } from '../../hooks/useApi';
import { CodeViewer } from '../../components/code/CodeViewer';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { rank } from '../../utils/fuzzy';
import { basename, formatNumber } from '../../utils/format';
import { useRepoContext } from './RepoLayout';

export function FilesTab() {
  const repo = useRepoContext();
  const tree = useTree(repo.id);
  const [params, setParams] = useSearchParams();
  const path = params.get('path');
  const line = Number(params.get('line')) || null;
  const [query, setQuery] = useState('');
  const file = useFile(repo.id, path);
  const explain = useMutation({ mutationFn: (p: string) => api.explain(repo.id, p) });
  const search = useMutation({ mutationFn: (q: string) => api.search(repo.id, q) });

  const files = tree.data ?? [];
  const shown = useMemo(() => (query ? rank(files, query, (f) => f.path, 200).map((r) => r.item) : files.slice(0, 300)), [files, query]);

  const open = (p: string, l?: number) => {
    const next: Record<string, string> = { path: p };
    if (l) next.line = String(l);
    setParams(next);
    explain.reset();
  };

  if (tree.isError) return <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <aside className="panel flex max-h-[70vh] flex-col overflow-hidden">
        <form
          className="relative border-b border-line p-2"
          onSubmit={(e) => { e.preventDefault(); if (query.trim()) search.mutate(query.trim()); }}
        >
          <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input className="field pl-9" aria-label="Filter files or press Enter to search code" placeholder="Filter files · Enter searches code" value={query} onChange={(e) => setQuery(e.target.value)} />
        </form>
        <div className="flex-1 overflow-y-auto p-1">
          {tree.isLoading && <Skeleton className="m-2 h-40" />}
          {search.data && (
            <div className="mb-2 border-b border-line pb-2">
              <p className="px-2 py-1 text-xs text-muted">Code matches ({search.data.results.length})</p>
              {search.data.results.map((r, i) => (
                <button key={i} onClick={() => open(r.path, r.line)} className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-fg/5">
                  <span className="block truncate font-mono text-xs text-accent2">{r.path}:{r.line}</span>
                  <span className="block truncate font-mono text-xs text-muted">{r.snippet.trim()}</span>
                </button>
              ))}
            </div>
          )}
          <ul>
            {shown.map((f) => (
              <li key={f.path}>
                <button onClick={() => open(f.path)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-fg/5 ${f.path === path ? 'bg-accent/10 text-fg' : 'text-muted'}`} title={f.path}>
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{basename(f.path)}<span className="ml-2 text-xs text-faint">{f.path.slice(0, f.path.length - basename(f.path).length)}</span></span>
                  <span className="text-xs text-faint">{formatNumber(f.lines)}</span>
                </button>
              </li>
            ))}
          </ul>
          {files.length > shown.length && !query && <p className="p-2 text-center text-xs text-faint">Showing first {shown.length} of {files.length}. Filter to narrow.</p>}
        </div>
      </aside>

      <section className="min-w-0 space-y-4">
        {!path ? (
          <EmptyState icon={<FileCode2 className="h-5 w-5" />} title="Pick a file" body="Browse the tree, or filter by name. Press Enter in the box to search the code itself." />
        ) : file.isError ? (
          <ErrorState error={file.error} onRetry={() => void file.refetch()} />
        ) : (
          <>
            <div className="panel overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
                <p className="truncate font-mono text-sm">{path}</p>
                <Button size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} loading={explain.isPending} onClick={() => explain.mutate(path)}>Explain this file</Button>
              </div>
              <div className="max-h-[55vh] overflow-auto bg-surface">
                {file.data ? <CodeViewer code={file.data.content} path={file.data.path} language={file.data.language} highlightLine={line} /> : <Skeleton className="m-4 h-48" />}
              </div>
              {file.data?.truncated && <p className="border-t border-line px-4 py-2 text-xs text-warn">File truncated for display.</p>}
            </div>
            {explain.isError && <p role="alert" className="text-sm text-bad">{explain.error instanceof ApiError ? explain.error.message : 'Explain failed'}</p>}
            {explain.data && (
              <div className="panel p-5">
                <h3 className="mb-2 flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4 text-accent2" aria-hidden />Explanation</h3>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{explain.data.explanation}</p>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
