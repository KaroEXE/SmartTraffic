/** Display formatting (no DOM). */

const DIRECTION_LABEL = { north: 'north', south: 'south', east: 'east', west: 'west' };

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '-';
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** "+3 min" / "-1 min" / "no delay" for a delay in seconds. */
export function formatDelay(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return 'no delay';
  return `${minutes > 0 ? '+' : '-'}${Math.abs(minutes)} min`;
}

/** How long ago an observation was made, e.g. "8 s ago", "3 min ago". */
export function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return 'never';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function formatClock(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatCoords(point) {
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}

export function directionLabel(direction) {
  return DIRECTION_LABEL[direction] || String(direction || '');
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
