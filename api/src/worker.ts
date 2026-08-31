import amqp from "amqplib";
import { pool, waitForDb } from "./lib/db";
import { beaconsProcessed } from "./telemetry";
import { startMetricsServer } from "./lib/metricsServer";
import { config } from "./config";

// Weights that turn raw engagement into a trending score. A completion is worth
// more than a play; a play more than a scrub. Deliberately simple — the point is
// a real write path under load, not a real recommender.
const SCORE: Record<string, number> = { play: 1, progress: 0.2, complete: 3 };

type Ch = Awaited<
  ReturnType<Awaited<ReturnType<typeof amqp.connect>>["createChannel"]>
>;

async function handle(channel: Ch, msg: amqp.ConsumeMessage) {
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
    // Simulated downstream processing cost (see config.workerEventMs). This is
    // what makes one worker's throughput finite, so scaling workers matters.
    if (config.workerEventMs > 0) {
      await new Promise((r) => setTimeout(r, config.workerEventMs));
    }
    beaconsProcessed.labels(type).inc();
    channel.ack(msg);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[worker] processing error:", (err as Error).message);
    channel.nack(msg, false, false); // drop poison messages
  }
}

// Consume with automatic reconnect. A dropped connection (laptop sleep, broker
// restart, network blip) is caught and the consumer is re-established, so a
// worker never becomes a running-but-dead zombie.
async function consumeForever() {
  await waitForDb();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const conn = await amqp.connect(config.rabbitUrl);
      const channel = await conn.createChannel();
      await channel.assertQueue(config.qoeQueue, { durable: true });
      await channel.prefetch(config.workerPrefetch);
      // eslint-disable-next-line no-console
      console.log(`[worker] consuming '${config.qoeQueue}'`);

      await new Promise<void>((_resolve, reject) => {
        conn.on("error", () => {});
        conn.on("close", () => reject(new Error("connection closed")));
        channel.on("close", () => reject(new Error("channel closed")));
        channel
          .consume(config.qoeQueue, (msg) => {
            if (msg) void handle(channel, msg);
          })
          .catch(reject);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] consumer lost, reconnecting in 2s:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

export async function startWorker() {
  startMetricsServer(config.port); // expose worker counters for Prometheus
  // Exit promptly on SIGTERM so `docker stop` (scale-down) is fast and clean.
  process.on("SIGTERM", () => process.exit(0));
  await consumeForever();
}
