import { FastifyInstance } from "fastify";
import { getChannel } from "../lib/rabbit";
import { beaconsPublished } from "../telemetry";
import { config } from "../config";
import { touchSession, endSession } from "../lib/sessions";

const VALID = new Set(["play", "progress", "complete", "rebuffer", "error"]);

type Body = {
  sessionId?: string;
  titleId?: string;
  type?: string;
  position?: number;
};

export async function beaconRoutes(app: FastifyInstance) {
  // QoE beacon ingest. Off the hot path: accept fast, enqueue for the worker to
  // aggregate, return 202. Session liveness (for concurrent-streams) is updated
  // here in Redis so it stays real-time even when the beacon backlog grows.
  app.post<{ Body: Body }>("/qoe/beacon", async (req, reply) => {
    const { sessionId, titleId, type, position } = req.body ?? {};
    if (!titleId || !type || !VALID.has(type)) {
      return reply.code(400).send({ error: "invalid_beacon" });
    }

    if (sessionId) {
      if (type === "complete" || type === "error") await endSession(sessionId);
      else await touchSession(sessionId); // play / progress / rebuffer keep it live
    }

    const channel = await getChannel();
    const payload = Buffer.from(
      JSON.stringify({ titleId, type, position: position ?? 0, ts: Date.now() })
    );
    channel.sendToQueue(config.qoeQueue, payload, { persistent: true });
    beaconsPublished.labels(type).inc();

    return reply.code(202).send({ accepted: true });
  });
}
