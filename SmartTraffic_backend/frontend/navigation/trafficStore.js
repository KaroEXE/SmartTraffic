import { isValidLatLng } from './geo.js';

/**
 * Live traffic observations per monitored intersection (no DOM).
 *
 * Fed by trafficFeed.js from the backend's live Socket.IO room. Snapshots
 * marked dataMode "simulation" are never stored: drivers only see real data.
 *
 * View of one intersection (list() / get()):
 *   { id, name, lat, lng, located,
 *     status: 'live' | 'stale' | 'no-data' | 'offline',
 *     ageSeconds, lastUpdate,
 *     approaches: { north: { vehicles, queueLength, waitingTime }, ... } | null,
 *     longestQueue: { direction, vehicles } | null,
 *     emergency: { type, direction, confidence, since } | null }
 *
 * Ages are measured on the server clock (serverTime - lastUpdate) plus the
 * time since the snapshot arrived, so a wrong phone clock cannot make old
 * data look live.
 */

const DIRECTIONS = ['north', 'south', 'east', 'west'];

function num(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function readApproaches(traffic) {
  if (!traffic || typeof traffic !== 'object') return null;
  const out = {};
  for (const d of DIRECTIONS) {
    const t = traffic[d];
    if (!t) return null;
    out[d] = {
      vehicles: num(t.vehicles),
      queueLength: num(t.queueLength),
      waitingTime: num(t.waitingTime !== undefined ? t.waitingTime : t.waiting),
    };
  }
  return out;
}

export function createTrafficStore({ staleAfterSeconds = 15, now = () => Date.now() } = {}) {
  const entries = new Map(); // id -> { meta, snap, receivedAt, ageAtReceipt }
  const listeners = new Set();
  let connection = 'connecting';

  const notify = () => { for (const fn of listeners) fn(); };

  function entry(id) {
    if (!entries.has(id)) entries.set(id, { meta: { id, name: id, lat: null, lng: null }, snap: null, receivedAt: 0, ageAtReceipt: null });
    return entries.get(id);
  }

  function applyMeta(e, src) {
    if (typeof src.name === 'string' && src.name) e.meta.name = src.name;
    if (Number.isFinite(src.lat) && Number.isFinite(src.lng)) {
      e.meta.lat = src.lat;
      e.meta.lng = src.lng;
    }
  }

  function apply(snap, receivedAt) {
    if (!snap || typeof snap.intersectionId !== 'string') return false;
    if (snap.dataMode === 'simulation') return false;
    const e = entry(snap.intersectionId);
    applyMeta(e, snap);
    const server = Date.parse(snap.serverTime);
    const last = Date.parse(snap.lastUpdate);
    e.snap = snap;
    e.receivedAt = receivedAt;
    e.ageAtReceipt = Number.isFinite(server) && Number.isFinite(last) ? Math.max(0, (server - last) / 1000) : null;
    return true;
  }

  function view(e) {
    const { meta, snap } = e;
    const base = {
      id: meta.id,
      name: meta.name,
      lat: meta.lat,
      lng: meta.lng,
      located: isValidLatLng(meta),
      status: 'no-data',
      ageSeconds: null,
      lastUpdate: null,
      approaches: null,
      longestQueue: null,
      emergency: null,
    };
    if (!snap || !snap.lastUpdate || e.ageAtReceipt === null) return base;

    const approaches = readApproaches(snap.traffic);
    const ageSeconds = e.ageAtReceipt + (now() - e.receivedAt) / 1000;
    let status = 'live';
    if (connection !== 'connected') status = 'offline';
    else if (snap.aiStatus !== 'CONNECTED' || ageSeconds > staleAfterSeconds) status = 'stale';

    let longestQueue = null;
    if (approaches) {
      for (const d of DIRECTIONS) {
        const q = approaches[d].queueLength;
        if (q !== null && (!longestQueue || q > longestQueue.vehicles)) longestQueue = { direction: d, vehicles: q };
      }
    }
    const em = snap.emergency;
    const emergency = status === 'live' && em && em.active
      ? { type: em.type, direction: em.direction, confidence: em.confidence, since: em.since }
      : null;

    return { ...base, status, ageSeconds, lastUpdate: snap.lastUpdate, approaches, longestQueue, emergency };
  }

  return {
    get connection() { return connection; },

    setConnection(state) {
      if (state === connection) return;
      connection = state;
      notify();
    },

    /** Positions and names from GET /api/intersections (no traffic data). */
    setIntersections(list) {
      for (const ix of list || []) {
        if (ix && typeof ix.id === 'string') applyMeta(entry(ix.id), ix);
      }
      notify();
    },

    /** One snapshot (trafficUpdate / signalUpdate). Returns true if stored. */
    applySnapshot(snap, receivedAt = now()) {
      const stored = apply(snap, receivedAt);
      if (stored) notify();
      return stored;
    },

    /** All snapshots of the live room (socket `init`). */
    replaceAll(list, receivedAt = now()) {
      for (const snap of list || []) apply(snap, receivedAt);
      notify();
    },

    list() {
      return [...entries.values()].map(view);
    },

    get(id) {
      const e = entries.get(id);
      return e ? view(e) : null;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    listenerCount() {
      return listeners.size;
    },
  };
}
