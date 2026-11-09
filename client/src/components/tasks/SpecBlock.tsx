import { Compass, ListChecks, ScrollText } from 'lucide-react';

/** Spec-first view of a plan: requirements (what must be true), design (how), tasks (the steps below). */
export function SpecBlock({ requirements, design }: { requirements?: string[]; design?: string }) {
  if (!requirements?.length && !design) return null;
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {!!requirements?.length && (
        <div className="rounded-lg border border-line bg-surface/70 p-3">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted"><ScrollText className="h-3.5 w-3.5 text-accent2" aria-hidden />Requirements</h3>
          <ul className="space-y-1.5 text-sm">{requirements.map((r, i) => <li key={i} className="flex gap-2"><ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden /><span>{r}</span></li>)}</ul>
        </div>
      )}
      {design && (
        <div className="rounded-lg border border-line bg-surface/70 p-3">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted"><Compass className="h-3.5 w-3.5 text-accent2" aria-hidden />Design</h3>
          <p className="text-sm">{design}</p>
        </div>
      )}
    </div>
  );
}
