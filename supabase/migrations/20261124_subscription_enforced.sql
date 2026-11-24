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
