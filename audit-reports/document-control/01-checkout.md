> **CLAIMED** claude/report-audit-findings-a3i90l 2026-08-24T18:00:00Z

# 01 · Checkout, check-in & the lock

**14 findings** — 3 CRITICAL · 7 HIGH · 4 MEDIUM.

Whether the lock is a control or a convention.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| One-active-episode-per-document enforced by a partial unique index, with the loser of a concurrent first-checkout re-selecting and joining the winner's episode | `supabase/migrations/20260729_checkout_episodes.sql:51-52, lib/checkoutEpisodes.ts:263-273` | This is the only checkout invariant that is genuinely database-enforced rather than advisory. The 23505 handler at lib/checkoutEpisodes.ts:267-270 is correct. Any fix that adds RLS or triggers to checkout_episodes must not break the insert-then-reselect race path. |
| The CAS lock claim: a conditional UPDATE filtered on `checked_out_by IS NULL OR checked_out_by = me`, which Postgres re-evaluates after the blocking write commits | `components/documents/CheckoutFlowModal.tsx:368-381, lib/checkoutEpisodes.ts:752-764` | Correctly closes the read-then-write double-lock race. The defect is only in how a null result is interpreted (see the failed-lock-claim finding) — the predicate itself is right and should be preserved. |
| publish_revision: per-document row lock (SELECT ... FOR UPDATE) plus the expected-base check that returns stale_base instead of clobbering, with the version insert, superseded_at stamp and pointer flip in one transaction | `supabase/migrations/20260828_integrity_hardening.sql:70-194` | This is the fix for the lost-update bug that docs/CHECKOUT_SYSTEM_REVIEW.md F1 called critical, and it works. The lock and MOC problems are about what this function does NOT check; nothing about the concurrency design should be touched. |
| reconcileDocumentCheckoutState — rebuilds documents' checkout columns from the active session rows, handling all three shapes (no sessions, orphaned holder, valid holder) | `lib/checkoutEpisodes.ts:794-879` | The self-healing primitive every bulk/expiry/repair path leans on, and it is correct: it never trusts a passed-in list and never clears a lock while sessions remain. Fixes elsewhere should call it rather than hand-clearing columns. |
| Pure, unit-tested decision cores: computeCheckInTransition / pickNextLockHolder / activeCollaboratorNames, and checkInCardsFor / validateCheckIn / mocRequirementFor | `lib/checkoutEpisodes.ts:73-123, lib/checkinOutcomes.ts:87-302, lib/__tests__/checkoutEpisodes.test.ts, lib/__tests__/checkinOutcomes.test.ts` | The lock-transfer and check-in-card rules are separable from the DB and already covered by tests. Server-side enforcement of the MOC gate can reuse mocRequirementFor's logic rather than restating it, keeping one vocabulary. |
| enforce_checkout_release_guard reading the org's capability policy at the database — releasing another user's session is genuinely gated in Postgres, not just in the UI | `supabase/migrations/20260831_capability_policy_and_rails.sql:80-102, supabase/migrations/20260901_db_hard_enforcement.sql:109-121` | The right model, and the one the documents lock columns and checkout_sessions DELETE should be brought under. It is also the reason several app paths now fail silently — the guard is doing its job; the callers were written before it existed. |
| The publish-guard trigger's review-completion check, placed before the role short-circuit so it binds Admin/DocCtrl too | `supabase/migrations/20260822_review_completion_guard.sql:43-58` | Demonstrates the pattern a restored lock check should follow: a data-integrity gate that applies to everyone, distinct from the authority gate below it. |


---


<a id="dck-1"></a>

## DCK-1 · The PSM MOC gate for drawing revisions is enforced only in browser JavaScript — no lib mutator, RPC, constraint, or trigger requires it, and revert/supersede have no gate at all

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/RevUpModal.tsx:214-219`, `components/documents/RevUpModal.tsx:261-266`, `lib/checkinOutcomes.ts:291-302`, `supabase/migrations/20260828_integrity_hardening.sql:142-165`, `lib/revisions.ts:1147-1180`, `lib/revisions.ts:1416-1462`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Fully confirmed, and the bypass is broader than the finding claims: publish_revision is SECURITY DEFINER and gates only on active org membership (20260828:76-83 `IF NOT v_is_member THEN RAISE EXCEPTION`), never on library publish authority — so any active member, not just an authorized publisher, can RPC a drawing-class revision into existence with moc_reference NULL. CRITICAL stands.

**Mechanism.** Two searches for MOC enforcement (grep for moc/mocRequired across lib+app+components; grep for moc_reference across supabase/) find the requirement expressed in exactly two client-side places: RevUpModal.tsx:219 `const mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike;` guarding a `return setError(...)` at 261-266, and lib/checkinOutcomes.ts validateCheckIn:295-299, a pure function the check-in panel calls. Server side, moc_reference is a bare nullable TEXT column (schema.sql:349, 905); publish_revision inserts it with `NULLIF(p_version->>'moc_reference','')` (20260828:159) and never tests it; revUpDocument passes it through (lib/revisions.ts:522) with no validation. revertToVersion (lib/revisions.ts:1147-1180) and supersedeDocument (1416-1462) accept mocReference as optional and have no drawing-class gate at all — yet both change which sheet is the controlled copy.

**Failure scenario.** OSHA 1910.119(l): a P&ID revision reflecting a real field change publishes with moc_reference NULL. Three ways with no code change: (a) set change type to "Minor" or "Correction" in RevUpModal — isMinorLike short-circuits mocRequired even for a drawing-class document; (b) call publish_revision directly with no moc_reference in p_version; (c) use revertToVersion to make an older drawing current again, which no MOC path covers. The evidence pack (lib/evidencePack.ts:62) then prints "—" in the MOC column for a change that legally required one.

**Evidence.**

components/documents/RevUpModal.tsx:261-263 is the entire gate:
```
    if (mocRequired && mocReference.trim().length < 3) {
      return setError(
        "This is a drawing-class document — PSM requires the MOC reference for a non-minor revision. ..."
```
lib/checkinOutcomes.ts:295-299 is the other one, and it is a pure function with no DB involvement:
```
  if (card.moc === "required") {
    if (!input.mocStatus) return "State the MOC position — PSM requires it for drawing changes.";
```

**Done when.**

- [ ] The MOC requirement is evaluated where the write happens — inside publish_revision (which can resolve doc_class from documents/collections/libraries) or at minimum inside revUpDocument before the upload, not only in the modal
- [ ] Minor/Correction remains the documented exemption but is decided server-side, so selecting it in the client does not by itself waive the gate
- [ ] revertToVersion and supersedeDocument on a drawing-class document run the same gate, since both change the controlled copy

---

<a id="dck-2"></a>

## DCK-2 · checkout_sessions RLS is FOR ALL with USING only, and the release guard is a BEFORE UPDATE trigger — so DELETE bypasses it entirely and non-status edits to another user's session are unguarded

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 3 — the permissive-RLS cluster).** Confirmed: `checkout_sessions_org_access` is `FOR ALL USING(org)` and the only rail is a BEFORE UPDATE trigger keyed on a status change, so DELETE and non-status edits slipped through. Fixed with a `BEFORE UPDATE OR DELETE` trigger `trg_checkout_session_guard` (`20261029`) that complements the existing status rail: **DELETE** of another user's session requires `checkout.force_release`; a change to **outcome / outcome_note / outcome_ref / user_id** on another user's session requires it too. The permissive policy is deliberately LEFT in place because the app performs legitimate cross-user writes it must keep allowing — linking every co-holder's active session to a shared episode (`episode_id`) and the status writes the release rail already governs; the guard restricts only the authority columns, so those benign writes are untouched.
- Done-when: (1) DELETE of another's session is controller-only ✓; (2) the release path has exactly one gated route — DELETE now hits the guard, closing the bypass ✓; (3) outcome columns are writable only by the session's own user (or a force_release holder / service role) ✓.
- Files: `supabase/migrations/20261029_dc_phase3_permissive_rls.sql`
- Tests: `lib/__tests__/phase3RlsMigration.test.ts` (migration presence/shape). The runtime refusal test needs the live DB.
- **Applied & verified live 2026-08-24:** `20261029` (both guard probes true).
- **What this brought to light:** the guard uses `auth.uid() IS NULL` to trust service-role/cron writes, matching the existing release rail's pattern — a consistent "trusted backend, gated user" seam across all checkout triggers.

- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1093-1095`, `supabase/migrations/20260831_capability_policy_and_rails.sql:80-102`, `supabase/migrations/20260901_db_hard_enforcement.sql:109-121`, `supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql:39-45`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search: `grep -rn checkout_sessions supabase/ --include=*.sql | grep -iE 'policy|trigger|delete|grant|revoke'` returns exactly one policy and one BEFORE UPDATE trigger — no DELETE policy, no RESTRICTIVE overlay, no REVOKE. DELETE therefore never reaches the guard, and non-status UPDATEs (expires_at, user_id, purpose) on another member's row pass the `NEW.status IS DISTINCT FROM OLD.status` predicate untouched; reconcileDocumentCheckoutState then clears the lock unconditionally once the rows are gone.

**Mechanism.** `CREATE POLICY "checkout_sessions_org_access" ON checkout_sessions FOR ALL USING (org_id IN (SELECT my_org_ids()))` (schema.sql:1094-1095) is the table's only policy — two searches (grep for `ON checkout_sessions` across supabase/, and grep for policy/RLS keywords in the migrations) return no other. FOR ALL covers SELECT/INSERT/UPDATE/DELETE and the USING clause is reused as the INSERT check, so org membership is the whole test. The force-release rail is `BEFORE UPDATE ON checkout_sessions` (20260831:101) and its body only fires when `OLD.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status` (20260901:113-114). Two holes follow: (a) DELETE is not a status UPDATE — there is no DELETE trigger and no DELETE policy; (b) any column other than status can be rewritten on someone else's active session, including outcome / outcome_note / outcome_ref, which 20261012 added with no CHECK constraint ("the app is the vocabulary", 20261012:24-25).

**Failure scenario.** Two paths. (1) A member who wants a locked P&ID issues `DELETE /rest/v1/checkout_sessions?id=eq.<holder's session>`; the release guard never runs, then any surface that calls reconcileDocumentCheckoutState (the modal's "Release Lock", the project bulk release, the sweep) sees zero active sessions and clears the lock and closes the episode — the exact outcome the 20260831 rail was written to make controller-only. (2) A member PATCHes another user's closed session row to `outcome: 'field_verified'` — status unchanged, trigger silent — and the drawing's walkdown register (CheckoutHistoryPanel's OUTCOME_LABEL 'Field verified ✓') now attests a walkdown that never happened, under someone else's name.

**Evidence.**

supabase/schema.sql:1094-1095:
```
CREATE POLICY "checkout_sessions_org_access" ON checkout_sessions FOR ALL
  USING (org_id IN (SELECT my_org_ids()));
```
20260901_db_hard_enforcement.sql:113-117:
```
  IF OLD.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status
     AND OLD.user_id::text <> auth.uid()::text
     AND NOT org_capability_allows(OLD.org_id, 'checkout.force_release', auth.uid()) THEN
    RAISE EXCEPTION 'You are not allowed to release another user''s checkout. ...'
```

**Done when.**

- [ ] checkout_sessions has explicit per-operation policies: INSERT restricted to rows whose user_id = auth.uid(), UPDATE/DELETE restricted to own rows plus checkout.force_release holders
- [ ] The release guard also covers DELETE (or DELETE is denied outright to non-controllers), so ending someone else's checkout has exactly one gated path
- [ ] outcome / outcome_note / outcome_ref are writable only by the session's own user (or service role), so the PSM register cannot be authored on another person's behalf

---

<a id="dck-3"></a>

## DCK-3 · documents RLS is FOR ALL with USING only — any active org member can seize or clear another user's checkout lock by writing documents.checked_out_by directly

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 3 — the permissive-RLS cluster).** Confirmed: `documents_org_access` is `FOR ALL USING(org)` and no trigger guards the lock columns, so any member could PATCH `checked_out_by` / `current_lock_id` and seize or clear another's lock, past the checkout_sessions rail. Fixed with a BEFORE UPDATE trigger `trg_document_lock_guard` (`20261029`): a change to `checked_out_by` or `current_lock_id` is allowed only when the doc is currently FREE (`OLD.checked_out_by IS NULL` — a claim), the caller IS the current holder (`OLD.checked_out_by = auth.uid()` — transfer to an heir or clear on last-out), or the caller holds `checkout.force_release`. This exactly matches the legitimate transitions `lib/checkoutEpisodes.ts` performs (its CAS filters are `checked_out_by IS NULL OR = self`, and the heir transfer runs as the departing holder), and `forceReleaseDocument` — already gated to capability holders by the pre-existing session release rail — passes the same capability check here.
- Done-when: (1) a change to `checked_out_by` / `current_lock_id` by anyone but the current holder / a force_release holder / the service role is rejected ✓; (2) the legitimate CAS claim on a null holder, the heir transfer, and clear-on-last-out are all permitted ✓.
- Files: `supabase/migrations/20261029_dc_phase3_permissive_rls.sql`
- Tests: `lib/__tests__/phase3RlsMigration.test.ts` (migration shape). Runtime refusal needs the live DB.
- **Applied & verified live 2026-08-24:** `20261029` (both guard probes true).
- **What this brought to light:** the lock authority now has ONE gated write path shared by the session rail and the documents guard, both keyed on `checkout.force_release`, so a controller delegation grant governs every route to another user's lock at once. Cosmetic columns (`checked_out_by_name`, `active_collaborators`) are intentionally unguarded — they carry no authority and follow the holder change.

- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1067-1069`, `supabase/schema.sql:152-158`, `supabase/migrations/20260901_db_hard_enforcement.sql:152-163`, `supabase/migrations/20260831_capability_policy_and_rails.sql:99-102`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. I enumerated every trigger/policy on `documents` (`grep -n 'ON documents' supabase/migrations/*.sql supabase/schema.sql`): documents_guard_access fires only on visibility/acl/acl_index changes, trg_document_publish_guard only when current_version_id or status advances, trg_documents_move_guard on moves, trg_documents_legal_hold_delete on delete. Nothing guards checked_out_by / checked_out_by_name / current_lock_id, so any active member — including a Viewer — can write them, and doing so also satisfies publish_revision's lock branch.

**Mechanism.** The only permissive policy on documents is `CREATE POLICY "documents_org_access" ON documents FOR ALL USING (org_id IN (SELECT my_org_ids()))` (schema.sql:1068-1069) — the exact FOR-ALL-with-USING-only shape the earlier audits found on tickets, notifications, email_notifications and project_documents. For UPDATE, Postgres reuses USING as the WITH CHECK, so the only thing checked is that the row's org is one of mine. The only RESTRICTIVE UPDATE policy added since is documents_deny_write_guard (20260901:152-163), which bites only when an explicit ACL deny for 'write'/'editMetadata' exists — absent a deny it passes everyone. The lock columns checked_out_by / checked_out_by_name / checked_out_at / current_lock_id / active_collaborators live on documents (schema.sql:152-158) and are covered by nothing else. The force-release rail added in 20260831/20260901 is a BEFORE UPDATE trigger on checkout_sessions only (20260831:99-102) — it never sees a write to documents.

**Failure scenario.** Any active member — a Viewer — issues `PATCH /rest/v1/documents?id=eq.<doc> {"checked_out_by": "<their own uid>", "checked_out_by_name": "me"}` with their own anon-key JWT. The lock badge now says they hold it, the real holder's checkout_sessions row is untouched and still active, and publish_revision's lock test (`v_doc.checked_out_by <> p_actor`) now passes for them. Conversely `{"checked_out_by": null}` frees a document the field engineer still has out, and the next person's CAS claim succeeds — two people editing the same drawing, each shown as the sole holder.

**Evidence.**

supabase/schema.sql:1068-1069:
```
CREATE POLICY "documents_org_access" ON documents FOR ALL
  USING (org_id IN (SELECT my_org_ids()));
```
with `my_org_ids()` (schema.sql:1031-1034) returning every org where the caller is an active member, regardless of role.

**Done when.**

- [ ] A RESTRICTIVE policy or BEFORE UPDATE trigger on documents rejects a change to checked_out_by / current_lock_id by anyone other than the row's current holder, a caller holding checkout.force_release, or the service role
- [ ] The same guard permits the legitimate transitions the lib performs: CAS claim on a null holder, transfer to the heir in finishMySession, and clear-on-last-out

---

<a id="dck-4"></a>

## DCK-4 · A failed lock-claim write is reported to the user as "you joined someone else's checkout", leaving an active session on a document that reads as free

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/CheckoutFlowModal.tsx:368-381`, `components/documents/CheckoutFlowModal.tsx:383-442`, `lib/checkoutEpisodes.ts:752-778`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: an ACL 'write' deny makes documents_deny_write_guard (RESTRICTIVE FOR UPDATE) filter the row out, so the update returns zero rows and NO error — indistinguishable from losing the CAS race. The join branch returns early (`setProcessing(false); return;`) without calling reconcileDocumentCheckoutState, leaving an active checkout_sessions row on a document whose checked_out_by is still NULL. Precondition (an ACL write-deny on the folder) narrows reachability but the swallowed-error/false-message mechanism is exactly as described.

**Mechanism.** The CAS lock claim destructures only `data`: `const { data: lockedRow } = await supabase.from("documents").update({...}).eq("id", ...).or(...).select("id").maybeSingle()`. A null lockedRow is treated as one thing only — "someone else holds the lock" — but null is also what you get when the write errors (an ACL deny under documents_deny_write_guard, a documents_guard_access rejection, a transport failure, or a RETURNING row the SELECT policy hides). The session row was already inserted and its error WAS checked (line 330), so it exists and is active. quickHold has the identical shape at lib/checkoutEpisodes.ts:752-764.

**Failure scenario.** An engineer whose role carries an ACL 'write' deny on a library folder checks out a drawing. The session insert succeeds (checkout_sessions has no such guard); the documents UPDATE is filtered out by documents_deny_write_guard. lockedRow is null, so the modal posts "X joined the checkout" to the thread, notifies the (nonexistent) other participants, writes a CHECK_OUT audit row with `joined: true`, and toasts "Joined an active checkout — someone else holds the lock. Coordinate before editing." No one holds the lock. documents.checked_out_by is still NULL, so CheckoutStatusCell renders "Check Out" and the next person claims it for real. Two active sessions, one lock, and the register says one of them joined a checkout that never existed.

**Evidence.**

components/documents/CheckoutFlowModal.tsx:368-381 — no `error` binding:
```
      const { data: lockedRow } = await supabase
        .from("documents")
        .update({ checked_out_by: currentUser.uid, ... })
        .eq("id", document.id!)
        .or(`checked_out_by.is.null,checked_out_by.eq.${currentUser.uid}`)
        .select("id")
        .maybeSingle();

      if (!lockedRow) {
        // Someone else holds the lock (they had it already, or won the race).
```

**Done when.**

- [ ] Both call sites destructure `error` and distinguish a genuine CAS miss (no error, no row) from a failed write (error present)
- [ ] On a failed write the session insert is rolled back or the user is told the checkout did not complete, rather than being told they joined
- [ ] quickHold at lib/checkoutEpisodes.ts:752-764 gets the same treatment — its "held"/"joined" return value carries the same ambiguity

---

<a id="dck-5"></a>

## DCK-5 · Force-release has two surfaces with two different audit behaviours — the Inspector path writes no audit row at all, and the popover path writes the FORCE_RELEASE record before the release is attempted

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/CheckoutStatusCell.tsx:191-236`, `components/documents/CheckoutStatusCell.tsx:206-217`, `app/(protected)/documents/[libraryId]/page.tsx:1186-1204`, `components/documents/InspectorPanel.tsx:765-773`, `lib/checkoutEpisodes.ts:602-682`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves verified. `grep -rn onForceUnlock` shows a single wiring, so there is no second audit-writing path for the Inspector drawer, and the popover's audit row is committed before the release is even attempted — a rejected or partially-failed release still leaves a FORCE_RELEASE record.

**Mechanism.** Two UI entry points call forceReleaseDocument, which itself writes no audit row (its doc comment at lib/checkoutEpisodes.ts:601 says "Callers write their own audit row"). CheckoutStatusCell's handleForceRelease does — but at lines 206-217, BEFORE calling forceReleaseDocument at 223, so an exception in the release leaves a FORCE_RELEASE audit row describing something that did not happen. The library page's handleForceUnlock (documents/[libraryId]/page.tsx:1186-1204), reached from the Inspector's "Force Release Lock" button (InspectorPanel.tsx:765-773), calls forceReleaseDocument and writes nothing — a grep for logCheckoutEvent/logAuditAction inside that function returns nothing, and the function body is only 18 lines. Neither surface captures a reason: forceReleaseDocument is called without `reason`, so released_reason falls back to the generated `Force released by ${actorName}` and the audit details carry only the victim's name and id.

**Failure scenario.** A DocCtrl force-releases a checked-out isometric from the Inspector drawer during a turnaround. The checkout ends, the episode is sealed as force_released, the holder is notified — and audit_logs contains no FORCE_RELEASE entry. Six weeks later, reconstructing why an unfinished as-built was released before the walkdown closed, the audit trail shows a CHECK_OUT with no corresponding release event and no stated reason anywhere. Under PSM records expectations that is an unexplained gap in the document's control history.

**Evidence.**

app/(protected)/documents/[libraryId]/page.tsx:1186-1204 in full — the whole handler, with no audit write:
```
  const handleForceUnlock = async (docRecord: DocumentRecord) => {
    if (!docRecord.id || !activeOrgId) return;
    if (!(await appConfirm({ ... }))) return;
    try {
      await forceReleaseDocument({
        orgId: activeOrgId, documentId: docRecord.id,
        actorUserId: uid ?? "unknown",
        actorName: userEmail?.split("@")[0] || "Admin",
      });
    } catch (e) { ... }
  };
```
CheckoutStatusCell.tsx:206 writes the audit first (`// 1. Audit Log`) and releases second (`// 2. Release everything`, line 223).

> **Verifier correction.** Minor overstatement: the Inspector path is not entirely traceless — forceReleaseDocument still posts the "SYSTEM ALERT: checkout force-released by X" thread message (lib/checkoutEpisodes.ts:653-658), closes the episode with close_reason 'force_released' (642-649), and emits the victim notification (665-680). What is missing there is the audit_logs row that /admin/audit and the activity feed read.

**Done when.**

- [ ] forceReleaseDocument writes the FORCE_RELEASE audit row itself, after the release succeeds, so both surfaces record identically and a failed release records nothing
- [ ] The confirm dialog collects a reason and it reaches both released_reason and the audit details
- [ ] The existing CheckoutStatusCell pre-write is removed so the event is not double-logged

---

<a id="dck-6"></a>

## DCK-6 · The documented DB backstop for the checkout lock does not exist — it was deliberately removed in 20260812 and never replaced, and documentGuards.ts still claims it is there

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/documentGuards.ts:10-18`, `supabase/migrations/20260713_document_publish_guard.sql:60-66`, `supabase/migrations/20260812_per_library_publish_authority.sql:133-146`, `supabase/migrations/20260816_owner_publish_access.sql:32-88`, `supabase/migrations/20260822_review_completion_guard.sql:21-96`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The factual claim is exactly right — I confirmed 20260822 is the newest redefinition and it has no lock branch (the hold branch survives, so the comment is only half-stale). Severity lowered to MEDIUM because the removal was an explicit, documented product decision, not an oversight, and the residual gap is reachable only by someone who already holds library publish authority or effective ownership (the trigger still enforces that) — i.e. exactly the population the app itself lets override the lock via DCK-8's override-with-reason path. What genuinely survives is a defense-in-depth loss plus a misleading source comment.

**Mechanism.** lib/documentGuards.ts:14-17 states: "A defense-in-depth Postgres trigger (see the matching migration) enforces the same rule at the DB layer for any path that bypasses the lib." The original 20260713 function did contain that rule (`IF OLD.checked_out_by IS NOT NULL AND OLD.checked_out_by::text <> v_actor::text THEN RAISE EXCEPTION`, lines 61-66). 20260812 recreated the function and dropped the check on purpose — its own comment at lines 133-136 says "We deliberately do NOT block on checked_out_by here." 20260816 and then 20260822 each recreated the function again, both without it. 20260822 is the last definition of enforce_document_publish_guard() in the tree, so the live trigger checks review completion, per-library publish authority and holds — and nothing about the lock. Four differently-shaped searches (grep for checked_out_by across migrations, grep for enforce_document_publish_guard, grep for DROP TRIGGER, and a full read of the 20260822 body) all agree.

**Failure scenario.** A drafter with `publish` on the library, or the document's effective owner, PATCHes documents.current_version_id directly through PostgREST with their own JWT while an isometric is checked out by the field engineer doing a walkdown. The trigger checks authority (passes), review completion (no roster, passes), and holds (none, passes) — and lets the promote through. The lib guard (evaluatePublishGuard) was never on the call path. The engineer's checkout stays open, they keep marking up a revision that is no longer current, and nothing in the DB refused the write.

**Evidence.**

20260822_review_completion_guard.sql:78-86 is the last check before `RETURN NEW` and reads holds only:
```
  SELECT EXISTS (
    SELECT 1 FROM document_holds h
     WHERE h.document_id = NEW.id AND h.released_at IS NULL
  ) INTO v_has_hold;
```
Compare 20260713_document_publish_guard.sql:60-66 which had:
```
  -- Block: checked out by someone other than the actor.
  IF OLD.checked_out_by IS NOT NULL
     AND OLD.checked_out_by::text <> v_actor::text THEN
    RAISE EXCEPTION 'Document is checked out by another user; ...'
```

> **Verifier correction.** Overstated as CRITICAL. Two mitigations the finding under-weights: (1) the trigger still blocks the publish itself for anyone without per-library publish authority or effective ownership (20260822:69-76), so the lock bypass is only reachable by someone already authorized to publish; (2) a second DB-layer lock check does exist in the transactional RPC — 20260823_publish_contract.sql:177-184 and its successor 20260828_integrity_hardening.sql:94-101 both test `v_doc.checked_out_by ... <> p_actor` before writing. So it is the TRIGGER backstop, not all DB enforcement, that is gone. The live defect is a stale comment plus a lost defense-in-depth layer for direct `documents` UPDATEs by authorized publishers.

**Done when.**

- [ ] lib/documentGuards.ts:10-18 no longer claims a DB trigger enforces the lock, OR the lock check is restored in a new migration that recreates enforce_document_publish_guard() with the 20260822 body plus the checked_out_by test
- [ ] If restored, the restored check honors the same override semantics the app uses (publisher-with-reason passes, hold never passes) so the override-with-note flow does not start failing at the DB

---

<a id="dck-7"></a>

## DCK-7 · The expiry sweep runs from the browser on every library and /checkouts page load, swallows the rejection when it cannot release other people's sessions, and sends "your checkout auto-released" notifications regardless

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:1032-1122`, `lib/projects.ts:1059-1078`, `lib/projects.ts:1104-1117`, `app/(protected)/checkouts/page.tsx:64`, `app/(protected)/documents/[libraryId]/page.tsx:352-355`, `supabase/migrations/20260901_db_hard_enforcement.sql:109-121`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. All three mechanics confirmed, including that `.in("id", ids)` is one statement so a single guard rejection aborts the batch and the sweeper's own expired hold survives too. Lowered to MEDIUM because the finding's "forever" overstates it: app/api/cron/maintenance/route.ts runs the same sweep nightly with a service-role client, and the guard's first line is `IF auth.uid() IS NULL THEN RETURN NEW; END IF;` — so the stuck sessions and the duplicate notifications are bounded by ≤24h, not permanent.

**Mechanism.** autoReleaseExpiredAdHoc selects every expired ad-hoc session in the org, then issues one UPDATE across all of them by id. When that UPDATE fails for a reason other than the missing outcome columns, the failure is only `console.warn("[autoReleaseExpiredAdHoc] sweep update failed", sweepErr)` (line 1076) and execution continues. Since 20260901, enforce_checkout_release_guard raises on any status change to a session whose user_id is not the caller unless they hold checkout.force_release — and a BEFORE-trigger RAISE aborts the whole statement, so a batch containing one other person's session releases nobody's, including the caller's own. The function then runs reconcile per document (which correctly does nothing, the sessions are still active) and finally inserts a notifications row for every session in the batch (1104-1117) with title "Your ad-hoc checkout auto-released" — built from the pre-update `data`, never from what was actually released. It is invoked with the RLS browser client on /checkouts load (checkouts/page.tsx:64) and on every library page mount (documents/[libraryId]/page.tsx:354).

**Failure scenario.** A drafter opens a library page. The sweep finds four expired quick-holds, three of them other people's. The trigger rejects the batch; nothing is released; the drafter's own expired hold also survives. Four people are told their checkout auto-released — and it is re-sent on every page load, forever, because the sessions never leave status='active'. Meanwhile the actual enforcement is deferred to the 03:00 cron, whose service-role client is exempt — so the daily cron quietly cleans up what the page-load path has been lying about all day.

**Evidence.**

lib/projects.ts:1071-1078:
```
    if (sweepErr) {
      const { isMissingOutcomeSchema } = await import("@/lib/checkoutEpisodes");
      if (isMissingOutcomeSchema(sweepErr)) {
        await db.from("checkout_sessions").update(basePayload).in("id", ids).eq("status", "active");
      } else {
        console.warn("[autoReleaseExpiredAdHoc] sweep update failed", sweepErr);
      }
    }
```
and lib/projects.ts:1116: `if (inserts.length > 0) await db.from("notifications").insert(inserts);` — built from `data`, the pre-update selection.

**Done when.**

- [ ] The client-side sweep either scopes itself to the caller's own sessions (`.eq("user_id", uid)`) or is removed in favour of the cron, so it cannot fail wholesale on other people's rows
- [ ] The notification insert is driven by the rows the UPDATE actually changed (a `.select()` on the update), not by the pre-update selection
- [ ] A non-missing-schema sweep error surfaces somewhere a human sees it, rather than console.warn on a page the user is not looking at

---

<a id="dck-8"></a>

## DCK-8 · The transactional publish's lock check is switched off by a client-supplied boolean — p_override_lock is passed straight from the browser with no reason, no authority test, and no audit

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260828_integrity_hardening.sql:39-101`, `lib/revisions.ts:539-547`, `lib/revisions.ts:239-257`, `components/documents/RevUpModal.tsx:258-263`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The bypass is real: a hand-crafted `POST /rest/v1/rpc/publish_revision` with p_override_lock:true skips the lock with no recorded reason and no audit row. Lowered to MEDIUM because "no authority test" overstates it — the RPC's `UPDATE documents SET current_version_id = ...` still fires trg_document_publish_guard (SECURITY DEFINER does not change auth.uid()), which rejects anyone lacking per-library publish authority or effective ownership. The genuine defect is accountability (missing reason + missing audit for a lock override), not unauthorized publishing.

**Mechanism.** publish_revision is the last server-side place the checkout lock is checked (20260828:94-101). Its test is `AND NOT (p_override_lock OR (p_force AND v_is_controller))` — p_force is correctly re-derived against org_members inside the function, but p_override_lock is a plain DEFAULT FALSE parameter that the function never validates: it does not require a reason, does not check role, does not record why. lib/revisions.ts:544 passes `p_override_lock: lockedByOther` — the app enforces the "a reason is required" rule earlier, in authorizePublish (lib/revisions.ts:239-243) and in RevUpModal (258-263), both of which run in the browser. Because publish_revision is exposed through PostgREST /rpc, the parameter is caller-controlled. With the publish-guard trigger's lock check also gone (see the 20260812 finding), nothing at the DB stops a lock override once this flag is set.

**Failure scenario.** A drafter with library publish authority calls `POST /rest/v1/rpc/publish_revision` with `p_override_lock: true` and no override reason while the process engineer holds the drawing for an As-Built walkdown. The RPC skips the lock branch, promotes the new version, and returns 'published'. Because the call never went through revUpDocument, noteOverrideOnHolder (lib/revisions.ts:264-300) never runs: no system message on the engineer's episode thread, no revision_published_over_checkout notification, no record anywhere that a lock was overridden. The engineer keeps working from a superseded rev and finds out at publish time.

**Evidence.**

supabase/migrations/20260828_integrity_hardening.sql:51 and 94-101:
```
  p_override_lock BOOLEAN DEFAULT FALSE -- authorized publisher's checkout-override: passes the LOCK, never a hold
...
  IF v_doc.checked_out_by IS NOT NULL
     AND v_doc.checked_out_by::text <> p_actor::text
     AND NOT (p_override_lock OR (p_force AND v_is_controller)) THEN
```
lib/revisions.ts:544: `p_override_lock: lockedByOther,`

> **Verifier correction.** Overstated as CRITICAL. A direct PostgREST caller setting p_override_lock still has to get the promote past trg_document_publish_guard, which re-checks per-library publish authority / effective ownership against auth.uid() (20260822:69-76) — so the bypass is available only to someone already authorized to publish this document; what they skip is the reason + holder-notification courtesy, not the authority gate. Note the same signature has a strictly larger sibling problem the finding does not mention: p_actor is caller-supplied and never compared to auth.uid(), so the lock test can also be defeated by passing the holder's uid. Also worth recording: publish_revision is SECURITY DEFINER with no `SET search_path` (no match for `SET search_path` anywhere in 20260828).

**Done when.**

- [ ] publish_revision takes the override REASON (not a boolean) and rejects a blank/short one, so the override cannot be asserted without stating why
- [ ] The function records the override itself — an audit_logs row or a checkout_messages system row written inside the transaction — so an override that bypasses the app still appears on the document's record
- [ ] publish_revision re-derives override eligibility from org_members / library authority rather than trusting the caller

---

<a id="dck-9"></a>

## DCK-9 · Three of the five release paths leave the check-in register blank or write an audit action nothing renders — the "every check-in records what came of it" contract holds only for the modal

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/StaleCheckoutBanner.tsx:75-96`, `lib/projects.ts:388-414`, `lib/projects.ts:1059-1078`, `lib/timeline.ts:256-268`, `app/(protected)/activity/page.tsx:195`, `supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql:18-29`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The load-bearing half is correct: three release paths write no outcome, so the register line is blank, and CHECKOUT_RELEASED has zero readers. Lowered to MEDIUM because "an audit action nothing renders" is overstated — lib/timeline.ts:296 `default: return r.action.replace(/_/g, " ").toLowerCase();` does render it as "checkout released"; the defect is that it is mis-bucketed in the activity pulse, not invisible. Also note lib/projects.ts:1068 (the sweep, one of the cited locations) *does* write `outcome: "auto_released"`, so the count of genuinely-blank paths is stale-banner / project-bulk / force-release.

**Mechanism.** 20261012 declares the register: "every deliberate check-in records WHAT CAME OF IT, not just that it ended". CheckInPanel, the popover's one-click release and MyDeskPanel all honour it (they pass an `outcome` to finishMySession). Three paths do not. (a) StaleCheckoutBanner.release updates the session row directly with no outcome and no user_id/status predicate (`.eq("id", row.id)` only), then writes `action: "CHECKOUT_RELEASED"` — a string that appears nowhere else in the codebase: two searches (grep CHECKOUT_RELEASED across the tree; grep the CHECK_OUT/CHECK_IN/FORCE_RELEASE renderer maps) show it is absent from lib/timeline.ts:256-268, from the activity page's lock bucket at activity/page.tsx:195, from admin/audit's ACTION_META, and from TimelineFeed. (b) releaseAllCheckoutsForProject (lib/projects.ts:388-414) ends every session on project completion with no outcome and no audit row at all, discarding the update's error. (c) The expiry sweep sets outcome 'auto_released' on the session but writes no audit row either.

**Failure scenario.** A drawing is checked out, then released from the stale-checkout banner. checkout_sessions.outcome is NULL, so CheckoutHistoryPanel renders no register line for the session. audit_logs gets CHECKOUT_RELEASED, which the activity page does not count as a lock event and the timeline renders through its `default:` fallback as the lowercase string "checkout released". The document's control history shows a CHECK_OUT with no recognised check-in — the exact "hole in the story" CheckoutFlowModal.tsx:419-420 says the join path was added to prevent.

**Evidence.**

components/projects/StaleCheckoutBanner.tsx:75-88:
```
      const { error } = await supabase.from("checkout_sessions").update({
        status: "checked_in", ended_at: now, released_at: now,
        released_by: userId,
        released_reason: "User released from stale-checkout banner",
      }).eq("id", row.id);
      if (error) throw new Error(error.message);
      await supabase.from("audit_logs").insert({
        action: "CHECKOUT_RELEASED",
```
lib/timeline.ts:260-268 lists CHECK_OUT / CHECK_IN / DOCUMENT_CHECKOUT / DOCUMENT_CHECKIN / ABANDON / JOIN / FORCE_RELEASE and nothing else.

> **Verifier correction.** Two corrections. First, "nothing renders" is too strong: both renderers have generic fallbacks — activity/page.tsx:264 `const verb = meta?.verb ?? r.action.toLowerCase().replace(/_/g, " ")` and lib/timeline.ts:295 `default: return r.action.replace(/_/g, " ").toLowerCase()` — so a CHECKOUT_RELEASED row appears as "checkout released" with a generic Activity icon; what it is genuinely excluded from is the lock-category count (activity/page.tsx:195) and the checkout vocabulary. Second, the missing user_id/status predicate on the banner's update is not an authority hole: listStaleCheckoutsForUser scopes rows to the current user (StaleCheckoutBanner.tsx:44-47), so `.eq("id", row.id)` only risks re-stamping an already-closed row.

**Done when.**

- [ ] StaleCheckoutBanner releases through finishMySession with an explicit outcome (all_clear) and logs CHECK_IN via logCheckoutEvent, dropping the unrecognised CHECKOUT_RELEASED action
- [ ] releaseAllCheckoutsForProject records an outcome per session and writes a CHECK_IN audit row per document, and stops discarding its update error
- [ ] The expiry sweep writes a CHECK_IN (or ABANDON) audit row so an auto-release is visible in the document's history, not only in a notification

---

<a id="dck-10"></a>

## DCK-10 · forceReleaseDocument ignores the error from the session-ending write, then clears the lock unconditionally — a rejected force-release still frees the document while every session stays active

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checkoutEpisodes.ts:602-682`, `lib/checkoutEpisodes.ts:616-626`, `lib/checkoutEpisodes.ts:630-640`, `supabase/migrations/20260901_db_hard_enforcement.sql:109-121`, `components/documents/CheckoutStatusCell.tsx:238`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified the documents UPDATE is not itself blocked: documents_org_access permits any org member, documents_deny_write_guard only bites on ACL denies, and neither trg_document_publish_guard (current_version_id/status only) nor documents_guard_access (visibility/acl only) fires on lock columns. So the sessions stay active while the lock is cleared. The premise also holds — capabilityPolicy.ts:89-91 marks checkout.force_release critical (Admin unremovable) but DocCtrl can be narrowed out, while CheckoutStatusCell.tsx:238 still shows the button on a hardcoded role check.

**Mechanism.** supabase-js resolves with {error} rather than throwing. forceReleaseDocument's first write — the one that ends everyone's session — discards the result entirely (no destructuring at all, lines 616-626). The function then unconditionally clears documents.checked_out_by / current_lock_id / active_collaborators (630-640, no CAS, no error check), closes the episode with close_reason 'force_released', posts "SYSTEM ALERT: checkout force-released" to the thread, and emits the victim notifications. Since 20260901 the session write is guarded by enforce_checkout_release_guard, which raises unless the actor holds the checkout.force_release capability. The UI gate is the hardcoded `userRole === 'Admin' || userRole === 'DocCtrl'` (CheckoutStatusCell.tsx:238), which is not the same predicate as the DB's org_capability_allows.

**Failure scenario.** An admin narrows checkout.force_release to ["Admin"] in Admin → Permissions (a supported, advertised action — capabilityPolicy.ts:89 says "widen or narrow freely"). A DocCtrl still sees the Force Release button, confirms the dialog, and the sessions UPDATE is rejected by the trigger. The error is dropped on the floor; the lock columns are cleared anyway, the episode is sealed as force_released, and the holders receive "Your checkout was force-released". Result: the drawing reads FREE and unlocked in every list while three checkout_sessions rows are still status='active', their episode is closed, and their thread posts will no longer be episode-tagged. The next person checks it out cleanly and two crews edit in parallel.

**Evidence.**

lib/checkoutEpisodes.ts:616-626 — the result is never captured:
```
  await supabase
    .from("checkout_sessions")
    .update({
      status: "checked_in", ended_at: now, released_at: now,
      released_by: input.actorUserId,
      released_reason: input.reason ?? `Force released by ${input.actorName}`,
    })
    .eq("document_id", input.documentId)
    .eq("status", "active");
```
followed immediately at 630-640 by the unconditional documents clear.

> **Verifier correction.** Worth stating for the fixer: with the DEFAULT capability policy (checkout.force_release defaultRoles ['Admin','DocCtrl'], lib/capabilityPolicy.ts:89-91) the UI gate and the DB gate agree, so the divergence bites when an org narrows the policy, when a member holds Admin/DocCtrl only through the additive roles[] array (is_org_controller honors roles[] at 20260814:38, the UI does not), or on any transient/RLS write failure. The code defect — discarded error then unconditional clear — is unconditional.

**Done when.**

- [ ] The session-ending update's error is checked and thrown before any documents column is touched, so a rejected force-release changes nothing
- [ ] The document clear is ordered after (and conditional on) the session write succeeding, or the whole operation moves into a single RPC
- [ ] The force-release UI gate reads the same checkout.force_release capability the DB enforces instead of a hardcoded role pair

---

<a id="dck-11"></a>

## DCK-11 · A single undefined-column error anywhere in the checkout path permanently disables episodes for the whole process, silently detaching new sessions and thread messages from the register

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/checkoutEpisodes.ts:130-142`, `lib/checkoutEpisodes.ts:155-168`, `lib/checkoutEpisodes.ts:380-392`, `lib/checkoutEpisodes.ts:206`, `lib/checkoutEpisodes.ts:264`, `app/api/cron/maintenance/route.ts:27`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the flag is a process/tab-lifetime latch with no production reset path, and the error classifier is over-broad (a bare 42703/PGRST204 for any column trips it). After it flips, ensureActiveEpisode returns null, new sessions get no episode_id and postEpisodeSystemMessage drops the episode tag, silently detaching everything from the register.

**Mechanism.** isMissingEpisodeSchema returns true for ANY error carrying code 42703 (undefined_column), 42P01, PGRST204 or PGRST205 — the message-based check at lines 138-141 is an OR alternative, not an additional requirement, so a bare code match short-circuits at line 137 regardless of which table or column the error is actually about. Every episode helper that hits that branch sets the module-level `let episodeSchemaMissing = true` (line 157), which is never cleared except by the exported test hook resetEpisodeSchemaFlag. From then on getActiveEpisode returns null, ensureActiveEpisode returns null, listEpisodesForDocument returns [], and postEpisodeSystemMessage strips episode_id — all silently, by design ("Pre-migration tolerance", lines 27-29). The flag lives in module scope, so on the server it is shared across the whole Node process; the maintenance cron imports this module transitively and runs reconcile against every org.

**Failure scenario.** A future migration adds or renames a column and one checkout_messages insert comes back PGRST204 for an unrelated field. episodeSchemaMissing flips. Every subsequent checkout in that browser tab (or, server-side, every request handled by that process) creates sessions with no episode_id and posts thread messages with no episode_id, on a database where checkout_episodes is perfectly healthy. Those sessions and messages are invisible in CheckoutHistoryPanel's per-episode register and fall into the "Earlier activity" legacy bucket forever — a permanent, silent hole in the checkout record with no error surfaced to anyone.

**Evidence.**

lib/checkoutEpisodes.ts:136-141:
```
  // 42P01 undefined_table / 42703 undefined_column (raw PG);
  // PGRST204 unknown column, PGRST205 unknown table (PostgREST schema cache).
  if (code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205") return true;
  return (
    (msg.includes("checkout_episodes") || msg.includes("episode_id")) &&
    ...
```
lib/checkoutEpisodes.ts:155-157:
```
// Once we know the schema is missing we stop retrying for the session —
let episodeSchemaMissing = false;
```

> **Verifier correction.** "Anywhere in the checkout path" is overstated. The flag is set at only five sites (206, 264, 328, 354's inverse, 385-386), and four of them evaluate errors returned by queries against checkout_episodes itself, where a 42703/PGRST204 genuinely does mean the episode schema. The one genuine cross-table case is postEpisodeSystemMessage (380-392), which runs isMissingEpisodeSchema over an error from an INSERT into checkout_messages — an undefined column there (e.g. `kind` or `lock_id`) would flip the episodes flag for the whole process. Keep SUSPECTED: nothing in the repo shows such an error actually occurring.

**Done when.**

- [ ] The bare-code short-circuit is removed: a code match must ALSO name checkout_episodes or episode_id before the flag is set
- [ ] The flag is scoped per client/request rather than per module, or is time-boxed so it re-probes instead of latching for the process lifetime
- [ ] Flipping the flag emits something visible (a console.error plus a one-time toast or server log) rather than degrading silently

---

<a id="dck-12"></a>

## DCK-12 · The check-in outcome register — the walkdown attestation trail the MOC gate feeds — has exactly one reader and answers none of the questions its migration was written for

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql:47-51`, `components/documents/CheckoutHistoryPanel.tsx:148-151`, `components/documents/CheckInPanel.tsx:337-349`, `lib/checkinOutcomes.ts:110-120`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. No query in the tree filters or orders by `outcome`, so the index built for "who last verified this?" has no user; outcome_ref is write-only. The only nuance: lib/projectExport.ts:41 and lib/inbox.ts:144 do `select("*")` on checkout_sessions, so the columns leave the system in a raw project dump — neither reads or renders them, which does not change the finding.

**Mechanism.** 20261012 adds `checkout_sessions_outcome_idx ON checkout_sessions (document_id, outcome) WHERE outcome IS NOT NULL` and justifies it at lines 47-48: "Field-verification attestations and outcome reporting query by document + outcome ('who last verified this P&ID against the field?')". Two differently-shaped searches — grep for `outcome`/`outcome_note`/`outcome_ref` across lib+app+components, and a targeted grep for `.eq("outcome"` / `select(...outcome...)` — find no query that filters or aggregates on it. The single reader is CheckoutHistoryPanel.tsx:150, which does `select("*")` on a chosen episode and maps `r.outcome` into a collapsed history row. The parallel audit-side record, `action: "FIELD_VERIFIED"` (CheckInPanel.tsx:339), likewise has no consumer: it is absent from lib/timeline.ts's summarizeAudit switch, from admin/audit's ACTION_META, and from TimelineFeed's icon map, so it renders only through timeline.ts's `default: return r.action.replace(/_/g, " ").toLowerCase()` fallback as "field verified", with no rev, no date framing, and no place on the document card.

**Failure scenario.** A field engineer completes an As-Built walkdown and records "Field matches — verified" against Rev 4 — the card whose hint promises "This is the drawing's accuracy record" (lib/checkinOutcomes.ts:115). To answer "when was P-101-ISO-004 last verified against the field, and against which revision?" — the question a PSI accuracy programme is built on — there is no screen, no report, and no query. The answer exists in two places (a session row and an audit row) and is reachable only by opening the document, expanding Checkout History, and expanding the right episode by hand.

**Evidence.**

supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql:47-51:
```
-- Field-verification attestations and outcome reporting query by document +
-- outcome ("who last verified this P&ID against the field?").
CREATE INDEX IF NOT EXISTS checkout_sessions_outcome_idx
  ON checkout_sessions (document_id, outcome)
  WHERE outcome IS NOT NULL;
```
The only consumer, components/documents/CheckoutHistoryPanel.tsx:150: `outcome: (r.outcome as string | null) ?? null,` inside a `select("*")` scoped to one episode.

> **Verifier correction.** HIGH is too high for a reporting/dead-index gap with no safety or authority consequence. The attestation is not lost — it is durably recorded on the session row and does surface, per-episode, in the Checkout History panel (with a label from OUTCOME_LABEL, CheckoutHistoryPanel.tsx:293-297). What is missing is any cross-document query, so the index is unused and the "who last verified this P&ID" question has no answer surface. MEDIUM.

**Done when.**

- [ ] A query exists that reads the index as intended — last field_verified per document with its rev and date — and it is surfaced where the drawing is looked at (document card / register), not only inside an expanded episode
- [ ] FIELD_VERIFIED is added to the audit renderer maps (timeline.ts summarizeAudit, admin/audit ACTION_META, TimelineFeed) so the attestation is legible in the history it is written to
- [ ] Either the index earns its keep through a real reader, or it and the parallel audit write are consolidated to one record

---

<a id="dck-13"></a>

## DCK-13 · The checkout.force_release capability is defined, editable and DB-enforced, but no checkout surface reads it — the buttons are gated on hardcoded ["Admin","DocCtrl"]

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/capabilityPolicy.ts:41`, `lib/capabilityPolicy.ts:89-91`, `supabase/migrations/20260901_db_hard_enforcement.sql:109-121`, `components/documents/CheckoutStatusCell.tsx:238`, `components/documents/InspectorPanel.tsx:156`, `lib/documentGuards.ts:61`, `lib/holds.ts:88-101`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the contrast the finding draws is real: lib/holds.ts:86-105 has assertHoldCapability calling `policyAllows(policy, cap, role, extra, uid)` for holds.open/holds.release, so the pattern exists and was simply never applied to the checkout surfaces. Both the widening (delegation inert) and narrowing (button still shown, DB rejects — which is DCK-10's swallowed error) failures follow directly.

**Mechanism.** 20260901 rewired enforce_checkout_release_guard to consult org_capability_allows(org, 'checkout.force_release', uid), and capabilityPolicy.ts:89-91 advertises it: "Enforced at the database, which reads this policy — widen or narrow freely." But two searches (grep for checkout.force_release / force_release across lib+app+components; grep -l for files importing capabilityPolicy) show the consumers are workflow.ts, holds.ts, the two admin pages, the requests page, the workflow-action route, and the two permissions components — lib/checkoutEpisodes.ts is not among them. holds.ts does it correctly (loadCapabilityPolicy + policyAllows at 88-101); the checkout surfaces do not. CheckoutStatusCell.tsx:238 is `const canAdmin = userRole === 'Admin' || userRole === 'DocCtrl';` and InspectorPanel.tsx:156 is `const isController = activeRole === 'Admin' || activeRole === 'DocCtrl';`. lib/documentGuards.ts:61 carries the same hardcoded pair for the publish force path. Both UI predicates read a single primary role, while the DB's is_org_controller (20260814:38) also honours the additive `roles[]` array.

**Failure scenario.** Two symmetrical failures. Widening: an admin delegates checkout.force_release to the Drafting Supervisor so a stuck lock can be cleared without paging DocCtrl. The DB now permits it; no button ever appears, so the delegation is inert and the admin believes it took effect. Narrowing: an admin removes DocCtrl from the capability; the button still renders for every DocCtrl and clicking it produces the silent half-release described in the forceReleaseDocument finding. Separately, a user holding DocCtrl only as a secondary role in `roles[]` is allowed by the DB and shown nothing by the UI.

**Evidence.**

components/documents/CheckoutStatusCell.tsx:238: `const canAdmin = userRole === 'Admin' || userRole === 'DocCtrl';`
against supabase/migrations/20260901_db_hard_enforcement.sql:113-117:
```
  IF OLD.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status
     AND OLD.user_id::text <> auth.uid()::text
     AND NOT org_capability_allows(OLD.org_id, 'checkout.force_release', auth.uid()) THEN
```
and lib/holds.ts:88-101, which shows the pattern the checkout surfaces should follow.

**Done when.**

- [ ] CheckoutStatusCell and InspectorPanel gate the force-release button on policyAllows(policy, 'checkout.force_release', ...) — the same evaluator holds.ts uses — instead of a hardcoded role pair
- [ ] The predicate honours additive roles[] the way is_org_controller does, so UI and DB agree on who is a controller
- [ ] lib/documentGuards.ts:61's CONTROLLER_ROLES set is sourced from the same vocabulary rather than a literal in application code

---

<a id="dck-14"></a>

## DCK-14 · checkout_episodes is updatable by any active org member, so a "sealed history record" can be rewritten or reopened, and a check-in race can seal an episode that still has live sessions

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260729_checkout_episodes.sql:85-92`, `supabase/schema.sql:1103-1104`, `lib/checkoutEpisodes.ts:334-355`, `lib/checkoutEpisodes.ts:485-539`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves hold. The RLS gap lets any active member PATCH a closed episode's status/close_reason/closed_by — the 'sealed record' has no immutability at the DB. And the race is asymmetric exactly as described: the documents update is protected by a CAS filter, the episode close is not, so an episode can be sealed 'checked_in' while a newcomer's session is still active on the same document.

**Mechanism.** Two things compound. (1) The RLS side: checkout_episodes_org_update is `FOR UPDATE USING (org_id IN (SELECT my_org_ids()))` with no WITH CHECK and no column restriction, so any active member may rewrite closed_at / closed_by / closed_by_name / close_reason / seq on a CLOSED episode, or flip status back to 'active'. The migration's comment (20260729:85-87) justifies the breadth for closing, but the table is described as "a sealed history record (participants, who/why, chat log, revisions published in its window)" (lib/checkoutEpisodes.ts:14-16) — sealed is not what the policy provides. (2) The application side: finishMySession computes the transition from a session list fetched at step 2 (line 485) and, in the "close" branch, calls closeEpisode unconditionally at 526-532. Its CAS is `.eq("status", "active")` — it guards against double-closing, not against a racer who joined the episode after the fetch. The documents clear immediately above it IS guarded (`.or(checked_out_by.is.null,checked_out_by.eq.${userId})`, line 524), so the two writes can disagree.

**Failure scenario.** Race: the last collaborator clicks Release at the moment a second engineer completes a checkout. ensureActiveEpisode hands the newcomer the same episode; the leaver's session fetch predates the newcomer's insert, so the transition is "close". The documents update is correctly skipped (the newcomer now holds the lock), but closeEpisode runs and seals the episode while the newcomer's session is active. Their thread posts stop being episode-tagged (postEpisodeSystemMessage resolves a null active episode), their session disappears from the register into the "Earlier activity" bucket, and the thread shows "everyone is done, checkout closed" over a live checkout.

**Evidence.**

supabase/migrations/20260729_checkout_episodes.sql:88-92:
```
DROP POLICY IF EXISTS checkout_episodes_org_update ON checkout_episodes;
CREATE POLICY checkout_episodes_org_update ON checkout_episodes FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = checkout_episodes.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
```
lib/checkoutEpisodes.ts:525-533 — closeEpisode runs even when the guarded documents update above it matched nothing.

**Done when.**

- [ ] A closed episode is immutable to non-service-role writers: a RESTRICTIVE policy or trigger rejects UPDATE when OLD.status = 'closed'
- [ ] closeEpisode is conditional on the same evidence the documents clear is conditional on — e.g. it re-reads active sessions inside the close, or the close and the lock clear move into one RPC
- [ ] A close that finds live sessions reconciles instead of sealing

---
