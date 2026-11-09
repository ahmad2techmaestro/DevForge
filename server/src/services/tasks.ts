import { randomUUID } from 'node:crypto';
import type { AgentClient } from '../integrations/aiService.js';
import type { GithubClient } from '../integrations/github.js';
import type { Config } from '../config/env.js';
import {
  TERMINAL_STATUSES,
  UsageSchema,
  RiskSchema,
  emptyUsage,
  now,
  type ApprovalDoc,
  type ApprovalKind,
  type EventDoc,
  type RepoDoc,
  type RunEvent,
  type TaskDoc,
  type TaskKind,
  type TaskStatus,
} from '../models/domain.js';
import { AppError, DuplicateKeyError, conflict, notFound } from '../utils/errors.js';
import type { Logger } from '../config/logger.js';
import { toTask } from '../models/mappers.js';
import { taskChannel, userChannel, type Bus } from '../realtime/bus.js';
import type { Store } from '../database/index.js';
import type { AuditService } from './audit.js';
import type { AccountService } from './auth.js';
import type { BudgetService } from './budget.js';
import type { MemoryService } from './memory.js';
import type { McpService } from './mcp.js';
import type { NotifyService } from './notify.js';
import type { RepoService } from './repos.js';

export interface RunDispatcher {
  enqueue(taskId: string): Promise<void>;
  remove(taskId: string): Promise<void>;
}

const isTerminal = (s: TaskStatus): boolean => TERMINAL_STATUSES.includes(s);
const CHANGE_KINDS: readonly TaskKind[] = ['feature', 'bugfix', 'refactor', 'tests'];

export interface CreateTaskInput {
  kind: TaskKind;
  title: string;
  description: string;
  autoApprove?: boolean;
  issue?: { number: number; url: string };
  ci?: { runId: number; url: string };
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject';
  feedback?: string;
  editedPlan?: unknown[];
}

export class TaskService {
  private dispatcher: RunDispatcher | null = null;
  private memory: MemoryService | null = null;
  private mcp: McpService | null = null;
  private budget: BudgetService | null = null;
  private notify: NotifyService | null = null;

  constructor(
    private readonly store: Store,
    private readonly agent: AgentClient,
    private readonly github: GithubClient,
    private readonly bus: Bus,
    private readonly repos: RepoService,
    private readonly account: AccountService,
    private readonly audit: AuditService,
    private readonly config: Pick<Config, 'apiPublicUrl'>,
    private readonly log: Logger,
  ) {}

  attachDispatcher(dispatcher: RunDispatcher): void {
    this.dispatcher = dispatcher;
  }

  attachMcp(mcp: McpService): void {
    this.mcp = mcp;
  }

  attachMemory(memory: MemoryService): void {
    this.memory = memory;
  }

  attachBudget(budget: BudgetService): void {
    this.budget = budget;
  }

  attachNotify(notify: NotifyService): void {
    this.notify = notify;
  }

  // ---- queries ----

  async get(userId: string, id: string): Promise<TaskDoc> {
    const task = await this.store.findOne<TaskDoc>('tasks', { id, userId });
    if (!task) throw notFound('Task');
    return task;
  }

  async list(
    userId: string,
    filter: { repoId?: string; status?: TaskStatus },
    limit: number,
    offset: number,
  ): Promise<{ items: TaskDoc[]; nextCursor: string | null }> {
    const rows = await this.store.find<TaskDoc>(
      'tasks',
      { userId, ...(filter.repoId ? { repoId: filter.repoId } : {}), ...(filter.status ? { status: filter.status } : {}) },
      { sort: { createdAt: -1 }, skip: offset, limit: limit + 1 },
    );
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(offset + limit) : null };
  }

  async detail(userId: string, id: string): Promise<{ task: TaskDoc; events: RunEvent[]; approvals: ApprovalDoc[] }> {
    const task = await this.get(userId, id);
    const events = await this.store.find<EventDoc>('events', { taskId: id }, { sort: { seq: 1 } });
    const approvals = await this.store.find<ApprovalDoc>('approvals', { taskId: id }, { sort: { createdAt: 1 } });
    return { task, events: events.map(({ seq, type, ts, data }) => ({ seq, type, ts, data })), approvals };
  }

  // ---- commands ----

  async create(userId: string, repoId: string, input: CreateTaskInput): Promise<TaskDoc> {
    await this.repos.ready(userId, repoId);
    await this.budget?.assertWithinBudget(userId);
    const ts = now();
    const task: TaskDoc = {
      id: randomUUID(),
      userId,
      repoId,
      kind: input.kind,
      title: input.title.trim(),
      description: input.description.trim(),
      status: 'queued',
      runId: randomUUID(),
      usage: emptyUsage(),
      autoApprove: input.autoApprove ?? false,
      ...(input.issue ? { issue: input.issue } : {}),
      ...(input.ci ? { ci: input.ci } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.store.insertOne('tasks', task);
    await this.audit.record(userId, 'task.create', task.id, { kind: task.kind, repoId, autoApprove: task.autoApprove });
    await this.publishTask(task);
    try {
      await this.requireDispatcher().enqueue(task.id);
    } catch (err) {
      await this.fail(task.id, 'Could not queue the task');
      throw err;
    }
    return task;
  }

  /** Called by the queue worker. Throws on failure so the queue can retry. */
  async dispatch(taskId: string): Promise<void> {
    const task = await this.store.findOne<TaskDoc>('tasks', { id: taskId });
    if (!task || task.status !== 'queued') return;
    const repo = await this.store.findOne<RepoDoc>('repos', { id: task.repoId });
    if (!repo) {
      await this.fail(taskId, 'Repository no longer exists');
      return;
    }
    await this.agent.createRun({
      runId: task.runId,
      taskId: task.id,
      repoId: repo.id,
      task: { kind: task.kind, title: task.title, description: task.description },
      callbackUrl: `${this.config.apiPublicUrl}/internal/runs/${task.runId}/events`,
      options: { autoApprove: task.autoApprove },
      memory: (await this.memory?.forRun(task.userId, task.repoId)) ?? [],
      mcpServers: (await this.mcp?.forRun(task.userId).catch(() => [])) ?? [],
    });
  }

  async fail(taskId: string, error: string): Promise<void> {
    const task = await this.store.findOne<TaskDoc>('tasks', { id: taskId });
    if (!task || isTerminal(task.status)) return;
    const ts = now();
    await this.store.updateOne('tasks', { id: taskId }, { $set: { status: 'failed', error, updatedAt: ts, finishedAt: ts } });
    await this.publishById(taskId);
  }

  async cancel(userId: string, id: string): Promise<TaskDoc> {
    const task = await this.get(userId, id);
    if (isTerminal(task.status)) throw conflict('task_finished', `Task is already ${task.status}`);
    if (task.status === 'queued') {
      await this.dispatcher?.remove(id).catch(() => undefined);
    } else {
      await this.agent.cancel(task.runId);
    }
    const ts = now();
    await this.store.updateOne('tasks', { id }, { $set: { status: 'cancelled', updatedAt: ts, finishedAt: ts } });
    await this.audit.record(userId, 'task.cancel', id);
    return this.publishById(id);
  }

  async decide(userId: string, taskId: string, approvalId: string, input: ApprovalDecision): Promise<{ task: TaskDoc; approval: ApprovalDoc }> {
    const task = await this.get(userId, taskId);
    const approval = await this.store.findOne<ApprovalDoc>('approvals', { taskId, approvalId });
    if (!approval) throw notFound('Approval');
    if (approval.status !== 'pending') throw conflict('approval_not_pending', `Approval is already ${approval.status}`);
    if (isTerminal(task.status)) throw conflict('task_finished', `Task is already ${task.status}`);
    await this.agent.approve(task.runId, {
      approvalId,
      decision: input.decision,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      ...(input.editedPlan ? { editedPlan: input.editedPlan } : {}),
    });
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    await this.store.updateOne(
      'approvals',
      { taskId, approvalId },
      { $set: { status, resolvedAt: now(), ...(input.feedback ? { feedback: input.feedback } : {}) } },
    );
    await this.audit.record(userId, `approval.${status}`, taskId, { approvalId, kind: approval.kind });
    if (input.decision === 'reject' && input.feedback?.trim()) {
      await this.memory?.add(userId, task.repoId, `Feedback on "${task.title}": ${input.feedback}`, 'feedback').catch(() => undefined);
    }
    const updated = (await this.store.findOne<ApprovalDoc>('approvals', { taskId, approvalId })) as ApprovalDoc;
    return { task: await this.get(userId, taskId), approval: updated };
  }

  // ---- pull request ----

  async createPr(
    userId: string,
    id: string,
    input: { title?: string; body?: string; draft?: boolean; branch?: string },
  ): Promise<{ task: TaskDoc; pr: NonNullable<TaskDoc['pr']> }> {
    const task = await this.get(userId, id);
    const repo = await this.repos.get(userId, task.repoId);
    if (task.status !== 'completed') throw conflict('task_not_completed', 'The task must be completed first');
    if (!CHANGE_KINDS.includes(task.kind)) throw conflict('no_changes', `A ${task.kind} task does not produce code changes`);
    if (task.pr) throw conflict('pr_exists', 'A pull request was already created for this task');
    const approvals = await this.store.find<ApprovalDoc>('approvals', { taskId: id, kind: 'changes' as ApprovalKind });
    if (!approvals.some((a) => a.status === 'approved')) throw conflict('changes_not_approved', 'The changes have not been approved');
    if (!repo.fullName) throw conflict('not_github_repo', 'Pull requests need a GitHub repository (owner/name)');
    const token = await this.account.requireToken(userId);

    const claimed = await this.store.updateOne('tasks', { id, prInProgress: { $ne: true }, pr: { $exists: false } }, { $set: { prInProgress: true } });
    if (!claimed) throw conflict('pr_in_progress', 'A pull request is already being created');
    try {
      const draft = task.prDraft;
      const branch = input.branch ?? draft?.branch ?? `devforge/${task.id.slice(0, 8)}`;
      const title = input.title?.trim() || draft?.title || task.title;
      const body = input.body ?? draft?.body ?? task.description;
      await this.agent.commit(task.runId, { branch, message: title });
      await this.agent.push(task.runId, { cloneUrl: repo.cloneUrl, branch, token });
      const created = await this.github.createPull(token, repo.fullName, { title, head: branch, base: repo.branch, body, draft: input.draft ?? true });
      const pr = { url: created.url, number: created.number, branch };
      await this.store.updateOne('tasks', { id }, { $set: { pr, updatedAt: now() }, $unset: { prInProgress: true } });
      await this.audit.record(userId, 'pr.create', id, { url: pr.url, number: pr.number, repo: repo.fullName });
      const fresh = await this.publishById(id);
      return { task: fresh, pr };
    } catch (err) {
      await this.store.updateOne('tasks', { id }, { $unset: { prInProgress: true } });
      throw err;
    }
  }

  // ---- ingest events from the agent ----

  async ingest(runId: string, event: RunEvent): Promise<{ duplicate: boolean }> {
    const task = await this.store.findOne<TaskDoc>('tasks', { runId });
    if (!task) throw notFound('Run');
    const doc: EventDoc = { ...event, id: randomUUID(), runId, taskId: task.id, userId: task.userId, receivedAt: now() };
    try {
      await this.store.insertOne('events', doc);
    } catch (err) {
      if (err instanceof DuplicateKeyError) return { duplicate: true };
      throw err;
    }
    await this.applyEvent(task, event);
    await this.bus.publish(taskChannel(task.id), { type: 'event', taskId: task.id, userId: task.userId, event });
    await this.publishById(task.id);
    return { duplicate: false };
  }

  private async applyEvent(task: TaskDoc, event: RunEvent): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: now() };
    const data = event.data;
    const live = !isTerminal(task.status);
    const finish = (status: TaskStatus): void => {
      if (!live) return;
      set.status = status;
      set.finishedAt = now();
    };
    switch (event.type) {
      case 'run.started':
        if (live) set.status = 'running';
        break;
      case 'approval.requested': {
        const kind = data.kind === 'changes' ? 'changes' : 'plan';
        const record: ApprovalDoc = {
          id: randomUUID(),
          taskId: task.id,
          userId: task.userId,
          approvalId: String(data.approvalId),
          kind,
          status: 'pending',
          summary: String(data.summary ?? ''),
          payload: (data.payload as Record<string, unknown>) ?? {},
          createdAt: event.ts,
        };
        await this.store.insertOne('approvals', record).catch((err: unknown) => {
          if (!(err instanceof DuplicateKeyError)) throw err;
        });
        if (live) set.status = 'awaiting_approval';
        break;
      }
      case 'approval.resolved': {
        const status = data.decision === 'approve' ? 'approved' : 'rejected';
        await this.store.updateOne(
          'approvals',
          { taskId: task.id, approvalId: String(data.approvalId), status: 'pending' },
          { $set: { status, resolvedAt: event.ts, ...(typeof data.feedback === 'string' ? { feedback: data.feedback } : {}) } },
        );
        if (live) set.status = 'running';
        break;
      }
      case 'usage': {
        const usage = UsageSchema.safeParse(data);
        if (usage.success) set.usage = usage.data;
        break;
      }
      case 'diff.ready':
      case 'review.result': {
        const risk = RiskSchema.safeParse(data.risk);
        if (risk.success) set.risk = risk.data;
        break;
      }
      case 'pr.draft':
        set.prDraft = { title: String(data.title ?? ''), body: String(data.body ?? ''), branch: String(data.branch ?? '') };
        break;
      case 'run.completed':
        finish('completed');
        if (typeof data.summary === 'string') set.summary = data.summary;
        if (live && CHANGE_KINDS.includes(task.kind)) {
          await this.memory?.add(task.userId, task.repoId, `Completed ${task.kind}: ${task.title}`, 'outcome').catch(() => undefined);
        }
        break;
      case 'run.failed':
        finish('failed');
        set.error = String(data.error ?? 'Run failed');
        break;
      case 'run.cancelled':
        finish('cancelled');
        break;
      default:
        break;
    }
    await this.store.updateOne('tasks', { id: task.id }, { $set: set });
    if (live && typeof set.status === 'string' && set.status !== task.status) this.notifyStatus(task, set.status as TaskStatus);
  }

  private notifyStatus(task: TaskDoc, status: TaskStatus): void {
    const path = `/tasks/${task.id}`;
    if (status === 'awaiting_approval') this.notify?.send(task.userId, 'task.awaiting_approval', `"${task.title}" is waiting for your approval.`, path);
    else if (status === 'completed') this.notify?.send(task.userId, 'task.completed', `"${task.title}" finished.`, path);
    else if (status === 'failed') this.notify?.send(task.userId, 'task.failed', `"${task.title}" failed.`, path);
  }

  // ---- helpers ----

  private requireDispatcher(): RunDispatcher {
    if (!this.dispatcher) throw new AppError(503, 'queue_unavailable', 'The run queue is not available');
    return this.dispatcher;
  }

  private async publishById(taskId: string): Promise<TaskDoc> {
    const task = (await this.store.findOne<TaskDoc>('tasks', { id: taskId })) as TaskDoc;
    await this.publishTask(task);
    return task;
  }

  private async publishTask(task: TaskDoc): Promise<void> {
    await this.bus.publish(userChannel(task.userId), { type: 'task.updated', task: toTask(task) });
  }
}
