import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { AgentClient, AgentHealth } from '../integrations/aiService.js';
import type { GithubClient } from '../integrations/github.js';
import type { Config } from '../config/env.js';
import type { SecretBox } from '../utils/crypto.js';
import { now, type UserDoc } from '../models/domain.js';
import { AppError, DuplicateKeyError, notFound } from '../utils/errors.js';
import type { Store } from '../database/index.js';
import type { AuditService } from './audit.js';

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly config: Pick<Config, 'jwtSecret' | 'bcryptCost'>,
    private readonly audit: AuditService,
  ) {}

  sign(userId: string): string {
    return jwt.sign({ sub: userId }, this.config.jwtSecret, { expiresIn: '7d' });
  }

  /** Returns the user id for a valid token, otherwise null. */
  verify(token: string): string | null {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret);
      return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  async register(input: { email: string; password: string; name: string }): Promise<{ token: string; user: UserDoc }> {
    const user: UserDoc = {
      id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      passwordHash: await bcrypt.hash(input.password, this.config.bcryptCost),
      createdAt: now(),
      github: null,
    };
    try {
      await this.store.insertOne('users', user);
    } catch (err) {
      if (err instanceof DuplicateKeyError) throw new AppError(409, 'email_taken', 'An account with this email already exists');
      throw err;
    }
    await this.audit.record(user.id, 'auth.register', user.id);
    return { token: this.sign(user.id), user };
  }

  async login(input: { email: string; password: string }): Promise<{ token: string; user: UserDoc }> {
    const user = await this.store.findOne<UserDoc>('users', { email: input.email.trim().toLowerCase() });
    const ok = user && user.passwordHash ? await bcrypt.compare(input.password, user.passwordHash) : false;
    if (user && !user.passwordHash) throw new AppError(401, 'use_social_login', 'This account uses Google or GitHub sign-in. Use that button instead.');
    if (!user || !ok) throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
    await this.audit.record(user.id, 'auth.login', user.id);
    return { token: this.sign(user.id), user };
  }

  async getUser(userId: string): Promise<UserDoc> {
    const user = await this.store.findOne<UserDoc>('users', { id: userId });
    if (!user) throw new AppError(401, 'unauthorized', 'Account no longer exists');
    return user;
  }
}

export interface AgentStatus {
  reachable: boolean;
  error?: string;
  provider: string;
  model: string;
  sandbox: string;
  dockerAvailable: boolean;
}

/** GitHub connection and agent status for the signed-in user. */
export class AccountService {
  constructor(
    private readonly store: Store,
    private readonly github: GithubClient,
    private readonly agent: AgentClient,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
  ) {}

  async connectGithub(userId: string, token: string): Promise<{ login: string; avatarUrl: string }> {
    const profile = await this.github.getUser(token);
    await this.store.updateOne('users', { id: userId }, { $set: { github: { tokenEnc: this.box.encrypt(token), ...profile } } });
    await this.audit.record(userId, 'github.connect', profile.login);
    return profile;
  }

  async disconnectGithub(userId: string): Promise<void> {
    await this.store.updateOne('users', { id: userId }, { $set: { github: null } });
    await this.audit.record(userId, 'github.disconnect', userId);
  }

  async githubStatus(user: UserDoc): Promise<{ connected: boolean; login?: string; avatarUrl?: string }> {
    return user.github ? { connected: true, login: user.github.login, avatarUrl: user.github.avatarUrl } : { connected: false };
  }

  /** Decrypted token, server-side use only. */
  async tokenFor(userId: string): Promise<string | null> {
    const user = await this.store.findOne<UserDoc>('users', { id: userId });
    return user?.github ? this.box.decrypt(user.github.tokenEnc) : null;
  }

  async requireToken(userId: string): Promise<string> {
    const token = await this.tokenFor(userId);
    if (!token) throw new AppError(409, 'github_not_connected', 'Connect your GitHub account first');
    return token;
  }

  async agentStatus(): Promise<AgentStatus> {
    try {
      const h: AgentHealth = await this.agent.health();
      return { reachable: true, provider: h.provider, model: h.model, sandbox: h.sandbox, dockerAvailable: h.dockerAvailable };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Agent service is unreachable';
      return { reachable: false, error, provider: 'unknown', model: '', sandbox: 'unknown', dockerAvailable: false };
    }
  }

  async mustExist(userId: string): Promise<UserDoc> {
    const user = await this.store.findOne<UserDoc>('users', { id: userId });
    if (!user) throw notFound('User');
    return user;
  }
}
