-- Accounts are made on purpose, and one email is one person.
--
-- 1. Profiles (public.users) are made only by the server: an admin adding
--    someone, or a paid new workspace's first admin. Until now the access
--    rule users_own (FOR ALL) let any signed-in account make its own
--    profile, and change any field on it, including the email that the
--    admin "add person" used to match people by. Now a person can change
--    only their own name, picture, home workspace and dashboard layout.
-- 2. Emails are kept trimmed and lower case, and no two profiles, and no
--    two members of one workspace, can share one.
-- 3. One workspace per payment (the payment webhook and the finish page
--    can both try to make it; the second finds the first).
--
-- Fails, changing nothing, if two profiles or two members of a workspace
-- already share an email (case aside): fix those first. Safe to run more
-- than once.

begin;

-- 1. Profiles: read as before; change only these fields of your own; never make or delete one.
drop policy if exists users_own on public.users;
drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

revoke insert, update, delete on public.users from anon, authenticated;
do $$
declare c text;
begin
  foreach c in array array['display_name', 'avatar_path', 'default_org_id', 'dashboard_config', 'updated_at'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = c) then
      execute format('grant update (%I) on public.users to authenticated', c);
    end if;
  end loop;
end $$;
grant all on public.users to service_role;

-- 2. One email, one person.
update public.users set email = lower(btrim(email)) where email is not null and email <> lower(btrim(email));
update public.org_members set email = lower(btrim(email)) where email is not null and email <> lower(btrim(email));
create unique index if not exists users_email_unique_ci on public.users (lower(email)) where email is not null;
create unique index if not exists org_members_org_email_unique_ci on public.org_members (org_id, lower(email)) where email is not null;

-- 3. One workspace per payment.
create unique index if not exists orgs_stripe_customer_unique on public.orgs (stripe_customer_id) where stripe_customer_id is not null;

commit;

notify pgrst, 'reload schema';
