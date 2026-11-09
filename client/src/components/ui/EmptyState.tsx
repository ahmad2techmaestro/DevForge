import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ApiError } from '../../services/api/client';
import { Button } from './Button';

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-raised text-accent2">{icon}</div>
      <h3 className="text-lg">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Something went wrong.';
  const code = error instanceof ApiError ? error.code : undefined;
  return (
    <div role="alert" className="flex flex-col items-center rounded-xl border border-bad/25 bg-bad/5 px-6 py-10 text-center">
      <AlertTriangle className="mb-3 h-6 w-6 text-bad" aria-hidden />
      <p className="max-w-md text-sm text-fg">{message}</p>
      {code && <p className="mt-1 font-mono text-xs text-faint">{code}</p>}
      {onRetry && (
        <Button size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
