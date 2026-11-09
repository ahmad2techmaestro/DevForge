import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Task } from '../../types/index';
import { KIND_LABEL, formatCost, timeAgo } from '../../utils/format';
import { Badge, RiskBadge, StatusBadge } from '../ui/Badge';

export function TaskList({ tasks, repoName }: { tasks: Task[]; repoName?: (repoId: string) => string | undefined }) {
  return (
    <ul className="panel divide-y divide-line overflow-hidden !rounded-[26px]">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link to={`/tasks/${t.id}`} className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-fg/[0.03]">
            <Badge tone="accent" className="w-[5.5rem] shrink-0 justify-center">{KIND_LABEL[t.kind] ?? t.kind}</Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.title}</p>
              <p className="truncate text-xs text-muted">
                {repoName?.(t.repoId) ? `${repoName(t.repoId)} · ` : ''}
                {timeAgo(t.createdAt)}
              </p>
            </div>
            {t.risk && <span className="hidden sm:block"><RiskBadge level={t.risk.level} score={t.risk.score} /></span>}
            <span className="hidden w-14 text-right font-mono text-xs text-muted sm:block">{formatCost(t.usage.costUsd)}</span>
            <StatusBadge status={t.status} />
            <ChevronRight className="h-4 w-4 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}