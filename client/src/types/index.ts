export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  path: string;
  line: number;
  severity: Severity;
  rule: string;
  title: string;
  detail: string;
  suggestion?: string;
}

export type RiskLevel = 'low' | 'medium' | 'high';
export interface Risk {
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export interface ReviewComment {
  path: string;
  line: number;
  severity: 'info' | 'low' | 'medium' | 'high';
  body: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AgentInfo {
  provider: string;
  model: string;
  sandbox: string;
  dockerAvailable: boolean;
  reachable: boolean;
  error?: string;
}

export interface Me {
  user: User;
  github: { connected: boolean; login?: string; avatarUrl?: string };
  agent: AgentInfo;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  updatedAt: string;
  cloneUrl: string;
}

export type RepoStatus = 'indexing' | 'ready' | 'error';
export type RepoSource = 'github' | 'url' | 'local';

export interface RepoStats {
  fileCount: number;
  totalLines: number;
  languages: Record<string, { files: number; lines: number }>;
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface Repo {
  id: string;
  name: string;
  fullName?: string;
  cloneUrl?: string;
  source: RepoSource;
  branch: string;
  status: RepoStatus;
  error?: string;
  commit?: string;
  stats?: RepoStats;
  summary?: string;
  health?: { score: number; grade: Grade };
  autoReview?: boolean;
  autoFixCi?: boolean;
  createdAt: string;
  indexedAt?: string;
}

export interface CreateRepoInput {
  fullName?: string;
  cloneUrl?: string;
  localPath?: string;
  branch?: string;
}

export interface TreeFile {
  path: string;
  size: number;
  language: string;
  lines: number;
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
  lines: number;
  truncated: boolean;
}

export interface GraphNode {
  id: string;
  path: string;
  language: string;
  lines: number;
  degree: number;
}
export interface GraphEdge {
  source: string;
  target: string;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface HealthReport {
  score: number;
  grade: Grade;
  metrics: {
    files: number;
    lines: number;
    testFiles: number;
    testRatio: number;
    todoCount: number;
    avgFileLines: number;
    largeFiles: number;
    longFunctions: number;
    secretsFound: number;
  };
  findings: Finding[];
}

export interface SearchResult {
  path: string;
  line: number;
  snippet: string;
  score: number;
}

export interface Citation {
  path: string;
  line: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  ts: string;
}

export interface ChatThread {
  threadId: string;
  messages: ChatMessage[];
}

export interface ChatSummary {
  threadId: string;
  title: string;
  updatedAt: string;
}

export type TaskKind = 'feature' | 'bugfix' | 'refactor' | 'tests' | 'review' | 'explain';
export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface PullRequestInfo {
  url: string;
  number: number;
  branch: string;
}

export interface Task {
  id: string;
  repoId: string;
  kind: TaskKind;
  title: string;
  description: string;
  status: TaskStatus;
  runId: string;
  summary?: string;
  error?: string;
  usage: Usage;
  risk?: Risk;
  pr?: PullRequestInfo;
  issue?: { number: number; url: string };
  ci?: { runId: number; url: string };
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface CreateTaskInput {
  kind: TaskKind;
  title: string;
  description: string;
  autoApprove?: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  files: string[];
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface ApprovalRecord {
  approvalId: string;
  taskId: string;
  kind: 'plan' | 'changes';
  status: 'pending' | 'approved' | 'rejected';
  summary: string;
  payload: Record<string, unknown>;
  feedback?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject';
  feedback?: string;
  editedPlan?: PlanStep[];
}

export interface CreatePrInput {
  title?: string;
  body?: string;
  draft?: boolean;
  branch?: string;
}

export type NodeName = 'classify' | 'plan' | 'implement' | 'test' | 'fix' | 'review' | 'pr_draft';

export interface RunEventBase<T extends string, D> {
  seq: number;
  type: T;
  ts: string;
  data: D;
}

export interface Approval {
  approvalId: string;
  kind: 'plan' | 'changes';
  summary: string;
  payload: Record<string, unknown>;
}

export type RunEvent =
  | RunEventBase<'run.started', { kind: TaskKind; title: string; provider: string; model: string; sandbox: string }>
  | RunEventBase<'node.started' | 'node.finished', { node: NodeName }>
  | RunEventBase<'log', { level: 'info' | 'warn' | 'error'; message: string }>
  | RunEventBase<'plan.proposed', { steps: PlanStep[]; summary: string; risk: Risk; requirements?: string[]; design?: string }>
  | RunEventBase<'approval.requested', Approval>
  | RunEventBase<'approval.resolved', { approvalId: string; decision: 'approve' | 'reject'; feedback?: string }>
  | RunEventBase<'tool.call', { name: string; args: Record<string, unknown> }>
  | RunEventBase<'tool.result', { name: string; ok: boolean; summary: string }>
  | RunEventBase<'file.changed', { path: string; additions: number; deletions: number }>
  | RunEventBase<'diff.ready', { files: DiffFile[]; risk: Risk }>
  | RunEventBase<'tests.started', { command: string; sandbox: string }>
  | RunEventBase<
      'tests.result',
      { passed: number; failed: number; total: number; ok: boolean; output: string; durationMs: number; sandbox: string; framework: string }
    >
  | RunEventBase<'review.result', { summary: string; risk: Risk; comments: ReviewComment[] }>
  | RunEventBase<'usage', Usage>
  | RunEventBase<'pr.draft', { title: string; body: string; branch: string }>
  | RunEventBase<'run.completed', { status: 'completed'; summary: string }>
  | RunEventBase<'run.failed', { error: string }>
  | RunEventBase<'run.cancelled', Record<string, never>>;

export type RunEventType = RunEvent['type'];

export interface TaskDetail {
  task: Task;
  events: RunEvent[];
  approvals: ApprovalRecord[];
}

export interface TaskPage {
  items: Task[];
  nextCursor: string | null;
}

export interface Stats {
  repos: number;
  tasks: { total: number; byStatus: Record<string, number> };
  successRate: number;
  usage: Usage;
  daily: { date: string; tasks: number; costUsd: number }[];
  recent: Task[];
  byKind: Record<string, { count: number; completed: number; failed: number; costUsd: number }>;
  avgDurationSec: number;
}

export interface ActivityItem { taskId: string; taskTitle: string; seq: number; type: string; ts: string; data: Record<string, unknown> }

export interface AuditEntry {
  id: string;
  action: string;
  target: string;
  meta: Record<string, unknown>;
  ts: string;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

export interface ApiHealth {
  status: 'ok';
  db: 'mongo' | 'memory';
  redis: boolean;
  agent: boolean;
  uptimeSec: number;
}

export interface TaskDiff {
  diff: string;
  files: DiffFile[];
}

export type ServerMessage =
  | { type: 'hello'; userId: string }
  | { type: 'event'; taskId: string; event: RunEvent }
  | { type: 'task.updated'; task: Task }
  | { type: 'repo.updated'; repo: Repo }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'subscribe'; taskId: string }
  | { type: 'unsubscribe'; taskId: string }
  | { type: 'ping' };

export interface SecurityReport {
  score: number;
  grade: Grade;
  counts: Partial<Record<Severity, number>>;
  dependencies: Record<string, number>;
  findings: Finding[];
  summary: string;
  usage: Usage;
}

export interface RepoIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  author: string;
  updatedAt: string;
  kind: TaskKind;
  taskId?: string;
}

export interface MemoryNote {
  id: string;
  text: string;
  source: 'manual' | 'feedback' | 'outcome';
  createdAt: string;
}

// ---- code intelligence, reviews, CI, platform ----
export interface SemanticHit { path: string; line: number; endLine: number | null; score: number; snippet: string; symbol: string | null }
export interface SemanticResult {
  reranker?: string; mode: string; embedder: string; results: SemanticHit[] }
export interface SymbolItem { name: string; kind: string; path: string; line: number; endLine: number; complexity?: number }
export interface SymbolsResult { engine: string; symbols: SymbolItem[] }
export interface ImpactResult {
  engine: string; target: string; exists: boolean; direct: string[]; transitive: string[]; tests: string[];
  symbolCallers: { path: string; symbol: string }[]; risk: 'low' | 'medium' | 'high'; summary: string;
}
export interface PrReviewComment { path: string; line: number; severity: string; body: string; suggestion?: string }
export interface PrReview {
  id: string; repoId: string; number: number; title: string; url?: string; summary: string;
  verdict: 'approve' | 'comment' | 'request_changes'; riskScore: 'low' | 'medium' | 'high'; comments: PrReviewComment[];
  stats?: { files: number; additions: number; deletions: number }; posted: boolean; postedUrl?: string; trigger: 'manual' | 'webhook'; createdAt: string;
}
export interface CiItem {
  run: { id: number; name: string; branch: string; url: string; conclusion: string | null; createdAt: string };
  handled?: { taskId?: string; summary: string };
}
export interface BudgetStatus { budgetUsd: number | null; spentUsd: number; remainingUsd: number | null; monthStart: string }
export interface NotifySettings { slack: boolean; discord: boolean; events: string[] }
export interface LlmCheck { ok: boolean; provider: string; model: string; error?: string }
export interface BenchStatus { status: 'idle' | 'running' | 'done' | 'error'; done: number; total: number; current: string; error: string; startedAt: number | null; finishedAt: number | null }
export interface BenchTask { id: string; kind: string; language: string; verified: boolean; status: string; seconds: number; input_tokens: number; output_tokens: number; cost_usd: number; tests_passed?: number; tests_failed?: number; error?: string }
export interface BenchResult {
  available: boolean;
  meta?: { provider: string; model: string; sandbox: string; date: string; note: string };
  summary?: { tasks: number; ran: number; skipped: number; solved: number; pass_at_1: number; input_tokens: number; output_tokens: number; cost_usd: number; seconds_total: number; seconds_mean: number };
  tasks?: BenchTask[];
}

export interface McpTool { name: string; description: string; readOnly: boolean }
export interface McpServer {
  id: string; name: string; transport: 'stdio' | 'http'; command: string; args: string[]; url: string;
  secretKeys: string[]; enabled: boolean; tools: McpTool[]; createdAt: string;
  lastCheck: { ok: boolean; at: string; error?: string } | null;
}
export interface McpInput { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; secrets?: Record<string, string> }
