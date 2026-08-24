> **CLAIMED** claude/report-audit-findings-a3i90l 2026-08-24T16:30:00Z

# 03 · The review gate & e-signatures

**13 findings** — 2 CRITICAL · 4 HIGH · 7 MEDIUM.

Required signers, invalidation on change, and whether the gate fails open.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The database completion guard is placed BEFORE the Admin/DocCtrl short-circuit, so it binds controllers too | `supabase/migrations/20260822_review_completion_guard.sql:43-58 (the review block) vs :60-66 (the role short-circuit)` | This ordering is deliberate and correct — the migration header calls it 'a data-integrity gate, not an authority one'. Any refactor that moves the completion check below the role check silently exempts every controller. The findings above are about what the guard COUNTS, not where it sits. |
| The compare-and-set on pending_version_id in both directions | `lib/reviewControl.ts:429-439 (finalize) and lib/revisions.ts:906-918 (submit)` | Two concurrent 'last' signers, and two concurrent submissions, are both resolved by matching on the pointer value read earlier — the loser matches zero rows and returns without re-running the supersede/notify pipeline. This is the correct pattern and the reason auto-finalize is safe to run from every signer's browser. |
| e_signatures is genuinely append-only at the database | `supabase/migrations/20260720_e_signatures.sql:45-61` | Only SELECT and INSERT policies exist; no UPDATE or DELETE policy is ever granted, and no later migration adds one. A signature, once written, cannot be altered or removed by any authenticated role. Preserve this when adding the server-side re-auth fields finding 10 asks for. |
| invalidateDraftSignoffs voids prior approvals on resubmit AND tells the earlier signers why | `lib/reviewControl.ts:261-280` | A new draft (2A→2B) invalidates every prior pending/signed row and sends a review_invalidated notification to each person who had already signed, so a stale approval cannot ride onto changed content and the signer learns their signature was voided. This is the correct behaviour for a content-bound signature and must survive any roster rework. |
| scanReviews is already wired into the existing daily maintenance cron under the service role | `app/api/cron/maintenance/route.ts:162 and :150-186, vercel.json` | Timeout-driven alternate activation and reviewer nudges run on a real clock, with the shared client swapped to service role for full visibility and reset in a finally block. No new vercel.json cron entry is needed or permitted — fixes to the scan belong inside this handler. |
| The zero-primary escalation path | `lib/reviewControl.ts:240-256` | When no primary reviewer resolves, or the roster has gaps, the effective owner and the org controllers are notified with a message naming the revision — the system escalates rather than silently blocking. Finding 12 is about the case where the roster WRITE failed; this escalation is the right response to the case where the policy simply resolved to nobody, and should be reused. |
| The escape-hatch warning banner in the rev-up form | `components/documents/RevUpModal.tsx:643-649` | When a gated library is being bypassed by the Minor/Correction change type, the form says so in plain language rather than silently taking the direct path. The defect in finding 11 is the default selection and the localStorage memory, not the disclosure. |


---


<a id="rg-1"></a>

## RG-1 · Any active org member can forge review completion with a single INSERT of a pre-signed sign-off row

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260828_integrity_hardening.sql:223-226`, `supabase/migrations/20260822_review_completion_guard.sql:46-57`, `lib/reviewControl.ts:363-369`, `lib/reviewControl.ts:661-665`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified — I looked for a later policy, a CHECK, or a trigger that would block it: the only files touching document_review_signoffs are 20260812/20260818/20260819/20260822/20260825/20260828/20260829/20260830, and none adds a status/self-row constraint on INSERT (20260830 rewrites only the UPDATE policy). A row with slot='alternate', status='signed' raises v_signed without raising v_primary_reqs, defeating both gates. The attacker cannot promote the version themselves (the publish guard's authority branch still applies to them), but they can make the gate report complete, and recordReviewSignoff's auto-finalize (reviewControl.ts:322-330) will then publish on the next genuine signature. CRITICAL is right.

**Mechanism.** The INSERT policy on document_review_signoffs is membership-only: `CREATE POLICY doc_review_signoff_insert ON document_review_signoffs FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id AND uid = auth.uid() AND status = 'active'))`. It constrains no other column — not slot, not status, not signature_id, not reviewer_user_id, not document_version_id. Both completion checks count raw rows and nothing else. The DB guard: `SELECT count(*) FILTER (WHERE slot = 'primary'), count(*) FILTER (WHERE status = 'signed') INTO v_primary_reqs, v_signed FROM document_review_signoffs WHERE document_version_id = NEW.current_version_id`. The app: `const signed = roster.filter((r) => r.status === "signed").length; const complete = requiredPrimaries > 0 && signed >= requiredPrimaries` (lib/reviewControl.ts:365-367). Neither joins e_signatures, neither checks signature_id IS NOT NULL, neither checks `activated`, and neither checks that the signer is the row's reviewer. So a row that was born signed is indistinguishable from a signed one.

**Failure scenario.** A Viewer-role contractor with an active membership POSTs one row to /rest/v1/document_review_signoffs: {org_id: <their org>, document_id: <the P&ID>, document_version_id: <the in-review draft 2A>, reviewer_user_id: <their own uid>, slot: 'alternate', status: 'signed', signed_at: now}. RLS accepts it — they are an active member. reviewCompletionForDraft now returns signed >= requiredPrimaries, so `complete` flips true; recordReviewSignoff's auto-finalize path, the ReviewGateSection publish button, and the DB publish guard all agree the review is done. The named Piping Lead never opened the draft. Rev 2 becomes the controlled copy carrying zero e_signatures rows, and because gatherEvidence never reads e_signatures or document_review_signoffs (see audit-reports/drafting-flow/10-audit-evidence.md), the evidence pack shows a normally-published revision.

**Evidence.**

```
20260828_integrity_hardening.sql:223-226 grants INSERT on membership alone; 20260822_review_completion_guard.sql:48-52 counts `status = 'signed'` with no signature_id predicate; lib/reviewControl.ts:365-367 does the same in the app. Two search shapes (grep 'document_review_signoffs' across supabase/*.sql, and grep 'ON document_review_signoffs') found exactly four policy definitions — select/insert/update/delete in 20260828, with only the UPDATE one re-issued by 20260830. No later migration narrows INSERT.
```

**Chain reaction.** This is the same shape the five prior audits recorded (a write policy that carries authority but checks only membership), except here the writable row IS the approval record. It also nullifies finding 2's mitigation and any future 'only the reviewer may sign their own row' fix that lives in UPDATE only — the forged row never needs an UPDATE.

**Done when.**

- [ ] doc_review_signoff_insert WITH CHECK constrains the inserted row to status='pending', activated per slot, and signature_id IS NULL — roster creation may not create approval
- [ ] Both completion counts require signature_id IS NOT NULL and join e_signatures on (signature_id, document_version_id) with signer_user_id = reviewer_user_id
- [ ] A reconciliation query proves every document_review_signoffs row with status='signed' has a matching e_signatures row signed by that same reviewer

---

<a id="rg-2"></a>

## RG-2 · The publisher the gate exists to constrain can mark another reviewer's row signed, and the roster renders it as that reviewer's approval

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260830_publisher_row_management.sql:34-50`, `lib/reviewControl.ts:287-303`, `components/documents/ReviewGateSection.tsx:131-135`, `components/documents/ReviewGateSection.tsx:191-203`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the migration's own header (:26-27, 'Signing someone else's row is still impossible for everyone without that authority') concedes the point for those who have it. One refinement that strengthens rather than weakens the claim: e_signatures is genuinely self-insert only (20260720_e_signatures.sql:56-61 `WITH CHECK (signer_user_id = auth.uid() ...)`), so the publisher cannot mint a signature in the Piping Lead's name — but calling recordReviewSignoff (reviewControl.ts:287-303) with their OWN signerUserId and the Piping Lead's signoffId attaches the publisher's e-signature to the Lead's roster row, and the roster still renders it under the Lead's name. A bare PATCH with signature_id left NULL renders identically.

**Mechanism.** 20260830's UPDATE policy grants the document's effective owner and anyone with per-library publish authority (plus Admin/DocCtrl) UPDATE on EVERY row of the document's roster — `OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_review_signoffs.document_id AND (user_is_effective_owner(...) OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)))`. Its WITH CHECK re-asserts only membership: `WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = ... AND uid = auth.uid() AND status = 'active'))`. USING gates which rows you may touch; WITH CHECK gates what the row becomes — so the resulting row's reviewer_user_id, reviewer_name, slot, status, signature_id and signed_at are all unconstrained. recordReviewSignoff does nothing to narrow it: `await supabase.from("document_review_signoffs").update({ status: "signed", signature_id: sig.id, signed_at: nowIso, updated_at: nowIso }).eq("id", input.signoffId)` — filtered by row id only, with no `reviewer_user_id = signerUserId` predicate (contrast lib/acknowledgments.ts:444, which does filter `.eq("assignee_user_id", input.signerUserId)`). The roster UI then renders `{r.reviewerName}` next to a green check and `r.signedAt?.slice(0,10)` (ReviewGateSection.tsx:132, :194) and never reads the signature back.

**Failure scenario.** The publisher of a B31.3 line-list revision is also the document's effective owner. Two primaries are outstanding and the turnaround is tomorrow. They call recordReviewSignoff (or issue the PATCH directly) with the Piping Lead's signoffId. RLS permits it — they are the effective owner. An e_signatures row is written with signer_user_id = the publisher (RLS forces that), intent 'Reviewed'. The roster row for the Piping Lead flips to status='signed' with signature_id pointing at the publisher's signature. The panel now shows 'Piping Lead — signed 2026-08-22'. reviewCompletionForDraft returns complete, the auto-finalize in recordReviewSignoff promotes the draft, and the DB guard passes. The Piping Lead's name is on an approval they never gave.

**Evidence.**

```
20260830_publisher_row_management.sql:47-50 is the whole WITH CHECK — it does not repeat the USING branch; lib/reviewControl.ts:301-303 shows the id-only filter. The migration's own header (lines 3-27) explains it deliberately widened UPDATE for publishers to do bulk void/invalidate work, and asserts 'Signing someone else's row is still impossible for everyone without that authority' — the carve-out it opened is exactly the authority the gate is meant to check.
```

**Chain reaction.** The same UPDATE also silently fails to check its own result: reviewControl.ts:301-303 discards {error}, so when RLS DOES deny (a plain reviewer whose row was concurrently voided), the e_signature is written, the roster stays 'pending', and the reviewer is nagged forever for a draft they signed. That half was recorded in audit-reports/drafting-flow/10-audit-evidence.md; the forging direction is not.

**Done when.**

- [ ] The UPDATE policy's WITH CHECK repeats the USING predicate, and additionally pins reviewer_user_id, slot and document_version_id to their OLD values
- [ ] status='signed' is settable only when reviewer_user_id = auth.uid(); the publisher's legitimate bulk work (void/invalidate) is a separate narrow policy or a SECURITY DEFINER RPC restricted to those two transitions
- [ ] recordReviewSignoff filters `.eq("reviewer_user_id", input.signerUserId)` and checks the returned row count, surfacing a zero-row update as an error

---

<a id="rg-3"></a>

## RG-3 · A review policy set on an intermediate folder is silently ignored — only the document's immediate parent folder is consulted

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:40-50`, `lib/reviewControl.ts:545-549`, `components/documents/ReviewGateSection.tsx:49-55`, `components/documents/ReviewControlModal.tsx:3-6`, `supabase/schema.sql:94`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified as an absence: I grepped every review_control read site in lib/, app/ and components/ — all four (reviewControl.ts:40-50, reviewControl.ts:545-549, ReviewGateSection.tsx:49-55, and page.tsx's row mapper) consult only doc.collectionId, and path_ids is never used for policy resolution anywhere. ReviewControlModal.tsx:3-4 advertises configuring the policy on 'a LIBRARY or FOLDER' with no hint that only the leaf folder counts, so a policy set on 'Piping / P&IDs' silently governs nothing under 'Piping / P&IDs / Unit 12'. HIGH stands.

**Mechanism.** Collections nest — `parent_id UUID REFERENCES collections(id) ON DELETE CASCADE` (schema.sql:94), with parentId/pathIds surfaced throughout lib/libraryCollections.ts (:25, :101, :161-164). ReviewControlModal is explicitly 'configure the pre-publish review policy on a LIBRARY or FOLDER'. But every resolution site reads exactly one folder — the document's own collection_id — and then jumps to the library: `if (doc.collectionId) { const { data } = await supabase.from("collections").select("review_control").eq("id", doc.collectionId).maybeSingle(); folder = ...}` then `const { data: lib } = await supabase.from("libraries")...`. scanReviews does the same with a flat colMap keyed by doc.collection_id (:546-548), and ReviewGateSection repeats it inline (:49-55). No ancestor walk exists anywhere for review_control — and the codebase already has the primitive: lib/pageHeader.ts:28-45 builds 'current node → ancestors (nearest first) → library' from pathIds for cover images.

**Failure scenario.** A controller sets mode 'require' with the Piping Lead as primary reviewer on the folder 'Piping / P&IDs', intending it to cover the whole discipline. Drawings actually live in 'Piping / P&IDs / Unit 12'. For every one of them doc.collectionId is the Unit 12 subfolder, whose review_control is null, so resolution falls straight through to the library — which is mode 'none'. effectiveModeForRevUp returns 'none', RevUpModal's willReview is false, and revUpDocument publishes immediately. The Inspector's ReviewGateSection returns null (:138-139), so the panel that would have shown 'Revisions in this library require reviewer sign-off' is not even rendered. Nobody sees that the policy is inert; the controller believes the discipline is gated.

**Evidence.**

```
lib/reviewControl.ts:44-49 is the entire container chain. Two search shapes confirm no ancestor walk for policy: grep for 'ancestor|walkUp|parentChain|collectionChain' across lib/ returns only scheduling/header/filter code, and grep for 'parent_id' in the collection libs returns only libraryCollections.ts create/list. audit-reports/drafting-flow/03-doc-control-wiring.md:299-303 lists this exact chain under 'Verified sound — do not break', citing lib/reviewControl.ts:527 — the prior audit read the three-level resolve function and did not check that folders nest.
```

**Chain reaction.** lib/docClass.ts:48-58 has the identical two-hop shape ('Most specific DEFINED level wins — identical to resolveEffectiveReviewControl'), so the PSM/MOC gate driven by document class inherits the same blind spot; retention (RetentionPolicy in types/schema.ts) and the ack policy are documented as using the same pattern. A fix belongs in one shared ancestor-chain resolver, not three copies.

**Done when.**

- [ ] A shared resolver walks collection.pathIds from nearest ancestor to the library and returns the first DEFINED review_control
- [ ] scanReviews, effectiveReviewControlForDocument and ReviewGateSection all call it instead of hand-rolling the two-hop lookup
- [ ] A test fixture with library=none / mid-folder=require / leaf-folder=undefined resolves to require

---

<a id="rg-4"></a>

## RG-4 · Completion is a bare signature count, so one alternate's signature can substitute for a different discipline's required primary

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:361-369`, `lib/reviewControl.ts:126-132`, `lib/reviewControl.ts:204-217`, `supabase/migrations/20260822_review_completion_guard.sql:48-57`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the auto-activation premise: reviewControl.ts:555-561 `if (r.slot === "alternate" && r.activated === false && ageDays >= timeoutDays) { ... activateAlternate(...) }`. With two primaries (Piping + I&E) and one alternate, Piping + the alternate gives signed=2 >= requiredPrimaries=2, and neither the app gate (:367) nor the trigger (:53) notices that a required discipline never signed. Completion is per-count, never per-reviewer, so there is no place the identity of the missing primary is checked.

**Mechanism.** The roster stores slot ('primary' | 'alternate') but no pairing between an alternate and the primary they back — openReviewRoster flattens both sets into rows (`...primaries.map((r) => ({ r, slot: "primary" as const, activated: true })), ...alternates.map((r) => ({ r, slot: "alternate" as const, activated: false }))`) and expandReviewers returns two undifferentiated arrays. Completion is then arithmetic: `const requiredPrimaries = roster.filter((r) => r.slot === "primary").length; const signed = roster.filter((r) => r.status === "signed").length; const complete = requiredPrimaries > 0 && signed >= requiredPrimaries`. The DB guard mirrors it exactly. Nothing requires that each primary either signs or is covered by an activated alternate; N signatures from any N roster members satisfy a roster of N primaries.

**Failure scenario.** A library gates a code-governed revision on two primaries — the Piping Lead (B31.3 stress) and the I&E Lead (loop integrity) — plus one alternate, a second piping engineer. The Piping Lead signs. The alternate is auto-activated at timeout (scanReviews:556) and signs too. signed = 2 >= requiredPrimaries = 2, so the review is complete and the last signature auto-finalizes the promote. The I&E Lead is never asked again and the revision publishes with two piping signatures and zero instrumentation review. In the roster panel this reads as '2/2 signed'.

**Evidence.**

```
lib/reviewControl.ts:365-367 quoted above; 20260822_review_completion_guard.sql:48-52 counts `count(*) FILTER (WHERE status = 'signed')` across all slots. The migration header states the intent — 'signed sign-offs (any slot — a primary OR an activated alternate) must reach the number of PRIMARY reviewers' — so the count semantics are deliberate; what is missing is any binding of an alternate to the primary they replace.
```

**Chain reaction.** The same count also lets a standby (never-activated) alternate's signature complete the review — status='signed' is counted regardless of `activated`, and only the UI filters on it (ReviewGateSection.tsx:82, listMyPendingReviews:608). And because reviewCompletionForDraft counts only rows in ('pending','signed') while the DB guard counts primaries in ALL statuses, a primary row voided or invalidated on the still-pending version makes the app say complete while the trigger raises — the promote then fails with a raw Postgres message surfaced through ReviewGateSection's `Couldn't publish: ${res.reason}`.

**Done when.**

- [ ] Alternates carry a backs_signoff_id (or a shared slot_group), and a slot is satisfied only by its primary or by an activated alternate for that slot
- [ ] Completion is evaluated per slot, not as an aggregate count, in both lib/reviewControl.ts and the publish guard
- [ ] A never-activated alternate's signature cannot satisfy any slot, enforced in the database not only in the UI

---

<a id="rg-5"></a>

## RG-5 · The gate's own policy record is writable by everyone the gate constrains, and setReviewControlPolicy logs the change without checking whether it happened

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:139-150`, `supabase/schema.sql:1063-1073`, `supabase/migrations/20260818_review_before_publish.sql:24-26`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. The publish-guard trigger cannot help: enforce_document_publish_guard returns NEW unless `v_advancing` (20260822:37-42), and a review_control-only UPDATE does not move current_version_id or status. Combined with resolveEffectiveReviewControl:34-37 (`for (const c of [docControl, folderControl, libraryControl]) if (c) return c;`) and the test that pins it (lib/__tests__/reviewControl.test.ts:26 'lets a document-level none override an inherited require'), one PATCH of `{"mode":"none"}` by any active member permanently disables the gate for that document — with no audit row at all if written directly rather than through setReviewControlPolicy.

**Mechanism.** review_control is a JSONB column on libraries, collections and documents. All three tables are governed by permissive FOR ALL policies with USING only and no WITH CHECK — `CREATE POLICY "libraries_org_access" ON libraries FOR ALL USING (org_id IN (SELECT my_org_ids()))`, and the same for collections and documents (schema.sql:1063-1069). Per the composition rule, a FOR ALL policy with only USING reuses USING as the INSERT/UPDATE check, so any active org member may UPDATE review_control at any level; the only additional overlay is 20260901's RESTRICTIVE documents_deny_write_guard, which bites only on an explicit ACL deny. The writer relies entirely on the UI: setReviewControlPolicy's own comment says 'Configuring it is restricted to Admin/DocCtrl or a delegated owner (enforced in the UI); this just writes + logs' — and it then writes `await supabase.from(table).update({ review_control: input.control }).eq("id", input.id);` with no {error} capture and no row count, and unconditionally emits the REVIEW_CONTROL_SET / REVIEW_CONTROL_CLEARED audit row afterwards.

**Failure scenario.** Because most-specific-defined wins (resolveEffectiveReviewControl:34-37) and a document-level 'none' overrides an inherited 'require' — an intended behaviour the test suite pins ('lets a document-level none override an inherited require') — any active member can PATCH a single document row with review_control = {"mode":"none"} and permanently exempt that controlled drawing from the library's gate. Nothing audits that write, because it did not go through setReviewControlPolicy. In the other direction, when a legitimate controller's write is denied or matches zero rows, the function still logs REVIEW_CONTROL_SET with the intended control in details — so the audit trail asserts a policy change that the database never accepted, and the controller sees a success.

**Evidence.**

```
lib/reviewControl.ts:144-149 — the update and the logAuditAction are sequential with no conditional between them; the audit call's only guard is `.catch(() => {})`, which suppresses audit failures rather than write failures. supabase/schema.sql:1072 and :1063-1069 for the FOR ALL/USING-only policies. Confirmed with two shapes: grep 'ON libraries|ON collections|ON documents' across supabase/*.sql, and reading 20260901_db_hard_enforcement.sql:152-174, which adds only RESTRICTIVE deny overlays on documents and nothing on libraries/collections.
```

**Chain reaction.** The base table policies were flagged in audit-reports/roles-and-permissions (EGRESS-6 and 11-database-authority cover document_versions and the documents overlay); what is new here is that review_control rides on them, so the gate's configuration has exactly the same write surface as ordinary document metadata. Any hardening of the sign-off table is moot while the policy that decides whether a roster is created at all is member-writable.

> **Verifier correction.** 'All three tables' is wrong — collections is no longer member-writable. supabase/migrations/20261011_collections_guard_and_trash.sql:30-34 adds `CREATE POLICY collections_update_controllers ON collections AS RESTRICTIVE FOR UPDATE USING (is_org_controller(org_id)) WITH CHECK (is_org_controller(org_id))`, so a FOLDER-level review_control write is controller-only. libraries and documents are unchanged: two searches (grep for policies on those tables across supabase/*.sql and supabase/migrations/*.sql, plus reading 20260901_db_hard_enforcement.sql:152-174) find only schema.sql:1059-1069's FOR ALL/USING-only policies, the RESTRICTIVE deny-ACL overlays on documents, and no policy or trigger on libraries at all. The library level is the one ReviewControlModal actually configures for a whole library, so the exposure stands there.

**Done when.**

- [ ] review_control is writable only by Admin/DocCtrl or the level's effective owner, enforced by a RESTRICTIVE UPDATE policy or a SECURITY DEFINER RPC — not by the UI
- [ ] setReviewControlPolicy captures {error} and the affected row count and throws on failure; the audit row is written only after a confirmed write
- [ ] Changing review_control on any level emits an audit row from the database (trigger), so a direct PATCH is still recorded

---

<a id="rg-6"></a>

## RG-6 · The review gate fails OPEN when its policy cannot be read — while the PSM gate three lines away fails closed

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:40-50`, `components/documents/RevUpModal.tsx:193-211`, `components/documents/RevUpModal.tsx:187-189`, `components/documents/RevUpModal.tsx:218-219`, `components/documents/ReviewGateSection.tsx:39-64`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the real behaviour is worse than the finding states: effectiveReviewControlForDocument (reviewControl.ts:40-50) uses `.maybeSingle()` and never throws on a PostgREST error, so the catch at :195 is not even reached — the failed read degrades silently to `{mode:'none'}` with no null to distinguish it. Nothing downstream recovers: the review requirement is enforced ONLY by this client-side branch (RevUpModal.tsx:280-291 chooses submitForReview vs revUpDocument), and the DB completion guard only bites when roster rows already exist (20260822:53 `IF COALESCE(v_primary_reqs, 0) > 0`), which a skipped review never creates. ReviewGateSection.tsx:39-64 swallows the same errors.

**Mechanism.** Three layers each degrade to 'no gate' on failure. (1) effectiveReviewControlForDocument destructures `const { data } = await ...` on both the collections and libraries reads and discards {error} — supabase-js resolves rather than throws, so an RLS denial, a schema-cache miss or a transient failure yields data=null, folder=null, lib=null, and the function returns NONE. (2) RevUpModal wraps the call in `try { ... } catch { if (alive) setReviewControl(null); }` and then computes `const effMode = effectiveModeForRevUp({ control: reviewControl ?? { mode: "none" }, changeType })` — a null policy is coerced to 'no gate'. (3) ReviewGateSection.load() ignores errors identically, so the Inspector panel renders nothing. The contrast is in the same useEffect: the doc-class read sets `setDocClassUnknown(true)` on failure and line 219 computes `const mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike` under the comment 'we couldn\'t check the class is NOT no class declared — on a transient resolution failure the MOC gate fails CLOSED'. The review gate, resolved by the adjacent await, does the opposite.

**Failure scenario.** The collections SELECT returns a PostgREST error (schema-cache miss after a migration, an ACL RESTRICTIVE policy the user does not satisfy, a cold-start timeout). reviewControl resolves to null. The rev-up form shows no 'route through review' section and no warning; the publisher attaches the revised P&ID and clicks Publish. revUpDocument runs, current_version_id advances, and the DB publish guard does not object because no roster rows exist for that version (20260822:53 requires v_primary_reqs > 0 to bite). A revision that the library requires to be reviewer-signed becomes the controlled copy with no sign-off and no trace that the gate was skipped. A narrower version of the same hole is unconditional: `reviewControl` initialises to null (RevUpModal.tsx:105) and the Publish button is `disabled={submitting || !file}` (:857) with no dependency on policy resolution, so a click landing before the async resolve completes takes the same path.

**Evidence.**

```
lib/reviewControl.ts:45 `const { data } = await supabase.from("collections").select("review_control")...` and :48 `const { data: lib } = await supabase.from("libraries")...` — neither captures error. RevUpModal.tsx:197 `catch { if (alive) setReviewControl(null); }`; :210 `reviewControl ?? { mode: "none" }`. lib/docClass.ts:59-68 documents the opposite contract for the class gate ('A TRANSIENT failure (network, RLS hiccup) THROWS instead of returning null ... that\'s how a PSM gate quietly turns itself off').
```

**Chain reaction.** Because the failure is silent at all three layers, there is no audit row, no notification and no UI state distinguishing 'this library has no gate' from 'we could not find out'. The audit_logs entry for the publish looks like an ordinary direct publish.

**Done when.**

- [ ] effectiveReviewControlForDocument captures {error} on both reads and throws on a transient failure, matching effectiveDocClassForDocument
- [ ] RevUpModal treats a resolution failure as UNKNOWN → fails closed (route through review, or block publish with an explicit 'couldn\'t verify the review policy' message), never as mode 'none'
- [ ] The Publish/Submit control is disabled until the policy has resolved

---

<a id="rg-7"></a>

## RG-7 · A draft whose reviewer roster failed to save strands the review and simultaneously leaves the database completion guard inert

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:208-239`, `lib/reviewControl.ts:363-369`, `supabase/migrations/20260822_review_completion_guard.sql:53`, `components/documents/ReviewGateSection.tsx:206-213`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both consequences: the draft can never finalize (finalizeReviewedRevision returns reason 'incomplete' at :409-411, and the Publish button is disabled at ReviewGateSection.tsx:214) while the database completion guard is simultaneously inert for that version, so a direct rev-up over it is unblocked. Partial mitigation the finding omits: reviewControl.ts:243-256 does notify the owner and Admin/DocCtrl ('The reviewer roster for X has gaps: ...'), and ReviewGateSection.tsx:206-213 shows a rescue panel — but the message misattributes the cause to 'no reviewers are configured for this library' and the publisher's own alert is flatly false. MEDIUM is appropriate.

**Mechanism.** openReviewRoster upserts the roster and, on failure, only records a warning: `console.warn("[reviewControl] roster insert failed", upsertErr.message); warnings.push(...)`. The draft version and documents.pending_version_id have already been written by submitForReview (lib/revisions.ts:884-918) and are not rolled back. Downstream, an empty roster is not a blocked state in the database — the guard's condition is `IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs`, so zero primary rows means the guard never bites, by design, so that ordinary non-review publishes pass. In the app, `complete = requiredPrimaries > 0 && signed >= requiredPrimaries` is false forever.

**Failure scenario.** The upsert fails (RLS, a CHECK on a value the environment's constraint has not been widened for, a transient error). The publisher gets an alert saying 'Reviewers have been notified. The current revision stays the controlled copy; the moment the last required reviewer signs, the draft publishes automatically' (RevUpModal.tsx:287-290) — the roster does not exist and nobody was notified. The Inspector shows the rescue card 'No reviewers are configured for this library — this draft can never complete review as-is', whose only offered exits are editing the library policy and resubmitting (which requires uploading another file, producing 2B). Meanwhile the document sits with pending_version_id set and getReviewSummaries reports it inReview with 0/0 forever. The way out that actually works is a direct publish — which, because the roster is empty, the DB guard permits with no review at all.

**Evidence.**

```
lib/reviewControl.ts:218-222 is the entire failure handling; the alternative path (:223-238) is what notifies and audits, so a roster failure also produces no REVIEW_REQUESTED audit row. 20260822_review_completion_guard.sql:53 shows the >0 precondition. ReviewGateSection.tsx:206-213 shows the rescue card's exits.
```

**Chain reaction.** The same zero-roster hole is what makes finding 7's intake path publishable and what makes IntakePanel's requireRosterComplete:false safe-looking. 'No roster' currently means 'not gated' everywhere; it should mean 'gated and not yet satisfied' whenever the effective mode is 'require'.

> **Verifier correction.** Not silent, which softens the framing: because the failure pushes onto `warnings` at :222, the `if (primaries.length === 0 || warnings.length)` branch at :240-260 does fire and notifies the effective owner plus all org controllers ('The reviewer roster for X has gaps: the reviewer roster could not be saved (...)'). What is genuinely lost is the REVIEW_REQUESTED audit row and the reviewers' own notifications (both inside the else branch, :223-238), plus the stranding itself.

**Done when.**

- [ ] A roster upsert failure aborts the submission (clear pending_version_id and supersede the just-created draft) rather than leaving a stranded in-review state
- [ ] The success alert is emitted only after a confirmed roster write
- [ ] The publish guard blocks promotion of a version whose document's effective review mode is 'require' but which carries zero primary rows, instead of treating an absent roster as 'no gate'

---

<a id="rg-8"></a>

## RG-8 · No reviewer independence: the submitting publisher is placed on their own draft's roster and may sign it, and their signature auto-finalizes the publish

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:196-232`, `lib/reviewControl.ts:126-132`, `lib/reviewControl.ts:316-332`, `components/documents/ReviewGateSection.tsx:82`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide search confirms the absence: no `excludeSelf`/self-review check exists in lib/reviewControl.ts, lib/revisions.ts (submitForReview), or any migration touching document_review_signoffs (20260818/20260822/20260828/20260830). The e_signatures RLS only requires `signer_user_id = auth.uid()` and active membership (20260720_e_signatures.sql:56-60), and the 20260822 publish guard's completion test counts signed rows without regard to who created the version. A sole-Engineer roster is self-approving end to end.

**Mechanism.** expandReviewers takes only (orgId, control) — it has no notion of who submitted the draft, and grep for 'created_by' in lib/reviewControl.ts returns nothing. openReviewRoster inserts every resolved primary, then excludes the actor from notification only: `await Promise.all(primaries.filter((r) => r.uid !== input.actorId).map((r) => notify({...})))`. The roster row is still created. ReviewGateSection then offers the ceremony to whoever matches: `const mine = roster.find((r) => r.reviewerUserId === uid && r.status === "pending" && (r.slot === "primary" || r.activated))` — no comparison against the draft's created_by. And recordReviewSignoff's auto-finalize runs as the signer: `finalizeReviewedRevision({ ..., actorId: input.signerUserId, actorName: input.signerName })`.

**Failure scenario.** A library gates on reviewerRoles: ['Engineer']. An Engineer with publish authority revises a P&ID and submits it for review. expandSet resolves every active Engineer including them, so they appear on their own roster as a primary. If they are the only Engineer, requiredPrimaries = 1 and they sign their own draft; the last-signature auto-finalize promotes it immediately under their own uid, which also satisfies the publish guard's authority branch. The audit trail records SUBMIT_FOR_REVIEW, ESIGNATURE_CAPTURED and REVISION_PUBLISHED_AFTER_REVIEW — all the same person, seconds apart — and the system reports the revision as reviewer-approved. The 'the actor was not notified' filter at :224 is the only trace that the tool knew the submitter was on the list.

**Evidence.**

```
lib/reviewControl.ts:224 filters notifications but not rows; :128-131 expandReviewers signature carries no actor; ReviewGateSection.tsx:82 has no author check. Two shapes confirm the absence: grep 'created_by|createdBy' in lib/reviewControl.ts returns nothing, and grep for 'independen|own draft|self-sign' across lib/ and components/ returns only unrelated prose.
```

**Chain reaction.** Combined with finding 5's aggregate count, a two-primary roster where the submitter is one of them needs only one genuinely independent signature. For an ASME B31.3 or MOC-bearing revision this is the difference between a reviewed change and a self-certified one.

**Done when.**

- [ ] openReviewRoster excludes the draft's created_by from the primary and alternate sets, and warns when that empties the roster (reusing the existing zero-primary escalation)
- [ ] recordReviewSignoff refuses a signature whose signerUserId equals the draft version's created_by
- [ ] The policy editor states plainly that a reviewer who authors a revision is skipped for that revision

---

<a id="rg-9"></a>

## RG-9 · Signing re-authentication is advisory only — it is client-side, leaves no record on the signature, and defaults to satisfied when the session cannot be read

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/eSignatures.ts:48-90`, `lib/eSignatures.ts:103-137`, `components/signatures/SignatureCeremony.tsx:61-66`, `components/signatures/SignatureCeremony.tsx:74-88`, `supabase/migrations/20260720_e_signatures.sql:26-38`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The comment's own claim in the file header (lib/eSignatures.ts:48-52) is not enforced anywhere server-side: the RLS INSERT policy (20260720_e_signatures.sql:55-60) checks only `signer_user_id = auth.uid()` plus active membership, so any code holding the session — including the other two callers, components/signatures/SignatureCaptureHost.tsx:50 and lib/acknowledgments.ts:429 — reaches recordSignature without passing through the ceremony. The 'defaults to satisfied' and 'no record on the signature' halves are both literally true.

**Mechanism.** The whole ceremony is a React gate. `identityReady` is `reauth === "loading" ? false : reauth === null ? true : reauth.method === "password" ? password.length > 0 : reauth.fresh`, and submit() calls verifySigningCredential only when the client-side state says the account is password-based. recordSignature then inserts the row from the browser with no evidence of re-auth attached — the e_signatures table has columns for intent, statement, signer, content_hash and user_agent but none for reauth_method or reauth_at, and the RLS policy checks only `signer_user_id = auth.uid()` plus membership. So nothing server-side can tell a re-authenticated signature from one produced by calling recordSignature directly. Three softer edges compound it: `reauth === null` (signingReauthState returns null whenever `user?.email` is falsy) is treated as ready; SSO freshness is computed purely from `user.last_sign_in_at` in the client (`fresh: Date.now() - last < SSO_REAUTH_WINDOW_MS`); and the signed name is not a name — SignatureCeremony's typed-name check compares against `signerName`, which both call sites derive as `(userEmail?.split("@")[0] ?? "").trim() || "user"` (ReviewGateSection.tsx:83, SignatureCaptureHost.tsx:44), so signer_name is stored as the email local part despite the column comment 'the name the signer typed to confirm'.

**Failure scenario.** The control the code names — 'A signature that anyone at an unlocked workstation can produce is a click, not a signature' — holds only against a person using the modal. Any script running with the session (a browser extension, a bookmarklet, an automation harness, or the app's own SignatureCaptureHost invoked through the global `request-signature` event) reaches recordSignature without the password prompt, and the resulting row is byte-identical to a re-authenticated one. Separately, for a signature that WAS produced properly, an auditor asking 'was this signer re-authenticated at the moment of signing?' has nothing to read: the row records a user_agent supplied by the same client and a signer_name of 'jsmith'.

**Evidence.**

```
components/signatures/SignatureCeremony.tsx:61-65 for identityReady including the `reauth === null ? true` branch with its comment 'no session info — server still validates the write' (the server validates only signer_user_id and membership); 20260720_e_signatures.sql:26-38 lists every column — there is no re-auth field; lib/eSignatures.ts:66-68 for the client-side freshness computation.
```

**Chain reaction.** audit-reports/drafting-flow/10-audit-evidence.md already records that intent, statement, signer_role, content_hash and user_agent are unvalidated client input on this same insert. This finding is the remaining half: the one control the module adds on top (re-authentication) is also client-side and, unlike the others, leaves no field behind that could ever be checked.

**Done when.**

- [ ] Signature capture goes through a server route that re-verifies the credential (or a fresh-session claim) and writes the e_signatures row itself
- [ ] e_signatures records reauth_method and reauth_at, set server-side, and the signature panel renders them
- [ ] signer_name is the member's display_name from org_members, resolved server-side, not the email local part; the typed-name check compares against that

---

<a id="rg-10"></a>

## RG-10 · The external intake route repoints pending_version_id and can publish over a live review under service role, orphaning the sign-off roster

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:320-334`, `supabase/migrations/20260822_review_completion_guard.sql:32-34`, `components/projects/IntakePanel.tsx:234-241`, `components/projects/IntakePanel.tsx:247-262`, `lib/reviewControl.ts:516-522`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The headline scenario is false: an assigned document mid-review cannot have pending_version_id repointed — the route 409s. A much narrower path does survive: when `link.allow_auto_supersede && linkAuthored` the guard is skipped, `autoNow` (route.ts:302) is true, and route.ts:322-327 sets `current_version_id` + `pending_version_id: null` through supabaseAdmin, which the publish guard waves through (`IF v_actor IS NULL THEN RETURN NEW;`, 20260822_review_completion_guard.sql:32-34), leaving the old draft's roster rows 'pending' on an un-superseded version that scanReviews (lib/reviewControl.ts:518-520) keeps chasing. That requires the org to have explicitly granted auto-supersede on a vendor-authored document that an org publisher separately put into review — hence LOW, not MEDIUM.

**Mechanism.** The route runs entirely on supabaseAdmin (service role), so auth.uid() is NULL and the publish guard's first statement — `IF v_actor IS NULL THEN RETURN NEW; END IF;` — returns before the review-completion check, the authority check and the hold check. On the trusted-link path it writes `.update({ current_version_id: versionId, rev: revLabel || "A", revision: revLabel || "A", status: "Issued", pending_version_id: null, updated_at: nowIso })` directly. On the ordinary path it writes `.update({ pending_version_id: versionId, updated_at: nowIso })` — an unconditional overwrite with no compare-and-set (contrast submitForReview, which CASes the pointer at lib/revisions.ts:906-918) and no call to openReviewRoster, and it never voids or invalidates the roster of whatever draft the pointer used to name.

**Failure scenario.** An assigned document is mid-review: draft 2A, pending_version_id = V_2A, three primaries on the roster, two already signed. The vendor submits through their intake link. pending_version_id is repointed at the intake version, which has no roster. The 2A rows keep status 'pending' and stay attached to V_2A, so scanReviews (which selects on `.eq("org_id", orgId).eq("status", "pending")` with no check that the version is still the document's pending draft) nags the third reviewer indefinitely about a draft the document no longer points at, while ReviewGateSection — scoped by listDraftRoster(doc.id, pv) — shows an empty roster and the 'No reviewers are configured' rescue card. A controller then clicks Approve in IntakePanel, which calls finalizeReviewedRevision with `requireRosterComplete: false`; the app check is skipped and the DB guard finds zero roster rows for the intake version, so it passes. The externally supplied file becomes the controlled revision and the two signatures on 2A are discarded with no supersede, no rejection and no notification. IntakePanel's reject path has the same gap in reverse: it clears pending_version_id and sets review_state 'rejected' without touching document_review_signoffs at all.

**Evidence.**

```
20260822_review_completion_guard.sql:32-34 is the service-role escape at the top of the guard; app/api/intake/upload/route.ts:14 imports supabaseAdmin and :322-333 performs both updates. IntakePanel.tsx:236-240 passes requireRosterComplete: false, which lib/reviewControl.ts:408-411 honours by skipping reviewCompletionForDraft entirely.
```

**Chain reaction.** Cited against the projects/intake area only for the panel; the review-gate consequence — a service-role door around a guard whose comment says it 'applies to ALL authenticated publishers, including Admin/DocCtrl' — belongs here. The same NULL-actor escape makes the guard inert for every future server route that publishes.

> **Verifier correction.** The ordinary-path half of this is largely mitigated, and the finding omits the guard. app/api/intake/upload/route.ts:256-258 rejects with 409 before any write: `if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored)) return bad("Your previous submission for this document is still in review...", 409)`. Because autoNow (:299) is exactly `!!docId && allow_auto_supersede && linkAuthored`, the non-auto branch at :331-333 is only ever reached with pending_version_id already NULL — so the 'unconditional overwrite orphaning an existing roster' is reachable only as a TOCTOU race against a concurrent submitForReview, not as ordinary behavior. What survives is the autoNow branch (:322-327): on a trusted link (allow_auto_supersede) for a link-AUTHORED document it writes current_version_id / status 'Issued' / pending_version_id=null under supabaseAdmin, and because 20260822_review_completion_guard.sql:32-34 returns early on NULL auth.uid() it bypasses review completion, publish authority AND the active-hold check — leaving any org-side roster rows pending against the orphaned draft. Also note the requireRosterComplete:false path (IntakePanel.tsx:236-240) is documented intent (lib/reviewControl.ts:398-401) and is still covered by the DB guard for authenticated actors.

**Done when.**

- [ ] The intake route refuses to repoint pending_version_id when the current pending draft has any roster row in ('pending','signed'), or explicitly invalidates that roster and notifies its signers first
- [ ] The publish guard does not blanket-exempt service role for the review-completion branch (only for the authority branch), or the intake route re-checks completion itself
- [ ] IntakePanel's reject path voids the pending draft's sign-off rows so scanReviews stops chasing them

---

<a id="rg-11"></a>

## RG-11 · The rev-up form opens pre-selected on the change type that switches the review gate off, and remembers it

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/RevUpModal.tsx:97`, `components/documents/RevUpModal.tsx:143-145`, `components/documents/RevUpModal.tsx:311`, `lib/reviewControl.ts:55-62`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Every factual element is confirmed. Downgraded because the mitigating control the finding itself quotes actually renders in exactly the risky state and names the remedy: RevUpModal.tsx:643-651 shows the amber banner whenever `reviewControl && reviewControl.mode !== "none" && effMode === "none"`, telling the publisher the gate is being skipped and to set Change Type to Major. The gate is bypassed by a bad default, but never silently — that is a defaulting/UX defect, not a MEDIUM control failure.

**Mechanism.** effectiveModeForRevUp's escape hatches are `if (input.changeType === "Minor" || input.changeType === "Correction") return "none";` and `if (input.relatedTicketId) return "none";`. The form's initial state is `const [changeType, setChangeType] = useState<DocumentVersion["changeType"]>("Minor")` — the default selection is one of the two hatches. On success the choice is persisted per library (`localStorage.setItem(memoryKey, JSON.stringify({ issueType, changeType }))`) and rehydrated on open (`if (remembered?.changeType) setChangeType(remembered.changeType)`), so a publisher who once published a genuinely minor revision reopens the form pre-set to skip the gate. The escape hatch is self-declared by the person the gate constrains, with no second party and no audit distinction.

**Failure scenario.** A publisher in a mode 'require' library opens the rev-up modal for a line-routing change. changeType is already 'Minor' from the last time. The banner at :646-649 does warn ('This library normally requires pre-publish review, but a Minor change publishes directly, skipping the reviewers'), but the default state means the skip is what happens if nobody actively changes anything, and the MOC gate at :219 releases at the same moment (`mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike`) — so one dropdown left at its default disables both the reviewer sign-off and the OSHA 1910.119(l) MOC reference for the same revision.

**Evidence.**

```
RevUpModal.tsx:97 initial state; :143-145 the localStorage rehydrate; :311 the persist; lib/reviewControl.ts:59-60 the two hatch branches. The warning banner exists (:643-649) but is conditional on `reviewControl && reviewControl.mode !== "none" && effMode === "none"` — i.e. it is not shown when the policy failed to resolve (finding 4).
```

**Chain reaction.** changeType is a free self-declaration recorded on document_versions with no reviewer of the declaration itself, so both the review gate and the PSM MOC gate ultimately rest on it. Neither audit_logs nor the evidence pack flags a revision that skipped a required review by way of the hatch.

**Done when.**

- [ ] The change-type control opens unset (or on the non-exempt option) and the publisher must choose; the remembered value never pre-selects an exemption
- [ ] Taking the Minor/Correction hatch in a mode 'require' library writes a distinct audit action (e.g. REVIEW_GATE_SKIPPED_MINOR) with the declared reason
- [ ] The register/evidence pack can list revisions published under the hatch

---

<a id="rg-12"></a>

## RG-12 · finalizeReviewedRevision's post-promote writes are unchecked; a failure leaves the newly controlled revision filtered out of every 'latest approved' query, so viewers serve the superseded drawing

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:444-449`, `components/viewers/MultiDocViewer.tsx:386`, `components/assets/FileReferenceModal.tsx:42`, `components/documents/HistoryDrawer.tsx:60`, `lib/timeline.ts:330`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. 'Filtered out of every latest-approved query, so viewers serve the superseded drawing' is false — the promote at :429-433 sets current_version_id, and every viewer/share path hits that pointer directly with no review_state predicate, so the correct new file is served. The real residue is a stuck record: revision_label frozen at '2A' while documents.rev says '2', review_state still 'in_review', prior rev not superseded — which hides the current revision from the listing surfaces that DO filter (components/documents/HistoryDrawer.tsx:60, lib/timeline.ts:330, components/documents/CompareRevisionsModal.tsx:60). The cited unique-index collision (20260823_publish_contract.sql:63-65) is also not the systematic trigger implied: baseRev is the NEXT label, not the outgoing rev's, so it collides only against a pre-existing un-superseded row with the same label.

**Mechanism.** The promote at :429-439 is guarded and checked. Everything after it is not. `await supabase.from("document_versions").update({ review_state: "approved", revision_label: baseRev, released_at: nowIso, supersedes_version_id: previousVersionId, updated_at: nowIso }).eq("id", pendingId);` — no {error} destructure, no row count. Same for `.update({ superseded_at: nowIso }).eq("id", previousVersionId)` on the next line. Meanwhile every surface that resolves 'the file to show' re-derives it as the newest version with `.or("review_state.is.null,review_state.eq.approved")` rather than following documents.current_version_id: MultiDocViewer.tsx:386 does exactly `select("file_url").eq("record_id", doc.id).or("review_state.is.null,review_state.eq.approved").order("created_at", {ascending:false}).limit(1)`, and FileReferenceModal, HistoryDrawer and timeline.ts:330/:514 use the same filter. So review_state is the switch that makes a version visible, and the write that flips it is fire-and-forget.

**Failure scenario.** The promote commits — documents.current_version_id = the approved draft, rev = '2', status 'Issued'. The follow-up UPDATE then fails: a transient error, or a unique-index collision on document_versions_active_label_uniq (record_id, revision_label) WHERE superseded_at IS NULL AND is_branch = FALSE (20260823_publish_contract.sql:63-65) if any active version already carries the label '2' — reachable via correctRevisionLabel, which relabels an existing active version. Nothing surfaces the error; finalizeReviewedRevision returns { published: true } and the 'Published after review' notification goes out. The version row still reads review_state='in_review', revision_label='2A', released_at=NULL, and the prior revision still has superseded_at=NULL. The register says Rev 2. Every viewer query excludes the in_review row and returns the newest remaining one — Rev 1, the superseded drawing — and HistoryDrawer shows no Rev 2 at all. A field engineer opening the P&ID gets the old revision from a document the system reports as revised.

**Evidence.**

```
lib/reviewControl.ts:444-446 and :447-449 quoted above — compare :429-434, where the promote explicitly captures `{ data: promoted, error: docErr }` and returns on failure, and :450-455, where the sign-off void DOES check `{ error: voidErr }` and warns. The three bookkeeping writes in between are the unchecked ones.
```

**Chain reaction.** This is the supabase-js {error} pattern the prior audits recorded in the audit logger and six ticket writes, landing on the one write that decides which bytes a worker sees. The same unchecked shape at :461-465 (provenance) and :448 (supersede) means the prior rev can stay unsuperseded, so two versions read as live.

> **Verifier correction.** The mechanism is real but the stated consequence is wrong. Every file-resolution surface follows documents.current_version_id FIRST and only falls back to the review_state filter when that yields nothing: MultiDocViewer.tsx:381-388 (`if (doc.currentVersionId) { ... .eq("id", doc.currentVersionId).single() }` before the .or() fallback), FileReferenceModal.tsx:37-44, app/(protected)/documents/[libraryId]/page.tsx:1916-1936, and both share routes (app/api/share/resolve/route.ts:53-58 and app/api/share/file/route.ts:62-66, each commented 'Resolve the current PUBLISHED version's file'). Since the promote at :429-439 IS checked and sets current_version_id, viewers serve the NEW file, not the superseded one. The real residue of the unchecked writes at :444-449 is bookkeeping corruption: the promoted version keeps review_state='in_review', revision_label '2A', released_at NULL and no supersedes pointer, and the prior version keeps superseded_at NULL — so the now-controlled revision is filtered OUT of HistoryDrawer.tsx:60, lib/timeline.ts:330 and :514, and CompareRevisionsModal.tsx:58-60, while documents.rev reads '2'. Wrong history and a mislabeled rev, not the wrong drawing.

**Done when.**

- [ ] The relabel/approve UPDATE and the supersede UPDATE capture {error} and row counts; a failure is raised, not swallowed
- [ ] The promote and its bookkeeping happen inside one transactional RPC so current_version_id can never point at a row still marked in_review
- [ ] Viewer/history surfaces resolve the controlled file through documents.current_version_id rather than re-deriving 'newest non-in_review'

---

<a id="rg-13"></a>

## RG-13 · useRevLetters is documented in the schema and typed in the app but never read — the letter suffix cannot be turned off

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `types/schema.ts:208-209`, `supabase/migrations/20260818_review_before_publish.sql:22`, `lib/reviewControl.ts:156-163`, `lib/revisions.ts:871`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The absence claim is correct — zero readers. Downgraded because there is also no way for a facility to SET it and be misled: `grep -n "useRevLetters" components/documents/ReviewControlModal.tsx` returns nothing, so the only configuration surface for review_control never offers the option. The exposure is a dead typed field plus a misleading migration comment, not a setting that silently fails on real users.

**Mechanism.** The policy shape documents `useRevLetters?: bool  -- auto 2A/2B suffix (default true)` and types/schema.ts declares `/** Auto-manage the 2A/2B letter suffix during review (default true). */ useRevLetters?: boolean;`. Nothing consumes it. letterLabelFor takes only (baseRev, existingDraftLabel) and always appends a letter, and submitForReview calls it unconditionally: `const draftLabel = letterLabelFor(baseRev, existingLabel);`. ReviewControlModal never renders or writes the field.

**Failure scenario.** A facility whose numbering standard has no letter revisions — or one where 'A', 'B', 'C' are already the issued-for-review revision letters in the title block — configures review control expecting to turn the suffix off, because both the migration comment and the TypeScript type say the option exists. It has no effect: every in-review draft is labelled baseRev + a letter. Where the base rev is itself a letter (rev 'A'), letterLabelFor produces 'AA', and where a draft reaches '2Z' the trailing-letter regex `/^(.*?)([A-Y])$/i` stops matching and the fallback yields '2ZA'. The document-control register then shows revision labels that do not exist in the drawing's title block.

**Evidence.**

```
Two search shapes: grep -rn 'useRevLetters' across .ts/.tsx/.sql, and a case-insensitive grep for 'revletters' across the whole tree excluding node_modules — both return exactly the two declaration sites and no reader. lib/reviewControl.ts:156-163 is the whole function; :159 is the [A-Y] regex.
```

**Chain reaction.** Same shape as the sidebar-badge 'doorway' and the push_subscriptions cron the prior audits recorded: a documented capability that reads as configured behaviour and is inert. Here the consequence lands on revision identity, which is the one field a controlled drawing is looked up by.

**Done when.**

- [ ] letterLabelFor is passed the resolved control and returns baseRev unchanged when useRevLetters === false, with the draft distinguished by review_state rather than the label
- [ ] ReviewControlModal exposes the toggle, or the field is deleted from types/schema.ts and the migration comment
- [ ] The letter sequence handles a letter-valued base rev and exhaustion past Z explicitly rather than falling through to string concatenation

---
