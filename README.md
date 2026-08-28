# Streaming Discovery API

A content and discovery API for a streaming catalog, built to demonstrate
scalability and resilience under real load. Independent concept prototype by
Danny Kilkenny — synthetic data, not affiliated with any company.

> The point of this repo is honesty: it produces **measured** numbers (Redis hit
> rate, RabbitMQ queue depth, p99 latency) under real load, in a real stack, not
> a simulation with invented figures. See [DESIGN.md](./DESIGN.md).

## Stack

Node.js · Fastify · TypeScript · Redis · RabbitMQ · Postgres · OpenTelemetry ·
Prometheus · Grafana · Docker Compose · k6

## Run it (one command)

Requires Docker. From the repo root:

```bash
make up          # build, start the stack, wait for health, seed the catalog
```

Then open the dashboard and generate load in another terminal:

```bash
make load        # containerized k6 ramps to 200 VUs against the API
```

Watch it live at **https://grafana.localhost** (Grafana → "Streaming Discovery API").

| Service | HTTPS (Caddy + mkcert) | Plain HTTP |
|---|---|---|
| Grafana | https://grafana.localhost | http://localhost:3001 |
| Discovery API | https://api.localhost/discover | http://localhost:3000/discover |
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

- **Read latency** stays low (p95 SLO < 250ms) because discover/detail/search are
  cache-first in Redis.
- **Cache hit rate** climbs from cold toward ~0.8+ as the working set warms.
- **Queue depth** rises when engagement events burst, then drains as the worker
  keeps up — visible backpressure, not a hidden failure.
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
  src/routes/   discover, title detail, search, events
  src/lib/      db, redis, rabbit, cache helper
  src/worker.ts queue consumer that aggregates engagement into trending scores
db/schema.sql   catalog + stats schema (applied on first boot)
load/           k6 load script
observability/  prometheus config + grafana dashboard (provisioned)
```

## Phase 2 (deploy)

The same images lift to ECS Fargate behind an ALB, with a Lambda control plane
that scales the stack up on demand and back to zero after idle, and a distributed
k6 fleet on Fargate Spot for six-figure concurrent load. Near-zero cost at rest.
Kept as a ready follow-up, not required to run everything above.
