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
- **Status:** RESOLVED
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

**Resolution (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL. Reproduced on the base: `lib/workflow.ts` `getActions` — `const needsEngineerApproval = engineerApprovalRequired(ticket.requesterRole, ctx?.requesterRoles, policy, ticket.requesterId, ticketResource(ticket));` — the requester's roles were the only input.

Landed:
- **The requirement is a property of the request.** `tickets.engineering_required` (`20261250`) is true for every request filed from the paste on unless its requester declared the work like-in-kind at intake, in their own words, signed (`GAP-110`, `DEC-34`). `lib/reviewModel.ts` `ticketEngineeringRequired`: true → required; false WITH a declaration → not required; otherwise (before the paste the column is undefined; a pre-paste row the backfill left false) the legacy gate, evaluated live exactly as today (DEC-90 ruling (2)).
- **One gate for every issue transition.** `lib/workflow.ts` `engineeringGateRequired` (`:133`) replaces the role test at `getActions` (`:533`) and in the roster's engineering slot (`app/api/tickets/workflow-action/route.ts` `engineeringGate.required`, `components/requests/TicketRosterPanel.tsx`): `approve_draft_ifc`, `approve_minor_correction`, `engineer_approve_final` / the override and the roster's completing sign-off are all decided by it (`submit_final` is reached only through one of them). Drafting is never gated.
- **The backfill keeps every in-flight request in its lane** (DEC-90 ruling (2)): existing rows land `false` (the legacy gate decides, live, exactly as today); the paste sets `true` only where the legacy gate is CERTAIN to require an engineer whatever happens next (no requester role, no requester, a requester no longer active, or the shipped default exempt list with no stored list or grant and neither the stamped nor the current roles holding an exempt role) — the counts-only inventory's predicate, word for word (pinned). A requester demoted after filing is still routed to an engineer (DEC-16), because the `false` rows keep the live test.

Tests: `lib/__tests__/reviewModel.test.ts` ("TIER-1 / DEC-33 …" — an undeclared request filed by a Manager, an Admin, a Supervisor or DocCtrl cannot be issued by its requester; a declared one is approved by a Viewer / Maintenance requester straight to IFC; "REGRESSION (DEC-90 rulings (2) and (8)) …" — per transition, the same actors are offered each issue transition whether the column is absent or left false, for every role); `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` ("TIER-1 / DEC-33 — the gate reads the work, at the route", both directions and both REGRESSION cases); the backfill against `engineerApprovalRequired` on PostgreSQL 16 (`rls/dfP6ReviewModel.test.ts` "THE BACKFILL …").

**Pending migration:** `supabase/migrations/20261250_df_roundG_review_model.sql` (DEC-30 one paste; not a widening — it narrows: the declaration is immutable and `engineering_required` never clears for any caller). **Order: deploy the DF-P6 app FIRST, then paste `20261250`.** Before the paste every request takes today's path (a 42703 / PGRST204 naming one of its columns reads as "not pasted": the engine's `engineeringRequired` is undefined and the legacy role-based gate decides; a declaration is signed but filed the usual way and the answer says so). The reverse order would leave a window in which the old app files requests that the column's new default (true) later reclassifies — the one order in which a request filed in the gap would change lane on deploy. `20261251_df_roundG_ticket_equipment.sql` is independent of both (paste it before or after; the app says the equipment was not recorded until it is there). Both exercised on PostgreSQL 16 (`lib/__tests__/rls/dfP6ReviewModel.test.ts`, 11 cases *(corrected at the fourth review fix pass, DEC-29: this said 10; 11 run and pass)*, each file applied twice) and shape-pinned (`lib/__tests__/dfRoundG_P6_reviewModelMigration.test.ts`, the guard lineDiff against its newest body `20261221`).

**Done-when.**
- ✓ 1. The engineering-review requirement is a function of the work requested (the declaration, the assigner's flag, an engineering work / code class), not of the requester's role — for every request filed after the paste. *Read with DEC-90 ruling (2): a request filed before it keeps the role-based answer it had.*
- ✓ 2. A new-design (undeclared) request requires engineering review regardless of who filed it — Manager, Supervisor, Admin and DocCtrl pinned.
- ✓ 3. A like-in-kind (declared) request does not require engineering review regardless of who filed it — a Viewer-tier requester pinned.
- ✓ 4. Tests pin both directions (engine and route).

**Scope / residual.** The legacy gate is quarantined as the seed (`DEC-35` pattern), not deleted: it decides only for requests the column cannot speak for. No in-flight request changes lane. `WF-5`'s trust half was DF-P1's.

**Fix pass (2026-10-21, drafting-flow Round G — DF-P6 review).** The review found done-when 2 met for whoever files the request but not binding on the requester, and a dead end for a manager with no engineer to pick. Both closed, and only where the column says engineering is required (a request the column cannot speak for keeps today's path exactly):
- **The requirement binds the requester** (DEC-33: only the requester, by declaring, lowers the rigor). In a workspace of 3+ (DEC-12) where an engineer can be picked, the requester's own override of the engineering sign-off — `override_engineer_final` and the management minor correction at `PENDING_FINAL_APPROVAL` — renders disabled with `SELF_OVERRIDE_REASON` (`lib/workflow.ts`) and the route refuses it (403). Another manager's override stands (SM-3). *(Superseded at the fourth review fix pass, DEC-29: this removed an override a legitimate manager uses today, against DEC-90 ruling (3) as given. The requester's own override now stands in every workspace size, with a required comment, recorded as an override — see fix pass 4.)* The `PENDING_REVIEW` co-review override is never the requester's (the requester takes the requester branch).
- **No dead end.** A requester who holds `ticket.manage` is offered the recorded override at `PENDING_REVIEW` — `approve_draft_ifc` marked `engineeringOverride` ("Override: Issue Without Engineer Sign-off"; the history note, `authority.override`, and the new `metadata.engineering_override` marker) — below the DEC-12 threshold, or when nobody can be picked as the engineer. "Send for Engineer Final Approval" is then rendered disabled with the reason (`NO_ENGINEER_TO_PICK_REASON`). Whether anyone can be picked is read by the route and by the request page under one rule (`lib/workflow.ts` `engineerPickQuestionApplies`; `lib/reviewModel.ts` `engineerPickAvailable` over `lib/ticketPage.ts` `engineerCandidates`, less the requester, the drafter and the picker in orgs of 3+).
- **A declaration stands only on its e-signature.** The route evaluates a declared row whose signature is not on record (a restored or hand-written row; a backup carries no `e_signatures`) as undeclared, and the audit row says so (`declarationUnverified`).

Tests: `lib/__tests__/reviewModel.test.ts` "fix pass (review, issues 1 and 2) — the requester's own override of the engineering sign-off" (a two-member workspace with no engineer; 3+ with nobody to pick; 3+ with an engineer — disabled; another manager — offered); `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass (review) — the requester's own override, at the route (issues 1 and 2)" and "fix pass (review, minor 11) — a declaration stands only on its e-signature". The REGRESSION pin now compares with the base engine itself (a snapshot generated once from `7893129`, `lib/__tests__/dfP6EngineBase7893129.golden.json`, over requester role × status × engineer assigned × member count × actor role × identity — only SM-3's rename differs). Done-when 2 now holds for the requester too: ✓.

**Fix pass 2 (2026-10-21, drafting-flow Round G — DF-P6 second review).** *Correction (DEC-29): the fix pass above said its limbs apply "only where the column says engineering is required", so the legacy path is unchanged apart from SM-3's rename. That was overstated: the `20261250` backfill writes `engineering_required = true` onto pre-paste rows the legacy gate is certain about (every row with no role stamped, every requester no longer active, every non-exempt requester), so after the paste those in-flight rows took the requester-binding limbs — a requester who is now a Manager lost the enabled final-approval override they have today (DEC-90 ruling (2)). The golden snapshot covered only the column absent, so it did not catch it.* Landed:
- **"Filed under the review model" is its own fact.** `tickets.review_model_filed` (`20261250`): added `DEFAULT false` (every pre-paste row) and then `SET DEFAULT true` (every row filed after the paste) — the `engineering_required` pattern; never changed by anyone (`ticket_update_guard`'s every-caller limb, ahead of the service-role return; the insert guard sets it true for a client insert). `lib/reviewModel.ts` `reviewModelBinds` (filed AND required) now keys the three requester-binding limbs — `selfOverrideBlocked`, the requester's recorded override at `PENDING_REVIEW` and `engineerPickQuestionApplies` (`lib/workflow.ts`). The gate itself (`engineeringGateRequired`) still reads `engineering_required`: a backfilled row is required exactly where the legacy gate requires it today.
- **The requirement's facts in the audit row** now include `reviewModelFiled`.
- **The member count is checked** (review major 2): `app/api/tickets/workflow-action/route.ts` destructures the count's error; an issuing approval or an override is refused 503 `member_count_unreadable` (nothing written), and any other action is evaluated with separation of duties ACTIVE and its audit row carries `memberCountUnchecked: true` — a failed read never opens the requester's own override.
- **The engineering-first loop on a declared request** (review minor 7): `request_eng_review` sent as the type's MANDATORY engineering-first loop (`lib/ticketTransitions.ts` `TransitionInput.engineeringFirstLoop`, set by the route when the type is engineering-first and the review has not happened yet) does not raise a DECLARED request's `engineering_required` — the loop is the type's, not a finding that the work is engineered, and DEC-90 ruling (8) says no added wait for a declared request. Every other `request_eng_review` still ratchets. *For the integrator to confirm (the brief says `request_eng_review` ratchets).*

Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 2 (review, issue 1) …" (GOLDEN: every base-snapshot entry whose legacy gate requires an engineer, evaluated with `engineeringRequired` true and `reviewModelFiled` false, is the base's list — only SM-3's rename differs; the reviewer's case: a no-role legacy row whose requester is now a Manager keeps the enabled override and minor correction, the same request filed under the model is disabled; the pick question and the `PENDING_REVIEW` override do not apply to a legacy row) and "… minor 7 …"; `lib/__tests__/helpers/dfP6EngineMatrix.ts` takes extra ticket fields (the snapshot itself unchanged); `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass 2 (review, issue 1) — at the route …", "… major 2 — the active-member count is checked …", "… minor 7 …"; `lib/__tests__/dfRoundG_P6_reviewModelMigration.test.ts` (the guard lineDiff now names the `review_model_filed` limb; the column's add-then-default; eight tolerated columns); `lib/__tests__/rls/dfP6ReviewModel.test.ts` on PostgreSQL 16 — 11 cases, passed (every pre-paste row `review_model_filed` false, the backfilled ones included; a row filed after the paste true; refused for every caller).

**Done-when (after fix pass 2).** Unchanged: ✓ 1–4. DEC-90 ruling (2) ("no in-flight request changes lane") now holds after the paste too: a pre-paste row keeps its requester's paths whatever the backfill wrote (pinned against the base engine). *(Corrected at fix pass 3, DEC-29: overstated. It held for what the backfill wrote, not for what a later transition wrote — `request_eng_review` still raised `engineering_required` on a pre-paste row, the engineering-first type's mandatory loop included, so a pre-paste Manager's request sent for a scope review lost today's direct approval at `PENDING_REVIEW` and got no override in its place. See fix pass 3.)*

**Scope / residual (fix pass 2).** For the integrator: DEC-33 as applied (the requester-manager's own override refused in orgs of 3+ on a request filed under the review model) and DEC-90 ruling (3) ("do not remove an override path a legitimate manager uses today") pull against each other for NEW tickets; the package keeps DEC-33's reading for requests filed after the paste only — rule explicitly. A restored pre-paste backup lands `review_model_filed = true` by default (fail-safe, binding): the restore should write `false` for rows from a backup without the column (admin-and-org hand-off, 99-fix-sequencing).

**Fix pass 3 (2026-10-21, drafting-flow Round G — DF-P6 third review).** Landed:
- **A scope review on a pre-paste row binds nothing.** `lib/ticketTransitions.ts` `computeTransition` `request_eng_review` writes `engineering_required = true` only when the ticket was FILED under the review model (`ticket.reviewModelFiled === true`); the declared engineering-first exemption (fix pass 2, minor 7) is kept. A pre-paste row's scope review — optional, or the engineering-first type's mandatory loop — now behaves exactly as it does at `7893129`; `flag_engineering` stays the explicit way to bind a legacy row. The audit row still carries the facts (`engineeringRequired`, `likeInKindDeclared`, `reviewModelFiled`).
- **Said before the click** (review minors): "Flag for Engineering Review" says, where it binds (a request filed under the model, not yet required, not a declared request's engineering-first loop — `lib/workflow.ts` `FLAG_ENG_REVIEW_BINDS_DESCRIPTION`), that the request will then need an engineer's sign-off before it issues and that this cannot be withdrawn; a co-reviewer's approval at `PENDING_REVIEW` that the route records as an override is labelled and described as one ("Override: Approve Without Engineer Sign-off" / "Override: Approve with Minor Correction", warning variant — `CO_REVIEW_OVERRIDE_NOTE`), as the `PENDING_FINAL_APPROVAL` override already was (`SM-3` fix pass 3).

Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 3 (review, major) — request_eng_review on a pre-paste row never moves an in-flight ticket's lane" (GOLDEN: a pre-paste row — `engineeringRequired` false, `reviewModelFiled` false, Manager requester — taken through `request_eng_review` → `approve_team` → `assign` → `submit_draft`; at `PENDING_REVIEW` every actor role × identity × member count is offered the `7893129` snapshot's list, `flag_engineering` the only addition, and the Manager keeps the direct approval; the same chain filed under the model binds) and "fix pass 3 (review, minors) — an override and a binding flag are SAID before the click"; `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass 3 (review, major): on a pre-paste row … request_eng_review … writes NO engineering_required" (the engineering-first loop and the optional review alike; `flag_engineering` still binds). Mutation-checked: with the `reviewModelFiled` condition removed, the golden chain test fails.

**Done-when (after fix pass 3).** ✓ 1–4. DEC-90 ruling (2) holds after the paste for every pre-paste row on what the backfill writes (fix pass 2's golden) and on what a scope review writes (fix pass 3's golden chain); the one transition that still binds a pre-paste row is the explicit `flag_engineering`, which says so before the click.

**Scope / residual (fix pass 3).** Unchanged from fix pass 2, except that the DEC-33 / DEC-90 ruling (3) question on NEW tickets is now a named, proposed ruling — DEC-90's DF-P6 line, R1 — and **the merge of DF-P6 is gated on it** (the code ships the proposed reading; the integrator rules and records the ruling in DEC-90 before merging, or applies R1's stated default: drop `selfOverrideBlocked`'s requester limb and record the self-override as an override with a required comment).

**Fix pass 4 (2026-10-21, drafting-flow Round G — DF-P6 fourth review).** *Correction (DEC-29): the record above marked TIER-1 RESOLVED while the code shipped a proposed ruling (R1) against DEC-90 ruling (3) as given — in a workspace of 3+ a Manager who filed a new undeclared request lost the management override at `PENDING_FINAL_APPROVAL` that works at `7893129` (an unavailable engineer left the request with no way to issue). Ruling (3)'s default is the given ruling.* Landed:
- **R1's default, which is ruling (3) as given.** `lib/workflow.ts`: `selfOverrideBlocked` and `SELF_OVERRIDE_REASON` are gone. On a request filed under the review model that requires engineering, the requester holding `ticket.manage` is offered the override in every workspace size — at `PENDING_REVIEW` ("Override: Issue Without Engineer Sign-off", `approve_draft_ifc` marked `engineeringOverride`) and at `PENDING_FINAL_APPROVAL` (`override_engineer_final` and the management minor correction) — with `requiresComment: true` and `SELF_OVERRIDE_NOTE` in its description ("You asked for this work: say why in the comment — it is recorded with the override."). It is recorded as an override: the history note, `metadata.engineering_override`, and the audit row's `authority.override`, whose reason now says when the actor is the request's requester (`app/api/tickets/workflow-action/route.ts`). The requester is still never offered a plain approval of an undeclared request (DEC-33 — only the declaration lowers the rigor). A pre-paste row keeps today's paths exactly (no comment required there — the golden pins are unchanged).
- **A signature read that fails no longer forces "required"** (review minor 3). The route used to set `engineeringRequired = true` in memory for an unreadable e-signature, so a `request_eng_review` in that moment wrote `engineering_required = true` for good and the declaration was lost over a read error; an issuing approval answered 403 "not available". Now only a signature KNOWN not to stand (`"missing"`) is evaluated as undeclared; for `"unchecked"` every action the declaration decides (`DECLARATION_DECIDES`: the issuing approvals, `sign_slot`, `request_eng_review`, `flag_engineering`) answers 503 `declaration_unreadable`, nothing written.
- **The request page evaluates the ticket the route evaluates** (review minor 6). `components/requests/DeclarationCard.tsx` reports its e-signature check (`onDeclarationCheck`); the page applies `lib/reviewModel.ts` `ticketAsDeclarationChecked` before `getActions` and the engineer-pick question, so a declared row whose signature is missing no longer shows the Viewer requester "Approve (IFC)" that the route refuses.
- **Deploy order stated once** (review minor 4): the `20261250` header now says deploy the DF-P6 app first, then paste, and what a paste-first window does (requests the old app files there land `review_model_filed = true`, `engineering_required = true`, and change lane when the DF-P6 app deploys). The same wording is in 99-fix-sequencing's paste notes for the integrator's `MIGRATION-PASTE-ORDER.md` row.

Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 4 (review, major 2 — DEC-90 ruling (3) as given) …" (the requester's override enabled, comment required, said, recorded, in a workspace of 5; another manager's needs no comment), the rewritten "an UNDECLARED request … never offered a plain approval …", "the reviewer's case … filed under the review model" (enabled with a comment), and "fix pass 4 (review, minor 6) …" (`ticketAsDeclarationChecked`; the page and the card pinned by source); `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass 4 (review, major 2 …)" (403 → taken with a comment at both statuses; 400 without), "fix pass 4 (review, minor 3)" (an e-signature read error answers 503 for an approval and for a declared engineering-first ticket's `request_eng_review` and `flag_engineering`, nothing written; once the read answers, the loop runs and leaves `engineering_required` alone).

**Done-when (after fix pass 4).** ✓ 1–4, unchanged. DEC-90 ruling (2) unchanged (pre-paste rows pinned against `7893129`). DEC-90 ruling (3) now holds for new requests too: no override a legitimate manager uses today is removed; the requester's own is recorded, with their comment.

**Scope / residual (fix pass 4).** The merge is no longer gated on R1 (DEC-90's DF-P6 fourth-pass line). R2, R3 and R4 remain proposed rulings, not given (FRIC-2, FRIC-4 stay Partial). Deploy the DF-P6 app first, then paste `20261250`. A restored pre-`20261250` backup lands `review_model_filed = true` (admin-and-org hand-off, unchanged).

**Fix pass 5 (2026-10-21, drafting-flow Round G — DF-P6 fifth review).** Landed:
- **The file viewer's green "Approve" never runs an override** (review major). `app/(protected)/requests/[id]/page.tsx` FileViewerModal `onApprove` took any enabled `approve_draft_ifc` — since DF-P6 that includes a co-reviewer's override at `PENDING_REVIEW` on a request that requires engineering (no comment, so it ran at once) and the requester-manager's recorded override. It now takes only `a.action === 'approve_draft_ifc' && !a.disabledReason && !a.engineeringOverride`; an override is taken only from its own labelled button ("Override: …", fix pass 3).
- **A neutral final issue says "not required"** (review minor). `lib/ticketTransitions.ts`: a management issue at `PENDING_FINAL_APPROVAL` of a request that does not require engineering (`withoutEngineerSignOff` — `override_engineer_final` and the minor correction) writes `metadata.engineering_sign_off = { notRequired: true, by, uid, at, action }`; an override, an engineer's sign-off or any later plain issue clears it (null). `lib/reviewModel.ts` `engineeringSignOffNotRequiredOf` reads it (an engineer's stamp after it is the latest word); the Engineer Reviewer card shows a grey dot and "Engineering sign-off not required — issued by …" instead of the pulsing "pending" (the seeded roster already said "not required"). *At the DF-P6 merge (the integrator, the independent review of fix pass 5, minor): the mark was written only when the issue landed in `PENDING_IFC`; an issue the drafter had marked issue-as-is lands straight in `FINAL_DRAFT` (`asIsIssue`), so it showed "pending" forever and did not clear a standing override. The block now runs for an issue landing in `PENDING_IFC`, or in `FINAL_DRAFT` from any status but `PENDING_IFC` (the drafter's own final submission is not an issue and keeps every mark) — pinned in `reviewModel.ts` tests. Recorded as intended too: the evidence pack's "Engineer approved" column (`lib/evidencePack.ts`) shows "—" for a request management issued at final approval (override or neutral), where it used to show a date attributed to an engineer who did not sign (SM-3).*
- **`flag_engineering` on a pre-paste row never leaves its manager requester with no way to issue** (review minor). `lib/workflow.ts` `requesterBindingApplies`: the requester-binding limbs (the recorded override with its comment, the engineer-pick question) apply on a review-model row (`reviewModelBinds`) AND on a pre-paste row whose column says required while today's role-based gate says not — a requirement raised after the paste (the assigner's flag, an engineering class). The backfill sets true only where that gate requires an engineer, so a backfilled row keeps today's paths exactly while that gate still requires one (the golden comparisons are unchanged). *Corrected at the DF-P6 merge (DEC-29, the independent review of fix pass 5): if the gate later stops requiring one — the requester promoted or reactivated, or an exempt list or grant stored — the row stays required (fail-safe) and the requester-binding limbs apply to it too: at final approval the requester's own override then needs a comment, and at `PENDING_REVIEW` a management requester gains the optional recorded override. Closer to base than before fix pass 5; the gate is not weakened.* Used by `getActions` (`selfOverride`, the `PENDING_REVIEW` override) and `engineerPickQuestionApplies` (so the route and the page compute `engineerPickAvailable` and the override is the way forward when nobody can be picked).
- **The roster panel's seed reads the checked declaration** (review minor). The page passes `ticketAsDeclarationChecked(ticket, declarationCheck)` to `TicketRosterPanel`, as it does to `getActions`.
- **The backfill writes exactly the rows the inventory counts** (review minor, DEC-30). `20261250`'s backfill `UPDATE` carries the inventory's scope (`t.archived_at IS NULL AND t.status NOT IN ('CLOSED', 'CANCELED')`); a closed or canceled row is never written and fires no guard; a row reopened later, left false, is gated live by the legacy gate exactly as today. Predicate unchanged (still pinned word for word).

Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 5 (review, major) — the file viewer's green \"Approve\" never runs an engineering override" (source pin + the reviewer's case), "fix pass 5 (review, minor) — a neutral final issue says 'not required' …" (the mark written, read, cleared; the card pinned by source), "fix pass 5 (review, minor) — flag_engineering on a pre-paste row …" (the 2-member workspace: override offered, comment required, non-optional with nobody to pick; a backfilled row untouched), "fix pass 5 (review, minor) — the roster panel's seed reads the checked declaration …"; the fix-pass-2 legacy-row case now uses a row the backfill could have set (Viewer stamped). `lib/__tests__/dfRoundG_P6_reviewModelMigration.test.ts` "DF-P6 fix pass 5 (review, minor): the backfill's SCOPE is the inventory's …"; `lib/__tests__/rls/dfP6ReviewModel.test.ts` the backfill case pins a closed and a canceled row left false (PostgreSQL 16.13, 11/11).

**Done-when (after fix pass 5).** ✓ 1, 3, 4, unchanged. ✓ 2 *with a qualifier (corrected, DEC-29: it was a plain ✓ after fix pass 4)*: an undeclared request requires engineering review regardless of who filed it, and its requester is never offered a plain approval — but a requester holding `ticket.manage` may issue it by a self-override with a required comment, recorded as an override (DEC-90 ruling (3); DEC-33's fourth-pass line). DEC-90 ruling (2) unchanged (pre-paste rows the backfill set, and column-absent rows, pinned against `7893129`).

**Scope / residual (fix pass 5).** R2, R3 and R4 are ruled by default (the brief's "decisionsNeeded take their proposed defaults", applied to R1 at the fourth pass): the serial seed and the requester's pick stay; the integrator acts only to overturn one (DEC-90's fifth-pass line). Deploy the DF-P6 app first, then paste `20261250`. A restored pre-`20261250` backup lands `review_model_filed = true` (admin-and-org hand-off, unchanged).

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* the restore remainder (a ticket restored from a backup taken before `20261250` lands `review_model_filed = true` by default; a declaration restored without its e-signature) → admin-and-org **P18 RESTORE REVIEW-MODEL ROWS**.

**Resolution (2026-10-21, admin-and-org Round G P18).** P18 RESTORE REVIEW-MODEL ROWS — the restore remainder only (DEC-90 rulings (1), (3), (4), (5) as given in the brief; the declaration half is `GAP-110`'s block). The page remainder — the restore page drawing the line — was owned by admin-and-org **`BKP-17`**, resolved by P18's final fix pass (the integrator put the panel in its scope, DEC-90); the Status line above is DF-P6's and is not changed by this block. *(Corrected by the P18 second fix pass, DEC-29: this block first read "Resolution", with the notes limb ✓ although it was not done on the page; it then read "Partial" until the final fix pass drew the line on the page.)* Reproduced on the base (`b96299d`): `lib/dataRestore.ts` `applyRestoreChunk` sent a backup's `tickets` rows as they were (remap, bind, land — no review-model rule), and the restore writes as the service role, so `ticket_review_model_insert_guard` returns early and a row from a backup taken before `20261250` landed at the column DEFAULTs — `review_model_filed = true`, `engineering_required = true`: filed under the review model and required, so a Manager's in-flight request that today's role-based gate lets its requester issue changed lane on restore.

Landed (no migration):
- **`lib/dataRestore.ts`** — `filedBeforeReviewModel` / `asFiledBeforeReviewModel` (`:1911`, `:1920`): a `tickets` row that carries NO `review_model_filed` key is written with `review_model_filed = false`, and — when it carries no `engineering_required` either — `engineering_required = false`; a row whose backup carries a key keeps its value. *Why `engineering_required` too (DEC-29 — ruling (1) says "so the legacy role-based gate decides for it, exactly as for a pre-paste row"):* with `engineering_required` left at its DEFAULT `true`, `lib/reviewModel.ts` `ticketEngineeringRequired` answers `true` without asking the legacy gate, and `lib/workflow.ts` `requesterBindingApplies` binds a requester the legacy gate exempts — the ruling would not hold as written. `false` with no declaration is the SEED (the legacy gate, evaluated live), which is exactly how the app reads a request the column cannot speak for; it is the paste's own treatment of a row filed before it (both columns `ADD`ed `DEFAULT false`). The one difference from a row the paste backfilled: the backfill sets `true` where the legacy gate is certain, and that `true` stays if the requester is later promoted; a restored row is gated live (it requires an engineer exactly where the legacy gate does at each action). **Ratified by the integrator** (DEC-90's P18 line, final pass: `engineering_required = false` for a row with neither key, needed for "the legacy gate decides").
- **Only when the target has the columns** (ruling (3)): `restoreReviewModelFacts` (`:1982`) reads once per `tickets` apply-table request (once per chunk the page's driver sends — **ratified by the integrator** as the reading of ruling (3)'s "once per run": the restore's chunked requests are its run unit for schema facts, DEC-90's P18 line, final pass) — `tickets.select(<the six columns>).limit(0)`, and only when a row needs a rule — and a `42703` / `PGRST204` naming a `20261250` column (`lib/reviewModel.ts` `isMissingReviewModelColumn`) means "not pasted": nothing is sent for these columns and the restore runs exactly as before. Any other read error stops the chunk before a write (nothing is written on a guess — the restore's own rule). *P18 fix pass — the schema-cache window:* the column check is a SELECT the database answers from its live catalog, while the write is checked against PostgREST's schema cache. Just after `20261250` is pasted, before PostgREST reloads, the check finds the columns and the write (now carrying `review_model_filed`) is refused `PGRST204`. That refusal is now said as what it is (`reviewModelSchemaCacheMessage`, `:1964`; matched in the write at `:2471` only when the check found the columns): "… its API has not reloaded its schema since that migration … Wait a minute and run the restore again" — the chunk still fails closed (500, nothing written; a re-run after the reload restores it). A refusal naming another column, and a post-paste backup into a database without the columns (no check ran), keep the database's own message, as before.
- **The note** (`filedBeforeReviewModelNote`, `:1973`): one line per chunk — "N request(s) restored from this part of the backup were taken before the review model (they carry no review_model_filed) and are marked as filed before it, so today's role-based engineering gate decides for each exactly as it did before the review model — none is held to the new engineering requirement retroactively." It rides `RestoreChunkResult.notes`, the apply-table answer and its `RESTORE_CHUNK` audit row (`app/api/admin/restore/apply-table/route.ts:123`, `:150`), and the page's driver carries it onto the tickets outcome (`RestoreTableOutcome.notes`, `:3337`; set only when there is one). *P18 second fix pass (the review's major, DEC-29):* N first counted every row of the chunk with no `review_model_filed` key, before any filter or outcome — so a request already here, held by another workspace or refused, and a chunk that then failed, all produced the line (re-running a finished restore wrote it into every tickets `RESTORE_CHUNK` row). N now counts only rows a statement WROTE (`filedBeforeWritten`, counted in the write at `:2458`; `chunkNotes`, `:2069`): the transformed rows are marked (`filedBefore`) and the mark is carried through the clears / sets map and the EDGE-5 renumbering; a statement that wrote every row counts them all; one that skipped some counts a marked row only when its key was held by no row before the write — the marked rows are located in the same pre-write key read as cleared pointers (`:2335`; never settled by it, so they go on exactly as before) — and no earlier row of the request carried it; a statement with no count, or a key read that failed with a partial count, claims none. No line when nothing was written; a chunk that fails after a statement wrote rows carries the line for exactly those (they are in its `inserted`, and a re-run counts them existing). *P18 final fix pass (the integrator's ruling, DEC-90):* the line counts a written request only when its FINAL `engineering_required` is false — a row carrying no `engineering_required` key that is not an unsigned declaration (which `GAP-110`'s rule writes `engineering_required = true`); a hand-made pre-paste row carrying `engineering_required = true` is not marked either (`:2101`, checked again where it is counted, `:2458`). Before, the line also counted a declaration cleared here, which today's role-based gate does not decide (it is REQUIRED).
- **Ruling (5), EDGE-5's request sets (P18 final fix pass, the integrator's ruling):** a request already here whose declaration ruling (2) flags is settled before the write (counted existing), so it no longer reached EDGE-5's `requestTicketIds` / `requestTicketNumbers`, and a second backup request carrying its number was told the holder was "already in this workspace" where `b96299d` said "of this backup (restored first)". Each row settled only because ruling (2) flagged it is now added back to both sets (`settledOnlyBySets`, `:2358`, used at `:2408`), so the holder wording and the fresh-number exclusions are exactly as on `b96299d` (pinned against `b96299d`'s own answer, computed by running the same chunk against its `lib/dataRestore.ts` in a scratch copy).
- **Ruling (4):** the write is unchanged — `upsert(..., { onConflict: "id", ignoreDuplicates: true })` (ON CONFLICT DO NOTHING), so `ticket_update_guard`'s UPDATE limbs never fire and a request already here is never touched (pinned: no UPDATE statement, the live row byte-identical, counted existing).

Tests: `lib/__tests__/aoRoundGP18RestoreReviewModel.test.ts` (17; 20 after the fix pass; 25 after the second; 27 after the final) — the pure transform (a key kept whether true or false; a hand-made `engineering_required` kept); **the gate**: for Manager, Admin, Supervisor, DocCtrl, Viewer, Maintenance and Engineer requesters, the restored row's `engineeringGateRequired` equals the column-absent answer, `requesterBindingApplies` and `reviewModelBinds` are false, and the reviewer's Manager case issues by its requester (left at the DEFAULTs it would not); with the columns — the row lands `false` / `false`, one note in the answer and the `RESTORE_CHUNK` row, no `cleared`; a post-paste backup's values kept; a post-paste backup with no declaration sent byte for byte with no extra read; ruling (4) (no UPDATE, live rows unchanged, counted existing — *the "no note" this sentence first claimed was not asserted, and was false: see the second fix pass below*); a renumbered pre-paste request (EDGE-5) keeps the transform; a column-check read error fails closed with nothing written; every other table (`ticket_comments`) sent byte for byte with no check; the driver's tickets outcome carries the line and the comments outcome is shaped exactly as before. **Without `20261250`** (`restoreMemoryDb` `missingColumns`, new: a select naming a missing column answers `42703`, a write carrying one `PGRST204`): the same upsert byte for byte, one column check answered "not there", no note, no `cleared`; through the route the same answer and audit row (no `notes` key). Regression: `aoRoundGP16RestoreBoundedCalls.test.ts` (the `4407b30` call goldens) and `aoRoundGP16RestoreTicketNumber.test.ts` now run against a database without `20261250` and pass unchanged — every call and write byte for byte, the one added read (the column check) kept apart and pinned once per tickets request — *in the second fix pass, asserted in every traced golden (one per tickets request: per chunk through the driver, never per held-back round or bisect), where it was first asserted in one*. Mutation-checked (the declaration limb's `flagged` inclusion; the carried `unsigned` key). *Fix pass:* "the schema-cache window" (the column check passes, the tickets upsert answers `PGRST204` naming `review_model_filed` → 500 with the retry sentence, nothing written, the same through the route; a `PGRST204` naming another column keeps the database's message) and, without `20261250`, "a backup taken after the paste … refused exactly as before" (the raw `PGRST204`); mutation-checked (the sentence's match removed → the window test fails). *Second fix pass:* ruling (4) now asserts no `notes`; re-running a finished restore (every request already here) → no line in the answer, the second `RESTORE_CHUNK` row or the driver's tickets outcome; a statement that skips some rows (one already here, one held by another workspace, one with a pointer to clear that is already here, two new) → the line counts 2; a statement with no count → no line; the key read failing → a partial statement claims none, a whole one counts all; a chunk that fails before any write → no line (direct, through the route, in the audit row; also the schema-cache window), after a 500-row statement → the line counts 500; the renumbered pre-paste request is counted; and, in `aoRoundGP16RestoreBoundedCalls.test.ts`, a post-paste variant of the 500-row collision golden (every row pre-paste, 250 carrying a declaration with no signature here): 33 calls in all — the 27 as without the columns, the column check, 2 signature reads and 3 key reads. Mutation-checked: counting a marked row without the held-before-write test fails ruling (4), the re-run and the skipped-rows tests. *Final fix pass:* "rulings (1) and (2) together" now asserts NO filed-before line for the cleared declaration (its `DECLARATION_NOT_RESTORED` note stays) and, beside a plain pre-paste row, a line counting 1; a hand-made pre-paste row carrying `engineering_required = true` is not counted; the 500-row post-paste golden's line counts 250 (the 250 cleared declarations are REQUIRED), its 33 calls unchanged; and "integrator ruling (5)": a declared, unsigned request already here holding N and a second backup request carrying N in the same chunk, no `backupNumberCarriers` — the `TICKET_RENUMBERED` note equals `b96299d`'s answer byte for byte ("request t-1 of this backup (restored first) carries …"; at `adb7509` it read "already in this workspace"). The page: `lib/__tests__/aoRoundGP18RestoreResultPanel.test.ts` (`BKP-17`).

**Done-when.** *(The brief's criteria for the restore remainder.)*
- ✓ A `tickets` row from a backup with no `review_model_filed` key is restored with `review_model_filed = false` (and, with no `engineering_required` key, `engineering_required = false` — see above), so the legacy gate decides as before the paste; a row whose backup carries the key keeps its value.
- ✓ Sent only when the target has the column; a target without `20261250` restores as today — pinned (the upsert byte for byte; the `4407b30` goldens pass unchanged; the only addition is one read that answers "not there").
- ✓ One line in the restore notes — the apply-table answer and its `RESTORE_CHUNK` audit row, and the driver's tickets outcome, counting only the requests written (second fix pass) with `engineering_required` false (final fix pass); **and on the page** — the result panel draws it under the tickets row (`app/(protected)/admin/restore/RestoreResultPanel.tsx` `TableNoteLines`; admin-and-org **`BKP-17`**, RESOLVED by the P18 final fix pass; pinned by rendered tests). *(Corrected by the P18 fix passes: first a plain ✓ with the panel left to "the integrator at the merge", then "✓ (API / audit)" under a Resolution heading, then ◐ until the final fix pass.)*
- ✓ An existing ticket is never touched (ON CONFLICT DO NOTHING; pinned) and produces no line (pinned, second fix pass); every other table, count and outcome unchanged (pinned).

**Scope / residual.** (1) **The result panel line** — resolved: admin-and-org **`BKP-17`** (`audit-reports/admin-and-org/02-backup-restore.md`), RESOLVED by the P18 final fix pass; the panel renders `RestoreTableOutcome.notes` under its table. (1b) **The schema-cache window** (above): a restore run in the minute or so between pasting `20261250` and PostgREST's schema reload fails the tickets table closed with the retry sentence; before P18 the same pre-paste backup restored cleanly in that window. For the paste row (`MIGRATION-PASTE-ORDER.md` row 194, not edited by P18 — the integrator's file): deploy first, paste, and run a restore only after the reload (Supabase reloads on DDL; `NOTIFY pgrst, 'reload schema'` forces it). (2) A backup taken AFTER `20261250` restored into a database WITHOUT it is sent as it is and refused by PostgREST (`PGRST204`), exactly as before P18 — a general newer-backup-into-older-schema case, not this finding's. (3) No migration, no new table, notification kind, capability or schema probe; nothing for `MIGRATION-PASTE-ORDER.md` or `lib/schemaExpectations.ts`.

---

## TIER-2 · There is no work classification at all — like-in-kind and new design are indistinguishable

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL. Reproduced on the base: `types/schema.ts` `Ticket` had no field distinguishing like-in-kind from new design. *Corrected at the DF-P6 review fix pass (DEC-29): this block first read "Resolution" with the Status RESOLVED, and said classes are set with `assign` / `self_assign`. No screen sets a class yet, and the route refuses a class sent with `self_assign` (400).*

Landed: two lanes, declared at steps that already exist. (a) **Like-in-kind vs engineered** — the requester's optional declaration at intake (`components/requests/LikeInKindField.tsx`, `GAP-110`), immutable once filed (`20261250`, every caller); blank is the engineered lane and the form says so. (b) **The workspace's own work and code classes** (`GAP-101`, `TIER-4`) — `OrgDraftingSettings.workClasses` / `codeClasses` in `org_configurations` `'drafting'` (DEC-90 ruling (4) for DF-P6), seeded EMPTY, edited on Admin → Request forms (`components/requests/ReviewClassesSection.tsx`); accepted from the assigner at triage (`assign`, `request_eng_review` or `flag_engineering` at `PENDING_ASSIGNMENT`, `app/api/tickets/workflow-action/route.ts`, validated against the list — 400 off the list, outside triage or with any other action, 503 when the list cannot be read), stored in `tickets.work_class` / `code_class` (workflow-owned in the guard). A class marked "Requires engineering" raises `engineering_required`; nothing lowers it. Unset is the safe engineered reading.

Tests: `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "GAP-101 / TIER-4 — the classes are the workspace's own lists, set at triage"; `lib/__tests__/reviewModel.test.ts` "GAP-101 / TIER-4 / GAP-105 — classes and the resource".

**Pending migration:** `supabase/migrations/20261250_df_roundG_review_model.sql` (DEC-30 one paste; not a widening — it narrows: the declaration is immutable and `engineering_required` never clears for any caller). **Order: deploy the DF-P6 app FIRST, then paste `20261250`.** Before the paste every request takes today's path (a 42703 / PGRST204 naming one of its columns reads as "not pasted": the engine's `engineeringRequired` is undefined and the legacy role-based gate decides; a declaration is signed but filed the usual way and the answer says so). The reverse order would leave a window in which the old app files requests that the column's new default (true) later reclassifies — the one order in which a request filed in the gap would change lane on deploy. `20261251_df_roundG_ticket_equipment.sql` is independent of both (paste it before or after; the app says the equipment was not recorded until it is there). Both exercised on PostgreSQL 16 (`lib/__tests__/rls/dfP6ReviewModel.test.ts`, 11 cases *(corrected at the fourth review fix pass, DEC-29: this said 10; 11 run and pass)*, each file applied twice) and shape-pinned (`lib/__tests__/dfRoundG_P6_reviewModelMigration.test.ts`, the guard lineDiff against its newest body `20261221`).

**Done-when.**
- ✓ 1. A ticket carries a declared work lane distinguishing like-in-kind from new design (the declaration) and, where the workspace defines them, its own classes.
- ✗ (in part) 2. Set at steps that already exist — ✓ for the declaration (the request form, one optional sentence; no step added, no class required at intake — 99-fix-sequencing "Do not"); ✗ for the classes: the route accepts them at triage, but no screen sends one (the assign modal is the request page's, DF-P9's file), so in production `tickets.work_class` / `code_class` stay unset and a class never acts.
- ✓ 3. `request_type` is validated server-side against the configured list (`WF-15`, DF-P2's create route — `lib/__tests__/ticketCreateRoute.test.ts` "…an unconfigured request type is refused…").

**Scope / residual.** Owner of the class select: drafting-flow **DF-P9** (one select per configured list beside the drafter pick in the assign modal, sending `workClass` / `codeClass` with `assign` / `request_eng_review` — 99-fix-sequencing "Hand-offs from DF-P6"). Recorded limitation: a class can be set only at `PENDING_ASSIGNMENT`; a wrong class cannot be corrected later and a request already past triage when `20261250` is pasted cannot be classified (no action at `DRAFTING` / `REVISION_REQ` accepts one). The select's owner decides whether `flag_engineering` should also carry a class later (it must stay ratchet-only for `engineering_required`). Stays OPEN on done-when 2's class limb.

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31; DF-P9, the package first named, merged on 2026-10-14):* the class select at triage → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**.

**Resolution (2026-10-21, drafting-flow Round G).** DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — done-when 2's class limb. Reproduced on the base (`1f928f8`): the route accepted `workClass` / `codeClass` at triage (`app/api/tickets/workflow-action/route.ts`, the GAP-101 / TIER-4 block) but no screen sent one — the assign modal (`app/(protected)/requests/[id]/page.tsx` `AssignmentModal`) carried only the library and the unit, and the engineer picker nothing. Landed:
- `components/requests/TriageClassSelects.tsx` (new): one select per CONFIGURED list (`lib/reviewModel.ts` `reviewClassOptions`), "No change" by default (sends nothing — triage never clears a class, and a class the list no longer names is never sent back), a class marked "requires engineering" said in the option. With both lists empty it renders nothing.
- The assign modal mounts it inside the triage fields (`page.tsx:449` in `AssignmentModal`, `classOffered` `:356`) and sends `workClass` / `codeClass` with `assign` at `PENDING_ASSIGNMENT` (`classTriagePayload`); the engineer picker (`components/requests/EngineerPickerModal.tsx`, a new optional `extra` slot) mounts it for `request_eng_review` at triage (`page.tsx:2718`, the `TriageClassSelects` passed as the `EngineerPickerModal`'s `extra`; *re-anchored at the DF-P18 merge — the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90*). `executeWorkflowAction` sends the two fields only when picked.
- `lib/requestPageReview.ts` `triageClassSelects`: no select outside `PENDING_ASSIGNMENT`, before `20261250` is pasted (the column unread — the route would only say the class was not recorded), or for a list the workspace left empty (DEC-90 ruling (1) for DF-P18: an unconfigured workspace's triage dialog is today's).
- `flag_engineering` is NOT given a class at `DRAFTING` / `REVISION_REQ` / `PENDING_REVIEW` (the call DF-P6 left open): a class is set at triage, as the route allows today — `DEC-44 (DF-P18-review-model-page)` item 3.

Tests: `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts` ("TIER-2 dw2 / TIER-4 dw1 / GAP-101 — the class at triage", incl. the REGRESSION "no select for an unconfigured workspace, outside triage, or before 20261250"); `lib/__tests__/dfRoundG_P18_reviewModelPageRender.test.ts` ("TriageClassSelects": nothing renders unconfigured; one select per list); `lib/__tests__/dfRoundG_P18_reviewModelPageRoute.test.ts` ("GAP-101 / TIER-4 (DF-P18) — the class the triage select sends with assign": recorded, an engineering class raises the requirement; REGRESSION: an assign with no class writes no class column).

**Done-when.**
- ✓ 1. As recorded (DF-P6).
- ✓ 2. Set at steps that already exist — the declaration at intake (DF-P6) and the classes at triage, in the assign dialog and the scope-review picker the queue already uses; no step added, never required.
- ✓ 3. As recorded (WF-15, DF-P2).

**Scope / residual.** A class is set only at triage (route rule unchanged — `DEC-44 (DF-P18-review-model-page)` item 3): a wrong class cannot be corrected later and a request past triage when `20261250` is pasted is not classified. The request's capability resource carrying the classes (scoped rules) is drafting-flow DF-P19's (`TIER-4`'s Assigned line). No migration.

---

## TIER-3 · QA/QC does not exist anywhere in the flow

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL, on DF-P5's roster. *Corrected at the DF-P6 second review fix pass (DEC-29): this block first read "Resolution" with the Status RESOLVED and done-when 1 ✓ "per work class". Per-class expression cannot be configured or exercised in production: `RoutingControlSection` does not let anyone edit a slot's `work_classes` (it only carries stored values through a save), and no screen sets a request's work class (`TIER-2`, `GAP-101` Partial, owner DF-P9) — so `routingForWorkClass` drops nothing. And a notify-only slot is a notice, not a requirement that can block or record an examination.* Ruled by the integrator for this package (DEC-90): no QA/QC role, status or signature slot (99-fix-sequencing "Do not"); the requirement is expressed through the routing table's slots.

Landed: a routing slot may name the work classes it applies to (`RoutingSlot.work_classes`, `lib/routingControl.ts`), accepted on a **notify-only** slot and refused on a blocking one (an unclassified request keeps it — the safe reading); `routingForWorkClass` drops a notify-only slot whose classes do not include the request's (`app/api/tickets/workflow-action/route.ts`, where the roster opens). So a library can tell its assurance reviewer about every issue of the classes it cares about, on the parallel roster, without a stop; the slot is filled by roles, named people or a capability (`DF-P5`), so no role is created. Blocking assurance slots per library already exist (DF-P5); per-class blocking is refused deliberately (GAP-102: assurance by data and holds, not by an added sign-off).

Tests: `lib/__tests__/reviewModel.test.ts` "GAP-102 / TIER-3 — a notify-only slot per work class; never a condition on a sign-off".

**Done-when.**
- ✗ (in part) 1. A review requirement can be expressed per library — ✓ (a blocking routing slot, DF-P5). Per work class — ✗: the ruled form is a notify-only slot limited to classes (the integrator's ruling for DF-P6: a per-class blocking sign-off is not offered), and it needs (a) a `work_classes` editor on the slot in `components/documents/RoutingControlSection.tsx` and (b) DF-P9's class select before it acts; even then it is a notice, not a requirement that holds the issue.
- ✓ 2. Satisfying it adds no serial status hop (the parallel roster; a notify-only slot never holds the issue).
- ✓ 3. No new role — the slot is filled by existing roles, people or a capability.

**Scope / residual.** Owners (DEC-31): the slot's `work_classes` editor → drafting-flow **DF-P9** (it holds the class select both read; `RoutingControlSection` is DF-P5's file, already edited by DF-P6 — the integrator may re-own it to the routing table's next holder); the class select → **DF-P9** (`TIER-2`). Rows in 99-fix-sequencing "Hand-offs from DF-P6". Stays OPEN. GAP-102's examination-data acceptance (4: a package missing required examination data cannot issue) is not built — it needs a data model for examination scope; proposed for the integrator to assign (no package lists it). The stop-by-hold path (GAP-102 acceptance 3) is the existing document hold.

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31; DF-P9, the package first named, merged on 2026-10-14):* the slot's `work_classes` editor and the class select → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS** (the integrator re-owns `components/documents/RoutingControlSection.tsx` to it for this editor).

**Resolution (2026-10-21, drafting-flow Round G).** DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — done-when 1's per-class limb, in the ruled form (DEC-90 for DF-P6, as the Partial above records: no QA/QC role, status or signature slot; GAP-102: assurance by notice and a hold, never a sign-off). Reproduced on the base: `components/documents/RoutingControlSection.tsx` only carried a slot's stored `work_classes` through a save (`kept.workClasses`, shown in the "settings this editor does not show" note) and nothing set a request's class. Landed:
- The routing editor offers, on a NOTIFY-ONLY slot, chips of the workspace's own work classes (`RoutingControlSection.tsx:375`, `data-testid="routing-slot-work-classes"`, `workClassChoices` at `:377` — *re-anchored at the DF-P18 merge, the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90*; read from `org_configurations` `'drafting'` through `reviewClassOptions`; `workClassChoices` also lists a stored value the list no longer names, so it can be seen and removed). No chips at all when the workspace has no work classes (DEC-90 ruling (1) for DF-P18); the note no longer lists what the editor now shows (`keptNote(d, shown)`). `lib/routingControl.ts` is unchanged: a class limit on a blocking or consent slot is still refused.
- With the triage class select (`TIER-2`) the limit acts: `routingForWorkClass` (the route, where the roster opens) leaves the slot out for a request of another class.

Tests: `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts` ("TIER-3 dw1 and the DF-P7 editor residual — the routing editor": the round trip through the editor and the parser, the note, the blocking-slot refusal, the source pins); DF-P6's `reviewModel.test.ts` "GAP-102 / TIER-3" (unchanged, green).

**Done-when.**
- ✓ 1. Per library (a blocking routing slot, DF-P5) and per work class (a notify-only slot limited to classes — edited in the routing table, acting on the class triage sets), in the ruled form: a notice plus the existing document hold, never a sign-off (the per-class blocking sign-off is refused by ruling). 
- ✓ 2. As recorded (no serial hop).
- ✓ 3. As recorded (no new role).

**Scope / residual.** GAP-102 acceptance 1 and 4 (examination data) are drafting-flow DF-P20's (assigned at the DF-P6 merge). No migration.

---

## TIER-4 · No code-governed review dimension — B31.3 and its equivalents are unrepresentable

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL. Reproduced on the base: no code dimension anywhere in the request or its approvals. *Corrected at the DF-P6 review fix pass (DEC-29): this block first read "Resolution" with the Status RESOLVED. No screen sets a code class, and the ticket resource no longer carries the classes (below), so done-when 1 and 3 are not met in practice.*

Landed: the workspace declares its own **code classes** (`codeClasses`, the same `'drafting'` configuration; DEC-35 — no code names in the application) and the assigner sets one at triage (`tickets.code_class`). A class marked "Requires engineering" raises the requirement. The capability evaluator accepts a rule scoped to a code class (`when.codeClass` on the `ticket.*` capabilities — `lib/capabilityPolicy.ts` `TICKET_RESOURCE_KEYS`; refused on a capability the database evaluates, whose SQL resource pin is unchanged), but since the review fix pass the ticket's resource (`lib/workflow.ts` `ticketResource`) does NOT carry the classes: the requests list and `lib/inbox.ts` build their Ticket without them, so such a rule would govern the route and the request page and not the attention badge (issue 6 of the review; hand-off in 99-fix-sequencing). Every issuing approval (and a roster sign-off) states the request's code class in its description before it is taken (`lib/workflow.ts`, the TIER-4 / HAND-7 note), and the request page shows it (`components/requests/DeclarationCard.tsx`) — when a class is set.

Tests: `lib/__tests__/reviewModel.test.ts` "a rule scoped to a code class narrows a ticket capability there …", "TIER-4 done-when 3 / HAND-7: an approval says the code class and a moved source before it is taken …"; `dfRoundG_P6_reviewRoute.test.ts` (the class at triage).

**Pending migration:** `supabase/migrations/20261250_df_roundG_review_model.sql` (DEC-30 one paste; not a widening — it narrows: the declaration is immutable and `engineering_required` never clears for any caller). **Order: deploy the DF-P6 app FIRST, then paste `20261250`.** Before the paste every request takes today's path (a 42703 / PGRST204 naming one of its columns reads as "not pasted": the engine's `engineeringRequired` is undefined and the legacy role-based gate decides; a declaration is signed but filed the usual way and the answer says so). The reverse order would leave a window in which the old app files requests that the column's new default (true) later reclassifies — the one order in which a request filed in the gap would change lane on deploy. `20261251_df_roundG_ticket_equipment.sql` is independent of both (paste it before or after; the app says the equipment was not recorded until it is there). Both exercised on PostgreSQL 16 (`lib/__tests__/rls/dfP6ReviewModel.test.ts`, 11 cases *(corrected at the fourth review fix pass, DEC-29: this said 10; 11 run and pass)*, each file applied twice) and shape-pinned (`lib/__tests__/dfRoundG_P6_reviewModelMigration.test.ts`, the guard lineDiff against its newest body `20261221`).

**Done-when.**
- ✗ (in part) 1. An org can declare governing codes (code classes, Admin → Request forms) and mark one "Requires engineering" — ✓ in configuration; ✗ in practice: no screen sets a class on a request, and a capability rule scoped to a code class does not bind until the resource carries it.
- ✓ 2. Org-configurable data, not a code branch (seeded empty; DEC-35 grep clean in the files this package wrote).
- ✗ (in practice) 3. A ticket in a code-governed service surfaces its code to the reviewer before they sign — the approval's description and the request page do, whenever a class is set; none can be set from a screen yet.

*Corrected at the DF-P6 second review fix pass (DEC-29): the policy validator now REFUSES a library-, work-class- or code-class-scoped rule on a `ticket.*` capability (`lib/capabilityPolicy.ts` `validateCapabilityPolicy`) — such a rule would never match while the resource carries only request type and unit, so it looked like a narrowing and did nothing. The refusal lifts when the resource carries the fields. The admin copy no longer says a rule can be scoped to a code class (`components/requests/ReviewClassesSection.tsx`, the `ticket.direct_approve` description).* *Corrected at the fourth review fix pass (DEC-29): the refusal is no longer in `validateCapabilityPolicy` (every write runs it, so a stored library-scoped rule would have blocked every later save, grant and revoke). Only a NEW such rule is refused, at the policy route (`newDeadTicketRuleRefusal` against the stored row); a stored one rides along matching nothing.*

**Scope / residual.** Owners: the assign-modal select → drafting-flow **DF-P9** (as `TIER-2`); the resource carrying `workClass` / `codeClass` (and `libraryId`) → the requests list's and `lib/inbox.ts`'s mappers first (99-fix-sequencing "Hand-offs from DF-P6", spread `lib/reviewModel.ts` `reviewModelFieldsFromRow`), then `ticketResource`. The same limitation as `TIER-2`: a class is set only at triage. Stays OPEN.

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31; DF-P9, the package first named, merged on 2026-10-14):* the assign-modal select → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**; the request's resource carrying `workClass` / `codeClass` / `libraryId` (scoped rules) → drafting-flow **DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION**.

**Partial (2026-10-21, drafting-flow Round G).** DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — the assign-modal select (this package's limb of the Assigned line). The workspace's code classes are picked at triage beside the drafter and with a scope review (`components/requests/TriageClassSelects.tsx`, `app/(protected)/requests/[id]/page.tsx` — see `TIER-2`'s Resolution), so a request now carries its code class from a screen; a class marked "Requires engineering" raises the requirement there, and every issuing approval and roster sign-off states the class in its description before it is taken (DF-P6's engine note, now reachable). Tests: `lib/__tests__/dfRoundG_P18_reviewModelPageRoute.test.ts` (the class sent with `assign` is recorded), `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts`.

**Done-when.**
- ✗ (in part) 1. Declared in configuration ✓ and set from a screen ✓ (this package), with its review requirement ("Requires engineering") ✓; a capability rule SCOPED to a code class still binds nothing until the request's resource carries the class — drafting-flow DF-P19 (assigned).
- ✓ 2. As recorded.
- ✓ 3. A ticket in a code-governed service surfaces its code to the reviewer before they sign — the class is set at triage from a screen and the approval's description and the request page say it.

**Scope / residual.** → drafting-flow **DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION** (the resource carrying `workClass` / `codeClass` / `libraryId`, as assigned). Stays OPEN for that limb only.


**Resolution (2026-10-22, drafting-flow Round G).** *RESOLVED on done-when 1's "Requires engineering" limb, which alone meets the item as written (DF-P19 fifth fix pass, review minor 2, DEC-29: the code-class reviewer-group limb is stated with its limit in the fifth-fix-pass block below, not claimed beyond it). DEC-90 ruling (3) for DF-P19 as the integrator ACCEPTED it at the DF-P19 merge (2026-10-22, DEC-90): the requests list, the inbox and the notification badge offer exactly the actions the workflow route allows on each request — parity with the route; the server's answer is authoritative. So for a review-model request with no library or class those three now offer the route's actions (pinned in `dfRoundG_P19_ticketResource.test.ts`, "the engine answers differ from the pre-DF-P19 mappers'"). The DF-P19 fourth fix pass (review minor 3, DEC-29) had recorded that as a departure from ruling (3)'s first wording ("a request with no library and no class decides exactly as today", which still holds for the workflow route and the request page) and put it to the integrator with a stated reversal; the call is made, and the reversal does not apply (DF-P19 merge-time fix pass, review nit 5).* DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION — the resource limb (the DF-P18 Partial's only ✗), under the integrator's rulings (1)–(3) and (5) for DF-P19 (DEC-90). Reproduced on the base `82f2ed6`: `lib/workflow.ts` `ticketResource` returned `{ requestType, unit }` only, so a capability rule scoped to a code class (or a work class, or a library) matched no request; the requests list's `fromRow`, `lib/inbox.ts` `rowToTicket` and the attention badge (`hooks/useTicketNotifications.ts` `fromDbTicket` and its column list) built their Ticket without the classes, which is why DF-P6 had reverted the resource.

Landed:
- **The resource carries the classes and the library** — `lib/workflow.ts:157` `ticketResource` returns `libraryId`, `workClass`, `codeClass` beside type and unit (null when the request has none, so no rule matches it).
- **Every mapper that builds a request for the engine spreads them** (ruling (1)): `lib/reviewModel.ts` `reviewModelFieldsFromRow` is now spread by the requests list (`app/(protected)/requests/page.tsx:583`), the inbox (`lib/inbox.ts:344`, the mapper only) and the badge (`hooks/useTicketNotifications.ts:160` `fromDbTicket`; its column list gains the library and the review-model columns, tried in order on a 42703 — `TICKET_ATTENTION_COLUMN_LADDER`, line 141: without 20261250's columns, then without 20261208's library, then `'*'` as before; the rung that answers is remembered), as the workflow route / cron (`lib/ticketTransitions.ts` `rowToTicket`) and the request page already did. The equipment route's queue check presents the same fields (`app/api/tickets/equipment/route.ts:147`, with the same 42703 ladder on its read).
- **A stored rule that never applied cannot silently take an action away** (ruling (2); the mechanism is recorded in `DEC-44 (DF-P19-ticket-resource-dimensions)`): on a `ticket.*` capability a rule scoped to a library / work class / code class is IN FORCE only once confirmed (`lib/capabilityPolicy.ts:420` `ruleInForce`; the rule's `confirmedAt`, server-owned). Until then it only ADDS (`effectiveTokens`): its tokens are joined to the answer the first-match scan gives without it, and "scoped" keeps that answer's state (on `ticket.engineer_gate_exempt` it is not even joined — fix pass below) — so a grant takes effect, a narrowing never removes a working action, never scopes a requester's own approval out and never narrows an engineer pick. The policy route confirms a rule it stores NEW (`app/api/admin/capability-policy/route.ts:220`, `carryTicketRuleConfirmation` — the save is the confirmation; a client never sends the stamp) and lifts DF-P6's refusal of a new one; a stored one is confirmed by an Admin (`op: "confirm_rule"`, line 232, audited). The permissions console lists every such rule with its state ("Not yet in force where it would take an action away — confirm to apply") and a Confirm button for an Admin (`components/permissions/CapabilityPolicyEditor.tsx:805`, `confirmRule` line 509). `canonicalEntry` now reads every rule key, so a class-scoped rule's change on a critical capability is Admin's.
- **The inventory before the keys match**: `supabase/migrations/20261263_df_roundG_ticket_dimension_inventory.sql` (counts only, per workspace, read-only; NARROW / GRANT / SAME by the same rule as `classifyTicketDimensionRule`). The live counts are the paste's (the integrator's report row); the app is safe whatever they are.

Tests: `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` (one row through all five mappers → one resource and one engine answer over every status × role × identity; ruling (3) over every status × role × identity under policies with and without such rules, confirmed and not; ruling (2): no enabled action lost to an unconfirmed narrowing, lost to a confirmed one where it matches only, an unconfirmed grant takes effect, the requester's own approval and the engineer pick; classification, carry, confirm, the console's words); `lib/__tests__/sweepRoundE_policyServer.test.ts` (the route: a new rule confirmed by the save, a forged stamp ignored, `confirm_rule` Admin-only / 409s); `lib/__tests__/attentionProvider.test.ts` (the badge's ladder); `reviewModel.test.ts`, `dfRoundG_P4_library.test.ts`, `sweepRoundD3.test.ts` re-pinned to the carried resource; PostgreSQL 16: `lib/__tests__/rls/dfP19TicketDimensionInventory.test.ts` (4 cases) plus a bare-cluster run without the 20261208 / 20261250 columns.

**Done-when.**
- ✓ 1. An org declares governing codes (code classes, Admin → Request forms) and attaches a review requirement to one: a class marked "Requires engineering" (DF-P6 / DF-P18) raises the request's `engineering_required` when the assigner picks it at triage — this alone meets the item as written. *Corrected at the DF-P19 fix pass (DEC-29; review minor 6):* a capability rule scoped to a code class also binds the request carrying that class in the evaluator, but **no screen authors one** — the permissions grid (`components/permissions/CapabilityPolicyEditor.tsx`) lists, preserves and confirms library- / class-scoped rules and cannot create one; such a rule can be stored only through the policy API (`POST /api/admin/capability-policy`, where the save confirms it). That limb is not claimed for done-when 1. *Corrected at the DF-P19 second fix pass (DEC-29; review major 2):* the limb is now met from the product — Admin → Permissions has **Code-class rules** (`components/permissions/CapabilityPolicyEditor.tsx`: pick a request capability and one of the workspace's code classes, then the roles whose list REPLACES the row above for requests of that class — e.g. final approval on code class X only by Engineer-3). An Admin's save stores it confirmed (in force at once); a DocCtrl's is stored unconfirmed and only adds until an Admin confirms it. So done-when 1 holds as the DF-P18 Partial read it: a review requirement attached to a governing code, both as "Requires engineering" and as a specific reviewer group for that code. *Corrected at the DF-P19 fifth fix pass (DEC-29; review major 1 and minor 2):* "a specific reviewer group for that code" did not hold as written through the fourth fix pass — the console wrote a new code-class rule AFTER the capability's stored request-type rows and the first matching rule decides, so for a request type with an override of its own (e.g. `{Engineer, Manager} where requestType EWR`) the code-class rule never applied (`tokensFor(…, {requestType: "EWR", codeClass: "B313"})` returned the EWR row's list; a Manager could still final-approve B31.3-class EWR work). Now a NEW code-class rule is written ahead of the request-type / project / preserved rules, so it applies whatever the request type (*corrected at the DF-P19 merge-time fix pass, DEC-29, review minor 1:* ahead of the request-type and unit rules, but AFTER every stored rule that can match a request of its class — a library rule, a rule naming that class, a multi-key rule that does not exclude it — so it cancels none of them; where such a rule sits behind a request-type / unit rule, the new rule goes right after it and the console names the rules that decide first for it); a code-class rule already STORED behind such a rule keeps its place (a save never reorders stored rules) and does not apply to the requests that rule matches — the console names those rules on the row and in the save preview (fifth-fix-pass block below). The ✓ rests on the "Requires engineering" class; the reviewer-group limb holds for every rule the console writes from now on, and, for a stored rule behind a request-type / unit rule, only for requests that rule does not match.
- ✓ 2. As recorded (org-configurable data; DEC-35 — no code names in the files this package wrote).
- ✓ 3. As recorded (DF-P18).

**Scope / residual.** None against the done-whens as written (done-when 1 rests on the "Requires engineering" class; *second fix pass:* and on a code-class rule authored in Admin → Permissions). *Superseded at the second fix pass for code classes — the rest of this paragraph now holds only for library- and work-class-scoped rules, which the finding's done-whens do not ask for:* Stated plainly (DF-P19 fix pass, DEC-29): a library- or code-class-scoped capability rule — e.g. "final approval on code class X only by Engineer-3" — has no control in the product; the grid authors request-type and project rows only, and a scoped rule is written by calling `POST /api/admin/capability-policy` directly. A grid row for them would follow the request-type row's pattern; proposed for the next package that holds `components/permissions/CapabilityPolicyEditor.tsx` (no owner assigned — it is not a TIER-4 done-when, so it is not a DEC-31 remainder; the integrator decides whether to raise it as its own finding).

*DF-P19 fix pass (2026-10-22, review):* (a) the evaluator no longer lets an unconfirmed rule shadow a later confirmed one — `effectiveTokens` continues the first-match scan past an unconfirmed rule (a later rule, a confirmed dimension rule included, still decides where it matches) and joins the unconfirmed rule's tokens to that answer, so the console's "In force" is what the evaluator does; (b) on `ticket.engineer_gate_exempt` (whose list removes the engineer sign-off for a requester's own request) an unconfirmed library / class rule is ignored entirely — not joined — until an Admin confirms it (`GATE_EXEMPT_CAP`), and `classifyTicketDimensionRule` / `20261263` count any such rule as NARROW unless its roles are exactly the base list (never GRANT); (c) a grid save keeps the stored order of conditional rules (`joinPolicyFromEditor`'s `stored` argument), so a preserved library- / class-scoped rule is never moved behind a request-type row. Tests: `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("fix pass (review major 2)", "(review minor 3)", "(review minor 4)"); `lib/__tests__/rls/dfP19TicketDimensionInventory.test.ts` (an exempt widening counted NARROW, an exact-base one SAME, on PostgreSQL 16).

*DF-P19 second fix pass (2026-10-22, review major 2 and minor 3; DEC-29):* (a) **done-when 1's scoped limb from the product** — `components/permissions/CapabilityPolicyEditor.tsx` gains code-class rows beside the request-type overrides: `splitPolicyForEditor` reads a request-capability rule naming exactly ONE code class (and nothing else) as a row (`editorRowKind` "codeClass"; a rule naming several classes, or another key too, stays preserved verbatim, so a save never splits it into rules the server would see as new), `joinPolicyFromEditor(…, codeClassOverrides)` writes one `{ tokens, when: { codeClass: [c] } }` per row in the stored order (a new row last), the classes offered are the workspace's own (`org_configurations` 'drafting' `codeClasses`, `reviewClassOptions` — DEC-35), a critical capability's row starts from Admin, and the save's impact preview says whether the rule is "in force once saved" (an Admin) or "adds people only until an Admin confirms it". `CODE_CLASS_RULE_CAPS` is every `ticket.*` capability (the evaluator reads `when.codeClass` there only). The editor keeps the stamps the server decided (`saveCapabilityPolicy` now returns the stored policy), so the state list below the grid says what is in force without a re-read. (b) **Confirming is an Admin's** (review minor 3): `carryTicketRuleConfirmation` takes `confirmNew` (the route passes `isAdmin`) — a NEW dimension rule saved by a DocCtrl controller is stored unconfirmed (audited as `unconfirmedRules`), so a controller can no longer confirm a stored unconfirmed narrowing by removing it in one save and re-adding it in the next. Tests: `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("second fix pass (review major 2)": the capabilities offered, split / join with the stamp carried, an Admin's code-class rule binding Engineer-3 only on that class and nowhere else, a DocCtrl's taking nobody's approval away, row order; "second fix pass (review minor 3)"); `lib/__tests__/sweepRoundE_policyServer.test.ts` (a DocCtrl's single new rule stored unconfirmed and audited; the two-save sequence confirms nothing).

*DF-P19 third fix pass (2026-10-22, review major 2 and minors 3–4; DEC-29):* (a) **done-when 1's scoped limb no longer lapses through a non-Admin's edit.** Before: a DocCtrl editing an in-force (Admin-confirmed) code-class row made it a NEW rule, stored unconfirmed, which only adds (on `ticket.engineer_gate_exempt` does nothing) — so "final approval on B31.3-class work only by Engineer-3" silently became "any Engineer", while the preview said only Engineer-2 was added. Now an in-force library- / class-scoped rule is an Admin's to change or remove: `lib/capabilityPolicy.ts` `inForceTicketRulesDropped` names any such stored rule a save no longer holds, the policy route refuses it from anyone but an Admin (403, nothing written), and the editor locks the row for a non-Admin ("in force — only an Admin may change or remove it"; `inForceClassRule`) and runs the same check before it sends; the preview now says a non-Admin's new rule on the engineer-gate exemption has "no effect at all until an Admin confirms it" (`classRuleTakesEffect`). Pinned: `lib/__tests__/sweepRoundE_policyServer.test.ts` ("DF-P19 third fix pass (review major 2)": `ticket.final_approve` edit and removal refused, `ticket.engineer_gate_exempt` widening refused, an unrelated DocCtrl save keeps the stamps, an Admin's edit is stamped and in force) and `dfRoundG_P19_ticketResource.test.ts`. (b) The request's library and classes decide `ticket.*` capabilities only — a routing slot filled by another capability sees the pre-DF-P19 resource (`requestResourceFor`; GAP-105). (c) The permissions explorer notes an unconfirmed library / class rule as "not yet in force — only add people … until an Admin confirms" (`components/permissions/PermissionsExplorer.tsx` `capabilityRow`); the View-as code-class picker is handed off (99-fix-sequencing, owner named). (d) DEC-90 ruling (3) for DF-P19 holds for the workflow route and the request page only; the list / inbox / badge change for review-model requests is put to the integrator for a ruling (99-fix-sequencing).

*DF-P19 fourth fix pass (2026-10-22, review major 1 and minors 2–4; DEC-29):* (a) **Correction to (a) above** — "an in-force library- / class-scoped rule is an Admin's to change or remove … so a DocCtrl edit can no longer quietly drop a confirmed narrowing" overstated what was built: the check was set membership only, and the first matching rule decides, so a non-Admin's direct API save that KEPT the confirmed rule but put another rule ahead of it cancelled the narrowing with nothing reported dropped (the reviewer's reproduction, on `ticket.final_approve` — not critical, so no other check ran: `[{Admin} where codeClass B313 (confirmed), base {Engineer, Admin}]` plus (i) a new unconfirmed `{Engineer} where codeClass B313` first, whose roles the evaluator joins to the confirmed rule's answer, or (ii) an in-force `{Engineer, Admin} where requestType EWR` first — either way every Engineer could final-approve B31.3-class work again). Now `lib/capabilityPolicy.ts` `inForceTicketRulesShadowed` names any in-force such rule with a rule newly placed, moved, edited or removed ahead of it — per capability, the ordered conditional rules up to and including the LAST in-force one must be the stored ones (compared as single-valued pieces, so the grid writing a stored multi-type rule back one rule per type is no change); a new rule may only go after it — and `app/api/admin/capability-policy/route.ts` refuses such a save from a non-Admin (403, nothing written, after `inForceTicketRulesDropped`), while `components/permissions/CapabilityPolicyEditor.tsx` runs the same check before it sends. Pinned: `lib/__tests__/sweepRoundE_policyServer.test.ts` ("DF-P19 fourth fix pass (review major 1)": both reproductions → 403 for a DocCtrl, allowed for an Admin; a rule added after → accepted, B313 still Admin's only; the grid's unchanged save with a stored multi-type rule ahead → accepted) and `dfRoundG_P19_ticketResource.test.ts` ("fourth fix pass (review major 1)"). With that the sentence holds. (b) **Counts** (minor 2): an unconfirmed NARROW rule that also names a role off the base list grants that role at the deploy — only its narrowing waits; `narrowTicketRuleAddedRoles` names those roles and `20261263` counts such rules in a new row 13 (row 10 now says only the narrowing half waits); pinned on PostgreSQL 16 (`lib/__tests__/rls/dfP19TicketDimensionInventory.test.ts`). (c) This Resolution is now marked conditional on the integrator's ruling-(3) call (minor 3; first line above). (d) The Review Lanes panel reads the server only for a chosen period or on "Count all time" (minor 4; GAP-101).

*DF-P19 fifth fix pass (2026-10-22, review major 1 and minor 2; DEC-29):* (a) **A code-class rule authored in Admin → Permissions now decides before the request-type rows.** Reproduced: stored `ticket.final_approve` `[{Engineer, Manager}, {Engineer, Manager} where requestType EWR]`; an Admin adds code class B313 → Engineer-3; `joinPolicyFromEditor` wrote the new row LAST (`conditionalRulesInStoredOrder` appended every new row), the save stamped it confirmed, and for an EWR request of class B313 the EWR row still decided (`["Engineer", "Manager"]`), while the panel, the save preview ("ONLY Engineer-3 … in force once saved") and this record said the class rule replaces the row above. Now `components/permissions/CapabilityPolicyEditor.tsx` `conditionalRulesInStoredOrder` puts a NEW code-class row before the first request-type / project / preserved rule (after any code-class rows already leading; with nothing stored as a rule list, code-class rows come first), so the Admin's rule answers `["Engineer-3"]` for EWR, DCN and every other type of class B313, and the EWR row still decides EWR requests of any other class. A STORED code-class rule keeps its place — a save never reorders stored rules (item 8 of `DEC-44 (DF-P19-ticket-resource-dimensions)`) — and the new pure `rulesDecidingBeforeClassRule(cap, entry, codeClass)` names the conditional rules ahead of it that can match a request of that class (every rule that does not name only other code classes); the row says "does not apply where … — that rule sits ahead and decides first (to put this rule first, an Admin removes it, saves, and adds it again)" and the save preview adds "except where …". The panel copy now says the first matching rule decides and a new code-class rule is written ahead of the request-type and unit rules. With an in-force code-class rule already leading, a DocCtrl's new code-class row goes after it, so `inForceTicketRulesShadowed` accepts it; where an in-force rule sits behind a request-type / unit / preserved rule, a DocCtrl's new code-class row would land ahead of it and the route refuses it (403, as for any rule ahead of an in-force one) — the editor's message says an Admin adds it there. *(Superseded at the DF-P19 merge-time fix pass, below: the new row now goes after every stored rule that can match its requests, and a rule that cannot match the in-force rule's requests does not count as ahead of it.)* (b) **This record's claim** (review minor 2): the Resolution's first line now says the Status rests on the "Requires engineering" limb, and done-when 1 carries a correction stating where the reviewer-group limb holds. Tests: `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` "fifth fix pass (review major 1)" (the reviewer's EWR + B313 case through the editor's split / join, the server's carry and the evaluator — an Admin's rule binds for EWR, DCN and ISO, a Manager refused, the EWR row still decides other classes, the engine's ticket resource agrees; a DocCtrl's unconfirmed row only adds and shadows nothing; a new row after a leading in-force one passes the shadow check; nothing stored → code-class rows first; a stored rule behind EWR / unit rules keeps its place and `rulesDecidingBeforeClassRule` names exactly the rules the evaluator lets decide first — *corrected at the DF-P19 merge-time fix pass (DEC-29, review minor 2): it did not; it also named an UNCONFIRMED rule ahead as deciding first, while the evaluator scans past such a rule and joins its roles (and on `ticket.engineer_gate_exempt` ignores it); it now names in-force rules only, and the console describes an unconfirmed one by what it does*; the console's wiring and copy), and the second-fix-pass ordering case re-pinned (a new row ahead of the stored unit rule).

**Scope / residual (fifth fix pass).** A code-class rule stored behind a request-type / unit rule before this pass (by the API, or by this branch's console before the fix — DF-P19 has not deployed) is not moved: it is named on its row, and an Admin moves it by removing it, saving and adding it again (*merge-time fix pass:* the re-added rule goes ahead of the request-type / unit rules unless a stored rule that can match its requests sits behind one of them; it then goes after that rule, and the row still names what decides first). Rules naming several classes, and library- / work-class rules, stay preserved verbatim in their stored place (not authored — no done-when asks for them). DEC-90 ruling (3) for the list / inbox / badge ~~stays with the integrator, as above~~ — *accepted by the integrator at the DF-P19 merge (parity with the route; the server's answer is authoritative), as above.*

*DF-P19 merge-time fix pass (2026-10-22, the independent review of `b726c45`, minors 1–3 and nits 4–6; DEC-29):* (a) **A new code-class row no longer cancels a stored rule** (minor 1). Reproduced: stored `ticket.final_approve` base `{Engineer, Manager}` + a confirmed `{Admin}` rule for library L1; an Admin adds class B16 → `{Engineer, Manager}`; the fifth pass wrote the row ahead of the L1 rule (before the first rule of any other kind), so L1 requests of class B16 went from Admin-only to Engineer / Manager with nothing in the save preview. Now `components/permissions/CapabilityPolicyEditor.tsx` `classRuleSlot` puts a new code-class row after every stored rule that can match a request of its class (`lib/capabilityPolicy.ts` `rulesCanOverlap` — a library rule, any rule naming that class, any rule whose `when` does not exclude it) and ahead of every request-type / unit rule; it is written just ahead of the first request-type / unit rule (the rules between cannot match a request of its class, so every request decides as at the earliest such slot, and the stored rules ahead keep their order). Where a rule that can match sits behind a request-type / unit rule, the new row goes right after it, and the row note and the save preview name the rules that decide first for it. The panel copy says this. (b) **What the console names as deciding first** (minor 2): `rulesDecidingBeforeClassRule` now returns in-force rules only (`ruleInForce`); `classRuleAheadNote` describes an unconfirmed rule ahead as adding its roles to the code-class rule's answer until an Admin confirms it — and, on `ticket.engineer_gate_exempt`, as doing nothing until then — matching `effectiveTokens`. (c) **A rule that cannot match the same requests does not shadow** (minor 3): `inForceTicketRulesShadowed` now compares, for each in-force library / class rule, only the rules ahead of it that can overlap it (disjoint code classes, libraries, request types, units or work classes where both rules name the key cannot); anything not ruled out still counts. A DocCtrl adding class B16 ahead of the EWR rule, with a confirmed B313 rule behind it, is accepted; a rule ahead that can reach a B313 request is still refused (403). (d) The refusal's wording is one function, `inForceTicketRulesShadowedRefusal`, used by the route and the console (nit 4). (e) `confirmTicketDimensionRule` confirms the first UNCONFIRMED stored rule with the key, and answers "already in force" only when every copy is (nit 6); with the same duplicate case in view, `carryTicketRuleConfirmation` carries the n-th stored copy's stamp to the n-th copy saved (before, every copy took the first stored copy's, so an unconfirmed copy ahead stripped a confirmed one behind it on any save) and `inForceTicketRulesDropped` counts copies the same way. A workspace with no library / class rule decides exactly as before (none of these paths acts on any other rule). Tests: `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("merge-time fix pass (review minor 1)" — the L1 example keeps the L1 rule deciding first, a stored `{B313, EWR}` rule stays live after a plain B313 rule is added, a can-match rule behind a request-type row, the slot rule, the fifth-pass pins; "(review minor 2)" — an unconfirmed rule ahead on `ticket.final_approve` and on `ticket.engineer_gate_exempt`; "(review minor 3)" — B16 vs B313 accepted, overlapping cases refused; "(review nit 6)"); `lib/__tests__/sweepRoundE_policyServer.test.ts` ("DF-P19 merge-time fix pass (review minor 3)" — through the route: the console's B16 save accepted for a DocCtrl, an overlapping rule ahead refused with the shared wording).

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
- **A routing table adds reviewers; it never drops the org-wide engineering gate** (DEC-13 stage 3 / DEC-16 / DEC-36). Before the fix a library table of one requester slot let a Planner's request reach `PENDING_IFC` with no engineer involved. Now, when the gate applies to the ticket — `lib/workflow.ts` `engineerApprovalRequired` (the requester's snapshot or current collection, under the org's `ticket.engineer_gate_exempt` list) or an engineering-first type — and the table carries no BLOCKING slot filled by an engineering capability, `lib/ticketRoster.ts` `withEngineeringGate` (`:320`, called by `openRoster`) appends the seed's engineering slot, independent of the drafter, the management tier as override. *Corrected at the DF-P5 fix pass 5 (DEC-29): as landed in fix pass 2 the slot was filled by the assigned engineer AND every `ticket.final_approve` holder (`resolveFill` takes the union), so on a ticket with an assigned engineer every engineer was told and any of them could sign — the gate was kept but widened, not kept "as on the serial path". Now the slot names the assigned engineer ONLY when one is on the ticket (the serial path's `canActHere` admits no other engineer); it fills by `ticket.final_approve` only when none is assigned; an assigned engineer who is no longer an active member leaves it empty and `openRoster`'s management fallback stands in. The slot keeps `engineering: true` either way (`openRoster` marks the appended gate slot by kind). Pinned by "fix pass 5: an assigned engineer is the slot's ONLY primary …" in `dfRoundG_P5_routing.test.ts`.* The roster records `engineeringGateAdded`, and the history line, the audit row (`reviewRoster.engineeringGateAdded`) and the panel (`ENGINEERING_GATE_NOTE`) all say so. A role-named slot is never guessed to be engineering (DEC-35), so the gate slot is still appended beside it, and one engineer's single sign-off fills both (DEC-37).
- **Library routing is controller-only** (`20261241`'s guard): the library owner / node-manager limb is gone, as the folder and document limbs went at the first fix pass. A drafting lead who owns a library can no longer swap that library's reviewers.
- **A package too large or too slow to fingerprint is no longer refused.** Before, a 240 MB set got "upload it again", which can never help. `lib/ticketRoster.ts` `rosterBinding` (`:231`) now binds such files by identity (storage key and recorded size, `unhashed: <reason>`), and they are named on the panel and in every sign-off statement (`lib/workflow.ts` `unhashedFilesNote`). A storage outage still refuses (503, try again), and so does a file that is not in storage (409, replace it).
- The completing sign-off's audit row names what was approved (`approvedDrafts` from the roster's files, with sha256 or the reason) and, when issued as-is, the Final it recorded (`issuedAsIsFinals`). It is notified as an approval (`classifyTransitionNotification` `rosterCompleted` → `ticket_approved`). `lib/routingControl.ts` `isMissingRoutingSchema` reads "not pasted" only from an error that names `routing_control`; a 42703 for another column fails closed.

DF-P5 fix pass 3 (same day, third review — a ticket's WHOLE review life in a routed library, not only a fresh submission):
- **A close out of a review closes its roster for good.** `computeTransition` closes an open roster on any exit from `PENDING_REVIEW` (closedAt, open slots void), but the route's CLOSED branch rebuilt `metadata` from the stored row for its deliverable note (`noteDeliverableNotInRegister` / `noteDeliverableNotInLibrary`), and a routed ticket always takes one of those branches. A force close therefore stored the roster still open, and `reopen_ticket` brought back the previous cycle's roster with its sign-offs. Every CLOSED branch now builds on the transition's metadata (`app/api/tickets/workflow-action/route.ts`, `closeMeta`).
- **A routed review never runs without a roster.** A ticket in a routed library that is in review with no roster (reopened, or already in review when the table was declared) is not approved on the serial path. `approve_draft_ifc`, `approve_minor_correction`, `request_final_engineer_approval` and `engineer_approve_final` (`lib/workflow.ts` `ROSTERLESS_APPROVALS`) are refused with `409 routing_needs_roster` and the way forward (`ROUTED_NO_ROSTER_REASON`: request a revision, and the resubmission opens the roster). Nothing is written. The route reads the routing only for those approvals on such a ticket (`lib/routingControl.ts` `ticketReviewRouting`: the source document's folder, the chain, then the ledger probe). A read that fails is a 503. Before `20261242` is pasted (no ledger) the usual review stands, as for a submission. The request page asks the same question through RLS, and the engine renders those approvals disabled with the reason (`WorkflowContext.reviewRouted`). Tickets already in review when a table was declared are deliberately NOT left on today's path: they fail closed as well (DEC-36) and go through a revision.
- **A partial sign-off is not a hand-off.** `sign_slot` that leaves the roster open now keeps every open blocking slot's occupants in `unread_by` (with the existing markers and today's participants, never the signer) — `lib/ticketTransitions.ts` — and the route's fan-out retires only the signer's own "please review" alerts (`fanOut` `rosterPartial`), so a reviewer still waited on keeps their alert and is told of the sign-off.

Tests (fix pass 3): `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("major 1: a FORCE CLOSE of a routed ticket under review stores the roster CLOSED …", "major 2: a reopened ticket in a routed library is NOT approved on the serial path …", "major 2 (route): the route resolves the routing itself …" incl. the 503 and the pre-20261242 cases, "REGRESSION: a library with no routing table approves on the serial path exactly as today", "major 3: a PARTIAL sign-off keeps every still-waited-on reviewer unread …", "major 3 (REGRESSION): the COMPLETING sign-off still retires every outstanding alert"); `lib/__tests__/dfRoundG_P5_routing.test.ts` ("DF-P5 fix pass 3 — …", four cases). The major-1 and major-3 route tests fail with the fix reverted (checked).

DF-P5 fix pass 5 (same day, fifth review — the full suite green again, and the gate exactly the serial path's):
- **The page's 409 branch keeps `setActionLoading(null);` as its first statement**, so DF-P9's PERS-7 ordering pin (`dfRoundG_P9_ticketPage.test.ts` "PERS-7 fix pass …") finds its anchor again; the `workflowRefusalMessage` read moved just above the alert. *Corrected (DEC-29): fix pass 4 never finished the full suite, and that pin failed at `c8d306d`.*
- **The engineering gate slot names the assigned engineer only** (see the correction on the gate bullet below).
- **The panel re-posts a sign-off only on the compare-and-set conflict** (`postSignOffOnce`): a code-less or coded 409 is not re-posted, so the route's `recordRefusedSignOff` writes one `TICKET_SIGN_SLOT_NOT_APPLIED` row per refused signature, not two.
- **An active alternate is not released** by a partial sign-off (see the correction on the partial sign-off bullet below).

Tests (fix pass 5): `lib/__tests__/dfRoundG_P5_routing.test.ts` ("fix pass 5: an assigned engineer is the slot's ONLY primary …" — primaries `[assigned]`, an unassigned engineer offered nothing, the inactive-engineer fallback; "fix pass 5: a co-occupant who is an ACTIVE alternate …" — kept after the timeout, released before it, kept in `unread_by` by `computeTransition`); `lib/__tests__/dfRoundG_P5_rosterPanel.test.ts` ("DF-P5 fix pass 5 — the panel retries a sign-off only on the compare-and-set conflict", three cases; the major-1 page pin now anchors on `setActionLoading(null);` first).

DF-P5 fix pass 4 (same day, fourth review — the refusal, the editor and the panel say what is true):
- **The refusal reaches the person with its reason.** *Corrected (DEC-29): fix pass 3 said the routed-without-roster refusal reaches the user "with the way forward". It did not. The request page read a 409's body only for `holds_open` and showed every other 409 as "someone else updated it", so `ROUTED_NO_ROSTER_REASON` appeared only when the page's own RLS read agreed with the server.* `app/(protected)/requests/[id]/page.tsx` now passes the body to `lib/workflow.ts` `workflowRefusalMessage`. A 409 that carries its own code (`routing_needs_roster`, `issue_as_is_unconfirmed`, `routing_invalid`, `routing_no_files`, `content_unhashable`, a roster's own codes) is shown with its reason. Only the compare-and-set conflict (`conflict: true`), `holds_open` (handled before) and a code-less 409 keep "someone else updated it".
- **A routing table that cannot be used is named.** `ticketReviewRouting` counts an `invalid` chain as routed, but a revision is refused there too (`routing_invalid` at submit), so "request a revision" was the wrong advice. The route now answers such an approval `409 routing_invalid` with `lib/workflow.ts` `routedNoRosterReason(routing)`, which names the level, the error and the document controller. The page passes the same reason to the engine (`WorkflowContext.reviewRoutedReason`) and to the panel.
- **The panel no longer shows the unconfigured seed on a routed review with no roster.** `components/requests/TicketRosterPanel.tsx` takes `reviewRouted` / `reviewRoutedReason` from the page and renders "No sign-off roster" with the reason instead of `seededSlotsFor`'s serial picture.
- **The routing editor says what a saved table does.** *Corrected (DEC-29): `components/documents/RoutingControlSection.tsx` said "It applies from each request's next submission for review", but since fix pass 3 a saved table immediately stops the serial approvals of every rosterless request already in review under that level.* The save note (`routingSavedNote`) now says so. Declaring a table on a level that had none first counts those requests (`lib/routingControl.ts` `reviewsInFlightUnder`: a library's own; a folder's by its source documents' folders and `path_ids`; a document's own; all through RLS, at most 500 then "at least"). The editor shows the number and asks before saving (`inFlightConfirmMessage`). A count that fails is said, and the editor still asks.
- **A partial sign-off releases the co-occupants of the slot it satisfied.** *Corrected (FRIC-2's audience): fix pass 3 kept every occupant ever added in `unread_by`.* `lib/ticketTransitions.ts` `rosterPartialReleased` names the satisfied slots' primaries, less anyone an open blocking slot still waits on, today's participants and the signer. *(Fix pass 5: "still waits on" includes the ALTERNATES of an open blocking slot whose alternate window has opened — `lib/workflow.ts` `slotAlternatesActive`, the rule `slotSignPlan` uses — so an active alternate who co-occupied the satisfied slot keeps their marker and alert.)* They leave `unread_by`, and the route retires their action alerts with the signer's (`fanOut` `rosterReleased`). So that sign-off notices do not pile up, an earlier partial sign-off's notice (`metadata.action = sign_slot`) is retired for anyone this one tells again; their "review opened" alert stays live.

Tests (fix pass 4): `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("DF-P5 fix pass 4 — a refusal reaches the user with its reason …": the route's 409 `routing_needs_roster` body through `workflowRefusalMessage` gives `ROUTED_NO_ROSTER_REASON`, and the conflict / `holds_open` / code-less bodies keep the old message; the `routing_invalid` reason; "major 3: a PARTIAL sign-off …" now pins e-2 released and the alerts not piling up; "DF-P5 fix pass 4 (major 2) — the routing editor counts …", library / folder / sub-folder / document and the failed read); `lib/__tests__/dfRoundG_P5_routing.test.ts` ("DF-P5 fix pass 4 — after a partial sign-off …", two cases); `lib/__tests__/dfRoundG_P5_rosterPanel.test.ts` ("DF-P5 fix pass 4 — …", five cases: the page's 409 branch, the panel's routed-without-roster state rendered, the page's props, the save note, the confirm before the write).

Tests (fix pass 2): `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("DF-P5 fix pass 2 — a routing table adds reviewers; it never drops the org-wide engineering gate …", five cases incl. "the reviewer's scenario …"; "a routed package over the request's byte budget is NOT refused …"; "EVID-12 done-when 3 on a roster …"; "DEC-36: a 42703 naming ANOTHER column …"; "before 20261242 (the ledger missing: PGRST205) …", now with postgrest-js's real HEAD behaviour in the stand-in); `lib/__tests__/dfRoundG_P5_routing.test.ts` ("withEngineeringGate …", "… bound by identity, not refused …"); `lib/__tests__/rls/dfP5RosterRouting.test.ts` ("DF-P5 fix pass 2: the library's OWNER cannot set or clear the library's routing …").

Tests: `lib/__tests__/dfRoundG_P5_routing.test.ts` ("TIER-5 done-when 1…", "completion CALLS … evaluateSlotCompletion", "TIER-5 done-when 3…", "TIER-5 done-when 2…", "DF-P5 fix — DEC-12 / DEC-37 acceptance 2 …", "DF-P5 fix — a completed roster records the engineering approval …", the ledger writer's 0-row case); `lib/__tests__/dfRoundG_P5_rosterRoute.test.ts` ("TIER-5: the first sign-off keeps the status (one wait); the second — in either order — issues the ticket automatically", "REGRESSION: reopening a closed ticket in a routed library with NO Draft …", "a table with no independent_of: the drafter's sign-off is refused …").

**Done-when.**
- ✓ (1) Two required reviewers sign in either order, or at the same time: each is offered their slot while the other's is open, and two concurrent sign-offs are serialised by the ticket's compare-and-set (the loser's `409 conflict: true` is retried once by the panel on the fresh row — fix pass 5: only that conflict; any other 409 is shown as is, so a refused signature is recorded once, `TicketRosterPanel.tsx` `postSignOffOnce`) — neither waits for the other.
- ✓ (2) The ticket advances automatically when the last required signature lands (`PENDING_IFC`, or `FINAL_DRAFT` when the drafter marked it issue-ready — `FRIC-5`).
- ✓ (3) Adding a reviewer adds no status: a two- or three-slot roster is one `PENDING_REVIEW`.
- These hold for a ticket's whole review life in a routed library, not only a fresh submission (fix pass 3). A close voids the roster, a reopen cannot revive it, a rosterless review cannot be approved serially, and a partial sign-off leaves the remaining reviewers told and alerted. *(The fix pass 2 claim "holds on routed libraries" was overstated for reopened tickets — DEC-29.)* Since fix pass 4 the refusal reaches the person with its reason (on the page's 409 path, not only when the page's own read agrees), a broken table names the document controller, and the routing editor counts and asks before a table stops the requests already in review. *(Fix pass 3's "with the way forward" was overstated until then — DEC-29.)*

**Pending migration:** `20261241_df_roundG_routing_control.sql` and `20261242_df_roundG_ticket_roster.sql` (DEC-30 — the code half is what is RESOLVED; until both are pasted every ticket takes today's path: a `routing_control` read answers 42703 / PGRST204 naming that column → unconfigured, a missing ledger answers 42P01 / PGRST205 → the submission goes the usual way and says so). Either paste first in SQL, but **paste `20261242` before (or together with) `20261241`**. *(Corrected at the DF-P5 fix pass 4, DEC-29: with `20261241` pasted and `20261242` not, a submission into a routed library goes the usual way with a warning, and pasting `20261242` afterwards makes that ticket routed with no roster, so its serial approvals are refused and it needs a revision. Pasting `20261242` first leaves no such ticket.)* *(Corrected at the DF-P5 fix pass 2: the ledger probe was a HEAD request, and postgrest-js maps PostgREST's body-less 404 for a missing table to success, so with 20261241 pasted and 20261242 not yet a roster opened anyway and every ledger write failed. The probe is now a GET (`.select("id").limit(1)`), which carries the PGRST205 body; the route test's stand-in reproduces postgrest-js's real HEAD behaviour. DEC-29.)* Both exercised on PostgreSQL 16 (`lib/__tests__/rls/dfP5RosterRouting.test.ts`, 13 cases, incl. the library owner refused (fix pass 2)).

**Scope / residual.** An org that has configured no routing table keeps today's serial machine byte-for-byte — DEC-90 ruling (2) for this package. A routed library changes who reviews and in what order, but never removes the org-wide engineering gate (fix pass 2, above); the seed (`SEEDED_ROUTING`) only describes it and is pinned against the engine. The ticket shed (`lib/ticketShed.ts`, DF-P11's) archives a ticket's row and deletes it, and the roster ledger cascades with it (`20261242`, `ON DELETE CASCADE`, as `ticket_comments` does); the archive bundle carries `metadata.review_roster` (the row), not the ledger rows — **for the integrator**: whether the shed bundle should carry `ticket_review_slots` / `ticket_review_slot_events` too (owner: the next package holding `lib/ticketShed.ts`). The attention badge (`hooks/useTicketNotifications.ts`, N11's) badges a slot occupant when its mapper carries `metadata` (the engine derives `sign_slot` from the ticket alone).

---

## TIER-6 · MOC is captured at check-in and re-typed at publish, with no link between them

- **Severity:** MEDIUM
- **Status:** RESOLVED (2026-10-22 — the hand-back limb built by DF-P18; the check-in limb closed by the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90: a check-in files the request before triage classifies it, so no work class exists at check-in time)
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL. The work-class mechanism now exists (`GAP-101`: the workspace's own `workClasses`, set at triage, stored in `tickets.work_class`, read by the engine and the routing table). MOC applicability is still its own rule — `mocRequirementFor` at check-in (`lib/checkinOutcomes.ts`) and `RevUpModal`'s `mocRequired` — not expressed through a class.

**Done-when.**
- ✓ See `LIFE-5` (as recorded above).
- ✗ "MOC applicability is expressed through the same work-class mechanism" — the mechanism exists; wiring MOC to it (a class carrying "needs MOC", read by the check-in and the hand-back) is not done: both readers are outside DF-P6's files (`lib/checkinOutcomes.ts`, `components/documents/RevUpModal.tsx` — the latter a document-control file).

**Scope / residual.** → proposed for the integrator to assign (no package in the fleet plan lists it; a follow-up beside DF-P17 is the natural home). Stays OPEN.

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS** (after its class select: a configured work class may carry "needs MOC", read by the check-in outcome and the hand-back).

**Partial (2026-10-21, drafting-flow Round G).** DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — the "additionally" clause, hand-back limb. *(Recorded as a Resolution until the DF-P18 fix pass 2 — review minor, DEC-29: the brief's "read by the check-in outcome" limb does not hold, so the finding stays OPEN.)* Reproduced on the base: MOC applicability was two separate rules — `mocRequirementFor(docClass, outcome)` at check-in (`lib/checkinOutcomes.ts`) and `mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike` in `components/documents/RevUpModal.tsx` — and neither read the work class. Landed:
- A configured WORK class may carry "Needs MOC" (`lib/reviewModel.ts` `ReviewClassFlags.moc`, edited on Admin → Request forms, `components/requests/ReviewClassesSection.tsx`; stored on the option in `org_configurations` `'drafting'`, no migration; a code class carries none).
- One rule, in `lib/checkinOutcomes.ts`: `mocRequirementFor(docClass, outcome, classNeedsMoc)` (a real change for a request of a needs-MOC class needs an MOC position whatever the document's class; a correction card stays "none") and `publishMocRequired({ docClass, docClassUnknown, changeType, classNeedsMoc })` (the hand-back's publish asks for the MOC number whatever the change type). `RevUpModal` reads `publishMocRequired` (`RevUpModal.tsx:296`, `mocRequired`; new optional prop `classMoc`, its label in the field and the refusal), and the request page passes the class only when it needs MOC (`workClassNeedingMoc` → `classNeedingMoc`, `page.tsx:2482`, passed as `classMoc` at `:2558` — *re-anchored at the DF-P18 merge, the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90*). `CheckInContext.classNeedsMoc` lets the check-in cards take the class, but no caller passes one yet (*corrected at the DF-P18 fix pass, DEC-29*).
- DEC-90 ruling (3) for DF-P18: a request with no class, or of an unflagged class, gets exactly today's rule — pinned for every document class × outcome × change type, and the check-in cards deep-equal today's with the flag absent or false.

Tests: `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts` ("TIER-6 — MOC applicability through the class", incl. the two REGRESSION pins); `lib/__tests__/dfRoundG_P18_reviewModelPageRender.test.ts` (the editor writes the flag and keeps the rest); `lib/__tests__/checkinOutcomes.test.ts` unchanged and green.

**Done-when.**
- ✓ See `LIFE-5` (as recorded).
- ✓ (hand-back limb) "MOC applicability is expressed through the same work-class mechanism": the class the workspace configures and triage sets carries "Needs MOC", and the hand-back reads it (`RevUpModal` via `publishMocRequired`, given the class by the request page).
- ✗ (check-in limb) "read by the check-in outcome" (the DF-P18 assignment): the check-in cards' engine takes the class through the same rule (`mocRequirementFor(…, classNeedsMoc)`), but no caller passes it: `components/documents/CheckInPanel.tsx` passes none, so no check-in asks for an MOC position because of a class. Not done here because `CheckInPanel` is document-control's file (DEC-31 / the fleet rule).

**Scope / residual.** No check-in today has a classed request in its context: a check-in FILES the request, and triage classes it afterwards; the hand-back is where a classed request's MOC is asked. The check-in panel, `components/documents/CheckInPanel.tsx`, is not this package's file and passes no class; the engine takes one when a caller has it. **Open limb:** wiring `CheckInPanel` to pass `classNeedsMoc` (for a check-in that resumes or names a request already classed). **Owner: the integrator assigns it (DEC-31)** — the natural holder is document-control, which owns `components/documents/CheckInPanel.tsx` (row in `99-fix-sequencing.md` "Hand-offs from DF-P18"); or the integrator rules the limb closed (a check-in files the request before triage classes it), and this finding then closes against that ruling. Until one of the two, `TIER-6` stays OPEN. No migration.

**Resolution (2026-10-22, by the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90).** The check-in limb is closed by ruling: a check-in FILES the request before triage classifies it, so no work class exists at check-in time and the limb cannot apply; the MOC rule applies wherever a class exists — the request page's hand-back (`RevUpModal`, given `classMoc` by the request page; the Partial above). No code changed for this ruling, and what the code does stays as recorded: `components/documents/CheckInPanel.tsx` passes no `classNeedsMoc`, so no check-in asks for an MOC position because of a class (the panel files a new request; it never opens an existing one); `lib/checkinOutcomes.ts` `mocRequirementFor(…, classNeedsMoc)` / `CheckInContext.classNeedsMoc` would take a class if a caller ever had one. The other `RevUpModal` mounts (the check-in panel's publish, the library page, `components/documents/lifecycle/ModifyDocumentRouter.tsx`) carry no request, so no class exists there either and they keep today's rule.

**Done-when.**
- ✓ See `LIFE-5` (as recorded).
- ✓ (hand-back limb) As recorded in the DF-P18 Partial above: the class the workspace configures and triage sets carries "Needs MOC", and the hand-back reads it.
- ✓ (check-in limb — closed by the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90) "read by the check-in outcome": not wired (`CheckInPanel` passes no class), and it cannot apply — no work class exists when a check-in files the request.

**Scope / residual.** None. The `TIER-6` row in `99-fix-sequencing.md` "Hand-offs from DF-P18" is closed by the same ruling (no owner needed). No migration.

---

## TIER-7 · "Approve with Minor Correction" is the only tiering the system actually has, and it bypasses the gate

- **Severity:** MEDIUM
- **Status:** RESOLVED (closed by ruling — the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90, under DEC-90 ruling (3) for DF-P18; the done-when does not hold as written: the button is not made to require a flagged class, and a flagged class adds a note and an audit key, not a reviewer requirement of its own)
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL. Reproduced on the base: `lib/ticketTransitions.ts` `approve_minor_correction` gave the same terminal effect as `approve_draft_ifc` and, at `PENDING_FINAL_APPROVAL`, stamped `engineer_approved_at` for whoever pressed it. *Corrected at the DF-P6 review fix pass (DEC-29): this block first read "Resolution" with the Status RESOLVED and said the button is offered on an engineering-required request "only to whoever may sign for engineering" — that was false (below).*

Landed — the fast path is kept and governed, not deleted (99-fix-sequencing "Do not"): the requester's minor correction follows the same gate as every issue transition (`engineeringGateRequired` — a requester holding no Engineer role on a request that requires engineering is not offered it; they send for an engineer). A management or `ticket.direct_approve` co-reviewer holding no Engineer role IS offered it at `PENDING_REVIEW` on such a request — as a recorded override (`engineeringOverride`, the history note, `authority.override`), exactly like their approval to IFC; at final approval a manager who is not the engineer gets it as an override that does NOT stamp `engineer_approved_at` (SM-3), and the requester's own such override is refused in orgs of 3+ (the TIER-1 fix pass). A workspace that wants a reduced reviewer set for its own "minor" changes declares it as a work class (`GAP-101`): a class that does not require engineering, on a declared like-in-kind request, issues through the assigner and requester; one marked "Requires engineering" keeps the engineer.

Tests: `lib/__tests__/reviewModel.test.ts` ("REGRESSION …" pins `approve_minor_correction` per transition; "the override issues … a management minor correction at final approval …"); `dfRoundG_P6_reviewRoute.test.ts` "a Supervisor's minor correction at final approval is an override too …".

**Done-when.**
- ✗ "A minor correction is a work class with its own reviewer requirement" — not met as written. The button no longer bypasses the requirement silently (the requester is gated; everyone else's use on an engineering-required request is a recorded override, never an engineer's sign-off), but no class carries a reduced reviewer set: the audit row's `declaredClass: "minor_correction"` is a label, not a class.

**Scope / residual.** Owner: drafting-flow **DF-P9** with the class select (`TIER-2`) — a class the workspace flags "minor correction" that the button requires, with that class's reviewer set — or an integrator ruling that the recorded override closes it. No minimum-length or new prompt was added to the minor correction (a regression for today's users). A built-in "minor correction" class is NOT seeded (DEC-35: the workspace names its classes). Stays OPEN.

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31; DF-P9, the package first named, merged on 2026-10-14):* → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS** (with the class select: a class the workspace flags "minor correction" that the button requires).

**Resolution (2026-10-21, drafting-flow Round G).** DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS, under DEC-90 ruling (3) for DF-P18 ("'minor correction' flags change nothing for a request with no class or an unflagged class"). Reproduced on the base: the audit row's `declaredClass: "minor_correction"` was a label; no class could be a minor correction. Landed:
- A configured WORK class may be flagged "Minor correction" (`lib/reviewModel.ts` `ReviewClassFlags.minorCorrection`, edited on Admin → Request forms; no migration). Its reviewer requirement is the class's own: its "Requires engineering" flag (raised at triage) and the notify-only routing slots limited to it (`TIER-3`) — the requirement any work class carries; the minor-correction flag adds none of its own (*clarified at the DF-P18 merge, DEC-29*).
- On a request OF such a class, "Approve with Minor Correction" is named as taken under the class before the click — the request page says `minorCorrectionClassNote` beside its buttons (`data-testid="minor-correction-class"`, only when the action is offered), and the workflow route adds the same note to the action's description (`withMinorCorrectionClass`, `route.ts:633`, `offeredActions`) — and the audit row records `minorCorrectionClass` beside `declaredClass` (`route.ts:1626`) (*re-anchored at the DF-P18 merge, the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90*). Nothing is enabled, disabled or removed: the engine's gate (DF-P6) still decides who may take it.
- For no class, an unflagged class or no configuration the action list is the SAME array and the audit row is today's (no key) — pinned at the engine (`withMinorCorrectionClass` returns its input) and at the route.
- The plan's limb "the button requires a request of such a class when the workspace flags any" is NOT built: on an unclassified or unflagged request it would take away a button a legitimate user has today, which ruling (3) forbids (`DEC-44 (DF-P18-review-model-page)` item 1).

Tests: `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts` ("TIER-7 / TIER-6 — what a configured work class carries", incl. the REGRESSION identity pin); `lib/__tests__/dfRoundG_P18_reviewModelPageRoute.test.ts` ("TIER-7 (DF-P18)": the class named in the row; REGRESSION for no class / unflagged / no configuration); `lib/__tests__/dfRoundG_P18_reviewModelPageRender.test.ts` (the editor flag).

**Done-when.**
- ✗ as written — closed by DEC-90 ruling (3). "A minor correction is a work class with its own reviewer requirement, not an unconditional button that bypasses whatever requirement applied." What the code does: a work class flagged "Minor correction" adds a note to "Approve with Minor Correction" on a request of that class — beside the page's buttons (`minorCorrectionClassNote`) and in the route's action description (`withMinorCorrectionClass`) — and the audit row records `minorCorrectionClass`. What it does not do: the flag carries no reviewer requirement of its own (the class's requirement is whatever any work class has — its "Requires engineering" flag and the notify-only slots limited to it), and the button is not made to require a flagged class — on an unclassified or unflagged request, and in a workspace that flags no class, it is offered exactly as on the base. That button bypasses nothing (DF-P6: the requester is gated; anyone else's use on an engineering-required request is a recorded override). Closed by the integrator's ruling at the DF-P18 merge, 2026-10-22, DEC-90, under DEC-90 ruling (3) for DF-P18: making the button require a flagged class would remove a governed path that works today, which the no-regression rule forbids; the class flag records the classification where a workspace uses it. *(Corrected at the DF-P18 merge, DEC-29: this line had read "✓ (as amended by ruling)", claiming more than the code does.)*

**Scope / residual.** None — closed by ruling; nothing is assigned. No migration.

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
