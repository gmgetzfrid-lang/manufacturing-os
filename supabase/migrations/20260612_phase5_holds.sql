-- 20260612_phase5_holds.sql
--
-- Phase 5 — Hold tracking & roadblock metrics.
--
-- A "hold" is an explicit operational stop on a document: it can't
-- be advanced until the blocker is cleared. Until now, this state
-- lived only in chat threads, sticky notes, and people's memory.
-- Putting it in the data model makes:
--
--   - "What's blocking this drawing?" answerable in one query
--   - "How long did this hold last?" automatic via released_at - opened_at
--   - "What's the most common blocker this quarter?" a GROUP BY away
--   - "Show me everything still blocked on Vendor Data >7 days"
--     a single search
--
-- Design choices:
--
-- 1. document_holds is a per-document log, NOT a single-column flag.
--    Multiple holds can be open on the same document simultaneously
--    (typical: "Awaiting Engineering" AND "Missing Vendor Data").
--    released_at = NULL means active.
--
-- 2. Partial UNIQUE on (document_id, reason) WHERE released_at IS NULL
--    prevents accidentally opening two of the same hold. Re-opening
--    a previously-released hold is fine — it gets a new row.
--
-- 3. reason is TEXT with NO check constraint. The four directive-named
--    reasons (Awaiting Engineering / Field Verification Needed /
--    Missing Vendor Data / Client Review) live in the UI's predefined
--    picker; orgs can also enter free-form reasons via "Other". The
--    DB is intentionally permissive — operations vocabulary varies
--    by site and locking the schema would force migrations for
--    every new blocker type.
--
-- 4. Audit row is written by the application (lib/holds.ts) using the
--    existing audit_logs flow, not by a trigger. That keeps the audit
--    actor accurate (we know who pressed the button) instead of
--    fabricating it from session_user.
--
-- 5. No FK to a "current holds" cached column on documents. The
--    listActiveHoldsByDocument query is cheap (partial index) and
--    avoids a denormalized-flag drift problem.

CREATE TABLE IF NOT EXISTS document_holds (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id           UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reason                TEXT NOT NULL,
  notes                 TEXT,
  expected_release_at   TIMESTAMPTZ,
  opened_by             UUID NOT NULL,
  opened_by_name        TEXT,
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by           UUID,
  released_by_name      TEXT,
  released_at           TIMESTAMPTZ,
  released_reason       TEXT
);

-- Single document, single hot reason, single active row at a time.
CREATE UNIQUE INDEX IF NOT EXISTS document_holds_open_reason_uniq
  ON document_holds(document_id, reason) WHERE released_at IS NULL;

-- "Active holds on this document" — covers the inspector strip.
CREATE INDEX IF NOT EXISTS document_holds_active_doc_idx
  ON document_holds(document_id) WHERE released_at IS NULL;

-- "Org-wide active queue" + "by reason" — covers the bottleneck dashboard.
CREATE INDEX IF NOT EXISTS document_holds_active_org_idx
  ON document_holds(org_id, opened_at DESC) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS document_holds_org_reason_idx
  ON document_holds(org_id, reason);

-- Aggregation index for duration metrics over completed holds.
CREATE INDEX IF NOT EXISTS document_holds_org_released_idx
  ON document_holds(org_id, released_at) WHERE released_at IS NOT NULL;

-- RLS — org-member-all, mirroring the established pattern.
ALTER TABLE document_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_holds_member_all" ON document_holds;
CREATE POLICY "document_holds_member_all" ON document_holds
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_holds.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_holds.org_id AND uid = auth.uid() AND status = 'active'));
