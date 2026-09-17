-- ============================================================================
-- RETIRED — DO NOT RUN. (DB-8, roles-and-permissions Round E, 2026-09-17)
-- ============================================================================
-- This file was a catch-up bundle of the migrations up to 2026-05-28
-- (search vectors, asset/document resync triggers, member policies).
--
-- It was a SECOND SOURCE OF TRUTH: every statement was CREATE OR REPLACE /
-- DROP+CREATE, frozen on the day it was written, so a re-run after later
-- migrations silently restored the frozen bodies over the live hardening —
-- no error, no record. On the day of retirement it forked from the numbered
-- sequence at: the three checkout_messages policies
-- (live: 20260727 and 20261046 — checkout_messages_own_update now reads the
-- role collection) — 3 of its 31 definitions; the other 28 were byte-identical
-- copies of numbered migrations.
--
-- The numbered files in supabase/migrations/ (NNNNNNNN_*.sql, applied in
-- order) are the ONLY source of truth. lib/__tests__/migrationSourceOfTruth
-- .test.ts fails the build if this file — or any file outside the numbered
-- sequence — defines a function, policy or trigger again.
--
-- Everything it carried is present in the numbered sequence.
-- The original text remains in git history (4e37340 and earlier). This stub
-- is deliberately kept so a bookmark, runbook or habit that still points here
-- meets a loud refusal instead of a silent revert.
-- ============================================================================

DO $$
BEGIN
  RAISE EXCEPTION 'RETIRED (DB-8): this script is no longer a source of truth. Apply the numbered files in supabase/migrations/ in order instead.';
END $$;
