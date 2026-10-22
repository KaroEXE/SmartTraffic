const { bboxOfLines, padBBoxMeters, locateOnLine } = require('../../utils/geo');
const { trafficStatus } = require('./liveTrafficService');

/**
 * POST /api/v1/routes: road routes ranked by estimated travel time.
 *
 *   1. routes from the routing provider (routingService, cached)
 *   2. live AI delay per route at monitored intersections (liveTrafficService)
 *   3. community reports and operator closures / roadworks near each route
 *      (roadReportService, roadFeatureService), when the database is available
 *   4. ranked by traffic.adjustedDuration (= duration + live delay), distance
 *      breaking ties
 *
 * Step 1 is cached, steps 2-4 run on every request: an app re-sending the
 * same request gets fresh ETAs and ranking without new provider requests.
 *
 * Route (answer):
 *   { id, rank, geometry, distance, duration, summary,
 *     traffic: { basis: 'live-ai' | 'none', adjustedDuration, delay, updatedAt,
 *                intersections: [...], alerts: [...] },
 *     roadAlerts: [...], steps? }
 * basis 'live-ai': at least one live observation is in this route's
 * estimate. 'none': adjustedDuration = duration (no live data on the route).
 */

const ALERT_KINDS = ['road_closure', 'roadworks'];
const MAX_ALERT_CANDIDATES = 1000;

const FEATURE_MESSAGE = { road_closure: 'Road closed', roadworks: 'Roadworks' };

function createRoutePlanner({
  routing, liveTraffic, roadFeatures, roadReports, config, now = Date.now, log = console,
}) {
  const alertMeters = config.reports.routeAlertMeters;

  /** Reports and closures within alertMeters of each route. Resolves { byRoute: Map, status }. */
  async function roadAlerts(routes) {
    const byRoute = new Map(routes.map((r) => [r.id, []]));
    if (!roadReports.available() || !roadFeatures.available()) return { byRoute, status: 'unavailable' };
    const bbox = padBBoxMeters(bboxOfLines(routes.map((r) => r.geometry.coordinates)), alertMeters + 50);
    let reports;
    let features;
    try {
      [reports, features] = await Promise.all([
        roadReports.findInBBox(bbox, { limit: MAX_ALERT_CANDIDATES }),
        roadFeatures.findInBBox(bbox, { kinds: ALERT_KINDS, limit: MAX_ALERT_CANDIDATES }),
      ]);
    } catch (err) {
      log.warn(`[navigation] road alerts unavailable: ${err.message}`);
      return { byRoute, status: 'unavailable' };
    }
    const candidates = [
      ...reports.reports.map((r) => ({
        type: 'report',
        id: r.id,
        kind: r.type,
        lat: r.lat,
        lng: r.lng,
        verification: r.verification,
        confirmations: r.confirmations,
        expiresAt: r.expiresAt,
        message: `${r.label} reported by drivers${r.verification === 'verified' ? ' (verified)' : ''}`,
      })),
      ...features.features.map((f) => ({
        type: 'road_feature',
        id: f.id,
        kind: f.kind,
        lat: f.lat,
        lng: f.lng,
        verification: f.verification,
        validUntil: f.validUntil,
        message: `${FEATURE_MESSAGE[f.kind]}${f.name ? `: ${f.name}` : ''}`,
      })),
    ];
    for (const route of routes) {
      const line = route.geometry.coordinates;
      const list = byRoute.get(route.id);
      for (const c of candidates) {
        const { distanceMeters, alongMeters } = locateOnLine(c, line);
        if (distanceMeters <= alertMeters) {
          list.push({ ...c, alongMeters: Math.round(alongMeters), distanceFromRouteMeters: Math.round(distanceMeters) });
        }
      }
      list.sort((a, b) => a.alongMeters - b.alongMeters);
    }
    const truncated = reports.truncated || features.truncated;
    return { byRoute, status: truncated ? 'partial' : 'ok' };
  }

  return {
    async plan({
      start, destination, maxRoutes, steps,
    }) {
      const planned = await routing.route({
        start, destination, maxRoutes, steps,
      });
      const views = liveTraffic.views();
      const estimates = planned.routes.map((r) => liveTraffic.estimate(r, views));
      const alerts = await roadAlerts(planned.routes);

      const routes = planned.routes.map((r, i) => {
        const e = estimates[i];
        return {
          id: r.id,
          rank: 0,
          geometry: r.geometry,
          distance: r.distance,
          duration: r.duration,
          summary: r.summary,
          traffic: {
            basis: e.live ? 'live-ai' : 'none',
            adjustedDuration: Math.round((r.duration + e.delay) * 10) / 10,
            delay: e.delay,
            updatedAt: e.updatedAt,
            intersections: e.intersections,
            alerts: e.alerts,
          },
          roadAlerts: alerts.byRoute.get(r.id),
          ...(r.steps ? { steps: r.steps } : {}),
        };
      });
      routes.sort((a, b) => a.traffic.adjustedDuration - b.traffic.adjustedDuration || a.distance - b.distance);
      routes.forEach((r, i) => { r.rank = i + 1; });

      return {
        generatedAt: new Date(now()).toISOString(),
        cached: planned.cached,
        trafficStatus: trafficStatus(estimates),
        roadAlertsStatus: alerts.status,
        snapWarnings: planned.snapWarnings,
        routes,
      };
    },
  };
}

module.exports = { createRoutePlanner };
