# 06 · Transmittals & the external portal

**14 findings** — 7 HIGH · 7 MEDIUM.

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
| Portal token entropy is sound — two concatenated randomUUIDs, dashes stripped, first 40 hex chars (~154 random bits), with a partial unique index and a strict format check at the door | `lib/transmittals.ts:385-387, supabase/migrations/20260910_transmittal_portal.sql:26-27, app/api/transmittal/route.ts:25` | Guessing is not the weakness — lifetime and revocation are. Do not spend effort lengthening or re-deriving the token; add expires_at/revoked_at instead. |
| The acknowledgment round-trip is idempotent and state-guarded: an already-acknowledged transmittal returns ok+already rather than re-writing, a non-issued one 409s, and the UPDATE re-asserts `.eq("status", "issued")` | `app/api/transmittal/route.ts:115-118, :136-137` | A double-clicked or replayed acknowledgment cannot overwrite the original receipt's name or timestamp. This is the one write in the whole area that does check its own preconditions properly. |
| The register already computes and displays supersession drift for live transmittals — staleIds compares each item's as-sent rev against documents.rev and badges "superseded rev in circulation" | `app/(protected)/transmittals/page.tsx:72-92, :238-242, components/documents/InspectorPanel.tsx:1036-1078` | The internal half of supersession awareness exists and works. The gap is that the external recipient never sees it — extend this computation into the portal payload rather than building a parallel one. |
| renderTransmittalEmail and renderTransmittalSheet are pure, escape every recipient-controlled field through `esc()`, and are unit-tested including an XSS case | `lib/transmittals.ts:93-94, :208-267, lib/__tests__/transmittalEmail.test.ts:35-42` | The email/HTML rendering layer is safe and covered. New fields added to the cover sheet or email must route through the same `esc()` and gain a test in the existing file. |
| The repo already contains every helper the portal is missing: publicOrigin(), applyStampToPdfDoc/stampPdf, logDownloadAudit/download_audits, document_versions.file_hash, and the intake link's expires_at/revoked_at/last_used_at lifecycle | `lib/publicOrigin.ts:17-22, lib/stamping.ts:238, lib/downloads.ts:120-146, supabase/migrations/20260526_document_version_control.sql:41, supabase/migrations/20260902_project_intake.sql:28-33` | None of the fixes in this report require new infrastructure — each has a working in-repo counterpart to copy, and app/api/share/file/route.ts is a complete worked example of anonymous external delivery done correctly. |
| Only two vercel.json cron entries exist and a third fails every deployment on this plan; /api/cron/maintenance is the documented place to hang new periodic work | `vercel.json:3-12, app/api/cron/maintenance/route.ts:286-291` | A portal-token expiry sweep must ride the maintenance cron, not get its own entry. |


---


<a id="trx-1"></a>

## TRX-1 · Any active org member — including a Viewer or a Contractor-role member — can create and issue a transmittal in a single insert, defeating the hardening the migration claims to deliver

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:15-17`, `supabase/migrations/20260910_transmittal_portal.sql:39-44`, `lib/transmittals.ts:436-456`, `lib/roleCapabilities.ts:39`, `lib/roleCapabilities.ts:48-67`, `app/(protected)/transmittals/page.tsx:54-70`
- **Also surfaced independently as** [`DIST-6`](./05-distribution.md#dist-6) — two lenses found this separately. Fix once.

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

---

<a id="trx-2"></a>

## TRX-2 · Issued and acknowledged transmittals are deletable at the database by their creator — the "draft-only" rule exists only in application code and was explicitly deferred, then never implemented

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:53-56`, `supabase/migrations/20260818_followups_rls.sql:50-58`, `supabase/migrations/20260815_versions_collections_delete_controllers.sql:15`, `lib/transmittals.ts:641-645`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:29-33`

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

---

<a id="trx-3"></a>

## TRX-3 · Nothing checks a document's status, legal hold, active operational holds, or effective date before it can be put on a transmittal or served by the portal

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/transmittals/page.tsx:386-392`, `app/(protected)/transmittals/page.tsx:112-127`, `app/api/transmittal/route.ts:39-82`, `types/schema.ts:613`, `supabase/migrations/20260612_phase5_holds.sql:5-7`, `supabase/migrations/20260820_retention.sql:31`, `lib/effectiveDate.ts:14-27`

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

---

<a id="trx-4"></a>

## TRX-4 · The portal token has no expiry, no revocation, no use tracking — the only way to cut off external access is to void the contractual record itself; and live tokens are exported in plaintext in the full workspace backup

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:5-10`, `supabase/migrations/20260910_transmittal_portal.sql:21-27`, `supabase/migrations/20260902_project_intake.sql:28-33`, `app/api/intake/resolve/route.ts:37-41`, `app/api/transmittal/route.ts:57-61`, `lib/exportTables.ts:54`, `lib/dataExport.ts:300`, `app/(protected)/transmittals/page.tsx:258-269`

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

---

<a id="trx-5"></a>

## TRX-5 · The transmittal portal hands an external recipient the raw, unstamped master file via a presigned bucket URL — inverting the app's own uncontrolled-copy rule at the one point it matters most

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:66-82`, `lib/downloads.ts:4-8`, `lib/downloads.ts:230-280`, `app/api/share/file/route.ts:105-141`, `lib/stamping.ts:211`, `app/transmittal/[token]/page.tsx:54`

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

---

<a id="trx-6"></a>

## TRX-6 · The transmittals UPDATE and DELETE policies grant rights on `created_by = auth.uid()` with no active-membership test, so a removed member keeps write control over the transmittals they issued

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:46-56`, `supabase/migrations/20260910_transmittal_portal.sql:39-44`, `supabase/migrations/20260910_transmittal_portal.sql:33-37`, `supabase/migrations/20260814_documents_delete_controllers.sql:31-40`

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

---

<a id="trx-7"></a>

## TRX-7 · issueTransmittal writes a TRANSMITTAL_ISSUED audit entry even when the UPDATE matched zero rows, and no other transmittal mutation checks its outcome — RLS-blocked and status-mismatched writes all read as success

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:558-591`, `lib/transmittals.ts:536-548`, `lib/transmittals.ts:594-619`, `lib/transmittals.ts:622-639`, `lib/transmittals.ts:642-645`, `app/(protected)/transmittals/page.tsx:136-179`, `app/(protected)/transmittals/page.tsx:280-289`

**Mechanism.** issueTransmittal does `.update({ status: "issued", … }).eq("id", id).eq("status", "draft").select("*").maybeSingle()`, then guards the email with `if (data)` (:578) — but the audit write at :581-590 sits outside that guard and fires unconditionally, with `details: data ? {…} : undefined`. supabase-js resolves with `{ error: null }` for a zero-row UPDATE, so a row blocked by transmittals_update (a non-creator, non-controller pressing the button) or already past draft produces `data === null, error === null`: no email, no state change, and a TRANSMITTAL_ISSUED row in audit_logs regardless. The sibling functions never even ask: updateTransmittalDraft (:546), acknowledgeTransmittal (:596-600), voidTransmittal (:624-628) and deleteTransmittal (:643) all destructure only `{ error }` with no `.select()`, no `count: 'exact'`, and no rows-affected test. The register calls each inside a try/catch and shows a success toast on the absence of a thrown error — e.g. `await acknowledgeTransmittal(t.id, name, actor); showToast({ type: "success", title: "Receipt recorded", … })` (page.tsx:141-142). The Receipt and Void buttons are rendered for every issued row (page.tsx:280-289) with no role condition, so a non-creator Viewer is routinely routed into exactly this silent no-op.

**Failure scenario.** A Viewer sees TR-0042 in the register, clicks Receipt, and types the recipient's name. RLS rejects the UPDATE (they are neither creator nor controller); supabase returns zero rows and no error; acknowledgeTransmittal writes a TRANSMITTAL_ACKNOWLEDGED audit row anyway (:609-618) and returns; the toast says "Receipt recorded — TR-0042 marked acknowledged." The register still shows Issued after refresh, but the audit trail now contains an acknowledgment that never happened. The same shape lets a failed Issue produce a TRANSMITTAL_ISSUED audit entry for a transmittal that is still a draft.

**Evidence.**

```
lib/transmittals.ts:578-590 — `  if (data) {` / `    await sendTransmittalEmail(rowToTransmittal(data as Record<string, unknown>), actor);` / `  }` / `  await logAuditAction({` / `    action: "TRANSMITTAL_ISSUED",` — the audit call is outside the `if (data)` block. lib/transmittals.ts:596-600 — `let { error } = await supabase` / `  .from("transmittals")` / `  .update({ status: "acknowledged", … })` / `  .eq("id", id)` / `  .eq("status", "issued");` — outcome never inspected.
```

**Chain reaction.** This is the same unchecked-write shape the earlier audits found in the audit logger and six client-side ticket writes; here it lands on the audit trail itself, so the record of what was issued and acknowledged can diverge from the register it is supposed to evidence.

**Done when.**

- [ ] every transmittal mutation uses `.select("id")` (or `count: 'exact'`) and throws when zero rows changed
- [ ] the audit write in issueTransmittal moves inside the `if (data)` guard, and the acknowledge/void/delete audits are likewise conditional on a confirmed row change
- [ ] the register's Receipt / Void / Edit / Delete controls are shown only when the current user could actually perform them (creator or controller)

---

<a id="trx-8"></a>

## TRX-8 · A transmittal records no content hash — the "point-in-time SNAPSHOT" is a set of mutable references, unlike every other binding artifact in the app

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:34-40`, `lib/transmittals.ts:8-10`, `supabase/migrations/20260717_transmittals.sql:10-14`, `supabase/migrations/20260526_document_version_control.sql:41`, `supabase/migrations/20260720_e_signatures.sql:8`, `supabase/migrations/20260720_e_signatures.sql:23`, `supabase/migrations/20260817_read_understood.sql:39`

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

---

<a id="trx-9"></a>

## TRX-9 · External portal downloads are invisible to stale-copy recall — no download_audits row is written, and the per-document transmittal trail swallows every query error

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:75-80`, `app/api/share/file/route.ts:129-141`, `lib/staleCopies.ts:1-14`, `lib/staleCopies.ts:38-46`, `lib/transmittals.ts:396-406`, `components/documents/InspectorPanel.tsx:1036-1078`

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

---

<a id="trx-10"></a>

## TRX-10 · Issuing an existing draft prints a cover sheet with no portal link or QR, and the success toast asserts the email was sent regardless of whether it was

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/transmittals/page.tsx:417-429`, `app/(protected)/transmittals/page.tsx:304-315`, `lib/transmittals.ts:309-323`, `lib/transmittals.ts:188-196`, `lib/transmittals.ts:275-307`

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

---

<a id="trx-11"></a>

## TRX-11 · The portal resolves an item's file with no tenancy check — items JSONB is member-writable and supabaseAdmin bypasses RLS on a single shared R2 bucket

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:39-55`, `app/api/transmittal/route.ts:13`, `lib/r2.ts:20`, `supabase/migrations/20260910_transmittal_portal.sql:40-44`, `app/api/transmittal/route.ts:5-6`

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

---

<a id="trx-12"></a>

## TRX-12 · When an item is not version-pinned the portal serves the newest row bearing the as-sent revision label — with no filter on superseded_at, is_branch, or review_state

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:36-55`, `supabase/migrations/20260823_publish_contract.sql:60-67`, `supabase/migrations/20260823_publish_contract.sql:50-51`, `app/api/intake/upload/route.ts:303-317`, `supabase/migrations/20260906_projects_hardening.sql:42-43`

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

---

<a id="trx-13"></a>

## TRX-13 · acknowledged_meta is write-only — the IP and user agent captured "for the receipt's weight" are never mapped, read, or rendered in any artifact

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260910_transmittal_portal.sql:11-13`, `supabase/migrations/20260910_transmittal_portal.sql:24`, `app/api/transmittal/route.ts:120-134`, `lib/transmittals.ts:335-369`, `lib/transmittals.ts:116-121`, `lib/evidencePack.ts:184-190`

**Mechanism.** 20260910's header promises evidentiary value: "acknowledged_via distinguishes a portal acknowledgment ('portal') from an internally recorded one ('manual'); acknowledged_meta keeps what the server saw (IP/user agent) for the receipt's weight." The route writes it — `const meta = { ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null, note: … }` then `acknowledged_meta: meta` (route.ts:121-133). Nothing reads it. Two independent searches (`grep -rn 'acknowledged_meta|acknowledgedMeta' --include=*.ts --include=*.tsx --include=*.sql .` and a follow-up on `acknowledged_via`) find exactly three hits for acknowledged_meta: the two migration lines and the single write at route.ts:133. rowToTransmittal (lib/transmittals.ts:335-369) maps portal_token, acknowledged_via, acknowledged_by_name and acknowledged_at but has no acknowledgedMeta field on the Transmittal interface at all. The printed cover sheet renders only `Receipt acknowledged ${by name} on ${date}` (lib/transmittals.ts:116-117); the project evidence pack renders only `${acknowledged_by_name} · ${date}${acknowledged_via === "portal" ? " (portal)" : ""}` (evidencePack.ts:188). The recipient's own note — collected in the portal's "Note (optional)" field (page.tsx:189-193) and stored in meta.note — is likewise never displayed anywhere.

**Failure scenario.** A contractor disputes ever having received TR-0042. The org points at the acknowledgment, but the artifacts that leave the system — the printed cover sheet and the project evidence pack — show only a typed name and a timestamp, indistinguishable from the manual path where an org member typed the recipient's name themselves (the very weakness 20260910:9-10 says the portal was built to fix). The IP and user agent that would have made it their-side proof are in the database and reachable by no code path in the application.

**Evidence.**

```
supabase/migrations/20260910_transmittal_portal.sql:12-13 — `--      from an internally recorded one ('manual'); acknowledged_meta keeps` / `--      what the server saw (IP/user agent) for the receipt's weight.` versus lib/transmittals.ts:363-366 — `acknowledgedAt: (r.acknowledged_at as string) ?? null,` / `acknowledgedByName: (r.acknowledged_by_name as string) ?? null,` / `acknowledgedVia: (r.acknowledged_via as "portal" | "manual" | null) ?? null,` / `portalToken: (r.portal_token as string) ?? null,` — no acknowledgedMeta.
```

**Chain reaction.** Same shape as the earlier audits' "comment describing behaviour that was never implemented" pattern (the sidebar badge doorway, the push_subscriptions cron). Here the consequence is that the portal acknowledgment carries no more evidentiary weight than the manual one it was built to replace, while the register's chip already tells users otherwise: "· via portal (their side)" (page.tsx:251).

> **Verifier correction.** The headline consequence is materially WRONG and must be rewritten before anyone acts on it. The captured data is neither lost nor unviewable: route.ts:140-144 writes the *same* meta into audit_logs as `details: { number, acknowledgedBy: name, via: "portal", ...meta }`, and the admin audit page renders it as pretty-printed JSON (app/(protected)/admin/audit/page.tsx:407-413) and includes it in the CSV export (:450). The recipient's note is additionally emailed to the issuer in the body_text at route.ts:170 (`${meta.note ? `\n\nTheir note: ${meta.note}` : ""}`), so 'never displayed anywhere' is false. Separately, the finding's evidencePack claim is right but for the wrong reason: gatherProjectEvidence's audit query is `.eq("resource_type", "project")` (evidencePack.ts:151), so TRANSMITTAL_ACKNOWLEDGED rows (resource_type 'transmittal') are excluded from that pack regardless of the meta column. Reduce the finding to: transmittals.acknowledged_meta is a dead column whose contents are only reachable through the admin audit log, so the IP/user-agent evidence never appears on the transmittal record, its cover sheet, or the project evidence pack.

**Done when.**

- [ ] Transmittal carries acknowledgedMeta and rowToTransmittal maps it
- [ ] the printed cover sheet's acknowledgment block and the evidence pack's Receipt column show the portal-side evidence (timestamp, source IP, and the recipient's note) for acknowledged_via = 'portal'
- [ ] the recipient's optional note collected at app/transmittal/[token]/page.tsx:189-193 is visible somewhere in the app, not only in audit_logs.details

---

<a id="trx-14"></a>

## TRX-14 · transmittalPortalUrl builds the external link from window.location.origin, bypassing the publicOrigin() helper that exists in this repo specifically to stop that

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:389-392`, `lib/publicOrigin.ts:1-22`, `lib/downloads.ts:90-100`, `lib/transmittals.ts:312-322`, `app/(protected)/transmittals/page.tsx:261`

**Mechanism.** `export function transmittalPortalUrl(token: string): string { const origin = typeof window !== "undefined" ? window.location.origin : ""; return `${origin}/transmittal/${token}`; }` (lib/transmittals.ts:389-392). lib/publicOrigin.ts was written for exactly this class of URL: "The origin used in URLs that leave the app — QR codes on printed copies, labels, hold cards, travelers, pack covers. … `window.location.origin` is wrong whenever the person generating the print is on a preview/branch deploy — Vercel gates those behind its own login, so the scan dead-ends on a Vercel auth screen". Every other outbound-URL producer uses it — lib/downloads.ts:97, lib/docPack.ts:104, components/documents/RelatedPanel.tsx:112, app/api/share/file/route.ts:114, components/viewers/FullScreenViewer.tsx:1015. The transmittal portal URL is the single most external URL in the app (it goes to a party with no account) and is the only one that does not. It feeds the issue email (lib/transmittals.ts:278-279), the QR encoded on the printed cover sheet (:316-319) and the "Portal link" clipboard copy (page.tsx:261). When window is undefined the function returns a bare relative path `/transmittal/<token>` with no host at all.

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

---
