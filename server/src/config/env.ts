import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export type OAuthCreds = { clientId: string; clientSecret: string };
const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789';
const DEV_INTERNAL_KEY = 'dev-internal-key';
const DEV_ENCRYPTION_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  DB_DRIVER: z.enum(['mongo', 'memory']).default('mongo'),
  DB_FILE: z.string().optional(),
  MONGO_URL: z.string().default('mongodb://localhost:27017'),
  MONGO_DB: z.string().default('devforge'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  AGENT_URL: z.string().url().default('http://localhost:8000'),
  INTERNAL_KEY: z.string().min(8).optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').optional(),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes as 64 hex characters')
    .optional(),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080'),
  OAUTH_REDIRECT_BASE: z.string().url().optional(),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  ALLOW_LOCAL_REPOS: bool.default(false),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_CLONE_BASE: z.string().url().default('https://github.com'),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().min(1).default(300),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  QUEUE_NAME: z.string().default('devforge-runs'),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  QUEUE_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  QUEUE_BACKOFF_MS: z.coerce.number().int().min(0).default(2000),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
  AGENT_LONG_TIMEOUT_MS: z.coerce.number().int().min(100).default(180_000),
  AGENT_INDEX_TIMEOUT_MS: z.coerce.number().int().min(100).default(600_000),
  GITHUB_WEBHOOK_SECRET: z.string().min(8).optional(),
  WEBHOOK_LABEL: z.string().min(1).max(50).default('devforge'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: string;
  dbDriver: 'mongo' | 'memory';
  dbFile?: string;
  mongoUrl: string;
  mongoDb: string;
  redisUrl: string;
  agentUrl: string;
  internalKey: string;
  jwtSecret: string;
  encryptionKey: string;
  corsOrigins: string[];
  webOrigin: string;
  oauthRedirectBase: string;
  oauth: { google: OAuthCreds | null; github: OAuthCreds | null };
  apiPublicUrl: string;
  allowLocalRepos: boolean;
  githubApiUrl: string;
  githubCloneBase: string;
  bcryptCost: number;
  rateLimitAuthPerMin: number;
  rateLimitApiPerMin: number;
  trustProxy: number;
  queueName: string;
  queueConcurrency: number;
  queueAttempts: number;
  queueBackoffMs: number;
  agentTimeoutMs: number;
  agentLongTimeoutMs: number;
  agentIndexTimeoutMs: number;
  /** HMAC secret for /webhooks/github. Webhooks are disabled when unset. */
  githubWebhookSecret?: string;
  webhookLabel: string;
}

export class ConfigError extends Error {}

const trimSlash = (u: string): string => u.replace(/\/+$/, '');

/** Validates the environment. Error messages list variable names and reasons, never values. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== '') cleaned[k] = v;
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  if (prod) {
    const missing = (['JWT_SECRET', 'INTERNAL_KEY', 'ENCRYPTION_KEY'] as const).filter((k) => !e[k]);
    if (missing.length > 0) {
      throw new ConfigError(`Missing required environment variables in production: ${missing.join(', ')}`);
    }
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    dbDriver: e.DB_DRIVER,
    ...(e.DB_FILE ? { dbFile: e.DB_FILE } : {}),
    mongoUrl: e.MONGO_URL,
    mongoDb: e.MONGO_DB,
    redisUrl: e.REDIS_URL,
    agentUrl: trimSlash(e.AGENT_URL),
    internalKey: e.INTERNAL_KEY ?? DEV_INTERNAL_KEY,
    jwtSecret: e.JWT_SECRET ?? DEV_JWT_SECRET,
    encryptionKey: e.ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    apiPublicUrl: trimSlash(e.API_PUBLIC_URL),
    webOrigin: trimSlash(e.WEB_ORIGIN),
    oauthRedirectBase: trimSlash(e.OAUTH_REDIRECT_BASE ?? e.API_PUBLIC_URL),
    oauth: {
      google: e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } : null,
      github: e.GITHUB_OAUTH_CLIENT_ID && e.GITHUB_OAUTH_CLIENT_SECRET ? { clientId: e.GITHUB_OAUTH_CLIENT_ID, clientSecret: e.GITHUB_OAUTH_CLIENT_SECRET } : null,
    },
    allowLocalRepos: e.ALLOW_LOCAL_REPOS,
    githubApiUrl: trimSlash(e.GITHUB_API_URL),
    githubCloneBase: trimSlash(e.GITHUB_CLONE_BASE),
    bcryptCost: e.BCRYPT_COST,
    rateLimitAuthPerMin: e.RATE_LIMIT_AUTH_PER_MIN,
    rateLimitApiPerMin: e.RATE_LIMIT_API_PER_MIN,
    trustProxy: e.TRUST_PROXY,
    queueName: e.QUEUE_NAME,
    queueConcurrency: e.QUEUE_CONCURRENCY,
    queueAttempts: e.QUEUE_ATTEMPTS,
    queueBackoffMs: e.QUEUE_BACKOFF_MS,
    agentTimeoutMs: e.AGENT_TIMEOUT_MS,
    agentLongTimeoutMs: e.AGENT_LONG_TIMEOUT_MS,
    agentIndexTimeoutMs: e.AGENT_INDEX_TIMEOUT_MS,
    ...(e.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: e.GITHUB_WEBHOOK_SECRET } : {}),
    webhookLabel: e.WEBHOOK_LABEL,
  };
}
