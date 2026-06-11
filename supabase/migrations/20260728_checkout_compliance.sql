-- 20260728_checkout_compliance.sql
-- Checkout system compliance pass:
--
--   1. Backfill checkout_sessions.library_id from the document — sessions with
--      a NULL library_id made the inbox "My Checkouts" link point at the
--      documents root instead of the document.
--   2. Backfill purpose from the free-text note for historical sessions, so
--      the new "who has this and why" surfaces aren't blank for old rows.
--
-- (Going forward the app REQUIRES purpose + reason at checkout, writes both,
-- and audit-logs DOCUMENT_CHECKOUT / DOCUMENT_CHECKIN.)
--
-- Additive + idempotent.

UPDATE checkout_sessions cs
   SET library_id = d.library_id
  FROM documents d
 WHERE cs.document_id = d.id
   AND cs.library_id IS NULL
   AND d.library_id IS NOT NULL;

UPDATE checkout_sessions
   SET purpose = note
 WHERE purpose IS NULL
   AND note IS NOT NULL;
