const {
  requestJson, createThrottle, createCircuitBreaker, isProviderFault, UpstreamError,
} = require('../../utils/upstream');
const { ApiError } = require('../../utils/apiError');

/**
 * One HTTP client per external provider (Geoapify for search, places and routing;
 * an optional self-hosted OSRM for routing). Both get the same behaviour:
 *
 *   - a throttle that spaces request starts (providers limit requests per second),
 *   - a circuit breaker (repeated timeouts / 5xx / rate limiting bench the provider
 *     for a while instead of making every request wait for a timeout),
 *   - a daily budget counted in credits, so this server stops before it spends a
 *     plan (cached answers never reach the client, so they cost nothing),
 *   - errors without URLs, keys or provider text.
 *
 * The API key travels in a request header, never in a URL: URLs end up in logs.
 * Provider-specific meaning of HTTP errors comes from `mapError(status, json, headers)`.
 */

function retryAfterSeconds(headers) {
  const seconds = Number(headers && headers.get && headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

const GENERIC_AUTH = 'The map service is not available right now';

/**
 * Geoapify errors: { statusCode, error, message } with the HTTP status.
 * 401 / 403 are our key (a configuration problem, never shown to clients);
 * 429 is rate limiting; routing failures are 400 with a message:
 *   "No suitable edges near location..." -> a point is not on a road.
 */
function geoapifyError(status, json, headers) {
  const message = json && typeof json.message === 'string' ? json.message : '';
  if (status === 401 || status === 403) return new ApiError(502, 'PROVIDER_AUTH_FAILED', GENERIC_AUTH);
  if (status === 429) {
    return new UpstreamError('PROVIDER_BUSY', 'Map provider is rate limiting this server', { provider: 'Map provider', status: 429, retryAfterSeconds: retryAfterSeconds(headers) });
  }
  if (status === 400) {
    if (/no suitable edges/i.test(message)) return new ApiError(422, 'POINT_NOT_ROUTABLE', 'A point is too far from any road; choose a point on or near a road');
    if (/route.*not found|no route|unreachable/i.test(message)) return new ApiError(422, 'NO_ROUTE', 'No drivable route was found between these points');
    return new ApiError(400, 'INVALID_REQUEST', 'The map provider rejected the request');
  }
  return new UpstreamError('PROVIDER_ERROR', `Map provider answered HTTP ${status}`, { provider: 'Map provider', status });
}

/** OSRM errors: { code: 'NoRoute' | 'NoSegment' | ..., message }. */
function osrmError(status, json, headers) {
  const code = json && json.code;
  if (code === 'NoRoute') return new ApiError(422, 'NO_ROUTE', 'No drivable route was found between these points');
  if (code === 'NoSegment') return new ApiError(422, 'POINT_NOT_ROUTABLE', 'A point is too far from any road; choose a point on or near a road');
  if (code === 'InvalidValue' || code === 'InvalidQuery' || code === 'TooBig') return new ApiError(400, 'INVALID_REQUEST', 'The routing server rejected the request');
  if (status === 429) {
    return new UpstreamError('PROVIDER_BUSY', 'Routing server is rate limiting this server', { provider: 'Routing server', status: 429, retryAfterSeconds: retryAfterSeconds(headers) });
  }
  return new UpstreamError('PROVIDER_ERROR', `Routing server answered HTTP ${status}`, { provider: 'Routing server', status });
}

function createProviderClient({
  name,
  baseUrl,
  headers = {},
  mapError,
  minIntervalMs = 0,
  timeoutMs = 15000,
  dailyLimit = 0,
  userAgent,
  maxWaitMs = 8000,
  cooldownMs = 30_000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = console,
}) {
  const enabled = Boolean(baseUrl);
  const throttle = createThrottle({
    minIntervalMs, maxWaitMs, provider: name, now,
  });
  const breaker = createCircuitBreaker({
    provider: name, failureThreshold: 3, cooldownMs, now,
  });
  const stats = { requests: 0, failures: 0, lastError: null, lastErrorAt: null };
  const budget = { day: null, used: 0 };
  const DAY_MS = 86_400_000;
  let authLogged = false;

  /** Counts `cost` credits against today's budget, or throws when it is used up. */
  function spend(cost) {
    const t = now();
    const day = Math.floor(t / DAY_MS);
    if (budget.day !== day) { budget.day = day; budget.used = 0; }
    if (dailyLimit > 0 && budget.used + cost > dailyLimit) {
      throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'The daily map request budget of this server is used up; it resets at 00:00 UTC', {
        retryAfterSeconds: Math.ceil(((day + 1) * DAY_MS - t) / 1000),
      });
    }
    budget.used += cost;
  }

  function fail(err) {
    stats.failures += 1;
    stats.lastError = err.code || 'PROVIDER_ERROR';
    stats.lastErrorAt = new Date(now()).toISOString();
    return err;
  }

  /** GET path with query params (arrays are not used); resolves the parsed JSON body. `cost`: credits this call uses. */
  async function get(path, params = {}, { cost = 1 } = {}) {
    if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', `${name} is not configured on this server`);
    breaker.check();
    spend(cost);
    stats.requests += 1;
    const query = new URLSearchParams(params).toString();
    let answer;
    try {
      answer = await throttle.schedule(() => requestJson(`${baseUrl}${path}${query ? `?${query}` : ''}`, {
        provider: name, timeoutMs, userAgent, fetchImpl, headers, passRateLimit: true,
      }));
    } catch (err) {
      breaker.failure(err);
      throw fail(err);
    }
    if (answer.status >= 400) {
      const err = mapError(answer.status, answer.json, answer.headers);
      // Credentials are our own configuration: say what is wrong in the log (once), never to clients.
      if (err.code === 'PROVIDER_AUTH_FAILED' && !authLogged) {
        authLogged = true;
        log.error(`[${name}] The provider refused this server's key (HTTP ${answer.status}). Check the key and its allowed IP addresses in the provider console.`);
      }
      if (isProviderFault(err)) breaker.failure(err); else breaker.success();
      throw fail(err);
    }
    breaker.success();
    return answer.json;
  }

  return {
    enabled,
    get,
    status() {
      return {
        enabled,
        provider: enabled ? name : null,
        ...breaker.state(),
        ...stats,
        dailyBudget: { limit: dailyLimit || null, usedToday: budget.day === Math.floor(now() / DAY_MS) ? budget.used : 0 },
      };
    },
  };
}

/** The Geoapify client: key in the x-api-key header, spaced for 5 requests per second. */
function createGeoapifyClient({ config, ...rest }) {
  return createProviderClient({
    name: 'geoapify',
    baseUrl: config.apiKey ? config.baseUrl : null,
    headers: { 'x-api-key': config.apiKey },
    mapError: geoapifyError,
    minIntervalMs: config.minIntervalMs,
    timeoutMs: config.timeoutMs,
    dailyLimit: config.dailyLimit,
    ...rest,
  });
}

/** A self-hosted OSRM (no key, no per-second limit, no budget). */
function createOsrmClient({ config, ...rest }) {
  return createProviderClient({
    name: 'osrm', baseUrl: config.osrmUrl || null, mapError: osrmError, minIntervalMs: 0, timeoutMs: config.timeoutMs, ...rest,
  });
}

module.exports = {
  createProviderClient, createGeoapifyClient, createOsrmClient, geoapifyError, osrmError,
};
