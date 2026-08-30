import { config } from "./config";
import { metricsSnapshot } from "./metrics";
import { activeWorkers, setDesiredWorkers } from "./docker";
import { logEvent } from "./state";

let enabled = false;
let lastScale = 0;
const COOLDOWN_MS = 3_000; // avoid flapping

export function setAutoscaler(on: boolean) {
  enabled = on;
  logEvent("autoscaler", on ? "enabled" : "disabled");
}

export function autoscalerEnabled() {
  return enabled;
}

// Closed loop: watch the engagement backlog and add/remove worker capacity.
async function tick() {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastScale < COOLDOWN_MS) return;

  const snap = await metricsSnapshot();
  const active = await activeWorkers();
  if (snap.backlog == null || active < 0) return;

  if (snap.backlog > config.scaleUpBacklog && active < config.maxWorkers) {
    // Scale up proportionally to the backlog so a big spike recovers decisively
    // instead of crawling up one worker at a time.
    const jump = Math.max(1, Math.ceil(snap.backlog / 5000));
    const next = await setDesiredWorkers(active + jump);
    lastScale = now;
    logEvent(
      "scale-up",
      `backlog ${snap.backlog} > ${config.scaleUpBacklog}, workers ${active} -> ${next}`
    );
  } else if (snap.backlog < config.scaleDownBacklog && active > config.minWorkers) {
    const next = await setDesiredWorkers(active - 1);
    lastScale = now;
    logEvent(
      "scale-down",
      `backlog ${snap.backlog} < ${config.scaleDownBacklog}, workers ${active} -> ${next}`
    );
  }
}

setInterval(() => {
  void tick().catch(() => {});
}, 2_000);
