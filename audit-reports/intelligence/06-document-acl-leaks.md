# 06 · Document-section permission leaks

**12 findings** — 1 CRITICAL · 3 HIGH · 8 MEDIUM.

**Your leak question, half two.** Every path by which content — or its existence — reaches someone the ACL forbids.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| lib/acl.ts — a single, well-tested pure ACL engine with allow/deny precedence, rule expiry, inherit-break, hidden/private visibility, and an isActiveMember kill-switch. It is genuinely the one place the semantics live for the app side. | `lib/acl.ts:87-214, lib/__tests__/acl.test.ts` | Every fix above should route through this engine rather than adding a third interpretation. The DB needs to be made to agree with it, not replaced by it. |
| lib/knowledgeAccess.ts — the AI layer's per-asker ACL seam. It loads a real principal, walks the true library→folder→document chain server-side with supabaseAdmin, and the ask route FAILS CLOSED (any error excludes all linked docs). | `lib/knowledgeAccess.ts:190-217, app/api/knowledge/ask/route.ts:163-186` | This is the only place in the codebase that resolves the full ACL chain on the server. It is the right shape for fixing the document-control side — the same landscape walk could back a SECURITY DEFINER RLS helper. |
| /api/storage/download-url's H7 gate — the one enforcement point that binds an ACL to actual bytes, including an explicit acl_index deny-download check that consults the additive roles array. | `app/api/storage/download-url/route.ts:48-115` | The pattern is correct; it just never fires because the documents it protects are all visibility='normal'. Fix the visibility/index propagation and this gate starts doing its job with no change. |
| lib/storageKey.ts — a strict, documented storage-key validator (no traversal, no control bytes, no empty segments) wired into download-url, upload-url and multipart. | `lib/storageKey.ts:41-53` | Complete and correct; the only gap is that /api/storage/delete does not call it. One line closes that. |
| Legal-hold BEFORE DELETE triggers on documents and document_versions, applied to service-role callers too. | `supabase/migrations/20260826_legal_hold_delete_guard.sql:29-58` | The row-level spoliation guard is genuinely airtight. It defines the standard the object-storage delete path must be raised to. |
| Server-side share stamping — /api/share/file pulls bytes bucket→server and applies applyStampToPdfDoc before any byte leaves, replacing a CORS-broken client-side stamp whose fallback leaked the raw file. | `app/api/share/file/route.ts:1-16, 105-125` | The copy-control story for outsiders is sound. Only the authorization to create the share is missing. |
| audit_logs INSERT is org-constrained, and full-org exports raise an out-of-band bell alert to every other Admin/DocCtrl. | `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90, app/api/data-export/run/route.ts:38-68` | Detection controls exist and work; they are what makes the Manager-export finding a scoping bug rather than an invisible one. |
| doc_is_visible() — a SECURITY DEFINER helper that lets a child table reuse its parent document's visibility decision without nested-RLS recursion, already applied to document_versions. | `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:34-45` | This is exactly the primitive the unprotected join tables (document_assets, project_documents, document_related_resources, document_supersessions, entity_mentions) need; the fix is mechanical. |
| components/permissions/ViewAsSimulator.tsx — an admin 'see it as this person' tool that evaluates canDiscover against a real principal with real team ids. | `components/permissions/ViewAsSimulator.tsx:36-46, 161-162` | The right surface to make the silent-lockout finding self-diagnosing: it should also surface what the DB would answer, exposing app/DB divergence to the admin at configuration time. |


---


<a id="dacl-1"></a>

## DACL-1 · Folder and library ACLs never reach the database: node_visible() short-circuits on visibility='normal' and documents.acl_index is never recomputed from the container chain

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260708_acl_rls_enforcement.sql:52-55`, `supabase/migrations/20260708_acl_rls_enforcement.sql:85-91`, `components/permissions/PermissionDrawer.tsx:258-285`, `app/(protected)/documents/[libraryId]/page.tsx:2449-2452`, `app/(protected)/documents/[libraryId]/page.tsx:1742-1751`, `app/api/storage/download-url/route.ts:70-71`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the claims of absence — I searched every migration and supabase/REMEDIATION_APPLY_ALL.sql for a trigger, function, or policy that walks the container chain for documents and found none (the only documents trigger, 20261011_collections_guard_and_trash.sql:58-59, is a move guard). Because a document's own visibility stays 'normal' even when created inside a restricted folder, node_visible returns true at line 54 before it can read the acl_index — so restricting a folder or library is enforced by React only, and a raw PostgREST select with the member's own JWT returns the rows.

**Mechanism.** Restricting a FOLDER is done by PermissionDrawer, which writes `acl`, `acl_index` and `visibility` to exactly ONE row: `supabase.from(table).update(payload).eq("id", nodeId)` (PermissionDrawer.tsx:284). Nothing recomputes the child documents' `acl_index`, and the children keep `visibility='normal'`. The only SELECT-restricting policy on `documents` is `documents_acl_select ... USING (node_visible(visibility, acl_index, org_id))`, and node_visible's FIRST branch is `IF p_visibility IS NULL OR p_visibility = 'normal' THEN RETURN true;`. So the restricted folder's contents pass RLS unconditionally. `document_versions_acl_select` delegates to `doc_is_visible(record_id)` → the same node_visible → also true, exposing `file_url`. Then /api/storage/download-url only applies its ACL gate `if (doc && (visibility === "private" || visibility === "hidden"))` — normal skips it — and signs the object. The ONLY thing hiding the folder's contents is the client-side filter in the library page (`canWithAclChain({... defaultAllow: true})`).

**Failure scenario.** DocCtrl restricts folder "MOC-2031 Turnaround" to team Engineering via the Permissions drawer. A Contractor-role member opens devtools (or curl) and issues `GET /rest/v1/documents?select=id,document_number,title,current_version_id&collection_id=eq.<folder-uuid>` with their own session JWT. Every row returns. They then `GET /rest/v1/document_versions?select=file_url&record_id=eq.<doc>`, take the key, call `GET /api/storage/download-url?path=<key>` — visibility is 'normal', the H7 gate is skipped, a presigned R2 URL is returned, and they download the restricted drawing. The same rows also appear, unfiltered, in the org graph (lib/orgGraph.ts:109-113 selects id/document_number/title with only `.eq("org_id", orgId)`) and in global search.

**Evidence.**

```
20260708_acl_rls_enforcement.sql:52-55 — `-- Fail-safe: normal/unset visibility is open to org members.` / `IF p_visibility IS NULL OR p_visibility = 'normal' THEN` / `RETURN true;` ... PermissionDrawer.tsx:284 — `const { error } = await supabase.from(table).update(payload).eq("id", nodeId);` ... download-url/route.ts:70-71 — `const visibility = (doc?.visibility as NodeVisibility | undefined) ?? "normal"; if (doc && (visibility === "private" || visibility === "hidden")) {`. Two grep shapes confirm no propagation exists: `grep -rn "buildAclIndexFromChain|buildAclIndex\b" app/ components/ lib/` returns only 4 call sites (folder create, folder create-on-upload, document create, PermissionDrawer.save) and `grep -rniE "acl_index" --include=*.sql supabase/ | grep -iE "trigger|update .*set|recompute"` returns nothing.
```

**Chain reaction.** Because RLS is the only server-side gate, EVERY client-side surface that reads `documents` with the anon client inherits the leak: the org graph (lib/orgGraph.ts:109), the Cmd+K palette (lib/globalSearch.ts:36 → lib/search.ts), the where-used Impact panel (lib/impact.ts:91-94), the doc-pack bundler (lib/docPack.ts:51-54), thumbnails (components/documents/DocThumb.tsx:38-42), and version history.

> **Verifier correction.** One nuance worth keeping straight: documents DO get an acl_index built from the chain at upload (page.tsx:2450-2451) and folders at create (page.tsx:600, 2072) — what never happens is RE-computation after a container's ACL changes. It is also moot either way while the child's visibility stays 'normal', since node_visible returns true before it ever looks at acl_index.

**Done when.**

- [ ] Restricting a folder makes `SELECT` on its child documents return zero rows for a non-granted member via direct PostgREST, not just in the UI
- [ ] node_visible (or a replacement) resolves the container chain — e.g. a SECURITY DEFINER walk of collections.parent_id up to libraries — instead of trusting a per-row denormalized acl_index that no writer maintains
- [ ] A trigger (or the same chain walk) keeps documents.acl_index/visibility in sync when a parent folder's or library's ACL changes, and when a document is moved between folders (app/api/documents/move/route.ts currently touches no acl column)

---

<a id="dacl-2"></a>

## DACL-2 · /api/storage/delete permanently destroys R2 objects with only an org-membership check — no ACL, no controller role, no legal-hold guard, and (uniquely) no storage-key validation

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/delete/route.ts:6-44`, `lib/storage.ts:442-450`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:17-58`, `lib/storageKey.ts:41-53`, `app/api/storage/download-url/route.ts:26-29`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every element checks out. The legal-hold triggers are the sharpest confirmation: the header at :10-13 claims they "close every path at once", but they can only refuse the DB delete, so bytes destroyed through this route leave the held document row and register entry intact and the spoliation invisible. The one point worth qualifying is the storage-key gap — lib/storageKey.ts:4-11 argues traversal is not itself exploitable against R2's opaque keys, so that part is a consistency defect rather than a second vulnerability.

**Mechanism.** The delete route resolves the user, parses `orgs/<uuid>/` out of the caller-supplied path, confirms active membership, and issues `DeleteObjectCommand` — nothing else. It never calls `assertSafeStorageKey`, which every sibling storage route does (download-url:29, upload-url:26, multipart:37). It never looks up which document owns the key, so it cannot honour `legal_hold`, `retention_until`, `disposition_state`, or the document's ACL. The DB triggers `trg_documents_legal_hold_delete` / `trg_document_versions_legal_hold_delete` protect the ROWS but are irrelevant to the bytes in R2. Any member can read `document_versions.file_url` for any normal-visibility document (see finding 1), so target keys are trivially discoverable.

**Failure scenario.** A departing Contractor with an active seat lists `document_versions` (RLS permits, all docs are visibility 'normal'), collects the `file_url` of every P&ID under an open OSHA legal hold, and issues `DELETE /api/storage/delete` for each. The DB rows survive and the register still lists the drawings, so nothing looks wrong — but every open, print, doc-pack and transmittal now 404s, and /api/storage/resolve reports `{archived:true, missing:true}` as if the file had been shed to an archive. In a PSM/OSHA context this is spoliation of evidence performed by a role with no delete authority anywhere else in the app (documents_delete_controllers and document_versions_delete_controllers restrict row deletion to controllers).

**Evidence.**

```
app/api/storage/delete/route.ts:26-40 — the entire authorization is `const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//); if (orgMatch) { ...select("uid")...eq("status","active").maybeSingle(); if (!member) return 403; }` followed immediately by `await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));`. Contrast supabase/migrations/20260815_versions_collections_delete_controllers.sql:22-23 `CREATE POLICY document_versions_delete_controllers ON document_versions` and 20260826_legal_hold_delete_guard.sql:12 `Applies to EVERYONE (including service-role scripts): release the hold first, then delete.`
```

> **Verifier correction.** The traversal half of the finding is the weaker half: S3/R2 treats a key as an opaque literal, so `orgs/<mine>/../../orgs/<other>/x` names a key that does not exist rather than resolving to another tenant's object. The load-bearing defect is the missing document-level authorization (ACL, controller tier, legal hold) on an irreversible destructive operation — and file_url values are readable by any member per finding 1, so targets are discoverable.

**Done when.**

- [ ] The route resolves the key to its owning document_version/ticket and refuses when the document is under legal hold, inside retention, or when the caller lacks an admin/write grant on it
- [ ] `assertSafeStorageKey(path)` is called before the org-prefix parse, matching download-url/upload-url/multipart
- [ ] Object deletion writes an audit_logs row naming the key, the document and the actor

---

<a id="dacl-3"></a>

## DACL-3 · /d/[number] is unauthenticated, service-role, and NOT org-scoped — it hands out real document and library UUIDs for any tenant, and /api/verify then turns a UUID into title + revision status

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/d/[number]/route.ts:26-46`, `app/api/verify/route.ts:22-39`, `app/api/verify/route.ts:96-108`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The claim is right and each route's own comment states the assumption the other one breaks. /d/[number]:6-7 says "The target page enforces auth + RLS as always — this route only translates a number into a location; it reveals nothing", but the redirect body is never fetched — the Location header IS the disclosure. /api/verify:5-7 rests on "Both IDs are unguessable UUIDs that only appear ON a printed copy the org itself issued", which /d/ falsifies by handing out real document UUIDs from any tenant to an unauthenticated caller supplying a 2-character substring.

**Mechanism.** The short-link route runs `supabaseAdmin` (service role, RLS bypassed) with `.ilike("document_number", "%"+raw+"%")` and NO `.eq("org_id", ...)` and no auth check at all. It then 302-redirects to `/documents/{match.library_id}?doc={match.id}` — the Location header discloses two real UUIDs. Worse, the fallback `?? (rows ?? [])[0]` means a mere substring match redirects, so enumeration needs no exact number. /api/verify is likewise unauthenticated service-role and accepts `doc` alone (`v` is optional: `if (!UUID_RE.test(docId) || (versionId && !UUID_RE.test(versionId)))`), returning docNumber, title, currentRev and docStatus with no visibility or ACL check.

**Failure scenario.** An unauthenticated attacker (or a Contractor in org A) requests `GET /d/P-101` with redirects disabled. The 302 Location is `/documents/<libraryUuid>?doc=<docUuid>` — possibly belonging to a DIFFERENT customer's workspace. They feed that UUID to `GET /api/verify?doc=<docUuid>` and receive `{docNumber:"P-101", title:"Crude Unit Overhead P&ID", currentRev:"C", docStatus:"Issued"}`. Iterating over plausible drawing numbers enumerates another tenant's document register, including documents marked private, with no login.

**Evidence.**

```
app/d/[number]/route.ts:6-7 comment claims `The target page enforces auth + RLS as always — this route only translates a number into a location; it reveals nothing.` The query at :26-32 is `await supabaseAdmin.from("documents").select("id, library_id, document_number, updated_at").filter("document_number", "not.is", null).ilike("document_number", \`%${raw.replace(/[%_]/g, "")}%\`)` — no org filter, no session. app/api/verify/route.ts:4-10 comment claims `Both IDs are unguessable UUIDs that only appear ON a printed copy the org itself issued` — falsified by this route and by document_assets (see separate finding).
```

> **Verifier correction.** CRITICAL is a notch high: the disclosure is identifiers plus revision metadata (library UUID, doc UUID, number, title, rev, status) — no file bytes, no ACL bypass on content. Exploitation needs a guessable document-number substring, which in a plant numbering scheme is realistic, so HIGH rather than MEDIUM.

**Done when.**

- [ ] /d/[number] requires an authenticated session and scopes the lookup to the caller's active org, or is removed
- [ ] A non-match and a cross-org match are indistinguishable in the response (same redirect target, same timing)
- [ ] /api/verify requires BOTH doc and version ids and refuses documents whose visibility is private/hidden, or is scoped to versions that were actually stamped/issued (a `verify_tokens` table keyed to a printed copy)

---

<a id="dacl-4"></a>

## DACL-4 · Any active org member can mint a public share link for any document id, and /api/share/file serves the full bytes with no ACL, no download-deny, no ack-gate and no legal-hold check

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260623_document_shares.sql:37-54`, `lib/documentShares.ts:33-57`, `app/api/share/file/route.ts:42-58`, `app/api/share/file/route.ts:105-125`, `app/api/storage/download-url/route.ts:92-111`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every limb: RLS gates share creation on org membership only, and the file route is service-role with no ACL/legal-hold/download-deny/ack check. I looked for a compensating guard in /api/share/resolve and in ShareLinkModal and found none — the modal is pure UI, and the insert goes through PostgREST so any UI gating is bypassable. If anything the finding understates it: the WITH CHECK never verifies that document_id belongs to org_id, and share/file resolves the document by id with no org filter, so a member can also mint a link for a document in a DIFFERENT tenant.

**Mechanism.** `document_shares_org_member` is a `FOR ALL` policy whose USING and WITH CHECK both test only active org membership — `document_id` is entirely unconstrained, so the INSERT check never asks whether the inserter can see that document. `createShareLink` inserts with the browser client, so any member can create a token for any document UUID in their org. /api/share/file then resolves the token with the SERVICE ROLE and reads `documents` + `document_versions` directly, checking only `revoked_at` and `expires_at`. It applies none of the protections the internal download path applies: no `canDiscover`, no acl_index deny-download check (download-url/route.ts:97-110 has one), no `assertAckGate` (lib/downloads.ts:177-215), no legal-hold or retention lookup, and no `download_policy` check. `expiresInDays: 0` in createShareLink produces `expiresAt = null` — a never-expiring public link.

**Failure scenario.** A Contractor is explicitly denied read on the private HAZOP report but learns its UUID from `document_assets` (readable by every member — see separate finding) or from an old email link. They POST a row into `document_shares` with that document_id (RLS permits it), receive the token, and hand the URL to an outsider. `/api/share/file?token=...` streams the complete PDF, watermarked but intact, to anyone on the internet. The download_audits row is attributed to the SHARER, not the outsider (`user_id: (share.created_by as string | null) ?? null`), so the trail names the contractor once, not each pull.

**Evidence.**

```
20260623_document_shares.sql:38-54 — `CREATE POLICY document_shares_org_member ON document_shares FOR ALL USING (EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = document_shares.org_id AND org_members.uid = auth.uid() AND org_members.status = 'active')) WITH CHECK (<same>);` — note per the RLS composition rule this FOR ALL policy governs INSERT via its WITH CHECK, which never mentions document_id. app/api/share/file/route.ts:42-51 — the only gates are `if (!share) ... if (share.revoked_at) ... if (share.expires_at && ... < Date.now())`. lib/documentShares.ts:43-45 — `: input.expiresInDays === 0 ? null`.
```

**Done when.**

- [ ] The document_shares INSERT policy requires the inserter to pass the same visibility/ACL predicate as `documents` SELECT (e.g. `WITH CHECK (... AND doc_is_visible(document_id))`), and ideally a `download` grant
- [ ] /api/share/file re-checks the SHARER's live ACL at fetch time (a revoked grant kills live links) and refuses documents under legal hold or with a hard ack gate
- [ ] Share creation is restricted by capability policy, is audited as a distribution event, and a null expiry is impossible from the UI

---

<a id="dacl-5"></a>

## DACL-5 · ACL rules addressed to a member's secondary role are inert everywhere except the download-deny check — grants silently do nothing, denies partially bite

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/acl.ts:72-74`, `components/providers/RoleContext.tsx:11-12`, `app/(protected)/documents/[libraryId]/page.tsx:1650-1657`, `app/api/storage/download-url/route.ts:99-107`, `supabase/migrations/20260708_acl_rls_enforcement.sql:58-59`, `supabase/migrations/20260722_member_roles_collection.sql:12-13`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide search for evaluateAcl/evaluateAclChain/canDiscover callers turned up no other site that expands org_members.roles into the ACL principal, so the asymmetry is real: secondary-role allow grants are inert, and a secondary-role deny binds only on download-URL issuance. 20260722_member_roles_collection.sql:5-8 even states the design intent ("every existing single-role check and every RLS policy reads `role`"), which is the cause, not a refutation.

**Mechanism.** `subjectMatches` for a role subject is `return !!ctx.role && ctx.role === (id as Role);` — a single scalar. The principal is built as `role: activeRole`, which RoleContext documents as `role: Role; // headline — highest-ranked of \`roles\``. node_visible likewise does `SELECT role INTO v_role FROM org_members`. But org_members carries an additive `roles TEXT[]`, and exactly one code path honours it: the download-deny branch, `const heldRoles = ((mem2?.roles as string[] | null) ?? [(mem2?.role as string) ?? "Viewer"]); ... heldRoles.some((r) => (dl.roles?.download ?? []).includes(r))`.

**Failure scenario.** A user's headline role is Engineer-2 and their collection is ['Engineer-2','Safety']. An admin grants `allow read` to role Safety on the incident library. The user still sees nothing — the grant matches no principal. Conversely an admin adds `deny download` to role Safety on a drawing: the drawing still opens and prints in the viewer, but the download button 403s with 'Downloading this document is denied for your account', which reads as a bug. Neither behaviour matches the admin's mental model, and the Permissions drawer's role picker (ROLES list, PermissionDrawer.tsx:56-73) gives no hint that only the headline role counts.

**Evidence.**

```
lib/acl.ts:73 — `return !!ctx.role && ctx.role === (id as Role);`. app/(protected)/documents/[libraryId]/page.tsx:1653 — `role: activeRole,` (no `roles`). app/api/storage/download-url/route.ts:102 — `const heldRoles = ((mem2?.roles as string[] | null) ?? [(mem2?.role as string) ?? "Viewer"]);`. supabase/migrations/20260722_member_roles_collection.sql:6-8 comment — `Every existing single-role check and every RLS policy reads \`role\`, so they keep working unchanged — no RLS surgery, no lockout risk.`
```

> **Verifier correction.** 'Exactly one code path honors it' is too absolute — it is true only within ACL subject matching. `roles` is honoured for access decisions elsewhere: lib/knowledgeAccess.ts:37-38 computes `isController` from the union (`roles.has("Admin") || roles.has("DocCtrl")`), 20260817_org_members_escalation_and_config.sql:21-27 uses `roles && ARRAY['Admin','Manager']`, and RoleContext.tsx:369 exposes hasAnyRole used by several screens. Restate the finding as: the ACL engine's role subject is scalar-only, so role-scoped grants/denies bind only against the headline role — download-deny (download-url/route.ts:99-107) is the sole ACL evaluation that reads the additive collection.

**Done when.**

- [ ] SubjectContext carries the full role collection and subjectMatches tests membership in it; node_visible reads org_members.roles the same way
- [ ] Every principal construction site passes the collection, not just activeRole
- [ ] The Permissions drawer states which roles a rule will actually match for a given member (the ViewAsSimulator already has the shape for this)

---

<a id="dacl-6"></a>

## DACL-6 · App layer denies by default once any ACL object exists; the DB allows by default — saving the Permissions drawer with zero rules silently blanks an entire library for every non-controller

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/acl.ts:166-205`, `lib/acl.ts:139-154`, `lib/permissions.ts:40-41`, `lib/permissions.ts:117-131`, `components/permissions/PermissionDrawer.tsx:263-270`, `app/(protected)/documents/[libraryId]/page.tsx:1728-1751`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified both halves and the trigger path: page.tsx:1728-1735 (folders, via canDiscover→isDiscoverable) and 1745-1751 (documents, `canWithAclChain({... defaultAllow: true})`) both flip from allow to deny the moment library.acl exists with zero rules, while Admin/DocCtrl short-circuit at permissions.ts:18-20 and see no change. The app/DB divergence is exactly as described.

**Mechanism.** `evaluateAclChain` returns null ONLY when `!chain.some(Boolean)`. PermissionDrawer.save always writes a truthy object — `const nextAcl: AccessControl = { inherit, visibility, rules: rules.map(...) }` — so after any Save the chain has a decision, even with `rules: []`. `canWithAclChain` then returns `decision.can(action)` instead of `defaultAllow`, and `can()` requires a matching allow. With zero rules, `allowed` is empty, so `can('read')` is false for every non-Admin/DocCtrl principal. The library page filters folders with `canDiscover` and documents with `canWithAclChain({action:'read'})`, so both lists go empty. Meanwhile the DB still returns every row (visibility is 'normal'), so this is pure UI blanking with no error, no toast, no 'restricted' placeholder. The same over-strictness bites the AI layer: lib/knowledgeAccess.ts:73-76 `if (decision) { ... return decision.can("read"); }`.

**Failure scenario.** An admin opens Permissions on the Drawings library to *look* at it, changes nothing, and clicks Save. `libraries.acl` becomes `{inherit:true, visibility:'normal', rules:[]}`. Every Engineer, Drafter, Operations and Maintenance user reloads /documents/<drawings> and sees an empty library — no folders, no documents, no message. Nothing in the audit trail says 'access removed'; NODE_ACL_CHANGED logs before `{acl:null}` and after `{acl:{rules:[]}}`, which reads as a no-op. Simultaneously the AI knowledge library stops answering from those drawings for everyone but Admin/DocCtrl.

**Evidence.**

```
lib/acl.ts:170 — `if (!chain.some(Boolean)) return null;` ; lib/permissions.ts:40-41 — `if (!decision) return defaultAllow;` / `return decision.can(action);` ; lib/acl.ts:133-137 — `const can = (action) => { if (allowed.has("admin") && !denied.has("admin")) return true; if (denied.has(action)) return false; return allowed.has(action); };` ; PermissionDrawer.tsx:263-270 — `const nextAcl: AccessControl = { inherit, visibility, rules: rules.map((r) => {...}) };` with `rules` initialised from `initial.rules ?? []` (line 155).
```

> **Verifier correction.** Severity is overstated at CRITICAL: this is an availability/footgun issue, not a leak — it denies, never grants. It is also the degenerate edge of INTENDED semantics: LibraryWizard.tsx:247-273 always writes a library ACL whose rules mirror read_access, so 'a role with no matching allow rule sees nothing' is the designed behaviour; the bug is only that the zero-rule state is reachable with no warning and no 'restricted' placeholder. Reaching it requires a controller to delete every rule and hit Save.

**Done when.**

- [ ] An ACL with zero rules is treated as 'no ACL' (chain filtering drops empty-rule nodes) OR the UI refuses to save an ACL whose rule set would lock out every non-controller
- [ ] A user whose ACL evaluation returns false sees an explicit 'restricted — request access' state instead of an empty list
- [ ] The DB and the app return the SAME answer for the same (visibility, rules, principal) triple; a shared fixture test asserts app-layer `canWithAclChain` and SQL `node_visible` agree on a matrix of cases

---

<a id="dacl-7"></a>

## DACL-7 · Full-workspace export (every table + every file) is open to the Manager role, which is not an ACL controller and cannot see private documents anywhere else

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/run/route.ts:18`, `app/api/data-export/run/route.ts:74-76`, `app/api/data-export/structured/route.ts:55-58`, `lib/exportTables.ts:44`, `lib/dataExport.ts:95-96`, `lib/dataExport.ts:326-334`, `lib/permissions.ts:18-20`, `supabase/migrations/20260708_acl_rls_enforcement.sql:57-62`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. "Manager" is a real assignable role (types/schema.ts:8). The only compensating control I found is detective, not preventive, and it does not even notify the Manager tier: run/route.ts:47 `.in("role", ["Admin", "DocCtrl"])` in alertAdminsOfExport, plus a 12-runs/hour rate limit at :78-85. Neither blocks the export.

**Mechanism.** Both export routes gate on `["Admin", "Manager", "DocCtrl"]`, but the ACL model's controller tier is only Admin and DocCtrl — `isControllerRole(role) { return role === "Admin" || role === "DocCtrl"; }` and node_visible's `IF v_role IN ('Admin', 'DocCtrl') THEN RETURN true;`. The export itself runs with the service role over `ORG_SCOPED_TABLES` (which includes `"documents"`) and, with `includeFiles`, walks `document_versions.file_url` to package the actual bytes. So a Manager gets, in one ZIP, the full content of documents the ACL denies them, including genuinely private ones RLS hides from their own session.

**Failure scenario.** A plant Manager is deliberately excluded from the HR-owned incident-investigation library and from private MOC drafts. They open Admin → Data export and click Run with 'include files'. The ZIP contains every `documents` row and every referenced R2 object for the whole workspace. The compensating control fires — `alertAdminsOfExport` notifies other Admin/DocCtrl — but it is explicitly labelled detection, not prevention, and the data is already gone.

**Evidence.**

```
app/api/data-export/run/route.ts:18 — `const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];` then :74 `const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);`. app/api/data-export/structured/route.ts:57 — `if (!["Admin", "Manager", "DocCtrl"].includes(role || ""))`. lib/exportTables.ts:44 — `"documents",`. lib/dataExport.ts:329-331 — `// Document versions store file_url (the R2 key) and a recorded byte size.` / `for (const row of (tables.document_versions as Array<{ file_url?: string; size?: number }>) ?? []) { add(row.file_url, row.size ?? null); }`. The route's own comment at :137-141 concedes `This is detection, not prevention (the actor is already authorized)`.
```

> **Verifier correction.** Severity should drop to MEDIUM because the Manager tier is already effectively a controller by design elsewhere: 20260817_org_members_escalation_and_config.sql:31-41 lets Admin OR Manager UPDATE org_members and only blocks conferring *Admin* (`NOT (role = 'Admin' OR roles && ARRAY['Admin'])` OR is_org_admin), so a Manager can grant themselves DocCtrl in one PostgREST call and become an ACL controller legitimately. The export route therefore is not the weak link it appears to be; it also rate-limits (12/hour), writes export_runs, and notifies every other Admin/DocCtrl (alertAdminsOfExport).

**Done when.**

- [ ] Export is restricted to the same controller tier the ACL recognises (Admin/DocCtrl), or Manager's export is filtered through the ACL so restricted documents are excluded or redacted
- [ ] The export manifest records which rows/files were withheld from the exporter and why
- [ ] A test asserts the export role list and isControllerRole() cannot drift apart

---

<a id="dacl-8"></a>

## DACL-8 · Public verify endpoints disclose document number, title and revision status for any document UUID, with no visibility check

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:34-39`, `app/api/verify/route.ts:96-108`, `app/api/verify-hold/route.ts:29-40`, `app/api/verify-package/route.ts:39-48`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — there is no visibility check on any of the three routes. But MEDIUM overstates it: these are deliberately unauthenticated QR endpoints (documented at verify/route.ts:3-13 and verify-package/route.ts:3-9), the response is metadata only (no file, no URL, no people — verify-hold:50-54 explicitly withholds notes and staff names), and every route hard-gates on a UUID_RE match plus a record_id/document cross-check (verify/route.ts:60-63). The marginal disclosure to someone who already holds the UUID is document number, title and rev status. LOW.

**Mechanism.** All three run the service role, are unauthenticated by design, and treat 'you hold a UUID' as authorization. None checks `documents.visibility`, acl_index, or org. /api/verify additionally accepts `doc` with no `v` (`if (!UUID_RE.test(docId) || (versionId && !UUID_RE.test(versionId)))`), so a document id alone is sufficient. verify-package expands one package UUID into `document_id`s and then `documents.select("id, document_number, title, name, rev, current_version_id, status")` for all of them.

**Failure scenario.** An org member who is denied read on a private document obtains its UUID from document_assets, or an outsider obtains one from /d/[number]. `GET /api/verify?doc=<uuid>` returns its number, title, current rev and status. For a package, one work-package UUID (printed on a traveler sheet that leaves the site with a contractor) enumerates the number and title of every document in it, including any the contractor was never issued.

**Evidence.**

```
app/api/verify/route.ts:5-10 asserts the threat model — `UNAUTHENTICATED by design ... Both IDs are unguessable UUIDs that only appear ON a printed copy the org itself issued.` The code at :34-39 selects and returns without any visibility predicate. verify-package/route.ts:48 — `? await sb.from("documents").select("id, document_number, title, name, rev, current_version_id, status").in("id", docIds)`.
```

> **Verifier correction.** 'for any document UUID' applies only to /api/verify. /api/verify-hold is keyed on a HOLD uuid (route.ts:21-31) and deliberately withholds notes and staff names (:50-54 comment and payload), and /api/verify-package is keyed on a PACKAGE uuid — both are still unauthenticated and org-unscoped, but neither turns an arbitrary document UUID into metadata. Severity MEDIUM is right: the exposure is revision-status metadata only, no files, no URLs.

**Done when.**

- [ ] Verify surfaces refuse documents whose visibility is private/hidden, or answer only 'current / superseded' without the title for them
- [ ] Verification is keyed to a per-print token recorded at stamping time rather than to the durable document UUID
- [ ] verify-package returns only documents that were actually issued in that package's distribution

---

<a id="dacl-9"></a>

## DACL-9 · The client-side ACL filter evaluates a truncated chain when an ancestor folder's row was hidden by RLS, then falls back to allow

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/documents/[libraryId]/page.tsx:1668-1696`, `app/(protected)/documents/[libraryId]/page.tsx:1745-1751`, `lib/acl.ts:176-193`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves reproduce by reading the code. The inherit-flag bug is a genuine off-by-one in scope: `inherit:false` on a node should clear its ANCESTORS' rules (which it does correctly on that node's own iteration) but the false value is then carried into the next node and clears that node's inherited set again, dropping the restricting node's own rules. Fails open in both cases.

**Mechanism.** `buildFolderChain` resolves ancestors through `folderMap.get(id)` — a map built only from the `collections` rows the browser actually received. `collections_acl_select` hides a private folder the user has no grant on, so that ancestor is missing from folderMap and its ACL is simply omitted from the chain. If the resulting chain is all-empty, `evaluateAclChain` returns null and `canWithAclChain({... defaultAllow: true})` returns TRUE. The same function also pushes `library.acl` twice for a document (`buildDocChain` pushes it, then calls `buildFolderChain`, which pushes it again), which matters because `evaluateAclChain` RESETS the merged rule set whenever a node has `inherit === false`.

**Failure scenario.** Folder A (private, no grant for this user) contains subfolder B (normal, inherits). The user can see B's row but not A's. Opening B, the doc chain is [library.acl, B.acl] — A's restriction is gone — so every document in B renders. Separately, a library ACL with `inherit:false` gets its rules dropped and re-added by the duplicate push, so the reset semantics do not behave as written.

**Evidence.**

```
app/(protected)/documents/[libraryId]/page.tsx:1673-1678 — `if (folder?.pathIds?.length) { for (const id of folder.pathIds) { const node = folderMap.get(id); if (node?.acl) chain.push(node.acl); } }` — a missing node contributes nothing. :1683-1690 — `if (library?.acl) chain.push(library.acl); if (docRecord?.collectionId) { const folder = folderMap.get(docRecord.collectionId); chain.push(...buildFolderChain(folder)); }` and buildFolderChain itself begins `if (library?.acl) chain.push(library.acl);`. lib/acl.ts:181-184 — `if (!inherit || !nodeInherit) { mergedRules = []; visibility = "normal"; }`.
```

> **Verifier correction.** Two adjustments. (1) The double-push of library.acl is real but SECURITY-INERT: evaluateAclChain's reset (lib/acl.ts:181-184) plus set-based allow/deny accumulation makes a repeated identical ACL idempotent — [lib, lib, folder] and [lib, folder] produce the same decision for every combination of inherit flags. Report it as a code-hygiene bug, not a mechanism. (2) The leak is broader than the all-empty-chain case the finding describes: ANY missing ancestor ACL is silently dropped from the chain, so a restrictive folder ACL is skipped even when the library ACL is present and grants read — the user then passes on the library's grant alone. Downgrading to MEDIUM only because it is the client-side mirror of finding 1, which is the same exposure at the enforcing layer.

**Done when.**

- [ ] The ACL decision is made server-side against the true chain (this disappears once finding 1 is fixed at the DB), or the client refuses to render children whose ancestry it could not fully resolve
- [ ] buildDocChain no longer double-pushes library.acl
- [ ] A test covers 'hidden ancestor, visible descendant' and asserts the descendant is NOT shown

---

<a id="dacl-10"></a>

## DACL-10 · The library detail page performs no read-access check — a direct URL bypasses the read_access/visible_to gate that hides the library on the home page

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/documents/page.tsx:43-51`, `app/(protected)/documents/page.tsx:155-167`, `app/(protected)/documents/[libraryId]/page.tsx:1434-1450`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search: read_access / visible_to appear in no RLS policy in supabase/migrations (grep over *.sql returns only unrelated `project_visible_to_me` hits), and (protected)/layout.tsx enforces only auth + org membership. So the columns are a home-page display filter with no server-side or route-level backing.

**Mechanism.** The library HOME page hides libraries with a legacy role-array model: `computeCanRead` checks `readAccess === "ALL"` else `readList.includes(role) || visibleTo.includes(role)`, and `const visible = isController ? libs : libs.filter((l) => l._canRead)`. The library DETAIL page loads the library by id and validates only that `data.org_id === activeOrgId` — it never calls computeCanRead, never consults `read_access`/`visible_to`, and there is no RLS policy on `libraries` at all (`grep -rn "ON libraries" supabase/migrations/*.sql` returns only two CREATE INDEX lines; `grep -rn "node_visible" supabase/migrations/*.sql` shows it attached to documents, collections, document_sets and document_versions only). Documents inside are then filtered only by `library.acl`, which is a DIFFERENT, unrelated model from read_access.

**Failure scenario.** HR's 'Personnel & Incident' library is configured `read_access: ['HR','Admin']`. A Maintenance user does not see the card at /documents. They paste /documents/<libraryUuid> (from a colleague's link, a notification, a bookmark, or the graph's library node href). The page renders the library, its folders and its documents — because `library.acl` is null, `canWithAclChain(..., defaultAllow: true)` returns true for every row.

**Evidence.**

```
app/(protected)/documents/page.tsx:165 — `const visible = isController ? libs : libs.filter((l) => l._canRead);`. app/(protected)/documents/[libraryId]/page.tsx:1449 — the only gate is `if (data.org_id && data.org_id !== activeOrgId) { setLibrary(null); setError("Library does not belong to active workspace."); return; }`. `grep -rn "computeCanRead|computeIsPublicRead" --include=*.ts --include=*.tsx .` returns matches ONLY inside app/(protected)/documents/page.tsx — the function exists on one screen.
```

> **Verifier correction.** The impact is narrower than 'documents inside are then filtered by a DIFFERENT, unrelated model'. LibraryWizard.tsx:247-275 — the ONLY writer of read_access, used for both create and edit — derives the library ACL from the same viewRoles it writes into read_access/visible_to, so for any wizard-managed library the ACL chain re-imposes the same restriction on the detail page (filteredDocs and filteredFolders both go empty for a non-granted role). What actually leaks through the direct URL is the library shell and its metadata (name, description, custom columns, folder-security config), plus full document read for any legacy/hand-edited row that has restricted read_access with acl = null. lib/libraryCollections.ts:126-137 (Save-As) writes acl: null but read_access: 'ALL', so it cannot produce that pair on its own.

**Done when.**

- [ ] Either read_access/visible_to are retired in favour of libraries.acl (one model), or the detail page enforces the same predicate the home page uses AND a RESTRICTIVE RLS policy enforces it on `libraries`
- [ ] A user without library read access lands on an explicit 'you don't have access to this library' page, not a populated one
- [ ] No screen re-implements a library read check locally

---

<a id="dacl-11"></a>

## DACL-11 · document_assets and project_documents are readable by every org member with no ACL predicate, leaking the existence and UUID of every restricted drawing

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260609_phase1_normalization.sql:185-197`, `lib/impact.ts:66-72`, `lib/orgGraph.ts:119-122`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed the claim of absence with a repo-wide grep of supabase/migrations for document_assets/project_documents policies — the only other hit is CATCHUP_2026-05-28.sql:468-479, which creates the same membership-only policies. Both tables carry document_id, so any active member can enumerate the UUIDs and tag↔document mappings of documents whose `documents` rows RLS hides.

**Mechanism.** Both tables are gated by a single permissive FOR ALL policy testing active org membership only. They carry `document_id` (plus `tag_text` on document_assets). No RESTRICTIVE overlay analogous to `documents_acl_select`/`document_versions_acl_select` was ever added — the 20260813 migration that closed that gap covered document_versions, document_sets and projects, but not these join tables. So even for a genuinely private document (where the `documents` row IS hidden), the join rows disclose that a document exists, which equipment tags are on it, and its UUID.

**Failure scenario.** A Contractor cannot see the private 'Unit 200 Debottleneck' P&IDs. They query `document_assets` for `asset_id` of E-204 and get five document UUIDs whose `documents` rows are invisible. The mere tag↔document mapping is itself sensitive (it reveals that undisclosed work exists on that exchanger), and the UUIDs are the missing input for the share-link mint described in the document_shares finding.

**Evidence.**

```
20260609_phase1_normalization.sql:187-190 — `CREATE POLICY "document_assets_member_all" ON document_assets FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_assets.org_id AND uid = auth.uid() AND status = 'active')) WITH CHECK (<same>);` — no document predicate. Contrast supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:42-45 which does exactly this for document_versions via `doc_is_visible(record_id)`.
```

> **Verifier correction.** Keep MEDIUM. Note the practical exposure is currently small for a second reason: per finding 1 almost nothing ends up with private visibility in the first place, so today this mostly matters as the gap that will open the moment private documents are actually used.

**Done when.**

- [ ] `document_assets`, `project_documents`, `document_related_resources`, `document_supersessions` and `entity_mentions` each carry a RESTRICTIVE SELECT policy `USING (doc_is_visible(document_id))` (and the second document column where present)
- [ ] Existence-only surfaces (impact panel counts, graph degree) do not silently reveal hidden nodes through edge counts

---

<a id="dacl-12"></a>

## DACL-12 · node_visible() honours only USER-scoped deny rules and treats an allow grant of ANY action as permission to read — a role- or team-scoped 'deny read' does not bind at the database

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260708_acl_rls_enforcement.sql:69-80`, `supabase/migrations/20260708_acl_rls_enforcement.sql:21-39`, `lib/acl.ts:100-119`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both defects are visible in the same function and the migration comment at :78 concedes the second one ("finer read-vs-discover distinctions stay in the app layer"), which is precisely why a PostgREST-direct read escapes them. The role/team deny omission is not documented anywhere and looks unintentional.

**Mechanism.** The SQL only inspects two paths in the deny bucket: `(p_acl_index->'deny'->'users'->'read') ? v_uid OR (p_acl_index->'deny'->'users'->'discover') ? v_uid`. Deny rules whose subject is a ROLE or a TEAM are never consulted. It then returns `acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams)`, and that helper bool_ORs across EVERY action list in the allow bucket, so a grant of `upload` alone — or `discover` alone — satisfies a read. The app engine does the opposite: `evaluateRules` collects denies from any subject type and then `for (const a of denied) { if (allowed.has(a)) allowed.delete(a); }`, and `can(action)` requires that exact action. The two layers therefore disagree about the same rule set.

**Failure scenario.** A private 'Executive MOC' folder grants `allow discover` to role Operations (so the folder name shows) and `deny read` to role Operations (so the contents do not). In the UI that works. Via PostgREST it does not: node_visible skips the role-scoped deny, finds 'Operations' in `allow.discover`, and returns true — every Operations user can SELECT the rows, and through doc_is_visible their `document_versions.file_url` too.

**Evidence.**

```
20260708_acl_rls_enforcement.sql:69-73 — `-- Explicit deny of read/discover wins.` / `IF (p_acl_index->'deny'->'users'->'read') ? v_uid` / `OR (p_acl_index->'deny'->'users'->'discover') ? v_uid THEN` / `RETURN false;` — no roles/teams branch. :78-80 — `-- Any allow grant (any action) lets the row through; finer read-vs-` / `-- discover distinctions stay in the app layer.` / `RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams);`. lib/acl.ts:108-110 — `for (const a of denied) { if (allowed.has(a)) allowed.delete(a); }`.
```

> **Verifier correction.** HIGH overstates the reach. The gap only opens on a row whose visibility is already private/hidden AND where the same principal holds some allow grant, i.e. a mixed allow-role / deny-team configuration; a plain deny with no allow still fails the final `acl_subject_in_bucket` and the row stays hidden. The allow-any-action half is explicitly documented as intentional at :78-79 ('finer read-vs-discover distinctions stay in the app layer'); the missing role/team deny branch is the genuinely undocumented defect.

**Done when.**

- [ ] node_visible evaluates deny for user, role AND team subjects before any allow
- [ ] The allow test is per-action ('read' or 'discover' as appropriate), not bool_or across every action list
- [ ] A SQL-level test matrix mirrors lib/__tests__/acl.test.ts so the two engines are proven to agree

---
