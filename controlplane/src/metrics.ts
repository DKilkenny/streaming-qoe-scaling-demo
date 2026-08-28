import { config } from "./config";

async function q(expr: string): Promise<number | null> {
  try {
    const url = `${config.prometheusBase}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      data: { result: { value: [number, string] }[] };
    };
    const r = data.data?.result;
    if (r && r.length) return Number(r[0].value[1]);
    return null;
  } catch {
    return null;
  }
}

export async function metricsSnapshot() {
  const [p50, p99, hitRate, rps, backlog, unacked, evPub, evProc] =
    await Promise.all([
      q("histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket[30s])) by (le))"),
      q("histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[30s])) by (le))"),
      q('sum(rate(cache_events_total{result="hit"}[30s])) / clamp_min(sum(rate(cache_events_total[30s])), 1)'),
      q("sum(rate(http_request_duration_seconds_count[15s]))"),
      q("sum(rabbitmq_queue_messages_ready)"),
      q("sum(rabbitmq_queue_messages_unacked)"),
      q("sum(rate(engagement_events_published_total[15s]))"),
      q("sum(rate(engagement_events_processed_total[15s]))"),
    ]);

  return {
    p50_ms: p50 == null ? null : Math.round(p50 * 1000 * 10) / 10,
    p99_ms: p99 == null ? null : Math.round(p99 * 1000 * 10) / 10,
    cacheHitRate: hitRate == null ? null : Math.round(hitRate * 1000) / 10, // percent
    rps: rps == null ? null : Math.round(rps),
    backlog: backlog == null ? null : Math.round(backlog),
    unacked: unacked == null ? null : Math.round(unacked),
    eventsPublished: evPub == null ? null : Math.round(evPub),
    eventsProcessed: evProc == null ? null : Math.round(evProc),
  };
}

export type Snapshot = Awaited<ReturnType<typeof metricsSnapshot>>;
