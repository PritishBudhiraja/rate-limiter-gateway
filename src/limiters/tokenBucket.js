/**
 * Token Bucket Rate Limiter
 *
 * Models a bucket with a fixed capacity that refills at a constant rate.
 * Each request consumes one token. When the bucket is empty, requests are
 * blocked until enough tokens have refilled.
 *
 * Pros:  Allows natural bursting (up to bucket capacity) while enforcing
 *        a sustained average rate. Most realistic model for real-world APIs.
 * Cons:  Slightly more complex state (two fields instead of one counter).
 *
 * All operations run inside a Lua script (tokenBucket.lua) to prevent
 * race conditions in the read-compute-write cycle.
 */

/**
 * @param {import('ioredis').Redis} client  — ioredis instance (with tokenbucket command registered)
 * @param {string}  identifier              — unique ID (IP, user ID, API key)
 * @param {number}  maxTokens               — bucket capacity
 * @param {number}  windowSeconds           — time window to spread tokens over
 *                                            (refillRate = maxTokens / windowSeconds)
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
 */
async function tokenBucketCheck(client, identifier, maxTokens, windowSeconds) {
  const key = `ratelimit:bucket:${identifier}`;
  const now = Date.now();

  // refillRate = tokens per second.
  // If maxTokens=100 and windowSeconds=60, we add ~1.67 tokens/sec.
  const refillRate = maxTokens / windowSeconds;

  // REDIS LEARNING NOTE: client.tokenbucket() calls our registered Lua
  // script. The Lua script handles the entire read-compute-write cycle
  // atomically: read current tokens → calculate refill → consume 1
  // → write back. This prevents double-spending under concurrency.
  const result = await client.tokenbucket(
    key,                // KEYS[1]
    now,                // ARGV[1] — current timestamp in ms
    maxTokens,          // ARGV[2] — bucket capacity
    refillRate,         // ARGV[3] — tokens per second
    windowSeconds * 2   // ARGV[4] — TTL (2× window for safety margin)
  );

  // Lua returns: [allowed (0|1), remainingTokens, resetAtMs]
  const allowed = result[0] === 1;
  const remaining = result[1];
  const resetAtMs = result[2];

  const resetAt = Math.ceil(resetAtMs / 1000);

  return { allowed, remaining, resetAt };
}

module.exports = { tokenBucketCheck };
