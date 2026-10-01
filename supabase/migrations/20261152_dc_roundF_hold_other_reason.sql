-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 3 — P15 SURFACE REMAINDERS: an "Other" hold
-- is keyed by its note (public-surfaces VFY-6 done-when 2).
--
--   VFY-6  document_holds.reason was free text: the picker's "Other…" wrote
--          whatever was typed into it, and reason is the field the public
--          verify surfaces name (by category only since HLD-7). P15 closes
--          that path in the app (the reversible option — no column split):
--          lib/holds.ts openHold writes only a reason CODE (the four
--          predefined reasons or "Other"), and an "Other" hold carries what
--          it is for in its NOTE (`notes`, which no public surface
--          publishes). The column itself keeps no CHECK: holds placed before
--          P15 keep their text, and a lifecycle copy (split / merge) carries
--          a source's hold across as it is.
--
--          What this file does: the partial unique index
--          document_holds_open_reason_uniq (20260612: one OPEN hold per
--          document and reason) now keys an "Other" hold by its note too —
--          (document_id, reason, CASE WHEN reason = 'Other' THEN
--          COALESCE(btrim(notes), '') ELSE '' END) WHERE released_at IS NULL.
--          Without it, two different custom holds on one document — which
--          two different free-text reasons allowed before P15 — would collide
--          on the shared "Other" code. Every other reason keeps exactly one
--          open hold per document; two "Other" holds with the same note are
--          still one.
--
-- WIDENING (the index admits a row it refused: a second open "Other" hold
-- with a different note), security-neutral (uniqueness only — no policy,
-- function or trigger is touched). DEC-30 inventory (aggregate counts only,
-- captured BEFORE the transaction): holds whose reason is outside the code
-- vocabulary (custom text placed before P15 — kept, never rewritten; the
-- public verify surfaces already publish them only as "On hold"), how many
-- of those are open, documents with two or more open custom-reason holds,
-- and open "Other" holds.
-- HOW TO APPLY: any time — before or with the app carrying P15 (until it is
-- pasted the app works, with one open "Other" hold per document at a time;
-- a second is refused with a sentence that says so). Independent of every
-- other pending migration. Single paste: temp-table inventory ->
-- BEGIN / DDL / COMMIT -> one SELECT (check text, ok boolean, n text).
-- REVERSAL: re-create the 20260612 index (document_id, reason) WHERE
-- released_at IS NULL — possible only while no document has two open
-- "Other" holds (count them first).
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
 WHERE released_at IS NULL AND reason = 'Other';

BEGIN;

-- ── The open-reason index: an "Other" hold is told apart by its note ───────
DROP INDEX IF EXISTS document_holds_open_reason_uniq;
CREATE UNIQUE INDEX document_holds_open_reason_uniq
  ON document_holds (document_id, reason, (CASE WHEN reason = 'Other' THEN COALESCE(btrim(notes), '') ELSE '' END))
  WHERE released_at IS NULL;

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
SELECT 'it keys (document_id, reason) and an Other hold by its note',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'document_holds'
                  AND indexname = 'document_holds_open_reason_uniq'
                  -- deparsed: the CASE is printed on its own lines; % spans them
                  AND indexdef LIKE '%(document_id, reason, (%CASE%WHEN%Other%THEN%COALESCE(btrim(notes)%ELSE%END)) WHERE%'),
       NULL::text
UNION ALL
SELECT 'document_holds carries exactly one unique index over (document_id, reason, ...) — the old two-column one is gone',
       (SELECT COUNT(*) = 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'document_holds'
           AND indexdef LIKE 'CREATE UNIQUE INDEX%(document_id, reason%'),
       NULL::text
UNION ALL
SELECT 'after apply: documents with two or more open Other holds (allowed now when their notes differ)',
       NULL::boolean,
       (SELECT COUNT(*) FROM (SELECT document_id FROM document_holds
                               WHERE released_at IS NULL AND reason = 'Other'
                               GROUP BY document_id HAVING COUNT(*) >= 2) AS multi)::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_152_before;
