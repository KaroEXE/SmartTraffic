/**
 * Traffic figures shared by the map, the 3D labels and the dashboard (pure,
 * no DOM; backend/test/metrics.test.js). Everything is derived from one
 * backend snapshot; nothing is estimated where the snapshot has no data.
 *
 * Congestion level is an ESTIMATE from the longest queue the snapshot
 * reports (vehicles stopped at one approach):
 *   free      longest queue 0-4
 *   moderate  5-11
 *   heavy     12 or more
 * Without usable data the level is 'nodata' / 'stale' / 'offline' - never a
 * level that could be mistaken for a measurement.
 */

const DIRS = ['north', 'south', 'east', 'west'];

export const CONGESTION_THRESHOLDS = { moderate: 5, heavy: 12 };

export const CONGESTION_LABEL = {
  free: 'Free flow',
  moderate: 'Moderate',
  heavy: 'Heavy',
  nodata: 'No data',
  stale: 'Stale data',
  offline: 'Offline',
};

/**
 * @param snapshot  decision-engine snapshot (or null)
 * @param options   { connected: socket connected? }
 * @returns {{ level, label, source: 'live'|'simulated'|null, vehicles, queued, maxQueue, maxWait, approaches }}
 *   numbers are null when there is no data for them.
 */
export function trafficSummary(snapshot, { connected = true } = {}) {
  const empty = (level) => ({
    level, label: CONGESTION_LABEL[level], source: null, vehicles: null, queued: null, maxQueue: null, maxWait: null, approaches: 0,
  });
  if (!connected) return empty('offline');
  if (!snapshot) return empty('nodata');
  const simulated = snapshot.dataMode === 'simulation';
  if (!simulated && snapshot.aiStatus !== 'CONNECTED') return empty(snapshot.aiStatus === 'STALE' ? 'stale' : 'nodata');

  let vehicles = 0;
  let queued = 0;
  let maxQueue = 0;
  let maxWait = 0;
  let approaches = 0;
  for (const dir of DIRS) {
    const t = snapshot.traffic && snapshot.traffic[dir];
    if (!t || t.available === false || !Number.isFinite(t.vehicles)) continue;
    approaches += 1;
    vehicles += t.vehicles;
    const q = Number.isFinite(t.queueLength) ? t.queueLength : 0;
    queued += q;
    maxQueue = Math.max(maxQueue, q);
    const w = Number.isFinite(t.waitingTime) ? t.waitingTime : t.waiting;
    if (Number.isFinite(w)) maxWait = Math.max(maxWait, w);
  }
  if (!approaches) return empty('nodata');
  let level = 'free';
  if (maxQueue >= CONGESTION_THRESHOLDS.heavy) level = 'heavy';
  else if (maxQueue >= CONGESTION_THRESHOLDS.moderate) level = 'moderate';
  return {
    level,
    label: CONGESTION_LABEL[level],
    source: simulated ? 'simulated' : 'live',
    vehicles,
    queued,
    maxQueue,
    maxWait: Math.round(maxWait * 10) / 10,
    approaches,
  };
}

/** "+34.7%" / "-4.0%" / "n/a" for an improvement percentage (positive = better). */
export function formatImprovement(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'n/a';
  if (pct === 0) return '0.0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/** How trustworthy a position is: 'surveyed', 'placeholder' or 'simulated'. */
export function positionLabel(intersection) {
  if (!intersection) return null;
  if (intersection.dataMode === 'simulation') return 'Simulated position';
  if (intersection.positionSource === 'surveyed') return null;
  if (intersection.positionSource === 'placeholder') return 'Approximate position - not surveyed';
  return null;
}
