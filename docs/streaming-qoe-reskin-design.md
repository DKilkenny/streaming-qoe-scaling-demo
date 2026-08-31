# Streaming QoE Reskin — Design Spec

**Date:** 2026-08-30
**Status:** Approved for implementation
**Author:** Danny Kilkenny

## Purpose

Reframe the existing discovery/engagement demo into a **video playback + QoE
(Quality of Experience) service** for a faith/family streaming catalog. The goal
is domain fluency: the demo should speak the exact vocabulary a streaming
engineering team uses day to day, driven by the scenario they actually feel —
an **episode premiere spike** (a synchronized surge of viewers hitting play when
new content drops).

This is a **surface + scenario reskin, not a rebuild.** All existing
infrastructure is reused unchanged: Fastify / Redis / RabbitMQ / Postgres, the
worker pool, the shared `streaming-app` image, the stop/start autoscaler,
OpenTelemetry → Jaeger tracing, Prometheus/Grafana, and the reconnect loops.

## Non-goals (Phase 1)

- Real HLS/DASH video segment delivery and adaptive bitrate. Deferred to a
  labeled Phase 2 (see "Future Phases").
- DRM / real entitlement providers. The entitlement check is a real cache-first
  DB lookup, not an integration with a commercial DRM system.
- AWS deployment. Phase 1 stays local (Docker Compose); Vercel front-end and AWS
  Fargate backend are sequenced follow-ups, advanced only once each prior step
  is verified working.

## The honesty contract (critical)

Every number on screen must be defensible under questioning. No invented
figures. Each metric is either **measured** by the running system or
**aggregated from client-emitted beacons**, and the distinction is stated
plainly.

| Metric | What it is | Honesty framing |
|---|---|---|
| **Video Start Time (VST) p95** | Real measured latency of `POST /playback/start` (authorize + prepare playback session, served cache-first). **SLO: p95 < 100 ms.** | "VST here is the session-authorization budget, measured — not the end-to-end first-frame time, which adds CDN segment fetch and is Phase 2 with real HLS." |
| **Concurrent streams** | Real gauge of active playback sessions. | Directly measured. |
| **Rebuffer ratio** | Aggregated from client-emitted QoE beacons. | The load generator plays a **client SDK fleet emitting beacons** — exactly how Conviva/real QoE works. Real pipeline, synthetic client input, clearly labeled. |
| **Playback error rate** | Aggregated from `error` beacons. | Same as rebuffer: real aggregation pipeline over synthetic client beacons. |
| **Most-watched / trending** | Aggregated from `play`/`complete` beacons. | Existing pipeline, unchanged. |
| **Cache hit rate** | Real Redis hit rate. | Reframed as "shielding the catalog DB during a premiere surge." |

### Service Level Objectives

- **VST p95 < 100 ms** — the session-authorization budget for `POST /playback/start`.
  This is the demo's primary pass/fail line: it must stay green *through* the
  Episode Premiere surge, which is the whole point (cache-first playback start is
  decoupled from the beacon write path).
- End-to-end VST (including first-segment fetch) would target the industry
  ~1–2 s in Phase 2 with real HLS. Called out so the two are never conflated.

## Architecture

Unchanged from the current system. Two roles off one image:

- **API** (`ROLE=api`): serves reads (cache-first in Redis) and accepts playback
  starts and QoE beacons, publishing beacons to RabbitMQ off the hot path.
- **Worker** (`ROLE=worker`): consumes QoE beacons, aggregates them into title
  stats / trending scores in Postgres. Per-event cost bounds per-worker
  throughput so scaling workers is meaningful (existing `WORKER_EVENT_MS`).
- **Control plane**: Load Console, load generator (the "client SDK fleet"),
  autoscaler, chaos injection, AI explainer.

Data flow for the premiere scenario:

```
client fleet (load gen)
  ├─ POST /playback/start ──► API (entitlement + session prep, cache-first) ──► VST measured
  └─ POST /qoe/beacon ───────► API ──► RabbitMQ ──► Worker ──► Postgres (aggregates)
                                          │
                                   backlog builds under surge
                                          │
                                   autoscaler adds workers to drain
```

## Endpoint changes

| Current | New | Change |
|---|---|---|
| `GET /discover` | `GET /discover` | unchanged (browse rails, cache-first) |
| `GET /titles/:id` | `GET /titles/:id` | unchanged (title detail) |
| `GET /search` | `GET /search` | unchanged |
| — | **`POST /playback/start`** | NEW. Entitlement check + session prep, cache-first. Returns a playback session. Its measured latency is VST. |
| `POST /events` | **`POST /qoe/beacon`** | Renamed. Client QoE heartbeats: `play` / `progress` / `complete` / `rebuffer` / `error`. Published to the queue as today. |

`/playback/start` does real work: a cache-first entitlement/title lookup
(Redis → Postgres on miss) plus session creation. This is what makes VST a real,
measured latency rather than a synthetic figure. Active sessions are tracked to
drive the concurrent-streams gauge.

## Scenarios (Load Console presets)

Replaces the current normal/spike/storm presets with streaming-native ones:

| Preset | Models | Traffic shape |
|---|---|---|
| **Evening peak** | steady baseline nightly viewing | moderate mixed (browse + playback + beacons) |
| **Trailer drop** | a trailer release, moderate surge | elevated, mixed |
| **Episode premiere** | The Chosen episode drop — the thundering herd | high, concentrated `playback/start` + beacons on one title |

The premiere preset is the demo centerpiece. Expected behavior:
concurrent streams spike, VST p95 holds under SLO because playback-start is
cache-first, the beacon pipeline backlog builds, the autoscaler adds workers to
drain it, then scales back down when the surge passes — all while VST stays flat.
The existing **worker outage** chaos control demonstrates hard-failure recovery.

## Dashboard + AI explainer

- **Grafana / Console tiles** relabel to: VST p95, rebuffer ratio, concurrent
  streams, playback error rate, beacons/sec, cache hit rate, active workers,
  queue backlog.
- **AI explainer** prompt rewritten in streaming vocabulary. It must keep the
  two-concern separation that already works: (1) the **read/playback path** (VST,
  kept fast by cache) is independent from (2) the **beacon pipeline backlog**
  (the write path the autoscaler responds to). It should only call the system
  "behind" when the beacon backlog is genuinely large or growing, never because
  of read latency.

## Testing / verification

The demo's credibility is the measured behavior, so verification is running it:

1. Clean start: backlog 0, 1 worker, autoscaler on, VST baseline captured.
2. **Episode premiere** preset: confirm concurrent streams spike, VST p95 stays
   under SLO, beacon backlog builds, autoscaler scales workers up, backlog
   drains, workers scale back down. Capture the numbers.
3. Worker outage chaos: confirm backlog spikes and recovers after workers return.
4. AI explainer mid-premiere: confirm it correctly separates a healthy playback
   path from a temporarily-behind beacon pipeline, using the live numbers.
5. Re-capture Console + Grafana screenshots under a live premiere for the README
   and the outreach email.

## Future phases (labeled, not required to run Phase 1)

- **Phase 2 — real video:** serve HLS segments through the Redis/CDN caching
  layer; show adaptive bitrate and real segment cache-hit ratios. Makes VST
  include real first-segment fetch.
- **Vercel front-end:** deploy the Load Console / a narrative front-end to Vercel
  for a clickable public URL to embed in the outreach email.
- **AWS Fargate scale-to-zero backend:** the same images lift to ECS Fargate
  behind an ALB with a control plane that scales up on demand and back to zero at
  rest, plus a distributed k6 fleet for six-figure concurrent load. Near-zero
  cost at rest.
