/**
 * Analytics Dashboard
 *
 * Tracks two kinds of data in Redis:
 *   1. Per-algorithm hit counts  -> stored in a Redis Hash  "analytics:hits"
 *   2. Blocked request log       -> stored in a Sorted Set  "analytics:blocked"
 *
 * The recording functions are called from the rate limiter middleware on every
 * request. The dashboard route reads all analytics in a single Redis pipeline
 * to minimize round-trips.
 */

import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Algorithm, BlockedEntry, DashboardResponse } from '../types';

// ═══════════════════════════════════════════════════════════════════════
// Recording (called from middleware on every request)
// ═══════════════════════════════════════════════════════════════════════

export async function recordRequest(
  client: Redis,
  algorithm: Algorithm,
  identifier: string,
  allowed: boolean,
): Promise<void> {
  // REDIS LEARNING NOTE: HINCRBY key field increment
  // What it does:   Atomically increments a numeric field in a Hash by
  //                 `increment`. If the field or key doesn't exist, Redis
  //                 creates it and initializes to 0 before incrementing.
  // Why used here:  We track total request count and per-algorithm counts
  //                 in a single Hash. HINCRBY is O(1) and lock-free.
  // Return value:   The new value of the field after incrementing.
  await client.hincrby('analytics:hits', 'total', 1);
  await client.hincrby('analytics:hits', algorithm, 1);

  if (!allowed) {
    // Increment the "blocked" counter in the same Hash
    await client.hincrby('analytics:hits', 'blocked', 1);

    // REDIS LEARNING NOTE: ZADD key score member
    // What it does:   Adds `member` to a Sorted Set with `score`.
    //                 Members are unique; if the member already exists,
    //                 its score is updated.
    // Why used here:  We log each blocked request with the current
    //                 timestamp as the score. Using the identifier as
    //                 the member means each IP/user appears once, with
    //                 the score updated to the LATEST block time. This
    //                 gives us a leaderboard of "most recently blocked"
    //                 identifiers that we can query with ZREVRANGE.
    // Return value:   Number of NEW members added (0 if the member
    //                 already existed and only its score was updated).
    const now: number = Date.now();
    await client.zadd('analytics:blocked', now, identifier);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Dashboard route handler
// ═══════════════════════════════════════════════════════════════════════

export function dashboardHandler(client: Redis) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // REDIS LEARNING NOTE: client.pipeline()
      // What it does:   Creates a pipeline -- a buffer that queues multiple
      //                 commands and sends them to Redis in a SINGLE TCP
      //                 round-trip, then reads all replies at once.
      // Why used here:  Without a pipeline, each command below would be:
      //                   send command -> wait for reply -> send next command
      //                 That's 3 round-trips (network latency x 3). With a
      //                 pipeline, all 3 commands travel in ONE packet, and
      //                 all 3 replies come back in ONE packet. If Redis is
      //                 on a remote server with 2ms latency, a pipeline
      //                 saves ~4ms (67% reduction). At scale, this adds up.
      // Return value:   An array of [error, result] pairs, one per command,
      //                 in the order they were queued.
      const pipeline = client.pipeline();

      // Command 1: Get all hit counters
      // REDIS LEARNING NOTE: HGETALL key
      // What it does:   Returns ALL field-value pairs in a Hash as an object.
      // Why used here:  We read total, blocked, and per-algorithm counts in
      //                 one shot.
      // Return value:   An object like { total: '42', blocked: '5', fixed: '20', ... }
      pipeline.hgetall('analytics:hits');

      // Command 2: Get top 10 most recently blocked identifiers
      // REDIS LEARNING NOTE: ZREVRANGE key start stop WITHSCORES
      // What it does:   Returns members of a Sorted Set ordered by score
      //                 from HIGH to LOW (reverse order). WITHSCORES
      //                 includes the score alongside each member.
      //                 start=0, stop=9 gives the top 10.
      // Why used here:  We want the 10 most recently blocked IPs/users.
      //                 Since score = timestamp, the highest scores are
      //                 the most recent blocks.
      // Return value:   An array alternating [member, score, member, score, ...]
      pipeline.zrevrange('analytics:blocked', 0, 9, 'WITHSCORES');

      // Command 3: Total number of unique blocked identifiers
      // REDIS LEARNING NOTE: ZCARD key
      // What it does:   Returns the number of members in a Sorted Set.
      // Why used here:  Tells us how many distinct IPs/users have been
      //                 blocked at least once.
      // Return value:   Integer -- cardinality of the set.
      pipeline.zcard('analytics:blocked');

      // Execute all three commands in one round-trip
      const results = await pipeline.exec();

      if (!results) {
        res.status(500).json({ error: 'Pipeline returned no results' });
        return;
      }

      // Parse results -- each entry is [error, value]
      const hits = (results[0][1] as Record<string, string>) || {};
      const topBlockedRaw = (results[1][1] as string[]) || [];
      const uniqueBlocked = (results[2][1] as number) || 0;

      // Transform the raw ZREVRANGE response into a structured array
      const topBlocked: BlockedEntry[] = [];
      for (let i = 0; i < topBlockedRaw.length; i += 2) {
        topBlocked.push({
          identifier: topBlockedRaw[i],
          lastBlockedAt: new Date(parseInt(topBlockedRaw[i + 1], 10)).toISOString(),
        });
      }

      const response: DashboardResponse = {
        summary: {
          totalRequests: parseInt(hits.total, 10) || 0,
          totalBlocked: parseInt(hits.blocked, 10) || 0,
          uniqueBlockedIdentifiers: uniqueBlocked,
        },
        perAlgorithm: {
          fixed: parseInt(hits.fixed, 10) || 0,
          sliding: parseInt(hits.sliding, 10) || 0,
          token: parseInt(hits.token, 10) || 0,
        },
        topBlockedIdentifiers: topBlocked,
      };

      res.json(response);
    } catch (err) {
      console.error('[Analytics] Error:', (err as Error).message);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  };
}
