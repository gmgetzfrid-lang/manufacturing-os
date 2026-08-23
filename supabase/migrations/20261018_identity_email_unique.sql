-- ═══════════════════════════════════════════════════════════════════
-- IDENT-1 · Make an email address mean one person
-- ═══════════════════════════════════════════════════════════════════
--
-- Nothing anywhere made users.email unique — `org_members` has
-- UNIQUE(org_id, uid), which prevents one *auth user* being doubled, not one
-- *person*. Two auth identities sharing an email (password + Microsoft) can
-- hold two membership rows in one org with two different roles, and which one
-- signs in depends on which button was pressed. This migration adds the
-- database backstop; the application half (case-insensitive matching and
-- collision refusal) is in lib/identity.ts and the admitting routes.
--
-- ⚠ APPLIED BY HAND (DEC-30). Read all of this before running any of it.
--
-- ── STEP 0 — inventory. RUN THESE FIRST and record the results in
--    audit-reports/identity-and-session/02-identity-collision.md (IDENT-1).
--
--   -- Duplicate profiles sharing an email (case-insensitive)
--   SELECT lower(email) AS email, count(*), array_agg(id) AS uids
--   FROM users WHERE email IS NOT NULL
--   GROUP BY lower(email) HAVING count(*) > 1;
--
--   -- Duplicate auth identities, and which providers each holds
--   SELECT lower(u.email) AS email, count(DISTINCT u.id) AS auth_users,
--          array_agg(DISTINCT i.provider) AS providers
--   FROM auth.users u LEFT JOIN auth.identities i ON i.user_id = u.id
--   WHERE u.email IS NOT NULL
--   GROUP BY lower(u.email) HAVING count(DISTINCT u.id) > 1;
--
--   -- Same email, same org, two membership rows
--   SELECT m.org_id, lower(m.email) AS email, count(*) AS rows,
--          array_agg(m.uid) AS uids, array_agg(m.role) AS roles,
--          array_agg(m.status) AS statuses
--   FROM org_members m WHERE m.email IS NOT NULL
--   GROUP BY m.org_id, lower(m.email) HAVING count(*) > 1;
--
-- If ALL THREE return zero rows, run the rest of this file as-is.
--
-- If any return rows: RECONCILE FIRST. The unique indexes below will
-- (correctly) fail to create while duplicates exist — that is the right
-- order of operations, not an obstacle. When reconciling:
--   • NEVER delete the spare auth.users row first — users.id is
--     ON DELETE CASCADE from auth.users, and org_members / e-signatures /
--     acknowledgments / checkout locks / audit rows all key on uid. Deleting
--     an identity deletes its profile and orphans its history.
--   • Instead: pick the surviving uid (the one holding the e-signature and
--     audit history), reassign the other uid's org_members rows (or delete
--     them where the surviving uid already holds a row in that org — keep
--     the higher-role row), reassign any other uid-keyed rows deliberately,
--     record what moved, and only then remove the spare identity.
--   • A healthy linked identity shows ONE auth.users row whose
--     auth.identities are {azure, email}. That is the desired end state —
--     see DEC-42 (identity linking is required).

-- ── STEP 1 — normalize stored emails (idempotent; safe to re-run).
-- The application now writes emails trimmed + lowercased (lib/identity.ts);
-- this brings pre-existing rows onto the same canonical form so the
-- case-insensitive lookups and the indexes below agree with the data.
UPDATE users
   SET email = lower(btrim(email))
 WHERE email IS NOT NULL AND email <> lower(btrim(email));

UPDATE org_members
   SET email = lower(btrim(email))
 WHERE email IS NOT NULL AND email <> lower(btrim(email));

UPDATE access_requests
   SET email = lower(btrim(email))
 WHERE email IS NOT NULL AND email <> lower(btrim(email));

-- ── STEP 2 — one profile per address.
-- The same technique the repo already uses for org names
-- (orgs_name_unique_ci): a case-folded unique index. It was simply never
-- applied to identity.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_ci
  ON users (lower(email))
  WHERE email IS NOT NULL;

-- ── STEP 3 — one ACTIVE membership per (org, address).
-- However many auth identities a person accumulates, the same address cannot
-- hold two active rows in one workspace. Partial on status='active' so a
-- suspended/inactive historical row never blocks a legitimate re-add.
CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_email_active_unique_ci
  ON org_members (org_id, lower(email))
  WHERE status = 'active' AND email IS NOT NULL;

-- ── Rollback ────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS users_email_unique_ci;
-- DROP INDEX IF EXISTS org_members_org_email_active_unique_ci;
-- (The email normalization in STEP 1 is not reversible and does not need to
-- be — lowercased emails remain deliverable and the app compares
-- case-insensitively either way.)
