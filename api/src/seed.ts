// Seeds a synthetic catalog. Run once after the stack is up:
//   docker compose run --rm -e ROLE=seed api node dist/seed.js
// Titles are invented (family / faith / adventure flavored) so no real film
// ever has fabricated numbers attached to it.
import { pool, waitForDb } from "./lib/db";

const GENRES = [
  "Drama",
  "Family",
  "Documentary",
  "Comedy",
  "Adventure",
  "Faith",
  "Historical",
  "Animation",
];

const NOUNS = [
  "Lantern",
  "Harvest",
  "Compass",
  "Ember",
  "Homestead",
  "Covenant",
  "Frontier",
  "Beacon",
  "Sparrow",
  "Anchor",
  "Meridian",
  "Threshold",
  "Wayfarer",
  "Kindling",
  "Bastion",
  "Willow",
  "Redwood",
  "Summit",
];

const ADJ = [
  "Silent",
  "Golden",
  "Distant",
  "Rising",
  "Hidden",
  "Bright",
  "Last",
  "First",
  "Quiet",
  "Fearless",
  "Faithful",
  "Wandering",
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  await waitForDb();

  const { rows } = await pool.query("SELECT count(*)::int AS n FROM titles");
  if (rows[0].n > 0) {
    // eslint-disable-next-line no-console
    console.log(`[seed] catalog already has ${rows[0].n} titles, skipping`);
    await pool.end();
    return;
  }

  const target = 120;
  const seen = new Set<string>();
  let inserted = 0;

  for (let i = 0; i < target * 3 && inserted < target; i++) {
    const title = `The ${ADJ[i % ADJ.length]} ${
      NOUNS[(i * 7) % NOUNS.length]
    }${i % 5 === 0 ? " II" : ""}`;
    const slug = slugify(title);
    if (seen.has(slug)) continue;
    seen.add(slug);

    const genre = GENRES[i % GENRES.length];
    const kind = i % 3 === 0 ? "series" : "movie";
    const year = 2016 + (i % 10);
    const heroImage = `https://picsum.photos/seed/${slug}/640/360`;
    const description = `A ${genre.toLowerCase()} story about courage, family, and the light people carry into hard places.`;

    const res = await pool.query(
      `INSERT INTO titles (slug, title, kind, genre, year, description, hero_image)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [slug, title, kind, genre, year, description, heroImage]
    );
    if (res.rows[0]) {
      // Baseline stats so the Trending rail has signal before any load runs.
      const views = Math.floor(Math.random() * 5000);
      const completions = Math.floor(views * (0.3 + Math.random() * 0.5));
      const trending = views * 0.01 + completions * 0.05 + Math.random() * 50;
      await pool.query(
        `INSERT INTO title_stats (title_id, view_count, completion_count, trending_score)
         VALUES ($1,$2,$3,$4)`,
        [res.rows[0].id, views, completions, trending]
      );
      inserted++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] inserted ${inserted} titles`);
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[seed] failed:", err);
  process.exit(1);
});
