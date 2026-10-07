# 01 · Security & access

Who can reach what, and what an outsider can put inside the perimeter.

**20 findings** — 4 CRITICAL, 11 HIGH, 4 MEDIUM, 1 LOW (`SEC-18` opened by projects Round G package J9, `SEC-19` by J1, `SEC-20` by J8, 2026-09-30).

> Line numbers are from commit `6a14d7d` and drift with edits. **Match on the
> quoted code, not the number.** See [`../README.md`](../README.md) for the
> resolution protocol.

---

## SEC-1 · An unauthenticated upload link can put executing JavaScript on the app's own origin

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED (by construction — code path traced link by link; no payload executed)
- **Blast radius:** security
- **Locations:**
  - `app/api/intake/upload/route.ts:270` — `ContentType: file.type || "application/octet-stream"`
  - `components/viewers/SecureDocViewer.tsx:129-140` — `response.blob()` → `URL.createObjectURL(blob)`
  - `components/viewers/SecureDocViewer.tsx:274` — `<iframe>` with no `sandbox`
- **Related:** `SEC-6` (no type validation), `SEC-7` (inline disposition), `SEC-5` (link never expires)
- **Re-verified:** hardening pass — **SURVIVES**. Both halves confirmed. `ContentType: file.type || "application/octet-stream"` (`intake/upload:270`) takes the type from the uploader unvalidated; `SecureDocViewer.tsx:274-275` renders the fetched bytes as `<iframe src={blobUrl}>`, and a `blob:` URL inherits the creating origin. Unauthenticated upload → script execution on the app's own origin.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed end to end. blob: URLs inherit the creating document's origin, there is no CSP anywhere (next.config.ts sets no headers and there is no middleware.ts), the viewer is never gated on file type (InspectorPanel.tsx:442 renders any selectedVersion.fileUrl), and lib/supabase.ts keeps the session in localStorage by default ('Absent flag → remember'). Same unvalidated ContentType also at l.76 and l.165 for the quote branch.

**Mechanism.** The intake route stores the object with `ContentType: file.type`
— whatever the client claimed — with no sniffing and no allowlist.
`SecureDocViewer` then fetches the object, wraps the bytes in an app-origin
`blob:` URL, and renders it in an `<iframe>` with no `sandbox` attribute and no
file-type gate.

**Failure scenario.** A vendor holding the link uploads `payload.html`
declaring `Content-Type: text/html`. Anyone who opens it in the document viewer
runs the attacker's script as themselves, on the application's origin, with
access to `localStorage` — which holds the Supabase session and refresh token.
On a trusted auto-supersede link no approval click is needed first.

**Remediation.** Four independent layers; the first alone breaks the active half
of the chain.
1. Set `ResponseContentDisposition: attachment; filename="…"` on the presigned
   download URL. `app/api/transmittal/route.ts:73` already does exactly this —
   copy it.
2. Sniff magic bytes server-side and store the sniffed type, never `file.type`.
3. Add `sandbox` to the viewer iframe (no `allow-scripts`, no
   `allow-same-origin`) and gate rendering on the sniffed type.
4. Serve untrusted uploads from a separate origin or bucket so a bypass cannot
   reach app-origin storage.

**Done when.**
- A stored `text/html` object downloads rather than renders, in Chrome, Firefox and Safari.
- The viewer iframe carries a `sandbox` attribute with no `allow-same-origin`.
- An upload declaring a false MIME type is stored with its sniffed type, not the declared one.
- A test asserts the disposition header is present on the presigned URL.

**Partial (2026-09-30, projects Round G — the egress limb; the ID closes in P1).** Built on document-control P2 EGRESS. (1) Every URL `/api/storage/download-url` signs is an ATTACHMENT unless an in-app viewer asks for inline and the key is a PDF or a raster image, whose Content-Type is then pinned (`SEC-7`, `lib/presignedDisposition.ts`, `DEC-49`): a stored `text/html` object is served `Content-Disposition: attachment` whatever the caller asks. (2) `components/viewers/SecureDocViewer.tsx` — the `:274` frame this finding cites; the identity `IS-P1` (`:58`) and drafting `EVID-5` (`:52-59`) regions are untouched — asks for inline and renders only what `viewerRenderKind` admits: a file that ARRIVED typed as a PDF or a raster image, re-typed to exactly that type (`new Blob([blob], { type: view.type })`, `:183-191`). A PDF goes to the viewer's ONE frame (`:336`); a raster image is shown as an `<img>` (`:347`), never framed — an image element runs no script whatever its bytes are and has no document or origin of its own. An HTML, SVG, XML, text or untyped file is never shown on the app origin (a "Preview is available for PDFs and images only" panel instead); the old fallback that framed the bare URL unconditionally is gone — when the bytes cannot be fetched, only the route's own inline grant, or a legacy absolute URL on another origin whose path NAMES a PDF or a raster image, may be shown directly (`directStreamKind`, `:23-28`) — and the route's refusal shows as a refusal. Tests: `lib/__tests__/presignedDisposition.test.ts` — the real presigned URL's `response-content-disposition`, "a stored HTML upload is an attachment whatever the caller asks", `viewerRenderKind` never admitting HTML / SVG / XML / script / text / octet-stream / an empty type, and source pins on the viewer's gate, the re-typing, "an image is an <img>, never a frame — the PDF frame is the viewer's only frame", "a legacy cross-origin URL is shown only when its path NAMES a PDF or a raster image — never framed blind". (That pin also refuses a future `sandbox` granting `allow-*` tokens; it pins nothing present — the PDF frame carries no `sandbox` at all, by decision, below.)

**Done-when (this limb).**
- A stored `text/html` object downloads rather than renders, in Chrome, Firefox and Safari — ✓ by construction and test: the signed URL carries `attachment` for it on every path (asserted on the real presigned URL) and the in-app viewer refuses to frame it. Not observed in the three browsers (no browser in this environment).
- The viewer iframe carries a `sandbox` attribute with no `allow-same-origin` — **partly, by decision (`DEC-49`)**: the viewer's only frame is the PDF frame, and it carries no `sandbox`, because Chromium blocks its PDF viewer in any sandboxed frame (the load is refused outright), which would blank every controlled drawing in the product's main preview. It is protected by the type gate instead — only bytes that arrived typed `application/pdf`, re-typed to exactly that, reach it from a fetch, so the browser's PDF viewer handles them and no HTML parser does. Images are no longer framed at all (an `<img>`). One path is weaker: a legacy absolute URL on another origin that could not be fetched reaches the frame when its path names a `.pdf`; it was not signed by the route, so it is served with its stored type (the `SEC-18` class, on the storage origin, not the app's). (Known Chromium behaviour, not re-observed here.)
- An upload declaring a false MIME type is stored with its sniffed type, not the declared one — not this limb: P1 (`SEC-6`).
- A test asserts the disposition header is present on the presigned URL — ✓.

**Scope / residual.** P1 closes the ID: the sniff and allowlist at the door (`SEC-6`, GAP-401). GAP-401 acceptance 1 (an uploaded HTML / SVG / JS file cannot execute on the app's origin) is proven here for the egress half — the headers for an HTML / SVG key and the viewer's refusal to frame one — with P1's upload-side test as the first line. `/api/storage/resolve` and `lib/dataExport.ts` are the remaining unsigned issuers: `SEC-18`.

**Resolution (2026-09-30, projects Round G — the route half; the egress limb above).** Package J1 INTAKE-DOOR (`GAP-401`, with projects-and-cost `INTK-11`). The intake door stores what the BYTES are: new `lib/fileSniff.ts` reads the magic number (PDF `%PDF-` at offset 0, DWG `AC10nn`, ZIP local header, DXF), `app/api/intake/upload/route.ts` refuses anything off the branch's allowlist BEFORE storage (quotes PDF; drawings and redlines PDF / DWG / DXF / ZIP), requires the extension to name the sniffed kind and the declared type to be one a real file of that kind is sent with, and writes the SNIFFED type as the object's `ContentType` and the version's `file_type` — never `file.type`. An HTML, SVG or script upload cannot enter through the door at all. Tests — `lib/__tests__/intakeUploadRoute.test.ts` "an HTML page named .pdf and declared application/pdf is refused before storage", "the stored ContentType is the SNIFFED type, never the declared one", "a DWG is accepted … and stored as image/vnd.dwg"; `lib/__tests__/intakeDoorLibs.test.ts` (the sniffer refuses HTML / SVG / script / text / EXE / a PDF header not at offset 0).

**Done-when.**
- [x] A stored `text/html` object downloads rather than renders — ✓ (egress limb, J9: every signed URL is an attachment unless an in-app viewer asks for a PDF or a raster image); and the door no longer stores one.
- [x] The viewer iframe carries a `sandbox` with no `allow-same-origin` — ✓ by `DEC-49`'s decision, not literally: the viewer's only frame is the PDF frame, left unsandboxed because Chromium refuses its PDF viewer in any sandboxed frame; it is protected by the type gate (J9's limb above).
- [x] An upload declaring a false MIME type is stored with its sniffed type — ✓ (this limb).
- [x] A test asserts the disposition header on the presigned URL — ✓ (J9).

**Scope / residual.** `SEC-18` (two other unsigned presigned-GET issuers) and `INTK-15` (presigned direct-to-R2 uploads) stay open under their own ids; serving uploads from a separate origin remains `GAP-401` item 4.

---

## SEC-2 · Private projects are not private for cost, bid, or quality data

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** security / data-confidentiality
- **Locations:**
  - `supabase/migrations/20261013_project_controls_program.sql:256` — the generated `%I_member_read` policy template
  - `supabase/migrations/20260913_projects_rls_recursion_fix.sql:40` — `project_visible_to_me()` defined
  - `supabase/migrations/20260913_projects_rls_recursion_fix.sql:91` — its only consumer
- **Re-verified:** hardening pass — **SURVIVES**. The loop at `20261013…:253-258` creates `%I_member_read … FOR SELECT USING (EXISTS … org_members … status = 'active')` for `change_orders`, `project_checklists`, `checklist_items`, `turnover_items` and `punch_items` — the predicate is **org-wide membership**, with no project-membership term. Private projects are not private for any of that data.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives at CRITICAL. Grep confirms the claim of absence: `project_visible_to_me` appears exactly three times in the whole migration tree — its definition, its GRANT, and the single project_activity policy — so every cost, bid, change-order, checklist, turnover and punch table is org-member-readable regardless of projects.visibility. And it does surface on the ordinary profile page: lib/companies.ts:248-251 (called by app/(protected)/companies/[id]/page.tsx via gatherCompanyProfile) reads change_orders amounts, turnover_items, punch_items and cost_documents `total_amount` for quotes, all through the authenticated client.

**Mechanism.** `project_visible_to_me()` is defined, granted to `authenticated`,
and then referenced by **exactly one policy in the entire schema** — the one on
`project_activity`. Every new table's SELECT policy is generated from a single
template that checks org membership only:

```sql
'CREATE POLICY %I_member_read ON %I FOR SELECT USING (EXISTS (
   SELECT 1 FROM org_members m
   WHERE m.org_id = %I.org_id AND m.uid = auth.uid() AND m.status = ''active''))'
```

The same is true of the four cost tables.

**Failure scenario.** Any active org member can read the budgets, bid prices,
change orders, PSSR findings and turnover records of a project marked private.
Not by crafting a query — the data surfaces on the ordinary
`/companies/[id]` profile page.

**Remediation.** Replace the org-membership check with
`project_visible_to_me(project_id)` in the SELECT policies for `cost_accounts`,
`cost_entries`, `cost_documents`, `project_parties`, `change_orders`,
`project_checklists`, `checklist_items`, `turnover_items`, `punch_items`. Note
`checklist_items` has no `project_id` — join through `project_checklists`.
Write it as a new migration; do not edit `20261013` in place.

**Done when.**
- A member who is not on a private project's member list receives zero rows from every one of those tables.
- The company profile page shows no data drawn from private projects the viewer cannot see.
- A policy test (pgTAP or an integration test) pins the negative case.

**Resolution (2026-09-30, projects Round G).** Reproduced at `2a2ae73`: `project_visible_to_me` was referenced by one policy (`project_activity_select`, 20260913:91); the five controls tables' `%I_member_read` (20261013:253-258) and the four cost tables' `%I_select` (20260906:160-173) checked org membership only — a census replaying the whole migration sequence (`lib/__tests__/projectsRls.test.ts` "sees the policies the 20261013 and 20260906 loops generated before 20261102 replaced them") shows both loop-generated policies with the bare `org_members` predicate. Fixed in `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 1: `change_orders_member_read`, `project_checklists_member_read`, `turnover_items_member_read`, `punch_items_member_read`, `project_parties_select`, `cost_accounts_select`, `cost_documents_select`, `cost_entries_select` are dropped and re-created `FOR SELECT USING (project_visible_to_me(project_id))`; `checklist_items_member_read` reads through its checklist (`EXISTS (… project_checklists c WHERE c.id = checklist_items.checklist_id AND project_visible_to_me(c.project_id))`). Controllers stay unscoped (the helper's controller branch, DEC-43); owners and roster members of a private project read it; write policies are untouched. The profile page's reads (`lib/companies.ts` gather through the authenticated client) are bound by the same policies, so a private project's change orders, turnover / punch items and quotes no longer reach `/companies/[id]` for a non-member (its schedule and intake reads are keyed on the project ids of the parties it could read, so they follow). The one gather source keyed on the COMPANY rather than a project is `company_events`: `company_events_member_read` (20261013:241, org membership only) is re-created in the same section with 20261013's line kept and one added line — `AND (company_events.project_id IS NULL OR project_visible_to_me(company_events.project_id))` — so an event with no project stays an org record, and a recordable / stop-work / warning logged against a private project is shown only to someone who can see that project. No code change in P9's `lib/companies.ts`.
- Commits: `e0c1aa2` (migration + census), `7ca202f`, `9363ebb`
- Tests: `lib/__tests__/projectsRls.test.ts` — a policy census over `supabase/schema.sql` + every numbered migration (literal statements AND the `FOREACH … format('CREATE POLICY %I …')` loops expanded per table): "every permissive read of the nine tables goes through project_visible_to_me — or is a controller / active-owner write policy", "each table's member read is the 20261102 policy"; `lib/__tests__/projectRailsMigration.test.ts` "20261102 — SEC-2: the nine read policies"; the company profile: `projectsRls.test.ts` "SEC-2 dw2 — the company profile shows no private-project event to a non-member" (before 20261102 the census sees the bare org read; after it every permissive read of `company_events` gates a project-tied event), `projectRailsMigration.test.ts` "company_events_member_read … is 20261013's line, closed one parenthesis early, plus ONE line gating a project-tied event on project_visible_to_me".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` (DEC-30 inventory in the file: private projects carrying cost / quality rows, the count of those rows, and the company events logged against a private project — the blast-radius statement; two probes check the `company_events` read).

**Done-when.**
- A member who is not on a private project's member list receives zero rows from every one of those tables — ✓ by policy (all nine SELECT policies are `project_visible_to_me`; no other permissive SELECT / ALL policy on them grants a bare org read — census-pinned); live once `supabase/migrations/20261102_prj_roundG_project_rails.sql` is applied (the file's probes check it). On the integrated tree the same holds for projects Round G J2's turnover review history, `turnover_review_events` (20261091) — second fix pass below.
- The company profile page shows no data drawn from private projects the viewer cannot see — ✓ by policy (the gather reads through the RLS client: the nine tables, and `company_events` — the source the first cut missed — now gate private-project rows, and since the third fix pass they stay gated after the private project is deleted; live once `supabase/migrations/20261102_prj_roundG_project_rails.sql` is applied).
- A policy test pins the negative case — ✓ as a **census** only (`projectsRls.test.ts`, a static replay of every policy statement in migration order, with a fixture for 20261091). It is **not** the pgTAP or integration test this item names. There is no live database in this environment, so per `DEC-30` the paste-back probes check the live policies instead. A pgTAP test that signs in as a non-member and reads zero rows is still to be written.

**Scope / residual.** `milestones` is still `milestones_member_all` FOR ALL for any org member (20260614) — outside this finding's nine tables; it is projects-and-cost PC-3's (`SCHED-*`) policy work (the profile's milestone read is keyed on visible projects, so it does not leak there). `audit_logs` rows about a private project (resource_type `project` / `cost`) stay readable org-wide — opened as `SEC-20`. *Fix pass (2026-09-30):* the first cut recorded dw2 ✓ with no change to `company_events`, whose member read stayed org-only while carrying `project_id` — a stop-work order logged against a private project still reached `/companies/[id]` for every member. Closed as above. *Second fix pass (2026-09-30):* two routes around dw1 were missed.
1. **J2's `turnover_review_events`.** Projects Round G J2's migration (20261091, merged on the integration branch, not in this package's base) creates `turnover_review_events` — status changes, reviewer notes, nonconformances, reviewed document ids — with `turnover_review_events_member_read` on org membership. That is the same private data as `turnover_items`, readable after merge with one query. `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 1 now re-creates that policy, in J2's statement shape, on `project_visible_to_me(project_id)`, inside a `to_regclass` guard, so a database without 20261091 skips it. The DEC-30 inventory counts the exposed rows (dynamically; 0 where the table is absent), and a probe checks the read. The census replays J2's statement as a fixture: 20261091 alone leaks, and with 20261102 after it every permissive read gates. Apply 20261102 after 20261091. If 20261091 is re-run, re-run 20261102; the probe says so.
2. **The delete snapshot.** Projects-and-cost `PM-6`'s `PROJECT_DELETED` row copied a deleted private project's whole cost and quality ledger into `audit_logs`, which any member reads. The snapshot now rides in `PURGE_PROJECT_SNAPSHOT`, which the `audit_logs_admin_trail` overlay limits to the org's audit viewers (see `PM-6`).

Tests: `projectsRls.test.ts` "SEC-2 after merge — projects Round G J2's turnover review history (20261091) is private with its project"; `projectRailsMigration.test.ts` "20261102 — SEC-2 after merge…". Still open beside this finding's tables: `milestone_baseline_history` (projects Round G J6a, 20261099) reads on `caller_is_active_member(org_id)`. It is schedule data, like `milestones_member_all`, and belongs with that projects-and-cost PC-3 policy work, not here.

*Third fix pass (2026-09-30):* dw2 did not survive a delete. `company_events.project_id` is ON DELETE SET NULL (20261013:98), and the member read above admits every active member to an event with no project. So once a private project was deleted, its recordables and stop-work orders became org-readable on `/companies/[id]`. That held on every delete path: `delete_project_record`, a raw DELETE under `projects_delete_owner`, and the pre-20261103 app path. `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 1 now adds `company_events.deleted_private_project` (NOT NULL, default false). A BEFORE DELETE trigger on projects, `trg_projects_private_company_events` (SECURITY DEFINER, `keep_private_project_company_events_private`), sets the mark on a PRIVATE project's events before the FK unlinks them. The member read's added line is now `AND ((company_events.project_id IS NULL AND NOT company_events.deleted_private_project) OR project_visible_to_me(company_events.project_id))`. It is still 20261013's line plus one line (lineDiff).

The events are kept, not deleted: a contractor's recordable is its permanent record. They stay readable to the org's controllers, through `company_events_controller_write` (FOR ALL), as they were while the project existed. `delete_project_record` (20261103) counts them and puts them in `PURGE_PROJECT_SNAPSHOT` (audit viewers), which keeps their project association. A probe in each file checks this.

Tests:
- `projectsRls.test.ts`: "deleting a private project does not make its events org-readable…". The census now requires the mark in every permissive member read of `company_events`.
- `projectRailsMigration.test.ts`: "deleting a private project keeps its company events private…" and "SEC-2: the company events the delete unlinks are counted and snapshotted…".

Events unlinked by a private project's delete BEFORE 20261102 cannot be told apart from org events, and stay org-readable. Two inventory rows bound this: "company events logged against a private project" counts the events the mark will protect, and "company events with no project" counts every unlinked event, including any of those.

---

## SEC-3 · The assigned-document review guarantee self-destructs after one submission

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** safety / document-control integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:246-249` — `linkAuthored` computation
  - `app/api/intake/upload/route.ts:257` — the pending-submission guard it defeats
  - `app/api/intake/upload/route.ts:302` — `autoNow`
- **Re-verified:** hardening pass — **SURVIVES**, and the mechanism is exact. `linkAuthored` is true once a version authored by this link exists (`:246-248`); the pending-review block is `if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored))` (`:257`). So the first submission is held for review and every later one takes the auto path. The route's own comment two hundred lines down — *"an assigned org-authored controlled drawing ALWAYS goes through review"* — is false from the second submission onward.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives at CRITICAL, and the code refutes its own contract: the comment immediately above line 302 states 'an assigned org-authored controlled drawing ALWAYS goes through review, whatever the link's trust level', and the migration comment at 20260903_intake_assignments.sql:22 and the UI text at IntakePanel.tsx:409 repeat that promise — but `linkAuthored` is computed from the version chain, not from provenance, so the first accepted assigned-document submission converts the org's own drawing into 'the link's own work' forever after. Submission two publishes and orphans the Rev A review row at review_state 'in_review' with pending_version_id cleared.

**Mechanism.** `linkAuthored` is computed as "a version row on this record
carries this link's id":

```ts
const { data: owned } = await supabaseAdmin
  .from("document_versions").select("id")
  .eq("record_id", docId).eq("intake_link_id", link.id as string).limit(1);
linkAuthored = !!owned?.length;
```

That is not "this link created this document." The link's own first,
correctly-review-routed submission plants exactly such a row. Review state is
irrelevant — an `in_review` or even `rejected` version satisfies it.

**Failure scenario.** Document Control assigns a PSM-covered P&ID to a trusted
contractor link. Submission one routes to review, correctly. Submission two
sees `linkAuthored = true`, skips the pending-submission 409, and publishes:
`status: "Issued"`, new `current_version_id`, `pending_version_id` cleared —
orphaning the first review in the same write.

The code comment three lines above says an assigned org-authored drawing
"ALWAYS goes through review, whatever the link's trust level."
`docs/ARCHITECTURE.md:752-756` says it, `20260903_intake_assignments.sql` says
it, and `IntakePanel.tsx:409` says it to the user in bold. The guard does not
implement it.

**Remediation.**
1. Make `linkAuthored` mean authorship: require the document's **first** version
   (lowest `created_at`, or the row referenced when `current_version_id` was
   first set) to carry this `intake_link_id`.
2. Independently, refuse auto-supersede outright for any document in the link's
   `assigned_doc_ids`, regardless of authorship. That is the invariant the copy
   promises, and it should be enforced directly rather than inferred.

**Done when.**
- A link that submits twice against an assigned org-authored document routes both submissions to review.
- A link that created a document itself can still auto-supersede its own work when trusted.
- A test covers both branches.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-1` (J1). Authorship is `documents.authored_by_link_id`, stamped when the door CREATES a document and backfilled from each document's first version (migration `20261104`); a document in the link's `assigned_doc_ids` is never auto-published whatever its history; a link-authored document needs at least one approved revision before a trusted link may publish over it (`DEC-56`). Fix pass (J1 review): a rejected submission can no longer be re-published by resubmission — a pending own submission, a rejection against the current revision, or rejected bytes all send the upload to review (`INTK-1`'s fix pass). Tests — `lib/__tests__/intakeUploadRoute.test.ts` "an ASSIGNED org document goes to review on every submission — even after a link version was approved", "publishes through publish_revision acting as the link's creator …" (the trusted own-document branch), "reject F → submit G (review) → submit F again, or F plus one byte: each lands IN REVIEW".

**Done-when.**
- [x] A link that submits twice against an assigned org-authored document routes both to review — ✓.
- [x] A link that created a document can still auto-supersede its own (approved) work when trusted — ✓ (through `publish_revision`, `SAF-5`).
- [x] A test covers both branches — ✓.

**Scope / residual.** Pending migration: `20261104` (before it, the route reads the document's first version — equally fail-safe).

---

## SEC-4 · The external door runs as service role, so every database-level document-control guard is skipped

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** safety / document-control integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:322-334` — the publish write, via `supabaseAdmin`
  - `supabase/migrations/20260822_review_completion_guard.sql:32-34` — the skip
- **Related:** `SEC-13`, `SEC-14`, `SAF-5`
- **Re-verified:** hardening pass — **SURVIVES**. Every write on this route uses `supabaseAdmin`; the publish-guard trigger exempts service-role writes by design, so no hold, lock or review gate is consulted.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives at CRITICAL. 20260822 is the newest of the five definitions of enforce_document_publish_guard (20260713, 20260812, 20260816, 20260822) and it is the one installed on trg_document_publish_guard (:92-96), so the NULL-actor early return is live. The route also never reads or touches checkout_sessions, so an open checkout is left dangling exactly as described, and document_holds is never consulted on this path.

**Mechanism.** The publish-guard trigger opens with:

```sql
v_actor uuid := auth.uid();   -- NULL for service-role
IF v_actor IS NULL THEN RETURN NEW; END IF;
```

`auth.uid()` is null for the service role the intake route uses. Every
protection the trigger provides is therefore inert on this path.

| Guard | Internal publisher | Intake auto-supersede |
|---|---|---|
| Review completion (signed roster) | enforced | **skipped** |
| Publish authority | enforced | **skipped** |
| Active hold blocks publish | enforced | **skipped** |
| Foreign checkout lock | enforced | **skipped** |

**Failure scenario.** An engineer has a drawing checked out for as-built
verification and Document Control has an active "Field Verification Needed"
hold on it. A trusted contractor link supersedes it anyway. The engineer's lock
stays open on a document whose current revision changed underneath them; the
hold is silently ignored.

**Remediation.** Either (a) route the intake publish through
`finalizeReviewedRevision` under a real JWT so the trigger sees an actor, or
(b) replicate the four guard checks explicitly in the route before writing.
(a) is preferable — it also fixes `SAF-5` and `SEC-13` at the same time.

**Done when.**
- An intake auto-supersede against a held document is refused with a clear reason.
- An intake auto-supersede against a document checked out by someone else is refused.
- The refusal reaches the contractor's portal as a readable message, not a 500.

**Resolution (2026-09-30, projects Round G — the residual after roles-and-permissions `OWN-4`).** `OWN-4` (RESOLVED) put the hold / checkout / creator-authority demotions in the route. J1 routes the trusted promote itself through the publish CONTRACT (`publish_revision`, acting as the link's creator — projects-and-cost `INTK-2`): the database locks the document row and applies the hold gate, the foreign-checkout lock, the expected-base check and the drawing-class MOC gate; the route's own gates now also include the library's review policy (the SQL twin `review_control_mode_for` — a `require` policy demotes, `SEC-13`) and HLD-1's shared hold gate (`lib/holdGate.ts` `readActiveHolds` / `decideHoldGate`, fail-closed) in place of the inline read. Every refusal DEMOTES the upload to review with the reason in the portal's `note` (OWN-4's semantics: the file is kept, the instant publish withheld). Tests — `lib/__tests__/intakeUploadRoute.test.ts` the ten-case demotion table ("an active hold", "an unreadable hold state (fails closed)", "a legal hold", "a checkout", "a creator without authority", "a library that requires sign-off", "the contract's hold gate", "the contract's checkout lock", "the contract's MOC gate …"); `lib/__tests__/rpPhase3Migration.test.ts` pins extended.

**Done-when.**
- [x] An auto-supersede against a held document is refused with a clear reason — ✓ (the promote is refused and the upload goes to review, reason shown).
- [x] …against a document checked out by someone else — ✓.
- [x] The refusal reaches the portal as a readable message, not a 500 — ✓.

**Scope / residual.** The route still runs as the service role, so `enforce_document_publish_guard` returns early on it; the guards the contract does not carry (per-library authority, review completion) are evaluated by the route (the creator's authority, the review policy). Replacing the service role with a constrained identity is `GAP-401`'s build, which runs on this tree. DEPENDENCY (J1 second review): the review-policy rail calls `review_control_mode_for`, which document-control Round F's `20261070` creates — until it is applied, the call errors and every trusted auto-publish DEMOTES ("the library's review policy could not be verified"; fail closed). The shared client the post-publish pipeline runs on is bound to the service role per request (`lib/serverClientScope.ts` — projects-and-cost `INTK-2` fix pass 2), never module-wide.

---

## SEC-5 · Quote links never expire, and document links default to never

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:539-544` — insert with no `expires_at`
  - `components/projects/IntakePanel.tsx:150` — `expires_at: expires ? … : null`
- **Related:** report [`11-upload-door-controls.md`](./11-upload-door-controls.md)
- **Re-verified:** hardening pass — **SURVIVES**, and the contrast is exact. The quote-link insert sets no `expires_at` column at all (`QuotesPanel.tsx:539-544`), while the document intake link at least offers one and defaults it to `null` (`IntakePanel.tsx:150`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives at HIGH. Both halves confirmed: quote links have no expiry field at all, document links default to NULL, and the only ceiling on reuse is a counter — bump_intake_use (20260902_project_intake.sql:74-79) does `submission_count = submission_count + 1` and enforces no cap. The sole kill switch is a manual revoke, which QuotesPanel does not even offer at mint time.

**Mechanism.** The quote-link insert has no `expires_at` at all — no field in
the form, no default, and no revoke button where the link is minted. The
document-link form has an expiry field, but leaving it blank writes `null`,
which means forever. There is no maximum-TTL ceiling anywhere in the code or
the schema.

**Failure scenario.** A link emailed to a vendor for a job that closed two
years ago still accepts uploads today, from anyone who has ever had the URL — a
forwarded email, a departed employee, a shared inbox.

**Remediation.** See report `11` for the full control set. Minimum: mandatory
`expires_at` with a 14-day default and a 90-day ceiling enforced by a DB
`CHECK`, applied to both link kinds.

**Done when.**
- No code path can create a link with a null or unbounded `expires_at`.
- A `CHECK` constraint rejects an out-of-range expiry at the database.
- Every surface that displays a link also offers Revoke.

*Landed 2026-09-29 (projects Round G, J4 limb): the quote-link mint (`QuotesPanel.tsx` `QuoteLinksSection.create`) now requires an expiry (date input, default 90 days, refused when blank or past), writes `expires_at`, inserts with `.select("id").single()`, records the audit row against the link id (no token material) with `{ error }` checked and surfaced, and the list offers Revoke (`INTAKE_QUOTE_LINK_REVOKED`; fix pass: the revoke reads back `.select("id")` and a zero-row result is reported, never audited as a revocation). The DB `CHECK` ceiling and the document-link half close in P1; existing quote links without an expiry are inventoried by 20261096 and the backfill is left commented there until no link is in active bidding (INTK-12 default).*

**Resolution (2026-09-30, projects Round G).** J1 finishes what J4 started on the quote-link mint. `components/projects/IntakePanel.tsx`: the document-link form now REQUIRES an expiry — 14 days by default, at most 90 (`lib/intakeLinks.ts` `intakeExpiryFor`; the date input carries `max`), written to `expires_at`; the list shows the expiry, and Revoke stays on every live link. Migration `20261104`: a `CHECK` — for every link created after the migration is applied — `expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= created_at + 92 days` (the 90-day policy plus slack for an end-of-day LOCAL expiry; older rows grandfathered by a literal apply timestamp), and every live DOCUMENT link with no expiry is given 14 days from apply (listed in the inventory; quote links stay with 20261096's blocked backfill, `INTK-12`). The portal shows "link valid until …". Tests — `lib/__tests__/intakeUploadRoute.test.ts` "IntakePanel links: document links only, an expiry always, the audit row names the link"; `lib/__tests__/intakeDoorLibs.test.ts` "a link's expiry is required, in the future, and at most 90 days away"; `lib/__tests__/intakeDoorMigration.test.ts` (the CHECK, the backfill).

**Fix pass (2026-09-30, projects Round G — J1 review).** The first ceiling was `created_at + 91 days`, on the claim that the Costs tab's 90-day default passes it. It does not west of UTC in the evening: `QuotesPanel` computes the UTC date of now + 90 days and then that day's END in LOCAL time, which is 91.29 days out at 18:00 in California and 91.19 at 20:30 in New York — the CHECK would have refused a legitimate mint with a raw constraint message. The ceiling is now 92 days (the worst case over every UTC offset from −12 to +14 is under 91.5 days — UTC−12 around local noon), and the Intake tab's date picker works in the user's LOCAL calendar (`isoDateInDays` and the `min`, no more `toISOString().slice(0, 10)`), so its maximum is the 90 days `intakeExpiryFor` accepts. Tests — `lib/__tests__/intakeDoorLibs.test.ts` "SEC-5: the database ceiling (92 days) admits every end-of-day local expiry the app offers — the Costs tab's UTC-date default included" (a grid of offsets and local hours, plus the reviewer's 18:00 PDT measurement, which exceeds 91 days); `lib/__tests__/intakeDoorMigration.test.ts` (the CHECK text and the probe say 92; no `91 days` remains); the IntakePanel source pin.

**Done-when.**
- [x] No code path creates a link with a null or unbounded `expires_at` — ✓ (both mint forms require one; the database refuses one for every new row).
- [x] A `CHECK` rejects an out-of-range expiry — ✓ (pending `20261104`; 92 days, so no in-range local expiry is refused — fix pass).
- [x] Every surface that displays a link offers Revoke — ✓ (Intake tab; J4's Costs tab).

**Scope / residual.** Pending migration: `supabase/migrations/20261104_prj_roundG_intake_links.sql`. Quote links minted before J4 without an expiry stay until 20261096's backfill runs (its own blocking inventory). FOLLOW-UP for J4 (J1 second review — `QuotesPanel.tsx` is J4's file and was not edited here): the quote-link date input has no `max` and no mapping of the CHECK's refusal, so an expiry picked more than 92 days out fails with the raw Postgres text ("violates check constraint \"project_intake_links_ttl\""). Done-when 1's "both mint forms comply" holds for the DEFAULT expiry only. The fix: `max={localDateInDays(90)}` on the input, validate with `lib/intakeLinks.ts` `intakeExpiryFor` in `create()`, and map a `23514` on `project_intake_links_ttl` to "A link can live at most 90 days".

---

## SEC-6 · Zero file-type validation on the public upload door

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `app/api/intake/upload/route.ts:22` — `MAX_BYTES`
  - `app/api/intake/upload/route.ts:46, 73` — size check after full buffering
  - `app/api/intake/upload/route.ts:270` — client MIME stored verbatim
- **Related:** `SEC-1`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The route's only content check is `if (file.size > MAX_BYTES)` (`intake/upload/route.ts:46`) — no MIME test, no extension allowlist, no magic-byte sniff. This is the input side of `SEC-1`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives at HIGH. I read the whole route: across all four branches (quote, redline, new document, revision) there is no extension allowlist, no MIME allowlist, no magic-byte sniff and no antivirus hook; a repo-wide grep finds no shared upload validator that this route could be said to have skipped. The client-supplied MIME is persisted onto the object and is what R2 later replays on download, which is what makes SEC-7 exploitable.

**Mechanism.** The only check is size: `MAX_BYTES` = 100 MB, applied *after*
the whole body has been buffered, which is then buffered a second time via
`arrayBuffer()`. No extension check, no magic-byte sniffing, no allowlist. A
repo-wide search finds no malware scanning of any kind, on any upload path.

**Failure scenario.** Any file of any type up to 100 MB is accepted, stored,
and later served. `SEC-1` is the sharpest consequence; a stored malware sample
served to whoever opens it is the other.

**Remediation.** See report `11`. Minimum: sniff magic bytes, allowlist PDF and
a short image list on the unauthenticated door, reject on `Content-Length`
before reading the body, and read the body once.

**Done when.**
- A renamed `.exe` is rejected with a clear message before it reaches storage.
- An oversize upload is rejected without the body being buffered.
- The stored `ContentType` is the sniffed type in every case.

**Resolution (2026-09-30, projects Round G).** Worked with projects-and-cost `INTK-11` (J1). The route refuses on the declared `Content-Length` (100 MB + framing) BEFORE reading the body, reads the body once, and runs the magic-byte allowlist (`lib/fileSniff.ts`) before anything reaches storage; the refusal names the accepted list; the stored `ContentType` is always the sniffed type. Tests — `lib/__tests__/intakeUploadRoute.test.ts` "an oversize Content-Length is refused 413 without reading the body", "a renamed .exe is refused with the accepted list named", "an HTML page named .pdf … is refused before storage", "the stored ContentType is the SNIFFED type".

**Done-when.**
- [x] A renamed `.exe` is rejected with a clear message before it reaches storage — ✓.
- [x] An oversize upload is rejected without the body being buffered — ✓ when the client declares its length (every browser upload does); a chunked body with no length is still bounded by the platform's own request cap and refused by size after parsing.
- [x] The stored `ContentType` is the sniffed type in every case — ✓.

**Scope / residual.** No malware scanning (none exists on any upload path); presigned direct-to-R2 uploads are `INTK-15`.

---

## SEC-7 · Presigned downloads are served inline rather than as attachments

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `lib/storage.ts:118` — `getPresignedDownloadUrl`
  - `app/api/storage/download-url/route.ts:146-151` — the call site
  - `app/api/transmittal/route.ts:73` — the correct pattern, for reference
- **Related:** `SEC-1`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `GetObjectCommand({ Bucket, Key })` is signed with no `ResponseContentDisposition` (`download-url/route.ts:146-151`), so the object is served with its stored content type and renders inline. This is the delivery side of `SEC-1`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The technical claim is correct and the one-parameter fix is real. Lowered to MEDIUM because the blast radius is smaller than 'active half of SEC-1' implies: lib/r2.ts:5 presigns against `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, a different origin from the application, so an inline-rendered HTML/SVG upload cannot read the app's session or DOM — it is malware/phishing delivery from a Cloudflare-hosted URL, not stored XSS against the product. Worth noting the finding's own third citation (transmittal/route.ts:73) is the counterexample that already sets attachment, not an instance of the bug.

**Mechanism.** The route does its authorization properly —
`assertSafeStorageKey` plus an org-prefix membership check. What it omits is
`ResponseContentDisposition`, so the browser is free to render whatever it
receives rather than saving it. Two sibling routes in the same repo —
`/api/transmittal` and `/api/share/file` — set it correctly.

**Failure scenario.** This is the active half of `SEC-1`. Adding one parameter
defuses the execution path independently of every other layer.

**Remediation.** Add `ResponseContentDisposition: 'attachment; filename="…"'`
to the `GetObjectCommand` in `getPresignedDownloadUrl`, or thread a flag so the
inline case must be opted into explicitly by callers that genuinely need it
(the PDF viewer). Default to attachment.

**Done when.**
- The presigned URL carries the attachment disposition by default.
- Any caller that needs inline rendering opts in explicitly and is reviewed.
- A test asserts the header on the default path.

**Resolution (2026-09-30, projects Round G).** Built on document-control P2 EGRESS — the clamp, `no-store` and granted `expiresIn` in `app/api/storage/download-url/route.ts`, `lib/presignedLifetime.ts`, migration `20261068` — none of which is re-implemented or changed. New `lib/presignedDisposition.ts`: `presignedGetDisposition(key, inlineRequested)` returns the GET's response overrides — `ResponseContentDisposition: attachment; filename="…"; filename*=UTF-8''…` by default (the key's last segment through the existing `contentDispositionAttachment`, header-safe); `inline` only when the caller asked AND the key's extension is a PDF or a raster image (`INLINE_TYPES_BY_EXTENSION`: pdf, png, jpg / jpeg, gif, webp — no SVG, which runs script when opened as a page), and then `ResponseContentType` is pinned to that type, so the uploader's declared type is never what the browser renders. The route (`download-url/route.ts:215-220`) spreads the overrides into the `GetObjectCommand`, reads `?inline=` through `wantsInline` (only `1` / `true`) and answers `{ url, expiresIn, disposition, contentType }`. `lib/storage.ts`: `getSignedUrlForPath(path, expiresIn, { inline })` is an ATTACHMENT by default (right for `<img>`, CSS backgrounds, `fetch`, pdf.js and downloads, none of which honour the disposition) with an explicit opt-in; `resolveFileUrl` / `resolveFileUrlDetailed`, the viewers' resolvers, ask for inline; inline and attachment URLs are cached apart (`INLINE_KEY_PREFIX`, a NUL no storage key can contain). The reviewed inline callers: `SecureDocViewer` (`&inline=1`), `resolveFileUrl`'s three callers (`MultiDocViewer`, `CompareRevisionsModal`, `ReviewGateSection`'s draft preview), and the two framing viewers outside this package, each opted in with one argument so nothing that framed a PDF starts downloading it — the ticket file viewer's PDF preview frame (`app/(protected)/requests/[id]/page.tsx:563`, the `FileViewerModal` region drafting-flow DF-P10 owns for `PHYS-2` / `PHYS-9` / `EVID-5` / `EDGE-2` / `AUTHZ-12`) and the cited-page viewer's open-in-new-tab link (`components/knowledge/CitedPageViewer.tsx:123`, intelligence I-07's file for `DWG-3`, the line I-12's `KACL-5` cites). `DEC-49` names the exact expression each owner's rewrite must keep, and both are source-pinned. Every other caller — images, avatars, the logo, thumbnails, pdf.js loaders, the CAD source pull, downloads, the doc pack — gets an attachment. `app/api/transmittal/route.ts` already sent one and is not edited; the share routes are document-control P1's. Tests (`lib/__tests__/presignedDisposition.test.ts`) sign with the REAL presigner (an S3 client with inert credentials — presigning is local) and read `response-content-disposition` / `response-content-type` off the URL: "DEFAULT: attachment, named after the key — even for a PDF" (P2's 3600 s window and `no-store` asserted unchanged), "a stored HTML upload is an attachment whatever the caller asks", "inline=1 on a PDF: inline, and the Content-Type is pinned to application/pdf", "anything but an explicit opt-in is an attachment"; the pure rules (SVG / HTML / XML / JS / no extension / a double extension never inline; header folding); the client ("…the two are cached apart", "resolveFileUrl is the viewers' resolver: it asks for inline", "subscribeSignedUrl … asks for an attachment"); a census that every presigned-GET issuer under `app/api` and `lib` signs a disposition; source pins on the reviewed callers. Reproduced first: against `3ae0b06` 11 of the 21 cases failed — the signed URL carried no `response-content-disposition`.

**Done-when.**
- The presigned URL carries the attachment disposition by default — ✓.
- Any caller that needs inline rendering opts in explicitly and is reviewed — ✓ (the list above, `DEC-49`); the route grants inline only to a PDF or a raster image and pins its type, so even a reviewed caller cannot get an HTML page inline.
- A test asserts the header on the default path — ✓ (on the real presigned URL).

**Scope / residual.** Two other presigned-GET issuers sign no disposition. `/api/storage/resolve` (the archive-aware opener, whose URL `ArchiveAwareOpen` opens in a new tab) belongs to drafting-flow DF-P11, which re-checks its ACL after document-control P2; `lib/dataExport.ts:154` (the data-export envelope's per-file URLs, which `lib/exportRunner.ts:242` and `lib/clientBackup.ts:136` tell users to download by hand) belongs to admin-and-org P2. Both are recorded as the new finding `SEC-18` below and named as the census's two known exceptions — any other new bare issuer, under `app/api` or `lib`, fails the suite. Browser behaviour was not observed (no browser in this environment); `Content-Disposition: attachment` is what Chrome, Firefox and Safari honour for a top-level navigation or a frame.

---

## SEC-8 · No rate limiting on the intake door, and each upload fans out email

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** availability / abuse
- **Locations:**
  - `app/api/intake/upload/route.ts:104-113` — notification fan-out
  - `app/api/intake/upload/route.ts:349-385` — in-app + queued email + drain kick
  - `signup_attempts` table — the existing anti-abuse primitive, not wired here
- **Re-verified:** hardening pass — **SURVIVES**. No rate limit guards the intake route, and each successful upload inserts one notification row per target (`intake/upload/route.ts:104-113` and `:349-358`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives at HIGH — verified as a claim of absence. There is no middleware.ts / src/middleware.ts in the repo at all, and rate limiting exists only in app/api/auth/signup/route.ts:42 and app/api/data-export/run/route.ts:89-90; neither covers the intake door. bump_intake_use (20260902_project_intake.sql:74-79) increments submission_count but enforces no ceiling, so a single non-expiring token yields unbounded 100 MB R2 writes and unbounded outbound mail to every Admin/DocCtrl in the org.

**Mechanism.** Nothing throttles submissions per token, per IP, or per hour.
Every upload writes an in-app notification to controllers plus the project
owner, queues email, and kicks the drain — so the door is also an amplifier.

**Failure scenario.** Anyone with a link can generate unbounded storage writes
and unbounded outbound email addressed to your controllers. No account needed.

**Remediation.** Wire the intake route to the existing attempt-tracking table
(or an equivalent): a per-token cap per hour, a per-IP cap per hour, and a
per-link lifetime use cap. Debounce the notification fan-out so N uploads in a
window produce one digest rather than N emails.

**Done when.**
- The Nth upload within a window is rejected with a 429 and a readable message.
- A burst of uploads produces at most one notification per recipient per window.
- Limits are configurable without a code change.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-8` / `INTK-10` (J1). New `lib/intakeRateLimit.ts`: a durable per-token (stored hashed) and per-IP hourly window in `intake_attempts` (migration `20261105`), checked before the link lookup and the body; 429 with `Retry-After` and a sentence the portal renders; FAIL OPEN on a limiter error (`GAP-401` acceptance 4); a per-link lifetime cap and byte budget (`20261104`). The project team hears at most ONE submission notice per link per 15-minute window (a displaced review is always told), through `emit()`. Fix pass (J1 review): a revision a trusted link PUBLISHED is always told (never folded); a folded notice is counted and the next one says how many more submissions arrived (`INTK-10`'s fix pass). Tests — `lib/__tests__/intakeUploadRoute.test.ts` "429 once the per-token hourly window is full", "the per-IP window counts every token from one address", "the limiter FAILS OPEN", "a link that has spent its submission budget answers 429 before the body", "a burst is ONE notice per link per window".

**Fix pass 2 (2026-09-30, projects Round G — J1 second review).** Done-when 2 was ticked without its exception: published notices (forced) and displacement notices (forced whenever a pending draft was replaced) bypassed the window, so a trusted — or leaked trusted — token re-sending its own document up to the per-token cap (30 an hour) sent every controller, the owner and the followers up to 30 notices an hour. Forced notices are now bounded (`lib/intakeRateLimit.ts` `noticeGoesOut`, `FORCED_NOTICES_PER_WINDOW` = 3): an ordinary notice goes only into an empty window; a forced one only while the window holds fewer than three notices of any kind; beyond that it is folded and counted by kind (`suppressed_published`, `suppressed_displaced`), and the next notice names them ("… (2 published without review, 1 replacing an earlier submission in review)"). Tests — `lib/__tests__/intakeUploadRoute.test.ts` "SEC-8 dw2: a burst of trusted publishes is NOT one notice per upload — at most three notices per window; the rest are counted by kind into the next notice"; `lib/__tests__/intakeDoorLibs.test.ts` (the rule and the by-kind count).

**Fix pass 3 (2026-09-30, projects Round G — J1 third review).** The folded publishes and replacements were reported only in the link's NEXT notice, so a link that went quiet after its burst left the controllers and the owner unaware that controlled revisions were published without review. The cap stays; what it folds is now always announced: `lib/intakeRateLimit.ts` `flushFoldedIntakeNotices`, run daily by the maintenance cron's intake step, sends ONE digest per link with unannounced `suppressed_published` / `suppressed_displaced` rows to the controller pool and the project owner (through `emit()`, request-scoped service role) and records a `notified` row, so nothing is counted twice or digested twice. Tests — `lib/__tests__/intakeDoorLibs.test.ts` "flushFoldedIntakeNotices — folded publishes / replacements never go unannounced" (six cases); the cron pin. (Full account: projects-and-cost `INTK-10` fix pass 3.)

**Done-when.**
- [x] The Nth upload in a window is rejected with a 429 and a readable message — ✓.
- [x] A burst produces at most one notification per recipient per window — ✓ **with a recorded exception**: a revision published without review, or a submission that replaced one in review, is told without waiting for the window — at most three notices per link per window in all (fix pass 2); every further submission in the window is folded and counted, by kind, into the next notice — or, for a folded publish or replacement no later notice announces, into the maintenance cron's daily digest (fix pass 3; one per PROJECT, each link listed — verification fix; so at most one more notice per project per day). (Before fix pass 2 the forced notices were unbounded.)
- [x] Limits are configurable without a code change — ✓ (`INTAKE_MAX_PER_TOKEN_HOUR`, `INTAKE_MAX_PER_IP_HOUR`, `INTAKE_NOTICE_WINDOW_MIN`; per link, `max_submissions` / `max_total_bytes`).

**Scope / residual.** Pending migrations: `20261104`, `20261105`. Until `20261105` is applied the limiter fails open (the house trade-off) and the per-link cap reads nothing.

**Verification fix (2026-09-30, projects Round G).** Fix pass 3's "nothing is counted twice or digested twice" and "one digest per link" did not hold. The digest's send was `emit()`, which swallows every delivery failure, and the marker write swallowed its own: a digest nobody received was marked and lost, and a lost marker repeated it. Now the cron inserts the digest's bell rows itself and checks them (`lib/intakeRateLimit.ts` `deliverFoldedDigest`); a link is marked only when they landed, and a marker that does not land is counted and reported (that link is announced again next run — repeated, never lost). The email leg is `emit()`, best-effort. Digests are ONE per project, listing each link (two links on one project had shared the email dedupe key, so the second link's email was dropped). The marker is its own outcome (`digested`) — a boundary for the fold count that the notice window does not count, so the link's next submission after a digest is told at once. Candidates are read to the two-day horizon page by page, not from the newest 1000 rows; a link whose fold count cannot be read is counted failed and retried, never skipped as announced (second verification, same date). So done-when 2's exception now reads: a folded publish or replacement no later notice announces goes into the cron's daily digest for its project — at most one per project per day. Full account: projects-and-cost `INTK-10` verification fix; tests in `lib/__tests__/intakeDoorLibs.test.ts` ("item 1" … "item 5").

---

## SEC-9 · An offboarded project owner can still delete the project, cascading away the financial and quality record

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** SUSPECTED (policy read is unambiguous; not exercised against a live database)
- **Blast radius:** data-integrity
- **Locations:**
  - `supabase/migrations/20260906_projects_hardening.sql:61-68` — `projects_delete_owner`
  - `supabase/migrations/20261013_project_controls_program.sql` — `user_owns_project()`, which does it correctly
- **Re-verified:** hardening pass — **SURVIVES**. `projects_delete_owner` is predicated on `owner_user_id::text = auth.uid()::text` (`20260906_projects_hardening.sql:61-66`) with **no `org_members.status` term**, so an offboarded owner still matches and the delete cascades the financial and quality record.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Claim holds at both layers, and the repo itself contains the corrected pattern (user_owns_project) that the delete policy was never updated to use. Repo-wide grep found no other FOR DELETE policy on `projects` and no RESTRICTIVE delete policy that would AND in an active check. The only mitigation is cosmetic: RoleContext.tsx:210-212 sets membershipState 'none' for a non-active member so the UI hard-stops — but RLS, not the SPA, is the boundary, and a deactivated user's existing JWT reaches PostgREST directly (DELETE does not require the SELECT policy to pass).

**Mechanism.** `projects_delete_owner` tests
`owner_user_id::text = auth.uid()::text` with no active-membership check —
unlike `user_owns_project()`, which correctly requires an active `org_members`
row with `status = 'active'`.

**Failure scenario.** Someone leaves and is deactivated. The write gate
correctly blocks them from editing costs. The delete gate does not block them
from destroying the project — and foreign-key cascade takes the cost accounts,
entries, change orders, checklists, turnover and punch records with it.

**Remediation.** Add the active-membership predicate to both
`projects_update_owner` and `projects_delete_owner`, or replace their bodies
with `user_owns_project(id)`. Consider also whether a project carrying posted
cost entries should be deletable at all, versus archive-only.

**Done when.**
- A deactivated owner's DELETE returns zero rows.
- A policy test pins it.
- (Decide separately) a project with financial records cannot be hard-deleted.

**Resolution (2026-09-30, projects Round G).** Reproduced: `projects_delete_owner` and `projects_update_owner` (20260906:60-68) admit `owner_user_id::text = auth.uid()::text` with no membership term. `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 2 re-creates both with the 20260906 lines kept verbatim plus ONE added line — `AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = projects.org_id AND m.uid = auth.uid() AND m.status = 'active')` — so an offboarded owner matches neither (lineDiff-pinned: the only line not in 20260906 is that one). `assertCanManageProject` (`lib/projects.ts`) now also requires an active membership before the owner branch. The decision part ("a project with financial records cannot be hard-deleted") is `DEC-54` and landed with projects-and-cost `PM-6` / `QUAL-3` in `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql`: `enforce_project_delete_guard` refuses a project carrying any cost or quality row unless `delete_project_record` — controller + reason, counts and snapshot audited — sets the purge GUC; a project under `projects.legal_hold` is deleted by nobody.
- Commits: `e0c1aa2`, `7ca202f`
- Tests: `lib/__tests__/projectRailsMigration.test.ts` "20261102 — SEC-9: projects UPDATE / DELETE are byte-faithful to 20260906 plus one active-membership line"; `projectsRls.test.ts` "the projects UPDATE and DELETE owner branches require an active org membership"; `lib/__tests__/projects.test.ts` "PM-5 / SEC-9 — who may manage a project" (a suspended owner is refused).
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql`, `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql` (inventory: projects whose owner is not an active member).

**Done-when.**
- A deactivated owner's DELETE returns zero rows — ✓ by policy (live after `supabase/migrations/20261102_prj_roundG_project_rails.sql`).
- A policy test pins it — ✓ (census + lineDiff shape).
- (Decide separately) a project with financial records cannot be hard-deleted — ✓ decided (`DEC-54`) and built (`supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql`): archive, or a controller's reasoned `delete_project_record`.

**Scope / residual.** None beyond the pending migrations.

---

## SEC-10 · The checklist route authorizes at member level but reads ACL-restricted documents with the service role

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** intelligence I-09 (app/api/flows/read is its file) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** security / data-confidentiality
- **Locations:**
  - `app/api/projects/checklist/route.ts:67` — admits any active org member
  - `lib/docFileServer.ts` — `resolveDocumentFile` uses `supabaseAdmin`
- **Re-verified:** hardening pass — **SURVIVES**. The route gates on `member.status === "active"` (`checklist/route.ts:67`) and then reads documents with the service role, so ACL-restricted content reaches a member the ACL excludes.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: any active org member can name a private/hidden or deny-listed document and get its pages read back as verbatim items — the system prompt at l.36 explicitly says 'Keep the item's own wording — do not paraphrase', and l.105 returns `{ items, pagesRead, sourceLabel: file.label }`. The service-role read bypasses RLS and the ACL layer that the download path enforces. HIGH is right (bounded to MAX_PAGES = 10 and to renderable PDFs).

**Mechanism.** The route admits any active org member, then resolves the
document through `supabaseAdmin`, which bypasses `documents_acl_select`
entirely — and returns the file's contents in the response.

**Failure scenario.** A member with no read grant on the HSE library points the
checklist reader at a restricted incident procedure and receives its verbatim
text.

**Remediation.** Before resolving the file, verify the caller can read the
document under their own identity: either re-query with the user's client and
require a row, or call the existing ACL predicate explicitly. Apply the same
check to `/api/projects/cost-docs` and `/api/companies/quality-manual` if they
resolve documents the same way.

**Done when.**
- A member without ACL read on a document receives 403 from the checklist route.
- The check is applied to every route that resolves a document via `supabaseAdmin`.
- An `apiRouteAuth.test.ts` case pins it.

**Partial (2026-09-30, projects Round G — stays OPEN for `/api/flows/read`, done-when 2 below).** `lib/docFileServer.ts` `resolveDocumentFile(orgId, documentId, reader)` takes a required `DocumentReader` (`{ uid, email, channel, labelOnly? }`) — TypeScript refuses a call without one — and makes the CALLER's content decision before any service-role file lookup: `loadReaderPrincipal` (headline + additive roles, team ids, active members only; a lookup error is 503, never a guess), then `loadContainerAclChain` — the document's library ACL, each ancestor folder's (`path_ids`, root first), its folder's, every read org-scoped; a rung that cannot be READ is 503 (*"…try again."*), never "no ACL", and a rung that does not EXIST — a stale `path_ids` id, a dangling folder or library — throws `BrokenAclChainError` and is 409 naming it (*"This document's folder chain is broken (folder … no longer exists), so access to it can't be checked. A document controller needs to repair the folder chain — trying again won't help."*), for controllers too, because the gate cannot know what the missing rung would have denied — then `documentContentDecision`, which asks the app's own read engine (`canWithAclChain`, the call the library page lists documents with) over that chain plus the document's own `acl`: wherever the chain carries an ACL it must grant `read` or `download`, on EVERY visibility — so an allow-list on a normal document, or on its folder or library, binds (the finding's scenario), and a discover-only grant is not enough (roles-and-permissions `DOCACL-5`); only a chain with no ACL at all is default-open, and only for a normal document. An explicit download deny binds everyone, controllers included — in the chain-resolved `acl_index` (uid, a held role, a team, or the org) or in the live chain itself. Then the `user_is_effective_owner` cascade when content is refused (`GAP-15` / `DEC-7`). A refused reader gets 403 *"You don't have access to read that document."*; the version and file are looked up only after the decision, so a refusal never reveals whether a file exists, and the version is BOUND to the document the decision was made on — `.eq("id", versionId).eq("record_id", documentId).eq("org_id", orgId)` (`lib/docFileServer.ts:317-323`): the pointer columns are member-writable, so a pointer on a readable document naming another document's version (current or pending, same org or not) resolves nothing — 404 *"That document has no stored file to read."*, nothing rendered, no `DEC-43` row — never the other document's pages under the first one's ACL. `DEC-43`: pages served ONLY because the reader is a controller (the same person without the controller tier would be refused — a normal document behind an allow-list included) write `CONTROLLER_RESTRICTED_READ` (`details.channel` names the route) unless ownership would have served them; a read the gate then refuses, and a `labelOnly` read, write none. Call sites: `app/api/projects/checklist/route.ts:96` (segment, `checklist_segment`), `:167` (assess — the SOW's label only when the caller may read it, `labelOnly`), `app/api/companies/quality-manual/route.ts:71` (`quality_manual`). The assess prompt's project-document titles, also a service-role read, are listed in the caller's org only (`.eq("org_id", orgId)`, `:171` — the project's `intake_collection_id` is owner-writable, so a foreign folder id lists nothing) and go through `discoverableDocuments` over the intake folder's own chain (`:174`, `:188`; `canDiscover`, the bar a member's own client applies), so a title the caller may not discover never reaches the model or the rationale it returns; a chain that cannot be read lists no titles. A check that could not RUN is told to the model as such, never as an absence that would ground an N/A proposal: *"A Summary of Work is on file but could not be checked — it was not read."* when the SOW's gate answered 503 / 409 or threw, and *"Project documents may be on file but could not be checked — their titles were not read."* when the list or its chain could not be read (`:180-209`). Tests: `lib/__tests__/apiRouteAuth.test.ts` — "SEC-10 (a): a normal document with an allow-list for team-A — a member outside team-A gets 403, nothing rendered; a team-A member is served", "SEC-10: read granted to team-A on the LIBRARY (the finding's HSE library) binds its normal documents — 403 outside team-A" (the folder rung too), "SEC-10 (b): a private document whose read grant is INHERITED from its library serves a team-A member (200)", "SEC-10: a library or folder whose ACL cannot be read is 503", "SEC-10: a pointer on a readable document naming ANOTHER document's version serves nothing — 404, nothing rendered, no row" (a member on a normal document and a controller on a private one, whose served read would be recorded; the mock resolves no row when the `record_id` filter does not match), "a folder chain with a rung that no longer exists is 409 naming it — not 'try again', and a controller gets it too", "SEC-10: a member the ACL excludes from a private document gets 403 — nothing resolved, rendered or sent to the model", "SEC-10 / DOCACL-5: a discover-only grant does not yield the pages", the read-grant / ownership pair, the download-deny case, the two `DEC-43` cases, "a membership read that fails is 503", the assess cases (restricted SOW label and hidden title kept out; a controller's prompt carries both with no row; "the intake folder's titles are read in THIS org only, and filtered over the folder's library → folder chain" — the org filter asserted on the title query's OWN builder, not on any `documents` read the request made; an unreadable chain lists none; "a check that cannot RUN is never told to the model as an absence…" for a chain read error, a broken chain and a failed list read; "a project with no SOW and an empty intake folder still says so plainly") and the quality-manual cases (including "a manual in a folder whose path_ids names a folder that no longer exists — 409 naming it, not a 'try again' 503", with the read-error twin still 503). `lib/__tests__/docFileServer.test.ts` — "SEC-10: the full chain" (library, ancestor-folder and document allow-lists; an inherited read on a private document; an inherited discover-only grant refused; an org-wide grant with a document deny; `inherit: false`; a live-chain org download deny binding an Admin; a controller-only read of a normal document recorded; three read errors that are 503 (asserted for a viewer; the Admin is covered by one quality-manual ancestor-read-error case) and four missing rungs that are 409 — a viewer and an Admin alike; org-scoped chain reads; the chain order); the version binding ("SEC-10: the version is bound to the document the decision was made on…": a current or pending pointer naming another document's version, for a viewer and an Admin, is 404 with no `DEC-43` row, and the version read's filters are asserted to be exactly `id`, `record_id`, `org_id` — the mock honours `.eq()` on `document_versions` in every case of the file, so each served case also proves the version matched); a property that the gate never serves what read-or-download over the chain would refuse, which also names its one divergence from the library page — the page LISTS by `read` alone, while the gate, like the bytes egress, serves a download-only grant (`viewer` / `manager × privateDownloadGrant`, asserted as the exact set); and the parity matrix, which runs the REAL egress route and the real gate over 4 principals × 11 documents × owner / not-owner and asserts the gate is never looser, records at least what the egress route records, and differs ONLY in the named `STRICTER_THAN_EGRESS` cases (a normal document's allow-list; an org-subject download deny). Reproduced first: against `3ae0b06` the excluded member was served a private document's pages (200) and every SEC-10 case failed; the chain cases were then run against this package's first gate (`8afc61b`, the document's own ACL only), where 32 of them failed — the normal-document allow-list was served, as the review found. The second review's cases were run the same way against `71aa890` by mutation: without the `record_id` filter the two forged-pointer cases fail; with a missing rung collapsed into 503 the three broken-chain cases fail; without the honest lines the assess case fails; and with the title list's `.eq("org_id", orgId)` removed the org-scope case now fails (it passed before, satisfied by the SOW's gate read).

**Done-when.**
- A member without ACL read on a document receives 403 from the checklist route — ✓: an allow-list on the document, its folder or its library excludes the member on every visibility, a discover-only grantee included (`apiRouteAuth.test.ts` (a) and the library / folder case); and a readable document's forged version pointer cannot bring another document's pages through (404, the forged-pointer cases). One path remains and is named in residual (5): a member-inserted in-review version whose `file_url` is another document's storage key.
- The check is applied to every route that resolves a document via `supabaseAdmin` — ✓ for doc-control `documents` rows, **qualified**: `resolveDocumentFile` is the only doc-control file resolver and all three call sites pass a reader (the argument is required); the checklist's title list goes through `discoverableDocuments`; `/api/projects/cost-docs` reads its own `cost_documents` row, gated controller-or-owner and pinned under `REL-6`. NOT covered: `/api/flows/read` (`app/api/flows/read/route.ts:53-80`) renders `knowledge_documents.file_key` as the service role for any controller — for a source-linked mirror that key IS the controlled version's R2 key — with no download-deny check and no `DEC-43` row. It does not go through this gate or `lib/knowledgeAccess.ts`. It is intelligence I-09's route (FLOW-*); recorded as the residual below. **Not met — this is why `SEC-10` stays OPEN**: it closes when that route reads through this gate or an equivalent.
- An `apiRouteAuth.test.ts` case pins it — ✓.

**Scope / residual.** (1) `/api/flows/read` — a controller-only service-role page read outside this gate (above). The fix belongs to its owner (intelligence I-09, cross-reference I-12 `KACL-5`, which names the mirror's `file_key` as the controlled key): resolve the mirror's `source_document_id` through `resolveDocumentFile` (channel `flows_read`) or an equivalent that honours the download deny and writes `DEC-43`, and keep upload-origin mirrors (no source document) on their own rule. (2) The gate is now STRICTER than `/api/storage/download-url`, which still evaluates only the document's own ACL and only for private / hidden documents and reads no `orgs`-subject deny — intelligence `KACL-5`. The parity matrix names each divergence; when `KACL-5` brings the egress route to the same chain, those names shrink (the census test fails if one goes stale). Until then the bytes of a normal document behind an allow-list can still be signed by the egress route: that is `KACL-5`'s open limb, not this route's. (3) The gate reads the chain through the shared engine, so it inherits the engine's zero-rule semantics: an ACL object with no rules anywhere on the chain grants nothing (intelligence `DACL-6`, I-12) — the library page hides the same documents, and when I-12 changes the engine the gate follows. (4) The title filter's ownership branch is the explicit document owner only (the cascade is asked for content), so a hidden title owned through a folder or library is left out of the prompt — failing closed. (5) `file_url` aliasing: the version is bound to the document, but its `file_url` is not bound to anything — roles-and-permissions `EGRESS-6`'s own-draft arm of `document_versions_insert_integrity` (`20261037:157`) lets a member insert an in-review version, with any `file_url`, on a document they can see, and then point that document's `pending_version_id` at it. A member who knows private document B's storage key can so have B's pages read under A's ACL. `/api/storage/download-url` shares the gap (it resolves a key's owning document with `.limit(1)` on `file_url`). The fix is a database rail — a new version's `file_url` must lie under its own document's storage prefix, or must not be another document's key — for the owner of `EGRESS-6`'s overlay; the gate does not refuse shared keys itself, because copy flows may legitimately share one. (6) A broken chain is refused, controllers included, with the repair message (409) until a document controller repairs the folder's `path_ids` (or the dangling folder / library reference). The library page (`buildFolderChain`, `documents/[libraryId]/page.tsx:1748-1756`) skips a missing rung instead, and `lib/aclIndexRebuild` skips and reports the node (`:27`), so the gate is stricter than both here — by design: it cannot know what the missing rung would have denied. (7) `app/api/transmittal/route.ts:43` (document-control P7's file) cites `lib/docFileServer.ts:26-28` for the forged-pointer comment; that comment is now `lib/docFileServer.ts:317-323`, and it binds `record_id` as well as the org — a citation for DC P7 to refresh, not edited here. Cross-reference: roles-and-permissions `03-document-control-acl.md` (`DOCACL-5`) cites this finding as the shape of a service-role re-check; for page reads the one shared helper is now `resolveDocumentFile`. `DEC-43` carries a landed line.

**Verification fix (2026-09-30, projects Round G — at merge).** A `document_versions` read error in `resolveDocumentFile` is now 503 (`DOC_ACCESS_UNVERIFIED`), never the 404 "no file" it used to fall into (`lib/docFileServer.ts`, the version read), and the assess prompt says a linked SOW with no readable file is "linked but has no readable file — it was not read", never "No Summary of Work attached" (`app/api/projects/checklist/route.ts`, `sowNoFile`). Pinned by `apiRouteAuth.test.ts` "a SOW whose version read fails is 'could not be checked'…", which fails on the previous tree.

**Resolution (2026-10-01, intelligence Round G, I-09 — `/api/flows/read`).** Reproduced first on the base route: a controller's read of a source-linked mirror rendered `knowledge_documents.file_key` as the service role without asking the document gate ("SEC-10: the controlled document gate is never asked": `expected +0 to be 1`).

What landed: `app/api/flows/read/route.ts` resolves a mirror's `source_document_id` through `lib/docFileServer` `resolveDocumentFile(orgId, sourceDocumentId, { uid, email, channel: "flows_read" })` before anything is rendered or sent. Fix pass: the gate is asked AFTER `assertAiGates` and the roster, just before the render. The first version asked it before the AI gates. A controller's restricted read then wrote a `CONTROLLER_RESTRICTED_READ` row even when the gates refused (412 / 428 / 402 / 503), and the 428 → sign → retry path wrote two rows for one read. Now a read the gates or the empty registry refuse opens no file and records nothing. So:
- an explicit download deny binds (controllers too);
- a broken folder chain is named (409), and a chain that cannot be read is 503;
- pages served only because the reader is a controller write `CONTROLLER_RESTRICTED_READ` with `channel: "flows_read"` (DEC-43).

The pages rendered are the file the gate decided on. An upload-origin knowledge document (no source document) keeps its own rule: the route is controller-only.

Second fix pass: the gate is first asked with `labelOnly: true`. That call serves no bytes, so it writes no DEC-43 row. Its answer is checked with `lib/verifyVerdict` `isPdfFile`. A mirror can lag behind its document: the current revision is republished as a DWG and no sync has dropped the stale PDF mirror yet. The route then answers 409 ("The current revision of this drawing is not a PDF — this mirror is stale … Sync the library"). It renders nothing and records nothing. The first version rendered the gate's DWG and answered a misleading 502 "could not be rendered", after writing a restricted-read row. Only a PDF is then resolved for its bytes, under the recording gate, and checked again. A revision that changes between the two asks gets the same 409.

Tests: `lib/__tests__/flowsReadRoute.test.ts` ("SEC-10 — the pages are the caller's to read": a refusal is its status with nothing rendered or sent, the call's arguments and channel; 409 / 503 before any spend; the gate's file is the one rendered; an upload skips the gate; from the fix pass, "the document gate is asked only once the read will happen …": an unsigned DocCtrl's 428 and an empty registry's 412 ask no gate, the retry after signing asks it once, and the order is gates → document gate → render → call; from the second fix pass, the order is gates → label-only gate → recording gate → render → call, "a mirror lagging a current revision that is NOT a PDF … is a 409 that says so — nothing opened, nothing recorded, nothing rendered", and "the revision changing to a non-PDF between the label and the read is the same 409 …"). The gate's own deny, chain and DEC-43 behaviour is pinned in `docFileServer.test.ts` / `apiRouteAuth.test.ts`.

**Done-when.**
- A member without ACL read on a document receives 403 from the checklist route — ✓ (2026-09-30).
- The check is applied to every route that resolves a document via `supabaseAdmin` — ✓. The one route left, `/api/flows/read`, now reads through `resolveDocumentFile`.
- An `apiRouteAuth.test.ts` case pins it — ✓ (2026-09-30). For flows/read the pins are in `flowsReadRoute.test.ts`.

**Scope / residual.** The residuals (2)–(7) above stay with their owners (KACL-5, DACL-6, EGRESS-6's overlay, DC P7's citation). They are not this route's. One case is still recorded: once the gate has resolved the file for a controller bypass, a render that then fails (502) or runs out of time (504) has fetched the controlled bytes for that reader, so it keeps its DEC-43 row. This is the same rule as the egress route, which records when the URL is issued, not when the download completes.

---

## SEC-11 · `assigned_doc_ids` is validated against nothing — not the project, not the ACL, not even the org

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED for project/ACL scope; the *absence* of an org check is CONFIRMED, cross-org exploitation is SUSPECTED (needs a foreign UUID)
- **Blast radius:** security / data-confidentiality
- **Locations:**
  - `components/projects/IntakePanel.tsx:215-232` — the write
  - `app/api/intake/resolve/route.ts:119` — `.in("id", docIds)` with **no** `org_id` filter
  - `app/api/intake/resolve/route.ts:144` — the redline query, which *does* filter by org
  - `supabase/migrations/20260903_intake_assignments.sql:20` — bare `UUID[]`, no FK, no CHECK
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `.update({ assigned_doc_ids: ids }).eq("id", l.id)` (`IntakePanel.tsx:218-219`) validates the ids against nothing — not the project, not the document ACL, not the org.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The structural claim is exactly right: nothing anywhere validates assigned_doc_ids against the project, the ACL, or even the org, and the resolve route reads them as service role with no org filter (so a UUID from another org would render on the portal). Lowered to MEDIUM because the stated scenario needs an already-privileged actor AND a UUID they cannot obtain in-product: the assign picker at IntakePanel.tsx:199-204 runs under RLS and `documents_acl_select` (20260708_acl_rls_enforcement.sql:86, `AS RESTRICTIVE FOR SELECT USING (node_visible(visibility, acl_index, org_id))`) hides a restricted HSE document from a non-controller project owner, so the restricted UUID must come from out of band.

**Mechanism.** The column has no foreign key, no check constraint and no
trigger. The authorization question asked on write is "may you manage this
link?" — never "may you see this document?" The picker runs under the user's
own policies so restricted documents do not *appear*, but the write is a plain
array update.

On the read side, `/api/intake/resolve` fetches assigned documents with
`supabaseAdmin` and no org filter, twenty lines above a query that does filter
by org — and returns document number, title, rev and status to the external
company.

**Failure scenario.** A non-controller project owner adds a restricted HSE
document's UUID to a contractor's `assigned_doc_ids`. The contractor's portal
now lists it by number and title, and can push revisions into its
`pending_version_id`. Nothing in the UI, the audit summary, or the timeline
says an out-of-project restricted document was exposed.

**Remediation.**
1. Validate on write: every id must belong to this org, be visible to the
   writer under ACL, and (decide) be scoped to this project.
2. Filter by `org_id` on every read in `app/api/intake/resolve/route.ts` — the redline query
   already shows the pattern.
3. Add a length cap on the array.
4. Consider a FK-backed join table instead of a bare `UUID[]`.

**Done when.**
- Assigning a document the writer cannot read is refused.
- The resolve route returns nothing for an id outside the link's org.
- A test covers both.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-9` (J1). Writes: migration `20261104`'s `trg_intake_links_assignment_guard` refuses a newly assigned document that is not in the link's org, that the writer holds no publish authority over (controller or `user_can_publish_on_library` on its library), or — fix pass — that the writer cannot OPEN (`doc_is_visible`, the read gate; controllers exempt), and caps the array at 500. Correction (J1 review): the first landing claimed publish authority was "stronger than can read it"; it is not — `node_visible` can deny a library publisher (an explicit deny, a restricted folder with no grant), and the SECURITY DEFINER trigger read the document regardless, so a denied publisher could have exposed a restricted document on the contractor's portal. The read check is now its own clause. Reads: `/api/intake/resolve` and `/api/intake/upload` scope every document read to the link's org. Tests — `lib/__tests__/intakeUploadRoute.test.ts` the resolve route's "an assigned id from ANOTHER org lists nothing", the upload route's "an assigned id that belongs to ANOTHER org resolves to nothing"; `lib/__tests__/intakeDoorMigration.test.ts` (the trigger).

**Done-when.**
- [x] Assigning a document the writer cannot read is refused — ✓ after the fix pass (`doc_is_visible(v_doc.doc_id)` in the trigger, beside the org and publish-authority checks; pending `20261104`). The first landing met this only for documents the publisher could also read.
- [x] The resolve route returns nothing for an id outside the link's org — ✓.
- [x] A test covers both — ✓ (route behaviour + migration shape, including the read clause and its probe; the trigger itself runs only in the database).

**Scope / residual.** Pending migration: `20261104`. Assignments are not scoped to the project (an org document assigned to a contractor for a project normally lives outside it); a FK-backed join table was not built.

---

## SEC-12 · A trusted link can publish a brand-new document into the controlled library by uploading twice

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** document-control integrity
- **Locations:** `app/api/intake/upload/route.ts:302`
- **Related:** `SEC-3` (same root cause)
- **Re-verified:** hardening pass — **SURVIVES**. `autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored` (`intake/upload/route.ts:302`) — the first upload sets `linkAuthored`, and the second therefore takes the auto path into the controlled library. Same mechanism as `SEC-3`, seen from the new-document side.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed end to end: upload 1 (title, no docId) creates a Draft document with pending_version_id set and review_state 'in_review'; the portal hands the contractor that docId back (resolve/route.ts:94-112, keyed on intake_link_id); upload 2 with that docId is linkAuthored, so the pending-review 409 is skipped and the document goes to Issued with pending_version_id cleared, leaving the Rev A row stranded at review_state 'in_review'. A fully controlled document enters the library with zero internal review — beyond the trusted flag's own stated scope ('revisions of their own documents').

**Mechanism.** `autoNow` requires an existing `docId`, so the first upload of a
new document always routes to review. Once that document row exists, the second
upload targets it by id, `linkAuthored` is true, and it publishes — even though
no human ever approved the document's existence.

**Failure scenario.** A contractor uploads a new isometric (goes to review,
sits pending), then immediately uploads Rev B. The document becomes `Issued`
with a current version and a cleared pending pointer — a fully controlled
document in the org's library authored entirely by an outside party, with the
Rev A review orphaned. Aggravated when `projects.intake_library_id` points at a
real P&ID library, which the project owner may choose with no warning
(`IntakePanel.tsx:425-430`).

**Remediation.** Require that a document has been through at least one human
approval before it is eligible for auto-supersede — e.g. gate `autoNow` on
`current_version_id IS NOT NULL`. Fixing `SEC-3` properly (first-version
authorship) also covers this.

**Done when.**
- A document that has never had an approved version cannot be auto-superseded.
- The second upload against a never-approved document routes to review.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-1` (J1): a trusted link may auto-publish only a document that has had at least one human approval (`current_version_id`), so a brand-new document's second upload goes to review; a trusted link may REPLACE its own pending submission (the displaced one is resolved 'superseded', `SAF-10`) but the replacement is reviewed too. Tests — `lib/__tests__/intakeUploadRoute.test.ts` "a link-authored document with no approved revision goes to review, and says why".

**Done-when.**
- [x] A never-approved document cannot be auto-superseded — ✓.
- [x] The second upload against a never-approved document routes to review — ✓.

**Scope / residual.** None.

---

## SEC-13 · Intake approval bypasses the library's configured review gate

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `components/projects/IntakePanel.tsx:234-246` — `finalizeReviewedRevision({ requireRosterComplete: false })`
  - `lib/reviewControl.ts:395-411`
  - `supabase/migrations/20260822_review_completion_guard.sql:46-58` — the guard that only bites when roster rows exist
- **Related:** `SEC-4`
- **Re-verified:** hardening pass — **SURVIVES**, and it is explicit in the call. `finalizeReviewedRevision({ …, requireRosterComplete: false })` (`IntakePanel.tsx:237-239`) — the library's configured review gate is switched off by the argument.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives: a repo-wide grep confirms neither app/api/intake/* nor IntakePanel.tsx ever calls effectiveReviewControlForDocument or reads review_control, so a library configured mode:'require' is never consulted on the intake path and no roster is ever created — leaving the DB completion gate with nothing to enforce. One correction to the wording, not the severity: the publish trigger's authority leg still runs (20260822:60-75, Admin/DocCtrl short-circuit else user_can_publish_on_library / user_is_effective_owner), so the approver must at least hold library publish authority — but they need not be a controller or a rostered reviewer, and zero e-signatures are recorded.

**Mechanism.** Approve passes `requireRosterComplete: false`. The upload route
never reads `review_control` and never creates `document_review_signoffs` rows,
and the database completion guard only bites when roster rows exist — they
never do.

**Failure scenario.** A library configured for mandatory two-reviewer sign-off
is satisfied by one click from one person, who need not be a controller or a
reviewer on that library's roster, with zero e-signatures recorded.

**Remediation.** Read `review_control` for the target library at submission
time and create the roster rows, then let the existing guard enforce
completion. Approval then requires the configured signatures.

**Done when.**
- A submission against a two-reviewer library cannot be published with one approval.
- The signatures appear in `document_review_signoffs` and on the revision chain.

**Resolution (2026-09-30, projects Round G).** `components/projects/IntakePanel.tsx` approve resolves the document's review policy through the container chain (`effectiveReviewControlForDocument`, `DEC-36`; a read failure refuses). When the policy REQUIRES sign-off, Approve sends the submission to the resolved roster (`openReviewRoster` on the pending version) and it publishes only through `finalizeReviewedRevision` with `requireRosterComplete: true` once the roster is complete — the signatures land in `document_review_signoffs` like any reviewed draft; `requireRosterComplete: false` is passed only when the resolved policy does not require a roster (the click is then the review). The database half: migration `20261105` re-creates `enforce_document_publish_guard` from its live body (20261070) with a block that refuses an authenticated promote of an EXTERNAL submission (a version with `intake_link_id`) in a `require` policy with no roster — RG-7 had exempted intake versions — and the door itself demotes a trusted auto-publish in such a library (`SEC-4`). Tests — `lib/__tests__/intakeUploadRoute.test.ts` "IntakePanel approve: the version on screen, the chain-resolved review policy, the MOC reference", "a library that requires sign-off (SEC-13)" demotion; `lib/__tests__/intakeDoorMigration.test.ts` "the publish guard is 20261070's body plus the two intake blocks — nothing removed" and "the intake blocks sit BEFORE the controller short-circuit".

**Fix pass (2026-09-30, projects Round G — J1 review).** In a `require` policy that resolves NO reviewer, `openReviewRoster` writes no roster (it tells the owner and Document Control), yet the panel said "was sent to its reviewers — it publishes once they sign off", and every later Approve looped on the same prompt (the guard refuses a roster-less intake promote). The panel now re-reads the roster after opening it and, with no primary slot, says "No reviewer could be resolved for … library — set its reviewers before this submission can be approved."; a roster is judged by its PRIMARY slots (a standby alternate alone reviews nothing). Source pin in `lib/__tests__/intakeUploadRoute.test.ts` "IntakePanel approve: …".

**Fix pass 2 (2026-09-30, projects Round G — J1 second review).** Two gaps on the `require` path. (1) The roster was opened with `contentHash: null`, so reviewers' `document_review_signoffs.content_hash` was NULL for every intake roster — no signature proved which bytes were reviewed (the internal submit path passes the file hash). The panel now reads the pending version's `file_hash` with its MOC reference and passes it as `contentHash`. (2) Approve opened the roster and returned BEFORE the SEC-14 MOC capture; the reviewers then signed on the document's review panel, whose publish (`finalizeReviewedRevision`) the 20261105 guard refused for a drawing-class submission with no MOC reference — and nothing on that panel could add it. The MOC is now captured before either path. The message names where the publish happens ("… it publishes when the last of them signs off on the document's review panel (in the document library), not from this tab."). Source pins in `lib/__tests__/intakeUploadRoute.test.ts` "IntakePanel approve: …" (the class read and the MOC write precede `openReviewRoster`; `contentHash` is the file hash; no `contentHash: null`).

**Done-when.**
- [x] A submission against a two-reviewer library cannot be published with one approval — ✓ (the panel sends it to the roster; finalize requires completion; the guard refuses a roster-less intake promote — pending `20261105`).
- [x] The signatures appear in `document_review_signoffs` and on the revision chain — ✓ (the ordinary roster and signing flow on the document's review panel); fix pass 2: each sign-off row carries the submission's file hash, and a drawing-class submission reaches the roster with its MOC reference, so the reviewers' final sign-off can publish.

**Scope / residual.** Pending migration: `supabase/migrations/20261105_prj_roundG_intake_review_and_attempts.sql` (apply after document-control Round F's 20261070).

---

## SEC-14 · No document-class or management-of-change gate on either intake path

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED (verified by exhaustive grep of `mocRequirementFor` / `effectiveDocClassForDocument` call sites)
- **Blast radius:** compliance (OSHA 1910.119(l))
- **Locations:**
  - `app/api/intake/upload/route.ts` — the whole document branch
  - `lib/docClass.ts` — imported by nothing under `app/api/`
  - `supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql` — adds `moc_reference` columns, no trigger, no CHECK
  - `components/documents/RevUpModal.tsx:219` — where the gate *does* exist
- **Re-verified:** hardening pass — **SURVIVES**, by absence. Neither intake path consults `docClass` or any MOC requirement before promoting a revision.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed as a claim of absence by repo-wide grep: `moc_reference`/`mocReference` appears in RevUpModal, BackfillVersionModal, Supersede/Revert/Split/Merge and the publish-contract RPCs, but never once in app/api/intake/ or in the IntakePanel approve path (which promotes an already-written version via finalizeReviewedRevision and adds no MOC). Both external routes to a live revision therefore land moc_reference NULL on a declared drawing, and no database object would refuse it.

**Mechanism.** The MOC gate lives only in two client components. There is no
database constraint on `moc_reference`, and `lib/docClass.ts` is never imported
by any API route.

**Failure scenario.** Both external routes to a live drawing revision —
trusted auto-supersede and Intake-tab approve — write a version with
`moc_reference = NULL` on a declared `drawing`. The row that lands in the
revision chain reads blank for what OSHA treats as a change.

**Remediation.** Enforce at the database: a trigger that refuses to publish a
version whose document's effective class is `drawing` (or unknown) without an
`moc_reference`, unless flagged minor. That covers every path — client, API,
and service role — at once. Then surface the requirement on the intake approve
screen so a reviewer can supply it.

**Done when.**
- Publishing a drawing revision with a null `moc_reference` fails at the database on every path.
- The intake approve UI captures the MOC reference.
- A test covers the service-role path specifically.

**Resolution (2026-09-30, projects Round G — the intake paths).** Both external routes to a live revision now carry the MOC rule. Trusted auto-publish: the promote goes through `publish_revision`, whose drawing-class MOC gate runs for the service-role caller too — a non-minor drawing revision with no MOC reference raises, and the door DEMOTES the upload to review naming the reason (the service-role path, tested). Intake approve: `IntakePanel` resolves the document class through the chain (`effectiveDocClassForDocument`; a read failure refuses) and, for a drawing, requires the reviewer to record the MOC reference on the submission (`appPrompt`, ≥ 3 characters, a checked write) before `finalizeReviewedRevision`. The database half for the approve path: migration `20261105`'s guard block refuses an authenticated promote of an external drawing-class submission with no MOC reference (the same class rule and 3-character floor as the contract). Tests — `lib/__tests__/intakeUploadRoute.test.ts` "the contract's MOC gate on a drawing (SEC-14, the service-role path)" demotion; "IntakePanel approve: … the MOC reference"; `lib/__tests__/intakeDoorMigration.test.ts` (the guard block, line-diffed).

**Done-when.**
- [x] Publishing an external drawing revision with a null `moc_reference` fails at the database on every intake path — ✓ (service role: `publish_revision`; signed-in approver: the guard — pending `20261105`).
- [x] The intake approve UI captures the MOC reference — ✓.
- [x] A test covers the service-role path specifically — ✓.

**Scope / residual.** Pending migration: `20261105`. Non-intake drafts finalized through the review path keep the MOC capture RevUpModal / check-in apply (document-control `DCK-1`'s surface) — the guard block is deliberately scoped to external submissions (`DEC-31`). J1 second review: the approve UI's capture now runs BEFORE a `require` policy's roster opens as well (it ran only on the direct path, so a roster-reviewed drawing submission reached the review panel with no reference and its final sign-off was refused) — see `SEC-13` fix pass 2.

---

## SEC-15 · Transferring project ownership is rejected by row-level security for the exact user offered the button

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED (policy read is unambiguous; not exercised live)
- **Blast radius:** ux / correctness
- **Locations:**
  - `lib/projects.ts:621-641` — `transferOwnership`
  - `supabase/migrations/20260906_projects_hardening.sql:60-65` — `projects_update_owner`
  - `app/(protected)/projects/[id]/page.tsx:977-982` — the button
  - `app/(protected)/projects/[id]/page.tsx:913` — where the raw error surfaces
- **Re-verified:** hardening pass — **SURVIVES**, and the mechanism is the `WITH CHECK`. `projects_update_owner` is `USING (is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text)` **and the same expression as `WITH CHECK`** (`20260906_projects_hardening.sql:60-65`). `WITH CHECK` evaluates against the **new** row, where `owner_user_id` is the incoming owner — so a non-controller owner transferring away fails their own policy. `transferOwnership` only checks `assertCanManageProject` first (`projects.ts:625`) and then surfaces the raw refusal.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is exactly as described — the button is offered to a plain project owner and the database rejects their transfer with the raw RLS violation text. Lowered to MEDIUM because this is a fail-closed denial of function plus a leaked internal error string, not an access-control breach: no data is exposed and no privilege is gained; the only party who loses is the legitimately authorized owner.

**Mechanism.** The policy's `WITH CHECK` is evaluated against the **new** row:

```sql
USING      (is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text)
WITH CHECK (is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text)
```

`transferOwnership` sets `owner_user_id` to somebody else, so for a plain
(non-controller) project owner both disjuncts fail on the new row.
`assertCanManageProject` passes first, so the button is live.

**Failure scenario.** The user gets `new row violates row-level security policy
for table "projects"` in an alert. The button renders for every non-owner
member with no hint that it only works for Admin or Document Control.

**Remediation.** Add a policy branch permitting an UPDATE whose `WITH CHECK`
allows the *current* owner to hand off — e.g. a `SECURITY DEFINER` function
`transfer_project_ownership(project, new_owner)` that validates the actor is
the current owner and the recipient is an active member, then writes. Also
validate the recipient's active membership (see `SEC-17` note below).

**Done when.**
- A plain project owner can transfer ownership successfully.
- Transfer to a deactivated org member is refused with a readable message.
- The button is hidden or disabled when the action is not available.

**Resolution (2026-09-30, projects Round G).** Reproduced: `projects_update_owner`'s WITH CHECK reads the NEW row's `owner_user_id`, so a plain owner handing the project to someone else fails their own policy (20260906:60-65), and `transferOwnership` surfaced the raw RLS text. `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 5 adds `transfer_project_ownership(p_project, p_new_owner, p_new_owner_name)` — SECURITY DEFINER, `search_path` pinned, row locked `FOR UPDATE`; the caller must be the project's ACTIVE owner (`user_owns_project`) or an org controller; the recipient must be an ACTIVE member of the project's org (else `The new owner must be an active member of this workspace.`); it moves `owner_user_id`, makes the recipient the roster `owner`, demotes the previous owner's `owner` row to `collaborator`, writes the `ownership_transferred` feed row and the `PROJECT_OWNERSHIP_TRANSFERRED` audit row — one transaction; EXECUTE revoked from PUBLIC and anon, granted to authenticated. The WITH CHECK is deliberately unchanged: the RPC is the path. `transferOwnership` (`lib/projects.ts`) calls it; before the migration it falls back to the direct writes, refuses an inactive recipient itself, and turns an RLS-filtered update into "Only an Admin / Document Control can transfer ownership until database migration 20261102 … is applied" instead of the raw text. The page (`app/(protected)/projects/[id]/page.tsx` MembersTab) offers "Make owner" only to a manager and only for a member who is ACTIVE in the org (`activeOrgMemberIds`), and badges an inactive member.
- Commits: `e0c1aa2`, `7ca202f`, `9363ebb`
- Tests: `projects.test.ts` "SEC-15 — ownership moves through transfer_project_ownership" (one RPC and a notice; the database's refusal of a deactivated recipient in words; the pre-migration fallback refusals); `projectRailsMigration.test.ts` "20261102 — SEC-15"; `projectPageRoundG.test.ts` "Make owner is offered only when the target is an ACTIVE member".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql`.

**Done-when.**
- A plain project owner can transfer ownership successfully — ✓ through the RPC (live after `supabase/migrations/20261102_prj_roundG_project_rails.sql`).
- Transfer to a deactivated org member is refused with a readable message — ✓ (RPC and the pre-migration path).
- The button is hidden or disabled when the action is not available — ✓ (hidden for non-managers, the current owner, and any member not active in the org).

**Scope / residual.** Before `supabase/migrations/20261102_prj_roundG_project_rails.sql` is applied a plain owner still cannot transfer (they are told why, in words).

---

## SEC-16 · The project owner can read a link's raw token and act as the contractor

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J11 (running: its SEC-19 token hashing and mint-once lists meet done-when 1 once 20261141 is live — reconciled at its merge) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED as a mechanism; SUSPECTED as a practical concern (requires an already-privileged actor)
- **Blast radius:** audit integrity
- **Locations:**
  - `components/projects/IntakePanel.tsx:145, 350-353` — token read and copy
  - `supabase/migrations/20260913_projects_rls_recursion_fix.sql:99-102` — `project_intake_links_select`
- **Re-verified:** hardening pass — **SURVIVES**. The token is generated client-side (`IntakePanel.tsx:145`) and stored on a `project_intake_links` row the project owner can read, so the owner holds the contractor's credential.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives at MEDIUM as filed. The project owner reads the raw token and can drive /api/intake/upload as the contractor, where the write runs as service role with `user_id: null, user_email: link.contact_email` (upload/route.ts:390) and `created_by_name: company` (:310) — so the record attributes the publish to the outside firm, and the service-role path skips the publish trigger entirely (see SEC-4). Needs an already-privileged actor, so MEDIUM is the right band.

**Mechanism.** Link SELECT is correctly scoped to controllers plus the project
owner (it was org-wide in `20260902` — that was a real fix). But a
non-controller owner can read the 40-character token of a trusted link and POST
to the upload route themselves. The resulting audit row records
`user_id: null`, `user_email: <link contact_email>`, and
`details.company: <company>`.

**Failure scenario.** The publish is attributed to the outside firm, not to the
human who did it, and it skips the publish guard. It needs an already-privileged
actor, so it is not an escalation — it is the cleanest audit-evasion path in
the system.

**Remediation.** Do not return the raw token to the client after creation.
Show it once at mint time, store a hash, and offer "copy link" via a
server-side endpoint that logs who copied it. At minimum, record the
authenticated session (when present) alongside the link attribution on intake
writes, so a token used from inside the app is distinguishable.

**Done when.**
- The raw token is not retrievable from the client after the creation response.
- An intake write made while an app session is present records that session.

**Partial (2026-09-30, projects Round G).** Done-when 2: a contractor token used from a browser that is also signed in to the app records that session — the portal sends the app session's bearer token when one exists, the door verifies it (`supabaseAdmin.auth.getUser`) and writes `details.appSession = { userId, email }` on the intake audit row (quote, redline and document branches). Test — `lib/__tests__/intakeUploadRoute.test.ts` "a token used from a browser signed in to the app records that session on the audit row".

**Done-when.**
- [ ] The raw token is not retrievable from the client after the creation response — **not done**: the Costs tab's quote-link list (`components/projects/cost/QuotesPanel.tsx` — J4's file) reads `token` for its Copy and RFQ actions, so a column-privilege `REVOKE SELECT (token)` would empty that list; the Intake tab still reads it for Copy link too. Needs both lists moved to a mint-once display (or a server copy endpoint) before the privilege can be revoked; hashing at rest is recorded as `SEC-19`.
- [x] An intake write made while an app session is present records that session — ✓.

**Scope / residual.** Stays OPEN for Done-when 1 (a QuotesPanel + IntakePanel change plus a `20261104`-style column REVOKE).


**Resolution (2026-10-01, projects Round G — reconciled by the integrator at the J11 merge).** Done-when 1 is met by projects J11's `SEC-19` work, not by a change here. The integrator verified it against the merged code; J11 did not touch this record.
- **Mint-once lists.** The Intake tab and the Costs tab's quote-link list read `token_prefix` first (`components/projects/IntakePanel.tsx:103-119`, `components/projects/cost/QuotesPanel.tsx:1224-1231`, via `lib/intakeLinks.ts` `firstReadWithColumns` / `linkCredentialView`).
- **The URL is shown once.** A link's address is shown only from the creation or re-issue response, kept in the tab's own memory (`freshUrls`). A lost address is re-issued, never read back.
- **The token is gone at rest.** `20261141` hashes every stored token and nulls the plain column, and its CHECK `project_intake_links_no_plain_token (token IS NULL)` keeps it null. After the paste, no client read can return a working token.

**Done-when.**
- [x] The raw token is not retrievable from the client after the creation response — once `20261141` is applied. Until then the lists fall back to the plain column, as before.
- [x] An intake write made while an app session is present records that session — ✓ (Partial above).

**Scope / residual.** Pending migration: `20261141`. Its deploy prerequisite: the J11 build is live and open tabs have reloaded (see `SEC-19`).

*J12 fix pass 7 (2026-10-02): this report's progress table read SEC-16 OPEN, while this record's Status line, its Resolution block (reconciled by the integrator at the J11 merge) and both its done-whens say RESOLVED, pending `20261141`. The table row was stale, and it now reads RESOLVED. The projects-tab README's "19 / 21" for this report already counted it: SEC-10 and SEC-21 are the two open findings.*
---

## SEC-17 · `project_documents` is writable by any active org member

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED gap; SUSPECTED impact
- **Blast radius:** data-integrity
- **Locations:**
  - `supabase/migrations/20260609_phase1_normalization.sql:194-197` — `FOR ALL` to any active member
  - `supabase/migrations/20260913_projects_rls_recursion_fix.sql:79-86` — `project_members_write`, for contrast, correctly gated
- **Related:** `SAF-17` (detach amputates the timeline)
- **Re-verified:** hardening pass — **SURVIVES**. `project_documents_member_all FOR ALL` with active-member membership in both `USING` and `WITH CHECK` (`20260609_phase1_normalization.sql:194-197`) — the same `FOR ALL`-with-membership shape catalogued in `document-control/DRLS-1`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives. A repo-wide grep finds no later migration that narrows project_documents (only the CATCHUP file repeats the same policy), and audit_logs carries only an INSERT policy (20260813_acl_close_gaps_and_audit_scope.sql:84-85) — no ACL SELECT policy — so the leak channel the finding describes is real, and the detach half is unguarded too. One citation error worth noting: the second cited location, 20260913_projects_rls_recursion_fix.sql:79-86, is `project_members_write`, not a project_documents policy; the substantive claim rests entirely on the 20260609 lines and holds there.

**Mechanism.** The policy is `FOR ALL` to any active org member. The
`ProjectDocumentsCard` gates attach and detach on `canManage`; the database does
not.

**Failure scenario.** A member can attach a document UUID they cannot read,
whose audit events then flow into that project's timeline.
`document_versions` is separately ACL-gated so the leak is limited to
`audit_logs`, which has no ACL SELECT policy. A member can also detach
documents from a project they do not manage — which, per `SAF-17`, erases that
document's history from the project view.

**Remediation.** Narrow the policy to owner-or-controller for INSERT/DELETE,
matching `project_members_write`. Keep SELECT at member level.

**Done when.**
- A non-managing member's attach and detach both return zero rows.
- The card's `canManage` gate and the policy agree.

**Resolution (2026-09-30, projects Round G).** Worked with projects-and-cost `PM-8` (same defect; drafting-flow `PROJ-3` closes by pointer). Reproduced: `project_documents_member_all` FOR ALL with active-org-membership in USING and WITH CHECK (20260609:192-197), the table's only policy. `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 4 DROPS it (not supplemented — cluster 3 / `DRLS-1`) and creates one policy per verb: SELECT `project_visible_to_me(project_id)`; INSERT `is_org_controller(org_id) OR can_manage_project(project_id)` (the fleet plan's predicate — owner / Admin / Manager / roster owner-or-collaborator, 20261047; second fix pass); UPDATE / DELETE `is_org_controller(org_id) OR is_project_owner(project_id)` (active owner, 20261047) — a detach or a moved link; every write with WITH CHECK `org_id = project_org(project_id)`. The detach is exactly the card's `canManage` (owner or Admin/DocCtrl); the card offers Attach to the same set, which the database admits. `checkouts_resync_project_documents` is re-created SECURITY DEFINER with `search_path` pinned (lineDiff: 20260609's body plus two guards — it links only a session whose org is its project's org, and, for a signed-in caller, only the caller's OWN session into a project the caller can see: `IF auth.uid() IS NOT NULL AND (NEW.user_id IS DISTINCT FROM auth.uid() OR NOT project_visible_to_me(NEW.project_id)) THEN RETURN NEW`), so a collaborator's checkout still links its document and nobody plants a register row through the definer. The card writes its `doc_added` / `doc_removed` rows through `writeActivity` (checked; author stamped by the database — `PM-7`) and checks the detach's row count.
- Commits: `e0c1aa2`, `9363ebb`
- Tests: `projectsRls.test.ts` "SEC-17 / PM-8 — project_documents" (no FOR ALL in the final policy set; per-verb predicates; no later migration re-creates `project_documents_member_all`); `projectRailsMigration.test.ts` "20261102 — PM-8 / SEC-17: the register" (the resync body is 20260609's plus exactly the two guards; "SEC-17: a signed-in caller cannot plant a register row through the definer — the guard is probed by the paste-back"); `projectPageRoundG.test.ts` "a viewer who cannot manage sees no attach or remove control".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` (inventory: `manual` rows — attacher unrecorded — and rows whose org is not their project's org).

**Done-when.**
- A non-managing member's attach and detach both return zero rows — ✓ by policy (live after `supabase/migrations/20261102_prj_roundG_project_rails.sql`): "managing" is `can_manage_project` for an attach, and the owner or a controller for a detach. The card also refuses a zero-row detach in words.
- The card's `canManage` gate and the policy agree — ✓ for detach, where both are owner-or-controller. For attach the card is the narrower of the two. It offers Attach to owner-or-controller, and the database also admits the project's managers, so the card never offers a write the database refuses. A manager's attach through the lib (split / merge carry-over, adoption) is not offered by the card.

**Scope / residual.** The fleet plan proposed `can_manage_project` for the write predicate; the findings' contract (this finding's remediation, `PM-8` dw1 and `SAF-17` dw3) names owner-or-controller, which is narrower (a collaborator's checkout still links through the definer trigger). Recorded in `DEC-54`. *Fix pass (2026-09-30):* the first cut's definer trigger checked only the org, and `checkout_sessions` is writable by any active member (FOR ALL, schema.sql) with `project_id` unguarded — one INSERT, or a PATCH moving someone else's session, still wrote a `checkout` row into any same-org project's register, private ones included (the drawing on its Documents tab and export, its history on the timeline). The caller guard above closes it; the paste-back probes it. The narrower write predicate also refuses two writers in other packages that swallow the error — the split / merge register carry-over (`lib/documentLifecycle/common.ts` `copyProjectMembershipToDoc`, document-control: a document owner who does not own every project listing the document gets the whole upsert refused, so the new sheets fall out of every register) and `adoptDocument`'s register link (`lib/transitionIn.ts`, projects-and-cost PC-1 / J1: a collaborator's adoption is not linked). Recorded in `DEC-54`; handed to those owners (surface the refusal, or route the write through the register's authority). *Second fix pass (2026-09-30):* the INSERT predicate now follows the fleet plan (`is_org_controller OR can_manage_project`), so those two writers land for anyone who manages the project. A document owner who neither manages the project nor is a controller is still refused, and a merge's second upsert over an existing row still meets the owner-only UPDATE. Both are recorded in projects-and-cost `PM-8` and remain handed off. UPDATE and DELETE stay owner-or-controller (`SAF-17`). *Third fix pass (2026-09-30):* the owner-or-controller UPDATE refused every upsert that met an existing row, for the managers the INSERT admits. That covered `adoptDocument`'s re-link and a merge's carry-over over a row already written, and both swallow the refusal. The INSERT also let an org Manager off a private project's roster write into a register they cannot see, because `can_manage_project` admits a Manager whatever the project's visibility. Now:
- **Links never move.** `trg_project_documents_link_fixed` (BEFORE UPDATE) refuses, for a signed-in caller, an UPDATE that changes `project_id` or `document_id`. So the rule that a moved link is a detach no longer needs the UPDATE policy.
- **UPDATE follows the plan.** USING `is_org_controller(org_id) OR can_manage_project(project_id)`, and WITH CHECK the same `AND org_id = project_org(project_id) AND project_visible_to_me(project_id)`.
- **INSERT gains the visibility line.** Its WITH CHECK now also requires `project_visible_to_me(project_id)`.
- **DELETE, the detach, stays owner-or-controller.**

dw1 now reads: a member who does not manage the project, or who cannot see it, gets zero rows on attach; on detach, anyone but the owner or a controller does. The card is unchanged, and still narrower than the database for attach.

Tests: `projectsRls.test.ts` "SEC-17 / PM-8 — project_documents"; `projectRailsMigration.test.ts` "an attach and an upsert's update follow the fleet plan…". The paste-back probes both policies and the trigger.

---

## SEC-18 · The archive-aware opener and the data-export envelope sign presigned downloads with no disposition

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects J11 PROJECTS RESIDUALS — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `app/api/storage/resolve/route.ts:86` — `getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: path }), …)`, no `ResponseContentDisposition`
  - `components/archive/ArchiveAwareOpen.tsx:35` — `window.open(body.url as string, "_blank", "noopener")`
  - `lib/dataExport.ts:154-157` — the data-export envelope signs a bare `GetObjectCommand({ Bucket: R2_BUCKET, Key: path })` per file; `lib/exportRunner.ts:242` and `lib/clientBackup.ts:136` tell the user to download those URLs by hand
- **Related:** `SEC-7`, `SEC-1`
- **Independently verified:** — (`author`: opened by projects Round G while resolving `SEC-7`, per `DEC-31`; not yet challenged)

**Mechanism.** `SEC-7` put a disposition on every URL `/api/storage/download-url`
signs — an attachment by default, inline only for a PDF or a raster image with
its type pinned (`DEC-49`). `/api/storage/resolve` is the second presigned-GET
issuer. It signs the bare `GetObjectCommand`, so the object is served with its
stored type — for an intake upload, whatever the uploader declared — and
`ArchiveAwareOpen` opens that URL in a new tab, where an HTML or SVG upload
renders as a page. The third is the data-export envelope (`lib/dataExport.ts`):
every file it lists carries a bare presigned GET, and the export's own messages
send the admin to open them.

**Failure scenario.** The `SEC-7` scenario through the "open" link of an
archive-aware file list: a stored `payload.html` opens as a page on the storage
origin (phishing or malware delivery — the origin is R2's, not the app's, which
is why this is MEDIUM, as `SEC-7` was). Or: an admin runs the JSON export and
opens a listed URL for an intake upload stored as `text/html`; it renders
inline on the R2 origin.

**Remediation.** Spread
`presignedGetDisposition(path, wantsInline(req.nextUrl.searchParams.get("inline"))).overrides`
into the route's `GetObjectCommand` (one line, as `download-url` does) and have
`ArchiveAwareOpen` — a new-tab viewer — pass `inline=1`. Owned by
drafting-flow DF-P11, which re-checks this route's ACL after document-control
P2 (the same file). In `lib/dataExport.ts`, spread
`presignedGetDisposition(path, false).overrides` (always an attachment — the
export is a download) into the per-file `GetObjectCommand`; owned by
admin-and-org P2 (the export contract). Then remove each from `KNOWN_UNSIGNED`
in `lib/__tests__/presignedDisposition.test.ts`.

**Done when.**
- The resolve route's URL carries the attachment disposition by default, and inline only for a PDF or a raster image with its type pinned.
- Every per-file URL in the data-export envelope carries the attachment disposition.
- The census in `presignedDisposition.test.ts` (which scans `app/api` and `lib`) has no known exception.

**Resolution (2026-10-01, projects Round G).** Package J11 PROJECTS RESIDUALS (assigned by the integrator; the record's earlier owners, drafting-flow DF-P11 and admin-and-org P2, were not built on this base). Reproduced first: at `55e281d` `app/api/storage/resolve/route.ts:86` signed `new GetObjectCommand({ Bucket: R2_BUCKET, Key: path })` and `lib/dataExport.ts:154-157` the same, with no response override — the new test file below fails 5 of its 6 cases against them (the signed URL carries no `response-content-disposition`; the opener asks for no inline). Fixed with DEC-49's helper, no second rule:
- `app/api/storage/resolve/route.ts` — `presignedGetDisposition(path, wantsInline(req.nextUrl.searchParams.get("inline")))` is spread into the `GetObjectCommand` (the `download-url` line), and the answer carries `disposition` / `contentType` as `download-url`'s does. An ATTACHMENT by default; INLINE only when asked AND the key names a PDF or a raster image, whose Content-Type is then pinned. The ACL, the archive answers, the `PRESIGNED_MAX_SECONDS` ceiling and `no-store` are unchanged.
- `components/archive/ArchiveAwareOpen.tsx` — the new-tab opener asks `&inline=1` (a reviewed inline caller, source-pinned): a PDF still opens in the browser's viewer, an HTML / SVG upload downloads. The two other callers of the route (`VersionHistoryPanel`'s download, which fetches the bytes, and the restore page's existence probe) ask for nothing and are unaffected — `fetch` ignores the disposition.
- `lib/dataExport.ts` — every per-file URL in the envelope is signed with `presignedGetDisposition(path, false).overrides` — always an attachment named after its key (the export is a download).
- `lib/__tests__/presignedDisposition.test.ts` — the census's `KNOWN_UNSIGNED` set is gone; it now requires `download-url`, `resolve` and `dataExport` among the issuers and fails for ANY presigned-GET issuer under `app/api` or `lib` that signs no disposition.
Tests — new `lib/__tests__/sec18ResolveExportDisposition.test.ts`, signing with the REAL presigner (only the HeadObject `send` is stubbed): "DEFAULT: an attachment named after the key, no type pinned, never cacheable", "a stored HTML / SVG upload is an attachment whatever the caller asks", "inline=1 on a PDF or a raster image: inline, with the type pinned", "the archived answer is unchanged", "the new-tab opener asks for inline — it is a reviewed inline caller", and `runOrgExport` "an intake upload stored as HTML, a PDF and a logo: each URL carries the attachment disposition and no type".

**Done-when.**
- The resolve route's URL carries the attachment disposition by default, and inline only for a PDF or a raster image with its type pinned — ✓.
- Every per-file URL in the data-export envelope carries the attachment disposition — ✓.
- The census in `presignedDisposition.test.ts` (which scans `app/api` and `lib`) has no known exception — ✓.

**Scope / residual.** None for this finding. `DEC-49`'s two named exceptions are closed (a *Landed* line records it). Browser behaviour was not observed (no browser here); the disposition is read off the real signed URL. Serving untrusted uploads from a separate origin stays `GAP-401` item 4.

---

## SEC-19 · Contractor intake tokens are stored in plaintext — any read of the table is a working door credential

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** projects J11 PROJECTS RESIDUALS — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (by reading)
- **Blast radius:** security
- **Locations:**
  - `supabase/migrations/20260902_project_intake.sql:22` — `token TEXT NOT NULL UNIQUE`
  - `app/api/intake/upload/route.ts`, `app/api/intake/resolve/route.ts` — `.eq("token", token)` lookups
  - `components/projects/IntakePanel.tsx`, `components/projects/cost/QuotesPanel.tsx` — read `token` back for Copy link / RFQ
- **Related:** `SEC-16`, projects-and-cost `INTK-6`, `DEC-45`
- **Independently verified:** — (`author`: opened by projects Round G package J1 while resolving `SEC-16`, per the plan's decision to defer hashing; not yet challenged)

**Mechanism.** The door's credential is stored as the plain value it compares against, so anything that can read `project_intake_links` — a signed-in controller or project owner, the SQL console, a service-role code path — holds every live link. Exports redact it (`DEC-45`), but the live table does not.

**Remediation.** Store `token_hash` (SHA-256) and a short display prefix; mint shows the full URL once; both public routes look up by the hash; the lists show the prefix and offer "re-issue" instead of "copy".

**Done when.**
- No column of `project_intake_links` holds a usable token.
- Both public routes resolve a link by the token's hash.
- A lost link is re-issued, never read back.

**Resolution (2026-10-01, projects Round G).** Package J11 PROJECTS RESIDUALS, the plan's default (SHA-256 hex of the token, compared by hash; links minted before the migration hashed in place). Reproduced first: at `55e281d` `project_intake_links.token` held the plain credential (`20260902:22`), both public routes looked a link up with `.eq("token", token)`, and the Intake and Costs tabs selected `token` to build Copy link / the RFQ.
- **Migration `20261141_prj_roundG_intake_token_hash_and_adoption.sql`** (section 1): `token_hash` (sha256 hex) and `token_prefix` (six characters, so a person can tell links apart) are added; `token` loses NOT NULL and every existing link is **hashed in place** (its token nulled) — the contractors' URLs keep working, because the routes hash what is presented. `trg_project_intake_links_hash_token` (BEFORE INSERT OR UPDATE, search_path pinned, not SECURITY DEFINER, EXECUTE revoked from PUBLIC and anon) hashes any `token` a writer sends — the tabs' mint, a re-issue, an older client, the org restore's revoked placeholder — and nulls it; writing `token_hash` / `token_prefix` directly on an existing link is refused (the credential changes only by re-issue). `CHECK project_intake_links_no_plain_token (token IS NULL)` keeps the table itself free of a usable token whatever writes it; `token_hash` carries a unique partial index (the lookup key). 20261104's TTL CHECK, budget columns and `bump_intake_use` grants are untouched. DEC-30 inventory (counts only): links, links stored in plain before apply, live links, shared tokens (expect 0). **DEPLOY PREREQUISITE (review fix pass):** the hash-in-place is irreversible and code from before J11 looks a link up by the plain token and builds Copy link / the RFQ from it — pasted before the J11 build is live, or followed by a code rollback, it would break every contractor link (404 "link invalid") and hand a PM `/submit/null` to send. The header says so, and the FIRST statement refuses to run (a sentence, nothing changed) until the operator uncomments `SET app.j11_deployed = 'yes';` above it — on the scratch cluster, the file as shipped stopped there with the token, the columns and the trigger untouched, and with the line uncommented every probe read `t`.
- **Both public routes resolve a link by the hash**: `lib/intakeLinks.ts` `readIntakeLinkByToken` (`.eq("token_hash", sha256)`; on a database without the column — before 20261141 — the plain column, so the door works on either side of the paste); `app/api/intake/upload/route.ts` passes the `tokenHash` the rate window already keys on, `app/api/intake/resolve/route.ts` `sha256Hex(token)`.
- **Mint once, re-issue never read back**: `components/projects/IntakePanel.tsx` and `components/projects/cost/QuotesPanel.tsx` mint with `newIntakeToken()` and keep the address for the session only (`freshUrls`) — "shown only this once"; the lists select `token_prefix` (the plain column only before 20261141, `firstReadWithColumns`), show `prefix…`, and offer **Re-issue** (`reissueIntakeLink`: a new token on the same live link — its id, authorship, assignments, history and budget stay; the old address stops working; zero rows refused; audited `INTAKE_LINK_REISSUED` naming the link, never token material) where Copy link / RFQ used to read the token back. *Review fix pass 2:* "live" is not revoked AND not expired — `reissueIntakeLink` also filters `expires_at` (null, or later than now) and refuses an expired link with a sentence ("an expired link is not revived: create a new one"), and the Costs tab's quote-link rows offer no RFQ, Copy link or Re-issue on an expired link (`QuotesPanel` `linkLive`, the Intake tab's gate). Before the fix the docstring said "only a live (unrevoked) link", the update filtered `revoked_at` only, and a PM could re-issue an expired quote link and send an RFQ whose new address answered "This link has expired."
- **DEC-45 unchanged in kind**: `lib/exportTables.ts` redacts `token_hash` and `token_prefix` with `token` (the hash is what a presented token is matched by — reinstating it from a backup would revive the link; the coverage tripwire names both as credential columns), and a restored link still arrives REVOKED with an unguessable placeholder the trigger hashes.
Tests — `lib/__tests__/prjRoundGJ11Migrations.test.ts`: the one-paste shape; "adds token_hash / token_prefix … hashes every existing link IN PLACE before the trigger exists"; "the trigger hashes any written token and nulls it; a direct hash write on an existing link is refused"; "the database holds no usable token (CHECK)…"; "the database's hash is the routes' hash" (the probe's vector is node:crypto's); "20261104's TTL CHECK … not touched"; the lib — "readIntakeLinkByToken looks a link up by the token's hash — never by the token", "before 20261141 … it reads the plain column; any other error is returned", "both public routes find the link through it", "the lists show a prefix, never read the token back…", "re-issue writes a NEW token on the live link only, refuses zero rows, and audits the link — never token material" (review fix pass 2: the update's filters include the expiry, and the refusal names it), "DEC-45: the export redacts the hash and its prefix"; `lib/__tests__/quotesPanelRender.test.ts` (review fix pass 2) "SEC-19 — an expired quote link offers no Re-issue, RFQ or Copy link" (rendered: the expired row's only button is Revoke; a live row with no known address offers Re-issue — fails against the first landing). The intake route suites (`intakeUploadRoute`, `intakeAutoPublishAcks`, `dcRoundFReviewGate`) now seed links as the migrated table holds them (`token: null`, `token_hash`) and pass unchanged otherwise. **Scratch PostgreSQL 16 cluster** (a Supabase-shaped stub: `auth.uid()` from the JWT claim, anon / authenticated / service_role, default grants): 20261141 applied in one paste, every probe `t`; two plain links hashed in place (`sha256('abc')` = node's); an owner's insert stored `token NULL`, the hash and `newtok`; a re-issue re-hashed; a direct `token_hash` write refused; a revoke passed; a service-role placeholder hashed; with the trigger disabled the CHECK still refused a plain token; a lookup by hash found the link, by the old token nothing.

**Done-when.**
- No column of `project_intake_links` holds a usable token — ✓ (pending `20261141`: hash + CHECK).
- Both public routes resolve a link by the token's hash — ✓.
- A lost link is re-issued, never read back — ✓ (both tabs).

**Scope / residual.** Pending migration: `20261141` — **DEPLOY PREREQUISITE: apply only after the J11 build (`readIntakeLinkByToken`, the `token_prefix` lists, re-issue) is live in production; a code rollback to a build before J11 after apply breaks every link (the plain tokens are not kept — the only way back is re-issuing each link).** The file's first statement enforces the order with an acknowledgement line. A browser tab opened before the deploy still runs the old Intake and Costs tabs until it reloads; such a tab copies a `/submit/null` address once the file is applied. The update pill offers the reload within five minutes or on focus, so let open tabs reload first (integration, 2026-10-01, from the final review). Until it is applied the plain column is still read (the fallback) — the paste closes it. `token_prefix` is six of forty characters (not a credential). This also makes projects-tab `SEC-16` done-when 1 ("the raw token is not retrievable from the client after the creation response") true once 20261141 is live — `SEC-16` is not this package's record; its owner should cross-reference.

---

## SEC-20 · Audit rows about a private project are readable by every org member

*Numbered SEC-20 on this branch: package J1, in parallel, opened `SEC-19` (intake tokens stored in plaintext) in this report. If the numbers collide at merge the integrator renumbers.*

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects J11 PROJECTS RESIDUALS — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (policy read; not exercised against a live database)
- **Blast radius:** data-confidentiality
- **Locations:**
  - `supabase/schema.sql:1122` — `audit_logs_org_access … FOR SELECT USING (org_id IN (SELECT my_org_ids()))`
  - `supabase/migrations/20261063_rp_roundE_audit_view_capability.sql:175` — `audit_logs_admin_trail`, the RESTRICTIVE overlay, which narrows only the org-level authority trail
  - `lib/checklists.ts:87-93`, `lib/turnover.ts:121-127`, `lib/changeOrders.ts:113,191`, `lib/costs.ts:111-117`, `lib/costDocs.ts:78-84` — the controls program's audit writers (`resource_type` `project` / `cost`)
  - `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql` `delete_project_record` — the snapshot of a deleted project's cost and quality rows is written as `PURGE_PROJECT_SNAPSHOT`, inside the overlay (audit viewers only); `PROJECT_DELETED` carries counts, not rows
- **Related:** `SEC-2`, `SAF-6`, projects-and-cost `PM-6`
- **Independently verified:** — (`author`: opened by projects Round G while resolving `SEC-2` / `SAF-6`, per `DEC-31`; not yet challenged)

**Mechanism.** `SEC-2` made the controls and cost TABLES follow
`project_visible_to_me`. Their audit rows did not move with them: every
`audit_logs` row is readable by any active member of its org (the base
`audit_logs_org_access` policy), and the only overlay (`audit_logs_admin_trail`)
restricts the org-level authority trail (members, roles, capability policy,
exports), not project rows. The controls program writes its decisions there with
their content — `COST_DOC_AWARDED` (vendor, total), `CHANGE_ORDER_*` (number,
amount, reason code), `TURNOVER_REVIEWED` (item, status, note),
`CHECKLIST_ITEM_UPDATED` (the ruling). Since projects-and-cost `PM-6`,
`PROJECT_DELETED` carries the counts of a deleted project's rows. The
serialized snapshot of those rows is kept deliberately: it is the only
surviving record of a regulated project a controller chose to delete. It is
written as a separate `PURGE_PROJECT_SNAPSHOT` row, which the existing
overlay's `PURGE_%` clause already limits to `admin.audit_view` holders.

**Failure scenario.** A member who is not on a private MOC project reads its
award amounts and change-order values with one PostgREST query on `audit_logs`
filtered by `resource_type = 'project'` / `'cost'` — the same data `SEC-2` now
hides in the tables. The project's Activity tab (`SAF-6`) is not the channel:
it opens only for someone who can see the project.

**Remediation.** A RESTRICTIVE SELECT overlay on `audit_logs` for
`resource_type IN ('project', 'cost')`: visible when the caller holds an
audit-viewing role (the `audit_logs_admin_trail` role set), or the row's
project is visible to them — `project_visible_to_me(resource_id::uuid)` for
`project`, and through the cost row's project for `cost` (a `cost_project_id`
helper, SECURITY DEFINER). A deleted project resolves to invisible for
everyone but the audit roles, which is the intent for a `PROJECT_DELETED`
snapshot. Keep the insert policy as it is.

**Done when.**
- A member who cannot see a private project receives zero `project` / `cost` audit rows for it.
- The audit roles still read every row (the `/admin/audit` page is unchanged for them), including `PROJECT_DELETED` and `PURGE_PROJECT_SNAPSHOT`.
- A policy census pins it (extend `lib/__tests__/projectsRls.test.ts`).

**Resolution (2026-10-01, projects Round G).** Package J11 PROJECTS RESIDUALS. Reproduced first: the NEWEST definition of the overlay is `20261063` (`grep -n "CREATE POLICY audit_logs_admin_trail"` finds 20261045 and 20261063 only) — it narrows only the org-level authority trail, so with the base `audit_logs_org_access` (`schema.sql:1122`) every `project` / `cost` row was any member's; `projectsRls.test.ts` "before 20261142 the overlay narrowed only the org-level trail…" pins that state, and on the scratch cluster below a member who is not on the private project read its `COST_DOC_AWARDED`, `COST_ENTRY_POSTED` and `CHANGE_ORDER_APPROVED` rows before the migration.
- **Migration `20261142_prj_roundG_project_audit_rows.sql`**: `public.audit_row_project_visible(p_type, p_resource)` — SECURITY INVOKER (it reads only what the caller may read; no privilege of its own), **no SET clause** with every table and function schema-qualified (review fix pass: a SET clause costs a GUC save and restore on every call), EXECUTE to anon / authenticated / service_role (it is evaluated inside a policy that applies to every role): a `project` row → `project_visible_to_me(resource_id)`; a `cost` row → the cost row's project, through each table a `cost` writer names (`cost_documents`, `cost_entries`, `cost_accounts`, `project_parties` — `lib/timeline.ts`'s vocabulary); (review fix pass) a `project_checklist` / `turnover_item` row — the quality sign-off's `ESIGNATURE_CAPTURED` rows `/api/signatures/sign` writes under `lib/checklists.ts` `QUALITY_SIGNOFF_RESOURCE` (the signer, the statement) — → that checklist's / turnover item's project (`project_id` is NOT NULL on both); a non-UUID id or a gone project / cost / checklist / turnover row → not visible (the audit roles still read it — the intent for `PROJECT_DELETED` and `PURGE_PROJECT_SNAPSHOT`); any other resource type → true. `audit_logs_admin_trail` is re-created from 20261063's body **byte for byte with ONE added clause** — `AND (COALESCE(resource_type, '') NOT IN ('project', 'cost', 'project_checklist', 'turnover_item') OR audit_row_project_visible(resource_type, resource_id))` — so it reads *audit viewer OR (not the org-level trail AND project-visible)*: the audit roles (`admin.audit_view` through the policy evaluator, unchanged) read every row; everyone else reads a project / cost / quality sign-off row only when they can see the project. The type test is INLINE: the function holds EXISTS sub-queries, so the planner cannot inline it whatever its attributes, and a row of any other type (the `/activity` feed, the dashboard's exact audit count) now never calls it. RESTRICTIVE, no TO clause (as 20261063); the INSERT policy and the base member policy are untouched. DEC-30 inventory (counts only): project / cost rows, rows about a private project, rows whose project or cost record is gone, the e-signature rows on a checklist or turnover item, the audit-view population.
Tests — `lib/__tests__/prjRoundGJ11Migrations.test.ts`: "no other migration re-creates the overlay after 20261063", "lineDiff: nothing of 20261063's body is lost; only the comment and the project clause are added", "still RESTRICTIVE SELECT, still no TO clause, and the INSERT policy and the base member policy are untouched", "audit_row_project_visible: SECURITY INVOKER (reads only what the caller may read), NO SET clause … with every name schema-qualified; … the quality sign-off's e-signature rows through their checklist / turnover item", "the policy's inline type list and the function's are the same four types", "the e-signature resource types are the quality sign-off's (QUALITY_SIGNOFF_RESOURCE)", "every 'cost' audit writer names a row of those four tables"; the census the record asked for — `lib/__tests__/projectsRls.test.ts` now replays `audit_logs`: "the final audit_logs set: one permissive member read, one insert, and ONE restrictive overlay that gates project / cost rows on audit_row_project_visible", and the reproduction above. **Scratch PostgreSQL 16 cluster** (Supabase-shaped stub, 20261063's overlay verbatim, 20260913's `project_visible_to_me` verbatim): every probe `t`; a member not on the private project then read the open project's and the document rows only (no private `project` / `cost` row, no deleted project's); the private project's owner read its rows; the Admin (audit viewer) read all 14 rows, `PROJECT_DELETED` / `PURGE_PROJECT_SNAPSHOT` included; anon read 0 rows without an error. Re-run after the review fix pass (a fresh PG16 cluster, the same stub plus `project_checklists` / `turnover_items` under `project_visible_to_me` RLS): every probe `t`; the member not on the private project read the document row, the public project's row and the public checklist's `ESIGNATURE_CAPTURED` row — not the private checklist's or turnover item's signature, the private cost award, the private project row or the deleted project's; the owner read all of the private project's; the Admin read all 8; anon 0. With 1,000 more document rows, a non-viewer's read of 1,008 rows called `audit_row_project_visible` 7 times — once per project-type row (`pg_stat_xact_user_functions`).

**Done-when.**
- A member who cannot see a private project receives zero `project` / `cost` audit rows for it — ✓ (pending `20261142`).
- The audit roles still read every row (the `/admin/audit` page is unchanged for them), including `PROJECT_DELETED` and `PURGE_PROJECT_SNAPSHOT` — ✓.
- A policy census pins it (extend `lib/__tests__/projectsRls.test.ts`) — ✓.

**Scope / residual.** Pending migration: `20261142`. **Handoff:** admin-and-org P7 owns audit-log integrity (append-only, the trail's own rails) — it builds on this definition of `audit_logs_admin_trail`, and the lineDiff test pins it against 20261063. Audit rows about a project written under another resource type are not project rows by this rule: they follow their own resource type and stay readable by every member of the org, as before — `project_intake_link` (the intake links' mint, revoke and re-issue rows, the project only in `details`), a document row written by the door, and (named by review fix pass 2) the **`MILESTONE_*` rows of a milestone anchored to a document**: `lib/milestones.ts` `pickResource` types them `document` (resource id = the document; `milestone` when neither anchor is set) and `lib/audit.ts` `logMilestoneEvent` writes the milestone's name and details — so a private project's document-anchored milestone names and dates are readable by a member who is not on the project (`audit_logs?action=like.MILESTONE_*`). Only a milestone anchored to the project alone is typed `project` and covered. Covered by type: `project`, `cost`, and the quality sign-off's `project_checklist` / `turnover_item` e-signature rows. The type-scoped rows are owned by **`SEC-21`** (opened by this fix pass, below). `audit_row_project_visible` is not inlined by the planner (its EXISTS sub-queries rule that out); the inline type test keeps its per-row cost to the project-type rows. `lib/projects.ts` `deleteProject`'s comment now says `PROJECT_DELETED` is the audit viewers' once 20261142 is applied; `20261103`'s probe text ("the org-readable PROJECT_DELETED row") was written before SEC-20 and belongs to an earlier package's migration, left as written — it describes the state before 20261142.

---

## SEC-21 · Project audit rows written under another resource type stay readable by every org member

*Numbered SEC-21 on this branch (opened by projects Round G J11's review fix pass 2). If the number collides at merge the integrator renumbers.*

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** projects-joint J14 PROJECTS FOLLOW-UPS — the done-when 2 remainder (the Partial block below: residuals 2 and 4); J14 runs after J12 — by J12's review fix pass 6, 2026-10-02, on the integrator's instruction. Also the done-when 1 exception (residual 3) — by J12's fix pass 7, 2026-10-02 (`DEC-31`). Earlier: projects-joint J12 SERVER REMAINDERS — by the integrator, 2026-10-01 (J11 merge; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (by reading; not exercised against a live database)
- **Blast radius:** data-confidentiality
- **Locations:**
  - `lib/milestones.ts:132-136` — `pickResource`: a milestone with a `documentId` is logged as `resource_type 'document'` (resource id = the document), one with neither anchor as `'milestone'`
  - `lib/audit.ts:131-161` — `logMilestoneEvent` writes `MILESTONE_*` with the milestone's name and details (`milestoneId` in `details`)
  - `lib/intakeLinks.ts` `reissueIntakeLink`, `components/projects/IntakePanel.tsx`, `components/projects/cost/QuotesPanel.tsx` — the link rows (`INTAKE_LINK_*`, `INTAKE_QUOTE_LINK_*`) typed `project_intake_link`, the project only in `details.projectId` (or not at all)
  - `supabase/migrations/20261142_prj_roundG_project_audit_rows.sql` — `audit_row_project_visible` and the policy's inline type test cover `project`, `cost`, `project_checklist`, `turnover_item` only
- **Related:** `SEC-20` (its named residual), `SEC-2`, `DEC-69` item 3
- **Independently verified:** — (`author`: opened by projects Round G J11's review fix pass 2 from the reviewer's minor on `SEC-20`, per `DEC-31`; not yet challenged)

**Mechanism.** `SEC-20` made a project's audit rows follow the project by RESOURCE TYPE. Rows about a project written under another type keep the base `audit_logs_org_access` reach (any active member of the org): the `MILESTONE_*` rows of a project milestone anchored to a document (typed `document`), intake-link rows (`project_intake_link`), and a document row the door writes.

**Failure scenario.** A member who is not on a private project reads `audit_logs?action=like.MILESTONE_*` and gets that project's document-anchored milestone names, dates and status changes, while `SEC-20` says the project's own rows are covered.

**Remediation.** Either (a) extend `audit_row_project_visible` and the policy's inline type test to these rows — a `MILESTONE_*` row through its milestone's project (`details->>'milestoneId'`), a `project_intake_link` row through the link's project — keeping the inline test so other rows never call the function; or (b) write them with the project as their anchor (a milestone's audit row typed `project` when it has one, the document in `details`). Re-create `audit_logs_admin_trail` from its newest definition (20261142) with a lineDiff test.

**Done when.**
- A member who cannot see a private project receives none of its `MILESTONE_*` or intake-link audit rows, whatever their resource type.
- The audit roles still read every row; the project's Activity tab and timeline keep their rows for the people who can see the project.

**Resolution (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS took remediation (a). `supabase/migrations/20261157_prj_roundG_server_remainders.sql` §6–7: `audit_row_project_ref_visible(action, type, resource, details)` (LANGUAGE sql STABLE, SECURITY INVOKER, no SET clause, names schema-qualified — as `audit_row_project_visible`): a row whose `details.projectId` is a uuid follows that project (`project_visible_to_me`); a `project_intake_link` row follows its link's project; a `MILESTONE_*` row follows its milestone's project (`details.milestoneId`; a milestone with no project is org-level; a project-typed row is SEC-20's); a milestone the caller cannot find (deleted, or hidden by its private project) → visible only when the row is typed `milestone` — written for a milestone on no project and no document (`lib/milestones.ts` `pickResource`), an org-level row — and otherwise the audit roles' only (review fix pass: the first landing hid EVERY row of a gone milestone, org-level ones included, and its residual named only the DELETED row of a document-anchored milestone); anything else → true. `audit_logs_admin_trail` is re-created from its NEWEST definition (20261142, found by scanning the sequence at test time) with ONE added clause whose inline kind test keeps every other row from calling the function. The audit roles still read every row (`admin.audit_view` first, unchanged). Review fix pass 2 — a deleted milestone's rows keep their trace, without editing `lib/milestones.ts`: `20261157` §9 `stamp_milestone_audit_project` (BEFORE INSERT ON `audit_logs`, `WHEN (left(NEW.action, 10) = 'MILESTONE_')` so no other row pays for it; SECURITY DEFINER, `search_path` pinned, EXECUTE revoked from PUBLIC, anon and authenticated; the service role passes, so a restore keeps its rows as written) writes `details.projectId` (with `projectIdFrom: 'milestone'`) from the milestone's own project in the row's org; for `MILESTONE_DELETED`, which `lib/milestones.ts` writes once the milestone is gone, from the project this trigger stamped on the milestone's earlier rows (same org, same resource — the `resource_id` index). A `projectId` the writer put on a milestone row is replaced, and only the trigger's own stamps are trusted for a gone milestone: the function's first branch trusts `details.projectId`, so a forged one on an earlier row must never decide who reads a later row about a private project's milestone. As first landed, a milestone on no project named none — review fix pass 3 below: it now carries an org-level marker, because with nothing stamped a document-scoped, project-less milestone's rows became the audit roles' once it was deleted. From the paste on, every new milestone row names its project or carries the marker, deleted milestone or not — including the `MILESTONE_DELETED` row of a milestone with no stamped row since the paste, which pass 3 left unstamped (review fix pass 5 below). Pending migration: `20261157` (DEC-30); the inventory counts milestone rows of private projects, rows of gone milestones, intake rows of private projects, and (review fix pass 2) link rows with no `details.projectId`, intake and link rows whose project or link is gone, and the document-typed milestone rows without a project whose milestone is on a non-private project (readable now; hidden from members if that milestone is later deleted — the history the stamp cannot reach).
- Review fix pass 3. The review showed the stamp narrowed reads that are not project rows. A milestone imported onto a document with no project (`lib/milestones.ts`: `document_id` set, `project_id` NULL) writes `document`-typed rows; §9 found it with no project and stamped nothing, §6 then hid every row of the deleted milestone that was not typed `milestone`, and its `MILESTONE_DELETED` fallback found no stamp — so a plain member's document timeline lost "Milestone hit: X" (`lib/timeline.ts`), rows written AFTER the paste included, where before `20261157` every member read them. The header and residual 2 said only pre-paste history was affected; that was overstated. Fixed in `20261157`: §9 marks a row whose milestone is on no project `projectIdFrom: 'milestone'`, `orgLevel: true` (no `projectId`), stripping a writer's `orgLevel` with its `projectId` / `projectIdFrom`; the `MILESTONE_DELETED` fallback carries whatever the newest own stamp held — a project or the marker; §6 reads a gone milestone's row carrying the trigger's marker (`p_details @> '{"projectIdFrom": "milestone", "orgLevel": true}'`) as org-level. Two minors in the same function: the fallback chose the newest stamp by `audit_logs.timestamp`, which the writer may set on insert, so a forged far-future row could choose the project a deleted private milestone's row followed — the trigger now sets `NEW."timestamp" := now()` on every signed-in milestone row (the app's writer never sets the column; its DEFAULT is `now()` already); and the fallback ran for project-typed deletes, whose `resource_id` is the project and is shared with every audit row of the project — it is skipped there (SEC-20 decides a project row by its `resource_id`). The inventory adds the pre-paste rows the marker cannot reach: document-typed milestone rows with no `projectId` and no marker whose milestone is on no project.
- Review fix pass 5. The review showed that the `MILESTONE_DELETED` fallback trusts only rows §9 has stamped, and `lib/milestones.ts` writes that row once the milestone is gone. A milestone whose rows all predate the paste — or an imported one, which writes no milestone audit row at all (`importMilestonesFromParsed`, `importGhostMilestones`) — had nothing stamped, so its `MILESTONE_DELETED` row, written AFTER the paste, named no project and carried no marker: audit-roles-only, where members read it before `20261157`. The review reproduced it on scratch PostgreSQL 16 (a doc-only and an open-project document milestone, each with only a pre-paste `MILESTONE_CREATED` row: a plain Viewer read neither `MILESTONE_DELETED` row). The migration header, the inventory label, the "from the paste on" sentence above and residual 2 said every row written from the paste on keeps its reach; that was overstated. Fixed in `20261157` §9 without rewriting history: `record_milestone_scope_on_delete` (BEFORE DELETE ON `milestones`, `WHEN (OLD.document_id IS NOT NULL)`; SECURITY DEFINER, `search_path` pinned, EXECUTE revoked from PUBLIC, anon and authenticated) writes one `MILESTONE_SCOPE_RECORDED` audit row on the milestone's document — the resource `pickResource` chooses for it — as a signed-in caller deletes it. §9's trigger stamps that row while the milestone still exists (its project, or the org-level marker), and the `MILESTONE_DELETED` row written after the delete takes the stamp through the existing fallback (same org, resource and milestone; newest by the server's clock). A project-typed or milestone-typed milestone needs none (SEC-20 decides a project row; §6 reads a milestone-typed row as org-level). A delete that RLS refuses fires nothing; the service role (a purge, a restore) and the org's own delete write none. *Overstated (review fix pass 6):* `delete_project_record`'s purge is not the service role — it runs as the signed-in caller and wrote one row per document-scoped milestone of the project; it writes none since pass 6. `lib/timeline.ts` `summarizeAudit` names the row ("Milestone deletion recorded by the database: <name>"); the admin audit page and the Activity feed show it under its action name (superseded by review fix pass 6: both timelines and the Activity feed leave it out; the admin audit page still shows it). The final SELECT probes the trigger and the function; the inventory counts the document-scoped milestones and any other BEFORE DELETE row trigger on `milestones`. (Chosen over appending one stamp row per existing milestone at the paste: the delete-time row also covers milestones imported after the paste, which write no row, and records the scope as it stands at the delete.)
- Review fix pass 6. (a) The review showed `record_milestone_scope_on_delete` firing inside `delete_project_record` (`20261103`: SECURITY DEFINER, `auth.uid()` still the caller), which deletes every milestone of the project — one `MILESTONE_SCOPE_RECORDED` row per document-scoped milestone (300 for a 300-task schedule) inside the purge's statement. Fixed in `20261157` §9: the function returns early when `app.record_purge` is `'project:' || OLD.project_id` (the setting `delete_project_record` sets around its deletes and clears after); a row naming a deleted project is the audit roles' alone (`SEC-20`, §6), so the purge loses nobody a row. The comments and the final SELECT's probe say so. The other bulk paths were checked: the org's own delete (its FK cascade) already writes none; `projects` and `documents` are `ON DELETE SET NULL` on `milestones` (an update, not a delete); `delete_milestone_keep_subtree` (`20261107`) and `lib/milestones.ts` `deleteMilestone` delete one row; `lib/projects.ts` `legacyDeleteRecordlessProject`'s bulk delete runs only where `delete_project_record` does not exist (before `20261103`); no restore deletes milestones. (b) Every document-milestone delete showed twice — "Milestone deletion recorded by the database: X" beside "Milestone deleted: X" — on the document timeline and on the project feed's linked-document rows, and the Activity pulse counted it twice. `lib/timeline.ts` `SCOPE_STAMP_ACTIONS` names the stamp: `getDocumentTimeline` and `getProjectTimeline`'s linked-document read leave it out *(Corrected at fix pass 7: after the read's row limit, so a window of N rows of paired deletes held about N/2 events; in the query since pass 7)*, `PROJECT_EVENT_VOCABULARY` classes it `noise`, and `app/(protected)/activity/page.tsx` leaves it out of the feed and the pulse (the "loaded" count and "Load more" still read every row). *(Corrected at fix pass 8: the feed's own read leaves it out in the query since J12 fix pass 8, before its row limit, so the loaded rows, their count and "Load more" are events.)* The raw audit lists — the admin audit page, the History drawer's audit list, the inspector's last three — still show every row. *(Corrected at fix pass 7: so did the dashboard's Activity widget, which is not a raw audit list — it listed the stamp and counted it in its 14-day sparkline; it leaves it out since pass 7.)*
- **J12 fix pass 7 (2026-10-02).** Two nits from the seventh review, and the record decision it asked for. No SQL behaviour changed, so there was no scratch run (`20261157` changed by one comment, in §1). (a) The dashboard's Activity widget (`components/dashboard/widgets.tsx` `ActivityBody`) listed and counted every audit row, so one document-milestone delete showed twice in its list and counted twice in its 14-day sparkline; pass 6's list of places that leave the stamp out missed it. Both of its reads now leave `MILESTONE_SCOPE_RECORDED` out in the query (`lib/timeline.ts` `SCOPE_STAMPS_NOT_IN`, a PostgREST `not.in` list; `fetchRecentDates` takes an optional `notIn`). The admin dashboard cards that measure audit volume — "Workspace activity · 30d" (`AdminAnalyticsBody`) and the Audit card's "events on record" (`AdminAuditBody`) — still count every row, as the admin audit page shows every row. (b) `getDocumentTimeline` and `getProjectTimeline`'s linked-document read left the stamp out only AFTER the read's row limit, so a window of N rows of paired deletes held about N/2 events. Both now filter in the query, before the limit (`.not("action", "in", SCOPE_STAMPS_NOT_IN)`, the form the project-scoped read already used; `audit_logs.action` is NOT NULL, so nothing else is dropped), and keep the filter after the read. (c) Residual 3 decided: it IS an exception to done-when 1, so done-when 1 is ◐, and its owner is projects-joint J14 PROJECTS FOLLOW-UPS (`DEC-31`). The evidence:
  - Done-when 1 says a member who cannot see a private project receives none of its `MILESTONE_*` rows, whatever their type. Residual 3's rows are `MILESTONE_*` rows of a milestone that is now on that project.
  - The corpus's own reach rule is the object's scope as it stands at the read. `SEC-20`'s `audit_row_project_visible` reads a project's privacy, and a cost row's project, when the row is read, so a project made private later hides its earlier rows. §6 reads an unstamped row of a milestone the caller can find through that milestone's CURRENT project.
  - Residual 3's rows keep instead the reach of the scope their milestone had when they were written. Reading §6 again, that is wider than the residual said: see residual 3.

  Why it stays LOW and is deferred, not fixed here. It is reachable only by moving an existing milestone onto another project, which no app path does, and the rows hold what every member could read when they were written. Closing it needs §6 to read the current project of a milestone the caller cannot see, without losing what the stamp keeps for a deleted one — a change beyond this pass (`DEC-31`).
- **J12 fix pass 8 (2026-10-02).** Review 8's nit 5. The Activity feed (`app/(protected)/activity/page.tsx`) left the stamp out only after its row limit, in its two memos, so a window of `limit` rows of paired deletes held fewer events. Pass 6 recorded this (above). Its read now leaves the stamp out in the query, before `.limit(limit)`, with `.not("action", "in", SCOPE_STAMPS_NOT_IN)` (the form pass 7 gave the timelines; `audit_logs.action` is NOT NULL, so nothing else is dropped), and the memos still skip it. Test: `prjRoundGJ12.test.ts` "J12 review fix 8: the feed's query leaves the stamp out BEFORE its row limit …". It fails with the filter removed (mutation run).
- Commits: `6f89983`, `8a26824` (review fix pass: the org-level rows of a gone milestone), `ac6941a` (review fix pass 2: §9's stamp and the wider inventory), `e03b655` (review fix pass 3: the org-level marker, the server's clock, no trace for a project-typed delete), `74b11b5` (review fix pass 5: the delete's scope row), `3a956cb` (review fix pass 6: no scope rows under the purge; the stamp off the timelines and the Activity feed), `32814cd` (J12 fix pass 7: the stamp out of the timelines' queries and off the dashboard's Activity widget), `d7ad34d` (J12 fix pass 8: the stamp out of the Activity feed's query).
- Tests: `lib/__tests__/prjRoundGJ12Migration.test.ts` "SEC-21 — audit_logs_admin_trail re-created from its NEWEST definition + ONE clause" (lineDiff: nothing of 20261142's body lost, only the comment and the clause added; the function's kinds and the inline test agree; INVOKER; the other `audit_logs` policies untouched); `lib/__tests__/projectsRls.test.ts` (the final overlay is 20261157's, ending in the SEC-20 then SEC-21 clauses; "before 20261157 an intake-link / INTAKE_ / MILESTONE_ row about a private project was any member's"); `prjRoundGJ11Migrations.test.ts`'s definer list now names 20261157. Review fix pass 2: `prjRoundGJ12Migration.test.ts` "section 9: a milestone row is stamped with its project as it is written …" (the trigger inside the one transaction with its `WHEN` clause; the service pass first; the writer's `projectId` replaced; both lookups bound to the row's org; only the trigger's stamps trusted for a gone milestone; a milestone on no project names none; `logMilestoneEvent` still writes no project and the delete still writes after the row is gone — why the stamp is needed), the DRLS-16 test (two SECURITY DEFINER trigger functions, each pinned and revoked from every role) and "the DEC-30 inventory counts everything the migration narrows". Review fix pass 3: "an org-level (document-scoped, project-less) milestone's rows stay every member's after it is deleted …", "the newest own stamp is chosen by the server's clock, never the writer's; a project-typed delete is not traced", the gone-milestone test now pinning §6's marker branch, and the final SELECT's two new answers (a marked row of a gone milestone → visible; an `orgLevel` without the trigger's `projectIdFrom` → not). Review fix pass 5: "a signed-in delete of a document-scoped milestone records its scope first …" (the trigger's event and `WHEN` clause inside the transaction; the service pass, then the org's own delete; the row it writes, on the resource `pickResource` chooses; §9's fallback reads any `MILESTONE_` action on the same resource; the imports write no audit row; the probe; `summarizeAudit`'s label), the DRLS-16 test (now three SECURITY DEFINER trigger functions, each pinned and revoked) and the inventory test. Review fix pass 6: `prjRoundGJ12Migration.test.ts` "delete_project_record's purge writes no scope row, an ordinary signed-in delete still writes one — the trigger function transcribed statement by statement" (20261103's purge sets the setting around its milestone delete and is the newest definer; the function read as its guards and its one INSERT, each guard transcribed; a 300-task purge writes nothing, an ordinary signed-in delete one, another project's milestone under the setting one; the probe — without the guard the purge writes 300 rows); `timeline.test.ts` "SEC-21 (projects Round G J12, review fix 6) — the database's scope stamp is not an event" (the document timeline and the project feed each show the delete once); `prjRoundGJ12.test.ts` "SEC-21 — the Activity feed shows and counts one milestone delete once" (the page's two memos, lifted from its source, transpiled and run: two milestone events, not three). J12 fix pass 7: `timeline.test.ts` "the document timeline's read leaves the stamp out in the query: a 4-row window is 4 deletes, not 2" and "the project feed's linked-document read does too" (each fails with the query filter removed — 2 events; pass 6's tests pass either way); `activityWidgetScopeStamp.test.ts` "SEC-21 (J12 review fix 7) — the dashboard's Activity widget shows and counts one milestone delete once" (the widget rendered: the list and the 14-day count; both reads filter before their caps; every other action still lists and counts — negative control). The first two fail against `1cf5aad`'s widget.
- Scratch: Run on a private scratch PostgreSQL 16 (a stub of the touched tables with the real `20261091` checklist rail and the real `20261142` function; the migration applied twice — idempotent — every final-SELECT probe `t`). A member outside a private project read only the org-level and open-project rows (an uploaded-document row, an open project's milestone, an org-level milestone, a gone project-typed milestone); a roster member also read the private project's `INTAKE_REJECTED` (with `projectId`) and its milestone rows; the owner read everything except a gone document-typed milestone; an Admin read every row; anon none. Review fix pass, same harness: after an org-level milestone and a private project's document-anchored milestone were both deleted, a member outside the private project and a roster member each read the org-level milestone's three rows (created, completed, deleted) and none of the document-anchored one's; an Admin read all five. Review fix pass 2, same harness (`scratchpad/j12fix2/scenarios_fix2.sql`; the migration applied twice, every probe `t`): signed-in rows for a public project's and a private project's document-anchored milestones were stamped with their projects, an org-level milestone's row and a row naming another org's milestone with none, and a row that brought its own (wrong) `projectId` got the milestone's; a service-role row was left as written. Both milestones were then deleted and their `MILESTONE_DELETED` rows written: they took the public and the private project from the earlier stamps; a delete row for a milestone with no stamped history took none. A plain member read the public milestone's created / completed / updated / deleted rows and the org-level one, none of the private milestone's or the untraceable one's; the private project's roster member read the private milestone's created and deleted rows; an Admin read the untraceable row. A member's forged rows — `projectId` of the public project on a gone private milestone, on a gone milestone with no stamped history, and on an existing org-level milestone — were stored as the private project, none and none; the forger could read back only the org-level one. Calling the stamp directly: permission denied. Inventory, seeded before the paste: 3 open and 1 awarded quote under a flagged company (the party-only count found 1), 2 link rows with no project, 2 intake / link rows whose project or link was gone, 1 at-risk milestone row. Review fix pass 3, same harness (`scratchpad/j12fix3/scenarios_fix3.sql`; the migration applied twice, every probe `t`; the review fix 2 scenarios re-run with the same answers): a document-scoped milestone on no project — its created and completed rows (one bringing its own `projectId` of the private project and `orgLevel: false`) were stored with the marker and no project; once the milestone was deleted its `MILESTONE_DELETED` row took the marker, and a plain member and another member each read all three. The review's forged clock: a member's `MILESTONE_UPDATED` with `timestamp` 2099 while the milestone was on the public project was stored with the server's time; the milestone moved to the private project, a row was written, it was deleted, and its `MILESTONE_DELETED` row followed the private project — the forger read none of it, the roster member read it. A project-typed `MILESTONE_DELETED` bringing its own marker was stored with none and read by a member of the public project. Inventory seeded before the paste: 2 document-typed rows of a project-less milestone counted by the new row. Review fix pass 5, a fresh cluster on the same harness (`scratchpad/j12fix5/scenarios_fix5.sql`; the migration applied twice, all 17 probes `t`): three document-scoped milestones, each with a `MILESTONE_CREATED` row written before the paste (as the service role, so unstamped) — on no project, on the open project, on the private project — and an imported one with no row at all, were deleted by the owner (a plain Viewer's delete was refused by RLS and wrote nothing), and `MILESTONE_DELETED` was then written as the lib writes it. Each delete wrote one `MILESTONE_SCOPE_RECORDED` row (the org-level marker, the open project, the private project, the marker), and each `MILESTONE_DELETED` row took the same. A plain Viewer read the doc-only, open-project and imported milestones' scope and deleted rows — not the private one's, and not the pre-paste `MILESTONE_CREATED` rows (residual 2); the private project's roster member also read the private one's; an Admin read all 12. A service-role delete and a project-typed milestone's delete wrote no scope row; calling the function directly was refused (permission denied). The earlier scenario files gave the same answers, except that their signed-in deletes of document-scoped milestones now also write the scope row. Inventory seeded before the paste: 2 document-scoped milestones. Review fix pass 6, a fresh cluster on the same harness (`scratchpad/j12fix6/`; the migration applied twice, all 17 probes `t`; `scenarios.sql` … `scenarios_fix5.sql` gave the same answers, generated ids aside): `scenarios_fix6.sql` — the owner, signed in, ran the purge's milestone step as `delete_project_record` runs it (a SECURITY DEFINER function setting `app.record_purge`, deleting the project's milestones, clearing it) over a project with 300 document-scoped milestones: 300 deleted, no scope row (with the pass-5 function body: 300 rows); an ordinary signed-in delete wrote one, stamped with its project; with the setting naming another project, a milestone's delete still wrote its row.

**Done-when.**
- ◐ A member who cannot see a private project receives none of its `MILESTONE_*` or intake-link audit rows, whatever their resource type (with the migration applied). *(Corrected at fix pass 7: marked ✓ through pass 6, but residual 3 is a case where it does not hold. Rows written before a milestone was moved onto a private project keep the reach they had, so a non-member still reads them. Owner: projects-joint J14 PROJECTS FOLLOW-UPS, `DEC-31` — J12 fix pass 7 above.)*
- ◐ The audit roles still read every row (✓); people who can see the project keep its rows written from the paste on (a deleted milestone's `MILESTONE_DELETED` row included, its earlier rows unstamped or none — review fix pass 5). *Overstated (review fix pass 6):* this limb was marked ✓ and the finding RESOLVED, but residuals 2 and 4 below are rows people who can see the project lose — see the Partial block. What does hold: every link row the app writes today carries `details.projectId` (`IntakePanel` create / revoke, `reissueIntakeLink`, the bid tab's quote links), so a roster member reads them; the Activity tab's milestone rows follow the milestone's project.

**Partial (2026-10-02, projects Round G — J12 review fix pass 6).** Re-opened under `DEC-31`. Done-when 1 holds (with the migration applied). *(Corrected at fix pass 7: except residual 3 — see J12 fix pass 7 and done-when 1.)* Done-when 2 holds for its first limb (the audit roles read every row) and fails its second — "the project's Activity tab and timeline keep their rows for the people who can see the project" — in two cases: (a) residual 2: a document-typed `MILESTONE_*` row written BEFORE the paste, with no `details.projectId`, becomes the audit roles' only once its milestone is deleted, so a roster member's document timeline and the project feed's linked-document rows lose that entry; (b) residual 4: a milestone deleted by the service role writes no scope row, so a `MILESTONE_DELETED` row a signed-in caller writes afterwards, for a milestone with no stamped row since the paste, names no project and is the audit roles' only (no app path does this today). Neither closes in this pass without widening its scope: (a) needs either a ruling to back-fill append-only audit rows or a reach rule for an unstamped row of a gone milestone that does not reopen the leak done-when 1 closes; (b) needs the service pass of §9's stamp and of the scope trigger changed. Owner: projects-joint J14 PROJECTS FOLLOW-UPS (Assigned above; it runs after J12). Not a failure of the limb: `delete_project_record`'s purge writes no scope row since pass 6 — a deleted project's rows are the audit roles' alone by `SEC-20`'s rule, so nobody who can see the project remains.

**Scope / residual.** Named in full:
1. A legacy `project_intake_link` row written without `details.projectId` is readable only by those who can read the link itself (`project_intake_links` RLS: the project's owner and controllers) and the audit roles; a link or INTAKE_ row whose project or link no longer exists is the audit roles' only. The inventory counts both, so the paste shows how many.
2. History written BEFORE the paste: a document-typed `MILESTONE_*` row with no `details.projectId` (every such row today) is audit-roles-only once its milestone is deleted — a document's timeline loses those entries for everyone else — whether its milestone is on a project or on none (a document-scoped one). §9 stamps every row written from the paste on with its project or, for a milestone on no project, the org-level marker (review fix pass 3 — as first landed it stamped nothing for a project-less milestone, so its post-paste rows went too), and records that stamp as a signed-in caller deletes a document-scoped milestone (review fix pass 5 — as pass 3 left it, the `MILESTONE_DELETED` row of a milestone with no stamped row since the paste went too), so a milestone deleted later keeps the trace of every row written after the paste, its `MILESTONE_DELETED` row included (its pre-paste rows still go). The inventory counts both kinds of at-risk row (milestone on a non-private project; milestone on no project). Back-filling `details.projectId` or the marker into existing audit rows was not done: it would rewrite append-only audit history. Owner: projects-joint J14 PROJECTS FOLLOW-UPS (the Partial block).
3. Toward showing, the other way: a row typed `milestone` is read as org-level when its milestone cannot be found by the caller. A milestone created with no project and LATER put on a private project is hidden from a non-member by `milestones` RLS, so its earlier org-level rows (written while it was org-level, and readable by every member then) stay readable to them. *(Corrected at fix pass 7: wider than written, and an exception to done-when 1.)*
   - Reading §6 again: a row that names its project (`details.projectId`, which §9 stamps on every row since the paste) follows THAT project. A row carrying §9's org-level marker is read as org-level once the caller cannot find its milestone. So rows keep the reach of the scope their milestone had when they were written.
   - A milestone moved after rows were written leaves those rows where they were. Moved from no project onto a private one: its milestone-typed rows and its marked rows stay every member's. Moved from an open project onto a private one: its rows stamped since the paste still follow the open project.
   - The other way round, a milestone moved off a private project onto an open one: its rows stamped since the paste stay with the private project's roster. That is a done-when 2 case.
   - No app path moves an existing milestone's project. `lib/milestones.ts` `PATCH_COLUMN` has no `project_id`, and no RPC sets it. A direct write by a caller that RLS lets update the milestone does.

   Owner: projects-joint J14 PROJECTS FOLLOW-UPS (`DEC-31`; it runs after J12) — the exception decided at J12 fix pass 7, above.
4. A milestone deleted by the service role (`auth.uid()` NULL — a server-side purge or the SQL editor) writes no scope row, so a `MILESTONE_DELETED` row a signed-in caller writes after such a delete, for a milestone with no stamped row since the paste, names no project and is the audit roles' only. No app path does this: `lib/milestones.ts` deletes as the signed-in caller (review fix pass 5). `delete_project_record`'s purge is not this case — it runs as the signed-in caller and, since review fix pass 6, writes no scope row on purpose (above). Owner: projects-joint J14 PROJECTS FOLLOW-UPS (the Partial block).

**Partial (2026-10-07, projects Round G — J14 PROJECTS FOLLOW-UPS).** Residuals 2 and 4 decided and recorded, with no SQL change (`DEC-69`'s J14 *Landed* line). Residual 3 stays open, and one premise of it is corrected.
- **Residual 2 — decided: accepted, not back-filled.** A document-typed `MILESTONE_*` row written before `20261157`'s paste carries no `details.projectId`, so it becomes the audit roles' alone once its milestone is deleted.
  - Back-filling the stamp would rewrite append-only audit history (admin-and-org P7 owns that trail's integrity), so it is not done.
  - No reach rule for an unstamped row of a gone milestone is added either. Such a row names only its document, and a document can sit in several projects, a private one among them. Any rule reading the row's reach from its document would reopen the leak done-when 1 closes.
  - The window is bounded. Every row written from the paste on carries its stamp or the org-level marker; a signed-in delete records the scope first; the audit roles keep every row; and `20261157`'s inventory counts the at-risk rows before the paste.
  - Done-when 2's exception for these rows is accepted on the record, not owed.
- **Residual 4 — decided: by design.** A milestone deleted by the service role (`auth.uid()` NULL: a restore, the cron, or the SQL editor) writes no scope row.
  - No app path deletes a milestone as the service role (`lib/milestones.ts` deletes as the signed-in caller, and `delete_project_record`'s purge writes none on purpose).
  - Recording the scope there would mean changing §9's service pass, which keeps a restore's rows exactly as written.
  - The `MILESTONE_DELETED` row written after such an operator's delete is the audit roles' alone. That is accepted for an operator action.
- **Residual 3 — still open; a premise corrected.** The residual says no app path moves an existing milestone's project. Read again at J14's HEAD, one does.
  - `lib/milestones.ts`'s import upsert reads a document-scoped import's existing rows by `document_id` alone (`existing` read: `else if (input.documentId) q = q.eq("document_id", input.documentId)`). Its upsert payload then writes the import's `scope`, including `project_id: input.projectId ?? null`, onto each matched row.
  - So a document-only re-import of a file whose rows were first imported onto a project with that document moves each matched milestone OFF its project, to the document alone. Its earlier rows stay with that project's roster (residual 3's "done-when 2 case"), and the milestone itself becomes an org-level one.
  - Found by reading; not run.
  - A rail refusing every signed-in move of `milestones.project_id` would refuse that import, so it was not built here. `lib/milestones.ts` is not this package's file.
- Owner of residual 3: the integrator assigns at the J14 merge (projects-joint, the owner of `lib/milestones.ts`): first the import's scope read (match an existing row only within its own project), then a `BEFORE UPDATE OF project_id ON milestones` rail for the signed-in caller.

**Done-when.**
- ◐ (unchanged) Done-when 1: residual 3, above.
- ◐ Done-when 2: its first limb ✓. Its second holds for every row written from the paste on. Residuals 2 and 4 are accepted exceptions, decided above (`DEC-69`'s J14 line), and not owed.

**Scope / residual.** Residual 3 (owner above). Residuals 2 and 4: decided, above. Residual 1: as recorded (the inventory counts its rows). Pending migration: `20261157` (HOLD).

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| SEC-1 | CRITICAL | RESOLVED |
| SEC-2 | CRITICAL | RESOLVED |
| SEC-3 | CRITICAL | RESOLVED |
| SEC-4 | CRITICAL | RESOLVED |
| SEC-5 | HIGH | RESOLVED |
| SEC-6 | HIGH | RESOLVED |
| SEC-7 | MEDIUM | RESOLVED |
| SEC-8 | HIGH | RESOLVED |
| SEC-9 | HIGH | RESOLVED |
| SEC-10 | HIGH | RESOLVED |
| SEC-11 | MEDIUM | RESOLVED |
| SEC-12 | HIGH | RESOLVED |
| SEC-13 | HIGH | RESOLVED |
| SEC-14 | HIGH | RESOLVED |
| SEC-15 | MEDIUM | RESOLVED |
| SEC-16 | MEDIUM | RESOLVED |
| SEC-17 | MEDIUM | RESOLVED |
| SEC-18 | MEDIUM | RESOLVED |
| SEC-19 | LOW | RESOLVED |
| SEC-20 | MEDIUM | RESOLVED |
| SEC-21 | LOW | OPEN |
