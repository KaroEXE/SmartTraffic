/* global io */

/**
 * Live traffic subscription. Opens one Socket.IO connection for this page
 * (never one per render or route) and feeds trafficStore.js.
 *
 * The connection stays in the backend's default "live" room and never
 * subscribes to simulation, so only real observations reach the driver.
 * The navigation page only reads traffic state; it never sends anything
 * that could influence signal decisions.
 */

let socket = null;

export function connectTrafficFeed(store) {
  if (socket) return socket;
  if (typeof io !== 'function') {
    store.setConnection('unavailable');
    return null;
  }

  store.setConnection('connecting');
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => store.setConnection('connected'));
  socket.on('disconnect', () => store.setConnection('disconnected'));
  socket.on('connect_error', () => store.setConnection('disconnected'));

  socket.on('init', (payload) => {
    if (!payload || (payload.dataMode && payload.dataMode !== 'live')) return;
    store.replaceAll(payload.intersections);
  });
  // signalUpdate carries the same snapshot; it is the event that reports a
  // feed going STALE, so both keep freshness accurate.
  socket.on('trafficUpdate', (snap) => store.applySnapshot(snap));
  socket.on('signalUpdate', (snap) => store.applySnapshot(snap));

  return socket;
}

/** Closes the connection (page hidden / unloaded). */
export function disconnectTrafficFeed(store) {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  if (store) store.setConnection('disconnected');
}

/** Listener counts, for checking that updates never add duplicates. */
export function feedDiagnostics() {
  if (!socket) return { connected: false, listeners: {} };
  const events = ['init', 'trafficUpdate', 'signalUpdate', 'connect', 'disconnect'];
  return {
    connected: socket.connected,
    listeners: Object.fromEntries(events.map((e) => [e, socket.listeners(e).length])),
  };
}
