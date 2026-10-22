-- ─────────────────────────────────────────────────────────────────────────────
-- 20261264_df_roundG_consent_escalation.sql
--
-- drafting-flow Round G — DF-P22 CONSENT AND ESCALATION FOLLOW-UPS (DEC-90
-- rulings (1) and (2) for DF-P22: industry best practice, fail-safe, no
-- regression). Four additions, nothing renamed, no function re-created, no
-- existing policy re-created:
--
--   (1) ticket_sla_escalations (new) — FRIC-1 done-when 2 / GAP-106: the
--       escalation tier above the queue owners. One row per breach per
--       period that told a workspace's configured escalation contact
--       (lib/ticketSla.ts runSlaEscalationScan, step 5b of the maintenance
--       cron — no new cron entry). The unique (ticket, breach, period) key
--       is the claim: two runs never send the same escalation twice. Written
--       only by the service role; read as the ticket reads. An UPDATE is
--       refused for every role (a sent escalation is never rewritten); a
--       DELETE is the service role's claim release when a notice reached
--       nobody (no client holds a DELETE grant or policy). Escalation only
--       tells: it writes nothing on the ticket.
--   (2) ticket_preauthorizations (new) — GAP-109 mechanism 2: a named
--       person's standing, revocable, scoped pre-consent to their own
--       sign-off. Scope from what a request already records (its library,
--       its request type, its work class — at least one; never the
--       engineered lane), a REQUIRED expiry no more than 365 days after it
--       was recorded, and the e-signature it rests on (minted by
--       /api/signatures/sign for this record's id, as the like-in-kind
--       declaration's is). Written only by the service role
--       (/api/tickets/preauthorizations, after its checks); read by its own
--       grantor or a workspace Admin. A record, never deleted while its workspace
--       exists; the only change ever accepted is its revocation, once
--       (ticket_preauthorizations_guard). Used only on a routing slot a
--       workspace explicitly opted in (lib/routingControl.ts
--       accepts_preauthorization), never on an engineering slot, an
--       assurance slot or an engineered request (app-enforced,
--       lib/ticketPreauthorization.ts).
--   (3) ticket_review_slots (20261242, CHECK last re-created by 20261255): a
--       slot may be satisfied 'preauthorization' — by a standing
--       pre-authorization, which names its signer (the person who recorded
--       it) and its signature (the pre-authorization's own), so the shape
--       CHECK (20261255) already requires both and is NOT re-created. The
--       satisfied_via CHECK widens by exactly that one value, re-created
--       from its newest body (20261255) — pinned by a lineDiff test.
--   (4) org_configurations key 'sla_escalation' (DF-P22 fix pass): the
--       escalation tier's setting lives in its own key, written ONLY by
--       /api/admin/sla-escalation as the service role after an Admin check
--       (with an audit row for every change). Three NEW RESTRICTIVE policies
--       refuse every client INSERT / UPDATE / DELETE of that one key, so the
--       queue owners the tier sits above (the DraftingSupervisor holders who
--       may write the 'drafting' key, 20261209) can never switch it off or
--       point it at themselves. They are AND-ed with 20261209's per-key
--       policies, which are not touched; every other key is unchanged.
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261255 (the first statement refuses
-- otherwise, changing nothing). Either order with the DF-P22 deploy is safe;
-- RECOMMENDED: deploy the app FIRST, then paste.
--   * App deployed, not pasted: no escalation is sent (the step says it
--     starts at this paste) and every breach is handled exactly as today; no
--     pre-authorization can be recorded (the route answers 503, said) or
--     used (a 42P01 / PGRST205 on the table reads as "none" — every slot
--     waits for its sign-off as today).
--   * Pasted, app not yet deployed: the old app never reads either table or
--     writes the new value; nothing changes.
--   * No workspace has an escalation contact or an opted-in slot at the
--     paste: the inventory below counts both (expected 0).
--
-- A WIDENING only in that the ledger accepts one more satisfied_via value
-- (service role only) and two tables become readable (the escalation record
-- as its ticket reads; a pre-authorization by its grantor or an Admin); no client
-- gains a write (and clients lose the write of the one new key, which no
-- workspace holds yet). The counts-only inventory is captured first (DEC-30).
-- Re-runnable: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, DROP … IF
-- EXISTS, the CHECK dropped and re-added.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.ticket_review_slots') IS NULL
     OR to_regclass('public.ticket_notice_events') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_via_check'
                     AND pg_get_constraintdef(oid) LIKE '%consent%') THEN
    RAISE EXCEPTION '20261264 needs 20261255 (the consent window) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'sla_breached_at') THEN
    RAISE EXCEPTION '20261264 needs tickets.sla_breached_at (20261166 / 20261195); nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_264_before;
CREATE TEMP TABLE df_round_g_264_before AS
SELECT 1 AS ord, 'inventory (before apply): workspaces with an escalation setting (org_configurations key sla_escalation — expected 0; none means today''s SLA clock exactly)' AS inventory,
       COUNT(*)::text AS n
  FROM org_configurations
 WHERE key = 'sla_escalation'
UNION ALL
SELECT 2, 'inventory (before apply): open requests whose SLA breach is on record (sla_breached_at set) — a workspace that later names a contact has these told to it once per period while they stay overdue',
       COUNT(*)::text
  FROM tickets
 WHERE status NOT IN ('CLOSED', 'CANCELED') AND archived_at IS NULL AND sla_breached_at IS NOT NULL
UNION ALL
SELECT 3, 'inventory (before apply): routing tables (libraries + folders + documents) with a slot opted in to standing pre-authorization (accepts_preauthorization — expected 0)',
       ((SELECT COUNT(*) FROM libraries WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.accepts_preauthorization == true)'))
      + (SELECT COUNT(*) FROM collections WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.accepts_preauthorization == true)'))
      + (SELECT COUNT(*) FROM documents WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.accepts_preauthorization == true)')))::text
UNION ALL
SELECT 4, 'inventory (before apply): satisfied slots in the roster ledger (ticket_review_slots) — none is changed by this paste',
       COUNT(*)::text FROM ticket_review_slots WHERE status = 'satisfied';

BEGIN;

-- ── 1. the escalation tier's record and claim ───────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_sla_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  breached_at TIMESTAMPTZ NOT NULL,
  period_index INTEGER NOT NULL CHECK (period_index >= 1),
  period_days INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 30),
  contact JSONB NOT NULL,
  recipients UUID[] NOT NULL DEFAULT '{}',
  status_at TEXT,
  audit_id UUID,
  escalated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticket_id, breached_at, period_index)
);
CREATE INDEX IF NOT EXISTS ticket_sla_escalations_ticket_idx ON ticket_sla_escalations (ticket_id, escalated_at);

CREATE OR REPLACE FUNCTION ticket_sla_escalations_no_update()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'ticket_sla_escalations is a record: a sent escalation is never rewritten.'
    USING ERRCODE = 'check_violation';
END;
$$;
REVOKE ALL ON FUNCTION ticket_sla_escalations_no_update() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_sla_escalations_no_update ON ticket_sla_escalations;
CREATE TRIGGER trg_ticket_sla_escalations_no_update
BEFORE UPDATE ON ticket_sla_escalations
FOR EACH ROW EXECUTE FUNCTION ticket_sla_escalations_no_update();

ALTER TABLE ticket_sla_escalations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_sla_escalations_read ON ticket_sla_escalations;
CREATE POLICY ticket_sla_escalations_read ON ticket_sla_escalations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_sla_escalations.ticket_id AND t.org_id = ticket_sla_escalations.org_id));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_sla_escalations FROM anon, authenticated;
REVOKE ALL ON ticket_sla_escalations FROM anon;

-- ── 2. standing pre-authorizations (a record; revoked, never deleted) ───────
CREATE TABLE IF NOT EXISTS ticket_preauthorizations (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  grantor_id UUID NOT NULL,
  grantor_name TEXT,
  -- Scope: what a request already records. No foreign key on purpose: a
  -- library that is removed leaves its pre-authorizations scoped to it (they
  -- then match nothing) — a SET NULL would WIDEN a person's pre-consent.
  library_id UUID,
  request_type TEXT,
  work_class TEXT,
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  signature_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  revoke_reason TEXT,
  CONSTRAINT ticket_preauthorizations_scoped CHECK (library_id IS NOT NULL OR request_type IS NOT NULL OR work_class IS NOT NULL),
  CONSTRAINT ticket_preauthorizations_expiry CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '365 days'),
  CONSTRAINT ticket_preauthorizations_revoker CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX IF NOT EXISTS ticket_preauthorizations_grantor_idx ON ticket_preauthorizations (org_id, grantor_id, expires_at);

CREATE OR REPLACE FUNCTION ticket_preauthorizations_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Removed only with its workspace (the orgs cascade runs after the org
    -- row is gone).
    IF EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
      RAISE EXCEPTION 'ticket_preauthorizations is a record: a standing pre-authorization is revoked, never deleted.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'this standing pre-authorization is already revoked; a revoked record is never changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NULL
     OR (NEW.id, NEW.org_id, NEW.grantor_id, NEW.grantor_name, NEW.library_id, NEW.request_type, NEW.work_class,
         NEW.statement, NEW.signature_id, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.org_id, OLD.grantor_id, OLD.grantor_name, OLD.library_id, OLD.request_type, OLD.work_class,
         OLD.statement, OLD.signature_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a standing pre-authorization is only ever revoked: its scope, expiry, statement and signature never change.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ticket_preauthorizations_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_preauthorizations_guard ON ticket_preauthorizations;
CREATE TRIGGER trg_ticket_preauthorizations_guard
BEFORE UPDATE OR DELETE ON ticket_preauthorizations
FOR EACH ROW EXECUTE FUNCTION ticket_preauthorizations_guard();

ALTER TABLE ticket_preauthorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_preauthorizations_read ON ticket_preauthorizations;
-- Read by its own grantor, or a workspace Admin — the route's rule
-- (/api/tickets/preauthorizations GET narrows a non-Admin to their own). Not
-- every member: a statement names its library, which a member outside that
-- library's ACL (a Contractor-only member) may not read.
CREATE POLICY ticket_preauthorizations_read ON ticket_preauthorizations
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT my_org_ids()) AND (grantor_id = auth.uid() OR is_org_admin(org_id)));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_preauthorizations FROM anon, authenticated;
REVOKE ALL ON ticket_preauthorizations FROM anon;

-- ── 3. the roster ledger: a slot satisfied by a standing pre-authorization ──
-- Re-created from its newest body (20261255 §5), one value added.
ALTER TABLE ticket_review_slots DROP CONSTRAINT IF EXISTS ticket_review_slots_satisfied_via_check;
ALTER TABLE ticket_review_slots ADD CONSTRAINT ticket_review_slots_satisfied_via_check
  CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent', 'preauthorization'));

-- ── 4. the escalation setting: no client writes it (Admin-only, server-side) ─
-- New RESTRICTIVE policies, AND-ed with the per-key ones (20261209, not
-- re-created): a client's INSERT / UPDATE / DELETE of the key is refused for
-- every role; the service role (the route, after its Admin check and audit
-- row) is not subject to row security.
DROP POLICY IF EXISTS org_config_sla_escalation_no_client_ins ON org_configurations;
CREATE POLICY org_config_sla_escalation_no_client_ins ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (key <> 'sla_escalation');
DROP POLICY IF EXISTS org_config_sla_escalation_no_client_upd ON org_configurations;
CREATE POLICY org_config_sla_escalation_no_client_upd ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (key <> 'sla_escalation')
  WITH CHECK (key <> 'sla_escalation');
DROP POLICY IF EXISTS org_config_sla_escalation_no_client_del ON org_configurations;
CREATE POLICY org_config_sla_escalation_no_client_del ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (key <> 'sla_escalation');

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 8 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'FRIC-1 / GAP-106: ticket_sla_escalations exists, row security on, one claim per breach per period (UNIQUE), never rewritten (BEFORE UPDATE trigger, enabled)' AS check,
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname = 'ticket_sla_escalations')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ticket_sla_escalations'::regclass AND contype = 'u')
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_sla_escalations_no_update' AND NOT tgisinternal AND tgenabled = 'O') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'ticket_sla_escalations: read follows the ticket; one SELECT policy; no write policy; no client write grant',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_sla_escalations' AND cmd = 'SELECT'
         AND qual LIKE '%FROM tickets t%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_sla_escalations' AND cmd <> 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_sla_escalations', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_sla_escalations', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ticket_sla_escalations', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.ticket_sla_escalations', 'SELECT'),
       NULL
UNION ALL
SELECT 1, 3, 'GAP-109 mechanism 2: ticket_preauthorizations exists, row security on, scoped (CHECK), expiry required and at most 365 days (CHECK), a revoker with every revocation (CHECK)',
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname = 'ticket_preauthorizations')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_preauthorizations_scoped')
       AND (SELECT pg_get_constraintdef(oid) LIKE '%365 days%' FROM pg_constraint WHERE conname = 'ticket_preauthorizations_expiry')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_preauthorizations_revoker')
       AND (SELECT is_nullable = 'NO' FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'ticket_preauthorizations' AND column_name = 'expires_at'),
       NULL
UNION ALL
SELECT 1, 4, 'ticket_preauthorizations: only ever revoked, once; never deleted while its workspace exists (BEFORE UPDATE OR DELETE trigger, enabled; SECURITY INVOKER, search_path pinned)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_preauthorizations_guard' AND NOT tgisinternal AND tgenabled = 'O')
       AND (SELECT NOT prosecdef AND proconfig @> ARRAY['search_path=public']
              AND prosrc LIKE '%already revoked%' AND prosrc LIKE '%never deleted%'
              FROM pg_proc WHERE proname = 'ticket_preauthorizations_guard'),
       NULL
UNION ALL
SELECT 1, 5, 'ticket_preauthorizations: read by its own grantor or a workspace Admin; one SELECT policy; no write policy; no client write grant',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_preauthorizations' AND cmd = 'SELECT'
         AND qual LIKE '%my_org_ids()%' AND qual LIKE '%grantor_id = auth.uid()%' AND qual LIKE '%is_org_admin(org_id)%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_preauthorizations' AND cmd <> 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_preauthorizations', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_preauthorizations', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ticket_preauthorizations', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.ticket_preauthorizations', 'SELECT'),
       NULL
UNION ALL
SELECT 1, 6, 'the roster ledger takes a slot satisfied by a standing pre-authorization, and every satisfied slot but a consent window''s still names its signer and its signature',
       (SELECT pg_get_constraintdef(oid) LIKE '%preauthorization%' AND pg_get_constraintdef(oid) LIKE '%consent%'
          FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_via_check')
       AND (SELECT pg_get_constraintdef(oid) LIKE '%signature_id IS NOT NULL%' AND pg_get_constraintdef(oid) LIKE '%consent_window%'
              FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_shape'),
       NULL
UNION ALL
SELECT 1, 7, 'the escalation and the pre-authorization notices are of a declared kind (notification_kinds() lists ticket_status — or the registry is absent and the rail with it)',
       COALESCE((SELECT bool_or(prosrc LIKE '%(''ticket_status'',%') FROM pg_proc WHERE proname = 'notification_kinds'), true),
       NULL
UNION ALL
SELECT 1, 8, 'DF-P22 fix pass: no client writes the escalation setting (org_configurations key sla_escalation) — three RESTRICTIVE policies refuse INSERT, UPDATE and DELETE of it; the per-key policies of 20261209 are untouched',
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'org_configurations' AND permissive = 'RESTRICTIVE'
           AND policyname IN ('org_config_sla_escalation_no_client_ins', 'org_config_sla_escalation_no_client_upd', 'org_config_sla_escalation_no_client_del')
           AND COALESCE(qual, with_check) LIKE '%<> ''sla_escalation''%')
       AND (SELECT with_check LIKE '%<> ''sla_escalation''%' FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'org_configurations' AND policyname = 'org_config_sla_escalation_no_client_upd')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_configurations'
                     AND policyname = 'org_config_key_writes_upd' AND qual LIKE '%''drafting''%'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_264_before
UNION ALL
SELECT 3, 1, 'after: escalations on record (0 right after the paste)', NULL,
       (SELECT COUNT(*) FROM ticket_sla_escalations)::text
UNION ALL
SELECT 3, 2, 'after: standing pre-authorizations on record (0 right after the paste)', NULL,
       (SELECT COUNT(*) FROM ticket_preauthorizations)::text
) AS final_rows
ORDER BY sec, ord;
