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
--            the version served. BOUNDED by partial unique indexes, because
--            anyone holding a token, live or dead, can call the routes in a
--            loop and must not be able to grow the table at will: refused
--            rows one per share per minute, served opens (resolve) one per
--            share per client IP per minute. A download row is one per copy
--            that left (it pairs with its download_audits row) and is not
--            bounded. Pruning the trail is the retention owner's (RET-*),
--            not this migration's. No recipient identification: possession
--            of the token is the whole authorization, and the record says
--            so rather than pretending a name. Attribution columns are plain
--            uuids, not foreign keys (the record outlives the share — the
--            DEC-44 shape). Written by the service role only; org
--            controllers read it; nobody updates or deletes through RLS.
--            The IP lives HERE ONLY. document_shares.access_last_ip stays
--            unwritten on purpose: document_shares rows are readable by
--            every member who can read the document (20261066), so an
--            outside accessor's IP written there would reach Viewers. The
--            column is kept (older backups carry the key, and the restore
--            upserts it) and its COMMENT says it is unused and why.
--   SHR-12   bump_share_access(uuid) was SECURITY DEFINER with no search_path
--            pin (20260818) and its EXECUTE reached authenticated (20261027)
--            although its only caller is the service-role resolve route. It
--            is re-created at the SAME arity — pinned at CREATE, body
--            unchanged (no IP) — so a route already deployed keeps calling
--            it across the apply. EXECUTE: service_role only.
--
-- NARROWS (authenticated loses an EXECUTE it never used; the new table is
-- readable by controllers only). No pre-apply inventory is required; the
-- counts below ride for the record. Idempotent. ⚠ APPLIED BY HAND (DEC-30).
-- Sequencing: after 20261080 (same package); the routes write the new table
-- from the wave-2 deploy on (before this apply, that write is logged and the
-- resolve / download still proceed).
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
  resolve_minute TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_share_accesses_refused_shape
    CHECK ((kind = 'refused') = (reason IS NOT NULL AND refused_minute IS NOT NULL)),
  CONSTRAINT document_share_accesses_resolve_shape
    CHECK ((kind = 'resolve') = (resolve_minute IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS document_share_accesses_share_idx ON document_share_accesses(share_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_share_accesses_doc_idx   ON document_share_accesses(document_id, created_at DESC);
-- The bound on refused attempts: one row per share per minute. The route
-- writes refused_minute (the minute the attempt fell in) and treats a
-- unique violation as "already recorded this minute".
CREATE UNIQUE INDEX IF NOT EXISTS document_share_accesses_refused_bound
  ON document_share_accesses(share_id, refused_minute) WHERE kind = 'refused';
-- The bound on served opens: one row per share per client IP per minute (a
-- missing IP is one bucket, not an unbounded one). The route writes
-- resolve_minute and treats the unique violation the same way.
CREATE UNIQUE INDEX IF NOT EXISTS document_share_accesses_resolve_bound
  ON document_share_accesses(share_id, (COALESCE(ip, '')), resolve_minute) WHERE kind = 'resolve';
COMMENT ON TABLE document_share_accesses IS
  'P1 SHARE (SHR-10): one row per share-link access — kind (resolve / download / refused with the reason; refused rows bounded to one per share per minute, opens to one per share per client IP per minute; downloads one per copy served), IP, user agent, document and version. The only place an accessor IP is kept. Service-role writes only; controllers read; append-only for members. share_id is attribution, not a foreign key.';

ALTER TABLE document_share_accesses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_share_accesses_controller_select ON document_share_accesses;
CREATE POLICY document_share_accesses_controller_select ON document_share_accesses FOR SELECT
  USING (is_org_controller(org_id));
-- No INSERT / UPDATE / DELETE policy on purpose: the routes write with the
-- service role (bypasses RLS); nothing a member does rewrites the trail.

-- ── 2. bump_share_access: pinned, same arity, no IP, service-role only ──────
-- An earlier draft of this file created a two-argument twin that wrote the
-- IP; drop it if a paste of that draft ever landed (no-op otherwise).
DROP FUNCTION IF EXISTS bump_share_access(uuid, text);
CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE document_shares
     SET access_count = COALESCE(access_count, 0) + 1,
         access_last_at = now()
   WHERE id = p_share;
$$;
REVOKE ALL ON FUNCTION bump_share_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_share_access(uuid) FROM anon;
REVOKE ALL ON FUNCTION bump_share_access(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION bump_share_access(uuid) TO service_role;
COMMENT ON FUNCTION bump_share_access(uuid) IS
  'P1 SHARE (SHR-12): the share access counter, called by the service-role resolve route only. Writes no IP (the accessor IP is controller-only, in document_share_accesses). search_path pinned.';

-- ── 3. access_last_ip: unused by design ─────────────────────────────────────
COMMENT ON COLUMN document_shares.access_last_ip IS
  'Unused by design (P1 SHARE, SHR-10 / DEC-46 §5): document_shares is readable by every member who can read the document, so an accessor IP is never written here. The per-access IP trail is document_share_accesses (controllers only).';

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
SELECT 'served opens are bounded: unique (share_id, COALESCE(ip), resolve_minute) where kind = resolve; a resolve row carries its minute',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE tablename = 'document_share_accesses' AND indexname = 'document_share_accesses_resolve_bound'
                  AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%share_id, COALESCE(ip%'
                  AND indexdef LIKE '%resolve_minute)%' AND indexdef LIKE '%resolve%')
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'document_share_accesses'::regclass AND contype = 'c'
                      AND conname = 'document_share_accesses_resolve_shape'),
       NULL
UNION ALL
SELECT 'bump_share_access(uuid) keeps its arity (no two-argument twin), SECURITY DEFINER, search_path pinned',
       to_regprocedure('bump_share_access(uuid, text)') IS NULL
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'bump_share_access'
                      AND p.oid = to_regprocedure('bump_share_access(uuid)')
                      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 'bump_share_access writes no IP onto document_shares (members can read that row)',
       (SELECT prosrc NOT LIKE '%access_last_ip%'
          FROM pg_proc WHERE oid = to_regprocedure('bump_share_access(uuid)')),
       NULL
UNION ALL
SELECT 'EXECUTE on bump_share_access(uuid): service_role yes; anon and authenticated no',
       has_function_privilege('service_role', 'bump_share_access(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'bump_share_access(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'bump_share_access(uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'inventory: share access rows (0 until the wave-2 routes deploy)', NULL,
       (SELECT COUNT(*) FROM document_share_accesses)::text
UNION ALL
SELECT 'inventory: shares carrying access_last_ip (expect 0: nothing writes it)', NULL,
       (SELECT COUNT(*) FROM document_shares WHERE access_last_ip IS NOT NULL)::text
UNION ALL
SELECT 'inventory: total recorded share opens (sum of access_count)', NULL,
       (SELECT COALESCE(SUM(access_count), 0) FROM document_shares)::text;
