import { motion } from 'framer-motion';
import { Coins, FolderGit2, ListChecks, Plus, ShieldCheck, Target } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useActivity, useApiHealth, useBudget, useMe, useRepos, useStats } from '../hooks/useApi';
import { AiCore } from '../components/common/AiCore';
import { TypeText } from '../components/common/TypeText';
import { describeActivity } from './Activity';
import { TaskList } from '../components/tasks/TaskList';
import { Button } from '../components/ui/Button';
import { Dot } from '../components/ui/Badge';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { KIND_LABEL, formatCost, formatNumber, formatTokens } from '../utils/format';
import { useUi } from '../store/ui';

function Kpi({ icon, label, value, sub, tint }: { icon: ReactNode; label: string; value: string; sub?: string; tint: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -4 }} className={`panel relative overflow-hidden p-5 ${tint}`}>
      <div className="flex items-center justify-between text-muted">
        <span className="text-sm">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/70 text-accent2 dark:bg-white/10">{icon}</span>
      </div>
      <p className="mt-4 text-4xl font-medium tabular-nums tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </motion.div>
  );
}

const PROVIDER_NAME: Record<string, string> = {
  gemini: 'Google Gemini', groq: 'Groq', openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Ollama (local)',
  openrouter: 'OpenRouter', openai_compatible: 'OpenAI-compatible', mock: 'Offline demo model',
};

/** "gemini-3.8-flash" -> "Gemini 3.8 Flash"; "gpt-4o-mini" -> "GPT 4o Mini"; "claude-sonnet-4-5" -> "Claude Sonnet 4.5". */
export function prettyModel(model: string): string {
  const parts = model.replace(/^models\//, '').split(/[-_:]/).filter(Boolean);
  const out: string[] = [];
  for (const w of parts) {
    const prev = out[out.length - 1];
    if (/^\d$/.test(w) && prev && /^\d+(\.\d+)*$/.test(prev)) out[out.length - 1] = `${prev}.${w}`;
    else if (/^\d+(\.\d+)*[bkm]$/i.test(w)) out.push(w.toUpperCase());
    else if (/^\d/.test(w)) out.push(w);
    else if (['gpt', 'glm', 'llm'].includes(w.toLowerCase())) out.push(w.toUpperCase());
    else out.push(w.charAt(0).toUpperCase() + w.slice(1));
  }
  return out.join(' ');
}

function Chip({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' }) {
  const dot = tone === 'ok' ? 'bg-mint' : tone === 'warn' ? 'bg-peach' : tone === 'bad' ? 'bg-[rgb(255_124_140)]' : 'bg-white/40';
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-[rgb(170_210_194)]">{label}</span>
      <span className="font-medium text-white">{value}</span>
    </span>
  );
}

interface HeroProps {
  agent?: { provider: string; model: string; sandbox: string; reachable: boolean; error?: string };
  working: number;
  waiting: number;
  latest: { tone: string; text: string; title: string; key: string } | null;
}

/** The dark hero card: who is working, on which model, and what happened last. */
function AgentHero({ agent, working, waiting, latest }: HeroProps) {
  const live = !!agent && agent.provider !== 'mock';
  const offline = !!agent && !agent.reachable;
  const heading = offline ? <>The agent service is <span className="accent-serif">offline</span></>
    : !live ? <>Connect a model to wake the <span className="accent-serif">crew</span></>
    : working ? <>Your crew is <span className="accent-serif">at work</span></>
    : waiting ? <>Your crew needs <span className="accent-serif">your review</span></>
    : <>Your engineering crew is <span className="accent-serif">ready</span></>;
  const sub = offline ? 'DevForge cannot reach the agent service, so new tasks will not start. Open Settings for the reason.'
    : !live ? 'Running on the offline demo model. Add a provider key in .env to let the agents plan, write and review real code.'
    : `Five agents plan, build, test and review each change on ${prettyModel(agent.model)}. Nothing is pushed until you approve it.`;
  const status = offline ? 'Agent service offline'
    : working ? `${working} task${working === 1 ? '' : 's'} in progress`
    : waiting ? `${waiting} task${waiting === 1 ? '' : 's'} awaiting your approval`
    : 'All agents idle';
  return (
    <section aria-label="Agent crew" className="hero-card mb-6 grid items-center gap-2 p-6 md:grid-cols-[1fr_auto] md:p-9">
      <div className="relative z-10 min-w-0">
        <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm text-[rgb(214_244_230)]">
          <Dot tone={offline ? 'bad' : working ? 'ok' : 'warn'} live={working > 0} />{status}
        </p>
        <h2 className="mt-4 text-3xl font-normal leading-tight md:text-[2.6rem]">{heading}</h2>
        <p className="mt-3 max-w-xl text-sm leading-6 text-[rgb(190_226_210)]">{sub}</p>
        {agent && (
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Agent runtime">
            {!offline && <Chip label="Model" value={live ? prettyModel(agent.model) : 'Demo'} tone={live ? 'ok' : 'warn'} />}
            {!offline && <Chip label="Provider" value={PROVIDER_NAME[agent.provider] ?? agent.provider} />}
            {!offline && <Chip label="Sandbox" value={agent.sandbox === 'docker' ? 'Docker' : 'Local process'} tone={agent.sandbox === 'docker' ? 'ok' : 'warn'} />}
            <Chip label="Service" value={agent.reachable ? 'Online' : 'Offline'} tone={agent.reachable ? 'ok' : 'bad'} />
          </div>
        )}
        <div className="mt-4 min-h-[2.5rem] max-w-xl rounded-2xl bg-black/20 px-4 py-2.5 font-mono text-xs leading-5 text-[rgb(170_210_194)]" aria-live="polite">
          {latest ? <><span className={latest.tone}>▸ </span><TypeText key={latest.key} text={`${latest.text}  ·  ${latest.title}`} cps={120} /></> : <span className="opacity-80">Latest activity will appear here as soon as an agent starts working.</span>}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={() => useUi.getState().setPalette(true)} className="inline-flex h-10 items-center gap-2 rounded-full bg-peach px-5 text-base font-medium text-[rgb(60_34_14)] shadow-[0_10px_24px_-10px_rgb(var(--peach)/0.9)] transition hover:brightness-105 active:scale-[0.98]">Ask DevForge <span className="rounded-md bg-black/10 px-1.5 font-mono text-2xs">⌘K</span></button>
          <Link to="/board" className="inline-flex h-10 items-center rounded-full border border-white/25 px-5 text-base text-white transition hover:bg-white/10">Open board</Link>
          {offline && <Link to="/settings" className="inline-flex h-10 items-center rounded-full border border-white/25 px-5 text-base text-white transition hover:bg-white/10">Check settings</Link>}
        </div>
      </div>
      <div className="relative mx-auto hidden md:block"><AiCore energy={working + (waiting ? 0.3 : 0)} size={260} /></div>
    </section>
  );
}

export function Dashboard() {
  const stats = useStats();
  const repos = useRepos();
  const me = useMe();
  const health = useApiHealth();
  const budget = useBudget().data;
  const feed = useActivity().data;
  const setConnect = useUi((s) => s.setConnect);
  const repoName = (id: string) => repos.data?.find((r) => r.id === id)?.name;

  if (stats.isError) return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  const s = stats.data;
  const working = (s?.tasks.byStatus.running ?? 0) + (s?.tasks.byStatus.queued ?? 0);
  const waiting = s?.tasks.byStatus.awaiting_approval ?? 0;
  const top = feed?.[0];
  const latest = top ? { ...describeActivity(top), key: `${top.taskId}-${top.seq}`, title: top.taskTitle } : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What your agents have been up to."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setConnect(true)}>Connect repository</Button>}
      />

      <AgentHero agent={me.data?.agent} working={working} waiting={waiting} latest={latest} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {!s ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <Kpi tint="tint-mint" icon={<FolderGit2 className="h-4 w-4" />} label="Repositories" value={String(s.repos)} />
            <Kpi tint="tint-peach" icon={<ListChecks className="h-4 w-4" />} label="Tasks" value={formatNumber(s.tasks.total)} sub={`${s.tasks.byStatus.completed ?? 0} completed · ${s.tasks.byStatus.awaiting_approval ?? 0} awaiting you`} />
            <Kpi tint="tint-sky" icon={<Target className="h-4 w-4" />} label="Success rate" value={s.tasks.total ? `${Math.round(s.successRate * 100)}%` : '—'} sub="completed vs failed" />
            <Kpi tint="tint-lilac" icon={<Coins className="h-4 w-4" />} label="LLM spend" value={formatCost(s.usage.costUsd)} sub={`${formatTokens(s.usage)} tokens`} />
          </>
        )}
      </div>

      {budget && budget.budgetUsd !== null && budget.budgetUsd > 0 && (() => {
        const pct = Math.min(100, (budget.spentUsd / budget.budgetUsd) * 100);
        return (
          <Link to="/settings" className="panel mt-4 block p-4 hover:bg-fg/[0.03]" aria-label="Monthly budget, open settings">
            <div className="flex items-center justify-between text-sm"><span>Monthly budget</span><span className="tabular-nums text-muted">{formatCost(budget.spentUsd)} of {formatCost(budget.budgetUsd)}</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-fg/10"><div className={pct >= 90 ? 'h-full rounded-full bg-bad' : pct >= 70 ? 'h-full rounded-full bg-warn' : 'h-full rounded-full bg-ok'} style={{ width: `${pct}%` }} /></div>
            {pct >= 100 && <p className="mt-2 text-xs text-bad">Budget reached. New agent tasks are paused until next month or until you raise the cap.</p>}
          </Link>
        );
      })()}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="panel p-4" aria-labelledby="activity">
          <h2 id="activity" className="mb-4 text-sm">Task activity · last 14 days</h2>
          {!s ? (
            <Skeleton className="h-56" />
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={s.daily} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="rgb(128 128 150 / 0.15)" />
                  <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11, fill: 'rgb(145 150 168)' }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'rgb(145 150 168)' }} tickLine={false} axisLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgb(128 128 150 / 0.08)' }}
                    contentStyle={{ background: 'rgb(12 52 40)', border: 'none', borderRadius: 14, fontSize: 12, color: '#e9faf2' }}
                    formatter={(v: number, _n, item) => [`${v} tasks · ${formatCost((item.payload as { costUsd: number }).costUsd)}`, '']}
                    labelStyle={{ color: '#bfe8d6' }} itemStyle={{ color: '#e9faf2' }}
                  />
                  <Bar dataKey="tasks" fill="#2fb88c" radius={[10, 10, 10, 10]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="panel p-4" aria-labelledby="system">
          <h2 id="system" className="mb-4 text-sm">System</h2>
          <ul className="space-y-3 text-sm">
            <Row label="API" ok={!!health.data} detail={health.data ? `${health.data.db} · up ${Math.round(health.data.uptimeSec / 60)}m` : 'unreachable'} />
            <Row label="Agent service" ok={!!me.data?.agent.reachable} detail={me.data ? `${me.data.agent.provider} · ${me.data.agent.model}` : '…'} />
            <Row label="Sandbox" ok={me.data?.agent.sandbox === 'docker'} warn detail={me.data ? (me.data.agent.sandbox === 'docker' ? 'Docker isolation' : 'Subprocess (dev only)') : '…'} />
            <Row label="GitHub" ok={!!me.data?.github.connected} warn detail={me.data?.github.connected ? `@${me.data.github.login}` : 'Not connected'} />
          </ul>
          {me.data && me.data.agent.provider === 'mock' && (
            <p className="mt-4 flex gap-2 rounded-lg border border-warn/25 bg-warn/10 p-3 text-xs text-warn">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Offline demo model. Set LLM_PROVIDER and an API key (Gemini and Groq have free tiers) in .env for real AI.
            </p>
          )}
        </section>
      </div>

      {s && Object.keys(s.byKind).length > 0 && (
        <section className="panel mt-6 p-4" aria-labelledby="kinds">
          <div className="mb-4 flex items-center justify-between"><h2 id="kinds" className="text-sm">By task type</h2><span className="text-xs text-muted">{s.avgDurationSec ? `avg ${s.avgDurationSec}s per completed task` : ''}</span></div>
          <ul className="space-y-3">
            {Object.entries(s.byKind).sort((a, b) => b[1].count - a[1].count).map(([kind, k]) => {
              const done = k.completed + k.failed;
              const rate = done ? Math.round((k.completed / done) * 100) : null;
              return (
                <li key={kind} className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 text-sm">
                  <span className="text-muted">{KIND_LABEL[kind] ?? kind}</span>
                  <div className="h-2 overflow-hidden rounded-full bg-fg/10"><div className="h-full rounded-full bg-accent" style={{ width: `${(k.count / Math.max(...Object.values(s.byKind).map((x) => x.count))) * 100}%` }} /></div>
                  <span className="w-44 text-right text-xs tabular-nums text-muted">{k.count} task{k.count === 1 ? '' : 's'} · {rate === null ? 'no result yet' : `${rate}% success`} · {formatCost(k.costUsd)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="mt-6" aria-labelledby="recent">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent" className="text-sm">Recent tasks</h2>
          <Link to="/tasks" className="text-xs text-accent2 hover:underline">View all</Link>
        </div>
        {!s ? <Skeleton className="h-40" /> : s.recent.length === 0 ? (
          <EmptyState icon={<ListChecks className="h-5 w-5" />} title="No tasks yet" body="Connect a repository, then ask an agent to build a feature, fix a bug or write tests." action={<Button variant="primary" onClick={() => setConnect(true)}>Connect repository</Button>} />
        ) : (
          <TaskList tasks={s.recent} repoName={repoName} />
        )}
      </section>
    </>
  );
}

function Row({ label, ok, detail, warn }: { label: string; ok: boolean; detail: string; warn?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-muted"><Dot tone={ok ? 'ok' : warn ? 'warn' : 'bad'} live={ok} />{label}</span>
      <span className="truncate text-xs">{detail}</span>
    </li>
  );
}