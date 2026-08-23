# 03 · The audit log & admin rails

**14 findings** — 1 CRITICAL · 4 HIGH · 9 MEDIUM.

What the trail can prove, and whether every admin surface is gated server-side.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| audit_logs is genuinely append-only for authenticated callers — no UPDATE and no DELETE policy is created anywhere, and no app code path deletes or updates a row | `supabase/schema.sql:1084-1087; supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90 ("Rows remain append-only (no UPDATE/DELETE policy exists)")` | This is the one PSM-grade property the audit table actually has. Verified two ways: a policy census over supabase/ for `ON audit_logs`, and a repo-wide grep of `audit_logs` filtered for delete/update, which returns only inserts. Any future fix must not add a FOR ALL policy here. |
| audit_logs_insert pins user_id = auth.uid() AND org membership, closing cross-org audit injection | `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90` | A member cannot write forged entries into another org's trail. This is the rail that makes the remaining forgery vectors (restore, client-supplied user_role) bounded rather than unlimited. |
| Every /api/admin/* route verifies a bearer token through the anon client before it ever touches the service-role client | `lib/serverAuth.ts:36-58; all 18 routes under app/api/admin/ call authorizeOrgRole or an equivalent inline check (app/api/admin/create-user/route.ts:22-31, app/api/admin/schema-health/route.ts:33-40)` | The client-only gating on the /admin pages is survivable precisely because the destructive server routes are gated independently. Do not consolidate page gating in a way that removes these. |
| prevent_last_admin_removal() blocks demoting, suspending or deleting an org's final active Admin, and exempts the service role | `supabase/migrations/20260831_capability_policy_and_rails.sql:43-76` | The recoverability rail. It is BEFORE UPDATE/DELETE on org_members and is the reason a misconfigured capability policy is always fixable. |
| validateCapabilityPolicy refuses any save that removes Admin from a capability marked critical, and the editor locks that checkbox in the UI | `lib/capabilityPolicy.ts:200-214; components/permissions/CapabilityPolicyEditor.tsx:147` | Belt-and-braces on the same rail. Two independent enforcement points for the same invariant. |
| /api/admin/create-user validates the role string against ALL_ROLES, refuses a DocCtrl minting an Admin, and refuses a DocCtrl demoting an existing Admin on the re-add path | `app/api/admin/create-user/route.ts:49-51, 66-72, 118-125` | The only server-side member-provisioning path, and it is carefully written. The gap is that it writes no audit row (see finding), not that it is unguarded. |
| /api/admin/schema-health exists as an honest rail for detecting migrations that were never pasted in, including per-column probes | `app/api/admin/schema-health/route.ts:24-27, 55-65; lib/schemaExpectations.ts:117-126` | It is the correct place to catch the org_configurations column defect below — EXPECTED_COLUMNS just does not carry that probe yet. |
| documents and document_versions carry BEFORE DELETE legal-hold triggers that also block cascading deletes | `supabase/migrations/20260826_legal_hold_delete_guard.sql:29-57 (OLD.record_id matches document_versions.record_id, supabase/schema.sql:322)` | The only thing standing between a library DELETE and total loss of a held record. A fix to library deletion must not route around these. |


---


<a id="alog-1"></a>

## ALOG-1 · The capability policy is read from and written to `org_configurations.value` — a column that does not exist; the table's column is `data`, so every org's action-permission policy and every per-person delegation is inert, and the DB function that holds RLS depends on raises at runtime

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/capabilityPolicy.ts:172-176`, `lib/capabilityPolicy.ts:229-235`, `supabase/migrations/20260901_db_hard_enforcement.sql:44-45`, `supabase/schema.sql:52-59`, `lib/orgBranding.ts:22-28`, `lib/ticketRouting.ts:48-53`, `app/(protected)/admin/requests/page.tsx:98-99`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide search confirms the absence: no `ALTER TABLE org_configurations`, no `ADD COLUMN value`, no rename anywhere under supabase/ — the only `value JSONB` in the tree is an unrelated table in 20260920_per_user_keys_real_limits.sql:25. The read path fails silently (supabase-js returns an error object, `data?.value` is undefined, raw={} so DEFAULTS apply); the save path throws at capabilityPolicy.ts:234 `if (error) throw new Error(error.message)`; and org_capability_allows() — whose body is only planned at execution time — raises `column "value" does not exist` on every call, which is exactly what gates the document_holds INSERT/UPDATE policies (20260901:94,99,101) and the checkout force-release trigger (:115). CRITICAL is correct.

**Mechanism.** `org_configurations` is defined exactly once, in supabase/schema.sql:52-59, as `id / org_id / key / data JSONB NOT NULL DEFAULT '{}' / updated_at`. There is no `value` column and no migration adds one. Three differently-shaped searches confirm it: (a) `grep -rniE "alter table (public\.)?org_configurations" supabase/` returns only the ENABLE ROW LEVEL SECURITY line; (b) `grep -rn -A8 "CREATE TABLE IF NOT EXISTS org_configurations" supabase/` returns one definition, with `data`; (c) listing every repo file that mentions `org_configurations` and testing each for the token `value` leaves only lib/capabilityPolicy.ts and 20260901_db_hard_enforcement.sql. Every other consumer uses `data`: `.select("data")` in lib/orgBranding.ts:24 and lib/ticketRouting.ts:50, and `.upsert({ org_id: activeOrgId, key: 'drafting', data: settings }, ...)` at app/(protected)/admin/requests/page.tsx:99. The two outliers are: `loadCapabilityPolicy` — `.from("org_configurations").select("value").eq("org_id", orgId).eq("key", "capability_policy")` (lib/capabilityPolicy.ts:173-176), wrapped in a `try { … } catch { return {}; }` (line 190) so PostgREST's 42703 becomes a silent fall-through to the shipped DEFAULTS; `saveCapabilityPolicy` — `.upsert({ org_id: input.orgId, key: "capability_policy", value: input.policy, updated_at: … }, { onConflict: "org_id,key" })` (line 231), which does check `{ error }` and throws; and the SQL helper `org_capability_allows()`, whose body is `SELECT value INTO v_val FROM org_configurations WHERE org_id = p_org AND key = 'capability_policy';` (20260901:44-45) with no declared variable named `value`, so the reference resolves to a column and plpgsql raises 42703 on first execution.

**Failure scenario.** An Admin opens /admin/permissions, unchecks Supervisor from "Force close" and Manager from "Reopen closed tickets", confirms the impact dialog, and gets an error (the upsert throws on the unknown column) — or, on a database where 20260901 was applied, something worse happens first: `document_holds_insert WITH CHECK (org_capability_allows(org_id,'holds.open',auth.uid()))` (20260901:92-94) and the `enforce_checkout_release_guard` trigger (20260901:108-120) both call the failing function, so placing a do-not-advance hold on a P&ID and force-releasing a stale checkout fail with a raw Postgres error for every authenticated user. Meanwhile `loadCapabilityPolicy` swallows its own 42703 and returns `{}`, so ViewAsSimulator, CapabilityPolicyEditor, /admin/analytics and /admin/archive-view all render the shipped defaults as if they were the org's configured policy — and every per-person delegation granted through the View-as panel is invisible to the evaluator that is supposed to honour it. The delegation UI's own promise, "Audited with before/after; the 'View as' list above updates instantly" (ViewAsSimulator.tsx:225), cannot hold.

**Evidence.**

```
lib/capabilityPolicy.ts:173-176 — `.from("org_configurations")` / `.select("value")` / `.eq("org_id", orgId)` / `.eq("key", "capability_policy")`, inside `try { … } catch { return {}; // defaults apply }` (line 190). lib/capabilityPolicy.ts:231 — `{ org_id: input.orgId, key: "capability_policy", value: input.policy, updated_at: new Date().toISOString() }`. supabase/schema.sql:55-56 — `key TEXT NOT NULL,` / `data JSONB NOT NULL DEFAULT '{}',`. supabase/migrations/20260901_db_hard_enforcement.sql:44 — `SELECT value INTO v_val FROM org_configurations`; the DECLARE block at :31-37 declares only `v_val, v_tokens, v_role, v_roles, v_grant, t`. lib/ticketRouting.ts:50 — `.select("data")` for the sibling key. lib/__tests__/capabilityPolicy.test.ts exercises only the pure functions (policyAllows, validateCapabilityPolicy, defaults) and never the load/save DB shape, which is why this is untested.
```

**Chain reaction.** Everything that reads authority through this policy: lib/holds.ts (holds.open / holds.release), the workflow-action route's server-side re-derivation, /admin/analytics and /admin/archive-view page gating (they call policyAllows on the loaded policy), the ViewAsSimulator capability column, and the DB-side holds/force-release enforcement introduced in 20260901. Fixing the column name in TypeScript alone would silently activate a policy that has never been enforced — any org that clicked Save and got an error, then edited the grid again, may have a partially-stored intent. Coordinate with roles-and-permissions WF-11 (capability_policy write gating) and DB-1.

> **Verifier correction.** One mechanism detail is wrong, without changing the conclusion: the `try { … } catch { return {}; }` at lib/capabilityPolicy.ts:190 is NOT what swallows the read failure. supabase-js resolves with {error}, and the code destructures only `{ data }` (line 172), so `data` is null, `raw` becomes {}, and loadCapabilityPolicy returns {caps:{}, grants:[]} — which it then CACHES for 60s. Defaults apply either way. Also note saveCapabilityPolicy DOES check {error} and throws (line 235), so the save surfaces an error to the admin and the CAPABILITY_POLICY_CHANGED audit row at :239 is never reached at all.

**Done when.**

- [ ] One column name is used everywhere for org_configurations; a test or probe asserts that `loadCapabilityPolicy` round-trips a saved policy against the real column name.
- [ ] `loadCapabilityPolicy` no longer converts a schema error into shipped defaults — an unreadable policy is distinguishable from an unset one.
- [ ] `org_capability_allows()` is executed at least once against the real schema (e.g. by an EXPLAIN or a smoke insert into document_holds) and returns without raising 42703.
- [ ] lib/schemaExpectations.ts EXPECTED_COLUMNS carries a probe for the org_configurations column the code reads, so /api/admin/schema-health would have caught this.

---

<a id="alog-2"></a>

## ALOG-2 · Access recertification — the periodic "does everyone still need this?" control — cannot fail visibly, is not restricted to the reviewers its own design names, and its attestation record is writable and deletable by any active member

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/accessRecert.ts:80-114`, `lib/accessRecert.ts:59-76`, `components/documents/AccessRecertModal.tsx:53-67`, `supabase/migrations/20260821_access_recert.sql:39-44`, `supabase/migrations/20260819_orphan_tables_backfill.sql:223-238`, `app/(protected)/documents/[libraryId]/page.tsx:3372-3379`, `lib/accessRecert.ts:128-145`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All three limbs hold. `FOR ALL` with a plain active-member predicate means any member — Viewer, Contractor, the departed contractor being reviewed — can INSERT a forged attestation or DELETE a real one; there is no reviewer restriction at the data layer and no UPDATE/DELETE-blocking policy. The UI entry point is gated (page.tsx:3372 `{isController && ...}`, isControllerRole = Admin|DocCtrl only, permissions.ts:18-20), which notably excludes the library *owner* the module header names as a reviewer — so the gate is both wrong-tight in the UI and wrong-loose in the database.

**Mechanism.** Four defects compound. (1) None of the writes check `{ error }`: `recertifyAccess` performs `await supabase.from("libraries").update({ last_recertified_at: now, … })` and `await supabase.from("access_recertification_events").insert({ … })` with no destructuring, then unconditionally returns `{ grantCount, nextDate }`; the modal wraps the call in `try { … } finally { setBusy(false) }` with no catch and no error state, so a rejected attestation is indistinguishable from a successful one. (2) The audit call passes `userId: input.actorId ?? ""` into a `UUID` column (schema.sql:777), which is 22P02 — the exact mechanism drafting-flow EVID-6 confirmed for reviewControl — and is then `.catch(() => {})`'d, which catches nothing because nothing throws. (3) The attestation table's only policy is `FOR ALL TO authenticated USING (org member) WITH CHECK (org member)`, created twice (20260821:41-44 and again by the loop at 20260819:223-238); there is no constraint tying `performed_by` to `auth.uid()`, and no restriction on UPDATE or DELETE — so any active member can forge, backdate, alter or erase an attestation, and can reset the clock by updating `libraries.next_recertification_date` (libraries is `FOR ALL USING (org_id IN my_org_ids())`). (4) The module docstring says "the library's owner / Admin / DocCtrl reviews who has access" and `scanAccessRecerts` notifies `[...(ownerId ? [ownerId] : []), ...controllers]` with body "Review who has access to this library and recertify it" and a link to `/documents/{id}` — but the only entry point is inside `{isController && ( … )}`, so a non-controller owner receives a notification and an inbox item for an action the UI never offers them. Separately, `listAccessGrants` filters on `effect === "allow"` and never filters expired rules, so `grant_count` and the snapshot include grants whose `expiresAt` has passed.

**Failure scenario.** A DocCtrl performs the semi-annual access review on the P&ID library, prunes two departed contractors, types "removed 2 contractors" and clicks "Recertify — access reviewed". The `libraries` update is rejected (any RLS or constraint fault); the events insert is rejected; the audit row is rejected on the empty-string uuid. The spinner stops, the modal reloads and shows the old "Last recertified" date, and no error appears anywhere. The reviewer believes the control was executed. Six months later the clock says overdue and there is no record that a review ever happened — and separately, any member of the org could have inserted a `recertified` row naming that DocCtrl to make it look as though one had.

**Evidence.**

```
lib/accessRecert.ts:106-111 — `await supabase.from("libraries").update({ last_recertified_at: now, last_recertified_by: input.actorId ?? null, next_recertification_date: nextDate, recert_notified_at: null }).eq("id", input.libraryId);` / `await supabase.from("access_recertification_events").insert({ … action: "recertified", grants_snapshot: grants, grant_count: grants.length, … performed_by: input.actorId ?? null, … });`. lib/accessRecert.ts:112 — `userId: input.actorId ?? ""` … `.catch(() => {});`. components/documents/AccessRecertModal.tsx:65 — `try { await recertifyAccess({ … }); setNote(""); await load(); onSaved?.(); }` followed at :66 by `finally { setBusy(false); }` — no catch. supabase/migrations/20260821_access_recert.sql:41-44 — `CREATE POLICY "access_recert_events_member" ON access_recertification_events` … `USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = access_recertification_events.org_id AND uid = auth.uid() AND status = 'active'))` / `WITH CHECK (…same…)`. lib/accessRecert.ts:3-6 — `On a cadence, the library's owner / Admin / DocCtrl reviews who has access`. lib/accessRecert.ts:136-140 — `const targets = uniq([...(ownerId ? [ownerId] : []), ...controllers]);` … `body: "Review who has access to this library and recertify it."`. lib/accessRecert.ts:62 — `.filter((r) => (r as AccessRule).effect === "allow")` with no expiry filter, while :74 carries `expiresAt` through unused.
```

**Chain reaction.** The FOR-ALL-with-WITH-CHECK-but-no-actor-binding shape on access_recertification_events is the same pattern the earlier audits found on tickets, notifications, email_notifications and project_documents. Tightening it will start rejecting the client-side insert above, which currently fails silently — so the unchecked-write fix must land with or before the policy fix, or the control goes from "silently unrecorded" to "silently unrecorded and also refused". The owner-notification dead end also touches the notifications area's recipient-resolution work.

> **Verifier correction.** Leg (2) is theoretical and should be dropped from the claim. `userId: input.actorId ?? ""` (:112) only produces the empty string when actorId is null, and the sole caller passes `uid` from a page where the user is a signed-in controller; nobody ran this and no code path supplies null. Also note `.catch(() => {})` there is harmless-but-inert for a different reason than stated: logAuditAction has its own try/catch (lib/audit.ts:17-30) and never rejects, so the error is dropped inside the helper, not by the .catch.

**Done when.**

- [ ] A failed recertification write surfaces an error to the reviewer instead of returning a success value.
- [ ] access_recertification_events binds performed_by to auth.uid() on INSERT and admits no UPDATE or DELETE from an authenticated caller.
- [ ] The set of people who can perform a recertification matches the set the scan notifies, or the notification stops naming people who cannot act.
- [ ] grant_count and grants_snapshot exclude rules whose expiresAt has passed, or label them.

---

<a id="alog-3"></a>

## ALOG-3 · Deleting a library cascades away every document and revision in it, writes no audit row, and its "safety" modal previews nothing — the confirmation asks the admin to type a name against a hedge, not a count

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/libraries/page.tsx:147-162`, `app/(protected)/admin/libraries/DeleteSafetyModal.tsx:47-52`, `supabase/schema.sql:93, 117, 133`, `supabase/schema.sql:322`, `supabase/schema.sql:1060`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence too: grep across the repo finds no LIBRARY_DELETED/LIBRARY_CREATED/LIBRARY_UPDATED audit action and no trigger on `libraries` (the only migrations touching it add columns and indexes). The modal takes no count props at all — its whole prop surface is {isOpen,onClose,onConfirm,libraryName,isLoading} — so it structurally cannot preview what is destroyed, and 'may become orphaned' actively understates a two-level ON DELETE CASCADE. The legal-hold triggers in 20260826_legal_hold_delete_guard.sql fire per-row on documents/document_versions, so they stop only flagged rows.

**Mechanism.** `confirmDelete` is three lines of work: `const { error } = await supabase.from("libraries").delete().eq("id", libraryToDelete.id!);` then optimistic list removal. It queries nothing before deleting and logs nothing after. `collections.library_id`, `document_sets.library_id` and `documents.library_id` are all `NOT NULL REFERENCES libraries(id) ON DELETE CASCADE`, and `document_versions.record_id` is `NOT NULL REFERENCES documents(id) ON DELETE CASCADE`, so one PostgREST DELETE removes the library, every folder, every document record and every revision row in it — leaving the R2 objects orphaned and the surviving audit rows pointing at resource_ids that no longer resolve. The modal that gates it renders no counts at all; its entire impact statement is prose: "Documents inside this library may become orphaned or inaccessible if not migrated first." "May" is wrong in both directions — they are not orphaned, they are deleted. A per-file grep of app/(protected)/admin/libraries/ for `logAuditAction|audit_logs` returns zero, and there is no trigger on `libraries` in the migration set.

**Failure scenario.** A controller cleaning up a duplicate library types the name, confirms, and destroys the live "Piping Isometrics" library instead: 1,400 controlled drawings and every revision of each. The legal-hold triggers stop the cascade only for rows explicitly flagged `legal_hold`; everything else goes. The audit log contains no DELETE, no LIBRARY_DELETED, nothing — the last record of the event is a browser console line and an optimistic list update. The only reconstruction path is /admin/restore, which is itself an unaudited service-role import (roles-and-permissions SURF-8).

**Evidence.**

```
app/(protected)/admin/libraries/page.tsx:151 — `const { error } = await supabase.from("libraries").delete().eq("id", libraryToDelete.id!);`. app/(protected)/admin/libraries/DeleteSafetyModal.tsx:47-52 — `This action is <span…>irreversible</span>. This will permanently delete the <strong>{libraryName}</strong> library configuration. Documents inside this library may become orphaned or inaccessible if not migrated first.` supabase/schema.sql:133 — `library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,` (documents); :93 the same for collections; :117 for document_sets. supabase/schema.sql:322 — `record_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,`.
```

**Chain reaction.** roles-and-permissions OWN-1 owns the authorization half of this — `libraries_org_access FOR ALL USING (org_id IN (SELECT my_org_ids()))` means any active member can issue this DELETE, and OWN-1's Done-when #3 is "DELETE on libraries is restricted to controllers." OWN-1 also warns that adding a RESTRICTIVE policy here will make several existing `.update()` calls on libraries fail silently (OWN-14) — including handleSaveLibrary in this same file. The evidence half (impact preview + audit row) is independent of that sequencing and can ship first.

**Done when.**

- [ ] The delete confirmation shows the real counts it is about to destroy (folders, documents, revisions, open holds, referencing tickets), queried before the delete.
- [ ] A library deletion writes an audit_logs row naming the library, the counts and the actor, on a path whose failure is observable.
- [ ] The modal's copy matches what the database actually does (cascade, not orphan).

---

<a id="alog-4"></a>

## ALOG-4 · The entire user and role administration surface writes no audit row at all: granting a role, removing a role, adding a member and removing a member are all unrecorded

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/users/page.tsx:123-156`, `app/(protected)/admin/users/page.tsx:163-186`, `app/api/admin/create-user/route.ts:127-170`, `app/(protected)/admin/settings/page.tsx:103-118`, `app/(protected)/admin/libraries/page.tsx:110-129`, `lib/orgBranding.ts:32-38`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The absence claim checks out repo-wide: a grep for ROLE_GRANT/ROLE_CHANGE/MEMBER_ADDED/MEMBER_REMOVED/USER_CREATED-style actions returns nothing, and the only migrations touching org_members with triggers are 20260831's last-admin guards (trg_prevent_last_admin_update/_delete), which block but do not record. `addRole`/`removeRole` (:159-161) both funnel into persistRoles, so the whole grant/revoke surface is unrecorded.

**Mechanism.** `persistRoles` writes the member's whole authority — `supabase.from('org_members').update({ roles: cleaned, role: headline }).eq('id', member.id)` — and calls no audit helper. `handleRemoveMember` issues `supabase.from('org_members').delete().eq('id', member.id)` and calls no audit helper. `/api/admin/create-user` creates the auth user, inserts or updates the org_members row (including reactivating a suspended member and rewriting their role at lines 127-135), upserts the profile, and returns — with no audit_logs insert anywhere in the file. Two searches confirm the absence: a per-file count of `logAuditAction|audit_logs` across every file under app/(protected)/admin/ returns 0 for users, settings, libraries, branding, teams, scope, codebook, assets, holds, restore, storage, requests, proposed-links, billing, permissions and analytics (only data-export and the audit viewer itself score above 0); and a targeted read of create-user/route.ts end to end shows no audit call. The same holds for the workspace-identity writes next door: `saveNumbering` rewrites `orgs.ticket_prefix / ticket_record_code / ticket_number_pad` — the scheme that forms every future request number — unaudited, and `saveOrgBranding` upserts the org's enforced palette unaudited.

**Failure scenario.** A Manager promotes a contractor to Engineer-3 on Tuesday, the contractor approves a piping revision on Wednesday, and the Manager removes the role on Thursday. The audit log contains the approval, attributed to "Engineer-3", and contains nothing about the grant or the revocation. An investigator reconstructing "was this person authorised to approve at the time?" finds the answer nowhere in the system — org_members holds only current state, and the audit trail, which exists precisely to answer that question, was never written. The same gap covers member removal: an offboarding leaves no record of who removed whom or when.

**Evidence.**

```
app/(protected)/admin/users/page.tsx:134-137 — `const { error } = await supabase` / `.from('org_members')` / `.update({ roles: cleaned, role: headline })` / `.eq('id', member.id);`. app/(protected)/admin/users/page.tsx:178 — `const { error } = await supabase.from('org_members').delete().eq('id', member.id);`. app/api/admin/create-user/route.ts:128-135 — `await supabaseAdmin.from("org_members").update({ role, roles: [role], status: "active", display_name: displayName ?? null })` — and the file's final statement is `return NextResponse.json({ uid: userId });` at :172. app/(protected)/admin/settings/page.tsx:110-114 — `await supabase.from("orgs").update({ ticket_prefix: …, ticket_record_code: …, ticket_number_pad: … }).eq("id", activeOrgId)`.
```

**Chain reaction.** roles-and-permissions SURF-13 already records the sibling gap on teams (`lib/teams.ts:66-118` — createTeam / addTeamMember / removeTeamMember / deleteTeam: zero logAuditAction calls); this is the same defect on the primary role surface. Note also that `handleRemoveMember`'s delete cannot succeed at all — SURF-1 established that no DELETE policy on org_members exists after 20260817 — so the removal path is doubly silent. Any fix should write the audit row server-side (the create-user route already holds a verified actor), not from the client, since the client path is the one that silently fails.

**Done when.**

- [ ] A role grant, a role revocation, a member add and a member removal each write an audit_logs row naming actor, subject, before-roles and after-roles.
- [ ] The ticket-numbering and branding writes on /admin/settings and /admin/branding are audited, or an explicit decision records why they are not.
- [ ] The audit row is written on a path whose failure is observable (see the swallowed-insert finding).

---

<a id="alog-5"></a>

## ALOG-5 · `/activity` renders the entire org audit log to every role with no gate of any kind, sitting in the same tab strip as /admin/audit's "Admin-class roles only" banner

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/activity/page.tsx:99-117`, `app/(protected)/admin/audit/page.tsx:27, 94, 196-208`, `components/navigation/ViewTabs.tsx:99-102`, `components/navigation/Sidebar.tsx:239, 245-249`, `supabase/schema.sql:1084-1085`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The only role filtering is cosmetic and does not cover the scenario: Sidebar.tsx:239 lists Activity in `workAll`, and :245-249 strips it only for `activeRole === 'Viewer' || activeRole === 'Contractor'` — a Maintenance, Operations, Safety, HR, Accounting or Drafter member keeps the link, and even Viewer/Contractor can reach /activity by URL since nothing server-side or in RLS stops the read.

**Mechanism.** /admin/audit gates itself on `const ADMIN_ROLES = new Set(["Admin","Manager","Supervisor","DocCtrl","Auditor"])` and renders a refusal card reading "Admin-class roles only. Ask your workspace admin if you need access." /activity reads the same table with the same org filter — `supabase.from("audit_logs").select("*").eq("org_id", activeOrgId).order("timestamp", {ascending:false}).limit(limit)` — and has no role check whatsoever. Two searches confirm the absence: `grep -n "activeRole|ADMIN_ROLES|canRead|isController" app/(protected)/activity/page.tsx` returns nothing, and a full read of the file shows the only `useRole()` destructure is `activeOrgId`. The two pages are siblings in `ACTIVITY_VIEWS = [{label:"Activity", href:"/activity"}, {label:"Audit log", href:"/admin/audit"}]`, so /admin/audit itself renders a link to the ungated twin. The sidebar hides the "Activity" entry only for `activeRole === 'Viewer' || activeRole === 'Contractor'` — every other role (Drafter, Requester, Engineer-N, Accounting, Safety, HR, Maintenance, Operations) is shown it — and hiding a nav item is not a gate: a Viewer or Contractor who types the URL gets the same page.

**Failure scenario.** A Maintenance technician clicks Activity in the sidebar and gets a rendered, human-readable, day-grouped feed of the whole workspace: who viewed and downloaded which drawing, every hold opened and the reason recorded in `details`, every rev-up, supersession, revert and archive, every note deletion, plus hydrated document numbers and titles pulled from a follow-up `documents` query (activity/page.tsx:119-128). Nothing in the product tells them this is the audit trail. A regulator or an internal investigator asking "who could see the access log?" gets the wrong answer from the /admin/audit banner.

**Evidence.**

```
app/(protected)/activity/page.tsx:102-105 — `const { data, error: qErr } = await supabase.from("audit_logs")` / `.select("*").eq("org_id", activeOrgId)` / `.order("timestamp", { ascending: false }).limit(limit);`. Its header comment at :11-12 says "Reads the same audit_logs table — the back-end is shared — but renders for humans, not auditors." app/(protected)/admin/audit/page.tsx:203 — `Admin-class roles only. Ask your workspace admin if you need access.` components/navigation/Sidebar.tsx:246-248 — `activeRole === 'Viewer' || activeRole === 'Contractor' ? workAll.filter((item) => ['Home','Documents','Drafting Requests','Projects'].includes(item.label)) : workAll`.
```

**Chain reaction.** This is the in-app half of roles-and-permissions SURF-9 ("/admin/audit … ❌ none — audit_logs_org_access allows every member"), whose Done-when #1 is a RESTRICTIVE SELECT policy matching the roles the page claims. That policy would also blank /activity for most of the org — /activity is a real, shipped, people-facing feature, so the fix must decide deliberately what /activity is allowed to show (e.g. a curated action subset) rather than discovering it as breakage.

> **Verifier correction.** Sharpen the framing: this is not an RLS bypass — the database deliberately grants audit SELECT to every org member, so /activity is consistent with the data layer and /admin/audit's banner is the outlier. The defect is that the app asserts an admin-only boundary it does not have anywhere.

**Done when.**

- [ ] /activity applies an explicit, stated authority rule rather than none, and that rule is enforced somewhere other than the client.
- [ ] The claim on /admin/audit ("Admin-class roles only") is either true or removed.
- [ ] A member outside the audit-reading set cannot retrieve raw audit rows through either page or through PostgREST (SURF-9 #1).

---

<a id="alog-6"></a>

## ALOG-6 · "Export CSV" exports only the rows currently on screen — by default the last 7 days capped at 200 — with no truncation notice, and drops the `metadata` column entirely from the evidence file

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/audit/page.tsx:107-108`, `app/(protected)/admin/audit/page.tsx:127-137`, `app/(protected)/admin/audit/page.tsx:226-234`, `app/(protected)/admin/audit/page.tsx:426-463`, `lib/audit.ts:11, 26`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The scope half is true — the export serialises the in-memory `filtered` array only. But two mitigations the finding omits lower it: the button carries `title="Download the currently-visible audit rows as a CSV"` (:232) and the toolbar shows `Showing {filtered.length} of {rows.length}` beside a `Load 200 more` control (:294-297), so the truncation is disclosed in the UI even if not inside the file. More importantly the `metadata` half is vacuous: no writer in the repo ever populates it — lib/audit.ts:27 `metadata: entry.metadata || null` is the only assignment, zero callers of logAuditAction pass a `metadata` key, and none of the ~30 direct `from("audit_logs").insert(...)` sites set one — so the column is uniformly NULL and dropping it loses nothing. LOW.

**Mechanism.** `exportAuditCsv(filtered, docMeta)` serialises the in-memory `filtered` array. `filtered` derives from `rows`, which is one PostgREST page: `.limit(limit)` with `const [limit, setLimit] = useState(200)`, plus `const [range, setRange] = useState<"24h"|"7d"|"30d"|"all">("7d")` applied as `q.gte("timestamp", …)`. The only way to get more is clicking "Load 200 more" repeatedly. The button's tooltip does say "the currently-visible audit rows", but the button is labelled "Export CSV", the filename is `audit-log-<date>.csv`, and the file itself carries no header row, note or row-count indicating it is a slice. The header array is `["Timestamp","Action","Resource Type","Resource ID","Resource Label","User Email","User Role","Details JSON"]` — `metadata` is selected by the query (`select("*")`), mapped into the row object at line 143, and then never written to the CSV, so any evidence a caller put in `metadata` rather than `details` is absent from the export.

**Failure scenario.** An investigator is asked for the audit trail on a specific drawing across the past two years. They open /admin/audit, type the document into the user filter (which only matches emails, so nothing), give up and click Export CSV. They receive a file containing the last seven days of workspace-wide activity, capped at 200 rows, with a filename that reads like a complete export and no field anywhere in it saying otherwise. The file is filed as the record.

**Evidence.**

```
app/(protected)/admin/audit/page.tsx:107-108 — `const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("7d");` / `const [limit, setLimit] = useState(200);`. :131 — `.limit(limit);`. :229 — `onClick={() => exportAuditCsv(filtered, docMeta)}`. :435 — `const header = ["Timestamp", "Action", "Resource Type", "Resource ID", "Resource Label", "User Email", "User Role", "Details JSON"];`. :443-451 — the row builder, which ends `r.details ? JSON.stringify(r.details) : "",` with no metadata entry, while :143 maps `metadata: r.metadata` into the row. lib/audit.ts:11 declares `metadata?: Record<string, unknown>;` and :26 writes `metadata: entry.metadata || null`.
```

**Chain reaction.** /admin/data-export produces the full-fidelity dump (and audits it as DATA_EXPORT), but roles-and-permissions and intelligence findings note that surface is scoped to whole-org exports with 24h presigned URLs — it is not a substitute for a scoped audit extract. A per-resource or date-bounded server-side export is the missing capability.

**Done when.**

- [ ] The CSV either contains everything the chosen filters select (server-side paging) or states its own bounds inside the file.
- [ ] metadata is exported alongside details, or its omission is deliberate and recorded.
- [ ] The export action itself is auditable, so "who took a copy of the audit log" is answerable.

---

<a id="alog-7"></a>

## ALOG-7 · Audit rows record self-declared identity: `user_email` and `user_role` come from the caller, `timestamp` is client-settable, and the one field `AuditEntry` declares for it is never written

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/audit.ts:5-14`, `lib/audit.ts:17-31`, `supabase/schema.sql:781-793`, `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90`, `app/(protected)/admin/audit/page.tsx:403`, `app/(protected)/admin/holds/page.tsx:94`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every limb. The display side makes the forgery consequential: app/(protected)/admin/audit/page.tsx:403 renders `{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}` — it prefers the self-declared email over the RLS-pinned user_id — and app/(protected)/admin/holds/page.tsx:94-98 shows the pattern of the caller handing its own `userEmail`/`activeRole` in as the recorded identity. Because nothing forces `timestamp`, a hand-rolled insert through the same permissive INSERT policy can backdate or postdate a row.

**Mechanism.** `audit_logs` stores `user_email TEXT`, `user_role TEXT` and `timestamp TIMESTAMPTZ DEFAULT NOW()`. The INSERT policy constrains only `user_id = auth.uid() AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))`. Nothing pins email or role to the actor's actual org_members row, and nothing pins `timestamp` to now() — no CHECK constraint and no trigger on the table (a grep of every migration for TRIGGER lines mentioning audit_logs returns nothing). `logAuditAction` copies `userEmail` and `userRole` straight from its argument, and every call site supplies them from client state — e.g. /admin/holds passes `releasedByRole: activeRole ?? undefined`. The viewer then renders `{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}` as if it were resolved identity. Separately, `AuditEntry` declares `timestamp?: string;` at lib/audit.ts:13 and the insert body at :18-27 never references it — a declared field with no writer, matching the dead-field pattern the earlier audits catalogued.

**Failure scenario.** Two shapes. Benign: an Engineer-2 who is later promoted has rows recorded as "Engineer-2" and rows recorded as "Engineer-3", and neither is verifiable against org_members history because none is kept — which is actually the useful behaviour, but nothing says the value is a snapshot rather than a lookup. Adversarial: an active member with any role issues `POST /rest/v1/audit_logs` with their own `user_id`, `user_role: "Admin"`, a `timestamp` six months in the past and any `action` and `details` they like. The policy accepts it. It appears in /admin/audit and /activity, indistinguishable from a real row, attributed to a role they have never held, dated before the events it purports to explain.

**Evidence.**

```
supabase/schema.sql:781-793 — `user_id UUID,` / `user_email TEXT,` / `user_role TEXT,` / `details JSONB,` / `metadata JSONB,` / `timestamp TIMESTAMPTZ DEFAULT NOW()`. supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:86-90 — `WITH CHECK ( user_id = auth.uid() AND (org_id IS NULL OR org_id IN (SELECT my_org_ids())) )` — the complete set of constraints on an inserted row. lib/audit.ts:24-25 — `user_email: entry.userEmail || null,` / `user_role: entry.userRole || null,`. lib/audit.ts:13 — `timestamp?: string;` with no corresponding line in the insert at :18-27. app/(protected)/admin/audit/page.tsx:403 — `<span>{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}</span>`.
```

**Chain reaction.** Cross-references roles-and-permissions SURF-8, which established that the restore path can inject arbitrary audit_logs rows through the service role with no audit of the import. Together they mean the audit table's integrity rests entirely on the absence of UPDATE/DELETE policies — content authenticity is not enforced at all. A regulator-grade fix (derive email/role server-side, pin timestamp, or hash-chain rows) is a design change, not a patch.

**Done when.**

- [ ] timestamp cannot be set by an authenticated client, or a stored-vs-received discrepancy is detectable.
- [ ] user_email and user_role are either resolved server-side from org_members at write time or explicitly labelled in the UI as caller-asserted at the time of the event.
- [ ] AuditEntry.timestamp is either written or removed.

---

<a id="alog-8"></a>

## ALOG-8 · Every destructive admin operation's audit insert is written so a failure cannot be detected — seven service-role routes plus the two permission-change writers all discard the result

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/purge/route.ts:173-184`, `app/api/admin/restore/apply/route.ts:129-139`, `app/api/admin/shed/commit/route.ts:113-120`, `app/api/admin/ticket-shed/commit/route.ts:197-204`, `app/api/admin/ticket-shed/restore/route.ts:210-217`, `app/api/admin/archive-cancel/route.ts:64-71`, `app/api/admin/orphans/route.ts:48-53`, `lib/capabilityPolicy.ts:237-246`, `components/permissions/PermissionDrawer.tsx:291-302`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Worse than stated: supabase-js resolves rather than rejects on a database error, so the `try/catch` at the seven route sites cannot catch an RLS or constraint rejection either — the error object is simply never destructured. The PermissionDrawer path also supplies its own failure mode: `user_id: auth.user?.id ?? null` (:295) writes NULL when the session lookup returns nothing, which the 20260813 policy's `user_id = auth.uid()` check rejects — silently, after the ACL change has already committed.

**Mechanism.** supabase-js resolves with `{ error }` rather than rejecting (established by drafting-flow PERS-7 / EVID-6, which traced `shouldThrowOnError = false` and confirmed `throwOnError()` appears zero times in lib/, app/, components/ or hooks/). EVID-6 scoped itself to `logAuditAction`. The admin rails do not go through `logAuditAction` at all — they insert into audit_logs directly — and every one of them uses a construct that is dead against a resolved error. Seven service-role routes use `try { await sb.from("audit_logs").insert({…}); } catch { /* best-effort */ }`; two more use `.then(() => undefined, () => undefined)`. The two `.then` cases are the permission writers: `saveCapabilityPolicy`, whose own comment reads "Full before/after audit — a permission change is the one edit an IT department must always be able to reconstruct", and `PermissionDrawer.save`, whose comment reads "Full before/after audit — a permission change must always be reconstructable." Both then discard the outcome. PermissionDrawer additionally writes `user_id: auth.user?.id ?? null` (line 296): a null `user_id` fails the `audit_logs_insert` WITH CHECK (`user_id = auth.uid()`), and that rejection is swallowed by the same `.then`.

**Failure scenario.** A DocCtrl edits the ACL on the P&ID library to grant a contractor `write`, and the audit insert is rejected (session refreshed mid-action so `auth.getUser()` returns no user, or any RLS/constraint fault). The ACL update at PermissionDrawer.tsx:284 already committed and was checked; the audit row at :291 did not and was not. The drawer closes normally. Six months later, reconstructing "who granted this contractor write access to the P&ID library" returns nothing — and there is no error, no console line, and no retry anywhere in the system. The same shape covers DATA_PURGE, DATA_RESTORE, DATA_ARCHIVE_RECLAIM, TICKET_ARCHIVE_RECLAIM, TICKET_ARCHIVE_RESTORE, ARCHIVE_PRODUCE_CANCELED and STORAGE_ORPHANS_PURGED: for those seven, the audit row is the ONLY surviving record of what was destroyed, because the rows themselves are gone.

**Evidence.**

```
app/api/admin/purge/route.ts:173-184 — `// Purging is itself an audited action — chain of custody for what was removed.` / `try {` / `await sb.from("audit_logs").insert({ action: "DATA_PURGE", … });` / `} catch { /* never block the purge result on the audit insert */ }`. lib/capabilityPolicy.ts:237-246 — `// Full before/after audit — a permission change is the one edit an IT` / `// department must always be able to reconstruct.` / `await supabase.from("audit_logs").insert({ action: "CAPABILITY_POLICY_CHANGED", … }).then(() => undefined, () => undefined);`. components/permissions/PermissionDrawer.tsx:296 — `user_id: auth.user?.id ?? null,` and :302 — `}).then(() => undefined, () => undefined);`. app/api/admin/orphans/route.ts:53 — `}).then(() => undefined, () => undefined);`.
```

**Chain reaction.** Shares a root cause with drafting-flow PERS-7 / EVID-6 (whose Done-when is "logAuditAction destructures and inspects `{ error }` … or writes to a durable dead-letter/outbox"). Fixing `logAuditAction` alone leaves all nine of these sites untouched, because none of them call it. If a dead-letter/outbox table is the chosen remedy, note the deployment constraint: no third vercel.json cron entry is permitted (app/api/cron/maintenance/route.ts:286-291), so a drainer must ride the existing maintenance sweep.

> **Verifier correction.** Overstated at HIGH. Six of the seven routes use the SERVICE-ROLE client (`sb`/`actor.admin`), which bypasses RLS entirely, so the realistic failure modes are narrow (network, NOT NULL on action/resource_id/resource_type). And the PermissionDrawer sub-claim is speculative: `user_id: auth.user?.id ?? null` (line 296) only yields null if `supabase.auth.getUser()` returns no user, which cannot happen on the same tick that the user's own authenticated UPDATE at line 284 just succeeded — nobody ran this, and no code path produces the null. The durable defect is the shape (unobservable audit failure on destructive operations), not a demonstrated lost row.

**Done when.**

- [ ] Each of the nine sites destructures `{ error }` and escalates — into the response body, a dead-letter row, or a raised error — rather than discarding it.
- [ ] PermissionDrawer refuses to claim a permission change was audited when it could not resolve an actor id.
- [ ] A test proves that a rejected audit insert on a purge or an ACL change is observable somewhere.

---

<a id="alog-9"></a>

## ALOG-9 · The action-permissions grid can only grant to 12 hardcoded role tokens; five of the system's nineteen real roles — Accounting, Safety, HR, Maintenance, Operations — have no column, so authority already held by those roles is invisible in the console that governs it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/permissions/CapabilityPolicyEditor.tsx:24-25`, `components/permissions/CapabilityPolicyEditor.tsx:145-160`, `types/schema.ts:5-46`, `lib/capabilityPolicy.ts:57`, `app/(protected)/admin/users/page.tsx:56-62`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The arithmetic is exact — 19 roles, 12 tokens (one of which is the `*` wildcard, not a role), Engineer-1..4 collapsed to one `Engineer` token by design (roleTokenMatches, capabilityPolicy.ts:130), leaving the five named roles with no cell. lib/capabilityPolicy.ts:86-88 confirms holds.open/holds.release default to `["*"]`, so an admin who narrows them from Everyone has no way to re-add Operations or Safety through this grid; the only escape hatches are a per-person grant or hand-editing the JSON. MEDIUM is right.

**Mechanism.** `TOKENS` is a literal array of 12 strings. `types/schema.ts` defines 19 roles and `ALL_ROLES` lists all 19; /admin/users offers every one of them as an assignable role, with labels naming them explicitly ("Operations (requests only)", "Safety (requests only)", …). The grid renders one column per TOKENS entry and computes each cell as `(policy[d.id] ?? []).includes(t)`, so a stored token outside TOKENS renders nowhere. Because `toggle()` rebuilds the array as `cur.includes(token) ? cur.filter(…) : [...cur, token]`, an out-of-grid token survives editing — it stays live in `policyAllows` and in the SQL `org_capability_allows` while being invisible to the admin. The grid is also the reason the role vocabulary is duplicated: `const MGMT = ["Admin", "Manager", "Supervisor"]` in lib/capabilityPolicy.ts:57 and `const ADMIN_ROLES = new Set(["Admin", "DocCtrl"])` in the permissions page are two more copies of facility vocabulary in application code.

**Failure scenario.** A plant narrows hold authority — `holds.open` / `holds.release` default to `["*"]`, and a controller decides only certain roles should be able to freeze a drawing. Operations and Safety are exactly the two groups who need to place a do-not-advance hold when something is found in the field, and neither has a column in the grid. The controller cannot grant it to them through the console at all; the only route is a per-person delegation for each individual, or a hand-written SQL edit whose result the grid will then hide.

**Evidence.**

```
components/permissions/CapabilityPolicyEditor.tsx:24 — `const TOKENS = ["*", "Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSupervisor", "Engineer", "Drafter", "Requester", "Viewer", "Contractor", "Auditor"];`. types/schema.ts:26-46 — `export const ALL_ROLES: Role[] = ["Admin","DocCtrl","Manager","Supervisor","DraftingSupervisor","Engineer-1","Engineer-2","Engineer-3","Engineer-4","Requester","Drafter","Accounting","Safety","HR","Maintenance","Operations","Contractor","Viewer","Auditor"];`. app/(protected)/admin/users/page.tsx:56-61 — `{ value: 'Operations', label: 'Operations (requests only)' }, { value: 'Maintenance', … }, { value: 'Safety', … }, { value: 'HR', … }, { value: 'Accounting', … },` under the comment `// Request-only staff roles … previously defined in the role model but unassignable here — the audit's "7 unreachable roles".` components/permissions/CapabilityPolicyEditor.tsx:146 — `const on = (policy[d.id] ?? []).includes(t);`.
```

**Chain reaction.** PermissionsExplorer collapses the same five roles into a single "Staff*" column (PermissionsExplorer.tsx:14-15), so both halves of the console erase the distinction the user-admin page carefully restored. Deriving TOKENS from ALL_ROLES adds five columns to an already wide grid and needs a decision about whether Engineer-N collapses to the "Engineer" alias token, which `roleTokenMatches` (lib/capabilityPolicy.ts:141-145) supports.

> **Verifier correction.** The headline overstates one half. 'Authority already held by those roles is invisible in the console' is not demonstrable: none of the 17 CAPABILITY_DEFS defaults name Accounting/Safety/HR/Maintenance/Operations (they use MGMT, 'Engineer', 'Drafter', 'Requester', 'Admin','DocCtrl' or '*'), and an out-of-grid token can only enter the stored policy by a direct database edit — no code path writes one. The confirmed defect is the forward direction: an admin cannot grant any capability to five of the org's assignable roles except by using '*' (Everyone).

**Done when.**

- [ ] The grid's columns are derived from the role model rather than a literal, or the omission is deliberate and stated in the UI.
- [ ] A capability token stored for a role the grid does not render is surfaced to the admin rather than hidden.
- [ ] The duplicated role literals (MGMT, ADMIN_ROLES, TOKENS) resolve to one declaration.

---

<a id="alog-10"></a>

## ALOG-10 · The audit INSERT policy explicitly admits `org_id IS NULL`, but the SELECT policy and both viewers can never return such a row — a write-only sink for audit evidence, reachable through optional-orgId signatures

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:86-90`, `supabase/schema.sql:1084-1085`, `lib/audit.ts:6, 20`, `lib/documentOrigin.ts:26-43`, `app/(protected)/admin/audit/page.tsx:129`, `app/(protected)/activity/page.tsx:103`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The write-only-sink mechanism is exactly as described. Worth flagging as the finding itself concedes: the one live caller does supply it — components/documents/OriginSection.tsx:48 passes `orgId` — so today this is a latent trap in the signature rather than an active data-loss bug, which is why MEDIUM (not higher) is the right level.

**Mechanism.** The INSERT check is `user_id = auth.uid() AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))` — a NULL org_id is permitted by design. The SELECT policy is `USING (org_id IN (SELECT my_org_ids()))`; `NULL IN (…)` evaluates to NULL, never true, so no authenticated caller can ever read such a row. Both viewers narrow further with `.eq("org_id", activeOrgId)`, which also excludes NULL. `AuditEntry.orgId` is optional (`orgId?: string;`) and `logAuditAction` writes `org_id: entry.orgId || null`, so any caller that omits it — or passes an undefined value — produces a permanently unreadable row. The reachable instance is `setDocumentOrigin`, whose signature is `orgId?: string | null` and whose audit call passes `orgId: input.orgId ?? undefined`. Its single current caller does supply orgId (components/documents/OriginSection.tsx:48), which is why this is SUSPECTED rather than CONFIRMED: the mechanism and the policy asymmetry are certain, the production consequence depends on a caller that does not exist today.

**Failure scenario.** A future helper — or a refactor of setDocumentOrigin's caller — omits orgId. Every DOCUMENT_ORIGIN_SET row it writes is accepted by Postgres, returns no error, appears to succeed, and is then invisible in /admin/audit, in /activity, in the per-document HistoryDrawer and to any authenticated query. Only a service-role console session can see them. The system reports a healthy audit trail while a category of events accumulates where no one will ever look.

**Evidence.**

```
supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:88 — `AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))`. supabase/schema.sql:1084-1085 — `CREATE POLICY "audit_logs_org_access" ON audit_logs FOR SELECT USING (org_id IN (SELECT my_org_ids()));`. lib/audit.ts:6 — `orgId?: string;` and :20 — `org_id: entry.orgId || null,`. lib/documentOrigin.ts:27 — `documentId: string; orgId?: string | null; actorId?: string | null;` and :41 — `orgId: input.orgId ?? undefined, userId: input.actorId ?? "",`. app/(protected)/admin/audit/page.tsx:129 — `.eq("org_id", activeOrgId)`.
```

**Chain reaction.** The same signature at lib/documentOrigin.ts:41 also carries `userId: input.actorId ?? ""`, the empty-string-into-UUID failure drafting-flow EVID-6 confirmed — so the identical call is at risk of both failure modes at once. Any fix that makes orgId required should be paired with making actorId required, since both defaults produce silently-lost evidence.

> **Verifier correction.** The producer side is weaker than the finding suggests, and I would keep this at SUSPECTED-and-latent rather than acting on it. I brace-matched every `logAuditAction({…})` call across app/, lib/, components/ and hooks/: 0 of them omit orgId. The cited 'reachable instance' is not one — lib/documentOrigin.ts:41 passes `orgId: input.orgId ?? undefined`, but its only caller (components/documents/OriginSection.tsx:48) reads orgId from a prop typed `orgId: string` (:17), so undefined never arrives. This is a hardening note about a policy that permits rows nothing writes, not a live evidence gap.

**Done when.**

- [ ] Either org_id is NOT NULL on audit_logs and the INSERT policy stops admitting NULL, or a query exists that can surface NULL-org rows to someone.
- [ ] AuditEntry.orgId is required, or a call with no orgId is rejected rather than written.
- [ ] An inventory query counts existing NULL-org audit rows before the constraint is added (DEC-30).

---

<a id="alog-11"></a>

## ALOG-11 · The audit viewer can filter 36 action types out of the 110 the app writes; every admin-authority action — permission changes, ACL changes, recertifications, purges, restores, e-signatures, folder deletes — is unreachable through any filter, and the compliance KPI miscounts in both directions

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/audit/page.tsx:46-83`, `app/(protected)/admin/audit/page.tsx:271-281`, `app/(protected)/admin/audit/page.tsx:192`, `app/(protected)/admin/audit/page.tsx:172-178`, `lib/capabilityPolicy.ts:239`, `components/permissions/PermissionDrawer.tsx:292`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The counts are exact, not rhetorical: a scan of every action-name literal in the tree (`action:` plus the `type:` unions that lib/audit.ts's helpers forward) yields precisely 110 distinct actions against 36 filterable. The unreachable set includes CAPABILITY_POLICY_CHANGED (capabilityPolicy.ts:239), NODE_ACL_CHANGED (PermissionDrawer.tsx:292), ACCESS_RECERTIFIED, DATA_PURGE, DATA_RESTORE, ESIGNATURE_CAPTURED, FOLDER_DELETED and STORAGE_ORPHANS_PURGED. The KPI regex genuinely errs both ways — it misses DATA_PURGE (a real destruction) while counting TICKET_ARCHIVE_RESTORE and ARCHIVE_PRODUCE_CANCELED (a restore and a cancel) because both contain "ARCHIVE".

**Mechanism.** The action dropdown is built as `...Object.keys(ACTION_STYLE).sort().map(...)`, so it offers exactly the 36 actions that happen to have an icon and colour assigned. Extracting every `action: "UPPER_SNAKE"` literal across app/, lib/, components/ and hooks/ and subtracting the 36 styled keys yields 74 emitted action types with no filter entry — among them CAPABILITY_POLICY_CHANGED, NODE_ACL_CHANGED, ACCESS_RECERTIFIED, DATA_PURGE, DATA_RESTORE, DATA_ARCHIVE_RECLAIM, ESIGNATURE_CAPTURED, FOLDER_DELETED, PROJECT_DELETED, DELETION_REQUESTED, AI_CAP_CHANGED, CHECKOUT_RELEASED and every TRANSMITTAL_* event. The resource dropdown is hardcoded to `document / project / milestone / asset`, but rows are written with `resource_type` of `library` (ACCESS_RECERTIFIED), `org_configuration` (CAPABILITY_POLICY_CHANGED), `collection` (NODE_ACL_CHANGED on a folder), `org` (DATA_PURGE, DATA_RESTORE) and `storage` (STORAGE_ORPHANS_PURGED) — none selectable. The library filter compounds it: `if (r.resourceType !== "document") return false;` silently discards every non-document row the moment a library is chosen. And the "Deletes / undo / force" KPI matches `/DELET|ARCHIVE|REVERS|FORCE/`, which counts DELETION_REQUESTED (a request, not a delete), TICKET_ARCHIVE_RESTORE and ARCHIVE_PRODUCE_CANCELED (both restorative) as deletions, while missing DATA_PURGE, STORAGE_ORPHANS_PURGED, SUPERSEDE_DOC and TRANSMITTAL_VOIDED.

**Failure scenario.** During a PSM records review the auditor is asked to produce every permission change in the last twelve months. On /admin/audit they select "All time", look for a permission-related action in the dropdown, and find none — the list runs from ABANDON to UPLOAD with nothing about permissions. Choosing "Any resource" and paging by hand through hundreds of VIEW and DOWNLOAD rows is the only route, and picking the library filter to narrow it wipes the permission rows out entirely because their resource_type is not `document`.

**Evidence.**

```
app/(protected)/admin/audit/page.tsx:271-274 — `<Select value={actionFilter} onChange={setActionFilter} options={[{ value: "ALL", label: "All actions" }, ...Object.keys(ACTION_STYLE).sort().map((k) => ({ value: k, label: prettyAction(k) }))]} />`. :275-281 — the four hardcoded resource options. :174 — `if (r.resourceType !== "document") return false;`. :192 — `const deletes = [...byAction.entries()].filter(([k]) => /DELET|ARCHIVE|REVERS|FORCE/.test(k)).reduce((s, [, n]) => s + n, 0);`. Producers of unfilterable actions: lib/capabilityPolicy.ts:239 — `action: "CAPABILITY_POLICY_CHANGED", resource_type: "org_configuration",`; components/permissions/PermissionDrawer.tsx:292-293 — `action: "NODE_ACL_CHANGED", resource_type: nodeType,`; lib/accessRecert.ts:112 — `action: "ACCESS_RECERTIFIED", resourceType: "library"`; app/api/admin/purge/route.ts:176-178 — `action: "DATA_PURGE", resource_type: "org"`; app/api/collections/delete/route.ts:116 — `action: "FOLDER_DELETED"`.
```

**Chain reaction.** The action vocabulary has no single declaration — it is spread across string literals, the union types in lib/audit.ts:103-113 and :148-155, and this presentation map. Deriving the filter from a shared registry fixes the dropdown, the icons, the KPI and the /activity feed's ACTION_VERBS map at once; patching only the dropdown leaves three other copies to drift.

**Done when.**

- [ ] The action and resource filters are derived from the same registry the writers use, so a new action type is filterable the day it ships.
- [ ] Selecting a library filter does not silently discard non-document rows without saying so.
- [ ] The deletes KPI counts a stated, reviewable list of destructive actions rather than a substring regex.

---

<a id="alog-12"></a>

## ALOG-12 · The capability-policy save is a whole-grid read-modify-write off a mount-time snapshot behind a 60-second cache — two admins silently clobber each other, and the `before` half of the CAPABILITY_POLICY_CHANGED record can be a state that was never current

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/permissions/CapabilityPolicyEditor.tsx:35-43`, `components/permissions/CapabilityPolicyEditor.tsx:59-91`, `lib/capabilityPolicy.ts:161-196`, `lib/capabilityPolicy.ts:215-246`, `lib/capabilityPolicy.ts:252-283`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every limb verified: last-writer-wins on the full `caps` object in both directions (grid save clobbers grants, grant save clobbers caps), and the audit `before` at :245 is whatever the 60-second cache held, which need never have been the row's actual prior state. Note this is currently masked by ALOG-1 — nothing persists at all — but the concurrency defect is independent of it.

**Mechanism.** `loadCapabilityPolicy` caches per org for `CACHE_TTL_MS = 60_000`. The editor loads once on mount into both `policy` and `baseline`, and `save()` writes `{ caps: policy, grants: stored.grants ?? [] }` — the full grid as it was at mount, plus whatever grants the (possibly cached) read returned. Nothing is compared against current state and nothing is versioned, so a second admin's edit made after this editor mounted is overwritten wholesale. The impact preview computes `was = baseline?.[d.id] ?? d.defaultRoles` against the same mount-time snapshot, so it describes a diff from a state that may no longer exist. Worse, `saveCapabilityPolicy` builds its audit payload as `const before = await loadCapabilityPolicy(input.orgId)` (line 219) — the very same cached read — and writes `details: { before, after: input.policy }`. Within the TTL, `before` is the cached value, not the row being overwritten. The same read-modify-write shape governs delegations: `addUserGrant`/`revokeUserGrant` (lines 252-283) each read `current = await loadCapabilityPolicy(...)`, rebuild the grants array, and hand the whole policy to `saveCapabilityPolicy`.

**Failure scenario.** Two controllers respond to the same incident. Admin A opens /admin/permissions and narrows "Force close" to Admin only. Admin B, whose console has been open since before that change, grants a temporary `ticket.assign` delegation to a supervisor through the View-as panel — `addUserGrant` reads the cached policy, rebuilds grants, and saves the whole object, restoring Manager and Supervisor on "Force close". The audit row for B's action records `before` as the pre-A state, so the trail shows no one ever removed those roles and no one ever put them back. A's change is gone and the log agrees it never happened.

**Evidence.**

```
lib/capabilityPolicy.ts:161-163 — `const CACHE_TTL_MS = 60_000;` / `const cache = new Map<string, { at: number; policy: CapabilityPolicy }>();` and :169 — `if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.policy;`. lib/capabilityPolicy.ts:219 — `const before = await loadCapabilityPolicy(input.orgId);`. components/permissions/CapabilityPolicyEditor.tsx:37-40 — `const stored = await loadCapabilityPolicy(activeOrgId);` / `const merged = { ...defaultCapabilityPolicy(), ...(stored.caps ?? {}) };` / `setPolicy(merged);` / `setBaseline(merged);`. components/permissions/CapabilityPolicyEditor.tsx:66 — `const was = baseline?.[d.id] ?? d.defaultRoles;`. components/permissions/CapabilityPolicyEditor.tsx:84 — `await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps: policy, grants: stored.grants ?? [] }, … })`.
```

**Chain reaction.** The org_configurations column defect above means this save currently throws before it can land, so the lost-update is latent — but it becomes live the instant the column name is fixed, and the two fixes will almost certainly ship together. The row is a single JSONB blob with no updated_at precondition and no optimistic-concurrency token, so the fix is a structural one (conditional update on a version/updated_at, or a server route that merges) rather than a cache-TTL tweak.

> **Verifier correction.** Two overstatements. (1) The stale-`before` window is narrower than implied: loadCapabilityPolicy only returns the cached value if the save happens within 60s of the mount-time load; past that the read is fresh. (2) The lost-update is the durable half and does not depend on the cache at all — `policy` is held in React state from mount, so a concurrent admin's edit is clobbered whenever the second save lands, cache or no cache. HIGH is too strong for a two-simultaneous-admins race on a console with an Admin/DocCtrl-only gate (admin/permissions/page.tsx:34).

**Done when.**

- [ ] A save that would overwrite a policy changed since the editor loaded is refused or merged, not applied blindly.
- [ ] The `before` recorded in CAPABILITY_POLICY_CHANGED is read from the database at write time, bypassing the cache, or is derived from the row the update actually replaced.
- [ ] addUserGrant and revokeUserGrant modify only the grants array without republishing a stale caps grid.

---

<a id="alog-13"></a>

## ALOG-13 · The permissions console asserts the legacy read/write/admin matrix "is GONE" and that nothing depended on it, while /admin/libraries still writes all three columns and the documents home page still filters library cards on two of them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/permissions/page.tsx:13-16`, `app/(protected)/admin/libraries/page.tsx:103-107`, `app/(protected)/admin/libraries/LibraryWizard.tsx:247-271`, `app/(protected)/documents/page.tsx:44-54`, `supabase/schema.sql:75-77`, `lib/libraryCollections.ts:129-131`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The console's absence claim is wrong: `read_access` (with `visible_to`) is read on every load of the documents home page and does gate which library cards a non-controller sees. The finding's 'two of them' is loose — the second column doing the filtering is `visible_to`, which is not one of the three the console names — but that does not weaken it, because the genuinely inert pair is `write_access`/`admin_access`, which /admin/libraries and LibraryWizard still present as upload/admin restrictions and no enforcement path ever consults. Both halves of the trap are therefore live.

**Mechanism.** The permissions page header states: "The old read/write/admin role matrix is GONE: it wrote columns (libraries.read_access/write_access/admin_access) that no policy, trigger, or query ever read — a decorative permission system is worse than none. Confirmed safe to remove: no org data depended on it." Both halves are wrong. It is not gone: `LibraryWizard` still renders the role pickers and returns `readAccess`, `writeAccess`, `adminAccess`, `visibleTo`, and `handleSaveLibrary` writes all four on every library create and edit — `write_access: config.writeAccess ?? [], admin_access: config.adminAccess ?? [], read_access: config.readAccess ?? "ALL", visible_to: config.visibleTo ?? []`. And two of the columns are read: the documents home page computes card visibility from them (`if (readAccess === "ALL") return true;` … `return readList.includes(role) || visibleTo.includes(role);`). `write_access` and `admin_access` genuinely are dead — read into LibraryConfig objects in three files and consulted by no evaluator, policy or trigger — which is the dead-column pattern the earlier audits catalogued. So an admin configuring "who can upload" and "who can administer" in the Library wizard changes nothing anywhere, while "who can view" changes only a client-side card filter.

**Failure scenario.** A controller reads the permissions console, believes the legacy matrix was removed, and does not think about it again. Meanwhile another controller sets up a new restricted library through /admin/libraries, ticks the view/upload/admin role boxes, and believes the library is restricted. Upload and admin authority were never enforced by those settings; view is enforced only by a client-side filter on the library list, which roles-and-permissions DACL-10 already established is bypassed by navigating straight to /documents/<libraryId>. Two controllers, two false beliefs, one of them created by the console's own comment.

**Evidence.**

```
app/(protected)/admin/permissions/page.tsx:13-16 — `// The old read/write/admin role matrix is GONE: it wrote columns` / `// (libraries.read_access/write_access/admin_access) that no policy, trigger,` / `// or query ever read — a decorative permission system is worse than none.` / `// Confirmed safe to remove: no org data depended on it.` app/(protected)/admin/libraries/page.tsx:105-106 — `write_access: config.writeAccess ?? [], admin_access: config.adminAccess ?? [],` / `read_access: config.readAccess ?? "ALL", visible_to: config.visibleTo ?? [],`. app/(protected)/documents/page.tsx:44-50 — `const readAccess = (lib as { readAccess?: Role[] | "ALL" }).readAccess;` / `if (readAccess === "ALL") return true;` / `const visibleTo = toArrayRole((lib as { visibleTo?: unknown }).visibleTo);` / `return readList.includes(role) || visibleTo.includes(role);`. A repo-wide grep for `writeAccess|adminAccess` outside admin/libraries and types/schema returns only the two read-into-config sites at app/(protected)/documents/[libraryId]/page.tsx:1455 and app/(protected)/documents/page.tsx:143-144 — no evaluator, no policy, no trigger.
```

**Chain reaction.** roles-and-permissions DACL-10 owns the read_access/visible_to enforcement gap and its Done-when is "Either read_access/visible_to are retired in favour of libraries.acl (one model), or the detail page enforces the same predicate the home page uses AND a RESTRICTIVE RLS policy enforces it on libraries." This finding is the documentation half: whichever way DACL-10 resolves, the console comment must stop asserting a removal that never happened, and the wizard must stop offering two controls that do nothing.

> **Verifier correction.** The closing sentence is wrong and would mislead anyone acting on this. 'An admin configuring who can upload and who can administer in the Library wizard changes nothing anywhere' is false: the same wizard values ALSO build the library's real, enforced ACL — LibraryWizard.tsx:249 derives writeRoles from the upload-role picker, then :258-259 emit `{effect:"allow", subject:{type:"role"}, actions:["upload","createFolder","editMetadata","write",…]}` and admin/managePermissions rules into `acl`, which page.tsx:107 persists and which the ACL evaluator and the database deny-guards (20260901:126-176) act on. What is dead is the mirrored COLUMN, not the control.

**Done when.**

- [ ] The comment on /admin/permissions matches what the code does, or the legacy columns really are removed everywhere including LibraryWizard and handleSaveLibrary.
- [ ] write_access and admin_access are either enforced or dropped from the wizard UI and the write payload.
- [ ] The decision is recorded so the next agent does not re-derive it from the stale comment.

---

<a id="alog-14"></a>

## ALOG-14 · The permissions console's headline panel is a hand-maintained 52-row string matrix that has drifted from the code — at least five rows assert authority boundaries the app does not have

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/permissions/PermissionsExplorer.tsx:14-80`, `app/(protected)/admin/permissions/page.tsx:148`, `app/(protected)/admin/holds/page.tsx:32`, `app/(protected)/admin/scope/page.tsx:36`, `app/(protected)/admin/assets/page.tsx:56`, `app/api/admin/create-user/route.ts:62`, `app/(protected)/documents/[libraryId]/page.tsx:3372-3379`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right, and the drift runs in both directions — DocCtrl is understated on four rows while Manager is overstated on user management. Only the row count is off: the array holds 51 rows, not 52, which is immaterial to the claim. The one hedge in the file, the `warn` field flagging known gaps, is used on exactly one row ("Create / edit / refresh work packages"), so none of the six drifted rows carries any warning.

**Mechanism.** `PermissionsExplorer` is rendered first on /admin/permissions, above the real editor, described as "the IT-department view of the ENTIRE app" and "Derived from a code audit of every enforcement point". It is a literal array of 52 `Row` objects whose `m` field is a 12-character string, one char per role, hand-written in source. It imports nothing from `lib/capabilityPolicy`, `lib/permissions`, or `lib/acl`; it never reads the org's stored policy, so it cannot reflect any change made in the CapabilityPolicyEditor rendered directly below it, nor any per-person delegation, nor any ACL rule. Being a snapshot, it has drifted. Column order is `[Admin, DocCtrl, Manager, Supervisor, DraftingSup, Engineer 1-4, Drafter, Requester, Staff*, Contractor, Auditor, Viewer]`, so position 1 is DocCtrl. Checkable mismatches: (1) `{ cap: "Audit log", m: "yyyy------y-" }` asserts a boundary that does not exist — `audit_logs_org_access` grants SELECT to every member (schema.sql:1084-1085) and /activity renders the rows to everyone; (2) `{ cap: "Release stale checkouts (/admin/holds)", m: "y-yy--------" }` marks DocCtrl "—", but the page's gate is `new Set(["Admin","Manager","Supervisor","DocCtrl"])`; (3) `{ cap: "Operational scope", m: "y-yy--------" }` marks DocCtrl "—", but /admin/scope's gate is the same four-role set; (4) `{ cap: "Equipment / asset admin pages", m: "y-yy--------" }` marks DocCtrl "—", but /admin/assets uses `["Admin","DocCtrl","Manager","Supervisor"]` and the file's own comment says "DocCtrl belongs here"; (5) `{ cap: "User management (invite, roles)", m: "y-y---------" }` marks DocCtrl "—", but /api/admin/create-user admits `["Admin","DocCtrl"]`; (6) `{ cap: "Access recertification reviews", m: "yycccccccccc", cond: "If library owner" }` promises any-role owners can recertify, but the only entry point is inside `{isController && ( … Access recertification … )}`.

**Failure scenario.** An IT auditor is asked to produce the workspace's access-control matrix. They open /admin/permissions, screenshot the top panel, and hand it over. It says the audit log is restricted to five roles — a Drafter or a Safety staffer can read every row of it — and it says Doc Control cannot manage users, release stale checkouts, edit operational scope or edit the equipment registry, all four of which Doc Control can do. The document is signed as an accurate control description and is wrong in both directions: it under-states an exposure and over-states three restrictions.

**Evidence.**

```
components/permissions/PermissionsExplorer.tsx:14 — `const ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSup", "Engineer 1-4", "Drafter", "Requester", "Staff*", "Contractor", "Auditor", "Viewer"];`. :17 — `// m: 12 chars in ROLES order — y (yes), c (conditional), - (no).` :65 — `{ area: "Metrics", cap: "Audit log", m: "yyyy------y-" },`. :74 — `{ area: "Admin", cap: "Release stale checkouts (/admin/holds)", m: "y-yy--------" },` vs app/(protected)/admin/holds/page.tsx:32 — `const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);`. :68 — `{ area: "Admin", cap: "User management (invite, roles)", m: "y-y---------", cond: "Only an Admin can grant the Admin role" },` vs app/api/admin/create-user/route.ts:62 — `if (!callerMember || !["Admin", "DocCtrl"].includes(callerMember.role as string))`. :45 — `{ area: "Reviews", cap: "Access recertification reviews", m: "yycccccccccc", cond: "If library owner" },` vs app/(protected)/documents/[libraryId]/page.tsx:3372 — `{isController && (` wrapping the "Access recertification" menu item, with `const isController = isControllerRole(activeRole);` at :2861 and lib/permissions.ts:18-20 — `return role === "Admin" || role === "DocCtrl";`.
```

**Chain reaction.** roles-and-permissions SURF-9 already censuses the per-page gates and DEC-17 scopes what may be fixed there; this finding is about the artifact that *reports* those gates, which SURF-9 does not cover. Deriving the matrix from CAPABILITY_DEFS + the stored policy would fix the drift for the Requests/Metrics/Holds rows but not for the Documents/Publishing/Reviews rows, which encode ACL and ownership semantics no single evaluator exposes — so the honest fix may be to derive what can be derived and label the rest as a documented, dated snapshot.

> **Verifier correction.** Two of the six cited mismatches do not hold as stated. (1) 'Audit log' m="yyyy------y-" is an EXACT match for admin/audit/page.tsx:27's `["Admin","Manager","Supervisor","DocCtrl","Auditor"]` — it is not drift against its own subject; it only looks wrong once you accept finding #2 (that /activity leaks the same table), so it is derivative, not independent evidence. (2) 'User management (invite, roles)' m="y-y---------" matches the /admin/users PAGE gate, which is `if (!['Admin','Manager'].includes(activeRole))` at admin/users/page.tsx:231 — DocCtrl genuinely cannot open that page. The real inconsistency is app-internal: the API at create-user/route.ts:62 admits `["Admin","DocCtrl"]`, so Manager can open the page but gets 403 from the route, and DocCtrl is admitted by the route but cannot reach the page. Severity MEDIUM: this is a misleading reference table in an admin console, not an enforcement defect.

**Done when.**

- [ ] Rows that correspond to a registered capability are rendered from CAPABILITY_DEFS and the org's stored policy, not from a literal string.
- [ ] The five mismatches above are each either corrected or shown to be intentional.
- [ ] Any remaining hand-maintained rows are visibly marked as a documentation snapshot rather than presented as derived truth.

---
