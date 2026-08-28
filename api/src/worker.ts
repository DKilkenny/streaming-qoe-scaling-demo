import { getChannel } from "./lib/rabbit";
import { pool, waitForDb } from "./lib/db";
import { eventsProcessed } from "./telemetry";
import { startMetricsServer } from "./lib/metricsServer";
import { config } from "./config";

// Weights that turn raw engagement into a trending score. A completion is worth
// more than a play; a play more than a scrub. Deliberately simple — the point is
// a real write path under load, not a real recommender.
const SCORE: Record<string, number> = { play: 1, progress: 0.2, complete: 3 };

export async function startWorker() {
  startMetricsServer(config.port); // expose worker counters for Prometheus
  await waitForDb();
  const channel = await getChannel();
  await channel.prefetch(config.workerPrefetch);

  // eslint-disable-next-line no-console
  console.log(`[worker] consuming '${config.engagementQueue}'`);

  await channel.consume(config.engagementQueue, async (msg) => {
    if (!msg) return;
    try {
      const { titleId, type } = JSON.parse(msg.content.toString());
      const score = SCORE[type] ?? 0;

      await pool.query(
        `INSERT INTO title_stats (title_id, view_count, completion_count, trending_score, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (title_id) DO UPDATE SET
           view_count       = title_stats.view_count + $2,
           completion_count = title_stats.completion_count + $3,
           trending_score   = title_stats.trending_score + $4,
           updated_at       = now()`,
        [titleId, type === "play" ? 1 : 0, type === "complete" ? 1 : 0, score]
      );

      eventsProcessed.labels(type).inc();
      channel.ack(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] processing error:", (err as Error).message);
      channel.nack(msg, false, false); // drop poison messages
    }
  });
}
