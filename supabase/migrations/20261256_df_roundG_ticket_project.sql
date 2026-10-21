-- ─────────────────────────────────────────────────────────────────────────────
-- 20261256_df_roundG_ticket_project.sql
--
-- drafting-flow Round G — DF-P8 PROJECTS: a drafting request names the
-- project it belongs to BY REFERENCE (DEC-40, GAP-114). One foreign key on
-- the ticket; the project's list of requests is a query, never a stored set,
-- and never a copy of a deliverable.
--
--   (1) tickets.project_id UUID REFERENCES projects(id) ON DELETE SET NULL
--       (nullable — a request with no project is exactly today's request),
--       plus a partial index for the project's request list.
--   (2) ticket_project_guard() + trg_ticket_project_guard BEFORE INSERT OR
--       UPDATE (SECURITY INVOKER, search_path pinned — its own trigger, so
--       ticket_update_guard is NOT re-created here and keeps 20261250's
--       body):
--         (a) for EVERY caller — the service role and the paste owner
--             included — the org-equality rail: a project_id that is set
--             names a project of the ticket's OWN workspace (as 20261047's
--             rails bind a row to its org). Checked when the reference is
--             written or the ticket's org changes;
--         (b) for a signed-in client: project_id is workflow-owned — a
--             client neither inserts one nor changes one. The writers are
--             /api/tickets/create (a request filed from a project, a
--             check-in under a project checkout, an intake collision) and
--             /api/tickets/project-link (link / unlink / "create a project
--             from this request"), both as the service role. The one other
--             writer is the project's own deletion: ON DELETE SET NULL
--             clears the reference from inside the delete's trigger once the
--             project row is gone, and only that passes (the library_id
--             limb's shape, 20261208).
--   (3) THE BACKFILL (DEC-90 ruling (2) for DF-P8 — inventory first, counts
--       only): before this paste the only project reference a ticket carried
--       was metadata.intake_collision.projectId (written by
--       flagCollisionToDrafting). It is copied into the column ONLY where it
--       is a UUID naming a project that exists in the SAME workspace, the
--       column is still empty, and the request never went through the link
--       route (metadata.project_link absent — a request somebody unlinked is
--       never re-linked by a re-paste). last_modified is not touched (no
--       compare-and-set token moves; nothing in flight is refused). Every
--       other row is left exactly as it is and counted.
--   (4) checkout_sessions.linked_ticket_id (DF-P8 fix pass 4): the baseline
--       declares it `UUID REFERENCES tickets(id)` with NO delete action
--       (supabase/schema.sql), and until DF-P8 nothing wrote it (inventory
--       row 6). /api/tickets/create now stamps a check-in's session with the
--       request it raised, so a request whose check-in session names it
--       could no longer be deleted (23503). The foreign key is re-created ON
--       DELETE SET NULL — milestones.linked_ticket_id's shape (20260614):
--       deleting the request clears the session's pointer, the session
--       stays. Every foreign key on that column to tickets that is not
--       already SET NULL is dropped first (by catalog, whatever its name);
--       a re-paste finds the SET NULL key and changes nothing. The route
--       writes that stamp ONLY once this file is applied (it sees
--       tickets.project_id — this file is one transaction, so (1) is there
--       exactly when (4) is); before the paste it stamps nothing, as before
--       DF-P8, so no request is held by the baseline key.
--
-- PASTE / DEPLOY ORDER. Independent of every other ticket migration (it
-- needs only tickets and projects). Either order with the DF-P8 deploy is
-- safe; RECOMMENDED: deploy the app first, then paste.
--   * App deployed, not pasted: tickets.project_id is not there. Every read
--     of it answers 42703 / PGRST204 (or a missing column in the row) and
--     takes today's path: the create route files the request without it (a
--     request filed from a project says the link was not recorded yet) and
--     stamps no checkout session's linked_ticket_id (the baseline key there
--     has no delete action — a stamp would make the request undeletable,
--     23503 — so the route stamps only once it sees the column), the
--     link route answers 503 "needs database update 20261256", the ticket
--     page reads the intake collision's project as today, the project page
--     shows no requests card and no "open drafting requests" gate line.
--   * Pasted, app not yet deployed: the old app never writes the column; the
--     backfilled collision tickets carry the reference the old app ignores.
--
-- NOT A WIDENING for any person: no client gains a write (a client loses
-- none either — it never had this column); the reference grants no access
-- (a project member who cannot read the ticket or the library still cannot).
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE
-- OR REPLACE, DROP TRIGGER IF EXISTS, the (4) key re-created only when it is
-- not already SET NULL; the backfill writes only rows whose
-- column is still empty (a re-paste writes 0).
-- Single paste: temp-table inventory (counts only) → BEGIN/DDL/backfill/
-- COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_256_before;
CREATE TEMP TABLE df_round_g_256_before AS
WITH ic AS (
  SELECT t.id, t.org_id, t.metadata->'intake_collision'->>'projectId' AS pid,
         (t.metadata ? 'project_link') AS link_route
    FROM tickets t
   WHERE jsonb_typeof(t.metadata) = 'object'
     AND jsonb_typeof(t.metadata->'intake_collision') = 'object'
     AND COALESCE(t.metadata->'intake_collision'->>'projectId', '') <> ''
)
SELECT 1 AS ord, 'inventory (before apply): requests carrying an intake collision''s project id (metadata.intake_collision.projectId)' AS inventory,
       COUNT(*)::text AS n FROM ic
UNION ALL
SELECT 2, 'inventory (before apply): of those, the id names a project in the SAME workspace — the backfill writes tickets.project_id for exactly these (minus any already linked by the route)',
       COUNT(*)::text FROM ic
        WHERE ic.pid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND NOT ic.link_route
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ic.pid::uuid AND p.org_id = ic.org_id)
UNION ALL
SELECT 3, 'inventory (before apply): of those, the project is gone or in another workspace — NOT written, left as they are (the ticket page keeps reading the metadata as today)',
       COUNT(*)::text FROM ic
        WHERE ic.pid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ic.pid::uuid AND p.org_id = ic.org_id)
UNION ALL
SELECT 4, 'inventory (before apply): of those, the id is not a UUID — NOT written (expected 0)',
       COUNT(*)::text FROM ic
        WHERE NOT (ic.pid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
UNION ALL
SELECT 5, 'inventory (before apply): projects whose linked_ticket_id is set (PROJ-13: the column had no reachable writer — expected 0)',
       COUNT(*)::text FROM projects WHERE linked_ticket_id IS NOT NULL
UNION ALL
SELECT 6, 'inventory (before apply): checkout sessions whose linked_ticket_id is set (PROJ-10: the column had no writer — expected 0)',
       COUNT(*)::text FROM checkout_sessions WHERE linked_ticket_id IS NOT NULL;

BEGIN;

-- ── 1. the reference ────────────────────────────────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tickets_project_id_idx ON tickets (project_id) WHERE project_id IS NOT NULL;

-- ── 2. the guard: the org-equality rail (every caller) and the column ───────
--       workflow-owned (a signed-in client neither inserts nor changes it)
-- New function (no earlier body). SECURITY INVOKER: the service role and
-- the paste owner read projects without row security; a client is refused
-- before the rail would read anything for it.
CREATE OR REPLACE FUNCTION ticket_project_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  -- (a) the org-equality rail — every caller.
  IF NEW.project_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'tickets: project_id must name a project of the request''s own workspace' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The create route and the project-link route (service role) write it.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- (b) a signed-in client: workflow-owned.
  IF TG_OP = 'INSERT' THEN
    IF NEW.project_id IS NOT NULL THEN
      RAISE EXCEPTION 'tickets: a request is linked to a project by the request workflow' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- The project's own deletion (ON DELETE SET NULL) clears it from inside
  -- the delete's trigger once the project row is gone — only that passes.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     AND NOT (pg_trigger_depth() > 1 AND NEW.project_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = OLD.project_id)) THEN
    RAISE EXCEPTION 'tickets: column(s) project_id are workflow-owned — use the request workflow actions' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_project_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_project_guard ON tickets;
CREATE TRIGGER trg_ticket_project_guard
  BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_project_guard();

-- ── 3. the backfill (inventory row 2's predicate, word for word) ────────────
UPDATE tickets t
   SET project_id = (t.metadata->'intake_collision'->>'projectId')::uuid
 WHERE t.project_id IS NULL
   AND jsonb_typeof(t.metadata) = 'object'
   AND jsonb_typeof(t.metadata->'intake_collision') = 'object'
   AND COALESCE(t.metadata->'intake_collision'->>'projectId', '') <> ''
   AND (t.metadata->'intake_collision'->>'projectId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND NOT (t.metadata ? 'project_link')
   AND EXISTS (SELECT 1 FROM projects p WHERE p.id = (t.metadata->'intake_collision'->>'projectId')::uuid AND p.org_id = t.org_id);

-- ── 4. checkout_sessions.linked_ticket_id → tickets(id) ON DELETE SET NULL ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.conname
             FROM pg_constraint c
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.contype = 'f' AND c.conrelid = 'public.checkout_sessions'::regclass
              AND c.confrelid = 'public.tickets'::regclass AND a.attname = 'linked_ticket_id'
              AND c.confdeltype <> 'n'
  LOOP
    EXECUTE format('ALTER TABLE checkout_sessions DROP CONSTRAINT %I', r.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                  WHERE c.contype = 'f' AND c.conrelid = 'public.checkout_sessions'::regclass
                    AND c.confrelid = 'public.tickets'::regclass AND a.attname = 'linked_ticket_id') THEN
    ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_linked_ticket_id_fkey
      FOREIGN KEY (linked_ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 7 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'GAP-114 / DEC-40: tickets.project_id is a UUID referencing projects(id) ON DELETE SET NULL' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'project_id' AND data_type = 'uuid' AND is_nullable = 'YES')
       AND EXISTS (SELECT 1 FROM pg_constraint c
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                   WHERE c.contype = 'f' AND c.conrelid = 'public.tickets'::regclass AND c.confrelid = 'public.projects'::regclass
                     AND a.attname = 'project_id' AND c.confdeltype = 'n') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'the project''s request list is indexed (tickets_project_id_idx)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tickets' AND indexname = 'tickets_project_id_idx'),
       NULL
UNION ALL
SELECT 1, 3, 'the guard runs BEFORE INSERT OR UPDATE (trigger enabled; SECURITY INVOKER, search_path pinned; no client may EXECUTE it)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_project_guard' AND tgrelid = 'public.tickets'::regclass AND NOT tgisinternal AND tgenabled = 'O')
       AND (SELECT NOT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_proc WHERE proname = 'ticket_project_guard')
       AND NOT has_function_privilege('authenticated', 'public.ticket_project_guard()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_project_guard()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 4, 'the org-equality rail holds for every caller, and a client neither inserts nor changes project_id (the project''s own deletion excepted)',
       (SELECT prosrc LIKE '%p.id = NEW.project_id AND p.org_id = NEW.org_id%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%IF TG_OP = ''INSERT'' THEN%pg_trigger_depth() > 1 AND NEW.project_id IS NULL%'
          FROM pg_proc WHERE proname = 'ticket_project_guard'),
       NULL
UNION ALL
SELECT 1, 5, 'every request that names a project names one of its own workspace (0 violations)',
       NOT EXISTS (SELECT 1 FROM tickets t WHERE t.project_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.org_id = t.org_id)),
       NULL
UNION ALL
SELECT 1, 6, 'the backfill left nothing it should have written (0 collision requests with a same-workspace project still unlinked, unless the link route recorded a choice)',
       NOT EXISTS (SELECT 1 FROM tickets t
                    WHERE t.project_id IS NULL
                      AND jsonb_typeof(t.metadata) = 'object'
                      AND jsonb_typeof(t.metadata->'intake_collision') = 'object'
                      AND (t.metadata->'intake_collision'->>'projectId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      AND NOT (t.metadata ? 'project_link')
                      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = (t.metadata->'intake_collision'->>'projectId')::uuid AND p.org_id = t.org_id)),
       NULL
UNION ALL
SELECT 1, 7, 'a check-in session''s linked_ticket_id references tickets(id) ON DELETE SET NULL only (deleting the request clears the pointer; the session stays)',
       EXISTS (SELECT 1 FROM pg_constraint c
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.contype = 'f' AND c.conrelid = 'public.checkout_sessions'::regclass AND c.confrelid = 'public.tickets'::regclass
                  AND a.attname = 'linked_ticket_id' AND c.confdeltype = 'n')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.contype = 'f' AND c.conrelid = 'public.checkout_sessions'::regclass AND c.confrelid = 'public.tickets'::regclass
                  AND a.attname = 'linked_ticket_id' AND c.confdeltype <> 'n'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_256_before
UNION ALL
SELECT 3, 1, 'after: requests naming a project (tickets.project_id set)', NULL,
       (SELECT COUNT(*) FROM tickets WHERE project_id IS NOT NULL)::text
) AS final_rows
ORDER BY sec, ord;
