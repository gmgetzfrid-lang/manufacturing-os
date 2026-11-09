-- Equipment: the ID governs. An ID (5510.19) is one piece of equipment
-- across the plant; a name (V-7) is not unique anywhere (the Crude Unit's
-- V-7 is 2010.19, the Transmix Unit's is 5510.19: two vessels). Only admins
-- change the equipment list. Everyone in the org still reads it, and
-- project members still link work orders to it. Safe to run more than once.

begin;

-- 1. No limit on names: two pieces of equipment can share a name (only
--    their IDs have to differ).
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'assets' and con.contype = 'u'
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(con.conkey) k
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k) = array['org_id', 'tag_normalized']
  loop
    execute format('alter table public.assets drop constraint %I', c.conname);
  end loop;
  -- A plain unique index on the same two columns, if one was made that way.
  for c in
    select i.relname as conname
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'assets' and x.indisunique and not x.indisprimary
      and not exists (select 1 from pg_constraint con where con.conindid = x.indexrelid)
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(x.indkey::int2[]) k
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k) = array['org_id', 'tag_normalized']
  loop
    execute format('drop index public.%I', c.conname);
  end loop;
end $$;
drop index if exists public.assets_unit_name_unique;

-- 2. An ID (5510.19, 5516-TV-110) is one piece of equipment, plant-wide
--    (5510.19 and 5510.019 count as the same ID).
create unique index if not exists assets_code_unique
  on public.assets (org_id, regexp_replace(upper(btrim(code)), '\.0+([0-9])', '.\1'))
  where code is not null and btrim(code) <> '';

-- 3. Kern's IDs don't follow the tag (the Transmix schedule has V-7 as
--    5510.19 and E-12 as 5530.25): IDs are never worked out from the name
--    again; they come from the schedule's Equipment column or are typed in.
--    (Admin › Codebook › Numbering shows it as "it's the tag's number": off.)
insert into public.codebook_config (org_id, iterable_rule)
values ('215b762d-7be4-4cbd-bdb1-4b2703d81296', '{"mirrorsTag": false, "padTo": 0}'::jsonb)
on conflict (org_id) do update
  set iterable_rule = jsonb_set(coalesce(public.codebook_config.iterable_rule, '{}'::jsonb), '{mirrorsTag}', 'false'::jsonb);

-- 4. Only admins add, change or remove equipment. Everyone in the org reads it.
create or replace function public.can_edit_equipment(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members
    where uid = auth.uid() and org_id = p_org and status = 'active'
      and (role = 'Admin' or roles && array['Admin']::text[])
  );
$$;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'assets' loop
    execute format('drop policy %I on public.assets', p.policyname);
  end loop;
end $$;
alter table public.assets enable row level security;
create policy assets_member_read on public.assets for select to authenticated
  using (exists (select 1 from org_members m where m.org_id = assets.org_id and m.uid = auth.uid() and m.status = 'active'));
create policy assets_admin_insert on public.assets for insert to authenticated
  with check (public.can_edit_equipment(org_id));
create policy assets_admin_update on public.assets for update to authenticated
  using (public.can_edit_equipment(org_id)) with check (public.can_edit_equipment(org_id));
create policy assets_admin_delete on public.assets for delete to authenticated
  using (public.can_edit_equipment(org_id));

commit;

notify pgrst, 'reload schema';

-- Check: expect 0 rows.
-- select org_id, regexp_replace(upper(btrim(code)), '\.0+([0-9])', '.\1'), count(*) from assets where code is not null and btrim(code) <> '' group by 1,2 having count(*) > 1;
