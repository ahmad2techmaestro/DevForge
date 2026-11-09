import { MongoClient, MongoServerError, type Db, type Document, type Filter, type UpdateFilter } from 'mongodb';
import { DuplicateKeyError } from '../utils/errors.js';
import { COLLECTIONS, UNIQUE_INDEXES, type Coll, type Doc, type FindOpts, type Store, type UpdateSpec } from './store.js';

const NO_ID = { projection: { _id: 0 } } as const;

/**
 * Production driver on the official `mongodb` driver. Documents carry an app-assigned `id`; `_id` is hidden.
 * NOTE: not exercised against a real server in the build environment; it shares the Store contract with MemoryStore.
 */
export class MongoStore implements Store {
  readonly kind = 'mongo' as const;
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
  ) {}

  static async connect(url: string, dbName: string): Promise<MongoStore> {
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const store = new MongoStore(client, client.db(dbName));
    await store.ensureIndexes();
    return store;
  }

  private async ensureIndexes(): Promise<void> {
    for (const coll of COLLECTIONS) {
      for (const keys of UNIQUE_INDEXES[coll]) {
        const spec = Object.fromEntries(keys.map((k) => [k, 1 as const]));
        await this.db.collection(coll).createIndex(spec, { unique: true, sparse: true });
      }
    }
    await this.db.collection('tasks').createIndex({ userId: 1, createdAt: -1 });
    await this.db.collection('repos').createIndex({ userId: 1, createdAt: -1 });
    await this.db.collection('events').createIndex({ taskId: 1, seq: 1 });
    await this.db.collection('audit').createIndex({ userId: 1, ts: -1 });
  }

  async insertOne<T extends Doc>(coll: Coll, doc: T): Promise<void> {
    try {
      await this.db.collection(coll).insertOne({ ...doc });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) throw new DuplicateKeyError(coll);
      throw err;
    }
  }

  async findOne<T extends Doc>(coll: Coll, filter: Doc): Promise<T | null> {
    return (await this.db.collection(coll).findOne(filter as Filter<Document>, NO_ID)) as unknown as T | null;
  }

  async find<T extends Doc>(coll: Coll, filter: Doc, opts: FindOpts = {}): Promise<T[]> {
    let cursor = this.db.collection(coll).find(filter as Filter<Document>, NO_ID);
    if (opts.sort) cursor = cursor.sort(opts.sort);
    if (opts.skip) cursor = cursor.skip(opts.skip);
    if (opts.limit !== undefined) cursor = cursor.limit(opts.limit);
    return (await cursor.toArray()) as unknown as T[];
  }

  async updateOne(coll: Coll, filter: Doc, update: UpdateSpec, opts: { upsert?: boolean } = {}): Promise<boolean> {
    try {
      const res = await this.db
        .collection(coll)
        .updateOne(filter as Filter<Document>, update as UpdateFilter<Document>, { upsert: opts.upsert ?? false });
      return res.matchedCount > 0 || res.upsertedCount > 0;
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) throw new DuplicateKeyError(coll);
      throw err;
    }
  }

  async deleteMany(coll: Coll, filter: Doc): Promise<number> {
    return (await this.db.collection(coll).deleteMany(filter as Filter<Document>)).deletedCount;
  }

  async count(coll: Coll, filter: Doc): Promise<number> {
    return this.db.collection(coll).countDocuments(filter as Filter<Document>);
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
