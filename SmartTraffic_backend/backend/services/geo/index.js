const { createPostgres } = require('../../db/postgres');
const { createGeoRepository } = require('../../repositories/geoRepository');
const { createGeoService } = require('./geoService');
const { createGeoController } = require('../../controllers/geoController');
const { createGeoRoutes } = require('../../routes/geoRoutes');

/**
 * Builds the geographic API: Postgres pool (lazy) -> repository (SQL) -> service -> controller -> router.
 * server.js mounts `router` at /api and passes `service` to the mobile navigation API; tests pass a
 * `pg` pointed at a real database, or a `service` of their own for unit tests.
 */
function createGeoApi({
  config, pg = createPostgres({ config: config.postgres }), now = Date.now,
}) {
  const repository = createGeoRepository({ pg });
  const service = createGeoService({ repository, enabled: pg.enabled });
  const controller = createGeoController({ geo: service });
  const router = createGeoRoutes({ controller, rateLimits: config.navigation.rateLimits, now });
  return {
    router,
    service,
    repository,
    pg,
    status: () => pg.status(),
    close: () => pg.close(),
  };
}

/** Startup warning for a deployment without the geographic database. */
function geoWarnings(postgres) {
  return postgres.url ? [] : ['DATABASE_URL is not set: place search, reverse geocoding and nearby places are disabled (they run on PostgreSQL/PostGIS).'];
}

module.exports = { createGeoApi, geoWarnings };
