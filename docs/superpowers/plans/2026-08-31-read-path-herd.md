# Read-Path Thundering Herd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Demonstrate the API (read) tier scaling horizontally behind a load balancer to hold Video Start Time under a synchronized playback-start thundering herd.

**Architecture:** Add an nginx load balancer that round-robins across API replicas via Docker DNS (per-request re-resolution). The control plane provisions/removes real API containers on demand (reusing the proven worker-provisioning pattern, with network alias `api` so the LB discovers them). A separate API-tier autoscaler scales the read tier on VST/read-load, independent of the untouched worker autoscaler. A per-instance saturation model + a playback-surge scenario make the read path genuinely stressable.

**Tech Stack:** Node/Fastify/TypeScript, dockerode, nginx, Redis/RabbitMQ/Postgres, Prometheus/Grafana, Docker Compose.

**Spec:** `docs/read-path-herd-design.md`
**Restore point:** git tag `demo-working-v2` (5737155) — if the feature can't be made solid, reset main here.

## Global Constraints

- **Do NOT break the existing demo.** Every task must verify the EXISTING Episode Premiere (beacon storm → worker scaling) still works, not just the new scenario. The worker autoscaler and its logic are UNTOUCHED.
- **Honesty:** VST is measured across API replicas; API instances are real containers; the per-instance saturation (`PLAYBACK_MAX_INFLIGHT` + `PLAYBACK_COST_MS`) is a LABELED simulation of a per-instance entitlement-concurrency limit — **async only, no CPU busy-loop** (unattended-run safe). Nothing invented.
- **Two autoscalers coexist:** worker tier scales on beacon backlog/utilization (existing); API tier scales on VST/read-load (new). They must not fight (different pools, different signals).
- VST SLO < 100ms remains the headline; the point is showing VST recover via API scale-out.
- `MIN_API=1`, `MAX_API=4`.
- No test framework — verify by running.

---

### Task 1: nginx load balancer + API-tier provision-on-demand (LINCHPIN — prove first)

Add an internal nginx LB that round-robins across API replicas via Docker DNS, route read traffic through it, and let the control plane provision/remove API containers on demand (discovered by the LB via network alias). This is the riskiest task — verify hard before anything else builds on it.

**Files:**
- Create: `lb/nginx.conf`
- Modify: `docker-compose.yml` (add `lb` service; remove `api` host port; route)
- Modify: `caddy/Caddyfile` (`api.localhost` → `lb`)
- Modify: `controlplane/src/config.ts` (`apiBase` default → `http://lb`; add `minApi`/`maxApi`)
- Modify: `controlplane/src/docker.ts` (generalize provisioning to an `api` pool with alias)
- Modify: `observability/prometheus.yml` (api via `dns_sd`)

**Interfaces:**
- Produces: `docker.setDesiredApiInstances(n): Promise<number>`, `docker.activeApiInstances(): Promise<number>`, `docker.apiWarming(): Promise<number>` — the API-tier equivalents of the worker functions. Worker functions unchanged.

- [ ] **Step 1: nginx LB config**

Create `lb/nginx.conf` — per-request DNS re-resolution so dynamically-added API containers are picked up with no reload:
```nginx
events {}
http {
  resolver 127.0.0.11 valid=1s ipv6=off;
  server {
    listen 80;
    location / {
      set $api_upstream "api:3000";
      proxy_pass http://$api_upstream;
      proxy_set_header Host $host;
      proxy_connect_timeout 2s;
      proxy_next_upstream error timeout http_502 http_503;
    }
  }
}
```

- [ ] **Step 2: compose — add lb, reroute, drop api host port**

In `docker-compose.yml`:
- Add:
```yaml
  lb:
    image: nginx:1.27-alpine
    volumes:
      - ./lb/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "3000:80"   # host :3000 now goes through the LB to an API replica
    depends_on:
      - api
```
- On the `api` service: REMOVE its `ports: ["3000:3000"]` block (multiple replicas can't share a host port; the LB fronts them now). Keep everything else.
- On the `controlplane` service env: add `API_BASE: http://lb`, `MIN_API: "1"`, `MAX_API: "4"`.

- [ ] **Step 3: Caddy → lb**

In `caddy/Caddyfile`, change the `api.localhost` reverse_proxy target from `api:3000` to `lb:80`.

- [ ] **Step 4: control-plane config**

In `controlplane/src/config.ts`: change `apiBase` default to `process.env.API_BASE ?? "http://lb"`, and add `minApi: Number(process.env.MIN_API ?? 1)`, `maxApi: Number(process.env.MAX_API ?? 4)`.

- [ ] **Step 5: generalize the Docker provisioning to an API pool**

In `controlplane/src/docker.ts`, generalize the existing worker create/remove/inspect logic to also manage the `api` service pool. Approach (derive the spec from a LIVE reference container, do not hardcode):
- Factor the container-management to be parameterized by service name (`worker` | `api`), OR add parallel `api`-specific functions that reuse the same clone logic. The existing WORKER functions and behavior must remain identical.
- `createInstance(service)`: clone from a live reference container of that service (`inspect()` → Image `streaming-app`, Env, Cmd, network). **CRITICAL for api:** set the created container's network alias to the service name (`api`) in `NetworkingConfig.EndpointsConfig[network].Aliases = ["api"]`, so Docker's embedded DNS returns it for `api` lookups and the LB discovers it. (Do this for workers too — harmless; they don't rely on it.) Apply the same partial-failure cleanup already in `createWorker` (remove a created-but-unstarted container).
- `setDesiredApiInstances(n)`: clamp to `[minApi, maxApi]`; create/remove `api` containers to match. Never remove below `minApi`. Reuse the stopped-container prune.
- `activeApiInstances()` / `apiWarming()`: running api containers (api has no cold-start delay unless added later, so "active" = running; keep an `apiWarming` that's 0 for now unless a cold-start is added). Return `-1` when docker unavailable (symmetric).
- Keep `referenceContainer()` working per-service (filter by the service label).

- [ ] **Step 6: Prometheus dns_sd for api**

In `observability/prometheus.yml`, change the `api` job to `dns_sd_configs` (names `["api"]`, type `A`, port `3000`) like the existing worker job, so all API replicas are scraped. VST/latency queries already aggregate with `sum(...) by (le)`, so multi-replica works.

- [ ] **Step 7: Build**

`cd controlplane && npx tsc --noEmit` — clean.

- [ ] **Step 8: VERIFY HARD (linchpin gate)**

```bash
make up   # clean start; note make up scales worker=5, api stays 1 (compose)
# a) LB works to the single api
curl -s http://localhost:3000/health   # via lb -> api
# b) provision API instances dynamically and confirm the LB distributes across ALL of them
curl -s -XPOST http://localhost:8080/api/apiscale -H 'content-type: application/json' -d '{"instances":3}' 2>/dev/null || echo "(apiscale endpoint is Task 3; for now drive setDesiredApiInstances via a one-off: docker compose exec controlplane node -e \"require('./dist/docker').setDesiredApiInstances(3).then(console.log)\")"
sleep 8
docker ps --filter "label=com.docker.compose.service=api" --format '{{.Names}}' | sort   # expect ~3 api containers
# hit the LB many times and confirm requests land on DIFFERENT replicas (e.g. add a header/hostname echo, or check each api container's logs shows traffic)
for i in $(seq 1 30); do curl -s http://localhost:3000/health >/dev/null; done
docker ps --filter "label=com.docker.compose.service=api" -q | while read id; do echo "$id: $(docker logs --since 30s $id 2>&1 | grep -c 'GET /health\|request')"; done
# c) existing premiere STILL works (worker tier)
curl -s -XPOST http://localhost:8080/api/preset -H 'content-type: application/json' -d '{"name":"episodePremiere"}'
sleep 20; curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);const m=s.metrics;console.log("workers="+s.workers,"backlog="+m.backlog,"vst="+m.vstP95_ms)})'
curl -s -XPOST http://localhost:8080/api/preset -H 'content-type: application/json' -d '{"name":"stop"}'
# d) scale api back to 1
docker compose exec controlplane node -e "require('./dist/docker').setDesiredApiInstances(1).then(console.log)"
```
Expected: LB serves via the single api; provisioning to 3 creates 3 api containers that the LB actually distributes across (traffic on multiple replicas); the existing premiere still scales workers and holds VST; scale-down removes api containers. **If the LB does not distribute across dynamically-created containers (DNS alias issue), debug it here — this is the make-or-break.** If it genuinely cannot work, report BLOCKED with findings.

- [ ] **Step 9: Commit**

```bash
git add lb/nginx.conf docker-compose.yml caddy/Caddyfile controlplane/src/config.ts controlplane/src/docker.ts observability/prometheus.yml
git commit -m "Add nginx LB and API-tier provision-on-demand (read tier scales behind the LB)"
```

---

### Task 2: Per-instance saturation model + playback-surge (thundering herd) scenario

Make the read path genuinely stressable (so scaling it matters), and add the thundering-herd load scenario.

**Files:**
- Modify: `api/src/config.ts` (`playbackCostMs`, `playbackMaxInflight`)
- Modify: `api/src/routes/playback.ts` (async entitlement delay + per-instance concurrency cap)
- Modify: `docker-compose.yml` (api env `PLAYBACK_COST_MS`, `PLAYBACK_MAX_INFLIGHT`)
- Modify: `controlplane/src/load.ts` (a `surge` mode: high-rate synchronized playback-starts)
- Modify: `controlplane/src/index.ts` (preset `playbackSurge`)

**Interfaces:**
- Produces: load mode `"surge"`; preset `playbackSurge`.

- [ ] **Step 1: config**

In `api/src/config.ts` add:
```ts
  // Simulated per-instance entitlement/license cost + concurrency cap, so one
  // API instance saturates at an achievable RPS and VST climbs past it (async
  // only — no CPU busy-loop). A labeled stand-in for a real entitlement path.
  playbackCostMs: Number(process.env.PLAYBACK_COST_MS ?? 0),
  playbackMaxInflight: Number(process.env.PLAYBACK_MAX_INFLIGHT ?? 0),
```

- [ ] **Step 2: saturation model in playback/start**

In `api/src/routes/playback.ts`, add a module-level in-flight counter and a small queue/wait so requests beyond `playbackMaxInflight` wait until a slot frees, and each held slot lasts `playbackCostMs` (async). Sketch:
```ts
let inflight = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (config.playbackMaxInflight <= 0) return; // disabled
  if (inflight >= config.playbackMaxInflight) {
    await new Promise<void>((r) => waiters.push(r));
  }
  inflight++;
}
function release() {
  if (config.playbackMaxInflight <= 0) return;
  inflight--;
  const next = waiters.shift();
  if (next) next();
}
```
In the handler, wrap the entitlement+session work: `await acquire();` then after the cache lookup, `if (config.playbackCostMs > 0) await new Promise(r => setTimeout(r, config.playbackCostMs));`, and `release()` in a finally. The queued wait is what makes VST climb when a single instance is overwhelmed. Keep the existing entitlement/session logic.

- [ ] **Step 3: compose env**

On the `api` service env, add `PLAYBACK_COST_MS: "10"` and `PLAYBACK_MAX_INFLIGHT: "20"` (≈ one instance caps ~2000 playback-starts/s; tune in Step 5). These apply to every api replica (compose + dynamically-provisioned clone the env).

- [ ] **Step 4: surge load mode + preset**

In `controlplane/src/load.ts`, add a `"surge"` mode that fires a high, synchronized rate of `POST /playback/start` on the premiere title (`titleIds[0]`) — the thundering herd. Fire-and-forget (don't await beacons; this scenario is about the read path). Respect `MAX_INFLIGHT`. In `controlplane/src/index.ts` PRESETS add `playbackSurge: { rps: 4000, mode: "surge" }` (4000 playback-starts/s — overwhelms one ~2000/s instance, forcing scale-out; tune in Step 5).

- [ ] **Step 5: build + verify the herd stresses one instance**

`cd api && npx tsc --noEmit && cd ../controlplane && npx tsc --noEmit`; `docker compose up -d --build`. Ensure api is at 1 instance. Run `playbackSurge` and watch VST climb:
```bash
docker compose exec controlplane node -e "require('./dist/docker').setDesiredApiInstances(1).then(console.log)"
curl -s -XPOST http://localhost:8080/api/preset -H 'content-type: application/json' -d '{"name":"playbackSurge"}'
for i in $(seq 1 8); do sleep 4; curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);const m=s.metrics;console.log("vst="+m.vstP95_ms+"ms rps="+m.rps)})'; done
curl -s -XPOST http://localhost:8080/api/preset -H 'content-type: application/json' -d '{"name":"stop"}'
```
Expected: with 1 API instance, VST climbs materially under the herd (well past 40ms, ideally toward/over 100ms) — proving the read path is genuinely stressed. **Tune** `rps` / `PLAYBACK_MAX_INFLIGHT` / `PLAYBACK_COST_MS` so: (a) 1 instance is clearly overwhelmed (VST high), and later (Task 3) ~3–4 instances hold VST < 100ms. Keep it async (CPU stays low). Also confirm the read path recovers when you manually scale api up (`setDesiredApiInstances(4)` mid-herd → VST drops).

- [ ] **Step 6: commit**

```bash
git add api/src/config.ts api/src/routes/playback.ts docker-compose.yml controlplane/src/load.ts controlplane/src/index.ts
git commit -m "Add per-instance saturation model and the playback-surge thundering-herd scenario"
```

---

### Task 3: API-tier autoscaler (scale the read tier on VST/read-load)

A separate autoscaler that scales the API pool to hold VST under the herd, independent of the worker autoscaler.

**Files:**
- Create: `controlplane/src/apiscaler.ts` (or extend `autoscaler.ts` with a clearly-separated API loop)
- Modify: `controlplane/src/config.ts` (thresholds)
- Modify: `controlplane/src/index.ts` (status fields + endpoints; start the API loop)

**Interfaces:**
- Produces: `setApiAutoscaler(on)`, `apiAutoscalerEnabled()`, `setDesiredApiInstances` wiring; `/api/status` fields `apiInstances`, `apiAutoscaler`, `readRps`; endpoints `POST /api/apiscale {instances}`, `POST /api/apiscaler {enabled}`.

- [ ] **Step 1: the API scaling loop**

Create `controlplane/src/apiscaler.ts` mirroring the worker autoscaler's structure but keyed on the READ signal:
- Scale UP when `vstP95_ms > VST_SCALE_UP_MS` (default 40) and `apiInstances < maxApi` (provision another API instance).
- Scale DOWN with hysteresis: when `vstP95_ms < VST_SCALE_DOWN_MS` (default 20) AND read RPS is low, and `apiInstances > minApi`, remove one — only after the surge subsides (use a publish/read-rate gate analogous to the worker scaler's, so it doesn't flap).
- Cooldown between actions (≥ 3s). Log human-readable reasons ("scale-up (read tier): VST 120ms > 40ms, provisioning API instance").
- Read RPS signal: `sum(rate(http_request_duration_seconds_count{route="/playback/start"}[15s]))` from Prometheus (add to metrics snapshot or query here).

- [ ] **Step 2: config**

In `controlplane/src/config.ts` add `vstScaleUpMs: Number(process.env.VST_SCALE_UP_MS ?? 40)`, `vstScaleDownMs: Number(process.env.VST_SCALE_DOWN_MS ?? 20)`. Add the compose envs on `controlplane` (`VST_SCALE_UP_MS: "40"`, `VST_SCALE_DOWN_MS: "20"`).

- [ ] **Step 3: endpoints + status + start the loop**

In `controlplane/src/index.ts`: import and start the API loop; add `/api/status` fields `apiInstances` (= `activeApiInstances()`), `apiAutoscaler`, `readRps`; add `POST /api/apiscale {instances}` (manual, clamps [minApi,maxApi], disables api-autoscaler) and `POST /api/apiscaler {enabled}`. Validate inputs (400 on bad) as the worker endpoints do.

- [ ] **Step 4: build + verify the read tier holds VST under the herd**

`cd controlplane && npx tsc --noEmit`; `docker compose up -d --build controlplane`. Enable the api-autoscaler, run the herd, watch the API tier scale and VST recover:
```bash
curl -s -XPOST http://localhost:8080/api/apiscaler -H 'content-type: application/json' -d '{"enabled":true}'
curl -s -XPOST http://localhost:8080/api/preset -H 'content-type: application/json' -d '{"name":"playbackSurge"}'
for i in $(seq 1 16); do sleep 5; curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);const m=s.metrics;console.log("apiInstances="+s.apiInstances+" vst="+m.vstP95_ms+"ms readRps="+s.readRps)})'; done
curl -s -XPOST http://localhost:8080/api/preset -H 'content-type: application/json' -d '{"name":"stop"}'
# confirm scale-down after
for i in $(seq 1 6); do sleep 5; curl -s http://localhost:8080/api/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log("apiInstances="+s.apiInstances+" vst="+s.metrics.vstP95_ms)})'; done
```
Expected: VST climbs, the API tier scales 1→N (up to maxApi), VST recovers under continued herd, then the tier scales back to 1 after the surge. Confirm the WORKER autoscaler still independently handles a beacon-storm premiere (run episodePremiere separately and confirm workers scale, api tier stays ~1 since reads are light). Capture VST-peak vs VST-after-scale.

- [ ] **Step 5: commit**

```bash
git add controlplane/src/apiscaler.ts controlplane/src/config.ts controlplane/src/index.ts
git commit -m "Add API-tier autoscaler: scale the read tier on VST to survive the thundering herd"
```

---

### Task 4: Console — read-tier readouts, playback-surge preset, self-explanatory

**Files:** `controlplane/public/index.html`, `app.js`, `style.css`.

- [ ] **Step 1:** Add tiles/readouts: **API instances** (`t-api`) and **Playback-start RPS** (`t-readrps`), reading `s.apiInstances` and `s.readRps`. Add a **Playback surge (thundering herd)** preset button (`data-preset="playbackSurge"`) and an **API autoscaler** toggle (`#apiscaler` → `/api/apiscaler`).
- [ ] **Step 2:** Self-explanatory: tile explanations (tooltip + subtitle) for API instances ("Read-tier API containers, provisioned on demand behind the load balancer") and Playback-start RPS. A `#note` entry for `playbackSurge`: "Everyone presses play at once when the episode drops. Watch VST climb as one API instance saturates, then recover as the read tier scales out." Extend the framing panel to mention the TWO tiers (read tier scales on VST; write/worker tier scales on backlog).
- [ ] **Step 3: verify** via `/browse` (or curl the served files): the new tiles move under the herd, the preset + toggle hit their endpoints, notes render, no console errors. Existing controls still work.
- [ ] **Step 4: commit** `git add controlplane/public/* && git commit -m "Console: read-tier readouts, playback-surge preset, two-tier self-explanatory copy"`

---

### Task 5: AI explainer + README

**Files:** `controlplane/src/explain.ts`, `README.md`.

- [ ] **Step 1:** In `explain.ts`, pass `apiInstances`, `readRps`, and VST into the prompt/fallback; extend the system prompt so it can narrate the READ-tier story ("VST rose because playback starts surged past one API instance's capacity; the read tier scaled to N to restore it") as distinct from the write/backlog story. Keep null-guards (`n()`), honesty (per-instance saturation labeled simulated), grounding.
- [ ] **Step 2:** In `README.md`, add a "Read-path thundering herd" section: the two-tier scaling story (read tier on VST behind the LB; write tier on backlog), the honesty framing (simulated per-instance saturation, real containers/LB), the ECS mapping (API tier → ECS service desired-count; herd → real premiere), and the measured numbers from Task 6.
- [ ] **Step 3: build + verify** the explainer narrates the read-tier scaling under a live herd (quote output; idle clean); README reads correctly.
- [ ] **Step 4: commit** `git add controlplane/src/explain.ts README.md && git commit -m "Explainer + README: two-tier scaling and the read-path thundering herd"`

---

### Task 6: Full verification + screenshots

**Files:** `docs/console.png`, `docs/dashboard.png`, (README number updates if needed).

- [ ] **Step 1: full end-to-end run**, recorded: (a) herd on 1 API instance → VST climbs; (b) api-autoscaler scales the read tier → VST recovers under continued herd → scales down after; (c) the EXISTING episodePremiere (beacon storm) still scales workers and holds VST, api tier stays ~1; (d) if stable, a combined run (herd + beacon storm) where BOTH tiers scale; (e) worker-outage chaos still recovers. Capture VST-peak vs VST-after-scale and the api-instance counts.
- [ ] **Step 2:** Re-capture `docs/console.png` (showing API instances + playback-surge + the herd) and `docs/dashboard.png` via `/browse`. If unavailable, say so; don't fabricate.
- [ ] **Step 3: commit** `git add docs/console.png docs/dashboard.png README.md && git commit -m "Verify read-path thundering herd end-to-end; refresh screenshots"`

---

## Notes for the executor
- **Task 1 is make-or-break.** If nginx can't distribute across dynamically-provisioned API containers (DNS alias), debug it there; if truly impossible, report BLOCKED — do not build Tasks 2–6 on a broken LB.
- **Never break the existing premiere** — verify it each task.
- **Keep the saturation model async** (no CPU busy-loop) — this runs unattended on the user's laptop.
- Two autoscalers, two pools, two signals — keep them cleanly separated so they don't fight.
