import { config } from "./config";
import { metricsSnapshot, type Snapshot } from "./metrics";
import { activeWorkers, isDockerAvailable } from "./docker";
import { recentEvents } from "./state";

// Deterministic reading of the metrics — always available, so the feature works
// with no API key and is the honest fallback if the model call fails.
function ruleBasedExplain(s: Snapshot, workers: number): string {
  const parts: string[] = [];
  if (s.backlog != null && s.backlog > 5000)
    parts.push(
      `The engagement queue is backed up (${s.backlog.toLocaleString()} messages) — the workers are behind the incoming event rate. ${workers >= 0 ? `${workers} worker(s) active; ` : ""}adding worker capacity will drain it.`
    );
  else if (s.backlog != null && s.backlog > 500)
    parts.push(`A small backlog is forming (${s.backlog} messages) but the workers are keeping pace.`);
  else parts.push("The event pipeline is healthy — the queue is essentially empty.");

  if (s.p99_ms != null && s.p99_ms > 100)
    parts.push(`Read latency is elevated (p99 ${s.p99_ms}ms), consistent with the API saturating under load; scaling reads or warming the cache would bring it down.`);
  else if (s.p99_ms != null)
    parts.push(`Reads are fast (p99 ${s.p99_ms}ms).`);

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
              "You are an SRE watching a streaming discovery API. Given live metrics and a recent event log, explain in 2-4 plain-English sentences what is happening right now and what action (if any) would help. Be concrete and calm. No preamble, no bullet points.",
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
