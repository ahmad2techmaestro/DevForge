import { createHmac } from 'node:crypto';
import type { GithubClient, GithubIssue } from '../integrations/github.js';
import type { Config } from '../config/env.js';
import { safeEqual } from '../utils/crypto.js';
import type { RepoDoc, TaskDoc, TaskKind } from '../models/domain.js';
import { AppError, conflict } from '../utils/errors.js';
import type { Store } from '../database/index.js';
import type { AuditService } from './audit.js';
import type { AccountService } from './auth.js';
import type { RepoService } from './repos.js';
import type { TaskService } from './tasks.js';

/** Picks the task type from issue labels, falling back to the title wording. */
export function kindFromIssue(labels: string[], title: string): TaskKind {
  const l = labels.map((x) => x.toLowerCase());
  const has = (...words: string[]) => l.some((x) => words.some((w) => x.includes(w)));
  if (has('bug', 'defect', 'regression')) return 'bugfix';
  if (has('test')) return 'tests';
  if (has('refactor', 'tech-debt', 'cleanup')) return 'refactor';
  if (has('question', 'docs', 'documentation')) return 'explain';
  if (has('enhancement', 'feature')) return 'feature';
  const t = title.toLowerCase();
  if (/\b(fix|bug|crash|error|broken|fails?)\b/.test(t)) return 'bugfix';
  if (/\b(refactor|clean ?up)\b/.test(t)) return 'refactor';
  if (/\b(test|coverage)\b/.test(t)) return 'tests';
  return 'feature';
}

export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return safeEqual(header, expected);
}

interface WebhookPayload {
  action?: string;
  label?: { name?: string };
  issue?: { number: number; title: string; body: string | null; html_url: string; labels?: { name?: string }[]; pull_request?: unknown };
  repository?: { full_name?: string };
}

export class IssueService {
  constructor(
    private readonly store: Store,
    private readonly github: GithubClient,
    private readonly account: AccountService,
    private readonly repos: RepoService,
    private readonly tasks: TaskService,
    private readonly audit: AuditService,
    private readonly config: Pick<Config, 'githubWebhookSecret' | 'webhookLabel'>,
  ) {}

  private async githubRepo(userId: string, repoId: string): Promise<RepoDoc & { fullName: string }> {
    const repo = await this.repos.get(userId, repoId);
    if (!repo.fullName) throw conflict('not_github_repo', 'Issues need a GitHub repository (owner/name)');
    return repo as RepoDoc & { fullName: string };
  }

  async list(userId: string, repoId: string): Promise<(GithubIssue & { kind: TaskKind; taskId?: string })[]> {
    const repo = await this.githubRepo(userId, repoId);
    const token = await this.account.requireToken(userId);
    const issues = await this.github.listIssues(token, repo.fullName);
    const existing = await this.store.find<TaskDoc>('tasks', { userId, repoId });
    const byIssue = new Map(existing.filter((t) => t.issue).map((t) => [t.issue!.number, t.id]));
    return issues.map((i) => ({ ...i, kind: kindFromIssue(i.labels, i.title), taskId: byIssue.get(i.number) }));
  }

  /** Starts an agent task from an issue. The human approval gates still apply. */
  async run(userId: string, repoId: string, number: number): Promise<TaskDoc> {
    const repo = await this.githubRepo(userId, repoId);
    const token = await this.account.requireToken(userId);
    const issue = await this.github.getIssue(token, repo.fullName, number);
    return this.start(userId, repo, issue.number, issue.title, issue.body, issue.url, issue.labels);
  }

  private async start(userId: string, repo: RepoDoc, number: number, title: string, body: string, url: string, labels: string[]): Promise<TaskDoc> {
    const dup = await this.store.find<TaskDoc>('tasks', { userId, repoId: repo.id });
    if (dup.some((t) => t.issue?.number === number && !['failed', 'cancelled'].includes(t.status))) {
      throw conflict('issue_already_running', `Issue #${number} already has an active or completed task`);
    }
    const description = `Resolve GitHub issue #${number}: ${title}\n${url}\n\n${body.slice(0, 6000) || '(no description)'}`;
    const task = await this.tasks.create(userId, repo.id, {
      kind: kindFromIssue(labels, title),
      title: `#${number} ${title}`.slice(0, 200),
      description,
      autoApprove: false,
      issue: { number, url },
    });
    await this.audit.record(userId, 'issue.run', task.id, { repoId: repo.id, issue: number });
    return task;
  }

  /**
   * GitHub webhook: an issue labelled with the trigger label starts a task on the matching connected repo.
   * Returns what happened so the route can answer 202/200 without leaking internals.
   */
  async handleWebhook(event: string | undefined, raw: Buffer, signature: string | undefined, body: unknown): Promise<{ status: 'ignored' | 'started'; taskIds?: string[]; reason?: string }> {
    const secret = this.config.githubWebhookSecret;
    if (!secret) throw new AppError(404, 'webhooks_disabled', 'Webhooks are not enabled');
    if (!verifySignature(secret, raw, signature)) throw new AppError(401, 'bad_signature', 'Invalid webhook signature');
    if (event === 'ping') return { status: 'ignored', reason: 'ping' };
    const p = body as WebhookPayload;
    if (event !== 'issues' || p.action !== 'labeled' || p.label?.name !== this.config.webhookLabel) {
      return { status: 'ignored', reason: 'not a trigger event' };
    }
    if (!p.issue || p.issue.pull_request || !p.repository?.full_name) return { status: 'ignored', reason: 'not an issue' };
    const repos = await this.store.find<RepoDoc>('repos', { fullName: p.repository.full_name, status: 'ready' });
    if (repos.length === 0) return { status: 'ignored', reason: 'repository not connected' };
    const labels = (p.issue.labels ?? []).map((l) => l.name ?? '').filter(Boolean);
    // Every user who connected this repository gets a task (each one still has to approve it).
    const taskIds: string[] = [];
    for (const repo of repos) {
      try {
        const task = await this.start(repo.userId, repo, p.issue.number, p.issue.title, p.issue.body ?? '', p.issue.html_url, labels);
        taskIds.push(task.id);
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'issue_already_running')) throw err;
      }
    }
    return taskIds.length > 0 ? { status: 'started', taskIds } : { status: 'ignored', reason: 'already running' };
  }
}
