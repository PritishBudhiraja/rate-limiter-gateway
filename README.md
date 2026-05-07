# Rate Limiter API Gateway

A production-quality rate limiter built with **Node.js + Express + Redis + Docker**, designed as a hands-on Redis learning project. Every Redis command in the source code has a `REDIS LEARNING NOTE` comment explaining what it does, why it's used, and what its return value means.

---

## Quick Start

```bash
# 1. Clone and enter the project
cd rate-limiter-gateway

# 2. Copy env file
cp .env.example .env

# 3. Start Redis and the app with Docker
docker-compose up --build

# 4. The API is now running at http://localhost:3000
```

### Without Docker (local Redis required)

```bash
npm install
REDIS_HOST=127.0.0.1 REDIS_PORT=6379 npm start
```

---

## Routes

| Route              | Algorithm        | Limit                        |
|--------------------|------------------|------------------------------|
| `GET /public`      | None             | No rate limit                |
| `GET /api/data`    | Sliding Window   | 10 req/min per IP            |
| `GET /api/user`    | Fixed Window     | 100 req/min per user         |
| `GET /api/protected` | Token Bucket + Fixed | 20 req/10s per IP + 100 req/min per user |
| `GET /dashboard`   | —                | Analytics view               |

---

## Rate Limiting Algorithms Explained

### 1. Fixed Window

Divides time into discrete, non-overlapping buckets. A single counter per bucket tracks requests.

```
Timeline:     0s ------------- 60s ------------- 120s
               |   Window 1    |    Window 2    |
               |               |                |
Request flow:  ||||| ||  |     |  |||| |||      |
Counter:       1→2→3→4→5→6→7→8  1→2→3→4→5→6→7
               ↑               ↑
            INCR + EXPIRE    INCR + EXPIRE
              (new key)        (new key)
```

**Redis commands:** `INCR`, `EXPIRE`, `TTL`

**How it works:**
1. Compute the window start: `floor(now / windowSeconds) * windowSeconds`
2. Build a key: `ratelimit:fixed:{ip}:{windowStart}`
3. `INCR` the key (atomic counter bump)
4. On first request (`count == 1`), `EXPIRE` the key so it auto-deletes
5. If count > limit, block the request

**Edge-burst problem:**
```
                 Window 1          Window 2
              [0s ─────── 60s] [60s ─────── 120s]
                          ↑↑↑↑  ↑↑↑↑
              A user sends 10 requests at second 59
              and 10 more at second 61.
              That's 20 requests in 2 seconds, but each
              window only sees 10 — both pass!
```

---

### 2. Sliding Window Log

Tracks every request timestamp in a Redis Sorted Set. The window slides with the current time — no fixed boundaries.

```
                  now - 60s                         now
                     |<---------- window ---------->|
                     |                              |
Sorted Set:   [ts1, ts2, ts3, ts4, ts5, ts6, ts7, ts8]
               ↑ removed ↑      ↑─── counted ──────↑
           (ZREMRANGEBYSCORE)        (ZCARD)

On new request:
  1. ZREMRANGEBYSCORE: remove entries older than (now - 60s)
  2. ZCARD: count remaining entries
  3. If count < limit: ZADD new entry with score = now
  4. EXPIRE key for cleanup
```

**Redis commands:** `ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`, `EXPIRE`

**All wrapped in a Lua script** for atomicity — see `src/scripts/slidingWindow.lua`.

---

### 3. Token Bucket

Models a bucket that fills with tokens at a steady rate. Each request consumes one token.

```
Capacity: 10 tokens     Refill rate: 2 tokens/sec

Time 0s:   [##########]   10/10 tokens (full bucket)
             ↓ 3 requests arrive
Time 0s:   [#######___]    7/10 tokens

             ↓ 2 seconds pass, +4 tokens refilled
Time 2s:   [##########]   10/10 tokens (capped at max)

             ↓ 12 requests arrive rapidly
Time 2s:   [__________]    0/10 tokens → requests 11 & 12 BLOCKED
                                         429 Too Many Requests

             ↓ 0.5 seconds pass, +1 token refilled
Time 2.5s: [#_________]    1/10 tokens → next request allowed
```

**Redis commands:** `HMGET`, `HSET`, `EXPIRE`

**All wrapped in a Lua script** — see `src/scripts/tokenBucket.lua`.

**State stored in a Hash:**
```
HGETALL ratelimit:bucket:192.168.1.1
→ { "tokens": "7.33", "lastRefill": "1700000042000" }
```

---

## Algorithm Comparison

| Property         | Fixed Window          | Sliding Window Log    | Token Bucket           |
|------------------|-----------------------|-----------------------|------------------------|
| **Precision**    | Low (edge burst)      | High (exact count)    | High (smooth rate)     |
| **Memory**       | O(1) per identifier   | O(n) per identifier   | O(1) per identifier    |
| **Atomicity**    | INCR is atomic        | Requires Lua script   | Requires Lua script    |
| **Burst control**| Poor at boundaries    | Excellent             | Controlled bursting    |
| **Complexity**   | Simplest              | Moderate              | Moderate               |
| **Best for**     | Simple/internal APIs  | Strict enforcement    | Public APIs            |
| **Redis type**   | String (counter)      | Sorted Set            | Hash                   |

---

## Testing the Rate Limiter

### Trigger the sliding window limit (10 req/min)

```bash
for i in $(seq 1 15); do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/data
  echo
done
```

Expected output:
```
Request 1: 200
Request 2: 200
...
Request 10: 200
Request 11: 429   ← blocked!
Request 12: 429
...
```

### Inspect rate-limit headers

```bash
curl -v http://localhost:3000/api/data 2>&1 | grep -i 'x-ratelimit\|retry-after'
```

```
< X-RateLimit-Limit: 10
< X-RateLimit-Remaining: 9
< X-RateLimit-Reset: 1700000100
```

### Check the analytics dashboard

```bash
curl -s http://localhost:3000/dashboard | jq .
```

```json
{
  "summary": {
    "totalRequests": 15,
    "totalBlocked": 5,
    "uniqueBlockedIdentifiers": 1
  },
  "perAlgorithm": {
    "fixed": 0,
    "sliding": 15,
    "token": 0
  },
  "topBlockedIdentifiers": [
    {
      "identifier": "::1",
      "lastBlockedAt": "2025-11-15T00:00:00.000Z"
    }
  ]
}
```

### Watch Redis commands in real time

```bash
redis-cli monitor
```

### Inspect a specific key

```bash
# Check the TTL of a fixed-window key
redis-cli TTL ratelimit:fixed:127.0.0.1:1700000000

# See all members in a sliding-window sorted set
redis-cli ZRANGE ratelimit:sliding:127.0.0.1 0 -1 WITHSCORES

# Read token bucket state
redis-cli HGETALL ratelimit:bucket:127.0.0.1
```

---

## Key Redis Concepts Covered

| Concept                        | Where Used                    | File                           |
|--------------------------------|-------------------------------|--------------------------------|
| `INCR` / `EXPIRE`             | Atomic counter + auto-delete  | `src/limiters/fixedWindow.js`  |
| `TTL`                          | Expose reset time in headers  | `src/limiters/fixedWindow.js`  |
| Sorted Set (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`) | Time-series log | `src/scripts/slidingWindow.lua` |
| Hash (`HMGET`, `HSET`)        | Structured state storage      | `src/scripts/tokenBucket.lua`  |
| Lua scripting (`EVAL`/`EVALSHA`) | Atomic multi-command ops    | `src/scripts/*.lua`            |
| `defineCommand` (ioredis)      | Script caching via SHA        | `src/redis/client.js`          |
| Pipeline (`client.pipeline()`) | Batch reads, 1 round-trip     | `src/dashboard/analytics.js`   |
| `HINCRBY`                      | Atomic counter in a Hash      | `src/dashboard/analytics.js`   |
| `ZREVRANGE WITHSCORES`         | Top-N leaderboard query       | `src/dashboard/analytics.js`   |
| `maxmemory-policy allkeys-lru` | Eviction strategy             | `redis.conf`                   |

---

## Project Structure

```
rate-limiter-gateway/
├── docker-compose.yml            # Redis 7 + Node.js app
├── Dockerfile                    # Node 20 Alpine image
├── redis.conf                    # Custom Redis config (maxmemory, eviction)
├── .env.example                  # Environment variables template
├── package.json
├── src/
│   ├── index.js                  # Express app entry point + routes
│   ├── redis/
│   │   └── client.js             # ioredis client + Lua script registration
│   ├── limiters/
│   │   ├── fixedWindow.js        # Algorithm 1: INCR + EXPIRE
│   │   ├── slidingWindowLog.js   # Algorithm 2: Sorted Set + Lua
│   │   └── tokenBucket.js        # Algorithm 3: Hash + Lua
│   ├── middleware/
│   │   └── rateLimiter.js        # Express middleware factory
│   ├── scripts/
│   │   ├── slidingWindow.lua     # Lua: atomic sliding window operations
│   │   └── tokenBucket.lua       # Lua: atomic token bucket operations
│   └── dashboard/
│       └── analytics.js          # Track hits/blocks + pipeline reads
└── README.md
```
