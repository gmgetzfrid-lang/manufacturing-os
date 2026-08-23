# 09 · Non-document authority surfaces

Everything outside the document library and the drafting workflow: membership,
admin pages, projects, teams, holds, retention, signatures, restore, cron and
notifications.

**16 findings** — 2 CRITICAL, 6 HIGH, 8 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**

---

## SURF-1 · "Remove from workspace" is a silent no-op — there is no working way to revoke a member

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `supabase/schema.sql:1050` — the original `CREATE POLICY "org_members_write" ON org_members FOR ALL`
  - `supabase/migrations/20260817_org_members_escalation_and_config.sql:44-53` — **drops it and recreates it as `FOR INSERT` only.** No DELETE policy is ever created, here or anywhere else in the migration set.
  - `supabase/REMEDIATION_APPLY_ALL.sql:196-202` — the consolidated file does the same
  - `app/(protected)/admin/users/page.tsx:178` — the UI delete, with optimistic local removal
  - `supabase/schema.sql:1013` — RLS is on
- **Related:** `OWN-12`, `SURF-2`, `SURF-14`
- **Re-verified:** hardening pass — **SURVIVES** — and the mechanism is subtler than the title. `20260817…:44` **DROPs the `FOR ALL` `org_members_write`** and replaces it with `FOR INSERT` only; `:32` adds `FOR UPDATE`. **No `FOR DELETE` policy exists on `org_members` anywhere.** The UI deletes — `admin/users/page.tsx:178`, `.from('org_members').delete().eq('id', member.id)` — and RLS filters rather than errors, so the call affects zero rows and returns no error. Removal silently does nothing.

**Mechanism.** `schema.sql` shipped a permissive `FOR ALL` policy that covered
DELETE. Migration `20260817` drops it and recreates it as `FOR INSERT`, adding a
separate `org_members_update`. **No DELETE policy exists anywhere.** With RLS on
and no permissive DELETE policy, every client delete matches zero rows — and
PostgREST returns `204` with `error: null` for a zero-row delete:

```ts
const { error } = await supabase.from('org_members').delete().eq('id', member.id);
if (error) throw error;
setMembers((prev) => prev.filter((m) => m.id !== member.id));   // optimistic
```

The admin sees the row vanish and a success path. **The member keeps full
access.**

**Failure scenario.** An engineer is fired. The Admin opens Team Management,
clicks the trash icon, the row disappears. The ex-employee's session and JWT keep
working indefinitely — `my_org_ids()` still returns the org.

**Chain reaction.** The only other revocation route is `status <> 'active'`, and
**nothing in the entire codebase ever writes `'suspended'` or `'invited'`** —
those literals appear only in the `RoleContext` type union.  `'inactive'` is
written only by restore. **Both revocation doors are shut.** Also dead as a
consequence: `prevent_last_admin_removal`'s DELETE trigger can never fire from a
client. Downstream, `team_members`, `project_members`, `document_shares` and
`checkout_sessions` rows all survive, and `my_team_ids()` has no status filter at
all.

⚠ Fixing this makes `OWN-12` (no owner succession) bite much harder, because
removal will actually start removing people. Read that finding before shipping
this one. Independently: make the UI verify the affected-row count before
mutating local state — the silent-success shape is the same one described in
`OWN-14`.

**Done when.**
1. An admin can actually revoke a member's access, and the member's session stops
   working.
2. A revocation that the database refuses surfaces as an error, not as a
   disappearing row.
3. There is a non-destructive path (suspend) as well as a destructive one.
4. The last-admin protection still holds against both.

---

## SURF-2 · `/api/storage/delete` — any active member can permanently destroy any file in the org, unaudited

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / safety / compliance
- **Locations:**
  - `app/api/storage/delete/route.ts:6-44` — the whole route; the delete is at `:42`
  - contrast `app/api/storage/download-url/route.ts:29` (`assertSafeStorageKey`) and `:47-70` (the ACL check)
- **Related:** `SURF-3`, `EGRESS-1`
- **Re-verified:** hardening pass — **SURVIVES**, with one clarification: the route **does** close cross-tenant deletion — `:29-40` requires active membership of the org named in the `orgs/<uuid>/` key prefix. What survives is the finding as titled: **within** the org, any active member of any role, including Viewer, may permanently delete any object, and the route writes no audit row.

**Mechanism.** The entire authorization is "is the caller an active member of the
org named in the key prefix":

```ts
if (!member) return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
}
await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));
```

No controller check. No `assertSafeStorageKey` — **which the sibling download
route does call**. No legal-hold check. No `audit_logs` row.

**Failure scenario.** A Viewer enumerates `file_url` values from
`document_versions` (readable to any member) and DELETEs each one. Every
controlled drawing's bytes are gone. The `documents` and `document_versions` rows
remain, pointing at nothing.

**Chain reaction.** This is the clean bypass of **every deletion guard the
database has**: `documents_delete_controllers`,
`enforce_legal_hold_delete_guard` and `enforce_legal_hold_version_delete_guard`
all protect *rows*. **Nothing protects bytes.** Spoliation of a record under
legal hold is one HTTP call. It also silently breaks `/api/share/file`,
transmittal portal downloads, work-package packs, and the backup/restore
round-trip.

**Done when.**
1. Deleting a stored object requires controller-equivalent authority.
2. `assertSafeStorageKey` is applied, as it is on the download route.
3. A key belonging to a document under legal hold or an unreleased hold is
   refused.
4. Every deletion writes an audit row.

---

## SURF-3 · Legal holds and retention have zero server-side enforcement

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / safety
- **Locations:**
  - `lib/retention.ts:120-145` — `placeLegalHold` / `releaseLegalHold`; `:151-159` — `disposeDocument`
  - **`lib/retention.ts` contains no role, controller or capability check of any kind** (verified by search)
  - the gate is client-only: `components/documents/RetentionSection.tsx:29-34,79,86`, fed by `components/documents/InspectorPanel.tsx:283` (`canManage = isController || isOwner`)
  - `supabase/migrations/20260816_documents_access_change_guard.sql:84-86` — the guard covers only `visibility|acl|acl_index`
  - `supabase/schema.sql:1068` — `documents` UPDATE is permitted to every active member
- **Related:** `OWN-2`, `SURF-2`

**Mechanism.** `releaseLegalHold` is a plain browser-client write:

```ts
const patch = { legal_hold: false, legal_hold_matter: null, legal_hold_reason: null,
                legal_hold_by: null, legal_hold_at: null };
await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50));
```

`legal_hold`, `retention_until` and `disposition_state` are guarded by nothing.

**Failure scenario.** The employee under investigation opens devtools and PATCHes
`legal_hold=false` on the held records. The database delete guard now passes.
Nothing in the audit trail says who cleared it, because `logEvent` only runs on
the app path they bypassed.

**Chain reaction.** There are **two hold systems with opposite enforcement**:
`document_holds` was hardened to capability-gated RLS in
`20260901_db_hard_enforcement.sql:93-105`, while the **legal** hold — the one
with spoliation liability — is client-trusted. Once `legal_hold` is clear,
`disposeDocument`, controller delete and the retention scan all unlock. Retention
dates are likewise rewritable, so a record can be aged into
`disposition_state='eligible'` on demand. The `document_holds` capability pattern
is the right template — note it is currently broken by `DB-1`.

**Done when.** A non-controller cannot change `legal_hold`, `legal_hold_*`,
`retention_until` or `disposition_state` on a document, and a test attempts it
and asserts refusal.

---

## SURF-4 · The force-release database guard is defeated by a second, unguarded write

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / availability
- **Locations:**
  - `lib/checkoutEpisodes.ts:616-627` — the `checkout_sessions` update, **error discarded**
  - `lib/checkoutEpisodes.ts:630-640` — the `documents` update that actually clears the lock
  - the guard: `supabase/migrations/20260901_db_hard_enforcement.sql:109-121`
  - the UI gate: `components/documents/CheckoutStatusCell.tsx:238`
- **Related:** `OWN-14`, `DB-1`

**Mechanism.** `enforce_checkout_release_guard` raises when a non-authorized user
closes someone else's session — but the caller never inspects the result, and
then performs a **second** write to `documents`, whose UPDATE policy is plain org
membership:

```ts
await supabase.from("checkout_sessions").update({ status: "checked_in", ... })
  .eq("document_id", input.documentId).eq("status", "active");
// ↑ no `const { error } =`, no throw
const episode = await getActiveEpisode(input.documentId);
await supabase.from("documents").update({
  checked_out_by: null, checked_out_by_name: null, checked_out_at: null,
  checkout_note: null, current_lock_id: null, active_collaborators: [],
}).eq("id", input.documentId);
```

The lock clears regardless. A member does not even need the UI — one PostgREST
PATCH on `documents.checked_out_by` does it.

**Failure scenario.** A Drafter clears another engineer's lock on a P&ID
mid-edit, then publishes over it. `publish_revision`'s lock check reads
`v_doc.checked_out_by` — which is now NULL — so it publishes cleanly. Meanwhile
the `checkout_sessions` row is still `active`, so the episode state is
split-brained.

**Chain reaction.** This makes the `checkout.force_release` capability —
documented in `lib/capabilityPolicy.ts:89-91` as *"Enforced at the database"* —
false. It corrupts `reconcileDocumentCheckoutState`, and the force-release victim
notification never fires, so the holder learns at publish time. Note the guard
itself is currently non-functional for a different reason (`DB-1`).

**Done when.**
1. A non-authorized user cannot clear another person's checkout, through the UI
   or through a direct PATCH.
2. The two writes cannot diverge — a refused session close does not leave the
   document unlocked.

---

## SURF-5 · `/api/notifications/send-queued` — any authenticated user drains every tenant's mail queue; any member can queue arbitrary mail

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / cross-tenant
- **Locations:**
  - `app/api/notifications/send-queued/route.ts:50-59` — the authorization
  - `app/api/notifications/send-queued/route.ts:105-114` — the candidate select, **with no `org_id` filter**
  - `supabase/migrations/20260605_rls_policies_new_tables.sql:121-124` — the queue INSERT policy
- **Related:** `WF-19`

**Mechanism.**

```ts
let authorized = cronSecret !== "" && token === cronSecret;
if (!authorized && token) {
  const { data: { user } } = await supabase.auth.getUser(token);
  authorized = !!user;             // ← any Supabase user, ANY org, no membership check
}
```

Everything after runs on the service key with **no `org_id` filter**: it
un-suppresses seven days of rows, re-queues stranded `sending` rows, and sends up
to `MAX_BATCH` across all tenants. Separately, the queue's INSERT policy lets any
active member write arbitrary `to_email` / `subject` / `body_html`.

**Failure scenario.** Someone signs up for a free trial (creating their own org),
takes their JWT, and repeatedly calls the endpoint — controlling *other
companies'* outbound mail timing and re-sending suppressed backlogs. Separately,
a Viewer inserts `email_notifications` rows addressed to customers, with HTML
bodies of their choosing, from the product's verified sender, then triggers the
drain: **a functioning phishing relay with the org's branding.**

**Chain reaction.** `/api/cron/maintenance` also queues mail and calls this
drain, so a poisoned queue rides the trusted path. `email_notifications` is in
the export contract, so forged rows land in every backup. Note `WF-19` needs this
endpoint to work for a *legitimate* session-authenticated caller — coordinate the
two fixes so the post-action drain does not break.

**Done when.**
1. The drain requires the cron secret, or a session **plus** org membership.
2. A session-authorized drain is scoped to that caller's own orgs.
3. A member cannot queue mail to an arbitrary address with arbitrary HTML.

---

## SURF-6 · Migration `20260901_db_hard_enforcement.sql` references two columns that do not exist

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (in code) / SUSPECTED (the live database may carry ad-hoc drift)
- **Blast radius:** availability / access-control

> **This is the same defect as [`DB-1`](./11-database-authority.md) and
> [`DB-2`](./11-database-authority.md), recorded there in full.** It appears here
> because its blast radius lands on this report's surfaces: holds, checkout
> force-release, and every non-controller document update.

See `DB-1` (`org_configurations.value`) and `DB-2` (`team_members.user_id`).
**Resolve them there; do not fix twice.**

---

## SURF-7 · The AI orchestrator acts with service-role authority the caller does not have

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / confidentiality

> **Recorded in full as [`EGRESS-4`](./10-content-egress.md).** Cross-referenced
> here because `log_audit_completion` writes to `drawing_audit_logs` with no role
> check at all, on a table whose RLS grants only SELECT to members — making the
> AI the sole writer of a record it accepts from a Viewer.

---

## SURF-8 · Restore is an unaudited service-role write path into tables the database makes immutable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / data-integrity
- **Locations:**
  - `app/api/admin/restore/apply-table/route.ts:24`, `:74-87` — no audit insert
  - `lib/exportTables.ts:53` (`e_signatures`), `:130` (`audit_logs`), `:67-68` (acks and signoffs), `:154` (`org_configurations`)
  - `lib/dataRestore.ts:86-93` — `SKIP_TABLES`; **none of the above appear in it**
  - `app/api/admin/restore/begin/route.ts:63-70` — a service-role `org_members` insert, unaudited
  - the invariants it ignores: `supabase/migrations/20260720_e_signatures.sql:47-61` (no UPDATE, no DELETE, self-insert only) and `supabase/migrations/20260813:84-90` (`audit_logs` append-only)
- **Related:** `SURF-13`, `WF-11`

**Mechanism.** `IMPORTABLE` is the union of the org-scoped and user-scoped table
sets, and rows are written with the **service-role client, which bypasses RLS**.
Tables that were deliberately made immutable are imported like any other.

**Failure scenario.** An Admin fabricates a backup JSON containing an
`e_signatures` row — "Approved for Construction", signer set to a different
engineer, backdated `signed_at` — and posts it to
`/api/admin/restore/apply-table`. **It lands.** No `audit_logs` row records the
import (only the single-shot `/apply` path writes one). The forged approval is
indistinguishable from a real ceremony.

**Chain reaction.** Restore is also the only path that can insert
`org_configurations` rows for a key that does not yet exist — including
`capability_policy`, whose direct write is controller-gated (`WF-11`). And
`restore/begin` mints `org_members` rows carrying whatever `role` the backup
names.

**Done when.**
1. Append-only and self-insert-only tables cannot be blind-imported, or are
   imported into a quarantined shadow for review.
2. Every restore chunk writes an audit row naming the table, row count and
   backup manifest.
3. A restored backup cannot mint an `org_members` row with a role the operator
   did not choose.

---

## SURF-9 · Every `/admin/*` surface is gated differently, and most are UI-only

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:** the table below; the census itself is the finding
- **Related:** `WF-20`, `ADD-*`

| Surface | Client gate | Enforced at the DB / API? |
|---|---|---|
| `/admin/branding` | `activeRole === "Admin"` | ✅ DB |
| `/admin/users` | `['Admin','Manager']` | ✅ DB |
| `/admin/teams` | `Admin \|\| Manager` | ✅ DB (singular `role`) |
| `/admin/permissions` | `{Admin, DocCtrl}` | ✅ DB (key only — see `WF-11`) |
| `/admin/settings` | `{Admin, DocCtrl}` | API is **Admin-only** — mismatch |
| `/admin/codebook` | `{Admin, DocCtrl}` | ✅ DB (singular `role`) |
| **`/admin/audit`** | `{Admin,Manager,Supervisor,DocCtrl,Auditor}` | ❌ **none** — `audit_logs_org_access` allows every member |
| `/admin/scope` | `{Admin,Manager,Supervisor,DocCtrl}` | ❌ none |
| `/admin/holds` | `{Admin,Manager,Supervisor,DocCtrl}` | DB capability (broken — `DB-1`) |
| **`/admin/assets`** | `[Admin,DocCtrl,Manager,Supervisor]` | ❌ **none** — `assets_member_all` |
| `/admin/libraries` | `Admin \|\| DocCtrl` | permissive only (`OWN-1`) |
| `/admin/billing` | `['Admin','Manager']` | ✅ API matches |
| `/admin/data-export` | `['Admin','Manager','DocCtrl']` | ✅ API matches |
| `/admin/restore` | `Admin` | ✅ API matches |
| `/admin/storage` | `Admin \|\| DocCtrl` for purge | ✅ API matches |
| `/admin/proposed-links` | 4 roles decide / 2 run | API is Admin/DocCtrl only |
| `/admin/analytics` | capability `admin.analytics_view` | ❌ none (`WF-20`) |
| `/admin/archive-view` | capability `admin.archive_view` | ❌ none |
| `/admin/requests` | `['Admin','DocCtrl']` | ❌ none |
| `/admin/ai-instructions` | `Admin \|\| DocCtrl` | ✅ DB (singular `role`) |

**Ten distinct role sets, two capability checks, one Admin-only.**

**Failure scenario.** Two of these are load-bearing:

- **`/admin/audit`'s "Admin-class roles only" banner is false.** A Viewer can
  `GET /rest/v1/audit_logs?org_id=eq.…` and read the entire org trail, including
  `CAPABILITY_POLICY_CHANGED` before/after payloads.
- **`assets` / `asset_types` / `asset_photos` / `plot_plans` are `FOR ALL` to
  every member.** The notice reading *"Only Admin / Doc Control / Manager /
  Supervisor roles can create or edit assets"* is a curtain — a Viewer can delete
  the equipment registry.

**Chain reaction.** ⚠ **This finding is a census, not an authorization to
refactor twenty surfaces.** The narrow, resolvable defects are the two named
above, plus the `/admin/settings` client/API mismatch.

**`DEC-17` settles the scope: fix those three now, defer the consolidation.**
Most of the census is inconsistency rather than exposure — a client gate stricter
than its API is untidy, not a hole. Consolidating twenty pages onto one authority
hook means twenty surfaces changing behaviour at once with no reviewer, which
`DEC-31` puts out of scope for a single finding.

**Done when.**
1. A Viewer cannot read `audit_logs` via PostgREST — a RESTRICTIVE SELECT policy
   matches the roles the page itself claims.
2. A Viewer cannot write `assets`, `asset_types`, `asset_photos` or `plot_plans`.
3. The `/admin/settings` client gate matches its Admin-only API.
4. The remaining seventeen rows stay documented in the table above, unchanged.

---

## SURF-10 · `authorizeOrgRole` reads `role`; the database reads `role OR roles[]`

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / availability
- **Locations:**
  - `lib/serverAuth.ts:49-58` — `.select("role, status")`, then `allowedRoles.includes(role || "")`
  - contrast the additive-aware: `supabase/migrations/20260814_documents_delete_controllers.sql:31-40`, `20260817:21-28`, `20260818_followups_rls.sql:10-31`
  - and the four API routes that get it right: `app/api/ai/usage/route.ts:29-35`, `app/api/admin/schema-health/route.ts:35-40`, `app/api/collections/delete/route.ts:44-48`, `app/api/ai/connection/route.ts`
- **Related:** `ADD-1`, `OWN-3`, `CHAIN-*`

**Mechanism.** Because `primaryRole` ranks Manager (90) and Supervisor (80) above
DocCtrl (70), a member with `roles = ['Manager','DocCtrl']` has `role='Manager'`.
The database grants them full controller powers via `is_org_controller`; **every
`authorizeOrgRole` route rejects them** — purge, shed, archives, restore, orphans,
storage-stats, ticket-shed. Same identity, opposite answers.

**Failure scenario.** A doc-control manager who also holds Manager cannot run any
maintenance route, with a "Insufficient role" error that names a role they hold.

**Chain reaction.** Separately, `lib/roleCapabilities.ts` defines a whole
`Capability` vocabulary (`manage_users`, `audit`, `doc_control`…) used **only by
the role picker** — no gate anywhere reads `capabilitiesFor()`. `DEC-11` keeps
it: it is the picker's descriptive layer, not an authority layer. Add a header
comment saying so — the confusion is the naming, not the code.

**Done when.** `authorizeOrgRole` computes the union of `role` and `roles`,
matching `is_org_controller`, and a test pins the `['Manager','DocCtrl']` case.

---

## SURF-11 · `project_members.role` is dead — an "Observer" has manager authority

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `supabase/migrations/20260527_projects_and_collaboration.sql:61-62` — `CHECK (role IN ('owner','collaborator','observer'))`
  - `supabase/migrations/20260818_followups_rls.sql:10-21` — membership is tested with **no role predicate**
  - `supabase/migrations/20260913:21-25` (`is_project_member`), `:40-54` (`project_visible_to_me`) — likewise
  - `app/(protected)/projects/[id]/page.tsx:952` — the only TypeScript read of `m.role`, for rendering a chip
  - contrast `supabase/migrations/20261013:57-66` — `user_owns_project` **does** join `org_members.status='active'`, and documents why
- **Related:** `OWN-4`

**Mechanism.** Every policy treats any roster row identically. Adding a
contractor as **Observer** grants them private-project visibility, `milestones`
delete, `transmittals` delete, and every `can_manage_project` follow-up policy.

**Failure scenario.** A contractor is added as an Observer "so they can see
progress" and can delete the project's milestones and transmittals.

**Chain reaction.** `is_project_member` / `is_project_owner` also omit the
`org_members.status='active'` join that `user_owns_project` deliberately includes
and documents (*"offboarding someone revokes their write access immediately"*).
An `inactive` project owner still satisfies `project_members_write`. Note the
cross-axis leak in `OWN-4`: project ownership already confers publish authority
into a document library.

**Done when.** `observer` grants strictly less than `collaborator`, and an
inactive member's project rows stop authorizing writes.

---

## SURF-12 · Distribution acknowledgments are forgeable by any member

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `supabase/migrations/20260825_work_packages_acks.sql:135-139` — `distribution_acks_org_update FOR UPDATE USING (active org member)`
  - `lib/distributionAcks.ts:186-194` — the client helper never scopes to the recipient
  - **the same hole, already closed for the sibling system:** `supabase/migrations/20260828_integrity_hardening.sql:264-273` hardened `document_acknowledgments` to `assignee_user_id = auth.uid()`, with the changelog calling it *"same hole, same fix"*
- **Related:** `SURF-13`

**Mechanism.** One person can mark "I have this revision" for all twelve
recipients. Two acknowledgment systems, opposite enforcement, both feeding
controlled-copy compliance reporting. `distribution_acks` was simply missed four
days later.

**Failure scenario.** A distribution list shows 12/12 acknowledged for a revised
P&ID. One person clicked twelve times. Eleven people have never seen it.

**Done when.** A member can acknowledge only their own `distribution_acks` row,
matching the `document_acknowledgments` rule.

---

## SURF-13 · `document_review_signoffs` UPDATE does not pin reviewer identity

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / safety
- **Locations:**
  - `supabase/migrations/20260828_integrity_hardening.sql:229-242` — `USING` correctly limits which rows you may touch; **`WITH CHECK` only re-verifies membership**
  - `supabase/migrations/20260828_integrity_hardening.sql:274-277` — the same gap in `doc_ack_update`
  - `supabase/migrations/20260822_review_completion_guard.sql:48-53` — the publish-completion guard counts `status='signed'` rows **without checking who signed**
- **Related:** `DEL-5`, `SURF-14`

**Mechanism.** A reviewer can flip their own row to `status='signed'` while
rewriting `reviewer_user_id`, `reviewer_name` and `signature_id` — attributing
the sign-off to a colleague.

**Failure scenario.** A revision is published with a review roster showing two
signatures. One of them names an engineer who never signed.

**Done when.** An UPDATE to a sign-off row cannot change the reviewer's identity,
and the completion guard is satisfied only by rows whose signer is who the row
says.

---

## SURF-14 · Signature re-authentication is client-side only

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `components/signatures/SignatureCeremony.tsx:75-86` — the ceremony's own stated purpose: *"signing must prove it's YOU at the keyboard, not just someone at your unlocked workstation"*
  - `lib/eSignatures.ts:73-77`, `:118-137` — `recordSignature` inserts straight into `e_signatures`
  - `supabase/migrations/20260720_e_signatures.sql:55-61` — the only DB condition is `signer_user_id = auth.uid()` plus active membership
- **Related:** `SURF-8`, `SURF-13`

**Mechanism.** The re-authentication is enforced entirely in React. Anyone
holding a live session — an unattended workstation, an XSS payload, a script —
can mint signatures with no password. The SSO path is weaker still: readiness is
satisfied by `last_sign_in_at` within 15 minutes, a claim the client evaluates
itself. Separately, `verifySigningCredential` calls `signInWithPassword`,
rotating the session token mid-ceremony.

**Failure scenario.** An engineer steps away from an unlocked workstation. A
colleague signs three pending reviews in their name. The `e_signatures` rows are
indistinguishable from genuine ones, and `e_signatures` is deliberately immutable
so they cannot be corrected — only annotated.

**Done when.** Signature creation verifies a fresh re-authentication assertion
server-side before inserting, and the direct client INSERT path is closed.

---

## SURF-15 · `assertOrgHasAccess` has zero callers — subscription enforcement is client-only

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** business-logic
- **Locations:**
  - `lib/serverAuth.ts:78-98` — exported and **never imported anywhere** (a repo search returns one hit: the definition)
  - `components/subscription/SubscriptionGate.tsx:48-57` — a React component with an `ENFORCE` flag and a controller escape hatch
- **Related:** `SURF-9`

**Mechanism.** The only subscription gate is client-side. A lapsed workspace
continues to write freely through PostgREST and every API route. The file's own
comment carefully explains which routes *should not* call the helper — for a
helper nothing calls.

**`DEC-18` settles it: wire the helper into the routes its own comment names,
with the refusal behind an env-gated flag defaulting to OFF.** A helper with zero
callers drifts; but switching on server-side subscription enforcement during an
audit remediation could lock a paying customer out of their own document-control
system over a billing webhook. Wiring it inert gets the path exercised without
that risk, and logging what it *would* have refused shows the blast radius before
anyone enables it.

**Done when.**
1. `assertOrgHasAccess` is called from the routes its comment names.
2. With the flag off, behaviour is byte-identical to today.
3. The log records what enforcement would have blocked.

---

## SURF-16 · Teams are ACL subjects with no audit trail, and `/api/admin/create-user` disagrees with its own page

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / ux
- **Locations:**
  - `lib/teams.ts:66-118` — `createTeam` / `addTeamMember` / `removeTeamMember` / `deleteTeam`: **zero `logAuditAction` calls**
  - `supabase/migrations/20260707_teams.sql:37-49` — `role IN ('Admin','Manager')`, **singular**, while `is_org_admin_or_manager` is additive
  - `supabase/migrations/20260707_teams.sql:52-55` — `my_team_ids()` has **no `status='active'` filter**, so a deactivated member's team grants persist in every ACL evaluation
  - `app/api/admin/create-user/route.ts:62` — requires `['Admin','DocCtrl']`
  - `app/(protected)/admin/users/page.tsx:231` — the page that calls it requires `['Admin','Manager']`
- **Related:** `DEL-3`, `DEL-4`, `SURF-1`

**Mechanism.** Two separate problems on the same surface.

**Teams:** adding yourself to a team is a permission grant — `team` is a
first-class ACL subject and team ownership makes a supervisor the effective owner
of a library. **It leaves no record.** Role changes are audited; team-membership
changes are not.

**Create-user:** a Manager sees the "Add Team Member" button and gets a 403; a
DocCtrl can call the route but cannot reach the page. The route creates an auth
account with an operator-chosen password, links a membership, and writes **no
audit row** — minting an identity is the single highest-value action in the
product and the one that is not recorded.

**Failure scenario.** An investigation asks who granted a contractor access to
the restricted library. The answer is "they added themselves to a team six weeks
ago," and there is no record of it.

**Chain reaction.** `my_team_ids()`'s missing status filter interacts with
`SURF-1`: with removal broken, deactivation is the only revocation route, and it
does not revoke team-derived access. The route's own internal guards
(`app/api/admin/create-user/route.ts:70-72`, `:123-125`) are good — **keep
them.**

**Done when.**
1. Team creation, deletion and membership changes write audit rows.
2. `my_team_ids()` excludes non-active members.
3. `/api/admin/create-user` and the page that calls it agree on who may use it,
   and the route writes an audit row.

---

## Verified sound — do not break

1. **`prevent_last_admin_removal`** (`20260831:43-76`) — correct trigger
   placement, service-role exempt, covers demote/suspend/delete, checks
   `uid <> OLD.uid`. **The recoverability rail.**
2. **`e_signatures` RLS** (`20260720:45-61`) — self-insert only, no UPDATE, no
   DELETE. Exactly right; the only ways around it are `SURF-8` and `SURF-14`.
3. **Legal-hold delete triggers** (`20260826`) — BEFORE DELETE on both
   `documents` and `document_versions`, applying to service-role too, explicitly
   blocking cascades. Correct; only `SURF-3` (unguarded flag) and `SURF-2`
   (bytes) get around them.
4. **`/api/admin/purge`** — a narrow allowlist of disposable byproducts,
   per-target safety floors, a `MIN_DAYS` clamp, explicit `confirm:true`,
   org-scoped, and audited. **The model for how a destructive route should
   look** — hold `SURF-2` to this standard.
5. **Data export** — `ai_connections` explicitly excluded, every run writes a
   `DATA_EXPORT` audit row, and the coverage contract is build-enforced by
   `exportCoverage.test.ts`. The restore role (`Admin`) is correctly *narrower*
   than export.
6. **`/api/cron/maintenance`** and **`/api/data-export/run-scheduled`** — fail
   closed: `if (!cronSecret || auth !== 'Bearer ' + cronSecret) return 401`. No
   user-session fallback. (`/api/cron/embed-drain` correctly scopes its user
   fallback to the caller's own orgs.) **This is the pattern `SURF-5` lacks.**
7. **Public token portals** — `/api/share/*`, `/api/intake/*`,
   `/api/transmittal`: token format validated before any DB touch, revoked and
   expired states handled distinctly, scoped to exactly one artifact, downloads
   audited, and the transmittal serves the *as-sent* revision rather than the
   newest. Good design. (`EGRESS-1` and `OWN-4` concern what is reachable
   *through* them, not the token handling.)
8. **`/api/storage/download-url`** — `assertSafeStorageKey` before the prefix
   gate, with the traversal reasoning written down; org-prefix membership check;
   plus an ACL `canDiscover` check for private and hidden documents. **This is
   the standard `/api/storage/delete` should be held to.**
9. **`RoleContext`** — resolves to `Viewer` + `membershipState: "none"` for any
   non-active membership, and `app/(protected)/layout.tsx:51` hard-stops rather
   than rendering an empty app. Retry-on-error instead of silent downgrade.
10. **`documents_guard_access_change`** (`20260816`) — a faithful SQL replication
    of the ACL-manage evaluation, service-role exempt, with the default-open case
    handled correctly.
11. **`signup_attempts`** (`20261010`) — RLS on with zero policies (service-role
    only), a durable per-IP window, and it records probes rather than only
    successes.
