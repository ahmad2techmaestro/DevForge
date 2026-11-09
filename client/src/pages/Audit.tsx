import { ScrollText } from 'lucide-react';
import { useAudit } from '../hooks/useApi';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { formatTime } from '../utils/format';

export function AuditPage() {
  const audit = useAudit();
  const items = audit.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title="Audit log" description="Every sensitive action: connections, approvals, pull requests." />
      {audit.isError ? <ErrorState error={audit.error} onRetry={() => void audit.refetch()} /> : audit.isLoading ? <Skeleton className="h-64" /> : items.length === 0 ? (
        <EmptyState icon={<ScrollText className="h-5 w-5" />} title="No activity yet" body="Actions you and your agents take will be recorded here." />
      ) : (
        <>
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="px-4 py-2.5 font-medium">When</th><th className="px-4 py-2.5 font-medium">Action</th><th className="px-4 py-2.5 font-medium">Target</th><th className="px-4 py-2.5 font-medium">Details</th></tr></thead>
              <tbody className="divide-y divide-line">
                {items.map((a) => (
                  <tr key={a.id} className="hover:bg-fg/[0.03]">
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{formatTime(a.ts)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-accent2">{a.action}</td>
                    <td className="max-w-[14rem] truncate px-4 py-2.5 font-mono text-xs text-muted">{a.target}</td>
                    <td className="max-w-[22rem] truncate px-4 py-2.5 text-xs text-faint">{Object.keys(a.meta).length ? JSON.stringify(a.meta) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.hasNextPage && <div className="mt-4 flex justify-center"><Button loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>Load more</Button></div>}
        </>
      )}
    </>
  );
}
