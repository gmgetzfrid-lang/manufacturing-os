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

**40 findings** — 7 CRITICAL, 20 HIGH, 13 MEDIUM — plus **8 gap specs**, all
buildable.

| # | Report | Findings | Focus |
|---|---|---|---|
| 01 | [Review tiering](./01-review-tiering.md) | 8 | Like-in-kind vs new design vs QA/QC vs code-governed — and why none of it can be expressed |
| 02 | [Friction & latency](./02-friction-latency.md) | 9 | The hop model: who waits, how long, and which waits are load-bearing |
| 03 | [Document control wiring](./03-doc-control-wiring.md) | 7 | Routing drawings to the library's document controller for review and release |
| 04 | [Flow leaks](./04-flow-leaks.md) | 9 | Where work, state and attention escape without saying so |
| 05 | [Discoverability](./05-ui-discoverability.md) | 7 | Can a first-time user work this without studying it? |
| 90 | [**Gap register**](./90-gap-register.md) | 8 specs | What has to be built. `GAP-101`+ so they never collide with the other area |
| 99 | [**Execution order**](./99-fix-sequencing.md) | — | Binding. The keystone build, and what must not ship before it |

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
`GAP-102` makes QA/QC a **capability plus a reviewer slot** — no new role, and
because the roster is parallel, requiring QA/QC on like-in-kind adds **zero
wait states**.

### "I'm not boxing myself into a new role or extra friction"

Correct instinct, and the mechanisms to honour it already exist. Per-person
capability grants with expiry are built (`lib/capabilityPolicy.ts:98-110`); teams
are built and correctly additive. **The answer to "should I add a QA/QC role?" is
no** — grant the capability to whoever already does the work.

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
