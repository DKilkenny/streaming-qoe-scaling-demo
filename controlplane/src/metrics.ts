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
  const [p50, p99, hitRate, rps, backlog, unacked, evPub, evProc, vst, concurrent, rebuf, errRate] =
    await Promise.all([
      q("histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket[30s])) by (le))"),
      q("histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[30s])) by (le))"),
      q('sum(rate(cache_events_total{result="hit"}[30s])) / clamp_min(sum(rate(cache_events_total[30s])), 1)'),
      q("sum(rate(http_request_duration_seconds_count[15s]))"),
      q("sum(rabbitmq_queue_messages_ready)"),
      q("sum(rabbitmq_queue_messages_unacked)"),
      q("sum(rate(qoe_beacons_published_total[15s]))"),
      q("sum(rate(qoe_beacons_processed_total[15s]))"),
      q('histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{route="/playback/start"}[30s])) by (le))'),
      q("max(concurrent_streams)"),
      q('sum(rate(qoe_beacons_processed_total{type="rebuffer"}[30s])) / clamp_min(sum(rate(qoe_beacons_processed_total{type=~"play|progress|rebuffer"}[30s])), 1)'),
      q('sum(rate(qoe_beacons_processed_total{type="error"}[30s])) / clamp_min(sum(rate(qoe_beacons_processed_total[30s])), 1)'),
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
    vstP95_ms: vst == null ? null : Math.round(vst * 1000 * 10) / 10,
    concurrentStreams: concurrent == null ? null : Math.round(concurrent),
    rebufferRatio: rebuf == null ? null : Math.round(rebuf * 1000) / 10, // percent
    playbackErrorRate: errRate == null ? null : Math.round(errRate * 1000) / 10, // percent
  };
}

export type Snapshot = Awaited<ReturnType<typeof metricsSnapshot>>;

// Read-tier load signal for the API autoscaler: playback-start rate, distinct
// from the worker autoscaler's beacon-publish signal. Queried separately
// (rather than folded into metricsSnapshot) so /api/status and the api
// scaler loop can each sample it on their own cadence.
export async function readRps(): Promise<number | null> {
  const rps = await q('sum(rate(http_request_duration_seconds_count{route="/playback/start"}[15s]))');
  return rps == null ? null : Math.round(rps);
}
