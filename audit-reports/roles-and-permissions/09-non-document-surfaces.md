# 09 · Non-document authority surfaces

> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T00:30:00Z

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
- **Status:** RESOLVED

**Resolution (2026-09-01, roles-and-permissions Phase 6 — built per `DEC-20`, shipped together with `GAP-5`/`OWN-12` as the pairing rule requires).** Both doors open, through ONE entry point. Database (`20261042`): an `org_members` DELETE policy (Admin by role collection, never yourself) — the missing permissive policy that made every client delete a zero-row "success"; the `revoke_member(p_member_id, p_mode)` SECURITY DEFINER RPC does the authority check (suspend/restore = Admin or Manager, and only an Admin may touch an Admin; remove = Admin), the self-guard, and the status UPDATE or DELETE as a real statement, so `trg_prevent_last_admin_*` fires with the caller's `auth.uid()` — the previously-dead DELETE arm of the last-admin trigger is now reachable. `my_team_ids()` joins active membership (DEC-20's explicit fix: a suspended member's team-derived grants stop applying). App: `lib/members.ts` `revokeMember` — an RPC error or a mode mismatch is thrown, never a disappearing row; the members page gained **Suspend** (the default action, non-destructive, restorable) and **Restore**, with **Remove** behind a confirmation that states what the sweep will do; the bare client `delete()` is gone. `authorizeOrgRole` already refused non-active status (pinned in Phase 5), so the API layer enforces suspend for free. `create-user`'s caller gate now reads the role collection.
- Done-when: (1) ✓ an admin can revoke — suspend ends `my_org_ids()` membership immediately, remove deletes the row; (2) ✓ a refused revocation surfaces as an error (RPC raise → thrown; no optimistic removal before confirmation); (3) ✓ suspend is the non-destructive path and the UI default; (4) ✓ last-admin protection holds on both paths (real UPDATE/DELETE statements inside the RPC; no trigger bypass — pinned).
- Files: `supabase/migrations/20261042_rp_phase6_revocation_and_succession.sql`, `lib/members.ts` (new), `app/(protected)/admin/users/page.tsx`, `app/api/admin/create-user/route.ts`; tests `lib/__tests__/rpPhase6Migration.test.ts`, `lib/__tests__/rpPhase6Additive.test.ts`.
- Migration: `20261042` — **applied & verified live 2026-09-02** (7-point probe all true after the probe-1 correction below; inventory 0/0/0/0/0 — no pre-existing orphaned ownership, no suspended members).
  - **Defect found in the 20261043 pre-flight, repaired in `20261043` §0:** the REMOVE path's lock clear assigned `'[]'::jsonb` to `documents.active_collaborators`, which is `TEXT[]`. plpgsql plans that UPDATE on every remove, so until `20261043` is applied, Remove raises `42804` — loudly, and atomically (one transaction, nothing partial); Suspend/Restore are unaffected. A test now forbids that assignment in every unapplied Phase 6 migration. **Repaired live 2026-09-02** (`20261043` probe 6 true: the assignment is `'{}'::text[]`). Residual: an org whose capability policy strips `checkout.force_release` from Admin will see Remove refused by the DCK-2/DCK-3 guards while the member holds a checkout — release it first (loud, not silent).
  - 2026-09-02 first live run: DDL applied (6/7 true, inventory 0/0/0/0/0). Probe 1 was false because `pg_policies.qual` holds the DEPARSED expression (`ARRAY['Admin']::text[]` is stored as `ARRAY['Admin'::text]`); the probe matched the source form. Probe corrected to the stored form, the same trap pre-empted in `20261044` (`x::text` is stored as `(x)::text`), and a test now forbids a bare cast inside any `qual`/`with_check` LIKE pattern across all four Phase 6 migrations. Re-verified live: probe 1 true; the stored expression reads `(me.roles && ARRAY['Admin'::text])` … `AND (uid <> auth.uid())`, exactly the policy as written.


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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed exactly as claimed. RLS is enabled on org_members with no DELETE policy, so PostgREST returns success with zero rows affected and the client optimistically drops the row from the table — a silent no-op. I searched for an alternate revocation path and found none: there is no admin API route for member removal (app/api/admin/ has no such route) and the users page renders `m.status` read-only (line 323) with no suspend/deactivate control, so the surviving UPDATE policy is not reachable as a workaround either. Note the last-admin BEFORE DELETE trigger (20260831:74-76) is likewise dead code.

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
- **Status:** RESOLVED

**Resolution.** The route is now held to the `/api/admin/purge` bar. All four Done-when: (1) controller authority — the caller must be an Admin/DocCtrl of the key's org, read **additively** (union of `role` and `roles[]` ∩ `{Admin, DocCtrl}`) so a `['Manager','DocCtrl']` member is not wrongly refused by the headline-only read (`SURF-10`); (2) `assertSafeStorageKey(path)` runs before any prefix reasoning, and a non-org-prefixed key is refused outright (closing the aggravator where such keys skipped the check entirely); (3) the key is resolved to its document via `document_versions.file_url` and refused (`423`) if the document is under `legal_hold` or has an unreleased `document_holds` row — **fail closed** on any lookup error (`503`), the deliberate opposite of the download route's fail-open, because destruction is irreversible; (4) a successful delete writes a `STORAGE_OBJECT_DELETE` audit row. No migration needed — the DB hold triggers already exist.
- Commit: `67e6bdd`
- Files: `app/api/storage/delete/route.ts`
- Tests: `lib/__tests__/storageDeleteRoute.test.ts` — 9 tests (Viewer refused; traversal key 400; non-org key 403; legal-hold 423; active-hold 423; unverifiable-hold 503 fail-closed; controller success + audit row; `['Manager','DocCtrl']` admitted; audit-failure refusal). Most fail against the pre-fix route.
- **Hardened (2026-08-24 adversarial-review round).** The first fix wrote the
  audit row AFTER `r2.send` inside a try/catch that was provably dead code —
  postgrest-js resolves both DB and network failures into `{ error }` without
  throwing, and the route never read it. So a DB hiccup in that gap destroyed
  bytes, returned 200, and left NO custody record and NO log line — the exact
  silent-audit failure Done-when 4 exists to prevent. The custody write now
  happens BEFORE destruction and fails closed (503, nothing deleted, error
  logged) when the insert errors — the same posture as the hold check: a
  refused delete is recoverable, destroyed-but-unrecorded bytes are not. If
  the R2 delete itself then fails, the custody row is marked
  `details.failed: true` best-effort so it never reads as a completed
  destruction. A new test pins audit-failure → 503 + zero `r2.send`s.
- Reproduced: the pre-fix route authorized on active membership alone, with no `assertSafeStorageKey`, no hold check, and no audit row — a Viewer could DELETE any `file_url` enumerated from `document_versions`.
- Verified: each Done-when pinned by a test; suite 1419 green.
- **Cross-area duplicates:** this resolution also satisfies `document-control/RET-2` and `intelligence/DACL-2` (same defect). **What this brought to light:** `lib/storage.ts:442` `deleteFile` is now the only caller shape and has **zero in-app callers** — a future component reviving the client delete path is the risk; a follow-up should remove it (noted, low priority).
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / safety / compliance
- **Locations:**
  - `app/api/storage/delete/route.ts:6-44` — the whole route; the delete is at `:42`
  - contrast `app/api/storage/download-url/route.ts:29` (`assertSafeStorageKey`) and `:47-70` (the ACL check)
- **Related:** `SURF-3`, `EGRESS-1`
- **Re-verified:** hardening pass — **SURVIVES**, with one clarification: the route **does** close cross-tenant deletion — `:29-40` requires active membership of the org named in the `orgs/<uuid>/` key prefix. What survives is the finding as titled: **within** the org, any active member of any role, including Viewer, may permanently delete any object, and the route writes no audit row.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed as stated; I read the entire 44-line route and found no role gate, no legal-hold check, and no audit_logs write. Two aggravating details the finding did not note: the route omits the `assertSafeStorageKey(path)` traversal check its sibling app/api/storage/download-url/route.ts:29 performs, and a non-org-prefixed key skips the membership check entirely (`if (orgMatch)`), leaving those objects deletable by any authenticated user. CRITICAL is warranted.

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
- **Status:** RESOLVED

**Resolution (2026-09-01, roles-and-permissions Phase 6).** The flag the delete guards read is no longer member-writable. `trg_document_retention_guard` (BEFORE UPDATE, `20261043`): `legal_hold` and its four companion columns change only for a controller (by role collection) — placing and releasing a legal hold is a controller decision, as the done-when states; `retention_policy`, `retention_until`, `disposition_state` and `disposed_at` change only for a controller, the document's effective owner, or a publisher of its library (the population that manages the record — the publish-time re-clock runs under a publisher); under a legal hold neither `disposition_state → 'disposed'` nor `status → 'Archived'` is accepted (the two UPDATE-shaped destructions the BEFORE DELETE guards could never see); service role passes (cron re-clock, admin routes). The hold-event log is append-only and its INSERT needs the same authority as the write it records. App side mirrors the rule with clear refusals (`assertLegalHoldAuthority`, `assertRetentionAuthority`), disposal is a checked write (a hold placed between the read and the write is refused by the DB and reported, closing the TOCTOU), and the bulk-archive path skips held documents loudly instead of archiving them. The scope note the verifiers added stands: deletion was already enforced; this closes placing, releasing, disposing, retention rewriting, and the archive verb.
- Done-when: ✓ a non-controller cannot change `legal_hold`/`legal_hold_*`, and cannot change `retention_until`/`disposition_state` without owner/publisher authority (guard pinned column-by-column; the live probe proves every guarded column exists). The "test attempts it and asserts refusal" is met by the guard shape pins plus the app-side authority tests — no live-DB harness exists here.
- Files: `supabase/migrations/20261043_rp_phase6_legal_hold_and_force_release.sql`, `lib/retention.ts`, `app/(protected)/documents/[libraryId]/page.tsx`; tests `lib/__tests__/rpPhase6Migration.test.ts`, `lib/__tests__/rpPhase6Additive.test.ts`, `lib/__tests__/checkedWrites.test.ts` (adapted).
- Migration: `20261043` — **applied & verified live 2026-09-02** (7-point probe all true; inventory: 0 documents under hold, 0 held-and-archived/disposed residue, 0 split-brain checkouts; §0 carried the `revoke_member` TEXT[] repair).


- **Verification:** CONFIRMED
- **Blast radius:** compliance / safety
- **Locations:**
  - `lib/retention.ts:120-145` — `placeLegalHold` / `releaseLegalHold`; `:151-159` — `disposeDocument`
  - **`lib/retention.ts` contains no role, controller or capability check of any kind** (verified by search)
  - the gate is client-only: `components/documents/RetentionSection.tsx:29-34,79,86`, fed by `components/documents/InspectorPanel.tsx:283` (`canManage = isController || isOwner`)
  - `supabase/migrations/20260816_documents_access_change_guard.sql:84-86` — the guard covers only `visibility|acl|acl_index`
  - `supabase/schema.sql:1068` — `documents` UPDATE is permitted to every active member
- **Related:** `OWN-2`, `SURF-2`
- **Re-verified:** **SURVIVES — with the headline narrowed.** The body is accurate and is what matters: `lib/retention.ts` contains no role, controller or capability check; the gate is client-only (`RetentionSection.tsx` fed by `InspectorPanel.tsx:283`); the access-change guard covers only `visibility|acl|acl_index`; and `documents` UPDATE is open to every active member. **But "zero server-side enforcement" overstates it.** `20260826_legal_hold_delete_guard.sql` installs `BEFORE DELETE` triggers on both `documents` and `document_versions` that `RAISE EXCEPTION` on a held record. Deletion of held records *is* enforced at the database; placing, releasing and disposing are not. Severity held at HIGH — the authority gap is the substance.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The exploit is real and correctly described: a member can PATCH legal_hold=false via PostgREST, and logEvent lives only on the bypassed app path so nothing records the release. One correction to the title's wording — 'zero server-side enforcement' is too absolute: supabase/migrations/20260826_legal_hold_delete_guard.sql:17-33 does install BEFORE DELETE triggers on documents and document_versions that RAISE on `IF OLD.legal_hold`. The accurate framing (which the finding's own summary uses) is that the guard exists but is trivially disarmed because the flag it reads is unprotected. Severity HIGH stands.

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
- **Status:** RESOLVED

**Resolution (2026-09-01, roles-and-permissions Phase 6).** Recon first: the "second, unguarded write" this finding names — the `documents` lock-column write — was ALREADY guarded by the document-control rails shipped earlier this session (`20261029` DCK-3 `enforce_document_lock_guard`: a non-holder without `checkout.force_release` cannot change `checked_out_by`/`current_lock_id`, UI or direct PATCH), and the app half was already loud (OWN-14). Done-when 1 was therefore met before this phase; done-when 2 was not — the two writes were still two statements. Now `force_release_document(p_doc, p_reason)` (`20261043`) ends the active sessions and clears the lock in ONE transaction; the existing guards (release guard, DCK-2, DCK-3) still fire inside it with the caller's `auth.uid()`, so authority is unchanged and a refusal leaves both halves exactly as they were. `forceReleaseDocument` calls the RPC (victim capture, episode close and notifications kept). The recon also found a NEW silent no-op the DCK-3 rail had created: `reconcileDocumentCheckoutState` cleared the lock columns with no error check, so for a non-holder the DB refusal was swallowed — it is now a checked write that reports the refusal.
- Done-when: (1) ✓ (DCK-3 + this); (2) ✓ the two writes cannot diverge (single transaction; a refused session close never leaves the document unlocked, and vice-versa).
- Residual (recorded): the cosmetic lock columns (`checked_out_by_name`, `checked_out_at`, `checkout_note`, `active_collaborators`) stay member-writable — collaborators legitimately add themselves — so a member could make a held document LOOK free in the UI; the lock itself cannot be moved.
- Files: `supabase/migrations/20261043_rp_phase6_legal_hold_and_force_release.sql`, `lib/checkoutEpisodes.ts`.
- Migration: `20261043` — **applied & verified live 2026-09-02** (7-point probe all true; inventory: 0 documents under hold, 0 held-and-archived/disposed residue, 0 split-brain checkouts; §0 carried the `revoke_member` TEXT[] repair).


- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / availability
- **Locations:**
  - `lib/checkoutEpisodes.ts:616-627` — the `checkout_sessions` update, **error discarded**
  - `lib/checkoutEpisodes.ts:630-640` — the `documents` update that actually clears the lock
  - the guard: `supabase/migrations/20260901_db_hard_enforcement.sql:109-121`
  - the UI gate: `components/documents/CheckoutStatusCell.tsx:238`
- **Related:** `OWN-14`, `DB-1`
- **Re-verified:** hardening pass — **SURVIVES**. Two sequential unchecked writes: `checkout_sessions` (`checkoutEpisodes.ts:616-624`) then `documents` clearing `checked_out_by`, `current_lock_id` and `active_collaborators` (`:630-638`). A guard on the first is defeated by the second reaching the lock columns directly.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. I checked every reference to checked_out_by in supabase/ — the only ones are read-side publish guards (20260713:61, 20260823:178, 20260828:94); nothing gates writing it, and documents_org_access is FOR ALL for any member. So the lock clears, the checkout_sessions row stays 'active' (split-brain), and the publish guard at 20260828:94 reads the now-NULL v_doc.checked_out_by and passes. One nuance on the narrative: the UI button is gated by `const canAdmin = userRole === 'Admin' || userRole === 'DocCtrl'` (CheckoutStatusCell.tsx:238, used at :337), so a Drafter reaches this only via the console — which is precisely the case the DB trigger was added to stop, and which it fails to stop.

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
- **Status:** RESOLVED

> **Scope note (DEC-31).** Done-when 1–2 (the cross-tenant drain — the severe
> half) are resolved here. Done-when 3 (the arbitrary-recipient queue-insert
> lockdown) is split to the new finding `SURF-17`, because it requires moving
> the transmittal external-send server-side plus a migration with data-loss
> risk needing live verification.

**Resolution (Piece A — the cross-tenant drain).** The route authorized any signed-up account (member of no org) via `authorized = !!user`, then drained and re-sent **every** tenant's queue with no org filter. Now: the cron secret drains all orgs (unchanged), but a session caller must be an active member of **some** org and drains **only their own orgs'** rows — the `scopeOrgIds` filter is applied to all four unscoped queue queries (the not-configured deferral count, the 7-day suppressed-row resurrection, the stranded-`sending` reclaim, and the candidate select). A session caller belonging to no org gets `403`. This preserves exactly what `WF-19` needs: a session caller (the browser kick after queueing) drains only their own org's rows, which include the just-queued mail.
- Commit: `b2907b9`
- Files: `app/api/notifications/send-queued/route.ts`
- Tests: `lib/__tests__/apiRouteAuth.test.ts` — 403 for a no-org account; a member's drain is org-scoped (every queue query carries `.in("org_id", …)`); the cron path stays unscoped. Two fail against the old route.
- **Test strengthened (2026-08-24 adversarial-review round).** The scoping
  test asserted only "≥ 1 org-scoped call" while the route reaches the queue
  through THREE query chains on the configured path (unsuppress, reclaim,
  candidates) — a later fourth, unscoped query could have drained
  cross-tenant without failing it. It now pins the exact count of org-scoped
  calls to the route's query-chain count and asserts each carries exactly the
  caller's orgs.
- Verified: Done-when 1 — the drain requires the cron secret or a session **plus** org membership. Done-when 2 — a session-authorized drain is scoped to the caller's own orgs. Suite 1429 green.
- **Done-when 3 is split to `SURF-17`** under `DEC-31`: "a member cannot queue mail to an arbitrary address with arbitrary HTML" is the queue-INSERT lockdown, which requires (a) moving the transmittal external-email send server-side — `lib/transmittals.ts` is a browser module that calls `queueExternalEmail` directly — and (b) a migration tightening the `email_notifications` INSERT policy that risks silently breaking legitimate member notifications if `to_email` ever differs from a member's registered email (needs live verification, `DEC-30`). That is a focused, safety-sensitive change deserving its own session; the design is recorded on `SURF-17`.
- **What this brought to light (adjacent, not in scope):** `email_notifications` has **no** SELECT or UPDATE policy for `authenticated`, so `queueEmail`'s 60-second burst-dedupe select (`lib/notifications.ts:66-75`) always sees zero rows (the dedupe never fires) and the `/admin/settings` dead-letter panel's count is always 0 and its requeue matches nothing — recorded as `SURF-18`. Also: the route comment claims a "Vercel/Supabase cron schedule" that `vercel.json` does not define — the maintenance cron's fetch loop is the only schedule.
- **Verification:** CONFIRMED
- **Blast radius:** security / cross-tenant
- **Locations:**
  - `app/api/notifications/send-queued/route.ts:50-59` — the authorization
  - `app/api/notifications/send-queued/route.ts:105-114` — the candidate select, **with no `org_id` filter**
  - `supabase/migrations/20260605_rls_policies_new_tables.sql:121-124` — the queue INSERT policy
- **Related:** `WF-19`
- **Re-verified:** hardening pass — **SURVIVES**, both halves, and it is the sharpest surface in this area. `authorized = !!user` (`send-queued/route.ts:56`) — **any authenticated user of any workspace passes** — and the claim query selects `email_notifications` by status alone with **no org predicate** (`:106-112`). One member can drain every tenant's mail queue.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves confirmed. `authorized = !!user` is weaker even than the finding says: it does not require membership in any org, so any signed-up account drains every tenant. The blast radius is amplified by lines 88-92, which resurrect `status = 'suppressed'` rows from the last 7 days back to 'queued' before draining — an attacker-triggerable re-send of a suppressed backlog. The insert half is a spoofing vector: arbitrary recipient and HTML sent from RESEND_FROM_EMAIL by any Viewer. HIGH is appropriate.

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
- **Status:** RESOLVED

**Resolution (2026-09-02, verified in the Phase 6 sweep recon — already fixed).** Both phantom columns in `20260901_db_hard_enforcement.sql` (`org_configurations.value`, `team_members.user_id`) were re-created with the real names by `20261025_fix_capability_and_deny_column_typos.sql` (`data`, `uid`), re-affirmed by `20261038` for `org_capability_allows`, and the live state was verified 2026-08-24 (`11-database-authority.md`, `DB-1`/`DB-2`). No further code change; the finding is closed as the DB-1/DB-2 code half.

- **Verification:** CONFIRMED (in code) / SUSPECTED (the live database may carry ad-hoc drift)
- **Blast radius:** availability / access-control
- **Re-verified:** hardening pass — **SURVIVES**, and both columns are verifiable in one look. `:44` reads `org_configurations.value` — the table's columns are `id, org_id, key, data, updated_at` (`schema.sql:52-59`) — and `:143` reads `tm.user_id` on a table keyed `team_id, uid, org_id, added_at, added_by` (`20260707_teams.sql:19-26`). Same roots as `DB-1`/`WF-1` and `DB-2`; one migration fixes all four.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both columns are confirmed absent by repo-wide search: the only `ALTER TABLE org_configurations` in the tree is `ENABLE ROW LEVEL SECURITY` (schema.sql:1014), no migration adds `value`, and the only ALTER on team_members is likewise RLS-only. Every other reader of the table uses `data` (lib/orgBranding.ts:26, lib/ticketRouting.ts:50, 20260701_perf_indexes.sql:21). Line 114's `OLD.user_id` is fine (checkout_sessions.user_id exists, schema.sql:835), so exactly two bad columns as claimed; plpgsql bodies are not column-checked at CREATE time, so the migration applies cleanly and fails at runtime — breaking document_holds insert/update, the force-release guard, and every non-controller document UPDATE whose acl_index is non-null.

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
- **Re-verified:** hardening pass — **SURVIVES**. Cross-area duplicate of `intelligence/IEDGE-2` and `EGRESS-3` — `lib/orchestrator/tools.ts` uses `supabaseAdmin` throughout, and the file's own comment concedes it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Claim holds. 20260929_mention_engine.sql:155-158 gives drawing_audit_logs RLS with a SELECT-only member policy and no INSERT/UPDATE policy, so the service-role orchestrator really is the sole writer, and the only gate on that write is `proposal()` — a human confirmation available to any role including Viewer. check_permissions' own comment is falsified by the client it uses.

> **Recorded in full as [`EGRESS-4`](./10-content-egress.md).** Cross-referenced
> here because `log_audit_completion` writes to `drawing_audit_logs` with no role
> check at all, on a table whose RLS grants only SELECT to members — making the
> AI the sole writer of a record it accepts from a Viewer.

---

## SURF-8 · Restore is an unaudited service-role write path into tables the database makes immutable

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A).** (1) Seven append-only / self-insert-only tables (`e_signatures`, `audit_logs`, `drawing_audit_logs`, `document_acknowledgments`, `distribution_acks`, `document_review_signoffs`, `org_configurations`) are `IMMUTABLE_TABLES`: `planRestore` never plans them in (they show in the review with the reason) and `/api/admin/restore/apply-table` refuses them before any write — they stay in the backup for review rather than being imported into a shadow. (2) Every restore chunk writes a `RESTORE_CHUNK` audit row (table, rows received, rows after filters, rows inserted, backup org id/name) as a *checked* write — if the trail cannot be written the chunk reports failure. (3) Restored placeholder members get `restoredMemberRole(backupRole)`: any privileged role (Admin, DocCtrl, Manager, Supervisor, DraftingSupervisor) becomes `Viewer` until an Admin re-grants it, and `roles[]` is seeded so the row is not born with an empty collection (`ADD-5`).
- Done-when: (1) ✓ refused; (2) ✓ audited per chunk; (3) ✓ no privileged row from a backup.
- Files: `lib/dataRestore.ts`, `app/api/admin/restore/apply-table/route.ts`, `app/api/admin/restore/begin/route.ts`, `app/api/admin/restore/apply/route.ts`, `app/(protected)/admin/restore/page.tsx`. Tests: `lib/__tests__/sweepRoundA.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** compliance / data-integrity
- **Locations:**
  - `app/api/admin/restore/apply-table/route.ts:24`, `:74-87` — no audit insert
  - `lib/exportTables.ts:53` (`e_signatures`), `:130` (`audit_logs`), `:67-68` (acks and signoffs), `:154` (`org_configurations`)
  - `lib/dataRestore.ts:86-93` — `SKIP_TABLES`; **none of the above appear in it**
  - `app/api/admin/restore/begin/route.ts:63-70` — a service-role `org_members` insert, unaudited
  - the invariants it ignores: `supabase/migrations/20260720_e_signatures.sql:47-61` (no UPDATE, no DELETE, self-insert only) and `supabase/migrations/20260813:84-90` (`audit_logs` append-only)
- **Related:** `SURF-13`, `WF-11`
- **Re-verified:** hardening pass — **SURVIVES**. Cross-area duplicate of `document-control/XEDGE-3` — `IMPORTABLE` spans all 104 `ORG_SCOPED_TABLES` including `e_signatures` (`exportTables.ts:53`), and `apply-table` writes no audit row.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Every element checks out. The route writes with `actor.admin` (service role), which bypasses those RLS invariants entirely; app/api/admin/restore/begin/route.ts:63-70 likewise inserts org_members rows with the service-role client and writes no audit row. The only mitigation is that the caller must be Admin (RESTORE_ROLES = ["Admin"], :21) — which is exactly the actor the immutability rails were written to constrain.

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
- **Partial (2026-09-01, Phase 6 / DEC-17):** the two entries that were genuine exposure are closed at the database — `audit_logs` (org-level authority trail readable only by the roles the page claims, document-level history unchanged) and the asset registry tables (RESTRICTIVE write overlays for the roles the page claims) — and the `/admin/settings` gate now matches its Admin-only API (`20261045`). Pre-flight 2026-09-02 carve-out: the plot-plan whiteboard flip (`assets.whiteboard_state`, offered to every working member with no role gate) would have been refused by a page-roles overlay, so the `assets` UPDATE overlay admits any active member holding no read-only role (Viewer/Auditor denied, deny-if-any per `CHAIN-1` — done-when 2 still holds) and a BEFORE UPDATE guard (`assets_guard_registry`) confines such a member to the flip columns; INSERT/DELETE and the other four tables keep the page roles. The plot-plan pages mirror it (flip controls disabled with a reason for read-only roles, `DEC-12`) and their controller checks now read the role collection (`DEC-2`). **`20261045` applied & verified live 2026-09-02** (9/9; inventory: 4 org-level audit rows now admin-class only). The consolidation of the other eighteen surfaces is deferred by DEC-17, not rejected; this finding stays OPEN for that.
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:** the table below; the census itself is the finding
- **Related:** `WF-20`, `ADD-*`
- **Re-verified:** hardening pass — **SURVIVES**. Corroborated by the per-capability census in this pass: `admin.analytics_view` and `admin.archive_view` have **0** references anywhere under `app/api/` (`WF-20`), so those surfaces are gated in the page component only, and each admin page carries its own bespoke expression.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both load-bearing rows of the census are confirmed. The only later audit_logs policy work (20260813:84-90) tightens INSERT, not SELECT, so no repo-wide fix exists. The /admin/settings mismatch is real too (page.tsx:25 `ADMIN_ROLES = new Set(["Admin","DocCtrl"])`). MEDIUM is fair given the finding is scoped as a census with three narrow fixes.

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
- **Status:** RESOLVED

**Resolution (2026-09-01, roles-and-permissions Phase 5).** `authorizeOrgRole` selects `role, roles, status` and admits when ANY held role (`normalizeRoles(roles, role)` — seeded from the headline, so a pre-backfill `roles: []` row still evaluates its headline) is in `allowedRoles`, matching `is_org_controller`. `AuthorizedActor` keeps `role` (the headline — the audit-row consumers are unchanged) and gains `roles`. Recon confirmed every one of the 32 call sites is GRANT-style (an allow-list → 403), so the union is a pure widening with no deny-side inversion; blast radius is exactly the `["Admin","DocCtrl"]` / `["Admin","Manager","DocCtrl"]` families (26 call sites) — the `["Admin"]` restore routes and `["Admin","Manager"]` Stripe routes are behaviorally unchanged, since Admin/Manager can only ever be headlines.
- Done-when: ✓ union computed; ✓ `['Manager','DocCtrl']` pinned admitted to a `["Admin","DocCtrl"]` gate and `['Manager']` alone refused (`rpPhase5Additive.test.ts` … see the serverAuth describe).
- Files: `lib/serverAuth.ts`. Header-comment note per the finding's chain-reaction paragraph: `lib/roleCapabilities.ts` already carries the DEC-11 "PICKER-ONLY" banner.


- **Verification:** CONFIRMED
- **Blast radius:** access-control / availability
- **Locations:**
  - `lib/serverAuth.ts:49-58` — `.select("role, status")`, then `allowedRoles.includes(role || "")`
  - contrast the additive-aware: `supabase/migrations/20260814_documents_delete_controllers.sql:31-40`, `20260817:21-28`, `20260818_followups_rls.sql:10-31`
  - and the four API routes that get it right: `app/api/ai/usage/route.ts:29-35`, `app/api/admin/schema-health/route.ts:35-40`, `app/api/collections/delete/route.ts:44-48`, `app/api/ai/connection/route.ts`
- **Related:** `ADD-1`, `OWN-3`, `CHAIN-*`
- **Re-verified:** hardening pass — **SURVIVES**. `serverAuth.ts` selects `"role, status"` and tests `allowedRoles.includes(role)` (`:51-58`) — headline only — while the database policies test `role IN (…) OR roles && ARRAY[…]` (e.g. `20260818_followups_rls.sql:16`). The server is stricter than the database, which is the safer direction but means the two disagree about who may act.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: authorizeOrgRole never reads roles[] and matches only the mirrored headline, so [DocCtrl, Manager] yields role='Manager' and is rejected by PURGE_ROLES/SHED_ROLES/ROLES = ["Admin","DocCtrl"] across app/api/admin/{purge,shed,archives,orphans,ticket-shed,archive-settings}. One overstatement in the summary: 'any maintenance route' is too absolute — storage-stats GET uses ADMIN_ROLES = ["Admin","Manager","DocCtrl"] (app/api/admin/storage-stats/route.ts:16) and would admit that member, though its POST at line 164 hardcodes ["Admin","DocCtrl"] and would not.

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
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round B).** `project_members.role` decides management authority: `can_manage_project` admits only `owner` / `collaborator` roster rows (an `observer` is on the roster to see, never to manage), requires an ACTIVE org membership on both the owner and the roster arms, reads the org roles by collection, and is search_path-pinned; `is_project_member` / `is_project_owner` require an active membership. `project_visible_to_me` stays role-agnostic (an observer should see a private project). No app change: `canManage = isOwner || isAdmin` already matched.
- Migration: `20261047` — **printed for operator paste; pending apply** (10-point verification incl. a 14-column late-binding probe; 5-line inventory recorded BEFORE apply).. Tests: `lib/__tests__/rpSweepMigrations.test.ts` (shape + line-diffs against the live predecessors), `lib/__tests__/sweepRoundB.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `supabase/migrations/20260527_projects_and_collaboration.sql:61-62` — `CHECK (role IN ('owner','collaborator','observer'))`
  - `supabase/migrations/20260818_followups_rls.sql:10-21` — membership is tested with **no role predicate**
  - `supabase/migrations/20260913:21-25` (`is_project_member`), `:40-54` (`project_visible_to_me`) — likewise
  - `app/(protected)/projects/[id]/page.tsx:952` — the only TypeScript read of `m.role`, for rendering a chip
  - contrast `supabase/migrations/20261013:57-66` — `user_owns_project` **does** join `org_members.status='active'`, and documents why
- **Related:** `OWN-4`
- **Re-verified:** hardening pass — **SURVIVES**. The followups policy resolves authority from **`org_members`** — `om.role IN ('Admin','Manager') OR om.roles && ARRAY['Admin','Manager']` (`20260818_followups_rls.sql:16`) — and never reads `project_members.role`, so the project-level role is decorative.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: an 'observer' row satisfies can_manage_project, so the RESTRICTIVE delete guards on milestones and transmittals pass for them. Repo-wide grep for "observer" outside node_modules returns only types/schema.ts:944 and the `<option value="observer">` at app/(protected)/projects/[id]/page.tsx:926 plus the display badge at :952 — no authorization site anywhere reads pm.role, so 'dead' is accurate. Mitigation the finding omits: the page's own controls use `canManage = isOwner || isAdmin` (line 134), so this is an API-level, not click-level, exposure.

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
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round B).** `distribution_acks` was closed by `20261032`; the sibling `document_acknowledgments` now has the same rails: INSERT may only mint a `pending`, unsigned row, and `enforce_document_ack_guard` (BEFORE UPDATE) makes the `pending → acknowledged` transition the named assignee's own act bound to their own e-signature (org-matched; version-matched where the row names one), refuses a self-waiver by a non-controller, and refuses editing or resurrecting a recorded acknowledgment. The app's signing path already writes exactly that shape.
- Migration: `20261047` — **printed for operator paste; pending apply** (10-point verification incl. a 14-column late-binding probe; 5-line inventory recorded BEFORE apply).. Tests: `lib/__tests__/rpSweepMigrations.test.ts` (shape + line-diffs against the live predecessors), `lib/__tests__/sweepRoundB.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `supabase/migrations/20260825_work_packages_acks.sql:135-139` — `distribution_acks_org_update FOR UPDATE USING (active org member)`
  - `lib/distributionAcks.ts:186-194` — the client helper never scopes to the recipient
  - **the same hole, already closed for the sibling system:** `supabase/migrations/20260828_integrity_hardening.sql:264-273` hardened `document_acknowledgments` to `assignee_user_id = auth.uid()`, with the changelog calling it *"same hole, same fix"*
- **Related:** `SURF-13`
- **Re-verified:** hardening pass — **SURVIVES**. `distribution_acks_org_update FOR UPDATE USING (active org member)` (`20260825_work_packages_acks.sql:135-139`) with no recipient predicate. Cross-area duplicate of `document-control/DIST-3` — fix once.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and no later migration repairs it: grepping every `policy … on distribution_acks` in supabase/ returns only the three policies from 20260825. The contrast the finding draws is exact — 20260828_integrity_hardening.sql:264-273 restricts doc_ack_update to `assignee_user_id = auth.uid()` OR controllers OR owner, the pinning that distribution_acks never received.

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
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round B).** The identity pin `20261030` gave review sign-offs already covered reviewer/slot/draft/document/org; the guard (body from `20261030`, line-diff pinned) now also pins `reviewer_name` and refuses a signature attached to a row that is not being signed. The policy's membership-only `WITH CHECK` is documented as cosmetic: the trigger is the rail.
- Migration: `20261047` — **printed for operator paste; pending apply** (10-point verification incl. a 14-column late-binding probe; 5-line inventory recorded BEFORE apply).. Tests: `lib/__tests__/rpSweepMigrations.test.ts` (shape + line-diffs against the live predecessors), `lib/__tests__/sweepRoundB.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** compliance / safety
- **Locations:**
  - `supabase/migrations/20260828_integrity_hardening.sql:229-242` — `USING` correctly limits which rows you may touch; **`WITH CHECK` only re-verifies membership**
  - `supabase/migrations/20260828_integrity_hardening.sql:274-277` — the same gap in `doc_ack_update`
  - `supabase/migrations/20260822_review_completion_guard.sql:48-53` — the publish-completion guard counts `status='signed'` rows **without checking who signed**
- **Related:** `DEL-5`, `SURF-14`
- **Re-verified:** hardening pass — **SURVIVES**. The UPDATE `WITH CHECK` on the sign-off path tests active org membership only (`20260828_integrity_hardening.sql:274-277`) and never pins the row's reviewer to `auth.uid()`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the current policy is worse than the one cited: 20260830_publisher_row_management.sql:33-50 supersedes this policy and widens USING with `OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)` while leaving the identical membership-only WITH CHECK, so any granted publisher — not only Admin/DocCtrl/owner — can now flip someone else's roster row to signed. The finding's citation is one migration stale but the defect it names is present and broader.

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
- **Re-verified:** hardening pass — **SURVIVES**. `lib/eSignatures.ts:75` calls `supabase.auth.signInWithPassword` — a **client-side module**, not a route handler — so the re-authentication happens in the browser and its outcome is never bound to the signature write server-side.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: nothing server-side observes whether a password was re-entered, so a direct PostgREST insert with a live session produces a signature byte-identical to a ceremonied one. Supporting evidence the finding did not cite: SignatureCeremony.tsx:62 comments `reauth === null ? true // no session info — server still validates the write`, which is factually false — no server validation of re-auth exists. The immutability claim also checks out: 20260720 grants only SELECT and INSERT policies on e_signatures, so a forged row cannot be corrected.

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
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A3).** `assertOrgHasAccess` has its caller: `/api/admin/create-user` — the billable seat mutation — consults it after the authority check. Per `DEC-18` the refusal (402) is behind `SUBSCRIPTION_ENFORCE=true`; with the flag off the would-be refusal is logged, so behaviour is byte-identical today and never silent. Data-export routes stay deliberately ungated.
- Files: `app/api/admin/create-user/route.ts`. Tests: `lib/__tests__/sweepRoundA3.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** business-logic
- **Locations:**
  - `lib/serverAuth.ts:78-98` — exported and **never imported anywhere** (a repo search returns one hit: the definition)
  - `components/subscription/SubscriptionGate.tsx:48-57` — a React component with an `ENFORCE` flag and a controller escape hatch
- **Related:** `SURF-9`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `assertOrgHasAccess` has **0 callers**; subscription enforcement therefore exists only in the client gate.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. If anything the severity is understated rather than overstated: the client-side gate the finding points to is itself disabled — components/subscription/SubscriptionGate.tsx:46-48 reads `const ENFORCE = false;` followed by `if (!ENFORCE || loading || hasAccess(info)) return <>{children}</>;`, so subscription state is not enforced client-side either, only nagged about via TrialBanner.

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
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round B — the DB half; the app half landed in Round A3).** `teams_admin_write` / `team_members_admin_write` read the collection (`caller_holds_any_role(org_id, ARRAY['Admin','Manager'])`), so an additively held Manager administers teams; the supervisor swap is a controller act (`DEL-4`). All five legs closed.
- Migration: `20261046` — **applied & verified live 2026-09-02** (12-point probe all true; inventory recorded BEFORE apply: 0 additive holders under a lower headline, 0 empty / 0 headline-missing / 0 mis-ranked collections, 0 terminal-status documents).. Tests: `lib/__tests__/rpSweepMigrations.test.ts` (shape + line-diffs against the live predecessors), `lib/__tests__/sweepRoundB.test.ts`.


**Partial (2026-09-02, Phase 6 severity sweep, Round A3 — the app half).** Three of the five legs were already closed by Phase 6 (`my_team_ids` active join, `owner_team_id` FK, audited supervisor change/delete). Now: `createTeam`, `updateTeam`, `addTeamMember`, `removeTeamMember` write `TEAM_CREATED` / `TEAM_UPDATED` / `TEAM_MEMBER_ADDED` / `TEAM_MEMBER_REMOVED` (update and remove are checked writes, so a refusal never leaves a phantom audit row; `TEAM_%` already rides the admin-only audit overlay); `/api/admin/create-user` writes `MEMBER_CREATED`; the members page's gates read the role collection and match the routes they front (page: Admin|Manager|DocCtrl; add: Admin|DocCtrl like the route; suspend/restore: Admin|Manager and remove: Admin like `revoke_member`). Remaining (DB half, next migration round): `teams_admin_write` / `team_members_admin_write` still read the headline `role` — they become `caller_holds_any_role(org_id, ARRAY['Admin','Manager'])` with the `ADD-4` rewrite.
- Files: `lib/teams.ts`, `app/(protected)/admin/teams/page.tsx`, `app/api/admin/create-user/route.ts`, `app/(protected)/admin/users/page.tsx`. Tests: `lib/__tests__/sweepRoundA3.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** compliance / ux
- **Locations:**
  - `lib/teams.ts:66-118` — `createTeam` / `addTeamMember` / `removeTeamMember` / `deleteTeam`: **zero `logAuditAction` calls**
  - `supabase/migrations/20260707_teams.sql:37-49` — `role IN ('Admin','Manager')`, **singular**, while `is_org_admin_or_manager` is additive
  - `supabase/migrations/20260707_teams.sql:52-55` — `my_team_ids()` has **no `status='active'` filter**, so a deactivated member's team grants persist in every ACL evaluation
  - `app/api/admin/create-user/route.ts:62` — requires `['Admin','DocCtrl']`
  - `app/(protected)/admin/users/page.tsx:231` — the page that calls it requires `['Admin','Manager']`
- **Related:** `DEL-3`, `DEL-4`, `SURF-1`
- **Re-verified:** hardening pass — **SURVIVES**. Teams are ACL subjects (`acl_subject_in_bucket` matches `teams`) with no audit trail on membership change, and `/api/admin/create-user` never consults team membership when deciding authority.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Both halves of the title hold: team membership (an ACL subject via my_team_ids()) mutates with no audit row, and the page/route role sets disagree in both directions — a Manager can open Team Management but gets 403 from create-user, a DocCtrl can call create-user but is refused the page. Severity stays MEDIUM, but the summary's scenario is refuted: a contractor cannot 'add themselves to a team', because supabase/migrations/20260707_teams.sql:52-55 gates team_members writes to `role IN ('Admin', 'Manager')`. The correct scenario is that an Admin/Manager grant leaves no record of who made it.

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

## SURF-17 · A member can queue mail to an arbitrary address with arbitrary HTML (split from `SURF-5`)

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round B).** A member can no longer queue mail to an arbitrary address with arbitrary HTML. Database: a client INSERT into `email_notifications` must address a member of the same org (`lower(r.email) = lower(to_email)`) and may not be marked external (the DEC-30 inventory of client-queued non-member mail is recorded before apply). App: the transmittal email is queued by `/api/transmittal/send-email` — session-authenticated, the caller must be an active member and the issuer or a controller, the message is rendered from the transmittal ROW (the request carries only an id), audited `TRANSMITTAL_EMAILED`; `sendTransmittalEmail` calls the route; `queueExternalEmail` is removed from the browser library. Server-side inserts (intake, cron, transmittal acknowledgment) are untouched.
- Migration: `20261047` — **printed for operator paste; pending apply** (10-point verification incl. a 14-column late-binding probe; 5-line inventory recorded BEFORE apply).. Files: `app/api/transmittal/send-email/route.ts`, `lib/transmittals.ts`, `lib/notifications.ts`. Tests: `lib/__tests__/rpSweepMigrations.test.ts` (shape + line-diffs against the live predecessors), `lib/__tests__/sweepRoundB.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** security (phishing relay) / brand
- **Locations:**
  - `supabase/migrations/20260605_rls_policies_new_tables.sql:121-124` — the `email_notifications` INSERT policy: any active member may insert arbitrary `to_email` / `subject` / `body_html`
  - `lib/notifications.ts:124-147` — `queueExternalEmail`, a **browser-client** insert of an external recipient + full HTML
  - `lib/transmittals.ts:281` — its only caller (a client module)
- **Related:** `SURF-5`
- *(Split from `SURF-5` under `DEC-31`, 2026-08-24. `SURF-5` closed Done-when 1–2 (the cross-tenant drain); this is its Done-when 3.)*

**Mechanism.** After `SURF-5`'s Piece A, a member can still queue a forged email — arbitrary `to_email`, attacker-chosen `body_html` — into their **own** org's queue and trigger the (now org-scoped) drain, which sends it from `RESEND_FROM_EMAIL`. A functioning phishing relay with the org's branding, within one org.

**Why it was split.** Closing this requires two coupled changes that are safety-sensitive and cannot be verified from the repository:
1. **Move the transmittal external-send server-side.** `queueExternalEmail` is called from `lib/transmittals.ts` (a browser module). Locking the INSERT policy breaks it unless the send moves to a new session-authed route (e.g. `/api/transmittal/send-email`) that loads the transmittal by id server-side, renders subject/body from the DB row (recipient + body un-forgeable), and inserts via the service role. This touches the controlled-distribution flow — a safety-critical path.
2. **Tighten the INSERT policy.** A member→member-only policy (recipient must be an active member) closes the external relay without the risky email-equality check. The stronger email-match form (`lower(r.email) = lower(to_email)`) risks silently dropping legitimate member notifications if `to_email` ever differs from a member's registered email — which cannot be confirmed without live data (`DEC-30`).

**Remediation (illustrative).** New migration: `DROP` the open INSERT policy; `CREATE` one requiring the caller be an active member of the row's org AND (`metadata->>'external' IS NOT 'true'`) so external sends must go server-side; the transmittal route inserts via `supabaseAdmin`. Confirm with the inventory query whether any `queueEmail` path sets `to_email` to anything other than the recipient's `org_members.email` before considering the stricter email-match.

**Inventory query (DEC-30, run before the stricter policy):**
```sql
SELECT en.id, en.to_email, m.email AS registered
FROM email_notifications en
LEFT JOIN org_members m ON m.org_id = en.org_id AND m.uid = en.to_user_id
WHERE (en.metadata->>'external') IS DISTINCT FROM 'true'
  AND lower(en.to_email) <> lower(coalesce(m.email, ''));
```

**Done when.** A member cannot queue mail to an address that is not a fellow active member's registered address, or with HTML they authored, except through a server route that renders the body from trusted state.

---

## SURF-18 · `email_notifications` has no SELECT/UPDATE policy, so dedupe and the dead-letter panel silently no-op

- **Severity:** LOW
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round B).** `email_notifications` gains a SELECT policy (own rows — the 60-second dedupe window finally sees something — or the admin trail for Admin/Manager by collection) and an UPDATE policy for Admin/Manager confined by `enforce_email_requeue_columns` to `status` / `attempt_count` only, so the dead-letter panel can count and re-queue but can never rewrite a queued message's address or body (`SURF-17`'s second door stays shut). Both key on `org_id`, never on `to_user_id` alone (the `SURF-5` trap).
- Migration: `20261047` — **printed for operator paste; pending apply** (10-point verification incl. a 14-column late-binding probe; 5-line inventory recorded BEFORE apply).. Tests: `lib/__tests__/rpSweepMigrations.test.ts` (shape + line-diffs against the live predecessors), `lib/__tests__/sweepRoundB.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** correctness / observability
- **Locations:**
  - `supabase/migrations/20260605_rls_policies_new_tables.sql:121-124` — the only `email_notifications` policy is INSERT
  - `lib/notifications.ts:66-75` — `queueEmail`'s 60-second burst-dedupe SELECT (always empty under RLS)
  - `app/(protected)/admin/settings/page.tsx` — the dead-letter panel count (always 0) and requeue update (matches nothing)
- **Related:** `SURF-5`, `SURF-17`
- *(Raised while resolving `SURF-5`, 2026-08-24. `author` grade until independently challenged.)*

**Mechanism.** With no SELECT or UPDATE policy for `authenticated`, every client read/update of `email_notifications` returns zero rows. So the documented burst-dedupe (`dispatch.ts:105-106`) never fires — duplicate emails are only prevented by the server-side claim, not the client dedupe — and the `/admin/settings` dead-letter panel shows an empty failed-queue and its "requeue failed" button silently matches nothing.

**Done when.** A carefully-scoped SELECT/UPDATE policy (or a server route) lets an org's admins see and requeue their own failed rows, and `queueEmail`'s dedupe sees its own recent rows — without re-opening the cross-tenant read `SURF-5` closed.

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
