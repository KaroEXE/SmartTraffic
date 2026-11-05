/**
 * Validation for camera-stream records and stream health reports.
 *
 * The record rules match the Python service's parser
 * (python/app/services/streams.py, parse_stream), so every record the
 * backend accepts is also usable by the AI service. Like utils/validation.js,
 * nothing here throws on bad input; problems are returned as error strings.
 * Error strings never contain the stream URL (it may carry private tokens).
 *
 *   validateStreamInput(body, { partial, hasIntersection }) -> { ok, value } | { ok: false, errors }
 *   validateHealthReport(body)  -> { ok, value: { source, reportedAt, intersectionId, entries, rejected } } | { ok: false, errors }
 *   sanitizeError(text, secrets) -> short text safe to store and show
 */

const { DIRECTIONS, ID_PATTERN } = require('./validation');

const SOURCE_TYPES = ['youtube', 'hls', 'http', 'rtsp', 'file', 'camera'];
// Reported by the AI service. 'unknown' = no report received yet.
const STREAM_STATUSES = ['unknown', 'online', 'connecting', 'degraded', 'offline', 'standby', 'disabled'];
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 120;
const MAX_PRIORITY = 1_000_000;
const MAX_ERROR_LENGTH = 200;
const MAX_HEALTH_ENTRIES = 200;
const CAMERA = /^camera:(\d{1,3})$/;

const EDITABLE = ['name', 'url', 'sourceType', 'intersectionId', 'direction', 'enabled', 'priority'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseUrl(text) {
  try { return new URL(text); } catch { return null; }
}

/** The source type a URL implies; "file" for anything without a scheme and host. */
function inferSourceType(url) {
  if (CAMERA.test(url)) return 'camera';
  const u = parseUrl(url);
  if (!u) return 'file';
  const scheme = u.protocol.slice(0, -1);
  const host = u.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return 'youtube';
  if (['rtsp', 'rtsps', 'rtmp', 'rtmps'].includes(scheme)) return 'rtsp';
  if ((scheme === 'http' || scheme === 'https') && host) {
    return u.pathname.toLowerCase().endsWith('.m3u8') ? 'hls' : 'http';
  }
  return 'file';
}

function urlMatches(url, sourceType) {
  if (sourceType === 'camera') return CAMERA.test(url);
  const u = parseUrl(url);
  const scheme = u ? u.protocol.slice(0, -1) : '';
  const host = u ? u.hostname.toLowerCase() : '';
  switch (sourceType) {
    case 'youtube': return (scheme === 'http' || scheme === 'https') && YOUTUBE_HOSTS.has(host);
    case 'hls':
    case 'http': return (scheme === 'http' || scheme === 'https') && Boolean(host);
    case 'rtsp': return ['rtsp', 'rtsps', 'rtmp', 'rtmps'].includes(scheme) && Boolean(host);
    // A path on the AI host, or a Windows drive letter ("C:\...").
    default: return !/^[A-Za-z][A-Za-z0-9+.-]+:/.test(url) || /^[A-Za-z]:[\\/]/.test(url);
  }
}

/**
 * Validates a stream record for POST (full) or PATCH (`partial: true`).
 * `id` is required for POST and must not be sent with PATCH.
 */
function validateStreamInput(body, { partial = false, hasIntersection = () => true } = {}) {
  if (!isPlainObject(body)) return { ok: false, errors: ['Request body must be a JSON object'] };
  const errors = [];
  const value = {};
  const allowed = partial ? EDITABLE : ['id', ...EDITABLE];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      errors.push(partial && key === 'id' ? 'id cannot be changed' : `${key} is not a stream setting (allowed: ${allowed.join(', ')})`);
    }
  }
  const has = (key) => body[key] !== undefined;

  if (!partial) {
    if (typeof body.id !== 'string' || !ID_PATTERN.test(body.id)) errors.push('id must be a string of 1-64 characters [A-Za-z0-9_-]');
    else value.id = body.id;
  }

  if (has('name')) {
    if (body.name !== null && (typeof body.name !== 'string' || body.name.length > MAX_NAME_LENGTH)) {
      errors.push(`name must be a string of at most ${MAX_NAME_LENGTH} characters`);
    } else {
      value.name = (body.name || '').trim();
    }
  }

  if (has('url') || !partial) {
    if (typeof body.url !== 'string' || !body.url.trim() || body.url.length > MAX_URL_LENGTH) {
      errors.push(`url must be a nonempty string of at most ${MAX_URL_LENGTH} characters`);
    } else {
      value.url = body.url.trim();
    }
  }

  if (has('sourceType')) {
    if (!SOURCE_TYPES.includes(body.sourceType)) errors.push(`sourceType must be one of ${SOURCE_TYPES.join(', ')}`);
    else value.sourceType = body.sourceType;
  } else if (value.url) {
    value.sourceType = inferSourceType(value.url);
  }
  if (value.url && value.sourceType) {
    if (!urlMatches(value.url, value.sourceType)) {
      errors.push(`url is not a valid ${value.sourceType} source`);
    } else if (['youtube', 'hls', 'http'].includes(value.sourceType) && parseUrl(value.url).username) {
      errors.push('url must not embed credentials');
    }
  } else if (partial && has('sourceType') && !has('url')) {
    errors.push('sourceType can only be changed together with url');
  }

  if (has('intersectionId') || !partial) {
    const id = body.intersectionId;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) errors.push('intersectionId must be a string of 1-64 characters [A-Za-z0-9_-]');
    else if (!hasIntersection(id)) errors.push(`intersectionId "${id}" is not a known intersection`);
    else value.intersectionId = id;
  }

  if (has('direction') || !partial) {
    const d = body.direction === undefined ? null : body.direction;
    if (d !== null && !DIRECTIONS.includes(d)) errors.push(`direction must be one of ${DIRECTIONS.join(', ')} or null`);
    else value.direction = d;
  }

  if (has('enabled')) {
    if (typeof body.enabled !== 'boolean') errors.push('enabled must be a boolean');
    else value.enabled = body.enabled;
  } else if (!partial) {
    value.enabled = true;
  }

  if (has('priority')) {
    const p = body.priority;
    if (!Number.isInteger(p) || p < 0 || p > MAX_PRIORITY) errors.push(`priority must be an integer from 0 to ${MAX_PRIORITY}`);
    else value.priority = p;
  } else if (!partial) {
    value.priority = 0;
  }

  if (!partial && value.id && !value.name) value.name = value.id;
  if (partial && !errors.length && !Object.keys(value).length) errors.push('Nothing to update');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}

/** Short, single-line error text with URLs and credential-like values removed. */
function sanitizeError(text, secrets = []) {
  if (text === null || text === undefined) return null;
  let s = String(text);
  for (const secret of secrets) if (secret) s = s.split(secret).join('<redacted>');
  s = s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b(token|key|sig|signature|password|passwd|secret|auth)=[^\s&]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > MAX_ERROR_LENGTH ? `${s.slice(0, MAX_ERROR_LENGTH - 3)}...` : s;
}

function optionalDate(errors, path, value) {
  if (value === undefined || value === null) return null;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    errors.push(`${path} must be an ISO-8601 date string or null`);
    return null;
  }
  return new Date(ms);
}

/**
 * Validates POST /api/streams/health. A malformed report is rejected as a
 * whole; a malformed entry is skipped and listed in `rejected`, so one bad
 * entry does not drop the health of every other stream.
 */
function validateHealthReport(body) {
  if (!isPlainObject(body)) return { ok: false, errors: ['Request body must be a JSON object'] };
  const errors = [];
  if (body.source !== undefined && (typeof body.source !== 'string' || body.source.length > 32)) {
    errors.push('source must be a string of at most 32 characters');
  }
  const reportedAt = optionalDate(errors, 'reportedAt', body.reportedAt);
  if (body.intersectionId !== undefined && (typeof body.intersectionId !== 'string' || !ID_PATTERN.test(body.intersectionId))) {
    errors.push('intersectionId must be a string of 1-64 characters [A-Za-z0-9_-]');
  }
  if (!Array.isArray(body.streams)) errors.push('streams must be an array');
  else if (body.streams.length > MAX_HEALTH_ENTRIES) errors.push(`streams may list at most ${MAX_HEALTH_ENTRIES} entries`);
  if (errors.length) return { ok: false, errors };

  const entries = [];
  const rejected = [];
  body.streams.forEach((entry, index) => {
    const e = [];
    if (!isPlainObject(entry)) {
      rejected.push({ index, errors: ['entry must be an object'] });
      return;
    }
    if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) e.push('id must be a string of 1-64 characters [A-Za-z0-9_-]');
    if (!STREAM_STATUSES.includes(entry.state) || entry.state === 'unknown') {
      e.push(`state must be one of ${STREAM_STATUSES.filter((s) => s !== 'unknown').join(', ')}`);
    }
    if (entry.active !== undefined && typeof entry.active !== 'boolean') e.push('active must be a boolean');
    const lastFrameAt = optionalDate(e, 'lastFrameAt', entry.lastFrameAt);
    const lastInferenceAt = optionalDate(e, 'lastInferenceAt', entry.lastInferenceAt);
    const failures = entry.consecutiveFailures === undefined ? 0 : entry.consecutiveFailures;
    if (!Number.isInteger(failures) || failures < 0 || failures > 1e9) e.push('consecutiveFailures must be a non-negative integer');
    if (entry.error !== undefined && entry.error !== null && typeof entry.error !== 'string') e.push('error must be a string or null');
    if (e.length) {
      rejected.push({ index, ...(typeof entry.id === 'string' ? { id: entry.id.slice(0, 64) } : {}), errors: e });
      return;
    }
    entries.push({
      id: entry.id,
      status: entry.state,
      active: entry.active === true,
      lastFrameAt,
      lastInferenceAt,
      consecutiveFailures: failures,
      error: entry.error === undefined ? null : entry.error,
    });
  });

  return {
    ok: true,
    value: {
      source: body.source ? body.source.trim().toLowerCase() : null,
      reportedAt,
      intersectionId: body.intersectionId === undefined ? null : body.intersectionId,
      entries,
      rejected,
    },
  };
}

module.exports = {
  SOURCE_TYPES,
  STREAM_STATUSES,
  MAX_URL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PRIORITY,
  MAX_ERROR_LENGTH,
  inferSourceType,
  validateStreamInput,
  validateHealthReport,
  sanitizeError,
};
