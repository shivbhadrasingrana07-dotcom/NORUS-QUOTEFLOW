import { sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import type { DrizzleDb } from '../src/db/index.ts';

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface RateLimitStore {
  consume(bucketKey: string, limit: number, windowMs: number): Promise<RateLimitCheckResult>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { hits: number; resetAtMs: number }>();
  private readonly maxBuckets: number;

  constructor(maxBuckets = 2000) {
    this.maxBuckets = Math.max(1, maxBuckets);
  }

  private pruneAndBound(now: number) {
    for (const [key, entry] of this.buckets.entries()) {
      if (entry.resetAtMs <= now) {
        this.buckets.delete(key);
      }
    }
    while (this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }

  getBucketCount(): number {
    return this.buckets.size;
  }

  async consume(bucketKey: string, limit: number, windowMs: number): Promise<RateLimitCheckResult> {
    const now = Date.now();
    const existing = this.buckets.get(bucketKey);
    if (!existing || existing.resetAtMs <= now) {
      if (existing) {
        this.buckets.delete(bucketKey);
      }
      if (this.buckets.size >= this.maxBuckets) {
        this.pruneAndBound(now);
      }
      const resetAtMs = now + windowMs;
      this.buckets.set(bucketKey, { hits: 1, resetAtMs });
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - 1),
        resetAt: new Date(resetAtMs),
      };
    }

    existing.hits += 1;
    // Refresh LRU order on active bucket
    this.buckets.delete(bucketKey);
    this.buckets.set(bucketKey, existing);
    const allowed = existing.hits <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - existing.hits),
      resetAt: new Date(existing.resetAtMs),
    };
  }
}

export class PostgresRateLimitStore implements RateLimitStore {
  private readonly db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  async consume(bucketKey: string, limit: number, windowMs: number): Promise<RateLimitCheckResult> {
    const nextReset = new Date(Date.now() + windowMs);
    const res = await this.db.execute(sql`
      INSERT INTO rate_limit_buckets (bucket_key, hits, reset_at)
      VALUES (${bucketKey}, 1, ${nextReset})
      ON CONFLICT (bucket_key) DO UPDATE SET
        hits = CASE
          WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
          ELSE rate_limit_buckets.hits + 1
        END,
        reset_at = CASE
          WHEN rate_limit_buckets.reset_at <= NOW() THEN ${nextReset}
          ELSE rate_limit_buckets.reset_at
        END
      RETURNING hits, reset_at
    `);

    const row = (res.rows[0] || {}) as { hits?: number | string; reset_at?: Date | string };
    const hits = Number(row.hits ?? 1);
    const resetAt = row.reset_at ? new Date(row.reset_at) : nextReset;

    return {
      allowed: hits <= limit,
      limit,
      remaining: Math.max(0, limit - hits),
      resetAt,
    };
  }
}

export function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function createRateLimitMiddleware(params: {
  store: RateLimitStore;
  namespace: string;
  limit: number;
  windowMs: number;
  keyFn?: (req: Request) => string;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = params.keyFn ? params.keyFn(req) : getClientIp(req);
      const bucketKey = `${params.namespace}:${identity}`.slice(0, 180);
      const result = await params.store.consume(bucketKey, params.limit, params.windowMs);

      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));

      if (!result.allowed) {
        const retrySec = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retrySec));
        return res.status(429).json({
          error: 'Rate limit exceeded. Please wait before retrying.',
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
