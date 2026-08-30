import { config } from "./config";
import { metricsSnapshot, type Snapshot } from "./metrics";
import { activeWorkers, isDockerAvailable } from "./docker";
import { recentEvents } from "./state";

// Deterministic reading of the metrics — always available, so the feature works
// with no API key and is the honest fallback if the model call fails.
function ruleBasedExplain(s: Snapshot, workers: number): string {
  const parts: string[] = [];
  const w = workers >= 0 ? `${workers} worker(s) active; ` : "";
  if (s.backlog != null && s.backlog > 2000)
    parts.push(
      `The engagement queue is backed up (${s.backlog.toLocaleString()} messages) — the workers are behind the incoming event rate. ${w}adding worker capacity will drain it.`
    );
  else if (s.backlog != null && s.backlog > 500)
    parts.push(`A backlog is forming (${s.backlog} messages); ${w}the workers are roughly keeping pace.`);
  else parts.push(`The event pipeline is healthy — the queue is essentially empty and ${workers >= 0 ? `${workers} worker(s) are` : "the workers are"} keeping up.`);

  if (s.p99_ms != null && s.p99_ms > 150)
    parts.push(`Read latency is elevated (p99 ${s.p99_ms}ms); warming the cache or scaling the read path would help.`);
  else if (s.p99_ms != null)
    parts.push(`Reads are fast (p99 ${s.p99_ms}ms), served from cache independently of the event pipeline.`);

  if (s.cacheHitRate != null && s.cacheHitRate < 80)
    parts.push(`Cache hit rate is low (${s.cacheHitRate}%) — the cache is still warming or churning.`);
  else if (s.cacheHitRate != null)
    parts.push(`Cache is warm (${s.cacheHitRate}% hit rate), shielding Postgres from read load.`);

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
              "You are an SRE watching a streaming discovery API. Explain in 2-4 plain-English sentences what the metrics show right now and what action, if any, would help. Ground every claim in the numbers provided; do not invent problems. Two separate concerns: (1) READ latency (p50/p99) is the API's read path, kept fast by caching — it is unrelated to event processing. (2) The QUEUE BACKLOG is the event write path. Only say the system is 'struggling' or 'behind' if the backlog is large (say > 2000) or clearly growing. If the backlog is low and latency is low, state plainly that the system is healthy. Be concrete and calm. No preamble, no bullet points.",
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

  const prompt =
    `Live metrics:\n` +
    `  p50 latency: ${snap.p50_ms}ms\n` +
    `  p99 latency: ${snap.p99_ms}ms\n` +
    `  cache hit rate: ${snap.cacheHitRate}%\n` +
    `  request rate: ${snap.rps}/s\n` +
    `  queue backlog: ${snap.backlog}\n` +
    `  events published/s: ${snap.eventsPublished}, processed/s: ${snap.eventsProcessed}\n` +
    `  active workers: ${workers < 0 ? "unknown" : workers}\n\n` +
    `Recent events:\n${events || "(none)"}`;

  const ai = await llmExplain(prompt);
  if (ai) return { source: "ai", model: config.openrouterModel, text: ai, snapshot: snap };
  return { source: "rule-based", text: ruleBasedExplain(snap, workers), snapshot: snap };
}
