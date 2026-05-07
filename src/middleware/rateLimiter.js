/**
 * Rate Limiter Middleware Factory
 *
 * Returns an Express middleware that applies rate limiting using one of
 * three algorithms: fixed window, sliding window log, or token bucket.
 *
 * Supports "stacking" — you can apply multiple instances (e.g. per-IP burst
 * limit AND per-user sustained limit) on the same route. Each middleware
 * runs independently; the first one to block wins.
 */

const { fixedWindowCheck } = require('../limiters/fixedWindow');
const { slidingWindowLogCheck } = require('../limiters/slidingWindowLog');
const { tokenBucketCheck } = require('../limiters/tokenBucket');
const { recordRequest } = require('../dashboard/analytics');

/**
 * @param {import('ioredis').Redis} client — ioredis instance
 * @param {Object} options
 * @param {'fixed'|'sliding'|'token'} options.algorithm   — which limiter to use
 * @param {'ip'|'user'|'apikey'}      options.keyBy       — how to identify the client
 * @param {number}                    options.maxRequests  — requests (or tokens) per window
 * @param {number}                    options.windowSeconds — window duration in seconds
 * @returns {Function} Express middleware
 */
function rateLimiter(client, options) {
  const { algorithm, keyBy, maxRequests, windowSeconds } = options;

  return async (req, res, next) => {
    // ── Extract the client identifier ─────────────────────────────────
    let identifier;

    switch (keyBy) {
      case 'ip':
        // req.ip respects the X-Forwarded-For header when trust proxy is on
        identifier = req.ip;
        break;
      case 'user':
        // Assumes authentication middleware has set req.user upstream
        identifier = req.user?.id;
        if (!identifier) {
          return res.status(401).json({ error: 'Authentication required' });
        }
        break;
      case 'apikey':
        identifier = req.headers['x-api-key'];
        if (!identifier) {
          return res.status(401).json({ error: 'API key required (X-API-Key header)' });
        }
        break;
      default:
        identifier = req.ip;
    }

    try {
      // ── Run the selected algorithm ────────────────────────────────
      let result;

      switch (algorithm) {
        case 'fixed':
          result = await fixedWindowCheck(client, identifier, maxRequests, windowSeconds);
          break;
        case 'sliding':
          result = await slidingWindowLogCheck(client, identifier, maxRequests, windowSeconds);
          break;
        case 'token':
          result = await tokenBucketCheck(client, identifier, maxRequests, windowSeconds);
          break;
        default:
          throw new Error(`Unknown algorithm: ${algorithm}`);
      }

      // ── Record analytics for every request ────────────────────────
      await recordRequest(client, algorithm, identifier, result.allowed);

      // ── Set rate-limit response headers ───────────────────────────
      // These headers follow the IETF draft "RateLimit Header Fields"
      // convention, widely adopted by APIs (GitHub, Stripe, etc.)
      res.set({
        'X-RateLimit-Limit': String(maxRequests),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.resetAt),
      });

      if (!result.allowed) {
        // Calculate seconds until the limit resets
        const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));

        res.set('Retry-After', String(retryAfter));

        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          retryAfter,
          limit: maxRequests,
          remaining: 0,
        });
      }

      next();
    } catch (err) {
      // If Redis is down, we fail open (allow the request) rather than
      // blocking all traffic. In production you might want to fail closed.
      console.error('[RateLimiter] Error:', err.message);
      next();
    }
  };
}

module.exports = { rateLimiter };
