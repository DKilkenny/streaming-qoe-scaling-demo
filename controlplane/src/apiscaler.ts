import { config } from "./config";
import { metricsSnapshot, readRps } from "./metrics";
import { activeApiInstances, setDesiredApiInstances } from "./docker";
import { logEvent } from "./state";

// Separate control loop from autoscaler.ts (worker pool, beacon-backlog
// signal). This one scales the API tier on the READ signal (VST) so the two
// autoscalers never compete for the same knob: a beacon-storm premiere
// drives the worker loop while reads stay light (api tier holds at min), and
// a playback-start thundering herd drives THIS loop while beacon volume
// stays light (worker pool holds at min).
let enabled = false;
let lastScale = 0;
const COOLDOWN_MS = 3_000; // avoid flapping
// Consecutive over-threshold ticks required before a scale-up acts (see
// below). Tracked independently of the scale cooldown so it keeps counting
// even while an action is on cooldown.
let highStreak = 0;
const HIGH_STREAK_REQUIRED = 2;
// Consecutive under-headroom ticks required before a scale-down acts, so a
// momentary dip in read RPS mid-herd doesn't shed an instance prematurely.
// Mirrors HIGH_STREAK_REQUIRED for the scale-up side.
let lowStreak = 0;
const LOW_STREAK_REQUIRED = 2;

export function setApiAutoscaler(on: boolean) {
  enabled = on;
  highStreak = 0;
  lowStreak = 0;
  logEvent("api-autoscaler", on ? "enabled" : "disabled");
}

export function apiAutoscalerEnabled() {
  return enabled;
}

// Serialize runs: a scale op's container create+start (plus the nginx upstream
// reload) can outlast the 2s tick interval, and lastScale is only updated after
// that await — so without this guard two overlapping runs read the same
// pre-scale `active` and both provision, overshooting maxApi. Same fix as the
// worker autoscaler. Node is single-threaded, so the boolean is race-free.
let scaling = false;

async function tick() {
  if (!enabled || scaling) return;
  scaling = true;
  try {
    await runScaleTick();
  } finally {
    scaling = false;
  }
}

async function runScaleTick() {
  const [snap, active, rps] = await Promise.all([metricsSnapshot(), activeApiInstances(), readRps()]);
  if (active < 0) return;
  const rawVst = snap.vstP95_ms;
  // vst is unusable ("not a real measurement") in two cases that both mean
  // "no /playback/start traffic right now", not "latency unknown":
  //   - null: Prometheus has no samples for the route in its rate window.
  //   - NaN: histogram_quantile() over an all-zero-count histogram (a
  //     window with samples but zero observations) returns NaN, not "no
  //     data" — and NaN survives `!= null` and fails every comparison, so
  //     without this check scale-down would wedge forever once a herd ends
  //     (confirmed while verifying: apiInstances stuck at 4 with vst
  //     showing as null over JSON, which is JSON.stringify(NaN)'s
  //     serialization, not an actual null in the in-process value).
  const vstKnown = rawVst != null && Number.isFinite(rawVst);
  const vst = vstKnown ? (rawVst as number) : null;
  const vstLabel = vstKnown ? `${vst}ms` : "n/a";

  // Debounce: require VST over threshold on HIGH_STREAK_REQUIRED consecutive
  // ticks (~4s at the 2s tick interval) before scaling up. A mixed workload
  // like episodePremiere (beacon storm; meant to drive the WORKER
  // autoscaler only) dispatches each 100ms tick's requests synchronously,
  // which can transiently spike the P95 VST sample for a tick or two even
  // though the api tier isn't really saturated (confirmed while verifying:
  // a single high sample early in episodePremiere triggered a false
  // scale-up before VST settled back down on its own) — a genuine playback
  // herd stays elevated for many consecutive ticks, so this only costs a
  // few seconds of detection latency on the real signal, not correctness.
  if (vstKnown && (vst as number) > config.vstScaleUpMs) {
    highStreak++;
  } else {
    highStreak = 0;
  }

  // Converge-down debounce: require the headroom check below to hold on
  // LOW_STREAK_REQUIRED consecutive ticks before a scale-down acts, mirroring
  // highStreak's role for scale-up. Tracked independently of the scale
  // cooldown (computed here, above the cooldown return) so it keeps counting
  // even while an action is on cooldown — otherwise the debounce would take
  // much longer than intended to satisfy right after a scale event.
  const headroom = (active - 1) * config.apiCapacity * config.apiScaleDownMargin;
  const vstLow = !vstKnown || (vst as number) < config.vstScaleDownMs;
  const hasSpareCapacity = (rps ?? 0) < headroom;
  if (vstLow && hasSpareCapacity && active > config.minApi) {
    lowStreak++;
  } else {
    lowStreak = 0;
  }

  const now = Date.now();
  if (now - lastScale < COOLDOWN_MS) return;

  if (vstKnown && highStreak >= HIGH_STREAK_REQUIRED && active < config.maxApi) {
    // Reactive, one instance at a time: unlike the worker scaler's
    // proportional jump, the read tier's per-instance saturation model
    // (see api/src/config.ts PLAYBACK_MAX_INFLIGHT) means even one extra
    // instance meaningfully sheds load off the saturated ones.
    const next = await setDesiredApiInstances(active + 1);
    lastScale = now;
    logEvent(
      "scale-up (read tier)",
      `VST ${vstLabel} > ${config.vstScaleUpMs}ms, provisioning API instance, api instances ${active} -> ${next}`
    );
  } else if (vstLow && hasSpareCapacity && active > config.minApi && lowStreak >= LOW_STREAK_REQUIRED) {
    // Converge-down on proven spare capacity: rather than waiting for the
    // herd to basically end (readRps -> 0), shed an instance as soon as
    // current demand would still have headroom on one fewer instance. This
    // lets the tier track demand proportionally on the way down (4->3->2->1
    // as load falls) instead of holding at peak count until traffic dies.
    const next = await setDesiredApiInstances(active - 1);
    lastScale = now;
    lowStreak = 0;
    logEvent(
      "scale-down (read tier)",
      `readRps ${rps ?? 0} below headroom (${headroom.toFixed(0)}) for ${active - 1} instances, shedding ${active} -> ${next}`
    );
  }
}

setInterval(() => {
  void tick().catch(() => {});
}, 2_000);
