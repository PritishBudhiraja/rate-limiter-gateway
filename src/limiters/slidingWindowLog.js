/**
 * Sliding Window Log Rate Limiter
 *
 * Uses a Redis Sorted Set to track every request timestamp within a rolling
 * window. Unlike Fixed Window, there are no discrete buckets — the window
 * slides with the current time, so there is no "edge burst" problem.
 *
 * Pros: Very precise, no boundary spike.
 * Cons: Higher memory — stores one sorted-set member per request.
 *
 * All Redis operations are wrapped in a Lua script (slidingWindow.lua) to
 * guarantee atomicity.
 */

const { v4: uuidv4 } = require('uuid');

/**
 * @param {import('ioredis').Redis} client  — ioredis instance (with slidingwindow command registered)
 * @param {string}  identifier              — unique ID (IP, user ID, API key)
 * @param {number}  maxRequests             — requests allowed per window
 * @param {number}  windowSeconds           — window duration in seconds
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
 */
async function slidingWindowLogCheck(client, identifier, maxRequests, windowSeconds) {
  const key = `ratelimit:sliding:${identifier}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  // Generate a unique member for each request so every entry is distinct
  // in the sorted set. If we used the identifier as the member, ZADD would
  // just update the score rather than adding a new entry.
  const uniqueMember = `${identifier}:${uuidv4()}`;

  // REDIS LEARNING NOTE: client.slidingwindow() calls our registered Lua
  // script via EVALSHA (or EVAL on first use). The arguments are:
  //   numberOfKeys = 1  → KEYS[1] = key
  //   ARGV = [now, windowMs, maxRequests, uniqueMember, expireSeconds]
  //
  // The Lua script runs atomically on the Redis server — even if 100
  // concurrent requests arrive, Redis executes each script invocation
  // one at a time, so counts are always accurate.
  const result = await client.slidingwindow(
    key,               // KEYS[1]
    now,               // ARGV[1] — current timestamp in ms
    windowMs,          // ARGV[2] — window size in ms
    maxRequests,       // ARGV[3] — max requests allowed
    uniqueMember,      // ARGV[4] — unique member for ZADD
    windowSeconds * 2  // ARGV[5] — TTL (2× window for safety margin)
  );

  // Lua returns an array: [allowed (0|1), currentCount, resetAtMs]
  const allowed = result[0] === 1;
  const currentCount = result[1];
  const resetAtMs = result[2];

  const remaining = Math.max(0, maxRequests - currentCount);
  const resetAt = Math.ceil(resetAtMs / 1000);

  return { allowed, remaining, resetAt };
}

module.exports = { slidingWindowLogCheck };
