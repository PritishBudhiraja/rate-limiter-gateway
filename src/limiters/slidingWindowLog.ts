/**
 * Sliding Window Log Rate Limiter
 *
 * Uses a Redis Sorted Set to track every request timestamp within a rolling
 * window. Unlike Fixed Window, there are no discrete buckets -- the window
 * slides with the current time, so there is no "edge burst" problem.
 *
 * Pros: Very precise, no boundary spike.
 * Cons: Higher memory -- stores one sorted-set member per request.
 *
 * All Redis operations are wrapped in a Lua script (slidingWindow.lua) to
 * guarantee atomicity.
 */

import { v4 as uuidv4 } from 'uuid';
import type { RateLimitResult, RedisWithLua } from '../types';

export async function slidingWindowLogCheck(
  client: RedisWithLua,
  identifier: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key: string = `ratelimit:sliding:${identifier}`;
  const now: number = Date.now();
  const windowMs: number = windowSeconds * 1000;

  // Generate a unique member for each request so every entry is distinct
  // in the sorted set. If we used the identifier as the member, ZADD would
  // just update the score rather than adding a new entry.
  const uniqueMember: string = `${identifier}:${uuidv4()}`;

  // REDIS LEARNING NOTE: client.slidingwindow() calls our registered Lua
  // script via EVALSHA (or EVAL on first use). The arguments are:
  //   numberOfKeys = 1  -> KEYS[1] = key
  //   ARGV = [now, windowMs, maxRequests, uniqueMember, expireSeconds]
  //
  // The Lua script runs atomically on the Redis server -- even if 100
  // concurrent requests arrive, Redis executes each script invocation
  // one at a time, so counts are always accurate.
  const result: [number, number, number] = await client.slidingwindow(
    key, // KEYS[1]
    now, // ARGV[1] -- current timestamp in ms
    windowMs, // ARGV[2] -- window size in ms
    maxRequests, // ARGV[3] -- max requests allowed
    uniqueMember, // ARGV[4] -- unique member for ZADD
    windowSeconds * 2, // ARGV[5] -- TTL (2x window for safety margin)
  );

  // Lua returns an array: [allowed (0|1), currentCount, resetAtMs]
  const allowed: boolean = result[0] === 1;
  const currentCount: number = result[1];
  const resetAtMs: number = result[2];

  const remaining: number = Math.max(0, maxRequests - currentCount);
  const resetAt: number = Math.ceil(resetAtMs / 1000);

  return { allowed, remaining, resetAt };
}
