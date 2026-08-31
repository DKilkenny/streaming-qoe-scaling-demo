# Intelligent Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add layered, production-shaped autoscaling (provision-on-demand + cold-start + proactive/predictive strategies) and make the demo self-explanatory.

**Architecture:** The control plane provisions real worker containers on demand via the Docker API (replacing the fragile warm pool); new workers cold-start (a simulated provisioning delay) before consuming; the autoscaler scales proactively on utilization (getting ahead of the backlog) with a reactive fallback and an operator pre-warm floor; the Console surfaces the strategy, utilization, and warming state, and explains itself so a viewer with no context can follow along.

**Tech Stack:** Node/Fastify/TypeScript (CommonJS), dockerode, Redis, RabbitMQ, Postgres, prom-client, Docker Compose. Dependency-free Console front-end.

**Spec:** `docs/intelligent-scaling-design.md`

## Global Constraints

- **Honesty:** utilization = `publishRate / (active × WORKER_CAPACITY)` where `WORKER_CAPACITY` is the MEASURED per-worker throughput (~550/s). Cold-start is a labeled simulated provisioning delay. Worker provisioning uses real Docker containers. Never invent numbers.
- **Robustness (the reason provision-on-demand exists):** after a bare `docker compose up -d --build` collapses the compose-managed worker count, the control plane MUST still scale correctly — because it creates its own containers, not relying on pre-stopped ones.
- **Preserve the reskin invariants:** VST p95 < 100ms through the premiere; QoE metrics/endpoints unchanged; scale-down keeps the publish-rate hysteresis (no flapping); beacon types exactly play/progress/complete/rebuffer/error.
- **`minWorkers` (1) always runs.** `maxWorkers` (5) is the ceiling.
- **No test framework** — verification is running the stack and observing (curl, `/api/status`, `/browse`).
- **Self-explanatory is a first-class requirement,** not polish (Task 4).
- Commit after each task.

---

### Task 1: Provision-on-demand Docker layer + cold-start delay

Replaces the warm-pool model with real create/remove of worker containers via the Docker API, and adds a simulated cold-start delay so new workers take time to become active. This is the foundation and the riskiest task — verify it hard, including the robustness test.

**Files:**
- Modify: `api/src/config.ts` (add `workerColdStartMs`)
- Modify: `api/src/worker.ts` (sleep `workerColdStartMs` before opening the consumer)
- Modify: `docker-compose.yml` (worker env `WORKER_COLDSTART_MS`; controlplane env `WORKER_COLDSTART_MS`, `WORKER_CAPACITY`)
- Modify: `controlplane/src/config.ts` (add `workerColdStartMs`, `workerCapacity`)
- Modify: `controlplane/src/docker.ts` (create/remove containers; `workersWarming`)

**Interfaces:**
- Produces:
  - `config.workerColdStartMs` (api) and `config.workerColdStartMs`/`config.workerCapacity` (controlplane)
  - `docker.setDesiredWorkers(n)` now CREATES containers to grow and REMOVES to shrink
  - `docker.workersWarming(): Promise<number>` — containers started within the cold-start window (not yet consuming)
  - `docker.activeWorkers()` — running containers past their cold-start window (actually consuming)

- [ ] **Step 1: Add the cold-start config (api) and worker boot delay**

In `api/src/config.ts` add:
```ts
  // Simulated provisioning/init time: a newly started worker waits this long
  // before opening its consumer, modeling an ECS/Fargate task cold start.
  workerColdStartMs: Number(process.env.WORKER_COLDSTART_MS ?? 0),
```
In `api/src/worker.ts` `startWorker()`, after the SIGTERM handler and before `await consumeForever()`, add:
```ts
  if (config.workerColdStartMs > 0) {
    // eslint-disable-next-line no-console
    console.log(`[worker] cold start: warming up for ${config.workerColdStartMs}ms before consuming`);
    await new Promise((r) => setTimeout(r, config.workerColdStartMs));
  }
```
(The metrics server still starts immediately; only consumption is delayed. SIGTERM still exits promptly.)

- [ ] **Step 2: Wire the env vars in compose**

In `docker-compose.yml`:
- Under the `worker` service `environment`, add `WORKER_COLDSTART_MS: "12000"`.
- Under the `controlplane` service `environment`, add `WORKER_COLDSTART_MS: "12000"` and `WORKER_CAPACITY: "550"`.

- [ ] **Step 3: Add control-plane config**

In `controlplane/src/config.ts` add:
```ts
  // Cold-start window used to classify a worker as "warming" vs "active".
  workerColdStartMs: Number(process.env.WORKER_COLDSTART_MS ?? 12000),
  // Measured steady-state per-worker beacon throughput, for the utilization signal.
  workerCapacity: Number(process.env.WORKER_CAPACITY ?? 550),
```

- [ ] **Step 4: Rewrite the Docker layer for provision-on-demand**

In `controlplane/src/docker.ts`, replace the start/stop pool logic with create/remove. Approach (the implementer must derive the exact container spec by inspecting a live reference worker — do NOT hardcode a guessed spec):

1. `referenceWorker()`: pick any existing container with the compose worker labels; `docker.getContainer(id).inspect()` to get its `Config` (Image, Env, Labels, Cmd, WorkingDir) and `HostConfig`, and its network name from `NetworkSettings.Networks`.
2. `createWorker()`: `docker.createContainer({...})` cloning the reference — same `Image` (`streaming-app`), same `Env` (so DATABASE_URL/RABBITMQ_URL/ROLE=worker/WORKER_*/OTEL_* all match), the compose labels (`com.docker.compose.project`, `com.docker.compose.service=worker`, and a unique `com.docker.compose.container-number`), attached to the same compose network (via `HostConfig.NetworkMode` or `NetworkingConfig.EndpointsConfig`), with a unique name like `angel-streaming-demo-worker-dyn-<ts>`. Then `.start()`. Return the id.
3. `removeWorker(id)`: `.stop({t:3})` then `.remove({force:true})`, ignoring errors.
4. `setDesiredWorkers(desired)`: clamp to [minWorkers, maxWorkers]. Count current containers. If short, `createWorker()` the difference (in parallel). If over, `removeWorker()` the newest extras (keep the oldest / the compose-created `minWorkers`). Never remove below `minWorkers`. Return the new count.
5. `activeWorkers()`: running containers whose `State.StartedAt` is older than `workerColdStartMs` (past cold start = consuming). `workersWarming()`: running containers whose `StartedAt` is within `workerColdStartMs` (still warming).
6. `injectOutage()`: stop all worker containers (keep the outage semantics — real recovery when they restart/are recreated).
7. `initPool()`: reconcile to `minWorkers`, creating one if none exist. Must NOT depend on pre-stopped containers.

Keep `isDockerAvailable()` and the `dockerAvailable` guard behavior.

- [ ] **Step 5: Build**

Run: `cd api && npx tsc --noEmit && cd ../controlplane && npx tsc --noEmit` — clean.

- [ ] **Step 6: Verify provisioning, cold-start, and ROBUSTNESS**

```bash
make up   # clean start
# a) scale up creates a container that warms up then consumes
curl -s -XPOST http://localhost:8080/api/scale -H 'content-type: application/json' -d '{"workers":3}'
sleep 3;  curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log("active="+s.workers,"warming="+s.workersWarming,"pool="+s.poolSize)})'   # expect warming>0, active still low
sleep 12; curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log("active="+s.workers,"warming="+s.workersWarming)})'   # expect active caught up, warming 0
# b) ROBUSTNESS: collapse the compose pool, confirm scaling still works
docker compose up -d --build   # reconciles compose worker count; control plane must not care
curl -s -XPOST http://localhost:8080/api/scale -H 'content-type: application/json' -d '{"workers":4}'
sleep 15; curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log("active="+s.workers)})'   # expect ~4 (control plane created its own)
# c) scale down removes containers
curl -s -XPOST http://localhost:8080/api/scale -H 'content-type: application/json' -d '{"workers":1}'
sleep 5; docker ps --filter "label=com.docker.compose.service=worker" -q | wc -l   # expect ~1 running
```
Expected: warming→active transition visible over ~12s; robustness test scales to ~4 even after a compose collapse; scale-down removes containers. If container creation fails, debug the clone spec (network/labels) — don't leave it broken.

- [ ] **Step 7: Commit**

```bash
git add api/src/config.ts api/src/worker.ts docker-compose.yml controlplane/src/config.ts controlplane/src/docker.ts
git commit -m "Provision workers on demand via Docker API with a simulated cold-start delay"
```

---

### Task 2: Autoscaler strategies (proactive/reactive) + utilization + pre-warm

Adds the utilization-based proactive strategy, a reactive/proactive switch, and an operator pre-warm floor, and exposes utilization + warming + strategy on `/api/status`.

**Files:**
- Modify: `controlplane/src/autoscaler.ts` (strategy, utilization, pre-warm)
- Modify: `controlplane/src/metrics.ts` (add `utilization`, `workersWarming` to the snapshot)
- Modify: `controlplane/src/index.ts` (endpoints `/api/strategy`, `/api/prewarm`; status fields)

**Interfaces:**
- Consumes: `config.workerCapacity`, `docker.workersWarming`, `setDesiredWorkers`.
- Produces:
  - `autoscaler.setStrategy("reactive"|"proactive")`, `autoscaler.getStrategy()`
  - `autoscaler.setPrewarm(n)`, `autoscaler.getPrewarm()` (effective floor)
  - `Snapshot.utilization` (0–1, rounded to %), and `/api/status` fields `strategy`, `prewarm`, `workersWarming`, `utilization`.

- [ ] **Step 1: Add strategy + pre-warm state and the utilization signal to the autoscaler**

In `controlplane/src/autoscaler.ts`:
- Add module state: `let strategy: "reactive" | "proactive" = "proactive";` and `let prewarm = 0;` with getters/setters (`setStrategy`, `getStrategy`, `setPrewarm`, `getPrewarm`).
- In `tick()`, after reading `snap` and `active`, compute the effective floor and utilization:
```ts
const floor = Math.max(config.minWorkers, prewarm);
const capacity = Math.max(1, active) * config.workerCapacity;
const utilization = (snap.eventsPublished ?? 0) / capacity;
```
- **Pre-warm floor:** if `active < floor`, scale up toward `floor` first (provision ahead of the surge) and return.
- **Scale-up:** in `proactive` mode, scale up when `utilization > 0.75 && active < maxWorkers` (proportional jump for large gaps, like the reskin's backlog jump but keyed off how far over 0.75). ALSO keep the reactive backlog safety net (`backlog > scaleUpBacklog`). In `reactive` mode, scale up ONLY on the backlog threshold.
- **Scale-down:** unchanged from the reskin — only when `backlog < scaleDownBacklog && eventsPublished < scaleDownPublishRate && active > floor` (note: floor, not minWorkers, so pre-warm holds capacity).
- Log human-readable reasons (used by the Console feed), e.g. `scale-up (proactive): utilization 78% > 75%, provisioning worker (warming ~12s)`.

- [ ] **Step 2: Add utilization + warming to the metrics snapshot**

In `controlplane/src/metrics.ts` `metricsSnapshot()`, add a computed `utilization` if you have publish-rate + an active-worker count available here; if worker count isn't available in this module, compute utilization in `index.ts`'s `/api/status` instead (where `activeWorkers()` is already called) and leave the snapshot as-is. Prefer computing it in `/api/status` to avoid a Prometheus round-trip. Expose it as a percentage (0–100) rounded.

- [ ] **Step 3: Add endpoints and status fields**

In `controlplane/src/index.ts`:
- `/api/status` returns additionally: `strategy: autoscaler.getStrategy()`, `prewarm: autoscaler.getPrewarm()`, `workersWarming: await workersWarming()`, and `utilization` (computed: `Math.round(100 * (snap.eventsPublished ?? 0) / Math.max(1, workers*config.workerCapacity))`).
- `POST /api/strategy` body `{strategy}` → `setStrategy`, logEvent.
- `POST /api/prewarm` body `{workers}` (0 clears) → `setPrewarm`, logEvent (`pre-warmed to N workers ahead of a surge` / `pre-warm cleared`).
- Manual `/api/scale` still disables the autoscaler as today.

- [ ] **Step 4: Build**

Run: `cd controlplane && npx tsc --noEmit` — clean.

- [ ] **Step 5: Verify strategy contrast + pre-warm**

```bash
docker compose up -d --build controlplane
# proactive: workers ramp on utilization BEFORE backlog builds
curl -s -XPOST http://localhost:8080/api/strategy -d '{"strategy":"proactive"}' -H 'content-type: application/json'
curl -s -XPOST http://localhost:8080/api/autoscaler -d '{"enabled":true}' -H 'content-type: application/json'
curl -s -XPOST http://localhost:8080/api/preset -d '{"name":"episodePremiere"}' -H 'content-type: application/json'
for i in $(seq 1 14); do sleep 5; curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);const m=s.metrics;console.log("util="+s.utilization+"% active="+s.workers+" warming="+s.workersWarming+" backlog="+m.backlog+" vst="+m.vstP95_ms)})'; done
curl -s -XPOST http://localhost:8080/api/preset -d '{"name":"stop"}' -H 'content-type: application/json'
# then repeat with strategy=reactive and compare peak backlog; and test pre-warm:
curl -s -XPOST http://localhost:8080/api/prewarm -d '{"workers":4}' -H 'content-type: application/json'   # provisions to 4 ahead of time
```
Expected: proactive keeps peak backlog materially lower than reactive; utilization drives scale-up before the backlog threshold; pre-warm provisions to the floor and holds; VST < 100ms throughout; scale-down still clean (no flap). Capture the proactive vs reactive peak-backlog numbers.

- [ ] **Step 6: Commit**

```bash
git add controlplane/src/autoscaler.ts controlplane/src/metrics.ts controlplane/src/index.ts
git commit -m "Add proactive utilization scaling, reactive/proactive strategy switch, and pre-warm floor"
```

---

### Task 3: Console — strategy selector, pre-warm, utilization + warming tiles

Surfaces the new controls and readouts in the Load Console.

**Files:**
- Modify: `controlplane/public/index.html`
- Modify: `controlplane/public/app.js`

**Interfaces:**
- Consumes `/api/status` fields `strategy`, `prewarm`, `workersWarming`, `utilization`; posts to `/api/strategy`, `/api/prewarm`.

- [ ] **Step 1: Add controls + tiles to index.html**

- Add a **Utilization** tile (`t-util`) and change the workers tile to show active + warming (e.g. `t-workers` shows `5 (+2 warming)`), or add a `t-warming` tile.
- In the controls panel, add a **Scaling strategy** segmented control: two buttons `data-strategy="reactive"` / `data-strategy="proactive"` (show which is active), and a **Pre-warm for premiere** button (`id="prewarm"`) plus a **Clear pre-warm** affordance.

- [ ] **Step 2: Wire them in app.js**

- In `poll()`, set the utilization tile (`s.utilization + "%"`), and the workers tile to show `s.workers + (s.workersWarming ? ` (+${s.workersWarming} warming)` : "")`. Reflect the active `strategy` on the segmented control, and the pre-warm state.
- Add listeners: strategy buttons → `post("/api/strategy", {strategy})`; pre-warm → `post("/api/prewarm", {workers: 4})`; clear → `post("/api/prewarm", {workers: 0})`.

- [ ] **Step 3: Verify**

`docker compose up -d --build controlplane`; curl the served HTML/JS to confirm the new ids/handlers; drive a premiere and confirm the utilization tile moves, the warming count appears during scale-up, and the strategy/pre-warm buttons hit their endpoints (check the activity feed). If `/browse` is available, click through them.

- [ ] **Step 4: Commit**

```bash
git add controlplane/public/index.html controlplane/public/app.js
git commit -m "Console: strategy selector, pre-warm, utilization and warming readouts"
```

---

### Task 4: Console self-explanatory layer

Make the demo teach as it runs, so a viewer with no context understands what they're seeing. This is a first-class requirement from the spec, not polish.

**Files:**
- Modify: `controlplane/public/index.html`
- Modify: `controlplane/public/app.js`
- Modify: `controlplane/public/style.css`

- [ ] **Step 1: Framing panel**

Add a collapsible panel at the top of the Console: 3–4 plain sentences on what the system is (a video playback + QoE service), the read-path-vs-write-path decoupling (why VST stays fast while the beacon pipeline scales), and the honesty note (measured vs simulated). Collapsed state remembered in `localStorage` (guarded in try/catch).

- [ ] **Step 2: Tile explanations**

Give every metric tile a one-line plain-English explanation of what it measures and its honest source, as a `title=` tooltip AND a small subtitle line under the value. Cover: VST p95, Concurrent streams, Rebuffer ratio, Playback errors, Beacon backlog, Active workers (+warming), Utilization. Example — VST: "Time to authorize a playback session. Kept fast by cache, independent of the write pipeline. SLO < 100ms."

- [ ] **Step 3: Scenario + strategy "what to watch" notes**

When a preset or strategy is selected, show a short contextual note (a dedicated `#note` region). Examples:
- Episode premiere: "Simulating a synchronized viewer surge (an episode drop). Watch: reads stay fast (VST) while the beacon backlog builds and the autoscaler provisions workers."
- Proactive: "Scales on utilization — provisions the next worker at ~75% load, before the backlog builds. New workers cold-start (~12s), so getting ahead matters."
- Pre-warm: "Capacity raised ahead of a known surge (premieres are scheduled). Watch the premiere barely move the backlog."

- [ ] **Step 4: Human-readable activity feed**

Ensure the feed renders the autoscaler's human-readable reasons (from Task 2's log lines) clearly — utilization/provisioning/warming/pre-warm/scale-down events read as sentences, not terse logs. (The `logEvent` detail strings carry the text; make sure the feed shows them with their kind and time.)

- [ ] **Step 5: Verify (naive-viewer test)**

`docker compose up -d --build controlplane`. If `/browse` is available, open the Console fresh and confirm: the framing panel reads clearly; hovering/looking at each tile explains it; selecting Episode premiere and flipping strategies shows the notes; the feed reads in plain English during a premiere. The bar: someone who has never seen this could describe what Episode Premiere does and why workers changed, from the on-screen text alone.

- [ ] **Step 6: Commit**

```bash
git add controlplane/public/index.html controlplane/public/app.js controlplane/public/style.css
git commit -m "Console self-explanatory layer: framing panel, tile explanations, scenario notes, readable feed"
```

---

### Task 5: AI explainer — narrate the scaling decision

Update the explainer to reference utilization, the active strategy, and workers warming, so it explains *why* it scaled when it did.

**Files:**
- Modify: `controlplane/src/explain.ts`

- [ ] **Step 1: Add the new signals to the prompt + fallback**

In `controlplane/src/explain.ts`:
- Pass `utilization`, `strategy`, `workersWarming` into the prompt body (guard nulls with the existing `n()` helper) and fetch them alongside the snapshot (from `/api/status`-equivalent calls or by importing the getters).
- Extend the system prompt: explain that proactive scaling provisions capacity on rising utilization *before* the backlog builds, that new workers cold-start (~12s) so there's a lead time, and that pre-warm raises the floor for known surges. Keep the VST-vs-backlog separation and the honesty grounding.
- Extend `ruleBasedExplain` to mention utilization and warming when relevant (e.g. "Utilization is 82%; the proactive scaler is provisioning capacity — 2 workers warming up (~12s)").

- [ ] **Step 2: Build + verify**

`cd controlplane && npx tsc --noEmit`; `docker compose up -d --build controlplane`; drive a premiere and `POST /api/explain` mid-ramp → confirm it explains the scaling decision in utilization/strategy/warming terms and stays grounded. Check idle stays clean (no null/NaN — the `n()` guard).

- [ ] **Step 3: Commit**

```bash
git add controlplane/src/explain.ts
git commit -m "AI explainer: narrate proactive/predictive scaling (utilization, cold-start, pre-warm)"
```

---

### Task 6: README + full verification + screenshots

Document the intelligent-scaling story and run the end-to-end verification, including the three-way contrast and the robustness test.

**Files:**
- Modify: `README.md`
- Modify: `docs/console.png`, `docs/dashboard.png`

- [ ] **Step 1: README "Intelligent scaling" section**

Add a section covering: provision-on-demand (Docker API now, ECS/Fargate in Phase 2), the simulated cold-start and why it makes lead time matter, the three strategies (reactive/proactive/pre-warm) with the contrast to run, and the honesty framing (utilization from measured rates, per-worker capacity is measured, cold-start is a labeled sim). Note the robustness win (no warm-pool fragility). Use the measured numbers from Step 2.

- [ ] **Step 2: Full verification run**

Perform and record: (a) robustness test (compose collapse → still scales); (b) cold-start visible (warming→active over ~12s); (c) reactive vs proactive same premiere — capture both peak-backlog numbers and confirm proactive is materially lower with VST < 100ms in both; (d) pre-warm premiere vs cold premiere; (e) scale-down clean (containers removed, no flap); (f) worker-outage recovery still works. Re-capture `docs/console.png` (showing utilization, warming, strategy selector, a scenario note) and `docs/dashboard.png` via `/browse`.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/console.png docs/dashboard.png
git commit -m "Document intelligent scaling; verify provisioning, cold-start, strategy contrast, and pre-warm end-to-end"
```

---

## Notes for the executor

- **Task 1 is the linchpin and the riskiest.** Get provision-on-demand rock-solid (including the robustness test) before building Tasks 2–6 on it. If cloning the container spec is flaky, debug the network/labels/env from a live `docker inspect` of a running worker — do not ship a half-working provisioner.
- **Cold-start makes the story work.** If `WORKER_COLDSTART_MS` is 0, proactive and reactive look identical — keep the ~12s default.
- **Preserve VST < 100ms and the no-flap scale-down** from the reskin through every task.
- **Self-explanatory (Task 4) is a requirement,** judged by the naive-viewer bar, not a nice-to-have.
