import { Redis } from 'ioredis';
import type { Logger } from '../config/logger.js';

export type BusMessage = { type: string; [key: string]: unknown };
type Handler = (channel: string, message: BusMessage) => void;

export const taskChannel = (taskId: string): string => `devforge:task:${taskId}`;
export const userChannel = (userId: string): string => `devforge:user:${userId}`;

/** Redis pub/sub so every API replica can fan events out to its own WebSocket clients. */
export class Bus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Set<Handler>();

  constructor(redisUrl: string, private readonly log: Logger) {
    this.pub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.sub = new Redis(redisUrl, { lazyConnect: false });
    for (const client of [this.pub, this.sub]) client.on('error', (err: Error) => this.log.warn({ err: err.message }, 'redis error'));
    this.sub.on('pmessage', (_pattern: string, channel: string, raw: string) => {
      let message: BusMessage;
      try {
        message = JSON.parse(raw) as BusMessage;
      } catch {
        return;
      }
      for (const h of this.handlers) h(channel, message);
    });
  }

  async start(): Promise<void> {
    await this.sub.psubscribe('devforge:task:*', 'devforge:user:*');
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async publish(channel: string, message: BusMessage): Promise<void> {
    try {
      await this.pub.publish(channel, JSON.stringify(message));
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'publish failed');
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.pub.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
