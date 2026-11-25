#!/usr/bin/env node
/**
 * npm run db:migrate - creates / updates the PostGIS schema (extensions, search tables, Redoz-owned
 * places). Needs DATABASE_URL (backend/.env or the environment). Safe to run again and on every deploy.
 * It does not import OpenStreetMap data: that is npm run db:import-osm.
 */
const config = require('../config');
const { createPostgres } = require('../db/postgres');
const { migrate } = require('../db/migrate');

async function main() {
  if (!config.postgres.url) {
    console.error('DATABASE_URL is not set. Example: postgresql://user:password@localhost:5432/redoz');
    process.exit(1);
  }
  const pg = createPostgres({ config: { ...config.postgres, statementTimeoutMs: 0 }, translateErrors: false });
  try {
    const { applied, skipped } = await migrate({ pg, schema: config.postgres.schema });
    console.log(`[db:migrate] done: ${applied.length} applied, ${skipped.length} already applied`);
  } catch (err) {
    console.error(`[db:migrate] failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pg.close();
  }
}

main();
