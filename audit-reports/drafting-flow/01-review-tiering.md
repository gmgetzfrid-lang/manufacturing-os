# 01 · Review tiering — what gets reviewed, by whom, and why

The question this report answers: **can the system say "a like-in-kind swap
needs a drafting-supervisor design review, a new design needs engineering, and
QA/QC reviews everything"?**

It cannot. Not partially — **structurally**. And the one gate that does exist is
pointed the wrong way.

**8 findings** — 2 CRITICAL, 4 HIGH, 2 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol and
> [`../DECISIONS.md`](../DECISIONS.md) for the pre-made calls. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.**

---

## The whole gate, in five lines

Every review decision in the drafting flow reduces to this function:

```ts
// lib/workflow.ts:37-43
export function requiresEngineerApproval(requesterRole?: Role | string): boolean {
  if (!requesterRole) return true;
  if (isEngineerRole(requesterRole)) return false;   // substring "Engineer"
  if (isManagementRole(requesterRole)) return false; // Admin | Manager | Supervisor
  if (isDocCtrlRole(requesterRole)) return false;
  return true;
}
```

**It takes one argument, and that argument is who asked.**

Not what the work is. Not whether a line is being added or a gasket replaced.
Not whether the drawing is code-governed. Not whether anything is being welded.
**Who asked.**

Everything else in this report follows from that.

---

## TIER-1 · The engineering gate keys on the requester's role, not the work — so it is inverted

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / friction
- **Locations:**
  - `lib/workflow.ts:37-43` — the entire gate
  - `lib/workflow.ts:78` — `const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole);`
  - `lib/workflow.ts:200` — `if (needsEngineerApproval && !isEng)` — the fork
  - `lib/roleCapabilities.ts:63-69` — Maintenance, Operations, Safety, HR, Accounting, Contractor all grant exactly `["create_requests"]`
- **Related:** `TIER-2`, `FRIC-1`, `WF-5`, `WF-12` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `requiresEngineerApproval(requesterRole)` takes the requester's role as its **only** argument (`workflow.ts:37-43`) and is called as `requiresEngineerApproval(ticket.requesterRole)` (`:78`). Nothing about the work reaches the decision. Read with `roles-and-permissions/WF-5`: that one input is client-stamped.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and a repo-wide grep shows requiresEngineerApproval has exactly one production call site — nothing else re-imposes an engineering gate. A Manager requester reaching PENDING_REVIEW is offered 'Approve (Issue for Construction)' directly (workflow.ts:213-217), which ticketTransitions.ts:221-225 moves to PENDING_IFC and stamps an issued deliverable_rev, with no second party involved. Nothing about the work reaches the decision. CRITICAL stands.

**Mechanism.** `isManagementRole` returns true for `Admin`, `Manager`,
`Supervisor`. So the gate produces exactly this:

| Who asks | What they ask for | Engineer required? |
|---|---|---|
| Maintenance planner | Like-in-kind gasket swap on a utility line | **YES** |
| Operations tech | Update a valve tag on an existing sheet | **YES** |
| Safety officer | Correct a mislabeled instrument | **YES** |
| **Manager** | **A brand-new pipe rack in a B31.3 service** | **NO — self-approves to IFC** |
| **Supervisor** | **New tie-in on a live process line** | **NO — self-approves to IFC** |
| **DocCtrl** | **Anything at all** | **NO** |

**Failure scenario.** A Manager files a request for a new 6" process line
tie-in. It reaches `PENDING_REVIEW`. `requiresEngineerApproval("Manager")` is
false, so their branch offers **"Approve (Issue for Construction)"** — one
button, no second person, no engineering calculation, no code check. The drawing
is issued for construction. The audit trail shows a legitimate, permitted
approval.

Meanwhile the Maintenance planner replacing a gasket with an identical gasket is
forced to find an engineer, pick them from a list, and wait.

**The two errors are the same error.** The system is asking a question about
*seniority* when the question that matters is *what is being changed*.

**Chain reaction.** `requesterRole` is a snapshot, stamped by the browser at
insert (`app/(protected)/requests/new/page.tsx:309`), never re-derived, and
never compared to `org_members` — see `WF-5` and `WF-12` in the
roles-and-permissions area. So the gate's single input is also forgeable and
goes stale on promotion or demotion. Fixing the *shape* of the gate (this
finding) and fixing the *trust* in its input (`WF-5`) are different work; both
are needed.

**Done when.**
1. The engineering-review requirement is a function of the work being requested,
   not of the requester's role.
2. A new-design request requires engineering review regardless of who filed it —
   including a Manager, a Supervisor and an Admin.
3. A like-in-kind request does not require engineering review regardless of who
   filed it — including a Viewer-tier requester.
4. A test pins both directions.

---

## TIER-2 · There is no work classification at all — like-in-kind and new design are indistinguishable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / compliance
- **Locations:**
  - `types/schema.ts:1019` — `export type RequestType = string;` — open, unvalidated free text
  - `lib/workflow.ts:185` — the **only** place `requestType` affects authority in the entire codebase: `if (ticket.requestType === 'RFI')`
  - `lib/notifications.ts:237-243` — the only other use: an SLA default lookup
  - `types/schema.ts:761` — `changeType?: "Major" | "Minor" | "Correction"` — **exists, but on `DocumentVersion`, not on the ticket**
  - `lib/docClass.ts:28` — `DocClass = "drawing" | "procedure"` — **exists, but on the document, not on the ticket**
- **Related:** `TIER-1`, `TIER-3`, `GAP-101`
- **Re-verified:** hardening pass — **SURVIVES**. `export type RequestType = string;` (`types/schema.ts:1019`) — no union, no enum, no CHECK — and a repo-wide search for `likeInKind`, `work_class` or `scopeTier` returns nothing. There is no field in which a like-in-kind declaration could be recorded, which is the mechanism `DEC-33`/`DEC-34` depend on.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The operative claim holds: no work class drives routing, gating or reporting anywhere. But the re-verification's absolute — 'There is no field in which a like-in-kind declaration could be recorded' — is refuted by the custom-category mechanism: types/schema.ts:1192-1214 defines `CustomFieldDef { type: "select", required?: boolean }` under `OrgDraftingSettings.customCategories`, and requests/new/page.tsx:273-289 validates required custom fields and writes them to `metadata.custom_categories`. An admin can add a required 'Like-in-kind / New design' select today. It is write-only (the only reader repo-wide is the admin editor) and the three programmatic creators bypass it, so this is an enabler gap rather than an exploitable defect — HIGH, not CRITICAL.

**Mechanism.** The ticket carries `request_type` — a free string an org
configures as a dropdown (`app/(protected)/admin/requests/page.tsx:179-195`),
with **no server-side or database validation**, and the three programmatic
creators bypass the dropdown entirely with hardcoded `"Revision"` / `"ASBUILT"`.

That string reaches an authority decision **exactly once**, for `'RFI'`.
Everywhere else it is cosmetic: an SLA default, a pink badge, an "urgent"
heuristic, a filter.

So the question *"is this a like-in-kind replacement or a new design?"* has no
representation. Not a wrong answer — **no field**.

Two adjacent classifications *do* exist and neither is reachable from the ticket:

- **`changeType`** (`Major` / `Minor` / `Correction`) lives on the document
  version and is chosen by the publisher, at publish time, weeks after the
  request was filed.
- **`docClass`** (`drawing` / `procedure`) lives on the document and answers
  "which change process applies" — but only for a document that already exists.
  A new-design request has no document yet.

**Failure scenario.** A drafting supervisor triaging the queue sees "Revision —
Unit 200 — replace relief valve" and has no way to record whether the
replacement is identical-for-identical or a resize. The ticket carries the same
metadata either way, routes identically, and reaches the same reviewer set. The
distinction survives only in the description prose and in whatever the
supervisor remembers.

**Chain reaction.** Every other finding in this report depends on this one. You
cannot route by class, gate by class, or report by class until the class exists.
**`GAP-101` specifies it**, and specifies it as something the *triage step*
confirms rather than something the requester must know — the requester
frequently cannot answer it, and asking them is itself friction (`FRIC-3`).

**Done when.**
1. A ticket carries a declared work class distinguishing at minimum
   like-in-kind from new design.
2. The class is set or confirmed at a step that already exists, not by adding a
   step.
3. `request_type` is validated server-side against the org's configured list
   (`WF-15`), so classification is not keyed to unvalidated free text.

---

## TIER-3 · QA/QC does not exist anywhere in the flow

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / compliance
- **Locations:**
  - A repo-wide search across `lib/`, `app/`, `components/`, `types/` for
- **Re-verified:** hardening pass — **SURVIVES**, and the census locates it precisely. `qaqc`/`QA/QC` appear only in the **projects** quality program — `api/projects/checklist/route.ts`, `lib/turnover.ts`, `lib/checklists.ts`, `components/projects/QualityTab.tsx` — and **0 times** in `lib/workflow.ts`, `lib/ticketTransitions.ts` or `lib/ticketRouting.ts`. The concept is modelled in the product; it is simply not wired to drafting.
    `qaqc`, `qa_qc`, `NDE`, `radiograph`, `x-ray`, `hold point`, `witness point`,
    `B31` returns **zero production hits** — only test fixtures
    (`lib/__tests__/projectControls.test.ts:29`,
    `lib/__tests__/knowledgeText.test.ts:108`) and knowledge-base answer text.
  - `lib/capabilityPolicy.ts:57-96` — 17 capabilities, none QA/QC
  - `lib/workflow.ts:80-342` — 12 statuses, none QA/QC
  - `types/schema.ts` — no inspection, examination or hold-point concept
- **Related:** `TIER-4`, `GAP-102`
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by a repo-wide search, and the finding is already honest that the concept exists in the projects module — it is simply not wired to the drafting ticket flow in any form: no status, no capability, no field, no notification. HIGH stands for a safety-domain absence.

**Mechanism.** The stated requirement is that **QA/QC reviews everything, even
like-in-kind** — because NDE scope, radiography extent and code design factors
apply regardless of whether the change is novel. There is no mechanism for this.
Not a partial one. The concept is absent from the type system, the state
machine, the capability list and the database.

**Failure scenario.** A like-in-kind pipe spool replacement in a B31.3 service
is drafted and issued. Nobody has recorded what NDE applies, whether radiography
is required at the tie-in welds, or that the design factors were checked against
the governing code case. The ticket closes clean. The information exists only in
whatever conversation happened outside the app — which is precisely the
shoulder-tap the system is meant to replace.

**Chain reaction.** ⚠ **The obvious implementation is the wrong one.** Adding a
`QAQC` role and a `PENDING_QAQC` status inserts a serial hop into a flow that is
already too serial (`FRIC-1`), and the stated constraint is explicit: *"I'm not
boxing myself into a new role or extra friction."*

**`GAP-102` specifies the non-serial version:** QA/QC is a **reviewer slot on a
parallel roster**, not a status. The capability layer already supports per-person
grants, so whoever performs QA/QC — often an engineer who already holds the
work — gets the capability rather than a new role. And because the roster is
parallel, adding QA/QC to a like-in-kind review adds **zero wait states**: the
QA/QC reviewer signs concurrently with the design reviewer, not after them.

**Done when.**
1. A QA/QC review requirement can be expressed per library and per work class.
2. Satisfying it does not add a serial status hop.
3. It does not require creating a new role — an existing person can hold it via
   the capability layer.

---

## TIER-4 · No code-governed review dimension — B31.3 and its equivalents are unrepresentable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `lib/capabilityPolicy.ts:141-155` — `policyAllows(policy, cap, role, extraRoles, uid)` — **no resource argument**
  - `lib/reviewControl.ts:126-132` — `expandReviewers` reads `reviewerIds` / `reviewerRoles` / `reviewerTeamIds` only
  - `types/schema.ts:191-210` — `ReviewControl` has no code, discipline or service-class dimension
- **Related:** `TIER-3`, `WF-13`, `GAP-101`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `policyAllows` keys on capability, role tokens and per-person grants (`capabilityPolicy.ts:141-152`); `expandReviewers` keys on ids, roles and teams (`reviewControl.ts:126-131`). Neither carries a code, standard or discipline dimension, so "B31.3 signatory" is unrepresentable except by inventing a role name.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by repo-wide search: a grep for governingCode|governing_code|codeClass|code_class|serviceClass|service_class|B31|API 653 across lib/ app/ types/ components/ supabase/ returns only test fixtures (lib/__tests__/knowledgeText.test.ts:108-120, drawingText.test.ts:434) and prompt strings in app/api/knowledge/ask/route.ts — zero production data model. The only 'discipline' hits are cost-discipline scoring and a document tag column example. There is no dimension in which a governing code could be declared.

**Mechanism.** The requirement is org-specific by nature: *"there's ASME B31.3
in my case, not another organization's case — it could be whatever, that NDE and
x-ray and design factors for codes need to be reviewed."* So the system needs a
**configurable governing-code dimension**, not a hardcoded B31.3 branch.

Nothing supports it. `ReviewControl` expands reviewers from three flat lists.
`policyAllows` takes no resource. There is no place to say "piping in a
B31.3 service requires a reviewer holding the piping-code capability."

**Failure scenario.** An org that runs B31.3 piping and an org that runs API 653
tankage get an identical, code-blind review model. Neither can express its own
governing standard, so both encode it in prose in the request description — where
it is unsearchable, unreportable, and invisible to the reviewer roster.

**Chain reaction.** This is the same missing dimension as `WF-13` /
`GAP-1` in the roles-and-permissions area (per-request-type approval authority),
seen from the compliance side rather than the authority side. **They are one
piece of work.** `DEC-13` already commits to building the resource dimension;
this finding says the `resource` shape must carry a service/code class, not only
`{requestType, unit, libraryId, discipline}`.

**Done when.**
1. An org can declare governing codes and attach a review requirement to one.
2. The declaration is org-configurable data, not a code branch.
3. A ticket in a code-governed service surfaces which code applies, to the
   reviewer, before they sign.

---

## TIER-5 · Review is serial by construction — every requirement added costs a wait state

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** friction
- **Locations:**
  - `lib/workflow.ts:80-342` — the state machine: every transition moves to exactly one status with exactly one actor set
  - `lib/ticketTransitions.ts:140-142` — the recipient set for every action is `[requesterId, assignedDrafterId]`
  - contrast `lib/reviewControl.ts:196-238` — `openReviewRoster` on the **document** side: primaries + alternates, **parallel**, with timeout-driven alternate activation and auto-finalize on the last signature
- **Related:** `TIER-3`, `FRIC-1`, `GAP-103`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The state machine's review stages are distinct sequential cases — `PENDING_ENG_INITIAL` (`workflow.ts:83`), `PENDING_REVIEW` (`:198`) — and no concurrency or fan-out concept exists in the engine. Each added requirement is another state to wait in.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence: there is no fan-out, quorum, or multi-holder concept anywhere in WorkflowEngine.getActions or computeTransition — status is a scalar column and every transition sets it to one value. The ticket engine cannot express two concurrent reviewers, so each added requirement is necessarily another serial state.

**Mechanism.** The ticket flow is a linear status machine. Each review is a
status; each status has one waiting party; the ticket advances when that party
acts. Adding a reviewer therefore **always** means adding a hop.

The document side already solved this. `lib/reviewControl.ts` has a roster with
required primaries and alternates, signatures bound to the draft's
`content_hash`, invalidation when the draft changes, timeout-driven alternate
activation, and auto-finalize when the last required signature lands. **It is
genuinely good, and the ticket flow cannot see it.**

**Failure scenario.** The moment the review model in `TIER-1` through `TIER-4` is
implemented on the current serial machine, a new-design B31.3 package becomes:
triage → drafter → requester review → engineering review → QA/QC review → code
review → IFC → acknowledge. **Eight hops, six people, seven waits.** People will
route around it — which is the outcome this whole audit exists to prevent.

**Chain reaction.** ⚠ **This finding must be resolved before `TIER-1` through
`TIER-4`, not after.** Implementing the correct review *model* on the wrong
review *mechanism* produces a system nobody uses. `GAP-103` specifies reusing the
existing document-side roster on the ticket: one roster, parallel signatures,
auto-advance on completion — so a three-reviewer requirement costs **one** wait
state, not three.

**Done when.**
1. Two required reviewers on the same ticket can sign in either order, or
   simultaneously, without one waiting for the other.
2. The ticket advances automatically when the last required signature lands.
3. Adding a reviewer to a review requirement does not add a status.

**Resolution (2026-10-21, drafting-flow Round G).** DF-P5 ROSTER (base `9bc7884`). Reproduced on the base: `lib/workflow.ts:406` (`case 'PENDING_REVIEW'`) is one waiting party per status, and a requester the gate covers is sent on to a second status (`request_final_engineer_approval`, `:418`, `requiresEngineerPick: true`) — every added reviewer is a hop.

Landed — the review stage of a ticket whose library (folder / document) declares a routing table runs on a PARALLEL roster:
- `supabase/migrations/20261241_df_roundG_routing_control.sql` — `routing_control` on libraries / collections / documents (`20261012`'s doc_class lines), guarded and audited (see `GAP-112`'s Landed line).
- `lib/routingControl.ts` — `resolveRoutingControlChain` / `effectiveRoutingForTicket` (`:183`, `:229`): one resolver on `lib/containerChain.ts`, declared-never-guessed, fail closed.
- `lib/ticketRoster.ts` — `openRoster` (`:343`) turns the table into slots (occupants resolved from the active members, keyset-paged; a blocking slot that resolves to nobody is filled by the management tier, marked `fallback`), `rosterContentHash` (`:203`) binds every sign-off to the sha256 of the files under review, `rosterCompletion` (`:427`) CALLS `lib/reviewControl.ts` `evaluateSlotCompletion` (DC P4's per-slot rule) — nothing forked.
- `lib/workflow.ts` — `currentRoster` (`:202`), `slotSignPlan` (`:229`); `getActions` at `PENDING_REVIEW` with a roster (`:593`) offers every occupant of every open blocking slot `sign_slot` AT ONCE (one action covers every slot the person fills, DEC-37), with the independence constraint named in `disabledReason` when one blocks it.
- `lib/ticketTransitions.ts` — `sign_slot` (`:529`): a sign-off that leaves a slot open writes the roster and a history line and keeps the status; the last blocking sign-off issues the ticket exactly as a direct approval does (`PENDING_IFC`, the issued label, Finals stamped). The roster rides `tickets.metadata.review_roster` on the same compare-and-set as the status, so the slots and the status cannot disagree.
- `app/api/tickets/workflow-action/route.ts` — the roster opens when a draft is SUBMITTED into review in a routed library (`submit_draft` only; `reopen_ticket` takes today's path into `PENDING_REVIEW` and the next submission opens the roster on its new files — DF-P5 fix pass, so a reopen is never refused for a missing or unreadable Draft. *Corrected at the DF-P5 fix pass 3 (DEC-29): "the next submission opens the roster" did not hold, because nothing required a submission — a reopened routed ticket ran the SERIAL `PENDING_REVIEW` case and the requester could approve and issue with no roster. The serial approvals are now refused on a routed ticket with no roster; see "DF-P5 fix pass 3" below.*), sign-offs carry an e-signature minted by `/api/signatures/sign` against the ticket and bound to the roster's hash (`signatureRefusal`, called at `:833`), the ledger (`20261242`) is written after the compare-and-set (`writeRosterLedger`, `:1496`). *(Line anchors re-taken at the DF-P5 fix pass 2 against the branch head.)*
- `components/requests/TicketRosterPanel.tsx` — who must act, who did, who was told; the sign-off ceremony.

DF-P5 fix pass (same day, review findings):
- **Producer-versus-checker floor on every roster** (DEC-12 / DEC-37 acceptance 2), whatever the table declares: above the threshold the drafter may sign slots they occupy but never the one that would complete the review with no blocking slot satisfied by anyone else (`lib/workflow.ts` `slotSignPlan` + `rosterLacksIndependentSignOff`, `PRODUCER_FLOOR_REASON`; `lib/ticketRoster.ts` `rosterCompletion(roster, { sodActive, drafterId })` checks it again at the route).
- **The engineering approval is recorded when a roster completes**: a slot filled by an engineering capability (`ticket.final_approve` / `ticket.eng_review`) is marked `engineering` when the roster opens, and its sign-off sets `engineer_approved_at` on completion (`lib/workflow.ts` `rosterEngineerApprovedAt`, `lib/ticketTransitions.ts` `sign_slot`); a role-named slot is the facility's own word and is not guessed (DEC-35) — the roster is its record.
- **The opening's hashing is bounded** (one deadline and byte budget, `HASH_LIMITS.rosterDeadlineMs`): storage that does not answer refuses the submission (503, nothing written) instead of hanging it.
- **Ledger updates are checked for a row**: a "satisfied" / "voided" update that matches no slot row is a failure (returned as the warning, no event row written) — `lib/ticketRoster.ts` `onceRows`.

DF-P5 fix pass 2 (same day, second review):
- **A routing table adds reviewers; it never drops the org-wide engineering gate** (DEC-13 stage 3 / DEC-16 / DEC-36). Before the fix a library table of one requester slot let a Planner's request reach `PENDING_IFC` with no engineer involved. Now, when the gate applies to the ticket — `lib/workflow.ts` `engineerApprovalRequired` (the requester's snapshot or current collection, under the org's `ticket.engineer_gate_exempt` list) or an engineering-first type — and the table carries no BLOCKING slot filled by an engineering capability, `lib/ticketRoster.ts` `withEngineeringGate` (`:320`, called by `openRoster`) appends the seed's engineering slot: filled by `ticket.final_approve`, the assigned engineer named as a primary when one is on the ticket, independent of the drafter, the management tier as override. The roster records `engineeringGateAdded`, and the history line, the audit row (`reviewRoster.engineeringGateAdded`) and the panel (`ENGINEERING_GATE_NOTE`) all say so. A role-named slot is never guessed to be engineering (DEC-35), so the gate slot is still appended beside it, and one engineer's single sign-off fills both (DEC-37).
- **Library routing is controller-only** (`20261241`'s guard): the library owner / node-manager limb is gone, as the folder and document limbs went at the first fix pass. A drafting lead who owns a library can no longer swap that library's reviewers.
- **A package too large or too slow to fingerprint is no longer refused.** Before, a 240 MB set got "upload it again", which can never help. `lib/ticketRoster.ts` `rosterBinding` (`:231`) now binds such files by identity (storage key and recorded size, `unhashed: <reason>`), and they are named on the panel and in every sign-off statement (`lib/workflow.ts` `unhashedFilesNote`). A storage outage still refuses (503, try again), and so does a file that is not in storage (409, replace it).
- The completing sign-off's audit row names what was approved (`approvedDrafts` from the roster's files, with sha256 or the reason) and, when issued as-is, the Final it recorded (`issuedAsIsFinals`). It is notified as an approval (`classifyTransitionNotification` `rosterCompleted` → `ticket_approved`). `lib/routingControl.ts` `isMissingRoutingSchema` reads "not pasted" only from an error that names `routing_control`; a 42703 for another column fails closed.

DF-P5 fix pass 3 (same day, third review — a ticket's WHOLE review life in a routed library, not only a fresh submission):
- **A close out of a review closes its roster for good.** `computeTransition` closes an open roster on any exit from `PENDING_REVIEW` (closedAt, open slots void), but the route's CLOSED branch rebuilt `metadata` from the stored row for its deliverable note (`noteDeliverableNotInRegister` / `noteDeliverableNotInLibrary`), and a routed ticket always takes one of those branches. A force close therefore stored the roster still open, and `reopen_ticket` brought back the previous cycle's roster with its sign-offs. Every CLOSED branch now builds on the transition's metadata (`app/api/tickets/workflow-action/route.ts`, `closeMeta`).
- **A routed review never runs without a roster.** A ticket in a routed library that is in review with no roster (reopened, or already in review when the table was declared) is not approved on the serial path. `approve_draft_ifc`, `approve_minor_correction`, `request_final_engineer_approval` and `engineer_approve_final` (`lib/workflow.ts` `ROSTERLESS_APPROVALS`) are refused with `409 routing_needs_roster` and the way forward (`ROUTED_NO_ROSTER_REASON`: request a revision, and the resubmission opens the roster). Nothing is written. The route reads the routing only for those approvals on such a ticket (`lib/routingControl.ts` `ticketReviewRouting`: the source document's folder, the chain, then the ledger probe). A read that fails is a 503. Before `20261242` is pasted (no ledger) the usual review stands, as for a submission. The request page asks the same question through RLS, and the engine renders those approvals disabled with the reason (`WorkflowContext.reviewRouted`). Tickets already in review when a table was declared are deliberately NOT left on today's path: they fail closed as well (DEC-36) and go through a revision.
- **A partial sign-off is not a hand-off.** `sign_slot` that leaves the roster open now keeps every open blocking slot's occupants in `unread_by` (with the existing markers and today's participants, never the signer) — `lib/ticketTransitions.ts` — and the route's fan-out retires only the signer's own "please review" alerts (`fanOut` `rosterPartial`), so a reviewer still waited on keeps their alert and is told of the sign-off.

Tests (fix pass 3): `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("major 1: a FORCE CLOSE of a routed ticket under review stores the roster CLOSED …", "major 2: a reopened ticket in a routed library is NOT approved on the serial path …", "major 2 (route): the route resolves the routing itself …" incl. the 503 and the pre-20261242 cases, "REGRESSION: a library with no routing table approves on the serial path exactly as today", "major 3: a PARTIAL sign-off keeps every still-waited-on reviewer unread …", "major 3 (REGRESSION): the COMPLETING sign-off still retires every outstanding alert"); `lib/__tests__/dfRoundG_P5_routing.test.ts` ("DF-P5 fix pass 3 — …", four cases). The major-1 and major-3 route tests fail with the fix reverted (checked).

DF-P5 fix pass 4 (same day, fourth review — the refusal, the editor and the panel say what is true):
- **The refusal reaches the person with its reason.** *Corrected (DEC-29): fix pass 3 said the routed-without-roster refusal reaches the user "with the way forward". It did not. The request page read a 409's body only for `holds_open` and showed every other 409 as "someone else updated it", so `ROUTED_NO_ROSTER_REASON` appeared only when the page's own RLS read agreed with the server.* `app/(protected)/requests/[id]/page.tsx` now passes the body to `lib/workflow.ts` `workflowRefusalMessage`. A 409 that carries its own code (`routing_needs_roster`, `issue_as_is_unconfirmed`, `routing_invalid`, `routing_no_files`, `content_unhashable`, a roster's own codes) is shown with its reason. Only the compare-and-set conflict (`conflict: true`), `holds_open` (handled before) and a code-less 409 keep "someone else updated it".
- **A routing table that cannot be used is named.** `ticketReviewRouting` counts an `invalid` chain as routed, but a revision is refused there too (`routing_invalid` at submit), so "request a revision" was the wrong advice. The route now answers such an approval `409 routing_invalid` with `lib/workflow.ts` `routedNoRosterReason(routing)`, which names the level, the error and the document controller. The page passes the same reason to the engine (`WorkflowContext.reviewRoutedReason`) and to the panel.
- **The panel no longer shows the unconfigured seed on a routed review with no roster.** `components/requests/TicketRosterPanel.tsx` takes `reviewRouted` / `reviewRoutedReason` from the page and renders "No sign-off roster" with the reason instead of `seededSlotsFor`'s serial picture.
- **The routing editor says what a saved table does.** *Corrected (DEC-29): `components/documents/RoutingControlSection.tsx` said "It applies from each request's next submission for review", but since fix pass 3 a saved table immediately stops the serial approvals of every rosterless request already in review under that level.* The save note (`routingSavedNote`) now says so. Declaring a table on a level that had none first counts those requests (`lib/routingControl.ts` `reviewsInFlightUnder`: a library's own; a folder's by its source documents' folders and `path_ids`; a document's own; all through RLS, at most 500 then "at least"). The editor shows the number and asks before saving (`inFlightConfirmMessage`). A count that fails is said, and the editor still asks.
- **A partial sign-off releases the co-occupants of the slot it satisfied.** *Corrected (FRIC-2's audience): fix pass 3 kept every occupant ever added in `unread_by`.* `lib/ticketTransitions.ts` `rosterPartialReleased` names the satisfied slots' primaries, less anyone an open blocking slot still waits on, today's participants and the signer. They leave `unread_by`, and the route retires their action alerts with the signer's (`fanOut` `rosterReleased`). So that sign-off notices do not pile up, an earlier partial sign-off's notice (`metadata.action = sign_slot`) is retired for anyone this one tells again; their "review opened" alert stays live.

Tests (fix pass 4): `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("DF-P5 fix pass 4 — a refusal reaches the user with its reason …": the route's 409 `routing_needs_roster` body through `workflowRefusalMessage` gives `ROUTED_NO_ROSTER_REASON`, and the conflict / `holds_open` / code-less bodies keep the old message; the `routing_invalid` reason; "major 3: a PARTIAL sign-off …" now pins e-2 released and the alerts not piling up; "DF-P5 fix pass 4 (major 2) — the routing editor counts …", library / folder / sub-folder / document and the failed read); `lib/__tests__/dfRoundG_P5_routing.test.ts` ("DF-P5 fix pass 4 — after a partial sign-off …", two cases); `lib/__tests__/dfRoundG_P5_rosterPanel.test.ts` ("DF-P5 fix pass 4 — …", five cases: the page's 409 branch, the panel's routed-without-roster state rendered, the page's props, the save note, the confirm before the write).

Tests (fix pass 2): `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("DF-P5 fix pass 2 — a routing table adds reviewers; it never drops the org-wide engineering gate …", five cases incl. "the reviewer's scenario …"; "a routed package over the request's byte budget is NOT refused …"; "EVID-12 done-when 3 on a roster …"; "DEC-36: a 42703 naming ANOTHER column …"; "before 20261242 (the ledger missing: PGRST205) …", now with postgrest-js's real HEAD behaviour in the stand-in); `lib/__tests__/dfRoundG_P5_routing.test.ts` ("withEngineeringGate …", "… bound by identity, not refused …"); `lib/__tests__/rls/dfP5RosterRouting.test.ts` ("DF-P5 fix pass 2: the library's OWNER cannot set or clear the library's routing …").

Tests: `lib/__tests__/dfRoundG_P5_routing.test.ts` ("TIER-5 done-when 1…", "completion CALLS … evaluateSlotCompletion", "TIER-5 done-when 3…", "TIER-5 done-when 2…", "DF-P5 fix — DEC-12 / DEC-37 acceptance 2 …", "DF-P5 fix — a completed roster records the engineering approval …", the ledger writer's 0-row case); `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("TIER-5: the first sign-off keeps the status (one wait); the second — in either order — issues the ticket automatically", "REGRESSION: reopening a closed ticket in a routed library with NO Draft …", "a table with no independent_of: the drafter's sign-off is refused …").

**Done-when.**
- ✓ (1) Two required reviewers sign in either order, or at the same time: each is offered their slot while the other's is open, and two concurrent sign-offs are serialised by the ticket's compare-and-set (the loser's 409 is retried once by the panel on the fresh row) — neither waits for the other.
- ✓ (2) The ticket advances automatically when the last required signature lands (`PENDING_IFC`, or `FINAL_DRAFT` when the drafter marked it issue-ready — `FRIC-5`).
- ✓ (3) Adding a reviewer adds no status: a two- or three-slot roster is one `PENDING_REVIEW`.
- These hold for a ticket's whole review life in a routed library, not only a fresh submission (fix pass 3). A close voids the roster, a reopen cannot revive it, a rosterless review cannot be approved serially, and a partial sign-off leaves the remaining reviewers told and alerted. *(The fix pass 2 claim "holds on routed libraries" was overstated for reopened tickets — DEC-29.)* Since fix pass 4 the refusal reaches the person with its reason (on the page's 409 path, not only when the page's own read agrees), a broken table names the document controller, and the routing editor counts and asks before a table stops the requests already in review. *(Fix pass 3's "with the way forward" was overstated until then — DEC-29.)*

**Pending migration:** `20261241_df_roundG_routing_control.sql` and `20261242_df_roundG_ticket_roster.sql` (DEC-30 — the code half is what is RESOLVED; until both are pasted every ticket takes today's path: a `routing_control` read answers 42703 / PGRST204 naming that column → unconfigured, a missing ledger answers 42P01 / PGRST205 → the submission goes the usual way and says so). Either paste first in SQL, but **paste `20261242` before (or together with) `20261241`**. *(Corrected at the DF-P5 fix pass 4, DEC-29: with `20261241` pasted and `20261242` not, a submission into a routed library goes the usual way with a warning, and pasting `20261242` afterwards makes that ticket routed with no roster, so its serial approvals are refused and it needs a revision. Pasting `20261242` first leaves no such ticket.)* *(Corrected at the DF-P5 fix pass 2: the ledger probe was a HEAD request, and postgrest-js maps PostgREST's body-less 404 for a missing table to success, so with 20261241 pasted and 20261242 not yet a roster opened anyway and every ledger write failed. The probe is now a GET (`.select("id").limit(1)`), which carries the PGRST205 body; the route test's stand-in reproduces postgrest-js's real HEAD behaviour. DEC-29.)* Both exercised on PostgreSQL 16 (`lib/__tests__/rls/dfP5RosterRouting.test.ts`, 13 cases, incl. the library owner refused (fix pass 2)).

**Scope / residual.** An org that has configured no routing table keeps today's serial machine byte-for-byte — DEC-90 ruling (2) for this package. A routed library changes who reviews and in what order, but never removes the org-wide engineering gate (fix pass 2, above); the seed (`SEEDED_ROUTING`) only describes it and is pinned against the engine. The ticket shed (`lib/ticketShed.ts`, DF-P11's) archives a ticket's row and deletes it, and the roster ledger cascades with it (`20261242`, `ON DELETE CASCADE`, as `ticket_comments` does); the archive bundle carries `metadata.review_roster` (the row), not the ledger rows — **for the integrator**: whether the shed bundle should carry `ticket_review_slots` / `ticket_review_slot_events` too (owner: the next package holding `lib/ticketShed.ts`). The attention badge (`hooks/useTicketNotifications.ts`, N11's) badges a slot occupant when its mapper carries `metadata` (the engine derives `sign_slot` from the ticket alone).

---

## TIER-6 · MOC is captured at check-in and re-typed at publish, with no link between them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / safety
- **Locations:**
  - `lib/checkinOutcomes.ts:87-93` — `mocRequirementFor`, the check-in gate
  - `components/documents/CheckInPanel.tsx:224-229,264` — MOC written into ticket `metadata.moc`
  - `components/documents/RevUpModal.tsx:214-217` — the publish-side gate, **independently recomputed**
  - `components/documents/RevUpModal.tsx:739` — the input, labelled *"Optional ticket # from change platform"*
  - `lib/revisions.ts:522` — `moc_reference: mocReference?.trim() || null`
- **Related:** `LIFE-5` (roles-and-permissions area — same defect, recorded there in full)
- **Re-verified:** hardening pass — **SURVIVES**. `mocRequirementFor` derives the requirement at check-in from doc class and outcome (`checkinOutcomes.ts:87-93`), and `CheckInPanel.tsx:224-229` renders a hand-typed `mocNumber` into a text line. Nothing carries either value to publish.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The headline defect is real — MOC is captured at check-in, never carried forward, and no version-to-ticket link exists — but two supporting claims are wrong. (1) The report says the publish gate 'asks for the number again as free text, described in the UI as optional, for a field the gate makes mandatory'; the optional-labelled input is explicitly suppressed when the gate is mandatory, so the free remediation it proposes ('relabel the input') is a no-op. (2) The 'laundering' scenario understates the surviving record: CheckInPanel.tsx:243 sets `priority: undocumented ? 1 : 2`, :266 stamps `undocumented_change: true`, and :291-305 pushes a 'PSM alert: undocumented field change' notification to every org controller. Downgrade to MEDIUM.

**Mechanism.** Two MOC gates exist and they do not speak. The check-in gate
**requires** an MOC position for a drawing-class discrepancy and deliberately
allows "no MOC exists" as a flagged answer. The publish gate recomputes the
requirement from scratch and asks for the number again as free text — described
in the UI as *optional*, for a field the gate makes mandatory.

**Failure scenario.** A field report states "No MOC exists" — correctly and
honestly — and the system flags it as an undocumented change. Weeks later the
as-built is published and the publisher types an MOC number they happen to
remember. **The undocumented-change finding is laundered into a documented one**,
and the only record contradicting it sits on a closed ticket nothing links to
the version.

**Chain reaction.** Recorded in full as `LIFE-5` in the roles-and-permissions
area; repeated here because it is a **review-tiering** defect as much as a
lifecycle one: MOC applicability is exactly the kind of per-work-class rule this
report says is missing, and it is the one instance where the system half-built
it. The free, dependency-free part of the fix is relabelling the RevUpModal input
so it stops calling a mandatory field optional.

**Done when.** See `LIFE-5`. Additionally: MOC applicability is expressed through
the same work-class mechanism as every other review requirement, rather than as
its own parallel rule.

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. The `LIFE-5` half is closed (roles-and-permissions [`LIFE-5`](../roles-and-permissions/07-document-lifecycle.md), Round C2, `a84f712`): the hand-back reads the check-in's MOC position — `mocOriginOf(metadata)` (`lib/ticketHandback.ts:45-52`) — and carries it into `RevUpModal` as `presetMocOrigin` (`app/(protected)/requests/[id]/page.tsx:1656`); a captured number prefills the reference (`components/documents/RevUpModal.tsx:188`) and says where it came from, and a recorded "no MOC" cannot silently acquire one (`:318-325`, an explicit acknowledgement logged into the change log). `related_ticket_id` (`20261049`) makes `moc_reference` reconcilable to `tickets.metadata.moc`.

**Done-when.**
- ✓ See `LIFE-5` (its three done-whens are checked on that record).
- ✗ "Additionally: MOC applicability is expressed through the same work-class mechanism as every other review requirement" — no work-class mechanism exists yet. MOC applicability is still its own rule: `mocRequirementFor` at check-in (`lib/checkinOutcomes.ts`) and `mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike` at publish (`RevUpModal`).

**Scope / residual.** Express MOC applicability through the work-class mechanism → **DF-P6** (`GAP-101` work class, then the review model keyed off it). The fleet plan expected this to close by pointer to LIFE-5; its "additionally" clause cannot hold before `GAP-101` lands.

---

## TIER-7 · "Approve with Minor Correction" is the only tiering the system actually has, and it bypasses the gate

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety
- **Locations:**
  - `lib/workflow.ts:219-228` — offered unconditionally, with the comment *"Available to every requester tier by design."*
  - `lib/ticketTransitions.ts:221-237` — identical terminal effect to `approve_draft_ifc`
- **Related:** `WF-3` (roles-and-permissions area — recorded there in full), `TIER-1`
- **Re-verified:** hardening pass — **SURVIVES**, and the two transitions are byte-identical in effect. `approve_draft_ifc` sets `PENDING_IFC` + `deliverable_rev = issuedRevLabel(ticket.revisionCount)` (`ticketTransitions.ts:221-224`); `approve_minor_correction` sets exactly the same two fields (`:230-232`). The only tiering the system has is the one that skips the gate.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and slightly worse than stated: the same action is also offered at PENDING_FINAL_APPROVAL (workflow.ts:277) where it produces PENDING_IFC WITHOUT setting `engineer_approved_at`, which the sibling `engineer_approve_final` does set (ticketTransitions.ts:246-248). So the fast path also drops the engineering-sign-off timestamp. The server route enforces getActions (workflow-action/route.ts:96-103), so the bypass is real, not merely a UI affordance.

**Mechanism.** The one place the system *does* express "this change is small
enough to need less review" is a button that produces the **identical** terminal
state as full approval — `PENDING_IFC` with the draft letter stripped off the
deliverable rev — and is offered to every requester tier including those the
engineering gate just blocked.

So the honest reading is: the app already believes in tiered review. It just
implements it as a bypass rather than as a policy.

**Chain reaction.** `WF-3` covers the security side and must be fixed with
`WF-14`. What this finding adds: **do not simply delete the fast path.** The
instinct behind it is correct and matches the stated requirement — a typo
correction genuinely should not need an engineering cycle. It should become a
*declared minor correction under the work-class model* (`GAP-101`), which routes
to the reduced reviewer set, rather than a button that skips the reviewer set.

**Done when.** A minor correction is a work class with its own reviewer
requirement, not an unconditional button that bypasses whatever requirement
applied.

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. The *bypass* half is closed by roles-and-permissions [`WF-3`](../roles-and-permissions/06-request-workflow.md) + `WF-14` (`087a39c`) — see [`AUTHZ-1`](./09-authority-surfaces.md#authz-1): `approve_minor_correction` is offered only to actors who could approve directly (`lib/workflow.ts:390-410`, `:415-443`, `:455-480`), the engineer-routed requester gets only `request_final_engineer_approval` (`:376-389`), and at `PENDING_FINAL_APPROVAL` the fast path stamps `engineer_approved_at` (`lib/ticketTransitions.ts:298`). What this finding asks for is not built: a minor correction is still a button, not a declared class — `lib/ticketTransitions.ts:292-297` gives it the same terminal effect as `approve_draft_ifc` (`PENDING_IFC`, `issuedRevLabel(...)`), and no work-class field exists on `Ticket` to hang a reduced reviewer set on.

**Done-when.**
- ✗ A minor correction is a work class with its own reviewer requirement — not done. The precondition (`GAP-101` work class, set at triage, and `GAP-111`'s binding engineering flag) is DF-P6's.

**Scope / residual.** Handed on, binding (fleet plan): the "declared minor-correction class inside the delivery gate" → **DF-P6** (Phase 4 item 7, after `GAP-101`/`GAP-111`/`TIER-1`). Per 99-fix-sequencing "Do not do these": do not delete the fast path — convert it.

---

## TIER-8 · Two review systems exist with no shared vocabulary, and "approve" means different things in each

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** process / compliance
- **Locations:**
  - Ticket side: `lib/workflow.ts:198-298`, `app/api/tickets/workflow-action/route.ts:91-132` — a role/identity state machine; approval is a status transition plus a history entry. **No signature. No content binding.**
  - Document side: `lib/reviewControl.ts:193-256`, `:283-320` — a reviewer roster with **e-signatures bound to the draft's `content_hash`**, invalidation on change, alternate activation, auto-finalize
  - The only declared bridge: `lib/reviewControl.ts:60` — dead, and a trap (`LIFE-2`)
- **Related:** `LIFE-12`, `LIFE-2`, `TIER-5`
- **Re-verified:** hardening pass — **SURVIVES**. The ticket engine's `approve_*` actions (`workflow.ts:198-228`) and the document `reviewControl` sign-off share no vocabulary, no state and no data path; the server enforcement at `workflow-action/route.ts:91-102` knows only the ticket side.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on every limb: the ticket approve_* actions write only status + a history entry (ticketTransitions.ts:114-147, 221-248) with no signature and no content hash, the server gate at workflow-action/route.ts:96-103 knows only WorkflowEngine.getActions, and the one declared bridge is dead code reachable only from a unit test.

**Mechanism.** An engineer who approves a drafting deliverable on the ticket has
**not** signed anything on the document. When the resulting revision is
published into a library with a required-review roster naming them, they are
asked to review the same drawing again — this time with an e-signature ceremony.

**Failure scenario.** The engineer either signs twice (two approval records for
one change, different timestamps, no link) or dismisses the second as a duplicate
and blocks the publish. Either way the reviewer concludes the app is wasting
their time — the precise sentiment that produces shoulder-tapping.

**Chain reaction.** ⚠ This is why `LIFE-2`'s dead `related_ticket_id` waiver is
so tempting: it *looks* like the bridge. It is not, and `DEC-23` deletes it. The
correct reconciliation is narrow — a ticket approval may satisfy a document
sign-off **only** when the approver is on that document's roster **and** the
approval was bound to the same content hash. Everything needed to check that
exists (`document_review_signoffs.content_hash`, `recordSignature`,
`expandReviewers`); nothing composes them.

`TIER-5`'s recommendation — put the ticket's review on the document-side roster —
collapses this finding entirely, because then there is only one review system.

**Done when.** A reviewer is asked to review a given artifact once, or is shown
plainly why a second review is a different question.

**Resolution (2026-10-21, drafting-flow Round G).** DF-P5 ROSTER. Reproduced on the base: a ticket approval wrote a status and a history line only — no signature, no content binding (`app/api/tickets/workflow-action/route.ts`, the approving actions; `fileIdentity` carried the storage ETag, `:133`).

Landed — the ticket's routed review speaks the document side's vocabulary: every sign-off is an e-signature (`e_signatures`, minted by `/api/signatures/sign`, `resource_type: "ticket"`) bound to a server-computed sha256 over the files under review (`lib/ticketRoster.ts` `rosterContentHash`, `signatureRefusal` `:456`: this ticket, the signer's own, the roster's hash, given after it opened, used once), and completion is the document roster's own per-slot rule (`evaluateSlotCompletion`, called). A file too large or too slow to fingerprint in the request is bound by its identity (storage key and recorded size), and every sign-off statement names it as such (DF-P5 fix pass 2: `rosterBinding`, `TicketRosterPanel.tsx` `rosterSignStatement`). The statement never claims a content binding it does not have. The roster panel says plainly what the ticket sign-off is and why a publish review is a different question (`components/requests/TicketRosterPanel.tsx` `TWO_REVIEWS_NOTE`, rendered with the roster and whenever the request's library has a publish review policy).

DF-P5 fix pass 3 — no signature attests a review that satisfied nothing. The panel used to mint the e-signature before the route decided, so a refused sign-off left an orphan "Reviewed" signature on the ticket. Refusal causes: someone else completed the roster first, an independence rule, or the producer floor. Now:
- The panel asks the route first. `sign_slot` with `dryRun: true` answers whether the sign-off is open to the caller, with no signature needed and nothing written; any other action sent with `dryRun` is refused (400). The ceremony opens only on that yes (`TicketRosterPanel.tsx` `openCeremony`).
- A refusal that still arrives with a signature (a race) is recorded beside it. `TICKET_SIGN_SLOT_NOT_APPLIED` names the signature and the reason, with `details.attempt: null` so the trail's attempt pairing leaves it alone (`route.ts` `recordRefusedSignOff`). This covers the route's own sign-off refusals and the "not available at this status" refusal, which is what the roster completing under the signer looks like. *Corrected at the DF-P5 fix pass 4 (DEC-29): as first landed the row named any UUID the client sent, after only a shape check, so a member could write a row calling another person's signature, or another ticket's or org's, "not applied". The route now reads the signature (or uses the row it already read) and records it only when it is the caller's own (`signer_user_id`), on this ticket (`resource_type = 'ticket'`, `resource_id`) in this org; anything else writes nothing. Pinned by "minor 4: a refused sign-off records … only for the caller's OWN signature …" in `dfRoundG_P5_rosterRoute.test.ts` (another person's, another ticket's, another org's, a non-ticket signature, an id with no signature, and both refusal branches).*
- The signed statement names the signer by their membership display name (RG-9), as `SignatureCaptureHost` does, never by email (`page.tsx`, the panel's `userName`).

Tests: `lib/__tests__/dfRoundG_P5_routing.test.ts` ("EVID-12: a sign-off's signature must be …"); `lib/__tests__/dfRoundG_P5_rosterPanel.test.ts` ("… TIER-8, said plainly"; fix pass 3: "the Sign off button asks the route first …", "the panel's signer name is the member's display name …"); `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` (fix pass 3: "TIER-8: a dry run answers …", "TIER-8: a sign-off refused after its signature was minted … records the orphan …").

**Done-when.**
- ✓ "A reviewer is asked to review a given artifact once, **or is shown plainly why a second review is a different question**" — the second limb: the panel states that signing the ticket approves the drafting deliverable (the exact files, by hash) and that publishing it as a revision is the library's own review (is this revision ready to be current?), asked once, at publish.

**Pending migration:** `20261241_df_roundG_routing_control.sql` and `20261242_df_roundG_ticket_roster.sql` (DEC-30 — the code half is what is RESOLVED; until both are pasted every ticket takes today's path: a `routing_control` read answers 42703 / PGRST204 naming that column → unconfigured, a missing ledger answers 42P01 / PGRST205 → the submission goes the usual way and says so). Either paste first in SQL, but **paste `20261242` before (or together with) `20261241`**. *(Corrected at the DF-P5 fix pass 4, DEC-29: with `20261241` pasted and `20261242` not, a submission into a routed library goes the usual way with a warning, and pasting `20261242` afterwards makes that ticket routed with no roster, so its serial approvals are refused and it needs a revision. Pasting `20261242` first leaves no such ticket.)* *(Corrected at the DF-P5 fix pass 2: the ledger probe was a HEAD request, and postgrest-js maps PostgREST's body-less 404 for a missing table to success, so with 20261241 pasted and 20261242 not yet a roster opened anyway and every ledger write failed. The probe is now a GET (`.select("id").limit(1)`), which carries the PGRST205 body; the route test's stand-in reproduces postgrest-js's real HEAD behaviour. DEC-29.)* Both exercised on PostgreSQL 16 (`lib/__tests__/rls/dfP5RosterRouting.test.ts`, 13 cases, incl. the library owner refused (fix pass 2)).

**Scope / residual.** The first limb — a ticket sign-off SATISFYING the document's publish roster for the same bytes (`GAP-103` acceptance 4) — is not built here: it is R&P `LIFE-12`'s (the plan's alreadyResolvedElsewhere), and `DEC-23` forbids the shortcut (no waiver; only a signature bound to the same content hash on that document's roster may count). The ticket side now records exactly the evidence that bridge needs (`ticket_review_slots.signature_id`, `content_hash`).

---

## What the target model looks like

Not a spec — `GAP-101`, `GAP-102` and `GAP-103` carry those. This is the shape
the eight findings above point at, recorded so the intent is not lost.

**One classification, set at a step that already exists:**

| Work class | Design review | Engineering review | QA/QC | Doc Ctrl release |
|---|---|---|---|---|
| Minor correction | — | — | per library | per library |
| Like-in-kind | Drafting Supervisor | — | **always** | per library |
| New design | Drafting Supervisor | **required** | **always** | per library |
| Code-governed service | Drafting Supervisor | **required**, code named | **always**, NDE scope named | per library |

**Three properties that make it not-friction:**

1. **The requester never classifies.** They describe the work. Triage — a step
   that already exists and already has the right person in it — sets or confirms
   the class in the same click as assignment. Zero added hops (`FRIC-3`).
2. **Reviews run in parallel, on one roster.** Three required reviewers cost one
   wait, not three (`TIER-5`, `GAP-103`).
3. **Nobody gets a new role.** QA/QC and code review are *capabilities* held by
   people who already exist, granted per-person with an expiry through the
   existing grant mechanism (`TIER-3`, `GAP-102`).

---

## Verified sound — do not break

1. **`lib/reviewControl.ts` — the document-side review roster.** Primaries and
   alternates expanded from people, roles and teams; signatures bound to
   `content_hash`; a new draft voids prior sign-offs and tells the earlier
   signers why; an empty primary roster escalates rather than silently blocking;
   the last signature auto-finalizes with the database re-checking completion
   transactionally. **This is the mechanism the ticket flow should adopt, not
   replace.**
2. **`lib/docClass.ts` — fail-closed class resolution.** A *transient* failure
   throws rather than returning null, because "we couldn't check" must never read
   as "no class declared" — that is exactly how a PSM gate quietly turns itself
   off. Resolution mirrors `review_control` (document → folder → library, most
   specific defined level wins), so a controller declares once per library and
   everything inherits. **That inheritance pattern is the right one for work
   class and for doc-control release routing too.**
3. **`lib/checkinOutcomes.ts` — the outcome decision engine.** Pure,
   exhaustively unit-tested, and the honesty invariants are real: every
   claim-creating branch demands a typed note, the MOC gate is class-and-change
   scoped, and **"no MOC exists" is never blocked** — reporting an undocumented
   change is deliberately frictionless. Deriving 2–4 cards from purpose + class +
   authority instead of showing a menu is the best anti-friction decision in the
   codebase.
4. **Identity rights are non-configurable** (`lib/workflow.ts:69-75`). A ticket's
   requester, drafter or engineer can never be locked out of their own ticket by
   a policy edit. Whatever review model replaces the current one must keep this.
5. **The deliverable-rev scheme** (`lib/ticketTransitions.ts:88-107`) —
   `1A → 1B → 1 → 2A → 2`, correctly reset on each revision request. The pure
   functions are sound and unit-frozen.

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
