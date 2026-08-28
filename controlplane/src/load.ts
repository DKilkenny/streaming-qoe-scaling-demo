import { config } from "./config";

type Mode = "mixed" | "events";

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

async function oneRequest() {
  if (inflight >= MAX_INFLIGHT) return;
  inflight++;
  try {
    const roll = Math.random();
    if (mode === "events") {
      const id = pickId();
      if (id) {
        await fetch(`${config.apiBase}/events`, {
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
      const id = pickId();
      if (id)
        await fetch(`${config.apiBase}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ titleId: id, type: "play" }),
        });
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
