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
