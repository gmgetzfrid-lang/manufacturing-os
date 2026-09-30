-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F — P1 SHARE: what a share access honestly records.
--
--   SHR-10   The only recorded fact about an external distribution was an
--            integer that went up: document_shares.access_last_ip was a dead
--            column nothing wrote, and neither public route read a request
--            header. document_share_accesses is one row per access — the
--            kind (resolve = link opened, download = bytes left, refused =
--            an attempt the routes turned away, with the reason: revoked,
--            expired, withdrawn, on hold, lapsed authority, no file), the
--            first forwarded-for hop and the user agent, the document and
--            the version served. Refused rows are BOUNDED: one per share per
--            minute (a partial unique index — anyone holding a dead token
--            can call the route, and must not be able to grow the table at
--            will). Pruning the trail is the retention owner's (RET-*), not
--            this migration's. No recipient identification: possession of
--            the token is the whole authorization, and the record says so
--            rather than pretending a name. Attribution columns are plain
--            uuids, not foreign keys (the record outlives the share — the
--            DEC-44 shape). Written by the service role only; org
--            controllers read it; nobody updates or deletes through RLS.
--   SHR-12   bump_share_access(uuid) was SECURITY DEFINER with no search_path
--            pin (20260818) and its EXECUTE reached authenticated (20261027)
--            although its only caller is the service-role resolve route. It
--            is re-created as bump_share_access(uuid, text) — pinned, taking
--            the IP so access_last_ip is finally written — and the old
--            arity is DROPped (a changed arity is a NEW function; both would
--            otherwise live). EXECUTE: service_role only.
--
-- NARROWS (authenticated loses an EXECUTE it never used; the new table is
-- readable by controllers only). No pre-apply inventory is required; the
-- counts below ride for the record. Idempotent. ⚠ APPLIED BY HAND (DEC-30).
-- Sequencing: after 20261080 (same package); the routes write the new table
-- and call the two-argument function from the wave-2 deploy on.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. the per-access record ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_share_accesses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id    UUID NOT NULL,
  org_id      UUID NOT NULL,
  document_id UUID NOT NULL,
  version_id  UUID,
  kind        TEXT NOT NULL CHECK (kind IN ('resolve', 'download', 'refused')),
  reason      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  refused_minute TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_share_accesses_refused_shape
    CHECK ((kind = 'refused') = (reason IS NOT NULL AND refused_minute IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS document_share_accesses_share_idx ON document_share_accesses(share_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_share_accesses_doc_idx   ON document_share_accesses(document_id, created_at DESC);
-- The bound on refused attempts: one row per share per minute. The route
-- writes refused_minute (the minute the attempt fell in) and treats a
-- unique violation as "already recorded this minute".
CREATE UNIQUE INDEX IF NOT EXISTS document_share_accesses_refused_bound
  ON document_share_accesses(share_id, refused_minute) WHERE kind = 'refused';
COMMENT ON TABLE document_share_accesses IS
  'P1 SHARE (SHR-10): one row per share-link access — kind (resolve / download / refused with the reason; refused rows bounded to one per share per minute), IP, user agent, document and version. Service-role writes only; controllers read; append-only for members. share_id is attribution, not a foreign key.';

ALTER TABLE document_share_accesses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_share_accesses_controller_select ON document_share_accesses;
CREATE POLICY document_share_accesses_controller_select ON document_share_accesses FOR SELECT
  USING (is_org_controller(org_id));
-- No INSERT / UPDATE / DELETE policy on purpose: the routes write with the
-- service role (bypasses RLS); nothing a member does rewrites the trail.

-- ── 2. bump_share_access: pinned, takes the IP, service-role only ───────────
DROP FUNCTION IF EXISTS bump_share_access(uuid);
CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid, p_ip text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE document_shares
     SET access_count = COALESCE(access_count, 0) + 1,
         access_last_at = now(),
         access_last_ip = p_ip
   WHERE id = p_share;
$$;
REVOKE ALL ON FUNCTION bump_share_access(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_share_access(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION bump_share_access(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION bump_share_access(uuid, text) TO service_role;
COMMENT ON FUNCTION bump_share_access(uuid, text) IS
  'P1 SHARE (SHR-12): the share access counter + last IP, called by the service-role resolve route only. search_path pinned.';

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry ok NULL.
SELECT 'document_share_accesses exists with RLS enabled' AS check,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'document_share_accesses'::regclass) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'exactly one policy on document_share_accesses: controller SELECT (no member INSERT / UPDATE / DELETE)',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE tablename = 'document_share_accesses')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_share_accesses'
                    AND policyname = 'document_share_accesses_controller_select' AND cmd = 'SELECT'
                    AND qual LIKE '%is_org_controller(org_id)%'),
       NULL
UNION ALL
SELECT 'the kind CHECK admits resolve, download and refused; a refused row carries its reason and minute',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'document_share_accesses'::regclass AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%resolve%' AND pg_get_constraintdef(oid) LIKE '%download%'
                  AND pg_get_constraintdef(oid) LIKE '%refused%')
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'document_share_accesses'::regclass AND contype = 'c'
                      AND conname = 'document_share_accesses_refused_shape'),
       NULL
UNION ALL
SELECT 'refused attempts are bounded: unique (share_id, refused_minute) where kind = refused',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE tablename = 'document_share_accesses' AND indexname = 'document_share_accesses_refused_bound'
                  AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%(share_id, refused_minute)%'
                  AND indexdef LIKE '%refused%'),
       NULL
UNION ALL
SELECT 'bump_share_access(uuid) is gone; bump_share_access(uuid, text) exists, SECURITY DEFINER, search_path pinned',
       to_regprocedure('bump_share_access(uuid)') IS NULL
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'bump_share_access'
                      AND p.oid = to_regprocedure('bump_share_access(uuid, text)')
                      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 'bump_share_access writes access_last_ip',
       (SELECT prosrc LIKE '%access_last_ip = p_ip%'
          FROM pg_proc WHERE oid = to_regprocedure('bump_share_access(uuid, text)')),
       NULL
UNION ALL
SELECT 'EXECUTE on bump_share_access(uuid, text): service_role yes; anon and authenticated no',
       has_function_privilege('service_role', 'bump_share_access(uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'bump_share_access(uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'bump_share_access(uuid, text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'inventory: share access rows (0 until the wave-2 routes deploy)', NULL,
       (SELECT COUNT(*) FROM document_share_accesses)::text
UNION ALL
SELECT 'inventory: shares carrying access_last_ip (0 before the two-argument function is called)', NULL,
       (SELECT COUNT(*) FROM document_shares WHERE access_last_ip IS NOT NULL)::text
UNION ALL
SELECT 'inventory: total recorded share opens (sum of access_count)', NULL,
       (SELECT COALESCE(SUM(access_count), 0) FROM document_shares)::text;
