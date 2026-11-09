import type { Config } from '../config/env.js';
import type { Store } from '../database/index.js';
import type { UserDoc } from '../models/domain.js';
import type { SecretBox } from '../utils/crypto.js';
import { AppError, badRequest } from '../utils/errors.js';

export const NOTIFY_EVENTS = ['task.awaiting_approval', 'task.completed', 'task.failed', 'review.posted', 'ci.failure'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

const SLACK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
const DISCORD = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;

/** Only well-known chat webhook hosts are accepted, so this cannot be used to reach internal services. */
export function validateHook(kind: 'slack' | 'discord', url: string): string {
  const ok = kind === 'slack' ? SLACK.test(url) : DISCORD.test(url);
  if (!ok) throw badRequest('validation_error', `That does not look like a ${kind === 'slack' ? 'Slack' : 'Discord'} webhook URL`);
  return url;
}

export interface NotifySettings {
  slack: boolean;
  discord: boolean;
  events: string[];
}

export class NotifyService {
  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly config: Pick<Config, 'webOrigin'>,
  ) {}

  async get(userId: string): Promise<NotifySettings> {
    const u = await this.store.findOne<UserDoc>('users', { id: userId });
    return { slack: !!u?.notify?.slackEnc, discord: !!u?.notify?.discordEnc, events: u?.notify?.events ?? [...NOTIFY_EVENTS] };
  }

  async set(userId: string, input: { slackUrl?: string | null; discordUrl?: string | null; events?: string[] }): Promise<NotifySettings> {
    const u = await this.store.findOne<UserDoc>('users', { id: userId });
    const cur = u?.notify ?? { events: [...NOTIFY_EVENTS] };
    const next: NonNullable<UserDoc['notify']> = { events: cur.events };
    if (cur.slackEnc) next.slackEnc = cur.slackEnc;
    if (cur.discordEnc) next.discordEnc = cur.discordEnc;
    if (input.slackUrl === null) delete next.slackEnc;
    else if (input.slackUrl) next.slackEnc = this.box.encrypt(validateHook('slack', input.slackUrl));
    if (input.discordUrl === null) delete next.discordEnc;
    else if (input.discordUrl) next.discordEnc = this.box.encrypt(validateHook('discord', input.discordUrl));
    if (input.events) next.events = input.events.filter((e) => (NOTIFY_EVENTS as readonly string[]).includes(e));
    await this.store.updateOne('users', { id: userId }, { $set: { notify: next } });
    return this.get(userId);
  }

  private async post(url: string, body: unknown): Promise<void> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!res.ok) throw new AppError(502, 'notify_failed', `Chat service answered ${res.status}`);
  }

  private async deliver(user: UserDoc, text: string): Promise<{ slack?: boolean; discord?: boolean }> {
    const out: { slack?: boolean; discord?: boolean } = {};
    const n = user.notify;
    if (n?.slackEnc) out.slack = await this.post(this.box.decrypt(n.slackEnc), { text }).then(() => true, () => false);
    if (n?.discordEnc) out.discord = await this.post(this.box.decrypt(n.discordEnc), { content: text }).then(() => true, () => false);
    return out;
  }

  /** Fire-and-forget: never throws and never blocks the caller. */
  send(userId: string, event: NotifyEvent, text: string, path = ''): void {
    void (async () => {
      const user = await this.store.findOne<UserDoc>('users', { id: userId });
      if (!user?.notify || !(user.notify.events ?? []).includes(event)) return;
      await this.deliver(user, `${text}${path ? `\n${this.config.webOrigin}${path}` : ''}`);
    })().catch(() => undefined);
  }

  async test(userId: string): Promise<{ slack?: boolean; discord?: boolean }> {
    const user = await this.store.findOne<UserDoc>('users', { id: userId });
    if (!user?.notify?.slackEnc && !user?.notify?.discordEnc) throw badRequest('no_webhook', 'Add a Slack or Discord webhook first');
    return this.deliver(user, 'DevForge test notification: your chat connection works.');
  }
}
