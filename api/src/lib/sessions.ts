import { redis } from "./redis";

const KEY = "active_sessions";
const WINDOW_MS = 30_000; // a session is "live" if it beaconed in the last 30s

// Mark a session live (playback start, or any play/progress/rebuffer beacon).
export async function touchSession(sessionId: string): Promise<void> {
  try {
    await redis.zadd(KEY, Date.now(), sessionId);
  } catch {
    /* concurrency tracking is best-effort, never a correctness dependency */
  }
}

// Remove a session (complete or error beacon).
export async function endSession(sessionId: string): Promise<void> {
  try {
    await redis.zrem(KEY, sessionId);
  } catch {
    /* best-effort */
  }
}

// Prune stale entries and return the count of sessions still live.
export async function liveStreamCount(): Promise<number> {
  try {
    const cutoff = Date.now() - WINDOW_MS;
    await redis.zremrangebyscore(KEY, "-inf", `(${cutoff}`);
    return await redis.zcard(KEY);
  } catch {
    return 0;
  }
}
