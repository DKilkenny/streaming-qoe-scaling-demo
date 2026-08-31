export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Points at the nginx LB (see lb/nginx.conf), which round-robins across
  // whatever api replicas Docker DNS currently returns for the "api" alias.
  apiBase: process.env.API_BASE ?? "http://lb",
  prometheusBase: process.env.PROMETHEUS_BASE ?? "http://prometheus:9090",
  jaegerUiBase: process.env.JAEGER_UI_BASE ?? "http://localhost:16686",
  composeProject: process.env.COMPOSE_PROJECT ?? "angel-streaming-demo",
  workerService: process.env.WORKER_SERVICE ?? "worker",
  minWorkers: Number(process.env.MIN_WORKERS ?? 1),
  maxWorkers: Number(process.env.MAX_WORKERS ?? 5),
  // API-tier pool bounds (read path, behind the LB).
  minApi: Number(process.env.MIN_API ?? 1),
  maxApi: Number(process.env.MAX_API ?? 4),
  // Autoscaler thresholds (queue backlog).
  scaleUpBacklog: Number(process.env.SCALE_UP_BACKLOG ?? 2000),
  scaleDownBacklog: Number(process.env.SCALE_DOWN_BACKLOG ?? 200),
  // Don't shed workers while a surge is still incoming. Only scale down once the
  // beacon publish rate has dropped below this, so the worker count holds flat
  // during sustained load instead of flapping when the queue momentarily drains.
  scaleDownPublishRate: Number(process.env.SCALE_DOWN_PUBLISH_RATE ?? 500),
  // Cold-start window used to classify a worker as "warming" vs "active".
  workerColdStartMs: Number(process.env.WORKER_COLDSTART_MS ?? 12000),
  // Measured steady-state per-worker beacon throughput, for the utilization signal.
  workerCapacity: Number(process.env.WORKER_CAPACITY ?? 550),
  // API-tier autoscaler thresholds (read signal: VST, distinct from the
  // worker autoscaler's backlog signal). vstScaleUpMs sits well above the
  // ~45ms transient VST spike observed from episodePremiere's viewer-session
  // dispatch (which fires each 100ms tick's requests synchronously, briefly
  // inflating P95 even when the api tier isn't really saturated) and orders
  // of magnitude below a genuine playbackSurge herd's VST (peaks ~1900ms on
  // 1 instance) — confirmed while verifying the two autoscalers' separation.
  vstScaleUpMs: Number(process.env.VST_SCALE_UP_MS ?? 80),
  vstScaleDownMs: Number(process.env.VST_SCALE_DOWN_MS ?? 20),
  // Don't shed api instances while the herd is still incoming, even if VST
  // momentarily dips — only scale down once playback-start RPS has also
  // dropped below this. Mirrors scaleDownPublishRate's role for the worker
  // scaler, gated on the read-path's own signal instead of beacon publishes.
  scaleDownReadRps: Number(process.env.SCALE_DOWN_READ_RPS ?? 100),
  // AI incident explainer via OpenRouter (OpenAI-compatible). Model is
  // overridable; verify the exact slug at https://openrouter.ai/models.
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterModel: process.env.OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite",
  openrouterBase: process.env.OPENROUTER_BASE ?? "https://openrouter.ai/api/v1",
};
