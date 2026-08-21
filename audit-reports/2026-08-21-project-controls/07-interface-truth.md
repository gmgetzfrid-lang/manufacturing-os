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
- **Status:** OPEN
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

---

## UX-2 · Every brand-new project scores zero and is labelled Concern

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / trust
- **Locations:**
  - `lib/projectHealth.ts` — `computeProjectHealth`
  - `lib/companyScore.ts:153-164` — the correct pattern, in the same codebase

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
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth
- **Locations:**
  - `lib/projectHealth.ts:225` — the claim
  - `components/projects/QualityTab.tsx:324` — `runAutoEvidence`'s only caller in the repo
  - `components/projects/QualityTab.tsx:378-382` — the button, explained only by a tooltip

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

---

## UX-4 · "Their documents and quotes land here and process themselves" — a human must click Read

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth
- **Locations:**
  - `lib/projectHealth.ts:243` and `components/projects/cost/QuotesPanel.tsx:599-601` — the claims
  - `app/api/intake/upload/route.ts:88` — inserts with `status: "draft"`
  - `lib/costDocs.ts:93-94` — the comment stating it plainly: *"The AI hasn't read it yet — that's the parse route, and it's a separate, deliberate click."*
  - `app/api/intake/upload/route.ts:107` — the app's own honest wording

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

---

## UX-5 · "Closeout is gated on acceptance; contractors are scored on it" — both halves are false

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth
- **Locations:**
  - `lib/projectHealth.ts:231` — the claim
  - `app/(protected)/projects/[id]/page.tsx:646-649` — "You can complete anyway", the actual behaviour
  - `lib/companies.ts:248` — scoring via `turnover_items.party_id`
  - Repeated at `lib/turnover.ts:8-9`, `lib/turnover.ts:187-188`, `components/projects/QualityTab.tsx:17`
- **Related:** `MON-7`

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

---

## UX-6 · The coach names an action that doesn't exist and advertises a metric that is hard-coded null

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** copy-truth / dead ends
- **Locations:**
  - `lib/projectHealth.ts:182-183` — "Review N read documents waiting for your confirmation" / "Confirmed quotes join the bid comparison"
  - `components/projects/cost/QuotesPanel.tsx:195-204` — a parsed quote joins the bid table immediately
  - `lib/projectHealth.ts:177` — "Unlocks … schedule health (SPI)"
  - `lib/projectSnapshot.ts:120` — `spi: null, // needs the schedule tab's EV math + history; null stays honest`
  - `lib/projectHealth.ts:208, 214` — the sow/purpose items, unactionable
  - `app/(protected)/projects/[id]/page.tsx:105-110` — one of them does not even change tabs

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

---

## UX-8 · Errors render at the top of the page while the action that raised them is far below

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `components/projects/CostsTab.tsx:119-124` — the single banner, at the top
  - Raised from: `QuotesPanel.tsx:70, 86, 169, 223`, `ChangeOrdersPanel.tsx:49, 61, 76`
  - `components/projects/QualityTab.tsx:81-86` vs `:331, :339` — same shape
  - `components/projects/QualityTab.tsx:383-386` + `lib/checklists.ts:218-223` — "Mark complete" always enabled, refusal lands off-screen

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

---

## UX-9 · An action error destroys the entire company page

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / data-loss
- **Locations:**
  - `app/(protected)/companies/[id]/page.tsx:75-82` — the guard
  - `app/(protected)/companies/[id]/page.tsx:153, 157` — panels receive the page's `setError` as `setErr`
  - `app/(protected)/projects/[id]/page.tsx:82-85` — the same bug, already fixed and documented there

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

---

## UX-11 · The Documents tab shows two divergent lists and badges the wrong one

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / correctness
- **Locations:**
  - `app/(protected)/projects/[id]/page.tsx:420` — the badge, `checkouts.length` (session count)
  - `app/(protected)/projects/[id]/page.tsx:442` — the help text, describing only the lower list
  - `app/(protected)/projects/[id]/page.tsx:461-483, 722-751` — the checkout list
  - `components/projects/ProjectDocumentsCard.tsx:48-84` — the register card
  - `lib/projects.ts:322-330` — `listProjectCheckouts`, one row per session
  - `app/(protected)/projects/[id]/page.tsx:3-6` — the header comment still describing a three-tab page that now has seven

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

---

## UX-12 · Creating a project costs eight clicks, five of which are pure tax

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `components/projects/ProjectWizard.tsx:440-444` — the primary button, "Next" on steps 0-4
  - `components/projects/ProjectWizard.tsx:120` — `finish()` reachable only from `next()`
  - `components/projects/ProjectWizard.tsx:222` — the "everything after Basics is optional" message, in 11px grey
  - `components/projects/ProjectWizard.tsx:434-444` — "Skip for now", which only appears once a step is empty

**Mechanism.** There is no escape from step 0. A user who has typed a name and a
description — everything actually required — must click through five screens
they have already decided to skip.

**Remediation.** Add a persistent **"Create project"** button beside "Next" from
step 0 onward. This is the single most fixable friction point in the area.

**Done when.**
- A project can be created in two clicks from the wizard's first step.
- The optionality of later steps is visible without reading small grey text.

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
- **Status:** OPEN
- **Verification:** CONFIRMED (exhaustive grep — two non-marketing occurrences)
- **Blast radius:** governance
- **Locations:**
  - `types/schema.ts:944` — the type union
  - `app/(protected)/projects/[id]/page.tsx:926` — the `<option>`
  - `app/(protected)/projects/[id]/page.tsx:133` — `canComment = isOwner || isMember || isAdmin`
  - `lib/projects.ts:686-707` — notifications fan out to all members
  - `supabase/migrations/20260913_projects_rls_recursion_fix.sql:40-54` — `project_visible_to_me` checks membership, not role

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

---

## UX-15 · Seven words for "this no longer counts", five for the company, six for the schedule row

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / rookie-readability
- **Locations:** across the Projects surface; representative sites below

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

## Report progress

| ID | Severity | Status |
|---|---|---|
| UX-1 | CRITICAL | OPEN |
| UX-2 | HIGH | OPEN |
| UX-3 | HIGH | OPEN |
| UX-4 | HIGH | OPEN |
| UX-5 | HIGH | OPEN |
| UX-6 | HIGH | OPEN |
| UX-7 | HIGH | OPEN |
| UX-8 | HIGH | OPEN |
| UX-9 | HIGH | OPEN |
| UX-10 | HIGH | OPEN |
| UX-11 | HIGH | OPEN |
| UX-12 | HIGH | OPEN |
| UX-13 | HIGH | OPEN |
| UX-14 | MEDIUM | OPEN |
| UX-15 | MEDIUM | OPEN |
