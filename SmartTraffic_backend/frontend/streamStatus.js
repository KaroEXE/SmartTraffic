/**
 * What the Live AI view says about the AI feed and the camera streams.
 * Pure functions (no DOM), so the loading / offline / stale rules are
 * testable on their own (backend/test/streamStatus.test.js).
 *
 * Nothing here invents data: a state is only "connected" / "online" when the
 * backend reported it, and an old report is shown as stale, never as live.
 */

const DIRS = ['north', 'south', 'east', 'west'];

const fmtAge = (seconds) => {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
};

const clock = (iso) => new Date(iso).toISOString().slice(11, 19);

/**
 * AI feed state of one intersection from its live decision-engine snapshot.
 * @param snapshot  live snapshot (aiStatus WAITING | CONNECTED | STALE) or null
 * @param options   { mode: 'live' | 'simulation', connected: socket connected? }
 * @returns {{ state: 'loading'|'offline'|'connected'|'stale'|'error', detail: string }}
 */
export function describeFeed(snapshot, { mode = 'live', connected = true } = {}) {
  if (mode !== 'live') {
    return { state: 'offline', detail: 'Live AI data is not shown in Simulation mode - switch to Live traffic' };
  }
  if (!connected) return { state: 'error', detail: 'Backend connection lost - reconnecting' };
  if (!snapshot) return { state: 'loading', detail: 'Loading live data...' };
  if (snapshot.dataMode && snapshot.dataMode !== 'live') {
    return { state: 'offline', detail: 'No live data for this intersection' };
  }
  const last = snapshot.lastUpdate ? ` - last update ${clock(snapshot.lastUpdate)} UTC` : '';
  switch (snapshot.aiStatus) {
    case 'CONNECTED':
      return { state: 'connected', detail: `Receiving AI detection data${last}` };
    case 'STALE':
      return { state: 'stale', detail: `AI data stopped${last} - signals on fixed-time fallback` };
    default:
      return { state: 'offline', detail: 'No AI data received for this intersection yet' };
  }
}

/** Server time now, from the last status payload's serverTime (corrects client clock skew). */
export function serverNow(status, receivedAtMs, nowMs = Date.now()) {
  const server = status && Date.parse(status.serverTime);
  return Number.isFinite(server) ? server + (nowMs - receivedAtMs) : nowMs;
}

/**
 * Display state of one camera stream (public record from /api/streams/status).
 * @returns {{ state: 'disabled'|'unknown'|'stale'|'online'|'connecting'|'degraded'|'offline'|'standby', label: string, detail: string }}
 */
export function describeStream(stream, nowMs, staleAfterSeconds = 60) {
  if (!stream.enabled) return { state: 'disabled', label: 'DISABLED', detail: 'Disabled in the registry' };
  const checked = stream.lastHealthCheckAt ? Date.parse(stream.lastHealthCheckAt) : null;
  if (checked === null || !stream.status || stream.status === 'unknown') {
    return { state: 'unknown', label: 'NO REPORT', detail: 'No health report from the AI service yet' };
  }
  const reportAge = (nowMs - checked) / 1000;
  const frame = stream.lastFrameAt
    ? `last frame ${fmtAge((nowMs - Date.parse(stream.lastFrameAt)) / 1000)} ago`
    : 'no frame yet';
  if (stream.stale || reportAge > staleAfterSeconds) {
    return {
      state: 'stale',
      label: 'STALE',
      detail: `Last report ${fmtAge(reportAge)} ago (${stream.status}) - ${frame}`,
    };
  }
  const label = stream.status.toUpperCase();
  const extra = stream.lastError && stream.status !== 'online' ? ` - ${stream.lastError}` : '';
  return { state: stream.status, label, detail: `${stream.active ? 'Feeding' : 'Not feeding'} - ${frame}${extra}` };
}

/**
 * Rows for the stream panel of one intersection, ordered by direction then priority.
 * @param registry  { loading, error, status } where status is the /api/streams/status body
 */
export function streamRows(registry, intersectionId, nowMs) {
  if (registry.loading) return { state: 'loading', message: 'Loading camera streams...', rows: [] };
  if (registry.error) return { state: 'error', message: registry.error, rows: [] };
  const status = registry.status;
  if (!status || !status.available) {
    return { state: 'offline', message: 'Stream registry unavailable (database not connected)', rows: [] };
  }
  const rows = status.streams
    .filter((s) => s.intersectionId === intersectionId)
    .sort((a, b) => (DIRS.indexOf(a.direction) + 1 || 9) - (DIRS.indexOf(b.direction) + 1 || 9) || a.priority - b.priority)
    .map((s) => ({ stream: s, ...describeStream(s, nowMs, status.staleAfterSeconds) }));
  if (!rows.length) return { state: 'empty', message: 'No camera streams registered for this intersection', rows };
  return { state: 'ok', message: '', rows };
}
