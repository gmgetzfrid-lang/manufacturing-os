-- Review cycles ────────────────────────────────────────────────────────────
-- Controlled documents (especially procedures) must be periodically reviewed to
-- stay valid: ISO 9001:2015 §7.5 requires keeping documented information current
-- and re-approved "as necessary", and OSHA PSM 29 CFR 1910.119(f)(3) requires
-- operating procedures be certified current/accurate annually. A review policy
-- can be attached to a LIBRARY, a FOLDER (collection), or a single DOCUMENT; the
-- most specific one wins (document > folder > library), and any level can set
-- enabled:false to opt out of an inherited cycle.
--
-- The per-document review STATE is denormalized onto `documents` so it's cheap
-- to badge, sort by, and scan for due/overdue without walking the policy chain.

-- Inheritable policy (interval / lead time / extra reviewers) as JSON per level.
ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS review_policy JSONB;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS review_policy JSONB;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS review_policy JSONB;

-- Per-document review state.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_reviewed_at   TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_reviewed_by   UUID;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS next_review_date   DATE;
-- Anti-spam: when the last due/overdue notice went out for this document.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_notified_at TIMESTAMPTZ;

-- Fast lookup for the due/overdue scan and the review-queue column sort.
CREATE INDEX IF NOT EXISTS documents_next_review_idx
  ON documents (org_id, next_review_date) WHERE next_review_date IS NOT NULL;

-- Audit trail of reviews / certifications / policy changes (auditors require it).
CREATE TABLE IF NOT EXISTS document_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  document_id UUID NOT NULL,
  action TEXT NOT NULL,           -- 'reviewed' | 'certified' | 'policy_set' | 'issued'
  outcome TEXT,                   -- 'no_change' | 'minor' | 'needs_revision' | null
  note TEXT,
  next_review_date DATE,          -- the next-due date this event set
  performed_by UUID,
  performed_by_name TEXT,
  performed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS document_review_events_doc_idx
  ON document_review_events (document_id, performed_at DESC);
