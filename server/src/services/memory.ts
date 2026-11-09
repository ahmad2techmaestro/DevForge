import { randomUUID } from 'node:crypto';
import { now, type MemoryDoc, type MemorySource } from '../models/domain.js';
import { notFound } from '../utils/errors.js';
import type { Store } from '../database/index.js';
import type { RepoService } from './repos.js';

const MAX_PER_REPO = 100;
const MAX_FOR_RUN = 30;
const MAX_TEXT = 300;

/**
 * Repo memory: short notes the agent receives with every run on that repository.
 * Manual notes come from the user; feedback and outcome notes are learned automatically.
 */
export class MemoryService {
  constructor(
    private readonly store: Store,
    private readonly repos: RepoService,
  ) {}

  async list(userId: string, repoId: string): Promise<MemoryDoc[]> {
    await this.repos.get(userId, repoId);
    return this.store.find<MemoryDoc>('memories', { userId, repoId }, { sort: { createdAt: -1 }, limit: MAX_PER_REPO });
  }

  async add(userId: string, repoId: string, text: string, source: MemorySource = 'manual'): Promise<MemoryDoc | null> {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!clean) return null;
    const existing = await this.store.findOne<MemoryDoc>('memories', { userId, repoId, text: clean });
    if (existing) return existing;
    const doc: MemoryDoc = { id: randomUUID(), userId, repoId, text: clean, source, createdAt: now() };
    await this.store.insertOne('memories', doc);
    await this.prune(userId, repoId);
    return doc;
  }

  async remove(userId: string, repoId: string, id: string): Promise<void> {
    await this.repos.get(userId, repoId);
    const n = await this.store.deleteMany('memories', { id, userId, repoId });
    if (n === 0) throw notFound('Memory note');
  }

  async clear(userId: string, repoId: string): Promise<number> {
    await this.repos.get(userId, repoId);
    return this.store.deleteMany('memories', { userId, repoId });
  }

  /** Notes sent to the agent: manual notes first (they are explicit instructions), then the newest learned ones. */
  async forRun(userId: string, repoId: string): Promise<string[]> {
    const all = await this.store.find<MemoryDoc>('memories', { userId, repoId }, { sort: { createdAt: -1 }, limit: MAX_PER_REPO });
    const manual = all.filter((m) => m.source === 'manual');
    const learned = all.filter((m) => m.source !== 'manual');
    return [...manual, ...learned].slice(0, MAX_FOR_RUN).map((m) => m.text);
  }

  /** Drops the oldest learned notes first when over the cap; manual notes are only dropped as a last resort. */
  private async prune(userId: string, repoId: string): Promise<void> {
    const all = await this.store.find<MemoryDoc>('memories', { userId, repoId }, { sort: { createdAt: 1 } });
    let excess = all.length - MAX_PER_REPO;
    if (excess <= 0) return;
    const order = [...all.filter((m) => m.source !== 'manual'), ...all.filter((m) => m.source === 'manual')];
    for (const m of order) {
      if (excess-- <= 0) break;
      await this.store.deleteMany('memories', { id: m.id });
    }
  }
}
