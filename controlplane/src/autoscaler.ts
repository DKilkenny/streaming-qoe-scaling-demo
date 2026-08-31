import { config } from "./config";
import { metricsSnapshot } from "./metrics";
import { activeWorkers, setDesiredWorkers } from "./docker";
import { logEvent } from "./state";

let enabled = false;
let lastScale = 0;
const COOLDOWN_MS = 3_000; // avoid flapping

// "proactive" scales on utilization before the backlog builds; "reactive"
// waits for the backlog threshold like the original loop. Default to
// proactive since that's the point of this control plane.
let strategy: "reactive" | "proactive" = "proactive";
// Operator-declared pre-warm floor: provision this many workers ahead of a
// known surge instead of waiting for load to trigger a cold start.
let prewarm = 0;

export function setStrategy(s: "reactive" | "proactive") {
  strategy = s;
  logEvent("strategy", `set to ${s}`);
}

export function getStrategy() {
  return strategy;
}

export function setPrewarm(n: number) {
  // Clamp to [0, maxWorkers] and fall back to 0 on non-finite input (NaN,
  // Infinity). An unclamped prewarm above maxWorkers would push `floor`
  // above the reachable `active` count forever, wedging tick()'s pre-warm
  // branch and permanently short-circuiting scale-up AND scale-down.
  prewarm = Number.isFinite(n) ? Math.min(config.maxWorkers, Math.max(0, Math.floor(n))) : 0;
  logEvent(
    "prewarm",
    prewarm > 0 ? `pre-warmed to ${prewarm} workers ahead of a surge` : "pre-warm cleared"
  );
}

export function getPrewarm() {
  return prewarm;
}

export function setAutoscaler(on: boolean) {
  enabled = on;
  logEvent("autoscaler", on ? "enabled" : "disabled");
}

export function autoscalerEnabled() {
  return enabled;
}

// Closed loop: watch utilization and the engagement backlog and add/remove
// worker capacity.
async function tick() {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastScale < COOLDOWN_MS) return;

  const snap = await metricsSnapshot();
  const active = await activeWorkers();
  if (snap.backlog == null || active < 0) return;

  // Effective floor: the pre-warm floor overrides minWorkers when it's higher,
  // so an operator-declared surge holds capacity through scale-down too.
  const floor = Math.max(config.minWorkers, prewarm);
  const capacity = Math.max(1, active) * config.workerCapacity;
  const utilization = (snap.eventsPublished ?? 0) / capacity;
  const warmSecs = Math.round(config.workerColdStartMs / 1000);

  if (active < floor) {
    // Pre-warm floor: provision ahead of the surge before any
    // reactive/proactive logic runs.
    const next = await setDesiredWorkers(floor);
    lastScale = now;
    logEvent(
      "scale-up",
      `pre-warm floor ${floor}, workers ${active} -> ${next} (warming ~${warmSecs}s)`
    );
    return;
  }

  if (strategy === "proactive" && utilization > 0.75 && active < config.maxWorkers) {
    // Scale on utilization BEFORE the backlog builds. Jump proportionally to
    // how far over the threshold we are, mirroring the backlog jump below.
    const jump = Math.max(1, Math.ceil((utilization - 0.75) / 0.25));
    const next = await setDesiredWorkers(active + jump);
    lastScale = now;
    logEvent(
      "scale-up (proactive)",
      `utilization ${Math.round(utilization * 100)}% > 75%, provisioning worker (warming ~${warmSecs}s), workers ${active} -> ${next}`
    );
  } else if (snap.backlog > config.scaleUpBacklog && active < config.maxWorkers) {
    // Reactive scale-up: the reactive strategy's only scale-up path, and a
    // safety net under proactive in case backlog builds despite utilization
    // looking fine (e.g. a burst faster than the utilization average tracks).
    const jump = Math.max(1, Math.ceil(snap.backlog / 5000));
    const next = await setDesiredWorkers(active + jump);
    lastScale = now;
    logEvent(
      strategy === "proactive" ? "scale-up (backlog safety net)" : "scale-up (reactive)",
      `backlog ${snap.backlog} > ${config.scaleUpBacklog}, workers ${active} -> ${next}`
    );
  } else if (
    snap.backlog < config.scaleDownBacklog &&
    (snap.eventsPublished ?? 0) < config.scaleDownPublishRate &&
    active > floor
  ) {
    // Backlog is low AND the surge has subsided (publish rate dropped): safe
    // to shed a worker, but never below the pre-warm floor. Under sustained
    // load the publish-rate gate keeps us from flapping — a near-empty queue
    // at high publish rate is equilibrium, not idle.
    const next = await setDesiredWorkers(active - 1);
    lastScale = now;
    logEvent(
      "scale-down",
      `backlog ${snap.backlog} < ${config.scaleDownBacklog} & publish ${snap.eventsPublished ?? 0}/s < ${config.scaleDownPublishRate}, workers ${active} -> ${next}`
    );
  }
}

setInterval(() => {
  void tick().catch(() => {});
}, 2_000);
