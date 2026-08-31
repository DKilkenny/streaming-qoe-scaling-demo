import { config } from "./config";
import { metricsSnapshot, type Snapshot } from "./metrics";
import { activeWorkers, isDockerAvailable } from "./docker";
import { recentEvents } from "./state";

// Deterministic reading of the metrics — always available, so the feature works
// with no API key and is the honest fallback if the model call fails.
function ruleBasedExplain(s: Snapshot, workers: number): string {
  const parts: string[] = [];
  const w = workers >= 0 ? `${workers} worker(s) active; ` : "";

  if (s.vstP95_ms != null && s.vstP95_ms > 100)
    parts.push(`Video Start Time is over SLO (p95 ${s.vstP95_ms}ms vs 100ms target) — the playback-start path needs cache warming or more read capacity.`);
  else if (s.vstP95_ms != null)
    parts.push(`Playback starts are fast (VST p95 ${s.vstP95_ms}ms, well under the 100ms SLO), served cache-first and independent of the telemetry pipeline.`);

  if (s.backlog != null && s.backlog > 2000)
    parts.push(`The QoE beacon pipeline is behind (${s.backlog.toLocaleString()} backlog) — ${w}the autoscaler is adding workers to drain it.`);
  else if (s.backlog != null && s.backlog > 500)
    parts.push(`A small beacon backlog is forming (${s.backlog}); ${w}the workers are roughly keeping pace.`);
  else
    parts.push(`The QoE beacon pipeline is healthy — the backlog is essentially empty and ${workers >= 0 ? `${workers} worker(s) are` : "the workers are"} keeping up.`);

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
              "You are an SRE watching a video streaming service. Explain in 2-4 plain-English sentences what the metrics show right now and what action, if any, would help. Ground every claim in the numbers; do not invent problems. Two separate concerns: (1) VIDEO START TIME (VST p95) is the playback-start path, kept fast by caching — its SLO is p95 < 100ms; only call it a problem if it exceeds 100ms. (2) The BEACON BACKLOG is the QoE telemetry write path; only say the pipeline is 'behind' if the backlog is large (say > 2000) or clearly growing, and note the autoscaler adds workers to drain it. Rebuffer ratio and playback error rate are viewer-experience signals aggregated from client beacons. If VST is under SLO and the backlog is low, state plainly that the service is healthy. Be concrete and calm. No preamble, no bullet points.",
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
  const workers = isDockerAvailable() ? await activeWorkers() : -1;
  const events = recentEvents(12)
    .map((e) => `- ${new Date(e.ts).toISOString().slice(11, 19)} ${e.kind}: ${e.detail}`)
    .join("\n");

  const n = (v: number | null, unit = ""): string =>
    v == null ? "n/a (no traffic sampled)" : `${v}${unit}`;

  const prompt =
    `Live metrics:\n` +
    `  VST p95: ${n(snap.vstP95_ms, "ms")} (SLO < 100ms)\n` +
    `  concurrent streams: ${n(snap.concurrentStreams)}\n` +
    `  rebuffer ratio: ${n(snap.rebufferRatio, "%")}\n` +
    `  playback error rate: ${n(snap.playbackErrorRate, "%")}\n` +
    `  cache hit rate: ${n(snap.cacheHitRate, "%")}\n` +
    `  beacon backlog: ${n(snap.backlog)}\n` +
    `  beacons published/s: ${n(snap.eventsPublished)}, processed/s: ${n(snap.eventsProcessed)}\n` +
    `  active workers: ${workers < 0 ? "unknown" : workers}\n\n` +
    `Recent events:\n${events || "(none)"}`;

  const ai = await llmExplain(prompt);
  if (ai) return { source: "ai", model: config.openrouterModel, text: ai, snapshot: snap };
  return { source: "rule-based", text: ruleBasedExplain(snap, workers), snapshot: snap };
}
