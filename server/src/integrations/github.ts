import type { Config } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export interface GithubUser {
  login: string;
  avatarUrl: string;
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

interface RawRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  language: string | null;
  updated_at: string;
  clone_url: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  author: string;
  updatedAt: string;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: (string | { name?: string })[];
  user: { login: string } | null;
  updated_at: string;
  pull_request?: unknown;
}

const toIssue = (i: RawIssue): GithubIssue => ({
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  url: i.html_url,
  labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
  author: i.user?.login ?? 'unknown',
  updatedAt: i.updated_at,
});

/** GitHub REST client. Tokens are passed per call and never stored or logged here. */
export class GithubClient {
  constructor(private readonly config: Pick<Config, 'githubApiUrl'>) {}

  private async request<T>(token: string, method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.githubApiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'devforge',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError(502, 'github_unreachable', 'GitHub could not be reached');
    }
    if (res.status === 401) throw new AppError(401, 'github_bad_token', 'GitHub rejected the token');
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { message?: string };
      const status = res.status >= 500 ? 502 : res.status === 403 ? 403 : res.status === 422 ? 422 : 400;
      throw new AppError(status, 'github_error', detail.message ?? `GitHub returned ${res.status}`);
    }
    if (accept !== 'application/vnd.github+json') return (await res.text()) as T;
    return (await res.json()) as T;
  }

  async getUser(token: string): Promise<GithubUser> {
    const u = await this.request<{ login: string; avatar_url: string }>(token, 'GET', '/user');
    return { login: u.login, avatarUrl: u.avatar_url };
  }

  async listRepos(token: string, query?: string): Promise<GithubRepo[]> {
    const raw = await this.request<RawRepo[]>(token, 'GET', '/user/repos?per_page=100&sort=updated');
    const q = query?.trim().toLowerCase();
    return raw
      .filter((r) => !q || r.full_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q))
      .map((r) => ({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        language: r.language,
        updatedAt: r.updated_at,
        cloneUrl: r.clone_url,
      }));
  }

  async listIssues(token: string, fullName: string): Promise<GithubIssue[]> {
    const raw = await this.request<RawIssue[]>(token, 'GET', `/repos/${fullName}/issues?state=open&per_page=50&sort=updated`);
    return raw.filter((i) => !i.pull_request).map(toIssue);
  }

  async getIssue(token: string, fullName: string, number: number): Promise<GithubIssue> {
    return toIssue(await this.request<RawIssue>(token, 'GET', `/repos/${fullName}/issues/${number}`));
  }

  async createPull(
    token: string,
    fullName: string,
    input: { title: string; head: string; base: string; body: string; draft: boolean },
  ): Promise<{ url: string; number: number }> {
    const pr = await this.request<{ html_url: string; number: number }>(token, 'POST', `/repos/${fullName}/pulls`, input);
    return { url: pr.html_url, number: pr.number };
  }

  async getPull(token: string, fullName: string, number: number): Promise<GithubPull> {
    const p = await this.request<{ number: number; title: string; body: string | null; html_url: string; head: { sha: string; ref: string }; base: { ref: string }; state: string; draft?: boolean }>(
      token, 'GET', `/repos/${fullName}/pulls/${number}`);
    return { number: p.number, title: p.title, body: p.body ?? '', url: p.html_url, headSha: p.head.sha, headRef: p.head.ref, baseRef: p.base.ref, state: p.state, draft: !!p.draft };
  }

  getPullDiff(token: string, fullName: string, number: number): Promise<string> {
    return this.request<string>(token, 'GET', `/repos/${fullName}/pulls/${number}`, undefined, 'application/vnd.github.diff');
  }

  async createReview(
    token: string,
    fullName: string,
    number: number,
    input: { body: string; event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'; commitId?: string; comments: { path: string; line: number; side: 'RIGHT'; body: string }[] },
  ): Promise<{ url: string }> {
    const r = await this.request<{ html_url: string }>(token, 'POST', `/repos/${fullName}/pulls/${number}/reviews`, {
      body: input.body, event: input.event, ...(input.commitId ? { commit_id: input.commitId } : {}), comments: input.comments,
    });
    return { url: r.html_url };
  }

  async listWorkflowRuns(token: string, fullName: string, status = 'failure'): Promise<GithubWorkflowRun[]> {
    const r = await this.request<{ workflow_runs: RawRun[] }>(token, 'GET', `/repos/${fullName}/actions/runs?status=${status}&per_page=20`);
    return r.workflow_runs.map(toRun);
  }

  async getWorkflowRun(token: string, fullName: string, runId: number): Promise<GithubWorkflowRun> {
    return toRun(await this.request<RawRun>(token, 'GET', `/repos/${fullName}/actions/runs/${runId}`));
  }

  /** Concatenated logs of the failed jobs of a run (tail-trimmed; the agent trims again). */
  async getFailedJobLogs(token: string, fullName: string, runId: number): Promise<string> {
    const jobs = await this.request<{ jobs: { id: number; name: string; conclusion: string | null }[] }>(token, 'GET', `/repos/${fullName}/actions/runs/${runId}/jobs?per_page=30`);
    const failed = jobs.jobs.filter((j) => j.conclusion === 'failure').slice(0, 3);
    const parts: string[] = [];
    for (const j of failed) {
      const text = await this.request<string>(token, 'GET', `/repos/${fullName}/actions/jobs/${j.id}/logs`, undefined, 'text/plain');
      parts.push(`### job: ${j.name}\n${text.slice(-60_000)}`);
    }
    return parts.join('\n\n');
  }
}

export interface GithubPull { number: number; title: string; body: string; url: string; headSha: string; headRef: string; baseRef: string; state: string; draft: boolean }
export interface GithubWorkflowRun { id: number; name: string; branch: string; url: string; conclusion: string | null; headSha: string; createdAt: string }
interface RawRun { id: number; name: string; head_branch: string; html_url: string; conclusion: string | null; head_sha: string; created_at: string }
const toRun = (r: RawRun): GithubWorkflowRun => ({ id: r.id, name: r.name, branch: r.head_branch, url: r.html_url, conclusion: r.conclusion, headSha: r.head_sha, createdAt: r.created_at });
