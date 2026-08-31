# Intelligent Scaling — Design Spec

**Date:** 2026-08-30
**Status:** Approved for planning
**Author:** Danny Kilkenny
**Builds on:** [streaming-qoe-reskin-design.md](./streaming-qoe-reskin-design.md)

## Purpose

Elevate the demo's autoscaling from a basic reactive scaler into a layered,
production-shaped scaling story that mirrors how real streaming teams operate,
and make the whole demo **self-explanatory** so a viewer clicking through
without narration understands what they're seeing.

Three scaling mechanisms, told as a maturity curve the same premiere can be run
against for contrast:

1. **Reactive** (today) — scale after the beacon backlog crosses a threshold.
2. **Proactive** — scale on *utilization* (incoming rate approaching capacity),
   provisioning the next worker *before* the backlog builds.
3. **Predictive pre-warm** — raise the worker floor ahead of a *known* surge
   (Angel's premieres are scheduled), so capacity is already there.

These only become meaningful once capacity takes time to arrive, so a simulated
**cold-start delay** is core to the design — it's what makes lead time matter.

## Non-goals

- Real ECS/Fargate provisioning (that's Phase 2 — this models its *shape*).
- Real predictive ML/forecasting. "Predictive" here = operator-triggered or
  scheduled pre-warm against known events, not a learned model.
- Changing the QoE metrics, endpoints, or premiere calibration from the reskin.

## The honesty contract (unchanged and extended)

Every signal is real or a clearly-labeled simulation:

| Signal | Source | Honesty framing |
|---|---|---|
| Utilization % | `publishRate / (activeWorkers × perWorkerCapacity)` | perWorkerCapacity is the **measured** steady-state per-worker throughput (~550/s at WORKER_EVENT_MS=4). |
| Cold-start delay | A newly provisioned worker waits `WORKER_COLDSTART_MS` (~12s) after boot before consuming. | The one deliberate knob — a labeled stand-in for Fargate task provisioning/init time (real Fargate is ~30–90s; we compress to demo timescale). Same category as the existing per-event cost. |
| Worker provisioning | Real Docker containers created/removed via the Docker API. | A local stand-in for `ecs:RunTask`/`UpdateService`; the control-plane pattern is identical. |
| Everything else | As in the reskin (VST measured, beacons aggregated, backlog real). | Unchanged. |

## Mechanism 1 — Provision-on-demand (replaces the warm pool)

**Why:** the current autoscaler starts/stops a pre-created pool of containers
(`make up --scale worker=5`). Any bare `docker compose up` reconciles the pool
back to 1 and deletes the rest, silently breaking scale-up. Provision-on-demand
removes that fragility *and* models the ECS lifecycle.

- On **scale-up**, the control plane **creates** a new worker container by
  cloning a reference worker's config (image `streaming-app`, env, compose
  network, labels) via dockerode `createContainer` + `start`, with a unique name
  and the compose service/label set so it's discovered by `workerContainers()`.
- On **scale-down**, it **removes** the container (`stop` + `remove`), so the
  next scale-up is a genuine create-from-scratch (real cold start).
- `minWorkers` (1) is always kept running.
- `initPool()` reconciles to `minWorkers` on boot and **self-heals**: it no
  longer depends on a pre-created pool, so a collapsed pool can't break it.

**Robustness requirement:** after any `docker compose up -d --build` (which
collapses the compose-managed worker count), the control plane must still scale
correctly — because it creates its own containers, not relying on stopped ones.

## Mechanism 2 — Cold-start delay

- New config `WORKER_COLDSTART_MS` (default ~12000) on the worker. On boot, the
  worker sleeps this long **before** opening its RabbitMQ consumer, then consumes
  normally. It still exits promptly on SIGTERM.
- The control plane tracks, per worker, whether it is **warming** (created but
  not yet consuming) vs **active** (consuming). Exposed as a `workersWarming`
  count so the Console can show "N warming up."
  - Simplest honest signal: a worker is "active" once it has registered a live
    consumer on the queue (RabbitMQ per-queue consumer count) or once
    `WORKER_COLDSTART_MS` has elapsed since its container `StartedAt`. Use the
    elapsed-since-StartedAt heuristic (no extra plumbing), and label it as such.

## Mechanism 3 — Proactive + reactive + pre-warm scaling

The autoscaler gains a **strategy** setting: `reactive` | `proactive` (default
`proactive`), plus an independent **pre-warm** floor.

- **perWorkerCapacity**: config `WORKER_CAPACITY` (default 550, the measured
  per-worker throughput). Utilization = `publishRate / (active × WORKER_CAPACITY)`.
- **proactive**: if `utilization > 0.75` and `active < maxWorkers`, provision the
  next worker now (proportional jump allowed for large gaps). Because provisioning
  costs `WORKER_COLDSTART_MS`, this keeps the backlog low by getting ahead of it.
- **reactive** (kept for the contrast): scale only when `backlog > scaleUpBacklog`.
  In `proactive` mode the backlog threshold remains as a **safety net**.
- **scale-down**: unchanged from the reskin's hysteresis — only when backlog is
  low AND publish rate has dropped below `scaleDownPublishRate` (no flapping).
  On scale-down, remove the container (Mechanism 1).
- **pre-warm**: a control that temporarily raises the effective `minWorkers`
  floor (e.g. to 4) so capacity is provisioned ahead of a surge. Clearing it
  lets the scaler shed back to 1 once the surge passes. Works with either strategy.

## Mechanism 4 — Console: contrast + self-explanation

**The contrast (the centerpiece):** a **Scaling strategy** selector
(Reactive / Proactive) and a **Pre-warm for premiere** button. Running the same
Episode Premiere three ways visibly differs: reactive (backlog spikes, plays
catch-up), proactive (backlog stays low, workers ramp early), pre-warmed (backlog
barely moves).

**New tiles/readouts:** Utilization %, Workers (active + "N warming up").

**Self-explanatory layer (cross-cutting requirement — not an afterthought):**

- **Framing panel** (top, collapsible): 3–4 sentences on what the system is, the
  read-path-vs-write-path decoupling, and the honesty contract. The mental model
  before touching anything.
- **Metric tiles**: each tile carries a one-line plain-English explanation of what
  it measures and its honest source (tooltip or subtitle).
- **Scenario/strategy notes**: selecting a preset or a strategy shows a short
  "what this models / what to watch" note. Clicking Episode Premiere, or flipping
  Reactive→Proactive, explains itself in one or two sentences.
- **Activity feed**: human-readable, contextual lines (e.g. "Utilization hit 78%
  — provisioning worker #3 (warming up, ~12s)"), not terse logs.
- The **AI explainer** stays as the on-demand deep dive; the inline layer makes
  the demo self-guiding even if the viewer never clicks it.

A viewer with zero context should be able to open the Console, read the framing
panel, click Episode Premiere, and understand what happened and why.

## Explainer + README

- **AI explainer** prompt/fallback updated to reference utilization, the active
  strategy, and workers warming up — narrating *why* it scaled when it did.
- **README** gains an "Intelligent scaling" section: the three strategies, the
  cold-start model, the honesty framing, and the contrast to run. Updated numbers
  from the verification run.

## Testing / verification

Verification is running it (no unit-test harness):

1. **Provision-on-demand robustness:** from a clean stack, run
   `docker compose up -d --build` (collapses the compose pool), then drive a
   premiere and confirm the control plane still provisions workers correctly and
   scales — proving the warm-pool fragility is gone.
2. **Cold-start visible:** on scale-up, the Console shows "N warming up" for
   ~12s before those workers count as active and the backlog responds.
3. **Reactive vs proactive contrast:** same premiere, both strategies. Proactive
   keeps peak backlog materially lower than reactive (capture both). VST stays
   < 100ms in both.
4. **Pre-warm:** pre-warm, then premiere → backlog barely builds; capture vs a
   cold premiere.
5. **Scale-down still clean:** after each run, workers shed back to 1 (containers
   removed) only once the surge subsides; no flapping.
6. **Self-explanatory:** a reader who has never seen the demo can, from the
   framing panel + inline notes alone, correctly describe what Episode Premiere
   does and why the worker count changed. (Sanity-check via the /browse pass.)
7. Re-capture Console + Grafana screenshots showing utilization, warming-up, and
   the strategy selector.

## Future phases (unchanged)

Phase 2 swaps the Docker API for the ECS/Fargate API (`RunTask`/`UpdateService`),
the cold-start delay becomes the real task cold-start, and pre-warm becomes a
scheduled capacity plan against the real release calendar. Vercel front-end for a
public clickable URL; scale-to-zero at rest.
