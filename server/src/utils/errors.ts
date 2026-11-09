/** An error that is safe to show to the client. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource'): AppError => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string): AppError => new AppError(409, code, message);
export const badRequest = (code: string, message: string, details?: unknown): AppError =>
  new AppError(400, code, message, details);

/** Thrown by stores when a unique index is violated. */
export class DuplicateKeyError extends Error {
  constructor(readonly collection: string, message = 'Duplicate key') {
    super(`${message} in ${collection}`);
    this.name = 'DuplicateKeyError';
  }
}
