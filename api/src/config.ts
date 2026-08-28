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
  workerPrefetch: Number(process.env.WORKER_PREFETCH ?? 50),
  otelEnabled: (process.env.OTEL_ENABLED ?? "false") === "true",
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
  engagementQueue: "engagement",
};
