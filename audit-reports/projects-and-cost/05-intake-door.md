# 05 · External intake & the contractor door

**14 findings** — 2 CRITICAL · 7 HIGH · 5 MEDIUM.

The tokened portal, and whether promoted content enters document control through the guard or around it.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The redline branch proves link ownership of the ticket before attaching anything — the one hand-off in this area that is correctly scoped. | `app/api/intake/upload/route.ts:154-157` | `if (String(meta.intake_collision?.intakeLinkId ?? "") !== String(link.id)) return bad(...403)` — combined with the `.eq("org_id", orgId)` on the ticket fetch (:152), a token cannot attach files to another company's ticket. Any fix to the docId scope check should copy this shape, not replace it. |
| Token entropy is not a weakness. `(crypto.randomUUID() + crypto.randomUUID()).replace(/-/g,"").slice(0,40)` keeps all 32 hex chars of a v4 UUID (~122 bits) plus 8 more (~32 bits). | `components/projects/IntakePanel.tsx:145, components/projects/cost/QuotesPanel.tsx:538` | Roughly 154 bits of CSPRNG entropy. Do not spend fix budget here; the exposure is in storage and export (see the backup-export finding), not generation. |
| Revocation and expiry are checked before any work in both public routes, and the portal renders a distinct message for each state. | `app/api/intake/resolve/route.ts:38-42, app/api/intake/upload/route.ts:40-42, app/submit/[token]/page.tsx:124-129` | The kill switch itself works for document links. Only the quote-link UI (no revoke control) and the absence of throttling undermine it. |
| R2 key construction is traversal-safe without needing assertSafeStorageKey: the filename is stripped to [\w.\-] and the key is UUID-prefixed under the org/project prefix. | `app/api/intake/upload/route.ts:70-71, 159-160, 264-265` | An unauthenticated writer cannot escape its org prefix or overwrite an existing object. Keep this if the route is refactored to presigned uploads. |
| The non-trusted intake path really does route through the reviewed-publish pipeline under a real auth.uid(). | `components/projects/IntakePanel.tsx:237-241 → lib/reviewControl.ts:395-509` | `finalizeReviewedRevision` hits the publish-guard trigger with a JWT present, does the CAS on pending_version_id, and calls runPostPublishSideEffects. The safe machinery exists; the trusted branch simply does not use it. |
| Provenance handling for external submissions is correct end to end. | `supabase/migrations/20260903_intake_assignments.sql:42-44, app/api/intake/upload/route.ts:313, lib/reviewControl.ts:461-465` | The CHECK was widened to admit 'external', and finalize only overwrites provenance where it IS NULL — so an approved contractor version keeps its 'external' stamp instead of being laundered into 'declared'. |
| The quote portal deliberately withholds price and bid intelligence from the submitting company, and maps a voided quote to 'not selected' rather than leaving it looking live. | `app/api/intake/resolve/route.ts:79-89` | This is the only place in the external surface that reasons carefully about what a competitor may infer. It is the model the rest of the resolve payload should follow. |


---


<a id="intk-1"></a>

## INTK-1 · A trusted link ASSIGNED an org-authored controlled drawing auto-publishes on its second submission — `linkAuthored` bootstraps from the link's own rejected or pending version

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:245-250`, `app/api/intake/upload/route.ts:257-259`, `app/api/intake/upload/route.ts:302`, `app/api/intake/upload/route.ts:322-329`, `supabase/migrations/20260903_intake_assignments.sql:5-9,21-22`, `components/projects/IntakePanel.tsx:409`

**Mechanism.** `linkAuthored` is computed as "does any document_versions row exist with this record_id AND this intake_link_id" — `const { data: owned } = await supabaseAdmin.from("document_versions").select("id").eq("record_id", docId).eq("intake_link_id", link.id).limit(1); linkAuthored = !!owned?.length;` (:246-248). But the route itself writes exactly such a row on EVERY submission, including the review-routed ones for assigned org documents: `intake_link_id: link.id` at :314. So the first submission against an assigned org drawing is correctly forced through review (linkAuthored=false → autoNow=false at :302), and in doing so it manufactures the very proof of authorship that the second submission reads. On submission two, `linkAuthored` is true, so (a) the in-review lock at :257 `if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored))` no longer blocks, and (b) `autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored` (:302) evaluates true, taking the branch at :322-329 that writes `current_version_id`, `rev`, `revision`, `status: "Issued"` and clears `pending_version_id` directly through the service role. The route's own comment at :299-301 ("an assigned org-authored controlled drawing ALWAYS goes through review, whatever the link's trust level"), the migration comment at 20260903:5-9, and the UI promise at IntakePanel.tsx:409 ("Their revisions of your documents **always** go through review, even on trusted links") are all false after one submission. This is the scope invariant, not the guard-skip — the guard skip itself is prior finding OWN-4 (audit-reports/roles-and-permissions/05-ownership-publish.md:264).

**Failure scenario.** Doc Control assigns P&ID D-25-1042 (a controlled, IFC drawing) to a trusted fabricator's link so they can mark up a tie-in. The fabricator uploads Rev C; it lands in review; Doc Control REJECTS it (IntakePanel.tsx:254-259 sets review_state='rejected' and clears pending_version_id — the version row, with intake_link_id set, survives). The fabricator re-uploads the same file. This time linkAuthored is true, autoNow is true, and D-25-1042 flips to status 'Issued' with the fabricator's rejected file as the controlled copy, `rev` set to whatever 24-character string they typed, and the org's previous version stamped `superseded_at` (:328). The rejection is overridden by the party it was issued against, and the portal tells them "Rev C of D-25-1042 is now the current revision" (:401).

**Evidence.**

```
upload/route.ts:246-248 `.eq("record_id", docId).eq("intake_link_id", link.id as string).limit(1); linkAuthored = !!owned?.length;` — versus :314 `intake_link_id: link.id,` written on every submission including in_review ones. :302 `const autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored;`. :325 `.update({ current_version_id: versionId, rev: revLabel || "A", revision: revLabel || "A", status: "Issued", pending_version_id: null, updated_at: nowIso })`.
```

**Chain reaction.** Because the promote runs on the service role, auth.uid() is NULL and `enforce_document_publish_guard` short-circuits on its first statement (supabase/migrations/20260816_owner_publish_access.sql:41-43 `IF v_actor IS NULL THEN RETURN NEW;`), so per-library publish authority, effective ownership AND the active-hold check (:70-78) are all skipped for a document under MOC or incident hold. Separately, the link that carries this power can be minted by a PROJECT OWNER who is not a controller (20260902_project_intake.sql:52-60 write policy = `is_org_controller(org_id) OR projects.owner_user_id = auth.uid()`), and the same owner writes `assigned_doc_ids` — so project ownership converts into publish authority over any controlled drawing in the org.

> **Verifier correction.** Two refinements that make it worse, not better. (1) The migration comment is at 20260903_intake_assignments.sql:4-8, not 5-9 — trivial. (2) The finding frames the trigger as the assigned-org-doc case, but the same bootstrap fires on the plain new-document path: a brand-new submission has docId=null so autoNow is false at :302 and it goes to review; submission #2 against that now-existing docId reads linkAuthored=true and auto-publishes. The likeliest real-world sequence is also the most damaging — a controller APPROVES submission #1 through finalizeReviewedRevision, which leaves the approved version carrying intake_link_id, and every subsequent contractor submission to that org drawing then bypasses review entirely with no one having consented to that.

**Done when.**

- [ ] `linkAuthored` is derived from a fact the route does not itself create — e.g. a dedicated `authored_by_link_id` stamped only on the document row at creation (upload/route.ts:284-296), never from the version chain the route appends to.
- [ ] A document whose id appears in `assigned_doc_ids` can never take the autoNow branch, regardless of its version history; add an explicit `if (isAssigned) autoNow = false` and a test that submits twice against an assigned doc.
- [ ] A version whose `review_state` is 'rejected' can never make a link look like the author, and a rejected submission cannot be re-published by resubmission without a controller action.
- [ ] The three comments asserting the invariant (upload/route.ts:299-301, 20260903:5-9, IntakePanel.tsx:409) are either true or deleted.

---

<a id="intk-2"></a>

## INTK-2 · Intake auto-supersede is a fourth writer of `current_version_id` that never runs the post-publish pipeline — no stale-copy signal, no fresh read-and-understood roster, no review-cycle reset

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:322-334`, `lib/postPublish.ts:1-13,79-90`, `lib/reviewControl.ts:490-509`, `app/api/intake/upload/route.ts:349-358`

**Mechanism.** lib/postPublish.ts declares itself "THE shared post-publish pipeline. Every path that changes a document's CURRENT revision must run the same side effects — otherwise the paths diverge and the most controlled route quietly skips the protections the direct route provides" (:3-8), and names its callers: revUpDocument, revertToVersion, finalizeReviewedRevision (:9-11). The intake auto-supersede branch changes `current_version_id` (:325) and is not in that list; nothing in app/api/intake/** imports postPublish. So the branch skips all three documented groups: (1) the stale-copy signal to live intent holders and library subscribers (`notifySuperseded`, postPublish.ts:22-64), (2) work-package pin-drift alerts, and (3) the compliance clocks — `onDocumentIssued` (review-cycle reset), `onDocumentIssuedAck` (a FRESH read-and-understood acknowledgement roster on the new revision), and `recomputeRetention` (postPublish.ts:17-19, 79-86). What it does instead is insert three hand-rolled `notifications` rows for Admin/DocCtrl plus the project owner (:337-358). Nobody holding the superseded copy is told anything.

**Failure scenario.** A trusted vendor publishes Rev D of a controlled P&ID through their link. `document_acknowledgments` still records the crew as having read-and-understood Rev C, and no new ack roster opens; `lib/impact.ts:186-193` will keep reporting `pendingDistributionAcks` against the old revision's roster. A pipefitter who acknowledged Rev C is never asked to acknowledge Rev D, holds a printed Rev C at the weld, and the compliance record affirmatively shows them current. The review-cycle clock also never resets, so the document's next periodic-review date is computed from the wrong issue.

**Evidence.**

```
lib/postPublish.ts:9-11 `// Callers: revUpDocument (direct publish), revertToVersion, // finalizeReviewedRevision (review-approved promote).` — the intake route is absent. lib/reviewControl.ts:498-509 shows what the reviewed path does: `const { runPostPublishSideEffects } = await import("@/lib/postPublish"); await runPostPublishSideEffects({ orgId, documentId, libraryId, docLabel, newRev: baseRev, ... })`. app/api/intake/upload/route.ts:322-334 has no equivalent — the branch ends after `.update({ superseded_at: nowIso })` on the prior version.
```

**Chain reaction.** The gap is invisible in the UI because the intake notification reads "published a new revision through their trusted intake link. It is now current" (:347) to controllers — the one audience that does hear. lib/impact.ts, the panel engineers consult BEFORE revving a drawing, reads `distribution_acks` and `document_holds` that this path never touched, so the impact panel under-reports the blast radius of a vendor publish specifically.

> **Verifier correction.** The finding lists three skipped groups; the pipeline actually runs five things. It also silently skips revisionImpact.notifyConnectedWork (postPublish.ts:117-127 — the one-hop warning to anyone drafting against a connected sheet) and linkProposals.staleProposalsForDocument (:132-134). The gap is broader than stated.

**Done when.**

- [ ] The autoNow branch calls `runPostPublishSideEffects` with the same arguments finalizeReviewedRevision passes, or the branch is removed in favour of routing through finalizeReviewedRevision.
- [ ] A test asserts that after an intake auto-supersede, a new acknowledgement roster exists for the new revision and the prior roster is closed.
- [ ] lib/postPublish.ts's caller list is updated to name every writer of `documents.current_version_id`, and a grep-based test fails the build when a new writer appears that does not import it.

---

<a id="intk-3"></a>

## INTK-3 · Adoption never re-checks the impact: colliding sheets are one click from the controlled register, and rejected or still-in-review submissions stay adoptable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/TransitionInPanel.tsx:241-245`, `components/projects/TransitionInPanel.tsx:8-9`, `lib/transitionIn.ts:202-254`, `lib/transitionIn.ts:73-80`, `components/projects/IntakePanel.tsx:254-259`

**Mechanism.** Two gaps. (a) The per-sheet Adopt button is disabled only on `busy === c.docId || !destLib` (:241) — the `impact.clean` flag is not consulted. It renders inside the expanded panel that is displaying the red 'Number collision' banner (:205-211), directly beside the optional renumber input, so the operator can adopt a sheet the panel just told them collides, without renumbering. `adoptDocument` performs no re-scan: it reads the doc, writes `{library_id, collection_id, updated_at}` plus an optional new number, and returns ok (:204-218). Only the BULK button filters on clean (:113). The file header asserts the opposite: "Anything with a collision stays put until a human resolves it — a single source of truth is the whole point" (:8-9). (b) `listTransitionCandidates` selects intake-folder documents with only `.neq("status", "Superseded")` (:78). A rejected submission leaves the document row at status 'Draft' in the intake collection (IntakePanel.tsx:254-259 marks the VERSION rejected and clears the pointer; the document's status is never touched), and a still-pending one is likewise 'Draft'. Both remain transition candidates and both adopt cleanly.

**Failure scenario.** A controller rejects a vendor sheet as unacceptable. Days later, working through the Transition-in list, the same or another controller adopts it — the panel gives no indication it was rejected (it shows number, title, rev and company only, :184-185) — and a rejected drawing enters the controlled library with `current_version_id` NULL, i.e. a register entry with no approved revision behind it. Adopting a still-pending sheet produces the same shape while its review is open.

**Evidence.**

```
TransitionInPanel.tsx:241-242 `<button onClick={() => void adoptOne(c)} disabled={busy === c.docId || !destLib} title={!destLib ? "Pick the destination library above" : undefined}` — no clean check; contrast :113 `const clean = candidates.filter((c) => impacts.get(c.docId)?.clean);` for the bulk path. lib/transitionIn.ts:78 `.neq("status", "Superseded")` — the only status filter. lib/transitionIn.ts:209-218 — adoptDocument's entire validation is `if (!before) return { ok: false, error: "Document not found." }`.
```

**Chain reaction.** The scan results are also computed once at panel load (`refresh`, :43-69) and never refreshed before an adopt, so even the advisory flag is stale by the time it is acted on. Because adoption does not clear `pending_version_id`, an adopted-while-pending document keeps appearing in the Intake review queue (IntakePanel queries by intake_link_id, not by collection) but disappears from the transition list — the two panels disagree about where the document is in its life.

> **Verifier correction.** Half (b) has a partial mitigation worth naming: adopting a still-pending sheet moves it out of the intake collection but leaves documents.pending_version_id set, so the version stays visible in IntakePanel's review queue (:109-113) and can still be approved afterwards. The reviewable state is not destroyed — but the document is in the controlled library before the review concludes, which is the actual document-control breach.

**Done when.**

- [ ] Adopting a candidate re-runs `scanTransitionImpact` server-side and refuses a number collision unless a new number is supplied that itself does not collide.
- [ ] `listTransitionCandidates` excludes documents whose latest intake version is 'rejected', and either excludes or clearly marks those with an open `pending_version_id`.
- [ ] The header comment at TransitionInPanel.tsx:8-9 matches the code, or the single-sheet Adopt button gains the same `clean` gate the bulk button has.

---

<a id="intk-4"></a>

## INTK-4 · Auto-supersede silently voids a pending review — the in_review version is orphaned and vanishes from the Intake review queue

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:257-259`, `app/api/intake/upload/route.ts:325`, `components/projects/IntakePanel.tsx:99-113`

**Mechanism.** When a trusted link submits again while its own prior submission is still awaiting review, the guard at :257 deliberately lets it through (`!(link.allow_auto_supersede && linkAuthored)` is false), and the promote at :325 sets `pending_version_id: null`. The earlier version row keeps `review_state: 'in_review'` forever — nothing in the route or in IntakePanel ever transitions it. The review queue is built by cross-referencing in_review versions against the document's CURRENT pending pointer: IntakePanel.tsx:112-113 filters `vRows.filter((v) => String(dMap.get(String(v.record_id))?.pending_version_id ?? "") === String(v.id))`, and the docs query at :109 further requires `.not("pending_version_id", "is", null)`. Once the pointer is cleared, the orphan matches neither test and disappears from 'Submissions awaiting review' with no rejection, no audit entry, and no notification.

**Failure scenario.** A vendor submits Rev B; a controller opens the Intake tab, sees it queued, and steps away to check it against the field. The vendor, realising they sent the wrong sheet, uploads Rev C. Rev B is now an orphan: it is gone from the queue, still marked in_review in `document_versions`, and Rev C is live as the controlled copy having been reviewed by nobody. The controller returns to an empty queue and reasonably concludes the item was handled.

**Evidence.**

```
upload/route.ts:257-259 `if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored)) { return bad("Your previous submission for this document is still in review — it must be approved or rejected first.", 409); }` — the trusted+authored case is exempted from the message's own rule. :325 `pending_version_id: null`. IntakePanel.tsx:113 `.filter((v) => String(dMap.get(String(v.record_id))?.pending_version_id ?? "") === String(v.id))`.
```

**Chain reaction.** Orphaned in_review rows accumulate with no surface that lists them. `/api/intake/resolve` computes the portal's `lastOutcome` from `review_state` (resolve/route.ts:100-105) mapping neither 'approved' nor 'rejected' to `null`, and `pendingReview` from the document's pointer (:126) — so the contractor sees the row as plain "current" (submit page :296) whether it was reviewed or bulldozed.

> **Verifier correction.** One scope note: the finding presents this as the trusted-link-submits-again case, but per finding 1 the review-routed submission that gets orphaned is frequently the FIRST submission on a brand-new intake document (docId null → autoNow false), so this fires on ordinary new-document flows too, not only on assigned drawings. Also worth stating precisely: the contractor's own portal shows the doc as approved, because resolve/route.ts:100-105 takes the newest version's review_state — so neither side of the transaction ever learns a review was discarded.

**Done when.**

- [ ] A superseding submission explicitly resolves the version it displaces — set `review_state` to 'void' (or 'superseded') with an audit row, rather than leaving 'in_review' behind.
- [ ] A query for `document_versions` with review_state='in_review' whose record_id's `pending_version_id` does not point at them returns zero rows in a fresh environment after an auto-supersede test.
- [ ] The 409 message at :258 is either true for all links or reworded to state the trusted exemption.

---

<a id="intk-5"></a>

## INTK-5 · Documents born through the external door never get `uniqueness_key`, so the DB duplicate-number index never applies to contractor drawings — before or after adoption

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:284-296`, `lib/transitionIn.ts:211-217`, `supabase/migrations/20260619_document_uniqueness_configurable.sql:39-46`, `lib/uniqueness.ts:22-42`

**Mechanism.** The only DB enforcement of "one number, one document" is a PARTIAL unique index on the app-computed column: `CREATE UNIQUE INDEX documents_library_uniqkey_uniq ON documents(library_id, uniqueness_key) WHERE uniqueness_key IS NOT NULL AND status NOT IN ('Archived','Superseded')` (20260619:39-41), with the column comment stating plainly "NULL opts the row out of the uniqueness check" (:44-45). `computeUniquenessKey` is called in exactly two places — the library page's create/edit handlers and the CSV importer — and in neither intake path. The intake document insert (upload/route.ts:284-293) writes `name, title, document_number, status, created_by_name, updated_at` and no `uniqueness_key`. `adoptDocument`, which moves the sheet into a controlled library and can RENUMBER it, builds its patch as `{ library_id, collection_id, updated_at }` plus `if (input.newNumber) patch.document_number = input.newNumber` (transitionIn.ts:211-216) — it changes the number that the key is derived from and never recomputes the key.

**Failure scenario.** A contractor submits a sheet numbered D-25-1042 while the org's own D-25-1042 is live. The row inserts with uniqueness_key NULL, so the unique index does not see it. A controller adopts it into the same controlled library — possibly renumbering it, which still leaves the key NULL. The library now holds two non-superseded documents carrying D-25-1042 and the database will never object, because the only guard is opt-in and externally submitted documents never opt in. That is the exact 'two sources of truth' condition the transition-in module was written to prevent (lib/transitionIn.ts:10-12).

**Evidence.**

```
upload/route.ts:286-292 — the full insert object, with no `uniqueness_key`. lib/transitionIn.ts:211-216 `const patch: Record<string, unknown> = { library_id: input.libraryId, collection_id: input.collectionId, updated_at: nowIso }; if (input.newNumber) patch.document_number = input.newNumber;`. `grep -rn 'uniqueness_key|uniquenessKey' lib app components` returns only app/(protected)/documents/[libraryId]/page.tsx (2424-2438, 2562-2596) and components/documents/CsvImportModal.tsx:162-176; a second, narrower search over `app/api/intake` and `lib/transitionIn.ts` returns nothing.
```

**Chain reaction.** This removes the last backstop behind the application-level collision scan, which is itself opt-in and truncated (see the next finding). Together, the number-collision defence is: an advisory scan the contractor can turn off by leaving the number blank, plus a DB index that structurally cannot see the rows it would need to check.

> **Verifier correction.** The absence claim is under-counted. computeUniquenessKey has FOUR call sites, not two: app/(protected)/documents/[libraryId]/page.tsx:2424 and :2564/:2587, components/documents/CsvImportModal.tsx:162, components/documents/BulkEditModal.tsx:71, and components/documents/MetadataStagingModal.tsx:286 (preview only). This does not weaken the finding — none is on any intake or adoption path — but it means a later bulk edit through BulkEditModal would incidentally heal the key, so the exemption is permanent only until someone happens to bulk-edit the row.

**Done when.**

- [ ] The intake document insert computes `uniqueness_key` from the destination library's `uniqueness_keys` (reusing lib/uniqueness.ts) so the partial index applies from the moment the row exists.
- [ ] `adoptDocument` recomputes `uniqueness_key` whenever it writes `document_number` or moves the row to a different `library_id`, and reports the resulting unique-violation to the operator instead of returning `{ok:false}` with a raw message.
- [ ] A backfill sets `uniqueness_key` for existing rows where it is NULL and `document_number` is not, and a test asserts that adopting two sheets with the same number into one library fails at the database.

---

<a id="intk-6"></a>

## INTK-6 · Live contractor portal tokens are dumped in cleartext into every org backup and shipped to external destinations, reachable by a role that cannot even read the table under RLS

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportTables.ts:51`, `lib/dataExport.ts:95-99,300`, `supabase/migrations/20260913_projects_rls_recursion_fix.sql:99-102`, `app/api/data-export/destinations/route.ts:13`, `supabase/migrations/20260902_project_intake.sql:22`

**Mechanism.** `project_intake_links` is listed in ORG_SCOPED_TABLES (exportTables.ts:51). The exporter dumps each listed table with the SERVICE ROLE and no column projection: `const sb: SupabaseClient = createClient(params.supabaseUrl, params.serviceRoleKey, ...)` (dataExport.ts:86-88) then `let q = sb.from(table).select("*").range(from, from + pageSize - 1)` (:300). `token` is a plain TEXT column with no hashing (20260902:22 `token TEXT NOT NULL UNIQUE`), so every un-revoked bearer credential for every contractor portal lands verbatim in the export bundle. RLS on the table is `is_org_controller(org_id) OR is_project_owner(project_id)` (20260913:100-102, i.e. Admin/DocCtrl or the specific project's owner), but the export API authorises against `const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"]` (destinations/route.ts:13). A Manager — who cannot SELECT a single row of that table directly — can obtain every token in the org through the backup door.

**Failure scenario.** A Manager configures a scheduled export to their own S3 bucket (destination_type/endpoint/bucket/access_key_id are all caller-supplied, destinations/route.ts:24-41) or a webhook. Every nightly run writes the org's complete set of live intake tokens to infrastructure the Manager controls. Each token is a full-power upload credential: with the trusted flag and an assigned document it publishes controlled revisions (see finding 1); without it, it still injects documents into the project's intake library and reveals project name, org name and every assigned document's number, title, rev and status via /api/intake/resolve. Revoking one link does not help — the export carries all of them, and the leak is silent because it uses the feature exactly as designed.

**Evidence.**

```
lib/dataExport.ts:300 `let q = sb.from(table).select("*").range(from, from + pageSize - 1);` iterated over `for (const tbl of ORG_SCOPED_TABLES)` (:95). lib/exportTables.ts:51 `"project_intake_links",`. app/api/data-export/destinations/route.ts:13 `const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];`. Contrast lib/projectSnapshot.ts:40, which selects only `id, revoked_at` — the codebase already knows the token is not safe to hand around.
```

**Chain reaction.** `document_shares` sits one line above in the same list (exportTables.ts:50) and carries the same shape of secret, so the fix is a general one. The restore path re-imports these tables verbatim (lib/dataRestore.ts:288), so a token exported from production and restored into a staging org re-arms the same live credential in a second environment.

> **Verifier correction.** The cited location is the weakest of the three. destinations/route.ts:13 only manages destination rows — it does not run an export. The load-bearing citations are app/api/data-export/structured/route.ts:55 (Manager downloads the whole envelope directly) and app/api/data-export/run/route.ts:18 (Manager triggers build-and-deliver to an external S3 bucket or webhook). Cite those instead. Note also that /run alerts other Admin/DocCtrl afterwards (route.ts:38-62), so the exfiltration is at least noisy — but the alert fires after the tokens have already left.

**Done when.**

- [ ] `dumpTable` accepts a per-table column denylist (or the exporter redacts `project_intake_links.token` and `document_shares.token`) so no bearer secret leaves in a backup.
- [ ] A restore that encounters a redacted token either regenerates one and marks the link revoked, or refuses — a restored backup never resurrects a live external door.
- [ ] The export API's role set and the table's RLS agree, or the export explicitly documents that it is a controller-only surface and drops 'Manager'.

---

<a id="intk-7"></a>

## INTK-7 · The collision scan is opt-in, wildcard-vulnerable, and truncated — the contractor decides whether the 'two sources of truth' check runs at all

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transitionIn.ts:124-142`, `lib/transitionIn.ts:101,147-181`, `app/submit/[token]/page.tsx:230`, `app/api/intake/upload/route.ts:134,137`

**Mechanism.** Four independent defects in one 60-line scan. (1) OPT-IN: the whole number-collision branch is wrapped in `if (candidate.number)` (:124). `number` is optional on the portal — the input's placeholder is literally "Drawing number (optional)" (submit page :230) and the route only requires a title (`if (!ticketId && !docId && !title)`, upload :137). A sheet submitted with no number is never checked against the register, and since `overlapDocs` is also empty, `out.clean = !out.numberCollision && out.overlapDocs.length === 0` (:180) evaluates TRUE — it is promoted to 'clean' and becomes eligible for the bulk 'Adopt N clean' button. (2) WILDCARDS: `.ilike("document_number", candidate.number)` (:129) passes the contractor's raw string into a LIKE pattern; `%` and `_` are metacharacters, so `P-101_` matches P-1010 and a bare `%` matches everything. (3) TRUNCATION: `.limit(5)` (:132) with NO `.order()`, followed by a client-side `find` for the first row that is neither Superseded nor Archived (:133-134). Where a number has more than five rows (superseded history, sheet series), the live one can fall outside the window and the collision is silently missed. (4) TITLE-ONLY TAG SCAN: `tags` come solely from `extractCandidateTags(candidate.number, candidate.title)` (:101) — the file bytes are never read — so `matchedAssets` and therefore `overlapDocs` are empty for any contractor who does not happen to type equipment tags into the title.

**Failure scenario.** A contractor submits twelve as-built sheets, leaving the optional number field blank on all of them (the fastest way to use the portal). Every sheet scans 'clean' — no number to collide, no tags in the title, no overlaps. A controller sets the destination library and clicks 'Adopt 12 clean'. Twelve unnumbered vendor drawings enter the controlled register having been checked against nothing, three of them covering equipment already documented on existing P&IDs that will never be flagged for a tie-in revision.

**Evidence.**

```
lib/transitionIn.ts:124 `if (candidate.number) {`; :129 `.ilike("document_number", candidate.number)`; :132 `.limit(5);`; :133-134 `const live = (((dup ?? []) as Array<Record<string, unknown>>)).find((d) => d.status !== "Superseded" && d.status !== "Archived");`; :180 `out.clean = !out.numberCollision && out.overlapDocs.length === 0;`. The codebase already knows raw user text is unsafe in a PostgREST filter — IntakePanel.tsx:192-193 strips `[,().\\%]` before building an `.or()` — but that lesson was not applied here.
```

**Chain reaction.** `clean` drives the bulk adopt path (TransitionInPanel.tsx:113 `candidates.filter((c) => impacts.get(c.docId)?.clean)`) and the green 'clean' badge at :199, so the flag is read by an operator as an assurance. Combined with the missing `uniqueness_key`, there is no layer left that would catch the duplicate. In the other direction, a contractor who submits number `%` forces a false collision against an arbitrary org document, whose label is then written into a drafting ticket description (lib/transitionIn.ts:295).

> **Verifier correction.** Sub-defect (2) is mis-framed on its own. LIKE metacharacters broaden the match, so a stray `%` or `_` produces FALSE-POSITIVE collisions (noise, blocked adoption), not missed ones — the safety-relevant failure only appears when (2) combines with (3): over-matching floods the unordered five-row window so the genuinely-colliding live document falls outside it and `.find()` returns undefined. State it as a compound defect. Sub-defects (1), (3) and (4) each cause a missed collision on their own and carry the finding.

**Done when.**

- [ ] The number-collision check runs on every candidate; a sheet with no number is classified 'unverifiable', never 'clean'.
- [ ] `candidate.number` is escaped for LIKE (`%`, `_`, `\`) before reaching `.ilike`, or the query uses an equality/normalised-key comparison instead.
- [ ] The duplicate query filters status server-side and orders deterministically rather than taking an arbitrary 5 rows and filtering in JS.
- [ ] `clean` reflects what was actually checked — a sheet whose tag scan found nothing is reported as 'no equipment recognised', which TransitionInPanel already renders (:229-231) but does not let influence `clean`.

---

<a id="intk-8"></a>

## INTK-8 · The external door has no throttling and parses the whole request body before checking the token — and it is the only upload path that streams bytes through the function at all

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:28-33`, `app/api/intake/upload/route.ts:20-22,44-46,266-271`, `lib/storage.ts:218-224,400-423`, `supabase/migrations/20261010_signup_rate_limit.sql:1-17`, `app/submit/[token]/page.tsx:172,244`

**Mechanism.** `req.formData()` is the first statement of the handler (:30); the token regex and DB lookup only run afterwards (:32-39). An unauthenticated caller with no token at all therefore makes the server buffer and MIME-parse an arbitrary multipart body before being told 404. The bytes are then materialised a second time — `const bytes = new Uint8Array(await file.arrayBuffer())` (:267, and :73, :162) — with `maxDuration = 120` (:20) and `MAX_BYTES = 100 * 1024 * 1024` (:22). Nothing keyed on token or IP limits request rate, and a valid token can create unbounded `documents` + `document_versions` rows (or `cost_documents` rows on a quote link) and unbounded R2 objects, one per request. The project HAS the pattern for this: 20261010_signup_rate_limit.sql builds a durable IP-keyed attempt table precisely because "the route runs on serverless functions with no shared memory, so an in-process counter is useless" (:4-6) — for the *signup* endpoint, which is far less powerful than this one. Two differently-shaped searches (`grep -rn 'rate_limit|rateLimit|ratelimit'` across lib/app/supabase, then `grep -rniE 'throttl|x-forwarded|ip\b|attempt|captcha|turnstile'` scoped to app/api/intake and app/submit) find nothing in the intake path.

**Failure scenario.** A leaked or shared token — pasted into a vendor's group chat, or lifted from a backup export — is replayed in a loop. Each request writes a document, a version, a notification per controller, a queued email per controller, an audit row and an R2 object. The org's Intake tab fills with thousands of submissions, every Admin/DocCtrl inbox receives thousands of emails (the route kicks the drain synchronously at :378-383), and the storage bill grows without limit. There is no per-token cap to hit and no signal short of noticing the flood.

**Evidence.**

```
upload/route.ts:29-33 `let form: FormData; try { form = await req.formData(); } catch { return bad("Expected multipart form data"); }` — then `const token = String(form.get("token") ?? "").trim(); if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return bad("invalid token");`. Contrast lib/storage.ts:400-403, where every internal upload presigns direct to R2 and switches to S3 multipart above `const MULTIPART_THRESHOLD = 64 * 1024 * 1024` (:224) — the intake route is the only path that puts file bytes through a Next.js handler.
```

**Chain reaction.** The streaming design also makes the advertised limit unreachable on the actual host: the portal promises "up to 100 MB" (submit page :172, :244) and the route enforces 100 MB, but a Vercel serverless function's request body is capped far below that (vercel.json confirms Vercel deployment), so a real 40 MB DWG set fails with a platform 413 that the portal surfaces to the contractor as the bare string `HTTP 413` (submit page :96). SUSPECTED on the exact platform limit, CONFIRMED that this route alone buffers the body server-side while every other upload presigns. Note the constraint recorded for this codebase: no third vercel.json cron entry is permitted, so any cleanup job must attach to /api/cron/maintenance.

> **Verifier correction.** Two overstatements. (1) "the only upload path that streams bytes through the function at all" is not quite true — app/api/admin/ticket-shed/restore/route.ts:69 also does `await req.arrayBuffer()`. It is fair to say intake is the only UNAUTHENTICATED path that does so, and the only user-file upload path that does (all internal uploads presign direct to R2 via lib/storage.ts getPresignedUploadUrl, switching to S3 multipart above MULTIPART_THRESHOLD at lib/storage.ts:224). (2) The storage.ts line cites are off by roughly ten lines (the presign call sits near :412, not :400-403); the threshold constant at :224 is exact.

**Done when.**

- [ ] The token is validated (format, existence, not revoked, not expired) before the body is read — e.g. move the token to a header or query parameter and reject before `formData()`.
- [ ] A durable per-token and per-IP attempt table, modelled on `signup_attempts`, caps submissions per window; exceeding it returns 429 with a message the portal can render.
- [ ] Intake uploads use the same presigned direct-to-R2 path as every internal upload, so the advertised size limit is the real one.
- [ ] A per-link submission cap (and a per-link storage budget) exists, and its pruning attaches to the existing /api/cron/maintenance entry rather than a new cron.

---

<a id="intk-9"></a>

## INTK-9 · `assigned_doc_ids` is an unvalidated UUID[] that both public routes trust without an org check — a non-controller project owner can point a contractor at another tenant's document

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:249,253-256`, `app/api/intake/resolve/route.ts:108-120`, `supabase/migrations/20260902_project_intake.sql:51-60`, `supabase/migrations/20260903_intake_assignments.sql:18-19`, `components/projects/IntakePanel.tsx:215-220`

**Mechanism.** `assigned_doc_ids UUID[] NOT NULL DEFAULT '{}'` (20260903:18-19) has no FK, no CHECK, and no trigger constraining its contents to the link's own org or project. The RLS write policy (20260902:51-60) gates WHO may write the row — `is_org_controller(org_id) OR projects.owner_user_id = auth.uid()` — but says nothing about WHAT goes in the array. The client-side picker filters by org (`IntakePanel.tsx:201 .eq("org_id", orgId)`) but the write is a plain `supabase.from("project_intake_links").update({ assigned_doc_ids: ids })` (:218-219), so any UUID can be posted. Both public routes then dereference those ids with the service role and NO org predicate: upload/route.ts:253-255 `.from("documents").select(...).eq("id", docId).maybeSingle()` and resolve/route.ts:116-119 `.from("documents").select("id, document_number, title, name, rev, status, pending_version_id, updated_at").in("id", docIds)`. The scope test at :249-250 only asks `isAssigned`, never `d.org_id === link.org_id`.

**Failure scenario.** A project owner who is not a controller (the RLS policy admits them) posts another org's document id into `assigned_doc_ids`. The contractor's portal now lists that foreign document's number, title, rev and status, and the contractor can submit revisions to it. The version rows the route creates carry `org_id: orgId` (the link's org, upload/route.ts:306) while `record_id` points at a document owned by a different tenant — cross-tenant write with corrupted tenancy metadata, and after the second submission (finding 1) it publishes.

**Evidence.**

```
upload/route.ts:249-250 `const isAssigned = (((link.assigned_doc_ids as string[] | null) ?? [])).includes(docId); if (!linkAuthored && !isAssigned) { return bad("This link may only submit revisions to its own or assigned documents.", 403); }` — followed at :253-255 by a document fetch with no `.eq("org_id", orgId)`. resolve/route.ts:116-119 has the same omission. Compare the ticket branch at :152, which DOES scope: `.eq("id", ticketId).eq("org_id", orgId)`.
```

**Chain reaction.** Prior finding OWN-4 (audit-reports/roles-and-permissions/05-ownership-publish.md:305-311) flagged the project-owner minting problem and the `intake_library_id` write; the assignment array is the same cross-axis leak with a wider reach, because it names individual controlled documents rather than a library. Because `assigned_doc_ids` is also a bare array update with no read-modify-write protection (IntakePanel.tsx:218), two concurrent assignment edits silently clobber one another.

> **Verifier correction.** Overstated in one respect: exploitation requires the project owner to already possess a valid document UUID belonging to another tenant, which the org-filtered picker at IntakePanel.tsx:202 will never surface. So this is a broken tenant-isolation invariant and a defense-in-depth failure rather than a directly reachable cross-tenant read — the attacker needs an out-of-band UUID. It stays HIGH because service-role code writing to a document without ever checking org_id is the exact shape that turns any future UUID leak into a cross-tenant write.

**Done when.**

- [ ] Both public routes add `.eq("org_id", link.org_id)` to every document fetch derived from `docId` or `assigned_doc_ids`.
- [ ] A DB-level constraint or trigger rejects an `assigned_doc_ids` entry whose document's `org_id` differs from the link's `org_id`.
- [ ] Assigning a controlled document to an external link requires the same authority as publishing in that document's library, not merely project ownership.

---

<a id="intk-10"></a>

## INTK-10 · Intake notifications bypass `emit`/`queueEmail` entirely — hardcoded Admin/DocCtrl recipients, no follower resolution, and email that ignores every per-user preference despite a comment claiming otherwise

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:97-113`, `app/api/intake/upload/route.ts:337-358`, `app/api/intake/upload/route.ts:360-385`, `lib/notify/dispatch.ts:3-8`, `lib/notifications.ts:50-89`, `lib/transitionIn.ts:335-354`

**Mechanism.** lib/notify/dispatch.ts declares itself "THE single entry point every producer should call. One event in → resolved recipients (from all follow systems) → fanned out to every delivery channel ... each honoring per-user, per-channel preferences" (:3-6). The intake route calls it nowhere. Instead it hand-builds the audience as `.in("role", ["Admin", "DocCtrl"])` plus `project.owner_user_id` (:337-342, and again at :98-103 for quotes) — facility vocabulary hardcoded in application code — and inserts `notifications` rows directly (:104, :197, :349), so document followers, library subscribers and live intent holders hear nothing about an external submission. The email leg is worse: the comment at :360-362 says "Queued rows honor delivery config; the drain kick makes it land in seconds", but the code inserts straight into `email_notifications` (:377) instead of calling `queueEmail`, which is where all four gates live — `if (prefs?.email_enabled === false) return; if (prefs?.digest_frequency === "never") return; if (!shouldSendForEvent(prefs, input.eventType)) return;` plus a 60-second per-resource dedupe (lib/notifications.ts:59-75). None of them run. The insert is also unchecked: `await supabaseAdmin.from("email_notifications").insert(rows);` resolves with `{error}` rather than throwing, so a failed insert inside the surrounding try/catch reads as success — the established supabase-js pattern.

**Failure scenario.** A Doc Control lead who has switched email off entirely (`email_enabled: false`) still receives an email for every external submission, from a route that believes it is honouring their setting. Meanwhile an engineer who is watching the specific drawing a contractor just superseded receives nothing, because the route resolves no followers. In a burst (see the throttling finding) the missing dedupe means one email per submission per controller with no 60-second suppression.

**Evidence.**

```
upload/route.ts:362 `// rows honor delivery config; the drain kick makes it land in seconds.` immediately above :377 `await supabaseAdmin.from("email_notifications").insert(rows);`. lib/notifications.ts:59-61 shows the gates that are skipped. upload/route.ts:338 `.in("role", ["Admin", "DocCtrl"])`. The other half of the same feature does it correctly — lib/transitionIn.ts:339-352 calls `emit({ orgId, category: "assignment", kind: "request_pending_approval", ..., audience: { involved: recipients.map((m) => m.uid) } })` after `resolveTicketRecipients`.
```

**Chain reaction.** This is the notifications area's established shape (already-audited: raw inserts, unchecked writes, hardcoded ["Admin","DocCtrl"]), but it matters more here because this is the only notification an org gets that an OUTSIDE party changed their document control state. The `notifications` FOR ALL / USING-only policy noted in that audit means these rows are also writable by any active org member.

> **Verifier correction.** One nuance on the unchecked insert: it sits inside a best-effort try/catch that the code explicitly labels "the submission itself already succeeded", so an unnoticed failure degrades notification delivery rather than corrupting record state. That is a weaker consequence than the audit-logger instance of the same pattern — MEDIUM is the right level, and the preference-bypass (a user who set digest_frequency='never' still receives mail) is the sharper half of the finding.

**Done when.**

- [ ] Both intake branches call `emit` with an audience that includes followers and live intent holders on the target document, not just a hardcoded role list.
- [ ] The email leg calls `queueEmail` so preference, digest and dedupe gates apply, or the comment at :360-362 is corrected to say the opposite.
- [ ] Every `insert` in this route checks `{ error }` rather than relying on try/catch, and the role list comes from the org's capability/role configuration rather than a literal array.

---

<a id="intk-11"></a>

## INTK-11 · No content validation on the external door: any MIME type and extension accepted, attacker-controlled Content-Type stored on the object, and unbounded title/number/rev text written into the register

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:44-46,74-77,163-166,268-271`, `app/api/intake/upload/route.ts:133-136`, `app/api/intake/upload/route.ts:307,325`, `app/submit/[token]/page.tsx:173,245`

**Mechanism.** The only file check is existence and size (`if (!(file instanceof File) || file.size === 0)`, `if (file.size > MAX_BYTES)`, :45-46). No extension allowlist, no MIME allowlist, no magic-byte sniff. The caller's declared type is then persisted onto the R2 object: `ContentType: file.type || "application/octet-stream"` (:76, :165, :270) and into `document_versions.file_type` (:308). The quote branch is the sharpest case: the portal restricts the picker with `accept=".pdf,application/pdf"` (submit page :173) and the notification tells the team to "Run the AI read from the project's Costs tab to tabulate it" (:108), but the server accepts anything at all — the document branch's picker has no `accept` at all (:245). Separately, of the four text fields the route reads, two are bounded and two are not: `revLabel` is `.slice(0, 24)` and `changeNote` is `.slice(0, 2000)` (:135-136), while `title` and `number` are `String(form.get(...)).trim()` with no cap (:133-134) and go straight into `documents.name/title/document_number` (:288-289). `revLabel` is also written unvalidated into `documents.rev` and `documents.revision` on the auto-supersede path (:325) — any 24 characters become the org's controlled revision label.

**Failure scenario.** A contractor uploads `plan.html` with `Content-Type: text/html`. It is stored with that type and served from a presigned R2 GET (app/api/storage/download-url) with no `ResponseContentDisposition` override, so an internal reviewer opening it gets script execution in the bucket's origin rather than a document preview. Separately, a submission with a 5 MB `title` string bloats the documents row and every list query that selects it; and a trusted-link publish can set the controlled revision label of a P&ID to an arbitrary 24-character string such as `0` or a homoglyph of an existing rev.

**Evidence.**

```
upload/route.ts:45-46 — the complete file validation. :270 `ContentType: file.type || "application/octet-stream",`. :133-134 `const title = String(form.get("title") ?? "").trim() || null; const number = String(form.get("number") ?? "").trim() || null;` versus :135-136 which both `.slice()`. :325 `rev: revLabel || "A", revision: revLabel || "A"`.
```

**Chain reaction.** SUSPECTED on the XSS consequence: I cannot read the bucket's public-hostname configuration, so whether the served origin is same-site or a separate r2 domain is not determinable from the repo. What IS confirmed is that no upload path in the codebase validates content type (app/api/storage/upload-url/route.ts:48-52 passes `contentType` through identically) — so this is a systemic gap that the unauthenticated door makes reachable without an account.

> **Verifier correction.** Note that `accept` on an <input type="file"> is a picker hint, not enforcement, even client-side — so the quote-branch asymmetry is a mismatch between stated intent and server behaviour, not a client control that the server fails to mirror. Also, title/number are unbounded only in application code; the documents table is not defined in supabase/migrations (it predates them), so whether a DB-level length cap exists is not observable from this repo. Treat the unbounded-text half as SUSPECTED and the MIME/extension half as CONFIRMED.

**Done when.**

- [ ] Intake uploads are checked against an extension+MIME allowlist appropriate to the branch (PDF only for quotes; PDF/DWG/DXF/ZIP for drawings), with a magic-byte check for the declared type.
- [ ] Stored `ContentType` is derived from the validated type, never echoed from `file.type`, and download URLs set an explicit attachment disposition.
- [ ] `title` and `number` are length-capped like `changeNote`, and `revLabel` is validated against a revision-label format before it can become `documents.rev`.

---

<a id="intk-12"></a>

## INTK-12 · Quote links are permanent bearer credentials: no expiry offered, no revoke control in the Costs tab, and their creation audit row writes a fragment of the secret token as the resource id

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/cost/QuotesPanel.tsx:536-548`, `components/projects/cost/QuotesPanel.tsx:613-635`, `components/projects/IntakePanel.tsx:62-64,354-359`, `components/projects/QuotesPanel.tsx:546-548`

**Mechanism.** The quote-link creator inserts `{ org_id, project_id, token, company_name, purpose: "quote", rfq_group, created_by }` (QuotesPanel.tsx:539-544) — no `expires_at`, and the form offers no expiry field (contrast IntakePanel.tsx:431, which has a date input). The rendered list filters out revoked links (`(links ?? []).filter((l) => !l.revokedAt)`, :613) but provides no control to revoke one: the row's only buttons are 'RFQ (.docx)' and 'Copy link' (:621-634). The only revoke path is the Intake tab, whose query is `.eq("project_id", projectId)` with no `purpose` filter (IntakePanel.tsx:62-64), so quote links appear there rendered as document links — with a 'Copy link' and an 'Assign docs' control (:352-357) whose assignments are a silent no-op, because both public routes branch on `purpose === "quote"` and return before ever reading `assigned_doc_ids` (resolve:64-91, upload:64-129). Separately, the creation audit row is written as `resource_type: "project_intake_link", resource_id: token.slice(0, 8)` (:547) — the resource id is eight characters of the live secret rather than the link's id (which the insert never selects back). If `audit_logs.resource_id` is UUID-typed the insert fails and is swallowed by `.then(() => undefined, () => undefined)`, leaving no audit trail at all for minting a contractor door; if it is TEXT, token material is written into the audit log.

**Failure scenario.** A buyer creates quote links for five bidders. The award goes out; the losing bidders' links stay live forever. Months later a bidder replays their link and submits a new 'quote' that appears in the project's bid tabulation with `status: 'draft'` → the portal shows it 'under review' — for an award already made. To stop it, the buyer must know to go to a different tab, where the link is presented as a drawing-submission link with an 'Assign docs' button that appears to grant document access and does nothing.

**Evidence.**

```
QuotesPanel.tsx:539-544 — the insert object, no `expires_at`. :613-634 — the rendered row: `<button onClick={() => void makeRfq(l)}...>` and `<button onClick={() => void copy(l)}...>`, no revoke. :547 `action: "INTAKE_QUOTE_LINK_CREATED", resource_type: "project_intake_link", resource_id: token.slice(0, 8),` — compare IntakePanel.tsx:175 for revocation, which correctly uses `resource_id: l.id`.
```

**Chain reaction.** IntakePanel's own audit row for creation has the mirror-image defect: `resource_id: projectId` (IntakePanel.tsx:156) rather than the link id, because the insert at :146 does not `.select()` the new row back. So neither door records WHICH link was created — the audit trail for minting an external credential identifies the project, or eight characters of the secret, but never the link.

> **Verifier correction.** Two fixes. (1) components/projects/QuotesPanel.tsx does not exist — the only file is components/projects/cost/QuotesPanel.tsx. Drop that location. (2) The audit_logs table is not defined in supabase/migrations (it predates them), so its resource_id type is not readable from this repo; the finding's disjunction is the right way to state it, and the circumstantial evidence favours UUID — every other audit_logs write in the codebase passes a UUID (lib/transitionIn.ts:243, lib/milestones.ts:323, app/api/transmittal/route.ts:77, IntakePanel.tsx:175), making the silent-failure branch (no audit trail at all for minting a contractor door, swallowed by `.then(() => undefined, () => undefined)`) the likelier outcome.

**Done when.**

- [ ] The quote-link form offers an expiry, and the list carries a revoke button that writes `revoked_at`.
- [ ] IntakePanel filters to `purpose = 'documents'` (or labels quote links distinctly and hides 'Assign docs' for them), so a link is never presented as a capability it does not have.
- [ ] Both link-creation inserts `.select("id").single()` and the audit row's `resource_id` is that id; no token material is ever written to `audit_logs`.
- [ ] Both audit inserts check `{ error }` instead of swallowing it, so a failed audit of external-credential creation is visible.

---

<a id="intk-13"></a>

## INTK-13 · The external door leaks raw Postgres error text, answers as an existence oracle for ticket ids, and races itself into duplicate intake folders on an unchecked write

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:93,191,294,318`, `app/api/intake/upload/route.ts:149-157`, `app/api/intake/upload/route.ts:231-240`, `app/submit/[token]/page.tsx:96,101`

**Mechanism.** Three distinct leaks of internal state through the unauthenticated surface. (1) ERROR TEXT: four failure paths interpolate the database's message straight into the response body — `return bad(\`Couldn't record the quote: ${qErr?.message ?? "unknown"}\`, 500)` (:93), `\`Couldn't attach the redline: ${updErr.message}\`` (:191), `\`Couldn't create the document: ${docErr?.message ?? "unknown"}\`` (:294), `\`Couldn't record the submission: ${verErr?.message ?? "unknown"}\`` (:318). Postgres surfaces column names, constraint names and RLS policy names in those strings, and the portal renders the raw text to the contractor (`throw new Error(body?.error || ...)` → `setMsg({ tone: "err", text: (e as Error).message })`, submit page :96, :101). (2) ORACLE: the redline branch fetches `.eq("id", ticketId).eq("org_id", orgId)` and returns 404 'Ticket not found.' when the row is absent but 403 'This link may only attach redlines to its own collision tickets.' when it exists in the org (:153, :156) — a token holder can confirm whether a given ticket UUID belongs to the org. (The document branch correctly avoids this by checking scope BEFORE fetching, :249-256.) (3) UNCHECKED WRITE + RACE: when a project has no intake folder yet, the route creates one and persists the id with `await supabaseAdmin.from("projects").update({ intake_collection_id: collectionId }).eq("id", projectId);` (:239) — no `{ error }` check, and no uniqueness on the collection name. If that write fails, or if two submissions arrive concurrently, each subsequent submission takes the `if (!collectionId)` branch again and inserts another collection named `Intake — <project>`.

**Failure scenario.** Two contractors submit within the same second against a project whose intake folder does not exist yet. Both see `intake_collection_id` NULL, both insert a collection, and the library now holds two folders called 'Intake — Unit 4 Revamp'. `projects.intake_collection_id` points at one of them, so TransitionInPanel (`listTransitionCandidates(orgId, intakeCollectionId)`, transitionIn.ts:76-77) scans only that folder — the other contractor's sheets are invisible to the adoption workflow and to the collision scan, sitting in the register unexamined.

**Evidence.**

```
upload/route.ts:232-240 `if (!collectionId) { const { data: col, error: colErr } = await supabaseAdmin.from("collections").insert({ org_id: orgId, library_id: libraryId, name: \`Intake — ${String(project.name ?? "Project")}\` }).select("id").single(); if (colErr || !col) return bad("Couldn't prepare the intake folder.", 500); collectionId = String(col.id); await supabaseAdmin.from("projects").update({ intake_collection_id: collectionId }).eq("id", projectId); }` — the collection insert IS checked, the projects update is not. :149-156 for the 404/403 split. :294 and :318 for the raw error interpolation.
```

**Chain reaction.** The unchecked `projects` update is the supabase-js `{error}`-not-thrown pattern the prior audits catalogued. It also interacts with the transition-in finding: a sheet in an orphaned second intake folder is never scanned for collisions and never appears in the Transition-in list, so it silently stays out of document control while the register shows it as a Draft in the intake library.

> **Verifier correction.** Trim one sub-claim. "No uniqueness on the collection name" is not verifiable here — the collections table is not defined in supabase/migrations (it predates them) and no unique index on it appears in any migration, so its absence cannot be asserted from the repo. It also does not matter: with a unique constraint the concurrent second insert would fail into `bad("Couldn't prepare the intake folder.", 500)`, and without one it produces a duplicate "Intake — <project>" folder. Either way the unchecked write at :239 is the defect. The oracle (2) is also the mildest leg — it confirms org membership of a UUID the caller must already hold — so the finding rests mainly on (1) and (3).

**Done when.**

- [ ] Error responses to the unauthenticated portal carry a generic message and a correlation id; the database message is logged server-side only.
- [ ] The redline branch checks link ownership before (or independently of) whether the ticket exists, so both cases return the same status.
- [ ] The `intake_collection_id` write checks `{ error }` and fails the request if it cannot persist; the collection creation is idempotent (unique index on `(library_id, name)` or a re-read under lock) so concurrent first submissions cannot fork the folder.

---

<a id="intk-14"></a>

## INTK-14 · `bump_intake_use` is a SECURITY DEFINER function with no REVOKE — PostgREST exposes it and any caller can tamper with any org's intake-link usage record

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260902_project_intake.sql:73-79`, `supabase/migrations/20260913_projects_rls_recursion_fix.sql:99-102`, `supabase/migrations/20260930_semantic_layer.sql:119-120`, `app/api/intake/upload/route.ts:121,214,393`

**Mechanism.** `CREATE OR REPLACE FUNCTION bump_intake_use(p_link UUID) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ UPDATE project_intake_links SET last_used_at = NOW(), submission_count = submission_count + 1 WHERE id = p_link; $$;` (20260902:74-79). It correctly pins `search_path`, but no `REVOKE ALL ON FUNCTION bump_intake_use(UUID) FROM public, anon` follows — so it keeps the default PUBLIC EXECUTE grant and is reachable over PostgREST as `rpc/bump_intake_use`. Being SECURITY DEFINER it writes past the table's RLS, which otherwise restricts writes to `is_org_controller(org_id) OR is_project_owner(project_id)`. The codebase applies the correct pattern elsewhere and repeatedly — `REVOKE ALL ON FUNCTION semantic_search(...) FROM public, anon; GRANT EXECUTE ... TO authenticated` (20260930:119-120), and the same shape in 20260929:133-134, 20261007:100-103, 20261011:41-42, 20261012:48-49, 20261014:28-29 — so the omission here is an outlier, not a house style.

**Failure scenario.** Anyone who can reach the PostgREST endpoint calls `bump_intake_use` in a loop with a guessed or observed link UUID. `submission_count` and `last_used_at` are the org's only at-a-glance record of contractor portal activity — they are rendered directly in the Intake tab (IntakePanel.tsx:348) and the Costs tab (QuotesPanel.tsx:551), and feed the vendor responsiveness view (lib/companies.ts:252 selects `submission_count, created_at, last_used_at`). Corrupting them makes a dormant link look active, or masks the true submission count when someone reconciles what a vendor claims to have sent against what the register shows.

**Evidence.**

```
20260902_project_intake.sql:73-79 — the full function definition, with no GRANT/REVOKE line before or after it. Two search shapes confirm: `grep -rn 'REVOKE|GRANT EXECUTE' supabase/migrations/*.sql` lists 26 hits, none naming `bump_intake_use`; `grep -rn 'bump_intake_use'` finds only the definition and the three service-role call sites (upload/route.ts:121, 214, 393).
```

**Chain reaction.** SUSPECTED rather than CONFIRMED only because I cannot read the deployed grant state — the mechanism (SECURITY DEFINER + no REVOKE + PostgREST exposure of the public schema) is unambiguous in the repo, but whether `anon` or only `authenticated` inherits the PUBLIC grant depends on the project's ALTER DEFAULT PRIVILEGES. The function returns VOID for both existing and non-existing ids, so it is at least not an existence oracle. This is an instance of the SECURITY DEFINER pattern the prior audits flagged; note that `is_org_controller` itself (20260814_documents_delete_controllers.sql:31-32) is SECURITY DEFINER with no `SET search_path` at all.

> **Verifier correction.** SUSPECTED is the right label and should stay. The blast radius is narrow and worth stating: the function's only effect is setting last_used_at and incrementing submission_count on one row, it takes the link's internal UUID (not the token) so it leaks nothing back to the caller, and PostgREST exposure additionally depends on deployment-level schema exposure that cannot be read from this repo. The concrete harm is falsifying the intake-usage audit surface the Intake tab renders (IntakePanel.tsx:348) — real for a PSM record, but not a route to the token or to document control.

**Done when.**

- [ ] `REVOKE ALL ON FUNCTION bump_intake_use(UUID) FROM public, anon, authenticated; GRANT EXECUTE ... TO service_role;` is added, matching the pattern in 20260930/20261007.
- [ ] A sweep confirms every SECURITY DEFINER function added since 20260902 either carries an explicit grant policy or is deliberately public with a written reason.

---
