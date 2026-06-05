-- 20260722_member_roles_collection.sql
-- Additive role model: a member can hold a COLLECTION of roles; their effective
-- permissions are the union of what each grants.
--
-- org_members.role is KEPT as the PRIMARY / headline role and is always the
-- highest-ranked role in the collection. Every existing single-role check and
-- every RLS policy reads `role`, so they keep working unchanged — no RLS
-- surgery, no lockout risk.
--
-- Additive + idempotent. Fully reversible:  ALTER TABLE org_members DROP COLUMN roles;

ALTER TABLE org_members
  ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';

-- Seed the collection from each member's existing single role.
UPDATE org_members
   SET roles = ARRAY[role]
 WHERE (roles IS NULL OR roles = '{}')
   AND role IS NOT NULL;

COMMENT ON COLUMN org_members.roles IS
  'Additive role collection. Effective permissions = union across these roles. '
  'org_members.role mirrors the highest-ranked role here (the headline) so '
  'legacy single-role checks and RLS policies keep working.';
