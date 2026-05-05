import type { Request, Response, NextFunction } from 'express';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Simple in-memory token bucket rate limiter.
 * Per-IP, per-endpoint.
 */
export function createRateLimiter(options: {
  /** Maximum tokens (burst size) */
  maxTokens: number;
  /** Tokens refilled per second */
  refillRate: number;
}) {
  const buckets = new Map<string, TokenBucket>();
  const { maxTokens, refillRate } = options;

  // Clean old entries periodically
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [key, bucket] of buckets) {
      if (bucket.lastRefill < cutoff) buckets.delete(key);
    }
  }, 60_000).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillRate);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests', retryAfter });
      return;
    }

    bucket.tokens -= 1;
    next();
  };
}
