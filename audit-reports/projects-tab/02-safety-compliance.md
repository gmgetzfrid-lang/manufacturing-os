# 02 · Safety, compliance & the record

The PSSR, turnover and closeout surfaces — where a false green is the failure
that matters — plus the audit trail that is supposed to prove what happened.

**17 findings** — 6 CRITICAL, 7 HIGH, 4 MEDIUM.

> Line numbers are from commit `6a14d7d` and drift with edits. **Match on the
> quoted code, not the number.** See [`../README.md`](../README.md) for the
> resolution protocol.

---

## SAF-1 · A contractor's self-typed filename can turn a PSSR item green

- **Severity:** CRITICAL
- **Status:** OPEN
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

---

## SAF-2 · The AI can mark thirty of forty PSSR items not-applicable behind one count-only confirmation

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-3 · A write denied by row-level security reports success and writes an audit row claiming it happened

- **Severity:** CRITICAL
- **Status:** OPEN
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

---

## SAF-4 · Every route to a green closeout gate accepts a blank reason on one keypress

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-5 · Auto-supersede is a raw column write, so the whole post-publish compliance pipeline is skipped

- **Severity:** CRITICAL
- **Status:** OPEN
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

---

## SAF-6 · The project timeline cannot see the controls program at all

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-7 · Re-baselining destroys the approved plan irreversibly, and the confirmation invites it

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-8 · A task can be Missed and one-hundred-percent earned at the same time

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SAF-9 · A rejection reason never reaches the contractor, and nothing notifies them either way

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-10 · Auto-supersede orphans a pending review and its e-signatures

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-11 · A rejected submission remains an adoptable transition-in candidate

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-12 · A known number collision can be adopted in one click, creating two live documents on one number

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-13 · Adopt is broken for precisely the user the panel is offered to

- **Severity:** HIGH
- **Status:** OPEN
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

---

## SAF-14 · The closeout override leaves no trace of what was overridden

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SAF-15 · Approving an intake submission promotes whatever is pending now, not the version you were shown

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SAF-16 · The project timeline leaks in-review drafts that the document timeline deliberately hides

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## SAF-17 · Detaching a document from a project amputates its history from the project timeline

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| SAF-1 | CRITICAL | OPEN |
| SAF-2 | CRITICAL | OPEN |
| SAF-3 | CRITICAL | OPEN |
| SAF-4 | CRITICAL | OPEN |
| SAF-5 | CRITICAL | OPEN |
| SAF-6 | CRITICAL | OPEN |
| SAF-7 | HIGH | OPEN |
| SAF-8 | HIGH | OPEN |
| SAF-9 | HIGH | OPEN |
| SAF-10 | HIGH | OPEN |
| SAF-11 | HIGH | OPEN |
| SAF-12 | HIGH | OPEN |
| SAF-13 | HIGH | OPEN |
| SAF-14 | MEDIUM | OPEN |
| SAF-15 | MEDIUM | OPEN |
| SAF-16 | MEDIUM | OPEN |
| SAF-17 | MEDIUM | OPEN |
