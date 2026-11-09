import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-fg text-bg shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-fg/90 active:bg-fg/80',
  secondary: 'border border-line-strong bg-surface text-fg shadow-panel hover:border-fg/30 hover:bg-raised',
  ghost: 'text-muted hover:bg-fg/5 hover:text-fg',
  danger: 'border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20',
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-9 px-4 text-base',
        variants[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={clsx('inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-fg/5 hover:text-fg', className)}
    >
      {children}
    </button>
  );
}
