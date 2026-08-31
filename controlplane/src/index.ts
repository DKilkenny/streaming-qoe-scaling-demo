import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import client from "prom-client";
import { config } from "./config";
import { startLoad, stopLoad, loadState } from "./load";
import { metricsSnapshot } from "./metrics";
import {
  initPool,
  setDesiredWorkers,
  injectOutage,
  activeWorkers,
  workersWarming,
  poolSize,
  isDockerAvailable,
} from "./docker";
import {
  setAutoscaler,
  autoscalerEnabled,
  setStrategy,
  getStrategy,
  setPrewarm,
  getPrewarm,
} from "./autoscaler";
import { explainIncident } from "./explain";
import { logEvent, recentEvents } from "./state";
import "./autoscaler"; // start the control loop

// Expose active worker count to Prometheus so the dashboard can chart it.
const registry = new client.Registry();
const activeWorkersGauge = new client.Gauge({
  name: "active_workers",
  help: "Worker containers currently active (running, not paused)",
  registers: [registry],
});
setInterval(async () => {
  const n = await activeWorkers();
  if (n >= 0) activeWorkersGauge.set(n);
}, 3_000);

const PRESETS: Record<string, { rps: number; mode: "mixed" | "events" | "premiere" }> = {
  eveningPeak: { rps: 800, mode: "mixed" },
  trailerDrop: { rps: 1500, mode: "mixed" },
  // Episode premiere: a synchronized surge of viewers opening sessions on one
  // title. Outruns a single worker's beacon-processing capacity, so the queue
  // builds and the autoscaler scales up to drain it — while VST stays flat.
  // 700 sessions/s * ~3 beacons/session ~= 2100 beacons/s: builds a backlog at
  // 1 worker (~580/s) but drains with headroom once the pool reaches max
  // (~2900/s), all while staying visibly the most intense preset.
  episodePremiere: { rps: 700, mode: "premiere" },
};

async function main() {
  await initPool();

  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
  });

  app.get("/api/status", async () => {
    const [snap, workers, warming, size] = await Promise.all([
      metricsSnapshot(),
      activeWorkers(),
      workersWarming(),
      poolSize(),
    ]);
    // Docker unavailable (-1): don't fabricate a utilization number, and
    // display warming as "n/a" (0) rather than a negative count.
    const utilization =
      workers < 0
        ? null
        : Math.round((100 * (snap.eventsPublished ?? 0)) / Math.max(1, workers * config.workerCapacity));
    return {
      load: loadState(),
      metrics: snap,
      workers,
      workersWarming: warming < 0 ? 0 : warming,
      poolSize: size,
      minWorkers: config.minWorkers,
      maxWorkers: config.maxWorkers,
      autoscaler: autoscalerEnabled(),
      strategy: getStrategy(),
      prewarm: getPrewarm(),
      utilization,
      dockerAvailable: isDockerAvailable(),
      jaegerUrl: config.jaegerUiBase,
      events: recentEvents(15),
    };
  });

  app.post<{ Body: { rps?: number; mode?: "mixed" | "events" } }>(
    "/api/load",
    async (req) => {
      const rps = Number(req.body?.rps ?? 0);
      const mode = req.body?.mode ?? "mixed";
      if (rps > 0) {
        await startLoad(rps, mode);
        logEvent("load", `set to ${rps} rps (${mode})`);
      } else {
        stopLoad();
        logEvent("load", "stopped");
      }
      return loadState();
    }
  );

  app.post<{ Body: { name?: string } }>("/api/preset", async (req) => {
    const name = req.body?.name ?? "";
    if (name === "stop") {
      stopLoad();
      logEvent("load", "stopped");
      return loadState();
    }
    const p = PRESETS[name];
    if (!p) return { error: "unknown preset" };
    await startLoad(p.rps, p.mode);
    logEvent("load", `preset '${name}' -> ${p.rps} rps (${p.mode})`);
    return loadState();
  });

  app.post("/api/chaos/worker-outage", async () => {
    await injectOutage();
    logEvent("chaos", "worker outage injected (all workers stopped)");
    return { ok: true };
  });

  app.post<{ Body: { workers?: number } }>("/api/scale", async (req) => {
    // Manual scaling is an override: turn the autoscaler off so it doesn't
    // immediately undo the operator's choice.
    if (autoscalerEnabled()) setAutoscaler(false);
    const desired = Number(req.body?.workers ?? config.minWorkers);
    const active = await setDesiredWorkers(desired);
    logEvent("scale", `manual scale -> ${active} workers (autoscaler off)`);
    return { active };
  });

  app.post<{ Body: { enabled?: boolean } }>("/api/autoscaler", async (req) => {
    setAutoscaler(Boolean(req.body?.enabled));
    return { enabled: autoscalerEnabled() };
  });

  app.post<{ Body: { strategy?: string } }>("/api/strategy", async (req, reply) => {
    const s = req.body?.strategy;
    if (s !== "reactive" && s !== "proactive") {
      reply.code(400);
      return { error: "strategy must be 'reactive' or 'proactive'" };
    }
    setStrategy(s);
    return { strategy: getStrategy() };
  });

  app.post<{ Body: { workers?: number } }>("/api/prewarm", async (req, reply) => {
    const raw = Number(req.body?.workers ?? 0);
    if (!Number.isFinite(raw)) {
      reply.code(400);
      return { error: "workers must be a finite number" };
    }
    // setPrewarm clamps to [0, maxWorkers]; the response reflects the
    // clamped value, not the raw request.
    setPrewarm(raw);
    return { prewarm: getPrewarm() };
  });

  app.post("/api/explain", async () => explainIncident());

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`[controlplane] Load Console on :${config.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
