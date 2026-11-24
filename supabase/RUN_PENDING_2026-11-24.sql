-- Pending database steps, checked against the live database on Nov 24, 2026 (read-only).
-- Run once, top to bottom, in the Supabase SQL editor. Each part is its own migration file.
-- Already applied (not here): 20261121_equipment_reader_added, 20261123_controlled_links.
-- Your workspace's subscription_status is 'active', so the subscription rule (last) leaves it working.

-- ════════ 20261119_project_materials.sql ════════
-- Materials register: every material and off-site repair an event needs,
-- each with its specification, an owner, a status, a need-by date and any
-- open question. Opened at scope freeze and checked at every gate.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS project_materials (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The phase it is for (projects.shift_times.phases), when the project has phases.
  phase_id         TEXT,
  -- material | offsite (a repair or calibration sent out)
  kind             TEXT NOT NULL DEFAULT 'material',
  item             TEXT NOT NULL,
  spec             TEXT,
  -- What the specification still lacks ("length"); empty when complete.
  spec_missing     TEXT,
  qty              TEXT,
  -- The work order or equipment it is for, and its step when picked.
  work_order       TEXT,
  milestone_id     UUID,
  owner            TEXT,
  vendor           TEXT,
  -- to_specify | ready | ordered | at_vendor | received | checked | short | cancelled
  status           TEXT NOT NULL DEFAULT 'to_specify',
  need_by          DATE,
  eta              DATE,
  eta_note         TEXT,
  -- A question holding it up, who asked and when; and its answer.
  question         TEXT,
  question_at      TIMESTAMPTZ,
  question_by      TEXT,
  answer           TEXT,
  answered_at      TIMESTAMPTZ,
  note             TEXT,
  created_by       UUID,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_name  TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_materials_kind_check CHECK (kind IN ('material', 'offsite')),
  CONSTRAINT project_materials_status_check CHECK (status IN ('to_specify', 'ready', 'ordered', 'at_vendor', 'received', 'checked', 'short', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS project_materials_project_idx ON project_materials(project_id);

ALTER TABLE project_materials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_materials_read ON project_materials;
CREATE POLICY project_materials_read ON project_materials FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_materials.org_id AND uid = auth.uid() AND status = 'active'));
DROP POLICY IF EXISTS project_materials_insert ON project_materials;
CREATE POLICY project_materials_insert ON project_materials FOR INSERT TO authenticated
  WITH CHECK (can_edit_project(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_materials.project_id AND p.org_id = project_materials.org_id));
DROP POLICY IF EXISTS project_materials_update ON project_materials;
CREATE POLICY project_materials_update ON project_materials FOR UPDATE TO authenticated
  USING (can_edit_project(project_id))
  WITH CHECK (can_edit_project(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_materials.project_id AND p.org_id = project_materials.org_id));
DROP POLICY IF EXISTS project_materials_delete ON project_materials;
CREATE POLICY project_materials_delete ON project_materials FOR DELETE TO authenticated
  USING (can_edit_project(project_id));

COMMENT ON TABLE project_materials IS 'Materials register: each material and off-site repair for an event, with its specification, owner, status, need-by date and open question.';

NOTIFY pgrst, 'reload schema';

-- ════════ 20261125_materials_two_owners.sql ════════
-- Materials register: two owners and "Used on the job" (docs/next-update.md,
-- section 7).
--
--   - owner (kept as it is) is now the warehouse owner: gets it in and
--     checks it.
--   - crew_owner is new: the turnaround crew person who makes sure it is
--     used on the job. A line with either owner missing is flagged.
--   - status 'used' ("Used on the job") comes after 'checked' ("Received,
--     checked"), marked by the crew owner, so done means done.
--
-- Run after 20261119_project_materials.sql. Safe to run more than once.
-- Row level security is unchanged. Until this runs, the app saves a line
-- without the crew owner and "used" and says so.

ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS crew_owner TEXT;

ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_materials_status_check;
ALTER TABLE project_materials ADD CONSTRAINT project_materials_status_check
  CHECK (status IN ('to_specify', 'ready', 'ordered', 'at_vendor', 'received', 'checked', 'used', 'short', 'cancelled'));

COMMENT ON COLUMN project_materials.owner IS 'Warehouse owner: gets it in and checks it.';
COMMENT ON COLUMN project_materials.crew_owner IS 'Crew owner: makes sure it is used on the job, and marks it used.';

NOTIFY pgrst, 'reload schema';

-- ════════ 20261126_materials_verify_by.sql ════════
-- Materials register: a verify-by date on each line, the date it is to be in
-- hand and checked ("Received, checked"). The warehouse owner gets a reminder
-- in the app as it nears (app/api/cron/maintenance, lib/materialReminders).
-- Without this column the app works to the need-by date less 14 days and
-- says so when a typed verify-by date can't be kept.

ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS verify_by DATE;
COMMENT ON COLUMN project_materials.verify_by IS 'By when the line is to be in hand and checked; the warehouse owner is reminded as it nears.';

NOTIFY pgrst, 'reload schema';

-- ════════ 20261124_subscription_enforced.sql ════════
-- 20261124_subscription_enforced.sql
--
-- No subscription, no changes. A workspace whose trial has ended, or whose
-- subscription was canceled, went unpaid or was paused, can still READ its
-- own data (so it can always see and export it) but can no longer insert,
-- update or delete anything from the app.
--
-- How: one RESTRICTIVE policy per change (insert, update, delete) on every
-- table in public that has a uuid org_id column and row-level security on.
-- Restrictive policies are ANDed with the existing ones, so nothing that is
-- refused today becomes allowed; changes are just also refused when the
-- workspace has no access. The server's own key (service role) is not
-- affected: Stripe updates, sign-up and exports keep working.
--
-- Left out: org_members, so people can still be taken off a lapsed
-- workspace.
--
-- Same rule as the app (lib/subscription.ts hasAccess):
--   active, past_due           access
--   trialing (or no status)    access until trial_ends_at; no end date = access
--   canceled, unpaid, paused   no access
--
-- Safe to run again. A table added later gets the rule when this is re-run.
--
-- BEFORE RUNNING: a workspace that should keep working without paying
-- (your own) needs subscription_status = 'active' first, for example:
--   update public.orgs set subscription_status = 'active'
--   where id = '215b762d-7be4-4cbd-bdb1-4b2703d81296';

create or replace function public.org_has_access(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when coalesce(o.subscription_status, 'trialing') in ('active', 'past_due') then true
      when coalesce(o.subscription_status, 'trialing') = 'trialing'
        then o.trial_ends_at is null or o.trial_ends_at > now()
      else false
    end
    from public.orgs o
    where o.id = p_org
  ), true);
$$;

revoke all on function public.org_has_access(uuid) from public;
grant execute on function public.org_has_access(uuid) to authenticated, anon;

do $$
declare
  t record;
begin
  for t in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and a.atttypid = 'uuid'::regtype
      and c.relname not in ('org_members')
  loop
    execute format('drop policy if exists subscription_insert on public.%I', t.tbl);
    execute format('drop policy if exists subscription_update on public.%I', t.tbl);
    execute format('drop policy if exists subscription_delete on public.%I', t.tbl);
    execute format(
      'create policy subscription_insert on public.%I as restrictive for insert to authenticated, anon with check (public.org_has_access(org_id))',
      t.tbl);
    execute format(
      'create policy subscription_update on public.%I as restrictive for update to authenticated, anon using (public.org_has_access(org_id)) with check (public.org_has_access(org_id))',
      t.tbl);
    execute format(
      'create policy subscription_delete on public.%I as restrictive for delete to authenticated, anon using (public.org_has_access(org_id))',
      t.tbl);
  end loop;
end $$;

-- To see which tables got the rule:
--   select tablename, policyname from pg_policies
--   where policyname like 'subscription_%' order by tablename;

