-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-10, 99 Phase 0) — GAP-310 / CB-9: one tag grammar.
--
-- asset_aliases.alias_normalized was written with the codebook's display
-- spelling (lib/codebook.ts normalizeTag: uppercase, dashes kept —
-- "THENORTHFURNACE", "F-101") and read with the registry's identity key
-- (lowercase, alphanumerics only — "thenorthfurnace", "f101"), so a taught
-- alias never resolved in search or on the old-tag URL path. The one grammar
-- is the registry's key — lib/codebook.ts tagKey, which IS this database's
-- normalize_tag() (20260609) and what assets.tag_normalized already holds;
-- the table's own comment says "Same normalization as tags, so matching is
-- punctuation-blind". The readers flip in the SAME commit as this file
-- (lib/assetAliases.ts writes and resolves with tagKey; lib/assets.ts and
-- lib/search.ts already look up with it) — the GAP-310 Do-not.
--
--   1. Every alias row is rewritten to normalize_tag(alias). Collision-safe
--      under the unique (asset_id, alias_normalized) index: two spellings of
--      one alias on one asset ("North Furnace" / "north-furnace") share a
--      key now, so exactly ONE row per (asset, key) carries it — a row that
--      already does, else the oldest — and the other spellings keep their
--      old value: inert (never matched), kept for the record, never deleted.
--      An alias with no letter or digit has no key and is left untouched.
--   2. A BEFORE INSERT OR UPDATE trigger keeps the column in the grammar for
--      every writer — the app, a restore of an older export, a direct write.
--
-- NARROWS nothing and WIDENS nothing (no policy is touched). Pre-apply
-- inventory (DEC-30) is captured into a TEMP TABLE before the transaction:
-- aggregate counts only. Single paste: inventory → BEGIN/DDL/COMMIT → ONE
-- SELECT (check text, ok boolean, n text) — the editor shows only the last
-- result. Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the rewrite) ───────
CREATE TEMP TABLE IF NOT EXISTS _intel_g27_before AS
SELECT 'asset_aliases rows' AS what, COUNT(*) AS n
  FROM asset_aliases
UNION ALL
SELECT 'aliases whose alias_normalized is not the one-grammar key (the rewrite population)', COUNT(*)
  FROM asset_aliases WHERE normalize_tag(alias) <> '' AND alias_normalized IS DISTINCT FROM normalize_tag(alias)
UNION ALL
SELECT 'aliases with no letter or digit (no key; left untouched)', COUNT(*)
  FROM asset_aliases WHERE normalize_tag(alias) = ''
UNION ALL
SELECT 'duplicate spellings: extra rows sharing one (asset, key) — the extras stay inert', COUNT(*)
  FROM (SELECT asset_id, normalize_tag(alias) AS k, COUNT(*) AS c
          FROM asset_aliases WHERE normalize_tag(alias) <> ''
         GROUP BY asset_id, normalize_tag(alias) HAVING COUNT(*) > 1) g;

BEGIN;

-- ── 1. the rewrite (collision-safe) ─────────────────────────────────────────
WITH candidates AS (
  SELECT a.id,
         normalize_tag(a.alias) AS k,
         EXISTS (SELECT 1 FROM asset_aliases o
                  WHERE o.asset_id = a.asset_id AND o.id <> a.id
                    AND o.alias_normalized = normalize_tag(a.alias)) AS key_taken,
         row_number() OVER (PARTITION BY a.asset_id, normalize_tag(a.alias)
                            ORDER BY a.created_at, a.id) AS rn
    FROM asset_aliases a
   WHERE normalize_tag(a.alias) <> ''
     AND a.alias_normalized IS DISTINCT FROM normalize_tag(a.alias)
)
UPDATE asset_aliases a
   SET alias_normalized = c.k
  FROM candidates c
 WHERE a.id = c.id
   AND NOT c.key_taken
   AND c.rn = 1;

-- ── 2. every future writer lands in the grammar ─────────────────────────────
CREATE OR REPLACE FUNCTION asset_aliases_one_grammar()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- GAP-310: the key is derived, never supplied — the same normalize_tag()
  -- the documents↔assets sync uses for assets.tag_normalized.
  NEW.alias_normalized := normalize_tag(NEW.alias);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_asset_aliases_one_grammar ON asset_aliases;
CREATE TRIGGER trg_asset_aliases_one_grammar
  BEFORE INSERT OR UPDATE OF alias, alias_normalized ON asset_aliases
  FOR EACH ROW EXECUTE FUNCTION asset_aliases_one_grammar();

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'normalize_tag(text) is present and is the one grammar (lower, alphanumerics only)' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'normalize_tag'
                  AND p.prosrc LIKE '%lower(regexp_replace(%'
                  AND p.prosrc LIKE '%[^a-zA-Z0-9]+%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'every alias with a key is findable by it (some row of its asset carries normalize_tag(alias))',
       NOT EXISTS (SELECT 1 FROM asset_aliases a
                    WHERE normalize_tag(a.alias) <> ''
                      AND NOT EXISTS (SELECT 1 FROM asset_aliases b
                                       WHERE b.asset_id = a.asset_id
                                         AND b.alias_normalized = normalize_tag(a.alias))),
       NULL
UNION ALL
SELECT 'trigger trg_asset_aliases_one_grammar installed (BEFORE INSERT OR UPDATE, FOR EACH ROW)',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_asset_aliases_one_grammar'
                  AND t.tgrelid = 'asset_aliases'::regclass AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT 'asset_aliases_one_grammar derives the key from normalize_tag(NEW.alias) and pins search_path',
       (SELECT prosrc LIKE '%NEW.alias_normalized := normalize_tag(NEW.alias);%'
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'asset_aliases_one_grammar'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g27_before
UNION ALL
SELECT 'inventory (after): rows still off-grammar (expect = the duplicate spellings; inert, kept for the record)', NULL,
       (SELECT COUNT(*) FROM asset_aliases
         WHERE normalize_tag(alias) <> '' AND alias_normalized IS DISTINCT FROM normalize_tag(alias))::text;
