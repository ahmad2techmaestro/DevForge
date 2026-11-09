import clsx from 'clsx';
import { useEffect, useRef } from 'react';
import type { RunEvent } from '../../types/index';
import { formatTime } from '../../utils/format';

function describe(e: RunEvent): { text: string; tone: 'info' | 'ok' | 'bad' | 'warn' | 'muted' } | null {
  switch (e.type) {
    case 'run.started': return { text: `Run started · ${e.data.provider}/${e.data.model} · ${e.data.sandbox} sandbox`, tone: 'info' };
    case 'node.started': return { text: `▶ ${e.data.node}`, tone: 'info' };
    case 'node.finished': return { text: `✓ ${e.data.node}`, tone: 'muted' };
    case 'log': return { text: e.data.message, tone: e.data.level === 'error' ? 'bad' : e.data.level === 'warn' ? 'warn' : 'muted' };
    case 'plan.proposed': return { text: `Plan proposed: ${e.data.steps.length} steps`, tone: 'info' };
    case 'approval.requested': return { text: `Waiting for your ${e.data.kind} approval`, tone: 'warn' };
    case 'approval.resolved': return { text: `You ${e.data.decision === 'approve' ? 'approved' : 'rejected'} it`, tone: e.data.decision === 'approve' ? 'ok' : 'bad' };
    case 'tool.call': return { text: `→ ${e.data.name}(${JSON.stringify(e.data.args).slice(0, 120)})`, tone: 'muted' };
    case 'tool.result': return { text: `${e.data.ok ? '←' : '✗'} ${e.data.name}: ${e.data.summary}`, tone: e.data.ok ? 'muted' : 'bad' };
    case 'file.changed': return { text: `Changed ${e.data.path} (+${e.data.additions} −${e.data.deletions})`, tone: 'ok' };
    case 'diff.ready': return { text: `Diff ready: ${e.data.files.length} files`, tone: 'ok' };
    case 'tests.started': return { text: `Running ${e.data.command}`, tone: 'info' };
    case 'tests.result': return { text: `Tests ${e.data.ok ? 'passed' : 'failed'} (${e.data.passed}/${e.data.total})`, tone: e.data.ok ? 'ok' : 'bad' };
    case 'review.result': return { text: `Review: ${e.data.comments.length} comments`, tone: 'info' };
    case 'pr.draft': return { text: 'PR draft prepared', tone: 'ok' };
    case 'run.completed': return { text: 'Run completed', tone: 'ok' };
    case 'run.failed': return { text: `Run failed: ${e.data.error}`, tone: 'bad' };
    case 'run.cancelled': return { text: 'Run cancelled', tone: 'warn' };
    default: return null;
  }
}

const tone = { info: 'text-accent2', ok: 'text-ok', bad: 'text-bad', warn: 'text-warn', muted: 'text-muted' };

export function Timeline({ events, follow }: { events: RunEvent[]; follow: boolean }) {
  const box = useRef<HTMLUListElement>(null);
  // Scroll only the log box: scrollIntoView would also scroll the whole page.
  useEffect(() => {
    const el = box.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [events.length, follow]);
  const rows = events.map((e) => ({ e, d: describe(e) })).filter((r) => r.d);
  return (
    <ul ref={box} className="max-h-80 overflow-y-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-6" aria-label="Run log">
      {rows.map(({ e, d }) => (
        <li key={e.seq} className="flex gap-3">
          <span className="shrink-0 text-faint">{formatTime(e.ts)}</span>
          <span className={clsx('min-w-0 break-words', tone[d!.tone])}>{d!.text}</span>
        </li>
      ))}
      {rows.length === 0 && <li className="text-faint">Waiting for the first event…</li>}
    </ul>
  );
}
