# Read-Path Thundering Herd — Design Spec

**Date:** 2026-08-31
**Status:** Approved for planning (built autonomously; user asleep)
**Author:** Danny Kilkenny
**Builds on:** streaming-qoe-reskin + intelligent-scaling (worker-tier scaling)
**Restore point if this fails:** git tag `demo-working-v2` (commit 5737155)

## Purpose

Close the sharpest hole in the demo: today it scales the **write path** (worker
tier draining the beacon queue), but Angel's stated need is **user-facing (read)
scalability**, and the headline "VST stays flat under a premiere" is partly
true-by-construction because the premiere is a beacon-write storm, not a read
surge. This feature adds a **read-path thundering herd** — a synchronized surge
of `POST /playback/start` requests (everyone pressing play when the episode
drops) — and demonstrates the **API (read) tier scaling horizontally behind a
load balancer to hold VST under it.** This makes "reads stay fast under load" a
thing you *show*, not assume, and targets Angel's actual ask.

## Non-goals

- Real video/CDN/ABR (still out of scope; this is the auth/session/read plane).
- Breaking or changing the existing worker-tier scaling or premiere scenarios —
  they must keep working unchanged.
- Real DRM/auth — the playback-start cost is a labeled simulation.

## The honesty contract (extended)

| Signal | Source | Framing |
|---|---|---|
| VST under herd | Measured `POST /playback/start` latency aggregated across all API replicas. | Real. Rises when an API instance saturates, recovers when the tier scales out. |
| Playback-start RPS | Measured request rate to `/playback/start`. | Real. |
| Active API instances | Real API containers, provisioned on demand via the Docker API (same pattern as workers), discovered by the load balancer. | Real. Docker API now → ECS service desired-count in Phase 2. |
| Per-instance saturation | A **bounded per-instance concurrency + a small async entitlement delay** (`PLAYBACK_MAX_INFLIGHT`, `PLAYBACK_COST_MS`) so one instance caps at an achievable RPS and VST climbs past it. | A labeled simulation of a per-instance entitlement/license-check concurrency limit (like a connection/thread pool). **Async only — no CPU busy-loop** (unattended-run safe). |

Nothing is invented; the one deliberate simulation is the per-instance
saturation model, labeled the same way as the worker per-event cost and
cold-start.

## Architecture (what's added)

```
load / viewers ─► [ lb: nginx ] ─► api replica 1 ─┐
                     (round-robin        api replica 2 ├─► Redis / Postgres / RabbitMQ
                      via Docker DNS)     api replica N ─┘
                          ▲
          control plane ──┘ provisions/removes API containers on demand
          (api-tier autoscaler, keyed on VST/read-load — SEPARATE from the
           worker autoscaler, which is untouched)
```

1. **`lb` service (nginx):** L7 round-robin across API replicas using Docker's
   embedded DNS with **per-request re-resolution** (`resolver 127.0.0.11`,
   variable `proxy_pass`), so newly-provisioned API containers (network alias
   `api`) are picked up automatically without an nginx reload.
2. **API-tier provision-on-demand:** the control plane provisions/removes real
   API containers (labels `com.docker.compose.service=api`, network alias `api`)
   via the Docker API — reusing the proven worker-provisioning pattern. New
   instances get the same env/image (`streaming-app`, `ROLE=api`).
3. **API-tier autoscaler (separate from the worker autoscaler):** scales the API
   pool on a **read-path signal** — scale up when VST p95 exceeds a threshold
   (default 40ms, giving headroom under the 100ms SLO) or read RPS approaches
   current API capacity; scale down with hysteresis once the herd subsides.
   `MIN_API=1`, `MAX_API=4`.
4. **Per-instance saturation model** on `/playback/start`: `PLAYBACK_COST_MS`
   (async delay, ~10ms, simulated entitlement lookup) + `PLAYBACK_MAX_INFLIGHT`
   (per-instance concurrency cap, ~20). Beyond the cap, requests queue → VST
   climbs. One instance caps ~`MAX_INFLIGHT/COST_MS`·1000 ≈ ~2000/s; a herd of
   several thousand/s overwhelms one instance and forces scale-out.
5. **Read-herd load scenario:** a `playbackSurge` load mode — a synchronized,
   high-rate ramp of `POST /playback/start` on the premiere title (the thundering
   herd), distinct from the beacon-storm premiere.
6. **Routing:** the load generator's read traffic and Caddy's `api.localhost` go
   through the `lb`. Prometheus scrapes API replicas via `dns_sd` (like workers).

## Console + explainer + README

- **Console:** new readouts — **Active API instances** and **Playback-start
  RPS**; a **Playback surge (thundering herd)** preset; a self-explanatory note
  ("Everyone presses play at once when the episode drops — watch VST rise as one
  API instance saturates, then recover as the read tier scales out"); tile
  explanations for the new readouts.
- **AI explainer:** narrate read-tier scaling — "VST rose to Xms as playback
  starts surged past one instance's capacity; scaling the API tier to N restored
  it" — distinct from the worker/backlog write-path story.
- **README:** a "Read-path thundering herd" section — the two-tier scaling story
  (read tier on VST, write tier on backlog), the honesty framing, the ECS mapping
  (API tier → ECS service desired-count; herd → real premiere thundering herd),
  and measured numbers.

## Testing / verification

No unit-test harness; verify by running:

1. **LB + API provisioning (linchpin):** dynamically provision API instances 1→3;
   confirm nginx distributes across ALL of them (each replica serves traffic) and
   VST aggregates across replicas; the existing premiere STILL works.
2. **Herd stresses one instance:** with 1 API instance, the `playbackSurge` herd
   pushes VST up materially (past the 40ms scale threshold, ideally toward/over
   100ms) — proving the read path is genuinely stressed.
3. **API tier scales to hold VST:** with the api-autoscaler on, the same herd
   scales the API tier 1→N and VST recovers under continued load; scales back down
   after. Capture the VST-before vs VST-after-scale numbers.
4. **No regression:** the worker-tier premiere (beacon storm → worker scaling)
   still works exactly as before; both autoscalers coexist without fighting.
5. **Combined (if stable):** a full premiere = read herd + beacon storm together —
   both tiers scale, VST holds. (Nice-to-have; don't destabilize the build for it.)
6. Re-capture Console + Grafana screenshots showing API instances + the herd.

## Safety (autonomous build)

- Restore point: tag `demo-working-v2` (5737155). Every task must keep the
  EXISTING premiere working (verify it each task), not just the new scenario.
- If the feature cannot be made solid, `main` is reset to `demo-working-v2` and
  the stack rebuilt so the user wakes to the working demo; the attempt is left in
  git history/tag for reference, with an honest report.

## Future phases

API tier → ECS service with `UpdateService` desired-count (or Application
Auto Scaling target-tracking on a custom VST metric); the herd is the real
premiere thundering herd; the load balancer becomes an ALB; per-instance
saturation becomes the real entitlement/DRM-license path.
