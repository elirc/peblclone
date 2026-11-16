import type { ApiErrorBody } from '@meridian/shared';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export function notFoundHandler(req: Request, res: Response) {
  const body: ApiErrorBody = {
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  };
  res.status(404).json(body);
}

/**
 * The single place where errors become HTTP responses.
 * Express recognises an error handler by its four-argument signature.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    const body: ApiErrorBody = {
      error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
    };
    res.status(err.status).json(body);
    return;
  }

  // express.json() failures (malformed JSON, body too large) carry a status.
  const status = (err as { status?: number; statusCode?: number } | null)?.status;
  if (status === 400 || status === 413) {
    const body: ApiErrorBody = {
      error: {
        code: status === 413 ? 'payload_too_large' : 'bad_request',
        message: status === 413 ? 'Request body is too large' : 'Malformed JSON body',
      },
    };
    res.status(status).json(body);
    return;
  }

  // Unexpected: log everything, tell the client nothing.
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  const body: ApiErrorBody = {
    error: { code: 'internal_error', message: 'Something went wrong on our side' },
  };
  res.status(500).json(body);
}
