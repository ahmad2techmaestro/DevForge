import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import type { Container } from '../config/container.js';
import { AppError, badRequest } from '../utils/errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('validation_error', 'Invalid request', issues);
  }
  return result.data;
}

export function requireAuth(c: Pick<Container, 'auth'>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const userId = token ? c.auth.verify(token) : null;
    if (!userId) throw new AppError(401, 'unauthorized', 'Sign in required');
    req.userId = userId;
    next();
  };
}

export const uid = (req: Request): string => req.userId as string;

export function pageParams(query: Request['query']): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number.parseInt(String(query.limit ?? '20'), 10) || 20, 1), 100);
  const offset = Math.max(Number.parseInt(String(query.cursor ?? '0'), 10) || 0, 0);
  return { limit, offset };
}
