import clsx from 'clsx';
import { Activity as ActivityIcon, CheckCircle2, FileDiff, FlaskConical, GitPullRequest, Hand, Play, ScrollText, Search, ShieldAlert, Wrench, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { useActivity } from '../hooks/useApi';
import type { ActivityItem } from '../types/index';
import { timeAgo } from '../utils/format';

type D = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function describeActivity(e: ActivityItem): { icon: ReactNode; text: string; tone: string } {
  const d = e.data as D;
  const ic = 'h-4 w-4';
  switch (e.type) {
    case 'run.started': return { icon: <Play className={ic} />, text: 'Run started', tone: 'text-accent2' };
    case 'plan.proposed': return { icon: <ScrollText className={ic} />, text: `Plan proposed (${Array.isArray(d.steps) ? d.steps.length : 0} steps)`, tone: 'text-accent2' };
    case 'approval.requested': return { icon: <ShieldAlert className={ic} />, text: `Waiting for your ${str(d.kind)} approval`, tone: 'text-warn' };
    case 'approval.resolved': return { icon: <Hand className={ic} />, text: d.decision === 'approve' ? 'You approved' : 'You rejected', tone: d.decision === 'approve' ? 'text-ok' : 'text-bad' };
    case 'tool.call': {
      const name = str(d.name);
      const args = (d.args ?? {}) as D;
      const target = str(args.path) || str(args.query) || str(args.command);
      return { icon: name.startsWith('mcp__') ? <Wrench className={ic} /> : <Search className={ic} />, text: `${name}${target ? ` ${target.slice(0, 80)}` : ''}`, tone: 'text-muted' };
    }
    case 'file.changed': return { icon: <FileDiff className={ic} />, text: `Edited ${str(d.path)} (+${Number(d.additions) || 0} −${Number(d.deletions) || 0})`, tone: 'text-ok' };
    case 'tests.result': return { icon: <FlaskConical className={ic} />, text: `Tests ${d.ok ? 'passed' : 'failed'} (${Number(d.passed) || 0}/${Number(d.total) || 0})`, tone: d.ok ? 'text-ok' : 'text-bad' };
    case 'review.result': return { icon: <ScrollText className={ic} />, text: 'Review finished', tone: 'text-accent2' };
    case 'pr.draft': return { icon: <GitPullRequest className={ic} />, text: 'Pull request drafted', tone: 'text-ok' };
    case 'run.completed': return { icon: <CheckCircle2 className={ic} />, text: 'Run completed', tone: 'text-ok' };
    case 'run.failed': return { icon: <XCircle className={ic} />, text: `Run failed: ${str(d.error).slice(0, 100)}`, tone: 'text-bad' };
    default: return { icon: <ActivityIcon className={ic} />, text: e.type, tone: 'text-muted' };
  }
}

export function ActivityPage() {
  const feed = useActivity();
  return (
    <>
      <PageHeader title="Activity" description="What your agents are doing right now, across every task. Updates every few seconds." />
      {feed.isError ? <ErrorState error={feed.error} onRetry={() => void feed.refetch()} /> : feed.isLoading ? <Skeleton className="h-96" /> : (feed.data ?? []).length === 0 ? (
        <EmptyState icon={<ActivityIcon className="h-5 w-5" />} title="Quiet for now" body="Start a task and every tool call, file edit and approval will stream in here." />
      ) : (
        <ol className="panel divide-y divide-line overflow-hidden" aria-live="polite">
          {feed.data!.map((e) => {
            const d = describeActivity(e);
            return (
              <li key={`${e.taskId}-${e.seq}`}>
                <Link to={`/tasks/${e.taskId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-fg/[0.03]">
                  <span className={clsx('shrink-0', d.tone)} aria-hidden>{d.icon}</span>
                  <span className={clsx('min-w-0 flex-1 truncate font-mono text-xs', d.tone)}>{d.text}</span>
                  <span className="hidden max-w-[40%] truncate text-xs text-muted sm:block">{e.taskTitle}</span>
                  <span className="shrink-0 text-xs text-faint">{timeAgo(e.ts)}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
