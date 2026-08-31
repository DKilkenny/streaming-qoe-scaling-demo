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

export const beaconsPublished = new client.Counter({
  name: "qoe_beacons_published_total",
  help: "QoE beacons published to the queue",
  labelNames: ["type"],
  registers: [registry],
});

export const beaconsProcessed = new client.Counter({
  name: "qoe_beacons_processed_total",
  help: "QoE beacons consumed by the worker",
  labelNames: ["type"],
  registers: [registry],
});

// Global gauge of live playback sessions. Every API replica reads the same
// Redis sorted set and reports the same value, so query it with max(), not sum().
export const concurrentStreams = new client.Gauge({
  name: "concurrent_streams",
  help: "Playback sessions with a heartbeat in the last 30s",
  registers: [registry],
});

export function setConcurrentStreams(n: number): void {
  concurrentStreams.set(n);
}

export function recordCache(cache: string, hit: boolean) {
  cacheEvents.labels(cache, hit ? "hit" : "miss").inc();
}
