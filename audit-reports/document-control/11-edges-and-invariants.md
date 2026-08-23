# 11 · Edges, modalities & load-bearing invariants

**14 findings** — 1 CRITICAL · 5 HIGH · 8 MEDIUM.

What twenty-three lenses did not look at — plus what is sound and must not break.

> ### ✓ Verified after the fact
>
> This report came from the completeness critic, which ran **after** the verification
> stage — so it originally shipped unverified, and its two worst citations were wrong
> (`META-AUDIT.md` `MA-6`). **Every finding in it has since been re-read against source**
> in the corpus hardening pass and carries a `Re-verified` line. All survive; the wrong
> citations are corrected.
>
> **This report spans all four areas audited in that run** — document control,
> projects & cost, admin & org, and the public surfaces. It lives here because
> document control is the largest of them; the other three READMEs link to it.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The caller-supplied storage-key discipline: assertSafeStorageKey (traversal, control bytes, empty segments, length) run BEFORE an org-prefix membership gate that authorizes the key rather than just the session. Present on all four storage routes. | `lib/storageKey.ts:40-52; app/api/storage/download-url/route.ts:29-45; app/api/storage/upload-url/route.ts:26-45; app/api/storage/multipart/route.ts:37-48; app/api/storage/resolve/route.ts:29` | This is the pattern the templates/generate hole should be fixed WITH, not around — the ordering (sanitize, then parse the first orgs/<uuid>/ segment, then require active membership) is deliberate and documented at storageKey.ts:1-15. Do not relax it to make a fix easier; the download route additionally layers canDiscover and acl_index deny-download on top (download-url:55-111) and that layering is the model for byte-level enforcement. |
| The document publish-guard trigger: a BEFORE UPDATE trigger on documents that refuses to advance current_version_id or set status='Superseded' when the document is checked out by another user or carries an unreleased hold, with deliberate, documented exemptions for service-role writes and controllers. | `supabase/migrations/20260713_document_publish_guard.sql:28-88` | This is the DB backstop behind lib/documentGuards.ts — it is what stops a raw PostgREST write from publishing over a hold. It only guards 'advance' transitions, which is why lock clears and metadata edits still work; any future RLS or trigger work must preserve that narrowness or it will break legitimate flows. Caveat for whoever touches it: the function is SECURITY DEFINER with no `SET search_path` (line 29), the same shape flagged elsewhere in this codebase — add the search_path pin without widening what the trigger blocks. |
| The restore org boundary: apply-table remaps ids and then unconditionally overwrites org_id with the authorized workspace, refuses tables outside the export contract, refuses reconciled tables, and caps rows per call. | `app/api/admin/restore/apply-table/route.ts:38-58` | It is the one hard invariant on the most dangerous route in the app — restored rows can never land in someone else's workspace. The fix for the audit_logs/e_signatures importability finding must be additive (shrink IMPORTABLE, add auditing) and must not disturb this forced assignment. |
| Credential handling for export destinations: AES-256-GCM with a fresh 12-byte random IV and an auth tag per secret, set-only-if-provided on PATCH, and credential columns stripped and masked on every read path. | `lib/serverCrypto.ts:33-54; app/api/data-export/destinations/route.ts:55-66,100-106,152; app/api/data-export/destinations/[id]/route.ts:57-70,102` | The crypto itself is correct and the API never returns a secret after creation — the defect is only that the export bypasses the read path. Fix the export/restore leak by redacting at the export boundary; do not weaken the encrypt-on-write or mask-on-read behaviour, and keep the getKey() throw (serverCrypto.ts:24-29) that makes a missing EXPORT_ENCRYPTION_KEY a 500 instead of a plaintext save. |
| Backup write verification: after every S3 push the object is HEADed and the stored ContentLength must equal the bytes sent, or the run is marked failed with an explicit 'do NOT trust this backup' message. | `lib/exportRunner.ts:358-371` | "A backup that isn't checked after writing isn't a backup" — this converts a silent truncation into a failed run. The retention-purge fix lives in the same function's neighbourhood; keep this check on the success path untouched. |
| The orphan sweep's fail-closed layers: any reference-query error aborts the whole scan, objects younger than 7 days are never candidates, protected prefixes are skipped, and deleteOrphans re-runs the full scan server-side rather than trusting the client's list. output_templates was retro-registered as a reference source with a comment explaining the near-miss. | `lib/storageOrphans.ts:9-19,26,77-87,96-97,154-158` | Every one of these is load-bearing for an irreversible operation, and the retro-registration comment ("Tables added later MUST be registered here") is the right maintenance contract. The ordering fix must be added inside this structure — do not replace the fail-closed abort with a warning. |
| The scheduled-export claim: a compare-and-set update on next_run_at guarded by the exact value selected, so an overlapping cron or a second scheduler cannot double-export, and a failed run advances the clock instead of re-firing. | `app/api/data-export/run-scheduled/route.ts:71-94,158-171` | This is a correct at-most-once claim implemented without a lock table, plus a real CRON_SECRET fail-closed gate at :49-55. The subscription/membership predicate this finding asks for must be added to the SELECT at :60-66, before the claim — not inside the try block, which would burn the schedule slot. |
| The service worker's honesty rules: never synthesize a status code for an aborted request, never intercept cross-origin requests, never touch RSC payloads (which would pin stale build chunks), and never resolve respondWith to undefined — with a regression test that reads the worker source and asserts each branch. | `public/sw.js:19-31,122-154,105-112; lib/__tests__/sw.test.ts:37,114` | These three rules were each written after a real failure (the phantom 504 on a cancelled prefetch, stale chunks after deploy) and the test pins them. The cache-scoping fix must be confined to cachePut and to a sign-out message handler; do not start intercepting RSC or cross-origin traffic to implement it. |
| Share downloads are stamped server-side, bucket→server→client, so the bytes can never leave unstamped by falling back to a raw presigned URL — and when stamping fails the file still goes out through this route with a download_audits row recording source 'share_link_unstamped'. | `app/api/share/file/route.ts:83-141` | The header comment (:5-12) documents the exact regression this replaced: a CORS failure that silently opened the RAW file. The distribution record distinguishing stamped from unstamped is what makes the failure auditable rather than invisible. Any caching or performance work on this route must not reintroduce a client-side stamping path. |
| The template-analyze prefix allowlist: only keys under this org's own output-templates / output-examples / output-data folders may be read, controller-gated, with the reason written down. | `app/api/templates/route.ts:86-100` | It is the correct implementation of the check its sibling /generate route is missing, in the same feature, twelve lines of code long — the fix for the CRITICAL finding is to lift this verbatim, adding assertSafeStorageKey to match the storage routes. |


---


<a id="xedge-1"></a>

## XEDGE-1 · /api/templates/generate reads ANY object in the R2 bucket by caller-supplied key and returns its parsed cell contents — no org prefix check, no ACL check, no assertSafeStorageKey

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/templates/generate/route.ts:126-156`, `lib/r2Bytes.ts:8-11`, `app/api/templates/route.ts:93-100`, `app/api/storage/download-url/route.ts:29-45`, `lib/knowledgeAccess.ts:31-46`
- **Re-verified:** hardening pass — **SURVIVES**, verified directly. `sourceFileKey` comes off the JSON body (`generate/route.ts:126`) and reaches `fetchBytes` (`:131`), which is a bare `GetObjectCommand({Bucket: R2_BUCKET, Key: fileKey})` with no validation of any kind (`lib/r2Bytes.ts:8-11`). `grep -c 'assertSafeStorageKey\|orgs/'` on the route returns **0**, against ten `assertSafeStorageKey` call sites elsewhere. This finding came from the unverified critic; it is now verified and belongs with `DRLS-2`, `ORG-1`, `EGR-1` and `PKG-1`.

**Mechanism.** The draft branch takes `sourceFileKey` straight off the JSON body and hands it to R2: line 126 `const sourceFileKey = String(body.sourceFileKey ?? "").trim();` then line 131 `sheetData = parseWorkbook(await fetchBytes(sourceFileKey), body.sheet);`. `fetchBytes` (lib/r2Bytes.ts:8-11) is a bare `GetObjectCommand({ Bucket: R2_BUCKET, Key: fileKey })` with no validation of any kind. The only authorization performed is `loadPrincipal(orgId, user.id)` (route:92-93), which returns a principal for ANY active member of ANY role (knowledgeAccess.ts:37-45 — `isController` is computed but never required on this path). The parsed content is then returned to the caller: `headers`, `rowCount` and `columnMap` in the needsMapping response (:148-156), and the actual cell values in `documents[].values` via `baseValues` (:165-172, response :304-313). The repo's own sibling route knows this is required and says so: app/api/templates/route.ts:84-85 — "Both matter — without the prefix check this endpoint would happily return the text of ANY object in the bucket, straight past document ACLs" — and enforces `allowedPrefixes = [orgs/${orgId}/output-templates/, .../output-examples/, .../output-data/]` at :93-100. /generate enforces none of it.

**Failure scenario.** A Viewer in org A is denied read on a private cost model or a controlled drawing's native source (document_versions.source_file_key holds .xlsx natives, lib/revisions.ts:506,524). They POST {orgId: <their own org>, templateId: <any template of theirs>, sourceFileKey: "orgs/<orgB>/documents/…/schedule.xlsx"}. The route authorizes them against THEIR org, fetches org B's object, parses it and returns its headers and row values. Cross-tenant: keys are enumerable from the already-reported /d/[number] oracle (roles-and-permissions EGRESS-2, intelligence DACL-3) and from document_assets; same-tenant: it is a clean bypass of canDiscover and of the acl_index deny-download rules that app/api/storage/download-url/route.ts:71-111 applies to the exact same bytes.

**Evidence.**

```
app/api/templates/generate/route.ts:131 `sheetData = parseWorkbook(await fetchBytes(sourceFileKey), body.sheet);`. Two differently-shaped searches confirm nothing guards it: `grep -n "orgs/\|startsWith\|allowedPrefix\|assertSafe" app/api/templates/generate/route.ts` returns only line 51 (the Bearer prefix) and line 244 (a JSON brace test); `grep -rn assertSafeStorageKey` over app/ and lib/ returns exactly four call sites — storage/multipart:37, storage/upload-url:26, storage/download-url:29, storage/resolve:29 — and no templates route. lib/storageKey.ts:1-15 states the house rule this route breaks: "One gate every storage route runs a caller-supplied R2 key through before it reaches the bucket."
```

**Chain reaction.** The same unvalidated key is the input to XLSX.read (lib/xlsxData.ts:33) on xlsx@0.18.5 — see the dependency finding — so this is also a way to aim a known-vulnerable parser at arbitrary bucket bytes.

**Done when.**

- [ ] `sourceFileKey` is validated with `assertSafeStorageKey` and required to start with one of the same `orgs/${orgId}/output-…/` prefixes app/api/templates/route.ts:93-100 already enforces
- [ ] a test posts a sourceFileKey under a different org's prefix and asserts 403 with no bucket read
- [ ] the ACL check applied to bytes on app/api/storage/download-url/route.ts:55-111 is applied (or the key is restricted to output-data uploads, which carry no document ACL)

---

<a id="xedge-2"></a>

## XEDGE-2 · Every multi-document render download throws before it can be sent — a literal em dash in the Content-Disposition header makes NextResponse reject the batch after the production record is already written

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/templates/generate/route.ts:383-388`, `app/api/templates/generate/route.ts:343-354`, `app/api/templates/generate/route.ts:371-377`, `lib/outputTemplateText.ts:120-138`
- **Re-verified:** hardening pass — **SURVIVES**. `const zipName = `…` — ${rendered.length} documents.zip`` (`generate/route.ts:383`) carries a literal em dash (U+2014) and goes straight into `content-disposition` at `:387`. HTTP header values are latin1; U+2014 is outside it and undici rejects it, so the batch throws **after** the `output_generations` production record is written.

**Mechanism.** The batch path builds `const zipName = `${tpl.name.replace(/[\\/:*?"<>|]+/g, "-")} — ${rendered.length} documents.zip`;` (:383) — the separator is U+2014 EM DASH, a literal in the source — and passes it as a header value: `"content-disposition": `attachment; filename="${zipName.replace(/"/g, "")}"`` (:386). NextResponse extends the web Response, whose Headers are ByteStrings: any code point > 255 throws a TypeError at construction. The same hazard exists on the single-file path (:375) because `renderFilename` only strips `[\\/:*?"<>|]` (outputTemplateText.ts:120,134) — any non-Latin-1 character coming out of a spreadsheet cell (CJK, Cyrillic, “ ” — ) survives into the header. The throw happens AFTER `output_generations` is inserted (:343-348) and after the `OUTPUT_DOCS_GENERATED` audit row is written (:349-354).

**Failure scenario.** A controller generates 12 RFQ letters and clicks download (not "file into document control"). The server renders all 12, records a production run of 12 documents and an audit entry saying 12 were generated, then throws while building the response; the browser sees a 500 and the user has zero files. The compliance record now claims a document production run that never reached anyone, and repeating it mints another phantom run each time. Batch download is unusable for every org, on every template, always — the em dash is unconditional.

**Evidence.**

```
Executed under this repo's Node (v22.22.2): `new Response("x", { headers: { "content-disposition": 'attachment; filename="a — b.zip"' } })` → `Cannot convert argument to a ByteString because the character at index 24 has a value of 8212 which is greater than 255.` The same string via `res.setHeader` on node:http → `Invalid character in header content ["Content-Disposition"]`. Source line app/api/templates/generate/route.ts:383 contains the U+2014 literal; `body.returnJson` (:360-369) short-circuits before this, which is why the filing flow works and only the download is dead.
```

**Done when.**

- [ ] filenames are emitted with RFC 5987 encoding (`filename*=UTF-8''…`) plus an ASCII-folded `filename=` fallback
- [ ] renderFilename / uniqueFilenames strip or transliterate every code point > 0x7F before it reaches a header
- [ ] the production record and audit row are written only after the response has been successfully constructed
- [ ] a test renders two documents whose names contain an em dash and a CJK character and asserts a 200 with a parseable Content-Disposition

---

<a id="xedge-3"></a>

## XEDGE-3 · The chunked restore is a universal, unaudited write primitive: audit_logs, e_signatures and document_acknowledgments are importable with fully client-authored content, and /apply-table writes no audit row at all

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/restore/apply-table/route.ts:24,38-43,74-89`, `lib/exportTables.ts:53,67,130`, `lib/dataRestore.ts:86-93,249-251`, `app/api/admin/restore/apply/route.ts:130`, `app/api/admin/restore/begin/route.ts:78-85`
- **Re-verified:** hardening pass — **SURVIVES**. Re-checked: `IMPORTABLE = new Set([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES])` (`apply-table:24`), `ORG_SCOPED_TABLES` lists 104 tables including `audit_logs`, `e_signatures` and `document_acknowledgments`, and `grep -c audit_logs apply-table/route.ts` returns **0**.

> **Post-hoc verification (hardening pass).** **SURVIVES.** Re-checked against source:
> `IMPORTABLE` is `new Set([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES])`
> (`apply-table/route.ts:24`) and `ORG_SCOPED_TABLES` lists 104 tables including
> `audit_logs`, `e_signatures` and `document_acknowledgments` — all three importable, as
> claimed. `grep -c audit_logs apply-table/route.ts` returns **0**: the chunked route
> writes no audit row, while the single-shot sibling does. **One citation was wrong** —
> `apply/route.ts:214-224` (the file is 154 lines); the Mechanism already names the
> correct anchor, `:130`, and the Locations line now matches it. Severity held at HIGH.

**Mechanism.** `IMPORTABLE = new Set([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES])` (apply-table:24). ORG_SCOPED_TABLES includes `"e_signatures"` (exportTables.ts:53), `"document_acknowledgments"` (:67) and `"audit_logs"` (:130). The SKIP set that would refuse them contains only orgs, org_members, users, notification_preferences, subscriptions, push_subscriptions (dataRestore.ts:86-93). So a POST of `{table:"audit_logs", rows:[…], idRemap:{orgId,uid}}` upserts caller-authored rows straight through the service-role client (:77-86) with no per-table schema validation, no provenance flag marking the row as restored, and no cap beyond 1000 rows per call. The route's own security note — "the caller is an org Admin who fully controls the row content anyway" (:8-12) — is false for exactly these tables: e_signatures and document_acknowledgments are the app's evidence that a named human signed or acknowledged, and audit_logs is the tamper-evidence for everything else. Worse, the chunked path is silent: `grep -n audit_logs app/api/admin/restore/*/route.ts` returns ONE hit, apply/route.ts:130 (the single-shot path). /begin and /apply-table write nothing, and the single-shot path is documented as unusable at real size ("a real org's envelope JSON is tens of MB, far over the ~4.5MB request cap that broke the single-shot apply", begin:5-7).

**Failure scenario.** An Admin (or anyone who has taken an Admin session) posts fabricated `e_signatures` and `document_acknowledgments` rows dated last quarter, and `audit_logs` rows attributing an approval to a controller who never made it — then posts a matching `documents`/`document_versions` slice so the record set is internally consistent. Nothing in the workspace records that a restore happened: the audit trail an OSHA/PSM auditor would read to detect the tampering is itself one of the tables that was written, and the write left no trace. Every downstream compliance surface (review sign-offs, acknowledgment coverage, the audit page) reports the fabricated state as fact.

**Evidence.**

```
app/api/admin/restore/apply-table/route.ts:38-43 `if (!table || !IMPORTABLE.has(table)) { … } if (isSkippedTable(table)) { … }` — the complete gate. lib/exportTables.ts:130 `"audit_logs",` sits inside ORG_SCOPED_TABLES (the array opens at :15 and closes at :161; USER_SCOPED is a separate const at :167). lib/dataRestore.ts:86-93 is the whole SKIP_TABLES map. Two searches for restore auditing (`grep -n audit_logs app/api/admin/restore/*/route.ts` and `grep -rn DATA_RESTORE app lib`) both return only apply/route.ts.
```

**Chain reaction.** `export_destinations` is importable on the same path (exportTables.ts:157), and its encrypted credential columns decrypt with the single global EXPORT_ENCRYPTION_KEY — so a restore can install another workspace's S3 credentials into this one (see the export-secrets finding).

**Done when.**

- [ ] audit_logs, e_signatures, document_acknowledgments, document_review_signoffs and download_audits are added to SKIP_TABLES (or restored into a quarantined `restored_*` shadow set), matching the reasoning already applied to `subscriptions`
- [ ] /begin and /apply-table each write a DATA_RESTORE audit row naming the table and row count, and that row is written by a path the restore cannot itself overwrite
- [ ] restored rows carry a `restored_from_backup_at` provenance column surfaced everywhere signatures and acknowledgments are displayed
- [ ] a test asserts POST /apply-table with table "audit_logs" returns 400

---

<a id="xedge-4"></a>

## XEDGE-4 · The export retention purge lists and deletes the customer's ENTIRE bucket when no prefix is set — it deletes by age, not by whether the object is one of ours

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportRunner.ts:257-265`, `lib/exportRunner.ts:374-405`, `app/api/data-export/destinations/route.ts:122,134`
- **Re-verified:** hardening pass — **SURVIVES**. `Prefix: params.prefix ? … : undefined` (`exportRunner.ts:386`) makes an empty prefix enumerate the whole bucket, and the only per-object test is `obj.LastModified < cutoff`. The purge is wrapped in `.catch()`, so the run still records `succeeded`.

**Mechanism.** After a successful push, `if (dest.retention_days && dest.retention_days > 0) { … s3PurgeOlderThan({ dest, prefix: dest.prefix || "", keepDays: dest.retention_days }) }` (:258-264). In s3PurgeOlderThan the empty prefix becomes no filter at all: `Prefix: params.prefix ? params.prefix.replace(/^\/+|\/+$/g, "") + "/" : undefined` (:386) — ListObjectsV2 with `Prefix: undefined` enumerates the whole bucket, paging until exhausted (:383-395). The only test applied to each object is age: `if (obj.Key && obj.LastModified && obj.LastModified < cutoff) toDelete.push({ Key: obj.Key })` (:389-391). There is no check that the key matches the export filename pattern built at :239-244, no check that it is a .zip, and no cap on how many objects may be deleted — they are deleted 1000 at a time (:398-404). Both `prefix` and `retention_days` are free-form fields the create route stores verbatim (destinations/route.ts:122,134) with no validation that a retention policy requires a prefix.

**Failure scenario.** An admin points a backup destination at an existing corporate bucket (`s3://acme-eng-archive`) without filling in the optional Prefix field, and sets Retention to 30 days because that is what their policy says. The first scheduled run at 05:00 UTC uploads the ZIP, then enumerates the whole bucket and permanently deletes every object last modified more than 30 days ago — the customer's own archived P&IDs, vendor packages and anything else living there. The run is recorded as `succeeded` (run-scheduled/route.ts:119-131) because the purge is wrapped in `.catch((e) => step("s3:retention:err", …))` (:264) and never fails the run.

**Evidence.**

```
lib/exportRunner.ts:386 `Prefix: params.prefix ? params.prefix.replace(/^\/+|\/+$/g, "") + "/" : undefined,` and :389-391 `for (const obj of out.Contents ?? []) { if (obj.Key && obj.LastModified && obj.LastModified < cutoff) { toDelete.push({ Key: obj.Key }); } }`. Contrast the same file's care on the write side — the read-back verify at :362-371 refuses to call a truncated upload a backup. Two searches for a guard (`grep -n "prefix" lib/exportRunner.ts` and `grep -rn "retention_days" app lib`) return only the storage, the schedule UI field, and these two call sites; nothing validates the pair.
```

**Done when.**

- [ ] a retention policy is refused unless a non-empty prefix is set, and the purge hard-fails on an empty prefix instead of defaulting to the bucket root
- [ ] deletion candidates are additionally matched against the `manufacturing-os-export-…zip` name pattern this app writes
- [ ] the purge reports the delete count into `export_runs.diagnostics` and a purge that would delete more objects than the app has ever written to that destination aborts
- [ ] a test asserts s3PurgeOlderThan with prefix "" performs no ListObjectsV2 call

---

<a id="xedge-5"></a>

## XEDGE-5 · The printed transmittal cover sheet's QR and the emailed portal link are built from window.location.origin — the exact failure lib/publicOrigin.ts exists to prevent, on the one artifact that leaves the site

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:389-393`, `lib/transmittals.ts:278`, `lib/transmittals.ts:309-321`, `lib/publicOrigin.ts:1-22`, `lib/docPack.ts:104-105`, `app/api/share/file/route.ts:114-116`
- **Re-verified:** hardening pass — **SURVIVES**. `transmittalPortalUrl` is `typeof window !== "undefined" ? window.location.origin : ""` (`transmittals.ts:390`), so the server produces a relative URL on the one artifact that leaves the site. Same root as `notifications/NEDGE-11` — fix once.

**Mechanism.** `export function transmittalPortalUrl(token: string): string { const origin = typeof window !== "undefined" ? window.location.origin : ""; return `${origin}/transmittal/${token}`; }` (transmittals.ts:390-393). Both external consumers use it: `sendTransmittalEmail` embeds it in the email body sent to the recipient (:278 → renderTransmittalEmail → queueExternalEmail :280-289), and `openTransmittalSheet` encodes it into the QR printed on the cover sheet — `portalUrl = transmittalPortalUrl(t.portalToken); … qrDataUrl = await toDataURL(portalUrl, …)` (:309-317). lib/publicOrigin.ts:6-15 states the contract these two violate: "those URLs get scanned by phones in the field, often with no session… `window.location.origin` is wrong whenever the person generating the print is on a preview/branch deploy — Vercel gates those behind its own login, so the scan dead-ends on a Vercel auth screen instead of the verify page." The stamped-PDF paths do it correctly (docPack.ts:104-105, share/file/route.ts:114-116, MultiDocViewer.tsx:724-725, FullScreenViewer.tsx:1015-1016), so this is a deviation from an established, working discipline, not an unbuilt feature.

**Failure scenario.** A document controller working from a preview deployment (or any non-canonical host) issues a transmittal to a contractor and prints the cover sheet. The QR encodes `https://mfgos-git-branch-x.vercel.app/transmittal/<token>`. The contractor scans it at the gate and lands on a Vercel login wall; the electronic acknowledgment is never made, so the org's proof that the drawing package was received — the entire point of the portal token — does not exist, while the transmittal record shows it was issued and emailed. The emailed link fails identically. Server-side rendering makes it worse: with `typeof window === "undefined"` the function returns `"/transmittal/<token>"`, a bare path in an outbound email.

**Evidence.**

```
lib/transmittals.ts:390 `const origin = typeof window !== "undefined" ? window.location.origin : "";`. The same repo, same class of artifact, done right: lib/docPack.ts:104-105 `verifyUrl: versionId && publicOrigin() ? `${publicOrigin()}/verify/${String(d.id)}?v=${versionId}` : undefined`. Two searches scope the deviation: `grep -rn "publicOrigin()"` returns 9 call sites (requests page, share/file, docPack, physicalBridge, downloads, the two viewers, FileReferenceModal, RelatedPanel); `grep -rn "location.origin"` returns the outbound-URL builders that skipped it — transmittals.ts:390, ShareLinkModal.tsx:81 (external share links), IntakePanel.tsx:273 and QuotesPanel.tsx:559,587 (contractor /submit links), and documents/[libraryId]/page.tsx:748,2962 (the copyable /d/ short links that RelatedPanel.tsx:112 builds with publicOrigin).
```

**Done when.**

- [ ] transmittalPortalUrl, ShareLinkModal's baseUrl, the /submit link builders and the /d/ copy actions all use publicOrigin()
- [ ] publicOrigin() throws (or the caller refuses to print/email) when NEXT_PUBLIC_SITE_URL is unset on the server, instead of returning ""
- [ ] a test asserts transmittalPortalUrl returns an absolute NEXT_PUBLIC_SITE_URL-rooted URL with window undefined

---

<a id="xedge-6"></a>

## XEDGE-6 · The service worker caches authenticated document bytes and signed-URL JSON in a device-wide cache that survives sign-out, ignoring Cache-Control: no-store

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:114-120`, `public/sw.js:156-177`, `public/sw.js:203-220`, `app/api/share/file/route.ts:145-151`, `app/api/storage/download-url/route.ts:144-153`
- **Re-verified:** hardening pass — **SURVIVES**. `cachePut` tests only `response.ok` and `response.type !== "opaque"` (`sw.js:117`) — **no `Cache-Control` inspection at all** — so a `no-store` authenticated document response is written to durable Cache Storage.

**Mechanism.** The fetch handler intercepts every same-origin GET that is not an RSC payload (sw.js:122-154). Both remaining branches write to Cache Storage: navigations `cachePut(RUNTIME_CACHE, request, res)` (:162) and everything else `cachePut(RUNTIME_CACHE, request, res)` (:211). `cachePut` (:116-120) gates only on `response.ok` — it never inspects Cache-Control, so `/api/share/file`'s explicit `"Cache-Control": "no-store"` (share/file/route.ts:149) is ignored and the stamped controlled PDF is written to disk. `/api/storage/download-url` responses are cached the same way, and that route mints a presigned R2 URL whose lifetime the caller chooses with no upper bound: `const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");` (download-url:144). Cache entries are keyed by URL and matched without regard to request headers (no Vary is set), and the only cache eviction in the codebase is the VERSION sweep in `activate` (sw.js:52-65) — `grep -rn "caches\." app components lib` returns exactly one hit, in lib/__tests__/sw.test.ts:114, and none of the five `supabase.auth.signOut()` call sites (app/(protected)/profile/page.tsx:78, app/(protected)/layout.tsx:99, app/page.tsx:225, components/navigation/Sidebar.tsx:293, components/subscription/SubscriptionGate.tsx:109) clears it.

**Failure scenario.** A shared field tablet in Field Mode. A supervisor opens a share link for Rev C of a line drawing; the stamped PDF lands in RUNTIME_CACHE. The share is later revoked and the drawing superseded by Rev D. Out in the unit with no signal, anyone holding the tablet re-opens that URL: the network-first fetch fails and sw.js:167-172 (navigation) or :214-215 (sub-resource) returns the cached Rev C from disk — a revoked, superseded drawing served to a worker with only a footer that says "at time of download". The same mechanism keeps a cached `/api/storage/download-url` JSON payload, so a signed URL issued to user A is replayable by user B for its full lifetime once signal returns — a lifetime user A could have set to a week.

**Evidence.**

```
public/sw.js:117 `if (!response || !response.ok || response.type === "opaque") return;` — the whole cacheability decision. app/api/share/file/route.ts:145-151 sets `"Cache-Control": "no-store"` on the PDF the SW stores anyway. The header comment at sw.js:15-17 claims "Deliberately NOT cached: cross-origin requests (Supabase, R2 signed URLs, Stripe, fonts)" — true of the R2 fetch itself, false of the same-origin JSON that CONTAINS the signed URL and of the same-origin route that streams the PDF bytes.
```

**Chain reaction.** Compounds the already-reported share-link weaknesses (intelligence DACL: any member can mint a token for any document): a cached copy outlives the revocation that is the only kill switch those links have.

**Done when.**

- [ ] `cachePut` refuses any response whose Cache-Control contains no-store/private, and refuses `/api/` paths that are not explicitly allow-listed as cacheable
- [ ] sign-out (all five call sites) posts a message to the worker that deletes RUNTIME_CACHE, and the worker clears it on `clients.claim` when the session identity changes
- [ ] `/api/storage/download-url` caps `expiresIn` server-side (e.g. 900s) instead of trusting the query parameter
- [ ] a sw.test.ts case asserts a `no-store` response is never written to the cache

---

<a id="xedge-7"></a>

## XEDGE-7 · Scheduled full-database exports keep firing for canceled workspaces and for destinations whose creator has been removed — the cron checks neither subscription nor membership

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/run-scheduled/route.ts:60-66,106-115`, `lib/serverAuth.ts:69-98`, `app/api/stripe/webhook/route.ts:80-95`, `components/subscription/SubscriptionGate.tsx:41-48`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. Neither cited range contains a subscription-status or org-membership predicate; a grep for `subscription`/`status`/`org_members`/`active` across them returns nothing.

**Mechanism.** The daily sweep selects purely on destination state: `.eq("enabled", true).not("next_run_at","is",null).lte("next_run_at", nowIso).limit(50)` (:60-66), then builds and delivers the full org export with the service role (:107-115). No org, subscription or membership predicate exists in the file. Cancellation only writes `subscription_status: "canceled"` on the org (webhook:84-87); nothing disables destinations, and the two enforcement points are inert — `assertOrgHasAccess` has zero callers (already reported as roles-and-permissions SURF-15) and SubscriptionGate hardcodes `const ENFORCE = false;` (SubscriptionGate.tsx:41-48). Removing a member likewise touches nothing: destinations carry only `created_by`/`updated_by` (destinations/route.ts:135-136) and no route re-validates them.

**Failure scenario.** Edge traced end to end: an org cancels. `customer.subscription.deleted` sets status canceled. Every night at 05:00 UTC the cron still builds a complete export of that workspace — all tables plus embedded binaries under a 1.5GB cap — and pushes it to whatever bucket or webhook is on file. If the person who configured that destination is the departed engineer whose account was deactivated months earlier, their private bucket keeps receiving the plant's entire document-control database, including drawings, holds, signatures and audit logs, indefinitely and with no one in the org able to see the credentials (destinations/route.ts:56-65 masks them on read).

**Evidence.**

```
app/api/data-export/run-scheduled/route.ts:60-66 is the complete selection predicate. `grep -rn "assertOrgHasAccess" app lib components` returns exactly one line — the definition at lib/serverAuth.ts:78 — and the comment at :75-77 ("data-export / data-portability routes intentionally do NOT call this — a lapsed workspace must always be able to get its data out") explains the interactive export but says nothing about an unattended recurring push.
```

**Done when.**

- [ ] the sweep skips destinations whose org fails org_has_active_subscription (the SQL helper already exists at supabase/migrations/20260713_document_publish_guard.sql:96-106), recording a skipped run rather than silently continuing
- [ ] deactivating a member disables (or flags for re-confirmation) the destinations they created
- [ ] the billing page and the destinations page show, per destination, when it last ran and who owns it

---

<a id="xedge-8"></a>

## XEDGE-8 · The Growth-plan gate on cloud backup destinations is enforced on create only — PATCH can add the bucket afterwards

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/destinations/route.ts:81-95`, `app/api/data-export/destinations/[id]/route.ts:49-56`
- **Re-verified:** hardening pass — **SURVIVES**. The plan gate lives only in `destinations/route.ts:81-95`; a grep for `Growth`/`plan` in `destinations/[id]/route.ts` returns **nothing**, so PATCH can add the bucket after creation.

**Mechanism.** POST gates on the plan, but only when the create body already carries a bucket: `if (body.bucket) { … const allowed = plan === "growth" || plan === "enterprise" || status === "trialing"; if (!allowed) return 402 }` (route.ts:83-94). PATCH has no plan lookup at all — it copies a fixed field list, `bucket` among them, straight into the update: `const fields: (keyof DestinationPatchBody)[] = ["name", "destination_type", "enabled", "endpoint", "region", "bucket", …]; for (const f of fields) if (f in body) updates[f] = body[f];` ([id]/route.ts:49-55). Credentials are equally patchable (:59-67).

**Failure scenario.** A Starter-plan org creates a webhook or bucket-less destination (passes, no gate), then PATCHes it with `{bucket, endpoint, region, access_key_id, secret_access_key, schedule_kind:"daily"}`. It now has a fully functional scheduled S3/R2 backup — the paid Growth feature — and the nightly cron (run-scheduled) never re-checks the plan either.

**Evidence.**

```
app/api/data-export/destinations/route.ts:83 `if (body.bucket) {` … :88 `const allowed = plan === "growth" || plan === "enterprise" || status === "trialing";`. `grep -n "subscribed_plan\|subscription_status" app/api/data-export/destinations/[id]/route.ts app/api/data-export/run-scheduled/route.ts` returns nothing — two of the three write/execute paths for the same feature have no plan check.
```

**Done when.**

- [ ] the plan gate is a shared helper called by POST, PATCH and the scheduled runner
- [ ] the runner skips (and records) destinations whose org no longer holds the entitlement
- [ ] a test PATCHes a bucket onto a Starter org's destination and asserts 402

---

<a id="xedge-9"></a>

## XEDGE-9 · The export SSRF guard validates the URL it is given and then hands the request to fetch, which follows redirects — and resolves DNS separately from the connection

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportRunner.ts:58-76`, `lib/exportRunner.ts:308-313`, `lib/exportRunner.ts:429-438`, `lib/exportRunner.ts:247,412`
- **Re-verified:** hardening pass — **SURVIVES**, both halves. The guard resolves the host itself — `const { address } = await lookup(host)` (`exportRunner.ts:72`) — and the request is then a plain `await fetch(dest.webhook_url, …)` (`:308`), which follows redirects and resolves DNS again independently of the guard's lookup.

**Mechanism.** `assertSafeExternalUrl` parses the URL, blocks non-http(s), blocks literal private IPs and localhost/.internal, then does `const { address } = await lookup(host)` and rejects a private first address (:58-76). The subsequent calls are plain fetches with default redirect handling: the delivery POST at :308-312 `await fetch(dest.webhook_url, { method: "POST", headers, body: zipBytes … })` and the connection test at :433 `await fetch(dest.webhook_url, { method: "HEAD" })`. Nothing sets `redirect: "manual"`, so a destination on a perfectly public host that answers 307/308 with `Location: http://169.254.169.254/latest/meta-data/…` (or an RFC1918 address) is followed with the body intact and the guard never re-runs. Separately, `lookup()` returns one address and the connection re-resolves later, so a host with a short TTL alternating public/private records (DNS rebinding) passes the check and connects to the private address; multi-record hosts are only checked on the first address returned.

**Failure scenario.** An Admin (or anyone with Admin/Manager/DocCtrl, per destinations ADMIN_ROLES) creates a webhook destination at a host they control that 307-redirects to an internal address. `testDestinationConnection` reports ok and the HTTP status of the internal service is echoed back in `{ ok:false, error: `Webhook returned HTTP ${r.status}` }` (:436) — a port/liveness oracle for the deployment's private network. On the scheduled run the whole org ZIP (every table plus embedded binaries) is POSTed to whatever the redirect names.

**Evidence.**

```
lib/exportRunner.ts:308-312 — the fetch with no `redirect` option, immediately after `await assertSafeExternalUrl(dest.webhook_url);` at :280. The module's own stated threat model at :31-36 is precisely what the redirect defeats: "a destination pointed at an internal address (e.g. 169.254.169.254 cloud metadata, localhost, RFC1918) would let an admin probe or reach internal infrastructure."
```

**Done when.**

- [ ] both fetches use `redirect: "manual"` and re-run assertSafeExternalUrl against any Location before following it (bounded hop count)
- [ ] the resolved address is pinned for the connection (custom agent/lookup) so the checked address is the connected address
- [ ] every address returned by DNS is checked, not just the first
- [ ] the test route returns a boolean, not the upstream status code

---

<a id="xedge-10"></a>

## XEDGE-10 · The full-org export dumps export_destinations' encrypted credential columns verbatim, and the restore path can re-import them into a different workspace where the same global key decrypts them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportTables.ts:157,171-176`, `lib/dataExport.ts:31-32`, `app/api/data-export/destinations/route.ts:55-66`, `lib/exportRunner.ts:333-343`, `lib/serverCrypto.ts:22-31`
- **Re-verified:** hardening pass — **SURVIVES**, and the contrast is the evidence. `export_destinations` sits in `ORG_SCOPED_TABLES` (`exportTables.ts:157`) while `EXPORT_EXCLUDED_TABLES` excludes `ai_connections` on the reasoning *"holds live AI provider API keys — secrets never leave the database"* (`:173-174`). The identical reasoning was never applied to the table holding encrypted bucket credentials.

**Mechanism.** `"export_destinations"` is an ORG_SCOPED_TABLE (exportTables.ts:157) and the exporter dumps whole rows with no column filtering — `grep -n "encrypted\|redact\|secret\|api_key" lib/dataExport.ts` returns nothing — so `access_key_id_encrypted`, `secret_access_key_encrypted` and `webhook_secret_encrypted` land in tables/export_destinations.json inside every backup ZIP and every /api/data-export/structured download. That contradicts the contract stated three lines below in the same file: ai_connections is excluded because it "holds live AI provider API keys — secrets never leave the database" (exportTables.ts:172-174), and the API surface for these same columns is careful — the destinations GET strips and masks them (destinations/route.ts:56-65). Decryption depends on a single deployment-wide `EXPORT_ENCRYPTION_KEY` (serverCrypto.ts:22-31), and `export_destinations` is importable through /api/admin/restore/apply-table, which forces only org_id (apply-table:54-58).

**Failure scenario.** Org A's nightly backup ZIP is delivered to a shared/managed webhook or bucket, or an ex-admin keeps their last export. Whoever holds it now has org A's S3 credentials as ciphertext. On the same deployment, an Admin of org B posts those rows to /api/admin/restore/apply-table with table "export_destinations"; org_id is rewritten to B, but the ciphertext is unchanged and `buildS3ClientFromDestination` decrypts it with the shared server key (exportRunner.ts:334-340). Pressing Test on that destination confirms org A's credentials work, and org B can now write to — and, with retention_days set, delete from — org A's bucket, all from inside the product.

**Evidence.**

```
lib/exportTables.ts:157 `"export_destinations",` inside ORG_SCOPED_TABLES vs :172-174 `ai_connections: "holds live AI provider API keys — secrets never leave the database; reconnect providers after a restore"`. lib/exportRunner.ts:334-335 `const accessKeyId = dest.access_key_id_encrypted ? decryptSecret(dest.access_key_id_encrypted) : "";`. Two searches confirm no redaction layer: `grep -n encrypted lib/dataExport.ts` (no hits) and `grep -rn "REDACT\|redactColumns" lib app` (no hits).
```

**Done when.**

- [ ] the exporter blanks the three *_encrypted columns (or export_destinations joins ai_connections in EXPORT_EXCLUDED_TABLES with the same written reason)
- [ ] export_destinations is added to SKIP_TABLES so a restore never installs credentials
- [ ] secrets are encrypted with a per-org derived key, not one deployment-wide key

---

<a id="xedge-11"></a>

## XEDGE-11 · The render action accepts an unbounded document array and an arbitrary tag→value map, neither limited to the template's declared placeholders

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/templates/generate/route.ts:66,317-339`, `lib/docxRender.ts:60-99`, `lib/outputTemplateText.ts:32,41-54`
- **Re-verified:** hardening pass — **SURVIVES** — **and the bound that looks like a refutation is on the other path.** `MAX_ROWS_PER_CALL = 25` (`:66`) is referenced exactly once, at `:162`, slicing spreadsheet rows in the **draft** branch. The render branch is `const docs = Array.isArray(body.documents) ? body.documents : []` with only an empty check (`:317-318`), then `for (let i = 0; i < docs.length; i++)` rendering each into memory (`:332-334`). No upper bound, and `d.values` is an arbitrary tag→value map.

**Mechanism.** `MAX_ROWS_PER_CALL = 25` (:66) is applied only in the draft branch (`slice = sheetData.rows.slice(offset, offset + MAX_ROWS_PER_CALL)`, :162). The render branch takes `const docs = Array.isArray(body.documents) ? body.documents : [];` (:317) with no length check and loops `rendered.push({ name: names[i], bytes: renderTemplate(templateBytes, docs[i].values) })` (:333-335), holding every rendered file in memory before zipping (:380-382). `docs[i].values` is passed to docxtemplater untouched — nothing intersects it with `tpl.placeholders`, so any key/value pair the caller invents is injected. Separately, the placeholder detector cannot see raw-XML tags: `const TAG_RE = /\{([#^/]?)\s*([A-Za-z0-9_.\-]+)\s*\}/g;` (outputTemplateText.ts:32) admits `#`, `^`, `/` markers only, so a `{@field}` in an uploaded template is invisible in the reviewed placeholder spec while docxtemplater's raw-XML handling would still consume a caller-supplied value for it.

**Failure scenario.** Generation is deliberately open to every member (the Generate button is outside the isController guard, app/(protected)/output-templates/page.tsx:111 vs :141-144). A member posts 5,000 documents in one render call: the function renders 5,000 .docx in a loop and builds the zip in RAM until the 300s/​memory ceiling kills it — after the audit row and production record are written. The raw-XML variant is the sharper one: if any org template contains a `{@…}` tag (invisible to the analyze step's review UI), a caller supplies OOXML for it and the injected markup becomes part of a document that is then filed into document control as a draft revision on the company's own letterhead.

**Evidence.**

```
app/api/templates/generate/route.ts:317-318 `const docs = Array.isArray(body.documents) ? body.documents : []; if (docs.length === 0) return bad("Nothing to render.");` — the only check. lib/docxRender.ts:76-80 constructs Docxtemplater with `{ paragraphLoop: true, linebreaks: true, nullGetter: () => "" }` — no `errorLogging`, no tag allow-list, no module restriction. The raw-XML half is SUSPECTED (docxtemplater's runtime behaviour is not observable here — node_modules is not installed); the missing cap and the unfiltered value map are CONFIRMED from source.
```

**Done when.**

- [ ] render caps `documents.length` at the same MAX_ROWS_PER_CALL the draft path uses, and streams or slices the zip build
- [ ] values are filtered to the template's declared placeholder tags before reaching renderTemplate
- [ ] findPlaceholders recognises `@` raw-XML tags and the analyze UI flags them as unsafe, or renderTemplate is configured to refuse them

---

<a id="xedge-12"></a>

## XEDGE-12 · The server-side workbook parser is xlsx@0.18.5 — the last npm release, carrying unpatched prototype-pollution and ReDoS advisories — and it is reachable with an attacker-chosen bucket object

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `package.json:29`, `package-lock.json (node_modules/xlsx 0.18.5)`, `lib/xlsxData.ts:9,33`, `app/api/templates/generate/route.ts:131`
- **Re-verified:** hardening pass — **SURVIVES**. `package.json:36` pins `"xlsx": "^0.18.5"`, the final npm release of the package, and `lib/xlsxData.ts:9` imports it. Reachable with an attacker-chosen bucket object via `XEDGE-1`.

**Mechanism.** `"xlsx": "^0.18.5"` resolves to the npm-registry build 0.18.5 (confirmed in package-lock: `node_modules/xlsx 0.18.5 https://registry.npmjs.org/xlsx/-/xlsx-0.18.5.tgz`). SheetJS stopped publishing to npm after 0.18.5; the prototype-pollution fix (0.19.3) and the ReDoS fix (0.20.2) exist only on the vendor CDN, so `npm audit`-visible advisories against this package can never be satisfied by a registry bump. The single call site is server-side and reached before any file-ownership check: lib/xlsxData.ts:33 `const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });`, called from app/api/templates/generate/route.ts:131 with bytes fetched from a caller-supplied key. `grep -rn "XLSX.read\|from \"xlsx\"" app lib components` returns exactly these two lines, so the blast surface is one function — which is also what makes it cheap to isolate.

**Failure scenario.** Any active org member uploads a crafted workbook to their own output-data prefix (permitted by /api/storage/upload-url) and calls the draft action. The parse runs in the Next.js server runtime with the service-role Supabase client and R2 credentials in scope; a successful Object.prototype pollution in that process affects every subsequent request handled by the same warm instance, and the ReDoS path stalls a 300s-maxDuration function. Not observable from the repo — no runtime here — hence SUSPECTED, but the version and the reachable sink are both confirmed.

**Evidence.**

```
`node -e` over package-lock.json printed `node_modules/xlsx 0.18.5 https://registry.npmjs.org/xlsx/-/xlsx-0.18.5.tgz`. lib/xlsxData.ts:33 is the only XLSX.read in the tree (two search shapes: `XLSX.read` and `from "xlsx"`).
```

**Done when.**

- [ ] the dependency is moved to the vendored SheetJS build ≥0.20.2 (or replaced with a maintained parser such as exceljs) and the lockfile reflects it
- [ ] parseWorkbook runs on hardened input: a size cap, a sheet cap, and `Object.freeze(Object.prototype)`-style hardening or an isolated worker
- [ ] a fixture test asserts a workbook whose sheet names include `__proto__` does not mutate Object.prototype

---

<a id="xedge-13"></a>

## XEDGE-13 · The storage orphan sweep paginates the reference scan with no ORDER BY, then permanently deletes every object it did not see referenced

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storageOrphans.ts:90-104`, `lib/storageOrphans.ts:118-150`, `lib/storageOrphans.ts:154-180`, `app/api/admin/orphans/route.ts:27,47`
- **Re-verified:** hardening pass — **SURVIVES**. `.range(from, from + 999)` with **no `.order()`** (`storageOrphans.ts:94`). Postgres gives no stable row order across windows without an ORDER BY, so a reference can be skipped and its object permanently deleted.

**Mechanism.** `collectReferencedKeys` walks each source table in 1000-row windows: `const { data, error } = await sb.from(table).select(select).range(from, from + 999);` (:95) — no `.order(...)` anywhere in the loop (:91-102). PostgREST/Postgres give no ordering guarantee across separate LIMIT/OFFSET queries; concurrent updates (HOT tuple moves), a plan switch to a bitmap or parallel scan, or autovacuum between pages can make one row appear twice and another never appear. A row missed in the reference set means its `file_url` is absent from the `referenced` Set, and scanOrphans then classifies the object as an orphan (:132 `if (!key || referenced.has(key)) continue;`) and deleteOrphans deletes it for real (:154-180, `DeleteObjectsCommand`). The module is explicitly built to fail closed — "deleting a live file is unrecoverable" (:9-19) — and it does so for query errors, young objects and protected prefixes, but unstable pagination is a silent way to produce an incomplete reference set that looks complete, which is exactly the failure the comment at :32-33 says must never happen: "an incomplete reference set must never masquerade as a complete one."

**Failure scenario.** A plant with 40k document_versions rows runs the orphan sweep from /admin (route:47 `deleteOrphans`). While page 12 of the document_versions scan is running, a check-in updates rows in that table; two rows shift across the page boundary and one is never returned. Its `file_url` — the current published PDF of a controlled drawing older than 7 days — is not in the reference set, so it is deleted from R2. The DB row still points at it; the next person who opens that drawing gets the archive prompt or a 404, and the binary is gone with no undo.

**Evidence.**

```
lib/storageOrphans.ts:95 `const { data, error } = await sb.from(table).select(select).range(from, from + 999);` — the comment above it at :92 claims ".range in 1000-row windows so big tables don't truncate", which addresses the row cap but not ordering. Contrast the same file's other safety layers, which are real: `throw new Error(… aborting (fail-closed))` (:97), `MIN_AGE_DAYS = 7` (:25), `PROTECTED_PREFIXES` (:26), and the re-scan before delete (:157).
```

**Done when.**

- [ ] every paginated reference query carries a stable `.order("id", { ascending: true })` (or keyset pagination on id)
- [ ] collectReferencedKeys cross-checks its per-table row count against a `head:true, count:'exact'` query and aborts if they disagree
- [ ] deleteOrphans refuses to run when any source table's paged total differs from its counted total

---

<a id="xedge-14"></a>

## XEDGE-14 · subscribed_plan is read only from Stripe subscription metadata, so a plan change made in the billing portal never reaches the app — and an update event without metadata nulls the plan outright

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/stripe/webhook/route.ts:52`, `app/api/stripe/webhook/route.ts:56`, `app/api/stripe/webhook/route.ts:63`, `app/api/stripe/checkout/route.ts:79-81`
- **Re-verified:** hardening pass — **SURVIVES**. `const plan = (sub.metadata?.plan as string) || null;` (`webhook/route.ts:56`) then `subscribed_plan: plan` (`:63`). Metadata is written at `checkout/route.ts:79-81` and nowhere else, so a portal-side plan change never arrives and a metadata-less update event writes `null` over the stored plan.

> **Post-hoc verification (hardening pass).** **SURVIVES — the citations were wrong.**
> The finding cited `checkout/route.ts:119-122` (98 lines) and `portal/route.ts:140-145`
> (49 lines); neither line exists. The real anchors are `webhook/route.ts:56` —
> `const plan = (sub.metadata?.plan as string) || null;` — and `:63`,
> `subscribed_plan: plan`, with the metadata written at `checkout/route.ts:79-81`.
> Both claims hold: the plan is read only from subscription metadata, so a change made in
> the billing portal never reaches the app, and an update event carrying no metadata
> resolves `plan` to `null` and writes that null over the stored value. Locations
> corrected above; severity held.

**Mechanism.** On `customer.subscription.created|updated` the handler takes the plan from metadata only: `const plan = (sub.metadata?.plan as string) || null;` (:56) and writes it unconditionally: `subscribed_plan: plan` (:63). Checkout stamps `subscription_data.metadata.plan` at purchase (checkout:119-122), but Stripe does not rewrite subscription metadata when a customer switches price in the Customer Portal — which this app deliberately opens for exactly that purpose ("update their card, see invoices, cancel, or change plan", portal:142-144). There is no price→plan mapping anywhere: lib/stripe.ts:32-36 maps plan→priceId only, and `sub.items` is never read in the webhook.

**Failure scenario.** An admin upgrades Starter→Growth in the portal. Stripe bills Growth; the webhook fires with the original metadata and writes `subscribed_plan: "starter"`. The org is refused cloud backup destinations with "require the Growth plan. Upgrade in Billing" (destinations/route.ts:91) while paying for Growth. The reverse is equally live: a downgrade leaves `subscribed_plan: "growth"` and the entitlement stays open. And any subscription updated outside checkout (a dashboard edit, a migration, a metadata clear) sets plan to NULL on an active, paying workspace.

**Evidence.**

```
app/api/stripe/webhook/route.ts:56 `const plan = (sub.metadata?.plan as string) || null;` → :63 `subscribed_plan: plan,`. `grep -rn "items.data\|price\b" app/api/stripe/webhook/route.ts` returns nothing; `grep -rn getPriceIdForPlan app lib` returns only lib/stripe.ts:32 and app/api/stripe/checkout/route.ts:79 — there is no inverse mapping in the codebase.
```

**Done when.**

- [ ] the webhook derives the plan from `sub.items.data[0].price.id` through a priceId→plan map, falling back to metadata
- [ ] a null/unmapped plan leaves the stored value unchanged rather than overwriting it with NULL
- [ ] a test replays a subscription.updated event whose metadata lacks `plan` and asserts subscribed_plan is untouched

---
