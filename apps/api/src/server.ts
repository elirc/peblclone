import { createApp } from './app';
import { config } from './config';
import { pool } from './db/client';
import { logger } from './lib/logger';
import { deleteExpiredSessions } from './lib/sessions';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`Meridian API listening on http://localhost:${config.port}`);
});

server.on('error', (err) => {
  // e.g. EADDRINUSE: fail loudly instead of leaving a half-started process around.
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});

// Housekeeping: expired sessions are useless rows; sweep them hourly.
const sweep = setInterval(
  () => {
    deleteExpiredSessions().catch((err) => logger.warn({ err }, 'Session sweep failed'));
  },
  60 * 60 * 1000,
);
sweep.unref();

/** Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool. */
function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
