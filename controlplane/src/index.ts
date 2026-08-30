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
  poolSize,
  isDockerAvailable,
} from "./docker";
import { setAutoscaler, autoscalerEnabled } from "./autoscaler";
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

const PRESETS: Record<string, { rps: number; mode: "mixed" | "events" }> = {
  normal: { rps: 800, mode: "mixed" },
  spike: { rps: 2000, mode: "mixed" },
  // Event storm outruns a single worker (~800/s), so the queue builds and the
  // autoscaler scales up to ~4 workers (with headroom) to drain it.
  storm: { rps: 2500, mode: "events" },
};

async function main() {
  await initPool();

  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
  });

  app.get("/api/status", async () => {
    const [snap, workers, size] = await Promise.all([
      metricsSnapshot(),
      activeWorkers(),
      poolSize(),
    ]);
    return {
      load: loadState(),
      metrics: snap,
      workers,
      poolSize: size,
      minWorkers: config.minWorkers,
      maxWorkers: config.maxWorkers,
      autoscaler: autoscalerEnabled(),
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
