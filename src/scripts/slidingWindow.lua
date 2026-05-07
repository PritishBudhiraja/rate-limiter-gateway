-- ═══════════════════════════════════════════════════════════════════════
-- Sliding Window Log — Atomic Lua Script
-- ═══════════════════════════════════════════════════════════════════════
--
-- This script implements rate limiting using a Sorted Set where each
-- member is a unique request ID and its score is the request timestamp
-- in milliseconds. On every call we:
--   1. Remove entries older than the window
--   2. Count how many entries remain
--   3. If under the limit, add the new entry
--   4. Refresh the key's TTL
--
-- REDIS LEARNING NOTE: Why a Lua script?
-- These four operations MUST happen atomically. If two requests arrive
-- at the same millisecond and we ran them as separate commands, both
-- could read count=9 (under a limit of 10), both add their entry, and
-- the real count would become 11 — exceeding the limit. Redis executes
-- a Lua script as a single, uninterruptible operation, so no other
-- client command can sneak in between steps.
-- ═══════════════════════════════════════════════════════════════════════

-- KEYS[1] = the sorted set key, e.g. "ratelimit:sliding:192.168.1.1"
-- ARGV[1] = now           — current time in milliseconds
-- ARGV[2] = windowMs      — window size in milliseconds (e.g. 60000)
-- ARGV[3] = maxRequests   — max allowed requests in the window
-- ARGV[4] = uniqueMember  — a unique ID for this request (UUID)
-- ARGV[5] = expireSeconds  — TTL for the key (cleanup idle keys)

local key          = KEYS[1]
local now          = tonumber(ARGV[1])
local windowMs     = tonumber(ARGV[2])
local maxRequests  = tonumber(ARGV[3])
local uniqueMember = ARGV[4]
local expireSec    = tonumber(ARGV[5])

-- Calculate the oldest timestamp we care about
local windowStart = now - windowMs

-- REDIS LEARNING NOTE: ZREMRANGEBYSCORE key min max
-- What it does:   Removes all members from the sorted set whose score
--                 falls between `min` and `max` (inclusive).
-- Why used here:  We purge every entry older than (now - windowMs).
--                 Using 0 as min ensures we catch all ancient entries.
-- Return value:   The number of members removed.
redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)

-- REDIS LEARNING NOTE: ZCARD key
-- What it does:   Returns the number of members in the sorted set.
-- Why used here:  After removing stale entries, ZCARD tells us how many
--                 requests fall within the current sliding window. This
--                 is our "current count" for rate limiting.
-- Return value:   Integer — the cardinality (size) of the set.
local currentCount = redis.call('ZCARD', key)

local allowed = 0

if currentCount < maxRequests then
  -- REDIS LEARNING NOTE: ZADD key score member
  -- What it does:   Adds `member` to the sorted set with `score`.
  --                 If the member already exists, its score is updated.
  --                 Members are ordered by score (ascending).
  -- Why used here:  We record this request by adding a unique member
  --                 (UUID) with the current timestamp as its score.
  --                 Using a UUID ensures each request is a distinct
  --                 member — if we used the IP as the member, we could
  --                 only ever store one entry per IP.
  -- Return value:   The number of NEW members added (0 if updated).
  redis.call('ZADD', key, now, uniqueMember)

  allowed = 1
  currentCount = currentCount + 1
end

-- REDIS LEARNING NOTE: EXPIRE key seconds
-- What it does:   Sets a TTL on the key so Redis auto-deletes it after
--                 `seconds` of inactivity.
-- Why used here:  If a client stops sending requests, we don't want
--                 their sorted set hanging around forever wasting memory.
--                 We reset the TTL on every request so the key only
--                 expires after a full window of silence.
-- Return value:   1 if the timeout was set, 0 if the key doesn't exist.
redis.call('EXPIRE', key, expireSec)

-- Return: [allowed (0|1), currentCount, resetAtMs]
-- resetAtMs = the timestamp when the oldest entry in the window expires
return {allowed, currentCount, now + windowMs}
