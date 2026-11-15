import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { buildContainer } from './config/container.js';
import { createLogger } from './config/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  if (config.env === 'production' && config.dbDriver === 'memory') log.warn('DB_DRIVER=memory is for development only');
  const container = await buildContainer(config, log);
  const app = createApp(container);
  const server = app.listen(config.port, config.host, () => log.info({ port: config.port, db: config.dbDriver }, 'devforge api listening'));
  container.hub.attach(server);

  // Say in the log whether the agent can be reached, so a wrong AGENT_URL shows up at startup.
  void container.agent
    .health()
    .then((h) => log.info({ provider: h.provider, model: h.model, sandbox: h.sandbox }, 'agent service reachable'))
    .catch((err: unknown) => log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'agent service NOT reachable: check AGENT_URL'));

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    server.close();
    await container.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
