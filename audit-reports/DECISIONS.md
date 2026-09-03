# Decisions

**These audits are worked by autonomous agents. Nobody is waiting to be asked.**

Every judgment call the audit would otherwise have deferred is made here, up
front. A `DEC-` entry is **binding on a resolving agent** — you do not get to
re-litigate it, and you do not need to.

Each carries a **Reversal** line: the one fact or preference that would flip it.
That is there so a person can change any of these cheaply later, not so an agent
can treat it as optional.

Where a decision rests on a business preference rather than something discovered
in the code, it says so in its own words. Those are marked **stated default** —
they are still binding, they are just visibly someone's choice rather than a fact
about the system.

---

## How to use this file

- A report that used to say *"a human must decide"* now cites a `DEC-` id. Follow
  it.
- If you hit a call that is genuinely **not** covered here, do not stop. Make it
  yourself using the same standard — pick the option that fails safe for a
  PSM/OSHA-regulated document-control system, write it into your `Resolution`
  block as a local decision with your reasoning, and keep going. Then add it here
  as the next free `DEC-` number so the next agent inherits it.
- Decisions are not findings. They have no severity and no status. They are the
  ground rules the findings are worked against.

---

## Lookup

| DEC | The call | Risk | Affects |
|---|---|---|---|
| [DEC-1](#dec-1) | `org_members.role` becomes a trigger-maintained projection of `roles[]` | high | `CHAIN-2`, `ADD-1`, `OWN-3`, `DB-3`, `DB-7` |
| [DEC-2](#dec-2) | Publish-path SQL goes additive via `is_org_controller`. **Do not touch `ROLE_RANK`.** | high | `OWN-3`, `DB-7`, `ADD-1` |
| [DEC-3](#dec-3) | Deprecate the six department roles; delete nothing | low | `ROLE-1`, `CHAIN-5` |
| [DEC-4](#dec-4) | Keep the four Engineer tiers as labels; collapse nothing | low | `ROLE-2`, `ROLE-3` |
| [DEC-5](#dec-5) | Role identity stays a string. Stable ids: declined for now | low | `CHAIN-5`, `ROLE-1` |
| [DEC-6](#dec-6) | An effective owner **may** reassign ownership within their own scope | medium | `OWN-2`, `DEL-1` |
| [DEC-7](#dec-7) | Ownership carries read access via a branch in `node_visible`, not an auto-granted ACL rule | medium | `DEL-2`, `DEL-9`, `GAP-15` |
| [DEC-8](#dec-8) | Explicit deny beats `admin`, in all three evaluators | medium | `OWN-8`, `DOCACL-2` |
| [DEC-9](#dec-9) | Team ownership stays a resolution rung; its gaps get fixed | medium | `DEL-3`, `OWN-16` |
| [DEC-10](#dec-10) | `acl_index` gets a nightly rebuild. Derived column: declined for now | medium | `DB-4`, `OWN-7`, `OWN-20` |
| [DEC-11](#dec-11) | Per-item disposition for the dead-code rosters | low | `OWN-21`, `WF-17`, `SURF-10` |
| [DEC-12](#dec-12) | Separation of duties is **derived from active member count**, not a toggle | high | `WF-4`, `WF-14`, `DEL-5`, `GAP-2` |
| [DEC-13](#dec-13) | `policyAllows` gains a resource dimension. Build it, staged | high | `WF-13`, `DRAFT-1`, `GAP-1` |
| [DEC-14](#dec-14) | Implement `CANCELED`; remove `PENDING_ENG_INITIAL` and `NEW` | medium | `WF-17` |
| [DEC-15](#dec-15) | A reopen starts a **new** revision cycle | medium | `WF-21` |
| [DEC-16](#dec-16) | `requiresEngineerApproval` fails closed on snapshot **or** current role | low | `WF-12` |
| [DEC-17](#dec-17) | Fix the two real admin-gate defects now; consolidation is separate staged work | medium | `SURF-9`, `WF-20` |
| [DEC-18](#dec-18) | Wire `assertOrgHasAccess`, enforcement **off** by default | low | `SURF-15` |
| [DEC-19](#dec-19) | Fix `access_requests` RLS and rate limit; build the pending-requests view | low | `EGRESS-5` |
| [DEC-20](#dec-20) | Implement **both** a DELETE policy and a real suspend | high | `SURF-1`, `OWN-12`, `SURF-16` |
| [DEC-21](#dec-21) | Reviewer independence is a per-library policy, default **on** where a roster exists | medium | `DEL-5`, `WF-14` |
| [DEC-22](#dec-22) | The hand-back is an explicit guarded action routed through `revUpDocument` | high | `LIFE-1`, `GAP-6` |
| [DEC-23](#dec-23) | **Delete the `related_ticket_id` review waiver outright** | medium | `LIFE-2`, `LIFE-12`, `GAP-6` |
| [DEC-24](#dec-24) | Markup persists server-side, keyed to document + version + user + session | medium | `LIFE-3`, `LIFE-8`, `GAP-7` |
| [DEC-25](#dec-25) | A ticket cannot close silently over its own open hold. Never auto-release | medium | `LIFE-6` |
| [DEC-26](#dec-26) | An `ASBUILT` ticket defaults the resulting version to `issue_type: "As-Built"` | low | `LIFE-11` |
| [DEC-27](#dec-27) | `BLOCKED` replaces "ask a human". Record and move on | — | protocol |
| [DEC-28](#dec-28) | `WONTFIX` / `INVALID` need evidence, not sign-off | — | protocol |
| [DEC-29](#dec-29) | The evidence bar for `RESOLVED` | — | protocol |
| [DEC-30](#dec-30) | How to work a finding whose fix needs a migration or unobservable DB state | — | protocol |
| [DEC-31](#dec-31) | The scope rule, without a human to ask | — | protocol |
| [DEC-32](#dec-32) | How parallel agents claim work without colliding | — | protocol |
| [DEC-33](#dec-33) | **Engineering is the default**, and it gates **delivery, not drafting**. Only the requester's declaration removes it; the assigner may only add it back | high | `TIER-1`, `TIER-2`, `TIER-7`, `GAP-101`, `GAP-111` |
| [DEC-34](#dec-34) | The declaration is a **typed statement in a column**, not a checkbox and not `metadata` | low | `GAP-110`, `INTAKE-*` |
| [DEC-35](#dec-35) | **No facility vocabulary in code.** No `QAQC`, no `B31.3`, no role-name branching | medium | `TIER-3`, `TIER-4`, `GAP-112` |
| [DEC-36](#dec-36) | The routing table lives in `org_configurations` and resolves through the container chain | medium | `GAP-112`, `GAP-104`, `DCW-6` |
| [DEC-37](#dec-37) | **One person may hold many slots.** Independence is per-slot, not per-person. Amends `DEC-12` | medium | `DEC-12`, `WF-14`, `GAP-112` |
| [DEC-38](#dec-38) | **No delivery record, no silent advance.** The consent clock starts at confirmed delivery | high | `GAP-109`, `GAP-113` |
| [DEC-39](#dec-39) | Warn before expiry; the non-response record lives on the **ticket**, not the bell | medium | `GAP-113`, `GAP-106` |
| [DEC-40](#dec-40) | Projects link by **reference**, never by copy | medium | `GAP-114`, `PROJ-*` |
| [DEC-42](#dec-42) | Supabase identity linking is **required**; the unique index is the backstop, not the mechanism | medium | `IDENT-1`, `IDENT-2`, `IDENT-3` |

---

# Role model

The additive-roles migration is genuinely half-finished, and the half that
shipped is the half that can *remove* authority. These four decisions settle the
direction so no agent has to guess.

<a id="dec-1"></a>
## DEC-1 · Does `role` become a maintained projection of `roles[]`?

**Decision. Yes. Add a `BEFORE INSERT OR UPDATE` trigger on `org_members` that
sets `NEW.role := primaryRole(NEW.roles)`, and make `roles` the only column any
writer sets. `role` becomes read-only to application code.**

**Rationale.** `org_members.role` is today a denormalized cache of a computation
that happens **in the browser** (`app/(protected)/admin/users/page.tsx:130`) and
is written by exactly one code path. Every other writer — signup, both restore
paths, any direct PATCH — can desynchronize it, and ~237 authority reads treat it
as truth. Making it a database invariant is what turns 32 primary-only RLS
clauses and 52 API guards correct-by-construction, and it retroactively secures
`prevent_last_admin_removal`, which currently protects a value the database does
not control.

**Implementation.** Three steps, in order, and **do not skip step 1**:

1. **Backfill first** (this is `DB-3`): `roles` is `NOT NULL DEFAULT '{}'`, so it
   is empty — not null — for every row signup created. Populate
   `roles = ARRAY[role]` wherever `roles = '{}'`. Until this runs, every additive
   check evaluates against an empty array and denies the org's founding Admin.
2. Port `primaryRole` / `ROLE_RANK` into SQL as a `STABLE` function. It must
   produce byte-identical output to `lib/roleCapabilities.ts:118-123` — pin that
   with a test that walks every role.
3. Add the trigger. Service-role exempt is **not** appropriate here — restore
   should also produce a consistent headline.

**Acceptance.**
- No `org_members` row exists where `role <> primaryRole(roles)`, verified by a
  query that returns zero.
- A direct `PATCH /rest/v1/org_members` setting only `role` does not change the
  effective headline.
- Signup produces `roles = ARRAY['Admin']`, not `'{}'`.
- A test asserts the SQL and TypeScript rank functions agree for all 19 roles.

**Reversal.** If the SQL/TypeScript rank duplication proves harder to keep in
sync than the desync it prevents, invert it: drop `role` entirely and have every
reader compute from `roles`. That is more work now and less to maintain later.

**Risk:** high — it touches every membership row.

<a id="dec-2"></a>
## DEC-2 · Additive publish path, or reorder `ROLE_RANK`?

**Decision. Make the five headline-only publish-path checks additive by routing
them through the existing `is_org_controller(org_id)`. Do NOT reorder
`ROLE_RANK`. These are mutually exclusive — applying both silently strips
Manager-tier ticket authority from the same people.**

**Rationale.** `is_org_controller` (`20260814:31-40`) is already
`SECURITY DEFINER`, already additive-roles-aware, and already used by the delete
policies. Every remaining fix is *substitution into existing call sites*, not new
logic. Reordering `ROLE_RANK` looks like a one-line fix and is not: rank drives
`primaryRole`, which drives `activeRole`, which gates roughly 80 client surfaces
including two **restriction**-shaped checks where a rank change is an escalation
(`CHAIN-1`).

**Implementation.** The five sites, each substituting the local
`SELECT role INTO v_role … IF v_role IN ('Admin','DocCtrl')` for
`is_org_controller(...)`:

| Site | Function |
|---|---|
| `20260822_review_completion_guard.sql:60-64` | the live publish/supersede guard |
| `20260812_per_library_publish_authority.sql:48-52` | `user_can_publish_on_library` |
| `20260828_integrity_hardening.sql:85-89` | `publish_revision`'s `v_is_controller` |
| `20260828_integrity_hardening.sql:235,270` | sign-off / ack row management |
| `20260708_acl_rls_enforcement.sql:58` | `node_visible` |

`node_visible` is the one to watch — it gates *all* document read visibility, so
land it last and separately from the other four.

**This widens authority.** Before shipping, run the inventory:
`SELECT uid, role, roles FROM org_members WHERE roles && ARRAY['Admin','DocCtrl'] AND role NOT IN ('Admin','DocCtrl')`.
Those people gain controller powers they did not have. Record the list in your
`Resolution` block. Requires `DEC-1` step 1 first.

**Acceptance.**
- A member with `roles = ['Manager','DocCtrl']` can publish a revision, appears
  in `getOrgControllers()`, and can see a `private` library.
- A member with `roles = ['Manager']` alone can do none of those.
- `ROLE_RANK` is byte-identical to its current value.

**Reversal.** If the inventory turns up a large population who would gain
authority unintentionally, narrow their `roles` arrays first — do not solve it by
reordering rank.

**Risk:** high — widens authority.

<a id="dec-3"></a>
## DEC-3 · What happens to the six capability-dead department roles?

**Decision. Deprecate them. Delete nothing. Mark `Accounting`, `Safety`, `HR`,
`Maintenance`, `Operations` as dormant in the role picker with a tooltip
pointing at teams. `Contractor` is NOT dormant — it is load-bearing.**

**Rationale.** Role identity is the role's *name*, stored as a bare string inside
customer JSON in seven places with no version field anywhere (`CHAIN-5`).
Removing a string from `ALL_ROLES` orphans every stored reference **silently** —
the rule stays in the JSON and simply stops matching, so an access grant
evaporates with no error and no audit event. That is unacceptable in a regulated
system, and the cost of keeping five inert strings is approximately zero.

`Contractor` is a separate case and the audit got it wrong once already: it drives
reduced navigation at `components/navigation/Sidebar.tsx:248` as a
**restriction**, so it carries real behaviour.

**Implementation.** Add a `dormant: true` flag to the role metadata; render those
five greyed in the picker with "Use a team instead — this role grants nothing
beyond Requester." Leave them fully functional as ACL subjects. Do not remove
them from `ALL_ROLES`, `PermissionDrawer.ROLES`, or `ROLE_HIERARCHY`.

**Acceptance.**
- An existing ACL rule naming `Safety` still matches after the change.
- The five are visibly discouraged in the picker and still selectable.
- `Contractor` is not marked dormant.

**Reversal.** Removal becomes safe once role identity is a stable id with a blob
migration — see `DEC-5`.

**Risk:** low.

<a id="dec-4"></a>
## DEC-4 · Do the four Engineer tiers collapse?

**Decision. Keep all four names. Do not collapse, do not delete. Document them
in the picker as what they already are — labels with identical authority.**

**Rationale.** `roleTokenMatches` already treats `"Engineer"` as matching all
four (`lib/capabilityPolicy.ts:130`), and the code says the tiers *"were never
enforced anywhere and remain a labeling convention."* So the authority collapse
has already happened; only the names remain, and the names are load-bearing as
customer-visible seniority. Deleting them hits the same stored-string problem as
`DEC-3`.

**Implementation.** Label them in the role picker: "Engineering tiers are
labels — all four grant identical authority. Use a capability grant to
differentiate." No code change to the evaluator.

**Acceptance.** The picker states the tiers are equivalent; `ALL_ROLES` is
unchanged.

**Reversal.** If per-tier authority is ever wanted, it needs the resource
dimension from `DEC-13`, not four separate role tokens.

**Risk:** low.

<a id="dec-5"></a>
## DEC-5 · Does role identity become a stable id?

**Decision. No, not now. Roles stay string-identified. No role may be renamed or
removed until this is revisited.**

**Rationale.** Converting to ids means a migration that rewrites `documents.acl`,
`documents.acl_index`, and the same pairs on `collections` and `libraries`, plus
`org_configurations.data` — across every customer, with no version field to key
off. That is a project with real risk and no current forcing function, because
`DEC-3` and `DEC-4` remove the reason anyone would want to delete a role.

**Implementation.** None. Record the constraint: renaming or removing a role is
blocked on this decision being revisited.

**Acceptance.** `ALL_ROLES` contains the same 19 strings at the end of this audit
as at the start.

**Reversal.** Flip this the moment someone actually needs to remove or rename a
role in production. At that point, build ids and a blob migration first.

**Risk:** low.

---

# Ownership

Ownership turned out to be the axis carrying the most authority and the least
protection. These decisions settle its shape.

<a id="dec-6"></a>
## DEC-6 · May an owner reassign ownership of their own scope?

**Decision. Yes. The `OWN-2` guard permits an ownership change when the actor is
a controller **or** the current effective owner of that node. Everyone else is
refused.**

**Rationale.** The UI already offers this (`ReviewSection.tsx:194`, shown when
`canManage = isController || isOwner`) and it is the only hand-off an owner has
today. Making the guard controller-only would break a working flow to close a
hole that a narrower rule closes just as well. The attack `OWN-2` describes is a
*non-owner* claiming a document; requiring current ownership stops it completely.

**Implementation.** Extend `documents_guard_access_change`
(`20260816_documents_access_change_guard.sql:84-86`) to fire on `owner_user_id`
and `owner_name` as well as `visibility|acl|acl_index`, and permit the change
when `is_org_controller(OLD.org_id)` **or**
`user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid())`.
Service-role stays exempt, as it already is.

**Acceptance.**
- A Viewer's direct PATCH setting `documents.owner_user_id` to self is rejected.
- The current owner can reassign through the Inspector.
- A controller can always reassign.

**Reversal.** If ownership hand-off turns out to need an approval trail, make it
an audited action rather than removing the capability.

**Risk:** medium.

<a id="dec-7"></a>
## DEC-7 · How does ownership carry read access?

**Decision. Add an ownership branch inside `node_visible`, placed after the
controller short-circuit and before the `acl_index` check. Do NOT auto-grant an
explicit ACL read rule at assignment time.**

**Rationale.** The explicit-rule option is more auditable and was tempting, but it
adds a **second dependent write** to `setOwner` — which is precisely the call
site with the known silent-failure bug (`OWN-13`, `OWN-14`). A rule that fails to
write leaves an owner who is recorded as owner and cannot see their documents,
with a success audit row. The implicit branch has one definition, cannot drift,
needs no backfill, and is immediately correct for every existing owner.

Visibility of ownership is a real concern and is solved separately by `DEL-7`
(surface effective owner and owner-source in the permissions console), not by
duplicating ownership into the ACL.

**Implementation.** `user_is_effective_owner` is `SECURITY DEFINER` and reads
`collections` / `libraries`, so it does not re-enter the policy — no recursion
risk. Add the branch, then confirm `isEffectiveOwnerOfDocument`
(`lib/ownership.ts:77-88`) starts returning true for an owner of a `private`
library, which fixes `DEL-9`'s sharpest case as a side effect.

**Acceptance.**
- A non-controller assigned as owner of a `private` library can open a document
  in it, and the deep-link in the review-due notification resolves.
- A member who is neither owner nor granted still cannot.
- `EXPLAIN` on a `documents` SELECT shows no recursion or plan blow-up.

**Reversal.** If auditors need ownership-derived read access to appear in the
permissions drawer, add it as a *rendered* derived row rather than a stored rule.

**Risk:** medium — widens read access.

<a id="dec-8"></a>
## DEC-8 · `admin`-implies-everything, or explicit deny wins?

**Decision. Explicit deny always wins, including over `admin`. Change
`lib/acl.ts:133-137` to evaluate denies before the `admin` short-circuit, so all
three evaluators agree with the two that already fail safe.**

**Rationale.** Two of the three evaluators (`canPublishViaIndex` and the SQL
`user_can_publish_on_library`) already check deny first. Only `lib/acl.ts` checks
`admin` first, and it is the one driving the *button* — so today the UI is the
permissive outlier. Moving the UI to match enforcement is both the smaller change
and the safer direction: a revocation that does not visibly take effect is the
failure mode that matters in a regulated system.

**Implementation.** In `can()`, test `denied.has(action)` before the
`allowed.has("admin")` short-circuit. Note this changes `canDiscover`,
`canWithAclChain`, `canBlindDrill` and `isDiscoverable` too — that is intended
and consistent. Separately, the SQL never consults `deny…admin` at all
(`20260812:65-68`); add it, so revoking a library `admin` grant works everywhere.

**Acceptance.**
- `{allow: admin} + {deny: publish}` returns **denied** from all three
  evaluators.
- `{allow: admin} + {deny: admin}` returns **denied** from all three.
- One shared test fixture pins both cases across TypeScript and SQL.

**Reversal.** If a real workflow depends on `admin` overriding a narrow deny,
express it by removing the deny rather than by weakening precedence.

**Risk:** medium — narrows access; may surface as "I lost a permission."

<a id="dec-9"></a>
## DEC-9 · Does team ownership stay a resolution rung?

**Decision. Keep the rung. Fix its four gaps rather than demoting it.**

**Rationale.** Demoting team ownership to "a convenience that writes
`owner_user_id`" is architecturally cleaner and was seriously considered. It is
rejected because it silently changes who owns things in orgs that already use it:
a library currently resolving to a team's supervisor would be frozen to whoever
happens to hold that role at migration time, with no signal. The rung's problems
are all fixable in place.

**Implementation.** Four fixes, all in `DEL-3`'s scope:
1. Constrain the supervisor picker to team members, with an explicit override
   that states what it means.
2. Audit every supervisor change with before/after and the affected library list.
3. Block clearing a supervisor while the team owns a library, or clear the
   ownership with it and audit that.
4. Handle team deletion — `libraries.owner_team_id` must not dangle.

**Acceptance.** Each of the four has a test; changing a supervisor produces an
audit row naming both people and every affected library.

**Reversal.** If teams are rarely used for ownership in practice, demoting
becomes cheap — check adoption before revisiting.

**Risk:** medium.

<a id="dec-10"></a>
## DEC-10 · Is `acl_index` a cache or a derived column?

**Decision. A nightly-rebuilt cache, for now. Add the rebuild to the existing
maintenance cron. A trigger-derived column is declined until the rebuild is
proven.**

**Rationale.** The rebuild is the cheapest thing that fixes two findings at once:
it propagates ancestor ACL changes to descendants (`DB-4`) **and** drops expired
rules that `buildAclIndexFromRules` never carried into the index (`OWN-7`). It
touches no SQL function and no JSON shape. A trigger-derived column is the
durable answer but is a schema change that would have to land while `DB-2`'s deny
guard is being switched on — too much moving at once.

**Implementation.** In `/api/cron/maintenance`, rebuild `acl_index` from `acl`
plus the resolved ancestor chain for every node, org by org. Log counts. This
narrows the stale-grant window from *forever* to *one day* — say so in the
`Resolution` block; do not describe it as fully fixed.

**Acceptance.**
- Granting at a library, revoking at the library, then checking a nested document
  after one rebuild cycle shows the revocation applied.
- An expired publish rule stops authorizing at the database after one cycle.
- The rebuild is idempotent.

**Reversal.** Move to a derived column once the deny guard (`DB-2`) has been live
and quiet for a release.

**Risk:** medium.

<a id="dec-11"></a>
## DEC-11 · Dispositions for the dead-code rosters

**Decision. Per item, as follows. Nothing on these lists is deleted except where
stated.**

| Item | Disposition |
|---|---|
| `p_actor_role` in both `publish_revision` signatures | **Remove the parameter.** It is referenced nowhere in either body and sits on a security-relevant RPC where it reads as a check. Drop it from the signature and from `lib/revisions.ts:541,1199`. |
| `org_has_active_subscription()` | **Keep, wire per `DEC-18`.** |
| `canBlindDrillAccess`, `filterDiscoverable` | **Remove.** Exported, zero callers, pure functions, no stored state, trivially restorable from git. |
| `owner_name` columns | **Keep as a cache; stop branching on it.** Per `DEL-8`, resolve display names live and never use `owner_name` to decide *whether* an owner exists. |
| Missing owner indexes | **Add** on `libraries.owner_user_id` and `collections.owner_user_id`. |
| `EffectiveOwner.source === "collection"` | **Keep.** `DEL-7` will render owner-source, which makes it live. |
| `revision_branches` resolution open to any member | **Not dead code — a real authority gap.** Restrict resolution to a controller or the document's effective owner. Treat as a defect under `OWN-21`. |
| `NEW`, `PENDING_ENG_INITIAL` | **Remove** — see `DEC-14`. |
| `CANCELED` | **Implement** — see `DEC-14`. |
| `ticket.initial_review`, `ticket.eng_review`, `ticket.final_approve` | **Keep, mark `dormant: true`,** rendered greyed with a tooltip. They become live if a "return to unassigned engineer pool" action is ever added, and a decorative live-looking control is the exact failure the permissions console was built to remove. |
| `metadata.minor_correction` | **Keep.** Written and unread, but it is provenance on a PSM record and costs nothing. |
| `lib/roleCapabilities.ts` `Capability` vocabulary | **Keep, mark as picker-only** in a header comment. It is the role picker's descriptive layer, not an authority layer; the confusion is the naming, not the code. |

**Acceptance.** Each row has either a commit or a recorded rationale. No item is
left ambiguous.

**Reversal.** Per item; all removals are recoverable from git.

**Risk:** low.

---

# Workflow

<a id="dec-12"></a>
## DEC-12 · What is the separation-of-duties default?

**Decision. Derive it from org size, do not add a toggle. When an org has **three
or more active members**, enforce all three predicates: the assigned drafter is
not the requester, the approver is not the assigned drafter, and the assigned
engineer is neither the requester nor the caller. Below three, allow the
single-person loop.**

> **Stated default.** Whether a small shop may self-approve is a business
> preference, not a fact about the code. This is the safer reading of the
> evidence, chosen so agents can proceed.

**Rationale.** The single-person loop appears deliberately supported — a one- or
two-person operation genuinely has nobody else to route to, and a hard rule would
break every such customer on upgrade. But a config toggle defaulting to `off` is
a control nobody sets, which is the same as not having it; and one defaulting to
`on` is a toggle people switch off in frustration. Deriving from active member
count means the protection appears exactly when it becomes possible to honour,
with no configuration and no upgrade break.

**Implementation.** Evaluate the predicates in `getActions`
(`lib/workflow.ts`) **and** re-check in
`app/api/tickets/workflow-action/route.ts:113-132`, which is where the engineer
pick is already validated. Where a predicate blocks an action, the UI must say
why — "needs a second person" is a comprehensible message; a missing button is
not. Count `org_members` where `status='active'`.

**Acceptance.**
- In a 5-member org, a Manager cannot assign themselves as drafter on their own
  request, and cannot pick themselves as engineer.
- In a 2-member org, the existing loop still completes end to end.
- A blocked action renders an explanation rather than disappearing.

**Reversal.** If a real customer needs self-approval above the threshold, this
becomes an explicit per-org override — added *then*, with an audit trail, not
pre-emptively.

**Risk:** high — changes what is possible on every ticket in orgs above the
threshold.

<a id="dec-13"></a>
## DEC-13 · Does `policyAllows` gain a resource dimension?

**Decision. Yes. Build it, staged. This is the stated requirement "only certain
people can approve certain types of requests" and it cannot be met without it.**

**Rationale.** The capability policy is the right chassis — 17 capabilities,
org-configurable, per-person grants, audited. It is missing exactly one thing: a
resource argument. Every workaround (more roles, more capabilities) makes the
model worse. See `GAP-1`.

**Implementation.** Three stages, each independently shippable:

1. **Make request types real** (`WF-15`). Validate `request_type` at insert
   against the org's configured list. Today it is unvalidated free text that
   gates a terminal transition. Nothing else in this decision is safe until types
   are trustworthy.
2. **Widen the signature** to `policyAllows(policy, cap, subject, resource?)`
   where `resource` carries `{requestType, unit, libraryId, discipline}`. Make
   `caps` entries `{tokens: string[], when?: {...}}` — an absent `when` behaves
   exactly as today, so shipped defaults stay byte-compatible. **All four call
   sites move together** — `lib/workflow.ts:65`, `lib/holds.ts:100`,
   `components/permissions/ViewAsSimulator.tsx:128`, and the SQL
   `org_capability_allows` — or `WF-7`'s divergence gets worse.
3. **Add `requests.requires_engineer_approval` as a real capability** so the
   gate at `lib/workflow.ts:37-43`, which is currently hardcoded and consults no
   capability, becomes configurable.

**Acceptance.**
- An org can express "ASBUILT requests may only be approved by DocCtrl" and it is
  enforced server-side.
- An org that has configured nothing behaves identically to today.
- The simulator reports the same answer the route enforces, for a resource-scoped
  capability.

**Reversal.** None expected — this is additive and backward-compatible by design.

**Risk:** high — signature change across four evaluators.

<a id="dec-14"></a>
## DEC-14 · `CANCELED`, `NEW`, `PENDING_ENG_INITIAL`

**Decision. Implement `CANCELED`. Remove `NEW` and `PENDING_ENG_INITIAL`.**

**Rationale.** `CANCELED` is documented to users as a real state in
`WorkflowDiagramModal.tsx:36` and no action produces it — a request that cannot
be cancelled is a genuine product gap, and users have been told otherwise.
`NEW` and `PENDING_ENG_INITIAL` are unreachable because `getInitialStatus` always
returns `PENDING_ASSIGNMENT` and all three creators set status explicitly; there
is no product intent behind them and no stored data references them.

**Implementation.** Add a `cancel_request` action from `PENDING_ASSIGNMENT` and
`DRAFTING`, available to the requester identity and to `ticket.manage`, requiring
a comment. Remove `NEW` and `PENDING_ENG_INITIAL` from `types/schema.ts`,
`WorkflowDiagramModal`, `lib/ticketRouting.ts:98-100` and
`lib/ticketAttention.ts:100-102`. Check for existing rows in those statuses
first — if any exist, migrate them to `PENDING_ASSIGNMENT` and say so.

**Acceptance.** A requester can cancel their own open request with a reason; the
cancellation is audited; no code path references the two removed statuses.

**Reversal.** If a two-stage intake is ever wanted, `PENDING_ENG_INITIAL` is
cheaper to reintroduce than to keep half-alive.

**Risk:** medium.

<a id="dec-15"></a>
## DEC-15 · Does a reopen start a new revision cycle?

**Decision. Yes. `reopen_ticket` increments `revision_count`, resets
`draft_iteration` to 0, and nulls `deliverable_rev`, so the next submission is
`3A` and the next approval `3`.**

**Rationale.** The alternative — barring reopen once issued — is cleaner in
theory and worse in practice: people reopen because something is wrong with a
distributed package, and removing the affordance pushes them to a raw PATCH
(`WF-2`), which produces no audit row at all. Renumbering is the honest outcome:
two materially different construction packages must not both be "Rev 2", and the
public QR endpoint must not report a drawing as current while it is back under
review.

**Implementation.** Three lines in `lib/ticketTransitions.ts:288-290`. Separately,
add `engineer_approved_at` to the `approve_minor_correction` case when the ticket
is at `PENDING_FINAL_APPROVAL` — today the engineering sign-off indicator stays
"pending" forever on a ticket the engineer did approve.

**Acceptance.**
- Two approvals of the same ticket produce different issued revision labels.
- A reopened ticket does not verify as "current" at `/api/verify-ticket`.
- The engineering sign-off dot resolves after a minor-correction approval at
  `PENDING_FINAL_APPROVAL`.

**Reversal.** If renumbering confuses the field more than duplicate labels do,
bar reopen after issue and add an explicit "supersede this deliverable" action
instead.

**Risk:** medium — changes revision numbering on reopened tickets.

<a id="dec-16"></a>
## DEC-16 · The `requesterRole` snapshot

**Decision. Keep the snapshot as a historical record, and make the gate fail
closed on either value: require engineer approval if **either** the snapshot
**or** the requester's current role requires it.**

**Rationale.** A live lookup is the theoretically right answer and changes
behaviour on every in-flight ticket at once — some would suddenly demand an
engineer mid-flight, with no migration window. The fail-closed disjunction fixes
the actual defect (a stale-*high* snapshot short-circuits before the current role
is examined, so the snapshot only ever fails **open**) with no flag day.

**Implementation.** In `getActions`, pass the requester's current
`org_members` role alongside `ticket.requesterRole` and require approval if
either says so. Document the rule at `types/schema.ts:1120` and in the
`lib/workflow.ts:30-36` comment block, which today reads as if the value were
live.

**Acceptance.** A demoted requester's in-flight tickets no longer bypass the
engineer gate; a promoted engineer's old tickets still do not require one.

**Reversal.** Move to a pure live lookup once someone is available to watch a
flag day.

**Risk:** low.

*Landed 2026-09-02 (roles-and-permissions Round D1): `engineerApprovalRequired(snapshot, currentRoles)` in `lib/workflow.ts`; the route looks the requester's current collection up on every action, the page best-effort. See `WF-12`, `DRAFT-3`.*

---

# Non-document surfaces

<a id="dec-17"></a>
## DEC-17 · Twenty admin surfaces, ten role gates

**Decision. Fix the two surfaces where the gate is a curtain over an open
table. Do not consolidate the other eighteen as part of this audit.**

**Rationale.** The census in `SURF-9` is real but most of it is inconsistency,
not exposure — a client gate that is stricter than its API is untidy, not a hole.
Two entries are genuine exposure and are worth fixing on their own:
`/admin/audit` (a Viewer can read the entire org audit trail, including
`CAPABILITY_POLICY_CHANGED` payloads, straight from PostgREST) and the asset
tables (`FOR ALL` to every member, behind a notice claiming otherwise — a Viewer
can delete the equipment registry).

Consolidating twenty pages onto one authority hook is a coherent project, but
doing it inside an audit remediation means twenty surfaces changing behaviour at
once with no reviewer.

**Implementation.** Add a RESTRICTIVE SELECT policy to `audit_logs` matching the
roles its own page claims. Add RESTRICTIVE write policies to `assets`,
`asset_types`, `asset_photos`, `plot_plans`. Fix the `/admin/settings` client
gate to match its Admin-only API. Leave the rest documented.

**Acceptance.** A Viewer cannot read `audit_logs` or write asset tables via
PostgREST; the `/admin/settings` gate and its API agree.

**Reversal.** The consolidation stays available as separate work — this decision
defers it, it does not reject it.

**Risk:** medium.

<a id="dec-18"></a>
## DEC-18 · Is subscription state enforced server-side?

**Decision. Wire `assertOrgHasAccess` into the routes its own comment names, with
enforcement **defaulting to off** via an explicit env-gated flag. Live code path,
inert behaviour, until someone turns it on deliberately.**

**Rationale.** A helper with zero callers is dead weight and drifts. But turning
on server-side subscription enforcement in an audit remediation could lock a
paying customer out of their own document control system over a billing
webhook — a catastrophic failure mode for a regulated record. Wiring it inert
gets the code exercised and reviewed without that risk.

**Implementation.** Add the calls; gate the *refusal* behind the flag; log what
it *would* have refused so someone can see the blast radius before enabling.

**Acceptance.** With the flag off, behaviour is byte-identical to today, and the
log shows what enforcement would have blocked.

**Reversal.** Enable the flag once the log shows a clean week.

**Risk:** low.

<a id="dec-19"></a>
## DEC-19 · `access_requests` — build the surface or remove the feature?

**Decision. Fix the security defects and build the minimal surface. Do not remove
the feature.**

**Rationale.** The security defects are unambiguous and independent of the
product question: the SELECT policy has no `org_id` correlation, so any Admin of
any workspace reads every access request in the database, and the public insert
route is unrate-limited while `/api/auth/signup` next to it is. Those get fixed
regardless. Having fixed them, the remaining state — requests collected and never
shown — is the worst of both worlds, and the surface is a list view.

**Implementation.** Add the org correlation to
`access_requests_admin_select`. Rate-limit `/api/auth/request-access` using the
existing `signup_attempts` pattern. Resolve the `org_id` column drift between the
backfill migration and the route. Add a pending-requests list to `/admin/users`.

**Acceptance.** An Admin sees only their own org's requests; the public route is
rate-limited; a submitted request appears to an Admin.

**Reversal.** If nobody uses the surface, removing the feature later is cheap —
the data model is one table.

**Risk:** low.

<a id="dec-20"></a>
## DEC-20 · What is the revocation model?

**Decision. Both. Add a DELETE policy on `org_members` for hard removal, and ship
a real suspend that writes `status = 'suspended'`. Suspend is the default action
in the UI; delete is behind a confirmation.**

**Rationale.** Today neither works — there is no DELETE policy anywhere, and
nothing in the codebase ever writes `'suspended'`, so both revocation doors are
shut and the UI reports success for a no-op. A regulated system needs the
non-destructive path (an investigation may need the membership record) and the
destructive one (a person genuinely leaving).

**Implementation.** ⚠ **This must ship with `OWN-12` (owner succession).** Today
removal is a no-op, so the dangling-owner problem is latent; making removal work
makes it live, and every library, folder and document owned by the removed person
starts resolving to a uuid that cannot log in — while the notification routers
suppress the controller fallback because they key on the owner *existing*.

Also fix `my_team_ids()`, which has no `status` filter — so today a suspended
member keeps every team-derived ACL grant.

**Acceptance.**
- Removing a member ends their access, and a refused removal surfaces an error
  rather than a disappearing row.
- A suspended member cannot act and their team grants stop applying.
- Removal clears or reassigns everything they owned, and audits it.
- Last-admin protection holds against both paths.

**Reversal.** None — both paths are required.

**Risk:** high — pair with `OWN-12`.

<a id="dec-21"></a>
## DEC-21 · Reviewer independence

**Decision. A per-library policy, defaulting to **on** for any library that has a
required-review roster configured, and off for libraries that do not.**

> **Stated default.** Whether single-person review is acceptable is a business
> call. Tying the default to "did you bother to configure a roster" is the
> reading that matches intent without a flag day.

**Rationale.** A global rule would break low-criticality libraries where
single-person review is legitimate. Defaulting on wherever someone has
deliberately configured reviewers matches what configuring a roster means. The
review-completion guard is the right home — it already runs above the role
short-circuit, deliberately, because it is a data-integrity gate rather than an
authority one.

**Implementation.** In `enforce_document_publish_guard`'s completion check, when
the actor is themselves a signer on the version's roster, require at least one
signed primary who is not the actor. Surface the setting where the roster is
configured so it reads as a visible policy rather than an invisible gap.

**Acceptance.** A sole signed primary cannot publish their own revision in a
roster-configured library; a signer alongside an independent primary can; a
library with no roster is unaffected.

**Reversal.** Per library, via the policy.

**Risk:** medium.

---

# Document lifecycle

<a id="dec-22"></a>
## DEC-22 · The shape of the ticket → document hand-back

**Decision. An explicit, authority-gated "Publish as revision of DOC-xxx" action
on the ticket, offered to whoever holds publish authority **on that document's
library** — not to whoever can close tickets. It pre-seeds the existing rev-up
flow and then runs `revUpDocument` unchanged. Never auto-publish on close.**

**Rationale.** Auto-publish-on-close is the obvious design and it is wrong: it
bypasses the publish guard, the MOC gate and the review gate in one move, on
exactly the documents where those matter most. Routing through the existing flow
means every guard and every post-publish side effect applies with no new code
path to keep in sync. Gating on library publish authority rather than ticket
authority is the point — closing a ticket and publishing a controlled revision
are different powers.

**Implementation.** When a ticket carries `metadata.source_document.id` and a
`Final` attachment, offer the action to a caller satisfying
`canPublishOnLibrary`. Pre-seed: the Final file, `issue_type` per `DEC-26`, the
MOC reference from `metadata.moc`, and a change log naming the ticket number.
Then call `revUpDocument` — do not reimplement any of it. `runPostPublishSideEffects`
must fire, or the as-built is a revision nobody has to acknowledge.

**Do not** set `related_ticket_id` expecting it to be inert — see `DEC-23`, which
must land first.

**Acceptance.**
- Publishing from a ticket produces a `document_versions` row whose `change_log`
  names the ticket, refused by `assertCanPublishRevision` when a hold is active.
- `runPostPublishSideEffects` fires, verified by a fresh ack roster and a
  supersede notification.
- Closing a ticket that has a source document and produced no revision leaves a
  visible, queryable "deliverable not yet in the register" state.

**Reversal.** None expected.

**Risk:** high — new publish path.

*Landed 2026-09-02 (roles-and-permissions Phase 7 build 4 / Round C2): built on this shape — see `GAP-6`, `LIFE-1`, `LIFE-5`, `LIFE-11`; migration `20261049`. There is no new publish path: the ticket pre-seeds `RevUpModal` and `revUpDocument` runs unchanged.*

<a id="dec-23"></a>
## DEC-23 · The `related_ticket_id` review waiver

**Decision. Delete the waiver branch at `lib/reviewControl.ts:60` outright. Write
the column for provenance only. A ticket approval never satisfies a document
sign-off.**

**Rationale.** The stated rationale for the waiver — *"they don't need, or
already had, review"* — is false. Ticket approval is `approve_draft_ifc` by the
requester or an engineer; it is not the document's reviewer roster, it is not
bound to the file's `content_hash`, and it produces no e-signature on the version.
The narrow alternative (honour it only when the approver is on the roster **and**
the approval is bound to the same content hash) is defensible but is a much
harder claim to verify, and nothing composes those checks today. Deleting the
waiver costs one extra review round on ticket-originated revisions and removes a
loaded gun pointed at the review gate.

**This is the highest-priority item in the lifecycle area** and must land before
any work on `DEC-22` / `GAP-6`.

**Implementation.** Remove the branch. Update
`lib/__tests__/reviewControl.test.ts:42`, which currently asserts the waiver as
correct behaviour. Keep writing `related_ticket_id` — it is what makes "which
redline caused this revision?" answerable.

**Acceptance.**
- A ticket-originated revision in a `mode: "require"` library opens a reviewer
  roster — proven by `document_review_signoffs` row count > 0.
- No production call to `effectiveModeForRevUp` can waive review because a ticket
  id is present.

**Reversal.** If the extra round proves genuinely redundant, reintroduce it as
the narrow roster-plus-hash condition — never as "a ticket id exists."

**Risk:** medium.

<a id="dec-24"></a>
## DEC-24 · Where does markup live?

**Decision. Server-side, as normalized per-page fabric JSON, keyed to
`(document_id, version_id, user_id, checkout_session_id)`, autosaved as the user
draws. The baked PDF becomes a derivative of stored state, not the only copy.**

**Rationale.** Markup on a controlled document is evidence — for a PSM record
that must survive an audit years later, the redline that justified a change *is*
the justification. Today it lives in React state and one browser-local blob that
`takeDraft` **deletes on read**, so a page refresh destroys it silently. The
viewer already produces exactly this shape and already normalizes to scale 1.0;
the persistence hooks already exist on the component
(`initialPageStates` / `onPageStatesChange` / `onCommit`) and the only render
site passes none of them.

**Implementation.** Wire the three existing hooks. Seed `initialPageStates` on
open so a reopened sheet shows the user's own redlines. Make `takeDraft`
non-destructive, or scope its deletion to successful ticket creation.

**Acceptance.**
- Closing and reopening the viewer on the same document and version restores the
  markup.
- Refreshing `/requests/new?draft=…` before submitting still yields the attached
  marked-up file.
- A markup is discoverable from the document without the user having downloaded
  anything.

**Reversal.** None — the current behaviour is data loss.

**Risk:** medium.

*Landed 2026-09-02 (roles-and-permissions Phase 7 build 1 / Round C4): built on this shape — see `GAP-7`, `LIFE-3`; migration `20261051`. Autosave is per page switch and on close (the viewer reports page states as they change); a keystroke-level save is deliberately not added.*

<a id="dec-25"></a>
## DEC-25 · A ticket closing over its own open hold

**Decision. Block the close until the hold is explicitly addressed. Never
auto-release. Record `holdId` in `outcome_ref` as the migration already
specifies, so the two are linked at all.**

**Rationale.** Releasing a safety hold must stay a deliberate act — auto-release
on close is exactly the kind of convenience that defeats a PSM control. But
allowing a silent close leaves the document permanently frozen with an open block
nobody can trace to a resolved cause, which is how it fails today. Blocking with
a clear path (release it, or state why it stays) is the only option that keeps
both properties.

**Implementation.** Populate `outcome_ref.holdId` when the hold offer is taken —
the migration at `20261012:27-29` already documents that field and the code simply
does not write it. Give holds an optional originating-ticket reference. On close,
if an originating hold is still active, require the closer to either release it
or record a reason it remains.

**Acceptance.** `outcome_ref.holdId` is populated; a hold shows its originating
ticket and vice versa; closing a ticket with an open originating hold cannot
happen silently.

**Reversal.** None.

**Risk:** medium.

<a id="dec-26"></a>
## DEC-26 · Does an as-built ticket classify its own output?

**Decision. Yes. A revision published from a ticket whose `request_type` is
`ASBUILT` defaults `issue_type` to `"As-Built"` — visibly, in the pre-seeded
form, and overridable with intent.**

**Rationale.** The system knows a document needs to be as-built at three points
and forgets at each boundary; `issue_type` ends up a free choice a publisher makes
weeks later with no knowledge of the ticket. Defaulting it from the origin is the
whole content of "it needs to be as-built." Visibly rather than silently, because
a silent default on a compliance classification is its own problem.

**Implementation.** Part of `DEC-22`'s pre-seeding. The Lifecycle board's
As-Built column then reflects as-built tickets that completed.

**Acceptance.** Publishing from an `ASBUILT` ticket produces
`issue_type: "As-Built"` without the publisher selecting it, and the value is
visible and changeable before publishing.

**Reversal.** None.

**Risk:** low.

---

# Protocol — how an autonomous agent behaves

These replace the parts of the resolution protocol that assumed a human reviewer.
They are not softer; they move the burden from *asking* to *proving*.

<a id="dec-27"></a>
## DEC-27 · What replaces "stop and ask a human"?

**Decision. There is still a halt condition — it just does not involve waiting.
When you hit one, set the finding's `Status: BLOCKED`, append a `Blocker` block
saying precisely what is unresolvable and what you tried, and **move to the next
finding.** Never stall, never guess past it, never silently skip it.**

Halt on exactly these:

1. **The finding does not reproduce.** → `INVALID`, not `BLOCKED`. See `DEC-28`.
2. **The fix would require changing something in a "Verified sound — do not
   break" section.** Those are load-bearing invariants; a fix that needs one
   changed is a design error in the fix.
3. **Two readings of the finding give materially different behaviour and the code
   does not settle it.** Record both readings in the `Blocker`.
4. **The fix requires observing live database state you cannot see.** → see
   `DEC-30`.
5. **The blast radius exceeds the scope rule.** → see `DEC-31`.

A `BLOCKED` finding is a *result*, not a failure. It is more valuable than a
guessed fix, and far more valuable than silence.

**Acceptance.** Every finding you touch ends `RESOLVED`, `INVALID`, `WONTFIX` or
`BLOCKED` — never `IN_PROGRESS` at the end of a session, and never untouched
without a note.

<a id="dec-28"></a>
## DEC-28 · `WONTFIX` and `INVALID` without sign-off

**Decision. Both are available to you without approval. Both require evidence, in
the `Resolution` block, that a reader can check without re-doing your work.**

- **`INVALID`** — the mechanism does not hold against current code. Quote the
  code that contradicts the finding, with `file:line`. "I could not reproduce it"
  is not evidence; "line 84 now includes `owner_user_id`, so the guard does fire"
  is.
- **`WONTFIX`** — real, but deliberately not fixed. State the cost, the
  alternative you rejected, and what would change the answer. `WONTFIX` on a
  `CRITICAL` needs a second, independent verification pass recorded in the block
  before you use it.

**Rationale.** The old rule required a human sign-off for `WONTFIX` on
`CRITICAL`/`HIGH`. With nobody to sign, the substance of that gate — that a
severe finding is not dismissed casually — is preserved by requiring independent
re-verification instead.

<a id="dec-29"></a>
## DEC-29 · The evidence bar for `RESOLVED`

**Decision. Nobody is going to review your work, so the evidence has to stand on
its own. All five, every time:**

1. **Reproduce first.** Before changing anything, demonstrate the finding is real
   against current code. If it is not, stop — that is `INVALID`, and it is a
   valid outcome.
2. **Test first where testable.** Logic, data layer and API authorization
   findings get a failing test before the fix and a passing one after. Name the
   test in the `Resolution` block. If genuinely untestable, say so and explain how
   you verified instead.
3. **The `Done when` criteria hold** — all of them, checked individually.
4. **The ship loop passes:** `npx tsc --noEmit` → `npx eslint <touched files>` →
   `npx vitest run` → full `next build`. A finding is not resolved if the build is
   red.
5. **Nothing in "Verified sound" changed.** Diff-check it.

<a id="dec-30"></a>
## DEC-30 · Migrations and unobservable database state

**Decision. Migrations in this repo are applied BY HAND. Never assume a migration
is applied, and never mark a finding `RESOLVED` on the strength of a migration
file existing.**

For a fix that needs a schema or policy change:

- Write the migration file **and** paste the complete SQL in your response.
- Set `Status: RESOLVED` only for the code half. Add an explicit
  `Pending migration:` line naming the file. The finding is not fully closed until
  someone applies it — say that plainly rather than implying otherwise.
- Where a fix depends on data you cannot observe (how many rows carry an
  `acl_index` deny, how many members hold a secondary DocCtrl), **write the
  inventory query into the `Resolution` block** and mark the finding `BLOCKED`
  with that query as the unblocking step. Do not proceed on an assumption about
  production data.
- `DB-1` is the canonical case: it has two possible worlds — migration applied
  (holds are broken in production) or not applied (two security rails silently do
  not exist). Which one you are in changes what you do next, and you cannot tell
  from here.

<a id="dec-31"></a>
## DEC-31 · The scope rule

**Decision. Fix the finding, not the neighbourhood. If a fix would touch more
than roughly five files, or would change a public function signature used in more
than three places, stop and split it: implement the narrowest piece that makes the
`Done when` criteria hold, mark the finding `RESOLVED` for that piece, and open a
new finding with the next free ID in the same report for the remainder.**

**Rationale.** The old rule said "stop and ask a human" at this boundary. The
boundary itself is still right — a sweeping refactor with no reviewer is how an
audit turns into an outage. What changes is that you split the work instead of
waiting on it.

**A finding that describes a systemic pattern is not an instruction to convert
every call site.** `CHAIN-2` describes ~237 singular-role reads to explain *why* a
specific defect exists — it is not authorization to touch 237 call sites. When a
report says a change is "a signature change across four evaluators", ship those
four together and nothing else.

<a id="dec-32"></a>
## DEC-32 · Claiming work so parallel agents do not collide

**Decision. Claim at the report-file level, not the finding level. One agent owns
one report file at a time, end to end.**

Before starting, set the file's own header line to
`> **CLAIMED** <agent-or-session-id> <ISO timestamp>` and commit that first. On
finishing, remove it in the same commit as your resolutions. A claim older than
24 hours is stale and may be taken over — say so in your `Resolution` block if you
do.

**Rationale.** Findings within a report share code paths and often share a root
cause; two agents in the same file will conflict on the same source files even
when working different IDs. File-level claiming is coarse enough to be safe and
fine enough to parallelize — there are 16 report files across the two areas.

**Do not** work two areas at once, and **do not** work a report whose
dependencies in `99-fix-sequencing.md` are unmet.

---

# The review model

These eight decisions were made after the drafting-flow audit, in response to
stated policy from the system's owner. They are the ones an agent is most likely
to get backwards, because the intuitive design — add a reviewer, add a status —
is the wrong one in every case.

Two of them (`DEC-33`, `DEC-35`) override earlier guidance in the drafting-flow
gap register. Where they conflict, these win.

<a id="dec-33"></a>
## DEC-33 · What makes engineering review required?

**Decision. Engineering review is the DEFAULT. Exactly one thing removes it: the
requester declares, at intake and in their own name, that the work is
like-in-kind. The drafting manager who assigns the ticket may add engineering
back at any point before drafting starts; the drafting manager may NEVER remove
it.**

This is a ratchet, and the direction matters:

| Who | May raise rigor | May lower rigor |
|---|---|---|
| Requester | yes (declare new design) | yes — **by taking responsibility for the claim** |
| Drafting manager / assigner | yes (flag for engineering) | no |
| Anyone else | no | no |

**Rationale.** The stated policy is *"only use engineered packages unless the
requester has declared on request this is like-in-kind — meaning it is inferred
this was already engineered at some point, we are putting back exactly the same,
we just need to replace something."*

That sentence contains the whole design. Like-in-kind is not a *category of
work*, it is a **claim about work already engineered**. The person who knows
whether the thing going back is identical to the thing that came out is the
requester — they are standing in front of it. So the requester is who declares,
and the declaration is what removes the engineering requirement.

The assigner's flag is the check on that claim, and it costs **zero waits**: a
drafting manager already sits at `PENDING_ASSIGNMENT` on every ticket. Reading a
one-line declaration while assigning is not a new stop. This is why the model
works — the reviewing party was already in the loop.

The asymmetry is deliberate. Lowering rigor requires someone to put their name on
a factual claim. Raising it requires nothing, because a false positive costs one
engineer's glance and a false negative can put an unengineered package in the
field.

**Consequence for the code.** `requiresEngineerApproval(requesterRole)`
(`lib/workflow.ts:37-43`) is the inversion this decision deletes. Engineering is
required or not because of **what the work is**, never because of **who asked**.

**What "required" gates: delivery, not drafting.** Stated by the owner as *"no
deliverable without official approval."* The requirement is a condition on the
**issue transitions** — `approve_draft_ifc`, `engineer_approve_final`,
`submit_final`, `approve_minor_correction` — not a stage inserted before work may
begin. Drafting proceeds in parallel with the approval roster; only issuing
waits.

This is not a softening. It is the same safety outcome one wait state cheaper: a
drafted package that later needs changing is what revisions are for, whereas a
drafter idle behind a scope note is pure loss. `PENDING_ENG_TEAM` remains
available as an *optional* pre-drafting scope review for an assigner who wants
one before spending the hours — it must not be the only route to requiring
engineering, and must not be mandatory.

**And approval goes to routed people, plural.** The assigner flags; the router
(`DEC-36`) resolves who. Requiring the assigner to hand-pick one engineer —
today's `requiresEngineerPick: true` — is a routing question dressed as a
judgement call, and it caps official approval at one person when the library and
the work class may require several. Hand-pick survives only as the fallback for
an org with no routing configured.

**Implementation.** Two persisted fields, both first-class columns:

- `like_in_kind_declared_at` / `_by` / `_statement` — set only at creation, only
  by the requester, never editable afterwards.
- `engineering_required` — set true at creation when no like-in-kind declaration
  exists; settable true (never false) by `request_eng_review`.

`getActions` reads `ticket.engineeringRequired`, not `ticket.requesterRole`.

> **Half of this already exists.** `request_eng_review` is already an action at
> `NEW` and `PENDING_ASSIGNMENT`, already requires a comment and an engineer
> pick, and already persists `assigned_engineer_id`,
> `engineer_review_requested_at` and `engineer_review_reason`
> (`lib/ticketTransitions.ts:179-189`). What it does **not** do is bind the
> approval end — `PENDING_REVIEW` consults only `requesterRole`, so a flagged
> ticket can still be self-approved to IFC by a Manager requester. The missing
> piece is one persisted boolean, not a feature.

**Acceptance.**
- A ticket with no like-in-kind declaration cannot **issue** without the
  engineering slot satisfied, whoever the requester is — Manager included.
- Every issue transition is gated, `approve_minor_correction` included.
- Drafting on a flagged ticket is not blocked; the roster runs alongside it.
- A ticket with a declaration reaches IFC through the assigner, with no engineer
  involved and no additional wait state.
- `request_eng_review` on a declared like-in-kind ticket sets
  `engineering_required = true` and it stays true.
- No action anywhere sets `engineering_required` from true to false.

**Reversal.** If a facility wants the assigner to be able to waive engineering,
that is a router slot property (`waivable_by`), added then — not a code branch.

**Risk:** high — this is the gate.

<a id="dec-34"></a>
## DEC-34 · What form does the like-in-kind declaration take?

**Decision. A typed statement, not a checkbox and not a dropdown value —
recorded as an **e-signature**, with the ticket carrying a pointer to it plus
denormalized columns for querying. Never in `metadata`.**

> **Strengthened after the deep audit.** The original decision said "first-class
> columns" and that is still necessary — but it is **not sufficient**, and the
> reason is `SM-2`/`PERS-1`/`AUTHZ-2`: `tickets` carries one `FOR ALL` policy
> with no `WITH CHECK`, so any active org member can rewrite any ticket column
> directly through the REST endpoint. A declaration stored only as a ticket
> column is a claim anyone in the org can forge or erase.
>
> `lib/eSignatures.ts` already exists, is the strongest evidentiary artifact in
> the system, and is the right home: the signature is the record, the column is
> a convenience. Choosing like-in-kind at intake runs the signature ceremony
> against `{resourceType: 'ticket', resourceId}` with the like-in-kind sentence
> as the statement, and the returned id is stored on the ticket.
>
> ⚠ `EVID-3` says e-signatures are themselves written directly by the browser
> with client-supplied identity. **Fix `EVID-3` before leaning on signatures for
> this**, or the stronger record inherits the weaker one's problem.

The requester types what is being replaced with what. Minimum length enforced.
No canned text, no preset options.

**Rationale.** This is the exact bar `lib/checkinOutcomes.ts` already sets for
every claim-creating branch of check-in: *"every claim-creating branch requires a
TYPED note (no canned text, no get-out-of-jail-free cards — same bar as
`approve_minor_correction`)"*. That module already models replacement-in-kind
correctly, already derives an MOC position from the declared doc class, and is
pure and unit-tested. **The vocabulary and the standard both already exist in
this codebase — on the check-in door only.**

A checkbox is clicked without reading. A sentence someone has to compose is a
statement they can be held to, and it is the artifact a regulator asks for.

**On `metadata`.** `CheckInPanel` already writes
`metadata.moc`, `metadata.minor_correction` and `metadata.undocumented_change`
(`components/documents/CheckInPanel.tsx:263-266`). A repo-wide search finds **no
reader of any of them** for any authority decision. Untyped JSON that nothing
enforces is a record, not a control. The declaration must be a column that
`getActions` reads.

**Acceptance.**
- The declaration cannot be saved empty or with fewer than ~20 characters.
- It renders on the ticket, on the deliverable, and in the audit trail, attributed.
- It cannot be edited after creation by anyone, including an admin. A wrong
  declaration is corrected by the assigner flagging engineering, which is
  recorded as an override rather than a rewrite of history.

**Reversal.** The minimum length is a preference. The typed-not-clicked shape is
not.

**Risk:** low.

<a id="dec-35"></a>
## DEC-35 · No facility vocabulary in application code

**Decision. No file under `app/`, `lib/`, or `components/` may branch on a
facility-specific role name, review name, or code name. Not `QAQC`, not `B31.3`,
not `NDE`, and not `DraftingSupervisor` as a routing target. Routing is data.**

Code knows **slot kinds** and their properties. It never knows what a facility
calls the person who fills one.

**Rationale.** Stated requirement, verbatim: *"I dont want to bake in anything
that says qaqc I rather have dynamic router a router configuration. Having it
baked into roles boxes the app in to names and conventions other people dont
subscribe to at their facility."*

This is correct and it is also the fix for a defect the roles audit already
found independently: role identity is unversioned customer-editable JSON
(`DEC-5`), so a facility that renames a role silently breaks every code branch
that string-matches it. `isEngineerRole` matching the **substring** `"Engineer"`
(`lib/workflow.ts:17-19`) is the clearest instance — it is one rename away from
matching nothing, or from matching a facility's "Engineering Clerk".

**Implementation.** Existing name-matching helpers are **quarantined, not
deleted**: `isEngineerRole`, `isManagementRole`, `isDocCtrlRole` become the
seeded default routing configuration for an org that has never configured one, so
behaviour on upgrade is unchanged. New code calls the router.

**Do not** delete the helpers in the same change that introduces the router. A
facility with no configuration must keep working exactly as it does today.

**Acceptance.**
- `grep -rn 'QAQC\|B31\|NDE\|radiograph' app lib components` returns nothing
  outside seed data, test fixtures and user-visible copy.
- An org can define a slot called anything, fill it from any role or named
  person, and the drafting flow honours it without a code change.
- An org that has configured nothing behaves byte-for-byte as it does today.

**Reversal.** None available. This is a structural constraint, not a preference.

**Risk:** medium — wide, but mechanical.

<a id="dec-36"></a>
## DEC-36 · Where the routing table lives, and how it resolves

**Decision. As a `routing_control JSONB` column on `libraries`, `collections`
and `documents` — exactly where `review_control` and `doc_class` already live —
resolved through the container chain: document → folder → library, most specific
DEFINED level wins.**

> **Revised.** An earlier version of this decision said `org_configurations`
> under a new key. That is wrong in a way worth naming, because the reasoning
> looked sound: `org_configurations` already holds the drafting form's request
> types with an admin editor, so one more key seemed free.
>
> It is not free. Routing must resolve **per container** — that is the whole
> point of "route this drawing type to the doc control of that library". A
> per-org blob would need its own library→rule index, maintained by hand, in
> parallel with the chain walk `review_control` and `doc_class` already do
> natively. Two mechanisms for one question is how they drift.
>
> Put it where its neighbours are. The migration mirrors `20261012` (doc_class)
> line for line, is additive and idempotent, and inherits the existing
> per-table RLS on `libraries` / `collections` — no new policies.
>
> Note also: the column on `org_configurations` is **`data`**, not `value`
> (`supabase/schema.sql:52-59`). An agent writing to `value` gets a runtime
> error, not a type error.

**Rationale.** Stated requirement: *"this assign should exist in the doc ctrl so
we could use it here."* That is right, and the substrate is already built:

| Piece | Where | Why it fits |
|---|---|---|
| Per-org JSON config with an admin editor | `org_configurations` (`org_id`,`key`,`data`); editor at `app/(protected)/admin/requests/page.tsx` | The drafting form's request types, units and priorities are already org-configured this way. A router is one more key. |
| Container-chain resolution | `resolveEffectiveDocClass` (`lib/docClass.ts:49-58`) | Three lines, already the house pattern, already mirrored by `review_control`. Copy the shape exactly. |
| Reviewer slots with primaries, alternates, timeouts | `lib/reviewControl.ts` | The roster mechanics are done. The router decides *which* roster applies. |
| Per-person grants with expiry | `lib/capabilityPolicy.ts:98-110` | Fills a slot with a named person rather than a role. |

**Two properties of `docClass.ts` must be copied, not just its shape:**

1. **Declared, never guessed.** *"guessing from filenames would misroute
   safety-critical documents."* A router must never infer a slot from a title.
2. **Fail closed on transient error.** *"'we couldn't check' must never silently
   read as 'no class declared' — that's how a PSM gate quietly turns itself
   off."* A router that cannot load its configuration must block, not default
   to permissive.

**Do not** create a new table. **Do not** write a second resolution function —
if the chain walk is duplicated it will drift, and the two will disagree about
which library governs a document.

**Note a real defect while you are here:** the admin config editor's access guard
is client-side only — `router.push('/dashboard')` in a `useEffect`
(`app/(protected)/admin/requests/page.tsx:63-67`) — with the write going straight
to `org_configurations` via `supabase.upsert`. Whether that is exploitable
depends on the table's RLS, which must be checked before the router is stored
there. A routing table with a weaker guard than the roles it routes is worse than
no router.

**Acceptance.**
- One resolver, unit-tested against the same cases as `resolveEffectiveDocClass`.
- A library-level rule applies to every document in it; a folder-level rule
  overrides for that folder; a document-level rule overrides for that document.
- A config load failure blocks the transition with a legible message.

**Reversal.** The storage key is a detail. The single-resolver rule is not.

**Risk:** medium.

<a id="dec-37"></a>
## DEC-37 · One person, many hats

**Decision. A person may satisfy any number of routing slots simultaneously.
Independence is a property of a SLOT, not of a person. This amends `DEC-12`.**

`DEC-12` stands as written — its three predicates are about **one deliverable's
producer versus its checker**, which is a real control. What it must not be read
to mean is that a person who holds two functions may only exercise one.

**Rationale.** Stated fact from the system's owner: *"where I work im the
drafting manager and the qaqc so I can approve a drawing. But that might not be
true elsewhere."*

That is the normal condition in a mid-size facility, not an edge case. A model
that assumes one function per person is wrong about how plants are actually
staffed, and a system that enforces it teaches people to route around it — which
is the failure this whole audit exists to prevent.

The genuine control is narrower and survives hat-stacking intact: **the person
who produced a deliverable may not be the person who accepts it.** That is about
one artifact and two acts, not about job titles.

**Implementation.** Each slot in the routing configuration carries an optional
`independent_of: string[]` naming other slot kinds it may not share an occupant
with. Seeded default: the approval slot is `independent_of: ["drafter"]` and
nothing else is constrained. `DEC-12`'s member-count derivation still gates
whether independence is enforced at all.

**Acceptance.**
- One person holding both the assigner slot and the quality slot satisfies both
  with one action, and the record shows both were satisfied and by whom.
- The same person cannot both draft a deliverable and accept it, in an org above
  the `DEC-12` threshold.
- A blocked action says which independence constraint blocked it. A missing
  button is not an explanation.

**Reversal.** Per-slot, in configuration.

**Risk:** medium — reduces enforcement relative to a naive reading of `DEC-12`,
deliberately.

<a id="dec-38"></a>
## DEC-38 · A consent window may not advance without a delivery record

**Decision. If the system cannot prove it told someone, the clock does not
start. No delivery record, no silent advance — the ticket waits and says why.**

**Rationale.** Stated requirement: *"there needs to be warnings. The system has
to log it was available to them and it didnt get taken care of."*

This is the load-bearing condition under `GAP-109`. "Nobody objected" is only a
defensible record if "everybody was asked" is a fact on disk. Otherwise
silence-is-consent degrades into advancing work nobody ever saw, which is
strictly worse than the backlog it replaces.

**The substrate exists and is currently unsafe for this purpose.** The
`notifications` table already stores one row per (recipient, event) with a
`read_at` column — that is exactly the "it was available to them, and whether
they looked" record. But `notify()` is **fire-and-forget with the error
swallowed**:

```ts
// lib/inAppNotifications.ts:79-97 — "Fire-and-forget by design"
if (error) console.warn("[notify] insert failed", error.message);
```

For the bell icon that is the right call. For a consent window it is
disqualifying: the insert can fail, nobody is told, and the clock runs anyway.

**Implementation.** Consent-window notifications take a different path from
bell-icon notifications: awaited, error-checked, retried, and the window's start
timestamp is written **in the same transaction as** the delivery rows. If the
rows cannot be written, no timestamp is written and the ticket stays put with a
visible reason.

> ⚠ **`notifications.read_at` is NOT usable as evidence today, and this is not a
> theoretical objection.** `app/api/tickets/workflow-action/route.ts:324-332`
> mass-stamps `read_at` on **other users'** unread rows for the ticket on every
> transition (`EVID-13`). So "they opened it" is already destroyed by any
> subsequent workflow action — the very thing a consent window is racing.
>
> **`EVID-13` is a hard prerequisite of `GAP-113`**, not a related finding. Until
> it is fixed, the three-state record in that spec collapses to two, and the
> useful middle state ("delivered, never opened") cannot be distinguished from
> "opened and ignored".

> ⚠ **No new cron entry.** `app/api/cron/maintenance/route.ts:286-291` documents
> that a third scheduled entry fails every deployment on this hosting plan and
> once froze production for a day. Any clock this decision needs — window expiry,
> warnings, escalation — **extends the existing maintenance cron**. It does not
> add one to `vercel.json`.

**Do not** reuse `notify()` unchanged for this and assume the record is there.
**Do not** start the clock at the moment of the transition; start it at the
moment delivery is confirmed.

**Acceptance.**
- Forcing the notification insert to fail leaves the ticket un-advanced and
  surfaces the failure.
- Every auto-advanced ticket can produce: who was told, when, whether they opened
  it, when they were warned, and when the window expired.
- That record survives any notification retention/cleanup — see `DEC-39`.

**Reversal.** None. Without this, `GAP-109` must not ship.

**Risk:** high — this is the safety condition on the whole consent-window model.

<a id="dec-39"></a>
## DEC-39 · Warnings, and where the non-response record lives

**Decision. At least one warning before expiry, to the same people plus the
assigner. The non-response record is written onto the TICKET, not left implicit
in the notification feed.**

**Rationale.** Two different things are being asked for and only one of them is a
notification. The warning is a courtesy that makes the window fair. The
**record** is evidence, and evidence cannot live in a feed that gets marked read,
archived, or pruned.

The pattern to copy already exists: the acknowledged-distribution feature tracks
per-assignee acknowledgment state with `ack_requested` / `ack_complete` /
`ack_overdue` / `ack_unsatisfiable` notification kinds
(`lib/inAppNotifications.ts`) backed by durable acknowledgment rows, not by the
bell. A consent window is the same shape with the polarity flipped: it advances
on silence instead of blocking on it.

Note `ack_unsatisfiable` — *"an ack policy resolved to nobody / has gaps."* A
consent window has the identical failure mode: a slot that resolves to zero
people. **A window whose recipient set is empty must never advance on silence.**
Nobody was asked, so nobody declined to object.

**Implementation.** On the ticket: `consent_window_opened_at`,
`consent_window_recipients` (uids at open time — frozen, not recomputed),
`consent_window_warned_at`, `consent_window_expired_at`, and the resulting
advance recorded in ticket history as an explicit *"advanced without objection"*
entry naming everyone who was asked.

**Acceptance.**
- A window that resolves to an empty recipient set blocks and escalates to the
  assigner.
- The warning fires at a configured fraction of the window and is itself recorded.
- The ticket's own history answers the regulator's question with no reference to
  the notification table.

**Reversal.** Warning count and timing are configuration.

**Risk:** medium.

<a id="dec-40"></a>
## DEC-40 · Projects link by reference, never by copy

**Decision. A controlled document associated with a project is a reference to
(document id, revision), resolved live. Never a file copied into project
storage.**

**Rationale.** Stated requirement: *"a bidirectional portal for situations like a
project manager wants to link or push the request and its files to a projects
documents."* The requirement is right; the word *push* hides the trap.

Copying a controlled drawing into a project folder creates an uncontrolled copy
that does not supersede, does not carry a hold, does not appear in distribution
recall, and does not go stale visibly. That is the precise failure this system
exists to prevent, and it would be introduced by the most natural reading of
"push the files".

A reference gets the opposite behaviour for free: it shows the current revision,
it goes visibly stale when superseded, and a hold on the document is a hold
everywhere it is referenced.

**The seam already exists on one side.** `CheckoutSession`, `Milestone` and
`MarkupRequest` all carry `projectId` (`types/schema.ts:929`, `:456`, `:1004`).
`ProjectActivity` already has a typed event vocabulary including `doc_added`,
`doc_removed` and `markup_requested` (`types/schema.ts:980-983`).

**`Ticket` carries no `projectId` and no container reference of any kind.** It is
the only work object in the system that a project cannot see. That is the whole
gap — the project side is built.

**Implementation.** `project_id` on the ticket (nullable, set at creation or
later), plus a `ProjectActivity` event when a request is linked and when its
deliverable is issued. The deliverable appears in the project as a reference to
the issued revision.

**Do not** copy files. **Do not** create a project-local document record that
duplicates a controlled one. **Do not** let a project surface show a revision
without showing that it is the current one — a project view of a superseded
drawing that does not say so is worse than no project view.

**Acceptance.**
- Linking a request to a project writes one foreign key and one activity row.
- The project's document list shows the live current revision and marks
  superseded ones.
- A hold on a referenced document is visible from the project.
- No bytes are duplicated.

**Reversal.** If a facility genuinely needs a frozen snapshot for a bid package,
that is the existing export/snapshot path with its own watermarking — a separate,
already-solved problem, not a change to this rule.

**Risk:** medium.

---

### DEC-41 · Verification grade is a field, not a caveat

**Decision.** Every finding declares how hard it was challenged, in
`findings.json` as `verified_by`, with five values in descending strength:
`adversarial-independent`, `adversarial`, `hardening-pass`, `author`,
`unverified`. Prose caveats about verification are not an acceptable substitute,
and a report-level banner is not either. A finding that did not survive its
challenge carries `Status: REFUTED` and `refuted: true`.

**`challenges` records the chain, not just the best link.** `verified_by` is the
strongest grade a finding earned; `challenges` is every pass it went through,
oldest first. Two challenges is a different claim from one, and the difference is
measurable: findings whose chain starts `adversarial` were refuted at 0.7%, those
whose chain starts `hardening-pass` at 2.7%. Collapsing to the strongest grade
would have hidden exactly the fact that made the second pass worth running.

**Why.** The corpus is consumed by agents that read the index rather than the
reports — that is what the index is for, and `audit-reports/README.md` says so.
A warning that lives only in a report header is invisible to the one consumer the
design optimises for. `META-AUDIT.md` `MA-6` is exactly that failure: a report
that skipped verification carried a correct banner, and its findings still
published `Verification: CONFIRMED` into the index with nothing to mark them.

**Consequences.**

- `Verification` (`CONFIRMED` / `SUSPECTED`) is the **finder's** assessment.
  `verified_by` is **who tried to prove them wrong.** They are different fields
  and neither substitutes for the other.
- A queue is sorted by severity **and** grade. A `HIGH` that survived an
  adversarial pass outranks an `author`-graded `CRITICAL` for confidence, though
  not for consequence.
- Refuted findings are marked refuted in place with the reason. They are never
  deleted. The record of what was rejected is the evidence that anything was —
  and its absence is what made `MA-2` unanswerable until the pass was re-run.
- A verifier who is not independent says so on the finding.
- **A grade is not permanent, and a non-independent one is a queue item.**
  `hardening-pass` existed because a session re-read its own findings; the
  correct response was to run the independent pass, not to document the gap
  better. It was run, and it refuted 10 findings and lowered 79 severities that
  the same-session read had cleared. **Treat any non-independent grade in this
  index as work not yet done.**

**Reversal.** If verification is ever restructured to emit corrected fields as
data rather than prose, `verified_by` stays and gains values; it does not go away.
The failure it guards against — a challenge that happened but was invisible to the
consumer, or one that never happened but looked the same — is permanent.

**Risk:** low.

---

# Identity

<a id="dec-42"></a>
## DEC-42 · Is Supabase identity linking required?

**Decision. Yes. The Supabase project MUST have automatic identity linking for
verified-email providers enabled, so Microsoft sign-in and password sign-in
resolve to ONE `auth.users` row whose `auth.identities` are `{azure, email}`.
The `lower(email)` unique indexes (migration `20261018_identity_email_unique.sql`)
are the backstop that keeps a second identity from acquiring a second profile
or a second active membership — they cannot force two providers onto one auth
user, which only the project setting does.**

> **Stated default.** Made during the identity-and-session resolution
> (2026-08-23) under the protocol's fail-safe rule: the repository cannot
> observe the project setting, and every `IDENT-*` fix is written to hold
> either way. Recorded so the next agent inherits the requirement instead of
> re-deriving it.

**Rationale.** One person, one signer identity. `org_members.uid` is the join
key for e-signatures, acknowledgments, checkout locks and audit rows; two auth
identities for one email split a person's regulatory history across two actors
— *"an account with this person's email signed"* is not *"this person
signed"*. The application half (normalized matching, collision refusal, the
device-workspace owner stamp) reduces how often a second identity can act, but
only linking prevents the second identity existing.

**Implementation.** In the Supabase dashboard: Authentication → Providers →
enable automatic linking for verified-email providers (Azure returns verified
emails for M365 tenants). Verify with the `IDENT-1` inventory query: a healthy
account shows one `auth.users` row with providers `{azure, email}`. Record the
check's result in `02-identity-collision.md` under `IDENT-1`.

**Acceptance.** The `IDENT-1` duplicate-identities query returns zero rows,
and a password sign-in and a Microsoft sign-in for the same address land on
the same `uid`.

**Reversal.** If a facility deliberately wants separate identities per
provider (none stated), the unique indexes must then key on
`(provider, email)` instead — a different data model, decided then.

**Risk:** medium — a project-setting dependency the repo cannot enforce.
