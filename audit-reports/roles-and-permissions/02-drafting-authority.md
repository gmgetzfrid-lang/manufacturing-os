# 02 · Drafting authority & routing

Who may approve what in the request workflow, and whether requests can be
triaged before they reach a drafter.

**5 findings** — 1 CRITICAL, 3 HIGH, 1 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Line numbers
> drift — **match on the quoted code.**

---

## The workflow as built

```
NEW ──► PENDING_ASSIGNMENT ──► DRAFTING ──► PENDING_REVIEW ──► PENDING_IFC ──► CLOSED
          │  (triage)             ▲              │
          │                       └── REVISION_REQ
          └─► PENDING_ENG_INITIAL / PENDING_ENG_TEAM   (optional, assigner-triggered)
                                                  └─► PENDING_FINAL_APPROVAL
```

Authority comes from three sources, in this order:

1. **Identity** — the ticket's requester, assigned drafter, and assigned
   engineer always keep their own-ticket actions. Not configurable, by design,
   and that is the right call.
2. **Capability policy** — 12 `ticket.*` capabilities, org-configurable, with
   per-person grants.
3. **The `ticket.manage` override** — Admin / Manager / Supervisor by default,
   able to co-approve at any stage.

The server re-derives actions from the org's real policy in the workflow-action
route, so a tampered client changes nothing. **That part is solid.**

---

## DRAFT-1 · Authority cannot vary by request type

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / governance
- **Locations:**
  - `lib/capabilityPolicy.ts:141-153` — `policyAllows(policy, cap, role, extraRoles, uid)` — **no type parameter**
  - `lib/workflow.ts:65` — `const allows = (cap) => policyAllows(policy, cap, userRole, null, userId)`
  - `types/schema.ts:1019` — `export type RequestType = string;`
  - `lib/capabilityPolicy.ts:63-65` — `ticket.eng_review` defaults to `["Engineer"]`
- **Related:** `ROLE-2`
- **Re-verified:** hardening pass — **SURVIVES**. `capabilityPolicy.ts` contains no reference to request type in any form, so there is no dimension along which authority could vary. Compounded by `drafting-flow/TIER-2` — `RequestType` is an unconstrained `string`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. requestType is read exactly once in the whole state machine and only to add an action, never to gate one: lib/workflow.ts:185 `if (ticket.requestType === 'RFI')`. The per-person `grants` escape hatch (capabilityPolicy.ts:98-101) is documented as 'ADDITIVE ONLY', so it cannot narrow authority by discipline either.

**Mechanism.** The authority evaluator takes a capability, a role, extra roles
and a uid. The ticket's `type` never enters the decision. `RequestType` is an
open string — org-configurable, never constrained — and it is used for
categorization and display only.

So `ticket.eng_review` is a single global switch: whoever holds it can complete
an engineering review on **every** request, whatever its discipline or risk.

**Failure scenario.** This is the gap you named. A civil engineer holding
`Engineer-2` can sign off the engineering review on a pressure-envelope
modification to a PSM-covered vessel. Nothing in the model — not the tier
(`ROLE-2`), not the capability, not the policy — can express "electrical
requests are approved by electrical engineers." The reviewer sees an Approve
button and the audit log will record a valid, authorized approval.

**Remediation.** Two shapes, and they compose.

**A — scope the capability by type (smaller change).** Extend the policy value
from `string[]` to allow a per-type override:

```ts
caps: {
  "ticket.eng_review": {
    default: ["Engineer"],
    byType: { "Electrical": ["team:electrical-engineers"], "Pressure Envelope": ["uid:..."] }
  }
}
```

`policyAllows` gains an optional `type` argument; callers already have the
ticket in hand. Absent a `byType` entry the default applies, so existing orgs
see no change — the same compatibility contract the layer already honours.

**B — make request types first-class (better long-term).** Today a type is a
free string. Give types a row: an id, a label, a required-reviewer capability, a
default assignee group, and whether MOC applies. Then "who approves this" is a
property of the type, editable by an admin, and the same table can drive the
intake form and the triage queue.

Either way, **allow subject tokens to name teams and users**, not just roles —
`team:electrical` is the natural way to say what you want, and teams are already
evaluated correctly (see `ROLE-1`).

**Done when.**
- An org can specify that a named request type requires a reviewer from a named group.
- A reviewer outside that group sees no Approve action, and the server refuses the transition.
- The default policy reproduces today's behaviour exactly for orgs that configure nothing.
- A test pins the refusal server-side, not just the hidden button.

---

## DRAFT-2 · Triage-first routing works, but the request type cannot influence it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** process
- **Locations:**
  - `lib/workflow.ts:46-53` — `getInitialStatus: (_type: RequestType, _requesterRole: Role): TicketStatus => 'PENDING_ASSIGNMENT'`
  - `lib/ticketRouting.ts:1-18` — the routing module's stated model
  - `lib/ticketRouting.ts:43-56` — `getRoutingConfig`, `adminsAlsoReceiveWhenSupervisorSet`
- **Related:** `DRAFT-1`, `DRAFT-4`
- **Re-verified:** hardening pass — **SURVIVES**. `getInitialStatus: (_type: RequestType, _requesterRole: Role)` — **both parameters are underscore-prefixed as unused** — and the body returns the constant `'PENDING_ASSIGNMENT'` (`workflow.ts:47-52`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the signature exists but the type is discarded, so no request type can pre-route to engineering or shorten the ceremony for a trivial fix. Notably ticketRouting.ts:79 `const byRole = (r: Role) => members.filter((m) => m.role === r)` also matches the mirrored primary role only, so an additive DraftingSupervisor is never notified — a second, unreported defect in the same file.

**Mechanism.** Both parameters are underscore-prefixed and unused. Every request
— every type, from every role — lands in `PENDING_ASSIGNMENT`, and routing
targets the `DraftingSupervisor` if one is set, falling back to Admins.

**This is the behaviour you asked for**, and it is deliberate: the comment states
that engineering review is *"an OPTIONAL branch the assigner triggers via 'Flag
for Engineering Review', never an automatic gate."* Nothing needs building for
the triage-first shape.

**Failure scenario.** What is missing is the ability for a type to *change* the
route. A "New Equipment Datasheet" and a "Fix a typo on an as-built" enter the
same queue with the same ceremony, and a type that should always get engineering
eyes before assignment cannot say so. The signature is there for exactly this —
it was written to take a type and a role — and then ignored.

**Remediation.** Once request types are first-class (`DRAFT-1` option B), let a
type declare its entry status and whether engineering review is mandatory
rather than optional. Keep `PENDING_ASSIGNMENT` as the default so the
triage-first default is preserved. If types stay free strings, delete the two
dead parameters so the signature stops implying a capability that does not
exist.

**Done when.**
- Either the parameters influence the initial status, or they are gone.
- A type can be marked "always route through engineering first" without code changes.

---

## DRAFT-3 · The engineer-approval requirement is decided from the requester's primary role only

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Round D1 — with `WF-12` / `DEC-16`; the stamp side landed in Round C1 / `ADD-3`).** The decision reads the collection at both ends. At filing, `requester_role` is stamped by relevance (`relevantRequesterRole`): an engineer tier held anywhere wins, then management / DocCtrl, then the headline — so an engineer whose headline is Manager is never forced through a redundant review. At evaluation, `engineerApprovalRequired(snapshot, currentRoles)` disjoins the stamped snapshot with the requester's CURRENT collection (looked up by the route on every action) and requires an engineer if either says so. The evaluation moment is documented: the stamp is a snapshot kept as the historical record; the current collection is consulted at every evaluation; the pair can only fail closed. On the first scenario — a `["Supervisor","Drafter"]` member approving "their own returned draft": the collection genuinely holds Supervisor, so management approval is theirs by design; what stops a producer checking their own deliverable is separation of duties (`GAP-2` / `DEC-12`, `DEC-37`: the assigned drafter cannot approve, and a requester cannot self-assign), which is slot-based and unaffected by which hats the person wears.
- Done-when: (1) ✓ Drafter-alongside-Supervisor cannot approve a draft they produced (slot independence); (2) ✓ an engineer who is also a manager is not forced through a redundant review; (3) ✓ the evaluation moment is documented and consistent (snapshot at filing ∨ current at evaluation).
- Files: `lib/workflow.ts`, `lib/roleCapabilities.ts`, `types/schema.ts`, `app/api/tickets/workflow-action/route.ts`, `app/(protected)/requests/[id]/page.tsx`. Tests: `lib/__tests__/sweepRoundD1.test.ts`, `lib/__tests__/sweepRoundC.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** safety / governance
- **Locations:**
  - `lib/workflow.ts:36-42` — `requiresEngineerApproval(requesterRole?: Role | string)`
  - `lib/workflow.ts:78` — `const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole)`
  - `lib/workflow.ts:22-24` — `isManagementRole`, exact string equality
- **Related:** `ADD-1`
- **Re-verified:** hardening pass — **SURVIVES**. `requiresEngineerApproval(requesterRole)` takes one argument and returns on role alone (`workflow.ts:37-42`), called as `requiresEngineerApproval(ticket.requesterRole)` (`:78`). Same mechanism as `WF-12` and `drafting-flow/TIER-1`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and it is a frozen snapshot as well as primary-only: a requester holding ["Requester","Engineer-1"] resolves to Engineer-1 (rank 61 > 40), so requiresEngineerApproval returns false and lib/workflow.ts:212-217 gives them 'Approve (Issue for Construction)' on their own request with no engineer in the loop. HIGH stands.

**Mechanism.**

```ts
export function requiresEngineerApproval(requesterRole?: Role | string): boolean {
  if (!requesterRole) return true;
  if (isEngineerRole(requesterRole)) return false;
  if (isManagementRole(requesterRole)) return false;
  if (isDocCtrlRole(requesterRole)) return false;
  return true;
}
```

`ticket.requesterRole` is a single string, stamped at creation from the
requester's *primary* role.

**Failure scenario — the gate opening when it should stay shut.** A member holds
`["Supervisor", "Drafter"]`. `primaryRole` is `Supervisor` (rank 80). They file a
request and, because `isManagementRole("Supervisor")` is true, the workflow
decides no engineer is needed — so they can approve their own returned draft to
IFC. The module's own comment says drafters approving their own work as
requester is *"a separate antipattern"* it means to exclude; the additive model
routes around that exclusion.

**Failure scenario — the gate closing when it should open.** The mirror case: an
engineer whose primary role is `Manager` (rank 90 > 61) files a request. They
*are* an engineer, but `isEngineerRole("Manager")` is false, so the workflow
inserts an engineering-review round they did not need.

Compounding: the stamped role is a **snapshot**. A requester promoted or
demoted after filing keeps whatever their role was that day, and there is no
re-evaluation.

**Remediation.** Pass the requester's full role collection into the decision
(`requiresEngineerApproval(roles: Role[])`), and store the collection on the
ticket rather than one string. Decide explicitly whether the requirement is
evaluated at file time or at approval time, and say which in the ticket record —
a snapshot is defensible, an accidental snapshot is not.

**Done when.**
- Holding `Drafter` alongside `Supervisor` does not let someone approve their own draft.
- An engineer who is also a manager is not forced through a redundant review.
- The evaluation moment is documented and consistent.

---

## DRAFT-4 · Triage can reject, but the reason is not captured as data

- **Severity:** HIGH
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Blast radius:** process / your stated goal
- **Locations:**
  - `lib/workflow.ts:83-92` — the `NEW` / `PENDING_ENG_INITIAL` action set
  - `lib/capabilityPolicy.ts:60-62` — `ticket.initial_review` defaults to `[...MGMT, "Engineer"]`
  - `lib/capabilityPolicy.ts:66-68` — `ticket.assign` defaults to `[...MGMT, "DraftingSupervisor"]`
- **Related:** `DRAFT-2`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `ticket.initial_review` is described as *"approve / flag / reject"* (`capabilityPolicy.ts:61-62`), and no rejection-reason field exists on `tickets` — the reason survives only as free text in `history`.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). False as stated: the reason is captured as an enumerated `category` field, is mandatory on reject, and is tallied and drilled into in analytics (even preserved across archiving via `archive_summary.revisionCategories`, :228-234). The residual, much smaller critique the finding could have made is that the seven categories are a hardcoded const in a page file rather than org-configurable, and are revision-flavored rather than a 'we don't/can't do that' triage vocabulary — that is a wording gap, not 'not captured as data'.

**Mechanism.** The initial-review stage offers approve / flag-for-engineering /
reject. Rejection takes a free-text comment (`requiresComment`), which is
recorded on the ticket thread.

**Failure scenario.** Your stated goal is *"so people don't ask for stupid
nonsense we don't or can't do."* Achieving that needs the rejection to
**teach** — a taxonomy the requester sees and the org can count. Free text
cannot:

- Nobody can answer "how many requests did we reject as out-of-scope last
  quarter, and for what?"
- The requester learns from one sentence written by a busy supervisor, with no
  standard wording and no link to a policy.
- The same nonsense request comes back next month with no memory of the first
  rejection.

Related: `ticket.initial_review` defaults to management **plus every Engineer**,
so an engineer can approve a request into the assignment queue without the
drafting supervisor ever seeing it — which partly bypasses the triage gate you
want to be mandatory.

**Remediation.**
1. Add a reason code to rejection at initial review — *out of scope*, *duplicate*,
   *insufficient information*, *not technically feasible*, *wrong channel* — with
   the free text kept as a note alongside it.
2. Surface the codes back to the requester with standard guidance per code, and
   count them in the metrics that already exist.
3. Decide whether `ticket.initial_review` should default to
   `[...MGMT, "DraftingSupervisor"]` rather than including all engineers, so
   triage genuinely funnels through the drafting manager. That is a one-line
   default change, and the policy layer makes it configurable per org either way.

**Done when.**
- A rejected request carries a structured reason.
- The reason is visible to the requester with guidance.
- Rejection reasons are countable in the request metrics.
- Triage authority matches the intended funnel.

---

## DRAFT-5 · Drafter self-assignment can bypass the assignment queue

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** process
- **Locations:**
  - `lib/capabilityPolicy.ts:69-70` — `ticket.self_assign` defaults to `["Drafter"]`
  - `lib/capabilityPolicy.ts:66-68` — `ticket.assign` defaults to `[...MGMT, "DraftingSupervisor"]`
- **Re-verified:** hardening pass — **SURVIVES**. `ticket.self_assign` defaults to `["Drafter"]` while `ticket.assign` defaults to management plus `DraftingSupervisor` (`capabilityPolicy.ts:66-69`), so a drafter can take work the assignment queue never routed.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. Since getInitialStatus (workflow.ts:52) drops every new request straight into PENDING_ASSIGNMENT, self_assign is available from the moment a ticket is created, before any assigner has looked at it. Mitigating: it is policy-configurable (an admin can empty the token list) and non-critical, which is consistent with MEDIUM.

**Mechanism.** Two capabilities reach the same outcome. `ticket.assign` runs the
queue; `ticket.self_assign` lets a drafter pick up unassigned work directly.

**Failure scenario.** If the intent is that the drafting manager assigns work —
so load, priority and skill match are decided deliberately — then
`ticket.self_assign` is a hole in that intent, and it is on by default for every
drafter. A drafter can cherry-pick easy tickets out of the queue before the
manager has triaged them.

Whether this is a defect depends entirely on how you want the shop to run. It is
worth deciding explicitly rather than inheriting.

**Remediation.** If assignment should be centralized, default
`ticket.self_assign` to `[]` and let orgs that prefer a pull model widen it.
Either way, document which model the default represents. If both should coexist,
consider gating self-assign on the ticket already having passed triage.

**Done when.**
- The default reflects the intended shop model.
- Self-assignment, where allowed, cannot precede triage.

---

## Verified sound — do not "fix" these

- **Identity rights are non-configurable and that is correct.** A ticket's
  requester, assigned drafter and assigned engineer always keep their own-ticket
  actions regardless of policy. This is stated as a design contract at
  `lib/capabilityPolicy.ts:16-18` and honoured in `lib/workflow.ts:71-72`.
- **The server is the enforcement point.** The workflow-action route re-derives
  the action set from the org's real policy, so hiding a button is a UX
  nicety rather than the control.
- **Critical capabilities cannot lock you out.** `validateCapabilityPolicy`
  refuses to save a policy that removes `Admin` from a critical capability, with
  a message explaining why.
- **Policy changes are fully audited** with before/after —
  `CAPABILITY_POLICY_CHANGED` at `lib/capabilityPolicy.ts:238-247`. For a
  permission model this is the single most important log line, and it is there.
- **Routing degrades sensibly.** No `DraftingSupervisor` set falls back to
  Admins, with an org toggle for whether Admins keep receiving once one exists.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| DRAFT-1 | CRITICAL | OPEN |
| DRAFT-2 | HIGH | OPEN |
| DRAFT-3 | HIGH | OPEN |
| DRAFT-4 | HIGH | OPEN |
| DRAFT-5 | MEDIUM | OPEN |
