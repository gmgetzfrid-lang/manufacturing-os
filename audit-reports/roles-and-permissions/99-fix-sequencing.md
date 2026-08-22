# 99 · Execution order

**This file is binding, not advisory.** In this area, fix *order* matters more
than the fixes. Three one-line changes switch on guards that have never
executed. One RLS fix converts a security hole into silent data loss if it ships
alone. One dead code path silently disables the document review gate the moment
someone wires a feature to it.

Read this before starting any finding or gap in this area. It contains no
findings of its own — it is the plan the 124 findings and 15 gap specs are worked
against.

Judgment calls referenced here are settled in
[`../DECISIONS.md`](../DECISIONS.md).

---

## The three traps

### Trap 1 — Fixing a broken guard turns it on for the first time

`DB-2` is a one-word fix: `tm.user_id` → `tm.uid`. It also switches on
`documents_deny_write_guard`, a `RESTRICTIVE` policy that has **never once
executed successfully**. Every explicit `write` / `editMetadata` deny written
since the guard shipped has been silently ignored. Turning it on enforces all of
them at once — against indexes that `DB-4` says may be stale.

**Same shape:** `DB-1`/`WF-1` (the phantom `org_configurations.value` column)
activates `WF-10`, `WF-11` and `WF-23`. `OWN-6` (threading `teamIds`) activates
team publish grants that have been inert and may be stale.

**The rule:** before enabling any dormant guard, run the inventory query for what
it will start enforcing and record the result in your `Resolution` block. Each
finding below names its query.

### Trap 2 — Tightening RLS on top of a silent-write call site converts a security bug into data loss

`OWN-1` adds RESTRICTIVE policies to `libraries`. Six application call sites write
to that table with `.update()` and no `.select()`, so a refused write returns
**200 with zero rows** — no error. Shipping `OWN-1` alone means ownership
assignments, review-policy changes and permission-drawer saves start failing
**silently**, while still writing "success" audit rows and notifying the new
owner.

**The rule:** `OWN-14` is a **prerequisite**, not a follow-up.

### Trap 3 — "Make it additive" currently means "deny everyone"

`COALESCE(roles, ARRAY[role])` is a no-op because `roles` is
`NOT NULL DEFAULT '{}'` — never `NULL`, just empty (`DB-3`). Signup and both
restore paths seed it empty. Converting a check from singular `role` to the
`roles` array today evaluates against `{}` and **denies everyone including the
org's founding Admin.**

**The rule:** `DB-3` (backfill `roles` from `role`) comes before *any* additive
conversion. That includes `DEC-1` and `DEC-2`.

---

## Phase 0 — Free and independent

No dependencies, no behaviour change beyond the fix itself. Good first work, and
a good way to confirm the ship loop is green before touching anything coupled.

| Item | Why it is free |
|---|---|
| `DB-6` | Pin `search_path` on 13 `SECURITY DEFINER` functions. No behaviour change. Identify which of the four `enforce_document_publish_guard` definitions is live first. |
| `OWN-9` | Add `DraftingSupervisor` to the two role pickers. Purely additive. |
| **`LIFE-2` / `DEC-23`** | **Delete the `related_ticket_id` review waiver. Do this early — it is the trap `GAP-6` springs.** |
| `LIFE-5` (partial) | Relabel the RevUpModal MOC input, which says "optional" for a field the gate makes mandatory. One line. |
| `LIFE-13` | Render the source-document backlink on the ticket page. Reads data that already exists; no schema change. |
| `CHAIN-4` | Correct the stale claims in `RoleModelTree` / `PermissionsExplorer`. Documentation-only. |
| `OWN-17` (partial) | Add an authority check to `backfillVersion`, which today has none at all. Independent of the rest of `OWN-17`. |
| `DEC-11` removals | `p_actor_role`, `canBlindDrillAccess`, `filterDiscoverable`. Pure deletions, recoverable from git. |
| `GAP-12` | Library ownership on the permissions console. Read-only extension of an existing query. |

---

## Phase 1 — Close the unauthenticated and cross-tenant doors

Independent of the role model entirely, and the highest severity in the audit.

1. `EGRESS-2` — `/d/[number]` unauthenticated cross-tenant enumeration.
2. `SURF-2` — `/api/storage/delete` byte destruction.
3. `EGRESS-1` — `document_shares` unconstrained `document_id`. **Trace the
   cross-org case to a conclusion** rather than assuming it is contained; the
   `WITH CHECK` never joins `document_id` to `org_id`.
4. `SURF-5` — the mail-queue drain. **Coordinate with `WF-19`**, which needs the
   endpoint to work for a legitimate session caller.
5. `EGRESS-5` + `DEC-19` — `access_requests` cross-tenant SELECT, rate limit, and
   the pending-requests view.

---

## Phase 2 — Make the database layer honest

Nothing downstream can be reasoned about until these land.

1. **`DB-3` + `DEC-1` step 1** — backfill `roles` from `role`; fix signup and both
   restore paths. **Everything additive depends on this.**
2. **`DB-1` + `WF-1`** — the phantom `org_configurations.value` column, both halves
   in one change. **Read `WF-23` first** — the SQL capability defaults deny every
   `ticket.*` capability, so this must not be followed immediately by a `tickets`
   policy that calls `org_capability_allows`.
   ⚠ Per `DEC-30`: this finding has two possible worlds (migration applied → holds
   broken in production; not applied → two security rails silently absent) and you
   cannot tell which from here. Determine it before proceeding, or mark `BLOCKED`
   with the query that would settle it.
3. **`DB-4` / `DEC-10`** — nightly `acl_index` rebuild in the maintenance cron.
   Also contains `OWN-7`'s exposure window. Say plainly in your `Resolution` that
   this narrows the stale-grant window to one day rather than closing it.
4. **`DB-2`** — `tm.user_id` → `tm.uid`. **Only after 3**, and only after running
   `SELECT count(*) FROM documents WHERE acl_index->'deny' IS NOT NULL` and
   recording the result.
5. `DB-5` — the library wizard writing `acl` without `acl_index`.
6. `DEC-1` steps 2–3 — the SQL rank function and the `org_members` trigger.

---

## Phase 3 — Close the publish path

The ownership axis, in dependency order.

1. **`OWN-14`** — silent-write-failure at the six named call sites.
   **Prerequisite for step 3.**
2. `OWN-2` + `DEC-6` — add `owner_user_id` / `owner_name` to the access-change
   guard, permitting controller **or** current effective owner.
3. **`OWN-1`** — RESTRICTIVE policies on `libraries`. Only after step 1.
4. `OWN-5` — `publish_revision`: derive the actor from `auth.uid()`, gate the
   branch path, retire the v1 fallback, drop `p_actor_role` (`DEC-11`).
5. `OWN-4` — intake auto-supersede.
6. `GAP-15` / `DEC-7` — the ownership branch in `node_visible`.
7. `EGRESS-6` — the `document_versions` UPDATE/INSERT overlay. **Last in this
   phase**, so it lands on top of paths that already carry real authority checks.

---

## Phase 4 — The workflow

1. **`WF-8`** — scope `ticket.requester_review` and `ticket.draft_work`.
   **Prerequisite for `WF-7`**: doing `WF-7` first is a privilege expansion.
2. `WF-7` — thread the role collection through the workflow engine and route.
3. **`WF-3` + `WF-14` together** — the minor-correction bypass and the self-picked
   engineer. Fixing either alone is a no-op; `WF-14` is the hole `WF-3` opens.
4. `WF-5` — server-derive `requester_role` at insert.
5. `GAP-2` / `DEC-12` — separation of duties, derived from active member count.
6. `WF-2` — narrow `tickets` RLS. **Only after `WF-23`** is resolved, or every org
   that has never opened the permissions editor locks itself out.
7. `WF-6`, `WF-22` — the missing input preconditions.
8. `WF-15` — validate `request_type`. **Prerequisite for `GAP-1`.**

---

## Phase 5 — Role resolution

Only after Phase 2. Each of these **widens** authority, so each needs its
inventory run and recorded before shipping.

1. **`OWN-3` / `DEC-2`** — the five publish-path checks routed through
   `is_org_controller`. Inventory:
   `SELECT uid, role, roles FROM org_members WHERE roles && ARRAY['Admin','DocCtrl'] AND role NOT IN ('Admin','DocCtrl')`.
   Land `node_visible` **last and separately** — it gates all document read
   visibility.
2. `CHAIN-1` — restriction-style checks against the full collection. This one
   *narrows*, and closes a genuine escalation.
3. `SURF-10` — `authorizeOrgRole` reads the union.
4. `OWN-6` + `OWN-10` — teams in the publish principal and the simulator,
   **together**. Inventory existing `allow.teams.publish` grants first; they have
   been inert and may be stale.
5. `DEC-3`, `DEC-4` — mark the five department roles and the Engineer tiers
   dormant in the picker.

---

## Phase 6 — Membership, delegation, and the remaining surfaces

1. **`SURF-1` / `DEC-20` + `GAP-5` together** — revocation and owner succession.
   Working revocation with no succession orphans every owned node; today the
   problem is latent only because removal is a no-op.
2. `DEL-1` + `GAP-3` — the permission drawer's authority input, then per-file
   delegation.
3. `SURF-3` — legal hold at the database.
4. `SURF-4` — the force-release second write.
5. `DEC-17` — the two real admin-gate defects (`audit_logs`, asset tables) and the
   `/admin/settings` mismatch.
6. `DEL-3` / `DEC-9` — the four team-ownership gaps.
7. `DEC-21` — reviewer independence per library.
8. Remaining `LIFE-*`, `DEL-*`, `DOCACL-*`, `ADD-*`, `SURF-*` in severity order.

---

## Phase 7 — The builds

Gap specs, once their dependencies are met. Each is `L` or `M` effort and should
be its own session.

| Order | Gap | Blocked until |
|---|---|---|
| 1 | `GAP-7` — markup persistence | — (independent; unblocks `LIFE-8`) |
| 2 | `GAP-8` — multi-sheet sources | `LIFE-4` (Phase 6) |
| 3 | `GAP-9` — verification currency | `LIFE-10` (Phase 6) |
| 4 | **`GAP-6` — the ticket → document hand-back** | **`DEC-23` (Phase 0) — non-negotiable**, plus Phase 3 |
| 5 | `GAP-13` — triage rejection taxonomy | `WF-19` (Phase 4) |
| 6 | `GAP-4` — owner as required approver | `OWN-11`, `DEC-21` (Phase 6) |
| 7 | `GAP-1` — approval authority per request type | `WF-15` (Phase 4), `DEC-13` |

`GAP-10`, `GAP-11` and `GAP-14` are `DECLINE` / `FOLD_INTO_FINDING` — do not
build them. Their specs name the findings that cover the requirement instead.

---

## Pairs that must ship together

| These two | Because |
|---|---|
| `WF-3` + `WF-14` | `WF-14` is the fallback hole `WF-3` opens. Either alone is a no-op. |
| `OWN-6` + `OWN-10` | Otherwise the permissions simulator reports a team grant the app still refuses. |
| `OWN-14` → `OWN-1` | Otherwise a security hole becomes silent data loss. |
| `DB-3` → any additive conversion | Otherwise "additive" means "denied". |
| `SURF-1` + `GAP-5` | Working revocation with no owner succession orphans every owned node. |
| `DB-1` + `WF-1` | Two halves of one column name. Fixing one leaves the layers disagreeing. |
| `DEC-23` → `GAP-6` | Otherwise the hand-back silently disables document review. |

## Do not do these

Each looked like a shortcut during the audit and is wrong. Where a decision
settles it, the decision is cited.

| Tempting | Why not |
|---|---|
| Reorder `ROLE_RANK` to lift `DocCtrl` above `Manager` | Silently removes Manager-tier ticket authority from the same people. `DEC-2` — do the additive fix instead, and **not both**. |
| Delete a "dead" role | No stored permission blob is versioned; customer JSON names roles by string in seven places, and removal orphans live grants **silently**. `DEC-3`, `DEC-5`. `Contractor` is load-bearing as a restriction (`CHAIN-1`). |
| Auto-publish a document when its ticket closes | Bypasses the publish guard and the MOC gate in one move. `DEC-22`. |
| Set `related_ticket_id` for provenance before `DEC-23` lands | It silently waives the document review gate. `LIFE-2`. |
| Convert all ~237 singular role reads | Not authorized by any finding. `CHAIN-2` explains why the singular projection is dominant; `DEC-1` is the database invariant that makes it moot. `DEC-31` bounds the scope. |
| Auto-release a hold when its ticket closes | Releasing a safety hold must stay a deliberate act. `DEC-25`. |
| Consolidate all 20 admin surfaces onto one hook | Twenty surfaces changing behaviour at once with no reviewer. `DEC-17` — fix the two real exposures, defer the rest. |
| Build a `handoffs` table | `GAP-10` is `DECLINE`; every concrete symptom has its own cheaper finding. |
| Build a `profiles` table | `GAP-14` is `FOLD_INTO_FINDING`; the mechanism exists and is inert for other reasons. |

---

## Verification you cannot skip

**No live database was available for this audit.** Every SQL finding is an
unambiguous read of a policy or function body, and the phantom-column findings
are read against the schema of record — but **migrations here are applied by
hand**, so deployed state may carry drift the repository does not show.

Per `DEC-30`:

- **Before Phase 2, establish which migrations are actually applied.** `DB-1` has
  two possible worlds and which one you are in changes what you do next.
- A migration fix is `RESOLVED` for its code half only, with an explicit
  `Pending migration:` line. Paste the SQL in your response.
- Where a fix depends on production data you cannot observe, write the inventory
  query into the `Resolution` block and mark the finding `BLOCKED` with that
  query as the unblocking step. Do not proceed on an assumption about production
  data.
