-- 20261014_coverage_timeout_headroom.sql
--
-- semantic_coverage gets its own statement-timeout headroom (25s). During a
-- meaning-index build, thousands of row updates unset visibility-map bits
-- faster than autovacuum resets them, so the "index-only" counts degrade to
-- heap checks and can outrun the API role's default timeout — surfacing as
-- "canceling statement due to statement timeout" on the very panel that
-- reports build progress. The counts stay identical; they just get room to
-- finish while the table is being hammered.
--
-- Pair with housekeeping after any mass rewrite of knowledge_chunks:
--   VACUUM ANALYZE knowledge_chunks;

CREATE OR REPLACE FUNCTION semantic_coverage(p_org_id UUID, p_library_id UUID DEFAULT NULL)
RETURNS TABLE (total BIGINT, embedded BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
SET statement_timeout = '25s'
AS $$
SELECT
(SELECT COUNT(*) FROM knowledge_chunks WHERE org_id = p_org_id
AND (p_library_id IS NULL OR library_id = p_library_id))::BIGINT,
(SELECT COUNT(*) FROM knowledge_chunks WHERE org_id = p_org_id
AND (p_library_id IS NULL OR library_id = p_library_id)
AND embedding IS NOT NULL)::BIGINT;
$$;

REVOKE ALL ON FUNCTION semantic_coverage(UUID, UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_coverage(UUID, UUID) TO authenticated;
