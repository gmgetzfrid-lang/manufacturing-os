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
- **Status:** OPEN
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

---

## TIER-8 · Two review systems exist with no shared vocabulary, and "approve" means different things in each

- **Severity:** MEDIUM
- **Status:** OPEN
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
