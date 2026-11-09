import clsx from 'clsx';
import { LayoutGroup, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface TabLink {
  to: string;
  label: string;
  icon?: ReactNode;
  end?: boolean;
}

export function RouteTabs({ tabs, id }: { tabs: TabLink[]; id: string }) {
  return (
    <LayoutGroup id={id}>
      <nav aria-label="Sections" className="no-scrollbar flex gap-1 overflow-x-auto rounded-full border border-white/70 bg-surface/50 p-1 shadow-panel backdrop-blur dark:border-white/10">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="relative shrink-0">
            {({ isActive }) => (
              <span className={clsx('relative flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition-colors', isActive ? 'text-bg' : 'text-muted hover:text-fg')}>
                {isActive && <motion.span layoutId="tab-pill" className="absolute inset-0 rounded-full bg-fg" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                <span className="relative flex items-center gap-2">{t.icon}{t.label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </LayoutGroup>
  );
}

export function SegmentedControl<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-white/70 bg-surface/60 p-0.5 dark:border-white/10">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx('rounded-full px-3 py-1 text-xs font-medium capitalize transition', value === o.value ? 'bg-fg text-bg shadow-sm' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
