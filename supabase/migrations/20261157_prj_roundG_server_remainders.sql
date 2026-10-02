-- 20261157_prj_roundG_server_remainders.sql
--
-- projects Round G — J12 SERVER REMAINDERS. Six database halves that the
-- merged packages left in the browser, in one paste. The numbers below are
-- the body's section numbers (the `-- ── n.` headings), which the records cite.
--
-- WHAT:
--   1–2. MON-12 — the registry rail on an award (§1 the company behind a
--      document, §2 the rail). `enforce_cost_document_award_registry`
--      (BEFORE INSERT OR UPDATE OF status ON cost_documents, SECURITY DEFINER,
--      search_path pinned): a signed-in write that moves a quote to
--      `awarded` is refused when the company it answers for (below) is
--      flagged `do_not_use` or `inactive` in the Known Companies registry — unless
--      the award runs through `award_quote` with a typed reason, which sets
--      `app.cost_doc_award_override` to the document's id for that one
--      statement. The company the award must ANSWER FOR is
--      `cost_doc_company_barred` — lib/costDocs.ts `companyBehind`'s
--      `barred`, the bid tab's `barredCompanyFor` gate (DEC-48: binding
--      refuses ambiguity, gating does not): a link that stands decides,
--      flagged or not — the document's own registry link
--      (cost_documents.company_id, 20261096 — read through to_jsonb so a
--      database without the column is not broken), then its contractor's
--      (project_parties.company_id), each only to a company of the
--      document's own org; with no link standing, ANY do_not_use registry
--      row of the org whose name normalises as the vendor name does
--      (`company_name_key` — lib/bidTab.ts normalizeCompanyName in SQL:
--      case, '&' as 'and', punctuation and whitespace, trailing legal
--      suffixes, a leading 'the'), so "Gulf Mechanical Inc" answers for a
--      do-not-use "Gulf Mechanical, Inc." — DEC-48's gate, which flags
--      do-not-use look-alikes only, as barredCompanyFor does; else the
--      company the quote binds to by ONE exact name, which answers for its
--      own `inactive` flag as it did before this migration. An inactive
--      look-alike the quote does not bind to is not the bid's (a registry
--      de-duplicated by marking the old row inactive leaves exactly that
--      beside the active row). The binding (`cost_doc_company_behind`: the
--      links, then ONE exact case-insensitive name) is what the award
--      records, never what clears a do-not-use look-alike's flag. The rail reads the registry as the definer (the functions
--      called from it run as the owner), so a row the caller cannot read
--      does not slip past. The write
--      that awards a quote may not also change the company link, the
--      contractor or the vendor name it is judged by. NOT covered (recorded
--      on projects-tab MON-12, which stays OPEN): moving those first, in a
--      write of their own, and awarding after — the bid row's company picker
--      asks a reason for moving a bid off a do-not-use company only in the
--      browser. The service role (auth.uid() NULL — restores, server routes,
--      the SQL editor) keeps its pass, as every Round G rail does.
--   3. GAP-406 — the award as ONE transaction. `award_quote(p_doc,
--      p_cost_account, p_expected_total, p_override_reason,
--      p_confirmed_total)` (SECURITY INVOKER: every read and write is the
--      caller's own, under the same RLS and the same 20261093 / 20261103
--      rails as the app's client sequence — nothing is widened) locks the
--      quote, re-checks it (a quote, still draft / parsed, the budget line
--      on the same project and in the document's currency, the total the
--      caller checked, the registry gate, and COST-13's read extent — a
--      confirmed figure that is not the total, or an AI total from a
--      truncated or unknown read with no confirmed figure, is refused as
--      lib/costDocs.ts extentRefusal refuses it, so `totalConfirmed` on
--      the award's record is never a confirmation that did not happen),
--      then CLAIMS it, posts the commitment
--      (lib/costs.ts addEntry's row, with its COST_ENTRY_POSTED audit row),
--      records the override (COST_DOC_AWARD_OVERRIDE), declines the open
--      rivals of the same RFQ group (compared by key — case-folded,
--      whitespace collapsed, lib/costDocs.ts rfqKey) and writes
--      COST_DOC_AWARDED. A failure at any step after the claim raises, so the
--      whole award rolls back — no awarded paper without its commitment.
--      A refusal BEFORE the claim returns {ok:false, code} and writes
--      nothing. A NULL auth.uid() is refused (DRLS-16); EXECUTE is revoked
--      from PUBLIC and anon. lib/costDocs.ts awardQuote calls it and falls
--      back to the client sequence while it is missing (42883 / PGRST202).
--   4. PERF-7 / DEC-52 item 10 — the assessment and the sweep apply in ONE
--      request. `apply_checklist_item_writes(p_checklist, p_writes)`
--      (SECURITY INVOKER) applies a list of machine writes to one
--      checklist's items in ONE statement, each row guarded on its
--      `updated_at` AS READ (`IS NOT DISTINCT FROM` — the same optimistic
--      guard as the client's `.eq("updated_at", …)` / `.is("updated_at",
--      null)`). Only when that statement is refused (a rail judged one row)
--      is the call judged row by row, each row in its own sub-transaction so
--      one refusal never undoes the rest — and only for a call of at most 50
--      writes (each landed row's sub-transaction holds a transaction id until
--      the call commits; PostgreSQL caches 64 per session before every other
--      session's snapshot must read pg_subtrans). A larger refused call
--      applies nothing and answers {split: 50}; the lib re-sends its writes
--      in calls of 50. It returns the ids that landed, the ids the guard
--      refused (changed by someone else, or filtered by RLS) and the
--      failures (id, SQLSTATE, message).
--      Only the machine actor's columns are written (status, applicability,
--      ai_rationale, evidence) and `updated_by_name` must be one of the two
--      machine names — every 20261091 rail still fires per row
--      (checklist_items_decision_rail bounds what each machine may write).
--      A NULL auth.uid() is refused; EXECUTE revoked from PUBLIC and anon.
--      lib/checklists.ts writeItemPatches calls it and falls back to the
--      batched single-row writes while it is missing.
--   5. MON-13 / DEC-76 item 3 — the contractor-link and item-contractor rules.
--        * `enforce_project_party_company_link` (BEFORE UPDATE OF company_id
--          ON project_parties): a contractor's Known Company link is set once
--          — a signed-in caller never re-points or clears a link that is set.
--          The company's own delete (its FK ON DELETE SET NULL, an UPDATE one
--          trigger level down) passes.
--        * `enforce_quality_item_contractor` (BEFORE UPDATE OF party_id ON
--          turnover_items and punch_items): an item's contractor changes only
--          while the item is undecided (turnover open / received; punch
--          open); an unassigned decided item may be named once, except a
--          REJECTED turnover item (no reopen — a wrong name could never be
--          corrected). The contractor's own delete (FK ON DELETE SET NULL,
--          one trigger level down) passes. The do-not-use REASON on a
--          look-alike link stays an app-level confirmation (lib/costs.ts),
--          as DEC-76 item 3 says.
--   6–7. SEC-21 — project audit rows written under another resource type
--      follow the project. `audit_row_project_ref_visible(action, type,
--      resource, details)` (SECURITY INVOKER, no SET clause, names
--      schema-qualified — 20261142's shape): a row that names its project in
--      `details.projectId` follows that project; an intake-link row
--      (`project_intake_link`) follows the link's project; a MILESTONE_* row
--      follows its milestone's project (`details.milestoneId`; a milestone
--      with no project is org-level, a project-typed row is SEC-20's). A
--      milestone row whose milestone is gone or unreadable stays readable
--      when it is typed `milestone` (written for an org-level milestone) or
--      carries §9's org-level marker (`projectIdFrom: 'milestone'`,
--      `orgLevel: true` — its milestone was on no project when the row was
--      written); any other such row (typed `document` and written before
--      this migration — its project can no longer be traced) is the audit
--      roles' only. §9 stamps every milestone row written from now on with
--      its project or the org-level marker, so that is pre-migration
--      history only. `audit_logs_admin_trail` is re-created from its NEWEST
--      definition (20261142) byte for byte with ONE added clause — the type /
--      action test inline, so a row of any other kind never calls the
--      function.
--   8. SAF-9 — the contractor's outcome notice is CLAIMED before it is
--      sent. A partial UNIQUE index on audit_logs (org, details.versionId,
--      details.attempt) WHERE action = 'INTAKE_OUTCOME_NOTICE_CLAIMED':
--      /api/intake/outcome-notice writes that claim row before it calls the
--      mail provider, so two concurrent calls (a double-click, a decision in
--      two tabs) send ONE email; a failed send frees the next attempt. The
--      index matches no existing row; building it reads audit_logs once
--      (a short pause for audit writes on a large trail). The notice's three
--      rows (CLAIMED, FAILED, NOTIFIED) are the route's own — it writes them
--      as the service role: `enforce_intake_outcome_notice_server_only`
--      (BEFORE INSERT ON audit_logs, only for those three actions — the
--      trigger's WHEN clause) refuses a signed-in insert of one, so no
--      member can forge "already notified" (the contractor never told) or
--      hold every attempt "in progress".
--   9. SEC-21 — a milestone's audit row carries its project.
--      `stamp_milestone_audit_project` (BEFORE INSERT ON audit_logs, only for
--      a MILESTONE_* row — the trigger's WHEN clause; SECURITY DEFINER,
--      search_path pinned, revoked from PUBLIC, anon and authenticated)
--      writes `details.projectId` (and `projectIdFrom: 'milestone'`) from
--      the milestone's own project, so §6's first branch decides the row even
--      after the milestone is deleted. A milestone on no project gets the
--      org-level marker instead (`projectIdFrom: 'milestone'`, `orgLevel:
--      true`, no projectId), which §6 reads as org-level once the milestone
--      is gone — a document-scoped milestone's rows stay every member's.
--      MILESTONE_DELETED is written once the milestone is gone: it takes the
--      project — or the marker — this trigger stamped on the milestone's
--      newest earlier row (same org, same resource, read through the
--      resource_id index; newest by `timestamp`, which the trigger sets to
--      the server's clock on every signed-in milestone row, so a writer's
--      clock never chooses). A project-typed delete skips that read (SEC-20
--      decides a project row by its resource_id, the project). A projectId,
--      projectIdFrom or orgLevel the writer put on the row is replaced —
--      never trusted, here or for a later row. The service role (auth.uid()
--      NULL — a restore re-inserting rows) keeps its rows as written.
--      lib/milestones.ts is not changed.
--
-- NOT a widening: every rule here refuses or narrows. The DEC-30 inventory
-- (aggregate counts only, never rows) is captured BEFORE the transaction and
-- returned with the probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true; inventory rows carry ok NULL and a count in n.
-- Requires 20261013 (the registry and the quality tables), 20261091 (the
-- checklist rails), 20261093 (the money rails) and 20261142 (SEC-20's
-- overlay, which section 7 re-creates).
--
-- PASTE ORDER: after 20261142 (the guard below refuses otherwise) AND only
-- once the J12 code is deployed. The code deployed before J12 awards a
-- flagged quote with its typed reason by writing status = 'awarded'
-- directly and recording the reason afterwards; it never sets
-- app.cost_doc_award_override, so section 2 would refuse every reasoned
-- override (the person types a reason and is still refused) until the J12
-- code — which awards through award_quote — is live. Pasted after the
-- deploy, the J12 code uses award_quote from the paste on.

DO $$
BEGIN
  IF to_regprocedure('public.audit_row_project_visible(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261142_prj_roundG_project_audit_rows.sql first — section 7 re-creates its audit_logs_admin_trail. Nothing was changed.';
  END IF;
END $$;

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
-- The name normaliser (section 1's company_name_key) is not in the database
-- yet when the inventory runs, so it reads a session-local copy — the same
-- body, pinned equal by the shape test (20261091's pattern).
CREATE OR REPLACE FUNCTION pg_temp.prj_g_j12_name_key(p_name text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  -- lib/bidTab.ts LEGAL_SUFFIXES, in its order (the shape test pins it).
  v_suffixes CONSTANT text[] := ARRAY['inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'gmbh', 'plc',
                                      'lp', 'llp', 'pty', 'sa', 'ag', 'bv', 'nv', 'srl', 'sarl', 'pte', 'pllc', 'pc'];
  v_tokens text[];
BEGIN
  -- lower-case; '&' reads as 'and'; anything but a-z, 0-9 and space is a
  -- break; split on the breaks (empty pieces dropped).
  v_tokens := array_remove(regexp_split_to_array(
                regexp_replace(replace(lower(COALESCE(p_name, '')), '&', ' and '), '[^a-z0-9 ]+', ' ', 'g'), ' +'), '');
  -- trailing legal suffixes go, never the last word;
  WHILE cardinality(v_tokens) > 1 AND v_tokens[cardinality(v_tokens)] = ANY (v_suffixes) LOOP
    v_tokens := v_tokens[1:cardinality(v_tokens) - 1];
  END LOOP;
  -- then a leading 'the', never the only word.
  IF cardinality(v_tokens) > 1 AND v_tokens[1] = 'the' THEN
    v_tokens := v_tokens[2:cardinality(v_tokens)];
  END IF;
  RETURN array_to_string(v_tokens, ' ');
END;
$$;

DROP TABLE IF EXISTS pg_temp.prj_g_j12_inventory;
CREATE TEMP TABLE prj_g_j12_inventory AS
WITH
-- MON-12, read ONCE each (never re-normalised per quote): every do-not-use
-- registry row's name key per org — the gate's no-link rule — and every
-- exact (case-insensitive) name per org with how many rows carry it — the
-- binding. Each quote's name is normalised once and looked up in the keys
-- (an IN list, which the server hashes once), and its exact name is joined
-- to the names.
prj_g_j12_dnu_keys AS MATERIALIZED (
  SELECT DISTINCT c.org_id, pg_temp.prj_g_j12_name_key(c.name) AS k
    FROM companies c
   WHERE c.status = 'do_not_use' AND pg_temp.prj_g_j12_name_key(c.name) <> ''
),
prj_g_j12_exact_names AS MATERIALIZED (
  SELECT c.org_id, lower(c.name) AS n, COUNT(*) AS hits, min(c.status) AS status
    FROM companies c
   GROUP BY c.org_id, lower(c.name)
),
prj_g_j12_quotes AS MATERIALIZED (
  -- As the rail judges a quote (section 1, cost_doc_company_barred): a link
  -- that stands decides — the document's own (read through to_jsonb — a
  -- database without 20261096's column still runs), then its contractor's,
  -- each only to a company of the document's org; with no link standing, a
  -- do-not-use row of the org whose name normalises as the vendor name
  -- does, else the company it binds to by one exact name (its own flag).
  SELECT d.status AS doc_status,
         COALESCE(
           (SELECT c.status FROM companies c
             WHERE c.id = NULLIF(to_jsonb(d) ->> 'company_id', '')::uuid AND c.org_id = d.org_id),
           (SELECT c.status FROM project_parties pp JOIN companies c ON c.id = pp.company_id AND c.org_id = d.org_id
             WHERE pp.id = d.party_id),
           CASE WHEN (d.org_id, pg_temp.prj_g_j12_name_key(d.vendor_name)) IN (SELECT f.org_id, f.k FROM prj_g_j12_dnu_keys f)
                THEN 'do_not_use' END,
           CASE WHEN x.hits = 1 THEN x.status END) AS status
    FROM cost_documents d
    LEFT JOIN prj_g_j12_exact_names x ON x.org_id = d.org_id AND x.n = lower(btrim(d.vendor_name)) AND btrim(d.vendor_name) <> ''
   WHERE d.kind = 'quote' AND d.status IN ('draft', 'parsed', 'awarded')
)
SELECT 'inventory (MON-12): open quotes (draft / parsed) that answer for a do-not-use or inactive company — the document''s own link, else its contractor''s, else ANY do-not-use row its vendor name normalises to, else the company it binds to by one exact name (an award now needs the typed override, through award_quote; a direct status write is refused)' AS inventory, COUNT(*)::text AS n
  FROM prj_g_j12_quotes
 WHERE doc_status IN ('draft', 'parsed') AND status IN ('do_not_use', 'inactive')
UNION ALL
SELECT 'inventory (MON-12): awarded quotes that answer (judged the same way) for a do-not-use or inactive company (kept as they are — the rail binds the next award)', COUNT(*)::text
  FROM prj_g_j12_quotes
 WHERE doc_status = 'awarded' AND status IN ('do_not_use', 'inactive')
UNION ALL
SELECT 'inventory (GAP-406): awarded / posted documents with no linked cost entry (the repair backlog — Repair on the Costs tab; this migration prevents new ones)', COUNT(*)::text
  FROM cost_documents d
 WHERE d.status IN ('awarded', 'posted')
   AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id)
UNION ALL
SELECT 'inventory (MON-13): contractors with a Known Company link (now set once — never re-pointed or cleared by a signed-in caller)', COUNT(*)::text
  FROM project_parties WHERE company_id IS NOT NULL
UNION ALL
SELECT 'inventory (MON-13): decided turnover items (accepted / waived / rejected) with a contractor (now kept as recorded)', COUNT(*)::text
  FROM turnover_items WHERE status IN ('accepted', 'waived', 'rejected') AND party_id IS NOT NULL
UNION ALL
SELECT 'inventory (MON-13): rejected turnover items with no contractor (cannot be named until the resubmission is accepted)', COUNT(*)::text
  FROM turnover_items WHERE status = 'rejected' AND party_id IS NULL
UNION ALL
SELECT 'inventory (MON-13): decided punch items (done / void) with a contractor (now kept as recorded)', COUNT(*)::text
  FROM punch_items WHERE status IN ('done', 'void') AND party_id IS NOT NULL
UNION ALL
SELECT 'inventory: other BEFORE UPDATE row triggers on cost_documents / project_parties / turnover_items / punch_items (they run beside these rails)', COUNT(*)::text
  FROM pg_trigger t
 WHERE NOT t.tgisinternal
   AND t.tgrelid IN ('public.cost_documents'::regclass, 'public.project_parties'::regclass, 'public.turnover_items'::regclass, 'public.punch_items'::regclass)
   AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
   AND t.tgname NOT IN ('trg_cost_documents_award_registry', 'trg_project_parties_company_link',
                        'trg_turnover_items_contractor_fixed', 'trg_punch_items_contractor_fixed')
UNION ALL
SELECT 'inventory (SEC-21): MILESTONE_* audit rows not typed project whose milestone belongs to a PRIVATE project (now readable only by those who can see it, and the audit roles)', COUNT(*)::text
  FROM audit_logs a
  JOIN milestones m ON m.id::text = a.details ->> 'milestoneId'
  JOIN projects p ON p.id = m.project_id
 WHERE left(a.action, 10) = 'MILESTONE_' AND COALESCE(a.resource_type, '') <> 'project' AND p.visibility = 'private'
UNION ALL
SELECT 'inventory (SEC-21): MILESTONE_* audit rows typed document (or untyped) whose milestone no longer exists (now readable only by the audit roles — its project can no longer be traced)', COUNT(*)::text
  FROM audit_logs a
 WHERE left(a.action, 10) = 'MILESTONE_' AND COALESCE(a.resource_type, '') NOT IN ('project', 'milestone')
   AND NOT EXISTS (SELECT 1 FROM milestones m WHERE m.id::text = a.details ->> 'milestoneId')
UNION ALL
SELECT 'inventory (SEC-21): MILESTONE_* audit rows typed milestone (org-level) whose milestone no longer exists (stay readable by every member, as before)', COUNT(*)::text
  FROM audit_logs a
 WHERE left(a.action, 10) = 'MILESTONE_' AND a.resource_type = 'milestone'
   AND NOT EXISTS (SELECT 1 FROM milestones m WHERE m.id::text = a.details ->> 'milestoneId')
UNION ALL
SELECT 'inventory (SEC-21): MILESTONE_* audit rows typed document (or untyped) with no details.projectId whose milestone is on a NON-private project (readable as now; if that milestone is later deleted they become the audit roles'' only — rows written from now on carry the project, section 9)', COUNT(*)::text
  FROM audit_logs a
  JOIN milestones m ON m.id::text = a.details ->> 'milestoneId'
  JOIN projects p ON p.id = m.project_id
 WHERE left(a.action, 10) = 'MILESTONE_' AND COALESCE(a.resource_type, '') NOT IN ('project', 'milestone')
   AND COALESCE(a.details ->> 'projectId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND p.visibility IS DISTINCT FROM 'private'
UNION ALL
SELECT 'inventory (SEC-21): MILESTONE_* audit rows typed document (or untyped) with no details.projectId and no org-level marker whose milestone is on NO project (org-level — readable as now; if that milestone is later deleted they become the audit roles'' only — rows written from now on carry the org-level marker, section 9)', COUNT(*)::text
  FROM audit_logs a
  JOIN milestones m ON m.id::text = a.details ->> 'milestoneId'
 WHERE left(a.action, 10) = 'MILESTONE_' AND COALESCE(a.resource_type, '') NOT IN ('project', 'milestone')
   AND COALESCE(a.details ->> 'projectId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND NOT COALESCE(a.details @> '{"projectIdFrom": "milestone", "orgLevel": true}'::jsonb, false)
   AND m.project_id IS NULL
UNION ALL
SELECT 'inventory (SEC-21): intake-link audit rows (project_intake_link) and INTAKE_* rows naming a PRIVATE project (now readable only by those who can see it, and the audit roles)', COUNT(*)::text
  FROM audit_logs a
  JOIN projects p ON p.id::text = COALESCE(a.details ->> 'projectId',
                                           (SELECT l.project_id::text FROM project_intake_links l WHERE l.id::text = a.resource_id))
 WHERE (a.resource_type = 'project_intake_link' OR left(a.action, 7) = 'INTAKE_') AND p.visibility = 'private'
UNION ALL
SELECT 'inventory (SEC-21): intake-link audit rows (project_intake_link) with no details.projectId (now readable only by those who may read the link — controllers and the project owner — and the audit roles)', COUNT(*)::text
  FROM audit_logs a
 WHERE a.resource_type = 'project_intake_link'
   AND COALESCE(a.details ->> 'projectId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
UNION ALL
SELECT 'inventory (SEC-21): intake-link and INTAKE_* audit rows whose named project no longer exists, or link rows with no project named whose link no longer exists (now readable only by the audit roles)', COUNT(*)::text
  FROM audit_logs a
 WHERE (a.resource_type = 'project_intake_link' OR left(a.action, 7) = 'INTAKE_')
   AND CASE
         WHEN COALESCE(a.details ->> 'projectId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN NOT EXISTS (SELECT 1 FROM projects p WHERE p.id::text = lower(a.details ->> 'projectId'))
         WHEN a.resource_type = 'project_intake_link'
           THEN NOT EXISTS (SELECT 1 FROM project_intake_links l WHERE l.id::text = lower(a.resource_id))
         ELSE false
       END
UNION ALL
SELECT 'inventory (SAF-9): contractor outcome notice rows already on the trail (CLAIMED / FAILED / NOTIFIED — from now on only the notice route, the service role, writes them; a signed-in insert is refused, section 8)', COUNT(*)::text
  FROM audit_logs a
 WHERE a.action IN ('INTAKE_OUTCOME_NOTICE_CLAIMED', 'INTAKE_OUTCOME_NOTICE_FAILED', 'INTAKE_OUTCOME_NOTIFIED')
UNION ALL
SELECT 'inventory (SEC-21 / SAF-9): other BEFORE INSERT row triggers on audit_logs (they run beside the section 8 and section 9 triggers)', COUNT(*)::text
  FROM pg_trigger t
 WHERE NOT t.tgisinternal
   AND t.tgrelid = 'public.audit_logs'::regclass
   AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4
   AND t.tgname NOT IN ('trg_audit_logs_milestone_project', 'trg_audit_logs_intake_outcome_notice');

BEGIN;

-- ── 1. the company behind a cost document (MON-12 / GAP-406) ─────────────
-- The BINDING (lib/costDocs.ts companyBehind's `company`, in SQL — what an
-- award records): the document's own registry link, then its contractor's,
-- then one exact case-insensitive name in the org. The GATE — the company
-- an award must answer for — is cost_doc_company_barred, below. A
-- link counts only to a company of the document's own org — called by the
-- rail it reads as the owner, past every org's RLS, so a link re-pointed at
-- another org's company never stands in for this org's registry.
-- SECURITY INVOKER: called by award_quote it reads what the caller may
-- read; called by the rail (a definer) it reads as the owner.
CREATE OR REPLACE FUNCTION public.cost_doc_company_behind(p_org uuid, p_company uuid, p_party uuid, p_vendor text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_party_company uuid;
  v_n integer;
BEGIN
  IF p_company IS NOT NULL THEN
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
      FROM companies c WHERE c.id = p_company AND c.org_id = p_org;
    IF v_row IS NOT NULL THEN RETURN v_row; END IF;
  END IF;
  IF p_party IS NOT NULL THEN
    SELECT pp.company_id INTO v_party_company FROM project_parties pp WHERE pp.id = p_party;
    IF v_party_company IS NOT NULL THEN
      SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
        FROM companies c WHERE c.id = v_party_company AND c.org_id = p_org;
      IF v_row IS NOT NULL THEN RETURN v_row; END IF;
    END IF;
  END IF;
  IF NULLIF(btrim(COALESCE(p_vendor, '')), '') IS NULL THEN RETURN NULL; END IF;
  SELECT COUNT(*) INTO v_n FROM companies c
   WHERE c.org_id = p_org AND lower(c.name) = lower(btrim(p_vendor));
  IF v_n <> 1 THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
    FROM companies c WHERE c.org_id = p_org AND lower(c.name) = lower(btrim(p_vendor));
  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) IS
  'MON-12 (20261157): the Known Company behind a cost document — its own registry link, then its contractor''s, then one exact case-insensitive name in the org (lib/costDocs.ts companyBehind). SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) TO authenticated, service_role;

-- A company name as a matching KEY — lib/bidTab.ts normalizeCompanyName, in
-- SQL ("Gulf Mechanical, Inc." and "gulf  mechanical inc" are both
-- "gulf mechanical"). For GATING only: a key never binds a bid to a row.
-- ASCII names give the TypeScript's answer exactly (the shape test pins the
-- steps and the suffix list); a letter outside a-z is a break in both.
CREATE OR REPLACE FUNCTION public.company_name_key(p_name text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  -- lib/bidTab.ts LEGAL_SUFFIXES, in its order (the shape test pins it).
  v_suffixes CONSTANT text[] := ARRAY['inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'gmbh', 'plc',
                                      'lp', 'llp', 'pty', 'sa', 'ag', 'bv', 'nv', 'srl', 'sarl', 'pte', 'pllc', 'pc'];
  v_tokens text[];
BEGIN
  -- lower-case; '&' reads as 'and'; anything but a-z, 0-9 and space is a
  -- break; split on the breaks (empty pieces dropped).
  v_tokens := array_remove(regexp_split_to_array(
                regexp_replace(replace(lower(COALESCE(p_name, '')), '&', ' and '), '[^a-z0-9 ]+', ' ', 'g'), ' +'), '');
  -- trailing legal suffixes go, never the last word;
  WHILE cardinality(v_tokens) > 1 AND v_tokens[cardinality(v_tokens)] = ANY (v_suffixes) LOOP
    v_tokens := v_tokens[1:cardinality(v_tokens) - 1];
  END LOOP;
  -- then a leading 'the', never the only word.
  IF cardinality(v_tokens) > 1 AND v_tokens[1] = 'the' THEN
    v_tokens := v_tokens[2:cardinality(v_tokens)];
  END IF;
  RETURN array_to_string(v_tokens, ' ');
END;
$$;

COMMENT ON FUNCTION public.company_name_key(text) IS
  'MON-12 (20261157): a company name as a matching key — lib/bidTab.ts normalizeCompanyName (lower-case, & as and, punctuation and whitespace as breaks, trailing legal suffixes and a leading the dropped, never the last word). For the do-not-use gate, never for binding.';

REVOKE ALL ON FUNCTION public.company_name_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_name_key(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.company_name_key(text) TO authenticated, service_role;

-- The company an award must ANSWER FOR — the do-not-use gate (lib/bidTab.ts
-- barredCompanyFor, lib/costDocs.ts companyBehind's `barred`; DEC-48:
-- binding refuses ambiguity, gating does not). A link that stands decides,
-- flagged or not: the document's own, else its contractor's, each only to a
-- company of the document's org. With no link standing, ANY do_not_use row
-- of the org whose name normalises as the vendor name does (DEC-48's gate
-- flags do-not-use look-alikes only — the exact name first, so the refusal
-- names the company the quote binds to when that one is barred); else the
-- company it binds to by one exact name (cost_doc_company_behind), when
-- that one is itself inactive — an inactive look-alike it does not bind to
-- is not the bid's. Returns the flagged company, or NULL when the award
-- needs no override. SECURITY INVOKER, as cost_doc_company_behind.
CREATE OR REPLACE FUNCTION public.cost_doc_company_barred(p_org uuid, p_company uuid, p_party uuid, p_vendor text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_party_company uuid;
  v_key text;
BEGIN
  IF p_company IS NOT NULL THEN
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
      FROM companies c WHERE c.id = p_company AND c.org_id = p_org;
    IF v_row IS NOT NULL THEN
      RETURN CASE WHEN v_row ->> 'status' IN ('do_not_use', 'inactive') THEN v_row END;
    END IF;
  END IF;
  IF p_party IS NOT NULL THEN
    SELECT pp.company_id INTO v_party_company FROM project_parties pp WHERE pp.id = p_party;
    IF v_party_company IS NOT NULL THEN
      SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
        FROM companies c WHERE c.id = v_party_company AND c.org_id = p_org;
      IF v_row IS NOT NULL THEN
        RETURN CASE WHEN v_row ->> 'status' IN ('do_not_use', 'inactive') THEN v_row END;
      END IF;
    END IF;
  END IF;
  v_key := company_name_key(p_vendor);
  IF v_key <> '' THEN
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
      FROM companies c
     WHERE c.org_id = p_org AND c.status = 'do_not_use'
       AND company_name_key(c.name) = v_key
     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, c.name, c.id
     LIMIT 1;
    IF v_row IS NOT NULL THEN RETURN v_row; END IF;
  END IF;
  -- No do-not-use look-alike: the company the quote binds to answers for its own flag.
  v_row := cost_doc_company_behind(p_org, NULL, NULL, p_vendor);
  RETURN CASE WHEN v_row ->> 'status' IN ('do_not_use', 'inactive') THEN v_row END;
END;
$$;

COMMENT ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) IS
  'MON-12 (20261157): the do-not-use / inactive company a cost document''s award must answer for — its own registry link, else its contractor''s (a standing link decides, flagged or not), else ANY do_not_use registry row of the org its vendor name normalises to (company_name_key; DEC-48), else the company it binds to by one exact name when that one is flagged; NULL when no override is needed. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ── 2. MON-12: a do-not-use / inactive company is never awarded without the override ──
CREATE OR REPLACE FUNCTION public.enforce_cost_document_award_registry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass: restores, server routes, the SQL editor
  IF NEW.status IS DISTINCT FROM 'awarded' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'awarded' THEN RETURN NEW; END IF;   -- no move to awarded
  -- The award is judged by the company behind the row AS IT STANDS: the one
  -- write that awards it never also moves the link, the contractor or the
  -- vendor name it is judged by (award_quote and the app's claim change
  -- status and its stamps only).
  IF TG_OP = 'UPDATE' AND (NEW.party_id IS DISTINCT FROM OLD.party_id
                           OR NEW.vendor_name IS DISTINCT FROM OLD.vendor_name
                           OR (to_jsonb(NEW) ->> 'company_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'company_id')) THEN
    RAISE EXCEPTION 'An award never changes the company link, the contractor or the vendor name it is judged by in the same write — award the quote as it stands; nothing was changed. (MON-12, 20261157)'
      USING ERRCODE = 'check_violation';
  END IF;
  v_company := cost_doc_company_barred(NEW.org_id, NULLIF(to_jsonb(NEW) ->> 'company_id', '')::uuid, NEW.party_id, NEW.vendor_name);
  IF v_company IS NOT NULL AND v_company ->> 'status' IN ('do_not_use', 'inactive')
     AND COALESCE(current_setting('app.cost_doc_award_override', true), '') IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION '% is flagged % in the company registry — awarding it needs an explicit override with a reason, recorded on the audit trail (Award on the Costs tab asks for one); nothing was changed. (MON-12, 20261157)',
      v_company ->> 'name', CASE v_company ->> 'status' WHEN 'do_not_use' THEN 'DO NOT USE' ELSE 'inactive' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_cost_document_award_registry() IS
  'MON-12 (20261157): a signed-in move of a quote to awarded is refused while the company it answers for (cost_doc_company_barred, read as the definer: its standing link, else ANY do_not_use registry row its vendor name normalises to, else the company it binds to by one exact name) is do_not_use or inactive, unless award_quote set app.cost_doc_award_override to the document id after a typed reason. The service role passes.';

REVOKE ALL ON FUNCTION public.enforce_cost_document_award_registry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_cost_document_award_registry() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_cost_document_award_registry() FROM authenticated;

DROP TRIGGER IF EXISTS trg_cost_documents_award_registry ON cost_documents;
CREATE TRIGGER trg_cost_documents_award_registry
  BEFORE INSERT OR UPDATE OF status ON cost_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cost_document_award_registry();

-- ── 3. GAP-406: the award as one transaction ─────────────────────────────
CREATE OR REPLACE FUNCTION public.award_quote(
  p_doc uuid,
  p_cost_account uuid,
  p_expected_total numeric,
  p_override_reason text DEFAULT NULL,
  p_confirmed_total numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := NULLIF(auth.jwt() ->> 'email', '');
  v_doc record;
  v_raw jsonb;
  v_account record;
  v_doc_currency text;
  v_account_currency text;
  v_extracted numeric;
  v_total numeric;
  v_pages_read numeric;
  v_pages_total numeric;
  v_company jsonb;
  v_barred jsonb;
  v_flagged boolean := false;
  v_override text := NULLIF(btrim(COALESCE(p_override_reason, '')), '');
  v_claimed integer;
  v_entry uuid;
  v_reference text;
  v_description text;
  v_key text;
  v_rival_ids uuid[] := '{}';
  v_rival_names jsonb := '[]'::jsonb;
  v_declined integer := 0;
  v_ungrouped jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to award a quote; nothing was changed. (GAP-406, 20261157)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The quote, locked for this award (RLS: only a caller who may update it
  -- finds it).
  SELECT * INTO v_doc FROM cost_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  v_raw := to_jsonb(v_doc);
  IF v_doc.kind IS DISTINCT FROM 'quote' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_quote'); END IF;
  IF v_doc.status NOT IN ('draft', 'parsed') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'status', 'status', v_doc.status);
  END IF;

  -- The budget line: this project's, in the document's currency (COST-8 —
  -- lib/costDocs.ts normalizeCurrency; an account with no currency is USD).
  SELECT a.id, a.project_id, a.currency INTO v_account FROM cost_accounts a WHERE a.id = p_cost_account;
  IF NOT FOUND OR v_account.project_id IS DISTINCT FROM v_doc.project_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'account');
  END IF;
  v_doc_currency := upper(regexp_replace(COALESCE(v_doc.currency, ''), '\s+', '', 'g'));
  v_doc_currency := CASE WHEN v_doc_currency IN ('$', 'US$', 'USD$', '$US') THEN 'USD'
                         WHEN v_doc_currency ~ '^[A-Z]{3}$' THEN v_doc_currency END;
  v_account_currency := upper(regexp_replace(COALESCE(v_account.currency, ''), '\s+', '', 'g'));
  v_account_currency := COALESCE(CASE WHEN v_account_currency IN ('$', 'US$', 'USD$', '$US') THEN 'USD'
                                      WHEN v_account_currency ~ '^[A-Z]{3}$' THEN v_account_currency END, 'USD');
  IF v_doc_currency IS NOT NULL AND v_doc_currency <> v_account_currency THEN
    RETURN jsonb_build_object('ok', false, 'code', 'currency', 'docCurrency', v_doc_currency, 'accountCurrency', v_account_currency);
  END IF;

  -- The total that posts: the row's (AI-written or typed), else the
  -- extraction's — and it must be the one the caller checked.
  v_extracted := CASE WHEN jsonb_typeof(v_doc.parsed -> 'total') = 'number' AND (v_doc.parsed ->> 'total')::numeric > 0
                      THEN (v_doc.parsed ->> 'total')::numeric END;
  v_total := COALESCE(v_doc.total_amount, v_extracted);
  IF v_total IS NULL OR v_total <= 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'no_total'); END IF;
  IF p_expected_total IS NULL OR v_total <> p_expected_total THEN
    RETURN jsonb_build_object('ok', false, 'code', 'total_changed', 'total', v_total);
  END IF;

  -- The registry (MON-12): the company the quote binds to is what the award
  -- records; the company it answers for (a standing link, else ANY
  -- do-not-use row its vendor name normalises to, else the bound company's
  -- own flag — the rail's own rule) needs the typed reason.
  v_company := cost_doc_company_behind(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);
  v_barred := cost_doc_company_barred(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);
  v_flagged := v_barred IS NOT NULL AND v_barred ->> 'status' IN ('do_not_use', 'inactive');
  IF v_flagged AND v_override IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'company_flagged', 'company', v_barred);
  END IF;

  -- The read extent (COST-13 — lib/costDocs.ts extentRefusal): a figure the
  -- caller says was typed from the paper must be the total, in whole units;
  -- an AI-read total from a truncated read, or one of unknown extent once
  -- 20261096 records the extent, posts only with that figure. So the
  -- award's record never claims a confirmation that did not happen.
  IF p_confirmed_total IS NOT NULL AND round(p_confirmed_total) <> round(v_total) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'confirm_mismatch', 'total', v_total, 'confirmed', p_confirmed_total);
  END IF;
  IF p_confirmed_total IS NULL AND v_extracted IS NOT NULL AND (v_raw ? 'pages_read' OR v_raw ? 'pages_total') THEN
    v_pages_read := CASE WHEN jsonb_typeof(v_raw -> 'pages_read') = 'number' THEN (v_raw ->> 'pages_read')::numeric END;
    v_pages_total := CASE WHEN jsonb_typeof(v_raw -> 'pages_total') = 'number' THEN (v_raw ->> 'pages_total')::numeric END;
    IF v_pages_read IS NULL OR v_pages_total IS NULL OR v_pages_read < v_pages_total THEN
      RETURN jsonb_build_object('ok', false, 'code', 'extent', 'total', v_total, 'pagesRead', v_pages_read, 'pagesTotal', v_pages_total);
    END IF;
  END IF;

  -- 1. The claim. The registry rail reads the override for this document only.
  IF v_flagged THEN PERFORM set_config('app.cost_doc_award_override', p_doc::text, true); END IF;
  UPDATE cost_documents SET status = 'awarded', posted_at = now(), posted_by = v_uid
   WHERE id = p_doc AND status IN ('draft', 'parsed');
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  PERFORM set_config('app.cost_doc_award_override', '', true);
  IF v_claimed = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'refused'); END IF;

  -- From here every failure RAISES: the award rolls back whole.
  -- 2. The commitment — lib/costs.ts addEntry's row and its audit row.
  v_reference := NULLIF(btrim(COALESCE(v_doc.doc_number, v_doc.file_name, '')), '');
  v_description := btrim('Award — ' || COALESCE(v_doc.vendor_name, 'vendor')
    || CASE WHEN COALESCE(v_doc.rfq_group, '') <> '' THEN ' (' || v_doc.rfq_group || ')' ELSE '' END);
  INSERT INTO cost_entries (org_id, project_id, cost_account_id, party_id, entry_type, amount, entry_date,
                            description, reference, source_document_id, status, created_by, created_by_name)
  VALUES (v_doc.org_id, v_doc.project_id, p_cost_account, v_doc.party_id, 'commitment', v_total,
          (now() AT TIME ZONE 'UTC')::date, v_description, v_reference, p_doc, 'posted', v_uid,
          NULLIF(split_part(COALESCE(v_email, ''), '@', 1), ''))
  RETURNING id INTO v_entry;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('COST_ENTRY_POSTED', 'cost', v_entry::text, v_doc.org_id, v_uid, v_email,
          jsonb_build_object('accountId', p_cost_account, 'type', 'commitment', 'amount', v_total,
                             'reference', v_reference, 'sourceDocumentId', p_doc));

  -- 3. The override, on the record by the id of the company it overrode.
  IF v_flagged THEN
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
    VALUES ('COST_DOC_AWARD_OVERRIDE', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,
            jsonb_build_object('companyId', v_barred ->> 'id', 'companyName', v_barred ->> 'name',
                               'companyStatus', v_barred ->> 'status', 'reason', v_override));
  END IF;

  -- 4. The rivals: every still-open quote of the same RFQ group (by key)
  --    becomes "not selected". An ungrouped award declines nothing; the open
  --    ungrouped quotes are named back to the caller.
  v_key := lower(btrim(regexp_replace(COALESCE(v_doc.rfq_group, ''), '\s+', ' ', 'g')));
  IF v_key <> '' THEN
    SELECT COALESCE(array_agg(c.id ORDER BY c.created_at, c.id), '{}'),
           COALESCE(jsonb_agg(COALESCE(c.vendor_name, c.id::text) ORDER BY c.created_at, c.id), '[]'::jsonb)
      INTO v_rival_ids, v_rival_names
      FROM cost_documents c
     WHERE c.project_id = v_doc.project_id AND c.id <> p_doc AND c.kind = 'quote'
       AND c.status IN ('draft', 'parsed')
       AND lower(btrim(regexp_replace(COALESCE(c.rfq_group, ''), '\s+', ' ', 'g'))) = v_key;
    IF cardinality(v_rival_ids) > 0 THEN
      UPDATE cost_documents SET status = 'declined'
       WHERE id = ANY (v_rival_ids) AND status IN ('draft', 'parsed');
      GET DIAGNOSTICS v_declined = ROW_COUNT;
    END IF;
  ELSE
    SELECT COALESCE(jsonb_agg(COALESCE(c.vendor_name, c.file_name, 'quote') ORDER BY c.created_at, c.id), '[]'::jsonb)
      INTO v_ungrouped
      FROM cost_documents c
     WHERE c.project_id = v_doc.project_id AND c.id <> p_doc AND c.kind = 'quote'
       AND c.status IN ('draft', 'parsed')
       AND lower(btrim(regexp_replace(COALESCE(c.rfq_group, ''), '\s+', ' ', 'g'))) = '';
  END IF;

  -- 5. The award, on the record.
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('COST_DOC_AWARDED', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,
          jsonb_build_object(
            'vendor', v_doc.vendor_name, 'total', v_total, 'rfqGroup', v_doc.rfq_group,
            'rivalsConsidered', v_rival_names, 'rivalsDeclined', v_declined,
            'ungroupedLeftOpen', jsonb_array_length(v_ungrouped),
            'costAccountId', p_cost_account, 'postedEntryId', v_entry,
            'companyId', v_company ->> 'id', 'override', CASE WHEN v_flagged THEN v_override END,
            'pagesRead', v_raw -> 'pages_read', 'pagesTotal', v_raw -> 'pages_total',
            'totalConfirmed', p_confirmed_total IS NOT NULL, 'oneTransaction', true));

  RETURN jsonb_build_object(
    'ok', true, 'entryId', v_entry, 'total', v_total,
    'rivals', cardinality(v_rival_ids), 'declined', v_declined, 'ungroupedOpen', v_ungrouped,
    'company', v_company, 'override', v_flagged);
END;
$$;

COMMENT ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) IS
  'GAP-406 (20261157): claim + commitment + override record + rival decline + COST_DOC_AWARDED in ONE transaction, under the caller''s own RLS and rails (SECURITY INVOKER). Re-checked under the lock first: status, budget line, currency, the total the caller checked, the registry gate (cost_doc_company_barred) and COST-13''s confirmed figure and read extent. A refusal before the claim returns {ok:false, code} and writes nothing; any failure after it raises and rolls the award back. NULL auth.uid() refused.';

REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) TO authenticated;

-- ── 4. PERF-7: the machine writes to a checklist's items in one request ──
-- ONE guarded statement for the whole call — one sub-transaction, so one
-- transaction id however many rows land. Only when that statement is refused
-- (a 20261091 rail judged one row, or a malformed timestamp) is the call
-- judged row by row, each row in its own sub-transaction so one refusal never
-- undoes the rest — and only for a call of at most 50 writes: every landed
-- row's sub-transaction keeps its transaction id until the call commits, and
-- past PostgreSQL's 64-entry per-session cache every other session's
-- snapshot would have to consult pg_subtrans while the call runs. A larger
-- refused call answers {split: 50} having applied nothing, and the lib
-- (lib/checklists.ts writeItemPatches) re-sends its writes in calls of 50.
CREATE OR REPLACE FUNCTION public.apply_checklist_item_writes(p_checklist uuid, p_writes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_write jsonb;
  v_id uuid;
  v_hit uuid;
  v_name text;
  v_valid jsonb;
  v_dupes boolean;
  v_landed jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to change checklist items; nothing was changed. (PERF-7, 20261157)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_writes IS NULL OR jsonb_typeof(p_writes) <> 'array' OR jsonb_array_length(p_writes) > 2000 THEN
    RAISE EXCEPTION 'apply_checklist_item_writes takes an array of at most 2000 item writes; nothing was changed.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Every write is checked up front: an item id, and one of the two machine
  -- names. One that fails is answered as failed and never written.
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.n) FILTER (
           WHERE COALESCE(e.value ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND COALESCE(e.value ->> 'updated_by_name', '') IN ('evidence sweep', 'AI assessment')), '[]'::jsonb),
         COALESCE(jsonb_agg(CASE
           WHEN COALESCE(e.value ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN jsonb_build_object('id', e.value ->> 'id', 'code', '22P02',
                    'message', 'Not a checklist item id; nothing was changed.')
           ELSE jsonb_build_object('id', e.value ->> 'id', 'code', '23514',
                    'message', 'Only the evidence sweep and the AI assessment write through this call — a person''s decision is its own write; nothing was changed.')
           END ORDER BY e.n) FILTER (
           WHERE NOT (COALESCE(e.value ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      AND COALESCE(e.value ->> 'updated_by_name', '') IN ('evidence sweep', 'AI assessment'))), '[]'::jsonb)
    INTO v_valid, v_failed
    FROM jsonb_array_elements(p_writes) WITH ORDINALITY AS e(value, n);
  SELECT COUNT(*) <> COUNT(DISTINCT lower(e.value ->> 'id')) INTO v_dupes FROM jsonb_array_elements(v_valid) e;

  -- 1. The whole call in ONE guarded statement (two writes to one item are
  --    judged row by row: the first lands, the second meets its guard).
  IF NOT v_dupes AND jsonb_array_length(v_valid) > 0 THEN
    BEGIN
      WITH w AS (
        SELECT (e.value ->> 'id')::uuid AS id, e.value AS v FROM jsonb_array_elements(v_valid) e
      ), hit AS (
        UPDATE checklist_items ci SET
          status = CASE WHEN w.v ? 'status' THEN w.v ->> 'status' ELSE ci.status END,
          applicability = CASE WHEN w.v ? 'applicability' THEN w.v ->> 'applicability' ELSE ci.applicability END,
          ai_rationale = CASE WHEN w.v ? 'ai_rationale' THEN w.v ->> 'ai_rationale' ELSE ci.ai_rationale END,
          evidence = CASE WHEN w.v ? 'evidence' THEN w.v -> 'evidence' ELSE ci.evidence END,
          updated_at = now(),
          updated_by = NULL,
          updated_by_name = w.v ->> 'updated_by_name'
          FROM w
         WHERE ci.id = w.id
           AND ci.checklist_id = p_checklist
           AND ci.updated_at IS NOT DISTINCT FROM NULLIF(w.v ->> 'expected_updated_at', '')::timestamptz
        RETURNING ci.id
      )
      SELECT COALESCE(jsonb_agg(w.v ->> 'id') FILTER (WHERE hit.id IS NOT NULL), '[]'::jsonb),
             COALESCE(jsonb_agg(w.v ->> 'id') FILTER (WHERE hit.id IS NULL), '[]'::jsonb)
        INTO v_landed, v_refused
        FROM w LEFT JOIN hit ON hit.id = w.id;
      RETURN jsonb_build_object('landed', v_landed, 'refused', v_refused, 'failed', v_failed);
    EXCEPTION WHEN OTHERS THEN
      v_landed := '[]'::jsonb;                                -- refused whole: nothing of it stands
      v_refused := '[]'::jsonb;
    END;
  END IF;

  -- 2. Row by row — at most 50 writes in one call (see above).
  IF jsonb_array_length(v_valid) > 50 THEN
    RETURN jsonb_build_object('landed', '[]'::jsonb, 'refused', '[]'::jsonb, 'failed', '[]'::jsonb, 'split', 50);
  END IF;
  FOR v_write IN SELECT value FROM jsonb_array_elements(v_valid) LOOP
    v_id := NULL;
    v_hit := NULL;
    BEGIN
      v_id := (v_write ->> 'id')::uuid;
      v_name := v_write ->> 'updated_by_name';
      UPDATE checklist_items ci SET
        status = CASE WHEN v_write ? 'status' THEN v_write ->> 'status' ELSE ci.status END,
        applicability = CASE WHEN v_write ? 'applicability' THEN v_write ->> 'applicability' ELSE ci.applicability END,
        ai_rationale = CASE WHEN v_write ? 'ai_rationale' THEN v_write ->> 'ai_rationale' ELSE ci.ai_rationale END,
        evidence = CASE WHEN v_write ? 'evidence' THEN v_write -> 'evidence' ELSE ci.evidence END,
        updated_at = now(),
        updated_by = NULL,
        updated_by_name = v_name
       WHERE ci.id = v_id
         AND ci.checklist_id = p_checklist
         AND ci.updated_at IS NOT DISTINCT FROM NULLIF(v_write ->> 'expected_updated_at', '')::timestamptz
      RETURNING ci.id INTO v_hit;
      IF v_hit IS NULL THEN
        v_refused := v_refused || jsonb_build_array(v_write ->> 'id');
      ELSE
        v_landed := v_landed || jsonb_build_array(v_write ->> 'id');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_array(jsonb_build_object(
        'id', v_write ->> 'id', 'code', SQLSTATE, 'message', SQLERRM));
    END;
  END LOOP;
  RETURN jsonb_build_object('landed', v_landed, 'refused', v_refused, 'failed', v_failed);
END;
$$;

COMMENT ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) IS
  'PERF-7 / DEC-52 item 10 (20261157): the evidence sweep''s and the AI assessment''s writes to one checklist''s items in ONE request — one guarded statement (updated_at as read, IS NOT DISTINCT FROM); a refused statement is judged row by row in sub-transactions for a call of at most 50 writes, else answered {split: 50} with nothing applied; returns {landed, refused, failed}. SECURITY INVOKER — RLS and every 20261091 rail apply per row. NULL auth.uid() refused.';

REVOKE ALL ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) TO authenticated;

-- ── 5. MON-13: the contractor-link and item-contractor rules ─────────────
CREATE OR REPLACE FUNCTION public.enforce_project_party_company_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass
  IF OLD.company_id IS NULL OR NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN RETURN NEW; END IF;
  -- The company's own delete: its FK ON DELETE SET NULL, one trigger level down.
  IF NEW.company_id IS NULL AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A contractor''s Known Company link is set once and never re-pointed or cleared — an award reads the company''s do-not-use flag through it; nothing was changed. (MON-13, 20261157)'
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION public.enforce_project_party_company_link() IS
  'MON-13 / DEC-76 item 3 (20261157): a signed-in caller never re-points or clears a contractor''s company link once it is set; the company''s delete (FK ON DELETE SET NULL, one trigger level down) and the service role pass.';

REVOKE ALL ON FUNCTION public.enforce_project_party_company_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_project_party_company_link() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_project_party_company_link() FROM authenticated;

DROP TRIGGER IF EXISTS trg_project_parties_company_link ON project_parties;
CREATE TRIGGER trg_project_parties_company_link
  BEFORE UPDATE OF company_id ON project_parties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_party_company_link();

CREATE OR REPLACE FUNCTION public.enforce_quality_item_contractor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_noun text := CASE TG_TABLE_NAME WHEN 'turnover_items' THEN 'turnover item' ELSE 'punch item' END;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass
  IF NEW.party_id IS NOT DISTINCT FROM OLD.party_id THEN RETURN NEW; END IF;
  -- The contractor's own delete: its FK ON DELETE SET NULL, one trigger level down.
  IF NEW.party_id IS NULL AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  -- Undecided: the contractor may be set and changed.
  IF (TG_TABLE_NAME = 'turnover_items' AND OLD.status IN ('open', 'received'))
     OR (TG_TABLE_NAME = 'punch_items' AND OLD.status = 'open') THEN
    RETURN NEW;
  END IF;
  IF OLD.party_id IS NOT NULL THEN
    RAISE EXCEPTION 'This % is decided (%) — its contractor stays as recorded; a standing decision never moves to another company''s record. Nothing was changed. (MON-13, 20261157)',
      v_noun, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'turnover_items' AND OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'A rejected turnover item''s contractor can''t be named — a rejection can''t be reopened, so a wrong name could never be corrected. Name the contractor once the resubmission is accepted; nothing was changed. (MON-13, 20261157)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;                                                 -- an unassigned decided item, named once
END;
$$;

COMMENT ON FUNCTION public.enforce_quality_item_contractor() IS
  'MON-13 / DEC-76 item 3 (20261157): a turnover or punch item''s contractor changes only while the item is undecided (turnover open / received; punch open); an unassigned decided item may be named once, never a rejected turnover item. The contractor''s delete (FK ON DELETE SET NULL, one trigger level down) and the service role pass.';

REVOKE ALL ON FUNCTION public.enforce_quality_item_contractor() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_quality_item_contractor() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_quality_item_contractor() FROM authenticated;

DROP TRIGGER IF EXISTS trg_turnover_items_contractor_fixed ON turnover_items;
CREATE TRIGGER trg_turnover_items_contractor_fixed
  BEFORE UPDATE OF party_id ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_quality_item_contractor();

DROP TRIGGER IF EXISTS trg_punch_items_contractor_fixed ON punch_items;
CREATE TRIGGER trg_punch_items_contractor_fixed
  BEFORE UPDATE OF party_id ON punch_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_quality_item_contractor();

-- ── 6. SEC-21: project audit rows written under another resource type ────
CREATE OR REPLACE FUNCTION public.audit_row_project_ref_visible(p_action text, p_type text, p_resource text, p_details jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    -- A row that names its project (the intake door's rows, the Intake and
    -- Costs tabs' link rows) follows that project.
    WHEN COALESCE(p_details ->> 'projectId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.project_visible_to_me((p_details ->> 'projectId')::uuid)
    -- An intake-link row names the link: the link's project.
    WHEN p_type = 'project_intake_link' THEN
      CASE WHEN COALESCE(p_resource, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
           ELSE EXISTS (SELECT 1 FROM public.project_intake_links l
                         WHERE l.id = p_resource::uuid AND public.project_visible_to_me(l.project_id)) END
    -- A milestone row names its milestone (details.milestoneId): the
    -- milestone's project; a milestone with no project is org-level. A
    -- project-typed milestone row is a project row (SEC-20's clause decides).
    -- A milestone the caller cannot find (deleted, or hidden from them): a
    -- row written as resource_type 'milestone' was written for a milestone
    -- on no project and no document (lib/milestones.ts pickResource) — an
    -- org-level row, readable as it was; so is a row section 9 marked
    -- org-level (its milestone was on no project when it was written — a
    -- document-scoped milestone's row); any other names no project it can
    -- still be traced to, and is the audit roles' only. (A row written after
    -- 20261157 names its project or carries the org-level marker — section
    -- 9 — the milestone deleted or not.)
    WHEN left(COALESCE(p_action, ''), 10) = 'MILESTONE_' THEN
      CASE WHEN p_type = 'project' THEN true
           WHEN COALESCE(p_details ->> 'milestoneId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                AND EXISTS (SELECT 1 FROM public.milestones m WHERE m.id = (p_details ->> 'milestoneId')::uuid)
             THEN EXISTS (SELECT 1 FROM public.milestones m
                           WHERE m.id = (p_details ->> 'milestoneId')::uuid
                             AND (m.project_id IS NULL OR public.project_visible_to_me(m.project_id)))
           WHEN p_type = 'milestone' THEN true
           WHEN p_details @> '{"projectIdFrom": "milestone", "orgLevel": true}'::jsonb THEN true
           ELSE false END
    -- Anything else (an INTAKE_ row that names no project): its own type's reach.
    ELSE true
  END;
$$;

COMMENT ON FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) IS
  'SEC-21 (20261157): may the caller read an audit row about a project written under another resource type? details.projectId → that project; a project_intake_link row → the link''s project; a MILESTONE_* row → its milestone''s project (no project = org-level; a gone or unreadable milestone → visible only when the row is typed milestone or carries section 9''s org-level marker, else not; a project-typed row → SEC-20 decides); else true. SECURITY INVOKER, no SET clause, names schema-qualified.';

REVOKE ALL ON FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) TO anon, authenticated, service_role;

-- ── 7. the audit trail overlay: 20261142's body + the SEC-21 clause ──────
DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;
CREATE POLICY audit_logs_admin_trail ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    org_capability_allows(org_id, 'admin.audit_view', auth.uid())
    OR NOT (
      COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
      OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
      OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
      OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%'
    )
    -- SEC-20 (20261142): a row about a project, a cost record or a quality
    -- sign-off is the project's — readable when the caller can see the
    -- project. AND binds tighter than OR: an audit viewer reads every row;
    -- anyone else reads a row that is not the org-level trail AND whose
    -- project they can see. The type test is inline: a row of any other
    -- type never calls the function.
    AND (COALESCE(resource_type, '') NOT IN ('project', 'cost', 'project_checklist', 'turnover_item')
         OR audit_row_project_visible(resource_type, resource_id))
    -- SEC-21 (20261157): a row about a project written under another type —
    -- an intake-link row, an INTAKE_ row, a MILESTONE_ row — follows the
    -- project it names. The kind test is inline: no other row calls the
    -- function.
    AND ((COALESCE(resource_type, '') <> 'project_intake_link'
          AND left(COALESCE(action, ''), 10) <> 'MILESTONE_'
          AND left(COALESCE(action, ''), 7) <> 'INTAKE_')
         OR audit_row_project_ref_visible(action, resource_type, resource_id, details))
  );

-- ── 8. SAF-9: one outcome notice per submission attempt ──────────────────
-- The route claims (org, version, attempt) with an INTAKE_OUTCOME_NOTICE_CLAIMED
-- row before it sends; a second claim of the same attempt is a unique
-- violation (23505) and sends nothing.
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_intake_outcome_notice_claim_uniq
  ON audit_logs (org_id, (details ->> 'versionId'), (details ->> 'attempt'))
  WHERE action = 'INTAKE_OUTCOME_NOTICE_CLAIMED';

-- The route decides "already sent" and "in progress" from these three rows,
-- and audit_logs_insert lets any active member insert any action in their
-- org: a forged NOTIFIED row would answer `already` for ever (the contractor
-- never told), a forged CLAIMED row would hold each attempt `in_progress`.
-- The route writes them as the service role (auth.uid() NULL), which
-- passes; a signed-in insert of one is refused. The trigger's WHEN clause
-- keeps every other audit row from calling it.
CREATE OR REPLACE FUNCTION public.enforce_intake_outcome_notice_server_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the notice route (the service role)
  RAISE EXCEPTION 'A contractor outcome notice''s audit row (%) is written only by the notice route; nothing was changed. (SAF-9, 20261157)', NEW.action
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION public.enforce_intake_outcome_notice_server_only() IS
  'SAF-9 (20261157): INTAKE_OUTCOME_NOTICE_CLAIMED / _FAILED and INTAKE_OUTCOME_NOTIFIED audit rows are written only by /api/intake/outcome-notice as the service role; a signed-in insert is refused, so no member can forge "already notified" or hold a notice "in progress".';

REVOKE ALL ON FUNCTION public.enforce_intake_outcome_notice_server_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_intake_outcome_notice_server_only() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_intake_outcome_notice_server_only() FROM authenticated;

DROP TRIGGER IF EXISTS trg_audit_logs_intake_outcome_notice ON audit_logs;
CREATE TRIGGER trg_audit_logs_intake_outcome_notice
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  WHEN (NEW.action IN ('INTAKE_OUTCOME_NOTICE_CLAIMED', 'INTAKE_OUTCOME_NOTICE_FAILED', 'INTAKE_OUTCOME_NOTIFIED'))
  EXECUTE FUNCTION public.enforce_intake_outcome_notice_server_only();

-- ── 9. SEC-21: a milestone's audit row carries its project ─────────────────
-- lib/milestones.ts logMilestoneEvent writes details.milestoneId but not the
-- project; once the milestone is deleted, section 6 could no longer trace a
-- document-typed row to it. This decides it as the row is written: the
-- milestone's own project — or, for a milestone on no project (a
-- document-scoped one), the org-level marker (projectIdFrom 'milestone',
-- orgLevel true, no projectId), which section 6 reads as org-level — or,
-- for MILESTONE_DELETED, written once the milestone is gone, what this
-- trigger stamped on the milestone's NEWEST earlier row (same org, same
-- resource: the resource_id index). Only rows this trigger stamped
-- (details.projectIdFrom = 'milestone') are trusted for that, and the
-- writer's projectId / projectIdFrom / orgLevel are replaced — section 6's
-- first branch trusts details.projectId, so a forged one on an earlier row
-- must never decide who reads a later row about a private project's
-- milestone. "Newest" is by "timestamp", which this trigger sets to the
-- server's clock on every signed-in milestone row (the column is the
-- writer's to set on insert): a far-future timestamp on a forged row never
-- chooses the project a deleted milestone's row follows. A project-typed
-- delete skips the read: SEC-20 decides a project row by its resource_id,
-- which is the project, and its resource_id is shared with every row of
-- the project. SECURITY DEFINER so the stamp is the milestone's true
-- project whatever the writer may read; nobody may call it.
CREATE OR REPLACE FUNCTION public.stamp_milestone_audit_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project uuid;
  v_org_level boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass: a restore keeps its rows as written
  IF left(COALESCE(NEW.action, ''), 10) <> 'MILESTONE_' THEN RETURN NEW; END IF;
  NEW."timestamp" := now();                                   -- the server's clock, never the writer's
  IF NEW.details IS NULL OR jsonb_typeof(NEW.details) <> 'object' THEN RETURN NEW; END IF;
  -- The writer's own stamp never stands.
  NEW.details := NEW.details - 'projectId' - 'projectIdFrom' - 'orgLevel';
  IF COALESCE(NEW.details ->> 'milestoneId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  SELECT m.project_id INTO v_project
    FROM milestones m
   WHERE m.id = (NEW.details ->> 'milestoneId')::uuid AND m.org_id = NEW.org_id;
  IF FOUND THEN
    v_org_level := v_project IS NULL;                         -- a milestone on no project: org-level
  ELSIF COALESCE(NEW.resource_type, '') <> 'project' THEN
    -- The milestone is gone (MILESTONE_DELETED): what this trigger stamped
    -- on its newest earlier row — a project, or the org-level marker.
    SELECT CASE WHEN COALESCE(a.details ->> 'projectId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (a.details ->> 'projectId')::uuid END,
           COALESCE(a.details @> '{"orgLevel": true}'::jsonb, false)
      INTO v_project, v_org_level
      FROM audit_logs a
     WHERE a.resource_id = NEW.resource_id
       AND a.org_id = NEW.org_id
       AND left(a.action, 10) = 'MILESTONE_'
       AND a.details ->> 'milestoneId' = NEW.details ->> 'milestoneId'
       AND a.details ->> 'projectIdFrom' = 'milestone'
       AND (COALESCE(a.details ->> 'projectId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR a.details @> '{"orgLevel": true}'::jsonb)
     ORDER BY a."timestamp" DESC NULLS LAST
     LIMIT 1;
  END IF;
  IF v_project IS NOT NULL THEN
    NEW.details := NEW.details || jsonb_build_object('projectId', v_project::text, 'projectIdFrom', 'milestone');
  ELSIF COALESCE(v_org_level, false) THEN
    NEW.details := NEW.details || jsonb_build_object('projectIdFrom', 'milestone', 'orgLevel', true);
  END IF;
  -- One whose milestone cannot be traced names none.
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.stamp_milestone_audit_project() IS
  'SEC-21 (20261157): a signed-in MILESTONE_* audit row gets details.projectId from the milestone''s project, or the org-level marker (projectIdFrom milestone, orgLevel true) for a milestone on no project, or — once the milestone is gone — what this trigger stamped on its newest earlier row in the same org and resource (not for a project-typed row); the writer''s projectId / projectIdFrom / orgLevel are replaced and its "timestamp" set to the server clock. The service role passes.';

REVOKE ALL ON FUNCTION public.stamp_milestone_audit_project() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_milestone_audit_project() FROM anon;
REVOKE ALL ON FUNCTION public.stamp_milestone_audit_project() FROM authenticated;

DROP TRIGGER IF EXISTS trg_audit_logs_milestone_project ON audit_logs;
CREATE TRIGGER trg_audit_logs_milestone_project
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  WHEN (left(NEW.action, 10) = 'MILESTONE_')
  EXECUTE FUNCTION public.stamp_milestone_audit_project();

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_policies.qual is DEPARSED; pg_proc.prosrc is verbatim.
SELECT 'MON-12: the registry rail is a SECURITY DEFINER trigger function with search_path pinned, EXECUTE revoked from anon and authenticated, judging the company the award answers for (cost_doc_company_barred), reading the award override for the one document, and refusing an award that also moves the link, contractor or vendor name' AS check,
       (SELECT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%app.cost_doc_award_override%' AND prosrc LIKE '%''do_not_use'', ''inactive''%'
               AND prosrc LIKE '%v_company := cost_doc_company_barred(NEW.org_id,%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
               AND prosrc LIKE '%NEW.party_id IS DISTINCT FROM OLD.party_id%'
               AND prosrc LIKE '%NEW.vendor_name IS DISTINCT FROM OLD.vendor_name%'
               AND prosrc LIKE '%(to_jsonb(NEW) ->> ''company_id'') IS DISTINCT FROM (to_jsonb(OLD) ->> ''company_id'')%'
          FROM pg_proc WHERE proname = 'enforce_cost_document_award_registry' AND pronargs = 0)
       AND NOT has_function_privilege('anon', 'public.enforce_cost_document_award_registry()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.enforce_cost_document_award_registry()', 'EXECUTE') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'MON-12: trg_cost_documents_award_registry fires BEFORE INSERT OR UPDATE OF status on cost_documents',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.cost_documents'::regclass AND t.tgname = 'trg_cost_documents_award_registry'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF status ON public.cost_documents%'),
       NULL::text
UNION ALL
SELECT 'MON-12: cost_doc_company_behind resolves the document link, then the contractor link (each only to a company of the document''s org), then one exact name — SECURITY INVOKER, not executable by anon',
       (SELECT NOT prosecdef AND prosrc LIKE '%FROM project_parties pp WHERE pp.id = p_party%'
               AND prosrc LIKE '%WHERE c.id = p_company AND c.org_id = p_org;%'
               AND prosrc LIKE '%WHERE c.id = v_party_company AND c.org_id = p_org;%'
               AND prosrc LIKE '%IF v_n <> 1 THEN RETURN NULL; END IF;%'
          FROM pg_proc WHERE proname = 'cost_doc_company_behind' AND pronargs = 4)
       AND NOT has_function_privilege('anon', 'public.cost_doc_company_behind(uuid,uuid,uuid,text)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'MON-12: company_name_key normalises as lib/bidTab.ts normalizeCompanyName (answers checked here), and cost_doc_company_barred gates on ANY do-not-use row the vendor name normalises to when no link stands (DEC-48), else on the company the quote binds to by one exact name — both SECURITY INVOKER, not executable by anon',
       company_name_key('Gulf Mechanical, Inc.') = 'gulf mechanical'
       AND company_name_key('  gulf   MECHANICAL inc ') = 'gulf mechanical'
       AND company_name_key('The Smith & Sons Co.') = 'smith and sons'
       AND company_name_key('Inc.') = 'inc' AND company_name_key('The') = 'the'
       AND company_name_key('Apex Industrial Services, LLC') = 'apex industrial services'
       AND company_name_key('') = '' AND company_name_key(NULL) = ''
       AND (SELECT NOT prosecdef AND provolatile = 'i' FROM pg_proc WHERE proname = 'company_name_key' AND pronargs = 1)
       AND (SELECT NOT prosecdef
                   AND prosrc LIKE '%RETURN CASE WHEN v_row ->> ''status'' IN (''do_not_use'', ''inactive'') THEN v_row END;%'
                   AND prosrc LIKE '%AND company_name_key(c.name) = v_key%'
                   AND prosrc LIKE '%WHERE c.org_id = p_org AND c.status = ''do_not_use''%'
                   AND prosrc NOT LIKE '%c.status IN (%'
                   AND prosrc LIKE '%v_row := cost_doc_company_behind(p_org, NULL, NULL, p_vendor);%'
                   AND prosrc LIKE '%WHERE c.id = p_company AND c.org_id = p_org;%'
                   AND prosrc LIKE '%WHERE c.id = v_party_company AND c.org_id = p_org;%'
              FROM pg_proc WHERE proname = 'cost_doc_company_barred' AND pronargs = 4)
       AND NOT has_function_privilege('anon', 'public.company_name_key(text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.cost_doc_company_barred(uuid,uuid,uuid,text)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'GAP-406: award_quote is SECURITY INVOKER with search_path pinned, refuses a NULL auth.uid(), locks the quote, re-checks the registry gate and COST-13''s confirmed figure and read extent before the claim, and claims + posts + records + declines in its one body',
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF v_uid IS NULL THEN%' AND prosrc LIKE '%FOR UPDATE;%'
               AND prosrc LIKE '%v_barred := cost_doc_company_barred(%'
               AND prosrc LIKE '%''code'', ''confirm_mismatch''%' AND prosrc LIKE '%''code'', ''extent''%'
               AND strpos(prosrc, '''code'', ''extent''') < strpos(prosrc, 'SET status = ''awarded''')
               AND prosrc LIKE '%INSERT INTO cost_entries%' AND prosrc LIKE '%''COST_ENTRY_POSTED''%'
               AND prosrc LIKE '%''COST_DOC_AWARD_OVERRIDE''%' AND prosrc LIKE '%SET status = ''declined''%'
               AND prosrc LIKE '%''COST_DOC_AWARDED''%'
               AND strpos(prosrc, 'SET status = ''awarded''') < strpos(prosrc, 'INSERT INTO cost_entries')
          FROM pg_proc WHERE proname = 'award_quote' AND pronargs = 5),
       NULL::text
UNION ALL
SELECT 'GAP-406: anon cannot execute award_quote; authenticated can (DRLS-16)',
       NOT has_function_privilege('anon', 'public.award_quote(uuid,uuid,numeric,text,numeric)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.award_quote(uuid,uuid,numeric,text,numeric)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'PERF-7: apply_checklist_item_writes is SECURITY INVOKER with search_path pinned, refuses a NULL auth.uid(), applies the call in one statement keeping the per-row updated_at guard, judges row by row only a call of at most 50, and writes only the machine actor''s rows',
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN%'
               AND prosrc LIKE '%ci.updated_at IS NOT DISTINCT FROM NULLIF(w.v ->> ''expected_updated_at'', '''')::timestamptz%'
               AND prosrc LIKE '%ci.updated_at IS NOT DISTINCT FROM NULLIF(v_write ->> ''expected_updated_at'', '''')::timestamptz%'
               AND prosrc LIKE '%IN (''evidence sweep'', ''AI assessment'')%'
               AND prosrc LIKE '%IF jsonb_array_length(v_valid) > 50 THEN%'
               AND prosrc LIKE '%''split'', 50%'
               AND prosrc LIKE '%EXCEPTION WHEN OTHERS THEN%'
          FROM pg_proc WHERE proname = 'apply_checklist_item_writes' AND pronargs = 2)
       AND NOT has_function_privilege('anon', 'public.apply_checklist_item_writes(uuid,jsonb)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.apply_checklist_item_writes(uuid,jsonb)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'MON-13: trg_project_parties_company_link fires BEFORE UPDATE OF company_id; a set link is never re-pointed or cleared by a signed-in caller (the FK SET NULL one level down passes)',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.project_parties'::regclass AND t.tgname = 'trg_project_parties_company_link'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF company_id ON public.project_parties%')
       AND (SELECT prosrc LIKE '%IF NEW.company_id IS NULL AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;%'
              FROM pg_proc WHERE proname = 'enforce_project_party_company_link' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'MON-13: the item-contractor triggers fire BEFORE UPDATE OF party_id on turnover_items and punch_items; decided items keep their contractor, a rejected one is never named',
       (SELECT COUNT(*) = 2 FROM pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
           AND ((t.tgrelid = 'public.turnover_items'::regclass AND t.tgname = 'trg_turnover_items_contractor_fixed'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF party_id ON public.turnover_items%')
             OR (t.tgrelid = 'public.punch_items'::regclass AND t.tgname = 'trg_punch_items_contractor_fixed'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF party_id ON public.punch_items%')))
       AND (SELECT prosrc LIKE '%OLD.status IN (''open'', ''received'')%' AND prosrc LIKE '%OLD.status = ''rejected''%'
              FROM pg_proc WHERE proname = 'enforce_quality_item_contractor' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'SEC-21: audit_logs_admin_trail is still RESTRICTIVE SELECT with SEC-20''s clause and now gates intake-link, INTAKE_ and MILESTONE_ rows on audit_row_project_ref_visible, the kind test inline',
       (SELECT permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
               AND qual LIKE '%org_capability_allows(org_id, ''admin.audit_view''%'
               AND qual LIKE '%audit_row_project_visible(resource_type, resource_id)%'
               AND qual LIKE '%audit_row_project_ref_visible(action, resource_type, resource_id, details)%'
               AND qual LIKE '%project_intake_link%' AND qual LIKE '%MILESTONE_%' AND qual LIKE '%INTAKE_%'
          FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail'),
       NULL::text
UNION ALL
SELECT 'SEC-21: the base member policy and the insert policy are untouched (one permissive SELECT, one INSERT, one RESTRICTIVE overlay)',
       (SELECT COUNT(*) FILTER (WHERE permissive = 'PERMISSIVE' AND cmd = 'SELECT') = 1
               AND COUNT(*) FILTER (WHERE cmd = 'INSERT') = 1
               AND COUNT(*) FILTER (WHERE permissive = 'RESTRICTIVE') = 1
          FROM pg_policies WHERE tablename = 'audit_logs'),
       NULL::text
UNION ALL
SELECT 'SEC-21: audit_row_project_ref_visible is SECURITY INVOKER with no SET clause, its names schema-qualified, executable by every role that reads audit_logs',
       (SELECT NOT prosecdef AND proconfig IS NULL
               AND prosrc LIKE '%public.project_visible_to_me(l.project_id)%' AND prosrc LIKE '%public.milestones m%'
          FROM pg_proc WHERE proname = 'audit_row_project_ref_visible' AND pronargs = 4)
       AND has_function_privilege('anon', 'public.audit_row_project_ref_visible(text,text,text,jsonb)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.audit_row_project_ref_visible(text,text,text,jsonb)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'SEC-21: the test answers — another kind → visible; an org-level row of a gone milestone (typed milestone, or carrying section 9''s org-level marker) → visible; a document milestone row naming no milestone or an unknown one (or a marker without the trigger''s projectIdFrom), an unknown link, an unknown project → not (no session here, so no project is visible)',
       audit_row_project_ref_visible('DOCUMENT_UPLOADED', 'document', 'x', '{}'::jsonb)
       AND audit_row_project_ref_visible('INTAKE_LINKS_REVOKED_WITH_PROJECT', 'project', 'x', '{}'::jsonb)
       AND audit_row_project_ref_visible('MILESTONE_CREATED', 'project', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)
       AND audit_row_project_ref_visible('MILESTONE_DELETED', 'milestone', '00000000-0000-0000-0000-000000000000', '{"milestoneId":"00000000-0000-0000-0000-000000000000"}'::jsonb)
       AND audit_row_project_ref_visible('MILESTONE_COMPLETED', 'document', 'x', '{"milestoneId":"00000000-0000-0000-0000-000000000000","projectIdFrom":"milestone","orgLevel":true}'::jsonb)
       AND NOT audit_row_project_ref_visible('MILESTONE_COMPLETED', 'document', 'x', '{"milestoneId":"00000000-0000-0000-0000-000000000000","orgLevel":true}'::jsonb)
       AND NOT audit_row_project_ref_visible('MILESTONE_CREATED', 'document', 'x', '{}'::jsonb)
       AND NOT audit_row_project_ref_visible('MILESTONE_COMPLETED', 'document', 'x', '{"milestoneId":"00000000-0000-0000-0000-000000000000"}'::jsonb)
       AND NOT audit_row_project_ref_visible('INTAKE_LINK_REVOKED', 'project_intake_link', 'not-a-uuid', '{}'::jsonb)
       AND NOT audit_row_project_ref_visible('INTAKE_LINK_REVOKED', 'project_intake_link', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)
       AND NOT audit_row_project_ref_visible('INTAKE_REJECTED', 'document', 'x', '{"projectId":"00000000-0000-0000-0000-000000000000"}'::jsonb),
       NULL::text
UNION ALL
SELECT 'SAF-9: a contractor outcome notice is claimed once per submission attempt (a UNIQUE partial index on the claim rows)',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'audit_logs'
                  AND indexname = 'audit_logs_intake_outcome_notice_claim_uniq'
                  AND indexdef LIKE 'CREATE UNIQUE INDEX%'
                  AND indexdef LIKE '%versionId%' AND indexdef LIKE '%attempt%'
                  AND indexdef LIKE '%INTAKE_OUTCOME_NOTICE_CLAIMED%'),
       NULL::text
UNION ALL
SELECT 'SAF-9: trg_audit_logs_intake_outcome_notice fires BEFORE INSERT on audit_logs for the notice''s three actions only and refuses a signed-in insert (the route writes them as the service role, which passes); nobody may call its function',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.audit_logs'::regclass AND t.tgname = 'trg_audit_logs_intake_outcome_notice'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT ON public.audit_logs%'
                  AND pg_get_triggerdef(t.oid) LIKE '%INTAKE_OUTCOME_NOTICE_CLAIMED%'
                  AND pg_get_triggerdef(t.oid) LIKE '%INTAKE_OUTCOME_NOTICE_FAILED%'
                  AND pg_get_triggerdef(t.oid) LIKE '%INTAKE_OUTCOME_NOTIFIED%')
       AND (SELECT proconfig::text LIKE '%search_path=public%'
                   AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%RAISE EXCEPTION%'
              FROM pg_proc WHERE proname = 'enforce_intake_outcome_notice_server_only' AND pronargs = 0)
       AND NOT has_function_privilege('anon', 'public.enforce_intake_outcome_notice_server_only()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.enforce_intake_outcome_notice_server_only()', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'SEC-21: trg_audit_logs_milestone_project fires BEFORE INSERT on audit_logs for MILESTONE_* rows only; its function is SECURITY DEFINER with search_path pinned, keeps the service pass, decides the project or the org-level marker itself (a writer''s stamp never stands; only its own stamps are trusted, newest by the server''s clock; a project-typed delete is not traced), and nobody may call it',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.audit_logs'::regclass AND t.tgname = 'trg_audit_logs_milestone_project'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT ON public.audit_logs%'
                  AND pg_get_triggerdef(t.oid) LIKE '%MILESTONE_%')
       AND (SELECT prosecdef AND proconfig::text LIKE '%search_path=public%'
                   AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%NEW."timestamp" := now();%'
                   AND prosrc LIKE '%NEW.details := NEW.details - ''projectId'' - ''projectIdFrom'' - ''orgLevel'';%'
                   AND prosrc LIKE '%jsonb_build_object(''projectIdFrom'', ''milestone'', ''orgLevel'', true)%'
                   AND prosrc LIKE '%ELSIF COALESCE(NEW.resource_type, '''') <> ''project'' THEN%'
                   AND prosrc LIKE '%AND a.details ->> ''projectIdFrom'' = ''milestone''%'
                   AND prosrc LIKE '%AND m.org_id = NEW.org_id;%'
                   AND prosrc LIKE '%AND a.org_id = NEW.org_id%'
              FROM pg_proc WHERE proname = 'stamp_milestone_audit_project' AND pronargs = 0)
       AND NOT has_function_privilege('anon', 'public.stamp_milestone_audit_project()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.stamp_milestone_audit_project()', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j12_inventory;
