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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** friction / adoption
- **Locations:**
  - `lib/workflow.ts:80-342` — no transition fires without an explicit user action
  - `app/api/cron/maintenance/route.ts` — nudges stale **checkouts** (`:348`), review cycles, effective dates and acknowledgments. **No ticket scan of any kind.**
  - `lib/notifications.ts:216-232` — `isPastDue` / `isNearingDue`
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


**Partial (2026-10-21, drafting-flow Round G).** DF-P7 CONSENT — the "nothing auto-advances" half, on the consent window (`GAP-109` on `GAP-113`; `DEC-38`, `DEC-39`; DEC-90's rulings for DF-P7). Reproduced on `c22c90a`: no ticket advanced without a person (`lib/workflow.ts` — every transition is an action someone takes; `app/api/cron/maintenance/route.ts` had the SLA step, which only notifies), and a routing slot configured `consent_window` waited exactly like a sign-off (`lib/routingControl.ts:358` `MODE_LABEL`, `lib/workflow.ts:361` `slotBlocks`).
- **What landed.** A routed review whose routing table configures a `consent_window` slot (DF-P5's slot mode — notify-only slots never; the seed and every unconfigured workspace have no roster, so no window) now runs a CLOCK on it where `lib/consentWindow.ts` `planConsentWindow` allows: never on engineered work (the highest work class — the same engineering gate the roster applies), never as the engineering sign-off, never with nobody to ask, one window per review, never before `20261255`. The workflow route (`app/api/tickets/workflow-action/route.ts`, after the submission's compare-and-set) calls `open_consent_window` (`20261255`), which writes the notification rows, their `delivered` events and the ticket's stamp in ONE transaction — or nothing; a refusal leaves the slot waiting for a sign-off and the answer says so (`consentWarning`), and the maintenance step retries it. ONE step of the maintenance cron (`5c`, `lib/consentWindowScan.ts` `runConsentWindowScan` — no new cron entry; `vercel.json` keeps its two) reminds at the configured fraction (`record_consent_window_warning`, the people asked plus the assignment queue, recorded with its rows), then closes the window: audit row first (`TICKET_CONSENT_WINDOW_ADVANCE`, system actor), then the compare-and-set (`computeTransition` `consent_window_advance` — the last blocking slot issues the ticket through the same issue limb as a sign-off — DF-P7 fix pass 2: plus the routed `PENDING_IFC` pool and the `FINAL_DRAFT` intent clearing; not the copy recall or the requester / drafter email, DEC-44 (DF-P7-consent) item 12), then the append-only `ticket_notice_events` and the roster ledger (`satisfied_via = 'consent'`). One of the people asked may object (`object_consent_window`, comment required — `lib/workflow.ts`, `lib/ticketTransitions.ts`): the slot then waits for a sign-off. Tests: `lib/__tests__/consentWindow.test.ts`, `consentWindowScan.test.ts`, `dfRoundG_P7_consentRoute.test.ts`, `dfRoundG_P7_consentMigration.test.ts`, `dfRoundG_P7_consentWiring.test.ts`, `rls/dfP7ConsentWindow.test.ts` (PostgreSQL 16).
- **Done-when, re-checked against the code (DEC-29).** 1. ✓ — by drafting-flow DF-P3 (`GAP-106`): `lib/ticketSla.ts:173` `slaRecipients` warns the party the ticket waits on in its CURRENT status (its routed pool; the queue when nobody), from the maintenance cron (`app/api/cron/maintenance/route.ts:477`). 2. **Not done as written** — at the target the same scan escalates to that party, the assignment queue's owners (`lib/ticketRouting.ts:133` `queuePool`) and the requester, ONCE; there is no tier "above" the queue owners (a ticket waiting on the queue itself, `PENDING_ASSIGNMENT`, escalates to the queue it already waits on, and with a drafting supervisor set and `adminsAlsoReceiveWhenSupervisorSet` off no Admin hears). 3. ✓ — the escalation is a bell row (`emit()`, `kind: "ticket_status"`) as well as an email.
- **The title's other half — "nothing auto-advances".** Holds now for a workspace that configures a consent slot, on work that is not engineered (DF-P7, above); every other review waits on its people exactly as before (DEC-90 ruling (1) for DF-P7: fail-safe, no regression).
- **DF-P7 fix pass 3 (review).** Narrowed further, each fail-safe: a consent slot saved before DF-P7 (labelled "waits like a sign-off") opens no window until a controller re-saves the table (`consent_confirmed`, `lib/routingControl.ts` `setRoutingControl` / `confirmConsentSlots`); the close re-checks the engineered lane (held, `engineered`); a person told who is no longer an active member is not counted (held, `no_longer_member`, the assignment queue told, when nobody independent is left); and silence issues the draft as-is (FRIC-5, above) only when the window's notice named the mark — the mark is not offered while a window runs, and otherwise the close takes the `PENDING_IFC` hop and withdraws it, said (`lib/consentWindowScan.ts`, `lib/ticketTransitions.ts` `consent_window_advance`, `lib/workflow.ts` `nothingSignedYet`; DEC-44 (DF-P7-consent) items 1, 7, 18–21).

**Scope / residual.** Status stays OPEN for done-when 2 (a second escalation tier above the queue owners). **Owner: the next holder of `lib/ticketSla.ts` — proposed drafting-flow (the integrator assigns, DEC-31)**: escalate a breach that already reaches the queue's owners once more, to the workspace's Admins (or the `ticket.manage` holders), stamped once like the others.

*Assigned (2026-10-21, the integrator at the DF-P7 merge, DEC-31):* done-when 2 (an escalation tier above the queue owners) → drafting-flow **DF-P22 CONSENT AND ESCALATION FOLLOW-UPS**.

**Resolution (2026-10-22, drafting-flow Round G).** DF-P22 CONSENT AND ESCALATION FOLLOW-UPS — done-when 2, the escalation tier above the queue owners, under DEC-90 ruling (1) for DF-P22 (industry best practice, fail-safe, no regression). Reproduced on `9b4da3b`: `lib/ticketSla.ts` `slaRecipients` (`:173-180`) sends a breach to the waiting party, the assignment queue (`queuePool`) and the requester ONCE (`sla_breached_at`, claimed compare-and-set at `:376-383`) and nothing ever reads the breach again — a request the queue's owners leave overdue is never raised above them.
- **What landed.** A workspace MAY name an escalation contact — one member, or everyone holding a role (the additive collection, ADD-1) — and a period (whole days, 1–30, default 2): `org_configurations` key `'drafting'`, `slaEscalation` (`{ contact: { kind: "member", uid } | { kind: "role", role }, periodDays }`), so exactly the request-form editors set it (20261209's write rule), on Admin → Request forms (`components/requests/SlaEscalationSection.tsx`, mounted on `app/(protected)/admin/requests/page.tsx` and written by that page's own Save; a page that never touches it saves exactly what it loaded). One more pass inside step 5b of the maintenance cron, under its deadline (`lib/ticketSla.ts` `runSlaEscalationScan`, called after `runTicketSlaScan` in `app/api/cron/maintenance/route.ts`; no new cron entry, `vercel.json` keeps its two): a breach its queue owners have not cleared — the request still open, not archived, `sla_breached_at` on record and its target (if any) still passed — for a whole period tells the contact ONCE per breach per period (at breach + 1 period, again at breach + 2 periods while it stays uncleared; a run that missed periods sends one notice for the period it is in). Each is CLAIMED first on `ticket_sla_escalations` (20261264 — the unique `(ticket_id, breached_at, period_index)` key; a second run's insert is a 23505 and sends nothing), then told through an EXISTING kind (`ticket_status`, category `sla` — bell + email under the "SLA warnings" preference, `emit()` as the service role; metadata `action: "sla_escalation"`, added to `SLA_NOTICE_ACTIONS` so the workflow route retires it only on exit, like the other two), then recorded on an audit row (`TICKET_SLA_ESCALATED`, `user_id` null, `system:sla-clock`, naming the contact, the people told, the breach and the period) — written after the notice so it never names a notice that did not go out; a notice that reached nobody releases its claim (retried next run). Escalation only tells: it writes nothing on the ticket, never reassigns, never changes a status, never blocks anyone (pinned: the pass never updates `tickets`).
- **No contact configured = exactly today's behaviour.** `runTicketSlaScan` is unchanged; the tier's pass reads ONE configuration list (`org_configurations` drafting rows carrying `slaEscalation`) and stops — no ticket read, no notice, no write — pinned across every SLA state (warned, breached, unbreached, closed, waiting on the requester). A stored value the parser cannot use escalates nothing and says why. Before 20261264 is pasted the pass sends nothing and says it starts at the paste (42P01 / PGRST205 → today's step).
- **Tests.** `lib/__tests__/dfRoundG_P22_escalation.test.ts` (parser, period, uncleared rule, recipients, the no-contact pin, claim → notice → audit, once per period, cleared / ended / archived / target-moved → nothing, unreached → released, concurrent runs → one notice, the cron hunk), `lib/__tests__/dfRoundG_P22_panelsRender.test.ts` (the editor), `lib/__tests__/rls/dfP22ConsentEscalation.test.ts` (PostgreSQL 16: the claim, never rewritten, no client write, member read), `lib/__tests__/ticketSla.test.ts` (the step's import pin, updated).

**Done-when.**
1. ✓ — by drafting-flow DF-P3 (`GAP-106`), unchanged: `lib/ticketSla.ts` `slaRecipients` warns the party the ticket waits on in its current status.
2. ✓ as ruled (DEC-90 ruling (1) for DF-P22) — past-due tickets escalate to the queue owner (DF-P3) and then above them, to the contact a workspace configures, once per breach per period, recorded. **Where a workspace names no contact there is no tier above the queue** — that is the ruling's "no contact configured = exactly today's behaviour", a deliberate default (no flag day; a contact must be chosen by the workspace, never guessed), not a gap left open (DEC-29: the tier exists only where configured).
3. ✓ — the escalation is a bell row (`ticket_status`) as well as an email, and its audit row is on the request's audit trail.

The title's other half ("nothing auto-advances") is DF-P7's consent window (the Partial above) and, from DF-P22, a standing pre-authorization on a slot a workspace opts in (`GAP-109` mechanism 2); every other review waits on its people exactly as before.

**Scope / residual.** None owned here. The integrator decides `ticket_sla_escalations`' export (`exportCoverage.test.ts` DECISION_AT_MERGE — proposed exported, never imported) and adds it to `EXPECTED_TABLES` (`schemaExpectations.test.ts` ROW_AT_MERGE). A breach recorded by 20261195's paste (the backlog already overdue) is escalated too once a workspace names a contact (it is still overdue and uncleared); each run reads at most 500 breaches, oldest first.

---

## FRIC-2 · `PENDING_REVIEW` waits on the requester — often the person least able to judge the drawing

- **Severity:** MEDIUM
- **Status:** RESOLVED (2026-10-21, by the integrator's ruling at the DF-P6 merge, `DEC-90` — the unconfigured seed's serial review accepted as a documented exception; see the ruling at the end of this finding)
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P5 ROSTER. Reproduced on the base: `lib/workflow.ts:406` — `PENDING_REVIEW` is the requester's (`canActAsRequester`), and the engineer review follows it serially.

Landed — on a routed library the two questions are two slots on one parallel roster: a slot filled by the requester's identity ("Is this what you asked for?") and the technical slot(s) ("Is it correct?"), signed in any order (`lib/workflow.ts` `slotSignPlan`, `getActions` `:593`; the panel words each slot by its question — `components/requests/TicketRosterPanel.tsx` `slotQuestion`). The technical slot never waits on the requester's answer (`lib/__tests__/dfRoundG_P5_routing.test.ts` "FRIC-2: the requester's own slot is a separate question; the technical slot is not waiting on it"; the route test's either-order case). A routing table that does not roster the requester at all leaves them a Request Revision that is not waited on.

**Done-when.**
- ✗ in part "The requester is asked a question they can answer, and the technical review is not blocked on their answering it" — holds on every request in a routed library (fix pass 3: including who is TOLD — a partial sign-off keeps the reviewers still waited on in `unread_by`, and their alerts are not superseded; `lib/ticketTransitions.ts` `sign_slot`, route `fanOut` `rosterPartial`. The earlier "neither waits on the other" held for the state machine, but the first sign-off silently retired the others' alerts. DEC-29. *Corrected at the DF-P5 fix pass 4 (DEC-29): fix pass 3 kept EVERY occupant ever added in `unread_by`, so the co-occupants of a slot already satisfied stayed alerted and unread though nothing waited on them, and each partial sign-off added another alert. Now `lib/ticketTransitions.ts` `rosterPartialReleased` drops them from `unread_by` and the route retires their action alerts with the signer's (`fanOut` `rosterReleased`); an earlier partial sign-off's notice is retired for anyone told again. The audience is exactly the people still waited on, today's participants and the existing markers. Fix pass 5: "still waited on" includes an open slot's alternates once its alternate window has opened (`slotAlternatesActive`, `slotSignPlan`'s rule), so an active alternate is not released.*); a workspace that configured no routing keeps today's serial review (DEC-90 ruling (2): the seed is byte-for-byte today's behaviour; anything else is configuration).

**Owner of the remainder:** drafting-flow **DF-P6** (the review model: `TIER-1` repoints the engineering gate, after `GAP-101`), or an integrator ruling under DEC-90 that the seed itself becomes the parallel two-slot roster. Stays OPEN.

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL. The technical review no longer waits on the requester where the requester's answer was never the technical one: a **declared like-in-kind** request needs no engineer, so `PENDING_REVIEW` is one question — "is this what you asked for?" — to the person who can answer it (`TIER-1`); an undeclared request filed after the paste routes to the engineer whoever asked (a Manager no longer approves the technical content as "requester"). On a routed library the two questions are two parallel slots (DF-P5).

**Done-when.**
- ✗ in part — holds on routed libraries (DF-P5) and for declared requests everywhere; in an unconfigured workspace an undeclared request still runs requester-then-engineer serially (`request_final_engineer_approval`) — today's path, kept by DEC-90 ruling (2) / the integrator's ruling for DF-P6 (the seed is today's serial path).

**Owner of the remainder:** the integrator — a ruling under DEC-90 that the unconfigured seed itself becomes the parallel requester + engineering roster (the code supports it: `withEngineeringGate` appends the engineering slot to any table). No package can make that change without the ruling. Stays OPEN. *Named at the DF-P6 third review fix pass (DEC-31): the decision this waits on is DEC-90's proposed DF-P6 ruling **R2** (proposed: keep the serial seed; not yet given) — if the integrator overturns it, the next holder of `lib/workflow.ts` builds the parallel seed.*

*Corrected at the DF-P6 fifth review fix pass (2026-10-21, DEC-29): R2 is ruled by default, not "not yet given" — the brief's "decisionsNeeded take their proposed defaults" applies to R2 as the fourth pass applied it to R1 (DEC-90's fifth-pass line). The serial seed for an undeclared request in an unconfigured workspace stands as ruled; done-when 1 stays unmet as written there, so this stays OPEN. The integrator acts only to overturn R2; then the next holder of `lib/workflow.ts` builds the parallel seed.*

**Ruling at the DF-P6 merge (2026-10-21, the integrator under `DEC-90`).** R2 is confirmed, and the remainder is accepted as a documented exception rather than kept open: a workspace that wants the requester's question and the technical review asked in parallel configures routing (DF-P5 — a routed library's two slots, with `withEngineeringGate` adding the engineering slot), and a declared like-in-kind request asks only the requester everywhere (`TIER-1`). An unconfigured workspace keeps today's serial requester-then-engineer path for an undeclared request. Changing that seed would change the lane of every request in every workspace that has not opted in — the flag day `DEC-90` ruling (2) rules out (fail-safe, no flag day). No package owns further work here; reopening needs a new ruling that the seed itself changes, and then the next holder of `lib/workflow.ts` builds it.

---

## FRIC-3 · The intake form demands a unit before it will accept the request

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-07, drafting-flow Round G).** DF-P2 CREATE, on `DEC-101` item 1: the unit is **optional** at intake, with an explicit answer for "I don't know". The form's unit select opens on "Unit unknown — triage assigns" (`lib/ticketCreate.ts` `UNIT_UNKNOWN_LABEL`) whenever there is more than one unit — no silent first-option pre-selection (the verifier's quieter failure) — and pre-selects the only one when there is exactly one. With no unit list the box is optional and says it is a setup gap. The route records the unknown explicitly (`unit: NULL`, `metadata.unit_unknown: true`) and never refuses for it. The form and the route offer and check **one** list — `unitOptionsFor` (the saved units, else the Site Codebook's, else none), called by both; the form's built-in settings carry no units, so a workspace that never saved its request settings is offered its codebook's units, never a list the route refuses. *(Corrected at DF-P2's review fix, 2026-10-07: the form first fell back to two built-in units, "100" and "200", whenever the workspace had no saved settings row, and the route refused them.)*

**Done-when.**
- ✓ (1) A failed submit says which field and puts the cursor there: a route refusal carries its `field`, and the form focuses it (`focusField`); a required custom field is named and focused before any upload; a title or description of only spaces is named and focused (no bare `return` left). `lib/__tests__/requestFormCreate.test.ts`, "a refused submit names the field and moves the cursor to it", "a title of only spaces is named and focused", and the EDGE-13 required-field case.
- ✓ (2) Unit is derived from the source document where one is attached — server-side, when the requester gave none: the document's metadata unit (`unitOfDocumentMetadata`, what the check-in and the collision always wrote), then its codebook `unit_code`; the first that is on the list wins, else the first given, kept and marked `unit_unlisted` (`lib/ticketCreate.ts` `resolveDerivedUnit`; `lib/__tests__/ticketCreateRoute.test.ts`, "no unit given but a source document names one: derived and resolved to the list's value", and "FRIC-3 / DCW-7 — one unit list for the form and the route; a derived unit tries each candidate").
- ✓ (3) All three creation paths satisfy the same field contract (`FRIC-8`).

**Scope / residual.** A triage action that sets the unit on a "Unit unknown" ticket is `DCW-7`'s residual. Nothing yet **shows** the recorded unknown: no reader of `metadata.unit_unknown` / `unit_unlisted` / `unit_unchecked` (the unit given when the list could not be read — `DCW-7`, third review fix) exists, and the queue and the ticket page render an empty unit chip for a NULL unit (`app/(protected)/requests/page.tsx`, `app/(protected)/requests/[id]/page.tsx`, DF-P9's files) — proposed for **DF-P9** in `99-fix-sequencing.md`, "Hand-offs from DF-P2".

*Readers landed (2026-10-14, drafting-flow Round G, DF-P9 TICKET-PAGE) — this record's Scope.* The recorded unknown is now shown: `lib/ticketStatusLabels.ts` `ticketUnitDisplay` (:90) reads `unit` with `metadata.unit_unknown` ("Unit unknown — triage assigns"), `unit_unlisted` (the unit, marked "not on the unit list") and `unit_unchecked` (the unit given, "not checked — the unit list could not be read; triage assigns"); a bare NULL with no mark reads "No unit recorded". The ticket page's unit field (`app/(protected)/requests/[id]/page.tsx`:2395) and the queue's unit cells and row chips (`app/(protected)/requests/page.tsx`:1448, :1373, :1554, `rowChips` :645) use it. The triage `unit` is sent by the assign modal (`DCW-7`). Tests: `lib/__tests__/dfRoundG_P9_ticketPage.test.ts` "FRIC-3 / FRIC-8 — the unit as a person reads it"; `lib/__tests__/dfRoundG_P9_ticketDetail.test.ts` "PROJ-9 / FRIC-3"; `lib/__tests__/dfRoundG_P9_requestsQueue.test.ts` "UI-7 / FRIC-3 / EDGE-8".

---

## FRIC-4 · The requester must personally choose an engineer, by email prefix

- **Severity:** HIGH
- **Status:** RESOLVED (2026-10-21, by the integrator's ruling at the DF-P6 merge, `DEC-90` — the unconfigured seed's requester pick accepted as a documented exception; see the ruling at the end of this finding)
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P5 ROSTER. Reproduced on the base: `lib/workflow.ts:418` (`request_final_engineer_approval`, `requiresEngineerPick: true`); the picker listed every engineer by email prefix (`components/requests/EngineerPickerModal.tsx:106`) from an unpaged read with its own filter (`:88`, `:98`).

Landed:
- **Under a routed library nobody picks a reviewer.** The assigner / requester flags nothing and chooses no one: the routing table resolves the occupants of every slot (roles, named people, a capability, the requester's identity) when the draft is submitted, and the roster panel shows them read-only (`lib/ticketRoster.ts` `openRoster`, `components/requests/TicketRosterPanel.tsx`). `request_final_engineer_approval` / `requiresEngineerPick` are not offered on a roster (`lib/workflow.ts:593`).
- **Where a person must still be chosen (no routing configured — DEC-90 ruling (2), the fallback) the picker offers exactly who the route accepts**, by name: `lib/ticketPage.ts` `engineerCandidates` / `engineerPickRefusal` — the route's own rule, now called by the route too (`app/api/tickets/workflow-action/route.ts:512`) — over a keyset-paged member read (`lib/ticketPickerMembers.ts`); the row shows the member's display name, email and engineer role (`ROUTE-8`).

Tests: `lib/__tests__/dfRoundG_P5_routing.test.ts` ("TIER-5 done-when 3 …" — no pick on a roster; "ROUTE-8 remainder …").

**Done-when.**
- ✗ in part (1) A requester is never required to name a reviewer — holds on every request in a routed library; in a workspace that configured no routing the requester still picks the engineer at `PENDING_REVIEW` (today's path, kept by DEC-90 ruling (2): an unconfigured workspace routes exactly as today).
- ✗ in part (2) Where a person must be chosen, the choice is defaulted from the library's review policy and the work class, and the picker shows why — the picker now offers only who the route accepts and shows names, and a library can derive the reviewers instead (routing); defaulting from the work class needs the class (`GAP-101`, not built).

**Owner of the remainder:** drafting-flow **DF-P6** (`GAP-101` → `TIER-1`: the engineering gate keyed to the work class, which moves the fallback pick onto the class / the router), with an integrator ruling under DEC-90 if the unconfigured default itself is to change. Stays OPEN.

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL. The class now exists (`GAP-101`) and the engineering requirement follows the work (`TIER-1`): a declared like-in-kind request never asks anyone to pick an engineer; a request whose workspace routes it resolves its engineer from the routing table (DF-P5), and a routing slot can be limited to work classes (notify-only — `TIER-3`). In an unconfigured workspace an undeclared request still asks the requester to pick an engineer at `PENDING_REVIEW` (today's path).

**Done-when.**
- ✗ in part (1) A requester is never required to name a reviewer — holds for declared requests and on routed libraries; not for an undeclared request in an unconfigured workspace (DEC-90 ruling (2)).
- ✗ in part (2) Defaulted from the library's review policy and the work class — from the library: ✓ (routing); from the class: the class is stored and a routing slot can key on it, but a blocking slot cannot (ruled notify-only for DF-P6) and the fallback picker does not default from it.

**Owner of the remainder:** the integrator (the same DEC-90 ruling as `FRIC-2`: an unconfigured workspace's seed routes the engineer instead of asking the requester), or drafting-flow DF-P9 for a picker default keyed on the class once a ruling says which engineer a class implies. Stays OPEN. *Named at the DF-P6 third review fix pass (DEC-31): the decision this waits on is DEC-90's proposed DF-P6 ruling **R3** (proposed: keep the requester's pick in an unconfigured workspace; not yet given) — if overturned, DF-P9 builds the default.*

*Corrected at the DF-P6 fifth review fix pass (2026-10-21, DEC-29): R3 is ruled by default, not "not yet given" — the brief's "decisionsNeeded take their proposed defaults" applies (DEC-90's fifth-pass line). The requester's pick for an undeclared request in an unconfigured workspace stands as ruled; done-when 1 and 2 stay unmet as written there, so this stays OPEN. The integrator acts only to overturn R3; then DF-P9 builds the default.*

**Ruling at the DF-P6 merge (2026-10-21, the integrator under `DEC-90`).** R3 is confirmed, and the remainder is accepted as a documented exception rather than kept open: where a workspace configures routing, the engineer is routed by the library's table (a named person, a role, a capability) and the requester names no one (DF-P5); a declared like-in-kind request needs no engineer at all (`TIER-1`). An unconfigured workspace keeps today's requester pick for an undeclared request, and a class-keyed default is not built, because no record says which engineer a class implies — the routing table is where a facility says that. No package owns further work here; reopening needs a new ruling, and then the next holder of `EngineerPickerModal.tsx` builds the default.

---

## FRIC-5 · The drafter is interrupted twice for one deliverable

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P5 ROSTER, on DEC-90 ruling (1) (opt-in per ticket by the drafter; default OFF = today's `PENDING_IFC` hop). *(Recorded RESOLVED in the first DF-P5 commit; corrected to Partial at the DF-P5 fix pass — the ✓ held only when the drafter had opted in, and the request page offers no at-submit opt-in yet, so a default approval still returns the request to the drafter. DEC-29.)* Reproduced on the base: `lib/workflow.ts:532` — after any approval the ticket returns to the drafter at `PENDING_IFC` for `submit_final` and a fresh upload.

Landed:
- The drafter marks the draft **issue-ready**: `submit_draft` with `issueReady: true` (the API's at-submit path, `lib/ticketTransitions.ts` `submit_draft`), or `mark_issue_ready` — offered to the assigned drafter only while NO sign-off has landed on the draft (`PENDING_REVIEW`, no roster slot satisfied: `lib/workflow.ts` `nothingSignedYet`), the nearest the page offers to "at submit" until it has the checkbox, so no reviewer signs without the issue-as-is note in front of them. Once a sign-off is in, the mark can only be withdrawn (`clear_issue_ready`). The mark is bound to the revision label it was made on (`issueReadyFor`), so any new submission clears it.
- With the mark, the approval that issues the draft (`approve_draft_ifc`, `engineer_approve_final`, or the roster's last sign-off) records the approved Draft as the Final — same bytes, same storage key, a new id, the issued label, `issuedFromDraftId` — and moves the request to `FINAL_DRAFT` (`lib/ticketTransitions.ts` `asIsIssue` `:384`, `issueAsIsFinals` `:264`). A minor correction never issues as-is (the correction must be folded in); a draft with no per-file revision falls back to `PENDING_IFC`, saying so.
- The approver is told plainly, wherever the approval is taken (DF-P5 fix pass 2). *(Corrected: the first commit put `ISSUE_AS_IS_NOTE` only in the action's `description`, which no UI renders, and the roster panel never showed it. The earlier claims "the approver is told plainly" and "no reviewer signs without the note" overstated. DEC-29.)*
  - On the request page, an approval that issues a marked draft (`approve_draft_ifc`, `engineer_approve_final`) goes through a confirm that says what it does (`lib/workflow.ts` `issueAsIsConfirmation`, `appConfirm` in `initiateWorkflowAction`). *Fix pass 3: the confirm is the server's too.* The page sends `issueAsIsAcknowledged: true` only for the approval its confirm asked about (`asIsAckRef`). The route refuses an as-is issue without it (`409 issue_as_is_unconfirmed`, nothing written: `app/api/tickets/workflow-action/route.ts`, `ISSUE_AS_IS_APPROVALS` && `issueReadyFor`). A mark made after the approver's page loaded, or a direct POST, therefore no longer issues the draft blind. *(The fix pass 2 claim "never taken blind" rested on a browser-only confirm, so it was overstated. DEC-29.)*
  - While a marked draft waits on a serial approval, the page shows a banner (`issueAsIsBanner`, `data-testid="issue-as-is-banner"`).
  - On a routed review, `TicketRosterPanel` shows `ISSUE_AS_IS_NOTE` above the Sign off button, and the signed statement carries it (`rosterSignStatement`).
- Marking or withdrawing is not a status change (UI-4, fix pass 2). Only the reviewers whose approval it changes are told, each with one bell row: `lib/ticketTransitions.ts` `issueMarkAudience` gives the open blocking slots' occupants on a roster, otherwise the requester in review or the engineer in final approval. No email is sent, watchers are not told, nobody's outstanding review alert is superseded, and existing unread markers are kept. On the drafter's own view the optional mark sits beside the "who this waits on" note instead of replacing it (`awaitedButtons` on the page).

Tests: `lib/__tests__/dfRoundG_P5_routing.test.ts` ("FRIC-5 — issue-as-is …", six cases incl. "DEFAULT OFF"; "DF-P5 fix — FRIC-5: the issue-as-is mark is offered only before the first sign-off lands"; fix pass 2: "DF-P5 fix pass 2 — FRIC-5 is in front of the approver; the drafter's optional mark keeps the UI-4 note and tells only the reviewers", five cases incl. the REGRESSION for the drafter's PENDING_REVIEW view in an unconfigured workspace); `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("FRIC-5: the drafter marks issue-ready; the approval then issues the draft as the Final (FINAL_DRAFT)"; "DF-P5 fix pass 2 (UI-4): the mark is not a status change …"); `lib/__tests__/dfRoundG_P5_rosterPanel.test.ts` ("DF-P5 fix pass 2 — FRIC-5 in front of every approver …": the panel note above the sign-off, the signed statement, and source pins for the page's confirm, banner and UI-4 note); fix pass 3: `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("FRIC-5: an approval of a draft marked issue-as-is WITHOUT the approver's acknowledgement is refused (409) …", "REGRESSION: an unmarked draft needs no acknowledgement …"), `lib/__tests__/dfRoundG_P5_rosterPanel.test.ts` ("the page sends issueAsIsAcknowledged only for the approval its confirm asked about").

**Done-when.**
- ✗ in part "A clean approval with no corrections does not require the drafter to re-enter the ticket to produce a file that already exists" — holds whenever the drafter opted in before the first sign-off; a DEFAULT approval (no opt-in — DEC-90 ruling (1) keeps it off) still returns the request to the drafter at `PENDING_IFC`, and the request page has no at-submit checkbox, so the opt-in is a ticket action rather than part of submitting.

**Owner of the remainder:** the at-submit checkbox on the request page's Submit (`issueReady` on `submit_draft`, which the route already takes) → the next package holding `app/(protected)/requests/[id]/page.tsx` (DF-P9's page); the integrator may instead rule under DEC-90 (1) that the opt-in ticket action satisfies the done-when. No migration (the mark lives in `metadata`, which is workflow-owned since `20261166` / `20261208`). Stays OPEN.

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* the at-submit "issue as-is" checkbox on the request page → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**.

**Resolution (2026-10-21, drafting-flow Round G).** DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — the at-submit checkbox, under DEC-90 ruling (5) for DF-P18 ("'issue as-is when approved' at submit defaults off and shows only where the ticket's toggle shows today") on DEC-90 ruling (1) for DF-P5 (opt-in per ticket by the drafter). Reproduced on the base: the request page's Submit sent no `issueReady`; the opt-in was only the later ticket action (`mark_issue_ready`). Landed: beside an offered Submit Draft, the request's ASSIGNED DRAFTER (the one person the ticket's own "Issue As-Is When Approved" toggle is offered to) sees an "Issue as-is when approved" checkbox, unticked by default (`page.tsx:2474` `issueReadyOffered` / `:2961` `data-testid="issue-ready-at-submit"`, `lib/requestPageReview.ts` `issueReadyAtSubmitOffered`); ticked, the submission carries `issueReady: true` (`submit_draft` — the route and `computeTransition` already take it: the mark is bound to the label the submission creates, and every reviewer then sees the issue-as-is note and confirm DF-P5 built). The choice is for one submission (reset after it lands). Nobody else sees it, and an unticked submit sends exactly today's body. It needs no configuration: the assigned drafter sees it in every workspace, so it is the second exception (with the equipment control, ruling (4)) to DEC-90 ruling (1)'s "an unconfigured workspace sees today's screens" — ruling (5) asks for it (DEC-90's DF-P18 Landed line (1); *corrected at the DF-P18 fix pass 3, review minor, DEC-29: the records had named only the equipment control*).

Tests: `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts` ("FRIC-5 — issue as-is at submit": who is offered it, default off, sent only for `submit_draft`, only when ticked, only by the assigned drafter, reset after); DF-P5's route tests for `issueReady` on `submit_draft` (unchanged, green).

**Done-when.**
- ✓ (as ruled) "A clean approval with no corrections does not require the drafter to re-enter the ticket to produce a file that already exists" — the drafter can now choose it AS PART OF SUBMITTING (and still afterwards, until the first sign-off), and a clean approval then issues the approved draft as the final package with no re-entry; with the choice left off (the default, DEC-90 ruling (1) for DF-P5 and ruling (5) for DF-P18) the request returns to the drafter as today, which the record's own owner line allowed the integrator to rule sufficient ("the integrator may instead rule under DEC-90 (1) that the opt-in … satisfies the done-when").

**Scope / residual.** None. No migration.

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
- **Status:** RESOLVED
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

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`; no code changed here. The over-count half — the badge flagging work the page does not offer, this finding's failure scenario — is closed by roles-and-permissions [`WF-24`](../roles-and-permissions/06-request-workflow.md) / `CHAIN-3` (Round E, `e5a203b`, 2026-09-17). The done-when asks for agreement on **every** role/status combination, and one real combination still disagrees in the other direction, so this stays OPEN (the DF-P0 review fix pass reopened it from `RESOLVED`; `UI-3` and `ROUTE-2`, whose done-whens are the over-count direction, stay closed). The badge no longer holds a role × status table — it is the engine: `lib/ticketAttention.ts:79-91`, `isActionRequired` calls `WorkflowEngine.getActions(ticket, headline, uid, ctx.policy ?? undefined, { userRoles, activeMemberCount, engineeringFirstTypes, closeWithoutReviewTypes })` and returns `actions.some((a) => !a.optional && !a.disabledReason)`. The rule this finding quotes (`if (roles.includes("DocCtrl")) { if (status === "FINAL_DRAFT" || status === "PENDING_IFC") return true; }`) exists nowhere in `lib/`, `hooks/`, `app/` or `components/` (grep). The management tier is defined once (`lib/managementRoles.ts:25`, `MANAGEMENT_ROLES = ["Admin", "Manager", "Supervisor"]`); the badge hook and the portal pass the org's policy, type flags and active-member count, so the engine sees the page's inputs.
- Tests: `lib/__tests__/ticketAttention.test.ts:78` (nine roles × ten statuses × six identities × five page contexts: badge = page's live actions); `lib/__tests__/dfRoundG_P0.test.ts:325` (new — every role in `ALL_ROLES` × every `TicketStatus` × four identities; DocCtrl unflagged at `FINAL_DRAFT` / `PENDING_IFC`); `lib/__tests__/sweepRoundE_A.test.ts:779` ("WF-24 / CHAIN-3").

**Done-when.** ✗ (in part) The attention badge and the ticket page agree for every role/status combination **given the same inputs**, because attention is derived from the engine (`lib/ticketAttention.ts:84-90`) — ✓, and so the over-count is gone (DocCtrl at `FINAL_DRAFT` / `PENDING_IFC`, management at `PENDING_IFC`; `lib/__tests__/dfRoundG_P0.test.ts:325`). But they do not get the same inputs: the badge has no field for the requester's current collection (`isActionRequired` takes `AttentionContext` without `requesterRoles`, `lib/ticketAttention.ts:79-91`), so where the route and page resolve a departed requester as `[]` and require the co-review (`requesterCanAct` false, `lib/workflow.ts:217`), the badge does not flag it. That is a real (role, status) pair — a Manager or Engineer-2 co-reviewer at `PENDING_REVIEW` — on which page and badge disagree: `lib/__tests__/dfRoundG_P0.test.ts:344` asserts the engine requires an action with `requesterRoles: []` while `isActionRequired` returns false (the every-role × every-status equality test passes identical contexts and so cannot see it). "Ideally because attention is derived from the engine" ✓.

**Scope / residual.** Binding → **DF-P9**, which owns `lib/ticketAttention.ts` and `hooks/useTicketNotifications.ts`: an `AttentionContext.requesterRoles` input, fed by the badge hook from the requesters' current membership (one batched member read for the tickets in view), passed to the engine as the route passes it — so a departed requester's ticket is counted by the badge, bell and inbox, not only shown on the page. Until then it is surfaced on the page and the route but counted by no badge, and can stall unseen by everyone who works from the badge (an under-count, never an unclearable badge). WF-24 recorded the under-count as accepted for its own done-when; that does not bind this one. DF-P9's brief does not name it; the integrator must add it (`99-fix-sequencing.md`, "Hand-offs from DF-P0" — no longer optional). The finding's "deeper reading" (Document Control belongs at issue and release) is `DCW-2` / `GAP-104`, OPEN under DF-P6: removing the false DocCtrl badge did not build that slot.

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — the under-count the DF-P0 review fix pass left. `lib/ticketAttention.ts` `AttentionContext.requesterRoles` (a map uid → current role collection) is passed to the engine for each ticket as the route and the page pass it (`requesterRolesFor`, :98; `[]` = known not to be an active member, so the engine requires the co-review; no entry = unknown, assumed present, the old behaviour — a failed read never invents a departure). `lib/ticketRequesterRoles.ts` (new) `loadRequesterRoles` reads the active members among the tickets' requesters in slices of 100 (`.in('uid', …)`, read only), answering `[]` for a requester the read did not return and `null` when the read fails. The badge hook (`hooks/useTicketNotifications.ts:659`, `:927`) and the queue (`app/(protected)/requests/page.tsx`:411, :327) feed it with the tickets they read, so the badge, bell, inbox and the queue's "needs you" markers count a departed requester's review exactly where the page requires it.

**Done-when.** ✓ The badge and the ticket page agree for every role/status combination given the same inputs, and now they get the same inputs. `lib/__tests__/dfRoundG_P9_ticketPage.test.ts` "FRIC-7 — the badge is given the requesters' CURRENT roles" (Engineer-2, Admin and Manager counted at `PENDING_REVIEW` for a departed requester — equal to the page's engine call with `requesterRoles: []` — not counted for a present one, and an uncovered requester unchanged; the loader's slices, `[]` entries and failure); `lib/__tests__/attentionProvider.test.ts` ("drafting-flow Round G (DF-P9) — the badge counts what the page offers") "FRIC-7: a departed requester's review is counted for an engineer…" (rendered hook); `lib/__tests__/dfRoundG_P9_requestsQueue.test.ts` "FRIC-7 — the queue's markers are given the requesters' current roles". The every-role × every-status equality tests (`lib/__tests__/ticketAttention.test.ts`; `lib/__tests__/dfRoundG_P0.test.ts:326`, "ROUTE-2 — every (Role × TicketStatus): the attention badge is the engine's live-action set") still pass unchanged.

**Scope / residual.** None. The finding's "deeper reading" (Document Control's slot at issue and release) stays `DCW-2` / `GAP-104` under DF-P6, as recorded.

*DF-P9 review fix pass (2026-10-14):* the ticket page's OWN read of its requester's membership (`app/(protected)/requests/[id]/page.tsx`, the `requesterRoles` effect, :1269) did not hold this record's rule — it ignored `error`, so a failed read (`{ data: null, error }`, not a rejection) became `[]` ("left the workspace"): the page's engine offered engineers and managers a required co-review and the new waiting line (`UI-1`) said the requester was gone. It now reads `{ data, error }`: an error is null (unknown, assumed present), exactly as `loadRequesterRoles` answers; `[]` only when the read succeeded and found no active row. `lib/__tests__/dfRoundG_P9_ticketDetail.test.ts` "fix pass (FRIC-7): a requester read that ERRORS invents no departure — the line still waits on the requester by name" and its success-with-no-row regression.

---

## FRIC-8 · Three ticket-creation paths, three different field contracts

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-07, drafting-flow Round G).** DF-P2 CREATE. One contract, one path. `lib/ticketCreate.ts` is the field contract every creator posts (`TicketCreateInput`: title, description, request type, priority, unit, target date, requester role, custom categories, source documents, attachments, and an `origin` that is `portal`, `checkin` or `intake_collision`), and `app/api/tickets/create/route.ts` is the only writer. It checks each origin against what binds it: the request form's required custom fields and unit list for `portal`; for `checkin`, a checkout of the source document by this requester (in the named episode — that document's, in this workspace — or still active); for `intake_collision`, a project in this workspace whose intake folder (`projects.intake_collection_id`) holds the source sheet, an intake link of that project when one is named, and — when named — a colliding document the caller can see (otherwise dropped with a warning, never stored); the queue notice's title is the sheet's own number read from the row, never the client's `sheetLabel` (`checkOrigin`; refused 400, field `origin`, otherwise). Source documents are read as the caller, so a document the caller cannot open never lends its fields to a request. So naming an origin is not a way around the form, and a check-in's PSM flags (`undocumented_change`, `moc`) are never written without a checkout behind them. What is **not** re-checked: a collision's overlap list is the scan's description and is stored as reported (`metadata.intake_collision.overlaps`, up to `MAX_COLLISION_OVERLAPS` with the full count and a truncated flag past it). *(Corrected at DF-P2's review fix, 2026-10-07: the required fields were first enforced only when the caller named the `portal` origin, so a member could name another origin to skip them.)* *(Corrected at DF-P2's second review fix, 2026-10-07: an `intake_collision` was first checked only for "a project exists in this workspace", so any member could post a collision against any project with a made-up sheet label as the notice title.)* It stamps the same row for every origin — `PENDING_ASSIGNMENT`, the SLA clock (`target_completion_at`, the form's date or `defaultSlaTargetDate`), the requester as watcher, the opening history line, the canonical source reference(s) and `unit` (resolved, derived from the source document, or the explicit "Unit unknown — triage assigns", `DEC-101` item 1). A collision ticket now has a due date and its flagger as a watcher, as `LIFE-9` required, from the same code as the other two.

**Done-when.** `LIFE-9`'s (roles-and-permissions, RESOLVED 2026-09-02) — re-checked on the one path: ✓ (1) all three origins produce the same required-field set (`lib/__tests__/ticketCreateRoute.test.ts`, "REGRESSION — each door's legitimate flow files the same ticket": the request form, a check-in and an intake collision); ✓ (2) a collision ticket has a target date and enrols its flagger; ✓ (3) a check-in or collision ticket carries `unit` whenever its source document names one, and the explicit unknown (`metadata.unit_unknown`) when it does not — sortable and searchable like any other (there is no unit facet filter, as the verifier noted); the record is explicit, its display is not yet (an empty chip on the queue and the ticket page — `FRIC-3` Scope). And the origin is checked against its own facts: `lib/__tests__/ticketCreateRoute.test.ts`, "FRIC-8 — the origin is checked against its own facts; naming one is not a way around the form" (no checkout: 400, nothing numbered, no PSM flag; another member's checkout; an episode of another document or workspace; a retry after a failed close files; a legacy check-in with no episode files on an active checkout only; a collision naming another workspace's project; unreadable facts 503) and "FRIC-8 — an intake collision is held to the project's own intake facts" (a sheet outside the project's intake folder, another project of the workspace, an intake link not the project's: each 400 with nothing numbered; the notice and history carry the sheet's own number; a colliding document the caller cannot see is dropped with a warning; a malformed id is refused); "source documents are read AS THE CALLER — the document ACL applies" (a restricted document is dropped like one not here, none of its fields stored; a check-in on it is refused).

Third review fix (2026-10-13). A viewer's "Send to Drafting" whose library key predates the `orgs/<orgId>/` prefix is attached when a version of a document in this workspace, read as the caller, carries it (`sourceReferenceUsable`, `app/api/tickets/create/route.ts:280-297`, `DEC-101` item 5). Before this fix it was dropped as "not a file in this workspace". A legacy check-in retried after its checkout closed is told so instead of getting the ownership refusal (`LEAK-6`). `lib/__tests__/ticketCreateRoute.test.ts`, "FRIC-8 / DEC-101 item 5 — a legacy library key the register carries is attached" and "FRIC-8 / LEAK-6 — a legacy check-in retried after its checkout closed is told what happened".

**Scope / residual.** Who resolves a "Unit unknown" ticket at triage is `DCW-7`'s residual.

*Readers landed (2026-10-14, drafting-flow Round G, DF-P9 TICKET-PAGE).* The explicit unknown this record's done-when 3 left undisplayed is now shown on the queue and the ticket page — see `FRIC-3`'s note (`lib/ticketStatusLabels.ts` `ticketUnitDisplay`).

---

## FRIC-9 · The queue does not open on "what needs me"

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE, on the integrator's ruling under `DEC-90` (the queue opens on "needs me" for every role; "all open" one click away; counts visible). `app/(protected)/requests/page.tsx`: `attentionView` starts at `'needs_me'` (:232) for every role, and the list (table and cards) shows `needsMeTickets` — the filtered list narrowed by the engine's action-required rule (`isActionRequired`, :327, the badge's rule) — with a summary line "Showing the N requests that need you, of M. Show all". A "Needs me N / All M" toggle sits in the filter row (:1237); when nothing needs the viewer, an empty state says so and offers "Show all M" (never "No matching tickets"). The Action Required tile and banner switch to the same view (the tile counts every loaded request the engine marks, before the filters; the toggle counts within them — `AUTHZ-15` covers the tile during a policy fault). The assignee filter now starts at "all" for everyone — the Drafter-only `assignedTo: 'me'` default was the proxy this replaces. The supervisor's by-drafter board keeps the whole filtered list (the team's work by design).

**Done-when.** ✓ A user landing on the queue sees their own actionable work first, with an obvious one-click path to the full queue. `lib/__tests__/dfRoundG_P9_requestsQueue.test.ts` "FRIC-9 / UI-6 — the queue opens on what needs me": a drafting supervisor lands on Needs me (count 1) with All (3) shown; REGRESSION — one click on All lists every request the scope returned; a requester with nothing waiting gets the empty state and "Show all"; a Drafter is no longer defaulted to "My Tickets" and sees the pool request they can pick up.

**Scope / residual.** None. The ruling changes the landing view for every role on purpose (`DEC-90`); "All" is one click and the counts are on screen.

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
5. **Per-request-type SLA defaults** (`lib/notifications.ts:237-243`) — the data
   model for a real SLA is already there and already org-shaped. `FRIC-1` is
   about nothing *reading* it, not about it being wrong.
6. **The stat strip's per-role slot counts**
   (`app/(protected)/requests/page.tsx:335-337`) — the queue already knows what
   each role cares about. `FRIC-9` is about the list not using what the header
   already computed.

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
