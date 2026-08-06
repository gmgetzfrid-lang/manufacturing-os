-- 20261008_storage_estimate_knowledge.sql
--
-- Teach the R2 fallback estimate about knowledge-library files.
--
-- mfg_storage_estimate() summed exactly two columns — document_versions.size
-- and asset_photos.file_size. Every knowledge-library PDF was invisible to
-- it, even though knowledge_documents.file_size has been populated at upload
-- since the library shipped. The estimate is what the storage page falls back
-- to when the real bucket walk fails, so a deployment with a credentials
-- problem showed a "storage used" figure that could not move no matter how
-- many drawings were uploaded — the most misleading shape a metric can take.
--
-- The measured bucket walk remains the truth. This only makes the fallback
-- honest about what it can and cannot see.
--
-- Idempotent. Apply after 20260805.
--
-- DROP first, deliberately: this widens the function's OUT parameters, and
-- Postgres rejects CREATE OR REPLACE when the returned row type changes
-- (42P13). Safe — the function is a read-only aggregate over live tables, so
-- dropping it destroys nothing and recreating it restores it in the same
-- transaction.

drop function if exists mfg_storage_estimate();

create function mfg_storage_estimate()
returns table(
  versions_bytes bigint,
  photos_bytes bigint,
  knowledge_bytes bigint,
  version_count bigint,
  photo_count bigint,
  knowledge_count bigint
)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select
    coalesce((select sum(size) from document_versions), 0)::bigint,
    coalesce((select sum(file_size) from asset_photos), 0)::bigint,
    coalesce((select sum(file_size) from knowledge_documents), 0)::bigint,
    (select count(*) from document_versions)::bigint,
    (select count(*) from asset_photos)::bigint,
    (select count(*) from knowledge_documents)::bigint;
$$;

revoke all on function mfg_storage_estimate() from public, anon, authenticated;
grant execute on function mfg_storage_estimate() to service_role;
