-- Performance indexes for the document-listing hot path.
--
-- The library explorer's main query filters documents by
--   (org_id, library_id, collection_id [or NULL])  and sorts by updated_at DESC
-- but no existing index covers collection_id OR the sort, so every folder open
-- did a filtered scan + an explicit sort of the library's matching rows. This
-- composite serves the folder case (collection_id = X), the root case
-- (collection_id IS NULL), and supplies the sort order for free — the single
-- biggest win for folder-open latency on a non-trivial library.
CREATE INDEX IF NOT EXISTS documents_folder_listing_idx
  ON documents (org_id, library_id, collection_id, updated_at DESC);

-- The folder list (collections) for a library is fetched by (org_id, library_id)
-- with no covering index today.
CREATE INDEX IF NOT EXISTS collections_org_library_idx
  ON collections (org_id, library_id);

-- The ACL RLS function node_visible() runs per row on every documents/collections
-- SELECT and does correlated lookups into org_members and team_members. Make sure
-- its exact filters are index-backed so the policy doesn't table-scan per row.
CREATE INDEX IF NOT EXISTS org_members_uid_org_active_idx
  ON org_members (uid, org_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS team_members_uid_idx
  ON team_members (uid);
