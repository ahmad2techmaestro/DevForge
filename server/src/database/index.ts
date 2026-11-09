import type { Config } from '../config/env.js';
import { MemoryStore } from './memory.js';
import { MongoStore } from './mongo.js';
import type { Store } from './store.js';

export type { Store } from './store.js';

export async function createStore(config: Pick<Config, 'dbDriver' | 'dbFile' | 'mongoUrl' | 'mongoDb'>): Promise<Store> {
  return config.dbDriver === 'memory' ? new MemoryStore(config.dbFile) : MongoStore.connect(config.mongoUrl, config.mongoDb);
}
