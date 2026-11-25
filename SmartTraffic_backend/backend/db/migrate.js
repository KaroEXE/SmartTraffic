const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Applies db/migrations/*.sql, in file-name order, to a fresh or an existing PostgreSQL database.
 *
 *   - Each file runs once, in its own transaction, and is recorded in schema_migrations with its
 *     SHA-256. A recorded file whose content changed later is an error: add a new migration instead.
 *   - A transaction-level advisory lock makes two deploys migrating at once take turns.
 *   - Nothing is ever dropped: a migration that fails rolls back and leaves the database as it was.
 *
 * `pg` is the object from db/postgres.js. Used by scripts/dbMigrate.js (npm run db:migrate).
 */

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 7_262_026; // arbitrary, only has to be the same everywhere

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { name: file, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

async function migrate({
  pg, dir = MIGRATIONS_DIR, log = console, schema = '',
}) {
  // The connection's search_path already starts with `schema` (db/postgres.js); it only has to exist.
  if (schema) {
    await pg.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // PostGIS and pg_trgm belong in "public": osm2pgsql connects with the default search_path and must find
    // the geometry type there. Migration 001 would otherwise install them into the first schema of the path.
    // Already installed anywhere = nothing happens.
    await pg.query('CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public');
    await pg.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public');
  }
  await pg.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const applied = [];
  const skipped = [];
  for (const migration of listMigrations(dir)) {
    const done = await pg.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [migration.name]);
      if (rows.length) {
        if (rows[0].checksum !== migration.checksum) {
          throw new Error(`${migration.name} was applied before but has changed since. Do not edit applied migrations: add a new one.`);
        }
        return false;
      }
      await client.query(migration.sql); // several statements: simple query protocol
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
      return true;
    });
    (done ? applied : skipped).push(migration.name);
    log.log(`[db:migrate] ${done ? 'applied' : 'already applied'}  ${migration.name}`);
  }
  return { applied, skipped };
}

module.exports = { migrate, listMigrations, MIGRATIONS_DIR };
