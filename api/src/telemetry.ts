import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status"],
  // buckets tuned for a low-latency read API (1ms .. 2s)
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: "cache_events_total",
  help: "Cache lookups by result",
  labelNames: ["cache", "result"], // result = hit | miss
  registers: [registry],
});

export const eventsPublished = new client.Counter({
  name: "engagement_events_published_total",
  help: "Engagement events published to the queue",
  labelNames: ["type"],
  registers: [registry],
});

export const eventsProcessed = new client.Counter({
  name: "engagement_events_processed_total",
  help: "Engagement events consumed by the worker",
  labelNames: ["type"],
  registers: [registry],
});

export function recordCache(cache: string, hit: boolean) {
  cacheEvents.labels(cache, hit ? "hit" : "miss").inc();
}
