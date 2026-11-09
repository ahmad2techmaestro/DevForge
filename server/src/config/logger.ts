import { pino, type Logger } from 'pino';
import type { Config } from './env.js';

export type { Logger };

export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-internal-key"]',
        '*.token',
        '*.password',
        '*.passwordHash',
        '*.tokenEnc',
      ],
      censor: '[redacted]',
    },
  });
}
