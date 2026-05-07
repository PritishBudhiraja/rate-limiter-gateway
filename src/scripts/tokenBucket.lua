-- ═══════════════════════════════════════════════════════════════════════
-- Token Bucket — Atomic Lua Script
-- ═══════════════════════════════════════════════════════════════════════
--
-- Models a bucket that:
--   • Has a maximum capacity of `maxTokens` tokens
--   • Refills at `refillRate` tokens per second
--   • Each request consumes exactly 1 token
--   • If no tokens are available, the request is rejected
--
-- State is stored in a Redis Hash with two fields:
--   tokens     — current number of tokens (float for fractional refills)
--   lastRefill — timestamp of the last refill calculation (in ms)
--
-- REDIS LEARNING NOTE: Why a Lua script?
-- The token bucket requires a read-modify-write cycle:
--   1. Read current tokens and lastRefill time
--   2. Calculate how many tokens have been added since last refill
--   3. Deduct 1 token if available
--   4. Write the new state back
-- If two concurrent requests both read "5 tokens" at the same instant,
-- they'd both think they can consume 1 and both write "4 tokens" — but
-- the correct answer is "3 tokens". By running this in Lua, Redis
-- guarantees the entire sequence is atomic.
-- ═══════════════════════════════════════════════════════════════════════

-- KEYS[1] = the hash key, e.g. "ratelimit:bucket:192.168.1.1"
-- ARGV[1] = now          — current time in milliseconds
-- ARGV[2] = maxTokens    — bucket capacity (e.g. 10)
-- ARGV[3] = refillRate   — tokens added per second (e.g. 1.67 for 100/min)
-- ARGV[4] = expireSec    — TTL for the key (cleanup idle keys)

local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local maxTokens  = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local expireSec  = tonumber(ARGV[4])

-- REDIS LEARNING NOTE: HMGET key field1 field2
-- What it does:   Returns the values of one or more fields in a Hash.
--                 Fields that don't exist return nil.
-- Why used here:  We read the two pieces of state we need — the current
--                 token count and the time of the last refill — in a
--                 single command (more efficient than two HGET calls).
-- Return value:   An array of values in the same order as the fields.
local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')

local tokens
local lastRefill

if bucket[1] == false then
  -- Key doesn't exist yet — first request from this identifier.
  -- Initialize with a full bucket.
  tokens     = maxTokens
  lastRefill = now
else
  tokens     = tonumber(bucket[1])
  lastRefill = tonumber(bucket[2])
end

-- Calculate how many tokens to add based on elapsed time
local elapsedMs    = now - lastRefill
local elapsedSec   = elapsedMs / 1000
local tokensToAdd  = elapsedSec * refillRate

-- Refill the bucket, capped at maxTokens
tokens     = math.min(maxTokens, tokens + tokensToAdd)
lastRefill = now

local allowed = 0

if tokens >= 1 then
  -- Consume 1 token for this request
  tokens  = tokens - 1
  allowed = 1
end

-- REDIS LEARNING NOTE: HSET key field1 value1 field2 value2
-- What it does:   Sets one or more field-value pairs in a Hash.
--                 Creates the Hash if it doesn't exist. Overwrites
--                 existing fields.
-- Why used here:  We persist the updated token count and refill
--                 timestamp so the next request picks up where we
--                 left off.
-- Return value:   The number of NEW fields added (0 if only updates).
redis.call('HSET', key, 'tokens', tokens, 'lastRefill', lastRefill)

-- REDIS LEARNING NOTE: EXPIRE key seconds
-- What it does:   Sets a TTL so Redis auto-deletes the key after idle time.
-- Why used here:  If a client disappears, we don't want their hash
--                 consuming memory forever. The TTL resets on every
--                 request so active clients never lose their bucket.
-- Return value:   1 if the timeout was set, 0 if the key doesn't exist.
redis.call('EXPIRE', key, expireSec)

-- Calculate when the next token will be available (for Retry-After header)
local msUntilNextToken = 0
if allowed == 0 then
  -- tokens is currently < 1; figure out how long until it reaches 1
  local deficit = 1 - tokens
  msUntilNextToken = math.ceil((deficit / refillRate) * 1000)
end

-- Return: [allowed (0|1), remaining tokens (floored), resetAtMs]
return {allowed, math.floor(tokens), now + msUntilNextToken}
