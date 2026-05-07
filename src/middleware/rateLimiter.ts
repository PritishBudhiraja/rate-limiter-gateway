/**
 * Rate Limiter Middleware Factory
 *
 * Returns an Express middleware that applies rate limiting using one of
 * three algorithms: fixed window, sliding window log, or token bucket.
 *
 * Supports "stacking" -- you can apply multiple instances (e.g. per-IP burst
 * limit AND per-user sustained limit) on the same route. Each middleware
 * runs independently; the first one to block wins.
 */

import type { NextFunction, Response } from 'express';
import { recordRequest } from '../dashboard/analytics';
import { fixedWindowCheck } from '../limiters/fixedWindow';
import { slidingWindowLogCheck } from '../limiters/slidingWindowLog';
import { tokenBucketCheck } from '../limiters/tokenBucket';
import type {
  AuthenticatedRequest,
  RateLimiterOptions,
  RateLimitResult,
  RedisWithLua,
} from '../types';

export function rateLimiter(client: RedisWithLua, options: RateLimiterOptions) {
  const { algorithm, keyBy, maxRequests, windowSeconds } = options;

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // ── Extract the client identifier ─────────────────────────────────
    let rawIdentifier: string | undefined;

    switch (keyBy) {
      case 'ip':
        // req.ip respects the X-Forwarded-For header when trust proxy is on
        rawIdentifier = req.ip;
        break;
      case 'user':
        // Assumes authentication middleware has set req.user upstream
        rawIdentifier = req.user?.id;
        if (!rawIdentifier) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        break;
      case 'apikey':
        rawIdentifier = req.headers['x-api-key'] as string | undefined;
        if (!rawIdentifier) {
          res.status(401).json({ error: 'API key required (X-API-Key header)' });
          return;
        }
        break;
      default:
        rawIdentifier = req.ip;
    }

    const identifier: string = rawIdentifier || 'unknown';

    try {
      // ── Run the selected algorithm ────────────────────────────────
      let result: RateLimitResult;

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
          throw new Error(`Unknown algorithm: ${algorithm satisfies never}`);
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
        const retryAfter: number = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));

        res.set('Retry-After', String(retryAfter));

        res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          retryAfter,
          limit: maxRequests,
          remaining: 0,
        });
        return;
      }

      next();
    } catch (err) {
      // If Redis is down, we fail open (allow the request) rather than
      // blocking all traffic. In production you might want to fail closed.
      console.error('[RateLimiter] Error:', (err as Error).message);
      next();
    }
  };
}
