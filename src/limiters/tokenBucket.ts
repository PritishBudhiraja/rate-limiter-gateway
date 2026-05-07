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

import type { RateLimitResult, RedisWithLua } from '../types';

export async function tokenBucketCheck(
  client: RedisWithLua,
  identifier: string,
  maxTokens: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key: string = `ratelimit:bucket:${identifier}`;
  const now: number = Date.now();

  // refillRate = tokens per second.
  // If maxTokens=100 and windowSeconds=60, we add ~1.67 tokens/sec.
  const refillRate: number = maxTokens / windowSeconds;

  // REDIS LEARNING NOTE: client.tokenbucket() calls our registered Lua
  // script. The Lua script handles the entire read-compute-write cycle
  // atomically: read current tokens -> calculate refill -> consume 1
  // -> write back. This prevents double-spending under concurrency.
  const result: [number, number, number] = await client.tokenbucket(
    key, // KEYS[1]
    now, // ARGV[1] -- current timestamp in ms
    maxTokens, // ARGV[2] -- bucket capacity
    refillRate, // ARGV[3] -- tokens per second
    windowSeconds * 2, // ARGV[4] -- TTL (2x window for safety margin)
  );

  // Lua returns: [allowed (0|1), remainingTokens, resetAtMs]
  const allowed: boolean = result[0] === 1;
  const remaining: number = result[1];
  const resetAtMs: number = result[2];

  const resetAt: number = Math.ceil(resetAtMs / 1000);

  return { allowed, remaining, resetAt };
}
