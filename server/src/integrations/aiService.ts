import type { Config } from '../config/env.js';
import { AppError } from '../utils/errors.js';

type Json = Record<string, unknown>;

export interface AgentHealth {
  status: string;
  provider: string;
  model: string;
  sandbox: string;
  dockerAvailable: boolean;
  version: string;
}

export interface IndexResult {
  repoId: string;
  commit: string;
  branch: string;
  fileCount: number;
  totalLines: number;
  languages: Record<string, { files: number; lines: number }>;
  summary: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Thin typed HTTP client for the Python agent service. */
export class AgentClient {
  constructor(private readonly config: Pick<Config, 'agentUrl' | 'internalKey' | 'agentTimeoutMs' | 'agentLongTimeoutMs' | 'agentIndexTimeoutMs'>) {}

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.config.agentTimeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.agentUrl}${path}`, {
        method,
        headers: {
          'X-Internal-Key': this.config.internalKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new AppError(502, 'agent_unavailable', timedOut ? 'Agent service timed out' : 'Agent service is unreachable');
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const err = (parsed as { error?: { code?: string; message?: string } }).error;
      const status = res.status >= 500 ? 502 : res.status;
      throw new AppError(status, err?.code ?? 'agent_error', err?.message ?? `Agent service returned ${res.status}`);
    }
    return parsed as T;
  }

  private repo(id: string): string {
    return `/repos/${encodeURIComponent(id)}`;
  }

  private run(id: string): string {
    return `/runs/${encodeURIComponent(id)}`;
  }

  health = (): Promise<AgentHealth> => this.request('GET', '/health', undefined, 8000);

  async reachable(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }

  indexRepo = (body: Json): Promise<IndexResult> => this.request('POST', '/repos/index', body, this.config.agentIndexTimeoutMs);
  deleteRepo = (id: string): Promise<Json> => this.request('DELETE', this.repo(id));
  tree = (id: string): Promise<Json> => this.request('GET', `${this.repo(id)}/tree`);
  file = (id: string, path: string): Promise<Json> => this.request('GET', `${this.repo(id)}/file?path=${encodeURIComponent(path)}`);
  graph = (id: string): Promise<Json> => this.request('GET', `${this.repo(id)}/graph`);
  repoHealth = (id: string): Promise<Json & { score: number; grade: string }> =>
    this.request('GET', `${this.repo(id)}/health`, undefined, this.config.agentLongTimeoutMs);
  search = (id: string, body: Json): Promise<Json> => this.request('POST', `${this.repo(id)}/search`, body);
  explain = (id: string, body: Json): Promise<Json & { usage?: Usage }> =>
    this.request('POST', `${this.repo(id)}/explain`, body, this.config.agentLongTimeoutMs);
  chat = (id: string, body: Json): Promise<Json & { answer: string; citations?: { path: string; line: number }[]; usage?: Usage }> =>
    this.request('POST', `${this.repo(id)}/chat`, body, this.config.agentLongTimeoutMs);
  bugs = (id: string, body: Json): Promise<Json & { usage?: Usage }> =>
    this.request('POST', `${this.repo(id)}/bugs`, body, this.config.agentLongTimeoutMs);

  security = (id: string): Promise<Json & { usage?: Usage }> =>
    this.request('POST', `${this.repo(id)}/security`, {}, this.config.agentLongTimeoutMs);

  semanticSearch = (id: string, q: string, mode: string, limit: number, rerank = false): Promise<Json> =>
    this.request('GET', `${this.repo(id)}/semantic-search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}&limit=${limit}&rerank=${rerank}`, undefined, this.config.agentLongTimeoutMs);
  symbols = (id: string, path?: string): Promise<Json> => this.request('GET', `${this.repo(id)}/symbols${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  impact = (id: string, path: string, symbol?: string): Promise<Json> =>
    this.request('GET', `${this.repo(id)}/impact?path=${encodeURIComponent(path)}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`);
  callgraph = (id: string, path?: string): Promise<Json> => this.request('GET', `${this.repo(id)}/callgraph${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  reviewPr = (body: Json): Promise<Json & { usage?: Usage }> => this.request('POST', '/reviews/pr', body, this.config.agentLongTimeoutMs);
  analyzeCi = (body: Json): Promise<Json> => this.request('POST', '/ci/analyze', body, this.config.agentLongTimeoutMs);
  llmCheck = (): Promise<Json> => this.request('GET', '/llm/check', undefined, this.config.agentLongTimeoutMs);
  mcpInspect = (body: Json): Promise<Json> => this.request('POST', '/mcp/inspect', body, 30_000);
  evalLatest = (): Promise<Json> => this.request('GET', '/eval/latest');
  evalRun = (limit?: number): Promise<Json> => this.request('POST', '/eval/run', limit ? { limit } : {});
  evalStatus = (): Promise<Json> => this.request('GET', '/eval/status');

  createRun = (body: Json): Promise<Json> => this.request('POST', '/runs', body);
  approve = (runId: string, body: Json): Promise<Json> => this.request('POST', `${this.run(runId)}/approve`, body);
  cancel = (runId: string): Promise<Json> => this.request('POST', `${this.run(runId)}/cancel`, {});
  diff = (runId: string): Promise<Json> => this.request('GET', `${this.run(runId)}/diff`);
  commit = (runId: string, body: Json): Promise<Json> => this.request('POST', `${this.run(runId)}/commit`, body, this.config.agentLongTimeoutMs);
  push = (runId: string, body: Json): Promise<Json> => this.request('POST', `${this.run(runId)}/push`, body, this.config.agentLongTimeoutMs);
}
