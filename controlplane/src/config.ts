export const config = {
  port: Number(process.env.PORT ?? 8080),
  apiBase: process.env.API_BASE ?? "http://api:3000",
  prometheusBase: process.env.PROMETHEUS_BASE ?? "http://prometheus:9090",
  jaegerUiBase: process.env.JAEGER_UI_BASE ?? "http://localhost:16686",
  composeProject: process.env.COMPOSE_PROJECT ?? "angel-streaming-demo",
  workerService: process.env.WORKER_SERVICE ?? "worker",
  minWorkers: Number(process.env.MIN_WORKERS ?? 1),
  maxWorkers: Number(process.env.MAX_WORKERS ?? 5),
  // Autoscaler thresholds (queue backlog).
  scaleUpBacklog: Number(process.env.SCALE_UP_BACKLOG ?? 2000),
  scaleDownBacklog: Number(process.env.SCALE_DOWN_BACKLOG ?? 200),
  // AI incident explainer via OpenRouter (OpenAI-compatible). Model is
  // overridable; verify the exact slug at https://openrouter.ai/models.
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterModel: process.env.OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite",
  openrouterBase: process.env.OPENROUTER_BASE ?? "https://openrouter.ai/api/v1",
};
