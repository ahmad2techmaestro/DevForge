import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { CornerDownLeft, FolderGit2, ListChecks, Plus, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRepos, useTasks } from '../../hooks/useApi';
import { Link } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { toast } from '../../store/ui';
import type { ChatMessage } from '../../types/index';
import { TypeText } from './TypeText';
import { searchPalette, type PaletteGroup, type PaletteItem } from '../../utils/palette';
import { useAuth } from '../../store/auth';
import { useUi } from '../../store/ui';

export function CommandPalette() {
  const { paletteOpen, setPalette, setConnect, toggleTheme } = useUi();
  const navigate = useNavigate();
  const clear = useAuth((s) => s.clear);
  const repos = useRepos();
  const tasks = useTasks();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [ai, setAi] = useState<{ repoId: string; repoName: string; question: string; loading: boolean; answer?: ChatMessage; error?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setPalette(false);
    setQuery('');
    setIndex(0);
    setAi(null);
  };

  const ask = async (repoId: string, repoName: string, question: string) => {
    setAi({ repoId, repoName, question, loading: true });
    try {
      const thread = await api.chat(repoId, question);
      const answer = [...thread.messages].reverse().find((m) => m.role === 'assistant');
      setAi({ repoId, repoName, question, loading: false, answer });
    } catch (err) {
      setAi({ repoId, repoName, question, loading: false, error: err instanceof ApiError ? err.message : 'The agent service did not answer.' });
    }
  };

  const items = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => () => {
      close();
      navigate(to);
    };
    const list: PaletteItem[] = [
      { id: 'a-connect', group: 'Actions', label: 'Connect repository', hint: 'Index a GitHub repo', keywords: 'add new clone', run: () => { close(); setConnect(true); } },
      { id: 'a-theme', group: 'Actions', label: 'Toggle theme', hint: 'Dark / light', keywords: 'appearance', run: () => { close(); toggleTheme(); } },
      { id: 'a-out', group: 'Actions', label: 'Sign out', run: () => { close(); clear(); navigate('/login'); } },
      { id: 'p-dash', group: 'Pages', label: 'Dashboard', hint: 'g d', run: go('/') },
      { id: 'p-repos', group: 'Pages', label: 'Repositories', hint: 'g r', run: go('/repos') },
      { id: 'p-tasks', group: 'Pages', label: 'Tasks', hint: 'g t', run: go('/tasks') },
      { id: 'p-audit', group: 'Pages', label: 'Audit log', hint: 'g a', run: go('/audit') },
      { id: 'p-settings', group: 'Pages', label: 'Settings', hint: 'g s', keywords: 'github token provider', run: go('/settings') },
    ];
    for (const r of repos.data ?? []) {
      list.push({ id: `r-${r.id}`, group: 'Repositories', label: r.fullName ?? r.name, hint: r.status, run: go(`/repos/${r.id}`) });
    }
    for (const t of tasks.data?.pages.flatMap((p) => p.items).slice(0, 15) ?? []) {
      list.push({ id: `t-${t.id}`, group: 'Tasks', label: t.title, hint: t.status.replace('_', ' '), keywords: t.kind, run: go(`/tasks/${t.id}`) });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.data, tasks.data, navigate]);

  const results = useMemo(() => {
    const base = searchPalette(items, query);
    const q = query.trim();
    if (q.length < 3) return base;
    const ready = (repos.data ?? []).filter((r) => r.status === 'ready').slice(0, 3);
    const dyn: PaletteItem[] = ready.flatMap((r) => [
      { id: `ai-ask-${r.id}`, group: 'Ask AI' as const, label: `Ask ${r.name}: ${q}`, hint: 'answer with citations', run: () => void ask(r.id, r.name, q) },
      { id: `ai-find-${r.id}`, group: 'Ask AI' as const, label: `Search ${r.name} by meaning`, hint: q.slice(0, 24), run: () => { close(); navigate(`/repos/${r.id}/search?q=${encodeURIComponent(q)}`); } },
      { id: `ai-task-${r.id}`, group: 'Ask AI' as const, label: `Start a task in ${r.name}`, hint: 'you approve the plan', run: () => void startTask(r.id, q) },
    ]);
    return [...dyn.map((item) => ({ item, match: { score: 0, indices: [] } })), ...base];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, repos.data]);

  const startTask = async (repoId: string, text: string) => {
    try {
      const t = await api.createTask(repoId, { kind: 'feature', title: text.slice(0, 120), description: text });
      close();
      navigate(`/tasks/${t.id}`);
    } catch (err) {
      toast.error('Could not start the task', err instanceof ApiError ? err.message : undefined);
    }
  };

  useEffect(() => {
    if (paletteOpen) setTimeout(() => inputRef.current?.focus(), 30);
  }, [paletteOpen]);
  useEffect(() => setIndex(0), [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[index]?.item.run();
    }
  };

  const icon = (g: PaletteGroup) => (g === 'Repositories' ? <FolderGit2 className="h-4 w-4" /> : g === 'Tasks' ? <ListChecks className="h-4 w-4" /> : g === 'Ask AI' ? <Sparkles className="h-4 w-4" /> : g === 'Actions' ? <Plus className="h-4 w-4" /> : <Search className="h-4 w-4" />);

  return (
    <AnimatePresence>
      {paletteOpen && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={close} />
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line-strong bg-overlay shadow-pop"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="h-4 w-4 text-faint" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Type a command or search…"
                aria-label="Search commands"
                className="h-12 w-full bg-transparent text-base text-fg placeholder:text-faint focus:outline-none"
              />
              <span className="kbd">esc</span>
            </div>
            {ai && (
              <div className="max-h-[50vh] overflow-y-auto border-b border-line p-4" aria-live="polite">
                <p className="mb-2 flex items-center gap-2 text-xs text-muted"><Sparkles className="h-3.5 w-3.5 text-accent2" aria-hidden />{ai.repoName} · {ai.question}</p>
                {ai.loading ? <p className="flex items-center gap-2 text-sm text-muted"><span className="h-2 w-2 animate-ping rounded-full bg-accent" aria-hidden />Reading the code…</p>
                  : ai.error ? <p role="alert" className="text-sm text-bad">{ai.error}</p>
                  : <div className="text-sm leading-6"><TypeText text={ai.answer?.content ?? 'No answer.'} />
                    {!!ai.answer?.citations?.length && <ul className="mt-3 flex flex-wrap gap-1.5">{ai.answer.citations.slice(0, 8).map((c, i) => <li key={i}><Link onClick={close} to={`/repos/${ai.repoId}/files?path=${encodeURIComponent(c.path)}&line=${c.line}`} className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-accent2 hover:border-accent/50">{c.path}:{c.line}</Link></li>)}</ul>}</div>}
              </div>
            )}
            <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
              {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No matches for “{query}”</li>}
              {results.map(({ item }, i) => (
                <li key={item.id} role="option" aria-selected={i === index}>
                  {(i === 0 || results[i - 1]?.item.group !== item.group) && <p className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-faint">{item.group}</p>}
                  <button
                    type="button"
                    onMouseMove={() => setIndex(i)}
                    onClick={item.run}
                    className={clsx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm', i === index ? 'bg-accent/15 text-fg' : 'text-muted')}
                  >
                    <span className={clsx(i === index ? 'text-accent2' : 'text-faint')}>{icon(item.group)}</span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint && <span className="shrink-0 text-xs text-faint">{item.hint}</span>}
                    {i === index && <CornerDownLeft className="h-3.5 w-3.5 text-faint" aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
