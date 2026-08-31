import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db";
import { getOrSet } from "../lib/cache";
import { touchSession } from "../lib/sessions";
import { config } from "../config";

// Simulated per-instance entitlement/license concurrency cap. Requests beyond
// `playbackMaxInflight` wait (async — no CPU busy-loop) for a slot to free,
// and each held slot lasts `playbackCostMs`. This is what makes ONE API
// instance saturate at an achievable RPS and VST climb past it under a
// synchronized playback-start herd — a labeled stand-in for a real
// entitlement/licensing service, not a real one. A no-op when
// `playbackMaxInflight <= 0` (the default).
let inflight = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (config.playbackMaxInflight <= 0) return;
  if (inflight >= config.playbackMaxInflight) {
    await new Promise<void>((r) => waiters.push(r));
  }
  inflight++;
}
function release() {
  if (config.playbackMaxInflight <= 0) return;
  inflight--;
  const next = waiters.shift();
  if (next) next();
}

// POST /playback/start — authorize + prepare a playback session. Its measured
// latency is Video Start Time (VST). Cache-first entitlement/title lookup keeps
// it fast (SLO p95 < 100ms) and independent of the beacon write path.
export async function playbackRoutes(app: FastifyInstance) {
  app.post<{ Body: { titleId?: string } }>("/playback/start", async (req, reply) => {
    const titleId = req.body?.titleId;
    if (!titleId) return reply.code(400).send({ error: "missing_title" });

    await acquire();
    try {
      // Entitlement check == the title exists and is playable. Cache-first.
      const title = await getOrSet(`entitle:${titleId}`, `entitle:${titleId}`, async () => {
        const { rows } = await pool.query(
          `SELECT id, slug, title, kind FROM titles WHERE id = $1`,
          [titleId]
        );
        return rows[0] ?? null;
      });
      if (!title) return reply.code(404).send({ error: "not_entitled" });

      if (config.playbackCostMs > 0) {
        await new Promise((r) => setTimeout(r, config.playbackCostMs));
      }

      const sessionId = randomUUID();
      await touchSession(sessionId);
      return reply.code(200).send({ sessionId, title });
    } finally {
      release();
    }
  });
}
