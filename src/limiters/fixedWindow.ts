/**
 * Fixed Window Rate Limiter
 *
 * Divides time into discrete, non-overlapping windows (e.g. 0-60s, 60-120s).
 * Each window has a counter; once it exceeds maxRequests the client is blocked
 * until the next window starts.
 *
 * Pros: Very simple, low memory (one key per identifier per window).
 * Cons: "Edge burst" -- a client can fire maxRequests at second 59 and again at
 *        second 61, effectively doubling throughput across the boundary.
 *
 * Redis commands used: INCR, EXPIRE, TTL
 */

import type { Redis } from 'ioredis';
import type { RateLimitResult } from '../types';

export async function fixedWindowCheck(
  client: Redis,
  identifier: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  // Compute the start timestamp of the current window.
  // Example: if windowSeconds = 60 and Date.now()/1000 = 1700000042,
  // windowStart = 1700000040 -- all requests in [40, 100) share this key.
  const nowSeconds: number = Math.floor(Date.now() / 1000);
  const windowStart: number = Math.floor(nowSeconds / windowSeconds) * windowSeconds;

  // Key pattern: ratelimit:fixed:{identifier}:{windowStart}
  // Each window gets its own key, so old windows auto-expire.
  const key: string = `ratelimit:fixed:${identifier}:${windowStart}`;

  // REDIS LEARNING NOTE: INCR key
  // What it does:   Atomically increments the integer at `key` by 1.
  //                 If the key does not exist, Redis creates it with value 0
  //                 first, then increments -- so the first call returns 1.
  // Why used here:  Each call represents one request. The returned value is
  //                 the total request count in this window.
  // Return value:   The new integer value after incrementing (e.g. 1, 2, 3...).
  const currentCount: number = await client.incr(key);

  if (currentCount === 1) {
    // REDIS LEARNING NOTE: EXPIRE key seconds
    // What it does:   Sets a time-to-live (TTL) on the key. After `seconds`
    //                 elapse, Redis automatically deletes the key.
    // Why used here:  We only call EXPIRE when count === 1 (first request in
    //                 this window). This ensures the key lives exactly one
    //                 window duration and then disappears, freeing memory.
    //                 We don't call EXPIRE on every request because EXPIRE
    //                 *resets* the TTL -- that would keep extending the window.
    // Return value:   1 if the timeout was set, 0 if the key doesn't exist.
    await client.expire(key, windowSeconds);
  }

  // REDIS LEARNING NOTE: TTL key
  // What it does:   Returns the remaining time-to-live of the key in seconds.
  // Why used here:  We expose this as `resetAt` so the client knows when the
  //                 current window ends and their limit resets.
  // Return value:   Positive integer (seconds remaining), -1 if the key has
  //                 no expiry, -2 if the key doesn't exist.
  const ttl: number = await client.ttl(key);

  const allowed: boolean = currentCount <= maxRequests;
  const remaining: number = Math.max(0, maxRequests - currentCount);
  const resetAt: number = nowSeconds + (ttl > 0 ? ttl : windowSeconds);

  return { allowed, remaining, resetAt };
}
