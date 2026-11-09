import { randomUUID } from 'node:crypto';
import { now, type AuditDoc } from '../models/domain.js';
import type { Logger } from '../config/logger.js';
import type { Store } from '../database/index.js';

export class AuditService {
  constructor(
    private readonly store: Store,
    private readonly log: Logger,
  ) {}

  /** Never throws: an audit failure must not break the action being audited. */
  async record(userId: string, action: string, target: string, meta: Record<string, unknown> = {}): Promise<void> {
    try {
      const doc: AuditDoc = { id: randomUUID(), userId, action, target, meta, ts: now() };
      await this.store.insertOne('audit', doc);
    } catch (err) {
      this.log.error({ err: (err as Error).message, action }, 'audit write failed');
    }
  }

  async list(userId: string, limit: number, offset: number): Promise<{ items: AuditDoc[]; nextCursor: string | null }> {
    const rows = await this.store.find<AuditDoc>('audit', { userId }, { sort: { ts: -1 }, skip: offset, limit: limit + 1 });
    const more = rows.length > limit;
    return { items: rows.slice(0, limit), nextCursor: more ? String(offset + limit) : null };
  }
}
