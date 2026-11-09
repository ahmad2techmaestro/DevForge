import clsx from 'clsx';
import { CheckCircle2, ChevronDown, Plug, Plus, RefreshCw, ShieldCheck, Trash2, Wrench, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { Switch } from '../components/ui/Switch';
import { useMcpMutations, useMcpServers } from '../hooks/useApi';
import { ApiError } from '../services/api/client';
import { toast } from '../store/ui';
import type { McpInput, McpServer } from '../types/index';

interface Preset { id: string; name: string; blurb: string; transport: 'stdio' | 'http'; command: string; args: string; secret?: string }

const PRESETS: Preset[] = [
  { id: 'filesystem', name: 'filesystem', blurb: 'Read and write files in one folder you choose.', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem /path/to/folder' },
  { id: 'github', name: 'github', blurb: 'Search code, read issues and pull requests.', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-github', secret: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
  { id: 'fetch', name: 'fetch', blurb: 'Fetch a web page as markdown.', transport: 'stdio', command: 'uvx', args: 'mcp-server-fetch' },
  { id: 'playwright', name: 'playwright', blurb: 'Drive a real browser to check a UI.', transport: 'stdio', command: 'npx', args: '@playwright/mcp@latest' },
  { id: 'devforge', name: 'devforge_repo', blurb: 'DevForge code search and impact analysis for any local repo.', transport: 'stdio', command: 'python', args: '-m app.mcp.server --repo /path/to/repo' },
];

/** Splits a command line into arguments, honouring simple double or single quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

function AddServer({ open, onClose, preset }: { open: boolean; onClose: () => void; preset: Preset | null }) {
  const { add } = useMcpMutations();
  const [form, setForm] = useState<{ name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; secretKey: string; secretValue: string }>({
    name: preset?.name ?? '', transport: preset?.transport ?? 'stdio', command: preset?.command ?? '', args: preset?.args ?? '', url: '', secretKey: preset?.secret ?? '', secretValue: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: McpInput = form.transport === 'stdio'
      ? { name: form.name, transport: 'stdio', command: form.command, args: splitArgs(form.args) }
      : { name: form.name, transport: 'http', url: form.url };
    if (form.secretKey.trim() && form.secretValue) body.secrets = { [form.secretKey.trim()]: form.secretValue };
    try {
      const res = await add.mutateAsync(body);
      if (res.lastCheck?.ok) toast.success('Connected', `${res.tools.length} tools available to your agents`);
      else toast.error('Saved, but the connection failed', res.lastCheck?.error);
      onClose();
    } catch (err) {
      toast.error('Could not add the server', err instanceof ApiError ? err.message : undefined);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={preset ? `Connect ${preset.name}` : 'Connect an MCP server'} description="Agents can call this server's tools while they work. Secrets are encrypted and never shown again.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div><label className="label" htmlFor="m-name">Name</label><input id="m-name" className="field" required value={form.name} onChange={set('name')} placeholder="github" /></div>
          <div><label className="label" htmlFor="m-tr">Type</label>
            <select id="m-tr" className="field" value={form.transport} onChange={set('transport')}><option value="stdio">Local command</option><option value="http">Remote URL</option></select></div>
        </div>
        {form.transport === 'stdio' ? (
          <>
            <div><label className="label" htmlFor="m-cmd">Command</label><input id="m-cmd" className="field font-mono" required value={form.command} onChange={set('command')} placeholder="npx" /></div>
            <div><label className="label" htmlFor="m-args">Arguments</label><input id="m-args" className="field font-mono" value={form.args} onChange={set('args')} placeholder="-y @modelcontextprotocol/server-github" /></div>
          </>
        ) : (
          <div><label className="label" htmlFor="m-url">Server URL</label><input id="m-url" className="field font-mono" required value={form.url} onChange={set('url')} placeholder="https://mcp.example.com/mcp" /></div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="m-sk">{form.transport === 'stdio' ? 'Environment variable' : 'Header name'} (optional)</label><input id="m-sk" className="field font-mono" value={form.secretKey} onChange={set('secretKey')} placeholder={form.transport === 'stdio' ? 'GITHUB_PERSONAL_ACCESS_TOKEN' : 'Authorization'} /></div>
          <div><label className="label" htmlFor="m-sv">Value</label><input id="m-sv" type="password" autoComplete="off" className="field font-mono" value={form.secretValue} onChange={set('secretValue')} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-1"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={add.isPending}>Connect and test</Button></div>
      </form>
    </Modal>
  );
}

function ServerCard({ s }: { s: McpServer }) {
  const { toggle, test, remove } = useMcpMutations();
  const [open, setOpen] = useState(false);
  const ok = s.lastCheck?.ok;
  return (
    <article className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className={clsx('flex h-10 w-10 items-center justify-center rounded-xl border', ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-bad/30 bg-bad/10 text-bad')}><Plug className="h-5 w-5" aria-hidden /></div>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-base">{s.name}<Badge tone={s.transport === 'stdio' ? 'neutral' : 'info'}>{s.transport === 'stdio' ? 'local' : 'remote'}</Badge></h3>
          <p className="truncate font-mono text-xs text-muted">{s.transport === 'stdio' ? `${s.command} ${s.args.join(' ')}` : s.url}</p>
          <p className={clsx('mt-1 flex items-center gap-1.5 text-xs', ok ? 'text-ok' : 'text-bad')}>
            {ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />}
            {ok ? `${s.tools.length} tools` : s.lastCheck?.error ?? 'Not tested yet'}
          </p>
        </div>
        <Switch checked={s.enabled} label={`Enable ${s.name}`} onChange={(v) => toggle.mutate({ id: s.id, enabled: v })} />
        <Button size="sm" icon={<RefreshCw className={clsx('h-3.5 w-3.5', test.isPending && 'animate-spin')} />} onClick={() => test.mutate(s.id)}>Test</Button>
        <Button size="sm" variant="danger" aria-label={`Remove ${s.name}`} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => remove.mutate(s.id, { onSuccess: () => toast.success('Server removed') })} />
      </div>
      {s.tools.length > 0 && (
        <>
          <button type="button" className="flex w-full items-center gap-2 border-t border-line px-4 py-2 text-left text-xs text-muted hover:bg-fg/[0.03]" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Wrench className="h-3.5 w-3.5" aria-hidden />Tools<ChevronDown className={clsx('ml-auto h-4 w-4 transition', open && 'rotate-180')} aria-hidden />
          </button>
          {open && (
            <ul className="divide-y divide-line border-t border-line">
              {s.tools.map((t) => (
                <li key={t.name} className="flex items-start gap-3 px-4 py-2.5">
                  <code className="shrink-0 font-mono text-xs text-accent2">{t.name}</code>
                  <span className="min-w-0 flex-1 text-xs text-muted">{t.description}</span>
                  {t.readOnly ? <Badge tone="ok">read-only</Badge> : <Badge tone="warn">can change things</Badge>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

export function McpPage() {
  const servers = useMcpServers();
  const [adding, setAdding] = useState<{ preset: Preset | null } | null>(null);
  return (
    <>
      <PageHeader title="Tools (MCP)" description="Connect Model Context Protocol servers so your agents can use GitHub, files, browsers, databases and more."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding({ preset: null })}>Connect server</Button>} />
      <p className="panel mb-6 flex items-start gap-3 p-4 text-sm text-muted"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
        During planning, agents can only use tools marked read-only. Tools that can change things run only in the implementation step, after you approve the plan.</p>
      {servers.isError ? <ErrorState error={servers.error} onRetry={() => void servers.refetch()} /> : servers.isLoading ? <Skeleton className="h-40" /> : (servers.data ?? []).length === 0 ? (
        <EmptyState icon={<Plug className="h-5 w-5" />} title="No tools connected" body="Pick one below to give your agents new abilities." />
      ) : (
        <div className="space-y-3">{servers.data!.map((s) => <ServerCard key={s.id} s={s} />)}</div>
      )}
      <h2 className="mb-3 mt-10 text-sm">Quick connect</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => setAdding({ preset: p })} className="panel p-4 text-left transition hover:border-accent/40 hover:bg-fg/[0.03]">
            <p className="font-mono text-sm text-accent2">{p.name}</p><p className="mt-1 text-sm text-muted">{p.blurb}</p>
          </button>
        ))}
      </div>
      {adding && <AddServer key={adding.preset?.id ?? 'custom'} open onClose={() => setAdding(null)} preset={adding.preset} />}
    </>
  );
}
