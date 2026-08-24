-- DEC-11: the missing owner indexes.
--
-- documents (20260630) and projects (20260527) index their owner columns;
-- libraries and collections never did, although user_is_effective_owner and
-- every effective-owner walk filters on them. Same shape as documents_owner_idx.

CREATE INDEX IF NOT EXISTS libraries_owner_idx
  ON libraries (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS collections_owner_idx
  ON collections (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
