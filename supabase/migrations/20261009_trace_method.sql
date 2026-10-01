-- 20261009_trace_method.sql
--
-- Record HOW a cached trace was produced.
--
-- A path followed pixel-by-pixel through the drawing's own line-work and a
-- path a model estimated by eye are both "a trace", and an engineer deciding
-- whether to isolate a line deserves to know which one is on screen. Storing
-- the method with the path means the honest label survives caching instead of
-- being re-derived (or quietly lost) on the next viewer.
--
--   'raster' — followed the drawn line. Corners are where the pipe turns.
--   'vision' — the model's estimate. Approximate; a hint, not a route.
--
-- Idempotent. Apply after 20261007.
--
-- intelligence Round G (I-07, DWG-9): 20261007_retire_line_traces.sql sorts
-- BEFORE this file and drops knowledge_line_traces, so replayed in filename
-- order on a fresh database the bare ALTER raised 42P01 (relation does not
-- exist) — ADD COLUMN IF NOT EXISTS guards the column, not the table. The
-- ALTER now runs only while the table exists: unchanged on a database that
-- applied this before the retirement, a no-op on every database after it.

DO $$
BEGIN
  IF to_regclass('public.knowledge_line_traces') IS NOT NULL THEN
    ALTER TABLE knowledge_line_traces
      ADD COLUMN IF NOT EXISTS method TEXT,
      -- Turn count is a cheap sanity signal: a "trace" with implausibly many
      -- direction changes is line-work wandering, not a pipe run.
      ADD COLUMN IF NOT EXISTS turns INTEGER;
  END IF;
END $$;
