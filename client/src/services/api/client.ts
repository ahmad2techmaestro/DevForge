import { API_URL } from '../../config/index';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/** Turns any failed response into an ApiError with a stable code and a human-readable message. */
export async function toApiError(res: Response): Promise<ApiError> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  if (isErrorBody(parsed) && parsed.error && typeof parsed.error.message === 'string') {
    const code = typeof parsed.error.code === 'string' ? parsed.error.code : `http_${res.status}`;
    return new ApiError(res.status, code, parsed.error.message, parsed.error.details);
  }
  return new ApiError(res.status, `http_${res.status}`, res.statusText || `Request failed with status ${res.status}`);
}

type Query = Record<string, string | number | undefined | null>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

let tokenProvider: () => string | null = () => null;
let unauthorizedHandler: () => void = () => undefined;

export function configureClient(opts: { getToken: () => string | null; onUnauthorized: () => void }): void {
  tokenProvider = opts.getToken;
  unauthorizedHandler = opts.onUnauthorized;
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(API_URL + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', `Can't reach the DevForge API at ${API_URL}. Check that it is running.`);
  }

  if (!res.ok) {
    const error = await toApiError(res);
    if (res.status === 401 && token && !path.startsWith('/api/auth/')) unauthorizedHandler();
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const http = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  del: <T>(path: string) => request<T>('DELETE', path),
};
