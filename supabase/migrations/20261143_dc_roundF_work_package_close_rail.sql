-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 2 — P8 FIELD: the work-package close rail
-- (DRLS-10 done-when 2).
--
--   DRLS-10  work_packages kept the 20260825 member-level UPDATE and DELETE
--            policies (no later migration re-creates them), so any active
--            member — a Viewer included — could PATCH a package to
--            status = 'closed' (stamping closed_at / closed_by) or DELETE it
--            through PostgREST. The /packages page no longer offers either
--            action to anyone but the package owner or a controller, and the
--            lib reports a zero-row close as a refusal — but that is the
--            browser. A DELETE also cascades work_package_prints (20261028:
--            package_id ON DELETE CASCADE), erasing the immutable print
--            snapshots every printed cover QR is verified against, so field
--            scans of that paper lose their record.
--
-- What this file does:
--   · work_packages_org_update and work_packages_org_delete are re-created
--     from their NEWEST definition (20260825 — grep: no later migration and
--     no schema.sql line re-creates them) with every line kept verbatim, and
--     AND the package owner or a controller — the same predicate 20261032
--     (PKG-5) gave the pin policies on work_package_documents:
--       owner_user_id = auth.uid(), or an active Admin / DocCtrl member of the
--       row's org (headline role or the additive roles collection).
--     UPDATE gains a WITH CHECK carrying the same terms (it had none, so the
--     USING clause applied to the new row; now it is explicit and the owner
--     cannot hand the row to someone else unless they are a controller).
--   · DELETE is additionally refused while the package has a print snapshot:
--     a printed package's record outlives it in the field, so it is CLOSED,
--     never deleted (the service role and the org-deletion cascade are
--     unaffected — RLS does not apply to either). The app never deletes a
--     work package; nothing legitimate changes.
--   · SELECT and INSERT are not touched. No function, no trigger.
--
-- NARROWS for members on apply: a non-owner who is not a controller can no
-- longer close, reopen, rename or delete a package. Packages whose owner is
-- no longer an active member of the org become controller-only (the owner arm
-- keeps the 20260825 membership term) — the inventory counts them.
--
-- Not here (DRLS-10 done-when 3, database half — recorded as open): a direct
-- PostgREST re-pin by the owner or a controller (both allowed by 20261032)
-- still leaves no database-side record; the app's re-pin does.
--
-- DEC-30: the inventory (aggregate counts only) is captured BEFORE the
-- transaction and returned with the probes in ONE result set — the only one
-- the SQL editor shows. MEASURE rows ride along (read-only, changed by
-- nothing here), so the reach of two app-side behaviour changes in the same
-- package is a count, not a guess:
--   · PKG-12, the field pack's budget (150 sheets / 1000 pages / 150 MB): the
--     open packages and asset tags over 150 sheets, and over 150 MB of
--     recorded file size, counted over the sheets the print gate admits
--     (Issued / Locked, no active document hold — an upper bound: a
--     printer's outstanding sign-offs and unreadable sheets are per person
--     and not subtracted); the single current files over 150 MB (left out of
--     every pack as too large); and the in-force files with no recorded size,
--     which the size rows cannot see. The 1000-page budget has no row: page
--     counts are not stored.
--   · TRX-15, the transmittal portal: the live items whose file is a PDF over
--     the 64 MiB stamping bound (released unstamped under DEC-61 §5 today,
--     the issuer told; refused only once the issue-time check, TRX-16, marks
--     such an item), and the live items whose size is not recorded.
--
-- DEPLOY ORDER (PKG-12): paste this file BEFORE the P8 FIELD app deploys and
-- read the MEASURE rows first — a package or asset tag they count prints
-- today and is refused with a split (or loses a too-large sheet) once the
-- app ships, so its owner is told before, not by the refusal. Applied before
-- the app, the narrowing is already in force: on the old page a non-owner's
-- Close matches no row (the old lib then reads it as closed; the package
-- stays open and listed) until the app deploys.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe. Needs 20260825
-- and 20261028 (both live since 2026-08); the TRX-15 rows read 20261133's
-- portal columns through to_jsonb, so they also run on a database without
-- 20261133.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS dc_round_f_143_before;
CREATE TEMP TABLE dc_round_f_143_before AS
SELECT 'BEFORE: work packages open' AS inventory,
       (SELECT COUNT(*) FROM work_packages WHERE status = 'open')::text AS n
UNION ALL
SELECT 'BEFORE: work packages executing',
       (SELECT COUNT(*) FROM work_packages WHERE status = 'executing')::text
UNION ALL
SELECT 'BEFORE: work packages closed',
       (SELECT COUNT(*) FROM work_packages WHERE status = 'closed')::text
UNION ALL
SELECT 'BEFORE: open / executing packages whose owner is no longer an active member of the org (after apply only a controller can close them)',
       (SELECT COUNT(*) FROM work_packages p
         WHERE p.status <> 'closed'
           AND NOT EXISTS (SELECT 1 FROM org_members m
                            WHERE m.org_id = p.org_id AND m.uid = p.owner_user_id AND m.status = 'active'))::text
UNION ALL
SELECT 'BEFORE: packages with at least one print snapshot (after apply nobody deletes them through the API; they are closed instead)',
       (SELECT COUNT(DISTINCT pr.package_id) FROM work_package_prints pr)::text
UNION ALL
SELECT 'BEFORE: policies on work_packages (expect 4: select, insert, update, delete)',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_packages')::text
UNION ALL
SELECT 'MEASURE (PKG-12, not changed by this file): open / executing packages with more than 150 printable sheets (Issued / Locked, no active hold; upper bound) — a print of one is refused with a split; it is split into packages',
       (SELECT COUNT(*) FROM (
          SELECT wpd.package_id FROM work_package_documents wpd
            JOIN work_packages p ON p.id = wpd.package_id
            JOIN documents d ON d.id = wpd.document_id
           WHERE p.status <> 'closed'
             AND d.status IN ('Issued', 'Locked')
             AND NOT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
           GROUP BY wpd.package_id HAVING COUNT(*) > 150) x)::text
UNION ALL
SELECT 'MEASURE (PKG-12, not changed by this file): asset tags carried by more than 150 printable documents (Issued / Locked, no active hold; upper bound) — the asset hub prints them in parts',
       (SELECT COUNT(*) FROM (
          SELECT d.org_id, t->>'tag' AS tag
            FROM documents d
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.asset_tags) = 'array' THEN d.asset_tags ELSE '[]'::jsonb END) t
           WHERE d.status IN ('Issued', 'Locked')
             AND NOT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
             AND jsonb_typeof(t) = 'object' AND NULLIF(t->>'tag', '') IS NOT NULL
           GROUP BY d.org_id, t->>'tag' HAVING COUNT(DISTINCT d.id) > 150) x)::text
UNION ALL
SELECT 'MEASURE (PKG-12, not changed by this file): open / executing packages whose printable sheets (each within a pack on its own) record more than 150 MB together — a print of one is refused with a split',
       (SELECT COUNT(*) FROM (
          SELECT wpd.package_id FROM work_package_documents wpd
            JOIN work_packages p ON p.id = wpd.package_id
            JOIN documents d ON d.id = wpd.document_id
            JOIN document_versions v ON v.id = d.current_version_id
           WHERE p.status <> 'closed'
             AND d.status IN ('Issued', 'Locked')
             AND NOT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
             AND v.size <= 157286400
           GROUP BY wpd.package_id HAVING SUM(v.size) > 157286400) x)::text
UNION ALL
SELECT 'MEASURE (PKG-12, not changed by this file): asset tags whose printable documents (each within a pack on its own) record more than 150 MB together — the asset hub prints them in parts',
       (SELECT COUNT(*) FROM (
          SELECT d.org_id, t->>'tag' AS tag
            FROM documents d
            JOIN document_versions v ON v.id = d.current_version_id
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.asset_tags) = 'array' THEN d.asset_tags ELSE '[]'::jsonb END) t
           WHERE d.status IN ('Issued', 'Locked')
             AND NOT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
             AND jsonb_typeof(t) = 'object' AND NULLIF(t->>'tag', '') IS NOT NULL
             AND v.size <= 157286400
           GROUP BY d.org_id, t->>'tag' HAVING SUM(v.size) > 157286400) x)::text
UNION ALL
SELECT 'MEASURE (PKG-12, not changed by this file): Issued / Locked documents whose current file records more than 150 MB — left out of every field pack as too large (downloaded on their own)',
       (SELECT COUNT(*) FROM documents d
          JOIN document_versions v ON v.id = d.current_version_id
         WHERE d.status IN ('Issued', 'Locked') AND v.size > 157286400)::text
UNION ALL
SELECT 'MEASURE (PKG-12, not changed by this file): Issued / Locked documents whose current file records no size — the size rows above cannot see them (and no row measures the 1000-page budget: page counts are not stored)',
       (SELECT COUNT(*) FROM documents d
          LEFT JOIN document_versions v ON v.id = d.current_version_id
         WHERE d.status IN ('Issued', 'Locked') AND d.current_version_id IS NOT NULL AND v.size IS NULL)::text
UNION ALL
SELECT 'MEASURE (TRX-15, not changed by this file): items on live transmittals (issued / acknowledged, link not revoked or expired) whose file is a PDF over the 64 MiB stamping bound — released unstamped under DEC-61 §5 (the issuer told); refused only once the issue-time check (TRX-16) marks such an item',
       (SELECT COUNT(*) FROM transmittals t
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) it
          JOIN document_versions v ON v.id::text = COALESCE(it->>'versionId', it->>'version_id')
         WHERE t.status IN ('issued', 'acknowledged')
           AND to_jsonb(t)->>'portal_token' IS NOT NULL
           AND to_jsonb(t)->>'portal_revoked_at' IS NULL
           AND (to_jsonb(t)->>'portal_expires_at' IS NULL OR (to_jsonb(t)->>'portal_expires_at')::timestamptz > now())
           AND (lower(COALESCE(v.file_type, '')) LIKE '%pdf%' OR lower(v.file_url) LIKE '%.pdf')
           AND COALESCE(CASE WHEN it->>'fileSize' ~ '^[0-9]+$' THEN (it->>'fileSize')::bigint END, v.size) > 67108864)::text
UNION ALL
SELECT 'MEASURE (TRX-15, not changed by this file): items on live transmittals whose size is recorded neither on the item nor on a pinned version — the row above cannot see them',
       (SELECT COUNT(*) FROM transmittals t
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) it
          LEFT JOIN document_versions v ON v.id::text = COALESCE(it->>'versionId', it->>'version_id')
         WHERE t.status IN ('issued', 'acknowledged')
           AND to_jsonb(t)->>'portal_token' IS NOT NULL
           AND to_jsonb(t)->>'portal_revoked_at' IS NULL
           AND (to_jsonb(t)->>'portal_expires_at' IS NULL OR (to_jsonb(t)->>'portal_expires_at')::timestamptz > now())
           AND COALESCE(it->>'fileSize', '') !~ '^[0-9]+$'
           AND v.size IS NULL)::text;

BEGIN;

-- ── DRLS-10: closing or deleting a package is the owner's or a controller's ─
DROP POLICY IF EXISTS work_packages_org_update ON work_packages;
CREATE POLICY work_packages_org_update ON work_packages FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_packages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND (
    work_packages.owner_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM org_members m
               WHERE m.org_id = work_packages.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND (m.role IN ('Admin','DocCtrl')
                      OR m.roles && ARRAY['Admin','DocCtrl']))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_packages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND (
    work_packages.owner_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM org_members m
               WHERE m.org_id = work_packages.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND (m.role IN ('Admin','DocCtrl')
                      OR m.roles && ARRAY['Admin','DocCtrl']))
  )
);
DROP POLICY IF EXISTS work_packages_org_delete ON work_packages;
CREATE POLICY work_packages_org_delete ON work_packages FOR DELETE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_packages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND (
    work_packages.owner_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM org_members m
               WHERE m.org_id = work_packages.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND (m.role IN ('Admin','DocCtrl')
                      OR m.roles && ARRAY['Admin','DocCtrl']))
  )
  AND NOT EXISTS (SELECT 1 FROM work_package_prints pr
                  WHERE pr.package_id = work_packages.id)
);

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 5 ─────────
SELECT 'work_packages has exactly one UPDATE and one DELETE policy, and they are the re-created ones' AS check,
       (SELECT COUNT(*) FILTER (WHERE cmd = 'UPDATE') = 1
           AND COUNT(*) FILTER (WHERE cmd = 'DELETE') = 1
           AND bool_and(policyname = 'work_packages_org_update') FILTER (WHERE cmd = 'UPDATE')
           AND bool_and(policyname = 'work_packages_org_delete') FILTER (WHERE cmd = 'DELETE')
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_packages') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'work_packages_org_update: an active member who is the owner or a controller, on the row (USING) and on the new row (WITH CHECK)',
       (SELECT qual LIKE '%org_members.uid = auth.uid()%'
              AND qual LIKE '%owner_user_id = auth.uid()%'
              AND qual LIKE '%m.roles && ARRAY%'
              AND with_check LIKE '%org_members.uid = auth.uid()%'
              AND with_check LIKE '%owner_user_id = auth.uid()%'
              AND with_check LIKE '%m.roles && ARRAY%'
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_packages' AND policyname = 'work_packages_org_update'),
       NULL::text
UNION ALL
SELECT 'work_packages_org_delete: an active member who is the owner or a controller, and never while a print snapshot exists',
       (SELECT qual LIKE '%org_members.uid = auth.uid()%'
              AND qual LIKE '%owner_user_id = auth.uid()%'
              AND qual LIKE '%m.roles && ARRAY%'
              AND qual LIKE '%NOT (EXISTS%work_package_prints pr%pr.package_id = work_packages.id%'
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_packages' AND policyname = 'work_packages_org_delete'),
       NULL::text
UNION ALL
SELECT 'SELECT and INSERT are untouched: still any active member, no owner term',
       (SELECT COUNT(*) = 2
              AND bool_and(COALESCE(qual, with_check) LIKE '%org_members.uid = auth.uid()%')
              AND bool_and(COALESCE(qual, with_check) NOT LIKE '%owner_user_id%')
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_packages'
           AND ((cmd = 'SELECT' AND policyname = 'work_packages_org_select')
             OR (cmd = 'INSERT' AND policyname = 'work_packages_org_insert'))),
       NULL::text
UNION ALL
SELECT 'work_packages carries four policies after apply',
       (SELECT COUNT(*) = 4 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_packages'),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_143_before;
