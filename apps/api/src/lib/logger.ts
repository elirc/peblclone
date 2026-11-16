import pino from 'pino';
import { config } from '../config';

/**
 * Structured (JSON) logs. Machines parse them in production; `pino-pretty`
 * makes them readable in development. Secrets are redacted at the logger so no
 * call site can forget.
 */
export const logger = pino({
  level: config.isTest ? 'silent' : config.isProduction ? 'info' : 'debug',
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    remove: true,
  },
  transport:
    config.env === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
