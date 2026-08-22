# 04 · Holds & stop-work

**14 findings** — 6 HIGH · 8 MEDIUM.

Whether a hold blocks every path or only the ones somebody remembered.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The two-layer publish guard: a pure, exhaustively unit-tested decision function plus a Postgres trigger that re-checks it | `lib/documentGuards.ts:109-151, lib/__tests__/documentGuards.test.ts:128-167, supabase/migrations/20260822_review_completion_guard.sql:77-86` | This is the one place holds are genuinely hard-enforced, and the split it encodes is correct and deliberate: `canForceLock` admits a per-library publisher's override-with-reason, `canForceHold = forcing && isController` does not — "an override-with-reason must never jump a safety hold". The DB trigger backstops it for direct PostgREST writes. Every fix above should extend this model, not replace it. |
| publish_revision's transactional re-check of the hold under a row lock, with p_force and p_override_lock deliberately unconflated | `supabase/migrations/20260828_integrity_hardening.sql:93-110` | The RPC serialises on `SELECT * FROM documents WHERE id = p_doc FOR UPDATE` and re-evaluates the hold inside that lock, closing the check-then-act race the app layer alone would leave open. The migration header documents why p_override_lock was split out — it exists precisely because the old conflation let a checkout override bypass a hold. Do not re-merge those parameters. |
| The three public verify surfaces and the printed artifacts that feed them | `app/verify/[docId]/page.tsx, app/verify-hold/[holdId]/page.tsx, app/verify-package/…, lib/physicalBridge.ts` | The pattern — unauthenticated, UUID-keyed, minimal-facts, one unmissable colour — is the right answer for a plant floor and the /verify-hold page in particular gets the failure mode right ("Treat the hold as ACTIVE until Document Control confirms otherwise" on error, app/verify-hold/[holdId]/page.tsx:67-69). The fix for the hold-blindness is to teach /api/verify and /api/verify-package about holds, not to change this architecture. |
| Multiple simultaneous holds per document, enforced by a partial unique index on the open ones | `supabase/migrations/20260612_phase5_holds.sql:60-62, lib/holds.ts:129-137` | `document_holds_open_reason_uniq ON document_holds(document_id, reason) WHERE released_at IS NULL` lets "Awaiting Engineering" and "Missing Vendor Data" coexist while preventing a duplicate of either, and openHold translates the 23505 into a readable message. The log-not-flag shape is what makes duration metrics and history possible; keep it. |
| releaseHold's double-release guard | `lib/holds.ts:180-193` | `.eq("id", input.holdId).is("released_at", null).select("*").single()` makes a concurrent second release fail loudly rather than silently overwrite the first releaser's identity and timestamp. This is the correct compare-and-swap shape and should be preserved by any trigger added on top of it. |
| The legal-hold DELETE triggers, which apply to service-role and cascades alike | `supabase/migrations/20260826_legal_hold_delete_guard.sql:11-13, 29-56` | "Applies to EVERYONE (including service-role scripts) … Note this also blocks cascading deletes that would remove a held document (e.g. deleting its org) — intentionally." Guarding document_versions as well as documents closes the app's delete-versions-first path. The only thing missing is that nothing verifies the legal_hold flag was actually set (see the retention finding). |
| Capability policy read by Postgres, so hold authority is enforced at the database rather than only in the client | `supabase/migrations/20260901_db_hard_enforcement.sql:28-105` | org_capability_allows() reads role tokens, additive roles[] and per-person grants with expiry, and the holds INSERT/UPDATE policies call it — this is the correct enforcement location and it pins search_path. The defect is not the mechanism but the shipped default and the unconstrained column surface it gates. |


---


<a id="hld-1"></a>

## HLD-1 · A hold is a hard block only on "advance" transitions; download, transmittal, distribution-ack, share link, checkout, revision-label correction, renumber and disposal all proceed unguarded

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260822_review_completion_guard.sql:36-40`, `supabase/migrations/20260822_review_completion_guard.sql:77-86`, `lib/documentGuards.ts:138-148`, `lib/revisions.ts:1051-1118`, `lib/retention.ts:151-158`, `lib/downloads.ts`, `lib/transmittals.ts`, `lib/distributionAcks.ts`, `lib/documentShares.ts`, `lib/documentLifecycle/renumber.ts`

**Mechanism.** Both enforcement layers scope the hold check to publishing a new canonical revision. The DB trigger computes `v_advancing := (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) OR (NEW.status = 'Superseded' AND COALESCE(OLD.status,'') <> 'Superseded'); IF NOT v_advancing THEN RETURN NEW; END IF;` (20260822:36-40) and only then reaches the `document_holds … released_at IS NULL` test. `evaluatePublishGuard` is only ever reached from `authorizePublish` in the rev-up / revert / supersede paths. Everything else that puts a held drawing in front of a human is untouched: `grep -rn "document_holds" --include='*.ts' --include='*.tsx'` returns zero hits in lib/downloads.ts, lib/docPack.ts, lib/transmittals.ts, lib/acknowledgments.ts, lib/distributionAcks.ts, lib/documentShares.ts, lib/checkoutEpisodes.ts and lib/documentLifecycle/renumber.ts; a second per-file `grep -n "hold|Hold"` over those files returns only unrelated words ("holder", "holding"). Two concrete state-changing paths are worth naming: `correctRevisionLabel` rewrites `document_versions.revision_label` and then `documents.rev`/`documents.revision` (revisions.ts:1099-1111) with an authority check but no hold check, and it slips the DB trigger because it never touches `current_version_id`; `disposeDocument` checks `isLegalHold` and nothing else before setting `status: "Archived", disposition_state: "disposed"` (retention.ts:153-156), and status→Archived is not an "advance" transition either.

**Failure scenario.** An MOC-driven "Client Review" hold sits on a piping isometric. During the hold: a contractor is sent a transmittal containing it, twelve people are assigned a read-and-understood acknowledgment against it and all sign, a public share link is issued, its revision label is corrected from 3 to 3A (changing what the register, the inspector and every hold card display), and — once the retention clock expires — it is disposed and archived. The /admin/holds queue still shows the hold open the entire time, pointing at a document that is now Archived. Nothing in any of those flows mentioned the hold.

**Evidence.**

```
supabase/migrations/20260822_review_completion_guard.sql:36-40 — `v_advancing := (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded'); IF NOT v_advancing THEN RETURN NEW; END IF;`  •  lib/revisions.ts:1099-1103 — `const { error: upErr } = await supabase.from("document_versions").update({ revision_label: check.label }).eq("id", versionId);`  •  lib/retention.ts:153 — `if (await isLegalHold(input.documentId)) return { ok: false, reason: "legal_hold" };` (no document_holds check)  •  lib/documentGuards.ts:6-7 comment — "historically locks and holds were advisory … This module turns those invariants into enforced rules."
```

**Done when.**

- [ ] A single `assertNotOnHold(documentId)` helper exists and is called by correctRevisionLabel, renumberDocument, disposeDocument, transmittal issue, distribution-ack assignment and share-link creation
- [ ] Download and doc-pack paths either refuse or stamp a HOLD banner rather than proceeding silently
- [ ] The DB trigger's advance test is widened, or a second trigger added, so that status→Archived and revision_label rewrites on a held document are refused for non-controllers

---

<a id="hld-2"></a>

## HLD-2 · Split and merge supersede a held source without any hold check, then copy the holds to the new sheets on a best-effort, error-swallowing path that is outside the compensation register

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/documentLifecycle/split.ts:137-170`, `lib/documentLifecycle/merge.ts:191-224`, `lib/documentLifecycle/common.ts:253-280`, `lib/documentLifecycle/common.ts:319-377`, `lib/revisions.ts:1425-1428`

**Mechanism.** Three defects compound. (1) `splitDocument` and `mergeDocuments` call `markSupersededAndLink` directly (split.ts:137, merge.ts:191), which issues a bare `.update({ status: "Superseded", … })` (common.ts:269-280) with no `authorizePublish` and therefore no hold evaluation — unlike `supersedeDocument`, which does call it (revisions.ts:1425-1428, "same per-library publish authority + lock/hold guard"). Only the DB trigger stands in the way, and it short-circuits for Admin/DocCtrl before reaching the hold test (20260822:62-66), so a controller splits a held drawing with no force flag, no confirmation and no audit that a hold was overridden. (2) The hold carry-over runs *after* the source is already Superseded and the new sheets already exist (split.ts:162-170 is step 3; markSupersededAndLink is step 2), and it is deliberately excluded from the rollback register — the comment says "A transient copy failure here is reported via honest counts rather than rolling back the whole split" (split.ts:155-159). (3) `copyActiveHoldsToDoc` swallows the insert error entirely: `const { data: insertedHold, error } = await supabase.from("document_holds").insert({…}); if (!error && insertedHold) { copied++; … }` (common.ts:351-364) — a row that fails to insert is silently not copied and not reported as a failure, only as a smaller number.

**Failure scenario.** A cluttered P&ID under an "Awaiting Engineering" hold is split into three sheets by a DocCtrl. The supersession succeeds with no hold prompt. RLS or a transient error rejects the three hold inserts (or the caller passed copyHolds:false). The result object reports holdsCopied:0 and the split "succeeded." The source is now Superseded and its hold is stranded on a retired document; the three new live sheets carry no hold at all and publish, download, transmit and pack freely. The engineering blocker that stopped work has been laundered away by a structural edit.

**Evidence.**

```
lib/documentLifecycle/common.ts:351-364 — `const { data: insertedHold, error } = await supabase.from("document_holds").insert({ … }).select("id").single();` / `if (!error && insertedHold) { copied++;`  •  lib/documentLifecycle/split.ts:155-159 — "These are SECONDARY effects: the split itself (new docs + supersession) is already durable and correct above. A transient copy failure here is reported via honest counts rather than rolling back the whole split"  •  lib/revisions.ts:1423-1428 — `// Retiring a document is a canonical-state change too: same per-library publish` / `// authority + lock/hold guard …` / `const preState = await authorizePublish({ documentId: doc.id, libraryId, orgId, actorUserId, actorRole, … });` (the call split/merge omit)
```

> **Verifier correction.** Two scoping corrections, both of which shift where the risk actually lives. (a) Sub-defect (1) is CONTROLLER-ONLY: status→Superseded IS an advancing transition under 20260822:35-40, so for a non-controller the trigger reaches the hold test at :77-86 and aborts the split. Admins/DocCtrl short-circuit at :63-66 — and they could force past a hold via the sanctioned path anyway, so the incremental loss is the missing force flag/confirmation/override audit, not a new capability. (b) Sub-defect (3) is WORSE than stated: the "honest counts" mitigation is never surfaced. `grep -rn holdsCopied` over all .ts/.tsx returns only lib/documentLifecycle/{split,merge}.ts, and a second search for the callers shows components/documents/lifecycle/SplitWizard.tsx:114 and MergeWizard.tsx:123 both `await` the function and discard the result object entirely. A hold that fails to carry over to a new sheet is reported to nobody.

**Done when.**

- [ ] splitDocument and mergeDocuments run the same authorizePublish (lock + hold) gate as supersedeDocument before markSupersededAndLink, requiring an explicit controller force to proceed over a hold
- [ ] Hold carry-over happens before the source is superseded, and a failed carry-over rolls the operation back via the existing compensation register rather than reporting a smaller count
- [ ] copyActiveHoldsToDoc surfaces insert errors to the caller instead of `if (!error && insertedHold)`, and copyHolds:false is refused when the source has active holds

---

<a id="hld-3"></a>

## HLD-3 · The field-verification QR surfaces are hold-blind: /api/verify flashes green "CURRENT" and /api/verify-package flashes "all fresh" for a document under an active stop-work hold

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:34-39`, `app/api/verify/route.ts:89-108`, `app/verify/[docId]/page.tsx:65`, `app/verify/[docId]/page.tsx:99`, `app/api/verify-package/route.ts:47-74`, `lib/docPack.ts:100-105`, `lib/physicalBridge.ts:275-281`

**Mechanism.** `/api/verify` is the endpoint behind the QR stamped on every uncontrolled copy and every doc-pack sheet. Its verdict is computed from status and version identity alone: `const docRetired = d.status === "Superseded" || d.status === "Archived"; const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);` (route.ts:89-90). It selects `id, document_number, title, name, rev, status, current_version_id, superseded_at` (route.ts:36) and never touches `document_holds`. `/api/verify-package` does the same for a whole pack: `fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null)` and `allFresh: sheets.length > 0 && staleCount === 0` (route.ts:56-73), again with no hold query. The public pages render that verdict as an unqualified green: `result?.isCurrent ? "bg-emerald-600" : "bg-red-600"` and the word `"CURRENT"` (app/verify/[docId]/page.tsx:65,99). The only surface in the product that knows about holds is `/api/verify-hold`, and it is keyed on a HOLD uuid that exists only on a card someone chose to print (app/api/verify-hold/route.ts:21-31). Confirmed by two differently-shaped searches: a `grep -rn "document_holds"` over all .ts/.tsx (none of the three verify routes appear except verify-hold), and a per-file `grep -n "hold|Hold"` of app/api/verify/route.ts and app/api/verify-package/route.ts (zero hits).

**Failure scenario.** DocCtrl places a "Field Verification Needed" hold on P&ID PID-2201 Rev 4 after a walkdown finds the line routing does not match. Nobody prints a red hold card. A pipefitter holding a stamped print from last week scans the footer QR — the page turns emerald and says CURRENT, "this print matches the current revision." He welds to a drawing that document control has formally stopped work on. The same scan on the work-package cover sheet, printed under the words "SCAN BEFORE STARTING WORK" (lib/physicalBridge.ts:278), returns allFresh:true for a pack containing that sheet.

**Evidence.**

```
app/api/verify/route.ts:89-90 — `const docRetired = d.status === "Superseded" || d.status === "Archived";` / `const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  •  app/api/verify/route.ts:8-10 comment — "The response contains ONLY revision-status facts … Answers exactly one question: 'is the paper in my hand still current?'"  •  app/verify/[docId]/page.tsx:99 — `{result.notYetEffective ? "NOT YET IN EFFECT" : result.isCurrent ? "CURRENT" : "DO NOT USE"}`  •  app/api/verify-package/route.ts:73 — `allFresh: sheets.length > 0 && staleCount === 0,`
```

> **Verifier correction.** Downgraded CRITICAL→HIGH. The endpoint's documented contract (route.ts:8-12) is narrower than the finding implies — it answers "is the paper in my hand still the current revision?", and a hold does not change which revision is current, so the endpoint is not returning a wrong revision answer. The real defect is a product-level inconsistency: lib/holds.ts:249 broadcasts "Work from this document should stop until it's released" while the field QR on the same sheet says CURRENT in green. Severe, but it is a missing signal rather than a false revision verdict.

**Done when.**

- [ ] /api/verify queries document_holds for the doc and returns an `onHold` flag plus the hold reasons; the verdict page renders a distinct HOLD state (red, "DO NOT USE — WORK STOPPED") that outranks isCurrent
- [ ] /api/verify-package does the same per sheet and forces allFresh:false when any member document carries an active hold
- [ ] A test asserts that a document whose version matches current but which has an unreleased document_holds row returns a non-green verdict from both routes

---

<a id="hld-4"></a>

## HLD-4 · buildAndDownloadDocPack assembles held drawings into the field pack with no hold marking and reports "all current, all stamped"

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/docPack.ts:50-53`, `lib/docPack.ts:90-105`, `app/(protected)/assets/[tag]/page.tsx:129-142`, `app/(protected)/assets/[tag]/page.tsx:215`

**Mechanism.** The pack builder selects only `id, org_id, document_number, title, name, rev, library_id, current_version_id, checked_out_by, checked_out_by_name, checkout_note` (docPack.ts:51-52) and never reads document_holds. It knows how to warn on a soft signal — a foreign CHECKOUT produces `" ACTIVE CHANGE IN PROGRESS: checked out by …"` appended to the footer (docPack.ts:92-94) — but the hard signal, a hold, produces nothing: no footer text, no skip, no entry in `skipped`. The calling screen makes this stark: the equipment page renders a per-document hold badge, `{(holdsByDoc.get(d.id) ?? 0) > 0 && <span …>hold</span>}` (assets/[tag]/page.tsx:215), directly beside a "Doc Pack" button whose success message reads `Pack ready — ${result.included} drawing${…}, all current, all stamped.` (assets/[tag]/page.tsx:140). The app has the hold state loaded in local component state at the moment it builds the pack and does not pass it in.

**Failure scenario.** A planner opens /assets/E-204, sees one of the six drawings badged "hold", clicks Doc Pack anyway (or does not notice the badge among six rows), and gets a single merged PDF whose banner says "Pack ready — 6 drawings, all current, all stamped." Each page's footer says "verify current revision before use" and carries a QR that (per the previous finding) answers CURRENT. The held drawing goes to the field inside a document that asserts it is current.

**Evidence.**

```
lib/docPack.ts:92-94 — `const holderWarning = d.checked_out_by && (` `  \` ACTIVE CHANGE IN PROGRESS: checked out by ${(d.checked_out_by_name as string) || "another user"} at time of issue.\`` `);`  •  lib/docPack.ts:99-102 — `footerNotice: \`${label} Rev ${(d.rev as string) ?? "?"} at time of issue — verify current revision before use.\` + (holderWarning || ""),`  •  app/(protected)/assets/[tag]/page.tsx:140 — `? \`Pack ready — ${result.included} drawing${result.included === 1 ? "" : "s"}, all current, all stamped.\``
```

> **Verifier correction.** Minor: the same defect applies to the second caller, app/(protected)/packages/page.tsx:159-169 (work-package pack), which the finding does not name.

**Done when.**

- [ ] buildAndDownloadDocPack loads active holds for the requested documentIds and either skips held documents with reason "on hold" or stamps an unmissable HOLD banner on every page of a held sheet
- [ ] The "all current, all stamped" success copy is suppressed whenever any packed document carried a hold
- [ ] The assets page passes its already-loaded holdsByDoc map into the pack call rather than re-deriving nothing

---

<a id="hld-5"></a>

## HLD-5 · document_holds rows are wholly mutable by anyone holding holds.release, with no column restriction, no trigger and an audit trail written only by the client — a hold can be released, re-dated, re-attributed or un-released leaving no record

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260901_db_hard_enforcement.sql:96-102`, `supabase/migrations/20260612_phase5_holds.sql:35-38`, `supabase/migrations/20260901_db_hard_enforcement.sql:103-105`, `lib/holds.ts:173-218`, `lib/audit.ts:129-150`

**Mechanism.** The UPDATE policy gates the *capability* and nothing else: `CREATE POLICY document_holds_update ON document_holds FOR UPDATE USING (org_capability_allows(org_id, 'holds.release', auth.uid())) WITH CHECK (org_capability_allows(org_id, 'holds.release', auth.uid()));` (20260901:98-102). Its own comment concedes the assumption — "the capability gates every update (the row has no other mutable purpose)" — but nothing restricts which columns move. A raw PostgREST PATCH may set `released_at`, `released_by`, `released_by_name`, `released_reason`, `reason`, `notes`, `opened_by`, `opened_by_name` or `opened_at` to anything, or set `released_at` back to NULL to resurrect a hold. There is no trigger on the table at all (`grep -rn "TRIGGER" supabase/migrations/*.sql supabase/schema.sql | grep -i hold` returns only the two legal-hold DELETE triggers on documents/document_versions; a second search, `grep -rn "document_holds" supabase/migrations/*.sql`, shows only CREATE TABLE, indexes and policies). The migration states the design explicitly: "Audit row is written by the application (lib/holds.ts) using the existing audit_logs flow, not by a trigger" (20260612:35-38). So a release performed outside `releaseHold()` produces no HOLD_RELEASED audit row and no notification, and the document immediately publishes clean. Delete is controller-only (20260901:103-105) — but a controller deleting the row removes the hold from the timeline entirely (see the timeline finding). Note the `holds.release` default of `["*"]` itself is already reported in audit-reports/drafting-flow/11-document-handoff.md:69 and 90-gap-register.md:71,270; this finding is about the unconstrained column surface and the client-only audit on top of that default.

**Failure scenario.** A drafter blocked by a controller's hold opens devtools, copies the session bearer token, and issues `PATCH /rest/v1/document_holds?id=eq.<uuid>` with `{"released_at":"<now>","released_by_name":"Document Control"}`. RLS allows it (holds.release defaults to "*"). No HOLD_RELEASED row is written, no bell fires, and the document's timeline — which prefers the hold row over the audit rows — renders a tidy "Hold released — Client Review (3d)" attributed to Document Control. The next rev-up passes both the app guard and the DB trigger. The PSM record shows a hold that Document Control released.

**Evidence.**

```
supabase/migrations/20260901_db_hard_enforcement.sql:96-102 — `-- Releasing = the UPDATE that sets released_at; the capability gates every` / `-- update (the row has no other mutable purpose).` / `CREATE POLICY document_holds_update ON document_holds FOR UPDATE USING (org_capability_allows(org_id, 'holds.release', auth.uid())) WITH CHECK (org_capability_allows(org_id, 'holds.release', auth.uid()));`  •  supabase/migrations/20260612_phase5_holds.sql:35-38 — "Audit row is written by the application (lib/holds.ts) … not by a trigger. That keeps the audit actor accurate (we know who pressed the button) instead of fabricating it from session_user."
```

**Done when.**

- [ ] A BEFORE UPDATE trigger on document_holds rejects any change to opened_by / opened_by_name / opened_at / reason / org_id / document_id, refuses released_at → NULL, and forces released_by = auth.uid() and released_at = now()
- [ ] The same trigger (or an AFTER trigger) writes the HOLD_RELEASED audit_logs row server-side so the trail cannot be skipped by writing outside lib/holds.ts
- [ ] A test performs a direct PostgREST release and asserts both that it is refused for the forged columns and that an audit row exists for the legitimate one

---

<a id="hld-6"></a>

## HLD-6 · placeLegalHold, releaseLegalHold and disposeDocument never inspect the write result — they log the retention event, fire the notification and report a success count derived from the input id list

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/retention.ts:120-131`, `lib/retention.ts:134-144`, `lib/retention.ts:151-158`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:17-33`

**Mechanism.** All three follow the established supabase-js shape the earlier audits flagged: the client resolves with `{ error }` rather than throwing, and the result is discarded. `placeLegalHold` does `for (let i = 0; i < ids.length; i += 50) { await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50)); }` then unconditionally `await logEvent(... action: "hold_placed" ...)`, `await notifyHold(... "legal_hold_placed" ...)` and `return ids.length;` (retention.ts:124-130). `releaseLegalHold` is identical (retention.ts:137-143). `disposeDocument` does `await supabase.from("documents").update({ disposition_state: "disposed", disposed_at: nowIso, status: "Archived", updated_at: nowIso }).eq("id", input.documentId);` and then `return { ok: true };` (retention.ts:156-158). The consequence is asymmetric and severe for placeLegalHold specifically, because the whole point of the 20260826 migration is that `enforce_legal_hold_delete_guard()` refuses a DELETE only when `OLD.legal_hold` is true — if the UPDATE silently failed, the flag is still false and the guard will not fire, while the app, the retention event log and everyone who got the notification believe the record is frozen for litigation.

**Failure scenario.** Counsel asks for a litigation hold across a folder of 380 incident drawings. A transient PostgREST error, an RLS denial on a subset, or a schema-cache miss makes every UPDATE fail. `placeLegalHold` returns 380, the UI reports "380 documents placed on legal hold," a `hold_placed` retention event is written, and everyone is notified. `legal_hold` is still false on all 380 rows. Six weeks later a controller runs a routine cleanup; the BEFORE DELETE trigger passes because legal_hold is false, and the evidentiary records are destroyed — with a retention log that says they were under hold at the time.

**Evidence.**

```
lib/retention.ts:124-130 — `const ids = await scopeDocumentIds(input.scope, input.id);` / `for (let i = 0; i < ids.length; i += 50) { await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50)); }` / `await logEvent(input.orgId, { … action: "hold_placed" … });` / `await notifyHold(input.orgId, ids, "legal_hold_placed", …);` / `return ids.length;`  •  supabase/migrations/20260826_legal_hold_delete_guard.sql:20-24 — `IF OLD.legal_hold THEN RAISE EXCEPTION 'This record is under a legal hold and cannot be deleted. Release the hold first.' USING ERRCODE = 'check_violation'; END IF;`  •  supabase/migrations/20260826_legal_hold_delete_guard.sql:6-9 — "spoliation prevention is exactly the invariant that must not depend on the client behaving."
```

> **Verifier correction.** Nit: the returned count comes from scopeDocumentIds' own SELECT, not literally "the input id list" — the substance (it is derived from a read, never from the write) is unchanged.

**Done when.**

- [ ] Each batched update destructures `{ error, count }` with `{ count: "exact" }`, aborts on error, and returns the count the database actually reports
- [ ] logEvent and notifyHold run only after a verified write, and a partial batch failure surfaces to the caller rather than being rounded up to ids.length
- [ ] disposeDocument returns { ok:false } when its update errors or matches zero rows

---

<a id="hld-7"></a>

## HLD-7 · /api/verify-hold publicly returns the hold's free-text `reason` — contradicting the route's own stated contract — and reports the document's live revision, because a hold is not bound to the revision it stopped

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-hold/route.ts:48-61`, `app/api/verify-hold/route.ts:37-46`, `components/documents/HoldStrip.tsx:191-206`, `supabase/migrations/20260612_phase5_holds.sql:44-58`, `lib/physicalBridge.ts:152-155`

**Mechanism.** The route's comment states the contract it believes it is honouring: "Minimal facts only … This endpoint is unauthenticated; a photographed hold card must not disclose staff names or free-text operator notes ('waiting on legal re: incident …') to whoever scans it. Status, category, dates, and the doc label suffice" (route.ts:48-52). It then returns `reason` (route.ts:55). `reason` is not a category: the schema has "NO check constraint" by design (20260612:29-33), and HoldStrip's "Other…" control accepts an arbitrary string — `<input value={otherDraft} onChange={…} placeholder="Custom hold reason" …>` feeding `onOpen(otherDraft)` (HoldStrip.tsx:191-206). The exact class of string the comment names is the class the endpoint publishes. Separately, `document_holds` has no version column (20260612:44-58), so the route resolves the label and rev from the document row live — `.select("document_number, title, name, rev")` (route.ts:39) — and returns `docRev` as whatever the document reads *now*. The printed card, meanwhile, freezes the rev at print time (physicalBridge.ts:152-155). Nothing records which revision the hold was placed against.

**Failure scenario.** Document control opens a hold with the free-text reason "Hold per legal — Aug 12 release incident, do not distribute." A red card is printed and hung on the compressor. Anyone who photographs or scans that QR — a contractor, a visitor, a passer-by — gets that sentence back from an unauthenticated endpoint. Separately: the card was printed showing "P-2201 · Rev 3." A controller later force-publishes Rev 5 over the hold. The card still hangs, the QR still says HOLD ACTIVE, but now displays "Rev 5" — and no one can determine from the system which revision the stop-work was actually placed against. (The unauthenticated, org-unscoped nature of this route is already reported in audit-reports/intelligence/06-document-acl-leaks.md:240-252; that entry credits the route with withholding free text, which the `reason` field contradicts.)

**Evidence.**

```
app/api/verify-hold/route.ts:48-56 — `// Minimal facts only — same contract as /api/verify. This endpoint is` / `// unauthenticated; a photographed hold card must not disclose staff names` / `// or free-text operator notes ("waiting on legal re: incident …") to` / `// whoever scans it.` … `return NextResponse.json({ active: !h.released_at, reason: (h.reason as string) ?? null,`  •  components/documents/HoldStrip.tsx:193-201 — `<input value={otherDraft} … placeholder="Custom hold reason" …/>` … `onClick={() => otherDraft && onOpen(otherDraft)}`  •  supabase/migrations/20260612_phase5_holds.sql:29-33 — "reason is TEXT with NO check constraint … orgs can also enter free-form reasons via 'Other'."
```

> **Verifier correction.** The disclosure half is largely self-mitigating and should not drive the severity. The printed card the QR sits on already draws, in large type, `Reason: ${input.reason}` (physicalBridge.ts:156), the notes verbatim (:157-159) and `Placed by ${openedByName}` (:160-163). Anyone who can photograph the card can already read all of that, so returning `reason` over the wire discloses nothing new — and the route does correctly withhold `notes` and `opened_by_name` from the JSON. The substance that survives is the second half: nothing binds a hold to the revision it stopped, so a scanned card can show a rev that differs from the printed one with no indication which one was actually held.

**Done when.**

- [ ] The public payload returns the reason only when it is one of PREDEFINED_HOLD_REASONS, and otherwise a generic "On hold" category — matching the contract the comment already claims
- [ ] document_holds gains a version_id (or held_rev_label) captured at open time; the card and the verify page both show the revision the hold was placed against, alongside the current one when they differ
- [ ] The intelligence-audit entry at 06-document-acl-leaks.md:252 is corrected to note that `reason` is operator free text

---

<a id="hld-8"></a>

## HLD-8 · Hold open/release UI is gated by hardcoded facility role lists that ignore the org's capability policy and make per-person delegations unusable; the hold queue's row links also drop ?doc= and land on the library instead of the held document

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/InspectorPanel.tsx:132-133`, `components/documents/InspectorPanel.tsx:425`, `components/documents/InspectorPanel.tsx:864-871`, `app/(protected)/admin/holds/page.tsx:32`, `app/(protected)/admin/holds/page.tsx:42`, `app/(protected)/admin/holds/page.tsx:115`, `app/(protected)/admin/holds/page.tsx:181`, `lib/capabilityPolicy.ts:103-113`

**Mechanism.** Two hardcoded vocabularies decide who sees the hold controls, and neither consults `loadCapabilityPolicy`/`policyAllows`. The inspector uses `const canManageAssets = activeRole === 'Admin' || activeRole === 'Manager' || activeRole === 'Supervisor' || (activeRole?.includes('Engineer') ?? false) || activeRole === 'Drafter' || activeRole === 'DocCtrl';` (InspectorPanel.tsx:132-133) and passes `canEdit={canManageAssets || isOwner}` to HoldStrip (:425), gating the place-first-hold section the same way (:871). The queue page uses `const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]); const canRelease = !!activeRole && ADMIN_ROLES.has(activeRole);` (admin/holds:32,42). The consequence cuts both ways against the policy layer: an admin who *widens* holds.open to a role outside those lists gets no button, and — more damagingly — `UserGrant` per-person delegations ("Grants are ADDITIVE ONLY: they can extend a person's authority beyond their role", capabilityPolicy.ts:103-106) are entirely invisible to the hold UI, so delegating holds.release to a named person grants an authority they can never exercise through the product. Separately, the queue's document link is `href={\`/documents/${meta.libraryId}\`}` (admin/holds:181) with no `?doc=` — even though the page's own subtitle says "Click a row to open the document" (:115), the deep-link param is supported (app/(protected)/documents/[libraryId]/page.tsx:1285, `const docId = searchParams.get("doc");`) and lib/holds.ts:248 builds it correctly for the notification.

**Failure scenario.** An admin, following the guidance in the hold error message ("An Admin can change this under Admin → Permissions → Action permissions"), delegates holds.release to the turnaround coordinator for the duration of the outage. The coordinator logs in, opens the held drawing, and sees the hold strip in read-only mode with no Release button — on both the inspector and the hold queue. The delegation is real at the database and unusable in the app. Meanwhile a controller working the 40-row hold queue clicks a row to go fix the document and lands on a library listing with hundreds of drawings and no selection.

**Evidence.**

```
components/documents/InspectorPanel.tsx:132-133 — `const canManageAssets = activeRole === 'Admin' || activeRole === 'Manager' || activeRole === 'Supervisor' || (activeRole?.includes('Engineer') ?? false) || activeRole === 'Drafter' || activeRole === 'DocCtrl';`  •  app/(protected)/admin/holds/page.tsx:32 — `const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);`  •  app/(protected)/admin/holds/page.tsx:181 — `<Link href={\`/documents/${meta.libraryId}\`} …>`  •  lib/holds.ts:248 — `link: doc?.library_id ? \`/documents/${doc.library_id}?doc=${input.documentId}\` : "/admin/holds",`  •  components/documents/InspectorPanel.tsx:864-867 — "Every hold-authorized role (Manager/Supervisor/Engineer/Drafter/controllers/owner) must be able to stop work from a document — a safety control, not an admin convenience"
```

**Done when.**

- [ ] Both hold surfaces derive canOpen/canRelease from loadCapabilityPolicy + policyAllows (role tokens, additive roles[], and live per-person grants) instead of a literal role list
- [ ] The hold queue link becomes /documents/{libraryId}?doc={documentId}, matching the notification link
- [ ] A test asserts that a user holding only a UserGrant for holds.release sees the Release control

---

<a id="hld-9"></a>

## HLD-9 · Nothing ties document_holds.org_id to the held document's org, while SELECT keys on the hold's org and every enforcement path keys on document_id — producing a hold that blocks a document its own org cannot see

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260612_phase5_holds.sql:44-58`, `supabase/migrations/20260901_db_hard_enforcement.sql:89-95`, `supabase/migrations/20260822_review_completion_guard.sql:77-81`, `lib/holds.ts:271-280`, `lib/documentLifecycle/common.ts:353-356`

**Mechanism.** The table declares two independent FKs — `org_id UUID NOT NULL REFERENCES orgs(id)` and `document_id UUID NOT NULL REFERENCES documents(id)` (20260612:46-47) — with no composite constraint or trigger asserting they agree; two searches confirm no later migration adds one (`grep -rn "document_holds" supabase/migrations/*.sql` shows only indexes and policies after 20260612, and `grep -rn "TRIGGER" … | grep -i hold` finds none on the table). The RLS INSERT check is `org_capability_allows(org_id, 'holds.open', auth.uid())` (20260901:93-95) — it validates the *submitted* org_id against the submitter's membership, never against the document. But SELECT filters on `document_holds.org_id` (20260901:89-92) while the publish guard filters on document only: `SELECT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = NEW.id AND h.released_at IS NULL)` (20260822:77-81), as do `listActiveHoldsForDocument` (`.eq("document_id", documentId).is("released_at", null)`, holds.ts:274-276) and the impact/inspector counters. A hold row carrying the wrong org_id is therefore fully load-bearing for blocking and invisible to the blocked org. `copyActiveHoldsToDoc` already stamps the ACTOR's org rather than the document's — `org_id: actor.orgId` (common.ts:354) — so this is one cross-org lifecycle operation away from happening without malice.

**Failure scenario.** A hold row lands with an org_id that does not match its document (a cross-org actor context in a lifecycle copy, a restore/import that remaps org ids, or a member of org A inserting against a document UUID from org B). Org B's inspector shows "No active holds," /admin/holds shows nothing, and every rev-up, revert and supersede on that drawing fails with "Document has an active hold; release the hold before publishing a new revision" — an error naming a hold nobody in the org can find, list or release. Only a controller forcing, or service-role SQL, gets past it.

**Evidence.**

```
supabase/migrations/20260612_phase5_holds.sql:46-47 — `org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,` / `document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,`  •  supabase/migrations/20260901_db_hard_enforcement.sql:93-95 — `CREATE POLICY document_holds_insert ON document_holds FOR INSERT WITH CHECK ( org_capability_allows(org_id, 'holds.open', auth.uid()) );`  •  supabase/migrations/20260822_review_completion_guard.sql:77-81 — `SELECT EXISTS ( SELECT 1 FROM document_holds h WHERE h.document_id = NEW.id AND h.released_at IS NULL ) INTO v_has_hold;`  •  lib/documentLifecycle/common.ts:353-356 — `.insert({ org_id: actor.orgId, document_id: targetDocId, …`
```

> **Verifier correction.** Verification corrected CONFIRMED→SUSPECTED. No code path in the repo actually produces a mismatched row. copyActiveHoldsToDoc's targetDocId is always a document created moments earlier in actor.orgId (split.ts:99-127 / common.ts createNewDocWithFirstVersion), and openHold's orgId comes from the UI's activeOrgId for a document already listed under that org. The mechanism (nothing enforces agreement) is confirmed; the consequence — an invisible-but-blocking hold — is not reachable from any path readable in this repo, so it is a latent constraint gap, not an observed defect.

**Done when.**

- [ ] A CHECK-equivalent trigger (or a composite FK to documents(id, org_id)) rejects any document_holds row whose org_id differs from the referenced document's org_id
- [ ] The INSERT policy derives org_id from the document rather than trusting the submitted value
- [ ] listActiveHoldsForDocument and the DB guard agree on scoping, or a backfill query is run to find existing mismatched rows

---

<a id="hld-10"></a>

## HLD-10 · Releasing a stop-work hold requires no reason, and the person who placed it is never told it was lifted — the release broadcast is fire-and-forget, swallows its own failure, and hardcodes ["Admin","DocCtrl"]

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/holds.ts:186`, `lib/holds.ts:208-215`, `lib/holds.ts:223-255`, `lib/holds.ts:252`, `components/documents/HoldStrip.tsx:320`, `app/(protected)/admin/holds/page.tsx:204`, `supabase/migrations/20260612_phase5_holds.sql:57`

**Mechanism.** `released_reason` is nullable in the schema (20260612:57), optional in the API (`releasedReason?: string`), and coerced away by `input.releasedReason?.trim() || null` (holds.ts:186). Both UI surfaces label the field `placeholder="Resolution (optional)"` (HoldStrip.tsx:320, admin/holds:204) and neither disables the Release button when it is empty — contrast the deliberate asymmetry elsewhere in the codebase, where `revertToVersion` refuses without one (`if (!reason.trim()) throw new Error("Revert reason is required")`, revisions.ts) and the RPC refuses a branch publish without one. Separately, the release broadcast is `void notifyHoldChange({…})` (holds.ts:208) whose body is wrapped in `try { … } catch { /* best-effort */ }` (holds.ts:231-254), so a failed stop-work-lifted announcement is invisible to the releaser and to the caller. Its audience is `audience: { followers: true, roles: ["Admin", "DocCtrl"] }` (holds.ts:252) — hardcoded facility vocabulary, and notably it does not include the hold's opener: the dispatch layer supports an `involved` list (lib/notify/dispatch.ts:69) that holds.ts never uses, so the person who stopped work only hears about the release if they happen to follow the document or hold a controller role.

**Failure scenario.** An Engineer places "Awaiting Engineering" on an isometric because a support location is wrong. A drafter releases it with the resolution box left blank (the button is enabled), publishes Rev 5, and moves on. The audit row records HOLD_RELEASED with `releasedReason: null`; the timeline reads "Hold released — Awaiting Engineering (2d)" with no explanation. The Engineer who placed the hold is not on the notification list and is not a follower, so the first they know is when Rev 5 appears in a transmittal. During an incident review, the record cannot answer why the stop-work was lifted.

**Evidence.**

```
lib/holds.ts:186 — `released_reason: input.releasedReason?.trim() || null,`  •  components/documents/HoldStrip.tsx:320 — `placeholder="Resolution (optional)"`  •  lib/holds.ts:252 — `audience: { followers: true, roles: ["Admin", "DocCtrl"] },`  •  lib/holds.ts:220-222 — `/** A hold is a stop-work signal — the people working the document must hear it, not discover it.`
```

**Done when.**

- [ ] releaseHold rejects an empty releasedReason (mirroring revertToVersion), and both UIs disable Release until one is typed
- [ ] notifyHoldChange adds the hold's opened_by to `audience.involved` so the person who stopped work is always told it resumed
- [ ] The ["Admin","DocCtrl"] audience is read from the org's role model / capability policy rather than a literal array, and a failed emit is at least logged rather than silently swallowed

---

<a id="hld-11"></a>

## HLD-11 · The document timeline discards the HOLD_OPENED / HOLD_RELEASED audit rows in favour of the mutable document_holds rows, so deleting or editing a hold row erases the hold from the document's visible history

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/timeline.ts:346-357`, `lib/timeline.ts:464-470`, `lib/timeline.ts:124-169`, `supabase/migrations/20260901_db_hard_enforcement.sql:103-105`

**Mechanism.** Both timeline builders filter the immutable audit rows out and render the mutable table instead: `.filter((r) => r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED")` (timeline.ts:351 and again at 467), with the stated reason "the hold rows themselves carry richer detail (duration, reason)" (timeline.ts:346-349). `holdRowsToEvents` then synthesises the two events purely from the row's current column values (timeline.ts:131-166). Combined with the previous finding — the row is freely UPDATE-able by anyone with holds.release and DELETE-able by any controller (`CREATE POLICY document_holds_delete ON document_holds FOR DELETE USING (is_org_controller(org_id));`, 20260901:103-105) — the document's own history becomes derived from an editable record while the true audit rows sit in audit_logs and are deliberately suppressed. Deleting the hold row makes the timeline show that the hold never existed. This also means `released_reason` never appears in a timeline summary line (it is only in `details`, timeline.ts:161-164), so the resolution text a releaser typed is invisible in the feed.

**Failure scenario.** An incident review pulls the drawing's timeline to reconstruct why a superseded sheet reached the field. A controller had, weeks earlier, deleted the awkward "Field Verification Needed" hold row rather than releasing it. The timeline shows a clean rev-up with no hold ever placed. The HOLD_OPENED audit_logs row is still in the database, and the reviewer never sees it because the timeline filters that action out by name.

**Evidence.**

```
lib/timeline.ts:346-352 — `// Holds and the matching HOLD_OPENED / HOLD_RELEASED audit rows` / `// describe the same fact pair. To avoid double-rendering, drop the` / `// audit rows whose action is one of the hold-event kinds …` / `const auditEvents = ((auditResult.data as AuditRow[]) ?? []).filter((r) => r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED").map(auditRowToEvent);`  •  lib/timeline.ts:126-129 — "Audit events with action HOLD_OPENED/HOLD_RELEASED also exist (fired by lib/holds.ts), but those carry the actor metadata; the version emitted here carries the duration and reason fields denormalized for the renderer."
```

> **Verifier correction.** Downgraded HIGH→MEDIUM because a mitigation the finding misses: the suppressed audit rows are NOT invisible product-wide. app/(protected)/admin/audit/page.tsx:69-70 and app/(protected)/activity/page.tsx:51-52,196 both render HOLD_OPENED / HOLD_RELEASED audit_logs rows (the audit page even resolves the document label, :141-149, and exports to CSV, :229). So deleting a document_holds row erases the hold from the DOCUMENT timeline only; the immutable trail survives in two other org-level views.

**Done when.**

- [ ] The dedup keys on holdId (audit details.holdId ↔ document_holds.id) rather than on action name, so an audit row with no surviving hold row is still rendered
- [ ] A HOLD_OPENED audit row whose hold row is gone renders as an explicit "hold record removed" event
- [ ] released_reason is surfaced in the release event's summary line, not only in details

---

<a id="hld-12"></a>

## HLD-12 · The hold-enforcement and legal-hold-guard functions are SECURITY DEFINER with no SET search_path, and supabase/schema.sql creates document_holds with no RLS enabled and no policy

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260822_review_completion_guard.sql:21-22`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:17-18`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:37-38`, `supabase/migrations/20260828_integrity_hardening.sql:39-54`, `supabase/schema.sql:564-588`, `supabase/schema.sql:1011-1028`

**Mechanism.** Four functions on the hold-enforcement path declare SECURITY DEFINER without pinning the schema: `CREATE OR REPLACE FUNCTION enforce_document_publish_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$` (20260822:21-22 — the current definition, which is the one carrying the `document_holds … released_at IS NULL` check), `enforce_legal_hold_delete_guard()` (20260826:17-18), `enforce_legal_hold_version_delete_guard()` (20260826:37-38), and `publish_revision(...) LANGUAGE plpgsql SECURITY DEFINER` (20260828:53-54). The sibling functions written in the same period do pin it — `org_capability_allows(...) STABLE SECURITY DEFINER SET search_path = public` (20260901:29), `acl_index_denies(...) SET search_path = public` (20260901:128), `user_can_publish_on_library(...) SET search_path = public` (20260812:37) — so this is an inconsistency, not a house style. Separately, `supabase/schema.sql` — headed "Run this in the Supabase SQL editor to set up your database" — creates document_holds and its five indexes (schema.sql:564-588) but its ROW LEVEL SECURITY block (schema.sql:1011-1028) omits `ALTER TABLE document_holds ENABLE ROW LEVEL SECURITY` and defines no policy for it; RLS on the table exists only in 20260612 / CATCHUP / 20260901.

**Failure scenario.** search_path: an unpinned SECURITY DEFINER function resolves `document_holds`, `org_members` and `documents` against the caller's search_path. Any path that lets a role prepend a schema turns the hold check into a lookup against attacker-controlled objects, and the trigger that refuses to publish over a hold silently returns clean. RLS: an environment bootstrapped from schema.sql alone (a demo, a staging rebuild, a self-hosted install following the file's own instruction) has document_holds with RLS disabled — every hold in every org readable and writable by any authenticated user — until the 20260612/20260901 migrations are also applied. I cannot observe deployment order from the repo, hence SUSPECTED for the consequence; the omissions themselves are confirmed in the files.

**Evidence.**

```
supabase/migrations/20260822_review_completion_guard.sql:21-22 — `CREATE OR REPLACE FUNCTION enforce_document_publish_guard()` / `RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$` (compare 20260901:29 — `RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$`)  •  supabase/schema.sql:564 — `CREATE TABLE IF NOT EXISTS document_holds (` with no matching entry in the `ALTER TABLE … ENABLE ROW LEVEL SECURITY` block at schema.sql:1017-1028  •  supabase/schema.sql:2 — `-- Run this in the Supabase SQL editor to set up your database.`
```

> **Verifier correction.** SUSPECTED is the right label and should be kept for both halves. Exploiting an unpinned search_path requires an attacker able to set search_path for the session and create shadowing objects in a schema on that path — not demonstrable from the repo. The schema.sql omission is likewise conditional on someone bootstrapping from schema.sql alone; note also that schema.sql's RLS block covers only ~18 core tables and omits many later ones (milestones and others), so this is a general property of a partial bootstrap file rather than a document_holds-specific mistake.

**Done when.**

- [ ] enforce_document_publish_guard, enforce_legal_hold_delete_guard, enforce_legal_hold_version_delete_guard and publish_revision are re-created with SET search_path = public
- [ ] schema.sql enables RLS on document_holds and carries the capability-gated policies, or its header states unambiguously that the migrations are mandatory and schema.sql alone is not a complete install
- [ ] A check exists (script or test) that every SECURITY DEFINER function in supabase/ pins search_path

---

<a id="hld-13"></a>

## HLD-13 · The printed equipment QR label promises "SCAN: drawings · holds · report a problem" but targets the login-walled /assets/[tag] route — the one printed artifact that advertises hold visibility in the field is the one that cannot be scanned by field staff

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/physicalBridge.ts:84`, `lib/physicalBridge.ts:99`, `app/(protected)/assets/[tag]/page.tsx:1`, `app/(protected)/layout.tsx:27-45`, `lib/physicalBridge.ts:219-221`, `lib/physicalBridge.ts:272-275`

**Mechanism.** `printEquipmentLabels` builds the sticker's QR as `const url = \`${origin()}/assets/${encodeURIComponent(asset.tag)}\`;` (physicalBridge.ts:84) and prints the promise `page.drawText("SCAN: drawings · holds · report a problem", …)` (physicalBridge.ts:99). That route lives at `app/(protected)/assets/[tag]/page.tsx`, inside the `(protected)` group whose layout renders an "Authenticating…" gate and requires a resolved membership (app/(protected)/layout.tsx:27-45). There is no public /assets route — `find app -maxdepth 3 -type d -name assets` returns only `app/(protected)/assets` and `app/(protected)/admin/assets`. The file's own history shows the team already learned this lesson twice for the other artifacts: the traveler comment says "the person holding the folder in the field has no account; sending them to the protected app was a login wall" (physicalBridge.ts:219-221) and the package cover says "the old /packages target was a login wall under the words 'SCAN BEFORE STARTING WORK'" (physicalBridge.ts:272-275). The equipment label was never migrated, and it is the only artifact that names holds.

**Failure scenario.** Every pump and exchanger in the unit carries a sticker that says scanning it shows drawings and holds. An operator who notices something wrong scans the label on E-204, lands on a sign-in screen, has no account, and gives up. The hold badge that the /assets/[tag] page renders (line 215) — the one place in the product where a hold is visible next to an equipment tag — is unreachable by exactly the audience the sticker was printed for.

**Evidence.**

```
lib/physicalBridge.ts:84 — `const url = \`${origin()}/assets/${encodeURIComponent(asset.tag)}\`;`  •  lib/physicalBridge.ts:99 — `page.drawText("SCAN: drawings · holds · report a problem", { x: tx, y: y + pad + 2, size: 7, font: bold, color: MUTED });`  •  lib/physicalBridge.ts:272-275 — `// PUBLIC verify page — the crew member scanning in the field has no` / `// account; the old /packages target was a login wall under the words` / `// "SCAN BEFORE STARTING WORK".`
```

> **Verifier correction.** Downgraded HIGH→MEDIUM on consequence (a field scan hits a login wall — a dead-end, not a wrong document-control answer), and one claim is wrong: this is NOT "the only artifact that names holds". printHoldCard (physicalBridge.ts:141-166) is an entire artifact about a hold and correctly targets the PUBLIC `${origin()}/verify-hold/${holdId}` (:164). The accurate statement is that the equipment label is the only artifact promising hold visibility that was never migrated off the protected route.

**Done when.**

- [ ] The equipment label QR points at a public tag page (mirroring /verify, /verify-hold, /verify-package) that shows current revisions and any active holds for the tag's documents, or the label text stops promising hold visibility
- [ ] The public tag surface follows the same minimal-facts contract as the other verify routes
- [ ] A test asserts the printed QR target is not under the (protected) route group

---

<a id="hld-14"></a>

## HLD-14 · expected_release_at is never written by any caller, so the "+Nd late" stale-hold indicator can never fire — and no cron or escalation exists for a hold that has been open for months

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/HoldStrip.tsx:14-17`, `components/documents/HoldStrip.tsx:268-270`, `components/documents/HoldStrip.tsx:284`, `app/(protected)/admin/holds/page.tsx:173-174`, `app/(protected)/admin/holds/page.tsx:194`, `lib/holds.ts:75`, `lib/holds.ts:122`, `vercel.json:3-13`

**Mechanism.** `openHold` accepts `expectedReleaseAt?: string` and writes `expected_release_at: input.expectedReleaseAt ?? null` (holds.ts:75,122), but neither of the two callers passes it: `HoldStrip.onOpen` sends `{ orgId, documentId, reason, openedBy, openedByName, openedByEmail, openedByRole }` (HoldStrip.tsx:86-93) and `CheckInPanel` sends `{ orgId, documentId, reason: "Field Verification Needed", notes, openedBy, openedByName, openedByEmail, openedByRole }` (CheckInPanel.tsx:366-371). Two differently-shaped searches confirm: `grep -rn "expectedReleaseAt|expected_release_at"` over all .ts/.tsx shows every other hit belongs to checkout_sessions, not holds; and `grep -rn "openHold"` returns exactly those two call sites plus lib/holds.ts. The only other writer is `copyActiveHoldsToDoc`, which propagates whatever the source held — always null. Both consumers therefore evaluate dead branches: `const expectedMs = hold.expectedReleaseAt ? … : null; const isLate = expectedMs !== null && nowMs > expectedMs;` (HoldStrip.tsx:268-269) and the same at admin/holds:173-174. The HoldStrip header describes it as shipped behaviour: "Stale indicator: when an active hold has gone past its expected_release_at, the duration label switches to red … the directive's 'schedule variance visibility' in its lightest form" (HoldStrip.tsx:14-17). There is no compensating escalation: `grep -n "hold|Hold" app/api/cron/maintenance/route.ts` returns only two unrelated comment lines, and vercel.json declares only the data-export and maintenance crons.

**Failure scenario.** A "Missing Vendor Data" hold is opened in March. The vendor never responds. Nothing ever turns red, nothing renudges, no digest names it. The only signal is the /admin/holds "Longest open" KPI, which someone has to go look at. In September the drawing is still stopped and the only people who know are the ones who remember. Note also that adding a cron here is constrained — a third vercel.json entry fails deployment on this plan (app/api/cron/maintenance/route.ts:286-291) — so the aging sweep must ride inside the existing maintenance route.

**Evidence.**

```
components/documents/HoldStrip.tsx:14-17 — `//   - Stale indicator: when an active hold has gone past its` / `//     expected_release_at, the duration label switches to red and` / `//     prefixes with "+Nd late" — the directive's "schedule` / `//     variance visibility" in its lightest form.`  •  components/documents/HoldStrip.tsx:86-93 — the openHold call, with no expectedReleaseAt key  •  components/documents/HoldStrip.tsx:284 — `{isLate && <span className="ml-1 font-bold text-red-700">(+{lateDays}d late)</span>}`  •  lib/holds.ts:122 — `expected_release_at: input.expectedReleaseAt ?? null,`
```

**Done when.**

- [ ] The hold picker offers an expected-release date (optional but prompted for the four predefined reasons) and passes it through openHold
- [ ] An aging sweep inside the EXISTING /api/cron/maintenance route nudges the opener and the doc-control pool on holds past expected_release_at, and on holds older than a configured age when no date was set — no new vercel.json cron entry
- [ ] The HoldStrip header comment matches what actually ships

---
