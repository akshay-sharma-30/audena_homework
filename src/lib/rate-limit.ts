// In-process token-bucket rate limiter.
//
// Per-key (typically per-API-token) bucket with a `capacity` (burst) and a
// `refillPerSec` rate. The bucket is filled lazily: on every check we add
// `(now - lastCheck) * refillPerSec` tokens up to capacity, then either
// consume 1 (allow) or report how long the caller should wait.
//
// In production this state lives in Redis (so it works across N Next.js
// instances). For the demo a single in-process map is correct — documented
// as a deferred trade-off.

type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

export type LimiterConfig = {
  capacity: number;       // max burst
  refillPerSec: number;   // sustained rate (tokens per second)
};

type Limiter = {
  config: LimiterConfig;
  buckets: Map<string, Bucket>;
};

const globalForLimiters = globalThis as unknown as {
  audenaLimiters?: Map<string, Limiter>;
};

function getRegistry(): Map<string, Limiter> {
  if (!globalForLimiters.audenaLimiters) {
    globalForLimiters.audenaLimiters = new Map();
  }
  return globalForLimiters.audenaLimiters;
}

/**
 * Get or create a named limiter. Each named limiter has its own per-key
 * map of buckets — so `getLimiter("POST /api/calls", ...)` and
 * `getLimiter("POST /api/webhooks", ...)` are independent.
 */
export function getLimiter(
  name: string,
  config: LimiterConfig
): Limiter {
  const registry = getRegistry();
  let l = registry.get(name);
  if (!l) {
    l = { config, buckets: new Map() };
    registry.set(name, l);
  }
  return l;
}

export type RateLimitResult =
  | { allowed: true; remaining: number; resetSec: number }
  | { allowed: false; retryAfterSec: number; resetSec: number };

/**
 * Attempt to consume 1 token from the bucket keyed by `key` in this
 * limiter. Returns whether the request is allowed plus the headers a
 * caller should set on the response.
 */
export function consume(limiter: Limiter, key: string): RateLimitResult {
  const { capacity, refillPerSec } = limiter.config;
  const now = Date.now();
  let b = limiter.buckets.get(key);
  if (!b) {
    b = { tokens: capacity, lastRefillMs: now };
    limiter.buckets.set(key, b);
  }

  // Lazy refill.
  const elapsedSec = Math.max(0, (now - b.lastRefillMs) / 1000);
  b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
  b.lastRefillMs = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(b.tokens),
      resetSec: Math.ceil((capacity - b.tokens) / refillPerSec),
    };
  }

  // Out of tokens — compute how long until we have 1 token available.
  const deficit = 1 - b.tokens;
  const retryAfterSec = Math.max(1, Math.ceil(deficit / refillPerSec));
  return {
    allowed: false,
    retryAfterSec,
    resetSec: Math.ceil((capacity - b.tokens) / refillPerSec),
  };
}

/**
 * Build the headers every response (allowed or denied) should include so
 * that well-behaved clients can pace themselves without trial-and-error.
 */
export function rateLimitHeaders(
  limiter: Limiter,
  result: RateLimitResult
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(limiter.config.capacity),
    "X-RateLimit-Reset": String(result.resetSec),
  };
  if (result.allowed) {
    headers["X-RateLimit-Remaining"] = String(result.remaining);
  } else {
    headers["X-RateLimit-Remaining"] = "0";
    headers["Retry-After"] = String(result.retryAfterSec);
  }
  return headers;
}

/**
 * Test-only: clear every bucket in every limiter. Tests share a process
 * with the running app via globalThis caching; without this they'd
 * accumulate state across runs and become flaky.
 */
export function __resetAllLimitersForTests(): void {
  const registry = getRegistry();
  for (const l of registry.values()) {
    l.buckets.clear();
  }
}
