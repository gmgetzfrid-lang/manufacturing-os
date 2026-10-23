# 90 · Gap register — build specs

**14 capabilities the drafting flow needs and does not have**, plus two
remainders opened by DF-P25 (2026-10-22): `GAP-115` and `GAP-116`, both owned
by drafting-flow DF-P26 — both RESOLVED by DF-P26 ISSUING-PATH STOPS
(2026-10-22; migration `20261268`, pending paste).

`GAP-110`–`GAP-114` were added after the review-model decisions
(`DEC-33`…`DEC-40`) and carry the facility's stated policy. **`GAP-110` and
`GAP-111` are the two that implement it**, and between them they are the
cheapest high-value work in this area — most of `GAP-111` is already built.

Numbered from **101** so they never collide with the `roles-and-permissions`
area's `GAP-1`…`GAP-15`.

> Build work. Each carries a verdict, scope, design direction, dependencies,
> acceptance criteria and a `Do not` list. Held to the evidence bar in
> [`../README.md`](../README.md) and `DEC-29`. Build order is in
> [`99-fix-sequencing.md`](./99-fix-sequencing.md).

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-101](#gap-101) | Work class on the ticket | **BUILD** | M | `WF-15` |
| [GAP-102](#gap-102) | QA/QC assurance with zero added stops | **BUILD_NARROW** | S | — |
| [GAP-103](#gap-103) | Parallel reviewer roster on the ticket | **BUILD** | L | `GAP-105` |
| [GAP-104](#gap-104) | Doc-control release routing per library | **BUILD** | M | `GAP-105`, `GAP-103` |
| [GAP-105](#gap-105) | Ticket → library binding | **BUILD** | S | — |
| [GAP-106](#gap-106) | SLA escalation that actually fires | **BUILD** | M | `LEAK-1` |
| [GAP-107](#gap-107) | Leak accounting — non-standard outcomes | **BUILD_NARROW** | S | `DEC-14` |
| [GAP-108](#gap-108) | "Where is my request" | **BUILD_NARROW** | S | — |
| [GAP-109](#gap-109) | Engineering review without a stop | **BUILD** | M | `GAP-101`, **`GAP-113`** |
| [GAP-110](#gap-110) | **The like-in-kind declaration** — the stated policy | **BUILD** | S | — |
| [GAP-111](#gap-111) | **The assigner's flag becomes binding** — 80% built | **BUILD_NARROW** | S | `GAP-110` |
| [GAP-112](#gap-112) | The routing table — no facility vocabulary in code | **BUILD** | M | `GAP-105` |
| [GAP-113](#gap-113) | The availability record — proving it was asked | **BUILD** | M | `LEAK-1` |
| [GAP-114](#gap-114) | Projects ↔ requests, by reference | **BUILD** | M | `GAP-105` |
| [GAP-115](#gap-115) | Exception-only review — `GAP-109` mechanism 3's remainder | **BUILD** (RESOLVED with one remainder — DF-P26; the committed base-route A/B pin, owner the drafting-flow integrator at the DF-P26 merge) | M | `GAP-109` |
| [GAP-116](#gap-116) | A notify-only hold that stops the request, not only its document | **BUILD_NARROW** (RESOLVED — DF-P26) | S | `GAP-102` |

---

## The friction ladder

**Every assurance mechanism has a cost measured in two currencies: waits and
touches.** They are not the same, and conflating them is how a review model that
looks cheap on paper becomes the thing people route around.

- A **wait** is elapsed time before the ticket can advance.
- A **touch** is a human being who has to stop what they are doing and act.

A parallel roster fixes waits and not touches. That distinction drove the
rewrite of `GAP-102`.

| Mechanism | Waits added | Touches added | Use when |
|---|---|---|---|
| Serial status per reviewer | **N** | **N** | Never. This is what the flow does today. |
| Parallel roster | 1 | **N** | The signature is genuinely the point — a code-governed new design |
| Silence-is-consent window | 1, **bounded by a clock, not a person** | **0** in the happy path | The reviewer needs the chance to object, not the obligation to bless |
| Standing pre-authorization | **0** | **0** | Recurring known work an engineer has already ruled on |
| Completeness gate on a field | **0** | **0** (whoever is already in the flow fills it) | The need is *data present*, not *judgement rendered* |
| Notify + stop-work authority | **0** | **0** unless exercised | The need is *visibility* and *a veto* |

**Read the ladder downward before adding anything.** The question is never "who
should review this?" — it is **"what is the cheapest mechanism that delivers the
assurance?"** Most requirements that present as reviews turn out to be data
completeness or visibility, and both of those are free.

Two mechanisms at the bottom of the ladder **already exist and are already
universal**, which is why `GAP-102` and `GAP-109` are `S` and `M` rather than
`L`:

- `holds.open` / `holds.release` default to `["*"]` (`lib/capabilityPolicy.ts:85-88`)
  and a hold is a hard block enforced in three layers
  (`lib/documentGuards.ts:109-125`). **Stop-work authority for everyone, costing
  nothing when unused.**
- `lib/subscriptions.ts` supports watching a `"library"` with follower fan-out.
  **Standing visibility, costing nothing.**

### What the work class is actually for

`GAP-101` reads like it exists to *add* review tiers. It does not.

**It exists to let you remove them.** Silence-is-consent is safe for a
like-in-kind swap and unsafe for a new tie-in in a hazardous service. Standing
pre-authorization is safe for a standard detail and unsafe for a novel one. You
cannot skip a review you cannot classify — so the classification is the thing
that makes *most* work cheap, not the thing that makes *all* work expensive.

---

<a id="gap-101"></a>
## GAP-101 · Work class on the ticket

**Verdict: BUILD** · Effort: **M** · Depends on: `WF-15`

> ### ⚠ Revised by `DEC-33`. Read this before the spec below.
>
> An earlier version of this spec said the class is set **at triage, not at
> intake**, and listed *"requiring the requester to classify"* as deliberately
> out of scope. **That is now wrong**, and an agent following it would build
> something that violates the facility's stated policy.
>
> The policy, verbatim: *"only use engineered packages unless the requester has
> declared on request this is like-in-kind."*
>
> The reasoning that produced the old version was not wrong, it was answering a
> different question. Asking a requester to **pick a work class from a taxonomy**
> is expensive and they often cannot do it. Asking a requester to **declare one
> exception, with a safe default if they say nothing**, is one question whose
> unanswered state is both cheap and correct. See "Why this does not reintroduce
> `UI-5`" below.

### Scope

**In:** a persisted classification on the ticket that review requirements key
off, established as follows:

| Set by | When | What it does |
|---|---|---|
| **Requester** | Intake, optional | Declares like-in-kind. Removes the engineering requirement. Requires a typed statement (`DEC-34`). |
| **Nobody** | — | **Default: engineered.** No declaration means the rigorous lane. |
| **Assigner** | `PENDING_ASSIGNMENT`, optional | May add engineering back (`GAP-111`). **May never remove it.** |

**Out (deliberately):** a drawing-type taxonomy (P&ID vs isometric vs loop
sheet). `DCW-3` establishes that the **library** is the better routing proxy and
already has an inheritance mechanism. A second taxonomy would have to be kept in
sync with the first.

**Out:** a required intake field. The declaration is optional *because* its
absence is the safe answer.

### Design

**The default is the whole design.** A ticket with no declaration is engineered
work. That single fact means:

- The requester who does not understand the question is not blocked, not
  confused, and not routed into a lane they should not be in — they simply get
  the rigorous one.
- The form cannot be gamed by clicking through, because clicking through *is*
  the conservative outcome.
- No triage step is required for correctness. `GAP-111`'s assigner check is a
  safety valve on the declaration, not the thing that establishes the class.

Beyond the declaration, finer classes (`minor_correction`, and whatever a
facility adds) remain org-configurable and settable at assignment — but they
modulate routing **within** the two lanes the declaration establishes. They never
override it.

Prefill where hard evidence exists — a request carrying
`metadata.source_document` whose `docClass` is `drawing`, raised from a check-in
whose outcome was already `correction_requested` — and mark the prefill visibly
as a suggestion. `lib/docClass.ts` establishes this principle in this codebase
and it applies identically: **a suggestion is never enforcement**, and guessing
from filenames is explicitly rejected there as a way to misroute safety-critical
documents.

### Why this does not reintroduce `UI-5`

`UI-5` is the finding that submitting an incomplete request does nothing at all —
a bare `return` with no message and no field highlight. It is about **required
fields the user cannot satisfy and is not told about**.

The declaration is not that. It is optional, its unanswered state is valid, and
the consequence of leaving it blank is stated on the form in one line: *"Leave
this blank and the request goes to engineering."* Nobody is ever blocked by it.

**The one way to get this wrong** is to make the declaration required *or* to
make the finer work class required at intake. Both turn a safe default into a
wall. Do neither.

### Do not

- **Do not make the declaration required.** Its optionality is what makes it
  safe.
- **Do not let the assigner, an admin, or anyone else clear a declaration or
  lower the lane.** Only the requester's own declaration lowers rigor, and only
  at creation. See `DEC-33`.
- **Do not store it in `metadata`.** `CheckInPanel` already writes
  `metadata.moc`, `metadata.minor_correction` and `metadata.undocumented_change`
  (`components/documents/CheckInPanel.tsx:263-266`) and **nothing reads any of
  them for any decision.** Untyped JSON nothing enforces is a record, not a
  control (`DEC-34`).
- **Do not derive it from `changeType`.** That lives on `DocumentVersion` and is
  chosen at publish — weeks after the review decision needs to be made.
- **Do not build it before `WF-15`.** An authority-bearing classification keyed
  to unvalidated free text is a hole (`LEAK-3` shows what that already costs).
- **Do not reuse `request_type` for this.** They are different questions: *what
  kind of ask* versus *how much change*. Collapsing them is why `request_type`
  is currently overloaded and unvalidated.

### Acceptance

1. A ticket created with no declaration has `engineering_required = true`, and
   cannot reach IFC without the engineering slot satisfied — **including when the
   requester is a Manager, Admin or DocCtrl**. This is the `TIER-1` inversion.
2. A ticket created with a declaration reaches IFC with no engineer involved and
   **no additional wait state versus today**.
3. The declaration is immutable after creation and renders attributed on the
   ticket, the deliverable and the audit trail.
4. Leaving the declaration blank never blocks submission and never produces a
   silent no-op.
5. A report can count, for any period: tickets by lane, and every declaration
   with its author and text. This is the number that tells you whether the
   like-in-kind lane is being used honestly.

**Related findings:** `TIER-1`, `TIER-2`, `TIER-7`, `LEAK-3`, `UI-5`.
**Related gaps:** `GAP-110` (the declaration UI and storage), `GAP-111` (the
assigner's flag).
**Decisions:** `DEC-33`, `DEC-34`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL): `tickets.engineering_required` (`20261250`, pending paste — deploy the app first), the declaration (`GAP-110`), the workspace's own `workClasses` / `codeClasses` (seeded empty, set at triage, an engineering class raises the requirement). Acceptance 1 ✓ (Manager, Admin, Supervisor and DocCtrl pinned, engine and route); 2 ✓ (a declared request reaches IFC through its requester — no engineer, no added state); 3 ✓ in part — immutable for every caller (the guard, PostgreSQL 16) and rendered attributed on the request (`DeclarationCard`), in its history ("Declared like-in-kind (signed)") and in each transition's audit row (`likeInKindDeclared`); NOT on the issued deliverable's stamp (the stamp is public-surfaces' / DF-P15's file — proposed hand-off); 4 ✓ (blank never blocks; the form says blank goes to engineering); 5 ✗ — the columns make the report a query (lanes by `engineering_required` and declaration; every declaration with author and text), but no report surface is built — proposed for drafting-flow DF-P16's analytics page. See `TIER-1`, `TIER-2`, `TIER-7`.*

*Corrected at the DF-P6 review fix pass (2026-10-21, DEC-29): the classes are accepted by the route at triage, but no screen sets one yet (the assign modal's select → DF-P9, 99-fix-sequencing "Hand-offs from DF-P6"), so the class half of the lanes does not act in production; the declaration half does. Acceptance 1 now also binds the requester: in a workspace of 3+ with an engineer to pick, the requester cannot override the engineering sign-off on their own request (`TIER-1` fix pass).*

*Corrected at the DF-P6 fifth review fix pass (2026-10-21, DEC-29): the last sentence above has not held since the fourth review fix pass. Acceptance 1 binds the requester's ISSUE, not their override: the requester holding `ticket.manage` may override the engineering sign-off on their own request in every workspace size, with a required comment, recorded as an override (history note, `metadata.engineering_override`, the audit row's `authority.override` naming the self-override) — DEC-90 ruling (3) as given (R1's default; DEC-33's fourth-pass line). The requester is never offered a PLAIN approval of an undeclared request. Since the fifth pass the same holds on a pre-paste request whose requirement was raised after the paste (`flag_engineering`, an engineering class): `lib/workflow.ts` `requesterBindingApplies`.*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31; DF-P9, the package first named, merged on 2026-10-14):* the class at triage → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**.

*Landed 2026-10-21 (drafting-flow Round G, DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS): the class at triage — the assign dialog and the scope-review engineer picker offer one select per configured list (`components/requests/TriageClassSelects.tsx`; `lib/requestPageReview.ts` `triageClassSelects`), "No change" by default, sending `workClass` / `codeClass` with `assign` / `request_eng_review` at `PENDING_ASSIGNMENT` (the route validates, as DF-P6 built it); no select for an empty list, outside triage or before `20261250` (DEC-90 ruling (1) for DF-P18). A work class may also be flagged "Minor correction" (named on the minor-correction approval and in its audit row — `TIER-7`) and "Needs MOC" (the hand-back asks for the MOC number — `TIER-6`); neither changes anything for a request with no class or an unflagged class (ruling (3)). Finer classes "modulate routing within the two lanes" now act: the notify-only routing slot limited to classes is edited in the routing table (`TIER-3`). Acceptance 1–4 unchanged (as recorded); 5 unchanged (the report surface — proposed for DF-P16, as recorded). See `TIER-2`, `TIER-3`, `TIER-6`, `TIER-7`.*

*Assigned (2026-10-22, the integrator at the DF-P18 merge, DEC-31):* acceptance 5 (the report counting tickets by lane and every declaration) → drafting-flow **DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION** (the earlier proposed owner, DF-P16, has merged).

*Landed 2026-10-22 (drafting-flow Round G, DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION; the integrator's ruling (4) under DEC-90): acceptance 5 ✓ — "Review Lanes" on `/admin/analytics`, beside "How Requests Ended" (where the request reports live): for any period of filing dates (inclusive, UTC; either end open), the requests by lane — engineered, declared like-in-kind, filed before the review model (role-based gate), lane not recorded (the 20261250 columns absent) — whose counts add up to the period's total, and every declaration with its author (the declaring uid, named as the requester where it is theirs), its text, its date and the request's work / code class (named as the workspace's list names them now), with an Export CSV of the same report (every cell through `lib/csvSafe`). Read-only, from what the ticket already records: `lib/reviewLaneReport.ts` (`reviewLaneOf`, `summarizeReviewLanes`, `reviewLaneReportCsv`), `components/requests/ReviewLaneReport.tsx`, the analytics page's mapper spreading `reviewModelFieldsFromRow`; the rows are the ones `/api/admin/analytics` already returns as the caller (RLS decides, the gate is `admin.analytics_view`); no new write path, table or route. The page says the declaration's e-signature is checked at approval, not here, and that the page loads at most the server's row limit (as "How Requests Ended" does). Tests: `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("GAP-101 acceptance 5"), `csvProducersCensus.test.ts` (the new producer through its builder).*

*Corrected at the DF-P19 fix pass (2026-10-22, review major 1 and minor 5; DEC-29).* (1) The lanes as first landed were wrong for a request declared like-in-kind and raised to engineering review at triage (a class marked "Requires engineering", or `flag_engineering` — DF-P6 / DF-P18): `reviewLaneOf` checked the declaration first and counted it "Declared like-in-kind", while the engine (`lib/reviewModel.ts` `ticketEngineeringRequired`) reviews it as engineered. `reviewLaneOf` now decides in the engine's order — `engineering_required` true → engineered; false with a declaration → declared like-in-kind; false without one → the pre-review-model gate; unknown → not recorded — and EVERY declaration filed in the period is still listed, with its lane now and an "engineering review required since (declaration overridden)" column (also in the CSV). Pinned by a declared + `engineering_required` true fixture checked against `ticketEngineeringRequired`. (2) "Any period" was not true above PostgREST's row limit: the read had no ORDER BY, so a cut dropped an arbitrary subset while the page said "the oldest may be missing". `/api/admin/analytics` now reads the tickets newest first (`created_at` desc) with an exact count (`ticketsTotal`), and the panel says "Showing N of M requests … requests filed before <date> are not counted — narrow the period to start after <date>" whenever the load was cut and the period reaches back past the oldest loaded date (`reviewLaneCoverage` / `reviewLaneCoverageNotice`); a period starting after that date is complete and is shown without the notice. Residual (explicit): above the row limit the report is complete only for periods that start after the oldest loaded filing date; there is no server-side period filter or paging (the read is the analytics page's shared read), and the notice says so on the page. Tests: `dfRoundG_P19_ticketResource.test.ts` ("fix pass (review minor 5)"), `roundE_D_rolesAdmin.test.ts` and `dfRoundG_P3_routing.test.ts` re-pinned to the ordered, counted read.*

*Corrected at the DF-P19 second fix pass (2026-10-22, review major 1; DEC-29).* The residual above meant "for any period" did not hold as written: in a workspace holding more requests than PostgREST's max-rows, no screen could count a period older than the oldest loaded filing date. The Review Lanes panel now reads its period WHOLE from the server: `app/api/admin/analytics/review-lanes/route.ts` (`GET ?orgId=&from=&to=`, the same `admin.analytics_view` gate as the page — `authorizeAdminSurface(req, orgId, "analytics")`, fail closed — and the read AS THE CALLER through `callerScopedClient`, so RLS decides exactly as on the rest of the page; it reads only the report's columns and writes nothing) calls `lib/reviewLaneReport.ts` `readReviewLanePeriod`, which filters `created_at` on the server (inclusive UTC dates: `>=` the start of `from`, `<` the start of the day after `to`), orders by `created_at, id` and pages with `.range` — each page starts after the rows that actually came back, so a max-rows smaller than the page loses nothing — until the exact count is reached (or an empty page when no count comes back). A 42703 on the first page steps down `REVIEW_LANE_COLUMN_LADDER` (without the 20261250 columns every request reads "lane not recorded"); any other error is a refusal, never a partial count. `components/requests/ReviewLaneReport.tsx` takes the page's loader (`loadPeriod`), shows no count while the period is read, counts the period read, and — only if that read fails — says so and falls back to the page's own load with its coverage notice. One period read stops at `REVIEW_LANE_READ_CAP` (50,000 requests in ONE period) and the panel then says "Showing the first N of M … narrow the period" (`reviewLanePeriodNotice`); a period can be narrowed to a single day. So acceptance 5 holds for any period of up to 50,000 requests, whatever the workspace's size, and a larger single period is said on the page, never silently cut. Tests: `lib/__tests__/dfRoundG_P19_reviewLanePeriod.test.ts` (the reviewer's case — 3,000 requests, max-rows 1,000, a period in 2025 read in full with its lanes and every declaration; paging under a max-rows of 7; no count; the 42703 ladder; errors first page and mid-way; the cap said; the route's gate, date bounds, caller-scoped read, refusals; the page and panel wiring).*

*DF-P19 fourth fix pass (2026-10-22, review minor 4).* The panel no longer starts that whole-period read on every visit to `/admin/analytics`: `components/requests/ReviewLaneReport.tsx` reads the server only once a filing-date bound is chosen or on "Count all time" (`periodReadWanted`); with no period chosen it counts the requests the page already loaded, with that load's coverage notice (as when the period read fails). Acceptance 5 holds as recorded — any period is counted whole once asked for. Pinned in `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("fourth fix pass (review minor 4)").

*Assigned (2026-10-22, the integrator at the DF-P19 merge, DEC-31):* acceptance 3's deliverable limb — the declaration rendered attributed on the issued deliverable (acceptances 1, 2, 4 and 5 and the request / audit-trail half of 3 have landed; the stamp itself is DF-P10's, merged) → drafting-flow **DF-P23 TRANSITION RECORD AND RECONCILE**, which already re-verifies the deliverable stamp under `HAND-3`.

*Landed 2026-10-22 (drafting-flow Round G, DF-P23 TRANSITION RECORD AND RECONCILE — acceptance 3's deliverable limb, DEC-90 ruling (5) for DF-P23): a deliverable copy of a request its requester declared like-in-kind carries the declaration, attributed, beside the request reference the stamp already names — "This file is KE-1 (declared like-in-kind by <requester> on <date>: "<the statement, up to 140 characters>") deliverable Rev 1 — not a controlled document revision — …" (`lib/ticketDeliverableCopy.ts` `declarationFooterClause` / `ticketCopyPlan`, every footer branch; a review Draft never carries it). Both stamping paths pass it: the server copy route reads the declaration with the request row (`app/api/tickets/copy/route.ts`, `DECLARATION_COLUMNS`), the page from the request it holds (`app/(protected)/requests/[id]/page.tsx`, `liveTicket.declaration`). Attribution is the request's requester (the declaration is theirs by construction — `like_in_kind_declared_by` is the filer, checked equal to `requester_id`; otherwise "the requester"). FAIL-SAFE, as ruled — a declaration that cannot be read never blocks or delays an issue: before `20261250` (42703 / PGRST204) no declaration can exist, so the line is OMITTED and the footer is exactly as before; any other failure of the declaration read falls back to the row read as before and the stamp says "like-in-kind declaration not available" (never a 503 for it). A request with no declaration prints exactly the footer it printed before (REGRESSION, pinned). Acceptance 3 ✓ — on the request (`DeclarationCard`), the deliverable (here) and the audit trail (`likeInKindDeclared` on the issuing approvals' rows). Limit (as before, unchanged): only a stamped copy carries a footer (a file the stamper cannot stamp is released unstamped under DEC-61 §5's rules). Tests: `lib/__tests__/dfRoundG_P23_followUps.test.ts` ("GAP-101 acceptance 3 — …"). *Fix pass (2026-10-22, DF-P23 fix pass — review major and two minors, DEC-29; two statements above were overstated and are corrected here).* (a) "Any other failure … the stamp says 'not available'" printed that on requests that never had a declaration (an engineered request after a transient read error): the server route now reads the declaration's columns once on their own after the row's fallback read, and prints "not available" only if that read fails too (logged); otherwise it prints what the record holds — nothing for no declaration. (b) The stamp attributed any row with a declared time: a declaration is now a time AND a statement (`isDeclaredLikeInKind`), and its e-signature is checked as the workflow route checks it (`declarationSignatureStands`) — known not to stand → "like-in-kind declaration not relied on: its e-signature does not stand" (never attributed: the workflow treated the request as undeclared); unreadable → printed with "e-signature not checked" (never blocking). One rule for the route and the page (`lib/ticketDeliverableCopy.ts` `copyDeclarationFacts`; the page passes its Declaration card's check). (c) The statement sits inside the footer's sentence, and on a copy with no QR the stamper cuts the footer at the first scan instruction (`lib/stamping.ts` `withoutScanInstruction`), so a statement saying "scan the code" dropped "not a controlled document revision" (and "do not work from it") from the paper: a scan instruction in the statement is now bracketed ("[scan] the code", the usual mark of an altered quotation) and its spaced dashes are hyphens, so every safety clause survives the cut on every standing. Tests: `lib/__tests__/dfRoundG_P23_copyDeclaration.test.ts` (the cut on all four standings × four statements; `copyDeclarationFacts`; the copy route's retry, signature and REGRESSION cases).* *Corrected at the merge-time fix pass (2026-10-22, DF-P23 — the final review's minor, the integrator's ruling; DEC-29: "carries the declaration, attributed" held only for words the stamp's font can draw).* The footer is drawn in pdf-lib's Helvetica-Bold, whose WinAnsi encoding has no Cyrillic, Greek or CJK letters, and the stamper draws a character it has no form for as "?" (`lib/stamping.ts` `stampText`, PHYS-15) — so a requester's name or statement in another script was printed as "?" runs, attributed to nobody legible. Now each part — the name and the statement — is checked on its own against the font's own encoder (`lib/ticketDeliverableCopy.ts` `stampPrintsWithoutSubstitute`: the stamper's plain forms first, a dash as "-", a format character removed, then pdf-lib's `encodeText`), and a part that cannot be drawn without a "?" is replaced by a plain-ASCII note naming the request — "the requester [name not printable in this stamp - see request KE-1]", "[statement not printable in this stamp - see request KE-1]" (`declarationPartNotPrintable`; "see the request" with no number). A part the font can draw is printed exactly as before (REGRESSION: plain Latin with accents, curly quotes, dashes and the ellipsis is byte-identical to `04bc73f`); a "?" the requester typed is theirs and kept. Never a refusal: the clause is pure, and the issue always proceeds. The words themselves stay whole on the request (its Declaration card, and the "Declared like-in-kind (signed)" history line). *Narrowed at the merge-time fix pass 2 (the independent review's nit):* a Latin-script part with a letter the font lacks ("Łukasz Nowak", "Dvořák") was replaced whole; now such a part is first printed diacritic-folded (`foldForStamp`: each character the font cannot print decomposed with its marks dropped, or Ł/ł/Đ/đ → L/l/D/d; characters the font prints kept as typed — "Lukasz Nowak", "Antonín Dvorák"), and only a part that still cannot be drawn (Cyrillic, Greek, CJK) takes the bracketed note. The folded letters are not named on the copy (the stamper's "Printed in plain characters" note sees only what it replaces itself). Text the font already draws is unchanged byte for byte (pinned). Tests: `lib/__tests__/dfRoundG_P23_mergeFix.test.ts` (a Cyrillic statement, a CJK name, mixed scripts, both parts, plain Latin unchanged; each footer drawn with no "?" and accepted by the font's encoder, with and without a QR).


*Built (2026-10-22, the integrator at the DF-P23 merge, DEC-29 / DEC-31) — every acceptance holds as written:* 1, 2 and 4 (DF-P6), 3 on the request, its history and the audit trail (DF-P6) and on the issued deliverable (DF-P23 — the declaration attributed on the stamp; a part the stamp's font cannot print is folded or replaced by a plain note, never a '?'), 5 (DF-P19 — Review Lanes). No owner remains; the stamp's silent fold note and the remaining unfolded Latin letters are DF-P25 follow-ups, not acceptance gaps.

---

<a id="gap-102"></a>
## GAP-102 · QA/QC assurance with **zero added stops**

> ### ⚠ Build the mechanism as `GAP-112`, not as a bespoke feature
>
> Everything below about *what assurance is needed and what it must cost* still
> stands and is the reasoning to follow. But per `DEC-35` the word "QA/QC" must
> not appear in application code — it is one facility's vocabulary. Express this
> as a **slot in the routing table** (`GAP-112`) with `mode: "notify_only"`, and
> the facility names it whatever it names it.

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: nothing

> **This spec was rewritten.** The first version made QA/QC a reviewer slot on
> the parallel roster. That was wrong: a parallel roster fixes *latency* (three
> reviewers cost one wait instead of three) but not *touches* — someone still has
> to sign. The objection was to the touch.
>
> It also had the authority backwards. **QA/QC does not review the engineer's
> design.** If an engineer specifies a method, that is an engineering decision.
> QA/QC's legitimate interests here are *what examination applies* and *is the
> code data present* — both of which are **outputs** of the design, not
> judgements on it.

### The reframe

Look at what QA/QC actually needs from a drawing package:

| Need | Is it a judgement on the design? | What it actually is |
|---|---|---|
| NDE / radiography scope | No | **Data that must be present** |
| Governing code + service class | No | **Data that must be present** |
| Design factors per that code | **Yes — and it is the engineer's** | Engineering, already reviewed |
| "This looks wrong to me" | Sometimes | **Stop-work authority** |

Three of the four are not reviews at all. The fourth is a *veto*, and a veto
costs nothing when it is not exercised.

**So QA/QC gets visibility and a stop, not a signature.**

### Scope

**In:** three things, none of which is a status, a role, or a signature.

1. **A completeness gate on the deliverable** — the issued package must carry its
   examination scope, governing code and service class. Enforced as *fields on
   the record*, not as a person's approval.
2. **Standing visibility** — QA/QC watches the libraries they are responsible
   for and is notified on every issue, with that data attached.
3. **Stop-work authority** — already exists, see below.

**Out (deliberately):** a QA/QC approval step, a QA/QC reviewer slot, a
`PENDING_QAQC` status, a QAQC role. All four add a touch.

### Design — all three parts already exist

**Stop-work authority is already built and already universal.**
`lib/capabilityPolicy.ts:85-88` defines `holds.open` and `holds.release` with
`defaultRoles: ["*"]` — **every member can already place a do-not-advance hold.**
And `lib/documentGuards.ts:109-125` makes a hold a hard block that only the
controller tier can force past, enforced in the pure function, in the trigger and
in the RPC.

That is precisely how a QA/QC function works in a real plant: they do not
countersign every drawing, they hold stop-work authority. **The mechanism is
built, correct, and costs exactly nothing when unused.**

**Visibility is already built.** `lib/subscriptions.ts` supports watching a
`"library"` with `listFollowerIds` fan-out. A QA/QC inspector watches the piping
library and is notified on every issue. Zero stops.

**The completeness gate is the only new work**, and it is a field-presence check,
not a review. Where the engineer already specified the NDE scope — which is the
normal case, and the case the objection is about — the field is already populated
and **the gate is invisible**. It only bites when the data is genuinely missing,
and the person who fills it is the drafter or engineer already in the flow.

Attach the required fields to the **work class** (`GAP-101`) and the **library**,
so a like-in-kind swap in a non-code service requires nothing and a B31.3 spool
requires its examination scope.

### Do not

- **Do not add a QA/QC approval step in any form** — status, roster slot, or
  sign-off. Even parallel, it is a touch, and the touch is the objection.
- **Do not let QA/QC gate on design method.** If an engineer specified it, that
  is settled. QA/QC's recourse is the hold, which is deliberate, visible and
  audited — not a silent veto in a review queue.
- **Do not build a new stop-work mechanism.** Holds exist, default to everyone,
  and are enforced at three layers.
- **Do not make the completeness gate a free-text box.** A field nobody can
  validate is a field everyone types "N/A" into. Constrain it to the org's
  configured examination and code vocabulary.

### Acceptance

1. A like-in-kind package with its examination data already specified by the
   engineer issues with **zero additional touches by anyone**.
2. QA/QC is notified of every issue in a library they watch, with the examination
   scope and code attached.
3. QA/QC can stop a package at any point via a hold, and that hold is audited.
4. A package missing required examination data for its class cannot issue — and
   the person prompted is someone already in the flow.
5. No new role and no new status exists.

**Related findings:** `TIER-3`, `TIER-4`, `TIER-5`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL), by the integrator's ruling for this package (no QA/QC role, status or signature slot): a routing slot may be limited to work classes when it is notify-only (`RoutingSlot.work_classes`); a blocking slot never is. Acceptance 2 ✓ in that form (a library's assurance reviewer is told of every issue of the classes they watch; the code class is on the approval); 3 ✓ (the existing document hold); 5 ✓ (no new role, no new status); 1 and 4 ✗ — examination data has no model yet; proposed for the integrator to assign. See `TIER-3`.* *Owner named at the DF-P6 fifth review fix pass (DEC-31): acceptance 1 and 4 → **the integrator**, who assigns the examination-data model to a package (no package in the fleet plan holds it); recorded in 99-fix-sequencing "Hand-offs from DF-P6".*

*Corrected at the DF-P6 second review fix pass (2026-10-21, DEC-29): acceptance 2 does not act in production yet — no screen edits a slot's `work_classes` (`RoutingControlSection` only carries stored values) and no screen sets a request's work class (DF-P9), so `TIER-3` is re-recorded OPEN / Partial; owners in 99-fix-sequencing "Hand-offs from DF-P6".*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* acceptance 1 and 4 (what an assurance reviewer examined, the record behind the veto) → drafting-flow **DF-P20 ASSURANCE EXAMINATION RECORD**.

*Landed 2026-10-22 (drafting-flow Round G, DF-P20 ASSURANCE EXAMINATION RECORD; the integrator's rulings (1)–(6) for DF-P20 under DEC-90): what an assurance reviewer examined is recorded with the act it backs.* Reproduced on the base `7a03272`: a roster sign-off's ledger event carried only `{ via }` and a revision request's `{ reason }` (`lib/ticketRoster.ts` `writeRosterLedger`, the `details:` line), and no screen asked what was examined. Landed: (1) the record rides `details.examination` of the slot EVENT the reviewer creates in the append-only ledger `ticket_review_slot_events` (`20261242` — its existing `details JSONB NOT NULL DEFAULT '{}'` column; **no migration**, no table, no column, the append-only rail untouched), in the same insert as the sign-off ("satisfied") or the veto (the "voided" rows of their `request_revision`) — `lib/ticketRoster.ts` `writeRosterLedger` (`examination` input, `examinedOn`), passed by `app/api/tickets/workflow-action/route.ts` (the `sign_slot` body: `examKinds`, checked before the dry run answers, so no signature is minted for a record that would be refused; the veto block: `vetoKinds`; both ledger writes). (2) The record (`lib/assuranceExamination.ts` `buildExaminationRecord`): the roster's own content hash and each file's sha256 as DF-P5's bounded hashing recorded them when the roster opened (nothing is hashed again — pinned: no storage read on a sign-off), the files examined (default every file under review; the reviewer may narrow; a file not under review, an empty list or a malformed body is refused 400 `examination_invalid` with nothing written), the note (trimmed, ≤ 2000), and for a veto a REQUIRED note (the panel's note, else the revision comment the route already requires trimmed — *fix pass:* a comment past 2000 characters is kept to its first 2000, marked `noteTruncated`, and never refused; the comment itself is stored whole). (3) An assurance slot is a slot property, never a name (DEC-35): a blocking slot (*fix pass:* never notify-only, never consent-window), not the engineering approval (`engineering: true`), not the requester-only slot (`isAssuranceSlot`). Every other slot, and every request with none, writes, reads and renders exactly as before — pinned in the route (the DF-P5 table's opened / satisfied / voided rows and audit rows key for key; the engineer's and the requester's sign-offs and revision requests on an assured roster; an unconfigured request) and on the panel (every status × five viewers × open / closed / no roster: no ledger read, no new markup). An event written before the deploy reads "Examination not recorded", never an error. (4) No paste exists, so nothing waits on one: the column is there wherever the ledger is (a request whose ledger is not pasted has no roster). (5) The roster panel (`components/requests/TicketRosterPanel.tsx`) asks the assurance reviewer in place — the files (all ticked), a note, a "Request revision" that refuses an empty note in place (one step), the signed statement naming narrowed files — shows each assurance sign-off's record (`ExaminationView`: the hash shortened with a copy button that copies it in full, the files, the note) and keeps a closed round's veto readable (`examination-history`); the transition's audit row carries the same facts (`reviewRoster.examination`, with the slot kinds). Tests: `lib/__tests__/dfRoundG_P20_assuranceExamination.test.ts` (route, lib, ledger, DEC-35 census; 8 of its cases fail on the base), `lib/__tests__/dfRoundG_P20_assurancePanelRender.test.ts` (rendered).

*Partial (2026-10-22, drafting-flow Round G, DF-P20) — ruling (6): acceptances 1 and 4 do NOT close as written.* **Acceptance 4** ("a package missing required examination data for its class cannot issue — and the person prompted is someone already in the flow") ✗: what landed is the record of what an assurance reviewer examined, and a veto that must say why; there is still no examination-scope / governing-code data on the request, no per-class requirement for it, and no issue gate that refuses a package without it (this spec's "completeness gate", constrained to the org's configured vocabulary). **Acceptance 1** ("a like-in-kind package with its examination data already specified by the engineer issues with zero additional touches by anyone") — the part DF-P20 can touch holds: the record adds no touch (it rides the existing sign-off; every file by default; the note optional on a sign-off; no slot, status or role added — pinned), and a request with no assurance slot is unchanged; but "its examination data already specified by the engineer" presupposes acceptance 4's data model, so it is ✗ as written until that exists. **Owner (DEC-31):** the integrator, to assign a new drafting-flow package (proposed: **DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE** — examination-scope fields on the request, required per work class / library from the workspace's own configured vocabulary, filled by the drafter or engineer already in the flow, refused at the issuing transitions when missing; the record above is what it would bind). Recorded in 99-fix-sequencing "Hand-offs from DF-P20".

*Partial — DF-P20 fix pass (2026-10-22, the package review; DEC-29: the Landed line above overstated rulings (2) and (3)).* **Ruling (2) is not met for two limbs.** (a) **The notify-only assurance reviewer** — the reviewer this finding is mainly about (assurance as notice plus a hold) — gets no record: a notify-only slot has no sign-off and no revision request (`lib/workflow.ts` `slotSignPlan` skips it, and since the fix pass `isAssuranceSlot` excludes it outright), and their only stop, a document hold, carries no examination record. ✗. (b) **The sheets examined** inside one file are not modelled: the roster's files carry no sheet data (`TicketReviewRoster.files`), so the record names whole files and only the free-text note can say "sheets 3–5". ✗. **Ruling (3) holds only under DF-P20's derived definition of an assurance slot**, which the integrator has not ruled on (`DEC-44 (DF-P20-assurance-examination)` item 1): the fix pass narrowed it to blocking slots (a consent-window slot — which can advance by silence — and a notify-only slot are no longer assurance slots, and a slot satisfied by consent never reads "Examination not recorded"), but every existing **blocking** slot of a configured roster that is not the engineering approval and not the requester's own acceptance still changes: its occupant now sees the optional "What you examined" form and the panel's own "Request revision", the panel reads the ledger for that ticket, and its sign-offs written before the deploy read "Examination not recorded". **Owner (DEC-31):** the integrator — to rule on the definition before merge (keep the derived reading, or gate it on an explicit per-slot routing flag, which is a `lib/routingControl.ts` parser and routing-editor change for that file's owner), and to assign the notify-only record (a hold placed by a notify-only assurance occupant carrying what they examined) and the sheets limb, proposed with acceptances 1 and 4 to **DF-P24**. Recorded in 99-fix-sequencing "Hand-offs from DF-P20". *Also landed at the fix pass:* the panel's in-place revision request now carries the same reason category as the page's Request Revision (`REVISION_CATEGORIES`, pinned equal to the page's list); the redline option stays on the page's path only (said on the panel); right after a sign-off the panel no longer flashes "Examination not recorded" while its re-read is in flight. Tests: `lib/__tests__/dfRoundG_P20_assuranceExamination.test.ts` (the 2,500-character page-path revision request, 200 with the record; a typed note past the limit still refused; consent / notify-only excluded), `lib/__tests__/dfRoundG_P20_assurancePanelRender.test.ts` (no "not recorded" during the re-read; the category; consent slots read and show nothing new; the shortened note).

*DF-P20 fix pass 2 (2026-10-22, the second package review; DEC-29: the Landed line's (3) and the fix-pass Partial's "derived definition" are superseded here).* **An assurance slot is now the controller's explicit opt-in, never inferred** (the review's preferred fix): `lib/routingControl.ts` `RoutingSlot.records_examination` (parsed by `parseRoutingControl`: kept as `true` on a blocking slot; refused on a notify-only or consent-window slot, on a slot only the requester fills, and as any value but `true`/`false`/absent), offered in the routing editor as an unticked checkbox on a blocking slot (`components/documents/RoutingControlSection.tsx` `DraftSlot.recordsExamination`, `draftToControl` / `controlToDraft`, `ASSURANCE_OPT_IN_HINT` — the old derived reading survives only as the editor's wording of which slots it suits), copied to the roster slot when it opens (`lib/ticketRoster.ts`, `TicketReviewSlot.recordsExamination` in `types/schema.ts`, on a blocking slot only — every other slot is stored exactly as before), and required by `lib/assuranceExamination.ts` `isAssuranceSlot` on top of the existing exclusions (`engineering: true` — `ENGINEERING_CAPABILITIES`, i.e. `ticket.final_approve` / `ticket.eng_review`, or the appended gate — and a slot whose people resolved to the requester alone). A slot filled by `ticket.direct_approve` is not excluded: it records only if a controller ticks it, which is that controller's explicit call. **So ruling (3) now holds without any ratification:** no configured roster changes at the deploy — a person-, role- or `ticket.direct_approve`-filled blocking check, or a requester slot fallen back to management, with no opt-in shows no form, reads no ledger and records nothing (pinned in the route and the rendered panel). What remains for the integrator is only to confirm the opt-in shape (DEC-44 (DF-P20) item 1). *Also landed (review minors):* a record made with no file list (the page's Request Revision, an API caller) is marked `defaulted` and reads "Files under review: all N (not narrowed — the reviewer was not asked)", never "Examined" — the panel now always sends its file list, so its "all" is a choice; each slot event's record carries the slot's label (`slotLabel`), so an earlier round reads by its label once its roster is gone; an occupant whose assurance slot is blocked (separation of duties / producer floor) sees only the revision request (no file checklist, no sign-off wording) and sends no file list; the route's two computations moved to `examinationForAct` / `examinationAuditFields`, one call each. Ruling (2)'s notify-only and sheets limbs, and acceptances 1 and 4, are unchanged: still Partial, owner the integrator, proposed DF-P24. Tests: `lib/__tests__/dfRoundG_P20_assuranceExamination.test.ts` (the unflagged table records nothing; the opt-in copied only where set; parser accept / refuse cases; the editor round trip; `examinationForAct`; the defaulted and chosen-all paths; the slot label on the event; the route's one-line calls), `lib/__tests__/dfRoundG_P20_assurancePanelRender.test.ts` (an unflagged check reads and shows nothing new; the blocked-only occupant's form and body; "Files under review"; an earlier round's label).

*Corrected (merge-time, 2026-10-22, the DF-P20 merge-time fix pass; DEC-29):* the Landed line above cites `examKinds` and `vetoKinds` in `app/api/tickets/workflow-action/route.ts`; neither exists any more (fix pass 2 moved the computation into `lib/assuranceExamination.ts`). The real calls are `examinationForAct` — once in the `sign_slot` body, checked before the dry run answers (`route.ts:1263`), and once in the veto block for `request_revision` (`route.ts:1283`) — and `examinationAuditFields(examination)` in the two audit rows' `reviewRoster` (the `signed` row, `route.ts:1637`; the `closed` row, `route.ts:1639`); the record reaches the ledger through `writeRosterLedger`'s `examination` input (`route.ts:2034`, `:2039`; `lib/ticketRoster.ts` `examinedOn`, `:576`). Three further corrections at the same pass, each made so no flow that worked before DF-P20 can regress (DEC-90): (i) **a stored `records_examination` is never a reason to refuse a routing table** — `parseRoutingControl` (`lib/routingControl.ts:246`) now reads it exactly as `consent_confirmed`: kept only when it is `true` on a slot `examinationOptInAllowed` (`:145`) accepts (blocking; not filled by the requester alone; not filled by an engineering capability — `CONSENT_REFUSED_CAPABILITIES`, pinned equal to `ENGINEERING_CAPABILITIES`), dropped silently otherwise (fix pass 2's "refused on a notify-only or consent-window slot, on a slot only the requester fills, and as any value but true" is superseded: a misplaced value used to make the whole table `invalid`, refusing every submission and routed approval in the library). The editor still refuses a save that would write one, with the reason (`validateRoutingDraft`); its own draft never carries one. (ii) The routing editor no longer offers the "Assurance check" box on a blocking slot filled by an engineering capability (`components/documents/RoutingControlSection.tsx` `assuranceOptInFor` — the slot says the engineering approval records its own sign-off), and `draftToControl` drops the flag there. (iii) **When the roster's ledger write fails**, the examination record survives only on the transition's audit row: the route's console reconcile line now names that row's `details.reviewRoster.examination` (and the slot kinds) as the source, and **a reconciliation of the ledger must copy it into each of those slots' event `details.examination`** (owner: 99-fix-sequencing "Hand-offs from DF-P20"); until then the roster panel says "Examination record could not be read yet" for that act in the session the route reported it (never "Examination not recorded"); after a reload it reads "Examination not recorded" until the reconciliation lands. The panel also keeps earlier rounds' records once a later round's roster has no assurance slot: one probe (`select id`, limit 1, `details->examination` not null) and a history read only on a hit; a request that never had a roster reads nothing new (so the Landed line's "no ledger read" for an open or closed roster with no assurance slot now reads "at most that one probe, and no history read unless it finds a record" — pinned in `lib/__tests__/dfRoundG_P20_assurancePanelRender.test.ts`). A route-side sweep (`lib/__tests__/dfRoundG_P20_noOptInSweep.test.ts`) runs every action the state machine offers plus `sign_slot` / `request_revision`, across every status × the harness's seven members, on a roster with no opted-in slot, with DF-P20's two route calls on and off: responses, every database call and every after-response task are identical and no `examination` key appears (219 combinations). The notify-only limb stays Partial (above).


*Assigned (2026-10-22, the integrator at the DF-P20 merge, DEC-31):* acceptances 1 and 4, and ruling (2)'s notify-only and sheets limbs → drafting-flow **DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE** (new; after DF-P23); the reconciliation's copy of a lost examination record → drafting-flow **DF-P23 TRANSITION RECORD AND RECONCILE**. The assurance slot as the controller's explicit opt-in (`records_examination`, DEC-44 (DF-P20) item 1) is confirmed at the merge.

*Recorded (2026-10-22, drafting-flow Round G, DF-P23 TRANSITION RECORD AND RECONCILE — no status change; DEC-29, DEC-31):* the reconciliation's copy is NOT built — there is no roster-ledger reconciliation on HEAD to extend (every "reconcile from tickets.metadata.review_roster" is a log line; nothing reads it back), and building one is a new mechanism past this follow-up. What DF-P23 did land for this record: the route returns the ledger-unwritten state as its own response flag (`rosterLedgerNotWritten`), so the roster panel's "Examination record could not be read yet" can no longer be displaced by a hold or library warning. The reconciliation (and its copy of `details.reviewRoster.examination` into each slot event's `details.examination`, with the slot's `slotLabel`) → the integrator (DEC-31), proposed DF-P24 — `99-fix-sequencing.md`, "Hand-offs from DF-P23".


**Resolution (2026-10-22, drafting-flow Round G) — DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE: acceptances 4 and 1 (the integrator's rulings (1)–(3) and (6) for DF-P24 under DEC-90; calls in `DEC-44 (DF-P24-examination-scope)`).** Reproduced on the base `30d9be9`: no examination-scope data existed anywhere (`grep -rn examinationScope app lib components` → nothing), no issuing transition read any (the workflow route's issuing path checks the engineer gate, the roster, the source drift and the declaration only), and the DF-P20 record binds what an assurance reviewer examined, not what the package must carry. Landed:
(1) **The data model, in the workspace's own words (ruling (1); DEC-35).** `org_configurations` 'drafting', key `examinationScope` — fields (each a list of values to pick from, never free text) and requirements (a field, for a work class and/or a library, with the time it was stored) — parsed tolerantly by `lib/examinationScope.ts` (`parseExaminationScopeConfig`, `applicableRequirements`), edited on Admin → Request forms (`components/requests/ExaminationScopeSection.tsx`, saved with the page's own Save Changes; the page stamps a new requirement's `since` at that save — `stampExaminationScope`; settings with nothing to stamp are written as the same object). A request carries its values in `ticket_examination_scopes` (**20261266**, new; one row per request, read as the request reads, written only by the service role; a guard keeps each row in its request's workspace and on its request) through `app/api/tickets/examination-scope/route.ts` (new): the assigned drafter, the assigned engineer, a person named on an engineering sign-off of the roster, or the assignment queue (`ticket.assign`) picks each value from its list; the audit row first (`TICKET_EXAMINATION_SCOPE_SET`), the write compare-and-set, a `_NOT_APPLIED` row when it does not land; 503 `not_migrated` before the paste. The request page shows it (`components/requests/ExaminationScopePanel.tsx`, mounted only when the workspace configured data) — "Needed before this request can issue: …" before anyone tries, so the person prompted is someone already working on it.
(2) **The issue gate (ruling (2)).** `app/api/tickets/workflow-action/route.ts` — one block between the source-drift check and the roster section: an issuing approval (`ISSUING_APPROVALS`) or a roster sign-off that would complete the review (its dry run too) on a request a requirement applies to reads its row and refuses (409 `examination_scope_missing`, with the plain sentence `examinationScopeRefusal` names — what is missing, for what, who records it *(corrected at the merge-time fix pass 2, DEC-29: the sentence first said "The drafter or the engineer records …", which a drafter could not follow in review; it now names the engineer of record or a revision, and the caller's waiver — or, with no engineer of record, only the waiver and a revision)* — nothing written; a refused sign-off recorded as DF-P5's rule says) ONLY when the request was filed at or after the requirement's `since` and no waiver covers it. A request filed before the requirement issues; its answer carries `examinationScopeWarning` and the panel says the same. The audit row of every gated issue carries `examinationScope` (what was required, recorded, missing, warned, waived); an unconfigured request's row is today's. **The override** is a waiver on the request: a person who holds the issue authority NOW (the state machine offers them an issuing approval or a roster sign-off, under the workspace's policy) records why it issues without the data — a required reason, audited (`TICKET_EXAMINATION_SCOPE_WAIVED` / `_WAIVER_WITHDRAWN`), bound to the fields missing then and the revision under review; the gate honours it only for those. Fail-safe readings (ruling (6)): an unreadable configuration, a requirement with no readable time or on an unfillable field, a value its list has since lost, and a database without 20261266 never refuse; only an unreadable row where a requirement is known to apply is a 503.
Tests: `lib/__tests__/dfRoundG_P24_examinationScope.test.ts` (the rules, the editor helpers, the DEC-35 census, the notify-only and sheets pins), `lib/__tests__/dfRoundG_P24_issueGateRoute.test.ts` (the route: an A/B sweep — every action × status × member, with no configuration and with a requirement on another class or library, byte-identical with the gate off, no read, no key — then each refusal / warning / waiver / not-migrated / unreadable case, the work-class requirement, the completing and non-completing sign-off, a non-issuing action reading nothing), `lib/__tests__/dfRoundG_P24_scopeFillRoute.test.ts`, `lib/__tests__/dfRoundG_P24_scopePanelsRender.test.ts` (the panel renders nothing and reads nothing unconfigured — every status × six viewers × three configurations), `lib/__tests__/dfRoundG_P24_scopeMigration.test.ts`, and on PostgreSQL 16 `lib/__tests__/rls/dfP24ExaminationScope.test.ts`.

**Done-when (the acceptances DF-P24 holds).**
- Acceptance 1 ("a like-in-kind package with its examination data already specified by the engineer issues with zero additional touches by anyone") ✓ *(restated at the merge-time fix pass, DEC-29: the data is specified on the request page after filing — the create form does not carry it — and the issuing act then needs zero additional touches; not zero touches at filing — block below)* — the data model now exists (the engineer, or the drafter, records it in the flow they are already in); with it recorded the issue proceeds with no prompt and the same answer as an unconfigured workspace (pinned: `dfRoundG_P24_issueGateRoute.test.ts` "acceptance 1"); a class or library that requires nothing is untouched. DF-P20's half (the record adds no touch) still holds.
- Acceptance 4 ("a package missing required examination data for its class cannot issue — and the person prompted is someone already in the flow") ✓ as ruled — refused at every issuing transition, constrained to the workspace's configured vocabulary, with the drafter / engineer named and prompted on the request *(corrected at the merge-time fix pass 2, DEC-29: in review — where every issuing act is — the refusal names the engineer of record, or a revision, and the caller's waiver; with no engineer of record, the waiver and a revision; the panel prompts the person who may record it)*; the two exceptions are the ruling's own (DEC-90 ruling (2) for DF-P24): a request filed before the requirement only warns, and a recorded, audited waiver by someone who holds the issue authority. *Corrected at the fix pass (DEC-29): as first recorded, "every issuing transition" overstated the code — a consent window whose close on silence completes the review (`lib/consentWindowScan.ts`, `consent_window_advance` → PENDING_IFC) issued without the gate; it is now held instead (the fix-pass block below), so the claim holds for the workflow route's issuing approvals and completing sign-offs AND the consent close.*
- Acceptances 3 and 5 — unchanged (✓); no role, status, slot or sign-off added. *Corrected at the DF-P24 second fix pass (DEC-29): as first written this line also read "acceptance 2 … ✓ as recorded above" — wrong: acceptance 2 stays **OPEN / Partial** as corrected at the DF-P6 second review fix pass (above), and it now also lacks the examination data on the issue notice ("with the examination scope and code attached"): DF-P24 created that data (`ticket_examination_scopes`, read through `lib/examinationScope.ts` `parseScopeValues`), but no issue notice or watcher fan-out carries it. Owner (DEC-31): the integrator — proposed the notifications area (the next holder of the issue notice); 99-fix-sequencing "Hand-offs from DF-P24".*

**Scope / residual.** Paste `20261266` (either order; recommended deploy first, then paste — row for `MIGRATION-PASTE-ORDER.md` in 99-fix-sequencing "Hand-offs from DF-P24"). ~~The stamp of a requirement's time is the saving browser's clock (DEC-44 (DF-P24) item 2 — stated limit).~~ *Superseded at the fix pass: the server's clock after the save commits (below).* The two ruling (2) limbs below; the DF-P23 ledger-reconciliation copy (proposed "DF-P24, or a new package") is not in DF-P24's plan entry and stays with the integrator.

**Partial (2026-10-22, drafting-flow Round G) — ruling (2)'s notify-only limb is NOT built (DF-P24 ruling (4): it cannot be done fail-safe through the hold's existing metadata).** `document_holds` carries no structured metadata — only `notes`, the person's own private free text (shown on the hold strip and the hold verify door), and the `HOLD_OPENED` audit row, which `lib/holds.ts` `openHold` writes from the browser AFTER the hold insert as a separate write (`lib/audit.ts` `logHoldEvent`): an examination record riding it could be lost while the hold stands, so the record and the act could disagree (DEC-44 (DF-P20) item 2). A request under review often has no document to hold at all (a new drawing's draft is a request attachment). So `parseRoutingControl` keeps dropping `records_examination` on a notify-only slot (pinned unchanged — an accepted opt-in there would promise a record nothing writes) and the routing editor's hint is unchanged (it already never steers toward a blocking assurance slot — pinned). **Owner (DEC-31):** the integrator — proposed document-control (a structured examination column on `document_holds` written in the hold's own insert, under 20261073's INSERT guard) together with the next holder of `components/requests/TicketRosterPanel.tsx` (a request-side "hold, with what I examined" for a notify-only assurance occupant, on the request's source document); then the parser accepts the opt-in. **Ruling (2)'s sheets limb is settled as ruled (DF-P24 ruling (5)):** the roster's files carry no sheet data (`TicketReviewRoster.files`), so the examination record keeps naming whole files and its note carries the sheets (pinned) — no owner needed.

**DF-P24 fix pass (2026-10-22, drafting-flow Round G — the package review: two majors, four minors; DEC-29, DEC-31).** Status unchanged (the notify-only limb above keeps GAP-102 open).
(1) **The consent window's close is an issuing transition too (major 1).** `lib/consentWindowScan.ts` `closeWindow`: a close that would issue the request (`wouldIssue`, every other hold clear, the source unmoved) now runs the gate the workflow route runs — the workspace's 'drafting' row the scan already reads carries the configuration (`OrgCtx.draftingCfg`); when a requirement applies it reads `ticket_examination_scopes` and decides through the one shared rule, `lib/examinationScope.ts` `scopeGateOutcome`. Missing enforced data with no waiver HOLDS the close for a sign-off (`examination_scope_missing`, the history naming the fields); the row unreadable where a requirement binds holds it (`examination_scope_unchecked`); a request filed before every requirement issues (warned on the audit row), as does a database without 20261266 (`notMigrated`). The audit row carries `examinationScope` only where a requirement applies; no requirement → no read, today's close (pinned). The two hold reasons are added to `TicketConsentWindowMark.heldReason` (`types/schema.ts`) and `consentHeldAction` (`lib/consentWindow.ts`).
(2) **A requirement's `since` can no longer be revived, and is never earlier than its save (major 2, minor 6).** `unstampNewlyFillable` drops the old `since` of a requirement whose field was unfillable (no choices) or not configured in the STORED configuration (as last loaded or saved) and is fillable now — options added, or the key added back — so it binds only requests filed after the save that makes it able to bind. The admin page no longer stamps with the browser's clock: it saves the requirement UNSTAMPED (binding nothing), then reads the server's clock — the `Date` header of a no-store GET of the existing `/api/version`, rounded up to the next second (`readServerClock`) — and stamps it in a second save (`stampExaminationScope`); when the clock cannot be read the requirement stays unstamped and the alert says it refuses nothing yet. A save with nothing to stamp is still ONE upsert of the same object (pinned). *Superseded at the second fix pass (major 1): the browser no longer stamps anything — the database's trigger does (below).*
(3) **An unreadable row refuses only where a requirement binds (minor 3).** `hasBindingRequirement` (knowable before the read); for a request filed before every requirement — or under requirements with no readable time — the issue proceeds and its audit row says `examinationScope: { unchecked: true, required }`.
(4) **An unreadable configuration is recorded (minor 4).** An issuing approval, or a sign-off that would complete the review, when the 'drafting' row could not be read carries `examinationScope: { configUnchecked: true }` on its audit row (still today's path otherwise).
(5) **The waiver's issue authority (minor 5).** `app/api/tickets/examination-scope/route.ts`: a roster `sign_slot` counts only when the caller's own sign-off would COMPLETE the review (the gate's preview: `slotSignPlan` → `applySignPlan` → `rosterCompletion`); a peer checker whose sign-off never issues is refused (403).
Tests: `lib/__tests__/consentWindowScan.test.ts` (new block: held / issued / warned / unchecked / not migrated / regression — no requirement, another library's, a non-issuing close: no read, no key), `lib/__tests__/dfRoundG_P24_issueGateRoute.test.ts` (config unchecked on the audit row; an unreadable row for an in-flight request and under a requirement with no time → 200; the peer's waiver 403, the completing signer's 200), `lib/__tests__/dfRoundG_P24_examinationScope.test.ts` (options-added and key-re-added re-stamp; same object otherwise; `hasBindingRequirement`; `scopeGateOutcome`; `readServerClock`; the two hold headlines), `lib/__tests__/dfRoundG_P24_adminStampRendered.test.ts` (new, rendered: two saves with the server's time, never the browser's slow clock; the field-gains-choices re-stamp; the unreadable clock; one save when nothing to stamp), `lib/__tests__/dfRoundG_P24_scopePanelsRender.test.ts` (the page's save order re-pinned).
**Done-when (re-checked).** Acceptance 4 ✓ as ruled at every issuing transition: the workflow route's issuing approvals, its completing sign-offs, and the consent close. Ruling (2)'s "never newly blocked": ✓ for the three ways the review found (a field becoming fillable re-stamps; a transient row read refuses only a bound request; the stamp is the server's time after the commit). Acceptance 1 ✓ unchanged. *Superseded at the DF-P24 second fix pass (DEC-29): "never newly blocked" held only for the admin page's own browser code (any other writer of the 'drafting' row could store any `since`), and acceptance 1 held only for the drafter-recorded variant — see the second fix-pass block below.*
**Scope / residual.** Files outside the plan entry, each minimal and declared: `lib/consentWindowScan.ts` (the gate on the issuing close), `lib/consentWindow.ts` (two `consentHeldAction` headlines), `types/schema.ts` (two `heldReason` values), `lib/__tests__/consentWindowScan.test.ts` (one appended block). The request page's waiver button still shows for any person offered a sign-off (its `issuing` prop): the server refuses a non-completing signer with the plain sentence — computing completion on the page needs `lib/ticketRoster.ts`, which is server-only (`node:crypto`). ~~The server's clock is the app server's; `tickets.created_at` is the database's — both are NTP-synced, and the stamp is rounded up a whole second.~~ *Corrected at the second fix pass (DEC-29): `tickets.created_at` is stamped by the app server (`app/api/tickets/create/route.ts`, `created_at: now`), not the database; and `since` is now the database's clock (below).*

**DF-P24 second fix pass (2026-10-22, drafting-flow Round G — the second package review: three majors, five minors; DEC-29, DEC-31).** Status unchanged (the notify-only limb keeps GAP-102 open).
(1) **A requirement's `since` is the database's, never a writer's (major 1).** `20261266` now also creates `drafting_examination_scope_stamp()` (SECURITY INVOKER, `search_path` pinned, EXECUTE revoked from every client role) and `trg_org_config_examination_scope_stamp` — BEFORE INSERT OR UPDATE on `org_configurations`, `WHEN (NEW.key = 'drafting')`. On every write of that row it rewrites each requirement's `since`, ignoring whatever the writer sent: a requirement whose identity (field, work class, library — trimmed as the parser trims, JavaScript's whitespace) is stored in the row being replaced, whose field had a value to pick from THERE (the parser's own reading: the first valid field with that key among the first 50, a non-blank option among its first 200), and whose stored time is in the trigger's own format, keeps that time; every other one — new, re-targeted, removed and re-added, or naming a field that had nothing to pick from (or did not exist) — gets the database's clock plus one minute, to the second (the margin covers the app server's clock, which stamps `tickets.created_at`). INSERT, UPDATE and PostgREST's upsert all pass through it, so a DraftingSupervisor's REST PATCH, a stale tab and a restore get the same rule. The requirements stored before a first paste (only possible app-first, when nothing could be refused) are re-stamped with the paste's time before the trigger exists; a re-paste keeps each stored time. Two probes added (5: the function and trigger; 6: every stored requirement carries a time in the trigger's format) and one inventory row (requirements stored before the paste). The admin page no longer computes any time: ONE upsert (`withNormalizedOutcomeReasons(settings)`), then — only when the settings carry a requirement (`examinationScopeHasRequirements`) — a read-back to show the stored times; before the paste a requirement has no time and the alert says it refuses nothing yet. `stampExaminationScope`, `unstampNewlyFillable`, `examinationScopeNeedsStamp` and `readServerClock` are removed (this also closes minor 4: the stale-`storedSettings` comparison and the two-upsert overwrite no longer exist — the trigger compares with the row as it stands at the write).
(2) **The requester records the data while the request is with the drafter (major 2, GAP-102 acceptance 1 as written).** `lib/examinationScope.ts` `scopeEditorBasis` gains `"requester"` for the request's requester while its status is in `SCOPE_REQUESTER_STATUSES` (PENDING_ENG_TEAM, PENDING_ASSIGNMENT, DRAFTING, REVISION_REQ — before review, never issued); the route, its 403 sentence and the panel follow. The engineer who files a like-in-kind request (no assigned engineer, no engineering slot) records what they already specified, so with it recorded the issue proceeds with zero added touches (the existing acceptance-1 route case).
(3) **Acceptance 2 restated (major 3)** — the Done-when line above is corrected; hand-off row in 99-fix-sequencing.
(4) **A transient read at the consent close waits a run (minor 5).** `lib/consentWindowScan.ts` `closeWindow`: `scopeGate.kind === "unreadable"` counts `report.failed`, says "its examination data could not be read — the window was not closed (retried next run)", and returns with nothing written, as the delivery, notice and engineered-lane reads do. The `examination_scope_unchecked` hold reason is removed (`types/schema.ts`, `lib/consentWindow.ts`); `examination_scope_missing` stays for genuinely missing data.
(5) **configUnchecked stated as the one exception (minor 6).** The claim "an unconfigured workspace … no key on any record" is narrowed in `lib/examinationScope.ts`'s header, the route's comment, DEC-44 (DF-P24) and DEC-90: an issue whose 'drafting' row could not be read carries `examinationScope: { configUnchecked: true }` (the route cannot know what was configured). The regression sweep now covers it (below).
(6) **The A/B sweep is no longer tautological (minor 7).** The route's gate is ONE call, `lib/examinationScopeGate.ts` `issueScopeGate` (new, server-only; also `signOffWouldComplete`, now shared with the waiver authority in `/api/tickets/examination-scope`); arm B of the sweep replaces that whole call with "none", so any read, preview or key the gate adds shows as a difference (checked: an extra read injected into the gate fails the sweep). A second sweep runs every action × status × member with the 'drafting' row unreadable: identical except `configUnchecked` on an issuing act's audit row, no read. A completing sign-off (and its dry run) on a routed roster, unconfigured or with a requirement elsewhere, is A/B-pinned too (the sweep's rows carry no roster, so `sign_slot` is refused before the gate there).
(7) **Record accuracy and the issued record (minor 8).** The PostgreSQL 16 file had 4 cases, not 5 (now 8 — the four new ones exercise the trigger). Values and a waiver are refused once the request has issued (`SCOPE_ISSUED_STATUSES` — PENDING_IFC, FINAL_DRAFT; 409 `issued`, nothing written; no issuing action is offered there, pinned, so nothing can be blocked by it); the panel shows the data read-only with "part of the issued record"; a request sent back opens again.
Tests: `lib/__tests__/rls/dfP24ExaminationScope.test.ts` (8 runtime cases on PostgreSQL 16: 6 probes and 4 inventory rows, twice; a member's backdated `since` replaced on INSERT / UPDATE / upsert, an unchanged requirement keeping its stored time whatever is sent; re-targeted, re-added, unfillable-in-the-stored-row and delete-then-insert stamped afresh, order kept; another key untouched; a first paste re-stamping pre-existing requirements, a re-paste keeping them), `lib/__tests__/dfRoundG_P24_scopeMigration.test.ts` (the trigger never reads the writer's `since`; the re-stamp before the trigger), `lib/__tests__/dfRoundG_P24_adminStampRendered.test.ts` (rewritten: one save, no clock, the stored time shown, not-migrated alert, one upsert and no read-back without a requirement), `lib/__tests__/dfRoundG_P24_scopeFillRoute.test.ts` (the like-in-kind requester at three statuses, 403 under review; issued 409 for values and a waiver), `lib/__tests__/dfRoundG_P24_scopePanelsRender.test.ts` (requester picker; issued read-only; the page's save pinned to one upsert with no time), `lib/__tests__/dfRoundG_P24_issueGateRoute.test.ts` (the real A/B; the unreadable-config sweep; the sign-off A/B), `lib/__tests__/consentWindowScan.test.ts` (unreadable → not closed, retried, then issued next run), `lib/__tests__/dfRoundG_P24_examinationScope.test.ts` (the requester statuses; the issued statuses offer no issuing action).
**Done-when (re-checked at the second fix pass).** Acceptance 1 ✓ as written: a like-in-kind package whose engineer (its requester) recorded the data while it was with the drafter issues with zero added touches (pinned: requester basis + the acceptance-1 route case). Acceptance 4 ✓ as ruled (unchanged). Ruling (2)'s "never newly blocked" ✓ server-side: no writer can set a `since`; only the database's trigger does, and only ever later than the stored one for an unchanged requirement (pinned at runtime). Acceptance 2 ✗ — OPEN / Partial (above). Acceptances 3, 5 ✓.
**Scope / residual.** Paste `20261266` (re-paste-safe; the paste now also creates the stamp trigger — see 99-fix-sequencing's corrected paste row). Clock skew: `since` is the database's clock + 60 s and `created_at` is the app server's; a skew over a minute (app ahead) could bind a request filed in the minute before the save, and a skew the other way only delays binding — both are NTP-synced (stated limit). Files outside the plan entry added here: `lib/examinationScopeGate.ts` (new, the gate's single call). The issue notice carrying the examination data → acceptance 2's owner (above).

**DF-P24 merge-time fix pass (2026-10-22, drafting-flow Round G — the final review: four minors, three records gaps; the integrator's rulings, DEC-90; DEC-29).** Status unchanged (the notify-only limb keeps GAP-102 open). `20261266` is NOT changed.
(1) **The requester fills an empty field; never changes or clears someone else's value.** `lib/examinationScope.ts` `scopeFieldRight` / `checkScopeWrite` (new, pure, per field): before review the requester may FILL an empty field, and change or clear only a value whose `by` is themselves; a value the drafter or engineer recorded is refused (403 `recorded_by_someone_else`, nothing written). The drafter, the engineers and the queue keep changing values before review. The route (`app/api/tickets/examination-scope/route.ts`) and the panel (`components/requests/ExaminationScopePanel.tsx` — a list only on a field the viewer may touch; the clear "—" only where they may clear) apply the same rule.
(2) **The waiver's issue authority is the workflow route's own — item-2 choice: EXTRACTION (the fallback was not needed).** `lib/workflowAuthority.ts` (new, server-only) holds the route's engine context — `draftingTypeFlags` (close-without-review / engineering-first types), `workflowEngineContext` (the requester's current roles, the like-in-kind declaration's signature, `engineerPickAvailable`, the source-drift labels — the same reads in the same order), `rosterlessRoutedRefusal` (TIER-5) and `DECLARATION_DECIDES` — moved out of `app/api/tickets/workflow-action/route.ts`, which now calls them; and `issueAuthorityNow`, which the waiver uses: the route's member-count rule (an unreadable count refuses an issuing approval, evaluates a sign-off with separation of duties active), the same context, `getActions`, a sign-off only when it would complete the review, and the TIER-5 refusal; an unreadable read is a 503, never authority. The route's behaviour is unchanged — pinned: the A/B sweep's 1,828 runs (every action × status × member, unconfigured / a requirement elsewhere / an unreadable 'drafting' row, the roster sign-offs) were dumped before and after the extraction and compared byte for byte (status, answer and every database call: identical); and every workflow-route test passes. New case: a routed library's request in review with no roster — the engine offers the serial approval, the workflow route refuses it (409 `routing_needs_roster`), and the same member's waiver is refused (403, nothing written; it was accepted, 200, before this pass — checked against the previous route) and the GET says `mayWaive: false`; the same member in an unrouted library may.
(3) **The editor validates with the parser's own rule.** `lib/examinationScope.ts` `examinationScopeProblems` (new; `FIELD_KEY_RE` now exported): a key outside `FIELD_KEY_RE`, over 60 characters, blank or duplicated (trimmed, as the parser trims), past the 50-field / 200-choice / 500-requirement limits, and a requirement naming a blank field, a field that would be dropped, or neither a work class nor a library — each named at its row in `components/requests/ExaminationScopeSection.tsx` (`editorScopeProblems`, checked on the configuration as the editor holds it), and `app/(protected)/admin/requests/page.tsx`'s Save Changes refuses to save while any remains (alert, no upsert). Settings without the key have no problem — today's save. Pinned by a 2,000-configuration parity property (no problem ⇔ the parser keeps every field and requirement).
(4) **Values in review and after issue.** (a) From the first review status the engine uses (`SCOPE_REVIEW_STATUSES`: PENDING_REVIEW, PENDING_FINAL_APPROVAL) only the assigned engineer of record writes a value (fill, change or clear); everyone else is refused (403 `in_review`; with no engineer of record the sentence names the waiver and a revision as the ways forward). Each such change is put on the request's history, old → new by the workspace's labels (`examinationScopeHistoryEntry`, action "Examination data changed in review", naming the audit row as `attempt` and the actor's uid). What the request issued with stays readable: after issue a value can only be filled, and each fill is marked (below), so `scopeValuesAsIssued` (the values less those marked for the revision issued) is exactly what it issued with (one stated edge: a request sent back and re-issued under the SAME revision label still reads a value completed after the first issue as completed after issue); the issuing audit row's `examinationScope.required[].value` still records the required values at the act. (b) After issue (PENDING_IFC / FINAL_DRAFT) a field still MISSING may be filled by the drafter, the engineer (assigned or on an engineering sign-off) or the queue — marked `afterIssue: { rev }`, audited with `completedAfterIssue: true`, put on the history ("Examination data completed after issue"), shown "(completed after issue)" on the panel; it changes no status and re-opens nothing (the history append writes only `history`). A recorded value is never changed or cleared after issue (409 `issued`; a call mixing a fill and a change is refused whole), the requester may not fill, and no waiver is recorded. *The history line is a bookkeeping append* (compare-and-set on `last_modified`, read again and tried once more; `last_modified` untouched — the deliverable-reference route's rule): when it cannot be written the value change still stands (DEC-90: bookkeeping never blocks the act), the answer says `historyNotWritten: true`, it is logged, and the `TICKET_EXAMINATION_SCOPE_SET` audit row (written first, with `from` / `to`) is the durable record; a concurrent whole-array history write by another route may drop the line (the same stated residual as that route's).
(5) **GAP-102 acceptance 1, stated as the code does it (records gap).** The create form does NOT carry examination data. The data is specified on the request page after filing — by its requester while it is still with the drafter (an empty field), or by the drafter or the engineer — and with it recorded the issuing act needs zero additional touches (no prompt, no added act, the same answer as an unconfigured workspace — pinned). It is not zero touches at filing: recording the data is one act on the request page. The Done-when lines above that read "zero added touches" mean the issuing act.
(6) **Clock skew (records gap — ruled).** `since` is the database's clock (+60 s, 20261266) and `tickets.created_at` the app server's; a request filed less than 15 minutes after `since` is now treated as in flight — warned, never refused (`SCOPE_CLOCK_SKEW_GRACE_MS`, applied in `examinationScopeStatus` and `hasBindingRequirement`, so the workflow route's gate, the consent close and the panel all read it). "A request already in flight is never newly blocked" therefore holds under any skew under 15 minutes. The admin editor says when a requirement binds (`scopeBindsFrom`: `since` + 15 minutes) and that it applies to requests filed at least 15 minutes after the save. Pinned at 0, +14:59.999 (warned) and +15:00 (refused), in the rules and through the route. This supersedes the second fix pass's stated one-minute limit.
(7) **The waiver control shows only to someone the shared check allows (records gap).** `GET /api/tickets/examination-scope?ticketId=…` answers `{ mayWaive }` from `issueAuthorityNow`; the panel asks only where the page already offers the viewer an issuing act on an open, unissued request with data to waive (or a waiver to withdraw), and shows the control only on `mayWaive: true`. The second fix pass's residual ("the waiver button still shows for any person offered a sign-off") is closed.
Tests: `lib/__tests__/dfRoundG_P24_examinationScope.test.ts` (the skew grace; phases; `scopeFieldRight` across every phase × person; `checkScopeWrite`; the after-issue mark and `scopeValuesAsIssued`; the history line; `examinationScopeProblems` and its parity property), `lib/__tests__/dfRoundG_P24_scopeFillRoute.test.ts` (the requester refused on another's value and allowed on their own; in review — drafter / queue / requester refused, the engineer of record's change with its history line, a clear, no engineer of record, an unwritable history line; after issue — drafter / engineer / queue fill with the mark and history line, requester refused, change / clear / mixed refused; the GET), `lib/__tests__/dfRoundG_P24_issueGateRoute.test.ts` (the waiver refused where the workflow route refuses; the skew grace through the route), `lib/__tests__/dfRoundG_P24_scopePanelsRender.test.ts` (per-field lists; in review; after issue; the mark; the waiver control only on `mayWaive`; the editor's inline problems), `lib/__tests__/dfRoundG_P24_adminStampRendered.test.ts` (Save refuses each kind of problem, no upsert; the bind time shown with the grace).
**Done-when (re-checked at the merge-time fix pass).** Acceptance 1 ✓ as restated in (5) (the issuing act; the data is recorded on the request page after filing). Acceptance 4 ✓ as ruled (unchanged). Ruling (2)'s "never newly blocked" ✓ under any skew below 15 minutes. Acceptance 2 ✗ — OPEN / Partial (above). Acceptances 3, 5 ✓.
**Scope / residual.** Files outside the plan entry added here: `lib/workflowAuthority.ts` (new, server-only — the workflow route's engine context, shared with the waiver authority). The workflow route's hunks (for DF-P25's rebase): the drafting row's inline type-flag reading → `draftingTypeFlags`; the requester-roles / declaration / engineer-pick / source-drift block → one `workflowEngineContext` call (the declaration's 503 kept, same sentence and code); the TIER-5 block → one `rosterlessRoutedRefusal` call; `DECLARATION_DECIDES` moved; unused imports dropped. The second fix pass's item (7) "values … are refused once the request has issued" is superseded for values by (4)(b) (a missing field may be filled; a recorded one is still never changed); its waiver half stands. `20261266` unchanged.


**DF-P24 merge-time fix pass 2 (2026-10-22, drafting-flow Round G — the independent review of `53a40a2`: no regressions, two minors, two nits; the integrator's rulings, DEC-90; DEC-29).** Status unchanged. `20261266` is NOT changed.
(1) **A field key named like an Object.prototype property is enforced, and refused.** (a) Every value lookup is own-property only — `lib/examinationScope.ts` `scopeValueOf` (`Object.hasOwn`) in `examinationScopeStatus`, `checkScopeWrite`, `applyScopeChanges`, the gate (`scopeGateOutcome` through the status) and the panel (`components/requests/ExaminationScopePanel.tsx`), and the fill route's audit `from` / `to`; values, changes and the as-issued view are written as own properties (`Object.defineProperty`), so a `__proto__` or `constructor` entry read from the database stays data and never touches a prototype. Before this, a key such as `constructor` read the inherited function as a recorded value: its requirement was never enforced (the reviewer's probe). (b) The parser drops a key that is a property of Object.prototype or `__proto__` (`RESERVED_FIELD_KEYS`), and `examinationScopeProblems` names it ("can't be used as a key …") — so the editor shows it inline and Save refuses it, consistent with the parser; a requirement on it is named as data that would be dropped. Pinned: on a configuration built directly (the parser would drop the key), each of `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf` — missing — blocks in the status and the gate, and the requester's fill of it is accepted and then satisfies it; the parser drops all six names and the editor flags each (rendered for `constructor` and `toString`); the parity property's key pool now includes them. *Stated:* 20261266's stamp trigger still treats such a key as a fillable field when deciding whether a stored requirement keeps its time — harmless, because the parser drops the field, so such a requirement binds nothing.
(2) **The refusal names who can act now.** `examinationScopeRefusal` is worded by phase and fact. In review with an engineer of record: "… Its engineer of record can record it on the request page, or the request can be sent back for revision; you can instead record why it issues without it." (the last clause only when the caller may waive). With no engineer of record: "… It has no engineer of record, so you can record why it issues without it, or the request can be sent back for revision." ("someone who can issue it may" when the caller may not). Before review (no issuing act is offered there today): the drafter or the engineer. The workflow route's gate passes `callerMayWaive: true` (`lib/examinationScopeGate.ts`): the gate runs only after the route's own authority checks, which are the acts `issueAuthorityNow` accepts a waiver from. The consent close does not use the sentence (it holds with its own history line). Pinned: both wordings in full, through the route too; no wording in review names the drafter.
(3) **A malformed `requestTypes` no longer hides the configuration from the gate.** `app/api/tickets/workflow-action/route.ts`: the gate gets its own copy of the 'drafting' row (`scopeDraftingCfg`), taken before the request-type flags are computed, so `draftingTypeFlags` throwing on a malformed `requestTypes` (a non-list `options`) leaves the gate reading the workspace's `examinationScope`, as the consent close does. The flags computation is unchanged, and every other reader keeps `draftingCfg` exactly as before (the minor-correction note and the work / code class triage, which a moved `draftingCfg` would also have changed on such a row — so a separate variable rather than moving the assignment). Pinned: a new sweep (every action × status × member) over three malformed-`requestTypes` configurations — none, a requirement on another library: byte-identical with the gate removed, no read; a requirement on this library: only an issuing act or a completing sign-off differs, refused 409 `examination_scope_missing`. Checked against the route without this change: 1,356 runs, 1,346 identical, the 10 others exactly those gated issuing acts. The existing sweep's 1,831 runs were dumped before and after this pass: identical except the four refusal sentences reworded by (2) (same status, same database calls).
(4) **The one stated exception, plainly.** A workspace that configures no examination data is exactly today's — no read of `ticket_examination_scopes`, no refusal, no key on any record — with ONE stated exception: when its 'drafting' row cannot be read at all, an issuing approval or a completing sign-off goes ahead as today and its audit row carries `examinationScope: { configUnchecked: true }`, because the route cannot know whether that workspace configured anything (pinned by the unreadable-row sweep: that key is the only difference).
Tests: `lib/__tests__/dfRoundG_P24_examinationScope.test.ts` (prototype-named keys enforced on a direct configuration; database values under such names stay own data; the parser drops and the editor names each; both refusal wordings; the parity pool), `lib/__tests__/dfRoundG_P24_scopePanelsRender.test.ts` (the editor flags `constructor` / `toString` inline), `lib/__tests__/dfRoundG_P24_issueGateRoute.test.ts` (the malformed-`requestTypes` sweep; the refusal through the route, with and without an engineer of record).


*Assigned (2026-10-22, the integrator at the DF-P24 merge, DEC-31):* ruling (2)'s notify-only limb — a structured examination column on `document_holds`, written in the hold's own insert, then the parser's notify-only opt-in → drafting-flow **DF-P25** (declares document-control's hold files). Acceptances 1 and 4 and the sheets limb are built (DF-P24). The restore import of `ticket_examination_scopes` (waiver cleared) → DF-P25.

**Partial (2026-10-22, drafting-flow Round G) — DF-P25: ruling (2)'s notify-only limb is BUILT, and `ticket_examination_scopes` is restored; GAP-102 stays OPEN only for acceptance 2 (the issue notice carrying the examination data — the notifications area, unchanged; "Hand-offs from DF-P24").** DEC-90 ruling (6) and (7) for DF-P25; calls in `DEC-44 (DF-P25-exception-review)`. Reproduced on `cbd5772`: `document_holds` had no structured column (only `notes`); `parseRoutingControl` dropped `records_examination` on a notify-only slot (`lib/routingControl.ts:267`, pinned in `dfRoundG_P24_examinationScope.test.ts`); `ticket_examination_scopes` was in `IMMUTABLE_TABLES` (`lib/dataRestore.ts:214`).
(1) **The record rides the hold's own insert.** `document_holds.examination` (JSONB, 20261267 §4): a JSON object of bounded size or NULL (CHECK `document_holds_examination_shape`), never changed once written, for every role (`trg_document_hold_examination_fixed`, BEFORE UPDATE OF examination, opened_by, opened_by_name, SECURITY INVOKER, search_path pinned — review fix pass 3 (7) for the opener columns). 20261073's guards are NOT re-created — a column-only change (20261073 is a pending PASTE, not a HOLD, but nothing in it needed to change). `lib/holds.ts` `openHold` writes `examination` in THE SAME insert as the hold (`OpenHoldInput.examination`), so the record and the stop cannot disagree (the ROW; who wrote it is tied by the review fix below); a hold placed without one inserts exactly what it inserted before (no key — pinned); before 20261267 (PGRST204 / 42703 naming the column — `isMissingHoldExaminationColumn`, `:162`) the hold is still placed, without the record, and the result says `examinationNotRecorded` (`:397`) — the stop is never refused for its record (DEC-90 ruling (8)). The hold is NOT given `origin_ticket_id` (the close gate releases a request's origin holds — a stop must outlive the request's close); the record names the request instead (`ticketId`).
(2) **The opt-in on a notify-only slot.** `notifyExaminationOptInAllowed` (`lib/routingControl.ts:177`): a NOTIFY-ONLY slot not filled by the requester alone nor by an engineering capability; `parseRoutingControl` keeps `records_examination` there (still dropped silently anywhere else), `validateRoutingDraft` accepts it, the routing editor offers "Record what they examined when they place a hold" with `NOTIFY_EXAMINATION_HINT` ("… no sign-off is added", never a steer to a blocking slot — `components/documents/RoutingControlSection.tsx` `notifyExaminationOptInFor`, `:124`), and the roster carries it (`lib/ticketRoster.ts:404`). Such a slot is never an assurance SIGN-OFF slot (`isAssuranceSlot` stays blocking-only) and never accepts a standing pre-authorization (`preauthorizationOptInAllowed` unchanged) — sign-offs, vetoes and the roster ledger are untouched.
(3) **The panel shows the hold's record.** `components/requests/NotifyHoldExamination.tsx` (new; mounted in `TicketRosterPanel`, `:691`): with such a slot on the roster on record, it reads the holds on the request's source document that carry a record of THIS request (the viewer's RLS read; `holdExaminationOf`) and shows each with what was examined (files, note, the reviewed version); the slot's own people, while the review is open, get "Stop it with a hold" (renamed "Place a hold on the document" by review fix pass 5 (9): the hold stops work on the document, NOT the request) — the files (every file by default), a REQUIRED note (`holdExaminationRecord`, `lib/assuranceExamination.ts:289`), the hold reason and description — which calls `openHold` with the record. A request naming no source document says so (nothing to hold). It renders NOTHING and reads NOTHING without such a slot (pinned, directly and through the roster panel); a closed round with such a slot keeps the panel up for the holds' records (one added condition on the panel's early return, false on every other roster).
(4) **Restore (the DF-P24 follow-up).** `ticket_examination_scopes` moves out of `IMMUTABLE_TABLES` into `RESTORE_SERVICE_ROLE_WAIVERS` (`lib/dataRestore.ts:236`), restored after `tickets` (`RESTORE_TABLE_ORDER`, `:1041`; parent rule `ticket_id>tickets`, `:397`; conflict target `ticket_id`, `:1093`) with the WAIVER cleared by a restore-side transform scoped to this table only (`landRestoredRow`, `:570`) and every uid in it (`updated_by`, each value's `by`) remapped by the existing deep remap. The export is unchanged.
Tests: `lib/__tests__/dfRoundG_P25_notifyHold.test.ts` (parser / editor / roster / helpers; rendered — nothing without the slot, the records shown, the form, the insert's record, the not-stored and no-source cases, the pre-paste read), `lib/__tests__/holds.test.ts` (DF-P25 block — the insert's keys unchanged without a record; one insert with it; the PGRST204 fallback; another refusal still thrown), `lib/__tests__/dfRoundG_P25_restoreScopes.test.ts`, on PostgreSQL 16 `lib/__tests__/rls/dfP25ExceptionReviewFollowups.test.ts` (a member's hold with a record; non-object / oversized refused 23514; the record never changed by the opener, an Admin or the service role; the release unchanged; a hold without one exactly as before). Updated pins (intent kept, ruling applied): `dfRoundG_P24_examinationScope.test.ts` and `dfRoundG_P20_assuranceExamination.test.ts` — the notify-only opt-in is now kept; every other misplaced value is still dropped.
(5) **Review fix — who placed the hold (DF-P25 fix pass).** The first pass tied the record to the hold ROW but not to its WRITER: `document_holds.opened_by` / `opened_by_name` are whatever the client sends (20261073's INSERT policy checks the capability and the document's workspace only), so any member holding `holds.open` could insert a hold naming another person (say the QA occupant) as its opener with a record naming the QA slot, and the panel showed it as "Quality — held by QA Lead · Examined all N files". Now: (a) 20261267 §4 adds `document_hold_examination_opener()` (new; SECURITY INVOKER, search_path pinned, no client EXECUTE) with `trg_document_hold_examination_opener` (BEFORE INSERT ON document_holds): a client role's insert that carries a record is refused 42501 unless `opened_by = auth.uid()`; the service role (a restore, a server route) and a SECURITY DEFINER path pass; a hold without a record is not looked at; 20261073's guards are still not re-created (probe 8; PostgreSQL 16: a record on a hold in another uid's name refused with this guard's message and nothing written, the same record in the caller's own name lands, the service role's insert untouched, a hold without a record never meets this guard). (b) The panel shows a record as a slot's stop ONLY when the hold's opener is a primary or an alternate of the NOTIFY-ONLY slot the record names, in the round it names — the roster on record, or for an earlier round the roster ledger `ticket_review_slots` read as the viewer (`holdOpenerInSlot` / `rosterOccupancy`, `lib/assuranceExamination.ts`); any other record is only counted ("… not placed by the people of the slot named — not shown as their stop"), and an earlier round whose ledger rows cannot be read is counted as unchecked, never shown. (c) The read is filtered to this request IN THE QUERY (`examination->>ticketId`), so other requests' holds on the same document never crowd it out, and a full page (more than `NOTIFY_HOLD_READ_LIMIT` = 50) says more exist. Tests: `dfRoundG_P25_notifyHold.test.ts` (the forged "Quality" stop not shown, only counted; an earlier round checked against the ledger, and unchecked when the ledger cannot be read; the query filter, the limit + 1 and the "more" note; `holdOpenerInSlot` cases), `dfRoundG_P25_migration.test.ts` (the opener check's body, trigger and probe count), `rls/dfP25ExceptionReviewFollowups.test.ts` (15 cases on PostgreSQL 16 at that pass; 16 after review fix pass 2).
(6) **Review fix pass 2 — who can stop it, and a round with no files (DF-P25 fix pass 2).** (a) The form was offered to every occupant of the opted-in slot, whether or not they hold `holds.open`, and `openHold`'s capability check then refused them — the panel had promised a stop that did not exist. `NotifyHoldExamination` now reads the capability policy (`loadCapabilityPolicyEntry`, fail closed: until it is read, or when it cannot be — `affordancePolicyFault` — no form, the reason and Try again) and offers the form only when `holdControlsFor(policy, role, roles, uid).canOpen` (`lib/holds.ts` — the same policy, additive roles, per-person grants and read-only subtraction `assertHoldCapability` applies; the role and collection come from the page's `useRole()` through `TicketRosterPanel`'s new `role` / `roles` props); otherwise the occupant reads `HOLD_NOT_PERMITTED` — they cannot stop this review with a hold, where an Admin allows it (Admin → Permissions → Action permissions, Place a hold), and to raise it with the assignment queue meanwhile. The policy is read only for an occupant who would be offered the form. The routing editor's `NOTIFY_EXAMINATION_HINT` now tells the controller the slot's people need permission to place holds. (b) A round with no files under review left the button disabled with no reason (the default pick was the empty file list, which the record refuses). The form now says `NO_FILES_UNDER_REVIEW` and sends no file list, so the note alone is the record (`files: []`, `ofFiles: 0`), shown as "No files were under review" (`examinedFilesText`, `lib/assuranceExamination.ts`). Tests: `dfRoundG_P25_notifyHold.test.ts` (a read-only viewer and a narrowed `holds.open` → the note, no form; a per-person grant → the form; an unreadable policy → no form, Try again re-reads; no policy read for someone outside the slot; the roster panel forwards the role and collection; a no-files round places the hold with the note alone; the hint).
(7) **Review fix pass 3 — the opener stays put, and the name shown is the member list's (DF-P25 fix pass 3).** (a) Paragraph (5) said the database ties a record to its writer with no condition, but after the insert that tie rested on 20261073's identity guard (`enforce_document_hold_guard` pins `opened_by` / `opened_by_name`), and 20261073 is still a pending PASTE (MIGRATION-PASTE-ORDER row 68): until it is pasted, a `holds.release` holder could place a hold with a record in their own name (allowed) and then re-point `opened_by` at a slot's person, and the panel would show it as that person's stop. Now 20261267 §4 pins it itself: `trg_document_hold_examination_fixed` fires BEFORE UPDATE OF examination, opened_by, opened_by_name, and `document_hold_examination_fixed()` refuses 42501, for every role, any change to `opened_by` or `opened_by_name` once the hold carries a record (`OLD.examination IS NOT NULL`); a hold without a record is not looked at, and 20261073 is still not re-created (column-only) and no longer relied on. Probe 7 checks the trigger's columns and the opener clause; PostgreSQL 16, with `trg_document_hold_guard` disabled to stand in for production: the re-pointed opener and a changed `opened_by_name` refused 42501 for a client and the service role, the same columns written unchanged plus the notes still land, a hold without a record not looked at (the case fails with the clause removed). (b) A record judged a slot's stop was headed with `opened_by_name`, text its writer typed (the opener check looks at `opened_by` only). The panel now heads it with the opener's name from the workspace's member list (`org_members`, read as the viewer, only for the openers of the records read — `slotStopHolder`), or "a member of <slot>" when that list cannot give a name; `opened_by_name` is no longer even read. (c) The prerequisite block now also refuses, changing nothing, without 20261241's `routing_control` columns (inventory row 6 reads them), instead of stopping on a bare 42703. Tests: `dfRoundG_P25_notifyHold.test.ts` (a forged `opened_by_name` never shown; the member-list name; unnamed when the list is unreadable; `slotStopHolder`), `dfRoundG_P25_migration.test.ts` (the opener clause, the trigger's columns, probe 7, the prerequisite), `rls/dfP25ExceptionReviewFollowups.test.ts` (17 cases).

(8) **Review fix pass 4 — the bookkeeping never refuses the stop, and an opt-in is never carried across modes (DF-P25 fix pass 4).** (a) Major: `CHECK document_holds_examination_shape` bounds the record at 32 KiB, but the record listed every file examined (default: every file under review) with no cap, and `openHold` retried without the record only for the missing column — so on a large round (about 200+ sheets) the CHECK's 23514 refused the HOLD itself, and the person's only stop did not happen (against ruling (8)). Now both: `holdExaminationRecord` (`lib/assuranceExamination.ts`) keeps every record within `HOLD_EXAMINATION_BUDGET_BYTES` (24 KiB, measured by `jsonbTextBytes` exactly as `octet_length(examination::text)` counts it — pinned equal on PostgreSQL 16) by naming the files examined in the roster's order while they fit, marked `filesTruncated` with `examinedFiles` (how many were examined in all); the content hash, the counts and the note are kept, and `examinedFilesText` says "Examined all 320 files: … (only the first N named — the record's size is bounded)"; a record within the budget is exactly as before (no new keys). And `openHold` (`lib/holds.ts`) also treats a 23514 naming `document_holds_examination_shape` (`isHoldExaminationShapeRefusal`) as "place the hold without the record", returning `examinationNotRecorded` plus `examinationTooLarge`, and the panel says the record was too large to store (`HOLD_RECORD_TOO_LARGE`), not the missing-update sentence. Any other refusal is still the hold's own. (b) Minor: the routing editor's mode select now goes through `withSlotMode` (`components/documents/RoutingControlSection.tsx`), which drops `recordsExamination` on any mode change — the opt-in means an assurance sign-off on a "must sign off" slot and a hold-recording stop on a notify-only one, so switching an opted-in slot never makes it the other kind unchosen; the controller ticks it again under the new meaning. Tests: `dfRoundG_P25_notifyHold.test.ts` (the measure; within budget unchanged; a 320-file round with a 2000-character note bounded, ordered, counted and said; a narrowed pick says "350 of 400"; a reader distrusts a marker that does not add up; the too-large sentence; a mode change drops the opt-in both ways), `holds.test.ts` (the 23514 fallback; another check's 23514, or one with no record, still thrown), `rls/dfP25ExceptionReviewFollowups.test.ts` (18 cases: a 320-file record as built lands and its stored size equals `jsonbTextBytes`; the same record naming every file is refused 23514, recognised by `isHoldExaminationShapeRefusal`).
(9) **Review fix pass 5 — the hold is named for what it stops (DF-P25 fix pass 5).** Major: the panel and the routing editor's hint called the notify-only hold a stop of the request or its review ("To stop it, place a hold on its source document", "Stop it with a hold", "Stops by the people told", `HOLD_NOT_PERMITTED`'s "you cannot stop this review with a hold", `NOTIFY_EXAMINATION_HINT`'s "If one of them stops the request"). It is not one. Re-verified: nothing on the request's issuing path reads holds on its source document — the workflow route's only `document_holds` reads (`app/api/tickets/workflow-action/route.ts:1521`, `:1946`) run at close, for holds whose `origin_ticket_id` is this request, and this hold is deliberately placed without one (paragraph (1)); `lib/workflow.ts`, `lib/ticketTransitions.ts` and `lib/consentWindowScan.ts` read no holds. So the drafter and engineer can still complete the roster and issue the deliverable while the hold is in force. What the hold DOES stop is work on the source document itself: no new revision of it is published (`lib/documentGuards.ts` `evaluatePublishGuard`, and the database's publish guard), and it is not transmitted, shared or acknowledged out (`lib/holdGate.ts` `assertNotOnHold`). Option (b) of the review was taken — every sentence now says exactly that, and making the hold a stop of the request is opened as `GAP-116` with a named owner (making it real needs the workflow route's issuing approvals and completing sign-off, which this package does not hold — DEC-31). `components/requests/NotifyHoldExamination.tsx`: `HOLD_DOES_NOT_STOP_REQUEST` (new: the hold stops work on the document — no new revision published, not transmitted or shared — until released; "It does not stop this request: its review can still complete and its deliverable be issued. To stop the request itself, raise it with the assignment queue."), `notifyHoldFormIntro` (the form's opening sentence, carrying it), `NOTIFY_HOLDS_HEADING` ("Holds on the source document by the people told, with what they examined"), `NOTIFY_HOLD_BUTTON` ("Place a hold on the document"), `HOLD_NOT_PERMITTED` ("… you cannot place a hold on the source document from here … To stop this request, raise it with the assignment queue."), and the not-the-slot's count says "not shown as theirs". `components/documents/RoutingControlSection.tsx`: `NOTIFY_EXAMINATION_HINT` says the hold stops work on the document and "does not stop the request — its review can still complete and its deliverable be issued"; the opt-in's label is "Record what they examined when they place a hold". Code comments that said the hold stops the request are corrected (`lib/routingControl.ts` `notifyExaminationOptInAllowed`, `components/requests/TicketRosterPanel.tsx`). No behaviour changed. Tests: `dfRoundG_P25_notifyHold.test.ts` (the rendered intro equals `notifyHoldFormIntro` and carries `HOLD_DOES_NOT_STOP_REQUEST`; the button, the heading; no visible sentence says "Stop it with a hold", "To stop it, place", "Stops by the people told" or "stop this review with a hold"; the hint says the request is not stopped and never says it is).

**Done-when (ruling (2)'s notify-only limb, as assigned).** ✓ a structured examination column on `document_holds` written in the hold's own insert; ✓ the parser accepts `records_examination` on a notify-only slot and the panel shows the hold's record; ✓ the editor's hint never steers toward a blocking assurance slot (pinned); ✓ no hold without the column behaves differently (pinned in `holds.test.ts` and on PostgreSQL 16). Acceptance 2 ✗ (unchanged — owner the notifications area). Acceptances 1, 3, 4, 5 ✓ (unchanged).

**Scope / residual.** Paste `20261267` (either order; deploy first recommended). **The hold does not stop the request** (review fix pass 5 (9)): it stops work on the source document (no new revision published; not transmitted or shared) until it is released, while the request's review can still complete and its deliverable issue — the panel and the routing hint say so, and a notify-only stop that holds the request's issuing path is `GAP-116` (owner drafting-flow DF-P26). The stop is offered only to an occupant who may place holds (`holds.open` — review fix pass 2 (6)); one who may not is told so and where an Admin allows it, and has no stop on this request beyond raising it with the assignment queue. A request naming no source document has nothing to hold (said). The record's content is the opener's own statement, built in their browser from the roster the page holds (the files and hashes the roster recorded); the database pins its shape, its immutability, that a client writes it only on a hold placed in its own name (`opened_by = auth.uid()` — review fix (5)) and that a recorded hold's opener never changes after (review fix pass 3 (7), by 20261267 itself — with or without 20261073); the hold's existing INSERT rules decide who may place one. What the database does NOT check is the record's claims: that the opener is one of the slot's people, and the `opened_by_name` text (both client-supplied). The panel therefore shows a record as a slot's stop only after checking the opener against that slot in that round (review fix (5)(b)), and names the opener from the member list, never from `opened_by_name` (review fix pass 3 (7)(b)). The service role is not checked (a restore lands rows as exported). A request with no source document has no hold to carry a record (said on the panel). On a very large round the record names only the first files examined (review fix pass 4 (8)) — the count, the content hash and the note are always kept; the full per-file list stays on the roster. Files outside the plan entry: `lib/holds.ts`, `lib/assuranceExamination.ts`, `components/documents/RoutingControlSection.tsx`, `components/requests/TicketRosterPanel.tsx`, `components/requests/NotifyHoldExamination.tsx` (new), `lib/dataRestore.ts`, `lib/exportTables.ts` (comment only).


*Assigned (2026-10-22, the integrator at the DF-P25 merge, DEC-31):* acceptance 2 (the issue notice carrying the examination data) → drafting-flow **DF-P26 ISSUING-PATH STOPS**, which holds the issuing path and declares the notice producer's files (no notifications package holds the issue notice). Every other limb of this gap is built.

**Status → RESOLVED (2026-10-22, drafting-flow Round G) — DF-P26 ISSUING-PATH STOPS: acceptance 2's remainder, the issue notice carrying the examination data (DEC-90 ruling (3) for DF-P26; calls in `DEC-44 (DF-P26-issuing-path-stops)` items 7–8).** Every other limb was already built (above); acceptance 2's audience stands as ruled at DF-P6 (a notify-only slot's people are told when the review opens) — residual below.

**Resolution.** Reproduced on `ceaa9d0`: the issue notice (the workflow route's `fanOut` — bell row, email text and HTML — and the consent close's issuing bell, `lib/consentWindowScan.ts`) carried the status line or the comment only; nothing read `ticket_examination_scopes`, the assurance records or the holds. Now `lib/issueNoticeExamination.ts` (new) composes ONE line of names and counts — never a note, a file name or a hash: the request's recorded examination-scope values by the workspace's field and option labels (a value since dropped from the list is shown as recorded; a field no longer configured is left out), the latest assurance record per assurance slot of the issuing roster ("examined 2 of 3 files", "examined all 1 file", "files under review: 3 files, not narrowed", "no files were under review"), and the count of holds a notify-only slot's people placed on the source document with what they examined (released, or how many still in force). It rides the EXISTING notification kind of the issue (`ticket_status`, the same `emit()` path) as a paragraph after the body (`\n\n` on the bell, a line in the text email, a `<p>` in the HTML email), on `ISSUING_APPROVALS` and a completing `sign_slot` (route `:2261`, `fanOut` `:2739`, `:2774`) and on the consent close that issues. Reads happen only where something could be recorded (`issueExaminationMayExist`: examination fields configured, an assurance slot on the roster, or a notify-only hold-recording slot with a source document); each read that fails leaves its part out (never throws), and the whole read is bounded at 2.5 s (`ISSUE_EXAMINATION_DEADLINE_MS`) — past it the notice goes out as today's. *(DF-P26 review fix:)* where such a record could exist, composing the line AND sending the notice run AFTER the response (`next/server` `after()`, as the pre-authorization step and the email drain do), so the read never delays the person's act (DEC-90 ruling (4)); where none could exist (every unconfigured workspace) the notice is written inside the request exactly as before. **Nothing recorded → today's notice, word for word** (pinned in the route and at the consent close, configured and unconfigured).

Tests: `lib/__tests__/dfRoundG_P26_issueNotice.test.ts` (the line, the may-exist rule — no read when nothing could exist, the reads, never a note or file name, the deadline), `lib/__tests__/dfRoundG_P26_holdStopRoute.test.ts` (GAP-102 block — an issuing approval: every bell row and email of the existing kinds equals the route-without-the-line's plus the one line, nothing else changed; the completing sign-off of a review with an assurance slot names the slot and the count, never the note or a file name; none recorded → today's bodies), `lib/__tests__/consentWindowScan.test.ts` (DF-P26 GAP-102 block — the consent close's bell rows end with the line; nothing recorded → today's body). Pins adjusted with intent: `dfRoundG_P24_issueGateRoute.test.ts` and `consentWindowScan.test.ts`'s DF-P24 sweep filter the notice's own `field_values` read (the gate's pins unchanged). Review fix: `dfRoundG_P26_holdStopRoute.test.ts` "the examination read never delays the act" (a hanging `issueExaminationNote`: the response is 200, no bell row or email written inside the request, the after-response task writes them with the line) and "where no record could exist the notice is still written inside the request".

**Done-when.** ✓ an issue notice names the recorded examination data (scope values, assurance records, the slot's holds) — names and counts only; ✓ through the existing notification kind; ✓ none recorded → today's notice (pinned); ✓ a read that fails or runs long never holds the issue or the notice — and, since the review fix, never delays the person's answer either (the notice is composed after the response where a record could exist; pinned: the response returns while the examination read hangs). *Fix pass 3 (DEC-29):* the hold count judged each hold against the CURRENT roster only, so a hold carrying an earlier round's record — which the stop counts since DF-P26 fix pass 2 (`notifyHoldRecordsEarlier`) — was left out of the notice. Now the notice judges it as the stop does: the occupancy assembly is shared (`lib/requestHoldStop.ts` `holdRecordOccupancy` — the roster on record's slots plus, only when a record names an earlier round, that round's `ticket_review_slots` rows), and here a failed ledger read leaves only the earlier rounds' holds out (bookkeeping, DEC-90 ruling (4)). Pinned: `dfRoundG_P26_issueNotice.test.ts` "an earlier round's hold is judged against that round's ledger slots" (counted; ledger unreadable → left out; a current-round hold reads no ledger) — mutation-checked.

**Scope / residual.** The notice's AUDIENCE is unchanged: the issue's existing recipients (the requester, the drafter, the routed pool, the unread list). A notify-only slot's people are told when the review opens (DF-P6's ruled form of "notified of every issue"); they are not told again at the issue, so the data reaches them only on the request page (the panel) — adding them to the issue's audience would change who is notified on every configured roster and is not done here (owner, if wanted: the notifications area, DEC-31). The line is composed at issue time from what is recorded then; a value recorded after the issue is not re-sent. Files outside the plan entry: `lib/issueNoticeExamination.ts` (new — the notice producer's composer); the producers themselves are `app/api/tickets/workflow-action/route.ts` (`fanOut`) and `lib/consentWindowScan.ts` (the issuing close's bell), both in plan.

---

<a id="gap-103"></a>
## GAP-103 · Parallel reviewer roster on the ticket

**Verdict: BUILD** · Effort: **L** · Depends on: `GAP-105`

> **This is the keystone.** `GAP-101`, `GAP-102` and `GAP-104` all become cheap
> once it exists and all become friction disasters without it.

### Scope

**In:** the ticket's review stage runs on a roster of required reviewers who sign
in any order, with the ticket advancing automatically when the last required
signature lands.

**Out (deliberately):** replacing the whole ticket state machine. The roster
replaces the review *stage* — `PENDING_REVIEW` and `PENDING_FINAL_APPROVAL` —
not `PENDING_ASSIGNMENT`, `DRAFTING` or `PENDING_IFC`.

**Out:** quorum rules (N-of-M). The evaluator is boolean; adding counting is a
separate project with no stated requirement.

### Design

**Do not design this from scratch — it already exists on the document side.**
`lib/reviewControl.ts` has: required primaries plus alternates expanded from
people, roles and teams; signatures bound to the draft's `content_hash`;
invalidation when the draft changes, with the earlier signers told why;
timeout-driven alternate activation; and auto-finalize when the last required
signature lands, with the database re-checking completion transactionally.

Every property the ticket flow needs, already built and already tested.

The work is to make it reachable from the ticket: `getActions`
(`lib/workflow.ts:61-65`) currently receives `ticket`, `userRole`, `userId` and
`policy` — **no library and no review control**, which is why `DCW-6` exists.
Once `GAP-105` gives the ticket a library, the library's `review_control`
resolves through the chain already in place.

This also collapses `TIER-8` entirely: if the ticket's review *is* the document's
review roster, an engineer is not asked to review the same drawing twice.

### Do not

- **Do not implement the review model from `GAP-101` / `GAP-102` on the current
  serial machine.** A new-design B31.3 package would become eight hops and six
  people, and people will route around it. **That failure mode is the reason this
  audit exists.**
- **Do not build a second roster mechanism.** One review system, not two
  (`TIER-8`).
- **Do not let a ticket approval satisfy a document sign-off without an
  e-signature bound to the content hash.** See `DEC-23` — and note the dead
  `related_ticket_id` waiver is exactly the shortcut that looks like this and is
  not.
- **Do not remove the identity rights** at `lib/workflow.ts:69-75`. A ticket's
  requester, drafter and engineer can never be locked out of their own ticket by
  a policy edit; whatever replaces the review stage must keep that.

### Acceptance

1. Two required reviewers on the same ticket can sign in either order, or
   simultaneously, with neither waiting on the other.
2. The ticket advances automatically when the last required signature lands.
3. Adding a reviewer to a requirement adds no status.
4. A reviewer who signed on the ticket is not asked to sign again at publish for
   the same artifact.
5. Identity rights still hold.

**Related findings:** `TIER-5`, `TIER-8`, `DCW-6`, `FRIC-1`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P5 ROSTER): the parallel roster exists on the ticket and its mechanics are the document side's, called — `lib/ticketRoster.ts` (`openRoster`, `rosterContentHash`, `applySignPlan`, `rosterCompletion` → `lib/reviewControl.ts` `evaluateSlotCompletion`), the engine's roster mode (`lib/workflow.ts` `currentRoster` / `slotSignPlan`), the workflow route (opens on submission into a routed library, e-signature-bound sign-offs, the last one issues), the ledger `20261242` (pending paste) and `components/requests/TicketRosterPanel.tsx`. Acceptance 1–3 ✓ and 5 ✓ (identity rights untouched: the requester always keeps Request Revision; the drafter's own actions are unchanged) on every request whose library routes its reviews; an unconfigured workspace keeps today's serial machine (DEC-90 ruling (2)). A routing table adds reviewers and never drops the org-wide engineering gate: where `engineerApprovalRequired` (or an engineering-first type) holds and the table carries no blocking engineering-capability slot, the seed's engineering slot is appended and said (`lib/ticketRoster.ts` `withEngineeringGate`, DF-P5 fix pass 2). Acceptance 4 (a ticket sign-off satisfying the publish roster for the same bytes) is NOT met — R&P `LIFE-12`'s, under `DEC-23`; the ticket side records the signature and content hash that bridge needs. See `TIER-5`, `TIER-8`, `DCW-6`.*

---

<a id="gap-104"></a>
## GAP-104 · Document-control release routing, per library

> ### ⚠ Build the mechanism as `GAP-112`
>
> The need below is real and the per-library reasoning is right. The mechanism is
> a routing slot filled by `{ owner_of: "library" }` (`GAP-112`), not a
> doc-control-specific code path. `DEC-35`, `DEC-36`.

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-105`, `GAP-103`

### Scope

**In:** a library can require document-control review before its drawings are
released, satisfied on the parallel roster.

**Out (deliberately):** a `PENDING_DOC_CTRL` status, and a global "all drawings
go through doc control" switch. Both add serial cost to every ticket
(`DCW-2`).

**Out:** routing by drawing type. Per `DCW-3`, the library is the better proxy
and already inherits.

### Design

The rule lives on the library and resolves through the container chain —
document → folder → library, most specific defined level wins — exactly as
`docClass` and `review_control` already do. An org that keeps P&IDs in a P&ID
library gets the routing for free.

The document controller becomes a **reviewer slot on the `GAP-103` roster**, so
release review runs alongside technical review rather than after it. Where a
library does not require it, no ticket ever sees it.

This finally makes `ticketAttention.ts:106` true. Whoever wrote that line
believed document control belongs at issue and release — **they were right about
the model and the flow never implemented it** (`FRIC-7`, `DCW-2`).

### Do not

- **Do not add a status.** `DCW-2`'s chain-reaction note is explicit: a serial
  doc-control hop on every ticket is exactly the friction the stated requirement
  forbids.
- **Do not route on a drawing-type enum.** `DCW-3`.
- **Do not give DocCtrl blanket `ticket.manage`.** That would make them a
  management-tier approver on every ticket, which is not the function. A scoped
  reviewer slot is.
- **Do not confuse release review with the hand-back.** This gap is *doc control
  reviews before release*; `GAP-6` (roles-and-permissions area) is *the
  deliverable reaches the register at all*. Both are needed and they are
  different — a controller reviewing a deliverable they then cannot register is
  no better than the reverse.

### Acceptance

1. A library can require document-control review before release; libraries that
   do not are unaffected.
2. Satisfying it adds no serial status hop.
3. A document controller's attention badge reflects work they can actually do
   (`FRIC-7`).

**Related findings:** `DCW-2`, `DCW-3`, `DCW-6`, `FRIC-7`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL — record and test on DF-P5's roster): a library's routing table can carry a blocking slot filled by document control; acceptance 1 ✓ (libraries without one are unaffected), 2 ✓ (parallel roster, no status), 3 ✓ (FRIC-7, and pinned for the slot). See `DCW-2`.*

---

<a id="gap-105"></a>
## GAP-105 · Ticket → library binding

**Verdict: BUILD** · Effort: **S** · **Prerequisite for `GAP-103` and `GAP-104`**

### Scope

**In:** a `library_id` on the ticket, set at intake where derivable and confirmed
at triage otherwise.

**Out:** a full container path (folder-level targeting). Library granularity is
enough for every routing rule in this audit, and the chain resolver handles the
rest.

### Design

Small, and it unblocks the two largest builds. Derive from
`metadata.source_document.id` where a source document exists. For a new-document
request, offer the libraries the requester can see — and where they can see none,
defer to triage, which is a step that already exists.

**Note the `DCW-5` interaction:** a requester who cannot *read* a restricted
library may still legitimately need to request work in it. The ACL already
supports `discover` without read; the request form does not use it.

### Do not

- **Do not make it required at intake.** A requester who cannot pick a library
  must still be able to file (`UI-5`, `FRIC-3`). Triage resolves it.
- **Do not infer it from `unit`.** `unit` is free text (`DCW-7`) and units do not
  map to libraries.

### Acceptance

1. A ticket created from a document viewer carries the source document's library
   automatically.
2. A ticket without one can still be filed, and triage must resolve it before
   assignment completes.
   *Note (DF-P4 fourth fix pass, ruled under `DEC-90`): the second half of
   this acceptance is superseded — a library is **never required, at intake
   or at assignment**: [`DEC-107`](../DECISIONS.md#dec-107) item 2
   and `DCW-1`'s ruling (`03-doc-control-wiring.md`, DCW-1 Partial: "Never
   required"). Triage MAY set or correct it; a ticket with no library is
   assigned, issued and closed as before.*
3. Library-scoped rules can be evaluated against any ticket past triage.

**Related findings:** `DCW-1`, `DCW-5`, `DCW-6`.

*DF-P6 REVIEW-MODEL (2026-10-21), corrected at its review fix pass (DEC-29): acceptance 3 is NOT met. DF-P6 first added `libraryId` to `ticketResource`, but the attention badge's mappers (the requests list's `fromRow`, `lib/inbox.ts` `rowToTicket`) do not carry `library_id`, so the badge and the buttons would disagree; the resource is back to request type and unit. `20261250`'s inventory still counts stored library-scoped ticket rules (expected 0). Hand-off: 99-fix-sequencing "Hand-offs from DF-P6". See `DCW-6`.*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* acceptance 3 (the library in the ticket's capability resource) → drafting-flow **DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION**.

*Landed 2026-10-22 (drafting-flow Round G, DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION; the integrator's rulings (1)–(3) and (5) under DEC-90): acceptance 3 ✓ — a library-scoped rule is evaluated against every ticket that carries a library (set at intake or at triage, DF-P4): `lib/workflow.ts` `ticketResource` presents `libraryId` (with `workClass` / `codeClass`), and every mapper that builds a ticket for the engine — the workflow route's and the cron's `rowToTicket`, the request page's and the requests list's `fromRow`, `lib/inbox.ts` `rowToTicket`, the attention badge's `fromDbTicket` — spreads `lib/reviewModel.ts` `reviewModelFieldsFromRow`, so the page, the list, the inbox, the badge and the route decide alike (`lib/__tests__/dfRoundG_P19_ticketResource.test.ts` runs one row through all five over every status × role × identity). A ticket with no library presents null and decides exactly as before (ruling (3), pinned the same way). A library-scoped `ticket.*` rule stored before DF-P19 only adds until an Admin confirms it (ruling (2): `lib/capabilityPolicy.ts` `ruleInForce` / `effectiveTokens`; the console's Confirm; `DEC-44 (DF-P19-ticket-resource-dimensions)`); one saved through the policy route since is confirmed by that save. The stored rules are inventoried, counts only, per workspace, NARROW / GRANT / SAME, by `20261263` (read-only; paste before the deploy). The DF-P4 hand-off's third item (`lib/dataRestore.ts` `RESTORE_PARENT_RULES.tickets`) was revisited and is kept: a restored ticket whose library is not in the target workspace has its pointer cleared, as the live `ON DELETE SET NULL` does — no rule of the target workspace can name that library, so clearing changes no answer; the rule's comment there ("the pointer confers no access … whoever adds it there revisits this rule") is now stale and is admin-and-org's file to reword (not edited here — fleet rule). See `TIER-4`, `DCW-6`.*

*Corrected at the DF-P19 second fix pass (2026-10-22, review minors 3 and 4; DEC-29).* (a) "A ticket with no library … decides exactly as before" is true of the workflow route and the request page, not of the requests list, the inbox and the badge: at `82f2ed6` those three built their Ticket without the review-model columns (`engineering_required`, the like-in-kind declaration), so they decided every request by the legacy role gate; they now spread `reviewModelFieldsFromRow` for every request, so for a review-model request — library or not — what they offer (approve vs. override, the engineer hand-off) and their "needs me" answer now follow the route's and the page's. That is the direction the route has always enforced; it is pinned in `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("second fix pass (review minor 4)": for a declared row and an `engineering_required` true row with no library, the list / inbox / badge engine answers and `isActionRequired` equal the route's over every status × role × identity, and the engine answers differ from the pre-DF-P19 mappers'). (b) "One saved through the policy route since is confirmed by that save" now holds for an Admin's save only: a new library- / class-scoped rule saved by a DocCtrl controller is stored unconfirmed and only adds until an Admin confirms it (`carryTicketRuleConfirmation(…, isAdmin)`), so removing a stored unconfirmed narrowing in one save and re-adding it in the next confirms nothing (`lib/__tests__/sweepRoundE_policyServer.test.ts`, both sequences).*

*Corrected at the DF-P19 third fix pass (2026-10-22, review majors 1–2 and minor 4; DEC-29).* (a) **Acceptance 3 and ruling (2) were too wide as built**: the request's library (and classes) also reached capabilities OUTSIDE `ticket.*` — a routing slot filled or waived by `transmittal.issue`, `holds.*` or any other capability (`lib/ticketRoster.ts` `resolveFill`, through `openRoster` in the workflow route) — where a library-scoped rule stored for the DOCUMENT side (valid since DEC-13 stage 2) then applied in full, never inventoried (`20261263` counts `ticket.*` only) and never held for confirmation (`ruleInForce` reads `ticket.*` rules only): a DocCtrl who filled a "Doc control release" slot yesterday could be dropped, or the submission refused `routing_unfillable`. Fixed: `lib/capabilityPolicy.ts` `requestResourceFor(cap, resource)` gives a non-`ticket.*` capability only the request's type and unit (what it presented at `82f2ed6`), and `resolveFill` uses it for both the fill and `waivable_by`; pinned in `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("third fix pass (review major 1)": the reviewer's `transmittal.issue` fixture through `openRoster` opens the same occupants and overriders as the pre-DF-P19 resource; a `ticket.*` fill still reads the library). So acceptance 3 holds as written for the `ticket.*` capabilities — the request's own authority — and a library rule on any other capability decides documents only, as before. (b) An IN-FORCE library- / class-scoped rule is now an Admin's to change or remove (the policy route refuses a non-Admin's save that drops one, 403 — `inForceTicketRulesDropped`), so a confirmed narrowing never lapses through a DocCtrl's edit. *(Corrected at the DF-P19 fourth fix pass, review major 1, DEC-29: as first built this held for an edit or removal only — a non-Admin's save that put another rule AHEAD of the confirmed one cancelled it with nothing dropped; the route and the editor now also refuse that, `inForceTicketRulesShadowed` — see `TIER-4`.)* (c) **Ruling (3) holds for the workflow route and the request page only**; the list / inbox / badge change in (a) of the second-fix-pass note above is put to the integrator for an explicit ruling (99-fix-sequencing, "Hand-offs from DF-P19"). *Ruled at the DF-P19 merge (2026-10-22, DEC-90): ACCEPTED — the list, the inbox and the badge offer exactly the actions the route allows on each request (parity with the route; the server's answer is authoritative).*

---

<a id="gap-106"></a>
## GAP-106 · SLA escalation that actually fires

**Verdict: BUILD** · Effort: **M** · Depends on: `LEAK-1`

### Scope

**In:** a server-side scan that notices a ticket sitting past a threshold in a
wait state and tells the party that owns it, escalating if it stays.

**Out:** auto-advancing the ticket. Escalation notifies; it does not decide.

### Design

The data model already exists — `target_completion_at` is set at creation with
per-request-type defaults (`lib/notifications.ts:237-243`), and `isPastDue` /
`isNearingDue` are written and tested. **Nothing reads them server-side.** A
repo-wide search finds no consumer outside the UI and the test file.

The maintenance cron already runs six comparable scans — stale checkouts,
review nudges, effective dates, acknowledgments, retention. This is a seventh, in
an established pattern.

Escalate to the **queue owner**, not the watcher list — which requires `LEAK-1`
fixed first, since `resolveTicketRecipients` is currently never consulted after
creation.

### Do not

- **Do not escalate to `[requesterId, assignedDrafterId]`.** That is the current
  fan-out and it is precisely who does not need telling — they already know.
- **Do not auto-close or auto-advance on timeout.** A stalled review is
  information, not a decision.
- **Do not use `notifyMany`.** It is in-app only. Use `emit`, so escalations
  reach email — the same asymmetry `LIFE-7` found on the PSM alert.

### Acceptance

1. A ticket past due in a wait state produces a notification to whoever owns that
   state.
2. Continued inaction escalates above them.
3. Escalations reach email, not only the in-app bell.
4. A collision ticket — which today has no due date at all (`LIFE-9`) — gets one.

**Related findings:** `FRIC-1`, `LEAK-1`, `LEAK-2`, `LIFE-9`.

*Landed 2026-10-13 (drafting-flow Round G, DF-P3): acceptance 1 and 3 — `lib/ticketSla.ts` + step 5b of the maintenance cron warn the owner of the current status at 75 % of the window and escalate a breach to them, the assignment queue and the requester, once each, through `emit()` (bell + email). Acceptance 2 holds in that form (the breach reaches the queue that can reassign). Acceptance 4 (a collision ticket gets a due date) → DF-P2's create route. The clock starts at the first paste of `20261195`, which records the backlog already past its target without a notice each (fix pass 2). See [`DEC-103`](../DECISIONS.md#dec-103), `EDGE-7`, `ROUTE-9`.*
*Amended 2026-10-13 (DF-P3 fix pass 3): the workflow route no longer retires the clock's notices on a transition that leaves the request open (the bell's client-side reconcile still does on a status change — DF-P9, on `EDGE-7`), and a client-created ticket is born with no SLA stamp (`ticket_insert_integrity`, `20261195` §2b), so no insert keeps a request off the clock. See `EDGE-7`.*

*Assigned (2026-10-21, the integrator at the DF-P7 merge, DEC-31):* the remainder (the escalation tier above the queue owners, with FRIC-1) → drafting-flow **DF-P22 CONSENT AND ESCALATION FOLLOW-UPS**.

*Landed 2026-10-22 (drafting-flow Round G, DF-P22 CONSENT AND ESCALATION FOLLOW-UPS — DEC-90 ruling (1) for DF-P22): acceptance 2 "continued inaction escalates above them" — a workspace may name an escalation contact (a member, or everyone holding a role) and a period on Admin → Request forms (`org_configurations` key `sla_escalation`, changed ONLY by an Admin through `/api/admin/sla-escalation` with an audit row for every change — the queue owners it sits above cannot switch it off or retarget it; 20261264 refuses every client write of the key); a breach its queue owners have not cleared within the period tells the contact's people who may read the request (a Contractor-only member only within their read) once per breach per period through the existing `ticket_status` kind (bell + email, `emit()`; one notice per person per workspace per run — a digest when several are due, which no single request's transition retires (fix pass 2: the workflow route's supersede step asks `slaNoticeSurvivesTransition`; it leaves the bell when read)), every due breach reached (keyset reads past those already told; a fair share per workspace), claimed on `ticket_sla_escalations` (20261264) and recorded on a `TICKET_SLA_ESCALATED` audit row (`lib/ticketSla.ts` `runSlaEscalationScan`, step 5b; no new cron entry). Escalation only tells. No contact configured = exactly today's clock (pinned). Acceptance 2 ✓ as ruled — where a workspace names no contact there is no tier above the queue, by the ruling's default. See `FRIC-1` (RESOLVED), `DEC-44 (DF-P22-consent-escalation)`.*


*Built (2026-10-22, the integrator at the DF-P22 merge, DEC-29 / DEC-31) — every acceptance holds as written:* 1 and 3 (DF-P3, `lib/ticketSla.ts`, bell + email through `emit()`); 2 (DF-P22 — the configured escalation tier above the queue owners, as ruled); 4 — every request, a collision included, is created through the one create path (`app/api/tickets/create/route.ts:678-698`, DF-P2), which stamps `target_completion_at` from the form, else the workspace's `sla_defaults`, else the request type's default (`defaultSlaTargetDate`), so a collision ticket has a due date (`LIFE-9`). No owner remains.

---

<a id="gap-107"></a>
## GAP-107 · Leak accounting — non-standard outcomes

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `DEC-14`

### Scope

**In:** closing a ticket as withdrawn, duplicate, or handled out of band, with a
reason, reportable per queue.

**Out:** an approval workflow for the outcome. Recording it is the whole feature.

### Design

`CANCELED` already exists in the `TicketStatus` union and is documented to users
in `WorkflowDiagramModal` — and **no action produces it** (`WF-17`). `DEC-14`
already commits to implementing it. This gap extends that: the outcome carries a
reason from an org-configurable list, and the list includes *handled outside the
system*.

**This is the measurement instrument for the entire area.** Every other finding
here is about reducing friction so people stop bypassing the app. Without this,
whether the fixes worked is unknowable — a bypassed ticket is currently
indistinguishable from a completed one (`LEAK-9`).

Pairs naturally with `GAP-13` (the triage rejection taxonomy, in the
roles-and-permissions area): same shape, same config mechanism, opposite end of
the flow.

### Do not

- **Do not force-close as the recording mechanism.** `ticket.force_close` records
  no reason and is Admin-tier; the person who knows the work went out of band is
  usually the requester.
- **Do not make it a status per reason.** One terminal status, a reason field.

### Acceptance

1. A ticket can be closed as withdrawn, duplicate or handled out of band, with a
   reason from the org's list.
2. A queue's leak rate is a number someone can look at.
3. `CANCELED` is reachable (`DEC-14`).

**Related findings:** `LEAK-9`, `WF-17`.

*Landed 2026-10-13 (drafting-flow Round G, DF-P3): acceptance 2 and 3 — `tickets.outcome` (`20261195`, pending paste) and "How Requests Ended" on `/admin/analytics`. Acceptance 1 holds at the route; the request page's picker is DF-P9's (until then a cancel without a category records none — never a guessed `withdrawn` — so the leak rate counts only outcomes someone named). The list is the ratified five, in code and a CHECK; org-configurable later. See [`DEC-103`](../DECISIONS.md#dec-103), `LEAK-9`.*
*Amended 2026-10-13 (DF-P3 fix pass 3): acceptance 2 is an instrument, not yet a number — until DF-P9's picker ships, a UI cancel names no category, so wherever no cancel named one the block shows the leak rate as "—" ("not measured yet: N cancels named no category") rather than a 0 % made of closes; once some cancels carry a category the rate is shown with the uncategorized ones counted beside it. See `LEAK-9` done-when 2.*

*Assigned (2026-10-14, the integrator at the drafting-flow DF-P9 merge, DEC-31):* acceptance 1's org-configured reason list → drafting-flow **DF-P14** (with roles-and-permissions `GAP-13`); acceptances 2 and 3 landed (DF-P3, DF-P9's Cancel Request picker).

*Landed 2026-10-14 (drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS): acceptance 1's org-configured list, under the integrator's ruling (`DEC-90`: optional; none configured → the Cancel Request picker and the workflow route behave exactly as before, the categories; with a list → the picker offers the org's reasons grouped by category and the route accepts only a configured reason or a bare category — read fail-safe at the review fix pass: a bare category only where the workspace keeps no reason under it, the picker's own rule). The list lives in the request-form configuration (`org_configurations` key `'drafting'`, `outcomeReasons`: `{ id, label, category }`, `lib/ticketOutcomeReasons.ts`) — no schema change, the `tickets.outcome` CHECK keeps the five; it is edited on Admin → Request forms ("Reasons for ending a request", under the four ways a cancel can end a request) by the drafting-form editor set (`DEC-107` item 1, the same page gate and the same `20261209` write rule); the Cancel Request dialog (`app/(protected)/requests/[id]/page.tsx`) groups the reasons under their categories (a category with none offered bare) and sends `outcomeReason` beside `outcome`; `/api/tickets/workflow-action` refuses (400, nothing written) a reason that is not configured, not of the category sent, or sent without one, answers 503 when the list cannot be read, and records an accepted one as `metadata.outcome_reason` (the words as they read then), in the history line and in the audit row; review fix pass: with no reason named it also refuses (400 `outcome_reason_required`, nothing written) a bare category the workspace keeps reasons under, or a cancel naming no category while it keeps reasons — so the list binds every caller, not only the dialog (if the list cannot be read then, the request ends as before and its audit row says `outcomeReasonUnchecked`). Acceptance 1: ✓ except while the reason list cannot be read: the route then accepts a bare category, audited as outcomeReasonUnchecked — otherwise a request can be closed as withdrawn, duplicate or handled out of band with a reason from the org's list (the five categories when none is configured). *(Ruled by the integrator at the DF-P14 merge, 2026-10-20 (DEC-90): the exception is kept in the code — refusing a cancel because the configuration could not be read would regress a flow that works today — and the acceptance is worded to say it; ruling (2)'s server reading is ratified as built: the route accepts a configured reason of the category, or a bare category (only where the workspace keeps no reason under it); recording the accepted reason — the history line, the audit row's fields, the `metadata` merge on the compare-and-set write — is part of the reason validation. *Was:* "Acceptance 1 now holds as written". See roles-and-permissions `GAP-13`.)* Tests: `lib/__tests__/dfRoundG_P14_outcomeReasons.test.ts`, `dfRoundG_P14_outcomeReasonsEditor.test.ts`, `dfRoundG_P14_routeLabelsReasons.test.ts`. See roles-and-permissions `GAP-13`, [`DEC-103`](../DECISIONS.md#dec-103).*

---

<a id="gap-108"></a>

*Assigned by the integrator, 2026-10-13, at the DF-P3 merge (DEC-31):* the measured leak rate waits only on the cancel-category picker → drafting-flow **DF-P9 TICKET-PAGE** (`LEAK-9` done-whens 1–2); the instrument (`outcome`, `/admin/analytics`) landed with DF-P3 and `20261195`.

## GAP-108 · "Where is my request"

**Verdict: BUILD_NARROW** · Effort: **S**

### Scope

**In:** the ticket states, in plain language, what stage it is at, who it is
waiting on, and how long it has been there.

**Out:** a redesign of the ticket page. This is a band, above the fold, in the
pattern the page already uses twice.

### Design

**Almost all of the content already exists.** `attentionLabel`
(`lib/ticketAttention.ts:95-107` (re-pointed: roles-and-permissions Round E rewrote the file, `WF-24`)) has the plain-English phrase for every status
and is currently rendered only in the notification bell. The current holder is
derivable from `assignedDrafterId` / `assignedEngineerId` / `requesterId` and the
status. Elapsed time is `last_modified`.

The **rendering pattern also already exists and is good**: the
revision-requested banner (`app/(protected)/requests/[id]/page.tsx:1661`) — *"Revision
requested — here's what to fix"* — states the situation in plain language at the
top with the required action attached. Generalize that.

Fold in `UI-2` while there: give the workflow map a visible affordance instead of
hiding it behind a status pill, and put it on the request form too, so a
first-time requester can see the process before committing to it.

### Do not

- **Do not rename the status enum values.** They are database identifiers that
  ripple into the state machine, the archive and the shed. Fix the display layer
  (`UI-7`).
- **Do not write a third set of plain-English labels.** Two already exist
  (`attentionLabel` and `WorkflowDiagramModal`'s blurbs). Route one of them.

### Acceptance

1. A ticket states its stage in plain language, names who it is waiting on, and
   shows how long it has waited.
2. The requester can tell at a glance whether the ball is in their court.
3. The workflow map has a visible affordance and is reachable before a request is
   filed.
4. No user-facing surface shows a raw status identifier as the primary label.

**Related findings:** `UI-1`, `UI-2`, `UI-4`, `UI-7`.

*Landed 2026-10-14 (drafting-flow Round G, DF-P9 TICKET-PAGE): acceptance 1–3 — the ticket's waiting line states the stage in words, who it waits on by name and part, and for how long, with "Your turn" when the engine offers the viewer a live action (`UI-1`); "View Only" is explained (`UI-4`); the workflow map has a visible affordance on the ticket and opens from the queue and from the request form before anything is filed (`UI-2`). The labels are one list (`lib/ticketStatusLabels.ts`), which the map's stage names read too. **Acceptance 4 is NOT met:** the request surfaces read that list, but six sites outside DF-P9's files still show the raw status or keep a third label set — `app/(protected)/admin/analytics/page.tsx:516`, the workflow route's bell body (`app/api/tickets/workflow-action/route.ts:1407`), email (`:1455`, `:1458`) and refusal text (`:360`), the SLA clock's bell / email bodies (`lib/ticketSla.ts:192`, `:196`, `:197`), and `components/dashboard/widgets.tsx:283-296`. The remainder and its owners are recorded under `UI-7` (OPEN, Partial); each fix is a call to `ticketStatusLabel`, never a new list ("Do not write a third set"). *(List completed at the DF-P9 integrator fix pass, which also fixed three more request sites with the shared list — a document's impact panel, the archived-ticket viewer and the printed traveler — and the queue board's lane chips; see `UI-7`.)*

*Assigned (2026-10-14, the integrator at the drafting-flow DF-P9 merge, DEC-31):* acceptance 4 (no raw status identifier as a primary label anywhere) → drafting-flow **DF-P14** (the `UI-7` remaining sites); acceptances 1–3 landed with DF-P9.

*Landed 2026-10-14 (drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS): acceptance 4 — the six remaining sites read the one list (`ticketStatusLabel`): `/admin/analytics`'s member ticket-list chip, the workflow route's refusal text, bell body and email (text and HTML; `metadata.status` keeps the stored value, which the bell's reconcile machine-reads), the SLA clock's "Due soon" / "Overdue" bodies, and the dashboard's Drafting Requests widget (its own label set removed, its classes kept). No third label set remains. *(Corrected at the DF-P14 review fix pass 2: the first search's patterns missed three sites, now fixed the same way — the Inbox's request lists chip (`app/(protected)/inbox/page.tsx:546`), a request hit's badge in ⌘K and on `/search` (`lib/globalSearch.ts:136`), and the admin help prose in `components/permissions/RoleModelTree.tsx:54`. The re-derivation, with the patterns used, is in `UI-7`'s Resolution; it finds no other ticket status shown as a primary label.)* All four acceptances now hold. See `UI-7` (RESOLVED).*

---

<a id="gap-109"></a>
## GAP-109 · Engineering review without a stop

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-110`, `GAP-111`, **`GAP-113`**

> ### ⚠ Hard precondition: `GAP-113`
>
> A consent window may not advance a ticket unless the system can prove it asked
> (`DEC-38`). `notify()` is documented fire-and-forget and swallows its error
> (`lib/inAppNotifications.ts:74-97`), and the workflow route does not resolve
> recipients at all (`LEAK-1`) — so today a window would advance on silence that
> nobody was ever given the chance to break.
>
> **Build `GAP-113` first. This spec is not safe without it.**
>
> Note also that `GAP-110`/`GAP-111` now supply the lane this keys off — the
> requester's declaration and the assigner's flag — rather than `GAP-101`'s
> triage-set class.

> The objection driving this spec: *"I'm complaining even over the engineer
> review."* That is a fair complaint and the audit under-served it. `TIER-1`
> establishes the engineering gate is pointed the wrong way; this spec is about
> making it cost less even when it points the right way.

### Scope

**In:** three mechanisms that let an engineering requirement be satisfied without
an engineer stopping their day, applied by work class.

1. **Silence-is-consent windows** — the reviewer gets a bounded period to object;
   no objection advances the ticket.
2. **Standing pre-authorization** — an engineer pre-approves a *class* of work,
   and tickets in that class carry their authority without touching them.
3. **Exception-only review** — where a standard detail was used, there is nothing
   to review; review the deviation.

**Out (deliberately):** removing engineering review from new design in a
code-governed service. That one genuinely needs a signature, and `GAP-103`'s
roster is where it belongs.

**Out:** silence-is-consent on the highest class. See `Do not`.

### Design

**Silence-is-consent is the highest-leverage of the three**, because it inverts
who must act. Today an engineer must act to say *yes*. Under a consent window
they act only to say *no* — and the happy path, which is most paths, costs zero
touches.

The document side already has the shape: `lib/reviewControl.ts` has
timeout-driven alternate activation, so the concept of "a reviewer had their
window and did not use it" is already modelled and already tested. This extends
that from *escalate to an alternate* to *advance on no objection*, per class.

**Standing pre-authorization** is how plants already work — approved standard
details, pre-approved repair procedures. An engineer records "any like-in-kind
gasket replacement in Unit 200, standing until I revoke it", and matching tickets
carry that authority with an audit reference to the standing approval. Zero
touches, and the engineer's prior instruction *is* the approval — which is
exactly the intent behind *"if an engineer says to do it a certain way."*

The per-person grant mechanism with expiry already exists
(`lib/capabilityPolicy.ts:98-110`) and is the right storage shape; what it lacks
is the resource dimension (`DEC-13`, `GAP-1`) to say *which* work a standing
approval covers.

**Exception-only review** depends on knowing a standard detail was used, which
means the detail must be a linked artifact rather than a copied block. That is
the largest of the three and the most deferrable.

### Do not

- **Do not apply silence-is-consent to the highest work class.** A new tie-in in
  a hazardous service auto-advancing because an engineer was on leave is exactly
  the PSM failure this system exists to prevent. Classify first (`GAP-101`), then
  choose the mechanism per class — that is what the classification is *for*.
- **Do not make the consent window silent.** The reviewer must be told the clock
  started, told again before it expires, and the advance must be audited as
  *advanced on no objection*, naming who did not object. A consent window that
  nobody knew about is not consent.
- **Do not let a standing pre-authorization be open-ended.** It expires, it is
  revocable, and every ticket that used it names it.
- **Do not build this before `GAP-101`.** Applied without a class, a consent
  window is either useless (set long enough for the riskiest work) or dangerous
  (set short enough for the routine).

### Acceptance

1. A like-in-kind ticket whose reviewer does not respond within the configured
   window advances, with an audit entry naming the reviewer and the window.
2. The reviewer was notified at window start and before expiry.
3. An engineer can record a standing pre-authorization scoped to a work class and
   an area, with an expiry, and matching tickets cite it instead of waiting.
4. Revoking a standing approval stops future tickets citing it, and the ones that
   already did remain traceable.
5. The highest work class is **not** eligible for either mechanism, and a test
   pins that.

**Related findings:** `TIER-1`, `TIER-5`, `FRIC-1`, `FRIC-4`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P7 CONSENT): mechanism 1 only — the silence-is-consent window. A window exists ONLY on a routing slot explicitly configured `consent_window` (DF-P5's `routing_control`; DEC-90 ruling (1)): the seed and every unconfigured workspace keep today's blocking roster, and before `20261255` is pasted a configured consent slot is still a sign-off, said on the answer. The highest work class is the engineered lane (`engineeringGateRequired`, DF-P6 and the legacy seed): an engineered request never gets a window (its consent slot waits as a sign-off, the reason named on the roster's history line), and a consent slot filled by an engineering capability (`ticket.final_approve`, `ticket.eng_review`) is refused in the editor with a visible reason (`lib/routingControl.ts` `validateRoutingDraft`). One window per review, on the slot's own occupants frozen at open; 3 working days by default, warned at 2/3 (`window_days` / `warn_fraction` per slot, 1–30 days, 0.1–0.9); an occupant may object with a reason (`object_consent_window`), which stops the advance and leaves the slot waiting for a sign-off; on close the slot is recorded satisfied via `consent` (no signer, no signature — `ticket_review_slots` widened in `20261255`), and when it was the last sign-off the request issues through the same issue limb as a sign-off (status, revision label, stamped finals, issue-as-is); *corrected at the DF-P7 fix pass 2:* it is not fully route-parity — it now also tells the `PENDING_IFC` routed pool (`LEAK-1`) and clears the request's document intents at `FINAL_DRAFT`, as the route does, but the `PHYS-18` copy recall and the requester / drafter email are not run (DEC-44 (DF-P7-consent) item 12, owners in `99-fix-sequencing.md`). Files: `lib/consentWindow.ts`, `lib/consentWindowScan.ts`, `lib/workflow.ts`, `lib/ticketTransitions.ts`, `lib/ticketRoster.ts`, `app/api/tickets/workflow-action/route.ts`, `app/api/cron/maintenance/route.ts` (step 5c; no new cron entry), `components/requests/ConsentWindowCard.tsx`. Acceptance 1 ✓ for any request outside the engineered lane whose library routing configures a consent slot ("like-in-kind" is that lane under DF-P6) — audit row `TICKET_CONSENT_WINDOW_ADVANCE` first, naming each person asked and the window (`consentWindowScan.test.ts`). Acceptance 2 ✓ (`GAP-113`, below). Acceptance 3 and 4 ✗ — standing pre-authorization is not built (no resource dimension on grants, `DEC-13` / `GAP-1`). Acceptance 5 ✓ for the consent window (route test "NEVER on the highest work class", `consentWindow.test.ts` `planConsentWindow`, the editor refusal); vacuous for pre-authorization until it exists. Mechanism 3 (exception-only review) not built. Not built here: the `window_days` / `warn_fraction` inputs in `components/documents/RoutingControlSection.tsx` (DF-P5's file — the values are read when present; see the DF-P7 hand-offs in `99-fix-sequencing.md`). Fix pass (review): DEC-12 / DEC-37 hold whatever the table declares — the people asked are never the drafter nor a party the slot is independent of (`lib/consentWindow.ts` `consentRecipients`; `open_consent_window` refuses them), a slot left with nobody else is BLOCKED and escalated, and a close where nobody but the drafter was asked is held; an issuing close runs the route's source-revision check first (a moved or unreadable source holds it for a person) and requires the roster ledger to agree; `open_consent_window` and the cron read the service-written ledger, never metadata alone. Acceptance 1 is therefore met only outside the engineered lane — "engineering review without a stop" is delivered for non-engineered sign-offs; the engineered lane always waits (DEC-44 (DF-P7-consent) item 1, a departure for the integrator to confirm). Fix pass 2 (review): DEC-37 slot-to-slot independence holds for silence too — nobody who signed, or can still sign, a slot the consent slot must be independent of (or that must be independent of it) is asked (`consentConflictedPeople`; `open_consent_window` refuses them from the ledger), and a close with nobody independent told is held (`independence`); the close is also held while another open slot can be signed only by the drafter, so a silent close never leaves the producer floor refusing the drafter for good (`drafterOnlyOpenSlot`; both sign orders pinned); the `consent` ledger shape is accepted only on a `consent_window` slot. Fix pass 3 (review): *corrected —* the "issue-as-is" above is honoured only when the window's opening notice named the drafter's mark (`lib/consentWindow.ts` `issueAsIsNamedAtOpen`; the notice, its email, the history line and the reminder carry `ISSUE_AS_IS_NOTE`), and the engine does not offer the mark while a window runs; otherwise the close takes the `PENDING_IFC` hop and withdraws the mark, said (FRIC-5 — DEC-44 (DF-P7-consent) items 7 and 19). The close counts only people still active members (a recipient suspended or removed during the window is not counted; with nobody independent left it is held, `no_longer_member`, and the assignment queue told — item 20), re-checks the engineered lane with the requester's current roles, the current policy and engineering-first types (held, `engineered` — item 1), and a consent slot saved before DF-P7 (when the editor said it "waits like a sign-off") opens no window until a controller re-saves the table (`consent_confirmed`, stamped by `setRoutingControl` — item 18). A planned window `open_consent_window` refuses for good (22023 / 55000 / 23505) is blocked once, not retried (item 21). Tests: `consentWindow.test.ts`, `consentWindowScan.test.ts`, `dfRoundG_P7_consentRoute.test.ts` ("fix pass 3").*

*Assigned (2026-10-21, the integrator at the DF-P7 merge, DEC-31):* mechanisms 2 and 3 (standing pre-authorization, exception-only review) → drafting-flow **DF-P22 CONSENT AND ESCALATION FOLLOW-UPS**.

*Landed 2026-10-22 (drafting-flow Round G, DF-P22 CONSENT AND ESCALATION FOLLOW-UPS — DEC-90 ruling (2) for DF-P22; recorded in `DEC-44 (DF-P22-consent-escalation)`): mechanism 2, STANDING PRE-AUTHORIZATION. A named person records their OWN pre-consent on their profile (`components/requests/PreauthorizationPanel.tsx` → `/api/tickets/preauthorizations`), scoped by what a request already records — its library, its request type, its work class (at least one; every one named must match; never the engineered lane) — with a REQUIRED expiry of at most 365 days and an e-signature minted by `/api/signatures/sign` for the record's own id, intent "Acknowledged" (the like-in-kind declaration's), over exactly the statement the route composes (`lib/ticketPreauthorization.ts` `preauthorizationStatement`, checked word for word). They or an Admin (by the held collection) revoke it at any time — *corrected at the DF-P22 merge-time fix pass (the integrator's ruling, the industry norm for revoking a delegation; DEC-29):* a sign-off already completed under it while it was valid stands (its slot stays satisfied, and the request's history and audit row keep naming the record), and the revocation takes effect immediately for every use not yet made, including on reviews open right now that have not applied it (`PREAUTH_REVOCATION_SCOPE`, said on the panel and in the route's answer); it is in force only while its grantor is an ACTIVE member of the workspace, continuously since it was created — a record whose grantor's membership lapsed afterwards (suspended, removed, re-added) is never used again, reactivation included, and the panel and the Admin list show it as "not in force — grantor's membership lapsed" (merge-time fix pass — see below); it is never deleted (`ticket_preauthorizations`, 20261264: scoped / expiry CHECKs, a guard that accepts only the revocation, once; service-role writes only, audit row first — `TICKET_PREAUTHORIZATION_RECORDED` / `_REVOKED`). It acts only on a slot a document controller explicitly opted in (`lib/routingControl.ts` `accepts_preauthorization`, a checkbox in `components/documents/RoutingControlSection.tsx`; kept only on a blocking slot not filled by the requester alone, not by an engineering capability, not an assurance slot — DF-P20's opt-in wins; frozen on the roster slot as `acceptsPreauthorization`), never on an engineering slot, an assurance slot or an engineered request (the route's engineered-lane answer at submission, or a declaration that could not be checked), and only for a person who would otherwise sign that slot NOW (`lib/workflow.ts` `slotSignPlan` offers it to them as a primary or an active alternate — never as an override — with every DEC-37 leg applied; never the assigned drafter). It NEVER satisfies the last open "must sign off" slot: a pre-authorization never issues a request — a person's live act still completes the review through the route's unchanged issue path. **It is never the second person either** (fix pass 2 — the first build counted it as one, so the drafter's own live sign-off could complete a review no second person had looked at): the DEC-12 producer floor (`lib/workflow.ts` `rosterLacksIndependentSignOff`, and the consent window's `lib/consentWindow.ts` `consentFloorHolds`) does not count a slot it satisfied — a consent recorded before the work existed is not a check of this revision — and it is never applied where only the drafter could then act (`lib/ticketPreauthorization.ts` `preauthLeavesNoSecondPerson`), so the floor never deadlocks the review: the slot waits for its live sign-off instead. DEC-12 is not weakened. When a submission opens such a roster, the workflow route (one guarded call after the consent-window step — `lib/ticketPreauthorizationApply.ts` `applyStandingPreauthorizations`) writes the audit row FIRST (`TICKET_PREAUTHORIZATION_APPLIED`, the system actor, naming each record, its signature and scope), then a compare-and-set satisfying the slot (`via: "preauthorization"`, the record's signature, `preauthorizationId`) with a history line naming each record, then the roster ledger (`ticket_review_slots.satisfied_via` widened by exactly `'preauthorization'` in 20261264) and a bell row to the person whose record was used; a miss writes `_NOT_APPLIED` and the slot waits for its sign-off; any read that fails, or the table missing before the paste, applies nothing. Default off: with no opted-in slot nothing is read (pinned — zero queries). Acceptance 3 ✓ **only on reviews with two or more open "must sign off" slots** (narrowed at the DF-P22 fix pass, DEC-29): a person records it scoped to a work class and an area — the library — with an expiry, and a matching request's opted-in slot cites it instead of waiting on that person; a ticket ALWAYS waits on at least one live sign-off (the ruling's fail-safe reading), so on a routing table with a single blocking slot — the common shape — it never acts, and the editor now says so when the opt-in is set there (`components/documents/RoutingControlSection.tsx` `preauthNeverActsNote`). Nor does an engineering sign-off a review gains ever make room for it: the gate that adds that slot makes the request engineered, and nothing applies on engineered work (fix pass 2 corrected the editor note, which had offered that as the case where it could act). It also never applies where satisfying the slot by that person would leave another open sign-off with nobody able to sign it (DEC-37 independence looked ahead — `planPreauthorizations` / `preauthLeavesSlotStranded`; the next person's record is tried). Acceptance 4 ✓ (*corrected at the DF-P22 merge-time fix pass — the fix pass line said "effective for the next submission" and admitted a use "in the instant between" the re-read and the write, while this line and the panel said "effective immediately"; the records now say one thing, and the code does it:* a sign-off already completed under a record while it was valid stands — its slot stays satisfied, and the request's history line and audit row keep naming the record; the revocation takes effect immediately for every use not yet made, including on reviews open right now that have not applied it. No use can land after a revocation commits: the re-check and the write are ONE database call, `apply_ticket_preauthorizations` (20261264 §5, re-pasteable), which locks the grantors' membership rows and then the records FOR SHARE, re-checks `revoked_at`, the expiry and the grantor's continuous membership on the rows it holds, and only then compare-and-sets the request — a revocation that committed first is seen (`_NOT_APPLIED`, reason `not_in_force`, the request untouched), and one that comes while the call runs waits for it and then governs every later use. Pinned: "a record revoked between plan and write is not applied" (`dfRoundG_P22_preauth.test.ts`) and, on PostgreSQL 16 with two sessions, a revocation in flight waited for and then seen, and an application in flight that the revocation waits for (`rls/dfP22ConsentEscalation.test.ts`)). The application runs after the submission's response (`after()` — DEC-90 ruling (5)). Acceptance 5 ✓ for both mechanisms (engineered work, the engineering slot and assurance slots are never eligible, and the DEC-12 producer floor never counts a pre-authorization — fix pass 2, the A/B in `dfRoundG_P22_preauth.test.ts`). A record is read by its own grantor or an Admin (20261264's SELECT policy, the route's rule — fix pass 2; not every member, since its statement names a library a Contractor-only member may not read). Mechanism 3 (exception-only review) is NOT built — see the Partial below. Tests: `dfRoundG_P22_preauth.test.ts`, `dfRoundG_P22_preauthRoute.test.ts`, `dfRoundG_P22_preauthMigration.test.ts`, `dfRoundG_P22_panelsRender.test.ts`, `rls/dfP22ConsentEscalation.test.ts` (PostgreSQL 16).*

*Merge-time fix pass (2026-10-22, the integrator's rulings on the final review's two minors):* (1) revocation scope as in Acceptance 4 above; an earlier 20261264 pasted before this pass lacks the function, and then every application is refused (`PGRST202`), logged as `_NOT_APPLIED`, and the slot waits for its sign-off as today, until the file is re-pasted. (2) **Grantor membership.** A pre-authorization is in force only while its grantor is an ACTIVE member, continuously since it was created (`lib/ticketPreauthorization.ts` `preauthGrantorMembership` / `readGrantorMemberships`, re-checked in the same transaction by `apply_ticket_preauthorizations`). `org_members` keeps a `status` and the membership row's `created_at`, and no time of a status change, so continuity is judged from: `status = 'active'` now; the membership row's `created_at` no later than the record's (a member removed and re-added has a new row: lapsed); and no membership status audit row of theirs (`MEMBER_SUSPENDED`, `MEMBER_REMOVED`, `MEMBER_RESTORED` — written by `revoke_member` in the same transaction as the status change — or `MEMBER_REACTIVATED`, the add-member route's) at or after the record's creation. That is the ruling's first option: a record whose grantor's membership row changed status since its `created_at`, as recorded, is not in force; anything unreadable (no `created_at`, an unparseable time, a membership read that fails or a history longer than one read) is not in force either. **What it does not see:** a status flipped straight on `org_members` with no audit row (an Admin or Manager writing the table through the API rather than `/admin/users`, or SQL) and then flipped back — no app path does this. A suspended grantor cannot sign in to use the route; their revoke attempt gets a 403 that says so (`not_active_member`), and an Admin can revoke any record. Tests: `dfRoundG_P22_preauth.test.ts` (suspended → not applied; reactivated → still not applied; continuously active → applied, unchanged), `dfRoundG_P22_preauthRoute.test.ts`, `dfRoundG_P22_panelsRender.test.ts`, and `rls/dfP22ConsentEscalation.test.ts` (the real `revoke_member` suspend and restore; removed and re-added).*

**Partial (2026-10-22, drafting-flow Round G).** DF-P22 — mechanism 3, EXCEPTION-ONLY REVIEW, is not built (DEC-90 ruling (3) for DF-P22 allows this when it cannot be built fail-safe within scope). Why: the exceptions the system already records are not on record when a review slot opens, so a slot "satisfied by a recorded system act" at that moment would be satisfied before the facts that should have stopped it exist — (a) the source-drift acknowledgement (`HAND-7`, DF-P6/DF-P18) is computed only at an issuing approval and is recorded by the approving person, i.e. after the slot would already have been satisfied; (b) an override (the management override, "Approve with Minor Correction") is recorded by the person who takes it, again after the review opened; (c) the like-in-kind declaration is on every declared request, so it is the normal case, not an exception. A fail-safe build therefore needs a re-open limb: when an exception is recorded later, the slot satisfied by the rule must be re-opened for its reviewer before anything issues — a change to the route's issuing path (`app/api/tickets/workflow-action/route.ts`, DF-P23's next) and a roster-ledger "re-opened" event (20261242's `ticket_review_slot_events.event` CHECK, a migration). The gap register's own note stands as well: an exception keyed to "a standard detail was used" needs the detail as a linked artifact. **Owner:** the integrator assigns (DEC-31) — proposed the next drafting-flow package holding the workflow route's issuing path after DF-P23, with a migration slot for the ledger event; the opt-in would ride `lib/routingControl.ts` like `accepts_preauthorization`.


*Assigned (2026-10-22, the integrator at the DF-P22 merge, DEC-31):* mechanism 3 (exception-only review) → drafting-flow **DF-P25 EXCEPTION-ONLY REVIEW AND PRE-AUTHORIZATION FOLLOW-UPS** (new; after DF-P23), with the pre-authorization follow-ups (a membership status change with no audit row; the Admin list's history window); the grantor's redundant "review opened" alert → drafting-flow **DF-P23**.

*Landed 2026-10-22 (drafting-flow Round G, DF-P25 — mechanism 2's follow-ups, DEC-90 ruling (2) for DF-P25; calls in `DEC-44 (DF-P25-exception-review)`):* (a) **membership continuity rests on a stored fact.** Reproduced on `cbd5772`: `org_members` kept no time of a status change, so a status flipped straight on the table and back with no audit row left a record in force (`lib/ticketPreauthorization.ts` `preauthGrantorMembership` read only `status`, `created_at` and the `MEMBER_*` audit rows; 20261264's clause (c) the same). Now `org_members.status_changed_at` (20261267 §1) is stamped by `trg_org_members_status_changed` (BEFORE INSERT OR UPDATE, SECURITY INVOKER, search_path pinned): NULL on insert, the time on every status change whoever writes it (the app, `revoke_member`, the API, SQL), the stored value on every other write — a writer's own value is never kept; existing rows stay NULL ("not changed since the column existed"). `preauthGrantorMembership` (`:227`) lapses a record whose grantor has a stamp at or after its creation; `readGrantorMemberships` (`:288`) reads the column and, before the paste (42703 / PGRST204 — `isMissingStatusChangedAt`, `:264`), today's read; the audit rows stay the second source. `apply_ticket_preauthorizations` is re-created from 20261264's body with that one condition (lineDiff-pinned). (b) the escalation claim's `recipients` is documented as the audience asked (20261267 §3 COMMENT), and a refused audit row's run line names who was told (`lib/ticketSla.ts:992`). (c) a notice that landed no bell row is said (`lib/ticketSla.ts:963`), as `runTicketSlaScan` says it. (d) the Admin list's history window: only records still IN FORCE are judged (a revoked or expired record is not in force whatever its grantor did), the window starts at the oldest of those per slice, and a slice holding more history than one read is read again grantor by grantor (each one's latest change) — so no volume of history refuses the list; (review fix pass 4) the Admin list (`app/api/tickets/preauthorizations/route.ts` GET) gives a record that was not judged — revoked or expired — NO `grantorMembership` at all, never the old default "unproven" (which would say its grantor's membership was checked and could not be confirmed; pinned in `dfRoundG_P22_preauthRoute.test.ts`, DF-P25 block). Tests: `lib/__tests__/dfRoundG_P25_membership.test.ts`, `lib/__tests__/dfRoundG_P22_escalation.test.ts` (DF-P25 block), `lib/__tests__/dfRoundG_P25_migration.test.ts`, and on PostgreSQL 16 `lib/__tests__/rls/dfP25ExceptionReviewFollowups.test.ts` (a grantor flipped and flipped back with no audit row: `not_in_force`; the stamp by the service role, `revoke_member` in an Admin's session and SQL; a forged stamp dropped on insert and update).

**Partial (2026-10-22, drafting-flow Round G).** DF-P25 — mechanism 3, EXCEPTION-ONLY REVIEW, is NOT built: DEC-90 ruling (1) for DF-P25 — "if either limb cannot be made fail-safe within scope, do not ship a half: record mechanism 3 Partial with an owner and say why". Re-verified on `cbd5772`: nothing in `lib/routingControl.ts`, `lib/ticketRoster.ts`, `lib/workflow.ts` or the workflow route satisfies a slot "by rule" or re-opens a satisfied slot (`ticket_review_slot_events.event` is still `('opened','told','satisfied','voided')` — 20261242:103; `ticket_review_slots.satisfied_via` accepts `primary / alternate / override / consent / preauthorization` — 20261264). **Why the re-open limb cannot be made fail-safe within this package's scope:** (1) the slot must re-open before ANYTHING issues, and three paths issue: the workflow route's completing `sign_slot` (`rosterCompletion`) and its `ISSUING_APPROVALS`, and the consent window's silent close (`lib/consentWindowScan.ts` `closeWindow`, which issues through the same issue limb when its slot is the last sign-off — a separate service-role path outside this package's files). A waiver recorded on `ticket_examination_scopes`, or a declaration check that fails, between the rule-satisfaction and a consent close would issue the request with the exception-only slot nobody looked at — the half the ruling forbids. (2) Each path would have to read every recorded exception kind the ruling names — the source-drift acknowledgement (carried by the issuing act itself, `route.ts` the `sourceDrift` block), an override sign-off on the roster (`via: "override"`), an examination-scope waiver (`issueScopeGate`), a declaration check failure (`declarationUnverified`) — and re-open in the same compare-and-set as the act, with a `reopened` ledger event (the event CHECK and the `satisfied_via` / shape CHECKs re-created — a signer-less "rule" satisfaction). (3) The DEC-12 producer floor must never count a rule-satisfied slot, in all three of its homes (`lib/workflow.ts` `rosterLacksIndependentSignOff`, `lib/consentWindow.ts` `consentFloorHolds`, `lib/ticketPreauthorization.ts` `preauthLeavesNoSecondPerson`), and the pre-authorization look-ahead, the waiting line (`holdersFor`) and the roster panel must read it. That is past the ~5-file split rule for one fix and reaches files other packages hold (`lib/consentWindowScan.ts`, `lib/workflow.ts`, `components/requests/TicketRosterPanel.tsx`'s sign-off path). **Owner (DEC-31):** the remainder is opened as its own record, **`GAP-115`**, owned by drafting-flow **DF-P26 ISSUING-PATH STOPS** (review fix pass 5 — the earlier text named only "the integrator — proposed a new package", which is no owner under DEC-31): the next free drafting-flow package, holding the workflow route's issuing path, `lib/consentWindowScan.ts` and `lib/workflow.ts` together, with one migration slot (the three CHECK re-creations); the integrator renumbers it on a collision and writes its plan entry at merge. Built in two commits — (i) the opt-in (`exception_only` on a non-engineering, non-assurance blocking slot, never the last open blocking slot, never the engineered lane, never counted by the DEC-12 floor) satisfied at open by a recorded system act naming the rule when no exception is on record; (ii) the re-open limb on all three issuing paths — and merged only together. Default off; an unconfigured workspace byte-identical (the A/B sweep pattern of `dfRoundG_P24_issueGateRoute.test.ts`).

*Landed 2026-10-22 (drafting-flow Round G, DF-P26 ISSUING-PATH STOPS — DEC-90 ruling (1) for DF-P26; calls in `DEC-44 (DF-P26-issuing-path-stops)` items 1–6):* mechanism 3, EXCEPTION-ONLY REVIEW, is BUILT — both limbs, one merge — as `GAP-115` (RESOLVED with one remainder (the base-route A/B pin; owner: the drafting-flow integrator, see the 99-fix-sequencing DF-P26 row); the Resolution there). The DF-P25 Partial above is superseded: the opt-in is satisfied at open by a recorded system act naming the rule, and re-opened before anything issues on every issuing path (the route's completing sign-off; its issuing approvals are refused on such a roster; the consent close), the DEC-12 floor excluding it in all three homes. Migration `20261268` (pending paste; until it is pasted the rule applies nothing).

---

<a id="gap-110"></a>
## GAP-110 · The like-in-kind declaration

**Verdict: BUILD** · Effort: **S** · Depends on: — · Decisions: `DEC-33`, `DEC-34`

### The requirement it implements

Verbatim from the system's owner, and the most important sentence in this audit:

> *"Unapproved construction packages can not be pushed into the field. One of our
> policies is only use engineered packages unless the requester has declared it
> on request this is like-in-kind — meaning it is inferred this was already
> engineered at some point, we are putting back exactly the same, we just need to
> replace something."*

### Scope

**In:** one optional question on every intake path, a typed statement when
answered, three immutable columns, and one boolean that the state machine reads.

**Out:** any change to who reviews what. That is `GAP-101` + `GAP-111` consuming
this. Build the declaration first; it is independently correct and independently
useful even if nothing else ships.

### The half that already exists — and the door it is missing from

`lib/checkinOutcomes.ts` already models this policy correctly. Read its header
before writing a line:

```
//   * every claim-creating branch requires a TYPED note (no canned text,
//     no get-out-of-jail-free cards — same bar as approve_minor_correction),
//   * a real change to a DRAWING-class document demands an MOC position
//     (OSHA 1910.119(l)) …
//   * minor corrections are replacement-in-kind: no MOC, mirroring the
//     existing Minor/Correction review-gate exemption.
```

It is pure, unit-tested, derives an MOC requirement from the declared doc class,
and requires a typed note for every claim. **The vocabulary and the standard both
already exist in this repository.**

They exist on the **check-in door only.**

There are **three** ways a ticket gets created. Enumerated by searching for
`.insert` against the `tickets` table across `app/`, `lib/` and `components/`,
excluding tests — several other files call `.from("tickets")` and are reads:

| Door | File | Declaration asked for? |
|---|---|---|
| Intake form | `app/(protected)/requests/new/page.tsx:328` | **No** |
| Check-in outcome | `components/documents/CheckInPanel.tsx:236` | Yes — MOC position + typed note |
| Transition-in collision scan | `lib/transitionIn.ts:304` | **No** |

Two of three doors reach the same outcome — a revised controlled drawing — with
no declaration at all, and one of them is the **main** door. **That is the leak
this gap closes**, and it is a policy leak rather than a code defect, which is
why no existing finding names it.

There is a fourth writer worth knowing about and **not** treating as a door:
`app/api/admin/ticket-shed/restore/route.ts:191` UPDATEs archived stubs back to
life. It is guarded — `.not("archived_at", "is", null)`, described in its own
comment as *"defence-in-depth against a TOCTOU flip"* — and it restores a
declaration that already existed rather than creating one. **Leave it alone.**

### The half that is worse than missing

The one door that *does* ask writes the answer to `metadata`:

```ts
// components/documents/CheckInPanel.tsx:263-266
...(card.moc === "required" ? { moc: { status: mocStatus, number: … } } : {}),
...(card.ticketKind === "minor" ? { minor_correction: true } : {}),
...(undocumented ? { undocumented_change: true } : {}),
```

A repo-wide search across `app/`, `lib/`, `components/` and `types/` finds **no
reader of `metadata.moc`, `metadata.minor_correction` or
`metadata.undocumented_change` for any authority decision.** `getActions` never
reads `ticket.metadata` at all.

So today: a person can declare at check-in that they are making an **undocumented
change to a drawing with no MOC**, and the resulting ticket flows through the
identical path as any other. The declaration is captured and inert.

That is arguably the most defensible thing in this audit to fix first. It is
already being asked. Nothing listens.

### Design

**Storage — columns, never JSON:**

| Column | Set by | Mutable |
|---|---|---|
| `like_in_kind_statement` | requester, at creation | **never** |
| `like_in_kind_declared_by` | server, from the session | never |
| `like_in_kind_declared_at` | server | never |
| `engineering_required` | server: `true` unless a statement exists | **true-ward only** |

The typed statement carries a minimum length. No canned options, no dropdown. The
same bar `checkinOutcomes` sets: *no get-out-of-jail-free cards.*

**Every door asks the same question.** One shared component, one shared
server-side validator. A door that cannot show UI (the external portal) defaults
to no declaration, which is the safe lane — and says so in the portal's
confirmation text.

**Backfill:** existing tickets get `engineering_required = false` — not `true`.
Retroactively blocking every open ticket in production on a gate that did not
exist when they were filed would strand live work, which is how a safety feature
teaches people to bypass the app. New tickets get the new default from day one,
and the report in `GAP-101` acceptance #5 is what tells you the lane is being
used honestly.

### Do not

- **Do not make it required.** Its optionality is what makes it safe: an
  unanswered question yields the rigorous lane. A required field the requester
  cannot answer is `UI-5` again.
- **Do not offer canned text or a picker.** A checkbox is clicked without
  reading. A sentence is a statement someone can be held to, and it is the
  artifact a regulator asks for.
- **Do not let it be edited, by anyone, including an admin.** A wrong declaration
  is corrected by the assigner flagging engineering (`GAP-111`) — recorded as an
  override on top, never as a rewrite underneath.
- **Do not store it in `metadata`.** See above. That is the exact mistake already
  present.
- **Do not skip the four silent doors.** A policy enforced at one of five
  entrances is not enforced.

### Acceptance

1. All three creation paths either capture a declaration or record its absence,
   and a test enumerates all three so a fourth door cannot be added silently.
2. A statement shorter than the minimum is rejected server-side, not only in the
   form.
3. No code path anywhere sets `engineering_required` from `true` to `false`. A
   test pins this.
4. The declaration renders attributed on the ticket, on the issued deliverable,
   and in ticket history.
5. `metadata.moc` / `metadata.minor_correction` / `metadata.undocumented_change`
   are either promoted to columns that something reads, or explicitly documented
   as informational. **Not left as-is.**

**Related findings:** `TIER-1`, `TIER-2`, `LEAK-3`, `UI-5`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL): the declaration is one optional sentence on the request form (no checkbox, no picker, no canned text), signed through the existing e-signature ceremony (intent `Acknowledged`, statement "Like-in-kind declaration: <the sentence>", resource the ticket id it will be filed under) and checked by `/api/tickets/create` before a number is spent (the requester's, this workspace, this id, this statement, within 30 minutes, the id not already filed — else 400 / 409 `declaration_used`; and, since the review fix pass, the id carries no other history — no other person's signature and no audit row but this declaration's capture, else 409 `declaration_key_used`); stored in four columns (`20261250`), not metadata, immutable for every caller. Acceptance 1 ✓ (every ticket INSERT in the app is the create route's — the three doors post there; enumerated by `lib/__tests__/reviewModel.test.ts` "GAP-110 acceptance 1 …", so a fourth door fails it); 2 ✓ (the contract and a CHECK, 20–2000 characters); 3 ✓ (no transition writes `false`, every action × every status pinned; the guard refuses true → false for every caller); 4 ✓ in part (the request page, its history and the audit trail; not the issued deliverable — see `GAP-101`); 5 ✓ documented: `metadata.minor_correction` / `undocumented_change` are informational records of the check-in (nothing reads them for authority; counted by the inventory, row 43); `metadata.moc` is the hand-back's (LIFE-5). 'Do not' kept.*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* a declaration restored from a backup (no `e_signatures` row is ever restored) → admin-and-org **P18 RESTORE REVIEW-MODEL ROWS**.

**Resolution (2026-10-21, admin-and-org Round G P18).** P18 RESTORE REVIEW-MODEL ROWS — the restore remainder of the declaration (`DEC-34`; DEC-90 ruling (2) as given in the brief, with (3)–(5)). The page remainder — the restore page drawing each request's words, and its headline not counting these as pointers — was owned by admin-and-org **`BKP-17`**, resolved by P18's final fix pass (the integrator put the panel in its scope, DEC-90). *(Corrected by the P18 second fix pass, DEC-29: this block first read "Resolution", with the notes limb ✓ although it was not done on the page; it then read "Partial" until the final fix pass drew the lines on the page.)* Reproduced on the base (`b96299d`): `lib/dataRestore.ts` `applyRestoreChunk` wrote a backup's `like_in_kind_*` and `engineering_required = false` as they were (the service role passes the insert guard), while `e_signatures` is never restored (`IMMUTABLE_TABLES`) — so the stored row said "declared, not required" (`engineering_required = false` beside a declaration whose signature is not on record). The workflow route (fix pass minor 11), the request page (`ticketAsDeclarationChecked` — `app/(protected)/requests/[id]/page.tsx:1551`, `:2315`, and the roster panel it mounts, `:2849`) and `components/requests/DeclarationCard.tsx` (`declarationSignatureStands`, `:100`) already treated it as undeclared; every other reader of the raw columns — the requests list, the inbox, exports — read it as declared and not required. P18 makes the stored row agree. *(Corrected by the P18 fix pass, DEC-29: this sentence first said the request page's seed and the roster read it as declared, and that only the workflow route treated it as undeclared.)*

Landed (no migration), in `lib/dataRestore.ts`:
- **`restoreReviewModelFacts`** (`:1982`): for the `tickets` rows that carry a declaration (any of the four columns set — `carriesDeclaration`), one read of `e_signatures` by id (≤200 a call; a malformed id is not read) and the workflow route's own test, `lib/reviewModel.ts` `declarationSignatureStands` (this workspace, `resource_type` ticket, this request's id, signed by the declarer). Only when the target has `20261250`'s columns (the same read-once check as `TIER-1`'s block); a signature read that fails stops the chunk before any write.
- **A declaration whose signature does not stand** is written with its four `like_in_kind_*` columns cleared together (the all-or-none CHECK) and `engineering_required = true` (`DECLARATION_NOT_RESTORED_VALUES`) — `review_model_filed` as the backup carries it (or `false` by `TIER-1`'s rule). It rides the pre-write rules as a cleared pointer does (`sets`, `:2309`; located with them, `:2335`), so its note is emitted only for a row the write takes: one per request in the chunk's `cleared` notes, code `DECLARATION_NOT_RESTORED` (`declarationNotRestoredMessage`, `:1939`: "like_in_kind_* cleared on request <number>: its requester declared the work like-in-kind and signed that declaration electronically, but the signature is not on record in this workspace (a backup carries no signatures), so the request was restored as undeclared — it now needs an engineer's sign-off (or a recorded management override) before it issues …", with the statement quoted; *P18 fix pass:* when the request is also renumbered on restore (EDGE-5 — the renumbering runs after the note is built), the note names the number it is restored under: "like_in_kind_* cleared on request <new number> (restored under this fresh number; "<backup number>", the number it carried in the backup, names another request in this workspace): …" — `declarationNoteRenumbered`, `:1952`, applied at `:2617`; it first named the backup number, which in the workspace is the other request's), `restoreRefusalLabel` names the code (`:1413`). The `RESTORE_CHUNK` audit row carries each note. *P18 final fix pass:* the note carries the number it names as a structured field, `ticketNumber` (additive; rewritten with the note on a renumbering), and the restore page lists each request from it in its own block, in the note's words, counting these apart in the headline ("N declaration(s) not restored (those requests now need an engineer's sign-off)") — admin-and-org `BKP-17`. A request whose declaration is cleared is written REQUIRED, so `TIER-1`'s filed-before line no longer counts it (the integrator's ruling, DEC-90); and a request already here that ruling (2) flags no longer changes how EDGE-5 names the holder of a number another backup request carries (`TIER-1`'s block, ruling (5)).
- **A signature that stands** (the request restored into the workspace that still holds it) keeps the declaration exactly as it is. **A request with no declaration** is unchanged. **A request already here** is never touched (ON CONFLICT DO NOTHING — `ticket_update_guard`'s every-caller limb never fires; counted existing, no note).

Tests: `lib/__tests__/aoRoundGP18RestoreReviewModel.test.ts` — the declaration cleared, all four columns, `engineering_required` true, `review_model_filed` kept, one note in a plant admin's words (and in the `RESTORE_CHUNK` row), a plain request in the same chunk byte-identical; every reader then agrees (`reviewModelFieldsFromRow` → `isDeclaredLikeInKind` false, `engineeringGateRequired` true for a Manager requester); a signature of the same id held by ANOTHER workspace, given for another request, signed by another person, or a malformed id → cleared; one on record here for this request by its declarer → kept as it is; a hand-made row with a declaration and no `review_model_filed` → filed before the model, undeclared and REQUIRED (the cleared declaration wins over the seed); an existing request (same id) with a declaration → no UPDATE, kept, counted existing, no note; a renumbered request (EDGE-5) carries both notes, the declaration's naming the fresh number and never "cleared on request <backup number>:" (pinned in the message and the `RESTORE_CHUNK` row; fix pass), and `declarationNoteRenumbered` leaves every other note as it is; a signature read error → 500, nothing written; without `20261250` no signature is read and the row goes out as the backup carries it (the database answers as it always has). Mutation-checked: without the `flagged` inclusion, the existing-request case reports a note for a row never written; without the renumber rewrite, the EDGE-5 case fails (fix pass).

**Done-when.** *(The brief's criteria for the restore remainder.)*
- ✓ A restored declaration with no `e_signatures` row standing in the target is cleared together (all four columns) and `engineering_required` is set true.
- ✓ Reported per request in the restore notes, in words a plant admin understands — the `cleared` notes and the `RESTORE_CHUNK` audit row carry one message per request, naming the number it is restored under; **and on the page** — each request listed by number in its own block in the note's words, counted apart from the pointers in the headline (`RestoreResultPanel.tsx` `DeclarationLines`; admin-and-org **`BKP-17`**, RESOLVED by the P18 final fix pass; pinned by rendered tests). *(Corrected by the P18 fix passes: first a plain ✓, then "✓ (notes / audit)" under a Resolution heading, then ◐ until the final fix pass.)*
- ✓ A ticket with no declaration is unchanged (pinned); every other table unchanged (pinned).
- ✓ Only when the target has the columns; a target without `20261250` restores as before (pinned).

**Scope / residual.** The page remainder (the headline counting these among "pointer(s) cleared", the table line showing the label, not each request's message) is resolved: admin-and-org **`BKP-17`**, RESOLVED by the P18 final fix pass. Acceptance 1–5 above are DF-P6's and unchanged.

---

<a id="gap-111"></a>
## GAP-111 · The assigner's flag becomes binding

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-110` · Decisions: `DEC-33`

### The requirement it implements

> *"Being that there is always a drafting manager that is assigning these, part
> of his responsibility can be to flag engineering — then it becomes required.
> Otherwise it's opportunistic and can close and be considered approved by the
> drafting manager."*

### This is 80% built. The missing 20% is one boolean.

The action already exists, at two statuses, with the right ergonomics:

```ts
// lib/workflow.ts:93-101 (NEW) and :146-153 (PENDING_ASSIGNMENT)
actions.push({
  label: 'Flag for Engineering Review',
  action: 'request_eng_review',
  requiresComment: true,
  requiresEngineerPick: true,
  description: 'Route to a specific engineer for scope review before assigning a drafter.'
});
```

It already persists a real record:

```ts
// lib/ticketTransitions.ts:179-189
case "request_eng_review":
  updates.status = "PENDING_ENG_TEAM";
  if (input.engineer) {
    updates.assigned_engineer_id = input.engineer.id;
    updates.engineer_review_requested_at = now;
    updates.engineer_review_reason = finalComment || null;
    …
```

And the flow's own author already intended exactly the model the owner described:

```ts
// lib/workflow.ts:46-50 — getInitialStatus
// Every new request lands in the assignment queue … Engineering review is
// an OPTIONAL branch the assigner triggers via "Flag for Engineering
// Review", never an automatic gate.
```

**What it does not do is bind the approval end.** `approve_team` sets status back
to `PENDING_ASSIGNMENT` and carries nothing forward
(`lib/ticketTransitions.ts:190-192`). At `PENDING_REVIEW` the only thing consulted
is:

```ts
// lib/workflow.ts:78
const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole);
```

**Consequence, confirmed by reading the state machine:** a drafting manager flags
a ticket for engineering, an engineer reviews the scope, and then — if the
requester happened to be a Manager, Admin or DocCtrl — the requester self-approves
straight to IFC with no engineering sign-off on the deliverable. The flag bought a
conversation and no gate.

### What the flag actually means

Stated by the owner in the clearest form yet:

> *"The drafting manager can be the gate and say: hey wait, this requires
> engineering — no deliverable without official approval. And it goes through the
> ringer to get official approvals from routed people."*

Three things in that sentence, and each one changes the build:

#### 1. The flag gates **delivery**, not drafting

*"No deliverable without official approval"* is a constraint on the **issue
point**, not on when work may start. That distinction is worth a whole wait
state:

| | Sequence | Waits |
|---|---|---|
| **Today** | flag → `PENDING_ENG_TEAM` → engineer reviews scope → back to `PENDING_ASSIGNMENT` → assign → draft → review | drafting waits on engineering |
| **What the owner described** | flag → **drafting starts now**, approval roster opens **in parallel** → deliverable cannot be **issued** until the roster is complete | only the issue point waits |

Drafting a package that later needs a change is cheap — that is what revisions
are for. **Making a drafter sit idle while an engineer reads a scope note is
not.** Gating the issue point instead of the start point gets the identical
safety outcome and gives the drafting time back.

So `engineering_required` must gate the **issue transitions** —
`approve_draft_ifc`, `engineer_approve_final`, `submit_final` and
`approve_minor_correction` — not merely insert a status early on. Today
`PENDING_ENG_TEAM` sits *before* assignment, which is the expensive placement.

⚠ **`approve_minor_correction` is the one that matters most here.** It routes
straight to `PENDING_IFC` (`lib/ticketTransitions.ts:230-235`) and is offered to
every requester at `PENDING_REVIEW` — including the branch the engineer gate
blocks. A delivery gate that does not cover it is not a gate.

#### 2. "Routed people" is plural, and derived — not picked

The flag currently carries `requiresEngineerPick: true`: the assigner must
personally choose **one** engineer from a list. Two problems.

- It is `FRIC-4` — making someone hand-pick a reviewer is a routing question that
  demands more domain knowledge than the review itself.
- It caps official approval at one person, when *"routed people"* plainly means
  whoever that library and that class of work require — which may be several.

Under `GAP-112` the assigner **flags, and the router resolves who**. The assigner
does not need to know, and on a parallel roster (`GAP-103`) N approvers still cost
**one** wait state.

Keep `requiresEngineerPick` as the fallback for an org with no routing configured.
Do not keep it as the only path.

#### 3. The flag must be available later than assignment

A drafting manager who realises at review time that something needs engineering
must be able to say so. Today the action exists only at `NEW` and
`PENDING_ASSIGNMENT` (`lib/workflow.ts:93-101`, `:146-153`).

Offer it wherever `ticket.manage` / `ticket.assign` holds and the ticket has not
yet issued. Because the gate is now on delivery rather than on starting, a late
flag does not restart anything — it just adds the requirement the deliverable
must satisfy before it can be issued.

### Scope

**In:**

1. `request_eng_review` sets `engineering_required = true`, permanently.
2. `engineering_required` gates **every issue transition**, including
   `approve_minor_correction`.
3. Drafting is **not** blocked by the flag; the approval roster runs alongside it.
4. The flag is available at any pre-issue status to whoever can assign.
5. Where a router exists, the flag resolves approvers through it rather than
   requiring a hand-pick.

**Out:** removing `PENDING_ENG_TEAM`. A pre-drafting scope review is genuinely
useful when the assigner wants one *before* spending drafting hours — it just
must not be the only way to require engineering, and must not be mandatory.

### Why a blocking signature is correct here

`99-fix-sequencing.md` says a wait on a specific person is a defect *until its
consequence justifies it*. **This is the case where it does.** An unapproved
construction package reaching the field is the consequence the whole system
exists to prevent, and there is no clock-based substitute for a signature that
says a qualified person accepted the design.

That is precisely why the flag matters: it makes blocking signatures
**countable**. A facility should be able to say *"we had N official approvals last
month, all of them flagged, and here is who flagged each one and why."* If that
number is not small and not explainable, the problem is the flagging policy — not
the flow.

**Everything not flagged advances without a person in the way.** That is the
trade: a small, deliberate, named set of real gates, in exchange for no ceremony
anywhere else.

### Why the *checking* costs zero waits

The gate above is deliberate. The **decision to apply it** costs nothing.

The drafting manager is **already in the loop on every ticket** —
`PENDING_ASSIGNMENT` is the initial status for every request from every door
(`lib/workflow.ts:44-51`). They already open the ticket, already read it, already
act on it.

Reading a one-line declaration while doing that is not a new stop. **That is the
entire reason this model satisfies the governing principle** — the checking party
was already there. Compare a QA/QC status, which inserts a person who was not.

### Do not

- **Do not let the flag be cleared.** True-ward only. If an assigner flags in
  error, the engineer's review resolves it — that costs one review, and the
  alternative is a clearable safety gate.
- **Do not let the assigner clear a like-in-kind declaration**, or set
  `engineering_required = false`. `DEC-33`'s ratchet only turns one way.
- **Do not delete `requiresEngineerApproval` in this change.** Leave it in place
  as the seeded fallback for tickets predating `GAP-110`'s columns, and remove it
  in a later, separate change once no rows depend on it.
- **Do not add a new status.** The delivery gate is a *condition on existing
  transitions*, not a stage. `PENDING_ENG_TEAM` stays available as the optional
  pre-drafting scope review.
- **Do not block drafting on the flag.** The constraint is *"no deliverable
  without official approval"* — not *"no drafting without official approval"*.
  Blocking the start is the expensive misreading and buys nothing.
- **Do not leave `approve_minor_correction` outside the gate.** It routes
  straight to `PENDING_IFC` and is offered to every requester. A delivery gate
  that misses it is not a gate.
- **Do not force the assigner to hand-pick the approver** once a router exists.
  Flagging is a judgement about the work; choosing who reviews is a routing
  question they should not have to answer (`FRIC-4`).

### Acceptance

1. A flagged ticket cannot **issue** without official approval, whoever the
   requester is — Manager, Admin and DocCtrl included. A test pins each.
2. **Every** issue transition is gated, `approve_minor_correction` included. A
   test pins that one by name.
3. A flagged ticket can still be drafted and submitted while approval is pending
   — the roster runs alongside drafting, not in front of it.
4. The flag can be raised at any pre-issue status by whoever can assign, and a
   late flag does not reset the ticket or discard drafting work.
5. Where routing is configured, flagging resolves approvers through it; N
   approvers cost one wait state on the roster.
6. `approve_team` leaves `engineering_required = true`.
7. No path sets it false.
4. The ticket shows *why* engineering is required — declaration absent, or
   flagged by a named person on a date with their stated reason. "Because of your
   job title" disappears as an answer.
5. An unflagged, declared like-in-kind ticket closes through the assigner with
   the assigner recorded as the approver of record — which is what the owner
   described, made explicit rather than implicit.

**Related findings:** `TIER-1`, `TIER-5`, `LEAK-3`, `UI-1`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL): `request_eng_review` and the new `flag_engineering` (the assignment queue, at `PENDING_ASSIGNMENT`, `DRAFTING`, `REVISION_REQ`, `PENDING_REVIEW`, a reason required, no status change) write `engineering_required = true`; nothing writes false. Acceptance 1 ✓ and 2 ✓ (every issue transition by name, `approve_minor_correction` included); 3 ✓ (drafting continues); 4 ✓ (any pre-issue status the queue can assign at; no reset); 5 ✓ on routed libraries (the engineering slot is appended where the gate applies — DF-P5 `withEngineeringGate`); 6 ✓ (`approve_team` writes nothing for it); 7 ✓; "the ticket shows why" ✓ (`DeclarationCard`: declared by whom and when / required — flagged or no declaration / the earlier rule for a pre-paste request); the declared like-in-kind request closes through the assigner and requester, the requester's approval recorded as the approval of record.*

*DF-P6 third review fix pass (2026-10-21, DEC-29): `request_eng_review` sets `engineering_required` only on a request FILED under the review model (`tickets.review_model_filed`, `20261250`) — never on a pre-paste row (DEC-90 ruling (2): an in-flight request does not change lane because a triager asked a scope question), and not as a declared request's engineering-first loop (fix pass 2). On those rows `flag_engineering` is the explicit binding flag. Proposal note 1 above ("`request_eng_review` sets `engineering_required = true`, permanently") holds for every request filed after the paste. Where it binds, "Flag for Engineering Review" now says so before the click (`lib/workflow.ts` `FLAG_ENG_REVIEW_BINDS_DESCRIPTION`). Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 3 (review, major) …", `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass 3 (review, major) …".*

---

<a id="gap-112"></a>
## GAP-112 · The routing table — no facility vocabulary in code

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-105` · Decisions: `DEC-35`, `DEC-36`, `DEC-37`

### The requirement it implements

> *"I don't want to bake in anything that says QA/QC — I'd rather have a dynamic
> router, a router configuration. Having it baked into roles boxes the app into
> names and conventions other people don't subscribe to at their facility."*
>
> *"This assign should exist in the doc ctrl so we could use it here."*
>
> *"Where I work I'm the drafting manager and the QA/QC, so I can approve a
> drawing. But that might not be true elsewhere."*

All three sentences describe one thing: **routing is data, resolved through
document control, and one person may fill several slots.**

### This replaces the reviewer-shaped parts of GAP-102 and GAP-104

`GAP-102` and `GAP-104` each describe a specific routing need — quality
assurance, and per-library release review. Both were written before the router
existed as a concept. **Neither should be built as a bespoke mechanism.** Build
the router; express both as configuration in it. Their `Do not` lists still
apply — especially "no new status, no new role."

### Where it lives — corrected

> An earlier version of this spec put the routing table in `org_configurations`
> under a new key. **`DEC-36` has been revised: it belongs as a
> `routing_control JSONB` column on `libraries`, `collections` and `documents`**,
> exactly where `review_control` and `doc_class` already sit.
>
> The reason is that routing must resolve **per container** — which is the whole
> requirement, "route this drawing type to the doc control of that library". A
> per-org blob needs its own library→rule index maintained by hand, in parallel
> with a chain walk that already exists. Two mechanisms for one question is how
> they drift apart.
>
> The migration mirrors `20261012` (doc_class) line for line: additive,
> idempotent, and inheriting the existing per-table RLS on `libraries` and
> `collections` — no new policies.
>
> Two further traps found while checking this:
> - `org_configurations`'s JSON column is **`data`**, not `value`
>   (`supabase/schema.sql:52-59`). Writing `value` is a runtime error, not a type
>   error.
> - **Do not model routing stops as `CapabilityId`s.** `lib/capabilityPolicy.ts`
>   is a fixed 17-member union with `defaultRoles` baked per entry. A facility's
>   stop is data; a capability is code.
> - **Do not add a facility's role to the `Role` union.** `types/schema.ts` is a
>   closed union of 19 literals and `ROLE_CAPABILITIES` is
>   `Record<Role, Capability[]>` — adding one is a code change, which is exactly
>   what `DEC-35` forbids.
> - **Do not key the router on `ticket.status`.** That is what
>   `lib/ticketRouting.ts:97-107` does today, and it is why routing cannot vary
>   by library or work class.
> - **Do not let the router resolve to nobody.** `lib/ticketRouting.ts:83-92`
>   currently guarantees a non-empty pool via `fallbackToAdmins`. Keep that
>   property — an empty stop is a silently dropped request.

### The substrate is already there

Nothing here needs a new table.

| Piece | Where | What it gives you |
|---|---|---|
| Per-org config JSON + admin editor | `org_configurations` (`org_id`, `key`, `data`); editor at `app/(protected)/admin/requests/page.tsx:72-101` | The drafting form's request types, units and priorities are **already** org-configured exactly this way. A router is one more `key`. |
| Container-chain resolution | `resolveEffectiveDocClass` — `lib/docClass.ts:49-58` | Six lines. Document → folder → library, most specific **defined** level wins. Already mirrored by `review_control`. |
| Roster mechanics | `lib/reviewControl.ts` | Required primaries, alternates, content-hash-bound signatures, invalidation on change, timeout-driven alternates, auto-finalize. Done. |
| Named-person grants with expiry | `lib/capabilityPolicy.ts:98-110` | Fills a slot with a person rather than a role. |
| Standing visibility | `lib/subscriptions.ts` | A slot can be *notified* rather than *blocking*. |
| Stop-work authority | `holds` — defaults `["*"]`, `lib/capabilityPolicy.ts:85-88`; enforced `lib/documentGuards.ts:109-125` | A slot's recourse when it has no signature. |

### Design

A **slot** is the unit. Code knows slot *properties*; it never knows slot
*names*.

```
slot := {
  key:            <facility's own string — "qa", "insp", "process-safety", anything>
  label:          <what the facility calls it, shown in the UI>
  fill:           { roles: [...] } | { users: [...] } | { owner_of: "library" }
  mode:           "blocking" | "consent_window" | "notify_only"
  applies_when:   { lane: "engineered" | "like_in_kind" | "any", … }
  independent_of: [<slot keys>]        // DEC-37
  window_hours:   <number>             // mode = consent_window only
}
```

**`mode` is the friction ladder made configurable.** The same facility can put
its quality function on `notify_only` (zero waits, zero touches, keeps its hold
authority) and its process-safety function on `blocking` for the engineered lane
only. Neither choice is in the code.

`applies_when.lane` keys off `GAP-110`'s declaration, which is why that ships
first.

**Resolution** copies `resolveEffectiveDocClass` exactly — document → folder →
library, most specific defined level wins — and copies two of its properties that
are not merely stylistic:

1. **Declared, never guessed.** *"guessing from filenames would misroute
   safety-critical documents."* A router must never infer a slot from a title or
   a filename.
2. **Fail closed on transient error.** *"'we couldn't check' must never silently
   read as 'no class declared' — that's how a PSM gate quietly turns itself
   off."* A router that cannot load its config **blocks with a legible message**.
   It does not default to permissive.

**Seeding.** An org with no configuration gets a seed that reproduces today's
behaviour exactly, built from the existing helpers — `isEngineerRole`,
`isManagementRole`, `isDocCtrlRole`. Those functions become *seed data*, not dead
code and not deleted code.

### One person, many slots

Per `DEC-37`, a person satisfies every slot they can fill, in one action, and the
record shows each slot satisfied and by whom. The only constraint is
`independent_of`, seeded so that the approval slot cannot be filled by the
drafter — which is about **one deliverable's producer versus its checker**, not
about how many hats someone wears.

This is the concrete answer to *"I'm the drafting manager and the QA/QC."* Both
slots resolve to the same person, both are satisfied, and the audit trail says so
explicitly rather than pretending one of them did not apply.

### A defect to fix before storing anything here

The admin editor's access guard is **client-side only**:

```tsx
// app/(protected)/admin/requests/page.tsx:63-67
useEffect(() => {
  if (activeRole && !['Admin', 'DocCtrl'].includes(activeRole)) {
    router.push('/dashboard');
  }
}, [activeRole, router]);
```

The write goes straight to the table via `supabase.upsert` — so whether a
non-admin can edit org configuration depends entirely on `org_configurations`
RLS, which must be read and confirmed **before** the routing table is stored
there. **A routing table with a weaker guard than the roles it routes is worse
than no router**, because it looks like a control.

### Do not

- **Do not create a new table.** `org_configurations` already exists with an
  editor and a proven pattern.
- **Do not write a second chain-walk.** One resolver. Two will drift and then
  disagree about which library governs a document.
- **Do not delete the role helpers in the same change.** They become the seed. An
  org that has configured nothing must behave byte-for-byte as it does today.
- **Do not put any facility's vocabulary in code.** Not `QAQC`, not `B31.3`, not
  `NDE`. If you find yourself typing one, it belongs in seed data or the org's
  configuration.
- **Do not default an unconfigured slot to blocking.** Unconfigured means absent,
  not maximal.
- **Do not build this before `GAP-105`.** With no `library_id` on the ticket
  there is no chain to walk (`DCW-1`).

### Acceptance

1. `grep -rn 'QAQC\|B31\|NDE\|radiograph' app lib components` returns nothing
   outside seed data, test fixtures and user-visible copy.
2. An org defines a slot named anything, filled from any role or named person,
   in any mode, and the drafting flow honours it with no code change.
3. An org with no configuration behaves exactly as today — pinned by a test that
   runs the current state machine's expectations against the seeded router.
4. One person filling three slots satisfies all three in one action, and the
   record names all three.
5. A config load failure blocks and says so. A test forces the failure.
6. The resolver passes the same chain-resolution cases as
   `resolveEffectiveDocClass`.

**Related findings:** `TIER-3`, `TIER-4`, `TIER-8`, `DCW-2`, `DCW-6`.
**Supersedes the mechanism (not the reasoning) of:** `GAP-102`, `GAP-104`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P5 ROSTER): `routing_control` on libraries / collections / documents (`20261241`, pending paste; `20261012`'s lines; guarded — a document controller ONLY may change a library's, a folder's or a document's (DF-P5 fix pass: folder and document, so a document's effective owner — often its drafter — cannot swap the gate; DF-P5 fix pass 2: library too — the library owner / node-manager limb let a drafting lead who owns a library drop the engineering gate one level up), and a row INSERTED carrying a table needs a controller on every level — and audited from the database as `ROUTING_CONTROL_CHANGED`, inserts included; no new policy), one resolver on `lib/containerChain.ts` (`lib/routingControl.ts`: declared, never guessed; a transient read failure, an unusable table, a slot nobody can fill, storage that cannot be read or a file that is not in storage refuse the submission with the reason; a file too large or too slow to fingerprint is bound by identity and named on every sign-off, not refused — DF-P5 fix pass 2; a 42703 / PGRST204 is "not pasted" only when it names `routing_control`), the editor beside the review-policy editor (`components/documents/RoutingControlSection.tsx`, library and folder levels — DEC-90 ruling (3)). Acceptance 2 ✓ for `blocking` and `notify_only` (any slot name, any role / person / capability / the requester, independence per slot); a `consent_window` slot is honoured as a sign-off until `GAP-109` lands (fail-safe, DEC-38 — said in the editor), so "in any mode" holds only in that sense. Acceptance 3 ✓ (the seed is today's behaviour, pinned against the engine — `dfRoundG_P5_routing.test.ts`). Acceptance 4 ✓ (one person, three slots, one sign-off; every slot names its signer). Acceptance 5 ✓ (route test: an unreadable chain refuses, 503). Acceptance 6 ✓ (the resolver passes `resolveEffectiveDocClass`'s cases). Acceptance 1: DF-P5 adds no `QAQC` / `B31` / `NDE` / `radiograph` anywhere; the literal case-sensitive grep over `app lib components` was not empty before this package (substrings of unrelated identifiers and prose — `INDEPENDENT`, `MEANING_INDEX_…`, `VISION_RENDER_…`, a companies-page tooltip), so it is not empty after it either. Not built: the document-level editor (the setter supports it; the Inspector is not this package's file) — see the DF-P5 hand-off notes in `99-fix-sequencing.md`.*

---

<a id="gap-113"></a>
## GAP-113 · The availability record — proving it was asked

**Verdict: BUILD** · Effort: **M** · Depends on: `LEAK-1`, **`EVID-13`** · Decisions: `DEC-38`, `DEC-39`
**`GAP-109` MUST NOT SHIP WITHOUT THIS.**

> ### ⚠ `read_at` is already destroyed — `EVID-13` is a prerequisite, not a relative
>
> The three-state record below rests on `notifications.read_at` meaning "this
> person opened it". It does not mean that today.
> `app/api/tickets/workflow-action/route.ts:324-332` **mass-stamps `read_at` on
> other users' unread rows** for the ticket on every transition. So the moment
> anything else happens on the ticket, everyone reads as having seen it.
>
> Fix `EVID-13` first or the middle state — *delivered, never opened*, the most
> useful signal about whether the window length is right — is unrecoverable.

> ### ⚠ Do not add a cron entry
>
> `app/api/cron/maintenance/route.ts:286-291` records that a third scheduled
> entry **fails every deployment on this hosting plan** and once froze production
> for a day. Window expiry, warnings and escalation extend the existing
> maintenance cron. Nothing goes into `vercel.json`.

### The requirement it implements

> *"There needs to be warnings. The system has to log it was available to them
> and it didn't get taken care of."*

This is the condition that makes silence-is-consent defensible instead of
reckless. *"Nobody objected"* is only a record if *"everybody was asked"* is a
fact on disk.

### The substrate exists and is currently unsafe for this purpose

The `notifications` table already stores **one row per (recipient, event)** with
a `read_at` column (`lib/inAppNotifications.ts:79-97`, `:188`). That is precisely
the "it was available to them, and whether they looked" record.

But the writer is fire-and-forget with the error swallowed:

```ts
// lib/inAppNotifications.ts:74-97
/**
 * Insert one notification row. Fire-and-forget by design — callers
 * shouldn't block their main flow on the bell-icon write. Errors are
 * logged but never re-raised.
 */
    if (error) console.warn("[notify] insert failed", error.message);
```

For a bell icon that is the correct engineering call. For a consent window it is
disqualifying: **the insert can fail, nobody is told, and the clock runs anyway.**
The ticket then advances with an audit trail that says nobody objected, when the
truth is nobody was asked.

There is a second, independent hole feeding the same failure: `LEAK-1` — the
workflow route never calls `resolveTicketRecipients`. Confirmed by reading the
route's imports (`app/api/tickets/workflow-action/route.ts:1-13`): it imports
`WorkflowEngine` and `loadCapabilityPolicy` and not the router. So after
creation, transitions notify the requester and drafter and nobody else. **A
consent window opened by a transition would today notify the wrong people, or
none.**

### The pattern to copy is already in this codebase

The acknowledged-distribution feature is the same shape with the polarity
flipped — it *blocks* on silence where a consent window *advances* on it — and it
is already built with durable rows rather than bell entries. Its notification
vocabulary is instructive:

```
| "ack_requested"      // you must read & acknowledge an issued revision
| "ack_complete"       // (to owner) every assignee has acknowledged
| "ack_overdue"        // (to owner/Admin/DocCtrl) an assignee is long overdue
| "ack_unsatisfiable"  // (to owner/Admin/DocCtrl) an ack policy resolved to
                       //   nobody / has gaps
```

**`ack_unsatisfiable` is the one to internalise.** A consent window has the
identical failure mode: a slot that resolves to **zero people**. A window with an
empty recipient set must never advance on silence — nobody was asked, so nobody
declined to object. Whoever built acknowledgments already found this; do not
rediscover it the expensive way.

### Design

**Three guarantees, in order:**

1. **Delivery is a precondition, not a side effect.** Consent-window
   notifications take a different path from bell notifications: awaited,
   error-checked, retried. The window's start timestamp is written **in the same
   transaction as** the delivery rows. No rows, no timestamp, no clock — the
   ticket stays put and says why.
2. **The record lives on the ticket.** `consent_window_opened_at`,
   `consent_window_recipients` (uids **frozen at open time**, not recomputed at
   expiry — people move roles), `consent_window_warned_at`,
   `consent_window_expired_at`, plus an explicit ticket-history entry:
   *"Advanced without objection — asked N people on <date>, warned <date>, window
   closed <date>"*, naming them. Evidence cannot live in a feed that gets marked
   read, archived or pruned.
3. **At least one warning before expiry**, to the same recipients plus the
   assigner, itself recorded.

**What "it didn't get taken care of" means, precisely.** Three distinguishable
states, and the record must tell them apart:

| State | Evidence | Reading |
|---|---|---|
| Never delivered | no notification row | **Blocks.** Not consent. |
| Delivered, unopened | row, `read_at` null | Advances. Recorded as *not opened*. |
| Opened, no action | row, `read_at` set | Advances. Recorded as *seen, no objection*. |

Collapsing the last two into "nobody objected" throws away the most useful signal
you have about whether the window length is right.

### Do not

- **Do not reuse `notify()` unchanged and assume the record exists.** It is
  documented as fire-and-forget. That is a correct design for its purpose and the
  wrong one for this.
- **Do not start the clock at the transition.** Start it at confirmed delivery.
- **Do not recompute the recipient set at expiry.** Freeze it at open. Otherwise
  a role change mid-window silently rewrites who was asked.
- **Do not advance on an empty recipient set.** Escalate to the assigner.
- **Do not build this after `GAP-109`.** It is the safety condition on it, not a
  follow-up.
- **Do not rely on the bell alone for the record.** Notifications get pruned;
  evidence must not.

### Acceptance

1. Forcing the notification insert to fail leaves the ticket un-advanced, with a
   visible reason. A test forces it.
2. Every auto-advanced ticket answers, from its own history with no reference to
   the notifications table: who was asked, when, whether they opened it, when
   they were warned, when it expired.
3. A window resolving to zero recipients blocks and escalates.
4. A recipient who changes role mid-window is still shown as asked.
5. The warning fires at the configured fraction and is recorded.
6. `LEAK-1` is fixed first, and a test asserts the workflow route resolves
   recipients through `resolveTicketRecipients`.

**Related findings:** `LEAK-1`, `FRIC-1`, `UI-1`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P7 CONSENT): `20261255` (pending paste; DEC-30 one file). Ten workflow-owned `consent_window_*` columns on `tickets` (a client neither writes nor inserts one — `trg_ticket_consent_window_guard`; `ticket_update_guard` untouched), the append-only `ticket_notice_events`, and two SECURITY DEFINER functions granted to the service role only (`open_consent_window`, `record_consent_window_warning`; search_path pinned, a session refused — DRLS-16). Guarantee 1 (DEC-38): `open_consent_window` inserts the bell rows and their `delivered` events and stamps `consent_window_opened_at` in ONE transaction, after a count check; no rows, no stamp, no clock. The route awaits it and, when it fails, the submission stands, the slot waits as a sign-off, and the answer says why; the cron retries the open with the frozen recipients. Guarantee 2: the recipients are frozen at open in `consent_window_recipients`, and the ticket's own history carries asked / reminded / closed and each person's notice state in words. Guarantee 3 (DEC-39): one reminder at the configured fraction to the people asked plus the assignment queue (`ticket.assign` holders), recorded as `warned` events and `consent_window_warned_at`; a window closes only once its reminder has been out 24 h. The three states are kept apart (`noticeStates`): never delivered HOLDS the close (not consent), delivered-unopened and opened advance, recorded as "told, not opened" and "seen, no objection" (`read_at` is the recipient's own act since `EVID-13`). Acceptance 1 ✓ for "un-advanced" (PG16: a forced notification-insert failure leaves no rows, no events and no stamp — `rls/dfP7ConsentWindow.test.ts`); the visible reason is said on the response (`consentWarning`) and recorded as a `blocked` notice event (`reason: window_not_opened`, fix pass) — it is NOT on the ticket page or in the ticket's history (DEC-29: the response and the notice record only). Acceptance 2 ✓ (`advancedHistoryDetails`; the scan test asserts the history line names who, when, opened, reminded and closed with no mention of notifications). Acceptance 3 ✓ (an empty set is BLOCKED: no window, a `blocked` event, the assignment queue told — route test; the function also refuses an empty set — PG16). Acceptance 4 ✓ (frozen at open; scan test "changed role mid-window"). Acceptance 5 ✓ (scan test and PG16: the reminder reaches everyone asked, stamped with its rows, once). Acceptance 6 ✓ before this package (`LEAK-1`: the route resolves its fan-out through `resolveTicketRecipients`, `app/api/tickets/workflow-action/route.ts:1316`, pinned by `dfRoundG_P3_routing.test.ts`); the window's own recipients are the consent slot's occupants, resolved by the routing resolver at open, less the drafter and any party the slot is independent of (fix pass), and checked against the service-written roster ledger by `open_consent_window`. The copy recall (`PHYS-18`) is not run on an issue that the consent advance completes — recorded under DEC-44 (DF-P7-consent) with an owner. Fix pass 2 (review): the open and the reminder were bell-only; each person they reach is now also emailed when their preferences allow it (an `assignment` email with an absolute link, queued once the function lands), the history line names each person's channel ("in the app only: … (why)"), and a person not emailed gets a `not_emailed` notice event (by their choice, or for want of an address, a readable preference row or a working queue) — DEC-44 (DF-P7-consent) item 15. The cron's retry asks only active members and, with nobody left, records the block once, tells the assignment queue once and stops (item 16). The reminder's "assigner" is resolved for the ticket's own request type and unit (`ticketResource`), as the route's block escalation resolves it.*

*Assigned (2026-10-21, the integrator at the DF-P7 merge, DEC-31):* acceptance 1's page half (the failed open's reason on the request page and in its history) → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**.

*Landed 2026-10-21 (drafting-flow Round G, DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS): acceptance 1's page half — a consent window that was NOT opened is said on the request page and in its history, read from what DF-P7 already records (the `blocked` rows of `ticket_notice_events`: the route's `window_not_opened` with its error, the maintenance run's `window_never_opened` with why, and `no_longer_member`). `components/requests/ConsentBlockNotice.tsx` (mounted only when the request's roster carries a consent plan or slot — DEC-90 ruling (1) for DF-P18: no extra read and no change for any other request; nothing said before `20261255`) says each in words (`lib/requestPageReview.ts` `consentBlockReason`), and the Audit Log tab shows each as an entry labelled by its reason, merged by date with the request's own history (`consentBlockHistoryEntries` — read-only; nothing is written to the ticket). Acceptance 1 ✓ now as written for the visible reason (the response, the notice record, the page and the history). *Corrected at the DF-P18 fix pass (review major, DEC-29):* the notice used to read every `blocked` row for the ticket, oldest first. It now reads only the current roster's rows (`roster_id`), newest first before the cap (`currentConsentBlockRows`). A `window_not_opened` row no longer stands once the window opened (`consentWindowOpenedFor`: the plan is marked `opened` by the maintenance run's retry, or the roster carries its window mark), so the page never shows "could not be opened" beside a running window. The Audit Log tab keeps the row, marked "Consent window not opened (opened later)". *Corrected at the DF-P18 fix pass 2 (review major and minor, DEC-29):* that fix pass handled only the opened-later case — a block on a slot since signed, or on a roster that had closed with the request moved on, still said "it waits for a sign-off". Now no block stands once its consent slot is `satisfied` or once the review is over (the roster's `closedAt`, or the request no longer `PENDING_REVIEW` — the page passes `ticketStatus`), by one rule (`consentBlockSupersededBy`); the Audit Log tab keeps each, marked "signed later" / "review closed", and labels each entry by its reason (`consentBlockActionLabel`: a `no_longer_member` row, a window that was opened and ran to its close, is "Consent window closed — nobody left who could object", not "not opened"). So the page states no block that no longer holds — opened later, signed, or closed. Also landed (the DF-P7 editor residual): the routing editor (`components/documents/RoutingControlSection.tsx`) edits a consent slot's `window_days` (1–30) and `warn_fraction` (as a percent, 10–90; blank = the defaults), validated by `lib/routingControl.ts` as before. Tests: `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts`, `lib/__tests__/dfRoundG_P18_reviewModelPageRender.test.ts`. *Fix pass 3 (review minors):* when the roster changes, the notice clears the rows it handed the page before anything else (a new roster with no consent slot keeps none, so the Audit Log never carries an earlier roster's block judged against the new one); and each window field sets only its own setting (`windowFieldPatch`), so editing the days keeps a stored `warn_fraction` that is not a whole percent (0.333) exactly as stored.*

*Built (2026-10-22, the integrator at the DF-P18 merge):* acceptances 2–6 landed with DF-P7 (20261255, PASTE row 197) and acceptance 1's page half with DF-P18; every acceptance holds in code, live once 20261255 is pasted. The two consent mechanisms not yet built and the escalation tier stay with DF-P22 (their own findings).

---

<a id="gap-114"></a>
## GAP-114 · Projects ↔ requests, by reference

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-105`, **`PROJ-1`/`HAND-3`** · Decisions: `DEC-40`

> ### ⚠ There is nothing to link yet
>
> `project_documents.document_id` is `UUID NOT NULL REFERENCES documents(id)`.
> A ticket's `type: 'Final'` attachment is **not** a document — it is a JSONB
> entry on the ticket with an R2 key.
>
> `PROJ-1` and `HAND-3` are the same fact from two directions: **a request's
> approved deliverable never becomes a controlled document.** Until that is
> built, "push the deliverable to the project's documents" has no row to
> reference, and the only way to satisfy it would be the byte copy `DEC-40`
> forbids.
>
> So the order is: deliverable → controlled document (`DEC-22`, `GAP-6` in the
> roles area), *then* the project reference. Linking the **request** to a project
> is independent and can ship first — that is one nullable FK.

### The requirement it implements

> *"What about projects — what if a bidirectional portal for situations like a
> project manager wants to link or push the request and its files to a project's
> documents."*

### The project side is built. The ticket is the one object it cannot see.

Every other work object in the system already carries a project reference:

| Type | Field | Location |
|---|---|---|
| `CheckoutSession` | `projectId?` — *"nullable: ad-hoc checkouts have none"* | `types/schema.ts:929` |
| `Milestone` | `projectId?`, `documentId?` | `types/schema.ts:456-457` |
| `MarkupRequest` | `projectId?`, `documentId` | `types/schema.ts:1002-1004` |
| **`Ticket`** | **none** | `types/schema.ts:1113-1157` |

And the project activity feed already has a typed vocabulary with the right
events in it:

```ts
// types/schema.ts:980-983
export type ProjectActivityType =
  | "comment" | "checkout_added" | "checkout_released"
  | "member_joined" | "member_left" | "status_changed"
  | "markup_requested" | "markup_shared"
  | "doc_added" | "doc_removed" | "ownership_transferred";
```

**A ticket has no `projectId`, no `libraryId`, no `collectionId` — no container
reference of any kind** (`DCW-1`). It is the only work object a project cannot
see, and it is the one that produces drawings. That is the entire gap. The
attachment point on the project side exists and is in use.

### The trap inside the word "push"

The requirement says *"push the request and its files to a project's
documents."* The requirement is right and the word hides a document-control
violation.

Copying a controlled drawing into project storage creates an uncontrolled copy
that:

- does not supersede when the source is revised,
- does not carry a hold,
- does not appear in distribution recall,
- and does not visibly go stale.

**That is precisely the failure the entire system exists to prevent**, and it is
what the most natural implementation of "push the files" produces. `DEC-40`
settles it: **reference, never copy.**

A reference gets the right behaviour for free — it shows the current revision,
goes visibly stale when superseded, and a hold on the document is a hold
everywhere it appears.

### Scope

**In, both directions:**

- **Project → request.** From a project, raise a drafting request already bound
  to it. The existing intake form with `project_id` pre-set.
- **Request → project.** From a ticket, link it to a project the actor is a
  member of. One foreign key, one `ProjectActivity` row.
- **Deliverable → project documents.** When a linked ticket issues, the issued
  revision appears in the project's document list **as a reference**, and the
  project activity feed gets a `doc_added` event.

**Out (deliberately):**

- **Any file copy.** `DEC-40`.
- **A project-local document record.** It would duplicate a controlled one and
  the two would diverge on the first revision.
- **Cross-permission-model reach-through.** A project member who cannot read the
  library must see that a deliverable exists and be unable to open it — not have
  the reference silently vanish (which reads as "the drafting team did nothing")
  and not have it silently open (which is an egress hole). This is the same
  discover-without-read distinction as `DCW-5`, and it is the single most likely
  thing to be got wrong here.

### Do not

- **Do not copy bytes.** Ever. Not "just for the bid package" — that is the
  existing export/snapshot path, which already watermarks, and is a different,
  already-solved problem.
- **Do not show a revision without showing whether it is current.** A project
  view of a superseded drawing that does not say so is worse than no project
  view, because it is trusted.
- **Do not grant read through the project link.** Project membership is not
  library access. Show existence; gate content on the library ACL.
- **Do not add the reverse link as a second source of truth.** One foreign key on
  the ticket. The project's list is a query, not a stored set.
- **Do not build before `GAP-105`.** `library_id` and `project_id` are the same
  shape of problem and the same migration; doing them together avoids two
  backfills over the same table.

### Acceptance

1. Linking writes exactly one foreign key and one activity row. No bytes move.
2. A project's document list shows the live current revision of every referenced
   deliverable and marks superseded ones as superseded.
3. A hold on a referenced document is visible from the project.
4. A project member without library read sees that a deliverable exists, sees its
   status, and cannot open it — verified in a test, both directions.
5. A request raised from a project arrives with `project_id` set and appears in
   the project's activity feed.
6. Unlinking removes the reference and leaves the ticket and the document
   untouched.

**Related findings:** `DCW-1`, `DCW-5`, `LEAK-9`.
**Related gaps:** `GAP-105` (ticket → library binding — same migration).

**Built (2026-10-21, drafting-flow DF-P8 PROJECTS).** The request ↔ project link by reference (DEC-40): `tickets.project_id` with an org-equality rail (20261256, PASTE row 200), settable only through `/api/tickets/project-link` and the create route; the check-in and collision paths carry it; the project page lists its requests and warns at closeout about open ones; the published deliverable is referenced on the project register by the hand-back and the link route. *Remaining:* the reference when a deliverable's document review completes (`PROJ-1`) → projects-joint **J21** (the integrator at the DF-P8 merge, DEC-31); this gap closes with it.

**Resolution (2026-10-22, projects-joint Round G).** Closed by record (DEC-90 ruling (6) for J21): `PROJ-1` landed. When a document review completes on a version a request published into review, `lib/reviewControl.ts` `finalizeReviewedRevision` starts — never awaits — the reference on the request's project. It goes through `POST /api/projects/deliverable-reference`: DF-P8's register policy and `referenceDeliverableInProject` (a `project_documents` reference, no bytes moved — DEC-40). The project's requests card reads a deliverable in review as "In document review" and, once promoted, as the current revision. With it, the deliverable reaches the project's documents by reference on every path: the hand-back outside review, a later link, and a review's completion.

**Acceptance.** 1–6 ✓ as built by DF-P8 (above), with acceptance 2 now holding through a document review too (the card reads the pointers: pending, current, or not current). At the review's completion the reference is written only for the person the promote names as having completed the review (`documents.updated_by`; J21's merge-time fix removed the forgeable audit-row qualifier), within minutes of the promote, and never over a detach since (J21's review fix pass, `PROJ-1`). A reference not written — including a promote whose release stamp is outside the window (a skewed browser clock) — is recorded on the request's audit trail and (unless the request is archived) as one line on its history (the Audit Log tab) — never for a document already on the register and said on screen to the finalizer (`components/documents/ReviewGateSection.tsx`; `PROJ-14` RESOLVED at J21's merge). Residual: a call lost entirely (the route unreachable on both tries, or the page closed before the POST went out) loses that one reference, recovered from the project's Documents card, or by unlinking the request and linking it again (re-linking to the same project writes nothing) — the P39 ruling (d) precedent.

---

<a id="gap-115"></a>

## GAP-115 · Exception-only review — GAP-109 mechanism 3's remainder

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-109` · Decisions: `DEC-90`, `DEC-12`, `DEC-31`

*Opened 2026-10-22 by drafting-flow Round G, DF-P25 review fix pass 5 (the reviewer's minor: mechanism 3's Partial named no owner).* `GAP-109` mechanism 3 (exception-only review) is NOT built; DF-P25's Partial on `GAP-109` says why (DEC-90 ruling (1): no half — the re-open limb must hold on every issuing path, and that reaches files DF-P25 does not hold). This record carries the remainder so it has an owner once DF-P25 merges.

**Owner (DEC-31):** drafting-flow **DF-P26 ISSUING-PATH STOPS** — the next free drafting-flow package number (the integrator renumbers on a collision and writes the plan entry at merge). It holds the workflow route's issuing path (`app/api/tickets/workflow-action/route.ts` — the completing `sign_slot` and `ISSUING_APPROVALS`), `lib/consentWindowScan.ts`, `lib/workflow.ts`, with one migration slot. It also owns `GAP-116`, which needs the same issuing path.

**What remains (both limbs, merged only together — DEC-90 ruling (1)).**
1. The opt-in (`exception_only` on a non-engineering, non-assurance blocking slot; never the last open blocking slot; never the engineered lane) satisfied at open by a recorded system act naming the rule when no exception is on record.
2. The re-open limb on all three issuing paths — the route's completing sign-off, its issuing approvals, and the consent window's silent close — reading every recorded exception kind (source drift, an override sign-off, an examination-scope waiver, a declaration-check failure), re-opening in the same compare-and-set as the act, with a `reopened` ledger event and the `satisfied_via` / shape / event CHECKs re-created.
3. Never counted by the DEC-12 floor in its three homes (`rosterLacksIndependentSignOff`, `consentFloorHolds`, `preauthLeavesNoSecondPerson`).

**Acceptance.** Default off; an unconfigured workspace byte-identical (the A/B sweep pattern of `dfRoundG_P24_issueGateRoute.test.ts`); no path issues a request whose exception-only slot was rule-satisfied while an exception is on record.

**Status → RESOLVED with one remainder (2026-10-22, drafting-flow Round G) — DF-P26 ISSUING-PATH STOPS, both limbs in one merge (DEC-90 ruling (1) for DF-P26; calls in `DEC-44 (DF-P26-issuing-path-stops)` items 1–6; migration `20261268`, pending paste). Remainder (fix pass 4, DEC-29): the acceptance's "default off — a real A/B sweep against the base route" has no committed base-route pin — NOT DONE as written (recorded evidence only; see the Done-when); owner (DEC-31): the drafting-flow integrator at the DF-P26 merge (`99-fix-sequencing.md` DF-P26 hand-off row).** *Merge-time fix pass (2026-10-22):* two more overstatements corrected ((3e)(i)–(ii)), and by merge-time fix pass 2 one more ((3e)(iv) — when the upgrade is required); the remainder stands as the integrator's standing check — the base-route A/B was re-run at the merge (`ceaa9d0` against `c755add`: 1 116 cases, 1 112 identical, the 4 others the intended hold reads only — (3e)(iii)) and is to be re-run before later route changes land; there is still no committed pin.

**Resolution.** Reproduced on `ceaa9d0`: nothing satisfied a slot by rule or re-opened a satisfied one; `ticket_review_slots.satisfied_via` accepted `primary / alternate / override / consent / preauthorization` (20261264) and the events `opened / told / satisfied / voided` (20261242).
(1) **The opt-in.** `RoutingSlot.exception_only` (`lib/routingControl.ts` `exceptionOnlyOptInAllowed` `:219` — exactly where the pre-authorization opt-in may ride and not on a slot accepting one: a blocking slot that is not the engineering sign-off, not an assurance check, not the requester's own acceptance); the parser keeps it only there (dropped silently elsewhere), `validateRoutingDraft` names a misplaced one, and the routing editor offers it with `EXCEPTION_ONLY_HINT` (`components/documents/RoutingControlSection.tsx` `exceptionOptInFor`). `openRoster` freezes it on the roster slot (`exceptionOnly`).
(2) **Limb 1 — satisfied at open by a recorded system act naming the rule.** At the submission that opens the roster (`route.ts:1261`, `lib/exceptionOnlyReview.ts` `exceptionRuleAtOpen`), each such slot is satisfied `via: "rule"` (no signer, no signature) ONLY when: the request is not engineered work (the route's own engineered-lane answer, which counts an unchecked declaration as engineered); after it the review still waits on a LIVE sign-off by someone other than the drafter that does not accept a standing pre-authorization (`planExceptionRule` / `waitsOnLiveSecondPerson` — never the last sign-off, never the DEC-12 second person); 20261268 answers (`exception_only_review_ready()`); the source has not moved since the request was raised; and no examination-data waiver is recorded. Otherwise the slot waits for its sign-off and the audit row says why (`exceptionReview.ruleNotApplied`: `engineered`, `no_live_sign_off`, `not_migrated`, `source_moved`, `waiver`, `unchecked`). Recorded: the roster-opened history line ("Satisfied by rule (exception-only review — no exception on record): …"), the audit row (`exceptionReview: { satisfiedByRule, rule: "exception_only" }`), and the ledger — the slot written `opened` (as open), then `satisfied` via `rule` by the system actor "System — exception-only review" (`writeRosterLedger`). The panel says "Satisfied by rule — exception-only review, no exception on record (re-opened for its reviewer if one comes on record before the request issues)" (`TicketRosterPanel` `RULE_SATISFIED_TEXT`).
(3) **Limb 2 — re-opened before anything issues.** On a roster carrying a slot satisfied by the rule, each issuing path reads the exceptions on record NOW (`exceptionsOnRecord`: the source moved — whatever the approver acknowledges; an override sign-off on the roster; an examination-data waiver; a like-in-kind declaration whose signature is NOT on record (review fix: one that merely could not be read is a retry, never an exception — on the route `sign_slot` is in `DECLARATION_DECIDES`, so it is already refused 503 `declaration_unreadable` before limb 2, and limb 2 refuses an "unchecked" too); the request become engineered work) and, with one, re-opens that slot for its reviewer in the SAME compare-and-set as the act (`reopenRuleSatisfied`; `exceptionReopened` names the exceptions on the slot): the act lands (the sign-off is recorded; the window closes) but the request does not issue — it waits on the re-opened slot. Paths: the route's `sign_slot` (`route.ts:1322`–`:1345`, before the dry run answers — the dry run says `exceptionReopens`; history, audit `exceptionReview: { reopened, exceptions }`, the answer's `exceptionReopened` and `warning`, the ledger `reopened` event `:2130`), the route's `ISSUING_APPROVALS` (refused 409 `exception_review_roster` on such a roster — the state machine never offers them under a roster, so this is a guard), and the consent close (`lib/consentWindowScan.ts:1071`–`:1084`, `:1294`). A waiver or source read that cannot prove there is no exception is a 503 `exception_review_unchecked` (nothing written, the dry run too) on the route and a retried run at the close — never a pass. *(Review fix:)* the route's limb 2 reads the source documents through `readSourceMoved` — every one of them, more than one read takes (100) being "unchecked" — as limb 1 and the consent close do, instead of the engine context's drift labels, which read only the first 100 (`lib/workflowAuthority.ts` `DRIFT_READ_CHUNK`) and silently skipped the rest. The re-opened slot's reviewer is put back on the request's unread list.
(3a) **No deadlock behind the floor (review fix; restated by the merge-time fix pass, DEC-29).** A slot the rule satisfied stays signable by its OWN occupants — a primary, or an alternate once alternates are active, never an overrider (`lib/workflow.ts` `slotSignPlan`, its second pass; `lib/ticketRoster.ts` `applySignPlan` upgrades it to the person's sign-off, the ledger's `satisfied` row rewritten with the signer) — except an occupant whose sign-off on it the routing table's independence forbids: the slot independent of the requester they are, or of a slot they signed (a standing pre-authorization they gave included), are signing in the same sign-off, are shown blocked on, or will be an alternate of once that slot's window opens (fix pass 3 (3c)(i); merge-time fix pass (3e)(i)). Without this, a review whose only other independent occupant left (suspended, removed) waited behind the DEC-12 floor with nobody able to sign the rule's slot; now that slot's reviewer signs it and the drafter can complete. Where the floor holds the drafter and no open blocking slot has anyone but the drafter who can actually complete it (`ruleUpgradeNeeded`; *merge-time fix pass 2, (3e)(iv):* a primary who is not the drafter, or an alternate of a slot with a timeout judged once its window opens, each counted only if `slotSignPlan` gives them that slot other than by override — never an overrider, never an alternate whose window never opens; before, every NAMED alternate and overrider counted, so such a review left the rule slot's reviewer an optional sign-off, unbadged, while the drafter's sign-off was disabled by the floor — a stall nobody able to complete it was told of), the upgrade is offered as a REQUIRED sign-off — said (`RULE_UPGRADE_NEEDED_NOTE`) and badged (`isActionRequired`) — to every occupant of the rule's slot whom the table lets sign it and who is not also an overrider of an open slot independent of it (or it of that slot) (pinned: the review fix's deadlock case; the merge-time block's "NO DEADLOCK BEHIND THE FLOOR" case — an alternate whose window never opens — and the reassign-drafter case, engine and route). *Stated — where the review still waits:* (1) the table forbids EVERY occupant of the rule's slot (each is the requester and the slot is independent of the requester, or each gave a standing pre-authorization on a slot the rule's slot is independent of) — the independence the table declares, not the upgrade; (2) the rule slot's only occupant who could act is also an OVERRIDER of a drafter-only open slot independent of the rule's slot (or it of that slot): they are offered only that override (optional — an override is never badged), the upgrade is not offered beside it ((3e)(i)), and the review waits — badging only the drafter, whose sign-off the floor disables and to whom a revision stays open — until they override (an exception, so the rule's slot re-opens and then waits on someone independent of the overridden slot), a revision is requested, or the routing changes. Making the upgrade take precedence there would change the open-slot part of that person's plan, which these passes do not do — raised to the integrator (DEC-31). A revision, or the routing changed, moves either. A sign-off that upgrades the last rule-satisfied slot leaves nothing to re-open (and, since the merge-time fix pass, reads nothing for it — (3e)(ii)).
(3b) **Never demanded of the reviewer the rule excused (fix pass 2).** *Corrected (DEC-29):* the review fix's upgrade path made the rule's slot fillable for its own primaries, so `WorkflowEngine.getActions` offered them a REQUIRED "Sign Off" and `lib/ticketAttention.ts` `isActionRequired` badged them on every request where the rule applied — "satisfied at open" was true in the data but not in what people saw. Now: the upgrade exists only for the DEC-12 floor — offered only above the threshold, never to the drafter (`lib/workflow.ts` `slotSignPlan`); a sign-off offered only on rule-satisfied slots is `optional` (and so is the revision request of an occupant only of such slots) unless `ruleUpgradeNeeded` holds — nobody but the drafter has signed and every open blocking slot names nobody but the drafter (*corrected by merge-time fix pass 2, (3e)(iv):* no open blocking slot has anyone but the drafter who can actually complete it) — when it is required and says why (`RULE_UPGRADE_OPTIONAL_NOTE` / `RULE_UPGRADE_NEEDED_NOTE`, on the action and on the panel; `components/requests/TicketRosterPanel.tsx` labels the button "Sign it yourself (optional) — …", `ruleUpgradeButtonText`). The roster-opened history line no longer lists a rule-satisfied slot under "Sign-offs needed", and its primaries are neither added to `unread_by` nor told (`lib/ticketTransitions.ts` — a roster the rule never touched is unchanged). The sign-off dry run now also returns `exceptionReopenReasons`, and the panel asks the signer BEFORE the e-signature is minted when their sign-off will re-open a rule slot instead of issuing (`exceptionReopenConfirmation`). Pinned in `dfRoundG_P26_exceptionOnly.test.ts` (getActions and isActionRequired for the rule slot's primary, the drafter, an alternate before and after its window, the live reviewer, the needed case; the roster-opened line, `unread_by` and recipients with a regression arm; the panel helpers) and `dfRoundG_P26_exceptionRoute.test.ts` (the dry run's reasons).
(3c) **Fix pass 3 (DEC-29 — two more places the record overstated).** *(i) Not badged, also when the upgrade is forbidden:* `slotSignPlan` offered a rule-satisfied slot even when an independence reason forbade this person's sign-off on it (the slot `independent_of` a slot they signed, or of the requester who holds the fill), so it landed in `plan.blocked` — `getActions` then showed a disabled "Sign Off" and a REQUIRED "Request Revision", and `isActionRequired` badged someone the review does not wait on. Now an upgrade that cannot be given is simply not offered (`lib/workflow.ts` `slotSignPlan`: `if (reason && ruleSatisfied) continue`); an OPEN slot an independence reason blocks is still shown disabled with its reason, as before. *(ii) The bookkeeping read never refuses a non-issuing act (DEC-90 rulings (1) and (4)):* limb 2's waiver / source reads ran on every `sign_slot` of a rule roster and an unreadable one refused even a partial sign-off with 503. Now the 503 `exception_review_unchecked` is given only when the sign-off WOULD complete the review (`rosterCompletion` on the preview roster, `route.ts` limb 2); a sign-off that leaves the review open is taken, nothing is re-opened by it, and the completing sign-off (or the consent close) checks again. Pinned: `dfRoundG_P26_exceptionOnly.test.ts` "an upgrade an independence reason forbids is simply not offered" (with an open-slot regression arm) and `dfRoundG_P26_exceptionRoute.test.ts` "an unreadable waiver read never refuses a sign-off that does NOT complete the review" (partial taken, dry run too; the completing sign-off still 503, nothing written) — both mutation-checked.
(3d) **Fix pass 4 (DEC-29 — "never on the engineered lane" did not hold on the route when the workspace's request types could not be read; one bookkeeping read still delayed a non-issuing consent close).** *(i) Engineered unknown is never "not engineered" (DEC-90 ruling (1), fail-safe):* the route reads the engineering-first request types from the org's `drafting` configuration row (`route.ts` the `org_configurations` read); when that read failed (or its request types could not be parsed) `engineeringFirstTypes` stayed `[]`, and both limbs then treated an engineering-first request as not engineered — limb 1 could satisfy a slot by the rule at open and limb 2 could find no exception and issue. The consent close already treated the same condition as unreadable (`lib/consentWindowScan.ts` `engineeredLaneNow`). Now the route keeps `engineeringFirstKnown` (the row read AND its types parsed); limb 1 passes `engineeredUnchecked: !engineeringFirstKnown` to `exceptionRuleAtOpen` (`lib/exceptionOnlyReview.ts`), which applies nothing and records `ruleNotApplied: "unchecked"` (a request known engineered still says `engineered`); limb 2 adds it to its unreadable branch — a completing sign-off (and its dry run) is refused 503 `exception_review_unchecked`, nothing written, and a partial one is taken, nothing re-opened, as for the other unreadable reads (fix pass 3 (3c)(ii)). *(ii) At the consent close, limb 2's waiver / source reads hold only an issuing close (DEC-90 rulings (1) and (4)):* a failure there aborted every close of a rule roster, even one that left the review waiting on a live blocking slot and so could not issue. Now the close is held (not closed, retried next run) only when the advanced roster would complete (`rosterCompletion`); otherwise the window closes, nothing is re-opened by it, the run's report says the read failed, and the act that completes the review checks again. Pinned (each mutation-checked): `dfRoundG_P26_exceptionRoute.test.ts` "the workspace's request types UNREADABLE — … nothing is applied" (limb 1, an engineering-first ISO type behind a failing `drafting` row: the slot open, `unchecked`, no probe; the row readable → applied), "… UNREADABLE when the completing sign-off arrives — 503 …" (limb 2, dry run too, nothing written; readable again with the type engineering-first → re-opened, not issued) and "… on a sign-off that does NOT complete the review — taken" (the completing one still 503); `dfRoundG_P26_exceptionOnly.test.ts` "whether the request is engineered work UNKNOWN (engineeredUnchecked)" (nothing read); `consentWindowScan.test.ts` "the waiver unreadable on a close that would NOT complete the review" (closed, nothing re-opened, nothing issued, failed 0).
(3e) **Merge-time fix pass (2026-10-22; DEC-29 — the final adversarial review, the integrator's rulings).** *(i) An optional upgrade never displaces a person's real, required sign-off; slot order no longer decides:* `slotSignPlan` walked the routing table once, so with the rule's slot R before an open slot X (X independent of R, or R of X) and one person P a primary of both, P's plan offered the upgrade of R and showed X blocked "Needs a second person" — and once P gave the upgrade, X was blocked for P for good; with X first in the table, P got X. Now it plans in two passes (`lib/workflow.ts` `slotSignPlan`): the OPEN blocking slots first, exactly as before and with no rule-satisfied slot in view; only then the upgrades of rule-satisfied slots, each dropped when its independence leg conflicts with a slot P signed, is signing in this sign-off, is shown blocked on, or will be an alternate of once that slot's window opens (a slot with a timeout — so the upgrade never produces a blocked reason on an open slot, now or later). An upgrade that cannot be given is still simply not offered (never pushed to blocked, fix pass 3); one sign-off's slots stay in table order. A roster with no rule satisfaction plans exactly as before (the second pass adds nothing). The route recomputes `slotSignPlan` for `sign_slot`, so what it signs, accepts and refuses follows the new plan: P signs X, R stays satisfied by the rule, and nothing more is open to P. *(ii) Limb 2 judged on the roster AFTER the sign-off (DEC-90 rulings (1) and (4)):* the route's limb 2 reads (waiver, source documents, the declaration's signature, the workspace's request types) and their 503 `exception_review_unchecked` keyed on the roster BEFORE the sign-off, so a completing sign-off that upgrades every rule-satisfied slot — nothing left to re-open — was refused when a read failed. Now the preview is computed first and limb 2 runs only while `ruleSatisfiedSlots(preview)` is non-empty (`app/api/tickets/workflow-action/route.ts` limb 2); such a sign-off reads nothing, and issues. A completing sign-off that leaves a rule-satisfied slot is still refused 503 on an unreadable read, as before. The consent close was checked for the same pattern and already keys on the roster after the close (`lib/consentWindowScan.ts`, `ruleSatisfiedSlots(advancedRoster)`); a close only satisfies its own consent-window slot, which can never be exception-only, so it never upgrades a rule slot — no change there. Pinned (each mutation-checked — the fix reverted, the test fails, restored): `lib/__tests__/dfRoundG_P26_exceptionOnly.test.ts` "DF-P26 merge-time fix pass — an optional upgrade never displaces a person's real, required sign-off" (R before X and X before R, X independent of R and R of X: P gets X fillable, no upgrade of R beside it, the sign-off required; after P signs X nothing is offered and P is not badged for R — `getActions`, `isActionRequired`; a later alternate of X; an open slot shown blocked for another reason; the no-deadlock case — an alternate whose window never opens is still offered the upgrade and the drafter then completes; regression arms: no independence → the upgrade rides with X in table order, a roster with no rule satisfaction plans as before) and `lib/__tests__/dfRoundG_P26_exceptionRoute.test.ts` (the route signs X in either order and direction, R stays the rule's, P is then refused 403 with nothing written, the live reviewer completes; an unreadable waiver read with a completing sign-off that upgrades the only rule slot → 200 and the request issues, its dry run 200 with no re-open). *(iii) The base-route A/B (the integrator's remainder) re-run:* the same route harness with no DF-P26 mock, on `ceaa9d0` (a temporary detached worktree, removed after) and on the merge-time fix pass's code commit `c755add`, 2026-10-22: 1 116 cases (every action the engine offers plus `sign_slot` / `request_revision`, real and dry run, × every status × every member, with and without a source document; and rosters opened from tables with no DF-P26 opt-in, with and without a notify-only hold-recording slot, each sign-off by every member, real and dry run). 1 112 identical byte for byte (status, answer and the full ordered call log). The 4 that differ are the intended `GAP-116` hold read — a completing sign-off by `e-2` and by the Admin `a-1`, each real and dry run, on a roster carrying an opted-in notify-only hold-recording slot with a source document — and differ only by inserted `document_holds` reads, with the status, the answer and every other call identical and in order: the hold stop's read (all 4) and, on the 2 real sign-offs, the issue notice's hold count (`GAP-102` acceptance 2, after the response). Against the earlier recorded run, the only change in those 4 is the hold read's ordering key (`opened_at` → `id`, fix pass 4's keyset paging). No golden was committed (the remainder stands — re-run before later route changes land). *(iv) Merge-time fix pass 2 (the independent review of the merge-time fix pass; the integrator's ruling — a reachable silent stall, opt-in only):* `ruleUpgradeNeeded` (`lib/workflow.ts`, from fix pass 2, cited as fixed by (3a)) counted every NAMED alternate and overrider of an open slot as able to sign it. With the rule's slot R (primary p-1) satisfied at open beside an open slot X (primary l-1, alternate p-1 with no timeout, independent of R) and the drafter then reassigned to l-1 (`reassign_drafter`, offered in review), l-1 was held by the floor (their sign-off disabled; badged only for a revision) and p-1 was offered an optional sign-off saying the request did not wait on them, unbadged — nobody who could complete the review was told. Now it counts only people who can actually complete an open blocking slot now or once its window opens — a primary who is not the drafter, or an alternate of a slot with a timeout (judged at the window's opening), each only if `slotSignPlan` gives them that slot other than by override, as `waitsOnLiveSecondPerson` judges it; overriders never (an override is itself an exception). It still answers false on any roster without a rule satisfaction (checked first, unchanged) and changes no plan — only whether a rule-only sign-off is optional or required; the engine (`getActions`), the attention badge (`isActionRequired`, which reads it) and the panel (`TicketRosterPanel`) share it, and the route's `sign_slot` takes the upgrade either way. Pinned (mutation-checked): `dfRoundG_P26_exceptionOnly.test.ts` — the "NO DEADLOCK BEHIND THE FLOOR" case now asserts the sign-off is required, said and badged; "who can actually complete an open slot" (an overrider only → needed; a timed alternate → not needed, optional; a timed alternate or a primary the plan blocks → needed; a non-drafter primary → not needed; regression: no rule satisfaction → never needed); "the reachable stall" (the rule applied at open beside l-1; `reassign_drafter` offered in review; after it l-1 disabled by the floor, p-1 required, said and badged; p-1 upgrades, l-1 badged and completes); "STATED … OVERRIDER of a drafter-only open slot" (case (2) of (3a) pinned as stated) — and `dfRoundG_P26_exceptionRoute.test.ts` (the same through the route: the new drafter refused 403 by the floor, the upgrade taken, then the drafter's sign-off issues; the route does not read `ruleUpgradeNeeded`, so this pins agreement, not the change).
(4) **The DEC-12 floor never counts a rule satisfaction** — `lib/workflow.ts` `rosterLacksIndependentSignOff` (`:508`), `lib/consentWindow.ts` `consentFloorHolds` (`:491`), `lib/ticketPreauthorization.ts` `preauthLeavesNoSecondPerson` (`:523`); `rosterCompletion` counts it complete under its own marker (`exception-rule:<id>`, `lib/ticketRoster.ts:478`).
(5) **20261268** (DEC-30 one paste): `satisfied_via` + `'rule'` (re-created from 20261264's body), the shape CHECK's rule alternative — a BLOCKING slot naming no signer and no signature, and the signer branch no longer admits `'rule'` (re-created from 20261255's), the events + `'reopened'` (from 20261242's inline CHECK, by its default name; the append-only trigger untouched), and `exception_only_review_ready()` (SECURITY INVOKER, search_path pinned, the service role only). Each CHECK lineDiff-pinned against its newest body by a folder scan. *(Review fix:)* the probe no longer answers a bare `true` — it reads the LIVE definitions (`pg_get_constraintdef`: `'rule'` in the satisfied_via and shape CHECKs, `'reopened'` in the event CHECK), so after a regressed re-paste of 20261242 / 20261255 / 20261264 it answers false and the app satisfies no slot by a rule the ledger would refuse; the paste's own probe 4 calls it.

Tests: `lib/__tests__/dfRoundG_P26_exceptionOnly.test.ts` (the rules — opt-in placement, the plan, the exceptions, the re-open, the floors; mutation-checked), `lib/__tests__/dfRoundG_P26_exceptionRoute.test.ts` (REGRESSION FIRST — every action × status × member, and a roster with no exception-only slot opened and completed, dry run included, byte-identical with the code switched off, no probe, no key; limb 1 applied / not migrated / moved / waived / engineered; limb 2 none → issues, waiver → re-opened with history, audit, ledger and answer, moved source, override, the waiver unreadable → 503 nothing written, then the reviewer signs and it issues), `lib/__tests__/consentWindowScan.test.ts` (DF-P26 GAP-115 block — none → today's close; waiver → closed, re-opened, not issued; unreadable → retried), `lib/__tests__/dfRoundG_P26_exceptionMigration.test.ts` (shape + lineDiffs), on PostgreSQL 16 `lib/__tests__/rls/dfP26IssuingPathStops.test.ts` (re-pastes twice, every probe true; the rule's shape accepted and every other rule shape refused; signer and consent shapes unchanged; `reopened` recorded, append-only kept; the probe the service role's only; the paste hand-off — 20261264 re-pasted after drops the value AND the probe then answers false (review fix), refused as a whole once a rule satisfaction is on record, restored by re-pasting 20261268, the probe true again). Full `npm run test:db`: 38 files, 503 tests pass. Review fix: `dfRoundG_P26_exceptionOnly.test.ts` (an unread declaration is not an exception; the rule's slot signable by its primary, not its overrider; the deadlock scenario — the drafter held by the floor, the primary upgrades, the drafter completes; a slot satisfied any other way never offered again), `dfRoundG_P26_exceptionRoute.test.ts` (101 source documents → 503 nothing written, dry run too; an unreadable declaration → 503 nothing written; the rule's slot's reviewer signs it → the ledger satisfied by the person, nothing re-opened), `dfRoundG_P26_exceptionMigration.test.ts` (the probe reads the three live CHECKs, never `SELECT true`).
**A/B against the base route itself (review fix — the gap's "a real A/B sweep against the base route").** The committed sweeps compare the route with its DF-P26 helpers stubbed off, which cannot catch an unconditional change in the route body. So the same harness, WITHOUT any DF-P26 mock, was run once on the base commit `ceaa9d0` (a detached scratch worktree) and once on this branch, dumping status, answer and the full ordered call log of 1 116 cases: every action the engine offers plus `sign_slot` / `request_revision`, real and dry run, × every status × every member, with and without a source document; and rosters opened from tables with no DF-P26 opt-in (with and without a notify-only hold-recording slot) and each sign-off by every member, real and dry run. 1 112 cases are identical byte for byte; the 4 that differ are the intended `GAP-116` read — a completing sign-off (and its dry run) on a roster carrying an opted-in notify-only hold-recording slot with a source document, which now reads `document_holds` — with the status, the answer and every other call identical and in order. (A committed test cannot import the base route, so this is recorded evidence, not a pin.)

**Done-when.** ✓ the opt-in satisfied at open by a recorded system act naming the rule when no exception is on record; ✓ re-opened, in the same write as the act, on every issuing path when one is (the route's completing sign-off, its issuing approvals refused, the consent close) with a `reopened` ledger event; ✓ the CHECKs re-created from their newest bodies; ✓ never counted by the DEC-12 floor in its three homes; ✓ default off — an unconfigured workspace (and any roster without the opt-in) byte-identical (A/B sweeps); ✓ no path issues a request whose exception-only slot was rule-satisfied while an exception is on record. *Fix pass 2 (DEC-29):* the first item was overstated after the review fix — the engine then offered the rule slot's reviewer a required sign-off, badging them; it is now an optional upgrade (required only where `ruleUpgradeNeeded` says the floor would otherwise leave nobody named able to complete), and the roster-opened line, `unread_by` and the notice leave the rule slot's people out, so ✓ holds in what people see. *Fix pass 3 (DEC-29):* the item "default off" is **✓ except the committed base-route pin** — NOT DONE as written: the committed sweeps (`dfRoundG_P26_exceptionRoute.test.ts`, `dfRoundG_P26_holdStopRoute.test.ts`) compare the branch route against itself with the DF-P26 helpers stubbed off, which cannot catch an unconditional change in the route body (the `fanOut` deferred / non-deferred split) or in `lib/workflow.ts` / `lib/ticketTransitions.ts` / `lib/ticketRoster.ts`; the cross-commit A/B against `ceaa9d0` (1 116 cases, 1 112 identical, 4 the intended `GAP-116` read) is recorded evidence only. A committed golden generated from `ceaa9d0` was not added: every other package merging into the same route this round would break it on a legitimate change, so it cannot pin "unchanged from base" past this merge. **Owner (DEC-31): the drafting-flow integrator at the DF-P26 merge** — re-run the base-vs-branch A/B (the same harness with no DF-P26 mock, on `ceaa9d0` and on the merge candidate) before later route changes land, and record the result here (`99-fix-sequencing.md` DF-P26 hand-off row). Also fix pass 3: the first item's "not badged" now holds for an occupant whose upgrade an independence reason forbids (paragraph (3c)(i)), and limb 2's 503 refuses only an issuing sign-off ((3c)(ii)). *Fix pass 4 (DEC-29):* the first item's "never the engineered lane" and the last item ("no path issues … while an exception is on record") did not hold on the route while the workspace's request types could not be read (an engineering-first request was taken as not engineered by both limbs); now ✓ — unknown is "unchecked", never "not engineered" (paragraph (3d)(i)); and the consent close's limb 2 reads hold only a close that would issue ((3d)(ii)). The Status line now says RESOLVED with one remainder (the base-route pin above), which the earlier RESOLVED overstated. *Merge-time fix pass (DEC-29):* the first item did not hold in one more place — an optional upgrade of the rule's slot could take a person's real, required sign-off from them, depending on the table's slot order (an open slot independent of the rule's slot, or it of the open slot, both naming the same primary); and the last item's fail-safe refused one sign-off that had nothing left to protect (a completing sign-off upgrading every rule-satisfied slot, 503 on an unreadable read). Now ✓ — the open slots are planned first and a conflicting upgrade is dropped ((3e)(i)), and limb 2 reads and refuses only while the roster after the sign-off still carries a rule satisfaction ((3e)(ii)); paragraph (3a) "No deadlock behind the floor" is restated so that it holds as written (the upgrade is offered to every occupant of the rule's slot whom the table lets sign it — as a required sign-off where the floor would otherwise hold — and the one case left waiting is stated). The "default off" item stays **✓ except the committed base-route pin**: re-run at the merge, 1 112 of 1 116 identical, the 4 others the intended hold reads only ((3e)(iii)); owner unchanged. *Merge-time fix pass 2 (DEC-29):* (3a) as the merge-time fix pass wrote it overstated one case — `ruleUpgradeNeeded` counted any named alternate or overrider, so where the only other person named on the open slot could never act on it the upgrade stayed optional and unbadged while the drafter was held by the floor (reachable after `reassign_drafter`). Now ✓ as (3a) states it — the upgrade is required and badged wherever no one but the drafter can actually complete an open slot ((3e)(iv)) — with the two cases where the review still waits stated there (the table forbidding every occupant; an occupant who is also an overrider of a conflicting drafter-only open slot, raised to the integrator).

**Scope / residual.** Paste `20261268` after `20261264` (deploy first recommended; before the paste the rule applies nothing — every exception-only slot waits for its sign-off, today's review, and the audit row says `not_migrated`). Never re-paste 20261242 / 20261255 / 20261264 after it without re-pasting it (once a rule satisfaction is on record such a re-paste is refused as a whole, changing nothing; before that, the probe reads the live CHECKs and answers false, so the rule applies nothing new — every exception-only slot waits for its sign-off — until 20261268 is re-pasted. *Corrected by the review fix:* the first record called that state fail-safe because "the consent close holds on the ledger disagreeing"; that held only for the consent path — the route's completing sign-off does not read the ledger, and the probe answered `true` regardless. A re-open of a rule satisfaction already on the request's record when such a re-paste lands can then be refused by the ledger — reported `rosterLedgerNotWritten`, the request's own record keeping it). *Stated:* the examination-scope gate and the `GAP-116` hold stop judge "would this sign-off complete the review?" before the re-open is computed, so on a request that also lacks required examination data or carries a stopping hold they may refuse a sign-off that would only have re-opened the rule's slot (the fail-safe direction — the signer is told why and can sign once it is cleared). The re-open reads the exceptions the request records; an exception not recorded anywhere (a conversation, an email) is not seen. Files outside the plan entry: `lib/exceptionOnlyReview.ts` (new), `lib/ticketPreauthorization.ts` (the floor's third home), `types/schema.ts`, `components/documents/RoutingControlSection.tsx`, `components/requests/TicketRosterPanel.tsx`. *Fix pass 2 residual:* the frozen roster cannot see that a named occupant left the workspace, so where the only other independent occupant has left, the rule slot's reviewer is offered the upgrade as optional (it stays signable — no deadlock) rather than badged; in the needed case the slot still reads "satisfied" to the unread/release bookkeeping (`rosterPartialReleased`), so that reviewer is badged by the engine but not re-marked unread. *Fix pass 3 residual:* in the needed case, an occupant whose upgrade an independence reason forbids is no longer shown a disabled sign-off (it is not offered at all); the review then waits, as before, on whoever else may give it. On a rule roster where limb 2's reads fail, a partial sign-off is taken without re-opening the rule's slot even if an exception is on record — the completing sign-off (or the consent close) re-reads and re-opens before anything issues. *Fix pass 4 residual:* the same holds for a consent close that does not complete the review (it closes without re-opening). While the workspace's `drafting` configuration cannot be read, no exception-only slot is satisfied at open (`unchecked`) and a rule roster's completing sign-off waits (503) — a malformed request-type list in that row reads the same way until it is corrected. *Merge-time fix pass residual (stated):* an occupant of the rule's slot who is also an alternate of an open slot independent of it (that slot carrying a timeout) is not offered the upgrade before that alternate window opens — they sign the open slot once it does; and an overrider of such an open slot is not offered the upgrade (the override is in their plan) — their override, itself an exception, then re-opens the rule's slot, which waits for someone independent of the overridden slot, as the table declares; where that slot is drafter-only and they are the rule slot's only occupant who could act, the review waits with only the drafter badged (for a revision; the floor disables their sign-off) — the override is optional and never badged — (3a) case (2), raised to the integrator.

---

<a id="gap-116"></a>

## GAP-116 · A notify-only hold that stops the request, not only its document

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-102` · Decisions: `DEC-90`, `DEC-31`

*Opened 2026-10-22 by drafting-flow Round G, DF-P25 review fix pass 5 (the reviewer's major on `GAP-102` ruling (6)).* `GAP-102` ruling (2)'s notify-only limb gives the slot's people a hold on the request's SOURCE document, which carries what they examined. That hold stops work on the document (no new revision is published — `lib/documentGuards.ts`; it is not transmitted or shared — `lib/holdGate.ts`). It does NOT stop the request: nothing on the request's issuing path reads holds on its source document (the workflow route reads `document_holds` only at close, and only for holds whose `origin_ticket_id` is the request — `app/api/tickets/workflow-action/route.ts:1521`; the notify-only hold has no `origin_ticket_id`, so that it outlives the close). The request can still complete its roster and issue the deliverable while the hold is in force. DF-P25 made every sentence say so (`GAP-102` paragraph (9)) and did not build the stop, because it needs the issuing path DF-P25 does not hold.

**Owner (DEC-31):** drafting-flow **DF-P26 ISSUING-PATH STOPS** (with `GAP-115`; same files).

**What remains.** On `ISSUING_APPROVALS` and a completing `sign_slot` in the workflow route — and on the consent window's close that would issue — refuse with 409 while an open (`released_at IS NULL`) `document_holds` row exists on the request's source document whose `examination->>ticketId` is this request and whose opener passes `holdOpenerInSlot` (`lib/assuranceExamination.ts`) for the round it names; the refusal names the hold and who can release it. Fail closed on an unreadable hold read, as `lib/holdGate.ts` does. Then the panel's sentences may call it a stop of the request again.

**Acceptance.** A/B: no such hold → byte-identical behaviour on every issuing path (pinned); a hold placed by a person who is not the slot's → no refusal; a released hold → no refusal.

**Status → RESOLVED (2026-10-22, drafting-flow Round G) — DF-P26 ISSUING-PATH STOPS (DEC-90 ruling (2) for DF-P26; calls in `DEC-44 (DF-P26-issuing-path-stops)` items 9–10). No database change.**

**Resolution.** Reproduced on `ceaa9d0`: the route's only `document_holds` reads ran at close by `origin_ticket_id`; `lib/workflow.ts`, `lib/ticketTransitions.ts` and `lib/consentWindowScan.ts` read no holds — a notify-only hold left the request free to issue. Now `lib/requestHoldStop.ts` (new): with a roster on record carrying a notify-only hold-recording slot and a source document (`holdStopScope`), it reads the OPEN holds on that document whose record names THIS request (`examination->>ticketId`, `released_at IS NULL`, filtered in the query; *fix pass 4:* every page of them, keyset on the hold's id — before, only the first 100) and keeps those whose opener is one of the named slot's people in the round the record names (the roster on record, else the roster ledger for an earlier round — `holdOpenerInSlot`); opener names come from the member list. **The route** (`route.ts:1081`–`:1094`, after the examination-scope gate): on `ISSUING_APPROVALS` and on a `sign_slot` that would complete the review (`issueHoldStopGate`; a sign-off that leaves the review open is not stopped), such a hold refuses 409 `request_on_hold` with a plain sentence (`requestHoldRefusal`: the document, the reason, who placed it for which slot, that it stops this request until released, who can release it) and `holds: [{ id, reason, slot }]` — the dry run too; nothing written; a real sign-off's signature is recorded as refused. **The consent close** (`lib/consentWindowScan.ts:1141`): the window is NOT closed while such a hold is in force (nothing written, said in the run's lines, checked again every run); released, the next run closes it. **Unreadable** (any read error where a record could exist, or a full page with no stopping hold found) → 503 `request_hold_unreadable` on the route ("try again"), a failed-and-retried close on the cron — never a pass; before 20261267 (42703 / PGRST204 naming `examination`) no hold can carry a record, so nothing stops. **Document Control's forced publish** of the source document is unchanged (`lib/documentGuards.ts` untouched) — the stop is on the request's issuing path, not a new rule on the document. **Wording:** the panel says the hold now stops the request (`components/requests/NotifyHoldExamination.tsx` `HOLD_STOPS_REQUEST` replaces `HOLD_DOES_NOT_STOP_REQUEST`: "… A hold that records what you examined also stops this request: while it is in force the review cannot complete and the deliverable cannot be issued. Releasing the hold lets the request go on."), as does the routing editor's `NOTIFY_EXAMINATION_HINT` ("… a hold that records what they examined stops the request too … (a hold placed without that record — before the database update 20261267, or when the record is too large — stops work on the document only)"); the comment in `lib/routingControl.ts` follows. *(DF-P26 review fix — the first wording said unconditionally that the hold stops the request; a hold that lands WITHOUT its record (before 20261267, or refused for size, 23514) names no request and is never matched, so that was false for it.)* Both "record not stored" messages now end with `HOLD_WITHOUT_RECORD_DOES_NOT_STOP_REQUEST`: "Without that record this hold stops work on the document only — it does not stop this request; raise it with the assignment queue to stop the request." (`HOLD_RECORD_NOT_STORED`, `HOLD_RECORD_TOO_LARGE`).

Tests: `lib/__tests__/dfRoundG_P26_holdStopRoute.test.ts` (REGRESSION FIRST — every action × status × member with and without the slot, byte-identical with the stop switched off and no hold read; a stopping hold → 409 on the issuing approval, the completing sign-off and its dry run, nothing written, the signature recorded refused; not the slot's opener / released / another request / a partial sign-off → proceeds; unreadable → 503; before 20261267 → proceeds), `lib/__tests__/consentWindowScan.test.ts` (DF-P26 GAP-116 block — held: not closed, nothing written; released: the next run issues; not the slot's opener → issues; unreadable → retried; before 20261267 → issues; no slot / no source / a close that does not issue → no hold read), `lib/__tests__/dfRoundG_P25_notifyHold.test.ts` (the wording pins changed with intent: the hint and the intro now say a hold that records what was examined stops the request; review fix: both record-not-stored branches — before 20261267 and too large — render the sentence that the hold does not stop this request).

**Done-when.** ✓ a hold of the slot's people carrying this request's record refuses `ISSUING_APPROVALS` and a completing `sign_slot` with 409 and a plain sentence, and holds the consent close that would issue; ✓ release lets it proceed; ✓ unreadable → 503 / retried; ✓ not the slot's person, released, or another request's record → no refusal; ✓ no such slot or source → byte-identical, no read (A/B); ✓ Document Control's forced publish unchanged; ✓ the panel and the editor say it stops the request — qualified by the review fix: they say a hold *that records what was examined* stops it, and a hold placed without its record is told, on the spot, that it stops work on the document only and does not stop this request (the first wording was unconditional and wrong for such a hold). *Fix pass 2 (DEC-29):* that wording was still overstated where the routing changed between rounds — the stop was scoped to the CURRENT roster carrying the opted-in slot, so a round-1 hold stopped nothing once the controller dropped the opt-in. Now a roster opened while the roster on record (the previous round) carried such a slot — or already carried the mark — carries `notifyHoldRecordsEarlier` (`lib/requestHoldStop.ts` `carryNotifyHoldMark`, called where the route opens a roster; `couldHoldNotifyRecord` is the scope), so the earlier round's hold, judged against that round's ledger rows, keeps stopping the request and the wording holds; a roster whose earlier rounds carried no such slot gets no key and reads nothing (pinned: `dfRoundG_P26_holdStopRoute.test.ts` "a hold placed in an earlier round keeps stopping the request…", round 2 refused 409, released → issues, the mark carried into round 3, regression arm with no key and the same object back). *Fix pass 3 (DEC-29):* that still did not hold in a round whose roster planned a consent window — the route rebuilt the roster from `opened.roster` when it attached the consent plan (`rosterOpen = { ...opened.roster, consentPlan }`), dropping the mark carried just before, so in that round an earlier-round hold stopped neither the completing sign-off nor the consent close. Now the consent branch builds on the roster as it stands (`{ ...rosterOpen, consentPlan }`, `route.ts`). Pinned (mutation-checked): `dfRoundG_P26_holdStopRoute.test.ts` "the earlier-round hold mark survives a round whose roster plans a consent window" (round 2 under a table with a confirmed consent slot and no notify opt-in: the stored roster carries the plan and the mark; the round-1 hold refuses the completing sign-off and its dry run 409; released → issues) and `consentWindowScan.test.ts` "a roster that plans a consent window and carries the earlier-round mark" (the close held by the round-1 hold, judged against that round's ledger row; released → issues). *Fix pass 4 (DEC-29):* "a hold placed by someone outside the slot is not refused" held per hold but not in number — 100 or more such holds made every issuing path 503 / the window unclosed; now ✓ — every page is read and judged (Scope / residual). Pinned (mutation-checked): `dfRoundG_P26_holdStopRoute.test.ts` "holds by people outside the slot never make the request unreadable, however many" (150 outsiders' holds → clear, both pages read; exactly one full page → clear; the slot person's hold on the second page behind 120 outsiders' still stops, named oldest first; a store that does not page forward → unreadable).

**Scope / residual.** The stop reads the record's request id and the opener's place in the named slot; a hold placed WITHOUT a record (a plain hold on the source document) is not a stop of the request — as before, it stops work on the document. A hold on a document the request does not name as its source is not read. *Corrected by fix pass 4 (DEC-29):* the first record treated more than 100 open recorded holds naming the request as unreadable (503 / retried) — so anyone allowed to place holds on the source document, in the slot or not, could block every issuing act by placing 100 holds naming the request, although none of them is a stop. Now every open hold naming the request is read page by page (`lib/requestHoldStop.ts` `requestHoldStop`, keyset on `id`, `REQUEST_HOLD_READ_LIMIT` per page) and each is judged; only a store that does not page forward, or more than 10 000 such holds (`REQUEST_HOLD_PAGE_CAP` pages — a runaway guard), is unreadable. Files outside the plan entry: `lib/requestHoldStop.ts` (new), `components/requests/NotifyHoldExamination.tsx`, `components/documents/RoutingControlSection.tsx`. *Fix pass 2:* a request whose earlier round carried the slot but whose roster on record was replaced before this change (no mark, no opted-in slot) is not carried — only rounds opened from now on carry the mark; `types/schema.ts` `TicketReviewRoster.notifyHoldRecordsEarlier` is new.

---

## Already built — do not build these twice

| Looks missing | Actually |
|---|---|
| **A parallel review roster with signatures, alternates and auto-finalize** | **Built** — `lib/reviewControl.ts`, on the document side. `GAP-103` is about reaching it from the ticket, not writing it. |
| **Plain-English status explanations** | **Built twice** — `attentionLabel` and `WorkflowDiagramModal`. `GAP-108` routes them to the right surfaces. |
| **Per-request-type SLA defaults** | **Built** — `lib/notifications.ts:237-243`. `GAP-106` is about nothing reading them. |
| **Queue routing by role pool with fallback** | **Built** — `lib/ticketRouting.ts`. `LEAK-1` is about the workflow route never calling it. |
| **A per-person delegation with expiry** | **Built** — `capabilityPolicy.UserGrant`. `GAP-102` uses it rather than adding a role. |
| **Container-chain rule inheritance** | **Built** — `docClass` and `review_control` both resolve document → folder → library. `GAP-101` and `GAP-104` reuse the pattern. |
| **Triage-first routing to the drafting supervisor** | **Built and working.** `GAP-101` adds one field to a step that already exists. |

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
