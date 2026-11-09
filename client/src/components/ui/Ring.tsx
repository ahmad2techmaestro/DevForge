import type { Grade } from '../../types/index';

export function scoreColor(score: number): string {
  if (score >= 80) return 'rgb(var(--ok))';
  if (score >= 60) return 'rgb(var(--warn))';
  return 'rgb(var(--bad))';
}

export function Ring({ score, grade, size = 44, stroke = 4 }: { score: number; grade?: Grade; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`Health score ${score} out of 100${grade ? `, grade ${grade}` : ''}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--line) / 0.1)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={scoreColor(score)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(100, Math.max(0, score)) / 100)}
          style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.2,0.7,0.2,1)' }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-xs font-semibold">{grade ?? score}</span>
    </div>
  );
}
