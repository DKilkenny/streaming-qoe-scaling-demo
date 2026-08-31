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

async function poll() {
  let s;
  try { s = await (await fetch("/api/status")).json(); } catch { return; }
  const m = s.metrics || {};

  $("t-vst").textContent = m.vstP95_ms == null ? "–" : m.vstP95_ms + " ms";
  $("t-concurrent").textContent = m.concurrentStreams == null ? "–" : m.concurrentStreams.toLocaleString();
  $("t-rebuffer").textContent = m.rebufferRatio == null ? "–" : m.rebufferRatio + "%";
  $("t-errors").textContent = m.playbackErrorRate == null ? "–" : m.playbackErrorRate + "%";
  $("t-backlog").textContent = m.backlog == null ? "–" : m.backlog.toLocaleString();
  $("t-workers").textContent = s.workers < 0 ? "n/a" : s.workers;
  $("w-count").textContent = s.workers < 0 ? "–" : s.workers;

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

  const feed = $("feed");
  feed.innerHTML = "";
  (s.events || []).slice().reverse().forEach((e) => {
    const li = document.createElement("li");
    const t = new Date(e.ts).toLocaleTimeString();
    li.innerHTML = `${t} <span class="k ${e.kind}">${e.kind}</span> ${e.detail}`;
    feed.appendChild(li);
  });
}

// ---- controls ----
$("rps").addEventListener("input", (e) => { $("rps-out").textContent = e.target.value + " rps"; });
$("rps").addEventListener("change", (e) => post("/api/load", { rps: Number(e.target.value), mode: "mixed" }));
document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => post("/api/preset", { name: b.dataset.preset }))
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
