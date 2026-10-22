/**
 * Input validation for the mobile navigation API (/api/v1).
 *
 * Everything from the app is untrusted. Each function returns
 * { value } on success or { errors: [string] } (never throws); controllers
 * turn errors into 400 INVALID_REQUEST with `details`.
 */
const { isValidLatLng } = require('./geo');
const {
  FEATURE_KINDS, REPORT_TYPES, REPORT_VOTES, MODERATION_STATUSES, PLATFORMS, PLACE_CATEGORIES, LIMITS,
} = require('../models/navigationConstants');

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?(,[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?)*$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const result = (errors, value) => (errors.length ? { errors } : { value });

/** Number from a query string ("35.5" -> 35.5); undefined when absent, NaN when malformed. */
function queryNumber(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return NaN;
  return Number(raw);
}

function checkLatLng(errors, path, lat, lng) {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.push(`${path}lat must be a number between -90 and 90`);
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) errors.push(`${path}lng must be a number between -180 and 180`);
}

/** ?lat=&lng= -> { value: { lat, lng } }; optional=true allows both absent ({ value: null }). */
function parseQueryPoint(query, { optional = false } = {}) {
  const lat = queryNumber(query.lat);
  const lng = queryNumber(query.lng);
  if (optional && lat === undefined && lng === undefined) return { value: null };
  const errors = [];
  if (lat === undefined || lng === undefined) return { errors: ['lat and lng are required together'] };
  checkLatLng(errors, '', lat, lng);
  return result(errors, { lat, lng });
}

/**
 * ?south=&west=&north=&east= -> { south, west, north, east }. The box must
 * not cross the antimeridian and may span at most `maxSpanDeg` per side.
 */
function parseBBox(query, { maxSpanDeg = LIMITS.maxBBoxSpanDeg, required = true } = {}) {
  const names = ['south', 'west', 'north', 'east'];
  const values = Object.fromEntries(names.map((n) => [n, queryNumber(query[n])]));
  if (!required && names.every((n) => values[n] === undefined)) return { value: null };
  const errors = [];
  for (const n of names) {
    if (values[n] === undefined) errors.push(`${n} is required`);
    else if (!Number.isFinite(values[n])) errors.push(`${n} must be a number`);
  }
  if (errors.length) return { errors };
  const { south, west, north, east } = values;
  if (south < -90 || north > 90) errors.push('south and north must be between -90 and 90');
  if (west < -180 || east > 180) errors.push('west and east must be between -180 and 180');
  if (south >= north) errors.push('south must be less than north');
  if (west >= east) errors.push('west must be less than east (boxes across the antimeridian are not supported)');
  if (!errors.length && (north - south > maxSpanDeg || east - west > maxSpanDeg)) {
    errors.push(`the box may span at most ${maxSpanDeg} degrees per side; zoom in`);
  }
  return result(errors, values);
}

/** Comma-separated list of allowed values (?kinds=a,b) -> array; undefined when absent. */
function parseList(raw, allowed, name) {
  if (raw === undefined || raw === '') return { value: undefined };
  if (typeof raw !== 'string') return { errors: [`${name} must be a comma-separated list`] };
  const items = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const bad = items.filter((i) => !allowed.includes(i));
  if (bad.length || !items.length) return { errors: [`${name} may contain only: ${allowed.join(', ')}`] };
  return { value: items };
}

function parseInteger(raw, name, { min, max, fallback }) {
  if (raw === undefined || raw === '') return { value: fallback };
  const n = queryNumber(raw);
  if (!Number.isInteger(n) || n < min || n > max) return { errors: [`${name} must be an integer between ${min} and ${max}`] };
  return { value: n };
}

/** Preferred result language: ?lang=, else the Accept-Language header (first entries), else null. */
function parseLanguage(req) {
  const raw = typeof req.query.lang === 'string' && req.query.lang.trim()
    ? req.query.lang.trim()
    : String(req.get('accept-language') || '').split(',').slice(0, 3).map((s) => s.split(';')[0].trim()).filter(Boolean).join(',');
  if (!raw) return { value: null };
  if (raw.length > 64 || !LANGUAGE.test(raw)) {
    return typeof req.query.lang === 'string' && req.query.lang.trim() ? { errors: ['lang must be a language tag such as en or ar-IQ'] } : { value: null };
  }
  return { value: raw };
}

function checkObjectId(id) {
  return typeof id === 'string' && OBJECT_ID.test(id);
}

function unknownKeys(errors, body, allowed) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) errors.push(`${key} is not a recognised field`);
}

function optionalText(errors, body, key, max, out) {
  if (body[key] === undefined) return;
  if (body[key] === null) { out[key] = null; return; }
  if (typeof body[key] !== 'string') { errors.push(`${key} must be a string or null`); return; }
  const text = body[key].trim().replace(/\s+/g, ' ');
  if (text.length > max) errors.push(`${key} may be at most ${max} characters`);
  // No control characters (kept out of logs and the app's UI).
  else if (/[\u0000-\u001f\u007f]/.test(text)) errors.push(`${key} contains control characters`);
  else out[key] = text || null;
}

function optionalBearing(errors, body, key, out) {
  if (body[key] === undefined) return;
  if (body[key] === null) { out[key] = null; return; }
  if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] >= 360) {
    errors.push(`${key} must be a compass bearing from 0 to 359.9 (degrees, 0 = north) or null`);
  } else {
    out[key] = Math.round(body[key] * 10) / 10;
  }
}

function optionalDate(errors, body, key, out) {
  if (body[key] === undefined) return;
  if (body[key] === null) { out[key] = null; return; }
  if (typeof body[key] !== 'string' || !Number.isFinite(Date.parse(body[key]))) errors.push(`${key} must be an ISO-8601 date or null`);
  else out[key] = new Date(body[key]);
}

// -------------------------------------------------------------- request bodies

function bodyPoint(errors, body, key) {
  const p = body[key];
  if (!isPlainObject(p)) { errors.push(`${key} must be an object { lat, lng }`); return null; }
  const before = errors.length;
  checkLatLng(errors, `${key}.`, p.lat, p.lng);
  return errors.length === before ? { lat: p.lat, lng: p.lng } : null;
}

/** POST /api/v1/routes */
function validateRouteRequest(body, { maxRoutes }) {
  if (!isPlainObject(body)) return { errors: ['body must be a JSON object'] };
  const errors = [];
  unknownKeys(errors, body, ['start', 'destination', 'maxRoutes', 'steps']);
  const start = bodyPoint(errors, body, 'start');
  const destination = bodyPoint(errors, body, 'destination');
  let routes = Math.min(3, maxRoutes);
  if (body.maxRoutes !== undefined) {
    if (!Number.isInteger(body.maxRoutes) || body.maxRoutes < 1 || body.maxRoutes > maxRoutes) errors.push(`maxRoutes must be an integer between 1 and ${maxRoutes}`);
    else routes = body.maxRoutes;
  }
  if (body.steps !== undefined && typeof body.steps !== 'boolean') errors.push('steps must be true or false');
  if (start && destination && start.lat === destination.lat && start.lng === destination.lng) {
    errors.push('start and destination are the same point');
  }
  return result(errors, { start, destination, maxRoutes: routes, steps: body.steps === true });
}

/** POST /api/v1/auth/device (body optional) */
function validateDeviceRegistration(body) {
  if (body === undefined || (isPlainObject(body) && !Object.keys(body).length)) return { value: { platform: 'other', appVersion: null } };
  if (!isPlainObject(body)) return { errors: ['body must be a JSON object'] };
  const errors = [];
  unknownKeys(errors, body, ['platform', 'appVersion']);
  let platform = 'other';
  if (body.platform !== undefined) {
    if (!PLATFORMS.includes(body.platform)) errors.push(`platform must be one of ${PLATFORMS.join(', ')}`);
    else platform = body.platform;
  }
  let appVersion = null;
  if (body.appVersion !== undefined && body.appVersion !== null) {
    if (typeof body.appVersion !== 'string' || !/^[0-9A-Za-z.+-]{1,32}$/.test(body.appVersion)) errors.push('appVersion must be a version string such as 1.4.0');
    else appVersion = body.appVersion;
  }
  return result(errors, { platform, appVersion });
}

/** POST /api/v1/reports */
function validateReportInput(body) {
  if (!isPlainObject(body)) return { errors: ['body must be a JSON object'] };
  const errors = [];
  unknownKeys(errors, body, ['type', 'lat', 'lng', 'heading', 'description']);
  if (!REPORT_TYPES.includes(body.type)) errors.push(`type must be one of ${REPORT_TYPES.join(', ')}`);
  checkLatLng(errors, '', body.lat, body.lng);
  const out = { type: body.type, lat: body.lat, lng: body.lng, heading: null, description: null };
  optionalBearing(errors, body, 'heading', out);
  optionalText(errors, body, 'description', LIMITS.reportDescriptionLength, out);
  return result(errors, out);
}

/** POST /api/v1/reports/:id/votes */
function validateVote(body) {
  if (!isPlainObject(body) || !REPORT_VOTES.includes(body.vote)) return { errors: [`vote must be one of ${REPORT_VOTES.join(', ')}`] };
  const errors = [];
  unknownKeys(errors, body, ['vote']);
  return result(errors, { vote: body.vote });
}

/** PATCH /api/v1/reports/:id (moderation) */
function validateModeration(body) {
  if (!isPlainObject(body)) return { errors: ['body must be a JSON object'] };
  const errors = [];
  unknownKeys(errors, body, ['status', 'verification']);
  const out = {};
  if (body.status !== undefined) {
    if (!MODERATION_STATUSES.includes(body.status)) errors.push(`status must be one of ${MODERATION_STATUSES.join(', ')}`);
    else out.status = body.status;
  }
  if (body.verification !== undefined) {
    if (!['verified', 'unverified'].includes(body.verification)) errors.push('verification must be verified or unverified');
    else out.verification = body.verification;
  }
  if (!errors.length && !Object.keys(out).length) errors.push('nothing to change: send status and/or verification');
  return result(errors, out);
}

/** POST /api/v1/road-features (partial=false) and PATCH (partial=true) */
function validateFeatureInput(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return { errors: ['body must be a JSON object'] };
  const errors = [];
  unknownKeys(errors, body, ['kind', 'lat', 'lng', 'name', 'description', 'direction', 'speedLimitKmh', 'source', 'active', 'validFrom', 'validUntil']);
  const out = {};
  if (body.kind !== undefined || !partial) {
    if (!FEATURE_KINDS.includes(body.kind)) errors.push(`kind must be one of ${FEATURE_KINDS.join(', ')}`);
    else out.kind = body.kind;
  }
  if (body.lat !== undefined || body.lng !== undefined || !partial) {
    const before = errors.length;
    checkLatLng(errors, '', body.lat, body.lng);
    if (errors.length === before) out.location = { type: 'Point', coordinates: [body.lng, body.lat] };
  }
  optionalText(errors, body, 'name', LIMITS.nameLength, out);
  optionalText(errors, body, 'description', LIMITS.descriptionLength, out);
  optionalText(errors, body, 'source', LIMITS.sourceLength, out);
  optionalBearing(errors, body, 'direction', out);
  if (body.speedLimitKmh !== undefined) {
    if (body.speedLimitKmh !== null && (!Number.isInteger(body.speedLimitKmh) || body.speedLimitKmh < 5 || body.speedLimitKmh > 200)) {
      errors.push('speedLimitKmh must be an integer from 5 to 200, or null');
    } else out.speedLimitKmh = body.speedLimitKmh;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') errors.push('active must be true or false');
    else out.active = body.active;
  }
  optionalDate(errors, body, 'validFrom', out);
  optionalDate(errors, body, 'validUntil', out);
  if (out.validFrom && out.validUntil && out.validFrom >= out.validUntil) errors.push('validFrom must be before validUntil');
  if (partial && !errors.length && !Object.keys(out).length) errors.push('nothing to change');
  return result(errors, out);
}

/** GET /api/v1/places/nearby query */
function validateNearbyQuery(query) {
  const errors = [];
  const point = parseQueryPoint(query);
  if (point.errors) errors.push(...point.errors);
  const categories = Object.keys(PLACE_CATEGORIES);
  if (!categories.includes(query.category)) errors.push(`category must be one of ${categories.join(', ')}`);
  const radius = parseInteger(query.radius, 'radius', { min: 100, max: LIMITS.nearbyMaxRadiusMeters, fallback: 2000 });
  if (radius.errors) errors.push(...radius.errors);
  const limit = parseInteger(query.limit, 'limit', { min: 1, max: LIMITS.nearbyMaxResults, fallback: 20 });
  if (limit.errors) errors.push(...limit.errors);
  return result(errors, {
    ...(point.value || {}), category: query.category, radius: radius.value, limit: limit.value,
  });
}

/** GET /api/v1/places/search query */
function validateSearchQuery(query) {
  const errors = [];
  const q = typeof query.q === 'string' ? query.q.trim().replace(/\s+/g, ' ') : '';
  if (q.length < LIMITS.searchMinLength || q.length > LIMITS.searchMaxLength) {
    errors.push(`q must be ${LIMITS.searchMinLength}-${LIMITS.searchMaxLength} characters`);
  }
  const near = parseQueryPoint(query, { optional: true });
  if (near.errors) errors.push(...near.errors);
  const limit = parseInteger(query.limit, 'limit', { min: 1, max: LIMITS.searchMaxResults, fallback: 5 });
  if (limit.errors) errors.push(...limit.errors);
  return result(errors, { q, near: near.value || null, limit: limit.value });
}

module.exports = {
  isValidLatLng,
  parseQueryPoint,
  parseBBox,
  parseList,
  parseInteger,
  parseLanguage,
  checkObjectId,
  validateRouteRequest,
  validateDeviceRegistration,
  validateReportInput,
  validateVote,
  validateModeration,
  validateFeatureInput,
  validateNearbyQuery,
  validateSearchQuery,
};
