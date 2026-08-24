# 11 · Database authority functions

> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T00:30:00Z

The SQL layer is where authority is actually enforced. This report covers the
helper functions and policies themselves: what they read, where they contradict
the application, and where they are broken outright.

**7 findings** — 2 CRITICAL, 3 HIGH, 2 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**
>
> **No live database was available** at audit time. These are unambiguous reads
> of policy and function bodies, and the two phantom-column findings are read
> from the schema of record. A staging reproduction should confirm them before
> any of it is treated as certain — migrations here are applied by hand, so the
> deployed state may carry drift the repository does not show.
>
> **Update 2026-08-24 — live verification.** The operator ran read-only probes
> from the Supabase SQL editor. Confirmed live: `org_capability_allows`,
> `acl_index_denies`, and the `documents_deny_write_guard` trigger all existed
> (the "live bug" world — both CRITICALs were real production breakage, not
> dormant), and **691 documents** carried a non-null `acl_index->'deny'`. After
> the combined remediation script
> (`supabase/APPLY_roles-and-permissions_2026-08-24.sql`, migrations
> `20261019`–`20261025`) was pasted, a 7-point probe returned `applied = true`
> for every fix — including `org_capability_allows` reading `data` and
> `acl_index_denies` reading `tm.uid`. The database and the repository now
> agree for everything in this report.

---

## DB-1 · `org_configurations.value` does not exist — the capability layer is inert and the holds policies raise

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, after the operator ran the DB-2 inventory).** The real column is `data` (`org_configurations` is `id, org_id, key, data, updated_at`), and **both** layers read the phantom `value`: `lib/capabilityPolicy.ts` selected `value` and upserted `value:` (so the read errored → returned `{}`, and every save errored — the whole capability layer was inert), and `org_capability_allows` did `SELECT value INTO v_val`. Both are fixed to `data` in one change, so the two layers agree.
- **Why this is safe (no lockout):** with no stored policy the function falls back to its SHIPPED DEFAULTS — `holds.open`/`holds.release` = `'*'` (anyone, same as before) and `checkout.force_release` = `Admin/DocCtrl` (the intended rule, already enforced app-side). And `20261024`'s roles backfill (which must run first) means the Admin's `checkout.force_release` token check evaluates against a populated `roles[]`, so an Admin is never refused their own force-release. The delegation UI can now actually persist a policy for the first time.
- Commit: (this session) — `lib/capabilityPolicy.ts` + `supabase/migrations/20261025_fix_capability_and_deny_column_typos.sql`
- Files: `lib/capabilityPolicy.ts`, `supabase/migrations/20261025_fix_capability_and_deny_column_typos.sql`
- Tests: `lib/__tests__/capabilityPolicy.test.ts` (12, green); full suite 1442.
- Verified: the migration's `org_capability_allows` is byte-identical to the `20260901` original except `value` → `data`; the app read/write use `data`; defaults preserve open behaviour for holds.
- Migration: `supabase/migrations/20261025_fix_capability_and_deny_column_typos.sql` — **applied & verified live 2026-08-24** (probe confirmed `org_capability_allows` reads `data`). Also fixes `DB-2` in the same file. Done-when 4 (a smoke test executing each SECURITY DEFINER helper) is left for a live-DB run.
- **World note (for the operator):** whether `20260901` is applied decides whether this fix takes effect immediately (holds repaired now) or sits ready until `20260901`'s policies are applied. Either way the fix is correct; the diagnostic that settles it is in the chat response.

- **Verification:** CONFIRMED (in code) / SUSPECTED (deployed state may differ)
- **Blast radius:** availability / access-control
- **Locations:**
  - `supabase/schema.sql:52-59` — `org_configurations` has `data JSONB NOT NULL DEFAULT '{}'`. **There is no `value` column, and no migration adds one.**
  - `supabase/migrations/20260901_db_hard_enforcement.sql:44` — `SELECT value INTO v_val FROM org_configurations`
  - `lib/capabilityPolicy.ts:174`, `:231` — the application reads and writes the same phantom column
  - `supabase/migrations/20260701_perf_indexes.sql:21` — documents the real shape as `select('data')`
- **Related:** `WF-1`, `WF-23`, `SURF-3`, `SURF-4`
- **Re-verified:** hardening pass — **SURVIVES**. `org_configurations` is `(id, org_id, key, data JSONB, updated_at)` — `schema.sql:52-59`. There is no `value` column and no migration adds one; `20260901_db_hard_enforcement.sql:44` reads `value` too, so the DB-side holds policy is inert for the same reason.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed CRITICAL, and the verifier found it reaches further than the finding states: 20260901_db_hard_enforcement.sql:44 `SELECT value INTO v_val FROM org_configurations` raises 42703 at runtime inside org_capability_allows, which is the sole gate on document_holds_insert/_update (:92-101) — so every hold insert and release errors outright, not merely the capability layer falling back to defaults.

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
- **Status:** RESOLVED

**Resolution (2026-08-24, after the operator ran the inventory: 691 documents carry an explicit deny).** `acl_index_denies` compared `team_members.user_id` (a column that does not exist → `42703`) to `p_uid::text`; the column is `uid` (uuid). Fixed to `tm.uid = p_uid` in `20261025`. The function is byte-identical to its `20260901` original except that one line.
- **Blast radius, from the inventory:** 691 documents have a deny block — but the bug only *manifests* for the subset that use **team-level** denies (uid- and role-level denies return `TRUE` before reaching the broken subquery, so they already enforce correctly). For those team-deny documents, a non-controller's `UPDATE` currently aborts with a raw SQL error; after the fix it returns a clean policy denial instead. **No new lockouts** — the same people are blocked, just with a comprehensible error. Run `DB-4`'s nightly rebuild (shipped, `lib/aclIndexRebuild.ts`) once before applying so the 691 denies are current, not stale.
- Commit: (this session) — `supabase/migrations/20261025_fix_capability_and_deny_column_typos.sql` (same file as `DB-1`)
- Files: `supabase/migrations/20261025_fix_capability_and_deny_column_typos.sql`
- Verified: the migration's `acl_index_denies` is byte-identical to the `20260901` original except `tm.user_id = p_uid::text` → `tm.uid = p_uid`; the client twin `ViewAsSimulator.tsx:59` is `OWN-10`, unchanged here.
- Migration: `20261025_fix_capability_and_deny_column_typos.sql` — **applied & verified live 2026-08-24** (probe confirmed `acl_index_denies` reads `tm.uid`).
- **World note:** if `20260901` is applied, `documents_deny_write_guard` exists and this fix makes it enforce correctly now; if not applied, the corrected function sits unused until `20260901`'s policies are applied — this migration installs no policy of its own.

- **Verification:** CONFIRMED (defect) / SUSPECTED (runtime blast radius)
- **Blast radius:** availability / access-control
- **Locations:**
  - `supabase/migrations/20260901_db_hard_enforcement.sql:141-145` — `SELECT 1 FROM team_members tm WHERE tm.user_id = p_uid::text`
  - `supabase/migrations/20260707_teams.sql:19-26` — the columns are `team_id, uid, org_id, added_at, added_by`. **There is no `user_id`,** and no later `ALTER TABLE team_members` exists.
  - every other reader uses `uid`: `20260812:62`, `20260708:76`, `20260816:62`, `lib/teams.ts:116,122`, `lib/knowledgeAccess.ts:35`, `app/api/storage/download-url/route.ts:74,100`
  - the same typo in the client: `components/permissions/ViewAsSimulator.tsx:59` (`OWN-10`)
- **Related:** `DB-1`, `OWN-10`, `DB-4`
- **Re-verified:** hardening pass — **SURVIVES**. `team_members` is keyed `(team_id, uid)` — `20260707_teams.sql:19-26`. The function queries `tm.user_id`, which does not exist, so `acl_index_denies` raises rather than denying.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence: every other reader (lib/teams.ts:116,122, lib/knowledgeAccess.ts:35, app/api/storage/download-url/route.ts:74,100, 20260812:62, 20260708:76, 20260816:62) uses `uid`; only this function and components/permissions/ViewAsSimulator.tsx:59 use `user_id`. acl_index has no DEFAULT (schema.sql:70,101,124,162 `acl_index JSONB`), so the function returns early on NULL — the error is latent until the first real ACL write, exactly as claimed. Note the comparison is also uuid-vs-text, so even adding the column would not fix it.

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

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution.** Signup now seeds `roles: ["Admin"]` on the founding member row (`app/api/auth/signup/route.ts`) — it previously set only the singular `role`, leaving `roles` at its `'{}'` default so every additive check evaluated the founding Admin against an empty array. The backfill migration `20261024_backfill_member_roles.sql` sets `roles = ARRAY[role]` for every existing row missing its headline role (idempotent, with a zero-rows verification query). This is the prerequisite the sequencing file names for **any** singular→array conversion (`DEC-1`, `DEC-2`, `OWN-3`).
- Commit: `8dc4543`
- Files: `app/api/auth/signup/route.ts`, `supabase/migrations/20261024_backfill_member_roles.sql`
- Tests: `lib/__tests__/signupRoute.test.ts::"seeds roles: ['Admin'] on the founding member row"` — a full happy-path signup asserting the `org_members` insert carries `roles: ["Admin"]`.
- Reproduced: the pre-fix signup insert set `role: "Admin"` with no `roles` key; `roles TEXT[] NOT NULL DEFAULT '{}'` means the row lands with `roles = '{}'`.
- Verified: Done-when 1 — the backfill guarantees every row's `roles` contains its `role`. Done-when 2 — signup seeds it; restore placeholders are `status:'inactive'` and filtered by every additive check's `status='active'` predicate (per the independent verifier), so they are not load-bearing. Done-when 3 — the `COALESCE` idiom is documented as misleading in the backfill header; it is left in place because removing it is a broader SQL change deferred with the additive-conversion work.
- Migration: `supabase/migrations/20261024_backfill_member_roles.sql` — **applied & verified live 2026-08-24** (probe: zero members whose `roles[]` misses their headline `role`).
- **What this brought to light:** `DB-1`'s BLOCKED activation depends on this backfill having run — recorded as step 2 of `DB-1`'s unblocking sequence.
- **Replay form corrected (2026-08-24 adversarial-review round).** The
  applied UPDATE's `SET roles = ARRAY[role]` also fired on a POPULATED
  collection that merely missed its headline role — replacing, not
  appending, and silently dropping every additive role on such a drifted
  row. The live probe showed no drifted rows existed when it ran, so nothing
  was lost in production — but the file stays in the replayable set for
  fresh deployments, so it now splits the statement: empty/NULL collections
  are seeded, populated-but-missing-headline collections get the headline
  APPENDED (`roles || ARRAY[role]`). Same end state for non-drifted rows;
  the applied-version note is in the file.
- **Verification:** CONFIRMED
- **Blast radius:** availability / access-control
- **Locations:**
  - `supabase/schema.sql:41` — `roles TEXT[] NOT NULL DEFAULT '{}'`
  - `supabase/migrations/20260722_member_roles_collection.sql:13` — the same, on the `ALTER TABLE` path
  - the idiom, three times: `supabase/migrations/20260901_db_hard_enforcement.sql:38`, `:135`, and `supabase/migrations/20260907_milestone_batch_move.sql:33`
  - `app/api/auth/signup/route.ts` — **does not set `roles`** (a search for `roles` in the file returns nothing)
- **Related:** `DB-1`, `DB-2`, `ADD-1`, `OWN-3`
- **Re-verified:** hardening pass — **SURVIVES**, and the reason is one word in the DDL. `roles TEXT[] NOT NULL DEFAULT '{}'` (`schema.sql:41`) means the column is **never NULL**, so `COALESCE(roles, ARRAY[role])` — used at `20260901_db_hard_enforcement.sql:38` and `:135` and `20260907_milestone_batch_move.sql:33` — never falls through. A member whose `roles` was never populated evaluates against `{}`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Mechanism is exactly right and the seeding UPDATE at 20260722:16-19 only ran once at migration time, so it does not help orgs created later. Severity lowered: the blast radius is one member per org (invited members get `roles:[role]` from create-user/route.ts:130,161; restore placeholders are `status:'inactive'` and so are filtered out by every function's `status='active'` predicate), and org_capability_allows is only wired to three capabilities — holds.open/holds.release default to `'*'` and pass anyway, leaving `checkout.force_release` plus the milestone batch move as the only real denials, both fail-closed and self-healing if the admin is ever re-added via Add Member.

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
- **Status:** RESOLVED

> **`DEC-10` scope:** this narrows the stale-grant window to one cron cycle; it
> does not close it. The index still carries no expiry, so the raw evaluator
> remains the source of truth between cycles. A trigger-derived column is the
> durable answer, deferred per `DEC-10` until the deny guard (`DB-2`) is live.

**Resolution.** Per `DEC-10`, a nightly rebuild now recomputes every node's `acl_index` from its ACL plus the resolved ancestor chain, org by org, in `/api/cron/maintenance`. The chain is resolved faithfully from the same merge the construction path uses (`buildAclIndexFromChain`), walking `libraries → collections (via collections.path_ids) → documents`, and **dropping expired rules** (the `OWN-7` half — the builder gained an optional `nowMs` that filters `isRuleActive`; absent, it is byte-identical to before, so no existing call site changes). The rebuild is **diff-guarded**: it only writes a node whose recomputed index differs from the stored one, so it is a no-op for already-correct data and idempotent — which bounds the blast radius of an access-control mutation over every node in every org to genuinely stale/expired indexes.
- Commit: `8dc4543`
- Files: `lib/acl.ts` (expiry-aware builder), `lib/aclIndexRebuild.ts` (the walk), `app/api/cron/maintenance/route.ts` (wired as step 4b)
- Tests: `lib/__tests__/aclIndexRebuild.test.ts` — expiry filtering, backward-compat when no clock is passed, expiry threading through a chain, the diff-guard (rewrites a stale document, skips a correct one), and the expired-grant drop.
- Reproduced: `PermissionDrawer.tsx:284` writes `.eq("id", nodeId)` (the edited node only); no trigger propagates; folders/documents index once at creation from the then-current chain.
- Verified: granting then revoking at a library, then checking a nested document after one rebuild cycle, shows the revocation applied (the diff-guard test encodes the stale-document case); an expired publish rule stops authorizing after one cycle (the expired-drop test); the rebuild is idempotent (diff-guard skips unchanged nodes). **This narrows the stale-grant window from *forever* to *one cron cycle* — it is NOT a full fix**: the index still carries no expiry, so the raw evaluator remains the source of truth between cycles (as `DEC-10` states). A trigger-derived column is the durable answer, deferred per `DEC-10` until the deny guard (`DB-2`) has been live and quiet.
- **What this brought to light:** the rebuild's expiry filter is exactly the `CHAIN-4` hazard note — a naive rebuild that called the unmodified `buildAclIndexFromRules` would have re-imported expired rules into the index. The builder change fixes that at the source, so any future caller can opt into expiry-correct indexing by passing `nowMs`. Also duplicate of `OWN-20` within this area — resolved once here.
- **Hardened (2026-08-24 adversarial-review round).** The 57-agent review
  found the first walk unsafe against PARTIAL DATA, which for a rebuild that
  REPLACES indexes is fail-open: (1) a failed table read coalesced to an
  empty list and the walk kept going — a collections timeout meant every
  document's index was rewritten without its folder chain's allow AND deny
  rules, and the diff guard happily persisted it; (2) no pagination, so
  PostgREST's 1000-row cap silently truncated big orgs the same way (the repo
  already codes around this in `lib/dataExport.ts`); (3) write failures only
  skipped a counter — a stale, possibly expired index stayed persisted with
  zero operational signal; (4) `document_sets` — the fourth ACL-indexed node
  type, RLS-gated directly on its own `acl_index` by
  `document_sets_acl_select` (20260813) — was never rebuilt, so a time-boxed
  grant on a drawing set never expired at the RLS layer. All four fixed: every
  read is paginated and error-checked (an org with any failed read is skipped
  whole and reported), a node with a dangling `library_id`/`path_ids` ancestor
  is skipped-and-reported rather than rebuilt ruleless, write failures land in
  `RebuildCounts.errors` which the cron folds into its `errors` list, and the
  walk gained a library→set pass. Tests pin each: skip-on-read-failure,
  dangling-ancestor skip, write-error surfacing, and the set rebuild.
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `components/permissions/PermissionDrawer.tsx:273-284` — recomputes `acl_index` for the **edited node only**
  - `app/(protected)/documents/[libraryId]/page.tsx:600-605`, `:2073`, `:2450-2452` — descendants compute their index once, at creation, from the then-current chain
  - `supabase/migrations/20260901_db_hard_enforcement.sql:124-125` — the claim: *"acl_index is chain-resolved when written … so a single-node check faithfully enforces inherited denies"*
  - **no trigger, no job and no rebuild exists** (verified by search)
- **Related:** `DB-2`, `DB-5`, `OWN-7`, `OWN-20`
- **Re-verified:** hardening pass — **SURVIVES**. `PermissionDrawer.tsx:284` writes `.eq("id", nodeId)` — the edited node only. No descendant is touched, and no trigger propagates. Duplicate of `OWN-20` within this area; fix once.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence. page.tsx:600-605 builds the index from `buildAclIndexFromChain(myChain)` at folder-creation time only — the index is a snapshot taken when the node is written, so a later library-level revoke never reaches documents or folders already indexed.

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
- **Status:** RESOLVED

**Resolution.** The library wizard save path (`app/(protected)/admin/libraries/page.tsx`) now writes `acl_index` alongside `acl` (via `buildAclIndex`), so the raw-ACL and index-based layers no longer diverge for a wizard-created or -edited library. Critically — to avoid trading the finding's under-revocation for over-revocation (the independent verifier's "real fork") — the save **merges** rather than clobbers: `mergeWizardLibraryAcl` keeps the wizard's role-subject rules and **re-adds the permission drawer's granular user/team/org grants**, which the wizard form does not manage. So a metadata-only edit through the wizard no longer silently drops a drawer-added publish grant, and both columns derive from one consistent merged ACL.
- Commit: (this Phase 2 record; code in `8dc4543` + the merge follow-up)
- Files: `app/(protected)/admin/libraries/page.tsx`, `lib/acl.ts` (`mergeWizardLibraryAcl`)
- Tests: `lib/__tests__/mergeWizardAcl.test.ts` — the merge keeps wizard role rules and preserves drawer user/team grants, drops the old role rule (wizard owns role access), handles the no-wizard-ACL case, and the derived `acl_index` names the preserved user grant.
- Reproduced: the pre-fix `dbConfig` wrote `acl: config.acl ?? null` with **no `acl_index`**, so a wizard-saved library had `acl_index = NULL` and was invisible to `canPublishViaIndex` / `node_visible` / `user_can_publish_on_library` while the raw evaluator honoured `acl`.
- Verified: a wizard save now writes a consistent `acl` + `acl_index`; a drawer grant survives a subsequent wizard metadata edit (the merge test); suite 1442 green.
- **What this brought to light:** the folder-creation path (`documents/[libraryId]/page.tsx:600-605`) already writes both columns correctly (`buildAclIndexFromChain`), and the drawer writes both — so the wizard was the only diverging writer. The deeper structural point (raw `acl` chain for app-side read/discover vs `acl_index` for RLS) is what `DB-4`'s nightly rebuild keeps reconciled going forward.
- **Hardened (2026-08-24 adversarial-review round).** The first merge split
  rules by SUBJECT TYPE ("preserve non-role") and that heuristic was wrong in
  both directions. Fail-open: the wizard itself authors a NON-role rule — the
  org-subject "Everyone" allow (`LibraryWizard.tsx:275`) — so an
  Everyone→restricted edit re-imported the old org-wide allow from the
  existing rules and the restriction never took effect (and every repeat
  "Everyone" save appended a duplicate copy). Fail-closed: the DRAWER can
  author role-subject rules the wizard cannot re-express — a role deny, a
  role publish grant (the very grant OWN-9 added DraftingSupervisor to the
  pickers for) — and "drop all role rules" stripped them on any metadata
  edit. The merge now splits by OWNERSHIP instead: a rule the wizard re-emits
  (an ALLOW for a role/org subject whose actions all fall inside the wizard's
  action vocabulary) is replaced by this save's output; everything else —
  user/team rules, ALL denies, role/org allows carrying `publish` or other
  non-wizard actions — is preserved verbatim, deduplicated by value. A third
  hole closed with it: the page cached the UNMERGED wizard ACL in local
  state, so the second edit of the same library in one session merged against
  role-only rules and clobbered every drawer grant after all — it now caches
  what was persisted. New tests pin all three: Everyone→restricted actually
  restricts, repeat saves don't duplicate, role denies and role publish
  grants survive.
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `components/permissions/PermissionDrawer.tsx:273-284` — writes **both** `acl` and `acl_index`, via `buildAclIndexFromChain`
  - `app/(protected)/admin/libraries/page.tsx:101-108` — `dbConfig` contains `acl` and `default_new_acl` and **no `acl_index`**
  - `app/(protected)/admin/libraries/LibraryWizard.tsx:252-262` — builds rules and returns `acl` only
  - `supabase/migrations/20260812_per_library_publish_authority.sql:56-58` — **the database reads `acl_index` only**
- **Related:** `DB-4`, `OWN-1`, `OWN-8`
- **Re-verified:** hardening pass — **SURVIVES**. Three writers with three payload shapes: `PermissionDrawer.tsx:273-284`, `admin/libraries/page.tsx:101-108`, and the folder-creation path at `documents/[libraryId]/page.tsx:600-605`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The structural claim holds: the wizard edit path silently discards every user- and team-scoped rule the drawer wrote into `acl`, and never touches `acl_index`, so the two columns diverge permanently. One correction to the summary's narrative: publish authority does NOT fork the way described — both sides deliberately read the index (lib/permissions.ts:61-88 `canPublishViaIndex` and 20260812:56 `SELECT acl_index INTO v_idx`), so the drawer's publish grant survives in the UI too. The real fork is elsewhere: app-side read/discover evaluates the raw `acl` chain (canWithAclChain, permissions.ts:22-40) while RLS evaluates `acl_index` (node_visible), and new descendants get indexed from the truncated `acl`.

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

## DB-6 · Twenty `SECURITY DEFINER` functions do not set `search_path`, while their neighbours do

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution.** `supabase/migrations/20261020_pin_search_path.sql` pins `search_path = public` (the house style — 20260724, 20260810, 20260824 et al.) on every remaining unpinned `SECURITY DEFINER` function via **ALTER FUNCTION, not re-CREATE** — ALTER pins whichever body is actually deployed without touching it, which is the only safe move when four historical bodies of `enforce_document_publish_guard` exist and applied state is unobservable (`DEC-30`). Every entry is guarded with `to_regprocedure(sig) IS NOT NULL`, so the script is idempotent and tolerant of partially-applied databases; a verification query at the end lists anything still unpinned. Two legacy `publish_revision` signatures are included defensively. `publish_revision` itself is pinned at creation by `20261019_publish_revision_drop_dead_param.sql` (the DEC-11 signature change). A lint test now replays the whole migration set and fails when any function's final definition is SECURITY DEFINER, unpinned, and not covered by the ALTER migration — the "Done when" guard for new functions; negative-tested by removing an entry and watching it name the function. `supabase/REMEDIATION_APPLY_ALL.sql` (advertised "safe to RE-RUN") re-creates 7 of these functions and would have silently stripped the pins on re-run — a pin-restoring DO block is appended to it, and the deeper hazard is recorded as `DB-8`.
- Commit: `2af2ebe`
- Files: `supabase/migrations/20261020_pin_search_path.sql`, `supabase/migrations/20261019_publish_revision_drop_dead_param.sql`, `supabase/REMEDIATION_APPLY_ALL.sql`, `lib/__tests__/searchPathPin.test.ts`
- Tests: `lib/__tests__/searchPathPin.test.ts::"every live definer function is pinned at creation or by 20261020_pin_search_path.sql"` (allowlist parsed from the migration itself so they cannot drift) and `::"the ALTER migration's legacy publish_revision entries stay defensive, not load-bearing"`.
- **Lint parser corrected (2026-08-24 adversarial-review round).** The
  census had three parser bugs that made the lint fail OPEN: it processed
  every CREATE in a file before every DROP, inverting SQL's textual order for
  the standard `DROP … ; CREATE …` re-creation pattern (so re-created LIVE
  functions were censused as dropped and skipped — `mfg_storage_estimate`
  among them); `--` comments were matched as real statements (a rollback
  comment killed `user_can_publish_on_library` from the census); and the
  argument capture stopped at the first `)` including one inside an arg-list
  comment, so `publish_revision`'s 11 parameters censused as 5 and the
  allowlist pairing was broken by construction. The census now strips
  comments, applies CREATE/DROP events in textual order per file, captures
  paren-nested argument lists, counts arity on top-level commas only, and
  accepts tagged dollar quotes. Two self-checks added: every 20261020
  signature must pair with a censused key (drift is now loud), and
  `publish_revision/11` must census live-and-pinned through its own
  drop-then-recreate. All functions the corrected census newly sees are
  pinned — consistent with the live probe — so the lint stays green while
  actually watching them.
- Reproduced: independent scripted census (final definition per `(name, arity)` over `schema.sql` + all migrations) confirmed every function in the table SECURITY DEFINER and unpinned at its final definition.
- Verified: Done-when 1 — all live definer functions pinned at creation or via the ALTER migration (census script returns zero). Done-when 2 — the lint test enforces it for new functions. **The live `enforce_document_publish_guard` is the `20260822_review_completion_guard.sql:21` definition** (4th of 4; that migration also re-binds the trigger) — recorded here so the next agent does not re-derive it.
- Migration: `supabase/migrations/20261020_pin_search_path.sql` — **applied & verified live 2026-08-24** (probe: zero `SECURITY DEFINER` functions in `public` without a pinned `search_path`).

> **Verifier corrections to the count reconciliation above (2026-08-24).** The
> reconciliation fell into its own trap #1: `publish_revision(11)` is **not
> live** — `20260828_integrity_hardening.sql:37` DROPs that exact 11-arg
> signature before creating its replacement, and the replacement has **arity
> 12** (`p_override_lock` is the 12th parameter), not 13. So the settled
> census is **55 distinct `(name, arity)`, 39 SECURITY DEFINER, 18 unpinned
> live** after the DEC-11 signature change (19 before it) — plus the two
> dead-in-repo-but-maybe-deployed legacy signatures the migration covers
> defensively. The substance of the finding is unchanged; the "both are live"
> sentence is what fails.
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:** every one of these is `SECURITY DEFINER` with no `SET search_path`:
- **Re-verified:** **SURVIVES — and the count was too low.** The original thirteen was an undercount; see the reconciliation below for the settled figure.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. The named contrast (ticket numbering and archive invariants hardened, publish guard and `node_visible` not) is exactly right, and MEDIUM is fair given the exposure depends on CREATE privileges this repository cannot show. The count is settled below.

> **Count reconciliation.** Four passes produced four different numbers — 13 as
> filed, then 23-of-44, 23-of-44 and 18-of-37 from three separate verifiers. All
> four are wrong, and they disagree for two reasons worth stating, because any
> future re-census will hit the same traps:
>
> 1. **Superseded definitions.** `enforce_document_publish_guard` is written four
>    times across four migrations. Only the last one exists in the live database;
>    counting all four inflates the denominator. That is where 44 comes from.
> 2. **Overloads are not supersessions.** `publish_revision` exists at arity 11
>    (`20260823_publish_contract.sql`) *and* arity 13
>    (`20260828_integrity_hardening.sql`). Postgres keys functions by signature,
>    so `CREATE OR REPLACE` with a changed arity adds a second function rather
>    than replacing the first — **both are live, and neither pins `search_path`.**
>    Collapsing them by name is where 37 comes from.
>
> Counting each distinct `(name, arity)` at its final definition: **57 functions,
> 39 of them `SECURITY DEFINER`, of which 20 set no `search_path`.** That list is
> the table below, and it is exhaustive.

| Function | Effective definition |
|---|---|
| `my_org_ids()` | `supabase/schema.sql` |
| `my_team_ids()` | `20260707_teams.sql` |
| `node_visible(3)` | `20260708_acl_rls_enforcement.sql` |
| `is_org_admin(1)` | `20260713_branding_admin_writes.sql` |
| `doc_is_visible(1)` | `20260813_acl_close_gaps_and_audit_scope.sql` |
| `my_project_ids()` | `20260813_acl_close_gaps_and_audit_scope.sql` |
| `is_org_controller(1)` | `20260814_documents_delete_controllers.sql` |
| `can_manage_node(2)` | `20260816_documents_access_change_guard.sql` |
| `documents_guard_access_change()` | `20260816_documents_access_change_guard.sql` |
| `is_org_admin_or_manager(1)` | `20260817_org_members_escalation_and_config.sql` |
| `bump_share_access(1)` | `20260818_followups_rls.sql` |
| `can_manage_project(1)` | `20260818_followups_rls.sql` |
| `is_org_assign_drafters(1)` | `20260818_followups_rls.sql` |
| `revup_rollback_orphan(2)` | `20260818_followups_rls.sql` |
| `enforce_document_publish_guard()` | `20260822_review_completion_guard.sql` |
| `publish_revision(11)` | `20260823_publish_contract.sql` |
| `enforce_legal_hold_delete_guard()` | `20260826_legal_hold_delete_guard.sql` |
| `enforce_legal_hold_version_delete_guard()` | `20260826_legal_hold_delete_guard.sql` |
| `publish_revision(13)` | `20260828_integrity_hardening.sql` |
| `enforce_document_move_guard()` | `20261011_collections_guard_and_trash.sql` |

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
- **Re-verified:** Re-read in the hardening pass. **This is an authority-function census, not a defect** — nothing to refute. Use it as the map before changing any policy.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Every factual assertion in the census checks out, including the asymmetry (`acl_index_denies` unnests all roles for denies while `node_visible` reads only the singular `role` for allows) and the ROLE_RANK demotion trap. The entry carries no independent defect of its own — it self-declares as a census — so its MEDIUM is nominal rather than an impact rating.

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

## DB-8 · `REMEDIATION_APPLY_ALL.sql` is a second source of truth that a re-run restores over later hardening

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / integrity-of-record
- **Locations:**
  - `supabase/REMEDIATION_APPLY_ALL.sql:1-8` — *"safe to RE-RUN (every statement is CREATE OR REPLACE …)"*
  - `:54,69,92,126,147,170,178` — re-creates `doc_is_visible`, `my_project_ids`, `is_org_controller`, `can_manage_node`, `documents_guard_access_change`, `is_org_admin`, `is_org_admin_or_manager` from copies frozen at the time the script was written
  - `supabase/migrations/20261020_pin_search_path.sql` — the pins a re-run would strip (mitigated: a re-pin DO block is now appended to the script)
- **Related:** `DB-6`
- *(Found while resolving `DB-6`, 2026-08-24. Checked only by this session — treat per the `author` grade until independently challenged.)*

**Mechanism.** The script duplicates the bodies of seven authority-bearing
functions outside the migration sequence. `CREATE OR REPLACE` resets a
function's `proconfig` **and its body** — so any later migration that hardens
one of these seven (a pin, a membership check, an additive-roles fix) is
silently reverted the next time someone runs the "safe" script. It is not safe;
it is safe *as of the day it was frozen*. The `search_path` half is mitigated
(the appended block re-pins), but a body divergence would not be. Spot-check:
`is_org_admin_or_manager` is currently equivalent in both sources (both read
`roles &&` additively), so the hazard is **prospective, not yet realized** —
DB-6's pins were the first concrete thing a re-run would have undone, and
Phase 2's additive-role migrations are the next.

**Failure scenario.** Phase 2 lands `DEC-1`'s additive fixes in a migration.
Months later an operator re-runs `REMEDIATION_APPLY_ALL.sql` after a restore,
reverting `is_org_controller` to the frozen copy — and the publish path quietly
loses whatever the migration added, with no error and no record.

**Remediation (illustrative).** Either regenerate the script mechanically from
the migration set (so it cannot fork), or replace the seven function bodies with
a header instruction to apply migrations `NNNN+` instead, keeping only the
table/policy DDL that is genuinely idempotent.

**Done when.** Re-running the script on a fully-migrated database leaves every
function byte-identical to its final migration definition, or the script no
longer defines functions at all.

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
