import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { Network } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGraph } from '../../hooks/useApi';
import type { GraphNode } from '../../types/index';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { basename, languageColor } from '../../utils/format';
import { useRepoContext } from './RepoLayout';

type N = GraphNode & SimulationNodeDatum;
const W = 900;
const H = 560;
const MAX_NODES = 250;

export function GraphTab() {
  const repo = useRepoContext();
  const graph = useGraph(repo.id);
  const navigate = useNavigate();
  const [, tick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const nodesRef = useRef<N[]>([]);
  const linksRef = useRef<SimulationLinkDatum<N>[]>([]);

  const data = useMemo(() => {
    if (!graph.data) return null;
    const nodes = [...graph.data.nodes].sort((a, b) => b.degree - a.degree).slice(0, MAX_NODES);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)), total: graph.data.nodes.length };
  }, [graph.data]);

  useEffect(() => {
    if (!data) return;
    const nodes: N[] = data.nodes.map((n) => ({ ...n }));
    const links = data.edges.map((e) => ({ source: e.source, target: e.target }));
    nodesRef.current = nodes;
    const sim = forceSimulation(nodes)
      .force('link', forceLink<N, SimulationLinkDatum<N>>(links).id((d) => d.id).distance(46).strength(0.4))
      .force('charge', forceManyBody().strength(-60))
      .force('center', forceCenter(W / 2, H / 2))
      // Gentle pull keeps files with no imports from drifting far away from the cluster.
      .force('x', forceX<N>(W / 2).strength(0.08))
      .force('y', forceY<N>(H / 2).strength(0.08))
      .force('collide', forceCollide<N>().radius((d) => radius(d) + 2));
    linksRef.current = links;
    let frame = 0;
    sim.on('tick', () => { if (++frame % 3 === 0) tick((t) => t + 1); });
    sim.on('end', () => tick((t) => t + 1));
    return () => { sim.stop(); };
  }, [data]);

  if (graph.isError) return <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />;
  if (!data) return <Skeleton className="h-96" />;
  if (data.nodes.length === 0) return <EmptyState icon={<Network className="h-5 w-5" />} title="No import graph" body="No local imports were detected in this repository." />;

  const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
  // Fit the view to the laid-out nodes so small repositories fill the canvas.
  const placed = nodesRef.current.filter((n) => n.x !== undefined && n.y !== undefined);
  const pad = 70;
  const xs = placed.map((n) => n.x as number);
  const ys = placed.map((n) => n.y as number);
  const box = placed.length
    ? { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 }
    : { x: 0, y: 0, w: W, h: H };
  const view = box.w / box.h > W / H ? { ...box, h: box.w * (H / W) } : { ...box, w: box.h * (W / H) };
  const scale = view.w / W; // keeps strokes and labels a constant on-screen size
  const labels = data.nodes.length <= 40;
  const active = hover ? new Set([hover, ...data.edges.filter((e) => e.source === hover || e.target === hover).flatMap((e) => [e.source, e.target])]) : null;

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs text-muted">
        <span>{data.nodes.length}{data.total > data.nodes.length ? ` of ${data.total}` : ''} files · {data.edges.length} imports · click a file to open</span>
        <span className="font-mono text-accent2">{hover ?? 'hover a node'}</span>
      </div>
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} className="h-auto max-h-[70vh] w-full bg-surface" role="img" aria-label="File import graph">
        <g stroke="rgb(var(--line) / 0.25)">
          {data.edges.map((e, i) => {
            const s = byId.get(e.source); const t = byId.get(e.target);
            if (!s || !t || s.x === undefined || t.x === undefined) return null;
            const dim = active && !(active.has(e.source) && active.has(e.target));
            return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} opacity={dim ? 0.08 : 0.7} />;
          })}
        </g>
        {nodesRef.current.map((n) => (
          <circle
            key={n.id}
            cx={n.x ?? W / 2}
            cy={n.y ?? H / 2}
            r={radius(n) * Math.max(scale, 0.6) * (data.nodes.length <= 40 ? 1.8 : 1)}
            fill={languageColor(n.language)}
            opacity={active && !active.has(n.id) ? 0.15 : 0.9}
            className="cursor-pointer"
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover(null)}
            onClick={() => navigate(`/repos/${repo.id}/files?path=${encodeURIComponent(n.path)}`)}
          >
            <title>{n.path}</title>
          </circle>
        ))}
        {labels && nodesRef.current.map((n) => (
          <text key={`t-${n.id}`} x={n.x ?? W / 2} y={(n.y ?? H / 2) + (radius(n) * 1.8 + 14) * Math.max(scale, 0.6)} textAnchor="middle" fontSize={11 * Math.max(scale, 0.6)} fill="rgb(var(--muted))" opacity={active && !active.has(n.id) ? 0.2 : 1} pointerEvents="none">{basename(n.path)}</text>
        ))}
      </svg>
    </div>
  );
}

function radius(n: GraphNode): number {
  return 4 + Math.min(10, Math.sqrt(n.degree) * 2);
}
