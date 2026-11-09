import { useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle2, Gauge, Wallet, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { keys, useBudget, useNotifications } from '../../hooks/useApi';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { toast } from '../../store/ui';
import type { LlmCheck } from '../../types/index';
import { formatCost } from '../../utils/format';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { Switch } from '../ui/Switch';

const EVENTS: { id: string; label: string }[] = [
  { id: 'task.awaiting_approval', label: 'A task needs my approval' },
  { id: 'task.completed', label: 'A task finished' },
  { id: 'task.failed', label: 'A task failed' },
  { id: 'review.posted', label: 'A pull request review was posted' },
  { id: 'ci.failure', label: 'CI failed and a fix task was drafted' },
];

export function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
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

export function ProviderCheck() {
  const [res, setRes] = useState<LlmCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setRes(await api.llmCheck());
    } catch (err) {
      setRes({ ok: false, provider: '', model: '', error: err instanceof ApiError ? err.message : 'Could not reach the agent service' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" icon={<Gauge className="h-3.5 w-3.5" />} loading={busy} onClick={() => void run()}>Test the model connection</Button>
        {res && (
          <span role="status" className={clsx('inline-flex items-center gap-1.5 text-sm', res.ok ? 'text-ok' : 'text-bad')}>
            {res.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
            {res.ok ? `${res.provider} · ${res.model} answered` : res.error ?? 'The provider did not answer'}
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        Free options: <span className="font-mono">LLM_PROVIDER=gemini</span> + <span className="font-mono">GEMINI_API_KEY</span> (aistudio.google.com),{' '}
        <span className="font-mono">groq</span> + <span className="font-mono">GROQ_API_KEY</span>, or local <span className="font-mono">ollama</span>. Put them in the root <span className="font-mono">.env</span> and restart.
      </p>
    </div>
  );
}

export function BudgetSection() {
  const budget = useBudget();
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  useEffect(() => { if (budget.data) setValue(budget.data.budgetUsd === null ? '' : String(budget.data.budgetUsd)); }, [budget.data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const n = value.trim() === '' ? null : Number(value);
    if (n !== null && (!Number.isFinite(n) || n < 0)) return;
    try {
      await api.setBudget(n);
      await qc.invalidateQueries({ queryKey: keys.budget });
      toast.success(n === null ? 'Budget removed' : 'Budget saved', n === null ? undefined : `${formatCost(n)} per month`);
    } catch (err) {
      toast.error('Could not save the budget', err instanceof ApiError ? err.message : undefined);
    }
  };
  const b = budget.data;
  const pct = b && b.budgetUsd ? Math.min(100, (b.spentUsd / b.budgetUsd) * 100) : 0;
  return (
    <Section title="Monthly budget" description="Stops new agent tasks once this month's model spend reaches the cap. Running tasks are never cut off.">
      {!b ? <Skeleton className="h-20" /> : (
        <form onSubmit={save} className="max-w-md">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label htmlFor="budget" className="label">Cap in USD (empty = no limit)</label>
              <div className="relative"><Wallet className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden /><input id="budget" className="field pl-9" inputMode="decimal" placeholder="e.g. 5" value={value} onChange={(e) => setValue(e.target.value)} /></div>
            </div>
            <Button type="submit" variant="primary">Save</Button>
          </div>
          <div className="mt-4" aria-label="Budget used">
            <div className="h-2 overflow-hidden rounded-full bg-fg/10"><div className={clsx('h-full rounded-full transition-all', pct >= 90 ? 'bg-bad' : pct >= 70 ? 'bg-warn' : 'bg-ok')} style={{ width: `${b.budgetUsd === null ? 0 : pct}%` }} /></div>
            <p className="mt-2 text-xs text-muted">{formatCost(b.spentUsd)} spent this month{b.budgetUsd !== null ? ` of ${formatCost(b.budgetUsd)}` : ''}.</p>
          </div>
        </form>
      )}
    </Section>
  );
}

export function NotificationsSection() {
  const n = useNotifications();
  const qc = useQueryClient();
  const [slack, setSlack] = useState('');
  const [discord, setDiscord] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (body: Parameters<typeof api.setNotifications>[0]) => {
    setBusy(true);
    try {
      await api.setNotifications(body);
      await qc.invalidateQueries({ queryKey: keys.notifications });
      setSlack(''); setDiscord('');
      toast.success('Notifications updated');
    } catch (err) {
      toast.error('Could not save', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const r = await api.testNotifications();
      const ok = [r.slack === true && 'Slack', r.discord === true && 'Discord'].filter(Boolean).join(' and ');
      if (ok) toast.success('Test sent', ok);
      else toast.error('The test message was not delivered', 'Check the webhook URL.');
    } catch (err) {
      toast.error('Test failed', err instanceof ApiError ? err.message : undefined);
    }
  };
  const d = n.data;
  const toggleEvent = (id: string, on: boolean) => {
    if (!d) return;
    void save({ events: on ? [...d.events, id] : d.events.filter((e) => e !== id) });
  };
  return (
    <Section title="Notifications" description="Get a Slack or Discord message when an agent needs you. Webhook URLs are encrypted and never shown again.">
      {!d ? <Skeleton className="h-32" /> : (
        <div className="max-w-lg space-y-4">
          <div>
            <label htmlFor="slack" className="label">Slack incoming webhook {d.slack && <span className="ml-1 text-ok">· connected</span>}</label>
            <div className="flex gap-2"><input id="slack" className="field font-mono" placeholder={d.slack ? '••••••••••••' : 'https://hooks.slack.com/services/…'} value={slack} onChange={(e) => setSlack(e.target.value)} />
              {d.slack && <Button onClick={() => void save({ slackUrl: null })}>Remove</Button>}</div>
          </div>
          <div>
            <label htmlFor="discord" className="label">Discord webhook {d.discord && <span className="ml-1 text-ok">· connected</span>}</label>
            <div className="flex gap-2"><input id="discord" className="field font-mono" placeholder={d.discord ? '••••••••••••' : 'https://discord.com/api/webhooks/…'} value={discord} onChange={(e) => setDiscord(e.target.value)} />
              {d.discord && <Button onClick={() => void save({ discordUrl: null })}>Remove</Button>}</div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" loading={busy} disabled={!slack.trim() && !discord.trim()} icon={<Bell className="h-4 w-4" />} onClick={() => void save({ ...(slack.trim() ? { slackUrl: slack.trim() } : {}), ...(discord.trim() ? { discordUrl: discord.trim() } : {}) })}>Save webhook</Button>
            {(d.slack || d.discord) && <Button onClick={() => void test()}>Send a test</Button>}
          </div>
          <fieldset className="space-y-2.5 border-t border-line pt-4">
            <legend className="sr-only">Notify me when</legend>
            {EVENTS.map((e) => (
              <label key={e.id} className="flex items-center gap-2.5 text-sm"><Switch checked={d.events.includes(e.id)} onChange={(v) => toggleEvent(e.id, v)} label={e.label} />{e.label}</label>
            ))}
          </fieldset>
        </div>
      )}
    </Section>
  );
}
