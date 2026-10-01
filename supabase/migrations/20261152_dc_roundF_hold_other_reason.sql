-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 3 — P15 SURFACE REMAINDERS: an "Other" hold
-- is keyed by its note, a new hold's reason is a code, and an "Other" hold's
-- description is fixed (public-surfaces VFY-6 done-when 2).
--
--   VFY-6  document_holds.reason was free text: the picker's "Other…" wrote
--          whatever was typed into it, and reason is the field the public
--          verify surfaces name (by category only since HLD-7). P15 closes
--          that path in the app (the reversible option — no column split):
--          lib/holds.ts openHold writes only a reason CODE (the four
--          predefined reasons or "Other"), and an "Other" hold carries what
--          it is for in its NOTE (`notes`, which no public surface
--          publishes). Holds placed before P15 keep their text, and a
--          lifecycle copy (split / merge / reversal) carries a source's
--          legacy reason across unchanged — skipping a hold already open on
--          the target by THIS index's key (lib/holds.ts openHoldKey), so two
--          different "Other" holds are both carried.
--
--          What this file does (three parts, one paste):
--   1. The partial unique index document_holds_open_reason_uniq (20260612:
--      one OPEN hold per document and reason) keys an "Other" hold by its
--      note too — (document_id, reason, CASE WHEN reason = 'Other' THEN
--      md5(COALESCE(btrim(notes), '')) ELSE '' END) WHERE released_at IS
--      NULL. Without it, two different custom holds on one document — which
--      two different free-text reasons allowed before P15 — would collide on
--      the shared "Other" code. Every other reason keeps exactly one open
--      hold per document; two "Other" holds with the same note are still
--      one. The note is keyed by its md5 (second review fix): equal hashes
--      are equal notes, and the key stays 32 characters whatever the note's
--      length — a long description, or a lifecycle carry's nested
--      "Carried over from … Original notes: …", can never exceed the btree
--      row-size limit (an INSERT, or this CREATE INDEX over a long legacy
--      note, would fail on it).
--   2. The reason rail (second review fix — the database limb of done-when
--      2): a signed-in INSERT writes a reason CODE — the four predefined
--      reasons, or "Other" with a non-blank note (its description). A reason
--      outside the codes that a hold of the same org already carries exactly
--      is kept: the legacy reason a lifecycle copy carries across. Any other
--      text (third review fix) is COERCED, never refused: it becomes an
--      "Other" hold whose note is that text (ahead of any note sent with
--      it) — so the app that runs before P15, whose "Other…" picker types
--      free text into `reason`, still places every custom stop-work hold
--      (between this paste and the P15 deploy, or after a rollback of it),
--      and free text still never lands in `reason`. The only refusal is an
--      "Other" hold with no description. The column's free text can be
--      copied, never added to. The service role (a restore replaying held
--      history) keeps what it supplies, as 20261073 does. No CHECK: the rows
--      placed before P15 keep their text.
--   3. An "Other" hold's note is fixed once it is placed (second review
--      fix): it is the hold's description — identity, as the free-text
--      reason it replaces is under 20261073's guard (which leaves notes
--      editable on an open hold). For everyone; release the hold and place
--      a new one. Every other hold's note stays editable (20261073). No app
--      door edits a hold's note.
--      And (final review fix) no hold's reason can be changed once it is
--      placed — the rail binds INSERT, this binds UPDATE — for everyone,
--      exactly as 20261073's identity guard holds it (that guard grants no
--      exemption: a signed-in member, the service role, a restore and the
--      SQL console are all refused), so the two never disagree, and pasted
--      ahead of 20261073 a member's PATCH still cannot put free text in
--      `reason`. No app door changes a hold's reason.
--      The rail and the freeze are one trigger function,
--      enforce_document_hold_reason_code() — SECURITY INVOKER (it reads only
--      the caller's own org's holds, which document_holds_select already
--      shows any active member), search_path pinned, EXECUTE revoked from
--      every client role (DRLS-16; a trigger function's privilege is checked
--      when the trigger is created, never when it fires).
--
-- WIDENING (the index admits a row it refused: a second open "Other" hold
-- with a different note) AND NARROWING (the rail rewrites a signed-in hold's
-- new free text in `reason` into an "Other" hold described by it, and with
-- the freeze refuses rows the database admitted: an "Other" hold with no
-- description, a change to an "Other" hold's note; and a change to any
-- hold's reason — which 20261073 already refuses for everyone, so a
-- narrowing only where 20261073 is not yet pasted).
-- DEC-30 inventory (aggregate counts only, captured BEFORE the
-- transaction): holds whose reason is outside the code vocabulary (custom
-- text placed before P15 — kept, never rewritten; the public verify
-- surfaces already publish them only as "On hold"), how many of those are
-- open, documents with two or more open custom-reason holds, open "Other"
-- holds, and open "Other" holds with a blank note (kept; the description
-- rule binds new rows).
-- HOW TO APPLY: paste it BEFORE deploying the app carrying P15 (a
-- prerequisite of that deploy). Without it the P15 app refuses a second
-- open "Other" hold on one document (two different custom holds, placeable
-- today as two free-text reasons, would collide on the shared code), and a
-- split / merge / reversal that carries two "Other" holds onto one document
-- is refused and rolled back (fails closed — never a dropped hold). The
-- paste does not stop the app that runs today (third review fix): its
-- custom ("Other…") hold, free text in `reason`, is placed as an "Other"
-- hold described by that text — the same row the P15 picker writes — and
-- its predefined holds and lifecycle carries are unaffected; so the gap
-- before the deploy, or a rollback of the deploy, closes no stop-work path.
-- (That app names such a hold "Other" in its bell / email, and refuses an
-- identical second custom hold as "already open" — as it did before.)
-- Independent of every other pending migration: pasted before or after
-- 20261073, a hold's reason cannot be rewritten (both refuse it, for
-- everyone, check_violation). Single paste: temp-table
-- inventory -> BEGIN / DDL / COMMIT -> one SELECT (check text, ok boolean,
-- n text).
-- REVERSAL: DROP TRIGGER trg_document_hold_reason_code ON document_holds and
-- DROP FUNCTION enforce_document_hold_reason_code(); re-create the 20260612
-- index (document_id, reason) WHERE released_at IS NULL — possible only
-- while no document has two open "Other" holds (count them first).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_152_before;
CREATE TEMP TABLE dc_round_f_152_before AS
SELECT 'inventory (before apply): holds whose reason is custom text (outside the five codes) — placed before P15, kept as they are' AS inventory, COUNT(*)::text AS n
  FROM document_holds
 WHERE reason NOT IN ('Awaiting Engineering', 'Field Verification Needed', 'Missing Vendor Data', 'Client Review', 'Other')
UNION ALL
SELECT 'inventory (before apply): of those, open (released_at IS NULL) — published online only as On hold (HLD-7)', COUNT(*)::text
  FROM document_holds
 WHERE released_at IS NULL
   AND reason NOT IN ('Awaiting Engineering', 'Field Verification Needed', 'Missing Vendor Data', 'Client Review', 'Other')
UNION ALL
SELECT 'inventory (before apply): documents with two or more open custom-reason holds (the pattern this index keeps placeable under Other)', COUNT(*)::text
  FROM (SELECT document_id
          FROM document_holds
         WHERE released_at IS NULL
           AND reason NOT IN ('Awaiting Engineering', 'Field Verification Needed', 'Missing Vendor Data', 'Client Review', 'Other')
         GROUP BY document_id
        HAVING COUNT(*) >= 2) AS multi
UNION ALL
SELECT 'inventory (before apply): open holds already under the Other code', COUNT(*)::text
  FROM document_holds
 WHERE released_at IS NULL AND reason = 'Other'
UNION ALL
SELECT 'inventory (before apply): of those, with a blank note (kept; a NEW Other hold must carry its description)', COUNT(*)::text
  FROM document_holds
 WHERE released_at IS NULL AND reason = 'Other' AND NULLIF(btrim(notes), '') IS NULL;

BEGIN;

-- ── 1. The open-reason index: an "Other" hold is told apart by its note ────
--    (by the note's md5 — any length keys in 32 characters)
DROP INDEX IF EXISTS document_holds_open_reason_uniq;
CREATE UNIQUE INDEX document_holds_open_reason_uniq
  ON document_holds (document_id, reason, (CASE WHEN reason = 'Other' THEN md5(COALESCE(btrim(notes), '')) ELSE '' END))
  WHERE released_at IS NULL;

-- ── 2 + 3. A new hold's reason is a code; an "Other" hold's note is fixed ───
CREATE OR REPLACE FUNCTION enforce_document_hold_reason_code()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The service role (a restore replaying held history) keeps what it
    -- supplies, as the 20261073 guards do.
    IF auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.reason IN ('Awaiting Engineering', 'Field Verification Needed', 'Missing Vendor Data', 'Client Review') THEN
      RETURN NEW;
    END IF;
    -- A NULL reason is left to the column's NOT NULL, as before.
    IF NEW.reason IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.reason <> 'Other' THEN
      -- A reason outside the codes that a hold of this org already carries
      -- exactly is the text of a hold placed before P15, carried across by
      -- a split / merge / reversal (copyActiveHoldsToDoc copies a source
      -- hold's reason unchanged): kept as it is.
      IF EXISTS (SELECT 1 FROM document_holds h
                  WHERE h.org_id = NEW.org_id AND h.reason = NEW.reason) THEN
        RETURN NEW;
      END IF;
      -- Any other text — the custom reason the picker that ran before P15
      -- typed into `reason` — becomes an "Other" hold whose description
      -- (its note) is that text, ahead of any note sent with it. Coerced,
      -- never refused: a stop-work hold is placed whichever app places it.
      NEW.notes := concat_ws(E'\n', NULLIF(btrim(NEW.reason), ''), NULLIF(btrim(NEW.notes), ''));
      NEW.reason := 'Other';
    END IF;
    IF NULLIF(btrim(NEW.notes), '') IS NULL THEN
      RAISE EXCEPTION 'An "Other" hold needs a description: say in the hold note what the document is held for.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: a hold's reason is identity — fixed once placed, for everyone,
  -- exactly as 20261073's identity guard holds it (no exemption there, none
  -- here), so ahead of 20261073 an UPDATE cannot put free text in `reason`.
  IF NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'A hold''s reason cannot be changed once it is placed; release the hold and place a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- An "Other" hold's note IS its description — what the work is
  -- stopped for — so it is identity, as the free-text reason it replaces is
  -- (20261073). Fixed once placed, for everyone.
  IF OLD.reason = 'Other' AND NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'The description of an "Other" hold cannot be changed once it is placed; release the hold and place a new one.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_document_hold_reason_code() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_document_hold_reason_code ON document_holds;
CREATE TRIGGER trg_document_hold_reason_code
  BEFORE INSERT OR UPDATE ON document_holds
  FOR EACH ROW EXECUTE FUNCTION enforce_document_hold_reason_code();

COMMIT;

-- ── Verification + inventory: ONE result set (check, ok, n) ─────────────────
SELECT 'document_holds_open_reason_uniq exists, UNIQUE, on document_holds' AS check,
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'document_holds'
                  AND indexname = 'document_holds_open_reason_uniq'
                  AND indexdef LIKE 'CREATE UNIQUE INDEX%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'it is partial on open holds (released_at IS NULL)',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'document_holds'
                  AND indexname = 'document_holds_open_reason_uniq'
                  AND indexdef LIKE '%WHERE (released_at IS NULL)%'),
       NULL::text
UNION ALL
SELECT 'it keys (document_id, reason) and an Other hold by the md5 of its note',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'document_holds'
                  AND indexname = 'document_holds_open_reason_uniq'
                  -- deparsed: the CASE is printed on its own lines; % spans them
                  AND indexdef LIKE '%(document_id, reason, (%CASE%WHEN%Other%THEN%md5(COALESCE(btrim(notes)%ELSE%END)) WHERE%'),
       NULL::text
UNION ALL
SELECT 'document_holds carries exactly one unique index over (document_id, reason, ...) — the old two-column one is gone',
       (SELECT COUNT(*) = 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'document_holds'
           AND indexdef LIKE 'CREATE UNIQUE INDEX%(document_id, reason%'),
       NULL::text
UNION ALL
SELECT 'trg_document_hold_reason_code fires enforce_document_hold_reason_code BEFORE INSERT OR UPDATE on every document_holds row',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgname = 'trg_document_hold_reason_code' AND NOT t.tgisinternal
                  AND t.tgrelid = 'document_holds'::regclass AND p.proname = 'enforce_document_hold_reason_code'
                  AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16),
       NULL::text
UNION ALL
SELECT 'the rail: a signed-in INSERT writes a code, new free text becomes an Other hold described by it (never refused), an Other hold needs its description, a reason the org already carries is kept, and the service role passes',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_hold_reason_code'
                  AND p.prosrc LIKE '%IF auth.uid() IS NULL THEN%RETURN NEW%'
                  AND p.prosrc LIKE '%Awaiting Engineering%Field Verification Needed%Missing Vendor Data%Client Review%'
                  AND p.prosrc LIKE '%WHERE h.org_id = NEW.org_id AND h.reason = NEW.reason%'
                  AND p.prosrc LIKE '%NEW.notes := concat_ws(E%, NULLIF(btrim(NEW.reason), %), NULLIF(btrim(NEW.notes), %))%NEW.reason := %Other%'
                  AND p.prosrc LIKE '%IF NULLIF(btrim(NEW.notes), %) IS NULL THEN%needs a description%'
                  AND p.prosrc NOT LIKE '%A hold reason is one of:%'),
       NULL::text
UNION ALL
SELECT 'the freeze: an Other hold''s note cannot change once placed, for everyone',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_hold_reason_code'
                  AND p.prosrc LIKE '%IF OLD.reason = %Other% AND NEW.notes IS DISTINCT FROM OLD.notes THEN%'
                  AND p.prosrc LIKE '%cannot be changed once it is placed%'),
       NULL::text
UNION ALL
SELECT 'the reason is fixed once placed, for everyone, as 20261073''s identity guard holds it (an UPDATE cannot put free text in reason)',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_hold_reason_code'
                  AND p.prosrc LIKE '%IF NEW.reason IS DISTINCT FROM OLD.reason THEN%reason cannot be changed once it is placed%IF OLD.reason = %Other% AND NEW.notes IS DISTINCT FROM OLD.notes THEN%'),
       NULL::text
UNION ALL
SELECT 'enforce_document_hold_reason_code is SECURITY INVOKER with search_path pinned, and no client role may execute it (DRLS-16)',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_hold_reason_code'
                  AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'enforce_document_hold_reason_code()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_document_hold_reason_code()', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'after apply: documents with two or more open Other holds (allowed now when their notes differ)',
       NULL::boolean,
       (SELECT COUNT(*) FROM (SELECT document_id FROM document_holds
                               WHERE released_at IS NULL AND reason = 'Other'
                               GROUP BY document_id HAVING COUNT(*) >= 2) AS multi)::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_152_before;
