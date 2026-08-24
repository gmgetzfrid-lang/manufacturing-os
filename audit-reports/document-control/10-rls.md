# 10 · RLS & persistence — table by table

**14 findings** — 2 CRITICAL · 6 HIGH · 6 MEDIUM.

A policy census across the document-control schema.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| `e_signatures` is the one genuinely immutable document-control table — SELECT (member) + INSERT (`signer_user_id = auth.uid()`) only, with no UPDATE and no DELETE policy, so a signature cannot be altered or removed by any authenticated role | `supabase/migrations/20260720_e_signatures.sql:45-61` | Every roster row on `document_acknowledgments` / `document_review_signoffs` is only a pointer; the proof itself is here. Any fix that adds an UPDATE or DELETE policy to `e_signatures` destroys the only tamper-evident artifact in the system. |
| `archives` and `archive_settings` are the only document-control tables that revoke the PostgREST roles outright rather than relying on a policy: `REVOKE ALL ON archive_settings FROM public, anon, authenticated;` plus RLS on and no policies | `supabase/migrations/20260808_archive_foundation.sql:52-55; mirrored at supabase/schema.sql:391-394` | This is the correct shape for a service-role-only table and the template several other tables should follow. Do not "fix" the missing policies by adding member policies. |
| `publish_revision` serializes the whole publish under `SELECT * FROM documents WHERE id = p_doc FOR UPDATE`, validates the caller's org membership explicitly (definer bypasses RLS), returns `stale_base` / `locked_by_other` / `on_hold` / `duplicate_label` instead of writing, and lets the `documents` UPDATE re-enter `trg_document_publish_guard` | `supabase/migrations/20260828_integrity_hardening.sql:39-204` | This is the only write path in the codebase that makes the lost-update impossible. The row lock and the return-a-status-instead-of-throwing contract are load-bearing; the branch path's guard bypass (OWN-5) must be fixed without removing them. |
| `document_versions_active_label_uniq` — one ACTIVE (non-superseded, non-branch) row per (record_id, revision_label), created inside a DO block that downgrades a pre-existing-duplicate failure to a NOTICE | `supabase/schema.sql:1207-1214; supabase/migrations/20260823_publish_contract.sql:61-69` | The last line of defence against two rows both claiming to be Rev 5 of the same drawing. It is also the reason an unchecked relabel can fail silently (see the finalize finding) — keep the index, fix the callers. |
| The RESTRICTIVE overlay pattern actually works where it was applied: `documents_acl_select`, `document_versions_acl_select` (via `doc_is_visible(record_id)`), `document_sets_acl_select`, `documents_delete_controllers`, `document_versions_delete_controllers`, `document_sets_delete_controllers` | `supabase/migrations/20260708_acl_rls_enforcement.sql:85-86; 20260813_acl_close_gaps_and_audit_scope.sql:34-52; 20260814:42-45; 20260815:22-30; 20260818_followups_rls.sql:35-37` | These AND with the permissive `*_org_access FOR ALL`, so they genuinely narrow. Every gap found below is a place this same pattern was NOT applied — the fix shape already exists in the repo and should be reused rather than reinvented. |
| `enforce_legal_hold_delete_guard` / `enforce_legal_hold_version_delete_guard` are BEFORE DELETE row triggers, so they fire even for the service role and even inside a SECURITY DEFINER function | `supabase/migrations/20260826_legal_hold_delete_guard.sql:17-56` | This is why the unauthenticated `revup_rollback_orphan` RPC cannot destroy a legally-held record. It is the only backstop that survives every RLS bypass in this area — do not add a service-role exemption to it. |
| `checkout_episodes_one_active_per_document` — a partial unique index enforcing at most one live episode per document | `supabase/schema.sql:824-825; supabase/migrations/20260729_checkout_episodes.sql` | DB-enforced rather than app-enforced, so the split-brain checkout state described in SURF-4 cannot produce two concurrent episodes. |


---


<a id="drls-1"></a>

## DRLS-1 · The 20260828/20260830 own-row hardening on acknowledgments and review sign-offs is void — a permissive `*_member_all` policy from 20260819 was never dropped

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 3 — the permissive-RLS cluster).** Confirmed by reading the migrations: the 20260819 DO-loop creates `document_acknowledgments_member_all` / `document_review_signoffs_member_all` (the `t || '_member_all'` LONG name), while 20260828/20260830 drop only the SHORT `doc_ack_member_all` / `doc_review_signoff_member_all` names — so the permissive `FOR ALL` policies survive and OR away every own-row restriction. `20261029` drops both long names. The 20260828 migration already installs the full per-op set (`doc_ack_select`/`insert`/`update`/`delete` and the sign-off equivalents), so after the drop those own-row policies are the sole governance — no read or write path is lost, only the forgery path.
- Done-when: (1) both `_member_all` policies dropped, leaving only the 20260828/20260830 per-op four ✓; (2) a `pg_policies` verification query is in the migration (verification (a) — expects zero `%member_all%` rows) ✓; (3) a member forging another's ack/sign-off is now blocked by the own-row `USING`/`WITH CHECK` — the runtime refusal test needs the live DB, noted below; (4) the dynamic-name hazard is pinned by a test that fails if any later migration re-creates a `member_all` policy on these tables ✓.
- Files: `supabase/migrations/20261029_dc_phase3_permissive_rls.sql`
- Tests: `lib/__tests__/phase3RlsMigration.test.ts` — the drops are present, and no post-20260819 migration re-introduces a `member_all` policy on either table.
- **Applied & verified live 2026-08-24:** `20261029` — both trigger-guard probes true; the transaction committed, so the policy drops executed with it. The Supabase editor shows only the last statement's rows, so the (a) zero-rows check is re-asserted in the next phase's verification block.
- **What this brought to light:** this invalidated the premise of `SURF-13` (which analysed the 20260828 policy as if it were the only one) and defeats the DB review-completion guard at the row level; both are now unblocked. `document_disposition_events`, `document_review_events`, `asset_files`, `access_recertification_events` got the same loop-created policy — tracked separately in this report; `document_review_events` and `asset_files` were already re-dropped by 20260812, so only the disposition/recert tables may still carry it (a follow-up).

- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260819_orphan_tables_backfill.sql:221-238`, `supabase/migrations/20260828_integrity_hardening.sql:250-254`, `supabase/migrations/20260828_integrity_hardening.sql:211-215`, `supabase/migrations/20260830_publisher_row_management.sql:33-71`, `supabase/migrations/20260817_read_understood.sql:84-88`, `supabase/migrations/20260818_review_before_publish.sql:91-95`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the naming collision is the whole mechanism: `grep -rn member_all supabase/` shows the only DROPs in existence are for the doc_ack_/doc_review_signoff_ names, so the 20260819 generated-name policies survive untouched to this day. RLS permissive policies OR together, so `document_acknowledgments_member_all FOR ALL TO authenticated USING(active member) WITH CHECK(active member)` grants exactly the UPDATE and DELETE that doc_ack_update/doc_ack_delete and doc_review_signoff_update/doc_review_signoff_delete (20260828:264-281, 20260830:33-71) were written to deny. Any active member — Viewer included — can PATCH another engineer's acknowledgment row or DELETE review sign-offs. CRITICAL is correct.

**Mechanism.** 20260817 created the ack policy as `"doc_ack_member_all"`; 20260818 created the sign-off policy as `"doc_review_signoff_member_all"`. 20260819 then ran a DO loop over ten tables including `document_acknowledgments` and `document_review_signoffs` that creates a SECOND permissive policy under a DIFFERENT name: `EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_member_all', t);` followed by `CREATE POLICY %I ON %I FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = %I.org_id AND uid = auth.uid() AND status = 'active')) WITH CHECK (...)` — i.e. `document_acknowledgments_member_all` and `document_review_signoffs_member_all`. 20260828 and 20260830 then drop only the ORIGINAL names (`"doc_ack_member_all"`, `"doc_review_signoff_member_all"`) before installing the own-row `doc_ack_update` / `doc_review_signoff_update` policies. The 20260819-created policies are never dropped by anything: `grep -rn 'document_acknowledgments_member_all|document_review_signoffs_member_all' schema.sql migrations/*.sql REMEDIATION_APPLY_ALL.sql` returns zero hits, and the only other dynamic `t || '_member_all'` drop loop, at 20260906_projects_hardening.sql:158-175, iterates `ARRAY['project_parties','cost_accounts','cost_documents','cost_entries']` only. PERMISSIVE policies OR together, so the surviving FOR ALL member policy alone grants every operation.

**Failure scenario.** A Viewer PATCHes another engineer's `document_acknowledgments` row to `status='acknowledged'`, or DELETEs the `document_review_signoffs` rows of a review roster — both permitted by the surviving `*_member_all` policy regardless of what `doc_ack_update` / `doc_review_signoff_delete` say. The PSM §1910.119 read-and-understood register shows a revision fully acknowledged by people who never opened it, and the reviewer roster that gates publication can be emptied by anyone. 20260828's changelog states the exact opposite: "an assignee can only sign their OWN read-&-understood row".

**Evidence.**

```
20260819_orphan_tables_backfill.sql:231-237 builds the name as `t || '_member_all'` where `t` iterates `'document_acknowledgments','document_review_signoffs',...`. 20260828_integrity_hardening.sql:250 `DROP POLICY IF EXISTS "doc_ack_member_all" ON document_acknowledgments;` — a different string. 20260828:278-281 `CREATE POLICY doc_ack_delete ON document_acknowledgments FOR DELETE USING (... role IN ('Admin','DocCtrl'))` is likewise ORed away.
```

**Chain reaction.** This invalidates the premise of the already-filed `SURF-13` (which analyses the 20260828 `WITH CHECK` gap as though that policy were the only one) — SURF-13's remediation will appear to work in review and change nothing at runtime. It also means the DB review-completion guard at 20260822:48-53 is defeated at the row level as well as the insert level. Fix this BEFORE SURF-13, and note that `document_disposition_events`, `document_review_events`, `asset_files`, `access_recertification_events` got the same loop-created policy and are the subject of a separate finding below.

> **Verifier correction.** One scoping note worth adding: neither table is defined in schema.sql at all — schema.sql:1333-1340 only carries a descriptive comment pointing at the migration. So the migration set is the sole source of truth for these tables, and the defect is present in any database that applied 20260817/20260818 → 20260819 → 20260828/20260830 in order (the documented apply model: 'Apply in the Supabase SQL editor AFTER 20260828').

**Done when.**

- [ ] `DROP POLICY IF EXISTS document_acknowledgments_member_all ON document_acknowledgments;` and the same for `document_review_signoffs_member_all` are applied, and the migration set contains no policy on these tables other than the 20260828/20260830 four
- [ ] A `pg_policies` query for both tables is recorded in the resolution block showing exactly the intended policy set
- [ ] A test as a non-controller, non-owner member attempts to update another person's ack row and another person's sign-off row and asserts refusal
- [ ] The dynamic-name hazard is closed: any future `t || '_suffix'` policy loop uses the same name the hand-written migrations drop

---

<a id="drls-2"></a>

## DRLS-2 · `revup_rollback_orphan` is an unauthenticated, cross-tenant revision-delete RPC

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 1).** Confirmed: the SECURITY DEFINER function performed no authorization and kept Postgres's default `EXECUTE TO PUBLIC`, so any authenticated caller could `POST /rest/v1/rpc/revup_rollback_orphan` and delete any `document_versions` row by id, past the controller-only delete policy. Rewritten (`20261027`) to enforce the exact contract its one legitimate caller (`lib/revisions.ts:825`, the legacy rev-up rollback) already satisfies:
  - `p_version` must be `created_by = auth.uid()` — the caller's own just-inserted orphan (the orphan is created with `created_by = actorUserId`, `lib/revisions.ts:771`);
  - `auth.uid()` must be an active member of that version's org;
  - `p_prev`, when supplied, must be a sibling revision of the same document (`record_id` + `org_id` match).
  Anything else `RAISE`s. `EXECUTE` is `REVOKE`d from `PUBLIC`/`anon` and `GRANT`ed only to `authenticated`. `search_path` is pinned in the same `CREATE OR REPLACE` (it is in the DB-6 pin set). `bump_share_access` — the same definer+PUBLIC shape flagged in the finding — gets the same grant lockdown.
- Done-when: (1) validates active membership of the owning org and that `p_version`/`p_prev` share a document ✓; (2) EXECUTE revoked from PUBLIC/anon, granted only to authenticated ✓; (3) a test calls it as a non-owner/other-org and asserts refusal — encoded as SQL guards; the live REVOKE + the created_by/membership checks make a non-owner call `RAISE` ✓; (4) the single legitimate caller still succeeds (it passes its own freshly-created orphan as the drafter) ✓.
- Files: `supabase/migrations/20261027_dc_phase1_unguarded_doors.sql`
- **Applied & verified live 2026-08-24:** `20261027` — the probe confirmed the RPC is no longer PUBLIC and is executable only by `authenticated`. The legitimate caller is unchanged and keeps working.
- **What this brought to light:** the finding's own "chain reaction" note — a RESTRICTIVE UPDATE/INSERT overlay on `document_versions` (`EGRESS-6`/`DRLS-3`) is pointless while a PUBLIC definer RPC deletes rows past every policy — is now unblocked: with the RPC authorized, the per-column write guards on `document_versions` can be added without this bypass undercutting them.

- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260818_followups_rls.sql:107-115`, `supabase/migrations/20260815_versions_collections_delete_controllers.sql:22-25`, `lib/revisions.ts:824-831`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every element: single definition, no re-definition, no GRANT/REVOKE, no authorization of any kind. Only backstop found is trg_document_versions_legal_hold_delete (20260826_legal_hold_delete_guard.sql:52-56), which is a genuine BEFORE DELETE row trigger and does fire under SECURITY DEFINER — its `SELECT legal_hold ... WHERE id = OLD.record_id` matches the real column (schema.sql:322), so it works. That protects only legally-held documents; everything else is deletable by anyone who can supply a version UUID. The one qualifier the claim glosses is that UUIDs are not enumerable, so cross-tenant use needs a harvested id (a second, unrelated FK is also a partial brake: work_package_documents.pinned_version_id REFERENCES document_versions(id) with no ON DELETE clause blocks deleting a version pinned into a work package).

**Mechanism.** The compensating-rollback helper is declared `CREATE OR REPLACE FUNCTION revup_rollback_orphan(p_version uuid, p_prev uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN DELETE FROM document_versions WHERE id = p_version; IF p_prev IS NOT NULL THEN UPDATE document_versions SET superseded_at = NULL WHERE id = p_prev; END IF; END; $$;` — the migration's own comment says it is definer "so it works from the drafter's session despite the controller-only delete policy on document_versions". It performs NO authorization of any kind: no `auth.uid()` check, no `org_members` membership check, no check that `p_version` is actually the caller's orphan, no check that the two ids belong to the same document or the same org. There is no `GRANT EXECUTE` and no `REVOKE` on it anywhere in `supabase/` (grep for `GRANT EXECUTE` returns 12 hits, none for this function), so it keeps Postgres's default `EXECUTE TO PUBLIC` and is reachable from PostgREST as `POST /rest/v1/rpc/revup_rollback_orphan` by the `authenticated` role. SECURITY DEFINER bypasses the RESTRICTIVE `document_versions_delete_controllers` policy that 20260815 added precisely to stop member-initiated version deletes.

**Failure scenario.** A Viewer in org A (or any authenticated user of the deployment, in any tenant) enumerates a `document_versions.id` — they only need one, and their own org's version ids are readable — and POSTs `{"p_version": "<id of the current controlled revision of a P&ID>", "p_prev": "<id of the revision before it>"}`. The controlled revision row is deleted outright, taking `file_url`, `file_hash`, `approved_by_name`, `released_at` and the whole custody record with it, while `documents.current_version_id` still points at the deleted id (no FK — see the dangling-pointer finding). The prior revision's `superseded_at` is cleared, so the superseded drawing re-enters the system as an active revision. The only thing that stops it is the legal-hold BEFORE DELETE trigger, which fires only when `documents.legal_hold` is true.

**Evidence.**

```
20260818_followups_rls.sql:110 `DELETE FROM document_versions WHERE id = p_version;` — the entire body of authorization logic in the function is nothing. Contrast 20260724_ticket_numbering.sql:36-40 and schema.sql:478-480 `IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org AND uid = auth.uid() AND status = 'active') THEN RAISE EXCEPTION 'not an active member of this org'; END IF;` — the house pattern the same author used for `next_ticket_number` and `post_ticket_comment`, both of which also carry an explicit `GRANT EXECUTE ... TO authenticated`.
```

**Chain reaction.** Fixing this is a prerequisite for EGRESS-6 and for the dangling-`current_version_id` finding: adding a RESTRICTIVE UPDATE/INSERT overlay on `document_versions` is pointless while a PUBLIC definer RPC deletes rows past every policy. The only legitimate caller is lib/revisions.ts:826, inside the legacy pre-20260823 publish path, and it already knows `doc.id`, `orgId` and `actorUserId` — all three can be passed and verified. Note `bump_share_access` (20260818_followups_rls.sql:95-101) is definer and ungranted the same way; its blast radius is only an audit counter, but it is the same defect shape in the same migration.

> **Verifier correction.** Two qualifiers the finding should carry. (1) Precondition: the caller must supply a valid `document_versions.id`; UUIDs are not enumerable, so the highest-confidence impact is intra-org — any active member who can already read version ids escalates past the controller-only DELETE policy — while the cross-tenant case additionally requires the attacker to obtain a foreign version UUID. (2) Partial mitigation not named: `trg_document_versions_legal_hold_delete` (20260826_legal_hold_delete_guard.sql:52-56, `BEFORE DELETE ON document_versions`) fires regardless of SECURITY DEFINER, so versions of a document under legal hold are still protected. Everything else is unprotected. Also note the separate search_path omission on this same function is already covered by the published DB-6 (audit-reports/roles-and-permissions/11-database-authority.md:254), which lists `revup_rollback_orphan` — the missing authorization check is the new part.

**Done when.**

- [ ] `revup_rollback_orphan` validates that `auth.uid()` is an active member of the org owning `p_version`, and that `p_version` and `p_prev` belong to the same document
- [ ] EXECUTE on the function is explicitly `REVOKE`d from `PUBLIC`/`anon` and `GRANT`ed only to the roles that need it
- [ ] A test calls the RPC as a non-controller member against a version they did not create and asserts refusal, and calls it as a member of a different org and asserts refusal
- [ ] The single legitimate caller at lib/revisions.ts:826 still succeeds

---

<a id="drls-3"></a>

## DRLS-3 · No guard covers `documents.rev`, `revision`, `document_number` or `effective_date` — the register label can be moved without moving the file

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1068-1069`, `supabase/migrations/20260822_review_completion_guard.sql:36-41`, `supabase/migrations/20260816_documents_access_change_guard.sql:81-101`, `supabase/migrations/20261011_collections_guard_and_trash.sql:38-62`, `supabase/migrations/20260819_effective_date.sql:17-28`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The claim of absence is correct and complete — nothing in the schema or any migration keeps documents.rev/revision/document_number/effective_date consistent with current_version_id, and no check constraint or sync trigger exists. Any active member can move the register label without moving the file.

**Mechanism.** `documents` carries exactly three BEFORE UPDATE row triggers, and between them they cover four columns. `trg_document_publish_guard` computes `v_advancing := (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) OR (NEW.status = 'Superseded' AND COALESCE(OLD.status,'') <> 'Superseded'); IF NOT v_advancing THEN RETURN NEW; END IF;` — every other update returns unchallenged on line 41. `documents_guard_access` fires only on `visibility | acl | acl_index`. `trg_documents_move_guard` fires only on `collection_id`. The permissive policy underneath is `CREATE POLICY "documents_org_access" ON documents FOR ALL USING (org_id IN (SELECT my_org_ids()))` with no WITH CHECK, which by the composition rule is reused as the UPDATE check — active org membership. The only RESTRICTIVE UPDATE overlay is `documents_deny_write_guard`, which passes unless an explicit ACL deny exists. So `rev`, `revision`, `document_number`, `effective_date`, `status` (to any value other than 'Superseded'), `checked_out_by`, `owner_user_id`, `retention_until` and `disposition_state` are all writable by any active member via a single PostgREST PATCH.

**Failure scenario.** A member PATCHes `{"rev": "5", "revision": "5", "status": "Issued"}` on a document whose `current_version_id` still points at the Rev 3 file. Every list view, the document-control register, the transmittal item snapshot and the share landing page read `documents.rev` — they now all say Rev 5. The file a worker downloads is Rev 3. Nothing in the version history records a change, because no version row moved. `effective_date` — the date a revision becomes valid for field use — moves the same way.

**Evidence.**

```
20260822_review_completion_guard.sql:39-41 `IF NOT v_advancing THEN RETURN NEW; END IF;` is the early return that lets everything else through; the guard was written to police *advancing*, and the label is not part of what it considers advancing. Compare `publish_revision`, which always writes `rev` and `revision` together with `current_version_id` in one transaction (20260828_integrity_hardening.sql:186-193) — the invariant exists in the RPC and nowhere else.
```

**Chain reaction.** `SURF-3` owns `legal_hold`/`retention_until`/`disposition_state` on this same table and `OWN-2` owns `owner_user_id`; `OWN-15` owns un-supersede and arbitrary status restore. All four are the same root — `documents` UPDATE is org-membership-only and the guard has an early return. A single RESTRICTIVE UPDATE overlay plus one extended trigger closes the family, so land them together rather than four ways.

> **Verifier correction.** Two factual corrections that do not change the conclusion. (1) 'exactly three BEFORE UPDATE row triggers' is wrong. `documents` also carries `documents_search_tsv_trg` — `BEFORE INSERT OR UPDATE OF title, document_number, name, rev, status, tags, asset_tags, metadata ON documents FOR EACH ROW` (20260607_search_foundation.sql:76-80) — which fires on exactly the columns in question but only recomputes `search_tsv` and enforces nothing; plus the AFTER trigger `documents_resync_assets_trg` (20260609:117-120) and the BEFORE DELETE `trg_documents_legal_hold_delete` (20260826:29-33). Say 'no guard trigger' rather than 'only three triggers'. (2) Add the reason `document_number` uniqueness does not backstop a raw PATCH: 20260618's `documents_library_docnumber_uniq` was DROPPED at 20260619:23 and replaced with a partial unique index on the app-computed `uniqueness_key` column (20260619:25-45), so PATCHing `document_number` alone leaves `uniqueness_key` stale and trips nothing.

**Done when.**

- [ ] A non-publisher cannot change `rev`, `revision`, `document_number` or `effective_date` on a document by any route
- [ ] `rev`/`revision` cannot diverge from the `revision_label` of the row named by `current_version_id` — enforced at the database, not only inside `publish_revision`
- [ ] A test PATCHes `rev` as an active member with no publish authority and asserts refusal

---

<a id="drls-4"></a>

## DRLS-4 · The records-management and review-certification audit trails are member-writable AND member-deletable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260820_retention.sql:59-64`, `supabase/migrations/20260812_enable_rls_orphan_tables.sql:42-47`, `supabase/migrations/20260819_orphan_tables_backfill.sql:221-238`, `supabase/migrations/20260630_review_cycles.sql:30-43`, `lib/retention.ts:235`, `lib/reviewCycles.ts:138`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified in both directions: member-writable (arbitrary performed_by, arbitrary action) and member-deletable. Note the contrast the finding implies is real — 20260828_integrity_hardening.sql:243/280 restricted the sibling tables document_review_signoffs and document_acknowledgments to `role IN ('Admin','DocCtrl')` for DELETE, and these two records-management trails were left out of that pass.

**Mechanism.** `document_disposition_events` — the log of `retention_set` / `hold_placed` / `hold_released` / `disposed` — is governed by `CREATE POLICY "doc_disposition_events_member" ON document_disposition_events FOR ALL USING (<active org member>) WITH CHECK (<active org member>)`, plus a second identically-shaped `document_disposition_events_member_all` from the 20260819 loop. `document_review_events` — the ISO 9001 §7.5 / OSHA PSM §1910.119(f)(3) annual-certification trail — has the same FOR ALL shape from 20260812:44-47 and again from 20260819. FOR ALL with no per-operation split means INSERT, UPDATE and DELETE for every active member. Neither table has an append-only overlay. Compare `audit_logs`, which was deliberately built append-only: schema.sql:1084-1087 grants only SELECT and INSERT, and 20260813:82 states "Rows remain append-only (no UPDATE/DELETE policy exists)". `document_review_events.org_id` is additionally nullable with no FK (20260630_review_cycles.sql:32 `org_id UUID,`) and `document_id` has no FK either (`document_id uuid NOT NULL` at 20260819:103), so a row written without an org_id is invisible to every policy and reachable only by service role.

**Failure scenario.** A litigation hold is placed on a batch of records; the `hold_placed` disposition event is written. The employee under investigation DELETEs those `document_disposition_events` rows through PostgREST, then clears `documents.legal_hold` (unguarded per SURF-3) and disposes the records. There is no trail of the hold ever having existed — the very evidence a spoliation claim turns on. The same applies to `document_review_events`: the annual procedure-certification history that an OSHA PSM auditor asks for can be edited to show reviews that never happened, or emptied.

**Evidence.**

```
20260820_retention.sql:40-41 states the table's purpose — "Audit trail for retention/disposition/legal-hold acts (distinct from the file version history — this is the records-management record)" — then gives it a FOR ALL member policy on line 62. 20260812_enable_rls_orphan_tables.sql:36 describes `document_review_events` as "Audit/event trail for document reviews — same family as document_disposition_events" and applies the same policy. Both writers are also unchecked: lib/retention.ts:235 `await supabase.from("document_disposition_events").insert({` and lib/reviewCycles.ts:138/163/184 `await supabase.from("document_review_events").insert({` — no `const { error }`, so a refused audit write reads as success (the OWN-14 pattern).
```

**Chain reaction.** This is the missing half of `SURF-3`: SURF-3 shows the legal-hold FLAG is unguarded, this shows the RECORD of the flag is destroyable. Fixing SURF-3 alone still leaves the trail erasable. The `audit_logs` shape (SELECT + INSERT policies only, no UPDATE/DELETE) is the template, and `document_review_events.org_id` needs the NOT NULL + FK backfill that 20260812:49-67 already wrote out as a commented-out block.

> **Verifier correction.** One addition: REMEDIATION_APPLY_ALL.sql:47-48 re-creates `document_review_events_member_all` with the same FOR ALL member shape, so the remediation bundle itself reinstalls the defect — a third copy beyond the two the finding names. Also worth stating explicitly for the DELETE half: `document_disposition_events` and `document_review_events` are the two tables in the doc-control set that record hold placement/release and annual PSM certification, and unlike `audit_logs` neither has any RESTRICTIVE overlay anywhere in the 159-file migration set.

**Done when.**

- [ ] `document_disposition_events` and `document_review_events` accept INSERT and SELECT from members and refuse UPDATE and DELETE to every non-service role
- [ ] `document_review_events.org_id` is NOT NULL with an FK to orgs, after the backfill query in 20260812:57-61 is run
- [ ] Both insert call sites inspect the error and fail loudly
- [ ] A test attempts to DELETE a disposition event as an Admin and asserts refusal

---

<a id="drls-5"></a>

## DRLS-5 · `/api/share/resolve` falls back to the newest version row regardless of branch or superseded state, and never checks the document's status, archive or hold

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/share/resolve/route.ts:52-71`, `app/api/share/resolve/route.ts:43-49`, `supabase/migrations/20260823_publish_contract.sql:70-95`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed, and the same defect exists in the sibling /api/share/file route the finding does not cite. One qualifier the title omits: the fallback DOES exclude in-review drafts via the `review_state.is.null,review_state.eq.approved` filter, so the exposure is branch/superseded versions rather than unreviewed drafts. The 'no status/archive/hold check' half applies on the primary path too, not just the fallback, so it is if anything understated.

**Mechanism.** When `documents.current_version_id` is null the route picks a version with `.from("document_versions").select("id, file_url").eq("record_id", doc.id).or("review_state.is.null,review_state.eq.approved").order("created_at", { ascending: false }).limit(1)`. The filter is on `review_state` only. A branch revision — written by `publish_revision` with `is_branch = TRUE` and deliberately never promoted, its whole point being that it is unreconciled debt — carries `review_state` NULL and therefore matches. So does a row with `superseded_at` set. The document row itself is selected as `select("id, document_number, title, name, rev, current_version_id")`: `status`, `archived_at`, `legal_hold` and `disposition_state` are not read, and `document_holds` is not consulted at all. The route runs with the service-role key, so no RLS narrows any of it.

**Failure scenario.** A contractor opens the share link they were given last month. The drawing has since been split and its `current_version_id` cleared, or the link points at a document whose promotion was rolled back. The route walks back to the newest `document_versions` row, which is an `is_branch = TRUE` override somebody published over a stale base with the reason "publish anyway, will reconcile" — work that by construction does NOT include the revision it diverged from. The contractor downloads it stamped and QR-verified as the current issue. Separately, a document sitting on an active "Field Verification Needed" hold, or one marked Superseded, is served with no indication of either.

**Evidence.**

```
20260823_publish_contract.sql:22-24 states the contract this breaks: "'Publish anyway' is publish-as-BRANCH: the version row is written but never promoted, and an open revision_branches row is created — visible debt that must be explicitly resolved, never silently dismissed." The route's own comment at route.ts:52 claims "Resolve the current PUBLISHED version's file (never an in-review draft)" — the filter it wrote catches in-review drafts and nothing else.
```

**Chain reaction.** Same fallback shape should be checked in `/api/share/file` (the route that actually streams bytes) — this finding covers `resolve`, which is what the landing page renders. Adding `.is("superseded_at", null).eq("is_branch", false)` is the narrow fix; the wider question of whether a share should resolve at all for a Superseded/held/archived document is a document-control policy call that fails safe by refusing.

> **Verifier correction.** Two amendments. (1) Strengthening — the finding cites only the metadata route; the IDENTICAL resolution block is duplicated in app/api/share/file/route.ts:61-79, which is the route that actually streams the bytes to the outsider. The defect is in the delivery path, not just the preview. (2) Partial mitigation the finding should name: app/api/share/file/route.ts:105-118 stamps every delivered PDF with `watermarkText: "UNCONTROLLED — SHARED COPY"`, a rev footer, and a `/verify/<docId>?v=<versionId>` QR before any byte leaves, so the recipient does not get an unmarked controlled drawing (and the fallback degrades to unstamped delivery only when pdf-lib cannot load the file, which is recorded as `source: "share_link_unstamped"` in download_audits). Also scope the branch half precisely: it only bites when `documents.current_version_id` is NULL or its version row has a NULL `file_url`; the missing status/archive/hold checks apply on EVERY resolve, including the main path, and are the stronger half of the finding.

**Done when.**

- [ ] The fallback selection excludes `is_branch = TRUE` and `superseded_at IS NOT NULL` rows
- [ ] A share link on a document with an active `document_holds` row, or `status = 'Superseded'`, or `archived_at` set, does not silently serve the file
- [ ] A test publishes a branch on a document with a null `current_version_id` and asserts the share route does not serve it

---

<a id="drls-6"></a>

## DRLS-6 · `document_review_signoffs` INSERT is unconstrained, so the database review-completion guard can be satisfied with forged sign-offs

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260828_integrity_hardening.sql:223-226`, `supabase/migrations/20260822_review_completion_guard.sql:46-58`, `lib/reviewControl.ts:363-368`, `lib/reviewControl.ts:355`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct: inserting N rows with slot='alternate', status='signed' raises v_signed without raising v_primary_reqs, satisfying the guard while the real primaries stay pending. The only structural brake, `doc_review_signoff_unique_idx ON (document_version_id, reviewer_user_id)` (20260818_review_before_publish.sql:76-77), does not help — reviewer_user_id is a bare UUID with no FK, so distinct arbitrary values satisfy it. The precondition in the summary is accurate: the forger still needs publish authority or effective ownership to clear the role branch of the same trigger.

**Mechanism.** The publish-completion gate counts rows: `SELECT count(*) FILTER (WHERE slot = 'primary'), count(*) FILTER (WHERE status = 'signed') INTO v_primary_reqs, v_signed FROM document_review_signoffs WHERE document_version_id = NEW.current_version_id;` and blocks only when `v_primary_reqs > 0 AND v_signed < v_primary_reqs`. The INSERT policy that governs who may create those rows is `CREATE POLICY doc_review_signoff_insert ON document_review_signoffs FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id AND uid = auth.uid() AND status = 'active'))` — org membership and nothing else. Neither `reviewer_user_id`, nor `status`, nor `slot`, nor `signature_id` is constrained, and there is no INSERT trigger on the table. Inserting N rows with `slot='alternate', status='signed'` raises `v_signed` without raising `v_primary_reqs`. Separately, the guard's `count(*) FILTER (WHERE slot='primary')` does not filter `status`, while the app's own completion function reads a roster pre-filtered to `.in("status", ["pending","signed"])` (lib/reviewControl.ts:355) before computing `requiredPrimaries = roster.filter(r => r.slot === 'primary').length` — the two disagree the moment any primary row is `void` or `invalidated`.

**Failure scenario.** A drafter who holds per-library publish authority (or is the document's effective owner) has an in-review 2A draft with two pending primary reviewers and a deadline. They POST two rows to `/rest/v1/document_review_signoffs` with `document_version_id` = the draft, `slot='alternate'`, `status='signed'`, `reviewer_user_id` = any uuid. `v_signed` is now 2, `v_primary_reqs` is 2, the trigger passes, and they promote the draft to the controlled copy. An ASME B31.3 piping revision becomes the issued drawing with two reviewer signatures that no reviewer made and no `e_signatures` row backs. The unique index `doc_review_signoff_unique_idx (document_version_id, reviewer_user_id)` does not obstruct this — a fresh uuid per row satisfies it.

**Evidence.**

```
20260822_review_completion_guard.sql:48-53 is the entire completion test; the migration header calls it "a data-integrity gate, not an authority one" and places it before the role short-circuit so it binds Admin/DocCtrl too — but nothing binds who may write the rows it counts. 20260828_integrity_hardening.sql:221-222's own comment concedes the model: "Roster creation: any active member may open a roster (publish authority is enforced app-side + by the publish guard trigger at promote time)" — the promote-time trigger is exactly the check being fed forged input.
```

**Chain reaction.** Compounds with the surviving `document_review_signoffs_member_all` policy (previous finding), which grants INSERT anyway even if `doc_review_signoff_insert` were tightened. Any fix must ALSO close that policy or it changes nothing. Constraining the guard to count only rows whose `signature_id` resolves to an `e_signatures` row with a matching `signer_user_id` is the durable shape, since `e_signatures` is genuinely immutable (self-insert only, no UPDATE/DELETE policy — 20260720:45-61).

> **Verifier correction.** Scope the attacker correctly. The completion test sits before the role short-circuit but the AUTHORITY test still runs after it (20260822:59-70: role lookup → Admin/DocCtrl return, then `user_can_publish_on_library(...) OR user_is_effective_owner(...)`). So forged sign-offs do not let a Viewer publish; they let someone who ALREADY holds publish authority self-approve a revision that reviewers never signed — a review-integrity bypass, not a privilege escalation. Conversely the finding understates one thing: given Finding 2, the surviving `document_review_signoffs_member_all` FOR ALL policy means UPDATE is unconstrained too, so an attacker need not even insert new rows — flipping an existing pending row to 'signed' works.

**Done when.**

- [ ] A member cannot insert a `document_review_signoffs` row with `status <> 'pending'`, nor a row naming a `reviewer_user_id` other than one the review policy resolved
- [ ] The completion guard counts only sign-offs backed by an `e_signatures` row whose `signer_user_id` equals the row's `reviewer_user_id`
- [ ] The guard's primary count and lib/reviewControl.ts:365's `requiredPrimaries` apply the same status filter, pinned by a test that voids a primary row and asserts both agree
- [ ] A test inserts a forged signed alternate row and asserts the promote is still refused

---

<a id="drls-7"></a>

## DRLS-7 · `document_shares`: revocation is not durable and the external-access audit trail is deletable by any member

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260623_document_shares.sql:34-54`, `lib/documentShares.ts:65-70`, `supabase/migrations/20260818_followups_rls.sql:95-101`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves are literally true and un-mitigated. Worth recording as context rather than refutation: an ordinary member can already mint a fresh share for the same document under the same policy, so the confidentiality delta of un-revoking is small — the durable harm is defeating Document Control's revocation of a link they believe dead and destroying the access trail. That is still integrity/audit damage of the same class as DRLS-4 and DRLS-8, so HIGH stands.

**Mechanism.** `CREATE POLICY document_shares_org_member ON document_shares FOR ALL USING (<active org member>) WITH CHECK (<active org member>)` is the only policy on the table — no RESTRICTIVE overlay for UPDATE or DELETE was ever added (confirmed by a full `CREATE POLICY ... ON document_shares` census across schema.sql and all 159 migrations: one hit). FOR ALL therefore covers UPDATE and DELETE for every active member, and the columns it leaves unconstrained are `revoked_at`, `revoked_by`, `expires_at`, `document_id`, `access_count`, `access_last_at` and `access_last_ip`. `revokeShareLink` is additionally an unchecked write: `await supabase.from("document_shares").update({ revoked_at: ..., revoked_by: actorUserId }).eq("id", id);` with no `const { error }` and no throw, so a refusal reads as success in the UI.

**Failure scenario.** Document Control revokes a share link that was handing a superseded P&ID to a vendor. Any active member — the person who created it, or anyone else — PATCHes `revoked_at` back to `null` and `expires_at` forward, and `/api/share/resolve` (which checks only `share.revoked_at` and `share.expires_at`, route.ts:38-41) serves the file again. Alternatively they DELETE the row: the link dies, but so does `access_count` / `access_last_at` / `access_last_ip` — the only record of how many times an outside party pulled a controlled drawing, which the share page advertises as "Audit logged".

**Evidence.**

```
20260623_document_shares.sql:36 comments the intent as "Anyone in the org can create / list / revoke shares" — the policy delivers create/list/revoke AND un-revoke AND delete AND repoint-to-another-document. Contrast the sibling `transmittals`, which got exactly this treatment four months later (20260910_transmittal_portal.sql:14-17: "the old any-member FOR ALL policy let a Viewer issue, void, or acknowledge contractual records") and was split into select/insert/update/delete. `document_shares` was not.
```

**Chain reaction.** `EGRESS-1` already owns the creation side (any member can publish any document to the public internet). This is the revocation and audit side, and the two share a fix: split the FOR ALL into per-operation policies. Do not remove the `access_count` bump path — `bump_share_access` (20260818:95-101) is SECURITY DEFINER precisely so the counter increments for an anonymous visitor, and it is also ungranted-and-PUBLIC (see the search_path finding).

> **Verifier correction.** Qualify the unchecked-write half. Because the same FOR ALL policy permits the UPDATE for any active org member, an RLS refusal on `revokeShareLink` is not the realistic failure mode; the missing error check only surfaces on a transport/PostgREST/column error or a session whose membership has gone inactive. The over-broad-policy half — un-revoke, extend expiry, repoint `document_id` to a different drawing under a token already in an outsider's hands, and DELETE the access-count trail — stands without qualification and is what carries the severity.

**Done when.**

- [ ] `revoked_at` cannot be cleared once set, by any role short of service role
- [ ] `document_shares` rows cannot be DELETEd by a non-controller; expiry/revocation retires a link without erasing its access record
- [ ] `revokeShareLink` inspects the error and surfaces a failure instead of reporting success
- [ ] A test revokes a link, attempts an un-revoke PATCH as the creator, and asserts refusal, then asserts `/api/share/resolve` still returns 410

---

<a id="drls-8"></a>

## DRLS-8 · `download_audits` — the record of who took a controlled drawing out — is rewritable and deletable by any active member

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:789-799`, `supabase/schema.sql:1090-1091`, `supabase/schema.sql:1084-1087`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. download_audits is the distribution record that /api/share/file writes to (app/api/share/file/route.ts:130-139) and that Document Control produces for PSM audits; it has strictly weaker protection than audit_logs sitting six lines above it in the same file.

**Mechanism.** `CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL USING (org_id IN (SELECT my_org_ids()));` is the only policy on the table across schema.sql and all 159 migrations (full `CREATE POLICY ... ON download_audits` census: one hit). No WITH CHECK, so USING is reused for INSERT and UPDATE; no per-operation split, so DELETE is included; no RESTRICTIVE overlay. `org_id` is additionally nullable (`org_id UUID REFERENCES orgs(id)` — no NOT NULL), and `user_id UUID NOT NULL` has no FK, so nothing binds the row to a real actor.

**Failure scenario.** A member downloads a restricted vendor drawing, then DELETEs their own `download_audits` rows — or rewrites `user_id` to a colleague's uuid. The distribution record that Document Control produces for a PSM audit ("who has had this drawing, and when") is missing the pull that matters, or attributes it to the wrong person. Because `org_id` is nullable and unconstrained on write, a row can also be inserted with a NULL org_id, making it invisible to every member's own listing while still occupying the table.

**Evidence.**

```
schema.sql:1090 `CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL USING (org_id IN (SELECT my_org_ids()));` — compare six lines earlier, schema.sql:1084-1087, where the same file gives `audit_logs` a SELECT policy and a separate INSERT policy and deliberately no UPDATE or DELETE. Two audit tables, adjacent in the same file, opposite enforcement.
```

**Chain reaction.** Shares the fix with the disposition/review event trails above — the append-only shape is already in the file and just needs applying. Note `/api/share/file` writes a `download_audits` row for external pulls (per app/api/share/resolve/route.ts:74-79's comment), so the table is the only place outside-the-org egress is recorded at all.

**Done when.**

- [ ] `download_audits` accepts INSERT and SELECT from members and refuses UPDATE and DELETE
- [ ] `org_id` is NOT NULL and the INSERT check pins `user_id = auth.uid()` for member-originated rows
- [ ] A test deletes a download_audits row as a member and asserts refusal

---

<a id="drls-9"></a>

## DRLS-9 · Any member can close out `revision_branches` debt without merging anything

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260823_publish_contract.sql:112-117`, `supabase/migrations/20260823_publish_contract.sql:70-95`, `supabase/schema.sql:1217-1236`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct, and the migration comment shows the breadth was deliberate ('any active org member may resolve') rather than an oversight — which is exactly why it reads as a design gap at MEDIUM rather than a bug. Nothing verifies that a merge actually happened.

**Mechanism.** `CREATE POLICY revision_branches_org_update ON revision_branches FOR UPDATE USING (EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = revision_branches.org_id AND org_members.uid = auth.uid() AND org_members.status = 'active'));` — no WITH CHECK, so by the composition rule the same predicate governs the new row. The mutable columns are `resolved_at`, `resolved_by`, `resolved_by_name`, `resolution` (CHECK: 'merged' | 'withdrawn') and `resolution_note`, and every one is writable by any active member. Nothing verifies that a merge occurred: no check that the branch version was actually folded into a later revision, no check that the resolver has publish authority on the document, no requirement that `resolution_note` be non-empty. The partial index `revision_branches_open_idx ... WHERE (resolved_at IS NULL)` is what every 'open branch debt' surface reads, so setting `resolved_at` removes the item from view everywhere at once.

**Failure scenario.** A drafter publishes over a stale base as a branch — deliberately unreconciled work that does not include somebody else's revision. The branch-debt row appears on the document-control queue. The same drafter (or anyone) PATCHes `{"resolved_at": "<now>", "resolution": "merged"}`. The queue clears. The branch version still sits in `document_versions` with `is_branch = TRUE`, never promoted, never merged, and now invisible — and, per the share-route finding above, still reachable through the share fallback.

**Evidence.**

```
20260823_publish_contract.sql:111 comments the intent as "Any active org member may resolve (author reconciles, DocCtrl closes out)" while the table comment eight lines from the end of the same file (`COMMENT ON TABLE revision_branches`) states the opposite requirement: "the row stays open until explicitly resolved (merged/withdrawn) with a note". The policy enforces neither the note nor the merge.
```

**Chain reaction.** The table has no DELETE policy, which is correct and should stay — the debt row is meant to be permanent once created. But `branch_version_id ... ON DELETE CASCADE` (20260823:76) means deleting the branch version erases the debt row anyway, and the unauthenticated `revup_rollback_orphan` RPC deletes version rows with no authorization at all. Fix that RPC first or this policy fix is bypassable.

> **Verifier correction.** Add one boundary the finding leaves implicit: `revision_branches` has SELECT, INSERT and UPDATE policies only (20260823:99-117) — there is no DELETE policy, so rows cannot be destroyed, only closed out. That is consistent with the finding and slightly narrows it: the debt record survives with a false 'merged' stamp rather than disappearing, which is what makes the partial-index effect (item vanishes from every open-debt surface at once) the actual harm.

**Done when.**

- [ ] Resolving a branch requires publish authority on the document, and `resolution` + `resolution_note` are both required
- [ ] A `resolution = 'merged'` claim is tied to a later revision that actually supersedes the branch, or the resolution is recorded as 'withdrawn'
- [ ] A test resolves a branch as a member with no publish authority and asserts refusal

---

<a id="drls-10"></a>

## DRLS-10 · Any member can re-pin or close a work package, so a STALE field package silently reads FRESH

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260825_work_packages_acks.sql:37-95`, `supabase/migrations/20260828_integrity_hardening.sql:283-292`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed end to end — the tripwire is derived state with no authority gate on either input. The 20260828 comment ('Refresh pack ... silently matched zero rows from the browser') shows the UPDATE policy was widened to all members specifically to make the button work, with no narrower role considered.

**Mechanism.** `work_package_documents` gets SELECT, INSERT and DELETE policies at 20260825:81-95, all `<active org member>`, and 20260828:286-292 adds the UPDATE policy with the same predicate on both USING and WITH CHECK. `pinned_version_id` and `pinned_rev_label` — the entire mechanism by which a package detects that a member drawing has advanced — are therefore rewritable by every active member, including a Viewer. `work_packages` itself gets all four operations at member level (20260825:60-79), so `status` can be flipped to `'closed'` and `closed_at`/`closed_by` stamped, or the whole package deleted, by anyone.

**Failure scenario.** A pump-swap package pins the P&ID at Rev 4. The P&ID advances to Rev 5 mid-job and the package correctly reads STALE — the tripwire the migration was built for. Any member (or a mis-scoped 'refresh pack' click by someone who should not have it) re-pins every member document to current, and the package reads FRESH again with no record that it was ever stale and no re-verification of the field copies. The crew executes against a package whose freshness signal was reset rather than resolved.

**Evidence.**

```
20260825_work_packages_acks.sql:8-11 states the design: "A package pins the revision of each member document at assembly; if any member advances before the job closes, the package reads STALE and the owner is told. Nothing is blocked — the package is a tripwire, not a lock." A tripwire any passer-by can reset is not a tripwire. 20260828_integrity_hardening.sql:26-28 records why the UPDATE policy was added — "'Refresh pack' (which re-pins every drawing to the current revision) silently matched zero rows from the browser" — and chose the broadest predicate rather than the package owner's.
```

**Chain reaction.** `work_packages.owner_user_id` already exists and is NOT NULL, so scoping UPDATE/DELETE to the owner plus controllers is a direct substitution with no new column. Note the same migration's `distribution_acks_org_update` chose the identical over-broad predicate on the same day, which is `SURF-12`.

**Done when.**

- [ ] Re-pinning a package's documents is limited to the package owner and controllers
- [ ] Closing or deleting a `work_packages` row is limited to the owner and controllers
- [ ] A re-pin records that the package had gone stale, rather than erasing the signal
- [ ] A test re-pins another member's package as a Viewer and asserts refusal

---

<a id="drls-11"></a>

## DRLS-11 · Ten more SECURITY DEFINER functions carrying document-control authority do not pin `search_path` — including `my_org_ids`, the base of every document-control policy

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1031-1034`, `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:34-40`, `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:58-61`, `supabase/migrations/20260814_documents_delete_controllers.sql:31-40`, `supabase/migrations/20260707_teams.sql:52-55`, `supabase/migrations/20260818_followups_rls.sql:95-96`, `supabase/migrations/20260818_followups_rls.sql:10-11`, `supabase/migrations/20260818_followups_rls.sql:23-24`, `supabase/migrations/20260713_branding_admin_writes.sql:11-12`, `supabase/migrations/20260817_org_members_escalation_and_config.sql:21-22`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every cited line checks out, including the claim that my_org_ids underpins the documents and document_versions policies (schema.sql:1068-1073). MEDIUM is the right level: exploitation additionally requires a principal with CREATE on a schema ahead of public in its search_path, which is not established here — the finding itself concedes that, and treats it as a house-pattern/defence-in-depth gap.

**Mechanism.** `CREATE OR REPLACE FUNCTION my_org_ids() RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER AS $$ SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'; $$;` has no `SET search_path`, and its unqualified `org_members` reference resolves against the caller's search_path. Every document-control policy in schema.sql is built on it: `documents_org_access`, `document_versions_org_access`, `document_sets_org_access`, `checkout_sessions_org_access`, `download_audits_org_access`, `checkout_episodes_*`, `checkout_messages_*`, `metadata_templates_org_access`, `watermark_policies_org_access`. The same omission covers `doc_is_visible` (the RESTRICTIVE SELECT overlay on `document_versions`), `is_org_controller` (the RESTRICTIVE DELETE overlay on `documents`, `document_versions`, `collections`, `document_sets`, and the DELETE/UPDATE gates on `document_holds`, `transmittals`, `markup_requests`), `my_project_ids`, `my_team_ids`, `bump_share_access`, `can_manage_project`, `is_org_assign_drafters`, `is_org_admin`, `is_org_admin_or_manager`. None of these ten appears in the existing DB-6 census.

**Failure scenario.** Same exposure DB-6 describes — a caller who can create objects in a schema earlier on their search_path shadows `org_members` and `my_org_ids()` returns whatever they choose, which is the sole predicate on the documents and document_versions policies. Whether any role in this deployment can create schemas was not verified from the repo. What is verified is the inconsistency: `user_is_effective_owner` (20260816_owner_publish_access.sql:10), `user_can_publish_on_library` (20260812:37), `org_capability_allows` (20260901:29), `acl_index_denies` (20260901:128), `prevent_last_admin_removal` (20260831:44), `enforce_checkout_release_guard` (20260831:81), `next_ticket_number` (schema.sql:475) and `post_ticket_comment` (schema.sql:527) all pin it — the codebase knows the pattern and applies it inconsistently within the same files.

**Evidence.**

```
schema.sql:1032 `RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER AS $$` — 43 lines above `CREATE POLICY "documents_org_access" ON documents FOR ALL USING (org_id IN (SELECT my_org_ids()))` at schema.sql:1068-1069, in the same file. 20260813:35 `RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$` for `doc_is_visible`, which is the only confidentiality overlay `document_versions` has. 20260814:32 for `is_org_controller`, which is the only destruction overlay `documents` has.
```

**Chain reaction.** Extends the existing `DB-6` (which censused nine functions: `node_visible`, four `enforce_document_publish_guard` definitions, `can_manage_node`, `documents_guard_access_change`, `revup_rollback_orphan`, `publish_revision`, both legal-hold guards, `enforce_document_move_guard`). Fix the two censuses together — it is one mechanical `SET search_path = public` per function with no behavioural change — and add the lint DB-6's `Done when` already calls for so the next definer function cannot ship without it. Note `bump_share_access` and `revup_rollback_orphan` additionally lack any `GRANT`/`REVOKE`, which is the separate CRITICAL above.

> **Verifier correction.** File this as an EXTENSION of the existing DB-6 (audit-reports/roles-and-permissions/11-database-authority.md:254), not as a new finding — it is the same defect class, the same severity, and the same remediation ('Every SECURITY DEFINER function in the migration set pins search_path'), just ten more names for that table. Carry DB-6's own hedge forward too: the code fact is confirmed, but the security consequence is not observable from the repo. A shadowing attack needs a caller who can both set `search_path` and create objects in a schema earlier on it; PostgREST does not let a client set search_path per request (it is server-configured), and Postgres 15+ removes the default PUBLIC CREATE on `public`. Treat this as defense-in-depth consistency, not a demonstrated exploit.

**Done when.**

- [ ] All ten functions listed here pin `SET search_path = public`, alongside the nine in DB-6
- [ ] A lint or test enumerates `pg_proc` for `prosecdef = true AND proconfig IS NULL` and fails on any hit
- [ ] The census is recorded once so no third audit has to re-derive it

---

<a id="drls-12"></a>

## DRLS-12 · The checkout force-release guard is BEFORE UPDATE only; `checkout_sessions` DELETE is unrestricted, so the row can be removed instead of closed

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1094-1095`, `supabase/migrations/20260831_capability_policy_and_rails.sql:80-102`, `supabase/migrations/20260901_db_hard_enforcement.sql:109-121`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the guard is a strict BEFORE UPDATE, deletion is wide open, and documents.checked_out_by has no guard of its own (the same trigger census as DRLS-3 shows no trigger touching that column). Deleting the session row rather than closing it evades the force-release control entirely.

**Mechanism.** `enforce_checkout_release_guard` is attached as `CREATE TRIGGER trg_checkout_release_guard BEFORE UPDATE ON checkout_sessions FOR EACH ROW` — UPDATE only. Its body tests `IF OLD.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status AND OLD.user_id::text <> auth.uid()::text AND NOT is_org_controller(OLD.org_id) THEN RAISE EXCEPTION`, which by construction cannot fire on a DELETE (there is no NEW). The table's only policy is `CREATE POLICY "checkout_sessions_org_access" ON checkout_sessions FOR ALL USING (org_id IN (SELECT my_org_ids()));` — no per-operation split and no RESTRICTIVE DELETE overlay anywhere in the migration set (full `CREATE POLICY ... ON checkout_sessions` census: one hit). So `DELETE /rest/v1/checkout_sessions?id=eq.<id>` from any active member removes another person's active checkout row without the guard executing.

**Failure scenario.** A drafter wants a P&ID another engineer has checked out. They DELETE the engineer's `checkout_sessions` row (guard never runs), then PATCH `documents.checked_out_by = null` (unguarded — the SURF-4 path). `publish_revision`'s lock check reads `v_doc.checked_out_by`, now NULL, so the publish proceeds cleanly over live in-progress work. Deleting rather than closing the session is strictly worse than SURF-4's path: no `ended_at`, no `released_by`, no `released_reason`, and the episode's membership record simply vanishes, so `reconcileDocumentCheckoutState` and the episode history have nothing to reconstruct from.

**Evidence.**

```
20260831_capability_policy_and_rails.sql:99-102 `DROP TRIGGER IF EXISTS trg_checkout_release_guard ON checkout_sessions; CREATE TRIGGER trg_checkout_release_guard BEFORE UPDATE ON checkout_sessions FOR EACH ROW EXECUTE FUNCTION enforce_checkout_release_guard();` — the migration header (line 16-19) claims "releasing ANOTHER USER's active checkout now requires Admin/DocCtrl at the database". schema.sql:1094 is the unmodified FOR ALL policy that leaves DELETE open. `checkout_episodes` has the same shape from the other direction: 20260729 gives it SELECT/INSERT/UPDATE policies and no DELETE policy at all — so episodes cannot be deleted while their member sessions can.
```

**Chain reaction.** `SURF-4` owns the split-write bypass (the unchecked `checkout_sessions` update followed by an unguarded `documents` write). This is a third route to the same outcome and must be closed in the same change, or SURF-4's fix looks complete and isn't. Note `enforce_checkout_release_guard` was rewritten by 20260901:109-121 to call `org_capability_allows`, which is itself non-functional per DB-1/SURF-6 — so the UPDATE half of this guard is currently raising a column error rather than enforcing anything.

> **Verifier correction.** HIGH overstates the consequence. Deleting the session row does NOT release the document lock: the lock lives on `documents.checked_out_by` / `current_lock_id` (written by the CAS at lib/checkoutEpisodes.ts:751-758 and by CheckoutFlowModal.tsx), and that is what `publish_revision` reads before allowing a publish (20260823_publish_contract.sql:193-199, `IF v_doc.checked_out_by IS NOT NULL AND v_doc.checked_out_by::text <> p_actor::text THEN RETURN ... 'locked_by_other'`). So the vector destroys the custody record and hides an active checkout from every session-reading surface (MyDeskPanel.tsx:54, DocControlQueue.tsx:84, HistoryDrawer.tsx:61, StaleCheckoutBanner.tsx), while leaving an orphaned lock on the document — it does not confer publish over someone else's lock. The separate, more direct hole is that `documents.checked_out_by` is itself PATCHable by any member, which is Finding 6, not this one. Downgrade to MEDIUM and reframe as custody-record destruction plus a guard that is trivially sidestepped by choosing DELETE over UPDATE.

**Done when.**

- [ ] A non-controller cannot DELETE another member's `checkout_sessions` row, and the guard covers DELETE as well as UPDATE
- [ ] Closing a checkout is the only way to end one — deletion of an active session row is refused for every non-service role
- [ ] A test deletes another user's active session as a member and asserts refusal

---

<a id="drls-13"></a>

## DRLS-13 · `document_supersessions` — the map of which drawing replaces which — is insert- and delete-able by any member, and both writers ignore errors

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260615_fix_missing_rls_policies.sql:71-76`, `supabase/schema.sql:189-200`, `lib/documentLifecycle/common.ts:293`, `lib/revisions.ts:1481`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All four cited claims verified verbatim, including the 'both writers ignore errors' half, which is the part most likely to have been overstated and is not.

**Mechanism.** `CREATE POLICY "document_supersessions_member_all" ON document_supersessions FOR ALL TO authenticated USING (<active org member>) WITH CHECK (<active org member>)` is the only policy on the table (census across schema.sql + all migrations: this one plus its duplicate in CATCHUP_2026-05-28.sql:932). FOR ALL covers DELETE, so any Viewer can remove a supersession link; WITH CHECK constrains only `org_id`, so any member can assert that any document supersedes any other document in their org. Both application writers discard the result: `await supabase.from("document_supersessions").upsert(rows, { onConflict: "superseded_doc_id,replacement_doc_id" });` (documentLifecycle/common.ts:293) and `await supabase.from("document_supersessions").insert(rows);` (revisions.ts:1481) — neither destructures `error`, and supabase-js resolves rather than throwing, so a refused or partially-refused write reports success.

**Failure scenario.** A split or merge records that drawing A-101 was superseded by A-101A and A-101B. A member deletes those two rows. The document detail view, the impact walk and any 'what replaced this?' query now show A-101 as a live standalone drawing with no successor, and a worker searching for the isolation boundary is handed the retired sheet with nothing pointing forward. In the other direction a member can insert a link claiming an active drawing was superseded by an obsolete one.

**Evidence.**

```
20260615_fix_missing_rls_policies.sql:67-70 explains why the policy exists at all — "Created in 20260526_supersede_archive.sql, never got an RLS policy. Same potential symptom: silent INSERT denial during a supersede / split / merge" — the fix chose the broadest available shape. Note the DELETE side was explicitly left out of the controller-gating pass: 20260815_versions_collections_delete_controllers.sql:11-18 lists what is "NOT included here" (document_sets, milestones, transmittals, documents UPDATE) and does not mention `document_supersessions` at all.
```

**Chain reaction.** Same table family as the `documents.rev` finding — the supersession chain and the rev label are the two things that decide which sheet is current. `documents.superseded_at` / `superseded_by_user` / `supersession_reason` on the parent row are likewise unguarded (the publish guard only fires on `status = 'Superseded'`, not on these columns).

**Done when.**

- [ ] `document_supersessions` rows cannot be deleted by a non-controller, and cannot be inserted by a member without publish authority on the superseded document
- [ ] Both writers inspect the error and surface a failure
- [ ] A test deletes a supersession row as a Viewer and asserts refusal

---

<a id="drls-14"></a>

## DRLS-14 · `documents.current_version_id` and `pending_version_id` have no foreign key, and the child-table cascades are asymmetric

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:144`, `supabase/migrations/20260818_review_before_publish.sql:30`, `supabase/migrations/20260825_work_packages_acks.sql:102`, `supabase/migrations/20260817_read_understood.sql:37`, `supabase/migrations/20260823_publish_contract.sql:76`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct on every element. One more instance of the asymmetry that strengthens rather than weakens it: work_package_documents.pinned_version_id REFERENCES document_versions(id) with no ON DELETE clause defaults to NO ACTION, so a pinned version blocks deletion while an acknowledged one silently cascades — three different behaviours across four child tables pointing at the same parent.

**Mechanism.** `documents.current_version_id UUID,` (schema.sql:144) and `ALTER TABLE documents ADD COLUMN IF NOT EXISTS pending_version_id UUID;` (20260818:30) are plain UUID columns — a `grep -rn 'current_version_id|pending_version_id' schema.sql migrations/*.sql | grep -i 'references|constraint|add column'` returns exactly one hit, the bare ALTER, and no FK anywhere. Meanwhile the tables that hang off a version disagree on what a version's deletion should mean: `distribution_acks.version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE` and `revision_branches.branch_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE` are destroyed with it; `document_acknowledgments.document_version_id uuid` and `document_review_signoffs.document_version_id uuid` have no FK at all and survive as orphans; `work_package_documents.pinned_version_id UUID REFERENCES document_versions(id)` has no ON DELETE clause, so it defaults to NO ACTION and BLOCKS the delete. Four child tables, four different behaviours, on the same parent.

**Failure scenario.** A controller deletes a `document_versions` row (permitted by `document_versions_delete_controllers`), or anyone calls the unauthenticated `revup_rollback_orphan` RPC. `documents.current_version_id` is left pointing at a row that no longer exists and the database raises nothing. The share route (route.ts:56-59) queries that id, gets no row, falls through to its newest-row fallback and serves a different drawing; the document detail view shows a document with a rev label and no resolvable file. In the same delete, the `distribution_acks` proving twelve people confirmed that revision are cascaded away while the `document_acknowledgments` roster rows for the same revision survive pointing at nothing — the PSM evidence for one acknowledgment system is destroyed and for the other is falsified.

**Evidence.**

```
schema.sql:144 `current_version_id UUID,` — the column immediately follows `status TEXT DEFAULT 'Draft',` and precedes `metadata JSONB`, with no REFERENCES, while `set_id UUID REFERENCES document_sets(id) ON DELETE SET NULL` eleven lines above shows the author writing FKs freely in the same CREATE TABLE. 20260825_work_packages_acks.sql:102 `version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,` vs 20260817_read_understood.sql:37 `document_version_id UUID,` — written eight days apart for the same purpose.
```

**Chain reaction.** Adding the FK on `current_version_id` will fail on any existing dangling pointer, so it needs an inventory query first (DEC-30). It is also the correct enforcement point for the `documents.rev` divergence finding — an FK plus a check that `rev` matches the referenced row's `revision_label` closes both. Changing `distribution_acks.version_id` away from CASCADE is the compliance-critical half: an acknowledgment record that vanishes when the thing it acknowledges is deleted is not a record.

> **Verifier correction.** Minor: the grep claim 'returns exactly one hit, the bare ALTER' is inaccurate — there are two definition sites (schema.sql:144 and 20260818:30), neither carrying a REFERENCES clause. The conclusion (no FK anywhere on either column) is unchanged. Also note the practical bite of the NO ACTION case is bounded: `document_versions` DELETE is already restricted to controllers (20260815:22-25) and blocked entirely under legal hold (20260826:52-56), so the 'blocks the delete' behaviour surfaces mainly on controller deletes and document/org cascades rather than on ordinary member activity.

**Done when.**

- [ ] `documents.current_version_id` and `pending_version_id` carry FKs to `document_versions`, after an inventory of existing dangling values is run and recorded
- [ ] The four child tables agree on a deliberate ON DELETE semantics, with compliance evidence (`distribution_acks`, `document_acknowledgments`, `document_review_signoffs`) preserved rather than cascaded
- [ ] A test deletes a version that a document points at and asserts the database refuses

---
