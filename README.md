# Streaming QoE

A video playback and quality-of-experience (QoE) service, built to demonstrate
scalability and resilience under real load — the kind a video start, a trending
episode, or a premiere-night surge puts on a streaming backend. Independent
concept prototype by Danny Kilkenny — synthetic data, not affiliated with any
company.

> The point of this repo is honesty: it produces **measured** numbers (video
> start time p95, concurrent streams, rebuffer ratio, beacon backlog) under real
> load, in a real stack, not a simulation with invented figures. See
> [DESIGN.md](./DESIGN.md).

## Stack

Node.js · Fastify · TypeScript · Redis · RabbitMQ · Postgres · OpenTelemetry ·
Prometheus · Grafana · Jaeger · Caddy · Docker · k6 · OpenRouter (AI explainer)

The AI explainer is optional. To enable it: `cp .env.example .env` and set
`OPENROUTER_API_KEY` (model configurable via `OPENROUTER_MODEL`). Without a key it
falls back to a deterministic rule-based explanation, so nothing breaks.

## Run it (one command)

Requires Docker. From the repo root:

```bash
make up          # build, start the stack, wait for health, seed the catalog
```

Then open the **Load Console** at **https://console.localhost** and drive it from the browser.

![Load Console](docs/console.png)

### The Load Console

An interactive control room for the system:

- **Drive real load** — a traffic dial and presets (Evening peak / Trailer drop / Episode premiere). Clicks hit a load-generator service that puts real HTTP load on `POST /playback/start` and `POST /qoe/beacon`.
- **Self-healing autoscaler** — toggle it on and hit **Episode premiere**: concurrent streams surge toward ~15,000, and the QoE beacon pipeline (one worker can't keep up — each beacon does simulated downstream processing, so per-worker throughput is bounded the way a real telemetry pipeline is) backs up into a multi-thousand-message backlog. The autoscaler scales workers up (1 → 5) to drain it, holds flat while the surge is sustained, then scales back down after. Through all of it, **video start time (VST) p95 stays under its 100ms SLO** — playback is decoupled from the beacon write pipeline, so a backed-up telemetry queue never slows down a stream starting. **Simulate worker outage** shows the same recovery from a hard failure: workers drop to zero, the backlog spikes, and the autoscaler brings it back down once workers return, with VST unaffected throughout.
- **Live distributed tracing** — API and worker are OpenTelemetry-instrumented; one click opens the trace waterfall (HTTP → Redis → RabbitMQ → Postgres) in **Jaeger**.
- **AI incident explainer** — reads the live metrics and event log and writes a plain-English "what's happening" via OpenRouter (falls back to a deterministic reading with no API key). Under a worker outage it correctly separates a healthy VST from a beacon pipeline that's fallen behind.
- Live sparklines and a color-coded activity feed, all dependency-free.

Prefer the command line? `make load` runs a containerized k6 ramp instead.

Watch the raw telemetry at **https://grafana.localhost** (Grafana → "Streaming QoE").

| Service | HTTPS (Caddy + mkcert) | Plain HTTP |
|---|---|---|
| Load Console | https://console.localhost | http://localhost:8080 |
| Grafana | https://grafana.localhost | http://localhost:3001 |
| Jaeger (traces) | https://jaeger.localhost | http://localhost:16686 |
| Playback API | https://api.localhost/playback/start | http://localhost:3000/playback/start |
| QoE beacons | https://api.localhost/qoe/beacon | http://localhost:3000/qoe/beacon |
| Prometheus | https://prometheus.localhost | http://localhost:9090 |
| RabbitMQ UI | — | http://localhost:15673 (streaming / streaming) |

Tear down with `make down` (keeps data) or `make clean` (wipes it).

### HTTPS with a trusted cert

The stack terminates TLS in a Caddy reverse proxy using a locally-trusted
certificate from [mkcert](https://github.com/FiloSottile/mkcert), so browsers
that force HTTPS on `localhost` get a green lock instead of a warning. `make up`
generates the cert automatically. One-time setup on a new machine:

```bash
brew install mkcert   # or your platform's package
mkcert -install       # trust the local CA (asks for your password once)
```

The `*.localhost` hostnames resolve to loopback automatically in modern browsers;
no `/etc/hosts` edits needed. Certs live in `caddy/certs/` and are gitignored.

## What to look for under load

- **Video start time (VST) p95 stays under 100ms** — the headline SLO. Under an
  Episode Premiere surge (~700 new viewer sessions/s, ~15,000 concurrent
  streams) it holds in the 10–25ms range the whole time; measured, not
  simulated.
- **Concurrent streams** climbs from 0 toward ~15,000 as the premiere ramps and
  holds there for the duration of the surge (tracked from real session state,
  queried with `max()` since every API replica reports the same global value).
- **Rebuffer ratio** settles around 3–4% under sustained load, computed from
  the actual mix of QoE beacon types the worker processes.
- **Beacon backlog** rises when the surge outpaces one worker, then drains as
  the autoscaler scales workers 1 → 5 and holds flat under sustained load —
  visible backpressure, not a hidden failure. A worker-outage chaos test
  (**Simulate worker outage** in the console) drives the same recovery from a
  hard failure, typically clearing a 10–15k backlog within ~30–40s of workers
  coming back.
- **Read latency** (discover/detail/search) stays low and flat throughout —
  it's cache-first in Redis and fully decoupled from the beacon pipeline.
- **Scale the API out** and watch p99 recover:
  ```bash
  docker compose up -d --scale api=4 --no-recreate
  ```

## Intelligent scaling

The autoscaler doesn't just add worker *replicas* to an existing pool — the
control plane **provisions worker containers on demand** via the Docker API
(`controlplane/src/docker.ts`), the same pattern a Fargate control plane uses
to call `RunTask`/`UpdateService`. In Phase 2 that call swaps to the AWS SDK;
the control-plane logic (desired count in, containers/tasks out) doesn't
change. This also makes the demo robust in a way a compose-scaled pool isn't:
run a bare `docker compose up -d --build` mid-demo (which recreates and
renames whatever container compose thinks is the `worker` service, collapsing
its tracked replica count back to 1) and the control plane keeps working —
it queries Docker directly for containers matching its own labels, so it
still scales the pool up to `maxWorkers` on the next premiere. No warm-pool
fragility to explain away.

**The cold-start is a labeled simulation**, not a real Fargate cold start —
`WORKER_COLDSTART_MS` (12s) models the *shape* of provisioning delay (real
Fargate is more like 30–90s; the demo compresses it to a watchable timescale).
It's called out as simulated everywhere it surfaces: the console's "warming"
readout, the AI explainer's narration, and the activity feed. What's real is
what it implies: a freshly created container is not capacity yet. Utilization
(`measured beacon publish rate / measured per-worker capacity`) and the
backlog are both live numbers from the running stack — only the delay between
"decided to scale" and "capacity delivered" is simulated, and that delay is
exactly what makes *when* you decide to scale matter.

That's the reason for three scaling strategies, selectable from the console:

- **Reactive** — scale up once the backlog crosses a threshold. Simple, but
  during the ~12s a new worker is warming, the backlog keeps growing.
- **Proactive** — scale up once utilization crosses 75%, *before* the backlog
  has built. Gets a worker's 12s of lead time back.
- **Pre-warm** — hold extra capacity ready ahead of a known event (a
  scheduled premiere), so there's no cold-start lead time to lose at all.

Run the same `Episode premiere` scenario under each and the difference is the
demo's core claim, measured end-to-end against the live stack (not asserted):

| Strategy | Peak beacon backlog | VST p95 |
|---|---|---|
| Reactive | ~25,000 | 9.8–20.7ms |
| Proactive | ~6,600 (**~74% lower**) | 9.9–17.7ms |
| Pre-warm(4) | ~70 (barely builds) | 9.8–22.5ms |

All three hold **VST p95 well under the 100ms SLO** throughout — the point of
decoupling playback from the write pipeline (see above) holds regardless of
which scaling strategy is fighting the backlog. Concurrent streams reached
~15,000–15,400 in every run; the load generator logged zero HTTP errors
across the full verification session.

Two more things worth watching in the console:

- **Cold-start is directly visible.** Scale the pool up (manually, or via the
  autoscaler) and the "warming" count holds steady for ~12s before those
  workers flip to "active" and start draining backlog — a clean, isolated
  demonstration of the delay the strategies above are all racing against.
- **Scale-down is flap-free and worker-outage recovery still works.** When
  load drops, the pool steps down one worker at a time with no oscillation
  back up, and containers are actually removed (not just idled). Simulating a
  worker outage mid-premiere (`Simulate worker outage`) drops the pool to
  zero, lets the backlog spike, and the autoscaler recovers it once workers
  come back — VST stays flat throughout, since the outage only ever touches
  the write path.

The console (`docs/console.png`) is meant to explain itself to a viewer who's
never seen it before: a framing panel spells out what's being shown and why,
every tile has a one-line explanation of what it measures and where the
number comes from, and the "what to watch" note updates with the preset or
strategy you've picked so there's always a concrete thing to look for.

## Observability

Metrics are always on (Prometheus + Grafana). Distributed tracing is
OpenTelemetry, opt-in via `OTEL_ENABLED=true` pointed at any OTLP collector
(Grafana Cloud, a Datadog agent, etc.) — one env var, no code change.

## Layout

```
api/            Fastify service (API + worker share one image, switched by ROLE)
  src/routes/   discover, catalog (title detail), search, playback/start, qoe/beacon
  src/lib/      db, redis, rabbit, cache helper, session tracking
  src/worker.ts queue consumer that processes QoE beacons into trending scores
db/schema.sql   catalog + stats schema (applied on first boot)
load/           k6 load script
observability/  prometheus config + grafana dashboard (provisioned)
```

## Phase 2 (deploy)

The same images lift to ECS Fargate behind an ALB, with a Lambda control plane
that scales the stack up on demand and back to zero after idle, and a distributed
k6 fleet on Fargate Spot for six-figure concurrent load. Near-zero cost at rest.
Kept as a ready follow-up, not required to run everything above.
