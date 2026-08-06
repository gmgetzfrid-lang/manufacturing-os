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

ALTER TABLE knowledge_line_traces
  ADD COLUMN IF NOT EXISTS method TEXT,
  -- Turn count is a cheap sanity signal: a "trace" with implausibly many
  -- direction changes is line-work wandering, not a pipe run.
  ADD COLUMN IF NOT EXISTS turns INTEGER;
