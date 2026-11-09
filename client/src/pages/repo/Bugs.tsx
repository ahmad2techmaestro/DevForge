import { useMutation } from '@tanstack/react-query';
import { Bug, ScanSearch } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { useCreateTask } from '../../hooks/useApi';
import type { Finding } from '../../types/index';
import { SeverityBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatCost } from '../../utils/format';
import { toast } from '../../store/ui';
import { useRepoContext } from './RepoLayout';

export function BugsTab() {
  const repo = useRepoContext();
  const scan = useMutation({ mutationFn: () => api.bugs(repo.id) });
  const create = useCreateTask(repo.id);
  const navigate = useNavigate();

  const fix = async (f: Finding) => {
    try {
      const task = await create.mutateAsync({
        kind: 'bugfix',
        title: `Fix: ${f.title}`,
        description: `${f.detail}\n\nLocation: ${f.path}:${f.line}${f.suggestion ? `\nSuggestion: ${f.suggestion}` : ''}`,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      toast.error('Could not start task', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Scan for likely bugs, unsafe patterns and leaked secrets, then hand any finding to an agent.</p>
        <Button variant="primary" icon={<ScanSearch className="h-4 w-4" />} loading={scan.isPending} onClick={() => scan.mutate()}>
          {scan.data ? 'Scan again' : 'Scan for bugs'}
        </Button>
      </div>
      {scan.isError && <p role="alert" className="mb-4 rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{scan.error instanceof ApiError ? scan.error.message : 'Scan failed'}</p>}
      {!scan.data ? (
        !scan.isPending && <EmptyState icon={<Bug className="h-5 w-5" />} title="No scan yet" body="Run a scan to see findings ranked by severity." />
      ) : scan.data.findings.length === 0 ? (
        <EmptyState icon={<Bug className="h-5 w-5" />} title="Nothing suspicious found" body="The scan completed without findings." />
      ) : (
        <>
          <p className="mb-2 text-xs text-faint">{scan.data.findings.length} findings · scan cost {formatCost(scan.data.usage.costUsd)}</p>
          <ul className="panel divide-y divide-line">
            {scan.data.findings.map((f, i) => (
              <li key={i} className="flex flex-wrap items-start gap-3 p-4">
                <SeverityBadge severity={f.severity} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{f.title}</p>
                  <p className="text-sm text-muted">{f.detail}</p>
                  {f.suggestion && <p className="mt-1 text-sm text-ok">Suggestion: {f.suggestion}</p>}
                  <Link to={`/repos/${repo.id}/files?path=${encodeURIComponent(f.path)}&line=${f.line}`} className="font-mono text-xs text-accent2 hover:underline">{f.path}:{f.line}</Link>
                </div>
                <Button size="sm" loading={create.isPending} onClick={() => void fix(f)}>Fix with agent</Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
