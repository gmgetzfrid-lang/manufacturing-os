-- 20260826_user_avatars.sql
--
-- USER AVATARS — a real identity everywhere a person appears.
--
-- Two changes:
--   1. users.avatar_path — storage path of the profile picture (resolved to
--      a signed URL client-side, same pattern as the org logo).
--   2. A SELECT policy so members of a shared org can read each other's
--      display_name + avatar. Until now `users` was self-only (users_own FOR
--      ALL), which is why every surface fell back to letter hacks — the app
--      literally couldn't see anyone else's name.
--
-- Write access is unchanged: only the user themself (users_own) can update
-- their row. Additive + idempotent; apply in the Supabase SQL editor.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path TEXT;

COMMENT ON COLUMN users.avatar_path IS
  'Storage path of the profile picture (e.g. avatars/<uid>/avatar-<rand>.png). NULL = no photo; UIs fall back to name initials (Grant Getzfrid → GG).';

-- Members who share at least one active org may see each other's profile
-- basics. The self-only users_own policy remains for writes.
DROP POLICY IF EXISTS users_shared_org_select ON users;
CREATE POLICY users_shared_org_select ON users FOR SELECT USING (
  id = auth.uid()
  OR EXISTS (
    SELECT 1
    FROM org_members me
    JOIN org_members them ON them.org_id = me.org_id
    WHERE me.uid = auth.uid() AND me.status = 'active'
      AND them.uid = users.id AND them.status = 'active'
  )
);
