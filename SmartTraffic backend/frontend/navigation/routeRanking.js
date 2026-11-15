import { distanceMeters, distanceToPolylineMeters } from './geo.js';

/**
 * Route ranking with live AI traffic (no DOM, no network).
 *
 *   estimate = routing provider's travel time (free-flow, no provider traffic)
 *            + live delay at every AI-monitored intersection the route passes
 *
 * Live delay at one intersection comes from the AI service's latest
 * observation of the approach the route enters by (the same data the Node
 * backend broadcasts to the dashboard):
 *
 *   delay = mean waiting time of the vehicles stopped on that approach
 *         + vehicles on that approach x `secondsPerVehicle`
 *
 * `secondsPerVehicle` (default 2 s) is one saturation headway: the time
 * each vehicle ahead takes to clear the stop line. Intersections without
 * fresh data, or an approach whose camera video is unavailable, add nothing
 * and are reported as such; nothing is guessed in their place.
 */

const DIRECTIONS = ['north', 'south', 'east', 'west'];

// Best -> worst. Fewer than four routes take evenly spaced colours, so the
// best is always green and the worst always red.
export const RANK_COLORS = ['#2ea043', '#a3c23a', '#f08c2e', '#e5484d'];

export function rankColor(position, total) {
  if (total <= 1) return RANK_COLORS[0];
  return RANK_COLORS[Math.round((position * (RANK_COLORS.length - 1)) / (total - 1))];
}

/** "Best", "2nd best", "3rd best", ..., and "Slowest" for the last of several. */
export function rankLabel(position, total) {
  if (position === 0) return 'Best';
  if (position === total - 1) return 'Slowest';
  return `${position + 1}${['', 'nd', 'rd'][position] || 'th'} best`;
}

// ----------------------------------------------------------------- geometry

const toPoint = ([lat, lng]) => ({ lat, lng });

/** Compass bearing in degrees (0 = north, clockwise) from a to b. */
export function bearingDegrees(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad)
    - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

/**
 * Approach (where the vehicle comes from, as the AI service names it) by
 * which the route enters `point`: travelling south means entering from the
 * north approach. Null when the route starts at the intersection.
 */
export function approachDirection(coords, point, { backM = 60 } = {}) {
  if (!coords || coords.length < 2) return null;
  let closest = 0;
  let best = Infinity;
  coords.forEach((c, i) => {
    const d = distanceMeters(toPoint(c), point);
    if (d < best) { best = d; closest = i; }
  });
  let i = closest;
  let walked = 0;
  while (i > 0 && walked < backM) {
    walked += distanceMeters(toPoint(coords[i - 1]), toPoint(coords[i]));
    i -= 1;
  }
  if (walked < 10) return null;
  const heading = bearingDegrees(toPoint(coords[i]), toPoint(coords[closest]));
  if (heading >= 315 || heading < 45) return 'south'; // heading north: came from the south
  if (heading < 135) return 'west';
  if (heading < 225) return 'north';
  return 'east';
}

/**
 * Travel-time estimate for one route.
 *   views: trafficStore.list() (monitored intersections with their latest
 *          observation and status)
 * Returns { duration, baseDuration, delay, live, intersections: [...] }.
 * `live` is true when at least one live observation was included.
 */
export function estimateRoute(route, views, { routeMatchMeters = 60, secondsPerVehicle = 2 } = {}) {
  const intersections = [];
  let delay = 0;
  let live = false;
  for (const ix of views) {
    if (!ix.located) continue;
    if (distanceToPolylineMeters({ lat: ix.lat, lng: ix.lng }, route.coordinates) > routeMatchMeters) continue;
    const entry = { id: ix.id, name: ix.name, status: ix.status, approach: null, delay: 0, included: false, reason: null };
    if (ix.status !== 'live' || !ix.approaches) {
      entry.reason = 'no live data';
    } else {
      const approach = approachDirection(route.coordinates, { lat: ix.lat, lng: ix.lng });
      const candidates = approach ? [approach] : DIRECTIONS;
      const measured = candidates
        .map((d) => ({ d, a: ix.approaches[d] }))
        .filter(({ a }) => a && Number.isFinite(a.vehicles));
      entry.approach = approach;
      if (!measured.length) {
        entry.reason = 'video unavailable';
      } else {
        // Unknown approach (route starts here): the average of the measured ones.
        const each = measured.map(({ a }) => (Number.isFinite(a.waitingTime) ? a.waitingTime : 0) + a.vehicles * secondsPerVehicle);
        entry.delay = each.reduce((s, x) => s + x, 0) / each.length;
        entry.vehicles = measured.reduce((s, { a }) => s + a.vehicles, 0) / measured.length;
        entry.included = true;
        delay += entry.delay;
        live = true;
      }
    }
    intersections.push(entry);
  }
  return { baseDuration: route.duration, delay, duration: route.duration + delay, live, intersections };
}

/**
 * Order of route ids, fastest first; distance breaks ties. With a previous
 * order, two routes only swap when the change is larger than
 * `hysteresisSeconds`, so near-equal routes do not flicker on every update.
 */
export function orderRoutes(routes, estimates, previous = null, { hysteresisSeconds = 5 } = {}) {
  const time = (id) => Math.round(estimates.get(id).duration);
  const dist = (id) => routes.find((r) => r.id === id).distance;
  const ids = routes.map((r) => r.id);
  const fresh = [...ids].sort((a, b) => time(a) - time(b) || dist(a) - dist(b));
  if (!previous) return fresh;
  // Keep the previous order for routes still present, new routes by time.
  const order = previous.filter((id) => ids.includes(id));
  for (const id of fresh) if (!order.includes(id)) order.push(id);
  // Insertion sort that only moves a route ahead of another when it is
  // clearly faster (or equally fast and shorter, beyond the threshold).
  for (let i = 1; i < order.length; i += 1) {
    let j = i;
    while (j > 0 && time(order[j - 1]) - time(order[j]) > hysteresisSeconds) {
      [order[j - 1], order[j]] = [order[j], order[j - 1]];
      j -= 1;
    }
  }
  return order;
}

/**
 * Whether live traffic is part of the estimates right now:
 *   'included'     at least one route's estimate contains live AI data
 *   'unavailable'  a route passes a monitored intersection without live data
 *   'not-on-route' no route passes an AI-monitored intersection
 */
export function liveStatus(estimates) {
  const all = [...estimates.values()];
  if (all.some((e) => e.live)) return 'included';
  if (all.some((e) => e.intersections.length)) return 'unavailable';
  return 'not-on-route';
}
