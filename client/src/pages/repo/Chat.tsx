import { useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { keys, useChats, useChatThread } from '../../hooks/useApi';
import type { ChatMessage } from '../../types/index';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { timeAgo } from '../../utils/format';
import { toast } from '../../store/ui';
import { useRepoContext } from './RepoLayout';

const SUGGESTIONS = ['Give me an architecture overview', 'Where is authentication handled?', 'What would you refactor first?'];

export function ChatTab() {
  const repo = useRepoContext();
  const qc = useQueryClient();
  const chats = useChats(repo.id);
  const [threadId, setThreadId] = useState<string | null>(null);
  const thread = useChatThread(repo.id, threadId);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const messages = [...(thread.data?.messages ?? []), ...pending];
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, busy]);

  const send = async (content: string) => {
    if (!content.trim() || busy) return;
    setPending([{ role: 'user', content, ts: new Date().toISOString() }]);
    setText('');
    setBusy(true);
    try {
      const res = await api.chat(repo.id, content, threadId ?? undefined);
      qc.setQueryData(keys.chat(repo.id, res.threadId), res);
      setThreadId(res.threadId);
      void qc.invalidateQueries({ queryKey: keys.chats(repo.id) });
    } catch (err) {
      toast.error('Message failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setPending([]);
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void send(text); };

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <aside className="panel max-h-[70vh] overflow-y-auto p-2">
        <Button size="sm" className="mb-2 w-full" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={() => setThreadId(null)}>New chat</Button>
        {chats.data?.map((c) => (
          <button key={c.threadId} onClick={() => setThreadId(c.threadId)} className={`block w-full rounded-md px-2 py-2 text-left hover:bg-fg/5 ${c.threadId === threadId ? 'bg-accent/10' : ''}`}>
            <span className="block truncate text-sm">{c.title}</span>
            <span className="block text-xs text-faint">{timeAgo(c.updatedAt)}</span>
          </button>
        ))}
        {chats.data?.length === 0 && <p className="p-2 text-xs text-faint">No conversations yet.</p>}
      </aside>

      <section className="panel flex h-[70vh] flex-col overflow-hidden">
        <div className="flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
          {messages.length === 0 && (
            <div className="mx-auto mt-10 max-w-md text-center">
              <p className="text-lg">Ask anything about {repo.name}</p>
              <p className="mt-1 text-sm text-muted">Answers are grounded in the indexed code and cite the files they used.</p>
              <div className="mt-5 flex flex-col gap-2">
                {SUGGESTIONS.map((s) => <button key={s} onClick={() => void send(s)} className="rounded-lg border border-line-strong px-3 py-2 text-sm text-muted transition hover:border-accent/40 hover:text-fg">{s}</button>)}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.role === 'user' ? 'bg-fg text-bg' : 'border border-line bg-raised'}`}>
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.citations && m.citations.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {m.citations.map((c, k) => (
                      <Link key={k} to={`/repos/${repo.id}/files?path=${encodeURIComponent(c.path)}&line=${c.line}`} className="rounded-md border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-xs text-accent2 hover:underline">{c.path}:{c.line}</Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && <p className="flex items-center gap-2 text-sm text-muted"><Spinner />Reading the code…</p>}
          <div ref={end} />
        </div>
        <form onSubmit={onSubmit} className="flex gap-2 border-t border-line p-3">
          <input className="field" aria-label="Message" placeholder="Ask about this codebase" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
          <Button type="submit" variant="primary" icon={<Send className="h-4 w-4" />} disabled={!text.trim()} loading={busy} aria-label="Send" />
        </form>
      </section>
    </div>
  );
}
