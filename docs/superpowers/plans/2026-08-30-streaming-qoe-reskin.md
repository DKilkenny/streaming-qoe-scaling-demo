# Streaming QoE Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the existing discovery/engagement demo into a video playback + QoE (Quality of Experience) service whose headline scenario is an episode-premiere traffic spike, reusing all existing infrastructure.

**Architecture:** Same two-role Fastify app (API + worker off one `streaming-app` image), Redis cache, RabbitMQ → worker → Postgres pipeline, control-plane Load Console, OTel/Jaeger, Prometheus/Grafana. The reskin adds a `POST /playback/start` endpoint (its measured latency is Video Start Time), renames the engagement-event pipeline to QoE beacons (`play/progress/complete/rebuffer/error`), tracks concurrent streams via a Redis sorted set of live sessions, and relabels the Console + Grafana + AI explainer into streaming vocabulary. No infrastructure is rebuilt.

**Tech Stack:** Node.js, Fastify, TypeScript (CommonJS build), Redis (ioredis), RabbitMQ (amqplib), Postgres (pg), prom-client, OpenTelemetry, Prometheus, Grafana, Docker Compose.

**Spec:** `docs/streaming-qoe-reskin-design.md`

## Global Constraints

- **Honesty contract:** every on-screen number is either **measured** by the running system or **aggregated from client-emitted beacons**, never invented. VST = measured latency of `POST /playback/start`. Rebuffer ratio / error rate = aggregated from beacons.
- **VST SLO: p95 < 100 ms** for `POST /playback/start`. This is the primary pass/fail line and must stay green through the Episode Premiere surge.
- **Reuse, don't rebuild:** the autoscaler (stop/start via Docker socket), OTel/Jaeger tracing, Prometheus/Grafana, worker reconnect loops, and the shared `streaming-app` image all stay intact.
- **No test framework exists** in either package. Verification for every task is *running the stack and observing real behavior* (curl responses, `/metrics`, Grafana, the Console) — not unit tests.
- **`concurrent_streams` is a global gauge:** every API replica reads the same Redis sorted set and reports the same value, so it MUST be queried with `max(concurrent_streams)`, never `sum(...)`.
- **Beacon types are exactly:** `play`, `progress`, `complete`, `rebuffer`, `error`.
- Commit after each task. Do a `make clean && make up` (not just `make up`) the first time the queue is renamed, so no stale `engagement` queue lingers.

---

### Task 1: Rename the event pipeline to QoE beacons (end-to-end)

Renames the internal engagement-event pipeline to QoE beacons so the queue, metrics, endpoint, worker, and load generator all speak streaming. This is a cohesive rename: it must compile and run as one unit.

**Files:**
- Modify: `api/src/config.ts` (rename `engagementQueue` → `qoeQueue`, value `"qoe"`)
- Modify: `api/src/telemetry.ts` (rename beacon counters, add concurrent-streams gauge + helper)
- Create: `api/src/routes/beacon.ts` (renamed from `events.ts`, adds `rebuffer`/`error` types)
- Delete: `api/src/routes/events.ts`
- Modify: `api/src/worker.ts` (use `config.qoeQueue`, `beaconsProcessed`)
- Modify: `api/src/server.ts` (register `beaconRoutes` instead of `eventRoutes`)
- Modify: `controlplane/src/load.ts` (`/events` → `/qoe/beacon`)

**Interfaces:**
- Produces:
  - `config.qoeQueue: string` (= `"qoe"`)
  - `telemetry.beaconsPublished: client.Counter` (metric `qoe_beacons_published_total`, label `type`)
  - `telemetry.beaconsProcessed: client.Counter` (metric `qoe_beacons_processed_total`, label `type`)
  - `telemetry.concurrentStreams: client.Gauge` (metric `concurrent_streams`)
  - `telemetry.setConcurrentStreams(n: number): void`
  - `beaconRoutes(app: FastifyInstance): Promise<void>` registering `POST /qoe/beacon`

- [ ] **Step 1: Rename the queue in config**

In `api/src/config.ts`, change the last field:
```ts
  qoeQueue: "qoe",
```
(replacing `engagementQueue: "engagement",`)

- [ ] **Step 2: Rename counters and add the concurrent-streams gauge in telemetry**

In `api/src/telemetry.ts`, replace the `eventsPublished` and `eventsProcessed` exports with:
```ts
export const beaconsPublished = new client.Counter({
  name: "qoe_beacons_published_total",
  help: "QoE beacons published to the queue",
  labelNames: ["type"],
  registers: [registry],
});

export const beaconsProcessed = new client.Counter({
  name: "qoe_beacons_processed_total",
  help: "QoE beacons consumed by the worker",
  labelNames: ["type"],
  registers: [registry],
});

// Global gauge of live playback sessions. Every API replica reads the same
// Redis sorted set and reports the same value, so query it with max(), not sum().
export const concurrentStreams = new client.Gauge({
  name: "concurrent_streams",
  help: "Playback sessions with a heartbeat in the last 30s",
  registers: [registry],
});

export function setConcurrentStreams(n: number): void {
  concurrentStreams.set(n);
}
```

- [ ] **Step 3: Create the beacon route (renamed from events)**

Create `api/src/routes/beacon.ts`:
```ts
import { FastifyInstance } from "fastify";
import { getChannel } from "../lib/rabbit";
import { beaconsPublished } from "../telemetry";
import { config } from "../config";
import { touchSession, endSession } from "../lib/sessions";

const VALID = new Set(["play", "progress", "complete", "rebuffer", "error"]);

type Body = {
  sessionId?: string;
  titleId?: string;
  type?: string;
  position?: number;
};

export async function beaconRoutes(app: FastifyInstance) {
  // QoE beacon ingest. Off the hot path: accept fast, enqueue for the worker to
  // aggregate, return 202. Session liveness (for concurrent-streams) is updated
  // here in Redis so it stays real-time even when the beacon backlog grows.
  app.post<{ Body: Body }>("/qoe/beacon", async (req, reply) => {
    const { sessionId, titleId, type, position } = req.body ?? {};
    if (!titleId || !type || !VALID.has(type)) {
      return reply.code(400).send({ error: "invalid_beacon" });
    }

    if (sessionId) {
      if (type === "complete" || type === "error") await endSession(sessionId);
      else await touchSession(sessionId); // play / progress / rebuffer keep it live
    }

    const channel = await getChannel();
    const payload = Buffer.from(
      JSON.stringify({ titleId, type, position: position ?? 0, ts: Date.now() })
    );
    channel.sendToQueue(config.qoeQueue, payload, { persistent: true });
    beaconsPublished.labels(type).inc();

    return reply.code(202).send({ accepted: true });
  });
}
```
Then delete `api/src/routes/events.ts`.

> Note: `../lib/sessions` (`touchSession`, `endSession`) is created in Task 2. Until Task 2 lands, this file will not compile — implement Task 1 and Task 2 back-to-back, or temporarily stub the two calls. Recommended: implement Task 2's `api/src/lib/sessions.ts` immediately after Step 3, before the Step 8 build.

- [ ] **Step 4: Point the worker at the renamed queue and counter**

In `api/src/worker.ts`:
- Change the import `import { eventsProcessed } from "./telemetry";` → `import { beaconsProcessed } from "./telemetry";`
- In `handle()`, change `eventsProcessed.labels(type).inc();` → `beaconsProcessed.labels(type).inc();`
- Every `config.engagementQueue` reference (in `consumeForever`) → `config.qoeQueue`.

- [ ] **Step 5: Register the beacon route in the server**

In `api/src/server.ts`:
- Change `import { eventRoutes } from "./routes/events";` → `import { beaconRoutes } from "./routes/beacon";`
- Change `await app.register(eventRoutes);` → `await app.register(beaconRoutes);`

- [ ] **Step 6: Update the load generator endpoint path**

In `controlplane/src/load.ts`, replace both `` `${config.apiBase}/events` `` occurrences with `` `${config.apiBase}/qoe/beacon` ``. (The richer viewer model comes in Task 4; this keeps load working now.)

- [ ] **Step 7: Update Prometheus queries that reference the old metric names**

In `controlplane/src/metrics.ts`, in the `metricsSnapshot` Promise.all, change:
```ts
      q("sum(rate(engagement_events_published_total[15s]))"),
      q("sum(rate(engagement_events_processed_total[15s]))"),
```
to:
```ts
      q("sum(rate(qoe_beacons_published_total[15s]))"),
      q("sum(rate(qoe_beacons_processed_total[15s]))"),
```

- [ ] **Step 8: Build both packages to confirm they compile**

Run: `cd api && npx tsc --noEmit && cd ../controlplane && npx tsc --noEmit`
Expected: no errors. (Requires Task 2's `api/src/lib/sessions.ts` to exist — see Step 3 note.)

- [ ] **Step 9: Bring the stack up clean and confirm beacons flow**

Run: `make clean && make up` then drive a little load:
```bash
curl -s -XPOST https://console.localhost/api/preset -H 'content-type: application/json' -d '{"name":"eveningPeak"}' -k
sleep 20
curl -s http://localhost:3000/metrics | grep qoe_beacons_
```
Expected: `qoe_beacons_published_total` and `qoe_beacons_processed_total` present and incrementing; RabbitMQ UI (http://localhost:15673) shows a `qoe` queue draining, no `engagement` queue. (If the `eveningPeak` preset name errors, it is added in Task 4 — use the raw load endpoint `-d '{"rps":800,"mode":"mixed"}'` against `/api/load` for this check instead.)

- [ ] **Step 10: Commit**

```bash
git add api/src controlplane/src/load.ts controlplane/src/metrics.ts
git commit -m "Rename engagement-event pipeline to QoE beacons"
```

---

### Task 2: Playback session model + Video Start Time endpoint

Adds `POST /playback/start` (the endpoint whose measured latency is VST) and the Redis-backed live-session set that powers concurrent-streams.

**Files:**
- Create: `api/src/lib/sessions.ts` (Redis sorted-set session tracking)
- Create: `api/src/routes/playback.ts` (`POST /playback/start`)
- Modify: `api/src/server.ts` (register `playbackRoutes`, start the concurrency sampler)

**Interfaces:**
- Consumes: `redis` from `api/src/lib/redis`; `getOrSet` from `api/src/lib/cache`; `pool` from `api/src/lib/db`; `setConcurrentStreams` from `api/src/telemetry`.
- Produces:
  - `sessions.touchSession(sessionId: string): Promise<void>` — `ZADD active_sessions <now> <id>`
  - `sessions.endSession(sessionId: string): Promise<void>` — `ZREM active_sessions <id>`
  - `sessions.liveStreamCount(): Promise<number>` — prunes stale entries, returns count with heartbeat in last 30s
  - `playbackRoutes(app: FastifyInstance): Promise<void>` registering `POST /playback/start` returning `{ sessionId, title }`

- [ ] **Step 1: Create the session tracker**

Create `api/src/lib/sessions.ts`:
```ts
import { redis } from "./redis";

const KEY = "active_sessions";
const WINDOW_MS = 30_000; // a session is "live" if it beaconed in the last 30s

// Mark a session live (playback start, or any play/progress/rebuffer beacon).
export async function touchSession(sessionId: string): Promise<void> {
  try {
    await redis.zadd(KEY, Date.now(), sessionId);
  } catch {
    /* concurrency tracking is best-effort, never a correctness dependency */
  }
}

// Remove a session (complete or error beacon).
export async function endSession(sessionId: string): Promise<void> {
  try {
    await redis.zrem(KEY, sessionId);
  } catch {
    /* best-effort */
  }
}

// Prune stale entries and return the count of sessions still live.
export async function liveStreamCount(): Promise<number> {
  try {
    const cutoff = Date.now() - WINDOW_MS;
    await redis.zremrangebyscore(KEY, "-inf", `(${cutoff}`);
    return await redis.zcard(KEY);
  } catch {
    return 0;
  }
}
```

- [ ] **Step 2: Create the playback-start route**

Create `api/src/routes/playback.ts`:
```ts
import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db";
import { getOrSet } from "../lib/cache";
import { touchSession } from "../lib/sessions";

// POST /playback/start — authorize + prepare a playback session. Its measured
// latency is Video Start Time (VST). Cache-first entitlement/title lookup keeps
// it fast (SLO p95 < 100ms) and independent of the beacon write path.
export async function playbackRoutes(app: FastifyInstance) {
  app.post<{ Body: { titleId?: string } }>("/playback/start", async (req, reply) => {
    const titleId = req.body?.titleId;
    if (!titleId) return reply.code(400).send({ error: "missing_title" });

    // Entitlement check == the title exists and is playable. Cache-first.
    const title = await getOrSet(`entitle:${titleId}`, `entitle:${titleId}`, async () => {
      const { rows } = await pool.query(
        `SELECT id, slug, title, kind FROM titles WHERE id = $1`,
        [titleId]
      );
      return rows[0] ?? null;
    });
    if (!title) return reply.code(404).send({ error: "not_entitled" });

    const sessionId = randomUUID();
    await touchSession(sessionId);
    return reply.code(200).send({ sessionId, title });
  });
}
```

- [ ] **Step 3: Register the route and start the concurrency sampler**

In `api/src/server.ts`:
- Add imports:
```ts
import { playbackRoutes } from "./routes/playback";
import { liveStreamCount } from "./lib/sessions";
import { setConcurrentStreams } from "./telemetry";
```
- Register alongside the others (after `catalogRoutes`):
```ts
  await app.register(playbackRoutes);
```
- After `await app.listen(...)`, add the sampler:
```ts
  // Publish the live-session count to Prometheus every 3s (global gauge; query
  // with max(concurrent_streams) since all replicas report the same value).
  setInterval(async () => setConcurrentStreams(await liveStreamCount()), 3_000);
```

- [ ] **Step 4: Build the API package**

Run: `cd api && npx tsc --noEmit`
Expected: no errors (this resolves the `../lib/sessions` import from Task 1).

- [ ] **Step 5: Bring up and verify VST + concurrency**

Run: `make up` then:
```bash
# grab a real title id
TID=$(curl -s http://localhost:3000/discover | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.rails[0].titles[0].id)})')
# start a playback session and time it
curl -s -o /dev/null -w 'VST: %{time_total}s status:%{http_code}\n' -XPOST http://localhost:3000/playback/start -H 'content-type: application/json' -d "{\"titleId\":\"$TID\"}"
# confirm the concurrency gauge exists
sleep 4 && curl -s http://localhost:3000/metrics | grep '^concurrent_streams'
```
Expected: playback/start returns 200 with a `sessionId` in well under 0.1s; `concurrent_streams` gauge present (≥ 1 right after a start, decaying to 0 after 30s of no heartbeats).

- [ ] **Step 6: Commit**

```bash
git add api/src/lib/sessions.ts api/src/routes/playback.ts api/src/server.ts
git commit -m "Add playback/start (VST) endpoint and live-session tracking"
```

---

### Task 3: Streaming metrics in the control plane snapshot

Extends the control-plane metrics snapshot with VST p95, concurrent streams, rebuffer ratio, and playback error rate, so the Console and AI explainer have streaming numbers to show.

**Files:**
- Modify: `controlplane/src/metrics.ts` (add VST, concurrency, rebuffer, error-rate queries)
- Modify: `controlplane/src/index.ts` (nothing structural — `/api/status` already returns `metricsSnapshot()`; confirm it flows)

**Interfaces:**
- Produces (new fields on `Snapshot`): `vstP95_ms: number | null`, `concurrentStreams: number | null`, `rebufferRatio: number | null` (percent), `playbackErrorRate: number | null` (percent). Existing fields (`p50_ms`, `p99_ms`, `cacheHitRate`, `rps`, `backlog`, `unacked`, `eventsPublished`, `eventsProcessed`) stay.

- [ ] **Step 1: Add the streaming queries**

In `controlplane/src/metrics.ts`, extend the `Promise.all` and the returned object. Add these queries (VST filtered to the playback route; concurrency via `max`; rebuffer and error as ratios over processed beacons):
```ts
      q('histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{route="/playback/start"}[30s])) by (le))'),
      q("max(concurrent_streams)"),
      q('sum(rate(qoe_beacons_processed_total{type="rebuffer"}[30s])) / clamp_min(sum(rate(qoe_beacons_processed_total{type=~"play|progress|rebuffer"}[30s])), 1)'),
      q('sum(rate(qoe_beacons_processed_total{type="error"}[30s])) / clamp_min(sum(rate(qoe_beacons_processed_total[30s])), 1)'),
```
Destructure them (e.g. `vst`, `concurrent`, `rebuf`, `errRate`) and add to the return object:
```ts
    vstP95_ms: vst == null ? null : Math.round(vst * 1000 * 10) / 10,
    concurrentStreams: concurrent == null ? null : Math.round(concurrent),
    rebufferRatio: rebuf == null ? null : Math.round(rebuf * 1000) / 10, // percent
    playbackErrorRate: errRate == null ? null : Math.round(errRate * 1000) / 10, // percent
```

- [ ] **Step 2: Build the control-plane package**

Run: `cd controlplane && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the new fields appear in /api/status**

Run: `make up`, drive load, then:
```bash
curl -s -XPOST http://localhost:8080/api/load -H 'content-type: application/json' -d '{"rps":1000,"mode":"events"}'
sleep 25
curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d).metrics;console.log({vstP95_ms:m.vstP95_ms,concurrentStreams:m.concurrentStreams,rebufferRatio:m.rebufferRatio,playbackErrorRate:m.playbackErrorRate})})'
```
Expected: `vstP95_ms` is a small number (well under 100), the other three are numbers (rebuffer/error may be 0 until Task 4 emits those beacon types).

- [ ] **Step 4: Commit**

```bash
git add controlplane/src/metrics.ts
git commit -m "Add VST, concurrency, rebuffer, and error-rate to metrics snapshot"
```

---

### Task 4: Streaming presets + client-fleet load generator

Replaces the presets with streaming scenarios and upgrades the load generator into a client fleet that opens playback sessions and emits QoE beacons (including rebuffers), so the Episode Premiere preset produces the demo's centerpiece behavior.

**Files:**
- Modify: `controlplane/src/load.ts` (viewer-session model, premiere targeting, rebuffer injection)
- Modify: `controlplane/src/index.ts` (rename PRESETS)

**Interfaces:**
- Consumes: `config.apiBase`; `POST /playback/start` (Task 2); `POST /qoe/beacon` (Task 1).
- Produces: presets `eveningPeak`, `trailerDrop`, `episodePremiere`; `startLoad(rps, mode)` where `mode` gains `"premiere"`.

- [ ] **Step 1: Add a viewer-session driver to the load generator**

In `controlplane/src/load.ts`, widen the mode type and add a viewer function that models one real streamer. Change `type Mode = "mixed" | "events";` to:
```ts
type Mode = "mixed" | "events" | "premiere";
```
Add near `oneRequest` (uses the module's `inflight`/`sent`/`errors` counters and `config.apiBase`):
```ts
// One simulated viewer: open a playback session (VST is measured server-side),
// then emit a short run of QoE beacons — a play, a couple of progress beacons,
// an occasional rebuffer, and a final complete. This is the "client SDK fleet"
// that produces the QoE numbers the dashboard aggregates.
async function viewerSession(titleId: string) {
  if (inflight >= MAX_INFLIGHT) return;
  inflight++;
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

    await beacon("play");
    await beacon("progress");
    if (Math.random() < 0.08) await beacon("rebuffer"); // ~8% see a rebuffer
    if (Math.random() < 0.02) { await beacon("error"); return; } // ~2% error out
    await beacon("progress");
    await beacon("complete");
    sent++;
  } catch {
    errors++;
  } finally {
    inflight--;
  }
}
```

- [ ] **Step 2: Route the premiere mode through the viewer driver**

In `load.ts` `oneRequest`, add a `premiere` branch at the top of the `try`. In premiere mode, concentrate viewers on a single "premiere" title (the first known id) to model everyone hitting play on the new episode:
```ts
    if (mode === "premiere") {
      const id = titleIds[0] ?? pickId();
      if (id) await viewerSession(id);
      return;
    }
```
(Place this before the existing `if (mode === "events")` block. Leave `mixed` and `events` behavior as-is for backward-compatible manual load.)

- [ ] **Step 3: Rename the presets**

In `controlplane/src/index.ts`, replace the `PRESETS` map:
```ts
const PRESETS: Record<string, { rps: number; mode: "mixed" | "events" | "premiere" }> = {
  eveningPeak: { rps: 800, mode: "mixed" },
  trailerDrop: { rps: 1500, mode: "mixed" },
  // Episode premiere: a synchronized surge of viewers opening sessions on one
  // title. Outruns a single worker's beacon-processing capacity, so the queue
  // builds and the autoscaler scales up to drain it — while VST stays flat.
  episodePremiere: { rps: 2500, mode: "premiere" },
};
```
Update the log line in `/api/preset` if it names old presets (it uses `name` dynamically, so no change needed).

- [ ] **Step 4: Build the control-plane package**

Run: `cd controlplane && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify the premiere scenario end-to-end**

Run: `make up`, ensure the autoscaler is on, then trigger the premiere and watch:
```bash
curl -s -XPOST http://localhost:8080/api/autoscaler -H 'content-type: application/json' -d '{"enabled":true}'
curl -s -XPOST http://localhost:8080/api/preset -H 'content-type: application/json' -d '{"name":"episodePremiere"}'
for i in $(seq 1 12); do
  curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);const m=s.metrics;console.log(`vst_p95=${m.vstP95_ms}ms concurrent=${m.concurrentStreams} backlog=${m.backlog} rebuffer=${m.rebufferRatio}% workers=${s.workers}`)})'
  sleep 5
done
```
Expected: `concurrent` climbs into the hundreds+, `backlog` builds then drains, `workers` scales 1→up→back down, and **`vst_p95` stays under 100ms throughout**. Stop with `-d '{"name":"stop"}'`.

- [ ] **Step 6: Commit**

```bash
git add controlplane/src/load.ts controlplane/src/index.ts
git commit -m "Add streaming presets and client-fleet load generator (premiere)"
```

---

### Task 5: Console UI reskin

Relabels the Load Console into streaming vocabulary and wires the new tiles and preset buttons.

**Files:**
- Modify: `controlplane/public/index.html` (tiles, chart titles, preset buttons, header copy)
- Modify: `controlplane/public/app.js` (map new metric fields to tiles/charts)

**Interfaces:**
- Consumes: `/api/status` fields `metrics.vstP95_ms`, `metrics.concurrentStreams`, `metrics.rebufferRatio`, `metrics.playbackErrorRate`, `metrics.cacheHitRate`, `metrics.backlog`, `workers`.
- Produces: preset buttons with `data-preset="eveningPeak|trailerDrop|episodePremiere|stop"`.

- [ ] **Step 1: Reskin the tiles and header in index.html**

Replace the `<section class="tiles">` block with streaming tiles:
```html
  <section class="tiles">
    <div class="tile"><span class="label">VST p95 (SLO &lt;100ms)</span><span class="value" id="t-vst">–</span></div>
    <div class="tile"><span class="label">Concurrent streams</span><span class="value" id="t-concurrent">–</span></div>
    <div class="tile"><span class="label">Rebuffer ratio</span><span class="value" id="t-rebuffer">–</span></div>
    <div class="tile"><span class="label">Playback errors</span><span class="value" id="t-errors">–</span></div>
    <div class="tile"><span class="label">Beacon backlog</span><span class="value" id="t-backlog">–</span></div>
    <div class="tile"><span class="label">Active workers</span><span class="value" id="t-workers">–</span></div>
  </section>
```
Update the header sub-copy (line ~13) to: `Drive playback traffic, survive a premiere spike, watch it heal. Concept prototype — synthetic data.`

- [ ] **Step 2: Reskin the preset buttons and chart titles in index.html**

Replace the load `btn-row`:
```html
      <div class="btn-row">
        <button data-preset="eveningPeak">Evening peak</button>
        <button data-preset="trailerDrop">Trailer drop</button>
        <button data-preset="episodePremiere" class="warn">Episode premiere</button>
        <button data-preset="stop" class="ghost">Stop</button>
      </div>
```
Update the four chart `<h3>` titles to: `Concurrent streams`, `VST p95 (ms)`, `Beacon backlog`, `Active workers`.

- [ ] **Step 3: Map the new fields in app.js**

In `controlplane/public/app.js`:
- Change the series keys: `const series = { concurrent: [], vst: [], backlog: [], workers: [] };`
- Replace the tile-update block in `poll()`:
```js
  $("t-vst").textContent = m.vstP95_ms == null ? "–" : m.vstP95_ms + " ms";
  $("t-concurrent").textContent = m.concurrentStreams == null ? "–" : m.concurrentStreams.toLocaleString();
  $("t-rebuffer").textContent = m.rebufferRatio == null ? "–" : m.rebufferRatio + "%";
  $("t-errors").textContent = m.playbackErrorRate == null ? "–" : m.playbackErrorRate + "%";
  $("t-backlog").textContent = m.backlog == null ? "–" : m.backlog.toLocaleString();
  $("t-workers").textContent = s.workers < 0 ? "n/a" : s.workers;
  $("w-count").textContent = s.workers < 0 ? "–" : s.workers;
```
- Replace the `push`/`drawSpark` block:
```js
  push("concurrent", m.concurrentStreams || 0);
  push("vst", m.vstP95_ms || 0);
  push("backlog", m.backlog || 0);
  push("workers", s.workers < 0 ? 0 : s.workers);
  drawSpark($("c-rps"), series.concurrent, "#5b8cff");
  drawSpark($("c-p99"), series.vst, "#f5b445");
  drawSpark($("c-backlog"), series.backlog, "#f2555a");
  drawSpark($("c-workers"), series.workers, "#34d399");
```
(Canvas element ids `c-rps`/`c-p99` are reused as-is to avoid touching the HTML canvas ids; only their titles and data change.)

- [ ] **Step 4: Verify the Console renders streaming metrics live**

Run: `make up`, open `https://console.localhost`, click **Episode premiere**.
Expected: the VST tile stays green under 100 ms, Concurrent streams climbs, Rebuffer ratio shows a small %, Beacon backlog rises and drains, Active workers scales up then down. No `–` stuck tiles after ~20s of load.

- [ ] **Step 5: Commit**

```bash
git add controlplane/public/index.html controlplane/public/app.js
git commit -m "Reskin Load Console into streaming QoE vocabulary"
```

---

### Task 6: AI explainer reskin

Rewrites the AI explainer's prompt and rule-based fallback into streaming vocabulary, keeping the read-path vs beacon-backlog separation grounded in the SLO.

**Files:**
- Modify: `controlplane/src/explain.ts` (system prompt, prompt body, rule-based fallback)

**Interfaces:**
- Consumes: the extended `Snapshot` (Task 3) fields `vstP95_ms`, `concurrentStreams`, `rebufferRatio`, `playbackErrorRate`, `backlog`, `eventsPublished`, `eventsProcessed`.

- [ ] **Step 1: Rewrite the system prompt**

In `controlplane/src/explain.ts`, replace the system `content` string with:
```ts
              "You are an SRE watching a video streaming service. Explain in 2-4 plain-English sentences what the metrics show right now and what action, if any, would help. Ground every claim in the numbers; do not invent problems. Two separate concerns: (1) VIDEO START TIME (VST p95) is the playback-start path, kept fast by caching — its SLO is p95 < 100ms; only call it a problem if it exceeds 100ms. (2) The BEACON BACKLOG is the QoE telemetry write path; only say the pipeline is 'behind' if the backlog is large (say > 2000) or clearly growing, and note the autoscaler adds workers to drain it. Rebuffer ratio and playback error rate are viewer-experience signals aggregated from client beacons. If VST is under SLO and the backlog is low, state plainly that the service is healthy. Be concrete and calm. No preamble, no bullet points.",
```

- [ ] **Step 2: Rewrite the prompt body**

Replace the `prompt` assignment with streaming fields:
```ts
  const prompt =
    `Live metrics:\n` +
    `  VST p95: ${snap.vstP95_ms}ms (SLO < 100ms)\n` +
    `  concurrent streams: ${snap.concurrentStreams}\n` +
    `  rebuffer ratio: ${snap.rebufferRatio}%\n` +
    `  playback error rate: ${snap.playbackErrorRate}%\n` +
    `  cache hit rate: ${snap.cacheHitRate}%\n` +
    `  beacon backlog: ${snap.backlog}\n` +
    `  beacons published/s: ${snap.eventsPublished}, processed/s: ${snap.eventsProcessed}\n` +
    `  active workers: ${workers < 0 ? "unknown" : workers}\n\n` +
    `Recent events:\n${events || "(none)"}`;
```

- [ ] **Step 3: Rewrite the rule-based fallback**

Replace `ruleBasedExplain` with a streaming-grounded version:
```ts
function ruleBasedExplain(s: Snapshot, workers: number): string {
  const parts: string[] = [];
  const w = workers >= 0 ? `${workers} worker(s) active; ` : "";

  if (s.vstP95_ms != null && s.vstP95_ms > 100)
    parts.push(`Video Start Time is over SLO (p95 ${s.vstP95_ms}ms vs 100ms target) — the playback-start path needs cache warming or more read capacity.`);
  else if (s.vstP95_ms != null)
    parts.push(`Playback starts are fast (VST p95 ${s.vstP95_ms}ms, well under the 100ms SLO), served cache-first and independent of the telemetry pipeline.`);

  if (s.backlog != null && s.backlog > 2000)
    parts.push(`The QoE beacon pipeline is behind (${s.backlog.toLocaleString()} backlog) — ${w}the autoscaler is adding workers to drain it.`);
  else if (s.backlog != null && s.backlog > 500)
    parts.push(`A small beacon backlog is forming (${s.backlog}); ${w}the workers are roughly keeping pace.`);
  else
    parts.push(`The QoE beacon pipeline is healthy — the backlog is essentially empty and ${workers >= 0 ? `${workers} worker(s) are` : "the workers are"} keeping up.`);

  if (s.concurrentStreams != null)
    parts.push(`${s.concurrentStreams.toLocaleString()} concurrent streams right now.`);
  if (s.rebufferRatio != null && s.rebufferRatio > 2)
    parts.push(`Rebuffer ratio is ${s.rebufferRatio}% — worth watching for viewer-experience impact.`);

  return parts.join(" ");
}
```

- [ ] **Step 4: Build and verify the explainer**

Run: `cd controlplane && npx tsc --noEmit`, then `make up`, start the premiere preset, wait ~20s, and:
```bash
curl -s -XPOST http://localhost:8080/api/explain | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(r.source, "-", r.text)})'
```
Expected: text speaks in VST/beacon/concurrent-streams terms, correctly separating a healthy playback path from a temporarily-behind beacon pipeline. Works both with an OpenRouter key (source `ai`) and without (source `rule-based`).

- [ ] **Step 5: Commit**

```bash
git add controlplane/src/explain.ts
git commit -m "Reskin AI explainer into streaming QoE vocabulary"
```

---

### Task 7: Grafana dashboard + README + verification run

Relabels the Grafana dashboard to streaming panels, updates the README, and does the full verification run from the spec (capturing fresh screenshots).

**Files:**
- Modify: `observability/grafana/dashboards/streaming.json` (panel titles + a VST/concurrency/rebuffer panel set)
- Modify: `README.md` (streaming framing, endpoint table, scenario names)
- Modify: `docs/console.png`, `docs/dashboard.png` (re-captured under a premiere)

**Interfaces:**
- Consumes: metric names `http_request_duration_seconds_bucket{route="/playback/start"}`, `concurrent_streams`, `qoe_beacons_processed_total`, `qoe_beacons_published_total`, `cache_events_total`.

- [ ] **Step 1: Retitle and re-target the Grafana panels**

Read `observability/grafana/dashboards/streaming.json` first. Then:
- Dashboard `title`: `Streaming Discovery API` → `Streaming QoE`.
- Add a new stat/timeseries panel **"Video Start Time p95 (ms)"** with expr `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{route="/playback/start"}[30s])) by (le)) * 1000` and a threshold line at 100.
- Add **"Concurrent streams"** with expr `max(concurrent_streams)`.
- Retitle **"Engagement events: published vs processed (/s)"** → **"QoE beacons: published vs processed (/s)"** and update its two exprs to `qoe_beacons_published_total` / `qoe_beacons_processed_total`.
- Retitle **"RabbitMQ queue depth (engagement)"** → **"QoE beacon backlog"**.
- Add **"Rebuffer ratio (%)"** with expr `sum(rate(qoe_beacons_processed_total{type="rebuffer"}[30s])) / clamp_min(sum(rate(qoe_beacons_processed_total{type=~"play|progress|rebuffer"}[30s])), 1) * 100`.
- Leave the read-latency, request-rate, cache, and 5xx panels as-is (still valid).

- [ ] **Step 2: Verify the dashboard provisions and populates**

Run: `make up`, start the premiere preset, open `https://grafana.localhost` → **Streaming QoE**.
Expected: the VST p95 panel shows a line under the 100ms threshold; Concurrent streams and QoE beacon panels populate; no "No data" on the new panels after ~30s of load.

- [ ] **Step 3: Update the README**

In `README.md`:
- Title/intro: describe a video playback + QoE service.
- Endpoint mentions: replace `/events` with `/qoe/beacon`; add `POST /playback/start`.
- Preset names: Normal/Spike/Event storm → Evening peak / Trailer drop / Episode premiere.
- The Load Console bullets: reframe "self-healing autoscaler" around the premiere surge and VST holding under its 100ms SLO while the beacon pipeline autoscales.
- "What to look for under load": VST p95 < 100ms, concurrent streams, rebuffer ratio, beacon backlog draining.

- [ ] **Step 4: Full verification run (from the spec) + screenshots**

Perform the spec's verification sequence: clean start → Episode premiere → confirm concurrent streams spike, VST p95 under 100ms, backlog builds and drains, workers scale up and back down → worker-outage chaos recovers → explainer is accurate. Re-capture `docs/console.png` and `docs/dashboard.png` mid-premiere. Record the observed numbers in the commit message.

- [ ] **Step 5: Commit**

```bash
git add observability/grafana/dashboards/streaming.json README.md docs/console.png docs/dashboard.png
git commit -m "Reskin Grafana dashboard and README; verify premiere scenario end-to-end"
```

---

## Notes for the executor

- **Task 1 and Task 2 are coupled**: Task 1's `beacon.ts` imports `../lib/sessions` which Task 2 creates. Implement Task 2's `sessions.ts` before running Task 1's build step (or do Task 1 then Task 2 with a single build in between).
- **Always `make clean` the first time the queue is renamed** (Task 1 Step 9) so no stale `engagement` queue lingers in RabbitMQ.
- **`concurrent_streams` must be queried with `max()`**, never `sum()` — every API replica reports the same global value.
- **The VST SLO (p95 < 100ms) is the headline pass/fail line.** If any task run shows VST p95 climbing over 100ms under the premiere, stop and investigate before proceeding — that is the number the whole demo rests on.
- Keep the existing autoscaler, OTel/Jaeger, and tracing untouched. This is a surface + scenario reskin.
