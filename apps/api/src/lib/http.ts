import type { Paginated } from '@meridian/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { validationError } from './errors';

function toDetails(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/** Validate `req.body` against a shared schema. Throws a 400 with per-field details. */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) throw validationError(toDetails(result.error));
  return result.data;
}

/** Validate `req.query`. Query values arrive as strings; schemas use `z.coerce` where needed. */
export function parseQuery<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) throw validationError(toDetails(result.error), 'Invalid query parameters');
  return result.data;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Read a UUID path parameter. A malformed id is a 400 here rather than a
 * Postgres "invalid input syntax for type uuid" 500 later.
 */
export function uuidParam(req: Request, name = 'id'): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw validationError({ [name]: ['Expected a UUID'] });
  }
  return value;
}

export function paginated<T>(
  items: T[],
  total: number,
  page: { limit: number; offset: number },
): Paginated<T> {
  return { items, total, limit: page.limit, offset: page.offset };
}

/** Date -> ISO string, preserving null. Used by every row -> DTO mapper. */
export function iso(value: Date): string;
export function iso(value: Date | null): string | null;
export function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
