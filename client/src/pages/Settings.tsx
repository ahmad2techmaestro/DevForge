import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, GitBranch, Moon, Sun, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../services/api/client';
import { api } from '../services/api/endpoints';
import { keys, useMe } from '../hooks/useApi';
import { BudgetSection, NotificationsSection, ProviderCheck } from '../components/settings/PlatformSettings';
import { GitHubIcon } from '../components/ui/BrandIcons';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { SegmentedControl } from '../components/ui/Tabs';
import { toast, useUi } from '../store/ui';

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="panel grid gap-6 p-5 md:grid-cols-[260px_1fr]">
      <div>
        <h2 className="text-base">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { theme, setTheme } = useUi();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState(false);

  useEffect(() => {
    api.authProviders().then((p) => setOauth(p.github), () => setOauth(false));
    if (window.location.hash === '#github=connected') {
      window.history.replaceState(null, '', window.location.pathname);
      toast.success('GitHub connected');
      void qc.invalidateQueries({ queryKey: keys.me });
    }
  }, [qc]);

  const connectWithGithub = async () => {
    setBusy(true);
    try {
      window.location.href = (await api.githubOAuthUrl()).url;
    } catch (err) {
      setBusy(false);
      toast.error('Could not start GitHub sign-in', err instanceof ApiError ? err.message : undefined);
    }
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.connectGithub(token.trim());
      toast.success('GitHub connected', `Signed in as @${res.login}`);
      setToken('');
      await qc.invalidateQueries({ queryKey: keys.me });
    } catch (err) {
      toast.error('GitHub rejected the token', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await api.disconnectGithub();
      toast.info('GitHub disconnected');
      await qc.invalidateQueries({ queryKey: keys.me });
    } catch (err) {
      toast.error('Could not disconnect', err instanceof ApiError ? err.message : undefined);
    }
  };

  const agent = me.data?.agent;
  return (
    <>
      <PageHeader title="Settings" description="Connections, agent runtime and appearance." />
      <div className="space-y-5">
        <Section title="GitHub" description="A personal access token lets DevForge list your repositories, clone private code and open pull requests. It is encrypted at rest and never sent back to the browser.">
          {!me.data ? <Skeleton className="h-24" /> : me.data.github.connected ? (
            <div className="flex flex-wrap items-center gap-4">
              {me.data.github.avatarUrl && <img src={me.data.github.avatarUrl} alt="" className="h-10 w-10 rounded-full border border-line-strong" />}
              <div className="flex-1">
                <p className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />Connected as @{me.data.github.login}</p>
                <p className="text-xs text-muted">Scopes needed: repo (read/write) for private repositories and PRs.</p>
              </div>
              <Button variant="danger" onClick={() => void disconnect()}>Disconnect</Button>
            </div>
          ) : (
            <div className="max-w-md">
            {oauth && (
              <>
                <Button variant="primary" icon={<GitHubIcon className="h-4 w-4" />} loading={busy} onClick={() => void connectWithGithub()}>Connect with GitHub</Button>
                <p className="my-4 text-xs text-faint">or paste a personal access token</p>
              </>
            )}
            <form onSubmit={connect}>
              <label htmlFor="gh-token" className="label">Personal access token</label>
              <input id="gh-token" type="password" autoComplete="off" className="field font-mono" placeholder="ghp_…" value={token} onChange={(e) => setToken(e.target.value)} required minLength={10} />
              <Button type="submit" variant="primary" icon={<GitBranch className="h-4 w-4" />} loading={busy} className="mt-4">Connect with token</Button>
            </form>
            </div>
          )}
        </Section>

        <Section title="Agent runtime" description="Configured on the agent service through environment variables.">
          {!agent ? <Skeleton className="h-24" /> : (
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <Item label="Status" value={agent.reachable ? 'Reachable' : 'Unreachable'} ok={agent.reachable} />
              <Item label="Provider" value={agent.provider} ok={agent.provider !== 'mock'} warn />
              <Item label="Model" value={agent.model || '—'} />
              <Item label="Code sandbox" value={agent.sandbox === 'docker' ? 'Docker (isolated)' : 'Local process (no isolation)'} ok={agent.sandbox === 'docker'} warn />
            </dl>
          )}
          {agent?.reachable && agent.sandbox !== 'docker' && (
            <p className="mt-4 rounded-xl bg-warn/10 px-3 py-2 text-xs text-muted">
              {agent.dockerAvailable
                ? <>Docker is running, but this service is forced to a local process. Remove <code className="font-mono">SANDBOX=subprocess</code> from the environment and restart to run agent code in isolated containers.</>
                : <>Agents run tests and commands as a local process on this computer. That is fine for your own projects. For isolated containers, install and start Docker Desktop, then restart <code className="font-mono">npm run dev</code>. It switches to Docker automatically.</>}
            </p>
          )}
          {agent && !agent.reachable && (
            <p className="mt-4 text-xs text-bad">
              The server cannot reach the agent service{agent.error ? ` (${agent.error})` : ''}. Check the <code className="font-mono">ai-service</code> lines in the terminal running <code className="font-mono">npm run dev</code>, then refresh this page.
            </p>
          )}
          {agent?.provider === 'mock' && <p className="mt-4 text-xs text-muted">The offline demo model is active. Set <code className="font-mono text-accent2">LLM_PROVIDER=gemini</code> and <code className="font-mono text-accent2">GEMINI_API_KEY</code> (or Groq, OpenAI, Anthropic, Ollama) in the root <code className="font-mono text-accent2">.env</code>, then restart.</p>}
          <ProviderCheck />
        </Section>

        <BudgetSection />
        <NotificationsSection />

        <Section title="Appearance" description="Choose how DevForge looks on this device.">
          <SegmentedControl label="Theme" value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
          <p className="mt-3 flex items-center gap-2 text-xs text-faint">{theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}Press <span className="kbd">⌘K</span> to open the command palette anywhere.</p>
        </Section>
      </div>
    </>
  );
}

function Item({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-2 font-medium">
        {ok === undefined ? null : ok ? <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden /> : warn ? <AlertTriangle className="h-4 w-4 text-warn" aria-hidden /> : <XCircle className="h-4 w-4 text-bad" aria-hidden />}
        {value}
      </dd>
    </div>
  );
}
