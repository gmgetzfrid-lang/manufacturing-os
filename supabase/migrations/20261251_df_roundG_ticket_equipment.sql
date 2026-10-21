-- ─────────────────────────────────────────────────────────────────────────────
-- 20261251_df_roundG_ticket_equipment.sql
--
-- drafting-flow Round G — DF-P6 REVIEW-MODEL, with intelligence GAP-312 and
-- WIRE-7 criterion 1: the drafting request names its equipment — through the
-- registry (assets, I-10) and the Bridge's relation (document_assets, I-11),
-- never a free-text column on the ticket.
--
--   (1) ticket_equipment (new): one row per equipment tag a request names —
--       the tag as the requester typed it, and the asset it resolved to in
--       this workspace's registry (asset_id; NULL = not found, kept as typed
--       and so flagged — GAP-312 acceptance 1). Written by the create route
--       as the service role (no client write policy, no client write grant).
--       Read by a member through the ticket's own read scope: the SELECT
--       policy asks for the ticket as the caller, so whoever cannot read the
--       ticket cannot read its equipment (the Contractor-only scope of
--       20261166 included). ON DELETE CASCADE with the ticket (as
--       ticket_comments); ON DELETE SET NULL with the asset (the typed tag
--       stays, now unresolved).
--   (2) ticket_equipment_integrity() (new; SECURITY INVOKER, search_path
--       pinned) + its BEFORE INSERT OR UPDATE trigger: a row's org is its
--       ticket's org, and its asset (when named) is an asset of that org —
--       for every writer, the service role included. On UPDATE only the
--       asset may change, and only to NULL (the asset's own deletion).
--
-- PASTE / DEPLOY ORDER. Independent of 20261250 (either first). Deploy
-- first is the smoother: the DF-P6 app before this paste writes no row (the
-- insert answers 42P01 / PGRST205 — the request is filed and the answer
-- says the equipment was not recorded) and the ticket page's card reads
-- nothing (it says the equipment list is not available yet). The app
-- before DF-P6 never reads or writes the table.
--
-- Not a widening (a new table, readable only where its ticket is). Export /
-- restore: a new ORG_SCOPED table, restored after tickets and assets — the
-- integrator's decision at merge (lib/exportTables.ts, lib/dataRestore.ts).
-- Re-runnable: CREATE TABLE / INDEX IF NOT EXISTS, the policy and the trigger
-- DROP-then-CREATE, the function CREATE OR REPLACE.
-- Single paste: temp-table inventory (counts only) → BEGIN/DDL/COMMIT → one
-- SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only) ────────────────────────────────────
DROP TABLE IF EXISTS df_round_g_251_before;
CREATE TEMP TABLE df_round_g_251_before AS
SELECT 1 AS ord, 'inventory (before apply): equipment in the registry (assets, not archived)' AS inventory,
       COUNT(*)::text AS n
  FROM assets WHERE NOT archived
UNION ALL
SELECT 2, 'inventory (before apply): open drafting requests (none names equipment yet)',
       COUNT(*)::text
  FROM tickets WHERE archived_at IS NULL AND status NOT IN ('CLOSED', 'CANCELED');

BEGIN;

-- ── 1. the relation ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_equipment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  asset_id    UUID REFERENCES assets(id) ON DELETE SET NULL,
  tag         TEXT NOT NULL CHECK (char_length(btrim(tag)) BETWEEN 1 AND 80),
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_equipment_ticket_idx ON ticket_equipment (ticket_id);
CREATE INDEX IF NOT EXISTS ticket_equipment_asset_idx ON ticket_equipment (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_equipment_org_idx ON ticket_equipment (org_id);
COMMENT ON TABLE ticket_equipment IS
  'drafting-flow DF-P6 / intelligence GAP-312, WIRE-7 (20261251): the equipment a drafting request names — the tag as typed and the registry asset it resolved to (NULL = not found, flagged). Written by the create route (service role); read through the ticket''s own read scope.';

ALTER TABLE ticket_equipment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_equipment_select ON ticket_equipment;
CREATE POLICY ticket_equipment_select ON ticket_equipment FOR SELECT TO authenticated
  USING (org_id IN (SELECT my_org_ids())
         AND EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_equipment.ticket_id));
REVOKE ALL ON ticket_equipment FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_equipment FROM authenticated;
GRANT SELECT ON ticket_equipment TO authenticated;
GRANT ALL ON ticket_equipment TO service_role;

-- ── 2. integrity, for every writer ─────────────────────────────────────────
-- New function (no earlier body). SECURITY INVOKER: the service role (its one
-- writer) reads tickets and assets past RLS anyway; a client cannot write.
CREATE OR REPLACE FUNCTION ticket_equipment_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.tag IS DISTINCT FROM OLD.tag
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.asset_id IS DISTINCT FROM OLD.asset_id AND NEW.asset_id IS NOT NULL) THEN
      RAISE EXCEPTION 'ticket_equipment: a recorded tag is not rewritten (only its asset clears, when the asset is deleted)';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = NEW.ticket_id AND t.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'ticket_equipment: the request is not in this workspace';
  END IF;
  IF NEW.asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'ticket_equipment: the asset is not in this workspace';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ticket_equipment_integrity ON ticket_equipment;
CREATE TRIGGER trg_ticket_equipment_integrity
  BEFORE INSERT OR UPDATE ON ticket_equipment
  FOR EACH ROW EXECUTE FUNCTION ticket_equipment_integrity();
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_equipment_integrity() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
SELECT 'GAP-312: ticket_equipment exists (ticket, asset, tag as typed), RLS on' AS check,
       (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ticket_equipment')
        AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ticket_equipment'::regclass)
        AND (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ticket_equipment'
                AND column_name IN ('org_id', 'ticket_id', 'asset_id', 'tag', 'created_by', 'created_at')) = 6) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'ticket_equipment: one SELECT policy, through the ticket''s own read scope; no client write policy or grant',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_equipment') = 1
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_equipment'
                    AND policyname = 'ticket_equipment_select' AND cmd = 'SELECT'
                    AND qual LIKE '%my_org_ids()%' AND qual LIKE '%FROM tickets t%')
       AND NOT has_table_privilege('authenticated', 'public.ticket_equipment', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_equipment', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ticket_equipment', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.ticket_equipment', 'SELECT'),
       NULL
UNION ALL
SELECT 'ticket_equipment_integrity: org = the ticket''s, asset of that org, tags never rewritten; SECURITY INVOKER, search_path pinned, trigger enabled; not executable by clients',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger tg ON tg.tgfoid = p.oid
                WHERE p.proname = 'ticket_equipment_integrity' AND NOT p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND tg.tgrelid = 'public.ticket_equipment'::regclass AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%the request is not in this workspace%'
                  AND p.prosrc LIKE '%the asset is not in this workspace%')
       AND NOT has_function_privilege('authenticated', 'public.ticket_equipment_integrity()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_equipment_integrity()', 'EXECUTE'),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_251_before ORDER BY ord) b
UNION ALL
SELECT 'after: equipment rows recorded (0 right after the paste)', NULL, (SELECT COUNT(*) FROM ticket_equipment)::text;
