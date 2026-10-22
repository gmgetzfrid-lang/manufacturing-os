-- ─────────────────────────────────────────────────────────────────────────────
-- 20261263_df_roundG_ticket_dimension_inventory.sql
--
-- drafting-flow Round G — DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION
-- (GAP-105 acceptance 3, TIER-4, the DCW-6 hand-off; DEC-90 ruling (2) for
-- DF-P19). A COUNTS-ONLY INVENTORY. It changes nothing: no table, column,
-- function, policy, trigger or row is created, altered or written.
--
-- WHY. From the DF-P19 deploy a request presents its library, work class and
-- code class to the capability policy (lib/workflow.ts ticketResource), so a
-- stored rule on a `ticket.*` capability scoped to one of them — which until
-- then could match no request — starts to match. The ruling: BEFORE the keys
-- start to match, count every such stored rule, per workspace, and classify
-- each by effect:
--   NARROW — it would take an action away from someone: a role on the
--            capability's base list (the stored bare list, else its first
--            unconditional rule, else the shipped default) or on one of its
--            request-type / unit rules is not on it (a matching rule
--            REPLACES the list), or it is on ticket.direct_approve (any
--            scoped rule there can scope a requester's own approval out) —
--            unless it names every member ("*"). On
--            ticket.engineer_gate_exempt EVERY such rule is NARROW unless its
--            roles are exactly the base list (DF-P19 fix pass, review major
--            2): that list names whose OWN requests need no engineer
--            sign-off, so a role ADDED there takes an engineering review
--            away — never a harmless grant — and the app ignores the rule
--            until an Admin confirms it;
--   GRANT  — it only adds roles to the base list (never on
--            ticket.engineer_gate_exempt);
--   SAME   — it names exactly what already applies.
-- lib/capabilityPolicy.ts classifyTicketDimensionRule is the same rule (a
-- test runs both on the same fixtures on PostgreSQL 16).
--
-- WHAT THE APP DOES WITH THEM (no paste needed for it). A rule stored before
-- the deploy carries no confirmation stamp, and an unconfirmed one only ADDS
-- (lib/capabilityPolicy.ts effectiveTokens): a GRANT takes effect at the
-- deploy; a NARROW does not take a working action away from anyone until an
-- Admin confirms it (and one on ticket.engineer_gate_exempt does nothing at
-- all until then) (Admin → Permissions, "Request rules scoped to a library
-- or a work / code class" → Confirm, which the policy route audits). Only
-- the narrowing half waits (DF-P19 fourth fix pass, review minor 2): the
-- classes are exclusive, but a NARROW rule may also name a role that is not
-- on the base list, and the app joins an unconfirmed rule's roles to the old
-- answer — so that role HAS the action from the deploy. Row 13 counts those
-- rules (lib/capabilityPolicy.ts narrowTicketRuleAddedRoles is the same
-- rule). A rule saved through the policy route after the deploy is
-- confirmed by that save when an Admin saves it.
--
-- PASTE / DEPLOY ORDER. Read-only, so the app is correct before and after
-- the paste and either order is safe; paste it BEFORE the DF-P19 deploy so
-- the counts describe the policies as they stood before the keys started to
-- match (a paste afterwards also counts rules saved since, stamped). Re-runnable.
-- Independent of every other migration: it reads org_configurations and
-- tickets only, and reads tickets.work_class / code_class through to_jsonb()
-- so a database without 20261250 answers 0 for them instead of failing; a
-- database without 20261208 (tickets.library_id) is read the same way.
--
-- Single paste (DEC-30): temp-table inventory (aggregate counts only, never a
-- customer row) → BEGIN/COMMIT (empty: nothing to apply) → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Inventory (aggregate only; captured BEFORE the transaction) ─────────────
DROP TABLE IF EXISTS df_round_g_263_before;
CREATE TEMP TABLE df_round_g_263_before AS
WITH
-- The shipped default role list of every request capability
-- (lib/capabilityPolicy.ts CAPABILITY_DEFS; the test pins the two equal).
defaults(cap, tokens) AS (
  VALUES
    ('ticket.manage', '["Admin","Manager","Supervisor"]'::jsonb),
    ('ticket.initial_review', '["Admin","Manager","Supervisor","Engineer"]'::jsonb),
    ('ticket.eng_review', '["Engineer"]'::jsonb),
    ('ticket.assign', '["Admin","Manager","Supervisor","DraftingSupervisor"]'::jsonb),
    ('ticket.self_assign', '["Drafter"]'::jsonb),
    ('ticket.draft_work', '["Drafter"]'::jsonb),
    ('ticket.requester_review', '["Requester"]'::jsonb),
    ('ticket.direct_approve', '["Engineer"]'::jsonb),
    ('ticket.final_approve', '["Engineer"]'::jsonb),
    ('ticket.reopen', '["Admin","Manager","Supervisor"]'::jsonb),
    ('ticket.force_close', '["Admin","Manager","Supervisor"]'::jsonb),
    ('ticket.reassign_engineer', '["Admin"]'::jsonb),
    ('ticket.engineer_gate_exempt', '["Admin","Manager","Supervisor","Engineer","DocCtrl"]'::jsonb)
),
-- Every request capability's stored entry, in either stored shape
-- (parseStoredCapabilityPolicy: `caps`, else the legacy flat object).
entries AS (
  SELECT c.org_id, e.cap, e.entry
    FROM org_configurations c,
         jsonb_each(CASE WHEN jsonb_typeof(c.data->'caps') = 'object' THEN c.data->'caps'
                         WHEN COALESCE(jsonb_typeof(c.data->'caps'), 'null') = 'null' AND jsonb_typeof(c.data) = 'object' THEN c.data
                         ELSE '{}'::jsonb END) AS e(cap, entry)
   WHERE c.key = 'capability_policy' AND e.cap LIKE 'ticket.%' AND jsonb_typeof(e.entry) = 'array'
),
-- Every rule (an object with a string-array `tokens`) of a rule list.
rules AS (
  SELECT en.org_id, en.cap, r.rule, r.ord,
         -- (every flag COALESCEd: jsonb_typeof of an absent key is NULL, and a
         -- NULL flag would drop the rule from every NOT (…) test below)
         EXISTS (SELECT 1 FROM unnest(ARRAY['requestType','unit','libraryId','discipline','projectId','workClass','codeClass']) k(key)
                  WHERE jsonb_typeof(r.rule->'when'->k.key) = 'array' AND jsonb_array_length(r.rule->'when'->k.key) > 0) AS conditional,
         COALESCE(jsonb_typeof(r.rule->'when'->'libraryId') = 'array' AND jsonb_array_length(r.rule->'when'->'libraryId') > 0, false) AS by_library,
         COALESCE(jsonb_typeof(r.rule->'when'->'workClass') = 'array' AND jsonb_array_length(r.rule->'when'->'workClass') > 0, false) AS by_work_class,
         COALESCE(jsonb_typeof(r.rule->'when'->'codeClass') = 'array' AND jsonb_array_length(r.rule->'when'->'codeClass') > 0, false) AS by_code_class
    FROM entries en,
         jsonb_array_elements(en.entry) WITH ORDINALITY AS r(rule, ord)
   WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(en.entry) x(v) WHERE jsonb_typeof(x.v) <> 'string')
     AND jsonb_typeof(r.rule) = 'object'
     AND jsonb_typeof(r.rule->'tokens') = 'array'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.rule->'tokens') t(v) WHERE jsonb_typeof(t.v) <> 'string')
),
-- The base list per (workspace, capability): the bare list, else the first
-- unconditional rule, else the shipped default.
bases AS (
  SELECT en.org_id, en.cap,
         COALESCE(
           CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(en.entry) x(v) WHERE jsonb_typeof(x.v) <> 'string') THEN en.entry END,
           (SELECT r.rule->'tokens' FROM rules r WHERE r.org_id = en.org_id AND r.cap = en.cap AND NOT r.conditional ORDER BY r.ord LIMIT 1),
           d.tokens,
           '[]'::jsonb) AS tokens
    FROM entries en LEFT JOIN defaults d ON d.cap = en.cap
),
dims AS (
  SELECT r.*,
         COALESCE(jsonb_typeof(r.rule->'confirmedAt') = 'string' AND length(r.rule->>'confirmedAt') > 0, false) AS confirmed,
         b.tokens AS base
    FROM rules r JOIN bases b ON b.org_id = r.org_id AND b.cap = r.cap
   WHERE r.by_library OR r.by_work_class OR r.by_code_class
),
classified AS (
  SELECT dm.*,
         CASE
           -- ticket.engineer_gate_exempt: a widening removes an engineering
           -- review, a narrowing adds one — NARROW (confirm first) unless
           -- the roles are exactly the base list (jsonb containment both ways).
           WHEN dm.cap = 'ticket.engineer_gate_exempt'
             THEN CASE WHEN (dm.rule->'tokens') @> dm.base AND dm.base @> (dm.rule->'tokens') THEN 'same' ELSE 'narrow' END
           WHEN NOT (dm.rule->'tokens' ? '*')
                AND (dm.cap = 'ticket.direct_approve'
                     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(dm.base) bt(t) WHERE NOT (dm.rule->'tokens' ? bt.t))
                     OR EXISTS (SELECT 1 FROM rules o, jsonb_array_elements_text(o.rule->'tokens') ot(t)
                                 WHERE o.org_id = dm.org_id AND o.cap = dm.cap AND o.conditional
                                   AND NOT (o.by_library OR o.by_work_class OR o.by_code_class)
                                   AND NOT (dm.rule->'tokens' ? ot.t)))
             THEN 'narrow'
           WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(dm.rule->'tokens') rt(t) WHERE NOT (dm.base ? rt.t))
             THEN 'grant'
           ELSE 'same'
         END AS effect
    FROM dims dm
),
per_org AS (
  SELECT org_id, COUNT(*) AS rules, COUNT(*) FILTER (WHERE effect = 'narrow') AS narrow FROM classified GROUP BY org_id
),
open_tickets AS (
  SELECT t.org_id, to_jsonb(t)->>'library_id' AS library_id, to_jsonb(t)->>'work_class' AS work_class, to_jsonb(t)->>'code_class' AS code_class
    FROM tickets t
   WHERE t.archived_at IS NULL AND t.status NOT IN ('CLOSED', 'CANCELED')
)
SELECT 1 AS ord, 'inventory (before apply): workspaces storing a capability policy' AS inventory,
       (SELECT COUNT(*) FROM org_configurations WHERE key = 'capability_policy')::text AS n
UNION ALL
SELECT 2, 'inventory (before apply): stored request (ticket.*) rules scoped to a library, a work class or a code class — they could match no request until the DF-P19 deploy',
       (SELECT COUNT(*) FROM classified)::text
UNION ALL
SELECT 3, 'inventory (before apply): … of them scoped to a library', (SELECT COUNT(*) FROM classified WHERE by_library)::text
UNION ALL
SELECT 4, 'inventory (before apply): … of them scoped to a work class', (SELECT COUNT(*) FROM classified WHERE by_work_class)::text
UNION ALL
SELECT 5, 'inventory (before apply): … of them scoped to a code class', (SELECT COUNT(*) FROM classified WHERE by_code_class)::text
UNION ALL
SELECT 6, 'inventory (before apply): … of them already confirmed (a policy-route save after the DF-P19 deploy; expect 0 before it)', (SELECT COUNT(*) FROM classified WHERE confirmed)::text
UNION ALL
SELECT 10, 'inventory (before apply): would newly NARROW someone''s access, or change whose own requests skip engineer sign-off (any such rule on ticket.engineer_gate_exempt) — its narrowing half is NOT in force until an Admin confirms it (Admin → Permissions): until then the old answer stands for everyone it would take an action from, and an engineer_gate_exempt rule does nothing; a role it names beyond the base list has the action at once (row 13)',
       (SELECT COUNT(*) FROM classified WHERE effect = 'narrow')::text
UNION ALL
SELECT 11, 'inventory (before apply): would newly GRANT (only adds roles; never a ticket.engineer_gate_exempt rule) — in force at the deploy',
       (SELECT COUNT(*) FROM classified WHERE effect = 'grant')::text
UNION ALL
SELECT 12, 'inventory (before apply): name exactly what already applies (no effect)',
       (SELECT COUNT(*) FROM classified WHERE effect = 'same')::text
UNION ALL
SELECT 13, 'inventory (before apply): … of the NARROW ones, unconfirmed and outside ticket.engineer_gate_exempt, that also name a role not on the base list — their added roles are IN FORCE at the deploy; only the removal waits for an Admin''s confirmation',
       (SELECT COUNT(*) FROM classified
         WHERE effect = 'narrow' AND NOT confirmed AND cap <> 'ticket.engineer_gate_exempt'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(rule->'tokens') rt(t) WHERE NOT (base ? rt.t)))::text
UNION ALL
SELECT 20, 'inventory (before apply): workspaces holding at least one such rule', (SELECT COUNT(*) FROM per_org)::text
UNION ALL
SELECT 21, 'inventory (before apply): workspaces holding at least one that would NARROW (their Admins see it as "not yet in force — confirm to apply")', (SELECT COUNT(*) FROM per_org WHERE narrow > 0)::text
UNION ALL
SELECT 22, 'inventory (before apply): most such rules in one workspace / most NARROW ones in one workspace',
       (SELECT COALESCE(MAX(rules), 0) FROM per_org)::text || ' / ' || (SELECT COALESCE(MAX(narrow), 0) FROM per_org)::text
UNION ALL
SELECT 30, 'inventory (before apply): open requests whose library a library-scoped rule of their workspace names (they start to match)',
       (SELECT COUNT(*) FROM open_tickets ot
         WHERE ot.library_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM classified c WHERE c.org_id = ot.org_id AND c.by_library AND c.rule->'when'->'libraryId' ? ot.library_id))::text
UNION ALL
SELECT 31, 'inventory (before apply): open requests whose work class or code class a class-scoped rule of their workspace names (0 before 20261250)',
       (SELECT COUNT(*) FROM open_tickets ot
         WHERE EXISTS (SELECT 1 FROM classified c WHERE c.org_id = ot.org_id
                         AND ((c.by_work_class AND ot.work_class IS NOT NULL AND c.rule->'when'->'workClass' ? ot.work_class)
                           OR (c.by_code_class AND ot.code_class IS NOT NULL AND c.rule->'when'->'codeClass' ? ot.code_class))))::text
UNION ALL
SELECT 40 + row_number() OVER (ORDER BY cap), 'inventory (before apply): ' || cap || ' — narrow / grant / same',
       (COUNT(*) FILTER (WHERE effect = 'narrow'))::text || ' / ' || (COUNT(*) FILTER (WHERE effect = 'grant'))::text || ' / ' || (COUNT(*) FILTER (WHERE effect = 'same'))::text
  FROM classified GROUP BY cap;

BEGIN;
-- Nothing to apply: DF-P19's mechanism is in the app (the request presents
-- its library and classes; an unconfirmed rule only adds). This transaction
-- is empty by design, so the paste keeps DEC-30's one shape.
COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 3 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'read-only: the capability policies read equal the policies stored now (nothing was written)' AS check,
       (SELECT n FROM df_round_g_263_before WHERE ord = 1) = (SELECT COUNT(*) FROM org_configurations WHERE key = 'capability_policy')::text AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'every counted rule is classified exactly once (narrow + grant + same = all)',
       (SELECT n::bigint FROM df_round_g_263_before WHERE ord = 2)
         = (SELECT n::bigint FROM df_round_g_263_before WHERE ord = 10) + (SELECT n::bigint FROM df_round_g_263_before WHERE ord = 11) + (SELECT n::bigint FROM df_round_g_263_before WHERE ord = 12),
       NULL
UNION ALL
SELECT 1, 3, 'no table, function or trigger was created by this paste (inventory only)',
       NOT EXISTS (SELECT 1 FROM pg_class WHERE relname LIKE 'df_round_g_263%' AND relpersistence <> 't'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_263_before
) AS final_rows
ORDER BY sec, ord;
