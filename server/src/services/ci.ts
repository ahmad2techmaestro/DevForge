import { randomUUID } from 'node:crypto';
import type { AgentClient } from '../integrations/aiService.js';
import type { GithubClient, GithubWorkflowRun } from '../integrations/github.js';
import type { Store } from '../database/index.js';
import { now, type CiRunDoc, type RepoDoc, type TaskDoc } from '../models/domain.js';
import { conflict } from '../utils/errors.js';
import type { AuditService } from './audit.js';
import type { AccountService } from './auth.js';
import type { NotifyService } from './notify.js';
import type { RepoService } from './repos.js';
import type { TaskService } from './tasks.js';

interface CiAnalysis {
  summary: string;
  failureKind: string;
  failingTests: string[];
  suggestedTask?: { title: string; description: string };
}

/** CI-failure autopilot: reads the failing job logs, summarises the cause and opens a bug-fix task. */
export class CiService {
  constructor(
    private readonly store: Store,
    private readonly agent: AgentClient,
    private readonly github: GithubClient,
    private readonly account: AccountService,
    private readonly repos: RepoService,
    private readonly tasks: TaskService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  private async githubRepo(userId: string, repoId: string): Promise<RepoDoc & { fullName: string }> {
    const repo = await this.repos.ready(userId, repoId);
    if (!repo.fullName) throw conflict('not_github_repo', 'CI integration needs a GitHub repository (owner/name)');
    return repo as RepoDoc & { fullName: string };
  }

  async list(userId: string, repoId: string): Promise<{ run: GithubWorkflowRun; handled?: { taskId?: string; summary: string } }[]> {
    const repo = await this.githubRepo(userId, repoId);
    const token = await this.account.requireToken(userId);
    const runs = await this.github.listWorkflowRuns(token, repo.fullName);
    const done = await this.store.find<CiRunDoc>('ciruns', { userId, repoId });
    const byRun = new Map(done.map((d) => [d.runId, d]));
    return runs.map((run) => {
      const d = byRun.get(run.id);
      return { run, ...(d ? { handled: { ...(d.taskId ? { taskId: d.taskId } : {}), summary: d.summary } } : {}) };
    });
  }

  async fix(userId: string, repoId: string, runId: number, trigger: 'manual' | 'webhook' = 'manual'): Promise<CiRunDoc> {
    const repo = await this.githubRepo(userId, repoId);
    const token = await this.account.requireToken(userId);
    const existing = await this.store.findOne<CiRunDoc>('ciruns', { userId, repoId, runId });
    if (existing) throw conflict('ci_run_handled', `Run ${runId} already has an analysis${existing.taskId ? ' and a task' : ''}`);
    const run = await this.github.getWorkflowRun(token, repo.fullName, runId);
    const log = await this.github.getFailedJobLogs(token, repo.fullName, runId);
    const a = (await this.agent.analyzeCi({ log: log || `Workflow ${run.name} failed with no job logs.`, workflow: run.name })) as unknown as CiAnalysis;
    const doc: CiRunDoc = {
      id: randomUUID(), userId, repoId, runId, name: run.name, branch: run.branch, url: run.url, failureKind: a.failureKind,
      summary: a.summary, failingTests: a.failingTests ?? [], trigger, createdAt: now(),
    };
    const t = a.suggestedTask ?? { title: `Fix failing CI: ${run.name}`, description: a.summary };
    const task: TaskDoc = await this.tasks.create(userId, repoId, {
      kind: 'bugfix',
      title: t.title.slice(0, 200),
      description: `${t.description}\n\nFailing workflow run: ${run.url}\nBranch: ${run.branch}\n\nCI summary:\n${a.summary}`.slice(0, 8000),
      autoApprove: false,
      ci: { runId, url: run.url },
    });
    doc.taskId = task.id;
    await this.store.insertOne('ciruns', doc);
    await this.audit.record(userId, 'ci.fix', String(runId), { repoId, trigger });
    this.notify.send(userId, 'ci.failure', `CI failed on ${repo.fullName} (${run.name}). DevForge drafted a fix task: ${t.title}`, `/tasks/${task.id}`);
    return doc;
  }

  async handleWorkflowRun(payload: { action?: string; conclusion?: string | null; runId?: number; fullName?: string; branch?: string }): Promise<{ status: 'ignored' | 'started'; taskIds?: string[]; reason?: string }> {
    if (payload.action !== 'completed' || payload.conclusion !== 'failure' || !payload.runId || !payload.fullName) return { status: 'ignored', reason: 'not a failed run' };
    const repos = await this.store.find<RepoDoc>('repos', { fullName: payload.fullName, status: 'ready', autoFixCi: true });
    const taskIds: string[] = [];
    for (const repo of repos) {
      if (payload.branch && payload.branch !== repo.branch) continue; // only the default branch, to avoid fix loops on bot branches
      try {
        const d = await this.fix(repo.userId, repo.id, payload.runId, 'webhook');
        if (d.taskId) taskIds.push(d.taskId);
      } catch {
        // already handled, token missing, budget reached...
      }
    }
    return taskIds.length ? { status: 'started', taskIds } : { status: 'ignored', reason: 'auto fix is off, branch not tracked, or already handled' };
  }
}
