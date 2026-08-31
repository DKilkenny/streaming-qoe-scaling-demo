import { randomUUID } from "node:crypto";
import { config } from "./config";

type Mode = "mixed" | "events" | "premiere" | "surge" | "combined";

let targetRps = 0;
let mode: Mode = "mixed";
let running = false;
let inflight = 0;
let sent = 0;
let errors = 0;
let titleIds: string[] = [];
const MAX_INFLIGHT = 3000;
const TERMS = ["the", "last", "golden", "silent", "rising", "faithful"];

async function refreshIds() {
  try {
    const res = await fetch(`${config.apiBase}/discover`);
    const body = (await res.json()) as {
      rails: { titles: { id: string }[] }[];
    };
    const ids = new Set<string>();
    for (const rail of body.rails ?? [])
      for (const t of rail.titles ?? []) ids.add(t.id);
    if (ids.size) titleIds = [...ids];
  } catch {
    /* API may be warming up */
  }
}

function pickId(): string | null {
  if (!titleIds.length) return null;
  return titleIds[Math.floor(Math.random() * titleIds.length)];
}

// One simulated viewer. Opens a playback session (VST measured server-side),
// then lives for a realistic short watch window: its QoE beacons are SCHEDULED
// over time (not awaited back-to-back), so many sessions are concurrently
// "live" in Redis at once and `concurrent_streams` reflects real overlap. The
// dispatch loop is not blocked for the whole watch — only for the start+play —
// so throughput (and thus beacon publish rate) is unchanged.
async function viewerSession(titleId: string) {
  try {
    const res = await fetch(`${config.apiBase}/playback/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titleId }),
    });
    if (!res.ok) { errors++; return; }
    const { sessionId } = (await res.json()) as { sessionId: string };
    const beacon = (type: string) =>
      fetch(`${config.apiBase}/qoe/beacon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, titleId, type }),
      }).catch(() => { errors++; });

    // play now; the rest are scheduled across a ~5-30s watch so sessions overlap.
    void beacon("play");
    if (Math.random() < 0.08) {
      setTimeout(() => void beacon("rebuffer"), 2_000 + Math.random() * 4_000); // ~8% rebuffer early
    }
    setTimeout(() => void beacon("progress"), 5_000 + Math.random() * 7_000); // progress mid-watch
    if (Math.random() < 0.02) {
      setTimeout(() => void beacon("error"), 6_000 + Math.random() * 6_000); // ~2% error out mid-watch
    } else {
      setTimeout(() => void beacon("complete"), 14_000 + Math.random() * 16_000); // finish 14-30s in
    }
    sent++;
  } catch {
    errors++;
  }
}

// Thundering herd: a high, synchronized rate of POST /playback/start on the
// premiere title. Fire-and-forget on the beacon path — this scenario is about
// stressing the read path (playback/start + the per-instance entitlement
// concurrency cap), not the QoE beacon pipeline.
async function playbackStartOnly(titleId: string) {
  try {
    const res = await fetch(`${config.apiBase}/playback/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titleId }),
    });
    if (!res.ok) { errors++; return; }
    sent++;
  } catch {
    errors++;
  }
}

// Combined-premiere: a QoE-only session used by mode "combined" to build the
// worker tier's beacon backlog *independently* of the playback-start rate
// driving the read tier above it. Deliberately skips /playback/start (that
// read traffic is already generated, at a much higher and separately-tuned
// rate, by playbackStartOnly below) — /qoe/beacon doesn't require a real
// session id, so a locally-generated one is enough to drive the same
// live-session bookkeeping (touchSession/endSession) a real viewer would.
// Same beacon shape/timing as viewerSession, so the worker tier sees the
// same mix (play/progress/rebuffer/complete/error) it does in episodePremiere.
async function beaconOnlySession(titleId: string) {
  const sessionId = randomUUID();
  const beacon = (type: string) =>
    fetch(`${config.apiBase}/qoe/beacon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, titleId, type }),
    }).catch(() => { errors++; });

  void beacon("play");
  if (Math.random() < 0.08) {
    setTimeout(() => void beacon("rebuffer"), 2_000 + Math.random() * 4_000);
  }
  setTimeout(() => void beacon("progress"), 5_000 + Math.random() * 7_000);
  if (Math.random() < 0.02) {
    setTimeout(() => void beacon("error"), 6_000 + Math.random() * 6_000);
  } else {
    setTimeout(() => void beacon("complete"), 14_000 + Math.random() * 16_000);
  }
  sent++;
}

// Fixed beacon-session spawn rate for mode "combined", deliberately NOT
// derived from targetRps — this is what keeps the write/worker tier's
// beacon rate DECOUPLED from the read tier's playback-start rate. Each
// spawned session emits ~3.08 beacons on average over its lifetime (play +
// progress + always one of complete/error + an 8% chance of rebuffer), and
// by Little's law the steady-state beacon *emission* rate is
// spawn-rate * beacons-per-session, independent of how those beacons are
// spread out in time by their setTimeout scheduling. At
// COMBINED_BEACON_SPAWNS_PER_TICK=65, fired once per 100ms dispatch tick
// (10 ticks/s, see the dispatch loop below) regardless of what rps the
// combined preset is set to, that's 650 spawns/s -> ~650*3.08 ≈ 2000
// beacons/s: enough to build a visible backlog at 1 worker (~550/s) but
// well within the 5-worker pool's drain capacity (~2750/s), so it builds
// then drains instead of running away. If the start rate ever changes,
// this number does NOT need to change with it — that decoupling is the
// point (see combined-report.md for why coupling it to rps was the
// failure mode: e.g. beacons-per-start scaling would run the backlog away
// at high start rates).
const COMBINED_BEACON_SPAWNS_PER_TICK = 65;

async function oneRequest() {
  if (inflight >= MAX_INFLIGHT) return;
  inflight++;
  try {
    const roll = Math.random();
    if (mode === "surge") {
      const id = titleIds[0] ?? pickId();
      if (id) await playbackStartOnly(id);
      return;
    }
    if (mode === "combined") {
      // Read-tier half of the combined scenario: the same fire-and-forget
      // playback-start herd as "surge", driven at the preset's rps. The
      // write-tier half (beaconOnlySession) is spawned separately, at a
      // fixed rate, by the dispatch loop below — not from here — so it
      // never scales with rps.
      const id = titleIds[0] ?? pickId();
      if (id) await playbackStartOnly(id);
      return;
    }
    if (mode === "premiere") {
      const id = titleIds[0] ?? pickId();
      if (id) await viewerSession(id);
      return;
    }
    if (mode === "events") {
      const id = pickId();
      if (id) {
        await fetch(`${config.apiBase}/qoe/beacon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ titleId: id, type: roll < 0.3 ? "complete" : "play" }),
        });
      }
    } else if (roll < 0.55) {
      await fetch(`${config.apiBase}/discover`);
    } else if (roll < 0.8) {
      const id = pickId();
      if (id) await fetch(`${config.apiBase}/titles/${id}`);
    } else if (roll < 0.92) {
      await fetch(`${config.apiBase}/search?q=${TERMS[(Math.random() * TERMS.length) | 0]}`);
    } else {
      // ~8% of mixed traffic opens a real playback session so VST/concurrent
      // streams/rebuffer ratio stay populated outside the premiere preset too.
      const id = pickId();
      if (id) await viewerSession(id);
      return; // viewerSession owns its own `sent` count; don't double-count here
    }
    sent++;
  } catch {
    errors++;
  } finally {
    inflight--;
  }
}

// Dispatch loop: every 100ms fire ~1/10th of the target RPS.
const TICK_MS = 100;
setInterval(() => {
  if (!running || targetRps <= 0) return;
  const n = Math.round((targetRps * TICK_MS) / 1000);
  for (let i = 0; i < n; i++) void oneRequest();
  // Combined-premiere's write/worker-tier half: a fixed spawn rate, NOT
  // derived from `n`/targetRps above — see COMBINED_BEACON_SPAWNS_PER_TICK.
  // Intentionally bypasses the inflight/MAX_INFLIGHT gate that oneRequest()
  // uses above: this is a fixed, low, fire-and-forget rate (not driven by
  // rps), so it can't runaway inflight the way an unbounded rps-scaled path
  // could — the gate isn't needed here and skipping it keeps this spawn
  // decoupled from the read tier's inflight pressure too.
  if (mode === "combined") {
    const id = titleIds[0] ?? pickId();
    if (id) for (let i = 0; i < COMBINED_BEACON_SPAWNS_PER_TICK; i++) void beaconOnlySession(id);
  }
}, TICK_MS);

// Keep the working set of title IDs fresh.
setInterval(refreshIds, 15_000);

export async function startLoad(rps: number, m: Mode) {
  targetRps = Math.max(0, Math.min(20000, rps));
  mode = m;
  running = targetRps > 0;
  if (running && !titleIds.length) await refreshIds();
}

export function stopLoad() {
  running = false;
  targetRps = 0;
}

export function loadState() {
  return { running, targetRps, mode, inflight, sent, errors };
}
