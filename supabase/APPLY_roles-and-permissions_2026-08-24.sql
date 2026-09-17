-- ============================================================================
-- RETIRED — DO NOT RUN. (DB-8, roles-and-permissions Round E, 2026-09-17)
-- ============================================================================
-- This file was the combined apply script for migrations 20261019–20261025
-- (roles-and-permissions Phase 0–2), pasted once on 2026-08-24.
--
-- It was a SECOND SOURCE OF TRUTH: every statement was CREATE OR REPLACE /
-- DROP+CREATE, frozen on the day it was written, so a re-run after later
-- migrations silently restored the frozen bodies over the live hardening —
-- no error, no record. On the day of retirement it forked from the numbered
-- sequence at: publish_revision (live: 20261049),
-- org_capability_allows (live: 20261052 — the resource-dimension wrapper),
-- document_shares_insert (live: 20261037) and document_shares_update (live:
-- 20261026) — 4 of its 8 definitions.
--
-- The numbered files in supabase/migrations/ (NNNNNNNN_*.sql, applied in
-- order) are the ONLY source of truth. lib/__tests__/migrationSourceOfTruth
-- .test.ts fails the build if this file — or any file outside the numbered
-- sequence — defines a function, policy or trigger again.
--
-- It was applied & verified live on 2026-08-24 (7-point probe, see
-- audit-reports/roles-and-permissions/README.md); that record stands.
-- The original text remains in git history (4e37340 and earlier). This stub
-- is deliberately kept so a bookmark, runbook or habit that still points here
-- meets a loud refusal instead of a silent revert.
-- ============================================================================

DO $$
BEGIN
  RAISE EXCEPTION 'RETIRED (DB-8): this script is no longer a source of truth. Apply the numbered files in supabase/migrations/ in order instead.';
END $$;
