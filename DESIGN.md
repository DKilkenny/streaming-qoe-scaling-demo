# Streaming Discovery API — Design

A concept build responding to the Sr Software Engineer, Streaming Services role:
own the content and discovery API that powers apps at scale. This is an
independent prototype by Danny Kilkenny. It uses synthetic catalog data and is
not affiliated with Angel Studios.

The goal is not a toy. It is a real, running system that produces **measured**
metrics under real load (Redis hit rate, RabbitMQ queue depth, p99 latency),
built in the target stack, instrumented the way a production service should be,
and designed to cost near zero at rest.

## What it does

A content and discovery API for a streaming catalog — the read-heavy,
latency-sensitive surface that a mobile / TV / web client hits to browse and
watch.

| Endpoint | Purpose | Hot path |
|---|---|---|
| `GET /health` | Liveness/readiness | — |
| `GET /titles/:id` | Title detail | Redis-cached |
| `GET /discover` | Ranked home rails (Trending, For You, New) | Redis-cached |
| `GET /search?q=` | Catalog search | Redis-cached (short TTL) |
| `POST /events` | Engagement events (play, progress, complete) | Published to RabbitMQ |
| `GET /metrics` | Prometheus scrape | — |

Discovery and title reads are cache-first: check Redis, fall back to Postgres,
backfill the cache. Engagement events are accepted fast and pushed onto RabbitMQ;
a worker drains the queue and updates aggregate counters (view counts, trending
scores) in Postgres. That write path is what makes the queue depth a real,
observable number under load, and it mirrors how a real discovery service keeps
"trending" fresh without putting analytics writes on the request hot path.

## Architecture

```
          ┌─────────── clients (mobile / TV / web) ───────────┐
          │                  k6 load fleet                     │
          └───────────────────────┬───────────────────────────┘
                                   │  HTTP
                            ┌──────▼──────┐
                            │  Node API   │  Fastify + TypeScript
                            │  (stateless)│  OTel + prom-client
                            └──┬───────┬──┘
                  cache-first  │       │  publish events
                        ┌──────▼─┐  ┌──▼───────┐
                        │ Redis  │  │ RabbitMQ │
                        └──┬─────┘  └────┬─────┘
                  miss ->  │             │ consume
                        ┌──▼─────────────▼──┐
                        │     Postgres      │  catalog + aggregates
                        └───────────────────┘
                                   ▲
                        ┌──────────┴──────────┐
                        │  worker (consumer)  │  drains queue, updates counters
                        └─────────────────────┘

   observability:  API + Redis + RabbitMQ + Postgres  ──►  Prometheus ──► Grafana
```

Stateless API so it scales horizontally. State lives in Redis (cache),
RabbitMQ (event buffer), Postgres (source of truth). Nothing about adding a
second, third, or Nth API instance requires coordination — that is the property
that makes horizontal scaling honest.

## The metrics that matter (all measured, not modeled)

- **p50 / p99 request latency** — `http_request_duration_seconds` histogram.
- **Cache hit rate** — `cache_hits_total` / `cache_misses_total`. Climbs as the
  cache warms; the whole point of the cache-first design.
- **RabbitMQ queue depth** — from the RabbitMQ Prometheus plugin. Rises when
  event volume outpaces the worker, drains as the worker keeps up (or as we add
  workers). The visible backpressure story.
- **Throughput (RPS) and error rate** — per route.
- **Postgres pool saturation** — connections in use vs pool size.

The money shot under load: RPS ramps, p99 spikes as the single API instance
saturates, then flattens once we scale the API out and the cache warms — while
queue depth shows the event path holding under backpressure.

## Stack

Node.js, Fastify, TypeScript, Redis, RabbitMQ, Postgres, OpenTelemetry,
Prometheus + Grafana, Docker Compose, k6. Deliberately the role's stack. Redis /
RabbitMQ / K8s substitute for tools on my resume (DynamoDB caching, SQS, Fargate)
that solve the same problems; using the exact stack here is the point.

## Phasing

**Phase 1 (this repo, runs locally):** the full stack in Docker Compose, real
load via a containerized k6 fleet, real metrics on a Grafana dashboard. Produces
the numbers and the recorded run. Everything is containerized and
OTel-instrumented so Phase 2 is additive, not a rewrite.

**Phase 2 (additive, deploy):** lift the same images to ECS Fargate behind an
ALB, with a Lambda + API Gateway control plane that scales the stack up on
demand and back to zero after idle. A distributed k6 fleet on Fargate Spot
generates six-figure concurrent load from inside the region. Near-zero cost at
rest; a few dollars per live run. Kept ready for a live "watch it scale"
interview demo.

## Non-goals

Auth, real video delivery / CDN (that is a separate concern from the discovery
API), a real recommender model, and multi-region. The discovery API's scaling
and resilience is the thesis; everything else is scoped out on purpose.
