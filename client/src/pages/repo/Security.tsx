import { useMutation } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { useCreateTask } from '../../hooks/useApi';
import type { Finding, Severity } from '../../types/index';
import { SeverityBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Ring } from '../../components/ui/Ring';
import { toast } from '../../store/ui';
import { useRepoContext } from './RepoLayout';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function SecurityTab() {
  const repo = useRepoContext();
  const scan = useMutation({ mutationFn: () => api.security(repo.id) });
  const create = useCreateTask(repo.id);
  const navigate = useNavigate();
  const report = scan.data;

  const fix = async (f: Finding) => {
    try {
      const task = await create.mutateAsync({
        kind: 'bugfix',
        title: `Security: ${f.title}`.slice(0, 120),
        description: `Fix this security finding without changing behaviour.\n\n${f.title}\n${f.detail}\nLocation: ${f.path}:${f.line}${f.suggestion ? `\nSuggested fix: ${f.suggestion}` : ''}`,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      toast.error('Could not start task', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">The Security Auditor checks for leaked secrets, injection-prone code, disabled TLS checks, risky dependencies and unsafe Docker or env files. Secret values are never shown.</p>
        <Button variant="primary" icon={<ShieldAlert className="h-4 w-4" />} loading={scan.isPending} onClick={() => scan.mutate()}>{report ? 'Audit again' : 'Run security audit'}</Button>
      </div>
      {scan.isError && <p role="alert" className="mb-4 rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{scan.error instanceof ApiError ? scan.error.message : 'Audit failed'}</p>}
      {!report ? (
        !scan.isPending && <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No audit yet" body="Run the auditor to get a security score and a prioritised list of findings." />
      ) : (
        <div className="space-y-5">
          <div className="panel flex flex-wrap items-center gap-6 p-5">
            <Ring score={report.score} grade={report.grade} size={84} stroke={7} />
            <div className="min-w-0 flex-1">
              <p className="text-3xl font-semibold tabular-nums">{report.score}<span className="text-lg text-muted"> / 100</span></p>
              <p className="mt-1 text-sm text-muted">{report.summary}</p>
              <p className="mt-3 flex flex-wrap gap-2">
                {ORDER.filter((s) => report.counts[s]).map((s) => <span key={s} className="inline-flex items-center gap-1.5 text-xs"><SeverityBadge severity={s} /><span className="font-mono">{report.counts[s]}</span></span>)}
                {Object.entries(report.dependencies).map(([eco, n]) => <span key={eco} className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted">{n} {eco} deps checked</span>)}
              </p>
            </div>
          </div>
          {report.findings.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="Nothing found" body="No security issues were detected by the auditor's rules." />
          ) : (
            <ul className="panel divide-y divide-line">
              {report.findings.map((f, i) => (
                <li key={`${f.path}:${f.line}:${f.rule}:${i}`} className="flex flex-wrap items-start gap-3 p-4">
                  <SeverityBadge severity={f.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{f.title}</p>
                    <p className="text-sm text-muted">{f.detail}</p>
                    {f.suggestion && <p className="mt-1 text-sm text-ok">Fix: {f.suggestion}</p>}
                    <Link to={`/repos/${repo.id}/files?path=${encodeURIComponent(f.path)}&line=${f.line}`} className="font-mono text-xs text-accent2 hover:underline">{f.path}:{f.line}</Link>
                    <span className="ml-2 font-mono text-[11px] text-faint">{f.rule}</span>
                  </div>
                  <Button size="sm" loading={create.isPending} onClick={() => void fix(f)}>Fix with agent</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
