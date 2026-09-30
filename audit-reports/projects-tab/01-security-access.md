# 01 · Security & access

Who can reach what, and what an outsider can put inside the perimeter.

**19 findings** — 4 CRITICAL, 11 HIGH, 3 MEDIUM, 1 LOW (`SEC-18` opened by projects Round G package J9, `SEC-19` by J1, 2026-09-30).

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
- **Status:** OPEN
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

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-1` (J1). Authorship is `documents.authored_by_link_id`, stamped when the door CREATES a document and backfilled from each document's first version (migration `20261104`); a document in the link's `assigned_doc_ids` is never auto-published whatever its history; a link-authored document needs at least one approved revision before a trusted link may publish over it (`DEC-50`). Fix pass (J1 review): a rejected submission can no longer be re-published by resubmission — a pending own submission, a rejection against the current revision, or rejected bytes all send the upload to review (`INTK-1`'s fix pass). Tests — `lib/__tests__/intakeUploadRoute.test.ts` "an ASSIGNED org document goes to review on every submission — even after a link version was approved", "publishes through publish_revision acting as the link's creator …" (the trusted own-document branch), "reject F → submit G (review) → submit F again, or F plus one byte: each lands IN REVIEW".

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

**Scope / residual.** The route still runs as the service role, so `enforce_document_publish_guard` returns early on it; the guards the contract does not carry (per-library authority, review completion) are evaluated by the route (the creator's authority, the review policy). Replacing the service role with a constrained identity is `GAP-401`'s build, which runs on this tree.

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

**Scope / residual.** Pending migration: `supabase/migrations/20261104_prj_roundG_intake_links.sql`. Quote links minted before J4 without an expiry stay until 20261096's backfill runs (its own blocking inventory).

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

**Done-when.**
- [x] The Nth upload in a window is rejected with a 429 and a readable message — ✓.
- [x] A burst produces at most one notification per recipient per window — ✓.
- [x] Limits are configurable without a code change — ✓ (`INTAKE_MAX_PER_TOKEN_HOUR`, `INTAKE_MAX_PER_IP_HOUR`, `INTAKE_NOTICE_WINDOW_MIN`; per link, `max_submissions` / `max_total_bytes`).

**Scope / residual.** Pending migrations: `20261104`, `20261105`. Until `20261105` is applied the limiter fails open (the house trade-off) and the per-link cap reads nothing.

---

## SEC-9 · An offboarded project owner can still delete the project, cascading away the financial and quality record

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SEC-10 · The checklist route authorizes at member level but reads ACL-restricted documents with the service role

- **Severity:** HIGH
- **Status:** OPEN
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

**Done-when.**
- [x] A submission against a two-reviewer library cannot be published with one approval — ✓ (the panel sends it to the roster; finalize requires completion; the guard refuses a roster-less intake promote — pending `20261105`).
- [x] The signatures appear in `document_review_signoffs` and on the revision chain — ✓ (the ordinary roster and signing flow on the document's review panel).

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

**Scope / residual.** Pending migration: `20261105`. Non-intake drafts finalized through the review path keep the MOC capture RevUpModal / check-in apply (document-control `DCK-1`'s surface) — the guard block is deliberately scoped to external submissions (`DEC-31`).

---

## SEC-15 · Transferring project ownership is rejected by row-level security for the exact user offered the button

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SEC-16 · The project owner can read a link's raw token and act as the contractor

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SEC-17 · `project_documents` is writable by any active org member

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SEC-18 · The archive-aware opener and the data-export envelope sign presigned downloads with no disposition

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SEC-19 · Contractor intake tokens are stored in plaintext — any read of the table is a working door credential

- **Severity:** LOW
- **Status:** OPEN
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

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| SEC-1 | CRITICAL | RESOLVED |
| SEC-2 | CRITICAL | OPEN |
| SEC-3 | CRITICAL | RESOLVED |
| SEC-4 | CRITICAL | RESOLVED |
| SEC-5 | HIGH | RESOLVED |
| SEC-6 | HIGH | RESOLVED |
| SEC-7 | MEDIUM | RESOLVED |
| SEC-8 | HIGH | RESOLVED |
| SEC-9 | HIGH | OPEN |
| SEC-10 | HIGH | OPEN |
| SEC-11 | HIGH | RESOLVED |
| SEC-12 | HIGH | RESOLVED |
| SEC-13 | HIGH | RESOLVED |
| SEC-14 | HIGH | RESOLVED |
| SEC-15 | HIGH | OPEN |
| SEC-16 | MEDIUM | OPEN |
| SEC-17 | MEDIUM | OPEN |
| SEC-18 | MEDIUM | OPEN |
| SEC-19 | LOW | OPEN |
