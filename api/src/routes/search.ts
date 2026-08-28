import { FastifyInstance } from "fastify";
import { pool } from "../lib/db";
import { getOrSet } from "../lib/cache";

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) {
      return reply.code(400).send({ error: "query_too_short" });
    }
    // Short TTL: search results tolerate a little staleness but the long tail of
    // distinct queries means we cache per-normalized-term to keep hit rate real.
    const key = `search:${q.toLowerCase()}`;
    return getOrSet(
      "search",
      key,
      async () => {
        const { rows } = await pool.query(
          `SELECT id, slug, title, kind, genre, year, hero_image
           FROM titles
           WHERE title ILIKE $1 OR genre ILIKE $1
           ORDER BY title
           LIMIT 20`,
          [`%${q}%`]
        );
        return { query: q, results: rows };
      },
      10
    );
  });
}
