import { config } from "./config";
import { metricsSnapshot, readRps, type Snapshot } from "./metrics";
import { activeWorkers, activeApiInstances, isDockerAvailable, workersWarming } from "./docker";
import { getStrategy } from "./autoscaler";
import { apiAutoscalerEnabled } from "./apiscaler";
import { recentEvents } from "./state";

// Deterministic reading of the metrics — always available, so the feature works
// with no API key and is the honest fallback if the model call fails.
function ruleBasedExplain(
  s: Snapshot,
  workers: number,
  warming: number,
  utilization: number | null,
  strategy: "reactive" | "proactive",
  apiInstances: number,
  readRps: number | null
): string {
  const parts: string[] = [];
  const w = workers >= 0 ? `${workers} worker(s) active; ` : "";
  const warmSecs = Math.round(config.workerColdStartMs / 1000);

  // READ tier: scaled independently of the worker/backlog story below, on
  // VST (video start time) behind the load balancer. `scaledOut` is only
  // ever true when apiInstances is a real (non-negative) reading, since -1
  // (docker unavailable) can never exceed minApi.
  const vst = s.vstP95_ms;
  const scaledOut = apiInstances > config.minApi;
  const atCap = apiInstances >= config.maxApi;
  const rpsLabel = readRps != null ? `${readRps} req/s of playback starts` : "playback-start volume";

  if (vst != null && vst > 100) {
    if (scaledOut) {
      parts.push(
        `VST is still over SLO (p95 ${vst}ms vs 100ms target)${atCap ? ` even at the ${config.maxApi}-instance cap` : ""}, but the read/API tier has already scaled to ${apiInstances} instance(s) behind the load balancer for ${rpsLabel} — VST is a trailing p95 (30s window), so it lags the scale-up by a few seconds rather than meaning the fix failed.`
      );
    } else {
      parts.push(
        `VST is over SLO (p95 ${vst}ms vs 100ms target) — ${rpsLabel} have outrun this API instance's capacity; the read/API tier should scale out behind the load balancer.`
      );
    }
  } else if (vst != null && vst > config.vstScaleUpMs) {
    parts.push(
      `VST is elevated (p95 ${vst}ms), above the ${config.vstScaleUpMs}ms read-tier scale-up threshold though still under the 100ms SLO — the read/API tier is responding to ${rpsLabel}${scaledOut ? `, now at ${apiInstances} instance(s) behind the load balancer` : ""}.`
    );
  } else if (vst != null && scaledOut) {
    parts.push(
      `Playback starts are fast (VST p95 ${vst}ms, under the 100ms SLO) — the read/API tier scaled out to ${apiInstances} instances behind the load balancer to hold it there under ${rpsLabel}.`
    );
  } else if (vst != null) {
    parts.push(`Playback starts are fast (VST p95 ${vst}ms, well under the 100ms SLO), served cache-first and independent of the telemetry pipeline.`);
  }

  if (s.backlog != null && s.backlog > 2000)
    parts.push(`The QoE beacon pipeline is behind (${s.backlog.toLocaleString()} backlog) — ${w}the autoscaler is adding workers to drain it.`);
  else if (s.backlog != null && s.backlog > 500)
    parts.push(`A small beacon backlog is forming (${s.backlog}); ${w}the workers are roughly keeping pace.`);
  else
    parts.push(`The QoE beacon pipeline is healthy — the backlog is essentially empty and ${workers >= 0 ? `${workers} worker(s) are` : "the workers are"} keeping up.`);

  // Scaling narration: only speak to utilization/warming when there's
  // something to say — high utilization and/or workers still cold-starting.
  if (warming > 0 && utilization != null && utilization > 75) {
    parts.push(
      `Utilization is ${utilization}%; the ${strategy} scaler is provisioning capacity — ${warming} worker(s) warming up (~${warmSecs}s simulated cold start).`
    );
  } else if (warming > 0) {
    parts.push(`${warming} worker(s) are still warming up (~${warmSecs}s simulated cold start) before they start consuming.`);
  } else if (utilization != null && utilization > 75) {
    parts.push(`Utilization is ${utilization}%, above the 75% threshold — the ${strategy} scaler is provisioning additional capacity.`);
  }

  if (s.concurrentStreams != null)
    parts.push(`${s.concurrentStreams.toLocaleString()} concurrent streams right now.`);
  if (s.rebufferRatio != null && s.rebufferRatio > 2)
    parts.push(`Rebuffer ratio is ${s.rebufferRatio}% — worth watching for viewer-experience impact.`);

  return parts.join(" ");
}

async function llmExplain(prompt: string): Promise<string | null> {
  if (!config.openrouterKey) return null;
  try {
    const res = await fetch(`${config.openrouterBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/DKilkenny/angel-streaming-demo",
        "X-Title": "Streaming Load Console",
      },
      body: JSON.stringify({
        model: config.openrouterModel,
        max_tokens: 220,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are an SRE watching a video streaming service. Explain in 2-4 plain-English sentences what the metrics show right now and what action, if any, would help. Ground every claim in the numbers; do not invent problems. Two separate concerns: (1) VIDEO START TIME (VST p95) is the playback-start path, kept fast by caching — its SLO is p95 < 100ms; only call it a problem if it exceeds 100ms. (2) The BEACON BACKLOG is the QoE telemetry write path; only say the pipeline is 'behind' if the backlog is large (say > 2000) or clearly growing, and note the autoscaler adds workers to drain it. Rebuffer ratio and playback error rate are viewer-experience signals aggregated from client beacons. If VST is under SLO and the backlog is low, state plainly that the service is healthy. " +
              "The autoscaler has two strategies: 'reactive' waits for the beacon backlog to build before adding workers; 'proactive' watches utilization (published beacons vs. current worker capacity) and provisions additional workers BEFORE the backlog builds, once utilization crosses ~75%. Newly provisioned workers cold-start for about 12 seconds — a SIMULATED provisioning delay standing in for a real container/task launch, not an actual infrastructure cold start — so there's a lead time between a scale-up decision and that capacity actually draining the queue; count warming workers as capacity in flight, not yet capacity delivered. An operator can also set a pre-warm floor to hold extra workers ready ahead of a known/scheduled surge, so scale-up happens before load even arrives. When utilization is high and/or workers are warming, explain the scaling decision in those terms — do not call the system 'struggling' on read latency (VST) alone; only flag VST if p95 exceeds 100ms. " +
              "There are TWO INDEPENDENT autoscalers, and you must keep their stories separate: the WRITE/worker tier above scales on beacon backlog; the READ/API tier scales on VST behind a load balancer (nginx round-robining across API replicas). When playback-start (`/playback/start`) traffic surges past what one API instance can handle, VST climbs above its scale-up threshold (~80ms — set well under the 100ms SLO, so a scale-up can happen before the SLO is actually breached) and the read tier adds instances (from a floor of 1 up to a cap of 4) behind the load balancer to bring VST back down; it only scales back down once VST is low AND playback-start RPS has genuinely subsided. A beacon-storm premiere can drive only the worker tier while the read tier sits at its floor, and a playback-start thundering herd can drive only the read tier while workers sit at theirs — treat these as two separate incidents unless both signals are moving. When VST is elevated or was recently elevated, narrate it as: VST rose because playback starts surged past one API instance's capacity, and the read/API tier scaled out to N instances behind the load balancer to restore it — do not conflate this with the backlog/worker story. The per-instance capacity limit that lets one API instance saturate is a LABELED SIMULATION (a bounded per-instance concurrency + a small async delay standing in for a real entitlement/DRM check), the same way worker cold-start is simulated — not a real infrastructure limit. IMPORTANT: VST is a TRAILING p95 over a 30-second window, so recovery lags an instance scale-up by several seconds; if the read tier has already scaled up but VST is still elevated moments later, say it is settling/recovering as the window rolls forward — do not call the system 'failing' or say the scale-up didn't work just because VST hasn't caught up yet. Be concrete and calm. No preamble, no bullet points.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // eslint-disable-next-line no-console
      console.error(`[explain] OpenRouter ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[explain] OpenRouter error:", (err as Error).message);
    return null;
  }
}

export async function explainIncident(): Promise<{
  source: "ai" | "rule-based";
  model?: string;
  text: string;
  snapshot: Snapshot;
}> {
  const snap = await metricsSnapshot();
  const dockerUp = isDockerAvailable();
  const workers = dockerUp ? await activeWorkers() : -1;
  const warming = dockerUp ? await workersWarming() : -1;
  const apiInstances = dockerUp ? await activeApiInstances() : -1;
  const rps = await readRps();
  const strategy = getStrategy();
  // Mirror /api/status's utilization computation: null when workers is
  // unknown (docker unavailable), so we never fabricate a number.
  const utilization =
    workers < 0
      ? null
      : Math.round((100 * (snap.eventsPublished ?? 0)) / Math.max(1, workers * config.workerCapacity));
  const events = recentEvents(12)
    .map((e) => `- ${new Date(e.ts).toISOString().slice(11, 19)} ${e.kind}: ${e.detail}`)
    .join("\n");

  const n = (v: number | null, unit = ""): string =>
    v == null ? "n/a (no traffic sampled)" : `${v}${unit}`;

  const prompt =
    `Live metrics:\n` +
    `  VST p95: ${n(snap.vstP95_ms, "ms")} (SLO < 100ms, read-tier scale-up threshold ${config.vstScaleUpMs}ms)\n` +
    `  concurrent streams: ${n(snap.concurrentStreams)}\n` +
    `  rebuffer ratio: ${n(snap.rebufferRatio, "%")}\n` +
    `  playback error rate: ${n(snap.playbackErrorRate, "%")}\n` +
    `  cache hit rate: ${n(snap.cacheHitRate, "%")}\n` +
    `  beacon backlog: ${n(snap.backlog)}\n` +
    `  beacons published/s: ${n(snap.eventsPublished)}, processed/s: ${n(snap.eventsProcessed)}\n` +
    `  active workers: ${workers < 0 ? "unknown" : workers}\n` +
    `  workers warming (cold-starting, not yet consuming): ${warming < 0 ? "unknown" : warming}\n` +
    `  utilization: ${n(utilization, "%")}\n` +
    `  write/worker autoscaler strategy: ${strategy}\n` +
    `  active API (read-tier) instances: ${apiInstances < 0 ? "unknown" : apiInstances} (min ${config.minApi}, max ${config.maxApi}) behind the load balancer\n` +
    `  read/API-tier autoscaler: ${apiAutoscalerEnabled() ? "on" : "off"}\n` +
    `  playback-start rate (read signal): ${n(rps, " req/s")}\n\n` +
    `Recent events:\n${events || "(none)"}`;

  const ai = await llmExplain(prompt);
  if (ai) return { source: "ai", model: config.openrouterModel, text: ai, snapshot: snap };
  return {
    source: "rule-based",
    text: ruleBasedExplain(snap, workers, warming < 0 ? 0 : warming, utilization, strategy, apiInstances, rps),
    snapshot: snap,
  };
}
