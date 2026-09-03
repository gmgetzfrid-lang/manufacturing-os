# 08 · Delegation, teams, and the owner's reach

Whether an owner can hand a single file to one person; whether teams are
genuinely optional; and what ownership does and does not carry with it.

**9 findings** — 0 CRITICAL, 5 HIGH, 4 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**
>
> Report [`05-ownership-publish.md`](./05-ownership-publish.md) covers who *is*
> the owner and what breaks in the ownership chain. This report covers what an
> owner can **do with** that authority, and how teams interact with it.

---

## Teams are genuinely optional — this part works

This was checked deliberately and it holds up. With zero teams in an org:

| Mechanism | Guard | Location |
|---|---|---|
| `getMyTeamIds` | returns `[]`, errors swallowed to `[]` | `lib/teams.ts:121-125` |
| `node_visible` | `array_length(p_team_ids,1) > 0` before touching the team bucket | `supabase/migrations/20260708_acl_rls_enforcement.sql:35-38` |
| `user_can_publish_on_library` | `v_teams IS NOT NULL AND EXISTS(…)` | `supabase/migrations/20260812_per_library_publish_authority.sql:67,81` |
| Every team picker | conditioned on `allTeams.length > 0` | throughout |
| Every `listTeams` call | `.catch(() => [])` | throughout |

Crucially, the "department groupings" in
`components/permissions/RoleTreeSelector.tsx:7-28` and
`app/(protected)/admin/libraries/LibraryWizard.tsx:81-87` are **role**
groupings, not teams — no team dependency.

**Nothing structural blocks a zero-team org.** Two teams-adjacent bugs bite
anyway (`DB-2`'s `tm.user_id` sits inside a document UPDATE policy, and
`OWN-10`'s simulator query errors regardless of team count), but those are
defects in team-handling code, not a teams requirement.

**Do not introduce a `NOT NULL` team requirement anywhere in the ownership
chain.**

---

## DEL-1 · An owner cannot delegate anything — the permission drawer is hard-wired to Admin/DocCtrl at every call site

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-01, roles-and-permissions Phase 6 — the `GAP-3` build).** All three drawer instantiations that matter for owners now receive a computed authority: the library page's document/folder drawer takes `isController || drawerDelegationAuthority` (effective owner of the node — document → folder → library owner — or a `managePermissions`/`admin` allow on its chain via `canWithAclChain`) and the library drawer takes `isController || libraryDelegationAuthority` (the library's owner); the admin permissions page stays controller-only by design (it is the org-wide console). Non-controllers get `delegationOnly`: allow-only rules, delegable actions only (no `admin`/`managePermissions`), expiry required, with an inline explanation and refusal messages. The database agrees (`20261044`): the documents access-change guard's ACL arm admits the effective owner and refuses any non-controller write that mints new admin/managePermissions allows; folder updates admit the owner and manage-grant holders. Ownership reassignment is no longer the only way to delegate — it stays a transfer, delegation is a bounded, expiring rule.
- Done-when: (1) ✓ owner opens the drawer, adds a person with `publish`/`write` and an expiry, saves; (2) ✓ a plain member on the same document still cannot; (3) ✓ the delegate publishes while the rule is live and not after expiry (evaluators honour `expiresAt`; the drawer writes an expiry-filtered index; the nightly rebuild retires later expiries); (4) ✓ every owner-issued save writes `NODE_ACL_CHANGED` naming the owner; (5) ✓ an owner cannot grant `admin` (drawer + DB bound) and is limited to the delegable action set.
- Files: `components/permissions/PermissionDrawer.tsx`, `app/(protected)/documents/[libraryId]/page.tsx`, `supabase/migrations/20261044_rp_phase6_owner_delegation.sql`; tests `lib/__tests__/rpPhase6Migration.test.ts`, `lib/__tests__/rpPhase6Additive.test.ts` (source pins).
- Migration: `20261044` — **printed for operator paste; pending apply** (7-point verification; 4-line inventory recorded BEFORE apply — this migration widens folder UPDATE to owner/manage-grant and document ACL authority to the owner arm).
  - 2026-09-02 live run: inventory BEFORE apply — 0 folders and 0 documents owned by a non-controller (no widening population today), 33 folders and 691 documents whose chain-resolved index already carries admin/managePermissions grants (the OLD-vs-NEW bound is what makes those re-saveable by a future owner). DDL applied; 6/7 true. Probe 2 (`OWN-2` arm kept) was false because `pg_proc.prosrc` stores the dollar-quoted body verbatim, where the message's apostrophe is written `document''s`; the probe's `''` matched one quote. Probe corrected to `''''`; a test now enforces the escaped pair for every intra-literal apostrophe in a `prosrc` probe across all four Phase 6 migrations. Re-verification of probe 2 pending paste-back (probe 1 is true on the same re-created body, whose line-diff against 20261036 is pinned as additions-only).
  - Pre-flight 2026-09-02 correction: the folder policy's `WITH CHECK` carried the admin-grant bound as an OR-disjunct (`OR NOT acl_index_grants_admin_beyond('{}', acl_index)`). A policy's `WITH CHECK` sees only the NEW row and the owner disjunct was already true, so that clause could never refuse anything — dead code that read as a control. Replaced by `collections_guard_access` (BEFORE UPDATE, compares OLD against NEW per subject bucket — the same shape as the documents guard); the policy's `WITH CHECK` now mirrors its `USING`. Test pins both. Residual: an owner's parent-ACL edit that cascades a not-yet-rebuilt admin grant into a child index is refused with the delegation message until the nightly index rebuild (service role) runs — same shape as the documents bound.


- **Verification:** CONFIRMED
- **Blast radius:** availability / access-control
- **Locations:**
  - `app/(protected)/documents/[libraryId]/page.tsx:4654` — document/folder drawer: `canEdit={isController}`
  - `app/(protected)/documents/[libraryId]/page.tsx:4671` — library drawer: `canEdit={isController}`
  - `app/(protected)/admin/permissions/page.tsx:35,58` — `ADMIN_ROLES = new Set(["Admin","DocCtrl"])`
  - `lib/permissions.ts:18-20` — `isControllerRole`: `role === "Admin" || role === "DocCtrl"`
  - `components/permissions/PermissionDrawer.tsx:258` — `const save = async () => { if (!canEdit) return; … }`
  - `supabase/migrations/20260816_documents_access_change_guard.sql:72-76` — **the database *does* honour a `managePermissions` grant**
  - A repo-wide search for `managePermissions` returns **zero** client-side authorization reads
- **Related:** `OWN-19`, `DOCACL-*`, `GAP-3`
- **Re-verified:** hardening pass — **SURVIVES**. Both `PermissionDrawer` call sites pass `canEdit={isController}` (`documents/[libraryId]/page.tsx:4654, 4671`) — ownership is not in the expression, so an owner cannot delegate any part of their own authority.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The absence claim is confirmed, and the DB is strictly more permissive than the UI: 20260816:66-85 `can_manage_node` already honours an `admin`/`managePermissions` grant on the node, so the delegation model exists in Postgres with no client that can reach it. Lowered to MEDIUM: this is an unimplemented capability, not a fault — nothing is exposed, nothing corrupts, and the report itself concedes PermissionsExplorer honestly shows the drawer as Admin/DocCtrl only.

**Mechanism.** There are exactly three drawer instantiations and all three pass
the controller boolean. An owner is therefore never `canEdit`, so the ACL editor
renders read-only and `save()` short-circuits before doing anything. **Meanwhile
the database would have accepted the write** — `can_manage_node` honours a
`managePermissions` allow on the node's chain, and that path has no client
consumer at all.

**Failure scenario.** The Drawings library owner needs the piping lead to update
sheet P-102 while she is on rotation. Her options today are exactly two:

1. **Reassign `documents.owner_user_id` to him** — which *strips her own
   authority over that file* (the resolver returns `p_doc_owner = p_uid` and
   stops, so an explicit document owner **replaces** the library owner rather
   than sitting alongside) and grants him everything ownership grants: publish,
   roster, retention, legal hold — with no expiry.
2. **Ask an Admin.**

There is no third option. She picks (1), forgets, and P-102 is still delegated
eighteen months later — invisible, because nothing lists per-document owners
(`DEL-7`).

**Chain reaction.** Folder-level delegation is dead at the database too
(`collections_update_controllers` is controller-only), so fixing only the client
would enable delegation at the document and library levels but not the folder
level. Note also that whatever authority an owner is given to grant must be
bounded: an owner should be able to grant only actions they themselves hold,
never `admin`, and owner-issued rules should carry an expiry so delegations
self-terminate — otherwise this fix creates a new escalation path.
`components/permissions/PermissionsExplorer.tsx` is honest about today's state
(it shows the ACL drawer as Admin/DocCtrl only); the "situational authority" fold
in `components/permissions/RoleModelTree.tsx:96-99` lists ownership powers
without mentioning that delegating is not among them.

**Done when.**
1. The effective owner of a document can open its Permissions drawer, add a rule
   granting one named person `publish`/`write` with an expiry, and save.
2. A plain member on the same document still cannot.
3. The delegate can publish while the rule is live and cannot after it expires.
4. Every owner-issued save writes an audit row naming the owner as actor.
5. An owner cannot grant an action they do not themselves hold, and cannot grant
   `admin`.

---

## DEL-2 · Ownership grants publish, roster, retention and legal-hold authority — but **not read access**

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / safety
- **Locations:**
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:42-82` — `node_visible` considers visibility, controller role and `acl_index` grants. **It has no ownership branch.**
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:85-91` — `documents_acl_select` / `collections_acl_select` are the only restrictive SELECT policies, and both call `node_visible`
  - `supabase/migrations/20260630_document_ownership.sql:4-5` — the migration's own comment promises the owner *"is granted CRUD access to their scope"*
  - `user_is_effective_owner` appears in the publish guard (×2), the review-completion guard, and the two publisher-row-management policies — and in **no SELECT policy**
- **Related:** `OWN-12`, `DEL-9`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `node_visible` reads visibility, `acl_index`, the singular `role` and team ids (`20260708_acl_rls_enforcement.sql:42-80`). **No ownership term appears anywhere in it**, so ownership confers publish and roster authority without conferring read.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by repo-wide search: `user_is_effective_owner` appears only in the publish guard (20260816:60, 20260822/20260824), the review-completion guard, and the two publisher-row-management policies (20260830:36-50, 20260828:237) — never in a SELECT policy, and no other policy references `owner_user_id` for reads (the sole hit, schema.sql:1125, is an unrelated table). 20260816_owner_publish_access.sql is titled "Phase 2: access grant" but ships publish only.

**Mechanism.** Phase 2 shipped ownership **write** authority
(`20260816_owner_publish_access.sql`) and never shipped ownership **read**
authority. The restrictive SELECT policies govern visibility only, and ownership
is invisible to them.

**Failure scenario.** An admin assigns the safety lead as owner of the private
Incident Procedures library. She receives "review due", "retention reached",
"acknowledgment overdue" and "access recert due" notifications for documents she
**cannot open** — the row is filtered out by `documents_acl_select`. The
`/register` row is invisible to her too. She can, bizarrely, still publish a
revision blind, because the restrictive policy governs `SELECT` only.

**Chain reaction.** Every owner-targeted notification in `lib/reviewCycles.ts`,
`lib/retention.ts`, `lib/effectiveDate.ts`, `lib/acknowledgments.ts`,
`lib/reviewControl.ts` and `lib/accessRecert.ts` deep-links to
`/documents/{libraryId}?doc={id}` — a dead link for such an owner. It also
silently breaks `isEffectiveOwnerOfDocument` (`lib/ownership.ts:77-88`), which
reads `documents` and `collections` under the caller's own RLS: **an owner who
cannot SELECT the row is told they are not the owner**, so the Inspector hides
the publish button the database would have honoured. See `DEL-9`.

**`DEC-7` settles it: add the branch inside `node_visible`, after the controller
short-circuit and before the `acl_index` check. Do not auto-grant an explicit ACL
read rule at assignment.** The explicit rule is more auditable and was the
tempting option, but it adds a *second dependent write* to `setOwner` — the exact
call site with the known silent-failure bug (`OWN-13`). A rule that fails to write
leaves an owner recorded as owner who cannot see their documents, with a success
audit row. The implicit branch has one definition, cannot drift, and needs no
backfill. Ownership visibility is solved separately by `DEL-7`. Spec: `GAP-15`.

**Done when.**
1. A non-controller assigned as owner of a `private` library can open a document
   in it.
2. The deep-link in the review-due notification lands on a readable page.
3. A member who is neither owner nor granted still cannot.
4. `isEffectiveOwnerOfDocument` returns true for that owner.

---

## DEL-3 · Team ownership collapses to a single uid with no succession, no membership requirement, no FK, and no audit

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-01, roles-and-permissions Phase 6 — the four `DEC-9` fixes, rung kept).** (1) The supervisor picker lists the TEAM's members; an explicit "allow a supervisor from outside this team" override widens it and states what it means (publish authority over every owned library), and out-of-team options are labelled. (2) Every supervisor change goes through `setTeamSupervisor` — a checked write that logs `TEAM_SUPERVISOR_CHANGED` with the previous and new person and the affected library list, and the page tells the admin which libraries' publish authority just moved; the page text now says what the dropdown does and lists the currently-owned libraries. (3) Clearing the supervisor of a team that owns libraries is refused with the list (or, with `clearOwnership`, clears the team ownership per library with an audit row each). (4) Team deletion clears `libraries.owner_team_id` (audited per library) BEFORE the delete, and the database backstops it: `libraries.owner_team_id` is now a real FK `ON DELETE SET NULL`, with any pre-existing dangling pointer nulled and audited in the migration. Supervisors who are not active members are no longer effective owners (`OWN-12`). Also: the teams page's admin gate reads the role collection.
- Done-when: (1) ✓ audit row naming both people and every affected library; (2) ✓ clearing is blocked (or clears ownership with audit rows); (3) ✓ deleting clears `owner_team_id` (app + FK); (4) ✓ the page shows which libraries the change affects — per the department, not per library chip; the chip grid still marks `other` ownership, and the effective-owner display per chip is left as a residual polish item.
- Files: `lib/teams.ts`, `app/(protected)/admin/teams/page.tsx`, `supabase/migrations/20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql`; tests `lib/__tests__/rpPhase6Additive.test.ts` (DEC-9 describe), `lib/__tests__/rpPhase6Migration.test.ts`.
- Migration: `20261045` — **printed for operator paste; pending apply**.


- **Verification:** CONFIRMED
- **Blast radius:** availability / compliance
- **Locations:**
  - `supabase/migrations/20260824_team_departments.sql:35-38` — the team rung resolves to `teams.supervisor_user_id`
  - `lib/ownership.ts:48-57` — the client mirror
  - `app/(protected)/admin/teams/page.tsx:198-202` — the supervisor `<select>` is populated from **every active org member**, not from the team's members
  - `app/(protected)/admin/teams/page.tsx:54-59` → `lib/teams.ts:84-92` — a bare UPDATE with **no `logAuditAction` call**
  - `lib/teams.ts:94-97` — `deleteTeam` is a bare DELETE; `libraries.owner_team_id` has no FK
  - `app/(protected)/admin/teams/page.tsx:204` — the *only* line of UI that reveals the collapse
- **Related:** `OWN-12`, `OWN-16`, `DEL-4`
- **Re-verified:** hardening pass — **SURVIVES**. `SELECT supervisor_user_id INTO v_owner FROM teams` (`20260824_team_departments.sql:36`) and the mirror at `ownership.ts:50-55` — a single uid, with no succession, no requirement that the supervisor be a member, and no audit of the change.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. All four sub-claims verified: single scalar (no deputy/succession), no FK, no membership requirement, and no audit row — contrast lib/ownership.ts:63-72 setLibraryOwnerTeam, which does log OWNER_TEAM_ASSIGNED. Publish authority genuinely rides on this value via 20260824:35-38 (`SELECT supervisor_user_id INTO v_owner FROM teams` inside user_is_effective_owner).

**Mechanism.** "A team owns the library" is a two-hop pointer that dereferences
to exactly **one person**. Every failure mode of that person is a failure mode of
the library:

- **Supervisor departs** — `OWN-12` applies, one level deeper and less visible.
- **No supervisor** — `supervisor_user_id` is nullable and the picker offers
  "— none —". A team-owned library with no supervisor silently has no owner.
- **Changing supervisors** — transfers publish authority over an entire library,
  instantly, with **no audit row**. (Compare `setLibraryOwnerTeam`, which *does*
  log `OWNER_TEAM_ASSIGNED` — the more consequential of the two writes is the
  unlogged one.)
- **Supervisor need not be in the team** — the dropdown lists the whole org.
- **Deleting the team** — `libraries.owner_team_id` dangles; `team_members`
  cascades away; ownership vanishes silently.

The only disclosure is one line of helper text: *"The supervisor becomes the
effective owner of any library this department owns (unless a more specific owner
is set)."* It does not say that changing the dropdown **transfers publish
authority over every document in those libraries**, does not show which libraries
are affected before you change it, and does not name the current individual owner
of a library you are about to team-own.

**Failure scenario.** An admin promotes the drafting supervisor and updates the
Drafting team's supervisor dropdown. Publish authority over the entire Drawings
library moves to a new person in one click, with zero audit trail. Two weeks
later, during an incident investigation, *"who could have published this revision
on 12 March?"* has no answer.

**Chain reaction.** The team rung also silently **never fires** when a more
specific `owner_user_id` exists — the resolver returns before reaching the team
branch — so an admin who team-owns a library that already has an individual owner
sees no effect and no warning. And two of the six owner resolvers ignore the team
rung entirely (`OWN-16`), so the same library reads as "owned" in the register
and "unowned" in the review-due cron.

**`DEC-9` settles it: keep the rung, fix its four gaps.** Demoting team
ownership to a convenience that writes `owner_user_id` at assignment is
architecturally cleaner and was seriously considered — it is rejected because it
silently changes who owns things in orgs already using it: a library resolving to
a team's supervisor would be frozen to whoever holds that role at migration time,
with no signal. The four fixes below are the whole of the work.

**Done when.**
1. Changing a supervisor writes an audit row naming both people and every
   affected library.
2. Clearing a supervisor on a library-owning team is blocked, or clears the
   ownership with an audit row.
3. Deleting such a team clears `owner_team_id`.
4. The teams page shows, per library chip, the current effective owner and
   whether team ownership would actually take effect.

---

## DEL-4 · Team supervision is administered by Admin/Manager while document control is Admin/DocCtrl — a Manager can mint publish authority

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `app/(protected)/admin/teams/page.tsx:25` — `const isAdmin = activeRole === "Admin" || activeRole === "Manager";`
  - `supabase/migrations/20260707_teams.sql:37-49` — `teams_admin_write` / `team_members_admin_write` allow `role IN ('Admin','Manager')`
  - `supabase/migrations/20260824_team_departments.sql:35-38` — supervisor → effective owner
  - `supabase/migrations/20260816_owner_publish_access.sql:60-62` — effective owner → publish authority
  - `components/permissions/RoleModelTree.tsx:47` — the role tree states Manager has *"No publish authority unless granted per-library or made an owner"*
- **Related:** `OWN-1`, `DEL-3`
- **Re-verified:** hardening pass — **SURVIVES**. `teams_admin_write` and `team_members_admin_write` both admit `role IN ('Admin','Manager')` (`20260707_teams.sql:37-48`), and the UI gate agrees (`admin/teams/page.tsx:25`). Setting a team supervisor makes that person the effective owner of every team-owned library, which is publish authority a Manager otherwise does not hold.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The DB offers no backstop: the only policy on libraries is schema.sql:1060 `CREATE POLICY "libraries_org_access" ON libraries FOR ALL USING (org_id IN (SELECT my_org_ids()))`, so writing `owner_team_id` is unrestricted to any org member, and lib/ownership.ts:66 does exactly that with no controller check. The audit trail records OWNER_TEAM_ASSIGNED but the supervisor swap that actually moves the authority (updateTeam) logs nothing — see DEL-3.

**Mechanism.** Two authority domains designed separately now compose. Teams were
*"named groups for ACL subjects"* (`lib/teams.ts:1-4`); migration `20260824`
turned them into an ownership rung without revisiting who administers them.

**Failure scenario.** A Manager — explicitly *not* a document controller — opens
`/admin/teams`, creates a team, sets themselves as supervisor, and clicks the
Drawings chip under "Owns libraries." They are now the effective owner of every
document in Drawings and can publish revisions. `setLibraryOwnerTeam` logs
`OWNER_TEAM_ASSIGNED` (so this half *is* audited, unlike the supervisor half),
but nothing prevents it and nothing alerts a controller.

**Chain reaction.** This is a **sanctioned-UI version of `OWN-1` and survives
`OWN-1`'s fix**, because the writes go through legitimate policies. It also means
the "Owns libraries" chip grid is a document-control surface rendered on a
people-management page, with no controller in the loop.

The underlying question is worth stating plainly: *"who may make someone an
effective document owner?"* should have exactly one answer across libraries,
folders, documents and teams. Today it has three — controller for folders, any
member for libraries and documents (`OWN-1`), and Admin/Manager for teams.

**Done when.**
1. A Manager without a controller role cannot change a team supervisor, cannot
   assign library ownership to a team, and cannot thereby publish a revision.
2. An Admin/DocCtrl can do all three.
3. Every one of those changes is audited.
4. Team membership and naming remain administrable by Admin/Manager (this is not
   a reason to lock down team management generally).

---

## DEL-5 · Ownership bundles roster authority and publish authority, so an owner can be sole reviewer of their own revision

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-01, roles-and-permissions Phase 6 — built per `DEC-21`).** Reviewer independence is now a per-library policy, ON by default wherever a required-review roster is configured and opt-out via `review_control.requireIndependentReviewer = false` (a checkbox in the library's review-control modal, so it reads as a visible policy). Database (`20261045`): inside `enforce_document_publish_guard`'s completion check — deliberately above the role short-circuit, as a data-integrity gate — when the publisher is themselves on the version's roster, at least one signed PRIMARY must be someone else, or the promote is refused with a message that names the rule. App: `reviewCompletionForDraft(documentId, versionId, actorId)` applies the same rule, `recordReviewSignoff` judges completion for the signer as would-be publisher (so a sole primary's own signature no longer auto-finalizes), and `finalizeReviewedRevision` reports `needs_independent_reviewer`. The bundling of roster authority and publish authority in one flag remains (an owner still configures the roster) — what this closes is its safety consequence: an owner can no longer be the sole reviewer of their own revision.
- DEC-21 acceptance: ✓ a sole signed primary cannot publish their own revision in a roster-configured library; ✓ a signer alongside an independent primary can; ✓ a library with no roster is unaffected (the clause binds only when `v_primary_reqs > 0`); ✓ opt-out per library.
- Files: `supabase/migrations/20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql`, `lib/reviewControl.ts`, `types/schema.ts`, `components/documents/ReviewControlModal.tsx`; tests `lib/__tests__/rpPhase6Additive.test.ts` (DEC-21 describe), `lib/__tests__/rpPhase6Migration.test.ts`.
- Migration: `20261045` — **printed for operator paste; pending apply**.


- **Verification:** CONFIRMED
- **Blast radius:** safety / compliance
- **Locations:**
  - `components/documents/InspectorPanel.tsx:718-732` — `ReviewSection`, `AckSection` and `ReviewGateSection` all receive `canManage={canPublishEff}` = `canPublish || isOwner`
  - `supabase/migrations/20260822_review_completion_guard.sql:44-58` — the completion gate counts signed primaries; **it does not care who they are**
  - `supabase/migrations/20260830_publisher_row_management.sql:36-50` — owners may update roster rows
  - a search of `lib/reviewControl.ts` finds **no author/self-review exclusion**
- **Related:** `OWN-1`, `OWN-11`, `WF-4`, `WF-14`
- **Re-verified:** hardening pass — **SURVIVES**. `canManage={canPublishEff}` is passed to both `ReviewersSection` and `AckSection` (`InspectorPanel.tsx:718-726`), so one flag governs who sets the roster and who publishes. The DB guard (`20260822_review_completion_guard.sql:44-55`) counts signatures but never compares signer to publisher.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence — a repo-wide search for any self-review/separation-of-duties predicate (author vs reviewer, created_by vs reviewer_user_id) returns nothing in lib/reviewControl.ts or any migration. lib/reviewControl.ts:287-303 recordReviewSignoff signs whatever signoffId it is given with no actor-vs-owner comparison, and finalize auto-publishes on the last signature.

**Mechanism.** The review gate enforces *that* the roster is complete. It never
enforces that the roster contains anyone other than the publisher.

**Failure scenario.** A document owner sets the review roster to themselves as
the single primary reviewer, signs their own row, and the completion guard
passes. A revision to a safety-critical procedure is issued with a self-signed
review that looks, in the audit trail, **exactly like an independent one**.

**Chain reaction.** This escalates every ownership finding in report 05: `OWN-1`
lets *anyone* become the owner, at which point this becomes a complete
self-service path from Viewer to "reviewed and issued." It also undercuts the
e-signature record, which binds to the content hash but not to reviewer
independence.

Note the symmetry with `WF-4` and `WF-14` on the ticket side — the same
"no second human" gap exists in both approval systems, independently. Any
independence rule should be a per-library policy rather than a global one, since
some low-criticality libraries legitimately want single-person review; and it
should be visible where the roster is configured, so it reads as a policy
decision rather than an invisible gap.

**Done when.**
1. A user who is the sole signed primary on a revision cannot publish it, where
   the library's policy requires independence.
2. A user who signed alongside an independent primary can.
3. The behaviour is stated in the review-gate UI.

---

## DEL-6 · Owners are told to recertify library access and cannot

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / ux
- **Locations:**
  - `lib/accessRecert.ts:127-146` — `scanAccessRecerts` notifies `[ownerId, ...controllers]`
  - `lib/accessRecert.ts:3-4` — the module header: *"the library's owner / Admin / DocCtrl reviews who has access"*
  - `app/(protected)/documents/[libraryId]/page.tsx:3372-3380` — the "Access recertification" menu item is inside `{isController && ( … )}`
  - `components/permissions/PermissionsExplorer.tsx` — the matrix row claims `"If library owner"`
- **Related:** `DEL-1`, `OWN-1`
- **Re-verified:** hardening pass — **SURVIVES**. `accessRecert.ts` targets `[ownerId, ...controllers]` (`:135-136`) while the ACL edit surface is controller-gated. The owner is asked to perform a review they have no control to complete.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. All three legs verified: the owner is notified, the owner cannot reach the modal (AccessRecertModal is rendered only behind `recertOpen`, set only from that controller-gated menu item), and the published matrix claims owners can do it. lib/accessRecert.ts:3-4's own header says "the library's owner / Admin / DocCtrl reviews who has access".

**Mechanism.** The notification targets and the UI gate were written against
different mental models and never reconciled. Three places in the codebase say
owners can do this; the gate says they cannot.

**Failure scenario.** A non-controller library owner receives "Access recert
overdue: Drawings" every seven days. The library's 3-dot menu shows them nothing.
The recertification never happens, the notification never stops, and the
published capability matrix says they can do it.

**Chain reaction.** Same shape as `DEL-1`, opposite direction: a power the
product documents and notifies about but does not expose. It also means
`next_recertification_date` can only ever be cleared by a controller, so the
"delegate the compliance chore" premise of ownership does not hold for this
control. Note that `AccessRecertModal` writes to `libraries` — which `OWN-1`'s
fix will restrict — so these two interact.

**Done when.** The set of people who receive the recert notification is exactly
the set who can perform it, and `PermissionsExplorer`'s row matches the enforced
behaviour.

---

## DEL-7 · Nobody can see who owns what — no ownership register above the document level, and the one entry point is mislabelled

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / ux
- **Locations:**
  - `lib/docControlRegister.ts:92-197` + `app/(protected)/register/page.tsx` — the register enumerates **documents only**
  - `lib/docControlRegister.ts:201` — `RegisterFilter` has `"unowned"` for documents; no library/folder equivalent
  - `app/(protected)/admin/permissions/page.tsx:76-91` — the permissions console lists libraries, folders and documents with visibility and rule counts, and **no owner column**
  - `components/permissions/RoleModelTree.tsx:227-238` — the only place library owners are listed, buried three folds deep
  - `app/(protected)/documents/[libraryId]/page.tsx:3327-3334` — the only way to *set* a library owner is a menu item labelled **"Review cycle"**, tooltipped *"Set a periodic-review cycle for every document in this library"*
  - `app/(protected)/admin/libraries/LibraryWizard.tsx` — **no owner field anywhere**, so libraries are born unowned
- **Related:** `OWN-12`, `DEL-8`
- **Re-verified:** hardening pass — **SURVIVES**. `loadDocControlRegister` selects from `documents` only (`docControlRegister.ts:94-103`). No register exists at library or folder level, and `RegisterFilter` (`:201`) offers `unowned` for documents alone.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives, with one softening the finding already concedes in its own location list: RoleModelTree.tsx:227-238 does render a live per-library owner list ("Live: library owners & publish grants"), so "no screen answers it" is strictly true only for folders and for export; for libraries it is buried rather than absent. Note that fold selects `owner_name` without `owner_user_id` (RoleModelTree.tsx:145), which is the DEL-8 defect.

**Mechanism.** Ownership was built as an attribute of the review-cycle feature
and never promoted to a first-class concept with its own surface.

**Failure scenario.** An auditor asks *"show me the owner of every controlled
library and folder."* There is no screen and no export that answers it. The
closest artifact, the register CSV, answers it per document and only via the
denormalized name string (`DEL-8`).

**Chain reaction.** Because folder ownership is invisible, the middle rung of the
chain is the one that silently overrides library ownership with no indication —
an admin sets a library owner and wonders why half the documents report someone
else. The Inspector *does* show the source (rendering "· from folder/library")
but only one document at a time, and never says "· from team."

**The narrow, high-value version of this fix:** the permissions console already
loads every library, folder and document. Adding effective owner and owner-source
to each row is a read-only extension of an existing query and gives admins the
register they lack. Renaming the "Review cycle" menu item is a one-line honesty
fix with no dependencies.

**Done when.**
1. An admin can see, in one screen and one export, the effective owner and owner
   source of every library, folder and controlled document.
2. Libraries with no owner are countable.
3. Assigning a library owner is reachable from something named after ownership.

---

## DEL-8 · `owner_name` is a denormalized snapshot that drifts, and is the only thing most surfaces render

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness / compliance
- **Locations:**
  - `supabase/migrations/20260630_document_ownership.sql:10,12,14` — `owner_name TEXT`, written alongside the uid
  - `lib/ownership.ts:130` — written once, never refreshed
  - `lib/ownership.ts:27` — `resolveEffectiveOwner` returns `name: lvl.owner_name ?? null`; it never re-resolves from the uid
  - `lib/docControlRegister.ts:233` — the auditor CSV prints `r.ownerName ?? "Admin/DocCtrl"`
  - `components/permissions/RoleModelTree.tsx:232` — `owner: {l.ownerName || (team ? … : "none")}`
  - `lib/docControlRegister.ts:216` — `filterRegister` searches on `r.ownerName`
- **Related:** `DEL-7`, `OWN-21`
- **Re-verified:** hardening pass — **SURVIVES**. `owner_name TEXT` is a plain denormalized column (`20260630_document_ownership.sql:10`) written beside `owner_user_id` (`ownership.ts:130`) and never re-synced when the person's display name changes.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence: repo-wide, nothing updates `owner_name` on a profile/display-name change — no trigger, no backfill, and users/org_members display_name writes (e.g. create-user/route.ts:165) never touch it. The RoleModelTree case is worse exactly as described: since owner_user_id is not even fetched, an owned library with a null owner_name renders as team-owned or as "none → falls to Admin/DocCtrl".

**Mechanism.** Nothing re-syncs `owner_name` when `org_members.display_name`
changes, when the person is removed, or when the owner is inherited from a team
supervisor (that path returns a live-resolved name but never persists it, so the
two rungs are inconsistent by construction).

**Failure scenario.** An owner changes their surname. Every register row, every
CSV export and every role-tree line keeps the old name indefinitely. Worse in the
`RoleModelTree` case: because the render is `ownerName || team`, a row where
`owner_user_id` is set but `owner_name` is null — which happens for any owner
written outside `setOwner`, e.g. `lib/dataRestore.ts:259` remaps
`owner_user_id` with no corresponding name repair — **displays the team as
owner, which is the opposite of what `user_is_effective_owner` computes.**

**Chain reaction.** The drift is invisible precisely where it matters — the
auditor artifact. And because the register searches on `ownerName`, searching by
a person's current name misses their documents.

**The rule worth extracting:** never branch on `owner_name` to decide *whether*
there is an owner — branch on `owner_user_id`, as `resolveEffectiveOwner`
correctly does and `RoleModelTree` incorrectly does not.

**Done when.**
1. Renaming a member updates their name everywhere the register and role tree
   display it.
2. A document whose `owner_user_id` is set but `owner_name` is null shows the
   resolved person, not the owning team.
3. The CSV distinguishes a live owner from a departed one.

---

## DEL-9 · Client-side owner resolution runs under the caller's RLS, so the app and the database disagree about who the owner is

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness / compliance
- **Locations:**
  - `lib/ownership.ts:40,43,79` — `effectiveOwnerForDocument` / `isEffectiveOwnerOfDocument` read `collections`, `libraries` and `documents` **through the browser client**
  - `lib/docControlRegister.ts:110-111` — loads libraries and collections with `.eq("org_id", orgId)` and nothing else
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:89-91` — `collections_acl_select` hides `private`/`hidden` folders without a grant
  - `supabase/migrations/20260824_team_departments.sql:19` — the SQL resolver is `SECURITY DEFINER` and sees everything
- **Related:** `DEL-2`, `OWN-16`
- **Re-verified:** hardening pass — **SURVIVES**. `ownership.ts:40` and `docControlRegister.ts:110-111` read `collections`/`libraries` through the **anon client under the caller's RLS**, while the database resolves ownership through `user_is_effective_owner`, a `SECURITY DEFINER` function that sees every row. The two answer differently for the same document.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the client resolver runs under caller RLS and the DB guard bypasses it, so the two genuinely disagree whenever an intermediate folder is invisible to the viewer. Scenario is reachable because visibility is per-node and never inherited (lib/acl.ts:190 resets to 'normal'), so a 'normal' document inside a private folder is DB-visible while its folder is not. Impact is a UI/notification lie plus a publish button that the DB trigger then rejects — not privilege escalation — so MEDIUM is right.

**Mechanism.** When a folder is invisible to the reader, the folder lookup misses
and the chain **skips a rung** — resolving to the *library* owner instead of the
*folder* owner. The database never skips.

**Failure scenario.** A document sits in a `private` folder owned by the process
lead, inside a library owned by the safety lead. A drafter who can see the
document but not the folder opens the Inspector: the app resolves the safety lead
as owner. The register shows the same. The publish guard resolves the process
lead. **Two different people are shown as accountable for the same record
depending on who is looking.**

**Chain reaction.** Combined with `DEL-2` this produces the sharpest version: an
actual owner whose own folder row is invisible to them is told by
`isEffectiveOwnerOfDocument` that they are **not** the owner, so the Inspector
hides the publish button the database would honour — and the reverse case shows
an enabled button that the database then rejects. The register's org-wide KPIs
are likewise per-viewer, though the page presents them as facts about the org.

**The structural direction:** owner resolution is an authorization question and
should not run under the asker's read privileges. Exposing the existing
`SECURITY DEFINER` SQL resolver as an RPC would also collapse `OWN-16`'s six
implementations into one by construction.

That is a multi-file change, so **apply `DEC-31`: ship the narrow fix first.**
`DEC-7`'s ownership branch in `node_visible` makes the owner's own folder row
visible to them, which resolves this finding's sharpest case — an owner told they
are not the owner — without touching six files. If the register and the guard
still disagree afterwards, open a new finding for the resolver consolidation.

**Done when.**
1. Two users with different folder visibility see the same owner for the same
   document.
2. The Inspector's publish button state matches what the database will accept in
   a fixture where the folder is private.
3. `/register`'s owner column matches `user_is_effective_owner` for every row.

---

## Verified sound — do not break

1. **The zero-teams path.** Every team lookup degrades correctly (see the table
   at the top of this report). **Do not introduce a `NOT NULL` team requirement
   anywhere in the ownership chain.**
2. **The ownership chain's precedence order** — `document > folder > library >
   team supervisor` is identical in `lib/ownership.ts:24-30,44-57` and
   `supabase/migrations/20260824_team_departments.sql:25-39`, including the
   subtle and correct rule that an explicit owner at a level **stops** the walk
   even if it does not match the caller. **Do not "fix" that to a fallthrough —
   it is what makes delegation meaningful.** (`DEL-1` is about the fact that
   *replacing* is currently the only delegation primitive, not about this rule
   being wrong.)
3. **`collections` write protection is the model the other tables should copy** —
   `collections_insert_controllers` / `collections_update_controllers` plus
   `enforce_document_move_guard` are exactly the posture `libraries` needs
   (`OWN-1`).
4. **`is_org_controller` is the correct additive-aware controller helper** and
   already exists. Most of the additive-roles remediation is substitution into
   existing call sites, not new logic.
5. **`documents_guard_access_change` / `can_manage_node`** is a well-built,
   well-commented mirror of `lib/acl.ts` evaluation semantics, including
   deny-precedence and the `admin`-implies-everything rule. It is the right
   template for the missing `libraries` guard.
6. **The register's `.or("status.is.null,status.not.in.(…)")`**
   (`lib/docControlRegister.ts:98-101`) correctly keeps NULL-status controlled
   records in scope — a real SQL-NULL trap that was already found and fixed.
   **Do not simplify it back to `.not.in`.**
7. **`registerToCsv` and `computeRegisterKpis` are pure and tested.** Keep them
   pure; add any owner-source column there rather than in the page.
8. **The `capabilityPolicy` delegation primitive is well-built** — additive-only,
   expiring, guardrailed against removing Admin from critical capabilities, and
   audited with full before/after including a **hard error check on the save**.
   It is the quality bar `lib/ownership.ts`'s writes should be raised to
   (`OWN-13`), and the right precedent if per-file delegation ever needs an
   expiry model. (Its own defects are `WF-1`, `WF-10`, `WF-11`, `WF-16`.)
9. **Review sign-off remains own-row-only for everyone.** Owners and publishers
   may *manage* roster rows (activate alternates, void stale ones) but signing is
   bound to `reviewer_user_id = auth.uid()`, and DELETE stays controller-only.
   **Do not widen this while fixing `DEL-1`.**
