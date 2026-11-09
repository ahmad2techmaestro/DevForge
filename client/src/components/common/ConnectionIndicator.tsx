import clsx from 'clsx';
import { useConnection } from '../../store/connection';
import { Dot, type Tone } from '../ui/Badge';

const meta = {
  open: { tone: 'ok' as Tone, label: 'Live', title: 'Real-time connection is active' },
  connecting: { tone: 'warn' as Tone, label: 'Connecting', title: 'Opening the real-time connection' },
  reconnecting: { tone: 'warn' as Tone, label: 'Reconnecting', title: 'Real-time connection lost. Retrying with backoff' },
  closed: { tone: 'bad' as Tone, label: 'Offline', title: 'Real-time connection is closed' },
};

export function ConnectionIndicator({ compact }: { compact?: boolean }) {
  const status = useConnection((s) => s.status);
  const m = meta[status];
  return (
    <span title={m.title} role="status" className={clsx('inline-flex items-center gap-2 text-xs text-muted', status !== 'open' && 'text-warn')}>
      <Dot tone={m.tone} live={status === 'open' || status === 'reconnecting'} />
      <span className={clsx(compact && 'sr-only')}>{m.label}</span>
    </span>
  );
}

export function OfflineBanner() {
  const status = useConnection((s) => s.status);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  if (status === 'open' || status === 'connecting') return null;
  return (
    <div role="alert" className="border-b border-warn/25 bg-warn/10 px-4 py-1.5 text-center text-xs text-warn">
      {online
        ? 'Live updates are disconnected. Task progress may be delayed. Reconnecting automatically.'
        : 'You are offline. Changes will sync when your connection returns.'}
    </div>
  );
}
