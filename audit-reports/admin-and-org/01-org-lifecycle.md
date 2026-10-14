# 01 · Org lifecycle, membership & teams

**14 findings** — 2 CRITICAL · 1 HIGH · 7 MEDIUM · 4 LOW (`ORG-14` opened at the projects Round G J2b integration, 2026-10-01; the split now counts the four findings the independent pass lowered to LOW, which the line had kept as MEDIUM).

Signup, invitation, removal, last-admin protection, and what offboarding orphans.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Last-admin protection trigger — `prevent_last_admin_removal()` on BEFORE UPDATE and BEFORE DELETE of org_members, correctly exempting service-role (auth.uid() IS NULL) and correctly firing on demote, suspend AND delete | `supabase/migrations/20260831_capability_policy_and_rails.sql:44-76` | The one rail that keeps an org recoverable. It also SETs search_path, unlike the org-authority helpers. Do not weaken it while fixing the missing DELETE policy — the DELETE trigger is currently unreachable from the client and will start firing once the policy lands. |
| org_members INSERT/UPDATE policies that are roles[]-aware and block a Manager from conferring Admin — `is_org_admin_or_manager` checks `role IN (…) OR roles && ARRAY[…]`, and both policies add `NOT (role = 'Admin' OR roles && ARRAY['Admin']) OR is_org_admin(org_id)` | `supabase/migrations/20260817_org_members_escalation_and_config.sql:21-53` | Closes the self-promotion hole and is the correct model for any new org_members policy. A DELETE policy should be written in the same shape. |
| create-user route defence in depth: role validated against ALL_ROLES before any write, caller must be active Admin/DocCtrl in the target org, only an Admin may grant Admin, and only an Admin may alter an existing Admin's membership on the re-add path | `app/api/admin/create-user/route.ts:41-72, 118-125` | This is the one org-membership write path that is fully guarded, and it explains why in comments (the service-role key bypasses RLS, so the route must re-implement the guard). It is the template the restore routes should follow. |
| The chunked restore route's org-boundary and table-allowlist enforcement — `if (!table \|\| !IMPORTABLE.has(table))`, `if (isSkippedTable(table))`, and `if ("org_id" in m) m.org_id = orgId;` after remapRow — with the security model stated in the file header | `app/api/admin/restore/apply-table/route.ts:8-12, 24, 38-43, 54-59` | The correct implementation already exists in the repo; the monolithic `apply` route just never received it. The fix is to copy these three checks, not to invent a model. |
| assertSafeStorageKey — one gate every storage route runs caller-supplied R2 keys through, rejecting traversal segments, control bytes, backslashes, leading and doubled slashes, with the reasoning written out (R2 does not normalize ../, but the org-prefix gate parses the FIRST orgs/<uuid>/ segment) | `lib/storageKey.ts:1-58, applied at app/api/storage/upload-url/route.ts:29 and download-url/route.ts:29` | Sound and correctly placed before the org-prefix authorization. The gap in upload-url is the missing per-AREA/role check, not the key hygiene — keep this and layer on top. |
| download-url's layered authorization: org membership, then a canDiscover check for private/hidden documents, then explicit download-deny enforcement against the chain-resolved acl_index, with the reasoning that URL issuance is the enforcement point for bytes | `app/api/storage/download-url/route.ts:36-115` | The model for what upload-url should look like. It also shows the team lookup done the right way (`.eq("uid", user.id)`), which is what ViewAsSimulator got wrong. |
| Per-library publish authority scopes team membership by org — `FROM team_members WHERE uid::text = p_uid AND org_id = p_org` — and sets search_path | `supabase/migrations/20260812_per_library_publish_authority.sql:35-37, 61-62` | The correct, org-scoped team read. `my_team_ids()` and `node_visible()` should be brought into line with this, not the reverse. |
| Schema-health card that probes every table the code expects and names the exact migration file to run, because migrations are pasted by hand and lib/ tolerates missing tables | `app/(protected)/admin/settings/page.tsx:296-383, lib/schemaExpectations.ts` | The right instinct for a hand-applied migration process, and the natural home for row-level invariant checks (org_members with no users row; team_members whose org_id disagrees with its team). |


---


<a id="org-1"></a>

## ORG-1 · /api/admin/restore/apply writes caller-supplied rows into ARBITRARY orgs and ARBITRARY tables with the service-role client — the sibling chunked route hardened exactly this and apply was left behind

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/restore/apply/route.ts:30-31 (deleted by admin-and-org P3, ILIFE-4)`, `app/api/admin/restore/apply/route.ts:75-104 (deleted by admin-and-org P3, ILIFE-4)`, `lib/dataRestore.ts:135-138`, `lib/dataRestore.ts:210-216`, `lib/dataRestore.ts:352-361`, `lib/dataRestore.ts:86-93`, `app/api/admin/restore/apply-table/route.ts:8-12`, `app/api/admin/restore/apply-table/route.ts:24, 38-40, 54-59`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the contrast with the sibling route is exact: apply-table/route.ts:24,38-40 gates on `IMPORTABLE` (ORG_SCOPED_TABLES + USER_SCOPED_FOR_ORG_TABLES) and :56 forces `if ("org_id" in m) m.org_id = orgId;` — apply/route.ts has neither line. Any Admin of any self-signup trial org can insert rows into arbitrary tables under an arbitrary org_id with RLS bypassed.

**Mechanism.** `apply` authorizes only `authorizeOrgRole(req, orgId, ["Admin"])` — Admin of the TARGET org, which anyone gets for free by self-signing-up a trial workspace. It then trusts the uploaded envelope for two things it must not trust.

(a) Org boundary. `planRestore` builds the org map from the envelope's own manifest: `const idRemap = { orgId: { [backupOrgId]: targetOrgId } … }` where `backupOrgId = env.manifest.orgId` (dataRestore.ts:100,135-138). `remapRow` rewrites `org_id` ONLY when the value is a key in that one-entry map: `if (k === "org_id" && typeof v === "string" && idRemap.orgId[v]) { out[k] = idRemap.orgId[v]; } else { out[k] = deepRemapValues(...) }` (dataRestore.ts:211-214). A row whose `org_id` is any OTHER uuid falls to the `else` branch and is written verbatim.

(b) Table allowlist. `const importable = plan.counts.tables.filter(t => t.willImport && t.rows > 0).map(t => t.name)` (apply/route.ts:75) and `plan.counts.tables` is built by iterating `Object.entries(env.tables)` (dataRestore.ts:146-151). The only filter is `SKIP_TABLES` (orgs, org_members, users, notification_preferences, subscriptions, push_subscriptions). `orderTablesForRestore` keeps unknown names (`return i === -1 ? Number.MAX_SAFE_INTEGER : i`, dataRestore.ts:354-355). The name then goes straight into `sb.from(name).upsert(chunk, …)` (apply/route.ts:104) where `sb = actor.admin` — the service-role client, RLS bypassed.

The newer chunked route does both checks and documents them: "the hard boundary enforced here is that every row lands in THEIR org: org_id is overwritten server-side with the authorized org after remapping, the table must be on the export contract (no arbitrary table writes)" — `if (!table || !IMPORTABLE.has(table))` and `if ("org_id" in m) m.org_id = orgId;` (apply-table/route.ts:38-40, 57). Neither line exists in `apply`.

**Failure scenario.** Attacker signs up a free trial org via /signup (no invite, no approval, 60-day trial) and is Admin of it. They POST /api/admin/restore/apply?orgId=<their-org>&confirm=true with a hand-written envelope: `manifest.orgId` = a throwaway uuid, and `tables.documents` / `tables.document_versions` / `tables.audit_logs` / `tables.team_members` rows each carrying `org_id: "<victim-org-uuid>"`. `remapRow` leaves those org_ids untouched (the victim uuid is not a key in the one-entry map), and each row is upserted with the service-role key into the victim tenant. Result: a forged, unapproved controlled drawing row and its version appear in a real customer's PSM library; forged `audit_logs` rows appear in that customer's regulatory audit trail; the attacker's uid is inserted into a victim `team_members` row (conflict target `team_id,uid`), which `my_team_ids()` and `node_visible()` then honour for ACL grants. Because the loop stops only on error and reports `results`, the attacker gets a per-table confirmation of what landed.

**Evidence.**

```
apply/route.ts:104 — `const up = await sb.from(name).upsert(chunk, { onConflict: conflictTargetFor(name), ignoreDuplicates: true, count: "exact" });` with `const sb = actor.admin;` (line 31). dataRestore.ts:211 — `if (k === "org_id" && typeof v === "string" && idRemap.orgId[v]) {`. apply-table/route.ts:57 — `if ("org_id" in m) m.org_id = orgId;` (the guard that is missing).
```

**Chain reaction.** Every downstream control keyed on org_id trusts these rows: the publish guard, acl_index, the audit log, and the data-export/portability contract. A forged document row with `status` set and a `current_version_id` bypasses the drafting/review workflow entirely because it never transitioned — it was inserted.

> **Verifier correction.** Minor precision: "arbitrary tables" is any table EXCEPT the six in SKIP_TABLES (orgs, org_members, users, notification_preferences, subscriptions, push_subscriptions — dataRestore.ts:86-93), and the write is an upsert with ignoreDuplicates, so it adds/leaves rows rather than overwriting existing ids. Cross-org writes also require the attacker to know the victim org's uuid. Neither changes the verdict.

**Done when.**

- [ ] `/api/admin/restore/apply` forces `m.org_id = orgId` after `remapRow`, exactly as apply-table/route.ts:57 does
- [ ] `/api/admin/restore/apply` rejects any table name not in `IMPORTABLE` (`ORG_SCOPED_TABLES` ∪ `USER_SCOPED_FOR_ORG_TABLES`), exactly as apply-table/route.ts:38-40 does
- [ ] A test posts an envelope whose rows carry a foreign `org_id` and asserts zero rows land in the foreign org
- [ ] A test posts an envelope with a table key not on the export contract and asserts a 400

**Resolution (2026-10-01, admin-and-org Round G).** Package P1 (restore boundary), first commit, together with `BKP-3`. Reproduced on HEAD `bcbf3e8` first: `app/api/admin/restore/apply/route.ts:81` was `rows.map((r) => remapRow(r, idRemap))` with nothing after it, `remapRow` rewrote `org_id` only for the one key in `idRemap.orgId` (`lib/dataRestore.ts:267`), and the table list came from `plan.counts.tables`, which `planRestore` built from every key of the uploaded envelope (`lib/dataRestore.ts:202`) — the route tests below failed against that code (12 of 13). Fix: the restore write lives in ONE function, `lib/dataRestore.ts applyRestoreChunk`, which both `/apply` and `/apply-table` call; it (1) refuses any table that is not on the export contract (`RESTORE_CONTRACT_TABLES` = `ORG_SCOPED_TABLES` ∪ `USER_SCOPED_FOR_ORG_TABLES`, `restoreTableRefusal` — the chunked route's three messages, unchanged), append-only (SURF-8) or reconciled, before any read or write; (2) remaps every row and then FORCES `org_id` to the authorized workspace with `bindRestoredRow` — set even when the row omits the key, so a hand-made row cannot land with a NULL or defaulted org; (3) bounds the two contract tables that have no `org_id` column by their parent row (`BKP-3` Done-when 3). `planRestore` marks a name that is not on the contract (and not a reconciled / append-only table an older contract carried) `willImport: false, offContract: true` with the reason, so neither the UI nor `/apply` ever attempts it; `/apply` answers **400** naming those tables BEFORE any write (no org rename, no placeholder, no row). The `DATA_RESTORE` audit row is now a checked write (`ALOG-8`'s restore/apply site).
- Files: `lib/dataRestore.ts` (`RESTORE_CONTRACT_TABLES`, `isRestoreContractTable`, `OFF_CONTRACT_REASON`, `ORG_LESS_RESTORE_PARENTS`, `restoreTableRefusal`, `bindRestoredRow`, `applyRestoreChunk`, `planRestore`'s `offContract`), `app/api/admin/restore/apply/route.ts`, `app/api/admin/restore/apply-table/route.ts`.
- Tests: `lib/__tests__/restoreApplyRoute.test.ts` — both routes run for real against an in-memory engine with PostgREST's statement semantics: "rows naming a foreign org_id land in THIS workspace — zero rows land in the foreign org" (documents, notifications, notes; the forged `audit_logs` row is never imported), "a row that omits org_id cannot land org-less", "an envelope carrying a table not on the export contract is refused with 400 before ANY write", "the chunked /apply-table refuses an off-contract table with 400 and touches nothing", "the same rows land identically through /apply-table and /apply"; `lib/__tests__/holds.test.ts`'s HLD-9 source pin now names the shared function.
- **Review fix pass (2026-10-01) — what a restored row POINTS AT.** The first landing bounded the row's `org_id` only, and its residual said "no read of another tenant's data follows" — that was false, and the finding's own `team_members` scenario still reproduced. `team_members` is read by `uid` with no org filter by `node_visible` (`20261041_rp_phase5_node_visible_additive.sql:75`), `loadReaderPrincipal` (`lib/docFileServer.ts:105`), `memberDownloadDenied` (`lib/downloadDeny.ts:72`) and `knowledgeAccess.loadPrincipal` (`lib/knowledgeAccess.ts:39`), so a restored row `{team_id: <victim team>, uid: <self>}` bound to the attacker's trial org made the victim team's grants the attacker's. Separately, a restored `checkout_episodes` row on a victim document would have taken the deployment-wide one-active index (`20260729_checkout_episodes.sql:51`) and blocked every checkout of that drawing. Fix: `lib/dataRestore.ts RESTORE_PARENT_RULES` lists every FOREIGN KEY column of a restorable table whose parent is an org-scoped table — 137 columns on 68 tables, taken from a census of `supabase/`. Before the write, `applyRestoreChunk` reads every parent a row names in the target workspace (`.in("id", …).eq("org_id", orgId)`). A row that names a parent which is elsewhere, or missing, is refused per row (`parent_outside_workspace`, in the response and the `RESTORE_CHUNK` row) and never written. An unreadable parent table fails the chunk closed. A self-reference (a version superseding another, a sub-folder, a milestone or message thread) may also name a row of the same chunk, but only when that id is new to the deployment. An id another workspace holds is skipped by `ON CONFLICT DO NOTHING`, so a child naming it would point there. `restoreRowsInOrder` puts such rows parents-first, so no chunk names a row a later chunk carries. The org-less rule (`ORG_LESS_RESTORE_PARENTS`) is now the required case of the same check: a NULL bounding parent is refused. Two parent tables have no `org_id` and are waived in writing (`RESTORE_FK_PARENT_WAIVERS`): `orgs` (the forced `org_id` itself) and `users` (a person's uid in `teams.created_by` and `team_members.uid` / `added_by`, which the email reconciliation remaps). Every lookup the restore makes by a table name or a text value is now own-key only. Before this, a table key named `constructor` or `__proto__` was taken as a skipped table, and `/apply` answered 200 instead of the 400 Done-when 4 requires.
- Fix-pass tests: `lib/__tests__/dataRestore.test.ts`:
  - "a foreign key to an org-scoped parent has a rule; one to a parent with no org_id names a waived parent". This is the census. `lib/__tests__/helpers/schemaKeys.ts` now collects foreign keys: inline `REFERENCES`, table-level `FOREIGN KEY`, `ALTER … ADD COLUMN … REFERENCES` and `ALTER … ADD CONSTRAINT … FOREIGN KEY`, less later `DROP CONSTRAINT` / `DROP COLUMN`.
  - "every rule is a real foreign key of a restorable table".
  - "the review's minimum set is covered".
  - "a table named after an Object.prototype key is off contract".

  `lib/__tests__/restoreApplyRoute.test.ts`:
  - "a team_members row naming another tenant's team is refused and never written" (both routes).
  - "a checkout episode on another tenant's document never lands".
  - "versions, project links, sessions and intents naming another tenant's rows are refused row by row".
  - "a self-reference may name a NEW row of the same chunk — never a row another workspace holds behind a skipped id".
  - "a long version chain written newest-first restores whole across chunks".
  - "an unreadable parent table fails the chunk closed".
  - "'constructor' and '__proto__' table keys are refused by the single-shot route".

  Each fails with its rule removed: checked by mutation, with the team_members rule dropped, the parents-first sort disabled, and the prototype lookups reverted.
- **Review fix pass 2 (2026-10-01).**
  - *The `users` waiver rested on a false premise; corrected.* It said a person's uid in `teams.created_by` / `team_members.uid` / `added_by` was "remapped by the email reconciliation". For a restored placeholder it is remapped to a fresh uid that is no sign-in account, and `users.id` references `auth.users`, so no profile row can exist for it and the database refuses every row naming it. `RESTORE_FK_PARENT_WAIVERS.users` now says so. The new `RESTORE_USER_REFERENCES` reads `users` before the write: a placeholder is cleared from a nullable column and refuses a team membership (`person_not_restored`). See `BKP-5` fix pass 2.
  - *Storage keys are bounded (closes the review's minor on this residual).* `remapOrgPath` rewrites only the BACKUP org's `orgs/<id>/` prefix. A restored `document_versions.file_url` (or any other value) could still name another tenant's prefix, and `lib/docFileServer.ts:322-351` reads `file_url` with the service role and checks no prefix (checklist segmentation and quality-manual review resolve through it). `applyRestoreChunk` now refuses, per row, any row carrying a string — top level or deep inside JSONB — with a storage key under an `orgs/<uuid>/` prefix other than the target workspace's (`lib/dataRestore.ts foreignStorageKey`, code `storage_key_outside_workspace`). Tests: `lib/__tests__/restoreApplyRoute.test.ts` "a version naming another tenant's object is refused; one under the backup's prefix is moved to this workspace's and lands" and "deep inside JSONB too (single-shot route); text that merely mentions 'orgs/' is data"; `lib/__tests__/dataRestore.test.ts` "foreignStorageKey".
  - *The read-only check is recorded.* The first fix pass said the parent reads added "no new existence oracle beyond what the apply already showed". That was true of the write, not of `preview: true`, a read-only and unaudited probe of whether arbitrary keys are held in other workspaces: for example whether user U is in team T, or has viewed document D, in another tenant. Any Admin could run it, including the Admin of a self-signup trial org, and it left nothing behind, where the write probe it replaced was audited as `RESTORE_CHUNK`. Every preview call now writes a `RESTORE_PREVIEW` audit row (table, rows, existing, heldElsewhere, wouldInsert, backup org). It is a checked write: when the row cannot be written, no counts are answered. Test: "a preview call leaves a RESTORE_PREVIEW row; when it cannot, the answer is withheld". The probe itself remains, for an Admin and now on the record: an Admin can still learn that some workspace holds a key they name.
  - *A row already held is counted, not refused.* A row the parent rule would refuse whose key is already in this workspace (kept) or another (held elsewhere) is counted as such (`BKP-5` fix pass 2).
- **Review fix pass 3 (2026-10-01) — the mail queue (blocker).** The restore writes with the service role, so it bypasses every client rail. One of those rails is the mail queue's INSERT policy (SURF-17, `20261047_rp_phase6_sweep_integrity_rails.sql:208-217`): mail only to a member of the same org, and never `metadata.external`. `email_notifications` was a restorable contract table, and the drain (`app/api/notifications/send-queued/route.ts:127-131`) sends every `queued` / `failed` row under five attempts. So the Admin of a self-signup trial workspace could POST `/apply-table` rows with any external address and HTML body as `queued`, and the cron sent them from the platform's notifications address: an open relay through the one write path this finding bounds. The base had the same hole. `email_notifications` is now in `SKIP_TABLES`, and no restore writes a row of it on either route. A skipped table's 400 now names its reason (`Table "email_notifications" is never blind-imported (the outbound mail queue — …)`), where it said "reconciled" for every one. Landing the rows terminal was rejected: the Admin's dead-letter re-queue makes a `failed` row sendable again, with its address and body unchanged. See `BKP-11`'s fix-pass-3 paragraph for the tests; each fails with the entry removed.
- **Review fix pass 4 (2026-10-01) — the class, not its first instance (major).** The mail queue was one service-role-only table the restore could still write. `ai_key_agreements` was another. `20260916_ai_governance.sql` makes it service-role only (`REVOKE ALL … FROM public, anon, authenticated`, no policy). Its only writer, `POST /api/ai/agreement`, records the caller's OWN acceptance (name, agreement version, IP, time), and the AI ask gates read it (`app/api/knowledge/ask/route.ts`, `app/api/orchestrator/route.ts`, `lib/ai/governedCall.ts`, `app/api/codebook/import/route.ts`). An Admin could `/apply-table` an agreement row for every member under the current version, and each member then passed the gate without ever seeing the agreement. That is a signature nobody gave, the forgery SURF-8 refuses for `e_signatures`. Likewise `ai_usage_limits`: its only writer, `POST /api/ai/usage`, is controller-gated, bounds a cap to 0..10000 and audits it, and the restore wrote any value unaudited. Fix in `lib/dataRestore.ts`:
  - `ai_key_agreements` is in `IMMUTABLE_TABLES` ("acceptable-use agreements are the signer's own act — written only by /api/ai/agreement").
  - `ai_usage_events`, the spend ledger the caps sum, is in `IMMUTABLE_TABLES` too: a restored row would move this month's spend, and `est_cost_usd` has no CHECK, so a negative cost would lift a cap.
  - `ai_usage_limits` is in `SKIP_TABLES`: caps are re-set through the controller route after a restore, and the default cap applies until then.
  - The class is fenced by a census. `lib/__tests__/helpers/schemaKeys.ts censusServiceRoleWriteTables` reads `supabase/` in order and lists every table left with no INSERT privilege for `authenticated` (a `REVOKE ALL`, or a REVOKE listing INSERT, not undone by a later GRANT). On the contract that is exactly the seven tables the review named. `lib/__tests__/dataRestore.test.ts` "ORG-1 (fix pass 4)" requires each one to be in `SKIP_TABLES` or `IMMUTABLE_TABLES`, or in the new `RESTORE_SERVICE_ROLE_WAIVERS` with a written reason. Three are waived: `archive_settings` (the location hint and alert threshold an Admin / Doc Control sets anyway), `archives` (the catalog restored versions' archive labels name; a reclaim still frees only this workspace's keys after its hold and shared-key checks) and `knowledge_page_entities` (derived index rows, bounded by `RESTORE_PARENT_RULES`, replaced on re-index). `turnover_review_events` was already append-only. A waiver must name a restorable, service-role-only contract table, so it cannot go stale.
  - Tests: the census (with a synthetic-schema sanity test of its REVOKE / GRANT reading) and "the review's tables: agreements and the spend ledger are append-only, the caps are skipped — none is planned or written" in `lib/__tests__/dataRestore.test.ts`; "/apply-table refuses each table with 400 before any read or write" and "the single-shot /apply and the page's driver plan them out and land the rest" in `lib/__tests__/restoreApplyRoute.test.ts`. Checked by mutation: with either AI entry removed, 4 tests fail.
  - The reconciliation the boundary rests on is checked now too (`BKP-5` fix pass 4). An unchecked member read planned every person new, and a swallowed placeholder insert let a person's rows land naming the raw backup uid. Both now stop `/begin` and `/apply` before any table is written.
- **Review fix pass 5 (2026-10-01) — every uid of the backup's membership list is mapped, or every row naming it is refused (major).** Fix pass 4's records said every person in the backup is mapped before any row is written. That was not so. `planRestore` kept only the first backup `org_members` row per address and skipped rows with no address (`lib/dataRestore.ts:511` before this pass), so their uids never entered `idRemap.uid`, and rows naming them landed with the raw backup uid. The export carries members of every status, and `20261018_identity_email_unique.sql` allows an inactive historical row beside a re-added active one, each under its own uid. The review reproduced it: with `{old-bob-inactive, bob@acme.com, inactive}` before `{old-bob-active, Bob@acme.com, active}` in the backup and `live-bob` here, a document owned by `old-bob-active` landed owned by `old-bob-active`. On a fresh deployment Bob's team membership was refused (`person_not_restored`) though Bob was linked; on the same deployment it landed under a uid that is no member of this workspace (the cross-tenant case fix pass 4's Risk names). `org_members.email` is nullable, so a member with no address was dropped the same way. Fix in `lib/dataRestore.ts planRestore`:
  - One person per address. The row with the earliest status in `RESTORE_LINK_MEMBER_STATUSES` (then the first given) speaks for the person (name, role). Every other row's uid is an alias (`UserReconcileItem.aliasUids`) mapped to the same person: to the linked member in `idRemap.uid`, and to the one placeholder `/begin` and `/apply` create (`created[alias] = newUid`). A uid is given to one person only.
  - A member with no address links by uid when this workspace has a member under that very uid (a restore into the workspace that still holds them, where those rows are already correct). The routes and the page now pass members with no address to the planner (`CurrentMember.email` may be null).
  - Otherwise no person here can be found for that uid. It is listed (`idRemap.unmappedUids`, `counts.unmappedUsers`, a plan warning naming them, `unmappedMembers` in the `/begin` and `/apply` responses and in `RESTORE_BEGIN` / `DATA_RESTORE`, a line in the result panel). `applyRestoreChunk` refuses every row that names one, at the top level or inside JSONB (`person_not_mapped`), and the run goes on; a row under a refused one is refused by its parent rule. Minting a placeholder with no address was rejected: nothing could link it again, so a re-run would mint a second one under a new uid and land every uid-keyed row twice (`BKP-5` fix pass 3).
  - `counts.newUsers` now counts exactly the placeholders `/begin` creates (a person with no uid of their own names no row and gets none).
  - Tests: "BKP-5 / ORG-1 (fix pass 5)" in `lib/__tests__/restoreApplyRoute.test.ts` (6 tests: the plan maps both rows; the review's run through the real `/begin` + `/apply-table`, where the document owned by the second uid lands owned by `live-bob` and Bob's team membership lands; a new person with two rows gets one placeholder on both routes and a re-run links it; a member with no address is unmapped and their rows refused on both routes, JSONB included; the same member linked by uid in the workspace that holds them; the routes and the page pass members with no address), and two planner tests in `lib/__tests__/dataRestore.test.ts`. Checked by mutation: without the alias map 3 tests fail; without `created[alias]` 2 fail on `/begin` and 2 on `/apply`; without the refusal 1 fails; without the uid link 1 fails.
- **Review fix pass 6 (2026-10-01) — the refusal of an unmapped member names the right remedy (minor).** For a table in `RESTORE_USER_REFERENCES` (`team_members`, `teams`), a row naming an unmapped member with no address was refused as `person_not_restored` ("no sign-in account on this deployment (a restored placeholder) — re-invite the person"), because `applyRestoreChunk`'s `outside()` reported the profile check before the unmapped check. No placeholder exists for such a member and re-inviting cannot help. The row was refused either way, so no data was harmed. `outside()` now reports `person_not_mapped` first (`unmappedRefusal.get(r) ?? personRefusal.get(r)`). Test: the fix-pass-5 test "a backup member with no email address and no member here is unmapped: … refused (both routes)" now carries `teams` + `team_members` and asserts `team-1/old-ghost` is refused `person_not_mapped` on the page's driver and on `/apply`. Checked by mutation: with the old order, that test fails.

**Done-when.**
- [x] `/api/admin/restore/apply` forces `m.org_id = orgId` after `remapRow` ✓ — through the shared `applyRestoreChunk` / `bindRestoredRow`, stricter than `apply-table:57` was (the key is set even when absent).
- [x] `/api/admin/restore/apply` rejects any table name not in `IMPORTABLE` ✓ — `restoreTableRefusal` inside the shared function, and a 400 from `/apply` before any write when the envelope carries rows for one.
- [x] A test posts an envelope whose rows carry a foreign `org_id` and asserts zero rows land in the foreign org ✓ (`restoreApplyRoute.test.ts`, first test).
- [x] A test posts an envelope with a table key not on the export contract and asserts a 400 ✓ (single-shot and chunked; since the fix pass, also for a name that is an `Object.prototype` key).

**Scope / residual.** *Corrected at the review fix pass:* the first residual said a foreign key naming another tenant's row was harmless ("no read of another tenant's data follows"). That was wrong (see the fix-pass paragraph above), and such keys are now checked. What is bounded now:
- the row's org (forced);
- every column the schema declares a FOREIGN KEY to an org-scoped table, checked in the target workspace. The census test fails on any new declared foreign key that has no rule or waiver.
- *(fix pass 2)* every person a `users` foreign key names: they must have a profile on the deployment, or they are cleared from a nullable column or refuse the row;
- *(fix pass 2)* every storage key under the `orgs/<uuid>/` layout, top level or in JSONB: it must be under the target workspace's prefix;
- *(fix pass 3)* the outbound mail queue: never written by a restore, so nothing a restore writes is sent.
- *(fix pass 4)* every contract table `supabase/` makes service-role only for writes: never written by a restore (agreements and the AI spend ledger are append-only, the AI caps are skipped), or waived in writing (`RESTORE_SERVICE_ROLE_WAIVERS`), with a census test that fails on a new one;
- *(fix pass 4)* a failed member read, rename or placeholder insert stops the restore before any table. *Corrected at the fifth review:* this line said "every person in the backup is mapped before any row is written". It was not so: a second membership row of one address and a member with no address were never put into the uid map, and rows naming them landed with the raw backup uid.
- *(fix pass 5)* every uid of the backup's membership list is mapped before any row is written (every row of an address maps to that person; a member with no address links by uid to this workspace's member under it), or it is listed as unmapped and every row naming it is refused (`person_not_mapped`, reported ahead of a missing profile since fix pass 6).

What is NOT checked:
- a column that holds another row's id WITHOUT a declared foreign key (for example `document_favorites.document_id`, `curated_collection_items.document_id`);
- ids inside JSONB (`acl_index` grants, transmittal item lists);
- *(fix pass 2)* a storage key OUTSIDE the `orgs/<uuid>/` layout (a legacy key with no org prefix). Readers that resolve a stored key with the service role, such as `lib/docFileServer.ts`, do not check any prefix, and the download route (`app/api/storage/download-url/route.ts:46-54`) authorizes only keys that carry one.
- *(fix pass 4)* a table whose INSERT is closed by RLS alone (RLS on, no INSERT policy, the privilege left in place) is outside the census, which reads REVOKE / GRANT only. The known append-only ones of that kind are SURF-8's `IMMUTABLE_TABLES` entries (`e_signatures`, `download_audits`, …). A new one is caught only if its migration revokes the privilege. The in-app `notifications` table is still restorable; no review raised it.
- *(fix pass 5)* a uid that is in NO row of the backup's `org_members` (a person removed from the workspace before the backup was taken) is in neither the uid map nor the unmapped list, so a row naming it lands with that uid, as before this package. The planner sees only the membership list; telling such a uid from any other UUID value in a row would need the column-by-column audit `DEC-31` leaves out.

The database does not bind those either, so a hand-made backup can make them name another tenant's id. Whether any reader follows one across tenants with the service role was not audited column by column (`DEC-31`). `/apply` stays as the small-backup path (now sharing the chunked route's write and its stop-on-failure rule) rather than being deleted — intelligence `ILIFE-4` criterion 2 ("deleted or wired as the small-backup path") can cite this. Since fix pass 2, the placeholder's refused profile row is counted and reported instead of swallowed. Since fix pass 3, the reconciliation links a backup person to the workspace's member of any status. A re-run therefore links the placeholders an earlier run created and creates no second one (`BKP-5` fix pass 3). *Corrected at the fourth review:* this record said the org-name update and the placeholder inserts were unchanged and outside this finding. They were unchecked, along with the member read, and a failed one let rows land naming an unmapped backup uid. Since fix pass 4 all three are checked, and a failure stops `/begin` and `/apply` before any table is written (`BKP-5` fix pass 4).

*Cross-note (2026-10-01, admin-and-org Round G, P3).* The sentence above that `/apply` "stays as the small-backup path … rather than being deleted" is out of date. `app/api/admin/restore/apply/route.ts` had no caller, and admin-and-org P3 deleted it under intelligence `ILIFE-4` (criterion 2: "deleted or wired as the small-backup path" — deleted). The restore has one door now: `/api/admin/restore/begin`, then `/api/admin/restore/apply-table`, whose writes go through `lib/dataRestore.ts applyRestoreChunk`. This finding's boundary (the allowlist, the forced org, the parent rule) lives in that shared write, so nothing here is lost with the route. Its tests moved to the chunked path (`lib/__tests__/restoreApplyRoute.test.ts`); `lib/__tests__/restoreArchiveRoundTrip.test.ts` pins the route's absence.

---

<a id="org-2"></a>

## ORG-2 · org_members has NO DELETE policy — "Remove from workspace" silently deletes nothing and reports success, so an offboarded engineer keeps access to controlled drawings

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/users/page.tsx:167-187`, `supabase/migrations/20260817_org_members_escalation_and_config.sql:44-53`, `supabase/schema.sql:1013`, `supabase/schema.sql:1048-1053`, `supabase/migrations/20260831_capability_policy_and_rails.sql:73-76`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified as a claim of absence by repo-wide search. Corroborating intent: 20260831_capability_policy_and_rails.sql:73-76 installs a BEFORE DELETE trigger on org_members, i.e. deletion is expected to work, but nothing grants it. There is no service-role removal route either (app/api/admin/ has create-user but no remove/delete-user).

**Mechanism.** `schema.sql:1050` originally created `CREATE POLICY "org_members_write" ON org_members FOR ALL USING (…Admin/Manager…)` — a FOR ALL policy, which covered DELETE. Migration 20260817 then does `DROP POLICY IF EXISTS org_members_write ON org_members;` and recreates it as `CREATE POLICY org_members_write ON org_members FOR INSERT WITH CHECK (…)` (lines 44-53), plus `org_members_update` FOR UPDATE (lines 31-42). A full inventory of every `CREATE POLICY … ON org_members` across supabase/schema.sql, supabase/migrations/*.sql and supabase/REMEDIATION_APPLY_ALL.sql yields exactly three: org_members_read (SELECT), org_members_update (UPDATE), org_members_write (INSERT). RLS is enabled (`ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;`, schema.sql:1013), so DELETE is default-deny for every non-service-role caller.

The only removal path in the app is client-side against the user (anon-key) client: `const { error } = await supabase.from('org_members').delete().eq('id', member.id); if (error) throw error;` (users/page.tsx:178-179). An RLS-filtered DELETE that matches zero rows is not an error — PostgREST returns 204 and supabase-js resolves `{ error: null }`. The `if (error) throw error` therefore passes, and line 180 runs `setMembers(prev => prev.filter(m => m.id !== member.id))`, removing the row from the table on screen only.

Separately, the UI offers no other revocation: the page renders `m.status` (line 324) but has no control to set it, so the schema's `'suspended'`/`'inactive'` states (schema.sql:42) are unreachable from the product. There is no working way to revoke a member.

**Failure scenario.** A drafter is terminated. The Admin opens /admin/users, clicks the trash icon, confirms the dialog whose text promises "They lose access immediately", the row disappears, no error is shown. The `org_members` row is untouched, `status` is still `'active'`, so `my_org_ids()` still returns the org and every permissive RLS policy still admits them. The ex-employee's session (and any new login — the confirm dialog itself notes the login account is deliberately not deleted) retains full read/download access to the org's controlled P&IDs and isometrics. Nobody notices until someone reloads /admin/users and sees the member is still listed — which reads as a UI bug, not as a failed revocation.

**Evidence.**

```
20260817_org_members_escalation_and_config.sql:44-46 — `DROP POLICY IF EXISTS org_members_write ON org_members;` / `CREATE POLICY org_members_write ON org_members` / `  FOR INSERT`. users/page.tsx:178-180 — `const { error } = await supabase.from('org_members').delete().eq('id', member.id);` … `setMembers((prev) => prev.filter((m) => m.id !== member.id));`. `grep -rn "FOR DELETE" supabase/ | grep -i member` returns nothing; `grep -rni "org_members_delete" supabase/` returns nothing.
```

**Chain reaction.** 20260831 adds `trg_prevent_last_admin_delete BEFORE DELETE ON org_members` — a guard written for a DELETE path that RLS makes unreachable from the client, which is why nobody noticed the policy gap. schema.sql still declares the old `FOR ALL` policy, so a fresh deploy from schema.sql alone behaves differently from a migrated one (there, a Manager could also DELETE and INSERT Admins).

**Done when.**

- [x] A `org_members_delete` policy exists (Admin/Manager of the row's org, roles[]-aware like `is_org_admin_or_manager`), or removal moves to a service-role route that verifies the caller
- [x] `handleRemoveMember` checks the affected row count, not just `error`, and refuses to update local state when zero rows changed
- [x] schema.sql's `org_members_write FOR ALL` is reconciled with 20260817 so fresh and migrated databases have the same policy set
- [x] The users page exposes suspend/reactivate so `status` can actually be changed

**Resolution (2026-10-02, admin-and-org Round G).** A record-only close, by pointer to roles-and-permissions `SURF-1` and `OWN-12`. Both were built in Phase 6 (commit `1f4991c`), together, as `DEC-20` requires.
- Migrations: `20261042_rp_phase6_revocation_and_succession.sql`, and `20261043_rp_phase6_legal_hold_and_force_release.sql`, whose §0 repairs `revoke_member`. Both were applied and verified live on 2026-09-02 and are marked LIVE in `audit-reports/MIGRATION-PASTE-ORDER.md`.
- App: `lib/members.ts` and `app/(protected)/admin/users/page.tsx`.
- No code changed in this package. New pin: the ORG-2 block of `lib/__tests__/aoRoundGP0Records.test.ts`, for done-when 3 (commit `447bb8b`).
- Reproduced: at the audit snapshot no `org_members` DELETE policy existed. On base `f1ac550` the mechanism no longer holds, as each item below shows.

**Done-when.**
- ✓ 1. `org_members_delete` exists (`20261042:34-45`). It is `FOR DELETE` for an active Admin of the row's org, by role collection (`me.role = 'Admin' OR me.roles && ARRAY['Admin']::text[]`), and never on your own row.
  - Removal also runs through the SECURITY DEFINER RPC `revoke_member` (newest body `20261043:45-194`), which verifies the caller. Remove is the Admin's (`:77-81`). Suspend and restore are the Admin's or the Manager's, through `is_org_admin_or_manager`, and only an Admin may touch an Admin (`:82-91`). That is also the criterion's second form.
  - It is narrower than the criterion's "Admin/Manager" for hard removal. That is roles-and-permissions `SURF-1`'s build under `DEC-20` (`20261042` header, item 1: "org_members DELETE policy — Admin (by collection) only"); `DEC-20` itself names the two paths, not who may take each. Hard removal is the Admin's, suspension the Admin's or the Manager's.
- ✓ 2. The zero-row "success" is gone, not just detected.
  - `handleRemoveMember` (`users/page.tsx:274-298`) no longer issues a client `delete()`. It calls `revokeMember` (`:286`).
  - The RPC writes as definer, so RLS cannot zero-filter the statement. Each failure raises: a missing row (`20261043:66-69`), every authority refusal, and the last-admin trigger (`trg_prevent_last_admin_delete`, `20260831:74`, which this path now reaches).
  - `lib/members.ts:34-39` throws on an RPC error, and on a result whose `mode` is not the one requested ("The change was not confirmed by the database — nothing was changed.").
  - The page changes local state only after that call resolves (`users/page.tsx:287`).
  - Pinned by `rpPhase6Additive.test.ts` "SURF-1 / DEC-20 — revokeMember" (including `/not confirmed/`) and "members page: suspend is the default action, remove is confirmed, both go through revokeMember; no bare delete".
- ✓ 3. `supabase/schema.sql` is now the declared pre-migration baseline (`schema.sql:3-27`; PKG-14 / HLD-12 / DB-8). Its header says: "THIS FILE ALONE IS NOT A COMPLETE INSTALL", "run this file FIRST, then EVERY file in supabase/migrations/ … The migrations are MANDATORY", and "Never re-run this file on a live database".
  - So the only fresh install replays `20260817:44-53`, which drops the baseline `org_members_write FOR ALL` (`schema.sql:1088`) and re-creates it `FOR INSERT`. It then replays `20261042`'s DELETE policy.
  - The bundle that could restore over it is retired (`DB-8`: `REMEDIATION_APPLY_ALL.sql` is a stub that raises). The baseline text stays in `schema.sql` as frozen history.
  - Pin: `aoRoundGP0Records.test.ts` "replaying schema.sql then every numbered migration leaves SELECT / UPDATE / INSERT / DELETE — the baseline FOR ALL is dropped". It runs a policy census in textual order and gets `org_members_read` SELECT, `org_members_update` UPDATE, `org_members_write` INSERT and `org_members_delete` DELETE, and no `ALL`.
- ✓ 4. Suspend (the default action) and Restore are on the members page (`users/page.tsx:249-272`, buttons `:494-509`). Both go through `revokeMember`.
  - Suspend writes `status = 'suspended'` (`20261043:103-111`), which `my_org_ids()` and every RLS predicate exclude.
  - `my_team_ids()` follows active membership (`20261042`, `DEC-20`).

**Scope / residual.** None for this finding. One note for the next owner: admin-and-org P8's brief says to re-create `revoke_member` "VERBATIM from 20261042". Its newest definition is `20261043:45-194`, and P8 should start from that. *(Integrator, at the notifications N5 merge, 2026-10-02: `revoke_member`'s newest definition is now `20261161` — N5 re-created it from `20261043` §0 verbatim plus the `NEDGE-7` notification tombstone, and a tripwire test fails if a later definition drops it. P8 re-creates it from `20261161`, found by scanning, never from `20261043`.)* `20261043` §0 fixed `active_collaborators = '{}'::text[]`; 20261042's body assigned `'[]'::jsonb` there, which raises 42804. A second note for P8: the grant strip in that body (`20261043:161-167`) leaves `updated_at` unchanged, so the capability-policy route's compare-and-set cannot see it. `ALOG-12`'s record proposes that as a LOW finding owned by P8, fixed by `updated_at = now()` in the same `UPDATE` when P8 re-creates the function.

---

<a id="org-3"></a>

## ORG-3 · "Request Access" is a black hole with a cross-tenant leak: nothing ever reads access_requests, any Admin of any org can read every tenant's requests, anon can insert unbounded rows, and the client shows "Request Sent" even on a 404/409

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/signup/page.tsx:83-100`, `app/signup/page.tsx:236-241`, `app/api/auth/request-access/route.ts:1-64`, `supabase/migrations/20260819_orphan_tables_backfill.sql:15-30`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All four sub-claims hold. Note an extra defect the finding did not name: the migration's table has no org_id column while the route inserts `org_id` (route.ts:47), so on a from-migrations rebuild the insert 500s — and the client still shows "Request Sent" because res.ok is never checked.

**Mechanism.** Four independent defects in one flow.

(1) No consumer. Repo-wide, `access_requests` appears only in: the migration that creates it, the route that inserts into it, `lib/schemaExpectations.ts:31`, `lib/exportTables.ts:91` and `lib/dataRestore.ts:315`. There is no admin page, no query, no notification, no email. Two search shapes (`grep -rn access_requests` over ts/tsx/sql, and a directory listing of app/(protected)/admin — archive-view, ai-instructions, analytics, assets, audit, billing, branding, codebook, data-export, holds, libraries, permissions, proposed-links, requests(=drafting config), restore, scope, settings, storage, teams, users) confirm no surface reads it. The route's own reply says "Please wait for an admin to respond" (line 40) and the page says "This form notifies them of your request" and "You'll get an email with login instructions" (page.tsx:236-241). None of that is implemented.

(2) Cross-tenant SELECT. `CREATE POLICY access_requests_admin_select ON access_requests FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'))` — the USING clause never references the row. It asks only "is this user an Admin *somewhere*", so it grants every Admin SELECT over every row in the table, for every tenant.

(3) Unbounded anon INSERT. `CREATE POLICY access_requests_anyone_insert ON access_requests FOR INSERT WITH CHECK (true)` — anon can POST rows directly to PostgREST with no rate limit and no org validation. Contrast the signup route, which has a per-IP limiter (signup/route.ts:10,19-29).

(4) Client ignores the response. `await fetch('/api/auth/request-access', …); setRequestSent(true);` (page.tsx:90-95) — `res.ok` is never checked, so the 404 "No organization named X was found" and the 409 "already have a pending request" both render the green check and "Request Sent". Additionally the route reads/writes `org_id` (lines 34, 47) but the table as reconstructed in 20260819 has no `org_id` column — on a fresh rebuild that INSERT fails with 42703 and returns 500, which the client still renders as success.

**Failure scenario.** A new process engineer at a customer plant types their org name, sends an access request, and sees "Request Sent — your organization's admin will receive your request". No admin ever sees it: nothing reads the table. Meanwhile an attacker signs up a throwaway trial org (making themselves Admin), then `GET /rest/v1/access_requests` and receives every access request ever filed against every customer org — full names, work emails, and which named plant each person works at, i.e. a ready-made target list for a phishing campaign that impersonates the document-control system.

**Evidence.**

```
20260819_orphan_tables_backfill.sql:29-30 — `CREATE POLICY access_requests_admin_select ON access_requests FOR SELECT TO authenticated` / `  USING (EXISTS (SELECT 1 FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'));` — no correlation to `access_requests.*`. signup/page.tsx:90-95 — `await fetch('/api/auth/request-access', {…}); setRequestSent(true);`. request-access/route.ts:47 — `org_id: orgId,` against a table whose migration (lines 16-24) declares only id/display_name/email/org_name/message/status/created_at.
```

**Chain reaction.** Because nothing surfaces access requests, the ONLY way into an existing org is an Admin hand-typing a temporary password in /admin/users (users/page.tsx:400-407) — a plaintext password the Admin must then transmit out-of-band. The missing queue is why that pattern exists.

> **Verifier correction.** The org_id/42703 sub-claim is CONFIRMED only for a fresh rebuild from migrations; the table is IF NOT EXISTS and the migration says the live DB is the source of truth, so on production the insert may well succeed. That sub-point is SUSPECTED; the other three are confirmed.

**Done when.**

- [x] `access_requests_admin_select` correlates the row to the caller's org (`is_org_admin(access_requests.org_id)`), and the table has an `org_id` column in the migration
- [x] An admin surface lists pending access requests and an approve action creates the member, or the Request Access mode is removed from /signup
- [x] `handleRequestAccess` checks `res.ok` and surfaces the route's error text
- [x] The route is rate-limited like /api/auth/signup, and the direct anon INSERT policy is removed in favour of service-role-only writes

**Resolution (2026-10-02, admin-and-org Round G).** A record-only close, by pointer to:
- roles-and-permissions `EGRESS-5`: all four `DEC-19` deliverables, commit `44711ca`, plus its 2026-08-24 completion round;
- identity-and-session `IDENT-6`: commit `c111433`, the page half.

Migration `20261023_access_requests_scope_and_limit.sql` was applied and verified live on 2026-08-24 and is marked LIVE in the paste guide. No code changed in this package. New pins: the ORG-3 block of `lib/__tests__/aoRoundGP0Records.test.ts` (commit `447bb8b`). Each item below was verified on base `f1ac550`.

**Done-when.**
- ✓ 1. `access_requests_admin_select` correlates the row to the caller's org (`20261023:26-36`): `m.org_id = access_requests.org_id AND m.uid = auth.uid() AND m.status = 'active' AND (m.role = 'Admin' OR m.roles && ARRAY['Admin']::text[])`. This is the inline, additive-roles form of `is_org_admin(access_requests.org_id)`.
  - The migration adds `org_id uuid REFERENCES orgs(id)` (`:17`) and backfills it by org name. A row with no match stays NULL and is visible to no one.
  - A census of every policy on the table, over `schema.sql` then the numbered migrations in order, leaves exactly this one. Pin: "done-when 1 / 4: one SELECT policy, correlated on the row's org and additive-roles aware; no INSERT policy survives".
- ✓ 2. `/admin/users` lists the org's pending requests to Admins (`users/page.tsx:136-146` reads them; the card starts at `:373`).
  - "Add" pre-fills the member form. `/api/admin/create-user` then marks the matching org-and-email rows `approved` (`app/api/admin/create-user/route.ts:38-46`, called at `:273` and `:351`).
  - "Decline" goes through `/api/admin/access-requests`, which checks against the org the stored request names (`accessRequestDecline.test.ts`).
- ✓ 3. `handleRequestAccess` checks `res.ok` and throws the route's `error` text into the page's alert before it calls `setRequestSent(true)` (`app/signup/page.tsx:102-106`; `IDENT-6`). Pin: "done-when 3: handleRequestAccess reads res.ok before it shows the success screen".
- ✓ 4. The route shares signup's per-IP `signup_attempts` window of 8 per hour (`app/api/auth/request-access/route.ts:10`, `:18-28`, `:38-43`; signup's `SIGNUP_MAX_PER_HOUR = 8` is at `app/api/auth/signup/route.ts:11`). It records an attempt before the org lookup (`:57`).
  - The anonymous `WITH CHECK (true)` insert policy is dropped (`20261023:43`) and no migration re-creates one, so the only writer is the service-role route (`:103`).
  - Pins: `requestAccessRoute.test.ts` (429 before any org read or insert; an attempt recorded), and the census pin above.

**Scope / residual.** None for this finding. `ORG-8` (OPEN, admin-and-org P5) holds the org-name oracle (404 versus 200) and the limiter's fail-open on a missing table (`route.ts:26`).

Outside this finding's criteria, and left to the integrator: two reads on `/admin/users` ignore `{ error }`. supabase-js returns `{ data: null, error }` on a failed query rather than throwing.
- The pending-requests read (`app/(protected)/admin/users/page.tsx:139`, `const { data } = await supabase.from('access_requests')…`; `:145`, `setPendingRequests((data ?? []) …)`). A failed read leaves the list empty, and the card is drawn only when `pendingRequests.length > 0` (`:374`). So while the read fails, the Admin sees no requests and no sign that anything failed.
- The members read (`:119`, `const { data } = …`; `:124`, `setMembers(data || [])`). A failed read draws an empty roster with no error.

No request is lost or exposed; the rows stay in `access_requests`. admin-and-org P8's plan entry already lists `app/(protected)/admin/users/page.tsx`. This package proposes that the integrator open it as a new LOW finding in this report, owned by P8: both reads check `{ error }` and show an error state instead of an empty list. *(Opened by the integrator at the A&O P0 merge, 2026-10-02, as `ORG-15`, owned by P8.)* It is not opened here, because that changes the area README's counts and `99-fix-sequencing.md`, which this package does not edit.

---

<a id="org-4"></a>

## ORG-4 · A DocCtrl can edit Request Numbering in /admin/settings and be told "Saved" — the orgs RLS policy admits only Admin, so the write matches zero rows and returns no error

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/settings/page.tsx:25, 39, 103-120`, `supabase/schema.sql:1042-1045`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: a DocCtrl's UPDATE matches zero rows, PostgREST returns no error, and the code treats no-error as success. MEDIUM is appropriate — silent data loss on the numbering scheme, no security boundary crossed.

**Mechanism.** The page gates on `const ADMIN_ROLES = new Set(["Admin", "DocCtrl"]); const canRead = !!activeRole && ADMIN_ROLES.has(activeRole);` (lines 25, 39) — a DocCtrl gets the full page including the editable Request Numbering card and its Save button. `saveNumbering` writes to `orgs` with the user (anon-key) client:
```
const { error } = await supabase.from("orgs").update({ ticket_prefix: …, ticket_record_code: …, ticket_number_pad: … }).eq("id", activeOrgId);
if (error) throw error;
setNumSaved(true);
```
The only UPDATE policy on `orgs` is `orgs_admin_write … WHERE … AND role = 'Admin'` (schema.sql:1042-1045). For a DocCtrl the policy filters the row out, so the UPDATE affects zero rows. That is not an error: PostgREST returns 204 and supabase-js resolves `{ error: null }`. `if (error) throw error` passes, `setNumSaved(true)` runs, and the button renders a green check and the word "Saved".

**Failure scenario.** The document controller — the role whose entire job is the numbering scheme — sets the workspace code from blank to "KE" and the record code from DDRT to the plant's actual record code, clicks Save, and reads "Saved". Nothing persisted. Every subsequent drafting request is numbered under the old scheme. Because the preview line (`formatTicketNumber(numbering, …)`, line 200) renders from local state, the page keeps showing the intended format for the rest of the session. The discrepancy surfaces only when someone compares an issued request number against the records index — i.e. during an audit.

**Evidence.**

```
settings/page.tsx:108-114 — `const { error } = await supabase.from("orgs").update({ … }).eq("id", activeOrgId); if (error) throw error; setNumSaved(true);`. settings/page.tsx:25 — `const ADMIN_ROLES = new Set(["Admin", "DocCtrl"]);`. schema.sql:1044 — `SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'`.
```

**Chain reaction.** Same shape as the org_members DELETE finding: an RLS-filtered write returning zero rows is indistinguishable from success in every client-side write in this codebase. `requeueFailed` on the same page (settings/page.tsx:92-94) does not even destructure `error`.

> **Verifier correction.** HIGH is overstated: no unauthorized write occurs (RLS holds correctly) and the affected data is ticket-number formatting. The defect is a false success signal to a DocCtrl, i.e. the unchecked-write pattern, not a privilege breach.

**Done when.**

- [ ] Either `orgs_admin_write` admits DocCtrl (roles[]-aware, via a helper like `is_org_controller`), or the Request Numbering card is disabled for non-Admins
- [ ] `saveNumbering` requests the updated row back (`.select()`) and treats an empty result as failure rather than success
- [ ] A shared helper is used for RLS-filtered client writes so "zero rows changed" never renders as Saved

**Resolution (2026-10-13, admin-and-org Round G).** Package P8. Reproduced on `6503ea7` (DEC-29): `saveNumbering` (`app/(protected)/admin/settings/page.tsx:132-149`) destructured `{ error }` off a bare `orgs.update()`, so an RLS-filtered write rendered "Saved".
- `saveNumbering` now writes through the shared helper `lib/checkedWrite.ts` (`checkedWrite(supabase.from("orgs").update(…).eq("id", org).select("id"))`). The row read back is the success. Zero rows is "Couldn't save numbering: the database saved nothing — only an Admin can change request numbering. Nothing was changed.", with no green "Saved". A database error is translated by `describeWriteError`. The change is audited (`TICKET_NUMBERING_CHANGED`, before / after; `ALOG-4` done-when 2).
- Tests: `lib/__tests__/adminOrgSurfaces.test.ts` (the rendered page: a save writes and audits; a write RLS refused shows no "Saved" and no audit row). `lib/__tests__/adminSettingsDeadLetters.test.ts` unchanged and green (the requeue already read its rows back).

**Done-when.**
- ✓ The Request Numbering card is shown only to an Admin. The whole page is Admin-only since DEC-17 / SURF-9 (`app/(protected)/admin/settings/page.tsx:27`, `:41`, by the role collection; `lib/adminSurfaces.ts` "settings" entry `["Admin"]`), so a DocCtrl never reaches the card. That is the "disabled for non-Admins" limb; `orgs_admin_write` is not widened (DEC-90: fail safe).
- ✓ `saveNumbering` requests the updated row back and treats an empty result as failure.
- ✓ The shared helper (`lib/checkedWrite.ts`, GAP-402) is what this write uses. The same rule is applied to the role editor and the time-zone save on these admin pages (`ALOG-4`, `NEDGE-19`); `lib/__tests__/checkedWrite.test.ts`'s SAF-18 census ratchets the rest of the codebase.

**Scope / residual.** None for this finding.

---

<a id="org-5"></a>

## ORG-5 · Any active org member can overwrite the org logo in R2 — the Admin-only branding RLS is bypassed because authority lives on the config row, not the storage key

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/upload-url/route.ts:26-56`, `lib/orgBranding.ts:24-31`, `app/(protected)/admin/branding/page.tsx:63-69`, `components/branding/LogoUploadModal.tsx:36-38`, `supabase/migrations/20260713_branding_admin_writes.sql:20-34`, `components/navigation/Sidebar.tsx:372-375`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the Admin-only RLS protects the pointer, not the bytes it points at. Any active member (Viewer/Contractor included) can presign a PUT for the exact logo key and replace what every member sees.

**Mechanism.** Branding WRITES are correctly Admin-gated at the database: three RESTRICTIVE policies on `org_configurations` for `key = 'branding'` requiring `is_org_admin(org_id)` (20260713). But branding SELECT is deliberately left open ("SELECT is intentionally left open so every member can read the branding to apply the logo/palette"), so `getOrgBranding` returns `logoPath` to every member (orgBranding.ts:24-31, called by OrgBrandingProvider for everyone).

The logo bytes live at that R2 key, and `/api/storage/upload-url` gates a PUT presign on org MEMBERSHIP only: `const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//); if (orgMatch) { …select uid from org_members where org_id=… and uid=… and status='active'… if (!member) return 403 }`. There is no role check and no per-area check — `orgs/<org>/branding/` is treated exactly like `orgs/<org>/tickets/`. `ContentType` is whatever the caller sends: `new PutObjectCommand({ Bucket: R2_BUCKET, Key: path, ContentType: contentType || "application/octet-stream" })`.

The path is also predictable in shape (`orgs/${activeOrgId}/branding/logo-${rand}.${ext}`) but does not even need guessing — the exact `logoPath` is handed to every member by the readable config row.

**Failure scenario.** A Contractor or Viewer — the lowest-privilege members — reads `org_configurations` where key='branding', takes `data.logoPath`, calls POST /api/storage/upload-url with that exact key and `contentType: "image/png"`, and PUTs any image they like to the presigned URL. Every member of the org, on their next load, sees that image as the workspace logo in the sidebar (`<img src={logoUrl} alt="Organization logo" …>`, Sidebar.tsx:375) and in the branding modal. No audit row is written (uploads are not audited on this path) and the Admin-only branding policy is never consulted, because the config row never changed. In a regulated plant, the branding is the visual authenticity cue for whether a screen is the real controlled-document system; an attacker with the lowest role in the tenant now controls it for everyone. Passing `contentType: "text/html"` instead stores an HTML document under the tenant's storage domain, served with that type by the plain `GetObjectCommand` presign in download-url/route.ts (no ResponseContentType/ResponseContentDisposition override).

**Evidence.**

```
upload-url/route.ts:36-45 — the entire authorization: `.from("org_members").select("uid").eq("org_id", orgMatch[1]).eq("uid", user.id).eq("status", "active").maybeSingle(); if (!member) return … 403`. Nothing about role, nothing about the key's area. upload-url/route.ts:47-51 — `ContentType: contentType || "application/octet-stream"`. branding/page.tsx:110 — the only MIME restriction anywhere is the browser hint `accept="image/*"`.
```

**Chain reaction.** The same membership-only gate applies to every other privileged key area under `orgs/<orgId>/`, so any authority the app derives from "this file is at this path" is member-writable, not role-writable.

> **Verifier correction.** HIGH is overstated. The route's org-prefix gate holds the tenant boundary (no cross-org write), so the impact is an insider replacing their OWN workspace's logo bytes — defacement plus an attacker-chosen Content-Type on a presigned object, not document-control compromise. grep for `logoPath` shows it is consumed only by OrgBrandingProvider (sidebar/branding preview), dataExport.ts:357-359 and storageOrphans.ts:74 — it is not stamped onto controlled drawings or watermarks.

**Done when.**

- [ ] upload-url authorizes the key's AREA, not just the org: writes under `orgs/<org>/branding/` require `is_org_admin`-equivalent
- [ ] The server pins ContentType from a small allowlist (png/jpeg/webp/svg) rather than echoing the caller's string, and enforces a size cap
- [ ] Branding logo uploads write an audit_logs row naming the actor


**Resolution (2026-10-02, admin-and-org Round G).** Package P6. Reproduced at base `f5073fc`: `app/api/storage/upload-url/route.ts:33-45` checked membership only and `:80-86` signed whatever `ContentType` the caller sent. The presigner leaves Content-Type unsigned (`@aws-sdk/s3-request-presigner` adds it to `unsignableHeaders`), so the PUT could carry any type regardless. The test "a Drafter … asking to PUT the exact logo key is refused 403" fails against base.
- **The logo area.** `lib/storageKey.ts isWorkspaceLogoKey` defines it as a file directly under `orgs/<uuid>/branding/`, which is where both the branding page and the sidebar's logo modal mint `logo-<uuid>.<ext>`. The sub-folders `branding/covers/` and `branding/backgrounds/` are a folder's or library's cover and page background (`components/documents/CustomizeNodeModal.tsx`), written by whoever customizes that node. They are not the logo, and they keep the membership rule, so those uploads work as before.
- **Done-when 1.** For a logo key, upload-url reads the member's role collection (`select("uid, role, roles")`) and refuses anyone not holding Admin (`memberHoldsAny`, the collection, as `is_org_admin` reads it): 403 "Only an Admin can change the workspace logo."
- **Done-when 2** (`DEC-99` §5, the brief's values):
  - **Types.** PNG, JPEG and WebP only (`LOGO_CONTENT_TYPES`, exact strings), else 415. SVG is refused, not sanitised: a presigned PUT never passes its bytes through the server, so nothing could sanitise it on the way in, and it can carry script when opened directly.
  - **Size.** 5 MB (`LOGO_MAX_BYTES`; the record names no cap, so the brief's default). Over is 413; a missing or non-integer declared size is 400.
  - **Signed into the PUT.** The type and the declared length are SIGNED headers of the presigned PUT (`ContentLength` set; `signableHeaders: content-type`), so storage refuses a PUT that sends another type or another byte count. The test reads `X-Amz-SignedHeaders` from a real presigned URL.
  - **Multipart.** `app/api/storage/multipart/route.ts` refuses the logo area outright (400 before storage is touched): a logo never needs multipart, and the route must not be the way around these checks.
- **Done-when 3.** Before signing, the route writes `BRANDING_LOGO_UPLOAD` (`resource_type` `org_branding`, the org, the actor's uid and email, `user_role` Admin, `details { path, contentType, size }`). Checked: a refused row refuses the upload (503), never signed unrecorded. The row is written where the upload is authorized, which the finding's attacker (a member calling upload-url directly) cannot skip. A client-side row in `lib/orgBranding.ts saveOrgBranding`, the plan's suggested site, would be skipped by exactly that caller, so `lib/orgBranding.ts` is not edited.
- **The client.**
  - `lib/storage.ts`: `getPresignedUploadUrl` sends the file's `size`, which non-logo keys ignore. A refused presign keeps its "Failed to get upload URL (HTTP n)" prefix and appends the route's reason, so the branding page's "Logo upload failed: …" says why. This file is outside P6's plan (filesOutsidePlan).
  - `components/branding/LogoUploadModal.tsx` pre-checks the same rule (`logoUploadProblem`), offers only those types, and says "PNG, JPEG or WebP, up to 5 MB."
- Tests: `lib/__tests__/aoRoundGLogoUpload.test.ts` (route, real presigner, multipart, regression for documents, covers and backgrounds; the client pins); `lib/__tests__/storageKey.test.ts` (the area and the rule).
- **Review fix pass: the backup restore puts the logo back.** The review found that the change above broke the second direct caller of upload-url. `app/(protected)/admin/restore/page.tsx` ("Put the files back") posted `{ path, contentType }` with no size, so every workspace-logo file in a Full ZIP was answered 400 and counted as a bare "failed", and the restored branding row pointed at a missing object. Now:
  - The page builds its request with `lib/storageKey.ts restoreUploadRequest(key, blob.size)`. That sends `{ path, contentType, size }`, and the PUT carries the same Content-Type the route signed. The extension table moved there unchanged, as `contentTypeForKey`.
  - A failed file keeps the route's (or storage's) reason, and the panel lists each distinct reason with its file count instead of a bare count.
  - A logo the route will not sign is not requested. That is an SVG or GIF uploaded before this change (the modal and the branding page accepted `image/*`), or one over 5 MB. The panel says "The workspace logo in this backup was not put back (…)" and links to Admin → Branding to upload it again. See Scope / residual.
  - The restore page is outside P6's plan (filesOutsidePlan; `99-fix-sequencing.md`).
  - Test: `aoRoundGLogoUpload.test.ts`, "ORG-5 fix pass — a backup restore puts the workspace logo back". It calls upload-url with the helper's exact body for PNG, JPEG and WebP logos (signed, type and length signed, audited). For SVG, GIF and over 5 MB, it checks that the helper names a problem exactly when the route refuses, and with the route's own sentence. Documents, covers and backgrounds are unaffected. Source pins check the page sends the helper's body and PUTs its type. The page's old body is 400, as the review reported.
- **Second review fix pass: a logo's type is its bytes', never its file name's.** The review found that the restore decided a logo's type from the key's extension, while upload-url accepts a logo by its declared type and the clients minted the key's extension from `file.name`. A real JPEG named "Company Logo.jfif" (Windows' default) was signed as `image/jpeg` under `…/logo-<uuid>.jfif`, then on restore `contentTypeForKey` said octet-stream and the panel claimed it was not a PNG or JPEG. An extensionless name failed the same way. Now:
  - `components/branding/LogoUploadModal.tsx` builds a new key's extension from the allow-listed type, `lib/storageKey.ts logoExtensionForType` (image/png → png, image/jpeg → jpg, image/webp → webp), never from the name. The branding page's own uploader is outside P6; the helper is exported for it (`99-fix-sequencing.md`).
  - For logos already stored, the restore page reads the blob's first 12 bytes for a logo key and passes them to `restoreUploadRequest(key, size, head)`, which decides a logo's type by `sniffImageType` (89 50 4E 47 PNG, FF D8 FF JPEG, RIFF…WEBP WebP, GIF8 GIF) before the extension. The bytes win over a wrong extension: a GIF stored at ".png" is named as not restorable, never signed as a PNG. Bytes that are no known image fall back to the extension; a non-logo key never reads its bytes' type.
  - Tests: `aoRoundGLogoUpload.test.ts`, "ORG-5 fix pass 2 — …": the ".jfif" case is REPRODUCED against the extension path (415 by extension) and restores with its bytes, signed and audited as `image/jpeg`; an extensionless key restores as PNG and as WebP; the GIF-at-".png" case; the fallback and non-logo cases; the four magic numbers; and that a new key's extension round-trips through `contentTypeForKey`.

**Done-when.**
- ✓ **for the logo area only.** upload-url authorizes the key's area for the workspace logo: writes directly under `orgs/<org>/branding/` require Admin by the full collection. *(Narrowed at the review fix pass. This line used to read as if the whole of `branding/` were held to Admin.)* The sub-folders `branding/covers/` and `branding/backgrounds/` are NOT held to Admin or to any role: any member, a Viewer or Contractor included, can read a folder's or library's `coverImageUrl` / background key and presign a PUT to it with any Content-Type, replacing the image every member sees. That is the same pointer-gated, bytes-open mechanism this finding describes. Under `DEC-31` that limb is opened as `ORG-16` with its owner.
- ✓ The server pins ContentType from an allow-list and enforces a size cap. The list is png / jpeg / webp; svg is refused rather than sanitised (reason above), narrower than the record's list. Both are signed into the PUT.
- ✓ Branding logo uploads write an audit row naming the actor (server-side, checked, before the signature).

**Scope / residual.**
- **An Admin can still overwrite the current logo's key in place.** The row is written. A fresh key per upload is what the app mints.
- **A logo already stored as SVG keeps rendering** (its pointer is unchanged); a new one cannot be uploaded as SVG.
- **A logo stored before this change under a name-derived extension** (".jfif", none, or a wrong one) restores by its bytes (second review fix pass); its key keeps the old extension, which the app never reads again.
- **A backup's SVG or GIF logo cannot be restored** (named residual, `DEC-31`; review fix pass). The restore puts back every PNG, JPEG or WebP logo of 5 MB or less. A logo uploaded before this change as SVG or GIF, or one over 5 MB, is refused by upload-url like any new upload of that type. So a restore into a fresh bucket, or into another workspace, leaves the restored branding row pointing at a missing object. The workspace's logo does not load until an Admin uploads one again. The restore panel says so, names the file and the reason, and links to Admin → Branding. It is not signed by a restore-only path: a restore flag would let any Admin skip the SVG refusal for any key the pointer names. Reversal: `DEC-99` (a server-side path that can sanitise SVG bytes).
- **Covers and backgrounds under `branding/` are still member-writable** (authorization, not only Content-Type): opened as `ORG-16`.
- **The finding's chain reaction is not closed here** (`DEC-31`): other member-writable areas, covers and backgrounds included, still accept any Content-Type. The download route's `ResponseContentType` / `ResponseContentDisposition` pinning is projects `SEC-7` (`lib/presignedDisposition.ts`).
- **R2 enforcing the signed headers** is the SigV4 contract the cap and type pin rely on. It was tested here at the signature (the URL's signed header list), not against a live bucket.

---

<a id="org-6"></a>

## ORG-6 · Every org-authority SECURITY DEFINER helper — the functions all RLS policies call — is missing SET search_path, while the guards written later all set it

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** admin-and-org P8 (done-when 1: one `ALTER FUNCTION acl_subject_in_bucket … SET search_path` in its ORG-13 migration) — by the integrator, 2026-10-02 (at the A&O P0 merge: the verify-and-record package named the owner in its Partial block; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1031-1034`, `supabase/migrations/20260707_teams.sql:52-55`, `supabase/migrations/20260713_branding_admin_writes.sql:11-18`, `supabase/migrations/20260814_documents_delete_controllers.sql:31-35`, `supabase/migrations/20260817_org_members_escalation_and_config.sql:21-28`, `supabase/migrations/20260708_acl_rls_enforcement.sql:42-45`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The absence is real and the inconsistency with newer code is real, but the exploit path is not reachable in this codebase: a repo-wide grep finds no GRANT of CREATE on any schema and no CREATE SCHEMA, PostgREST fixes the connection search_path, and Supabase's anon/authenticated roles cannot create a schema that precedes public. This is search_path hardening debt (defense-in-depth), not a live privilege-escalation path — LOW.

**Mechanism.** The six functions that every org-scoped RLS policy in the schema resolves through are declared SECURITY DEFINER with no search_path pin: `my_org_ids()` (`RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER AS $$`), `my_team_ids()` (`… SECURITY DEFINER STABLE AS $$`), `is_org_admin(p_org uuid)`, `is_org_controller(p_org uuid)`, `is_org_admin_or_manager(p_org uuid)` (all `LANGUAGE sql STABLE SECURITY DEFINER AS $$`), and `node_visible(...)` (`LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$`). Each body references bare `org_members` / `team_members` with no schema qualification.

The codebase demonstrably knows the pattern: `prevent_last_admin_removal`, `enforce_checkout_release_guard` (20260831:45,81), `user_can_publish_on_library`, `user_is_effective_owner` (20260812:37, 20260816:10) and two functions in schema.sql itself (lines 475, 527) all carry `SET search_path = public`. The org-authority family is precisely the set that was missed — and it is the highest-value set, because it is what every permissive policy in the database delegates its decision to.

**Failure scenario.** Any role that can create objects in a schema that precedes `public` on the resolution path (or a future migration that adds one, or a Postgres/Supabase extension schema) can shadow `org_members` with a view. `my_org_ids()` then executes as its definer against the shadow relation and returns whatever the shadow says, which every `USING (org_id IN (SELECT my_org_ids()))` policy in the schema accepts as ground truth — a total, silent collapse of tenant isolation rather than a scoped bug.

**Evidence.**

```
schema.sql:1031-1034 — `CREATE OR REPLACE FUNCTION my_org_ids() RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER AS $$ SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'; $$;` — no SET clause, unqualified `org_members`. Compare 20260831:45 — `RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$`.
```

**Chain reaction.** `node_visible` is the RESTRICTIVE gate on documents and collections; `my_org_ids` is the permissive gate on nearly every table in schema.sql:1040-1133. Shadowing either one is sufficient on its own.

> **Verifier correction.** The framing "the guards written later all set it" / "precisely the set that was missed" is wrong and should not be repeated. `grep -i "SECURITY DEFINER" supabase/schema.sql supabase/migrations/*.sql | grep -vi search_path` returns roughly twenty unpinned SECURITY DEFINER functions, including many written after the pinned ones (20260713_document_publish_guard.sql:29, 20260813:35 and :59, 20260816_documents_access_change_guard.sql:47 and :82, 20260816_owner_publish_access.sql:33, 20260818_followups_rls.sql:11,24,96,108, 20260822:22, 20260823:137, 20260826:18,38). This is a repo-wide inconsistency, not a targeted omission on the org-authority family. Exploitability also requires CREATE on a schema earlier in search_path, which anon/authenticated roles do not normally hold on Supabase — defense-in-depth, hence MEDIUM.

**Done when.**

- [ ] `my_org_ids`, `my_team_ids`, `is_org_admin`, `is_org_controller`, `is_org_admin_or_manager`, `node_visible`, `acl_subject_in_bucket`, `doc_is_visible`, `my_project_ids`, `can_manage_node`, `is_org_assign_drafters` and `next_ticket_number` all carry `SET search_path = public`
- [ ] A CI or schema-health check fails on any SECURITY DEFINER function without a search_path pin

**Partial (2026-10-02, admin-and-org Round G, P0).** Reproduced against base `f1ac550` (DEC-29) with an order-aware census. It takes the final definition of each `(name, arity)` over `schema.sql` and then every numbered migration, and applies top-level static ALTERs and `20261020`'s ALTER list in sequence. The resolving finding is roles-and-permissions `DB-6` (commit `2af2ebe`). Eleven of the twelve helpers are pinned live. Done-when 2 holds for the numbered replay order as of this package, but the lint cannot see a file pasted out of that order (one known case, below). The twelfth helper is not pinned, so the status stays OPEN.

- **Done-when 1 holds for the eleven SECURITY DEFINER helpers.**
  - Pinned at creation: `my_team_ids()` (`20261042`), `is_org_admin(uuid)` and `can_manage_node(jsonb, uuid)` (`20261046`), `node_visible(text, jsonb, uuid)` and `doc_is_visible(uuid)` (`20261037`), the six-argument `node_visible` (`20261041`), and `next_ticket_number` (`20260724`).
  - Pinned by `20261020`'s ALTER, over a final definition that precedes it: `my_org_ids()` (`schema.sql`), `my_project_ids()` (`20260813`), `is_org_controller(uuid)` (`20260814`), `is_org_admin_or_manager(uuid)` (`20260817`) and `is_org_assign_drafters(uuid)` (`20260818`).
  - All of these files are LIVE. `20261020` was applied and verified live on 2026-08-24 ("zero SECURITY DEFINER functions in public without a pinned search_path"), and each later re-creation above is a LIVE file that pins at creation.
- **Done-when 1 does not hold for the twelfth.** `acl_subject_in_bucket(jsonb, text, text, text[])` carries no `SET search_path` (`20260708_acl_rls_enforcement.sql:21-39`, `RETURNS boolean LANGUAGE sql STABLE AS $$`).
  - It is not SECURITY DEFINER, so neither `20261020` nor the lint ever covered it.
  - It reads only its own arguments, so there is no relation to shadow. Its only callers are `node_visible` (`20261037:83`; `20261041:80`, `:83`), whose own pin is in force while it runs. So this is the letter of the criterion, not an open path.
  - **Owner: admin-and-org P8.** The fix is one line, `ALTER FUNCTION acl_subject_in_bucket(jsonb, text, text, text[]) SET search_path = public;`, in its ORG-13 migration (the same family: ORG-13 changes `node_visible`'s team read). That migration is not written yet, so there is nothing to paste.
  - **Plan amendment needed.** The admin-and-org plan's P8 entry does not list `ORG-6`. Its "new migration A (ORG-13)" is where the line goes. The integrator adds `ORG-6` to P8, or re-owns this remainder.
  - Tripwire: `lib/__tests__/searchPathPin.test.ts`, `it.fails` "acl_subject_in_bucket carries SET search_path = public (ORG-6 residual, owner A&O P8)". P8 flips it to `it` when the pin lands. A plain test beside it checks that `acl_subject_in_bucket/4` is live and not dropped, so the tripwire cannot pass vacuously if the helper is renamed, re-aritied or dropped.
- **Done-when 2 holds for the numbered replay order, as of this package.** `lib/__tests__/searchPathPin.test.ts` replays `schema.sql` and then the numbered migrations in filename order, and fails on any definer that replay leaves unpinned.
  - The gap: its exemption for `20261020`'s list ignored order, but `CREATE OR REPLACE` resets `SET search_path`. Re-creating any of the eight functions that `20261020` alone pins, without the clause, passed the lint while the live function lost its pin.
  - Reproduced: a temporary `supabase/migrations/20991231_zz_repro_unpinned.sql` that re-creates `is_org_controller(uuid)` as SECURITY DEFINER with no SET left `searchPathPin.test.ts` green (4 of 4).
  - The change tightens the 20261020 exemption and adds ALTER-as-pin. It is not purely a tightening:
    - Tightened: the exemption now covers only a final definition that precedes `20261020` (`unpinnedDefiners`), and `SET search_path TO DEFAULT`, `RESET search_path` and `RESET ALL` count as unpinning wherever they appear (a reset after `20261020` loses its pin as a re-creation does).
    - Added, and able to pass a function the earlier lint failed: a static, top-level `ALTER FUNCTION … SET search_path` counts as a pin. An ALTER inside a single-quoted string or a dollar-quoted block (an `EXECUTE '…'` string, a conditional `DO` block, a function body) does not, because it may never run (`topLevelOnly`). No migration on `f1ac550` has a static one, so the census is unchanged by this rule today.
    - Synthetic self-checks pin each rule: re-creations, resets, and quoted or conditional ALTERs.
  - The same temporary file now fails the lint, naming `is_org_controller/1 … re-created or reset after 20261020, so its ALTER pin was lost` (re-run in the fix pass with the current message, together with a temporary `ALTER FUNCTION my_org_ids() RESET search_path`, which fails it the same way). Both files were then deleted.
  - On base `f1ac550` the order-aware census finds no unpinned live definer among 127.
  - **What the lint cannot see: a paste out of filename order.** It knows the files, not the order they were pasted in. Known case: `20261011_collections_guard_and_trash.sql` (`audit-reports/MIGRATION-PASTE-ORDER.md` row 10, ASK) re-creates `enforce_document_move_guard()` as SECURITY DEFINER with no `SET search_path` (`20261011:38-42`). It sorts before `20261020`, so the replay counts 20261020's ALTER as its pin and the lint passes it. The paste guide says the opposite about live state: pasting 20261011 now would revert that pin, and its move-guard part needs a re-based file rather than a paste.
    - That hazard is held by the paste guide's row 10 (ASK). Whoever re-bases 20261011 adds `SET search_path = public` to the function. A later `ALTER FUNCTION enforce_document_move_guard() SET search_path = public` (for example, in P8's ORG-13 migration) would restore the pin after an accidental paste, but would not prevent one.
    - A schema-health probe of live state (a SECURITY DEFINER function in `public` whose `proconfig` has no `search_path`) would also catch an out-of-order paste. It is optional hardening outside this criterion, which asks for "a CI or schema-health check" and is met by the CI lint. It is not proposed as a finding, and no package is tasked with it; paste guide row 10 holds the one known case.
    - Pin: `searchPathPin.test.ts` "the known out-of-order case is as recorded". It fails the day the function is pinned at creation or by a later ALTER; this paragraph is then updated.

**Done-when.**
1. ✗ for one of twelve: `acl_subject_in_bucket`. It is a SECURITY INVOKER helper with no relation reference, reached only under `node_visible`'s pin (owner P8). The eleven SECURITY DEFINER helpers ✓.
2. ✓ met by the CI lint, for the numbered replay order: the lint is order-aware, counts a top-level static ALTER as a pin, and fails on every definer that replay leaves unpinned. It cannot see a file pasted out of filename order; the known case is `20261011` (`enforce_document_move_guard`), held by paste guide row 10 (ASK). A live-state probe would be optional hardening outside the criterion.

**Scope / residual.** One `ALTER FUNCTION` line (P8, once the plan is amended). The out-of-order paste of 20261011 stays with the paste guide's row 10; a live-state probe is outside this finding. Test-only change here: `lib/__tests__/searchPathPin.test.ts` (commit `447bb8b`, and this package's fix passes). No migration.

**Resolution (2026-10-13, admin-and-org Round G).** Package P8, as P0's Partial named. `supabase/migrations/20261203_ao_roundG_team_members_org_rail.sql` §4 carries the one line, top-level inside its transaction: `ALTER FUNCTION acl_subject_in_bucket(jsonb, text, text, text[]) SET search_path = public;`. Its final SELECT probes `proconfig @> ARRAY['search_path=public']`.
- Tests: the tripwire `lib/__tests__/searchPathPin.test.ts` "acl_subject_in_bucket carries SET search_path = public" is flipped from `it.fails` to `it` and passes. The census counts a top-level static ALTER as a pin. `lib/__tests__/aoRoundGP8Migrations.test.ts` pins the line. PG16: the probe is true after the paste.

**Done-when.**
1. ✓ All twelve helpers carry `SET search_path = public`: the eleven SECURITY DEFINER helpers as P0 recorded, and `acl_subject_in_bucket` from `20261203` (PASTE pending; it is a SECURITY INVOKER helper over its own arguments, so nothing is open before the paste).
2. ✓ Unchanged from P0: the CI lint (`searchPathPin.test.ts`) fails on any SECURITY DEFINER function the numbered replay leaves unpinned.

**Scope / residual.** The out-of-order paste of `20261011` stays with the paste guide's row 10, as P0 recorded. `20261203` does not ALTER `enforce_document_move_guard()`, so the pin "the known out-of-order case is as recorded" is unchanged.

---

<a id="org-7"></a>

## ORG-7 · Member removal orphans everything hung off the member — no team_members prune, no ACL prune, no ownership reassignment, and the recertification snapshot degrades to raw UUIDs for exactly the departed people

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** admin-and-org P12 MEMBER-REMOVAL AND WORKSPACE TIME-ZONE FOLLOW-UPS (the remainder P8 named: done-when 2's `isActiveMember` at the documents page and the View-as simulator, done-when 3 for a suspended member's grant, done-when 4's `org_id` filter, and the re-add residual) — by the integrator, 2026-10-13 (at the admin-and-org P8 merge, DEC-31; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/users/page.tsx:164-187`, `supabase/migrations/20260707_teams.sql:19-28`, `lib/accessRecert.ts:59-78`, `lib/ownership.ts:44-57`, `lib/acl.ts:26-34`, `supabase/schema.sql:33-48`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Right about the missing prune/reassign/snapshot logic, but the finding's own scenario is unreachable today — the DELETE silently no-ops, so nothing is actually orphaned. It is latent debt that only bites once ORG-2 is fixed, so LOW rather than MEDIUM.

**Mechanism.** `handleRemoveMember` is a bare `delete().eq('id', member.id)` on `org_members` and nothing else. Two search shapes (`grep -rn "removeMember|offboard|deactivate|suspend"` across lib/app/components — only `lib/projects.ts:530` for PROJECT members; and a repo-wide `team_members` reference audit) confirm there is no org-level offboarding routine anywhere.

`org_members.uid` carries NO foreign key (`uid UUID NOT NULL`, schema.sql:36 — the org_id column two lines above does have `REFERENCES orgs(id) ON DELETE CASCADE`), and `team_members.uid` references `users(id)`, not `org_members`. So deleting the membership row cascades to nothing. Left behind, all still naming the departed uid: `team_members` rows, `teams.supervisor_user_id`, `libraries/collections/documents.owner_user_id`, and every explicit `user` ALLOW rule inside `acl` / `acl_index`.

The consequences are visible in the code that reads them. `listAccessGrants` resolves user names only from live membership: `.from("org_members").select("uid, display_name, email").eq("org_id", orgId).in("uid", userIds)` then `subjectName: r.subject.type === "user" ? (nameMap.get(r.subject.id) || r.subject.id) : r.subject.id`. A removed member's uid misses the map and falls through to the bare UUID — and that array is what `recertifyAccess` freezes into `grants_snapshot` as the compliance record. `effectiveOwnerForDocument` does the same lookup for a team supervisor with no `org_id` filter at all (`.from("org_members").select("display_name, email").eq("uid", sup).maybeSingle()`) and falls back to the team name or the literal string "Supervisor".

lib/acl.ts:26-34 documents the exact hazard — "a stale rule can still name a uid whose membership was revoked… the ACL layer should not GRANT to a non-member. When a caller knows membership status, pass it" — but `isActiveMember` is optional and "Omitted/`true` = unchanged behavior", so every call site that omits it keeps honouring the stale grant.

**Failure scenario.** An engineer with an explicit per-user ALLOW grant on the Isometrics library and a seat on the Piping team leaves. The Admin removes them. Six months later the annual access recertification runs: the reviewer opens the access list and sees a row reading `8f2c1d64-…` with actions `read, download` and no name — the one entry that most needs a name is the only one without one. They attest anyway (the UI offers nothing else), and `recertifyAccess` writes that unresolvable UUID into `access_recertification_events.grants_snapshot` as the signed record of who had access. Meanwhile the ex-employee is still a member of the Piping team, so any team grant added to any library since their departure silently extends to them, and if their `owner_user_id` is on a library they remain that library's accountable owner for review-overdue notifications that go nowhere.

**Evidence.**

```
users/page.tsx:178 — the entire removal: `const { error } = await supabase.from('org_members').delete().eq('id', member.id);`. accessRecert.ts:73 — `subjectName: r.subject.type === "user" ? (nameMap.get(r.subject.id) || r.subject.id) : r.subject.id,`. ownership.ts:53 — `const { data: m } = await supabase.from("org_members").select("display_name, email").eq("uid", sup).maybeSingle();` (no org_id). schema.sql:36 — `uid UUID NOT NULL,` with no REFERENCES.
```

**Chain reaction.** This compounds with the missing DELETE policy: today removal does not even reach the point of orphaning, so the orphan-cleanup gap is latent and will surface the moment the policy is fixed.

> **Verifier correction.** Two corrections. (a) The claimed access consequence is largely mitigated at the enforcement point: download-url/route.ts:35-46 independently re-checks `org_members … status='active'` and 403s before any ACL evaluation, so `isActiveMember: true` at line 82 is safe there; a stale ACL grant does not by itself return bytes. (b) The whole scenario is currently unreachable through the UI anyway, because the DELETE is RLS-denied (finding 2) — the orphaning bites only via service-role/SQL-console removal, or once finding 2 is fixed. What is squarely confirmed and unmitigated is the absence of any offboarding routine and the recert snapshot degrading to raw UUIDs.

**Done when.**

- [ ] Removal (or suspension) runs one transaction that also deletes the member's `team_members` rows, clears `teams.supervisor_user_id` where it names them, and reassigns or clears `owner_user_id` at library/folder/document level
- [ ] Explicit per-user ACL ALLOW rules naming the removed uid are pruned or flagged, and `acl.ts`'s `isActiveMember` is passed at every grant-evaluating call site
- [ ] `listAccessGrants` resolves names from a durable source (or records the name at grant time) so a recert snapshot never contains a bare UUID
- [ ] `effectiveOwnerForDocument`'s supervisor lookup filters by org_id

**Partial (2026-10-13, admin-and-org Round G).** Package P8. Reproduced on `6503ea7` (DEC-29). Done-when 1 already held (below). The per-user ACL rules naming a removed member were never touched: `revoke_member`, newest body `20261161`, pruned capability grants and rosters, not `acl` / `acl_index`.
- **Done-when 2, the prune: DEC-90 ruling for this package, PRUNE in `revoke_member`'s transaction, never flag.** `supabase/migrations/20261204_ao_roundG_revoke_member_acl_prune.sql` re-creates `revoke_member` from its NEWEST definition (`20261161`, found by scanning; it keeps `20261043` §0's TEXT[] lock clear and N5's NEDGE-7 tombstone). On REMOVE only, after the capability-grant strip and before the roster deletes, it removes the removed member's **ALLOW** rules from the `acl` of every library, folder, document and document set of the workspace, and from the library's template for new nodes (`default_new_acl`). It removes the member's uid from every `acl_index` allow user list, the exact image of the rebuild: the builder fills allow and deny buckets independently, pinned against `lib/acl.ts` `buildAclIndexFromChain` in `lib/__tests__/aoRoundGP8Migrations.test.ts`. It writes `MEMBER_ACL_GRANTS_PRUNED` with the counts.
  - DENY rules naming the member are kept (a block outlives the membership). Grants by role, team or org are untouched.
  - An ACL whose rules all go keeps its object with `rules: []`. An ACL with no rule grants nothing; it is not read as "no ACL" (`canWithAclChain` falls back to the default only when the chain has no ACL object at all), so nothing widens.
  - Suspension keeps the grants, for the member's return; every evaluator refuses a non-active member.
  - Grants that already named someone with no membership in the workspace (removed before the paste) are pruned once, inside the transaction, counted before it, one machine `ACL_STALE_GRANTS_PRUNED` row per workspace. A suspended or inactive member still has a membership row and is not touched.
  - PG16: the removal pruned one library, folder, document and set; a deny and another member's allow stayed; the ghost uid was pruned by the backfill and the inactive member's grant kept; a second run found nothing.
  - *Cost and timeout (two review passes).* `revoke_member` is called as `authenticated`, under that role's statement_timeout (8 s on Supabase). In the first fix pass the in-statement prune also rewrote every descendant whose chain-resolved `acl_index` named the uid. Timed on a throwaway PostgreSQL 16, a member whose personal grant on a library was indexed into 100,000 documents took 14.9 s and was cancelled (57014) under an 8 s timeout (limit roughly 40,000 to 50,000 rewritten nodes, lower with the production guards). A removal that works today would have failed after the paste. **Second review fix: the work is split.**
    - **In `revoke_member`'s statement:** only the nodes whose OWN `acl` carries a rule naming the uid (and a library's `default_new_acl`) are rewritten, with that same node's `acl_index`. The scan is narrowed by one binary containment test, `acl @> v_rule_probe` (any effect), before the exact `acl_allow_user_ids(acl, NULL)` check. The cost is bounded by the grants a person was given, not by what inherits them. There is no `acl_index @?` scan in the function (a probe in the paste checks this).
    - **After the removal, in bounded chunks:** *(the second review fix's form, described in this bullet and the two after it, was replaced at fix pass 3 — below: the walk is now keyed on the person's own grant rows.)* The new `prune_removed_member_acl_index(p_org_id uuid, p_uid uuid, p_limit integer DEFAULT 1000)` in `20261204` §2b. It is SECURITY DEFINER with `search_path` pinned. EXECUTE goes to authenticated and service_role, and is revoked from PUBLIC and anon. It strips the person from the allow buckets of at most `p_limit` (clamped 1 to 5,000) nodes per call: documents, then folders, sets and libraries, each `UPDATE … WHERE id IN (SELECT … acl_index @? v_probe LIMIT v_left)`, so each call is its own short statement. It returns `{pruned, documents, collections, documentSets, libraries, limit, done}`, and writes one `MEMBER_ACL_GRANTS_PRUNED` row per call that pruned anything (`phase: "acl_index"`, per-table counts, `done`). It runs only for an ACTIVE Admin of the workspace (by the role collection) or the server (`auth.role() = 'service_role'`). It refuses with 42501 for a uid that still has a membership row, so it can never strip a current member.
    - **Who calls it:** `/admin/users` `handleRemoveMember`, right after `revokeMember` returns, through `lib/memberAclIndexPrune.ts` `pruneRemovedMemberAclIndex`. That helper loops the RPC in chunks of 1,000 until `done`, a 500-call budget or a 2-minute deadline, never rejects, and treats a missing function (before the paste) as nothing to do. The loop is not awaited by the removal. A failed call is shown ("…could not be cleared yet (…). They can't open anything as a non-member; tonight's re-index finishes the clean-up."), and so is a run cut short.
    - **Nothing leaks meanwhile:** with the `org_members` row gone, every RLS path refuses a non-member. The nightly `acl_index` rebuild (DEC-10, `lib/aclIndexRebuild.ts`) drops the uid anyway, because its rule is no longer in the chain.
    - **PG16, throwaway cluster:** a stub schema with **ten** BEFORE UPDATE guard triggers on `documents`, each reading `org_members` like `is_org_controller`, which stands in for the production guards. Under `SET statement_timeout = '8s'` as `authenticated`: removing a member whose library grant is indexed into 100,000 documents (plus 50 folders, one own-ACL document and one deny-only document) **completed in 0.19 s**. It pruned the library's acl and template and the own-ACL document; the deny rule and the other member's allow stayed. The chunk loop then ran **101 calls, the slowest 0.82 s, 49 s in all**. It left 0 documents naming the person, kept the other member in all 100,000, and wrote 101 audit rows (`done` only on the last). The function refused a non-Admin, refused while the person was still a member, refused anon (permission denied), and let service_role through. The full `20261204` script on the same stub returned every probe `true`.
  - **Fix pass 3 (third review), 2026-10-13 — the chunked walk is keyed on the person's own grant rows.** The review found that every removal, including one of a person who held no personal grant, made the members page call the RPC, whose first statement scanned every document of the workspace (`acl_index @? v_probe`, no index serves it). Measured only at 100,000 documents; in a workspace of a few million it could exceed the 8 s statement_timeout and show a false "danger" alert after a removal that had worked. Now:
    - `revoke_member` (`supabase/migrations/20261204_ao_roundG_revoke_member_acl_prune.sql:394-415`) collects the libraries whose OWN `acl` carried the person's allow (read before the prune; a template-only library is not one — `default_new_acl` is copied into a new node's own `acl`, never indexed into a descendant) and the folders the prune rewrote (`RETURNING id`), and returns them as `aclIndexScope` (`:475`). Only a node under one of these can have inherited the grant.
    - `prune_removed_member_acl_index(p_org_id, p_uid, p_library_ids uuid[], p_collection_ids uuid[], p_phase text DEFAULT 'documents', p_after uuid DEFAULT NULL, p_limit integer DEFAULT 1000)` (`:512-625`; the three-argument form is dropped, `DROP FUNCTION IF EXISTS`) keeps the scope to `p_org_id`'s own libraries and folders, and returns at once with nothing read when it is empty (`:553`). Otherwise it reads at most `p_limit` (clamped 1 to 5,000) candidates of one table per call, in key order after `p_after`, through the existing `documents_library_id_idx` / `documents_collection_id_idx` / `collections_library_id_idx` / `collections_path_ids_idx` (documents in a carrying library or in a carrying folder or any folder under one, by `path_ids`; then folders; then sets of a carrying library), and strips the person from those that still list them. It returns `{pruned, examined, phase, after, limit, done}`: a full page resumes after its last row, a short one moves to the next table, so no row is read twice and the walk ends. Authority, the refusal for a current member, `search_path`, the grants and the one audit row per call that pruned anything (now `table` and `nodes`) are as before. A wrong or partial scope can only leave entries (the function removes the person from allow buckets and nothing else).
    - `lib/memberAclIndexPrune.ts` `pruneRemovedMemberAclIndex(sb, orgId, uid, scope, opts)` passes the scope and the returned cursor, and makes no call for an empty scope; `aclIndexScopeOf` reads `revoke_member`'s answer (null before `20261204`). `/admin/users` (`app/(protected)/admin/users/page.tsx:336-345`) runs it only for a non-empty scope; a failed call is said as "<name> was removed. The access their grants left in the document index is not cleared yet (…); they can't open anything as a non-member, and tonight's re-index finishes the clean-up." — no longer in the "danger" tone of a failed action.
    - Grants already in the index on nodes under NO carrier (an index the nightly rebuild has not yet recomputed after some other change) are not this walk's: the nightly rebuild (DEC-10) drops them, and nothing reads them while the person is not a member.
    - Tests: `lib/__tests__/aoRoundGP8Migrations.test.ts` (the scope's two reads and the answer; the new signature, the old one dropped; the empty-scope return before any node table is read; every candidate read keyed on the scope's columns with the keyset `LIMIT`; no `WHERE org_id = p_org_id AND acl_index @?` read left; the cursor rule), `lib/__tests__/aoRoundGP8AclIndexPrune.test.ts` (7: scope and cursor passed call by call; no call for an empty scope; `aclIndexScopeOf`; not installed; refusals; an unconfirmed answer; budget and deadline), `lib/__tests__/adminOrgSurfaces.test.ts` (the rendered page walks the returned scope in five calls; no call and no alert for an empty scope or before `20261204`; a failed call said plainly, not as "danger").
    - **PG16, throwaway cluster (16.13; deleted afterwards), the real migrations:** `supabase/schema.sql` and then every dated migration in filename order up to and including `20261204` (so `20261195`, `20261197`, `20261198`, `20261203`, `20261204` among them), on a Supabase-shaped bootstrap. The only errors were the known ones of a cluster without `pgvector` (the semantic-layer files) and two unrelated earlier statements (`20260630`'s `team_members` index, `20261075`'s verification `SELECT`); `20261195` re-pasted returns 13 × true, `20261203` 9 × true, `20261204` 11 × true. Seed: 204,512 documents — 3,000 in a library carrying the person's allow, 1,500 in a folder under a carrying folder, 200,000 in an unrelated folder naming only another member, 10 stale entries naming the person under no carrier, one own-ACL document, one deny-only document — plus a folder in the carrying library and a set in it. As an Admin (`authenticated`, `statement_timeout = 8s`), one statement per call as the page makes them:
      - the removal (through `revoke_member`) returned `aclIndexScope` = the carrying library and folder, in 0.26 s; the walk took 7 calls (documents 1,000 / 1,000 / 1,000 / 1,000 / 500, folders 2, sets 1, `done`), the slowest 0.44 s; 0 documents, folders or sets under the carriers still list the person, the other member is kept in all 3,000, the 10 stale entries under no carrier are untouched (the nightly rebuild's); the own-ACL document's rule went (`rules: []`), the deny-only document's deny stayed; 8 `MEMBER_ACL_GRANTS_PRUNED` rows (one from `revoke_member`, one per call that pruned); the candidate read's plan is a `BitmapOr` of `documents_library_id_idx` and `documents_collection_id_idx`, 294 buffers, 4,500 rows — not the 200,000 others;
      - a member who held no grant: `aclIndexScope` `{libraries: [], collections: []}`; the RPC with that scope returned `{pruned: 0, examined: 0, done: true}`;
      - refused: a current member (42501), a non-Admin (42501), `anon` (permission denied), an unknown phase (22023); `service_role` runs it;
      - scale: the carrying library grown to 600,000 inheriting documents (801,512 in all): the removal took 1.10 s; the walk ran 604 calls, the slowest 0.55 s, and left 0 documents naming the person, the other member kept in all 600,000. At that size the walk takes about 2 m 20 s in all, longer than the page's 2-minute deadline: the page then says the rest is left to tonight's re-index, as recorded.
    - What bounds a call is now its page (`p_limit` rows examined and written) plus reading the carriers' own index ranges, never the workspace. A call's read still grows with the size of what sits under the carriers (each call re-reads the scope's index entries to order them); at 600,000 under one library it was 0.55 s. `revoke_member`'s own statement still makes one containment pass over the workspace's documents (`acl @> v_rule_probe`, for the nodes that CARRY a rule): 1.10 s at 801,512 documents.
  - **MERGE (drafting-flow DF-P3, `DEC-103`, 2026-10-13).** `20261204`'s `revoke_member` keeps DF-P3's departure behaviour: the hand-back lives on `org_members`' own AFTER triggers (`20261195`), which this re-creation does not touch, and `revoke_member`'s body carries no departure path. A new paste probe checks both (`20261204:790`), and `aoRoundGP8Migrations.test.ts` pins it. PG16, in the run above: removing the drafter through `revoke_member` handed their `DRAFTING` request back (`PENDING_ASSIGNMENT`, drafter cleared) and cleared them from their `PENDING_REVIEW` request (status kept), wrote ONE summary notice to the workspace's DraftingSupervisor ("Dee Drafter left · 2 request(s) handed back") and a `TICKET_RETURNED_ON_DEPARTURE` row per request — in the same transaction as the ACL prune, which still ran (above). The member with no grant had their `DRAFTING` request handed back with one summary notice too.
- **Done-when 2, the `isActiveMember` half: not done.** The grant-evaluating sites were censused: `lib/principal.ts`, `lib/knowledgeAccess.ts`, `lib/docFileServer.ts`, `lib/documentDiscoverers.ts`, `app/api/storage/download-url/route.ts:99`, `app/api/acl/rebuild/route.ts:76` and `app/(protected)/requests/[id]/page.tsx:1083` pass `isActiveMember: true` for a principal read from an ACTIVE membership. Three sites do not pass what they know:
  - `app/(protected)/documents/[libraryId]/page.tsx:1726` builds the signed-in member's principal without it. The member is active by the protected shell's gate, but the flag is not passed. Document-control P25 holds this file now.
  - `lib/principal.ts` `resolveActorPrincipal`'s fallback (membership unread) omits it, by design: "never wider".
  - `components/permissions/ViewAsSimulator.tsx:450` passes `true` for the SIMULATED member whatever their status. Admin-and-org P7 holds this file now.
  With the prune, a removed member has no user rule left to be honoured; a suspended member is refused by RLS and by every active-membership read before an ACL is evaluated.
- **Done-when 3: not done for a suspended member.** A removed member's grants are pruned, so no rule names them and no snapshot shows their uid. `lib/accessRecert.ts` `listAccessGrantsDetailed` still admits a uid from the index's allow user lists without checking membership, and `nameOf` resolves names only from ACTIVE members. A SUSPENDED member with a personal grant is listed under a bare uid (and listed at all, though RLS refuses them). Notifications N14 holds this file now.
- **Done-when 4: not done.** `lib/ownership.ts:187`, the team rung's display-name read `org_members … .eq("uid", eff.userId).maybeSingle()`, still has no `org_id` filter. The person is an active member of the org, so the name is right, but a person in two workspaces makes `maybeSingle` error and the name falls back to the team's. It needs one `.eq("org_id", orgId)`. Notifications N14 holds this file now.

**Done-when.**
1. ✓ By pointer: `revoke_member` REMOVE deletes the member's `team_members` rows, clears `teams.supervisor_user_id` and clears `owner_user_id` at library, folder and document level, audited, in one transaction (`20261042` → `20261161` → `20261204`; DEC-20 / GAP-5).
2. Partly. ✓ The ALLOW rules naming the removed uid are pruned (`20261204`, PASTE pending): in `revoke_member`'s transaction for the nodes that carry them, and by the chunked `prune_removed_member_acl_index`, which the members page loops after the removal, for the index entries descendants inherited — keyed on the carriers `revoke_member` returns, never a scan of every document (fix pass 3). No removal now runs into the statement_timeout (PG16: 100,000 indexed documents at the second review; 600,000 under one carrier at fix pass 3, slowest call 0.55 s). ✗ `isActiveMember` is not passed at the three sites named above.
3. ✗ for a suspended member's personal grant (`lib/accessRecert.ts`). ✓ for a removed member, whose grants are pruned.
4. ✗ (`lib/ownership.ts:187`).

**Residual of the prune split (second review fix).** Until the chunk loop finishes (or, if the Admin's tab closes mid-run or a call fails, until the nightly rebuild), descendants inheriting the grant still list the person in `acl_index`. While they are not a member nothing reads it. If they are **re-added** in that window, the stale entries count again until the loop is re-run or the nightly rebuild passes. `/api/admin/create-user` does not clear them before a re-add. Doing so touches the route's shared test mocks (`createUserRoute.test.ts`, `producersRoutes.test.ts`, not this package's) and needs a time budget inside a request, so it was left out (DEC-31). The RPC already admits service_role for that caller.

**Owner of the remainder:** admin-and-org. It is a P8 follow-up the integrator schedules once notifications N14 (`lib/accessRecert.ts`, `lib/ownership.ts`), document-control P25 (the documents page) and admin-and-org P7 (`ViewAsSimulator.tsx`) have merged those files; this package may not edit them. Each fix is one line, as named above. The finding stays OPEN. *(Fix pass 3, 2026-10-13: N14 and P25 have merged on the integration branch — `0cb6409`, `dd49a18`, merged into this branch at `e18cdd9` — and the lines still read as named: `lib/ownership.ts:190` (was `:187`) has no `org_id` filter, `lib/accessRecert.ts` `nameOf` resolves from active members only, and the documents page's principal (`app/(protected)/documents/[libraryId]/page.tsx:1727`) passes no `isActiveMember`. P7 has not merged; `components/permissions/ViewAsSimulator.tsx:450` is unchanged. The same owner holds them.)*

---

<a id="org-8"></a>

## ORG-8 · Request-access has no rate limiter while signup does, and both are distinguishing-response org-name oracles

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/auth/request-access/route.ts:4-24`, `app/api/auth/signup/route.ts:10, 19-29, 53-60`, `supabase/migrations/20261010_signup_rate_limit.sql:9-13`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search for a middleware/edge limiter (none exists). The asymmetry is exactly as described: the endpoint that was hardened is the one that already leaks less.

**Mechanism.** The signup route carries a durable per-IP limiter and the migration explains why: "signup has no CAPTCHA and returns distinguishable 409s for taken email / org names, so an unbounded loop could enumerate accounts and burn trial orgs." `/api/auth/request-access` is the sibling public endpoint on the same page, and has none — no IP check, no attempt log, no CAPTCHA. It answers `404` with `No organization named "X" was found`, `409` with `You already have a pending request to join "<real org name>"`, and `200` with `{ ok: true, orgName: orgRealName }` — three distinguishable outcomes, and the 200/409 paths both echo back the org's TRUE casing from the database (`orgRealName`), turning a fuzzy `ilike` guess into an exact confirmation.

On the signup side the limiter has two holes of its own: the `< 2 chars` org-name rejection returns at line 55 BEFORE `recordSignupAttempt` runs at line 60, so short-name probes are free; and `signupRateLimited` returns `false` for `ip === "unknown"` and `false` on any query error (`if (error) return false; // table absent / transient — fail open`).

Separately, the direct-to-PostgREST path bypasses the route entirely: `access_requests_anyone_insert … WITH CHECK (true)` accepts anon inserts with no limit at all.

**Failure scenario.** An attacker walks a list of chemical and refining company names against /api/auth/request-access at full speed. The 404-vs-200 split maps which plants use the platform, and the echoed `orgRealName` gives the exact registered tenant name. That name is the join key for the signup flow's 409 ("An organization named X already exists") and for a plausible phishing lure. Nothing is logged (the route writes no signup_attempts row and no audit_logs row) and nothing throttles, so the enumeration leaves no trace on the defender's side. The same loop pointed at PostgREST fills `access_requests` — a table nothing reads and nothing prunes.

**Evidence.**

```
request-access/route.ts:19-24 — `if (!org) { return NextResponse.json({ error: \`No organization named "${orgName}" was found…\` }, { status: 404 }); }`; line 59 — `return NextResponse.json({ ok: true, orgName: orgRealName });`. signup/route.ts:54-56 — the short-name return precedes the attempt log at line 60. signup/route.ts:20 — `if (ip === "unknown") return false;`, line 27 — `if (error) return false;`.
```

**Chain reaction.** 20261010's stated purpose was closing "unauthenticated reconnaissance" (finding H4); the fix landed on one of the two public endpoints on that page.

**Done when.**

- [ ] /api/auth/request-access records attempts and enforces the same per-IP window as /api/auth/signup
- [ ] The 404/409/200 responses are collapsed to one neutral acknowledgement, or the org's real name is no longer echoed
- [ ] The short-org-name rejection in signup records an attempt before returning
- [ ] The anon INSERT policy on access_requests is removed so PostgREST cannot be used to bypass the route

---

<a id="org-9"></a>

## ORG-9 · Subscription/trial enforcement is inert at all three layers, and orgs UPDATE is column-unrestricted so any Admin can self-grant 'active' or hijack another tenant's Stripe identity

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/subscription/SubscriptionGate.tsx:3-8, 46-48`, `lib/serverAuth.ts:78-100`, `supabase/migrations/20260713_document_publish_guard.sql:90-107`, `supabase/schema.sql:1042-1045`, `app/api/stripe/webhook/route.ts:138-146`, `supabase/migrations/20260601_billing.sql:31`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All five sub-claims verified, including both claims of absence. MEDIUM is fair: enforcement being off is a deliberate, commented choice, so the self-grant has no effect today, but the customer-id column being tenant-writable makes another tenant's webhook resolution attacker-influenced.

**Mechanism.** Three enforcement points exist; none runs.
(a) `SubscriptionGate` — header says "the enforcement that was missing… Previously `hasAccess()` existed but had ZERO callers: an expired trial showed a red banner and nothing else, so lapsed orgs kept full access" — then `const ENFORCE = false;` and `if (!ENFORCE || loading || hasAccess(info)) return <>{children}</>;`. Every render short-circuits on the first disjunct.
(b) `assertOrgHasAccess` in lib/serverAuth.ts:78 — the server-side gate for billable mutations. Two search shapes (`grep -rn assertOrgHasAccess` across ts/tsx; `grep -rn OrgHasAccess` across app/lib/components) return only the definition. Zero callers.
(c) `org_has_active_subscription(p_org uuid)` — its own comment says "NOT wired to any blocking policy yet". A repo-wide grep across ts/tsx/sql returns only the CREATE. Zero callers.

Meanwhile the write side is wide open: `CREATE POLICY "orgs_admin_write" ON orgs FOR UPDATE USING (id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'))` (schema.sql:1042-1045) — FOR UPDATE, no column restriction, no RESTRICTIVE guard on the billing columns anywhere. Any Admin can PATCH `orgs` over PostgREST and set `subscription_status`, `trial_ends_at`, `subscribed_plan`, `stripe_customer_id`, `stripe_subscription_id` to anything the CHECK constraint permits.

`stripe_customer_id` has only a non-unique partial index (`CREATE INDEX … orgs_stripe_customer_idx`), and the webhook resolves an org by `.eq("stripe_customer_id", customerId).maybeSingle()` (webhook/route.ts:140-145). Two orgs carrying the same value makes `maybeSingle()` return no row, so `orgId` is null and the handler `break`s.

**Failure scenario.** Trial path: a 60-day trial org (signup/route.ts:4,104) lapses. Nothing blocks anything — the gate is compiled off, the server helper is uncalled, the SQL helper is unwired — so the workspace keeps publishing controlled revisions indefinitely. Should enforcement ever be switched on, its Admin simply PATCHes `/rest/v1/orgs?id=eq.<org>` with `{"subscription_status":"active"}` and it is off again.
Hijack path: Admin of org B reads their own org row, then sets `orgs.stripe_customer_id` to the value belonging to org A (obtainable from an invoice, or brute-forced against the observable effect). Stripe's next `invoice.payment_succeeded` / `invoice.payment_failed` for org A resolves to two matching rows, `maybeSingle()` yields null, the handler breaks, and org A's subscription state silently stops tracking reality — no error, no audit row, because the `audit_logs` insert is inside the branch that was skipped.

**Evidence.**

```
SubscriptionGate.tsx:46-48 — `const ENFORCE = false;` / `if (!ENFORCE || loading || hasAccess(info)) return <>{children}</>;`. 20260713_document_publish_guard.sql:90-94 — `-- ── Subscription helper (NOT wired to any blocking policy yet) ──`. schema.sql:1042 — `CREATE POLICY "orgs_admin_write" ON orgs FOR UPDATE` with no WITH CHECK and no column list. webhook/route.ts:144 — `.maybeSingle();`.
```

**Chain reaction.** orgs is also the home of `ticket_prefix`/`ticket_record_code`/`ticket_number_pad` — the record-identifier scheme for every drafting request — and of the org `name`, which is the tenant's unique identity (`orgs_name_unique_ci`). The same unrestricted UPDATE covers all of them.

> **Verifier correction.** Overstated as a security finding. ENFORCE=false is a documented deliberate choice (SubscriptionGate.tsx:41-45: "Hard-blocking is OFF by default… Flip ENFORCE to true … when you actually want to gate access"), not an oversight — and because nothing enforces subscription state, an Admin self-setting subscription_status='active' gains nothing today. The genuine residual defect is the unrestricted billing-column UPDATE plus the non-unique stripe_customer_id, which lets one tenant's Admin poison another tenant's webhook resolution (maybeSingle() → null → handler breaks). That is a billing-integrity issue, not access to controlled documents.

**Done when.**

- [ ] A RESTRICTIVE UPDATE policy (or a trigger) blocks non-service-role writes to subscription_status / trial_ends_at / subscribed_plan / stripe_customer_id / stripe_subscription_id
- [ ] `stripe_customer_id` gets a UNIQUE partial index so two orgs can never claim one customer
- [ ] Either the three enforcement points are wired up, or the dead ones are deleted and the comments claiming enforcement are removed

**Partial (2026-10-02, admin-and-org Round G).** Package P4: Done-when 1 and 2, the RLS and UNIQUE halves the fleet plan assigns it. Done-when 3 (the enforcement half) is A&O P5's (`BILL-10`), so the status stays OPEN for it.

**Reproduced.** In the sequence on `f5073fc`:
- no trigger, column grant or RESTRICTIVE policy on orgs (`orgs_admin_write`, `20261046:136-138`, is the only write policy);
- only the non-unique `orgs_stripe_customer_idx` (`20260601:31`);
- the webhook's `.maybeSingle()` lookup discarding its error (`app/api/stripe/webhook/route.ts:142-150`).

On PostgreSQL 16, before either paste, an Admin's member session updated its own billing columns (1 row), and a second workspace took a customer id another already held.

**What landed.**
- `supabase/migrations/20261176_ao_roundG_orgs_billing_columns_guard.sql`: a BEFORE UPDATE trigger refuses (`42501`) any non-service-role change to `subscription_status`, `subscribed_plan`, `trial_ends_at`, `current_period_end`, `stripe_customer_id` and `stripe_subscription_id`. The record and its tests are under `BILL-2`.
- `supabase/migrations/20261175_ao_roundG_stripe_events_ledger.sql`: `orgs_stripe_customer_unique` (UNIQUE partial), built only in the world with no duplicates. Two workspaces on one customer is now a 409 from the webhook, never a silent drop. The record and its tests are under `BILL-6`.

**Done-when.**
- [x] A RESTRICTIVE UPDATE policy (or a trigger) blocks non-service-role writes to the billing columns ✓ — a trigger, **pending the paste of 20261176**.
- [x] `stripe_customer_id` gets a UNIQUE partial index so two orgs can never claim one customer ✓ — **pending the paste of 20261175** (built where no duplicates exist; otherwise they are counted).
- [ ] The three enforcement points are wired up, or the dead ones deleted — **not done here**: A&O P5 (`BILL-10`, "ORG-9 (enforcement half)").

**Scope / residual.** OPEN for Done-when 3 (A&O P5). The chain reaction's other columns on orgs (`ticket_prefix` / `ticket_record_code` / `ticket_number_pad`, `name`) stay Admin-writable, by design. They are the settings page's and the restore's, and are not billing state.

---

<a id="org-10"></a>

## ORG-10 · The "View as" access simulator queries team_members by a column that does not exist, so team-derived access is invisible in the one screen built to show effective access

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/permissions/ViewAsSimulator.tsx:55-64`, `supabase/migrations/20260707_teams.sql:19-26`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search for the column. The simulator silently reports 'no team grants' for every user, which is worst-case in the one screen built to certify access.

**Mechanism.** `team_members` has columns `team_id, uid, org_id, added_at, added_by` (20260707_teams.sql:19-26) — every other reader in the repo uses `uid` (lib/teams.ts:122, lib/knowledgeAccess.ts:35, app/api/storage/download-url/route.ts:74,100, 20260812_per_library_publish_authority.sql:62). The simulator alone uses `user_id`:
```
const { data } = await supabase.from("team_members").select("team_id").eq("user_id", pick);
if (alive) setTeamIds((((data ?? []) as Array<{ team_id: string }>)).map((r) => r.team_id));
```
PostgREST answers a filter on a non-existent column with 42703. supabase-js resolves rather than throws, so the `catch { setTeamIds([]) }` never runs; `error` is not destructured at all, `data` is `null`, and `data ?? []` yields `[]`. `teamIds` is permanently empty for every subject.

The file's own comment states the contract this breaks: "their EFFECTIVE access is computed with the same evaluators the app enforces with… not a re-implementation that could drift" — and the very next comment, "The picked member's team memberships (teams factor into ACL grants)", names the input that is silently always empty.

**Failure scenario.** An Admin uses View-as during access recertification to check what a contractor can actually reach. The contractor's only route into the restricted As-Built library is a team grant. The simulator feeds `teamIds: []` into `canDiscover`/`canPublishViaIndex`, which report no access. The Admin concludes the contractor is correctly walled off and attests. The contractor can in fact open and download the library, because `node_visible()` in the database reads real `team_members` rows. The tool built to make effective access auditable reports the opposite of the truth, with no error anywhere.

**Evidence.**

```
ViewAsSimulator.tsx:59 — `const { data } = await supabase.from("team_members").select("team_id").eq("user_id", pick);`. 20260707_teams.sql:20-22 — `team_id UUID NOT NULL …, uid UUID NOT NULL …, org_id UUID NOT NULL …`.
```

**Chain reaction.** The query is also missing an `org_id` filter, so even with the column fixed it would return the subject's teams across every org they belong to.

> **Verifier correction.** HIGH is overstated: ViewAsSimulator is an admin diagnostic, not an enforcement path, and the failure is fail-closed (it under-reports access), so nobody gains access from it. The real harm is a reviewer being shown "no team-derived access" during an access review — a wrong compliance answer, not a wrong authorization decision.

**Done when.**

- [ ] The filter uses `uid` and is scoped by `org_id` to the active org
- [ ] The `{ error }` is destructured and a failed lookup renders "team memberships unavailable" instead of silently reporting no team access
- [ ] A test asserts the simulator reports team-derived access for a member whose only grant is via a team

*Cross-area note (2026-09-30, intelligence Round G): intelligence `DACL-5` criterion 3 is handed to the package that fixes this finding (admin-and-org P9, `components/permissions/ViewAsSimulator.tsx`) — show the member's full role collection in the picker (today `:160` shows the headline only) and, for a role rule, which held role it matches. DACL-5 stays OPEN on that limb alone.*

**Resolution (2026-10-07, admin-and-org Round G).** Package P9 — "ORG-10 residual"; the column bug closed earlier (the plan's `alreadyResolvedElsewhere`: "ORG-10 column bug ← DB-2", Round E `OWN-10`). Reproduced on base `c537602` (DEC-29): `components/permissions/ViewAsSimulator.tsx:74` read `team_members … .eq("uid", pick)` with the error destructured and shown ("Team memberships could not be loaded … do not sign off on them", `:76`, `:189-193`), but with no `org_id` filter — a member's teams in another workspace fed this workspace's ACL evaluation — and no test drove a team-only grant through the simulator (`rpPhase5Additive.test.ts` "OWN-10" pins source text only).

Landed: the team read is scoped to the ACTIVE org (`ViewAsSimulator.tsx:114`, `.eq("uid", pick).eq("org_id", activeOrgId ?? "")`) and re-runs when the org changes. The content-rules list now names the team a rule reaches the member by ("via team <name>"; DACL-5's simulator half, below).

Tests: `lib/__tests__/aoRoundGP9ConsoleRendered.test.ts` (rendered, the real simulator and the real evaluators over a PostgREST stand-in) "ORG-10 done-when 3: a member whose only access is a team grant shows as SEEING the library; the team read is scoped to the active org" — a private library whose only rule admitting the member is a team rule shows "visible"; the read's filters are exactly `uid` and `org_id`; the member's row in another org's team is not read; with the membership removed the same member shows "hidden". "ORG-10: a failed team read is said, never shown as 'no team access'".

**Done-when.**
- ✓ The filter uses `uid` (Round E) and is scoped by `org_id` to the active org (this package).
- ✓ The `{ error }` is destructured and a failed lookup renders "Team memberships could not be loaded (…)" — the text names the omission, rendered-tested here.
- ✓ A test asserts the simulator reports team-derived access for a member whose only grant is via a team.

**Scope / residual.** None. The cross-area note above (intelligence `DACL-5` criterion 3, the simulator half) is built here: the picker shows each member's whole role collection and a role or team rule names the held role or team it matches; the Permissions drawer's half is admin-and-org P7's (`DACL-5`'s Partial).

---

<a id="org-11"></a>

## ORG-11 · The org-enforced palette is applied straight from the database with no hex validation, while every other palette entry point validates

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `components/providers/ThemeProvider.tsx:79-108, 116-127, 183, 198-206`, `components/providers/OrgBrandingProvider.tsx:35-44`, `lib/orgBranding.ts:24-38`, `lib/dataRestore.ts:311`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and slightly worse than stated: a non-string palette value makes hexToRgb's `hex.replace("#","")` (:59) throw inside an unguarded useEffect, which takes down the whole provider tree for every member, not just the color tokens. Write access to the branding row is Admin-only (20260713 RESTRICTIVE policies), so the realistic vectors are a hostile/careless Admin or the ORG-1 restore path — MEDIUM stands.

**Mechanism.** `isHex` exists at ThemeProvider.tsx:77 and is used on both other paths: `initialPalette()` gates the localStorage palette (`if (o && isHex(o.primary) && isHex(o.secondary))`, line 122) and the pre-paint `<head>` script re-validates with an inline regex (`if(o&&/^#[0-9a-fA-F]{6}$/.test(o.primary)){prim=o.primary;}`, line 203). The org path does not: `applyOrgPalette = useCallback((p: Palette | null) => { setOrgPalette(p); }, [])` (line 183) feeds `effective` straight into `applyTheme`, which does `root.style.setProperty("--color-accent", p.primary)`, `mix(p.primary, "#000000", 0.15)`, `contrastFg(p.primary)` and string-interpolates into `linear-gradient(135deg, ${p.primary}, ${p.secondary})` (line 94).

`mix` → `hexToRgb` → `parseInt(n, 16)` returns NaN for a non-hex string; `rgbToHex`'s clamp is `Math.max(0, Math.min(255, Math.round(NaN)))` = NaN, `NaN.toString(16)` = `"NaN"`, so the derived tokens become `#NaNNaNNaN`. Custom properties accept that token, so every `var(--color-accent-hover)` / `--color-accent-ring` / `--color-accent-soft` consumer becomes invalid at computed-value time.

The value reaches the browser from `org_configurations` key='branding', which is Admin-writable via PostgREST (the RLS guard checks the key and the role, never the shape) and is also on the restore contract (`"org_configurations"` appears in RESTORE_TABLE_ORDER), so a tampered backup is a second write path.

**Failure scenario.** A malformed or hostile `branding.palette` — from a direct PostgREST PATCH, or from restoring a backup whose org_configurations rows were edited — is loaded by `OrgBrandingProvider` for every member on every page load and applied unvalidated. Accent, hover, ring and soft-tint tokens resolve to `#NaNNaNNaN` org-wide: primary buttons, focus rings and the brand gradient lose their color for every user simultaneously, with no error and no way for a member to override (the org palette wins over the personal one by design — `const effective = orgPalette ?? palette`). Marked SUSPECTED because the branding UI itself can only emit hex (`<input type="color">`), so reaching the bad state requires the direct-write or restore path rather than normal use.

**Evidence.**

```
ThemeProvider.tsx:183 — `const applyOrgPalette = useCallback((p: Palette | null) => { setOrgPalette(p); }, []);` — no validation, versus line 122 — `if (o && isHex(o.primary) && isHex(o.secondary))`. ThemeProvider.tsx:94 — `root.style.setProperty("--brand-gradient", \`linear-gradient(135deg, ${p.primary}, ${p.secondary})\`);`.
```

**Chain reaction.** `saveOrgBranding` (orgBranding.ts:31-38) writes the palette with no shape validation either, so nothing between the input and the DOM checks it.

> **Verifier correction.** The write side is narrower than implied: org_configurations key='branding' is Admin-gated by three RESTRICTIVE policies (20260713_branding_admin_writes.sql:20-34), so only an org Admin (or a tampered restore) can plant a malformed palette — an Admin defacing their own workspace's own theme. This is a robustness/defense-in-depth gap in an input-validation asymmetry, not a privilege boundary, and the rendered outcome (unstyled accents) was not observed, only derived.

**Done when.**

- [ ] `applyOrgPalette` (or `applyTheme`) validates `primary`/`secondary` with the existing `isHex` and falls back to `PALETTE_PRESETS[0]` otherwise, matching `initialPalette`
- [ ] `saveOrgBranding` rejects a non-hex palette before writing

**Resolution (2026-10-13, admin-and-org Round G).** Package P8. Reproduced on `6503ea7` (DEC-29): `components/providers/ThemeProvider.tsx:183` `applyOrgPalette = (p) => setOrgPalette(p)` applied the branding row's palette unvalidated, and `lib/orgBranding.ts:32-38` wrote any shape.
- `ThemeProvider.tsx`: `isHex` takes any value (a non-string is not hex, so `hexToRgb` can no longer throw on one). The new exported `sanitizeOrgPalette` passes a palette whose primary and secondary are both `#RRGGBB`, keeps `null` as `null` (no enforced palette: each member's own applies), and replaces anything else with `PALETTE_PRESETS[0]`, as `initialPalette` does for the stored personal palette. `applyOrgPalette` applies `sanitizeOrgPalette(p)`.
- `lib/orgBranding.ts`: `brandingPaletteProblem` and `saveOrgBranding` refuse a palette that is not two `#RRGGBB` colours before anything is written. *Review fix pass:* only a palette the caller CHANGES is checked (compared with the stored one, which the save already reads as `before`). The logo modal saves `{ ...branding, logoPath }` and so carries the stored palette along. When that palette is invalid (written before ORG-11, or brought in by a restore), a logo upload or removal used to fail with a palette error the Admin never touched, leaving the uploaded object orphaned. It now saves; the theme still sanitizes that palette on the way in. The write reads back its row (a refused write throws in words, never a silent success). The save is audited (`BRANDING_CHANGED`; `ALOG-4` done-when 2). The branding page's colour inputs only emit hex, so no legitimate save changes.
  - *Second review fix:* the "before" was read with `getOrgBranding`, which returns null on a read error, so a failed read passed for "nothing stored". Every palette then counted as changed (a logo-only save carrying a stored pre-ORG-11 palette was refused again), and `BRANDING_CHANGED` recorded `before: null` as if no branding existed. `saveOrgBranding` now reads through `readOrgBrandingChecked`, which tells "no row" apart from "read failed". On a failed read a valid palette still saves. An invalid palette is refused with the read failure named ("Couldn't read the stored branding (…), so this palette can't be checked against it: … Nothing was saved — try again."), because it cannot be told apart from a stored one. The audit row marks the before as unknown (`beforeUnknown: true, beforeReadError`), never as absent.
- Tests: `lib/__tests__/adminOrgSurfaces.test.ts` (ORG-11 block: a failed stored-branding read saves a valid palette with the before marked unknown and refuses an invalid one in words, plus valid, null, non-hex and non-string palettes; a non-hex save refused before any write; a valid save checked and audited; a refused write throws; a logo-only save carrying a stored invalid palette unchanged still saves, and changing it to another invalid one is refused).

**Done-when.**
- ✓ `applyOrgPalette` validates `primary` / `secondary` with the existing `isHex` and falls back to `PALETTE_PRESETS[0]` otherwise, matching `initialPalette`.
- ✓ `saveOrgBranding` rejects a non-hex palette before writing (a palette the save changes; an unchanged stored palette is carried, and sanitized when applied).

**Scope / residual.** A tampered `branding` row from a restore is rendered safely by the first point. The restore's own row validation stays with the restore boundary (DEC-75).

---

<a id="org-12"></a>

## ORG-12 · prune_signup_attempts() has no caller — the housekeeping the migration describes does not exist, and no cron slot is available to add one

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261010_signup_rate_limit.sql:34-40`, `app/api/auth/signup/route.ts:31-34`, `app/api/cron/maintenance/route.ts:286-291`, `vercel.json`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The no-caller claim is true. The severity is not: the row is tiny, signup_attempts is service-role-only with no policies, the hot query is index-covered (signup_attempts_ip_time_idx), and nothing breaks — this is unbounded growth of a housekeeping table. The secondary claim 'no cron slot is available' is also overstated: /api/cron/maintenance already exists as a daily slot and the RPC could be added inside it without a new vercel.json entry.

**Mechanism.** The migration states the intent: "Housekeeping: this table only needs a rolling window. A periodic prune keeps it from growing unbounded; the maintenance cron can call this, and it's safe to run anytime." A repo-wide search for the function name across ts/tsx/sql/mjs returns only its own CREATE statement; a second search for `signup_attempts` returns the migration, the two signup-route call sites, `lib/schemaExpectations.ts:102` and `lib/exportTables.ts:179` — no `rpc("prune_signup_attempts")` anywhere.

Meanwhile `recordSignupAttempt` inserts one row per well-formed attempt (`await supabaseAdmin.from("signup_attempts").insert({ ip, email, outcome }).then(() => undefined, () => undefined);` — errors deliberately discarded), and the rate check only ever reads the trailing hour (`.gte("created_at", since)` with `since = now - 3600s`). Rows older than an hour are pure dead weight and nothing removes them.

The obvious fix is constrained: a third vercel.json cron entry fails deployment on this hosting plan (documented at app/api/cron/maintenance/route.ts:286-291), so the prune must be folded into the existing maintenance route, not scheduled separately.

**Failure scenario.** The table grows monotonically with one row per signup attempt forever — including every bot probe, which is exactly the traffic the limiter is designed to attract. The index `signup_attempts_ip_time_idx (ip, created_at DESC)` keeps the hot count query fast, so nothing degrades visibly; the failure is that the table is on the export contract (`lib/exportTables.ts:179`) and the restore contract, so every data-portability export silently carries an ever-growing log of IP addresses and attempted email addresses — personal data with no retention bound, in a product whose README leads with "your data is yours".

**Evidence.**

```
20261010_signup_rate_limit.sql:37-40 — `CREATE OR REPLACE FUNCTION prune_signup_attempts() RETURNS void LANGUAGE sql AS $$ DELETE FROM signup_attempts WHERE created_at < NOW() - INTERVAL '2 days'; $$;` with the preceding comment naming a caller that does not exist. signup/route.ts:22-26 — the only read is `.gte("created_at", since)` where `since` is one hour back.
```

**Chain reaction.** Same shape as the push_subscriptions cron and the sidebar-badge doorway from earlier audits: a comment describing a scheduled behaviour that was never wired.

> **Verifier correction.** Impact is modest — growth is bounded by the 8-per-hour-per-IP limiter for well-formed attempts, so this is unbounded-but-slow table growth (a comment describing behaviour never implemented), not an availability risk.

**Done when.**

- [ ] The existing maintenance cron route calls `prune_signup_attempts()` (no new vercel.json entry — a third fails deploy per app/api/cron/maintenance/route.ts:286-291)
- [ ] The retention window in the function matches the window the limiter actually reads, or the comment is corrected
- [ ] signup_attempts is reviewed against the data-portability export contract given it holds IPs and attempted emails

---

<a id="org-13"></a>

## ORG-13 · team_members rows are not constrained to the team's own org, and my_team_ids()/node_visible() read team membership with no org scope

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260707_teams.sql:19-26, 45-55`, `supabase/migrations/20260708_acl_rls_enforcement.sql:75-76`, `lib/teams.ts:107-112`, `app/(protected)/admin/teams/page.tsx:85-96, 189-203`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct on every point, and the finding is honest that it is SUSPECTED. Exploitation is blocked in both directions: team_members INSERT is gated by team_members_admin_write (20260707:50-54, USING doubles as the INSERT check) to orgs where you are already Admin/Manager, and node_visible only runs inside policies that already require membership of the row's org — so a foreign team_id buys nothing without membership you already have. Latent schema-integrity debt: LOW.

**Mechanism.** `team_members` carries its own `org_id` column alongside `team_id`, with no constraint tying them together — no composite FK to `teams(id, org_id)`, no trigger, no CHECK. Its write policy authorizes on the row's own `org_id` only: `CREATE POLICY "team_members_admin_write" ON team_members FOR ALL USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin','Manager')))`. So an Admin/Manager of org A can insert `(team_id = <a team in org B>, uid = <themselves>, org_id = <org A>)` — the org_id they are entitled to — and RLS passes; the `team_id` FK to `teams(id)` is satisfied because the team really exists.

The readers then diverge. `user_can_publish_on_library` correctly scopes: `FROM team_members WHERE uid::text = p_uid AND org_id = p_org` (20260812:62). But `my_team_ids()` is `SELECT team_id FROM team_members WHERE uid = auth.uid()` with no org filter, and `node_visible` does `SELECT array_agg(team_id::text) INTO v_teams FROM team_members WHERE uid = auth.uid();` — also unscoped. Both feed the ACL team bucket.

Separately, `updateTeam` writes `supervisor_user_id` with no validation that the uid is a member of the team's org (`row.supervisor_user_id = patch.supervisorUserId`), and the teams page lets an Admin OR Manager set any active member — including a Viewer — as supervisor of a department that owns a library, which makes them the library's effective owner (ownership.ts:47-57).

**Failure scenario.** The unscoped reads mean a team_members row is honoured against any org's acl_index that names that team id. Cross-tenant exploitation is blocked today by the permissive org policies (you must still be an active member of the target org to see its rows at all), which is why this is SUSPECTED rather than confirmed-exploitable. What IS reachable from the repo: a Manager — who cannot grant Admin (20260817 blocks that) and cannot edit the capability policy (20260831 blocks that) — can freely add themselves to any team in their org via the teams page and inherit whatever library publish/admin grants that team holds, and can appoint any Viewer as supervisor of a library-owning department, conferring effective-owner publish authority on a read-only role. Both writes are client-side (lib/teams.ts) with RLS as the sole enforcement, and neither is audited.

**Evidence.**

```
20260707_teams.sql:45-49 — the policy tests only `org_id`, never `teams.org_id`. 20260708_acl_rls_enforcement.sql:75-76 — `SELECT array_agg(team_id::text) INTO v_teams FROM team_members WHERE uid = auth.uid();`. Contrast 20260812:61-62 — `FROM team_members WHERE uid::text = p_uid AND org_id = p_org;`. teams.ts:108-111 — `supabase.from("team_members").insert({ team_id: input.teamId, uid: input.uid, org_id: input.orgId, added_by: input.addedBy })`.
```

**Chain reaction.** Team membership is an ACL subject (`subject.type === "team"`), a publish-authority subject, and — via supervisor → library owner → `user_is_effective_owner` — a publish-guard bypass. Self-service team joining touches all three.

> **Verifier correction.** The cross-tenant read consequence does not follow, and should not be asserted. node_visible is used only as a RESTRICTIVE overlay (20260708:85-91 `CREATE POLICY documents_acl_select ON documents AS RESTRICTIVE FOR SELECT USING (node_visible(...))`, same at 20260813:52), so it ANDs with the permissive org-membership policies — an attacker who plants a foreign team_id still fails the `org_id IN (SELECT my_org_ids())` gate on org B's rows. What remains is real but narrower: a missing composite-FK invariant, a within-org integrity gap, and the my_team_ids/node_visible vs user_can_publish_on_library scoping inconsistency.

**Done when.**

- [ ] `team_members` gets a composite FK or trigger enforcing `org_id = (SELECT org_id FROM teams WHERE id = team_id)`
- [ ] `my_team_ids()` and `node_visible`'s team lookup filter by the org in question, matching `user_can_publish_on_library`
- [ ] `updateTeam` validates that `supervisorUserId` is an active member of the team's org
- [ ] Team membership and supervisor changes write audit_logs rows

**Resolution (2026-10-13, admin-and-org Round G).** Package P8. Reproduced on `6503ea7` (DEC-29). `team_members.org_id` was tied to nothing (`20260707:19-26`), and `node_visible`'s team lookup (newest body `20261041:74-75`) read `team_members WHERE uid = auth.uid()` with no org. Reproduced on a throwaway PostgreSQL 16: before the paste, a member planted in another workspace's team, and a member whose legitimate team belongs to another workspace, both saw a restricted document whose index named that team.
- **The rail: a trigger, not a composite FK (DEC-90 ruling for this package).** A composite FK needs a new unique key on `teams` and rewrites every row. `supabase/migrations/20261203_ao_roundG_team_members_org_rail.sql`:
  - `trg_team_members_org_rail` (BEFORE INSERT OR UPDATE OF team_id, org_id). A SECURITY DEFINER read of the team's org refuses a row whose `org_id` is not its team's (check_violation). It is a definer read so that RLS cannot hide another workspace's team and let the row through.
  - `trg_teams_org_move_rail`: a team that has members cannot move to another org.
  - The rows that already broke the rail are counted before the transaction and removed inside it, one machine `TEAM_MEMBER_REMOVED` row each (`reason: cross_org_team_member`).
- **`node_visible` org-scoped.** `node_visible/6` is re-created from its NEWEST definition (`20261041`, found by scanning) with exactly one line changed: `FROM team_members WHERE uid = auth.uid() AND org_id = p_org;`, matching `user_can_publish_on_library`. The 3-arg wrapper delegates to it. Its grants are left exactly as they are: a policy written for every role calls it.
- **The supervisor.** `lib/teams.ts` `assertSupervisorIsActiveMember` (new) runs before `setTeamSupervisor`'s and `updateTeam`'s write. A suspended person, a uid of another workspace, or a stale picker entry is refused in words, and a read failure refuses too.
  - *Second review fix: the database refuses it too.* The browser check alone let a direct PostgREST PATCH of `teams.supervisor_user_id` through (a Manager or Admin with RLS write on teams), and that person became the effective owner of the team's libraries. `20261203` now adds `trg_teams_supervisor_member_rail` (BEFORE INSERT OR UPDATE OF supervisor_user_id, org_id on `teams`). Its function `enforce_team_supervisor_member()` is SECURITY DEFINER, with `search_path` pinned and EXECUTE revoked from PUBLIC, anon and authenticated. A person's write (`auth.uid()` set) that SETS or CHANGES the supervisor, or moves a supervised team, must name a user with an **active** `org_members` row in the team's own org, or it is refused (check_violation). The legitimate cases pass and are not re-judged: a write that leaves the supervisor as it was (so a team whose supervisor was later suspended can still be renamed), a clear to NULL (`revoke_member` does it), and writes with no `auth.uid()` (restore, service jobs). Existing teams are counted in the pre-apply inventory, never changed. A probe checks the trigger's shape. PG16, on the extracted function and trigger: a rename keeping a suspended supervisor passed; another org's uid was refused; an unchanged suspended supervisor passed; a suspended supervisor on INSERT was refused; an active member passed; a clear passed; a no-uid write passed.
- **Tests.** `lib/__tests__/aoRoundGP8Migrations.test.ts` (node_visible lineDiff against the newest earlier definition, plus a tripwire on the newest in the whole sequence; the rail's shape; the audited removal inside the transaction). `lib/__tests__/adminOrgSurfaces.test.ts` (ORG-13 block). `lib/__tests__/rpPhase6Additive.test.ts`: its two supervisor-change cases now seed the new supervisor's active membership; their assertions are unchanged. PG16 (throwaway cluster): the forged row removed and audited; a cross-org insert, and an UPDATE of team_id to another org's team, refused, including as an Admin of org A (whom RLS would not show team B); a same-org add passes; a team with members cannot move and an empty one can; a rename is unaffected. After the paste neither member above sees the document; a member of the document's own team still does. A re-run is a no-op.

**Done-when.**
- ✓ `team_members` gets a trigger enforcing `org_id = (SELECT org_id FROM teams WHERE id = team_id)` (`20261203`, PASTE pending).
- ✓ `node_visible`'s team lookup filters by the node's org (`20261203`). `my_team_ids()` has no org parameter and no caller (no policy and no app code calls it). Since `20261042` it returns teams only through the caller's ACTIVE membership in `tm.org_id`, which the rail makes the team's own org. The plan closes it by pointer to DEC-20.
- ✓ `updateTeam` (and `setTeamSupervisor`) validate that `supervisorUserId` is an active member of the team's org. Since the second review fix the database enforces it too (`trg_teams_supervisor_member_rail`, `20261203`, PASTE pending), so a direct write of `teams.supervisor_user_id` is refused as well.
- ✓ Verified first, as the plan asks: team membership and supervisor changes write audit_logs rows: `TEAM_MEMBER_ADDED`, `TEAM_MEMBER_REMOVED`, `TEAM_SUPERVISOR_CHANGED`, `TEAM_UPDATED` (`lib/teams.ts`, SURF-16).

**Scope / residual.** `can_manage_node`'s team lookup (`20261046:186`) is not org-scoped. It is not named by this finding, and with the rail its team ids are each in their own org (DEC-31: not widened here). *Before the paste* the app works as today. *After it* a forged cross-org team row is refused (the teams page never writes one).

---

<a id="org-14"></a>

## ORG-14 · The "View as" simulator reports that Admin, Document Control and the project owner cannot sign off quality records — and cannot show a project-scoped grantee at all — while the database admits all of them

- **Severity:** MEDIUM
- **Severity rationale:** The author's estimate (an upper bound, like every unchallenged grade here). The same harm class as `ORG-10`, whose verifier set MEDIUM: the screen built to certify effective access gives a wrong compliance answer, fail-closed — it under-reports, so nobody gains access from it. Mitigated, not removed, by the permissions grid: the `quality.sign_off` row's description names the standing holders, but the simulator itself does not.
- **Status:** RESOLVED
- **Assigned:** admin-and-org P9 (permissions console truth) — by the integrator, 2026-10-01
- **Verification:** CONFIRMED (by reading)
- **Locations:** `components/permissions/ViewAsSimulator.tsx:142-148` (the capability list is `policyAllows(policy, d.id, who.role, who.roles, who.uid, resource)` for every `CAPABILITY_DEFS` row, with `resource` a request type or nothing — never a project), `components/permissions/ViewAsSimulator.tsx:157` ("computed with the SAME evaluators the app enforces with"), `components/permissions/ViewAsSimulator.tsx:185` (the only standing rights it mentions are ticket identity rights), `lib/capabilityPolicy.ts:168-170` (`quality.sign_off`, `defaultRoles: []`), `supabase/migrations/20261136_prj_roundG_quality_signoff.sql:428-437` (`quality_signer_eligible`: a controller, the owner, or the capability for that project)
- **Related:** `QUAL-4`, `QUAL-14`, `ORG-10`, `ALOG-14`, `DEC-13`
- **Independently verified:** — (`author`: opened 2026-10-01 at the J2b integration of projects Round G, per `DEC-31`, from the package's final review; not yet challenged)

**Mechanism.** `QUAL-4` (`20261136`) made `quality.sign_off` the capability that grants quality sign-off BEYOND its standing holders: Admin and Document Control write and sign off a project's checklists, turnover and punch by the four write policies' `is_org_controller` clause, and the project owner by the owner disjunct, whatever the policy says — so the capability's shipped default is `[]`. The simulator answers each capability with `policyAllows` alone, so for an Admin, a Document Control member or a project owner (with no grant) it draws "Sign off quality records" unticked. It also has no project to evaluate against: its resource is `{ requestType }` from the request-type picker or nothing, so a rule scoped to one project (`{ tokens: ["Safety"], when: { projectId: [<id>] } }` — the per-project grant `QUAL-4` exists to allow) never matches there, and the granted Safety lead is drawn unticked as well. The page's subtitle says the answers are "computed with the SAME evaluators the app enforces with"; for this capability the database's answer is `quality_signer_eligible` (controller, owner, or the capability for that project), which the simulator does not reproduce, and its footnote names only the ticket identity rights.

**Failure scenario.** An Admin preparing a PSSR access review asks the console who can sign off project X's quality records. View-as on the project owner, on a Document Control member and on the Safety lead granted on project X shows "Sign off quality records" unticked for all three. The Admin records that none of them can sign off; in fact each can complete X's checklists and accept or waive its turnover, and the owner and Document Control can on every project they can see. The access review is wrong for exactly the people who sign.

**Remediation.** Illustrative: for a capability with standing holders, have the simulator say so beside the verdict ("Admin / Document Control and each project's owner sign off whatever this row says") or compute the standing clause the way `quality_signer_eligible` does; give the capability list a project picker for the capabilities evaluated per project (`PROJECT_SCOPED_CAPS` in `lib/capabilityPolicy.ts`) and pass `{ projectId }`; or ask the database (`quality_signoff_status` answers for the caller only today — a per-member question would need a service-side read, since `quality_signer_eligible` answers for any uid and is closed to clients).

**Done when.**
- The simulator does not report an Admin, a Document Control member or a project's owner as unable to sign off quality records the database lets them sign off.
- A member granted `quality.sign_off` on one project is shown as holding it for that project (and not for another).
- A test compares the simulator's quality sign-off answer against `quality_signer_eligible`'s rule for a controller, an owner, a project-scoped grantee and an ungranted member.

**Resolution (2026-10-07, admin-and-org Round G).** Package P9. Reproduced on base `c537602` (DEC-29): the simulator answered every capability with `policyAllows` alone (`ViewAsSimulator.tsx:143-150`) and its only resource was a request type (`:142`), so `quality.sign_off` (default `[]`) drew Admin, Document Control and a project's owner unticked, and a rule scoped to one project could never match.

Landed:
- `lib/capabilityPolicy.ts qualitySignOffEligible` (`:394`) — the TypeScript mirror of `quality_signer_eligible` (`20261136:428-438`) for an active member: a controller by the collection (`is_org_controller_for`), the project's owner, or a holder of `quality.sign_off` FOR THAT PROJECT (`policyAllows` with `{ projectId }` — a project-scoped rule, the base list, or a live personal grant) who can see the project (`quality_signoff_granted_for`'s visibility rule: not private, or a project member).
- `ViewAsSimulator.tsx`: a **project** picker beside the request-type picker; the project-scoped capability is evaluated with `{ projectId }`, the ticket capabilities with `{ requestType }` (DEC-13). For `quality.sign_off` with a project picked the answer is `qualitySignOffEligible` and says why ("they own the project", "Admin / Document Control always can", "granted by the policy for this project"); with none picked a controller is shown as holding it on every project, anyone else as "per project — pick a project". A failed project-members read is said. The footnote names the project owner's standing right beside the ticket identity rights.
- *Review fix, 2026-10-07.* With no project picked, the answer used to be the base list alone. A base-list holder was told "granted on every project they can see", even where a project-scoped rule replaces the base list and excludes them; the database refuses them there (`tokensFor`; `quality_signoff_granted_for`, `20261136`). The no-project answer now checks each project a stored rule names:
  - **A base-list holder** is told "granted where no project rule applies — not on <projects>, whose project rule replaces the base list (pick a project)".
  - **A member outside the base list** whom a project rule admits is told "not by the base list — granted on <projects> by a project rule".
  - **With no project rules**, or none that changes the answer, the old sentence stands.

Tests: `lib/__tests__/aoRoundGP9PermissionsConsole.test.ts` "ORG-14 — qualitySignOffEligible against quality_signer_eligible (20261136)" (a controller by the collection, the owner, a project-scoped grantee on p1 and not p2, an ungranted member; a grantee who cannot see a private project; an org-wide personal grant; and the SQL it mirrors has the same three disjuncts and the same visibility rule); `lib/__tests__/aoRoundGP9ConsoleRendered.test.ts` "ORG-14: …" (rendered: DocCtrl held only in the collection holds it; the owner is held with no project picked, their project named (integrator fix pass; this first read "does not until their project is picked"), and on their project, not on another; the Safety grantee holds it on p1 and not p2; the ungranted engineer never; the Admin always; review fix: with no project picked, a base-list holder whom p1's rule excludes is named "not on PSSR Unit 200", is refused on p1 and admitted on p2; an engineer admitted only by p1's rule is named "granted on PSSR Unit 200 by a project rule"; with no project rules the old sentence stands).

**Done-when.**
- ✓ The simulator does not report an Admin, a Document Control member or a project's owner as unable to sign off what the database lets them. *(Corrected at the integrator's fix pass, 2026-10-08: with no project picked, a non-controller who OWNED projects was drawn unticked — "per project — pick a project" — which the criterion as written does not allow. Now the projects the member owns are read from the list already loaded (`projects[].ownerUserId`) and the row is drawn as held: "owns <names> — a project's owner always can sign off there; elsewhere not by the base list (pick a project)". The owner disjunct (`user_owns_project`) holds before and after `20261136`.)*
- ✓ A member granted `quality.sign_off` on one project is shown as holding it for that project and not for another — the grant being a project-scoped rule naming a role they hold (a person-scoped project grant does not exist yet: projects-and-cost `QUAL-14` done-when 2, Partial). With no project picked, the simulator names the projects whose rule changes the answer, and never claims "every project" for a member a project rule excludes (review fix).
- ✓ A test compares the simulator's answer against `quality_signer_eligible`'s rule for a controller, an owner, a project-scoped grantee and an ungranted member.

**Scope / residual.** None for this finding's code. The database's rule is `20261136`'s, which is PASTE pending. Until it is pasted, the database does not decide quality sign-off per project: it admits the controllers and the project's owner only. *(Integrator's fix pass, 2026-10-08: the simulator and the explorer now show what holds TODAY and name the rule to come, instead of drawing the rule the database will apply — see below. This read "The simulator shows the rule the database WILL apply".)*

*(P9's second review fix, 2026-10-07.)* Two changes:
- **On screen:** View-as now says this. When a project is picked, it asks the database once (`quality_signoff_status`, which exists only from `20261136`). On a missing function (`42883` / `PGRST202`) it shows "This database does not decide quality sign-off per project yet (migration 20261136 is not applied): today it admits Admin / Document Control and the project's owner only…". A probe that fails for any other reason claims nothing.
- **Record:** the explicit DEC-30 line below was added; this record first said "PASTE pending" only inline.

Tests: `aoRoundGP9ConsoleRendered.test.ts`:
- "ORG-14 (fix pass 2): before 20261136 is pasted, a picked project says the database admits only the controllers and the owner today" *(rewritten at the integrator's fix pass — below)*;
- the regression: with the probe answering, or failing for another reason, no note.

*(The integrator's fix pass, 2026-10-08.)* The fix pass 2 note held only once a project was picked, and even then a policy grantee was ticked. Before `20261136` is pasted the live quality write policies are `20261091`'s `is_org_controller(org_id) OR user_owns_project(project_id)`, which never read the capability, while the route lets an Admin store base tokens for `quality.sign_off` — so View-as with no project picked, and the explorer's row (`ALOG-14`), showed a base-list holder as granted where the database refuses them. Now:
- **The probe runs once on mount** (`probeQualitySignOffDecided`, `PermissionsExplorer.tsx`, shared by both panels), with the nil project id — a project nobody can see answers no row and no error when the function is live; `42883` / `PGRST202` means not live; any other failure claims nothing either way.
- **While the database does not decide yet, nothing the policy grants is drawn as held.** With no project picked a base-list holder reads "the policy grants it, but the database admits only Admin / Document Control and the project's owner until migration 20261136 is pasted — a policy grant of this capability is not read yet" (unticked); on a picked project a grantee reads "granted by the policy for this project, but …" (unticked). The controllers, and an owner on the projects they own, stay ticked. The explorer's row does the same (◐ with the same sentence, ⚠ and a row note).
- **The banner** says the row below is what holds today and that a grant the policy makes is named but not ticked until the paste.
- **DEC-91:** a member row with no headline role is mapped to `null` — never the `"Viewer"` placeholder P9 had left in the member mapping it rewrote — listed as "no role known", said on screen, and simulated as holding no role (`heldRoles` from `lib/roleHeld.ts`; `isControllerPrincipal` takes the null). `org_members.role` is NOT NULL today, so no live member changes.

Tests: `aoRoundGP9ConsoleRendered.test.ts` "ORG-14 (fix pass 2 / integrator fix pass): before 20261136 is pasted — asked once on mount — a policy grant is NOT drawn as held with no project picked nor on a picked project; an owner and a controller are", "DEC-91: a member whose row carries no headline role is listed as 'no role known' — never simulated as a Viewer", "integrator fix pass / ORG-14: before 20261136 is pasted the quality sign-off row shows a policy grant as ◐ …"; `aoRoundGP9PermissionsConsole.test.ts` "integrator fix pass — pre-paste truth on the explorer, no placeholder role, no stale gap" (the probe's shape, the explorer's cells, the owner path, no `"Viewer"` on a code line, the gap text gone).

- Pending migration: `supabase/migrations/20261136_prj_roundG_quality_signoff.sql` (owned by projects-and-cost J2b; not this package's file).

---

## ORG-15 · `/admin/users` ignores the error on its members and pending-requests reads, so a failed read draws an empty roster and hides every pending request

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** admin-and-org P8 (its plan entry already lists `app/(protected)/admin/users/page.tsx`) — by the integrator, 2026-10-02 (at the A&O P0 merge, from P0's proposed finding in `ORG-3`'s record; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED (by reading)
- **Blast radius:** admin visibility
- **Locations:**
  - `app/(protected)/admin/users/page.tsx:119-124`: `const { data } = await supabase.from('org_members')…`; `setMembers(data || [])`.
  - `app/(protected)/admin/users/page.tsx:139-145`: `const { data } = await supabase.from('access_requests')…`; `setPendingRequests((data ?? []) …)`. The card renders only when `pendingRequests.length > 0` (`:373`).
- **Related:** `ORG-3` (its record names this), `ORG-8`
- **Independently verified:** — (`author`: opened by the integrator on 2026-10-02 at the admin-and-org P0 merge, from P0's proposed finding; not yet challenged)

**Mechanism.** supabase-js resolves a failed query with `{ data: null, error }` instead of throwing. Both reads use `data` alone, so a failure looks exactly like an empty result.

**Failure scenario.** The pending-requests read fails (an outage, an expired session, a policy error). The Admin sees no requests card and no sign that anything failed, and a person waiting for access is not seen. Likewise a failed members read draws an empty roster. No request is lost or exposed: the rows stay in `access_requests`.

**Remediation.** Check `{ error }` on both reads and show an error state with a retry instead of an empty list.

**Done when.**
- A failed members read or pending-requests read shows an error, never an empty roster or a missing card.
- A rendered test drives both failures.

**Resolution (2026-10-13, admin-and-org Round G).** Package P8. Reproduced on `6503ea7` (DEC-29) at `app/(protected)/admin/users/page.tsx:119-124` and `:139-145`.
- `fetchMembers` destructures `{ data, error }`. A failed read sets `membersError`, and the table is replaced by "Couldn't load the member list (…). Nothing is shown rather than an empty roster." with a Retry button. "No team members found." renders only after a read that succeeded.
- `fetchPendingRequests` destructures `{ data, error }`. A failed read renders an error card ("Couldn't load pending access requests (…). Anyone waiting to join is not shown until this loads.") with a Retry button in place of a missing card.
- Tests: `lib/__tests__/adminOrgSurfaces.test.ts` (ORG-15, rendered: a members read failure shows the error and no empty roster, and Retry then shows the roster; a pending-requests read failure shows the error card; the regression case renders both as before).

**Done-when.**
- ✓ A failed members read or pending-requests read shows an error, never an empty roster or a missing card.
- ✓ A rendered test drives both failures.

**Scope / residual.** None. The org-name read on the same page still shows "Loading..." on a failure (cosmetic, outside this finding).

---

## ORG-16 · Any member can replace a folder's or library's cover image and page background: `branding/covers/` and `branding/backgrounds/` keys are signed for any member, any Content-Type

- **Severity:** LOW
- **Severity rationale:** The author's estimate. It is `ORG-5`'s mechanism on a smaller surface. The images are a node's decoration, not the workspace's mark, and they are not stamped on controlled drawings. The tenant boundary holds: the org prefix gate refuses another workspace's member.
- **Status:** RESOLVED
- **Assigned:** admin-and-org P10 STORAGE FOLLOW-UPS — by the integrator, 2026-10-13 (A&O P6 merge, DEC-31; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED (by reading)
- **Locations:**
  - `app/api/storage/upload-url/route.ts`. `isWorkspaceLogoKey` holds only files directly under `orgs/<org>/branding/` to Admin; every other key under the org prefix is signed for any active member, with the caller's Content-Type.
  - `lib/storageKey.ts`, `isWorkspaceLogoKey`: `^orgs/<uuid>/branding/[^/]+$`.
  - `components/documents/CustomizeNodeModal.tsx:76-77`, `:93-94` (`uploadToPath` to `orgs/<org>/branding/covers/<uuid>.<ext>` and `…/backgrounds/<uuid>.<ext>`, the prefix handed in by `app/(protected)/documents/page.tsx:511` and `documents/[libraryId]/page.tsx:4805`).
  - The pointers (`coverImageUrl`, `bgImagePath`) are readable by every member who can see the node.
- **Related:** `ORG-5` (opened from its review fix pass, under `DEC-31`), projects `SEC-7` (download disposition)
- **Independently verified:** — (`author`: opened 2026-10-02 at the admin-and-org Round G P6 review fix pass, from the reviewer's finding; not yet challenged)

**Mechanism.** `ORG-5`'s fix held the workspace logo's bytes to the rule its pointer has (Admin). The covers and backgrounds sub-folders were left on the membership rule, so their uploads keep working. But their bytes are then held to nothing beyond membership. A cover or background pointer is readable by every member who can see the folder or library, and upload-url signs a PUT for any key under the org's prefix that is not a published revision's bytes (`PKG-1`). It signs with any Content-Type.

**Failure scenario.** A Viewer or Contractor reads a library's `coverImageUrl` (or `bgImagePath`) key (`orgs/<org>/branding/covers/<key>`), posts it to `/api/storage/upload-url` with any `contentType`, and PUTs any image (or an HTML document) to the signed URL. Every member sees the replaced cover on the library's card the next time it loads. No audit row is written, and the node's customize authority is never consulted, because the node row never changed.

**Remediation.** Illustrative, one of:
- authorize a covers / backgrounds key by the node's customize authority (whoever may save the node's cover may write its bytes), which needs the key to name its node, or a lookup from key to node;
- mint a fresh key per upload, as the app already does, and refuse a PUT to a key that already exists or that any node points at, so the stored bytes of a saved cover cannot be replaced in place;
- pin the Content-Type to an image allow-list, as `ORG-5` does for the logo.

**Done when.**
- A member without the node's customize authority cannot replace the bytes of a cover or background that a node points at.
- A covers / backgrounds PUT carries a signed image Content-Type.
- A route test shows a Viewer refused, and the node's customizer signed, for an existing cover key.


**Resolution (2026-10-13, admin-and-org Round G).** Package P10 (STORAGE FOLLOW-UPS), no migration. Reproduced at base `6503ea7`: `app/api/storage/upload-url/route.ts` read the member as `uid, role, roles` but held only `isWorkspaceLogoKey` (files directly under `branding/`) to Admin, and signed every other org key for any active member, with the caller's Content-Type left unsigned. `lib/__tests__/aoRoundGLogoUpload.test.ts` pinned exactly that ("a folder cover and a page background under branding/ sub-folders stay member-writable, any image type"). The new test "REPRODUCED → fixed: a Viewer posting an existing cover key … is refused 403" fails against base (200).
- **Whose authority (read from the node editor, not invented).** `components/documents/CustomizeNodeModal.tsx` has no gate of its own; it is opened in two places, and both offer it only to `isController = hasAnyRole(["Admin", "DocCtrl"])` (the controller tier, by the full role collection): `app/(protected)/documents/page.tsx:146` (the library tile's `LibraryAdminMenu`, drawn under `{isController && …}`, whose `onCustomize` opens the modal) and `app/(protected)/documents/[libraryId]/page.tsx:3154` (the folder tree's `onCustomize={isController ? … : undefined}`). Those are also the only two places that hand the modal its `storagePrefix` (`orgs/<org>/branding`), so the only members who can upload a cover or background in the app today are those controllers. `lib/storageKey.ts NODE_CUSTOMIZE_ROLES` is that list (Admin, DocCtrl), and a test reads both pages' gate lines and the two `storagePrefix` sites and pins them to it, so the route and the editor cannot drift. It is the set `is_org_controller` reads (role or roles holds Admin / DocCtrl).
- **Done-when 1.** For a key under `orgs/<uuid>/branding/covers/` or `…/backgrounds/` (`lib/storageKey.ts isNodeImageKey`, any depth, so a hand-made deeper key is held too), upload-url refuses a member who holds neither role, by the collection (`memberHoldsAny`), 403 "Only an Admin or a Document Controller can change a folder's or library's cover image or background." (`upload-url/route.ts:52`, `:67-72`). `app/api/storage/multipart/route.ts` applies the same rule on every action for those keys (`:54-64`), so a picture over the client's 64 MB multipart threshold is not the way around it; its member read asks for `role, roles` only for those keys.
- **Done-when 2.** The Content-Type must be one of `NODE_IMAGE_CONTENT_TYPES`, else 415 "A cover or background image must be a PNG, JPEG, WebP, GIF, AVIF or BMP image (SVG is not accepted)." The list is PNG, JPEG, WebP, GIF, AVIF and BMP: the raster types every current browser draws. BMP was added at the review fix; it carries no script. (`nodeImageUploadProblem`; `upload-url/route.ts:78-81`; the multipart create, `:65-68`). SVG is refused as for the logo (`DEC-99` §5: it can carry script and a presigned PUT never passes the server), and so is any non-image type (an HTML page). The type is SIGNED into the presigned PUT (`signableHeaders: content-type`, `:145`), so storage refuses a PUT that sends another type; the multipart upload carries it from `CreateMultipartUpload`. No size cap is added (a phone photo is a normal cover), so `content-length` is not signed.
- **Regression.** Every member who can customise a node today still can, and an Admin or DocCtrl (either held additively) is signed for an existing cover key.
  - **The type the modal sends.** `components/documents/CustomizeNodeModal.tsx` sends the type `lib/storageKey.ts nodeImageTypeFor` gives, and PUTs exactly that string (`uploadToPath(file, path, { contentType })`, pinned). That is the browser's `file.type` when it is on the allow-list. The legacy JPEG aliases `image/jpg` and `image/pjpeg`, which some desktop mime databases report, are sent as `image/jpeg`. An empty or unknown type is read from the file's first 12 bytes (`sniffNodeImageType`: the logo's four magic numbers plus BMP and AVIF). A file that is none of these gets a toast with the route's sentence, and nothing is requested. So a real JPEG that a Linux or Windows browser types `''` is signed, as it was at base.
  - **Key names.** The key's extension now comes from that type (`nodeImageExtensionForType`), not from the file's name, so a new cover can always be restored by its extension.
  - **Unchanged.** Documents, ticket files and the logo rule are unchanged (pinned).
  - **Backup restore** (Admin-only). It puts covers and backgrounds back. `lib/storageKey.ts contentTypeForKey`'s table gains `jfif` (image/jpeg), `avif` (image/avif) and `bmp` (image/bmp), because the modal used to name a key after the file. `restoreUploadRequest` also reads a cover's or background's first bytes, as `ORG-5` reads a logo's, and `app/(protected)/admin/restore/page.tsx` passes them for those keys too. So a cover picked as "photo" and stored at `<uuid>.photo` is put back as the JPEG it is, not refused as octet-stream. A logo's restore rule is unchanged: `sniffImageType` is untouched.
  - **A cover the restore cannot put back is named, not counted as a failure** (fix pass 2, review issue 3). At base an SVG cover was typed `image/svg+xml` and signed for any member, so an Admin's restore put it back; after this finding upload-url refuses it (415). `restoreUploadRequest` now returns `nodeImageProblem` for a cover or background key whose type `nodeImageUploadProblem` refuses (an SVG, HEIC or TIFF from before the rule, or bytes that are no allowed image under an extension the table does not name). `app/(protected)/admin/restore/page.tsx` does not ask upload-url for it. It lists it in its own notice, as `ORG-5` does for a logo (`logoNotRestored`): "N folder or library cover / background image(s) in this backup were not put back (covers/<file>, …): a cover or background must now be a PNG, JPEG, WebP, GIF, AVIF or BMP image (SVG, HEIC and TIFF are not accepted). Open the folder or library under Documents → Customize and pick the image again; until then it shows no cover or background." So the Admin learns which files need a new image instead of reading a generic "1 failed" with a broken card. The remaining gap is opened as `ORG-18`.
- Tests: `lib/__tests__/aoRoundGStorageFollowups.test.ts` ("ORG-16 — …"): a Viewer refused for an existing cover and background key (and with an HTML type); every role outside the gate refused; Admin, DocCtrl and Viewer-plus-DocCtrl signed with `content-type` in `X-Amz-SignedHeaders` (real presigner); each allowed type signed and SVG / HTML / octet-stream / none refused 415; a deeper key and a non-member refused; documents unchanged; the multipart route (Viewer 403 on every action before storage is touched; a controller's create 415 without an image type and carrying the type with one; a library scan still multiparts for any member); the two pages' gates and prefix sites pinned to `NODE_CUSTOMIZE_ROLES`; the key shapes; the restore helper's covers by extension. Review fix ("ORG-16 review fix — …"): `nodeImageTypeFor`'s cases (aliases, empty type with JPEG / BMP / AVIF bytes, HTML and SVG refused); a DocCtrl's empty-typed JPEG, `image/pjpeg` JPEG and BMP signed through the route; a `<uuid>.photo` cover restored by its bytes (415 by extension alone); the restore page's byte read pinned; the modal's type and key-extension lines pinned. `aoRoundGLogoUpload.test.ts`: its covers / backgrounds pin now asserts this rule; its ".jfif" reproduction notes that the extension table now names `.jfif`; its restore-page pin and its "non-logo key" bytes case follow the cover byte read. Fix pass 2 ("review fix (issue 3): …"): a legacy SVG, HEIC and TIFF cover or background carries `nodeImageProblem` (the route's sentence; the route would 415 it), while an allowed cover, a logo and a document carry none; the restore page's skip (before the presign request) and its named notice are pinned.

**Done-when.**
- ✓ A member without the node's customize authority cannot replace the bytes of a cover or background that a node points at, through upload-url or the multipart route. (The pointer side is a different authority: see Scope / residual and `ORG-17`.)
- ✓ A covers / backgrounds PUT carries a signed image Content-Type.
- ✓ A route test shows a Viewer refused, and the node's customizer (Admin, DocCtrl) signed, for an existing cover key.

**Scope / residual.**
- **A controller can still replace a cover's bytes in place** (they are the customizers). Fresh keys are what the modal mints; no audit row is written for a cover upload (the record does not ask for one; the logo's row is `ORG-5`'s).
- **A cover or background already stored as SVG keeps rendering** (its pointer is unchanged). A new one cannot be uploaded as SVG, HEIC or TIFF. SVG is refused for its script. HEIC and TIFF are refused because most browsers do not draw them. The modal says so before any request. A picked file whose type is empty or unknown is typed from its bytes, so only a file that is no PNG, JPEG, WebP, GIF, AVIF or BMP is refused. Opened as `ORG-18` (`DEC-31`, owner the integrator to route); the allow-list itself is `DEC-99` §5's rule.
- **A backup's SVG, HEIC or TIFF cover or background, or one whose bytes are none of the allowed images and whose extension the restore table does not name, is not put back.** At base an SVG one was. This is a regression this finding accepts for SVG's script risk (`DEC-99` §5). The restore page names each such file and says to pick the image again under Customize (fix pass 2). After the restore the node's pointer still names the missing key, so its card shows no cover until someone does. Opened as `ORG-18` (`DEC-31`, owner the integrator to route), with the legacy-format upload gap above.
- **Who may point a node at a cover is not this finding.** At the database a folder's appearance is held to controller, owner or a manage grant (`collections_update_controllers`, `20261044`), but a library's appearance columns (`cover_image_url`, `page_config`) are writable by any member under `libraries_org_access` (`schema.sql:1098`; `enforce_library_sensitive_columns` does not list them). The editor is controllers-only, so no app flow changes. That pointer gap is opened as `ORG-17` (`DEC-31`), owner the integrator to route.
- **A folder's owner or manage-grant holder who is not a controller** may set a folder's cover pointer at the database (`20261044`) but could not open the editor before and cannot upload new bytes now; their customize path in the app was already none.


---

## ORG-17 · Any member can repoint a library's cover image and page background: the appearance columns sit under the membership-wide `libraries_org_access`, and only the UI holds the node editor's authority

- **Severity:** LOW
- **Severity rationale:** The author's estimate. Decoration, not a controlled record: nothing about a document, a revision or an approval changes, and no other workspace is reached. The cost is that any member (a Viewer, a Contractor) can change what every member sees on a library's card and page, including pointing it at an external URL that every viewer's browser then loads.
- **Status:** RESOLVED
- **Assigned:** — Owner: the integrator, to route (opened by admin-and-org Round G P10 under `DEC-31` from `ORG-16`'s Scope / residual; the fix is a `libraries` UPDATE rail, so it likely belongs to the package that next re-creates `libraries` policies or `enforce_library_sensitive_columns`).
- **Assigned:** admin-and-org P11 APPEARANCE RAILS (a `libraries` / folder UPDATE rail: the cover and background columns change only for a member holding the node editor's authority — Admin / DocCtrl, `NODE_CUSTOMIZE_ROLES` — every other column decided as today; DEC-30 migration) — by the integrator, 2026-10-13 (at the A&O P10 merge, DEC-31; fleet plan `admin-and-org.json`).
- **Verification:** CONFIRMED (by reading)
- **Locations:**
  - `supabase/schema.sql:1098`: `CREATE POLICY "libraries_org_access" ON libraries FOR ALL USING (org_id IN (SELECT my_org_ids()))`, the only permissive policy on `libraries`; no UPDATE policy narrows it (the only restrictive one is `libraries_delete_controllers`, `20261036:70-72`).
  - `supabase/migrations/20261077_dc_roundF_records_rails.sql` (`enforce_library_sensitive_columns`, newest): guards owner, ACL, visibility and policy columns, not `cover_image_url`, `cover_tint`, `color`, `icon`, `description` or `page_config` (whose `background.imagePath` is the page background).
  - `app/(protected)/documents/page.tsx:123-142` (`saveLibraryAppearance`, a browser update of those columns) is reached only from the controller-gated editor (`:146`, `:446-453`).
  - `components/documents/NodeCover.tsx:29`: a pointer that is an `http(s):` / `data:` URL is drawn directly; a storage key is signed.
- **Related:** `ORG-16` (the bytes; resolved), `ORG-5`, roles-and-permissions `OWN-1` (the sensitive-column guard this extends)
- **Independently verified:** — (`author`: opened 2026-10-13 at admin-and-org Round G P10, from `ORG-16`'s recon; not yet challenged)

**Mechanism.** `ORG-16` held a cover's and a background's BYTES to the node editor's authority (Admin / DocCtrl). The library row's POINTERS to them are held to membership: `libraries_org_access` is `FOR ALL` with membership only, and the sensitive-column trigger lists ownership and policy columns, not appearance. Folders differ: `collections_update_controllers` (`20261044`) is a restrictive UPDATE policy (controller, owner or a manage grant).

**Failure scenario.** A Viewer sends `PATCH /rest/v1/libraries?id=eq.<lib>` with `{ "cover_image_url": "https://example.net/pixel.png" }` (or another library's cover key, or `page_config` with a new `background.imagePath`). The update passes RLS and the trigger. Every member who opens the documents list now sees that image on the library's card, and their browser fetches the external URL. No audit row names who changed it.

**Remediation.** Illustrative: add the appearance columns to `enforce_library_sensitive_columns` (or a restrictive `libraries` UPDATE policy) held to `is_org_controller(org_id)` — the editor's gate — re-created from its newest definition (`20261077`), with an inventory of rows whose appearance a non-controller last changed if that is recorded. A library owner or manage-grant holder could be admitted to match folders (`20261044`), which is a product call: today the editor is controllers-only for both.

**Done when.**
- A member who cannot open the node editor cannot change a library's `cover_image_url`, `cover_tint` or `page_config.background` at the database; a controller still can, from the editor.
- A test or a probe shows a non-controller's update of those columns refused and a controller's applied.

**Resolution (2026-10-13, admin-and-org Round G).** Package P11 (APPEARANCE RAILS), migration `20261210_ao_roundG_node_appearance_rail.sql` (**PASTE pending**, one paste, re-runnable). Ruled under `DEC-90` (the integrator's brief for P11): the cover-image and page-background columns of libraries, and of folders since they carry them, change only for `NODE_CUSTOMIZE_ROLES` (Admin / DocCtrl, the node editor's own gate) when a signed-in person writes; a write with no `auth.uid()` passes; every other column is decided exactly as today; existing values are counted, never changed.
- **Reproduced on the base (`0a3150a`)** on a throwaway PostgreSQL 16 with the real bodies of every trigger and policy on the two tables, extracted from `supabase/` (`is_org_controller` 20260814, `enforce_library_sensitive_columns` 20261077, `enforce_library_insert_sensitive_columns` 20261062, `audit_review_control_change` 20261072, `collections_guard_access_change` / `collections_update_controllers` 20261044, `audit_library_delete` 20261204, `libraries_delete_controllers` 20261036, `libraries_org_access` / `collections_org_access` schema.sql). A Viewer's `UPDATE libraries SET cover_image_url = 'https://example.net/pixel.png'` landed (1 row), and so did a Viewer's repoint of `page_config.background.imagePath` and of `cover_tint`.
- **The rail.** `enforce_node_appearance_columns()` (SECURITY DEFINER, `SET search_path = public`, EXECUTE revoked from PUBLIC, anon and authenticated — DRLS-16), attached as `trg_node_appearance_columns`, a BEFORE UPDATE row trigger, to `libraries` AND `collections`. Its first statement passes a write with no uid (`20261210:112`). It then judges exactly three values, OLD against NEW: `cover_image_url`, `cover_tint` (the cover's duotone recolor — the done-when names it with the cover) and `page_config -> 'background'` (a JSON null reads as none; the header and every other `page_config` key are not judged). A change to any of them needs `is_org_controller(OLD.org_id)` (`:121`) — Admin or DocCtrl by role or roles for an active member, the set `lib/storageKey.ts NODE_CUSTOMIZE_ROLES` names and both pages that open `CustomizeNodeModal` gate on. Otherwise `check_violation` with the upload route's own sentence: "Only an Admin or a Document Controller can change a folder's or library's cover image or background." A write that leaves all three as they were — a rename, a column width, an ACL, a folder move, `revoke_member`'s prune — is not judged at all.
- **Nothing live is re-created.** No policy, and no existing function or trigger, is touched; the function and trigger names are new to the sequence (a test scans every earlier file), so there is no earlier body to line-diff. `libraries_org_access`, `collections_update_controllers`, the 20261077 guard, the INSERT rail, the review-control audit triggers and P8's `trg_library_delete_audit` keep firing; the paste's final SELECT compares the trigger and policy counts on both tables with counts captured before the transaction.
- **Inventory (counts only, before the transaction).** Libraries and folders with a cover pointer, how many of those are an external `http(s):` / `data:` URL drawn directly by every viewer, how many carry a page background, and the trigger / policy counts. Who last set a cover is recorded nowhere, so it is not counted.
- **PG16 cases after the paste (pasted twice: idempotent; every probe `ok = true`).** Refused 23514: a Viewer's cover (an external URL), `cover_tint`, `background.imagePath` repoint and background removal; a Viewer's rename together with a cover change (nothing written); the library's owner (an Engineer) and a Manager changing the cover; a folder's owner and a folder's manage-grant Manager changing the folder's cover or background. Applied: a DocCtrl's and an Admin's Customize save (cover, tint, background, colour), a Viewer holding DocCtrl in `roles`, a DocCtrl's folder cover + background, a write with no uid, and the ORG-18 clear by an Admin. Decided exactly as today: a Viewer's header-only `page_config` change, colour / icon / description / name, column widths with the cover written back unchanged (all applied); the library owner's rename, the folder owner's rename and `{"background": null}` over a NULL `page_config`, the manage-grant holder's folder description (applied); a suspended DocCtrl, another workspace's Admin and a Viewer's folder rename (zero rows, RLS, as before); a Viewer's `owner_user_id` change (refused by the 20261077 guard, its own message). A Viewer calling the function directly: 42501. Coexistence: a DocCtrl's `review_control` change on a library and a folder wrote its two `REVIEW_CONTROL_CHANGED` rows (20261072), and an Admin's library delete wrote `LIBRARY_DELETED` with its folder cascading (20261204). Triggers listed at test time: libraries `trg_libraries_review_control_audit` (AFTER UPDATE), `trg_library_delete_audit` (BEFORE DELETE), `trg_library_insert_sensitive_columns` (BEFORE INSERT), `trg_library_sensitive_columns` (BEFORE UPDATE), `trg_node_appearance_columns` (BEFORE UPDATE); collections `collections_guard_access` (BEFORE UPDATE), `trg_collections_review_control_audit` (AFTER UPDATE), `trg_node_appearance_columns` (BEFORE UPDATE). The scratch cluster was deleted.
- **Regression.** No app flow changes. The only app writers of these columns are the node editor's two saves — `app/(protected)/documents/page.tsx:132` `saveLibraryAppearance` and `lib/libraryCollections.ts` `updateCollectionAppearance` (called at `documents/[libraryId]/page.tsx:4948`), both reached only under `isController = hasAnyRole(["Admin", "DocCtrl"])` (ORG-16's test pins the gates) — and ORG-18's restore clear (an Admin). A census test fails if another file starts writing them. Before the paste the app behaves as today; after it, a controller's save is the same write and passes. No 42703 / 42883 / 42P01 / PGRST2xx path: nothing new is read or called by the app.
- **Tests.** `lib/__tests__/aoRoundGP11AppearanceRails.test.ts` ("20261210 — …", "ORG-17 regression — …"): DEC-30 one-paste shape (counts-only inventory before BEGIN, one final (check, ok, n) SELECT); DRLS-16; the probe literals; the no-uid pass is the first statement; the judged columns are exactly `cover_image_url`, `cover_tint` and `page_config -> 'background'` (plus `org_id` as the gate's argument), never written; the gate and the sentence equal the upload route's; the NEWEST `is_org_controller` (scanned) reads exactly `NODE_CUSTOMIZE_ROLES`; both triggers; nothing re-created and the names new to the sequence; a tripwire on the newest definition; every trigger on the two tables listed by a scan, none other using the function, and no other BEFORE trigger's newest body reading or rewriting the appearance columns (so firing order cannot change the verdict); the writer census and the two saves' lines.

**Done-when.**
- ✓ A member who cannot open the node editor cannot change a library's `cover_image_url`, `cover_tint` or `page_config.background` at the database; a controller still can, from the editor — once `20261210` is pasted (PASTE pending). The same holds for a folder's (the ruling's "collections/folders if they carry them").
- ✓ A test or a probe shows a non-controller's update of those columns refused and a controller's applied: the PG16 cases above (the real trigger bodies), and the paste's own probes for the trigger, its function and the gate.

**Scope / residual.**
- **PASTE pending.** Until `20261210` is pasted the database is as before (any member can repoint a library's cover). Paste order: independent of every other pending file; either order with the P11 deploy.
- **INSERT is not judged** (the brief's rail is BEFORE UPDATE; the done-when is about changing a node). `libraries_org_access` lets any active member INSERT a library, and `20261062` holds only its ownership / ACL / policy columns at birth, so a member can still create a NEW library born with an external cover URL. Folders are not affected (`collections_insert_controllers`, `20261011`, is controllers-only). Opened as `ORG-19` (`DEC-31`), owner the integrator to route. No app insert writes an appearance column (`createLibrary` does not), so a birth rail would change no app flow.
- **No audit row** is written for an appearance change (the record's failure scenario notes it; neither the ruling nor the done-when asks for one). The editor's own saves are not audited today either.
- **A folder owner or manage-grant holder who is not a controller** keeps every other folder write; only the cover and background are now the controllers' at the database. Their app path to them was already none (the editor is offered under `isController` only).
- **Existing pointers** — including any external URL a member set before the paste — are counted by the inventory and left as they are (the ruling); a controller replaces one under Customize.

---

## ORG-18 · A folder's or library's cover or background in a legacy format (SVG, HEIC, TIFF) can no longer be uploaded or restored, and the node keeps pointing at the missing image

- **Severity:** LOW
- **Severity rationale:** The author's estimate. Decoration, not a controlled record. No data is lost from the backup ZIP, which still holds the file. Since `ORG-16` fix pass 2 the restore names each skipped file. The cost is a node whose cover or background shows nothing until a controller picks a new image, and nothing in the app that lists such nodes.
- **Status:** RESOLVED
- **Assigned:** — Owner: the integrator, to route (opened by admin-and-org Round G P10 fix pass 2 under `DEC-31` from `ORG-16`'s Scope / residual).
- **Assigned:** admin-and-org P11 APPEARANCE RAILS (a node whose legacy-format cover or background was not restored has its pointer cleared and says so, never a broken image; the restore names each skipped file, as now) — by the integrator, 2026-10-13 (at the A&O P10 merge, DEC-31; fleet plan `admin-and-org.json`).
- **Verification:** CONFIRMED (by reading and by test: `lib/__tests__/aoRoundGStorageFollowups.test.ts` "review fix (issue 3): a legacy SVG / HEIC / TIFF cover or background is not asked for …")
- **Locations:**
  - `lib/storageKey.ts` `NODE_IMAGE_CONTENT_TYPES` / `nodeImageUploadProblem` (PNG, JPEG, WebP, GIF, AVIF, BMP; SVG refused for script, HEIC and TIFF because most browsers do not draw them).
  - `lib/storageKey.ts` `restoreUploadRequest` (`nodeImageProblem`) and `app/(protected)/admin/restore/page.tsx` ("Put the files back": the skipped covers' notice).
  - `components/documents/NodeCover.tsx` (draws the pointer; a missing object renders no image).
- **Related:** `ORG-16` (resolved; this is its residual), `ORG-5` (the logo's same trade-off, `logoNotRestored`), `ORG-17`
- **Independently verified:** — (`author`: opened 2026-10-13 at admin-and-org Round G P10 fix pass 2; not yet challenged)

**Mechanism.** Before `ORG-16`, any member could upload a cover or background of any type, and the restore put back whatever the backup held, typed by extension (an SVG as `image/svg+xml`). `ORG-16` holds those keys to an image allow-list signed into the PUT. A cover stored as SVG (or HEIC / TIFF, typed `application/octet-stream`) before the rule keeps rendering in place. But it cannot be uploaded again, and a backup restore does not put it back. The restore page skips it and names it. The library row's `cover_image_url` (or the folder's, or `page_config.background.imagePath`) is restored by the data restore and still names the key, so the node points at a missing object.

**Failure scenario.** An Admin restores a Full ZIP into a fresh workspace. A library's cover is `orgs/<org>/branding/covers/<uuid>.svg`, uploaded before `ORG-16`. The files panel says "1 folder or library cover / background image(s) in this backup were not put back (covers/<uuid>.svg) …". The library card renders without a cover, and the panel does not say which library, because the page knows only the key.

**Remediation.** Illustrative, and a product call: (a) after the data restore, clear the pointers whose key was skipped (a controller-held write, which needs the key → node map from the restored rows); (b) name the node in the notice by reading `libraries.cover_image_url` / `collections` / `page_config` for the skipped keys; (c) convert a legacy raster (HEIC, TIFF) client-side to PNG before the PUT. SVG stays refused (`DEC-99` §5).

**Done when.**
- After a restore, no folder or library points at a cover or background key the restore skipped, or the restore names the node (not only the key) that needs a new image.
- A test drives a restore with a legacy-format cover and shows the pointer cleared or the node named.

**Resolution (2026-10-13, admin-and-org Round G).** Package P11 (APPEARANCE RAILS), no migration. Ruled under `DEC-90` (the integrator's brief for P11): a restore that skips a legacy SVG / HEIC / TIFF cover or background clears that node's pointer and names the node and the file in the restore's result; SVG stays refused (script risk, `DEC-99` §5).
- **Reproduced on the base (`0a3150a`).** `app/(protected)/admin/restore/page.tsx` "Put the files back" skipped such a key (`restoreUploadRequest.nodeImageProblem`) and listed only the file (`covers/<file>`); nothing read or changed the restored rows, so the library or folder kept `cover_image_url` (or `page_config.background.imagePath`) naming the missing object, and nothing said which node it was.
- **The clear.** `lib/dataRestore.ts` `clearSkippedNodeImagePointers(supabase, orgId, skipped, scope)` (`:2280`). For each skipped key and each of `libraries` and `collections`, it reads the nodes of this workspace whose `cover_image_url` equals the key, and those whose `page_config` contains `{ background: { imagePath: key } }`. A cover pointer becomes NULL; a background becomes `{ type: "none" }`, which is what the Customize editor writes for "no background" (`pageConfigWithoutBackground`: the header and every other key are kept). Every other column is untouched. Each write is scoped to the node's id, the workspace, and the pointer still naming the key (so an image re-picked meanwhile is not undone), and goes through `checkedWrite`: a zero-row answer (RLS, or the `20261210` rail) is a refusal, said by name, never counted as cleared. A failed read is said, and no write follows it.
- **Which pointers are cleared: those whose file storage did not return.** The page keeps each skipped key with whether `/api/storage/resolve` answered 200 with `missing: true` (`page.tsx:352`). That is the route's answer when the `HeadObject` call fails, for ANY reason: the `catch` around it (`resolve/route.ts:105-108`) is a catch-all, so a NotFound, but also a 5xx, throttling, a timeout or a credentials error, all answer `missing: true`. It is therefore not a proof of absence: a passing storage error can clear the pointer of a file that is still in R2. Fix pass 2 therefore fences the clear: only a node this restore added, and only in a run where storage answered, can be cleared (next bullet). Making the route tell a NotFound from other failures (answer `missing: true` only for a 404) is the full fix, but the route belongs to document-control P2 / drafting-flow DF-P11 (`audit-reports/fleet-plans/drafting-flow.json`), so it is not edited here; opened as `ORG-20`. A file already present is counted "already present" before this point and never reaches it. A key whose check did not answer 200 with `missing: true` is not cleared: its nodes are NAMED as still pointing at the skipped image, and nothing is changed. A key seen twice is one key. *(Fix pass 2026-10-13: the earlier wording here said "confirmed missing" and "the route's answer for an object that is not in storage", which overstated the route (`DEC-29`); the comments in `lib/dataRestore.ts` and the page, and the `skipped` field name (`confirmedMissing` → `reportedMissing`), were corrected with it.)*
- **Fail-safe scope (fix pass 2, 2026-10-13, `DEC-90`).** Because `missing: true` is not a proof of absence, a reported-missing key alone no longer clears anything. A pointer is cleared only when all three hold (`nodeImageClearVerdict`, `lib/dataRestore.ts:2198`): (1) the check reported the key missing; (2) the node is one THIS restore added. Just before the records are written, and after the Admin confirms, the page reads which of the backup's library and folder ids already exist in this workspace (`restoreEnvelopeNodeIds` `:2215`, `nodeIdsPresentBeforeRestore` `:2233`, a checked read in chunks of 200, `page.tsx:268`). The ids that were absent are the ones the restore added, and they accumulate across runs in the session (`addRestoredNodeIds` `:2255`, `page.tsx:277`). A failed read adds nothing, so nothing is cleared, and the failure is shown with the pointer errors. The clear's `.eq("id", …)` write is then reached only for an added id. A library or folder that was already here is NAMED and never written, whatever the check said; (3) storage answered at least once in this files run, meaning a file was uploaded or a HEAD found one already there (`storageAnsweredInRun` `:2209`). In a run where storage never answered (an outage, or wrong credentials, where every HEAD fails), every report of a missing file is distrusted and nothing is cleared. Every other node naming a skipped key is listed as kept, with its reason (`keptBecause`: `not-reported-missing`, `already-here` or `storage-unanswered`, worded by `NODE_IMAGE_KEPT_REASON_TEXT`). `scope` is a required argument, so no caller gets the old clear-everything behaviour. The route's own NotFound-only answer is opened as `ORG-20`.
- **Named in the restore's result.** After every file has been tried (the restored rows are in place: this step follows "Restore records"), the page calls the helper with this workspace's id (`page.tsx:397`) and shows, under the ORG-16 file notice, "So nothing points at a missing image, the cover or background was removed from N folder(s) / librar(ies): library "P&IDs" — cover (covers/<file>); folder "Unit 100" — background (backgrounds/<file>) … Pick a new image for each under Customize." (`data-testid="restore-node-images-cleared"`), a second notice for nodes kept, each with the reason it was kept (`restore-node-images-kept`; fix pass 2: the check did not report the file missing, the node was already here, or storage never answered), and each failed read or write in words (`restore-node-image-errors`). A thrown helper is said, never a silent success. No list is cut short silently: the cleared and kept notices name the first 10 nodes and then say "and N more", the errors show the first 5 and then "and N more that failed", and whenever a list is longer than that a "Show all N" toggle lists every line (`lib/dataRestore.ts overflowLines`, the page's `ShowAllLines`). *(Fix pass 2026-10-13: before it, errors past the fifth were dropped without a count and nodes past the tenth appeared only as "; …".)*
- **Who writes.** The Admin running the restore, through the browser client: the node editor's authority, so `20261210` admits the write before and after its paste (PG16 case A26 in `ORG-17`), and `collections_update_controllers` admits a controller.
- **Restore boundary (`DEC-75` §5).** The record restore still only adds. This is the files step, after it, and it changes one thing, on a row THIS restore added only: a pointer at an object storage did not return (a HEAD failure of any kind, see above). A row that was already in the workspace is never changed by it. *(Fix pass 2, 2026-10-13: this bullet said earlier that the clear also applied to an existing row naming the same key. That is no longer so.)* The Admin is told before running either step. `RESTORE_ADDITIVE_NOTE`, shown in the confirm before the records are applied and on the page, now ends with `RESTORE_FILES_POINTER_NOTE` (`lib/dataRestore.ts:1728`). It says that putting the files back can remove a legacy SVG / HEIC / TIFF cover or background from a folder or library this restore added, that each one is named, and that one already here is never changed. The same sentence sits in the "Put the files back" paragraph above its button (`page.tsx:644`, `data-testid="restore-files-pointer-note"`). A `DEC-75` landed line says so.
- **Regression.** The ORG-16 file notice is unchanged (pinned). A cover or background that was put back, a logo, a document and a file already present are never touched. Before or after the `20261210` paste, the same writes.
- **Tests.** `lib/__tests__/aoRoundGP11AppearanceRails.test.ts` ("ORG-18 — …"), against an in-memory PostgREST chain: a library's legacy SVG cover and a folder's, reported missing — cleared and named, nothing else on the row changed, another workspace's library naming the same key untouched, a put-back cover untouched; a legacy HEIC background — `{ type: "none" }` with the header kept, every write scoped to the workspace and the still-naming pointer; a key not reported missing — named, not written; a duplicate key; a skipped file no node points at; a failed read and a refused write said and not counted; the pure helpers, including `overflowLines` (every line shown or counted); a `DEC-29` pin that the route's catch is a catch-all and the helper's comments say so and no longer say "confirmed". Fix pass 2 adds a review pin: a pre-existing library that names a reported-missing SVG cover is KEPT (`already-here`), named and never written, while an added folder naming the same key is cleared. It also adds the same pin for a background, a storage-never-answered run that clears nothing (`storage-unanswered`), `nodeImageClearVerdict`, `storageAnsweredInRun`, `restoreEnvelopeNodeIds` / `addRestoredNodeIds` (a second run keeps the first run's rows as added), `nodeIdsPresentBeforeRestore` (org-scoped, chunked 200/200/52, a failed read is `ok: false`), and `RESTORE_ADDITIVE_NOTE` ending with `RESTORE_FILES_POINTER_NOTE` while the existing counter pins still hold. The page: the reported-missing flag read from the resolve route's own answer, after the "already present" skip; the helper called after the upload loop with `activeOrgId`; the notices; each list's "and N more" line and "Show all" toggle, with the old silent caps gone; the catch. Fix pass 2 pins: the "was it here" read comes after the confirm and before `runChunkedRestore`; the scope passed to the helper; a failed read shown with the errors; a new drop resetting the added set; the files-step note sitting between the paragraph and the button. `lib/__tests__/aoRoundGStorageFollowups.test.ts`: the ORG-16 skip pin now also expects the skipped key to be kept before the `return`.

**Done-when.**
- ✓ (second limb: the restore names the node) After a restore, every folder or library pointing at a cover or background key the restore skipped is named by node name and file. Each is either cleared, or kept with its reason, or listed as a failed write. A node is cleared only when the restore added it, the storage check reported the file missing, and storage answered during the run. A node that was already here, or one in a run where storage never answered, keeps its pointer and is named with the reason (fix pass 2, `DEC-90` fail-safe). The criterion's first limb (no node points at a skipped key) therefore holds only for nodes the restore added. It is NOT claimed for a node that was already here, which is the safe direction. The panel shows the first 10 (5 for failures) of each list and counts the rest, and "Show all" lists every line, so no node goes unnamed.
- ✓ A test drives a restore's skipped legacy-format cover (SVG) and background (HEIC) through the helper the page calls and shows the pointer cleared and the node named; the page's call site is pinned.

**Scope / residual.**
- **No converter.** A legacy HEIC or TIFF is not converted to PNG on the way back (remediation (c)); the node shows no cover until a controller picks a new image. SVG stays refused (`DEC-99` §5).
- **No audit row** for the clear (the ruling does not ask for one; registering a new action belongs to admin-and-org P7's registry). The restore's panel names every node.
- **A key not reported missing** (the storage check did not answer 200 with `missing: true`) keeps its pointer by design; "Run again" re-checks it.
- **A transient storage error can still clear, but only on a row this restore added,** in a run where storage otherwise answered. The resolve route answers `missing: true` for any `HeadObject` failure (`resolve/route.ts:105-108`), so a passing error on one key while others succeed can clear an added node's pointer whose file is in R2. The node is named in the cleared list. An SVG cannot be re-picked, because `ORG-16` refuses SVG uploads; a HEIC or TIFF can be re-picked only as a converted PNG, JPEG or other allowed type. The full fix is for the route to answer `missing: true` only on a NotFound. That route is owned by document-control P2 / drafting-flow DF-P11, so it is opened as `ORG-20`, owner the integrator to route.
- **Covers or backgrounds already live as SVG** in a workspace (rows that were here before the restore) keep rendering, as `ORG-16` records. Fix pass 2 makes this true for the files step too: a row present before the records were applied is never written (`nodeImageClearVerdict` → `already-here`), and is only named. *(Before fix pass 2 this line said "nothing here touches them", but the code cleared any live node naming a reported-missing key. Corrected, `DEC-29`.)*
- **A row the restore added in an earlier session** (records applied, page reloaded, the backup dropped again and only the files step run) counts as already here, because the session's added set starts empty. It is kept and named, which is the safe direction.
- **A backup whose only files are skipped covers or backgrounds** gives no evidence that storage is answering, so nothing is cleared and each node is named as `storage-unanswered`.

---

## ORG-19 · Any member can create a library born with an external cover image or page background — `libraries_org_access` admits the INSERT and the birth rail does not hold the appearance columns

- **Severity:** LOW
- **Severity rationale:** The author's estimate. `ORG-17`'s harm by another door: decoration, not a controlled record, and no other workspace is reached. The cost is a new library card that every member who can see it draws, including an external URL every viewer's browser then loads. Creating a library at all is a visible act (it appears on the documents list), so this is less quiet than a repoint.
- **Status:** OPEN
- **Assigned:** — Owner: the integrator, to route (opened by admin-and-org Round G P11 under `DEC-31` from `ORG-17`'s Scope / residual; the fix is a `libraries` INSERT rail).
- **Verification:** CONFIRMED (by reading)
- **Locations:**
  - `supabase/schema.sql:1098`: `libraries_org_access` is `FOR ALL USING (org_id IN (SELECT my_org_ids()))` with no WITH CHECK, so the membership test also decides an INSERT.
  - `supabase/migrations/20261062_rp_roundE_library_insert_ownership_rail.sql` (`enforce_library_insert_sensitive_columns`): a non-controller's new library must be born with its ownership, ACL and policy columns NULL; `cover_image_url`, `cover_tint` and `page_config` are not listed.
  - `supabase/migrations/20261210_ao_roundG_node_appearance_rail.sql`: the appearance rail is BEFORE UPDATE only (`ORG-17`).
  - Folders are not affected: `collections_insert_controllers` (`20261011`) is controllers-only.
- **Related:** `ORG-17` (the UPDATE half; resolved), `ORG-16`, roles-and-permissions `OWN-22` (the birth rail this would extend)
- **Independently verified:** — (`author`: opened 2026-10-13 at admin-and-org Round G P11; not yet challenged)

**Mechanism.** `ORG-17`'s rail judges a CHANGE to a node's cover, tint or page background. A new library has no OLD row, and the INSERT path's only rail (`20261062`) lists ownership, access and policy columns, not appearance.

**Failure scenario.** A Viewer sends `POST /rest/v1/libraries` with `{ "org_id": "<their org>", "name": "Read me", "cover_image_url": "https://example.net/pixel.png" }`. RLS passes on membership and the birth rail passes (no owner, ACL or policy set). Every member who can see the new library draws its card, and their browsers fetch the URL. Once it exists, only a controller can change that cover (`ORG-17`).

**Remediation.** Illustrative: hold `cover_image_url`, `cover_tint` and `page_config -> 'background'` to `is_org_controller(NEW.org_id)` on a person's INSERT (NULL or absent passes), as `20261062` does for its columns — either by extending `enforce_library_insert_sensitive_columns` (re-created from its newest definition, lineDiff-pinned) or by giving `enforce_node_appearance_columns` an INSERT arm. No app insert writes these columns today (`lib/libraryCollections.ts createLibrary` does not; the restore inserts with the service role), so no app flow would change. Whether a non-controller should create libraries at all is a separate question (`OWN-22` kept the Save-As door open on purpose).

**Done when.**
- A non-controller's INSERT of a library carrying a cover, tint or page background is refused; a controller's and a service-role insert pass; an insert without them is decided as today.
- A test or a probe shows both.

---

## ORG-20 · `/api/storage/resolve` answers `missing: true` for a storage failure of ANY kind, so its callers cannot tell an absent file from an outage

- **Severity:** LOW
- **Severity rationale:** The author's estimate. Today the one caller that acts on the answer, the restore's `ORG-18` clear, is fenced so a wrong answer cannot change a row that was already in the workspace (fix pass 2). The remaining cost is a restored node's legacy cover cleared by a passing storage error while its file is still in R2, plus the archive prompt shown in the viewer for a file that is present.
- **Status:** OPEN
- **Assigned:** — Owner: the integrator, to route to document-control P2 / drafting-flow DF-P11, who own `app/api/storage/resolve/route.ts` (`audit-reports/fleet-plans/drafting-flow.json`). Opened by admin-and-org Round G P11 fix pass 2 under `DEC-31` from `ORG-18`'s Scope / residual.
- **Verification:** CONFIRMED (by reading; pinned in `lib/__tests__/aoRoundGP11AppearanceRails.test.ts` "DEC-29: the helper's comments do not claim more than the route gives")
- **Locations:**
  - `app/api/storage/resolve/route.ts:105-108`: the `catch` around `HeadObjectCommand` and `getSignedUrl` is a bare `catch {`. It answers `{ archived: true, missing: true, archiveId, … }` with status 200 for any thrown error: a NotFound, but also a 5xx, throttling, a timeout, bad credentials, or a `getSignedUrl` throw.
  - `app/(protected)/admin/restore/page.tsx:352` (the `ORG-18` reported-missing flag, read from this answer).
- **Related:** `ORG-18` (the caller this weakens; resolved with a fail-safe fence), `DEC-90`, `DEC-75` §5
- **Independently verified:** — (`author`: opened 2026-10-13 at admin-and-org Round G P11 fix pass 2; not yet challenged)

**Mechanism.** The route signs a GET only after a successful HEAD. Every failure lands in one catch, which reports the object as missing, so "storage is down" and "the object is not there" give the same answer.

**Failure scenario.** R2 throttles or times out on one HEAD during a restore's "Put the files back". The route answers `missing: true` for a file that is present. Before `ORG-18` fix pass 2, that cleared the cover of every library naming the key, including live ones. Now it can clear only a node the restore just added, in a run where storage otherwise answered. A viewer opening the same key meanwhile is shown the "this file is archived" prompt instead of a transient error.

**Remediation.** Illustrative: answer `missing: true` only when the error is a NotFound (`name === "NotFound"` or `$metadata.httpStatusCode === 404`), and answer any other failure with a 5xx (for example 503, with the reason) so a caller can retry. Check the route's other callers' handling of a 5xx (the viewer's archive prompt, the restore page's upload loop, which already counts a non-200 as "not reported missing").

**Done when.**
- `/api/storage/resolve` answers `missing: true` only for a NotFound (name `NotFound` or `$metadata.httpStatusCode` 404); any other storage failure answers a 5xx.
- A route test drives a NotFound, a 5xx and a timeout from the HEAD and shows the three answers.

---
