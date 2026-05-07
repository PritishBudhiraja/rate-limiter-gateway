import type { Request } from 'express';
import type { Redis } from 'ioredis';

// ─── Rate Limiter Types ─────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export type Algorithm = 'fixed' | 'sliding' | 'token';
export type KeyBy = 'ip' | 'user' | 'apikey';

export interface RateLimiterOptions {
  algorithm: Algorithm;
  keyBy: KeyBy;
  maxRequests: number;
  windowSeconds: number;
}

// ─── Extended Redis client with our custom Lua commands ─────────────

export interface RedisWithLua extends Redis {
  slidingwindow(
    key: string,
    now: number,
    windowMs: number,
    maxRequests: number,
    uniqueMember: string,
    expireSeconds: number,
  ): Promise<[number, number, number]>;

  tokenbucket(
    key: string,
    now: number,
    maxTokens: number,
    refillRate: number,
    expireSeconds: number,
  ): Promise<[number, number, number]>;
}

// ─── Express extensions ─────────────────────────────────────────────

export interface AuthenticatedUser {
  id: string;
  name: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

// ─── Analytics Types ────────────────────────────────────────────────

export interface BlockedEntry {
  identifier: string;
  lastBlockedAt: string;
}

export interface DashboardResponse {
  summary: {
    totalRequests: number;
    totalBlocked: number;
    uniqueBlockedIdentifiers: number;
  };
  perAlgorithm: {
    fixed: number;
    sliding: number;
    token: number;
  };
  topBlockedIdentifiers: BlockedEntry[];
}
