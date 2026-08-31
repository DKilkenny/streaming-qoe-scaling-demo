const $ = (id) => document.getElementById(id);
const MAXPTS = 90;
const POLL_MS = 1500;
const series = { concurrent: [], vst: [], backlog: [], workers: [] };
let latestStatus = null; // last /api/status payload, used by tours + tooltips

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

// ---- sparkline hover: crosshair + tooltip ----
const sparkMeta = {
  "c-concurrent": { key: "concurrent", color: "#5b8cff", label: "Concurrent streams", fmt: (v) => Math.round(v).toLocaleString() },
  "c-vst": { key: "vst", color: "#f5b445", label: "VST p95", fmt: (v) => Math.round(v) + " ms" },
  "c-backlog": { key: "backlog", color: "#f2555a", label: "Backlog", fmt: (v) => Math.round(v).toLocaleString() },
  "c-workers": { key: "workers", color: "#34d399", label: "Active workers", fmt: (v) => Math.round(v) },
};
let hoverCanvasId = null;
let hoverIndex = null;

function sparkX(w, i) {
  const pad = 8;
  return pad + (i / (MAXPTS - 1)) * (w - pad * 2);
}
function sparkY(h, v, min, max) {
  const pad = 8, span = Math.max(max - min, 1);
  return h - pad - ((v - min) / span) * (h - pad * 2);
}

function drawCrosshair(canvasId) {
  if (hoverCanvasId !== canvasId || hoverIndex == null) return;
  const canvas = $(canvasId);
  const meta = sparkMeta[canvasId];
  const data = series[meta.key];
  if (!data.length) return;
  const idx = Math.min(hoverIndex, data.length - 1);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const x = sparkX(w, idx);
  const y = sparkY(h, data[idx], min, max);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, 2);
  ctx.lineTo(x, h - 2);
  ctx.strokeStyle = "rgba(230,235,242,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = meta.color;
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// draws the live line, then re-applies the crosshair on top if this canvas
// is currently being hovered — keeps the crosshair alive across live polling.
function redrawSpark(canvasId) {
  const meta = sparkMeta[canvasId];
  drawSpark($(canvasId), series[meta.key], meta.color);
  drawCrosshair(canvasId);
}

function showTooltip(canvasId, idx, clientX, clientY) {
  const meta = sparkMeta[canvasId];
  const data = series[meta.key];
  if (idx >= data.length) return;
  const v = data[idx];
  const fromEnd = data.length - 1 - idx;
  const timeLabel = fromEnd === 0 ? "now" : `-${(fromEnd * (POLL_MS / 1000)).toFixed(1)}s`;
  const tip = $("spark-tooltip");
  tip.innerHTML = `<strong>${meta.fmt(v)}</strong><span>${meta.label} &middot; ${timeLabel}</span>`;
  tip.style.left = clientX + 14 + "px";
  tip.style.top = clientY - 14 + "px";
  tip.classList.remove("hidden");
}
function hideTooltip() {
  $("spark-tooltip").classList.add("hidden");
}

function initSparkHover(canvasId) {
  const canvas = $(canvasId);
  const meta = sparkMeta[canvasId];
  canvas.addEventListener("mousemove", (e) => {
    const data = series[meta.key];
    if (!data.length) return;
    const rect = canvas.getBoundingClientRect();
    const pad = 8;
    const w = rect.width;
    let frac = (e.clientX - rect.left - pad) / (w - pad * 2);
    frac = Math.max(0, Math.min(1, frac));
    let idx = Math.round(frac * (MAXPTS - 1));
    idx = Math.max(0, Math.min(data.length - 1, idx));
    hoverCanvasId = canvasId;
    hoverIndex = idx;
    redrawSpark(canvasId);
    showTooltip(canvasId, idx, e.clientX, e.clientY);
  });
  canvas.addEventListener("mouseleave", () => {
    if (hoverCanvasId === canvasId) {
      hoverCanvasId = null;
      hoverIndex = null;
      redrawSpark(canvasId);
    }
    hideTooltip();
  });
}
Object.keys(sparkMeta).forEach(initSparkHover);

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
let apiscalerLocked = false;
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
  playbackSurge: "Everyone presses play at once when the episode drops — a read-path thundering herd. Watch VST spike as one API instance saturates, then recover as the read tier scales out. (VST is a trailing p95, so recovery shows a few seconds after the instances come up.)",
  stop: "Traffic stopped. Watch: the backlog drains, and once the surge has cleared, the autoscaler sheds workers back toward the floor.",
};
const STRATEGY_NOTES = {
  reactive: "Reactive scales only after the backlog crosses a threshold (2,000 queued beacons). Simple, but new workers arrive ~12s late (simulated) relative to the surge, so the backlog spikes higher before it's tamed (a real Fargate cold-start is ~60-90s — which is why you pre-warm).",
  proactive: "Proactive scales on utilization: it provisions the next worker at ~75% load, before the backlog builds. New workers still cold-start (~12s, simulated), so getting ahead matters (a real Fargate cold-start is ~60-90s — which is why you pre-warm).",
};
const PREWARM_NOTE_ON = "Capacity raised ahead of a known surge (premieres are scheduled). Watch the premiere barely move the backlog.";
const PREWARM_NOTE_OFF = "Pre-warm floor cleared. Capacity will ride the scaling strategy above instead of a fixed floor.";

async function poll() {
  let s;
  try { s = await (await fetch("/api/status")).json(); } catch { return; }
  latestStatus = s;
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
  $("t-api").textContent = s.apiInstances == null || s.apiInstances < 0 ? "n/a" : String(s.apiInstances);
  $("t-readrps").textContent = s.readRps == null ? "–" : Math.round(s.readRps).toLocaleString();

  push("concurrent", m.concurrentStreams || 0);
  push("vst", m.vstP95_ms || 0);
  push("backlog", m.backlog || 0);
  push("workers", s.workers < 0 ? 0 : s.workers);
  redrawSpark("c-concurrent");
  redrawSpark("c-vst");
  redrawSpark("c-backlog");
  redrawSpark("c-workers");

  if (!autoscalerLocked) $("autoscaler").checked = !!s.autoscaler;
  if (!apiscalerLocked) $("apiscaler").checked = !!s.apiAutoscaler;
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
$("apiscaler").addEventListener("change", async (e) => {
  apiscalerLocked = true;
  await post("/api/apiscaler", { enabled: e.target.checked });
  setTimeout(() => (apiscalerLocked = false), 1500);
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

// ---- Basic/Advanced tabs: remembered per-browser ----
const TAB_KEY = "console.activeTab";
function getStoredTab() {
  try { return localStorage.getItem(TAB_KEY); } catch { return null; }
}
function setStoredTab(v) {
  try { localStorage.setItem(TAB_KEY, v); } catch { /* ignore */ }
}
function applyTab(tab) {
  const basic = tab !== "advanced";
  $("basic-view").classList.toggle("hidden", !basic);
  $("advanced-view").classList.toggle("hidden", basic);
  $("tab-basic").classList.toggle("active", basic);
  $("tab-advanced").classList.toggle("active", !basic);
  $("tab-basic").setAttribute("aria-selected", String(basic));
  $("tab-advanced").setAttribute("aria-selected", String(!basic));
}
applyTab(getStoredTab() === "advanced" ? "advanced" : "basic");
// Switching tabs mid-tour would strand the Stop control (it only lives in
// #basic-view), so a tour is auto-stopped on any manual tab switch —
// stopTour() is a no-op when no tour is running.
$("tab-basic").addEventListener("click", () => { stopTour(); applyTab("basic"); setStoredTab("basic"); });
$("tab-advanced").addEventListener("click", () => { stopTour(); applyTab("advanced"); setStoredTab("advanced"); });

// ---- Guided tours ----
// Each tour drives the same API endpoints a human would click, on a timed
// sequence, narrating through #tour-caption. `tourGeneration` invalidates any
// in-flight tour when a new one starts or Stop is pressed, so stale timers
// and awaits become no-ops instead of racing the new state.
let tourGeneration = 0;
let activeTour = null; // 'A' | 'B' | null
let tourTimers = [];

function setCaption(html) { $("tour-caption").innerHTML = html; }

function sleep(ms) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    tourTimers.push(id);
  });
}

function clearTourTimers() {
  tourTimers.forEach(clearTimeout);
  tourTimers = [];
}

// Polls latestStatus (already refreshed by the live poll() loop) until
// `check` passes or `timeoutMs` elapses, bailing early if the tour was
// invalidated (stopped, or another tour started) in the meantime.
async function waitForCondition(check, timeoutMs, myGen, intervalMs = 1200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (myGen !== tourGeneration) return false;
    if (check(latestStatus)) return true;
    await sleep(intervalMs);
    if (myGen !== tourGeneration) return false;
  }
  return check(latestStatus);
}

function updateTourUI() {
  const btnA = $("tour-a-btn"), btnB = $("tour-b-btn"), stopBtn = $("tour-stop-btn");
  btnA.disabled = !!activeTour;
  btnB.disabled = !!activeTour;
  btnA.classList.toggle("active", activeTour === "A");
  btnB.classList.toggle("active", activeTour === "B");
  stopBtn.classList.toggle("hidden", !activeTour);
}

function finishTour() {
  activeTour = null;
  clearTourTimers();
  updateTourUI();
}

async function stopTour() {
  if (!activeTour) return;
  tourGeneration++; // invalidates every pending await in the running tour
  clearTourTimers();
  await post("/api/preset", { name: "stop" });
  setCaption("Tour stopped.");
  activeTour = null;
  updateTourUI();
}

async function runTourA() {
  if (activeTour) return;
  const myGen = ++tourGeneration;
  activeTour = "A";
  updateTourUI();

  if (myGen !== tourGeneration) return;
  await post("/api/apiscaler", { enabled: true });
  if (myGen !== tourGeneration) return;
  await post("/api/strategy", { strategy: "proactive" });
  if (myGen !== tourGeneration) return;
  setCaption("It&rsquo;s Tuesday night &mdash; a new episode just dropped. Everyone hits play at once.");

  await sleep(2500);
  if (myGen !== tourGeneration) return;
  await post("/api/preset", { name: "playbackSurge" });

  await sleep(5000);
  if (myGen !== tourGeneration) return;
  setCaption("One server is overwhelmed &mdash; playback-start time (VST) is climbing.");

  await waitForCondition((s) => s && s.apiInstances > 1, 15000, myGen);
  if (myGen !== tourGeneration) return;
  const apiN = latestStatus && latestStatus.apiInstances != null ? latestStatus.apiInstances : 4;
  setCaption(`The read tier is provisioning servers behind the load balancer to absorb it &mdash; 1 &rarr; ${apiN}. (Cold-start is compressed to ~12s here &mdash; a real Fargate cold-start is ~60-90s, which is why you pre-warm.)`);

  await waitForCondition((s) => s && s.metrics && s.metrics.vstP95_ms != null && s.metrics.vstP95_ms < 100, 45000, myGen, 1500);
  if (myGen !== tourGeneration) return;
  const vst = latestStatus && latestStatus.metrics && latestStatus.metrics.vstP95_ms != null ? latestStatus.metrics.vstP95_ms : "<100";
  setCaption(`Recovered &mdash; playback starts are fast again (VST ~${vst}ms) under a ~4,000/sec rush. And the analytics pipeline (workers) never even flinched &mdash; the two paths are decoupled.`);

  await sleep(4500);
  if (myGen !== tourGeneration) return;
  await post("/api/preset", { name: "stop" });
  setCaption("The rush passes; the read tier scales back down as demand falls.");

  await sleep(6000);
  if (myGen !== tourGeneration) return;
  setCaption("Tour complete &mdash; back to idle. Try &ldquo;Survive a failure&rdquo; next, or explore the Advanced tab.");
  finishTour();
}

async function runTourB() {
  if (activeTour) return;
  const myGen = ++tourGeneration;
  activeTour = "B";
  updateTourUI();

  if (myGen !== tourGeneration) return;
  await post("/api/autoscaler", { enabled: true });
  if (myGen !== tourGeneration) return;
  await post("/api/preset", { name: "episodePremiere" });
  if (myGen !== tourGeneration) return;
  setCaption("A premiere is running &mdash; analytics events flood in and the worker pool scales to keep up.");

  await sleep(12000);
  if (myGen !== tourGeneration) return;
  setCaption("Now watch what happens when I kill the entire analytics tier.");

  await sleep(1500);
  if (myGen !== tourGeneration) return;
  await post("/api/chaos/worker-outage");

  await sleep(5000);
  if (myGen !== tourGeneration) return;
  const backlog0 = latestStatus && latestStatus.metrics && latestStatus.metrics.backlog != null ? latestStatus.metrics.backlog.toLocaleString() : "rising";
  setCaption(`The event queue is backing up with no one to drain it (backlog ${backlog0}) &mdash; but watch playback latency: dead flat. Decoupled paths.`);

  await waitForCondition((s) => s && s.workers > 0 && s.metrics && s.metrics.backlog != null && s.metrics.backlog < 500, 30000, myGen, 1500);
  if (myGen !== tourGeneration) return;
  const w = latestStatus && latestStatus.workers != null ? latestStatus.workers : "several";
  setCaption(`Capacity comes back (workers ${w}) and drains the backlog. (Cold-start is compressed to ~12s in this demo &mdash; a real Fargate task takes ~60-90s.)`);

  await sleep(4000);
  if (myGen !== tourGeneration) return;
  await post("/api/preset", { name: "stop" });
  setCaption("Recovered. Playback never noticed.");

  await sleep(5000);
  if (myGen !== tourGeneration) return;
  setCaption("Tour complete &mdash; back to idle. Try &ldquo;The premiere rush&rdquo; next, or explore the Advanced tab.");
  finishTour();
}

$("tour-a-btn").addEventListener("click", () => { runTourA(); });
$("tour-b-btn").addEventListener("click", () => { runTourB(); });
$("tour-stop-btn").addEventListener("click", () => { stopTour(); });

poll();
setInterval(poll, POLL_MS);
