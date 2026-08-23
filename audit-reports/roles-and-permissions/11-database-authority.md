# 11 · Database authority functions

The SQL layer is where authority is actually enforced. This report covers the
helper functions and policies themselves: what they read, where they contradict
the application, and where they are broken outright.

**7 findings** — 2 CRITICAL, 3 HIGH, 2 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**
>
> **No live database was available.** These are unambiguous reads of policy and
> function bodies, and the two phantom-column findings are read from the schema
> of record. A staging reproduction should confirm them before any of it is
> treated as certain — migrations here are applied by hand, so the deployed state
> may carry drift the repository does not show.

---

## DB-1 · `org_configurations.value` does not exist — the capability layer is inert and the holds policies raise

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (in code) / SUSPECTED (deployed state may differ)
- **Blast radius:** availability / access-control
- **Locations:**
  - `supabase/schema.sql:52-59` — `org_configurations` has `data JSONB NOT NULL DEFAULT '{}'`. **There is no `value` column, and no migration adds one.**
  - `supabase/migrations/20260901_db_hard_enforcement.sql:44` — `SELECT value INTO v_val FROM org_configurations`
  - `lib/capabilityPolicy.ts:174`, `:231` — the application reads and writes the same phantom column
  - `supabase/migrations/20260701_perf_indexes.sql:21` — documents the real shape as `select('data')`
- **Related:** `WF-1`, `WF-23`, `SURF-3`, `SURF-4`
- **Re-verified:** hardening pass — **SURVIVES**. `org_configurations` is `(id, org_id, key, data JSONB, updated_at)` — `schema.sql:52-59`. There is no `value` column and no migration adds one; `20260901_db_hard_enforcement.sql:44` reads `value` too, so the DB-side holds policy is inert for the same reason.

**Mechanism.** plpgsql bodies are not column-validated at `CREATE FUNCTION`, so
the migration applies cleanly and fails at **first execution**.
`org_capability_allows()` raises `42703 undefined_column`. That function is:

- the `WITH CHECK` of `document_holds_insert` and `document_holds_update`
  (`20260901:93-102`)
- the body of `enforce_checkout_release_guard` (`20260901:109-121`)

So **no hold can be opened or released**, and the force-release override path
errors. On the application side, `loadCapabilityPolicy` swallows the read error
and returns `{}` (`lib/capabilityPolicy.ts:193-195`), and `assertHoldCapability`
catches with the comment `/* policy lookup hiccup: fail open */`
(`lib/holds.ts:105-107`).

**Failure scenario.** There are exactly two possibilities and both are bad:

- **The migration was applied** — in which case holds are broken in production
  and every "enforced at the database" claim in `lib/capabilityPolicy.ts:19-22`
  is unbacked.
- **The migration was not applied** — in which case the ACL-deny database rail
  and the policy-aware force-release guard silently do not exist, and the
  codebase believes they do.

Nothing in the repository defines `org_configurations.value`, so a fresh
`supabase db reset` produces the first case.

**Chain reaction.** ⚠ Fixing the column name **activates** `WF-10` (the
uninvalidated server cache), `WF-11` (client-only guardrails) and `WF-23` (the
SQL defaults table that denies every `ticket.*` capability). Read all three
before shipping. The application-side twin is `WF-1`; **fix both halves in one
change or the two layers will disagree about which column is real.**

**Done when.**
1. `org_capability_allows()` executes without raising against the real schema.
2. Opening and releasing a hold works.
3. The application and the SQL function read the same column.
4. A smoke test executes each `SECURITY DEFINER` helper once, so this class of
   drift fails loudly at migration time rather than at first use.

---

## DB-2 · `acl_index_denies` queries `team_members.user_id`; the column is `uid`

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (defect) / SUSPECTED (runtime blast radius)
- **Blast radius:** availability / access-control
- **Locations:**
  - `supabase/migrations/20260901_db_hard_enforcement.sql:141-145` — `SELECT 1 FROM team_members tm WHERE tm.user_id = p_uid::text`
  - `supabase/migrations/20260707_teams.sql:19-26` — the columns are `team_id, uid, org_id, added_at, added_by`. **There is no `user_id`,** and no later `ALTER TABLE team_members` exists.
  - every other reader uses `uid`: `20260812:62`, `20260708:76`, `20260816:62`, `lib/teams.ts:116,122`, `lib/knowledgeAccess.ts:35`, `app/api/storage/download-url/route.ts:74,100`
  - the same typo in the client: `components/permissions/ViewAsSimulator.tsx:59` (`OWN-10`)
- **Related:** `DB-1`, `OWN-10`, `DB-4`
- **Re-verified:** hardening pass — **SURVIVES**. `team_members` is keyed `(team_id, uid)` — `20260707_teams.sql:19-26`. The function queries `tm.user_id`, which does not exist, so `acl_index_denies` raises rather than denying.

**Mechanism.** `acl_index_denies` returns early when `p_idx IS NULL`, and returns
early on a uid- or role-level deny. **Otherwise it reaches the `team_members`
subquery and raises `42703` at first execution** — which surfaces as a hard
statement failure, not a policy denial.

It is called from `documents_deny_write_guard` (`20260901:152-162`), a
`RESTRICTIVE` policy on `documents UPDATE`. The `USING` clause is
`auth.uid() IS NULL OR is_org_controller(org_id) OR NOT (…)`, and **PostgreSQL
does not guarantee OR short-circuiting** — it may reorder by estimated cost — so
controllers are not reliably shielded either.

**Failure scenario.** The first org that actually sets a folder- or
document-level ACL discovers that non-controllers can no longer update documents
in it at all, with an opaque `column tm.user_id does not exist` error. Because
controllers are (usually) exempt, it is invisible to exactly the person who would
investigate.

**Chain reaction.** ⚠ **The one-word fix turns `documents_deny_write_guard` on
for the first time.** Every explicit `write` / `editMetadata` deny that has been
quietly ignored will start blocking. **Inventory `documents.acl_index -> 'deny'`
before applying**, and see `DB-4` — `acl_index` is not propagated to descendants,
so the denies that activate may be stale ones. Sequencing matters here more than
almost anywhere else in this audit; see
[`99-fix-sequencing.md`](./99-fix-sequencing.md).

**Done when.**
1. A non-controller updates a document carrying an `acl_index` and the update
   succeeds.
2. A document whose `acl_index` denies `write` to one of the user's teams rejects
   the update **with a policy denial, not a SQL error**.
3. A controller is unaffected in both cases.
4. The inventory of newly-activated denies was run **before** the fix shipped and
   its result is recorded in the `Resolution` block:
   `SELECT count(*) FROM documents WHERE acl_index->'deny' IS NOT NULL`. Per
   `DEC-30`, if you cannot run it, this finding is `BLOCKED` with that query as
   the unblocking step — do not enable a dormant guard against unknown data.

---

## DB-3 · `COALESCE(roles, ARRAY[role])` is a no-op — a new org's sole Admin fails every additive check

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / access-control
- **Locations:**
  - `supabase/schema.sql:41` — `roles TEXT[] NOT NULL DEFAULT '{}'`
  - `supabase/migrations/20260722_member_roles_collection.sql:13` — the same, on the `ALTER TABLE` path
  - the idiom, three times: `supabase/migrations/20260901_db_hard_enforcement.sql:38`, `:135`, and `supabase/migrations/20260907_milestone_batch_move.sql:33`
  - `app/api/auth/signup/route.ts` — **does not set `roles`** (a search for `roles` in the file returns nothing)
- **Related:** `DB-1`, `DB-2`, `ADD-1`, `OWN-3`

**Mechanism.** `COALESCE(x, fallback)` returns the fallback only when `x` is
`NULL`. The column is `NOT NULL DEFAULT '{}'`, so **`roles` is never `NULL` — it
is an empty array.** The fallback never fires, and `v_roles` is `{}`.

**Failure scenario.** Signup creates the founding Admin with `role = 'Admin'` and
`roles = '{}'`. Every function using this idiom — `org_capability_allows`,
`acl_index_denies`, and the milestone batch move — evaluates the additive check
against an empty array. **The org's only Admin fails it.** Both restore paths
seed `roles` the same way.

**Chain reaction.** This is masked today by `DB-1` (the function raises before
reaching the check) and by the fact that the surrounding code usually also tests
the singular `role`. It becomes load-bearing the moment `DB-1` is fixed. It is
also the reason a naive "make everything additive" fix (`OWN-3`, `ADD-1`) would
*reduce* authority rather than widen it: converting a check from `role` to
`roles` against an empty array denies everyone.

**Backfilling `roles` from `role` is therefore a prerequisite for most of the
additive-roles work in this audit.** See
[`99-fix-sequencing.md`](./99-fix-sequencing.md).

**Done when.**
1. Every existing `org_members` row has a `roles` array containing at least its
   headline `role`.
2. Signup and both restore paths seed `roles` consistently.
3. The `COALESCE` idiom either handles the empty-array case or is removed as
   misleading.

---

## DB-4 · `acl_index` has no propagation — revoking at a library leaves every descendant granting

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `components/permissions/PermissionDrawer.tsx:273-284` — recomputes `acl_index` for the **edited node only**
  - `app/(protected)/documents/[libraryId]/page.tsx:600-605`, `:2073`, `:2450-2452` — descendants compute their index once, at creation, from the then-current chain
  - `supabase/migrations/20260901_db_hard_enforcement.sql:124-125` — the claim: *"acl_index is chain-resolved when written … so a single-node check faithfully enforces inherited denies"*
  - **no trigger, no job and no rebuild exists** (verified by search)
- **Related:** `DB-2`, `DB-5`, `OWN-7`, `OWN-20`

**Mechanism.** The claim in `20260901` is true **only until the parent changes.**
`acl_index` is chain-resolved at write time but written per node, and nothing
recomputes descendants when an ancestor's ACL changes.

**Failure scenario.** An admin revokes a contractor's grant at the library level.
Every document and folder beneath it still carries an `acl_index` that names
them. `node_visible` reads the node's own index, so the contractor keeps seeing
the documents. The revocation appears to have taken effect and has not.

**Chain reaction.** This is the finding that makes `DB-2`'s one-word fix
dangerous: activating the deny guard against **stale** indexes could block the
wrong people. It also compounds `OWN-7` (expiry is not carried into the index at
all), which means the index can be stale in two independent ways.

**`DEC-10` settles it: nightly rebuild now, derived column deferred.** A rebuild
from `acl` in the existing maintenance cron is the cheapest thing that fixes two
findings at once — it propagates ancestor changes to descendants **and** drops the
expired rules `buildAclIndexFromRules` never carried into the index (`OWN-7`). It
touches no SQL function and no JSON shape. A trigger-derived column is the durable
answer but is a schema change that would land while `DB-2`'s deny guard is being
switched on — too much moving at once.

Say plainly in your `Resolution` block that this narrows the stale-grant window
from *forever* to *one day*. Do not describe it as closed.

**Done when.** Changing a node's ACL is reflected in its descendants' effective
authority — by propagation, by rebuild, or by resolving the chain at read time —
and a test covers "grant at library, revoke at library, check a nested document."

---

## DB-5 · Three writers of `acl` and `acl_index`, with three different semantics

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `components/permissions/PermissionDrawer.tsx:273-284` — writes **both** `acl` and `acl_index`, via `buildAclIndexFromChain`
  - `app/(protected)/admin/libraries/page.tsx:101-108` — `dbConfig` contains `acl` and `default_new_acl` and **no `acl_index`**
  - `app/(protected)/admin/libraries/LibraryWizard.tsx:252-262` — builds rules and returns `acl` only
  - `supabase/migrations/20260812_per_library_publish_authority.sql:56-58` — **the database reads `acl_index` only**
- **Related:** `DB-4`, `OWN-1`, `OWN-8`

**Mechanism.** Two writers, one enforced column. The drawer keeps `acl` and
`acl_index` in sync; the library wizard writes only `acl`.

**Failure scenario.** An admin grants someone `publish` on Drawings via the
drawer. Months later they edit the library in the wizard to add a metadata
column. The wizard rewrites `acl` from its own form state — the grant is gone
from `acl`, so the UI stops offering the publish button. But **`acl_index` still
names them**, so `user_can_publish_on_library` returns true and the database
still accepts their revisions. **Revocation appears to have happened and did
not.**

The reverse is equally bad: a brand-new library has `acl_index = NULL`, so
`user_can_publish_on_library` returns false for everyone non-controller while
`resolveCanControlLibrary` falls back to raw `acl` and may say yes.

**Chain reaction.** Combined with `OWN-6` and `OWN-8`, the publish decision has
**three inputs that can all disagree**: `library.acl` at the page,
`acl_index`-then-`acl` in the mutator, and `acl_index` at the database. Any fix
that consolidates them should be checked against all three call sites at once.

**Done when.** Creating a library, editing it in the wizard, and granting or
revoking via the drawer all leave `acl` and `acl_index` consistent — and
revoking a publish grant in the drawer causes the database guard to reject that
user's next rev-up.

---

## DB-6 · Thirteen `SECURITY DEFINER` functions do not set `search_path`, while their neighbours do

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:** every one of these is `SECURITY DEFINER` with no `SET search_path`:

| Function | Migration |
|---|---|
| `node_visible` | `20260708_acl_rls_enforcement.sql` |
| `enforce_document_publish_guard` | `20260713`, `20260812`, `20260816`, `20260822` (four definitions) |
| `can_manage_node` | `20260816_documents_access_change_guard.sql` |
| `documents_guard_access_change` | `20260816_documents_access_change_guard.sql` |
| `revup_rollback_orphan` | `20260818_followups_rls.sql` |
| `publish_revision` | `20260823_publish_contract.sql`, `20260828_integrity_hardening.sql` |
| `enforce_legal_hold_delete_guard` | `20260826_legal_hold_delete_guard.sql` |
| `enforce_legal_hold_version_delete_guard` | `20260826_legal_hold_delete_guard.sql` |
| `enforce_document_move_guard` | `20261011_collections_guard_and_trash.sql` |

  Contrast with functions in the same repository that **do** set it:
  `20260724_ticket_numbering.sql:37`, `20260726_ticket_comments.sql:67`,
  `20260806_intelligence_layer.sql:151`, `20260810_archive_invariants.sql:20`,
  and `user_is_effective_owner` (`20260824_team_departments.sql:19`).
- **Related:** `OWN-5`, `DB-1`

**Mechanism.** A `SECURITY DEFINER` function runs with the definer's privileges.
If `search_path` is not pinned, an unqualified table or function reference
resolves against the **caller's** `search_path` — so a caller who can create
objects in a schema earlier on that path can shadow a table the function reads.

**Failure scenario.** The exposure depends on whether any role in this deployment
can create schemas or objects, which was not verified. **What is verified is the
inconsistency**: the codebase clearly knows the pattern and applies it to ticket
numbering and archive invariants while omitting it from the publish guard,
`node_visible`, `can_manage_node` and `publish_revision` — the four functions that
carry the most authority in the system.

**Chain reaction.** This is a cheap, low-risk, mechanical fix with no behavioural
change, which makes it a good one to land early — but note that four separate
definitions of `enforce_document_publish_guard` exist, and only the last one
applied is live. Fixing "the" guard means identifying which definition is
deployed. **Determine which one is live before editing any of them**, and record
the answer — four definitions of the load-bearing publish guard is itself a
hazard, and the next agent should not have to re-derive it.

**Done when.** Every `SECURITY DEFINER` function in the migration set pins
`search_path`, and a lint or test asserts it for new ones.

---

## DB-7 · The authority-function census — what reads what

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity

**Mechanism.** The database's authority helpers split cleanly into two families,
and the split is the root cause of a family of findings across this audit.

**Additive-aware (read `role` OR `roles[]`):**

| Function | Migration |
|---|---|
| `is_org_controller` | `20260814_documents_delete_controllers.sql:31-40` |
| `is_org_admin_or_manager` | `20260817:21-28` |
| `org_capability_allows` | `20260901:38` (but see `DB-3`) |
| `acl_index_denies` | `20260901:135` (but see `DB-2`, `DB-3`) |

**Headline-only (read the singular `role`):**

| Function | Migration | What it gates |
|---|---|---|
| `node_visible` | `20260708:58` | **all document and folder read visibility** |
| `can_manage_node` | `20260816:59-61` | ACL editing |
| `user_can_publish_on_library` | `20260812:48-52` | per-library publish |
| `enforce_document_publish_guard` | `20260822:60-64` | **publish and supersede** |
| `publish_revision` | `20260828:85-89` | the RPC's controller check |
| `doc_review_signoff_update` / `doc_ack_update` | `20260828:235,270` | sign-off and ack rows |
| `teams_admin_write` | `20260707:37-49` | team administration |

**Failure scenario.** The net effect, stated precisely:

> **Role-based *denies* bind on any of your roles; role-based *allows* bind only
> on your headline role.**

And the headline can be *demoted* by adding an unrelated role, because
`ROLE_RANK` orders by org chart rather than by privilege — `Manager` (90)
outranks `DocCtrl` (70). So adding a role can remove authority (`OWN-3`,
`ADD-1`), while never removing a restriction.

**Chain reaction.** ⚠ **This is a census, not an authorization to convert every
function.** Two specific traps:

- Converting a headline-only check to additive **widens** authority for every
  multi-role member at once. `DB-3` must land first or the conversion instead
  *denies* everyone.
- Reordering `ROLE_RANK` to put `DocCtrl` above `Manager` looks like a
  one-line fix and silently **removes** Manager-tier ticket authority from the
  same people.

**`DEC-2` settles it: route the headline-only checks through the existing
`is_org_controller`, and do NOT reorder `ROLE_RANK`. These are mutually
exclusive — applying both strips Manager-tier authority from exactly the people
the first fix was meant to help.**

**Done when.**
1. The five sites in the table above evaluate controller status through
   `is_org_controller`, converted one at a time in the order in
   [`99-fix-sequencing.md`](./99-fix-sequencing.md) — **`node_visible` last and
   separately**, since it gates all document read visibility.
2. `DB-3`'s backfill landed first, so "additive" does not mean "denied".
3. The widening inventory was run and recorded:
   `SELECT uid, role, roles FROM org_members WHERE roles && ARRAY['Admin','DocCtrl'] AND role NOT IN ('Admin','DocCtrl')`.
4. `ROLE_RANK` is byte-identical to its current value.

---

## Verified sound — do not break

1. **`is_org_controller()`** (`20260814:31-38`) — `SECURITY DEFINER`,
   additive-roles-aware, no RLS recursion. **This is the correct controller
   primitive.** Most of the remediation across this audit is routing existing
   checks through it, not writing new logic.
2. **RESTRICTIVE policy composition.** `documents_acl_select` /
   `collections_acl_select` AND with the permissive org policy, so an ACL denial
   cannot be OR'd away by a permissive policy elsewhere. The composition is
   correct — the findings are about tables that lack the overlay
   (`EGRESS-6`, `OWN-1`), not about how it composes.
3. **`prevent_last_admin_removal`** (`20260831:43-76`) — correct trigger
   placement, service-role exempt, covers UPDATE and DELETE, and checks
   `uid <> OLD.uid`. The org stays recoverable.
4. **Legal-hold delete triggers** (`20260826`) — BEFORE DELETE on both
   `documents` and `document_versions`, applying to service-role too, explicitly
   blocking cascades.
5. **`documents_guard_access_change` / `can_manage_node`** (`20260816`) — a
   faithful SQL replication of `lib/acl.ts` evaluation semantics, including
   deny-precedence and the `admin`-implies-everything rule, service-role exempt,
   with the default-open case handled correctly. **The right template for the
   missing `libraries` guard** (`OWN-1`).
6. **`collections_insert_controllers` / `collections_update_controllers` +
   `enforce_document_move_guard`** (`20261011`) — the write posture `libraries`
   needs.
7. **`user_is_effective_owner`** (`20260824:18-42`) — `SECURITY DEFINER STABLE`
   **with** `SET search_path = public`, correctly scoped, and the precedence
   walk is right. Its problems are what it *omits* (a membership check —
   `OWN-12`), not how it is written.
8. **`publish_revision`'s transactional core** — `SELECT … FOR UPDATE`, the
   expected-base check before any write, `stale_base` returned as structured data
   rather than an exception, and `document_versions_active_label_uniq` as a
   last-resort backstop. **The authority holes in `OWN-5` are a bolt-on to fix;
   do not rewrite the contract.**
9. **Grant expiry is fail-closed in SQL** (`20260901:70-73`), matching the
   TypeScript mirror. A malformed expiry disables the grant rather than making it
   eternal.
10. **`signup_attempts`** (`20261010`) — RLS on with zero policies, i.e.
    service-role only. A durable per-IP window that records probes, not just
    successes.
