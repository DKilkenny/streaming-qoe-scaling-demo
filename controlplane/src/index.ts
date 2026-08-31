import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import client from "prom-client";
import { config } from "./config";
import { startLoad, stopLoad, loadState } from "./load";
import { metricsSnapshot, readRps } from "./metrics";
import {
  initPool,
  setDesiredWorkers,
  setDesiredApiInstances,
  injectOutage,
  activeWorkers,
  workersWarming,
  activeApiInstances,
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
import { setApiAutoscaler, apiAutoscalerEnabled } from "./apiscaler";
import { explainIncident } from "./explain";
import { logEvent, recentEvents } from "./state";
import "./autoscaler"; // start the worker control loop
import "./apiscaler"; // start the api (read-tier) control loop

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

const PRESETS: Record<string, { rps: number; mode: "mixed" | "events" | "premiere" | "surge" | "combined" }> = {
  eveningPeak: { rps: 800, mode: "mixed" },
  trailerDrop: { rps: 1500, mode: "mixed" },
  // Episode premiere: a synchronized surge of viewers opening sessions on one
  // title. Outruns a single worker's beacon-processing capacity, so the queue
  // builds and the autoscaler scales up to drain it — while VST stays flat.
  // 700 sessions/s * ~3 beacons/session ~= 2100 beacons/s: builds a backlog at
  // 1 worker (~580/s) but drains with headroom once the pool reaches max
  // (~2900/s), all while staying visibly the most intense preset.
  episodePremiere: { rps: 700, mode: "premiere" },
  // Read-path thundering herd: a synchronized surge of playback-STARTS (not
  // beacons) on the premiere title. One API instance's simulated entitlement
  // concurrency cap saturates around ~2000/s (PLAYBACK_MAX_INFLIGHT=20 /
  // PLAYBACK_COST_MS=10ms), so 4000 rps overwhelms 1 instance (VST climbs
  // hard) and forces scale-out of the api pool to hold VST down.
  playbackSurge: { rps: 4000, mode: "surge" },
  // Combined premiere: one load scales BOTH tiers at once — the same
  // ~4000/s playback-start herd as playbackSurge (read tier: 1 -> 4 api
  // instances on VST), plus a beacon stream fixed at ~2000/s regardless of
  // rps (write tier: 1 -> 5 workers on backlog) — see load.ts
  // COMBINED_BEACON_SPAWNS_PER_TICK for why that rate is decoupled from
  // rps rather than derived from it. Two independent autoscalers, one
  // premiere event.
  premiereFull: { rps: 4000, mode: "combined" },
};

async function main() {
  await initPool();

  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
  });

  app.get("/api/status", async () => {
    const [snap, workers, warming, size, apiInstances, rps] = await Promise.all([
      metricsSnapshot(),
      activeWorkers(),
      workersWarming(),
      poolSize(),
      activeApiInstances(),
      readRps(),
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
      // Read tier (api pool): separate from the worker pool above.
      apiInstances,
      minApi: config.minApi,
      maxApi: config.maxApi,
      apiAutoscaler: apiAutoscalerEnabled(),
      readRps: rps,
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

  app.post<{ Body: { instances?: number } }>("/api/apiscale", async (req, reply) => {
    const raw = Number(req.body?.instances);
    if (!Number.isFinite(raw)) {
      reply.code(400);
      return { error: "instances must be a finite number" };
    }
    // Manual scaling is an override: turn the api-autoscaler off so it
    // doesn't immediately undo the operator's choice.
    if (apiAutoscalerEnabled()) setApiAutoscaler(false);
    const desired = Math.min(config.maxApi, Math.max(config.minApi, Math.floor(raw)));
    const active = await setDesiredApiInstances(desired);
    logEvent("apiscale", `manual scale -> ${active} api instances (api-autoscaler off)`);
    return { active };
  });

  app.post<{ Body: { enabled?: boolean } }>("/api/apiscaler", async (req) => {
    setApiAutoscaler(Boolean(req.body?.enabled));
    return { enabled: apiAutoscalerEnabled() };
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
