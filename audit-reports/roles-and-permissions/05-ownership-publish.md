> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T23:55Z — fixing Phase 3 (publish path)

# 05 · Ownership & publish authority

> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T00:30:00Z

The axis the first pass missed entirely. Library, folder and document ownership
is a **fifth, independent authority path** — it is not a role, it is not a
capability, it is not an ACL rule, and it grants the right to publish and
supersede controlled documents.

**21 findings** — 5 CRITICAL, 10 HIGH, 6 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**

---

## The concept map

There are **six** distinct "ownership" concepts in this codebase. Three of them
grant publish authority. They are stored in different places, set from different
screens, and protected by different rules (or none).

| Concept | Storage | Set from | DB write gate | What it grants |
|---|---|---|---|---|
| **Library owner** | `libraries.owner_user_id` + `owner_name` | Library actions → **"Review cycle"** modal | **NONE** | Effective owner of every document in the library with no doc/folder owner → publish + supersede past the guard |
| **Folder owner** | `collections.owner_user_id` | same modal, `level:"collection"` | `collections_update_controllers` (Admin/DocCtrl) | Same, folder-scoped |
| **Document owner** | `documents.owner_user_id` | Inspector → Review section | **NONE for this column** | Publish/revert that document, manage its rosters, request deletion, the Manage & lifecycle drawer |
| **Owner team** | `libraries.owner_team_id` → `teams.supervisor_user_id` | Admin → Teams | `teams_admin_write` on the team; the library column itself is **ungated** | The team's *supervisor* — a single person — becomes effective owner |
| **Effective owner** | derived, not stored | — | — | `document > folder > library > library's team supervisor`. Implemented **six times** (`OWN-16`) |
| **Granted publisher** | `libraries.acl_index` → `allow.{users,roles,teams}.publish\|admin` | Permission drawer | documents' index is guarded; **libraries' index is not** | Publish in that one library |

Two adjacent axes leak into this surface: **project owner**
(`projects.owner_user_id`, see `OWN-4`) and **controller tier**
(`role IN ('Admin','DocCtrl')`).

### The canonical resolver

`user_is_effective_owner(p_doc_owner, p_collection, p_library, p_uid)` —
`SECURITY DEFINER STABLE SET search_path = public`. Defined at
`supabase/migrations/20260816_owner_publish_access.sql:9` and **redefined** at
`supabase/migrations/20260824_team_departments.sql:18` (the winning definition,
which adds the team fallback).

Five call sites, all of them authority decisions:

| Call site | What it authorizes |
|---|---|
| `supabase/migrations/20260822_review_completion_guard.sql:70` | **The live publish/supersede guard** |
| `supabase/migrations/20260828_integrity_hardening.sql:237` | Review sign-off row management |
| `supabase/migrations/20260828_integrity_hardening.sql:272` | Acknowledgment row management |
| `supabase/migrations/20260830_publisher_row_management.sql:43` | Publisher row management |
| `supabase/migrations/20260830_publisher_row_management.sql:64` | Publisher row management |

**It reads neither `org_members.role` nor `org_members.roles`, and performs no
membership or `status` check at all.** See `OWN-13`.

---

## The complete set of publish / supersede paths

Seventeen ways a document's controlled revision can advance. Six of them do not
reach the database guard.

| # | Path | Entry point | Client check | DB guard |
|---|---|---|---|---|
| 1 | Rev-up | `lib/revisions.ts:395` → `authorizePublish:214` → `publish_revision` RPC | library grant ∥ effective owner; **no `teamIds`** (`OWN-6`) | ✅ trigger on the promote |
| 2 | Legacy rev-up | `lib/revisions.ts:758-835` | same as #1 | ✅ trigger |
| 3 | Revert | `lib/revisions.ts:1146` → `authorizePublish:1155` | same as #1 | ✅ trigger |
| 4 | Supersede document | `lib/revisions.ts:1414` → `authorizePublish:1425` | same as #1 | ✅ trigger |
| 5 | Submit for review | `lib/revisions.ts:847` → `authorizePublish:859` | same as #1 | ❌ writes `pending_version_id` only — not "advancing" |
| 6 | Review finalize (manual) | `lib/reviewControl.ts:395` | **none** | ✅ trigger + completion gate |
| 7 | Review finalize (**auto**) | `lib/reviewControl.ts:324-331` | **none** | ✅ trigger — under the *last signer's* identity (`OWN-12`) |
| 8 | Intake approve | `components/projects/IntakePanel.tsx:237` | project-scoped `canManage` | ✅ trigger |
| 9 | **Intake auto-supersede** | `app/api/intake/upload/route.ts:322-329` | **token only, no account** | ❌ **service role — guard skipped (`OWN-4`)** |
| 10 | **`publish_revision`, branch mode** | `supabase/migrations/20260828_integrity_hardening.sql:170-180` | none | ❌ **`documents` never touched ⇒ no trigger (`OWN-5`)** |
| 11 | Split / merge | `lib/documentLifecycle/split.ts:137`, `merge.ts:191` | none in lib | ✅ trigger (`→ 'Superseded'`) |
| 12 | **Reverse split / merge** | `lib/documentLifecycle/reverse.ts:118-126`, `:213-222` | client-only | ❌ **not an advancing transition (`OWN-15`)** |
| 13 | New-doc creation | `lib/documentLifecycle/common.ts:225-229` | library write/ACL | ❌ by design — `OLD` has no current version |
| 14 | **Backfill historical version** | `lib/revisions.ts:1594` | **none** | ❌ `document_versions` insert only (`OWN-17`) |
| 15 | **Revision label correction** | `lib/revisions.ts:1051` | client-only | ❌ not advancing (`OWN-17`) |
| 16 | **Archive / unarchive** | `lib/revisions.ts:1325`, `:1357` | none | ❌ not advancing (`OWN-15`) |
| 17 | Delete → null `current_version_id` | `app/(protected)/documents/[libraryId]/page.tsx:1224-1234` | `isController` | ✅ trigger (and passes) |

---

## OWN-1 · `libraries` has no restrictive RLS — any member can make themselves the library owner

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, roles-and-permissions Phase 3).** Confirmed — `libraries` had exactly one policy (`FOR ALL USING (org membership)`, no WITH CHECK, no trigger): any member could take ownership of any library, rewrite its ACL, or delete it. Per Trap 2, `OWN-14` shipped FIRST (a write-path recon mapped **21 static + 9 dynamic-table writers**; seventeen were silent). Rails in migration `20261036`:
- **`trg_library_sensitive_columns`** (BEFORE UPDATE, service-role pass): changing any of the 17 SENSITIVE columns — ownership (`owner_user_id/name/team`), access (`acl`, `acl_index`, `write/admin/read_access`, `visible_to`, `folder_security`, `default_new_*`), compliance policy (`review_control`, `review_policy`, `retention_policy`, `ack_policy`, `recert_policy`) — requires a controller, the library's CURRENT owner, or an ACL manage-grant (`can_manage_node`). Cosmetic columns (names, descriptions, custom columns, column widths, layouts) stay member-writable, so the seventeen shipped convenience writers keep working — the guard-vs-policy split is exactly what the write-path map bought.
- **`libraries_delete_controllers`** — RESTRICTIVE, DELETE is controllers-only (both app delete sites already check errors).
- Done-when: (1) non-controller/non-owner cannot change owner/acl/review_control via PostgREST — trigger-refused, pinned by test ✓; (2) every app call site fails loudly (OWN-14) or keeps working (cosmetic set) ✓; (3) DELETE controllers-only ✓.
- The migration's verification block also proves all 17 guarded columns exist (plpgsql binds late — a missing one would break every library update) and carries the DEC-30 inventory queries (non-controller library owners; owned-document count).
- Tests: `lib/__tests__/rpPhase3Migration.test.ts` — every sensitive column asserted by name in the guard body; the three authority arms; RESTRICTIVE delete shape.
- **Applied & verified live 2026-08-24:** `20261036` — probe true; DEC-30 inventory all ZERO (no non-controller owners, no owned documents, no unreconciled branches — the rails enforce against a blank slate).
- **Verification:** CONFIRMED
- **Blast radius:** security / data-integrity / safety
- **Locations:**
  - `supabase/schema.sql:1060` — `CREATE POLICY "libraries_org_access" ON libraries FOR ALL USING (org_id IN (SELECT my_org_ids()))`
  - `supabase/schema.sql:1031-1034` — `my_org_ids()` returns every org where the caller is an active member **of any role**
  - `supabase/migrations/20260824_team_departments.sql:33` — `user_is_effective_owner` reads `libraries.owner_user_id`
  - `supabase/migrations/20260812_per_library_publish_authority.sql:56` — `user_can_publish_on_library` reads `libraries.acl_index`
  - `supabase/migrations/20261011_collections_guard_and_trash.sql:30-34` — the pattern `libraries` is missing, present on `collections`
- **Related:** `OWN-2`, `OWN-14`, `DB-4`
- **Re-verified:** hardening pass — **SURVIVES**. `libraries_org_access FOR ALL USING (org_id IN my_org_ids())` with no `WITH CHECK` and no role predicate — `USING` is reused as the UPDATE check, so any active member may rewrite `owner_user_id`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Right, and if anything understated: documents_org_access (schema.sql:1066) is equally permissive, so an attacker can set documents.owner_user_id directly and skip the library step entirely. CRITICAL stands.

**Mechanism.** `libraries` carries exactly one policy. A `FOR ALL` policy with
only a `USING` clause reuses that same expression as the `WITH CHECK` for
`INSERT` and `UPDATE`. There is no `AS RESTRICTIVE` policy on `libraries`
anywhere in the migration set, and no trigger on the table. So a `Viewer` — the
lowest role in the system — can issue:

```
PATCH /rest/v1/libraries?id=eq.<lib>
{ "owner_user_id": "<self>", "owner_name": "Me" }
```

`user_is_effective_owner(NULL, NULL, <lib>, me)` now returns true →
`enforce_document_publish_guard` sets `v_can_publish := true` → the caller can
publish and supersede **every document in that library** that has no explicit
document or folder owner.

The same single request can instead write `acl_index` directly
(`{"allow":{"users":{"publish":["<self>"]}}}`), or write
`review_control = {"mode":"none"}` to switch off the pre-publish review
requirement for the entire library, or `DELETE` the library — which cascades to
`documents`.

**Failure scenario.** A contractor with `Viewer` on a P&ID library issues one
HTTP request, becomes the library owner, and publishes a modified Rev 4 of a
PSM-covered P&ID. The publish guard **approves** it, because by the time the
guard runs the attacker genuinely is the owner. `audit_logs` records a
legitimate `REV_UP` by an authorized owner. Doc Control sees nothing anomalous:
the ownership change itself is only audited by the app path, which was not used.

**Chain reaction.** ⚠ **This fix cannot ship alone.** Adding
`libraries_update_controllers AS RESTRICTIVE FOR UPDATE` will immediately start
refusing every non-controller write to `libraries` that the app performs today:
`lib/ownership.ts:66` (`setLibraryOwnerTeam`), `lib/ownership.ts:130` (`setOwner`
level `library`), `lib/reviewControl.ts:144` (`setReviewControlPolicy`),
`lib/reviewCycles.ts` (`setReviewPolicy`),
`components/permissions/PermissionDrawer.tsx:284`, and the library-config
surfaces in `app/(protected)/admin/libraries/page.tsx`. **Every one of those uses
`.update()` without `.select()`, so they will fail silently** — zero rows, no
error — rather than raising. Resolve `OWN-14` **first** or this converts a
security hole into an invisible-data-loss hole.

**Remediation (illustrative — do not apply verbatim).** Mirror the shape already
used on `collections` at `20261011_collections_guard_and_trash.sql:30-34`. Decide
deliberately whether library owners themselves may edit their own library row, or
only controllers.

**Done when.**
1. A non-controller, non-owner member cannot change `libraries.owner_user_id`,
   `owner_team_id`, `acl_index`, `acl`, or `review_control` through PostgREST,
   demonstrated by a test that attempts it and asserts refusal.
2. Every app call site that writes to `libraries` either still succeeds for the
   roles that legitimately need it, or fails **loudly** (`OWN-14`).
3. `DELETE` on `libraries` is restricted to controllers.

---

## OWN-2 · `documents.owner_user_id` is not covered by the access-change guard

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, roles-and-permissions Phase 3, with DEC-6).** Confirmed — `documents_guard_access_change` guarded `visibility`/`acl`/`acl_index` but not the owner columns, and the effective owner carries PUBLISH authority (`user_is_effective_owner` in the publish guard), so a self-assigned owner was a self-granted publisher. Migration `20261036` re-creates the guard (original block byte-carried) adding: a change to `owner_user_id`/`owner_name` requires a controller, an ACL manage-grant, or the document's CURRENT owner. Per DEC-6's acceptance: a Viewer's direct PATCH to self is refused; the current owner reassigns through the Inspector (owner arm); a controller always can; and FIRST assignment on an unowned, default-open document stays open — the deliberate, recorded scope note: on unrestricted libraries any member may still make the initial assignment (matching the existing guard's default-open escape hatch and keeping `ReviewSection`'s "Assign owner" working), but a TAKEOVER of an owned document is always refused.
- Done-when: (1) refusal for non-controller/non-owner/non-granted ✓; (2) the intended reassignment flow works and the decision is written down (this record + the migration comment) ✓; (3) tests cover refusal arms and the claim escape ✓ (shape pins; the live probe is in the migration's verification).
- Tests: `lib/__tests__/rpPhase3Migration.test.ts`.
- **Applied & verified live 2026-08-24:** `20261036` — probe true (documents guard covers ownership; all 17 guarded library columns exist).
- **Verification:** CONFIRMED
- **Blast radius:** security / data-integrity / safety
- **Locations:**
  - `supabase/migrations/20260816_documents_access_change_guard.sql:84-86` — the guard fires only on `visibility`, `acl`, `acl_index`
  - `supabase/schema.sql:1068` — `documents_org_access FOR ALL USING (org_id IN (SELECT my_org_ids()))`
  - `supabase/migrations/20260901_db_hard_enforcement.sql:152-162` — the RESTRICTIVE update guard blocks only when an **explicit deny** already exists
  - `supabase/migrations/20260822_review_completion_guard.sql:70` — the guard that then trusts `owner_user_id`
- **Related:** `OWN-1`, `OWN-5`
- **Re-verified:** hardening pass — **SURVIVES**. `documents_guard_access_change()` fires only on `visibility`, `acl`, `acl_index` (`20260816…:84-86`); `grep -c owner_user_id` on that migration returns **0**. Ownership — which decides publish authority — is outside the guard, and `documents_org_access FOR ALL` lets any member change it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Repo-wide grep confirms only three triggers exist on `documents` (trg_document_publish_guard, documents_guard_access, trg_documents_move_guard) and none of them looks at owner_user_id; `grep -n owner_user_id 20260816_...sql` returns nothing. Worse than stated: the publish guard reads NEW.owner_user_id, so a single UPDATE that sets both owner_user_id and current_version_id self-authorizes in one statement.

**Mechanism.** Migration `20260816` was written specifically to close "a member
could grant themselves in `acl_index`." It closed the ACL vector and left the
**ownership** vector — which grants strictly more (publish + supersede + roster
management) — open on the same table, in the same `UPDATE`, on the same row.
The guard's condition, verbatim:

```sql
IF (NEW.visibility IS DISTINCT FROM OLD.visibility
    OR NEW.acl IS DISTINCT FROM OLD.acl
    OR NEW.acl_index IS DISTINCT FROM OLD.acl_index) THEN
```

`UPDATE documents SET owner_user_id = auth.uid()` passes everything: it is not
an advancing transition, not an ACL change, not a folder move, and
`documents_deny_write_guard` only bites if someone had already written an
explicit `write`/`editMetadata` deny naming that user.

**Failure scenario.** Any org member picks the one drawing they want changed,
claims it, publishes a revision over the real owner's work, and the database
records them as the accountable owner who approved it.

**Chain reaction.** Adding `owner_user_id` and `owner_name` to the `20260816`
guard's column list is a two-line change and the highest-leverage fix in this
report. But it will then also block `lib/ownership.ts:130` for owners
reassigning ownership within their own scope, which the UI currently permits
(`components/documents/ReviewSection.tsx:194`, shown when
`canManage = isController || isOwner`). Decide whether an owner may hand
ownership on, and encode that in the guard rather than removing it. Downstream
readers of the column: `lib/ownership.ts:79`, `lib/docControlRegister.ts:155`,
`lib/reviewCycles.ts:283`, `lib/acknowledgments.ts:589`,
`lib/reviewControl.ts:576`, `lib/retention.ts:189`, `lib/effectiveDate.ts:74`,
`components/documents/InspectorPanel.tsx:277`,
`components/documents/CheckInPanel.tsx:99`.

**Done when.**
1. A member who is neither a controller, nor the current effective owner, nor
   ACL-granted `managePermissions` cannot change `documents.owner_user_id`.
2. The intended owner-reassignment flow still works for whoever the owner
   decides may perform it, and that decision is written down.
3. A test covers both the refusal and the permitted case.

---

## OWN-3 · Adding a second role to your Doc Control manager silently strips their publish authority

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / access-control
- **Locations:**
  - `lib/roleCapabilities.ts:74-94` — `ROLE_RANK`: `Manager: 90`, `Supervisor: 80`, `DraftingSupervisor: 75`, **`DocCtrl: 70`**
  - `lib/roleCapabilities.ts:120-123` — `primaryRole()` returns the highest-ranked role
  - `app/(protected)/admin/users/page.tsx:130,137` — `const headline = primaryRole(cleaned); … .update({ roles: cleaned, role: headline })`
  - `supabase/migrations/20260822_review_completion_guard.sql:60-64` — `SELECT role INTO v_role … IF v_role IN ('Admin','DocCtrl')` — **singular only**
  - `supabase/migrations/20260812_per_library_publish_authority.sql:48-52` — singular only
  - `supabase/migrations/20260828_integrity_hardening.sql:85-89` — `publish_revision`'s `v_is_controller`, singular only
  - `supabase/migrations/20260814_documents_delete_controllers.sql:31-38` — `is_org_controller` **is** additive
- **Related:** `ADD-1`, `ADD-3`, `DB-3`
- **Re-verified:** hardening pass — **SURVIVES**. `ROLE_RANK` ranks `Manager: 90` and `Supervisor: 80` above `DocCtrl: 70`, and `primaryRole` returns the highest. Adding either role to a DocCtrl flips the mirrored `role` column that the publish policies read. Same defect class as `identity-and-session/ORGSEL-3`, which reaches it from the write side.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on both sides: the app also degrades — RoleContext.tsx:200-213 sets `activeRole = primaryRole(collection)`, so the DocCtrl+Manager member loses `isControllerRole` in the UI too. The additive-aware helper `is_org_controller` (20260814:31-38, `role IN (...) OR roles && ARRAY['Admin','DocCtrl']`) exists but is NOT called by the publish guard or by user_can_publish_on_library, so it does not rescue the path.

**Mechanism.** A person who is `DocCtrl` **and** `Manager` gets
`org_members.role = 'Manager'` written by the admin UI, because Manager
outranks DocCtrl. Every database check that reads the singular `role` now says
"not a controller"; every check that goes through `is_org_controller()` still
says "controller." The resulting split is concrete:

| They can | They cannot |
|---|---|
| ✅ **Delete** the document (`is_org_controller`) | ❌ **Publish a revision** of it |
| ✅ **Move** it between folders | ❌ Force past a lock/hold via `publish_revision` |
| ✅ Edit folders | ❌ Appear in `getOrgControllers()` — they drop out of every fallback-owner list, escalation, and intake notification |

**Failure scenario.** The owner promotes their doc-control manager to also cover
people-management. Next morning nobody can publish, and the only fix — visible
nowhere in the UI — is to remove the Manager role.
`components/permissions/RoleModelTree.tsx:117` lists this as a "known gap" ("a
few older checks still read only the headline role"), which understates it: the
publish guard is not an old check, it is *the* check.

**Chain reaction.** Two candidate fixes, and **they must not both be applied**:

- Make the three publish-path SQL functions additive
  (`COALESCE(roles, ARRAY[role])`, as `org_capability_allows` already does). This
  changes who can publish **upward**. Audit `org_members` for
  `roles && ARRAY['Admin','DocCtrl'] AND role NOT IN ('Admin','DocCtrl')` before
  shipping — note `DB-3`, which says that `COALESCE` idiom is currently a no-op.
- Rerank `DocCtrl` above `Manager`. This silently **removes** Manager-tier ticket
  powers from those same people.

**Done when.**
1. A member holding `DocCtrl` as a non-headline role has the same publish and
   supersede authority as one holding it as their headline role.
2. A test pins the `roles=['Manager','DocCtrl']` case against the publish path.
3. `getOrgControllers()` returns them.

---

## OWN-4 · External intake auto-supersede publishes controlled revisions with zero authority, hold, or review checks

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, roles-and-permissions Phase 3).** Confirmed — the intake route runs service-role end to end, so every publish rail (holds, the per-library authority guard, checkout locks, review) was structurally bypassed on the `allow_auto_supersede` fast path, and the route stamped `review_state: 'approved'` on uploads no one reviewed. Fixed in `app/api/intake/upload/route.ts`; any failed gate DEMOTES the upload to the existing pending-review path (the file is still wanted — only the instant promote is withheld), with the reason in the team notification, the audit row, and the uploader's response:
1. **Holds always block the promote** — `legal_hold` and active `document_holds` are checked, and an errored hold read fails CLOSED to review (done-when 1).
2. **A live checkout blocks the instant promote.**
3. **The trusted link acts under its CREATOR's authority, evaluated at promote time** — the link creator must still be a controller or hold `user_can_publish_on_library` on the target library. This is the deliberate, documented reading of done-when 2: the per-link `allow_auto_supersede` setting is sanctioned by a person, and that person's live publish authority is the authority evaluation; if they lost it, the shortcut dies with it.
4. **No fabricated review** — an auto-published external upload now carries `review_state: NULL` (issued-without-review), never `'approved'`.
- Done-when: (1) ✓; (2) ✓ via the creator-authority rule, recorded here; (3) **partial** — consulting the library owner before a project names their library as intake target is an intake-creation UX flow, tracked with the projects-tab area's intake findings rather than this route.
- Files: `app/api/intake/upload/route.ts`.
- Tests: `lib/__tests__/rpPhase3Migration.test.ts` (source pins: hold check + fail-closed wording, checkout gate, creator-authority RPC, approved-stamp removal).
- **Verification:** CONFIRMED
- **Blast radius:** safety / data-integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:15` — `supabaseAdmin` (service role) for the whole route
  - `app/api/intake/upload/route.ts:302` — `const autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored;`
  - `app/api/intake/upload/route.ts:322-329` — the promote: `.update({ current_version_id: versionId, rev: …, status: "Issued", … })`
  - `supabase/migrations/20260822_review_completion_guard.sql:32-34` — `IF v_actor IS NULL THEN RETURN NEW;`
  - `components/projects/IntakePanel.tsx:146-152` — link creation with `allow_auto_supersede: trusted`
  - `supabase/migrations/20260902_project_intake.sql:52-60` — link write policy: `is_org_controller(org_id) OR projects.owner_user_id = auth.uid()`
- **Related:** `OWN-5`, `EGRESS-*`
- **Re-verified:** hardening pass — **SURVIVES**. `autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored` (`:302`), then a direct `supabaseAdmin` update sets `current_version_id` and `status: "Issued"` and supersedes the prior version (`:322-329`) — never calling `publish_revision`. The publish-guard trigger exempts service-role writes, so no hold, lock or review gate is consulted.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. `grep -n hold app/api/intake/upload/route.ts` returns nothing — the route never consults document_holds, never calls publish_revision, and the service-role write makes auth.uid() NULL so the guard short-circuits before the review-completion, authority and hold checks. Scope is narrower than the title implies (only link-authored docs on a link whose allow_auto_supersede is set — :244-250 enforces that), but within that scope every gate is skipped, so CRITICAL stands.

**Mechanism.** Because the write uses the service-role key, `auth.uid()` is
`NULL` and the publish guard short-circuits on its very first statement. That
skips, in one hop:

- per-library publish authority
- effective ownership
- the review-completion gate
- **and the active-hold check**

Nothing in the route re-implements any of them. It checks only link validity,
expiry, revocation, and `linkAuthored`.

**Failure scenario.** A vendor drawing is placed on an active hold (MOC pending,
or an incident investigation). The vendor uploads through their trusted link. The
document flips to `Issued` with the vendor's file as the controlled copy,
`document_holds` untouched, and the notification reads *"published a new revision
through their trusted intake link. It is now current."* The library owner and Doc
Control had no veto and were merely CC'd.

**Chain reaction.** The same route already routes non-trusted submissions through
`pending_version_id` → `finalizeReviewedRevision`
(`components/projects/IntakePanel.tsx:237`) with `requireRosterComplete: false`,
which **does** run the guard under a real `auth.uid()`. So the machinery for a
safe path already exists. Whatever you do, decide what the route returns when
refused — the external submitter needs a comprehensible 409, not a 500.

**Related (HIGH, no separate ID — fix with this one):** the intake link can be
minted by a **project owner** who is not a controller
(`20260902_project_intake.sql:53,56`), and the same panel sets
`projects.intake_library_id` to any library it can list
(`components/projects/IntakePanel.tsx:143`). The library's document-control
manager is never consulted. That is a cross-axis leak: project ownership
silently confers publish authority into a document library.

**Done when.**
1. No path from an unauthenticated intake token can set
   `documents.current_version_id` or `documents.status = 'Issued'` on a document
   with an active hold.
2. Every intake-originated revision is subject to the same review and authority
   evaluation as an internal one, or the difference is a deliberate,
   documented, per-library setting owned by that library's owner.
3. The library owner is consulted before a project can name their library as an
   intake target.

---

## OWN-5 · `publish_revision` trusts a client-supplied actor, and its branch path bypasses the guard entirely

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, roles-and-permissions Phase 3).** Confirmed with the recon corrections (the `p_actor_role` half was already removed by `20261019`; the live `20261034` body never references `auth.uid()`, and its branch path skips exactly the authority/base/review evaluations while keeping holds, the lock check, MOC and the revert gate). Migration `20261036` re-creates `publish_revision` (all Phase 5/7c gates byte-carried) with:
- **Session-derived actor**: a signed-in caller's `p_actor` must equal `auth.uid()` (NULL = derived); a mismatch raises — attribution, membership, controller status, and the lock comparison all follow the session. Only a service-role call (`auth.uid() IS NULL`) may name its actor, and must.
- **The branch path carries the promote's authority bar**: controller OR `user_can_publish_on_library` OR `user_is_effective_owner` — the same primitives `trg_document_publish_guard` applies to promotes (which never fires for branches, since they write no `documents` row).
- **EXECUTE revoked from PUBLIC**, granted to `authenticated` + `service_role`.
- **The v1 fallback retry is RETIRED** (app half, with DEC-11): `callPublishRevisionRpc` no longer downgrades to the v1 signature by folding `p_override_lock` into `p_force` — the silent upgrade of a noted checkout-override into a hold-bypassing controller force. A genuinely missing RPC now surfaces as the deployment error it is.
- Done-when: (1) actor from `auth.uid()`, `p_actor` honored only service-role ✓; (2) branch under the same authority evaluation ✓; (3) `p_override_lock` cannot advantage an unauthorized caller — the promote path's trigger and the branch path's new bar both refuse them regardless of the flag, and the v1 upgrade that converted it into `p_force` is gone ✓; (4) forged-actor, unauthorized-branch and override shapes pinned by test ✓.
- Tests: `lib/__tests__/rpPhase3Migration.test.ts` (actor block, branch gate, REVOKE/GRANT, carried gates, v1-retry removal).
- **Applied & verified live 2026-08-24:** `20261036` — probe true; DEC-30 inventory all ZERO (no non-controller owners, no owned documents, no unreconciled branches — the rails enforce against a blank slate).
- **Verification:** CONFIRMED
- **Blast radius:** security / data-integrity / safety
- **Locations:**
  - `supabase/migrations/20260828_integrity_hardening.sql:39-53` — signature: `p_actor UUID`, `p_override_lock BOOLEAN DEFAULT FALSE`
  - `supabase/migrations/20260828_integrity_hardening.sql:77-89` — the only authority checks, both about `p_actor`
  - `supabase/migrations/20260828_integrity_hardening.sql:94-96` — `NOT (p_override_lock OR (p_force AND v_is_controller))`
  - `supabase/migrations/20260828_integrity_hardening.sql:150-155` — `created_by := p_actor`, `created_by_name` from the payload
  - `supabase/migrations/20260828_integrity_hardening.sql:170-180` — the branch path inserts the version row and **never touches `documents`**
  - `lib/revisions.ts:534-546` — the client passes `p_actor`, `p_actor_role`, `p_override_lock: lockedByOther`
- **Related:** `OWN-4`, `OWN-17`, `DB-4`
- **Re-verified:** hardening pass — **SURVIVES**, both halves. (a) `p_actor`, `p_actor_name`, `p_actor_role` are function parameters, so the caller names the actor; membership and controller status are re-derived from the database (`:77-89`), which closes privilege escalation but **not impersonation** — you may publish as a colleague and the recorded name/role are unvalidated. (b) The base-version check is `IF p_op_class = 'content' AND NOT p_as_branch` (`:116`), so `p_as_branch := true` skips it and costs only a non-empty reason string (`:131`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves hold. `auth.uid()` appears nowhere in the function body (first occurrence in that file is line 219, in an unrelated RLS policy), there is no GRANT/REVOKE on the function so EXECUTE stays PUBLIC, and document_versions has no INSERT trigger (only a tsv trigger and a legal-hold DELETE guard). One correction to the narrative, not the finding: the NON-branch path cannot be used to escalate — the promote UPDATE still fires trg_document_publish_guard under the real caller's auth.uid() and rolls the transaction back — so the escalation is specifically the branch path, plus forgeable attribution and a client-controlled p_override_lock on every path.

**Mechanism.** The function is `SECURITY DEFINER` and validates `p_actor` — a
parameter — instead of `auth.uid()`. **`auth.uid()` does not appear in the
function body at all.** Three consequences:

1. **`p_override_lock` is a client boolean.** Anyone who can call the RPC can set
   it and skip the foreign-checkout check. The database has no idea whether the
   app collected an override reason or notified the lock holder — those are
   app-side only (`lib/revisions.ts:242-243,267-307`).
2. **Attribution is forgeable.** `p_actor` and `created_by_name` land verbatim in
   `document_versions`. In a PSM record, `created_by` on the revision row *is*
   the custody claim.
3. **`p_as_branch: true` never reaches the trigger.** No `UPDATE documents` runs,
   so `enforce_document_publish_guard` never fires. Any active org member can
   insert a `document_versions` row against any controlled document — arbitrary
   `revision_label`, `file_url`, `approved_by_name`, `file_hash`, `provenance` —
   plus an open `revision_branches` debt row, attributed to whoever they name.
   The hold check *does* still apply on this path; authority does not.

The comment at `supabase/migrations/20260823_publish_contract.sql:286-288`
("the definer function's promote runs the `enforce_document_publish_guard`
trigger too — belt and suspenders") is only true for the *promote*. It is the
load-bearing check, not a suspender, and on the branch path it does not exist.

**Failure scenario.** A member calls the RPC directly with
`p_actor: <the doc control manager's uuid>`, `p_as_branch: true`, and a
`created_by_name` of their choosing. A version row appears in the controlled
chain of a PSM drawing attributed to someone who never touched it. There is no
trigger to stop it and no audit row that contradicts it.

**Chain reaction.** Gating the branch path means
`lib/revisions.ts:407-409` ("publish as branch," reached from the stale-base
conflict screen) can start returning refusals it has never returned before —
that screen needs a real error state. Separately,
`callPublishRevisionRpc`'s v1 fallback (`lib/revisions.ts:98-106`) folds
`p_override_lock` into `p_force`; if the pre-`20260828` function is still
deployed anywhere, that fallback silently upgrades a lock-override into a full
controller force. Retire the v1 fallback in the same change.

**Done when.**
1. `publish_revision` derives the acting identity from `auth.uid()` for every
   caller that has one, and the `p_actor` parameter is only honored on an
   explicitly service-role path.
2. The branch-mode insert is subject to the same publish-authority evaluation as
   the promote.
3. `p_override_lock` cannot be honored for a caller who lacks the
   `checkout.force_release` authority.
4. Tests cover: forged `p_actor`, branch-mode by an unauthorized member, and
   `p_override_lock` by a non-authorized caller.

---

## OWN-6 · Team-based publish grants are dead on every mutator path while the database honors them

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / ux
- **Locations:**
  - `lib/revisions.ts:224-228` — `const principal: Principal = { uid, role, orgId };` — **no `teamIds`**
  - `lib/revisions.ts:1058` — same omission in `correctRevisionLabel`
  - `lib/permissions.ts:77` — `const teams = p.teamIds ?? [];` → `[]`
  - `lib/acl.ts:71` — `case "team": return Array.isArray(ctx.teamIds) && ctx.teamIds.includes(id);` → `false`
  - `supabase/migrations/20260812_per_library_publish_authority.sql:61-62,81-84` — the DB **does** resolve `team_members` and honors team grants
  - `app/(protected)/documents/[libraryId]/page.tsx:1642-1657` — the *page's* principal **does** carry `teamIds`
- **Related:** `OWN-9`, `DEL-*`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The `Principal` constructed on the mutator paths is `{ uid, role, orgId }` (`revisions.ts:224-228` and `:1058`) — **no `teamIds`** — so `evaluateAclChain` can never match a team-subject grant, while the SQL evaluator matches teams via `acl_subject_in_bucket`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed asymmetry: the page's principal carries teamIds (feeding canPublishOnLibrary at :1663) while both mutator principals omit them, and lib/documentGuards.ts:222-226 (resolveCanControlLibrary) passes that team-less principal into canPublishViaIndex. The DB honors team grants, so the button-shows / mutator-refuses split is real.

**Mechanism.** The page computes `canPublish` with team memberships and shows the
"Publish New Revision" button. The user clicks. `revUpDocument` →
`authorizePublish` builds a *different* principal without `teamIds`,
`resolveCanControlLibrary` returns false, and the call throws *"You don't have
authority to publish revisions in this library. Ask an Admin or Doc Control to
grant it."* — for a grant that exists, that the database would honor, and that
the button they just clicked said they had.

**Failure scenario.** You grant the CAD team publish on the drawings library, as
the Permission drawer's team subject type invites you to. Nobody on that team can
publish. Support gets "the button lies."

**Chain reaction.** The fix is roughly one line, but it makes team grants **live**
on the mutator path for the first time. Audit existing `libraries.acl_index` for
`allow.teams.publish` before shipping — those grants have been inert and may be
stale. Note also that the View-as simulator cannot show you who is affected,
because it reads the wrong column (`OWN-10`).

**Done when.** A member whose only publish authority comes from a team grant can
complete a rev-up end to end, and a test pins it.

---

## OWN-7 · `acl_index` discards rule expiry, so publish grants never expire at the database

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `lib/acl.ts:256-272` — `buildAclIndexFromRules` reads only `rule.effect`, `rule.subject`, `rule.actions`. **`expiresAt` is never carried into the index.**
  - `lib/acl.ts:81-85,97` — `isRuleActive` / expiry is honored **only** by the raw-ACL evaluator
  - `supabase/migrations/20260812_per_library_publish_authority.sql:75-85` — the DB reads `acl_index` and has no concept of expiry
  - `lib/permissions.ts:80-90` — `canPublishViaIndex`, likewise no expiry
  - `lib/documentGuards.ts:220-226` — deliberately **prefers** the index
  - `components/permissions/RoleModelTree.tsx:101` — the in-app documentation asserts *"expiry dates honored"*
- **Related:** `DOCACL-*`, `OWN-20`
- **Re-verified:** hardening pass — **SURVIVES**, and the helper it should call sits nine lines away. `buildAclIndexFromRules` iterates `rule.actions` and buckets them (`acl.ts:256-267`) with **no call to `isRuleActive`** — which exists at `:81-85` and is used by the TypeScript evaluator. Expiry is dropped on the way into the column RLS reads.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Right, and the index-preferred short-circuit in resolveCanControlLibrary means the raw evaluator (the only place expiry lives) is never reached whenever an acl_index exists. No nightly rebuild exists — no migration or script rewrites acl_index — so the stale grant persists indefinitely.

**Mechanism.** You grant a contractor `publish` on the drawings library with
`expiresAt = 2026-09-01`. On 2026-09-02 the raw evaluator drops the grant, so the
page's `canPublish` goes false and the Inspector button disappears. But
`libraries.acl_index` still lists them, so `user_can_publish_on_library` returns
**true** forever, and `resolveCanControlLibrary` (index-preferred) also returns
true. The grant is revoked in the UI and live at the database.

**Failure scenario.** A terminated contractor retains database-level publish
authority on a PSM library indefinitely. They reach it through `CheckInPanel`
(a different code path using `canPublish || isOwner`), through the
`publish_revision` RPC directly, or through any surface that does not recompute
from the raw ACL.

**Chain reaction.** Adding expiry to `AclIndexBucket` (`types/schema.ts:116-126`)
changes the JSON shape read by `user_can_publish_on_library`, `acl_index_denies`,
`can_manage_node` / `acl_subject_has_action`, `node_visible`,
`components/permissions/RoleModelTree.tsx:159-165`, and
`app/api/storage/download-url/route.ts:95`. **A cheaper interim option:** have the
daily maintenance cron rebuild `acl_index` from `acl` for every node nightly,
which drops expired rules naturally and touches no SQL function. That narrows the
exposure window from "forever" to "one day" without a schema change.

**Done when.** An expired publish rule stops authorizing a publish at the
database, not only in the UI — demonstrated by a test that advances past an
expiry and asserts refusal.

---

## OWN-8 · `admin`-implies-everything vs. explicit `publish` deny: the three evaluators disagree in opposite directions

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `lib/acl.ts:108-110` — denied actions are removed from `allowed`, but `admin` survives unless `admin` itself is denied
  - `lib/acl.ts:133-137` — `can()`: `if (allowed.has("admin") && !denied.has("admin")) return true;` **before** the deny check
  - `lib/permissions.ts:80-90` — `canPublishViaIndex`: `deniedPublish` short-circuits **first**
  - `supabase/migrations/20260812_per_library_publish_authority.sql:64-71` — SQL: explicit `publish` deny wins, checked **first**
- **Related:** `DOCACL-2`, `OWN-20`
- **Re-verified:** hardening pass — **SURVIVES**. Two different orders in one file: `:108-110` subtracts denied actions from allowed, while `can()` at `:133-137` short-circuits on `allowed.has("admin")` **before** testing `denied.has(action)`. An explicit `publish` deny against an `admin` allow resolves differently depending on which path evaluates it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both directions verified. {allow admin, deny publish}: evaluateAcl.can('publish') returns true (admin short-circuit precedes the deny test) while canPublishViaIndex and user_can_publish_on_library both return false. {allow admin, deny admin}: evaluateAcl returns false while the index and SQL evaluators return true — neither checks deny.*.admin at all. The 20260812 header's claim that it "mirrors lib/permissions.ts#canPublishOnLibrary exactly" is false.

**Mechanism.** For a rule set of `{allow: admin} + {deny: publish}` on a library:

| Evaluator | Result | Reached from |
|---|---|---|
| `evaluateAcl.can("publish")` | **ALLOWED** | the Publish button |
| `canPublishViaIndex` | **DENIED** | the lib mutators |
| `user_can_publish_on_library` | **DENIED** | the publish guard trigger |

The `20260812` header claims *"This mirrors `lib/permissions.ts#canPublishOnLibrary`
exactly."* It does not. And the mirror is broken the *other* way for
`deny: admin`: the SQL never consults `deny…admin` at all, while `lib/acl.ts:134`
does — so revoking a library `admin` grant with an explicit deny works in the raw
evaluator and nowhere else.

**Failure scenario.** Doc Control grants a lead "admin" on a library for
convenience, then later adds `deny publish` to take publishing back after an
incident. The button stays visible, the click fails with a confusing error, and
database-side they are denied — three different answers, none of which reads as
"your revocation took effect."

**Chain reaction.** `evaluateAcl.can` is used for **every** action, not just
publish (`canDiscover`, `canWithAclChain`, `canBlindDrill`, `isDiscoverable`).
Changing the admin/deny ordering there changes read and discover visibility
across the whole app. Changing `canPublishViaIndex` and the SQL to match
`lib/acl.ts` is the narrower blast radius — but it is also the *less safe*
precedence, which is why **`DEC-8` chooses the other direction: explicit deny
always wins, including over `admin`.** Move `lib/acl.ts` to check denies before
the `admin` short-circuit, and add the missing `deny…admin` check to the SQL.
That narrows access, so expect "I lost a permission" reports; a revocation that
does not visibly take effect is the worse failure in a regulated system.

**Done when.** All three evaluators return the same answer for
`{allow: admin} + {deny: publish}` and for `{allow: admin} + {deny: admin}`, the
chosen precedence is written down in `lib/acl.ts`, and a shared test fixture
pins both cases across the TypeScript and SQL paths.

---

## OWN-9 · `DraftingSupervisor` — the role the per-library publish feature was built for — cannot be selected as an ACL subject

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution.** `DraftingSupervisor` added to `PermissionDrawer.ROLES` (after `Supervisor`) and to `ROLE_HIERARCHY`'s Engineering group (beside `Drafter` — the group the finding's own chain-reaction sentence implies: "grant publish to all Engineering today silently excludes drafting supervision"). Verified no code reads either array's length or ordering (both are render/select-only). The evaluator side needed nothing — `lib/__tests__/permissions.publish.test.ts:26-29` already pins that a `{type:'role', id:'DraftingSupervisor'}` rule authorizes a publish end to end; the gap was purely that no picker could emit the rule.
- Commit: `2af2ebe`
- Files: `components/permissions/PermissionDrawer.tsx`, `components/permissions/RoleTreeSelector.tsx`, `lib/__tests__/rolePickerCensus.test.ts`
- Tests: `lib/__tests__/rolePickerCensus.test.ts` — two census tests pinning that BOTH pickers offer exactly `ALL_ROLES` (19 roles, no duplicates), extracted from the components' source since their import graph reaches the live Supabase client. Both failed before the fix (18 vs 19), both pass after — and any future role added to the model without picker coverage fails CI.
- Reproduced: counted both arrays against the 19-role union in `types/schema.ts` — 18 entries each, `DraftingSupervisor` absent from both, exactly as filed.
- Verified: Done-when — the role is selectable in the single-rule picker and the bulk selector; a rule naming it authorizes publish per the pre-existing evaluator tests. Suite 1407 green.
- **What this brought to light:** the census-test pattern generalizes — the same one-missing-entry drift can happen to any of the pickers' sibling arrays (`SUBJECT_TYPES`, the explorer's `ROLES` column list). The census test now guards the two role rosters; the explorer's 12-column matrix remains hand-maintained (see `CHAIN-4`'s resolution for its corrections).
- **Verification:** CONFIRMED
- **Blast radius:** availability / ux
- **Locations:**
  - `supabase/migrations/20260812_per_library_publish_authority.sql:7-8` — *"the product now lets an Admin grant a non-controller (e.g. a **Drafting Supervisor**) the 'publish' action on a SPECIFIC library"*
  - `lib/permissions.ts:50-51`, `lib/__tests__/permissions.publish.test.ts:23,28,33` — the feature is specified and tested against `DraftingSupervisor`
  - `types/schema.ts:10,31` — the role exists
  - `components/permissions/PermissionDrawer.tsx:55-74` — the `ROLES` array driving the role picker: **`DraftingSupervisor` is absent**
  - `components/permissions/RoleTreeSelector.tsx:7-28` — `ROLE_HIERARCHY`, the bulk selector: **also absent** from all five groups
- **Related:** `ROLE-*`, `DRAFT-*`
- **Re-verified:** hardening pass — **SURVIVES**. The feature migration names the case in its own header — *"an Admin grant a non-controller (e.g. a Drafting Supervisor) the 'publish' action on a SPECIFIC library"* (`20260812_per_library_publish_authority.sql:7-8`) — and `lib/permissions.ts:50-51` repeats it, while the subject picker's role list does not offer that role (`ROLE-6`).
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The factual claim is exactly right — neither picker can emit a {type:'role', id:'DraftingSupervisor'} rule. Severity is too high at HIGH: there is no security exposure (it fails closed), and the same authority is reachable today by granting publish to that person as a `user` subject, which both pickers support. MEDIUM.

**Mechanism.** Both role pickers in the Permission drawer omit the role. Neither
can produce a `{subject: {type:'role', id:'DraftingSupervisor'}}` rule. The
feature's canonical use case is unreachable from the UI. What remains: per-user
grants (work), team grants (broken — `OWN-6`), and `org` grants (broken —
`OWN-18`).

**Failure scenario.** You try to give your drafting supervisor publish rights on
the drawings library, exactly as the migration that built the feature describes,
and the role is not in the list.

**Chain reaction.** `ROLE_HIERARCHY` also drives **bulk** rule creation, so
"grant publish to all Engineering" today silently excludes drafting supervision.
Adding the role to both arrays is trivial; verify no code assumes the two arrays
are the same length or ordering.

**Done when.** `DraftingSupervisor` is selectable in both the single-rule picker
and the bulk selector, and a rule naming it authorizes a publish end to end.

---

## OWN-10 · The "View as" simulator reads a non-existent column, so it under-reports every team-derived grant

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / access-control
- **Locations:**
  - `components/permissions/ViewAsSimulator.tsx:59` — `.from("team_members").select("team_id").eq("user_id", pick)`
  - `supabase/migrations/20260707_teams.sql:19-26` — `team_members` columns are `team_id, uid, org_id, added_at, added_by`. **There is no `user_id`.**
  - `components/permissions/ViewAsSimulator.tsx:61` — `catch { setTeamIds([]) }` — the PostgREST 400 is swallowed
  - `components/permissions/ViewAsSimulator.tsx:161-164` — `teamIds` (always `[]`) feeds `canDiscover` and `canPublishViaIndex`
  - `components/permissions/ViewAsSimulator.tsx:5-6` — the component's own docstring: *"their EFFECTIVE access is computed with the same evaluators the app enforces with — not a re-implementation that could drift"*
- **Related:** `OWN-6`, `DB-2`, `ADD-2`
- **Re-verified:** hardening pass — **SURVIVES**. `.from("team_members").select("team_id").eq("user_id", pick)` (`ViewAsSimulator.tsx:59`) against a table keyed `(team_id, uid)` (`20260707_teams.sql:19-26`). Identical defect to `DB-2`, in the surface people use to check their own answer.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by repo-wide search — this is the single site in the codebase using `user_id` on team_members, so the simulator always evaluates every member as belonging to zero teams and silently drops team-derived visibility and publish grants.

**Mechanism.** The query errors, the catch sets `teamIds = []`, and the simulator
then reports that a team-granted publisher **cannot** publish anywhere. It is the
only tool an admin has for "who can publish here," and it is wrong in the one
direction that hides authority.

**Failure scenario.** During an access recertification
(`supabase/migrations/20260821_access_recert.sql`) the reviewer uses View-as to
confirm nobody unexpected can publish. Every team-derived grant is invisible. The
recertification is signed on false evidence — which in a PSM audit is worse than
having no recertification.

**Chain reaction.** Fixing the column makes the simulator start reporting team
publish grants which, per `OWN-6`, the app's own mutators still refuse. Ship both
together or the tool becomes honest about a capability that still does not work.
**Do not leave the `catch` swallowing errors** — a permissions tool that fails
silent is the failure mode here, not the typo.

**Done when.**
1. The simulator resolves the subject's real team memberships.
2. A query failure surfaces as a visible error state in the simulator, never as
   an empty result.
3. The authority the simulator reports matches what the mutator path and the
   database actually grant, for a team-granted publisher.

---

## OWN-11 · Ownership does not make you the approver, and auto-finalize publishes under whoever signs last

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / process
- **Locations:**
  - `types/schema.ts:191-210` — `ReviewControl` has `reviewerIds` / `reviewerRoles` / `reviewerTeamIds` only. **No owner slot.**
  - `lib/reviewControl.ts:126-132` — `expandReviewers` reads only those explicit lists
  - `lib/reviewControl.ts:196-238` — `openReviewRoster` creates rows only for those people; the owner is *notified* on gaps but never rostered
  - `lib/reviewControl.ts:316-332` — **auto-finalize**: the last required signature calls `finalizeReviewedRevision({ actorId: input.signerUserId })`
  - `lib/reviewControl.ts:429-434` — the promote runs under that signer's `auth.uid()`; a guard rejection lands in `docErr` and returns `{published:false, reason}`
  - `components/permissions/RoleModelTree.tsx:106` — the app documents this honestly
- **Related:** `GAP-4`, `OWN-13`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `ReviewControl` (`types/schema.ts:191-202`) models reviewers and alternates and has no approver or owner concept; `expandReviewers` returns primaries and alternates only (`reviewControl.ts:126-131`). Auto-finalize therefore publishes under whoever signs last.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Every element checks out; RoleModelTree:106 documents the authority-inheritance as intended, but the ternary at :315 is a genuine bug — the one notification that says an approved revision is stranded is withheld from Admin/DocCtrl exactly when a (possibly absent) owner is set.

**Mechanism.** Against the stated model — *"setting ownership means they are the
approval of revision and superseding"* — ownership today grants **execution**
authority (you may press publish) but not **approval** authority (you are not a
required signer). And whether an approved draft auto-publishes is decided by
*which reviewer happens to sign last*: an Engineer signs last → the trigger
refuses → the draft sits until someone presses the manual button; a DocCtrl signs
last → it publishes instantly. Same document, same roster, different outcome
based on signing order.

**Failure scenario.** A procedure's review completes Friday afternoon; the last
signer is an Engineer; the promote silently fails; the "Ready to publish"
notification goes **only to the owner** (`lib/reviewControl.ts:315` —
`owner.userId ? [owner.userId] : controllers`, so controllers are *excluded* when
an owner exists); the owner is on leave, and nothing checks their
`org_members.status` (`OWN-13`). The approved revision sits unpublished and
everyone keeps working from the superseded copy.

**Chain reaction.** ⚠ Making the owner a required approver is a **feature**, not
a fix — see `GAP-4`. Adding an owner slot to `ReviewControl` and to
`openReviewRoster` changes `reviewCompletionForDraft`'s `requiredPrimaries` count
**and** the database completion gate (`20260822:46-58`, which counts
`slot = 'primary'` rows). Existing in-flight drafts would gain a new required
signer mid-review. What *is* in scope as a bug fix here: the auto-finalize
outcome should not depend on signing order, and the "ready to publish" notice
should not suppress the controller fallback.

**Done when.**
1. A completed roster produces the same publish outcome regardless of which
   reviewer signs last — either it always auto-publishes under a defined
   authority, or it never does and always routes to a named person.
2. When auto-finalize is refused, the resulting notification reaches someone who
   can act, and says why.

---

## OWN-12 · No succession: a deactivated or removed owner keeps authority and swallows every notification

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / safety
- **Locations:**
  - `supabase/migrations/20260824_team_departments.sql:18-42` — `user_is_effective_owner` never joins `org_members`; **no `status` check, no org check**
  - `lib/ownership.ts:24-30,35-59` — `resolveEffectiveOwner` / `effectiveOwnerForDocument` never check membership status
  - `supabase/migrations/20260630_document_ownership.sql:9-14` — the owner columns are bare `UUID` with **no foreign key**, so nothing cascades or nulls on removal
  - `app/(protected)/admin/users/page.tsx:167-187` — `handleRemoveMember` does nothing about owned libraries, folders, or documents
  - `lib/effectiveDate.ts:81` — `[...(owner.userId ? [owner.userId] : controllers), …]` — controllers **excluded** when a stale owner exists
  - `lib/reviewControl.ts:315`, `components/documents/CheckInPanel.tsx:398`, `lib/acknowledgments.ts:470` — the same pattern
  - `lib/retention.ts:192`, `lib/acknowledgments.ts:398,593` — the *safer* "owner AND controllers" form; the codebase is split
- **Related:** `SURF-1`, `GAP-5`
- **Re-verified:** hardening pass — **SURVIVES**, by absence in both evaluators. `user_is_effective_owner` returns the stored uid with no status test (`20260824_team_departments.sql:24-29`) and `resolveEffectiveOwner` does the same in TypeScript (`ownership.ts:24-30`). Neither consults `org_members.status`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The dead-letter routing for effective-date, review-complete/ack and check-in hand-off notices is confirmed and unmitigated, but the title's claim that the departed owner 'keeps authority' is false — every RLS predicate requires status='active' — and the periodic-review path does escalate to Admin/DocCtrl after the grace window, so HIGH overstates it.

**Mechanism.** Ownership is a dangling uuid. Once the person is gone:

- `user_is_effective_owner` still returns `true` for them, so the publish guard
  would still authorize them. The only thing stopping them is the
  `documents_org_access` membership policy — i.e. authority survives in the
  ownership layer and is only *accidentally* contained by a different layer.
- Every "owner OR controllers" router sends the notification to a dead account
  and **suppresses** the controller fallback, because the fallback is keyed on
  the owner *existing*, not on the owner being *reachable*.

**Failure scenario.** The document-control manager for the P&ID library leaves.
Their `org_members` row is deleted. Every P&ID in that library still resolves to
them. Effective-date notices, review-complete notices, ack-complete notices and
check-in hand-offs all go to a user id that cannot log in — and Admin/DocCtrl are
explicitly *not* told, because the code believes the document is owned.

**Chain reaction.** Note `SURF-1`: today the removal itself is a silent no-op, so
this finding currently bites on *deactivation* and on genuine departures handled
outside the UI. Fixing `SURF-1` makes this one bite much harder. Two fixes are
needed together: (a) require an active `org_members` row in
`resolveEffectiveOwner` and `user_is_effective_owner` — which will re-route a lot
of notification traffic to controllers overnight; (b) an orphaned-ownership
sweep. There is no "orphaned libraries" view today, and the one place library
ownership is displayed renders from `owner_name`, not `owner_user_id`, so a
deleted user with a stale name string still reads as owned.

**Done when.**
1. A departed or deactivated member is never the effective owner for an
   authority decision.
2. Notifications that would have gone to an unreachable owner reach the
   controller fallback instead.
3. Orphaned ownership is discoverable by an admin.

---

## OWN-13 · Ownership writes swallow RLS refusals, then write a "success" audit row and notify the new owner

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / safety
- **Locations:**
  - `lib/ownership.ts:130` — `await supabase.from(table).update({ owner_user_id, owner_name }).eq("id", id);` — **no error check, no `.select()`**
  - `lib/ownership.ts:132-139` — `logAuditAction({ action: "OWNER_ASSIGNED", … })` runs unconditionally
  - `lib/ownership.ts:141-150` — `notify({ kind: "owner_assigned", … })` runs unconditionally
  - `lib/ownership.ts:66` — `setLibraryOwnerTeam`, same pattern
  - `lib/reviewControl.ts:144` — `setReviewControlPolicy`, same pattern
  - `supabase/migrations/20261011_collections_guard_and_trash.sql:30-34` — `collections_update_controllers` refuses folder updates from non-controllers, which is exactly when this bites
  - `supabase/migrations/20260830_publisher_row_management.sql:20-23` — the precedent, stated in the codebase's own words: *"'Silently' is the dangerous part: RLS returns 0 matched rows, not an error"*
- **Related:** `OWN-1` (**blocking prerequisite**), `OWN-14`
- **Re-verified:** hardening pass — **SURVIVES**. `await supabase.from(table).update({ owner_user_id, owner_name }).eq("id", input.id)` (`ownership.ts:130`) — **the result is never destructured** — and `logAuditAction` writes `OWNER_ASSIGNED` immediately after (`:132-139`).
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The unchecked-write-then-claim-success mechanism is confirmed line for line, but today no app path triggers an actual refusal — the folder path is controller-gated in the UI and controllers pass the restrictive policy, and libraries/documents are wide open (OWN-1). It is latent until OWN-1 is fixed or someone drives the API raw, so HIGH is too high.

**Mechanism.** A PostgREST `UPDATE` filtered out by RLS returns **200 with zero
rows**, not an error. `setOwner` never inspects the result. So the modal closes
cleanly, `audit_logs` gets an `OWNER_ASSIGNED` row naming a person who is not the
owner, and that person receives *"You're now the owner… You'll receive its
notifications and review reminders."* They will not.

**Failure scenario.** Exactly the scenario the system is meant to support: a
document-control manager is designated per library. The assignment does not stick
— at folder level today, and at library level the moment `OWN-1` is fixed. The
audit trail says it did. Six months later a PSM audit asks who owned the
procedure and the record is false, which is a worse outcome than having no
record.

**Chain reaction.** This is a **prerequisite for `OWN-1`.** Locking down
`libraries` without fixing this converts a security hole into silent data loss
across six call sites.

**Done when.**
1. `setOwner`, `setLibraryOwnerTeam`, `setReviewControlPolicy` and `setReviewPolicy`
   confirm the row was actually written before returning success.
2. The audit row and the notification are emitted **only** after that
   confirmation.
3. A refused write surfaces to the user as a visible error.

---

## OWN-14 · Silent-write-failure is a codebase-wide pattern, not a single bug

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-08-24, roles-and-permissions Phase 3 — the prerequisite).** Confirmed: all six named sites still swallowed refusals (recon re-verified each), and five of them wrote successful-looking audit rows after the refused write. Every one is now CHECKED — `{ error }` read, `.select("id")` appended, zero rows throws with a message naming what was NOT changed, and the audit/notify side-effects moved behind success:
- `lib/ownership.ts` `setOwner` (the SINGLE funnel for every ownership write at every level) and `setLibraryOwnerTeam` — no more phantom `OWNER_ASSIGNED` rows or congratulations to owners who were never assigned.
- `lib/reviewControl.ts` `setReviewControlPolicy`; `lib/checkoutEpisodes.ts` `forceReleaseDocument` (BOTH halves — the session close and the documents lock clear; a refused force-release now says the lock survived).
- `lib/retention.ts` `placeLegalHold` / `releaseLegalHold` — every batch checked, the returned count is what actually held, and a partial refusal throws BEFORE the `hold_placed` log and notifications ("Legal hold was only applied to 50 of 60…").
- Trap-2 companions (the other sensitive-column writers the new `20261036` rails will refuse for unauthorized callers): `setReviewPolicy`, `setRetentionPolicy`, `setAckPolicy`, `setRecertPolicy`, `recertifyAccess` — all checked. UI callers without a catch (`ReviewSection.assignOwner`, `ReviewPolicyModal.save/remove`) now catch and surface via `appAlert`.
- Files: `lib/ownership.ts`, `lib/reviewControl.ts`, `lib/checkoutEpisodes.ts`, `lib/retention.ts`, `lib/reviewCycles.ts`, `lib/acknowledgments.ts`, `lib/accessRecert.ts`, `components/documents/ReviewSection.tsx`, `components/documents/ReviewPolicyModal.tsx`.
- Tests: `lib/__tests__/checkedWrites.test.ts` — refused setOwner throws with NO audit row and NO owner notification; DB error surfaces; landed write audits; refused team assignment; partial legal hold throws with the true count and logs nothing; landed hold returns the real count.
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/ownership.ts:66`, `:130`
  - `lib/reviewControl.ts:144`
  - `lib/checkoutEpisodes.ts:616-627` — `await supabase.from("checkout_sessions").update(…)` with no `const { error } =`
  - `lib/retention.ts:126`, `:139` — legal-hold place/release, same shape
  - the counter-example that proves it can be done: `lib/reviewControl.ts:429-439` — `.eq("pending_version_id", pendingId).select("id")` with the loser handled explicitly
- **Related:** `OWN-13`, `SURF-1`, `SURF-2`
- **Re-verified:** hardening pass — **SURVIVES**, with the count made exact: **47** unchecked `await supabase.from(…).update(…)` calls in `lib/` alone. `ownership.ts:66` and `reviewControl.ts:144` are two of them.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The pattern is real and the fix-sequencing argument is sound, but one cited example actually checks its error, and none of the unchecked writes currently hit a refusing policy — the affected tables (libraries, documents) are permissive today and the guarded paths are already controller-gated. It is a prerequisite for the other fixes, not a live HIGH.

**Mechanism.** Supabase `.update()` without `.select()` cannot distinguish "I
updated the row" from "RLS matched nothing." Across the authority-relevant
surfaces this pattern appears wherever a policy is *about* to be tightened —
which means every RLS hardening in this report lands on top of a call site that
will not notice being refused.

**Failure scenario.** Any RLS fix in this report, shipped alone, converts a
security failure into a silent-data-loss failure. This finding is why fix
sequencing matters — see [`99-fix-sequencing.md`](./99-fix-sequencing.md).

**Chain reaction.** This is deliberately scoped as a **pattern finding, not a
sweep authorization.** Do not convert every `.update()` in the codebase. Fix the
specific call sites named above, each alongside the RLS change that makes it
bite.

**Done when.** Each authority-relevant write named above verifies its own
row count, and a failed write is visible to the user and absent from the audit
log.

---

## OWN-15 · Un-supersede, unarchive, and arbitrary status restore are not guarded at the database

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / data-integrity
- **Locations:**
  - `supabase/migrations/20260822_review_completion_guard.sql:36-38` — `v_advancing` covers `current_version_id` changes and `→ 'Superseded'` **only**
  - `lib/documentLifecycle/reverse.ts:118-126` — `reverseSplit` sets `status: "Issued", superseded_at: null, supersession_reason: null`
  - `lib/documentLifecycle/reverse.ts:213-222` — `reverseMerge`, same
  - `lib/revisions.ts:1357-1372` — `unarchiveDocument` writes `status: restoreStatus || "Issued"` — a caller-supplied string with no allow-list
  - `components/documents/HistoryDrawer.tsx:45` — the only gate: `const isReverseAuthorized = activeRole === "Admin" || activeRole === "DocCtrl";` — client-side, headline role only
- **Related:** `OWN-3`, `OWN-17`
- **Re-verified:** hardening pass — **SURVIVES**. `v_advancing` fires only on a `current_version_id` change or a transition **into** `Superseded` (`20260822_review_completion_guard.sql:36-38`), while `reverse.ts:118-126` sets `status: "Issued"` and clears `superseded_at` — moving backwards, which the guard does not model.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by exhaustive trigger/policy search: nothing at the database restricts a status transition out of Superseded or Archived, and unarchiveDocument's caller (ArchiveConfirmModal.tsx:44) never passes restoreStatus, so an archived Superseded document silently returns as 'Issued'.

**Mechanism.** The guard is deliberately one-directional: it stops you retiring a
document without authority, but not *resurrecting* one.
`UPDATE documents SET status='Issued', superseded_at=NULL WHERE id=…` passes
every policy and trigger for any active org member.

**Failure scenario.** A superseded operating procedure — retired because it
caused an incident — is flipped back to `Issued`. `documents.status` drives the
document-control register, `/api/verify`, work-package retirement alerts,
knowledge-source sync, and search. The resurrected procedure re-enters every one
of those surfaces as current, and the retirement notice that went out has no
counterpart.

**Chain reaction.** Extending `v_advancing` to cover transitions *out of*
`'Superseded'` / `'Archived'` / `'Void'` makes `reverseSplit` / `reverseMerge`
require real database authority, where today only the client check stands. Verify
`components/documents/HistoryDrawer.tsx:45` uses `is_org_controller` semantics
(additive roles) **before** tightening the database — `OWN-3` interacts: a
DocCtrl+Manager would be refused by both.

**Done when.** Restoring a document out of a retired status requires the same
authority as retiring it, `restoreStatus` is validated against an allow-list, and
a test covers a non-controller attempting it.

---

## OWN-16 · Six divergent implementations of the effective-owner chain; three silently ignore team-owned libraries

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness / process
- **Locations:**
  - `lib/ownership.ts:24-59` — the canonical TypeScript version, **includes** the team fallback
  - `supabase/migrations/20260824_team_departments.sql:18-42` — the SQL version, includes the team fallback
  - `lib/docControlRegister.ts:110,154-163` — a third; includes teams but mislabels the source as `"library"` at `:162` instead of `"team"`
  - `lib/reviewCycles.ts:263,282-286` — fourth; `select("id, review_policy, owner_user_id, owner_name")` — **no `owner_team_id`**
  - `lib/reviewControl.ts:527,575-579` — fifth; **no `owner_team_id`**
  - `lib/acknowledgments.ts:559,588-592` — sixth; **no `owner_team_id`**
- **Related:** `OWN-12`
- **Re-verified:** hardening pass — **SURVIVES**. Two of the six are `resolveEffectiveOwner` (`ownership.ts:24-30`, document→folder→library, **no team branch**) and `user_is_effective_owner` (`20260824_team_departments.sql:18-42`, which **does** consult `teams.supervisor_user_id`). They disagree by construction on every team-owned library.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed exactly as described, including the scenario: the register (docControlRegister) names the team supervisor while the periodic-review nudge (reviewCycles), the review-timeout escalation (reviewControl) and the ack-overdue escalation (acknowledgments) all route to controllers instead.

**Mechanism.** `resolveEffectiveOwner` is a pure function whose team fallback
lives in its *async caller*, not in itself. Three call sites use the pure
function against library rows they fetched without `owner_team_id`, so every
team-owned library resolves to "unowned."

**Failure scenario.** A department (team) owns the drawings library. The
document-control register shows the team supervisor as owner; the periodic-review
nudge routes to Admin/DocCtrl instead. The supervisor never learns their
department's drawings are overdue for review; Doc Control gets nudges for
documents the register says are not theirs. The `20260824` header claims it
"slots a department layer into the existing owner chain" — it slotted it into two
of six.

**Chain reaction.** Consolidating on a single resolver is the right shape, but
that touches six files. Per the protocol, **the narrow fix is to add
`owner_team_id` to the three deficient selects** — do that first, and treat
consolidation as separate, human-approved work.

**Done when.** All six paths resolve a team-owned library to the same owner, and
`EffectiveOwner.source` reports `"team"` where the team fallback was used.

---

## OWN-17 · Revision-label correction and historical backfill are gated in the client only

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-08-24, roles-and-permissions Phase 3b — completing the Phase 0 partial).** The app half landed in Phase 0 (`backfillVersion` runs the publish-authority population before any write). The DB half is now the EGRESS-6 overlay (`20261037`): `backfillVersion`'s INSERT (caller-chosen `released_at`, `approved_by_name`, `file_hash`) needs the publisher-grade arm, and `correctRevisionLabel`'s UPDATE of a released row is admitted only by the same arm — a member who could not have published a revision can no longer rewrite its label at the database, whatever the client says. `correctRevisionLabel` also now refuses a zero-row denial instead of reporting success.
- Done-when: backfill refuses without publish authority ✓ (app + DB); a revision label cannot be rewritten by a member who could not have published it ✓ (DB overlay).
- ⚠ Rides **migration `20261037`** (awaiting hand-apply).

> **Phase 0 partial landed (2026-08-24, commit `2af2ebe`).** The free,
> independent half is done: `backfillVersion` now runs the same authority
> population as publish/revert/label-correction (per-library control via
> `resolveCanControlLibrary`, else `isEffectiveOwnerOfDocument`) **before any
> byte is hashed or uploaded** — it previously had no check of any kind while
> inserting rows with caller-chosen `released_at`, `approved_by_name` and
> `file_hash`. Pinned by `lib/__tests__/backfillAuthority.test.ts` (3 tests:
> refusal-before-upload for an unauthorized caller — which FAILED against the
> ungated code — plus the library-control and effective-owner allow paths).
> **What remains OPEN is the database half**: `document_versions_org_access
> FOR ALL` still lets any active member write `revision_label` /
> `document_versions` rows via PostgREST, so the second Done-when clause ("a
> revision label cannot be rewritten by a member who could not have published
> it") waits on the `EGRESS-6` RESTRICTIVE overlay (Phase 3, last), which must
> also allow `finalizeReviewedRevision`'s post-promote relabel under the
> finalizer's `auth.uid()`.
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / safety
- **Locations:**
  - `lib/revisions.ts:1058-1063` — `correctRevisionLabel` checks authority, then at `:1093-1105` updates `document_versions.revision_label` and `documents.rev`/`revision`
  - `supabase/schema.sql:1072` — `document_versions_org_access FOR ALL` for any active member
  - `supabase/migrations/20260822_review_completion_guard.sql:36-38` — a `rev` / `revision_label` change is not "advancing," so the publish guard never fires
  - `lib/revisions.ts:1594-1683` — `backfillVersion`: **no authority check of any kind**, no lock check, no hold check
- **Related:** `OWN-5`, `DB-4`
- **Re-verified:** hardening pass — **SURVIVES**. The correction path builds its `Principal` client-side (`revisions.ts:1058-1063`) and the table's only policy is `document_versions_org_access FOR ALL` (`schema.sql:1072`) — so the gate is the client's, and the database permits the write to any active member. See `EGRESS-6`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — both operations write document_versions under a policy that admits any active org member, and backfillVersion does not even have the client-side check that correctRevisionLabel has.

**Mechanism.** The controlled revision *label* — the string that appears on the
drawing, in transmittals, and in every "which rev do you have" conversation — can
be rewritten by any active org member through PostgREST. And arbitrary historical
version rows, with attacker-chosen `released_at`, `approved_by_name` and
`file_hash`, can be injected into any document's chain via `backfillVersion` with
no check at all.

**Chain reaction.** Guarding `rev` / `revision_label` at the database needs a new
trigger branch, and it will interact with `finalizeReviewedRevision`'s
post-promote relabel (`lib/reviewControl.ts:444-446`, which rewrites `2A → 2`) —
that write runs under the finalizer's `auth.uid()` and must be allowed. **Add the
authority check to `backfillVersion` first**; that one is free and independent.

**Done when.** `backfillVersion` refuses a caller without publish authority, and
a revision label cannot be rewritten by a member who could not have published it.

---

## OWN-18 · `org`-subject grants publish in one evaluator and nowhere else

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / access-control
- **Locations:**
  - `components/permissions/PermissionDrawer.tsx:52` — the drawer offers `{ key: "org", label: "Org" }` as a subject type
  - `lib/acl.ts:74-75` — `case "org": return !!ctx.orgId && ctx.orgId === id;` — matches
  - `lib/acl.ts:250` — `buildAclIndexFromRules` writes org grants into `allow.orgs.<action>`
  - `lib/permissions.ts:86-90` — `canPublishViaIndex` checks `users`, `roles`, `teams`. **Not `orgs`.**
  - `supabase/migrations/20260812_per_library_publish_authority.sql:75-85` — the SQL checks `users`, `roles`, `teams`. **Not `orgs`.**
  - `supabase/migrations/20260816_owner_publish_access.sql:40` — `acl_subject_has_action` **does** handle `orgs`
- **Related:** `OWN-6`, `OWN-8`
- **Re-verified:** hardening pass — **SURVIVES**, and the SQL side is verifiable in one function. `acl_subject_in_bucket` matches `users`, `roles` and `teams` (`20260708_acl_rls_enforcement.sql:27-36`) and has **no `org` branch**, while `lib/acl.ts:74-75` implements `case "org"` and `PermissionDrawer.tsx:52` offers it as a subject type.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — org-subject grants are collected into the index bucket and then never read by the index evaluator or the DB function, so the grant silently works or doesn't depending on whether acl_index happens to be populated. Note this fails closed (the grant is ignored), which supports MEDIUM rather than higher.

**Mechanism.** "Grant publish to everyone in the org" works in the raw evaluator
that drives the page's button, and fails in both index-based evaluators. Same
UI-shows / database-refuses split as `OWN-6`. The org bucket *is* honored for
`managePermissions` but not for `publish`.

**Done when.** An org-subject publish grant either works everywhere or is not
offered in the drawer for the `publish` action.

---

## OWN-19 · A granted publisher can rev-up but cannot supersede, archive, split or merge — the database allows all of it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `components/documents/InspectorPanel.tsx:283-284` — `canManage = isController || isOwner`; `canPublishEff = canPublish || isOwner`
  - `components/documents/InspectorPanel.tsx:516` — Publish button gated on `canPublishEff`
  - `components/documents/InspectorPanel.tsx:888` — the whole **Manage & lifecycle** section (Supersede `:922`, Archive `:931`, split/merge/renumber `:892`, Move `:902`, Permissions `:905`) gated on `canManage` — **`canPublish` is not in that expression**
  - `lib/revisions.ts:1425` — `supersedeDocument` calls the same `authorizePublish` as rev-up
  - `supabase/migrations/20260822_review_completion_guard.sql:38,69-70` — the database authorizes a granted publisher to supersede
- **Related:** `OWN-9`
- **Re-verified:** hardening pass — **SURVIVES**. `canPublishEff` gates `onRevUp` (`InspectorPanel.tsx:516`) while supersede, archive, split and merge sit behind `canManage = isController || isOwner` (`:283`) — and `documents_org_access FOR ALL` permits all of it at the database.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — the UI ties structural lifecycle acts to controller-or-owner while the publish guard (and lib/revisions' own authorizePublish) admits granted publishers, and archive is ungated entirely. Fails closed in the UI, so MEDIUM is right.

**Mechanism.** The authority model says publish authority covers rev-up, revert
and supersede. The Inspector splits them: rev-up follows publish authority,
supersede follows *ownership*. A Drafting Supervisor granted publish on the
drawings library can issue Rev 5 but cannot retire a drawing — with no
explanation, because the button simply is not rendered.

**Done when.** The Inspector's lifecycle affordances match the authority the
mutators and the database actually enforce, or the difference is deliberate and
explained in the UI.

---

## OWN-20 · Descendant `acl_index` goes stale when a library's ACL changes

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `components/permissions/PermissionDrawer.tsx:273-284` — recomputes `acl_index` for the edited node **only**
  - `app/(protected)/documents/[libraryId]/page.tsx:600-605`, `:2073`, `:2450-2452` — descendants compute their index once, at creation, from the then-current chain
  - `supabase/migrations/20260901_db_hard_enforcement.sql:124-125` — *"acl_index is chain-resolved when written … so a single-node check faithfully enforces inherited denies"* — true only until the parent changes
- **Related:** `OWN-7`, `DOCACL-*`
- **Re-verified:** hardening pass — **SURVIVES**. Same evidence as `DB-4` — `PermissionDrawer.tsx:284` updates only `.eq("id", nodeId)`. Duplicate within this area; fix once.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence: every acl_index writer in the repo (PermissionDrawer.tsx:284, documents/[libraryId]/page.tsx:604 and :2073, lib/libraryCollections.ts:108) writes exactly one node at creation/edit time, and no migration contains an acl_index backfill/rebuild. Nothing re-derives descendants when a parent's ACL changes.

**Mechanism.** This does not affect publish authority today, because the database
reads `libraries.acl_index` directly and that node's own index is always fresh.
It **does** affect `documents_deny_write_guard` and `node_visible`. It becomes
load-bearing the moment anyone proposes "make publish authority chain-resolved
like everything else" — which is the natural remediation to reach for on `OWN-7`.

**Done when.** Changing a library's ACL is reflected in its descendants'
`acl_index`, or every consumer resolves the chain at read time rather than
trusting the stored index.

---

## OWN-21 · Dead code and never-wired declarations on the ownership surface

- **Severity:** MEDIUM
- **Status:** OPEN

> **Phase 0 dispositions landed (2026-08-24, commit `2af2ebe` + follow-up).**
> Per `DEC-11`: `p_actor_role` removed from both `publish_revision` call sites
> and retired from the SQL signature
> (`supabase/migrations/20261019_publish_revision_drop_dead_param.sql` — the
> old signatures are DROPped explicitly because Postgres keys functions by
> signature; apply after deploying the code). `canBlindDrillAccess` and
> `filterDiscoverable` removed from `lib/permissions.ts` (zero callers,
> restorable from git; a comment marks the removal). The missing owner indexes
> added: `supabase/migrations/20261021_owner_lookup_indexes.sql`
> (`libraries_owner_idx`, `collections_owner_idx`, same partial-index shape as
> `documents_owner_idx`). The `Capability` vocabulary in
> `lib/roleCapabilities.ts` marked **PICKER-ONLY** in its header per DEC-11.
> Remaining rows (`org_has_active_subscription` wiring → DEC-18/Phase 6, the
> `revision_branches` authority gap, `NEW`/`PENDING_ENG_INITIAL`/`CANCELED` →
> DEC-14/Phase 4, ticket dormant flags, `owner_name` cache posture → DEL-8)
> stay OPEN here and land with their phases.
> One rpc-shape note for the record: after the signature change, the client's
> v1-shape retry (folding `p_override_lock` into `p_force`) can fire during a
> transient PGRST202 schema-cache blip; the SQL enforces `p_force AND
> v_is_controller`, so for a non-controller the fold fails CLOSED
> (`locked_by_other`) — an availability edge during cache reloads, not an
> escalation.
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity
- **Re-verified:** hardening pass — **SURVIVES**. `canBlindDrillAccess` (`permissions.ts:134-145`) has **0 callers** anywhere in `app/`, `lib/` or `components/`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. The finding as a whole holds — seven of its eight line items check out — but one row is factually wrong and should be struck. Severity stays MEDIUM (the only genuinely security-relevant item, the open revision_branches UPDATE policy, is already called out separately).

> **Dispositions are settled in `DEC-11`** — per item, below. Two are real
> defects rather than cleanup: `revision_branches` resolution is open to any
> active member, and `p_actor_role` reads as a check on a security-relevant RPC
> while being referenced nowhere.

| Item | Location | State |
|---|---|---|
| `p_actor_role` | `20260823_publish_contract.sql:131`, `20260828_integrity_hardening.sql:46` | Declared in both signatures, **never referenced in either body**. The client dutifully sends it (`lib/revisions.ts:541`, `:1199`). Decoration on a security-relevant RPC. |
| `org_has_active_subscription()` | `20260713_document_publish_guard.sql:96-106` | Self-documented as *"NOT wired to any blocking policy yet."* Zero references. |
| `canBlindDrillAccess` | `lib/permissions.ts:134` *(removed 2026-08-24 — a comment at that spot records the DEC-11 removal)* | Exported, zero callers. |
| `filterDiscoverable` | `lib/permissions.ts:134` *(removed 2026-08-24, same note)* | Exported, zero callers. |
| `owner_name` columns | `20260630_document_ownership.sql:10,12,14` | Written once by `lib/ownership.ts:130`, read only for display. Never refreshed → drifts when a person is renamed. `owner_team_id` has **no** name column at all. |
| Owner indexes | `20260630_document_ownership.sql:17` | Index exists on `documents(org_id, owner_user_id)` only. `libraries.owner_user_id` and `collections.owner_user_id` are unindexed. |
| `EffectiveOwner.source === "collection"` | `lib/ownership.ts:19,25` | Produced but never branched on by any consumer. |
| `revision_branches` resolution | `20260823_publish_contract.sql:113-116` | *"Any active org member may resolve"* — branch debt on a controlled document can be closed as `merged` by anyone, no owner or controller involved. **This one is a real authority gap, not just dead weight.** |

**Done when.** Per `DEC-11`, each row reaches its stated disposition:

- **Removed:** `p_actor_role` (from both signatures and from
  `lib/revisions.ts:541,1199`), `canBlindDrillAccess`, `filterDiscoverable`.
- **Fixed as a defect:** `revision_branches` resolution restricted to a
  controller or the document's effective owner.
- **Added:** indexes on `libraries.owner_user_id` and
  `collections.owner_user_id`.
- **Kept:** `org_has_active_subscription()` (wired per `DEC-18`), `owner_name`
  as a cache that nothing branches on (`DEL-8`), and
  `EffectiveOwner.source === "collection"` (made live by `DEL-7`).

Every removal is recoverable from git; every retention has a recorded reason.

---

## OWN-22 · The "Save As" library-creation path still births unowned libraries

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / accountability
- **Locations:**
  - `lib/libraryCollections.ts:120-147` — `createLibrary`, writes no owner columns
  - `components/documents/DocumentLinkPicker.tsx:76` — its caller (the "Save As" flow)
  - `app/(protected)/admin/libraries/LibraryWizard.tsx` — the wizard path, which now DOES prompt (GAP-12)
- **Related:** `GAP-12`, `DEL-8`
- *(Found while building `GAP-12`, 2026-08-24. Checked only by this session — treat per the `author` grade until independently challenged.)*

**Mechanism.** `GAP-12` closed the "libraries are born unowned" gap for the
wizard — its acceptance criterion covered only "creating a library" through the
admin surface. A second creation path exists: `createLibrary` in
`lib/libraryCollections.ts`, reached from `DocumentLinkPicker`'s Save-As flow,
and it writes no `owner_user_id`. Unowned births continue from this door, now
visible as such in the console's unowned count.

**Failure scenario.** A drafter saves a linked drawing into a new library via
Save-As; the library lands unowned, its review-cycle reminders route to
Admin/DocCtrl, and nobody notices until the unowned count is questioned.

**Done when.** Either `createLibrary` accepts and writes an optional owner (with
`setOwner` semantics — audit row + notification), or the Save-As flow visibly
states the library will be unowned until assigned in the console.

---

## Verified sound — do not break

1. **`publish_revision`'s transactional core.** `SELECT … FOR UPDATE` on the
   documents row, the expected-base check *before* any write, `stale_base`
   returned as structured data rather than an exception, and the
   `document_versions_active_label_uniq` partial index as a last-resort backstop.
   The "publish as branch → open a `revision_branches` debt row" escape hatch is
   a genuinely good pattern: visible debt instead of a silent clobber. The
   authority holes in `OWN-5` are a **bolt-on to fix — do not rewrite the
   contract.**
2. **The review-completion gate sits above the role short-circuit.**
   `20260822:43-58` runs the roster-completeness check **before** the
   `Admin/DocCtrl` return, with the explicit reasoning *"it's a data-integrity
   gate, not an authority one."* That is exactly right for PSM: nobody, including
   Admin, publishes a revision with outstanding required sign-offs. **Preserve
   this ordering through any refactor.**
3. **Holds are stricter than locks, consistently.** A checkout override passes the
   lock and never a hold — in the pure function, in the trigger, and in the RPC.
   Three layers, same rule, correctly asymmetric. Keep `p_force` and
   `p_override_lock` separate.
4. **`is_org_controller()` is the correct controller primitive.**
   `SECURITY DEFINER`, additive-roles-aware, no RLS recursion. The problem is
   that five checks do not route through it (`OWN-3`), not that this function is
   wrong.
5. **The CAS on `pending_version_id` in `finalizeReviewedRevision`**
   (`lib/reviewControl.ts:429-439`) — the one place in this whole surface that
   checks a write's row count, and the one that most needed it.
6. **`evaluatePublishGuard` as a pure, exhaustively tested function**
   (`lib/documentGuards.ts:109-151`), and `canPublishOnLibrary`'s deliberate
   library-only ACL scope with its own test file. The *design* of per-library
   publish authority is right. It is the wiring that has forked.
7. **`RoleModelTree` and `ViewAsSimulator` as artifacts.** Even with the bugs
   (`OWN-10`), a self-documenting authority model *inside the product*, with an
   explicit "Known gaps" section that admits its own inconsistencies, is unusual
   and worth keeping. Fix them; do not remove them.
