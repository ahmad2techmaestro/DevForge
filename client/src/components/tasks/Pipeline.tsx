import clsx from 'clsx';
import { Check } from 'lucide-react';
import { PIPELINE, type NodeState } from '../../utils/run';
import type { NodeName } from '../../types/index';

export function Pipeline({ nodes }: { nodes: Record<NodeName, NodeState> }) {
  return (
    <ol className="flex items-center overflow-x-auto py-1" aria-label="Agent pipeline">
      {PIPELINE.map((p, i) => {
        const state = nodes[p.node];
        const fixing = p.node === 'test' && nodes.fix === 'active';
        return (
          <li key={p.node} className="flex items-center" aria-current={state === 'active' ? 'step' : undefined}>
            <div className="flex items-center gap-2">
              <span className={clsx('flex h-6 w-6 items-center justify-center rounded-full border text-xs transition-colors',
                state === 'done' && 'border-ok/50 bg-ok/15 text-ok',
                state === 'active' && 'border-accent bg-accent/20 text-accent animate-pulse',
                state === 'pending' && 'border-line-strong text-faint')}>
                {state === 'done' ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
              </span>
              <span className={clsx('whitespace-nowrap text-sm', state === 'pending' ? 'text-faint' : 'text-fg')}>{fixing ? 'Test · fixing' : p.label}</span>
            </div>
            {i < PIPELINE.length - 1 && <span className={clsx('mx-3 h-px w-6 shrink-0 sm:w-10', state === 'done' ? 'bg-ok/50' : 'bg-line-strong')} />}
          </li>
        );
      })}
    </ol>
  );
}
