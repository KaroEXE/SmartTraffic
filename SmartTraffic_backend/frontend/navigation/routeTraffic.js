import { distanceToPolylineMeters } from './geo.js';

/**
 * Relates routes to live observations at monitored intersections (no DOM).
 *
 * This does not estimate travel time. It only reports which monitored
 * intersections a route passes and what was actually observed there; any
 * ETA adjustment must come from the backend (routeService.js).
 */

/**
 * For one route: monitored intersections within `routeMatchMeters` of the
 * line, in order of distance, plus long-queue alerts from live observations.
 * Takes NAV_CONFIG.traffic.
 */
export function matchRouteToTraffic(route, intersections, { routeMatchMeters, longQueueVehicles }) {
  const monitored = [];
  for (const ix of intersections) {
    if (!ix.located) continue;
    const d = distanceToPolylineMeters({ lat: ix.lat, lng: ix.lng }, route.coordinates);
    if (d <= routeMatchMeters) monitored.push({ intersection: ix, distanceMeters: d });
  }
  monitored.sort((a, b) => a.distanceMeters - b.distanceMeters);

  const alerts = [];
  for (const { intersection: ix } of monitored) {
    if (ix.status !== 'live') continue;
    if (ix.emergency) {
      alerts.push({ key: `${ix.id}:emergency`, kind: 'emergency', intersectionId: ix.id, name: ix.name, emergency: ix.emergency, ageSeconds: ix.ageSeconds });
    }
    if (ix.longestQueue && ix.longestQueue.vehicles >= longQueueVehicles) {
      alerts.push({ key: `${ix.id}:queue`, kind: 'long-queue', intersectionId: ix.id, name: ix.name, direction: ix.longestQueue.direction, vehicles: ix.longestQueue.vehicles, ageSeconds: ix.ageSeconds });
    }
  }
  return { monitored, alerts };
}

/**
 * Rerouting suggestion from data that actually exists.
 *
 * With backend adjustments on every route: suggest the route whose adjusted
 * ETA is at least `minSavingSeconds` better than the selected one.
 * Without them: when the selected route has a new live alert, point to an
 * alternative that does not pass that intersection (no time claim made).
 */
export function findRerouteSuggestion({ routes, selectedId, matches, seenAlertKeys, minSavingSeconds = 60 }) {
  const selected = routes.find((r) => r.id === selectedId);
  if (!selected || routes.length < 2) return null;

  if (routes.every((r) => r.traffic)) {
    let best = null;
    for (const r of routes) {
      if (r.id !== selected.id && (!best || r.traffic.adjustedDuration < best.traffic.adjustedDuration)) best = r;
    }
    const saving = best ? selected.traffic.adjustedDuration - best.traffic.adjustedDuration : 0;
    if (best && saving >= minSavingSeconds) {
      return { kind: 'faster', routeId: best.id, savingSeconds: saving, key: `faster:${best.id}:${Math.round(saving / 60)}` };
    }
    return null;
  }

  const selectedAlerts = (matches.get(selected.id) || { alerts: [] }).alerts;
  const fresh = selectedAlerts.find((a) => !seenAlertKeys.has(a.key));
  if (!fresh) return null;
  const avoiding = routes.find((r) => r.id !== selected.id
    && !(matches.get(r.id) || { monitored: [] }).monitored.some((m) => m.intersection.id === fresh.intersectionId));
  return avoiding
    ? { kind: 'avoid', routeId: avoiding.id, alert: fresh, key: fresh.key }
    : { kind: 'notice', routeId: null, alert: fresh, key: fresh.key };
}
