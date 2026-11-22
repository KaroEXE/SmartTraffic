const { Pool } = require('pg');
const { ApiError } = require('../utils/apiError');

/**
 * PostgreSQL + PostGIS connection of the geographic layer (search, reverse geocoding, nearby
 * places, roads). MongoDB is untouched: it keeps users, reports, devices and traffic.
 *
 * The pool is created on first use, so the server starts (and every non-geographic endpoint
 * works) without DATABASE_URL, and without waiting for the database. Without DATABASE_URL a
 * geographic request is answered 503 FEATURE_DISABLED; a database that cannot be reached
 * gives 503 GEO_DATABASE_UNAVAILABLE. SQL lives in repositories/, never in controllers.
 */

/** DATABASE_SSL ("false" | "true" | "no-verify") -> the `ssl` option of pg. */
function sslOption(mode) {
  if (mode === 'true' || mode === 'require') return { rejectUnauthorized: true };
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return false;
}

/** Connection errors (not SQL mistakes) that mean "the database is not reachable right now". */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', '57P01', '57P02', '57P03', '53300', '08006', '08001', '08004', '28P01']);

function createPostgres({
  config, log = console, PoolImpl = Pool, translateErrors = true,
}) {
  const enabled = Boolean(config.url);
  let pool = null;

  function getPool() {
    if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', 'Place search is disabled: the geographic database is not configured (DATABASE_URL)');
    if (!pool) {
      pool = new PoolImpl({
        connectionString: config.url,
        ssl: sslOption(config.ssl),
        max: config.poolMax,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30_000,
        statement_timeout: config.statementTimeoutMs,
      });
      // An idle client that dies must not crash the process.
      pool.on('error', (err) => log.warn(`[postgres] idle client error: ${err.code || err.name}`));
    }
    return pool;
  }

  function translate(err) {
    if (!translateErrors || err instanceof ApiError) return err;
    if (err && (UNREACHABLE.has(err.code) || /timeout exceeded when trying to connect|Connection terminated/i.test(err.message || ''))) {
      log.warn(`[postgres] unreachable: ${err.code || err.message}`);
      return new ApiError(503, 'GEO_DATABASE_UNAVAILABLE', 'The geographic database is not reachable; try again later', { retryAfterSeconds: 10 });
    }
    if (err && (err.code === '42P01' || err.code === '42883')) { // undefined table / function: migrations or import not run
      log.warn(`[postgres] geographic schema incomplete: ${err.message}`);
      return new ApiError(503, 'GEO_DATA_NOT_READY', 'The geographic database is not set up yet (run npm run db:migrate and npm run db:import-osm)');
    }
    if (err && err.code === '57014') { // statement_timeout
      return new ApiError(503, 'GEO_QUERY_TIMEOUT', 'The geographic query took too long; try again', { retryAfterSeconds: 5 });
    }
    return err;
  }

  return {
    enabled,

    /** Runs one statement; resolves the pg result. */
    async query(text, params) {
      try {
        return await getPool().query(text, params);
      } catch (err) {
        throw translate(err);
      }
    },

    /** Runs `work(client)` in one transaction; `local` settings (SET LOCAL) end with it. */
    async transaction(work) {
      let client;
      try {
        client = await getPool().connect();
      } catch (err) {
        throw translate(err);
      }
      try {
        await client.query('BEGIN');
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw translate(err);
      } finally {
        client.release();
      }
    },

    /** Cheap reachability check for health endpoints; never throws. */
    async ping() {
      if (!enabled) return { enabled: false, connected: false };
      try {
        await getPool().query('SELECT 1');
        return { enabled: true, connected: true };
      } catch {
        return { enabled: true, connected: false };
      }
    },

    status() {
      return {
        enabled,
        pool: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null,
      };
    },

    async close() {
      if (pool) {
        const closing = pool;
        pool = null;
        await closing.end().catch(() => {});
      }
    },
  };
}

module.exports = { createPostgres, sslOption };
