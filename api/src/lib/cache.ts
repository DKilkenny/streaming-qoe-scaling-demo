import { redis } from "./redis";
import { recordCache } from "../telemetry";
import { config } from "../config";

/**
 * Cache-first read. Checks Redis, records hit/miss for the dashboard, and on a
 * miss runs the loader and backfills the cache. A Redis outage degrades to a
 * straight Postgres read rather than an error — the cache is an optimization,
 * never a dependency of correctness.
 */
export async function getOrSet<T>(
  cacheName: string,
  key: string,
  loader: () => Promise<T>,
  ttlSeconds = config.cacheTtlSeconds
): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      recordCache(cacheName, true);
      return JSON.parse(cached) as T;
    }
    recordCache(cacheName, false);
  } catch {
    recordCache(cacheName, false);
  }

  const value = await loader();

  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* cache write best-effort */
  }
  return value;
}
