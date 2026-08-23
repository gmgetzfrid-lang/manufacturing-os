# 02 · Friction & latency — the hop model

How many people, how many waits, and how many of them are load-bearing.

**9 findings** — 1 CRITICAL, 5 HIGH, 3 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.**

---

## The measurement

Every status in the drafting machine is a **wait state**: the ticket sits until
one specific party opens the app and clicks. There is no auto-advance anywhere,
and — per `LEAK-1` — **no escalation when nobody does.**

Counting hops for the two scenarios that matter most:

### Scenario A — Maintenance planner, like-in-kind gasket replacement

`requiresEngineerApproval("Maintenance")` → **true** (`lib/workflow.ts:37-43`)

| # | Status | Waiting on | Avoidable? |
|---|---|---|---|
| 1 | `PENDING_ASSIGNMENT` | Drafting Supervisor | **No** — this is triage, and triage is wanted |
| 2 | `DRAFTING` | Drafter | No |
| 3 | `PENDING_REVIEW` | **The Maintenance planner** | **Yes** — `FRIC-2` |
| 4 | `PENDING_FINAL_APPROVAL` | An engineer the planner had to pick | **Yes** — `TIER-1`, `FRIC-4` |
| 5 | `PENDING_IFC` | Drafter | Partly — `FRIC-5` |
| 6 | `FINAL_DRAFT` | **The Maintenance planner again** | **Yes** — `FRIC-6` |
| — | `CLOSED` | | |

**6 wait states. 4 distinct people. For a gasket swap.**
Three of the six are avoidable without loosening a single control.

### Scenario B — Manager, brand-new tie-in on a live line

`requiresEngineerApproval("Manager")` → **false**

| # | Status | Waiting on |
|---|---|---|
| 1 | `PENDING_ASSIGNMENT` | Manager can assign — **themselves** |
| 2 | `DRAFTING` | Drafter |
| 3 | `PENDING_REVIEW` | Manager → **"Approve (Issue for Construction)"** |
| 4 | `PENDING_IFC` | Drafter |
| 5 | `FINAL_DRAFT` | Manager acknowledges |

**No engineer. No QA/QC. No code check.** Fewer hops than the gasket.

> **The friction and the safety problem are the same problem.** The system spends
> its ceremony on the people who need it least and skips it for the work that
> needs it most. Fixing `TIER-1` improves *both* at once — this is the rare case
> where the safe change is also the faster one.

---

## FRIC-1 · Nothing auto-advances, and nothing escalates — every hop is a cold human wait

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** friction / adoption
- **Locations:**
  - `lib/workflow.ts:80-342` — no transition fires without an explicit user action
  - `app/api/cron/maintenance/route.ts` — nudges stale **checkouts** (`:348`), review cycles, effective dates and acknowledgments. **No ticket scan of any kind.**
  - `lib/notifications.ts:257-271` — `isPastDue` / `isNearingDue`
  - a repo-wide search shows `target_completion_at` has **no server-side reader**: `lib/search.ts:376` (a type), and test files. Nothing else.
- **Related:** `LEAK-1`, `FRIC-7`, `WF-19` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**, by absence, and checked two ways. `grep -n ticket app/api/cron/maintenance/route.ts` returns **nothing** — the only scheduled job in the product does no ticket work at all — and a repo-wide search for escalation logic finds it only in the document-control modules (`distributionAcks.ts`, `reviewControl.ts`, `reviewCycles.ts`), never for a drafting ticket.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The absence is real and repo-wide-confirmed: no drafting request is ever moved, nagged or escalated by a clock, and the asymmetry with the document-control side makes it an omission rather than a design choice. Lowered from CRITICAL because the hop is not entirely 'cold' — every server-side transition fans out a bell row and a preference-aware email (workflow-action/route.ts:334-390) and lib/ticketAttention.ts flags the state as action-required for the responsible role, so the stall requires the notified party to ignore a live notice. What is missing is the time-based reminder/escalation layer, which is a HIGH-grade product gap, not a correctness failure.

**Mechanism.** The SLA clock is set at creation
(`defaultSlaTargetDate`, 14 days default, 21 for `ASBUILT`) and then **read only
by the browser**, to paint a red "Past Due" chip on a page.

There is no scan. No reminder. No escalation. A ticket that goes past due
produces exactly one thing: a colour, on a screen, that somebody has to already
be looking at.

**Failure scenario.** A request sits at `PENDING_ASSIGNMENT` because the drafting
supervisor is on nights. Day 3, the requester wonders. Day 5, they walk to
drafting and ask. **At that moment the app has lost.** The work now happens
outside it, and the ticket becomes a stale record nobody closes — which makes the
next person trust the queue even less.

**Chain reaction.** This compounds with `WF-19` in the roles-and-permissions
area: nobody is even notified when a ticket *enters* the assignment queue after
an engineering-review round trip, because the recipient set for every action is
hardcoded to `[requesterId, assignedDrafterId]` and `resolveTicketRecipients` —
the module written specifically to answer "who owns this queue state" — is never
imported by the workflow route.

**So a ticket can enter a queue nobody was told about, and sit there past a due
date nobody is watching.** That is the shoulder-tap generator.

**Done when.**
1. A ticket that has been in a wait state past a threshold produces a
   notification to whoever owns that state — not to a watcher list.
2. Past-due tickets escalate to the queue owner and then above them.
3. The escalation is visible in the app, not only in email.

---

## FRIC-2 · `PENDING_REVIEW` waits on the requester — often the person least able to judge the drawing

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** friction / quality
- **Locations:**
  - `lib/workflow.ts:198-256` — the `PENDING_REVIEW` branch; `canActAsRequester` gates the primary path
  - `lib/workflow.ts:74` — `canActAsRequester = isRequesterIdentity || allows('ticket.requester_review')`
  - `lib/roleCapabilities.ts:63-69` — Maintenance / Operations / Safety hold `["create_requests"]` and nothing else
- **Related:** `TIER-1`, `FRIC-4`, `FRIC-6`
- **Re-verified:** hardening pass — **SURVIVES**. `case 'PENDING_REVIEW': if (canActAsRequester)` (`workflow.ts:198-199`) — every advancing action at that state is gated on the requester's identity or an explicit `ticket.requester_review` grant (`:74`).
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The state is nominally requester-owned and the requester is who gets nagged, so the 'rubber-stamp or stall' critique stands as a design observation. But 'waits on the requester' is too strong: a qualified engineer or any management-tier member can co-review and clear it with the same three actions, and the badge already surfaces it to them, so the ticket is not structurally blocked on the least-qualified person. The residual 'no escalation' half is FRIC-1, not an independent defect.

**Mechanism.** After the drafter submits, the ticket waits on the **requester**
to review the draft. For an engineer-requester that is sensible. For a
maintenance planner who asked for a valve tag correction, the app is asking
someone to review a CAD deliverable they filed a plain-language request about.

Their options are: approve it to engineering, approve with a minor correction, or
request a revision. All three require them to have formed a judgement about a
drawing.

**Failure scenario.** The planner does not know what they are looking at, so they
either rubber-stamp it (the review is theatre) or sit on it (the ticket stalls
with no escalation, per `FRIC-1`). Neither outcome is the one the state was
designed for.

**Chain reaction.** Removing the requester review entirely would be wrong — the
requester is the only person who knows whether the *scope* is right, even when
they cannot judge the *drafting*. The distinction the flow is missing is
**"is this what you asked for?" (requester) versus "is this correct?"
(reviewer)** — two different questions currently collapsed into one button.
Splitting them costs no hop if the reviewer roster runs in parallel (`TIER-5`).

**Done when.** The requester is asked a question they can answer, and the
technical review is not blocked on their answering it.

---

## FRIC-3 · The intake form demands a unit before it will accept the request

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** friction / adoption
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:201` — `if (!title || !description || !unit) return;`
  - `app/(protected)/requests/new/page.tsx:469` — the free-text `unit` input, `required`, `placeholder="e.g. 20-CRUDE"`, force-uppercased
  - `app/(protected)/requests/new/page.tsx:272-280` — custom required fields, validated with a blocking `appAlert`
  - `components/documents/CheckInPanel.tsx:236-267` and `lib/transitionIn.ts:304-331` — the two programmatic creators, which **omit `unit` entirely**
- **Related:** `LIFE-9` (roles-and-permissions area), `FRIC-8`
- **Re-verified:** hardening pass — **SURVIVES**. `if (!title || !description || !unit) return;` (`requests/new/page.tsx:201`) with `required` on the input (`:469`).
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The hard gate is real, but the friction only bites orgs with no configured unit list. When `config.units.options.length > 0` the field is a Select (:453-462) AND page.tsx:153 pre-seeds `setUnit(String(cfg.units.options[0].value))`, so unit is never empty and submission never blocks — the contractor picks from labels rather than recalling a code. Note the failure mode then inverts into a quieter one the finding did not name: the first unit in the list is silently pre-selected, so an inattentive requester files against the wrong unit. HIGH overstates a required field with a dropdown; MEDIUM fits.

**Mechanism.** The portal form refuses to submit without a unit. When the org has
not configured a unit list, the field is **free text** — so the requester must
know and correctly type a unit code, uppercase, matching whatever convention the
site uses.

Meanwhile the two in-app creation paths bypass the requirement completely and
create tickets with no unit at all.

**Failure scenario.** A contractor or a new hire opens the request form, does not
know the unit code for the area they are standing in, guesses, and creates a
ticket that the supervisor's unit-filtered queue view will not match — or gives
up and calls someone.

**The silent-failure detail makes it worse:** the guard is a bare `return`. No
message, no field highlight, no scroll-to-error. **Pressing submit with a missing
unit does nothing at all**, with no explanation. A user who has filled in title
and description and does not notice the unit field simply cannot submit and does
not know why.

**Chain reaction.** `unit` is derivable in both programmatic cases — the source
document carries unit/area metadata, and the org **Site Codebook** is already the
fallback vocabulary at `app/(protected)/requests/new/page.tsx:139-150`. If it is
derivable there, it is largely derivable in the portal too, from a chosen source
document.

**Done when.**
1. A failed submit tells the user which field is missing and moves focus to it.
2. Unit is derived from the source document where one is attached.
3. All three creation paths satisfy the same field contract (`LIFE-9`).

---

## FRIC-4 · The requester must personally choose an engineer, by email prefix

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** friction / quality
- **Locations:**
  - `lib/workflow.ts:203-209` — `request_final_engineer_approval` carries `requiresEngineerPick: true`
  - `components/requests/EngineerPickerModal.tsx:74-99` — the list: every active member holding any `Engineer` role
  - `components/requests/EngineerPickerModal.tsx:93` — the display name is `(m.email || "").split("@")[0]`
  - `components/requests/EngineerPickerModal.tsx:100-105` — a best-effort open-ticket count as `workload`
- **Related:** `TIER-1`, `FRIC-2`, `WF-14` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `requiresEngineerPick: true` (`workflow.ts:207`) forces the modal, and the modal labels each option `(m.email || "").split("@")[0] || "Engineer"` (`EngineerPickerModal.tsx:97`) — an email prefix, not a name or a discipline.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on every clause: the requester personally names an engineer, identified by email prefix with no unit coverage, availability or OOO signal, and only an Admin can swap the choice afterwards. The one mitigation the finding half-acknowledges is real but thin — the modal shows an open-ticket workload badge and sorts lightest-first (:106-120) — which is a load hint, not a competence or availability hint.

**Mechanism.** The lowest-authority requester in the flow — the one the
engineering gate just told cannot sign off — is handed a list of every engineer
in the org and asked to pick one. The only decision support is an email prefix, a
role string, and an open-ticket count.

Nothing indicates which engineer covers that unit, that discipline, that system,
or that governing code. **The requester is being asked a routing question that
requires more domain knowledge than the review they were just judged unqualified
to perform.**

**Failure scenario.** The planner picks the engineer whose name they recognise —
who is on vacation, or covers a different unit. The ticket sits at
`PENDING_FINAL_APPROVAL` with no escalation (`FRIC-1`). Reassignment requires
`ticket.reassign_engineer`, which defaults to **Admin only**.

**Chain reaction.** The picker also lists the requester and the assigned drafter
without exclusion — the separation-of-duties hole recorded as `WF-14`. Fixing the
routing (derive the reviewer from the work class and the library, per `TIER-5`)
removes both this friction **and** that hole, because nobody is choosing by hand.

**Done when.**
1. A requester is never required to name a reviewer.
2. Where a person must be chosen, the choice is defaulted from the library's
   review policy and the work class, and the picker shows why.

---

## FRIC-5 · The drafter is interrupted twice for one deliverable

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** friction
- **Locations:**
  - `lib/workflow.ts:166-194` — `DRAFTING` → `submit_draft` → `PENDING_REVIEW`
  - `lib/workflow.ts:301-316` — `PENDING_IFC` → `submit_final` → `FINAL_DRAFT`
  - `lib/ticketTransitions.ts:280-283` — `submit_final` sets `FINAL_DRAFT` and appends the attachment
- **Related:** `FRIC-6`, `WF-6`
- **Re-verified:** hardening pass — **SURVIVES**. `save_progress` is offered at `DRAFTING`/`REVISION_REQ` (`workflow.ts:168-174`) and again at `PENDING_IFC` (`:302-307`), with `submit_final` after it — two separate drafter interruptions for one deliverable.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. No reuse path exists: UploadIFCModal (app/(protected)/requests/[id]/page.tsx:331-372) takes a fresh `File` from an `<input type="file" accept=".pdf">` and its submit button is `disabled={!file}` — there is no 'issue the approved draft as-is' option, so the second interruption is unavoidable even when the bytes are identical. MEDIUM is the right level.

**Mechanism.** After approval the ticket returns to the drafter at `PENDING_IFC`
so they can issue the final package. That is a real step when the approval
carried corrections. When it did not — a clean approval of a draft that is
already the deliverable — it is a context switch back into a job the drafter
finished days ago.

**Failure scenario.** The drafter has moved to other work. The ticket waits at
`PENDING_IFC` for them to come back, re-open it, and upload a file that is often
the same file. With no escalation (`FRIC-1`), this is a common stall point.

**Chain reaction.** The `requiresFile` precondition on `submit_final` is
**not enforced server-side** (`WF-6`), so the state can be advanced with no
deliverable at all — meaning today the step can be skipped incorrectly but not
skipped correctly.

**Done when.** A clean approval with no corrections does not require the drafter
to re-enter the ticket to produce a file that already exists — or, if it must,
the ticket says plainly what is different about the final package.

---

## FRIC-6 · Closure waits on the requester acknowledging, with no fallback

- **Severity:** HIGH
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Blast radius:** friction / data quality
- **Locations:**
  - `lib/workflow.ts:319-324` — `FINAL_DRAFT` requires `canActAsRequester || allows('ticket.direct_approve') || isManagement`
  - `lib/workflow.ts:345-350` — `ticket.force_close` (default: Admin/Manager/Supervisor) is the only bypass
  - `lib/ticketShed.ts:83-96` — archive eligibility keys off `closed_at`
- **Related:** `FRIC-1`, `LEAK-3`
- **Re-verified:** hardening pass — **SURVIVES**. `FINAL_DRAFT` offers `close_ticket` only to `canActAsRequester || allows('ticket.direct_approve') || isManagement` (`workflow.ts:320-321`). The `ticket.force_close` escape at `:345-350` is an override, not a fallback — it fires only for whoever holds that capability.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). 'Closure waits on the requester acknowledging, with no fallback' is false as written: at FINAL_DRAFT any engineer or management-tier member can close directly, and force-close is available to management from ANY non-closed state, both enforced server-side at app/api/tickets/workflow-action/route.ts:96. What is genuinely absent is an AUTOMATIC/time-based closure — but that is the same missing clock already claimed by FRIC-1, so this adds no independent defect and its queue-pollution consequences should be attributed there.

**Mechanism.** The deliverable is issued. The work is done. The ticket stays open
until the requester logs in and clicks **Acknowledge & Close**. If they never do
— they left, they are on shift, they consider the job finished when the drawing
arrived — the ticket stays open forever.

**Failure scenario.** The queue accumulates tickets whose work completed weeks
ago. Every metric built on open-ticket counts is wrong. The drafting supervisor's
backlog looks worse than it is, so real backlog becomes invisible inside the
noise. Nobody trusts the queue; people stop working from it.

**Chain reaction.** `closed_at` gates archive eligibility, so un-acknowledged
tickets never shed and the table grows without bound. Auto-closing after a
delay is the obvious fix and is **not obviously right** — acknowledgment is
sometimes a real control. The distinction: acknowledgment matters where a
controlled document was distributed, and matters much less for an RFI answer.
That is again the **work class** (`TIER-2`) deciding, not a global rule.

**Done when.**
1. A ticket whose deliverable was issued does not stay open indefinitely because
   one person never clicked.
2. Where acknowledgment is a real control, it is escalated rather than waited on
   silently.

---

## FRIC-7 · The attention badge tells people to act on tickets that offer them nothing

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / adoption
- **Locations:**
  - `lib/ticketAttention.ts:106-108` — `if (roles.includes("DocCtrl")) { if (status === "FINAL_DRAFT" || status === "PENDING_IFC") return true; }`
  - `lib/workflow.ts:301-316` — at `PENDING_IFC` only `canActAsDrafter` gets actions
  - `lib/workflow.ts:319-324` — at `FINAL_DRAFT`: `canActAsRequester || ticket.direct_approve || isManagement`
  - `lib/capabilityPolicy.ts:73-77` — `ticket.direct_approve` defaults to `["Engineer"]`; `ticket.manage` to `["Admin","Manager","Supervisor"]` — **DocCtrl is in neither**
  - `app/(protected)/requests/[id]/page.tsx:1605` — the result: *"View Only - No Actions Available"*
- **Related:** `WF-24`, `CHAIN-3` (roles-and-permissions area), `DCW-1`
- **Re-verified:** hardening pass — **SURVIVES**. `ticketAttention.ts:106-108` flags DocCtrl at `FINAL_DRAFT` and `PENDING_IFC`; `workflow.ts:301-312` gives `PENDING_IFC` actions to `canActAsDrafter` only. The badge and the action list disagree. Duplicate of `UI-3` within this area — fix once.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — a DocCtrl is badged for two statuses at which getActions provably returns an empty array for them. The structural cause is exactly as the finding frames it: the badge is computed from role+status in ticketAttention.ts while the buttons are computed from the capability policy in workflow.ts, and the two are never reconciled. One wording correction: the badge does clear once the ticket leaves that status, so it is 'permanently wrong for that ticket' rather than literally never clearing.

**Mechanism.** The attention feed asserts that a DocCtrl must act on every ticket
at `FINAL_DRAFT` and `PENDING_IFC`. The workflow engine offers a DocCtrl
**nothing** at either state. The two disagree completely, and the file's own
header comment (`lib/ticketAttention.ts:60`) documents the false claim as if it
were the design.

**Failure scenario.** A document controller's badge shows a number. They open
each ticket. Every one says *"View Only — No Actions Available."* The badge never
clears, because it is computed from role + status rather than from
`getActions`. **They learn to ignore the badge — and the badge is also how real
work reaches them.**

This is the single most concrete instance of "a weird UI where people don't know
where to look." The app is actively pointing them at nothing.

**Chain reaction.** Same root cause as `WF-24` and `CHAIN-3` in the
roles-and-permissions area: three subsystems answer "who acts on this ticket?"
with three different models. Deriving attention from `getActions` fixes all
three at once and is the smaller change.

**But note the deeper reading:** whoever wrote `ticketAttention.ts:106` believed
Doc Control belongs in the flow at issue and release. **They were right** — see
`DCW-1`. The badge is not wrong about the intent; the flow never implemented it.

**Done when.** The attention badge and the ticket page agree for every
role/status combination, ideally because attention is derived from the engine.

---

## FRIC-8 · Three ticket-creation paths, three different field contracts

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data quality / friction
- **Re-verified:** hardening pass — **SURVIVES**. Three creation paths were counted directly during the drafting-flow audit and re-counted here: `requests/new/page.tsx`, `lib/transitionIn.ts` and `components/documents/CheckInPanel.tsx`. Each assembles its own field set.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The three-contract divergence is exactly as claimed, and the collision ticket genuinely has no SLA clock. One sub-claim is wrong: there is no 'unit-filtered queue view' — FilterConfig (requests/page.tsx:60-68, 180-187) has status/type/dateRange/assignedTo/priority/search only; `unit` is a sortable column and a free-text search field (page.tsx:400), not a filter.

> **Recorded in full as `LIFE-9`** in the roles-and-permissions area. Repeated
> here because the friction consequence is this report's concern: a check-in
> ticket and a collision ticket carry **no `unit`**, so they are invisible in the
> unit-filtered queue view the drafting supervisor uses to batch work — and a
> collision ticket has **no target completion date at all**, so it never goes
> past due and never appears in any overdue view.

The highest-priority ticket kind in the system is the one that can never be late.

**Done when.** See `LIFE-9`.

---

## FRIC-9 · The queue does not open on "what needs me"

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `app/(protected)/requests/page.tsx:180-196` — the default `FilterConfig`, `viewMode: 'table'`, `itemsPerPage: 25`
  - `app/(protected)/requests/page.tsx:329` — `myActionItems` **is computed** via `isActionRequired`
  - `app/(protected)/requests/page.tsx:335-337` — per-role slot counts are computed for the header stat strip
- **Related:** `FRIC-7`, `UI-*`
- **Re-verified:** hardening pass — **SURVIVES**. The queue's default filters are `status: 'ALL'` with `assignedTo` narrowed to `'me'` **only for a Drafter** (`requests/page.tsx:180-187`), while `myActionItems` is computed at `:329` and not used to shape the initial view.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. The mechanism claim (the computed action-required set does not shape the initial list) is correct for every role except Drafter. The stated failure scenario is false twice over: for a Drafter the default filter IS 'me' (:184), and the Drafter's fetch never loads the org queue at all — it fetches only `assigned_drafter_id = uid` plus the `PENDING_ASSIGNMENT` pool (:284-293), so a drafter cannot 'see every open ticket in the plant'. Severity stays MEDIUM but the scenario needs rewriting around non-drafter roles.

**Mechanism.** The page computes exactly the right number — how many tickets need
*you* — and renders it as a statistic. The list underneath still opens on the
full org queue, sorted by the default sort, paginated at 25.

**Failure scenario.** A drafter with three assigned tickets opens `/requests` and
sees every open ticket in the plant. Their own work is somewhere in the list.
They filter, or they scroll, or they use the badge and click through one at a
time.

**The fix is nearly free** — the selector already exists and its result is
already on screen. Defaulting the list to the action-required set (with a visible
"showing 3 of 84 — show all" affordance) turns a computed statistic into the
actual default view.

**Done when.** A user landing on the request queue sees their own actionable work
first, with an obvious one-click path to the full queue.

---

## Verified sound — do not break

1. **`ticket.self_assign`** (`lib/capabilityPolicy.ts:68-69`, default `Drafter`)
   and the `PENDING_ASSIGNMENT` "Pick Up Ticket" action. A drafter with capacity
   does not have to wait for a supervisor. **This is the one place the flow
   already lets someone remove a wait state, and it is exactly the right
   instinct.** Generalize it; do not remove it.
2. **Compare-and-set on `(status, last_modified)`**
   (`app/api/tickets/workflow-action/route.ts:155-191`) with a real recovery
   message surfaced to the user. Concurrency here is handled properly.
3. **`generateTicketNumber`** — atomic, collision-proof, human-readable
   (`KE-DDRT-26-0001`). Requesters can say a number out loud, which matters
   precisely because the shoulder-tap conversation is going to happen sometimes
   regardless.
4. **The requester auto-subscribes as a watcher**
   (`app/(protected)/requests/new/page.tsx:328`) — nobody has to remember to
   follow their own request.
5. **Per-request-type SLA defaults** (`lib/notifications.ts:283-287`) — the data
   model for a real SLA is already there and already org-shaped. `FRIC-1` is
   about nothing *reading* it, not about it being wrong.
6. **The stat strip's per-role slot counts**
   (`app/(protected)/requests/page.tsx:335-337`) — the queue already knows what
   each role cares about. `FRIC-9` is about the list not using what the header
   already computed.
