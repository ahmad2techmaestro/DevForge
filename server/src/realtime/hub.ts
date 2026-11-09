import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { TaskDoc } from '../models/domain.js';
import type { Logger } from '../config/logger.js';
import type { Metrics } from '../monitoring/metrics.js';
import type { AuthService } from '../services/auth.js';
import type { Store } from '../database/index.js';
import type { Bus, BusMessage } from './bus.js';

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), taskId: z.string().min(1) }),
  z.object({ type: z.literal('unsubscribe'), taskId: z.string().min(1) }),
  z.object({ type: z.literal('ping') }),
]);

interface Client {
  ws: WebSocket;
  userId: string;
  tasks: Set<string>;
}

/** WebSocket gateway: JWT auth, per-task subscriptions, fan-out from Redis pub/sub. */
export class Hub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<Client>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly metrics: Metrics,
    private readonly log: Logger,
  ) {}

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const userId = this.auth.verify(url.searchParams.get('token') ?? '');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, userId));
    });
    this.unsubscribe = this.bus.onMessage((channel, message) => this.route(channel, message));
  }

  private onConnection(ws: WebSocket, userId: string | null): void {
    if (!userId) {
      ws.close(4401, 'unauthorized');
      return;
    }
    const client: Client = { ws, userId, tasks: new Set() };
    this.clients.add(client);
    this.metrics.ws.inc();
    this.send(ws, { type: 'hello', userId });
    ws.on('message', (raw) => void this.onMessage(client, raw.toString()));
    ws.on('close', () => {
      this.clients.delete(client);
      this.metrics.ws.dec();
    });
    ws.on('error', (err) => this.log.debug({ err: err.message }, 'ws error'));
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let parsed: z.infer<typeof ClientMessage>;
    try {
      parsed = ClientMessage.parse(JSON.parse(raw));
    } catch {
      this.send(client.ws, { type: 'error', code: 'bad_message' });
      return;
    }
    if (parsed.type === 'ping') {
      this.send(client.ws, { type: 'pong' });
    } else if (parsed.type === 'unsubscribe') {
      client.tasks.delete(parsed.taskId);
    } else {
      const task = await this.store.findOne<TaskDoc>('tasks', { id: parsed.taskId, userId: client.userId });
      if (!task) {
        this.send(client.ws, { type: 'error', code: 'forbidden', taskId: parsed.taskId });
        return;
      }
      client.tasks.add(parsed.taskId);
      this.send(client.ws, { type: 'subscribed', taskId: parsed.taskId });
    }
  }

  private route(channel: string, message: BusMessage): void {
    if (channel.startsWith('devforge:user:')) {
      const userId = channel.slice('devforge:user:'.length);
      for (const c of this.clients) if (c.userId === userId) this.send(c.ws, message);
    } else if (channel.startsWith('devforge:task:')) {
      const taskId = channel.slice('devforge:task:'.length);
      const { userId: _owner, ...outgoing } = message;
      for (const c of this.clients) {
        if (c.tasks.has(taskId) && c.userId === message.userId) this.send(c.ws, outgoing as BusMessage);
      }
    }
  }

  private send(ws: WebSocket, message: BusMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  close(): void {
    this.unsubscribe?.();
    for (const c of this.clients) c.ws.close(1001, 'server shutting down');
    this.wss.close();
  }
}
