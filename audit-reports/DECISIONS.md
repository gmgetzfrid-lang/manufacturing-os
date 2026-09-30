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
| [DEC-43](#dec-43) | Controllers are **unscoped by design**; a bypass-decided read of a restricted node is audited at the bytes egress | low | `DOCACL-3`, `DEC-2` |
| [DEC-44](#dec-44) | Content egress rails: `download_audits` append-only, presigned windows ≤ 1 h, the service worker caches no API response | low | `DIST-9`, `DRLS-8`, `EGR-4`, `PKG-11`, `XEDGE-6` |
| [DEC-45](#dec-45) | Bearer columns never leave the database in an export and never come back from a backup | low | `EGR-7`, `XEDGE-10`, `BKP-1`, `INTK-6` |
| [DEC-46](#dec-46) | External share links are **controlled distribution**: controllers or granted publishers mint, 90-day maximum, a withdrawn or held document is refused, every access recorded (IP controller-only), a link always serves the current revision | low | `DRLS-5`, `DRLS-7`, `DIST-6`, `DIST-7`, `EGR-3`, `EGR-5`, `SHR-3`, `SHR-10` |
| [DEC-47](#dec-47) | Imported schedule rows are **commitments everywhere** — one liveness predicate (`lib/milestoneLiveness.ts`) for health, coach, report and EV | low | `MON-6`, `PM-3`, `SCH-5` |
| [DEC-48](#dec-48) | Bids are scored on **price, and on stated hours only where three bids corroborate them** — declared exclusions never lower a score, coverage is unscored until a per-RFQ scope list exists; a bidder **binds** to a registry row only by exact/normalised name or a human link, but the **do-not-use gate** fires on any row the name could be | medium | `BID-3`, `BID-4`, `BID-6`, `BID-7`, `BID-12`, `COST-5`, `COST-7`, `MON-12` |
| [DEC-49](#dec-49) | A URL `/api/storage/download-url` signs is an **attachment** unless a viewer asks AND the type cannot be a page (PDF, raster image — type pinned); the viewer frames only a PDF and shows images as `<img>` | low | `SEC-7`, `SEC-1` |
| [DEC-50](#dec-50) | The money ledger: the headline is what is still **uncommitted**; approved change orders revise the budget only while their money is on the ledger; CPI forecasts only what it measured; the ledger is never deleted; the decider decides the amount and line they were shown | medium | `MON-1`, `MON-4`, `COST-2`, `COST-4`, `COST-6`, `COST-9`, `COST-10`, `COST-11` |
| [DEC-51](#dec-51) | A schedule re-import is a **reviewed merge, never a guess**: the importer plans before it writes, keeps local progress, keys rows on content, reads dates one way for the whole file, and adopts a legacy position row only by a name unique on both sides | low | `SCH-1`, `SCH-2`, `SCH-3`, `SCH-14`, `SCHED-3`, `SCHED-4`, `SCHED-9` |
| [DEC-52](#dec-52) | A green on a PSSR / MI / QA-QC line says who decided it: a **person** (a reason that meets the bar, uid on the row) or the **machine** (a citation the database resolves); only a person's decisions make a completion citable | low–medium | `QUAL-1`, `QUAL-2`, `QUAL-5`, `QUAL-6`, `QUAL-11`, `QUAL-12`, `SAF-1`, `SAF-4` |
| [DEC-53](#dec-53) | The equipment registry: writer tier edits and archives, controller tier deletes; a site code identifies the **type**, one code is one asset; codebook edits never rewrite codes | medium | `AREA-1`, `IRLS-5`, `CB-3`, `CB-5`, `CB-6`, `CB-10`, `GAP-310` |
| [DEC-54](#dec-54) | Knowledge ingestion has **one writer per document** (a five-minute claim; the loser waits), **one reset** of a document's derived index, pages AI vision failed to read **hold 'ready'** until retried or explicitly accepted, the table-aware chunker is **chosen per library, never automatic**, and a controlled document's AI mirror **dies with it** | medium | `ING-1`, `ING-2`, `ING-3`, `ING-4`, `ING-6`, `ING-7`, `ING-12`, `DWG-1`, `ILIFE-5`, `IRLS-7` |

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

*Landed 2026-09-17 (roles-and-permissions Round E): the rebuild gained an on-demand scope — `rebuildAclIndexes(sb, now, { orgId, libraryId })` behind `POST /api/acl/rebuild`, called by the permission drawer after a (checked) library / folder save and gated on the drawer's own save authority (controller / effective owner / manage grant on the node's chain), same diff guard. The nightly pass stays the backstop; `acl_index` stays a rebuilt cache. See `OWN-20`.*

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

*Landed 2026-09-17 (roles-and-permissions Round E): the `revision_branches` row — resolution restricted to `is_org_controller(org_id)` OR the document's effective owner (`user_is_effective_owner`), migration `20261061`; `lib/branches.ts#resolveBranch` names a refusal. Every row of this table now has a commit or a recorded rationale — see `OWN-21`.*

---

*Landed 2026-09-17 (roles-and-permissions Round E): the three workflow rows — `NEW` / `PENDING_ENG_INITIAL` removed (union, engine, routing, attention, portal, widget, open-status lists; migration `20261053` moves any stragglers and flips the default), `CANCELED` implemented (`cancel_request`), and `ticket.initial_review` / `ticket.eng_review` / `ticket.final_approve` marked `dormant: true` with a `dormantNote`, rendered greyed with the tooltip in the capability editor; `metadata.minor_correction` kept. See `WF-17`.*

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

*Landed 2026-09-29 (projects Round G): the same derivation on change orders — `decideChangeOrder` (`lib/changeOrders.ts`) refuses a proposer's own decision while the org has another eligible decider (active controller-tier holders plus the project owner, minus the actor), allows and MARKS it when nobody else can, and `enforce_change_order_decision_guard` (`20261094`) applies the rule at the database for the SIGNED-IN caller (`auth.uid()`, which must be the recorded `decided_by`; the recorded decider only for a service write) against a proposer pinned at insert (`created_by = auth.uid()`) and never rewritten. Counted from the eligible-decider set rather than the raw active-member count, since only controllers and the owner can decide a CO. See `COST-6`, `DEC-50`.*

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

*Landed 2026-09-03 (roles-and-permissions Round D3): stages 1–2. Stage 1 was `WF-15` (`20261038`). Stage 2: `policyAllows(…, resource?)` with `{tokens, when}` rules in `lib/capabilityPolicy.ts`; `getActions`, holds, the simulator and the SQL evaluator (`20261052`: `org_capability_allows_for` + the 3-argument wrapper) moved together; the route refuses a scoped-out approval and an out-of-group reviewer pick; the permissions console edits request-type overrides. See `DRAFT-1`, `WF-13`, `GAP-1`. Stage 3 (the engineer gate as a capability) is open — next round.*

*Landed 2026-09-17 (roles-and-permissions Round E): stage 3. `ticket.engineer_gate_exempt` ("Approve own request without an engineer", default `["Admin","Manager","Supervisor","Engineer","DocCtrl"]` — byte-identical to the hardcoded test, pinned over every role × collection; the id lists the EXEMPT roles in the `ticket.*` namespace the evaluators share, rather than the sketched `requests.requires_engineer_approval`) is consulted by `engineerApprovalRequired` / `requiresEngineerApproval` in `lib/workflow.ts` alongside the `DEC-16` disjunction — snapshot OR current still fails closed; the capability only decides which roles are exempt, and a personal grant or a request-type override of it is honoured. Migration `20261057` re-creates `org_capability_allows_for` from `20261052` with the one added CASE row (lineDiff-pinned); the WF-23 census in `rpPhase4Migration.test.ts` now reads the newest evaluator and pins `20261038` as historical. Tests: `sweepRoundE_policyServer.test.ts`.*

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

*Landed 2026-09-17 (roles-and-permissions Round E): `cancel_request` from `PENDING_ASSIGNMENT` and `DRAFTING` for the requester identity and `ticket.manage`, comment required, audited, terminal — and terminal everywhere: the `LIFE-6` / `DEC-25` hold gate, the intent bridge and every live-work filter treat `CANCELED` exactly as `CLOSED` (fix pass); `NEW` and `PENDING_ENG_INITIAL` removed from every code path; migration `20261053` inventories (temp table, aggregate counts) and moves existing rows to `PENDING_ASSIGNMENT` with a history line, and sets the column default. See `WF-17`.*

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

*Landed 2026-09-17 (roles-and-permissions Round E): `reopen_ticket` increments `revision_count`, resets `draft_iteration`, nulls `deliverable_rev`; `approve_minor_correction` at `PENDING_FINAL_APPROVAL` stamps `engineer_approved_at`; `/api/verify-ticket` treats a reopened ticket as back under review only with evidence of an issue — the last issued number is read from the "… — issued Rev N" history line, never from `revision_count` (a bumped cycle count alone is not evidence). See `WF-21`.*

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

*Landed 2026-09-17 (roles-and-permissions Round E): the deferred consolidation. ONE server-enforced admin gate — `lib/adminSurfaces.ts` (the registry: entry by role collection, any-member, or a capability with grants), `lib/adminGate.ts` `authorizeAdminSurface` (fail closed on a policy-load error), `/api/admin/gate`, and `app/(protected)/admin/layout.tsx` asking it before any admin page renders. Every registry entry mirrors what its page admitted, pinned by test, with one deliberate narrowing — `/admin/storage` (entry = its stats API's Admin / Manager / DocCtrl set; the page never gated entry and is unusable without it) — and one presentation change (`/admin/libraries` / `/admin/requests` answer a non-controller with the denial screen instead of a redirect), both recorded in `SURF-9`'s resolution; `admin.audit_view` (`20261063`) makes the audit page policy-driven at the page and at the database. See `SURF-9`, `WF-20`, `ROLE-5`; the API-route conversion is split off as `SURF-19` (DEC-31).*

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

*Landed 2026-09-23 (document-control Round F): the scheduled-export sweep's subscription and plan refusals (`XEDGE-7` / `XEDGE-8`, `lib/exportEntitlement.ts scheduledRunGate`) ride the same `SUBSCRIPTION_ENFORCE` flag — off: the would-be skip is logged and recorded on the run and the destination; on: a cancelled `export_runs` row is recorded and nothing is pushed. The "configurer still an active member" check in the same gate is not billing state and always applies. Fix pass: the gate reads the org row once for both billing limbs and treats an unreadable row like a refusal on that limb (skip under the flag, notice without it — never `assertOrgHasAccess`'s fail-open), and the skip's record writes are checked and surfaced on the sweep result.*

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

*Landed 2026-09-23 (document-control Round F): the same per-library flag (`review_control.requireIndependentReviewer`, default on) now governs the ROSTER and the SIGNING, not only the promote — the draft's author (`document_versions.created_by`) is skipped from the primary and alternate sets by `openReviewRoster`, refused by `recordReviewSignoff` before a signature is minted, and refused by `enforce_review_signoff_guard` (`20261070`); when the skip empties the roster the zero-primary escalation says why. The promote-time clause is unchanged. See `RG-8`.*

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

*Extended 2026-09-17 (roles-and-permissions Round E): the gate keys on the terminal transition (`CLOSED` or `CANCELED`), not on the close action's name, so `cancel_request` (`DEC-14`) meets the same 409 and the same release-or-keep resolution. See `WF-17`.*

*Landed 2026-09-23 (document-control Round F): the `20261073` `document_holds` guard pins a hold's identity and freezes its release record but leaves `origin_ticket_id` writable and admits the ticket close gate's service-role release — which must still name a releaser and a reason, and keeps writing its own audit row. For a signed-in caller a release is never silent and never anonymous: UPDATE requires a reason and attributes to the session, and INSERT refuses a row born released. The service role is trusted to name its actor and write its row (the ticket gate does; a restore replays history). Pinned by shape only until 20261073 is pasted (DEC-30). See `HLD-5`.*

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

*Landed 2026-09-23 (document-control Round F): `20261077` applies the two-worlds rule inside one paste — the pre-apply inventory (TEMP TABLE, aggregate counts: `document_review_events` rows with NULL `org_id` and how many of those have no parent document left, live `document_versions` rows sharing a storage key, documents disposed or Archived under an open hold) is captured BEFORE the transaction, the DDL then chooses its own world — `org_id SET NOT NULL` when the backfill left nothing, otherwise a `NOT VALID` CHECK that binds every NEW row and keeps the unbackfillable residue for the record (never deleted) — and the final SELECT reports which world it chose. See `DRLS-4`, `RET-8`, `HLD-1`.*

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

*Landed 2026-09-23 (document-control Round F): the hold-change and hold-aging audience is the org's `holds.release` pool read from the capability policy (`lib/holds.ts` `holdPoolFromMembers` — tokens expanded against the held collection, per-person grants included), never a literal list; the shipped wildcard is read as "no dedicated pool" and falls back to the controller tier (`isControllerRole`, what `is_org_controller` means) rather than an org-wide broadcast, so an unconfigured org's fan-out is unchanged. Which controls a person sees on the two hold surfaces is the same policy through `holdControlsFor`. See `HLD-8`, `HLD-10`, `HLD-14`.*
*Landed 2026-09-29 (projects Round G): the change-order approval threshold is configuration — `org_configurations` key `change_order_approval_threshold` = `{ "amount": N }`, read by `loadApprovalThreshold` and by the `20261094` trigger; the decider tier above it is the controller collection (`memberHoldsAny(m, ["Admin","DocCtrl"])` / the `is_org_controller` predicate), never a facility role name. Default: no threshold until an org sets one; a malformed amount (anything but a plain non-negative number) means no threshold, in the lib and the trigger alike. See `COST-6`, `DEC-50`.*
*Landed 2026-09-29 (projects Round G): the schedule-editing predicate — `can_edit_project_schedule(p_org, p_project)` in `20261098`, `caller_holds_any_role` over the four roles `20260907` listed inline, or the project owner — is read by `apply_milestone_moves`, `set_project_baseline` and `clear_project_baseline` (`20261099`) instead of a fresh literal in each; registered as a collection funnel in `authorityCensus.test.ts`. Aligning the read to the funnel admits one member class `20260907`'s `COALESCE(roles, ARRAY[role])` refused — a headline role among the four with a `roles[]` that holds none of them — inventoried before the apply in `20261098`'s result set. See `SCHED-4`, `SCHED-3`.*
*Landed 2026-09-29 (projects Round G): the quality program's machine actor is a reserved sentinel, not a facility role — `MACHINE_ACTOR_SWEEP` (`"evidence sweep"`) / `MACHINE_ACTOR_ASSESSMENT` (`"AI assessment"`) in `lib/checklistEngine.ts`, written as `updated_by = NULL` + `updated_by_name = <sentinel>` by `runAutoEvidence` / `applyAssessment`; a human write always carries a uid. Checklist kinds stay seed data (`CHECKLIST_KIND_LABEL`), and the turnover subject match reads the seeded item names, never a role. See `QUAL-6`, `DEC-52`.*

*Landed 2026-09-30 (intelligence Round G, I-10): the equipment registry adds no role list. Its delete tier is the controller tier (`isControllerRole` from `lib/permissions.ts` on the client, `is_org_controller` in `20261128`), and the master-list workbook route reads the registry writer tier from `ADMIN_SURFACES` "assets" `writes` through `memberHoldsAny`, which checks the whole role collection. See `AREA-1`, `IRLS-5`, `BR-4` and `DEC-53`.*

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

*Landed 2026-09-23 (document-control Round F): the single resolver exists — `lib/containerChain.ts` (`loadContainerChain` / `firstDefinedInChain` / `folderChainFromMap`) walks document → folder → `path_ids` ancestors nearest first → library, throws on a read error, and is the only chain walk: `review_control` and `doc_class` ride it; `routing_control` must too. Its SQL twin is `review_control_mode_for` (`20261070`). See `RG-3`, `RG-6`.*

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

*Landed 2026-09-23 (document-control Round F), for the review roster: independence is a property of a SLOT there too — every primary row is a slot in its `slot_group` (`person:<uid>` / `role:<Role>` / `team:<teamId>`), a slot is satisfied by its own primary or by an ACTIVATED alternate of the same group, one signature fills one slot, and a person resolved by several policy entries holds ONE row — in the most specific entry (person > role > team), and between two listed ROLES in the first listed role they hold (policy list order decides): the other role's slot is not opened by them, and the policy editor warns that it opens no slot rather than silently requiring nothing for it (one row per person-and-group is not this round's shape). A named alternate is paired with the slot it backs through `ReviewControl.alternateBacks`; unpaired, it satisfies nothing and the roster says so. See `RG-4`.*

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

<a id="dec-43"></a>
## DEC-43 · Can a document controller be scoped?

**Decision. No. `Admin` and `DocCtrl` stay unscoped — every controller sees
and may publish every document in the org. The one mitigation is a record:
when a controller is served the bytes of a restricted node ONLY because of
the controller tier, an `audit_logs` row (`CONTROLLER_RESTRICTED_READ`) is
written at the download egress.**

> Made during the roles-and-permissions Round E (2026-09-17) under the
> protocol's fail-safe rule, closing `DOCACL-3` as accepted-by-design.

**Rationale.** `DEC-2` made the controller tier the recovery rail on purpose:
the publish path, the review guard, ack rows and `node_visible` all route
through `is_org_controller` so that a member holding `DocCtrl` anywhere in
their collection can always reach and repair a document. A scoped `DocCtrl`
is a controller who can be configured out of the thing they must recover —
the exact class of failure `DEC-2` exists to prevent — and the change would
land inside `node_visible`, the function every document read passes through.
No facility has stated a per-area document-controller requirement; the
exposure is that a document controller can read the org's documents.

**Implementation.** `lib/permissions.ts` `controllerBypassDecided` (pure) and
the audit row in `app/api/storage/download-url/route.ts`, best-effort so a
failed insert never blocks the rail. The route passes the document's explicit
owner into the evaluation (`effectiveOwnerUserId`) and asks
`user_is_effective_owner` (the folder / library / team cascade) before
writing, so ownership that would have served the bytes leaves no row; a
cascade lookup error records the read rather than skipping it. Reads through
PostgREST are not audited: an RLS function cannot write per row without a
side effect on every SELECT.

**Acceptance.** An unscoped controller behaves exactly as before; a
controller download of a private/hidden document that the ACL does not admit
them to leaves a `CONTROLLER_RESTRICTED_READ` row; a download the ACL (or
ownership) would have served anyway leaves none.

**Reversal.** A stated per-area controller requirement AND `DEC-5` (stable
role ids) — then scope lives on the id, is checked in `node_visible` after
the `Admin` branch, and an unscoped controller keeps today's behaviour.

**Risk:** low.

*Landed 2026-09-30 (projects Round G): service-role PAGE reads are a second bytes egress. `lib/docFileServer.ts` `resolveDocumentFile` — used by the checklist reader and the quality-manual reviewer, and required to name its reader — makes the app's own read decision over the full library → folder → document chain (read or download wherever an ACL exists, on every visibility) and writes the same `CONTROLLER_RESTRICTED_READ` row when a controller is served a document only by the controller tier — a normal document restricted by an allow-list included — with `details.channel` naming the route. A read it then refuses (a download deny) and a label-only read write none, and the version it serves must belong to the document it decided on — a forged pointer to another document's version resolves nothing, so no row describes a read of the wrong document through a pointer. One case remains (`SEC-10` residual 5, `file_url` aliasing): a version of A whose `file_url` is B's storage key is served under A's decision, and its row names A while `details.path` is B's key. `lib/__tests__/docFileServer.test.ts` runs the egress route and the gate over the same principals and documents and asserts the gate is never looser and records at least what the egress route records, naming each case where it is stricter until intelligence `KACL-5` brings the egress route to the same chain (projects-tab `SEC-10`). `/api/flows/read` renders a knowledge mirror's `file_key` — the controlled version's key — as the service role with no such row; that is recorded as a residual under `SEC-10` for the intelligence package that owns the route.*

<a id="dec-44"></a>
## DEC-44 · The download record, the presigned window, and the worker's cache

**Decision. Three rails for content egress, decided together because each
one is where the other two would otherwise leak:**

1. **`download_audits` is an append-only record.** Members read their org's
   rows and insert only their OWN pull (`user_id = auth.uid()`, in an org
   they belong to); no member policy admits UPDATE or DELETE. A pull that is
   not a member's act — a share-link download, a transmittal-portal download
   — is a service-role row with `user_id` NULL and the channel on the row
   (`source`, `share_id` / `transmittal_id`; a CHECK requires one of the
   three attributions). The attribution columns are plain uuids, not foreign
   keys: the record outlives the share or transmittal it names and never
   blocks their deletion. `org_id` is NOT NULL. A record that cannot be READ
   is rendered as a gap, never as an empty "all current".
2. **Long-lived access lives on the share surface, never on a presigned
   URL.** A presigned R2 URL is a bearer capability nothing can revoke, so
   the window it opens is the whole control: every issuer under `app/api`
   signs for at most `PRESIGNED_MAX_SECONDS` (3600, the app's own default),
   the caller's `expiresIn` is clamped into `[60, 3600]` or refused when it
   is not an integer, and the signed payload is `Cache-Control: no-store`.
   The client believes the GRANTED window, never the requested one:
   `lib/storage.ts` caches one URL per path for the `expiresIn` the route
   answered and re-signs at the margin before it closes. Six in-repo sites
   ask for 3600; five image callers (the org logo, avatars, folder covers,
   page backgrounds, the branding preview) used to ask for a week and now
   take the granted hour, re-signed in place while on screen — images are
   not share-surface material, so they are not routed there. Anything that
   must outlast an hour or be forwarded is a `document_shares` row — it has
   an expiry and a `revoked_at`.
3. **The service worker caches no API response.** `public/sw.js` refuses to
   store any same-origin `/api/` response (allow-list empty, on purpose) and
   any response marked `no-store` / `private`, never replays an `/api/` entry
   offline, and its runtime cache does not outlive the session: every
   sign-out site posts `SIGN_OUT`, the protected layout posts the signed-in
   `SESSION` id, and an identity the worker has not seen purges the cache.

> Made during the document-control Round F (2026-09-23, package P2 EGRESS)
> closing `DIST-9`, `DRLS-8`, `EGR-4`, `PKG-11`, `XEDGE-6` and the
> `download_audits` limb of `XEDGE-3`. A first attempt (2026-09-17) landed the
> same design and was lost to a container recycle before its records were
> committed; this is the rewrite.

**Rationale.** `download_audits` is the only evidence base for stale-copy
recall and for the PSM answer "who has had this drawing, and when" — a record
any member could edit is not a record (`audit_logs`, six lines above it in
`schema.sql`, already had the append-only shape). The presigned URL and the
worker's cache are the two places a copy of a controlled document escapes
every later decision — a revoked membership, an ACL deny, a hold, a
supersession, a share revocation — so each is bounded to the shortest window
the app itself needs, and the durable, revocable form of external access is
the one that already exists.

**Implementation.** Migration `20261068` (policies, columns, the attribution
CHECK, the org backfill and NOT NULL with a `NOT VALID` fallback when the
DEC-30 inventory shows rows with no document to backfill from);
`lib/presignedLifetime.ts` + `/api/storage/download-url` + `/api/storage/resolve`
(a census test keeps every `getSignedUrl` under `app/api` on the ceiling);
`public/sw.js` v6 + `lib/swSession.ts` posted from the four sign-out sites and
the protected layout; `lib/staleCopies.ts` reads the new shape with a legacy
fallback, flags external copies, and reports `unavailable`.

**Acceptance.** A member's `DELETE` / `PATCH` on `download_audits` is refused
and a member's INSERT with another `user_id` is refused; the live policy set
is exactly `{download_audits_select: SELECT, download_audits_insert_own: INSERT}`;
`?expiresIn=604800` signs for 3600 and `?expiresIn=abc` is a 400; a
`no-store` or `/api/` response is never written to Cache Storage and
`SIGN_OUT` empties it.

**Reversal.** A stated need for offline API data on field devices adds a
path to the worker's allow-list WITH a written reason its payload is safe to
replay; a stated need for longer presigned windows raises the ceiling in one
constant — neither reopens member writes to the record.

**Risk:** low — every change narrows; nobody gains anything on apply.

*Corrected 2026-09-23 (document-control Round F fix pass): §2 first said "the app's own default" was the only lifetime any caller had asked for. It was not — five image callers asked for 604800. The clamp alone would have left `lib/storage.ts` (cache keyed by the requested window) and the per-component avatar / background / cover caches holding a dead URL for a week; §2 now states the client half of the contract (cache by path, honour the granted window, re-sign at the margin) and names the five callers, which take the granted hour rather than a share-surface route.*

*Corrected 2026-09-23 (document-control Round F, second fix pass): "re-signed in place while on screen" is now literally true — the re-sign gives up only on the route's refusal (a 4xx), keeps the current URL and retries on a bounded backoff (and at once on reconnect) for any transient failure, so a wifi blip or a wake from sleep at the margin no longer blanks the image for the session; the margin is a quarter of the granted window capped at a minute; and an avatar's subscription is held by the mounted avatar and released on unmount, not kept per path for the tab's life. §3's "every sign-out site posts `SIGN_OUT`" means the four click sites; the expiry-driven and cross-tab `SIGNED_OUT` branch in `RoleContext.tsx` is handed to identity-and-session `IS-P1` / public-surfaces `OFF-8` (`XEDGE-6` dw2).*

*Landed 2026-09-29 (document-control Round F wave 2, P1 SHARE): §1's share-link row is now written — `app/api/share/file/route.ts` inserts `user_id` NULL + `share_id` + `source` with the served `version_id`, BEFORE the bytes leave, and a refused write refuses the download (`503 unrecorded`, logged) rather than shipping an unrecorded copy — except that a refusal which IS the unapplied `20261068` is retried once in the table's pre-20261068 shape (sharer-attributed, as before) and logged as the deploy order, so the record degrades, not the access; `lib/staleCopies.ts` already keys such rows `share:<id>` and flags them external. The per-access IP / user-agent trail lives beside it in `document_share_accesses` (20261081), controller-readable, service-role written. See `DIST-7`, `EGR-3`, `SHR-5`, `SHR-10`.*

<a id="dec-45"></a>
## DEC-45 · Bearer columns never leave the database and never come back from a backup

**Decision. A column whose VALUE is a credential — a share token, a vendor
intake token, a transmittal portal token, an encrypted destination
credential — is nulled in every export and never reinstated by a restore.
A restored share or intake link arrives with an unguessable placeholder
token and REVOKED; a restored transmittal has no portal token; a restored
export destination has no credentials and is DISABLED. People re-issue
links and re-enter credentials; the software never revives them.**

> Made during the document-control Round F (2026-09-23) closing `EGR-7`
> and `XEDGE-10` (also admin-and-org `BKP-1`, projects-and-cost `INTK-6`).

**Rationale.** `ai_connections` was already excluded from the backup on the
rule "secrets never leave the database"; the token columns and the
encrypted destination credentials were the same class and had simply never
been treated as such. A backup is designed to be mailed around and pushed
to third-party buckets nightly; a token inside it stays live against
production long after the backup has aged, and an intake token is a WRITE
credential. Re-minting on restore was rejected: a link nobody has been sent
is dead anyway, and a live token minted by the restore would be a
credential nobody chose to issue.

**Implementation.** `lib/exportTables.ts REDACT_COLUMNS` (the map, with a
reason per table) and `redactRow`, applied by `dumpTable` to every row;
`lib/dataRestore.ts scrubRestoredRow`, applied inside `remapRow` so both
restore paths get it; the manifest, notes and ZIP README name the redacted
columns. `lib/__tests__/exportCoverage.test.ts` censuses every exported
table for credential-named columns, so a future bearer column cannot ship
un-redacted.

**Acceptance.** No export artifact (ZIP, webhook, bucket, JSON download)
contains a token or an `*_encrypted` value; a restore from any envelope —
redacted or hand-edited — lands no presentable token and no usable
credential; the tripwire fails the build for a new bearer column.

**Reversal.** A stated requirement to restore share links live (none
stated) — then the restore would have to re-mint AND re-notify every
recipient, decided then.

**Risk:** low — restored rows are dead until a person acts, which is the
safe side for a credential.

*Landed 2026-09-23 (document-control Round F, fix pass): "a restored transmittal has no portal token" is enforced against the insert rail — `trg_transmittals_guard` (20261027) mints a fresh token for every row inserted as `issued`, so `scrubRestoredRow` lands a formerly issued transmittal as `voided` (the register record survives, a note says why, and no link can ever be presented); a person issues a new transmittal to send again. `push_subscriptions` (per-device Web Push `endpoint` / `p256dh` / `auth`) is excluded from the export whole, and the coverage tripwire also treats `auth` / `p256dh` as bearer names, so the acceptance line holds for every exported table.*

<a id="dec-46"></a>
## DEC-46 · External share links: who mints, how long, what serves, what is recorded

**Decision. A public share link is a controlled-distribution act, and its
rules are the publish rules:**

1. **Who mints:** the org's controllers (Admin / DocCtrl by the role
   COLLECTION — `is_org_controller`) or a publisher granted on the document's
   library (`user_can_publish_on_library`, the database's own evaluator). Not
   every member, and not the effective owner as such — a share is a copy
   leaving the building, and the tier that issues the revision is the tier
   that lets it out. Enforced by the INSERT policy (20261080) and mirrored in
   the modal (`canMintShare`), which explains rather than hides — and
   re-asked at SERVE time (`creatorMayShare`, `lib/shareServe.ts`): a link
   serves only while its creator still holds the tier (and can still read
   the document, and is not named by an explicit ACL download deny on it —
   the rule `/api/storage/download-url` applies to members, one helper for
   both: `lib/downloadDeny.ts`), so a link a Viewer minted before 20261080,
   one whose publisher has since lost the grant, or one whose creator is
   denied download, stops serving at the wave-2 deploy rather than living
   out its expiry. Nothing is grandfathered. The download deny is a
   SERVE-time check only: the database has no download-deny predicate, so
   the INSERT policy and the modal do not refuse such a mint — the row
   inserts and never serves (`SHR-14`, OPEN).
2. **How long:** every share expires. "Never expires" is removed; 30 days is
   the default and 90 the ceiling, enforced by trigger on INSERT and on any
   change to `expires_at` (a never-expiring legacy row is capped at
   `created_at + 90 days` on apply — one older than that expires then). The
   ceiling is measured on the DATABASE's clock: a live INSERT is stamped
   `created_at := now()` whatever the client sent, `created_at` is immutable
   after (so neither an INSERT nor an UPDATE can walk the anchor forward),
   and a row with no `created_at` may only move its expiry earlier. The
   expiry itself is computed on the minting browser's clock, so an expiry up
   to one hour past the ceiling (a clock running ahead on a "90 days" pick)
   is clamped to the ceiling rather than refused; beyond that the insert is
   refused and the modal says why.
3. **What may be shared, and what serves:** never a Draft, a Superseded /
   Void / Archived document (the shared `NOT_CURRENT_STATUSES`), an archived
   record, or a document under an active hold — refused WITH THE REASON at
   mint time (`document_share_refusal`, `describeShareRefusal`) and at every
   resolve (`lib/shareServe.ts`), fail-closed when the hold set cannot be
   read. The landing page is UNAUTHENTICATED, so a hold refusal there names
   only the hold's predefined category (`publicHoldReason`, the HLD-7 /
   VFY-6 rule `/api/verify-hold` follows) — never the operator's free text
   and never a database error (logged server-side instead); members see the
   full reason in the modal. A retired document's outstanding links stop
   serving while its status is not current — for supersede, split, merge,
   void and archive alike — and serve again if that status is undone (an
   unarchive, a reversed split or merge). Only supersede also REVOKES them
   for the record (`DIST-1`); revoke-on-archive / split / merge is P3
   LIFECYCLE's (`REV-10`, OPEN for that half). The modal says only "a link
   stops serving while the document is held, withdrawn or archived, and may
   be revoked when it is superseded, split, merged or archived".
4. **Which revision:** a share always serves the CURRENT issued revision. No
   version pinning. Stated in the modal, on every link row, on the landing
   page and in the stamped footer, so neither party can believe otherwise.
   The link row's "resolves to" is computed by the same function the routes
   run (`resolveServedVersion`) and the same status + hold rule, so for the
   DOCUMENT it says "not serving" or "no published file" when the routes
   would refuse or answer `nofile`, and "couldn't confirm" when the modal's
   own read failed. It is not a per-link verdict: whether a given link's
   creator still holds the authority it serves on is the server's to decide
   at each request, and the list states that rule in words.
5. **What is recorded:** every download is a `download_audits` row attributed
   by `share_id` (DEC-44 §1) written before the bytes leave — a refused
   write refuses the download; every access (open or download) is a
   `document_share_accesses` row with IP, user agent, kind and version, and
   so is every REFUSED attempt on a known share (kind `refused` + the
   reason: revoked, expired, withdrawn, on hold, lapsed authority, no file,
   unrecorded). Anyone holding a token, live or dead, can call the routes in
   a loop, so the trail is BOUNDED by unique indexes: refused attempts one
   per share per minute, opens one per share per client IP per minute;
   downloads are one per copy served (each is a distribution). The
   accessor's IP is CONTROLLER-ONLY: it lives on `document_share_accesses`
   and nowhere else — never on `document_shares`, whose rows every member
   who can read the document can read (`access_last_ip` is emptied on apply
   by `20261081` and stays unwritten, commented as such;
   `bump_share_access` carries no IP). Pruning the trail
   (the plan's default: 90 days) is the retention owner's (the `RET-*`
   findings / `08-retention.md`), not this decision's; until a retention
   rule names it, rows are kept and the bounds above are the only brake. No
   recipient identification: possession of the token is the whole
   authorization, and the record says what it knows rather than a name
   nobody verified.
6. **Revocation is durable:** `revoked_at`, once set, never clears or moves,
   a revoked share cannot be re-dated, and creators revoke but only
   controllers DELETE (retention). Creating and revoking write `audit_logs`
   — checked: a refused audit row leaves the change standing and the modal
   says the record could not be written; revoking a row that is already
   revoked is a no-op (no second row).
7. **Deploy order:** `20261068` (wave 1) → `20261080` → `20261081` are
   applied before the wave-2 routes deploy. Deploying first degrades, it
   does not lock out: ahead of `20261068` a share download's record is
   retried once in the table's older shape (sharer-attributed, as before —
   logged as the deploy order) and the copy is served on it; ahead of
   `20261081` the access rows fail (logged, not fatal) and the counter call
   still resolves (`bump_share_access` keeps its one-argument arity); ahead
   of `20261080` minting follows the old policy. A download is refused
   (`503 unrecorded`) only when no record at all can be written.

> Made during document-control Round F wave 2 (2026-09-29, package P1
> SHARE + public-surfaces PKG-3). Closed: `DRLS-5`, `DRLS-7`, `DIST-6`,
> `DIST-7`, `EGR-2` (record-only), `EGR-3`, `EGR-5`, `SHR-1` (record-only),
> `SHR-3`, `SHR-4`, `SHR-5`, `SHR-6`, `SHR-7`, `SHR-10`, `SHR-13`
> (record-only). Partial, left OPEN with the closer named: `REV-10` (the
> lifecycle revoke — P3 LIFECYCLE), `EGR-6` (the other `download_audits`
> writers — P8 FIELD), `SHR-11` (`PHYS-11` — PS-STAMP), `SHR-12` (the
> `schemaExpectations` row — integrator follow-up), `PHYS-8` (the drafting
> limb — PKG-5 / P8), `PHYS-13` (the viewer QR — PS-STAMP). Opened:
> `DIST-15` (the org-wide inventory — unassigned), `SHR-14` (the mint-time
> download-deny arm — unassigned; opened 2026-09-30). Not this package's,
> though in the same `SHR-` range: `SHR-8` (PS-STAMP), `SHR-9` (PKG-1). The
> defaults were stated to the system's owner on 2026-09-17 and applied
> unless overridden.
>
> **Verification fix (2026-09-30, document-control Round F wave 2).** An
> independent check of `f1ce4c7` found `SHR-3` listed Closed here while its
> deny-download criterion was ◐. The serve-time half is now built (§1:
> `creatorMayShare` asks `lib/downloadDeny.ts` for the creator), so `SHR-3`
> stays in the Closed list on what holds; the mint-time half has no SQL
> predicate to call and is opened as `SHR-14`. §5 now records that
> `20261081` empties `access_last_ip`.

**Rationale.** A share link is the one channel that hands a controlled
drawing to someone with no account, no ACL and no recall path. Every other
door — publish, transmittal, distribution ack — already asks who, what state,
which revision and where is the record; the share link asked only "does the
token exist". Aligning it with the publish tier and the not-current set makes
"outside the building" no weaker than "inside".

**Implementation.** `lib/shareRules.ts` (the rules, plus
`resolveServedVersion`, which reads only through the caller's client),
`lib/shareServe.ts` (server), `lib/downloadDeny.ts` (the deny-download rule,
shared with `/api/storage/download-url`), `lib/documentShares.ts` (client mint path),
`components/documents/ShareLinkModal.tsx`, `app/share/[token]/page.tsx`,
`app/api/share/{resolve,file}/route.ts`; migrations `20261080`
(minting tier, refusal rail, durable revocation, 90-day ceiling) and
`20261081` (per-access record, pinned counter); `lib/__tests__/shareRoutes.test.ts`.

**Acceptance.** A Viewer's INSERT into `document_shares` is refused; a
controller's INSERT on a Draft / Superseded / held document is refused with
the reason; `expires_at` NULL or more than 90 days (plus the one-hour skew
allowance) after the database's `now()` is refused, whatever `created_at`
the INSERT names; `UPDATE document_shares SET created_at = …` raises; a
Superseded or held document answers `withdrawn` / `on_hold` on both routes,
the latter naming no free-text hold reason; a share download produces
exactly one `download_audits` row with `share_id` before the bytes;
`UPDATE document_shares SET revoked_at = NULL` on a revoked row raises; a
signed-in member calling `document_share_refusal` on another org's document,
or on a private / hidden document of their own org they cannot read, gets
`not_found`; a link whose creator no longer holds the minting tier, or whom
an explicit ACL download deny on the document names, answers 410 on both
routes; after the apply and after a resolve, `document_shares.access_last_ip`
is NULL on every row and the IP is on the `document_share_accesses` row; a second open
from the same IP in the same minute adds no row.

**Reversal.** A stated need for a longer-lived external link (a customer
contract, a regulator) raises the ceiling in one constant and one interval —
never reinstates "never". A stated need for recipient identification adds a
gate on the landing page and a `recipient` column on the access row, decided
then. A stated need for owners to share widens the INSERT arm to
`user_can_publish_doc`.

**Risk:** low — every change narrows; a never-expiring link older than 90
days expires on apply, which the migration's inventory counts before the fact.

<a id="dec-47"></a>
## DEC-47 · Imported schedule rows are commitments everywhere

**Decision. A milestone row that came from a scheduling tool (`source` in
`p6` / `msproject` / `csv` / `mpxj`) counts for every metric exactly as a
typed row does — the health score, the coach, the printed report and the
earned-value rollup. "Ghost" describes how the row is EDITED (read-only in
the UI), never whether it counts. The rule is written once, in
`lib/milestoneLiveness.ts`, and every consumer imports it.**

> Made during projects Round G (2026-09-23) under the protocol's fail-safe
> rule, closing projects-tab `MON-6` and projects-and-cost `PM-3`.

**Rationale.** Two surfaces on one page disagreed: the Schedule and Costs
tabs read every row (and told the user imported rows "still count toward the
earned-value rollup"), while the health snapshot and the report filtered to
`source == null || "manual" || "app"` — a NOT NULL column with a CHECK, so
the filter collapsed to manual-only. A 400-activity P6 import scored "No
schedule yet", was nagged to "Add a schedule" forever, and printed "No
schedule loaded" for a job twelve activities late. The safe direction for a
capital project is the one where the imported commitments are visible to the
score the boss reads; a filter that hides them fails toward a confident,
wrong page.

**Implementation.** `isLiveMilestone` (every stored row), `liveMilestones`,
`isImportedMilestone` (for view toggles only) and `isOverdueMilestone`
(UTC-day, the storage convention) in `lib/milestoneLiveness.ts`; consumed by
`lib/projectSnapshot.ts`, `lib/projectReport.ts` and
`components/projects/ScheduleTab.tsx`. `spi` is computed from
`computeScheduleMetrics` over the same rows and is `null` while nothing is
due (never a fabricated 1.00).

**Do not** reintroduce a source filter in a consumer. A surface that wants to
HIDE imported rows from a list uses `isImportedMilestone` on the view and
keeps its metrics over the full set.

**Acceptance.** A project whose only milestones are imported reports a real
milestone count, overdue count, baseline state and SPI; the report prints its
milestone table; the coach does not ask for a schedule that exists
(`lib/__tests__/projectSnapshot.test.ts`, `lib/__tests__/projectReport.test.ts`).

**Reversal.** A stated facility requirement that imported rows are reference
only — then the flag is a per-import choice stored on the row, read by the
same predicate, and the Schedule tab's copy changes with it.

**Risk:** low.

*Landed 2026-09-29 (projects Round G; review fix 2026-09-30): counting every row only helps if every consumer reads the same rows. `lib/milestoneLiveness.ts` also exports `PROJECT_MILESTONE_READ_LIMIT` (1,000). The health snapshot and the printed report both read `order("planned_at").order("id").limit(PROJECT_MILESTONE_READ_LIMIT)`, which is the subset the Costs tab's unbounded `order("planned_at")` read gets under the API's default row cap. So EV, CPI and overdue agree across surfaces, and the report discloses "first N of M" above the bound (projects-tab `MON-5`). A new project-level milestone reader imports the same bound rather than choosing its own.*

*Verification fix (2026-09-30, projects Round G): the sentence above held only under the API's default row cap and with no planned-date tie at the cut, because the Costs tab ordered by `planned_at` alone. Its read now carries the same `.order("planned_at").order("id").limit(PROJECT_MILESTONE_READ_LIMIT)` (`components/projects/CostsTab.tsx:95-96`), so the snapshot, the report and the Costs tab read the same first rows by construction (source pin in `lib/__tests__/projectReport.test.ts`). The Schedule tab reads through `listMilestones` (`lib/milestones.ts`), with no `id` tiebreak and no explicit bound, so it agrees only for a schedule within the API's row cap. Bounding that read belongs to the owner of `lib/milestones.ts` (PC-3 / J6); `lib/milestoneLiveness.ts` now says so instead of claiming the Schedule tab reads the same rows.*

<a id="dec-48"></a>
## DEC-48 · Bid scoring honesty and the registry's evidence floor

**Decision. The bid tabulation scores only what a vendor states about its
own price and hours. (1) A DECLARED exclusion never lowers a score; it is
shown as a fact beside the price. (2) "Silent gap" detection is word
matching on free text and cannot tell a rewording from an omission, so it
is a PROMPT ("check: …") and never enters the score. (3) With neither in
the score, the coverage part is NOT SCORED until a per-RFQ scope checklist
exists; the composite is price + manpower with the weights renormalised.
(4) Labour hours are vendor-stated and AI-extracted, so they count only
where the field can corroborate them: manpower is scored for every bid or
for none — only when at least THREE bids in the field (one currency) state
plausible hours; with fewer, the hours are shown per row and every bid
— a typed-total (price-only) bid included — is scored on price alone and
can take the badge. Where manpower IS scored, a typed-total bid keeps its
price part (which still sets every rival's) and carries no composite:
"price only — not scored on manpower". Once three or more bids state
hours, each bid whose whole-price $/hr is more than 4× off the field's
log-scale median is flagged "implausible hours — check" and scored as not
stated; a bid within 4× of it never is. The median is taken within one currency: a mixed-currency field is
not scored and no row in it is flagged. When manpower is scored it moves
the composite by at most 5 points between bids that state plausible hours,
and a bid that states NONE (or implausible ones) scores 0 there — so
against a silent bid, stating plausible hours is worth up to 100 × the
manpower share (37.5 composite points at the default weights). (5) A
best-value badge needs two scored bids and a unique top; a tie is a tie; a mixed-currency field is not
ranked, and a bid with no printed currency is shown in the field's
currency, marked as assumed — or, when no bid prints one, shown as USD and
said so, and never awarded into a line kept in another currency without a
restatement. On the registry: `field_condition` change orders are
contractor-neutral (neither side's miss); a scorecard band is PROVISIONAL
below three recorded evidence points; a bidder is BOUND to a registry row
only by an exact (trimmed, case-insensitive) name hit, else exact
normalised-name equality with a single row, or an explicit human link —
never fuzzily and never on ambiguity; but the do-not-use GATE fails toward
the flag: without a link, a bid is flagged when ANY registry row its name
normalises to is barred (two rows normalising alike included), read from
the org's full list of barred rows.**

> Made during the projects Round G resolution (2026-09-29, package J4
> BID-TAB-AND-REGISTRY) closing `BID-3`, `BID-4`, `BID-6`, `BID-7`,
> `BID-12`, `COST-7` and `COST-12`'s band gate, and partially `COST-5`.
> **Numbering.** Minted on the package branch under provisional numbers
> and renumbered DEC-48 at merge (DEC-44 to DEC-47 were already taken on
> the integration branch). **For the
> user to ratify — three departures from binding defaults:** (a) the joint
> fleet's ownership rule makes the projects-and-cost brief binding for
> `lib/bidTab.ts`, and its COST-5 default — "100 − 15 per silent gap − 5
> per declared exclusion" — was NOT taken: it contradicts the RFQ letter
> this product sends ("declared exclusions do not lower your score") and
> `BID-4`'s finding that the matcher cannot carry a score; (b) item (4)'s
> silence-scores-0, at the cost that — once three bids state plausible
> hours — a plausible statement of hours outscores silence by up to 37.5
> points. The first landing described silence as taking "the floor"; the
> code never did. The first fix pass then let ANY stated figure buy that
> gap (a $150k bid stating one hour scored 79.2 and took the badge from a
> silent $100k bid). The second fix pass added a plausibility check (a
> person-day floor, and a 4× band around the median of two or more
> statements) that still let a lone 8-hour statement buy the gap ($150k
> at $18,750/h scored 79.2 over a silent $100k bid at 62.5) and, with two
> statements, flagged BOTH once they were 16× apart — one misread figure
> wiped out an honest bid's manpower score; (c) the three-statement rule
> that replaced it (verification of 2026-09-30) re-decides the pinned
> "cheapest does not automatically win" example, which the J4 brief kept
> green: in its original two-bid form the staffed bid is the only one
> stating hours, so manpower is scored for neither and the cheaper,
> thinner bid is badged on price with its three exclusions shown beside
> it; the example holds — and is pinned — once two more bids state hours
> in line with the staffed one.
>
> **Verification fix (2026-09-30, projects Round G).** Item (4)'s hours
> rule is the three-statement rule above (`MIN_CORROBORATING_STATEMENTS`;
> the person-day floor `MIN_PLAUSIBLE_BID_HOURS` is gone — a lone
> statement is no longer scored at all). The rationale's claim that "one
> padder cannot drag an honest bid out of line" was not true of the
> second fix pass and is replaced below by what now holds. The risk line
> said "low — pure scoring logic"; this decision also governs the award
> gate, and the line is corrected.
>
> **Verification fix (2026-09-30, projects Round G).** Second verification
> of this date (commit `2e080de`). A field scored on price alone still left
> typed-total bids unscored, so a typed €90k bid read "not scored" while a
> €100k bid took the badge "on price alone"; item (4) now scores them on
> price in such a field. The rationale overclaimed what one statement
> cannot do — it said one absurd or misread figure's hours change no other
> bid's score, which holds only for a figure that ends up flagged — and
> the residual now names the verifier's two counter-cases and what the
> proposed closer would and would not stop.

**Rationale.** The scorer punished the disclosure the RFQ letter promised
to reward (a single honest exclusion cost twenty points; hiding it cost
nothing) and accused competent bids of omitting scope they had priced in
other words. Any positive weight on a declared exclusion re-creates the
inversion in miniature, and any weight on detected gaps makes the score a
function of the word matcher. `BID-4`'s own option 3 — remove coverage from
the composite rather than score on noise — is the only honest position
until the RFQ carries an explicit scope list the bids are mapped onto.
Bounding manpower to five points between bids that state hours keeps
"price alone is never the verdict" without letting a padded figure outbid
an honest one; it does NOT stop a bid that states a plausible figure from
outscoring one that states none — the letter asks for hours, and silence
is treated as non-compliance. Hours count only where the field
corroborates them: one or two figures cannot be checked against anything,
so they buy nothing and no row is judged — every bid, typed totals
included, compares on price. With three or more statements the field's
median is the reference. What holds, exactly: a row is flagged only when
its own figure is more than 4× off that median; and when every OTHER
statement in the field agrees with every other within 4×, one added
statement cannot flag any of them (the median of three or more always
lies within the range of all the values but one) — if the added figure is
itself flagged, it is left out of the band's best $/hr and out of the
three-statement count, so its hours change no other bid's score (its price
competes like any price). A statement that is NOT flagged can move other
bids, by design: it may set the band's best $/hr (at most 5 composite
points on the others) or be the third plausible statement that switches
manpower on — a $150k / 400 h bid ($375/h) beside $100k / 1,000 h and
$100k / 1,100 h bids is plausible, and a silent $95k bid drops from 100
to 62.5 and loses the badge. Where the other statements do NOT all agree
within 4×, one added statement can do more (`COST-5`'s residual): it can
flag several bids at once, honest ones that agree exactly included — two
bids at $100/h beside one misread at $2,000/h leave only the misread one
flagged, and a second $2,000/h figure moves the median to about $447/h
and flags all four; and it can REMOVE a flag and switch manpower on —
with $20, $100 and $500/h statements and a cheaper silent bid, the $20
and $500 figures are flagged, manpower is off and the silent bid is
badged at 100, and one more $20/h figure moves the median to about $45/h,
clears the $20 flag, makes three plausible statements and drops the
silent bid to 62.5, off the badge. One commendation graded "Excellent"
is a rating, not evidence; three points is the floor. Binding and gating differ on purpose: binding on an
ambiguous name would put the wrong company's record beside the price;
clearing the do-not-use flag on the same ambiguity would let a barred
company through because a duplicate registry row exists.

**Implementation.** `lib/bidTab.ts` (`scoreBids`, `effectiveWeights`,
`MANPOWER_MAX_COMPOSITE_SWING`, `MIN_CORROBORATING_STATEMENTS`,
`HOURS_PLAUSIBILITY_RATIO`, `BidEconomics.implausibleHours`,
`scopeSimilarity`, `matchCompanyByName`, `companyCandidatesByName`,
`barredCompanyFor`, `fieldCurrency`, `bidCurrency`), `lib/companies.ts`
(`listBarredCompanies`), `lib/rfqDocx.ts` (the letter, quoted below),
`lib/companyScore.ts` (`MIN_EVIDENCE_FOR_BAND`,
`scoreBand(score, evidenceCount)`), `lib/companies.ts`
(`CONTRACTOR_CO_REASONS` / `OWNER_CO_REASONS`),
`components/projects/cost/QuotesPanel.tsx` (the footer and the hours
tooltip state the effective weights, the 5-point cap and what silence
costs — or, where fewer than three bids state hours in line, that the
score is price alone and why; coverage is not scored). The letter reads
"Price is scored, and so is manpower once at least three bids state labor
hours in line with one another; scope coverage and any undeclared gaps are
reviewed by our evaluators".

**Acceptance.** The same bid scores identically with and without its
declared exclusion; realistic rewordings of identical scope never change a
score; with fewer than three bids stating hours no bid's manpower is
scored and no row is flagged (a lone 1-, 8- or 1,500-hour statement does
not take the badge from a cheaper silent bid); once three bids state
plausible hours, any two of them differ by at most five composite points on
manpower and a bid stating none scores 0 there (pinned, with the
37.5-point consequence); a bid more than 4× off the median of three or
more statements is flagged and scored as not stated, and a row within 4×
of it never is; adding an absurd statement of hours to a field whose
other statements all agree within 4× changes no other bid's score (pinned
with the absurd bid priced above the field's lowest); in a field scored
on price alone a typed-total bid is scored and can take the badge, and in
a field that scores manpower it reads "price only — not scored on
manpower" with no badge (both rendered and pinned); a mixed-currency
field flags no row; a single
bid or a tie carries no badge; a mixed-currency field has no scores; a registry row
with one commendation reads "Provisional"; a barred registry row beside a
same-normalised sibling still flags the bid and prompts for the override.

**Reversal.** Coverage re-enters the score when an RFQ carries a per-RFQ
scope checklist and each bid's line items are mapped onto it (`BID-4`
option 2) — then declared exclusions can be priced from the field's own
line items and the letter is reworded in the same change. If the user
prefers the projects-and-cost weighting, the −15 / −5 coverage part is a
`scoreBids` change plus the letter. If the silence gap is unacceptable,
give an hours-silent bid the swing floor (`100 − 5 / manpowerShare`)
instead of 0 and re-decide the pinned "cheapest does not automatically
win" example in the same change. The thresholds (three statements, 4×)
are constants in `lib/bidTab.ts` (`MIN_CORROBORATING_STATEMENTS`,
`HOURS_PLAUSIBILITY_RATIO`). If an added statement must never flag
another bid (`COST-5`'s residual, first case), replace the median test
with an absolute corroboration rule — a statement counts only when two
others sit within 4× of it — which is monotone: no added statement can
un-corroborate another. It does NOT stop a statement from ADDING
corroboration — clearing another bid's flag, or making the third
plausible statement that switches manpower on and moves every other bid
(the residual's second case, and the $150k / 400 h example) — and no rule
can while manpower switches on at three statements: that is item (4)'s
own trade. `field_condition` attribution and
the five-point cap are org-level tunables once an org states a different
reading of the reason-code contract.

**Risk:** medium (corrected 2026-09-30; first recorded as "low — pure
scoring logic"). The scoring half is pure and every branch is pinned by
tests, but this decision also governs the award gate: the do-not-use flag
fires on any registry row a bidder's name could be (a wrong call lets a
barred company through without the recorded override), and a bid whose
currency cannot be vouched for is not awarded into a budget line kept in
another currency without a restatement (a wrong call posts a commitment
in the wrong currency). Both gate limbs are pinned by rendered tests
(`quotesPanelRender.test.ts`).

<a id="dec-49"></a>
## DEC-49 · A presigned download is an attachment unless a viewer asks and the type cannot be a page

**Decision. Every presigned GET that `/api/storage/download-url` issues — and
so every URL `lib/storage`'s helpers hand the app — is signed with a
Content-Disposition. It is an ATTACHMENT by default. It is INLINE only when
the caller explicitly asks (`?inline=1`) AND the key names a type a browser
shows in a viewer rather than as a page — PDF, PNG, JPEG, GIF, WebP — and an
inline URL pins its Content-Type to that type. SVG, HTML, XML, script, text and
anything unknown are attachments whatever the caller asks. Two other issuers
still sign bare GETs and are known exceptions until their owners adopt the
same helper: `/api/storage/resolve` (the archive-aware opener) and
`lib/dataExport.ts` (the data-export envelope's per-file URLs) — both
projects-tab `SEC-18`. The in-app viewer frames only a file that arrived
typed as a PDF, re-typed to exactly that type; a PDF frame is not sandboxed,
because Chromium will not run its PDF viewer in a sandboxed frame; a raster
image is shown as an `<img>`, never framed; nothing else is shown. When the
bytes cannot be fetched, a legacy absolute URL on another origin is shown only
when its path names a PDF (the frame) or a raster image (an `<img>`) — such a
URL was not signed by the route, so the type it is served with is the stored
one (`SEC-18`'s class).**

> Made during projects Round G (2026-09-30, package J9) under the protocol's
> fail-safe rule, closing projects-tab `SEC-7` and the egress limb of `SEC-1`.
> It delivers the download-disposition item of projects-and-cost `INTK-11`
> for URLs this route issues; that record's owner should cross-reference it.
> **Numbering.** DEC-49 on the integration branch (DEC-44 to DEC-48 were
> already taken when this package merged).

**Rationale.** A presigned URL signed with no overrides is served with the
object's stored type, and for an intake upload that is whatever the uploader
declared — so the browser renders an HTML "drawing" as a page. One parameter
defuses the delivery half of the chain (report `11`: "the highest
value-per-line change in the whole audit"). Inline is still needed — the
document viewers frame PDFs and open them in new tabs — so it is an opt-in the
route bounds: a caller may ask for inline, but it can never get an HTML page
inline, because the route decides by the key's type and pins what the browser
will see. The viewer gate is the same rule on the client: the type the bytes
arrived with decides what they may be rendered as, and they are re-typed to
exactly that type, so no HTML parser ever sees them. Sandboxing the PDF frame
was rejected because it blanks every controlled drawing in Chrome; the type
gate carries that frame instead.

**Implementation.** `lib/presignedDisposition.ts` (`presignedGetDisposition`,
`wantsInline`, `INLINE_TYPES_BY_EXTENSION`, `viewerRenderKind`);
`app/api/storage/download-url/route.ts` spreads the overrides and answers
`disposition` / `contentType`; `lib/storage.ts` — `getSignedUrlForPath(path,
expiresIn, { inline })` is an attachment by default, the viewer resolvers
`resolveFileUrl` / `resolveFileUrlDetailed` ask for inline, and inline and
attachment URLs are cached apart; `components/viewers/SecureDocViewer.tsx`.
Reviewed inline callers: `SecureDocViewer`; `resolveFileUrl`'s callers
(`MultiDocViewer`, `CompareRevisionsModal`, `ReviewGateSection`'s draft
preview); the ticket file viewer's PDF frame
(`app/(protected)/requests/[id]/page.tsx`, the `FileViewerModal` region
drafting-flow DF-P10 owns for `PHYS-2`, `PHYS-9`, `EVID-5`, `EDGE-2` and
`AUTHZ-12` — its rewrite must keep
`getSignedUrlForPath(file.url, undefined, { inline: true })`); the cited-page
viewer's new-tab link (`components/knowledge/CitedPageViewer.tsx`, which
intelligence I-07 edits for `DWG-3` and I-12's `KACL-5` cites — keep
`getSignedUrlForPath(view.fileKey, undefined, { inline: true })`). Both are
source-pinned in `lib/__tests__/presignedDisposition.test.ts`. A census there
fails for any presigned-GET issuer under `app/api` or `lib` that signs no
disposition (two named exceptions, `/api/storage/resolve` and
`lib/dataExport.ts` — projects-tab `SEC-18`).

**Do not** frame or open a signed URL without `{ inline: true }` (it will
download instead), and do not add a type a browser renders as a document (SVG,
HTML, XML) to the inline list.

**Acceptance.** `download-url` without `inline` signs
`response-content-disposition=attachment; filename="…"`; with `inline=1` on a
`.pdf` it signs `inline` and `response-content-type=application/pdf`; with
`inline=1` on `.html` or `.svg` it signs `attachment`; the viewer frames only
a file that arrived typed as a PDF and shows a raster image as an `<img>`.

**Reversal.** Serving untrusted uploads from a separate origin (report `11`
item 9, `GAP-401`) would let the inline list widen; a Chromium that runs its
PDF viewer in sandboxed frames would let the PDF frame take `sandbox=""` too.

**Risk:** low — every change narrows; the viewers that frame keep working
through the opt-in.

<a id="dec-50"></a>
## DEC-50 · The money ledger's derived figures and rails

**Decision. The cost rollup's headline is what is still UNCOMMITTED; approved
change orders revise the budget without touching the baseline, but only while
their money is on the ledger; CPI forecasts only what CPI measured; the
ledger is never deleted; and a refusal is always a sentence with a repair
path, never a silent success.**

> Made during projects Round G (2026-09-29) by the joint J3 MONEY-LEDGER
> package, taking the briefs' stated defaults. Each rule below is the fail-safe
> reading of its evidence, chosen so the packages that consume these figures
> (health, report, charts) can proceed. *Numbered DEC-50 at merge (DEC-44 to DEC-49 were already taken on the
> integration branch).*

**Rules.**
1. **Exposure** = spent + open commitments, where a commitment is drawn down
   by the actuals invoiced against it, matched by party, never below zero.
   `remaining` = revised budget − exposure, labelled *Available (uncommitted)*;
   the actuals-only figure (revised budget − spent) is secondary and labelled
   *unspent (actuals only)* — never "uninvoiced", which is the Committed
   tile's open-commitment figure; `overBudget` trips on exposure (`MON-4` /
   `COST-2`). An unmatched party over-counts exposure — the conservative
   direction.
2. **Revised budget** = budget + approved change orders by cost account,
   counting ONLY an approved CO whose linked entry (`posted_entry_id`) is
   still POSTED — an approval whose entry was voided by hand (the base's only
   unwind), or whose link is missing, revises nothing and is listed for
   repair (rule 7). The original budget stays the visible baseline; EV, CPI,
   remaining, overBudget, the forecast and the S-curve's planned line use the
   revised figure; the health score's "change control" part keeps scoring
   growth against the baseline and says so (`COST-4`). No stored
   `budget_revised` column — derived from the ledger. The linked entry's
   status is read BY ID (`listChangeOrders` → `postedEntryStatus`), never
   looked up in a loaded page of entries, and one rule
   (`changeOrderOnLedger`) serves the revised budget and the change-order
   summary (`summarizeChangeOrders` — the CO panel's and the report's
   "approved" figure) alike *(verification fix, 2026-09-30)*. Every
   consumer passes `approvedChangesByAccount(await listChangeOrders(projectId))`:
   today only the Costs tab does; `lib/projectSnapshot.ts` and
   `lib/projectReport.ts` (J7, merged without it) call `computeCostRollup`
   without the map, so health and the lessons-learned draft agree with the
   tab only while no change order is approved (`MON-4` dw3, `COST-4` dw2 —
   a follow-on).
3. **CPI scope.** The CPI-based EAC applies to the milestone-pinned subset;
   the unpinned remainder, having no earned-value evidence, is carried at its
   BUDGET — a spend pace (when the schedule gives one) may raise it above
   budget, never lower it below (a barely-started line's pace would otherwise
   drop the rest of its budget and print "under budget"); every part is
   floored at its own spend, so an EAC is never below money already spent;
   the split is labelled wherever the EAC is printed (`COST-1`).
4. **Change-order authority.** Self-decision is refused while another
   eligible decider exists (DEC-12's derivation over controllers + owner,
   DEC-37's one-deliverable reading), otherwise allowed and marked; the
   approval threshold is `org_configurations.change_order_approval_threshold`
   with **no default** — a shipped default that blocked every large CO would
   strand real approvals; the marker + audit make the gap visible; a
   malformed amount means no threshold (lib and trigger alike, never a cast
   error). At the database the decider is the SIGNED-IN caller — never a
   client-written `decided_by` / `created_by`: a session records itself as
   the decider, the proposer is pinned at insert and never rewritten, and
   `decided_by` changes only by the decision or its revert (`COST-6`).
   *(Verification fix, 2026-09-30, four passes.)* A signed-in caller's
   INSERT is only the app's proposal: proposed, proposer = caller, no
   decision and no link (`posted_entry_id`, `decided_by`, `decided_at`,
   `decided_by_name`, `decision_note` NULL), `org_id` = the project's org.
   A signed-in caller's UPDATE is only one of the app's update steps, and
   each step may change only the columns it writes — every other pinned
   business column of the row must stay as it was (`updated_at` /
   `updated_by` are not pinned): the budget-line pick (proposed → proposed:
   `cost_account_id`); the decision (proposed → approved / rejected / void:
   status and the decision fields, recording the caller; void runs neither
   rule — it moves no money; an approval needs a row with no link yet); the
   entry link (approved → approved: `posted_entry_id`); the unwind and the
   repair reverse (approved → void: status and the note, refused while the
   linked entry is still posted); and the
   failed-post revert (approved → proposed: status and the decision fields,
   cleared, only by the approver while no unlinked posted commitment
   carrying the CO's number is on its line). Rejected and void are
   TERMINAL — void → approved does not exist (the unwind voids the entry
   first, so it never needs a put-back) — and approved → rejected does not
   exist. `posted_entry_id` links only the CO's own posted commitment (same
   project and line, its number, no source document, no other CO linked)
   and is never repointed away from a posted entry. A cost entry is never
   edited by a signed-in caller — its status moves only posted → void, and
   no other column changes (`20261093`) — so a posted commitment cannot be
   renamed out of the revert's look-alike test. `decideChangeOrder` binds a
   decision to the amount AND the budget line the decider was shown
   (compare-and-swap on both). The service role keeps its pass (it
   bypasses the insert policy; the guards let it through). Still open at
   the database: which budget line a proposed CO names (it may be
   re-picked until the decision, and the id is not tied to its project —
   only the lib binds the decision to the line shown); `decided_at` is the
   caller's clock; `updated_at` / `updated_by` are writable; another
   BEFORE UPDATE trigger that writes a pinned column would make the guards
   refuse (counted before apply, not handled); deleting a party that
   entries or COs reference is refused (no app path deletes one); rows
   written before the rail are counted by the inventory, not rewritten.
5. **No FX.** A document in another currency than its budget line is refused
   at posting; no conversion is built. A stored "$" / "US$" is USD, a
   non-code is unstated, an account with no currency is USD (as rendered),
   and `setManualTotal` corrects a document's currency (`COST-8`).
6. **Never delete.** Every direct DELETE on the four money tables is refused
   at the database except the audited project purge (`app.record_purge =
   'project:<id>'`, the GUC contract shared with the project-purge RPC) and
   the service role, audited first (`COST-10`). An FK cascade from the
   parent project's (or org's) own delete passes the money-table guard:
   whether a project that holds money may be deleted is the PROJECT's rail
   (J8's `projects` guard + `delete_project_record`), so the app's existing
   Delete-project action is never broken by this guard; until J8 lands, a
   project delete still takes its ledger with it, as before.
7. **Repair, not correction.** A claimed-but-unposted document, or an
   approved change order whose linked entry is missing or void, is surfaced
   on the Costs tab and repaired by an audited action, never rewritten
   silently (`MON-1` / `COST-11`): a document by re-post or revert
   (`repairCostDoc`), a change order by link (to a posted commitment on its
   line carrying its CO number) or reverse (when none remains) —
   `repairChangeOrder`. A document is ATTENDED — never listed, never
   re-posted — when any entry links to it (a hand-voided one was the
   correction) or when an UNLINKED entry of its award/invoice shape stands
   for it (pre-Round-G money carries no link; re-posting it would double it).
   The line renders only once `20261093` (its view and backfill) has run.
   *(Verification fix, 2026-09-30.)* A document whose linked entry was
   voided by hand is refused BOTH repairs — the void was the correction, and
   reopening the paper would let its money post a second time. The unwind of
   a change order whose entry is already void applies the repair reverse's
   look-alike refusal. A truly stuck document hidden by an ambiguous legacy
   entry of its shape is a hand (SQL) repair, recorded as `MON-1`'s
   residual — no link UI.
8. **Declined rivals.** A grouped award declines every still-open quote in
   its RFQ group, the group compared by key (case-folded, whitespace
   collapsed — the bid tab's key). An ungrouped award declines NOTHING
   automatically — ungrouped quotes tabulate alone and are often for
   unrelated work (the intake-link case copies a null group), and there is no
   declined → open path — so the award's `warning` names the ungrouped quotes
   that stay open and a competing one is declined by hand through
   `declineQuote` (audited, `COST_DOC_DECLINED`). `declined` moved no money,
   so it can still be voided or have its total corrected (it stays
   declined). The RFQ group is the scope handle (`MON-10`). *(Amended in the
   fix pass: the first cut declined every open ungrouped quote on the
   project, which marked unrelated scopes "not selected" with no way back.)*
9. **Do-not-use.** Awarding a company flagged `do_not_use` or `inactive`
   needs a reasoned override, audited by company id by the lib after the post
   (`MON-12`). The refusal is LIB-LEVEL (the caller's session — no database
   rail), resolves the company by `cost_documents.company_id`, then the
   party's link, then a single exact name, and fails CLOSED on any failed
   lookup. Callers pass `overrideReason`; they do not write their own
   override row.
10. **Truncated reads.** When the AI read a document and the read was
    truncated — or, once the extent columns exist (J4's `20261096`), of
    unknown extent — its total posts only with the figure typed back from
    the paper (`confirmedTotal`, equal to the row's total in whole units),
    whether that total is the extraction or a hand correction: the
    confirmation is EXPLICIT, never inferred from whether the total differs
    from the AI's reading *(verification fix, 2026-09-30 — the earlier "a
    human-typed total needs none" is withdrawn for totals of a read
    document)*. A total nobody read (no extraction) needs none; a
    `confirmedTotal` that disagrees with the row is always refused. Before
    the columns exist there is nothing to read and the check is a no-op
    (`COST-13` posting limb).
11. **One number.** The money paths post `total_amount ?? extraction`.
    `parsedQuoteFrom` returns the extraction unmodified (the bid tab shows
    "corrected by hand from the AI's X" from it); the display overlay is the
    consumer's — J4's `withHumanTotal(q, doc.totalAmount)` is the accepted
    contract, and any new consumer that shows a total applies it (`BID-1`
    dw1, recorded by J4).

**Acceptance.** `lib/__tests__/costs.test.ts`, `lib/__tests__/costDocs.test.ts`,
`lib/__tests__/moneyRailsMigration.test.ts`; migrations `20261093`, `20261094`.

**Reversal.** Per rule: 1 and 2 are label + formula changes in `lib/costs.ts`
and `approvedChangesByAccount`; 3 is `computeForecast`'s pinned branch; 4's
threshold is per-org configuration and its rail the `20261094` trigger; 6 is
the delete-guard trigger; 7 is `listLedgerOrphans`' attendance test and the
view; 8 is `awardQuote`'s group filter plus `declineQuote`; 10 is
`extentRefusal`.

**Risk:** medium — the headline money figure changes meaning on every Costs
tab (from budget − spent to budget − exposure); the previous figure stays
visible as the secondary line.

<a id="dec-51"></a>
## DEC-51 · A schedule re-import is a reviewed merge, never a guess

**Decision. The importer decides nothing it cannot read from the file, shows
what it would do before it writes, and never erases what the crew recorded.
Concretely: (1) day-first vs month-first is decided once from the file's
date values (a CSV's start and finish columns; XML / XER dates are ISO) — a
file that cannot decide it asks the user once, and the answer applies to
every row, weekday-prefixed dates included; (2) a row the file does not carry is reported as "not in this
file" and left alone — removal is a separate explicit action; (3) progress,
status and actual dates recorded in the app survive a re-import unless the
user opts in per import; (4) identity is the source system's id where one
exists, otherwise a hash of the row's own content — never its position and
never its name alone; a row imported before content keys (keyed by its
position) is adopted — a one-time, reviewed transition — only when its
normalised name occurs once among the position rows of its source tag and
once in the file: it is that task whatever its dates, the file's dates are
written and the crew's progress kept; a position row whose name repeats on
either side is never adopted — the file's rows are added, the old rows kept
as "not in this file", and the plan names both the adopted and the repeated
tasks before anything is written (residual: repeated-name legacy tasks are
duplicated rather than matched, visibly); no zone offset is inferred; and a
keyless row whose name or dates change becomes a new
row, the old one reported as "not in this file" — the fail-safe, said in
words in the review panel; (5) relationship type and lag are captured on every
link; the engine honours finish-to-start, and everything else is stored on
the task and reported as "not enforced" until the reflow has its own test;
(6) a file that holds several projects asks which one and never merges; (7)
MS Project's Predecessors resolve through the ID column, and an unresolvable
token is counted, not guessed; (8) a level-0 summary row is the root parent,
not a sibling leaf; (9) every date form is read as wall-clock-as-UTC (never
the importer's zone); a value that names its zone directly after its time —
a numeric offset (after AM / PM too; a.m. / p.m. normalised) or a listed US /
European abbreviation in upper case, at its fixed offset — is read at that
instant; other words after the time ("est." = estimated) are ignored and
reported; an abbreviation on a date with no time is dropped (the date stays
00:00Z); an unreadable start, like an unreadable finish, skips and counts
its row; and a day / night shift label follows its task when the
start moves into the other band (every date-writing path, one rule) — an
unlabelled row stays unlabelled, a hand-set swing is kept, a date-only start
(stored at 00:00Z) earns no label, and existing rows are recomputed in bulk
only on request; (10) the approved baseline is set and cleared only through
RPCs that enforce the schedule-editing predicate, keep every prior snapshot,
and audit themselves — a guard refuses a direct baseline write on UPDATE and
on INSERT, and the RPCs' pass names the project and lasts only for their own
UPDATE; (11) a batch move
leaves a per-row reschedule breadcrumb, the same one a single edit leaves;
(12) an import is capped at 5 MB / 5,000 rows, shows progress, can be
cancelled, and tags every row it touched with its batch id; (13) what is
written is what was reviewed — a change to the column review discards the
plan — and a batch move the lock rejected is reported as an error, never a
success.**

> Made during projects Round G (2026-09-29) under the protocol's fail-safe
> rule, taking the defaults the fleet plan proposed for `GAP-403`, `SCH-1`,
> `SCH-2`, `SCH-3`, `SCH-8`, `SCH-14`, `SCH-16` and `SCHED-1`, `SCHED-3`,
> `SCHED-6`, `SCHED-8`, `SCHED-9`, `SCHED-11`.

**Rationale.** A weekly re-import is the normal case, and every one of these
defaults replaces a silent guess with either the file's own evidence or a
question the user answers once. The alternatives — a locale default for
dates, treating an absent row as deleted, a file-name namespace for identity,
flattening SS / FF to FS — each looked cheaper and each was a data-integrity
defect in the audit.

**Implementation.** `lib/scheduleParsers.ts` (`detectDateConvention`,
`contentKey`, `hasTimeOfDay`, `ParsedLink`, `ParseOptions`,
`SCHEDULE_IMPORT_LIMITS`), `lib/milestones.ts` (`importMilestonesFromParsed`
with `dryRun` / `overwriteProgress` / `signal` / `onProgress` and the
position-row adoption, `applyMilestoneMoves` / `MoveConflictError`,
`setBaseline` / `clearBaseline`), `lib/scheduleFilter.ts` (`shiftForStart`,
`shiftAfterMove`),
`components/projects/ScheduleImportModal.tsx`, migrations `20261097`,
`20261098`, `20261099`.

**Acceptance.** Inserting a row at the top of a source file leaves every
other row's identity and progress intact; a genuinely ambiguous date file
imports nothing until asked; a re-import with no changes issues no write
(against PostgREST's `+00:00` timestamp rendering); the first re-import of
a keyless file imported by position adds nothing for tasks whose names are
unique on both sides, whatever zone the earlier import ran in, and never
moves a completion between tasks — a repeated name is added, its old rows
kept, and the plan names it; an
SS + FF ladder creates no cycle; the anon key cannot call the batch-move or
baseline RPCs.

**Verification fix (2026-09-30, projects Round G).** Items (4) and (9), the acceptance and the risk
restated to what the code does after three verifier passes: position rows
are adopted only by a name unique on both sides (no offset, zone or DST
inference — each inferred rule produced wrong pairings), repeated names are
added and their old rows kept, visibly; a zone named directly after a time
(a numeric offset, or an upper-case listed abbreviation) is read at its
fixed offset and other trailing words are ignored and reported (PT `SCH-3`,
PC `SCHED-9`).

**Reversal.** Per item, by a stated requirement: a facility that wants a
locale default for dates changes the modal's radio default, not the parser;
a facility that wants "missing = deleted" adds it as the separate explicit
action this decision already reserves.

**Risk:** low — every default fails toward asking or leaving data alone.
Item (4)'s transition fails toward duplicates: a legacy task whose name
repeats is added again rather than matched (its old row and progress kept
and listed), and a unique-named one is matched by name even when the file
moved it.

<a id="dec-52"></a>

## DEC-52 · The quality record's evidence contract

**Decision. A green on a PSSR / MI / QA-QC line means one of two things, and
the row says which: a PERSON decided it (a typed reason that meets the bar,
uid on the row — a person-attached chip is evidence, not a reason), or the
MACHINE cited the row that proves it (an admitted document, an accepted
turnover item or a human-completed MI checklist — the database resolves the
citation before it accepts the green) and the next sweep withdraws the green
once that proof is gone. Any other green (a legacy one, or a note under the
bar) is never a person's: a checklist holding one completes only as
`'auto'`.**

The defaults the projects Round G quality package (`J2 QUALITY`: `SAF-1`–`SAF-4`,
`QUAL-1` / `2` / `5` / `6` / `7` / `8` / `11` / `12` / `13`, `PERF-7`, `UX-7` / `8` /
`10`) adopted, recorded so nobody re-litigates them per surface:

1. **Evidence register** (`SAF-1`, `QUAL-13`): only documents at `Issued` or
   `Locked` with a `current_version_id` are admissible; `NOT_CURRENT_STATUSES`
   (`lib/aiBoundary.ts`) and `Draft` never are; an external (intake) submission
   counts only once its CURRENT version is `approved` (an earlier rejected
   submission does not taint an approved current revision; a failed version
   read admits nothing); documents attached to ACCEPTED
   turnover items are listed first; a document whose current version the read
   did not return is not admitted either. A title match inside that register is the
   citation; a title match outside it is nothing. Equipment-tag binding via
   `document_assets` is a follow-on, not built. **Departure from the P2 brief's
   default, for the orchestrator to accept:** the brief rendered a title match as
   "suggested", never green; here a title match inside the register is a
   labelled MACHINE green — withdrawn when its document leaves the register,
   re-checked at "Mark complete" (item 2), and never citable, since a completion
   containing one is `'auto'` (item 5). A checklist can be completed on machine
   greens; the basis restricts citation, not completion.
2. **Retraction** (`QUAL-1`): an auto-only green whose probe no longer proves
   it goes to `needs_evidence` on the next sweep, stale auto chips removed,
   in one audit row per sweep whose `items[]` names each item. "Mark complete"
   re-checks at the moment it matters: a sweep green whose document has left
   the register (or whose proof the sweep would withdraw or re-cite) refuses
   the completion until the sweep runs. A human chip or note is never touched.
   The migration lists stale greens (inventory) and never rewrites them.
3. **Bulk AI action** (`SAF-2`, `QUAL-5`): per-item review, every row unticked
   by default, apply writes only ticked ids, the audit row carries the ids;
   the bulk "tick every in-scope proposal" never ticks an N/A.
   The assessment never moves a satisfied or evidence-bearing item to N/A —
   such proposals are listed and locked; the human N/A control (with a
   reason) is the only way.
4. **The reason bar** (`SAF-4` / `GAP-405`): 10 non-whitespace characters, no
   canned text — checked in the client data layer (`reasonProblem` in
   `lib/checklists.ts` / `lib/turnover.ts`), mirrored by `appPrompt({ required,
   minLength })`, and ENFORCED by the database (`quality_reason_ok()` and the
   20261091 rails on waive / reject / reopen, punch void, and every checklist
   decision a person makes — satisfied, N/A, item reopen; the service pass —
   restores, server routes, the SQL editor — passes). A decision needs its
   OWN reason: the note already on the row belongs to the earlier decision
   (compared normalised — case, spacing and invisible characters do not make
   a new one), and a standing decision keeps its reason (a turnover decision
   its reviewer, date and reviewed document; a punch closure its closer and
   date) until the next one; a checklist note is never cleared. The bar
   strips Unicode whitespace and zero-width characters before measuring, in
   the lib and in the database alike. No placeholder is ever written. Waived
   is its own bucket.
5. **Completion basis** (`QUAL-2`): `project_checklists.completed_basis` is
   `'human'` only when every applicable item is green or N/A, every green
   and every N/A carries a person's reason (a note that meets the reason bar
   — `x` is not one, and a person-attached chip is evidence, not a reason),
   and at least one green was decided by a person; otherwise `'auto'`. The
   completion itself is refused by the database while the checklist has no
   items or an applicable item is neither green nor N/A; an item is never
   deleted on its own or moved; every item write serialises with the
   completion (a SHARE lock on the checklist row); and a completed
   checklist's items, kind and project are frozen until it is reopened
   (which clears the basis). Only a `'human'` MI completion
   is citable by another checklist. The DATABASE records it
   (`checklist_completion_basis()`, the same rule as `completionBasis()`,
   computed by a rail when the status moves to complete; a client value is
   ignored), and the backfill uses the same function. A person gives a sweep
   green their decision with **✓ Verify** and an assessment N/A with **✓ Confirm
   N/A** (reason on the record; the sweep's chip kept; the sweep hands-off from
   then on).
6. **Machine actor** (`QUAL-6`, `DEC-35`): `updated_by = NULL` + a sentinel
   name. The sweep and the assessment run in the browser under the user's
   token, so the database bounds a machine-stamped write to what that
   machine writes — the sweep: status (satisfied / needs evidence) and its
   own citations, each resolving to its row (an admitted document, an
   accepted turnover item, a human MI completion); the assessment:
   applicability, its rationale and the status that follows, never an N/A on
   a satisfied or evidence-bearing item; neither on an item a person decided
   (a visible note or a person chip), neither touching text, section, seq or
   the note — and stamps every other signed-in write with the caller's uid
   and sign-in name (`auth.users`, which the app cannot edit); all a machine
   write can produce is `'auto'`. A server-side sweep (service role) would
   make the actor unforgeable — a follow-on. Provenance is carried by the existing `updated_by` / `updated_by_name`
   pair and `evidence[].source` / `documentId`; no `satisfied_by` /
   `satisfied_how` columns were added (a column the sweep must write breaks
   the sweep until the migration is applied — `DEC-30`).
7. **Turnover history** (`QUAL-11`): `turnover_review_events`, append-only and
   written only by the database — a trigger on `turnover_items` appends one row
   per status change in the same statement (no client INSERT); the decisions
   made before it existed are backfilled. A rejection is a `nonconformance`
   event, a reopen of an accepted / waived item is a `reopen` event whose OWN
   reason (a new note that meets the bar) the database requires. Each row
   carries the note its decision changed and the reviewer's sign-in name,
   never the client's; a history row outlives a deleted item
   (`item_id` is a plain column); a restore never imports the history
   (`IMMUTABLE_TABLES`) and writes one row per restored decided item. There is
   no separate NCR module (a follow-on capability if a facility wants
   disposition / corrective-action tracking).
8. **Punch record** (`QUAL-7`): `closed_by_name`, `description`, `location`,
   `closure_note` as nullable text; photos / attachments deferred.
9. **Checked writes** (`SAF-3` / `GAP-402` narrow): `lib/checkedWrite.ts` is the
   one helper; every quality decision write uses it and audits only after a
   confirmed match; the census in `lib/__tests__/checkedWrite.test.ts` holds
   the quality files at zero raw writes and ratchets the money files until
   `J3` converts them.
10. **Batching** (`PERF-7`, which stays OPEN): n checked, `updated_at`-guarded
    single-row client writes, at most 50 in flight (wall-clock ≈ ceil(n/50)
    waves; still n requests) — not a server-side RPC, which would tie both paths
    to a pending migration. A single-statement apply (one request per
    assessment) is the follow-on that closes PERF-7; it must keep the per-row
    guard.

**Verification fix (2026-09-30, projects Round G).** An independent verifier
(Postgres 16, RLS on, as the project owner) showed items 4, 5, 6 and 7 claimed
more than 20261091 did at 13fcd5e: a machine-stamped write with the note `x`
laundered an MI completion to `'human'`; a checklist with open items completed
by a direct PATCH; a reopen, a waive or a void reused the note already on the
row, and a note-only update cleared a waiver's reason; a direct reject's note
never reached its history row, deleting a decided item deleted its history,
and the reviewer's name was the client's. Each is now enforced as written
above (`checklist_items_decision_rail`, `project_checklists_completion_basis_rail`,
`checklist_completion_basis`, `turnover_items_decision_rail`,
`punch_items_void_rail`, `turnover_items_record_review_event`,
`quality_actor_name`; `lib/__tests__/qualityRailsMigration.test.ts`), with the
lib mirroring the own-reason rule and keeping the sweep and the assessment off
human territory.

**Verification fix 2 (2026-09-30, projects Round G).** A second
independent pass showed items 4–7 still claimed more than 20261091 did at
c031239: a person chip counted as a person's decision and a made-up sweep
citation passed, so a checklist with no reason anywhere completed as
`'human'`; deleting an unmet line, or racing a completion, walked round the
gate; a machine-shaped write could rewrite an item's text; a completed
checklist could change kind; a standing acceptance's document and a standing
void's closer and date could be rewritten; a note plus a trailing space, or a
reason of no-break spaces, counted as a reason; a fresh `reviewed_at`
re-attributed a carried note; and the actor's name came from a profile the
user can edit. Items 4–7 above now say what the database enforces
(`checklist_completion_basis`, `checklist_auto_citation_ok`,
`checklist_items_decision_rail`, `project_checklists_completion_basis_rail`,
`turnover_items_decision_rail`, `punch_items_void_rail`,
`turnover_items_record_review_event`, `quality_reason_key`,
`quality_actor_name`; `lib/__tests__/qualityRailsMigration.test.ts`), with the
lib mirroring the reason rule, the key, the chip rule and the citation rows.

**Verification fix 3 (2026-09-30, projects Round G).** A third independent
pass found the citation rule refusing the sweep's own greens on the normal
production document — a current version with NO provenance (the bulk
upload's, every version before 20260823): `v.provenance = 'external'` is
NULL there, so the predicate refused what the lib admits (the predecessor's
app writes landed 56 of 58). It now reads `v.provenance IS NOT DISTINCT FROM
'external'`, and every other predicate in 20261091 was audited for the same
NULL trap (none other found — the rest read NOT NULL columns, guard with
COALESCE / IS [NOT] DISTINCT FROM, or mean "no row, no proof" by design). The
same pass tied every citation branch to the item's org, read a legacy
evidence value stored as one object as a single chip (in the lib too), and
capped an item write's wait for its checklist row at 500 ms so a delete that
cascades into it no longer deadlocks against it. The headline above no longer
counts a person-attached chip as a person's decision (verification fix 2
made the database stop counting it).

**Rationale.** A pre-startup safety review is signed. The audit found the
green could come from a contractor's filename, survive the document's voiding,
launder itself into a "complete" checklist another checklist then cites, be
mass-N/A'd behind a count, and be recorded as done by a write the database had
refused. Each default above closes one of those doors without weakening the
one invariant that was sound — a human's note keeps every automated pass out.

**Reversal.** Per default, by a facility's stated requirement: a stricter
register (assets), a stricter bar (longer reasons, no accept-without-document),
an NCR module, and — the brief's own default for item 1 — a title match shown
as "suggested" until verified, or "Mark complete" refused while the basis
would be `'auto'`. None of the defaults can be loosened below "a person or an
admitted document", which is the contract itself.

**Risk:** low–medium — the register is narrower than before (existing intake-
title greens retract on the next sweep, visibly, in one audit row per sweep),
and until migration `20261091` is applied, closing / voiding / reopening a punch
item and adding one with a location or details fail with the migration message
(PostgREST's schema-cache shapes included); "Mark complete", checklist void /
reopen and turnover decisions work before it, with no basis recorded and no
history yet — the migration's backfills record both. The same migration ties
every project-scoped quality row's `org_id` to its project's (`QUAL-12`, header
and siblings included), without blocking a document or party delete.

<a id="dec-53"></a>
## DEC-53 · The equipment registry's tiers, and what a site code identifies

**Decision. Five calls about the registry and its codebook. They were made together because each one is where the others would otherwise leak.**

1. **Authority is decided by the role collection.** The registry writer tier creates, edits and archives equipment. That tier is Admin, DocCtrl, Manager and Supervisor: `ADMIN_SURFACES` "assets" `writes`, enforced by `20261045`. The writer tier may also edit the identity columns `unit_code`, `code` and `origin`, which is what the Operating Areas page promises. Only the controller tier (`is_org_controller`) may **delete** assets, asset types or photos, because a deletion cascades into photos, aliases, mentions and document links. Photos follow the asset. `asset_files` is a document link rather than a registry record, so it keeps the writer tier. The database writes an audit row (`ASSET_DELETED`) whenever a person deletes an asset, in the same transaction. The writer tier's way to remove equipment is to archive it, and a writer reverses that in the product: the Operating Areas page lists archived equipment ("Archived (N)") with a Restore action, the asset drawer offers Restore on an archived asset (`restoreAsset`), and a master-list update that names an archived tag restores it. An archived asset keeps its tag and site code, so it is restored rather than re-created.
2. **A site code identifies the equipment TYPE, not the tag prefix.** When one type is registered with several prefixes (Vessels: V, D), those prefixes share its number space by the site's own standard. The app neither writes the prefix into the code nor forbids multi-prefix types, because either would impose a numbering convention on the site (the DEC-35 spirit). Instead, the registry refuses a second asset carrying the same code: a unique index on `(org_id, code)` for non-blank codes, created once no duplicate exists. The index refuses the code, and the writers that derive one keep the asset. A code the SERVICE ROLE inserts (the org restore, the Bridge's discovery insert) yields to the asset already carrying it: the `20261128` trigger `assets_code_one_holder` lands the insert without it. A service-role UPDATE to a taken code is refused (23505, the holder named), so a SQL-editor cleanup done in the wrong order is told instead of silently ignored. The Bridge re-sends its unit backfill without the code, so the filing lands. The trigger sees committed rows only. When two drawings are ingested in parallel and derive one code, the index refuses the second insert, and the Bridge re-sends it once without the code. The Bridge records each tag it leaves without a code (`codesLeftBlank`), and any other service-role writer racing on one code gets the 23505. A person's write reaches the index: the app writes a code the codebook DERIVES as optional (the importer, the bulk filer, the drawer's auto-derived code), so the asset is stored without it, and only a code a person typed is refused, with the code named. The identity review lists every filed asset whose derived code another asset carries, for a person to give it its own code. The inverse (`codeToTag`) reports ambiguity rather than picking a prefix.
3. **Unit and equipment-type codes are digits.** Site codes are built from these digits and read back the same way, so a letter code can be written but never decoded. The rule binds every NEW code a person writes: a trigger in `20261128` checks inserts and code changes. The service role passes it, so an org restore of a backup holding a legacy letter code carries on, and for the same reason there is no CHECK: a CHECK, NOT VALID or validated, also binds the service role, so a backup taken before the org replaced its letter codes could never be restored (and a NOT VALID one binds every meta-only update of a legacy row too). A legacy letter-coded unit or type stays usable for everything except decoding, and is replaced by adding the digit code, refiling its equipment and removing the letter code. Drawing-type codes keep their free shape.
4. **A codebook edit never rewrites stored codes.** Before saving, it warns with the number of existing codes the edit would derive differently. The identity review is the re-decode plan: each asset's change is accepted one at a time, under the user's RLS. A unit or type that assets or process flows still reference cannot be removed or re-coded. The database refuses it for every person (`20261128` `codebook_entries_guard_in_use`), and the refusal shows the counts; the service role's cascades (org purge, restore) pass. This round adds neither a code rename with cascade nor a version stamp (`CB-5` and `CB-6` stay partial).
5. **There is one tag grammar: the registry key.** `tagKey` is the database's `normalize_tag()`, a lowercase key with alphanumerics only. `assets.tag_normalized` and `asset_aliases.alias_normalized` both use it. The codebook's `normalizeTag` is the canonical display spelling that the codec parses. It is not an identity key.

> Made during intelligence Round G (2026-09-30) under the protocol's fail-safe rule. It closes `IRLS-5`, `CB-3` and `CB-10`, and records the partial calls on `AREA-1` (its runtime refusal test), `CB-5`, `CB-6` and `GAP-310`.
>
> **Numbering.** DEC-53 on the integration branch (DEC-44 to DEC-52 were already taken when this package merged).
>
> **Verification fix (2026-09-30, intelligence Round G).** An independent verification found that (2) claimed more than the code did. Service-role writes did not "always land": a parallel insert the trigger cannot see was refused by the index, and the Bridge then lost the asset. A service-role UPDATE to a taken code also kept its old code and still answered UPDATE 1. (2) and the Acceptance now say what `20261128` and `lib/equipmentBridgeServer.ts` do. The UPDATE is refused with 23505 naming the holder, and the Bridge re-sends both of those writes once without the code. (4) and the Acceptance also said "every caller" / "any caller" for the in-use guard, which the service role's cascades pass; they now say "person". The decision itself is unchanged.

**Rationale.** In a PSM registry, a deletion that cascades destroys evidence. Nobody else was stopping it, so the delete sits at the tier that also governs the codebook. Editing does not destroy anything and is audited, so it stays with the tier the page already names. The owner warned against baking in conventions. Forcing one prefix per type, or a prefix inside the code, would do exactly that. Refusing a collision at the registry instead keeps each site's own standard while never letting two assets share an identity. The codebook is the identity authority, and for that reason it must never silently re-file the plant. A person accepts every rewrite.

**Acceptance.** A Manager holding no controller role can archive equipment but gets an explicit refusal when deleting it. An `ASSET_DELETED` row exists for every deletion a person makes. `codeToTag("2010.1")` answers ambiguous for Vessels [V, D]. A second asset on a code already held is refused with the code named when a person typed it. A derived-code writer (the app's importer, bulk filer and drawer, and the Bridge, including a parallel insert) files the asset without the code. A restore lands a row without a code another asset carries, and a service-role UPDATE to a taken code is refused, naming the holder. An org restore of a backup holding a legacy letter-coded unit completes. An archived asset is restored from the Archived list. `tagToCode` returns nothing for a letter unit code. A legacy letter-coded unit can still be relabelled and bound, and a unit still in use cannot be removed by any person. Saving a padding change shows the count before anything is written. An alias taught as "the north furnace" is found by `getAssetByTag`, by search and by ⌘K under any spelling. See `lib/__tests__/intelRoundGRegistry.test.ts`, `lib/__tests__/codebook.test.ts`, `lib/__tests__/assetCategorize.test.ts`, `lib/__tests__/intelRoundGGrammar.test.ts` and `lib/__tests__/globalSearchTags.test.ts`.

**Reversal.** (1) If a facility states that Managers delete equipment, `is_org_controller` in the DELETE overlay becomes `caller_holds_any_role(org_id, writes)`. (2) If a site's standard encodes the prefix, the code format becomes an org setting read by `tagToCode` and `codeToTag`; there is still no default. (4) A server-side re-decode job and a version stamp are additive to the plan and replace nothing.

**Risk:** medium. The only narrowing is DELETE for Manager and Supervisor; everything else is either a warning or a refusal of data that would otherwise be corrupted.

<a id="dec-54"></a>
## DEC-54 · Knowledge ingestion: one writer, one reset, honest pages, a chunker a library chooses

**Decision. Five calls about how a knowledge document becomes an index. They were made together because each one is where the others would otherwise leak.**

1. **One writer per document, per batch.** Every ingest batch and the rev-up refresh claim the document before touching it (`claimIngestLease` in `lib/knowledgeIngest.ts`). The drawing rebuild is to take the claim once I-07 moves `app/api/knowledge/drawing/route.ts` onto `resetKnowledgeIndex`; today it resets without it. The claim is one conditional UPDATE of `knowledge_documents.ingest_claimed_by` / `ingest_claimed_at` and holds for **five minutes**; a claim older than that is free. It lasts one batch, never a document, so the self-imposed invocation deadline still bounds every write. The batch commits with a compare-and-set on the claim, the file and version it read, and the page it started from. **The loser never errors the document.** A driver that finds the claim held gets `busy`, with `retryAfterMs` (at most how long until the claim is free), and the interactive route waits for it. A claim an invocation the platform killed left behind stands for the whole five minutes. The library page's loop (I-02's `ingestLoop` in `lib/knowledge.ts`) is to wait that out and not count a `busy` answer as a stalled round; until it does, it can report a false stall and advise a rebuild. A batch whose row moved under it (re-pointed, deleted, or colliding on a duplicate key) withdraws exactly the rows it wrote and reports `superseded`. The cron drain skips claimed rows. **A rev-up does not wait for a batch writing the old file.** It re-points the row at once, as a compare-and-set of its own, and that batch's commit misses. A superseded revision is never completed to `ready`. **A rev-up resets only the revision it read.** The sync passes the version it read, and the reset compares it on every path. A second sync that read the mirror before the first one re-pointed it leaves the new revision alone. **Whatever records a batch's outcome compares against what the batch read**: the failure write (`markIngestFailed`), the non-PDF refusal and the acceptance of a partial index all check the file, the version and (where it applies) the resume point. None of them can land on a revision a rev-up moved to. A superseded batch's withdrawal of its own rows is checked and tried once more; one that still fails is reported, and on a database without the claim a re-pointed row is re-queued through the reset.
2. **One reset of a document's derived index: `resetKnowledgeIndex`.** It runs under the same claim. It **queues the row first** (`stale`, counters zeroed, re-pointed on a rev-up), so an interrupted reset leaves a queued row and never a `ready` row without its chunks. Then it deletes every chunk (and its embedding), every page entity of every kind, and the machine-derived entity mentions (a person's explicit pin survives). When the file changed, it drops the cached line traces too, before the row moves. The rev-up refresh uses it; the drawing rebuild is to call it (I-07); a library re-index uses it. A batch that starts at page 0 restarts every counter, and under the claim it clears the document's whole derived index before writing, so nothing of the last generation outlives it. The mention pass runs wherever a document reaches `ready`, so a reset's dropped mentions come back on the cron path too. A document's first batch that cannot read its library's chunker choice stops (and is retried) rather than taking chunker 1.
3. **A page AI vision failed to read holds 'ready'.** A provider error on a vision read is recorded on the row (`vision_failed_pages`, with the provider's message) and retried once the main pass is through. The document reaches `ready` only with zero failed pages, or when a controller explicitly accepts the partial index. The acceptance takes the claim, is audited first (an acceptance that cannot be recorded changes nothing), keeps the pages listed, and feeds the equipment Bridge and the mention pass like any document reaching `ready`. **A retry that cannot run or fails again never errors the document.** Status `error` would drop the whole document out of Ask. The document stays `indexing` (retrievable), with the plain reason in `error` and `vision_retry_after` on the row. After the provider refuses a whole retry pass there is a 30-minute back-off that every driver honours. Without a key it is stamped at the current time, which files the document behind fresh work in the cron's queue. **No failed page is starved.** `vision_failed_pages` is a queue, least recently tried first. A page whose retry fails again goes to the back, and `vision_retry_tried` holds the current round. The back-off starts only once every waiting page has had its try this round. A retry batch re-reads pages without moving the resume point (`pagesIndexed`), so the pages it clears, and the tries it spends (`visionRetryAttempts`), are its progress. The cron drain counts them. The library page's loop (I-02's `lib/knowledge.ts`) is to count them the same way; until it does, it can report a false stall while retries succeed. A transcript too short to use is a READ page that is empty (`empty_pages`), not a failure. **A batch that fails for real** (not contention, not a vision retry) **is retried automatically, a bounded number of times.** `markIngestFailed` keeps the document's status, so an `indexing` document stays in Ask. It records the failure, the count (`ingest_failures`) and a back-off (`vision_retry_after`: 10, then 30 minutes) that every driver honours. The third failure in a row makes the document `error`, for a person. The bound is on re-billing: each retry reads the batch's vision pages again. A damaged PDF is `error` at once, since no retry can mend it.
4. **The table-aware, page-bridging chunker (chunker 2) is chosen per library, never automatically.** It keeps line structure so tables stay whole, measures text-layer column gaps, and carries a page's unfinished sentence into the next page's first chunk, marked with its page. Chunker 1 stays byte-for-byte the default. A library moves only by an explicit, controller-only, audited re-index (`POST /api/knowledge/ingest { action: "reindex", libraryId, chunker }`). A dry run (`dryRun: true`) changes nothing and says, before anything is deleted, how many documents would reset and how many AI-vision pages would be read, and billed, again. A real run audits its intent before any reset. It is bounded by the invocation's deadline and answers `remaining`. It skips documents already on the chosen chunker, so a re-run resumes without resetting or re-billing any document twice. The carry is for prose only: a drawing sheet neither gives nor takes one. `knowledge_libraries.chunk_version` records the choice. `knowledge_documents.chunk_version` records which chunker wrote a document, which keeps it from mixing the two.
5. **A controlled document's AI mirror dies with it.** `knowledge_documents.source_document_id REFERENCES documents(id) ON DELETE CASCADE`, so the mirror row, its chunks, embeddings, page entities, mentions and traces all go in the delete's own statement. Mirrors that already name no document are deleted in the same paste that adds the key, and are counted first (DEC-30).

> Made during intelligence Round G (2026-09-30) under the protocol's fail-safe rule, taking the four defaults the fleet plan (`audit-reports/fleet-plans/intelligence.json`, package I-06) named. It closes `ING-1`, `ING-2` and `ING-3`. It records partial calls on:
> - `ING-4` and `ING-7`: code complete, pending activation (the `20261122` paste plus I-02's button);
> - `ING-12`: pending I-07's rebuild calling the reset;
> - `ING-6`, `DWG-1`, `ILIFE-5` and `IRLS-7`.
>
> Migration: `20261122_intel_roundG_ingest_integrity.sql`.
>
> **Numbering.** DEC-54 on this branch: DEC-44 to DEC-53 already exist at its base (fdb51b1). The integrator renumbers on merge if another package takes 54.

**Rationale.** The three drivers already existed and could not see each other, and the rev-up re-points the row underneath all of them. So the only coordination that can hold lives on the row itself, taken in one statement. A lease that outlived an invocation would reintroduce the stalls the per-batch commit was built to prevent, which is why it is per batch, with a TTL. The reset had been written twice, and each copy forgot a table: the sync forgot the entities, the rebuild forgot the counters. One function that both call is the fix that stays fixed. In a PSM library, a sheet the model could not read and a sheet with nothing on it must never look alike, and `ready` is the word the census and the audit trust. Changing the chunker moves every chunk boundary in a library and re-bills its vision pages, so the library's owner decides when. A mirror is an AI shadow of a controlled record, so it has no standing once the record is gone.

**Acceptance.**
- Two drivers racing one document produce one set of chunks, and neither errors.
- A rev-up that lands while a batch writes the old file re-points the row at once. The batch withdraws, and the old revision never reaches `ready`. A row re-pointed by any other writer keeps saying `stale`, with none of the old batch's rows under it.
- A second sync that read the old revision leaves the new one alone, both under the new revision's first batch and between its batches. A superseded batch that then fails does not mark the new revision `error`, and an acceptance that a rev-up overtakes answers 409 rather than stamping the new revision `ready`.
- A reset that fails part-way leaves a queued row, never a `ready` one without chunks.
- After a rev-up to a revision with fewer sheets, no page entity survives past the new page count. A person's pinned mention survives, and the machine mentions come back when the cron re-indexes it.
- A vision provider error leaves the document `indexing` with the page listed. The next pass retries it and completes. Or, with no key or a provider that refuses again, the document stays `indexing` and retrievable, with the reason on the row and a back-off. The cron drain reads twenty failed pages back in one run. When four failed pages fail every time, the four behind them are still read, and only the four that fail stay listed.
- A transient failure mid-document leaves it `indexing` and retrievable, with a back-off. A later drain run completes it. A failure that persists fails three times in a row (the first try and two automatic retries), then the document is `error`.
- A keyless rebuild ends at `vision_pages: 0`.
- A library on chunker 2 stores a vision-read table as one chunk with its rows on separate lines. A sentence straddling a page break appears whole in one chunk, and a drawing set carries nothing from sheet to sheet. A library on chunker 1 chunks exactly as before. Deleting a controlled document removes its mirror and everything derived from it. See `lib/__tests__/ingestLock.test.ts`, `lib/__tests__/sourceSync.test.ts`, `lib/__tests__/ingestRoute.test.ts`, `lib/__tests__/intelRoundGIngestMigration.test.ts` and `lib/__tests__/knowledgeText.test.ts`.

**Reversal.** (1) The TTL is `INGEST_LEASE_TTL_MS`, one constant. (3) If a facility prefers "ready, with the unread pages listed" to "held until accepted", the `done` condition in `ingestKnowledgeDocBatch` drops its failed-pages term; the pages stay recorded either way. The failed-batch bound and back-off are `INGEST_FAILURE_MAX_ATTEMPTS` and `ingestFailureBackoffMs`. (4) Making chunker 2 the default for NEW libraries is a column default change (`knowledge_libraries.chunk_version DEFAULT 2`); existing libraries still move only by the action. (5) `ON DELETE SET NULL` in place of CASCADE, with the sync's REMOVE pass sweeping unsourced mirrors, is the alternative the finding offered.

**Risk:** medium. The migration deletes derived rows only: mirrors naming no document, and entities and chunks past a document's last page. It never touches a controlled document. Until it is applied, the engine runs its legacy, unclaimed path, which still never errors on contention. **Restore.** A backup taken before the paste, or between a controlled document's delete and the next sync, can hold a mirror naming no document. Once the key exists, restoring that backup fails on it (23503). The single-shot restore (`app/api/admin/restore/apply/route.ts`) stops at `knowledge_documents` and skips every table after it: `knowledge_chunks`, `knowledge_page_entities`, `knowledge_questions`, `output_templates` and `output_generations`. The chunked restore (`app/api/admin/restore/apply-table/route.ts`) answers 500 for the whole slice, because it allows a per-row refusal only for `document_holds`. The fix is handed to I-01, which owns restore. The restore should drop mirrors whose `source_document_id` is absent from the restored documents, or put `knowledge_documents` in the per-row refusal set and teach the single-shot path the same refusal.
