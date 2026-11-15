import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AgentClient } from '../src/integrations/aiService.js';
import { ConfigError, loadConfig } from '../src/config/env.js';

const base = { NODE_ENV: 'test' };

describe('hosted configuration defaults', () => {
  it('uses the Render address as the public API URL when none is set', () => {
    const c = loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://devforge-api.onrender.com', AGENT_URL: 'https://a.example.com' });
    expect(c.apiPublicUrl).toBe('https://devforge-api.onrender.com');
  });

  it('allows the web origin when CORS_ORIGINS is not set', () => {
    const c = loadConfig({ ...base, WEB_ORIGIN: 'https://devforget.vercel.app' });
    expect(c.corsOrigins).toEqual(['https://devforget.vercel.app']);
  });

  it('fails fast on Render when AGENT_URL is missing', () => {
    expect(() => loadConfig({ ...base, RENDER: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RENDER: 'true' })).toThrow(/AGENT_URL/);
  });
});

describe('agent client errors', () => {
  it('tells the operator to copy the real address when the host answers 404', async () => {
    const srv = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('Not Found');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const client = new AgentClient({ agentUrl: `http://127.0.0.1:${port}`, internalKey: 'k', agentTimeoutMs: 2000, agentLongTimeoutMs: 2000, agentIndexTimeoutMs: 2000 });
    await expect(client.health()).rejects.toThrow(/not the agent.*AGENT_URL/);
    srv.close();
  });

  it('explains a 502 from a gateway and names the host only', async () => {
    const srv = createServer((_req, res) => {
      res.statusCode = 502;
      res.end('Bad Gateway');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const client = new AgentClient({ agentUrl: `http://127.0.0.1:${port}/private-path`, internalKey: 'k', agentTimeoutMs: 2000, agentLongTimeoutMs: 2000, agentIndexTimeoutMs: 2000 });
    await expect(client.health()).rejects.toThrow(/returned 502 \(127\.0\.0\.1:\d+\).*AGENT_URL/);
    await expect(client.health()).rejects.not.toThrow(/private-path/);
    srv.close();
  });
});
