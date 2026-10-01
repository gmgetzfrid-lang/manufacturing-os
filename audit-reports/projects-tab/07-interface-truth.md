# 07 · Truth in the interface

Where the copy promises more than the machine delivers, where typed input is
lost, and where the machine's failures never reach the user.

Most of these are cheap. Each one is a place where a user learns not to trust
the tool.

**15 findings** — 1 CRITICAL, 12 HIGH, 2 MEDIUM.

> Line numbers drift — **match on the quoted code.** See
> [`../README.md`](../README.md) for the protocol.

---

## UX-1 · Five of the wizard's six writes fail silently, and four fields are lost permanently

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-loss
- **Locations:**
  - `components/projects/ProjectWizard.tsx:149-151` — purpose, goals, success criteria, job kind, SOW, setup state → `console.warn`, and **nothing at all** for `PGRST204` / `42703`
  - `components/projects/ProjectWizard.tsx:162` — budget lines → `console.warn`
  - `components/projects/ProjectWizard.tsx:168-172` — milestones → `.then(() => undefined, () => undefined)`, total swallow
  - `components/projects/ProjectWizard.tsx:191, 193` — contractors → `console.warn`
  - `components/projects/ProjectWizard.tsx:199-201` — turnover seeds → `.catch(() => undefined)`, and `seedTurnoverItems` returns `{ok:false}` rather than throwing, so double-swallowed
  - `components/projects/ProjectWizard.tsx:203-204` — then routes to the project as if everything worked
  - `components/projects/EditProjectModal.tsx:36-42` — patches only `name`/`description`/`mocReference`/`targetCompletionDate`/`visibility`
  - `components/projects/ProjectWizard.tsx:153` — the comment claiming "typed input is never silently discarded"
- **Re-verified:** hardening pass — **SURVIVES**. `if (accErr) console.warn(…)` and the equivalent at `:149-151` log and continue — nothing reaches the user and nothing aborts the wizard, so a rejected write reads as a successful step.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Every sub-claim verified line by line. The silent money loss is unconditional, not migration-dependent: :155 filters on `Number(r.budget || 0) >= 0`, and `Number("1,200,000")` is NaN, so a comma-typed budget drops the whole row with no warning. (20261013 does add the columns and an owner-write policy on the cost tables, so on a migrated DB the RLS/schema failure modes are narrower than the report implies — but the swallow structure and the four uneditable fields stand.)

**Mechanism.** Only the first write reports failure. Compounding it,
`Number("1,200,000")` is `NaN`, so a budget typed the way people type money is
silently dropped.

**And four fields are unrecoverable.** Purpose, goals, success criteria and
`sow_document_id` are written in exactly one place — the wizard — and the edit
modal patches none of them. The two coach items that resurface them are dead
ends because no interface exists to satisfy them (`UX-6`).

**Failure scenario.** The user types a purpose, three goals, four budget lines,
two milestones and two contractors, and lands on a project with none of it —
where the coach immediately asks for all of it back. This is the impatience tax
inverted: you invest the effort *and* the system throws it away without saying
so.

**Remediation.**
1. Collect failures from all six writes and, if any failed, land on the project
   with a visible, dismissible strip: *"Your 4 budget lines and 2 milestones
   didn't save — [Retry]"*, holding the values.
2. Parse money with a tolerant parser (strip separators and currency symbols)
   and reject non-numeric input at the field, not silently at write time.
3. Add purpose / goals / success criteria / SOW to `EditProjectModal` so the
   wizard's promise becomes true and the coach items become actionable.

**Done when.**
- A failed write is visible to the user with the data still recoverable.
- `1,200,000` is accepted as a budget.
- All four wizard-only fields are editable after creation.
- A test asserts a failing sub-write surfaces rather than being swallowed.

**Resolution (2026-09-29, projects Round G).** The five follow-up writes now run through the new `lib/projectWizardWrites.ts` (`runWizardFollowUpWrites`), which binds every error — the milestones insert loses `.then(() => undefined, () => undefined)`, the turnover seed's `{ ok: false }` counts as a failure, the extended-fields update reports a `PGRST204` / `42703` as "the database has not been migrated for …" instead of treating it as success — and returns the list of what did not save. `components/projects/ProjectWizard.tsx` keeps the project (createProject already committed) but no longer routes on a partial failure: it stays open with a `role="alert"` panel naming exactly what did not save and why, the typed rows stay in component state, **Retry unsaved** re-runs only the refused steps (`only: Set<WizardWriteStep>`), and **Open project anyway** is the explicit choice. Money is parsed by `parseMoneyInput` (strips `$ € £ ¥`, commas, spaces): `1,200,000` saves as 1200000; an unparseable amount is flagged at the field (`aria-invalid`, red border, a line naming the row) and blocks Create with a message pointing at step 4, instead of dropping the row at write time; the false comment at `:153` is gone. `components/projects/EditProjectModal.tsx` now reads and edits purpose, goals, success criteria and the Summary of Work (document search, same as the wizard); the write is checked, refuses to overwrite when the read failed, and audits before/after (`PROJECT_UPDATED`) — the coach's `sow` / `purpose` items point at it (see `UX-6`). Tests: `lib/__tests__/projectWizard.test.ts` — "a refused cost_accounts insert surfaces, named, with the rows untouched for a retry", "the milestones insert binds its error…", "a turnover seed that returns { ok: false } is a failure…", "accepts 1,200,000…", "the retry re-runs ONLY the refused steps with the retained rows". Reproduced: `ProjectWizard.tsx:149-201` at `8276cad` is quoted verbatim in the finding; the wizard-writes tests exercise the same failure shapes the finding describes.

**Fix pass (2026-09-29, projects Round G review).** Three edges closed. (1) `EditProjectModal`: the Summary of Work attachment is set (`{ id, label: "Document" }`) the moment the fields become editable and only its label is filled in after the `documents` lookup, so a Save inside that lookup's latency no longer writes `sow_document_id = null` (and audits it as a deliberate removal). (2) `EditProjectModal`: when the identity fields saved but the purpose/goals/SOW write was refused, the modal keeps the saved patch (`savedIdentity`), **Save changes** retries only the refused second write (an identity field edited since is written again), the error says which half landed, and Cancel / X / backdrop become **Close** and go through `onSaved` so the page refreshes and the header shows the saved name. The modal also calls `invalidateProjectSnapshot` after its write (`PERF-3`). (3) `ProjectWizard`: in the partial-failure state the header X now asks (`appConfirm`) before discarding the retained rows and calls `onCreated()` on the way out, so the list shows the project that exists instead of inviting a duplicate. Component files are outside the vitest include; verified by reading.

**Second fix pass (2026-09-30, projects Round G review).** The failure state hid every step body, so "what you typed is still here" was true only in component state: a refusal that is not transient (a CHECK or numeric-overflow rejection, an RLS denial for a non-owner creator) fails identically on **Retry unsaved**, and the only exits — **Open project anyway** or the X — then discarded rows the user had never been shown. The panel now lists, under each failed step, **What you typed** as read-only, selectable lines with a **Copy** button (`retainedRowLines(input, step, sowLabel)` in `lib/projectWizardWrites.ts`: "Piping subcontract — subcontract — 200,000 USD", "Mobilize — 2026-10-01", "Gulf Mechanical — contractor — piping", "Purpose: …" / "Goal: …" / "Job size: …" / "Summary of Work: <label>"), and the copy says to copy them and add them from the project's tabs if the same refusal comes back. Editing a refused row in place and retrying is not offered. Tests: `lib/__tests__/projectWizard.test.ts` "a data refusal fails the same way on Retry, so the typed rows are shown for every failed step" and "covers every step that carries typed input".

**Done-when.**
- A failed write is visible to the user with the data still recoverable — ✓. A transient refusal is recovered by **Retry unsaved** (rows retained in state). A persistent one fails the same way on retry; its typed rows are then shown read-only and copyable in the panel, and the user re-enters them from the project's tabs. They cannot be edited in place and retried.
- `1,200,000` is accepted as a budget — ✓ (`parseMoneyInput`, `prepareBudgetRows`).
- All four wizard-only fields are editable after creation — ✓ (`EditProjectModal`).
- A test asserts a failing sub-write surfaces rather than being swallowed — ✓ (`projectWizard.test.ts`).

**Scope / residual.** The banner lives in the wizard (over the projects list) rather than on the destination project page: `app/(protected)/projects/[id]/page.tsx` is J8's file, and the wizard already holds the rows the retry needs, so the failure is shown *before* routing rather than carried across a navigation. The wizard still writes purpose/goals/SOW with a direct checked `projects.update` (as before) rather than through `lib/projects.ts` (J8's); `EditProjectModal` audits its own write. `GAP-402`'s generic checked-write helper was not merged when this landed; `runWizardFollowUpWrites` is the wizard-shaped instance of it.

---

## UX-2 · Every brand-new project scores zero and is labelled Concern

- **Severity:** HIGH
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Blast radius:** ux / trust
- **Locations:**
  - `lib/projectHealth.ts` — `computeProjectHealth`
  - `lib/companyScore.ts:153-164` — the correct pattern, in the same codebase
- **Re-verified:** hardening pass — **SURVIVES**. `composite` is `null` when no dimension has a score (`companyScore.ts:160-161`), and a brand-new project has `evidenceCount` zero across every term of the sum (`:154-158`) — the band the UI derives from that is what produces the Concern label.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). False as written: the finding's own remediation ("copy lib/companyScore.ts — null parts excluded, composite null renders 'not enough data'") is already the shipped behaviour in computeProjectHealth. The claimed dashboard blast radius is also unreachable — grep shows gatherProjectSnapshot/ProjectCoach render on the project detail page only, with no project health score on the projects list or any dashboard widget.

**Mechanism.** A project created thirty seconds ago has no cost data, no
schedule and no quality records, so every health part scores zero and the
composite lands in the lowest band.

**Failure scenario.** The first thing a new user sees after creating their first
project is a red "Concern" verdict on a project they have not started. It is
also actively misleading on a dashboard of many projects, where a new project is
indistinguishable from a failing one.

**Remediation.** Copy the company scorecard's approach: a part with no evidence
scores `null` and is **excluded** from the composite, and a composite with no
parts renders as "Not enough data yet" rather than 0 · Concern.
`lib/companyScore.ts` already does exactly this and has tests.

**Done when.**
- A new project reads "Not enough data yet", not "0 · Concern".
- A part with no evidence does not drag the composite down.
- A test pins the empty-project case.

---

## UX-3 · "Each one auto-greens the moment its document lands" — nothing runs automatically

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth
- **Locations:**
  - `lib/projectHealth.ts:225` — the claim
  - `components/projects/QualityTab.tsx:324` — `runAutoEvidence`'s only caller in the repo
  - `components/projects/QualityTab.tsx:378-382` — the button, explained only by a tooltip
- **Re-verified:** hardening pass — **SURVIVES**. The coach promises *"Each one auto-greens the moment its document lands"* (`projectHealth.ts:225`) while `runAutoEvidence` is invoked only from a button handler (`QualityTab.tsx:324`). Nothing schedules it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Absence verified by repo-wide search, so the copy promises automation that has exactly one manual trigger.

**Mechanism.** The evidence sweep has exactly one caller: a manual button
labelled "Check evidence we already hold." Nothing calls it on document upload,
on turnover acceptance, on page load, or on any schedule.

**Failure scenario.** A PSSR reviewer uploads the hydrotest records the day
before startup, watches the coach still say "3 items need evidence," and
concludes the system is broken or lying.

**Remediation.** Either make it true or make it honest.
- *True (preferred):* run the sweep after an intake approval and after a
  turnover item is accepted — the two moments new evidence actually arrives.
  Then the copy describes the product.
- *Honest:* rewrite to "Run the evidence check and the ones we can prove turn
  green with the citation attached."

Note `SAF-1` must be fixed first — automating a sweep that can green on an
unreviewed draft filename makes that problem worse, not better.

**Done when.**
- The copy and the behaviour agree.
- If automated, the sweep runs after intake approval and turnover acceptance.

**Resolution (2026-09-29, projects Round G).** Honest, not automated (the package's stated default — no sweep is scheduled here, and `SAF-1` is still open). `lib/projectHealth.ts` `evidence` payoff now reads: *"Nothing runs on its own — run "Check evidence we already hold" on the Quality tab; items with a matching document on file turn green with the citation attached."* — the button's exact label, the tab it is on, and what the sweep does. Test: `lib/__tests__/projectControls.test.ts` "coach copy claims no unbuilt mechanism" (no `auto-green` anywhere in coach output) and "every coach action names a verb that exists…" (the payoff names the button; the href is `?tab=quality`). Reproduced: `projectHealth.ts:225` at `8276cad` read `"Each one auto-greens the moment its document lands."`; `runAutoEvidence` has one caller, `QualityTab.tsx:324`, a button handler.

**Done-when.**
- The copy and the behaviour agree — ✓.
- If automated, the sweep runs after intake approval and turnover acceptance — not done, by decision: nothing was automated in this package (`DEC-31`); the automated sweep is recorded as the new finding `UX-16` below for the intake (P1) and quality (P2) packages, to be built after `SAF-1`.

**Scope / residual.** `UX-16` carries the "make it true" half.

---

## UX-4 · "Their documents and quotes land here and process themselves" — a human must click Read

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth
- **Locations:**
  - `lib/projectHealth.ts:243` and `components/projects/cost/QuotesPanel.tsx:599-601` — the claims
  - `app/api/intake/upload/route.ts:88` — inserts with `status: "draft"`
  - `lib/costDocs.ts:93-94` — the comment stating it plainly: *"The AI hasn't read it yet — that's the parse route, and it's a separate, deliberate click."*
  - `app/api/intake/upload/route.ts:107` — the app's own honest wording
- **Re-verified:** hardening pass — **SURVIVES**. *"Their documents and quotes land here and process themselves"* (`projectHealth.ts:243`) and the panel's own copy repeating it (`QuotesPanel.tsx:599-601`), against a `ReadButton` a human must click before any total exists.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Checked for an auto-parse the finding might have missed — no parse endpoint is invoked from the intake upload route or from any upload handler; the two overstating strings contradict the notification the same route sends.

**Mechanism.** The quote lands as a draft. A human must click **Read**.

**Failure scenario.** The owner sends four contractors links, goes home, comes
back expecting a bid tab, and finds four rows saying "Uploaded — not read yet."

**Remediation.** The application's own notification already says the right
thing: *"Run the AI read from the project's Costs tab to tabulate it."* Copy
that wording into the two places that overstate it. (Auto-reading on arrival is
not obviously right — it spends the user's own AI budget without a click — so
prefer fixing the copy.)

**Done when.**
- No UI string claims quotes process themselves.

**Resolution (2026-09-29, projects Round G; copy corrected 2026-09-30 after review).** `lib/projectHealth.ts` `links` payoff now says where each kind of upload lands and what the human does: *"Documents land on the Intake tab for review; quotes land on the Costs tab as drafts — run the AI read there to tabulate them."* The first wording sent quotes to the Intake tab. That was wrong: a quote-purpose link inserts a `cost_documents` row with status `draft`, which appears on the Costs tab's Quotes panel, and the intake route's own notification links `?tab=costs` (`app/api/intake/upload/route.ts:62-111`). Test: `projectControls.test.ts` "coach copy claims no unbuilt mechanism" (`process themselves` absent). The `links` assertions check that documents land on the Intake tab, that quotes land on the Costs tab as drafts and never on the Intake tab, and that the AI read happens there. Reproduced: `projectHealth.ts:243` at `8276cad` read `"Their documents and quotes land here and process themselves."`.

**Done-when.**
- No UI string claims quotes process themselves — ✓ for the coach. The second site the finding cites, `QuotesPanel.tsx:599-601`, no longer exists in that form: at `8276cad` the panel's empty state (`:120`) says submissions *"land here on their own"* — a claim about arrival (true: they land as drafts), not processing. `QuotesPanel.tsx` is P4's file and was not edited.

**Scope / residual.** None.

---

## UX-5 · "Closeout is gated on acceptance; contractors are scored on it" — both halves are false

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth
- **Locations:**
  - `lib/projectHealth.ts:231` — the claim
  - `app/(protected)/projects/[id]/page.tsx:646-649` — "You can complete anyway", the actual behaviour
  - `lib/companies.ts:248` — scoring via `turnover_items.party_id`
  - Repeated at `lib/turnover.ts:8-9`, `lib/turnover.ts:187-188`, `components/projects/QualityTab.tsx:17`
- **Related:** `MON-7`
- **Re-verified:** hardening pass — **SURVIVES**, and the app contradicts itself on one screen. `payoff: "Closeout is gated on acceptance; contractors are scored on it."` (`projectHealth.ts:231`) against the closeout panel's own text — *"You can complete anyway — the open items stay on the record and in the report"* (`projects/[id]/page.tsx:646-649`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The 'no interface ever sets party_id' claim is the kind that needed a repo-wide check; it holds for turnover_items and punch_items, so those scorecard counts are structurally zero. Same copy repeated at turnover.ts:7-8 and QualityTab.tsx:17.

**Mechanism.** **Not gated:** the transition dialog says, correctly, "You can
complete anyway — the open items stay on the record." The behaviour is right;
the coach calls it a gate. **Not scored:** turnover reaches the company profile
through `party_id`, which no interface ever sets, so accepted / rejected / punch
counts on every scorecard are structurally zero.

**Remediation.** Fix `MON-7` (wire `party_id`), which makes the second half
true. Rewrite the first half to "Acceptance is what the closeout gate checks" —
the gate is a check with an override, not a block, and that is the correct
design.

**Done when.**
- The copy describes a check-with-override, not a gate.
- The scoring claim is true, or removed until `MON-7` lands.

**Resolution (2026-09-29, projects Round G; copy corrected 2026-09-30 after review).** Both halves corrected in `lib/projectHealth.ts`. Gate strictness now has one source of truth, `CLOSEOUT_GATE_POLICY` (`blocking: false`, `summary`, `overrideNote` — the dialog's exact line), and the coach's `turnover` payoff *is* `CLOSEOUT_GATE_POLICY.summary`: *"Closeout gates are checks with an override, not blocks — you can complete anyway; open items stay open on the record."* The first wording ("open items are recorded on the closeout") described a snapshot nothing writes yet: `transitionProjectStatus` records `details: { reason }` only (`lib/projects.ts`), and the report prints "No gate snapshot was recorded with this completion" for every completion today. That wording is J8's to switch on when PC-2 / `SAF-14` records the gate snapshot. The scoring claim is removed (no coach string says contractors are scored) until `MON-7` wires `party_id`. Tests: `projectControls.test.ts` "gate strictness has one source of truth, and the coach quotes it", "no copy says open items are 'recorded on the closeout' while nothing records a gate snapshot" (reads `transitionProjectStatus` and, while it writes no gate key the report can read, asserts the phrase is absent from every gate string and coach payoff), and the copy-truth test (`gated on` / `scored on it` absent). Reproduced: `projectHealth.ts:231` at `8276cad` read `"Closeout is gated on acceptance; contractors are scored on it."` against `page.tsx:649` *"You can complete anyway…"*.

**Done-when.**
- The copy describes a check-with-override, not a gate — ✓.
- The scoring claim is true, or removed until `MON-7` lands — ✓ (removed).

**Scope / residual.** Both of this finding's done-whens are met. The dialog's line in `app/(protected)/projects/[id]/page.tsx:649` is byte-identical to `CLOSEOUT_GATE_POLICY.overrideNote` but is not yet *read from* it — that one-line import is J8's and is the third done-when of projects-and-cost `QUAL-9`, which therefore stays OPEN (Partial) until J8 lands it; this finding does not close `QUAL-9` by pointer.

**Verification fix (2026-09-30, projects Round G).** Pointer for J8, not fixed here (`page.tsx` is J8's and is being rewritten). The closeout-gates dialog (`app/(protected)/projects/[id]/page.tsx:636-639`) builds its four lines from `gatherProjectSnapshot`'s counts and never reads `readFailures` / `notMigrated`. A refused or not-migrated read therefore shows as a pass: `punch_items` gives "Punch list clear", `turnover_items` gives "No turnover requirements set", `project_checklists` / `checklist_items` give "Checklists clear", and `change_orders` gives "No change orders awaiting decision", each with the green check. The coach already leaves such zeros out (`lib/projectHealth.ts` `SNAPSHOT_READS`). For each gate line, the dialog should check whether the snapshot names that line's read (`SNAPSHOT_READS.punch`, `.turnover`, `.checklists` / `.checklistItems`, `.changeOrders`) in `readFailures` or `notMigrated`. If it does, the line should render "Could not read …" or "Needs migration 20261013" as unknown (neither a check nor a pass), and the dialog should not count it as clear. Listed under this fix's `filesOutsidePlan`.

---

## UX-6 · The coach names an action that doesn't exist and advertises a metric that is hard-coded null

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth / dead ends
- **Locations:**
  - `lib/projectHealth.ts:182-183` — "Review N read documents waiting for your confirmation" / "Confirmed quotes join the bid comparison"
  - `components/projects/cost/QuotesPanel.tsx:195-204` — a parsed quote joins the bid table immediately
  - `lib/projectHealth.ts:177` — "Unlocks … schedule health (SPI)"
  - `lib/projectSnapshot.ts:120` — `spi: null, // needs the schedule tab's EV math + history; null stays honest`
  - `lib/projectHealth.ts:208, 214` — the sow/purpose items, unactionable
  - `app/(protected)/projects/[id]/page.tsx:105-110` — one of them does not even change tabs
- **Re-verified:** hardening pass — **SURVIVES**. The coach names a confirmation step (`projectHealth.ts:182-183`) that no surface implements — the tabulation is computed straight from `parsedQuoteFrom` with no confirm state (`QuotesPanel.tsx:195-204`) — and the metric it advertises is `cpi`, which `MON-5` shows is null on the printed report.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves verified, including the dead SPI branches and the same-page href that cannot change tabs (page.tsx:105-110 only reacts to a `tab` param the purpose item never sets).

**Mechanism.** There is no "confirm" action anywhere in the quotes panel — the
verbs are **Award**, **Void**, and **type total** — and a parsed quote joins the
bid table on parse, not on any confirmation. Separately, `spi` is hard-coded
null, so every SPI branch in `computeProjectHealth` is unreachable in
production, while the test fixture passes a real value that production can never
produce.

**Failure scenario.** The user is sent hunting for a button that does not exist,
for a step that already happened.

**Remediation.**
- Use the verbs that exist: **Award** and **Post as actual**.
- Drop "(SPI)" until `projectSnapshot` returns a real value, and remove the SPI
  glossary entry from the Costs tab (it appears there for a metric that surface
  never shows).
- Make the sow/purpose coach items point at a real editor once `UX-1`'s third
  remediation lands; until then remove them rather than nag with no path.
- Change the test fixture to reflect what production can produce, so the
  unreachable branch is visible.

**Done when.**
- Every coach item names an action that exists and links to a place it can be done.
- No advertised metric is hard-coded null.

**Resolution (2026-09-29, projects Round G).** Every coach item now names an action that exists and links where it can be done. `confirm-docs`: *"N read document(s) waiting on you — Read quotes are already in the bid comparison — award the winner; read invoices post as spend when you post them as actual"* (the panel's verbs are **Award** and **Post as actual**; there is no confirm step). `sow` / `purpose` (corrected 2026-09-30 after review): *"Attach a Summary of Work (Edit button in the header)"* / *"Write the purpose & goals (Edit button in the header)"*, linking to the project page, where `EditProjectModal` now edits both (`UX-1`). The payoff adds *"The Edit button shows for the project owner, admins and document control — anyone else, ask the owner."* The header button is labelled **Edit** and renders only for `canManage` (owner, or `Admin` / `DocCtrl` via `hasAnyRole`, `page.tsx:69,135,333-338`). The first wording, "Edit project, in the header", named neither the real label nor who can see it. Both items are also left out when the database has not been migrated for those fields, or the `projects` read failed (see `PERF-3`), so the coach never sends anyone to an editor whose fields cannot be read. SPI is no longer hard-coded null: `lib/projectSnapshot.ts` computes it from `computeScheduleMetrics` (`MON-6`), so the `schedule` payoff's "(SPI)" and `computeProjectHealth`'s SPI branch are reachable in production; the test fixture's `spi: 1.0` now reflects what production produces. Tests: `projectControls.test.ts` "every coach action names a verb that exists and links to a place it can be done" (every href is `/projects/p1` or a real `?tab=`), "no advertised metric is hard-coded null…", and `projectSnapshot.test.ts` "a project whose only milestones are source='p6' has a real count, overdue and SPI". Reproduced: `projectHealth.ts:182-183` / `:208` / `:214` and `projectSnapshot.ts:120` at `8276cad` as quoted in the finding.

**Done-when.**
- Every coach item names an action that exists and links to a place it can be done — ✓. The `sow` / `purpose` items name the **Edit** button and say who has it. For a member without manage rights the action they can take is to ask the owner, and the item says so.
- No advertised metric is hard-coded null — ✓ (`spi` computed; null only while nothing is due yet, which the coach does not advertise as a value).

**Scope / residual.** The SPI glossary entry on the Costs tab (`CostsTab.tsx`, P3's file) was not touched; SPI is now a real metric so the entry is no longer for a metric that never exists. The `sow` link lands on the project page header rather than opening the modal directly — `page.tsx` (J8's) has no `?edit=` affordance. `buildCoachItems` takes no `canManage` flag, because `page.tsx` renders `<ProjectCoach>` without one. The wording is therefore true for every viewer rather than tailored to each. If J8 passes `canManage` later, a member-specific "ask the owner to …" title is a small change.

---

## UX-7 · The two most common successful outcomes are rendered as red errors

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / trust
- **Locations:**
  - `components/projects/QualityTab.tsx:314` — *"Applied 12; left 3 alone because a human already decided them."*
  - `components/projects/QualityTab.tsx:328` — *"Evidence sweep: nothing new to prove or demand…"*
  - `components/projects/QualityTab.tsx:81-86` — the rose-bordered `AlertTriangle` banner both land in
  - `components/projects/IntakePanel.tsx:292` — the inverse: one neutral grey banner carrying both success and failure
- **Re-verified:** hardening pass — **SURVIVES**. `setErr("Applied N; left M alone…")` (`QualityTab.tsx:314`) and `setErr("Evidence sweep: nothing new to prove or demand…")` (`:328`) — the two most common successful outcomes routed into the error channel.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: neither component has a tone prop, so QualityTab has only an error channel and IntakePanel only a neutral one — a failed intake action is visually indistinguishable from a successful one.

**Mechanism.** `QualityTab` has only an error tone, so successes are announced
in red. `IntakePanel` has only a neutral tone, so failures — "Couldn't revoke:
…", every throw from approve and reject — are announced as status notes.

**Failure scenario.** An impatient user reads red and stops trusting the
feature. On the Intake panel, a failed approval looks like it worked.

**Remediation.** Give both banners a `tone` prop (`info` / `success` / `error`)
and set it at each call site. This is a small, mechanical change with high
return.

**Done when.**
- A successful sweep renders in a non-error tone.
- A failed intake action renders in an error tone.

**Partial (2026-09-29, projects Round G — QualityTab half).** `components/projects/QualityTab.tsx` has a `Notice` with a tone (`error` / `success` / `info`): the sweep's "nothing new to prove or demand" is `info`, a sweep that proved / demanded / withdrew items is `success` with the tallies, "Applied N; left M alone…" is `success`, refusals are `error` (`role="alert"`). The single `setErr` channel is gone; each section and each checklist card carries its own notice.

**Done-when.**
- ✓ A successful sweep renders in a non-error tone.
- ✗ A failed intake action renders in an error tone — `components/projects/IntakePanel.tsx` :292 is P1 / DC P4's file, not edited here; this record stays OPEN for that limb.

**Scope / residual.** The IntakePanel limb.

---

## UX-8 · Errors render at the top of the page while the action that raised them is far below

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `components/projects/CostsTab.tsx:119-124` — the single banner, at the top
  - Raised from: `QuotesPanel.tsx:70, 86, 169, 223`, `ChangeOrdersPanel.tsx:49, 61, 76`
  - `components/projects/QualityTab.tsx:81-86` vs `:331, :339` — same shape
  - `components/projects/QualityTab.tsx:383-386` + `lib/checklists.ts:218-223` — "Mark complete" always enabled, refusal lands off-screen
- **Re-verified:** hardening pass — **SURVIVES**. The error state renders at the top of the page while the controls that raise it sit far below in the tab content, so on a long project page the feedback is off-screen.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on every cited line. I looked specifically for a mitigation and found none: grep for `scrollIntoView`, `toast`, or focus management across CostsTab.tsx, QualityTab.tsx and components/projects/cost/*.tsx returns zero hits, so nothing brings the banner into view. The only correction is a path detail — the Approve button lives in components/projects/cost/ChangeOrdersPanel.tsx, not CostsTab.tsx itself (the report's own Locations block already says this).

**Mechanism.** Between the banner and the change-orders panel sit the stat
strip, the burn bar, the S-curve, the forecast, the crew curve and the whole
quotes panel.

**Failure scenario.** The user clicks Approve and nothing appears to happen.
Same for "Mark complete" on a checklist: the button is always enabled and
styled as the primary green action, and the refusal — "N items are not satisfied
yet…" — lands hundreds of pixels above where the user is looking.

**Remediation.** Render the error inline, beside the control that raised it.
Where a shared banner must be kept, scroll it into view and move focus to it.
Separately, disable "Mark complete" when the checklist is not satisfiable and
explain why on the button.

**Done when.**
- An error from a control below the fold is visible without scrolling.
- "Mark complete" is disabled with a visible reason when it would be refused.

**Partial (2026-09-29, projects Round G — the `CostsTab.tsx:119-124` limb only; the ID closes in P2/J2).** Joint J3 MONEY-LEDGER. `components/projects/CostsTab.tsx`: the banner carries `ref` / `tabIndex={-1}` / `role="alert"`, and a `useEffect` on `err` scrolls it into view (`scrollIntoView({ block: "nearest", behavior: "smooth" })`) and moves focus to it — so an error raised by Approve / Reverse / Award / Void far below the fold is seen and announced. The quotes and change-order panels keep raising through the same `setErr`, which is also how `decideChangeOrder`'s partial-outcome warning (`COST-11`) and `awardQuote`'s rival warning reach the user.

**Done-when.**
1. ✓ for the Costs tab — an error from a control below the fold is brought into view (and focused).
2. ✗ NOT DONE HERE — "Mark complete" disabled-with-reason is `QualityTab.tsx` / `lib/checklists.ts`, J2's.

**Scope / residual.** OPEN for J2's QualityTab half. Inline placement beside each control is the fuller fix the P7 component-wide package can take; the shared banner is now at least reachable.

**Partial (2026-09-29, projects Round G — QualityTab half).** In `components/projects/QualityTab.tsx` every notice renders inside the section or card whose control raised it (the checklist card's notice sits directly under its buttons; the turnover and punch sections have their own), and the page-level banner is reserved for a failed load with a Retry. "Mark complete" is disabled — with `aria-disabled` and a title — while the gate would refuse (no items, or N unsatisfied), and the reason is printed beside the button; the server-side refusal (`lib/checklists.ts` :218-223 gate, unchanged) is still the authority.

**Done-when.**
- ✓ An error from a quality control below the fold is visible without scrolling (rendered beside the control).
- ✓ "Mark complete" is disabled with a visible reason when it would be refused.
- ✗ `components/projects/CostsTab.tsx` :119-124 (and the cost panels raising into it) — P3 / J3's limb, not edited here; this record stays OPEN for that half.

**Scope / residual.** The costs half (J3).


**Integration (2026-09-30, projects Round G — J2 merged onto J3).** Both halves hold on the merged tree. An error raised on the Costs tab, including from the cost panels that report into its banner, is scrolled into view and focused (J3). A quality control's error renders beside the control that raised it (J2). "Mark complete" is disabled with a visible reason when it would be refused (J2). Both Done-when items are met.

---

## UX-9 · An action error destroys the entire company page

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux / data-loss
- **Locations:**
  - `app/(protected)/companies/[id]/page.tsx:75-82` — the guard
  - `app/(protected)/companies/[id]/page.tsx:153, 157` — panels receive the page's `setError` as `setErr`
  - `app/(protected)/projects/[id]/page.tsx:82-85` — the same bug, already fixed and documented there
- **Re-verified:** hardening pass — **SURVIVES**. `if (error || !company) return (…)` (`companies/[id]/page.tsx:75-80`) replaces the entire page, so a transient action error discards the loaded company view.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Right, and the sibling page's comment is the settling proof that this is a known bug pattern already fixed in projects/[id] and left standing in companies/[id]. A transient action failure (e.g. a failed event save at line 344) unmounts the header, scorecard, profile and both panels — discarding whatever the user had typed into the EventsPanel form. HIGH with a data-loss facet is fair.

**Mechanism.** `if (error || !company) return <red box + "Back to companies">`.
So a failed quality-manual evaluation — including the entirely ordinary "add
your AI key first" — replaces the whole company record, discarding the proposal
in flight and the form contents. There is no dismiss.

**Remediation.** Separate load errors from action errors, exactly as the project
detail page does. Its comment records why: *"Sharing one state used to let a
failed COMMENT blank the entire project view."*

**Done when.**
- An action error renders as a dismissible banner and leaves the page intact.
- Form contents survive a failed action.

**Resolution (2026-09-29, projects Round G).** `app/(protected)/companies/[id]/page.tsx` separates load errors from action errors exactly as the project page does: `error` (load) still replaces the record; a new `actionError` renders as a dismissible `role="alert"` banner above the header, and both `QualityManualPanel` and `EventsPanel` receive `setErr={setActionError}`. A failed evaluation ("add your AI key first") or event save now leaves the header, scorecard, proposal and form contents mounted. Pinned in `companiesRegistry.test.ts` ("a failed action renders as a dismissible banner and leaves the company page mounted") and, fix pass, on the RENDERED page (`companiesPagesRender.test.ts`, jsdom): a failed event save leaves the header mounted, shows the dismissible banner with the failure, and keeps the typed description in its input.

**Done-when.**
- An action error renders as a dismissible banner and leaves the page intact — ✓.
- Form contents survive a failed action — ✓ (the panels are never unmounted by an action error; their `useState` survives).

**Scope / residual.** None.

---

## UX-10 · A missing migration or a denied policy reads as a friendly empty state

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / diagnosability
- **Locations:**
  - `lib/costs.ts:157, 221, 120` — `listAccounts`, `listEntries`, `listParties`
  - `lib/checklists.ts:96, 102` — `listChecklists`, `listChecklistItems`
  - `lib/turnover.ts:132, 239` — `listTurnoverItems`, `listPunchItems`
  - `lib/costs.ts:189` — where the raw Postgres string then surfaces
  - `components/projects/cost/QuotesPanel.tsx:545` — the one call site that does it right
- **Related:** `REL-2`, `REL-3`
- **Re-verified:** hardening pass — **SURVIVES**. The list functions discard their error and return `[]` (`costs.ts`), so a missing migration and a denied policy both render as the friendly empty state. Same root as `REL-2`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Claim of absence checked repo-wide: the only schema-gap detector, lib/schemaExpectations.ts, is consumed solely by app/api/admin/schema-health/route.ts and the intelligence page — nothing in the Projects surface distinguishes empty from missing-table from RLS-denied. Only the cited line numbers drift slightly.

**Mechanism.** Every list function destructures `{ data }` and discards the
error. A missing table or a policy denial returns null data, so the interface
confidently renders "No cost accounts yet", "No checklists yet", "Nothing
required yet."

**Failure scenario.** The user cannot distinguish empty from broken from
not-allowed. Then the first write surfaces the raw string:
`relation "public.cost_accounts" does not exist`, or
`new row violates row-level security policy for table "cost_entries"`.

**Remediation.** Return `{ rows, error }` from the list functions (or throw) and
have the UI render three distinct states: empty, failed-to-load with a retry,
and not-permitted. Map the two common Postgres codes to plain language — the
quote-link creator already shows the pattern: *"Quote links need the latest
database migration (20261013) applied."*

**Done when.**
- Empty, broken and forbidden render differently.
- No raw Postgres string reaches a user in the Projects area (see `REL-3`).

*Landed 2026-09-29 (projects Round G, J4 limb): `QuotesPanel.tsx:545`'s migration-aware message is kept as the model; the two new writes in the panel (`cost_documents.company_id`, quote-link `expires_at`) surface a named-migration message on `42703` / `PGRST204` instead of a silent success. The list-function conversion closes in P2.*

**Partial (2026-09-29, projects Round G — the load-bearing safety read; PC QUAL-8).** `listChecklists`, `listChecklistItems`, `listTurnoverItems` and `listPunchItems` throw a translated error on a read failure instead of returning `[]` (`describeWriteError` in `lib/checkedWrite.ts`: a missing table or column — raw `42P01` / `42703` or PostgREST's schema-cache `PGRST205` / `PGRST204`, the shapes a pending migration actually produces through the client — → "This needs the latest database migration applied", 42501 / RLS → "You don't have permission…", else the message; *review fix (projects Round G):* the schema-cache codes were missing at first, so the pre-migration writes surfaced PostgREST's raw "Could not find the … column … in the schema cache"); `readChecklistItems` returns `{ rows, error }` for the completion gate, which now refuses on a read error (QUAL-8). `QualityTab` renders a failed load as "The quality program couldn't be loaded — <reason> · Retry" and a failed item load inside the card with Retry — never "No checklists yet". `listTurnoverReviewEvents` was the one deliberate exception (an empty history before the migration, since the items still render) — narrowed to the missing-table shapes by the second review fix below. Tests: `lib/__tests__/checklists.test.ts` `"listChecklists / listChecklistItems throw on a read error instead of returning []"`, `"before 20261091 'Mark complete' names no new column, so it lands…"` (second review fix: the completion no longer writes `completed_basis`); `lib/__tests__/turnover.test.ts` `"listTurnoverItems / listPunchItems throw on a read error"`, `"before 20261091 a close meets PostgREST's unknown-column error (PGRST204)…"` (the PGRST205 history-insert case went with the client insert — second review fix); `lib/__tests__/checkedWrite.test.ts` `"a pending migration in PostgREST's schema-cache shapes (PGRST204 / PGRST205) and raw 42703 reads as the migration message, never raw text"`.

*Second review fix (projects Round G).* The first build's "never 'No checklists yet'" did not hold: `refresh()` read all four lists with `Promise.all`, so one failed read left every list at `[]` and the page showed the error banner AND, directly below it, "No checklists yet", "Nothing required yet…" and "Nothing on the punch list." with their Seed / Add controls — and one failing read hid the three that answered. `QualityTab` now reads with `Promise.allSettled`; each section renders its own data or its own "… couldn't be loaded — <reason> · Retry" (`LoadFailed`) in place of its empty state, and hides its add / seed / new controls while its list is unknown. The review history is its own read: `listTurnoverReviewEvents` (`lib/turnover.ts`) returns `[]` only for the missing-table shapes (`isMissingSchemaError`, new in `lib/checkedWrite.ts`) and throws otherwise, and the turnover section shows "Review history unavailable — <reason> · Retry" rather than a history with its nonconformance lines silently missing. Tests: `lib/__tests__/turnover.test.ts` `"the review history is empty (not an error) before the migration — in every missing-table shape"`, `"any OTHER history read failure throws…"`; `lib/__tests__/checkedWrite.test.ts` `"isMissingSchemaError is true for the pending-migration shapes only…"`.

**Done-when.**
- ✓ Empty, broken and forbidden render differently on the quality tab (empty state / "couldn't be loaded — needs the latest migration" / "you don't have permission") — per section, with no empty state under a failed read (second review fix: the first build rendered both).
- ✗ No raw Postgres string reaches a user in the Projects area — the quality lib maps the two common codes and the rest carry the message; the costs half is REL-2 / REL-3 in P3 (J3) and the `QuotesPanel.tsx` :545 limb is P4's. This record stays OPEN for those halves.

**Scope / residual.** `lib/projectReport.ts` (PC-9's) wraps these readers in its own `safe()` and is unaffected by the throw.


**Integration (2026-09-30, projects Round G — J2 merged onto J3 and J4).** With all three merged, "empty, broken and forbidden render differently" holds on the Quality tab (J2), on the Costs tab (J3: the list functions throw, and the tab shows its failure banner), and in the bid table's new writes (J4). Still OPEN for Done-when 2: no raw Postgres string may reach a user anywhere in the Projects area. That is `REL-3`'s sweep, and not every surface has been converted.

---

## UX-11 · The Documents tab shows two divergent lists and badges the wrong one

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux / correctness
- **Locations:**
  - `app/(protected)/projects/[id]/page.tsx:420` — the badge, `checkouts.length` (session count)
  - `app/(protected)/projects/[id]/page.tsx:442` — the help text, describing only the lower list
  - `app/(protected)/projects/[id]/page.tsx:461-483, 722-751` — the checkout list
  - `components/projects/ProjectDocumentsCard.tsx:48-84` — the register card
  - `lib/projects.ts:322-330` — `listProjectCheckouts`, one row per session
  - `app/(protected)/projects/[id]/page.tsx:3-6` — the header comment still describing a three-tab page that now has seven
- **Re-verified:** hardening pass — **SURVIVES**. The Documents tab badge counts one collection while the panel below renders another (`projects/[id]/page.tsx:420`), so the number and the list disagree.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Every sub-claim in the report's table verified, including that adoption is manual (lib/transitionIn.ts:221 is the sole writer of project_documents from intake) and that the Intake tab hosting TransitionInPanel is gated at page.tsx:508 `{tab === "intake" && !canManage && ...}`. The batch summary overstates one case: an ADOPTED intake sheet does appear, in the register card above; only approved-but-unadopted sheets are invisible outside Intake.

**Mechanism.** Two independent sources render stacked, and the badge counts
sessions rather than documents.

| Situation | Card | Checkout list | Tab badge |
|---|---|---|---|
| One drawing checked out 10 times | 1 row | 10 rows | **10** |
| Intake sheet adopted via transition-in | shown | absent | not counted |
| Intake sheet approved but not adopted | absent | absent | not counted |
| Manager clicks ✕ on a checkout-sourced row | removed | **still listed** | still counted |
| Document the viewer can't read under ACL | silently dropped | still listed | still counted |

**Failure scenario.** A contractor submits 40 sheets and all 40 are approved.
The project manager opens Documents and reads *"No documents checked out yet.
Open a doc in a library and check it out to this project."* The sheets exist,
are versioned and are audited — and are visible only inside the Transition-in
panel nested in the Intake tab, which is itself hidden from anyone who is not
the owner or a controller.

**Remediation.** Make the card the primary list — it is the project's document
register — and present checkouts as a secondary "currently out" section. Badge
distinct documents, not sessions. Show "n hidden by permissions" rather than
silently dropping ACL-filtered rows. Rewrite the help text to describe both, and
update the stale header comment.

**Done when.**
- The badge counts what the tab shows.
- Approved intake documents are visible in the Documents tab.
- ACL-hidden rows are disclosed as a count.

**Resolution (2026-09-30, projects Round G).** Reproduced at `2a2ae73`: the badge was `checkouts.length` (sessions), the card silently dropped ACL-hidden rows, and an approved-but-unadopted intake sheet appeared nowhere outside the Intake tab. Now the register card is the Documents tab's PRIMARY list, fed by `lib/projects.ts` `listProjectDocuments`: the `project_documents` rows plus the contractor intake documents that were APPROVED (they carry a `current_version_id`; a pending submission is not listed) in the project's intake folder but not adopted (`approved intake` badge); each row is a live reference with a DEC-40 "Not current" marker for a superseded / void / archived document; linked documents the viewer's permissions hide are disclosed ("N linked documents are hidden by your permissions"). The checkout list below is the secondary "checkouts under this project" section. The tab badge is `documentsTabCount` — DISTINCT documents across the register, approved intake, checkouts AND the disclosed hidden ones, counted in one set (`listProjectDocuments` returns `hiddenDocIds` beside the count), so a restricted document that is also checked out under the project counts once — never a session count. Help text and the page's header comment (seven tabs) rewritten.
- Commits: `7ca202f`, `9363ebb`
- Tests: `projects.test.ts` "UX-11 — the register the Documents tab shows, and its badge" (hidden count, approved-intake read filtered on `current_version_id`, the not-current marker, ten sessions of one drawing badge as one); `projectPageRoundG.test.ts` "renders approved intake rows, marks the not-current one, and discloses what permissions hide", "the tab badge counts distinct documents"; `projects.test.ts` "a restricted document that is ALSO checked out under the project counts once — the badge matches the tab".

**Done-when.**
- The badge counts what the tab shows — ✓.
- Approved intake documents are visible in the Documents tab — ✓.
- ACL-hidden rows are disclosed as a count — ✓.

**Scope / residual.** When projects-and-cost PC-1 / J1 (drafting `PROJ-5`) writes a `project_documents` row on intake approval, those documents simply move from the intake section into the register; the listing de-duplicates. *Fix pass (2026-09-30):* the first cut added the hidden COUNT to the size of the distinct-id set, so a checked-out document the viewer's ACL hides (auto-linked by the checkout trigger, and its id still supplied by the org-readable session) was counted twice — one hidden notice and one checkout row badged as 2. The hidden ids now join the same set. *Second fix pass (2026-09-30):* two paths still dropped approved intake silently. (1) `listProjectDocuments` read a failed `projects` read (a timeout, an RLS error) as "no intake collection", so the approved contractor sheets vanished from the tab and the badge with no message. A failed read now throws ("The project could not be read, so its approved intake documents cannot be listed: …"), which the card shows. Only the pre-20260902 missing `intake_collection_id` column still means "no intake". (2) The intake read was capped at 200 rows (and the register read at PostgREST's 1,000), with nothing disclosed. Both now page to exhaustion in 1,000-row windows with a stable order (`readAllPages`, the sweep's pager, renamed). The linked documents are read 100 ids per request, and a failed page or chunk throws, never a short register. Tests: `projects.test.ts` "a failed project read throws…", "approved intake past 200 — and past PostgREST's 1,000-row cap — is listed in full, and the badge counts every sheet", "a register of 1,200 links is read in full (paged) and its documents 100 ids per request…". All three fail against the previous `lib/projects.ts`.


**Residual (2026-09-30, projects Round G — final review, not fixed).** The Documents tab's badge matches the tab only after the Documents card has mounted: `register` is set by `ProjectDocumentsCard`'s `onLoaded`, and the card renders only on that tab (`app/(protected)/projects/[id]/page.tsx` ~:536). Until the tab is first opened, the badge shows the pre-register count.

---

## UX-12 · Creating a project costs eight clicks, five of which are pure tax

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `components/projects/ProjectWizard.tsx:440-444` — the primary button, "Next" on steps 0-4
  - `components/projects/ProjectWizard.tsx:120` — `finish()` reachable only from `next()`
  - `components/projects/ProjectWizard.tsx:222` — the "everything after Basics is optional" message, in 11px grey
  - `components/projects/ProjectWizard.tsx:434-444` — "Skip for now", which only appears once a step is empty
- **Re-verified:** hardening pass — **SURVIVES**. Only step 0 has required fields (`ProjectWizard.tsx:440`); every later step is advanced by the same Next button and can be skipped (`:120`), so the clicks are ceremony rather than input.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real — no early exit from the six-step flow — but the headline count is wrong: projects/page.tsx:116 "New Project" (1) + five Next clicks (2-6) + "Create project" (7) is seven, not eight, and the first Next commits the required fields, so four rather than five are ceremony. Pure friction with no data-loss or correctness consequence (the surrounding HIGHs in this report carry data-loss or false-statement impact), so MEDIUM.

**Mechanism.** There is no escape from step 0. A user who has typed a name and a
description — everything actually required — must click through five screens
they have already decided to skip.

**Remediation.** Add a persistent **"Create project"** button beside "Next" from
step 0 onward. This is the single most fixable friction point in the area.

**Done when.**
- A project can be created in two clicks from the wizard's first step.
- The optionality of later steps is visible without reading small grey text.

**Resolution (2026-09-29, projects Round G).** Package default taken: Basics alone creates the project. `components/projects/ProjectWizard.tsx` shows a **Create project** button on every step from step 0 (primary on the first and last steps, secondary in between; enabled once name + description are typed) beside **Next**; `createNow()` records the current step as done-or-skipped and every unreached step as skipped, so the coach still resurfaces them. Optionality is visible: an **Optional** badge next to the step title from step 1 on, and the subtitle says *"Only this step is required — create the project now, or keep going."* on step 0 and *"Skip or fill in — everything here can also be added from the project page later."* after. The count: **New Project** → **Create project** = two clicks. Verified by reading (component; the vitest include is `lib/__tests__` only) — the create path is the same `finish()` the wizard tests cover via `runWizardFollowUpWrites`. Reproduced: `ProjectWizard.tsx:440-444` at `8276cad` — the only primary button was "Next" until step 5.

**Done-when.**
- A project can be created in two clicks from the wizard's first step — ✓.
- The optionality of later steps is visible without reading small grey text — ✓ (badge + button, not only the 11px subtitle).

**Scope / residual.** None.

---

## UX-13 · Preconditions are announced after the effort, not before it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `lib/ai/governedCall.ts:41-47` — 412, no key; `:52-59` — 428, unsigned agreement; `:66-70` — 402, over cap
  - AI entry points, all rendered enabled: `QualityTab.tsx:230, 373`, `QuotesPanel.tsx:394`, `companies/[id]/page.tsx:279`
  - `components/projects/cost/QuotesPanel.tsx:409-411` — "needs a budget line", with the fix in a `title`
  - `components/projects/QualityTab.tsx:129-131` — the checklist empty state, which points at Document Control with no upload affordance here
- **Re-verified:** hardening pass — **SURVIVES**. `governedCall` throws its 412 — *"Add your Claude or OpenAI key in AI settings first"* — only once invoked (`governedCall.ts:41-47`), while the button that invokes it is `disabled={!doc || evaluating}` (`companies/[id]/page.tsx:279`), never disabled on the missing precondition.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Checked for a guard the finding might have missed: `ai_connections` is queried from exactly one client file repo-wide (app/(protected)/setup/page.tsx:89), so no Projects-area surface knows whether a key exists before the click.

**Mechanism.** Nothing signals the three AI gates until after the click. The
user searches for a document, selects it, picks a kind, clicks, watches a
spinner — then is told to configure something on a different page, losing all
context and the flow's state.

The same shape governs awarding: to satisfy "needs a budget line" you scroll
past the change-orders panel, create an account through six inputs, and scroll
back — and **the dependency is discovered only after uploading the PDF, typing
the vendor, and spending an AI call on the read**.

**Remediation.**
- Where no AI key is configured, render the AI buttons with an inline
  *"Needs your AI key — set it up (1 min)"* link instead of letting the user
  spend effort to learn it. Same for the unsigned agreement and the cap.
- Replace the inert "needs a budget line" text with a **Create budget line**
  action right there.
- Give the Quality tab an upload affordance, or link directly to the right
  Document Control destination.

**Done when.**
- Every AI entry point states its precondition before the click.
- "Needs a budget line" offers the fix in place.

---

## UX-14 · The observer role is a label with no behaviour

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (exhaustive grep — two non-marketing occurrences)
- **Blast radius:** governance
- **Locations:**
  - `types/schema.ts:944` — the type union
  - `app/(protected)/projects/[id]/page.tsx:926` — the `<option>`
  - `app/(protected)/projects/[id]/page.tsx:133` — `canComment = isOwner || isMember || isAdmin`
  - `lib/projects.ts:686-707` — notifications fan out to all members
  - `supabase/migrations/20260913_projects_rls_recursion_fix.sql:40-54` — `project_visible_to_me` checks membership, not role
- **Re-verified:** hardening pass — **SURVIVES**. `ProjectMemberRole = "owner" | "collaborator" | "observer"` (`types/schema.ts:944`) is declared and never read for authority — cross-area duplicate of `roles-and-permissions/SURF-11`, which shows the policies resolve from `org_members` instead.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The absence claim is confirmed by exhaustive search, not inference — the role is declared, offered in the picker, and never consulted by any read, write, notification, or policy path.

**Mechanism.** No read path, write path, notification path or guard checks it.

**Failure scenario.** An observer can post comments, receives every project
notification, and on a **private** project has read access identical to a
collaborator. Adding someone as an observer to keep them at arm's length does
nothing of the sort.

**Remediation.** Either implement it — read-only, no comments, opt-in
notifications — or remove the option so the interface stops implying a
distinction it does not make.

**Done when.**
- The role has enforced behaviour, or it no longer appears in the picker.

**Resolution (2026-09-30, projects Round G).** Record-only for the database half, per the plan: roles-and-permissions `SURF-11` / 20261047 re-created `can_manage_project` so an `observer` is on the roster to SEE, never to manage (verified in the file: `COALESCE(pm.role, 'collaborator') IN ('owner', 'collaborator')`). This package added the behaviour the role still lacked (projects-and-cost `PM-11`, default taken — keep the option, enforce it): `supabase/migrations/20261102_prj_roundG_project_rails.sql`'s `project_activity_insert` refuses a `comment` unless the author is a controller or `can_manage_project` (so an observer cannot post); the page's `canComment` excludes observers (`isMember && myRosterRole !== "observer"`), and the picker says what each role means ("Observer — can see, cannot manage or comment"). Authority never comes from a roster row's role (`isOwner` reads `owner_user_id`).
- Commits: `e0c1aa2`, `9363ebb`
- Tests: `projectPageRoundG.test.ts` "authority is projects.owner_user_id; an observer gets no comment box; the observer option says what it means"; `projects.test.ts` "an observer's refused comment is 'not posted'"; `projectsRls.test.ts` "the insert binds the author…" (the comment branch).
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` (the database half of the comment refusal).

**Done-when.**
- The role has enforced behaviour, or it no longer appears in the picker — ✓ enforced (cannot manage — 20261047; cannot comment — UI now, database after `supabase/migrations/20261102_prj_roundG_project_rails.sql`).

**Scope / residual.** Observers still receive project notifications (members ∪ watchers fan-out) — notifications area `PROD-4` owns the audiences; not changed here.

---

## UX-15 · Seven words for "this no longer counts", five for the company, six for the schedule row

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / rookie-readability
- **Locations:** across the Projects surface; representative sites below
- **Re-verified:** hardening pass — **SURVIVES**. Three different phrasings for the same concept across three surfaces, with no shared vocabulary constant.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Spot-checked five of the report's representative sites and all five hold (one line number off by four). MEDIUM is right for an aggregate vocabulary finding.

**Mechanism — dismissal (7 words).** `na` / "Not applicable" (checklist),
`waived` (turnover), `void` (punch), `void` (cost entry), `void` (cost
document), `declined` / "Not selected" (quote), `rejected` (turnover and
intake). Each has different reason requirements and different audit behaviour
(see `SAF-4`), and nothing on screen explains which is which.

**Mechanism — the company (5 words + a schema leak).** "Team & contractors"
(`ProjectWizard.tsx:30, 393, 413`), "Contractors & vendors"
(`CostsTab.tsx:268`), **"Party…"** as a dropdown placeholder
(`CostsTab.tsx:452, 507`) with **"Party name is required."** surfaced to the
user (`lib/costs.ts:151`), "Bidder"/"vendor"/"known" (`QuotesPanel.tsx:260, 280,
286`), "Known Companies" (`companies/page.tsx:85`). *Party* is a schema word,
not a plant word. The kind lists disagree too: the wizard offers
`contractor | vendor | rental | internal`, the Costs panel offers
`contractor | vendor | internal` — so a rental company edited in Costs has a
value that is not in the list.

**Mechanism — the schedule row (6 words).** "Milestones"
(`ScheduleTab.tsx:393`), "Add milestone" (`:298`), **"No tasks match"**
(`:420`), "sub-tasks" (`:547, 591`), "phase" (`ExecutionView.tsx:1119`), "step"
(`TaskDetailPanel.tsx:347`), and `projectHealth.ts:97` calls them "tasks
overdue". Sharpest collision: `ExecutionView.tsx:1500` has a legend entry *"A
milestone — a zero-duration marker"* **inside a view where every row is called a
milestone** — actively misleading to anyone who knows P6.

**Mechanism — money (5 words).** "entries", "actual", "invoice",
"spend"/"Spent"/"burned", and "post as actual" vs "post as spend" vs "Post".

**Mechanism — four export buttons in one row** (`projects/[id]/page.tsx:323-373`)
— Export CSV / Evidence pack / Report / Lessons learned — with no explanation of
the difference between any of them.

**Remediation.** Write a short vocabulary list, pick one word per concept, and
sweep. Priorities: kill "party" from all user-facing strings; settle on one word
for the schedule row and fix the contradictory legend; reconcile the two kind
lists; explain the four export buttons. Add the missing glossary entries listed
below — the glossary at `CostCharts.tsx:158-196` promises "every term on this
page" and is missing: **Value score / best value**, **Silent gap**,
**Remaining**, **Burn / % burned**, **Peak crew**, **Party**, **Void**, **RFQ**
(expansion), **Reason code**, **Pinned**. It meanwhile defines **SPI** (never
shown on that tab), **EAC** (never rendered — the forecast is a sentence),
**S-curve** (labelled "Spend curve" on screen) and **$/labor-hour** (labelled
"$ / hr").

**Done when.**
- One word per concept in user-facing strings.
- The execution legend does not contradict the row label.
- The glossary covers the terms actually on screen, and drops the ones that are not.

---

## UX-16 · The evidence sweep never runs when evidence actually arrives

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects J11 PROJECTS RESIDUALS — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth / workflow
- **Locations:**
  - `components/projects/QualityTab.tsx:324` — `runAutoEvidence`'s only caller, a button handler
  - `lib/reviewControl.ts` — intake approval (`finalizeReviewedRevision`) — no sweep after a document is issued
  - `lib/turnover.ts` `reviewTurnoverItem` — no sweep after an item is accepted
- **Independently verified:** — (`author`: opened by projects Round G while resolving `UX-3`, per the sequencing note "automated sweeps … recorded as a new finding for P1/P2, per `DEC-31`"; not yet challenged)

**Mechanism.** `UX-3` corrected the coach copy to say the sweep is manual. It
is: nothing calls `runAutoEvidence` on intake approval or on turnover
acceptance — the two moments new evidence actually arrives — so a reviewer who
issues the hydrotest records still sees "N items need evidence" until someone
opens the Quality tab and clicks.

**Failure scenario.** Same as `UX-3`'s: the evidence lands the day before
startup and the checklist stays red.

**Remediation.** Run the sweep (scoped to the project) after an intake approval
finalises a revision on a project document, and after a turnover item is
accepted. **Only after `SAF-1` is closed** — automating a sweep that can green on
an unreviewed draft filename makes that worse. Owned by the intake (P1) and
quality (P2) packages, not the wizard/health package.

**Done when.**
- The sweep runs after intake approval and after turnover acceptance, scoped to the project.
- `SAF-1` is `RESOLVED` first.
- The `UX-3` coach copy is updated to describe the automated moments.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| UX-1 | CRITICAL | RESOLVED |
| UX-2 | HIGH | OPEN |
| UX-3 | HIGH | RESOLVED |
| UX-4 | HIGH | RESOLVED |
| UX-5 | HIGH | RESOLVED |
| UX-6 | HIGH | RESOLVED |
| UX-7 | HIGH | OPEN |
| UX-8 | HIGH | OPEN |
| UX-9 | HIGH | RESOLVED |
| UX-10 | HIGH | OPEN |
| UX-11 | HIGH | RESOLVED |
| UX-12 | HIGH | RESOLVED |
| UX-13 | HIGH | OPEN |
| UX-14 | MEDIUM | RESOLVED |
| UX-15 | MEDIUM | OPEN |
| UX-16 | MEDIUM | OPEN |
