import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/client';
import { organizations } from '../db/schema';
import { REFERENCE_TABLES, resetTenantData, TENANT_TABLES } from './cleanup';
import { createTenant, createWorker } from './helpers';

/**
 * The guard that makes the hand-written table list in cleanup.ts safe.
 * Add a table to schema.ts, forget to add it to the list, and THIS fails —
 * with a message that says exactly what to do — instead of some unrelated
 * test failing weeks later because rows leaked from a previous test.
 */
describe('test database cleanup', () => {
  it('names every table in the schema', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const actual = result.rows.map((r) => r.table_name).sort();
    const listed = [...TENANT_TABLES, ...REFERENCE_TABLES].sort();
    expect(
      actual,
      'A table exists that src/test/cleanup.ts does not know about. Add it to TENANT_TABLES ' +
        '(before the tables it references) or to REFERENCE_TABLES.',
    ).toEqual(listed);
  });

  it('removes tenant data and keeps reference data', async () => {
    const { org } = await createTenant();
    await createWorker(org.id, {}, { withTasks: true });

    await resetTenantData();

    expect(await db.select().from(organizations)).toHaveLength(0);
    for (const table of TENANT_TABLES) {
      const rows = await db.execute<{ n: number }>(
        sql.raw(`select count(*)::int as n from "${table}"`),
      );
      expect(rows.rows[0]?.n, table).toBe(0);
    }
    const countries = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from countries`,
    );
    expect(countries.rows[0]?.n).toBeGreaterThan(0);
  });
});
