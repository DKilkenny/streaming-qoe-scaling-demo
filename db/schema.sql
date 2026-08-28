-- Applied automatically by Postgres initdb on first boot.

CREATE TABLE IF NOT EXISTS titles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- 'movie' | 'series'
  genre       TEXT NOT NULL,
  year        INT  NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  hero_image  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS title_stats (
  title_id         UUID PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
  view_count       BIGINT NOT NULL DEFAULT 0,
  completion_count BIGINT NOT NULL DEFAULT 0,
  trending_score   DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stats_trending ON title_stats (trending_score DESC, view_count DESC);
CREATE INDEX IF NOT EXISTS idx_titles_year    ON titles (year DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_titles_genre   ON titles (lower(genre));
