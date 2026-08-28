import { FastifyInstance } from "fastify";
import { getChannel } from "../lib/rabbit";
import { eventsPublished } from "../telemetry";
import { config } from "../config";

const VALID = new Set(["play", "progress", "complete"]);

type Body = { titleId?: string; type?: string; position?: number };

export async function eventRoutes(app: FastifyInstance) {
  // Write path off the hot path: accept fast, enqueue, return 202. The worker
  // does the Postgres aggregation. This is what keeps read latency flat while
  // engagement volume spikes, and what makes queue depth an observable signal.
  app.post<{ Body: Body }>("/events", async (req, reply) => {
    const { titleId, type, position } = req.body ?? {};
    if (!titleId || !type || !VALID.has(type)) {
      return reply.code(400).send({ error: "invalid_event" });
    }

    const channel = await getChannel();
    const payload = Buffer.from(
      JSON.stringify({ titleId, type, position: position ?? 0, ts: Date.now() })
    );
    channel.sendToQueue(config.engagementQueue, payload, { persistent: true });
    eventsPublished.labels(type).inc();

    return reply.code(202).send({ accepted: true });
  });
}
