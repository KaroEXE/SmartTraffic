/**
 * HTTP calls to external providers (OSRM, Nominatim, Overpass).
 *
 *   requestJson(url, options)   one request with a timeout and an identifying
 *                               User-Agent -> { status, json, headers }
 *   createThrottle(options)     spaces requests to one provider, as the public
 *                               OpenStreetMap services require (about 1/s)
 *
 * Failures become UpstreamError with a stable `code`, which the API maps to
 * an HTTP status (utils/apiError.js). Provider URLs may carry API keys, so
 * neither URLs nor response bodies are put into error messages.
 */

class UpstreamError extends Error {
  /**
   * code: PROVIDER_TIMEOUT | PROVIDER_UNREACHABLE | PROVIDER_ERROR | PROVIDER_BUSY
   */
  constructor(code, message, { provider = null, status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfter(headers) {
  const raw = headers && headers.get && headers.get('retry-after');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/**
 * Sends one request. Resolves { status, json, headers } for any HTTP status
 * whose body is JSON (OSRM reports routing errors as 400 + JSON). Rejects
 * with UpstreamError on timeout, network failure, HTTP 429 or a non-JSON
 * error answer.
 */
async function requestJson(url, {
  provider,
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 10_000,
  userAgent,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      body,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(userAgent ? { 'User-Agent': userAgent } : {}), ...headers },
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new UpstreamError('PROVIDER_TIMEOUT', `${provider} did not answer within ${Math.round(timeoutMs / 1000)} s`, { provider });
    }
    throw new UpstreamError('PROVIDER_UNREACHABLE', `${provider} could not be reached`, { provider });
  }
  try {
    if (res.status === 429) {
      throw new UpstreamError('PROVIDER_BUSY', `${provider} is rate limiting this server`, {
        provider, status: 429, retryAfterSeconds: retryAfter(res.headers),
      });
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      if (controller.signal.aborted) {
        throw new UpstreamError('PROVIDER_TIMEOUT', `${provider} did not answer within ${Math.round(timeoutMs / 1000)} s`, { provider });
      }
      throw new UpstreamError('PROVIDER_ERROR', `${provider} returned an unreadable answer (HTTP ${res.status})`, { provider, status: res.status });
    }
    return { status: res.status, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serializes calls to one provider with at least `minIntervalMs` between
 * their starts. With minIntervalMs = 0 (a self-hosted provider) calls run
 * immediately and concurrently. A call that would wait longer than
 * `maxWaitMs` in the queue is refused at once with PROVIDER_BUSY, so a busy
 * public provider cannot make every API request hang.
 */
function createThrottle({ minIntervalMs = 0, maxWaitMs = 8000, provider = 'provider', now = Date.now } = {}) {
  let chain = Promise.resolve();
  let nextStart = 0;
  let queued = 0;

  function schedule(task) {
    if (minIntervalMs <= 0) return task();
    const wait = Math.max(0, nextStart - now()) + queued * minIntervalMs;
    if (wait > maxWaitMs) {
      return Promise.reject(new UpstreamError('PROVIDER_BUSY', `${provider} is busy; try again shortly`, {
        provider, retryAfterSeconds: Math.ceil(wait / 1000),
      }));
    }
    queued += 1;
    // Resolves when this call may start. Only starts are spaced: a slow
    // answer does not hold up the calls queued behind it.
    const turn = chain.then(async () => {
      const delay = nextStart - now();
      if (delay > 0) await new Promise((resolve) => { setTimeout(resolve, delay); });
      nextStart = now() + minIntervalMs;
      queued -= 1;
    });
    chain = turn;
    return turn.then(() => task());
  }

  return { schedule, get queued() { return queued; } };
}

/**
 * True when an error says the provider itself is failing (timeout, no
 * connection, 5xx, unreadable answer, or the provider rate-limiting us) -
 * not a valid "no result" answer and not our own queue being full.
 */
function isProviderFault(err) {
  if (!err || err.name !== 'UpstreamError') return false;
  if (err.code === 'PROVIDER_TIMEOUT' || err.code === 'PROVIDER_UNREACHABLE') return true;
  if (err.code === 'PROVIDER_ERROR') return !err.status || err.status >= 500;
  return err.code === 'PROVIDER_BUSY' && err.status === 429;
}

/**
 * Circuit breaker for one provider: after `failureThreshold` consecutive
 * provider faults it opens for `cooldownMs`, and calls fail at once with
 * PROVIDER_BUSY (503 + Retry-After) instead of each waiting for a timeout.
 * The first call after the cooldown tries the provider again.
 */
function createCircuitBreaker({
  provider = 'provider', failureThreshold = 3, cooldownMs = 30_000, now = Date.now,
} = {}) {
  let failures = 0;
  let openUntil = 0;
  return {
    check() {
      const t = now();
      if (openUntil > t) {
        const retryAfterSeconds = Math.ceil((openUntil - t) / 1000);
        throw new UpstreamError('PROVIDER_BUSY', `${provider} is not responding; retrying it in ${retryAfterSeconds} s`, { provider, retryAfterSeconds });
      }
    },
    success() {
      failures = 0;
      openUntil = 0;
    },
    failure(err) {
      if (!isProviderFault(err)) return;
      failures += 1;
      if (failures >= failureThreshold) {
        openUntil = now() + cooldownMs;
        failures = 0;
      }
    },
    get open() { return openUntil > now(); },
    state() {
      return openUntil > now() ? { circuit: 'open', retryAt: new Date(openUntil).toISOString() } : { circuit: 'closed' };
    },
  };
}

module.exports = {
  UpstreamError, requestJson, createThrottle, createCircuitBreaker, isProviderFault,
};
