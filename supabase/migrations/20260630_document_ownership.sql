-- Document ownership ─────────────────────────────────────────────────────────
-- An accountable OWNER can be delegated at the library, folder (collection), or
-- document level; the most specific one wins, and an unset owner falls back to
-- the org's Admin/DocCtrl roles collectively. The owner receives that document's
-- notifications and (Phase 2) is granted CRUD access to their scope; if a
-- delegated owner falls behind on review upkeep, Admin/DocCtrl get a side
-- escalation so responsibility is delegated, not abandoned.

ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS owner_name    TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS owner_name    TEXT;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS owner_name    TEXT;

-- "Everything I own" lookups + escalation scans.
CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
