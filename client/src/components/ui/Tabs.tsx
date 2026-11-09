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
      <nav aria-label="Sections" className="-mb-px flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="relative shrink-0">
            {({ isActive }) => (
              <span className={clsx('flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors', isActive ? 'text-fg' : 'text-muted hover:text-fg')}>
                {t.icon}
                {t.label}
                {isActive && <motion.span layoutId="tab-underline" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-fg" />}
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
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line-strong bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx('rounded-md px-2.5 py-1 text-xs font-medium capitalize transition', value === o.value ? 'bg-overlay text-fg shadow-sm' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
