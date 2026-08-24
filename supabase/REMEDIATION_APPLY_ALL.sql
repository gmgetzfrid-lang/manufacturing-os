-- ============================================================================
-- SECURITY REMEDIATION — consolidated DB apply script
-- ============================================================================
-- This is the idempotent UNION of every remediation migration to date. It is
-- safe to run, and safe to RE-RUN (every statement is CREATE OR REPLACE /
-- DROP ... IF EXISTS / CREATE ... IF NOT EXISTS). Run it once in the Supabase
-- SQL editor and the entire database side of the remediation is applied,
-- regardless of which pieces were already applied individually.
--
-- Covers: H1 (push_subscriptions table), the orphan-table RLS (asset_files,
-- document_review_events), C3 (ACL overlays on versions/sets/projects) + H5
-- (audit org-scoping), and C2 steps 1-2 (controller-gated deletes).
-- Nothing here touches existing rows; it only adds tables/functions/policies.
-- ============================================================================

-- ── H1: push_subscriptions table (reminders cron + push subscribe/unsubscribe)
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  org_id uuid,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_reminded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);
alter table push_subscriptions enable row level security;
drop policy if exists push_sub_select_own on push_subscriptions;
create policy push_sub_select_own on push_subscriptions for select using (auth.uid() = user_id);
drop policy if exists push_sub_insert_own on push_subscriptions;
create policy push_sub_insert_own on push_subscriptions for insert with check (auth.uid() = user_id);
drop policy if exists push_sub_delete_own on push_subscriptions;
create policy push_sub_delete_own on push_subscriptions for delete using (auth.uid() = user_id);

-- ── Orphan-table RLS: asset_files
alter table asset_files enable row level security;
drop policy if exists "asset_files_member_all" on asset_files;
create policy "asset_files_member_all" on asset_files
  for all to authenticated
  using (exists (select 1 from org_members where org_id = asset_files.org_id and uid = auth.uid() and status = 'active'))
  with check (exists (select 1 from org_members where org_id = asset_files.org_id and uid = auth.uid() and status = 'active'));

-- ── Orphan-table RLS: document_review_events
alter table document_review_events enable row level security;
drop policy if exists "document_review_events_member_all" on document_review_events;
create policy "document_review_events_member_all" on document_review_events
  for all to authenticated
  using (exists (select 1 from org_members where org_id = document_review_events.org_id and uid = auth.uid() and status = 'active'))
  with check (exists (select 1 from org_members where org_id = document_review_events.org_id and uid = auth.uid() and status = 'active'));

-- ── C3: ACL overlay on document_versions / document_sets / projects
create or replace function doc_is_visible(p_doc uuid)
returns boolean language sql stable security definer as $$
  select coalesce(
    (select node_visible(d.visibility, d.acl_index, d.org_id) from documents d where d.id = p_doc),
    false);
$$;

drop policy if exists document_versions_acl_select on document_versions;
create policy document_versions_acl_select on document_versions
  as restrictive for select using (doc_is_visible(record_id));

drop policy if exists document_sets_acl_select on document_sets;
create policy document_sets_acl_select on document_sets
  as restrictive for select using (node_visible(visibility, acl_index, org_id));

create or replace function my_project_ids()
returns setof uuid language sql stable security definer as $$
  select project_id from project_members where user_id = auth.uid();
$$;

drop policy if exists projects_visibility_select on projects;
create policy projects_visibility_select on projects
  as restrictive for select using (
    coalesce(visibility, 'public') <> 'private'
    or owner_user_id = auth.uid()
    or id in (select my_project_ids())
  );

-- ── H5: org-scope audit_logs inserts (block cross-org injection)
drop policy if exists audit_logs_insert on audit_logs;
create policy audit_logs_insert on audit_logs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (org_id is null or org_id in (select my_org_ids()))
  );

-- ── C2: controller helper + controller-gated deletes
create or replace function is_org_controller(p_org uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from org_members
    where uid = auth.uid() and org_id = p_org and status = 'active'
      and (role in ('Admin', 'DocCtrl') or roles && array['Admin', 'DocCtrl']::text[])
  );
$$;

drop policy if exists documents_delete_controllers on documents;
create policy documents_delete_controllers on documents
  as restrictive for delete using (is_org_controller(org_id));

drop policy if exists document_versions_delete_controllers on document_versions;
create policy document_versions_delete_controllers on document_versions
  as restrictive for delete using (is_org_controller(org_id));

drop policy if exists collections_delete_controllers on collections;
create policy collections_delete_controllers on collections
  as restrictive for delete using (is_org_controller(org_id));

-- ── C2: guard document visibility/acl UPDATE (the "unhide" vector)
create or replace function acl_subject_has_action(
  p_bucket jsonb, p_action text,
  p_uid text, p_role text, p_team_ids text[], p_org text
) returns boolean language sql stable as $$
  select
    coalesce((p_bucket->'users'->p_action) ? p_uid, false)
    or (p_role is not null and coalesce((p_bucket->'roles'->p_action) ? p_role, false))
    or (p_team_ids is not null and array_length(p_team_ids, 1) > 0
        and exists (select 1 from unnest(p_team_ids) t where coalesce((p_bucket->'teams'->p_action) ? t, false)))
    or (p_org is not null and coalesce((p_bucket->'orgs'->p_action) ? p_org, false));
$$;

create or replace function can_manage_node(p_acl_index jsonb, p_org uuid)
returns boolean language plpgsql stable security definer as $$
declare
  v_uid text := auth.uid()::text; v_role text; v_teams text[];
  v_allow jsonb; v_deny jsonb; v_org text := p_org::text;
begin
  if is_org_controller(p_org) then return true; end if;
  if p_acl_index is null then return false; end if;
  select role into v_role from org_members where uid = auth.uid() and org_id = p_org and status = 'active' limit 1;
  if v_role is null then return false; end if;
  select array_agg(team_id::text) into v_teams from team_members where uid = auth.uid();
  v_allow := p_acl_index->'allow'; v_deny := p_acl_index->'deny';
  if acl_subject_has_action(v_allow, 'admin', v_uid, v_role, v_teams, v_org)
     and not acl_subject_has_action(v_deny, 'admin', v_uid, v_role, v_teams, v_org) then return true; end if;
  if acl_subject_has_action(v_allow, 'managePermissions', v_uid, v_role, v_teams, v_org)
     and not acl_subject_has_action(v_deny, 'managePermissions', v_uid, v_role, v_teams, v_org) then return true; end if;
  return false;
end;
$$;

create or replace function documents_guard_access_change()
returns trigger language plpgsql security definer as $$
begin
  if (new.visibility is distinct from old.visibility
      or new.acl is distinct from old.acl
      or new.acl_index is distinct from old.acl_index) then
    if auth.uid() is not null
       and not can_manage_node(old.acl_index, old.org_id)
       and not (old.acl_index is null and coalesce(old.visibility, 'normal') = 'normal') then
      raise exception 'Not permitted to change document visibility or access control on this document';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_guard_access on documents;
create trigger documents_guard_access
  before update on documents
  for each row execute function documents_guard_access_change();

-- ── CRITICAL: org_members privilege escalation (self-promote to Admin)
-- is_org_admin() normally comes from 20260713; define it here too so this
-- script is self-contained even on a DB where that migration wasn't applied.
create or replace function is_org_admin(p_org uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from org_members
    where uid = auth.uid() and org_id = p_org and status = 'active' and role = 'Admin'
  );
$$;

create or replace function is_org_admin_or_manager(p_org uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from org_members
    where uid = auth.uid() and org_id = p_org and status = 'active'
      and (role in ('Admin', 'Manager') or roles && array['Admin', 'Manager']::text[])
  );
$$;

drop policy if exists org_members_update on org_members;
create policy org_members_update on org_members
  for update
  using (is_org_admin_or_manager(org_id))
  with check (
    is_org_admin_or_manager(org_id)
    and (not (role = 'Admin' or roles && array['Admin']::text[]) or is_org_admin(org_id))
  );

drop policy if exists org_members_write on org_members;
create policy org_members_write on org_members
  for insert
  with check (
    is_org_admin_or_manager(org_id)
    and (not (role = 'Admin' or roles && array['Admin']::text[]) or is_org_admin(org_id))
  );

-- ── DB-6: keep search_path pins intact across re-runs of this script ─────────
-- The CREATE OR REPLACE statements above reset proconfig, which would strip
-- the `SET search_path = public` pins applied by
-- migrations/20261020_pin_search_path.sql. Re-pin everything this script may
-- have just re-created (idempotent; missing signatures are skipped).
do $$
declare
  sig text;
  sigs text[] := array[
    'doc_is_visible(uuid)',
    'my_project_ids()',
    'is_org_controller(uuid)',
    'can_manage_node(jsonb, uuid)',
    'documents_guard_access_change()',
    'is_org_admin(uuid)',
    'is_org_admin_or_manager(uuid)'
  ];
begin
  foreach sig in array sigs loop
    if to_regprocedure(sig) is not null then
      execute format('alter function %s set search_path = public', sig);
    end if;
  end loop;
end $$;
