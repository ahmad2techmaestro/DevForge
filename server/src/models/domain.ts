import { z } from 'zod';

export const TASK_STATUSES = ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'awaiting_approval'];

export const TASK_KINDS = ['feature', 'bugfix', 'refactor', 'tests', 'review', 'explain'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

export const RiskSchema = z.object({
  score: z.number(),
  level: z.enum(['low', 'medium', 'high']),
  reasons: z.array(z.string()),
});
export type Risk = z.infer<typeof RiskSchema>;

export interface PrInfo {
  url: string;
  number: number;
  branch: string;
}

// ---- stored documents (type aliases so they satisfy index-signature constraints) ----

export type UserDoc = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  github?: { tokenEnc: string; login: string; avatarUrl: string } | null;
  /** Monthly spend cap in USD for agent runs (null/undefined = unlimited). */
  budgetUsd?: number | null;
  /** Chat notifications. The webhook URLs are secrets and are stored encrypted. */
  notify?: { slackEnc?: string; discordEnc?: string; events: string[] } | null;
};

export type RepoSource = 'github' | 'url' | 'local';
export type RepoStatus = 'indexing' | 'ready' | 'error';

export type RepoDoc = {
  id: string;
  userId: string;
  name: string;
  fullName?: string;
  cloneUrl?: string;
  localPath?: string;
  source: RepoSource;
  branch: string;
  status: RepoStatus;
  error?: string | null;
  commit?: string;
  stats?: { fileCount: number; totalLines: number; languages: Record<string, { files: number; lines: number }> };
  summary?: string;
  health?: { score: number; grade: string };
  /** Per-repo automation toggles. */
  autoReview?: boolean;
  autoFixCi?: boolean;
  /** Accumulated usage of repo-level LLM calls (explain/bugs/chat). Internal. */
  usage?: Usage;
  indexingStartedAt?: string;
  createdAt: string;
  indexedAt?: string;
};

export type TaskDoc = {
  id: string;
  userId: string;
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
  pr?: PrInfo;
  prDraft?: { title: string; body: string; branch: string };
  prInProgress?: boolean;
  autoApprove: boolean;
  /** Set when the task was started from a GitHub issue. */
  issue?: { number: number; url: string };
  /** Set when the task was started from a failing CI run. */
  ci?: { runId: number; url: string };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type MemorySource = 'manual' | 'feedback' | 'outcome';

export type MemoryDoc = {
  id: string;
  userId: string;
  repoId: string;
  text: string;
  source: MemorySource;
  createdAt: string;
};

export type RunEvent = { seq: number; type: string; ts: string; data: Record<string, unknown> };

export type EventDoc = RunEvent & {
  id: string;
  runId: string;
  taskId: string;
  userId: string;
  receivedAt: string;
};

export type ApprovalKind = 'plan' | 'changes';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type ApprovalDoc = {
  id: string;
  taskId: string;
  userId: string;
  approvalId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  summary: string;
  payload: Record<string, unknown>;
  feedback?: string;
  createdAt: string;
  resolvedAt?: string;
};

export type Citation = { path: string; line: number };
export type ChatMessage = { role: 'user' | 'assistant'; content: string; citations?: Citation[]; ts: string };
export type ChatDoc = {
  id: string;
  repoId: string;
  userId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type AuditDoc = {
  id: string;
  userId: string;
  action: string;
  target: string;
  meta: Record<string, unknown>;
  ts: string;
};

export const now = (): string => new Date().toISOString();

export type ReviewComment = { path: string; line: number; side?: string; severity: string; body: string; suggestion?: string };

export type ReviewDoc = {
  id: string;
  userId: string;
  repoId: string;
  number: number;
  title: string;
  url?: string;
  summary: string;
  verdict: 'approve' | 'comment' | 'request_changes';
  riskScore: 'low' | 'medium' | 'high';
  comments: ReviewComment[];
  stats?: { files: number; additions: number; deletions: number };
  posted: boolean;
  postedUrl?: string;
  trigger: 'manual' | 'webhook';
  headSha?: string;
  createdAt: string;
};

export type CiRunDoc = {
  id: string;
  userId: string;
  repoId: string;
  runId: number;
  name: string;
  branch: string;
  url: string;
  failureKind: string;
  summary: string;
  failingTests: string[];
  taskId?: string;
  trigger: 'manual' | 'webhook';
  createdAt: string;
};

export type McpServerDoc = {
  id: string;
  userId: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  /** JSON of env (stdio) or headers (http), encrypted. Never returned to the browser. */
  secretsEnc?: string;
  secretKeys: string[];
  enabled: boolean;
  tools?: { name: string; description: string; readOnly: boolean }[];
  lastCheck?: { ok: boolean; at: string; error?: string };
  createdAt: string;
};
