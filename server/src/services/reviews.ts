import { randomUUID } from 'node:crypto';
import type { AgentClient } from '../integrations/aiService.js';
import type { GithubClient } from '../integrations/github.js';
import type { Store } from '../database/index.js';
import { now, type RepoDoc, type ReviewComment, type ReviewDoc } from '../models/domain.js';
import { AppError, conflict } from '../utils/errors.js';
import type { AuditService } from './audit.js';
import type { AccountService } from './auth.js';
import type { NotifyService } from './notify.js';
import type { RepoService } from './repos.js';

interface AgentReview {
  summary: string;
  verdict: ReviewDoc['verdict'];
  riskScore: ReviewDoc['riskScore'];
  comments: ReviewComment[];
  stats?: ReviewDoc['stats'];
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

const ICON: Record<string, string> = { high: '🔴', medium: '🟠', low: '🟡', info: '🔵' };

/** AI review of GitHub pull requests: fetches the diff, reviews it, and (optionally) posts inline comments. */
export class ReviewService {
  constructor(
    private readonly store: Store,
    private readonly agent: AgentClient,
    private readonly github: GithubClient,
    private readonly account: AccountService,
    private readonly repos: RepoService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  list(userId: string, repoId: string): Promise<ReviewDoc[]> {
    return this.store.find<ReviewDoc>('reviews', { userId, repoId }, { sort: { createdAt: -1 }, limit: 50 });
  }

  private async githubRepo(userId: string, repoId: string): Promise<RepoDoc & { fullName: string }> {
    const repo = await this.repos.ready(userId, repoId);
    if (!repo.fullName) throw conflict('not_github_repo', 'Pull request reviews need a GitHub repository (owner/name)');
    return repo as RepoDoc & { fullName: string };
  }

  async review(userId: string, repoId: string, number: number, opts: { post: boolean; trigger: 'manual' | 'webhook' }): Promise<ReviewDoc> {
    const repo = await this.githubRepo(userId, repoId);
    const token = await this.account.requireToken(userId);
    const [pull, diff] = await Promise.all([this.github.getPull(token, repo.fullName, number), this.github.getPullDiff(token, repo.fullName, number)]);
    if (!diff.trim()) throw new AppError(422, 'empty_diff', 'This pull request has no changes to review');
    const out = (await this.agent.reviewPr({ title: pull.title, description: pull.body.slice(0, 6000), diff, repoId, baseRef: pull.baseRef, headRef: pull.headRef })) as unknown as AgentReview;
    await this.repos.recordUsage(repoId, out.usage);
    const doc: ReviewDoc = {
      id: randomUUID(), userId, repoId, number, title: pull.title, url: pull.url, summary: out.summary,
      verdict: out.verdict, riskScore: out.riskScore, comments: out.comments ?? [], ...(out.stats ? { stats: out.stats } : {}),
      posted: false, trigger: opts.trigger, headSha: pull.headSha, createdAt: now(),
    };
    if (opts.post) {
      const posted = await this.post(token, repo.fullName, number, doc);
      doc.posted = true;
      doc.postedUrl = posted;
      this.notify.send(userId, 'review.posted', `DevForge reviewed ${repo.fullName}#${number} "${pull.title}": ${doc.verdict.replace('_', ' ')}, risk ${doc.riskScore}.`, `/repos/${repoId}/reviews`);
    }
    await this.store.insertOne('reviews', doc);
    await this.audit.record(userId, 'review.create', `${repo.fullName}#${number}`, { posted: doc.posted, trigger: opts.trigger });
    return doc;
  }

  /** Always posts as a COMMENT review: a bot must not approve or block merges on its own. */
  private async post(token: string, fullName: string, number: number, doc: ReviewDoc): Promise<string> {
    const inline = doc.comments.slice(0, 30).map((c) => ({
      path: c.path, line: c.line, side: 'RIGHT' as const,
      body: `${ICON[c.severity] ?? '🔵'} **${c.severity}**: ${c.body}${c.suggestion ? `\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\`` : ''}`,
    }));
    const body = `### DevForge review\n\n${doc.summary}\n\n**Verdict:** ${doc.verdict.replace('_', ' ')} · **Risk:** ${doc.riskScore}\n\n_Automated review. A human should make the final call._`;
    try {
      return (await this.github.createReview(token, fullName, number, { body, event: 'COMMENT', commitId: doc.headSha, comments: inline })).url;
    } catch (err) {
      if (!(err instanceof AppError) || err.status !== 422 || inline.length === 0) throw err;
      // GitHub rejected an inline position: fall back to one summary comment listing every finding.
      const list = doc.comments.map((c) => `- \`${c.path}:${c.line}\` ${ICON[c.severity] ?? ''} ${c.body}`).join('\n');
      return (await this.github.createReview(token, fullName, number, { body: `${body}\n\n${list}`, event: 'COMMENT', commitId: doc.headSha, comments: [] })).url;
    }
  }

  async handlePullRequest(action: string | undefined, payload: { number?: number; fullName?: string; draft?: boolean }): Promise<{ status: 'ignored' | 'reviewed'; reviewIds?: string[]; reason?: string }> {
    if (!['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action ?? '')) return { status: 'ignored', reason: 'not a review trigger' };
    if (!payload.number || !payload.fullName) return { status: 'ignored', reason: 'malformed payload' };
    if (payload.draft) return { status: 'ignored', reason: 'draft pull request' };
    const repos = await this.store.find<RepoDoc>('repos', { fullName: payload.fullName, status: 'ready', autoReview: true });
    if (repos.length === 0) return { status: 'ignored', reason: 'auto review is off or repository not connected' };
    const ids: string[] = [];
    for (const repo of repos) {
      try {
        ids.push((await this.review(repo.userId, repo.id, payload.number, { post: true, trigger: 'webhook' })).id);
      } catch {
        // one owner's failure (token, quota) must not block the others
      }
    }
    return ids.length ? { status: 'reviewed', reviewIds: ids } : { status: 'ignored', reason: 'review failed' };
  }
}
