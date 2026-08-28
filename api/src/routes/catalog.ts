import { FastifyInstance } from "fastify";
import { pool } from "../lib/db";
import { getOrSet } from "../lib/cache";

export async function catalogRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/titles/:id", async (req, reply) => {
    const { id } = req.params;
    const title = await getOrSet(`title:${id}`, `title:${id}`, async () => {
      const { rows } = await pool.query(
        `SELECT t.id, t.slug, t.title, t.kind, t.genre, t.year, t.description,
                t.hero_image,
                COALESCE(s.view_count, 0)       AS view_count,
                COALESCE(s.completion_count, 0) AS completion_count,
                COALESCE(s.trending_score, 0)   AS trending_score
         FROM titles t
         LEFT JOIN title_stats s ON s.title_id = t.id
         WHERE t.id = $1`,
        [id]
      );
      return rows[0] ?? null;
    });

    if (!title) return reply.code(404).send({ error: "not_found" });
    return title;
  });
}
