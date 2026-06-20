-- Dedup opportunity measurement (read-only). Uses the SHA-256 already stored in
-- document_versions.file_hash to quantify how many bytes are identical files
-- stored more than once — i.e. what content-addressed dedup would reclaim.
-- Aggregates only; SECURITY DEFINER, service-role only. Changes nothing.

create or replace function mfg_dedup_stats()
returns table(
  total_versions bigint,
  total_bytes bigint,
  distinct_hashes bigint,
  dup_groups bigint,
  reclaimable_bytes bigint
)
language sql
security definer
set search_path = public, pg_catalog
as $$
  with h as (
    select file_hash, count(*) as n, sum(size) as bytes, max(size) as keep_size
    from document_versions
    where file_hash is not null and size is not null
    group by file_hash
  )
  select
    coalesce(sum(n), 0)::bigint,                                   -- versions with a hash+size
    coalesce(sum(bytes), 0)::bigint,                              -- their total bytes
    coalesce(count(*), 0)::bigint,                                -- distinct files (unique hashes)
    coalesce(count(*) filter (where n > 1), 0)::bigint,          -- hashes stored more than once
    coalesce(sum(bytes - keep_size), 0)::bigint                  -- reclaimable: keep one copy per hash
  from h;
$$;

revoke all on function mfg_dedup_stats() from public, anon, authenticated;
grant execute on function mfg_dedup_stats() to service_role;
