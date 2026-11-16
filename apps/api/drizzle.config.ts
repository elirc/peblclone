import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only diffs schema.ts against the last snapshot — it
// never connects to a database, so no credentials are needed here.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
