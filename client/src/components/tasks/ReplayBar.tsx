import { History, Pause, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RunEvent } from '../../types/index';
import { Button } from '../ui/Button';

/** Scrub through a finished run: the pipeline, crew and log all show the run as it was at that event. */
export function ReplayBar({ events, at, onChange }: { events: RunEvent[]; at: number | null; onChange: (seq: number | null) => void }) {
  const [playing, setPlaying] = useState(false);
  const seqs = events.map((e) => e.seq);
  const last = seqs[seqs.length - 1] ?? 0;
  const idx = at === null ? seqs.length : seqs.filter((s) => s <= at).length;
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      onChange(((cur) => {
        const next = seqs.find((s) => s > (cur ?? 0));
        if (next === undefined) { setPlaying(false); return last; }
        return next;
      })(at));
    }, 320);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [playing, at, last, onChange, seqs]);

  if (at === null) {
    return <Button size="sm" icon={<History className="h-3.5 w-3.5" />} onClick={() => { onChange(seqs[0] ?? 0); setPlaying(false); }} disabled={seqs.length < 2}>Replay</Button>;
  }
  return (
    <div className="flex flex-1 items-center gap-3 rounded-lg border border-line-strong bg-raised px-3 py-1.5" role="group" aria-label="Run replay">
      <button type="button" aria-label={playing ? 'Pause replay' : 'Play replay'} onClick={() => { if (!playing && at >= last) onChange(seqs[0] ?? 0); setPlaying((p) => !p); }} className="rounded-md p-1 text-fg hover:bg-fg/10">
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <input
        type="range" min={0} max={Math.max(seqs.length - 1, 0)} value={Math.max(idx - 1, 0)} aria-label="Replay position"
        onChange={(e) => { setPlaying(false); onChange(seqs[Number(e.target.value)] ?? last); }}
        className="h-1 flex-1 cursor-pointer accent-[rgb(var(--fg))]"
      />
      <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">{idx}/{seqs.length}</span>
      <button type="button" aria-label="Exit replay" onClick={() => { setPlaying(false); onChange(null); }} className="rounded-md p-1 text-muted hover:bg-fg/10 hover:text-fg"><X className="h-4 w-4" /></button>
    </div>
  );
}
