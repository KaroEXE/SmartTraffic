#!/usr/bin/env node
/**
 * npm run db:import-osm [-- --file <path.osm.pbf>] [--cache <MB>] [--processes <n>] [--post-only]
 *
 * Loads an OpenStreetMap extract into PostgreSQL/PostGIS. A separate job, never part of the server
 * start. Two steps:
 *   1. osm2pgsql (flex output, db/osm/redoz.lua) bulk-loads osm_places, osm_roads, osm_addresses and
 *      osm_admin_areas. Millions of objects go through osm2pgsql, not through Node INSERTs.
 *   2. db/osm/post-import.sql rebuilds the derived search tables, in one transaction.
 *
 * Needs: DATABASE_URL, `npm run db:migrate` done, osm2pgsql >= 1.8 on PATH (or OSM2PGSQL_BIN), and the
 * extract (default: the only *.osm.pbf in the repository root, or OSM_PBF_PATH). The extract is never
 * committed to git (.gitignore) and never goes into the production image: import into the database
 * from a machine that has the file (see docs/GEO_DATABASE.md).
 *
 * --post-only skips step 1 and only rebuilds the derived tables from the osm_* tables already there.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');
const { createPostgres } = require('../db/postgres');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STYLE = path.join(__dirname, '..', 'db', 'osm', 'redoz.lua');
const POST_IMPORT = path.join(__dirname, '..', 'db', 'osm', 'post-import.sql');
const MIN_OSM2PGSQL = [1, 8];

function parseArgs(argv) {
  const out = { postOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--post-only') out.postOnly = true;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--cache') out.cache = Number(argv[++i]);
    else if (a === '--processes') out.processes = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function findExtract(explicit) {
  const wanted = explicit || process.env.OSM_PBF_PATH;
  if (wanted) {
    const full = path.resolve(wanted);
    if (!fs.existsSync(full)) throw new Error(`OSM file not found: ${full}`);
    return full;
  }
  const found = fs.readdirSync(REPO_ROOT).filter((f) => /\.osm\.pbf$/i.test(f));
  if (found.length === 1) return path.join(REPO_ROOT, found[0]);
  throw new Error(found.length ? `several .osm.pbf files in ${REPO_ROOT}: choose one with --file` : `no .osm.pbf file in ${REPO_ROOT}: pass --file or set OSM_PBF_PATH`);
}

function osm2pgsqlVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.error) throw new Error(`osm2pgsql was not found (${bin}). Install osm2pgsql >= ${MIN_OSM2PGSQL.join('.')} and put it on PATH, or set OSM2PGSQL_BIN.`);
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /osm2pgsql version (\d+)\.(\d+)\.(\d+)/i.exec(text);
  if (!m) throw new Error(`could not read the osm2pgsql version from: ${text.slice(0, 200)}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < MIN_OSM2PGSQL[0] || (major === MIN_OSM2PGSQL[0] && minor < MIN_OSM2PGSQL[1])) {
    throw new Error(`osm2pgsql ${m[1]}.${m[2]}.${m[3]} is too old: the style needs >= ${MIN_OSM2PGSQL.join('.')}`);
  }
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/** DATABASE_URL -> osm2pgsql connection arguments; the password goes in the environment, not on the command line. */
function connectionFor(url, ssl) {
  const u = new URL(url);
  const args = ['-d', decodeURIComponent(u.pathname.replace(/^\//, '')), '-H', u.hostname, '-P', u.port || '5432'];
  if (u.username) args.push('-U', decodeURIComponent(u.username));
  const env = { ...process.env };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  if (ssl === 'true' || ssl === 'require') env.PGSSLMODE = 'require';
  else if (ssl === 'no-verify') env.PGSSLMODE = 'require';
  return { args, env };
}

function run(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited with code ${code}`))));
  });
}

/**
 * `osm2pgsql --create` replaces everything it manages in the target schema: its helper tables (planet_osm_*)
 * and osm2pgsql_properties included. If that schema already holds an import that is not this style's (someone
 * else's data, or DATABASE_SCHEMA forgotten on a database that uses `public`), stop before anything is dropped.
 */
async function refuseForeignImport(pg, schema) {
  const found = await pg.query("SELECT to_regclass(quote_ident($1) || '.osm2pgsql_properties') AS t", [schema]);
  if (!found.rows[0].t) return;
  const { rows } = await pg.query(`SELECT property, value FROM "${schema}".osm2pgsql_properties WHERE property IN ('output', 'style')`);
  const value = Object.fromEntries(rows.map((r) => [r.property, r.value]));
  if (value.output === 'flex' && /redoz\.lua$/i.test(value.style || '')) return; // our own earlier import: re-importing is the point
  throw new Error(`schema "${schema}" already holds an osm2pgsql import that is not this one (output: ${value.output || 'unknown'}, style: ${value.style || 'unknown'}); `
    + 'importing here would drop its tables. Nothing was changed. Set DATABASE_SCHEMA=redoz (db:migrate and db:import-osm, and the running service) to keep this layer in its own schema.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!config.postgres.url) throw new Error('DATABASE_URL is not set');
  const pg = createPostgres({ config: { ...config.postgres, statementTimeoutMs: 0 }, translateErrors: false });
  let runId = null;
  try {
    const ready = await pg.query("SELECT to_regclass('search_entities') AS t, to_regclass('osm_import_runs') AS r");
    if (!ready.rows[0].t || !ready.rows[0].r) throw new Error('the schema is not there: run `npm run db:migrate` first');

    let file = '(post-import only)';
    let bytes = null;
    let version = null;
    if (!args.postOnly) {
      await refuseForeignImport(pg, config.postgres.schema || 'public');
      file = findExtract(args.file);
      bytes = fs.statSync(file).size;
      const bin = process.env.OSM2PGSQL_BIN || 'osm2pgsql';
      version = osm2pgsqlVersion(bin);
      console.log(`[db:import-osm] ${path.basename(file)} (${(bytes / 1048576).toFixed(1)} MB), osm2pgsql ${version}`);
      runId = (await pg.query('INSERT INTO osm_import_runs (source_file, file_bytes, tool_version) VALUES ($1, $2, $3) RETURNING id', [path.basename(file), bytes, version])).rows[0].id;

      const { args: conn, env } = connectionFor(config.postgres.url, config.postgres.ssl);
      const cache = Number.isFinite(args.cache) ? args.cache : 2000;
      const procs = Number.isFinite(args.processes) ? args.processes : 2;
      const started = Date.now();
      // --create replaces only the four osm_* tables of the style; --slim is needed for areas and
      // boundaries, --drop removes the slim helper tables afterwards (no updates are planned: a new
      // extract is re-imported whole).
      // DATABASE_SCHEMA puts the four tables, osm2pgsql's own properties table and its slim helper tables
      // in that schema (redoz.lua reads REDOZ_SCHEMA), so tables of the same name elsewhere are never touched.
      const schema = config.postgres.schema;
      const schemaArgs = schema ? ['--schema', schema] : [];
      await run(bin, ['--create', '--slim', '--drop', '--output=flex', `--style=${STYLE}`, `--cache=${cache}`, `--number-processes=${procs}`, ...schemaArgs, ...conn, file], { ...env, REDOZ_SCHEMA: schema });
      console.log(`[db:import-osm] osm2pgsql finished in ${Math.round((Date.now() - started) / 1000)} s`);
    } else {
      runId = (await pg.query("INSERT INTO osm_import_runs (source_file) VALUES ('(post-import only)') RETURNING id")).rows[0].id;
    }

    console.log('[db:import-osm] building the search tables (post-import.sql) ...');
    const started = Date.now();
    await pg.transaction((client) => client.query(fs.readFileSync(POST_IMPORT, 'utf8')));
    console.log(`[db:import-osm] search tables built in ${Math.round((Date.now() - started) / 1000)} s`);

    const counts = (await pg.query(`SELECT jsonb_build_object(
      'osm_places', (SELECT count(*) FROM osm_places),
      'osm_roads', (SELECT count(*) FROM osm_roads),
      'osm_addresses', (SELECT count(*) FROM osm_addresses),
      'osm_admin_areas', (SELECT count(*) FROM osm_admin_areas),
      'search_entities_poi', (SELECT count(*) FROM search_entities WHERE source = 'osm' AND entity = 'poi'),
      'search_entities_settlement', (SELECT count(*) FROM search_entities WHERE source = 'osm' AND entity = 'settlement'),
      'search_entities_street', (SELECT count(*) FROM search_entities WHERE source = 'osm' AND entity = 'street'),
      'search_entities_area', (SELECT count(*) FROM search_entities WHERE source = 'osm' AND entity = 'area'),
      'search_names', (SELECT count(*) FROM search_names),
      'database_bytes', pg_database_size(current_database())) AS c`)).rows[0].c;
    await pg.query("UPDATE osm_import_runs SET status = 'finished', finished_at = now(), counts = $2 WHERE id = $1", [runId, counts]);
    console.log('[db:import-osm] done:', JSON.stringify(counts, null, 2));
  } catch (err) {
    if (runId) await pg.query("UPDATE osm_import_runs SET status = 'failed', finished_at = now() WHERE id = $1", [runId]).catch(() => {});
    throw err;
  } finally {
    await pg.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[db:import-osm] failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { refuseForeignImport };
