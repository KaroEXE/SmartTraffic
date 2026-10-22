const { sendError } = require('./apiError');

/**
 * Fixed-window rate limiter (Express middleware), in memory.
 *
 * Counters live in this process, so limits apply per backend instance; a
 * deployment with several instances needs a shared store (e.g. Redis) -
 * see docs/DEPLOYMENT.md. Every answer carries RateLimit-Limit,
 * RateLimit-Remaining and RateLimit-Reset (seconds); a refused request gets
 * 429 RATE_LIMITED with Retry-After.
 *
 *   key(req) -> string | null   null = not limited (e.g. no device yet)
 */
function createRateLimiter({
  name, windowMs, max, key = (req) => req.ip, now = Date.now,
}) {
  const windows = new Map(); // key -> { count, resetAt }
  let nextSweep = 0;

  function sweep(t) {
    if (t < nextSweep) return;
    nextSweep = t + windowMs;
    for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
  }

  function middleware(req, res, next) {
    const k = key(req);
    if (k === null || k === undefined) return next();
    const t = now();
    sweep(t);
    let w = windows.get(k);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      windows.set(k, w);
    }
    w.count += 1;
    const resetSeconds = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - w.count)));
    res.set('RateLimit-Reset', String(resetSeconds));
    if (w.count > max) {
      return sendError(res, 429, 'RATE_LIMITED', `Too many ${name} requests; try again in ${resetSeconds} s`, {
        retryAfterSeconds: resetSeconds,
      });
    }
    return next();
  }

  middleware.reset = () => windows.clear();
  return middleware;
}

module.exports = { createRateLimiter };
