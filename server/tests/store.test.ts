import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/utils/crypto.js';
import { DuplicateKeyError } from '../src/utils/errors.js';
import { MemoryStore } from '../src/database/memory.js';

describe('Store contract (memory driver)', () => {
  it('inserts, finds with sort/skip/limit and counts', async () => {
    const s = new MemoryStore();
    for (const [i, name] of ['c', 'a', 'b'].entries()) await s.insertOne('audit', { id: `id${i}`, userId: 'u', name, n: i });
    expect((await s.find('audit', { userId: 'u' }, { sort: { name: 1 } })).map((d) => d.name)).toEqual(['a', 'b', 'c']);
    expect((await s.find('audit', {}, { sort: { n: -1 }, skip: 1, limit: 1 })).map((d) => d.name)).toEqual(['a']);
    expect(await s.count('audit', { n: { $gte: 1 } })).toBe(2);
    expect(await s.findOne('audit', { id: 'nope' })).toBeNull();
  });

  it('supports $set (dotted), $inc, $push, $unset and upsert', async () => {
    const s = new MemoryStore();
    await s.insertOne('tasks', { id: 't1', runId: 'r1', usage: { inputTokens: 1 }, tags: [] });
    expect(await s.updateOne('tasks', { id: 't1' }, { $set: { 'usage.costUsd': 0.5, status: 'running' }, $inc: { 'usage.inputTokens': 4 }, $push: { tags: 'x' } })).toBe(true);
    expect(await s.findOne('tasks', { id: 't1' })).toMatchObject({ status: 'running', usage: { inputTokens: 5, costUsd: 0.5 }, tags: ['x'] });
    await s.updateOne('tasks', { id: 't1' }, { $unset: { status: true } });
    expect((await s.findOne('tasks', { id: 't1' }))?.status).toBeUndefined();

    expect(await s.updateOne('tasks', { id: 'missing' }, { $set: { a: 1 } })).toBe(false);
    expect(await s.updateOne('tasks', { id: 't2', runId: 'r2' }, { $set: { a: 1 } }, { upsert: true })).toBe(true);
    expect(await s.findOne('tasks', { id: 't2' })).toMatchObject({ id: 't2', runId: 'r2', a: 1 });
  });

  it('enforces unique indexes, including compound ones', async () => {
    const s = new MemoryStore();
    await s.insertOne('users', { id: '1', email: 'a@x.com' });
    await expect(s.insertOne('users', { id: '2', email: 'a@x.com' })).rejects.toBeInstanceOf(DuplicateKeyError);
    await s.insertOne('events', { id: 'e1', runId: 'r', seq: 1 });
    await s.insertOne('events', { id: 'e2', runId: 'r', seq: 2 });
    await s.insertOne('events', { id: 'e3', runId: 'other', seq: 1 });
    await expect(s.insertOne('events', { id: 'e4', runId: 'r', seq: 1 })).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('deletes and isolates stored documents from caller mutation', async () => {
    const s = new MemoryStore();
    await s.insertOne('repos', { id: 'r1', userId: 'u', stats: { n: 1 } });
    const copy = await s.findOne<{ stats: { n: number } }>('repos', { id: 'r1' });
    (copy as { stats: { n: number } }).stats.n = 99;
    expect(await s.findOne('repos', { id: 'r1' })).toMatchObject({ stats: { n: 1 } });
    expect(await s.deleteMany('repos', { userId: 'u' })).toBe(1);
    expect(await s.count('repos', {})).toBe(0);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox('00'.repeat(32));
  it('round-trips and uses a fresh IV each time', () => {
    const a = box.encrypt('ghp_secret');
    expect(a).not.toContain('ghp_secret');
    expect(box.decrypt(a)).toBe('ghp_secret');
    expect(box.encrypt('ghp_secret')).not.toBe(a);
  });
  it('detects tampering and wrong keys', () => {
    const enc = box.encrypt('hello');
    const [iv, tag, data] = enc.split('.') as [string, string, string];
    const flipped = Buffer.from(data, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => box.decrypt([iv, tag, flipped.toString('base64')].join('.'))).toThrow();
    expect(() => new SecretBox('11'.repeat(32)).decrypt(enc)).toThrow();
  });
});

describe('memory store persistence', () => {
  it('reloads data from its file after a restart', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { MemoryStore } = await import('../src/database/memory.js');
    const file = join(mkdtempSync(join(tmpdir(), 'df-db-')), 'db.json');
    const a = new MemoryStore(file);
    await a.insertOne('users', { id: 'u1', email: 'x@y.z' });
    await a.close();
    const b = new MemoryStore(file);
    expect(await b.findOne('users', { id: 'u1' })).toMatchObject({ email: 'x@y.z' });
  });
});
