import type { McpServerDoc, ApprovalDoc, AuditDoc, EventDoc, MemoryDoc, RepoDoc, RunEvent, TaskDoc, UserDoc } from './domain.js';

/** Public (API) shapes. Anything not listed here (passwordHash, tokenEnc, userId, ...) is never returned. */
export const toUser = (u: UserDoc) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt });

export const toRepo = (r: RepoDoc) => ({
  id: r.id,
  name: r.name,
  ...(r.fullName ? { fullName: r.fullName } : {}),
  ...(r.cloneUrl ? { cloneUrl: r.cloneUrl } : {}),
  source: r.source,
  branch: r.branch,
  status: r.status,
  ...(r.error ? { error: r.error } : {}),
  ...(r.commit ? { commit: r.commit } : {}),
  ...(r.stats ? { stats: r.stats } : {}),
  ...(r.summary ? { summary: r.summary } : {}),
  ...(r.health ? { health: r.health } : {}),
  autoReview: !!r.autoReview,
  autoFixCi: !!r.autoFixCi,
  createdAt: r.createdAt,
  ...(r.indexedAt ? { indexedAt: r.indexedAt } : {}),
});
export type PublicRepo = ReturnType<typeof toRepo>;

export const toTask = (t: TaskDoc) => ({
  id: t.id,
  repoId: t.repoId,
  kind: t.kind,
  title: t.title,
  description: t.description,
  status: t.status,
  runId: t.runId,
  ...(t.summary ? { summary: t.summary } : {}),
  ...(t.error ? { error: t.error } : {}),
  usage: t.usage,
  ...(t.risk ? { risk: t.risk } : {}),
  ...(t.pr ? { pr: t.pr } : {}),
  ...(t.issue ? { issue: t.issue } : {}),
  ...(t.ci ? { ci: t.ci } : {}),
  autoApprove: t.autoApprove,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
});
export type PublicTask = ReturnType<typeof toTask>;

export const toApproval = (a: ApprovalDoc) => ({
  approvalId: a.approvalId,
  taskId: a.taskId,
  kind: a.kind,
  status: a.status,
  summary: a.summary,
  payload: a.payload,
  ...(a.feedback ? { feedback: a.feedback } : {}),
  createdAt: a.createdAt,
  ...(a.resolvedAt ? { resolvedAt: a.resolvedAt } : {}),
});

export const toRunEvent = (e: EventDoc): RunEvent => ({ seq: e.seq, type: e.type, ts: e.ts, data: e.data });

export const toAudit = (a: AuditDoc) => ({ id: a.id, action: a.action, target: a.target, meta: a.meta, ts: a.ts });

export const toMemory = (m: MemoryDoc) => ({ id: m.id, text: m.text, source: m.source, createdAt: m.createdAt });

export const toMcp = (m: McpServerDoc) => ({
  id: m.id, name: m.name, transport: m.transport, command: m.command, args: m.args, url: m.url,
  secretKeys: m.secretKeys, enabled: m.enabled, tools: m.tools ?? [], lastCheck: m.lastCheck ?? null, createdAt: m.createdAt,
});
