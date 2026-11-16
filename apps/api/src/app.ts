import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { originCheck } from './middleware/security';
import { moduleRouters } from './modules';

/**
 * Build the Express app. A factory (rather than a module-level singleton that
 * also calls `listen`) lets tests create the app in-process with supertest —
 * no ports, no network.
 *
 * Middleware order is the request pipeline, top to bottom:
 *   security headers -> logging -> cookies -> JSON body -> CSRF origin check
 *   -> routes -> 404 -> error handler
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy in production; makes req.ip the real client address.
  app.set('trust proxy', config.isProduction ? 1 : false);

  app.use(helmet());
  if (!config.isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/v1/health' } }));
  }
  app.use(cookieParser());
  // 8mb: document uploads arrive as base64 inside JSON (5 MB file ≈ 6.7 MB of base64).
  app.use(express.json({ limit: '8mb' }));
  app.use(originCheck);

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Every module declares its own full paths (e.g. '/workers/:id'), so mounting
  // is uniform and adding a module is a one-line change in modules/index.ts.
  for (const router of moduleRouters) {
    app.use('/api/v1', router);
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
