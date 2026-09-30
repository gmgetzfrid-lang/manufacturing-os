-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F — P1 SHARE: who mints an external share, what it
-- may name, how long it lives, and that a revocation is durable.
--
--   DIST-6 / SHR-4  Any active member — a Viewer included — could mint a
--                   never-expiring public link to any document they could
--                   read. Minting is now the publisher tier: the org's
--                   controllers (Admin / DocCtrl by the role COLLECTION —
--                   is_org_controller) or a publisher granted on the
--                   document's library (user_can_publish_on_library, the
--                   database's own evaluator, so the app and the rail agree).
--                   "Never expires" is gone: a live share must carry an
--                   expiry no later than 90 days after its creation, on
--                   INSERT and on any later change to expires_at. The
--                   ceiling is measured from the DATABASE's clock: a live
--                   INSERT is stamped created_at := now() (a client-supplied
--                   created_at is ignored), created_at is immutable after,
--                   and an expiry up to one hour past the ceiling — a
--                   browser clock running ahead of the server's on a
--                   "90 days (maximum)" pick — is clamped to the ceiling
--                   rather than refused.
--   EGR-5 / SHR-3   A share could be minted on a Draft, a Superseded / Void /
--   REV-10 / DRLS-5 Archived document, or one under an active hold, and both
--                   public routes then served it. document_share_refusal()
--                   names why a document cannot be shared (draft / withdrawn /
--                   archived / on_hold) and the INSERT policy requires NULL.
--                   It answers only for the caller's own orgs AND a document
--                   the caller can read (node_visible — anything else reads
--                   'not_found'), so it is no oracle across tenants or
--                   across a private / hidden document inside one.
--                   The routes refuse the same set at serve time
--                   (lib/shareServe.ts) — this is the rail behind the mint.
--   DRLS-7 / SHR-13 Revocation was not durable: the creator (or any
--                   controller) could clear revoked_at, re-date expires_at,
--                   or DELETE the row and its access trail. The anchor guard
--                   (20261026, BEFORE UPDATE) is re-created as BEFORE INSERT
--                   OR UPDATE: revoked_at, once set, never clears and never
--                   moves; a revoked share cannot be re-dated; created_at
--                   never moves; expiry is capped. DELETE becomes
--                   controller-only (retention) — a creator revokes, never
--                   erases.
--
-- Policies after apply (document_shares):
--   document_shares_org_select  (20261066, untouched)
--   document_shares_insert      creator = caller AND active member AND the
--                               document is in the org and readable (20261037
--                               body, byte-carried) AND (controller OR granted
--                               publisher) AND document_share_refusal IS NULL
--   document_shares_update      (20261026, untouched — creator or controller)
--   document_shares_delete      controller only
--
-- NARROWS for members (fewer may mint; nothing widens). The backfill below
-- CAPS every live share's expiry at created_at + 90 days — a never-expiring
-- link older than 90 days expires on apply, which is the decision the
-- ceiling states. The DEC-30 inventory captures those counts BEFORE the
-- transaction so the paste's result set says what the apply retired.
-- Idempotent: every step is DROP-then-CREATE / OR REPLACE / IF NOT EXISTS.
-- ⚠ APPLIED BY HAND (DEC-30). One paste; the editor shows the final SELECT.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
-- Outside the transaction, so a failure inside BEGIN…COMMIT leaves it behind
-- in a pooled SQL-editor session: dropped first so a re-run re-captures it.
DROP TABLE IF EXISTS dc_round_f_80_before;
CREATE TEMP TABLE dc_round_f_80_before AS
SELECT 'BEFORE: share rows (all)' AS inventory, COUNT(*)::text AS n
  FROM document_shares
UNION ALL
SELECT 'BEFORE: live share rows (unrevoked; unexpired or never-expiring)', COUNT(*)::text
  FROM document_shares
 WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
UNION ALL
SELECT 'BEFORE: live never-expiring rows (capped to created_at + 90 days below)', COUNT(*)::text
  FROM document_shares
 WHERE revoked_at IS NULL AND expires_at IS NULL
UNION ALL
SELECT 'BEFORE: live never-expiring rows already older than 90 days (these EXPIRE on apply)', COUNT(*)::text
  FROM document_shares
 WHERE revoked_at IS NULL AND expires_at IS NULL
   AND COALESCE(created_at, now()) + interval '90 days' < now()
UNION ALL
SELECT 'BEFORE: live rows whose expiry exceeds created_at + 90 days (capped below)', COUNT(*)::text
  FROM document_shares
 WHERE revoked_at IS NULL AND expires_at IS NOT NULL
   AND expires_at > COALESCE(created_at, now()) + interval '90 days'
UNION ALL
SELECT 'BEFORE: share rows with no created_at (no anchor for the ceiling: capped at apply time + 90 days, and their expiry may only move earlier after)', COUNT(*)::text
  FROM document_shares
 WHERE created_at IS NULL
UNION ALL
SELECT 'BEFORE: live rows on a Draft / Superseded / Void / Archived or archived-record document (the routes refuse these at serve time; rows kept for the record)', COUNT(*)::text
  FROM document_shares s JOIN documents d ON d.id = s.document_id
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
   AND (d.status IN ('Draft', 'Superseded', 'Void', 'Archived') OR d.archived_at IS NOT NULL)
UNION ALL
SELECT 'BEFORE: live rows on a document under an active hold (refused at serve time until release)', COUNT(*)::text
  FROM document_shares s
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = s.document_id AND h.released_at IS NULL)
UNION ALL
SELECT 'BEFORE: live rows whose creator could not mint after apply (not a controller, no publish grant on the library) - the wave-2 routes refuse them at serve time (authority lapsed)', COUNT(*)::text
  FROM document_shares s JOIN documents d ON d.id = s.document_id
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = s.org_id AND m.uid = s.created_by AND m.status = 'active'
                      AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
   AND NOT COALESCE(user_can_publish_on_library(d.library_id, s.created_by::text, s.org_id), false)
UNION ALL
SELECT 'BEFORE: policies on document_shares (expect 4: org_select, insert, update, delete)', COUNT(*)::text
  FROM pg_policies WHERE tablename = 'document_shares';

BEGIN;

-- ── 1. Why a document cannot be shared: one answer for the rail and the app ─
-- SECURITY DEFINER so the policy's answer does not depend on the caller's
-- own read access to document_holds; STABLE, search_path pinned. It answers
-- only for an org the caller is an active member of, and only for a
-- document the caller can READ (node_visible, the read decision the INSERT
-- policy already requires — so no legitimate mint changes); anything else
-- reads 'not_found', so a signed-in member learns nothing about another
-- org's documents, nor the status / hold of a private or hidden document
-- in their own org, by calling it. The service role (auth.uid() IS NULL)
-- is not scoped.
-- Returns NULL when shareable, else: not_found | draft | withdrawn:<status>
-- | archived | on_hold. The status set is the app's NOT_CURRENT_STATUSES
-- (Superseded, Void, Archived) plus Draft — lib/shareRules.ts states the
-- same rule and the shape test pins the two together.
CREATE OR REPLACE FUNCTION document_share_refusal(p_doc uuid, p_org uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN d.id IS NULL THEN 'not_found'
    WHEN d.status = 'Draft' THEN 'draft'
    WHEN d.status IN ('Superseded', 'Void', 'Archived') THEN 'withdrawn:' || lower(d.status)
    WHEN d.archived_at IS NOT NULL THEN 'archived'
    WHEN EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL) THEN 'on_hold'
    ELSE NULL
  END
  FROM (SELECT 1) AS one
  LEFT JOIN documents d ON d.id = p_doc AND d.org_id = p_org
                       AND (auth.uid() IS NULL OR p_org IN (SELECT my_org_ids()))
                       AND (auth.uid() IS NULL OR node_visible(d.visibility, d.acl_index, d.org_id,
                                                                d.owner_user_id, d.collection_id, d.library_id));
$$;
REVOKE ALL ON FUNCTION document_share_refusal(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION document_share_refusal(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION document_share_refusal(uuid, uuid) TO authenticated, service_role;

-- ── 2. INSERT: the 20261037 body, byte-carried, plus the two P1 SHARE arms ──
DROP POLICY IF EXISTS document_shares_insert ON document_shares;
CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (
  document_shares.created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = document_shares.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_shares.document_id
      AND d.org_id = document_shares.org_id
      AND node_visible(d.visibility, d.acl_index, d.org_id,
                       d.owner_user_id, d.collection_id, d.library_id)
  )
  -- P1 SHARE: the minting tier — controllers (by collection) or a publisher
  -- granted on the document's library, asked of the database's own evaluator.
  AND (
    is_org_controller(document_shares.org_id)
    OR EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_shares.document_id
        AND user_can_publish_on_library(d.library_id, auth.uid()::text, document_shares.org_id)
    )
  )
  -- P1 SHARE: a Draft / Superseded / Void / Archived or held document is refused.
  AND document_share_refusal(document_shares.document_id, document_shares.org_id) IS NULL
);

-- ── 3. DELETE: controllers only (retention). A creator revokes, never erases.
DROP POLICY IF EXISTS document_shares_delete ON document_shares;
CREATE POLICY document_shares_delete ON document_shares FOR DELETE USING (
  is_org_controller(document_shares.org_id)
);

-- ── 4. The anchor guard (20261026 body, byte-carried) grows the revocation
--       and expiry rails and fires on INSERT too ─────────────────────────────
-- Not SECURITY DEFINER (it only reads OLD/NEW); search_path pinned anyway so
-- an EXCEPTION message can never resolve against caller-schema shadows.
CREATE OR REPLACE FUNCTION document_shares_anchor_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- SHR-4: a LIVE share must expire within 90 days of its creation. A row
    -- born revoked (a restore, DEC-45) can never serve and is exempt, and
    -- keeps the created_at it was restored with.
    IF NEW.revoked_at IS NULL THEN
      -- The ceiling is measured from the DATABASE's clock: a live share is
      -- born now(), whatever created_at the client sent.
      NEW.created_at := now();
      IF NEW.expires_at IS NULL
         OR NEW.expires_at > NEW.created_at + interval '90 days' + interval '1 hour' THEN
        RAISE EXCEPTION 'document_shares: a share must expire within 90 days of its creation';
      END IF;
      -- The expiry is computed on the minting browser's clock; one running
      -- ahead of the server's lands a "90 days (maximum)" pick just past the
      -- ceiling. Clamp it to the ceiling rather than refuse a legitimate mint.
      IF NEW.expires_at > NEW.created_at + interval '90 days' THEN
        NEW.expires_at := NEW.created_at + interval '90 days';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.org_id      IS DISTINCT FROM OLD.org_id
     OR NEW.created_by  IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'document_shares: document_id, org_id and created_by are immutable — revoke this share and create a new one';
  END IF;
  -- SHR-4: the 90-day ceiling is measured from created_at, so it never moves.
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'document_shares: created_at is immutable — the 90-day expiry ceiling is measured from it';
  END IF;
  -- DRLS-7: revocation is durable. Once set, revoked_at never clears and
  -- never moves, and a revoked share cannot be re-dated back to life.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'document_shares: a revoked share stays revoked — create a new share instead';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'document_shares: a revoked share cannot be re-dated';
  END IF;
  -- SHR-4: any change to the expiry lands within 90 days of creation, never
  -- NULL. A legacy never-expiring row is untouched until its expiry moves.
  -- A legacy row with no created_at has no anchor: its ceiling is its
  -- current expiry, so the expiry may only move earlier.
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
     AND (NEW.expires_at IS NULL
          OR NEW.expires_at > COALESCE(OLD.created_at + interval '90 days', OLD.expires_at)) THEN
    RAISE EXCEPTION 'document_shares: a share must expire within 90 days of its creation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_shares_anchor_guard ON document_shares;
CREATE TRIGGER document_shares_anchor_guard
BEFORE INSERT OR UPDATE ON document_shares
FOR EACH ROW EXECUTE FUNCTION document_shares_anchor_immutable();

-- ── 5. Backfill: every live share expires within 90 days of its creation ────
-- Runs THROUGH the guard above (the new value equals the ceiling, so it
-- passes) — the rail is exercised by its own migration.
UPDATE document_shares
   SET expires_at = COALESCE(created_at, now()) + interval '90 days'
 WHERE revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > COALESCE(created_at, now()) + interval '90 days');

COMMENT ON TABLE document_shares IS
  'Time-limited public share links (P1 SHARE, Round F): minted by controllers or granted publishers only, on issued documents that are not on hold; expiry required, at most 90 days; a share always serves the CURRENT revision; revoked_at is durable; DELETE is controller-only.';

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows carry ok NULL and the
--    count in n. pg_policies.qual / with_check are DEPARSED (no casts inside a
--    LIKE pattern); pg_proc.prosrc is verbatim.
SELECT 'document_share_refusal(uuid, uuid) exists, SECURITY DEFINER, search_path pinned' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'document_share_refusal'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'document_share_refusal names the four refusals (draft / withdrawn / archived / on_hold)',
       (SELECT prosrc LIKE '%''draft''%' AND prosrc LIKE '%''withdrawn:'' || lower(d.status)%'
           AND prosrc LIKE '%''archived''%' AND prosrc LIKE '%''on_hold''%'
          FROM pg_proc WHERE proname = 'document_share_refusal'),
       NULL
UNION ALL
SELECT 'document_share_refusal answers only for the caller''s own orgs (service role excepted)',
       (SELECT prosrc LIKE '%auth.uid() IS NULL OR p_org IN (SELECT my_org_ids())%'
          FROM pg_proc WHERE proname = 'document_share_refusal'),
       NULL
UNION ALL
SELECT 'document_share_refusal answers only for a document the caller can read (node_visible; unreadable reads not_found)',
       (SELECT prosrc LIKE '%auth.uid() IS NULL OR node_visible(d.visibility, d.acl_index, d.org_id,%'
           AND prosrc LIKE '%d.owner_user_id, d.collection_id, d.library_id));%'
          FROM pg_proc WHERE proname = 'document_share_refusal'),
       NULL
UNION ALL
SELECT 'INSERT keeps the 20261037 anchor (created_by = caller, active member, org-joined readable document)',
       (SELECT with_check LIKE '%created_by = auth.uid()%'
           AND with_check LIKE '%m.status = ''active''%'
           AND with_check LIKE '%d.org_id = document_shares.org_id%'
           AND with_check LIKE '%node_visible(d.visibility, d.acl_index, d.org_id, d.owner_user_id, d.collection_id, d.library_id)%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'),
       NULL
UNION ALL
SELECT 'INSERT requires the minting tier (is_org_controller OR user_can_publish_on_library on the document library)',
       (SELECT with_check LIKE '%is_org_controller(%'
           AND with_check LIKE '%user_can_publish_on_library(d.library_id%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'),
       NULL
UNION ALL
SELECT 'INSERT requires document_share_refusal(...) IS NULL (no Draft / withdrawn / archived / held document)',
       (SELECT with_check LIKE '%document_share_refusal(%' AND with_check LIKE '% IS NULL%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'),
       NULL
UNION ALL
SELECT 'DELETE is controller-only (no creator arm)',
       (SELECT qual LIKE '%is_org_controller(%' AND qual NOT LIKE '%created_by%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_delete'),
       NULL
UNION ALL
SELECT 'exactly four policies on document_shares, one per verb (org_select / insert / update / delete)',
       (SELECT COUNT(*) = 4 FROM pg_policies WHERE tablename = 'document_shares')
       AND (SELECT COUNT(*) = 0 FROM pg_policies WHERE tablename = 'document_shares' AND cmd = 'ALL')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_org_select' AND cmd = 'SELECT')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_update' AND cmd = 'UPDATE'),
       NULL
UNION ALL
SELECT 'anchor guard fires BEFORE INSERT OR UPDATE (tgtype: BEFORE + ROW + INSERT + UPDATE)',
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'document_shares_anchor_guard' AND NOT tgisinternal
                  AND (tgtype & 2) <> 0 AND (tgtype & 1) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0),
       NULL
UNION ALL
SELECT 'anchor guard body carries the immutable anchor, the durable revocation and the 90-day expiry rails',
       (SELECT prosrc LIKE '%document_id, org_id and created_by are immutable%'
           AND prosrc LIKE '%a revoked share stays revoked%'
           AND prosrc LIKE '%a revoked share cannot be re-dated%'
           AND prosrc LIKE '%must expire within 90 days of its creation%'
           AND prosrc LIKE '%TG_OP = ''INSERT''%'
          FROM pg_proc WHERE proname = 'document_shares_anchor_immutable'),
       NULL
UNION ALL
SELECT 'anchor guard measures the ceiling from the database clock (live INSERT stamps created_at := now(), clamps up to 1 hour of skew) and created_at is immutable',
       (SELECT prosrc LIKE '%NEW.created_at := now();%'
           AND prosrc LIKE '%NEW.expires_at := NEW.created_at + interval ''90 days'';%'
           AND prosrc LIKE '%NEW.created_at + interval ''90 days'' + interval ''1 hour''%'
           AND prosrc LIKE '%IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN%'
           AND prosrc LIKE '%created_at is immutable%'
          FROM pg_proc WHERE proname = 'document_shares_anchor_immutable'),
       NULL
UNION ALL
SELECT 'no live share is without an expiry or beyond created_at + 90 days',
       (SELECT COUNT(*) = 0 FROM document_shares
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > COALESCE(created_at, now()) + interval '90 days')),
       NULL
UNION ALL
SELECT 'RLS is enabled on document_shares',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'document_shares'::regclass),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM dc_round_f_80_before
UNION ALL
SELECT 'AFTER: live share rows (unrevoked, unexpired)', NULL,
       (SELECT COUNT(*) FROM document_shares WHERE revoked_at IS NULL AND expires_at > now())::text
UNION ALL
SELECT 'AFTER: rows that expired on apply (unrevoked, expiry now in the past, created more than 90 days ago)', NULL,
       (SELECT COUNT(*) FROM document_shares
         WHERE revoked_at IS NULL AND expires_at <= now()
           AND COALESCE(created_at, now()) + interval '90 days' <= now())::text;
