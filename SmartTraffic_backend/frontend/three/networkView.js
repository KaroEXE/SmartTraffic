/**
 * What the 3D network shows for one network decision (no THREE, no DOM;
 * backend/test/network3d.test.js). Everything is derived from the decision
 * the backend's network coordinator emitted (`networkDecision`), so the
 * scene can only show what the decision logic actually used and chose.
 *
 *   link states      free / busy / congested / blocked / unknown - from the
 *                    queue at the road's far end (the coordinator's view)
 *   junction states  emergency > nodata / stale > action > congested > normal
 *   corridor         the emergency vehicle's position and the intersections
 *                    of its corridor, in scene coordinates
 */

export const LINK_STATES = ['free', 'busy', 'congested', 'blocked', 'unknown'];
export const SITE_STATES = ['normal', 'congested', 'action', 'emergency', 'stale', 'nodata'];

const LEG = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const HEAVY_QUEUE = 12; // vehicles on one approach (same threshold as metrics.js "heavy")

/** Corridor intersections (and support actions) by id: { vehicleId, stage, etaSeconds, status, purpose }. */
export function corridorIndex(decision) {
  const index = new Map();
  for (const c of (decision && decision.corridors) || []) {
    for (const e of c.entries) {
      if (!index.has(e.intersectionId)) index.set(e.intersectionId, { ...e, vehicleId: c.vehicleId, type: c.type, purpose: 'priority' });
    }
    for (const s of c.support || []) {
      if (!index.has(s.intersectionId)) index.set(s.intersectionId, { ...s, vehicleId: c.vehicleId, type: c.type, stage: 'preparing' });
    }
  }
  return index;
}

/** Highlight state of one intersection record of a decision. */
export function siteState(record, corridors = new Map()) {
  if (!record) return 'nodata';
  if (record.emergency || corridors.has(record.intersectionId)) return 'emergency';
  if (!record.evaluated) return record.status === 'stale' ? 'stale' : 'nodata';
  if (record.changed || record.networkChangedChoice) return 'action';
  const congested = (record.candidates || []).some((c) => (c.downstream && (c.downstream.state === 'congested' || c.downstream.state === 'blocked'))
    || (c.queue !== null && c.queue >= HEAVY_QUEUE));
  return congested ? 'congested' : 'normal';
}

/** Link id -> { state, releasing, corridor } for drawing the road arrows. */
export function linkStates(decision) {
  const out = new Map();
  if (!decision) return out;
  const corridorLinks = new Set();
  for (const c of decision.corridors || []) {
    const route = c.route || [];
    for (let i = 0; i < route.length - 1; i += 1) {
      if (!c.passed.includes(route[i + 1])) corridorLinks.add(`${route[i]}>${route[i + 1]}`);
    }
  }
  for (const l of decision.links || []) {
    out.set(l.id, {
      state: LINK_STATES.includes(l.state) ? l.state : 'unknown',
      releasing: Boolean(l.releasing),
      corridor: corridorLinks.has(l.id),
      queue: l.queue,
      capacity: l.capacity,
    });
  }
  return out;
}

/**
 * Scene position of a vehicle `distanceM` before the stop line of
 * `approach` at `towards`. `sites` = layout sites by id ({ x, z }).
 * Returns { x, z, heading } (heading = travel direction) or null.
 */
export function vehiclePosition(position, sites, stopLine = 13) {
  if (!position) return null;
  const site = sites.get(position.towards);
  const leg = LEG[position.approach];
  if (!site || !leg) return null;
  const d = Math.max(-stopLine, position.distanceM) + stopLine;
  return { x: site.x + leg[0] * d, z: site.z + leg[1] * d, heading: OPPOSITE[position.approach] };
}

/** Points of the corridor polyline: vehicle -> each corridor intersection centre (scene coordinates). */
export function corridorPath(corridor, sites, stopLine = 13) {
  const points = [];
  const start = vehiclePosition(corridor.position, sites, stopLine);
  if (start) points.push({ x: start.x, z: start.z });
  for (const e of corridor.entries) {
    const site = sites.get(e.intersectionId);
    if (site) points.push({ x: site.x, z: site.z });
  }
  return points;
}

/** Counts for the decision panel header. */
export function summarize(decision) {
  const records = (decision && decision.intersections) || [];
  const evaluated = records.filter((r) => r.evaluated);
  return {
    evaluated: evaluated.length,
    total: records.length,
    applied: evaluated.filter((r) => r.applied === 'applied').length,
    pending: evaluated.filter((r) => r.applied && r.applied.startsWith('pending')).length,
    overridden: evaluated.filter((r) => r.applied && r.applied.startsWith('overridden')).length,
    networkChanged: evaluated.filter((r) => r.networkChangedChoice).length,
    corridors: ((decision && decision.corridors) || []).length,
    congestedLinks: ((decision && decision.links) || []).filter((l) => l.state === 'congested' || l.state === 'blocked').length,
  };
}
