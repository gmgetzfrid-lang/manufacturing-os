# 06 · Transmittals & the external portal

**15 findings** — 7 HIGH · 7 MEDIUM · 1 LOW (`TRX-15` opened at the P7 merge, 2026-10-01).

What leaves the building, and what the recipient can reach.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The transmittal snapshot design — items denormalize number/title/rev/versionId into JSONB so the record survives the document revving forward or being deleted | `lib/transmittals.ts:8-14, supabase/migrations/20260717_transmittals.sql:10-14` | This is the correct doc-control model and the reason the register can answer "what rev did we send?" at all. Fixes should extend the item shape (add file_hash, status-as-sent), never replace the snapshot with live joins. |
| The 20260910 RLS split already fixed the FOR-ALL/no-WITH-CHECK shape found on tickets, notifications, email_notifications and project_documents — transmittals now has four separate policies and both UPDATE and INSERT carry WITH CHECK | `supabase/migrations/20260910_transmittal_portal.sql:29-56` | The recurring org-wide defect is genuinely absent here. The remaining problems are narrower (a missing membership test on one disjunct, a missing status predicate) and should be fixed by tightening these policies, not by rewriting them. |
| The portal correctly refuses voided transmittals before any file resolution, and scopes downloads to items actually on the transmittal | `app/api/transmittal/route.ts:61, :66-68, :114` | `if (t.status === "voided")` runs before the `?file=` branch, and `items.find((i) => i.documentId === fileDoc)` with a 403 on miss means an arbitrary document id cannot be pulled through a valid token. These two guards are the portal's real containment and must survive any refactor. |
| Portal token entropy is sound — two concatenated randomUUIDs, dashes stripped, first 40 hex chars (~154 random bits), with a partial unique index and a strict format check at the door | `lib/transmittals.ts:377-379, supabase/migrations/20260910_transmittal_portal.sql:26-27, app/api/transmittal/route.ts:25` | Guessing is not the weakness — lifetime and revocation are. Do not spend effort lengthening or re-deriving the token; add expires_at/revoked_at instead. |
| The acknowledgment round-trip is idempotent and state-guarded: an already-acknowledged transmittal returns ok+already rather than re-writing, a non-issued one 409s, and the UPDATE re-asserts `.eq("status", "issued")` | `app/api/transmittal/route.ts:115-118, :136-137` | A double-clicked or replayed acknowledgment cannot overwrite the original receipt's name or timestamp. This is the one write in the whole area that does check its own preconditions properly. |
| The register already computes and displays supersession drift for live transmittals — staleIds compares each item's as-sent rev against documents.rev and badges "superseded rev in circulation" | `app/(protected)/transmittals/page.tsx:72-92, :238-242, components/documents/InspectorPanel.tsx:1036-1078` | The internal half of supersession awareness exists and works. The gap is that the external recipient never sees it — extend this computation into the portal payload rather than building a parallel one. |
| renderTransmittalEmail and renderTransmittalSheet are pure, escape every recipient-controlled field through `esc()`, and are unit-tested including an XSS case | `lib/transmittals.ts:93-94, :208-267, lib/__tests__/transmittalEmail.test.ts:35-42` | The email/HTML rendering layer is safe and covered. New fields added to the cover sheet or email must route through the same `esc()` and gain a test in the existing file. |
| The repo already contains every helper the portal is missing: publicOrigin(), applyStampToPdfDoc/stampPdf, logDownloadAudit/download_audits, document_versions.file_hash, and the intake link's expires_at/revoked_at/last_used_at lifecycle | `lib/publicOrigin.ts:17-22, lib/stamping.ts:238, lib/downloads.ts:120-146, supabase/migrations/20260526_document_version_control.sql:41, supabase/migrations/20260902_project_intake.sql:28-33` | None of the fixes in this report require new infrastructure — each has a working in-repo counterpart to copy, and app/api/share/file/route.ts is a complete worked example of anonymous external delivery done correctly. |
| Only two vercel.json cron entries exist and a third fails every deployment on this plan; /api/cron/maintenance is the documented place to hang new periodic work | `vercel.json:3-12, app/api/cron/maintenance/route.ts:286-291` | A portal-token expiry sweep must ride the maintenance cron, not get its own entry. |


---


<a id="trx-1"></a>

## TRX-1 · Any active org member — including a Viewer or a Contractor-role member — can create and issue a transmittal in a single insert, defeating the hardening the migration claims to deliver

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:15-17`, `supabase/migrations/20260910_transmittal_portal.sql:39-44`, `lib/transmittals.ts:428-448`, `lib/roleCapabilities.ts:39`, `lib/roleCapabilities.ts:48-67`, `app/(protected)/transmittals/page.tsx:54-70`
- **Also surfaced independently as** [`DIST-6`](./05-distribution.md#dist-6) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence too: app/(protected)/transmittals/page.tsx contains no capability/role check at all (grep for hasCapability/ROLE_CAPABILITIES/activeRole=== returns nothing), `openNew` at :133 is unconditional, ViewTabs DOCUMENT_VIEWS lists /transmittals for everyone (components/navigation/ViewTabs.tsx:86), and there is no middleware.ts or protected-layout role gate. The composer's `save(true)` (page.tsx:427) passes `issueNow: issue` straight through. Any active member issues a contractual record.

**Mechanism.** 20260910's header states the intent: "RLS hardening: the old any-member FOR ALL policy let a Viewer issue, void, or acknowledge contractual records. Now: members read, members create their OWN drafts, and only the creator or a controller (Admin/DocCtrl) may update/delete." But the INSERT policy constrains only authorship and membership (:41-43) — it says nothing about `status`. createTransmittal writes the terminal state directly on insert: `status: issueNow ? "issued" : "draft"`, `issued_at: issueNow ? now : null`, `...(issueNow ? { portal_token: makePortalToken() } : {})` (lib/transmittals.ts:447, 452-453), then immediately emails the portal link (:494-496). So "members create their OWN drafts" is not what the policy enforces: a member creates their own *issued* transmittal with a live external portal token. On the app side there is no capability gate at all — the page reads `activeRole` only to stamp it into the audit actor (page.tsx:65-70); `grep -i transmit lib/roleCapabilities.ts lib/capabilityPolicy.ts lib/permissions.ts` returns nothing, even though the app defines a `doc_control: "Document control (IFC / final issue)"` capability (roleCapabilities.ts:39) held by DocCtrl alone.

**Failure scenario.** A member with the Viewer role (ROLE_CAPABILITIES.Viewer is `[]`, roleCapabilities.ts:67) or the Contractor role opens /transmittals, adds a set of IFC drawings, types an outside email address, and clicks Issue. createTransmittal inserts status='issued' with a portal token; the RLS INSERT policy passes; the portal link is emailed to the outside party; a numbered TR- record now asserts the org formally issued those drawings For Construction. No role check ran anywhere.

**Evidence.**

```
supabase/migrations/20260910_transmittal_portal.sql:15-17 — `--   3. RLS hardening: the old any-member FOR ALL policy let a Viewer` / `--      issue, void, or acknowledge contractual records. Now: members read,` / `--      members create their OWN drafts, and only the creator or a`. lib/transmittals.ts:447 — `status: issueNow ? "issued" : "draft",` and :453 — `...(issueNow ? { portal_token: makePortalToken() } : {}),`. lib/roleCapabilities.ts:67 — `  Viewer: [],`
```

**Chain reaction.** Because the creator also satisfies transmittals_update (20260910:47-48), the same Viewer can then acknowledge their own transmittal on the recipient's behalf via acknowledgeTransmittal, manufacturing a receipt record end to end.

**Done when.**

- [ ] the INSERT policy requires status = 'draft' (and portal_token IS NULL), so issuing is always an UPDATE subject to the update policy
- [ ] the update policy gates the draft→issued transition on is_org_controller (or a named issuer role), not merely on created_by
- [ ] the /transmittals page hides or disables New/Issue for roles lacking the doc_control (or a new transmit) capability, using lib/roleCapabilities.ts rather than a hardcoded role list

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced from code: `createTransmittal` inserted `status: issued` + a token in one INSERT and `transmittals_insert` (20260910) checked only authorship and membership; nothing anywhere asked who may issue. Fixed in three layers, decided by the database:
- **Capability.** New `transmittal.issue` ("Issue transmittals", area Transmittals) in `lib/capabilityPolicy.ts` `CAPABILITY_DEFS`, default `["Admin","DocCtrl"]` — the controller pair the UPDATE policy (`is_org_controller`) and the email route hardcoded. Migration `20261132` re-creates `org_capability_allows_for` from its newest definition (`20261063`) with exactly that one CASE row (lineDiff-pinned). It gates issuing, voiding, revoking the portal link and recording a receipt on the recipient's behalf; drafting stays open to every active member.
- **Database (20261133).** `transmittals_insert` now requires `status = 'draft' AND portal_token IS NULL` (plus the 20260910 authorship + active membership), so issuing is always an UPDATE; `trg_transmittals_guard` refuses a member INSERT born anything but a draft and clears every server-owned column; on the draft → issued transition (and on void / revoke) it calls `org_capability_allows_for(org, 'transmittal.issue', auth.uid(), {libraryId})` once per item's library (DEC-13 — a library rule decides who may transmit from that library; an item whose document is gone, or a transmittal with no items, is judged on the base list) and raises `insufficient_privilege` otherwise. `transmittals_update` admits a controller, a transmit authority, or the creator while an active member.
- **App.** `createTransmittal` creates drafts only (`issueNow` is gone); the composer creates, then calls `issueTransmittal`. `/transmittals` reads the policy (`loadCapabilityPolicy` + `mayTransmit(policy, principal, itemLibraries)`) — no role list on the page (DEC-35) — and disables Issue with the reason for a member without transmit authority ("a Document Controller can issue your draft"); Receipt / Revoke / Void render only for a transmit authority. `/api/transmittal/send-email` and the new `/api/transmittal/receipt` decide with `evaluateTransmitAuthority` (active membership + the strict, fail-closed policy read + per-library evaluation).
- Tests: `lib/__tests__/dcRoundFTransmittals.test.ts` ("TRX-1 — transmit authority is a capability…": default pair by role collection, library rule, personal grant, page has no role list, createTransmittal inserts a draft only; send-email refuses the creator without the capability); `lib/__tests__/dcRoundFTransmittalMigrations.test.ts` (20261132 line diff + CASE census; the guard's authority block; the INSERT / UPDATE policies); the CASE census updates in `rpPhase4Migration.test.ts`, `roundE_D_migration.test.ts`, `sweepRoundE_policyServer.test.ts`. Also run against a scratch PostgreSQL 16 cluster (stub schema + the real 20260717 / 20260910 / 20261027 / 20261132 / 20261133): a Viewer's INSERT of an issued row → 23514 "cannot be born issued"; a Viewer issuing their own draft → 42501; a DocCtrl issuing the Viewer's draft → ok; with a stored library rule (`{"tokens":["DocCtrl"],"when":{"libraryId":[L2]}}`) an Admin issuing a library-2 item → 42501 and a DocCtrl → ok.
- Pending migration: `20261132_dc_roundF_transmit_capability.sql` then `20261133_dc_roundF_transmittal_rails.sql` — hand-applied, in that order (DEC-30; 20261133 refuses to apply before 20261132 — its first statement raises and rolls the file back). Until they are applied only the app half of this resolution is in force.

**Done-when.**
- ✓ The INSERT policy requires `status = 'draft'` and `portal_token IS NULL` (20261133); issuing is always an UPDATE.
- ✓ The draft → issued transition is gated on transmit authority — a named capability whose default is the controller tier — not on `created_by`. It is enforced in `trg_transmittals_guard` rather than in the UPDATE policy's expression, because a policy sees only one side of the row and cannot tell the transition from a draft edit; the trigger sees both and also covers void / revoke.
- ✓ `/transmittals` disables Issue (and hides Receipt / Revoke / Void) for a principal lacking the capability, from the capability policy — not `lib/roleCapabilities.ts`, which DEC-11 keeps picker-only ("do not wire an enforcement decision to these strings") — and with no hardcoded role list. New stays open: drafting is a member's act.

**Scope / residual.** A member granted the capability only through a library-scoped rule (none exists until an org writes one) is admitted by the trigger for that library but not by the UPDATE policy's base-list arm when the draft is someone else's — they can issue their own drafts there; a controller or base-list holder issues the rest. The new decision is DEC-61.

---

<a id="trx-2"></a>

## TRX-2 · Issued and acknowledged transmittals are deletable at the database by their creator — the "draft-only" rule exists only in application code and was explicitly deferred, then never implemented

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:53-56`, `supabase/migrations/20260818_followups_rls.sql:50-58`, `supabase/migrations/20260815_versions_collections_delete_controllers.sql:15`, `lib/transmittals.ts:633-637`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:29-33`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The legal-hold trigger cannot cover the gap: 20260826_legal_hold_delete_guard.sql attaches `BEFORE DELETE` triggers only to `documents` (:53-57) and `document_versions` (:85-89) — there is no trigger on transmittals in any migration (grep for 'transmittals' across supabase/migrations returns only the policy statements). A creator's direct DELETE on an issued or acknowledged transmittal is permitted at the database.

**Mechanism.** Only lib/transmittals.ts:643 enforces draft-only: `.delete().eq("id", id).eq("status", "draft")`. At the DB, DELETE composes as (permissive) `transmittals_delete USING (is_org_controller(org_id) OR created_by = auth.uid())` (20260910:54-56) AND (restrictive) `transmittals_delete_guard … USING (is_org_admin_or_manager(org_id) OR created_by = auth.uid() OR (project_id IS NOT NULL AND can_manage_project(project_id)))` (20260818:52-58). `created_by = auth.uid()` satisfies both branches, and neither policy mentions `status`. So a direct PostgREST DELETE by the creator removes an issued or acknowledged transmittal row outright. 20260815:15 named this exact gap as deferred work — "transmittals delete   — issuer roles, draft-only" — and 20260818 delivered the "issuer roles" half only; 20260910 then rewrote the permissive policy, again without a status predicate. Contrast documents and document_versions, which carry BEFORE DELETE triggers precisely because "a direct PostgREST call, a future code path that forgets the check, or a race … could still destroy a held record" (20260826:4-8).

**Failure scenario.** A contractual dispute surfaces over TR-0042. The engineer who issued it opens the browser console (or any PostgREST client with their session token) and issues `DELETE /rest/v1/transmittals?id=eq.<uuid>`. RLS permits it: they are created_by. The numbered, acknowledged record of "we issued you P-200-001 Rev C for construction on this date" — including the acknowledgment, the recipient, and the item list — is gone. The unique index on (org_id, number) frees TR-0042 for reuse. Only scattered audit_logs rows remain, and audit_logs has no FK to the deleted row.

**Evidence.**

```
supabase/migrations/20260815_versions_collections_delete_controllers.sql:15 — `--   * transmittals delete   — issuer roles, draft-only`. supabase/migrations/20260910_transmittal_portal.sql:54-56 — `CREATE POLICY transmittals_delete ON transmittals FOR DELETE USING (` / `  is_org_controller(org_id) OR created_by = auth.uid()` / `);` — no status predicate. lib/transmittals.ts:643 — `const { error } = await supabase.from("transmittals").delete().eq("id", id).eq("status", "draft");`
```

**Chain reaction.** Voiding has the same shape: voidTransmittal uses `.neq("status", "voided")` (lib/transmittals.ts:628), so a draft can be voided too, contradicting its own docstring "Drafts are deleted, not voided" (:621).

**Done when.**

- [ ] a RESTRICTIVE DELETE policy (or BEFORE DELETE trigger, matching 20260826) blocks deletion of any transmittal whose status is not 'draft', applying to service-role paths as well
- [ ] the transmittals_delete permissive policy is narrowed to drafts so the app-layer filter is a convenience, not the only guard
- [ ] voidTransmittal is constrained to status = 'issued' or 'acknowledged'

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced from the policies: `transmittals_delete` (20260910) and the RESTRICTIVE `transmittals_delete_guard` (20260818) both admit `created_by = auth.uid()` with no status predicate, and no trigger existed on the table. Fixed in `20261133`:
- `trg_transmittals_guard` now also fires BEFORE DELETE (one trigger, not two) and refuses deleting any transmittal whose status is not `draft` — for every caller, the service role included, as 20260826 does for held records. The one pass is the FK cascade of deleting the workspace itself (the org row is already gone in that snapshot, so the org's own delete decided).
- The permissive `transmittals_delete` is narrowed to `status = 'draft'` (a controller, or the creator while an active member — TRX-6).
- The lifecycle runs one way in the same trigger: draft → issued → acknowledged, issued / acknowledged → voided; a draft is deleted, never voided, and nothing leaves `voided`. `voidTransmittal` filters `.in("status", ["issued","acknowledged"])` and is a checked write (TRX-7).
- Tests: `dcRoundFTransmittalMigrations.test.ts` ("TRX-2: an issued transmittal is never deleted…", the lifecycle and DELETE-policy pins); `dcRoundFTransmittals.test.ts` ("void is constrained to issued / acknowledged"). Scratch PostgreSQL 16 run: the creator's DELETE of an issued row → 0 rows (policy); the service role's DELETE of it → 23514 "stays on the register"; a draft voided → 23514 "cannot move from draft to voided"; un-voiding → refused; deleting the org cascades past the arm (0 rows left).
- Pending migration: `20261132_dc_roundF_transmit_capability.sql` then `20261133_dc_roundF_transmittal_rails.sql` — hand-applied, in that order (DEC-30; 20261133 refuses to apply before 20261132 — its first statement raises and rolls the file back). Until they are applied only the app half of this resolution is in force.

**Done-when.**
- ✓ A BEFORE DELETE trigger arm (matching 20260826) blocks deleting any non-draft transmittal, service-role paths included.
- ✓ `transmittals_delete` is narrowed to drafts, so the app-layer `.eq("status", "draft")` is a convenience.
- ✓ Voiding is constrained to `issued` / `acknowledged` — in `voidTransmittal` and, for every path, in the trigger's lifecycle rule.

**Scope / residual.** The 20260818 RESTRICTIVE delete guard is unchanged (it still decides who among the permissive arm's callers may delete a draft). A purge of an issued transmittal, if a retention rule ever needs one, would need its own audited path — none exists or is asked for.

---

<a id="trx-3"></a>

## TRX-3 · Nothing checks a document's status, legal hold, active operational holds, or effective date before it can be put on a transmittal or served by the portal

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/transmittals/page.tsx:386-392`, `app/(protected)/transmittals/page.tsx:112-127`, `app/api/transmittal/route.ts:39-82`, `types/schema.ts:613`, `supabase/migrations/20260612_phase5_holds.sql:5-7`, `supabase/migrations/20260820_retention.sql:31`, `lib/effectiveDate.ts:14-27`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The core is right and unguarded: a document under a legal hold (20260820_retention.sql:31) or an open operational hold (20260612_phase5_holds.sql) can be added to a transmittal and served by the portal with no check anywhere, and the Inspector's entry point (components/documents/InspectorPanel.tsx:582-583) is an unconditional NextLink. Corrected because 'nothing checks status' is not literally true (Archived is excluded) and the effective-date item is a design choice the app applies uniformly, not a transmittal-specific defect — which removes half the stated blast radius that HIGH rested on.

**Mechanism.** The composer's document picker filters exactly one thing: `.eq("org_id", orgId).neq("status", "Archived")` (page.tsx:389-390). `DocumentStatus = "Draft" | "Issued" | "Superseded" | "Void" | "Archived" | "Locked"` (types/schema.ts:613), so a Draft, Superseded or Void drawing is selectable and issuable "For Construction". The deep-link preload path is worse — page.tsx:113-117 fetches the document by id with no status filter at all, so /transmittals?compose=1&doc=<id> from the Inspector or command palette pre-loads an Archived or Void record. There is no reference to `legal_hold`, `document_holds`, or `effective_date` anywhere in lib/transmittals.ts, the composer, or app/api/transmittal/route.ts (grep for hold/legal/Superseded/Void across all three returns only the register's own status strings). document_holds is defined as "an explicit operational stop on a document: it can't be advanced until the blocker is cleared" (20260612_phase5_holds.sql:5-7), and lib/effectiveDate.ts:14-27 distinguishes a `pending` revision not yet in force — neither state is visible on the cover sheet or the portal.

**Failure scenario.** A P&ID is placed on hold for "Missing Vendor Data" and its Rev D is dated effective the first of next month. A project engineer opens the Inspector, clicks "Issue this document via transmittal", and issues it For Construction. The cover sheet (lib/transmittals.ts:176-182) prints only #/Number/Title/Rev and closes with "This is the controlled record of the documents and revisions issued above." The portal (page.tsx:132-155) shows the same four fields. The contractor has no way to learn the drawing is held, is Void, or is not yet in force.

**Evidence.**

```
app/(protected)/transmittals/page.tsx:389-390 — `.eq("org_id", orgId)` / `.neq("status", "Archived")`. page.tsx:113-117 — `await supabase.from("documents").select("id, document_number, title, name, rev, current_version_id").eq("id", docId).maybeSingle();` (no status/hold predicate). lib/transmittals.ts:180 — `<thead><tr><th style="width:32px">#</th><th>Number</th><th>Title</th><th style="width:80px">Rev</th></tr></thead>` — the sheet carries no status column.
```

**Chain reaction.** Because the transmittal denormalizes only number/title/rev (lib/transmittals.ts:34-40), the document's control state at issue time is never captured either, so no later audit of the transmittal register can detect that a held or voided drawing went out.

**Done when.**

- [ ] the picker and the ?doc= preload path exclude Superseded / Void / Archived documents, or require an explicit acknowledged override recorded on the transmittal
- [ ] isTransmittalIssuable (lib/transmittals.ts:87-91) refuses to issue when any item is on an active document_holds row or under legal_hold, or surfaces a blocking confirmation
- [ ] the item snapshot records the document status and effective_date as sent, and both the cover sheet and the portal render them

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: the picker filtered `.neq("status","Archived")` only, the `?doc=` preload filtered nothing, and no transmittal path read holds or the effective date. Fixed at both ends:
- **Picker and preload.** The composer's search excludes the shared not-current set (`NOT_CURRENT_FILTER`, built from `NOT_CURRENT_STATUSES` in `lib/aiBoundary.ts` — no inline list) and archived documents; the `?compose=1&doc=` preload refuses a withdrawn document with a toast instead of pre-adding it.
- **The issue gate — app (HLD-1 call site).** `issueTransmittal` runs `assertItemsIssuable`: a withdrawn, unreadable or file-less item is refused with its name, then `assertNotOnHold` (lib/holdGate.ts, fail-closed) is asked for every document. The composer shows each item's status, a LEGAL HOLD chip and the blocker, disables Issue while any item is blocked (an unreadable hold set blocks), and asks a deliberate confirmation for a legal hold (`legalHoldNotice`).
- **The issue gate — database (20261133).** On the draft → issued transition `trg_transmittals_guard` refuses an item whose document is Superseded / Void / Archived or archived, or has an active `document_holds` row, and then writes the as-sent snapshot onto the item: `statusAsSent` (the document's status) and `effectiveDate` (the pinned revision's), with `versionId` / `fileHash` / `fileSize` (TRX-8 / TRX-12). A Draft may go out (for review / approval) — its status is printed as sent.
- **Status truth (fix pass).** The review found the gate admitted a pinned version that had since been superseded and wrote it out under the document's CURRENT status ("Rev C · Issued" for a revision Rev D replaced). Now only the document's current revision can go out: the trigger refuses an item whose pinned `versionId` is not `documents.current_version_id` — "P-200-001 Rev C has been superseded by Rev D — remove P-200-001 and add it again to send the current revision." — and a version row stamped `superseded_at`; the snapshot is always taken from the current version, so `statusAsSent` is the status of the revision actually sent. A Rev mismatch now names its cause: when the item's Rev is the document's own Rev field but not the current file's label, the message says the document's Rev field drifted from its file and must be corrected (re-adding cannot help); otherwise the item is stale and is re-added. The composer reads the current file's `revision_label` and `documents.rev` into its facts and `itemIssueBlocker` / `assertItemsIssuable` refuse the same three cases before the round-trip, so Issue is never offered for something the database will refuse. The migration's inventory counts the drafts pinned to a revision that is no longer current.
- **Render.** The cover sheet gains "Status as sent" (status + effective date, "not yet in force" when pending) and SHA-256 columns; the portal shows "<status> as sent", "Effective <date> — not yet in force" and the file fingerprint per document.
- Tests: `dcRoundFTransmittals.test.ts` ("TRX-3 — withdrawn, held or file-less items cannot be issued": blocker reasons incl. fail-closed holds; legal hold asks; `issueTransmittal` refuses a held and a withdrawn item before any write; picker / preload pins; fix pass: a superseded pin refused naming its replacement, the Rev-field drift and stale-item messages, `assertItemsIssuable` reading the current labels, the composer's facts), the sheet and portal render pins; `transmittalPortalRoute.test.ts` (snapshot payload); `dcRoundFTransmittalMigrations.test.ts` (the gate block; fix pass: the current-revision pin before the snapshot, `superseded_at`, the two mismatch messages, the inventory row). Scratch PostgreSQL 16 run: issuing a Superseded item → "withdrawn (Superseded)"; a held item → "under an active hold"; a legal-held item → issues; an issued row carries `statusAsSent` and `effectiveDate`. Fix pass, on a fresh scratch cluster: a draft pinned to Rev C, issued after Rev D was published → "P-200-001 Rev C has been superseded by Rev D …"; re-added at Rev D → issues with `statusAsSent` of the current revision; a document whose Rev field (B) drifted from its file (A) → the Rev-field message; a stale unpinned item → the listed-at message; the inventory counted the stale draft.
- Pending migration: `20261132_dc_roundF_transmit_capability.sql` then `20261133_dc_roundF_transmittal_rails.sql` — hand-applied, in that order (DEC-30; 20261133 refuses to apply before 20261132 — its first statement raises and rolls the file back). Until they are applied only the app half of this resolution is in force.

**Done-when.**
- ✓ The picker and the `?doc=` preload exclude Superseded / Void / Archived (and archived) documents.
- ✓ Issuing refuses an item on an active `document_holds` row (app: the shared hold gate, fail-closed; database: the trigger). A legal hold surfaces a blocking confirmation rather than a refusal — a legal hold preserves records, and no other distribution door (share links, packs) refuses on it.
- ✓ The item snapshot records the document's status and the revision's effective date as sent, and the cover sheet and the portal render both. Corrected in the fix pass: the status recorded is now the status OF THE REVISION SENT — the database admits only the document's current revision (a pin to a superseded one is refused, naming its replacement), so a superseded revision can no longer go out labelled with the document's current status.

**Scope / residual.** `isTransmittalIssuable` keeps its two-field rule when called without facts (its callers outside the composer are unchanged); the composer and the issue path always pass or apply the facts. Sending a superseded revision on purpose (an explicit override recorded on the item) was not built — no requirement for it is stated; such a draft is refused until its item is re-added at the current revision.

---

<a id="trx-4"></a>

## TRX-4 · The portal token has no expiry, no revocation, no use tracking — the only way to cut off external access is to void the contractual record itself; and live tokens are exported in plaintext in the full workspace backup

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:5-10`, `supabase/migrations/20260910_transmittal_portal.sql:21-27`, `supabase/migrations/20260902_project_intake.sql:28-33`, `app/api/intake/resolve/route.ts:37-41`, `app/api/transmittal/route.ts:57-61`, `lib/exportTables.ts:54`, `lib/dataExport.ts:300`, `app/(protected)/transmittals/page.tsx:258-269`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The export half is confirmed too: lib/exportTables.ts:54 lists `"transmittals"` (and :51 `"project_intake_links"`) among exported tables, and lib/dataExport.ts:300 pulls them with `sb.from(table).select("*")` — grep for 'redact' in lib/dataExport.ts returns nothing, so live portal_token values leave in plaintext. A repo-wide grep confirms portal_token exists in exactly one migration and is never expired, rotated, or counted.

**Mechanism.** 20260910 claims the pattern it copied: "an unguessable token turns each ISSUED transmittal into an isolated external link (same pattern as project intake)". Project intake's table actually carries the lifecycle: `expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, … last_used_at TIMESTAMPTZ, submission_count INT NOT NULL DEFAULT 0` (20260902:28-33), enforced at app/api/intake/resolve/route.ts:38-41 (`if (link.revoked_at) … 410 revoked` / `if (link.expires_at && Date.parse(...) < Date.now()) … 410 expired`) and bumped via `bump_intake_use` on every use. 20260910 adds three columns and nothing else — `portal_token TEXT`, `acknowledged_via TEXT`, `acknowledged_meta JSONB` — and `grep 'ALTER TABLE transmittals' supabase/` confirms no other column was ever added. app/api/transmittal/route.ts checks only `if (t.status === "voided")` (:61, :114). So access is revoked only by flipping the record to `voided`, which the register itself describes as "It was sent in error" (lib/transmittals.ts:621) and the portal renders as "This transmittal was voided by the issuer — it is no longer a valid record" (page.tsx:86) — you cannot cut off a link without repudiating the issue. Amplifier: `transmittals` is in ORG_SCOPED_TABLES (lib/exportTables.ts:54) and dataExport dumps it with `sb.from(table).select("*")` (lib/dataExport.ts:300) with no redaction anywhere in the file, so every live portal_token lands in the workspace backup JSON in plaintext.

**Failure scenario.** A contractor's project ends and the relationship sours. The org wants to cut off their access to the IFC set. Voiding TR-0042 works, but it also stamps the contractual record "voided — no longer a valid record", destroying the proof that the drawings were properly issued. The alternative is leaving a permanent, un-expiring download link in the hands of a former counterparty. Meanwhile a routine workspace export downloaded to an admin's laptop contains every one of those tokens as readable text — an exfiltrated backup is an exfiltrated set of permanent, unrevokable drawing-download links.

**Evidence.**

```
supabase/migrations/20260910_transmittal_portal.sql:6-7 — `--      an unguessable token turns each ISSUED transmittal into an isolated external link (same pattern as project intake) —`. supabase/migrations/20260902_project_intake.sql:28-29 — `  expires_at TIMESTAMPTZ,` / `  revoked_at TIMESTAMPTZ,`. lib/dataExport.ts:300 — `let q = sb.from(table).select("*").range(from, from + pageSize - 1);`
```

**Chain reaction.** There is also no `last_used_at`/open counter, so the register cannot answer "did the contractor ever open the link?" — only whether they clicked Acknowledge. And any active org member can copy the link for a transmittal they did not issue: the register renders a "Portal link" button for every row with a token (page.tsx:258-269) and transmittals_select (20260910:34-37) exposes portal_token to every active member.

> **Verifier correction.** Two qualifications worth carrying: (1) voiding does genuinely sever access — the route returns 410 at :61 and :114 — so the defect is that revocation and repudiation are the same act, not that revocation is impossible; (2) the export amplifier is gated to active Admin/Manager/DocCtrl members of that org (app/api/data-export/structured/route.ts:53-58), so it is an over-broad admin-visible dump rather than a public leak — and note project_intake_links.token and document_shares.token ride the same unredacted export, so this is a table-wide export pattern, not transmittal-specific.

**Done when.**

- [ ] transmittals carries portal_expires_at and portal_revoked_at, and both GET and POST in app/api/transmittal/route.ts return a distinct 410 for each, as app/api/intake/resolve/route.ts:38-41 does
- [ ] the register exposes "revoke link" separately from "void transmittal", so access can be cut without repudiating the issue record
- [ ] portal_token is redacted (or replaced with a one-way digest) in lib/dataExport.ts output
- [ ] portal opens and downloads bump a last_used_at / open counter so the register can show whether the recipient ever collected the documents
- [ ] any expiry sweep rides /api/cron/maintenance — a third vercel.json cron entry fails deployment (app/api/cron/maintenance/route.ts:286-291)

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: `transmittals` had no expiry, revocation or use columns and the route refused only `voided`. Fixed:
- **Lifecycle columns (20261133).** `portal_expires_at`, `portal_revoked_at`, `portal_revoked_by`, `portal_last_used_at`, `portal_open_count`, `portal_download_count`. `trg_transmittals_guard` sets `portal_expires_at = issue + 90 days` on the issue transition (stated default, DEC-61), keeps it immutable after, and makes revocation durable: set once, on a live link of an issued transmittal, stamped with the database clock and `portal_revoked_by = auth.uid()`; it never clears or moves; only a transmit authority may set it (TRX-1).
- **The door.** `GET` and `POST /api/transmittal` answer distinct 410s — `voided`, `revoked`, `expired` (`portalRowRefusal` in `lib/transmittals.ts`, as `/api/intake/resolve` does), and never serve a non-issued row. The portal page renders each state ("The issuer has revoked this link. The transmittal itself still stands…").
- **Revoke ≠ void.** The register's new Revoke-link action (`revokeTransmittalLink`, checked, audited `TRANSMITTAL_LINK_REVOKED`) cuts access while the record stays issued; the void dialog now points at it.
- **Use tracking.** Every portal open and download calls `bump_transmittal_portal_use` (SECURITY DEFINER, pinned, service-role only; the trigger refuses a member writing the counters); the register shows "Portal opened N× · M downloads" / "Portal not opened yet" (only where the columns exist) and "Link until <date>" / "portal link revoked" / "expired" chips.
- **Export redaction.** Verified, not redone: `lib/exportTables.ts` `REDACT_COLUMNS.transmittals = ["portal_token"]` (P10 / EGR-7, DEC-45) and `scrubRestoredRow` lands a restored issued row voided; the new trigger keeps that path. Fix pass: `scrubRestoredRow` voids only a row that carries the `portal_token` key, so a row from a backup taken before 20260910 arrived `issued` and ran the full issue gate (re-dated, a fresh 90-day live link, or the whole restore aborted on a document the backup lists as withdrawn). The trigger now lands a service-role INSERT born `issued` VOIDED with the same `RESTORED_TRANSMITTAL_NOTE` sentence, keeping its recorded issue date, minting no token and skipping the gate (`dcRoundFTransmittalMigrations.test.ts` pins the note to `lib/dataRestore.ts`'s constant; scratch run: such an INSERT listing a Superseded document lands voided with the note and its 2025 issue date, no token).
- Tests: `transmittalPortalRoute.test.ts` ("TRX-4 — the link has its own lifecycle": distinct 410s on GET and POST, open bump + expiry in the snapshot); `dcRoundFTransmittals.test.ts` (`portalLinkState`, `portalRowRefusal`, revoke checked + audited, usage unknown on a pre-20261133 row); `dcRoundFTransmittalMigrations.test.ts` (columns, revocation rule, RPC grants). Scratch PostgreSQL 16 run: a member bumping the counter → refused; `authenticated` calling the RPC → 42501 permission denied; the service role's bumps → counters 1 / 1; a Viewer revoking → 42501; a Manager+DocCtrl (role collection) revoking → stamped with the db clock and the revoker; clearing it → refused.
- Pending migration: `20261132_dc_roundF_transmit_capability.sql` then `20261133_dc_roundF_transmittal_rails.sql` — hand-applied, in that order (DEC-30; 20261133 refuses to apply before 20261132 — its first statement raises and rolls the file back). Until they are applied only the app half of this resolution is in force.

**Done-when.**
- ✓ `portal_expires_at` and `portal_revoked_at` exist and both GET and POST return a distinct 410 for each.
- ✓ The register exposes "revoke link" separately from "void transmittal".
- ✓ `portal_token` is redacted in the export (verified: P10 / EGR-7, DEC-45 — not redone here).
- ✓ Portal opens and downloads bump `portal_last_used_at` and the open / download counters, shown on the register.
- ✓ No sweep was added — expiry is checked at the door on every request, so nothing periodic is needed (and no vercel.json entry).

**Scope / residual.** Links issued before 20261133 carry no expiry (counted by the migration's inventory) and keep serving until revoked or voided — retroactively expiring live contractual links on apply was not chosen (DEC-61). The SELECT policy still lets every active member read `portal_token`; the register now offers the copy button only to the creator and transmit authorities.

---

<a id="trx-5"></a>

## TRX-5 · The transmittal portal hands an external recipient the raw, unstamped master file via a presigned bucket URL — inverting the app's own uncontrolled-copy rule at the one point it matters most

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:66-82`, `lib/downloads.ts:4-8`, `lib/downloads.ts:230-280`, `app/api/share/file/route.ts:105-141`, `lib/stamping.ts:211`, `app/transmittal/[token]/page.tsx:54`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. An external recipient definitionally holds no checkout, so lib/downloads.ts:230-240 would give them the stamped copy through any in-app path; the portal is the one egress that inverts it. It also skips the distribution record — app/api/share/file/route.ts:129-141 writes a `download_audits` row, while the portal writes only an audit_logs entry (route.ts:77-82) and no download_audits row at all.

**Mechanism.** lib/downloads.ts states the app's copy-control rule in its header: "- User holds an active checkout on the document  -> CONTROLLED copy (raw PDF) / - Otherwise -> UNCONTROLLED copy (stamped)", and lib/stamping.ts:211 renders `UNCONTROLLED COPY • Downloaded: … • Do Not Distribute` plus a scan-to-verify QR on every such copy. The other anonymous external delivery path obeys this: app/api/share/file/route.ts:105-118 loads the PDF server-side and calls `applyStampToPdfDoc(pdfDoc, { watermarkText: "UNCONTROLLED — SHARED COPY", footerNotice: `${label} Rev ${rev ?? "?"} at time of download — scan the QR to confirm it is still current.`, verifyUrl: … })`, then streams bytes through the route — "never a raw bucket URL" (its own comment at :121-123). The transmittal portal does none of it. app/api/transmittal/route.ts:71-74 does `const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: file.key, ResponseContentDisposition: … }), { expiresIn: 300 })` and returns `{ url }`; the page opens it directly (`window.open(body.url, "_blank", "noopener")`, page.tsx:54). `grep -c "stamp|watermark|UNCONTROLLED" app/api/transmittal/route.ts` returns 0.

**Failure scenario.** Doc control issues TR-0042 "For Construction" to Acme Fabricators for P-200-001 Rev C. The contractor clicks Download in the portal and receives the byte-identical controlled master PDF — no UNCONTROLLED watermark, no "Rev C at time of download" footer, no verify QR. That file is printed in the shop and pinned to the wall. Six weeks later Rev D lands after an MOC; the paper on the wall carries no marking that says it is a copy, no date of issue, and nothing to scan. A welder builds to a superseded B31.3 spool detail. The identical drawing delivered through the /share link path would have carried all three markings.

**Evidence.**

```
lib/downloads.ts:4-8 — `//   - User holds an active checkout on the document  -> CONTROLLED copy (raw PDF)` / `//   - Otherwise                                       -> UNCONTROLLED copy (stamped)`. app/api/share/file/route.ts:107-116 — `await applyStampToPdfDoc(pdfDoc, { userLabel: "shared-link", … watermarkText: "UNCONTROLLED — SHARED COPY", footerNotice: …, verifyUrl: versionId && publicOrigin() ? `${publicOrigin()}/verify/${doc.id as string}?v=${versionId}` : undefined })`. app/api/transmittal/route.ts:71-74 — `const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: file.key, … }), { expiresIn: 300 });` then `:81 return NextResponse.json({ url });`
```

**Chain reaction.** The portal page tells the recipient (app/transmittal/[token]/page.tsx:154) "Files download exactly as issued on this transmittal — if a newer revision exists, it is NOT what this record covers" — a warning that exists only on the web page and is lost the moment the PDF is saved or printed. The stamp is the only part of that warning that travels with the file.

> **Verifier correction.** Downgrade CRITICAL→HIGH. The 'inverts the app's own uncontrolled-copy rule' framing is an interpretation, not a code contradiction: lib/downloads.ts's checkout rule is written for authenticated internal users, and a transmittal is arguably a *controlled* formal issue, so no line of code or comment states that transmittal deliveries must be stamped. What is confirmed and concrete is narrower but still serious: the one file that leaves the org to a party with no account carries no verify QR, no 'Rev X at time of download' footer, and is delivered as a raw 5-minute presigned bucket URL that the recipient can forward — contrary to the explicit rule the sibling external route writes down for itself.

**Done when.**

- [ ] /api/transmittal?file= streams the bytes through the route (as app/api/share/file does) instead of returning a presigned R2 URL
- [ ] every PDF served to a portal recipient carries the UNCONTROLLED watermark, the as-issued rev + transmittal number in the footer, and a publicOrigin()-based /verify QR bound to the exact version served
- [ ] non-stampable files (encrypted/corrupt/non-PDF) still go out through the route and the fallback is recorded, matching app/api/share/file/route.ts:121-124

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: the file branch returned a 300-second presigned R2 URL that the page opened directly — no stamp, no verify QR. `/api/transmittal?file=` now does what `/api/share/file` does for the same audience:
- The bytes are pulled bucket → server (`r2.send(GetObjectCommand)`) and streamed back as an attachment with `Cache-Control: no-store`; `getSignedUrl` is gone from the route (the presigned census tests now pin that the portal never signs).
- A PDF (magic bytes `%PDF`) is stamped with `applyStampToPdfDoc`: watermark `UNCONTROLLED — TRANSMITTAL COPY`, the userLabel `transmittal TR-nnnn`, a footer `<number> Rev <rev> as issued on transmittal TR-nnnn (<issue date>). Scan the QR to confirm it is still current.` and a verify QR `${publicOrigin()}/verify/<docId>?v=<the exact version served>` (when no public origin is configured the footer says to confirm the revision with the issuer, as the share route does).
- A non-PDF or unstampable file still goes out through the route with its own content type, and the distribution row records `source: "transmittal_portal_unstamped"`.
- **Size (fix pass).** The review found the first cut returned the whole (stamped) file as ONE buffered body from a 60-second function — the platform caps a buffered function response at ~4.5 MB (recorded in `app/api/admin/restore/begin/route.ts:5`), so a large drawing set the presigned link used to serve would fail, after its distribution row was written. Now the response is a STREAMED body handed out in 1 MiB chunks (`chunkedStream`), never one buffered body, and `maxDuration` is 300 s (the repo's budget for long transfers) so the function lives while the recipient drains it. A file up to 64 MiB (`PORTAL_STAMP_MAX_BYTES`) is held once in memory, verified, stamped (a PDF) and streamed. A larger one is never held whole: a first read hashes it chunk by chunk (TRX-8), and only when the digest matches is a second read — pinned to the verified object with `If-Match` on its ETag, so a replaced object is refused (412 → 502) rather than sent under the verified digest — piped straight through; it goes out unstamped (stamping needs the whole document in memory twice) and its distribution row says `transmittal_portal_unstamped`, with `unstampedReason: "oversize"` on the audit row (`not_pdf` / `stamp_failed` for the other two causes). The second read is opened BEFORE the record is written and released if the record is refused, so a failure records nothing. The response carries `X-Transmittal-Stamped`, and the portal page tells the recipient when a file arrived without the marking.
- The portal page saves the streamed blob (named from Content-Disposition) and maps the refusal codes (revoked / expired / unrecorded) to plain sentences; its copy now says each PDF is marked UNCONTROLLED with a verify QR.
- Tests: `transmittalPortalRoute.test.ts` ("TRX-5 / EGR-8 — streamed through the route and stamped, never a presigned URL": stamp options, headers, `%PDF` body; the non-PDF path; the source pins no `getSignedUrl`; fix pass, "size — a streamed body, never one buffered response …": a 5 MB file comes back whole as a stream read in ≥ 5 chunks with one read of the object; a PDF over the bound is hashed, re-read with `If-Match` on the ETag, piped unstamped and recorded with `unstampedReason: "oversize"`; a large mismatch is never re-read (409); an If-Match refusal or a missing ETag records nothing (502); a refused record releases the second read (503); source pins: no `new NextResponse(Buffer.from(`, `maxDuration = 300`). `presignedLifetime.test.ts` / `presignedDisposition.test.ts` updated: the portal is no longer a signing site.

**Done-when.**
- ✓ `/api/transmittal?file=` streams the bytes through the route.
- ◐ *(integration, 2026-10-01: the criterion says every PDF; beyond the 64 MiB bound the remainder is `TRX-15`)* Every PDF up to 64 MiB served to a portal recipient carries the UNCONTROLLED watermark, the as-issued rev + transmittal number in the footer and a `publicOrigin()`-based `/verify` QR bound to the exact version served. Stated bound (fix pass, DEC-61 §5): a PDF larger than that is delivered through the route verified but unstamped — the third done-when's recorded fallback, with its reason — rather than not delivered at all.
- ✓ Non-stampable files go out through the route and the fallback is recorded on the download row (and, since the fix pass, its reason on the audit row).

**Scope / residual.** Stamping uses the conventional placements (no `sourceBytes` ink analysis — no DOM on the server), exactly as `/api/share/file`. An explicit per-transmittal "send the unstamped original" flag was not added — no requirement for one is stated (EGR-8 dw3 is conditional). A file is delivered within the function's 300 s budget, so a very large file to a slow connection can still be cut off mid-transfer (its distribution row stands; the recipient retries); the presigned link had no such limit. That the platform does not apply its buffered-body cap to a streamed response is the platform's stated behaviour, confirmed here only by the test's chunked read — check one portal download over 4.5 MB on the deployment. `/api/share/file` still returns one buffered body (P1 SHARE's route, not edited here).

---

<a id="trx-6"></a>

## TRX-6 · The transmittals UPDATE and DELETE policies grant rights on `created_by = auth.uid()` with no active-membership test, so a removed member keeps write control over the transmittals they issued

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:46-56`, `supabase/migrations/20260910_transmittal_portal.sql:39-44`, `supabase/migrations/20260910_transmittal_portal.sql:33-37`, `supabase/migrations/20260814_documents_delete_controllers.sql:31-40`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence: grep across supabase/migrations shows no other UPDATE policy or BEFORE UPDATE trigger on transmittals, so nothing re-adds the check. Note the deactivated member loses SELECT (the read policy does test status) but PostgREST UPDATE/DELETE by id needs only the UPDATE/DELETE USING clause, so blind writes on a known id still land — and no session-revocation-on-deactivation path exists in the repo.

**Mechanism.** The INSERT policy correctly conjoins ownership with active membership: `created_by = auth.uid() AND EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id AND uid = auth.uid() AND status = 'active')` (20260910:41-43). The UPDATE and DELETE policies drop the second half: `USING (is_org_controller(org_id) OR created_by = auth.uid())` (20260910:47-48, 54-56). `is_org_controller` does check `status = 'active'` (20260814:33-39), but the `created_by` disjunct checks nothing — not membership, not status, not even that the caller still belongs to the org. org_members is a separate table from Supabase auth, so deactivating or removing a member leaves their auth user and JWT intact. The UPDATE policy also places no constraint on which columns may change, so `items`, `recipient_email`, `status`, `portal_token`, `acknowledged_by_name` and `acknowledged_at` are all writable by that same disjunct — and there is no status predicate, so an issued or acknowledged row is as writable as a draft.

**Failure scenario.** An engineer is terminated and their org_members row is set to status = 'inactive'. Their Supabase session is still valid. They call `PATCH /rest/v1/transmittals?id=eq.<uuid>` on a transmittal they issued and rewrite `items` to a different document/rev set, or set `acknowledged_at` and `acknowledged_by_name` to fabricate a receipt, or mint a fresh `portal_token` and hand it to an outside party. RLS permits every one of these: created_by is still them.

**Evidence.**

```
supabase/migrations/20260910_transmittal_portal.sql:41-43 (INSERT) — `  created_by = auth.uid()` / `  AND EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id` / `              AND uid = auth.uid() AND status = 'active')`. Compare :47-51 (UPDATE) — `FOR UPDATE USING (` / `  is_org_controller(org_id) OR created_by = auth.uid()` / `) WITH CHECK (` / `  is_org_controller(org_id) OR created_by = auth.uid()` / `);`
```

**Chain reaction.** Because the UPDATE policy allows rewriting `items` on an already-issued row, the JSONB snapshot the whole design rests on ("the record stays truthful even after the documents rev forward", lib/transmittals.ts:8-10) is not immutable at the database — the app's `.eq("status", "draft")` guard in updateTransmittalDraft (lib/transmittals.ts:546) is the only thing holding it.

> **Verifier correction.** Reweight which half carries the severity. The removed-member half needs a still-valid session and overlaps the already-audited roles & permissions area (see audit-reports/roles-and-permissions/09-non-document-surfaces.md:441-460, which establishes the same inactive-member pattern for transmittals delete via project roles). The half that stands alone and needs no offboarding at all is the column and status freedom: the WITH CHECK repeats the USING expression unchanged, so a creator in good standing can UPDATE `items`, `recipient_email`, `status`, `portal_token`, `acknowledged_at` and `acknowledged_by_name` on an already-*acknowledged* row — i.e. forge or rewrite a receipt on a contractual record — through a direct PostgREST call. Lead with that.

**Done when.**

- [ ] both the UPDATE and DELETE `created_by` disjuncts require an active org_members row for transmittals.org_id, matching the INSERT policy
- [ ] the UPDATE policy (or a trigger) prevents mutation of items/seq/number/issued_at/portal_token once status leaves 'draft'
- [ ] acknowledged_at / acknowledged_by_name / acknowledged_via are writable only by the service-role portal route, not by any member session

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced from 20260910: the UPDATE / DELETE `created_by` arms tested nothing, and the UPDATE WITH CHECK repeated USING, so a creator in good standing could rewrite `items` or forge `acknowledged_*` on an acknowledged row. Fixed in `20261133`:
- **Active membership.** `transmittals_update` and `transmittals_delete` now require an active `org_members` row of the transmittal's org on the `created_by` arm (matching INSERT).
- **The issued record is frozen** (`trg_transmittals_guard`, every caller): workspace, seq, number and author never change; once the status leaves `draft`, `items`, the recipient fields, purpose, subject, notes, issue time, portal token and expiry cannot change; unlinking from a project is allowed only as the FK's own ON DELETE SET NULL (one trigger level down) or by the service role.
- **The receipt is written once, server-side.** `acknowledged_at` / `_by_name` / `_via` / `_meta` change only on issued → acknowledged and never from a member session; afterwards they are immutable for everyone. The two legitimate writers are service-role routes: the recipient portal (`POST /api/transmittal`, unchanged contract, now a checked write) and the new `POST /api/transmittal/receipt` — a transmit authority (TRX-1) records a receipt on the recipient's behalf and the route writes `acknowledged_via: "manual"` with `acknowledged_meta.recordedBy` / `recordedByEmail` (so a typed-in receipt never reads like the recipient's own). `acknowledgeTransmittal` now calls that route.
- Tests: `dcRoundFTransmittals.test.ts` ("TRX-6 — a register receipt goes through the server…": the lib never writes the row; a Viewer 403s; a DocCtrl's receipt carries the recorder and is a checked write; an unreadable policy fails closed 503); `transmittalPortalRoute.test.ts` (portal receipt evidence + checked write); `dcRoundFTransmittalMigrations.test.ts` (identity, lifecycle, frozen columns, receipt rule, UPDATE policy). Scratch PostgreSQL 16 run: a removed member's UPDATE / DELETE of their old draft → 0 rows; the creator rewriting `items` on the issued row → 23514; a DocCtrl rewriting the recipient → 23514; the creator and a DocCtrl forging a receipt from a session → 23514; the service role's portal receipt → ok; rewriting it after → 23514; a DocCtrl re-linking the issued row to another project → 23514; deleting the project (FK SET NULL as a member) → passes.
- Pending migration: `20261132_dc_roundF_transmit_capability.sql` then `20261133_dc_roundF_transmittal_rails.sql` — hand-applied, in that order (DEC-30; 20261133 refuses to apply before 20261132 — its first statement raises and rolls the file back). Until they are applied only the app half of this resolution is in force.

**Done-when.**
- ✓ Both the UPDATE and DELETE `created_by` arms require an active `org_members` row for the transmittal's org.
- ✓ The trigger prevents mutation of items / seq / number / issued_at / portal_token (and the rest of the record) once status leaves `draft`.
- ✓ `acknowledged_at` / `acknowledged_by_name` / `acknowledged_via` are writable only by service-role routes — the portal route and the receipt route (which checks transmit authority and names the recorder) — never by a member session.

**Scope / residual.** None. The migration's inventory counts the issued and draft rows whose creator is no longer active (they lose update rights; nothing is rewritten).

---

<a id="trx-7"></a>

## TRX-7 · issueTransmittal writes a TRANSMITTAL_ISSUED audit entry even when the UPDATE matched zero rows, and no other transmittal mutation checks its outcome — RLS-blocked and status-mismatched writes all read as success

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:550-583`, `lib/transmittals.ts:528-540`, `lib/transmittals.ts:586-611`, `lib/transmittals.ts:614-631`, `lib/transmittals.ts:634-637`, `app/(protected)/transmittals/page.tsx:136-179`, `app/(protected)/transmittals/page.tsx:280-289`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is exactly as described — RLS rejections return zero rows with no error under PostgREST, so every one of these reads as success. Downgraded to MEDIUM because the register self-corrects: both handlers call `await refresh()` after the toast (app/(protected)/transmittals/page.tsx:143-145 and :164-166), which re-reads from the database, so the false state is a transient toast rather than a persistent wrong register. The durable damage is a fabricated ISSUED/ACKNOWLEDGED entry in the compliance audit log with no corresponding state change.

**Mechanism.** issueTransmittal does `.update({ status: "issued", … }).eq("id", id).eq("status", "draft").select("*").maybeSingle()`, then guards the email with `if (data)` (:578) — but the audit write at :581-590 sits outside that guard and fires unconditionally, with `details: data ? {…} : undefined`. supabase-js resolves with `{ error: null }` for a zero-row UPDATE, so a row blocked by transmittals_update (a non-creator, non-controller pressing the button) or already past draft produces `data === null, error === null`: no email, no state change, and a TRANSMITTAL_ISSUED row in audit_logs regardless. The sibling functions never even ask: updateTransmittalDraft (:546), acknowledgeTransmittal (:596-600), voidTransmittal (:624-628) and deleteTransmittal (:643) all destructure only `{ error }` with no `.select()`, no `count: 'exact'`, and no rows-affected test. The register calls each inside a try/catch and shows a success toast on the absence of a thrown error — e.g. `await acknowledgeTransmittal(t.id, name, actor); showToast({ type: "success", title: "Receipt recorded", … })` (page.tsx:141-142). The Receipt and Void buttons are rendered for every issued row (page.tsx:280-289) with no role condition, so a non-creator Viewer is routinely routed into exactly this silent no-op.

**Failure scenario.** A Viewer sees TR-0042 in the register, clicks Receipt, and types the recipient's name. RLS rejects the UPDATE (they are neither creator nor controller); supabase returns zero rows and no error; acknowledgeTransmittal writes a TRANSMITTAL_ACKNOWLEDGED audit row anyway (:609-618) and returns; the toast says "Receipt recorded — TR-0042 marked acknowledged." The register still shows Issued after refresh, but the audit trail now contains an acknowledgment that never happened. The same shape lets a failed Issue produce a TRANSMITTAL_ISSUED audit entry for a transmittal that is still a draft.

**Evidence.**

```
lib/transmittals.ts:570-582 — `  if (data) {` / `    await sendTransmittalEmail(rowToTransmittal(data as Record<string, unknown>), actor);` / `  }` / `  await logAuditAction({` / `    action: "TRANSMITTAL_ISSUED",` — the audit call is outside the `if (data)` block. lib/transmittals.ts:588-592 — `let { error } = await supabase` / `  .from("transmittals")` / `  .update({ status: "acknowledged", … })` / `  .eq("id", id)` / `  .eq("status", "issued");` — outcome never inspected.
```

**Chain reaction.** This is the same unchecked-write shape the earlier audits found in the audit logger and six client-side ticket writes; here it lands on the audit trail itself, so the record of what was issued and acknowledged can diverge from the register it is supposed to evidence.

**Done when.**

- [ ] every transmittal mutation uses `.select("id")` (or `count: 'exact'`) and throws when zero rows changed
- [ ] the audit write in issueTransmittal moves inside the `if (data)` guard, and the acknowledge/void/delete audits are likewise conditional on a confirmed row change
- [ ] the register's Receipt / Void / Edit / Delete controls are shown only when the current user could actually perform them (creator or controller)

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: `issueTransmittal` logged `TRANSMITTAL_ISSUED` outside its `if (data)` guard and the siblings destructured only `{ error }`. Every mutation in `lib/transmittals.ts` is now checked:
- `updateTransmittalDraft`, `voidTransmittal`, `revokeTransmittalLink` and `deleteTransmittal` add `.select("id")` and throw a sentence when zero rows changed; `issueTransmittal` throws when the UPDATE returned no row ("was not issued — it is no longer a draft, or you do not hold transmit authority…").
- The audit rows (`TRANSMITTAL_ISSUED` / `_VOIDED` / `_LINK_REVOKED`) are written only after a confirmed change, and a refused audit row is surfaced (`auditError`) and toasted rather than swallowed; the manual receipt's audit row is written by the receipt route after its checked write (409 on zero rows).
- The register shows Edit to the draft's author, a controller or a transmit authority (the UPDATE policy's arms), and Receipt / Revoke / Void only to a transmit authority (`mayTransmit` over the items' libraries). Delete — corrected in the fix pass: the first cut drew it from the permissive policy alone (author or controller), but the RESTRICTIVE `transmittals_delete_guard` (20260818, unchanged) also requires an Admin / Manager, the author, or someone who manages the draft's project, so a DocCtrl who is neither was shown Delete and refused. `mayDeleteDraft` in `lib/transmittals.ts` now draws it from both policies together — the author; otherwise a controller who is also an Admin / Manager (`DRAFT_DELETE_GUARD_ROLES`, the mirror of `is_org_admin_or_manager`) or who manages the draft's project (the page reads the projects the controller owns or is an owner / collaborator on — `can_manage_project`'s other arms) — and `deleteTransmittal`'s refusal names that rule instead of "only its author or a Document Controller can delete it".
- Tests: `dcRoundFTransmittals.test.ts` ("TRX-7 / TRX-10 — every mutation is checked…": a zero-row issue throws with NO audit row; the four sibling mutations throw on zero rows and audit only on change; the refused audit surfaces; page pins for the gated controls; fix pass: the `mayDeleteDraft` truth table — author yes, DocCtrl alone no, DocCtrl managing the project yes, Admin yes, Manager+DocCtrl yes, Manager alone no, never an issued row — the page draws Delete from it, and the refusal text). Mutation-checked: re-allowing the zero-row issue to proceed fails the suite. Fix pass scratch run: a DocCtrl (not Admin / Manager) deleting an engineer's draft → `DELETE 0`; a DocCtrl collaborator on the draft's project → `DELETE 1`; an Admin → `DELETE 1`; the author → `DELETE 1`.

**Done-when.**
- ✓ Every transmittal mutation uses `.select(...)` and throws when zero rows changed.
- ✓ The issue audit is inside the confirmed-change path, and the acknowledge / void / delete / revoke audits are likewise conditional on a confirmed row change (delete writes none, as before).
- ✓ Receipt / Void / Edit / Delete are shown only to who can perform them: Edit to the author, a controller or a transmit authority; Delete to who BOTH delete policies admit (the author, or a controller who is also Admin / Manager or manages the draft's project — corrected in the fix pass; the first cut showed it to every controller); Receipt / Revoke / Void to a transmit authority.

**Scope / residual.** `createTransmittal` keeps its single `TRANSMITTAL_CREATED` row after a confirmed insert (it always read the inserted row back). *Integration (2026-10-01, at the P7 merge):* done-when 3 holds for everyone except one case — Revoke and Void are drawn from `mayTransmit` over the items' libraries, while the UPDATE policy's capability arm reads `org_capability_allows(org, 'transmittal.issue', uid)` on the base list only; a member admitted to transmit authority only by a library-scoped rule, who is neither the creator nor a controller, is shown both buttons and gets the checked zero-row refusal ("nothing was changed"), never a silent success. The same base-list limit is `TRX-1`'s residual for issuing. Also: the fix pass rewrote `components/documents/InspectorPanel.tsx`'s distribution-pill effect and summary beside its `TransmittalTrail` (outside the brief's limb; no other package owns that block).

---

<a id="trx-8"></a>

## TRX-8 · A transmittal records no content hash — the "point-in-time SNAPSHOT" is a set of mutable references, unlike every other binding artifact in the app

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:34-40`, `lib/transmittals.ts:8-10`, `supabase/migrations/20260717_transmittals.sql:10-14`, `supabase/migrations/20260526_document_version_control.sql:41`, `supabase/migrations/20260720_e_signatures.sql:8`, `supabase/migrations/20260720_e_signatures.sql:23`, `supabase/migrations/20260817_read_understood.sql:39`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The 'point-in-time SNAPSHOT' framing in the header comment (lib/transmittals.ts:8-10, echoed at 20260717_transmittals.sql:10-14) denormalizes number/title/rev but not bytes. Partially mitigated — `versionId` is usually pinned and document_versions.file_hash may recover the hash — but it is optional in the type, the portal falls back to matching on `revision_label` alone when it is absent (app/api/transmittal/route.ts:47-54), and versions created through the intake route are inserted with no file_hash at all (app/api/intake/upload/route.ts:304-316). MEDIUM is the right level.

**Mechanism.** `interface TransmittalItem { documentId; number; title?; rev?; versionId? }` (lib/transmittals.ts:34-40) and the migration's item contract `{ documentId, number, title, rev, versionId? }` (20260717:14) carry no hash. The bytes are hashed and stored everywhere else: `ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS file_hash TEXT` (20260526:41), populated by lib/revisions.ts:378, :525, :894 and lib/documentLifecycle/common.ts:212. Both other binding artifacts pin to it: e_signatures "The content_hash binds the signature to the exact file/" (20260720:8) with `content_hash TEXT` (:23), and read-and-understood records `content_hash TEXT, -- the file_hash of that version, for audit binding` (20260817:39). The transmittal — the contractual "we sent you P-101 Rev C for construction on this date" artifact — is the one that pins to nothing but a UUID and a text label.

**Failure scenario.** A dispute arises over whether the spool detail Acme built was the one issued on TR-0042. The transmittal says P-200-001 Rev C, versionId v-123. The org can prove a row named v-123 exists and points at an R2 key; it cannot prove the bytes behind that key are the bytes that were delivered, because nothing recorded a digest at issue time and no download record captured one at delivery time. The file_hash needed for the proof was already computed and sitting on the version row when the transmittal was written.

**Evidence.**

```
lib/transmittals.ts:8-10 — `// A transmittal is a point-in-time SNAPSHOT: each item denormalizes the` / `// document number/title/rev as-sent, so the record stays truthful even after` / `// the documents rev forward (or get deleted).` versus lib/transmittals.ts:34-40 — the TransmittalItem interface, which has no hash field. supabase/migrations/20260720_e_signatures.sql:8 — `-- name to confirm. The content_hash binds the signature to the exact file/`
```

**Chain reaction.** Combined with the label-match fallback in fileKeyForItem, there is no layer at which a substituted file could be caught: not at resolution (no hash to compare), not at delivery (no download_audits row), and not at the record (no hash stored).

> **Verifier correction.** Downgrade HIGH→MEDIUM and drop the 'pins to nothing but a UUID and a text label' line — it is misleading. `item.versionId` is a document_versions primary key, and that row *does* carry file_hash (20260526:41), so a pinned item binds to the bytes transitively; e_signatures does the same thing via its own `document_version_id` column alongside content_hash. The real, narrower gap is that (a) versionId is optional in the interface, so an unpinned item binds to nothing, and (b) the hash is not denormalized onto the snapshot, so the binding breaks if the version row's file_url is repointed or the row is deleted — which is precisely the deletion case the header comment at :8-10 says the denormalization exists to survive.

**Done when.**

- [ ] each item captures the version's file_hash (and file size) at compose/issue time
- [ ] the portal verifies the resolved object's digest against the stored hash before signing a URL, and refuses with a clear message on mismatch
- [ ] the cover sheet and evidence pack print a short hash prefix per document so the paper record is self-verifying

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: `TransmittalItem` had no hash and the portal compared nothing. Fixed:
- **Capture.** On the issue transition `trg_transmittals_guard` (20261133) pins every item to a version of its own document and writes that version's `file_hash` onto the item as `fileHash` — by the database, not the browser — and (fix pass) its `size` as `fileSize`. `TransmittalItem` gains `fileHash` / `fileSize` / `statusAsSent` / `effectiveDate`; `rowToTransmittal` maps them.
- **Verify.** The portal file branch computes the SHA-256 of the bytes it fetched and compares it (case-insensitively) with the item's `fileHash` — or, for an item issued before 20261133, the resolved version row's `file_hash`; a mismatch releases nothing (409 "no longer matches the one recorded when the transmittal was issued"), writes no download row, and records `TRANSMITTAL_PORTAL_INTEGRITY_REFUSED`. Every served download's audit row carries `servedSha256` and `hashVerified`, so the delivery records what left.
- **Paper.** The cover sheet prints a 12-character SHA-256 prefix per document and, beneath it, the file's size (`fileSizeLabel`, e.g. "2.4 MB"; footer: "Each SHA-256 prefix (and size) identifies the exact file issued."); the project evidence pack prints `#<prefix> <size>` per document; the portal shows the fingerprint and the size.
- Tests: `transmittalPortalRoute.test.ts` ("TRX-8 — the bytes served are the bytes issued": match serves with digest, mismatch 409 with no record, legacy item verified against the version row; fix pass: the snapshot payload carries `fileSize`, and a large file is verified chunk by chunk before anything is sent); `dcRoundFTransmittals.test.ts` (`hashPrefix`, `fileSizeLabel`, `fileSize` mapped, sheet and evidence-pack renders with the size); `dcRoundFTransmittalMigrations.test.ts` (the snapshot write, `'fileSize', v_size`). Scratch PostgreSQL 16 run: an issued row's items carry the version's `fileHash` and (fix pass) its `fileSize` (12345 → 12345).
- Pending migration: `20261132_dc_roundF_transmit_capability.sql` then `20261133_dc_roundF_transmittal_rails.sql` — hand-applied, in that order (DEC-30; 20261133 refuses to apply before 20261132 — its first statement raises and rolls the file back). Until they are applied only the app half of this resolution is in force.

**Done-when.**
- ✓ Each item captures the version's `file_hash` and file size at issue. Corrected in the fix pass: the first write-up said `document_versions` holds no size column — false (`supabase/schema.sql:366` `size BIGINT`, written on every version insert by `lib/revisions.ts:376` and `lib/documentLifecycle/common.ts:230`); the trigger now copies it as `fileSize`.
- ✓ The portal verifies the resolved object's digest against the stored hash before releasing it, and refuses with a clear message on mismatch.
- ✓ The cover sheet and the evidence pack print a short hash prefix per document.

**Scope / residual.** A version with no `file_hash` (rows written before hashing existed) is served unverified, and its audit row says `hashVerified: false`.

---

<a id="trx-9"></a>

## TRX-9 · External portal downloads are invisible to stale-copy recall — no download_audits row is written, and the per-document transmittal trail swallows every query error

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:75-80`, `app/api/share/file/route.ts:129-141`, `lib/staleCopies.ts:1-14`, `lib/staleCopies.ts:38-46`, `lib/transmittals.ts:388-398`, `components/documents/InspectorPanel.tsx:1036-1078`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on all three legs: the portal download is audited only to audit_logs, the recall panel (components/documents/DistributionRecall.tsx:39 → getDocumentRecall) is download_audits-only, and the compensating TransmittalTrail returns [] on any query error and then renders nothing. The trail (InspectorPanel.tsx:1076-1080 'HOLDS SUPERSEDED REV') is a real partial mitigation for external holders, which is why MEDIUM rather than higher is right.

**Mechanism.** lib/staleCopies.ts is the recall register: "Every download is already recorded with the exact version it delivered (download_audits). Joining that against documents.current_version_id answers … 'who is still holding an outdated copy of THIS drawing'". Every other download path writes that row — lib/downloads.ts:132-143, lib/docPack.ts:114, and crucially the anonymous share path at app/api/share/file/route.ts:130-140, which attributes an outsider's download to the sharer (`user_id: (share.created_by as string | null) ?? null, // attributed to the sharer — the outsider has no account`) and stamps `version_id` and `source: "share_link"`. The transmittal portal writes only an `audit_logs` row (route.ts:75-80) that carries `documentId`, `docNumber` and `rev` — a text label, not `version_id` — and nothing in download_audits. Separately, the only per-document "who received this?" query fails closed: lib/transmittals.ts:404 is `if (error) { if (isMissingTable(error)) return []; return []; }`, so any error (RLS, network, malformed containment filter) renders as "no transmittals" in the Inspector's TransmittalTrail.

**Failure scenario.** P-200-001 revs C→D. A controller opens the Inspector's recall panel to answer "who is holding the old copy?" — `getDocumentRecall` reads download_audits and lists three internal engineers. Acme Fabricators, who pulled Rev C through the transmittal portal and are the party actually building from it, do not appear: no download_audits row exists for them. If the transmittal-trail query also errors, the TransmittalTrail pill reports zero transmittals and the controller concludes the drawing was never issued externally at all.

**Evidence.**

```
lib/staleCopies.ts:4-8 — `// Every download is already recorded with the exact version it delivered` / `// (download_audits). Joining that against documents.current_version_id`. app/api/transmittal/route.ts:75-80 — `await supabaseAdmin.from("audit_logs").insert({ action: "TRANSMITTAL_PORTAL_DOWNLOAD", … details: { number: t.number, documentId: fileDoc, docNumber: item.number, rev: item.rev } }).then(() => undefined, () => undefined);` — no download_audits, no version_id. lib/transmittals.ts:404 — `if (error) { if (isMissingTable(error)) return []; return []; }`
```

**Chain reaction.** Because the fileKeyForItem resolution (route.ts:39-55) is the only place that knows which version_id was actually served, the version identity is discarded at exactly the moment it could have been recorded, so no later backfill can reconstruct which revision the contractor holds.

> **Verifier correction.** Downgrade HIGH→MEDIUM. The finding overstates 'invisible': a TRANSMITTAL_PORTAL_DOWNLOAD row IS written to audit_logs and is rendered/exported by the admin audit UI (app/(protected)/admin/audit/page.tsx:407-413, :450). More importantly, the recall question this finding says is unanswerable is in fact answered by two other paths that do not use download_audits at all: the register recomputes staleness by diffing each item's as-sent rev against documents.rev (page.tsx:82-89, chip at :238-242 'superseded rev in circulation'), and InspectorPanel's TransmittalTrail flags 'HOLDS SUPERSEDED REV' per recipient (:1065-1078). What survives is that the transmittal download is absent from the *download_audits* register specifically (so it never carries a version_id, unlike the share path), and that the fail-closed `return []` at transmittals.ts:404 silently renders those mitigating panels empty on any RLS or network error.

**Done when.**

- [ ] the portal file branch writes a download_audits row with org_id, document_id, the resolved version_id, and a distinguishing `source` (e.g. "transmittal_portal"), mirroring app/api/share/file/route.ts:130-140
- [ ] getDocumentRecall / listMyStaleCopies surface external transmittal holders alongside internal ones
- [ ] listTransmittalsForDocument distinguishes "none" from "query failed" and the Inspector renders the failure instead of an empty trail

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: the portal wrote only `audit_logs`, and `listTransmittalsForDocument` returned `[]` on every error. Fixed:
- **The record.** The portal file branch writes one `download_audits` row per pull BEFORE the bytes leave — `org_id`, `document_id`, the resolved `version_id`, `user_id: NULL`, `transmittal_id`, `user_email` = the recipient's address, `source: "transmittal_portal"` (or `_unstamped`) — the DEC-44 §1 shape 20261068 added. A refused write refuses the download (503 `unrecorded`); a refusal that IS the unapplied 20261068 is retried once in the older shape attributed to the issuer, logged as the deploy order (the `/api/share/file` degrade).
- **Recall.** `getDocumentRecall` (P2, `lib/staleCopies.ts`) already keys such rows `transmittal:<id>` and flags them external — verified, not edited; external holders now appear alongside internal ones because the rows exist.
- **The trail.** `listTransmittalsForDocument` throws on a real error (only a missing table answers "none"); the Inspector's `TransmittalTrail` renders "Transmitted on — couldn't check … it is not 'never transmitted'" instead of nothing. Fix pass: the Inspector's distribution pill read the transmittals and the two `distribution_acks` counts in one `try`, so the now-throwing read also hid the read-and-understood counts; the transmittal read is caught on its own, the issued count becomes unknown (`? issued`, with a tooltip) and the acks counts still show (`dcRoundFTransmittals.test.ts` pins it).
- Tests: `transmittalPortalRoute.test.ts` ("TRX-9 — the distribution record is written before the bytes leave": the row's shape and ordering after the stamp, 503 on a refused write, the pre-20261068 retry); `dcRoundFTransmittals.test.ts` ("TRX-9 — the transmittal trail says when it could not be read"). The recall reader's handling of `transmittal_id` rows is pinned by `downloadAudits.test.ts`. Mutation-checked: letting a refused record write through fails the suite.

**Done-when.**
- ✓ The portal file branch writes a `download_audits` row with org, document, the resolved version, `source: "transmittal_portal"` and the transmittal, mirroring `/api/share/file`.
- ✓ `getDocumentRecall` surfaces external transmittal holders alongside internal ones (P2's reader, now fed). `listMyStaleCopies` is a member's own list — an outside recipient has no account to list it on — so nothing applies there.
- ✓ `listTransmittalsForDocument` distinguishes "none" from "query failed" and the Inspector renders the failure.

**Scope / residual.** None in this package; download_audits retention is the RET-* owner's.

---

<a id="trx-10"></a>

## TRX-10 · Issuing an existing draft prints a cover sheet with no portal link or QR, and the success toast asserts the email was sent regardless of whether it was

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/transmittals/page.tsx:417-429`, `app/(protected)/transmittals/page.tsx:304-315`, `lib/transmittals.ts:301-315`, `lib/transmittals.ts:188-196`, `lib/transmittals.ts:275-307`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves check out. The freshly-issued row does get its token in the DB (issueTransmittal line 562), so the list's own 'Cover sheet' button prints correctly afterwards — but the sheet auto-opened at issue time, the one that goes in the project file, has no QR and no URL.

**Mechanism.** On the edit-then-issue path the composer calls `await issueTransmittal(editing.id, actor)` — which mints the portal_token server-side and never returns it to the caller (it returns `void`) — then hands onSaved a locally synthesized object: `{ ...editing, ...fields, status: "issued", issuedAt: new Date().toISOString() }` (page.tsx:425). `editing` was loaded while the row was a draft, so `editing.portalToken` is null and stays null. onSaved then calls `openTransmittalSheet(t)` (page.tsx:307), whose portal block is gated on `if (t.portalToken && t.status !== "voided")` (lib/transmittals.ts:315) — so the printed sheet silently omits the entire "Recipient portal — download & acknowledge online" panel and QR (lib/transmittals.ts:188-196). The create-and-issue-now path does receive the token (createTransmittal returns the inserted row) and prints correctly, so the same button produces two different cover sheets depending on whether the transmittal was drafted first. Separately, the toast at page.tsx:312 is unconditional on delivery: it renders "portal link emailed to {recipientEmail}" whenever an email address is present, while sendTransmittalEmail returns false silently when there is no portal token (pre-20260910 database, lib/transmittals.ts:277) and swallows queue failures with `console.warn` and `return false` (:303-306) — a boolean neither caller inspects.

**Failure scenario.** A controller drafts TR-0042 on Monday, edits it Friday and clicks Issue. The toast says "TR-0042 issued — portal link emailed to jane@buildco.com and cover sheet opened." The cover sheet opens and is printed for the project file — with no QR and no portal URL, so the paper record of a portal-enabled transmittal carries no way to reach the portal. On a database where 20260910 has not been applied, the same toast fires while no email was queued at all and no portal exists.

**Evidence.**

```
app/(protected)/transmittals/page.tsx:425 — `await onSaved(issue, issue ? { ...editing, ...fields, status: "issued", issuedAt: new Date().toISOString() } : { ...editing, ...fields });`. lib/transmittals.ts:315 — `if (t.portalToken && t.status !== "voided") {`. lib/transmittals.ts:277 — `if (!to || !t.portalToken || t.status === "voided") return false;`
```

**Chain reaction.** Because the printed sheet is the artifact that survives, the omission is invisible on screen — the register's own "Portal link" button (page.tsx:258-269) works fine after the next refresh, so nobody notices the printed copy is the deficient one.

**Done when.**

- [ ] issueTransmittal returns the updated Transmittal (it already selects the row) and the composer passes that, not a synthesized object, to onSaved/openTransmittalSheet
- [ ] the toast reports the actual result of sendTransmittalEmail rather than inferring it from the presence of a recipient email
- [ ] when the portal token is absent (pre-migration) the issue flow says so explicitly instead of silently issuing without a portal

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: the edit-then-issue path printed the sheet from `{ ...editing, status: "issued" }` (no token) and the toast inferred delivery from the address. Fixed:
- `issueTransmittal` returns an `IssueOutcome` — `transmittal` (the row the database wrote: token, snapshot, expiry), `email` (`{ sent, reason }` from `sendTransmittalEmail`, which now returns why it did not send), `portal: "ready" | "missing"`, `auditError`. Both composer paths (new and edited drafts) go create/update → `issueTransmittal`, and `onSaved` prints `openTransmittalSheet(result.outcome.transmittal)`.
- The toast (`issueToast`) reports the actual email result ("the email was NOT sent (<reason>) — copy the portal link instead"), says explicitly when the transmittal was issued WITHOUT a portal (a pre-20260910 database), warns when NEXT_PUBLIC_SITE_URL is unset (TRX-14), and names a refused audit row; it is a warning, not a success, whenever any of those holds. An issue that fails after the draft was saved says "Saved as a draft — not issued: <reason>".
- Tests: `dcRoundFTransmittals.test.ts` (a confirmed issue returns the DB row and the email's real outcome; a token-less row reports `portal: missing` and attempts no email; the page prints from the outcome and the old synthesized object / inferred toast are gone; `sendTransmittalEmail` reasons).

**Done-when.**
- ✓ `issueTransmittal` returns the updated Transmittal and the composer passes it to `onSaved` / `openTransmittalSheet`.
- ✓ The toast reports the actual result of `sendTransmittalEmail`.
- ✓ When the portal token is absent the issue flow says so explicitly.

**Scope / residual.** None.

---

<a id="trx-11"></a>

## TRX-11 · The portal resolves an item's file with no tenancy check — items JSONB is member-writable and supabaseAdmin bypasses RLS on a single shared R2 bucket

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:39-55`, `app/api/transmittal/route.ts:13`, `lib/r2.ts:20`, `supabase/migrations/20260910_transmittal_portal.sql:40-44`, `app/api/transmittal/route.ts:5-6`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. No tenancy check exists anywhere on the resolution path — the only gate is `items.find(i => i.documentId === fileDoc)` (line 67), whose contents the attacker authored. Practical exploitation needs a version UUID from the other org, which is the only thing keeping this at MEDIUM rather than higher.

**Mechanism.** Both branches of fileKeyForItem query with the service-role client and no org predicate: `.from("document_versions").select("file_url, revision_label").eq("id", item.versionId).maybeSingle()` (route.ts:41-43) and `.eq("record_id", item.documentId).eq("revision_label", item.rev)` (route.ts:47-49). Neither joins to `transmittals.org_id`. `supabaseAdmin` (imported at :13) bypasses RLS by construction, and R2 is one bucket for the whole platform — `export const R2_BUCKET = process.env.R2_BUCKET_NAME!` (lib/r2.ts:20) with org-scoped key prefixes only. `items` is unconstrained JSONB: the INSERT policy (20260910:40-44) validates `created_by` and membership and says nothing about items' contents, and the UPDATE policy validates neither. So the only barrier between an attacker-supplied `versionId`/`documentId` in items and a signed URL for another tenant's file is knowing a UUID. The route's own header asserts the opposite guarantee: "the recipient … sees ONLY this one transmittal, can download ONLY the files listed on it … nothing else in the org is reachable."

**Failure scenario.** An active member of org A crafts a transmittal whose items array contains `{ documentId: "<uuid>", number: "x", rev: "A", versionId: "<a version uuid from org B>" }`, issues it (RLS permits — they are created_by), opens their own portal link, and clicks Download. The route matches the item by documentId, resolves file_url from org B's version row with no org check, and returns a presigned URL to org B's drawing. The membership check that RLS would have applied never runs because the query is made with the service-role client.

**Evidence.**

```
app/api/transmittal/route.ts:5-6 — `// transmittal, can download ONLY the files listed on it (at their as-sent` / `// revisions), and can acknowledge receipt once. Voided transmittals` … `// answer with their state; nothing else in the org is reachable.` versus :41-43 — `const { data: v } = await supabaseAdmin` / `  .from("document_versions").select("file_url, revision_label")` / `  .eq("id", item.versionId).maybeSingle();` — no `.eq("org_id", t.org_id)`.
```

**Chain reaction.** The same missing predicate means a legitimate transmittal whose items were composed against a document later moved or re-keyed will silently resolve to whatever row now holds that id, rather than failing.

> **Verifier correction.** Downgrade HIGH→MEDIUM. The finding's own sentence 'the only barrier … is knowing a UUID' is the reason: exploitation requires an active org member who already can create a transmittal to *also* possess a foreign tenant's document_versions id (or documents id plus its exact revision_label). Those are random v4 UUIDs, not enumerable, and this lens found no path that discloses them cross-org. This is a confirmed defense-in-depth failure — a service-role query with no tenancy predicate, which is exactly how a UUID disclosed by some future bug becomes a cross-tenant file read — but it is not an independently exploitable cross-tenant read today, so 'the only barrier … is knowing a UUID' should not be read as 'low barrier'.

**Done when.**

- [ ] both branches of fileKeyForItem add `.eq("org_id", t.org_id)` (and the record_id branch verifies the document belongs to that org)
- [ ] the resolved key is verified to start with the org's R2 prefix before being signed
- [ ] items are validated at insert/update time — either by a trigger or by moving transmittal writes behind a server route that re-resolves each item against the caller's org

**Resolution (2026-10-01, document-control Round F wave 2) — record-only close, resolved by `EGR-1`.** Verified against the current code: `fileKeyForItem` filters both version lookups `.eq("org_id", t.org_id)` (EGR-1, `app/api/transmittal/route.ts`), and `trg_transmittals_guard` refuses any persisted item naming a document or version outside the row's org (EGR-1, 20261027 — carried verbatim into 20261133). The one criterion EGR-1 did not deliver — the key-prefix assertion — landed here while TRX-5 rewrote the same branch: `portalKeyAllowed` (`lib/transmittals.ts`) refuses a key under another workspace's `orgs/<id>/` prefix or an unsafe key before any byte is read (legacy keys without the `orgs/` prefix stay readable — their row is already org-scoped). This package also requires a pinned version to be a version OF the item's document (route + the 20261133 issue gate).
- Tests: `transmittalPortalRoute.test.ts` (EGR-1 cross-org 404; "TRX-11 — a key under another workspace's prefix is never read"; a pinned version of another document → 404); `dcRoundFTransmittals.test.ts` (`portalKeyAllowed`).

**Done-when.**
- ✓ Both branches of `fileKeyForItem` filter on the transmittal's org (EGR-1), and the record_id branch is org-scoped the same way.
- ✓ The resolved key is checked against the org's R2 prefix before it is read (`portalKeyAllowed`).
- ✓ Items are validated at insert/update time by the trigger (EGR-1), and at issue the trigger re-resolves each item against the org (20261133).

**Scope / residual.** None.

---

<a id="trx-12"></a>

## TRX-12 · When an item is not version-pinned the portal serves the newest row bearing the as-sent revision label — with no filter on superseded_at, is_branch, or review_state

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:36-55`, `supabase/migrations/20260823_publish_contract.sql:60-67`, `supabase/migrations/20260823_publish_contract.sql:50-51`, `app/api/intake/upload/route.ts:303-317`, `supabase/migrations/20260906_projects_hardening.sql:42-43`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: when item.versionId is null the fallback hands out whatever row most recently carried that label, including an is_branch row or an in_review intake submission. The pinned path (line 41) is the only correct one.

**Mechanism.** fileKeyForItem's fallback is `.from("document_versions").select("file_url, created_at").eq("record_id", item.documentId).eq("revision_label", item.rev).order("created_at", { ascending: false }).limit(1)` (route.ts:46-50). The label is not unique across the table: the backstop index is partial — `CREATE UNIQUE INDEX … document_versions_active_label_uniq ON document_versions(record_id, revision_label) WHERE (superseded_at IS NULL AND is_branch = FALSE)` (20260823:62-65) — so superseded rows and branch rows freely share a label with the active one. `is_branch` is documented as "TRUE = published as an unreconciled branch (stale-base override); never promoted to current until resolved" (20260823:50-51). Unreviewed rows also carry a caller-supplied label: app/api/intake/upload/route.ts:306-312 inserts `revision_label: revLabel || "A", file_url: key, … review_state: autoNow ? "approved" : "in_review"`, and 20260906:42-43 admits `'rejected'` as a third state. fileKeyForItem filters on none of these three columns, and the migration's own DO-block (20260823:66-68) downgrades index creation to a NOTICE on pre-existing duplicates, so the uniqueness backstop may not even exist in a given database. The function's own docstring claims the opposite behaviour: "never silently the newest — the portal must hand out what the transmittal says it carries".

**Failure scenario.** P-200-001 is transmitted at Rev C on a record whose current_version_id was null at compose time, so item.versionId is null. Later a publisher lands an unreconciled branch revision also labelled C (is_branch = TRUE, exempt from the unique index) with a newer created_at. The contractor clicks Download in the portal and receives the branch file — work explicitly marked as never promoted to current — while both the cover sheet and the portal assert they are getting the as-issued Rev C.

**Evidence.**

```
app/api/transmittal/route.ts:37-38 — `/** Resolve an item's file: the exact version if pinned, else the version whose revision label matches the AS-SENT rev (never silently the newest …) */` versus :46-52 — `.eq("record_id", item.documentId).eq("revision_label", item.rev)` / `.order("created_at", { ascending: false }).limit(1);` / `const hit = v?.[0];`. supabase/migrations/20260823_publish_contract.sql:63-65 — `ON document_versions(record_id, revision_label)` / `WHERE (superseded_at IS NULL AND is_branch = FALSE);`
```

**Chain reaction.** Because no download_audits row records the version_id actually served (see the recall finding), there is no record of which of the same-labelled rows the contractor received, so the substitution is undetectable after the fact.

> **Verifier correction.** Downgrade HIGH→MEDIUM: the finding omits how narrow the reachable path is. The fallback branch only runs when `item.versionId` is falsy (route.ts:41), and the composer always sets `versionId` from the document's `current_version_id` (page.tsx:399, :124), so every item added through the UI is version-pinned. The label-matching branch is reached only for items whose document had a null current_version_id at compose time, or for rows written outside the composer. The mechanism and the docstring contradiction are real; the exposure is conditional, not routine.

**Done when.**

- [ ] the fallback excludes is_branch = TRUE and review_state IN ('in_review','rejected'), and prefers the row whose created_at is nearest-before the transmittal's issued_at
- [ ] when more than one candidate row matches the label the portal refuses and reports it rather than picking by created_at
- [ ] items are always version-pinned at issue time so the fallback is a genuine legacy path, not the normal one

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: the label fallback took the newest row with the label, branch and unreviewed rows included. Fixed at both ends:
- **The fallback (legacy rows only).** `fileKeyForItem` admits only rows that are not a branch (`.eq("is_branch", false)`), not `in_review` / `rejected`, created at or before the transmittal's `issued_at`, in its org; exactly one → served; none → 404; more than one → 409 "this transmittal does not record which one was sent" — it never picks by `created_at`.
- **Pinned at issue.** `trg_transmittals_guard` (20261133) pins every item at the issue transition: an unpinned item is pinned to the document's current revision only when that revision's label IS the item's rev (otherwise the issue is refused: "no published file at Rev X to pin"); a pinned version must be of the item's document, carry the item's label, be published (not a branch, not in review / rejected) and have a stored, un-shed file. So the fallback is a genuine legacy path. Fix pass: a pinned version must also still BE the document's current revision (not superseded — see TRX-3's status-truth block), and the "no published file at Rev X to pin" refusal is now one of two messages naming the cause (the document's Rev field drifted from its file, or the item is stale).
- **DEC-30 inventory.** 20261133's pre-apply result set counts the issued transmittals with unpinned items and splits those items by what the new rule does with each (one candidate keeps serving / none answers not-available / several now refuse).
- Tests: `transmittalPortalRoute.test.ts` ("TRX-12 — the unpinned label fallback never guesses": the filters applied, in-review / rejected never served, two candidates 409); `dcRoundFTransmittalMigrations.test.ts` (the gate's pin + the inventory's candidate rule). Scratch PostgreSQL 16 run: an unpinned item whose rev is not the current label → refused; a branch pin → "not a published revision"; a version of another document → refused; an unpinned item on a published current revision → pinned to it at issue; the inventory on the seeded legacy rows reported 2 transmittals / 2 items / 1 serves / 1 none / 0 ambiguous.
- Pending migration: `20261132_dc_roundF_transmit_capability.sql` then `20261133_dc_roundF_transmittal_rails.sql` — hand-applied, in that order (DEC-30; 20261133 refuses to apply before 20261132 — its first statement raises and rolls the file back). Until they are applied only the app half of this resolution is in force.

**Done-when.**
- ✓ The fallback excludes `is_branch` and `review_state IN ('in_review','rejected')`, and confines itself to rows created at or before `issued_at` — the "nearest-before" preference, made strict.
- ✓ When more than one candidate matches, the portal refuses and says so.
- ✓ Items are always version-pinned at issue (the database pins them).

**Scope / residual.** None.

---

<a id="trx-13"></a>

## TRX-13 · acknowledged_meta is write-only — the IP and user agent captured "for the receipt's weight" are never mapped, read, or rendered in any artifact

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:11-13`, `supabase/migrations/20260910_transmittal_portal.sql:24`, `app/api/transmittal/route.ts:120-134`, `lib/transmittals.ts:327-361`, `lib/transmittals.ts:116-121`, `lib/evidencePack.ts:184-190`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The column itself is genuinely write-only and neither artifact shows it — evidencePack.ts:184-190 prints only `${acknowledged_by_name} · ${acknowledged_at}` and the cover sheet's ackLine (lib/transmittals.ts:116-121) the same, and both evidence packs filter audit_logs by resource_type 'document'/'project' so the 'transmittal' row never reaches them. But 'never mapped, read, or rendered' overstates it: the IP and user agent survive in audit_logs.details and are visible and CSV-exportable on /admin/audit, so the dispute evidence is recoverable. Cosmetic/plumbing gap, not lost data — LOW.

**Mechanism.** 20260910's header promises evidentiary value: "acknowledged_via distinguishes a portal acknowledgment ('portal') from an internally recorded one ('manual'); acknowledged_meta keeps what the server saw (IP/user agent) for the receipt's weight." The route writes it — `const meta = { ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null, note: … }` then `acknowledged_meta: meta` (route.ts:121-133). Nothing reads it. Two independent searches (`grep -rn 'acknowledged_meta|acknowledgedMeta' --include=*.ts --include=*.tsx --include=*.sql .` and a follow-up on `acknowledged_via`) find exactly three hits for acknowledged_meta: the two migration lines and the single write at route.ts:133. rowToTransmittal (lib/transmittals.ts:327-361) maps portal_token, acknowledged_via, acknowledged_by_name and acknowledged_at but has no acknowledgedMeta field on the Transmittal interface at all. The printed cover sheet renders only `Receipt acknowledged ${by name} on ${date}` (lib/transmittals.ts:116-117); the project evidence pack renders only `${acknowledged_by_name} · ${date}${acknowledged_via === "portal" ? " (portal)" : ""}` (evidencePack.ts:188). The recipient's own note — collected in the portal's "Note (optional)" field (page.tsx:189-193) and stored in meta.note — is likewise never displayed anywhere.

**Failure scenario.** A contractor disputes ever having received TR-0042. The org points at the acknowledgment, but the artifacts that leave the system — the printed cover sheet and the project evidence pack — show only a typed name and a timestamp, indistinguishable from the manual path where an org member typed the recipient's name themselves (the very weakness 20260910:9-10 says the portal was built to fix). The IP and user agent that would have made it their-side proof are in the database and reachable by no code path in the application.

**Evidence.**

```
supabase/migrations/20260910_transmittal_portal.sql:12-13 — `--      from an internally recorded one ('manual'); acknowledged_meta keeps` / `--      what the server saw (IP/user agent) for the receipt's weight.` versus lib/transmittals.ts:355-358 — `acknowledgedAt: (r.acknowledged_at as string) ?? null,` / `acknowledgedByName: (r.acknowledged_by_name as string) ?? null,` / `acknowledgedVia: (r.acknowledged_via as "portal" | "manual" | null) ?? null,` / `portalToken: (r.portal_token as string) ?? null,` — no acknowledgedMeta.
```

**Chain reaction.** Same shape as the earlier audits' "comment describing behaviour that was never implemented" pattern (the sidebar badge doorway, the push_subscriptions cron). Here the consequence is that the portal acknowledgment carries no more evidentiary weight than the manual one it was built to replace, while the register's chip already tells users otherwise: "· via portal (their side)" (page.tsx:251).

> **Verifier correction.** The headline consequence is materially WRONG and must be rewritten before anyone acts on it. The captured data is neither lost nor unviewable: route.ts:140-144 writes the *same* meta into audit_logs as `details: { number, acknowledgedBy: name, via: "portal", ...meta }`, and the admin audit page renders it as pretty-printed JSON (app/(protected)/admin/audit/page.tsx:407-413) and includes it in the CSV export (:450). The recipient's note is additionally emailed to the issuer in the body_text at route.ts:170 (`${meta.note ? `\n\nTheir note: ${meta.note}` : ""}`), so 'never displayed anywhere' is false. Separately, the finding's evidencePack claim is right but for the wrong reason: gatherProjectEvidence's audit query is `.eq("resource_type", "project")` (evidencePack.ts:151), so TRANSMITTAL_ACKNOWLEDGED rows (resource_type 'transmittal') are excluded from that pack regardless of the meta column. Reduce the finding to: transmittals.acknowledged_meta is a dead column whose contents are only reachable through the admin audit log, so the IP/user-agent evidence never appears on the transmittal record, its cover sheet, or the project evidence pack.

**Done when.**

- [ ] Transmittal carries acknowledgedMeta and rowToTransmittal maps it
- [ ] the printed cover sheet's acknowledgment block and the evidence pack's Receipt column show the portal-side evidence (timestamp, source IP, and the recipient's note) for acknowledged_via = 'portal'
- [ ] the recipient's optional note collected at app/transmittal/[token]/page.tsx:189-193 is visible somewhere in the app, not only in audit_logs.details

**Resolution (2026-10-01, document-control Round F wave 2).** Reproduced: `rowToTransmittal` had no `acknowledgedMeta`; the sheet and the pack printed a name and a time only. Fixed:
- `Transmittal.acknowledgedMeta` (`TransmittalAckMeta`: `ip`, `userAgent`, `note`, `recordedBy`, `recordedByEmail`) is mapped by `rowToTransmittal`.
- The cover sheet's receipt block renders `receiptEvidence(t)`: for a portal receipt "…through the recipient portal from <IP>. Their note: "<note>""; for a register receipt "— recorded on the register by <recorder>" (the receipt route now stores who recorded it, TRX-6). The project evidence pack's Receipt column carries the same evidence (`portal · from <IP> · note: "…"` / `recorded internally by …`), escaped.
- The recipient's note is visible in the app: the register row shows it beside the acknowledgment (and the portal-side IP / the internal recorder in the ack line).
- The portal page now discloses what it records ("Your name, your note, the time and the network address you confirm from are recorded on the transmittal").
- Tests: `dcRoundFTransmittals.test.ts` ("the sheet's receipt block shows the portal-side evidence", "a register receipt names who recorded it", `rowToTransmittal` mapping, the evidence-pack render incl. escaping, the portal disclosure pin).

**Done-when.**
- ✓ `Transmittal` carries `acknowledgedMeta` and `rowToTransmittal` maps it.
- ✓ The printed cover sheet and the evidence pack show the portal-side evidence (timestamp, source IP, the recipient's note) for `acknowledged_via = 'portal'`.
- ✓ The recipient's note is visible in the app (the register), not only in `audit_logs.details`.

**Scope / residual.** The user agent is mapped but not printed (it adds bulk, not weight). `acknowledged_meta` is readable by every active member, as the whole row always was (`transmittals_select`).

---

<a id="trx-14"></a>

## TRX-14 · transmittalPortalUrl builds the external link from window.location.origin, bypassing the publicOrigin() helper that exists in this repo specifically to stop that

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:381-384`, `lib/publicOrigin.ts:1-22`, `lib/downloads.ts:90-100`, `lib/transmittals.ts:304-314`, `app/(protected)/transmittals/page.tsx:261`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — transmittalPortalUrl is the only URL builder in the repo that still uses window.location.origin for an externally-consumed link, and publicOrigin() exists precisely for this. Note the fix only helps where NEXT_PUBLIC_SITE_URL is set, since publicOrigin falls back to window.location.origin (publicOrigin.ts:20).

**Mechanism.** `export function transmittalPortalUrl(token: string): string { const origin = typeof window !== "undefined" ? window.location.origin : ""; return `${origin}/transmittal/${token}`; }` (lib/transmittals.ts:381-384). lib/publicOrigin.ts was written for exactly this class of URL: "The origin used in URLs that leave the app — QR codes on printed copies, labels, hold cards, travelers, pack covers. … `window.location.origin` is wrong whenever the person generating the print is on a preview/branch deploy — Vercel gates those behind its own login, so the scan dead-ends on a Vercel auth screen". Every other outbound-URL producer uses it — lib/downloads.ts:97, lib/docPack.ts:104, components/documents/RelatedPanel.tsx:112, app/api/share/file/route.ts:114, components/viewers/FullScreenViewer.tsx:1015. The transmittal portal URL is the single most external URL in the app (it goes to a party with no account) and is the only one that does not. It feeds the issue email (lib/transmittals.ts:278-279), the QR encoded on the printed cover sheet (:316-319) and the "Portal link" clipboard copy (page.tsx:261). When window is undefined the function returns a bare relative path `/transmittal/<token>` with no host at all.

**Failure scenario.** A doc controller validating a change opens the app on a Vercel preview deploy and issues TR-0042. The contractor receives an email whose "Download & acknowledge receipt" button points at https://manufacturing-os-git-<branch>.vercel.app/transmittal/<token>, which Vercel gates behind its own login. The printed cover sheet's QR encodes the same dead URL. The contractor cannot download the IFC set or acknowledge receipt, and the org's register shows the transmittal as unacknowledged with no explanation.

**Evidence.**

```
lib/publicOrigin.ts:8-11 — `// point at the PUBLIC production domain. \`window.location.origin\` is wrong` / `// whenever the person generating the print is on a preview/branch deploy —` / `// Vercel gates those behind its own login, so the scan dead-ends on a` / `// Vercel auth screen instead of the verify page.` versus lib/transmittals.ts:390 — `const origin = typeof window !== "undefined" ? window.location.origin : "";`
```

**Chain reaction.** Because the URL is baked into the emailed body and the printed QR at issue time, correcting the origin later does not repair transmittals already sent — each has to be re-issued.

> **Verifier correction.** Drop the last sentence. The 'when window is undefined it returns a bare relative path' case is not reachable in this codebase: lib/transmittals.ts imports the browser client (`@/lib/supabase`, :16) and createTransmittal/issueTransmittal/sendTransmittalEmail are only ever called from the client component app/(protected)/transmittals/page.tsx, so window is always defined. Also note publicOrigin() itself falls back to window.location.origin (publicOrigin.ts:20) — so the divergence bites only in deployments that actually set NEXT_PUBLIC_SITE_URL, which is precisely the preview-deploy case, but it is a conditional misroute rather than an unconditional one.

**Done when.**

- [ ] transmittalPortalUrl calls publicOrigin() and returns null/undefined when no origin is configured, so callers can refuse to email or print a hostless link
- [ ] sendTransmittalEmail and openTransmittalSheet handle the no-origin case explicitly rather than emitting `/transmittal/<token>`
- [ ] NEXT_PUBLIC_SITE_URL is asserted at issue time (or the issue flow warns) so a preview deploy cannot mint a dead portal link

**Partial (2026-10-01, document-control Round F wave 2).** Reproduced, and worse than recorded: since SURF-17 moved the send server-side, `/api/transmittal/send-email` called `transmittalPortalUrl` with no `window`, so every emailed link was the hostless `/transmittal/<token>`. Fixed with a narrow local guard (lib/publicOrigin.ts's server fallback is public-surfaces PS-STAMP's change and is not edited here):
- `transmittalPortalUrl(token)` now returns `string | null`, built on `publicOrigin()` (NEXT_PUBLIC_SITE_URL, or the page's origin in a browser) and `null` when there is no origin at all — a server with NEXT_PUBLIC_SITE_URL unset. `portalOriginConfigured()` says whether the deployment names its public origin.
- The email route refuses to email a hostless link (`sent: false` with the reason; logged) and the issue toast relays it; `openTransmittalSheet` prints the portal block only for a live link with a URL; the copy-link action refuses a null URL.
- When NEXT_PUBLIC_SITE_URL is unset the issue toast and the copy-link toast warn that the link uses this browser's address and a preview deploy's link cannot be opened by the recipient.
- Tests: `dcRoundFTransmittals.test.ts` ("TRX-14 / XEDGE-5 — the portal URL is built on the public origin, never hostless": absolute NEXT_PUBLIC_SITE_URL-rooted URL with `window` undefined; `null` when unset; no `window.location.origin` left in the lib; the email route refuses unset and emails the absolute link when set). `sweepRoundB.test.ts`'s SURF-17 pin follows the route.

**Done-when.**
- ◐ `transmittalPortalUrl` calls `publicOrigin()` ✓ and returns null when there is no origin at all — on the server with NEXT_PUBLIC_SITE_URL unset ✓. NOT done in a browser: with NEXT_PUBLIC_SITE_URL unset, `publicOrigin()` falls back to `window.location.origin`, so the cover-sheet QR and the copy-link action still use the page's own host (a preview deploy's host behind Vercel's login). The first write-up marked this done-when met — corrected in the fix pass. Returning null in the browser too was not chosen here: NEXT_PUBLIC_SITE_URL is optional in `.env.example`, so a correctly hosted production without it would lose the sheet's QR and the copy link outright; the issue and copy toasts warning that the link uses this browser's address are the stated mitigation until the origin rule itself changes (`lib/publicOrigin.ts` is public-surfaces PS-STAMP's).
- ✓ `sendTransmittalEmail` (via its route) and `openTransmittalSheet` handle the no-origin case explicitly instead of emitting `/transmittal/<token>`.
- ✓ The issue flow warns when NEXT_PUBLIC_SITE_URL is unset.

**Scope / residual.** Left OPEN for the browser half of done-when 1. Making `publicOrigin()` itself refuse when NEXT_PUBLIC_SITE_URL is unset is PS-STAMP's (XEDGE-5 dw2); when it lands, `transmittalPortalUrl` follows it with no change here. The other builders XEDGE-5 names belong to their owners (XEDGE-5 stays OPEN for them).

**Resolution (2026-10-01, public-surfaces Round F).** The browser half is closed by the origin rule changing in `lib/publicOrigin.ts`, as P7 anticipated ("until the origin rule itself changes").
- `lib/publicOrigin.ts` (PS-STAMP) gains `configuredPublicOrigin()`: `NEXT_PUBLIC_SITE_URL`, else Vercel's production domain (`VERCEL_PROJECT_PRODUCTION_URL` on the server, its `NEXT_PUBLIC_` twin in a browser; never `VERCEL_URL`). It never answers with the page's own host. `publicOrigin()` itself no longer returns a `*.vercel.app` host from a browser.
- `lib/transmittals.ts` (P7's merged file, two lines): `transmittalPortalUrl` builds on `configuredPublicOrigin()`, and `portalOriginConfigured()` is `!!configuredPublicOrigin()`. A browser and the server therefore build the same link, and with nothing configured neither builds one: `null` in the browser too. The cover sheet then prints no portal block, the copy action refuses, and the email route refuses (unchanged).
- On a Vercel production without `NEXT_PUBLIC_SITE_URL`, the production domain keeps the link working. That was P7's reason for not returning `null` in the browser.
- `app/(protected)/transmittals/page.tsx` (P7's, one line): the issue toast now says no portal link can be built, instead of "the link uses this browser's address".
- `lib/__tests__/dcRoundFTransmittals.test.ts`: the "unset on the server" test also clears the two Vercel variables, so it holds on a Vercel builder.
- Tests: `lib/__tests__/psStampRoundF.test.ts` "TRX-14 / XEDGE-5 — the portal link needs a configured origin in a browser too":
  - with nothing configured, a browser builds no link (`null`) on a preview host and off Vercel alike;
  - on a preview deploy the browser's link equals the server's: the production link;
  - the lib and toast pins.
  P7's three TRX-14 tests stay green.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4636 tests: 4629 passed, 7 expected-fail).

**Done-when.**
1. ✓ `transmittalPortalUrl` builds on the public-origin helper (`configuredPublicOrigin()`) and returns `null` when no origin is configured, in a browser as on the server. Callers therefore refuse to email or print a hostless or preview-host link.
2. ✓ (P7) `sendTransmittalEmail` (its route) and `openTransmittalSheet` handle the no-origin case explicitly.
3. ✓ The issue flow says when no public origin is configured, and now says that no link was built.

**Scope / residual.** The copy-link toast's warning suffix in `transmittals/page.tsx` (`portalOriginConfigured() ? "" : " NEXT_PUBLIC_SITE_URL is not set …"`) can no longer run, because a URL exists only when an origin is configured. It is left in place, dead but harmless, for P7's owner to tidy. See DEC-44 (public-surfaces PS-STAMP) and the DEC-61 landed note.

---

## TRX-15 · A PDF over 64 MiB leaves the transmittal portal unstamped, and the portal page holds every download in memory

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED (by reading; the bound and the fallback are pinned in `lib/__tests__/transmittalPortalRoute.test.ts`)
- **Blast radius:** document-control integrity (an uncontrolled copy without its marking)
- **Locations:**
  - `app/api/transmittal/route.ts` — `PORTAL_STAMP_MAX_BYTES` (64 MiB): a larger PDF is piped through unstamped and recorded `transmittal_portal_unstamped`
  - `app/transmittal/[token]/page.tsx` — the download is read with `res.blob()` and the object URL revoked on the same tick as `a.click()`
- **Related:** `TRX-5`, `EGR-8`, `DEC-61`
- **Independently verified:** — (`author`: opened by the integrator at the P7 TRANSMITTALS merge, 2026-10-01, per `DEC-31`, from the package's final review; not yet challenged)

**Mechanism.** P7 stamps every portal PDF in memory up to a stated bound of 64 MiB and pipes anything larger through the route without the UNCONTROLLED watermark, the as-issued footer or the `/verify` QR (the delivery is recorded, the bytes are hash-verified). The portal page then reads the whole response into a Blob before saving it, so the streamed path does not spare the recipient's browser either.

**Failure scenario.** A 90 MiB drawing-set PDF is issued on TR-0107. The contractor downloads it from the portal: it carries no UNCONTROLLED marking and no as-issued footer, so a printed copy is indistinguishable from a controlled one. On a low-memory device the page's `res.blob()` may fail outright for very large files.

**Remediation.** Stamp large PDFs without holding them whole (an incremental-update stamp, or a size-aware worker), or refuse to serve an unstampable PDF over the bound and tell the issuer at issue time; on the page, stream to disk (a download link to the route with `Content-Disposition`) instead of `res.blob()`, and revoke the object URL after the click has been handled.

**Done when.**
- Every PDF served by the portal carries the stamp, whatever its size — or a PDF that cannot be stamped is refused at issue with the reason.
- The portal page does not hold a download in memory.

---

> Line citations into `lib/transmittals.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep moved the transmittal email send server-side (`SURF-17`); the cited symbols are unchanged.
