export const config = {
  role: process.env.ROLE ?? "api",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://streaming:streaming@localhost:5432/streaming",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  rabbitUrl:
    process.env.RABBITMQ_URL ?? "amqp://streaming:streaming@localhost:5672",
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 30),
  workerPrefetch: Number(process.env.WORKER_PREFETCH ?? 4),
  // Simulated per-event downstream work (enrichment, multi-aggregate updates,
  // etc.). Bounds per-worker throughput so event capacity scales with the number
  // of workers — which is what makes the autoscaler's job real under load.
  workerEventMs: Number(process.env.WORKER_EVENT_MS ?? 4),
  otelEnabled: (process.env.OTEL_ENABLED ?? "false") === "true",
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
  qoeQueue: "qoe",
  // Simulated provisioning/init time: a newly started worker waits this long
  // before opening its consumer, modeling an ECS/Fargate task cold start.
  workerColdStartMs: Number(process.env.WORKER_COLDSTART_MS ?? 0),
};
