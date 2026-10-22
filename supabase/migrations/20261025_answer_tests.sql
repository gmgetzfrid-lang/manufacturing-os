-- 20261025_answer_tests.sql
--
-- Proof that answers are getting better, measured instead of claimed.
--
--   knowledge_ask_traces   the research record behind every answer: the
--                          queries written, what each search returned, what
--                          reached the model, what it cited. Ids, pages and
--                          short snippets only — never whole passages.
--   knowledge_eval_cases   questions an engineer has marked with what a right
--                          answer must contain, cite, and never do.
--   knowledge_eval_runs    one press of "Run tests": which engine version,
--                          what it cost, how many passed.
--   knowledge_eval_results each case's answer in that run and every check.
--
-- Every write goes through the server (service role). Members read their own
-- traces; document controllers (Admin/DocCtrl) read their org's traces and
-- everything about tests.

-- ── Research records ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_ask_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID,
  user_id UUID,
  question_id UUID,
  eval_run_id UUID,
  question TEXT,
  status INTEGER,
  error TEXT,
  engine_version TEXT,
  trace JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_ask_traces_org_idx ON knowledge_ask_traces (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_ask_traces_question_idx ON knowledge_ask_traces (question_id) WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_ask_traces_run_idx ON knowledge_ask_traces (eval_run_id) WHERE eval_run_id IS NOT NULL;

ALTER TABLE knowledge_ask_traces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_ask_traces_select ON knowledge_ask_traces;
CREATE POLICY knowledge_ask_traces_select ON knowledge_ask_traces FOR SELECT USING (
  user_id = auth.uid() OR is_org_controller(org_id)
);

-- Records are for diagnosis, not an archive: 90 days, cleared by the daily
-- maintenance job (DELETE … WHERE created_at < now() - interval '90 days').

-- ── Test cases ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_eval_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL,
  question TEXT NOT NULL,
  -- What a right answer must do. Pages are named by DOCUMENT NAME pattern,
  -- because re-indexing changes ids:
  --   { mustCite: [{ document, page, tolerance }], mustContain: [...],
  --     mustNot: [failure codes or phrases], askedClass: "150",
  --     termRules: [{ term, mustNotEquate: [...] }] }
  expect JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_question_id UUID,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  notes TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_eval_cases_org_idx ON knowledge_eval_cases (org_id, library_id, status);

CREATE TABLE IF NOT EXISTS knowledge_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID,
  engine_version TEXT,
  scope TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','stopped')),
  stop_reason TEXT,
  started_by UUID,
  started_by_name TEXT,
  cost_cap_usd NUMERIC NOT NULL DEFAULT 5,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  is_baseline BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS knowledge_eval_runs_org_idx ON knowledge_eval_runs (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_eval_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES knowledge_eval_runs(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES knowledge_eval_cases(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  answer TEXT,
  citations JSONB,
  trace_id UUID,
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  pass BOOLEAN,
  cost_usd NUMERIC,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, case_id)
);
CREATE INDEX IF NOT EXISTS knowledge_eval_results_case_idx ON knowledge_eval_results (case_id, created_at DESC);

ALTER TABLE knowledge_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_eval_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_eval_cases_select ON knowledge_eval_cases;
CREATE POLICY knowledge_eval_cases_select ON knowledge_eval_cases FOR SELECT USING (is_org_controller(org_id));
DROP POLICY IF EXISTS knowledge_eval_runs_select ON knowledge_eval_runs;
CREATE POLICY knowledge_eval_runs_select ON knowledge_eval_runs FOR SELECT USING (is_org_controller(org_id));
DROP POLICY IF EXISTS knowledge_eval_results_select ON knowledge_eval_results;
CREATE POLICY knowledge_eval_results_select ON knowledge_eval_results FOR SELECT USING (is_org_controller(org_id));

-- ── Why an answer was wrong ─────────────────────────────────────────────
-- A thumbs-down can say what went wrong, in the same terms the tests check.
ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS feedback_reasons TEXT[];
ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS feedback_note TEXT;
