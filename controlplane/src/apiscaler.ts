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

export function setApiAutoscaler(on: boolean) {
  enabled = on;
  highStreak = 0;
  logEvent("api-autoscaler", on ? "enabled" : "disabled");
}

export function apiAutoscalerEnabled() {
  return enabled;
}

async function tick() {
  if (!enabled) return;

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
  } else if (
    (!vstKnown || (vst as number) < config.vstScaleDownMs) &&
    (rps ?? 0) < config.scaleDownReadRps &&
    active > config.minApi
  ) {
    // VST is low (or unmeasured because traffic has stopped) AND read RPS
    // has actually subsided (not just momentarily fast because the tier is
    // over-provisioned): safe to shed an instance. The RPS gate keeps this
    // from flapping mid-herd the same way the worker scaler's publish-rate
    // gate does.
    const next = await setDesiredApiInstances(active - 1);
    lastScale = now;
    logEvent(
      "scale-down (read tier)",
      `VST ${vstLabel} < ${config.vstScaleDownMs}ms & read RPS ${rps ?? 0} < ${config.scaleDownReadRps}, api instances ${active} -> ${next}`
    );
  }
}

setInterval(() => {
  void tick().catch(() => {});
}, 2_000);
