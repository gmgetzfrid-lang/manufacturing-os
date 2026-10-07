-- ─────────────────────────────────────────────────────────────────────────────
-- 20261173_intel_roundG_ai_cap_change.sql
--
-- intelligence Round G — I-18 AI CAP TRANSACTION (GOV-15, closing GOV-10's
-- concurrent remainder): a change to a monthly AI cap is ONE database
-- transaction.
--
--   GOV-15  /api/ai/usage decided the self-raise ban (nobody raises their own
--           cap while another active member holds ai.manage_caps; DEC-73 item
--           5) in the app, over several PostgREST round trips with no lock
--           between them. Fix passes 5–10 of GOV-10 added re-reads, guarded
--           writes and put-backs; each closed the interleaving its review
--           reproduced and the next review found another. This file adds the
--           one function that replaces that machinery:
--
--           ai_cap_change(p_org_id, p_actor, p_target, p_cap_usd, p_clear,
--                         p_other_holders) RETURNS jsonb — NEW (no earlier
--           migration defines it; a shape test scans the sequence for one).
--             1. takes the workspace's cap-change lock
--                (pg_advisory_xact_lock — every cap change of one workspace
--                runs one after the other, whichever rows exist yet) and
--                locks the default row and the override rows it reads
--                (SELECT … FOR UPDATE);
--             2. decides against those locked figures exactly what the app
--                decided for requests made one after another (GOV-10's
--                sequential matrix T1–T10): the self-raise ban; the SOLE
--                holder (p_other_holders false — the app reads the roster
--                through the capability policy and passes the answer; NULL =
--                the roster could not be read, refused only where the
--                decision needs it); the hold a raise of the default writes
--                for a setter who follows it (at their figure, before the
--                default moves); `unchanged` for a request that changes
--                nothing; `pinnedAtDefault` for a person given the default's
--                figure as their own. One rule is loosened, as the record
--                asks: a holder's self-clear that is NOT a raise (the default
--                is at or below their override) is allowed — it was refused
--                only because, without a lock, racing it against a default
--                raise once deleted the hold that raise had just written;
--             3. writes, and appends AI_CAP_CHANGED in the same transaction:
--                a sole holder's own raise is recorded FIRST and a record the
--                log refuses changes nothing (the record is the only control
--                on an unsigned raise); every other change's row is written
--                after it in a guarded block, so a log that refuses it never
--                undoes the change (as before this file) — the row comes back
--                in `audit_retry` and the app tries it once more;
--             4. answers {outcome: changed | unchanged | refused, reason,
--                previous_cap_usd, cap_usd, sole_holder, pinned_at_default,
--                held_self_at_usd, audit_retry}. The app maps it onto the
--                same answers and bell notices as before.
--
--           DRLS-16: SECURITY DEFINER with search_path pinned; EXECUTE revoked
--           from PUBLIC, anon AND authenticated and granted to service_role
--           only — the route's server calls it, naming the actor it
--           authenticated (p_actor). A NULL auth.uid() is therefore the only
--           caller it serves (the service role carries no user), and a
--           signed-in session that somehow reached it is refused outright.
--
-- NOT a widening: the service role could already write ai_usage_limits and
-- audit_logs directly (the route did); no client role gains anything. The
-- pre-apply inventory (aggregate counts only) is captured BEFORE the
-- transaction as DEC-30 asks and returned with the probes.
--
-- PASTE / DEPLOY ORDER: after 20260916 (ai_usage_limits) — it reads nothing
-- else of the app's but audit_logs. Independent of 20261137 (it never asks
-- the capability evaluator: the app does, and passes the answer). Paste it
-- BEFORE the app deploy that ships it, or in the same window. The app works
-- before and after it: until this file is pasted, /api/ai/usage gets
-- PGRST202 / 42883 and makes the change app-side — the same sequential
-- answers, notices and audit rows, without the lock (the server log says so
-- once; a holder's own self-clear stays refused there while another holder
-- exists). That path has none of the earlier app's in-flight guards, so
-- until the paste it is weaker against two cap changes in flight than the
-- app it replaces. Paste it, then the next cap change runs through the
-- function.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (CREATE OR
-- REPLACE; the grants are restated).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS intel_round_g_173_before;
CREATE TEMP TABLE intel_round_g_173_before AS
SELECT 'BEFORE: workspace-default AI caps stored (one row per workspace at most)' AS inventory, COUNT(*)::text AS n
  FROM ai_usage_limits
 WHERE user_id IS NULL
UNION ALL
SELECT 'BEFORE: per-person AI cap overrides stored', COUNT(*)::text
  FROM ai_usage_limits
 WHERE user_id IS NOT NULL
UNION ALL
SELECT 'BEFORE: stored caps the app reads as the $10 default because the figure is not usable (negative or not a number; expect 0)', COUNT(*)::text
  FROM ai_usage_limits
 WHERE NOT (monthly_cap_usd >= 0 AND monthly_cap_usd < 'Infinity'::numeric)
UNION ALL
SELECT 'BEFORE: per-person overrides whose person is not an active member of that workspace (kept as they are; the route refuses a change for a non-member)', COUNT(*)::text
  FROM ai_usage_limits l
 WHERE l.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = l.org_id AND m.uid = l.user_id AND m.status = 'active')
UNION ALL
SELECT 'BEFORE: AI_CAP_CHANGED rows the app-side race guards wrote (compensated, unverified, holdKept, holdChanged, overrideChanged; none from this file on unless the app runs app-side)', COUNT(*)::text
  FROM audit_logs
 WHERE action = 'AI_CAP_CHANGED'
   AND (details ? 'compensated' OR details ? 'unverified' OR details ? 'holdKept'
        OR details ? 'holdChanged' OR details ? 'overrideChanged')
UNION ALL
SELECT 'BEFORE: ai_cap_change already defined (0 on the first paste, 1 on a re-paste)', COUNT(*)::text
  FROM pg_proc
 WHERE proname = 'ai_cap_change';

BEGIN;

-- ── GOV-15: one cap change, one transaction ─────────────────────────────────
CREATE OR REPLACE FUNCTION ai_cap_change(
  p_org_id UUID,
  p_actor UUID,
  p_target UUID,
  p_cap_usd NUMERIC,
  p_clear BOOLEAN,
  p_other_holders BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default      ai_usage_limits%ROWTYPE;
  v_target       ai_usage_limits%ROWTYPE;
  v_has_default  BOOLEAN;
  v_has_target   BOOLEAN := false;
  v_has_actor    BOOLEAN := false;
  v_default_cap  NUMERIC;
  v_previous     NUMERIC;
  v_self         BOOLEAN := p_target IS NOT NULL AND p_target = p_actor;
  v_sole         BOOLEAN := false;
  v_pin          NUMERIC := NULL;
  v_pinned       BOOLEAN := false;
  v_details      JSONB;
  v_held         JSONB;
  v_retry        JSONB := '[]'::jsonb;
BEGIN
  -- DRLS-16: the route's server calls this as the service role, naming the
  -- actor it authenticated. No signed-in session may: EXECUTE is granted to
  -- service_role alone, and a session that reached it anyway is refused.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'ai_cap_change is called by the server, never by a signed-in session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_org_id IS NULL OR p_actor IS NULL OR p_clear IS NULL THEN
    RAISE EXCEPTION 'ai_cap_change needs a workspace, an actor and whether the change clears an override'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_clear AND p_target IS NULL THEN
    RAISE EXCEPTION 'only a person''s override can be cleared' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT p_clear AND (p_cap_usd IS NULL OR NOT (p_cap_usd >= 0 AND p_cap_usd <= 10000)) THEN
    RAISE EXCEPTION 'a monthly AI cap is a figure from 0 to 10000 (0 locks AI)' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One cap change at a time per workspace: the lock is held to the end of
  -- the transaction, so a second change waits and then decides from what
  -- this one committed — rows that do not exist yet included.
  PERFORM pg_advisory_xact_lock(hashtext('ai_cap_change'), hashtext(p_org_id::text));
  -- And the rows the decision reads, against any writer that does not take
  -- the lock.
  SELECT * INTO v_default FROM ai_usage_limits
   WHERE org_id = p_org_id AND user_id IS NULL FOR UPDATE;
  v_has_default := FOUND;
  IF p_target IS NOT NULL THEN
    SELECT * INTO v_target FROM ai_usage_limits
     WHERE org_id = p_org_id AND user_id = p_target FOR UPDATE;
    v_has_target := FOUND;
  ELSE
    PERFORM 1 FROM ai_usage_limits
     WHERE org_id = p_org_id AND user_id = p_actor FOR UPDATE;
    v_has_actor := FOUND;
  END IF;

  -- The figures as the app reads them (getCapUsd): an override, else the
  -- default, else $10; a stored figure that is not a usable number reads as
  -- $10; 0 is the lock.
  v_default_cap := CASE WHEN v_has_default AND v_default.monthly_cap_usd >= 0
                             AND v_default.monthly_cap_usd < 'Infinity'::numeric
                        THEN v_default.monthly_cap_usd ELSE 10 END;
  v_previous := CASE
    WHEN p_target IS NULL THEN v_default_cap
    WHEN v_has_target THEN CASE WHEN v_target.monthly_cap_usd >= 0 AND v_target.monthly_cap_usd < 'Infinity'::numeric
                                THEN v_target.monthly_cap_usd ELSE 10 END
    ELSE v_default_cap END;

  -- ── Clearing a person's override: they follow the default again ─────────
  IF p_clear THEN
    IF v_self THEN
      IF p_other_holders IS NULL THEN
        RETURN jsonb_build_object('outcome', 'refused', 'reason', 'roster_unreadable');
      END IF;
      IF p_other_holders THEN
        IF NOT v_has_target THEN
          RETURN jsonb_build_object('outcome', 'unchanged', 'cleared', false);
        END IF;
        -- A self-clear onto a HIGHER default is a raise: another holder's.
        -- One that is not a raise is allowed (GOV-15) — the default was
        -- read under this transaction's lock.
        IF v_default_cap > v_previous THEN
          RETURN jsonb_build_object('outcome', 'refused', 'reason', 'self_clear');
        END IF;
      END IF;
    END IF;
    IF NOT v_has_target THEN
      RETURN jsonb_build_object('outcome', 'unchanged', 'cleared', false);
    END IF;
    -- Only a sole holder reaches a self-raise here.
    v_sole := v_self AND v_default_cap > v_previous;
    v_details := jsonb_build_object('targetUserId', p_target, 'cleared', true, 'previousCapUsd', trim_scale(v_previous))
      || CASE WHEN v_sole THEN jsonb_build_object('soleHolder', true) ELSE '{}'::jsonb END;
    IF v_sole THEN
      -- The only control on an unsigned raise: recorded first, or not made.
      BEGIN
        INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details, timestamp)
        VALUES ('AI_CAP_CHANGED', 'ai_usage_limit', p_org_id::text, p_org_id, p_actor, v_details, clock_timestamp());
      EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('outcome', 'refused', 'reason', 'sole_audit_failed', 'error', SQLERRM);
      END;
    END IF;
    DELETE FROM ai_usage_limits WHERE id = v_target.id;
    IF NOT v_sole THEN
      BEGIN
        INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details, timestamp)
        VALUES ('AI_CAP_CHANGED', 'ai_usage_limit', p_org_id::text, p_org_id, p_actor, v_details, clock_timestamp());
      EXCEPTION WHEN OTHERS THEN
        v_retry := v_retry || jsonb_build_array(v_details);
      END;
    END IF;
    RETURN jsonb_build_object('outcome', 'changed', 'cleared', true,
      'previous_cap_usd', trim_scale(v_previous), 'cap_usd', NULL,
      'sole_holder', v_sole, 'pinned_at_default', false, 'held_self_at_usd', NULL,
      'audit_retry', v_retry);
  END IF;

  -- ── Setting a figure ────────────────────────────────────────────────────
  -- Nobody raises their OWN cap while another holder exists.
  IF v_self AND p_cap_usd > v_previous THEN
    IF p_other_holders IS NULL THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'roster_unreadable');
    END IF;
    IF p_other_holders THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'self_raise');
    END IF;
    v_sole := true;
  END IF;
  -- The default already at this figure: nothing changes for anyone.
  IF p_target IS NULL AND p_cap_usd = v_previous THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'cleared', false, 'cap_usd', trim_scale(p_cap_usd));
  END IF;
  -- Raising the default must not raise the setter's own cap: a setter who
  -- follows it (no override of their own) is held at their figure — which
  -- is the default's — by an override written before the default moves. A
  -- sole holder is not held: they follow the default like everyone else.
  IF p_target IS NULL AND p_cap_usd > v_previous AND NOT v_has_actor THEN
    IF p_other_holders IS NULL THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'roster_unreadable');
    END IF;
    IF p_other_holders THEN v_pin := v_previous; ELSE v_sole := true; END IF;
  END IF;
  -- A person's override already at this figure: nothing changes. (A person
  -- who follows the default given its figure as their own IS a change.)
  IF p_target IS NOT NULL AND v_has_target AND v_target.monthly_cap_usd = p_cap_usd AND v_previous = p_cap_usd THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'cleared', false, 'cap_usd', trim_scale(p_cap_usd));
  END IF;
  v_pinned := p_target IS NOT NULL AND NOT v_has_target AND p_cap_usd = v_previous;
  v_details := jsonb_build_object('capUsd', trim_scale(p_cap_usd), 'previousCapUsd', trim_scale(v_previous))
    || CASE WHEN p_target IS NOT NULL THEN jsonb_build_object('targetUserId', p_target) ELSE '{}'::jsonb END
    || CASE WHEN v_sole THEN jsonb_build_object('soleHolder', true) ELSE '{}'::jsonb END
    || CASE WHEN v_pinned THEN jsonb_build_object('pinnedAtDefault', true) ELSE '{}'::jsonb END;
  IF v_sole THEN
    BEGIN
      INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details, timestamp)
      VALUES ('AI_CAP_CHANGED', 'ai_usage_limit', p_org_id::text, p_org_id, p_actor, v_details, clock_timestamp());
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'sole_audit_failed', 'error', SQLERRM);
    END;
  END IF;
  IF v_pin IS NOT NULL THEN
    INSERT INTO ai_usage_limits (org_id, user_id, monthly_cap_usd, updated_by, updated_at)
    VALUES (p_org_id, p_actor, v_pin, p_actor, now());
  END IF;
  IF p_target IS NULL THEN
    IF v_has_default THEN
      UPDATE ai_usage_limits SET monthly_cap_usd = p_cap_usd, updated_by = p_actor, updated_at = now()
       WHERE id = v_default.id;
    ELSE
      INSERT INTO ai_usage_limits (org_id, user_id, monthly_cap_usd, updated_by, updated_at)
      VALUES (p_org_id, NULL, p_cap_usd, p_actor, now());
    END IF;
  ELSIF v_has_target THEN
    UPDATE ai_usage_limits SET monthly_cap_usd = p_cap_usd, updated_by = p_actor, updated_at = now()
     WHERE id = v_target.id;
  ELSE
    INSERT INTO ai_usage_limits (org_id, user_id, monthly_cap_usd, updated_by, updated_at)
    VALUES (p_org_id, p_target, p_cap_usd, p_actor, now());
  END IF;
  -- The change's row, then the hold's — the order the log has always read
  -- in. A log that refuses one never undoes the change (only the sole
  -- holder's own raise above is refused unrecorded).
  IF NOT v_sole THEN
    BEGIN
      INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details, timestamp)
      VALUES ('AI_CAP_CHANGED', 'ai_usage_limit', p_org_id::text, p_org_id, p_actor, v_details, clock_timestamp());
    EXCEPTION WHEN OTHERS THEN
      v_retry := v_retry || jsonb_build_array(v_details);
    END;
  END IF;
  IF v_pin IS NOT NULL THEN
    v_held := jsonb_build_object('targetUserId', p_actor, 'capUsd', trim_scale(v_pin),
      'previousCapUsd', trim_scale(v_previous), 'heldOnDefaultRaise', true);
    BEGIN
      INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details, timestamp)
      VALUES ('AI_CAP_CHANGED', 'ai_usage_limit', p_org_id::text, p_org_id, p_actor, v_held, clock_timestamp());
    EXCEPTION WHEN OTHERS THEN
      v_retry := v_retry || jsonb_build_array(v_held);
    END;
  END IF;
  RETURN jsonb_build_object('outcome', 'changed', 'cleared', false,
    'cap_usd', trim_scale(p_cap_usd), 'previous_cap_usd', trim_scale(v_previous),
    'sole_holder', v_sole, 'pinned_at_default', v_pinned, 'held_self_at_usd', trim_scale(v_pin),
    'audit_retry', v_retry);
END;
$$;

COMMENT ON FUNCTION ai_cap_change(UUID, UUID, UUID, NUMERIC, BOOLEAN, BOOLEAN) IS
  'GOV-15 (20261173): one monthly AI cap change in one transaction — the workspace cap-change lock and FOR UPDATE on the rows read, the self-raise ban decided against them, the write and its AI_CAP_CHANGED row. Called by /api/ai/usage as the service role only.';

-- DRLS-16: executable by the server alone.
REVOKE ALL ON FUNCTION ai_cap_change(UUID, UUID, UUID, NUMERIC, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ai_cap_change(UUID, UUID, UUID, NUMERIC, BOOLEAN, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION ai_cap_change(UUID, UUID, UUID, NUMERIC, BOOLEAN, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION ai_cap_change(UUID, UUID, UUID, NUMERIC, BOOLEAN, BOOLEAN) TO service_role;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 7 ─────────
SELECT 'GOV-15: ai_cap_change exists once (six arguments), returns jsonb, SECURITY DEFINER with search_path pinned' AS check,
       (SELECT COUNT(*) = 1 AND bool_and(p.prosecdef) AND bool_and(p.prorettype = 'jsonb'::regtype)
               AND bool_and(array_to_string(p.proconfig, ',') LIKE '%search_path=public%') AND bool_and(p.pronargs = 6)
          FROM pg_proc p WHERE p.proname = 'ai_cap_change') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'GOV-15: it takes the workspace cap-change lock and locks the rows it decides from (pg_advisory_xact_lock, FOR UPDATE)',
       (SELECT prosrc LIKE '%PERFORM pg_advisory_xact_lock(hashtext(''ai_cap_change''), hashtext(p_org_id::text));%'
              AND prosrc LIKE '%WHERE org_id = p_org_id AND user_id IS NULL FOR UPDATE;%'
              AND prosrc LIKE '%WHERE org_id = p_org_id AND user_id = p_target FOR UPDATE;%'
              AND prosrc LIKE '%WHERE org_id = p_org_id AND user_id = p_actor FOR UPDATE;%'
          FROM pg_proc WHERE proname = 'ai_cap_change'),
       NULL::text
UNION ALL
SELECT 'GOV-15: it decides the ban, the sole holder and the hold, and writes AI_CAP_CHANGED in the same transaction',
       (SELECT prosrc LIKE '%''reason'', ''self_raise''%' AND prosrc LIKE '%''reason'', ''self_clear''%'
              AND prosrc LIKE '%''reason'', ''sole_audit_failed''%' AND prosrc LIKE '%''heldOnDefaultRaise'', true%'
              AND prosrc LIKE '%INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details, timestamp)%'
          FROM pg_proc WHERE proname = 'ai_cap_change'),
       NULL::text
UNION ALL
SELECT 'DRLS-16: it refuses a signed-in session (auth.uid() set); only the service role it is granted to calls it',
       (SELECT prosrc LIKE '%IF auth.uid() IS NOT NULL THEN%' FROM pg_proc WHERE proname = 'ai_cap_change'),
       NULL::text
UNION ALL
SELECT 'DRLS-16: PUBLIC, anon and authenticated cannot execute ai_cap_change',
       NOT has_function_privilege('anon', 'ai_cap_change(uuid, uuid, uuid, numeric, boolean, boolean)', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'ai_cap_change(uuid, uuid, uuid, numeric, boolean, boolean)', 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                          WHERE p.proname = 'ai_cap_change' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'DRLS-16: service_role can execute ai_cap_change',
       has_function_privilege('service_role', 'ai_cap_change(uuid, uuid, uuid, numeric, boolean, boolean)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'ai_usage_limits keeps its two unique indexes (one default per workspace, one override per person)',
       (SELECT COUNT(*) = 2 FROM pg_indexes
         WHERE tablename = 'ai_usage_limits'
           AND indexname IN ('ai_usage_limits_org_default_idx', 'ai_usage_limits_user_idx')),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM intel_round_g_173_before;
