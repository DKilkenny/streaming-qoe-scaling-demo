const $ = (id) => document.getElementById(id);
const MAXPTS = 90;
const series = { concurrent: [], vst: [], backlog: [], workers: [] };

// ---- dependency-free sparkline ----
function drawSpark(canvas, data, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const pad = 8, span = Math.max(max - min, 1);
  const x = (i) => pad + (i / (MAXPTS - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  // fill
  ctx.beginPath();
  ctx.moveTo(x(0), h);
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(data.length - 1), h);
  ctx.closePath();
  ctx.fillStyle = color + "22";
  ctx.fill();
  // line
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // last value dot
  const lx = x(data.length - 1), ly = y(data[data.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
}

function setActive(btn, active) {
  btn.classList.toggle("active", active);
}

function push(key, v) {
  const arr = series[key];
  arr.push(Number.isFinite(v) ? v : 0);
  if (arr.length > MAXPTS) arr.shift();
}

async function post(path, body) {
  await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).catch(() => {});
}

let autoscalerLocked = false;
let strategyLocked = false;
let prewarmLocked = false;

// ---- framing panel: collapsible, remembered per-browser ----
const FRAMING_KEY = "console.framingCollapsed";
function getFramingCollapsed() {
  try { return localStorage.getItem(FRAMING_KEY) === "1"; } catch { return false; }
}
function setFramingCollapsed(v) {
  try { localStorage.setItem(FRAMING_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}
function applyFramingState(collapsed) {
  $("framing").classList.toggle("collapsed", collapsed);
  $("framing-toggle").textContent = collapsed ? "Show explanation ▾" : "Hide explanation ▴";
  $("framing-toggle").setAttribute("aria-expanded", String(!collapsed));
}
applyFramingState(getFramingCollapsed());
$("framing-toggle").addEventListener("click", () => {
  const next = !$("framing").classList.contains("collapsed");
  applyFramingState(next);
  setFramingCollapsed(next);
});

// ---- "what to watch" note: updated when a preset or strategy is picked ----
function setNote(text) { $("note-text").textContent = text; }

const PRESET_NOTES = {
  eveningPeak: "Simulating a modest, steady evening viewership bump: mixed browsing, search, and playback. Watch: metrics stay well within normal range and the autoscaler shouldn't need to do much.",
  trailerDrop: "Simulating a trailer-drop spike: a burst of catalog and search traffic. Watch: read-path load (discover/search) rises while playback stays a smaller share of it.",
  episodePremiere: "Simulating a synchronized viewer surge (an episode drop): everyone opens the same title at once. Watch: reads stay fast (VST) while the beacon backlog builds and the autoscaler provisions workers.",
  stop: "Traffic stopped. Watch: the backlog drains, and once the surge has cleared, the autoscaler sheds workers back toward the floor.",
};
const STRATEGY_NOTES = {
  reactive: "Reactive scales only after the backlog crosses a threshold (2,000 queued beacons). Simple, but new workers arrive ~12s late (simulated) relative to the surge, so the backlog spikes higher before it's tamed.",
  proactive: "Proactive scales on utilization: it provisions the next worker at ~75% load, before the backlog builds. New workers still cold-start (~12s, simulated), so getting ahead matters.",
};
const PREWARM_NOTE_ON = "Capacity raised ahead of a known surge (premieres are scheduled). Watch the premiere barely move the backlog.";
const PREWARM_NOTE_OFF = "Pre-warm floor cleared. Capacity will ride the scaling strategy above instead of a fixed floor.";

async function poll() {
  let s;
  try { s = await (await fetch("/api/status")).json(); } catch { return; }
  const m = s.metrics || {};

  $("t-vst").textContent = m.vstP95_ms == null ? "–" : m.vstP95_ms + " ms";
  $("t-concurrent").textContent = m.concurrentStreams == null ? "–" : m.concurrentStreams.toLocaleString();
  $("t-rebuffer").textContent = m.rebufferRatio == null ? "–" : m.rebufferRatio + "%";
  $("t-errors").textContent = m.playbackErrorRate == null ? "–" : m.playbackErrorRate + "%";
  $("t-backlog").textContent = m.backlog == null ? "–" : m.backlog.toLocaleString();
  $("t-workers").textContent = s.workers < 0 ? "n/a" : String(s.workers);
  $("t-workers-badge").textContent = s.workersWarming ? `+${s.workersWarming} warming` : "";
  $("w-count").textContent = s.workers < 0 ? "–" : s.workers;
  $("t-util").textContent = s.utilization == null ? "–" : s.utilization + "%";

  push("concurrent", m.concurrentStreams || 0);
  push("vst", m.vstP95_ms || 0);
  push("backlog", m.backlog || 0);
  push("workers", s.workers < 0 ? 0 : s.workers);
  drawSpark($("c-concurrent"), series.concurrent, "#5b8cff");
  drawSpark($("c-vst"), series.vst, "#f5b445");
  drawSpark($("c-backlog"), series.backlog, "#f2555a");
  drawSpark($("c-workers"), series.workers, "#34d399");

  if (!autoscalerLocked) $("autoscaler").checked = !!s.autoscaler;
  if (s.jaegerUrl) $("jaeger-link").href = s.jaegerUrl;

  if (!strategyLocked) {
    document.querySelectorAll("[data-strategy]").forEach((b) => setActive(b, b.dataset.strategy === s.strategy));
  }
  if (!prewarmLocked) {
    const active = s.prewarm > 0;
    setActive($("prewarm"), active);
    $("prewarm").textContent = active ? `Pre-warmed (${s.prewarm})` : "Pre-warm for premiere";
  }

  const feed = $("feed");
  feed.innerHTML = "";
  (s.events || []).slice().reverse().forEach((e) => {
    const li = document.createElement("li");
    const t = new Date(e.ts).toLocaleTimeString();
    // e.kind can carry a qualifier, e.g. "scale-up (proactive)"; color by the
    // base word so the CSS class stays a single clean token, but show the
    // full kind text.
    const baseKind = e.kind.split(" ")[0];
    const detail = e.detail.charAt(0).toUpperCase() + e.detail.slice(1) + (/[.!?]$/.test(e.detail) ? "" : ".");
    li.innerHTML = `<span class="t">${t}</span><span class="k ${baseKind}">${e.kind}</span><span class="d">${detail}</span>`;
    feed.appendChild(li);
  });
}

// ---- controls ----
$("rps").addEventListener("input", (e) => { $("rps-out").textContent = e.target.value + " rps"; });
$("rps").addEventListener("change", (e) => post("/api/load", { rps: Number(e.target.value), mode: "mixed" }));
document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => {
    const note = PRESET_NOTES[b.dataset.preset];
    if (note) setNote(note);
    post("/api/preset", { name: b.dataset.preset });
  })
);
$("chaos").addEventListener("click", () => post("/api/chaos/worker-outage"));
$("scale-max").addEventListener("click", () => post("/api/scale", { workers: 99 }));
$("w-up").addEventListener("click", async () => {
  const n = parseInt($("w-count").textContent) || 1; await post("/api/scale", { workers: n + 1 });
});
$("w-down").addEventListener("click", async () => {
  const n = parseInt($("w-count").textContent) || 1; await post("/api/scale", { workers: n - 1 });
});
$("autoscaler").addEventListener("change", async (e) => {
  autoscalerLocked = true;
  await post("/api/autoscaler", { enabled: e.target.checked });
  setTimeout(() => (autoscalerLocked = false), 1500);
});
document.querySelectorAll("[data-strategy]").forEach((b) =>
  b.addEventListener("click", async () => {
    strategyLocked = true;
    document.querySelectorAll("[data-strategy]").forEach((x) => setActive(x, x === b));
    const note = STRATEGY_NOTES[b.dataset.strategy];
    if (note) setNote(note);
    await post("/api/strategy", { strategy: b.dataset.strategy });
    setTimeout(() => (strategyLocked = false), 1500);
  })
);
$("prewarm").addEventListener("click", async () => {
  prewarmLocked = true;
  setActive($("prewarm"), true);
  $("prewarm").textContent = "Pre-warmed (4)";
  setNote(PREWARM_NOTE_ON);
  await post("/api/prewarm", { workers: 4 });
  setTimeout(() => (prewarmLocked = false), 1500);
});
$("prewarm-clear").addEventListener("click", async () => {
  prewarmLocked = true;
  setActive($("prewarm"), false);
  $("prewarm").textContent = "Pre-warm for premiere";
  setNote(PREWARM_NOTE_OFF);
  await post("/api/prewarm", { workers: 0 });
  setTimeout(() => (prewarmLocked = false), 1500);
});
$("explain").addEventListener("click", async () => {
  const out = $("explain-out");
  out.classList.remove("hidden");
  out.innerHTML = `<span class="tag">thinking…</span>`;
  try {
    const r = await (await fetch("/api/explain", { method: "POST" })).json();
    const tag = r.source === "ai" ? `AI · ${r.model}` : "rule-based (no API key)";
    out.innerHTML = `<span class="tag">${tag}</span>${r.text}`;
  } catch {
    out.innerHTML = `<span class="tag">error</span>Could not generate an explanation.`;
  }
});

poll();
setInterval(poll, 1500);
