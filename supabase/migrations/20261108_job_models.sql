-- 20261108_job_models.sql
--
-- Which model each AI job runs on. ai_connections.model stays the main
-- model; job_models points single jobs elsewhere, e.g.
--   {"knowledge": "<model id>", "reading": "main"}
-- ("main" = the main model). A job not listed keeps its own default.

ALTER TABLE ai_connections ADD COLUMN IF NOT EXISTS job_models JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN ai_connections.job_models IS 'Model per AI job (lib/ai/jobModels): knowledge, shiftNotes, reading, drafting, projectDocs. "main" = ai_connections.model.';

NOTIFY pgrst, 'reload schema';
