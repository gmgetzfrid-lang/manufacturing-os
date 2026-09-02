# 04 · Additive roles vs primary role

A member holds a **collection** of roles. Almost nothing reads the collection.

This is the half-finished migration underneath every other finding in this run —
`ROLE-1`, `DRAFT-3` and `DOCACL-1` are all the same defect wearing different
clothes.

**5 findings** — 1 CRITICAL, 3 HIGH, 1 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Line numbers
> drift — **match on the quoted code.**

---

## The shape of the migration

`20260722_member_roles_collection.sql` added `org_members.roles TEXT[]` beside
the existing `org_members.role`. The design, stated in
`lib/roleCapabilities.ts:1-15`, is deliberate and sound:

> *"A member holds a COLLECTION of roles; their effective permissions are the
> UNION of what each role grants… the `primaryRole` headline (highest-ranked
> role) that we keep mirrored into `org_members.role` so the existing
> single-role checks + RLS keep working unchanged **while additive checks roll
> out surface by surface**."*

The mirror is the compatibility bridge. The plan was to migrate surfaces onto
the collection over time.

**That rollout largely did not happen.** The bridge is now load-bearing, and
because `primaryRole` is a *lossy* projection — it keeps the highest-ranked role
and discards the rest — every unmigrated surface silently ignores part of a
member's authority.

### The census

| Reader | Count | Reads |
|---|---|---|
| `activeRole` | **204** | primary only |
| `roles.includes(...)` | 8 | collection |
| `hasAnyRole(...)` | 5 | collection |
| `hasRole(...)` | **0** | collection |

| Database | Count |
|---|---|
| Migration files reading `org_members.role` | **41** |
| Policies/functions matching `roles &&` or `unnest(roles)` | **7** |

Roughly **94% of the application** and **85% of the schema** evaluate authority
from a single role that was chosen by rank, not by relevance.

---

## ADD-1 · The additive role collection reaches production authority in exactly one place

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-09-01 — priority 1 landed in Phase 4 as WF-7; priorities 2–3 closed in Phase 5).** (1) `getActions` receives and evaluates the full collection (`WorkflowContext.userRoles`, threaded by the route and the ticket page — WF-7). (2) The two admin pages (`/admin/analytics`, `/admin/archive-view`) pass `roles` and `uid` to `policyAllows`. (3) The authority sweep: every controller-tier check on the publish path and its UI (OWN-3), the restriction-style gates (CHAIN-1), the ACL role-subject matcher and index evaluator (allow AND deny), `authorizeOrgRole` (SURF-10), the library read-access check on the documents index, and the six lib-level controller lookups now read the collection — so adding a role grants what the picker said it would. The 204-read sweep was scoped to AUTHORITY reads; display-only `activeRole` reads (badges, attribution, `signerRole`) intentionally keep the headline.
- Done-when: ✓ engine evaluates the collection (`workflow.test.ts` WF-7 describe); ✓ adding a role grants what the picker promises (additive Drafter self-assigns, additive DocCtrl publishes, additive DraftingSupervisor is granted by an ACL role subject); ✓ `["Manager","Drafter"]`-shaped case pinned (`Viewer`+`Drafter` → self_assign in `workflow.test.ts`; `Requester`+`DraftingSupervisor` → publish via index in `rpPhase5Additive.test.ts`).
- Files: `lib/workflow.ts` (Phase 4), `app/(protected)/admin/analytics/page.tsx`, `app/(protected)/admin/archive-view/page.tsx`, plus the Phase 5 files listed under OWN-3 / CHAIN-1 / SURF-10.


- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `lib/capabilityPolicy.ts:141-153` — `policyAllows(policy, cap, role, extraRoles, uid)` — the `extraRoles` parameter exists for exactly this
  - `lib/holds.ts:100` — `policyAllows(policy, cap, role, extra, uid)` — **the only production caller that passes it**
  - `lib/workflow.ts:65` — `policyAllows(policy, cap, userRole, null, userId)` — **the entire drafting workflow passes `null`**
  - `app/(protected)/admin/analytics/page.tsx:95` — `policyAllows(p, "admin.analytics_view", activeRole)` — omits it
  - `app/(protected)/admin/archive-view/page.tsx:25` — same
  - `lib/__tests__/capabilityPolicy.test.ts:130-131` — the tests **do** exercise `extraRoles`, so the mechanism is proven to work
- **Related:** `ROLE-1`, `DRAFT-3`, `DOCACL-1`, `ADD-2`
- **Re-verified:** hardening pass — **SURVIVES**, verified by enumerating every call site. `policyAllows(policy, cap, role, extraRoles, uid)` receives a real collection in exactly one production path — `lib/holds.ts:100`. `lib/workflow.ts:65` passes `null`, so the entire drafting engine ignores every role but the headline. The remaining callers are two admin pages and `ViewAsSimulator.tsx:128` (a simulator, not authority).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the admin UI actively promises the opposite: app/(protected)/admin/users/page.tsx:474-484 renders each addable role with `+ {adds.join(' · ')}` from `capabilitiesAdded`, so adding Drafter to a Manager displays '+ Claim & produce drafts' while lib/workflow.ts:65 will never see it (ticket.self_assign defaults to ["Drafter"], headline is Manager). I tried to find a server path that reads roles[] and there is none. CRITICAL stands: the admin console states an authority grant that production authority does not honor.

**Mechanism.** The evaluator supports the collection. One production call site
passes it. The workflow — the largest consumer of the capability policy, and the
one this whole model exists to serve — explicitly passes `null`.

**Failure scenario.** A member is added as `Drafter` and later promoted, so
their collection becomes `["Manager", "Drafter"]`. `primaryRole` is `Manager`
(rank 90 > 50). In the drafting workflow:

- `ticket.self_assign` defaults to `["Drafter"]` → **denied**. They cannot pick
  up drafting work any more.
- `ticket.draft_work` defaults to `["Drafter"]` → **denied**. They can only work
  tickets already assigned to them by identity.

The admin added the role, the member list shows it, the picker offered it — and
it does nothing. Nothing in the interface says the role is inert.

The mirror image is equally live and worse: because `capabilitiesFor` unions
capabilities but the *evaluator* sees only the primary, adding a **high-ranked**
role to give someone one small permission hands them that role's entire
authority everywhere the primary role is read.

**Remediation.** Thread the collection through. `RoleContext` already exposes
`roles` alongside `activeRole` (`components/providers/RoleContext.tsx:366-369`),
so the value is available at essentially every call site — it just is not
passed.

Priority order:
1. `lib/workflow.ts:65` — one line, and it is the highest-traffic authority
   decision in the app.
2. The two admin pages.
3. Then sweep the 204 `activeRole` reads, converting authority checks (not
   display) to `hasAnyRole`.

**Done when.**
- `getActions` receives and evaluates the member's full role collection.
- Adding a role always grants what the picker said it would grant.
- A test asserts a `["Manager","Drafter"]` member gets drafter actions.

---

## ADD-2 · The view-as simulator evaluates authority differently than production does

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (by comparing arguments; the visible symptom was not observed in a browser)
- **Blast radius:** trust / verification
- **Locations:**
  - `components/permissions/ViewAsSimulator.tsx:128` — `policyAllows(policy, d.id, who.role, who.roles, who.uid)` — passes the **collection**
  - `lib/workflow.ts:65` — `policyAllows(policy, cap, userRole, null, userId)` — passes **null**
- **Related:** `ADD-1`
- **Re-verified:** hardening pass — **SURVIVES**. `ViewAsSimulator.tsx:128` passes `who.roles`; `workflow.ts:65` passes `null`. The simulator answers a question production never asks.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The divergence is real and the UI's literal claim of parity is the aggravating fact. Concretely: a member with role='Manager', roles=['Manager','Drafter'] shows a green check next to 'Do drafting work'/'Self-assign drafting work' in the simulator, while WorkflowEngine.getActions offers neither. HIGH is right.

**Mechanism.** The simulator is the tool an administrator uses to answer "what
can this person actually do?" It is the one surface that passes `extraRoles`
correctly. Production, for the same question, does not.

**Failure scenario.** This is the worst possible place for the divergence,
because the simulator's entire purpose is to be trusted.

An admin checks whether a `["Manager","Drafter"]` member can do drafting work.
The simulator unions the collection, finds `Drafter` in `ticket.draft_work`, and
reports **allowed**. The member opens the ticket and there is no button — the
workflow evaluated `Manager` alone and denied it.

The admin now has a verification tool that is *more permissive than reality*,
and no way to tell which answer is right. Every conclusion drawn from the
simulator about a multi-role member is unsound in one direction or the other.

**Remediation.** Fixing `ADD-1` closes this automatically — that is the right
fix, and the simulator is already correct. Until then, the simulator should
either evaluate the way production does (pass `null`, and show a warning that
secondary roles are not yet honoured) or display both answers side by side and
name the discrepancy. Silently showing the optimistic one is the only option
that must not stand.

**Done when.**
- The simulator's verdict matches what the member experiences, for a multi-role member, on every capability.
- A test compares the simulator's evaluation path against the workflow's for the same input.

---

## ADD-3 · `primaryRole` is chosen by rank, which is not the same as chosen by relevance

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / design
- **Locations:**
  - `lib/roleCapabilities.ts:76-96` — `ROLE_RANK`
  - `lib/roleCapabilities.ts:122-125` — `primaryRole`, `sort` by rank, take the first
  - `lib/roleCapabilities.ts:8-13` — the stated intent: *"the most powerful role the member holds"*
- **Related:** `ADD-1`, `ROLE-1`
- **Re-verified:** hardening pass — **SURVIVES**. `primaryRole` sorts by `ROLE_RANK` alone (`roleCapabilities.ts:122`), so a Manager who also drafts has headline `Manager` (90) and misses every `Drafter`-keyed check.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. I tested whether this is merely a restatement of ADD-1 (harmless if every check read the collection) and it is not: the singular mirror is irreducibly what the database reads. A member holding {Manager, DocCtrl} gets headline Manager, and the publish-path SQL that gates on `v_role IN ('Admin','DocCtrl')` (20260812_per_library_publish_authority.sql:52,119; 20260713_document_publish_guard.sql:56; 20260816_owner_publish_access.sql:56; 20260822_review_completion_guard.sql:64) denies them at the DB regardless of app-layer fixes. Cited line numbers are ~2 low (ROLE_RANK is 74-94, primaryRole 120-123), content matches exactly. HIGH stands.

**Mechanism.** `primaryRole` returns the highest-ranked role. Where a single
role must be produced, "most powerful" is a defensible choice — it is safe for
*display* and for the "can they do this admin thing" class of check.

**Failure scenario.** It is the wrong choice for a *specific* authority
question, and that is what most call sites ask. The rank ordering encodes
seniority, not applicability:

| Collection | `primaryRole` | Question asked | Right answer | Actual answer |
|---|---|---|---|---|
| `["Manager","Drafter"]` | `Manager` | may they draft? | yes | **no** |
| `["Requester","Safety"]` | `Requester` | are they Safety? | yes | **no** |
| `["Manager","Engineer-2"]` | `Manager` | are they an engineer? | yes | **no** |
| `["Drafter","Viewer"]` | `Drafter` | are they read-only? | yes | **no** |

Every row is a real path: the second breaks department ACLs (`ROLE-1`), the
third breaks the engineering-review gate (`DRAFT-3`), the fourth defeats
read-only (`ROLE-5`).

The projection is not merely incomplete — for the common questions it is
**wrong in a specific direction**, because rank was designed for a different
purpose than the one it is serving.

**Remediation.** Keep `primaryRole` for display and for the RLS mirror, and
label it that way in the source. For authority, ask about the *collection*
(`hasAnyRole`) rather than about a projection of it. Where a single role must
reach the database, prefer widening the policy to read `roles` (seven already
do) over improving the projection — no single-role projection can answer these
questions correctly.

**Done when.**
- `primaryRole`'s doc comment states it is for display and legacy RLS only.
- No new authority check consumes it.

---

## ADD-4 · The database is split — seven policies read the collection, the rest read the mirror

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - Roles-aware: `20260814_documents_delete_controllers.sql:38`, `20260817_org_members_escalation_and_config.sql:26,38,50`, `20260818_followups_rls.sql:16,28`, `20260901_db_hard_enforcement.sql:61,64,138`, `20260907_milestone_batch_move.sql:42`
  - Mirror-only: **41 migration files** reading `org_members.role`, including `20260708_acl_rls_enforcement.sql:58` — the ACL (`DOCACL-1`)
- **Related:** `DOCACL-1`, `ADD-1`
- **Re-verified:** hardening pass — **SURVIVES**, with the census made exact: **11** SQL references read `roles[]` (`roles &&` / `ANY(roles)`) against **50** that read the `role` mirror. The split is real and lopsided.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The count in the title is accurate to the file: seven policy sites read the collection, everything else reads the mirror only. The split is exactly as described — whether a secondary role counts depends on which migration wrote the policy. HIGH stands.

**Mechanism.** Migrations written after the collection landed tend to check both
(`role IN (...) OR roles && ARRAY[...]`). Migrations written before it check
only `role`, and were not revisited.

**Failure scenario.** Two documents in the same library, governed by policies
from different eras, answer the same authority question differently for the same
person. An admin cannot reason about the system from any single rule — whether a
secondary role counts depends on which month the policy was written.

The highest-impact instance is the ACL, which predates the collection and is the
most granular access decision in the product (`DOCACL-1`).

**Remediation.** Introduce one helper and route everything through it:

```sql
CREATE OR REPLACE FUNCTION member_has_role(p_org uuid, p_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = p_org AND uid = auth.uid() AND status = 'active'
      AND (role = ANY(p_roles) OR roles && p_roles)
  );
$$;
```

Then migrate policies to it, starting with `node_visible`. A single helper also
means the next role-model change is one edit rather than forty-eight.

**Done when.**
- One helper answers "does this member hold any of these roles" for the whole schema.
- `node_visible` uses it.
- No new policy reads `org_members.role` directly.

---

## ADD-5 · Nothing keeps the mirror in sync at the database

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / data-integrity
- **Locations:**
  - `lib/roleCapabilities.ts:122-125` — `primaryRole`, computed in TypeScript
  - `supabase/migrations/20260722_member_roles_collection.sql:13` — `ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}'` — no trigger, no constraint
  - `components/providers/RoleContext.tsx:198-201` — `normalizeRoles` then `primaryRole`, on read
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `primaryRole` is TypeScript (`roleCapabilities.ts:120-123`) and `20260722_member_roles_collection.sql:13` only adds the column with a default. No trigger, constraint or function keeps `role` consistent with `roles`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and I found a live writer that already violates the invariant: app/api/auth/signup/route.ts:133-142 inserts `{ ..., role: "Admin", status: "active" }` with no `roles`, so the row lands with role='Admin' and roles='{}'. That also breaks org_capability_allows, whose `COALESCE(roles, ARRAY[role])` (20260901:39) does not fall back for an empty-but-non-null array. MEDIUM is defensible, arguably light.

**Mechanism.** The invariant "`role` equals the highest-ranked member of
`roles`" is maintained by application code on write. There is no trigger, no
`CHECK`, and no reconciliation.

**Failure scenario.** Any writer that updates `roles` without recomputing
`role` — a data restore, a support script, a direct console edit, or a future
code path — leaves the mirror stale. Because 41 migration files and 204
component reads trust the mirror, a stale value silently governs authority
across most of the app, in whichever direction the stale data points.

`normalizeRoles` is tolerant on read (it merges the array and the legacy single
value), which is good defensive design — but it runs in the client and does not
correct the stored row that RLS reads.

**Remediation.** Move the invariant into the database: a `BEFORE INSERT OR
UPDATE` trigger on `org_members` that recomputes `role` from `roles` using a SQL
mirror of `ROLE_RANK`. Then the mirror cannot drift regardless of who writes.
Add a reconciliation query to the maintenance cron reporting rows where the
invariant does not hold.

Note this becomes far less critical once `ADD-4` lands — a schema that reads the
collection directly does not depend on the mirror being right.

**Done when.**
- Updating `roles` by any path updates `role`.
- A drifted row is detectable.

---

## Verified sound — do not "fix" these

- **The union semantics are correct.** `capabilitiesFor` unions across held
  roles, which is the right model for additive authority.
- **`normalizeRoles` is properly defensive** — it tolerates the pre-migration
  shape where only `role` exists, dedupes, and rejects strings that are not real
  roles.
- **`RoleContext` already exposes everything needed.** `activeRole`, `roles`,
  `hasRole` and `hasAnyRole` are all in the context value
  (`components/providers/RoleContext.tsx:366-369`). The plumbing exists; it is
  the call sites that did not adopt it.
- **The migration was additive and reversible**, with the rollback documented in
  the file's own header.
- **`lib/__tests__/capabilityPolicy.test.ts` covers `extraRoles` and per-person
  grants**, including expiry — so the mechanism is proven, which is precisely
  what makes `ADD-1` a wiring problem rather than a design problem.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| ADD-1 | CRITICAL | OPEN |
| ADD-2 | HIGH | OPEN |
| ADD-3 | HIGH | OPEN |
| ADD-4 | HIGH | OPEN |
| ADD-5 | MEDIUM | OPEN |
