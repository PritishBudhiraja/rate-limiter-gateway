# Contributing

This is a learning project — contributions that add new Redis patterns or improve explanations are welcome!

## Setup

```bash
git clone https://github.com/PritishBudhiraja/rate-limiter-gateway.git
cd rate-limiter-gateway
cp .env.example .env
docker-compose up --build
```

## Guidelines

1. **Every Redis command must have a `REDIS LEARNING NOTE` comment** explaining what it does, why it's used, and what it returns.
2. Keep Lua scripts in `src/scripts/` with inline comments on every `redis.call()`.
3. Update the README algorithm comparison table if adding a new limiter.
4. Test your changes by hitting the endpoints with curl and watching `redis-cli monitor`.

## Adding a new algorithm

1. Create `src/limiters/yourAlgorithm.js` exporting a check function.
2. If it needs Lua, add the script to `src/scripts/` and register it in `src/redis/client.js`.
3. Wire it into `src/middleware/rateLimiter.js` as a new `algorithm` option.
4. Add a test route in `src/index.js`.
5. Document it in the README with an ASCII diagram.
