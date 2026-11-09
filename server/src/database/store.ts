export type Doc = Record<string, unknown>;

export const COLLECTIONS = ['users', 'repos', 'tasks', 'events', 'approvals', 'chats', 'audit', 'memories', 'reviews', 'ciruns', 'mcpservers'] as const;
export type Coll = (typeof COLLECTIONS)[number];

export interface FindOpts {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

export interface UpdateSpec {
  $set?: Doc;
  $inc?: Record<string, number>;
  $push?: Doc;
  $unset?: Record<string, true | 1 | ''>;
}

/** Narrow storage interface used by the whole app (see CONTRACT.md, "Storage interface"). */
export interface Store {
  readonly kind: 'mongo' | 'memory';
  /** Throws DuplicateKeyError when a unique index is violated. */
  insertOne<T extends Doc>(coll: Coll, doc: T): Promise<void>;
  findOne<T extends Doc>(coll: Coll, filter: Doc): Promise<T | null>;
  find<T extends Doc>(coll: Coll, filter: Doc, opts?: FindOpts): Promise<T[]>;
  /** Resolves true when a document matched (or was upserted). */
  updateOne(coll: Coll, filter: Doc, update: UpdateSpec, opts?: { upsert?: boolean }): Promise<boolean>;
  deleteMany(coll: Coll, filter: Doc): Promise<number>;
  count(coll: Coll, filter: Doc): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Unique indexes enforced by both drivers. */
export const UNIQUE_INDEXES: Record<Coll, string[][]> = {
  users: [['email']],
  repos: [['id']],
  tasks: [['id'], ['runId']],
  events: [['runId', 'seq']],
  approvals: [['taskId', 'approvalId']],
  chats: [['id']],
  audit: [['id']],
  memories: [['id']],
  reviews: [['id']],
  ciruns: [['id']],
  mcpservers: [['id']],
};
