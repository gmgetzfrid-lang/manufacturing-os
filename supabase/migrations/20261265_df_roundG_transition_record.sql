-- ─────────────────────────────────────────────────────────────────────────────
-- 20261265_df_roundG_transition_record.sql
--
-- drafting-flow Round G — DF-P23 TRANSITION RECORD AND RECONCILE (DEC-90
-- rulings (3) and (4) for DF-P23: industry best practice, fail-safe, no
-- regression). Two sections, nothing renamed, no existing policy or trigger
-- re-created, and one existing function re-created (ticket_equipment_integrity,
-- 20261251's body plus one condition — section 1, DF-P23 merge-time fix pass):
--
--   (1) intelligence GAP-312 follow-up — ticket_equipment (20261251) gains a
--       UNIQUE index on (ticket_id, the tag's key), closing the race the
--       equipment route's read-then-write check (already_listed) cannot: two
--       adds that both read before either writes. The key is
--       ticket_equipment_tag_key(tag) (new; IMMUTABLE, SECURITY INVOKER,
--       search_path pinned) — the route's own comparison
--       (lib/ticketEquipment.ts equipmentListingKey: for an ASCII tag
--       lib/codebook.ts tagKey; a non-Latin tag's letters are kept; else the
--       trimmed lowercase tag), so "E-22", "E22" and "e 22" are one tag and
--       "Насос-1" and "Компрессор-1" are two. Lowercasing is made
--       context-free on both sides (a dotted capital I is "i", a final sigma
--       the sigma), so where the database's lower() and the browser's agree
--       letter by letter the index refuses nothing the route lets through; a
--       letter they case differently (a Unicode-version difference) is met by
--       the route's 23505 handling (an add: "already listed"; a correction:
--       retried once as a one-transaction respelling; the create route: each
--       entry written on its own).
--       replace_ticket_equipment (new; SECURITY INVOKER, search_path pinned,
--       EXECUTE for the service role only) replaces one entry with a
--       respelling of the same tag in ONE transaction (delete, then insert),
--       because the index would refuse the route's add-then-remove while the
--       old row stands; 20261251's integrity trigger still runs on the insert.
--       ticket_equipment_integrity (20261251's, re-created — DF-P23
--       merge-time fix pass) keeps every rule it had and lets one more
--       UPDATE through: a tag respelled within its key (the same key, so the
--       same entry by the index's own rule — what replace_ticket_equipment
--       already does as delete + insert). The equipment route uses it only
--       while PostgREST has not yet seen replace_ticket_equipment (PGRST202
--       right after the paste); a tag rewritten to another key, or any other
--       column changed, is still refused. Re-pasting 20261251 after this file
--       restores the strict body; the route then falls back as before the
--       paste (nothing breaks).
--       INVENTORY FIRST: the entries already listed twice are counted before
--       anything changes; while ANY exist, this paste REFUSES — nothing is
--       changed, and the error names the count. No row a person entered is
--       ever deleted or rewritten by this file.
--   (2) intelligence WIRE-7 criterion 1 — tickets gain unit_code: the Site
--       Codebook unit (codebook_entries, kind 'unit') the request's unit
--       names, or NULL. It is DERIVED, never written by the app: a BEFORE
--       INSERT OR UPDATE trigger (ticket_unit_code_derive; SECURITY INVOKER,
--       search_path pinned, executable by no client role) sets it from
--       tickets.unit on every write that inserts a request or changes its unit,
--       its org, its archived flag (archived_at set or cleared) or the column
--       itself, and on any write to a request whose unit_code is NULL while its
--       unit is set (DF-P23 merge-time fix pass: a request restored from the
--       archive, or one whose unit the codebook gained since, is coded on its
--       next write) — one lookup on the codebook's own unique key (org_id,
--       kind, code). So it only ever holds a code the codebook has (checked
--       against codebook_entries at the write), and a client that writes it
--       gets the derived value back. The open requests'
--       unit_code is filled once here (counted in the inventory first); a
--       re-paste also clears a live request's code the codebook no longer
--       holds for its unit (DF-P23 merge-time fix pass 2; never an archived
--       request's); a request's unit and every other column are untouched.
--
-- WHY NOT THE TRANSITION-AND-AUDIT RPC (EVID-12 done-when 1). Not built by
-- DF-P23 — recorded in EVID-12's Partial (DEC-90 ruling (1) for DF-P23): its
-- outcome could not be proven unchanged for every action × status × role
-- within scope, so DF-P8's drain stays.
--
-- PASTE / DEPLOY ORDER — REQUIRED: deploy the DF-P23 app first, then paste;
-- never before. Needs 20261251 (ticket_equipment) and the Site Codebook
-- (20260928); the first statement refuses otherwise, changing nothing.
--   * the DF-P23 app before the paste is safe: the equipment route meets no
--     index (a respelling's replace_ticket_equipment call answers 42883 /
--     PGRST202, the in-place respelling is refused by 20261251's trigger, and
--     the route takes today's add-then-remove, which works with no index),
--     and nothing reads tickets.unit_code;
--   * the app BEFORE DF-P23 with this paste loses a person's work: its create
--     route lists one tag once only by letter case ("E-22" and "E22" both
--     kept) and writes the whole equipment list in ONE insert, so a request
--     filed naming one tag in two spellings meets the index (23505) and is
--     filed with NONE of its equipment (the answer says it was not recorded);
--     its equipment route refuses a same-tag respelling correction (500, not
--     recorded) and answers a racing add 500 instead of "already listed".
--     No SQL here makes that old create route survive without weakening the
--     index (a trigger that silently skipped the second spelling would also
--     answer the DF-P23 route's racing add with no row, a 500), so the order
--     is required.
-- Not a widening (an index, a derived column, a service-role-only function;
-- the integrity trigger's one new pass is a same-key respelling by the service
-- role — clients still have no write grant on ticket_equipment).
-- Export / restore: no new table; tickets.unit_code is derived on the
-- restore's insert by the trigger. A backup taken before this paste that lists
-- one tag twice on a request restores its first entry; each later one is
-- reported, never refused (lib/dataRestore.ts DUPLICATE_EQUIPMENT_TAG).
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
-- EXISTS; the fill writes only live rows whose unit_code differs from the
-- code the codebook holds for their unit (set, or cleared).
-- Single paste: prerequisites → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.ticket_equipment') IS NULL THEN
    RAISE EXCEPTION '20261265 needs 20261251 (ticket_equipment) pasted first; nothing was changed.';
  END IF;
  IF to_regclass('public.codebook_entries') IS NULL THEN
    RAISE EXCEPTION '20261265 needs the Site Codebook (20260928, codebook_entries) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
-- The key is spelled out here (the function is created below).
DROP TABLE IF EXISTS df_round_g_265_before;
CREATE TEMP TABLE df_round_g_265_before AS
WITH keyed AS (
  SELECT ticket_id,
         CASE WHEN regexp_replace(translate(lower(translate(COALESCE(tag, ''), chr(304), 'i')), chr(962), chr(963)), '[^\u0080-\U0010ffffa-z0-9]|[\u00a0\u00ad\u2000-\u200b\u2010-\u2015\u2212\u202f\u3000\ufeff]', '', 'g') = ''
              THEN lower(regexp_replace(COALESCE(tag, ''), '^\s+|\s+$', '', 'g'))
              ELSE regexp_replace(translate(lower(translate(COALESCE(tag, ''), chr(304), 'i')), chr(962), chr(963)), '[^\u0080-\U0010ffffa-z0-9]|[\u00a0\u00ad\u2000-\u200b\u2010-\u2015\u2212\u202f\u3000\ufeff]', '', 'g') END AS k
    FROM ticket_equipment
), dup AS (
  SELECT ticket_id, k, COUNT(*) AS c FROM keyed GROUP BY ticket_id, k HAVING COUNT(*) > 1
)
SELECT 1 AS ord, 'inventory (before apply): equipment entries on requests (ticket_equipment)' AS inventory,
       (SELECT COUNT(*) FROM ticket_equipment)::text AS n
UNION ALL
SELECT 2, 'inventory (before apply): tags listed more than once on one request (by the route''s tag key) — expected 0; above 0 this paste REFUSES, nothing changed',
       (SELECT COUNT(*) FROM dup)::text
UNION ALL
SELECT 3, 'inventory (before apply): entries beyond the first in those groups (never deleted by this file)',
       (SELECT COALESCE(SUM(c - 1), 0) FROM dup)::text
UNION ALL
SELECT 4, 'inventory (before apply): requests carrying a tag listed twice',
       (SELECT COUNT(DISTINCT ticket_id) FROM dup)::text
UNION ALL
SELECT 5, 'inventory (before apply): live requests (not archived) whose unit is a Site Codebook unit code — their unit_code is filled by this paste',
       (SELECT COUNT(*) FROM tickets t WHERE t.archived_at IS NULL AND t.unit IS NOT NULL
           AND EXISTS (SELECT 1 FROM codebook_entries ce WHERE ce.org_id = t.org_id AND ce.kind = 'unit' AND ce.code = t.unit))::text
UNION ALL
SELECT 6, 'inventory (before apply): live requests with a unit the Site Codebook does not hold (a saved request-form unit, free text) — unit_code stays NULL, the unit is kept',
       (SELECT COUNT(*) FROM tickets t WHERE t.archived_at IS NULL AND t.unit IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM codebook_entries ce WHERE ce.org_id = t.org_id AND ce.kind = 'unit' AND ce.code = t.unit))::text;

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── 1. GAP-312 follow-up: one tag once per request ──────────────────────────
-- New function (no earlier body). The route's key (lib/ticketEquipment.ts
-- equipmentListingKey): a dotted capital I (chr(304)) read as "i", lowercase,
-- a final sigma (chr(962)) read as the sigma (chr(963)), then removed: ASCII
-- other than [a-z0-9] (for an ASCII tag exactly lib/codebook.ts tagKey) and
-- the Unicode spaces and dashes a pasted tag carries; every other letter is
-- KEPT ("Насос-1" and "Компрессор-1" are two tags). Nothing left: the trimmed
-- lowercase tag.
CREATE OR REPLACE FUNCTION ticket_equipment_tag_key(p_tag TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT CASE WHEN k = '' THEN lower(regexp_replace(COALESCE(p_tag, ''), '^\s+|\s+$', '', 'g')) ELSE k END
    FROM (SELECT regexp_replace(translate(lower(translate(COALESCE(p_tag, ''), chr(304), 'i')), chr(962), chr(963)), '[^\u0080-\U0010ffffa-z0-9]|[\u00a0\u00ad\u2000-\u200b\u2010-\u2015\u2212\u202f\u3000\ufeff]', '', 'g') AS k) s;
$$;

DO $$
DECLARE
  v_groups bigint;
  v_extra bigint;
BEGIN
  -- The count and the index build under one lock: no entry is added between them.
  LOCK TABLE ticket_equipment IN SHARE ROW EXCLUSIVE MODE;
  SELECT COUNT(*), COALESCE(SUM(c - 1), 0) INTO v_groups, v_extra FROM (
    SELECT COUNT(*) AS c FROM ticket_equipment GROUP BY ticket_id, ticket_equipment_tag_key(tag) HAVING COUNT(*) > 1
  ) d;
  IF v_groups > 0 THEN
    RAISE EXCEPTION '20261265 REFUSED: % tag(s) are listed more than once on one request (% entr(ies) beyond the first) — nothing was changed and no entry was deleted. Decide which entry of each stays, then paste this file again.', v_groups, v_extra;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_equipment_ticket_tag_key_uniq
  ON ticket_equipment (ticket_id, ticket_equipment_tag_key(tag));

-- Re-created (20261251's body; DF-P23 merge-time fix pass): every rule kept,
-- and a tag respelled WITHIN its key passes (the condition on NEW.tag below
-- is the only change) — the in-place respelling the equipment route uses
-- while PostgREST cannot yet see replace_ticket_equipment.
CREATE OR REPLACE FUNCTION ticket_equipment_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
       OR (NEW.tag IS DISTINCT FROM OLD.tag AND ticket_equipment_tag_key(NEW.tag) IS DISTINCT FROM ticket_equipment_tag_key(OLD.tag))
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
-- DRLS-16: a trigger function is executable by no client role (as 20261251).
REVOKE ALL ON FUNCTION ticket_equipment_integrity() FROM PUBLIC, anon, authenticated, service_role;

-- New function (no earlier body). A respelling of one entry, in one
-- transaction: the old row out, the corrected row in — both or neither.
CREATE OR REPLACE FUNCTION replace_ticket_equipment(
  p_row_id UUID, p_ticket_id UUID, p_org_id UUID, p_tag TEXT, p_asset_id UUID, p_created_by UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_id UUID;
BEGIN
  DELETE FROM ticket_equipment WHERE id = p_row_id AND ticket_id = p_ticket_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'replace_ticket_equipment: that entry is not on this request' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO ticket_equipment (org_id, ticket_id, tag, asset_id, created_by)
  VALUES (p_org_id, p_ticket_id, p_tag, p_asset_id, p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION replace_ticket_equipment(UUID, UUID, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION replace_ticket_equipment(UUID, UUID, UUID, TEXT, UUID, UUID) TO service_role;

-- ── 2. WIRE-7 criterion 1: tickets.unit_code, derived ───────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS unit_code TEXT;
COMMENT ON COLUMN tickets.unit_code IS
  'intelligence WIRE-7 / drafting-flow DF-P23 (20261265): the Site Codebook unit (codebook_entries kind unit) tickets.unit names, else NULL — derived by trg_ticket_unit_code on every write that sets the unit, changes the archived flag, or meets a NULL code with a unit set; never written by the app.';
CREATE INDEX IF NOT EXISTS tickets_org_unit_code_idx ON tickets (org_id, unit_code) WHERE unit_code IS NOT NULL;

-- New function (no earlier body). SECURITY INVOKER: the service role (every
-- writer of tickets.unit) reads the codebook past RLS; a member's own write
-- (none sets the unit — the guard refuses it) reads it as its RLS allows.
CREATE OR REPLACE FUNCTION ticket_unit_code_derive()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Unchanged unit, org, archived flag and code, and nothing left to derive
  -- (a code on record, or no unit): nothing read. DF-P23 merge-time fix pass:
  -- a request un-archived (archived_at cleared) or whose code is NULL while
  -- its unit is set is derived again — one lookup on the codebook's unique
  -- key (org_id, kind, code).
  IF TG_OP = 'UPDATE'
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.unit_code IS NOT DISTINCT FROM OLD.unit_code
     AND (NEW.archived_at IS NULL) = (OLD.archived_at IS NULL)
     AND NOT (NEW.unit_code IS NULL AND NEW.unit IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  NEW.unit_code := (SELECT ce.code FROM codebook_entries ce
                     WHERE ce.org_id = NEW.org_id AND ce.kind = 'unit' AND ce.code = NEW.unit
                     LIMIT 1);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ticket_unit_code ON tickets;
CREATE TRIGGER trg_ticket_unit_code
  BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_unit_code_derive();
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_unit_code_derive() FROM PUBLIC, anon, authenticated, service_role;

-- The live requests' unit_code, filled once (only rows whose value differs).
UPDATE tickets t
   SET unit_code = ce.code
  FROM codebook_entries ce
 WHERE ce.org_id = t.org_id AND ce.kind = 'unit' AND ce.code = t.unit
   AND t.archived_at IS NULL
   AND t.unit_code IS DISTINCT FROM ce.code;
-- DF-P23 merge-time fix pass 2: and cleared where the codebook no longer
-- holds the live request's unit (a unit deleted or recoded since an earlier
-- paste) — so verification row 7 holds on a re-paste. Live requests only;
-- an archived one is never written here. Nothing to clear on a first paste.
UPDATE tickets t
   SET unit_code = NULL
 WHERE t.archived_at IS NULL
   AND t.unit_code IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM codebook_entries ce
                    WHERE ce.org_id = t.org_id AND ce.kind = 'unit' AND ce.code = t.unit);

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord,
       'GAP-312: ticket_equipment carries a valid UNIQUE index on (ticket_id, ticket_equipment_tag_key(tag)) — one tag once per request' AS check,
       EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                WHERE i.indrelid = 'public.ticket_equipment'::regclass AND c.relname = 'ticket_equipment_ticket_tag_key_uniq'
                  AND i.indisunique AND i.indisvalid AND i.indisready
                  AND pg_get_indexdef(i.indexrelid) LIKE '%(ticket_id, ticket_equipment_tag_key(tag))%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'GAP-312: the key is the route''s — "E-22", "E22", "e 22" and "E–22" are one tag; two different tags (a non-Latin tag''s letters are kept: "Насос-1" and "Компрессор-1") stay two',
       ticket_equipment_tag_key('E-22') = ticket_equipment_tag_key('E22')
       AND ticket_equipment_tag_key('e 22') = 'e22'
       AND ticket_equipment_tag_key('P-101A') <> ticket_equipment_tag_key('P-101')
       AND ticket_equipment_tag_key('  Насос  ') = lower('Насос')
       AND ticket_equipment_tag_key('E–22') = 'e22'
       AND ticket_equipment_tag_key('Насос-1') <> ticket_equipment_tag_key('Компрессор-1')
       AND (SELECT provolatile FROM pg_proc WHERE oid = 'public.ticket_equipment_tag_key(text)'::regprocedure) = 'i'
       AND (SELECT proconfig @> ARRAY['search_path=public'] FROM pg_proc WHERE oid = 'public.ticket_equipment_tag_key(text)'::regprocedure),
       NULL
UNION ALL
SELECT 1, 3, 'GAP-312: no tag is listed twice on one request now; no entry was removed by this paste (the count is at least inventory row 1)',
       NOT EXISTS (SELECT 1 FROM ticket_equipment GROUP BY ticket_id, ticket_equipment_tag_key(tag) HAVING COUNT(*) > 1)
       AND (SELECT COUNT(*) FROM ticket_equipment) >= (SELECT n FROM df_round_g_265_before WHERE ord = 1)::bigint,
       NULL
UNION ALL
SELECT 1, 4, 'GAP-312: replace_ticket_equipment — one transaction, SECURITY INVOKER, search_path pinned; EXECUTE for the service role only (not PUBLIC, anon or authenticated)',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.replace_ticket_equipment(uuid, uuid, uuid, text, uuid, uuid)'::regprocedure
                 AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                 AND p.prosrc LIKE '%DELETE FROM ticket_equipment WHERE id = p_row_id AND ticket_id = p_ticket_id AND org_id = p_org_id;%'
                 AND p.prosrc LIKE '%INSERT INTO ticket_equipment (org_id, ticket_id, tag, asset_id, created_by)%')
       AND has_function_privilege('service_role', 'public.replace_ticket_equipment(uuid, uuid, uuid, text, uuid, uuid)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.replace_ticket_equipment(uuid, uuid, uuid, text, uuid, uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.replace_ticket_equipment(uuid, uuid, uuid, text, uuid, uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 5, 'GAP-312: ticket_equipment''s own rails hold (one SELECT policy, no client write grant, the integrity trigger enabled — still refusing a tag rewritten to another key, another workspace''s request or asset; only a respelling within its key passes)',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_equipment') = 1
       AND NOT has_table_privilege('authenticated', 'public.ticket_equipment', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_equipment', 'UPDATE')
       AND EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                    WHERE tg.tgrelid = 'public.ticket_equipment'::regclass AND tg.tgname = 'trg_ticket_equipment_integrity' AND tg.tgenabled = 'O'
                      AND p.proname = 'ticket_equipment_integrity' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                      AND p.prosrc LIKE '%(NEW.tag IS DISTINCT FROM OLD.tag AND ticket_equipment_tag_key(NEW.tag) IS DISTINCT FROM ticket_equipment_tag_key(OLD.tag))%'
                      AND p.prosrc LIKE '%the request is not in this workspace%'
                      AND p.prosrc LIKE '%the asset is not in this workspace%')
       AND NOT has_function_privilege('authenticated', 'public.ticket_equipment_integrity()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 6, 'WIRE-7: tickets.unit_code exists, derived by trg_ticket_unit_code (BEFORE INSERT OR UPDATE, enabled; again on an archived-flag change or a NULL code with a unit set; SECURITY INVOKER, search_path pinned, not executable by clients)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'unit_code')
       AND EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                    WHERE tg.tgrelid = 'public.tickets'::regclass AND tg.tgname = 'trg_ticket_unit_code' AND tg.tgenabled = 'O'
                      AND p.proname = 'ticket_unit_code_derive' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                      AND p.prosrc LIKE '%WHERE ce.org_id = NEW.org_id AND ce.kind = ''unit'' AND ce.code = NEW.unit%'
                      AND p.prosrc LIKE '%(NEW.archived_at IS NULL) = (OLD.archived_at IS NULL)%'
                      AND p.prosrc LIKE '%NOT (NEW.unit_code IS NULL AND NEW.unit IS NOT NULL)%')
       AND NOT has_function_privilege('authenticated', 'public.ticket_unit_code_derive()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_unit_code_derive()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 7, 'WIRE-7: every live request''s unit_code is the codebook unit its unit names, or NULL — never a code the codebook does not hold',
       NOT EXISTS (SELECT 1 FROM tickets t WHERE t.archived_at IS NULL
                     AND t.unit_code IS DISTINCT FROM (SELECT ce.code FROM codebook_entries ce
                                                        WHERE ce.org_id = t.org_id AND ce.kind = 'unit' AND ce.code = t.unit LIMIT 1)),
       NULL
UNION ALL
SELECT 1, 8, 'row-level security is still enabled on tickets and ticket_equipment (untouched)',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tickets'::regclass)
       AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ticket_equipment'::regclass),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_265_before
UNION ALL
SELECT 3, 1, 'after: live requests whose unit_code is set (the codebook unit their unit names)', NULL,
       (SELECT COUNT(*) FROM tickets WHERE archived_at IS NULL AND unit_code IS NOT NULL)::text
) AS final_rows
ORDER BY sec, ord;
