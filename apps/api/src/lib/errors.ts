/**
 * One error type for every *expected* failure (bad input, not found, not
 * allowed, conflict). Services throw these; the error middleware turns them
 * into the JSON envelope `{ error: { code, message, details? } }`.
 *
 * Anything that is NOT an AppError is a bug or an outage: it is logged with a
 * stack trace and the client gets a generic 500 with no internals.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new AppError(400, code, message);

export const validationError = (details: Record<string, string[]>, message = 'Invalid request') =>
  new AppError(400, 'validation_error', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'forbidden', message);

/**
 * Also used when a record exists but belongs to another tenant: answering 403
 * there would confirm the id is real. "Not found" leaks nothing.
 */
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);

export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);

export const tooManyRequests = (message = 'Too many attempts. Try again shortly.') =>
  new AppError(429, 'rate_limited', message);

/** Postgres unique-violation check, for turning a constraint error into a friendly 409. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  // drizzle wraps driver errors; the pg error may be on `.cause`.
  const candidates = [err, (err as { cause?: unknown } | null)?.cause];
  return candidates.some((e) => {
    const pgErr = e as { code?: string; constraint?: string } | null | undefined;
    return pgErr?.code === '23505' && (constraint === undefined || pgErr.constraint === constraint);
  });
}
