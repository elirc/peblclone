import { tooManyRequests } from './errors';

/**
 * A tiny fixed-window rate limiter, in process memory.
 *
 * Good enough to stop password guessing against one API instance. It is NOT
 * shared between instances and resets on restart — the moment this app runs on
 * more than one server, this must move to Redis or the database. That
 * limitation is recorded in the journal's "known gaps" list on purpose.
 */
interface Window {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: { limit: number; windowMs: number }) {
  const windows = new Map<string, Window>();

  return {
    /** Count one attempt for `key`; throws 429 once the limit is exceeded. */
    hit(key: string): void {
      const now = Date.now();
      const current = windows.get(key);
      if (!current || current.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return;
      }
      current.count += 1;
      if (current.count > options.limit) throw tooManyRequests();
    },
    /** Forget a key (e.g. after a successful login). */
    clear(key: string): void {
      windows.delete(key);
    },
    reset(): void {
      windows.clear();
    },
  };
}
