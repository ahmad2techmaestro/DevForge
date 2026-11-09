import type {
  Approval, DiffFile, NodeName, ReviewComment, Risk, RunEvent, TaskKind, Usage,
} from '../types/index';

/** Inserts an event keeping the list sorted by seq; duplicates (same seq) are ignored. */
export function mergeEvent(events: RunEvent[], event: RunEvent): RunEvent[] {
  if (events.some((e) => e.seq === event.seq)) return events;
  const next = [...events, event];
  if (events.length > 0 && events[events.length - 1].seq > event.seq) next.sort((a, b) => a.seq - b.seq);
  return next;
}

export type NodeState = 'pending' | 'active' | 'done';

export const PIPELINE: { node: NodeName; label: string }[] = [
  { node: 'classify', label: 'Classify' },
  { node: 'plan', label: 'Plan' },
  { node: 'implement', label: 'Implement' },
  { node: 'test', label: 'Test' },
  { node: 'review', label: 'Review' },
  { node: 'pr_draft', label: 'PR draft' },
];

export interface TestResult {
  passed: number;
  failed: number;
  total: number;
  ok: boolean;
  output: string;
  durationMs: number;
  sandbox: string;
  framework: string;
}

export interface RunView {
  nodes: Record<NodeName, NodeState>;
  kind?: TaskKind;
  plan?: { steps: Extract<RunEvent, { type: 'plan.proposed' }>['data']['steps']; summary: string; risk: Risk; requirements?: string[]; design?: string };
  pendingApproval?: Approval;
  changedFiles: DiffFile[];
  diffRisk?: Risk;
  testsCommand?: string;
  tests?: TestResult;
  review?: { summary: string; risk: Risk; comments: ReviewComment[] };
  prDraft?: { title: string; body: string; branch: string };
  usage?: Usage;
  error?: string;
  finished: boolean;
}

const NODES: NodeName[] = ['classify', 'plan', 'implement', 'test', 'fix', 'review', 'pr_draft'];

/** Folds the event stream into the state the task screen renders. */
export function deriveRun(events: RunEvent[]): RunView {
  const nodes = Object.fromEntries(NODES.map((n) => [n, 'pending'])) as Record<NodeName, NodeState>;
  const view: RunView = { nodes, changedFiles: [], finished: false };
  const files = new Map<string, DiffFile>();

  for (const ev of events) {
    switch (ev.type) {
      case 'run.started':
        view.kind = ev.data.kind;
        break;
      case 'node.started':
        nodes[ev.data.node] = 'active';
        break;
      case 'node.finished':
        nodes[ev.data.node] = 'done';
        break;
      case 'plan.proposed':
        view.plan = ev.data;
        break;
      case 'approval.requested':
        view.pendingApproval = ev.data;
        break;
      case 'approval.resolved':
        if (view.pendingApproval?.approvalId === ev.data.approvalId) view.pendingApproval = undefined;
        break;
      case 'file.changed': {
        const prev = files.get(ev.data.path);
        files.set(ev.data.path, {
          path: ev.data.path,
          status: prev?.status ?? 'modified',
          additions: ev.data.additions,
          deletions: ev.data.deletions,
        });
        break;
      }
      case 'diff.ready':
        view.changedFiles = ev.data.files;
        view.diffRisk = ev.data.risk;
        break;
      case 'tests.started':
        view.testsCommand = ev.data.command;
        break;
      case 'tests.result':
        view.tests = ev.data;
        break;
      case 'review.result':
        view.review = ev.data;
        break;
      case 'pr.draft':
        view.prDraft = ev.data;
        break;
      case 'usage':
        view.usage = ev.data;
        break;
      case 'run.completed':
        view.finished = true;
        break;
      case 'run.failed':
        view.finished = true;
        view.error = ev.data.error;
        break;
      case 'run.cancelled':
        view.finished = true;
        break;
      default:
        break;
    }
  }
  if (view.changedFiles.length === 0) view.changedFiles = [...files.values()];
  return view;
}
