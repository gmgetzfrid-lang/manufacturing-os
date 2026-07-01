-- 20260818_review_before_publish.sql
--
-- Review & approval BEFORE publish (the 2A -> 2B -> 2 lifecycle). In a library
-- configured to require it, a non-minor, non-ticket rev-up does NOT go live
-- immediately: it opens an in-review DRAFT (labeled 2A) that required reviewers
-- must e-sign before it publishes as the clean controlled Rev 2. The currently
-- published rev stays the controlled copy the whole time.
--
-- Keyed off a per-library "change-control mode" (Admin/DocCtrl sets it; folders/
-- documents can override). Two escape hatches always apply, enforced in the app:
-- a Minor change and a rev that originated from a drafting ticket skip the gate.
--
-- Additive + idempotent. Dated after 20260817 so it applies last.

-- ── The change-control policy (inherits document > folder > library) ──────────
-- Shape (JSONB):
--   { mode: 'require' | 'publisher_choice' | 'none',
--     reviewerIds: uuid[], reviewerRoles: text[],       -- primary reviewers
--     alternateIds: uuid[], alternateRoles: text[],     -- backups (timeout / out)
--     timeoutDays?: int,                                -- auto-activate alternates after this
--     draftViewerIds?: uuid[], draftViewerRoles?: text[], -- extra in-review draft viewers
--     useRevLetters?: bool }                            -- auto 2A/2B suffix (default true)
-- Absent = mode 'none' = today's behavior (publish is immediate). Fully additive.
ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS review_control JSONB;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS review_control JSONB;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS review_control JSONB;

-- The in-review draft version pointer. The document keeps its current_version_id
-- (the live controlled copy) untouched while a draft is under review here.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pending_version_id UUID;

-- A version can be an in-review draft or an approved-and-promoted revision.
-- NULL = an ordinary published/superseded version (unchanged existing rows).
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS review_state TEXT
  CHECK (review_state IN ('in_review', 'approved'));
-- The numeric target the in-review letter resolves to on publish (e.g. '2' for '2A').
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS base_rev TEXT;

-- ── The reviewer roster: one row per (draft version, reviewer) ────────────────
-- A primary reviewer counts toward the required sign-off total; an alternate is a
-- backup that only becomes eligible (activated) after the timeout or a manual
-- Admin/DocCtrl activation, then their signature also counts toward the total.
CREATE TABLE IF NOT EXISTS document_review_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  document_version_id UUID,           -- the in-review draft the sign-off is for
  revision_label TEXT,                -- snapshot e.g. '2A'
  content_hash TEXT,                  -- the exact draft bytes the reviewer signs against

  reviewer_user_id UUID NOT NULL,
  reviewer_name TEXT,
  reviewer_role TEXT,
  slot TEXT NOT NULL DEFAULT 'primary'
    CHECK (slot IN ('primary', 'alternate')),
  source TEXT NOT NULL DEFAULT 'person'
    CHECK (source IN ('person', 'role')),

  -- Primaries are active immediately; alternates start inactive and are turned on
  -- by the timeout scan or an explicit early-activation.
  activated BOOLEAN NOT NULL DEFAULT true,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'signed', 'invalidated', 'void')),
  signature_id UUID,                  -- e_signatures.id once signed
  signed_at TIMESTAMPTZ,

  assigned_by UUID,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,            -- re-nudge / timeout watermark
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per reviewer per draft version.
CREATE UNIQUE INDEX IF NOT EXISTS doc_review_signoff_unique_idx
  ON document_review_signoffs(document_version_id, reviewer_user_id);
-- "What reviews do I owe?" — the inbox queue + nudges.
CREATE INDEX IF NOT EXISTS doc_review_signoff_reviewer_idx
  ON document_review_signoffs(org_id, reviewer_user_id, status);
-- "Who's outstanding on this draft?" — the gate panel + completion.
CREATE INDEX IF NOT EXISTS doc_review_signoff_doc_idx
  ON document_review_signoffs(document_id, status);
-- The scan only cares about still-pending sign-offs.
CREATE INDEX IF NOT EXISTS doc_review_signoff_pending_idx
  ON document_review_signoffs(org_id, status) WHERE status = 'pending';

ALTER TABLE document_review_signoffs ENABLE ROW LEVEL SECURITY;
-- Member-all (mirrors document_acknowledgments): who may configure/activate is
-- enforced app-side; the immutable proof is the e_signature (self-insert only).
DROP POLICY IF EXISTS "doc_review_signoff_member_all" ON document_review_signoffs;
CREATE POLICY "doc_review_signoff_member_all" ON document_review_signoffs
  FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id AND uid = auth.uid() AND status = 'active'));
