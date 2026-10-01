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

**Partial (2026-09-30, intelligence Round G).** Planned as a record-only close on roles-and-permissions `DB-4` + `DOCACL-4` + `OWN-20` (`DEC-10`). Re-verified against HEAD `1b71ca1`, it does **not** close: those findings made `acl_index` a maintained cache, but this finding's first sentence — `node_visible()` short-circuits on `visibility='normal'` — is unchanged in the newest body, and nothing carries a container's restriction into its children's `visibility`.

**Done-when.**
1. ✗ Restricting a folder does not hide its child documents from a direct PostgREST read. `node_visible` (6-arg; newest body `20261041_rp_phase5_node_visible_additive.sql:23-85`, live) still opens with `IF p_visibility IS NULL OR p_visibility = 'normal' THEN RETURN true;` (`:37-40`, "Fail-safe ordering is preserved"), and `documents_acl_select` passes the row's OWN `visibility` (`20261037_rp_phase3b_read_ownership_and_version_integrity.sql:109-111`, live). The drawer's "Restrict" writes `visibility` to the edited node only (`components/permissions/PermissionDrawer.tsx:310`, `.eq("id", nodeId)` at `:315`); the rebuilds write `acl_index` only (`lib/aclIndexRebuild.ts:163`, `lib/serverCollections.ts:135`, `:149`); a new document is stamped from the LIBRARY default, not its folder (`app/(protected)/documents/[libraryId]/page.tsx:2559`, `library.defaultNewVisibility ?? "normal"` — R&P `DOCACL-2` records per-node visibility as a design residual). So the child keeps `visibility='normal'`, `node_visible` returns true before it reads the (now correct) `acl_index`, and the rows come back. Mitigation that exists: a library born "Restricted" (`DOCACL-2`'s `defaultNewVisibility`) stamps its new children hidden.
2. ◐ `node_visible` still trusts the per-row `acl_index`, but "an acl_index that no writer maintains" no longer describes it: the index is rebuilt from the live chain at save (`OWN-20`: the drawer's checked save POSTs `/api/acl/rebuild`, `PermissionDrawer.tsx:347` → `rebuildAclIndexes(…, { orgId, libraryId })`, `app/api/acl/rebuild/route.ts:114`), on a folder move (`DOCACL-4`: `app/api/collections/move/route.ts:94-100` → `rebuildSubtreeAclIndex`, `lib/serverCollections.ts:116-152`) and nightly (`DB-4`: `app/api/cron/maintenance/route.ts:161`). The chain is resolved into the index by its writers, not at read time — `DEC-10`'s choice (a rebuilt cache; the derived column deferred). That half closes on DEC-10; it does not reach a `normal` row (criterion 1).
3. ◐ `acl_index` stays in sync when a folder's or library's ACL changes (at save) and when a FOLDER moves; a DOCUMENT moved between folders is not re-indexed at move time — `app/api/documents/move/route.ts:98-101` updates `collection_id` only — and waits for the nightly rebuild (`DEC-10`'s one-cycle window). `visibility` is never synced.

**Remaining / owner.** Criterion 1 (and the read-time half of 2) is the one-predicate question `IEDGE-12` carries — "a normal-visibility document carrying an explicit read deny is refused by every path … node_visible" — and belongs to I-12 (DOCUMENT ACL BOUNDARY), which already plans the `node_visible` re-creation for `DACL-12`. I-12's plan lists "DEC-10 acl_index cache + nightly rebuild (DACL-1 closed on it)" as verified sound; for criterion 1 this re-verification says otherwise, so criterion 1 is not in I-12's plan today — the integrator adds it. The decision it needs is `DOCACL-2`'s — whether a restricted container restricts its `normal` children at the database (the app's chain evaluation already does), weighed against the lockout the fail-safe default exists to avoid. The document-move re-index (criterion 3) is in no fleet plan; the nightly rebuild bounds it, and the owner named here is the same I-12 (it is `acl_index` maintenance on the document ACL boundary), for the integrator to confirm. The download step of the failure scenario is `KACL-5`'s (also I-12).

---

<a id="dacl-2"></a>

## DACL-2 · /api/storage/delete permanently destroys R2 objects with only an org-membership check — no ACL, no controller role, no legal-hold guard, and (uniquely) no storage-key validation

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Partial (2026-09-30, intelligence Round G).** Planned as a record-only close on roles-and-permissions [`SURF-2`](../roles-and-permissions/09-non-document-surfaces.md) (whose record names this finding). Re-verified against `app/api/storage/delete/route.ts` at HEAD `1b71ca1`: criteria 2 and 3 hold; criterion 1 does not — its retention limb is missing, and its legal-hold limb covers a version's rendered file (`file_url`) but not its native source file (`source_file_key`) — so this stays OPEN. *(Corrected on the package's fix pass 3: the first recording said criterion 1 held apart from retention, missing the source-key limb.)*

**Done-when.**
1. ◐ The route resolves a key to its `document_versions` row (`:76-88`, `.eq("file_url", path)`) and refuses `423` when the document is under legal hold (`:95-97`) or has an unreleased `document_holds` row (`:98-100`), failing closed `503` on any lookup error (`:102-104`); the caller must be a controller of the key's org read from the role collection (`:52-70`) — stricter than "an admin/write grant on it". **Not done: the legal-hold limb for a version's native source file.** The lookup matches `file_url` only (`:79-84`). A revision's native source (the DWG or other source upload) is stored under `orgs/<org>/libraries/…` (`lib/revisions.ts:504-510`, `makeLibraryStoragePath` → `uploadToPath`) and recorded in `document_versions.source_file_key` (`lib/revisions.ts:528`), so it passes the org-prefix gate (`:46`); for that key `ver` is null, `documentId` stays null, the `legal_hold` and `document_holds` checks (`:86-101`) never run, and the route writes its custody row and destroys the bytes with a 200 — a controller (or a compromised controller session) can destroy a held P&ID's native source. The sibling `upload-url` route already resolves both columns (`app/api/storage/upload-url/route.ts:60`, `for (const col of ["file_url", "source_file_key"])`). Reproduced against the real route: `lib/__tests__/intelRoundGRecords.test.ts` "DACL-2 criterion 1 …" — a controller (Requester + DocCtrl) deletes one revision's two keys under a filter-aware stand-in; for a document held by `legal_hold`, and again by an unreleased `document_holds` row, the rendered file answers `423` with nothing sent and the native source answers `200` after `DeleteObject`. Both cases are `it.fails`; a scratch two-column lookup in the route flipped both, and `storageDeleteRoute.test.ts` stayed green under it (its stand-in answers every `document_versions` read with the row whatever the filter, which is why SURF-2's tests could not see this limb). **Not done: "inside retention".** Nothing reads `retention_until` or `disposition_state`: a controller can destroy the bytes of a document whose retention period has not run (and is not under hold) and gets a 200. Ticket attachments are not resolved to their ticket; they carry no hold or retention state and the controller gate still applies.
2. ✓ `assertSafeStorageKey(path)` runs before the org-prefix parse (`:41`); a non-org key is refused (`:46-49`).
3. ✓ A `STORAGE_OBJECT_DELETE` audit row naming the key, the document, the version and the actor is written BEFORE the object is destroyed, and the delete is refused if it cannot be written (`:113-129`); a failed R2 delete marks the row (`:131-143`). Tests: `lib/__tests__/storageDeleteRoute.test.ts` (SURF-2).

**Remaining / owner.** Two limbs of criterion 1, one fix site. (a) Resolve the key against BOTH `file_url` and `source_file_key` before any refusal — two exact-equality lookups, as `upload-url` does (`:60`), never a PostgREST `.or()` string (`assertSafeStorageKey` admits commas and parentheses) — failing closed on either lookup's error, so a held document's native source is refused `423` exactly like its rendered file. (b) The retention refusal: resolve the document's effective `retention_until` / `disposition_state` and refuse while it is in the future, fail-closed like the hold check, for a key matched on either column. Owner named: document-control's retention rail — the follow-up to **P9 RECORDS** (retention, legal-hold records), whose `RET-2` (`08-retention.md`) recorded this route closed on SURF-2 without either limb (cross-note added there; roles-and-permissions `SURF-2`'s criterion 3 is flagged for the source-key limb by a cross-note too). No document-control package lists `app/api/storage/delete/route.ts` today, so the integrator adds both limbs to that follow-up; neither is scheduled until then. *Integrator (2026-10-01, at the I-01A merge): both limbs are now the document-control fleet plan's package **P11 STORAGE-DELETE** (`audit-reports/fleet-plans/document-control.json`), which owns the route, its test and the two tripwire flips.* Landing (a) makes the two `it.fails` above fail the suite (a deliberate tripwire), so that package also flips them to `it` in `lib/__tests__/intelRoundGRecords.test.ts` — the only edit that file needs.

**Resolution (2026-10-01, document-control Round F wave 2).** Package **P11 STORAGE-DELETE** landed both limbs of criterion 1 at the one fix site, `app/api/storage/delete/route.ts`; no migration. (a) **The native source file.** The key is resolved against BOTH `document_versions.file_url` and `document_versions.source_file_key` (`:126-136`). These are two exact-equality lookups, `for (const col of ["file_url", "source_file_key"] as const) … .eq(col, path)`, the pattern `app/api/storage/upload-url/route.ts:60` uses, never a PostgREST `.or()` string. Either lookup's error refuses `503` (`:132`, `:225-227`). Every document that names the key in either column is collected and checked, not only the first match (`:137-141`), so a key shared by two documents' revisions is refused when either is held. A held document's native source now answers `423` exactly like its rendered file (`:149-154`). A cleared source key's `STORAGE_OBJECT_DELETE` custody row names its document and revision (`resource_id`, `details.documentId` / `versionId`); before, it named only the path. (b) **Inside the EFFECTIVE retention.** The documents read now selects the hold and retention columns plus the policy inputs (`OWNER_DOC_COLUMNS`, `:41-42`, read at `:143`). The route refuses `423` when EITHER of two readings says retention is in force (`:155-223`): (1) the materialized `retention_until` / `disposition_state`, read through the one shared verdict `retentionStatusFor` (`:184-188`; "active" is a period that has not run, and an unparseable date also reads as active); (2) the effective retention, resolved at request time from the document → folder → library policy by P9 RECORDS' pure resolver (`resolveEffectiveRetentionPolicy` + `retentionBasisISO` + `computeRetentionUntil`, imported from `lib/retentionPolicy.ts`, `:6-8`, used at `:193-203`), the same rules `recomputeRetention` and `reclockRetentionForDocs` clock with. A computed date after today is in force (`:207-209`): the re-clock's "active", so a date that runs out today is clear here as it is eligible there. A policy in force whose date cannot be computed also refuses: no readable basis date, or a year past 9999. Past year 9999 `computeRetentionUntil`'s `toISOString()` gives an extended-year string (`+012025-…`), which sorts before every ISO date and which P9's re-clock cannot store in the DATE column (the row stays unclocked), so only a four-digit-year date counts as computed (`ISO_DATE`, `:44-50`, applied at `:204`). Reading (2) is needed because P9 writes the materialized columns best-effort: `lib/revisions.ts:395` and `lib/postPublish.ts:219` swallow recompute errors, and `setRetentionPolicy` re-clocks covered documents from an unchecked, unpaged select (`lib/retention.ts:123-127`), so PostgREST's row cap and one refused batch both leave rows unclocked. A row that was never clocked under an in-force policy, or carries a stale, already-run date after the policy was extended, therefore no longer reads as clear. **A `disposed` record is not exempt** (`:171-182`, `:184-188`, `:205-209`). `disposeDocument` (`lib/retention.ts:216-256`) checks no eligibility, the database guard refuses disposal only under a hold, and the only eligibility gate is the Dispose button's client-side `eligible && !hold.on` (`components/documents/RetentionSection.tsx:177`). Exempting every disposed record would have made the refusal bypassable in two steps: one Dispose click on a stale-`eligible` row the route refuses, then the delete. `disposeDocument` leaves `retention_until`, `created_at` and `effective_date` as they were but rewrites `updated_at`, so a disposed record is judged on (1) its stored `retention_until` alone (its `disposed` state no longer reads as clear), and on (2) only when its policy clocks from a basis disposal cannot move: `created`, or `effective` with an `effective_date` (`basisFixed`, `:206`). The `issued` / `superseded` / effective-without-a-date bases clock from `updated_at`, which disposal resets to today, so for those a disposed record is judged on its stored date only. The folder and library policies are read CHECKED (`containerRetentionPolicy`, `:52-60`, called at `:189-192`). Either read failing refuses `503`, as a documents or `document_holds` read error does. `retentionStatusFor` moved verbatim from `lib/retention.ts` into the pure `lib/retentionPolicy.ts` (`:29-47`), and `lib/retention.ts` re-exports it (`:28-33`). That lets the route use the register's and the pill's verdict, and P9's resolver, without importing the browser client. The date arithmetic and the inheritance rule are not copied into the route. A record whose stored and effective retention have both run is not refused, disposed or not. A record the scan flagged `eligible` before its policy was extended IS refused, and so is that record after it is disposed. The hold refusal is checked first, so a held record inside retention answers as a hold. When both readings are in force, the refusal names the later date, and it quotes only a four-digit-year date. Tests: `lib/__tests__/storageDeleteRoute.test.ts` now uses a filter-aware stand-in (`.eq` / `.is` / `.in` / `.limit` applied to in-memory rows); the old filter-blind stand-in is why SURF-2's tests could not see limb (a). It has 48 cases, 39 of them new: a released-hold case plus 38 DACL-2 cases, 10 for limb (a) and 28 for limb (b). Limb (a): both held kinds refuse the native source `423` with nothing sent and no custody row; both columns are read by exact equality with no `.or()`; a comma-and-parentheses key still resolves; each lookup's error, and a documents or holds read error on a source key, refuses `503`; every owning document is checked; and a clear source key is deleted with its document on the custody row. Limb (b), stored reading (8): a future `retention_until` refuses both keys `423` and names the date; run-out, `eligible` and `disposed` records whose date has run do not refuse; an unparseable date refuses; a legal hold inside retention answers as a hold; and the identity case below. Limb (b), effective reading (14): an unclocked row (both columns NULL) under an in-force library policy refuses both keys `423` and names the computed date; a stale run-out row under an extended policy refuses; a stale `eligible` row refuses; a folder policy refuses with no library policy; a defined-but-disabled folder policy stops inheritance, with a non-vacuous control; the document's own policy wins both ways; an effective retention that has run does not refuse; a policy in force with no readable basis date refuses, while a policy with no length does not; a `libraries` or a `collections` policy read error each refuses `503` with nothing sent and no custody row; the policies are read by the document's own folder and library ids; the in-force boundary (on a fixed clock, a ten-year `created` policy whose date is today does not refuse and one whose date is tomorrow refuses `423`, naming it); and a 9999-year policy (a "permanent" sentinel) refuses both keys `423` with nothing sent, no custody row and no extended-year date quoted, while a length so long that the date arithmetic throws is refused too (`503`). Limb (b), disposed records (6): a disposed record whose stored date has not run refuses `423` and names it, and one whose date has run is deleted; a disposed record under an in-force policy refuses (the first fix pass pinned this case as a `200`); the two-step bypass, a stale `eligible` row refused before and after it is disposed, and an unclocked disposed row under a 9999-year policy; an `effective` basis with an `effective_date` refuses while in force; a disposed record whose stored and effective retention have both run is deleted; and a basis disposal resets (`issued`, or `effective` without a date) is not re-clocked from the disposal, with an undisposed control that is refused. The identity case checks that the route imports `retentionStatusFor`, `resolveEffectiveRetentionPolicy`, `computeRetentionUntil` and `retentionBasisISO` from `lib/retentionPolicy`; the first three are the same function objects `lib/retention` exports (`retentionBasisISO` is not re-exported there, so for it only the import line is pinned). It also checks that the route contains no `setFullYear` (no second copy of the date arithmetic) and imports neither `@/lib/supabase` nor `@/lib/retention`. 32 of the 39 new cases failed against the pre-fix route at `abbee22`. The 7 that pass there are controls: the released hold, the `file_url` lookup error, and the five "does not refuse" cases (run-out, `eligible` and `disposed` on the stored date, the run-out effective retention, and the disposed record whose stored and effective retention have both run). Against the first fix pass's route (`f925eef`), 5 of the 8 cases this pass added fail: the 9999-year case and four of the disposed-record cases; the boundary case and the two disposed controls pass there and pin the behaviour. A mutation run against the final route (`>` to `>=`, the ISO guard dropped, `basisFixed` forced either way, its `effective_date` limb dropped or loosened, the stored reading exempting `disposed` again, and the old blanket disposed exemption) fails at least one case each. The two DACL-2 `it.fails` in `lib/__tests__/intelRoundGRecords.test.ts` are now `it`, and their plain `control:` twins are kept. That file's header and block comments, which still described the bypass as current, now say it held until P11. The tripwire was confirmed before the flip: with the fix in place and the file unflipped, both tests failed the suite. *(Corrected on the package's fix passes. The first recording read only the materialized columns, called that "not a second resolver", and listed effective retention for unclocked or stale rows as residual (iii) while marking Done-when 1 met. It also counted "28 cases, 18 of them new; 14 of the 18 failed" where the file then had 19 new cases, 14 of which failed. The first fix pass exempted every `disposed` record from both readings, compared the computed date as a string without checking its shape (a 9999-year policy read as run and answered `200`), left the `>` boundary unpinned, and said all three resolver functions are the same objects `lib/retention` exports; the second fix pass corrected each.)*

**Done-when.**
1. ✓ The route resolves the key to its owning `document_versions` row in either column, the rendered file or the native source. It refuses `423` when that document is under legal hold or an unreleased hold, or when it is inside its retention period by the stored date or by its effective policy, including a policy whose computed date passes year 9999, and including a record already disposed (on its stored date, and on its effective date where disposal cannot move the basis). It refuses `503` when any of those reads fails. The caller must still be a controller of the key's org, read from the role collection (`:92-110`), which is stricter than "an admin/write grant on it". Ticket attachments are not resolved to their ticket: tickets have no hold or retention column (`legal_hold` / `retention_until` / `disposition_state` / `retention_policy` exist on `documents`, `collections` and `libraries` only, `20260820_retention.sql:19-35`), so there is nothing to refuse on, and the controller gate still applies.
2. ✓ `assertSafeStorageKey(path)` runs before the org-prefix parse (`:81`), and a non-org key is refused (`:86-89`). Unchanged.
3. ✓ A `STORAGE_OBJECT_DELETE` custody row naming the key, the document, the version and the actor is written BEFORE destruction, and the delete is refused if it cannot be written (`:229-252`). A failed R2 delete marks the row (`:254-267`). A source key's row now names its document as well.

**Scope / residual.** Only what DACL-2 criterion 1 names; no migration (DEC-30 not engaged). Not done here, each outside this finding: (i) document-control `RET-2`'s second Done-when also asks that a key be refused when "its row is the current revision". The route still has no current-revision refusal, so RET-2 is demoted to OPEN with a Partial block naming that limb (see `08-retention.md`). (ii) The project-level legal hold (`projects.legal_hold`, `20261103_prj_roundG_project_closeout_rails.sql:136`) guards cost and quality ROWS, but this route does not resolve project-area keys (for example `cost_documents.file_url`) to their project. A controller can still destroy a held project's cost-document bytes here. That is the projects area's QUAL-3 rail, not a DACL-2 limb. It is noted for the integrator and no finding is opened here. (iii) The effective reading follows P9's resolver exactly: the document's own policy, then its immediate folder (`collection_id`), then the library. It does not walk ancestor folders, because `recomputeRetention` and `reclockRetentionForDocs` do not either. If P9's inheritance rule changes, the route picks the change up through the shared functions. (iv) `retentionStatusFor` / `RetentionStatus` now live in `lib/retentionPolicy.ts`, a P9 RECORDS file. The move is recorded in the P11 Partial block on `RET-2`, and the identity test in `storageDeleteRoute.test.ts` is the tripwire against a drifting second copy. It catches a second definition, not a semantic change to the shared verdict; the document-control fleet plan still lists `lib/retentionPolicy.ts` and `lib/retention.ts` under P9 only, and the integrator may add both to P11 with a "moved verbatim from P9" note. (v) **For the integrator, P9 RECORDS' root causes, which the route guards against but does not fix.** `computeRetentionUntil` (`lib/retentionPolicy.ts:21-27`) and the policy editor (`components/documents/RetentionPolicyModal.tsx:86`, `min={1}` with no maximum) accept any length. A length that passes year 9999 (about 7974 years or more on a 2026 basis, a common "permanent" sentinel being 9999) yields an extended-year string that `recomputeRetention` cannot store, so the register and the pill show such a record as unclocked. A length of about 274,000 years or more makes `toISOString()` throw, which this route answers `503`. The fix is a bound on `years` in the editor and in `computeRetentionUntil`, or a first-class "permanent" policy. Separately, `disposeDocument` (`lib/retention.ts:216-256`) has no eligibility check, so a record can be disposed before its retention runs. This route now refuses such a record on its stored date and, for the `created` basis or `effective` with a date, on its effective date. For a policy that clocks from `updated_at` (`issued`, `superseded`, `effective` without a date), disposal rewrites `updated_at`, so a disposed record whose stored date is a stale run-out one, never re-clocked after the policy was extended, is still deletable here. Closing that needs P9 to gate `disposeDocument` on eligibility (the effective date, not the stored state), or to stop disposal rewriting the basis. No finding is opened here; both are on the integrator's list for P9 RECORDS / `RET-2`.

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

**Partial (2026-09-30, intelligence Round G).** Planned as a record-only close on roles-and-permissions [`EGRESS-2`](../roles-and-permissions/10-content-egress.md). Re-verified at HEAD `1b71ca1`: criteria 1 and 2 hold; criterion 3 is the `/api/verify` half, which EGRESS-2 did not touch, so this stays OPEN.

**Done-when.**
1. ✓ `/d/[number]` does no database work and holds no service-role client (`app/d/[number]/route.ts:20-32`); it forwards the raw string to `/documents?d=…`, where the protected page resolves it client-side under the caller's own session (`app/(protected)/documents/page.tsx:101-108`, `searchDocuments({ orgId: activeOrgId, … })`) — scoped to the active org and subject to RLS (`documents_acl_select` → `node_visible`, which for a `normal`-visibility child of a restricted folder is `DACL-1`'s gap, above); a signed-out caller is sent to sign-in by the protected layout. Test: `lib/__tests__/shortLinkRoute.test.ts`.
2. ✓ Every input gets the same redirect (`/documents`, with `?d=` only for a 2–40-character normalized string, `:26-31`) and no lookup is made, so a non-match and a cross-org match are indistinguishable in response and in timing.
3. ✗ `/api/verify` still accepts `doc` alone (`app/api/verify/route.ts:27-31`, `(versionId && !UUID_RE.test(versionId))`), selects the document by id with no visibility, ACL or org predicate (`:35-39`) and returns its number and title (`:145-146`); no per-print token exists. The oracle that fed it UUIDs is gone (criterion 1), which removes the unauthenticated enumeration path the failure scenario uses; a UUID obtained elsewhere still yields number, title and status.

**Remaining / owner.** Criterion 3 → public-surfaces **PS-VERIFY** (owns the four verify endpoints: `VFY-2` / `VFY-3` per-print semantics, `VFY-14` narrow select). It is the same limb as `DACL-8` criteria 1–2 and is handed over there with the default (answer "current / superseded" without number or title for a private or hidden document). Cross-note added on `VFY-14`; PS-VERIFY's plan does not list it yet, and the integrator adds it with DACL-8's.

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

**Partial (2026-09-30, intelligence Round G).** Planned as record-only: halves 1 / 2a on roles-and-permissions [`EGRESS-1`](../roles-and-permissions/10-content-egress.md) (`20261022`, `20261026`, `20261037` live), halves 2b / 3 on document-control wave-2 **P1 SHARE** (`DRLS-5`, `DIST-6`, `EGR-5`, `DEC-46`), which is merged on this base. Re-verified against HEAD `1b71ca1`: criterion 1 holds; criterion 2 misses two limbs P1 did not build; criterion 3 holds through `createShareLink` and the UI but not at the database until `20261080` is applied — so this stays OPEN.

**Done-when.**
1. ✓ The INSERT policy requires the inserter to pass the same read predicate as `documents` SELECT, in the share's own org, as themselves: `document_shares_insert` (`20261037_rp_phase3b_read_ownership_and_version_integrity.sql:120-135`, live) — `created_by = auth.uid()`, active membership, and `EXISTS (… d.org_id = document_shares.org_id AND node_visible(d.visibility, d.acl_index, …))`. `20261080` (P1, **pending migration, not applied**) adds the minting tier and `document_share_refusal`. The "ideally a download grant" limb is enforced at serve time (`creatorMayShare` → `lib/downloadDeny.ts`, `lib/shareServe.ts:161`, `:196`); its mint-time half is public-surfaces `SHR-14` (OPEN, unassigned).
2. ◐ Both public routes run `resolveShareForServing` (`lib/shareServe.ts:123-183`): the document is joined to the share's org (`:146-151`), the SHARER's live read access is re-checked at every fetch (`shareStillAuthorized`, `:157` → `lib/shareAuthorization.ts:23-40`), so a revoked grant kills live links; their minting tier and any download deny too (`creatorMayShare`, `:161`); Draft / not-current / archived documents are refused (`shareStatusRefusal`, `:163-164`) and an unreleased `document_holds` row refuses `423`, fail-closed (`assertNotOnHold`, `:166-176`). **Not done:** the documents-row **legal hold** (`documents.legal_hold`, set by `lib/retention.ts:183`) is never read on this path — `/api/verify` counts it as held (`app/api/verify/route.ts:54`), the share path does not — and there is no **hard acknowledgment gate** check (`assertAckGate`, `lib/downloads.ts:215`, guards member downloads only; `DEC-46` does not address it). The creator's ACL re-check also inherits [`KACL-12`](./05-knowledge-acl.md#kacl-12): a failed container or `team_members` read inside the seam widens it.
3. ◐ Holds through `createShareLink` and the UI; the database half is open until `20261080` is applied. Through the app: creation is restricted to the minting tier `DEC-46` settled — controllers by the role collection, or a publisher granted on the library (`canMintShare` in the modal, the `20261080` INSERT arms, and `creatorMayShare` at serve time, live in code, so a link a non-minter inserts never serves); it writes a checked `SHARE_LINK_CREATED` audit row (`lib/documentShares.ts:199`) and `SHARE_LINK_REVOKED` on revoke (`:260`); "Never expires" is gone (`components/documents/ShareLinkModal.tsx:46-51`, 24 h – 90 days) and `createShareLink` refuses 0 or more than 90 days (`shareExpiryFor`, `lib/shareRules.ts:32`, called at `lib/documentShares.ts:177`). Tests: `lib/__tests__/shareRoutes.test.ts`, `shareAuthorization.test.ts`, `shareResolveRoute.test.ts`. **Not done at the database:** until `20261080` is applied, the live `document_shares_insert` (`20261037_rp_phase3b_read_ownership_and_version_integrity.sql:120-135`) admits any member who can read the document, inserting straight through PostgREST with no expiry bound and no `SHARE_LINK_CREATED` row — and for a library publisher that row serves: a NULL `expires_at` never expires (`lib/shareServe.ts:142`) and `creatorMayShare` passes a publisher (`:218-225`). `20261080` closes the tier and the 90-day ceiling at the database (`DIST-6`); it adds no insert audit, so a minting-tier member's direct insert still writes no distribution row (the serve-side access trail, `recordShareAccess`, records each fetch).

**Remaining / owner.** Two serve-time refusals — `documents.legal_hold = true`, and a document whose effective acknowledgment policy sets `hardGate` (whether that binds for the sharer or outright is the owner's call) — plus KACL-12 (I-12), plus criterion 3's database half: the tier and the expiry ceiling close when `20261080` is applied (`DIST-6`, pending apply), and an audit row for a direct insert (a trigger, or the INSERT policy refusing what `createShareLink` did not write) is not in `20261080`. Owner named: document-control **P1 SHARE's remainders** — P1 built `lib/shareServe.ts` and merged without these two; they go beside its other remainders (`SHR-14`, `DIST-15`), with the direct-insert audit. No queued package lists them today, so the integrator adds them to that follow-up.

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

**Partial (2026-09-30, intelligence Round G).** Planned as a record-only close on roles-and-permissions `DOCACL-1` / `ADD-1` / `20261041` (live). Re-verified at HEAD `1b71ca1`: the defect itself — a grant naming a secondary role matching no one, a deny naming it biting only at download — is gone at every evaluator; criterion 3 (a statement in the UI) is not built, so this stays OPEN.

**Done-when.**
1. ✓ A role subject matches any held role: `lib/acl.ts:79-82` (`if (ctx.role && ctx.role === id) return true; return Array.isArray(ctx.roles) && ctx.roles.includes(id)`), for allow AND deny (`evaluateRules`, `:96-129`); `lib/permissions.ts` passes `roles: heldRoles(principal)` to every evaluator (`:69`, `:153`, `:180`, `:213`). `node_visible` reads `COALESCE(roles, ARRAY[role])` and matches the allow bucket against every held role (`20261041_rp_phase5_node_visible_additive.sql:48-52`, `:80-83`, live). (A role-subject DENY is not evaluated by `node_visible` for any role, headline or not — that is `DACL-12`, I-12's.)
2. ✓ Every principal construction site passes the collection: the library page (`app/(protected)/documents/[libraryId]/page.tsx:1691-1700`), `/api/storage/download-url` (`:93-99`, `normalizeRoles`), `/api/acl/rebuild` (`:76`), the ticket page (`app/(protected)/requests/[id]/page.tsx:1081`), `lib/principal.ts:54-63`, `lib/docFileServer.ts:110-117`, `loadPrincipal` (`lib/knowledgeAccess.ts:36-50`), the simulator (`components/permissions/ViewAsSimulator.tsx:199`); the headline-authority census is pinned by `lib/__tests__/sweepRoundC1b.test.ts` (ADD-1).
3. ✗ Neither the Permissions drawer nor the simulator states which roles a rule matches for a given member. The simulator EVALUATES with the full collection (`ViewAsSimulator.tsx:196-201`), but its member picker shows the headline only (`:160`, `{m.name} — {m.role}`) and its per-person list shows user-subject rules only (`:134`, `:272`); the drawer's role picker (`components/permissions/PermissionDrawer.tsx:626-646`) says nothing about who holds the role. The confusion this guarded against is much narrower now (a role rule reaches every holder), but the statement is not there.

**Remaining / owner.** Criterion 3 only — show a member's full role collection in the simulator and, for a role rule, which held role it matches. `ViewAsSimulator.tsx` is on admin-and-org **P9** (permissions-console truth; its `ORG-10` residual touches the same component), `PermissionDrawer.tsx` on A&O **P7** (`ALOG-8`); P9 is the owner named here. P9's findings list does not carry this criterion yet — the integrator adds it; reverse pointer on `ORG-10` (`admin-and-org/01-org-lifecycle.md`).

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

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: nothing has landed and no criterion holds. Both export routes still admit Manager — `app/api/data-export/run/route.ts:18` (`ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"]`, used at `:76`) and `app/api/data-export/structured/route.ts:56` (now read from the role collection, `memberHoldsAny`) — and so does `app/api/data-export/destinations/route.ts:14`; the manifest names no withheld rows. Owner: admin-and-org **P3** (`BKP-8`, Admin-only full export per `DEC-43`); the same fix closes `ILIFE-7` and `IEDGE-10`. Landed neighbour, not a criterion here: document-control `EGR-7` redacts bearer-token columns from every dump (`DEC-45`). Cross-note on `BKP-8`.

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

*Corrected 2026-09-23 (document-control Round F, `HLD-7` / public-surfaces `VFY-6`): the credit above was only half right — /api/verify-hold withheld `notes` and names but published `reason` verbatim, and `reason` is operator free text (no CHECK; the picker's "Other…" stores whatever was typed). The route now publishes the reason only when it is one of the predefined picker categories and says "On hold" otherwise (`lib/holds.ts` `publicHoldReason`).*

**Done when.**

- [ ] Verify surfaces refuse documents whose visibility is private/hidden, or answer only 'current / superseded' without the title for them
- [ ] Verification is keyed to a per-print token recorded at stamping time rather than to the durable document UUID
- [ ] verify-package returns only documents that were actually issued in that package's distribution

**Partial (2026-09-30, intelligence Round G).** Re-verified at HEAD `1b71ca1`. Closed around it: the outsider's UUID source the failure scenario names — `/d/[number]` no longer hands out document UUIDs (roles-and-permissions `EGRESS-2`; see `DACL-3`); `/api/verify-package` answers from the immutable print snapshot when the QR carries one (`app/api/verify-package/route.ts:28-34`, `:50-73`, document-control `PKG-2`) and reads documents only in the package's own org (`:84-86`); `/api/verify-hold` publishes only a predefined hold category (the note above, `HLD-7`). No verify route checks visibility, so every criterion is still open:

**Done-when.**
1. ✗ No route refuses a private or hidden document or withholds its title: `/api/verify` selects by id with no visibility column (`app/api/verify/route.ts:35-39`) and returns `docNumber` / `title` (`:145-146`); `/api/verify-package` labels every sheet `document_number || title` (`:98`); `/api/verify-hold` returns the held document's label (`app/api/verify-hold/route.ts:45-53`).
2. ◐ Packages: a print-keyed QR verifies what was printed (`PKG-2`). Documents: `/api/verify` is still keyed on the durable document UUID with `v` optional (`:27-31`); no per-print token.
3. ◐ With `?print=` the answer is exactly the printed sheets; without it (an older QR) it is the package's live membership (`:74-81`), not "what was actually issued in its distribution".

**Remaining / owner.** Handed to public-surfaces **PS-VERIFY** (owns the four verify endpoints: `VFY-2` / `VFY-3` per-print semantics, `VFY-12` scan log, `VFY-14` narrow select) with the default this package was given: for a private or hidden document answer "current / superseded" without number or title (fail-safe — less disclosure). Cross-note added on `VFY-14`; the same limb closes `DACL-3` criterion 3. The cross-note is only a pointer: no VFY finding covers private / hidden refusal, and PS-VERIFY's plan (`audit-reports/fleet-plans/public-surfaces.json`) lists no visibility item, so the integrator adds DACL-8 criteria 1–3 and DACL-3 criterion 3 to PS-VERIFY with that default (or public-surfaces opens a VFY finding for them).

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
