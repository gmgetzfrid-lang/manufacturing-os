# 01 · Org lifecycle, membership & teams

**13 findings** — 2 CRITICAL · 1 HIGH · 10 MEDIUM.

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
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/restore/apply/route.ts:30-31`, `app/api/admin/restore/apply/route.ts:75-104`, `lib/dataRestore.ts:135-138`, `lib/dataRestore.ts:210-216`, `lib/dataRestore.ts:352-361`, `lib/dataRestore.ts:86-93`, `app/api/admin/restore/apply-table/route.ts:8-12`, `app/api/admin/restore/apply-table/route.ts:24, 38-40, 54-59`
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

---

<a id="org-2"></a>

## ORG-2 · org_members has NO DELETE policy — "Remove from workspace" silently deletes nothing and reports success, so an offboarded engineer keeps access to controlled drawings

- **Severity:** CRITICAL
- **Status:** OPEN
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

- [ ] A `org_members_delete` policy exists (Admin/Manager of the row's org, roles[]-aware like `is_org_admin_or_manager`), or removal moves to a service-role route that verifies the caller
- [ ] `handleRemoveMember` checks the affected row count, not just `error`, and refuses to update local state when zero rows changed
- [ ] schema.sql's `org_members_write FOR ALL` is reconciled with 20260817 so fresh and migrated databases have the same policy set
- [ ] The users page exposes suspend/reactivate so `status` can actually be changed

---

<a id="org-3"></a>

## ORG-3 · "Request Access" is a black hole with a cross-tenant leak: nothing ever reads access_requests, any Admin of any org can read every tenant's requests, anon can insert unbounded rows, and the client shows "Request Sent" even on a 404/409

- **Severity:** HIGH
- **Status:** OPEN
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

- [ ] `access_requests_admin_select` correlates the row to the caller's org (`is_org_admin(access_requests.org_id)`), and the table has an `org_id` column in the migration
- [ ] An admin surface lists pending access requests and an approve action creates the member, or the Request Access mode is removed from /signup
- [ ] `handleRequestAccess` checks `res.ok` and surfaces the route's error text
- [ ] The route is rate-limited like /api/auth/signup, and the direct anon INSERT policy is removed in favour of service-role-only writes

---

<a id="org-4"></a>

## ORG-4 · A DocCtrl can edit Request Numbering in /admin/settings and be told "Saved" — the orgs RLS policy admits only Admin, so the write matches zero rows and returns no error

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="org-5"></a>

## ORG-5 · Any active org member can overwrite the org logo in R2 — the Admin-only branding RLS is bypassed because authority lives on the config row, not the storage key

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="org-6"></a>

## ORG-6 · Every org-authority SECURITY DEFINER helper — the functions all RLS policies call — is missing SET search_path, while the guards written later all set it

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="org-7"></a>

## ORG-7 · Member removal orphans everything hung off the member — no team_members prune, no ACL prune, no ownership reassignment, and the recertification snapshot degrades to raw UUIDs for exactly the departed people

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="org-10"></a>

## ORG-10 · The "View as" access simulator queries team_members by a column that does not exist, so team-derived access is invisible in the one screen built to show effective access

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="org-11"></a>

## ORG-11 · The org-enforced palette is applied straight from the database with no hex validation, while every other palette entry point validates

- **Severity:** MEDIUM
- **Status:** OPEN
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
- **Status:** OPEN
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

---
