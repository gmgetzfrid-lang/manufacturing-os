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
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 5).** Confirmed, then enforced where the write happens (`20261031_dc_phase5_moc_gate.sql` re-creates `publish_revision`, byte-identical to the live 20261019 definition except one inserted block):
- **The gate (done-when 1):** a `content` publish of a document whose effective `doc_class` — resolved document → folder → library inside the RPC — is `'drawing'` requires a real `moc_reference` (≥3 chars). This binds every rev-up AND every revert (both go through `publish_revision`), including a direct RPC call by any member.
- **Server-side exemption (done-when 2):** Minor/Correction stays the documented escape hatch, but the decision runs in the RPC against the declared `change_type`. A client that lies about change type now records a false declaration on the version row (audit-visible) instead of bypassing an unchecked gate.
- **Revert is never minor-like (done-when 3, first half):** `revertToVersion` hardcodes `change_type: 'Correction'` (`lib/revisions.ts:1173`) — a naive exemption would have waived every revert. The gate treats `reverted_from_version_id IS NOT NULL` as a real change, always. The revert modal already collects an MOC reference; its placeholder now says it is required for drawings.
- **Supersede (done-when 3, second half):** `supersedeDocument` flips `documents.status` directly with no version payload, so its gate is app-side — it resolves the effective class via `effectiveDocClassForDocument` and refuses a drawing-class supersession without an MOC reference (class-unresolvable environments do not block).
- **Deliberate scope limits, recorded:** only a DECLARED drawing is gated at the DB — the client keeps prompting for unclassified documents, but hard-failing every legacy org's publishes (most rows predate `20261012`'s `doc_class` columns) would be a DEC-30 two-worlds regression. On a pre-20261012 database the class lookup catches `undefined_column` and no-ops rather than 42703-ing every content publish.
- Files: `supabase/migrations/20261031_dc_phase5_moc_gate.sql`, `lib/revisions.ts` (`supersedeDocument`), `components/documents/RevertConfirmModal.tsx`
- Tests: `lib/__tests__/mocGateMigration.test.ts` — the gate, the cascade, revert-never-minor, pre-migration tolerance, and the search_path pin.
- **Applied & verified live 2026-08-24:** `20261031` (probe: the gate text present in the live function, search_path still pinned; the Phase-4 reconciliation re-assert returned clean).
- **What this brought to light:** the verifier's note that `publish_revision` gates only on membership (never per-library publish authority) remains true and is NOT this finding — the publish-authority check lives in the `enforce_document_publish_guard` trigger, which the RPC's promote fires with the caller's `auth.uid()`, so authority IS enforced transactionally at promote time; a branch publish (never promoted) is the residual soft spot, tracked under the RG/REV family.

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
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced against `ba7bfcb`: `components/documents/CheckoutFlowModal.tsx` destructured only `data` from the CAS claim and `lib/checkoutEpisodes.ts` `quickHold` did the same, so a REFUSED write (an ACL write deny under `documents_deny_write_guard`, an RLS filter, a transport error) read as "someone else holds the lock". Fixed at the seam both sites share: `classifyLockClaim(result)` in `lib/checkoutEpisodes.ts` returns `held` / `joined` / `failed` (an error wins over any row), and `abortFailedLockClaim` rolls a failed attempt back — the session row this attempt opened is ended (`status = checked_in`, `released_reason = "Checkout did not complete — the lock claim failed"`, keyed by the inserted id) and the episode this attempt CREATED is sealed as `reconciled` (best-effort; a stray active episode is harmless — the next checkout joins it). Both call sites now read the full `{ data, error }`: on `failed` they roll back and throw `"The checkout did not complete — the lock could not be claimed: <db error>"`, which the modal toasts as "Checkout failed" — no "joined the checkout" thread line, no join notification to the crew, no `CHECK_OUT{joined:true}` audit row, no "Joined an active checkout" toast. A genuine CAS miss (no error, no row) still joins exactly as before. The CAS predicate itself (`checked_out_by IS NULL OR = me`) and the insert-then-reselect episode race path are untouched (Report 01 substrate). Review fix (Round F review, minor): the rollback left the `document_intents` row (`kind: edit`, `source: checkout`) that `recordIntent` had upserted for the new session, so overlap banners kept naming a phantom editor. `abortFailedLockClaim` now takes `documentId` and, after the session row is ended, calls `endMyIntents({ documentId, userId, sources: ["checkout"] })` best-effort (the intent's conflict key is `(document, user, kind, source)`, so the row the upsert wrote a moment earlier IS this session's); both call sites keep the `recordIntent` promise (`intentWrite`) and await it before the rollback so the delete does not race the upsert. Review fix (Round F review, BLOCKER): the first landing settled the verdict on the error binding alone, and the mechanism this finding was VERIFIED on carries no error — `documents_deny_write_guard` is `AS RESTRICTIVE FOR UPDATE USING (…)` (`20260901_db_hard_enforcement.sql`), so an ACL write deny makes PostgREST answer with ZERO ROWS AND NO ERROR, byte-identical to a lost CAS race; that case still read "joined". The verdict is now settled on EVIDENCE: `resolveLockClaim({ claim, documentId, userId })` (one shared async helper in `lib/checkoutEpisodes.ts`, used by `quickHold` and the modal) keeps `held` (a row) and `failed` (an error) as before, and on no-row/no-error RE-READS `documents.checked_out_by` (a member SELECT, visible under the permissive read policy): another user's id there means someone really holds the lock → `joined`; NULL or the caller's own id (the CAS predicate would have matched — the write was filtered), an unreadable row, or a read error → `failed`, with `detail` "the write was refused without an error (nobody else holds the lock) — check your access on this folder". Both call sites roll back and throw on that verdict exactly as for an error-bearing refusal. Cost: one SELECT, only on the no-row branch.
- Files: `lib/checkoutEpisodes.ts` (`classifyLockClaim`, `resolveLockClaim`, `abortFailedLockClaim`, `quickHold`), `components/documents/CheckoutFlowModal.tsx`
- Tests: `lib/__tests__/checkoutRoundF.test.ts` — "DCK-4": the pure verdict; `resolveLockClaim` (row → held and error → failed with no re-read; `checked_out_by = other` → joined; NULL / own id / no row / read error → failed); `quickHold` under an error-bearing refusal AND under the confirmed no-error filter (`documents` row with `checked_out_by: null`, CAS answers no row) — both roll back `checkout_sessions-2`, seal the episode they opened, post no "joined", end the checkout-sourced intent and throw; a no-row claim with ANOTHER user's id in `checked_out_by` is the genuine join and keeps its intent; source pins that the modal settles its claim through `resolveLockClaim` (no bare `classifyLockClaim`), waits for the intent write and passes `documentId` into the rollback.

**Done-when.**
- ✓ Both call sites read the full `{ data, error }` and settle a no-row answer on the re-read holder: another user's id → `joined`; NULL / own id / unreadable → `failed` (the RESTRICTIVE-policy filter that yields no error is the case this closes); an error → `failed`.
- ✓ On a failed write — error-bearing or filtered — the session insert is rolled back (ended, with the honest reason), its edit intent ended, AND the user is told the checkout did not complete with why — never "you joined".
- ✓ `quickHold` gets the same treatment through the same two helpers; its `"held" | "joined"` return is now derived from the verdict and it throws on `failed`.

**Scope / residual.** The rollback is a second write under the same RLS session; if the session UPDATE is itself refused the throw says so ("could not be rolled back"), and `reconcileDocumentCheckoutState` (the modal's Release Lock repair) heals the remainder. The re-read is a second statement, not the CAS itself: a holder who releases between the claim and the re-read reads as NULL → `failed` (the user is told to retry; nothing is left behind), and a holder who arrives in that window reads as `joined` (correct — they hold it). A single-statement verdict (a `claim_document_lock` RPC that raises on a filtered write) would remove the window; not this wave. No migration.

---

<a id="dck-5"></a>

## DCK-5 · Force-release has two surfaces with two different audit behaviours — the Inspector path writes no audit row at all, and the popover path writes the FORCE_RELEASE record before the release is attempted

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced: `CheckoutStatusCell.handleForceRelease` wrote `FORCE_RELEASE` BEFORE calling `forceReleaseDocument`, and the library page's `handleForceUnlock` (the Inspector's "Force Release Lock") wrote nothing; neither collected a reason. Built on the `force_release_document` RPC that `20261043` (SURF-4) already made the single transactional write — no second write added. `forceReleaseDocument` now takes `actorEmail` / `actorRole` / `reason` and writes the `FORCE_RELEASE` audit row ITSELF, via `logCheckoutEvent`, only after the RPC has confirmed the release for this document — details carry `reason`, `previousHolderId` (from the RPC), `endedSessions`, `releasedUsers` (id + name of every session it ended), `episodeId` and `checkoutNumber`. A refused RPC (or an answer for another document) throws before anything is recorded: no audit row, no thread alert, no episode close, no victim notification. Both surfaces collect the reason with `appPrompt` (required, ≥ 3 characters; the popover and the page each refuse a blank) and pass it to the RPC's `p_reason` (→ `released_reason` on every ended session, `20261043`) and to the audit details, so the register and the audit trail say the same thing. The popover's pre-write is removed; a refusal is shown (`appAlert` on the popover, the page's error strip on the Inspector path) instead of `console.error`. Review fix (Round F review, minor): the post-release row went through `logAuditAction`, which awaited the insert and never read its `{ error }` — supabase-js does not throw on a refused insert (`audit_logs_insert` requires `user_id = auth.uid()`; both surfaces fall back to `"unknown"` without a uid) — so a successful release could leave no `FORCE_RELEASE` row and no signal. `logAuditAction` now reads the insert's `{ error }`, logs it (`console.error("Failed to write audit log (<action>)", message)`) and RETURNS `{ error }` (callers that ignored the `void` are unaffected); `forceReleaseDocument` reads it, `console.error`s "the lock was released but the FORCE_RELEASE audit row was refused" and returns `{ auditRecorded, auditError }`; both surfaces show "Released, but the audit row was refused: …" (`appAlert` on the popover, the page's error strip on the Inspector path) instead of plain success.
- Files: `lib/checkoutEpisodes.ts` (`forceReleaseDocument`), `components/documents/CheckoutStatusCell.tsx`, `app/(protected)/documents/[libraryId]/page.tsx` (`handleForceUnlock`)
- Tests: `lib/__tests__/checkoutRoundF.test.ts` — "DCK-5": a refused RPC records nothing; a successful RPC is followed by exactly one `FORCE_RELEASE` row (ordered after the RPC in the event timeline) carrying the reason, the holder and the ended sessions, with the same reason on the RPC's `p_reason`; a mismatched answer records nothing; a successful RPC whose audit insert is refused resolves `{ auditRecorded: false, auditError }`, logs, and still seals/alerts/notifies; a landed row answers `auditRecorded: true`; the REAL `logAuditAction` (via `importActual`) returns `{ error }` under a refused `audit_logs` insert and `{ error: null }` otherwise; source pins that both surfaces show "Released, but the audit row was refused". `lib/__tests__/checkoutAffordances.test.ts` pins `lib/checkoutEpisodes.ts` as the ONLY `type: "FORCE_RELEASE"` writer under `app/`, `components/`, `lib/`.

**Done-when.**
- ✓ `forceReleaseDocument` writes the `FORCE_RELEASE` audit row itself, after the release succeeds; both surfaces record identically, a failed release records nothing, and a successful release whose row is refused says so (checked insert, `auditRecorded: false` surfaced on both paths).
- ✓ The confirm dialog collects a reason on both surfaces; it reaches `released_reason` (through the RPC) and the audit details.
- ✓ The `CheckoutStatusCell` pre-write is removed — one row per force-release.

**Scope / residual.** The modal's own "Release Lock" repair (`reconcileDocumentCheckoutState`) is state repair, not a force-release, and writes no `FORCE_RELEASE` — unchanged. The Inspector's button is now also gated on the `checkout.force_release` capability (DCK-13). The audit refusal is REPORTED, not retried and not blocking: the release is already real when the row is refused, so the actor is told the history is missing this act and to report it; a retry queue for refused audit rows is out of scope. No migration.

---

<a id="dck-6"></a>

## DCK-6 · The documented DB backstop for the checkout lock does not exist — it was deliberately removed in 20260812 and never replaced, and documentGuards.ts still claims it is there

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Verified against `ba7bfcb` (`grep -l enforce_document_publish_guard supabase/migrations`): the newest body is `20261060_rp_roundE_archive_publish_authority.sql` — it checks review completion, per-library publish authority, ownership and holds, and has NO `checked_out_by` branch; the lock is tested at the database only inside the `publish_revision` RPC (`20260828` → `20261040`, `v_doc.checked_out_by <> p_actor` unless `p_override_lock` / controller `p_force`). Taken as the first alternative in the done-when: `lib/documentGuards.ts`'s header no longer claims a defense-in-depth trigger enforces the lock — it now states exactly which rule lives where (hold → trigger; lock → RPC only; trigger lock branch removed on purpose in `20260812` and never restored), so the next reader is not misled. The trigger is deliberately NOT re-created here: `enforce_document_publish_guard` is P4 REVIEW's file this wave (its guard body must start from `20261060`, which is live), and restoring the lock branch would have to honour the override-with-reason semantics the app carries only in `authorizePublish` — that is a design change for the lifecycle/review packages, not a comment fix.
- Files: `lib/documentGuards.ts` (header comment only; the file is outside this package's plan — reported under `filesOutsidePlan`)
- Tests: `lib/__tests__/checkoutAffordances.test.ts` pins that the stale claim is gone and the corrected description is present.

**Done-when.**
- ✓ `lib/documentGuards.ts:10-18` no longer claims a DB trigger enforces the lock (first alternative taken; the lock check is NOT restored in a migration).
- — Not applicable: the "if restored" override-semantics criterion; nothing was restored. Recorded here so a later package that does restore it knows the constraint: publisher-with-reason must pass, a hold never.

**Scope / residual.** Defense-in-depth for a direct `documents.current_version_id` PATCH by someone who already holds publish authority stays absent at the trigger; the RPC path (every app publish) still refuses. Left for P3/P4 to weigh with the `20261060` body in hand. No migration.

*Follow-up (2026-10-21, document-control Round G, P32 PUBLISH GUARD LOCK LEG): the residual above is narrowed, not closed, by `20261245_dc_roundG_publish_guard_lock_leg.sql` (drafting-flow [`HAND-13`](../drafting-flow/11-document-handoff.md#hand-13), Partial — OPEN with recorded remainders) — the trigger refuses a direct pointer write over another person's checkout (42501), and the constraint this record set for a restored check holds: the publisher-with-reason override passes (it is `publish_revision`'s own promote), a hold never. What it still admits over a checkout: the promote of any pending row still `in_review` that carries a complete bound roster or is shaped as the intake door writes a submission (no member creator, `'external'`, a link of the org that scopes the document) — door (b). A genuine reviewed promote of that kind is [`DCK-15`](#dck-15), untold and unrecorded. Because every column door (b) reads is writable by a library publisher, a publisher can also MAKE such a row from an existing or a new one: a door-shaped draft on an intake-born or link-assigned document, by INSERT or UPDATE — [`DCK-16`](#dck-16); or an earlier reviewed revision relabelled back to `in_review`, whose old signed roster still counts, on any document with a reviewed history — [`DCK-17`](#dck-17). (Corrected at P32's review fix pass 2: this note first said the residual was closed while any pending draft a publisher labelled `in_review` passed. Corrected again at P32's fix pass 3: it said door (b) admitted only a draft a review decided, which the relabel route disproves.)*

---

<a id="dck-7"></a>

## DCK-7 · The expiry sweep runs from the browser on every library and /checkouts page load, swallows the rejection when it cannot release other people's sessions, and sends "your checkout auto-released" notifications regardless

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced at `lib/projects.ts` `autoReleaseExpiredAdHoc`: one org-wide batch UPDATE under the RLS client, `console.warn` on refusal, notifications built from the pre-update selection. Fixed on all three limbs. (1) The browser sweep is the CALLER'S OWN: without `opts.client` the function requires `opts.userId` and adds `.eq("user_id", uid)` to the selection — no userId, no sweep (returns 0, touches nothing). The release guard cannot refuse a caller's own session, so the batch can no longer abort wholesale on someone else's row. The cron path (`{ client }`, no org) is unchanged and remains the authoritative enforcer. (2) The UPDATE now RETURNS (`.select("id, document_id, org_id, user_id, library_id")`) and the notifications — and the DCK-9 `CHECK_IN` audit rows — are built only from the rows it actually changed; the LIFE-14 `.is("outcome", null)` rail is preserved (pinned by `lifeSweep2.test.ts`). (3) A sweep write that fails for any reason other than the missing outcome schema THROWS (`"Expired checkouts were NOT released: …"`): `/checkouts` shows it in its own `sweepError` strip above the list, the library page shows it in its page banner (`setError`, replacing the `.catch(() => undefined)`), the cron records it in `result.errors`. Both page callers pass `{ userId: uid }`. Review fix (Round F review, minor): `/checkouts` first awaited the sweep inside the same `try` as `listAllActiveCheckouts`, so a failed own-row sweep blanked the whole listing; the sweep now has its own `try/catch` → `sweepError` state and the listing loads regardless (the library page already isolated its sweep this way).
- Files: `lib/projects.ts` (`autoReleaseExpiredAdHoc`), `app/(protected)/checkouts/page.tsx`, `app/(protected)/documents/[libraryId]/page.tsx`
- Tests: `lib/__tests__/checkoutRoundF.test.ts` — "DCK-7": no userId → nothing; with a userId the selection is scoped and notifications + audit rows come from the RETURNING rows (a row the UPDATE did not change gets no notice); a refused write throws and notifies nobody; the cron path sweeps every org without a user filter; source pin that `/checkouts` keeps the sweep in its own `try/catch` → `sweepError` ahead of the listing and the library page's `.catch` isolation.

**Done-when.**
- ✓ The client-side sweep scopes itself to the caller's own sessions (`.eq("user_id", uid)`), and does nothing without a caller.
- ✓ The notification insert is driven by the rows the UPDATE actually changed (RETURNING), not by the pre-update selection.
- ✓ A non-missing-schema sweep error is thrown and surfaced where a human sees it (`/checkouts` `sweepError` strip with the listing still loaded, library page banner, cron `errors`).

**Scope / residual.** The post-release fan-out (notifications, the DCK-9 audit rows) stays non-blocking — the sessions are already released when it runs, and a failed notice must not re-fail a completed release; it logs. No migration.

---

<a id="dck-8"></a>

## DCK-8 · The transactional publish's lock check is switched off by a client-supplied boolean — p_override_lock is passed straight from the browser with no reason, no authority test, and no audit

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-30, document-control Round F wave 2).** P3 LIFECYCLE. Reproduced against the NEWEST definition (`20261105_prj_roundG_intake_review_and_attempts.sql`, which J1 re-created from 20261049): the lock test was still `AND NOT (p_override_lock OR (p_force AND v_is_controller))` — `p_override_lock` a bare boolean, no reason, no eligibility re-derivation, no record. (The verifier's sibling point — a caller-supplied `p_actor` — was closed by OWN-5: the actor is `auth.uid()` for any signed-in caller.)
- **Migration `20261130_dc_roundF_publish_override_reason.sql`** re-creates `publish_revision` from the 20261105 body (lineDiff-proven: only the lock block, one new parameter, two declarations and the audit insert differ): a trailing `p_override_reason TEXT DEFAULT NULL`; an override now REQUIRES it (≥ 5 characters after trim) and an eligible actor — the controller tier (already read from `org_members`), `user_can_publish_on_library` or `user_is_effective_owner`, re-derived in the function; every pass of a foreign lock (override or controller force) writes one `audit_logs` row, `REV_LOCK_OVERRIDDEN` (holder, reason, new version, branch or not), in the publish's own transaction. The 11-argument form is dropped first (a new trailing parameter would otherwise leave an overload PostgREST cannot choose between); EXECUTE is authenticated + service_role, revoked from PUBLIC and — explicitly — anon (a re-CREATEd function picks up the schema's default grants, and an anon caller has no `auth.uid()`, which this function reads as a service-role call allowed to name its actor). Not a widening; the inventory counts documents checked out right now.
- **App.** `authorizePublish` requires an override reason of at least `OVERRIDE_REASON_MIN` (5) unless a CONTROLLER forces (a non-controller's `force` is no longer a way round the reason) — for the callers that publish through `publish_revision` (rev-up, revert) only (review fix 2: supersede, split, merge and a review submission reuse the gate with their own reason as the holder's message, so they pass `operation` and need a non-blank reason, refused in the operation's own words, never "you're publishing"); `revUpDocument` / `revertToVersion` name `p_override_reason` ONLY when they pass `p_override_lock`, so an ordinary publish is the same call on either side of the paste; before the paste an override publish is refused with "needs migration 20261130" (`REV-8`), never published.
- Tests: `lib/__tests__/dcRoundFLifecycleMigration.test.ts` "20261130 — …" (the exact lineDiff against 20261105; the J1 revert-target word, MOC gate, branch bar and session actor survive; the order force → reason → eligibility → locked_by_other; the record written after the version exists; drop-before-create and the grants; 20261130 the newest `publish_revision`, 20261105 still the newest guard; every probe fragment present in the body it reads); `lib/__tests__/dcRoundFLifecycle.test.ts` "DCK-8 — …" (missing / short reason refused before upload, a non-controller's force refused, a controller's force passes; the reason travels only with an override; the pre-paste deploy message). `authorityCensus`, `searchPathPin` and `intakeDoorMigration` re-keyed to the 12-argument signature.

**Done-when.**
1. ✓ `publish_revision` takes the override REASON and rejects a blank / short one.
2. ✓ The function records the override itself (`REV_LOCK_OVERRIDDEN` in `audit_logs`, same transaction), so an override that bypasses the app is on the document's record.
3. ✓ Override eligibility is re-derived from `org_members` / library authority / effective ownership inside the function.

**Scope / residual.** **Pending migration:** `supabase/migrations/20261130_dc_roundF_publish_override_reason.sql` (DEC-30 — the database half does not exist until pasted). Deploy order and its windows are in `99-fix-sequencing.md`: each side fails closed — the wave-2 app before the paste refuses an override publish with "needs migration 20261130"; the paste before the wave-2 app makes the OLD app's override publish raise a raw `check_violation` ("needs a reason"), because the old app never sends `p_override_reason` — keep that window short. ⚠ Re-pasting 20261105 or an earlier `publish_revision` migration afterwards would re-create the 11-argument overload; re-running 20261130 removes it. Timeline renderers show `REV_LOCK_OVERRIDDEN` with their generic row (no icon mapping — not this package's files). ⚠ **The LIVE 11-argument `publish_revision` was never revoked from `anon`** — no migration did, and the function reads a NULL `auth.uid()` as a service-role call that may name any actor — so anyone with the public anon key can publish as any member until it is closed. That is its own CRITICAL finding, **`DRLS-16`** (`10-rls.md`), with a one-statement hotfix to paste now, independent of the wave-2 deploy; `20261130` closes it for the new signature.

---

<a id="dck-9"></a>

## DCK-9 · Three of the five release paths leave the check-in register blank or write an audit action nothing renders — the "every check-in records what came of it" contract holds only for the modal

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced on the three paths the verifier confirmed blank (stale banner, project bulk release, sweep) and the renderers. (a) `components/projects/StaleCheckoutBanner.tsx` releases through `finishMySession` with an explicit register outcome (`all_clear`, "Released from the stale-checkout banner (no changes)") — which also settles the lock/episode (clear, transfer or rebuild) the same way every other surface does — and logs `CHECK_IN` via `logCheckoutEvent` (`details.via = "stale_checkout_banner"`); the unrecognised `CHECKOUT_RELEASED` write and the direct session UPDATE are gone. (b) `releaseAllCheckoutsForProject` (now exported for tests) ends each session with `outcome: "auto_released"` and `outcome_note: <reason>` (the project's state change ended it — nobody chose it; the existing "Auto-released" register label plus the note, no new vocabulary), writes one `CHECK_IN` audit row per document naming every session it ended (`details.releasedSessions`, `via: "project_release"`, `projectId`, `reason`), and its write is CHECKED: a refusal throws (`"The project's active checkouts were NOT released: …"`); `transitionProjectStatus` still notifies the audience of the status change and then RETURNS that refusal as `{ releaseError }` (review fix, Round F review, minor: it first re-threw it, and the page's `catch` skipped `refresh()`, so the page kept rendering the OLD status beside a message saying the project was completed — the status change had succeeded), so a Manager who cannot release another user's session (the release guard) is told instead of believing it happened; `app/(protected)/projects/[id]/page.tsx` refreshes to the database's status first and then shows `releaseError` as its action strip, and also refreshes after a throw so the rendered status never lags the database. (c) The expiry sweep writes a `CHECK_IN` row per released session (`outcome: "auto_released"`; under the RLS client `user_id` is the caller — the `audit_logs_insert` policy requires `user_id = auth.uid()` — and under the cron `user_id` is NULL with `user_email: "system"`, the holder named in `details.releasedUserId`). Renderers: legacy `CHECKOUT_RELEASED` rows now read "Checked in (released from the stale-checkout banner)" in `lib/timeline.ts`, count in the activity pulse's lock bucket (`app/(protected)/activity/page.tsx:195`) and carry a chip in `/admin/audit`; an auto-released `CHECK_IN` reads "Checked in (auto-released)".
- Files: `components/projects/StaleCheckoutBanner.tsx`, `lib/projects.ts` (`releaseAllCheckoutsForProject`, `transitionProjectStatus`, `autoReleaseExpiredAdHoc`), `app/(protected)/projects/[id]/page.tsx` (`handleTransition`), `lib/timeline.ts`, `app/(protected)/activity/page.tsx`, `app/(protected)/admin/audit/page.tsx` (one map entry; outside this package's plan)
- Tests: `lib/__tests__/checkoutRoundF.test.ts` — "DCK-9" (outcome + note, one `CHECK_IN` per document with the session list, refusal thrown with no audit row, nothing active → 0, `transitionProjectStatus` lands the status and returns `releaseError` on a refused release / `null` otherwise, source pin that the project page refreshes before showing the refusal and after a throw) and the sweep's audit rows under "DCK-7"; `lib/__tests__/timelineHolds.test.ts` — the banner writes through `finishMySession` with `all_clear` + `CHECK_IN`, no `action: "CHECKOUT_RELEASED"` writer remains anywhere under `app/`, `components/`, `lib/`, and the renderer maps.

**Done-when.**
- ✓ The stale banner releases through `finishMySession` with `all_clear` and logs `CHECK_IN`; `CHECKOUT_RELEASED` is no longer written.
- ✓ `releaseAllCheckoutsForProject` records an outcome per session, writes a `CHECK_IN` per document, and no longer discards its update error.
- ✓ The expiry sweep writes a `CHECK_IN` row per auto-released session, visible in the document's history.

**Scope / residual.** The project release is still ONE batch statement: for an actor without `checkout.force_release` a refusal on any other user's session refuses the whole batch — now loudly. Splitting it per session (own sessions first) is a wave-2 nicety, not a correctness gap. No migration.

---

<a id="dck-10"></a>

## DCK-10 · forceReleaseDocument ignores the error from the session-ending write, then clears the lock unconditionally — a rejected force-release still frees the document while every session stays active

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F — record-only close; this id was assigned to no Round F package, and its residual is the DCK-13 line the plan names).** Verified against `ba7bfcb`, no code beyond DCK-13's. The code defect no longer reproduces: roles-and-permissions `SURF-4` (migration `20261043`, **applied & verified live**) replaced the two split writes with the `force_release_document` RPC — the session close and the lock clear are ONE transaction, the release guard fires inside it, and `lib/checkoutEpisodes.ts` `forceReleaseDocument` reads `{ data, error }` from the RPC and THROWS (`"Force release was refused — the lock was NOT cleared: …"`) before any episode close, thread alert or notification; a refusal leaves both the sessions and the lock exactly as they were. The UI-gate half — the hardcoded `Admin`/`DocCtrl` pair on `CheckoutStatusCell.tsx` that showed the button to people the database then refused — closes with `DCK-13` this round: the button is drawn from `policyAllows(policy, "checkout.force_release", …)` (`lib/checkoutAffordances.ts`, `useForceReleaseAllowed`), and `DCK-5` makes a refusal visible (`appAlert` / page error) with nothing recorded.
- Resolved by: `SURF-4` (`20261043`) for the write ordering; `DCK-13` for the gate; `DCK-5` for the surfaced refusal.
- Tests: `lib/__tests__/checkoutRoundF.test.ts` "DCK-5" (a refused RPC records nothing and throws); `lib/__tests__/checkoutAffordances.test.ts` (the gate follows the policy: narrowing hides, widening shows, grants light).

**Done-when.**
- ✓ The session-ending update's error is checked and thrown before any documents column is touched — the RPC is one transaction; the app throws on its error.
- ✓ The document clear is conditional on the session write succeeding — the whole operation moved into a single RPC (`20261043`).
- ✓ The force-release UI gate reads the `checkout.force_release` capability the DB enforces (DCK-13).

**Scope / residual.** None. No migration beyond `20261043` (live).

---

<a id="dck-11"></a>

## DCK-11 · A single undefined-column error anywhere in the checkout path permanently disables episodes for the whole process, silently detaching new sessions and thread messages from the register

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced: `isMissingEpisodeSchema` short-circuited on a bare `42P01 / 42703 / PGRST204 / PGRST205`, and `episodeSchemaMissing` was a module-scope boolean with no production reset. Both halves fixed in `lib/checkoutEpisodes.ts`. The classifier now REQUIRES the message to name the episode schema (`checkout_episodes` or `episode_id`) before a code — or a schema-cache phrase — counts; Postgres and PostgREST both name the missing object, so a genuine pre-migration error still classifies while a `PGRST204` for `checkout_messages.kind` no longer does (it is thrown, as it should be). The latch is TIME-BOXED: `EPISODE_SCHEMA_RECHECK_MS` (5 min) — after the window every helper re-probes, so a transient misclassification can no longer detach a whole browser tab's or server process's sessions and thread messages from the register for its lifetime; a genuinely pre-migration environment simply re-latches every few minutes at the cost of one failed query. Flipping is LOUD: the first flip of each window logs `console.error("[checkoutEpisodes] episode schema unavailable — …", cause)` — the server log / browser console says why sessions stopped being episode-tagged. `resetEpisodeSchemaFlag` / `episodeSchemaIsMissing` keep their contracts (the modal's `episodesSupported` read is unchanged).
- Files: `lib/checkoutEpisodes.ts`
- Tests: `lib/__tests__/checkoutEpisodes.test.ts` (the classifier: named errors classify, bare or unrelated codes do not — the old "bare code → true" expectations were rewritten, which is the failing-before/passing-after evidence); `lib/__tests__/checkoutRoundF.test.ts` — "DCK-11": latches on a real `42P01` naming `checkout_episodes`, logs once, skips the query while latched, re-probes after the window (fake timers); an unrelated `42703` throws and does not latch.

**Done-when.**
- ✓ The bare-code short-circuit is removed: a code match must also name `checkout_episodes` / `episode_id`.
- ✓ The flag is time-boxed and re-probes instead of latching for the process lifetime. (It is still module-scoped rather than per-request — the window bounds the blast radius to five minutes per process; a per-client flag would need every helper to thread a client through and is not what the failure needed.)
- ✓ Flipping emits a `console.error` with the cause (server log / browser console). No toast: the flip happens inside lib helpers with no UI in hand, and the modal already shows the "episodes unsupported" state.

**Scope / residual.** `isMissingOutcomeSchema` keeps its bare-code shape — it does not latch anything; it retries the same write without the outcome columns — so it is outside this finding (DEC-31). No migration.

---

<a id="dck-12"></a>

## DCK-12 · The check-in outcome register — the walkdown attestation trail the MOC gate feeds — has exactly one reader and answers none of the questions its migration was written for

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Verified against `ba7bfcb` before touching anything: the reader the index was built for now EXISTS — `components/documents/CheckoutHistoryPanel.tsx` queries `checkout_sessions … .eq("document_id") .in("outcome", ["field_verified","discrepancy"]) .order("ended_at")` (the exact shape `checkout_sessions_outcome_idx` serves) and renders "Last field-verified against Rev N on <date> by <who>" — or "superseded by a field discrepancy reported by …" — as a strip ABOVE the collapsed Checkout History header inside the Inspector's checkout section, i.e. where the drawing is looked at, without expanding any episode (landed with the LIFE-* register work; this round records it against this finding). What was still missing was legibility of the parallel `FIELD_VERIFIED` audit row, and that is fixed: `lib/timeline.ts` `summarizeAudit` renders it as "Field verified against Rev N"; the activity pulse counts it as a lock event (`app/(protected)/activity/page.tsx:195`); `/admin/audit`'s chip map (`ACTION_STYLE`) and `components/documents/TimelineFeed.tsx`'s icon map carry it. The audit row and the session outcome are deliberately NOT consolidated: the session row is the register (queryable per document/outcome through the index), the audit row is the immutable attestation event in the org-level trail; each now has a real reader.
- Files: `lib/timeline.ts`, `app/(protected)/activity/page.tsx`, `app/(protected)/admin/audit/page.tsx` and `components/documents/TimelineFeed.tsx` (one map entry each; both outside this package's plan — reported)
- Tests: `lib/__tests__/timelineHolds.test.ts` — `summarizeAudit` for `FIELD_VERIFIED` with and without a rev; the activity bucket, the admin chip map and the TimelineFeed case are pinned by source.

**Done-when.**
- ✓ A query reads the index as intended (last `field_verified` per document with rev and date) and is surfaced on the document (the strip above Checkout History in the Inspector), not only inside an expanded episode — verified present at `CheckoutHistoryPanel.tsx` (`fieldVerification`).
- ✓ `FIELD_VERIFIED` is in every audit renderer map (`timeline.ts` `summarizeAudit`, `/admin/audit` `ACTION_STYLE`, `TimelineFeed`, and the activity pulse bucket).
- ✓ The index earns its keep through that reader; the two records are kept (register vs. attestation event), each with a consumer.

**Scope / residual.** No cross-document "last verified" report/register column exists yet (the per-document strip answers the question at the drawing); an org-wide PSI-accuracy report is a build item, not this finding. No migration.

---

<a id="dck-13"></a>

## DCK-13 · The checkout.force_release capability is defined, editable and DB-enforced, but no checkout surface reads it — the buttons are gated on hardcoded ["Admin","DocCtrl"]

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced: `CheckoutStatusCell.tsx` gated Force Release on the literal pair (OWN-3 had widened it to the collection, still a literal), `InspectorPanel.tsx` on `holdsAny(['Admin','DocCtrl'])`, `lib/documentGuards.ts` carried its own `CONTROLLER_ROLES` set. Fixed with the evaluator `lib/holds.ts` already uses: new pure `lib/checkoutAffordances.ts` — `canForceReleaseCheckout(policy, role, roles, uid)` = `policyAllows(policy, "checkout.force_release", …)` (role tokens, the additive `roles[]`, live per-person grants; a not-yet-loaded policy evaluates the shipped default, byte-identical to the old pair for an unconfigured org) and `holdAffordances` for the HLD-8 half. `CheckoutStatusCell` exports `useForceReleaseAllowed(orgId, role, roles, uid)` (loads the org policy through the browser-cached `loadCapabilityPolicy`, keyed by org) and draws "Admin Force Release" from it; `InspectorPanel` draws "Force Release Lock" from the same hook. Widening (a Drafting Supervisor delegated `checkout.force_release`, or a personal grant) now shows the button; narrowing (`[Admin]`) hides it from every DocCtrl the database would refuse — the silent half-release of DCK-10 can no longer be reached from the UI. `lib/documentGuards.ts` `isControllerRoleName` is sourced from `lib/permissions.ts` `isControllerRole` (the mirror of `is_org_controller`); the literal set is gone.
- Files: `lib/checkoutAffordances.ts` (new), `components/documents/CheckoutStatusCell.tsx`, `components/documents/InspectorPanel.tsx`, `lib/documentGuards.ts` (outside this package's plan — reported)
- Tests: `lib/__tests__/checkoutAffordances.test.ts` — defaults, the additive collection, narrowing, widening, a personal grant (live and expired), `isControllerRoleName ≡ isControllerRole` for every role, and source pins that the two surfaces gate on the capability and no literal pair remains.

**Done-when.**
- ✓ `CheckoutStatusCell` and `InspectorPanel` gate the force-release button on `policyAllows(policy, "checkout.force_release", …)` — the evaluator `holds.ts` uses.
- ✓ The predicate honours additive `roles[]` (and grants) the way `is_org_controller` / `org_capability_allows` do.
- ✓ `lib/documentGuards.ts`'s controller set is sourced from `lib/permissions.ts` rather than a literal.

**Scope / residual.** The policy is read once per org per minute in the browser (WF-10); authority is decided by the database either way — the button is drawn from the same answer the trigger gives. DCK-10's residual (the same line) closes with this. No migration.

---

<a id="dck-14"></a>

## DCK-14 · checkout_episodes is updatable by any active org member, so a "sealed history record" can be rewritten or reopened, and a check-in race can seal an episode that still has live sessions

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced both halves: `checkout_episodes_org_update` is `FOR UPDATE USING (member)` with no column restriction, and `finishMySession`'s close branch sealed on a session list that predates its own writes. DATABASE — migration `20261075_dc_roundF_checkout_episode_seal.sql` installs `trg_checkout_episode_guard` (`enforce_checkout_episode_guard`, BEFORE UPDATE, SECURITY DEFINER, `SET search_path = public`; a GUARD in the 20261029 shape, not a policy change, so a collaborator, a force-release or the sweep may still close an episode someone else opened): (1) `OLD.status = 'closed'` → refused for every signed-in writer — a sealed record cannot be rewritten or reopened; (2) `active → closed` while a `checkout_sessions` row with `episode_id = OLD.id` is still active → refused ("still has active sessions and cannot be sealed"); the service role passes (`auth.uid() IS NULL`), the seam every checkout guard uses. Not a widening; the inventory (aggregate, captured before the DDL) counts the residue the rail now prevents. APP — `closeEpisode` re-reads the episode's own active sessions inside the close, before the write, and returns `"closed" | "live_sessions" | "skipped"`; the database refusal text is matched (`EPISODE_LIVE_SESSIONS_RAIL`, pinned against the migration) and treated as the same verdict. `finishMySession` no longer seals over a racer: on `live_sessions` it runs `reconcileDocumentCheckoutState` (which hands the lock to the newcomer the guarded documents clear correctly left alone, or rebuilds the collaborator list) and posts "… checked in — someone else joined meanwhile, so the checkout stays open" instead of "checkout closed"; `episodeClosed` is only true when the seal happened. `forceReleaseDocument`, the sweep, `reconcileDocumentCheckoutState` and the DCK-4 rollback all go through the same guarded close.
- Files: `supabase/migrations/20261075_dc_roundF_checkout_episode_seal.sql`, `lib/checkoutEpisodes.ts` (`closeEpisode`, `finishMySession`)
- Tests: `lib/__tests__/checkoutRoundF.test.ts` — "DCK-14": last-one-out seals; a session that joined after the closer's fetch is NOT sealed over (no episode write, the lock is settled to the newcomer, the thread says the checkout stays open); the database rail's refusal reconciles instead of throwing; any other refusal still throws. `lib/__tests__/dcRoundFCheckoutMigration.test.ts` — the guard's two refusals, the service pass, the search_path pin, the one-result-set protocol (TEMP TABLE inventory before `BEGIN`, a single final `SELECT` of `(check, ok, n)`), the app/migration refusal-text lock-step, and that this file is the only definer.
- **Pending migration:** `supabase/migrations/20261075_dc_roundF_checkout_episode_seal.sql` — the code half is live on the branch; done-when 1 holds only once the SQL is applied (DEC-30). The app half is safe on a pre-migration database (the re-read alone catches the race short of a same-instant join). *(2026-10-14, the integrator at the intelligence I-27 merge: as first written the file could not be pasted — its final SELECT named the `check` column bare, so the SQL editor rejected the whole script and applied nothing (intelligence `IRLS-19`, found by I-17's fresh replay). I-27 quoted that one identifier in place; the corrected file pastes as one script and returns its nine-row result on PostgreSQL 16. Paste guide row 70 is PASTE again; done-when 1 now waits only on the user's paste of row 70.)*

**Done-when.**
- ✓ A closed episode is immutable to non-service-role writers (trigger; pending apply).
- ✓ `closeEpisode` is conditional on the same evidence the documents clear is conditional on — it re-reads active sessions inside the close, and the database refuses the seal on the same fact.
- ✓ A close that finds live sessions reconciles (lock settled from the live rows, honest thread line) instead of sealing.

**Scope / residual.** The close and the lock clear remain two statements (the "single RPC" alternative was not taken — the trigger closes the gap the RPC would have closed, without moving the transfer/rebuild logic out of the tested pure core). `checkout_episodes_org_update`'s breadth is untouched by design; the guard restricts only what the finding named.

---

<a id="dck-15"></a>

## DCK-15 · A review's promote publishes over another person's checkout without a word — no lock read at any layer, no notice to the holder, nothing recorded

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED (found by document-control Round G P32 while closing drafting-flow `HAND-13`, 2026-10-21; reproduced on the I-17 PostgreSQL 16 harness)
- **Locations:** `lib/reviewControl.ts:915-1072` (`finalizeReviewedRevision`), `lib/reviewControl.ts:1118-1175` (`promoteThreeStep`), `supabase/migrations/20261151_dc_roundF_promote_transaction_and_hold_override.sql:208-326` (`finalize_reviewed_promote`), `supabase/migrations/20261245_dc_roundG_publish_guard_lock_leg.sql:855-940` (the lock leg; door (b) at `:922-935`), `lib/revisions.ts:411-451` (`noteOverrideOnHolder`)
- **Assigned:** proposed — document-control (the integrator assigns at the P32 merge, DEC-31); files: `lib/reviewControl.ts`, `components/documents/ReviewGateSection.tsx`, and, if the database is to record it, a `finalize_reviewed_promote` re-creation from its newest body. **Assigned (2026-10-21, the integrator at the P32 merge, DEC-31): document-control P33 VERSION ROW INTEGRITY.**

**Mechanism.** Every other way a new revision becomes current over another person's checkout is an act: `publish_revision` refuses it (`locked_by_other`) unless the publisher gives a reason or Document Control forces it, records `REV_LOCK_OVERRIDDEN` in the same transaction (DCK-8), and the app tells the holder on their episode thread and in-app (`noteOverrideOnHolder`, called by `revUpDocument` and `revertToVersion` only). After `20261245` the publish guard refuses a direct pointer write over a checkout too (HAND-13). The reviewed promote is the one door left: `finalizeReviewedRevision` reads no checkout (no `checked_out_by` in `lib/reviewControl.ts`), `finalize_reviewed_promote` and `promoteThreeStep` write the pending draft current with no lock test, and `20261245` admits that write as its door (b) on purpose when the pending row looks reviewed (every column it reads is publisher-writable — see `DCK-16` / `DCK-17`) — a bound roster the review gate proved complete, or an external submission shaped as the intake door writes it (no member creator, `'external'`, a link of the org that scopes the document; since P32's review fix pass 2 — a draft a publisher merely labels `in_review` with a creator or an unrelated link is refused; the row's columns are publisher-writable, so the forgeable remainders are [`DCK-16`](#dck-16) (the intake shape) and [`DCK-17`](#dck-17) (an earlier reviewed revision relabelled `in_review`)) — it worked that way before, and DEC-90 ruling 2 (P32's brief) keeps every flow legitimate users use today (a departure from rulings (1)/(2) as written — a non-holder's promote that is not the override path — flagged for explicit ratification in DEC-90's landed line). So when the last reviewer signs (or a publisher finalizes from the Inspector) while someone else holds the document checked out, the new revision lands, the holder is not told, and nothing records that a checkout was passed.

**Failure scenario.** A field engineer checks out an isometric for a walkdown. Meanwhile the drafter's Rev 3 (2A in review) collects its last signature and a publisher finalizes it. Rev 3 is current; the engineer keeps marking up Rev 2 with no notice. Their own publish will meet `publish_revision`'s expected-base check (`stale_base`), so nothing is clobbered — but the walkdown was spent on a superseded sheet, and the audit trail does not show that the promote passed a live checkout.

**Evidence.** `lib/__tests__/rls/dcP32PublishGuardLock.test.ts` — "finalize_reviewed_promote by a publisher, or Document Control, who does not hold the checkout promotes the reviewed draft on both sides" (admitted before and after `20261245`); `grep -n "checked_out\|noteOverrideOnHolder" lib/reviewControl.ts` returns nothing.

**Done when.**

- [ ] Finalizing a reviewed draft on a document someone else holds tells the holder (episode thread + in-app, as `noteOverrideOnHolder` does) and records that the promote passed the checkout (an audit row naming the holder), whichever door ran it (`finalize_reviewed_promote` or `promoteThreeStep`).
- [ ] The Inspector's finalize says before the click that the document is checked out by someone else (or asks for a reason, as the rev-up override does) — the product call is the owner's, under DEC-90 (fail-safe, no regression: a review must still be finishable).
- [ ] A finalize the lock leg refuses (42501, "This document is checked out by …") is answered in words that fit the door: `lib/reviewControl.ts` `finalizeReasonMessage` (shared by `ReviewGateSection` and `components/projects/IntakePanel.tsx`) maps that sentence to "ask the holder to check it in, then approve" rather than passing through the guard's "publish it from the revision flow with an override reason", which an intake approver cannot use. Reachable after `20261245` when a genuine submission's document was unassigned from its link after it was submitted (the intake limb reads the link's scope when the promote runs — P32 fix pass 3, harness "fail-safe, recorded"), and for a roster-less internal draft over a foreign checkout. Added at P32's fix pass 3 (the review's minor); same owner and file as this finding.
- [ ] Pinned by a test on each side (the app's notice; the record).

**Resolution (2026-10-21, document-control Round G).** P33 VERSION ROW INTEGRITY (assigned at the P32 merge, DEC-31; ruled under DEC-90 — fail-safe, no regression; door (b) itself was ratified at the P32 merge). Reproduced on HEAD `ad9d42b`: `grep -n "checked_out\|noteOverrideOnHolder" lib/reviewControl.ts` returned nothing, and the P32 harness's "finalize_reviewed_promote by a publisher, or Document Control, who does not hold the checkout" promoted on both sides with no notice and no row. App-side, after the promote, never blocking it (the brief's ruling (4)):
- `lib/reviewControl.ts` `finalizeReviewedRevision` reads `checked_out_by` / `checked_out_by_name` with the document and, once the promote has landed — through `finalize_reviewed_promote` or `promoteThreeStep` (both converge after the promote, before the bookkeeping that follows) — calls the new exported `notePromoteOverCheckout`: when someone OTHER than the actor holds the checkout (re-read after the promote, so a checkout released meanwhile is not reported; a failed re-read keeps the one read before), it posts a system note on the holder's active checkout episode (`getActiveEpisode` / `postEpisodeSystemMessage`, as `noteOverrideOnHolder` does), sends an in-app notice of the EXISTING kind `revision_published_over_checkout` (no new notification kind; `notification_kinds()` untouched) linked to the document with `metadata.via = "review_promote"`, and writes a `REVIEW_PROMOTED_OVER_CHECKOUT` audit row (`details.via = "review_promote"`, `holderUserId`, `holderName`, `versionId`, `previousVersionId`, `revisionLabel`; the actor's email on the row) — a distinct action registered in `lib/auditActions.ts` under revisions and NOT destructive, with a history label in `lib/timeline.ts` `summarizeAudit` ("Reviewed Rev X published while <holder> had it checked out (their checkout stays open)"). *(Corrected at P33's review fix pass: the first version wrote `REV_LOCK_OVERRIDDEN`, `publish_revision`'s override / force, which sits in `DESTRUCTIVE_AUDIT_ACTIONS` — so the routine door (b), the end of a review the drafter submitted while keeping the checkout, counted on the Admin audit page's "Destructive / undo / force" KPI and read "rev lock overridden" in the history.)* Every leg is best-effort: a failure is logged and the landed publish is returned as before.
- `finalizeReasonMessage` maps the lock leg's 42501 sentence (`"This document is checked out by <holder>, so a new revision can't be made current here; …"`, recognised by the new exported `FINALIZE_LOCK_REFUSAL` / `finalizeLockRefusalHolder`) to "This document is checked out by <holder>, so the reviewed revision was not published and nothing was changed. Ask the holder to check it in, then approve it again — the review stands." — shared by `ReviewGateSection` and `components/projects/IntakePanel.tsx` (whose refused approve already throws `finalizeReasonMessage(res.reason)`; no copy of its own, so IntakePanel is unchanged). Every other reason reads as before.
- `components/documents/ReviewGateSection.tsx`: when someone other than the viewer holds the document (`doc.checkedOutBy`), the panel shows, above "Publish approved revision", a note (`role="note"`): "This document is checked out by <holder>. Publishing the approved revision makes it current while their checkout stays open — they are told on their checkout thread and in-app, and the document's history records it." Informational: the button is not held back (a review stays finishable — door (b), ratified).
- Before / after any paste: nothing here reads a new column or calls a new function (the checkout columns are `schema.sql`'s); the notice and the row run on every database. 20261247 (DCK-16 / DCK-17) is not required by this half.
- Tests: `lib/__tests__/dcRoundGReviewPromoteOverCheckout.test.ts` (10: the record is a non-destructive revisions action with its history label, and `REV_LOCK_OVERRIDDEN` stays destructive; the notice, the thread note and the record through `finalize_reviewed_promote` and through `promoteThreeStep` (PGRST202); none for the holder's own promote, an unlocked document, or a checkout released before the promote landed; a failing notice never fails the publish; a refused or conflicting promote tells nobody; the lock leg's sentence read from `20261245` itself and mapped; the other reasons unchanged; IntakePanel answers through `finalizeReasonMessage`); `lib/__tests__/dcRoundGReviewGateCheckoutNote.test.ts` (3, rendered: the note names the holder and the publish stays available; "another user" with no name; no note for the holder's own view or an unlocked document).

**Done-when.**
- ✓ Finalizing a reviewed draft on a document someone else holds tells the holder (episode thread + in-app) and records an audit row naming the holder, whichever door ran it (`finalize_reviewed_promote` or `promoteThreeStep`, both run by `finalizeReviewedRevision`) — `lib/reviewControl.ts` `notePromoteOverCheckout`. App-side as ruled; see the residual for a promote made outside the app.
- ✓ The Inspector's finalize says before the click that the document is checked out by someone else — `ReviewGateSection` (informational; the product call under DEC-90: no reason is asked, a review stays finishable).
- ✓ A finalize the lock leg refuses is answered "ask the holder to check it in, then approve" — `finalizeReasonMessage`, shared by `ReviewGateSection` and `IntakePanel`.
- ✓ Pinned by a test on each side (the app's notice; the record) — the two test files above.

**Scope / residual.** The notice and the row are written by the app after the promote, not in the promote's transaction: a reviewed promote made OUTSIDE the app by someone with publish authority — a direct PostgREST call of `finalize_reviewed_promote`, or the three-step PATCH by hand — is admitted by door (b) (ratified) and is neither told nor recorded, and a notice or row whose write fails is logged only. Recorded as new finding [`DCK-18`](#dck-18) (LOW; owner proposed: document-control — the database-side record would re-create `finalize_reviewed_promote` (newest `20261151`) and/or the publish guard (newest `20261245`); the integrator assigns, DEC-31). After `20261247` the rows door (b) admits can no longer be forged by a signed-in session (`DCK-16`, `DCK-17`), so what is untold is a genuine reviewed promote only.

---

<a id="dck-16"></a>

## DCK-16 · A library publisher can still forge an intake submission on an intake-born or link-assigned document and promote it over another person's checkout — the client INSERT policy admits a publisher's row whatever its provenance

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (found by the P32 review, 2026-10-21, and narrowed by P32's review fix pass 2; the remainder reproduced on the I-17 PostgreSQL 16 harness)
- **Locations:** `supabase/migrations/20261214_prj_roundG_intake_door_rls.sql:509-525` (`document_versions_insert_integrity`, re-created from `20261205` / `20261037`: its first limb, `user_can_publish_doc(record_id, org_id)`, admits any row from a library publisher — any `provenance`, any `intake_link_id`, any `created_by`, NULL included), `supabase/migrations/20261245_dc_roundG_publish_guard_lock_leg.sql:922-935` (the lock leg's door (b), whose intake limb trusts that shape), `supabase/migrations/20260902_project_intake.sql:52-60` (`project_intake_links_write`: a controller or the project's owner may assign documents to a link)
- **Assigned:** proposed — projects (owner of `document_versions_insert_integrity` and the intake door's row shape since J16 / J20); the integrator assigns at the P32 merge (DEC-31). **Assigned (2026-10-21, the integrator at the P32 merge, DEC-31): document-control P33 VERSION ROW INTEGRITY.**
- **Pending migration:** `supabase/migrations/20261247_dc_roundG_version_row_integrity.sql` — paste AFTER `20261245` (required: its first statement refuses, changing nothing, without `20261245`'s lock leg or `20261214`'s door limb); `20261245` is HOLD behind `20261193` (paste guide row 150; `20261245` is row 187), so this file waits with them. The code half needs no deploy order; what this record closes at the database holds once the file is pasted (DEC-30).

**Mechanism.** The lock leg `20261245` adds to the publish guard admits, over another person's checkout, the reviewed promote of the pending draft (door (b)). Since P32's review fix pass 2 that is a draft with a bound roster the review gate proved complete, or an external submission shaped as the intake door writes it: no member as creator (NULL, or the link's own id under the door's bound identity), `provenance = 'external'`, its `intake_link_id` a link of this org whose scope holds the document — the document's authoring link (`documents.authored_by_link_id`, which no signed-in session can write — `trg_documents_authorship_fixed`, `20261141`) or a link it is assigned to. The trigger reads the row; it cannot see who inserted it. A library publisher may insert that same row through PostgREST: `document_versions_insert_integrity`'s publisher limb checks only `user_can_publish_doc`, and no trigger keeps `provenance`, `intake_link_id` or `created_by` (the P17 review found the same of `created_by` — `03-review-gate.md`, RG-14's fix). With the pending pointer then moved to it (a pending-pointer change is not judged by the guard) and the three-step promote, the forged revision becomes current over the holder's checkout in any library whose review mode is not `require`. Nothing records it and the holder is not told. The same row can be made by UPDATE: `document_versions_update_integrity` (`20261037:177-189`) admits any change from a library publisher, so an ordinary revision on an intake-born document re-shaped as the door's submission (`review_state 'in_review'`, `provenance 'external'`, `intake_link_id` the link, `created_by` the link) and promoted passes the same way (harness "the remainder DCK-16 records, by UPDATE", admitted on both sides). P32's fix pass 2 refused the review's first reproduction (a creator, or an `intake_link_id` that names no link — now 42501), so this route needs a document an intake link scopes; on an ordinary document the forger must first assign it to a link, which only a controller or the project's owner can. That is NOT a narrowing of what a publisher can do over a checkout overall: the roster limb of door (b) can be borrowed on any document with a reviewed history by relabelling an earlier reviewed revision back to `in_review` — [`DCK-17`](#dck-17). *(Corrected at P32's fix pass 3: this paragraph said the fix pass "narrowed this from every document to the documents an intake link scopes", read as a bound on the lock leg's gap.)*

**Failure scenario.** A drafter holds a contractor-authored isometric (born through the project's intake link) checked out for a markup. A library publisher who is not the holder inserts `document_versions` (`review_state 'in_review'`, `provenance 'external'`, `intake_link_id` = the authoring link, `created_by` NULL), PATCHes `documents.pending_version_id` to it, then PATCHes `current_version_id` to it with the pending pointer cleared: the content is current, attributed to the contractor, over the drafter's checkout.

**Evidence.** `lib/__tests__/rls/dcP32PublishGuardLock.test.ts` — "the remainder DCK-16 records" (the publisher's own INSERT of a member-less `'external'` draft naming the scoping link, creator the link's id or NULL, admitted before and after `20261245`); "a GENUINE external submission" (the same shape, promoted over a foreign checkout on both sides — the trigger cannot tell them apart); "door (b) cannot be borrowed by a FORGED intake draft" (the narrowed cases: a creator, or a link that names nothing, refused 42501 after). `app/api/intake/upload/route.ts` and the intake door functions (`20261184`, `20261214`) are the only writers of an `'external'` row with a link: no signed-in client path writes one (`grep -rn 'provenance: "external"' app lib components` names only the route).

**Done when.**

- [ ] A signed-in session's INSERT into `document_versions` cannot carry `provenance = 'external'`, a non-NULL `intake_link_id`, or a `created_by` other than itself (the door's role and the service role keep writing them) — `document_versions_insert_integrity` re-created from its newest body with that limb, lineDiff-pinned, DEC-30 one paste, its door limb kept (the `lib/__tests__/prjRoundGJ20DoorRls.test.ts` forward scan).
- [ ] The same columns cannot be changed by a signed-in UPDATE on an existing row (`document_versions_update_integrity`, or a column guard on `document_versions`) — coordinated with [`DCK-17`](#dck-17), which needs the same policy or trigger for the lifecycle columns.
- [ ] The harness's "remainder DCK-16 records" and "the remainder DCK-16 records, by UPDATE" cases answer refused after that paste, and "a GENUINE external submission" still promotes.

**Resolution (2026-10-21, document-control Round G).** P33 VERSION ROW INTEGRITY (assigned at the P32 merge, DEC-31; ruled under DEC-90 — fail-safe, no regression; coordinated with projects in the same file, the policy's owner since J16 / J20). Reproduced on HEAD `ad9d42b` on the I-17 PostgreSQL 16 harness: a library publisher's INSERT of a member-less `'external'` draft naming the scoping link (creator the link's id, or NULL), the INSERT of a link without the mark, of the mark without a link, of a draft created as someone else, and the re-shape of an ordinary revision by UPDATE — all admitted (P32 harness "the remainder DCK-16 records" / "…, by UPDATE"; P33 harness "before" column). Every legitimate writer was found first (census below) and is pinned before and after.
- `supabase/migrations/20261247_dc_roundG_version_row_integrity.sql` §1 re-creates `document_versions_insert_integrity` from its NEWEST body (`20261214`, found by scanning; lineDiff + exact cut) with ONE limb ANDed in front: `(CURRENT_USER = 'intake_door' OR (provenance IS DISTINCT FROM 'external' AND intake_link_id IS NULL AND created_by = auth.uid()))`. The door's limb is kept byte for byte (the `prjRoundGJ20DoorRls.test.ts` forward scan passes: the newest definition still carries it, and the file says how `intake_door` is treated); the service role bypasses row-level security.
- §2 one column guard, `enforce_document_version_row_integrity()` (SECURITY INVOKER — it reads no table, so DRLS-16's definer rights are not needed; `search_path` pinned; EXECUTE revoked from PUBLIC and anon, granted to authenticated and service_role as `documents_authorship_fixed` is), `trg_document_version_row_integrity` BEFORE INSERT OR UPDATE FOR EACH ROW on `document_versions`. It judges a signed-in session only — not the contractor door's identity (`CURRENT_USER = 'intake_door'` or the door's bound claims, `20261184`), asked FIRST, before `auth.uid()` is read (`supabase/migrations/20261247_dc_roundG_version_row_integrity.sql:264-270`; see the final fix pass below), and `auth.uid()` set — whichever door the write comes through (PostgREST, an INVOKER function, a DEFINER function such as `publish_revision`). DCK-16: an INSERT that is `'external'`, names an intake link, or names a creator other than the session is refused 42501; an UPDATE that changes `intake_link_id` or `created_by`, or moves `provenance` onto or off `'external'`, is refused 42501.
- Legitimate writers (census `grep -rn 'from("document_versions")' app lib components` + every function body that writes the table, newest definitions): the signed-in INSERTs all name the session as creator (`lib/revisions.ts` submitForReview / createDocumentWithFile / historical import, `lib/documentLifecycle/common.ts`, the library page's bulk import) and none names a link or `'external'`; the only writers of `'external'` rows and links are the intake route (service role — its legacy insert, the withdrawal and its restore, the provenance stamp after a trusted publish) and the door's functions (`intake_door_submit_version` as the role `intake_door`; `intake_door_housekeep` / `_promote` / `_point_pending`); `publish_revision` names `p_actor` = `auth.uid()` for a signed-in caller; provenance declared on a promote (NULL → `'declared'`) and Document Control's verification (`'unverified'` → `'declared'`) never touch `'external'`. Newly refused by design: a signed-in `publish_revision` whose `p_version` names `provenance: 'external'` (no app path sends it).
- The app works before and after the paste: no app path writes a row or change the file refuses (the census test pins it); nothing deploys with it. Paste order: after `20261245` (its prerequisite refuses otherwise, changing nothing); never re-paste `20261214` / `20261205` after it.
- PostgreSQL 16 (I-17 harness, `npm run test:db`; "before" = the replay with 20261247 undone; every case rolled back): `lib/__tests__/rls/dcP33VersionRowIntegrity.test.ts` — the publisher's member-less `'external'` INSERT (creator the link, and NULL with the replay's NOT NULL dropped as live) admitted before / 42501 after; a link alone, the mark alone, another creator — admitted / 42501; the UPDATE re-shape then pointer then promote over the holder's checkout — admitted ×3 before; after, the re-shape 42501 (row unchanged), the pointer lands, the promote 42501 by the lock leg (the row is not in review), pointer on A; each intake column alone by UPDATE (link set, creator, onto `'external'`, off `'external'`, link cleared) — admitted / 42501; `publish_revision` with `'external'` — published / 42501; REGRESSION, same answer both sides: submit for review + race-loser retire, a creation flow's first version, `finalize_reviewed_promote` by a publisher and Document Control (draft approved / released / superseding A, A superseded), the three-step writes + provenance declared, the genuine external submission's Intake-tab approve (door marks kept), the Intake tab's MOC note and reject, void / verification / label / effective date, an ordinary `publish_revision`, the service role's route writes, and the contractor door's writers — `intake_door_submit_version` filing its submission, `intake_door_promote` (a trusted link whose creator is a publisher auto-publishing its own approved document: `published`, `intake_link_stamped` true, the new current row `'external'`, the link, created by the member, superseding A), `intake_door_housekeep` `'retire'` then `'restore'` with the same stamp (back to `in_review`, `superseded_at` NULL) and `'withdraw'` (added at P33's review fix pass); the same retire / restore attempted by a signed-in publisher's direct UPDATE — admitted before, 42501 after. Promote and housekeep run as the function's owner with the door's identity bound in the request claims (`intake_door_bind`), so the guard's claims branch is what exempts them: with the claims branch removed, the promote and restore cases fail on the "after" side (checked by mutation at the review fix pass; not committed). *(Corrected at P33's final fix pass: this line said that on the harness `intake_door_submit_version` takes the bound-claims path too. It did so only AFTER the paste, and only because the paste had broken its role-switch path — see the final fix pass below.)* `intake_door_submit_version` is pinned on both of its paths (final fix pass, `lib/__tests__/rls/dcP33VersionRowIntegrity.test.ts:424-441`): the ROLE-SWITCH path (`intake_door_version_rls_ready()` true — the hosted path; the INSERT as `CURRENT_USER = 'intake_door'`, recorded by a probe trigger) lands as `intake_door` with no WARNING on both sides, as replayed (the role holds no USAGE on schema `auth` here), with that USAGE granted and with it revoked; the BOUND-CLAIMS FALLBACK (readiness made false by a restrictive policy for every role) lands as the service role under the door's claims, no WARNING, on both sides. The file pasted as one script on the "before" copy — seven probes true, five count rows (four before the final fix pass), a re-paste clean, and the inventory counts the forgery signatures only: two drafts retired in review, the door's submission and a trusted auto-publish move only the informational row, a member-created in-review `'external'` row, a released revision relabelled in review and the pending pointer naming it each move their row by one (added at P33's review fix pass); the prerequisite refusing (no lock leg; no door limb) with nothing changed. `lib/__tests__/rls/dcP32PublishGuardLock.test.ts`'s "remainder DCK-16 records" and "…, by UPDATE" now answer admitted before / refused after; "a GENUINE external submission" promotes on both sides. Full harness: 19 files, 272 tests green (276 after P33's review fix pass; 277 after its final fix pass).
- **Final fix pass (2026-10-21) — the door's role-switch path, a regression found and fixed before any paste.** `intake_door_submit_version` (`supabase/migrations/20261214_prj_roundG_intake_door_rls.sql:406-482`) switches to the role `intake_door` for its INSERT where `intake_door_version_rls_ready()` is true (`:420`), and on an `insufficient_privilege` whose message begins "permission denied" it undoes the switch, raises a WARNING and files the row with the bound identity alone (`:467-476`). The column guard as first written read `auth.uid()` in its DECLARE before asking whether the caller was the door; a plpgsql call of `auth.uid()` as `intake_door` needs USAGE on schema `auth`, which `20261184` grants only where it can (`supabase/migrations/20261184_prj_roundG_intake_door_identity.sql:263`, NOTICE and carry on otherwise) and which the replay's `intake_door` does not hold. So after the paste every switched submission hit "permission denied for schema auth" and fell back with a WARNING — the row was still filed, so the earlier harness case (which read only the row) passed. The new case caught it (after side: `as:service_role` with the WARNING; before side: `as:intake_door`, none). Fix: the guard asks for the door's identity FIRST and reads `auth.uid()` only after (`supabase/migrations/20261247_dc_roundG_version_row_integrity.sql:253-271`; the probe at `:359-360` and the shape test `lib/__tests__/dcRoundGVersionRowIntegrityMigration.test.ts:96-110` re-pinned, `auth.uid()` called once in code); the role-switch case now answers the same on both sides, with and without the role's USAGE on `auth`.
- Tests: `lib/__tests__/dcRoundGVersionRowIntegrityMigration.test.ts` (18 after the final fix pass: the door asked before `auth.uid()`, the informational pending-submission row (final fix pass), the inventory's forgery-signature predicates (review fix pass), the base found by scan, nothing removed, every new line the limb, the policy minus the limb = the base byte for byte, the door limb kept, the guard's head / grants / trigger / exemptions / each refusal, nothing else defined, the one-paste shape, counts-only inventory, each prosrc probe true on the body; the app census of `document_versions` writes).

**Done-when.**
- ✓ A signed-in session's INSERT cannot carry `provenance = 'external'`, a non-NULL `intake_link_id`, or a `created_by` other than itself (the door's role and the service role keep writing them) — `document_versions_insert_integrity` re-created from `20261214` with that limb, lineDiff-pinned, DEC-30 one paste, its door limb kept (the J20 forward scan) — and the column guard holds the same on every door (pending the paste). The door's writers keep working on both sides of the harness: `intake_door_submit_version` on both of its paths — the role switch (as `intake_door`, no WARNING, no fallback) and the bound-claims fallback (both pinned at P33's final fix pass, which found and fixed the guard sending the switched INSERT to its fallback) — `intake_door_promote` and `intake_door_housekeep` `'retire'` / `'restore'` / `'withdraw'` (the last four added at P33's review fix pass; the first version pinned only the submit).
- ✓ The same columns cannot be changed by a signed-in UPDATE — the column guard on `document_versions`, shared with `DCK-17` (pending the paste).
- ✓ The harness's "remainder DCK-16 records" and "the remainder DCK-16 records, by UPDATE" answer refused after the paste, and "a GENUINE external submission" still promotes.

**Scope / residual.** `document_versions_update_integrity` (`20261037`) is not re-created: the column guard carries the UPDATE limb (the brief's preferred shape), so the policy's breadth for other columns is unchanged by design. A row already written before the paste is left as it is: the inventory counts rows IN REVIEW that are `'external'` or name a link and whose creator is a member (the door files its submissions with no creator) — expected 0 on legitimate data. *(Corrected at P33's review fix pass: the first version counted every external or link-naming row with a member creator and said "expected 0", but a trusted link's auto-publish — `intake_door_promote` / the route's `publish_revision` fallback, created by the link's creator, then stamped with its link — is exactly that shape, so a live org read a false forgery count. A trusted auto-publish is published, never in review, and is no longer counted.)* A forged row that was already approved or published before the paste cannot be told from a trusted auto-publish by its columns and is not counted. **Residual — DCK-16's own shape written before the paste (recorded on [`DCK-18`](#dck-18), its owner; stated at P33's final fix pass):** writes from the paste on are judged; a door-shaped in-review row a signed-in session wrote BEFORE the paste (`'external'`, the link, created by NULL or the link's id) cannot be told from the door's genuine submission, is not refused or retired by the file, and door (b) can still promote it over a checkout until it is decided, withdrawn or voided. The inventory's row 2 (informational — it counts the genuine pending submissions too) counts the documents whose pending pointer names such a submission, so the operator sees how many pending external submissions there are to look over (`supabase/migrations/20261247_dc_roundG_version_row_integrity.sql:185-196`; header `:115-124`; harness `lib/__tests__/rls/dcP33VersionRowIntegrity.test.ts:499-576`, where a door-shaped row written before the paste moves only the informational rows).

---

<a id="dck-17"></a>

## DCK-17 · A library publisher can relabel an earlier reviewed revision back to "in review" and promote it over another person's checkout — an unrecorded revert the lock leg admits through its roster limb

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (found by the second P32 review, 2026-10-21, on the I-17 PostgreSQL 16 harness before and after `20261245`; pinned by P32's fix pass 3)
- **Locations:** `supabase/migrations/20261037_rp_phase3b_read_ownership_and_version_integrity.sql:177-189` (`document_versions_update_integrity`: its first limb, `user_can_publish_doc(record_id, org_id)`, admits any change to any column of an existing row from a library publisher, in USING and WITH CHECK), `supabase/migrations/20261245_dc_roundG_publish_guard_lock_leg.sql:922-935` (the lock leg's door (b): `COALESCE(v_primary_reqs, 0) > 0` on a pending row still `in_review`), the review gate in the same body (`v_primary_reqs` / `v_signed`: the roster bound to the version, counted in every status), `supabase/migrations/20261151_dc_roundF_promote_transaction_and_hold_override.sql:208-326` (`finalize_reviewed_promote`, the legitimate writer of `review_state 'approved'`, `released_at`, `supersedes_version_id` and the prior's `superseded_at`)
- **Assigned:** proposed — document-control (owner of the review lifecycle these columns record; the policy itself is roles-and-permissions RP phase 3b's, `20261037`); the integrator assigns at the P32 merge (DEC-31). Coordinate with [`DCK-16`](#dck-16) done-when 2 (projects), which needs the same policy or trigger for the intake columns. **Assigned (2026-10-21, the integrator at the P32 merge, DEC-31): document-control P33 VERSION ROW INTEGRITY.**
- **Pending migration:** `supabase/migrations/20261247_dc_roundG_version_row_integrity.sql` — paste AFTER `20261245` (required: its first statement refuses, changing nothing, without `20261245`'s lock leg or `20261214`'s door limb); `20261245` is HOLD behind `20261193` (paste guide row 150; `20261245` is row 187), so this file waits with them. The code half needs no deploy order; what this record closes at the database holds once the file is pasted (DEC-30).

**Mechanism.** The lock leg `20261245` adds to the publish guard admits, over another person's checkout, the promote of the pending draft when that row is still `review_state = 'in_review'` and carries a bound reviewer roster the review gate proved complete (door (b), roster limb). The gate counts the roster bound to the version whatever the row's lifecycle, and no trigger keeps `review_state`, `released_at`, `superseded_at` or `supersedes_version_id`: `document_versions_update_integrity` lets a library publisher rewrite all of them. So any revision that went through review — approved, released, later superseded: ordinary history — can be relabelled `in_review`, pointed at by `documents.pending_version_id` (a pending-pointer change is not judged by the guard) and made current with the pending pointer cleared. Door (b) admits it, the review gate passes it (its old roster is complete), and the holder's checkout is passed with no override reason, no `REV_LOCK_OVERRIDDEN`, no notice, and no new revision — the document silently reverts to an earlier controlled content. It works on every document with a reviewed revision in its history, not only intake-scoped ones. Any extra test on the version row inside the lock leg (`released_at IS NULL`, `superseded_at IS NULL`, `supersedes_version_id = OLD.current_version_id`) reads columns the same publisher can clear first, so it would be forgeable; P32 added none and records the remainder here.

**Failure scenario.** Document D is checked out by a drafter. Its Rev A went through review two years ago (approved, signed roster) and was superseded by Rev B, current. A library publisher who does not hold the checkout sends three PostgREST writes: `UPDATE document_versions SET review_state = 'in_review' WHERE id = A`; `UPDATE documents SET pending_version_id = A`; `UPDATE documents SET current_version_id = A, pending_version_id = NULL`. Each answers ok; Rev A is current again over the drafter's checkout, and nothing records that a checkout was passed or that a revert happened.

**Evidence.** `lib/__tests__/rls/dcP32PublishGuardLock.test.ts` — "the remainder DCK-17 records" (the three writes admitted on both sides of the paste, pointer on A; without the relabel the same promote is refused 42501 after the paste). The only `BEFORE UPDATE` triggers on `document_versions` guard `file_url` (`20261077` `trg_document_version_key_guard`) and `revision_label` (`20261074`); no migration body reads `OLD.review_state` (`grep -ln "OLD.review_state" supabase/migrations/*.sql` returns nothing).

**Done when.**

- [ ] A signed-in session cannot move a `document_versions` row back to `review_state 'in_review'` from `'approved'`, `'rejected'` or `'superseded'`, nor clear `released_at` or `superseded_at` once set, nor change `supersedes_version_id` once set — a column guard trigger on `document_versions` or a narrowed `document_versions_update_integrity`, re-created from its newest body, lineDiff-pinned, DEC-30 one paste. `finalize_reviewed_promote` / `promoteThreeStep` (`in_review` → `approved`, stamping `released_at`, `supersedes_version_id` and the prior's `superseded_at`), a rejection, a resubmission of an author's own still-in-review draft and the intake door keep working (no regression, DEC-90).
- [ ] The harness's "the remainder DCK-17 records" case answers refused (at the relabel, or at the promote) after that paste; "finalize_reviewed_promote by a publisher …" and "a GENUINE external submission" still promote.

**Resolution (2026-10-21, document-control Round G).** P33 VERSION ROW INTEGRITY (assigned at the P32 merge, DEC-31; ruled under DEC-90 — fail-safe, no regression). Reproduced on HEAD `ad9d42b` (P32 harness "the remainder DCK-17 records": the relabel, the pointer and the promote admitted on both sides of `20261245`; P33 harness "before" column for each lifecycle column, and for a reviewed pending draft moved onto another document).
- The column guard of `20261247` (`enforce_document_version_row_integrity()`, shared with `DCK-16`; see its resolution for the function's shape, grants and who it judges) refuses, for a signed-in session, an UPDATE that moves `review_state` INTO `'in_review'` from any other state — `'approved'`, `'rejected'`, `'superseded'`, and also no state at all (a superset of the done-when: no legitimate signed-in writer moves a row into review — submit for review INSERTs a new row; only the intake route's service-role restore of a withdrawn submission does, and it is not judged) — that clears `released_at` or `superseded_at` once set, or that changes `supersedes_version_id` once set (to another revision or to none). One more limb, fail-safe and in this finding's mechanism, found while enumerating: the review gate counts the roster bound to the VERSION id, so a reviewed pending draft (complete signed roster) moved onto another document by `UPDATE … SET record_id` was promoted over that document's checkout through door (b)'s roster limb (reproduced: admitted before) — the guard now also refuses a change of `record_id` / `org_id` (no writer moves a revision between documents; the cascades delete rows, they do not move them).
- Every lifecycle transition the app and the RPCs make today, enumerated and pinned on the I-17 harness before and after: submit for review (INSERT, `in_review`, superseding the live revision) and its race-loser retire / a resubmission's retire of the earlier draft (`superseded_at` stamped); `finalize_reviewed_promote` (SECURITY INVOKER — judged, and admitted: `in_review` → `approved`, `released_at` stamped, `supersedes_version_id` written with the value submit / the door already gave it, the prior's `superseded_at` stamped) by a publisher and by Document Control; `promoteThreeStep`'s relabel and supersede; the Intake tab's approve (the same promote) and reject (`in_review` → `rejected`, with its reason); void pending draft; provenance declared / verified; label correction; effective date; `publish_revision` (it stamps the prior's `superseded_at`); the contractor door and the intake route (not judged). `supersedes_version_id` never changes in a legitimate promote: `finalizeReviewedRevision` refuses a draft whose recorded base is not the current revision (`stale_base`, REV-5), so the relabel writes the value already set (or sets it from NULL for an intake draft that recorded none) — pinned by the census test. `put_back_retired_issue`, `restore_reversed_source` and the reversal doors write `documents`, never `document_versions` (scan of every function body that writes the table: `finalize_reviewed_promote`, `publish_revision`, `intake_door_submit_version`, `intake_door_housekeep`, `intake_door_promote`, `revup_rollback_orphan`). Newly refused by design: `revup_rollback_orphan`'s clear of a sibling's `superseded_at` for a signed-in caller (no app caller since REV-8).
- The app works before and after the paste (no app path writes a change the guard refuses); paste after `20261245`.
- PostgreSQL 16 (`lib/__tests__/rls/dcP33VersionRowIntegrity.test.ts`): the relabel of the reviewed, superseded revision then pointer then promote over the holder's checkout — admitted ×3 before (pointer on A); after, the relabel 42501, the promote 42501 by the lock leg, pointer on B; back into review from approved, rejected, superseded and no state (a publisher; Document Control) — admitted / 42501; `released_at` cleared, `superseded_at` cleared, `supersedes_version_id` cleared / changed (an internal draft, the door's submission) — admitted / 42501; the reviewed pending draft moved onto another document then promoted over its checkout — admitted ×3 before; after, the move 42501 and nothing promoted; the regression cases listed under `DCK-16` — the same answer on both sides. `lib/__tests__/rls/dcP32PublishGuardLock.test.ts` "the remainder DCK-17 records" now answers admitted before / refused after (the relabel at the guard, the promote at the lock leg); "finalize_reviewed_promote by a publisher …" and "a GENUINE external submission" still promote on both sides.
- Tests: `lib/__tests__/dcRoundGVersionRowIntegrityMigration.test.ts` (the DCK-17 limbs pinned to the body, six refusals, no limb that refuses a forward move).

**Done-when.**
- ✓ A signed-in session cannot move a row back to `in_review` from `'approved'`, `'rejected'` or `'superseded'`, nor clear `released_at` or `superseded_at` once set, nor change `supersedes_version_id` once set — a column guard trigger on `document_versions` (new; nothing re-created for it), lineDiff-pinned where it re-creates (the insert policy), DEC-30 one paste; `finalize_reviewed_promote` / `promoteThreeStep`, a rejection, a resubmission of an author's own draft and the intake door keep working (harness, both sides; for the door: `intake_door_submit_version`, and — added at P33's review fix pass — `intake_door_promote` and `intake_door_housekeep` `'retire'`, `'restore'` (which clears `superseded_at` and moves `superseded` → `in_review`, both refused to a signed-in session) and `'withdraw'`, exempt by the door's bound claims) — pending the paste.
- ✓ The harness's "the remainder DCK-17 records" answers refused after the paste (at the relabel, and at the promote); "finalize_reviewed_promote by a publisher …" and "a GENUINE external submission" still promote.

**Scope / residual.** Rows already relabelled before the paste are not rewritten: the inventory counts revisions in review that are already RELEASED (a draft in review is never released), and pending pointers naming one — expected 0 on legitimate data. *(Corrected at P33's review fix pass: the first version also counted in-review rows with `superseded_at` set and said "expected 0", but every draft voided, replaced by a resubmission, lost to a race or withdrawn while in review keeps `in_review` with `superseded_at` stamped — a legitimate retire, already surfaced as `pending_on_retired_version_count` since `20261105` — so a live org read false forgery counts.)* A relabel of a revision that was never released (a rejected draft put back into review) leaves no signature in the row and is not counted. The guard judges a signed-in session; the service role and the door's identity write lifecycle columns as before (the intake route restores a withdrawn submission to review).

---

<a id="dck-18"></a>

## DCK-18 · A reviewed promote made outside the app over another person's checkout is neither told nor recorded — the notice and the row are the app's

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED (found by document-control Round G P33 while closing [`DCK-15`](#dck-15), 2026-10-21)
- **Locations:** `lib/reviewControl.ts` (`finalizeReviewedRevision` → `notePromoteOverCheckout`, after the promote), `supabase/migrations/20261151_dc_roundF_promote_transaction_and_hold_override.sql:208-326` (`finalize_reviewed_promote`, granted to `authenticated`), `supabase/migrations/20261245_dc_roundG_publish_guard_lock_leg.sql:911-940` (the lock leg's door (b))
- **Assigned:** proposed — document-control (owner of the review promote and its record); the integrator assigns (DEC-31). **Assigned (2026-10-21, the integrator at the P33 merge, DEC-31): document-control P35 DOOR B RECORD** — ruled under DEC-90: record the pass and notify the holder in the database (finalize_reviewed_promote re-created from its newest body), and confirm or retire every pre-paste door-shaped pending submission (20261247 inventory row 2).

**Mechanism.** `DCK-15`'s notice to the holder and its `REVIEW_PROMOTED_OVER_CHECKOUT` (`via: "review_promote"`) row are written by `finalizeReviewedRevision` after the promote lands, as the P33 brief ruled (app-side, never blocking). The database admits the same promote without the app: someone with publish authority may call `finalize_reviewed_promote` through PostgREST (it is granted to `authenticated`) or make the three-step PATCH by hand, and door (b) of the lock leg admits it over another person's checkout when the pending draft is genuinely reviewed (ratified under DEC-90). Such a promote is neither told to the holder nor recorded; and a notice or a row the app fails to write is only logged. After `20261247` the rows door (b) admits cannot be forged by a signed-in session (`DCK-16`, `DCK-17`), so what goes untold is a genuine reviewed promote.

**Failure scenario.** A publisher finalizes a fully signed 2A by calling `finalize_reviewed_promote` from a script while a field engineer holds the document checked out. The revision lands; the engineer is not told; the history shows the promote but not that a checkout was passed.

**Evidence.** `lib/__tests__/dcRoundGReviewPromoteOverCheckout.test.ts` pins the app's notice and row; no function body in `supabase/migrations` writes `REVIEW_PROMOTED_OVER_CHECKOUT` (or any row with `via` `'review_promote'`) (`grep -n "review_promote" supabase/migrations/*.sql` names only the REV-20 hold record and its probe).

**Done when.**

- [ ] A reviewed promote over another person's checkout records the pass in the promote's own transaction whichever caller ran it (e.g. `finalize_reviewed_promote` re-created from its newest body writing the row as it writes `REV_HOLD_OVERRIDDEN`, and the three-step write refused over a foreign checkout or recorded by the guard), with the app's row not doubled.
- [ ] The holder is told of a promote the app did not run (a database-side notice, or a reconcile that reads the record).
- [ ] DCK-16's residual (recorded here at P33's final fix pass): a door-shaped in-review row a signed-in session wrote BEFORE `20261247` (`'external'`, the link, created by NULL or the link's id) cannot be told from the door's genuine submission and stays promotable by door (b) over a checkout until it is decided, withdrawn or voided. Done when every submission pending at the paste (`20261247`'s inventory row 2, informational) has been confirmed as the door's or retired, or door (b)'s intake limb admits only a submission the database can vouch for (for example a marker only the door's functions write).


**Partial (2026-10-21, document-control Round G).** P35 DOOR B RECORD (assigned at the P33 merge, DEC-31; ruled under DEC-90 — fail-safe, no regression; door (b) stays finishable). Reproduced on HEAD `803ec64`: no function body in `supabase/migrations` wrote `REVIEW_PROMOTED_OVER_CHECKOUT` (the newest `finalize_reviewed_promote` was `20261151`'s, `:208-326`, which reads no checkout), and on the I-17 PostgreSQL 16 harness a publisher's direct call of `finalize_reviewed_promote` over the holder's checkout promoted with no notice row and no audit row (`lib/__tests__/rls/dcP35DoorBRecord.test.ts`, "THE DEFECT, closed" — the "before" side). What landed:
- `supabase/migrations/20261252_dc_roundG_door_b_record.sql` (pending paste; DEC-30 one paste) re-creates `finalize_reviewed_promote` from its NEWEST body (`20261151`, found by scanning; lineDiff + exact cut: every base line kept but the last parameter's, which gains a comma). In the promote's own transaction, when the document was checked out by someone other than the actor (`COALESCE(auth.uid(), p_actor)`; the checkout read right after the promote matched, which writes no checkout column — the row's values before it, the row locked by the promote; `:283-291`), it queues the holder's notice of the EXISTING kind `revision_published_over_checkout` (no new kind; `notification_kinds()` untouched; `:357-376`) and writes a `REVIEW_PROMOTED_OVER_CHECKOUT` audit row with `details.via = 'database'` naming the holder, the versions and whether the holder was told (`:377-393`). Each write is its own sub-block: one that cannot be written is a WARNING and the promote stands — never a refusal (ruling (1)). Both are written as the caller, as the app's own notice and record are: `SECURITY INVOKER` is kept (the publish guard and the row-level policies still decide the promote as the caller's own UPDATE); the notice passes the notification insert rails (`20261160`: the signed-in member is its actor, a declared kind, an app-relative link, no server watermark key; a recipient who is no longer an active member is skipped), the record is the session's own row in its own org (`audit_logs_insert`); the service role names `p_actor`. One DEFAULTed argument, `p_report_over_checkout` (false): asked, the answer is `'promoted_clear'` or `'promoted_over_checkout'` + `'_recorded'` / `'_told'` (`:399-407`); not asked, exactly `'promoted'` / `'no_match'` as before. The seven-argument form is dropped first, so ONE signature remains (a call by five or seven named arguments resolves to it unchanged). Grants restated: `search_path` pinned; EXECUTE revoked from PUBLIC and anon, granted to authenticated and service_role.
- `lib/reviewControl.ts` (dedupe only, ruling (2)): `promoteReviewedDraftAtomically` asks for the report (`:1236`) and, on PGRST202 / 42883 (a database before `20261252` — no such argument), calls again with exactly the arguments it always sent (`:1240`; before `20261151` the same "no such function" again → the three-step promote, as before). New exported `readPromoteReport` / `PromoteReport` (`:1200-1213`). `finalizeReviewedRevision` passes the report to `notePromoteOverCheckout` (`:1030`), which then writes only what the database did not: nothing at all for `'promoted_clear'` (the database read the checkout inside the promote and nobody else held it, `:1141`), no second notice when told (`:1166`), no second record when recorded (`:1177`); the holder's checkout-thread note (which the database does not write) is still posted. With no report (a plain `'promoted'`, the three-step path) the app writes both exactly as since P33. A checkout the database saw but the app's earlier read did not is re-read and covered.
- Before / after the paste: before, the reporting call answers PGRST202 / 42883 and the app calls exactly as before — today's behaviour; after, the database records and tells and the app writes only what is missing. **Deploy order:** the app carrying P35 BEFORE or WITH the paste (an app before P35 keeps working after the paste — its plain `'promoted'` is unchanged — but writes its own notice and row too, so the pass is recorded and told twice until the deploy: over-recording, never under). **Paste order:** after `20261247` (required; the prerequisite refuses, changing nothing, without its column guard or `20261151`'s function), so it waits behind row 191; never re-paste `20261151` after it.
- PostgreSQL 16 (I-17 harness, `npm run test:db`; "before" = the replay with `20261252` undone — the eight-argument function dropped, `20261151`'s body and grants put back; every case rolled back): `lib/__tests__/rls/dcP35DoorBRecord.test.ts` (12) — a publisher's direct call over the holder's checkout: promoted on both sides, `0|0` rows before / one record and one notice after (the record: the publisher, their email, `via database`, the holder, `Holder Person`, the versions, `holderNotified true`; the notice: the actor, the title / body / link / `via database`); the same for Document Control and for the Intake tab's approve of a genuine external submission; the reporting call → `'promoted_over_checkout_recorded_told'` after, 42883 before with nothing moved; REGRESSION, the same answer on both sides with no row: the holder's own promote, an unlocked document (`'promoted_clear'` when asked), a compare-and-set that matches nothing (`'no_match'`), a promote the guard refuses (an active hold, no force — rolled back); the service role naming `p_actor` (recorded as that actor), naming the holder (no pass), naming nobody (the record names no person); FAIL-SAFE: a notice refused → the promote stands, the WARNING names it, the report says `'promoted_over_checkout_recorded'`; a record refused → `'…_told'`; both → `'promoted_over_checkout'`; a holder no longer an active member → recorded, not told; the remainder pinned: the hand three-step PATCH over the checkout lands on both sides and records nothing; the file pasted as ONE script on the "before" copy — six probes true, five count rows, a re-paste clean, the header's two queries count and list the same rows (the route-recorded submission counted, the unrecorded one listed); the prerequisite refusing without `20261247`'s guard, nothing changed. Full harness: 21 files, 302 tests green (the P32 and P33 harness files included — their finalize cases now also write the record, which they do not read).
- Tests (default suite): `lib/__tests__/dcRoundGDoorBRecordMigration.test.ts` (19: the base found by scan, lineDiff, exact cut, the order of the blocks, INVOKER kept, the condition, the two sub-blocks with their WARNINGs and no RAISE EXCEPTION, the existing kind and the rails' terms, the record's action and keys, the answer only when asked, the drops before the create, the grants, nothing else defined — the publish guard not re-created, the one-paste shape, counts-only inventory, every prosrc probe on the body, the header's queries read-only, the app's call and retry); `lib/__tests__/dcRoundGReviewPromoteOverCheckout.test.ts` (+8: the report asked; each of the four over-checkout answers writes exactly the missing legs; `'promoted_clear'` writes nothing; a checkout only the database saw; before the paste the retry carries the old arguments and the app writes both; a plain `'promoted'` from an app-before-P35 world; `readPromoteReport` against the migration's tokens, and an unknown answer never read as published); `lib/__tests__/dcRoundFPromoteTransaction.test.ts` (the call's arguments now carry the report flag; +1: before the paste the retry is exactly five / seven arguments; the flag-setter census admits `20261252`'s two set / clear lines, byte for byte the base's).

**Done-when.**
- ✗ (in part) A reviewed promote over another person's checkout records the pass in the promote's own transaction whichever caller ran it, with the app's row not doubled — ✓ for every call of `finalize_reviewed_promote` (the app, a direct PostgREST request, the service role), recorded in its own transaction and deduped against the app's (`20261252` + `notePromoteOverCheckout`, pending the paste); **not done for the three-step PATCH sent by hand**, which the publish guard admits as door (b): recording it needs the guard (`enforce_document_publish_guard`, newest `20261245`) re-created to write a row, and DEC-90's ruling (3) for this package records it as a remainder rather than add a writing trigger that could break a legitimate write. Remainder owner: document-control, at the next re-creation of the publish guard (the integrator assigns, DEC-31). The app never sends it except on a database without `finalize_reviewed_promote` (before `20261151`), and then records it itself, as since P33.
- ✗ (in part) The holder is told of a promote the app did not run — ✓ for `finalize_reviewed_promote` called outside the app (the database's notice, in the promote's transaction); not for the hand three-step PATCH (the same remainder and owner as above). The checkout-thread note stays app-side.
- ✗ Every submission pending at `20261247`'s paste (its row 2) confirmed as the door's or retired — the means are delivered, the act is the operator's: `20261252`'s result set counts them, split by whether the intake route's own `INTAKE_SUBMISSION` record (server-written, no person named — a row a signed-in session cannot write) names the version (rows 3-5, counts only); the header carries two read-only queries the operator runs themselves (counts, then the list of the ones to look over, never in the paste result); each is confirmed by approving it from its project's Intake tab or retired there with Reject — the existing path (`components/projects/IntakePanel.tsx` `reject`: in_review → rejected with a reason, the pending pointer cleared, sign-offs voided, `INTAKE_REJECTED` recorded; it works the same after `20261247`, pinned there). No new write path. The alternative (door (b)'s intake limb admitting only a submission the database can vouch for) needs the publish guard re-created — not this package's file. Owner of the act: the operator at the paste of `20261252`, who tells the integrator the counts (expected 0 to look over on legitimate data); the integrator records it here.

**Scope / residual.** OPEN until (a) the hand three-step remainder is recorded by the guard (owner: document-control, next publish-guard re-creation) and (b) the operator's look-over of the pending door-shaped submissions is recorded. `20261252` pending paste (after row 191). For the integrator at merge (not edited here): the `20261252` row in `MIGRATION-PASTE-ORDER.md` (after `20261247`; deploy the app with or before it); no `lib/schemaExpectations.ts` probe is needed (the app tolerates both signatures by its PGRST202 / 42883 retry; the file's own result set is the paste check); no new table, no new notification kind, no new audit action.

---
