import { config } from "./config";

type Mode = "mixed" | "events" | "premiere";

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

async function oneRequest() {
  if (inflight >= MAX_INFLIGHT) return;
  inflight++;
  try {
    const roll = Math.random();
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
