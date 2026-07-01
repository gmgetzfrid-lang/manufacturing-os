-- 20260817_read_understood.sql
--
-- Read-&-understood (training acknowledgment). When a controlled document is
-- ISSUED, the people who actually do that work must attest "I have read and
-- understood Rev N" — tracked PER PERSON, PER REVISION. This is the proof-of-
-- training an OSHA PSM (§1910.119) / ISO 9001 (§7.2) audit asks for.
--
-- Design principle enforced here: the acknowledgment state is a first-class
-- data model, NOT a column a user might forget to add. The roster below is the
-- source of truth; the pill, the optional list column, the inbox queue, and the
-- daily notification scan all read from it. Completion is ALWAYS computed from
-- these rows (signed vs required) — never cached in a way that can drift.
--
-- Additive + idempotent. Dated after 20260816 so it applies last.

-- ── Who must acknowledge — a policy that inherits doc > folder > library ──────
-- Mirrors review_policy (20260630_review_cycles). Shape (JSONB):
--   { enabled: bool, assigneeIds: uuid[], assigneeRoles: text[], hardGate?: bool }
-- assigneeRoles are org roles (e.g. 'Operator') expanded to their members at
-- issue time; hardGate (optional) marks the rev "pending acknowledgment" until
-- everyone has signed.
ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS ack_policy JSONB;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS ack_policy JSONB;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS ack_policy JSONB;

-- ── The roster: one row per (document revision, assignee) ─────────────────────
-- Created when a rev is issued under an ack policy. A signature links back via
-- signature_id (the immutable proof lives in e_signatures). Superseding a rev
-- voids the prior rev's still-pending rows and opens a fresh roster.
CREATE TABLE IF NOT EXISTS document_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  -- The exact revision the person must acknowledge (snapshotted so it survives
  -- the document revving forward, matching the transmittals denormalization).
  document_version_id UUID,
  revision_label TEXT,
  content_hash TEXT,                       -- the file_hash of that version, for audit binding

  assignee_user_id UUID NOT NULL,
  assignee_name TEXT,
  assignee_role TEXT,                      -- set when the row came from a role expansion
  source TEXT NOT NULL DEFAULT 'person'    -- 'person' | 'role'
    CHECK (source IN ('person','role')),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','acknowledged','waived','void')),
  signature_id UUID,                       -- e_signatures.id once signed
  acknowledged_at TIMESTAMPTZ,

  -- Waiver path: the owner/controller excuses an assignee (left the role, etc.)
  -- WITHOUT it silently counting as done — a waiver is an explicit, logged act.
  waived_by UUID,
  waived_reason TEXT,

  assigned_by UUID,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,                 -- re-nudge watermark for the daily scan

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One roster row per person per revision — makes re-expansion idempotent. (A row
-- is only inserted with a non-null document_version_id, so NULL-distinctness in
-- the unique index is a non-issue.)
CREATE UNIQUE INDEX IF NOT EXISTS doc_ack_unique_idx
  ON document_acknowledgments(document_id, document_version_id, assignee_user_id);
-- "What do I still owe?" — the inbox queue + per-person nudges.
CREATE INDEX IF NOT EXISTS doc_ack_assignee_idx
  ON document_acknowledgments(org_id, assignee_user_id, status);
-- "Who's outstanding on this doc?" — the roster panel + completion count.
CREATE INDEX IF NOT EXISTS doc_ack_doc_idx
  ON document_acknowledgments(document_id, status);
-- The daily scan only cares about still-pending rows.
CREATE INDEX IF NOT EXISTS doc_ack_pending_idx
  ON document_acknowledgments(org_id, status) WHERE status = 'pending';

ALTER TABLE document_acknowledgments ENABLE ROW LEVEL SECURITY;
-- Member-all (mirrors transmittals / markup_requests): who may assign/waive is
-- enforced app-side; the immutable PROOF is the e_signature (self-insert only),
-- so a roster row is only ever a pointer to that proof.
DROP POLICY IF EXISTS "doc_ack_member_all" ON document_acknowledgments;
CREATE POLICY "doc_ack_member_all" ON document_acknowledgments
  FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id AND uid = auth.uid() AND status = 'active'));

-- ── Drawn ("sign your name") signature image ─────────────────────────────────
-- e_signatures already binds intent + content_hash; this adds the optional
-- touchpad-drawn signature (stored as a data URL) alongside the typed name.
ALTER TABLE e_signatures ADD COLUMN IF NOT EXISTS signature_image TEXT;
