-- 20261012_doc_class_and_checkin_outcomes.sql
--
-- Two small pillars for the check-in redesign:
--
-- 1. DOCUMENT CLASS — the declared kind of a controlled document, resolved
--    document -> collection -> library (most specific DEFINED level wins),
--    exactly like review_control. It drives change-control routing:
--      'drawing'   — CAD-controlled (P&IDs, isometrics, layouts). Changes are
--                    drafted, never typed: check-in routes redlines to a
--                    drafting request, and a non-minor publish REQUIRES an MOC
--                    reference (OSHA 1910.119(l) management of change).
--      'procedure' — text-controlled (procedures, policies, forms). The
--                    effective owner / per-library publishers release
--                    revisions directly (through the review gate if one is
--                    configured). No MOC demanded by class.
--    NULL = inherit (and a NULL chain = unclassified: behaves like today).
--
-- 2. CHECK-IN OUTCOMES — the honest register: every deliberate check-in
--    records WHAT CAME OF IT, not just that it ended.
--      outcome:      'all_clear' | 'field_verified' | 'discrepancy'
--                    | 'correction_requested' | 'revision_requested'
--                    | 'published' | 'submitted_for_review'
--                    | 'sent_to_owner' | 'handoff' | 'auto_released'
--                    (TEXT by design — same convention-not-constraint approach
--                    as checkout_sessions.status; the app is the vocabulary.)
--      outcome_note: the typed "why" for claim-creating outcomes.
--      outcome_ref:  JSONB pointers to what the check-in spawned:
--                    { ticketId, ticketNumber, versionId, revisionLabel,
--                      holdId, moc: { status, number } }

ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS doc_class TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS doc_class TEXT;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS doc_class TEXT;

COMMENT ON COLUMN libraries.doc_class   IS 'Declared document class: drawing | procedure. NULL = unclassified.';
COMMENT ON COLUMN collections.doc_class IS 'Folder-level doc_class override. NULL = inherit from library.';
COMMENT ON COLUMN documents.doc_class   IS 'Document-level doc_class override. NULL = inherit from folder/library.';

ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS outcome_note TEXT;
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS outcome_ref JSONB;

COMMENT ON COLUMN checkout_sessions.outcome      IS 'What came of this checkout (check-in register): all_clear | field_verified | discrepancy | correction_requested | revision_requested | published | submitted_for_review | sent_to_owner | handoff | auto_released.';
COMMENT ON COLUMN checkout_sessions.outcome_note IS 'The typed reason recorded with a claim-creating outcome.';
COMMENT ON COLUMN checkout_sessions.outcome_ref  IS 'Pointers to what the check-in spawned: ticket / version / hold / MOC reference.';

-- Field-verification attestations and outcome reporting query by document +
-- outcome ("who last verified this P&ID against the field?").
CREATE INDEX IF NOT EXISTS checkout_sessions_outcome_idx
  ON checkout_sessions (document_id, outcome)
  WHERE outcome IS NOT NULL;
