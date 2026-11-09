import clsx from 'clsx';

const SEGMENTS = ['planner', 'engineer', 'qa', 'reviewer', 'release'] as const;

/** Five bars, one per crew agent, stepping up like a relay handing over a baton. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={clsx('h-7 w-7', className)} aria-hidden>
      <rect width="32" height="32" rx="16" className="fill-fg" />
      {SEGMENTS.map((s, i) => (
        <rect key={s} x={6 + i * 4.2} y={21 - (i + 1) * 3} width="2.8" height={(i + 1) * 3 + 2} rx="1.4" style={{ fill: `rgb(var(--crew-${s}))` }} />
      ))}
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight', className)}>
      <LogoMark />
      <span>DevForge</span>
    </span>
  );
}

/** The relay line as a standalone divider / progress track. `progress` fills it from the left. */
export function RelayLine({ className, progress = 1 }: { className?: string; progress?: number }) {
  return (
    <div className={clsx('relative h-1 overflow-hidden rounded-full bg-fg/10', className)} role="presentation">
      <div className="relay-bg absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out" style={{ width: `${Math.round(progress * 100)}%` }} />
    </div>
  );
}
