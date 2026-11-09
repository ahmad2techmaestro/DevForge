import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Container } from './config/container.js';
import { AppError } from './utils/errors.js';
import { requireAuth } from './middleware/http.js';
import { accountRoutes, authRoutes } from './routes/account.js';
import { internalRoutes, opsRoutes, publicRoutes } from './routes/ops.js';
import { repoRoutes } from './routes/repos.js';
import { taskRoutes } from './routes/tasks.js';

const limitedResponse = {
  error: { code: 'rate_limited', message: 'Too many requests, slow down' },
};

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  if (c.config.trustProxy > 0) app.set('trust proxy', c.config.trustProxy);

  app.use((req, res, next) => {
    const id = req.header('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', id);
    (req as unknown as { id: string }).id = id;
    next();
  });
  app.use(pinoHttp({ logger: c.log, genReqId: (req) => (req as unknown as { id: string }).id, autoLogging: c.config.env !== 'test' }));
  app.use(helmet());
  app.use(cors({ origin: c.config.corsOrigins, allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }));
  app.use(c.metrics.middleware());
  app.use(
    express.json({
      limit: '1mb',
      // Webhook signatures are computed over the exact bytes GitHub sent.
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  app.use(publicRoutes(c));
  app.use('/internal', internalRoutes(c));

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: c.config.rateLimitAuthPerMin,
    standardHeaders: true,
    legacyHeaders: false,
    message: limitedResponse,
  });
  app.use('/api/auth', authRoutes(c, authLimiter));

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: c.config.rateLimitApiPerMin,
    standardHeaders: true,
    legacyHeaders: false,
    message: limitedResponse,
    keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? ''),
  });
  app.use('/api', requireAuth(c), apiLimiter);
  app.use('/api', accountRoutes(c), opsRoutes(c));
  app.use('/api/repos', repoRoutes(c));
  app.use('/api/tasks', taskRoutes(c));

  app.use((_req, _res, next) => next(new AppError(404, 'not_found', 'Route not found')));
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
      return;
    }
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 500) c.log.error({ err: (err as Error).message, stack: (err as Error).stack, path: req.path }, 'unhandled error');
    res.status(status >= 500 ? 500 : status).json({ error: { code: status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Something went wrong' : (err as Error).message } });
  };
  app.use(onError);
  return app;
}
