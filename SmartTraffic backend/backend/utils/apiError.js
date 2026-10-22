/**
 * Errors of the mobile navigation API (/api/v1).
 *
 * Every error answer has the backend's usual shape plus a stable,
 * machine-readable `code` the app can switch on:
 *
 *   { "ok": false, "code": "INVALID_REQUEST", "error": "lat must be ...", "details": [...] }
 *
 * `error` is English text for logs and developers; it may change. `code`
 * does not change within an API version.
 */

class ApiError extends Error {
  constructor(status, code, message, { details, retryAfterSeconds, extra } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    this.extra = extra;
  }
}

const invalid = (message, details) => new ApiError(400, 'INVALID_REQUEST', message, { details });
const notFound = (message) => new ApiError(404, 'NOT_FOUND', message);
const dbUnavailable = () => new ApiError(503, 'DATABASE_UNAVAILABLE', 'The database is not connected; try again later');

// UpstreamError (utils/upstream.js) code -> HTTP status.
const UPSTREAM_STATUS = {
  PROVIDER_TIMEOUT: 504,
  PROVIDER_UNREACHABLE: 502,
  PROVIDER_ERROR: 502,
  PROVIDER_BUSY: 503,
};

function sendError(res, status, code, message, { details, retryAfterSeconds, extra } = {}) {
  if (retryAfterSeconds) res.set('Retry-After', String(retryAfterSeconds));
  return res.status(status).json({
    ok: false,
    code,
    error: message,
    ...(details && details.length ? { details } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    ...(extra || {}),
  });
}

/** Maps any error thrown by a navigation handler to an answer. */
function sendApiError(res, err, log = console) {
  if (err instanceof ApiError) {
    return sendError(res, err.status, err.code, err.message, err);
  }
  if (err && err.name === 'UpstreamError' && UPSTREAM_STATUS[err.code]) {
    return sendError(res, UPSTREAM_STATUS[err.code], err.code, err.message, { retryAfterSeconds: err.retryAfterSeconds });
  }
  if (err && err.name === 'ValidationError') { // mongoose schema validation (a backstop: input is validated first)
    return sendError(res, 400, 'INVALID_REQUEST', 'Invalid data', { details: Object.values(err.errors || {}).map((e) => e.message) });
  }
  if (err && (err.name === 'MongoNotConnectedError' || err.name === 'MongoServerSelectionError' || err.code === 'DB_UNAVAILABLE')) {
    return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The database is not connected; try again later');
  }
  log.error(`[navigation] unhandled error: ${err && err.stack ? err.stack : err}`);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}

/** Express wrapper: async handler errors go to sendApiError. */
const handle = (fn) => (req, res) => Promise.resolve()
  .then(() => fn(req, res))
  .catch((err) => sendApiError(res, err));

module.exports = {
  ApiError, invalid, notFound, dbUnavailable, sendError, sendApiError, handle,
};
