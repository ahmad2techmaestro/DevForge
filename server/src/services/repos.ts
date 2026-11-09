import { randomUUID } from 'node:crypto';
import type { AgentClient, Usage } from '../integrations/aiService.js';
import type { Config } from '../config/env.js';
import { addUsage, emptyUsage, now, type ChatDoc, type ChatMessage, type RepoDoc } from '../models/domain.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import type { Logger } from '../config/logger.js';
import { toRepo } from '../models/mappers.js';
import { userChannel, type Bus } from '../realtime/bus.js';
import type { Store } from '../database/index.js';
import type { AuditService } from './audit.js';
import type { AccountService } from './auth.js';

export interface CreateRepoInput {
  fullName?: string;
  cloneUrl?: string;
  localPath?: string;
  branch?: string;
}

const GITHUB_FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

/** What people paste into a path box: quotes from Windows "Copy as path", stray spaces, file:// URLs. */
export function cleanLocalPath(raw: string): string {
  let text = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  if (/^file:\/\//i.test(text)) {
    try {
      const p = decodeURIComponent(new URL(text).pathname);
      text = /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
    } catch { /* keep the text; the agent reports a clear error */ }
  }
  return text;
}

export class RepoService {
  constructor(
    private readonly store: Store,
    private readonly agent: AgentClient,
    private readonly bus: Bus,
    private readonly account: AccountService,
    private readonly audit: AuditService,
    private readonly config: Pick<Config, 'allowLocalRepos' | 'githubCloneBase'>,
    private readonly log: Logger,
  ) {}

  async create(userId: string, input: CreateRepoInput): Promise<RepoDoc> {
    const provided = [input.fullName, input.cloneUrl, input.localPath].filter(Boolean).length;
    if (provided !== 1) throw badRequest('validation_error', 'Provide exactly one of fullName, cloneUrl or localPath');

    let repo: Omit<RepoDoc, 'id' | 'userId' | 'status' | 'createdAt' | 'branch'>;
    if (input.fullName) {
      if (!GITHUB_FULL_NAME.test(input.fullName)) throw badRequest('validation_error', 'fullName must look like owner/repo');
      repo = {
        name: input.fullName.split('/')[1] as string,
        fullName: input.fullName,
        cloneUrl: `${this.config.githubCloneBase}/${input.fullName}.git`,
        source: 'github',
      };
    } else if (input.cloneUrl) {
      repo = this.fromUrl(input.cloneUrl);
    } else {
      if (!this.config.allowLocalRepos) throw new AppError(403, 'local_repos_disabled', 'Local repositories are disabled on this server');
      const local = cleanLocalPath(input.localPath as string);
      // A repository link pasted into the "Local path" box is a clone URL, not a folder.
      repo = /^(https?:\/\/|git@|ssh:\/\/)/i.test(local) || /^(www\.)?github\.com\//i.test(local)
        ? this.fromUrl(/^(www\.)?github\.com\//i.test(local) ? `https://${local}` : local)
        : { name: local.split(/[\\/]/).filter(Boolean).pop() ?? 'local', localPath: local, source: 'local' };
    }

    const doc: RepoDoc = {
      ...repo,
      id: randomUUID(),
      userId,
      branch: input.branch ?? 'main',
      status: 'indexing',
      usage: emptyUsage(),
      createdAt: now(),
      indexingStartedAt: now(),
    };
    await this.store.insertOne('repos', doc);
    await this.audit.record(userId, 'repo.connect', doc.id, { name: doc.name, source: doc.source });
    void this.indexInBackground(doc, input.branch);
    return doc;
  }

  private fromUrl(raw: string): Omit<RepoDoc, 'id' | 'userId' | 'status' | 'createdAt' | 'branch'> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw badRequest('validation_error', 'cloneUrl must be a valid URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('validation_error', 'Only http(s) clone URLs are supported');
    if (url.username || url.password) throw badRequest('validation_error', 'Do not embed credentials in the URL; connect GitHub in Settings instead');
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    const name = parts.at(-1);
    if (!name) throw badRequest('validation_error', 'cloneUrl must point at a repository');
    const onGithub = url.host === new URL(this.config.githubCloneBase).host;
    if (onGithub && parts.length < 2) {
      throw badRequest('validation_error', `That is a GitHub profile, not a repository. Use the full repository link, for example ${url.origin}/${parts[0] ?? 'owner'}/repo-name`);
    }
    const isGithub = onGithub && parts.length === 2;
    return {
      name,
      cloneUrl: url.toString(),
      ...(isGithub ? { fullName: parts.join('/') } : {}),
      source: isGithub ? 'github' : 'url',
    };
  }

  async list(userId: string): Promise<RepoDoc[]> {
    return this.store.find<RepoDoc>('repos', { userId }, { sort: { createdAt: -1 } });
  }

  async get(userId: string, id: string): Promise<RepoDoc> {
    const repo = await this.store.findOne<RepoDoc>('repos', { id, userId });
    if (!repo) throw notFound('Repository');
    return repo;
  }

  async ready(userId: string, id: string): Promise<RepoDoc> {
    const repo = await this.get(userId, id);
    if (repo.status !== 'ready') throw new AppError(409, 'repo_not_ready', `Repository is ${repo.status}`);
    return repo;
  }

  async remove(userId: string, id: string): Promise<void> {
    const repo = await this.get(userId, id);
    await this.agent.deleteRepo(id).catch((err: Error) => this.log.warn({ err: err.message, repoId: id }, 'agent repo delete failed'));
    const tasks = await this.store.find<{ id: string }>('tasks', { repoId: id, userId });
    for (const t of tasks) {
      await this.store.deleteMany('events', { taskId: t.id });
      await this.store.deleteMany('approvals', { taskId: t.id });
    }
    await this.store.deleteMany('tasks', { repoId: id, userId });
    await this.store.deleteMany('chats', { repoId: id, userId });
    await this.store.deleteMany('repos', { id, userId });
    await this.audit.record(userId, 'repo.delete', repo.id, { name: repo.name });
  }

  async reindex(userId: string, id: string): Promise<RepoDoc> {
    const repo = await this.get(userId, id);
    if (repo.status === 'indexing') throw new AppError(409, 'already_indexing', 'Repository is already being indexed');
    await this.store.updateOne('repos', { id }, { $set: { status: 'indexing', indexingStartedAt: now() }, $unset: { error: true } });
    const fresh = await this.get(userId, id);
    void this.indexInBackground(fresh, undefined);
    await this.publish(fresh);
    return fresh;
  }

  private async indexInBackground(repo: RepoDoc, requestedBranch: string | undefined): Promise<void> {
    try {
      const token = repo.source === 'local' ? null : await this.account.tokenFor(repo.userId);
      const result = await this.agent.indexRepo({
        repoId: repo.id,
        ...(repo.localPath ? { localPath: repo.localPath } : { cloneUrl: repo.cloneUrl }),
        ...(requestedBranch ? { branch: requestedBranch } : {}),
        ...(token ? { token } : {}),
      });
      await this.store.updateOne(
        'repos',
        { id: repo.id },
        {
          $set: {
            status: 'ready',
            commit: result.commit,
            branch: result.branch,
            summary: result.summary,
            stats: { fileCount: result.fileCount, totalLines: result.totalLines, languages: result.languages },
            indexedAt: now(),
          },
          $unset: { error: true },
        },
      );
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Indexing failed';
      this.log.warn({ repoId: repo.id, err: (err as Error).message }, 'repo indexing failed');
      await this.store.updateOne('repos', { id: repo.id }, { $set: { status: 'error', error: message } });
    }
    const latest = await this.store.findOne<RepoDoc>('repos', { id: repo.id });
    if (latest) await this.publish(latest);
  }

  async publish(repo: RepoDoc): Promise<void> {
    await this.bus.publish(userChannel(repo.userId), { type: 'repo.updated', repo: toRepo(repo) });
  }

  async updateSettings(userId: string, id: string, input: { autoReview?: boolean; autoFixCi?: boolean }): Promise<RepoDoc> {
    await this.get(userId, id);
    const set: Record<string, boolean> = {};
    if (typeof input.autoReview === 'boolean') set.autoReview = input.autoReview;
    if (typeof input.autoFixCi === 'boolean') set.autoFixCi = input.autoFixCi;
    if (Object.keys(set).length) await this.store.updateOne('repos', { id, userId }, { $set: set });
    return this.get(userId, id);
  }

  async cacheHealth(repoId: string, health: { score: number; grade: string }): Promise<void> {
    await this.store.updateOne('repos', { id: repoId }, { $set: { health: { score: health.score, grade: health.grade } } });
  }

  async recordUsage(repoId: string, usage: Usage | undefined): Promise<void> {
    if (!usage) return;
    const repo = await this.store.findOne<RepoDoc>('repos', { id: repoId });
    if (repo) await this.store.updateOne('repos', { id: repoId }, { $set: { usage: addUsage(repo.usage ?? emptyUsage(), usage) } });
  }

  // ---- chat threads ----

  async chat(userId: string, repoId: string, threadId: string | undefined, message: string): Promise<{ threadId: string; messages: ChatMessage[] }> {
    await this.ready(userId, repoId);
    let thread = threadId ? await this.store.findOne<ChatDoc>('chats', { id: threadId, repoId, userId }) : null;
    if (threadId && !thread) throw notFound('Chat thread');
    const ts = now();
    if (!thread) {
      thread = { id: randomUUID(), repoId, userId, title: message.slice(0, 60), messages: [], createdAt: ts, updatedAt: ts };
      await this.store.insertOne('chats', thread);
    }
    const userMsg: ChatMessage = { role: 'user', content: message, ts };
    const history = [...thread.messages, userMsg].map(({ role, content }) => ({ role, content }));
    const reply = await this.agent.chat(repoId, { messages: history });
    await this.recordUsage(repoId, reply.usage);
    const assistant: ChatMessage = {
      role: 'assistant',
      content: reply.answer,
      ...(reply.citations?.length ? { citations: reply.citations } : {}),
      ts: now(),
    };
    await this.store.updateOne('chats', { id: thread.id }, { $push: { messages: userMsg }, $set: { updatedAt: assistant.ts } });
    await this.store.updateOne('chats', { id: thread.id }, { $push: { messages: assistant } });
    const saved = await this.store.findOne<ChatDoc>('chats', { id: thread.id });
    return { threadId: thread.id, messages: saved?.messages ?? [userMsg, assistant] };
  }

  async chats(userId: string, repoId: string): Promise<{ threadId: string; title: string; updatedAt: string }[]> {
    await this.get(userId, repoId);
    const rows = await this.store.find<ChatDoc>('chats', { repoId, userId }, { sort: { updatedAt: -1 } });
    return rows.map((c) => ({ threadId: c.id, title: c.title, updatedAt: c.updatedAt }));
  }

  async thread(userId: string, repoId: string, threadId: string): Promise<{ threadId: string; messages: ChatMessage[] }> {
    const chat = await this.store.findOne<ChatDoc>('chats', { id: threadId, repoId, userId });
    if (!chat) throw notFound('Chat thread');
    return { threadId: chat.id, messages: chat.messages };
  }
}
