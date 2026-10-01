# Migration paste order: 20261007 → 20261140

This is a read-only reference, compiled 2026-10-01 by the integrator from two sources: each migration's header comment and every mention of its number in `audit-reports/**/*.md`. It covers the **105 numbered files** in `supabase/migrations/` dated 20261001 or later. The un-numbered `CATCHUP_*` and `DIAGNOSE_*` files are out of scope. It describes schema and structure only, and contains no data rows.

**Citation shorthand.**
- `RP` = `audit-reports/roles-and-permissions/README.md`
- `DCR` = `audit-reports/document-control/README.md`
- `SEQ` = `audit-reports/document-control/99-fix-sequencing.md`
- `DEC` = `audit-reports/DECISIONS.md`
- Area folders under `audit-reports/`: `dc/` = document-control, `rp/` = roles-and-permissions, `pc/` = projects-and-cost, `pt/` = projects-tab, `int/` = intelligence, `ps/` = public-surfaces, `id/` = identity-and-session, `ao/` = admin-and-org.
- `h:N` = line N of the row's own migration file. `20261130:47` = line 47 of `supabase/migrations/20261130_*.sql`.
- **(derived)** marks an ordering fact I worked out from which files CREATE the same function, policy or trigger. No record states it.

**Keeping this current.** The integrator updates this guide at every merge that adds a migration, and whenever you report a paste. Not listed yet, because they are still on unmerged package branches: 20261137 (I-05) and 20261144 (P13). When you paste a file, send back its result rows; the integrator then marks it **LIVE** here and in the finding records.

---

## 1. How to use

1. **Paste one file at a time, the whole file.** Order:
   - §2 (20261129) first, now.
   - Then the §4 table from top to bottom:
     - Skip rows tagged **LIVE**.
     - Ask before pasting rows tagged **ASK**.
     - Hold rows tagged **HOLD** until their deploy gate in §3 is met.
   - §4's closing summary lists the same order in one place.
2. **The SQL editor shows only the last result set.** From Round E (20261053) on, every file ends with one `SELECT` that returns the columns `check`, `ok` and `n` (RP:360-365).
   - **Probe rows** have `ok` = true or false, and `n` is empty.
     - **Any `ok = false` means stop.** Don't paste the next file. Send back the whole result.
   - **Inventory rows** have an empty `ok` and a count in `n`. Send these counts back.
   - Some headers predict `ok = false` in specific situations. Still stop and report; the header names the fix:
     - 20261071: duplicate active labels exist (h:14-19). Reconcile, then re-run.
     - 20261095: `documents` or `milestones` has more than 50,000 rows (h:21-39). Then paste the `CREATE INDEX CONCURRENTLY` statements at its foot, one statement per run.
     - 20261106: the database has no `supabase_realtime` publication (h:17-18).
     - 20261131: duplicate supersession pairs exist (dc/02-revisions-publish.md:655). Reconcile, then re-run.
3. **An ERROR instead of rows also means stop and report.** These raise on purpose when a prerequisite is missing:
   - 20261133 needs 20261132 (h:3-6).
   - 20261136 needs 20261091, 20261125 and 20261132 (h:3-5).
4. **Older result shapes.**
   - 20261007–20261025 end with no SELECT at all (DDL only).
   - 20261026–20261052 end in other shapes: (`check`, `ok`), (`check`, `result` text), or a column list (20261039).
   - Every file from 20261019 to 20261066 is recorded live, so none of them should be pasted.
5. **Never re-paste an earlier file after a later file that re-creates the same object** (column 5).
   - Exceptions the records allow:
     - 20261071 and 20261131: re-run after reconciling.
     - 20261102: re-run whenever 20261091 is re-run (20261102:39-40).
     - 20261130: re-run if 20261105 or an earlier `publish_revision` file was re-pasted after it (20261130:50-53).
     - 20261138: paste once more after the first unit-identity decode run (20261138:109-112).
6. **Foot blocks are not part of the paste.** Some files carry statements at the foot that are run separately, and only when the header says so:
   - 20261095: the `CONCURRENTLY` index builds.
   - 20261096: a review query (it returns names, which this guide does not need) and a commented-out quote-link `UPDATE` that stays blocked (h:41-52).
   - 20261103: a statement that revokes existing intake links on closed projects, run after review (h:84-86).

---

## 2. URGENT, paste first: `20261129_dc_hotfix_anon_execute.sql`

**What it fixes.** DRLS-16, a **CRITICAL** finding that is still OPEN (dc/10-rls.md:673-676). Anonymous callers holding the public anon key can execute:
- `publish_revision`, which reads a NULL `auth.uid()` as the service role and so lets the caller name any actor;
- `post_ticket_comment`, which skips its membership check for a NULL uid.

The file loops over every overload of both functions by name (h:31-45), inside one transaction (h:28-47). For each overload it:
- grants EXECUTE to `authenticated` and `service_role`;
- revokes EXECUTE from `anon` and `PUBLIC`.

**Nothing has to be pasted before it.**
- Header: *"Narrows only; idempotent; safe to run before or after 20261130 … Independent of every other pending migration — paste it now."* (h:24-26)
- Records:
  - *"independent of every other pending migration and safe before or after `20261130`"* (dc/10-rls.md:702)
  - *"Paste the `DRLS-16` hotfix now … independent of everything else"* (SEQ:163)
  - *"the operator pastes `20261129` today (no package needed)"* (dc/10-rls.md:713)
- No deploy gate.
- Records say: *"not yet pasted, so nothing below binds the live database yet"* (dc/10-rls.md:702).

**What the result should look like.**
- 4 probe rows. Expect `ok = true` on every one (h:50-72).
- 1 inventory row: the count of SECURITY DEFINER functions `anon` can still execute (h:74-78).
- Then one row per such function. In these rows `check` is the function's signature, `ok` is empty, and `n` reads *"read it for an auth.uid() IS NULL branch"* (h:80-88). Here `n` is an instruction, not a count.
- **Send every row back.** Reading these sweep rows is DRLS-16's second done-when item (dc/10-rls.md:705, :710).

**Afterwards.**
- 20261130 re-creates `publish_revision` and revokes `anon` itself (20261130:356).
- No later file re-creates `post_ticket_comment`. It is defined only in 20260726, 20260810 and 20260811.
- If 20261105 or an earlier `publish_revision` file is ever re-pasted after 20261130:
  - Re-run 20261130 (20261130:50-53; SEQ:157-159).
  - **(derived)** Re-run 20261129 too. The re-created overload picks up Supabase's default anon grant (h:4-6).

---

## 3. Deploy gates

### A. The app deploy must come BEFORE the paste

| file | gate | citation |
|---|---|---|
| **20261131** documents rails | Deploy these library-page fixes first:<br>• **DRLS-15**: the metadata save stops sending a changed `rev` and checks its write.<br>• **DRLS-17**: the delete flow becomes one checked statement.<br>If 20261131 is pasted earlier, every save that touches Rev silently loses all its edits, and a delete stops part-way, leaving a document with no current file. | h:105-111; SEQ:129-148, :164-166; dc/10-rls.md:651; DEC:3805-3809 |
| | **Status.** Both fixes are RESOLVED in code (dc/10-rls.md:633, :722): *"Landed 2026-10-01 in P12's first commit … Step 3 waits only for the app carrying that commit to be deployed"* (SEQ:164). **No record says that app is deployed.** | |
| | **One-deploy variant.** Paste 20261130 → deploy the app with the page fixes → paste 20261131 (SEQ:170-173). | |
| **20261139** first issue and branch close-out | *"Deploy the app carrying `REV-15`'s bulk upload change with or before it"*. REV-15 itself is still OPEN, with a Partial block (dc/02-revisions-publish.md:664, :681). | SEQ:217-219 |
| **20261124** drawing audit scope | Paste after the app carrying intelligence **I-04** is deployed. I-04 moves the orchestrator's `log_audit_completion` onto the new `(org, library, sheet, revision)` key; before that, the paste makes that one tool's write fail (42P10). | h:23-28 |
| **20261141** intake token hashing | **Irreversible.** Paste only after the J11 build is live and every open tab has reloaded (the update pill offers it). Pasted earlier, or followed by a rollback, every contractor link breaks; the only way back is re-issuing each link. The file refuses until its `SET app.j11_deployed = 'yes';` line is uncommented. | 20261141 header; pt/01-security-access.md SEC-19 |
| **20261143** work package close rail | Paste with the P8 FIELD app deploy or just after it, never before (h:66-73). Its MEASURE rows are the counts `DEC-70` §2's ratification reads. | 20261143 header; dc/10-rls.md DRLS-10 |
| 20261019 *(LIVE, historical)* | The app that stops sending `p_actor_role` had to deploy before this file was applied. | 20261019:18-19 |
| 20261050 *(LIVE, historical)* | Applied after the app carrying the signing route was deployed. | 20261050:25-27 |

### B. Paste BEFORE the deploy

The other order is tolerated: the app degrades or fails closed until the paste lands.

| file(s) | rule | citation |
|---|---|---|
| 20261068 → 20261080 → 20261081 | Apply before the wave-2 share routes deploy. Deploying first *"degrades attribution, not access"*. | SEQ:108-120; DEC:1997-2004; dc/05-distribution.md:316 |
| 20261070 | *"paste `20261070` with the deploy"*. The app tolerates a database without it (dc/03-review-gate.md:178). Until it is applied, every trusted intake auto-publish demotes to review (pc/05-intake-door.md:112; pt/01-security-access.md:265). | dc/02-revisions-publish.md:225 |
| 20261130 | *"paste this BEFORE the wave-2 app deploys"*. Both windows fail closed (SEQ:175-189). Keep the window short (SEQ:167-168). | 20261130:47-50 |
| 20261132 → 20261133 | Apply both, *"then deploy the app"*. If the migrations land first, the old app's one-INSERT issue and its member-session receipt are refused until the deploy. | DEC:3569-3577 |
| 20261134 | No gate. Until it is pasted, scans are still answered, nothing is recorded or capped, and the routes log the deploy order. | 20261134:58-61; ps/01-verify-endpoints.md:588 |

### C. App configuration named beside these gates (not migrations)

- Set `NEXT_PUBLIC_FACILITY_TIME_ZONE` before the wave-2 app ships (SEQ:149-156).
- Self-hosted deployments only: set `NEXT_PUBLIC_SITE_URL` (a Docker build argument) before deploying the app that carries P12 (SEQ:237-247).

---

## 4. Ordered table (numeric order)

**Tags in the # column:**
- **LIVE**: records say applied and verified. Do not paste.
- **ASK**: the records don't say whether it is live. Confirm before pasting (see §5).
- **PASTE**: pending, no deploy gate.
- **HOLD**: pending, deploy gate in §3A.
- **NOW**: §2.

All PASTE and HOLD rows read *"Pending migration"* or *"not applied"* in the records. The file and line are given in the last column.

| # | file | serves | must follow | must precede / never re-paste after | deploy gate | records say live? |
|---|---|---|---|---|---|---|
| 1 ASK | `20261007_line_traces.sql` creates `knowledge_line_traces` (cached P&ID trace waypoints) | — (pre-audit feature) | 20260930 (h:17) | **(derived)** Pasting it now recreates a table that `20261007_retire_line_traces` drops. The feature is retired (int/14-drawing-intelligence.md:426). | — | unknown |
| 2 ASK | `20261007_rag_hardening.sql` adds a weighted-section tsvector and length-normalised rank, and limits retrieval to READY docs. It rebuilds `tsv`, which takes minutes (h:22-25). | — | — | Precede 20261121, which re-creates `semantic_search` "from 20261007" (20261121:44). Never re-paste after 20261121. | — | unknown |
| 3 ASK | `20261007_retire_line_traces.sql`: `DROP TABLE IF EXISTS knowledge_line_traces` | — | `20261007_line_traces` | `20261009_trace_method` fails after it (row 7) | — | unknown |
| 4 ASK | `20261008_knowledge_threads.sql`: `thread_id` groups asks into conversations | — | — | no later re-creation found | — | unknown |
| 5 ASK | `20261008_storage_estimate_knowledge.sql`: `mfg_storage_estimate()` now counts knowledge files (DROP + CREATE, h:18-22) | — | 20260805 (h:16) | no later re-creation found | — | unknown |
| 6 ASK | `20261009_folder_order.sql`: `collections.sort_order` | — | — | — | — | unknown |
| 7 ASK | `20261009_trace_method.sql` ALTERs `knowledge_line_traces`, now only while that table exists (guarded at the I-07 merge, 2026-10-01) | DWG-9 | header says "after 20261007" (h:14) | Harmless in any order now: a no-op once `20261007_retire_line_traces` has dropped the table. | — | DWG-9 RESOLVED (int/14-drawing-intelligence.md) |
| 8 ASK | `20261010_explorer_view_prefs.sql`: `table_views.view_config`, plus restrictive policies so only controllers write org-default rows | — | — | no later re-creation found | — | unknown |
| 9 ASK | `20261010_signup_rate_limit.sql`: `signup_attempts` (IP rate limit, service-role only) | finding H4 (pre-corpus id, h:9) | — | — | — | unknown |
| 10 ASK | `20261011_collections_guard_and_trash.sql`: controller-only folder INSERT/UPDATE policies, a document move guard and folder trash | — | — | **(derived)** It re-creates `collections_update_controllers` (DROP + CREATE, h:30-34), which **LIVE** 20261044 widened (20261044:93-105). It also CREATE OR REPLACEs `enforce_document_move_guard` with no `search_path`, which **LIVE** 20261020 pinned (20261020:54). **Pasting it now would revert both.** | — | unknown. 20261044:16-18 and 20261072:7-8 describe its policy as having been in force (§5 #1) |
| 11 ASK | `20261011_semantic_coverage_fast.sql`: coverage indexes and a `semantic_coverage` rewrite | — | — | Re-created by 20261014 and 20261121. Never re-paste after either. | — | unknown |
| 12 ASK | `20261012_doc_class_and_checkin_outcomes.sql`: `doc_class` on doc/folder/library, plus check-in outcome columns | — | — | The **LIVE** 20261031 MOC gate no-ops without it (DCR:122-124; 20261031:133) | — | unknown |
| 13 ASK | `20261012_doc_targeted_search.sql`: `knowledge_search_document()` | — | — | no later re-creation found | — | unknown |
| 14 ASK | `20261013_answer_feedback.sql`: answer rating | — | — | — | — | unknown |
| 15 ASK | `20261013_project_controls_program.sql`: companies, change orders, checklists, turnover, punch and quotes; owner-level cost writes | basis of the projects-tab audit (pt/README.md:18-20) | — | Precede 20261091, 20261093–96, 20261102–03 and 20261136, which build on its tables (20261091:67,76; 20261094:4; 20261095:16). **(derived)** Never re-paste after 20261094: that would re-create the `change_orders_write` FOR ALL policy that 20261094 drops (20261094:129). | — | *"may not be applied in production"* (pt/README.md:18). Schema-health names it if missing (pt/08-reliability.md:343). |
| 16 ASK | `20261014_coverage_timeout_headroom.sql`: 25 s timeout on `semantic_coverage` | — | `20261011_semantic_coverage_fast` (same function) | 20261121 re-creates it "from 20261014" (20261121:26). Never re-paste after it. | — | unknown |
| 17 ASK | `20261015_connection_skills.sql`: `link_rules` table and policies | — | — | Precede 20261125, which re-creates all four `link_rules_*` policies. Never re-paste after it (DROP + CREATE). | — | unknown |
| 18 ASK | `20261016_reasoning_skills.sql`: `answer_skills` | — | — | Precede 20261125 ("apply after 20261016", 20261125:12), which re-creates all four `answer_skills_*` policies. Never re-paste after it. | — | unknown |
| 19 ASK | `20261017_process_flows.sql`: `process_flows` edges | — | — | no later re-creation found | — | unknown (ao/02-backup-restore.md:453 imagines it "never pasted in") |
| 20 HOLD | `20261018_identity_email_unique.sql`: email normalisation and `lower(email)` unique indexes | IDENT-1 | **STEP 0 first.** Run the three inventory queries and reconcile any duplicates (h:15-46). Those queries return data rows, which are not reproduced here. | — | none, but STEP 0 is a production-data gate | IDENT-1 **BLOCKED** (id/02-identity-collision.md:139, :157). *"Pending migration: … applied by hand, after STEP 0"* (:155; §5 #7) |
| 21 LIVE | `20261019` retires `publish_revision`'s `p_actor_role` and pins `search_path` | OWN-5, DB-6, DEC-11 | — | Never re-paste after 20261031 or any later `publish_revision` file (chain 31→34→36→40→49→105→130) | app before (h:18-19), historical | *"applied & verified in the live database 2026-08-24"* (RP:464-467; RP:106-115) |
| 22 LIVE | `20261020` pins `search_path` on SECURITY DEFINER functions | DB-6 | — | uses ALTER, so it pins whichever body is live (h:16-18) | — | *"applied & verified in the live database 2026-08-24"* (RP:460; rp/11-database-authority.md:406) |
| 23 LIVE | `20261021` owner lookup indexes | DEC-11 | — | — | — | RP:464-467 |
| 24 LIVE | `20261022` per-verb `document_shares` policies | EGRESS-1 | — | Policies re-created by 26, 37, 66, 80 and 140. Never re-paste. | — | *"applied & verified live 2026-08-24"* (rp/10-content-egress.md:51; RP:435-438) |
| 25 LIVE | `20261023` `access_requests` scope | EGRESS-5, DEC-19 | — | — | — | rp/10-content-egress.md:346; RP:437 |
| 26 LIVE | `20261024` roles backfill | DB-3 | — | precede 20261025 (20261025:13) | — | rp/11-database-authority.md:175. The file is the corrected form, not the text that was pasted (h:23-26; §5 #8) |
| 27 LIVE | `20261025` capability and deny column typos | DB-1, DB-2 | 20261024 (h:13; RP:422-423) | `org_capability_allows` re-created by 38 and 52 | — | rp/11-database-authority.md:46, :111 |
| 28 LIVE | `20261026` share anchor integrity | EGRESS-1 | 20261022 | Anchor function and trigger re-created by 20261080; insert policy by 37, 80, 140 | — | *"✅ APPLIED & VERIFIED … 2026-08-24"* (h:31; RP:99-100) |
| 29 LIVE | `20261027` unguarded doors | DRLS-2, EGR-1 | — | `transmittals_guard` and its trigger re-created by 20261133. Never re-paste after it. | — | DCR:71 |
| 30 LIVE | `20261028` work-package print snapshot | PKG-2 | — | — | — | DCR:86-87 |
| 31 LIVE | `20261029` permissive-RLS family | DRLS-1, DCK-2, DCK-3 | — | — | — | DCR:101 |
| 32 LIVE | `20261030` review gate | RG-1, RG-2 | — | Sign-off guard and policy re-created by 47 and 70; publish guard by 40, 45, 46, 60, 70, 105, 139 | — | DCR:114 |
| 33 LIVE | `20261031` MOC gate in `publish_revision` | DCK-1 | — | `publish_revision` chain (row 21) | — | DCR:126-127 |
| 34 LIVE | `20261032` ack and pin integrity | DIST-3, PKG-5 | — | re-created by 20261033 | — | DCR:161-162 |
| 35 LIVE | `20261033` guard patches | (7a self-audit) | 20261032 (h:15) | — | — | DCR:179-180 |
| 36 LIVE | `20261034` revert-target gate | REV-2 | — | `publish_revision` chain | — | DCR:199-200 |
| 37 LIVE | `20261035` ack currency | DIST-4 | — | — | — | DCR:229-230 |
| 38 LIVE | `20261036` publish path | OWN-1, OWN-2, OWN-5 | — | Re-created by 44 (`documents_guard_access_change`) and **77** (`enforce_library_sensitive_columns` and its trigger) | — | RP:126 |
| 39 LIVE | `20261037` read ownership and version integrity | GAP-15, EGRESS-6 | — | `node_visible` → 41; share insert policy → 80, 140 | — | RP:142-143; rp/10-content-egress.md:409 |
| 40 LIVE | `20261038` ticket workflow rails | WF-2, WF-5, WF-15, WF-23 | — | — | — | RP:165-166 |
| 41 LIVE | `20261039` tickets column repair | WF-5 (repair) | 20261038 | — | — | *"(applied; …)"* (RP:170) |
| 42 LIVE | `20261040` additive publish path | OWN-3, CHAIN-1, ADD-1 | — | publish guard and `publish_revision` chains | — | RP:192-193 |
| 43 LIVE | `20261041` `node_visible` additive | OWN-3 | 20261040 | — | — | RP:194-195 |
| 44 LIVE | `20261042` revocation and succession | SURF-1, GAP-5, OWN-12 | — | `revoke_member` → 43 | — | RP:213 |
| 45 LIVE | `20261043` legal hold and force-release | SURF-3, SURF-4 | — | Retention guard, trigger and `doc_disposition_events_no_delete` re-created by **77** | — | RP:214 |
| 46 LIVE | `20261044` owner delegation | DEL-1, GAP-3 | — | (re-created 20261011's folder policy, row 10) | — | RP:216 |
| 47 LIVE | `20261045` admin gates, team FK, reviewer independence | DEC-17, DEL-3, DEL-5 | — | **(derived)** 20261128 re-creates the `*_write_roles_delete` overlays on assets, asset_types and asset_photos (20261128:107-116). Never re-paste after it. | — | RP:218 |
| 48 LIVE | `20261046` authority by role collection | ADD-4, DOCACL-1, OWN-15, ADD-5 … | — | `user_can_publish_on_library` → 59 | — | RP:279 |
| 49 LIVE | `20261047` integrity rails | SURF-11..18, LIFE-6 | — | sign-off guard → **70** | — | RP:279 |
| 50 LIVE | `20261048` `drawing_audit_logs` write policy | SURF-7, EGRESS-3 | — | — | — | RP:288 |
| 51 LIVE | `20261049` hand-back `related_ticket_id` | GAP-6, LIFE-1, LIFE-5 | — | `publish_revision` → **105**, 130 | — | RP:306 |
| 52 LIVE | `20261050` signature ceremony | SURF-14, RG-9, EVID-3 | — | — | app before (h:25-27), historical | RP:314 |
| 53 LIVE | `20261051` markup store | GAP-7, LIFE-3 | — | — | — | RP:322 |
| 54 LIVE | `20261052` capability resource dimension | DRAFT-1, WF-13, GAP-1 | — | `org_capability_allows_for` → 57, 63, **132, 136** | — | *"applied & verified live 2026-09-17"* (RP:355-356) |
| 55 LIVE | `20261053` dead statuses | WF-17 | — | — | — | Round E one paste, *"Applied & verified live 2026-09-17"* (RP:392-397) |
| 56 LIVE | `20261056` capability-policy write guard | WF-11 | — | — | — | RP:392-397 |
| 57 LIVE | `20261057` engineer-gate capability | DEC-13 stage 3 | 20261052 | evaluator → 63 | — | RP:392-397 |
| 58 LIVE | `20261059` org-subject publish | OWN-18 | — | — | — | RP:392-397 |
| 59 LIVE | `20261060` archive publish authority | OWN-19 | — | publish guard → **70** | — | RP:392-397; dc/01-checkout.md:299 *"20261060, which is live"* |
| 60 LIVE | `20261061` branch resolution authority | OWN-21 | — | `revision_branches_org_update` → **139** | — | RP:392-397 |
| 61 LIVE | `20261062` library insert ownership rail | OWN-22 | — | — | — | RP:392-397 |
| 62 LIVE | `20261063` `admin.audit_view` capability | ROLE-5, SURF-9, WF-20 | 20261057 (RP:385-386) | evaluator → **132**; `audit_logs_admin_trail` from 45 | — | RP:392-397 |
| 63 LIVE | `20261066` share-list read decision | EGRESS-8 | — | — | — | RP:392-397 |
| 64 PASTE | `20261068`: `download_audits` becomes append-only, with share and transmittal attribution | DIST-9, DRLS-8, XEDGE-3, DIST-7, TRX-9, SHR-5, PHYS-8 | — | Precede 20261080 and 20261081 (DEC:1997) and P7's 20261132/33 (h:61-62) | §3B: paste before the share routes deploy | *"not applied"* (dc/10-rls.md:368; dc/05-distribution.md:402) |
| 65 PASTE | `20261070`: the review gate counts slots, needs a roster when policy requires one, and enforces author independence | RG-4, DRLS-6, RG-8, RG-7, REV-5 | bodies from **LIVE** 20261047 and 20261060 (h:49-50) | Precede 20261072 (dc/03-review-gate.md:212, :216) and **20261105** (20261105:80-82). Never re-paste after 20261105 or 20261139 (publish guard). | §3B: paste with the deploy | Pending (dc/03-review-gate.md:178, :290; dc/10-rls.md:282) |
| 66 PASTE | `20261071`: active-label unique index, branches included | REV-7 | — | — | — | Pending (dc/02-revisions-publish.md:313). Probe reads false if duplicates exist: reconcile and re-run (h:14-19) |
| 67 PASTE | `20261072`: document `review_control` guard and audit triggers | RG-5 | 20261070 (dc/03-review-gate.md:212, :216) | — | — | Pending (dc/03-review-gate.md:216) |
| 68 PASTE | `20261073`: `document_holds` integrity | HLD-5, HLD-9, HLD-7 | — | — | — | *"Until pasted the forgery door is open"* (dc/04-holds.md:251). Wrong-org holds must be deleted before any restore from an older backup (h:44-50) |
| 69 PASTE | `20261074`: held-document label rails | HLD-1 (DB half) | — | — | — | *"the label rails do not exist until pasted"* (dc/04-holds.md:61) |
| 70 PASTE | `20261075`: checkout episode seal | DCK-14 | — | — | — | *"done-when 1 holds only once the SQL is applied"* (dc/01-checkout.md:686) |
| 71 PASTE | `20261077`: records rails | HLD-1, RET-4, RET-6, DRLS-4, RET-13 | bodies from **LIVE** 20261043 and 20261036 (h:9-26) | Never re-paste 20261036 or 20261043 after it **(derived)** | — | Pending (dc/08-retention.md:194; dc/10-rls.md:190) |
| 72 PASTE | `20261080`: share minting tier, durable revocation, 90-day cap. **On apply, never-expiring links older than 90 days expire** (h:52-55). | DIST-6, SHR-4, EGR-5, SHR-3, REV-10, DRLS-5, DRLS-7, SHR-13 | 20261068 (DEC:1997) | Precede 20261081 (20261081:47) and 20261140 (20261140:38). Never re-paste after 20261140 **(derived)**. Re-creates 22/26/37's objects. | §3B | *"not applied"* (dc/10-rls.md:322; ps/02-share-links.md:215) |
| 73 PASTE | `20261081`: per-access share log; `bump_share_access` pinned | SHR-10, SHR-12 | 20261080 (h:47-49) | — | §3B | *"not applied"* (dc/10-rls.md:323) |
| 74 PASTE | `20261091`: quality rails | QUAL-12, QUAL-11, QUAL-13, QUAL-7, QUAL-2, SAF-1..4 | 20261013 tables (h:67, :76, :159) | Precede 20261102 (20261102:39-40) and 20261136 (20261136:3-5). If it is ever re-run, re-run 20261102 (same lines) and **(derived)** 20261136. | — | Pending (pc/03-quality.md:146; pt/02-safety-compliance.md:276) |
| 75 PASTE | `20261093`: money rails (delete guard, void rails, orphan view, backfill) | COST-10, COST-9, COST-11, MON-1, MON-8, REL-4 | 20261013 tables | — | — | Pending (pc/04-cost-and-bids.md:480; pt/03-money-ledger.md:74) |
| 76 PASTE | `20261094`: change-order authority split and decision guard | COST-6 | 20261013 (h:4) | drops `change_orders_write` (h:129) | — | Pending (pc/04-cost-and-bids.md:299) |
| 77 PASTE | `20261095`: registry indexes | PERF-11 (+REL-4, REL-9) | — | Probe false above 50,000 rows → foot statements (h:21-39) | — | Pending (pt/09-performance-scale.md:598) |
| 78 PASTE | `20261096`: cost-doc extent and company link; audited party backfill | COST-13, COST-3, COST-12, BID-12, MON-7 | — | — | — | Pending (pc/04-cost-and-bids.md:166) |
| 79 PASTE | `20261097`: import provenance | SCH-3, SCH-14 (GAP-403) | 20261066 (h:17) | precede 20261098 (20261098:34) | — | Pending (pt/06-schedule-engine.md:161) |
| 80 PASTE | `20261098`: `apply_milestone_moves` (NULL-uid fix and lock) and `can_edit_project_schedule` | SCHED-4, SCH-7, SCHED-9 | 20261097 (h:34) | precede 20261099 (pc/02-scheduling.md:144) | — | Pending (pc/02-scheduling.md:186) |
| 81 PASTE | `20261099`: baseline authority, rail and history | SCHED-3, SAF-7 | 20261098 (h:27-28) | — | — | Pending (pc/02-scheduling.md:150) |
| 82 PASTE | `20261102`: project read/write rails and ownership transfer | SEC-2, SEC-9, SEC-15, PM-7, PM-9, PM-11, SAF-17 | **20261091** (h:39-40) | Precede 20261103 (20261103:91). Re-creates `company_events_member_read` (from 13) and `turnover_review_events_member_read` (from 91). | — | Pending (pc/01-project-model.md:427; pt/01-security-access.md:124) |
| 83 PASTE | `20261103`: closeout, reopen and delete guards | PM-1, PC-1, PM-6, QUAL-3, SEC-9, PC-7 | 20261102 (h:91) | — | — | Pending (pc/01-project-model.md:74) |
| 84 PASTE | `20261104`: intake link as a bounded credential | INTK-1, INTK-9, INTK-14, INTK-8, PM-2, SEC-3/5/8/11/12 | — | precede 20261105 (20261105:80-82) | — | Pending (pc/05-intake-door.md:69; pt/01-security-access.md:208) |
| 85 PASTE | `20261105`: intake review and attempts. Re-creates the publish guard (from 70) and `publish_revision` (from 49). | INTK-4/5/8/13, SEC-8/13/14, SAF-9/10/12, REL-8 | **20261070** and 20261104 (h:80-82; pc/05-intake-door.md:206; pt/01-security-access.md:679) | Precede 20261130 (20261130:15-16) and 20261139 (20261139:50). **Never re-paste after 20261130 or 20261139** (SEQ:157-159, :216; 20261130:50-53; 20261139:55-56). | — | Pending (pc/05-intake-door.md:206) |
| 86 PASTE | `20261106`: `milestones` joins the realtime publication. Widening, id-only, on DELETE events (h:24-30). | SCH-7, RT-12 | — | precede 20261107 (20261107:40) | — | Pending (pt/06-schedule-engine.md:401) |
| 87 PASTE | `20261107`: all-or-nothing milestone delete RPC | SCH-17 | 20261106 (h:40) | — | — | Pending (pt/06-schedule-engine.md:822) |
| 88 PASTE | `20261120`: knowledge memory ACL | ASK-1, KACL-1, IRLS-1, IEDGE-5, KACL-7, IEDGE-6, IRLS-9 | — | — | — | Pending (int/02-ask-and-retrieval.md:67) |
| 89 PASTE | `20261121`: embed claim queue, retrievable coverage, `ef_search` | SEM-4, SEM-7, SEM-1, SEM-5, SEM-13, SEM-9 | **(derived)** 20261007_rag_hardening, 20261011_semantic_coverage_fast and 20261014 (it re-creates their functions, h:26, :44) | — | — | Pending (int/03-semantic-layer.md:62) |
| 90 PASTE | `20261122`: ingest claim, counters, chunker version, provenance, sync cursor, mirror FK | ING-1/2/4/6/7/8/11/12, GOV-9, ILIFE-5/13, IRLS-7 | — | — | — | Pending (int/01-ingestion.md:139, :318) |
| 91 PASTE | `20261123`: `knowledge_questions` search column re-stated after 20260911 | IRLS-6 | — | — | — | Pending. *"On live deployments it is a no-op"* (int/16-persistence-rls.md:287) |
| 91a HOLD | `20261124`: drawing audit verdicts keyed by library (`drawing_audit_logs.library_id`, new unique key), and the census counted in the database (`drawing_entity_rollup()`, `knowledge_doc_text_stats()`, service_role only) | DWG-6, DWG-11 (I-07) | — | — | **Wait for intelligence I-04** (h:23-28): until I-04 moves the orchestrator's `log_audit_completion` onto the new key, that one tool's upsert is refused (42P10) after this paste. The drawing page itself works either way. | Pending (int/14-drawing-intelligence.md DWG-6) |
| 92 PASTE | `20261125`: skills authority and `is_org_controller_for` | IEDGE-3, GOV-2, IRLS-3, ORCH-2, PR-3, HUB-2, LNK-7 | 20261016 (h:12), and 20261015 (re-creates its policies) | precede 20261126 (20261126:5) and **20261136** (20261136:3-5) | — | Pending (int/04-ai-governance.md:152) |
| 93 PASTE | `20261126`: plain conflict-target indexes, link provenance, readable-only link policy | LNK-3, IRLS-2, WIRE-2, IRLS-4, LNK-9, LNK-4, LNK-5, IRLS-15 | 20261125 (h:5) | — | — | Pending (int/09-link-proposals.md:164; int/16-persistence-rls.md:585) |
| 94 PASTE | `20261127`: one tag grammar | GAP-310, CB-9 | — | — | — | Pending (int/10-codebook.md:407; int/90-gap-register.md:550) |
| 95 PASTE | `20261128`: registry delete tier, delete audit, digit codes, unique asset code | AREA-1, IRLS-5, CB-2, IRLS-8, CB-3, CB-10 | probes **LIVE** 45, 46, 20 (h:5-15) | re-creates 45's delete overlays (row 47) | — | Pending (int/10-codebook.md:155, :470; int/12-operating-areas.md:58) |
| 96 NOW | `20261129_dc_hotfix_anon_execute.sql` | DRLS-16 (CRITICAL) | nothing (§2) | — | none | *"not yet pasted"* (dc/10-rls.md:702) |
| 97 PASTE | `20261130`: `publish_revision` needs an override reason. Drops the 11-argument signature, creates a 12-argument one, revokes anon. | DCK-8 | 20261105 (h:15-16) | Precede 20261131 (20261131:112). **Never re-paste 20261105 or earlier after it; if that happens, re-run this file** (h:50-53; SEQ:157-159). | §3B: paste before the wave-2 deploy | Pending (dc/01-checkout.md:403) |
| 98 HOLD | `20261131`: documents rails (label, pointers, evidence FKs, supersession policies) | DRLS-3, DRLS-14, DRLS-13, REV-14 (+REV-13) | 20261130 (h:112) | — | **§3A: DRLS-15 and DRLS-17 deployed first** | *"not pasteable yet"* (dc/10-rls.md:152, :579; dc/02-revisions-publish.md:609) |
| 99 PASTE | `20261132`: `transmittal.issue` capability row in `org_capability_allows_for` (re-created from 63) | TRX-1 | — | **Precede 20261133** (h:17-20; dc/06-transmittals.md:64) and 20261136. **(derived)** Never re-paste after 20261136. | §3B: 132 → 133, then deploy | *"Until they are applied only the app half … is in force"* (dc/06-transmittals.md:64) |
| 100 PASTE | `20261133`: transmittal rails. Re-creates `transmittals_guard` (from 27). | TRX-1/2/3/4/6/8/12, HLD-1 | **20261132**. It raises and rolls back otherwise (h:3-6). | — | §3B | dc/06-transmittals.md:64 |
| 101 PASTE | `20261134`: `verify_scans` and `prune_verify_scans()` | VFY-12 (+deploy-impact counts VFY-9, VFY-20) | none. *"nothing existing is re-created"* (h:34-39) | — | none (§3B) | *"not applied"* (ps/01-verify-endpoints.md:588) |
| 102 PASTE | `20261136`: quality sign-off authority. Adds the `projectId` key and `quality.sign_off`; re-creates the four quality write policies. | QUAL-4 | **20261091, 20261125, 20261132**. It refuses otherwise (h:3-5; pc/03-quality.md:269). | — | — | Pending (pc/03-quality.md:269) |
| 103 PASTE | `20261138`: unit identity (`units.codebook_code`, `documents.unit_code`, guards, projection) | GAP-305, GM-6 | — | **Paste once more after the first decode run** (h:109-112; int/90-gap-register.md:335) | — | Pending (int/07-graph-model.md:122) |
| 104 HOLD | `20261139`: first-issue refusal (publish guard from 105) and branch close-out WITH CHECK (from 61) | REV-17, DRLS-9 | 20261105, 20261061 (h:50-51; SEQ:213-215; dc/02-revisions-publish.md:762). Any order relative to 20261129–20261131 (h:51-52; SEQ:210-211). | Never re-paste 20261105 after it (h:55-56; SEQ:216). REV-17 is fully closed only once 20261131 is live too (h:52-55). | **§3A: REV-15 app change with or before it** | *"not yet pasted"* (dc/02-revisions-publish.md:759; dc/10-rls.md:419) |
| 105 PASTE | `20261140`: `user_download_denied()` plus a deny arm on `document_shares_insert` (from 80) | SHR-14 | 20261080 (h:38). `role_rank` comes from LIVE 46. | independent of 20261139 (h:40; ps/02-share-links.md:720) | — | *"not yet pasted"* (ps/02-share-links.md:717) |
| 106 HOLD | `20261141`: the intake link stored as the SHA-256 of its token (every stored token hashed, the plain column nulled and kept null by a CHECK); intake authorship fixed; `adopt_intake_document` and the adoption number guard | SEC-19, SEC-16, INTK-16 (projects J11) | 20261104, 20261105 (it refuses otherwise) | — | **IRREVERSIBLE — §3A.** Paste only once the J11 build is live AND open browser tabs have reloaded. The file refuses to run until you uncomment its `SET app.j11_deployed = 'yes';` line. | Pending (pt/01-security-access.md SEC-19) |
| 107 PASTE | `20261142`: a private project's audit rows are read by those who can read the project (`audit_row_project_visible`); `audit_logs_admin_trail` re-created from 20261063 | SEC-20 (projects J11) | 20261063 (LIVE), 20261102 (`project_visible_to_me`) | **(derived)** Never re-paste 20261045 or 20261063 after it (both define `audit_logs_admin_trail`). | — | Pending (pt/01-security-access.md SEC-20) |
| 108 HOLD | `20261143`: closing or deleting a work package limited to its owner and controllers; deleting a printed package refused through the API; the field-pack budget's MEASURE counts | DRLS-10, PKG-12 (document-control P8) | 20260825 (the work_packages policies it re-creates) | — | **§3A: with the P8 app deploy or just after, never before** (h:66-73) — pasted first, the old page shows a false "Package closed" to a non-owner. | Pending (dc/10-rls.md DRLS-10) |

**Sequence at a glance.**
1. **20261129**, now.
2. Settle the ASK rows (1–19) and the STEP 0 gate on row 20 (§5).
3. Paste in this order:
   - 20261068, 20261070, 20261071, 20261072, 20261073, 20261074, 20261075, 20261077, 20261080, 20261081
   - 20261091, 20261093, 20261094, 20261095, 20261096, 20261097, 20261098, 20261099, 20261102, 20261103, 20261104, 20261105, 20261106, 20261107
   - 20261120, 20261121, 20261122, 20261123, 20261125, 20261126, 20261127, 20261128
   - 20261130, 20261132, 20261133, 20261134, 20261136, 20261138, 20261140
4. Deploy the app build carrying the wave-2 changes (SEQ:167-168).
5. Paste 20261131 once DRLS-15 and DRLS-17 are deployed, and 20261139 once REV-15 is deployed (either order). Paste 20261124 once intelligence I-04 is deployed. Paste 20261141 once the J11 build is live and open tabs have reloaded; 20261142 any time after 20261102; 20261143 with or just after the P8 deploy.
6. Paste 20261138 again after the first decode run.

No record or header makes 20261132–20261140 depend on 20261131, so holding 20261131 does not block them (derived from the headers above).

---

## 5. Conflicts and questions

1. **Is 20261011 live?** No record says.
   - Two later headers describe its folder policy as having been in force: 20261044:16-18 *"(was controller-only …)"* and 20261072:7-8 *"the RESTRICTIVE controllers-only UPDATE policy (20261011)"*.
   - The 20261072 description is out of date either way. LIVE 20261044 (RP:216) changed that policy to "controller OR owner OR manage-grant" (20261044:93-105).
   - **(derived)** Pasting 20261011 now, whether for the first time or again, would replace 20261044's policy and drop 20261020's `search_path` pin on `enforce_document_move_guard`. Its folder-trash and move-guard parts would need a re-based file rather than a paste.
2. **Is 20261013 live?**
   - pt/README.md:18 says it *"may not be applied in production"*.
   - Yet every projects Round G file builds on its tables (20261091:67,76; 20261094:4; 20261095:16), and 20261136 runs end to end only on a database that has it (pc/03-quality.md:259).
   - A verifier notes that if it were unapplied, `project_checklists` would not exist either (pc/03-quality.md:463).
   - Confirm with schema-health (pt/08-reliability.md:343) before pasting 20261091 and later.
3. **20261009_trace_method (resolved 2026-10-01).** It raised 42P01 after `20261007_retire_line_traces`. Since the I-07 merge it runs its ALTER only while the table exists (DWG-9). **(derived)** Pasting `20261007_line_traces` now would still resurrect the retired table, so keep row 1 as ASK.
4. **A wrong citation in 20261129 (corrected 2026-10-01).** Its header and dc/10-rls.md listed 20261060 among the `publish_revision` signatures, but `20261060_rp_roundE_archive_publish_authority.sql` contains no `publish_revision` at all. The real chain is 19 → 31 → 34 → 36 → 40 → 49 → 105 → 130. Both comments now read `20261049 / 20261105 / 20261130`; the SQL is unchanged, and it was harmless anyway, because the hotfix loops over overloads by name.
5. **SEQ contradicts itself on the one-deploy order.**
   - SEQ:183-184 labels the window "wave-2 app deployed, `20261130` not yet pasted" as *"(the one-deploy order)"*.
   - SEQ:170-172 defines the one-deploy order as paste 20261130 → deploy → paste 20261131, and 20261130:47 also says paste it BEFORE the deploy.
   - Follow 170-172. Both windows fail closed in any case.
6. **The 20261131 gate is not recorded as met.** DRLS-15 and DRLS-17 are RESOLVED in code (dc/10-rls.md:633, :722; SEQ:164), but no record says the app carrying them is deployed. Confirm before pasting.
7. **20261018 wording.** id/02-identity-collision.md:155 says *"Pending migration: … — applied by hand, after STEP 0"*, which reads like an applied claim. IDENT-1 is BLOCKED (:139), and the Blocker (:157) says STEP 0 has not been run. Treat it as not applied.
8. **20261024 file ≠ the text that was pasted.** h:23-26 says the live paste on 2026-08-24 used a single replacing `UPDATE`, and that the file is a corrected form with the same end state. It does not need re-pasting.
9. **Document-control wave 1 (20261068–20261077).** DCR:52-56 says the wave was *"printed as ONE script"* for one paste, but makes no applied claim, and every record calls them pending or not applied. No such combined script exists under `supabase/` (only `APPLY_roles-and-permissions_2026-08-24.sql`). If that combined script was in fact pasted, the records were never updated. Ask before pasting.
10. **20261139's deploy prerequisite is still OPEN.** REV-15 has a Partial block (dc/02-revisions-publish.md:664, :681). Confirm which app build carries the bulk-upload change. Separately, REV-18 (Draft → Issued bypass) is OPEN, so REV-17's refusal stays incomplete even after 20261131 and 20261139 are both live (SEQ:220-226).
11. **Derived re-paste hazards the records do not state.**
    - Never re-paste 20261132 after 20261136: it drops the `projectId` key and the `quality.sign_off` row, 20261136:12-25.
    - Re-running 20261091 after 20261136 reverts the four quality write policies, so re-run 20261136 as well as the 20261102 re-run that 20261102:39-40 names.
    - Never re-paste 20261045 after 20261128.
    - Never re-paste 20261080 after 20261140.
    - Never re-paste 20261013 after 20261094.
    - Never re-paste 20261015 or 20261016 after 20261125.
    - Never re-paste 20261007, 20261011 or 20261014 after 20261121.
