# 01 · Security & access

Who can reach what, and what an outsider can put inside the perimeter.

**17 findings** — 4 CRITICAL, 11 HIGH, 2 MEDIUM.

> Line numbers are from commit `6a14d7d` and drift with edits. **Match on the
> quoted code, not the number.** See [`../README.md`](../README.md) for the
> resolution protocol.

---

## SEC-1 · An unauthenticated upload link can put executing JavaScript on the app's own origin

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (by construction — code path traced link by link; no payload executed)
- **Blast radius:** security
- **Locations:**
  - `app/api/intake/upload/route.ts:270` — `ContentType: file.type || "application/octet-stream"`
  - `components/viewers/SecureDocViewer.tsx:129-140` — `response.blob()` → `URL.createObjectURL(blob)`
  - `components/viewers/SecureDocViewer.tsx:274` — `<iframe>` with no `sandbox`
- **Related:** `SEC-6` (no type validation), `SEC-7` (inline disposition), `SEC-5` (link never expires)
- **Re-verified:** hardening pass — **SURVIVES**. Both halves confirmed. `ContentType: file.type || "application/octet-stream"` (`intake/upload:270`) takes the type from the uploader unvalidated; `SecureDocViewer.tsx:274-275` renders the fetched bytes as `<iframe src={blobUrl}>`, and a `blob:` URL inherits the creating origin. Unauthenticated upload → script execution on the app's own origin.

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
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / document-control integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:246-249` — `linkAuthored` computation
  - `app/api/intake/upload/route.ts:257` — the pending-submission guard it defeats
  - `app/api/intake/upload/route.ts:302` — `autoNow`
- **Re-verified:** hardening pass — **SURVIVES**, and the mechanism is exact. `linkAuthored` is true once a version authored by this link exists (`:246-248`); the pending-review block is `if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored))` (`:257`). So the first submission is held for review and every later one takes the auto path. The route's own comment two hundred lines down — *"an assigned org-authored controlled drawing ALWAYS goes through review"* — is false from the second submission onward.

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

---

## SEC-4 · The external door runs as service role, so every database-level document-control guard is skipped

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / document-control integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:322-334` — the publish write, via `supabaseAdmin`
  - `supabase/migrations/20260822_review_completion_guard.sql:32-34` — the skip
- **Related:** `SEC-13`, `SEC-14`, `SAF-5`
- **Re-verified:** hardening pass — **SURVIVES**. Every write on this route uses `supabaseAdmin`; the publish-guard trigger exempts service-role writes by design, so no hold, lock or review gate is consulted.

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

---

## SEC-5 · Quote links never expire, and document links default to never

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:539-544` — insert with no `expires_at`
  - `components/projects/IntakePanel.tsx:150` — `expires_at: expires ? … : null`
- **Related:** report [`11-upload-door-controls.md`](./11-upload-door-controls.md)

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

---

## SEC-6 · Zero file-type validation on the public upload door

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `app/api/intake/upload/route.ts:22` — `MAX_BYTES`
  - `app/api/intake/upload/route.ts:46, 73` — size check after full buffering
  - `app/api/intake/upload/route.ts:270` — client MIME stored verbatim
- **Related:** `SEC-1`

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

---

## SEC-7 · Presigned downloads are served inline rather than as attachments

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `lib/storage.ts:118` — `getPresignedDownloadUrl`
  - `app/api/storage/download-url/route.ts:146-151` — the call site
  - `app/api/transmittal/route.ts:73` — the correct pattern, for reference
- **Related:** `SEC-1`

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

---

## SEC-8 · No rate limiting on the intake door, and each upload fans out email

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / abuse
- **Locations:**
  - `app/api/intake/upload/route.ts:104-113` — notification fan-out
  - `app/api/intake/upload/route.ts:349-385` — in-app + queued email + drain kick
  - `signup_attempts` table — the existing anti-abuse primitive, not wired here

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

---

## SEC-9 · An offboarded project owner can still delete the project, cascading away the financial and quality record

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** SUSPECTED (policy read is unambiguous; not exercised against a live database)
- **Blast radius:** data-integrity
- **Locations:**
  - `supabase/migrations/20260906_projects_hardening.sql:61-68` — `projects_delete_owner`
  - `supabase/migrations/20261013_project_controls_program.sql` — `user_owns_project()`, which does it correctly

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

---

## SEC-11 · `assigned_doc_ids` is validated against nothing — not the project, not the ACL, not even the org

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED for project/ACL scope; the *absence* of an org check is CONFIRMED, cross-org exploitation is SUSPECTED (needs a foreign UUID)
- **Blast radius:** security / data-confidentiality
- **Locations:**
  - `components/projects/IntakePanel.tsx:215-232` — the write
  - `app/api/intake/resolve/route.ts:119` — `.in("id", docIds)` with **no** `org_id` filter
  - `app/api/intake/resolve/route.ts:144` — the redline query, which *does* filter by org
  - `supabase/migrations/20260903_intake_assignments.sql:20` — bare `UUID[]`, no FK, no CHECK

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

---

## SEC-12 · A trusted link can publish a brand-new document into the controlled library by uploading twice

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** document-control integrity
- **Locations:** `app/api/intake/upload/route.ts:302`
- **Related:** `SEC-3` (same root cause)

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

---

## SEC-13 · Intake approval bypasses the library's configured review gate

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `components/projects/IntakePanel.tsx:234-246` — `finalizeReviewedRevision({ requireRosterComplete: false })`
  - `lib/reviewControl.ts:395-411`
  - `supabase/migrations/20260822_review_completion_guard.sql:46-58` — the guard that only bites when roster rows exist
- **Related:** `SEC-4`

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

---

## SEC-14 · No document-class or management-of-change gate on either intake path

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (verified by exhaustive grep of `mocRequirementFor` / `effectiveDocClassForDocument` call sites)
- **Blast radius:** compliance (OSHA 1910.119(l))
- **Locations:**
  - `app/api/intake/upload/route.ts` — the whole document branch
  - `lib/docClass.ts` — imported by nothing under `app/api/`
  - `supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql` — adds `moc_reference` columns, no trigger, no CHECK
  - `components/documents/RevUpModal.tsx:219` — where the gate *does* exist

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

---

## SEC-15 · Transferring project ownership is rejected by row-level security for the exact user offered the button

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** SUSPECTED (policy read is unambiguous; not exercised live)
- **Blast radius:** ux / correctness
- **Locations:**
  - `lib/projects.ts:621-641` — `transferOwnership`
  - `supabase/migrations/20260906_projects_hardening.sql:60-65` — `projects_update_owner`
  - `app/(protected)/projects/[id]/page.tsx:977-982` — the button
  - `app/(protected)/projects/[id]/page.tsx:913` — where the raw error surfaces

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

## Report progress

| ID | Severity | Status |
|---|---|---|
| SEC-1 | CRITICAL | OPEN |
| SEC-2 | CRITICAL | OPEN |
| SEC-3 | CRITICAL | OPEN |
| SEC-4 | CRITICAL | OPEN |
| SEC-5 | HIGH | OPEN |
| SEC-6 | HIGH | OPEN |
| SEC-7 | HIGH | OPEN |
| SEC-8 | HIGH | OPEN |
| SEC-9 | HIGH | OPEN |
| SEC-10 | HIGH | OPEN |
| SEC-11 | HIGH | OPEN |
| SEC-12 | HIGH | OPEN |
| SEC-13 | HIGH | OPEN |
| SEC-14 | HIGH | OPEN |
| SEC-15 | HIGH | OPEN |
| SEC-16 | MEDIUM | OPEN |
| SEC-17 | MEDIUM | OPEN |
