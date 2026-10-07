# 03 · The audit log & admin rails

**14 findings** — 1 CRITICAL · 4 HIGH · 9 MEDIUM.

What the trail can prove, and whether every admin surface is gated server-side.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| audit_logs is genuinely append-only for authenticated callers — no UPDATE and no DELETE policy is created anywhere, and no app code path deletes or updates a row | `supabase/schema.sql:1084-1087; supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90 ("Rows remain append-only (no UPDATE/DELETE policy exists)")` | This is the one PSM-grade property the audit table actually has. Verified two ways: a policy census over supabase/ for `ON audit_logs`, and a repo-wide grep of `audit_logs` filtered for delete/update, which returns only inserts. Any future fix must not add a FOR ALL policy here. |
| audit_logs_insert pins user_id = auth.uid() AND org membership, closing cross-org audit injection | `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90` | A member cannot write forged entries into another org's trail. This is the rail that makes the remaining forgery vectors (restore, client-supplied user_role) bounded rather than unlimited. |
| Every /api/admin/* route verifies a bearer token through the anon client before it ever touches the service-role client | `lib/serverAuth.ts:36-58; all 18 routes under app/api/admin/ call authorizeOrgRole or an equivalent inline check (app/api/admin/create-user/route.ts:22-31, app/api/admin/schema-health/route.ts:33-40)` | The client-only gating on the /admin pages is survivable precisely because the destructive server routes are gated independently. Do not consolidate page gating in a way that removes these. |
| prevent_last_admin_removal() blocks demoting, suspending or deleting an org's final active Admin, and exempts the service role | `supabase/migrations/20260831_capability_policy_and_rails.sql:43-76` | The recoverability rail. It is BEFORE UPDATE/DELETE on org_members and is the reason a misconfigured capability policy is always fixable. |
| validateCapabilityPolicy refuses any save that removes Admin from a capability marked critical, and the editor locks that checkbox in the UI | `lib/capabilityPolicy.ts:200-214; components/permissions/CapabilityPolicyEditor.tsx:147` | Belt-and-braces on the same rail. Two independent enforcement points for the same invariant. |
| /api/admin/create-user validates the role string against ALL_ROLES, refuses a DocCtrl minting an Admin, and refuses a DocCtrl demoting an existing Admin on the re-add path | `app/api/admin/create-user/route.ts:49-51, 66-72, 118-125` | The only server-side member-provisioning path, and it is carefully written. The gap is that it writes no audit row (see finding), not that it is unguarded. |
| /api/admin/schema-health exists as an honest rail for detecting migrations that were never pasted in, including per-column probes | `app/api/admin/schema-health/route.ts:24-27, 55-65; lib/schemaExpectations.ts:117-126` | It is the correct place to catch the org_configurations column defect below — EXPECTED_COLUMNS just does not carry that probe yet. |
| documents and document_versions carry BEFORE DELETE legal-hold triggers that also block cascading deletes | `supabase/migrations/20260826_legal_hold_delete_guard.sql:29-57 (OLD.record_id matches document_versions.record_id, supabase/schema.sql:322)` | The only thing standing between a library DELETE and total loss of a held record. A fix to library deletion must not route around these. |


---


<a id="alog-1"></a>

## ALOG-1 · The capability policy is read from and written to `org_configurations.value` — a column that does not exist; the table's column is `data`, so every org's action-permission policy and every per-person delegation is inert, and the DB function that holds RLS depends on raises at runtime

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Assigned:** admin-and-org P9 (done-when 2: a capability-policy read error is said, never rendered as the shipped defaults) — by the integrator, 2026-10-02 (at the A&O P0 merge: the verify-and-record package named the owner in its Partial block; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED
- **Locations:** `lib/capabilityPolicy.ts:172-176`, `lib/capabilityPolicy.ts:229-235`, `supabase/migrations/20260901_db_hard_enforcement.sql:44-45`, `supabase/schema.sql:52-59`, `lib/orgBranding.ts:22-28`, `lib/ticketRouting.ts:48-53`, `app/(protected)/admin/requests/page.tsx:98-99`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide search confirms the absence: no `ALTER TABLE org_configurations`, no `ADD COLUMN value`, no rename anywhere under supabase/ — the only `value JSONB` in the tree is an unrelated table in 20260920_per_user_keys_real_limits.sql:25. The read path fails silently (supabase-js returns an error object, `data?.value` is undefined, raw={} so DEFAULTS apply); the save path throws at capabilityPolicy.ts:234 `if (error) throw new Error(error.message)`; and org_capability_allows() — whose body is only planned at execution time — raises `column "value" does not exist` on every call, which is exactly what gates the document_holds INSERT/UPDATE policies (20260901:94,99,101) and the checkout force-release trigger (:115). CRITICAL is correct.

**Mechanism.** `org_configurations` is defined exactly once, in supabase/schema.sql:52-59, as `id / org_id / key / data JSONB NOT NULL DEFAULT '{}' / updated_at`. There is no `value` column and no migration adds one. Three differently-shaped searches confirm it: (a) `grep -rniE "alter table (public\.)?org_configurations" supabase/` returns only the ENABLE ROW LEVEL SECURITY line; (b) `grep -rn -A8 "CREATE TABLE IF NOT EXISTS org_configurations" supabase/` returns one definition, with `data`; (c) listing every repo file that mentions `org_configurations` and testing each for the token `value` leaves only lib/capabilityPolicy.ts and 20260901_db_hard_enforcement.sql. Every other consumer uses `data`: `.select("data")` in lib/orgBranding.ts:24 and lib/ticketRouting.ts:50, and `.upsert({ org_id: activeOrgId, key: 'drafting', data: settings }, ...)` at app/(protected)/admin/requests/page.tsx:99. The two outliers are: `loadCapabilityPolicy` — `.from("org_configurations").select("value").eq("org_id", orgId).eq("key", "capability_policy")` (lib/capabilityPolicy.ts:173-176), wrapped in a `try { … } catch { return {}; }` (line 190) so PostgREST's 42703 becomes a silent fall-through to the shipped DEFAULTS; `saveCapabilityPolicy` — `.upsert({ org_id: input.orgId, key: "capability_policy", value: input.policy, updated_at: … }, { onConflict: "org_id,key" })` (line 231), which does check `{ error }` and throws; and the SQL helper `org_capability_allows()`, whose body is `SELECT value INTO v_val FROM org_configurations WHERE org_id = p_org AND key = 'capability_policy';` (20260901:44-45) with no declared variable named `value`, so the reference resolves to a column and plpgsql raises 42703 on first execution.

**Failure scenario.** An Admin opens /admin/permissions, unchecks Supervisor from "Force close" and Manager from "Reopen closed tickets", confirms the impact dialog, and gets an error (the upsert throws on the unknown column) — or, on a database where 20260901 was applied, something worse happens first: `document_holds_insert WITH CHECK (org_capability_allows(org_id,'holds.open',auth.uid()))` (20260901:92-94) and the `enforce_checkout_release_guard` trigger (20260901:108-120) both call the failing function, so placing a do-not-advance hold on a P&ID and force-releasing a stale checkout fail with a raw Postgres error for every authenticated user. Meanwhile `loadCapabilityPolicy` swallows its own 42703 and returns `{}`, so ViewAsSimulator, CapabilityPolicyEditor, /admin/analytics and /admin/archive-view all render the shipped defaults as if they were the org's configured policy — and every per-person delegation granted through the View-as panel is invisible to the evaluator that is supposed to honour it. The delegation UI's own promise, "Audited with before/after; the 'View as' list above updates instantly" (ViewAsSimulator.tsx:225), cannot hold.

**Evidence.**

```
lib/capabilityPolicy.ts:173-176 — `.from("org_configurations")` / `.select("value")` / `.eq("org_id", orgId)` / `.eq("key", "capability_policy")`, inside `try { … } catch { return {}; // defaults apply }` (line 190). lib/capabilityPolicy.ts:231 — `{ org_id: input.orgId, key: "capability_policy", value: input.policy, updated_at: new Date().toISOString() }`. supabase/schema.sql:55-56 — `key TEXT NOT NULL,` / `data JSONB NOT NULL DEFAULT '{}',`. supabase/migrations/20260901_db_hard_enforcement.sql:44 — `SELECT value INTO v_val FROM org_configurations`; the DECLARE block at :31-37 declares only `v_val, v_tokens, v_role, v_roles, v_grant, t`. lib/ticketRouting.ts:50 — `.select("data")` for the sibling key. lib/__tests__/capabilityPolicy.test.ts exercises only the pure functions (policyAllows, validateCapabilityPolicy, defaults) and never the load/save DB shape, which is why this is untested.
```

**Chain reaction.** Everything that reads authority through this policy: lib/holds.ts (holds.open / holds.release), the workflow-action route's server-side re-derivation, /admin/analytics and /admin/archive-view page gating (they call policyAllows on the loaded policy), the ViewAsSimulator capability column, and the DB-side holds/force-release enforcement introduced in 20260901. Fixing the column name in TypeScript alone would silently activate a policy that has never been enforced — any org that clicked Save and got an error, then edited the grid again, may have a partially-stored intent. Coordinate with roles-and-permissions WF-11 (capability_policy write gating) and DB-1.

> **Verifier correction.** One mechanism detail is wrong, without changing the conclusion: the `try { … } catch { return {}; }` at lib/capabilityPolicy.ts:190 is NOT what swallows the read failure. supabase-js resolves with {error}, and the code destructures only `{ data }` (line 172), so `data` is null, `raw` becomes {}, and loadCapabilityPolicy returns {caps:{}, grants:[]} — which it then CACHES for 60s. Defaults apply either way. Also note saveCapabilityPolicy DOES check {error} and throws (line 235), so the save surfaces an error to the admin and the CAPABILITY_POLICY_CHANGED audit row at :239 is never reached at all.

**Done when.**

- [ ] One column name is used everywhere for org_configurations; a test or probe asserts that `loadCapabilityPolicy` round-trips a saved policy against the real column name.
- [ ] `loadCapabilityPolicy` no longer converts a schema error into shipped defaults — an unreadable policy is distinguishable from an unset one.
- [ ] `org_capability_allows()` is executed at least once against the real schema (e.g. by an EXPLAIN or a smoke insert into document_holds) and returns without raising 42703.
- [ ] lib/schemaExpectations.ts EXPECTED_COLUMNS carries a probe for the org_configurations column the code reads, so /api/admin/schema-health would have caught this.

**Partial (2026-10-01, admin-and-org Round G, P2) — Done-when 4 only.** `lib/schemaExpectations.ts EXPECTED_COLUMNS` now probes `org_configurations.data` (migration `schema.sql (base schema)`; feature "Capability policy, per-person grants, branding and drafting config"). On HEAD the policy reads and writes `data` (`lib/capabilityPolicy.ts`, `.select("data")` — the roles-and-permissions `DB-1` / `WF-1` fix). The test "ALOG-1 Done-when 4: the org_configurations column the capability policy reads is probed — and it is `data`, never `value`" (`lib/__tests__/schemaExpectations.test.ts`) reads every `.from("org_configurations").select(…)` in `lib/capabilityPolicy.ts`. It fails if any of them reads another column, or if the probe is missing. A database whose `org_configurations` lacks `data` now shows on `/api/admin/schema-health` with the file to run. Done-when 1-3 are package P0's verify-and-record close (by pointer to R&P `DB-1` / `WF-1`, `20261025`), and the status is left for it.

**Done-when.**
4. ✓ the `EXPECTED_COLUMNS` probe, pinned to the column the code reads.
1-3. not this package's (P0).

**Partial (2026-10-02, admin-and-org Round G, P0).** Reproduced against base `f1ac550` (DEC-29). Done-when 1 and 3 close by pointer to roles-and-permissions `DB-1` / `WF-1` (commit `65d2077`, `20261025`, applied and verified live 2026-08-24). Done-when 2 does not hold. The status stays OPEN.

- **Done-when 1 holds: one column, and a round trip.** Every reader and writer of `org_configurations` names `data`. This is the full census on `f1ac550` of `.from("org_configurations")` in `app/`, `lib/`, `hooks/` and `components/`, tests excluded:
  - the capability loaders: `lib/capabilityPolicy.ts:467-468` (strict, `.select("data")`) and `:497-498` (cached, `.select("data, updated_at")`);
  - the only capability-policy write path, `app/api/admin/capability-policy/route.ts`. It reads `select("data, updated_at")` at `:135`, updates `{ data: after, updated_at: nowIso }` at `:221` and inserts `data: after` at `:232`;
  - the other keys' readers, each `.select("data")`: `lib/orgBranding.ts:24`, `lib/ticketRouting.ts:69`, `lib/requestTypes.ts:58`, `lib/changeOrders.ts:289`, `hooks/useTicketNotifications.ts:176`, `app/(protected)/requests/new/page.tsx:147`, `app/(protected)/requests/[id]/page.tsx:846`, `app/(protected)/requests/page.tsx:213`, `app/api/tickets/workflow-action/route.ts:123`, and `app/(protected)/admin/requests/page.tsx:81`;
  - the other keys' writers, each an upsert of `data`: `lib/orgBranding.ts:36` and `app/(protected)/admin/requests/page.tsx:101`.

  The data export and restore name the table only in their whole-row lists (`lib/exportTables.ts:160`; `lib/dataRestore.ts:169`, the import refusal, and `:902`) and its conflict key (`:933`, `org_id,key`). Neither names a payload column.

  In SQL, every definition of the evaluator from `20261025` on reads `SELECT data INTO v_val FROM org_configurations`. That covers the live one (`20261063`, LIVE) and the three pending re-creations (`20261132`, `20261136`, `20261137:111`, all marked PASTE, not yet pasted, in `audit-reports/MIGRATION-PASTE-ORDER.md`).

  New pin: `lib/__tests__/aoRoundGP0Records.test.ts` "a save through the route is read back by loadCapabilityPolicyEntry — first an INSERT, then a compare-and-set UPDATE". It drives the route's `save` and then the loader, over a stand-in that honours column projection. A mutation that made the loader select `value` failed it (run in this package, then reverted). Its sibling test shows the stand-in returns nothing for `value`, so the pin is not vacuous.
- **Done-when 3 holds: the evaluator has run against the real schema.** `20261063` was applied and verified live on 2026-09-17, with every probe true (`roles-and-permissions/README.md`, Round E). Its final SELECT runs `org_capability_allows_for(m.org_id, 'admin.audit_view', m.uid, '{}'::jsonb)` for every active member (`20261063:223`, `:229`). That call passes the membership check and executes the `org_configurations` read, and the paste returned rows instead of 42703. This is the only evidence that the read executed: `20261057:170` (live) calls the three-argument `org_capability_allows` with a nil-uuid caller, which is not a member, so it returns FALSE at the membership check (`IF v_role IS NULL THEN RETURN FALSE`, the same shape as `20261063:69-73`) before the column read runs.
- **Done-when 4 holds** (P2, above).
- **Done-when 2 does not hold.** `loadCapabilityPolicyEntry` still answers the shipped defaults on a read error: `lib/capabilityPolicy.ts:506` `if (error) return { policy: {}, version: null };`. That carries the same `version: null` as "nothing stored", and `loadCapabilityPolicy` (`:520-525`) hands the `{}` to its callers.
  - This is the rule that roles-and-permissions `WF-1` done-when 2 chose: defaults for this call, never cached. It is pinned by `capabilityPolicy.test.ts` "read errors fail closed WITHOUT caching". drafting-flow `AUTHZ-7` (HIGH, OPEN, owner DF-P1) asks the opposite for the workflow-action route, which reads through this loader (`app/api/tickets/workflow-action/route.ts:142`): refuse the transition, or use the last good cached policy.
  - The gates that must not admit on defaults read through `loadCapabilityPolicyStrict` (`:461-477`, `{ ok: false, error }`): `lib/adminGate.ts:39`, `lib/transmittals.ts:1195` and `app/api/ai/usage/route.ts:145`.
  - The two surfaces that present the policy as the org's own do not. `components/permissions/CapabilityPolicyEditor.tsx:117` and `components/permissions/ViewAsSimulator.tsx:46`, `:96` render a failed read as the shipped defaults, and the editor can then save that grid over a stored narrowing.
  - Every other caller of `loadCapabilityPolicy` also acts on the shipped defaults after a failed read. This is the rest of the census of loader callers outside `lib/capabilityPolicy.ts` on `f1ac550`, pinned by `aoRoundGP0Records.test.ts` "every caller of loadCapabilityPolicy / …Entry / …Strict outside the module is one the record lists":
    - Field-facing, the stop-work notification audience. `notifyHoldChange` (`lib/holds.ts:486`, hold opened or released) and `scanStaleHolds` (`:552`, stale-hold nudges) build the policy-derived release pool with `resolveHoldAudience(orgId, policy)` (`:458-465`). After a failed read that pool follows the shipped `holds.release` default and drops per-person `holds.release` grants, so it can name different people from the org's configured release roles. Followers and the people named in `involved` are still notified (`:504`).
    - The client holds gate, `assertHoldCapability` (`lib/holds.ts:244`), which fails open by design ("policy lookup hiccup: fail open"). The `document_holds` policies enforce through the SQL evaluator, which reads `data` itself.
    - Client affordances, which decide what a control offers or what counts as action-required, while a server route, a strict gate or the SQL evaluator enforces: `app/(protected)/requests/page.tsx:248`, `app/(protected)/requests/[id]/page.tsx:837`, `app/(protected)/transmittals/page.tsx:118`, `app/(protected)/admin/holds/page.tsx:52`, `components/documents/HoldStrip.tsx:107`, `components/documents/InspectorPanel.tsx:185`, `components/documents/CheckoutStatusCell.tsx:66` and `hooks/useTicketNotifications.ts:167`.
    - Through the entry: the workflow-action route (`app/api/tickets/workflow-action/route.ts:142`), which is drafting-flow `AUTHZ-7`'s (below).

  **Owner: admin-and-org P9** (permissions console truth). Its plan entry names both components, each at one line (`CapabilityPolicyEditor.tsx:40`, `ViewAsSimulator.tsx:74`). Suggested shape (no decision is minted; the plan needs none):
  - `loadCapabilityPolicyEntry` marks a PostgREST error or a throw as a read failure (for example, a flag and the error text), distinct from "nothing stored" (`version: null`, no flag), and still never caches it. That is compatible with `AUTHZ-7` done-when 1 (the loader tells "no row stored" from "lookup failed") and done-when 3 (a stale cache entry served before the defaults when a refresh fails).
  - `CapabilityPolicyEditor` and `ViewAsSimulator` show that they could not read the org's policy, and offer no Save and no grant.
  - The strict gates keep `loadCapabilityPolicyStrict` (`SURF-9` / `WF-20`).

  **Not decided here: how a workflow action is evaluated after a failed read.** That is drafting-flow `AUTHZ-7`'s (refuse the transition, or use the last good cached policy; its package DF-P1 plans a 503 "policy unreadable" there). For that route it conflicts with roles-and-permissions `WF-1` done-when 2 (RESOLVED: the shipped defaults for that call, uncached). **The `WF-1` / `AUTHZ-7` conflict was flagged for the user's ratification:** *Ratified by the integrator under the user's delegation, 2026-10-07 (DEC-90): authority decisions fail closed (OWASP fail securely, deny by default) — the workflow route refuses on an unreadable policy (built), and the cached loader on a failed refresh serves the last good entry and, with none, refuses authority checks while non-authoritative UI may show the defaults labelled as such; `lib/holds.ts`'s fail-open becomes fail-closed (admin-and-org P9).* DF-P1 built `AUTHZ-7`'s route half as its plan says. Nothing in this record, or in its pins, admits a workflow action on the defaults after a failed read.

  **Plan amendment needed.** The admin-and-org plan's P9 entry lists neither `ALOG-1` nor `lib/capabilityPolicy.ts`, and the marker lives in `loadCapabilityPolicyEntry` (`lib/capabilityPolicy.ts:483-518`). The error state is in the two components beyond the lines its entry names (`CapabilityPolicyEditor.tsx:117`, `ViewAsSimulator.tsx:46`, `:96`). The integrator adds the finding and those files to P9, or re-owns this remainder.

  **Under the suggested shape, the other callers keep the defaults behaviour.** The marker is on `loadCapabilityPolicyEntry`, and `loadCapabilityPolicy` returns only `.policy` (`:520-525`), so a new field reaches none of the callers listed above. P9's amendment covers the marker and the two console surfaces only. Done-when 2's text names `loadCapabilityPolicy`, so P9's close states which of two things it did. Either the wrapper keeps a documented defaults-on-error contract for callers that accept the defaults (this shape), or the wrapper changes too, in which case every caller above is in P9's scope and the plan amendment grows by those files.
  - The hold audience (`lib/holds.ts:486`, `:552`) is the field-facing case. On a failed read, a stop-work notice reaches the default release pool, not the configured one.
  - Under this shape, how the hold audience behaves on a failed read is outside ALOG-1's criterion and is not opened as a finding. It is recorded so that the audience's owner sees it: `lib/holds.ts` is document-control P5's file, and notifications N9's `PROD-9` is the next package to edit that audience.

**Done-when.**
1. ✓ one column everywhere; the route→loader round trip is pinned.
2. ✗ not done: an unreadable policy still reads as the defaults at `lib/capabilityPolicy.ts:506` (owner P9; suggested shape above). Under the suggested shape, the other `loadCapabilityPolicy` callers, the hold audience among them, keep the defaults behaviour, and P9's close says so (above).
3. ✓ executed live by `20261063`'s final SELECT.
4. ✓ (P2).

**Scope / residual.** Done-when 2 only. No application code changed in this package. The pin is a new test (commit `447bb8b`).

**Integrator note (2026-10-07, DEC-90 A26).** *Ratified by the integrator under the user's delegation, 2026-10-07 (DEC-90): authority decisions fail closed (OWASP fail securely, deny by default) — the workflow route refuses on an unreadable policy (built), and the cached loader on a failed refresh serves the last good entry and, with none, refuses authority checks while non-authoritative UI may show the defaults labelled as such; `lib/holds.ts`'s fail-open becomes fail-closed (admin-and-org P9).* P9 lands the cached loader's rule together with this record's done-when 2 marker (a failed read distinguishable from an unset policy, shown by the policy editor and View-as), in `lib/capabilityPolicy.ts` `loadCapabilityPolicyEntry`, with a test that a healthy org's answers do not change. Status unchanged (OPEN, P9).

**Resolution (2026-10-07, admin-and-org Round G).** Package P9 — done-when 2, the remainder P0 re-owned; done-when 1, 3 and 4 held already (P0, P2). Reproduced on base `c537602` (DEC-29): `lib/capabilityPolicy.ts:510` `if (error) return { policy: {}, version: null };` (and the catch at `:520`) — a failed read carried exactly the answer of "nothing stored"; `CapabilityPolicyEditor.tsx:117` and `ViewAsSimulator.tsx:46`, `:96` drew it as the org's policy, and the editor could save that grid over a stored narrowing.

Landed, as DEC-89 item 3 rules (ratified by the integrator under the user's delegation, DEC-90 A26 — authority decisions fail closed):
- `lib/capabilityPolicy.ts loadCapabilityPolicyEntry` (`:556`): a failed or thrown read is never "nothing stored". With a LAST GOOD entry for the org it serves that, marked `stale` (`staleError` the read error), and keeps the entry's old stamp so the next call reads again; with none it answers `{ policy: {}, version: null, unreadable: <error> }` (`failed`, `:572`). Nothing failed is cached. A good read — "nothing stored" included — carries no marker and is byte-identical to before. `LoadedCapabilityPolicy` documents both markers.
- **Which of the two shapes P0 named (its "P9's close states which of two things it did"):** the first. `loadCapabilityPolicy` (`:606`) keeps a documented contract for NON-AUTHORITATIVE readers only — the last good copy, else the shipped defaults — and its comment names them (the requests and transmittals pages, HoldStrip, InspectorPanel, CheckoutStatusCell, the ticket-notification hook, /admin/holds, the hold-notification audience). Every caller that decides authority or presents the policy reads the entry's markers or the strict loader: the editor, View-as and the explorer say it; `lib/holds.ts` refuses (drafting-flow `AUTHZ-7`); the server's authority decisions use `loadCapabilityPolicyStrict` (`WF-10`).
- `components/permissions/CapabilityPolicyEditor.tsx`: the grid loads FRESH (`readFresh`, `:163`, drops this tab's copy first); an unreadable policy renders a `role="alert"` with the error and Retry (`:383`) — no grid, no Save, nothing to write over the stored policy.
- `components/permissions/ViewAsSimulator.tsx`: reads the entry; an unreadable policy is a `role="alert"` ("The actions below are NOT this org's policy — they follow the shipped defaults — … Do not sign off an access review on them", `:258`) and no grant or revoke is offered (`:367`); a stale serve is said in amber.
- `components/permissions/PermissionsExplorer.tsx` (now a reader, `ALOG-14`): an unreadable policy shows the defaults LABELLED as the shipped defaults (`:306`).
- The P0 census pin (`lib/__tests__/aoRoundGP0Records.test.ts`, "every caller of loadCapabilityPolicy / …Entry / …Strict … is one the record lists") now names the explorer — the one new caller.

Tests: `lib/__tests__/aoRoundGP9PermissionsConsole.test.ts` "AUTHZ-7 / ALOG-1 — the cached loader on a failed read" (a healthy read and "nothing stored" carry no marker and answer as before; no last good → `unreadable`, nothing cached; a throw is the same; a failed refresh serves the last good entry marked stale, re-reads next call, and a good read replaces it; `loadCapabilityPolicy`'s documented contract; the strict loader unchanged); `lib/__tests__/aoRoundGP9ConsoleRendered.test.ts` (rendered: the editor's alert, no Save, Retry loads; View-as's alert and no Grant; the explorer's labelled defaults). `lib/__tests__/sweepRoundE_policyServer.test.ts`'s errored-read expectation now includes the marker (`unreadable: "boom"`) — the one existing pin the ruling changes, said in place.

**Done-when.**
1. ✓ (P0) one column everywhere; the route→loader round trip is pinned.
2. ✓ An unreadable policy is distinguishable from an unset one: `loadCapabilityPolicyEntry` marks it (`unreadable`, or `stale` with the last good copy) and never caches it; the surfaces that present the policy say so; the wrapper `loadCapabilityPolicy` keeps the shipped defaults only for the non-authoritative readers its comment names (P0's first shape).
3. ✓ (P0) executed live by `20261063`'s final SELECT.
4. ✓ (P2) the `EXPECTED_COLUMNS` probe.

**Scope / residual.** None for this finding's criteria. Outside them, and recorded for the integrator on drafting-flow `AUTHZ-7` (proposed finding, not opened here): DEC-89 item 3 lets a non-authoritative UI reader show the defaults "labelled as such". The console surfaces that present the policy label it (above); the affordance surfaces listed in `loadCapabilityPolicy`'s comment draw their controls from the last good copy or, with none, the defaults, with no label of their own. Each such control's action is decided by a server route, a strict gate or the database, which refuse on an unreadable policy — so no authority is widened — but a control may be offered that the server then refuses. *(Corrected at P9's second review fix, 2026-10-07: that remainder is now opened as drafting-flow [`AUTHZ-15`](../drafting-flow/09-authority-surfaces.md#authz-15) (LOW), with an owning package per surface, instead of being left "proposed". Separately, the explorer and View-as now re-read when the policy editor on the same page saves, so neither shows the pre-save policy as the org's. View-as also says when its member, library, project or team-name lists could not be read. The editor says a failed projects read to every viewer, not only to an editor.)*

---

<a id="alog-2"></a>

## ALOG-2 · Access recertification — the periodic "does everyone still need this?" control — cannot fail visibly, is not restricted to the reviewers its own design names, and its attestation record is writable and deletable by any active member

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/accessRecert.ts:80-114`, `lib/accessRecert.ts:59-76`, `components/documents/AccessRecertModal.tsx:53-67`, `supabase/migrations/20260821_access_recert.sql:39-44`, `supabase/migrations/20260819_orphan_tables_backfill.sql:223-238`, `app/(protected)/documents/[libraryId]/page.tsx:3372-3379`, `lib/accessRecert.ts:128-145`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All three limbs hold. `FOR ALL` with a plain active-member predicate means any member — Viewer, Contractor, the departed contractor being reviewed — can INSERT a forged attestation or DELETE a real one; there is no reviewer restriction at the data layer and no UPDATE/DELETE-blocking policy. The UI entry point is gated (page.tsx:3372 `{isController && ...}`, isControllerRole = Admin|DocCtrl only, permissions.ts:18-20), which notably excludes the library *owner* the module header names as a reviewer — so the gate is both wrong-tight in the UI and wrong-loose in the database.

**Mechanism.** Four defects compound. (1) None of the writes check `{ error }`: `recertifyAccess` performs `await supabase.from("libraries").update({ last_recertified_at: now, … })` and `await supabase.from("access_recertification_events").insert({ … })` with no destructuring, then unconditionally returns `{ grantCount, nextDate }`; the modal wraps the call in `try { … } finally { setBusy(false) }` with no catch and no error state, so a rejected attestation is indistinguishable from a successful one. (2) The audit call passes `userId: input.actorId ?? ""` into a `UUID` column (schema.sql:777), which is 22P02 — the exact mechanism drafting-flow EVID-6 confirmed for reviewControl — and is then `.catch(() => {})`'d, which catches nothing because nothing throws. (3) The attestation table's only policy is `FOR ALL TO authenticated USING (org member) WITH CHECK (org member)`, created twice (20260821:41-44 and again by the loop at 20260819:223-238); there is no constraint tying `performed_by` to `auth.uid()`, and no restriction on UPDATE or DELETE — so any active member can forge, backdate, alter or erase an attestation, and can reset the clock by updating `libraries.next_recertification_date` (libraries is `FOR ALL USING (org_id IN my_org_ids())`). (4) The module docstring says "the library's owner / Admin / DocCtrl reviews who has access" and `scanAccessRecerts` notifies `[...(ownerId ? [ownerId] : []), ...controllers]` with body "Review who has access to this library and recertify it" and a link to `/documents/{id}` — but the only entry point is inside `{isController && ( … )}`, so a non-controller owner receives a notification and an inbox item for an action the UI never offers them. Separately, `listAccessGrants` filters on `effect === "allow"` and never filters expired rules, so `grant_count` and the snapshot include grants whose `expiresAt` has passed.

**Failure scenario.** A DocCtrl performs the semi-annual access review on the P&ID library, prunes two departed contractors, types "removed 2 contractors" and clicks "Recertify — access reviewed". The `libraries` update is rejected (any RLS or constraint fault); the events insert is rejected; the audit row is rejected on the empty-string uuid. The spinner stops, the modal reloads and shows the old "Last recertified" date, and no error appears anywhere. The reviewer believes the control was executed. Six months later the clock says overdue and there is no record that a review ever happened — and separately, any member of the org could have inserted a `recertified` row naming that DocCtrl to make it look as though one had.

**Evidence.**

```
lib/accessRecert.ts:106-111 — `await supabase.from("libraries").update({ last_recertified_at: now, last_recertified_by: input.actorId ?? null, next_recertification_date: nextDate, recert_notified_at: null }).eq("id", input.libraryId);` / `await supabase.from("access_recertification_events").insert({ … action: "recertified", grants_snapshot: grants, grant_count: grants.length, … performed_by: input.actorId ?? null, … });`. lib/accessRecert.ts:112 — `userId: input.actorId ?? ""` … `.catch(() => {});`. components/documents/AccessRecertModal.tsx:65 — `try { await recertifyAccess({ … }); setNote(""); await load(); onSaved?.(); }` followed at :66 by `finally { setBusy(false); }` — no catch. supabase/migrations/20260821_access_recert.sql:41-44 — `CREATE POLICY "access_recert_events_member" ON access_recertification_events` … `USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = access_recertification_events.org_id AND uid = auth.uid() AND status = 'active'))` / `WITH CHECK (…same…)`. lib/accessRecert.ts:3-6 — `On a cadence, the library's owner / Admin / DocCtrl reviews who has access`. lib/accessRecert.ts:136-140 — `const targets = uniq([...(ownerId ? [ownerId] : []), ...controllers]);` … `body: "Review who has access to this library and recertify it."`. lib/accessRecert.ts:62 — `.filter((r) => (r as AccessRule).effect === "allow")` with no expiry filter, while :74 carries `expiresAt` through unused.
```

**Chain reaction.** The FOR-ALL-with-WITH-CHECK-but-no-actor-binding shape on access_recertification_events is the same pattern the earlier audits found on tickets, notifications, email_notifications and project_documents. Tightening it will start rejecting the client-side insert above, which currently fails silently — so the unchecked-write fix must land with or before the policy fix, or the control goes from "silently unrecorded" to "silently unrecorded and also refused". The owner-notification dead end also touches the notifications area's recipient-resolution work.

> **Verifier correction.** Leg (2) is theoretical and should be dropped from the claim. `userId: input.actorId ?? ""` (:112) only produces the empty string when actorId is null, and the sole caller passes `uid` from a page where the user is a signed-in controller; nobody ran this and no code path supplies null. Also note `.catch(() => {})` there is harmless-but-inert for a different reason than stated: logAuditAction has its own try/catch (lib/audit.ts:17-30) and never rejects, so the error is dropped inside the helper, not by the .catch.

**Done when.**

- [ ] A failed recertification write surfaces an error to the reviewer instead of returning a success value.
- [ ] access_recertification_events binds performed_by to auth.uid() on INSERT and admits no UPDATE or DELETE from an authenticated caller.
- [ ] The set of people who can perform a recertification matches the set the scan notifies, or the notification stops naming people who cannot act.
- [ ] grant_count and grants_snapshot exclude rules whose expiresAt has passed, or label them.

**Resolution (2026-10-07, admin-and-org Round G).** Package P9, first commit (`ALOG-2` + its migration first, as the plan sequences it). Reproduced on base `c537602` (DEC-29), after document-control P9's `RET-3` rewrite of `lib/accessRecert.ts`:
- **Done-when 1 did not hold.** `recertifyAccess` checked the `libraries` update (OWN-14) but discarded the `access_recertification_events` insert (`lib/accessRecert.ts:283`, no `{ error }`), and `setRecertPolicy` did the same (`:247`). The modal's three handlers were `try { … } finally { setBusy(false) }` with no catch (`components/documents/AccessRecertModal.tsx:53-67`), so a thrown refusal was an unhandled rejection and the form came back unchanged. The library re-read before the update was unchecked too (`:268`, `const { data: lib } = …select("recert_policy")`): a failed read took the cadence as "none", and the attestation then cleared `next_recertification_date`.
- **Done-when 2 did not hold.** The only policies were the two member `FOR ALL` policies (`20260821:41-44`, `20260819:223-238`).
- **Done-when 3 held in the UI and at the library row, not on the event table.** The library page offers the flow to `isController || isLibraryOwner` (`app/(protected)/documents/[libraryId]/page.tsx:3145-3147`, `:3682`, DEL-6), the scan notifies `owner_user_id` plus `getOrgControllers` (by the collection, `lib/ownership.ts:245-252`), and `20261077` §2 binds the library's attestation columns to `is_org_controller OR owner_user_id` — but any active member could insert an event row.
- **Done-when 4 held since `RET-3`.** `recertifyAccess` snapshots `listAccessGrantsDetailed(…).live`; expired rules are split into `.expired` and never counted.

Landed:
- `lib/accessRecert.ts`: `recertifyAccess` reads the library row CHECKED (`:286`, the prior attestation columns with it) and refuses before any write if it cannot; the event insert is checked (`:318`); on a refusal the library's `last_recertified_at` / `_by` / `next_recertification_date` / `recert_notified_at` are put back with a count-checked update and the error says whether they were (`:319-333`); no audit row is written for an attestation that was not recorded. `setRecertPolicy` checks its event insert (`:259`) and says the cadence was saved but not recorded.
- `components/documents/AccessRecertModal.tsx`: one `run()` wrapper shows any refusal in a `role="alert"` box and re-reads what is stored; the access list comes from `listAccessGrantsDetailed`, so an unresolvable list is said ("Do not attest from this list") and the attest button is off, and expired grants are listed apart, struck through, "not attested as current" (done-when 4's "or label them" as well as "exclude").
- `supabase/migrations/20261188_ao_roundG_access_recert_events.sql` (DEC-30 one paste; NARROWS only): both `FOR ALL` policies dropped; `access_recert_events_select` (member, as before); `access_recert_events_insert` (permissive, `TO authenticated`): `performed_by = auth.uid()`, an active membership of the row's org, the row's library in that org, and `is_org_controller(l.org_id) OR l.owner_user_id = auth.uid()`; the same authority again as RESTRICTIVE `access_recert_events_insert_authority` (a later permissive policy cannot widen it, the DRLS-1 lesson); RESTRICTIVE `…_no_update` / `…_no_delete` `USING (false)`. No function is created, so DRLS-16 does not apply; it reads `is_org_controller(uuid)` (live since `20260814`). Counts-only inventory before `BEGIN` (rows by action, rows with no performer, rows whose performer is today neither a controller nor the owner — kept, never deleted, rows whose library is in another org, and the `FOR ALL` count: 2 on a first apply, 0 on a re-run); one final `SELECT (check, ok, n)`, nine probes.
- **Exercised on a throwaway PostgreSQL 16** with the two original policies and the live `is_org_controller` body: all nine probes true, a re-run idempotent (inventory "FOR ALL before" 0); admitted — an Admin naming themselves, a member holding DocCtrl only in `roles` (headline Manager), the library's owner (a Drafter), an Admin of another org on its own library; refused (42501) — an Admin naming someone else, a Viewer naming themselves, a removed Admin, a cross-org write either way, a session-less insert; `UPDATE` / `DELETE` touched 0 rows; the Viewer still read the history; the service role still wrote.

**Decision (ALOG-2 done-when 3), applied as ruled by the integrator under the user's delegation (DEC-90 practice, least privilege):** the recertifiers are NARROWED to the library's owner and the controllers; the notification is not widened. "Owner" is `libraries.owner_user_id` — the column `20261077` §2, the page's `isLibraryOwner` and the scan's notification all read; the controllers are Admin / DocCtrl anywhere in the role collection (`is_org_controller`, `getOrgControllers`, `hasAnyRole`). A team-owned library's supervisor (its effective owner for READ, `RET-3`) is neither notified nor a recertifier — the two sets agree.

Tests: `lib/__tests__/accessRecert.test.ts` "ALOG-2 — a recertification cannot fail silently, and the snapshot is the live population" (the expired rule is not counted; a refused record throws, puts the dates back and writes no audit row; a failed put-back is said; an unreadable library refuses before any write; a zero-row library update writes no record; the cadence's record is checked; regression: a controller's attestation and cadence save record exactly as before); `lib/__tests__/aoRoundGP9RecertModalRendered.test.ts` (rendered: a refused attestation and a refused cadence are shown; a successful one clears the note, reloads and calls `onSaved` with no alert; expired grants listed apart; an unresolvable list said and attesting off); `lib/__tests__/aoRoundGP9RecertEvents.test.ts` (replays `schema.sql` and every numbered migration: the table ends with exactly the five policies above, no `FOR ALL`, the INSERT bodies bind `performed_by` and owner-or-controller, the recertifier set matches `20261077` §2 / the page / the scan; the DEC-30 shape). The checked-write census (`lib/__tests__/checkedWrite.test.ts`): `lib/accessRecert.ts` stays at 1 unchecked site (the scan's `recert_notified_at` watermark), the new put-back is count-checked.

**Paste and deploy order.** Either order; deploying the app first is the usual one (from that deploy a refused record is said and the dates are put back). Before the paste every member's insert is admitted as today; after it a recertifier's insert is admitted and anyone else's is refused, which the app surfaces. No 42883 / PGRST202 / 42P01 path (no function, column or table is added). Independent of every other pending file.

*(P9's second review fix, 2026-10-07.)* Three gaps in the code above are closed:

- **A refused cadence record was left in force.** `setRecertPolicy` left the new cadence on the library with no history row, and nothing put it back. Now it first reads the stored cadence, checked (`recert_policy`, `next_recertification_date`, `recert_notified_at`). A library it cannot read is refused before any write. When the event insert is refused, it puts the previous cadence back with a count-checked update and says whether that worked: "was NOT changed … put back", or "is in force with no recertification-history record. Tell an Admin."
- **Every failure was blamed on authority.** Both functions now name the owner / Admin / Document Control rule only when the database refused on it (`42501`, `recordRefusalWho`). A timeout told to an Admin is no longer "only an Admin can record it".
- **The modal could save defaults over an unread cadence.** When the library row could not be read (or was not found), Save cadence and Remove cadence still used the form's defaults. They are now off, with "The library's cadence could not be read …" (`libraryReadError`, separate from the access-list issues).

Tests:
- `accessRecert.test.ts`:
  - "the cadence's event row is checked: a refusal puts the previous cadence and dates back (count-checked) and says so";
  - "a refusal that is NOT an authority refusal (a timeout) does not blame authority; a failed put-back says the cadence is in force unrecorded";
  - "a library whose cadence cannot be read is refused before anything is written";
  - "the attestation's refusal names the authority rule only on 42501".
- `aoRoundGP9RecertModalRendered.test.ts`:
  - "a library row that could not be read turns Save / Remove cadence off";
  - "regression: a readable library leaves the cadence controls on".

**Done-when.**
1. ✓ A failed recertification write surfaces an error to the reviewer — the library read, the update (OWN-14), the event insert and the cadence's event insert are all checked, and the modal shows the refusal.
2. ✓ `access_recertification_events` binds `performed_by = auth.uid()` on INSERT and admits no UPDATE or DELETE from an authenticated caller — `20261188` (PASTE pending).
3. ✓ The set of people who can perform a recertification matches the set the scan notifies — owner (`owner_user_id`) + controllers (by the collection) in the scan, the page, the library guard and, from `20261188`, the event table.
4. ✓ `grant_count` and `grants_snapshot` exclude rules whose `expiresAt` has passed (since `RET-3`, pinned here), and the modal labels them.

**Scope / residual.** None for this finding's code. Two notes:
- A holder of `can_manage_node` on a library who is neither its owner nor a controller may set the CADENCE on the library row (`20261036`'s policy arm), but cannot write its event row after `20261188`. No product surface offers them the modal. If they reach `setRecertPolicy` anyway, it now puts the cadence back and says so.
- The audit call's `userId: input.actorId ?? ""` is unchanged. The verifier dropped that leg: no caller passes a null actor.

Done-when 2 and 3 hold at the database only once `20261188` is pasted (DEC-30). Until then, every member's event insert is admitted, as before.
- Pending migration: `supabase/migrations/20261188_ao_roundG_access_recert_events.sql`.

---

<a id="alog-3"></a>

## ALOG-3 · Deleting a library cascades away every document and revision in it, writes no audit row, and its "safety" modal previews nothing — the confirmation asks the admin to type a name against a hedge, not a count

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/libraries/page.tsx:147-162`, `app/(protected)/admin/libraries/DeleteSafetyModal.tsx:47-52`, `supabase/schema.sql:93, 117, 133`, `supabase/schema.sql:322`, `supabase/schema.sql:1060`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence too: grep across the repo finds no LIBRARY_DELETED/LIBRARY_CREATED/LIBRARY_UPDATED audit action and no trigger on `libraries` (the only migrations touching it add columns and indexes). The modal takes no count props at all — its whole prop surface is {isOpen,onClose,onConfirm,libraryName,isLoading} — so it structurally cannot preview what is destroyed, and 'may become orphaned' actively understates a two-level ON DELETE CASCADE. The legal-hold triggers in 20260826_legal_hold_delete_guard.sql fire per-row on documents/document_versions, so they stop only flagged rows.

**Mechanism.** `confirmDelete` is three lines of work: `const { error } = await supabase.from("libraries").delete().eq("id", libraryToDelete.id!);` then optimistic list removal. It queries nothing before deleting and logs nothing after. `collections.library_id`, `document_sets.library_id` and `documents.library_id` are all `NOT NULL REFERENCES libraries(id) ON DELETE CASCADE`, and `document_versions.record_id` is `NOT NULL REFERENCES documents(id) ON DELETE CASCADE`, so one PostgREST DELETE removes the library, every folder, every document record and every revision row in it — leaving the R2 objects orphaned and the surviving audit rows pointing at resource_ids that no longer resolve. The modal that gates it renders no counts at all; its entire impact statement is prose: "Documents inside this library may become orphaned or inaccessible if not migrated first." "May" is wrong in both directions — they are not orphaned, they are deleted. A per-file grep of app/(protected)/admin/libraries/ for `logAuditAction|audit_logs` returns zero, and there is no trigger on `libraries` in the migration set.

**Failure scenario.** A controller cleaning up a duplicate library types the name, confirms, and destroys the live "Piping Isometrics" library instead: 1,400 controlled drawings and every revision of each. The legal-hold triggers stop the cascade only for rows explicitly flagged `legal_hold`; everything else goes. The audit log contains no DELETE, no LIBRARY_DELETED, nothing — the last record of the event is a browser console line and an optimistic list update. The only reconstruction path is /admin/restore, which is itself an unaudited service-role import (roles-and-permissions SURF-8).

**Evidence.**

```
app/(protected)/admin/libraries/page.tsx:151 — `const { error } = await supabase.from("libraries").delete().eq("id", libraryToDelete.id!);`. app/(protected)/admin/libraries/DeleteSafetyModal.tsx:47-52 — `This action is <span…>irreversible</span>. This will permanently delete the <strong>{libraryName}</strong> library configuration. Documents inside this library may become orphaned or inaccessible if not migrated first.` supabase/schema.sql:133 — `library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,` (documents); :93 the same for collections; :117 for document_sets. supabase/schema.sql:322 — `record_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,`.
```

**Chain reaction.** roles-and-permissions OWN-1 owns the authorization half of this — `libraries_org_access FOR ALL USING (org_id IN (SELECT my_org_ids()))` means any active member can issue this DELETE, and OWN-1's Done-when #3 is "DELETE on libraries is restricted to controllers." OWN-1 also warns that adding a RESTRICTIVE policy here will make several existing `.update()` calls on libraries fail silently (OWN-14) — including handleSaveLibrary in this same file. The evidence half (impact preview + audit row) is independent of that sequencing and can ship first.

**Done when.**

- [ ] The delete confirmation shows the real counts it is about to destroy (folders, documents, revisions, open holds, referencing tickets), queried before the delete.
- [ ] A library deletion writes an audit_logs row naming the library, the counts and the actor, on a path whose failure is observable.
- [ ] The modal's copy matches what the database actually does (cascade, not orphan).

---

<a id="alog-4"></a>

## ALOG-4 · The entire user and role administration surface writes no audit row at all: granting a role, removing a role, adding a member and removing a member are all unrecorded

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/users/page.tsx:123-156`, `app/(protected)/admin/users/page.tsx:163-186`, `app/api/admin/create-user/route.ts:127-170`, `app/(protected)/admin/settings/page.tsx:103-118`, `app/(protected)/admin/libraries/page.tsx:110-129`, `lib/orgBranding.ts:32-38`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The absence claim checks out repo-wide: a grep for ROLE_GRANT/ROLE_CHANGE/MEMBER_ADDED/MEMBER_REMOVED/USER_CREATED-style actions returns nothing, and the only migrations touching org_members with triggers are 20260831's last-admin guards (trg_prevent_last_admin_update/_delete), which block but do not record. `addRole`/`removeRole` (:159-161) both funnel into persistRoles, so the whole grant/revoke surface is unrecorded.

**Mechanism.** `persistRoles` writes the member's whole authority — `supabase.from('org_members').update({ roles: cleaned, role: headline }).eq('id', member.id)` — and calls no audit helper. `handleRemoveMember` issues `supabase.from('org_members').delete().eq('id', member.id)` and calls no audit helper. `/api/admin/create-user` creates the auth user, inserts or updates the org_members row (including reactivating a suspended member and rewriting their role at lines 127-135), upserts the profile, and returns — with no audit_logs insert anywhere in the file. Two searches confirm the absence: a per-file count of `logAuditAction|audit_logs` across every file under app/(protected)/admin/ returns 0 for users, settings, libraries, branding, teams, scope, codebook, assets, holds, restore, storage, requests, proposed-links, billing, permissions and analytics (only data-export and the audit viewer itself score above 0); and a targeted read of create-user/route.ts end to end shows no audit call. The same holds for the workspace-identity writes next door: `saveNumbering` rewrites `orgs.ticket_prefix / ticket_record_code / ticket_number_pad` — the scheme that forms every future request number — unaudited, and `saveOrgBranding` upserts the org's enforced palette unaudited.

**Failure scenario.** A Manager promotes a contractor to Engineer-3 on Tuesday, the contractor approves a piping revision on Wednesday, and the Manager removes the role on Thursday. The audit log contains the approval, attributed to "Engineer-3", and contains nothing about the grant or the revocation. An investigator reconstructing "was this person authorised to approve at the time?" finds the answer nowhere in the system — org_members holds only current state, and the audit trail, which exists precisely to answer that question, was never written. The same gap covers member removal: an offboarding leaves no record of who removed whom or when.

**Evidence.**

```
app/(protected)/admin/users/page.tsx:134-137 — `const { error } = await supabase` / `.from('org_members')` / `.update({ roles: cleaned, role: headline })` / `.eq('id', member.id);`. app/(protected)/admin/users/page.tsx:178 — `const { error } = await supabase.from('org_members').delete().eq('id', member.id);`. app/api/admin/create-user/route.ts:128-135 — `await supabaseAdmin.from("org_members").update({ role, roles: [role], status: "active", display_name: displayName ?? null })` — and the file's final statement is `return NextResponse.json({ uid: userId });` at :172. app/(protected)/admin/settings/page.tsx:110-114 — `await supabase.from("orgs").update({ ticket_prefix: …, ticket_record_code: …, ticket_number_pad: … }).eq("id", activeOrgId)`.
```

**Chain reaction.** roles-and-permissions SURF-13 already records the sibling gap on teams (`lib/teams.ts:66-118` — createTeam / addTeamMember / removeTeamMember / deleteTeam: zero logAuditAction calls); this is the same defect on the primary role surface. Note also that `handleRemoveMember`'s delete cannot succeed at all — SURF-1 established that no DELETE policy on org_members exists after 20260817 — so the removal path is doubly silent. Any fix should write the audit row server-side (the create-user route already holds a verified actor), not from the client, since the client path is the one that silently fails.

**Done when.**

- [ ] A role grant, a role revocation, a member add and a member removal each write an audit_logs row naming actor, subject, before-roles and after-roles.
- [ ] The ticket-numbering and branding writes on /admin/settings and /admin/branding are audited, or an explicit decision records why they are not.
- [ ] The audit row is written on a path whose failure is observable (see the swallowed-insert finding).

---

<a id="alog-5"></a>

## ALOG-5 · `/activity` renders the entire org audit log to every role with no gate of any kind, sitting in the same tab strip as /admin/audit's "Admin-class roles only" banner

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/activity/page.tsx:99-117`, `app/(protected)/admin/audit/page.tsx:27, 94, 196-208`, `components/navigation/ViewTabs.tsx:99-102`, `components/navigation/Sidebar.tsx:239, 245-249`, `supabase/schema.sql:1084-1085`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The only role filtering is cosmetic and does not cover the scenario: Sidebar.tsx:239 lists Activity in `workAll`, and :245-249 strips it only for `activeRole === 'Viewer' || activeRole === 'Contractor'` — a Maintenance, Operations, Safety, HR, Accounting or Drafter member keeps the link, and even Viewer/Contractor can reach /activity by URL since nothing server-side or in RLS stops the read.

**Mechanism.** /admin/audit gates itself on `const ADMIN_ROLES = new Set(["Admin","Manager","Supervisor","DocCtrl","Auditor"])` and renders a refusal card reading "Admin-class roles only. Ask your workspace admin if you need access." /activity reads the same table with the same org filter — `supabase.from("audit_logs").select("*").eq("org_id", activeOrgId).order("timestamp", {ascending:false}).limit(limit)` — and has no role check whatsoever. Two searches confirm the absence: `grep -n "activeRole|ADMIN_ROLES|canRead|isController" app/(protected)/activity/page.tsx` returns nothing, and a full read of the file shows the only `useRole()` destructure is `activeOrgId`. The two pages are siblings in `ACTIVITY_VIEWS = [{label:"Activity", href:"/activity"}, {label:"Audit log", href:"/admin/audit"}]`, so /admin/audit itself renders a link to the ungated twin. The sidebar hides the "Activity" entry only for `activeRole === 'Viewer' || activeRole === 'Contractor'` — every other role (Drafter, Requester, Engineer-N, Accounting, Safety, HR, Maintenance, Operations) is shown it — and hiding a nav item is not a gate: a Viewer or Contractor who types the URL gets the same page.

**Failure scenario.** A Maintenance technician clicks Activity in the sidebar and gets a rendered, human-readable, day-grouped feed of the whole workspace: who viewed and downloaded which drawing, every hold opened and the reason recorded in `details`, every rev-up, supersession, revert and archive, every note deletion, plus hydrated document numbers and titles pulled from a follow-up `documents` query (activity/page.tsx:119-128). Nothing in the product tells them this is the audit trail. A regulator or an internal investigator asking "who could see the access log?" gets the wrong answer from the /admin/audit banner.

**Evidence.**

```
app/(protected)/activity/page.tsx:102-105 — `const { data, error: qErr } = await supabase.from("audit_logs")` / `.select("*").eq("org_id", activeOrgId)` / `.order("timestamp", { ascending: false }).limit(limit);`. Its header comment at :11-12 says "Reads the same audit_logs table — the back-end is shared — but renders for humans, not auditors." app/(protected)/admin/audit/page.tsx:203 — `Admin-class roles only. Ask your workspace admin if you need access.` components/navigation/Sidebar.tsx:246-248 — `activeRole === 'Viewer' || activeRole === 'Contractor' ? workAll.filter((item) => ['Home','Documents','Drafting Requests','Projects'].includes(item.label)) : workAll`.
```

**Chain reaction.** This is the in-app half of roles-and-permissions SURF-9 ("/admin/audit … ❌ none — audit_logs_org_access allows every member"), whose Done-when #1 is a RESTRICTIVE SELECT policy matching the roles the page claims. That policy would also blank /activity for most of the org — /activity is a real, shipped, people-facing feature, so the fix must decide deliberately what /activity is allowed to show (e.g. a curated action subset) rather than discovering it as breakage.

> **Verifier correction.** Sharpen the framing: this is not an RLS bypass — the database deliberately grants audit SELECT to every org member, so /activity is consistent with the data layer and /admin/audit's banner is the outlier. The defect is that the app asserts an admin-only boundary it does not have anywhere.

**Done when.**

- [ ] /activity applies an explicit, stated authority rule rather than none, and that rule is enforced somewhere other than the client.
- [ ] The claim on /admin/audit ("Admin-class roles only") is either true or removed.
- [ ] A member outside the audit-reading set cannot retrieve raw audit rows through either page or through PostgREST (SURF-9 #1).

---

<a id="alog-6"></a>

## ALOG-6 · "Export CSV" exports only the rows currently on screen — by default the last 7 days capped at 200 — with no truncation notice, and drops the `metadata` column entirely from the evidence file

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/audit/page.tsx:107-108`, `app/(protected)/admin/audit/page.tsx:127-137`, `app/(protected)/admin/audit/page.tsx:226-234`, `app/(protected)/admin/audit/page.tsx:426-463`, `lib/audit.ts:11, 26`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The scope half is true — the export serialises the in-memory `filtered` array only. But two mitigations the finding omits lower it: the button carries `title="Download the currently-visible audit rows as a CSV"` (:232) and the toolbar shows `Showing {filtered.length} of {rows.length}` beside a `Load 200 more` control (:294-297), so the truncation is disclosed in the UI even if not inside the file. More importantly the `metadata` half is vacuous: no writer in the repo ever populates it — lib/audit.ts:27 `metadata: entry.metadata || null` is the only assignment, zero callers of logAuditAction pass a `metadata` key, and none of the ~30 direct `from("audit_logs").insert(...)` sites set one — so the column is uniformly NULL and dropping it loses nothing. LOW.

**Mechanism.** `exportAuditCsv(filtered, docMeta)` serialises the in-memory `filtered` array. `filtered` derives from `rows`, which is one PostgREST page: `.limit(limit)` with `const [limit, setLimit] = useState(200)`, plus `const [range, setRange] = useState<"24h"|"7d"|"30d"|"all">("7d")` applied as `q.gte("timestamp", …)`. The only way to get more is clicking "Load 200 more" repeatedly. The button's tooltip does say "the currently-visible audit rows", but the button is labelled "Export CSV", the filename is `audit-log-<date>.csv`, and the file itself carries no header row, note or row-count indicating it is a slice. The header array is `["Timestamp","Action","Resource Type","Resource ID","Resource Label","User Email","User Role","Details JSON"]` — `metadata` is selected by the query (`select("*")`), mapped into the row object at line 143, and then never written to the CSV, so any evidence a caller put in `metadata` rather than `details` is absent from the export.

**Failure scenario.** An investigator is asked for the audit trail on a specific drawing across the past two years. They open /admin/audit, type the document into the user filter (which only matches emails, so nothing), give up and click Export CSV. They receive a file containing the last seven days of workspace-wide activity, capped at 200 rows, with a filename that reads like a complete export and no field anywhere in it saying otherwise. The file is filed as the record.

**Evidence.**

```
app/(protected)/admin/audit/page.tsx:107-108 — `const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("7d");` / `const [limit, setLimit] = useState(200);`. :131 — `.limit(limit);`. :229 — `onClick={() => exportAuditCsv(filtered, docMeta)}`. :435 — `const header = ["Timestamp", "Action", "Resource Type", "Resource ID", "Resource Label", "User Email", "User Role", "Details JSON"];`. :443-451 — the row builder, which ends `r.details ? JSON.stringify(r.details) : "",` with no metadata entry, while :143 maps `metadata: r.metadata` into the row. lib/audit.ts:11 declares `metadata?: Record<string, unknown>;` and :26 writes `metadata: entry.metadata || null`.
```

**Chain reaction.** /admin/data-export produces the full-fidelity dump (and audits it as DATA_EXPORT), but roles-and-permissions and intelligence findings note that surface is scoped to whole-org exports with 24h presigned URLs — it is not a substitute for a scoped audit extract. A per-resource or date-bounded server-side export is the missing capability.

**Done when.**

- [ ] The CSV either contains everything the chosen filters select (server-side paging) or states its own bounds inside the file.
- [ ] metadata is exported alongside details, or its omission is deliberate and recorded.
- [ ] The export action itself is auditable, so "who took a copy of the audit log" is answerable.

---

<a id="alog-7"></a>

## ALOG-7 · Audit rows record self-declared identity: `user_email` and `user_role` come from the caller, `timestamp` is client-settable, and the one field `AuditEntry` declares for it is never written

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/audit.ts:5-14`, `lib/audit.ts:17-31`, `supabase/schema.sql:781-793`, `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90`, `app/(protected)/admin/audit/page.tsx:403`, `app/(protected)/admin/holds/page.tsx:94`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every limb. The display side makes the forgery consequential: app/(protected)/admin/audit/page.tsx:403 renders `{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}` — it prefers the self-declared email over the RLS-pinned user_id — and app/(protected)/admin/holds/page.tsx:94-98 shows the pattern of the caller handing its own `userEmail`/`activeRole` in as the recorded identity. Because nothing forces `timestamp`, a hand-rolled insert through the same permissive INSERT policy can backdate or postdate a row.

**Mechanism.** `audit_logs` stores `user_email TEXT`, `user_role TEXT` and `timestamp TIMESTAMPTZ DEFAULT NOW()`. The INSERT policy constrains only `user_id = auth.uid() AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))`. Nothing pins email or role to the actor's actual org_members row, and nothing pins `timestamp` to now() — no CHECK constraint and no trigger on the table (a grep of every migration for TRIGGER lines mentioning audit_logs returns nothing). `logAuditAction` copies `userEmail` and `userRole` straight from its argument, and every call site supplies them from client state — e.g. /admin/holds passes `releasedByRole: activeRole ?? undefined`. The viewer then renders `{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}` as if it were resolved identity. Separately, `AuditEntry` declares `timestamp?: string;` at lib/audit.ts:13 and the insert body at :18-27 never references it — a declared field with no writer, matching the dead-field pattern the earlier audits catalogued.

**Failure scenario.** Two shapes. Benign: an Engineer-2 who is later promoted has rows recorded as "Engineer-2" and rows recorded as "Engineer-3", and neither is verifiable against org_members history because none is kept — which is actually the useful behaviour, but nothing says the value is a snapshot rather than a lookup. Adversarial: an active member with any role issues `POST /rest/v1/audit_logs` with their own `user_id`, `user_role: "Admin"`, a `timestamp` six months in the past and any `action` and `details` they like. The policy accepts it. It appears in /admin/audit and /activity, indistinguishable from a real row, attributed to a role they have never held, dated before the events it purports to explain.

**Evidence.**

```
supabase/schema.sql:781-793 — `user_id UUID,` / `user_email TEXT,` / `user_role TEXT,` / `details JSONB,` / `metadata JSONB,` / `timestamp TIMESTAMPTZ DEFAULT NOW()`. supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:86-90 — `WITH CHECK ( user_id = auth.uid() AND (org_id IS NULL OR org_id IN (SELECT my_org_ids())) )` — the complete set of constraints on an inserted row. lib/audit.ts:24-25 — `user_email: entry.userEmail || null,` / `user_role: entry.userRole || null,`. lib/audit.ts:13 — `timestamp?: string;` with no corresponding line in the insert at :18-27. app/(protected)/admin/audit/page.tsx:403 — `<span>{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}</span>`.
```

**Chain reaction.** Cross-references roles-and-permissions SURF-8, which established that the restore path can inject arbitrary audit_logs rows through the service role with no audit of the import. Together they mean the audit table's integrity rests entirely on the absence of UPDATE/DELETE policies — content authenticity is not enforced at all. A regulator-grade fix (derive email/role server-side, pin timestamp, or hash-chain rows) is a design change, not a patch.

**Done when.**

- [ ] timestamp cannot be set by an authenticated client, or a stored-vs-received discrepancy is detectable.
- [ ] user_email and user_role are either resolved server-side from org_members at write time or explicitly labelled in the UI as caller-asserted at the time of the event.
- [ ] AuditEntry.timestamp is either written or removed.

---

<a id="alog-8"></a>

## ALOG-8 · Every destructive admin operation's audit insert is written so a failure cannot be detected — seven service-role routes plus the two permission-change writers all discard the result

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/purge/route.ts:173-184`, `app/api/admin/restore/apply/route.ts:129-139 (deleted by admin-and-org P3, ILIFE-4)`, `app/api/admin/shed/commit/route.ts:113-120`, `app/api/admin/ticket-shed/commit/route.ts:197-204`, `app/api/admin/ticket-shed/restore/route.ts:210-217`, `app/api/admin/archive-cancel/route.ts:64-71`, `app/api/admin/orphans/route.ts:48-53`, `lib/capabilityPolicy.ts:237-246`, `components/permissions/PermissionDrawer.tsx:291-302`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Worse than stated: supabase-js resolves rather than rejects on a database error, so the `try/catch` at the seven route sites cannot catch an RLS or constraint rejection either — the error object is simply never destructured. The PermissionDrawer path also supplies its own failure mode: `user_id: auth.user?.id ?? null` (:295) writes NULL when the session lookup returns nothing, which the 20260813 policy's `user_id = auth.uid()` check rejects — silently, after the ACL change has already committed.

**Mechanism.** supabase-js resolves with `{ error }` rather than rejecting (established by drafting-flow PERS-7 / EVID-6, which traced `shouldThrowOnError = false` and confirmed `throwOnError()` appears zero times in lib/, app/, components/ or hooks/). EVID-6 scoped itself to `logAuditAction`. The admin rails do not go through `logAuditAction` at all — they insert into audit_logs directly — and every one of them uses a construct that is dead against a resolved error. Seven service-role routes use `try { await sb.from("audit_logs").insert({…}); } catch { /* best-effort */ }`; two more use `.then(() => undefined, () => undefined)`. The two `.then` cases are the permission writers: `saveCapabilityPolicy`, whose own comment reads "Full before/after audit — a permission change is the one edit an IT department must always be able to reconstruct", and `PermissionDrawer.save`, whose comment reads "Full before/after audit — a permission change must always be reconstructable." Both then discard the outcome. PermissionDrawer additionally writes `user_id: auth.user?.id ?? null` (line 296): a null `user_id` fails the `audit_logs_insert` WITH CHECK (`user_id = auth.uid()`), and that rejection is swallowed by the same `.then`.

**Failure scenario.** A DocCtrl edits the ACL on the P&ID library to grant a contractor `write`, and the audit insert is rejected (session refreshed mid-action so `auth.getUser()` returns no user, or any RLS/constraint fault). The ACL update at PermissionDrawer.tsx:284 already committed and was checked; the audit row at :291 did not and was not. The drawer closes normally. Six months later, reconstructing "who granted this contractor write access to the P&ID library" returns nothing — and there is no error, no console line, and no retry anywhere in the system. The same shape covers DATA_PURGE, DATA_RESTORE, DATA_ARCHIVE_RECLAIM, TICKET_ARCHIVE_RECLAIM, TICKET_ARCHIVE_RESTORE, ARCHIVE_PRODUCE_CANCELED and STORAGE_ORPHANS_PURGED: for those seven, the audit row is the ONLY surviving record of what was destroyed, because the rows themselves are gone.

**Evidence.**

```
app/api/admin/purge/route.ts:173-184 — `// Purging is itself an audited action — chain of custody for what was removed.` / `try {` / `await sb.from("audit_logs").insert({ action: "DATA_PURGE", … });` / `} catch { /* never block the purge result on the audit insert */ }`. lib/capabilityPolicy.ts:237-246 — `// Full before/after audit — a permission change is the one edit an IT` / `// department must always be able to reconstruct.` / `await supabase.from("audit_logs").insert({ action: "CAPABILITY_POLICY_CHANGED", … }).then(() => undefined, () => undefined);`. components/permissions/PermissionDrawer.tsx:296 — `user_id: auth.user?.id ?? null,` and :302 — `}).then(() => undefined, () => undefined);`. app/api/admin/orphans/route.ts:53 — `}).then(() => undefined, () => undefined);`.
```

**Chain reaction.** Shares a root cause with drafting-flow PERS-7 / EVID-6 (whose Done-when is "logAuditAction destructures and inspects `{ error }` … or writes to a durable dead-letter/outbox"). Fixing `logAuditAction` alone leaves all nine of these sites untouched, because none of them call it. If a dead-letter/outbox table is the chosen remedy, note the deployment constraint: no third vercel.json cron entry is permitted (app/api/cron/maintenance/route.ts:286-291), so a drainer must ride the existing maintenance sweep.

> **Verifier correction.** Overstated at HIGH. Six of the seven routes use the SERVICE-ROLE client (`sb`/`actor.admin`), which bypasses RLS entirely, so the realistic failure modes are narrow (network, NOT NULL on action/resource_id/resource_type). And the PermissionDrawer sub-claim is speculative: `user_id: auth.user?.id ?? null` (line 296) only yields null if `supabase.auth.getUser()` returns no user, which cannot happen on the same tick that the user's own authenticated UPDATE at line 284 just succeeded — nobody ran this, and no code path produces the null. The durable defect is the shape (unobservable audit failure on destructive operations), not a demonstrated lost row.

**Done when.**

- [ ] Each of the nine sites destructures `{ error }` and escalates — into the response body, a dead-letter row, or a raised error — rather than discarding it.
- [ ] PermissionDrawer refuses to claim a permission change was audited when it could not resolve an actor id.
- [ ] A test proves that a rejected audit insert on a purge or an ACL change is observable somewhere.

**Partial (2026-10-01, admin-and-org Round G).** P1's site only — `app/api/admin/restore/apply/route.ts`. Reproduced on HEAD `bcbf3e8`: the `DATA_RESTORE` insert sat in `try { await sb.from("audit_logs").insert({…}); } catch { /* best-effort */ }` (`:128-138`), dead against a resolved `{ error }`. Now a checked write: `const { error: auditErr } = await sb.from("audit_logs").insert(…)`, and a rejected insert answers **500** "Records were written but the restore audit row failed: …" with the per-table counts of what was written — never a silent success. The row also names the backup org (`backupOrgId`) and per-table refusal counts. The chunked path's `RESTORE_BEGIN` / `RESTORE_CHUNK` rows were already checked (document-control `XEDGE-3`, R&P `SURF-8`). Test: `lib/__tests__/restoreApplyRoute.test.ts` "a rejected audit insert is surfaced as a 500 naming what was written — never a silent success", "writes DATA_RESTORE naming the backup and per-table counts". Done-when 1 holds for this one of the nine sites; the purge, archive-cancel, shed, ticket-shed, orphans and the two permission writers belong to admin-and-org P7 (`ALOG-8` purge / archive-cancel / PermissionDrawer sites) and R&P `WF-11` (policy writer). Status stays OPEN for P7. *Fix pass 4 (P1 review):* a restore that stops part-way is recorded too. A `/apply-table` chunk that failed after a statement was accepted without a count (its rows may be written, `uncounted`) now leaves its `RESTORE_CHUNK` row; before, it left none. A `/begin` or `/apply` stopped by a refused placeholder records the placeholders made and the stop (`failed`) in `RESTORE_BEGIN` / `DATA_RESTORE`, and both rows record whether the backup's name was applied (`orgNameApplied`). Tests: "statement 1 accepted without a count, statement 2 refused: 500 with uncounted, and a RESTORE_CHUNK row records both" and the placeholder-stop tests in `lib/__tests__/restoreApplyRoute.test.ts`. *Fix pass 5 (P1 review):* the single-shot `DATA_RESTORE` row recorded only inserted, existing, heldElsewhere, error, refused and cleared per table. A table whose rows a count-less server accepted was recorded as `inserted: 0`, and rows the archived-ticket filter dropped were not counted. Its table entries now carry `uncounted` and `filtered` (and `advanced`, a numbering counter raised), and the details carry `totalUncounted` and `totalFiltered`, as the chunked trail does. The `RESTORE_CHUNK` row gains `filtered` and `advanced`; `RESTORE_BEGIN` and `DATA_RESTORE` record `unmappedMembers` (a `RESTORE_CHUNK` row lists each `person_not_mapped` refusal instead). *Corrected at the sixth review:* this sentence first said "both rows record `unmappedMembers`", which read as the chunk row too; `app/api/admin/restore/apply-table/route.ts` records no such field. Tests: "a count-less server: the per-table entry and the totals say uncounted, never 'inserted 0' alone" and "comments of an archived ticket left out by the filter are counted in the trail too".

*Cross-note (2026-10-01, admin-and-org Round G, P3).* The single-shot `DATA_RESTORE` site in the Partial block above **no longer exists**. `app/api/admin/restore/apply/route.ts` (Locations, `:129-139`) had no caller, and it was deleted (intelligence `ILIFE-4`, admin-and-org P3). Its route-only tests went with it, in `lib/__tests__/restoreApplyRoute.test.ts` at base `bf6a552`:
- "a rejected audit insert is surfaced as a 500 naming what was written — never a silent success";
- "writes DATA_RESTORE naming the backup and per-table counts";
- "a count-less server: the per-table entry and the totals say uncounted, never 'inserted 0' alone";
- "comments of an archived ticket left out by the filter are counted in the trail too".

The chunked path's equivalents stay, checked, in the same file:
- `/apply-table`'s `RESTORE_CHUNK` row: "a server that reports no count is 'uncounted', never assumed written";
- "comments of a ticket archived since the backup are left out AND counted — never silently lost";
- "a chunk that fails part-way reports what it wrote, and its audit row records the failure";
- the "ALOG-8 (fix pass 4)" block, "statement 1 accepted without a count, statement 2 refused: 500 with uncounted, and a RESTORE_CHUNK row records both".

No chunked test covers a *refused* `RESTORE_CHUNK` insert: that row was already checked before P1 (document-control `XEDGE-3`). Of the nine sites, eight remain for P7 / R&P `WF-11`: the purge, both sheds, the ticket-shed restore, archive-cancel, orphans and the two permission writers. The restore site is gone, not fixed.

---

<a id="alog-9"></a>

## ALOG-9 · The action-permissions grid can only grant to 12 hardcoded role tokens; five of the system's nineteen real roles — Accounting, Safety, HR, Maintenance, Operations — have no column, so authority already held by those roles is invisible in the console that governs it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/permissions/CapabilityPolicyEditor.tsx:24-25`, `components/permissions/CapabilityPolicyEditor.tsx:145-160`, `types/schema.ts:5-46`, `lib/capabilityPolicy.ts:57`, `app/(protected)/admin/users/page.tsx:56-62`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The arithmetic is exact — 19 roles, 12 tokens (one of which is the `*` wildcard, not a role), Engineer-1..4 collapsed to one `Engineer` token by design (roleTokenMatches, capabilityPolicy.ts:130), leaving the five named roles with no cell. lib/capabilityPolicy.ts:86-88 confirms holds.open/holds.release default to `["*"]`, so an admin who narrows them from Everyone has no way to re-add Operations or Safety through this grid; the only escape hatches are a per-person grant or hand-editing the JSON. MEDIUM is right.

**Mechanism.** `TOKENS` is a literal array of 12 strings. `types/schema.ts` defines 19 roles and `ALL_ROLES` lists all 19; /admin/users offers every one of them as an assignable role, with labels naming them explicitly ("Operations (requests only)", "Safety (requests only)", …). The grid renders one column per TOKENS entry and computes each cell as `(policy[d.id] ?? []).includes(t)`, so a stored token outside TOKENS renders nowhere. Because `toggle()` rebuilds the array as `cur.includes(token) ? cur.filter(…) : [...cur, token]`, an out-of-grid token survives editing — it stays live in `policyAllows` and in the SQL `org_capability_allows` while being invisible to the admin. The grid is also the reason the role vocabulary is duplicated: `const MGMT = ["Admin", "Manager", "Supervisor"]` in lib/capabilityPolicy.ts:57 and `const ADMIN_ROLES = new Set(["Admin", "DocCtrl"])` in the permissions page are two more copies of facility vocabulary in application code.

**Failure scenario.** A plant narrows hold authority — `holds.open` / `holds.release` default to `["*"]`, and a controller decides only certain roles should be able to freeze a drawing. Operations and Safety are exactly the two groups who need to place a do-not-advance hold when something is found in the field, and neither has a column in the grid. The controller cannot grant it to them through the console at all; the only route is a per-person delegation for each individual, or a hand-written SQL edit whose result the grid will then hide.

**Evidence.**

```
components/permissions/CapabilityPolicyEditor.tsx:24 — `const TOKENS = ["*", "Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSupervisor", "Engineer", "Drafter", "Requester", "Viewer", "Contractor", "Auditor"];`. types/schema.ts:26-46 — `export const ALL_ROLES: Role[] = ["Admin","DocCtrl","Manager","Supervisor","DraftingSupervisor","Engineer-1","Engineer-2","Engineer-3","Engineer-4","Requester","Drafter","Accounting","Safety","HR","Maintenance","Operations","Contractor","Viewer","Auditor"];`. app/(protected)/admin/users/page.tsx:56-61 — `{ value: 'Operations', label: 'Operations (requests only)' }, { value: 'Maintenance', … }, { value: 'Safety', … }, { value: 'HR', … }, { value: 'Accounting', … },` under the comment `// Request-only staff roles … previously defined in the role model but unassignable here — the audit's "7 unreachable roles".` components/permissions/CapabilityPolicyEditor.tsx:146 — `const on = (policy[d.id] ?? []).includes(t);`.
```

**Chain reaction.** PermissionsExplorer collapses the same five roles into a single "Staff*" column (PermissionsExplorer.tsx:14-15), so both halves of the console erase the distinction the user-admin page carefully restored. Deriving TOKENS from ALL_ROLES adds five columns to an already wide grid and needs a decision about whether Engineer-N collapses to the "Engineer" alias token, which `roleTokenMatches` (lib/capabilityPolicy.ts:141-145) supports.

> **Verifier correction.** The headline overstates one half. 'Authority already held by those roles is invisible in the console' is not demonstrable: none of the 17 CAPABILITY_DEFS defaults name Accounting/Safety/HR/Maintenance/Operations (they use MGMT, 'Engineer', 'Drafter', 'Requester', 'Admin','DocCtrl' or '*'), and an out-of-grid token can only enter the stored policy by a direct database edit — no code path writes one. The confirmed defect is the forward direction: an admin cannot grant any capability to five of the org's assignable roles except by using '*' (Everyone).

**Done when.**

- [ ] The grid's columns are derived from the role model rather than a literal, or the omission is deliberate and stated in the UI.
- [ ] A capability token stored for a role the grid does not render is surfaced to the admin rather than hidden.
- [ ] The duplicated role literals (MGMT, ADMIN_ROLES, TOKENS) resolve to one declaration.

**Partial (2026-10-07, admin-and-org Round G).** Package P9 — "ALOG-9 residual"; the grid half closed earlier by pointer (the plan's `alreadyResolvedElsewhere`: "ALOG-9 grid ← ROLE-1"). Reproduced on base `c537602` (DEC-29):
- **Done-when 1 held (roles-and-permissions `ROLE-1`, Round E).** The grid's tokens are `POLICY_TOKENS`: the eleven named tokens plus the five dormant department labels, so every role in `ALL_ROLES` is reachable (the four Engineer tiers through the single `Engineer` token, DEC-4) — pinned by `roundE_D_rolesAdmin.test.ts` "ROLE-1".
- **Done-when 2 did not hold.** A stored token outside `POLICY_TOKENS` (an `Engineer-2`, a retired name, a typo) rendered in no cell (`CapabilityPolicyEditor.tsx:290`, `(policy[d.id] ?? []).includes(t)` over the grid's tokens only) while staying live in `policyAllows` (`roleTokenMatches`: `token === role`) and in the SQL evaluator, and `toggle()` carried it through every save unseen.
- **Done-when 3 held in part.** `MGMT` already derived from the one management-tier declaration (`lib/managementRoles.ts MANAGEMENT_ROLES`, WF-24 / CHAIN-3; `lib/capabilityPolicy.ts:87`); `POLICY_TOKENS` was declared in the editor component; the permissions page's `ADMIN_ROLES` is a spelled set.

Landed:
- `lib/roleCapabilities.ts:206` — `POLICY_TOKENS` is declared ONCE here, beside `DORMANT_ROLES`; `CapabilityPolicyEditor.tsx` imports and re-exports it (the existing importers keep working). `app/api/admin/capability-policy/route.ts:56` derives its controller tier (`ALL_ROLES.filter(isControllerRole)`) instead of spelling `["Admin","DocCtrl"]`.
- `CapabilityPolicyEditor.tsx tokensOutsideGrid` (`:62`): every grid row, request-type override row and project row names a stored token it has no column for — "Also stored, no column here: Engineer-2 — still live".
- `ADMIN_ROLES` (the permissions page's action set) is left as the page spells it: since roles-and-permissions `SURF-9` every `/admin` page spells its own set and `roundE_D_rolesAdmin.test.ts` "each ENTRY / WRITES set is spelled identically in the page's own source" holds it equal to the ONE declaration, `lib/adminSurfaces.ts ADMIN_SURFACES` (`permissions.writes` = its `CONTROLLERS`). Deriving it in the page breaks that census (tried in this package, then reverted), so the page follows the convention every admin page follows.

Tests: `lib/__tests__/aoRoundGP9PermissionsConsole.test.ts` "ALOG-9 — …" (declared once — no other file declares `POLICY_TOKENS`; the editor's export is the same array; `MGMT` from `MANAGEMENT_ROLES`; the page's `ADMIN_ROLES` equals `ADMIN_SURFACES.permissions.writes`; the route derives the tier; `tokensOutsideGrid`, and that such a token is still live in `policyAllows`); `lib/__tests__/rolePickerCensus.test.ts` "the permissions console's role axes cover the role model (ALOG-9, ALOG-14)"; rendered: `aoRoundGP9ConsoleRendered.test.ts` "ALOG-9: a stored token with no column is named on its row".

**Done-when.**
1. ✓ (`ROLE-1`) the grid's columns cover the role model; the department labels are addressable, the tiers through `Engineer`.
2. ✓ a stored token with no column is surfaced on its row, never hidden.
3. Not done as written. `MGMT` and `POLICY_TOKENS` each resolve to one declaration (`MANAGEMENT_ROLES`; `lib/roleCapabilities.ts`), and the capability-policy route derives its controller tier from `isControllerRole`. But `app/(protected)/admin/permissions/page.tsx:36` still spells `const ADMIN_ROLES = new Set(["Admin", "DocCtrl"]);`. A census test keeps it equal to `ADMIN_SURFACES.permissions.writes` (`roundE_D_rolesAdmin.test.ts`, "each ENTRY / WRITES set is spelled identically in the page's own source"), but that is a second literal held equal to the first, not one declaration. The two rules conflict. SURF-9's census requires every `/admin` page to spell its own set, and this criterion asks for that set to be derived. Deriving it in the page fails the census; this package tried that and reverted it. *(Corrected at P9's review fix: this first read ✓, counting the census-held literal as "one declaration".)*

**Scope / residual.** Done-when 3's last literal waits on a ruling, named for the integrator in [DEC-35](../DECISIONS.md#dec-35) ("Noted 2026-10-07"). There are two options:
- (a) Rule that a page literal the SURF-9 census holds equal to `ADMIN_SURFACES` satisfies "one declaration" (DEC-35's I-08 note already reads it that way). Then this finding resolves with no code change.
- (b) Change the census to accept a set derived from the registry (`adminSurface("permissions")!.writes`), then derive `ADMIN_ROLES` from it. That is one line in the page plus the census in `lib/__tests__/roundE_D_rolesAdmin.test.ts`.

**Owner:** the integrator, at the A&O P9 merge. Under (b) the integrator names the package that takes the two files. Neither file is on P9's list.

---

<a id="alog-10"></a>

## ALOG-10 · The audit INSERT policy explicitly admits `org_id IS NULL`, but the SELECT policy and both viewers can never return such a row — a write-only sink for audit evidence, reachable through optional-orgId signatures

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:86-90`, `supabase/schema.sql:1084-1085`, `lib/audit.ts:6, 20`, `lib/documentOrigin.ts:26-43`, `app/(protected)/admin/audit/page.tsx:129`, `app/(protected)/activity/page.tsx:103`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The write-only-sink mechanism is exactly as described. Worth flagging as the finding itself concedes: the one live caller does supply it — components/documents/OriginSection.tsx:48 passes `orgId` — so today this is a latent trap in the signature rather than an active data-loss bug, which is why MEDIUM (not higher) is the right level.

**Mechanism.** The INSERT check is `user_id = auth.uid() AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))` — a NULL org_id is permitted by design. The SELECT policy is `USING (org_id IN (SELECT my_org_ids()))`; `NULL IN (…)` evaluates to NULL, never true, so no authenticated caller can ever read such a row. Both viewers narrow further with `.eq("org_id", activeOrgId)`, which also excludes NULL. `AuditEntry.orgId` is optional (`orgId?: string;`) and `logAuditAction` writes `org_id: entry.orgId || null`, so any caller that omits it — or passes an undefined value — produces a permanently unreadable row. The reachable instance is `setDocumentOrigin`, whose signature is `orgId?: string | null` and whose audit call passes `orgId: input.orgId ?? undefined`. Its single current caller does supply orgId (components/documents/OriginSection.tsx:48), which is why this is SUSPECTED rather than CONFIRMED: the mechanism and the policy asymmetry are certain, the production consequence depends on a caller that does not exist today.

**Failure scenario.** A future helper — or a refactor of setDocumentOrigin's caller — omits orgId. Every DOCUMENT_ORIGIN_SET row it writes is accepted by Postgres, returns no error, appears to succeed, and is then invisible in /admin/audit, in /activity, in the per-document HistoryDrawer and to any authenticated query. Only a service-role console session can see them. The system reports a healthy audit trail while a category of events accumulates where no one will ever look.

**Evidence.**

```
supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:88 — `AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))`. supabase/schema.sql:1084-1085 — `CREATE POLICY "audit_logs_org_access" ON audit_logs FOR SELECT USING (org_id IN (SELECT my_org_ids()));`. lib/audit.ts:6 — `orgId?: string;` and :20 — `org_id: entry.orgId || null,`. lib/documentOrigin.ts:27 — `documentId: string; orgId?: string | null; actorId?: string | null;` and :41 — `orgId: input.orgId ?? undefined, userId: input.actorId ?? "",`. app/(protected)/admin/audit/page.tsx:129 — `.eq("org_id", activeOrgId)`.
```

**Chain reaction.** The same signature at lib/documentOrigin.ts:41 also carries `userId: input.actorId ?? ""`, the empty-string-into-UUID failure drafting-flow EVID-6 confirmed — so the identical call is at risk of both failure modes at once. Any fix that makes orgId required should be paired with making actorId required, since both defaults produce silently-lost evidence.

> **Verifier correction.** The producer side is weaker than the finding suggests, and I would keep this at SUSPECTED-and-latent rather than acting on it. I brace-matched every `logAuditAction({…})` call across app/, lib/, components/ and hooks/: 0 of them omit orgId. The cited 'reachable instance' is not one — lib/documentOrigin.ts:41 passes `orgId: input.orgId ?? undefined`, but its only caller (components/documents/OriginSection.tsx:48) reads orgId from a prop typed `orgId: string` (:17), so undefined never arrives. This is a hardening note about a policy that permits rows nothing writes, not a live evidence gap.

**Done when.**

- [ ] Either org_id is NOT NULL on audit_logs and the INSERT policy stops admitting NULL, or a query exists that can surface NULL-org rows to someone.
- [ ] AuditEntry.orgId is required, or a call with no orgId is rejected rather than written.
- [ ] An inventory query counts existing NULL-org audit rows before the constraint is added (DEC-30).

---

<a id="alog-11"></a>

## ALOG-11 · The audit viewer can filter 36 action types out of the 110 the app writes; every admin-authority action — permission changes, ACL changes, recertifications, purges, restores, e-signatures, folder deletes — is unreachable through any filter, and the compliance KPI miscounts in both directions

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/audit/page.tsx:46-83`, `app/(protected)/admin/audit/page.tsx:271-281`, `app/(protected)/admin/audit/page.tsx:192`, `app/(protected)/admin/audit/page.tsx:172-178`, `lib/capabilityPolicy.ts:239`, `components/permissions/PermissionDrawer.tsx:292`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The counts are exact, not rhetorical: a scan of every action-name literal in the tree (`action:` plus the `type:` unions that lib/audit.ts's helpers forward) yields precisely 110 distinct actions against 36 filterable. The unreachable set includes CAPABILITY_POLICY_CHANGED (capabilityPolicy.ts:239), NODE_ACL_CHANGED (PermissionDrawer.tsx:292), ACCESS_RECERTIFIED, DATA_PURGE, DATA_RESTORE, ESIGNATURE_CAPTURED, FOLDER_DELETED and STORAGE_ORPHANS_PURGED. The KPI regex genuinely errs both ways — it misses DATA_PURGE (a real destruction) while counting TICKET_ARCHIVE_RESTORE and ARCHIVE_PRODUCE_CANCELED (a restore and a cancel) because both contain "ARCHIVE".

**Mechanism.** The action dropdown is built as `...Object.keys(ACTION_STYLE).sort().map(...)`, so it offers exactly the 36 actions that happen to have an icon and colour assigned. Extracting every `action: "UPPER_SNAKE"` literal across app/, lib/, components/ and hooks/ and subtracting the 36 styled keys yields 74 emitted action types with no filter entry — among them CAPABILITY_POLICY_CHANGED, NODE_ACL_CHANGED, ACCESS_RECERTIFIED, DATA_PURGE, DATA_RESTORE, DATA_ARCHIVE_RECLAIM, ESIGNATURE_CAPTURED, FOLDER_DELETED, PROJECT_DELETED, DELETION_REQUESTED, AI_CAP_CHANGED, CHECKOUT_RELEASED and every TRANSMITTAL_* event. The resource dropdown is hardcoded to `document / project / milestone / asset`, but rows are written with `resource_type` of `library` (ACCESS_RECERTIFIED), `org_configuration` (CAPABILITY_POLICY_CHANGED), `collection` (NODE_ACL_CHANGED on a folder), `org` (DATA_PURGE, DATA_RESTORE) and `storage` (STORAGE_ORPHANS_PURGED) — none selectable. The library filter compounds it: `if (r.resourceType !== "document") return false;` silently discards every non-document row the moment a library is chosen. And the "Deletes / undo / force" KPI matches `/DELET|ARCHIVE|REVERS|FORCE/`, which counts DELETION_REQUESTED (a request, not a delete), TICKET_ARCHIVE_RESTORE and ARCHIVE_PRODUCE_CANCELED (both restorative) as deletions, while missing DATA_PURGE, STORAGE_ORPHANS_PURGED, SUPERSEDE_DOC and TRANSMITTAL_VOIDED.

**Failure scenario.** During a PSM records review the auditor is asked to produce every permission change in the last twelve months. On /admin/audit they select "All time", look for a permission-related action in the dropdown, and find none — the list runs from ABANDON to UPLOAD with nothing about permissions. Choosing "Any resource" and paging by hand through hundreds of VIEW and DOWNLOAD rows is the only route, and picking the library filter to narrow it wipes the permission rows out entirely because their resource_type is not `document`.

**Evidence.**

```
app/(protected)/admin/audit/page.tsx:271-274 — `<Select value={actionFilter} onChange={setActionFilter} options={[{ value: "ALL", label: "All actions" }, ...Object.keys(ACTION_STYLE).sort().map((k) => ({ value: k, label: prettyAction(k) }))]} />`. :275-281 — the four hardcoded resource options. :174 — `if (r.resourceType !== "document") return false;`. :192 — `const deletes = [...byAction.entries()].filter(([k]) => /DELET|ARCHIVE|REVERS|FORCE/.test(k)).reduce((s, [, n]) => s + n, 0);`. Producers of unfilterable actions: lib/capabilityPolicy.ts:239 — `action: "CAPABILITY_POLICY_CHANGED", resource_type: "org_configuration",`; components/permissions/PermissionDrawer.tsx:292-293 — `action: "NODE_ACL_CHANGED", resource_type: nodeType,`; lib/accessRecert.ts:112 — `action: "ACCESS_RECERTIFIED", resourceType: "library"`; app/api/admin/purge/route.ts:176-178 — `action: "DATA_PURGE", resource_type: "org"`; app/api/collections/delete/route.ts:116 — `action: "FOLDER_DELETED"`.
```

**Chain reaction.** The action vocabulary has no single declaration — it is spread across string literals, the union types in lib/audit.ts:103-113 and :148-155, and this presentation map. Deriving the filter from a shared registry fixes the dropdown, the icons, the KPI and the /activity feed's ACTION_VERBS map at once; patching only the dropdown leaves three other copies to drift.

**Done when.**

- [ ] The action and resource filters are derived from the same registry the writers use, so a new action type is filterable the day it ships.
- [ ] Selecting a library filter does not silently discard non-document rows without saying so.
- [ ] The deletes KPI counts a stated, reviewable list of destructive actions rather than a substring regex.

---

<a id="alog-12"></a>

## ALOG-12 · The capability-policy save is a whole-grid read-modify-write off a mount-time snapshot behind a 60-second cache — two admins silently clobber each other, and the `before` half of the CAPABILITY_POLICY_CHANGED record can be a state that was never current

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** admin-and-org P9 (done-when 1: the editor's save carries the version it loaded; the route refuses a stale one with 409) — by the integrator, 2026-10-02 (at the A&O P0 merge: the verify-and-record package named the owner in its Partial block; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED
- **Locations:** `components/permissions/CapabilityPolicyEditor.tsx:35-43`, `components/permissions/CapabilityPolicyEditor.tsx:59-91`, `lib/capabilityPolicy.ts:161-196`, `lib/capabilityPolicy.ts:215-246`, `lib/capabilityPolicy.ts:252-283`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every limb verified: last-writer-wins on the full `caps` object in both directions (grid save clobbers grants, grant save clobbers caps), and the audit `before` at :245 is whatever the 60-second cache held, which need never have been the row's actual prior state. Note this is currently masked by ALOG-1 — nothing persists at all — but the concurrency defect is independent of it.

**Mechanism.** `loadCapabilityPolicy` caches per org for `CACHE_TTL_MS = 60_000`. The editor loads once on mount into both `policy` and `baseline`, and `save()` writes `{ caps: policy, grants: stored.grants ?? [] }` — the full grid as it was at mount, plus whatever grants the (possibly cached) read returned. Nothing is compared against current state and nothing is versioned, so a second admin's edit made after this editor mounted is overwritten wholesale. The impact preview computes `was = baseline?.[d.id] ?? d.defaultRoles` against the same mount-time snapshot, so it describes a diff from a state that may no longer exist. Worse, `saveCapabilityPolicy` builds its audit payload as `const before = await loadCapabilityPolicy(input.orgId)` (line 219) — the very same cached read — and writes `details: { before, after: input.policy }`. Within the TTL, `before` is the cached value, not the row being overwritten. The same read-modify-write shape governs delegations: `addUserGrant`/`revokeUserGrant` (lines 252-283) each read `current = await loadCapabilityPolicy(...)`, rebuild the grants array, and hand the whole policy to `saveCapabilityPolicy`.

**Failure scenario.** Two controllers respond to the same incident. Admin A opens /admin/permissions and narrows "Force close" to Admin only. Admin B, whose console has been open since before that change, grants a temporary `ticket.assign` delegation to a supervisor through the View-as panel — `addUserGrant` reads the cached policy, rebuilds grants, and saves the whole object, restoring Manager and Supervisor on "Force close". The audit row for B's action records `before` as the pre-A state, so the trail shows no one ever removed those roles and no one ever put them back. A's change is gone and the log agrees it never happened.

**Evidence.**

```
lib/capabilityPolicy.ts:161-163 — `const CACHE_TTL_MS = 60_000;` / `const cache = new Map<string, { at: number; policy: CapabilityPolicy }>();` and :169 — `if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.policy;`. lib/capabilityPolicy.ts:219 — `const before = await loadCapabilityPolicy(input.orgId);`. components/permissions/CapabilityPolicyEditor.tsx:37-40 — `const stored = await loadCapabilityPolicy(activeOrgId);` / `const merged = { ...defaultCapabilityPolicy(), ...(stored.caps ?? {}) };` / `setPolicy(merged);` / `setBaseline(merged);`. components/permissions/CapabilityPolicyEditor.tsx:66 — `const was = baseline?.[d.id] ?? d.defaultRoles;`. components/permissions/CapabilityPolicyEditor.tsx:84 — `await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps: policy, grants: stored.grants ?? [] }, … })`.
```

**Chain reaction.** The org_configurations column defect above means this save currently throws before it can land, so the lost-update is latent — but it becomes live the instant the column name is fixed, and the two fixes will almost certainly ship together. The row is a single JSONB blob with no updated_at precondition and no optimistic-concurrency token, so the fix is a structural one (conditional update on a version/updated_at, or a server route that merges) rather than a cache-TTL tweak.

> **Verifier correction.** Two overstatements. (1) The stale-`before` window is narrower than implied: loadCapabilityPolicy only returns the cached value if the save happens within 60s of the mount-time load; past that the read is fresh. (2) The lost-update is the durable half and does not depend on the cache at all — `policy` is held in React state from mount, so a concurrent admin's edit is clobbered whenever the second save lands, cache or no cache. HIGH is too strong for a two-simultaneous-admins race on a console with an Admin/DocCtrl-only gate (admin/permissions/page.tsx:34).

**Done when.**

- [ ] A save that would overwrite a policy changed since the editor loaded is refused or merged, not applied blindly.
- [ ] The `before` recorded in CAPABILITY_POLICY_CHANGED is read from the database at write time, bypassing the cache, or is derived from the row the update actually replaced.
- [ ] addUserGrant and revokeUserGrant modify only the grants array without republishing a stale caps grid.

**Partial (2026-10-02, admin-and-org Round G, P0).** Reproduced against base `f1ac550` (DEC-29). Done-when 2 and 3 hold since roles-and-permissions `WF-11` (commit `e32b554`: every policy write goes through `POST /api/admin/capability-policy`). Done-when 1 does not hold. The status stays OPEN.

- **Done-when 2 holds, through its first form: `before` is read from the database at write time, bypassing the cache.** The route reads the stored row fresh, with the service-role client and never through the cache: `app/api/admin/capability-policy/route.ts:132-139`, `before = parseStoredCapabilityPolicy(stored?.data)`. The write is a compare-and-set on that row's `updated_at` (`:218-228`). If no row matches, the route answers 409 and audits nothing.
  - The compare-and-set catches another route write, because the route stamps `updated_at` (`:221`). It does not catch `revoke_member`'s grant strip. On removal that function rewrites the policy row's `data` without touching `updated_at` (`supabase/migrations/20261043_rp_phase6_legal_hold_and_force_release.sql:161-167`, its newest definition), and no trigger on `org_configurations` stamps it. The only one is `trg_capability_policy_write_guard` (`20261056:206-210`); neither its live function body (`20261056`) nor its newest (`20261137`, PASTE) assigns `updated_at`.
  - So `before` is not always the row the update replaced. Suppose an Admin saves or grants after the route has read `before`, and another Admin meanwhile removes a member who holds a personal grant. The compare-and-set still matches, and `after`, built from `before`, re-stores the removed member's grant. The evaluator refuses a non-member, so nothing is admitted then. But if that person is re-added, the grant is live again, contrary to `DEC-20`'s "grants die with the membership".
  - Pins:
    - `sweepRoundE_policyServer.test.ts` "a DocCtrl … saves a non-critical change: CAS write, … audit row" (`d.before` equals the stored row), and its WF-16 409 case;
    - new: `aoRoundGP0Records.test.ts` "`before` is read fresh at write time: another admin's route write, not what this process had cached". It primes the server cache with an older row, lands a concurrent route write, then saves; `before` is the concurrent row.
- **Done-when 3 holds.** `addUserGrant` / `revokeUserGrant` (`lib/capabilityPolicy.ts:628`, `:644`) post `{ op: "grant" | "revoke", uid, cap }` with no caps. The route builds `after = { caps: before.caps ?? {}, grants: [...] }` from the fresh row (`route.ts:196`, `:200`). The failure scenario as written can no longer happen: Admin B's delegation cannot republish a stale grid over Admin A's narrowing. Pins:
  - `sweepRoundE_policyServer.test.ts` "an Admin's grant replaces the (person, capability) pair, … keeps other live grants" (`after.caps` equals the stored caps);
  - new: `aoRoundGP0Records.test.ts` "a grant rewrites the stored caps verbatim and touches only the grants array".
- **Done-when 1 does not hold.** A grid save is still a whole-grid replace built from a mount-time snapshot.
  - The editor loads once, through the 60 s browser cache (`components/permissions/CapabilityPolicyEditor.tsx:115-126`), keeps the grid in state, and on Save posts the whole joined grid (`:181`, `:216`).
  - `CapabilityPolicyChange` `save` carries `caps` only, with no version (`lib/capabilityPolicy.ts:587-588`). The route sets `after = { caps, grants: liveGrants }` (`route.ts:159`).
  - The route's compare-and-set uses the stamp it read in the same request (`:139`, `:223`). It catches only a write that lands between that read and the write.
  - So a second admin's grid change made after this editor mounted is overwritten wholesale. The CAPABILITY_POLICY_CHANGED row records it truthfully (`before` is the other admin's row), but nobody is told, and the impact preview still diffs against the mount-time baseline (`CapabilityPolicyEditor.tsx:187`).

  **Owner: admin-and-org P9.** Its plan entry names `CapabilityPolicyEditor.tsx` (at `:40`). Suggested shape:
  - the editor sends the `version` that `loadCapabilityPolicyEntry` already returns (`lib/capabilityPolicy.ts:483-518`);
  - the route refuses (409) a `save` whose version is not the row's `updated_at`, or merges per capability;
  - the editor reloads on a 409.
  - A version check on `updated_at`, here or in the existing compare-and-set, is blind to `revoke_member`'s grant strip (above) until `revoke_member` sets `updated_at = now()` in that `UPDATE`, re-created from `20261043`, its newest definition, or the check compares `data`. That race is the route's against a definer RPC, not this finding's criterion. It is proposed below as its own finding, owned by admin-and-org P8; P9 needs nothing from it.

  **Plan amendment needed.** The admin-and-org plan's P9 entry lists neither `ALOG-12` nor the files this shape needs beyond the editor's `:40`: the editor's load and save (`CapabilityPolicyEditor.tsx:115-126`, `:216`), `app/api/admin/capability-policy/route.ts` (refuse a stale-version save) and `lib/capabilityPolicy.ts` (the `CapabilityPolicyChange` `save` op carries the version). The integrator adds the finding and those files to P9, or re-owns this remainder.

**Proposed finding for the integrator (owner: admin-and-org P8): the policy route's compare-and-set cannot see `revoke_member`'s grant strip.** *(Opened by the integrator at the A&O P0 merge, 2026-10-02, as `ALOG-15`, owned by P8.)*
- Mechanism: the strip (`20261043:161-167`) rewrites the policy row's `data` and leaves `updated_at` unchanged. The route conditions its write on the `updated_at` it read (`app/api/admin/capability-policy/route.ts:134-139`, `:218-223`).
- Failure: an Admin removes member X, who holds a personal grant, while another Admin's save, grant or revoke is between the route's read (`:134`) and its compare-and-set (`:218`). The compare-and-set matches, `after` is built from `before`, and X's grant is written back.
  - The CAPABILITY_POLICY_CHANGED row carries X's grant in both `before` and `after`, so it shows no grant change while the write re-adds one. *Overstated (integrator, at the merge, from the final review): the strip itself is audited — `trg_capability_policy_write_guard` writes its own `CAPABILITY_POLICY_CHANGED` row (`via: direct_write`) for `revoke_member`'s update; what the route's row does not show is the re-add.*
  - Nothing is admitted while X is not a member, because the evaluator refuses a non-member. If X is re-added, the grant is live again, contrary to `DEC-20`'s "grants die with the membership".
  - The window is one request's read-to-write span. Proposed severity: LOW.
- Fix: set `updated_at = now()` in that `UPDATE`, in P8's re-creation of `revoke_member` (its plan's migration B, for `ORG-7`), starting from `20261043`, the newest definition. *(Integrator, at the notifications N5 merge, 2026-10-02: `revoke_member`'s newest definition is now `20261161` — N5 re-created it from `20261043` §0 verbatim plus the `NEDGE-7` notification tombstone, and a tripwire test fails if a later definition drops it. P8 re-creates it from `20261161`, found by scanning, never from `20261043`.)* The route's existing compare-and-set then answers 409 in the race, with no route change.
- Tripwire: `lib/__tests__/aoRoundGP0Records.test.ts`, `it.fails` "the grant strip stamps updated_at, so the policy route's compare-and-set sees it". It reads the newest `revoke_member` in the migrations, and P8 flips it to `it`. A plain test beside it checks that the newest definition still strips grants by rewriting `data`.
- This package does not open the finding, because doing so changes the area README's counts and `99-fix-sequencing.md`, which it does not edit. `ORG-3`'s proposed users-page finding is handled the same way.

**Done-when.**
1. ✗ not done: grid-against-grid saves are still last-writer-wins (owner P9).
2. ✓ through its first form: `before` is read fresh at write time, bypassing the cache. The compare-and-set catches route writes but not `revoke_member`'s grant strip, which leaves `updated_at` unchanged (the proposed finding above, owner P8).
3. ✓ grants never republish caps.

**Scope / residual.** Done-when 1 only (owner P9). Outside this finding's criteria: the `revoke_member` race, proposed above as a LOW finding owned by P8. No application code changed in this package.

**Resolution (2026-10-07, admin-and-org Round G).** Package P9 — done-when 1, the remainder P0 re-owned (done-when 2 and 3 held since roles-and-permissions `WF-11`, P0's Partial). Reproduced on base `c537602` (DEC-29): the editor loaded once through the browser cache and posted the whole grid (`CapabilityPolicyEditor.tsx:115-126`, `:216`); the `save` op carried no version (`lib/capabilityPolicy.ts:592`); the route's compare-and-set used the stamp it read in the same request (`route.ts:139`, `:223`) — so a second admin's grid change made after the editor mounted was overwritten.

Landed (the shape P0 suggested):
- `lib/capabilityPolicy.ts`: the `save` change carries `version?: string | null` (`CapabilityPolicyChange`); `saveCapabilityPolicy({ …, version })` sends it and answers the version the save wrote; a refused write throws `CapabilityPolicyChangeError` with the route's status and `code`; `samePolicyVersion` (`:702`) compares two stamps as text, then as the same instant (PostgREST's `+00:00` and an ISO `Z` spell one timestamptz).
- `app/api/admin/capability-policy/route.ts:162-171`: a `save` carrying `version` is refused **409** `{ code: "policy_changed" }` when the stored row's `updated_at` is not that version (null = "nothing was stored"; a row that now exists is stale) — before anything is written or audited. A body without the key (a bundle from before this change, mid-deploy) keeps today's compare-and-set only. The compare-and-set's own 409s now carry the same code (`changed`, `:66`). Grants and revokes are not version-checked: they never republish the grid (done-when 3).
- `components/permissions/CapabilityPolicyEditor.tsx`: the grid loads FRESH and remembers its version and the grid it started from; Save sends the version (`:340`). On 409 `policy_changed` it re-reads: if the stored ROLE GRID is still the one it started from (only grants moved — a delegation in View-as, a pruned expiry), it saves again on the new version (`:356-366`) — so the same admin's grant does not refuse their own grid edit; otherwise it shows the other admin's grid and says "your change was NOT saved. Make your change again." Any other refusal (a critical capability, the 20261136 probe) is said as before, with no reload.

Tests: `lib/__tests__/aoRoundGP9PermissionsConsole.test.ts` "ALOG-12 — …" (the loaded version → 200 and audited; the same instant spelled the other way → 200; a stale version → 409 `policy_changed`, the row unchanged, no update call, no audit row; `version: null` against an existing row → 409; `null` with nothing stored → the first INSERT; no key → today's behaviour; a malformed version → 400; a grant is not version-checked; the CAS 409 carries the code); `lib/__tests__/aoRoundGP9ConsoleRendered.test.ts` (rendered: the save carries the version; a 409 where only grants moved re-saves on the new version with the edit intact; a 409 where the grid moved shows the other admin's row and saves nothing).

**Done-when.**
1. ✓ A save that would overwrite a policy changed since the editor loaded is refused (409 `policy_changed`), never applied blindly; when only grants moved the editor re-applies the same edit on the current version (the grid it started from is still the stored one).
2. ✓ (P0) `before` is read from the database at write time, bypassing the cache (the `revoke_member` race is `ALOG-15`, P8's).
3. ✓ (P0) grants never republish caps.

**Scope / residual.** None for this finding. `ALOG-15` (the grant strip that leaves `updated_at` alone, so neither the compare-and-set nor this version check sees it) stays P8's.

---

<a id="alog-13"></a>

## ALOG-13 · The permissions console asserts the legacy read/write/admin matrix "is GONE" and that nothing depended on it, while /admin/libraries still writes all three columns and the documents home page still filters library cards on two of them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** admin-and-org P8, coordinating with intelligence I-12 (DACL-10) (all three done-whens: the console comment, the dead-column writers and readers, the recorded decision) — by the integrator, 2026-10-02 (at the A&O P0 merge: the verify-and-record package named the owner in its Partial block; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/permissions/page.tsx:13-16`, `app/(protected)/admin/libraries/page.tsx:103-107`, `app/(protected)/admin/libraries/LibraryWizard.tsx:247-271`, `app/(protected)/documents/page.tsx:44-54`, `supabase/schema.sql:75-77`, `lib/libraryCollections.ts:129-131`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The console's absence claim is wrong: `read_access` (with `visible_to`) is read on every load of the documents home page and does gate which library cards a non-controller sees. The finding's 'two of them' is loose — the second column doing the filtering is `visible_to`, which is not one of the three the console names — but that does not weaken it, because the genuinely inert pair is `write_access`/`admin_access`, which /admin/libraries and LibraryWizard still present as upload/admin restrictions and no enforcement path ever consults. Both halves of the trap are therefore live.

**Mechanism.** The permissions page header states: "The old read/write/admin role matrix is GONE: it wrote columns (libraries.read_access/write_access/admin_access) that no policy, trigger, or query ever read — a decorative permission system is worse than none. Confirmed safe to remove: no org data depended on it." Both halves are wrong. It is not gone: `LibraryWizard` still renders the role pickers and returns `readAccess`, `writeAccess`, `adminAccess`, `visibleTo`, and `handleSaveLibrary` writes all four on every library create and edit — `write_access: config.writeAccess ?? [], admin_access: config.adminAccess ?? [], read_access: config.readAccess ?? "ALL", visible_to: config.visibleTo ?? []`. And two of the columns are read: the documents home page computes card visibility from them (`if (readAccess === "ALL") return true;` … `return readList.includes(role) || visibleTo.includes(role);`). `write_access` and `admin_access` genuinely are dead — read into LibraryConfig objects in three files and consulted by no evaluator, policy or trigger — which is the dead-column pattern the earlier audits catalogued. So an admin configuring "who can upload" and "who can administer" in the Library wizard changes nothing anywhere, while "who can view" changes only a client-side card filter.

**Failure scenario.** A controller reads the permissions console, believes the legacy matrix was removed, and does not think about it again. Meanwhile another controller sets up a new restricted library through /admin/libraries, ticks the view/upload/admin role boxes, and believes the library is restricted. Upload and admin authority were never enforced by those settings; view is enforced only by a client-side filter on the library list, which roles-and-permissions DACL-10 already established is bypassed by navigating straight to /documents/<libraryId>. Two controllers, two false beliefs, one of them created by the console's own comment.

**Evidence.**

```
app/(protected)/admin/permissions/page.tsx:13-16 — `// The old read/write/admin role matrix is GONE: it wrote columns` / `// (libraries.read_access/write_access/admin_access) that no policy, trigger,` / `// or query ever read — a decorative permission system is worse than none.` / `// Confirmed safe to remove: no org data depended on it.` app/(protected)/admin/libraries/page.tsx:105-106 — `write_access: config.writeAccess ?? [], admin_access: config.adminAccess ?? [],` / `read_access: config.readAccess ?? "ALL", visible_to: config.visibleTo ?? [],`. app/(protected)/documents/page.tsx:44-50 — `const readAccess = (lib as { readAccess?: Role[] | "ALL" }).readAccess;` / `if (readAccess === "ALL") return true;` / `const visibleTo = toArrayRole((lib as { visibleTo?: unknown }).visibleTo);` / `return readList.includes(role) || visibleTo.includes(role);`. A repo-wide grep for `writeAccess|adminAccess` outside admin/libraries and types/schema returns only the two read-into-config sites at app/(protected)/documents/[libraryId]/page.tsx:1455 and app/(protected)/documents/page.tsx:143-144 — no evaluator, no policy, no trigger.
```

**Chain reaction.** roles-and-permissions DACL-10 owns the read_access/visible_to enforcement gap and its Done-when is "Either read_access/visible_to are retired in favour of libraries.acl (one model), or the detail page enforces the same predicate the home page uses AND a RESTRICTIVE RLS policy enforces it on libraries." This finding is the documentation half: whichever way DACL-10 resolves, the console comment must stop asserting a removal that never happened, and the wizard must stop offering two controls that do nothing.

> **Verifier correction.** The closing sentence is wrong and would mislead anyone acting on this. 'An admin configuring who can upload and who can administer in the Library wizard changes nothing anywhere' is false: the same wizard values ALSO build the library's real, enforced ACL — LibraryWizard.tsx:249 derives writeRoles from the upload-role picker, then :258-259 emit `{effect:"allow", subject:{type:"role"}, actions:["upload","createFolder","editMetadata","write",…]}` and admin/managePermissions rules into `acl`, which page.tsx:107 persists and which the ACL evaluator and the database deny-guards (20260901:126-176) act on. What is dead is the mirrored COLUMN, not the control.

**Done when.**

- [ ] The comment on /admin/permissions matches what the code does, or the legacy columns really are removed everywhere including LibraryWizard and handleSaveLibrary.
- [ ] write_access and admin_access are either enforced or dropped from the wizard UI and the write payload.
- [ ] The decision is recorded so the next agent does not re-derive it from the stale comment.

**Partial (2026-10-02, admin-and-org Round G, P0).** Reproduced against base `f1ac550` (DEC-29). The fleet plan expected this finding to close by pointer to roles-and-permissions `DB-5`. It does not. `DB-5` made the wizard write `acl_index` from a merged ACL (`app/(protected)/admin/libraries/page.tsx:112`, `:119-120`), which is the ACL half the verifier correction above describes. None of this finding's three criteria moved. The status stays OPEN.

- **Done-when 1 does not hold.** `app/(protected)/admin/permissions/page.tsx:13-16` still says "The old read/write/admin role matrix is GONE: it wrote columns (libraries.read_access/write_access/admin_access) that no policy, trigger, or query ever read … Confirmed safe to remove: no org data depended on it."
  - The library save still writes all four columns: `app/(protected)/admin/libraries/page.tsx:116-117`, `write_access: config.writeAccess ?? [], admin_access: config.adminAccess ?? [], read_access: config.readAccess ?? "ALL", visible_to: config.visibleTo ?? []`.
  - The documents home page still filters library cards on `read_access` and `visible_to` (`app/(protected)/documents/page.tsx:43-51`).
- **Done-when 2 does not hold; only the UI half has moved.**
  - The wizard no longer offers an admin picker: `adminRoles` is fixed at `["Admin", "DocCtrl"]` (`app/(protected)/admin/libraries/LibraryWizard.tsx:280`).
  - Its upload picker (`:644-654`) builds the library's enforced ACL rules (`:281`, `:290-291`), so it is a real control.
  - The payload still mirrors both pickers into the dead columns (`LibraryWizard.tsx:301-302` → `page.tsx:116`), and `createLibrary` writes `[]` into both on every library it creates (`lib/libraryCollections.ts:180-181`). No evaluator or policy enforces them.
  - The library sensitive-column guard compares both: `enforce_library_sensitive_columns()` refuses a change to `write_access` or `admin_access`, as to the other guarded columns, unless the caller is an org controller, the library's owner or a manager of its ACL (`20261036:41-42`, live; re-created at `20261077:169-170`, its newest definition, PASTE). That is a guard on writes, not enforcement of what the columns say. Dropping the columns, rather than only the payload, therefore needs that function re-created from `20261077` without them first. Otherwise the trigger raises `record "new" has no field "write_access"` on every library UPDATE.
  - **The full census on `f1ac550`** (`git grep -nE "write_access|admin_access"` outside the records; pinned by `aoRoundGP0Records.test.ts` "every source file that names write_access / admin_access is one the record lists"):
    - Writers, two: the wizard save, `app/(protected)/admin/libraries/page.tsx:116` (fed by `LibraryWizard.tsx:301-302`), and `createLibrary`, `lib/libraryCollections.ts:180-181` (`write_access: [], admin_access: [],`).
    - Readers, four sites in three files: the edit load, `app/(protected)/admin/libraries/page.tsx:63`, which seeds the upload picker (`LibraryWizard.tsx:244`); the library page, `app/(protected)/documents/[libraryId]/page.tsx:1460`, a named select list (`…,uniqueness_keys,write_access,admin_access,read_access,…`) mapped at `:1482`; and the documents home page, `app/(protected)/documents/page.tsx:175-176`, mapped from a `select("*")` (`:161`). Outside the wizard seed, nothing consults the mapped values; the `LibraryConfig` type carries them (`types/schema.ts:375-376`).
    - SQL: the guard above (`20261036:41-42` live; `20261077:169-170` newest), the column definitions (`schema.sql:114-115`), and `20261036`'s probe "all guarded library columns exist" (`:369-376`, `COUNT(*) = 17`, naming both at `:373`). That probe is history in a LIVE file, never re-pasted. The guard's shape tests name both columns (`rpPhase3Migration.test.ts:30`; `dcRoundFMigration.test.ts`, which compares the 20261036 and 20261077 bodies). `roundEOwnershipMigrations.test.ts:167` pins that the library INSERT rail ignores them, because `createLibrary` writes their defaults.
  - **What each fix needs.**
    - Dropping them from the write payload (done-when 2's second form) needs both writers changed, `admin/libraries/page.tsx:116` (with the mirror at `LibraryWizard.tsx:301-302`) and `lib/libraryCollections.ts:180-181`. It also needs the upload picker seeded from the ACL's role rules instead of `page.tsx:63`.
    - Dropping the columns as well needs, before the `DROP COLUMN`: the guard re-created from `20261077` without them (above); both writers gone, or every library create and wizard save is refused for an unknown column; and the named select list at `documents/[libraryId]/page.tsx:1460` changed. Otherwise that select fails with 42703 on every library open, and the page reaches the library only through its `select("*")` fallback (`:1466-1471`, written for a database that is behind on a migration). The mappings at `admin/libraries/page.tsx:63` and `documents/page.tsx:175-176` read a missing column as `[]`, so they only need removing with the type fields.
- **Done-when 3 does not hold.** No decision is recorded.

**Owner: admin-and-org P8.** It owns `admin/libraries/page.tsx` (`:183-198` only, in its plan entry), and the intelligence plan names it for "admin/libraries wizard, ALOG-13 console copy" (`audit-reports/fleet-plans/intelligence.json`, I-12's notes). P8 coordinates with intelligence I-12, which owns `DACL-10` enforcement and by default retires `read_access` / `visible_to` as enforcement.

**Plan amendment needed.** The admin-and-org plan's P8 entry does not list `ALOG-13`, and its files do not cover the fix:
- the writers: `app/(protected)/admin/libraries/page.tsx:116-117` (the payload) and `lib/libraryCollections.ts:180-181` (`createLibrary`);
- the wizard: `app/(protected)/admin/libraries/LibraryWizard.tsx:244` and `:301-302` (the picker seed and the mirror), with the edit load at `admin/libraries/page.tsx:63`;
- the comment: `app/(protected)/admin/permissions/page.tsx:13-16`;
- only if the columns are dropped: `app/(protected)/documents/[libraryId]/page.tsx:1460` and `:1482`, `app/(protected)/documents/page.tsx:175-176`, `types/schema.ts:375-376`, and a migration that re-creates `enforce_library_sensitive_columns` from `20261077` first.

The integrator adds the finding and those files to P8 (checking them against other packages' file lists), or re-owns this finding.

Tripwire: `lib/__tests__/aoRoundGP0Records.test.ts`, `it.fails` "done-when 1: the console's 'GONE' comment does not coexist with a library write that still names write_access / admin_access". Its write side is a census over `app/`, `lib/`, `hooks/`, `components/` and `types/`, not one file, so today it sees both writers. It fails the suite the day the comment goes or every writer stops, and P8 then flips it to `it`. It is a done-when 1 tripwire only: it does not show that done-when 2 holds (the enforce-or-drop choice and the picker seed), which P8 records separately. A plain test beside it checks that the console file exists and that the census walks both writers' files, so the tripwire cannot pass vacuously.

**Done-when.**
1. ✗ the comment still asserts a removal that did not happen (owner P8).
2. ✗ `write_access` / `admin_access` are still written, by the wizard save and by `createLibrary`, and not enforced. The admin picker is gone and the upload picker is real (owner P8).
3. ✗ no decision recorded (owner P8, with I-12's DACL-10 default).

**Scope / residual.** All three criteria are open. No application code changed in this package.

---

<a id="alog-14"></a>

## ALOG-14 · The permissions console's headline panel is a hand-maintained 52-row string matrix that has drifted from the code — at least five rows assert authority boundaries the app does not have

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/permissions/PermissionsExplorer.tsx:14-80`, `app/(protected)/admin/permissions/page.tsx:148`, `app/(protected)/admin/holds/page.tsx:32`, `app/(protected)/admin/scope/page.tsx:36`, `app/(protected)/admin/assets/page.tsx:56`, `app/api/admin/create-user/route.ts:62`, `app/(protected)/documents/[libraryId]/page.tsx:3372-3379`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right, and the drift runs in both directions — DocCtrl is understated on four rows while Manager is overstated on user management. Only the row count is off: the array holds 51 rows, not 52, which is immaterial to the claim. The one hedge in the file, the `warn` field flagging known gaps, is used on exactly one row ("Create / edit / refresh work packages"), so none of the six drifted rows carries any warning.

**Mechanism.** `PermissionsExplorer` is rendered first on /admin/permissions, above the real editor, described as "the IT-department view of the ENTIRE app" and "Derived from a code audit of every enforcement point". It is a literal array of 52 `Row` objects whose `m` field is a 12-character string, one char per role, hand-written in source. It imports nothing from `lib/capabilityPolicy`, `lib/permissions`, or `lib/acl`; it never reads the org's stored policy, so it cannot reflect any change made in the CapabilityPolicyEditor rendered directly below it, nor any per-person delegation, nor any ACL rule. Being a snapshot, it has drifted. Column order is `[Admin, DocCtrl, Manager, Supervisor, DraftingSup, Engineer 1-4, Drafter, Requester, Staff*, Contractor, Auditor, Viewer]`, so position 1 is DocCtrl. Checkable mismatches: (1) `{ cap: "Audit log", m: "yyyy------y-" }` asserts a boundary that does not exist — `audit_logs_org_access` grants SELECT to every member (schema.sql:1084-1085) and /activity renders the rows to everyone; (2) `{ cap: "Release stale checkouts (/admin/holds)", m: "y-yy--------" }` marks DocCtrl "—", but the page's gate is `new Set(["Admin","Manager","Supervisor","DocCtrl"])`; (3) `{ cap: "Operational scope", m: "y-yy--------" }` marks DocCtrl "—", but /admin/scope's gate is the same four-role set; (4) `{ cap: "Equipment / asset admin pages", m: "y-yy--------" }` marks DocCtrl "—", but /admin/assets uses `["Admin","DocCtrl","Manager","Supervisor"]` and the file's own comment says "DocCtrl belongs here"; (5) `{ cap: "User management (invite, roles)", m: "y-y---------" }` marks DocCtrl "—", but /api/admin/create-user admits `["Admin","DocCtrl"]`; (6) `{ cap: "Access recertification reviews", m: "yycccccccccc", cond: "If library owner" }` promises any-role owners can recertify, but the only entry point is inside `{isController && ( … Access recertification … )}`.

**Failure scenario.** An IT auditor is asked to produce the workspace's access-control matrix. They open /admin/permissions, screenshot the top panel, and hand it over. It says the audit log is restricted to five roles — a Drafter or a Safety staffer can read every row of it — and it says Doc Control cannot manage users, release stale checkouts, edit operational scope or edit the equipment registry, all four of which Doc Control can do. The document is signed as an accurate control description and is wrong in both directions: it under-states an exposure and over-states three restrictions.

**Evidence.**

```
components/permissions/PermissionsExplorer.tsx:14 — `const ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSup", "Engineer 1-4", "Drafter", "Requester", "Staff*", "Contractor", "Auditor", "Viewer"];`. :17 — `// m: 12 chars in ROLES order — y (yes), c (conditional), - (no).` :65 — `{ area: "Metrics", cap: "Audit log", m: "yyyy------y-" },`. :74 — `{ area: "Admin", cap: "Release stale checkouts (/admin/holds)", m: "y-yy--------" },` vs app/(protected)/admin/holds/page.tsx:32 — `const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);`. :68 — `{ area: "Admin", cap: "User management (invite, roles)", m: "y-y---------", cond: "Only an Admin can grant the Admin role" },` vs app/api/admin/create-user/route.ts:62 — `if (!callerMember || !["Admin", "DocCtrl"].includes(callerMember.role as string))`. :45 — `{ area: "Reviews", cap: "Access recertification reviews", m: "yycccccccccc", cond: "If library owner" },` vs app/(protected)/documents/[libraryId]/page.tsx:3372 — `{isController && (` wrapping the "Access recertification" menu item, with `const isController = isControllerRole(activeRole);` at :2861 and lib/permissions.ts:18-20 — `return role === "Admin" || role === "DocCtrl";`.
```

**Chain reaction.** roles-and-permissions SURF-9 already censuses the per-page gates and DEC-17 scopes what may be fixed there; this finding is about the artifact that *reports* those gates, which SURF-9 does not cover. Deriving the matrix from CAPABILITY_DEFS + the stored policy would fix the drift for the Requests/Metrics/Holds rows but not for the Documents/Publishing/Reviews rows, which encode ACL and ownership semantics no single evaluator exposes — so the honest fix may be to derive what can be derived and label the rest as a documented, dated snapshot.

> **Verifier correction.** Two of the six cited mismatches do not hold as stated. (1) 'Audit log' m="yyyy------y-" is an EXACT match for admin/audit/page.tsx:27's `["Admin","Manager","Supervisor","DocCtrl","Auditor"]` — it is not drift against its own subject; it only looks wrong once you accept finding #2 (that /activity leaks the same table), so it is derivative, not independent evidence. (2) 'User management (invite, roles)' m="y-y---------" matches the /admin/users PAGE gate, which is `if (!['Admin','Manager'].includes(activeRole))` at admin/users/page.tsx:231 — DocCtrl genuinely cannot open that page. The real inconsistency is app-internal: the API at create-user/route.ts:62 admits `["Admin","DocCtrl"]`, so Manager can open the page but gets 403 from the route, and DocCtrl is admitted by the route but cannot reach the page. Severity MEDIUM: this is a misleading reference table in an admin console, not an enforcement defect.

**Done when.**

- [ ] Rows that correspond to a registered capability are rendered from CAPABILITY_DEFS and the org's stored policy, not from a literal string.
- [ ] The five mismatches above are each either corrected or shown to be intentional.
- [ ] Any remaining hand-maintained rows are visibly marked as a documentation snapshot rather than presented as derived truth.

**Resolution (2026-10-07, admin-and-org Round G).** Package P9, second step (after `ALOG-2`). Reproduced on base `c537602` (DEC-29): `components/permissions/PermissionsExplorer.tsx` was a literal array of 51 rows (`:20-80`) whose 12-character mark strings were hand-written, imported nothing from the policy or the admin-surface registry, never read the org's stored policy, and called itself "Derived from a code audit of every enforcement point" (`:6`).

Landed — `PermissionsExplorer.tsx` now draws three sections, each labelled on screen:
1. **Action permissions — this org's policy** (`capabilityRow`, `:89`): one row per `CAPABILITY_DEFS` entry, each cell `policyAllows(storedPolicy, cap, role)` for the column's roles (the evaluator the workflow route, the admin gate and the SQL mirror share), ✓ when every role in the column holds, ◐ when some do; the standing holders the policy cannot remove are said (`STANDING`: Admin / DocCtrl always sign off quality records; a project's owner; the identity rights of the ticket capabilities); scoped rules and live personal grants are noted per row; dormant rows greyed. The policy is read through `loadCapabilityPolicyEntry`; an unreadable one is said and the rows are LABELLED as the shipped defaults (`ALOG-1`).
2. **Admin surfaces — the admin-surface registry** (`SURFACE_ROWS`, `:115`): the `/admin` pages' action authority read from `lib/adminSurfaces.ts` (`writes` where the page declares one, else `entry`), which `roundE_D_rolesAdmin.test.ts` already holds equal to each page's own rule.
3. **Documentation snapshot — hand-maintained, reviewed 2026-10-07** (`SNAPSHOT_ROWS`, `:154`): the ACL, ownership and per-library rows no single evaluator answers, each tagged SNAPSHOT; the section says they are not derived. No snapshot row repeats a derived one.
The columns are the role model (`EXPLORER_COLUMNS`, `:38`): every role in `ALL_ROLES` exactly once (the four Engineer tiers share a column, DEC-4; the dormant labels share "Staff*").

**The six named mismatches, each decided from CAPABILITY_DEFS, the stored policy and the registry as the server evaluates them** (the integrator's ruling under the user's delegation: show the truth; change who may act only for a real defect proved — none was):
1. *Audit log* — **display-only.** The row now IS `admin.audit_view` (the capability the admin gate and, since `20261063`, the database's `audit_logs_admin_trail` overlay read): Admin, DocCtrl, Manager, Supervisor, Auditor by default — the same marks, now live. The exposure the finding named is document-level history, which every member reads (`/activity`): a snapshot row says so, with ⚠ `ALOG-5` (open, not P9's).
2. *Release stale checkouts (/admin/holds)* — **display-only, and stale.** `/admin/holds` releases HOLDS (`holds.release`, `HLD-8`); releasing another person's checkout is `checkout.force_release` (database-enforced). Both are derived rows (Admin + DocCtrl force-release by default — the old row had DocCtrl "—" and Manager / Supervisor "y", wrong both ways); the row is gone.
3. *Operational scope* — **display-only.** From `ADMIN_SURFACES.scope.writes`: Admin, Manager, Supervisor, DocCtrl (DocCtrl ✓).
4. *Equipment / asset admin pages* — **display-only.** From `ADMIN_SURFACES.assets.writes`: Admin, DocCtrl, Manager, Supervisor (DocCtrl ✓).
5. *User management (invite, roles)* — **display-only; split in three.** "Add a member (invite)" is the create-user route's rule and the members page's `canAddMember` (Admin + DocCtrl by the collection; only an Admin grants Admin) — a snapshot row; "Change member roles, suspend or restore members" is `ADMIN_SURFACES.users.writes` (Admin, Manager) — derived, with the database's narrowing said on the row (only an Admin grants Admin or suspends / restores an Admin: `org_members_update`, `20260817`, and `revoke_member`); "Remove a member from the workspace" is Admin only (`revoke_member` mode `'remove'`, newest body `20261161`; `org_members_delete`, `20261042`) — a snapshot row. The page/route inconsistency the verifier saw (Manager opening a page whose route refused it; DocCtrl admitted by a route whose page refused it) no longer holds at HEAD: the page's entry admits DocCtrl and its add control follows the route. *(Corrected at P9's review fix: the derived row first read "Change member roles, suspend or remove members" and showed Manager ✓ for removal, which `revoke_member` refuses.)*
6. *Access recertification reviews* — **holds as written** since DEL-6 and now at the database too: the owner (◐ "If library owner") plus Admin / DocCtrl — the page, the library guard (`20261077` §2) and the event table (`20261188`, `ALOG-2`).
The derivation also corrected rows the finding did not name: *Data export & backups* (Admin only since `BKP-8`; the old row said Admin, DocCtrl, Manager), *Workspace settings* and *Branding* (Admin only by the registry; the old row said DocCtrl too). Ownership and teams are three rows:
- *Change a department's supervisor* (snapshot, Admin): the supervisor guard (`teams_guard_supervisor_change`, `20261046`) admits a controller and the teams write policy (`teams_admin_write`, `20261046`) admits Admin or Manager, so Admin alone — or a member holding Document Control together with Manager, which the row's note says.
- *Reassign library ownership / owning team* (snapshot, `yycccccccccc`): the library guard (`enforce_library_sensitive_columns`, `20261077` §2) admits a controller, the library's current owner or a Manage Permissions grant on it; reached from the library's review policy (`setOwner`) and from `/admin/teams` (`setLibraryOwnerTeam`).
- *Create teams & manage team membership* (derived, `ADMIN_SURFACES.teams.entry`, Admin and Manager): the page's audience, and the same two `teams_admin_write` / `team_members_admin_write` (`20261046`) admit. The registry's `teams.writes` (Admin, DocCtrl) is the page's supervisor and library-ownership controls, the two snapshot rows above.

*(Corrected at P9's review fix, 2026-10-07. The rewrite first had one snapshot row, "Change a department's supervisor or library ownership", marked Admin only. That understated library ownership the same way the old matrix understated DocCtrl, which is what this finding is about: Document Control and a library's owner can both reassign it. The teams row was labelled "Teams & team members" with no source named. All three rows are now pinned to the SQL text they describe.)*

*(Corrected at P9's second review fix, 2026-10-07.)* Two claims above were overstated:

1. **Composed authority was missing from four derived rows.** `capabilityRow` asked only the row's own capability. But the workflow engine the route enforces (`lib/workflow.ts` `getActions`, called by `app/api/tickets/workflow-action/route.ts`) also admits the management override at those rows' stages:
   - `allows('ticket.eng_review') || isManagement` at PENDING_ENG_TEAM;
   - `allows('ticket.direct_approve') || isManagement` at PENDING_REVIEW and FINAL_DRAFT;
   - `allows('ticket.final_approve') || isManagement` at PENDING_FINAL_APPROVAL;
   - a co-reviewer acting on the requester's behalf.

   So "Direct engineering approval" showed Admin, Manager and Supervisor "—", "Engineering scope review" and "Final engineering approval" showed them ◐ (identity only), and "Requester review" showed management and engineers as identity only. All are wrong; the old literal matrix had the final-approval row right. `PermissionsExplorer.tsx` now composes them:
   - `COMPOSED` and `composedAllows`: management for those three rows; Direct engineering approval or management for Requester review; and, ◐, a Requester-review holder reopening a ticket with no requester (`canActAsRequester`).
   - A cell held only through composition says so, for example "Via Management override (ticket.manage)".
   - `ViewAsSimulator` answers through the same `composedAllows`.

   With the shipped defaults, the rows now read:
   - Direct engineering approval `y-yy-y------`;
   - Engineering scope review and Final engineering approval `ycyycycccccc`;
   - Requester review `ycyycycycccc`.
2. **The snapshot's review date overclaimed.** Every snapshot row sat under "reviewed 2026-10-07", but only the rows this package changed had been checked against the code. One of them was stale: "Per-library permission (ACL) drawer" said Admin and Document Control only, beside the corrected ownership row that admits an owner and a Manage Permissions grant holder. Fixed:
   - **ACL drawer row:** now `yycccccccccc`, matching the drawer's delegation mode (`PermissionDrawer` `delegationOnly`, DEL-1 / GAP-3). The library page offers that mode on the library to its owner, and on a folder or document to its effective owner or a Manage Permissions grant holder on the chain. It allows allow-rules only, never Admin or Manage Permissions, and each needs an expiry. The library guard (`20261077` §2) admits the same people on the library's ACL, without the drawer's bounds.
   - **"Edit document metadata":** checked too (the reviewer named it). It is now `yycccccccccc` with ⚠:
     - The metadata editor's fields are the controllers' (`MetadataEditor` `canEdit`). An ACL Edit Metadata grant opens nothing more there.
     - The inline title rename is offered to every member.
     - The database admits any member's update unless an ACL deny binds them: `documents_org_access`, plus `documents_deny_write_guard` (`20260901`). This is the OWN-2 / OWN-19 class.
   - **Per-row stamps:** each snapshot row now says whether it was checked. The eight rows checked against the code on 2026-10-07 carry `checked` and are tagged SNAPSHOT. The other 23 are tagged **NOT RE-CHECKED** on screen (named under *Scope / residual*). The section header now reads "rows marked SNAPSHOT were checked against the code on 2026-10-07, rows marked NOT RE-CHECKED were not".
   - **Live refresh:** the explorer and View-as panels re-read on the same page when the policy editor saves or a View-as grant or revoke lands (`announceCapabilityPolicyChanged` / `onCapabilityPolicyChanged`, `lib/capabilityPolicy.ts`). Before this, the matrix kept showing the pre-save policy under "this org's policy".

Tests: `lib/__tests__/aoRoundGP9PermissionsConsole.test.ts` "ALOG-14 — the permissions explorer tells the truth" (the columns are the role model; every capability is a derived row and a stored narrowing moves it; each of the six rows is the server's answer; quality sign-off's standing holders; every registry row reads a field that exists; the snapshot is labelled, dated and duplicates nothing; the old "Derived from a code audit" claim is gone; review fix, each pinned to the newest migration that defines its rule: library ownership to the `20261077` §2 guard text, the supervisor row to `20261046`'s guard and `teams_admin_write`, the teams row to `teams_admin_write` / `team_members_admin_write` and the registry's `teams.entry`, member removal to `revoke_member`'s `'remove'` branch in `20261161` and `org_members_delete` in `20261042`); `lib/__tests__/aoRoundGP9ConsoleRendered.test.ts` "PermissionsExplorer" (rendered: three sections in order; a stored narrowing in the cells; the unreadable policy labelled); `lib/__tests__/rolePickerCensus.test.ts` (the columns cover every role once); `sweepRoundA3.test.ts`'s DEL-6 pin on the recertification row still holds.

Second review fix, tests:
- `aoRoundGP9PermissionsConsole.test.ts` "the four ticket rows the engine composes with ticket.manage show management as able".
- **Engine parity** — "parity with the engine, per role column — the shipped defaults" and "— a narrowed policy". For every live ticket row, a synthetic ticket is built at the row's stage. `WorkflowEngine.getActions` is asked, per role, whether that role is offered the stage's action, and each column's cell must agree: ✓ when every role is offered, ◐ when some are, never ✓ when none are. Every `COMPOSED` entry must have a stage there. A mutation that drops one composition fails it.
- "the narrowed policy moves the composed cells too".
- "View-as answers through the same composition".
- "exactly the rows checked against the code carry the review date".
- "the ACL drawer row is the drawer's delegation contract (DEL-1 / GAP-3) and the library guard" (pinned to `PermissionDrawer`, the library page and `20261077` §2).
- "document metadata: the editor is the controllers'…" (pinned to `MetadataEditor`, `saveInlineTitle`, `documents_org_access` and `documents_deny_write_guard`).
- `aoRoundGP9ConsoleRendered.test.ts`:
  - "a snapshot row not checked against the code says so on screen";
  - "a policy-editor save re-reads the explorer and View-as on the same page";
  - "View-as: a Manager approves drawings via the management override".

**Done-when.**
1. ✓ Rows that correspond to a registered capability are rendered from `CAPABILITY_DEFS` and the org's stored policy — every capability, not only the old matches.
2. ✓ The mismatches are each corrected (1–5, display-only: derived or corrected snapshot rows) or shown to hold (6); none was a policy gap, so nobody's authority changed. The rewrite's own rows are held to the same bar: member removal (Admin only), library ownership (controllers, the owner, a Manage Permissions grant), a department's supervisor and team membership each say what the database admits, and tests pin each one to the SQL it describes. *(Corrected at P9's review fix: this first claimed every mismatch was corrected while two rows the rewrite added were wrong — library ownership shown Admin-only, and Manager ✓ for removing a member.)* *(Corrected again at P9's second review fix: the ✓ above was still overstated. Four derived ticket rows left out the management override the engine composes onto them, so Admin, Manager and Supervisor were shown unable, or identity-only, on approvals the route lets them make. They are now composed, and each live ticket row is pinned per role column to `WorkflowEngine.getActions` for the defaults and for a narrowed policy.)*
3. ✓ The remaining hand-maintained rows are a labelled documentation snapshot (section header, per-row tag, the hint that they are not derived). *(Corrected at P9's second review fix: this first said "dated" for every row while only the rows this package changed had been checked. Now only the eight rows checked against the code carry the date (SNAPSHOT); the other 23 say NOT RE-CHECKED on screen.)*

**Scope / residual.** The snapshot rows stay hand-maintained by design (the finding's own chain reaction: ACL and ownership semantics no single evaluator exposes).

**Checked against the code on 2026-10-07 (8 rows):**
- Edit document metadata
- Access recertification reviews
- Document-level activity history (/activity)
- Add a member (invite)
- Remove a member from the workspace
- Change a department's supervisor
- Reassign library ownership / owning team
- Per-library permission (ACL) drawer

**Not re-checked (23 rows).** These are carried from the earlier hand-written matrix and tagged NOT RE-CHECKED on screen:
- **Documents:** Browse & read documents; Upload files / create folders; Download / print (stamped when uncontrolled); Edit equipment / asset tags; Manage sets & binders; Delete documents / versions; Request deletion (owner path).
- **Publishing:** Publish / rev-up a revision; Publish over someone's checkout (reason required); Force past an active hold; Revert to a prior revision; Check out / check in documents; Place / release legal hold.
- **Reviews:** Configure review policies & rosters; Sign a review (e-signature); Auto-publish as last review signer; Acknowledge read-&-understood; Retention, disposition & purge.
- **Other areas:** Create a drafting request; Create / edit / refresh work packages; Request distribution confirmations; Confirm "I have this revision"; Create / manage projects & schedules.

Re-checking them is a documentation task for whoever next edits the snapshot. They are not part of this finding's three criteria.

---

## ALOG-15 · The capability-policy route's compare-and-set cannot see `revoke_member`'s grant strip, so a concurrent save can write a removed member's grant back

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** admin-and-org P8 (set `updated_at = now()` in `revoke_member`'s grant strip, in P8's re-creation of `revoke_member` from its newest definition, `20261043` — `20261161` since the notifications N5 merge) — by the integrator, 2026-10-02 (at the A&O P0 merge, from P0's proposed finding; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED (by reading; not exercised against a live database)
- **Blast radius:** access control / audit integrity
- **Locations:**
  - `supabase/migrations/20261043_*.sql:160-167` (`revoke_member`, newest definition): `UPDATE org_configurations SET data = jsonb_set(data, '{grants}', …)` — `updated_at` is not touched.
  - `app/api/admin/capability-policy/route.ts:134-139` (the fresh read of `data, updated_at`) and `:218-223` (the write conditioned on `.eq("updated_at", storedVersion)`).
  - No trigger on `org_configurations` stamps `updated_at`: the only one is `trg_capability_policy_write_guard` (newest body `20261137`), which audits a signed-in write and leaves `updated_at` alone.
- **Related:** `ALOG-12` (the editor's lost update; its record proposed this finding), `ORG-7`, `DEC-20` ("grants die with the membership")
- **Independently verified:** — (`author`: opened by the integrator on 2026-10-02 at the admin-and-org P0 merge, from P0's proposed finding and its final review's correction; not yet challenged)

**Mechanism.** The route reads the stored policy and its `updated_at`, builds `after` from that `before`, and writes only if `updated_at` is unchanged. `revoke_member` strips the removed member's personal grants by rewriting `data` without changing `updated_at`. A strip that lands between the route's read and its write is invisible to the compare-and-set.

**Failure scenario.** Admin A removes member X, who holds a personal grant, while Admin B's save, grant or revoke is between the route's read (`:134`) and its compare-and-set (`:218`). The compare-and-set matches, and B's `after`, built from a `before` that still holds X's grant, writes it back. The audit trail does show the strip: `trg_capability_policy_write_guard` writes its own `CAPABILITY_POLICY_CHANGED` row (`via: direct_write`, with `before` and `after`) for `revoke_member`'s update. The route's following `CAPABILITY_POLICY_CHANGED` row then carries X's grant in both `before` and `after`, so the re-add itself is not shown as a change. Nothing is admitted while X is not a member, because the evaluator refuses a non-member. If X is re-added, the grant is live again, contrary to `DEC-20`. The window is one request's read-to-write span.

**Remediation.** In P8's re-creation of `revoke_member` (its plan's migration for `ORG-7`), starting from `20261043`, the newest definition (`20261161` since the notifications N5 merge — start from it), set `updated_at = now()` in the grant-strip `UPDATE`. The route's existing compare-and-set then answers 409 in the race, with no route change.

**Done when.**
- `revoke_member`'s grant strip stamps `updated_at`, re-created from its newest definition with a lineDiff test.
- The tripwire `lib/__tests__/aoRoundGP0Records.test.ts` "the grant strip stamps updated_at, so the policy route's compare-and-set sees it" flips from `it.fails` to `it`.

---
