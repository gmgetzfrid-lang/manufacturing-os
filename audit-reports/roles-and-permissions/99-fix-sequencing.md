# 99 · Fix sequencing

**This file contains no findings.** It exists because in this audit, more than in
most, **the order of fixes matters more than the fixes.** Several one-line
changes are safe alone and dangerous together, and at least three of them
*activate* problems that are currently dormant.

Read this before starting any finding that touches roles, ACL indexes, or the
capability policy.

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

**The rule:** before enabling any dormant guard, **inventory what it will start
enforcing.**

### Trap 2 — Tightening RLS on top of a silent-write call site converts a security bug into data loss

`OWN-1` adds RESTRICTIVE policies to `libraries`. Six application call sites write
to that table with `.update()` and no `.select()`, so a refused write returns
**200 with zero rows** — no error. Shipping `OWN-1` alone means ownership
assignments, review-policy changes and permission-drawer saves start failing
**silently**, while still writing "success" audit rows and notifying the new
owner.

**The rule:** `OWN-14` (silent-write-failure at the named call sites) is a
**prerequisite**, not a follow-up.

### Trap 3 — "Make it additive" currently means "deny everyone"

`COALESCE(roles, ARRAY[role])` is a no-op because `roles` is
`NOT NULL DEFAULT '{}'` — never `NULL`, just empty (`DB-3`). Signup and both
restore paths seed it empty. So converting a check from the singular `role` to
the `roles` array, today, evaluates against `{}` and **denies everyone including
the org's founding Admin.**

**The rule:** `DB-3` (backfill `roles` from `role`) comes before *any* additive
conversion.

---

## Suggested order

Each phase is **separate work.** Do not collapse them. Stop between phases and
confirm the previous one held.

### Phase 0 — Free and independent

No dependencies, no behaviour change, safe in any order. Good first work.

| Finding | Why it is free |
|---|---|
| `DB-6` | Pin `search_path` on 13 `SECURITY DEFINER` functions. No behaviour change. Identify which `enforce_document_publish_guard` definition is live first. |
| `OWN-9` | Add `DraftingSupervisor` to the two role pickers. Purely additive. |
| `LIFE-2` | Delete or narrow the dead `related_ticket_id` review waiver. **Do this early — it is the trap `GAP-6` springs.** |
| `LIFE-5` (partial) | Relabel the RevUpModal MOC input, which currently says "optional" for a field the gate makes mandatory. One line. |
| `LIFE-13` | Render the source-document backlink on the ticket page. Reads data that already exists; no schema change. |
| `CHAIN-4` | Correct the stale claims in `RoleModelTree` / `PermissionsExplorer`. Documentation-only. |
| `OWN-17` (partial) | Add an authority check to `backfillVersion`, which today has none at all. Independent of the rest of `OWN-17`. |

### Phase 1 — Close the unauthenticated and cross-tenant doors

These are independent of the role model entirely, and they are the highest
severity in the audit.

1. `EGRESS-2` — `/d/[number]` unauthenticated cross-tenant enumeration.
2. `SURF-2` — `/api/storage/delete` byte destruction.
3. `EGRESS-1` — `document_shares` unconstrained `document_id`.
4. `SURF-5` — the mail-queue drain. **Coordinate with `WF-19`**, which needs the
   endpoint to work for a legitimate session caller.
5. `EGRESS-5` — `access_requests` cross-tenant SELECT.

### Phase 2 — Make the database layer honest

Nothing downstream can be reasoned about until these are resolved.

1. **`DB-3`** — backfill `roles` from `role`; fix signup and both restore paths.
   **Everything additive depends on this.**
2. **`DB-1` + `WF-1`** — the phantom `org_configurations.value` column, both
   halves in one change. **Read `WF-23` first** — the SQL capability defaults deny
   every `ticket.*` capability, so this must not be followed immediately by a
   `tickets` policy that calls `org_capability_allows`.
3. **`DB-4`** — give `acl_index` a rebuild path (the nightly cron is the cheap
   containment; a derived column is the durable fix). Also contains `OWN-7`'s
   exposure window.
4. **`DB-2`** — `tm.user_id` → `tm.uid`. **Only after 3**, and only after
   inventorying `documents.acl_index -> 'deny'`.
5. `DB-5` — the library wizard writing `acl` without `acl_index`.

### Phase 3 — Close the publish path

The ownership axis, in dependency order.

1. **`OWN-14`** — silent-write-failure at the six named call sites.
   **Prerequisite for step 3.**
2. `OWN-2` — add `owner_user_id` / `owner_name` to the access-change guard. Decide
   first whether an owner may hand ownership on.
3. **`OWN-1`** — RESTRICTIVE policies on `libraries`. Only after step 1.
4. `OWN-5` — `publish_revision`: derive the actor from `auth.uid()`, gate the
   branch path, and retire the v1 fallback.
5. `OWN-4` — intake auto-supersede.
6. `EGRESS-6` — the `document_versions` UPDATE/INSERT overlay. **Last in this
   phase**, so it lands on top of paths that already carry real authority checks.

### Phase 4 — The workflow

1. **`WF-8`** — scope `ticket.requester_review` and `ticket.draft_work`.
   **Prerequisite for `WF-7`**: doing `WF-7` first is a privilege expansion.
2. `WF-7` — thread the role collection through the workflow engine and route.
3. **`WF-3` + `WF-14` together** — the minor-correction bypass and the
   self-picked engineer. Fixing either alone is a no-op; `WF-14` is the hole
   `WF-3` opens.
4. `WF-5` — server-derive `requester_role` at insert.
5. `WF-2` — narrow `tickets` RLS. **Only after `WF-23`** is resolved, or every
   org that has never opened the permissions editor locks itself out.
6. `WF-6`, `WF-22` — the missing input preconditions.

### Phase 5 — Role resolution

Only after `DB-3`. Each of these **widens** authority, so each needs an
inventory of who it affects before shipping.

1. `OWN-3` — make the three publish-path SQL functions additive. Inventory
   `roles && ARRAY['Admin','DocCtrl'] AND role NOT IN ('Admin','DocCtrl')` first.
   **Do not also reorder `ROLE_RANK`** — see `CHAIN-2`.
2. `CHAIN-1` — restriction-style checks against the full collection. This one
   *narrows*, and closes a genuine escalation.
3. `SURF-10` — `authorizeOrgRole` reads the union.
4. `OWN-6`, `OWN-10` — teams in the publish principal and the simulator,
   **together**, or the simulator becomes honest about a capability that still
   does not work.

### Phase 6 — Everything else

`SURF-1` (membership revocation — makes `OWN-12` bite, so pair it),
`SURF-3` (legal hold), `SURF-4` (force-release), the remaining `LIFE-*`,
`DEL-*`, `DOCACL-*` and `ADD-*` findings, in severity order.

---

## Pairs that must ship together

| These two | Because |
|---|---|
| `WF-3` + `WF-14` | `WF-14` is the fallback hole `WF-3` opens. Either alone is a no-op. |
| `OWN-6` + `OWN-10` | Otherwise the permissions simulator reports a team grant the app still refuses. |
| `OWN-14` → `OWN-1` | Otherwise a security hole becomes silent data loss. |
| `DB-3` → any additive conversion | Otherwise "additive" means "denied". |
| `SURF-1` + `OWN-12` | Working revocation with no owner succession orphans every owned node. |
| `DB-1` + `WF-1` | Two halves of one column name. Fixing one leaves the layers disagreeing. |

## Changes to resist

| Tempting | Why not |
|---|---|
| Reorder `ROLE_RANK` to lift `DocCtrl` above `Manager` | Silently removes Manager-tier ticket authority from the same people. `CHAIN-2`. |
| Delete a "dead" role | No stored permission blob is versioned; customer JSON names roles by string in seven places. `CHAIN-5`. And `Contractor` is load-bearing as a restriction — `CHAIN-1`. |
| Auto-publish a document when its ticket closes | Bypasses the publish guard and the MOC gate in one move. `LIFE-1`. |
| Set `related_ticket_id` for provenance | It silently waives the document review gate. `LIFE-2`. |
| Convert all 200+ singular role reads | Not authorized by any finding. `CHAIN-2` explains why the singular projection is dominant; the fix is a database invariant, which is a human's decision. |
| Auto-release a hold when its ticket closes | Releasing a safety hold must stay a deliberate act. `LIFE-6`. |

---

## A note on verification

**No live database was available for this audit.** Every SQL finding is an
unambiguous read of a policy or function body, and the phantom-column findings
are read against the schema of record — but migrations here are applied by hand,
so the deployed state may carry drift the repository does not show.

**Before Phase 2, confirm which migrations are actually applied.** `DB-1` in
particular has two possible worlds — migration applied (holds are broken in
production) or not applied (two security rails silently do not exist) — and which
one you are in changes what you do next.
