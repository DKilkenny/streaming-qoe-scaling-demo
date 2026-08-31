import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db";
import { getOrSet } from "../lib/cache";
import { touchSession } from "../lib/sessions";

// POST /playback/start — authorize + prepare a playback session. Its measured
// latency is Video Start Time (VST). Cache-first entitlement/title lookup keeps
// it fast (SLO p95 < 100ms) and independent of the beacon write path.
export async function playbackRoutes(app: FastifyInstance) {
  app.post<{ Body: { titleId?: string } }>("/playback/start", async (req, reply) => {
    const titleId = req.body?.titleId;
    if (!titleId) return reply.code(400).send({ error: "missing_title" });

    // Entitlement check == the title exists and is playable. Cache-first.
    const title = await getOrSet(`entitle:${titleId}`, `entitle:${titleId}`, async () => {
      const { rows } = await pool.query(
        `SELECT id, slug, title, kind FROM titles WHERE id = $1`,
        [titleId]
      );
      return rows[0] ?? null;
    });
    if (!title) return reply.code(404).send({ error: "not_entitled" });

    const sessionId = randomUUID();
    await touchSession(sessionId);
    return reply.code(200).send({ sessionId, title });
  });
}
