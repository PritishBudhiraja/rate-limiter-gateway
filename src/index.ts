/**
 * Rate Limiter API Gateway -- Express Entry Point
 *
 * This server demonstrates three Redis-based rate limiting algorithms:
 *   1. Fixed Window   (INCR + EXPIRE)
 *   2. Sliding Window (Sorted Set + Lua)
 *   3. Token Bucket   (Hash + Lua)
 *
 * Each route uses a different algorithm so you can compare their behavior.
 * Read every "REDIS LEARNING NOTE" comment in the source to understand
 * what each Redis command does and why.
 */

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { dashboardHandler } from './dashboard/analytics';
import { rateLimiter } from './middleware/rateLimiter';
import redisClient from './redis/client';
import type { AuthenticatedRequest } from './types';

const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);

// REDIS LEARNING NOTE: trust proxy tells Express to respect the
// X-Forwarded-For header set by reverse proxies (like nginx or Docker's
// network layer). Without this, req.ip would always be the proxy's IP
// instead of the real client IP -- which would make per-IP rate limiting
// useless since ALL clients would share one limit.
app.set('trust proxy', true);

// ═══════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════

// ── GET /public -- No rate limit ─────────────────────────────────────
// A baseline route to compare against rate-limited routes.
app.get('/public', (_req: Request, res: Response) => {
  res.json({
    message: 'This is a public endpoint -- no rate limiting applied.',
    tip: 'Compare the response headers here vs /api/data to see rate limit headers.',
  });
});

// ── GET /api/data -- Sliding Window, 10 req/min per IP ───────────────
// Uses the most precise algorithm. Try hitting this >10 times in a
// minute to see the 429 response.
app.get(
  '/api/data',
  rateLimiter(redisClient, {
    algorithm: 'sliding',
    keyBy: 'ip',
    maxRequests: 10,
    windowSeconds: 60,
  }),
  (_req: Request, res: Response) => {
    res.json({
      message: 'Here is your data!',
      algorithm: 'Sliding Window Log',
      note: 'This route allows 10 requests per minute per IP.',
    });
  },
);

// ── GET /api/user -- Fixed Window, 100 req/min per user ──────────────
// Demonstrates per-user limiting with a mock authentication middleware.

// Mock auth middleware -- in production this would verify a JWT or session.
function mockAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  req.user = { id: 'u1', name: 'Test User' };
  next();
}

app.get(
  '/api/user',
  mockAuth,
  rateLimiter(redisClient, {
    algorithm: 'fixed',
    keyBy: 'user',
    maxRequests: 100,
    windowSeconds: 60,
  }),
  (req: AuthenticatedRequest, res: Response) => {
    res.json({
      message: `Hello, ${req.user?.name}!`,
      algorithm: 'Fixed Window',
      note: 'This route allows 100 requests per minute per user.',
    });
  },
);

// ── GET /api/protected -- Stacked limits (per-IP burst + per-user) ───
// Demonstrates applying TWO rate limiters on the same route.
// The per-IP limiter catches short bursts (20 req/10s).
// The per-user limiter enforces a sustained limit (100 req/min).
// Whichever fires first returns 429.
app.get(
  '/api/protected',
  mockAuth,
  rateLimiter(redisClient, {
    algorithm: 'token',
    keyBy: 'ip',
    maxRequests: 20,
    windowSeconds: 10,
  }),
  rateLimiter(redisClient, {
    algorithm: 'fixed',
    keyBy: 'user',
    maxRequests: 100,
    windowSeconds: 60,
  }),
  (req: AuthenticatedRequest, res: Response) => {
    res.json({
      message: `Protected resource for ${req.user?.name}`,
      note: 'This route has TWO stacked rate limiters: per-IP burst (token bucket, 20/10s) and per-user sustained (fixed window, 100/min).',
    });
  },
);

// ── GET /dashboard -- Analytics ──────────────────────────────────────
// Returns total requests, total blocked, top 10 blocked IPs, and
// per-algorithm hit counts. All data is fetched in a single Redis
// pipeline for minimal latency.
app.get('/dashboard', dashboardHandler(redisClient));

// ── Error handling middleware ────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════════════════
// Start server
// ═══════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\nRate Limiter Gateway running on http://localhost:${PORT}`);
  console.log('\nAvailable routes:');
  console.log('  GET /public         -- No rate limit');
  console.log('  GET /api/data       -- Sliding window (10 req/min per IP)');
  console.log('  GET /api/user       -- Fixed window (100 req/min per user)');
  console.log('  GET /api/protected  -- Stacked: token bucket + fixed window');
  console.log('  GET /dashboard      -- Analytics dashboard\n');
});
