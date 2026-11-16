import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db, pool } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedReferenceData } from '../db/reference-data';

/**
 * Runs ONCE before the whole test run (in its own process):
 * wipe the test database, apply every migration from scratch, load reference data.
 *
 * Rebuilding from migrations each run means the migration files themselves are
 * tested on every `npm test` — a broken migration fails here, not in production.
 */
export default async function globalSetup() {
  const dbName = new URL(config.databaseUrl).pathname.slice(1);
  // Belt and braces: this function DROPS A SCHEMA. Refuse anything not obviously a test DB.
  if (!config.isTest || !dbName.includes('test')) {
    throw new Error(`Refusing to reset database "${dbName}": not a test database`);
  }

  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations();
  await seedReferenceData(db);
  await pool.end();
}
