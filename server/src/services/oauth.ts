import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from '../config/env.js';
import type { Store } from '../database/index.js';
import { now, type UserDoc } from '../models/domain.js';
import { AppError } from '../utils/errors.js';
import type { SecretBox } from '../utils/crypto.js';
import type { AuditService } from './audit.js';
import type { AuthService } from './auth.js';

export type Provider = 'google' | 'github';
export const PROVIDERS: Provider[] = ['google', 'github'];
export const isProvider = (v: string): v is Provider => (PROVIDERS as string[]).includes(v);

interface Profile { email: string; name: string; gh?: { token: string; login: string; avatarUrl: string } }

/** OAuth 2.0 authorization-code login for Google and GitHub. A provider is enabled only when its keys are set. */
export class OAuthService {
  constructor(
    private readonly store: Store,
    private readonly config: Pick<Config, 'oauth' | 'oauthRedirectBase' | 'webOrigin' | 'jwtSecret'>,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly box: SecretBox,
  ) {}

  enabled(): Record<Provider, boolean> {
    return { google: !!this.config.oauth.google, github: !!this.config.oauth.github };
  }

  private creds(p: Provider) {
    const c = this.config.oauth[p];
    if (!c) throw new AppError(501, 'oauth_not_configured', `${p === 'google' ? 'Google' : 'GitHub'} sign-in is not configured on this server`);
    return c;
  }

  private redirectUri(p: Provider): string {
    return `${this.config.oauthRedirectBase}/api/auth/oauth/${p}/callback`;
  }

  authorizeUrl(p: Provider, connectUserId?: string): string {
    const { clientId } = this.creds(p);
    const state = jwt.sign({ p, n: randomUUID(), ...(connectUserId ? { u: connectUserId } : {}) }, this.config.jwtSecret, { expiresIn: '10m' });
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: this.redirectUri(p), state });
    if (p === 'google') {
      q.set('response_type', 'code');
      q.set('scope', 'openid email profile');
      q.set('prompt', 'select_account');
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    }
    q.set('scope', 'repo read:user user:email');
    return `https://github.com/login/oauth/authorize?${q}`;
  }

  private checkState(p: Provider, state: string): { connectUserId?: string } {
    try {
      const payload = jwt.verify(state, this.config.jwtSecret) as { p?: string; u?: string };
      if (payload.p === p) return payload.u ? { connectUserId: payload.u } : {};
    } catch { /* fall through */ }
    throw new AppError(400, 'bad_state', 'Sign-in session expired. Please try again.');
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  private async fetchProfile(p: Provider, code: string): Promise<Profile> {
    const { clientId, clientSecret } = this.creds(p);
    if (p === 'google') {
      const tok = await this.json(await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: this.redirectUri(p), grant_type: 'authorization_code' }),
      }));
      if (typeof tok.access_token !== 'string') throw new AppError(502, 'oauth_failed', 'Google rejected the sign-in');
      const me = await this.json(await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } }));
      if (typeof me.email !== 'string' || me.email_verified !== true) throw new AppError(400, 'email_unverified', 'Your Google email is not verified');
      return { email: me.email, name: typeof me.name === 'string' && me.name ? me.name : me.email.split('@')[0]! };
    }
    const tok = await this.json(await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: this.redirectUri(p) }),
    }));
    if (typeof tok.access_token !== 'string') throw new AppError(502, 'oauth_failed', 'GitHub rejected the sign-in');
    const h = { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'devforge' };
    const me = await this.json(await fetch('https://api.github.com/user', { headers: h }));
    const emails = (await (await fetch('https://api.github.com/user/emails', { headers: h })).json().catch(() => [])) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const best = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)) : undefined;
    if (!best) throw new AppError(400, 'email_unverified', 'Your GitHub account has no verified email');
    const login = typeof me.login === 'string' ? me.login : best.email.split('@')[0]!;
    const avatarUrl = typeof me.avatar_url === 'string' ? me.avatar_url : '';
    return { email: best.email, name: typeof me.name === 'string' && me.name ? me.name : login, gh: { token: tok.access_token, login, avatarUrl } };
  }

  /** Completes sign-in (or a GitHub connect from Settings). Returns a session token and whether it was a connect. */
  async complete(p: Provider, code: string, state: string): Promise<{ token: string; connected: boolean }> {
    const { connectUserId } = this.checkState(p, state);
    const profile = await this.fetchProfile(p, code);
    const link = async (userId: string) => {
      if (!profile.gh) return;
      const github = { tokenEnc: this.box.encrypt(profile.gh.token), login: profile.gh.login, avatarUrl: profile.gh.avatarUrl };
      await this.store.updateOne('users', { id: userId }, { $set: { github } });
      await this.audit.record(userId, 'github.connect', profile.gh.login);
    };
    if (connectUserId) {
      if (!(await this.store.findOne<UserDoc>('users', { id: connectUserId }))) throw new AppError(401, 'unauthorized', 'Account no longer exists');
      await link(connectUserId);
      return { token: this.auth.sign(connectUserId), connected: true };
    }
    const email = profile.email.trim().toLowerCase();
    let user = await this.store.findOne<UserDoc>('users', { email });
    if (!user) {
      user = { id: randomUUID(), email, name: profile.name.trim().slice(0, 100), passwordHash: '', createdAt: now(), github: null };
      await this.store.insertOne('users', user);
      await this.audit.record(user.id, 'auth.register', `oauth:${p}`);
    } else {
      await this.audit.record(user.id, 'auth.login', `oauth:${p}`);
    }
    await link(user.id);
    return { token: this.auth.sign(user.id), connected: false };
  }

  successUrl(token: string, connected = false): string {
    return connected ? `${this.config.webOrigin}/settings#github=connected` : `${this.config.webOrigin}/auth/callback#token=${encodeURIComponent(token)}`;
  }

  failureUrl(message: string): string {
    return `${this.config.webOrigin}/auth/callback#error=${encodeURIComponent(message)}`;
  }
}
