import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * Resetting the database between tests.
 *
 * The first version of this was one line:
 *   TRUNCATE organizations, users, audit_logs CASCADE
 * It is elegant (new tables are covered automatically) and it was measured at
 * ~350 ms per test on this machine — TRUNCATE takes heavy locks and rewrites
 * files for every table, however empty. With ~380 tests that is over two
 * minutes of pure cleanup.
 *
 * Plain DELETEs on near-empty tables take a few milliseconds in total. The
 * price is that the list below must name every table, children before parents.
 * `cleanup.test.ts` fails the build if a table is ever missing from it.
 */

/** Tenant-owned tables in deletion order: a table appears before anything it references. */
export const TENANT_TABLES = [
  'audit_logs',
  'invoice_lines',
  'invoices',
  'expenses',
  'payroll_items',
  'payroll_runs',
  'time_off_requests',
  'contracts',
  'quotes',
  'documents',
  'onboarding_tasks',
  'invitations',
  'sessions',
  'workers',
  'users',
  'organizations',
] as const;

/** Global reference data, loaded once per run and never reset. */
export const REFERENCE_TABLES = ['countries', 'fx_rates'] as const;

// One round trip for the whole reset. Table names are compile-time constants
// from the list above (never user input), so building the SQL text is safe.
const RESET_SQL = [
  ...TENANT_TABLES.map((table) => `delete from "${table}"`),
  'alter sequence invoice_number_seq restart',
].join('; ');

export async function resetTenantData(): Promise<void> {
  await db.execute(sql.raw(RESET_SQL));
}
