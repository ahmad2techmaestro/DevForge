import clsx from 'clsx';

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx('relative h-5 w-9 shrink-0 rounded-full border transition-colors', checked ? 'border-accent/60 bg-accent' : 'border-line-strong bg-raised')}
    >
      <span className={clsx('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all', checked ? 'left-[1.1rem]' : 'left-0.5 bg-muted')} />
    </button>
  );
}
