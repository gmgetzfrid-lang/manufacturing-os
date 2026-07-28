-- 20260831_capability_policy_and_rails.sql
--
-- PERMISSIONS OVERHAUL, DB SIDE — three rails:
--
--   1. The org's capability policy (org_configurations key
--      'capability_policy' — who may perform which workflow/app action,
--      enforced by the workflow-action route) may only be WRITTEN by
--      Admin/DocCtrl. Readable by every member (clients draw buttons from
--      it); the generic org_configurations policies left non-branding,
--      non-drafting keys writable by anyone.
--
--   2. LAST-ADMIN PROTECTION: the final active Admin of an org can never be
--      demoted, suspended, or deleted — the rail that keeps an org
--      recoverable no matter what an admin misclicks.
--
--   3. FORCE-RELEASE GUARD: releasing ANOTHER USER's active checkout now
--      requires Admin/DocCtrl at the database, matching the UI gate that was
--      previously the only enforcement. Your own checkout, and the
--      service-role cron sweep (auth.uid() IS NULL), are unaffected.
--
-- Additive + idempotent. Apply in the Supabase SQL editor.

-- ─── 1. capability_policy write guard ────────────────────────────────────

DROP POLICY IF EXISTS org_config_cap_policy_insert ON org_configurations;
CREATE POLICY org_config_cap_policy_insert ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (key <> 'capability_policy' OR is_org_controller(org_id));

DROP POLICY IF EXISTS org_config_cap_policy_update ON org_configurations;
CREATE POLICY org_config_cap_policy_update ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (key <> 'capability_policy' OR is_org_controller(org_id))
  WITH CHECK (key <> 'capability_policy' OR is_org_controller(org_id));

DROP POLICY IF EXISTS org_config_cap_policy_delete ON org_configurations;
CREATE POLICY org_config_cap_policy_delete ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (key <> 'capability_policy' OR is_org_controller(org_id));

-- ─── 2. Last-admin protection ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION prevent_last_admin_removal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_remaining INT;
BEGIN
  -- Service-role / SQL-console operations (restore, support) are exempt.
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- Only care when an ACTIVE Admin row stops being an active Admin.
  IF OLD.role = 'Admin' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'Admin' OR NEW.status <> 'active') THEN
    SELECT COUNT(*) INTO v_remaining
    FROM org_members
    WHERE org_id = OLD.org_id AND role = 'Admin' AND status = 'active'
      AND uid <> OLD.uid;
    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'This is the organization''s last active Admin — assign another Admin before demoting or removing this one.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_last_admin_update ON org_members;
CREATE TRIGGER trg_prevent_last_admin_update
  BEFORE UPDATE ON org_members
  FOR EACH ROW EXECUTE FUNCTION prevent_last_admin_removal();

DROP TRIGGER IF EXISTS trg_prevent_last_admin_delete ON org_members;
CREATE TRIGGER trg_prevent_last_admin_delete
  BEFORE DELETE ON org_members
  FOR EACH ROW EXECUTE FUNCTION prevent_last_admin_removal();

-- ─── 3. Force-release guard on checkouts ─────────────────────────────────

CREATE OR REPLACE FUNCTION enforce_checkout_release_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Cron sweep / service role: exempt.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  -- Releasing (or otherwise closing) SOMEONE ELSE'S active session requires
  -- a controller. Your own sessions stay fully yours.
  IF OLD.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status
     AND OLD.user_id::text <> auth.uid()::text
     AND NOT is_org_controller(OLD.org_id) THEN
    RAISE EXCEPTION 'Only Admin/Document Control can release another user''s checkout.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkout_release_guard ON checkout_sessions;
CREATE TRIGGER trg_checkout_release_guard
  BEFORE UPDATE ON checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_checkout_release_guard();
