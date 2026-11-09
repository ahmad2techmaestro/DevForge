import type { ClientMessage, ServerMessage } from '../../types/index';

export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/** Exponential backoff with +/-25% jitter. `random` is injectable for tests. */
export function backoffDelay(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const raw = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  const jitter = 0.75 + random() * 0.5;
  return Math.round(Math.min(opts.maxMs, raw * jitter));
}

interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
}
type SocketFactory = (url: string) => SocketLike;

export interface WsClientOptions {
  url: () => string | null;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: WsStatus) => void;
  onAuthFailure?: () => void;
  onReconnected?: () => void;
  createSocket?: SocketFactory;
  backoff?: BackoffOptions;
  pingIntervalMs?: number;
  random?: () => number;
}

const OPEN = 1;
export const AUTH_CLOSE_CODE = 4401;

function parseMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as ServerMessage;
    }
  } catch {
    // ignore malformed frames
  }
  return null;
}

/** WebSocket wrapper: auto-reconnect with backoff, resubscribes to tasks after every reconnect, keeps the link alive with pings. */
export class WsClient {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private hasConnectedBefore = false;
  private readonly subscriptions = new Set<string>();
  private readonly backoff: BackoffOptions;

  constructor(private readonly opts: WsClientOptions) {
    this.backoff = opts.backoff ?? { baseMs: 800, maxMs: 15000 };
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000);
    }
    this.opts.onStatus('closed');
  }

  subscribe(taskId: string): void {
    this.subscriptions.add(taskId);
    this.send({ type: 'subscribe', taskId });
  }

  unsubscribe(taskId: string): void {
    this.subscriptions.delete(taskId);
    this.send({ type: 'unsubscribe', taskId });
  }

  private send(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private open(): void {
    const url = this.opts.url();
    if (!url) {
      this.opts.onStatus('closed');
      return;
    }
    this.opts.onStatus(this.hasConnectedBefore ? 'reconnecting' : 'connecting');
    const create = this.opts.createSocket ?? ((u: string) => new WebSocket(u) as SocketLike);
    const socket = create(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus('open');
      for (const taskId of this.subscriptions) this.send({ type: 'subscribe', taskId });
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), this.opts.pingIntervalMs ?? 25000);
      if (this.hasConnectedBefore) this.opts.onReconnected?.();
      this.hasConnectedBefore = true;
    };
    socket.onmessage = (ev) => {
      const msg = parseMessage(ev.data);
      if (msg) this.opts.onMessage(msg);
    };
    socket.onclose = (ev) => {
      this.clearTimers();
      this.socket = null;
      if (this.stopped) return;
      if (ev.code === AUTH_CLOSE_CODE) {
        this.stopped = true;
        this.opts.onStatus('closed');
        this.opts.onAuthFailure?.();
        return;
      }
      this.opts.onStatus('reconnecting');
      const delay = backoffDelay(this.attempt++, this.backoff, this.opts.random);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
    socket.onerror = () => {
      // The close event that follows drives reconnection.
    };
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }
}
