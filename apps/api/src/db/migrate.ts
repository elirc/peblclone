import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from '../config';
import { db, pool } from './client';

export const migrationsFolder = path.join(config.repoRoot, 'apps/api/drizzle');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}

// Run directly: `npm run db:migrate`
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  runMigrations()
    .then(() =>
      console.log(`Migrations applied to ${new URL(config.databaseUrl).pathname.slice(1)}`),
    )
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
