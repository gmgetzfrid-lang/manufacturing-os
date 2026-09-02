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
- **Status:** OPEN
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

---

## ROLE-2 · The four Engineer tiers are one role wearing four names

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## ROLE-3 · `Requester` is capability-identical to the six department labels

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## ROLE-4 · The smart picker hides most of the roster, which is the model telling you something

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## ROLE-5 · `Viewer` and `Auditor` are the only roles that subtract, and they do it inconsistently

- **Severity:** MEDIUM
- **Status:** OPEN
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
