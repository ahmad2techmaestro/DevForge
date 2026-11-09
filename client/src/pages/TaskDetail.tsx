import { CheckCircle2, ExternalLink, GitPullRequest, Square, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../services/api/client';
import { useCancelTask, useCreatePr, useMe, useRepo, useResolveApproval, useTask, useTaskDiff } from '../hooks/useApi';
import { useTaskSubscription } from '../services/realtime/live';
import type { Task } from '../types/index';
import { ApprovalCard } from '../components/tasks/ApprovalCard';
import { DiffViewer } from '../components/code/DiffViewer';
import { CrewPanel } from '../components/tasks/CrewPanel';
import { Pipeline } from '../components/tasks/Pipeline';
import { SpecBlock } from '../components/tasks/SpecBlock';
import { RunVitals } from '../components/tasks/RunVitals';
import { ReplayBar } from '../components/tasks/ReplayBar';
import { Timeline } from '../components/tasks/Timeline';
import { Badge, RiskBadge, SeverityBadge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { KIND_LABEL, formatCost, formatDuration, formatTokens, timeAgo } from '../utils/format';
import { deriveRun } from '../utils/run';
import { toast } from '../store/ui';

const ACTIVE = new Set(['queued', 'running', 'awaiting_approval']);

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-sm">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function TaskDetail() {
  const { taskId = '' } = useParams();
  useTaskSubscription(taskId);
  const detail = useTask(taskId);
  const resolve = useResolveApproval(taskId);
  const cancel = useCancelTask(taskId);
  const task = detail.data?.task;
  const repo = useRepo(task?.repoId ?? '');
  const [replay, setReplay] = useState<number | null>(null);
  const allEvents = detail.data?.events;
  const shown = useMemo(() => (replay === null ? (allEvents ?? []) : (allEvents ?? []).filter((e) => e.seq <= replay)), [allEvents, replay]);
  const view = useMemo(() => deriveRun(shown), [shown]);
  const hasChanges = view.changedFiles.length > 0;
  const diff = useTaskDiff(taskId, hasChanges);

  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!task) return <Skeleton className="h-64" />;

  const approval = detail.data?.approvals.find((a) => a.status === 'pending');
  const active = ACTIVE.has(task.status);
  const plan = view.plan;
  const onResolve = async (decision: 'approve' | 'reject', opts: { feedback?: string; editedPlan?: import('../types/index').PlanStep[] }) => {
    if (!approval) return;
    try {
      await resolve.mutateAsync({ approvalId: approval.approvalId, decision, ...opts });
      toast.info(decision === 'approve' ? 'Approved' : 'Rejected', decision === 'approve' ? 'The agent is continuing.' : 'The agent will revise.');
    } catch (err) {
      toast.error('Could not submit decision', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="mb-1 flex items-center gap-2 text-xs text-muted">
            <Link to={`/repos/${task.repoId}`} className="hover:text-fg hover:underline">{repo.data?.name ?? 'Repository'}</Link>
            <span aria-hidden>/</span>
            <Badge tone="accent">{KIND_LABEL[task.kind] ?? task.kind}</Badge>
            <span>{timeAgo(task.createdAt)}</span>
            {task.ci && <a href={task.ci.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent2 hover:underline">CI run #{task.ci.runId}<ExternalLink className="h-3 w-3" aria-hidden /></a>}
            {task.issue && <a href={task.issue.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent2 hover:underline">Issue #{task.issue.number}<ExternalLink className="h-3 w-3" aria-hidden /></a>}
          </p>
          <h1 className="text-2xl">{task.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          {task.risk && <RiskBadge level={task.risk.level} score={task.risk.score} />}
          <StatusBadge status={task.status} />
          {active && <Button variant="danger" size="sm" icon={<Square className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>}
        </div>
      </header>

      <div className="panel px-4 py-3"><Pipeline nodes={view.nodes} /></div>
      <RunVitals events={shown} />
      <CrewPanel events={shown} status={replay === null ? task.status : 'running'} />

      {task.status === 'failed' && task.error && <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{task.error}</p>}
      {task.summary && task.status === 'completed' && <p className="panel p-4 text-sm text-muted">{task.summary}</p>}

      {task.status === 'awaiting_approval' && approval && (
        <ApprovalCard
          approval={{ approvalId: approval.approvalId, kind: approval.kind, summary: approval.summary, payload: approval.payload }}
          plan={approval.kind === 'plan' ? plan : undefined}
          busy={resolve.isPending}
          onResolve={(d, o) => void onResolve(d, o)}
        />
      )}

      {plan && approval?.kind !== 'plan' && (
        <Panel title="Plan" right={<span className="text-xs text-muted">{plan.steps.length} steps</span>}>
          <p className="mb-3 text-sm text-muted">{plan.summary}</p>
          <SpecBlock requirements={plan.requirements} design={plan.design} />
          <div className="h-3" />
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {plan.steps.map((s) => <li key={s.id}><span className="font-medium">{s.title}</span> <span className="text-muted">— {s.detail}</span></li>)}
          </ol>
        </Panel>
      )}

      {hasChanges && (
        <Panel title="Changes" right={<span className="font-mono text-xs"><span className="text-ok">+{view.changedFiles.reduce((n, f) => n + f.additions, 0)}</span> <span className="text-bad">−{view.changedFiles.reduce((n, f) => n + f.deletions, 0)}</span> · {view.changedFiles.length} files</span>}>
          {diff.isLoading ? <Skeleton className="h-32" /> : diff.data ? <DiffViewer diff={diff.data.diff} /> : (
            <ul className="space-y-1 font-mono text-xs">{view.changedFiles.map((f) => <li key={f.path}>{f.path} <span className="text-ok">+{f.additions}</span> <span className="text-bad">−{f.deletions}</span></li>)}</ul>
          )}
        </Panel>
      )}

      {(view.tests || view.testsCommand) && (
        <Panel
          title="Tests"
          right={view.tests ? <Badge tone={view.tests.ok ? 'ok' : 'bad'}>{view.tests.ok ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <XCircle className="h-3 w-3" aria-hidden />}{view.tests.passed}/{view.tests.total} passed</Badge> : <Badge tone="accent">Running</Badge>}
        >
          <p className="mb-2 font-mono text-xs text-muted">$ {view.testsCommand}{view.tests && ` · ${view.tests.framework} · ${view.tests.sandbox} · ${formatDuration(view.tests.durationMs)}`}</p>
          {view.tests && <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-5 text-muted">{view.tests.output || '(no output)'}</pre>}
        </Panel>
      )}

      {view.review && (
        <Panel title="AI review" right={<RiskBadge level={view.review.risk.level} score={view.review.risk.score} />}>
          <p className="text-sm text-muted">{view.review.summary}</p>
          {view.review.comments.length > 0 && (
            <ul className="mt-3 space-y-2">
              {view.review.comments.map((c, i) => (
                <li key={i} className="flex gap-3 rounded-lg border border-line bg-surface/60 p-3 text-sm">
                  <SeverityBadge severity={c.severity} />
                  <div><p className="font-mono text-xs text-accent2">{c.path}:{c.line}</p><p>{c.body}</p></div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {(view.prDraft || task.pr) && <PrPanel task={task} draft={view.prDraft} canOpen={hasChanges && task.status === 'completed'} />}

      <Panel title="Run log" right={<div className="flex min-w-0 flex-1 items-center justify-end gap-3"><span className="hidden text-xs text-muted sm:inline">{formatTokens(task.usage)} tokens · {formatCost(task.usage.costUsd)}</span><ReplayBar events={allEvents ?? []} at={replay} onChange={setReplay} /></div>}>
        <Timeline events={shown} follow={active && replay === null} />
      </Panel>
    </div>
  );
}

function PrPanel({ task, draft, canOpen }: { task: Task; draft?: { title: string; body: string; branch: string }; canOpen: boolean }) {
  const me = useMe();
  const create = useCreatePr(task.id);
  const [title, setTitle] = useState(draft?.title ?? task.title);
  const [body, setBody] = useState(draft?.body ?? '');
  const [asDraft, setAsDraft] = useState(true);

  if (task.pr) {
    return (
      <Panel title="Pull request">
        <a href={task.pr.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-2 text-sm text-accent2 hover:underline">
          <GitPullRequest className="h-4 w-4" aria-hidden />#{task.pr.number} on {task.pr.branch}<ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </Panel>
    );
  }

  const submit = async () => {
    try {
      await create.mutateAsync({ title, body, draft: asDraft, branch: draft?.branch });
      toast.success('Pull request opened');
    } catch (err) {
      toast.error('Could not open pull request', err instanceof ApiError ? err.message : undefined);
    }
  };
  const github = me.data?.github.connected;

  return (
    <Panel title="Pull request draft" right={draft && <code className="text-xs text-muted">{draft.branch}</code>}>
      <label className="label" htmlFor="pr-title">Title</label>
      <input id="pr-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label className="label mt-3" htmlFor="pr-body">Description</label>
      <textarea id="pr-body" className="field min-h-[140px] resize-y font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="accent-[rgb(var(--accent))]" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} />Open as draft</label>
        {!github ? (
          <p className="text-sm text-muted">Connect GitHub in <Link to="/settings" className="text-accent2 hover:underline">Settings</Link> to open a PR.</p>
        ) : (
          <Button variant="primary" icon={<GitPullRequest className="h-4 w-4" />} disabled={!canOpen || !title.trim()} loading={create.isPending} onClick={() => void submit()}>Open pull request</Button>
        )}
      </div>
    </Panel>
  );
}
