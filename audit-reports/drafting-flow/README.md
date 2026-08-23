# Drafting Request Flow — audit area

Read-only audit of the drafting request flow end to end: intake, triage,
assignment, drafting, review, approval, issue, closure — plus its document
control wiring, its permissions, its friction, its leaks, and whether anyone can
use it without being taught.

**No application code, test, or migration was modified at any point.**

---

## ⚠ Before you touch anything

1. **Read [`../README.md`](../README.md)** — the resolution protocol — and
   [`../DECISIONS.md`](../DECISIONS.md), which settles the judgment calls this
   area shares with the roles model.
2. **Read [`99-fix-sequencing.md`](./99-fix-sequencing.md).** One build here is a
   keystone: implementing the correct review model on the current serial state
   machine produces a workflow people will route around, which is the failure
   this audit exists to prevent.
3. **This area overlaps `roles-and-permissions` deliberately.** That area covered
   *authority* in this flow (`WF-*`, `LIFE-*`). This one covers *friction,
   latency, wiring and discoverability*. Where a defect belongs to both, it is
   recorded in full in one place and cross-referenced from the other — never
   duplicated. Cross-references name the owning ID.

---

## Findings

**139 findings** — 9 CRITICAL, 46 HIGH, 61 MEDIUM, 23 LOW — plus **14 gap specs**, all
buildable.

Two passes. **`01`–`05`** are the design read: review tiering, friction, wiring,
leaks, discoverability. **`06`–`13`** are the deep read: seven code lenses plus a
completeness critic, every finding put through an adversarial refutation pass.

| # | Report | Findings | Focus |
|---|---|---|---|
| 01 | [Review tiering](./01-review-tiering.md) | 8 | Like-in-kind vs new design vs QA/QC vs code-governed — and why none of it can be expressed |
| 02 | [Friction & latency](./02-friction-latency.md) | 9 | The hop model: who waits, how long, and which waits are load-bearing |
| 03 | [Document control wiring](./03-doc-control-wiring.md) | 7 | Routing drawings to the library's document controller for review and release |
| 04 | [Flow leaks](./04-flow-leaks.md) | 9 | Where work, state and attention escape without saying so |
| 05 | [Discoverability](./05-ui-discoverability.md) | 7 | Can a first-time user work this without studying it? |
| 06 | [State machine](./06-state-machine.md) | 13 | Reachable transitions, concurrency, partial failure, and the actions that skip the gates |
| 07 | [Persistence & RLS](./07-persistence-and-rls.md) | 8 | What the database actually permits, and which writes fail silently |
| 08 | [Routing & attention](./08-routing-and-attention.md) | 11 | Who is told what, and what goes quiet |
| 09 | [Authority surfaces](./09-authority-surfaces.md) | 13 | Every door into a ticket, including the public verify endpoint |
| 10 | [Audit & evidence](./10-audit-evidence.md) | 14 | What this system could prove to a PSM auditor, and what it could not |
| 11 | [Document handoff](./11-document-handoff.md) | 13 | Where the request flow meets the controlled document, and the as-built path |
| 12 | [Projects boundary](./12-projects-boundary.md) | 13 | The bidirectional-portal question, answered from the schema up |
| 13 | [Edges & invariants](./13-edges-and-invariants.md) | 14 | The completeness critic, plus what is sound and must not break. **Verified by hand** — record at the top of the file |
| 90 | [**Gap register**](./90-gap-register.md) | 14 specs | What has to be built. `GAP-101`+ so they never collide with the other area |
| 99 | [**Execution order**](./99-fix-sequencing.md) | — | Binding. Read before claiming any file |

**`06`–`12` were adversarially verified** — a second agent read the cited code and
tried to refute each finding. Three were refuted and are not recorded. Several
severities were lowered by that pass and the lowered value is the one shown.

**`13` has since been verified by hand.** Every `CRITICAL` and `HIGH` was re-read
against the source; the per-finding record is at the top of that file. Two
findings were corrected (`EDGE-2` retitled to its general case, `EDGE-6`
scoped away from code that is already correct), one was lowered (`EDGE-1`
`CRITICAL` → `HIGH`).

**Everything in this area has since been challenged by an independent agent.**
No finding is `unverified` any more — see `verified_by` in
[`findings.json`](./findings.json). That pass refuted two findings (`FRIC-6`,
`UI-5`, both marked `Status: REFUTED` in place — **do not queue them**) and
lowered a number of severities, which is why the totals above differ from what
the original run reported.

### Root-cause clusters — read before claiming a file

Four findings are the same defect seen from different angles — three of the nine
CRITICALs plus `PERS-1`, which the independent pass lowered to `HIGH` on the
grounds that the blanket policy is intra-tenant. They still share one fix. An
agent claiming one file needs to know it shares that fix with three others.

| Cluster | Findings | One fix |
|---|---|---|
| **The blanket `tickets` RLS policy** | `SM-2`, `PERS-1`, `AUTHZ-2`, `EVID-1` | One migration. `supabase/schema.sql:1079-1081` is `FOR ALL USING (…)` with no `WITH CHECK`. Four lenses found it independently. |
| **The minor-correction bypass** | `SM-1`, `AUTHZ-1`, and `TIER-7` | One gate. `GAP-111` requires it inside the delivery gate. |
| **Audit writes that cannot fail loudly** | `PERS-7`, `EVID-6` | `supabase-js` resolves with `{error}` rather than throwing. |
| **`rowToTicket` never maps `metadata`** | `SM-11`, `PERS-5` | One line — and the reason `GAP-110`'s declaration cannot live in `metadata`. |
| **Headline `role` instead of `roles[]`** | `ROUTE-8`, `ROUTE-10`, `EDGE-6`, and `LEAK-2` | `DEC-1` collapses all four. |
| **The SLA layer has no reader** | `ROUTE-9`, `EDGE-7` | `GAP-106`. |

---

## The headline

**The one gate this flow has is pointed the wrong way, and every review
requirement you want to add costs a wait state.**

Every review decision reduces to five lines (`lib/workflow.ts:37-43`), and the
function takes **one argument: who asked.** Not what the work is. So:

| Who asks | What for | Engineer required? |
|---|---|---|
| Maintenance planner | Like-in-kind gasket swap | **YES** |
| **Manager** | **New tie-in on a live process line** | **NO — self-approves to IFC** |

The gasket swap costs **6 wait states and 4 people**. The new tie-in costs fewer,
and no engineer ever sees it.

**The friction problem and the safety problem are the same problem.** The system
spends its ceremony on the people who need it least and skips it for the work
that needs it most. Fixing that improves both at once — which is unusual and
worth exploiting.

Three structural facts behind everything else:

1. **There is no work classification.** `request_type` is `export type RequestType = string`,
   unvalidated, and it reaches an authority decision exactly once in the entire
   codebase — for `'RFI'`. Like-in-kind and new design are indistinguishable.
2. **A ticket has no library.** `Ticket` carries no `libraryId`, no
   `collectionId`, no container reference of any kind. Every document-control
   rule in the system resolves through the container chain, and the ticket sits
   outside it. **That is why "route this drawing type to doc control of that
   library" cannot be built today** — the join does not exist.
3. **The flow is serial by construction.** Every review is a status; every status
   has one waiting party. So every requirement you add costs a hop — which is
   why the review model you want would, on the current machine, produce an
   eight-hop workflow people route around.

---

## Direct answers

### "How much unnecessary back-and-forth is there for a low-permission user?"

**Three of six wait states are avoidable without loosening a single control** —
see the hop table in [`02`](./02-friction-latency.md).

- The requester is asked to review a **CAD deliverable** they filed a
  plain-language request about (`FRIC-2`).
- Then to **personally choose an engineer** from a list showing email prefixes
  and an open-ticket count — a routing question requiring more domain knowledge
  than the review they were just judged unqualified to perform (`FRIC-4`).
- Then to come back a second time to **acknowledge and close** (`FRIC-6`).

And the thing that turns a delay into a shoulder-tap: **nothing escalates.** The
SLA clock is set at creation and has **no server-side reader at all** — a
repo-wide search finds none outside the UI and the test file. Queue routing runs
once, at ticket birth, and is never consulted again (`LEAK-1`). So a ticket can
enter a queue nobody was told about and sit past a due date nobody is watching.

### "Drawing packages need to be engineered; like-in-kind can get by with drafting supervisor review; QA/QC needs to review all"

Expressible today: **none of it.**

- No work class exists to hang the distinction on (`TIER-2`).
- **QA/QC has zero presence** — a repo-wide search for `qaqc`, `NDE`,
  `radiograph`, `x-ray`, `hold point`, `B31` returns only test fixtures and
  knowledge-base text (`TIER-3`).
- No code-governed dimension: `policyAllows` takes no resource argument, so
  "B31.3 piping needs a code reviewer" has nowhere to live (`TIER-4`).

**The good news is the shape you described is cheap — if built in the right
order.** `GAP-101` puts the class on the ticket at **triage**, a step that
already exists with the right person in it, so classification costs zero hops.
`GAP-102` gives QA/QC **visibility plus stop-work authority instead of a
signature** — both already built, both costing nothing when unused. `GAP-109`
does the same for engineering review via consent windows and standing
pre-authorization. See **the friction ladder** in the gap register: the question
is never "who reviews this?" but "what is the cheapest mechanism that delivers
the assurance?" — and most requirements that present as reviews turn out to be
data completeness or visibility, which are free.

### "I'm not boxing myself into a new role or extra friction"

Correct instinct, and it goes further than a role: **`DEC-35` forbids any
facility's vocabulary appearing in application code at all.** No `QAQC`, no
`B31.3`, no `NDE`, and no role name as a routing target.

Routing becomes data (`GAP-112`), and nothing needs inventing to hold it:
`org_configurations` already stores your request types, units and priorities with
an admin editor; `resolveEffectiveDocClass` (`lib/docClass.ts:49-58`) is six
lines of document → folder → library resolution to copy exactly; and
`lib/reviewControl.ts` already has the roster mechanics.

Each slot carries a **mode** — `blocking`, `consent_window`, or `notify_only` —
which is the friction ladder made configurable. One facility puts its quality
function on `notify_only` and keeps stop-work authority for free; another makes
it blocking for the engineered lane only. Neither choice is in the code.

This also fixes a defect found independently in the roles area: `isEngineerRole`
matches the **substring** `"Engineer"`, and role identity is unversioned
customer-editable JSON — one rename from matching nothing.

### "Only engineered packages unless the requester declares like-in-kind"

**This is the policy the review model now serves, and an earlier version of this
audit had it backwards.** `GAP-101` used to say the class is set at triage and
that requiring the requester to classify was out of scope. `DEC-33` reverses it,
and the revision is marked inline in the gap register.

Engineering is the **default**. One thing removes it: the requester declaring
like-in-kind at intake, in their own name, with a typed statement (`GAP-110`).
The assigner may add engineering back at any time and may **never** remove it.

Two things make this cheap rather than expensive:

- **The unanswered state is the safe one.** Blank means engineered. Someone who
  does not understand the question is not blocked and not misrouted — and the
  form cannot be gamed by clicking through, because clicking through *is* the
  conservative outcome. This is why it does not reintroduce `UI-5`.
- **The checking party was already there.** A drafting manager sits at
  `PENDING_ASSIGNMENT` on every ticket from every door. Reading a one-line
  declaration while assigning adds **zero waits**.

### "The drafting manager can flag engineering, and then it's required"

**That mechanism is already 80% built**, and its author wrote your model into the
code:

```
// Engineering review is an OPTIONAL branch the assigner triggers via "Flag for
// Engineering Review", never an automatic gate.        — lib/workflow.ts:46-50
```

`request_eng_review` exists at `NEW` and `PENDING_ASSIGNMENT`, requires a comment
and an engineer pick, and persists `assigned_engineer_id`,
`engineer_review_requested_at` and `engineer_review_reason`
(`lib/ticketTransitions.ts:179-189`).

**What it does not do is bind the approval end.** `approve_team` returns the
ticket to assignment carrying nothing, and `PENDING_REVIEW` consults only
`requiresEngineerApproval(ticket.requesterRole)` — so a flagged ticket can still
be self-approved to IFC by a Manager requester. The flag buys a conversation and
no gate. The missing piece is one persisted boolean (`GAP-111`, effort `S`).

**And the gate belongs on delivery, not on drafting.** *"No deliverable without
official approval"* is a condition on the **issue** transitions — which means
drafting starts immediately and the approval roster runs alongside it. Only
issuing waits. That is the same safety outcome as today's pre-drafting scope
review, one wait state cheaper: a drafted package that later needs changing is
what revisions are for; a drafter idle behind a scope note is pure loss.

Two consequences worth stating plainly:

- **`approve_minor_correction` must be inside the gate.** It routes straight to
  `PENDING_IFC` and is offered to every requester, including the one the engineer
  gate just blocked. A delivery gate that misses it is not a gate.
- **"Routed people" is plural and derived.** The flag today carries
  `requiresEngineerPick: true` — the assigner hand-picks one engineer. Flagging
  is a judgement about the work; choosing who reviews is a routing question they
  should not have to answer (`FRIC-4`), and one engineer is not what *"routed
  people"* means. Under `GAP-112` the assigner flags and the router resolves who;
  on a parallel roster N approvers still cost one wait state.

**This is the case where a blocking signature is right**, and the flag is what
makes it countable: a facility should be able to say *"we had N official
approvals last month, all flagged, here is who flagged each and why."* Everything
not flagged advances with nobody in the way. That is the trade.

### "I'm the drafting manager and the QA/QC — but that's not true elsewhere"

`DEC-37`: **one person may satisfy any number of slots.** Independence is a
property of a *slot*, not of a person, and the record shows every slot satisfied
and by whom rather than pretending one did not apply.

The genuine control survives and is narrower than it sounds: the person who
*produced* a deliverable may not be the person who *accepts* it. That is about
one artifact and two acts, not about job titles. It amends `DEC-12`, which a
naive reading would have used to forbid hat-stacking outright.

### "The system has to log it was available to them"

`DEC-38`: **no delivery record, no silent advance.** This is the condition that
makes silence-is-consent defensible rather than reckless, and `GAP-109` must not
ship without `GAP-113`.

The substrate exists and is currently unsafe for the purpose. `notifications`
already stores one row per (recipient, event) with `read_at` — exactly the "it
was available to them, and whether they looked" record. But `notify()` is
documented *"fire-and-forget by design"* and swallows its error
(`lib/inAppNotifications.ts:74-97`). Correct for a bell icon; disqualifying for a
clock. Compounding it, `LEAK-1` means the workflow route never resolves
recipients at all.

`GAP-113` keeps three states apart, because collapsing them discards the most
useful signal you have about whether the window length is right:

| State | Evidence | Reading |
|---|---|---|
| Never delivered | no row | **Blocks.** Not consent. |
| Delivered, unopened | row, `read_at` null | Advances — recorded as *not opened* |
| Opened, no action | row, `read_at` set | Advances — recorded as *seen, no objection* |

And the record lives on the **ticket**, not the bell — evidence cannot sit in a
feed that gets marked read and pruned. A window resolving to zero recipients
never advances: nobody was asked, so nobody declined to object. The
acknowledged-distribution feature already hit that failure mode and named it
`ack_unsatisfiable`.

### "A bidirectional portal to projects"

**The project side is built. The ticket is the only work object it cannot see.**

`CheckoutSession`, `Milestone` and `MarkupRequest` all carry `projectId`
(`types/schema.ts:929`, `:456`, `:1002`), and `ProjectActivity` already has
`doc_added` / `doc_removed` / `markup_requested` in its typed event vocabulary.
`Ticket` carries no `projectId` and no container reference of any kind. Someone
already needed the link and worked around its absence: `lib/transitionIn.ts:304`
writes `metadata.intake_collision.projectId` into untyped JSON.

The trap is in the word *push*. `DEC-40`: **reference, never copy.** A controlled
drawing copied into project storage does not supersede, does not carry a hold,
does not appear in distribution recall, and does not visibly go stale — which is
the failure the whole system exists to prevent, produced by the most natural
reading of the requirement.

The seam to get right is permissions: a project member who cannot read the
library must **see that a deliverable exists and be unable to open it**. Hiding
it reads as "drafting did nothing"; opening it is an egress hole. `GAP-114`.

### "Codes vary by org — B31.3 in my case"

That is right, and it is why `TIER-4` says the code dimension must be
**org-configurable data, not a code branch**. `DEC-13` already commits to adding
the resource dimension to `policyAllows`; this area's contribution is that the
`resource` shape must carry a service/code class, not just
`{requestType, unit, libraryId, discipline}`.

### "Specific drawing types pushed to doc ctrl of that library for review and release"

**Blocked one field earlier than expected.** The ticket has no library
(`DCW-1`), so no library-scoped rule can be evaluated against it.

Beyond that, **Document Control is not a party to the flow at any state**
(`DCW-2`). `DocCtrl` appears in the state machine exactly once — where it causes
the engineering gate to be **skipped**. No status waits on them, no action is
offered to them, no routing reaches them, no capability names them.

And yet `lib/ticketAttention.ts:106` tells them they must act at `FINAL_DRAFT`
and `PENDING_IFC`. They open those tickets and see **"View Only — No Actions
Available"** (`FRIC-7`). Whoever wrote that line believed document control
belongs at issue and release. **They were right; the flow never implemented it.**

`GAP-104` builds it as a **per-library rule on the parallel roster** — not a
status — so libraries that need controlled release get it and nobody else pays.

### "Are there leaks in the flow?"

Nine, in [`04`](./04-flow-leaks.md). The three that matter most:

- **Any RFI-typed ticket can be closed from `DRAFTING` in one click** by any
  drafter in the org, skipping every approval stage. It is gated on an
  unvalidated free-text string (`LEAK-3`).
- **Queue routing runs once and never again** — after creation, transitions
  notify only the requester and drafter (`LEAK-1`).
- **There is no record of work that left the app.** No withdrawn, no duplicate,
  no handled-out-of-band; `CANCELED` is documented to users and unreachable. So
  the bypassing you are worried about is **structurally invisible** — you cannot
  count it or tell whether any fix helped (`LEAK-9`).

### "Is there a weird UI people don't know where to look?"

Yes, and one instance is stark: **the app points document controllers at work
that does not exist** (`UI-3`).

The rest is more ordinary and more fixable — mostly good content in the wrong
place:

- A ticket **never says who it is waiting on**. The plain-English label exists
  and renders only in the notification bell (`UI-1`).
- The **workflow map is genuinely good** and is hidden behind a status pill that
  does not look clickable, on the detail page only — so a first-time requester
  cannot see the process before committing to it (`UI-2`).
- **Submitting an incomplete request does nothing at all** — a bare `return`, no
  message, no field highlight. First contact, least experienced user, no recovery
  path (`UI-5`). Probably the single highest-friction moment in the product.

Steps 1 and 2 of the first-run walkthrough are good. Everything after first
contact assumes knowledge the user does not have.

---

## The one thing to get right

If only one item from this area ships, make it **`GAP-103` — the parallel
reviewer roster** — and make it *first*.

Not because it is the biggest problem, but because it decides whether every other
fix helps or hurts. The review model in `TIER-1`–`TIER-4` implemented on the
current serial machine turns a new-design package into eight hops and six people.
The same model on a parallel roster costs **one** wait state regardless of how
many reviewers it requires.

And it does not need designing: `lib/reviewControl.ts` already has required
primaries and alternates, signatures bound to the content hash, invalidation on
change, timeout-driven alternate activation, and auto-finalize on the last
signature. **It is genuinely good, and the ticket flow cannot see it.**

---

## Method & limits

- The state machine was read in full (`lib/workflow.ts`, 366 lines), along with
  the transition effects, routing, attention, intake form, ticket detail page and
  queue.
- Hop counts were derived by tracing `getActions` for each status against the
  capability defaults in `lib/capabilityPolicy.ts:57-96`, not estimated.
- Absence claims (QA/QC, code review, ticket `libraryId`) are repo-wide searches
  across `app/`, `lib/`, `components/` and `types/`, stated as searches so they
  can be re-run.
- **No live database and no browser.** UI findings are read from the render
  code — component structure, gating conditions and copy — not observed. Where a
  finding depends on how an org has configured itself in practice, it is marked
  `SUSPECTED` and says so (`DCW-5`).
- One correction made during the audit: `attentionLabel` was initially read as
  having zero callers. It has one — `hooks/useTicketNotifications.ts:265`, the
  bell subtitle. `UI-1` is written against the corrected fact.
