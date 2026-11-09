import type { NodeName, RunEvent } from '../types/index';

export type AgentId = 'planner' | 'engineer' | 'qa' | 'reviewer' | 'release';
export type AgentState = 'idle' | 'working' | 'waiting' | 'done' | 'failed';

export interface AgentMeta {
  id: AgentId;
  name: string;
  role: string;
  nodes: NodeName[];
}

export const CREW: AgentMeta[] = [
  { id: 'planner', name: 'Planner', role: 'Reads the codebase and drafts a step-by-step plan', nodes: ['classify', 'plan'] },
  { id: 'engineer', name: 'Engineer', role: 'Writes the code in an isolated workspace', nodes: ['implement', 'fix'] },
  { id: 'qa', name: 'QA', role: 'Runs the tests in the sandbox', nodes: ['test'] },
  { id: 'reviewer', name: 'Reviewer', role: 'Reviews the diff and scores the risk', nodes: ['review'] },
  { id: 'release', name: 'Release', role: 'Prepares the branch and pull request', nodes: ['pr_draft'] },
];

const OWNER = new Map<NodeName, AgentId>(CREW.flatMap((a) => a.nodes.map((n) => [n, a.id] as const)));

export interface AgentView {
  meta: AgentMeta;
  state: AgentState;
  activity: string[];
  stats: string[];
}

export interface Handoff {
  seq: number;
  from: string;
  to: string;
  note: string;
}

export interface CrewView {
  agents: AgentView[];
  handoffs: Handoff[];
  /** The agent currently doing work or waiting on a human. */
  focus: AgentId | null;
}

const ACTIVITY_CAP = 4;
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Folds the run's event stream into per-agent state, recent activity and the handoffs between agents. */
export function deriveCrew(events: RunEvent[], finishedStatus?: 'completed' | 'failed' | 'cancelled' | null): CrewView {
  const state = new Map<AgentId, AgentState>(CREW.map((a) => [a.id, 'idle']));
  const activity = new Map<AgentId, string[]>(CREW.map((a) => [a.id, []]));
  const counters = new Map<AgentId, { tools: number; files: number; fixes: number; comments: number; tests?: string }>(
    CREW.map((a) => [a.id, { tools: 0, files: 0, fixes: 0, comments: 0 }]),
  );
  const handoffs: Handoff[] = [];
  let current: AgentId | null = null;
  let last: AgentId | null = null;
  let waiting: AgentId | null = null;

  const note = (id: AgentId | null, text: string) => {
    if (!id) return;
    const list = activity.get(id)!;
    list.push(short(text));
    if (list.length > ACTIVITY_CAP) list.shift();
  };
  const name = (id: AgentId) => CREW.find((a) => a.id === id)!.name;

  for (const ev of events) {
    switch (ev.type) {
      case 'node.started': {
        const id = OWNER.get(ev.data.node);
        if (!id) break;
        if (ev.data.node === 'fix') counters.get(id)!.fixes += 1;
        if (last && last !== id) {
          const why = ev.data.node === 'fix' ? 'tests failed, asking for a fix' : 'handing over';
          handoffs.push({ seq: ev.seq, from: name(last), to: name(id), note: why });
        }
        current = id;
        last = id;
        waiting = null;
        state.set(id, 'working');
        break;
      }
      case 'node.finished': {
        const id = OWNER.get(ev.data.node);
        if (id && state.get(id) === 'working') state.set(id, 'done');
        if (current === id) current = null;
        break;
      }
      case 'log':
        note(current, ev.data.message);
        break;
      case 'tool.call':
        counters.get(current ?? 'engineer')!.tools += 1;
        note(current, `→ ${ev.data.name}`);
        break;
      case 'tool.result':
        note(current, `${ev.data.ok ? '✓' : '✗'} ${ev.data.name}: ${ev.data.summary}`);
        break;
      case 'file.changed':
        counters.get('engineer')!.files += 1;
        note('engineer', `edited ${ev.data.path}`);
        break;
      case 'plan.proposed':
        note('planner', `proposed ${ev.data.steps.length} step plan`);
        break;
      case 'tests.result': {
        const c = counters.get('qa')!;
        c.tests = `${ev.data.passed}/${ev.data.total} passed`;
        note('qa', `tests ${ev.data.ok ? 'passed' : 'failed'} (${ev.data.passed}/${ev.data.total})`);
        break;
      }
      case 'review.result':
        counters.get('reviewer')!.comments = ev.data.comments.length;
        note('reviewer', `${ev.data.comments.length} comment(s), ${ev.data.risk.level} risk`);
        break;
      case 'pr.draft':
        note('release', `drafted PR on ${ev.data.branch}`);
        break;
      case 'approval.requested': {
        const id: AgentId = ev.data.kind === 'plan' ? 'planner' : 'reviewer';
        waiting = id;
        state.set(id, 'waiting');
        handoffs.push({ seq: ev.seq, from: name(id), to: 'You', note: `${ev.data.kind} approval` });
        break;
      }
      case 'approval.resolved': {
        if (waiting) {
          const approved = ev.data.decision === 'approve';
          handoffs.push({ seq: ev.seq, from: 'You', to: name(waiting), note: approved ? 'approved' : 'rejected, revising' });
          state.set(waiting, approved ? 'done' : 'working');
          waiting = null;
        }
        break;
      }
      default:
        break;
    }
  }

  if (finishedStatus === 'failed' && current) state.set(current, 'failed');
  if (finishedStatus === 'cancelled' || finishedStatus === 'failed') {
    for (const [id, s] of state) if (s === 'working' || s === 'waiting') state.set(id, finishedStatus === 'failed' ? 'failed' : 'idle');
  }
  if (finishedStatus === 'completed') {
    for (const [id, s] of state) if (s === 'working' || s === 'waiting') state.set(id, 'done');
  }

  const focus = [...state].find(([, s]) => s === 'waiting')?.[0] ?? [...state].find(([, s]) => s === 'working')?.[0] ?? null;
  return {
    focus,
    handoffs,
    agents: CREW.map((meta) => {
      const c = counters.get(meta.id)!;
      const stats: string[] = [];
      if (meta.id === 'engineer') {
        if (c.files) stats.push(`${c.files} file edit${c.files > 1 ? 's' : ''}`);
        if (c.fixes) stats.push(`${c.fixes} fix pass${c.fixes > 1 ? 'es' : ''}`);
      }
      if (meta.id === 'qa' && c.tests) stats.push(c.tests);
      if (meta.id === 'reviewer' && state.get('reviewer') !== 'idle') stats.push(`${c.comments} comment${c.comments === 1 ? '' : 's'}`);
      return { meta, state: state.get(meta.id)!, activity: activity.get(meta.id)!, stats };
    }),
  };
}
