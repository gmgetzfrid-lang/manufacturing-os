# 02 · Safety, compliance & the record

The PSSR, turnover and closeout surfaces — where a false green is the failure
that matters — plus the audit trail that is supposed to prove what happened.

**18 findings** — 6 CRITICAL, 7 HIGH, 5 MEDIUM (`SAF-18` opened by projects-joint J12, 2026-10-01, as `GAP-402`'s remainder).

> Line numbers are from commit `6a14d7d` and drift with edits. **Match on the
> quoted code, not the number.** See [`../README.md`](../README.md) for the
> resolution protocol.

---

## SAF-1 · A contractor's self-typed filename can turn a PSSR item green

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** safety
- **Locations:** `lib/checklists.ts:250-266` — `gatherProjectEvidenceState`
- **Re-verified:** hardening pass — **SURVIVES**. `documentTitles` is assembled from `documents.title ?? name` across the project's intake collection and turnover items (`checklists.ts:257-266, 275-281`) and handed to `runAutoEvidence`, described in its own docblock as *"the deterministic sweep: gather what the platform can prove."* For an intake-submitted document that title is the contractor's filename.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Correct, and nothing upstream filters on review_state, pending_version_id or document status — an unreviewed Draft from an unauthenticated link is indistinguishable to the sweep from an approved controlled document. The satisfied item then counts toward setChecklistStatus's completion gate (checklists.ts:219). Mitigations exist but do not prevent the false green: an internal user must click the sweep, and the citation renders as a chip titled "Found by the evidence sweep" (QualityTab.tsx:459-461). CRITICAL stands for a PSM compliance record.

**Mechanism.** The evidence gather pulls document titles with no filter on
status, revision, review state, effective date, or equipment identity:

```ts
const docs = await safe(
  supabase.from("documents")
    .select("title, name, document_number")
    .eq("collection_id", collectionId).limit(500)
);
```

The matching itself is careful — `firstDocMatch` uses whole-word regexes
specifically so "under" cannot match "NDE", and there is a regression test
pinning that. What is missing is any check on the document's *standing*.

**Failure scenario.** A contractor uploads a file and types the title
"Hydrotest Report." It lands in the project's intake collection as a `Draft`,
unreviewed, from an unauthenticated link. The evidence sweep matches the
phrase, marks the pressure-test checklist item **satisfied**, and attaches the
citation *Document on file: "Hydrotest Report"*. Nobody checked that the
document contains a hydrotest, covers this equipment, or has been reviewed by
anyone.

The module header at `lib/checklistEngine.ts:69` promises the opposite:
"Deliberately conservative: a weak match yields needs_evidence, never a false
green."

**Remediation.**
1. Filter the gather to documents that are `Issued` (or otherwise
   review-complete) with a non-null `current_version_id`. A `Draft` must never
   be citable evidence.
2. Exclude documents whose provenance is `external` and whose version is not
   approved.
3. Where the checklist item names equipment, require the document to be linked
   to that asset via `document_assets` rather than matching on title text alone.
4. Render the cited document's status on the evidence chip so a reviewer can
   see what backs the green.

**Done when.**
- A `Draft` document cannot satisfy any checklist item.
- An externally-submitted, unapproved document cannot satisfy any checklist item.
- The evidence chip shows the cited document's status and revision.
- A test pins "unreviewed draft with a matching title does not satisfy."

**Resolution (2026-09-29, projects Round G — with PC QUAL-1 / QUAL-13; GAP-404 acceptance 1).** The evidence register has a contract. `gatherProjectEvidenceState` (`lib/checklists.ts`) selects `id, title, name, document_number, status, rev, current_version_id` and admits a document only when `status ∈ EVIDENCE_DOCUMENT_STATUSES` (`Issued`, `Locked`), `NOT_CURRENT_STATUSES` (`lib/aiBoundary.ts`) does not hold it, and `current_version_id` is set; it then reads `document_versions` for the admitted documents' CURRENT version ids (`.in("id", currentVersionIds)`) and drops a document whose current version has `provenance = 'external'` without `review_state = 'approved'` — an earlier rejected submission does not taint an approved or internal current revision, and a failed version read fails closed (nothing whose current version could not be checked is admitted). *Review fix (projects Round G):* the first build keyed the filter on every external version of the document, so a document with an approved current v2 was dropped for an unapproved v1. A Draft — a contractor's self-typed filename — never reaches `documentTitles`, so `firstDocMatch` (byte-identical) cannot cite it. Documents on accepted turnover items are admitted first (QUAL-13). Every auto chip carries the `documentId` it matched (QUAL-1), and `EvidenceChip` in `components/projects/QualityTab.tsx` renders the cited document's current status and revision — rose when it has since left Issued/Locked; a cited document the viewer cannot read (ACL-restricted for them — the lookup runs under their RLS, SEC-10's service-role read is not here) reads `· not visible to you`, never "not found". Tests: `lib/__tests__/checklists.test.ts` `"an unreviewed Draft with a matching title does NOT enter the register; Void / Superseded / no-current-version are out too"`, `"an external (intake) submission counts only once its version is approved"`, `"judged on the CURRENT version: an earlier rejected external submission does not taint an approved or internal current revision"`, `"a failed version read fails CLOSED…"`; `lib/__tests__/projectControls.test.ts` `"QUAL-1: satisfy on a matching title…"` (documentId on the chip). Reproduced first: the pre-fix gather selected `title, name, document_number` with no status filter (the register query at :258).

*Second review fix (projects Round G).* (1) The provenance check failed OPEN per document: a document whose current version did not come back from an otherwise successful read (hidden by `document_versions`' own policy, or missing) was admitted with its provenance never checked. `gatherProjectEvidenceState` now keeps the set of version ids the read returned and drops every document whose current version is not in it, exactly as a failed read drops all of them. Test: `lib/__tests__/checklists.test.ts` `"a document whose current version did not come back is NOT admitted — its provenance was never checked (fails closed per document)"`. (2) **Departure from the P2 brief's default, recorded for the orchestrator to accept.** The brief's evidence-contract default was "a filename/title match is a proposal rendered as 'suggested', never green". What landed: a title match INSIDE the admitted register (Issued / Locked, a current version, approved if it is an external submission) is a MACHINE green — labelled "Machine-verified (evidence sweep) — not a human sign-off", withdrawn when its document leaves the register, re-checked when "Mark complete" is clicked (QUAL-1), and never citable, because a completion that contains one is recorded `'auto'` by the database until a person verifies it (QUAL-2). A PSSR can therefore still be completed on machine greens: the basis restricts citation, not completion. The stricter options — render such a match as "suggested" until ✓ Verify, or refuse "Mark complete" while the basis would be `'auto'` — are recorded in DEC-52 as the reversal if the facility wants them.


**Done-when.**
- ✓ A `Draft` document cannot satisfy any checklist item.
- ✓ An externally-submitted, unapproved document cannot satisfy any checklist item.
- ✓ The evidence chip shows the cited document's status and revision.
- ✓ A test pins "unreviewed draft with a matching title does not satisfy."

**Scope / residual.** The departure above (a title match inside the register is a labelled, non-citable machine green, not a "suggested" state) awaits the orchestrator's acceptance. Remediation item 3 (require a `document_assets` link when the item names equipment) is not built — the register is status- and provenance-gated, the match is still title-based within it; recorded in DEC-52 as a follow-on. The AI assessment's context (`app/api/projects/checklist/route.ts` :129) still lists intake titles as *context* for the model's applicability proposal — a proposal, never a green.

---

## SAF-2 · The AI can mark thirty of forty PSSR items not-applicable behind one count-only confirmation

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** safety
- **Locations:**
  - `components/projects/QualityTab.tsx:293-319` — the confirm and apply
  - `lib/checklists.ts:150-176` — `applyAssessment`
- **Related:** `SAF-4` (the manual-note immunization), `PERF-7` (the sequential writes)
- **Re-verified:** hardening pass — **SURVIVES**, and the confirm text is the evidence. The proposals carry a `rationale` per item, and the dialog says only *"proposes applicability for N items (M look not-applicable to this job, with reasons attached). Apply it?"* — the reasons are never rendered. One click applies all.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The headline mechanism is real — one count-only confirm bulk-writes every proposed N/A. Two supporting claims in the report are false: applyAssessment does not set manual_note (so the 'immunized from every future pass via checklistEngine.ts:141' chain is wrong — the sweep skips those items only because they are already na), and the checklist does not 'jump to complete' (setChecklistStatus at checklists.ts:216-221 still requires every non-na item satisfied). Real but over-stated: HIGH.

**Mechanism.** The confirmation dialog reports counts only — "(N look
not-applicable to this job, with reasons attached)" — and then writes all of
them. It does not show which items, or their rationales, before writing. The
rationales are visible only afterwards, one at a time, inside an expanded card.

**Failure scenario.** A rookie clicks OK and thirty safety lines go
not-applicable sight-unseen. Because a not-applicable item is excluded from the
progress count (`computeChecklistProgress`, `lib/checklists.ts:339`), the
checklist jumps to complete. And because the write sets a manual note, no
future sweep or assessment will ever revisit those items
(`lib/checklistEngine.ts:141` — `if (item.manualNote) continue`).

**Remediation.** Replace the count-only confirm with a review step that lists
every proposed N/A with its item text and the AI's stated rationale, each
individually checkable, defaulting to **unchecked**. Apply only what the human
ticked. Keep the existing "a human already decided this" skip.

**Done when.**
- No item can be set N/A by the bulk path without appearing individually in a review list.
- The default state of the review list applies nothing.
- The applied set is recorded in the audit row by item id, not just by count.

**Resolution (2026-09-29, projects Round G — with PC QUAL-5; GAP-404 acceptance 2).** The count-only confirm is gone. `assess()` in `components/projects/QualityTab.tsx` now opens `AssessmentReview`: every proposal listed with its item text, section, the AI's rationale and the item's current state, each with its own checkbox, all UNTICKED by default; "Tick every applicable proposal" and "Clear" are explicit actions; Apply is disabled at zero ticked and writes only the ticked ids. `applyAssessment` (`lib/checklists.ts`) takes `confirmedItemIds` and skips every proposal not in it (`skippedUnconfirmed`) — a call with none writes nothing and audits nothing. The `CHECKLIST_ASSESSED` audit row carries `items[]` (`itemId`, prior and new `applicability`/`status`) plus the tallies. The human-decided skip (`manual_note`) is kept, and QUAL-5's protection (never N/A a satisfied or evidence-bearing item) rides the same list. Tests: `lib/__tests__/checklists.test.ts` `"a count-only call (no confirmed ids) writes NOTHING and audits nothing"`, `"writes only the ticked ids…"` (audit `items` by id). Reproduced first: the pre-fix `applyAssessment` wrote every proposal in the array behind `appConfirm`'s count text.

*Second review fix (projects Round G).* "Tick every applicable proposal" ticked every proposal the assessment made — N/As included — in one click, so an MI checklist could be N/A'd end to end without a person looking at a line, and the completion then counted as human sign-off (QUAL-2). The control is now "Tick every in-scope proposal" and never ticks an N/A: every N/A the assessment writes was ticked individually, and the review says so ("N/A proposals are ticked one by one. An applied N/A carries no reason of yours, so a checklist completed with it is recorded as auto until you confirm it on the item"). The applied N/A is stamped with the machine actor and no note, and a completion containing it is `'auto'` — not citable — until a person gives it a reason with ✓ Confirm N/A (QUAL-2; the database computes the basis).


**Done-when.**
- ✓ No item can be set N/A by the bulk path without appearing individually in the review list.
- ✓ The default state of the review list applies nothing.
- ✓ The applied set is recorded in the audit row by item id, not just by count.

**Scope / residual.** The finding's claim that the bulk write sets `manual_note` was already refuted by the verifier; it still does not — an assessment N/A stays machine territory (stamped `AI assessment`, QUAL-6): the sweep skips it because it is `na`, and it is NOT a person's decision — a completion containing one is recorded `'auto'` until ✓ Confirm N/A gives it a person's reason (second review fix; the first wording implied the per-item tick made it one).

---

## SAF-3 · A write denied by row-level security reports success and writes an audit row claiming it happened

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** audit integrity / safety
- **Locations:**
  - `lib/checklists.ts:204, 226` — `updateChecklistItem`, `setChecklistStatus`
  - `lib/turnover.ts:207, 275` — `reviewTurnoverItem`, punch status
  - `lib/costs.ts:111-116` — `addEntry` audit
  - Contrast: `lib/changeOrders.ts:151-161`, which gets it right
- **Re-verified:** hardening pass — **SURVIVES**. `const { error } = await supabase…update(…)` **is** checked, but an RLS denial is not an error — PostgREST filters the row out and returns `{data: null, error: null}`, so the function proceeds to write the audit row and return `{ok: true}`. Confirmed at both cited sites (`checklists.ts:204, 226`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the scenario is reachable: supabase/migrations/20261013_project_controls_program.sql:273-282 gives ordinary active members SELECT only, with UPDATE limited to `is_org_controller(org_id) OR user_owns_project(project_id)` — a non-owner member's UPDATE is filtered to zero rows, which PostgREST reports as `{data:null,error:null}`. One citation is weak: lib/costs.ts:111-116 is the audit helper, and the real write (addEntry, costs.ts:226-239) is an INSERT with `.select("id").single()`, which DOES error under RLS — that site does not demonstrate the bug.

**Mechanism.** PostgREST returns `{ data: null, error: null }` for an UPDATE
that matched zero rows because a policy filtered it out — success with nothing
changed. None of the decision paths check the affected row count before writing
their audit entry. `decideChangeOrder` does check, and its comment explains
exactly why.

**Failure scenario.** A user without write authority accepts a turnover item.
The interface says accepted. The audit log says accepted, by them, at that
time. The database still says open. The record and the reality disagree, and
the record is the one that gets exported.

**Remediation.** Apply the `decideChangeOrder` pattern everywhere a decision is
recorded: add `.select("id")` to the update, require a non-empty result, and
return a distinct "you do not have permission, or someone else changed this"
error when it is empty. Only write the audit row after a confirmed match.

**Done when.**
- Every decision write in `checklists.ts`, `turnover.ts` and `costs.ts` verifies the row count.
- A zero-match write returns an error and writes no audit row.
- A test simulates the zero-match case for at least one path per file.

**Partial (2026-09-29, projects Round G — the costs / changeOrders half; the ID closes in P2/J2 QUALITY, which ships the shared helper and the checklists / turnover sites).** Joint J3 MONEY-LEDGER. Every decision-shaped UPDATE in `lib/costs.ts` is now a checked write in `decideChangeOrder`'s own pattern (`lib/checkedWrite.ts` was not merged at the base commit, so the OWN-14 inline shape is used — `.select("id")` + row-count; PC-5's census can pick the file up): `voidEntry` (predicate carries `status = 'posted'`, so a second void is a zero-row match), `saveAccount` (update branch) and `saveParty` (update branch) return `NO_ROW_MATCHED` — "You do not have permission to change this record, or someone else changed it first — refresh" — and write NO audit row on zero rows. `lib/changeOrders.ts`'s compensating revert (`revertDecision`) and the `posted_entry_id` link write are checked too (`COST-11`), and `unwindChangeOrder` claims the CO with `.eq("status", "approved")`. `lib/costDocs.ts`: `voidCostDoc` / `setManualTotal` are checked through the status-predicate UPDATE (`MON-3`), `revertDocTransition` and the rival-decline are checked (`MON-1`, `COST-11`). The audit helpers in both files LOG a failed insert instead of discarding it.
- Tests: `lib/__tests__/costDocs.test.ts` — "a zero-row void (RLS-filtered) returns the permission-or-changed error and writes NO audit row", "a zero-row account update is refused before its audit row".
- Reproduced at the base commit: `voidEntry` was `.update({ status: "void" }).eq("id", …)` with the audit row written on `error == null`.

**Done-when.**
1. ✓ for `costs.ts` (every decision write verifies the row count); `checklists.ts` / `turnover.ts` are J2's.
2. ✓ for the money sites — a zero-match write returns an error and writes no audit row.
3. ✓ A test simulates the zero-match case for `costs.ts` (two paths).

**Scope / residual.** `addEntry` and the insert branches were already erroring under RLS (`.single()` on an insert) — unchanged. Status stays OPEN for J2's half.

**Partial (2026-09-29, projects Round G — GAP-402 narrow).** The helper and the quality sites. New `lib/checkedWrite.ts`: `checkedWrite(q)` takes a chain ending in `.select("id")`, requires a non-empty match, and returns `{ ok: true, ids }` or a typed failure — `refused` ("Nothing was changed — you don't have permission…, or someone else changed it first") for the RLS zero-row shape, `db` with `describeWriteError` (a missing table or column — 42P01 / 42703, or PostgREST's schema-cache PGRST205 / PGRST204 — → "needs the latest database migration", 42501 / RLS text → "don't have permission", else the message) — never throwing raw Postgres text; the shape mirrors OWN-14 (`lib/ownership.ts` `setLibraryOwnerTeam`). Every decision write in `lib/checklists.ts` (`createChecklist` items + rollback, `applyAssessment`, `updateChecklistItem`, `setChecklistStatus`, `runAutoEvidence`) and `lib/turnover.ts` (`seedTurnoverItems`, `addTurnoverItem`, `reviewTurnoverItem`, `reopenTurnoverItem`, `addPunchItem`, `setPunchStatus`; the client review-event insert was removed by the QUAL-11 second review fix — the database writes the history) goes through it and writes its audit row only after a confirmed match. Census: `lib/__tests__/checkedWrite.test.ts` fails when an `.update(` / `.delete(` on a supabase chain in `lib/checklists.ts` or `lib/turnover.ts` is not inside `checkedWrite(...)`, and when either file re-grows the `const { error } = await supabase…update(` shape; for `lib/costs.ts`, `lib/costDocs.ts`, `lib/changeOrders.ts` it RATCHETS (3 / 5 / 3 unchecked sites at 8276cad — may fall, never rise). Tests: `lib/__tests__/checklists.test.ts` `"an RLS-refused override returns the refusal and writes NO audit row"`, `"a refused write (RLS zero rows) reports an error and writes no audit row"` (assessment), `"a refused status write reports the refusal and audits nothing"`, `"an RLS-refused sweep writes no audit row"`; `lib/__tests__/turnover.test.ts` `"an RLS-refused decision returns the refusal and writes NO audit row (SAF-3)"`, `"a refused reopen audits nothing"`, `"a refused seed…"`, `"an RLS-refused close…"`. Reproduced first: the memory stand-in answering `{ data: [], error: null }` made the pre-fix `reviewTurnoverItem` return `ok: true` and write `TURNOVER_REVIEWED`.

**Done-when.**
- ✓ `checklists.ts` and `turnover.ts` — every decision write verifies the row count. ✗ `costs.ts` (and `changeOrders.ts` / `costDocs.ts`): J3 MONEY-LEDGER's (PC-7) sites; the ratchet in the census holds their count at the baseline until J3 converts them. This record stays OPEN for that half.
- ✓ A zero-match write returns an error and writes no audit row (on every quality path).
- ✓ Tests simulate the zero-match case per file — `checklists.ts` and `turnover.ts` here; `costs.ts` with J3.

**Scope / residual.** `audit()` in both files stays best-effort (a failed audit insert never blocks the decision it follows — that is PERS-7 / EVID-6's question in drafting-flow, not this one). Remaining for SAF-3: the three money files (J3), after which the census ratchet can drop to zero and this record flips to RESOLVED.


**Integration (2026-09-30, projects Round G — J2 merged onto J3).** The two halves above meet every Done-when item together:
- [x] Every decision write in `checklists.ts` and `turnover.ts` goes through `checkedWrite` (J2). Every decision write in `costs.ts`, `costDocs.ts` and `changeOrders.ts` returns its matched rows and refuses a zero-row match (J3).
- [x] A zero-match write returns an error and writes no audit row, on both halves.
- [x] A test simulates the zero-match case per file (`checklists.test.ts`, `turnover.test.ts`, `costDocs.test.ts`, `costs.test.ts`).

At merge, the census in `lib/__tests__/checkedWrite.test.ts` was taught J3's shape: a statement that returns `.select("id")`, including a builder awaited in the next statement, followed by a count test. The money files' ratchet is now at zero: all 14 of their update sites are counted as checked, each re-read by hand. A synthetic case pins that a bare discarded write is still flagged.

---

## SAF-4 · Every route to a green closeout gate accepts a blank reason on one keypress

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** safety / audit integrity
- **Locations:**
  - `components/providers/DialogProvider.tsx:107` — the root cause
  - `components/projects/QualityTab.tsx:426-436` — checklist N/A and satisfied, the `"decided by reviewer"` fallback
  - `components/projects/QualityTab.tsx:579-581` — turnover Waive
  - `components/projects/QualityTab.tsx:698-699` — punch Void, no prompt at all
  - `lib/turnover.ts:204` — `review_note: input.note?.trim() || null`
  - `lib/turnover.ts:225` — `computeTurnoverProgress` counts waived as accepted
- **Re-verified:** hardening pass — **SURVIVES**. `DialogProvider.tsx:107` — `onSubmit` settles with `inputRef.current?.value ?? ""` and applies no non-empty test, so Enter on an untouched prompt returns the empty string.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. Every cited line checks out: a blank reason is accepted on one keypress at each gate, and a blank waive still turns turnover progress green. Severity is over-stated at CRITICAL though — the actor identity and timestamp are still recorded (turnover.ts:201-203), so this is a missing-required-field control weakness, not a record that contradicts reality (that is SAF-3). HIGH.

**Mechanism.** The load-bearing defect is in the dialog layer:

```ts
settle(current.kind === "prompt" ? (inputRef.current?.value ?? "") : true);
```

Submitting an empty box resolves to `""`, not `null`. The `null` path is only
the explicit Cancel. So every caller guarding with `if (v === null) return;`
accepts a blank reason.

Three controls turn a gate green, and none requires a reason:

**Checklist → N/A.** `manualNote = v.trim() || "decided by reviewer"` — a blank
reason becomes a literal string written to the audit log *as if it were a
reason*. Two keystrokes remove the item from the count and permanently immunize
it against every future sweep. The dialog even tells the user this is the
effect while making it free.

**Turnover → Waive.** Blank stores `null`. Waived counts as accepted, so waiving
the outstanding items flips the closeout gate to "Turnover package fully
accepted" and drives Quality health to 100. Available on `open` items — you can
waive something the contractor never delivered.

**Punch → Void.** No reason field exists, and no confirmation dialog. One click
on an unlabeled icon whose meaning is hover-only, and the gate reads "Punch list
clear." Compare the Done button beside it: identical weight, opposite meaning.

**Failure scenario.** A user who wants a clean closeout can turn every gate
green in about a dozen keystrokes, and the audit log will record
`"decided by reviewer"`, `null`, and nothing at all as the reasons.

**Remediation.**
1. Add a `requireValue` option to `appPrompt` that re-prompts (or disables
   submit) on empty, and use it at all three call sites. Do not change the
   default `appPrompt` behaviour globally without auditing its ~90 call sites.
2. Delete the `|| "decided by reviewer"` fallback. A missing reason must block
   the write, not be invented.
3. Give punch-void the same confirm-plus-reason as its siblings.
4. Separately: stop counting `waived` as `accepted` in
   `computeTurnoverProgress` — report it as its own bucket so the gate and the
   report can distinguish "delivered and accepted" from "waived."

**Done when.**
- None of the three controls can complete with an empty reason.
- No placeholder string is ever written as a reason.
- `computeTurnoverProgress` reports `waived` separately from `accepted`.
- Tests pin each of the three, and the progress-bucket change.

**Resolution (2026-09-29, projects Round G — GAP-405 server half + prompt).** The bar is server-side and the prompt mirrors it. `reasonProblem()` / `REASON_MIN_LENGTH = 10` (`lib/checklistEngine.ts`): a blank or whitespace reason, fewer than 10 non-whitespace characters, or a canned string (`decided by reviewer`, `n/a`, `not applicable`, `ok`, …) is refused with the reason why. `updateChecklistItem` requires it on every status/applicability change (satisfied, N/A, reopen) — the `|| "decided by reviewer"` fallback is deleted from `components/projects/QualityTab.tsx`; `reviewTurnoverItem` requires it on reject and waive; `reopenTurnoverItem` and `setPunchStatus('void')` require it (punch-void now prompts, with a labelled button). `appPrompt` (`components/providers/DialogProvider.tsx`, :107 region) gains additive `required` / `minLength` options: a submit that does not meet them shows the problem inline (`role="alert"`) and keeps the box open; Cancel is still the only way to `null`; the default is unchanged for the ~90 other call sites. `computeTurnoverProgress` reports `waived` as its own bucket — `accepted` counts accepted only — and the header reads "a/req accepted · w waived" (`pct` still counts both as met, documented). Tests: `lib/__tests__/checklists.test.ts` `"refuses a blank, short or canned reason on N/A, satisfied and reopen — nothing written, nothing audited"` (asserts no `decided by reviewer` ever reaches a write); `lib/__tests__/turnover.test.ts` `"reject and waive refuse a blank, whitespace, short or canned reason…"`, `"void refuses a blank or canned reason"`, `"only an accepted or waived item can be reopened, and only with a real reason"`, `"reports accepted and waived separately"`; `lib/__tests__/projectControls.test.ts` `"SAF-4: the reason bar refuses blank, short and canned reasons and accepts a real one"`.

*Second review fix (projects Round G) — enforced by the database, not only by the client data layer.* "Server-side" above meant `lib/checklists.ts` / `lib/turnover.ts`, which run in the browser (`"use client"` QualityTab, anon-key client); a direct PostgREST PATCH as the project owner — `status = 'waived', review_note = NULL` — was accepted and turned the closeout gate green (reproduced by the reviewer on Postgres 16; GAP-405: "do not make it a client-side check"). `supabase/migrations/20261091_prj_roundG_quality_rails.sql` now enforces the bar: `quality_reason_ok(text)` mirrors `reasonProblem()` (at least `REASON_MIN_LENGTH` = 10 non-whitespace characters; the canned list is `CANNED_REASONS`, now exported from `lib/checklistEngine.ts` and pinned to the SQL list by `lib/__tests__/qualityRailsMigration.test.ts`); `turnover_items_decision_rail` refuses a move to `waived` / `rejected`, or out of `accepted` / `waived` (a reopen), without one in `review_note`; `punch_items_void_rail` refuses `void` without one in `closure_note`; `checklist_items_na_rail` refuses a uid-stamped (a person's) move to N/A without one in `manual_note` — the machine-stamped assessment N/A passes and is never citable (QUAL-2). Each is BEFORE INSERT OR UPDATE OF the status column(s), SECURITY DEFINER with `search_path` pinned; the service pass (`auth.uid() IS NULL` — restores, server routes, the SQL editor) passes, as 20261056 / 20261062 do. The final SELECT probes `quality_reason_ok` functionally. Verified on Postgres 16 as the owner: a reason-less or canned waive, a reason-less reopen, a reason-less void, a person's reason-less N/A and an insert born `waived` are refused with a plain message ("… needs a reason of at least 10 characters … — nothing was changed."); a real reason lands; a restore of a legacy `waived` row with a canned note lands.

**Verification fix (2026-09-30, projects Round G).** Two claims in the paragraph above did not hold at 13fcd5e (an independent verifier, Postgres 16, RLS on, as the project owner). (1) "A reason-less reopen … refused": the rails read whatever note was already on the row and fired only on a status change — an accepted item carrying "reviewed page by page" was reopened, then waived, with no new reason; a punch item closed done with a note was voided with no new reason; and a note-only UPDATE set a waiver's or a void's reason to NULL. (2) "The machine-stamped assessment N/A … is never citable": any signed-in write could set `updated_by = NULL`, which skipped the N/A rail, and the basis rule counted any non-empty note as a person's reason — two N/As and a green each carrying the note `x` completed an MI checklist as `'human'` (QUAL-2). Now, in `supabase/migrations/20261091_prj_roundG_quality_rails.sql`: `turnover_items_decision_rail` and `punch_items_void_rail` require a decision's OWN reason — the note must change (`NEW IS DISTINCT FROM OLD`) and pass `quality_reason_ok()` — and a standing waived / rejected / accepted item keeps its note, reviewer and date (a standing void its reason) until the next decision; both now fire on the note and reviewer / closer columns too, and stamp the reviewer / closer with the caller's uid and profile name (`quality_actor_name`). `checklist_items_na_rail` is replaced by `checklist_items_decision_rail` (BEFORE INSERT OR UPDATE OR DELETE): `updated_by = NULL` is accepted only as the machine actor — `updated_by_name` one of the two sentinels (pinned to `MACHINE_ACTOR_SWEEP` / `MACHINE_ACTOR_ASSESSMENT`), never on an item carrying a note or a person's chip, no note written, no person chip added, a green carrying an auto citation — and every other signed-in write is stamped with the caller and needs, for any status or applicability change (satisfied, N/A, item reopen), a note that changed and meets the bar; a note is never cleared. The sweep and the assessment run in the browser under the user's own token, so the database cannot tell them from a direct PATCH by sender: it bounds what a machine-stamped write can do, and all that can produce (a note-less N/A, a cited sweep green) is `'auto'` by the basis rule. The lib mirrors the own-reason rule (`updateChecklistItem`, `reviewTurnoverItem`, `reopenTurnoverItem`, `setPunchStatus`) and keeps the sweep and the assessment off human territory (`isHumanTerritory`: a note or a person chip). Both claims now hold. Verified on a throwaway Postgres 16 (the 20261013 quality schema, RLS on, a stub `auth.uid()`, as the project owner and as a controller): each of the verifier's reproductions is refused, and the lib's own write shapes land — createChecklist; the sweep's green, re-cite and retraction; the assessment's N/A and reversal; Verify, Confirm N/A, Mark satisfied and item reopen; turnover received / accept / reject / waive / reopen; punch done / void / reopen (97 scenarios). Tests: `lib/__tests__/qualityRailsMigration.test.ts` (`"turnover_items: waive, reject and any move out of accepted / waived (a reopen) need their OWN reason…"`, `"turnover_items: a standing decision keeps its note, reviewer and date…"`, `"punch_items: void needs its OWN reason…"`, the `checklist_items_decision_rail` block); `lib/__tests__/checklists.test.ts` `"verification fix (SAF-4 / QUAL-2): a decision needs its OWN reason, and a note is never cleared…"`; `lib/__tests__/turnover.test.ts` the three `"verification fix: … its OWN reason…"` tests.


**Verification fix 2 (2026-09-30, projects Round G).** A second independent pass found the bar and the own-reason rule still weaker at the database than in the lib, and one way round "a note is never cleared": `quality_reason_ok()` accepted ten no-break spaces (which `reasonProblem()` refused) and both accepted ten zero-width spaces; "a new note" compared raw text, so the old note plus a trailing space passed as a reopen's or a waiver's own reason; and deleting a checklist item and inserting it again dropped its note with no reason and no audit row. Now both sides strip the same two character classes — Unicode whitespace and zero-width / invisible characters — before measuring (`REASON_SPACE_CLASS` / `REASON_INVISIBLE_CLASS` in `lib/checklistEngine.ts`, byte-identical in the SQL, pinned by the shape test; the lib counts code points, as the database does); "a new note" is judged on the normalised key (`quality_reason_key()` / `reasonKey()`: invisible characters dropped, whitespace runs collapsed, trimmed, lower-cased) in every rail and in the lib's own-reason checks; and a signed-in single-item DELETE is refused (a cascade from deleting the checklist, project or org passes). Tests: `lib/__tests__/projectControls.test.ts` `"verification fix 2 (SAF-4): the bar strips Unicode whitespace and zero-width characters exactly as quality_reason_ok does…"`; `lib/__tests__/qualityRailsMigration.test.ts` `"quality_reason_ok mirrors reasonProblem()… the same two character classes"`; the final SELECT probes a no-break-space and a zero-width reason; verified on Postgres 16.

**Done-when.**
- ✓ None of the three controls (checklist N/A / satisfied / reopen, turnover waive & reject, punch void) can complete with an empty reason — refused by the client data layer and, for N/A, waive / reject / reopen and void, by the DATABASE (20261091 rails; second review fix — the first build's "server-side" was the browser-run lib), and the prompt cannot settle blank. *Verification fix:* every checklist decision a person makes — N/A, satisfied, item reopen — is refused at the database too without a reason of its own (`checklist_items_decision_rail`); a waive / reject / reopen and a void need a NEW note (the one on the row is the earlier decision's), and a standing decision's reason cannot be cleared or cut below the bar.
- ✓ No placeholder string is ever written as a reason.
- ✓ `computeTurnoverProgress` reports `waived` separately from `accepted`.
- ✓ Tests pin each of the three and the progress-bucket change.

**Scope / residual.** Pending migration `20261091`: until it is applied, the client data layer's check is the only one. The database cannot tell the browser-run sweep and assessment from a direct PATCH by sender (both carry the user's token); it bounds what a machine-stamped write can do (verification fix) — a server-side sweep / assessment under the service role would make the machine actor unforgeable, a follow-on. Waive is still offered on an `open` item (a never-delivered requirement can be waived, with a reason on the record — that is what a waiver is); `lib/projectSnapshot.ts` `turnoverAccepted` still counts waived as met for the closeout gate (J7/J8's file) — the report (`lib/projectReport.ts`) now shows accepted-only through the changed bucket.

---

## SAF-5 · Auto-supersede is a raw column write, so the whole post-publish compliance pipeline is skipped

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `app/api/intake/upload/route.ts:322-334` — the bare `documents.update(...)`
  - `lib/postPublish.ts:91-145` — `runPostPublishSideEffects`, which is skipped
  - `lib/reviewControl.ts:495-510` — the approve path, which calls it correctly
- **Related:** `SEC-4` (same root cause: service-role bypass)
- **Re-verified:** hardening pass — **SURVIVES**, verified by absence: `grep -c postPublish app/api/intake/upload/route.ts` returns **0**. The auto-supersede branch sets `current_version_id` and `status: "Issued"` with a raw `supabaseAdmin` update (`:322-329`) and never enters the post-publish pipeline.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by repo-wide search: runPostPublishSideEffects has exactly three callers (lib/reviewControl.ts:499, lib/revisions.ts:711, :1304) and the intake auto-supersede path is not one of them, so the review-cycle reset, fresh read-and-understood roster and retention recompute (postPublish.ts:139-147) are all skipped on this route. The review-gated path (reviewControl.ts:495-510) does call it, which is exactly the contrast the finding draws.

**Mechanism.** The approve path calls `runPostPublishSideEffects`. The
auto-supersede path does a bare column update plus a `superseded_at` stamp on
the prior version, and nothing else.

Skipped on every trusted-link publish: stale-copy notices to live intent
holders (`notifySuperseded`), library-subscriber notices, work-package pin-drift
alerts, connected-work revision-impact warnings, retirement of stale link
proposals, **`onDocumentIssued`** (the periodic-review clock),
**`onDocumentIssuedAck`** (the fresh read-and-understood roster), and
**`recomputeRetention`**.

**Failure scenario.** A contractor supersedes an operating procedure that forty
operators had acknowledged. No new acknowledgment roster is issued, the
periodic-review clock never resets, and retention is never recomputed — so the
compliance record still shows everyone signed off on the *previous* revision.
The only signal is one `doc_superseded` notification to Admin, Document Control
and the project owner.

`lib/postPublish.ts:1-13` exists *because* a prior audit found exactly this bug
in the internal path: "the audit found exactly that: finalizeReviewedRevision …
changed current_version_id and told nobody." The intake route reintroduces it.

**Remediation.** Route the intake publish through `finalizeReviewedRevision`
(preferred — also fixes `SEC-4` and `SEC-13`), or call
`runPostPublishSideEffects` explicitly after the column write with the same
arguments the approve path passes.

**Done when.**
- An auto-supersede issues a fresh acknowledgment roster where the document requires one.
- The periodic-review clock resets.
- Retention is recomputed.
- Subscribers and intent holders are notified.
- A test asserts the side-effect runner is invoked on the auto path.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-2` (J1). The auto-supersede branch publishes through `publish_revision` (acting as the link's creator — the database's hold gate, checkout lock, expected-base check and MOC gate) and then runs `runPostPublishSideEffects` with finalizeReviewedRevision's arguments, the shared client bound to the service role and `settle: true` (`lib/postPublish.ts`) so every signal finishes inside the binding: stale-copy notices to intent holders and followers, library-subscriber notices, the recall nudge, work-package pin drift, connected-work warnings, stale-proposal retirement, `onDocumentIssued`, `onDocumentIssuedAck`, `recomputeRetention`. Tests — `lib/__tests__/intakeUploadRoute.test.ts` "publishes through publish_revision … and runs the pipeline bound to the service role"; `lib/__tests__/intakeAutoPublishAcks.test.ts` (the REAL pipeline and acknowledgments module: the prior roster voided, a fresh one for the new revision); `lib/__tests__/intakeDoorLibs.test.ts` "settle:true awaits the fire-and-forget signals".

**Done-when.**
- [x] An auto-supersede issues a fresh acknowledgment roster where the document requires one — ✓ (tested end to end).
- [x] The periodic-review clock resets — ✓ (`onDocumentIssued` in the settled pipeline).
- [x] Retention is recomputed — ✓ (`recomputeRetention`).
- [x] Subscribers and intent holders are notified — ✓ (`notifySuperseded`).
- [x] A test asserts the side-effect runner is invoked on the auto path — ✓.

**Scope / residual.** None in this finding. The census in `lib/__tests__/intakeUploadRoute.test.ts` fails the build for a new unpiped writer of `current_version_id` — per call site after the J1 review's fix pass (TypeScript's parser; inline, shorthand, spread and prebuilt patches; the pipeline must run in the same function), with four pinned exemptions, each with its reason (three first-version seeds, two of them document-control P3's to convert, and revUp's legacy leg, whose caller runs the pipeline — checked). J1 second review: the census also sees RPC writers — every `rpc("publish_revision")` call and every call of its pinned wrapper `callPublishRevisionRpc` (the door's `publishThroughContract` pinned via `POST`) — and only a real CALL of the pipeline in the syntax tree satisfies it, never a comment or a string naming it (projects-and-cost `INTK-2` fix pass 2). The pipeline runs on a request-scoped service-role binding (`lib/serverClientScope.ts`).

---

## SAF-6 · The project timeline cannot see the controls program at all

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** audit integrity / compliance
- **Locations:**
  - `lib/timeline.ts:416-427` — `getProjectTimeline`'s query set
  - `lib/timeline.ts:441-443` — `.eq("resource_type", "document")`, the only audit query
  - `lib/timeline.ts:287-292` — the `MILESTONE_*` summarizers that can never execute
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `buildTimeline` reads `project_activity` and `project_documents` and nothing else (`timeline.ts:416-427`) — no read of `change_orders`, `project_checklists`, `punch_items` or `turnover_items` anywhere in the file.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The visibility gap is real and confirmed by repo-wide search. Downgrading because the events are not lost — they are written to audit_logs and are visible to an admin at app/(protected)/admin/audit/page.tsx:127-137, which selects all org rows with an optional resource_type filter. This is a missing view on one tab, not a missing record.

**Mechanism.** `getProjectTimeline` queries `audit_logs` only where
`resource_type = 'document'`. There is no query for
`resource_type = 'project' AND resource_id = projectId` — which is the shape
every controls-program module writes (`checklists.ts:88-93`,
`turnover.ts:121-126`, `changeOrders.ts:113,191`), and the cost modules write
`resource_type: 'cost'`.

**Failure scenario.** An auditor opens a project's Activity tab and sees
comments and checkouts. Invisible:

- **Cost & commercial** — `COST_DOC_UPLOADED`, `COST_DOC_PARSED` (the AI quote
  read), `COST_DOC_MANUAL_TOTAL`, **`COST_DOC_AWARDED`**, `COST_DOC_POSTED`,
  `COST_DOC_VOIDED`, `COST_ENTRY_POSTED`, `COST_ENTRY_VOIDED`,
  `INTAKE_QUOTE_LINK_CREATED`, `INTAKE_QUOTE_SUBMISSION`.
- **Change control** — `CHANGE_ORDER_PROPOSED`, **`CHANGE_ORDER_APPROVED`**
  (which posts money), `CHANGE_ORDER_REJECTED`, `CHANGE_ORDER_VOIDED`.
- **Quality / closeout** — `CHECKLIST_CREATED`, **`CHECKLIST_ASSESSED`**,
  **`CHECKLIST_ITEM_UPDATED`** (the human applicability decisions),
  `CHECKLIST_AUTO_EVIDENCE`, `TURNOVER_SEEDED`, **`TURNOVER_REVIEWED`**,
  `PUNCH_ADDED`, `PUNCH_STATUS`.
- **Intake** — link created / revoked / assignment changed, submission,
  auto-supersede, rejection, collision flagged, redline.
- **Schedule** — every `MILESTONE_*` action. The reader has purpose-built
  summarizers for all six that can never execute — dead code proving the
  omission was unintended.

**Remediation.** Add one query:

```ts
supabase.from("audit_logs").select("*")
  .eq("org_id", orgId).eq("resource_type", "project").eq("resource_id", projectId)
  .order("created_at", { ascending: false }).limit(200)
```

plus a second for `resource_type = 'cost'` scoped to the project's cost rows
(or change the cost writers to use `resource_type: 'project'` with the project
id, which is simpler and makes one query sufficient). Merge into the existing
timeline the same way the document rows are merged. The `MILESTONE_*`
summarizers then start working with no further change.

**Done when.**
- An award, an approved change order, a turnover acceptance and a checklist ruling all appear in the project's Activity tab.
- The Activity badge count matches what the tab renders (see `UX-11` for the badge).
- A test asserts a project-scoped audit row reaches `getProjectTimeline`.

**Resolution (2026-09-30, projects Round G).** Reproduced: `getProjectTimeline` queried `audit_logs` only for `resource_type = 'document'`; the controls modules write `resource_type: 'project'` (checklists, turnover, change orders) and the cost modules `resource_type: 'cost'` keyed by the cost row. `lib/timeline.ts` now adds (a) one query for `resource_type = 'project' AND resource_id = projectId` and (b) one for `resource_type = 'cost'` over the project's cost documents (the award row's id), both filtered IN THE QUERY through ONE vocabulary map, `PROJECT_EVENT_VOCABULARY` (`DEC-54`): an award (and an award over a do-not-use flag), every change-order proposal and decision, checklist created / assessed / status, turnover seeded / reviewed, punch status, milestone hit / missed / blocked, schedule baselined / re-based, lessons saved are **milestones** (shown); individual cost entries, ledger edits, uploads, reads and manual totals, individual checklist item updates, evidence sweeps, turnover item adds and punch adds are **noise** (kept in `audit_logs`, off the feed); status / ownership / membership / edit rows are **mirrored** (the feed already has the `project_activity` row). An action nobody classified is shown, never dropped. Summarizers were added for the milestone vocabulary; the `MILESTONE_*` summarizers now execute. The Activity badge counts the timeline the tab renders (projects/[id]/page.tsx — `timeline.length`, loaded with the tab, `PERF-8`).
- Commits: `054cb61`, `9363ebb`
- Tests: `lib/__tests__/timeline.test.ts` "SAF-6 — the controls program reaches the project's Activity tab" (an award, an approved change order, a turnover acceptance, a checklist ruling and a punch close appear; noise, mirrored rows and another project's row do not; noise filtered in the query) and "the vocabulary is ONE map; an unclassified action is SHOWN". Test first: all six `timeline.test.ts` cases failed against the `2a2ae73` `lib/timeline.ts` (run with inert shims for the new exports) and pass now.

**Done-when.**
- An award, an approved change order, a turnover acceptance and a checklist ruling all appear in the project's Activity tab — ✓ (a "checklist ruling" is a checklist completed / voided / assessed; item-by-item edits are noise per the decided vocabulary).
- The Activity badge count matches what the tab renders — ✓.
- A test asserts a project-scoped audit row reaches `getProjectTimeline` — ✓.

**Scope / residual.** Intake-link events written with `resource_type = 'project_intake_link'` (link created / revoked / assignment changed) and intake rows keyed on an unlinked document are not pulled — the intake door is projects-and-cost PC-1 / J1's; a `project_intake_link` query can join the map when that package fixes the rows' resource type. `audit_logs` itself is org-readable (`SEC-20`). *Second fix pass (2026-09-30):* dw2 ("the badge matches what the tab renders") could fail for a busy project. The cost-audit read put up to 500 cost-document UUIDs in ONE `.in()` filter, about 18 KB of request line, and the linked-document reads did the same with every linked id. The gateway refuses a request that long, and one refused read failed the whole Activity tab ("The timeline could not be loaded"). `lib/timeline.ts` now reads every id list `TIMELINE_ID_CHUNK` (100) ids per request (`readByIdChunks`), and so does the hold existence lookup. Each chunk is still capped at `limit`, and the chunks are merged before the final newest-first sort and slice, so the feed is the same one. A failed chunk fails the read rather than showing a partial feed. Tests: `timeline.test.ts` "250 quotes and 230 drawings: every .in() carries at most 100 ids, and an event from the last chunk still reaches the feed" (fails against the previous `lib/timeline.ts`), "one refused chunk fails the read — a partial feed is never shown as the whole one". *Third fix pass (2026-09-30):* the id lists themselves were still capped, so dw2 ("the badge matches") could fail silently.
- **Cost documents.** `getProjectTimeline` read them with `.limit(500)`, newest first. On a project with more than 500 quotes, an award on an older quote was never asked for.
- **Register links and doc_removed rows.** These were read with no range, under PostgREST's 1,000-row cap.

All three lists are now read whole: `readAllRows` pages them by id in 1,000-row windows until a short page, and a failed window fails the read. The ids are then chunked through `readByIdChunks` as before. Tests (both fail against the previous `lib/timeline.ts`; the mock now applies the 1,000-row cap and honours `.range`):
- `timeline.test.ts` "600 quotes: an award on the OLDEST one still reaches the feed…".
- `timeline.test.ts` "1,200 doc_removed rows and 1,100 links: the detach cutoff past row 1,000 and the link past row 1,000 both hold".

---

## SAF-7 · Re-baselining destroys the approved plan irreversibly, and the confirmation invites it

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / commercial
- **Locations:**
  - `lib/milestones.ts:1462-1502` — `setBaseline`
  - `lib/milestones.ts:1490-1499` — the audit entry, which logs only a count
  - `components/projects/ScheduleTab.tsx:284` — the button and its confirm text
- **Re-verified:** hardening pass — **SURVIVES**. `setBaseline` reads the current planned dates and overwrites the baseline columns with no snapshot of the prior baseline (`milestones.ts:1462-1489`), and the audit write is `.catch(() => {})` best-effort (`:1490-1499`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. `grep -rn baseline supabase/migrations` shows only the two scalar columns added in 20260706_milestones_baseline.sql (and re-added in 20260714_schema_catchup.sql) — there is no baseline history/snapshot table anywhere, so the prior approved plan is unrecoverable after one confirm.

**Mechanism.** `setBaseline` overwrites `baseline_start_at` /
`baseline_finish_at` in place. A search across `supabase/`, `lib/`,
`components/` and `app/` for `baseline_history` or `milestone_baselines`
returns nothing. The audit entry logs `{ count }` — not a single prior date.

**Failure scenario.** A job is sixty days late. A manager re-plans and clicks
Re-baseline. The dialog reads "Re-capture the current plan as the new baseline?
Drift will be measured from now on against this snapshot" — accurate,
reassuring, and the last moment the original dates exist. Afterwards
`finishDriftDays` reads 0, the drift nudge disappears, and every "vs plan" badge
vanishes. The evidence of a sixty-day slip is unrecoverable from the database
and from the audit log alike.

For a project with commercial exposure this is the difference between having
and not having a delay claim.

**Remediation.**
1. Write the prior baseline into the audit row's `details` before overwriting —
   cheapest fix, recovers the record if not the feature.
2. Better: add a `milestone_baselines` table keyed by project and a captured-at
   timestamp, write a new row per capture, and point drift at the latest.
   Re-baselining then becomes non-destructive and the history is queryable.
3. Change the confirm text to name what is being replaced and when it was set.

**Done when.**
- Re-baselining preserves the prior baseline in a queryable form.
- The confirm dialog states which baseline is being replaced.
- Drift can be computed against any captured baseline, not only the newest.

**Resolution (2026-09-30, projects Round G — J6b; the history half is J6a's `20261099`).** Re-baselining is non-destructive: `set_project_baseline` / `clear_project_baseline` (migration `20261099`, J6a — see projects-and-cost `SCHED-3`) write the prior snapshot to `milestone_baseline_history` before overwriting, and audit themselves; a clear is a retirement that keeps its snapshot the same way. This package makes the history usable and the confirm honest. The confirm (`components/projects/ScheduleTab.tsx`) names what it replaces and says whether it is kept — asking the database first (`lib/milestones.ts` `baselineHistoryAvailable`: can `milestone_baseline_history` be read?). With the history: "Replace the baseline set on 1 Jun 2026 (48 tasks) with the current plan? The one you replace is kept — the Report can still measure drift against it — but from now on every "vs plan" figure is measured against the new snapshot." Without `20261099` (where `setBaseline`'s legacy path overwrites with no history), a danger-toned confirm: "This database does not keep replaced baselines yet (the baseline-history migration is not applied): the one you replace is overwritten and cannot be recovered."; when it cannot tell, it says so and that it may be overwritten (`currentBaselineSummary` — the newest `baseline_set_at` and the row count). The button's tooltip says the replaced one is kept once the migration is applied. *Review fix pass:* the first version promised "The one you replace is kept" unconditionally, which was false on the legacy path. Drift against any capture: `lib/milestones.ts` `listBaselineCaptures` returns the live baseline and every capture in `milestone_baseline_history`, newest first (when it was set, when and why it was retired, its rows' finishes); `computeExecutionReport(…, { baselineFinishById })` measures drift against the one chosen; `ExecutionReportView` shows a "Compare with" picker (the newest by default) and labels the drift line with the capture's date. A database without the history table says "Earlier baselines are kept once the baseline-history migration (20261099) is applied."; any other read failure is shown as an error, never as "no history". Tests: `scheduleEngineWriters.test.ts` "SAF-7 ·" (the live summary; captures newest first with their set / retired dates and rows, another project's excluded; missing table vs. a real error); `executionReport.test.ts` "measures against an older capture" (a re-baselined task reads on plan against the live baseline and 60 days late against the original); `scheduleEngineWriters.test.ts` "baselineHistoryAvailable" (true / false without the table / null on another error); `scheduleEngineMigration.test.ts` pins the three confirm wordings and that the tooltip no longer promises "kept".

**Done-when.** 1 ✓ (pending `20261099`). 2 ✓. 3 ✓ (any capture, from the Report).

**Scope / residual.** Pending migration: `supabase/migrations/20261099_prj_roundG_baseline_authority.sql` (J6a). The picker lives on the Report; the Planning list's "+Nd vs plan" chip and the detail panel still compare with the live baseline.

---

## SAF-8 · A task can be Missed and one-hundred-percent earned at the same time

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J12 SERVER REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/milestones.ts:389-395` — the `else` branch clears `actual_at`, leaves `percent_complete`
  - `lib/scheduleProgress.ts:35-39` — `leafPercent` returns the stored percent for those statuses
- **Re-verified:** hardening pass — **SURVIVES**. The blocked/on-hold/missed branch deliberately leaves `percent_complete` untouched (`milestones.ts:389-395`) and `leafPercent` returns `clampPercent(m.percentComplete)` for any non-completed, non-planned status (`scheduleProgress.ts:35-39`) — so `missed` at 100% earns full credit.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The contradiction is real: percent_complete=100 + status='missed' is representable and contributes full weight to earned value and SPI. But the report's stated harm is wrong — marking a completed task Missed changes leafPercent by nothing, so SPI does not 'improve at the moment somebody records a miss'; it merely fails to degrade. Requires the specific completed-then-missed sequence and misstates the effect, so MEDIUM.

**Mechanism.** Setting a task to `blocked`, `on_hold` or `missed` clears the
actual date but deliberately leaves `percent_complete` untouched, and the
progress reader returns the stored percent for those statuses.

**Failure scenario.** A task completes at 100%. A supervisor later
re-classifies it **Missed**. Result: `percent_complete = 100`,
`actual_at = null`, `status = 'missed'`. `ScheduleProgress` shows "1 Missed"
while `computeScheduleMetrics` adds its full weight to earned value and SPI —
so schedule performance *improves* at the moment somebody records a failure.

**Remediation.** Decide the intended semantics and make the two agree. Most
likely: `missed` should contribute zero earned value (it did not happen);
`blocked` and `on_hold` should retain whatever partial progress was genuinely
achieved. Encode that in `leafPercent` rather than in the setter, so it holds
for imported rows too.

**Done when.**
- A `missed` task contributes no earned value.
- A test pins the 100%-then-missed transition.
- The Schedule tab's "Missed" count and the EV rollup cannot disagree.

**Partial (2026-09-30, projects Round G).** `lib/scheduleProgress.ts` `leafPercent` returns 0 for `missed` (as for `planned`), whatever percent is stored — in the reader, so it holds for imported rows too; `blocked` / `on_hold` keep the progress genuinely logged, and the stored percent is left alone (un-missing a task gives it back). Every SCHEDULE rollup reads `leafPercent`: `computeScheduleMetrics` (the Schedule tab's earned value and SPI), `buildProgressIndex`, `overallPercent`, `computeExecutionReport`, and the critical path's remaining hours. NOT the money: the cost earned value still gives a missed task its stored percent — `lib/costs.ts:448-460` `milestonePctIndex` returns `Math.round(percentComplete)` whatever the status, and `computeCostRollup` earns each pinned account's budget by it, so a task completed at 100% and then reclassified Missed still earns 100% of its account on the Costs tab's CPI (`components/projects/CostsTab.tsx:106`), in `projectSnapshot` (health, `lib/projectSnapshot.ts:272`) and in the printed report (`lib/projectReport.ts:189`). `lib/costs.ts` belongs to the money package (J3, later J10), not this one, so it was not edited here; the review fix pass withdrew this record's earlier "every rollup reads `leafPercent`", which overstated. Tests: `scheduleProgress.test.ts` "SAF-8 ·" — `leafPercent({ missed, 100 }) = 0`; the 100%-then-missed transition: earned value 1 → 0, `byStatus.missed = 1` with earned value 0 (the Missed count and the EV rollup agree), `overallPercent` 0, the phase over it 0%.

**Done-when.** 1 — partly: a missed task contributes no SCHEDULE earned value (✓); it still contributes cost earned value (not done — `lib/costs.ts:448`, another package's file). 2 ✓ (the 100%-then-missed transition is pinned for the schedule rollups). 3 — partly: the Missed count and the Schedule tab's EV rollup agree (✓); the Costs tab / snapshot / report CPI can still disagree with the Missed count (not done, same reason).

**Scope / residual.** Remaining to close: route `milestonePctIndex` (`lib/costs.ts:448-460`) through `leafPercent` — or at least return 0 for status `missed` — in the money package's file (owner or integrator); its three callers (`CostsTab.tsx:106`, `projectSnapshot.ts:272`, `projectReport.ts:189`) already pass `status`, so no caller changes. A missed leaf's slider still shows 0% (its earned share) while its stored percent is kept; see projects-and-cost `SCHED-7` for how a phase of missed work now reads.

**Resolution (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS closed the money half named in the residual: `lib/costs.ts` `milestonePctIndex` returns 0 for a `missed` task whatever percent is stored (the rule `lib/scheduleProgress.ts` `leafPercent` applies to the schedule), so the cost earned value — the Costs tab's CPI, the health snapshot and the printed report, its three callers, which already pass `status` — no longer credits a task the Schedule tab counts as Missed. The stored percent is left alone (un-missing a task gives it back).
- Commit: `87a8436`.
- Tests: `lib/__tests__/prjRoundGJ12.test.ts` "SAF-8 — a missed task earns nothing in the cost EV index" (missed → 0 with or without a stored percent; other statuses unchanged) and "the 100%-then-missed transition: the pinned account's earned value goes 1000 → 0 and the cost CPI with it" (`computeCostRollup` CPI 2 → 0 on the same 500 spent).

**Done-when.**
- ✓ A `missed` task contributes no earned value — schedule (above) and cost (here).
- ✓ A test pins the 100%-then-missed transition — schedule rollups (above) and the cost CPI (here).
- ✓ The Schedule tab's "Missed" count and the EV rollup cannot disagree — both rollups read a missed task as 0.

**Scope / residual.** None.

---

## SAF-9 · A rejection reason never reaches the contractor, and nothing notifies them either way

- **Severity:** HIGH
- **Status:** OPEN
- **Assigned:** projects-joint J12 SERVER REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** ux / process
- **Locations:**
  - `components/projects/IntakePanel.tsx:248-270` — intake reject, captures nothing
  - `app/submit/[token]/page.tsx:294-295` — the bare rejected badge
  - `app/api/intake/resolve/route.ts:100-105` — returns no reason
  - `components/projects/QualityTab.tsx:524` — the turnover claim
- **Related:** `MON-11` (no notifications anywhere), `UX-5`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `reject` writes `review_state: "rejected"` and clears the pending pointer (`IntakePanel.tsx:254-259`) — it captures **no reason field** and sends **no notification**. The portal shows only a red "rejected" badge (`app/submit/[token]/page.tsx:294-295`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on all four sites. project_intake_links carries a `contact_email` column (20260902_project_intake.sql:24) that no code path uses on reject, and the only mailer in the repo is app/api/notifications/send-queued/route.ts, which the intake reject flow never touches — so 'nothing notifies them either way' holds.

**Mechanism.** Intake rejection prompts a yes/no confirm and captures no reason
at all; `audit_logs.INTAKE_REJECTED.details` has no reason field. The portal
renders a bare badge. No email or notification is sent to `contact_email` on
reject *or* on approve.

Turnover rejection *does* capture a note, and the reviewer is told "The
contractor sees this reason and it lands on their record" — but the portal has
no turnover surface at all, `/api/intake/resolve` never returns turnover rows,
and (per `MON-7`) the row never reaches the scorecard either. Both halves of
that sentence are false.

**Failure scenario.** The contractor resubmits blind, and the reviewer rejects
again.

**Remediation.**
1. Capture a rejection reason on the intake path (required, not optional) and
   store it on the version row or the audit details.
2. Return it from `/api/intake/resolve` and render it on the portal.
3. Send a notification to `contact_email` on approve and reject.
4. Either build the turnover surface on the portal, or change the
   `QualityTab.tsx:524` copy to state what actually happens.

**Done when.**
- A rejected submission shows its reason on the contractor's portal.
- The contractor is notified on both outcomes.
- No UI string claims a channel that does not exist.

**Partial (2026-09-30, projects Round G).** Intake rejection now REQUIRES a reason (`IntakePanel` reject: `appPrompt`, at least a few words), stored on the version (`document_versions.review_note`, migration `20261105`; a database without the column keeps it in the audit row only) and in `INTAKE_REJECTED`'s details; `/api/intake/resolve` returns it with the rejected item (`rejectionReason`) and the portal shows "Reviewer's reason: …" under "not accepted — resubmit". The confirmation copy says exactly that ("the company sees this reason on their submission portal"). Tests — `lib/__tests__/intakeUploadRoute.test.ts` "IntakePanel reject: a required reason, stored for the portal and the audit", the resolve route's "a rejected submission carries the reviewer's reason".

**Done-when.**
- [x] A rejected submission shows its reason on the contractor's portal — ✓ (pending `20261105` for the column).
- [ ] The contractor is notified on both outcomes — **not done**: the portal shows the outcome and the reason on the contractor's next visit; an email to the link's `contact_email` needs a server route (external mail is server-only since SURF-17 / 20261047) that is not in this package's plan (`DEC-56`'s default: email only when the link carries a contact the org entered — to be built with it).
- [ ] No UI string claims a channel that does not exist — **partly**: the Intake tab's copy is now true; the turnover claim at `components/projects/QualityTab.tsx:524` is another package's file (J2 QUALITY) and was not edited.

**Scope / residual.** Stays OPEN for the contractor notification and the turnover copy.

**Partial (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS built the server half of done-when 2; the call from the Intake tab and the turnover copy are in another package's files, so the record stays OPEN.
- `app/api/intake/outcome-notice/route.ts` (new): `POST {orgId, versionId}` emails the contact the org entered on the intake link (`project_intake_links.contact_email` — `DEC-56`: an address the org typed, never one the door collected) how the submission was decided, on approval AND on rejection, through the server's email path (Resend, the `RESEND_API_KEY` / `RESEND_FROM_EMAIL` the queue drain uses; the per-member queue cannot carry it — `email_notifications.to_user_id` is NOT NULL and the preference gate keys on it). The caller must be an active member who may decide the submission — Admin / DocCtrl held additively (`memberHoldsAny`) or the project's owner (403 otherwise; 503 when the membership cannot be read). The outcome and the reason are read from the DATABASE (`document_versions.review_state` / `review_note`; a release with no review state is an approval), never from the request (409 while undecided). One notice per submission (an `INTAKE_OUTCOME_NOTIFIED` row for that `versionId` answers `already`). No contact → `no_contact`; email not configured → `not_configured`; the provider refusing → 502 `send_failed` with `INTAKE_OUTCOME_NOTICE_FAILED` (the error in details). The audit row is the record (resource the document, `projectId` in details so it follows the project — `SEC-21`).
- `lib/intakeOutcomeNotice.ts` (new): `intakeOutcomeEmail` words it ("Not accepted — resubmit: …" with "Reviewer's reason: …", or "Accepted: …"; a rejection with no recorded reason says so, never invents one); `notifyIntakeOutcome(orgId, versionId)` is the Intake tab's call.
- Commit: `b624f94`.
- Tests: `lib/__tests__/intakeOutcomeNoticeRoute.test.ts` (400 / 401; inactive or non-deciding member 403 with nothing sent; a DocCtrl held in `roles[]` may send; not a door submission or another org's link 404; failed membership read 503; the rejection email to the entered contact with the reason and its audit row; approval and release; undecided 409 whatever the body says; no contact; once per submission; not configured; provider refusal 502 + failure row); `lib/__tests__/prjRoundGJ12.test.ts` "SAF-9 — the contractor's notice says what was decided, and why".

**Done-when.**
- [x] A rejected submission shows its reason on the contractor's portal (above).
- [ ] The contractor is notified on both outcomes — **the route is built and tested; nothing calls it yet.** Wiring is one call after a decision lands: `notifyIntakeOutcome(orgId, versionId)` in `components/projects/IntakePanel.tsx` after the reject write (`:444-462`, `INTAKE_REJECTED`) and after an approval / publish — J10b's file in this wave (handed over). A submission approved from the document review surface (`components/documents/**`, document-control P14 / P15) can call the same route; the outcome is read from the version, so any surface that decides may.
- [ ] No UI string claims a channel that does not exist — **still the turnover copy**: `components/projects/QualityTab.tsx:1104` ("The contractor sees this reason, it lands on their record…") — a turnover rejection reaches no contractor channel. J10b's file (handed over): say "kept on the item's record as a nonconformance" or point at a channel that exists.

**Scope / residual.** OPEN for the two hand-offs above. Out of scope by `DEC-56`: emailing an address the door collected.

---

## SAF-10 · Auto-supersede orphans a pending review and its e-signatures

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** compliance / data-integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:257-259` — the guard that is skipped
  - `app/api/intake/upload/route.ts:325` — `pending_version_id: null`
  - `components/projects/IntakePanel.tsx:113` — the queue filter that then hides it
- **Related:** `SEC-3`, `SEC-12`
- **Re-verified:** hardening pass — **SURVIVES**. The auto path is exempted from the pending-review block at `:257` and then sets `pending_version_id: null` at `:325`, leaving the pending version and any sign-offs against it unreachable.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and there is no DB-side protection: `pending_version_id` appears in the migrations only as the ADD COLUMN at 20260818_review_before_publish.sql:30 — no trigger or constraint guards clearing it. The orphaned version keeps review_state='in_review' forever with its signatures attached to a draft no interface can reach. HIGH stands.

**Mechanism.**

```ts
if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored))
  return bad(…, 409);
```

When the exemption applies, the route overwrites `pending_version_id` to null
without touching the previously pending version. That row keeps
`review_state: 'in_review'` forever, is referenced by no document, and
disappears from the review queue — which filters on the pointer that was just
cleared. It is surfaced nowhere else.

**Failure scenario.** Reachable via `SEC-3` and `SEC-12`, and additionally
whenever an *internal* reviewer has an in-review draft with a signed roster on
an assigned document — that draft and its e-signatures are orphaned by the
external write.

**Remediation.** Before clearing the pointer, explicitly resolve the outgoing
pending version: set it to `superseded` or `abandoned` with a reason, notify its
reviewers, and preserve any signatures. Add a maintenance query that surfaces
`in_review` versions referenced by no document as a data-health signal.

**Done when.**
- Clearing `pending_version_id` never leaves an unreferenced `in_review` row.
- Reviewers of an abandoned draft are told it was superseded.
- A health check reports orphaned in-review versions.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-4` (J1), on top of document-control `RG-10` (RESOLVED — a draft carrying a roster can never be displaced; `IntakePanel` reject voids a draft's sign-offs). A displaced submission is now RESOLVED: `review_state = 'superseded'` + `superseded_at` + an `INTAKE_SUBMISSION_DISPLACED` audit row, and the project team's notice says the earlier submission was replaced (never folded into a burst). Displacement happens only on the review path — a trusted link whose own submission is still in review never auto-publishes (`INTK-1`'s fix pass), so its new upload replaces the draft IN REVIEW. Migration `20261105` admits the state and keeps it out of the revert-target gate; `orphaned_in_review_versions_count()` is reported by the maintenance cron (step 4c) and by the migration's inventory. Fix pass (J1 review): the door's own lost pointer race now resolves its new version 'superseded' (it had stayed 'in_review' with only `superseded_at` — unreferenced); `20261105` converts intake rows retired that older way to 'superseded'; the health signal counts only in-review rows nothing points at AND nothing withdrew, so it is not permanently red, and the cron line names a remedy a document controller can run. Tests — `lib/__tests__/intakeUploadRoute.test.ts` "a trusted link with its own submission still in review does NOT auto-publish: the upload replaces it IN REVIEW — CAS on that draft, 'superseded', an audit row, a forced notice", "the door's own lost pointer race RESOLVES the new version ('superseded')…"; `lib/__tests__/intakeDoorMigration.test.ts` "intake rows retired the older way are RESOLVED at apply; the health signal counts only rows nothing withdrew".

**Done-when.**
- [x] Clearing `pending_version_id` never leaves an unreferenced `in_review` row — ✓ **on the intake paths** (asserted on displacement; the lost-race withdrawal too after the fix pass; J1 second review: the displaced draft is retired before its replacement exists, checked, and a failed replacement restores it — projects-and-cost `INTK-4` fix pass 2). NOT across the codebase: `lib/revisions.ts` `revUpDocument`'s resubmit (`update({ superseded_at })` on the prior draft, ~:637) and `lib/reviewControl.ts` `withdrawStrandedSubmission` (~:327-333) still leave a row 'in_review' with `superseded_at` stamped after `20261105`'s one-shot conversion (which converts intake rows only). Those writers are document-control P3's; the health signal does not count them (nothing points at them, but something withdrew them), so they are resolved-in-fact but mis-stated in `review_state`.
- [x] Reviewers of an abandoned draft are told it was superseded — ✓: a displaceable draft has no roster (RG-10 refuses otherwise), so its reviewers are the review queue's audience — the controllers and the project owner — and they are told.
- [x] A health check reports orphaned in-review versions — ✓ (the cron's `orphanedInReviewVersions` and a `review-health` error line when non-zero — rows nothing withdrew, with a remedy a controller can act on). Fix pass 3 (J1 third review): its mirror image — a document whose pending revision still names a RETIRED draft — is also counted from state on every run (`pending_on_retired_version_count()`, `20261105`; the cron's `pendingOnRetiredVersions`), where fix pass 2 reported only the intake door's own case, from audit rows, for 25 hours.

**Scope / residual.** Pending migration: `20261105`. Existing true orphans (in review, nothing withdrew, no pointer) are counted, not auto-voided — which submission is live is a person's call; intake rows already retired by `superseded_at` are converted. No screen lists a version nothing points at; the cron line names the SQL function a controller runs, and (J1 second review) a displaced intake draft the door could not restore after a failed replacement (`INTAKE_DISPLACE_UNRESOLVED`) — since fix pass 3 counted from state (`pending_on_retired_version_count()`: any document whose pending revision names a retired draft, whatever wrote it) and reported until it reaches 0, not for 25 hours. Handed to document-control P3: `revUpDocument`'s resubmit and `withdrawStrandedSubmission` should set `review_state = 'superseded'` with `superseded_at` (the state `20261105` adds).

**Verification fix (2026-09-30, projects Round G).** Done-when 3's "reports" was a line in the cron's JSON body that nobody reads, and an RPC error on either count was dropped (a broken check read as 0). The maintenance cron now logs every `review-health` line (`console.error`), reports an RPC failure unless the function is simply not applied yet (PGRST202, or 42883 only when the message says a function does not exist — never matched on the function's name), and, when a count is above 0, nudges each affected org's Admin / DocCtrl pool once a day through `emit()` (bell, `review_overdue` — a compliance kind the daily compliance email includes) from the new `intake_review_health_by_org()` (migration `20261105`: the two predicates per org, SECURITY DEFINER, service role only). The nudge is best-effort — `emit()` reports no delivery. Rows whose version and document both lack an org are not nudged (no pool to resolve); the cron reports them as an error line (second verification, same date). Full account: projects-and-cost `INTK-4` verification fix.

---

## SAF-11 · A rejected submission remains an adoptable transition-in candidate

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** document-control integrity
- **Locations:**
  - `lib/transitionIn.ts:69-91` — `listTransitionCandidates`, filters only `.neq("status","Superseded")`
  - `components/projects/IntakePanel.tsx:257-259` — reject clears the pointer, never touches the document row
- **Re-verified:** hardening pass — **SURVIVES**. `listTransitionCandidates` filters `.neq("status", "Superseded")` only (`transitionIn.ts:73-80`); rejection is recorded in `document_versions.review_state`, which this query never reads.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Correct. The second half checks out too: app/api/intake/upload/route.ts:286-293 creates intake documents with no current_version_id, and adoptDocument (transitionIn.ts:211-217) only patches library_id/collection_id/document_number — so adoption lands a controlled-library document whose only version is in_review or rejected and which has no current revision. TransitionInPanel's row render shows label/rev/company/collision/clean and never surfaces the review state, so there is no warning at the click. HIGH stands.

**Mechanism.** Rejecting a new-document submission clears
`pending_version_id` but leaves the document at `status: "Draft"`. The
candidate list filters only on not-Superseded, so it stays listed, still scans
clean, and is still adoptable into the controlled register.

**Failure scenario.** A drawing the organization explicitly refused gets
adopted into the library with one click. The same applies to a submission still
*awaiting* review — adoption places it in the controlled library with no
`current_version_id` and its only version `in_review`.

**Remediation.** Exclude from candidates any document whose latest version is
`rejected`, and any whose only versions are `in_review`. Better: give rejected
intake documents a terminal status of their own so they are excluded by state
rather than by inference.

**Done when.**
- A rejected submission does not appear in the transition-in candidate list.
- An un-reviewed submission either does not appear, or appears clearly marked and blocked from adoption.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-3` (J1). `listTransitionCandidates` drops a sheet whose latest intake submission was rejected and marks one with no approved revision (in review, or never decided); `adoptDocument` refuses both, and a sheet whose latest submission was rejected; the panel shows "in review" / "not approved" and disables Adopt. Tests — `lib/__tests__/transitionIn.test.ts` "drops a sheet whose latest intake submission was rejected; marks one still in review or never approved", "refuses a sheet still in review, or never approved", "refuses a sheet whose latest submission was rejected".

**Done-when.**
- [x] A rejected submission does not appear in the transition-in list — ✓.
- [x] An un-reviewed submission appears clearly marked and blocked from adoption — ✓. Fix pass 3 (J1 third review): including an APPROVED sheet whose NEWER submission is still in review — the list marked it (`pendingReview`) but the panel showed it "clean", counted it in "Adopt N clean" and offered it for adoption; `candidateInReview` now drives every panel gate and the "in review" mark (projects-and-cost `INTK-3` fix pass 3).

**Scope / residual.** None (a terminal "rejected" document status was not introduced — exclusion is by the latest submission's state). J1 second review: the exclusion is for a sheet NEVER approved whose latest submission was rejected; a sheet with an approved revision whose newer proposal was rejected stays adoptable at its approved revision (it was stranded before — projects-and-cost `INTK-3` fix pass 2).

---

## SAF-12 · A known number collision can be adopted in one click, creating two live documents on one number

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** document-control integrity
- **Locations:**
  - `components/projects/TransitionInPanel.tsx:241-245` — `adoptOne`, which never consults `impact.clean`
  - `lib/transitionIn.ts:216` — `adoptDocument`, no re-validation
  - `lib/transitionIn.ts:10-12` — the module header claiming this is impossible
- **Re-verified:** hardening pass — **SURVIVES**. `adoptOne` is disabled only on `busy` or a missing destination library (`TransitionInPanel.tsx:241-242`) — the collision the panel itself detects does not gate the button.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and I looked for the DB backstop that would have refuted it: the partial unique index is `documents(library_id, uniqueness_key)` (20260619_document_uniqueness_configurable.sql:44-46), and the intake insert at route.ts:286-292 never sets uniqueness_key — NULL opts the row out of the index entirely. So even adopting into the SAME library as the colliding document raises no error. HIGH stands.

**Mechanism.** Single-item adopt does not consult the impact scan. The Adopt
button renders identically for a flagged candidate and a clean one — only the
*bulk* button is gated. The renumber input is optional and validated by nothing:
no uniqueness check, no call to `lib/uniqueness.ts`, no re-scan.

**Failure scenario.** The panel shows "P&ID-2101 — ⚠ number collision:
P&ID-2101 (Rev 4) already exists." The manager expands it, does not type a new
number, and clicks Adopt. Both documents are now live in the controlled
register under the same number, in different libraries, neither superseded —
the exact "two sources of truth" the module header declares impossible.

**Remediation.**
1. Gate single-adopt on `impact.clean`, or require an explicit override with a
   reason when it is not.
2. Validate the renumber value for uniqueness before writing, using the
   existing uniqueness helper.
3. Re-scan inside `adoptDocument` rather than trusting the page-load snapshot
   (see `SAF-14` — same TOCTOU root).

**Done when.**
- Adopting a candidate with a live number collision is refused, or requires a validated renumber.
- The renumber value is uniqueness-checked at write time.
- A test covers the collision path.

**Resolution (2026-09-30, projects Round G).** Worked as projects-and-cost `INTK-3` / `INTK-5` / `INTK-7` (J1). Single Adopt is disabled for a sheet with a live number collision until a renumber is typed; `adoptDocument` RE-RUNS the scan at the click with the effective number and refuses a collision (naming the other document) unless the new number is itself clear, refuses when the scan could not run, and writes the destination library's `uniqueness_key` so the partial unique index sees the adopted sheet — its refusal reaches the operator as a sentence. The scan itself is exact and complete (LIKE-escaped, exact-match filtered, status filtered in the database, library-root documents counted). Tests — `lib/__tests__/transitionIn.test.ts` "refuses a live collision; refuses a renumber onto another live number; accepts a clear renumber and writes its key", "finds a live collision hiding behind six superseded rows, a library-root document …", "the database's unique refusal and the move guard reach the operator as sentences".

**Fix pass 3 (2026-09-30, projects Round G — J1 third review).** Fix pass 2's tuple rule reopened this finding for one case: when the destination library's key had more than one part, EVERY number-collision refusal was dropped — including a live same-numbered document in ANOTHER library, which the org-wide scan reports. An approved intake P-100 with recognised equipment adopted into a `["documentNumber","sheet"]` library in one click while P-100 Rev 3 stood Issued in a default-tuple library, and the panel said the shared number was expected. Now `lib/transitionIn.ts` `blockingNumberCollision` judges each collider against the destination (the scan returns its `libraryId`): a same-numbered sibling INSIDE a multi-part destination is expected; one anywhere else blocks until a renumber that is itself clear. `adoptDocument` enforces it at the click, with its own look-up for a live same number outside the destination (never hidden behind a full window of in-library siblings; an error refuses), and `TransitionInPanel` gates the Adopt button and words the collision box the same way. Tests — `lib/__tests__/transitionIn.test.ts` "the reviewer's case: P-100 Rev 3 Issued in L1 refuses adopting an intake P-100 into an ['documentNumber','sheet'] library — nothing moves", "a renumber onto the other library's live number is refused; a clear renumber is adopted", "a live number elsewhere is found even behind a full window of same-numbered siblings inside the destination", the `blockingNumberCollision` cases; the multi-sheet door-to-adoption test and the panel pin in `lib/__tests__/intakeUploadRoute.test.ts`. (Full account: projects-and-cost `INTK-3` fix pass 3.)

**Done-when.**
- [x] Adopting a candidate with a live number collision is refused, or requires a validated renumber — ✓ for every destination: under the default tuple any live same-numbered document; in a multi-part destination any live same-numbered document outside it (siblings inside it are decided by the full key). Fix pass 2's tick was unconditional while the cross-library case adopted with no refusal; fix pass 3 closes it.
- [x] The renumber value is uniqueness-checked at write time — ✓ (the re-scan, then the key the index enforces).
- [x] A test covers the collision path — ✓ (fix pass 3 adds the cross-library path into a multi-part destination).

**Scope / residual.** Pending migration: `20261105` backfills keys for existing numbered rows (skipping live collisions, which it counts). J1 second review: a collision is judged by the DESTINATION library's tuple — where the number alone is the key, as above; in a multi-sheet library (`["documentNumber","sheet"]`) a shared number is expected and the full key decides, and a sheet with no sheet value is adopted unkeyed with a note (the key was a partial `'p-100::'` that refused sheet 2 — projects-and-cost `INTK-5` fix pass 2).

---

## SAF-13 · Adopt is broken for precisely the user the panel is offered to

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** SUSPECTED (trigger read is unambiguous; not exercised live)
- **Blast radius:** ux / correctness
- **Locations:**
  - `lib/transitionIn.ts:217` — `adoptDocument` runs on the browser client and always changes `collection_id`
  - `supabase/migrations/20261011_collections_guard_and_trash.sql:44-53` — `enforce_document_move_guard`
  - `app/(protected)/projects/[id]/page.tsx:508-523` — the panel renders for owner **or** controller
- **Re-verified:** hardening pass — **SURVIVES**. `supabase.from("documents").update(patch).eq("id", input.docId)` (`transitionIn.ts:217`) runs under the caller's own RLS, while the panel is surfaced to project managers who need no document-write authority.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Correct: the exact population the panel targets (non-controller project owner) is the population the trigger rejects, on every document. One narrative detail is off — the raw trigger message is surfaced only by the single-document path (adoptOne's `setMsg((e as Error).message)`); the bulk path at TransitionInPanel.tsx:127-131 reports `Adopted 0 of 12 — failed: <labels>` with the reason swallowed, which is arguably worse. HIGH stands.

**Mechanism.** The move guard raises when `collection_id` changes and the actor
is not Admin or Document Control (service role and null-JWT are exempt).
`adoptDocument` always changes `collection_id`, including to `null` for library
root — still `IS DISTINCT FROM`. The panel is offered to project owners too.

**Failure scenario.** A non-controller project owner picks a destination and
clicks "Adopt 12 clean." Every one fails: *"Adopted 0 of 12 — failed: …"*,
surfacing the raw trigger message *"Moving documents between folders requires
Admin or Document Control."*

**Remediation.** Either (a) hide the transition-in panel from non-controllers,
or (b) route adoption through a `SECURITY DEFINER` function that validates
project ownership and performs the move — the guard's intent is to stop
arbitrary moves, not to stop a sanctioned adoption. (b) preserves the feature.

**Done when.**
- The user who is shown the Adopt button can complete it, or is not shown it.
- No raw Postgres trigger message reaches the UI from this path.

**Resolution (2026-09-30, projects Round G).** Remedy (a): `components/projects/TransitionInPanel.tsx` shows the destination picker, the bulk button, the renumber input and Adopt only to the controller tier (`isControllerPrincipal` over the viewer's role collection — what the database's move guard, `is_org_controller`, means); a non-controller project owner sees the scan and a sentence saying adoption needs Admin or Document Control (and can still flag a conflict to drafting). `adoptDocument` maps the move guard's refusal (and any other) to a sentence; a zero-row write is reported. Tests — `lib/__tests__/transitionIn.test.ts` "the database's unique refusal and the move guard reach the operator as sentences"; the panel's gate is source-pinned in `lib/__tests__/intakeUploadRoute.test.ts`.

**Done-when.**
- [x] The user shown the Adopt button can complete it — ✓ (only the controller tier sees it).
- [x] No raw Postgres trigger message reaches the UI from this path — ✓.

**Scope / residual.** Remedy (b) — a SECURITY DEFINER adopt that lets a project owner with publish authority on the destination adopt — was not built; the collections guard (20261011) is unchanged.

---

## SAF-14 · The closeout override leaves no trace of what was overridden

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** audit integrity
- **Locations:**
  - `app/(protected)/projects/[id]/page.tsx:627-653` — the transition dialog
  - `lib/projectReport.ts:159` — the report's checklist rollup
  - `lib/turnover.ts:225` — waived counted as accepted
- **Related:** `SAF-4`
- **Re-verified:** hardening pass — **SURVIVES**. The gate lines are computed for display only (`projects/[id]/page.tsx:627-632`); nothing records which of them were failing at the moment the override was taken.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the closeout snapshot exists in the modal and dies there — neither project_activity (`Project completed`) nor audit_logs carries the gate counts, and the printed report is regenerated live so it reflects today's rows, not closeout day. Waived-counted-as-accepted is verbatim at turnover.ts:225. The 'N/A'd items omitted' phrasing is loose (turnover has no 'na' status; the omission is of `required: false` items and checklist items with applicability 'na'), but that does not change the finding. MEDIUM stands.

**Mechanism.** The override itself is well designed — gates shown plainly, a
note captured, an audit row written. It is the only control in the area that
handles an override properly. What the record does not preserve is *which*
gates were open at the moment of override, and with what counts.

**Failure scenario.** A project closed over four open turnover items and eleven
open punch items records only a free-text note. The report then counts waived
items as accepted and omits N/A'd items entirely, so on paper the project reads
as fully accepted. Six months later nobody can reconstruct what was outstanding
at closeout.

**Remediation.** Serialize the gate state — every gate, its pass/fail, and its
counts — into the audit row's `details` at override time. Render that snapshot
in the report's closeout section rather than recomputing from current state.

**Done when.**
- The override audit row contains the full gate snapshot.
- The printed report shows what was open at closeout, not what is open now.

**Resolution (2026-09-30, projects Round G).** Reproduced: the completion's audit row carried `details: { reason }` only; the gate lines lived in the dialog. `lib/projects.ts` `closeoutGateLines(snapshot)` builds the four gate lines once (punch, turnover, checklists, change orders — each `{ key, ok, text, openCount }`; a gate whose read failed or is not migrated is `ok: null`, "could not be read", never "clear"); `transitionProjectStatus` records them in the `PROJECT_COMPLETED` audit row as `details.gates` with `overridden` (any gate not clear) — from the snapshot the actor was SHOWN (the page passes `gateSnapshot`) or, when none was loaded, gathered at that moment; a failed gather is recorded as `gateSnapshotError` with `gates: null` AND `overridden: null` (unknown — never "not overridden"). The dialog renders the same `closeoutGateLines` and says the state is recorded. The report half (reading `details.gates` from the newest `PROJECT_COMPLETED` row) landed with J7 (`lib/projectReport.ts` `parseGateSnapshot`); it now prints the recorded lines.
- Commits: `7ca202f`, `9363ebb`
- Tests: `projects.test.ts` "SAF-14 — the completion's audit row records what was open at the override" (the four lines as recorded, and `parseGateSnapshot` reads back exactly those lines), "a gate whose read failed is recorded as UNKNOWN", "a snapshot that could not be gathered records overridden: null beside gates: null"; `projectPageRoundG.test.ts` "renders the recorded gate lines, passes them to the transition…".

**Done-when.**
- The override audit row contains the full gate snapshot — ✓.
- The printed report shows what was open at closeout, not what is open now — ✓ (J7's reader over this writer).

**Scope / residual.** Waived-counted-as-accepted in `lib/turnover.ts:225` (cited in the mechanism) is the quality package's (`QUAL-*`) semantics, not this record; unchanged. *Fix pass (2026-09-30):* the first cut computed `overridden` as `(gates ?? []).some(…)`, so a completion whose snapshot could not be gathered was recorded `{ gates: null, overridden: false }` — an unknown gate state written as a clean closeout. It is now `overridden: gates === null ? null : …`.

---

## SAF-15 · Approving an intake submission promotes whatever is pending now, not the version you were shown

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `components/projects/IntakePanel.tsx:237-241` — `approve(p)` passes only `documentId`
  - `lib/reviewControl.ts:402-406` — re-reads `pending_version_id` fresh
- **Re-verified:** hardening pass — **SURVIVES**. The panel holds `p.pendingVersionId` and does not pass it — `finalizeReviewedRevision` re-reads `pending_version_id` from the row at call time (`reviewControl.ts:402-406`). Whatever is pending when Approve lands is what publishes.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Correct — approval is keyed on the document, not on the version the reviewer was shown, and the CAS at reviewControl.ts:427-429 is on the freshly-read pendingId so it does not detect the substitution. The reject path two functions below shows the fix already exists in the file: it targets `.eq("id", p.pendingVersionId)`. MEDIUM stands.

**Mechanism.** Approve passes only the document id; finalize re-reads the
pending pointer fresh. The success message then reports the label from the
stale client row.

**Failure scenario.** Reviewer A has "P&ID-2101 Rev 5 pending" on screen.
Reviewer B rejects Rev 5 and the contractor submits Rev 6. Reviewer A, who
never refreshed, clicks Approve on the Rev 5 row. Rev **6** is promoted, and
the toast says *"P&ID-2101 Rev 5 approved — it is now the current revision."*
An approval of a file the approver never opened, recorded against a different
revision.

**Remediation.** Pass the expected `versionId` from the client and have
`finalizeReviewedRevision` compare-and-swap on it — the CAS machinery is
already there (`reviewControl.ts:429-439`), it just needs the caller's expected
value instead of the freshly-read one. On mismatch, refuse with "this
submission changed — refresh to see the current one."

**Done when.**
- Approving a stale row is refused rather than silently promoting a different version.
- The success message names the version that was actually promoted.

**Resolution (2026-09-30, projects Round G).** `IntakePanel` approve re-reads the document's `pending_version_id` (org-scoped) at the click and refuses when it is not the version on screen ("… changed since this list loaded — it has been refreshed. Check the submission shown now before approving."), and after `finalizeReviewedRevision` names what actually became current (the document's new `rev`) — or says the current revision is not the one approved. Test — `lib/__tests__/intakeUploadRoute.test.ts` "IntakePanel approve: the version on screen …" (source pin; the repo has no component renderer).

**Done-when.**
- [x] Approving a stale row is refused rather than silently promoting a different version — ✓.
- [x] The success message names the version that was actually promoted — ✓.

**Scope / residual.** `finalizeReviewedRevision` still re-reads the pointer itself; the window between the panel's check and that read is milliseconds. Passing the expected version into finalize's compare-and-set is a change to `lib/reviewControl.ts` (document-control P4's file) — noted for its owner.

---

## SAF-16 · The project timeline leaks in-review drafts that the document timeline deliberately hides

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-confidentiality
- **Locations:**
  - `lib/timeline.ts:324-332` — `getDocumentTimeline`, with the filter and the comment explaining it
  - `lib/timeline.ts:447-452` — `getProjectTimeline`, with no such filter
  - `lib/timeline.ts:513-514` — `getRevisionChain`, which also gets it right
- **Re-verified:** hardening pass — **SURVIVES**, and the contrast is forty lines apart in one file. The document timeline filters `.or("review_state.is.null,review_state.eq.approved")` with the comment *"the timeline must not leak them to everyone"* (`timeline.ts:324-332`); the project timeline's query over the same table has **no such filter** (`:447-452`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by direct comparison of the three queries in one file, and there is no database backstop: repo-wide grep for review_state in supabase/migrations returns only the ADD COLUMN and the two CHECK constraints (20260818:34-35, 20260906:42-43) — no RLS policy filters drafts, so PostgREST returns them. Note the leak is slightly wider than stated: 'rejected' versions ride through the same missing filter. MEDIUM stands.

**Mechanism.** The document reader filters
`.or("review_state.is.null,review_state.eq.approved")` with the comment
"In-review drafts are only visible to their reviewers/owner … the timeline must
not leak them to everyone." The project reader has no such filter.

**Failure scenario.** Any project viewer who can read the document sees pending
intake submissions' revision labels, change logs and submitting company before
review. Two of three readers get this right; only the project reader is wrong.

**Remediation.** Copy the filter from `getDocumentTimeline` into
`getProjectTimeline`'s `document_versions` query.

**Done when.**
- An in-review version does not appear in the project timeline for a non-reviewer.
- The three timeline readers apply the same visibility rule.

**Resolution (2026-09-30, projects Round G).** Reproduced: `getProjectTimeline`'s `document_versions` query had no review-state filter (the document timeline and the revision chain did). `lib/timeline.ts` exports ONE rule, `CONTROLLED_VERSIONS_ONLY` (`review_state.is.null,review_state.eq.approved`), and all three readers apply it — the project reader now drops in-review and rejected versions.
- Commit: `054cb61`
- Tests: `timeline.test.ts` "an in-review or rejected version of a linked document does not reach the project timeline" (the filter executed by the mock over null / approved / in_review / rejected rows) and "the document timeline, the revision chain and the project timeline all read CONTROLLED_VERSIONS_ONLY" (three uses, no literal left).

**Done-when.**
- An in-review version does not appear in the project timeline for a non-reviewer — ✓ (for everyone, reviewers included — the same rule as the document timeline).
- The three timeline readers apply the same visibility rule — ✓.

**Scope / residual.** None.

---

## SAF-17 · Detaching a document from a project amputates its history from the project timeline

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** audit integrity
- **Locations:**
  - `components/projects/ProjectDocumentsCard.tsx:135-144` — `detach`
  - `lib/timeline.ts:423-433` — document scope resolved entirely from `project_documents`
- **Related:** `SEC-17` (any member can detach)
- **Re-verified:** hardening pass — **SURVIVES**. `detach` deletes the `project_documents` row (`ProjectDocumentsCard.tsx:138`), and `getProjectTimeline` derives every document event from exactly that table (`timeline.ts:423-433`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Mechanically correct, including the tooltip detail: ProjectDocumentsCard.tsx:225 shows the re-link warning only for `r.source === "checkout"`, and manually attached docs get a bare "Remove from project". Worth recording that the loss is display-scoped and reversible — no audit_log, document_version or hold row is deleted, the document's own timeline is untouched, and re-attaching restores the project timeline in full, since the join is computed live. MEDIUM (already the floor here) stands.

**Mechanism.** The timeline resolves its entire document scope from
`project_documents`. Deleting that row removes every audit event, version event
and hold event for that drawing from the project's Activity tab — while the
checkout rows below still list it.

**Failure scenario.** One ✕ click erases a drawing's history from the project
view. A `doc_removed` activity row is written, but the *loss* is invisible: the
tooltip only warns "it will re-link on the next checkout." For a PSM shop this
is a one-click history erasure. Combined with `SEC-17`, any active org member
can do it.

**Remediation.** Soft-delete the link (`detached_at`) rather than deleting the
row, and have the timeline include detached links for historical events while
excluding them from the current-documents list. Warn in the confirm that
project history for the document will be hidden.

**Done when.**
- Detaching preserves the document's historical events in the project timeline.
- The confirm states the consequence.
- Only owners and controllers can detach (see `SEC-17`).

**Resolution (2026-09-30, projects Round G).** Reproduced: the timeline's document scope was exactly the `project_documents` rows; a detach deleted the row and with it the drawing's history from the project view. `getProjectTimeline` now also reads the project's `doc_removed` feed rows (`metadata.documentId`) and keeps a detached document's audit / version / hold events **up to its latest detach** (`detachCutoffs`); anything that happens to it afterwards is not the project's; a re-linked document is simply linked. No schema change: the history of documents detached BEFORE this fix returns too, wherever the UI wrote its `doc_removed` row. The detach confirm (`ProjectDocumentsCard`) states the consequence ("Its history up to now stays on the project's Activity tab; anything that happens to it after this is not shown there", plus the re-link note for checkout-sourced rows); the `doc_removed` row goes through `writeActivity` (checked, author stamped by the database) and — `supabase/migrations/20261102_prj_roundG_project_rails.sql` — only the register's own authority (owner or controller) may write `doc_added` / `doc_removed` rows, so nobody can plant a detach record that pulls a document's history into a project.
- Commits: `054cb61`, `e0c1aa2`, `9363ebb`
- Tests: `timeline.test.ts` "a detached document's events up to the detach remain; later ones are not the project's", "detachCutoffs: the latest detach wins; a re-linked document is simply linked"; `projectPageRoundG.test.ts` "detaching states the consequence first; declining removes nothing; confirming removes and writes the stamped feed row".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` (the owner-or-controller detach rail, with `SEC-17`).

**Done-when.**
- Detaching preserves the document's historical events in the project timeline — ✓.
- The confirm states the consequence — ✓.
- Only owners and controllers can detach (see `SEC-17`) — ✓ UI; database after `supabase/migrations/20261102_prj_roundG_project_rails.sql`.

**Scope / residual.** The remediation suggested a soft-delete column; the feed row already records the detach (document and time), so the history is recovered without a schema change and without touching the resync trigger's re-link behaviour. A detach made by a direct API delete that wrote no `doc_removed` row (possible before `supabase/migrations/20261102_prj_roundG_project_rails.sql`) is not recoverable this way. *Second fix pass (2026-09-30):* the register's INSERT (an attach) now admits the project's managers (`can_manage_project`, the fleet plan's predicate — see `SEC-17`). A detach, and an UPDATE that could move a link (a detach by another name), stay owner-or-controller, and so do `doc_added` / `doc_removed` feed rows. dw3 is unchanged. *Third fix pass (2026-09-30):*
- **Moved links.** A link that moves is now refused outright, by `trg_project_documents_link_fixed` (BEFORE UPDATE on `project_documents`, 20261102) for any signed-in caller. The UPDATE policy therefore follows the fleet plan (`can_manage_project`, in a project the caller can see; see `SEC-17`). The detach (DELETE) and the `doc_*` feed rows stay owner-or-controller, so dw3 is unchanged.
- **The history read.** The timeline's read of `doc_removed` rows had no range, so a register with more than 1,000 detaches lost cutoffs silently. It is now paged to exhaustion (see `SAF-6`), so dw1 ("history preserved") holds at any size.


**Residual (2026-09-30, projects Round G — final review, not fixed).** The preserved history depends on a second client request: the `doc_removed` feed row is written after the DELETE (`components/projects/ProjectDocumentsCard.tsx` ~:132). A detach whose second request fails leaves no cutoff row, the same as the raw-API case already recorded. Writing the feed row in the same statement, through a trigger on `project_documents` delete, would close it.

---

## SAF-18 · Outside the quality and money paths, 177 update / delete sites still discard a zero-row result

*Numbered SAF-18 on this branch (opened by projects-joint J12 SERVER REMAINDERS as `GAP-402`'s remainder, per its Scope and `DEC-31`). If the number collides at merge the integrator renumbers.*

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** — (unassigned; the integrator assigns by file owner)
- **Verification:** CONFIRMED (by the census in `lib/__tests__/checkedWrite.test.ts`, at `2af813b` + J12; not exercised against a live database)
- **Blast radius:** audit integrity / silent failure
- **Locations:** (unchecked `.update(` / `.delete(` statements on a supabase chain, per file — the census's `writeSites`)
  - `lib/knowledgeIngest.ts` 17, `lib/milestones.ts` 12, `lib/projects.ts` 9, `lib/reviewControl.ts` 9, `lib/acknowledgments.ts` 7, `lib/checkoutEpisodes.ts` 6, `lib/collections.ts` 6, `lib/libraryCollections.ts` 6, `lib/operationalGraph.ts` 6, `lib/revisions.ts` 6, `lib/reviewCycles.ts` 5, and 37 more `lib` files with 1–4 each (158 in `lib` in all — the `LIB_RATCHET` table names every file and count)
  - the Projects surface: `app/api/intake/upload/route.ts` 10, `components/projects/IntakePanel.tsx` 5, `components/projects/EditProjectModal.tsx` 1, `components/projects/ProjectWizard.tsx` 1, `components/projects/cost/ChangeOrdersPanel.tsx` 1, `app/api/projects/cost-docs/route.ts` 1 (the read's save builder; its zero-row result is checked one statement later, a shape the census does not follow)
- **Related:** `GAP-402` (whose Scope asked for this finding), `SAF-3`, `DEC-31`
- **Independently verified:** — (`author`: opened by projects-joint J12 from the widened census; not yet challenged)

**Mechanism.** `supabase-js` resolves a write with `{ data, error }` and never throws; an UPDATE or DELETE that RLS filters to zero rows returns no error at all. A statement that neither routes through `lib/checkedWrite.ts` nor asks for the matched rows (`.select("id")`) and tests their count reads a refused write as success. `GAP-402` converted the quality and money paths; these sites were left, by Scope, for a finding.

**Failure scenario.** A member whose role lost a write permission edits a milestone, a collection or a review assignment; the policy filters the UPDATE to zero rows; the screen says it saved, and — where an audit row follows — the trail records a change that did not happen (`SAF-3`'s shape).

**Remediation.** Per file, by its owner: route each write through `checkedWrite(…select("id"))` (or the count-checked shape) and surface the refusal; lower the file's number in `LIB_RATCHET` / `PROJECTS_UI_RATCHET` in the same change, and move a file that reaches zero to the clean list.

**Done when.**
- Every `lib` file and every Projects-surface file has zero unchecked update / delete sites, and the ratchets are empty.
- No audit row is written after a write that matched zero rows, on any of those paths.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| SAF-1 | CRITICAL | RESOLVED |
| SAF-2 | HIGH | RESOLVED |
| SAF-3 | CRITICAL | RESOLVED |
| SAF-4 | HIGH | RESOLVED |
| SAF-5 | CRITICAL | RESOLVED |
| SAF-6 | HIGH | RESOLVED |
| SAF-7 | HIGH | OPEN |
| SAF-8 | MEDIUM | RESOLVED |
| SAF-9 | HIGH | OPEN |
| SAF-10 | HIGH | RESOLVED |
| SAF-11 | HIGH | RESOLVED |
| SAF-12 | HIGH | RESOLVED |
| SAF-13 | HIGH | RESOLVED |
| SAF-14 | MEDIUM | RESOLVED |
| SAF-15 | MEDIUM | RESOLVED |
| SAF-16 | MEDIUM | RESOLVED |
| SAF-17 | MEDIUM | RESOLVED |
| SAF-18 | MEDIUM | OPEN |
