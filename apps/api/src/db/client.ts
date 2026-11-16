import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config';
import * as schema from './schema';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
/** The transaction handle drizzle passes to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/**
 * Most service helpers accept either, so the same function can run standalone
 * or join a caller's transaction. Rule of thumb: any operation that writes more
 * than one row takes a `Tx`, so it all commits or none of it does.
 */
export type DbOrTx = Db | Tx;

export { schema };
