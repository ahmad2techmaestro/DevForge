export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(usd < 10 ? 3 : 2)}`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatTokens(u: { inputTokens: number; outputTokens: number }): string {
  return formatNumber(u.inputTokens + u.outputTokens);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function extension(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const KIND_LABEL: Record<string, string> = {
  feature: 'Feature',
  bugfix: 'Bug fix',
  refactor: 'Refactor',
  tests: 'Tests',
  review: 'Review',
  explain: 'Explain',
};

export const LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#3b82f6',
  javascript: '#facc15',
  python: '#34d399',
  go: '#22d3ee',
  rust: '#fb923c',
  java: '#f87171',
  css: '#c084fc',
  html: '#f472b6',
  json: '#94a3b8',
  markdown: '#a3a3a3',
  yaml: '#fbbf24',
  shell: '#86efac',
};

export function languageColor(lang: string): string {
  return LANGUAGE_COLORS[lang.toLowerCase()] ?? '#64748b';
}
