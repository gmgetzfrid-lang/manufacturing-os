# 12 · Coupling & change impact

> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T00:30:00Z

What a change to the role model actually touches, which changes are safe, and
which look safe and are not.

**6 findings** — 0 CRITICAL, 3 HIGH, 3 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**
>
> **This report is mostly analysis.** Its findings are real defects, but its
> primary job is to tell a resolving agent what *not* to touch and in what order.
> Read it before working any finding in reports 01–11 that mentions roles.

---

## The one rule that governs everything else

Authority checks in this codebase come in two shapes, and they fail in opposite
directions:

| Shape | Example | If the role resolution is wrong |
|---|---|---|
| **Grant** — "you may, if your role is in this set" | `if (role === 'Admin' \|\| role === 'DocCtrl')` | **Fail-closed.** Can wrongly deny. Never wrongly allows. |
| **Restriction** — "you may, unless your role is in this set" | `activeRole !== "Viewer" && activeRole !== "Auditor"` | **Fail-open.** Rank collapse is a genuine **escalation**. |

Almost every role check in the app is a grant, which is why the additive model's
incompleteness is mostly an *availability* problem rather than a security one.

**The exceptions are what matter.** Two restriction-style checks were found, both
reading the singular headline role:

- `app/(protected)/documents/[libraryId]/page.tsx:4010` —
  `canEdit={isController || (activeRole !== "Viewer" && activeRole !== "Auditor")}`
- `components/navigation/Sidebar.tsx:248` —
  `activeRole === 'Viewer' || activeRole === 'Contractor'` (reduced navigation)

See `CHAIN-1`.

---

## CHAIN-1 · Restriction-style checks read the headline role, so adding a role *removes* a restriction

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / access-control
- **Locations:**
  - `app/(protected)/documents/[libraryId]/page.tsx:4010` — `canEdit={isController || (activeRole !== "Viewer" && activeRole !== "Auditor")}`
  - `components/navigation/Sidebar.tsx:241-248` — `activeRole === 'Viewer' || activeRole === 'Contractor'`, with the comment *"Viewers/Contractors hold few or no capabilities"*
  - `lib/roleCapabilities.ts:74-94` — `ROLE_RANK`: `Requester: 40` outranks `Auditor` and `Contractor`
  - `lib/roleCapabilities.ts:120-123` — `primaryRole()` returns the highest-ranked role
- **Related:** `ROLE-1`, `ADD-1`, `DB-7`
- **Re-verified:** hardening pass — **SURVIVES**. `canEdit={isController || (activeRole !== "Viewer" && activeRole !== "Auditor")}` (`documents/[libraryId]/page.tsx:4010`) and the same shape in `Sidebar.tsx:247-248`. Because the test is on the *headline*, adding any higher-ranked role removes the restriction rather than adding a permission.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Right, and adding a role genuinely REMOVES a restriction — the inverse of what an additive model should do. I checked for a backstop and found none: the only DB-hard write blocks are ACL deny rules (20260901_db_hard_enforcement.sql §4), which are content rules, not role restrictions, so nothing stops the now-editable Auditor's metadata write. HIGH stands.

**Mechanism.** `primaryRole` is a *max-rank* projection. For a **grant** check
that is harmless-to-restrictive. For a **restriction** check it is an escalation:
adding any higher-ranked role to a restricted user makes the restriction stop
matching.

**Failure scenario.** An Auditor — a role that exists specifically to be
read-only — is additively given `Requester` so they can file a ticket.
`primaryRole` now returns `Requester`. At
`app/(protected)/documents/[libraryId]/page.tsx:4010`, `activeRole !== "Auditor"`
is now true, so `canEdit` is true: **the read-only auditor gains inline document
editing.** The same shape applies to `Contractor` and reduced navigation.

**Chain reaction.** ⚠ **This correction matters for report 01.** `ROLE-1`
classifies `Contractor` as a pure label with no authority branch. That is wrong:
`Contractor` is load-bearing at `components/navigation/Sidebar.tsx:248` as a
*restriction*. It was missed because a first-pass search matched only
double-quoted role literals and the codebase uses both quote styles.
**`Contractor` must not be treated as removable.** `ROLE-1`'s conclusion about the
other five department roles is unaffected.

**Done when.**
1. Restriction-style checks evaluate against the full role collection — a user
   who holds `Auditor` is restricted whether or not they also hold something
   higher-ranked.
2. `ROLE-1` in report 01 is annotated to reflect that `Contractor` carries a
   restriction.
3. A test covers `roles = ['Auditor','Requester']` against the document edit
   gate.

---

## CHAIN-2 · `primaryRole()` is a four-line browser function that 200+ authority checks treat as truth

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / model-complexity
- **Locations:**
  - `lib/roleCapabilities.ts:118-123` — the function
  - `app/(protected)/admin/users/page.tsx:130,137` — **the only place the headline is computed and written**: `const headline = primaryRole(cleaned); … .update({ roles: cleaned, role: headline })`
  - `components/providers/RoleContext.tsx:200-206` — mirrored into `activeRole`
  - consumed as truth by the headline-only census in [`11-database-authority.md`](./11-database-authority.md) (`DB-7`)
- **Related:** `DB-3`, `DB-7`, `ADD-1`, `OWN-3`
- **Re-verified:** hardening pass — **SURVIVES**, with the count made exact: `activeRole` appears **209** times across `app/` and `components/`. Not all are authority checks, but the magnitude the finding claims holds, and every one of them resolves through a four-line browser sort.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on counts and on the claimed write paths. Nothing server-side or in the database recomputes or validates the headline, so a restore or a direct console edit can leave `role` disagreeing with `roles`, and 209 call sites follow the singular. HIGH stands.

**Mechanism.** `org_members.role` is a **denormalized cache of a computation that
happens in the browser**. Nothing in the database enforces that
`role = primaryRole(roles)`. Any write that sets one without the other — a
restore, a direct PATCH, a service-role path, a future API route — silently
desynchronizes the headline from the collection.

An approximate census of the two access patterns across `app/`, `lib/` and
`components/` returns roughly 237 singular-role reads against roughly 50
collection-aware ones. **Treat those as orders of magnitude, not exact counts** —
they are pattern matches, not a compiler-accurate census, and the two patterns
overlap. The structural point stands regardless: the singular projection is the
dominant access path by a wide margin, and it is computed client-side.

**Failure scenario.** `lib/dataRestore.ts` and `app/api/admin/restore/begin/route.ts`
write `org_members` rows with whatever `role` the backup names, and
`app/api/auth/signup/route.ts` writes `role` without `roles` at all (`DB-3`).
After a restore, a member's headline can disagree with their collection, and
every check in the singular family will believe the headline.

**Chain reaction.** This is the pivot for most of the additive-roles work in this
audit. A database invariant making `role` derived from `roles` would make the
singular-family checks correct by construction — including
`prevent_last_admin_removal`, which currently protects against a headline the
database does not control. It is a schema change with a backfill (`DB-3`) and a
behaviour change for every desynchronized row.

**`DEC-1` settles it: yes. Add a `BEFORE INSERT OR UPDATE` trigger on
`org_members` setting `NEW.role := primaryRole(NEW.roles)`, and make `roles` the
only column application code writes.** Three steps in order, and step 1 is not
optional: backfill `roles` from `role` (`DB-3` — the column is
`NOT NULL DEFAULT '{}'`, so it is empty rather than null and every additive check
currently denies the founding Admin); port `primaryRole` / `ROLE_RANK` into SQL as
a `STABLE` function pinned byte-identical to
`lib/roleCapabilities.ts:118-123` by a test walking all 19 roles; then add the
trigger, **not** service-role exempt, so restore also produces a consistent
headline.

**Done when.**
1. A query for `org_members` rows where `role <> primaryRole(roles)` returns zero.
2. A direct PATCH setting only `role` does not change the effective headline.
3. Signup produces `roles = ARRAY['Admin']`, not `'{}'`.
4. A test asserts the SQL and TypeScript rank functions agree for all 19 roles.
5. No finding was converted from a singular check to additive before step 1
   landed.

---

## CHAIN-3 · "Who acts on this ticket?" is answered by three subsystems with three different models

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / access-control
- **Locations:**
  - badges / attention: `lib/ticketAttention.ts:22-27`, `:79-108` — hardcoded role list, **additive-aware**
  - buttons / actions: `lib/workflow.ts:65` — capability policy, **headline-only** (`extraRoles: null`)
  - email / routing: `lib/ticketRouting.ts:79,91,99` — hardcoded role list, **headline-only**
  - `lib/ticketAttention.ts:21` carries a comment claiming it is in sync with routing
- **Related:** `WF-7`, `WF-19`, `WF-24`
- **Re-verified:** hardening pass — **SURVIVES**. Three models, all present: the `MANAGEMENT_ROLES` const (`ticketAttention.ts:22-27`), `policyAllows` with `extraRoles: null` (`workflow.ts:65`), and `byRole` on the headline column (`ticketRouting.ts:79`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the contradiction is even sharper than the summary: a plain DraftingSupervisor needs no secondary role to hit it — attention marks PENDING_ENG_INITIAL as action-required for them (MANAGEMENT_ROLES includes DraftingSupervisor) while getActions offers nothing (MGMT excludes DraftingSupervisor, and initial_review is MGMT+Engineer), and routing sends that state to engineers instead. Three subsystems, three answers. HIGH stands.

**Mechanism.** Three subsystems answer the same question with three different
role resolutions and three different role lists. The comment asserting they are
aligned is not true.

**Failure scenario.** A DraftingSupervisor sees a badge count of 14 (attention
says they must act), opens each ticket and finds "View Only — No Actions
Available" (the workflow engine disagrees), and never receives the routing email
(routing matched on their headline `Manager`). Three subsystems, three answers,
one confused person.

**Chain reaction.** Recorded in full as `WF-7`, `WF-19` and `WF-24`. It appears
here because it is the clearest illustration of the general pattern: **the same
authority question is re-implemented per surface rather than resolved once.** Any
fix must move all three together or it makes the divergence worse rather than
better.

**Done when.** The three surfaces agree for every role/status combination — see
`WF-24`'s acceptance criteria.

---

## CHAIN-4 · The app's own answer to "do I have dead roles?" is stale

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution.** Every stale claim in `RoleModelTree` and `PermissionsExplorer` now either matches enforced behaviour or sits under "Known gaps" — the finding's Done-when, applied claim by claim after re-verifying each against current code (three of the audit's five had been joined by NEW stale claims that intervening work created; all were corrected):
- *"expiry dates honored"* → corrected: honored only by the raw-rule evaluator; the publish path (app + DB) reads the `acl_index` snapshot which carries no expiry. Added as its own Known-gaps entry.
- *"a few older checks still read only the headline role"* → replaced with the honest statement: the publish guard (app + database), most RLS predicates and the admin-page gates are headline-only — e.g. Manager + secondary DocCtrl has no publish authority anywhere.
- Access recertification *"If library owner"* (PermissionsExplorer) → the entry point is `{isController && …}` (`documents/[libraryId]/page.tsx:3374`); the row is now `yy----------` with a ⚠ warn naming the owner-path gap (`DEL-6`), and the same gap is listed in the tree's Known gaps.
- `ownerName || team` render → owner existence now comes from `owner_user_id` (selected at last), name resolved live from membership rows — the `DEL-8`/DEC-11 rule, so a renamed or name-less owner no longer displays as the team.
- `publishGrants` missing `allow.teams` → team grants (live authority: `canPublishViaIndex` and the DB function both honor them) now listed with team names.
- Stale claims the audit did not have: `:79` staff roles + `:89` Contractor "not assignable in /admin/users" (all 19 roles are in `ROLE_OPTIONS` now), `:90` "/admin/audit does NOT admit Auditor" (it does — `ADMIN_ROLES` includes Auditor with a comment saying why), and the DocCtrl blurb claiming user management (`/admin/users` is `['Admin','Manager']`-gated; DocCtrl is denied). All corrected; the DocCtrl sidebar-link inconsistency is recorded as new finding `CHAIN-7`.
- Commit: `2af2ebe`
- Files: `components/permissions/RoleModelTree.tsx`, `components/permissions/PermissionsExplorer.tsx`
- Tests: documentation-and-display change — verified by claim-by-claim read-through against the enforcing code (each anchor above); the two display-data fixes ride the existing render paths. Neither component is renderable in the node test env (live Supabase import); the enforced behaviours the text now describes are pinned by the neighbouring suites (`permissions.publish.test.ts`, `acl.test.ts`).
- Reproduced: every corrected claim was reproduced against current code before editing — including confirming `buildAclIndexFromRules` (`lib/acl.ts:256-272`) carries no expiry filter while `isRuleActive` (`:81,:97`) enforces it for raw rules.
- Verified: components kept (per the finding's ⚠ — the self-documenting model is an asset); claims re-derived from code; Known gaps grew from 3 to 5 honest entries.
- **What this brought to light:** (1) **DEC-10 hazard for Phase 2:** the planned nightly `acl_index` rebuild is justified partly as "drops expired rules", but `buildAclIndexFromRules` has no expiry filter — a naive rebuild that calls it re-imports expired rules into the index; the rebuild must filter `isRuleActive(rule, now)` first. (2) `OWN-6`'s enforcement half may already be fixed in current code (`canPublishViaIndex` honors teams, the DB function honors teams, the library page threads `teamIds`) — the OWN-6/OWN-10 resolver should re-verify before re-fixing. (3) The Sidebar/users-page inconsistency became `CHAIN-7`.
- **Verification:** CONFIRMED
- **Blast radius:** ux / trust
- **Locations:**
  - `components/permissions/RoleModelTree.tsx:79,89,90` — role summaries
  - `components/permissions/RoleModelTree.tsx:101` — asserts *"expiry dates honored"* (contradicted by `OWN-7`)
  - `components/permissions/RoleModelTree.tsx:106` — correctly describes the auto-finalize authority quirk
  - `components/permissions/RoleModelTree.tsx:113-120` — a "Known gaps" section that admits some inconsistencies
  - `components/permissions/RoleModelTree.tsx:117` — *"a few older checks still read only the headline role"*
  - `components/permissions/PermissionsExplorer.tsx` — the capability matrix, including a row claiming access recertification works *"If library owner"* (contradicted by `DEL-6`)
- **Related:** `OWN-7`, `OWN-10`, `DEL-6`, `ROLE-*`
- **Re-verified:** hardening pass — **SURVIVES**. `RoleModelTree.tsx:79` still carries *"NOTE: not currently assignable in /admin/users (known…"* — the app's own documentation of its role model is stale in the file that exists to explain it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — the tree is internally inconsistent, with stale per-role text sitting above a comment that says those very gaps are fixed. And GAPS[0] at :117 understates the real state: `a few older checks still read only the headline role` describes 45 role-only SQL predicates across 24 migration files plus 209 activeRole references. MEDIUM is fair for a documentation-integrity finding.

**Mechanism.** The product contains a self-documenting authority model. It is
**the right idea** and unusual to find — but several of its claims no longer
match the code, and an admin reasoning about permissions is reasoning from it.

The most consequential inaccuracies:

| The app says | Reality |
|---|---|
| *"expiry dates honored"* | `acl_index` discards `expiresAt` entirely (`OWN-7`) |
| *"a few older checks still read only the headline role"* | The publish guard is one of them, and it is *the* check (`OWN-3`) |
| Access recertification: *"If library owner"* | The menu item is inside `{isController && …}` (`DEL-6`) |
| `RoleModelTree.tsx:232` renders `ownerName \|\| team` | A library with `owner_user_id` set and `owner_name` null displays the **team** as owner (`DEL-8`) |
| `publishGrants` reads `allow.users` and `allow.roles` | `allow.teams` is never read, so team publish grants are invisible in the only place they are listed (`OWN-6`) |

**Failure scenario.** An admin preparing for an access recertification reads the
role model tree, concludes the model is sound apart from the "few older checks"
it admits to, and signs off. Every discrepancy above was invisible to them.

**Chain reaction.** ⚠ **Do not remove these components.** A self-documenting
authority model with an explicit "Known gaps" section is a genuine asset and
worth keeping. The finding is that its claims must be re-derived from the code
rather than maintained by hand — and, in the interim, corrected.

**Done when.** Every claim in `RoleModelTree` and `PermissionsExplorer` either
matches the enforced behaviour or is explicitly listed under "Known gaps."

---

## CHAIN-5 · No stored permission blob carries a version, so no role can safely be removed

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `types/schema.ts:96-126` — `AccessRule` / `AclIndexBucket`; **no version field**
  - `lib/acl.ts:256-272` — `buildAclIndexFromRules` writes role names as bare strings into `allow.roles.<action>`
  - `lib/capabilityPolicy.ts:112-117` — `CapabilityPolicy`; role tokens are bare strings, no version
  - `documents.acl` / `acl_index`, `collections.acl` / `acl_index`, `libraries.acl` / `acl_index`, `org_configurations.data` — all JSONB blobs holding role **names**
- **Related:** `ROLE-1`, `ROLE-*`, `CHAIN-1`
- **Re-verified:** hardening pass — **SURVIVES**. `AccessRule`/`PermissionSubject` (`types/schema.ts:96-107`) carry no version or schema marker, and `buildAclIndexFromRules` bakes bare role names into the allow/deny buckets (`acl.ts:256-267`). A removed role leaves grants that match nothing and deny nothing.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence: three stored blob shapes, zero version fields, and no normalization pass anywhere prunes or migrates an unknown role string. The failure is silent in the dangerous direction — a deny rule naming a deleted role simply stops matching, widening access with no error. MEDIUM stands.

**Mechanism.** Role identity is the role's *name*, stored as a string inside
customer JSON in at least seven places. There is no id, no version stamp, and no
migration hook.

**Failure scenario.** A future decision to delete `Accounting` (say) has no safe
execution path: a customer's `documents.acl` may name it in a live rule; a
`capability_policy` blob may list it as a token; the role picker may have written
it into `acl_index` at any node. Removing the string from `ALL_ROLES` orphans
every stored reference **silently** — the rule stays in the JSON and simply stops
matching, so an access grant quietly evaporates with no error and no audit event.

**Chain reaction.** This is why `ROLE-1`'s "six department roles gate nothing"
conclusion **is not a removal authorization**, and why the protocol in
`../README.md` says never to delete a role because a report calls it dead. The
prerequisite for any role removal is stable role ids plus a migration that
rewrites stored blobs — which is a project, not a cleanup.

**`DEC-5` settles it: roles stay string-identified, and no role may be renamed or
removed until that is revisited.** Converting to ids means a migration rewriting
`acl` and `acl_index` on `documents`, `collections` and `libraries` plus
`org_configurations.data`, across every customer, with no version field to key
off — a project with real risk and, given `DEC-3` and `DEC-4`, no forcing
function.

**Done when.** `ALL_ROLES` contains the same 19 strings at the end of this audit
as at the start, and the constraint is recorded where a future rename would hit
it.

---

## CHAIN-6 · Change-impact map — what each candidate change actually touches

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity
- **Re-verified:** Re-read in the hardening pass. **This is a change-impact map, not a defect** — there is nothing to refute. Its value is as a blast-radius reference before touching the role model.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. The content is accurate on every row I sampled, so nothing here is refuted — but it carries a MEDIUM severity while being, by its own text, reference material with no remediation and no 'done when'. Corrected severity: none/informational; it should not be counted as an open MEDIUM defect in the severity rollup at :572-579.

**Mechanism.** This entry exists so that a resolving agent can check a proposed
change against its real reach before starting. It is reference material, not a
defect.

| Candidate change | Reaches | Verdict |
|---|---|---|
| Add `DraftingSupervisor` to the ACL role pickers (`OWN-9`) | 2 arrays | **Safe.** Additive; no stored data changes. |
| Fix `tm.user_id` → `tm.uid` (`DB-2`) | 1 word | **Not safe alone.** Activates `documents_deny_write_guard` for the first time, against possibly-stale indexes (`DB-4`). |
| Backfill `roles` from `role` (`DB-3`) | 1 migration | **Safe and enabling.** Prerequisite for nearly all additive work. |
| Pin `search_path` on 13 functions (`DB-6`) | 13 definitions | **Safe.** No behavioural change. Identify which `enforce_document_publish_guard` definition is live first. |
| Add `owner_user_id` to the access-change guard (`OWN-2`) | 1 trigger + 1 UI flow | **Mostly safe.** Blocks owner-to-owner reassignment unless explicitly allowed. |
| Add RESTRICTIVE policies to `libraries` (`OWN-1`) | 6+ call sites | **Not safe alone.** Every one uses `.update()` without `.select()` and will fail **silently** (`OWN-14`). |
| Thread `teamIds` into the publish principal (`OWN-6`) | ~1 function | **Widens authority.** Audit existing `allow.teams.publish` grants first — they have been inert. |
| Make publish-path SQL additive (`OWN-3`) | 3 functions | **Widens authority.** Needs `DB-3` first, and an inventory of secondary-DocCtrl holders. |
| Reorder `ROLE_RANK` to lift `DocCtrl` (`OWN-3` alt) | 1 constant | **Resist.** Silently removes Manager-tier ticket authority from the same people. Do not do this *and* the additive fix. |
| Narrow `tickets` RLS (`WF-2`) | 3 client writers | **Not safe alone.** Read `WF-23` first — the SQL capability defaults deny everyone. |
| Fix `org_configurations.value` (`DB-1`, `WF-1`) | 2 files | **Activates three latent findings** (`WF-10`, `WF-11`, `WF-23`). |
| Delete any role (`ROLE-1`) | customer JSON in 7 places | **Resist.** No stored blob is versioned (`CHAIN-5`). |
| Restore `org_members` DELETE (`SURF-1`) | 1 policy | **Makes `OWN-12` bite.** Ownership has no succession. |
| Give ownership a read branch (`DEL-2`) | `node_visible` | **Widens read access.** `DEC-7` picks the implicit branch — an auto-granted ACL rule adds a second dependent write to the call site with the known silent-failure bug. |

**Done when.** Nothing — this is reference material. It carries an ID so it can
be cited from a `Resolution` block, and so an agent that finds it wrong can mark
it `INVALID` with evidence rather than silently working around it.

---

## CHAIN-7 · The sidebar shows DocCtrl an admin Users link that the page then denies

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / trust
- **Locations:**
  - `components/navigation/Sidebar.tsx:209` — `const isAdmin = activeRole === 'Admin' || activeRole === 'DocCtrl';`, driving the admin section at `:252`
  - `app/(protected)/admin/users/page.tsx:258-260` — `if (!['Admin', 'Manager'].includes(activeRole)) return <div…>Access Denied. Admins Only.</div>`
- **Related:** `CHAIN-4`, `SURF-9`
- *(Found while resolving `CHAIN-4`, 2026-08-24. Checked only by this session — treat per the `author` grade until independently challenged.)*

**Mechanism.** The sidebar's admin section is gated Admin-or-DocCtrl; the Users
page inside it is gated Admin-or-Manager. DocCtrl sees a live-looking Users
link and gets "Access Denied" on click — the decorative-control failure the
permissions console was built to remove, and the inverse of the documented
Manager-by-URL gap (which `RoleModelTree`'s Known gaps already lists; both
directions are now listed there per `CHAIN-4`'s fix).

**Failure scenario.** A DocCtrl reads the tree, sees the Users link, clicks it
to onboard a drafter, is denied, and concludes their permissions are broken —
support ticket, or worse, a workaround through a shared Admin login.

**Remediation (illustrative).** Decide which gate is right (per `DEC-17`'s
posture this is an inconsistency, not a hole — the API behind the page is what
matters) and align the two: either the sidebar link renders for
Admin/Manager, or the page admits DocCtrl to a read-only roster.

**Done when.** The set of people shown the link equals the set the page admits.

---

## Verified sound — do not break

1. **`RoleModelTree` and `PermissionsExplorer` as artifacts.** Even with the
   stale claims in `CHAIN-4`, a self-documenting authority model *inside the
   product*, with an explicit "Known gaps" section that admits its own
   inconsistencies, is unusual and valuable. **Fix the claims; keep the
   components.**
2. **Identity rights are non-configurable** (`lib/workflow.ts:69-75`). A ticket's
   requester, drafter or engineer can never be locked out of their own ticket by
   a policy edit — so no capability-policy change can strand a ticket. Frozen by
   a test.
3. **The additive/singular split is *documented* in the code**
   (`lib/roleCapabilities.ts:10-11` describes the rollout as surface-by-surface).
   The incompleteness is known, not accidental — which means the remaining work
   is finishing a plan, not discovering one.
4. **The grant/restriction asymmetry works in the codebase's favour.** Because
   nearly every check is a grant, an incorrect role resolution nearly always
   *denies* rather than *allows*. `CHAIN-1`'s two exceptions are the whole
   security surface of the additive-roles gap — which is a much smaller problem
   than the raw count of divergent checks suggests. **Preserve that property:
   prefer grant-shaped checks when adding new ones.**
