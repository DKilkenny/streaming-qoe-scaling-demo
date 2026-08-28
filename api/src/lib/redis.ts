import Redis from "ioredis";
import { config } from "../config";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 2,
  lazyConnect: false,
  enableReadyCheck: true,
});

redis.on("error", (err) => {
  // Cache must never take the request path down. Log and fall through to Postgres.
  // eslint-disable-next-line no-console
  console.error("[redis] error:", err.message);
});
