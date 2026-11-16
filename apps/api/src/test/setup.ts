import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { config } from '../config';
import { db, pool } from '../db/client';
import { loginLimiter } from '../modules/auth/service';

/**
 * Runs inside every test file. Each test starts from the same known state:
 * all tenant data gone, reference data (countries, fx_rates) intact.
 *
 * TRUNCATE … CASCADE on the root tables clears every table that references
 * them, so new tables are covered automatically.
 */
beforeEach(async () => {
  if (!config.isTest) throw new Error('Test setup loaded outside NODE_ENV=test');
  await db.execute(
    sql`truncate table organizations, users, audit_logs restart identity cascade`,
  );
  await db.execute(sql`alter sequence invoice_number_seq restart`);
  loginLimiter.reset();
});

afterAll(async () => {
  await pool.end();
});
