# 90 · Gap register — build specs

> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T00:30:00Z

**15 capabilities the system needs and does not have.** Six were stated
requirements from the system's owner; the rest were found during the audit —
things the code reaches for and cannot do.

**These are build work.** Each entry is a spec: a verdict, a scope, a design
direction, its dependencies, its acceptance criteria, and a `Do not` list naming
the specific wrong turn an implementing agent would otherwise take.

> Held to the same evidence bar as findings — see [`../README.md`](../README.md)
> and `DEC-29`. Build order is in
> [`99-fix-sequencing.md`](./99-fix-sequencing.md). Several of these are scoped
> **deliberately narrower** than the original requirement; each says what was cut
> and why.

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-1](#gap-1) | Approval authority per request type | **BUILD** | L | `WF-15`, `DEC-13` |
| [GAP-2](#gap-2) | Nobody approves their own work | **BUILD_NARROW** | M | `DEC-12` |
| [GAP-3](#gap-3) | Owner delegates a specific file | **BUILD** | M | `DEL-1`, `DEC-6` |
| [GAP-4](#gap-4) | Ownership means being the approver | **BUILD_NARROW** | M | `OWN-11`, `DEC-21` |
| [GAP-5](#gap-5) | Owner succession and a real no-owner state | **BUILD** | M | — (blocks `SURF-1`) |
| [GAP-6](#gap-6) | The ticket → document hand-back | **BUILD** | L | `LIFE-2`/`DEC-23` **first** |
| [GAP-7](#gap-7) | Markup as a durable artifact | **BUILD_NARROW** | M | — |
| [GAP-8](#gap-8) | Multi-sheet source documents | **BUILD_NARROW** | S | `LIFE-4` |
| [GAP-9](#gap-9) | Field-verification currency | **BUILD_NARROW** | S | `LIFE-10` |
| [GAP-10](#gap-10) | A first-class hand-off record | **DECLINE** | — | — |
| [GAP-11](#gap-11) | Document declares downstream approval requirements | **FOLD_INTO_FINDING** | — | `LIFE-5`, `LIFE-12` |
| [GAP-12](#gap-12) | Library ownership admin surface | **BUILD → BUILT** `98a65d5` | S | — |
| [GAP-13](#gap-13) | Triage rejection taxonomy | **BUILD_NARROW** | S | — |
| [GAP-14](#gap-14) | "Profiles" instead of role stacking | **FOLD_INTO_FINDING** | — | `WF-1`, `GAP-1`, `GAP-3` |
| [GAP-15](#gap-15) | Ownership carries read access | **BUILD** | S | `DEC-7` |

**Verdict meanings.** `BUILD` — build as specified. `BUILD_NARROW` — build the
reduced version described in Scope; the cut parts are stated and are not to be
built. `FOLD_INTO_FINDING` — the requirement is met by fixing named findings; do
not build a separate feature. `DECLINE` — do not build; the alternative is
stated.

---

<a id="gap-1"></a>
## GAP-1 · Only certain people can approve certain types of requests

**Verdict: BUILD** · Effort: **L** · Depends on: `WF-15`, then `DEC-13`

> *"The issue mostly is that in the drafting work flow only certain people can
> approve certain types of requests."*

### Scope

**In:** a resource dimension on the capability evaluator, so an org can express
"ASBUILT requests may only be approved by DocCtrl" and have it enforced
server-side and at the database.

**Out (deliberately):** per-discipline reviewers ("electrical → an electrical
engineer"). That needs a discipline taxonomy that does not exist, and the
`resource` shape below leaves room for it later without committing to it now.

### Design

Three stages, each independently shippable. **Do not start at stage 2.**

**Stage 1 — make request types real (`WF-15`).** `RequestType` is
`export type RequestType = string` (`types/schema.ts:1019`), unvalidated, and it
gates a terminal transition (`close_rfi`, the only `DRAFTING → CLOSED` edge).
Validate `request_type` at insert against the org's configured list. Nothing else
here is safe until types are trustworthy — a new authority dimension keyed off
unvalidated free text is worse than no dimension.

**Stage 2 — widen the signature.** `policyAllows(policy, cap, subject, resource?)`
where `resource` carries `{requestType, unit, libraryId, discipline}`. Make
`caps` entries `{tokens: string[], when?: {requestType?: string[], unit?: string[]}}`.
An absent `when` behaves exactly as today, so every shipped default stays
byte-compatible and no org that has configured nothing changes behaviour.

**All four call sites move together** or `WF-7`'s divergence gets worse:
`lib/workflow.ts:65`, `lib/holds.ts:100`,
`components/permissions/ViewAsSimulator.tsx:128`, and the SQL
`org_capability_allows`.

**Stage 3 — make the hardcoded gate configurable.** Add
`requests.requires_engineer_approval` as a real capability. Today
`requiresEngineerApproval` (`lib/workflow.ts:37-43`) is hardcoded and consults no
capability at all, so an org that removes `Manager` from `ticket.manage` still
lets Manager requesters self-approve.

### Do not

- **Do not add roles to express this.** That is what produced 19 roles. The
  capability layer is the right chassis; it is missing one argument.
- **Do not build stage 2 before stage 1.** Authority keyed to an unvalidated
  string is a hole, not a feature.
- **Do not move the four call sites separately.** The simulator and the enforcer
  disagreeing is already `WF-7`; doing this piecemeal makes it worse.
- **Do not extend `CapabilityId` with per-type variants** (`ticket.approve_asbuilt`,
  …). That is the combinatorial explosion the resource dimension exists to avoid.

### Acceptance

1. An org can express "ASBUILT may only be approved by DocCtrl" and it is
   enforced in `getActions`, re-enforced in
   `app/api/tickets/workflow-action/route.ts`, and honoured by
   `org_capability_allows`.
2. An org that has configured no `when` clause behaves byte-identically to today.
3. `ViewAsSimulator` reports the same answer the route enforces for a
   resource-scoped capability.
4. A ticket cannot be created with a `request_type` outside the org's configured
   list.

**Related findings:** `DRAFT-1`, `WF-13`, `WF-15`, `WF-8`.

---

<a id="gap-2"></a>
## GAP-2 · Nobody approves their own work

**Verdict: BUILD_NARROW** · Effort: **M** · Depends on: `DEC-12`

**Status: RESOLVED (2026-09-01, roles-and-permissions Phase 4).** Built exactly to this spec on the DEC-12 shape (threshold = ≥ 3 active members, derived — never a toggle), reconciled with DEC-37: independence is a property of the SLOT (one deliverable's producer cannot be its checker), which is precisely what the three predicates express, so multi-hat people are unaffected except where they are producer-and-checker of the same deliverable. All three predicates live in `getActions` (`separationOfDutiesActive`, `producerIsChecker`, the self-requester `self_assign` case) AND are re-checked in the workflow-action route (engineer-pick exclusions: requester / drafter / caller; assignment exclusions: requester, plus the `ticket.draft_work` authority check). Every "Do not" honored: blocked actions render DISABLED with "needs a second person" (`disabledReason` travels engine → button, engine → route 403, same words); nothing enforces below 3; the picker filter (`independentOf` in `EngineerPickerModal`, with explanatory empty state) is UI convenience layered OVER the route refusals, not instead of them. Acceptance: (1) ✓ 5-member org — self-assign-as-drafter on own request refused server-side (403) and rendered disabled; self-pick as engineer refused (403) and filtered; (2) ✓ 2-member org — the single-person loop completes (passthrough test); (3) ✓ blocked actions carry the explanation. The document-side counterpart (`DEL-5`/`DEC-21`) remains its own item in Phase 6. Tests: `lib/__tests__/workflow.test.ts` (GAP-2/DEC-12 describe, 6 cases), `lib/__tests__/rpPhase4Migration.test.ts` (route pins). Files: `lib/workflow.ts`, `app/api/tickets/workflow-action/route.ts`, `components/requests/EngineerPickerModal.tsx`, `app/(protected)/requests/[id]/page.tsx`.

### Scope

**In:** the three ticket-side predicates from `DEC-12` — assigned drafter ≠
requester, approver ≠ assigned drafter, assigned engineer ∉ {requester, caller} —
enforced when the org has three or more active members.

**Out (deliberately):** a configurable per-org toggle. `DEC-12` derives the rule
from active member count instead, because a toggle defaulting off is a control
nobody sets and one defaulting on is a control people switch off. Revisit only if
a real customer above the threshold needs an override.

**Out:** quorum / N-of-M approval. The evaluator is boolean and has no counting;
adding quorum is a separate project with no stated requirement behind it.

### Design

Evaluate the predicates in `getActions` (`lib/workflow.ts`) **and** re-check them
in `app/api/tickets/workflow-action/route.ts:113-132`, which already validates the
engineer pick and is the natural home. Count `org_members` where
`status='active'`.

The document-side counterpart is `DEL-5` / `DEC-21` — an owner can currently be
the sole reviewer of their own revision, because the review-completion guard
counts signed primaries without checking who they are. Same gap, different
subsystem; both need doing.

### Do not

- **Do not make a blocked action disappear.** A missing button is
  indistinguishable from a bug. Render it disabled with "needs a second person".
- **Do not enforce below the threshold.** A two-person shop has nobody to route
  to, and breaking them on upgrade is a worse outcome than the loop.
- **Do not filter the engineer picker only in the UI.** `EngineerPickerModal`
  listing the current user is half the defect; the route accepting them is the
  other half (`WF-14`).

### Acceptance

1. In a 5-member org: a Manager cannot assign themselves as drafter on their own
   request, and cannot pick themselves as engineer. Both refused server-side, not
   only hidden.
2. In a 2-member org: the existing single-person loop completes end to end.
3. A blocked action renders an explanation.

**Related findings:** `WF-4`, `WF-14`, `DEL-5`.

---

<a id="gap-3"></a>
## GAP-3 · A library owner delegates a specific file

**Verdict: BUILD** · Effort: **M** · Depends on: `DEL-1`, `DEC-6`

**Status: RESOLVED (2026-09-01, roles-and-permissions Phase 6, with DEL-1).** Built on the existing carrier — no new mechanism. (1) The drawer's authority is computed at each mount as controller OR the node's effective owner OR a `managePermissions`/`admin` allow on its chain (`canWithAclChain`, mirroring `can_manage_node`); non-controllers edit in **delegation mode**. (2) Bounds: allow-only, actions limited to the delegable set (never `admin` or `managePermissions`), and an expiry is REQUIRED — enforced in the drawer and, for the admin/managePermissions bound, at the database (`acl_index_grants_admin_beyond` per subject bucket in `documents_guard_access_change`; the folder policy's WITH CHECK). The drawer now builds the index expiry-aware (`buildAclIndexFromChain(chain, Date.now())`) so an already-expired rule never bakes into `acl_index`; the nightly rebuild (`DB-4`/`DEC-10`) retires grants that expire later. (3) Folder-level delegation is possible at the database: `collections_update_controllers` admits controller OR folder owner OR manage-grant (`20261044`). "Do not" honoured: delegation is a rule with an expiry, never an ownership transfer; `UserGrant` is untouched; owners cannot grant `admin`; expiry cannot be skipped. Acceptance: (1) ✓ the effective owner adds `allow / user / publish+write` with an expiry and saves (DB owner arm); (2) ✓ a plain member cannot (not owner, no grant → drawer read-only and DB refuses); (3) ✓ the delegate publishes while live; expiry is honoured by the evaluators and the index rebuild (the write-time index already drops expired rules); (4) ✓ every save writes `NODE_ACL_CHANGED` naming the actor (existing); (5) ✓ no `admin`/`managePermissions` from an owner (drawer + DB bound). Migration `20261044` pending operator paste.
- Migration: `20261044` — **applied & verified live 2026-09-02** (7/7; inventory 0 / 0 / 33 / 691). Pre-flight correction: the folder-level admin-grant bound is a BEFORE UPDATE trigger (`collections_guard_access`), not a policy disjunct — see `DEL-1` for why the disjunct was unenforceable.

> *"Library owners need to be able to assign people from their team or just a
> profile if not using teams to delegate a specific file."*

### Scope

**In:** an effective owner can grant one named person — or one team — a
time-boxed `publish` / `write` grant on a single document, without transferring
ownership and without becoming an Admin.

**Out (deliberately):** delegation chains (A delegates to B, B to C). `UserGrant`
has `grantedBy` but no transitivity and no depth limit; chains need cycle
detection and an expiry-inheritance rule, and nobody has asked for them.

### Design

**The carrier already exists and is the right shape.** Do not invent a mechanism.
`PermissionSubjectType = "user" | "team" | "role" | "org"` (`types/schema.ts:96`),
`AccessRule.expiresAt` (`types/schema.ts:107`), `subjectMatches` handles user and
team symmetrically (`lib/acl.ts:67-78`), and the database honours user and team
grants identically (`20260812:65-85`). `can_manage_node`
(`20260816:72-76`) **already honours a `managePermissions` grant** — that path
simply has no client consumer.

The work is three things:

1. **Give the drawer a real authority input.** All three instantiations pass
   `canEdit={isController}`. Compute it once, next to the existing `canPublish`
   memo, as *controller, or effective owner of this node, or holder of a
   `managePermissions`/`admin` allow on this node's chain* — the last clause is
   `canWithAclChain({ principal, action: "managePermissions", aclChain, defaultAllow: false })`,
   which exists in `lib/permissions.ts:22-42` and already mirrors `can_manage_node`.
2. **Bound what a non-controller may grant.** An owner may grant only actions they
   themselves hold, never `admin`, and owner-issued rules **must** carry an
   expiry. Without this, delegation is a fresh escalation path.
3. **Make folder-level delegation possible at all.** `collections_update_controllers`
   is controller-only, so even a fixed client cannot delegate at the folder level.
   Extend it with an `OR can_manage_node(acl_index, org_id)` clause rather than
   replacing it.

### Do not

- **Do not implement delegation as ownership reassignment.** That is what exists
  today and it is a *transfer*: `user_is_effective_owner` returns
  `p_doc_owner = p_uid` and stops, so an explicit document owner **replaces** the
  library owner. The owner loses their own authority over the file they delegated.
- **Do not use `capabilityPolicy.UserGrant` for this.** Its `CapabilityId` union
  contains no document or library capability and no node scope. It structurally
  cannot say "this person, this file", and bending it to fit means a second ACL.
- **Do not let an owner grant `admin`.** That is a self-escalation path dressed as
  delegation.
- **Do not skip the expiry requirement.** An unbounded owner-issued grant is
  invisible six months later — nothing lists per-document grants.

### Acceptance

1. The effective owner of a document opens its Permissions drawer, adds
   `allow / user / publish+write` with an expiry, and saves.
2. A plain member on the same document still cannot.
3. The delegate can publish while the rule is live; the database refuses them
   after it expires (this requires `OWN-7` / `DEC-10` — the index discards
   expiry today).
4. Every owner-issued save writes a `NODE_ACL_CHANGED` audit row naming the owner
   as actor.
5. An owner cannot grant an action they do not hold, and cannot grant `admin`.

**Related findings:** `DEL-1`, `OWN-19`, `OWN-7`, `DOCACL-*`.

---

<a id="gap-4"></a>
## GAP-4 · Ownership means being the approver of revision and supersession

**Verdict: BUILD_NARROW** · Effort: **M** · Depends on: `OWN-11`, `DEC-21`

> *"Setting ownership means they are the approval of revision and superseding —
> they control the library along with admin."*

### Scope

**In:** an optional owner slot on `ReviewControl`, so a library can require its
effective owner to sign before a revision publishes. Applies **only to rosters
opened after the change.**

**Out (deliberately):** retrofitting in-flight drafts. Adding a required signer
to a roster that is already part-signed changes `requiredPrimaries` mid-review and
would strand approvals. Gate on roster creation date.

**Out:** making ownership *automatically* imply approval everywhere. It is a
per-library policy, not a global rule — some libraries legitimately want an owner
who executes but does not sign.

### Design

Add an owner slot to `ReviewControl` (`types/schema.ts:191-210`, which today has
`reviewerIds` / `reviewerRoles` / `reviewerTeamIds` and no owner concept) and to
`openReviewRoster` (`lib/reviewControl.ts:196-238`, which notifies the owner on
roster gaps but never rosters them).

This changes `reviewCompletionForDraft`'s `requiredPrimaries` count
(`lib/reviewControl.ts:363-369`) **and** the database completion gate
(`20260822:46-58`, which counts `slot = 'primary'` rows). Both move together.

**Fix `OWN-11` first, independently of this gap.** Whether an approved draft
auto-publishes currently depends on *which reviewer happens to sign last* — an
Engineer signs last and the trigger refuses; a DocCtrl signs last and it publishes
instantly. Same document, same roster, different outcome. That is a bug and it
gets fixed whether or not this gap is ever built.

### Do not

- **Do not add the owner to existing open rosters.** Gate on creation date.
- **Do not make this global.** Per-library policy.
- **Do not conflate it with `DEC-21`** (reviewer independence). Independence says
  *the publisher cannot be the only signer*; this says *the owner must be a
  signer*. They compose but they are different rules.

### Acceptance

1. A library configured owner-must-approve opens rosters that include the
   effective owner as a required primary.
2. Rosters opened before the change are unaffected and still complete.
3. `OWN-11` holds separately: a completed roster produces the same publish
   outcome regardless of signing order.

**Related findings:** `OWN-11`, `DEL-5`.

---

<a id="gap-5"></a>
## GAP-5 · Owner succession and a real "no owner" state

**Verdict: BUILD** · Effort: **M** · **Blocks `SURF-1` / `DEC-20`**

**Status: RESOLVED (2026-09-01, roles-and-permissions Phase 6, shipped with SURF-1/DEC-20).** All three parts: (1) membership-aware resolvers in ONE place per layer — `resolveEffectiveOwner(…, activeUids)` / `effectiveOwnerForDocument` in the app, `user_is_effective_owner` in the database — fall-through to the next level and finally null; (2) the sweep on removal lives INSIDE the revocation RPC (`revoke_member`), which nulls owner columns and team supervision, writes `OWNER_CLEARED` audit rows, and the app notifies controllers with the list of what became unowned; (3) the database mirror is the same rule (`member_is_active` at every rung). "Do not" honoured: nothing is reassigned; the TypeScript and SQL resolvers agree; the routers key on a resolver that now returns null for an unreachable owner. Acceptance: (1) ✓ removing an owner of a library, folder and document clears all three with one audit row each, surfaced under the register's unowned count; (2) ✓ the next review-due notice routes to Admin/DocCtrl (resolver falls through; `reviewCycles` passes the active set); (3) ✓ a re-added account regains nothing (ownership was cleared, not parked); (4) ✓ a deactivated owner is never the effective owner (suspend leaves the columns but the resolver ignores inactive members). Tests: `lib/__tests__/rpPhase6Additive.test.ts`, `lib/__tests__/rpPhase6Migration.test.ts`. Migration `20261042` pending operator paste.
- Migration: `20261042` — **applied & verified live 2026-09-02** (7-point probe all true; inventory all zero).

### Scope

**In:** ownership resolution that requires an active membership; an ownership
sweep on member removal; a visible unowned state.

**Out:** automatic reassignment to a manager. Silent reassignment is worse than a
visible gap in a regulated system — a document with no owner is an actionable
signal; a document owned by someone who never agreed to own it is a false record.

### Design

Ownership is currently a dangling uuid: the owner columns are bare `UUID` with
**no foreign key** (`20260630_document_ownership.sql:9-14`), and
`user_is_effective_owner` performs **no membership or status check at all**.

Three parts:

1. **Make the resolver membership-aware.** The effective owner is the most
   specific `owner_user_id` **that resolves to an active `org_members` row**,
   otherwise fall through to the next level and ultimately to null. This belongs
   in one place — see `OWN-16`, which found six divergent implementations, three
   of which already ignore the team rung.
2. **Sweep on removal.** In the same route as the membership delete: null the
   owner columns and any `teams.supervisor_user_id` they held, write
   `OWNER_CLEARED` audit rows, and notify controllers with a list of what just
   became unowned.
3. **Mirror the rule into `user_is_effective_owner`** so the database agrees with
   the application.

**This must ship with `SURF-1` / `DEC-20`.** Today removal is a silent no-op, so
the dangling-owner problem is latent. Making revocation work makes it live.

### Do not

- **Do not reassign silently.** Clear, audit, and notify.
- **Do not fix only the TypeScript resolver.** The database has its own definition
  and the two must agree, or the app and the publish guard will name different
  people (`DEL-9`).
- **Do not forget the notification routers.** `lib/effectiveDate.ts:81`,
  `lib/reviewControl.ts:315`, `components/documents/CheckInPanel.tsx:398` and
  `lib/acknowledgments.ts:470` all use `owner.userId ? [owner] : controllers` —
  keyed on the owner *existing*, not on being *reachable*. A stale owner actively
  **suppresses** the controller fallback.

### Acceptance

1. Removing a member who owns a library, a folder and a document clears all
   three, writes one audit row per cleared scope, and surfaces them under
   `/register`'s unowned count.
2. The next review-due notice for those documents routes to Admin/DocCtrl.
3. A re-added account does not regain any prior ownership.
4. A deactivated owner is never the effective owner for an authority decision.

**Related findings:** `OWN-12`, `OWN-16`, `DEL-3`, `SURF-1`.

---

<a id="gap-6"></a>
## GAP-6 · The ticket → document hand-back

**Verdict: BUILD** · Effort: **L** · ⚠ **`DEC-23` must land first**

**Status: RESOLVED (2026-09-02, roles-and-permissions Phase 7 build 4 / Round C2).** Built exactly to this spec on the `DEC-22` shape. Offered when the ticket carries `metadata.source_document.id` and a `Final` attachment, to a caller satisfying library publish authority (`resolveCanControlLibrary`) or effective ownership — the pair `authorizePublish` re-checks — never `ticket.manage`. Pre-seeds the existing rev-up flow (the Final file, `issue_type` per `DEC-26`, the MOC position from `metadata.moc` per `LIFE-5`, a change log naming the ticket, `relatedTicketId`) and calls `revUpDocument` unchanged. "Do not" honoured: `related_ticket_id` is written only now that `DEC-23` has deleted the waiver (`20261049` makes the publish contract write it); no part of the publish path is reimplemented (`/api/tickets/handback` only records an outcome it can prove — the version row must carry the ticket as provenance); `runPostPublishSideEffects` fires because it is the same call; the gate is library publish authority. Acceptance: (1) ✓ `document_versions.change_log` names the ticket and `related_ticket_id` is set (post-`DEC-23`); (2) ✓ refused by `assertCanPublishRevision` when a hold is active — it is a `revUpDocument` call; (3) ✓ `runPostPublishSideEffects` fires; (4) ✓ a `mode: "require"` library opens the reviewer roster (`submitForReview`, same modal path; the ticket records "submitted for document review"); (5) ✓ closing with a source document and no revision leaves `metadata.deliverable.state = "not_in_register"` (+ history + close notification), shown on the card. Out of scope as specified: auto-publish on close; multi-document hand-back (`GAP-8`). Tests: `lib/__tests__/sweepRoundC2.test.ts`. Migration `20261049` — **applied & verified live 2026-09-02** (4/4).

> *"If someone checks out a P&ID and marks it up it needs to be as-built then
> sent the file to drafting request to be added."*

The outbound half is built and built well. *"To be added"* does not exist:
`close_ticket` is three lines (`lib/ticketTransitions.ts:284-287`), and the only
document-side effect of closure in the entire codebase **deletes** the drafter's
`document_intents` row. The corrected drawing lives on as an attachment to a
closed ticket while `DOC-123` still says Rev 3.

### Scope

**In:** an explicit, authority-gated "Publish as revision of DOC-xxx" action on
the ticket, per `DEC-22`.

**Out (deliberately):** auto-publish on close. It bypasses the publish guard, the
MOC gate and the review gate in one move, on exactly the documents where those
matter most.

**Out:** multi-document hand-back. `source_document` is single-valued — see
`GAP-8`.

### Design

Offered when a ticket carries `metadata.source_document.id` and a `Final`
attachment, to a caller satisfying `canPublishOnLibrary` **on that document's
library** — not to whoever can close tickets. Closing a ticket and publishing a
controlled revision are different powers.

Pre-seed the existing rev-up flow: the Final file, `issue_type` per `DEC-26`
(`"As-Built"` when `request_type === "ASBUILT"`), the MOC reference from
`metadata.moc` (`LIFE-5`), and a change log naming the ticket number. **Then call
`revUpDocument` and let it do everything else.**

Where the hand-back does *not* happen, the ticket must at minimum tell the
requester at closure that the document is still un-revised.

### Do not

- ⚠ **Do not set `related_ticket_id` before `DEC-23` lands.** It currently
  **waives the document review gate** (`lib/reviewControl.ts:60`) and no code path
  writes it — the column is NULL in every row that has ever existed. An agent
  building this will naturally set it for provenance and thereby silently disable
  required reviewer sign-off on every ticket-originated revision, including P&ID
  as-builts. This is the single most dangerous trap in this audit. After `DEC-23`
  removes the waiver, writing the column is correct and valuable.
- **Do not reimplement any part of the publish path.** Route through
  `revUpDocument`. A second publish path is how `lib/postPublish.ts` came to exist
  in the first place.
- **Do not skip `runPostPublishSideEffects`.** It fans out supersede notices,
  work-package pin-drift alerts, revision-impact warnings, resets the review
  cycle, opens a fresh acknowledgment roster and recomputes retention. **A
  ticket-originated publish that skips it is a revision nobody has to
  acknowledge.**
- **Do not gate on ticket authority.** `canPublishOnLibrary`, not
  `ticket.manage`.

### Acceptance

1. Publishing from a ticket produces a `document_versions` row whose `change_log`
   names the ticket and whose `related_ticket_id` is set (post-`DEC-23`).
2. That publish is refused by `assertCanPublishRevision` when a hold is active,
   exactly as a manual publish is.
3. `runPostPublishSideEffects` fires — verified by a fresh ack roster and a
   supersede notification.
4. A ticket-originated revision in a `mode: "require"` library still opens a
   reviewer roster (`document_review_signoffs` count > 0).
5. Closing a ticket with a source document and no resulting revision leaves a
   visible, queryable "deliverable not yet in the register" state.

**Related findings:** `LIFE-1`, `LIFE-2`, `LIFE-5`, `LIFE-6`, `LIFE-11`.

---

<a id="gap-7"></a>
## GAP-7 · Markup as a durable, addressable artifact

**Verdict: BUILD_NARROW** · Effort: **M** · Design settled by `DEC-24`

**Status: RESOLVED (2026-09-02, roles-and-permissions Phase 7 build 1 / Round C4).** Built to this spec on the `DEC-24` shape and no wider. In: server-side persistence of viewer markup as normalized per-page fabric JSON, keyed to `(document_id, version_id, user_id)` with `checkout_session_id` as provenance (`document_markups`, `20261051`), saved as the user moves between pages and on close, restored on reopen. Out, as specified: no collaborative markup, no versioning beyond last-write-per-user-per-version. Design honoured: the three existing `FullScreenViewer` hooks are wired at the one render site (`initialPageStates` seeded from the store, `onPageStatesChange` autosave, `onCommit` on close); `bakeMarkupIntoPdf` stays for export as a derivative; the `takeDraft` delete-on-read was already replaced by `readDraft` / `discardDraft` (Round A). "Do not" honoured: the baked PDF is never the only copy (the fabric JSON is the record — who drew what, on which revision, when); IndexedDB is not the source of truth (the stash only carries a baked file into a request); no new viewer. Acceptance: (1) ✓ closing and reopening the viewer on the same document and version restores the user's markup; (2) ✓ refreshing `/requests/new?draft=…` still yields the marked-up file; (3) ✓ a markup is discoverable from the document's inspector without a download. Tests: `lib/__tests__/sweepRoundC4.test.ts`. Migration `20261051` — **applied & verified live 2026-09-02** (5/5).

### Scope

**In:** server-side persistence of viewer markup, keyed to
`(document_id, version_id, user_id, checkout_session_id)`, autosaved as the user
draws, restored on reopen.

**Out (deliberately):** collaborative/simultaneous markup, or markup versioning
beyond last-write-per-user-per-version. The requirement is that a redline
survives a page refresh and is findable later — not real-time co-editing.

### Design

`FullScreenViewer` already offers three persistence hooks
(`initialPageStates` / `onPageStatesChange` / `onCommit`, `:138-143`) and the only
render site passes **none of them** (`app/(protected)/documents/[libraryId]/page.tsx:3025-3039`).
`handleClose` computes a merged page-state map, finds no listener, and drops it.
The viewer already normalizes to scale 1.0, so the stored shape is the shape it
already produces.

Wire the hooks. Seed `initialPageStates` on open so a reopened sheet shows the
user's own redlines. Keep `bakeMarkupIntoPdf` for export, but make the baked PDF a
*derivative* of stored state rather than the only copy.

Then make `takeDraft` (`lib/draftHandoff.ts:53-66`) non-destructive — it currently
**deletes the entry inside the `get` success handler before returning**, so a
refresh on `/requests/new` destroys the only copy.

### Do not

- **Do not store only the baked PDF.** A flattened raster answers "what did it
  look like" and not "who drew which annotation, when, against which version" —
  which is the question a PSM audit asks years later.
- **Do not keep IndexedDB as the source of truth.** Browser-local plus
  delete-on-read is the current bug.
- **Do not build a new viewer.** The hooks exist; the page does not pass them.

### Acceptance

1. Closing and reopening the viewer on the same document and version restores the
   user's markup.
2. Refreshing `/requests/new?draft=…` before submitting still yields the attached
   marked-up file.
3. A markup that exists is discoverable from the document without the user having
   downloaded anything.

**Related findings:** `LIFE-3`, `LIFE-8`.

---

<a id="gap-8"></a>
## GAP-8 · A drafting request references more than one source document

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `LIFE-4`

### Scope

**In:** `metadata.source_documents` as an array alongside the existing singular
`source_document`, and the Impact-panel / intent-bridge queries reading both.

**Out:** per-sheet workflow state (each sheet advancing independently). One
ticket, many source sheets — not many sub-tickets.

### Design

`metadata.source_document` is a single object. `MultiDocViewer.sendMarkupsToDrafting`
degrades a real set of marked-up sheets into a prose bullet list in the
description, and drops `docId` entirely on the way (`LIFE-4`).

Keep the singular field populated with the primary sheet for backward
compatibility — `lib/impact.ts:117` and
`app/api/tickets/workflow-action/route.ts:231-233` both key on
`metadata->source_document->>id` and existing rows must keep working. Add the
array; have both consumers read the union.

**Fix `LIFE-4` first** — it is the reason the book-viewer path has no document id
to put in the array at all.

### Do not

- **Do not replace the singular field.** Existing tickets and both server-side
  consumers depend on it.
- **Do not represent sheets as prose in the description.** That is the current
  behaviour and it is why the Impact panel cannot see these tickets.

### Acceptance

1. A ticket created from a 3-sheet markup appears in the Impact panel of all
   three sheets.
2. Assigning a drafter produces `document_intents` rows for all three.
3. Existing single-source tickets are unaffected.

**Related findings:** `LIFE-4`, `LIFE-13`.

---

<a id="gap-9"></a>
## GAP-9 · Field verification has currency and expiry

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `LIFE-10`

### Scope

**In:** surface last-verified (who, when, against which revision) on the document,
and a staleness state derived from a configurable interval.

**Out:** a new reminder/notification cadence. Reuse the existing periodic-review
machinery rather than adding a parallel clock.

### Design

The data already exists and the index that answers the question was already
built — the migration comment states it outright: *"Field-verification
attestations and outcome reporting query by document + outcome ('who last
verified this P&ID against the field?')"*
(`20261012_doc_class_and_checkin_outcomes.sql:47-51`). **Nothing asks it.**

The currency machinery also already exists twice: `lib/reviewCycles.ts` (periodic
review) and `lib/acknowledgments.ts:217` (`ackStatusFor`, with grace windows).
Model verification staleness the same way and render it alongside `AckPill` /
`ReviewPill` / `EffectivePill`.

Also: a `discrepancy` outcome must visibly supersede an earlier `field_verified`
claim. Today a document can simultaneously show a positive attestation and an open
discrepancy ticket.

### Do not

- **Do not add a third currency implementation.** Reuse the review-cycle pattern.
- **Do not let `auto_released` overwrite a real outcome.** The expiry sweep
  currently writes `auto_released` into the outcome slot, erasing evidence that a
  discrepancy was reported through that session (`LIFE-14`).

### Acceptance

1. A document shows when it was last field-verified and against which revision.
2. A `discrepancy` outcome visibly supersedes an earlier `field_verified` claim.
3. Checkout history entries link to the tickets they spawned.

**Related findings:** `LIFE-10`, `LIFE-14`.

---

<a id="gap-10"></a>
## GAP-10 · A first-class hand-off record

**Verdict: DECLINE** · Do this instead: fix `LIFE-9`, `LIFE-13`, `LIFE-14`

### Why declined

The observation is correct — three unrelated conventions exist for the same
concept (`tickets.metadata.source_document`, `document_intents.ticket_id`,
`checkout_sessions.outcome_ref`), which is why they have three different field
contracts and only one is bidirectional.

But a unifying hand-off abstraction is a large refactor across three working
subsystems, justified by elegance rather than by a failure. **Every concrete
symptom it would fix has its own finding**, and those are cheaper and safer:

| Symptom | Finding |
|---|---|
| Three different required-field contracts | `LIFE-9` |
| The link is one-way; the ticket page never shows its source | `LIFE-13` |
| A hand-off orphaned by a mid-flight failure | `LIFE-14` |
| `outcome_ref` is write-only | `LIFE-10` |

Fix those four and the practical gap closes. Revisit the abstraction if a
**fourth** hand-off seam is ever added — at that point the duplication starts
paying compound interest.

### Do not

- **Do not build a `handoffs` table** as part of resolving `LIFE-9` or `LIFE-13`.
  Those are narrow fixes to existing structures.

**Related findings:** `LIFE-9`, `LIFE-13`, `LIFE-14`, `LIFE-10`.

---

<a id="gap-11"></a>
## GAP-11 · A document event declares what approval its downstream work requires

**Verdict: FOLD_INTO_FINDING** · Covered by `LIFE-5`, `LIFE-12`, `LIFE-13`

### Why folded

The requirement — that a document's approval requirements travel with the request
it originates — decomposes cleanly into three findings that already exist, and
building a general "requirements travel with the work" mechanism on top of them
would be speculative:

- **`LIFE-5`** — the MOC position is captured at check-in, stored twice, and read
  by nothing. Carrying it to the publish that needs it *is* half this gap.
- **`LIFE-12`** — ticket approval and document approval are two universes with no
  shared vocabulary. Making them mutually legible (the ticket shows the document's
  reviewer roster; the document shows that a ticket approval happened, as
  **context, explicitly not as a substitute**) is the other half.
- **`LIFE-13`** — the ticket page renders none of the structured backlink three
  producers already write.

Fix those three and the stated need is met.

### Do not

- **Do not let a ticket approval satisfy a `document_review_signoffs` row.** See
  `DEC-23`. Ticket approval is not bound to a content hash and produces no
  e-signature.

**Related findings:** `LIFE-5`, `LIFE-12`, `LIFE-13`.

---

<a id="gap-12"></a>
## GAP-12 · Library ownership has an admin surface

**Verdict: BUILD** · Effort: **S** · **Status: BUILT (2026-08-24)**

> **Build record.** Commit `98a65d5`. All four acceptance criteria hold:
> 1. **One screen and one export** — the permissions console (retitled
>    "Content permissions & ownership") shows effective owner + owner-source
>    on every library, folder and document row, live-resolved from
>    `owner_user_id` via the new pure `resolveOwnerForNode` (document > folder
>    > library > team supervisor), and an "Export ownership CSV" button whose
>    handler runs its own untruncated query (cap 4000, mirroring
>    `docControlRegister`) — deliberately NOT the lazily-loaded on-screen tree,
>    which truncates at 200 docs/folder.
> 2. **Unowned countable** — an amber "N unowned" chip counts libraries and
>    folders whose resolution is null (a folder under an owned/team-owned
>    library correctly does not count).
> 3. **Creation prompts for an owner** — `LibraryWizard` step 1 gains an
>    "Accountable owner" member search; saves route through
>    `lib/ownership.setOwner` so the `OWNER_ASSIGNED` audit row and owner
>    notification come from the single write path.
> 4. **Reachable from something named after ownership** — the "Review cycle"
>    menu items (library actions menu + folder context menu) are now
>    "Ownership & review cycle" with an honest tooltip.
>
> Do-nots respected: no new page; no `owner_name` branching anywhere (the
> DEL-8 rider also live-resolves the ReviewPolicyModal owner chip).
> Tests: `lib/__tests__/ownership.test.ts` — 9 pins including the DEL-8
> regression class (owner id set, name null → still owned) and the
> no-supervisor team rung (→ unowned, never a phantom).
>
> **What the build brought to light:** a SECOND library-creation path —
> `createLibrary` in `lib/libraryCollections.ts` (the Save-As flow) — still
> births unowned libraries; recorded as `OWN-22`. The document-control
> register still prints snapshot owner names for explicit owners
> (`docControlRegister.ts:154-158`) — the full DEL-8 fix should live-resolve
> there too when DEL-8 is worked. `resolveEffectiveOwner`'s returned `name`
> field is itself the trap; consider renaming it `snapshotName` in DEL-8's
> scope.

### Scope

**In:** effective owner and owner-source as columns on the existing permissions
console; an owner field in the library wizard; an unowned count that includes
libraries and folders; rename the misleading menu item.

**Out:** a dedicated ownership admin page. The permissions console already
enumerates the node tree.

### Design

Ownership was built as an attribute of the review-cycle feature and never
promoted. Today the **only** way to set a library owner is a menu item labelled
**"Review cycle"**, tooltipped *"Set a periodic-review cycle for every document in
this library"* (`app/(protected)/documents/[libraryId]/page.tsx:3327-3334`). And
`LibraryWizard` never asks who owns a library, so **libraries are born unowned.**

`app/(protected)/admin/permissions/page.tsx:76-91` already loads every library,
folder and document with visibility and rule counts. Adding effective owner and
owner-source per row is a read-only extension of an existing query.

Read `owner_user_id` and resolve the name **live** — never `owner_name`, which is
a write-once snapshot that drifts (`DEL-8`). `RoleModelTree.tsx:232` currently
renders `ownerName || team`, so a row with an owner uuid and a null name displays
**the team** as owner, which is the opposite of what `user_is_effective_owner`
computes.

### Do not

- **Do not branch on `owner_name` to decide whether an owner exists.** Branch on
  `owner_user_id`.
- **Do not build a new page.** Extend the console.

### Acceptance

1. An admin sees, in one screen and one export, the effective owner and owner
   source of every library, folder and controlled document.
2. Libraries with no owner are countable.
3. Creating a library prompts for an owner.
4. Assigning a library owner is reachable from something named after ownership.

**Related findings:** `DEL-7`, `DEL-8`.

---

<a id="gap-13"></a>
## GAP-13 · Triage has a first-class "we don't do that" outcome

**Verdict: BUILD_NARROW** · Effort: **S**

> *"Route requests to the current drafting manager first for assignment and
> approval so people don't ask for stupid nonsense we don't or can do."*

### Scope

**In:** a configurable rejection-reason taxonomy on the reject action, stored
structured and reportable.

**Out:** an approval workflow for the triage decision itself. The triage-first
shape is already built and works.

### Design

**The routing half already exists.** `getInitialStatus` returns
`PENDING_ASSIGNMENT` for everything; `lib/ticketRouting.ts` targets the
`DraftingSupervisor` when one is set, falling back to Admins, with an org setting
for whether Admins keep receiving. What is missing is the teeth: nothing records
*why* a request was rejected as out of scope.

Add an org-configurable reason list (same shape as the request-type config at
`app/(protected)/admin/requests/page.tsx:179-195`), require a reason on reject,
store it structured, and surface a rejection-reason breakdown in
`/admin/analytics`.

**Two live defects on this path get fixed with it**, and they matter more than the
taxonomy: `WF-19` — routing matches on the **headline** role, so a
`['Manager','DraftingSupervisor']` supervisor is silently never notified and the
branch falls back to Admins; and nobody at all is notified when a ticket
*re-enters* the queue after engineering review.

### Do not

- **Do not free-text the reason.** Free text is what exists (a comment) and it is
  not reportable, which is the whole point.
- **Do not fix the taxonomy without fixing `WF-19`.** A rejection taxonomy on a
  queue the supervisor is never told about is decorative.

### Acceptance

1. Rejecting a request requires selecting a reason from the org's configured
   list.
2. `/admin/analytics` shows a rejection-reason breakdown.
3. A ticket entering a queue state notifies whoever the routing policy names,
   matched against the full role collection.

**Related findings:** `DRAFT-4`, `WF-19`.

---

<a id="gap-14"></a>
## GAP-14 · "Profiles" instead of stacking roles

**Verdict: FOLD_INTO_FINDING** · Covered by `WF-1`, `WF-10`, `WF-11`, plus `GAP-1` and `GAP-3`

> *"I'm thinking I can just assign profiles instead of using multiple role
> additions."*

### Why folded

**The mechanism you want mostly exists, and the answer to "should I add more
roles?" is no.** Two primitives cover the intent between them:

- **Per-person capability grants** (`lib/capabilityPolicy.ts:98-110`) —
  additive-only, optional expiry, audited with full before/after, riding the same
  evaluator as roles so there is no parallel system to collide with.
- **Teams** — a proper join table, a first-class ACL subject, and **correctly
  evaluated additively**: `node_visible` aggregates *all* of a user's teams, so
  unlike roles a team grant is never shadowed by a higher-ranked one.

Neither needs replacing. What they need is:

1. **To actually work.** The whole grant mechanism is currently inert because it
   reads a column that does not exist (`WF-1` / `DB-1`), the server cache is never
   invalidated (`WF-10`), and the guardrails are client-side only (`WF-11`).
2. **A resource dimension** so a grant can name a request type (`GAP-1`) or a
   document (`GAP-3`).

Build a named "profile" object only if, after all of that lands, bundling
capabilities under a name is still wanted. It probably will not be — a team plus a
capability grant is a profile.

### Do not

- **Do not build a `profiles` table.** Fix the grant mechanism first; re-evaluate
  after.
- **Do not add roles** to express any distinction. That is what produced 19 roles,
  six of which gate nothing.

**Related findings:** `ADD-1`, `ADD-2`, `WF-1`, `WF-10`, `WF-11`, `WF-13`, `WF-16`.

---

<a id="gap-15"></a>
## GAP-15 · Ownership carries read access

**Status: RESOLVED (2026-08-24, roles-and-permissions Phase 3b).** Built exactly per DEC-7: an ownership branch INSIDE `node_visible`, after the controller short-circuit and before the `acl_index` check, using the same `user_is_effective_owner` cascade (document → folder → library → team supervisor) the publish guard trusts — never an auto-granted ACL rule (`setOwner` is the known silent-failure site; it also now fails loudly per OWN-14). Because `node_visible` had no owner columns, it gained a 6-arg form; the 3-arg form remains as a delegating wrapper (document_sets, owner-less). `doc_is_visible` forwards the cascade — that is the path gating `document_versions` SELECT and with it `file_url`. Policies re-created with owner columns: `documents_acl_select`, `collections_acl_select`, `document_shares_insert` (20261026 body byte-carried). The CLIENT mirrors gained the same branch so DB-granted rows are not re-hidden: `canDiscover` / `canWithAclChain` (read/discover only — ownership's write half stays in the publish guard), the library explorer's folder and document filters, and the storage download-url route (which re-checks via the `user_is_effective_owner` RPC before its 403). `isEffectiveOwnerOfDocument`'s self-defeat resolves automatically once the owner can SELECT the row (DEL-9's sharpest case, as predicted). Acceptance: (1) owner of a private library opens their documents ✓ (DB + mirrors + bytes); (2) a non-owner, non-granted member still cannot ✓ (pinned by test); (3) `isEffectiveOwnerOfDocument` true ✓ (consequence of 1); (4) no recursion — the cascade function is SECURITY DEFINER and re-enters no policy ✓. Scope note: the client folder/doc filters resolve direct owners (doc/folder/library); the team-supervisor rung resolves DB-side and in the storage route. Migration `20261037` **applied & verified live 2026-08-24** (7-point probe all true). Tests: `lib/__tests__/ownershipReadAccess.test.ts`, `lib/__tests__/rpPhase3bMigration.test.ts`.

**Verdict: BUILD** · Effort: **S** · Design settled by `DEC-7`

### Scope

**In:** an ownership branch inside `node_visible`, after the controller
short-circuit and before the `acl_index` check.

**Out (deliberately):** auto-granting an explicit ACL read rule at assignment
time. That was the more auditable option and is rejected in `DEC-7`, because it
adds a second dependent write to `setOwner` — the exact call site with the known
silent-failure bug (`OWN-13`). A rule that fails to write leaves an owner who is
recorded as owner and cannot see their documents, with a success audit row.

### Design

Migration `20260630_document_ownership.sql:4-5` promises the owner *"is granted
CRUD access to their scope"*. Phase 2 shipped the write half
(`20260816_owner_publish_access.sql`) and never shipped the read half:
`user_is_effective_owner` appears in the publish guard, the review-completion
guard and two publisher-row policies — and in **no SELECT policy**.

Add the branch. `user_is_effective_owner` is `SECURITY DEFINER` and reads
`collections` / `libraries`, so it does not re-enter the policy — no recursion
risk.

This also fixes `DEL-9`'s sharpest case as a side effect:
`isEffectiveOwnerOfDocument` (`lib/ownership.ts:77-88`) reads `documents` under
the caller's own RLS, so an owner who cannot SELECT the row is currently told they
are **not** the owner — and the Inspector hides the publish button the database
would have honoured.

Visibility of ownership in the admin UI is solved by `GAP-12`, not by duplicating
ownership into the ACL.

### Do not

- **Do not add a second write to `setOwner`.** See `OWN-13` / `OWN-14`.
- **Do not put the branch before the controller short-circuit.** Order matters for
  plan cost.

### Acceptance

1. A non-controller assigned as owner of a `private` library can open a document
   in it, and the deep-link in the review-due notification resolves.
2. A member who is neither owner nor granted still cannot.
3. `isEffectiveOwnerOfDocument` returns true for that owner.
4. `EXPLAIN` on a `documents` SELECT shows no recursion or plan blow-up.

**Related findings:** `DEL-2`, `DEL-9`.

---

## Already built — do not build these twice

Recorded because each looks like a gap and is not.

| Looks missing | Actually |
|---|---|
| **Triage-first routing to the drafting manager** | **Built and working.** Missing only the rejection taxonomy (`GAP-13`). |
| **Per-file / per-subfolder permissions instead of NTFS whole-directory grants** | **Built, and materially better than NTFS.** A document carries its own ACL, `inherit: false` breaks the chain at any node, `hidden`/`private` supports blind-drilling to a single file via an explicit `discover` grant, rules carry expiry, and it is enforced at the **database** as a `RESTRICTIVE` policy. Defects: `DOCACL-1`, `DOCACL-2`, `DOCACL-3`, `OWN-7`, `DB-4`, `DB-5`. |
| **Assigning a library owner, a different person per library** | **Built.** Hidden, unvalidated, unprotected — `DEL-7`, `OWN-1`, `OWN-13` — but the mechanism is there. |
| **Teams being optional** | **Built and verified.** Every team lookup degrades correctly at zero teams. See report 08. |
| **Delegating one capability to one person with an expiry** | **Built** (`UserGrant`), currently inert (`WF-1`), scoped to tickets/holds rather than documents (`GAP-3`). |
| **A capability layer that could carry the whole app** | **Built.** 17 capabilities, org-configurable, per-person grants, critical-capability guardrails, audited. Covers requests, holds, checkouts and two admin pages and nothing else — that is `SURF-9`, a coverage gap, not a missing design. |
