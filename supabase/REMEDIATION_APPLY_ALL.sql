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
