import type { Context, MiddlewareHandler } from "hono";

export interface RateLimiterOptions {
  windowMs?: number;
  /** Per-method request budget inside the window; unlisted methods pass. */
  limits?: Record<string, number>;
}

const clientIp = (c: Context): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  c.req.header("x-real-ip") ??
  "unknown";

/**
 * In-memory sliding-window limiter. Prune-on-touch: expired timestamps are
 * dropped when a key is next seen, so the map stays bounded by active keys.
 */
export function rateLimiter({
  windowMs = 60_000,
  limits = { PUT: 30, POST: 60 },
}: RateLimiterOptions = {}): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  return async (c, next) => {
    if (process.env.RATE_LIMIT_DISABLED === "1") return next();
    // OPTIONS must never 429 — preflights gate every cross-origin request.
    if (c.req.method === "OPTIONS") return next();
    const limit = limits[c.req.method];
    if (limit == null) return next();
    const now = Date.now();
    const key = `${c.req.method}:${c.req.header("x-openjam-key") ?? clientIp(c)}`;
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      const retryAfter = Math.ceil(((arr[0] ?? now) + windowMs - now) / 1000);
      return c.json({ error: "rate_limited" }, 429, {
        "retry-after": String(retryAfter),
      });
    }
    arr.push(now);
    hits.set(key, arr);
    await next();
  };
}
