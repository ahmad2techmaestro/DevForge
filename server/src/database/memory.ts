import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Query } from 'mingo';
import { DuplicateKeyError } from '../utils/errors.js';
import { COLLECTIONS, UNIQUE_INDEXES, type Coll, type Doc, type FindOpts, type Store, type UpdateSpec } from './store.js';

const clone = <T>(v: T): T => structuredClone(v);

function getPath(obj: Doc, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Doc)[part];
  }
  return cur;
}

function parentOf(obj: Doc, path: string): { holder: Doc; key: string } {
  const parts = path.split('.');
  const key = parts.pop() as string;
  let holder = obj;
  for (const part of parts) {
    const next = holder[part];
    if (next === null || typeof next !== 'object') holder[part] = {};
    holder = holder[part] as Doc;
  }
  return { holder, key };
}

function applyUpdate(doc: Doc, update: UpdateSpec): void {
  for (const [path, value] of Object.entries(update.$set ?? {})) {
    const { holder, key } = parentOf(doc, path);
    holder[key] = clone(value);
  }
  for (const [path, by] of Object.entries(update.$inc ?? {})) {
    const { holder, key } = parentOf(doc, path);
    holder[key] = (typeof holder[key] === 'number' ? (holder[key] as number) : 0) + by;
  }
  for (const [path, value] of Object.entries(update.$push ?? {})) {
    const { holder, key } = parentOf(doc, path);
    if (!Array.isArray(holder[key])) holder[key] = [];
    (holder[key] as unknown[]).push(clone(value));
  }
  for (const path of Object.keys(update.$unset ?? {})) {
    const { holder, key } = parentOf(doc, path);
    delete holder[key];
  }
}

/** Equality fields of a filter, used to seed an upserted document. */
function seedFromFilter(filter: Doc): Doc {
  const seed: Doc = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some((x) => x.startsWith('$'))) continue;
    const { holder, key } = parentOf(seed, k);
    holder[key] = clone(v);
  }
  return seed;
}

/** Dev/test driver: Mongo query semantics via mingo, data kept in process memory. */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private readonly data = new Map<Coll, Doc[]>(COLLECTIONS.map((c) => [c, []]));
  private timer: NodeJS.Timeout | null = null;

  /** With `file`, data survives restarts (dev convenience): loaded on start, saved shortly after every write. */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Doc[]>;
        for (const c of COLLECTIONS) if (Array.isArray(saved[c])) this.data.set(c, saved[c]);
      } catch {
        // unreadable snapshot: start empty rather than crash
      }
    }
  }

  private dirty(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 150);
    this.timer.unref();
  }

  private flush(): void {
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data)));
      renameSync(tmp, this.file);
    } catch {
      // best effort
    }
  }

  private rows(coll: Coll): Doc[] {
    return this.data.get(coll) as Doc[];
  }

  private assertUnique(coll: Coll, doc: Doc, ignore?: Doc): void {
    for (const keys of UNIQUE_INDEXES[coll]) {
      if (keys.some((k) => getPath(doc, k) === undefined)) continue;
      const clash = this.rows(coll).some(
        (row) => row !== ignore && keys.every((k) => getPath(row, k) === getPath(doc, k)),
      );
      if (clash) throw new DuplicateKeyError(coll);
    }
  }

  async insertOne<T extends Doc>(coll: Coll, doc: T): Promise<void> {
    this.assertUnique(coll, doc);
    this.rows(coll).push(clone(doc));
    this.dirty();
  }

  async findOne<T extends Doc>(coll: Coll, filter: Doc): Promise<T | null> {
    const found = new Query(filter).find(this.rows(coll)).limit(1).all() as Doc[];
    return found[0] ? (clone(found[0]) as T) : null;
  }

  async find<T extends Doc>(coll: Coll, filter: Doc, opts: FindOpts = {}): Promise<T[]> {
    let cursor = new Query(filter).find(this.rows(coll));
    if (opts.sort) cursor = cursor.sort(opts.sort);
    if (opts.skip) cursor = cursor.skip(opts.skip);
    if (opts.limit !== undefined) cursor = cursor.limit(opts.limit);
    return clone(cursor.all() as T[]);
  }

  async updateOne(coll: Coll, filter: Doc, update: UpdateSpec, opts: { upsert?: boolean } = {}): Promise<boolean> {
    const target = (new Query(filter).find(this.rows(coll)).limit(1).all() as Doc[])[0];
    if (target) {
      const draft = clone(target);
      applyUpdate(draft, update);
      this.assertUnique(coll, draft, target);
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, draft);
      this.dirty();
      return true;
    }
    if (!opts.upsert) return false;
    const fresh = seedFromFilter(filter);
    applyUpdate(fresh, update);
    this.assertUnique(coll, fresh);
    this.rows(coll).push(fresh);
    this.dirty();
    return true;
  }

  async deleteMany(coll: Coll, filter: Doc): Promise<number> {
    const doomed = new Set(new Query(filter).find(this.rows(coll)).all() as Doc[]);
    this.data.set(coll, this.rows(coll).filter((r) => !doomed.has(r)));
    if (doomed.size) this.dirty();
    return doomed.size;
  }

  async count(coll: Coll, filter: Doc): Promise<number> {
    return new Query(filter).find(this.rows(coll)).all().length;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.flush();
  }
}
