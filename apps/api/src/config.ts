import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * All configuration is read, validated and frozen here, once, at startup.
 * Nothing else in the codebase touches `process.env`. If a variable is missing
 * or malformed the process refuses to start with a readable message — far
 * better than discovering `undefined` in a connection string at 2am.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://postgres:postgres@localhost:5443/meridian_dev'),
  TEST_DATABASE_URL: z
    .string()
    .url()
    .default('postgres://postgres:postgres@localhost:5443/meridian_test'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(168),
  STORAGE_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}
const env = parsed.data;
const isTest = env.NODE_ENV === 'test';

export const config = Object.freeze({
  env: env.NODE_ENV,
  isTest,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  /** Tests ALWAYS get the test database; there is no way to point a test at dev data. */
  databaseUrl: isTest ? env.TEST_DATABASE_URL : env.DATABASE_URL,
  webOrigin: env.WEB_ORIGIN.replace(/\/$/, ''),
  sessionTtlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  storageDir: env.STORAGE_DIR ?? path.join(repoRoot, 'apps/api/storage', isTest ? 'test' : 'dev'),
  /** Explicit override; otherwise the logger picks a level per environment. */
  logLevel: env.LOG_LEVEL,
  repoRoot,
});
