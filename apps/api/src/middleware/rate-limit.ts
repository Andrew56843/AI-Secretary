import type { Request, RequestHandler } from "express";
import { env } from "../config.js";

type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const stores = new Map<string, Map<string, RateLimitEntry>>();

function defaultKey(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const store = new Map<string, RateLimitEntry>();
  stores.set(options.name, store);

  return (req, res, next) => {
    if (!env.RATE_LIMIT_ENABLED) {
      next();
      return;
    }

    const now = Date.now();
    const key = (options.key ?? defaultKey)(req);
    const existing = store.get(key);
    const entry = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : existing;

    entry.count += 1;
    store.set(key, entry);

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - entry.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ message: "Too many requests. Try again later." });
      return;
    }

    next();
  };
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const store of stores.values()) {
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }
}, 60_000);

cleanupTimer.unref();
