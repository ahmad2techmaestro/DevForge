import { useEffect, useState } from 'react';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Reveals already-received text progressively, so an answer feels like it is being written. Instant with reduced motion. */
export function TypeText({ text, cps = 900, onDone }: { text: string; cps?: number; onDone?: () => void }) {
  const [n, setN] = useState(reduced() ? text.length : 0);
  useEffect(() => {
    if (reduced()) { setN(text.length); onDone?.(); return; }
    setN(0);
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(text.length, Math.floor(((now - t0) / 1000) * cps));
      setN(k);
      if (k < text.length) raf = requestAnimationFrame(tick); else onDone?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, cps]);
  const typing = n < text.length;
  return <span className="whitespace-pre-wrap">{text.slice(0, n)}{typing && <span aria-hidden className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent2" />}</span>;
}
