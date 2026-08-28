import { FastifyInstance } from "fastify";
import { pool } from "../lib/db";
import { getOrSet } from "../lib/cache";

type Row = {
  id: string;
  slug: string;
  title: string;
  kind: string;
  genre: string;
  year: number;
  hero_image: string;
};

async function rail(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function discoverRoutes(app: FastifyInstance) {
  // Home-screen rails. Cache-first: this is the single most requested response
  // in a streaming app, so it is the response the cache exists to protect.
  app.get<{ Querystring: { genre?: string } }>("/discover", async (req) => {
    const genre = (req.query.genre ?? "all").toLowerCase();
    const key = `discover:${genre}`;

    return getOrSet(key, key, async () => {
      const cols =
        "id, slug, title, kind, genre, year, hero_image";

      const [trending, fresh, forYou] = await Promise.all([
        rail(
          `SELECT ${cols} FROM titles t
           JOIN title_stats s ON s.title_id = t.id
           ORDER BY s.trending_score DESC, s.view_count DESC
           LIMIT 12`
        ),
        rail(
          `SELECT ${cols} FROM titles
           ORDER BY year DESC, created_at DESC
           LIMIT 12`
        ),
        genre === "all"
          ? rail(
              `SELECT ${cols} FROM titles
               ORDER BY random() LIMIT 12`
            )
          : rail(
              `SELECT ${cols} FROM titles
               WHERE lower(genre) = $1
               ORDER BY random() LIMIT 12`,
              [genre]
            ),
      ]);

      return {
        rails: [
          { key: "trending", label: "Trending Now", titles: trending },
          { key: "new", label: "New & Noteworthy", titles: fresh },
          {
            key: "for_you",
            label: genre === "all" ? "For You" : `More ${genre}`,
            titles: forYou,
          },
        ],
      };
    });
  });
}
