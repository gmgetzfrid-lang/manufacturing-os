-- Read-only storage/usage instrumentation for the admin "Storage & Usage" view.
-- Two SECURITY DEFINER functions that expose ONLY aggregate sizes/counts (never
-- row content), so an admin can see where data and cost actually sit. Locked to
-- the service_role (the admin API calls them); not callable by anon/users.

-- Per-table total size on disk + a cheap row-count estimate (pg's planner
-- statistic; refreshed by ANALYZE/autovacuum). Deployment-wide.
create or replace function mfg_table_stats()
returns table(table_name text, row_estimate bigint, total_bytes bigint)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select
    c.relname::text,
    c.reltuples::bigint,
    pg_total_relation_size(c.oid)::bigint
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
  order by pg_total_relation_size(c.oid) desc;
$$;

-- R2 binary estimate, summed from the records that carry a stored size.
-- Excludes ticket attachments (no size column) and orphaned files.
create or replace function mfg_storage_estimate()
returns table(versions_bytes bigint, photos_bytes bigint, version_count bigint, photo_count bigint)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select
    coalesce((select sum(size) from document_versions), 0)::bigint,
    coalesce((select sum(file_size) from asset_photos), 0)::bigint,
    (select count(*) from document_versions)::bigint,
    (select count(*) from asset_photos)::bigint;
$$;

revoke all on function mfg_table_stats() from public, anon, authenticated;
revoke all on function mfg_storage_estimate() from public, anon, authenticated;
grant execute on function mfg_table_stats() to service_role;
grant execute on function mfg_storage_estimate() to service_role;
