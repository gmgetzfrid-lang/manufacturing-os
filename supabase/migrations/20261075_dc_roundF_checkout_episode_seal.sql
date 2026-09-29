-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F — DCK-14: a closed checkout episode is a SEALED
-- record, and an episode cannot be sealed over live sessions.
--
-- lib/checkoutEpisodes.ts describes a closed episode as "a sealed history
-- record (participants, who/why, chat log, revisions published in its
-- window)". The table's policy (20260729 checkout_episodes_org_update) says
-- otherwise: FOR UPDATE USING (active member), no WITH CHECK, no column
-- restriction — any active member may rewrite closed_at / closed_by /
-- close_reason / seq on a CLOSED episode, or flip status back to 'active'.
-- And nothing at the database stops an episode being closed while a member
-- session tied to it is still active (the app's close CAS guards only
-- against double-closing, not against a racer who joined after the closer's
-- own session fetch).
--
-- This migration installs ONE BEFORE UPDATE trigger guard on
-- checkout_episodes (the same shape as the 20261029 DCK-2 / DCK-3 guards —
-- a guard, not a policy change, so the app's legitimate cross-user close
-- keeps working: a collaborator, a force-release or the sweep may still
-- close an episode someone else opened):
--
--   1. OLD.status = 'closed'  → refused for every signed-in writer. The
--      service role (auth.uid() IS NULL — the cron, admin routes) passes,
--      matching the trusted-backend seam every checkout guard uses.
--   2. active → closed while a checkout_sessions row with episode_id =
--      OLD.id is still status = 'active' → refused. The app's closeEpisode
--      re-reads live sessions before the write and treats this refusal
--      (matched by its text, "still has active sessions") as "reconcile
--      instead of seal" (DCK-14 done-when 3).
--
-- Not a widening: nothing is granted. The inventory below (captured BEFORE
-- the DDL, aggregate counts only) records the split-brain residue the rail
-- now prevents — closed episodes that still carry an active member session.
-- Those rows are NOT rewritten here; reconcileDocumentCheckoutState settles
-- them the next time each document is touched.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run. ONE result set:
-- the final SELECT carries the probes (ok) and the inventory (n).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Inventory BEFORE apply (aggregate, never customer rows) ─────────────────
DROP TABLE IF EXISTS _dc_roundf_episode_seal_inventory;
CREATE TEMP TABLE _dc_roundf_episode_seal_inventory AS
SELECT 'inventory: closed episodes that still carry an active member session (residue the rail now prevents)'::text AS check,
       COUNT(*)::text AS n
  FROM checkout_episodes e
 WHERE e.status = 'closed'
   AND EXISTS (SELECT 1 FROM checkout_sessions s WHERE s.episode_id = e.id AND s.status = 'active')
UNION ALL
SELECT 'inventory: active episodes with NO active member session (stray opens; reconcile closes them)', COUNT(*)::text
  FROM checkout_episodes e
 WHERE e.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM checkout_sessions s WHERE s.episode_id = e.id AND s.status = 'active')
UNION ALL
SELECT 'inventory: closed episodes (all orgs)', COUNT(*)::text FROM checkout_episodes WHERE status = 'closed'
UNION ALL
SELECT 'inventory: active episodes (all orgs)', COUNT(*)::text FROM checkout_episodes WHERE status = 'active';

BEGIN;

-- ── DCK-14: the episode seal guard ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_checkout_episode_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service role / cron (no JWT): trusted backend, same seam as the other
  -- checkout guards (20260901, 20261029).
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- 1. A closed episode is a sealed record: no rewrite, no reopen.
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'A closed checkout episode is a sealed record and cannot be changed.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. An episode is sealed only when nobody is left on it. A member session
  --    that joined after the closer fetched its list is still active here.
  IF NEW.status = 'closed' AND OLD.status = 'active'
     AND EXISTS (SELECT 1 FROM checkout_sessions s
                  WHERE s.episode_id = OLD.id AND s.status = 'active') THEN
    RAISE EXCEPTION 'This checkout episode still has active sessions and cannot be sealed.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkout_episode_guard ON checkout_episodes;
CREATE TRIGGER trg_checkout_episode_guard
  BEFORE UPDATE ON checkout_episodes
  FOR EACH ROW EXECUTE FUNCTION enforce_checkout_episode_guard();

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes carry ok (expect true × 5, n NULL); inventory rows carry n (ok NULL).
SELECT 'guard installed: BEFORE UPDATE ON checkout_episodes, FOR EACH ROW'::text AS check,
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_checkout_episode_guard'
                  AND t.tgrelid = 'checkout_episodes'::regclass AND NOT t.tgisinternal
                  AND pg_get_triggerdef(t.oid) LIKE 'CREATE TRIGGER trg_checkout_episode_guard BEFORE UPDATE ON public.checkout_episodes FOR EACH ROW%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'closed episodes are immutable to signed-in writers',
       (SELECT prosrc LIKE '%IF OLD.status = ''closed'' THEN%'
           AND prosrc LIKE '%sealed record and cannot be changed%'
          FROM pg_proc WHERE proname = 'enforce_checkout_episode_guard'),
       NULL
UNION ALL
SELECT 'an episode cannot be sealed over an active member session',
       (SELECT prosrc LIKE '%s.episode_id = OLD.id AND s.status = ''active''%'
           AND prosrc LIKE '%still has active sessions and cannot be sealed%'
          FROM pg_proc WHERE proname = 'enforce_checkout_episode_guard'),
       NULL
UNION ALL
SELECT 'service role passes (auth.uid() IS NULL → RETURN NEW)',
       (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
          FROM pg_proc WHERE proname = 'enforce_checkout_episode_guard'),
       NULL
UNION ALL
SELECT 'search_path pinned on the guard',
       (SELECT array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'enforce_checkout_episode_guard'),
       NULL
UNION ALL
SELECT check, NULL::boolean, n FROM _dc_roundf_episode_seal_inventory;
