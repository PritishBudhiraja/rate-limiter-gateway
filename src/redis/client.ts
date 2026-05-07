import fs from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import type { RedisWithLua } from '../types';

// REDIS LEARNING NOTE: ioredis is a robust, feature-rich Redis client for
// Node.js. It supports Cluster, Sentinel, pipelining, Lua scripting, and
// Pub/Sub out of the box. We use it instead of the basic "redis" package
// because defineCommand() lets us register Lua scripts as first-class methods.

const client: RedisWithLua = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),

  // REDIS LEARNING NOTE: maxRetriesPerRequest = null tells ioredis to keep
  // retrying failed commands indefinitely rather than rejecting promises
  // after 20 attempts (the default). This prevents the app from crashing
  // during transient Redis restarts.
  maxRetriesPerRequest: null,

  // REDIS LEARNING NOTE: enableReadyCheck makes ioredis wait until Redis
  // replies to a background INFO command confirming the server is ready to
  // accept commands (e.g. after an AOF/RDB load). Without this, early
  // commands could fail with LOADING errors.
  enableReadyCheck: true,
}) as RedisWithLua;

// ─── Connection event listeners ─────────────────────────────────────────

// REDIS LEARNING NOTE: 'connect' fires when the TCP socket to Redis is
// established, but the client may not be ready to accept commands yet
// (e.g. if AUTH or SELECT is pending).
client.on('connect', () => {
  console.log('[Redis] TCP connection established');
});

// REDIS LEARNING NOTE: 'ready' fires after the connection is established
// AND any AUTH / SELECT / enableReadyCheck handshake has completed. This
// is the safe point to start issuing commands.
client.on('ready', () => {
  console.log('[Redis] Client ready — accepting commands');
});

// REDIS LEARNING NOTE: 'error' fires on any connection or command-level
// error. ioredis will automatically attempt to reconnect, but we log the
// error for visibility.
client.on('error', (err: Error) => {
  console.error('[Redis] Connection error:', err.message);
});

// REDIS LEARNING NOTE: 'close' fires when the connection is fully closed,
// either by calling client.disconnect() or after all reconnect retries
// are exhausted.
client.on('close', () => {
  console.log('[Redis] Connection closed');
});

// ─── Register Lua scripts as custom commands ────────────────────────────

// REDIS LEARNING NOTE: redis.defineCommand() takes a Lua script and
// registers it on the client so you can call it like a native method
// (e.g. client.slidingwindow(...)). Under the hood, ioredis:
//   1. Computes the SHA1 hash of the script.
//   2. First tries EVALSHA <sha> (executes cached script by hash).
//   3. If Redis replies NOSCRIPT, falls back to EVAL <full script>.
// This means the full script text is only sent over the network once;
// subsequent calls use the compact SHA — saving bandwidth.

const slidingWindowLua: string = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'slidingWindow.lua'),
  'utf8',
);

client.defineCommand('slidingwindow', {
  numberOfKeys: 1,
  lua: slidingWindowLua,
});

const tokenBucketLua: string = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'tokenBucket.lua'),
  'utf8',
);

client.defineCommand('tokenbucket', {
  numberOfKeys: 1,
  lua: tokenBucketLua,
});

export default client;
