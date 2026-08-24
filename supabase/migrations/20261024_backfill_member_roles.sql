-- DB-3 / DEC-1 step 1: backfill org_members.roles from role.
--
-- `roles TEXT[] NOT NULL DEFAULT '{}'` is never NULL — so
-- `COALESCE(roles, ARRAY[role])` (used by org_capability_allows,
-- acl_index_denies, the milestone batch move) never falls through, and any
-- row whose `roles` was never populated evaluates every additive check against
-- an EMPTY array. Signup created the founding Admin with role='Admin' and
-- roles='{}', so that Admin fails every additive check.
--
-- This backfills every row whose `roles` is empty (or somehow missing its
-- headline role) so `roles` always contains at least `role`. It is the
-- prerequisite for ANY conversion of a check from the singular `role` to the
-- `roles` array (DEC-1, DEC-2, OWN-3): converting before this backfill makes
-- "additive" mean "deny everyone". Idempotent — safe to re-run.
--
-- The 20260722 seeding UPDATE ran once at migration time and does not help
-- orgs created afterward; this catches those.

-- Two branches, because SET must never LOSE a role: an empty/NULL collection
-- is seeded from the headline, but a populated collection that is merely
-- missing its headline gets the headline APPENDED — `roles = ARRAY[role]`
-- there would have discarded every additive role the member held.
-- (2026-08-24 adversarial-review note: the version applied to the live DB on
-- 2026-08-24 used a single replacing UPDATE; the live probe showed no
-- populated-but-missing-headline rows existed, so no data was lost there.
-- This corrected form is for every future/fresh deployment. Same end state
-- for non-drifted rows; idempotent.)

UPDATE org_members
   SET roles = ARRAY[role]
 WHERE role IS NOT NULL
   AND role <> ''
   AND (roles IS NULL OR roles = '{}');

UPDATE org_members
   SET roles = roles || ARRAY[role]
 WHERE role IS NOT NULL
   AND role <> ''
   AND roles <> '{}'
   AND NOT (role = ANY(roles));

-- Verification (expect zero rows): every active member's roles array carries
-- its headline role.
SELECT uid, org_id, role, roles
FROM org_members
WHERE role IS NOT NULL AND role <> '' AND NOT (role = ANY(roles));
