# 01 · Role inventory

Which of the nineteen roles carry real authority, which are duplicates, and
which are labels.

**6 findings** — 0 CRITICAL, 2 HIGH, 4 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Line numbers
> drift — **match on the quoted code.**

---

## The census

Every role, its capability set from `lib/roleCapabilities.ts`, and whether any
code path branches on it.

| Role | Capabilities granted | Named in a capability-policy default? | Real gate outside the policy? | Verdict |
|---|---|---|---|---|
| `Admin` | manage_users, manage_org_config, assign_drafters, view_requests, create_requests | ✅ (all criticals) | ✅ everywhere | **Real** |
| `Manager` | manage_users, assign_drafters, view_requests, create_requests | ✅ MGMT | ✅ | **Real** |
| `Supervisor` | assign_drafters, view_requests, create_requests | ✅ MGMT | ✅ | **Real** |
| `DraftingSupervisor` | assign_drafters, **route_requests**, view_requests, create_requests | ✅ `ticket.assign` | ✅ routing target | **Real** |
| `DocCtrl` | doc_control, manage_org_config, view_requests, create_requests | ✅ | ✅ + DB bypass | **Real** |
| `Engineer-1` | approve_engineering, view_requests, create_requests | via `"Engineer"` token | ✅ | **Real, but see ROLE-2** |
| `Engineer-2` | *identical to Engineer-1* | via `"Engineer"` | — | **Duplicate** |
| `Engineer-3` | *identical* | via `"Engineer"` | — | **Duplicate** |
| `Engineer-4` | *identical* | via `"Engineer"` | — | **Duplicate** |
| `Drafter` | draft_work, create_requests | ✅ `ticket.self_assign`, `ticket.draft_work` | ✅ | **Real** |
| `Requester` | create_requests | ✅ `ticket.requester_review` | ✅ | **Real** |
| `Auditor` | audit, view_requests | ❌ | ✅ 2 sites | **Real (thin)** |
| `Viewer` | *(none)* | ❌ | ✅ 1 site (read-only exclusion) | **Real (subtractive)** |
| `Accounting` | create_requests | ❌ | ❌ | **Label** |
| `Safety` | create_requests | ❌ | ❌ | **Label** |
| `HR` | create_requests | ❌ | ❌ | **Label** |
| `Maintenance` | create_requests | ❌ | ❌ | **Label** |
| `Operations` | create_requests | ❌ | ❌ | **Label** |
| `Contractor` | create_requests | ❌ | ✅ 1 site (**restriction** — reduced nav) | **Real (subtractive)** — see `CHAIN-1` |

**10 distinct capability sets across 19 roles.**

---

## ROLE-1 · Six department roles gate nothing, and cannot do the one job left to them

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Annotation (2026-09-01, Phase 5 / CHAIN-1 done-when 2):** `Contractor` is NOT a pure label. It is load-bearing as a RESTRICTION — reduced navigation at `components/navigation/Sidebar.tsx` (the `hasAnyRole(['Viewer','Contractor'])` gate; formerly `activeRole === 'Contractor'`). It must not be treated as removable, and `DEC-3` excludes it from the dormant set for this reason. The conclusion about the other five department roles (`Accounting`, `Safety`, `HR`, `Maintenance`, `Operations`) stands; those five are now marked dormant in every role picker (`DORMANT_ROLES` in `lib/roleCapabilities.ts`) and remain fully valid ACL subjects.
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity / access-control
- **Locations:**
  - `lib/roleCapabilities.ts:63-69` — Accounting, Safety, HR, Maintenance, Operations, Contractor, all `["create_requests"]`
  - ⚠ **Correction:** `components/navigation/Sidebar.tsx:241-248` — `Contractor` **is** load-bearing, as a *restriction* (`activeRole === 'Viewer' || activeRole === 'Contractor'` → reduced navigation). The first pass missed it because the search matched only double-quoted role literals. **`Contractor` is not removable.** See `CHAIN-1`. The other five department roles are unaffected by this correction, and per `DEC-3` they are deprecated in the picker rather than deleted — no stored permission blob is versioned (`CHAIN-5`).
  - `lib/roleCapabilities.ts:87-92` — their ranks (30–35), all below `Requester` (40)
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:58` — `SELECT role INTO v_role FROM org_members` (singular)
  - `app/(protected)/admin/libraries/LibraryWizard.tsx:91-93` — the only non-label use: preset groupings
  - `components/permissions/RoleTreeSelector.tsx:17-22` — the same
  - `components/permissions/PermissionDrawer.tsx:66-71` — the ACL subject picker
- **Related:** `DOCACL-1`, `ROLE-3`
- **Re-verified:** hardening pass — **SURVIVES**. `Accounting`, `Safety`, `HR`, `Maintenance`, `Operations` and `Contractor` all map to exactly `["create_requests"]` (`roleCapabilities.ts:60-65`), and `Sidebar.tsx:247-248` reduces the workbench for `Contractor` alongside `Viewer`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The shadowing mechanism is confirmed (and extends further than the report says: lib/acknowledgments.ts:79 targets ack assignees with `.in("role", roles)`, so department-role ack rosters miss the same people). But the title's "six roles gate nothing" is contradicted by the finding's own correction note about Contractor, and the failure mode is a grant that silently does nothing — it fails closed, granting no unintended access. MEDIUM.

**Mechanism.** These six grant exactly what `Requester` grants and appear in no
capability-policy default. An exhaustive search for authority branches on them
returns nothing — every hit is a role-list grouping, a `<option>`, or the type
union itself.

Their one remaining function is to be named as the subject of a document ACL
rule (`{ type: "role", id: "Safety" }`). **That function does not work.** The
database evaluates ACL role rules against the member's *primary* role — the
highest-ranked one — and all six rank below `Requester`.

**Failure scenario.** A safety engineer holds `["Requester", "Safety"]`.
`primaryRole` resolves to `Requester` (rank 40 > 33). Document Control writes an
ACL rule granting `read` to the role `Safety` on the incident-procedure folder.
`node_visible` compares the rule against `Requester` and returns false. **The
grant silently does nothing** — no error, no warning, the folder simply stays
invisible. The only way to make the rule bite is to give the person *no other
role*, which then removes their ability to file a request.

**Remediation.** Two options, and the second is better.

1. Make the ACL roles-aware — see `DOCACL-1`. This rescues the six roles as
   access groups.
2. **Convert them to teams and retire the roles.** `team` is already a
   first-class ACL subject, `team_members` is a proper join table with an admin
   UI at `app/(protected)/admin/teams/page.tsx`, and — critically —
   `node_visible` aggregates **every** team a user belongs to
   (`array_agg(team_id) … FROM team_members`), so a team grant can never be
   shadowed by a higher-ranked anything. This is what teams are for, and it
   works today.

Doing (2) shrinks the roster from 19 to 13 and makes department-scoped access
actually function.

**Done when.**
- Either an ACL rule naming a department reaches every member of that department, or the six roles no longer exist and the equivalent teams do.
- Adding someone to a department no longer competes with their functional role.

**Resolution (2026-09-17, Round E).** The six roles keep their ONE job — being NAMED — and that job now works end to end. The mechanism the finding describes (the ACL role match against the *primary* role) no longer holds: `lib/acl.ts` `subjectMatches` and the SQL `node_visible` (`20261041`) evaluate every held role (CHAIN-1, Phase 5), so a rule naming `Safety` reaches a `["Requester","Safety"]` member whatever the headline. Round E adds the second door DEC-13 stage 2 opened: the five dormant department labels are addressable capability-policy TOKENS — `POLICY_TOKENS` in `components/permissions/CapabilityPolicyEditor.tsx` now lists them (labelled "(dept)") in the grid and in the request-type override rows, so "INCIDENT requests are reviewed by Safety" can be written from the console and is honoured by `policyAllows` and the SQL evaluator alike; the four Engineer tiers stay reachable through the single `Engineer` token (DEC-4). `lib/roleCapabilities.ts` records the job (`DORMANT_ROLE_JOB`) and the add-role picker repeats it on every dormant entry. Remediation option 2 (convert to teams, retire the roles) is declined per DEC-3 / DEC-5 — no stored blob is versioned.
- Tests: `lib/__tests__/roundE_D_rolesAdmin.test.ts` — "ROLE-1" describe: the token census (every role in `ALL_ROLES` reachable, every dormant role listed, no tier token), a request-type override naming `Safety` (matches by collection on INCIDENT only), an ACL allow AND deny naming `Safety` binding for the additive holder, the `20261041` `unnest(v_roles)` pin.
- Reproduced: at the base commit `POLICY_TOKENS` had no department entry, so no override could name one (`TOKENS` line 30); the ACL half was already collection-aware (CHAIN-1) — confirmed by the new test against `canServeContent` / `canWithAclChain`.

**Done-when.**
1. ✓ An ACL rule naming a department reaches every member of that department — app (`lib/acl.ts`) and database (`node_visible`, `20261041`) both match any held role; the alternative ("the six roles no longer exist") is declined by DEC-3.
2. ✓ Adding someone to a department no longer competes with their functional role — the collection is a set; headline rank plays no part in matching.

**Scope / residual.** The ack-roster query the independent pass named (`lib/acknowledgments.ts` `.in("role", roles)`) was already converted in Round C1b (`.or(roleFilter(roles))`) — nothing left there. `Contractor` is untouched and not dormant (CHAIN-1). No migration.

---

## ROLE-2 · The four Engineer tiers are one role wearing four names

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity / drafting authority
- **Locations:**
  - `lib/roleCapabilities.ts:56-59` — all four grant `["approve_engineering", "view_requests", "create_requests"]`
  - `lib/roleCapabilities.ts:52-54` — the comment: *"Engineer levels share one capability on purpose (the level is a sub-hierarchy, not a distinct permission)"*
  - `lib/capabilityPolicy.ts:130` — `if (token === "Engineer") return role.includes("Engineer");`
  - `lib/capabilityPolicy.ts:14-16` — *"the tiers were never enforced anywhere and remain a labeling convention"*
  - `lib/workflow.ts:18-20` — `isEngineerRole` = `role.includes("Engineer")`
  - `supabase/migrations/20260901_db_hard_enforcement.sql:61` — the DB does the same: `r LIKE '%Engineer%'`
- **Related:** `DRAFT-1`
- **Re-verified:** hardening pass — **SURVIVES**. `Engineer-1` through `Engineer-4` map to identical capability arrays — `["approve_engineering", "view_requests", "create_requests"]` (`roleCapabilities.ts:54-57`). Only `ROLE_RANK` distinguishes them, and rank affects nothing but the headline.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Every cited line checks out — the four tiers are genuinely interchangeable at every layer. But the finding's own body concedes "It is not a bug today", the behavior is documented as deliberate in two separate source comments, and nothing is currently mis-authorized. A documented design-debt item with no present defect does not warrant HIGH; MEDIUM.

**Mechanism.** Every layer — capabilities, the policy token matcher, the
workflow helper, and the database — treats all four tiers as interchangeable.
This is documented and deliberate.

**Failure scenario.** It is not a bug today; it becomes one the moment you want
what you described: *"only certain people can approve certain types of
requests."* The obvious lever — "Engineer-3 and up approve pressure-envelope
changes" — does not exist, and the tier field looks like it should provide it.
Someone will eventually assume it does.

**Remediation.** Decide which the tiers are and commit:

- **A labeling convention** (seniority for display and reporting only) — then
  move them off `Role` entirely into a `seniority` field on the member profile,
  and collapse the union to a single `Engineer`. Four fewer roles, and the
  ambiguity disappears.
- **Real authority** — then the token matcher must stop wildcarding, and each
  tier needs its own capability defaults. Note this only becomes useful together
  with `DRAFT-1`; tiers without request-type scoping just means "Engineer-4 can
  approve more things than Engineer-1," which is a blunter tool than what you
  asked for.

Option A plus `DRAFT-1` is very likely what you actually want.

**Done when.**
- The tier either carries authority or is no longer part of `Role`.
- No code path infers seniority from a string match on `"Engineer"` unless that is the documented contract.

**Resolution (2026-09-17, Round E).** Resolved per DEC-4: the four tiers are one role wearing four labels, and the decision is now recorded AT THE TYPE — `types/schema.ts` carries the DEC-4 / ROLE-2 contract above `"Engineer-1"` (identical authority; every check is "role contains Engineer"; the only consumer of the tier order is `ROLE_RANK`, the display headline; differentiate with a capability grant or a request-type override, never the tier). Recon for "any place that treats tiers as ranks" found one outside `ROLE_RANK`: the library wizard's default upload set named `Engineer-1` and `Engineer-2` only (`app/(protected)/admin/libraries/LibraryWizard.tsx`), which — because an ACL role subject matches by exact name — silently left Engineer-3/4 out of every new library's upload grant; it now names all four (`...ENGINEER_TIER_ROLES`). `relevantRequesterRole` sorts tiers by `ROLE_RANK` to choose the stamped label — that is the one permitted consumer and is unchanged. The policy editor keeps exactly one `Engineer` token (no per-tier token), pinned.
- Tests: `lib/__tests__/roundE_D_rolesAdmin.test.ts` — "ROLE-2 / DEC-4" describe: identical capability arrays, `roleTokenMatches("Engineer", tier)` for all four, no tier adds anything over another, the type-level note, the documented `includes("Engineer")` contract in `lib/workflow.ts`, the wizard default (both occurrences) naming all four.
- Reproduced: `LibraryWizard.tsx:217/251` at the base commit — `["DocCtrl", "Admin", "Engineer-1", "Engineer-2"]`.

**Done-when.**
1. ✓ (as amended by DEC-4, which binds over the record's either/or) The tier carries NO authority and stays part of `Role` as a label — recorded at the type, in the picker labels (Phase 5) and in the policy editor's single token; the "no longer part of `Role`" branch is declined by DEC-4 / DEC-5.
2. ✓ No code path infers seniority from a string match on `"Engineer"` — the string match IS the documented contract (type note, `lib/capabilityPolicy.ts` header, `lib/workflow.ts`), and the one place that ranked tiers as distinct roles (the wizard default) is corrected.

**Scope / residual.** `ROLE_RANK` is byte-identical (DEC-2). `app/api/signatures/sign/route.ts` `APPROVAL_TIER` lists all four tiers already. No migration.

---

## ROLE-3 · `Requester` is capability-identical to the six department labels

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity
- **Locations:**
  - `lib/roleCapabilities.ts:62-69` — `Requester` and the six all grant `["create_requests"]`
  - `lib/capabilityPolicy.ts:76` — `ticket.requester_review` defaults to `["Requester"]`
  - `lib/workflow.ts:71` — `canActAsRequester = isRequesterIdentity || allows('ticket.requester_review')`
- **Related:** `ROLE-1`
- **Re-verified:** hardening pass — **SURVIVES**. `Requester` and the six department labels resolve to the same single capability (`roleCapabilities.ts:59-65`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Accurate as written. The only thing distinguishing Requester from the department labels is the ticket.requester_review default, and because that default is role-wide it does grant every Requester in the org review rights over anyone's returned draft while the identity half already covers the legitimate case. MEDIUM is right.

**Mechanism.** `Requester` has one thing the department labels don't: it is the
default role list for `ticket.requester_review`. But that capability is almost
always satisfied by *identity* instead — the ticket's own requester always keeps
their review right, regardless of role.

**Failure scenario.** The role-based half of `ticket.requester_review` grants
**every** `Requester` in the org the ability to review **anyone's** returned
draft. That is broader than it looks, and it is the default. Meanwhile someone
in Operations who files a request gets the identity right anyway, so the role
buys them nothing.

**Remediation.** Consider narrowing `ticket.requester_review`'s default to `[]`
and letting identity carry it — the assigned requester always can, and a
manager override already exists via `ticket.manage`. Then `Requester` becomes a
pure "may file requests" marker, which is what everyone assumes it is.

**Done when.**
- Reviewing someone else's returned draft requires either identity or an explicit grant.
- The difference between `Requester` and a department label is documented, or one of them is removed.

**Resolution (2026-09-17, Round E).** The failure scenario no longer reproduces: WF-8 (Phase 4) made `ticket.requester_review` substitute ONLY on a ticket with no requester of record (`canActAsRequester = isRequesterIdentity || (!ticket.requesterId && allows('ticket.requester_review'))`), so a Requester-role stranger gets no review action on anyone else's returned draft — identity carries the right, exactly as the remediation wanted. The remaining recommendation (narrow the shipped default to `[]`) is deliberately NOT taken: after WF-8 the role-wide half only ever reaches an orphaned ticket, which is precisely what an org-wide default should cover; emptying it would strand requester-less tickets behind `ticket.manage` and would change the SQL evaluator's default for every org (the "defaults reproduce historical behaviour" contract). What was missing is now written down: `Requester` is the "may file requests" marker and the shipped default reviewer for a requester-less ticket; the five department labels are dormant (DEC-3), identical in authority, in no policy default, and exist to be named (ROLE-1). Recorded in `lib/roleCapabilities.ts` (the map comment, `REQUESTER_ROLE_NOTE`), in the add-role picker note, and in the in-app role model (`components/permissions/RoleModelTree.tsx`: the Requester row and the department row).
- Tests: `lib/__tests__/roundE_D_rolesAdmin.test.ts` — "ROLE-3" describe: a Requester stranger and a `["Requester","Safety"]` stranger get `[]` on another person's `PENDING_REVIEW` ticket; the requester keeps `request_revision`; the default is still `["Requester"]` and substitutes on a requester-less ticket for a Requester, not for `Safety`; source pins on the three documentation sites.
- Reproduced: traced `lib/workflow.ts:161` (WF-8 shape) and asserted the stranger case in the new test before writing the documentation.

**Done-when.**
1. ✓ Reviewing someone else's returned draft requires identity (or `ticket.manage`) — a role grant alone no longer reaches it (WF-8, re-pinned here).
2. ✓ The difference between `Requester` and a department label is documented in the three places the roster is read (neither is removed — DEC-3 / DEC-5).

**Scope / residual.** Default unchanged (reasoned above); no migration.

---

## ROLE-4 · The smart picker hides most of the roster, which is the model telling you something

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux / model-complexity
- **Locations:**
  - `lib/roleCapabilities.ts:117-119` — `addableRoles` filters to roles granting a capability the member lacks
  - `lib/roleCapabilities.ts:110-113` — `capabilitiesAdded`
- **Re-verified:** hardening pass — **SURVIVES**. `addableRoles` offers only roles granting a capability not already held (`roleCapabilities.ts:112-115`); because most roles are capability-identical, the picker hides most of the roster — which is the model reporting its own redundancy.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the arithmetic follows: any role granting create_requests makes all seven of Requester/Accounting/Safety/HR/Maintenance/Operations/Contractor return an empty capabilitiesAdded and drop out, and one Engineer tier hides the other three. The picker has no 'why is this missing' affordance.

**Mechanism.** The picker only offers a role if it would add a capability. This
is a good guardrail — it prevents meaningless additions.

**Failure scenario.** It also means that once a member holds *any* role granting
`create_requests`, **all seven** of `Requester` / `Accounting` / `Safety` / `HR`
/ `Maintenance` / `Operations` / `Contractor` vanish from the picker, and once
they hold one Engineer tier the other three vanish. An admin who wants to record
"this person is in Safety" finds the option simply not there, with no
explanation.

The guardrail is correct. What it reveals is that ten of nineteen roles carry no
capability worth adding — the picker is diagnosing `ROLE-1` and `ROLE-2` at
runtime.

**Remediation.** Once `ROLE-1` and `ROLE-2` are resolved the symptom disappears.
In the interim, when a role is hidden, say why: *"Safety adds nothing this
member doesn't already have — use a team to record department."*

**Done when.**
- A hidden role explains itself, or there are no roles that add nothing.

**Resolution (2026-09-17, Round E).** The add-role picker shows the WHOLE roster. `addableRoles` (the "never an empty add" guardrail) is untouched; the picker now renders `pickerRoster(current)` (`lib/roleCapabilities.ts`) — three labelled groups whose union is exactly `ALL_ROLES` minus what is held: "Roles that add new access" (the old list), "Labels and restrictions" (roles that add nothing — a label, or Viewer / Auditor / Contractor, which RESTRICT), and "Dormant department labels" (DEC-3, greyed). Every entry that used to vanish now carries its reason via `pickerNote`: `READ_ONLY_ROLE_NOTE` for Viewer/Auditor (read-only on document editing and equipment state, deny-if-any — ROLE-5), `CONTRACTOR_ROLE_NOTE`, the dormant note plus `DORMANT_ROLE_JOB`, the Engineer-tier note, `REQUESTER_ROLE_NOTE`, or "adds nothing … a label only". "full access" became "every role held", which is the only case with nothing to offer. An admin can now record "this person is in Safety" or place a Viewer restriction on a Drafter — with the consequence stated before the click.
- Tests: `lib/__tests__/rolePickerCensus.test.ts` — new "ROLE-4" describe: for every single-role collection the three groups partition `ALL_ROLES` minus the held role, dormant == `DORMANT_ROLES` minus held, `adds` == the guardrail's answer minus dormant; a Drafter is offered Requester / Contractor / Viewer / the five department labels / Auditor with the right notes; the members page renders the three groups (source pin). `lib/__tests__/roleCapabilities.test.ts` (the guardrail) is unchanged and green.
- Reproduced: `addableRoles(["Drafter"])` at the base commit omitted all seven of Requester / Accounting / Safety / HR / Maintenance / Operations / Contractor and Viewer (the guardrail test itself asserts that), and `RoleAddPicker` rendered only that list.

**Done-when.**
1. ✓ A hidden role explains itself — no role is hidden; each roster entry that adds nothing says why it is still offered.

**Scope / residual.** `app/(protected)/admin/users/page.tsx` (the picker component), `lib/roleCapabilities.ts`. No migration.

---

## ROLE-5 · `Viewer` and `Auditor` are the only roles that subtract, and they do it inconsistently

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `lib/roleCapabilities.ts:71` — `Viewer: []`
  - `lib/roleCapabilities.ts:70` — `Auditor: ["audit", "view_requests"]`
  - `app/(protected)/documents/[libraryId]/page.tsx:4010` — `canEdit={isController || (activeRole !== "Viewer" && activeRole !== "Auditor")}`
  - `app/(protected)/admin/audit/page.tsx:27` — `ADMIN_ROLES = new Set(["Admin","Manager","Supervisor","DocCtrl","Auditor"])`
  - `app/(protected)/admin/users/page.tsx:82` — `Viewer` is the default for new members
- **Related:** `ADD-1`
- **Re-verified:** hardening pass — **SURVIVES**. `Viewer: []` and `Auditor: ["audit", "view_requests"]` (`roleCapabilities.ts:66-67`) are the only entries that subtract, and they do it by two different means — one by holding nothing, one by holding a narrow set that the headline ranking then buries at rank 20.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the read-only checks key off the string name of the single highest-ranked role, so Viewer/Auditor held alongside anything higher subtract nothing. Two mitigations the finding omits: addableRoles() never offers Viewer (capabilitiesAdded("Viewer", …) is always []), so the mixed collection is only reachable as a residue of the default 'Viewer' seed (app/(protected)/admin/users/page.tsx:82) being promoted; and Viewer *does* restrict when it is the sole role. Exposure is a UI/model consistency defect, not an escalation.

**Mechanism.** Every other role is purely additive. These two are the only ones
whose presence is meant to *restrict* — and they do it through a hardcoded
denylist at a single call site, not through the capability model.

**Failure scenario.** The additive model defeats them. Because authority is the
**union** of held roles and the read-only check tests only `activeRole` (the
highest-ranked), a member holding `["Drafter", "Viewer"]` has
`primaryRole = "Drafter"` and is fully editable — the `Viewer` role subtracts
nothing. There is no way to express "read-only" in a model where roles only add.

`Auditor` has the same shape plus an inconsistency: it is in the audit page's
allowlist but has no capability-policy entry, so its access cannot be
reconfigured like every other admin surface.

**Remediation.** Model restriction where restriction belongs. Either:
- add an explicit `readOnly` boolean on the membership, checked independently of
  roles; or
- add a `content.edit` capability whose default excludes Viewer, so the
  read-only decision goes through the same evaluator as everything else.

Give `Auditor` a real capability id (`admin.audit_view`) so it joins the policy
layer rather than living in a hardcoded set.

**Done when.**
- Holding `Viewer` alongside another role produces a read-only member, or `Viewer` no longer implies read-only.
- Audit-page access is configurable through the capability policy.

**Resolution (2026-09-17, Round E).** The two subtracting roles now subtract the SAME way at every restriction-style check, and the audit page's admission is a capability. (1) `lib/roleHeld.ts` `READ_ONLY_ROLES = ["Viewer","Auditor"]` / `holdsReadOnlyRole(held)` — deny-if-any across the full collection (CHAIN-1), no headline shortcut, and no controller escape: the document edit gate (`app/(protected)/documents/[libraryId]/page.tsx`, `canEdit={!holdsReadOnlyRole(roles)}` — it used to let a controller past the restriction while the plot-plan page and the database did not), the plot-plan whiteboard flip (`app/(protected)/plot-plans/[id]/page.tsx`, `canFlip = !holdsReadOnlyRole(roles)`) and the `assets` UPDATE overlay at the database (`20261045`, unchanged) all answer identically; the members page shows a **read-only** badge on any member holding a read-only role beside others, and the add-role picker states the consequence before Viewer / Auditor is added (ROLE-4). (2) `Auditor`'s audit-page admission is the new capability `admin.audit_view` (`lib/capabilityPolicy.ts`, area "Admin", default `Admin / Manager / Supervisor / DocCtrl / Auditor` — the set the page hardcoded), evaluated by the one server admin gate (SURF-9: role tokens by collection, then a per-person grant, fail closed) and, at the database, by the `audit_logs_admin_trail` SELECT overlay re-created to call `org_capability_allows(org_id, 'admin.audit_view', auth.uid())` (`20261063`; the evaluator's default CASE gains the one line). The page's hardcoded `ADMIN_ROLES` set is gone. Widen, narrow or delegate it from the permissions console like every other capability; the simulator shows it.
- Tests: `lib/__tests__/roundE_D_rolesAdmin.test.ts` — "ROLE-5" describe (`holdsReadOnlyRole` cases incl. `["Admin","Auditor"]`; the three sites and the `20261045` overlay pinned; no hand-spelled pair anywhere; `admin.audit_view` default, narrowing, per-person grant, the surface's cap, the loader keeping a stored entry); the gate route test admits `["Requester","Auditor"]` and a Drafter with a grant to `audit`; `lib/__tests__/roundE_D_migration.test.ts` (20261063 shape: evaluator byte-faithful to 20261052 + exactly one CASE line; CASE mirrors `CAPABILITY_DEFS`; overlay predicate verbatim from 20261045). Updated pins: `rpPhase5Additive.test.ts` (edit gate), `rpPhase6Additive.test.ts` (flip), `sweepRoundD3.test.ts` and `rpPhase4Migration.test.ts` (the SQL-mirror census now reads the NEWEST re-creation of the evaluator).
- Reproduced: at the base commit `app/(protected)/admin/audit/page.tsx:27` hardcoded the set and `CAPABILITY_DEFS` had no audit capability; `documents/[libraryId]/page.tsx:4125` carried `isController ||` while `plot-plans/[id]/page.tsx:33` did not — two different subtractions for the same pair.

**Done-when.**
1. ✓ Holding `Viewer` alongside another role produces a read-only member on every restriction-style surface — document editing, equipment state (app and DB) — whatever else is held, controllers included. Stated residual: "read-only" means those restriction-style checks; workflow authority is governed by the capability policy (a `["Drafter","Viewer"]` member still drafts — remove Drafter to stop that), and the picker and the badge say so.
2. ✓ Audit-page access is configurable through the capability policy — `admin.audit_view`, enforced by the admin gate and by the database (pending the migration).

**Scope / residual.** `Contractor`'s reduced navigation is a different restriction (Viewer + Contractor, `components/navigation/Sidebar.tsx`) and already deny-if-any — untouched. The record's `readOnly` boolean / `content.edit` capability alternatives were not needed: the helper is the single point of definition. **Pending migration:** `supabase/migrations/20261063_rp_roundE_audit_view_capability.sql` (widening-capable — an Admin may now widen the trail's readers; pre-apply inventory captured in the paste; the AFTER rows do not re-run the BEFORE predicate — they ask the re-created evaluator itself (`org_capability_allows_for`, explicit uid) who it admits and count the members whose old five-role answer differs from it, expected 0, a real before/after delta; on apply nothing changes for anyone because no org stores an `admin.audit_view` entry yet — the probes say so).

---

## ROLE-6 · The permissions explorer shows a role list that does not match the real roster

- **Severity:** MEDIUM
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Blast radius:** ux / trust
- **Locations:**
  - `components/permissions/PermissionsExplorer.tsx:14` — `const ROLES = ["Admin","DocCtrl","Manager","Supervisor","DraftingSup","Engineer 1-4","Drafter","Requester","Staff*","Contractor","Auditor","Viewer"]`
  - `types/schema.ts:5-25` — `ALL_ROLES`, the real union
- **Re-verified:** hardening pass — **SURVIVES**. `PermissionsExplorer.tsx:14` lists `"DraftingSup"`, `"Engineer 1-4"` and `"Staff*"` — display strings that match no member of the real `Role` union.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The two load-bearing claims are false. Staff IS defined — STAFF_NOTE is rendered in the table footer, so nothing about Staff is 'unverifiable'. And the 12 columns account for all 19 roles in ALL_ROLES exactly once: 'Engineer 1-4' collapses Engineer-1..4 and 'Staff*' collapses the five request-only roles (19 − 3 − 4 = 12); 'DraftingSup' is a column-width abbreviation of DraftingSupervisor. The only residual truth is that ROLES is a hardcoded literal that will not auto-pick-up a new ALL_ROLES entry — a maintenance nit in a documentation component, not a role-roster mismatch.

**Mechanism.** A hand-maintained display array that diverges from the source of
truth in three ways: `"DraftingSup"` is not a role (`DraftingSupervisor` is),
`"Engineer 1-4"` collapses four roles into a label, and `"Staff*"` is a
placeholder standing in for the six department roles.

**Failure scenario.** An admin reading the explorer to understand the permission
model sees twelve entries, three of which do not exist as roles and one of which
(`Staff*`) has no definition anywhere. Anything they conclude about `Staff*` is
unverifiable. Adding a real role to `ALL_ROLES` will not appear here.

**Remediation.** Derive the list from `ALL_ROLES` (grouping for display if that
is the intent) rather than hand-maintaining it, so it cannot drift. If the
grouping is deliberate, label the groups as groups and name their members.

**Done when.**
- The explorer's roster is derived from `ALL_ROLES`.
- No displayed token is a name that does not exist in the type.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| ROLE-1 | HIGH | OPEN |
| ROLE-2 | HIGH | OPEN |
| ROLE-3 | MEDIUM | OPEN |
| ROLE-4 | MEDIUM | OPEN |
| ROLE-5 | MEDIUM | OPEN |
| ROLE-6 | MEDIUM | OPEN |
