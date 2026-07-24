-- 20260819_effective_date.sql
--
-- Effective date. A controlled revision can be ISSUED (approved/published) today
-- but only become EFFECTIVE (in force) on a later date — e.g. a procedure that
-- takes effect after its training window. This is a standard doc-control field,
-- distinct from the issue date.
--
-- Scoped as a date + badge + notification: the revision is still the current
-- controlled version (which rev is served does NOT change); it simply shows
-- "Effective <date>" until the day arrives, then flips automatically and the
-- owner + acknowledgment assignees are told it's now in force.
--
-- Additive + idempotent. Dated after 20260818.

-- The date a version becomes/​became effective. NULL = effective immediately on
-- release (today's behavior for every existing row).
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS effective_date DATE;

-- Denormalized onto the document (the current version's effective date) so the
-- pill, the sortable column, the register, and the daily scan are all cheap.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS effective_date DATE;
-- Watermark so the "now in effect" notice fires once, not every scan that day.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS effective_notified_at TIMESTAMPTZ;

-- The scan looks up documents whose effective date has arrived but not yet
-- announced.
CREATE INDEX IF NOT EXISTS documents_effective_date_idx
  ON documents(org_id, effective_date) WHERE effective_date IS NOT NULL;
