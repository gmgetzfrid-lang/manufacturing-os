-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-08) — who may publish an org-wide skill, and who
-- owns the built-ins.
--
-- A Reasoning Skill (answer_skills) is free text that rides every colleague's
-- answer prompt and the orchestrator's playbook; a Connection Skill
-- (link_rules) is a set of regexes the engine runs over the whole corpus.
-- Both admitted ANY active member as the author of an ORG-WIDE row (IEDGE-3,
-- GOV-2, IRLS-3, ORCH-2, PR-3), and whoever opened the Skill Library first
-- became the author — and so the manager — of every built-in (HUB-2, LNK-7).
--
-- What this file changes (apply after 20261016):
--   1. Authority (DEC-35: the controller tier is is_org_controller — no role
--      list; is_org_controller_for asks the same question about another
--      user, for the data step and the restore guard). A member authors
--      PRIVATE skills; only a controller publishes
--      org-wide or flips a row to 'org'. A member may ASK to share
--      (share_requested): the row stays private — it rides only its author
--      and the engine does not run it — and controllers (who read every
--      skill of the org) approve (visibility -> 'org', stamped shared_by /
--      shared_at) or decline. An author may unshare or delete their own row; changing an
--      org-wide row is a controller act (a reviewed pack cannot be rewritten
--      by its author afterwards). A member's PRIVATE skill stays theirs: a
--      controller approves or declines its share request (visibility /
--      share_requested) and changes nothing else while it is private — the
--      guards refuse any other change by someone who is not its author —
--      and deletes only org-wide custom rows. Nobody changes a skill's
--      author or built-in key.
--   2. Built-ins belong to nobody: created_by NULL, managed by controllers,
--      never deleted by a person (every seeder restores a missing one — turn
--      it off instead). Built-ins already carrying a member's uid are
--      released (HUB-2, LNK-7), and the guards clear the author of a
--      built-in on EVERY write — a restored pre-20261125 backup included.
--   3. Existing org-wide custom rows whose author is not an active controller
--      go back to private with a share request, so a controller reviews them
--      before they reach anyone else again (fail-safe; nothing is deleted).
--      Rows a controller has approved carry shared_by and are never touched.
--   4. New custom rows default to 'private' (GOV-2).
--   5. Guards (BEFORE INSERT OR UPDATE). Sharing is stamped by the database,
--      not claimed by the client; updated_at is stamped on every update;
--      re-enabling a connection skill clears the engine's note. A
--      service-role INSERT of an org-wide custom row nobody approved (the
--      org restore of a pre-20261125 backup) whose author is not an active
--      controller arrives private with a share request — the data step's
--      rule, at the door. For a PERSON's write (the service role's seeding
--      and the org restore pass):
--        answer_skills — a new or changed pack, or one being published, is
--          40-4000 characters and says when it applies (APPLIES WHEN).
--        link_rules — a new or changed config holds at most 8 patterns of
--          1-200 characters in the bounded subset compileSkillPatterns
--          (lib/linkProposalLogic.ts) enforces with the same rules: no
--          repeated group holding a repeat, an alternation or another group;
--          no lookaround, named group, inline flag or backreference; a
--          repeat bounded above 10 counts as unbounded; no unbounded repeat
--          of '.'; no two unbounded repeats with only optional atoms between
--          them; at most 2 unbounded repeats; no repeat bound over 100.
--          minCoCitations is 1-50. A PATCH of config can no longer bypass
--          the Studio's validation (LNK-6), and publishing a skill (its
--          visibility becoming 'org') re-checks its patterns. The subset is a filter, not a
--          proof of linear time: the engine runs patterns in a worker it
--          terminates on a hard deadline (lib/customSkillRunner.ts).
--   6. link_rules.disabled_reason — the engine's note when a skill's match
--      ran past the worker's hard ceiling and was switched off (LNK-6).
--   7. Audit (PR-3, LNK-7, GOV-2): every person-initiated create / change /
--      delete of a skill writes an audit_logs row naming the actor, the skill
--      and what changed — with the pack text or patterns whenever they are
--      written or published AND the row is (or was) org-visible. audit_logs
--      is readable by every active member of the org, so a PRIVATE skill's
--      words never go there: its name, description, text and patterns are
--      recorded as withheld, with the pack's length and md5 and the pattern
--      count.
--
-- NARROWS (members lose org-wide publishing and built-in management;
-- controllers lose built-in DELETE) and WIDENS ONE READ AND ONE DECISION:
-- controllers (the is_org_controller tier) now read every PRIVATE skill of
-- their org — the share requests are theirs to decide, and a decision that
-- leaves a row private must read back — and so, for the first time, their
-- UPDATE reaches a member's private row (before, it matched nothing: the
-- read hid the row). That write is held to the share decision: approve
-- (visibility -> 'org') or decline (share_requested -> false). The guards
-- refuse any other change to a private skill by someone who is not its
-- author — no rewrite of its text or patterns, no switching it, no new
-- author — and the DELETE policy admits a controller on org-wide custom
-- rows only. The inventory counts, per table, the private custom skills
-- that become controller-readable; after apply it also counts the custom
-- connection skills holding a pattern the bounded subset refuses (that
-- pattern stops running) and the org-wide, switched-on ones left with
-- none. Pre-apply inventory
-- (DEC-30) is captured into a TEMP TABLE before the transaction: aggregate
-- counts only. The inventory runs before is_org_controller_for exists, so
-- it spells the controller predicate out; a probe pins that text to
-- is_org_controller's and is_org_controller_for's bodies. Single paste: inventory -> BEGIN/DDL/COMMIT -> ONE SELECT
-- (check text, ok boolean, n text) — the editor shows only the last result.
-- Every SECURITY DEFINER function pins SET search_path = public. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g25_before AS
SELECT 'answer_skills built-in rows carrying a member uid (released: created_by NULL)' AS what, COUNT(*) AS n
  FROM answer_skills WHERE builtin_key IS NOT NULL AND created_by IS NOT NULL
UNION ALL
SELECT 'link_rules built-in rows carrying a member uid (released: created_by NULL)', COUNT(*)
  FROM link_rules WHERE builtin_key IS NOT NULL AND created_by IS NOT NULL
UNION ALL
SELECT 'answer_skills org-wide custom packs whose author is not an active controller (back to private, share requested)', COUNT(*)
  FROM answer_skills s
 WHERE s.builtin_key IS NULL AND s.visibility = 'org'
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = s.org_id AND m.uid = s.created_by AND m.status = 'active'
                      AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
UNION ALL
SELECT 'link_rules org-wide custom skills whose author is not an active controller (back to private, share requested)', COUNT(*)
  FROM link_rules r
 WHERE r.builtin_key IS NULL AND r.visibility = 'org'
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = r.org_id AND m.uid = r.created_by AND m.status = 'active'
                      AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
UNION ALL
SELECT 'answer_skills custom packs that never say APPLIES WHEN (left as they are; a new, changed or published pack must)', COUNT(*)
  FROM answer_skills WHERE builtin_key IS NULL AND instructions !~* 'applies when'
UNION ALL
SELECT 'answer_skills custom packs longer than 4000 characters (left as they are; a new or changed pack must fit)', COUNT(*)
  FROM answer_skills WHERE builtin_key IS NULL AND length(instructions) > 4000
UNION ALL
SELECT 'link_rules custom skills with more than 8 patterns or a pattern over 200 characters (the engine refuses them at run)', COUNT(*)
  FROM link_rules r
 WHERE r.builtin_key IS NULL AND jsonb_typeof(r.config->'patterns') = 'array'
   AND (jsonb_array_length(r.config->'patterns') > 8
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(r.config->'patterns') e
                    WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > 200))
UNION ALL
SELECT 'active members who are not controllers (lose org-wide skill publishing; keep private authoring and share requests)', COUNT(*)
  FROM org_members
 WHERE status = 'active'
   AND NOT (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
UNION ALL
SELECT 'answer_skills private custom packs newly readable by controllers (WIDENING: controllers read every skill of the org)', COUNT(*)
  FROM answer_skills WHERE builtin_key IS NULL AND visibility = 'private'
UNION ALL
SELECT 'link_rules private custom skills newly readable by controllers (WIDENING: controllers read every skill of the org)', COUNT(*)
  FROM link_rules WHERE builtin_key IS NULL AND visibility = 'private';

BEGIN;

-- ── 0. columns ──────────────────────────────────────────────────────────────
ALTER TABLE answer_skills ADD COLUMN IF NOT EXISTS share_requested BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE answer_skills ADD COLUMN IF NOT EXISTS shared_by UUID;
ALTER TABLE answer_skills ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
ALTER TABLE link_rules ADD COLUMN IF NOT EXISTS share_requested BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE link_rules ADD COLUMN IF NOT EXISTS shared_by UUID;
ALTER TABLE link_rules ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
ALTER TABLE link_rules ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
-- GOV-2: a new custom row is private unless someone with the authority says otherwise.
ALTER TABLE answer_skills ALTER COLUMN visibility SET DEFAULT 'private';
ALTER TABLE link_rules ALTER COLUMN visibility SET DEFAULT 'private';

-- ── 0b. DEC-35: the controller tier, asked about ANOTHER user ───────────────
-- is_org_controller reads auth.uid() only, so it cannot say whether a skill's
-- AUTHOR is a controller. This is its body with p_uid for auth.uid() — a
-- probe pins the two together. Not callable by clients (it would answer for
-- any user of any org); the data step runs as the migration owner and the
-- restore guard as the service role.
CREATE OR REPLACE FUNCTION is_org_controller_for(p_org uuid, p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = p_uid
      AND org_id = p_org
      AND status = 'active'
      AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
  );
$$;
REVOKE ALL ON FUNCTION is_org_controller_for(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_org_controller_for(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION is_org_controller_for(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION is_org_controller_for(uuid, uuid) TO service_role;

-- ── 1. data: built-ins belong to nobody; unreviewed org-wide rows go back ───
UPDATE answer_skills SET created_by = NULL WHERE builtin_key IS NOT NULL AND created_by IS NOT NULL;
UPDATE link_rules SET created_by = NULL WHERE builtin_key IS NOT NULL AND created_by IS NOT NULL;

UPDATE answer_skills s SET visibility = 'private', share_requested = true, updated_at = now()
 WHERE s.builtin_key IS NULL AND s.visibility = 'org' AND s.shared_by IS NULL
   AND NOT is_org_controller_for(s.org_id, s.created_by);
UPDATE link_rules r SET visibility = 'private', share_requested = true, updated_at = now()
 WHERE r.builtin_key IS NULL AND r.visibility = 'org' AND r.shared_by IS NULL
   AND NOT is_org_controller_for(r.org_id, r.created_by);

-- ── 2. authority (IEDGE-3 / GOV-2 / IRLS-3 / ORCH-2 / PR-3 / HUB-2 / LNK-7) ─
-- Members see org skills and their own; controllers see every skill of the
-- org — they govern what rides the org's prompts, the share requests are
-- theirs to decide, and a decision that leaves a row private must still be
-- readable back (PostgREST returns the updated row).
DROP POLICY IF EXISTS answer_skills_select ON answer_skills;
CREATE POLICY answer_skills_select ON answer_skills FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = answer_skills.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND (visibility = 'org' OR created_by = auth.uid() OR is_org_controller(org_id))
);

-- A custom row is written by its author — org-wide only by a controller; a
-- built-in row is written by a controller and owned by nobody.
DROP POLICY IF EXISTS answer_skills_insert ON answer_skills;
CREATE POLICY answer_skills_insert ON answer_skills FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = answer_skills.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND (
    (builtin_key IS NULL AND created_by = auth.uid()
     AND (visibility = 'private' OR is_org_controller(org_id)))
    OR (builtin_key IS NOT NULL AND created_by IS NULL AND is_org_controller(org_id))
  )
);

-- Controllers manage every row (a built-in stays owned by nobody); an author
-- manages their own custom row and can only ever leave it private.
DROP POLICY IF EXISTS answer_skills_update ON answer_skills;
CREATE POLICY answer_skills_update ON answer_skills FOR UPDATE USING (
  is_org_controller(org_id)
  OR (builtin_key IS NULL AND created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = answer_skills.org_id
                  AND m.uid = auth.uid() AND m.status = 'active'))
) WITH CHECK (
  (is_org_controller(org_id) AND (builtin_key IS NULL OR created_by IS NULL))
  OR (builtin_key IS NULL AND created_by = auth.uid() AND visibility = 'private')
);

-- A built-in is never deleted by a person (turn it off); an org-wide
-- custom row by a controller; any custom row by its author. A member's
-- private row is theirs — a controller declines its request instead.
DROP POLICY IF EXISTS answer_skills_delete ON answer_skills;
CREATE POLICY answer_skills_delete ON answer_skills FOR DELETE USING (
  builtin_key IS NULL
  AND ((is_org_controller(org_id) AND visibility = 'org')
       OR (created_by = auth.uid()
           AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = answer_skills.org_id
                       AND m.uid = auth.uid() AND m.status = 'active')))
);

DROP POLICY IF EXISTS link_rules_select ON link_rules;
CREATE POLICY link_rules_select ON link_rules FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = link_rules.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND (visibility = 'org' OR created_by = auth.uid() OR is_org_controller(org_id))
);

DROP POLICY IF EXISTS link_rules_insert ON link_rules;
CREATE POLICY link_rules_insert ON link_rules FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = link_rules.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND (
    (builtin_key IS NULL AND created_by = auth.uid()
     AND (visibility = 'private' OR is_org_controller(org_id)))
    OR (builtin_key IS NOT NULL AND created_by IS NULL AND is_org_controller(org_id))
  )
);

DROP POLICY IF EXISTS link_rules_update ON link_rules;
CREATE POLICY link_rules_update ON link_rules FOR UPDATE USING (
  is_org_controller(org_id)
  OR (builtin_key IS NULL AND created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = link_rules.org_id
                  AND m.uid = auth.uid() AND m.status = 'active'))
) WITH CHECK (
  (is_org_controller(org_id) AND (builtin_key IS NULL OR created_by IS NULL))
  OR (builtin_key IS NULL AND created_by = auth.uid() AND visibility = 'private')
);

DROP POLICY IF EXISTS link_rules_delete ON link_rules;
CREATE POLICY link_rules_delete ON link_rules FOR DELETE USING (
  builtin_key IS NULL
  AND ((is_org_controller(org_id) AND visibility = 'org')
       OR (created_by = auth.uid()
           AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = link_rules.org_id
                       AND m.uid = auth.uid() AND m.status = 'active')))
);

-- ── 3. LNK-6: the bounded pattern subset, at the database ───────────────────
-- Mirrors patternSafetyIssue() in lib/linkProposalLogic.ts rule for rule, on
-- the same normalised text (escapes -> E, character classes -> C, '(?:' ->
-- '('; a repeat bounded above 10 -> '*' or '+'; the adjacency view drops
-- what can match nothing). It never refuses what the app accepts; the app
-- additionally compiles each pattern and refuses one that matches empty
-- text. A filter, not a proof: the engine's worker deadline bounds a run.
CREATE OR REPLACE FUNCTION skill_pattern_issue(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  s    text;
  raw  text;
  u    text;
  v    text;
  prev text;
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN 'empty pattern'; END IF;
  IF length(p) > 200 THEN RETURN 'longer than 200 characters'; END IF;
  raw := regexp_replace(p, '\\\\', 'EE', 'g');
  IF raw ~ '\\[1-9]' OR raw ~ '\\k<' THEN RETURN 'backreferences are not supported'; END IF;
  s := regexp_replace(p, '\\.', 'E', 'g');
  s := regexp_replace(s, '\[[^]]*\]', 'C', 'g');
  s := replace(s, '(?:', '(');
  IF position('(?' in s) > 0 THEN RETURN 'lookarounds, named groups and inline flags are not supported'; END IF;
  IF s ~ '\([^()]*[*+?{|][^()]*\)[*+{]' OR s ~ '\)[^()]*\)[*+{]' THEN
    RETURN 'a repeated group may not contain a repeat, an alternation or another group';
  END IF;
  -- A repeat whose upper bound is above 10 backtracks like an unbounded one.
  u := regexp_replace(s, '\{0+,0*(1[1-9]|[2-9][0-9]|[1-9][0-9]{2,})\}', '*', 'g');
  u := regexp_replace(u, '\{0*[1-9][0-9]*,0*(1[1-9]|[2-9][0-9]|[1-9][0-9]{2,})\}', '+', 'g');
  IF u ~ '\.([*+]|\{[0-9]+,\})' THEN RETURN 'an unbounded repeat of "." is not supported'; END IF;
  -- The adjacency view: whatever can match nothing is dropped, so two
  -- repeats with only optional atoms between them are side by side.
  v := u;
  LOOP
    prev := v;
    v := regexp_replace(v, '\(\|([^()]*)\)', '(\1)?', 'g');
    v := regexp_replace(v, '\(([^()]*)\|\)', '(\1)?', 'g');
    v := regexp_replace(v, '\(([^()]*)\|\|([^()]*)\)', '(\1|\2)?', 'g');
    v := regexp_replace(v, '\([^()]*([*+]|\{[0-9]+,\})[^()]*\)(\?|\{0+(,[0-9]+)?\})', 'C*', 'g');
    v := regexp_replace(v, '\([^()]*\)(\?|\{0+(,[0-9]+)?\})', '', 'g');
    v := regexp_replace(v, '[^()|*+?{}](\?|\{0+(,[0-9]+)?\})', '', 'g');
    v := regexp_replace(v, '\(\)', '', 'g');
    v := regexp_replace(v, '\([^()]*\)([*+{])', 'C\1', 'g');
    v := regexp_replace(v, '\(([^()|]*)\)([^*+?{]|$)', '\1\2', 'g');
    EXIT WHEN v = prev;
  END LOOP;
  IF v ~ '([*+]|\{[0-9]+,\})\??[^()|*+?{}]([*+]|\{[0-9]+,\})' THEN
    RETURN 'two unbounded repeats may not sit side by side';
  END IF;
  IF (SELECT COUNT(*) FROM regexp_matches(u, '[*+]|\{[0-9]+,\}', 'g')) > 2 THEN
    RETURN 'more than 2 unbounded repeats';
  END IF;
  IF EXISTS (SELECT 1 FROM regexp_matches(s, '\{([0-9]+)(,([0-9]*))?\}', 'g') AS m(g)
              WHERE g[1]::numeric > 100 OR (COALESCE(g[3], '') <> '' AND g[3]::numeric > 100)) THEN
    RETURN 'a repeat bound above 100 is not supported';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION link_rules_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_patterns jsonb;
  v_elem     jsonb;
  v_issue    text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    -- Re-enabling a skill the engine switched off clears the engine's note.
    IF NEW.enabled AND NOT OLD.enabled THEN NEW.disabled_reason := NULL; END IF;
  END IF;
  -- A built-in belongs to nobody, whoever writes it (a restored backup too).
  IF NEW.builtin_key IS NOT NULL THEN NEW.created_by := NULL; END IF;
  -- The service role's INSERT of an org-wide custom row nobody approved (a
  -- restored pre-20261125 backup) waits for a controller, as the data step
  -- decided for the rows already here. (Nested: a person's write never
  -- reaches the helper, which clients may not execute.)
  IF TG_OP = 'INSERT' AND auth.uid() IS NULL AND NEW.builtin_key IS NULL AND NEW.visibility = 'org'
     AND NEW.shared_by IS NULL THEN
    IF NOT is_org_controller_for(NEW.org_id, NEW.created_by) THEN
      NEW.visibility := 'private'; NEW.share_requested := true;
    END IF;
  END IF;
  -- Sharing is stamped by the database: who approved, and when.
  IF NEW.visibility = 'private' THEN
    NEW.shared_by := NULL; NEW.shared_at := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.visibility IS DISTINCT FROM 'org' THEN
    NEW.share_requested := false;
    IF auth.uid() IS NOT NULL THEN NEW.shared_by := auth.uid(); NEW.shared_at := now(); END IF;
  END IF;
  -- The service role (built-in seeding, the org restore) is not a person.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- A person never changes a skill's author or built-in key (a controller
  -- could otherwise retarget a private skill onto one member).
  IF TG_OP = 'UPDATE' AND (NEW.builtin_key IS DISTINCT FROM OLD.builtin_key
       OR (NEW.builtin_key IS NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by)) THEN
    RAISE EXCEPTION 'link_rules_author: the author and built-in key of a skill are fixed' USING ERRCODE = '42501';
  END IF;
  -- A member's PRIVATE skill is theirs: anyone else (RLS admits only a
  -- controller) approves or declines its share request and changes nothing
  -- more while it is private, before or after the change.
  IF TG_OP = 'UPDATE' AND OLD.builtin_key IS NULL AND OLD.created_by IS DISTINCT FROM auth.uid()
     AND (OLD.visibility IS DISTINCT FROM 'org' OR NEW.visibility IS DISTINCT FROM 'org')
     AND (to_jsonb(NEW) - ARRAY['visibility', 'share_requested', 'shared_by', 'shared_at', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['visibility', 'share_requested', 'shared_by', 'shared_at', 'updated_at']) THEN
    RAISE EXCEPTION 'link_rules_private: a private skill belongs to its author; a controller approves or declines its share request and changes nothing else'
      USING ERRCODE = '42501';
  END IF;
  -- A new or changed config, and a skill being published, is held to the subset.
  IF TG_OP = 'INSERT' OR NEW.config IS DISTINCT FROM OLD.config
     OR (NEW.visibility = 'org' AND OLD.visibility IS DISTINCT FROM 'org') THEN
    IF jsonb_typeof(NEW.config) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'link_rules_config: config must be a JSON object' USING ERRCODE = '23514';
    END IF;
    v_patterns := NEW.config->'patterns';
    IF v_patterns IS NOT NULL THEN
      IF jsonb_typeof(v_patterns) <> 'array' THEN
        RAISE EXCEPTION 'link_rules_config: patterns must be a list' USING ERRCODE = '23514';
      END IF;
      IF jsonb_array_length(v_patterns) > 8 THEN
        RAISE EXCEPTION 'link_rules_config: at most 8 patterns per skill (this one has %)', jsonb_array_length(v_patterns)
          USING ERRCODE = '23514';
      END IF;
      FOR v_elem IN SELECT value FROM jsonb_array_elements(v_patterns) LOOP
        IF jsonb_typeof(v_elem) <> 'string' THEN
          RAISE EXCEPTION 'link_rules_config: every pattern must be text' USING ERRCODE = '23514';
        END IF;
        v_issue := skill_pattern_issue(v_elem #>> '{}');
        IF v_issue IS NOT NULL THEN
          RAISE EXCEPTION 'link_rules_pattern: % (%)', v_elem #>> '{}', v_issue
            USING ERRCODE = '23514',
                  HINT = 'Connection-skill patterns are a bounded subset so one pattern cannot hang the engine.';
        END IF;
      END LOOP;
    END IF;
    IF NEW.config ? 'minCoCitations'
       AND (jsonb_typeof(NEW.config->'minCoCitations') <> 'number'
            OR (NEW.config->>'minCoCitations')::numeric NOT BETWEEN 1 AND 50) THEN
      RAISE EXCEPTION 'link_rules_config: minCoCitations must be a number from 1 to 50' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_rules_guard ON link_rules;
CREATE TRIGGER trg_link_rules_guard
  BEFORE INSERT OR UPDATE ON link_rules
  FOR EACH ROW EXECUTE FUNCTION link_rules_guard();

-- ── 4. IEDGE-3: a pack says when it applies — enforced, not hinted ──────────
CREATE OR REPLACE FUNCTION answer_skills_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  -- A built-in belongs to nobody, whoever writes it (a restored backup too).
  IF NEW.builtin_key IS NOT NULL THEN NEW.created_by := NULL; END IF;
  -- The service role's INSERT of an org-wide custom row nobody approved (a
  -- restored pre-20261125 backup) waits for a controller, as the data step
  -- decided for the rows already here. (Nested: a person's write never
  -- reaches the helper, which clients may not execute.)
  IF TG_OP = 'INSERT' AND auth.uid() IS NULL AND NEW.builtin_key IS NULL AND NEW.visibility = 'org'
     AND NEW.shared_by IS NULL THEN
    IF NOT is_org_controller_for(NEW.org_id, NEW.created_by) THEN
      NEW.visibility := 'private'; NEW.share_requested := true;
    END IF;
  END IF;
  IF NEW.visibility = 'private' THEN
    NEW.shared_by := NULL; NEW.shared_at := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.visibility IS DISTINCT FROM 'org' THEN
    NEW.share_requested := false;
    IF auth.uid() IS NOT NULL THEN NEW.shared_by := auth.uid(); NEW.shared_at := now(); END IF;
  END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- A person never changes a skill's author or built-in key (a controller
  -- could otherwise retarget a private pack onto one member's prompts).
  IF TG_OP = 'UPDATE' AND (NEW.builtin_key IS DISTINCT FROM OLD.builtin_key
       OR (NEW.builtin_key IS NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by)) THEN
    RAISE EXCEPTION 'answer_skills_author: the author and built-in key of a skill are fixed' USING ERRCODE = '42501';
  END IF;
  -- A member's PRIVATE pack is theirs (it rides only their prompts): anyone
  -- else (RLS admits only a controller) approves or declines its share
  -- request and changes nothing more while it is private, before or after.
  IF TG_OP = 'UPDATE' AND OLD.builtin_key IS NULL AND OLD.created_by IS DISTINCT FROM auth.uid()
     AND (OLD.visibility IS DISTINCT FROM 'org' OR NEW.visibility IS DISTINCT FROM 'org')
     AND (to_jsonb(NEW) - ARRAY['visibility', 'share_requested', 'shared_by', 'shared_at', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['visibility', 'share_requested', 'shared_by', 'shared_at', 'updated_at']) THEN
    RAISE EXCEPTION 'answer_skills_private: a private skill belongs to its author; a controller approves or declines its share request and changes nothing else'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.instructions IS DISTINCT FROM OLD.instructions
     OR (NEW.visibility = 'org' AND OLD.visibility IS DISTINCT FROM 'org') THEN
    IF length(btrim(NEW.instructions)) < 40 OR length(NEW.instructions) > 4000 THEN
      RAISE EXCEPTION 'answer_skills_instructions: a reasoning skill is 40 to 4000 characters (this one is %)', length(NEW.instructions)
        USING ERRCODE = '23514';
    END IF;
    IF NEW.instructions !~* 'applies when' THEN
      RAISE EXCEPTION 'answer_skills_instructions: the pack must say when it applies (APPLIES WHEN ...)'
        USING ERRCODE = '23514',
              HINT = 'Every pack rides every question and must gate itself.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_answer_skills_guard ON answer_skills;
CREATE TRIGGER trg_answer_skills_guard
  BEFORE INSERT OR UPDATE ON answer_skills
  FOR EACH ROW EXECUTE FUNCTION answer_skills_guard();

-- ── 5. PR-3 / LNK-7 / GOV-2: every person's change to a skill is recorded ───
-- audit_logs is readable by every active member of the org
-- (audit_logs_org_access), so the words of a PRIVATE skill never go there:
-- name, description, pack text and patterns are recorded only while the
-- row is (or, for the previous values, was) org-visible; otherwise they are
-- marked withheld, with the pack's length and md5 and the pattern count.
CREATE OR REPLACE FUNCTION skills_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_new     jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old     jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_row     jsonb;
  v_org     uuid;
  v_changed text[] := ARRAY[]::text[];
  v_prev    jsonb;
  v_key     text;
  v_email   text;
  v_role    text;
  v_details jsonb;
  v_shown   boolean;
  v_was     boolean;
BEGIN
  -- The service role's writes (seeding, the org restore, the engine switching
  -- a skill off) are not a person's act; an org already gone has nowhere to record.
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  v_row := COALESCE(v_new, v_old);
  v_org := (v_row->>'org_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = v_org) THEN RETURN NULL; END IF;
  -- The row as it stands (as it stood, for a delete) is org-visible; the row
  -- before this change was.
  v_shown := COALESCE(v_row->>'visibility' = 'org', false);
  v_was := COALESCE(v_old->>'visibility' = 'org', false);
  IF TG_OP = 'UPDATE' THEN
    FOREACH v_key IN ARRAY ARRAY['name', 'description', 'instructions', 'config', 'enabled', 'visibility', 'share_requested', 'builtin_key', 'created_by'] LOOP
      IF (v_new->v_key) IS DISTINCT FROM (v_old->v_key) THEN v_changed := v_changed || v_key; END IF;
    END LOOP;
    IF array_length(v_changed, 1) IS NULL THEN RETURN NULL; END IF;
    SELECT jsonb_object_agg(k, CASE
             WHEN v_was OR k NOT IN ('name', 'description', 'instructions', 'config') THEN v_old->k
             WHEN k = 'instructions' THEN jsonb_build_object('withheld', 'private',
               'length', length(v_old->>'instructions'), 'md5', md5(v_old->>'instructions'))
             WHEN k = 'config' THEN jsonb_build_object('withheld', 'private',
               'patterns', CASE WHEN jsonb_typeof(v_old->'config'->'patterns') = 'array'
                                THEN jsonb_array_length(v_old->'config'->'patterns') END)
             ELSE jsonb_build_object('withheld', 'private')
           END) INTO v_prev FROM unnest(v_changed) AS k;
  END IF;
  SELECT email, array_to_string(COALESCE(roles, ARRAY[role]), ', ') INTO v_email, v_role FROM org_members
   WHERE org_id = v_org AND uid = auth.uid() AND status = 'active' LIMIT 1;
  v_details := jsonb_build_object(
    'kind', CASE TG_TABLE_NAME WHEN 'answer_skills' THEN 'reasoning' ELSE 'connection' END,
    'name', CASE WHEN v_shown THEN v_row->'name' WHEN v_was THEN v_old->'name' END,
    'builtin_key', v_row->'builtin_key',
    'author', v_row->'created_by', 'author_name', v_row->'created_by_name',
    'visibility', v_row->'visibility', 'enabled', v_row->'enabled',
    'share_requested', v_row->'share_requested',
    'changed', to_jsonb(v_changed), 'previous', v_prev);
  IF NOT v_shown AND NOT v_was THEN
    v_details := v_details || jsonb_build_object('text_withheld', 'private');
  END IF;
  -- The text itself whenever it is written or published: what rode the
  -- prompt — only where the org can already read it.
  IF TG_OP = 'INSERT' OR 'instructions' = ANY(v_changed) OR 'config' = ANY(v_changed)
     OR ('visibility' = ANY(v_changed) AND v_shown) THEN
    IF v_shown THEN
      v_details := v_details || jsonb_build_object('instructions', v_row->'instructions', 'patterns', v_row->'config'->'patterns');
    ELSE
      v_details := v_details || jsonb_build_object(
        'instructions_length', length(v_row->>'instructions'), 'instructions_md5', md5(v_row->>'instructions'),
        'pattern_count', CASE WHEN jsonb_typeof(v_row->'config'->'patterns') = 'array'
                              THEN jsonb_array_length(v_row->'config'->'patterns') END);
    END IF;
  END IF;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
  VALUES (CASE TG_OP WHEN 'INSERT' THEN 'SKILL_CREATED' WHEN 'DELETE' THEN 'SKILL_DELETED' ELSE 'SKILL_UPDATED' END,
          CASE TG_TABLE_NAME WHEN 'answer_skills' THEN 'answer_skill' ELSE 'link_rule' END,
          v_row->>'id', v_org, auth.uid(), v_email, v_role, jsonb_strip_nulls(v_details));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_answer_skills_audit ON answer_skills;
CREATE TRIGGER trg_answer_skills_audit
  AFTER INSERT OR UPDATE OR DELETE ON answer_skills
  FOR EACH ROW EXECUTE FUNCTION skills_audit();
DROP TRIGGER IF EXISTS trg_link_rules_audit ON link_rules;
CREATE TRIGGER trg_link_rules_audit
  AFTER INSERT OR UPDATE OR DELETE ON link_rules
  FOR EACH ROW EXECUTE FUNCTION skills_audit();

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'answer_skills and link_rules each carry exactly four policies (select / insert / update / delete)' AS check,
       (SELECT COUNT(*) = 8 FROM pg_policies
         WHERE tablename IN ('answer_skills', 'link_rules')
           AND policyname IN (tablename || '_select', tablename || '_insert', tablename || '_update', tablename || '_delete'))
       AND (SELECT COUNT(*) = 8 FROM pg_policies WHERE tablename IN ('answer_skills', 'link_rules')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'INSERT: a custom skill by its author, org-wide only by a controller; a built-in only by a controller, owned by nobody',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename IN ('answer_skills', 'link_rules') AND policyname = tablename || '_insert'
           AND with_check LIKE '%is_org_controller(org_id)%'
           AND with_check LIKE '%''private''%'
           AND with_check LIKE '%builtin_key IS NULL%'
           AND with_check LIKE '%created_by IS NULL%'),
       NULL
UNION ALL
SELECT 'UPDATE: controllers manage (built-ins stay unowned); an author keeps their own custom row private',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename IN ('answer_skills', 'link_rules') AND policyname = tablename || '_update'
           AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%builtin_key IS NULL%'
           AND with_check LIKE '%''private''%' AND with_check LIKE '%created_by IS NULL%'),
       NULL
UNION ALL
SELECT 'DELETE: never a built-in; an org-wide custom row by a controller; any custom row by its author',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename IN ('answer_skills', 'link_rules') AND policyname = tablename || '_delete'
           AND qual LIKE '%builtin_key IS NULL%' AND qual LIKE '%is_org_controller(org_id)%'
           AND qual LIKE '%''org''%' AND qual LIKE '%created_by = auth.uid()%'),
       NULL
UNION ALL
SELECT 'SELECT: org rows and your own; controllers read every skill of the org (the share requests are theirs)',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename IN ('answer_skills', 'link_rules') AND policyname = tablename || '_select'
           AND qual LIKE '%''org''%' AND qual LIKE '%created_by = auth.uid()%'
           AND qual LIKE '%is_org_controller(org_id)%'),
       NULL
UNION ALL
SELECT 'new custom rows default to private on both tables',
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('answer_skills', 'link_rules')
           AND column_name = 'visibility' AND column_default LIKE '%private%'),
       NULL
UNION ALL
SELECT 'share_requested / shared_by / shared_at on both tables, disabled_reason on link_rules',
       (SELECT COUNT(*) = 7 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND ((table_name IN ('answer_skills', 'link_rules') AND column_name IN ('share_requested', 'shared_by', 'shared_at'))
                OR (table_name = 'link_rules' AND column_name = 'disabled_reason'))),
       NULL
UNION ALL
SELECT 'guard + audit triggers installed on both tables',
       (SELECT COUNT(*) = 4 FROM pg_trigger
         WHERE NOT tgisinternal
           AND ((tgrelid = 'answer_skills'::regclass AND tgname IN ('trg_answer_skills_guard', 'trg_answer_skills_audit'))
                OR (tgrelid = 'link_rules'::regclass AND tgname IN ('trg_link_rules_guard', 'trg_link_rules_audit')))),
       NULL
UNION ALL
SELECT 'search_path pinned on skill_pattern_issue, link_rules_guard, answer_skills_guard, skills_audit, is_org_controller_for (the last two definer)',
       (SELECT COUNT(*) = 5 FROM pg_proc
         WHERE proname IN ('skill_pattern_issue', 'link_rules_guard', 'answer_skills_guard', 'skills_audit', 'is_org_controller_for')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%')
       AND (SELECT prosecdef FROM pg_proc WHERE proname = 'skills_audit')
       AND (SELECT prosecdef FROM pg_proc WHERE proname = 'is_org_controller_for'),
       NULL
UNION ALL
SELECT 'DEC-35: is_org_controller_for is is_org_controller for another user (same predicate; the inventory spells the same text), and clients cannot call it',
       (SELECT prosrc LIKE '%(role IN (''Admin'', ''DocCtrl'') OR roles && ARRAY[''Admin'', ''DocCtrl'']::text[])%'
               AND prosrc LIKE '%uid = auth.uid()%'
          FROM pg_proc WHERE proname = 'is_org_controller')
       AND (SELECT prosrc LIKE '%(role IN (''Admin'', ''DocCtrl'') OR roles && ARRAY[''Admin'', ''DocCtrl'']::text[])%'
                   AND prosrc LIKE '%uid = p_uid%'
              FROM pg_proc WHERE proname = 'is_org_controller_for')
       AND NOT has_function_privilege('authenticated', 'public.is_org_controller_for(uuid, uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.is_org_controller_for(uuid, uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'LNK-6: the bounded subset refuses nested repeats, lookarounds, backreferences, unbounded dots, side-by-side or 3+ unbounded repeats and huge bounds; accepts identifier patterns',
       skill_pattern_issue('(a+)+b') IS NOT NULL
       AND skill_pattern_issue('(\w+\s?)+$') IS NOT NULL
       AND skill_pattern_issue('(?=x)y') IS NOT NULL
       AND skill_pattern_issue('(a)\1') IS NOT NULL
       AND skill_pattern_issue('WO.*x') IS NOT NULL
       AND skill_pattern_issue('\d{1,5000}') IS NOT NULL
       AND skill_pattern_issue('\w+\s+\w+') IS NOT NULL
       AND skill_pattern_issue('\b[A-Z]+-\d+-\d+\b') IS NOT NULL
       AND skill_pattern_issue('\d+-?\d+X') IS NOT NULL
       AND skill_pattern_issue('\w+\s?\w+') IS NOT NULL
       AND skill_pattern_issue('\d{0,100}\d{0,100}\d{0,100}\d{0,100}X') IS NOT NULL
       AND skill_pattern_issue('[A-Z0-9]{1,100}[A-Z0-9]{1,100}[A-Z0-9]{1,100}#') IS NOT NULL
       AND skill_pattern_issue('\d+(\d+)?X') IS NOT NULL
       AND skill_pattern_issue('\d+(-|)\d+X') IS NOT NULL
       AND skill_pattern_issue('\bWO-\d{5}\b') IS NULL
       AND skill_pattern_issue('\b(?:WO|PTW)-\d{4,6}\b') IS NULL
       AND skill_pattern_issue('\b[A-Z]{2,4}-\d+\b') IS NULL
       AND skill_pattern_issue('\b[A-Z]+-\d+\b') IS NULL
       AND skill_pattern_issue('(\d{3}-)?\d{4}') IS NULL,
       NULL
UNION ALL
SELECT 'link_rules_guard validates config for a person (8 patterns, the subset), clears a built-in''s author on every write, holds a restored unapproved org-wide row for a controller',
       (SELECT prosrc LIKE '%skill_pattern_issue(v_elem #>> ''{}'')%'
               AND prosrc LIKE '%jsonb_array_length(v_patterns) > 8%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
               AND prosrc LIKE '%IF NEW.builtin_key IS NOT NULL THEN NEW.created_by := NULL; END IF;%'
               AND prosrc LIKE '%IF NOT is_org_controller_for(NEW.org_id, NEW.created_by) THEN%'
               AND position('IF NEW.builtin_key IS NOT NULL THEN NEW.created_by := NULL;' in prosrc)
                   < position('IF auth.uid() IS NULL THEN RETURN NEW;' in prosrc)
          FROM pg_proc WHERE proname = 'link_rules_guard'),
       NULL
UNION ALL
SELECT 'answer_skills_guard requires APPLIES WHEN and 40-4000 characters on a new, changed or published pack; built-in author cleared; restored unapproved org-wide row held',
       (SELECT prosrc LIKE '%NEW.instructions !~* ''applies when''%'
               AND prosrc LIKE '%length(NEW.instructions) > 4000%'
               AND prosrc LIKE '%IF NEW.builtin_key IS NOT NULL THEN NEW.created_by := NULL; END IF;%'
               AND prosrc LIKE '%IF NOT is_org_controller_for(NEW.org_id, NEW.created_by) THEN%'
               AND position('IF NEW.builtin_key IS NOT NULL THEN NEW.created_by := NULL;' in prosrc)
                   < position('IF auth.uid() IS NULL THEN RETURN NEW;' in prosrc)
          FROM pg_proc WHERE proname = 'answer_skills_guard'),
       NULL
UNION ALL
SELECT 'both guards: a member''s private skill is approved or declined by a controller and changed no further; nobody changes a skill''s author or built-in key; publishing a connection skill re-checks its patterns',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('link_rules_guard', 'answer_skills_guard')
           AND prosrc LIKE '%OLD.created_by IS DISTINCT FROM auth.uid()%'
           AND prosrc LIKE '%- ARRAY[''visibility'', ''share_requested'', ''shared_by'', ''shared_at'', ''updated_at'']%'
           AND prosrc LIKE '%NEW.created_by IS DISTINCT FROM OLD.created_by%'
           AND prosrc LIKE '%USING ERRCODE = ''42501''%')
       AND (SELECT prosrc LIKE '%IF TG_OP = ''INSERT'' OR NEW.config IS DISTINCT FROM OLD.config%'
                   AND prosrc LIKE '%OR (NEW.visibility = ''org'' AND OLD.visibility IS DISTINCT FROM ''org'') THEN%'
              FROM pg_proc WHERE proname = 'link_rules_guard'),
       NULL
UNION ALL
SELECT 'skills_audit records person-initiated SKILL_CREATED / SKILL_UPDATED / SKILL_DELETED; the text only while the row is org-visible, a private skill''s words withheld',
       (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NULL; END IF;%'
               AND prosrc LIKE '%''SKILL_CREATED''%' AND prosrc LIKE '%''SKILL_DELETED''%' AND prosrc LIKE '%''SKILL_UPDATED''%'
               AND prosrc LIKE '%v_shown := COALESCE(v_row->>''visibility'' = ''org'', false);%'
               AND prosrc LIKE '%IF v_shown THEN%v_details := v_details || jsonb_build_object(''instructions'', v_row->''instructions''%'
               AND prosrc LIKE '%''instructions_md5'', md5(v_row->>''instructions'')%'
               AND prosrc LIKE '%WHEN v_was OR k NOT IN (''name'', ''description'', ''instructions'', ''config'') THEN v_old->k%'
               AND prosrc LIKE '%''name'', CASE WHEN v_shown THEN v_row->''name'' WHEN v_was THEN v_old->''name'' END%'
          FROM pg_proc WHERE proname = 'skills_audit'),
       NULL
UNION ALL
SELECT 'no built-in skill is owned by a member',
       NOT EXISTS (SELECT 1 FROM answer_skills WHERE builtin_key IS NOT NULL AND created_by IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM link_rules WHERE builtin_key IS NOT NULL AND created_by IS NOT NULL),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g25_before
UNION ALL
SELECT 'inventory (after): reasoning-skill share requests waiting for a controller', NULL,
       (SELECT COUNT(*) FROM answer_skills WHERE share_requested)::text
UNION ALL
SELECT 'inventory (after): connection-skill share requests waiting for a controller', NULL,
       (SELECT COUNT(*) FROM link_rules WHERE share_requested)::text
UNION ALL
SELECT 'inventory (after): custom connection skills holding a pattern the bounded subset refuses (that pattern no longer runs; the skill card names it)', NULL,
       (SELECT COUNT(DISTINCT r.id)
          FROM link_rules r,
               jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.config->'patterns') = 'array'
                                              THEN r.config->'patterns' ELSE '[]'::jsonb END) AS p(pattern)
         WHERE r.builtin_key IS NULL AND skill_pattern_issue(p.pattern) IS NOT NULL)::text
UNION ALL
SELECT 'inventory (after): org-wide, switched-on custom connection skills whose every pattern the subset refuses (they no longer find anything)', NULL,
       (SELECT COUNT(*)
          FROM link_rules r
         WHERE r.builtin_key IS NULL AND r.visibility = 'org' AND r.enabled
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.config->'patterns') = 'array'
                                                                    THEN r.config->'patterns' ELSE '[]'::jsonb END))
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.config->'patterns') = 'array'
                                                                        THEN r.config->'patterns' ELSE '[]'::jsonb END) AS p(pattern)
                            WHERE skill_pattern_issue(p.pattern) IS NULL))::text;
