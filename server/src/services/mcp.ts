import { randomUUID } from 'node:crypto';
import type { Store } from '../database/index.js';
import type { AgentClient } from '../integrations/aiService.js';
import { now, type McpServerDoc } from '../models/domain.js';
import type { SecretBox } from '../utils/crypto.js';
import { badRequest, notFound } from '../utils/errors.js';
import type { AuditService } from './audit.js';

const MAX_PER_USER = 8;

export interface McpInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** env for stdio, headers for http. */
  secrets?: Record<string, string>;
  enabled?: boolean;
}

/** User-owned MCP servers. Env vars and headers (often API tokens) are encrypted and never sent back to the browser. */
export class McpService {
  constructor(
    private readonly store: Store,
    private readonly agent: AgentClient,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
  ) {}

  list(userId: string): Promise<McpServerDoc[]> {
    return this.store.find<McpServerDoc>('mcpservers', { userId }, { sort: { createdAt: 1 } });
  }

  private async get(userId: string, id: string): Promise<McpServerDoc> {
    const doc = await this.store.findOne<McpServerDoc>('mcpservers', { id, userId });
    if (!doc) throw notFound('MCP server');
    return doc;
  }

  private validate(i: McpInput): void {
    if (i.transport === 'stdio' && !i.command?.trim()) throw badRequest('validation_error', 'A command is required for a local (stdio) server');
    if (i.transport === 'http') {
      let u: URL;
      try {
        u = new URL(i.url ?? '');
      } catch {
        throw badRequest('validation_error', 'Enter a valid http(s) URL');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('validation_error', 'Enter a valid http(s) URL');
    }
  }

  async create(userId: string, i: McpInput): Promise<McpServerDoc> {
    this.validate(i);
    const name = i.name.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 32);
    if (!name) throw badRequest('validation_error', 'Name must contain letters or digits');
    const existing = await this.list(userId);
    if (existing.length >= MAX_PER_USER) throw badRequest('limit_reached', `You can connect up to ${MAX_PER_USER} MCP servers`);
    if (existing.some((m) => m.name === name)) throw badRequest('duplicate', `A server named "${name}" already exists`);
    const secrets = i.secrets ?? {};
    const doc: McpServerDoc = {
      id: randomUUID(), userId, name, transport: i.transport, command: i.command?.trim() ?? '', args: i.args ?? [], url: i.url?.trim() ?? '',
      secretKeys: Object.keys(secrets), enabled: i.enabled ?? true, createdAt: now(),
      ...(Object.keys(secrets).length ? { secretsEnc: this.box.encrypt(JSON.stringify(secrets)) } : {}),
    };
    await this.store.insertOne('mcpservers', doc);
    await this.audit.record(userId, 'mcp.add', name);
    return doc;
  }

  async setEnabled(userId: string, id: string, enabled: boolean): Promise<McpServerDoc> {
    await this.get(userId, id);
    await this.store.updateOne('mcpservers', { id, userId }, { $set: { enabled } });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const doc = await this.get(userId, id);
    await this.store.deleteMany('mcpservers', { id, userId });
    await this.audit.record(userId, 'mcp.remove', doc.name);
  }

  private toAgent(m: McpServerDoc): Record<string, unknown> {
    const secrets: Record<string, string> = m.secretsEnc ? (JSON.parse(this.box.decrypt(m.secretsEnc)) as Record<string, string>) : {};
    return {
      name: m.name, transport: m.transport, command: m.command, args: m.args, url: m.url, enabled: m.enabled,
      ...(m.transport === 'stdio' ? { env: secrets } : { headers: secrets }),
    };
  }

  /** Connects once through the agent service and stores the tool list (or the error) on the record. */
  async test(userId: string, id: string): Promise<McpServerDoc> {
    const m = await this.get(userId, id);
    let patch: Partial<McpServerDoc>;
    try {
      const res = (await this.agent.mcpInspect({ ...this.toAgent(m), enabled: true })) as { tools?: McpServerDoc['tools'] };
      patch = { tools: res.tools ?? [], lastCheck: { ok: true, at: now() } };
    } catch (e) {
      patch = { lastCheck: { ok: false, at: now(), error: e instanceof Error ? e.message.slice(0, 300) : 'Connection failed' } };
    }
    await this.store.updateOne('mcpservers', { id, userId }, { $set: patch });
    return this.get(userId, id);
  }

  /** Decrypted configs of the user's enabled servers, sent to the agent with each run. */
  async forRun(userId: string): Promise<Record<string, unknown>[]> {
    return (await this.list(userId)).filter((m) => m.enabled).map((m) => this.toAgent(m));
  }
}
