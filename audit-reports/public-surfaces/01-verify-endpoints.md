# 01 · The public verify endpoints

**20 findings** — 1 CRITICAL · 2 HIGH · 11 MEDIUM, plus `VFY-15`, `VFY-16`, `VFY-17`, `VFY-18`, `VFY-19` and `VFY-20` (LOW) opened by public-surfaces Round F (PS-VERIFY), 2026-10-01.

Unauthenticated. What each returns to someone holding only a scanned code.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| UUID-keyed entry points. Every public verify surface is keyed on a gen_random_uuid() primary key (documents.id, document_versions.id, document_holds.id, work_packages.id, tickets.id) and every route validates it against a strict UUID_RE before touching the DB. IDs are genuinely unguessable; there is no sequential-id enumeration path through /api/verify*, and mixed doc/version ids are rejected with a clean 404 (verify/route.ts:60-63). | `app/api/verify/route.ts:19,29-31,60-63; supabase/migrations/20260612_phase5_holds.sql:46; supabase/migrations/20260825_work_packages_acks.sql:22` | The enumeration risk on these four endpoints is entirely inherited from /d/[number] (already reported as DACL-3), not from the verify routes themselves. Do not 'fix' them by adding a second secret; fix the oracle. |
| publicOrigin() — every printed QR is built on NEXT_PUBLIC_SITE_URL, not window.location.origin, so a print made from a preview deploy still resolves against production instead of dead-ending on a Vercel auth wall. | `lib/publicOrigin.ts:17-21; used at lib/physicalBridge.ts:51-53, lib/downloads.ts:97` | This is the single most load-bearing correctness detail in the physical bridge and it is right. Any refactor of the QR builders must keep it. |
| No global auth middleware exists (no middleware.ts anywhere in the repo), and app/verify*, app/d, app/share, app/submit, app/transmittal sit outside the (protected) route group. The four verify pages are genuinely reachable with no session — the design intent is actually implemented. | `app/ (route groups); absence of /home/user/manufacturing-os/middleware.ts` | The 'no login wall in the field' promise is real. Any future middleware matcher must explicitly exempt /verify, /verify-hold, /verify-package, /verify-ticket, /d or every printed QR in the plant breaks at once. |
| handlePrintPack re-pins the whole package immediately before building the cover sheet, so paper and pins agree by construction at the moment of printing. | `app/(protected)/packages/page.tsx:157-176` | This is the correct half of the work-package tripwire and must be preserved; the defect is that the same re-pin is also reachable WITHOUT a print (finding 1). |
| refreshWorkPackage checks every single pin write and throws on a zero-row match rather than reporting success — the exact supabase-js {error}-not-thrown trap the earlier audits found six times, handled correctly here, with a comment naming the past incident. | `lib/workPackages.ts:206-228` | A worked example of the correct write-verification pattern for the rest of the codebase to copy. |
| effectiveStatusFor() / daysUntilEffective() — a single canonical, unit-tested helper for 'is this revision in force yet', using local-midnight date arithmetic. | `lib/effectiveDate.ts:21-36; lib/__tests__/effectiveDate.test.ts` | The public verify endpoint reimplements this instead of calling it (finding 8). The helper is the right answer; the fix is to import it. |
| Four in-repo canonical 'not current' status lists that all agree with each other and all include Void: NOT_CURRENT_STATUSES, staleCopies, the doc-control register filter, and viewerStatusBadge. | `lib/aiBoundary.ts:25; lib/staleCopies.ts:76; lib/docControlRegister.ts:101; lib/downloads.ts:52-68` | The vocabulary is settled everywhere except the two public field endpoints (finding 2). Fixing those means importing one of these, not writing a fifth list. |
| A working per-IP throttle pattern already exists (signup_attempts + clientIp + fail-open on missing table), with the reasoning written down. | `app/api/auth/signup/route.ts:10-33` | Finding 13 needs no new infrastructure and no new vercel.json cron entry — this is the template. |


---


<a id="vfy-1"></a>

## VFY-1 · A VOIDED drawing scans GREEN "CURRENT" — the public verify endpoints use a two-value retired set while four other places in the repo use the three-value one that includes Void

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:89-90`, `app/api/verify-package/route.ts:56`, `lib/aiBoundary.ts:25`, `lib/staleCopies.ts:76`, `lib/docControlRegister.ts:101`, `lib/downloads.ts:52-68`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right, and reachable: `Void` is a first-class document status (types/schema.ts:613) offered in the status dropdown at components/documents/MetadataEditor.tsx:9/394. app/verify/[docId]/page.tsx:106 only special-cases Superseded/Archived too, so a Void document renders the full-screen emerald 'CURRENT — This print matches the current revision.' CRITICAL stands.

**Mechanism.** `const docRetired = d.status === "Superseded" || d.status === "Archived";` (verify/route.ts:89) and `const retired = d?.status === "Superseded" || d?.status === "Archived";` (verify-package/route.ts:56). The documents.status vocabulary is `["Draft","Issued","Superseded","Void","Archived","Locked"]` (components/documents/MetadataEditor.tsx:9). Every other consumer of that vocabulary in the repo treats Void as not-current: `NOT_CURRENT_STATUSES = new Set(["Superseded", "Void", "Archived"])` (aiBoundary.ts:25), `if (d.status === "Archived" || d.status === "Superseded" || d.status === "Void") continue;` (staleCopies.ts:76), `.or("status.is.null,status.not.in.(Draft,Superseded,Void,Archived)")` (docControlRegister.ts:101), and `case "Void": return { label: "Void", tone: "danger" };` (downloads.ts:62-63). The two public endpoints are the only places the list is short. A grep for 'Void' across app/api/verify*, app/api/verify-hold, app/api/verify-package, app/api/verify-ticket and all four page.tsx returns zero matches. This is the 'facility vocabulary hardcoded in application code' pattern the earlier audits flagged, now on the one surface where a wrong answer reaches a worker with a wrench.

**Failure scenario.** A P&ID is Voided — the drawing was issued in error, or the equipment it shows was never installed. Its current_version_id is unchanged and its status is 'Void', not 'Superseded'. A contractor scans the QR on his copy. /api/verify computes docRetired=false, isCurrent = versionId === current_version_id = true, and returns isCurrent:true. The page paints full-screen emerald with a 24px check mark, 'CURRENT — This print matches the current revision.' In the app the same document shows a red 'Void' badge (viewerStatusBadge, downloads.ts:62-63). The same voided sheet inside a work package returns retired:false, fresh:true, and contributes to 'PACK IS CURRENT'.

**Evidence.**

```
app/api/verify/route.ts:89-90 — `const docRetired = d.status === "Superseded" || d.status === "Archived";` / `const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  |  app/api/verify-package/route.ts:56 — `const retired = d?.status === "Superseded" || d?.status === "Archived";`  |  lib/aiBoundary.ts:25 — `export const NOT_CURRENT_STATUSES: ReadonlySet<string> = new Set(["Superseded", "Void", "Archived"]);`  |  components/documents/MetadataEditor.tsx:9 — `const DOCUMENT_STATUSES = ["Draft", "Issued", "Superseded", "Void", "Archived", "Locked"];`  |  grep for 'Void' across all eight verify files: ZERO MATCHES.
```

**Done when.**

- [ ] Both /api/verify and /api/verify-package import NOT_CURRENT_STATUSES from lib/aiBoundary.ts (or a shared lib/documentStatus.ts) instead of open-coding the comparison
- [ ] The verdict is computed by allow-list ('Issued'/'Locked' can be green) rather than by deny-list, so a status added later defaults to not-green
- [ ] A test asserts that status='Void' with versionId === current_version_id yields isCurrent:false / fresh:false

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: document-control `DIST-2` (2026-08-24) had moved `/api/verify` onto the shared `NOT_CURRENT_STATUSES` set, but its verdict was still a deny-list — the final `else verdict = "current"` let any status outside the set (NULL, "In Review", a value added later) read green — and `/api/verify-package` still spelled its own inline list (`d?.status === "Superseded" || d?.status === "Archived" || d?.status === "Void"`, `app/api/verify-package/route.ts:96`) with Draft fresh. Fixed with ONE shared decision:
- `lib/verifyVerdict.ts` (new) — `documentStanding(status)`: retirement from `NOT_CURRENT_STATUSES` (`void` / `archived` / `superseded`; any other member of the set `retired`), `draft`, and an ALLOW-list `IN_FORCE_STATUSES = {Issued, Locked}` (`in_force`); everything else — an empty / NULL status, or one added to the vocabulary later — is `not_issued`.
- `/api/verify` and `/api/verify-package` both call it; neither route spells a status list any more (pinned by test). A non-allow-listed document reads `not_issued` ("NOT ISSUED — DO NOT USE"); a pack sheet carries its own state (`void`, `draft`, `not_issued`, …) and is never fresh.
- Files: `lib/verifyVerdict.ts`, `app/api/verify/route.ts`, `app/api/verify-package/route.ts`, `lib/verifyPresent.ts`, `app/verify/[docId]/page.tsx`, `app/verify-package/[packageId]/page.tsx`.
- Tests: `lib/__tests__/verifyRouteVerdict.test.ts` "VFY-1 / VFY-9 — green is an ALLOW-list (Issued, Locked) …" (Locked current; NULL / "" / In Review / Pending / an unknown status → `not_issued`; Void at the current version → `isCurrent: false`; the route imports the shared decision); `lib/__tests__/verifyPackageSnapshot.test.ts` "VFY-1 / PKG-8 — the shared allow-list decides every sheet" (Void / Superseded / Archived / Draft / NULL / In Review at the printed current version → not fresh, never green; Locked in force; no status list in the route); `lib/__tests__/verifyPresent.test.ts` (green only for `current`, and never for a verdict the page does not know).
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ Both routes read retirement from `NOT_CURRENT_STATUSES`, through the shared `lib/verifyVerdict.ts`.
2. ✓ The verdict is an allow-list (Issued / Locked can be green); a status added later defaults to not-green.
3. ✓ `status = 'Void'` with the printed version = `current_version_id` → `isCurrent: false` (`/api/verify`) and `fresh: false` (`/api/verify-package`) — both tested.

- **Review fix pass (2026-10-01).** A just-printed pack holding such a legacy no-status sheet read red "PACK IS STALE — 1 of N sheets changed or withdrawn since this pack was printed", which is false (nothing changed; it was printed that way). `/api/verify-package` now returns `notIssuedCount` (sheets in `draft` / `not_issued`) beside `staleCount`, and `presentPackVerdict` counts them apart: "N of M sheets are not an issued, controlled revision", headline "PACK HAS UNISSUED SHEETS" when nothing else is wrong (still red, still never green). Tests: `verifyPackageSnapshot.test.ts` "VFY-1 residual / VFY-11 — a not-issued sheet is not 'changed since printing'"; `verifyPresent.test.ts` "VFY-1 / VFY-11: a sheet that is not an issued revision …". Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).

**Scope / residual.** None for this finding. A legacy document with an EMPTY status, which PKG-4's pack gate still admits as "pre-status legacy data" (`lib/docPack.ts` `filterPackDocs`, document-control P8 FIELD's file), now verifies `not_issued` — the fail-safe side, and the page now says "not an issued, controlled revision" rather than "changed since printing". The gate and the allow-list still disagree for such rows: opened as `VFY-17` (owner: document-control P8 FIELD — `filterPackDocs` refuses an empty status).

---

<a id="vfy-2"></a>

## VFY-2 · "Refresh pins" silently flips every already-printed work pack from red STALE to green PACK IS CURRENT — the tripwire is disarmed by a click, with the paper unchanged in the field

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-package/route.ts:39-63`, `lib/workPackages.ts:192-228`, `app/(protected)/packages/page.tsx:108-128`, `lib/physicalBridge.ts:275`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: a repo-wide grep for `printed_at`/`last_printed` finds nothing, so no data anywhere records what the paper says. One correction to the wording: it is not fully 'silent' — the confirm dialog (packages/page.tsx:112-114) and the success toast (:121) both say 'then re-print the pack so the paper matches'. The tripwire is still disarmed with no technical trace, so HIGH stands.

**Mechanism.** The QR on a printed cover sheet encodes ONLY the package UUID — `qrPng(doc, `${origin()}/verify-package/${input.packageId}`)` (physicalBridge.ts:275). There is no print token, no print timestamp, no manifest hash. /api/verify-package therefore computes freshness from two LIVE values: `fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null)` (route.ts:61), where `r.pinned_version_id` comes from work_package_documents at read time. refreshWorkPackage() rewrites exactly that column for every member — `.update({ pinned_version_id: (d?.current_version_id as string | null) ?? null, pinned_rev_label: ... })` (workPackages.ts:212-219) — so after a refresh, pinned_version_id === current_version_id for every sheet by construction, staleCount becomes 0, and allFresh becomes true. handlePrintPack calls refresh-then-print together (packages/page.tsx:157-176), but handleRefresh (packages/page.tsx:108-128) is a separate 'Refresh pins' button (rendered at :293-299) that re-pins with nothing but an advisory string — 'then re-print the pack so the paper matches' (:113) and 'Re-print the pack.' (:122). Nothing enforces the reprint and nothing invalidates the QR already in the field.

**Failure scenario.** A pump-swap pack for U-200 is printed Monday with P&ID Rev 3. Tuesday an MOC issues P&ID Rev 4. The package owner opens /packages, sees '1 stale', clicks 'Refresh pins', confirms, and gets 'Package refreshed'. He does not reprint — the crew already has the folder. Wednesday morning the crew scans the cover sheet under the words 'SCAN BEFORE STARTING WORK. No login needed. Green = this pack is current.' The page returns allFresh:true and paints full-screen emerald: 'PACK IS CURRENT — Every sheet in this pack is still the current revision.' They break the line on a Rev 3 P&ID that Rev 4 re-routed. Before the refresh the same scan of the same paper was red 'PACK IS STALE'.

**Evidence.**

```
app/api/verify-package/route.ts:61 — `fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null),`  |  lib/workPackages.ts:212-219 — `.from("work_package_documents").update({ pinned_version_id: (d?.current_version_id as string | null) ?? null, pinned_rev_label: (d?.rev as string | null) ?? null, }).eq("id", r.id)`  |  app/(protected)/packages/page.tsx:122 — `showToast({ type: "success", title: "Package refreshed", message: "All pins moved to the current revisions. Re-print the pack." });`  |  lib/physicalBridge.ts:275 — `const qr = await qrPng(doc, `${origin()}/verify-package/${input.packageId}`);`  |  The design comment at supabase/migrations/20260825_work_packages_acks.sql:8-11 states the intent this breaks: 'A package pins the revision of each member document at assembly; if any member advances before the job closes, the package reads STALE'.
```

**Chain reaction.** The same live-membership read means sheets ADDED to the package after printing appear in the scan as fresh (addDocumentToPackage upserts pinned_version_id = current, workPackages.ts:181-189), inflating sheetCount and painting green while the crew's folder is physically missing that sheet; sheets REMOVED after printing vanish from the verdict while remaining in the folder. Both directions are invisible to the scanner.

> **Verifier correction.** "Silently" is wrong and should be struck: the flow warns twice — the appConfirm at page.tsx:111-116 says "Review what changed first if you haven't — then re-print the pack so the paper matches" and the success toast at :122 says "Re-print the pack." The button is also rendered only when `stale` is true (:291), and handlePrintPack refreshes-and-prints atomically so the normal path keeps paper and pins in sync. The defect is that the advisory is unenforced, not that the flip is unannounced — which is why I drop CRITICAL to HIGH: it requires a deliberate operator action taken against two on-screen instructions.

**Done when.**

- [ ] The printed cover sheet carries a per-print token (e.g. a row in a work_package_prints table recording package_id, printed_at, and the exact {document_id, version_id} manifest), and the QR encodes that token rather than the bare package UUID
- [ ] /api/verify-package resolves the token and compares the PRINTED manifest against each document's current_version_id, so re-pinning in the database cannot change the verdict for paper already issued
- [ ] A scan of a package UUID with no print token returns a non-green 'cannot confirm which printing this is' state rather than computing freshness from live pins
- [ ] Sheets present in the printed manifest but no longer in the package, and sheets in the package but not in the manifest, are both reported explicitly rather than silently folded into the live list

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY, on top of document-control `PKG-2` (2026-08-24), which landed done-when 1–2: the immutable `work_package_prints` snapshot, the `?print=<id>` cover QR, and a verdict computed against the RECORDED versions. Reproduced on `3a3203d`: a cover QR with no print id still computed freshness from the live pins (`app/api/verify-package/route.ts:75-82`) and painted "PACK IS CURRENT" — the PKG-2 test pinned exactly that ("legacy QR without a print id still uses the live pins") — and a print-keyed scan never compared the manifest with the package, so a sheet added since printing was invisible and a removed one still counted.
- **A legacy QR is never green** (the fail-safe default, user-informed 2026-09-17; `DEC-65`): verdict `unconfirmed_print` — grey "CAN'T CONFIRM WHICH PRINTING — … do not assume this pack is current"; each sheet reads `unconfirmed` with no "printed" rev (a live pin is not what was printed). What is true of every printing still shows: a held sheet makes the pack `held`, a voided one `stale`.
- **The manifest against the package:** the route always reads the live membership; with a print it marks a printed sheet no longer in the package `removed` ("REMOVED FROM PACKAGE", the pack `stale`) and reports every package sheet missing from the paper, split by what is true of it now — `notInPack` (red) or `notPrintable` with its reason (amber `incomplete`) — see the second review fix pass below. (The first pass reported them all as `addedSincePrint`, "Added to the package since printing — NOT in this pack", and made the pack `stale`.)
- Files: `app/api/verify-package/route.ts`, `lib/verifyPresent.ts`, `app/verify-package/[packageId]/page.tsx`.
- Tests: `lib/__tests__/verifyPackageSnapshot.test.ts` "VFY-2 — the printed manifest, not the live package" (legacy never green even with the pin at current; a legacy scan still reports held / void; an added sheet is reported and the pack is not green; a removed sheet is marked `removed`). The PKG-2 legacy test is replaced — its assertion is the behaviour this finding retires.
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).
- **Second review fix pass (2026-10-01): a sheet the print gate left out is not "added since printing".** Reproduced on the first fix pass (`796cc73`): `addedIds = [...inPackage].filter((id) => !onPaper.has(id))` (`app/api/verify-package/route.ts:154`) counted every package sheet missing from the paper as added since printing and made the pack `stale` (`:247`). But document-control `PKG-4`'s gate (`lib/docPack.ts` `filterPackDocs` / `assessPackDocs`) leaves a Draft / withdrawn / held / file-less sheet OUT of a print and the snapshot records only the sheets that rode in — so a correctly printed pack beside one such member scanned red "PACK IS STALE — 1 sheet added to the package since printing is not in this pack … ask for a re-printed pack", both statements false, and a re-print (which skips the sheet again) could never clear it. The route now reads the documents and the holds of every missing sheet too (the one hold read covers them) and splits them by what is true NOW:
  - `notPrintable` — the gate's own refusals, so a re-print would leave the sheet out too: `{ label, reason }` with `reason` one of `not_issued` / `withdrawn` / `on_hold` (a document_holds row or the legal hold — **overstated as landed:** the print gate never refuses a legal hold; corrected by the integration fix pass below) / `hold_unknown` (the hold read failed) / `unavailable` (the document cannot be read) / `no_file` (no current revision — as landed in this pass it tested only `current_version_id`, NOT the builder's "no current file" or its non-PDF skip; corrected by the third review fix pass below). Listed "In the package, not in this pack — cannot be printed now" with the reason; on its own it makes an otherwise current pack AMBER `incomplete` — "PACK INCOMPLETE — Every sheet in this pack is current, but N sheets in the package are not in it and cannot be printed now (not issued, on hold) — listed below. Work only from the sheets in this pack …" — never `stale`, never green. A not-yet-effective printed sheet still says so first.
  - `notInPack` — every other missing sheet: it could be printed now (added since printing, or left out for a reason that no longer holds — a file that failed to fetch, a sheet issued since). Listed "In the package but NOT in this pack"; the pack is red `stale` ("PACK IS MISSING SHEETS" when nothing else is wrong — "N sheets in the package are not in this pack — get the missing sheets"; a re-print does carry them). **Overstated as landed:** a sheet whose current revision has no file, or whose file is not a PDF, also fell here — see the third review fix pass.
  - Nothing says "added since printing": the snapshot cannot prove it (it records no skipped sheets, and `work_package_documents.added_at` is stamped by the browser's clock — `lib/workPackages.ts` `addDocumentToPackage`), so recording the gate's skips and reasons in the print snapshot is opened as `VFY-19` (owner: document-control P8 FIELD), per DEC-31. `addedSincePrint` is gone from the payload.
  - Files: `app/api/verify-package/route.ts`, `lib/verifyPresent.ts` (`NotPrintableReason`, `notPrintableText`, the `incomplete` verdict, the `stale` wording), `app/verify-package/[packageId]/page.tsx`.
  - Tests: `verifyPackageSnapshot.test.ts` "VFY-2 review fix — a package sheet the print gate could not print is not 'added since printing' and never makes a correct pack stale" (a printed Issued sheet + a Draft member → `incomplete`, no "added" / "stale"; a held and a legally held member → `on_hold` — the legally held half is reversed by the integration fix pass; withdrawn / no file / unreadable document / unknown hold state; a member truly added later is still reported and the pack red, also beside a not-printable one; a re-print that carries it reads green; not-yet-effective first; a legacy QR unchanged; neither the page nor the route says "since printing" / `addedSincePrint`) and the rewritten "a printable sheet ADDED to the package since printing is reported as 'in the package but not in this pack' …"; `verifyPresent.test.ts` (the `incomplete` view, "PACK IS MISSING SHEETS", `notPrintableText`, `incomplete` in the green-only list). Verified (second fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (268 files / 5131 passed, 7 expected-fail); run against the first fix pass's code, 21 of the new / changed assertions fail (DEC-29).
- **Third review fix pass (2026-10-01): the split now matches the print gate's file refusals too.** Reproduced on the second fix pass (`2e236dc`): the off-paper split's only file test was `else if (!d.current_version_id) reason = "no_file";` (`app/api/verify-package/route.ts:266`). But the print gate refuses two more things AFTER `filterPackDocs` — `lib/docPack.ts` `buildAndDownloadDocPack` skips a current revision whose version row has no `file_url` ("no current file") and any file `PDFDocument.load` cannot parse (a DWG, XLSX, DOCX or image — `AddToPackageButton` lets any document join a package). So a package holding P-101 (Issued PDF) and P-102 (Issued, hold-free, current revision a `.dwg`) printed P-101 only, and every scan of that correctly printed pack read red "PACK IS MISSING SHEETS — 1 sheet in the package is not in this pack — get the missing sheets … ask for a re-printed pack"; every re-print skipped P-102 again, so it could never read anything else. On `3a3203d` the same pack read green (the route used only the snapshot) — a regression the second pass introduced. Fixed:
  - For the off-paper sheets that pass every other refusal (in force, hold-free, a current revision), the route reads their current versions' files ONCE — `document_versions.select("id, file_url, file_type").in("id", …)`; only 42703 retries with `"id, file_url"` (and the retry is checked); any other error is a 503 with an `error` scan row, never a guess at red or amber. A missing version row or a NULL `file_url` is `no_file` ("no current file" — the builder's own words). A file that is not a PDF is the new `NotPrintableReason` **`not_pdf`** ("not a printable PDF"). Both go to `notPrintable`, so on their own the pack is amber `incomplete`. Only an in-force, hold-free sheet with a PDF on file stays in `notInPack` (red) — one a re-print would carry.
  - The PDF rule is `isPdfFile(fileUrl, fileType)` in `lib/verifyVerdict.ts`: `lib/knowledgeSourceSync.ts` `isPdf`'s rule (the MIME type names PDF, or the path ends `.pdf`; that helper is not exported and not this package's file), widened only so a query string / fragment on an http(s) URL does not hide the extension. A doubtful file leans to "a PDF" — the red side, never amber. **Overstated as landed:** it returned "not a PDF" for anything without PDF evidence, so a path with no recognisable extension and an empty or `application/octet-stream` type read amber `not_pdf`, against its own lean — corrected by the integration fix pass below.
  - The amber advice now fits every reason: "Do not do any work the sheets listed as not in it cover until Document Control supplies them — they cannot be printed into a pack now; a re-printed pack includes them once they can be." (It said "until Document Control issues or releases them", which is wrong for an issued, released DWG.)
  - Files: `app/api/verify-package/route.ts`, `lib/verifyVerdict.ts` (`isPdfFile`), `lib/verifyPresent.ts` (`not_pdf`, the `incomplete` advice).
  - Tests: `verifyPackageSnapshot.test.ts` "VFY-2 third review fix — a sheet the print gate can NEVER print (no file on its current revision, not a PDF) is amber, never red" (the review's .dwg scenario → `not_pdf` / `incomplete` / amber, never "MISSING SHEETS"; XLSX / DOCX / PNG / CAD-MIME DWG / untyped DXF → `not_pdf`; `file_url` NULL and a missing version row → `no_file`; a PDF member by extension, by MIME type alone and behind a signed URL's query string → still `notInPack` and red; a re-print that skips the DWG again still reads amber; the file is read once and only for sheets that pass the other refusals; a failing file read → 503 + `error` row; 42703 → retry by path, a failing retry → 503; `isPdfFile` cases); `verifyPresent.test.ts` (`not_pdf` text, the advice no longer says "issues or releases"). The two existing tests whose added member must be printable now carry a PDF version row. Verified (third fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (268 files / 5147 passed, 7 expected-fail); run against the second fix pass's code, 19 of the new / changed assertions in the four verify suites fail (DEC-29).
  - What is still NOT classified: a sheet the builder dropped at print because its fetch failed, or whose file is named / typed as a PDF but pdf-lib could not parse. Nothing the route can read now says so, so it stays in `notInPack` (red). A transient fetch failure clears on a re-print; a corrupt "PDF" would not — both wait on `VFY-19` (the snapshot recording the builder's skips and reasons).
- **Integration fix pass (2026-10-01): the split is exactly the print gate's refusals; the file rule leans red; the cover says what the scan answers.**
  - **A legal hold alone is not a refusal.** The third pass classed a package sheet missing from the pack whose document carried `legal_hold` (and no `document_holds` row) as `on_hold` — "cannot be printed now" (`app/api/verify-package/route.ts:270` at `9bf6744`). The print gate never refuses it: `lib/docPack.ts` `filterPackDocs` / `assessPackDocs` / `buildAndDownloadDocPack` read only `document_holds`; a legal hold is preservation, not stop-work. So such a sheet with a PDF on file is one a re-print carries and now goes to `notInPack` (red), as any printable sheet missing from the pack does; an active `document_holds` row (stop-work), with or without the legal hold, stays `on_hold` (amber). On the PAPER nothing changes: a printed sheet under a legal hold still reads `held` (`VFY-5`, `DEC-65` §1 — a field scan is never green under a legal hold), and `/api/verify` (DIST-2) and `/api/verify-hold` (`VFY-10`) still count it — none of them is a print-gate question.
  - **`isPdfFile` returns "not a PDF" only on positive evidence:** a known non-PDF extension (CAD — dwg, dxf, dgn, dwf, rvt, ifc, step …; office — xlsx, xls, docx, doc, csv, pptx …; images — png, jpg, jpeg, tif, tiff, gif, bmp …; archives / mail — zip, 7z, msg …) on the path (an http(s) URL's path) or a specific non-PDF MIME type (`image/*`, `text/*`, `application/vnd.*`, `application/msword`, `application/zip`, a CAD type …). PDF evidence is read first and wins. A path with no recognisable extension and an empty or generic binary type (`application/octet-stream`, `binary/octet-stream`, `application/x-download`) is read as a PDF — the red side, as its rule states.
  - **A status the vocabulary does not know** ("IFC", a free value) is the new `NotPrintableReason` `status_unrecognised` ("status not recognised") when the sheet is missing from the pack, and the new sheet state `status_unrecognised` when it is printed — see `VFY-9`'s integration fix. Amber / red exactly as before.
  - **The cover's legend states the real verdict set** (`COVER_SCAN_LINES`, `lib/physicalBridge.ts`): "GREEN = every sheet is current — work from this pack." / "AMBER = do only what the screen says — a sheet is not yet in effect or not in this pack." / "GREY = the scan cannot confirm this pack — check with Document Control before work." / "RED = stop — a sheet changed, was withdrawn, is held, is not issued or is missing." It replaces "No login needed. Green = this pack is current. / Red = a sheet changed since printing — get the new one.", which knew neither amber nor grey; and that red line, drawn at x 428 in 8pt (204pt wide), ran past the 612pt page edge. The legend is drawn in 9pt Helvetica in the column left of the QR plate (x 52, `COVER_TEXT_WIDTH` 368 — every line measured inside it); "SCAN BEFORE STARTING WORK" and "No login needed." stay under the QR.
  - Files: `app/api/verify-package/route.ts`, `lib/verifyVerdict.ts` (`isPdfFile`), `lib/verifyPresent.ts` (`status_unrecognised`), `lib/physicalBridge.ts` (`COVER_SCAN_LINES`, `COVER_TEXT_WIDTH`).
  - Tests: `verifyPackageSnapshot.test.ts` "integration fix — a LEGAL hold alone is not a print-gate refusal: a legally held member with a PDF is notInPack (red); a document_holds member is on_hold (amber)" (and `lib/docPack.ts` reads no legal hold — a tripwire if the gate ever starts to), "a PRINTED sheet under a legal hold still reads held — the integration fix changes only the off-paper split", "isPdfFile (integration fix) — NOT a PDF only on positive evidence …", "a member whose file has no recognisable extension and an empty or octet-stream type is read as a PDF — notInPack, red, never amber"; the "ACTIVE HOLD" test keeps only its `document_holds` half; `verifyDoor.test.ts` "the legend names every verdict colour /verify-package can show (green, amber, grey, red); each line fits the cover's text column left of the QR". Verified: `tsc` 0, `eslint .` 0 warnings, full `vitest` green (268 files / 5157 passed, 7 expected-fail); run against `9bf6744`'s four source files, 11 of the new / changed assertions in `verifyPackageSnapshot`, `verifyPresent` and `verifyDoor` fail (DEC-29); the printed-legal-hold pin passes on both (no regression).

**Done-when.**
1. ✓ (PKG-2) The printed cover carries a per-print token (`work_package_prints` row: package, printed_at, the {document, version} manifest); the QR encodes it.
2. ✓ (PKG-2) `/api/verify-package` compares the PRINTED manifest against each document's current version; re-pinning cannot change the verdict.
3. ✓ A scan with no print token returns the non-green "cannot confirm which printing this is".
4. ✓ Sheets in the manifest but no longer in the package (`removed`) and in the package but not in the manifest are both reported explicitly — the latter as `notInPack` or `notPrintable` with the reason it cannot be printed now. The classified print-gate refusals are exactly the gate's: a status outside Issued / Locked (`not_issued`, `status_unrecognised` for a non-empty status the vocabulary does not know, `withdrawn`), an active `document_holds` row or an unreadable hold state (`on_hold` / `hold_unknown`), an unreadable document (`unavailable`), no current revision or a current revision with no file (`no_file`), and a file that is not a PDF on positive evidence (`not_pdf`) — each amber, never red. A legal hold alone is not one (the gate never reads it): such a sheet with a PDF is `notInPack`. (The first pass labelled the print gate's skips "added to the package since printing"; the second pass still sent a file-less or non-PDF sheet to red `notInPack` — the third pass corrected it; the third pass also refused a legal hold the gate does not refuse — the integration fix pass corrected that.) Not classified: a print-time fetch failure or an unparseable PDF — red until a re-print carries it (`VFY-19`).

**Scope / residual.** Packs printed before PKG-2 (2026-08-24) carry legacy QRs and now read grey until re-printed — intended (the default). Which missing sheets the print gate skipped AT PRINT TIME — as opposed to what is true of them now — the snapshot does not record, so the route cannot tell "left out at print" from "added since", and it cannot see a print-time fetch failure or a PDF pdf-lib could not parse (those read red `notInPack`; a corrupt "PDF" would stay red across re-prints): opened as `VFY-19` (owner: document-control P8 FIELD — record the skipped ids and reasons in `work_package_prints`). A re-print records a new snapshot and a fresh QR. A second consequence of the same default, not only pre-PKG-2 paper: a NEW print whose snapshot insert fails (`recordPackagePrint`, `lib/workPackages.ts`, is best-effort and returns null) gets a bare-package cover QR that can never read green, while the packages page reports a successful print — opened as `VFY-18` (owner: document-control P8 FIELD — warn on, or refuse, a print with no snapshot).

---

<a id="vfy-3"></a>

## VFY-3 · /verify/<docId> with no ?v= returns isCurrent:true unconditionally — and lib/downloads.ts stamps exactly that URL onto prints of documents with no current version

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:29-31,90`, `lib/downloads.ts:96-101`, `lib/docPack.ts:104-105`, `app/api/share/file/route.ts:114-115`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real and reachable (documents.current_version_id is nullable, schema.sql:144, while DocumentRecord.fileUrl is not, types/schema.ts:763, so a version-less document can still be printed). But 'unconditionally' is wrong — the docRetired guard at :89 still returns isCurrent:false for Superseded/Archived — and two of the four cited stamp sites actually GUARD against it: lib/docPack.ts:104-105 and app/api/share/file/route.ts:114-116 both emit `verifyUrl: undefined` when versionId is null rather than a bare /verify/<docId>. Only lib/downloads.ts produces the version-less URL, which narrows this to MEDIUM.

**Mechanism.** The guard at route.ts:30 is `if (!UUID_RE.test(docId) || (versionId && !UUID_RE.test(versionId)))` — `v` is optional. isCurrent at :90 is `!docRetired && (!versionId || versionId === d.current_version_id)`: with no versionId the second clause short-circuits TRUE, so the endpoint asserts the paper is current while holding no information whatsoever about which revision the paper is. printedRev comes back null and the page renders 'This print — Rev ?' in emerald beside the giant green CURRENT. buildVerifyUrl emits precisely this URL: `const version = ctx.versionId ?? ctx.doc.currentVersionId; ... return version ? `${base}?v=${version}` : base;` (downloads.ts:99-101) — currentVersionId is optional on DocumentRecord (types/schema.ts:638), and the verify route itself guards `if (d.current_version_id)` at :70, so the author knew it can be null. Two sibling call sites got this right by omitting the QR entirely when there is no version: docPack.ts:104 `versionId && publicOrigin() ? ... : undefined` and share/file/route.ts:114 `versionId && publicOrigin() ? ... : undefined`. downloads.ts does not.

**Failure scenario.** A document ingested without a version row (external-origin import, legacy attachment) is printed. buildVerifyUrl produces yourdomain/verify/<docId> with no ?v=. Anyone who scans it — forever, at any revision, past any number of subsequent rev-ups — gets full-screen emerald 'CURRENT — This print matches the current revision.' The stamp is a permanent green light. Independently, the truncation is trivially reachable by hand: a superseded print whose QR correctly shows red DO NOT USE flips to green the moment the query string is dropped, which is what happens when the URL is retyped from a photograph, bookmarked, or pasted through a system that splits on '?'.

**Evidence.**

```
app/api/verify/route.ts:90 — `const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  |  lib/downloads.ts:99-101 — `const version = ctx.versionId ?? ctx.doc.currentVersionId; const base = `${origin}/verify/${ctx.doc.id}`; return version ? `${base}?v=${version}` : base;`  |  lib/docPack.ts:104-105 — `verifyUrl: versionId && publicOrigin() ? `${publicOrigin()}/verify/${String(d.id)}?v=${versionId}` : undefined` (the correct guard)  |  app/api/verify/route.ts:70 — `if (d.current_version_id) {` (the route's own acknowledgement that it can be null).
```

**Chain reaction.** audit-reports/intelligence/06-document-acl-leaks.md:242 already noted that 'v' is optional, but framed it as a disclosure problem ('a document id alone is sufficient'). The verdict consequence — that the id-only form is not merely readable but affirmatively GREEN — is not covered there.

**Done when.**

- [ ] /api/verify requires both doc and v; a request with doc alone returns a 400 or a distinct 'cannot confirm which revision this print is' verdict, never isCurrent:true
- [ ] buildVerifyUrl returns undefined when no version can be resolved, matching lib/docPack.ts:104 and app/api/share/file/route.ts:114, so no print is stamped with an unqualifiable QR
- [ ] The page has no branch in which it prints 'Rev ?' next to a green CURRENT

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: `const isThisTheCurrentVersion = !versionId || versionId === d.current_version_id;` (`app/api/verify/route.ts:116`) — a doc-only QR read green; `buildVerifyUrl` returned `…/verify/<doc>` with no `?v=` when no version resolved (`lib/downloads.ts:131-133`).
- `/api/verify`: no `?v=` — or a document with no current revision — → verdict `unverifiable` (grey "CAN'T CONFIRM THIS REVISION — this code does not say which revision was printed … do not assume it is"), `isCurrent: false`. (Since the third review fix pass, a code that names its version on a document with no current revision answers `no_current_revision` instead — below.) The held / retired / not-issued verdicts still win: they are true of every print of the document.
- `lib/downloads.ts` `buildVerifyUrl` returns `undefined` when no version resolves — no QR is stamped, the guard `lib/docPack.ts` and `app/api/share/file` already use. (The only change in that file.)
- The page never prints "Rev ?" beside green: a green answer names the printed revision (falling back to the current label — the printed version IS the current one); an unknown rev renders "—" with "not stated on this code"; and the legacy fallback for a payload without `verdict` needs a printed revision before it paints green (`lib/verifyPresent.ts` `presentDocVerdict`).
- Files: `app/api/verify/route.ts`, `lib/downloads.ts`, `lib/verifyPresent.ts`, `app/verify/[docId]/page.tsx`.
- Tests: `verifyRouteVerdict.test.ts` "VFY-3 — a code with no ?v= never reads green" (Issued doc-only → `unverifiable`; Void / held still say so without `?v=`; no current revision → `unverifiable`); `lib/__tests__/verifyDoor.test.ts` "VFY-3 — buildVerifyUrl never stamps a document-only QR"; `verifyPresent.test.ts` (a legacy payload without a printed rev is not green; no blurb prints "Rev ?"; the page's Rev line).
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).
- **Third review fix pass (2026-10-01): one verdict, two meanings, split.** With a valid `?v=` on a document whose `current_version_id` is NULL, the route returned `unverifiable` (`app/api/verify/route.ts:195`, `!versionId || !d.current_version_id`) and the page said "This code does not say which revision was printed" beside "This print: Rev <printedRev>" — false: the code named it. The route now answers `unverifiable` only for a code with no `?v=`, and the new verdict **`no_current_revision`** when the code names its version but the document has no current revision on record: grey "CAN'T CONFIRM THIS REVISION — This document has no current revision on record, so the system cannot confirm this print is current. Do not assume it is — check with Document Control." Never green; the held / retired / not-issued verdicts still win. Files: `app/api/verify/route.ts`, `lib/verifyPresent.ts` (`DocVerdict`, `presentDocVerdict`). Tests: `verifyRouteVerdict.test.ts` (no current revision with `?v=` → `no_current_revision`, the printed rev shown, the scan row records it; the same document doc-only → `unverifiable`); `verifyPresent.test.ts` (both blurbs pinned and distinct, the same advice; `no_current_revision` in the green-only list).

**Done-when.**
1. ✓ A request with `doc` alone returns the distinct "cannot confirm which revision this print is" verdict, never `isCurrent: true` (a verdict rather than a 400, so a held or retired document still says so).
2. ✓ `buildVerifyUrl` returns `undefined` when no version can be resolved.
3. ✓ No branch prints "Rev ?" next to a green CURRENT.

**Scope / residual.** Prints already stamped with a doc-only QR now read grey "can't confirm" (they read green) — the fail-safe direction. A doc-only request still returns the number and title; whether a private / hidden document's title should be withheld is intelligence `DACL-8`'s question, opened here as `VFY-16`.

---

<a id="vfy-4"></a>

## VFY-4 · "NOT YET IN EFFECT" drops hours early: /api/verify reimplements the effective-date comparison in server UTC instead of calling the repo's canonical local-date helper

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:91-94`, `lib/effectiveDate.ts:21-28`, `lib/docControlRegister.ts:187`, `supabase/migrations/20260819_effective_date.sql:17`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The divergence is real but the finding misdiagnoses the fix. effectiveStatusFor is RUNTIME-local, and this is a server route on a UTC host, so calling the canonical helper would compute the identical answer — the two only disagree because the register/badge call sites run in the browser (lib/docControlRegister.ts:187 uses the browser supabase client). A repo-wide grep for timezone/org-locale settings finds none, so there is no plant timezone to compare against; the actual defect is a one-day-boundary disagreement bounded by the UTC offset between the field page and the in-app badge. LOW.

**Mechanism.** `notYetEffective = isCurrent && !!effectiveDate && effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10)` (route.ts:93-94). effective_date is a DATE column (20260819_effective_date.sql:17), so the left side is a calendar date in the plant's frame of reference. The right side is `toISOString()` — the SERVER's UTC calendar date. The repo already has the canonical answer, unit-tested, comparing at LOCAL midnight: `const today = new Date(); today.setHours(0, 0, 0, 0); const eff = new Date(`${effectiveDate.slice(0, 10)}T00:00:00`); if (eff.getTime() > today.getTime()) return "pending";` (effectiveDate.ts:23-27). The in-app register calls it (docControlRegister.ts:187); the public field endpoint does not. On a UTC host serving a US plant, the endpoint's 'today' rolls over 5-6 hours before the plant's does, and the comparison is `>` — strictly greater — so the amber guard releases early, never late.

**Failure scenario.** A revised operating procedure is issued with effective_date 2026-03-02 because it requires a training window. At 19:30 CST on 2026-03-01, a night-shift operator scans the print. The server's UTC date is already 2026-03-02, so '2026-03-02' > '2026-03-02' is false, notYetEffective is false, isCurrent is true, and the page paints emerald 'CURRENT — This print matches the current revision.' The banner the feature exists to show — 'NOT YET IN EFFECT ... until then, keep working to the prior in-force revision' — never appears. In the office the same document still shows its pending badge, because that path goes through effectiveStatusFor in the browser's local time.

**Evidence.**

```
app/api/verify/route.ts:91-94 — `// A published rev with a FUTURE effective date is the latest issue but is not yet in force — the field page must not flash an unqualified green.` / `const notYetEffective = isCurrent && !!effectiveDate && effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10);`  |  lib/effectiveDate.ts:21-28 — the canonical `effectiveStatusFor`, using `today.setHours(0,0,0,0)` and `new Date(\`${effectiveDate.slice(0,10)}T00:00:00\`)`  |  grep for effectiveStatusFor across lib/app/components: called only from lib/docControlRegister.ts:187 and its test — never from the public endpoint.
```

**Chain reaction.** The same UTC-vs-local skew affects lib/effectiveDate.ts:62 `.lte("effective_date", todayISO())`, the daily scan that announces 'now in force' — it can fire the announcement on the evening before, matching the verify page's early green and making the two consistently wrong together rather than catching each other.

> **Verifier correction.** MEDIUM, not HIGH, and two framing points are off. (a) The blast radius is a window of hours on one day per effective date, after which the correct green verdict is what shows anyway. (b) 'The repo already has the canonical answer' oversells the fix: effectiveStatusFor is itself server-local, not plant-local, so calling it from a UTC-hosted route would produce the identical result; lib/effectiveDate.ts also imports lib/supabase and lib/inAppNotifications (:10-12), i.e. the browser client, so it is not directly importable into a route handler. The real fix is an org/plant timezone, which the repo does not appear to have — so 'the endpoint just failed to call the helper' misstates the remedy.

**Done when.**

- [ ] /api/verify imports effectiveStatusFor from lib/effectiveDate.ts rather than open-coding the comparison
- [ ] The comparison is made against the org's configured plant timezone, not the host's, so a UTC deployment and a plant in UTC-6 agree
- [ ] A test pins the clock to 19:30 local on the day before an effective date and asserts notYetEffective is true

**Partial (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: `inForceNow && !!effectiveDate && effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10)` (`app/api/verify/route.ts:138-139`) — the server's UTC date.
- `/api/verify` decides "not yet in effect" with `effectiveStatusFor(effectiveDate) === "pending"` (`lib/effectiveDate.ts`), whose "today" is `effectiveTodayISO()` — document-control P3 LIFECYCLE's one calendar (`REV-9`, DEC-63 §4): the facility's IANA zone named in `NEXT_PUBLIC_FACILITY_TIME_ZONE`, else UTC-12, which can only be late, never early. No parallel helper was created (the plan's `lib/effectiveDateCore.ts` is superseded by P3's module); the route no longer spells a UTC "today" (pinned by test). REV-9 records the swap.
- The page's "comes into force <date>" line now formats the stored calendar DAY — it parsed "2026-03-02" as UTC midnight and printed 1 March anywhere west of UTC (`formatEffectiveDay`, `lib/verifyPresent.ts`).
- **Review fix pass (2026-10-01): the effective-date read fails CLOSED.** `/api/verify` retried without the column on ANY error, ignored the retry's own error and still reached `current`; `/api/verify-package` swallowed any `document_versions` error, so a sheet whose revision was not yet in force read `fresh` and the pack could scan green. Both routes now tolerate only Postgres' undefined_column (`42703` — a pre-20260819 database, which has no dates at all; `isUndefinedColumnError`, `lib/verifyVerdict.ts`); any other error — and an error on `/api/verify`'s column-less retry — is `503` with an `error` scan row, never a verdict. Tests: `verifyRouteVerdict.test.ts` "an effective-date read that ERRORS … is 503" / "a missing effective_date COLUMN (42703) retries without it … and the retry is checked"; `verifyPackageSnapshot.test.ts` "an effective-date read that ERRORS is never green: 503 …" / "only a missing COLUMN (42703) …". Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).
- Files: `app/api/verify/route.ts`, `app/api/verify-package/route.ts`, `lib/verifyVerdict.ts`, `lib/verifyPresent.ts`.
- Tests: `verifyRouteVerdict.test.ts` "VFY-4 / REV-9 — 'not yet in effect' is decided in the facility's calendar …": the clock pinned to 19:30 America/Chicago on 1 March with an effective date of 2 March → `not_yet_effective` / `notYetEffective: true`; 00:30 local on 2 March → `current`; with no zone configured, 19:30 is still `not_yet_effective` (late, never early); the route source carries no UTC today. `verifyPresent.test.ts` `formatEffectiveDay`.
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).
- **Second review fix pass (2026-10-01): record corrected, no code.** The first record marked done-when 2 ✓ and the finding RESOLVED, but "a UTC deployment and a plant in UTC-6 agree" holds only once the deployment names its zone (`NEXT_PUBLIC_FACILITY_TIME_ZONE`) — on every deployment without it (all of them today; the step is unobservable from the repo) the verify page lifts "NOT YET IN EFFECT" up to 18 hours late for a UTC-6 plant, so the two do not agree. Document-control `REV-9` keeps that same operator limb ◐ and OPEN; this record now says the same, so the two no longer contradict each other: done-when 2 ◐, status OPEN.

**Done-when.**
1. ✓ `/api/verify` calls `effectiveStatusFor` from `lib/effectiveDate.ts` (through `effectiveTodayISO`) rather than open-coding the comparison.
2. ◐ Code ✓ — the comparison is made in the facility's zone (`effectiveTodayISO`), so a UTC host and a UTC-6 plant agree once the deployment names the plant's zone; with none named the answer is late by design, never early. **Pending operator step: `NEXT_PUBLIC_FACILITY_TIME_ZONE`** set in every deployment — the operator limb, the same one that keeps document-control `REV-9` OPEN (`document-control/99-fix-sequencing.md`, rule 2); until it is set the two do NOT agree (late by the plant's offset plus 12 hours). A per-ORG zone (one deployment serving plants in different zones) is beyond P3's facility zone; per DEC-31 it is opened as `VFY-15`, not built here.
3. ✓ A test pins the clock to 19:30 local on the day before the effective date and asserts `notYetEffective: true`; an effective date that cannot be READ is never taken for "no date" (503 on both routes).

**Scope / residual.** Stays OPEN for done-when 2's operator limb, alongside document-control `REV-9`: every deployment setting `NEXT_PUBLIC_FACILITY_TIME_ZONE` closes both (no code is left in this finding). The per-org zone is `VFY-15`.

---

<a id="vfy-5"></a>

## VFY-5 · /api/verify and /api/verify-package are blind to active holds — a document under a HOLD scans green while the hold card twenty feet away says the work is stopped

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:34-108`, `app/api/verify-package/route.ts:31-77`, `app/verify-hold/[holdId]/page.tsx:93-94`, `supabase/migrations/20260713_document_publish_guard.sql:70-79`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by reading both routes end to end. A hold blocks publication at the database level but is invisible to the two public endpoints the field actually scans, so a held drawing and its pack both render green while the printed hold card says stop.

**Mechanism.** Neither endpoint references document_holds. A grep for 'document_holds|hold' across app/api/verify/route.ts and app/api/verify-package/route.ts returns exactly one hit, and it is the word 'holding' inside a prose comment. Yet the hold concept is defined in this system as covering the work, not just the publish transition: the hold verify page's own copy is 'Do not advance this document or the work it covers' (verify-hold page.tsx:94), and the database refuses to advance a held document at all (20260713_document_publish_guard.sql:70-79). Three public surfaces therefore answer 'can I use this?' about the same document and only one of them knows about the hold — and it is the one keyed on a hold UUID that a field user only has if the tag is still attached and legible.

**Failure scenario.** An iso drawing goes on hold for 'Field Verification Needed' — the as-built does not match the field. The drawing is not superseded and no new revision exists, so current_version_id is unchanged. A crew scans their print: green CURRENT. They scan the work-package cover: green PACK IS CURRENT. Nothing in either answer mentions that the drawing is under an open hold placed precisely because it cannot be trusted. The hold's own tag is on the equipment in the field, not in the crew's folder.

**Evidence.**

```
grep -rn 'document_holds|hold' app/api/verify/route.ts app/api/verify-package/route.ts → one match, app/api/verify-package/route.ts:4, the word 'holding' in a comment. Zero code references.  |  app/verify-hold/[holdId]/page.tsx:94 — `? "Do not advance this document or the work it covers."`  |  supabase/migrations/20260713_document_publish_guard.sql:74-79 — `SELECT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = NEW.id AND h.released_at IS NULL) INTO v_has_hold; IF v_has_hold THEN RAISE EXCEPTION 'Document has an active hold; ...'`
```

**Done when.**

- [ ] /api/verify returns an activeHolds count for the document and the page renders amber (not green) when it is non-zero, naming the hold categories
- [ ] /api/verify-package marks any sheet with an active hold as not-fresh, or reports holds as a separate non-green condition alongside staleness
- [ ] The three public surfaces give consistent answers about the same document being held

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: document-control `DIST-2` (2026-08-24) made `/api/verify` hold-aware — a `held` verdict, red "ON HOLD — STOP WORK", fail-safe on a read error — but it read `.select("id").limit(1)`, so no count or category reached the page; `/api/verify-package` read no holds at all.
- `/api/verify` reads every unreleased hold's `reason` and returns `activeHolds` (null when unreadable) and `holdReasons` — public CATEGORIES via `publicHoldReason` (operator text → "On hold"); the page names them ("under 2 active holds (Client Review, On hold)"). The colour stays DIST-2's red stop-work, stronger than the criterion's amber.
- `/api/verify-package` reads holds ONCE for every printed sheet (an unreadable hold state holds every sheet); a held sheet reads `held` with its categories ("ON HOLD · Client Review") and the pack `held` ("PACK ON HOLD — STOP WORK").
- `/api/verify-hold` now reports the document's other active holds (`VFY-10`), so all three surfaces agree: a held document is never green on any of them.
- **Review fix pass (2026-10-01).** The first pass overstated done-when 3: `/api/verify-hold` ignored `documents.legal_hold`, so a released card on a legally held document read green "this tag can come down" while `/api/verify` and `/api/verify-package` called the same document ON HOLD. The hold route now reads `legal_hold` with the document label (error checked) and counts it as one more hold in `otherActiveHolds` — counted, never named, exactly as the other two routes publish it (no `legalHold` field; VFY-14's "read for the verdict, never returned") — so the card reads amber "RELEASED — DOCUMENT STILL ON HOLD"; an unreadable or vanished document is `released_others_unknown` (amber). Tests: `verifyHold.test.ts` "released, nothing else in document_holds, but the DOCUMENT is under legal hold → never green …", "legal hold plus … both counted", "a document read that FAILS → released_others_unknown …", "a document row that is not there …". Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).
- **Second review fix pass (2026-10-01): the hold COUNTS agree too.** The verdicts agreed, but `/api/verify`'s `activeHolds` counted only `document_holds` rows (`app/api/verify/route.ts:114`) while `/api/verify-hold` counts the legal hold as one more hold — a document under a legal hold plus hold Y read "2 other holds are still active (Client Review)" on the released X card and "under an active hold (Client Review)" (`activeHolds` 1) on the sheet QR; a legal hold alone was `onHold: true` with `activeHolds: 0`. `/api/verify` now returns `activeHolds = rows + (legal_hold ? 1 : 0)` — the categories unchanged, so the legal hold is counted and never named; an unreadable hold read stays `null`. (`/api/verify-package` publishes no per-sheet count.) Tests: `verifyRouteVerdict.test.ts` "done-when 3 (review fix): the LEGAL hold counts in activeHolds …" (legal + one row → 2, `holdReasons` only the row's; legal alone → 1; unreadable → null) and "the same document shows the same count on the sheet QR and the hold card …" ("under 2 active holds (Client Review)"). Verified (second fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (268 files / 5131 passed, 7 expected-fail); run against the first fix pass's code, 21 of the new / changed assertions fail (DEC-29).
- Files: `app/api/verify/route.ts`, `app/api/verify-package/route.ts`, `app/api/verify-hold/route.ts`, `lib/verifyPresent.ts`, the three pages.
- Tests: `verifyRouteVerdict.test.ts` "VFY-5 — the hold's public categories are named; operator text never is"; `verifyPackageSnapshot.test.ts` "HLD-3 / PHYS-1 / VFY-5 …" (held sheet + category, released hold ignored, legal hold, unreadable → held); `lib/__tests__/verifyHold.test.ts`.
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. Not done as written — replaced by design: `/api/verify` returns the active-hold count and the categories and the page names them, but the colour is RED "ON HOLD — STOP WORK", not the criterion's amber — DIST-2's stop-work design (2026-08-24): a hold stops the work, and amber reads as "proceed with care". Recorded as a deliberate replacement of the amber asked for, not as ✓.
2. ✓ `/api/verify-package` marks a held sheet with its own label and the pack non-green.
3. ✓ The three public surfaces give consistent answers about a held document — a document_holds row, an unreadable hold state or the document's legal hold — after the review fix pass (the hold card ignored the legal hold before it); and, since the second review fix pass, the same hold COUNT (`/api/verify`'s `activeHolds` counts the legal hold as `/api/verify-hold` does).

**Scope / residual.** None here. The printed-copy footer's hold line is document-control P8 FIELD's (`PHYS-1` done-when 4).

---

<a id="vfy-6"></a>

## VFY-6 · /api/verify-hold publishes the hold reason verbatim to the open internet, and the reason field accepts free text — the route's own comment claims free text is withheld

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-hold/route.ts:46-56`, `components/documents/HoldStrip.tsx:190-203`, `supabase/migrations/20260612_phase5_holds.sql:26-33`, `app/verify-hold/[holdId]/page.tsx:110-113`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right on both halves: the route withholds `notes` and `opened_by_name` but publishes `reason` verbatim to an unauthenticated endpoint, and `reason` is exactly the field the UI lets a controller type free text into. app/verify-hold/[holdId]/page.tsx:110-113 prints it under 'Reason' on the public page.

**Mechanism.** The route withholds notes, opened_by_name, released_by_name and released_reason, and says so: 'a photographed hold card must not disclose staff names or free-text operator notes ("waiting on legal re: incident …") to whoever scans it. Status, category, dates, and the doc label suffice' (route.ts:48-53). It then returns `reason: (h.reason as string) ?? null` (:55). But `reason` is not a category. The migration is explicit: 'reason is TEXT with NO check constraint. The four directive-named reasons ... live in the UI's predefined picker; orgs can also enter free-form reasons via "Other"' (20260612_phase5_holds.sql:26-33), and HoldStrip renders an unconstrained `<input ... placeholder="Custom hold reason">` whose value is passed straight to onOpen (HoldStrip.tsx:190-203, :81-88). The verify page then renders it in bold red as the card's most prominent fact (page.tsx:110-113). Alongside it the route publishes docLabel, which falls back to the document TITLE when document_number is null (`String(d.document_number || d.title || d.name || "")`, :43).

**Failure scenario.** Document Control places a hold with the custom reason 'Hold pending OSHA 1910.119 finding — Fuller incident, do not distribute'. printHoldCard produces the red tag; the tag hangs on a unit in an open yard for six weeks. A contractor, a visitor, a journalist, or anyone who photographs the tag scans the QR from outside the fence and, with no login, reads the reason string in bold, plus the drawing number or title, plus the revision, plus the date it was placed. The endpoint refused to show them the operator's note while showing them a field that the schema documents as accepting exactly that kind of note.

**Evidence.**

```
app/api/verify-hold/route.ts:55 — `reason: (h.reason as string) ?? null,`  |  app/api/verify-hold/route.ts:48-53 comment — 'a photographed hold card must not disclose staff names or free-text operator notes ... Status, category, dates, and the doc label suffice'  |  supabase/migrations/20260612_phase5_holds.sql:26-33 — '3. reason is TEXT with NO check constraint. ... orgs can also enter free-form reasons via "Other". The DB is intentionally permissive'  |  components/documents/HoldStrip.tsx:196 — `placeholder="Custom hold reason"` feeding :81-88 `const onOpen = async (reason: string) => { ... reason: reason.trim(), ... }`.
```

**Chain reaction.** This corrects the premise of the verifier note at audit-reports/intelligence/06-document-acl-leaks.md:252, which credited /api/verify-hold with deliberately withholding free text. It withholds one free-text column and publishes another.

> **Verifier correction.** The exposure delta is much smaller than 'publishes to the open internet' implies, and the finding omits the mitigating fact that decides severity: the printed hold card itself already prints the reason in plain text at 13pt bold red AND the free-text notes underneath it (lib/physicalBridge.ts:155-158 — `page.drawText(fit(`Reason: ${input.reason}`, …))` and `if (input.notes) page.drawText(fit(input.notes, …))`). Anyone positioned to scan or photograph the QR is reading that text on the tag regardless. What the endpoint adds is reachability by URL alone (a forwarded link, a photo cropped to the QR) — real, but a category-vs-free-text inconsistency in the route's own contract rather than a new disclosure channel.

**Done when.**

- [ ] The response returns the reason only when it matches the predefined picker vocabulary; a custom reason is reported as a generic category ('Other') to unauthenticated callers
- [ ] Either the reason column is split into reason_code (constrained) plus reason_text (never public), or the free-text path is closed
- [ ] The route comment is corrected to describe what is actually disclosed, including that docLabel falls back to the document title

**Partial (2026-10-01, public-surfaces Round F).** PS-VERIFY. The payload half landed at document-control P5 HOLDS (`HLD-7`, 2026-09-23): `/api/verify-hold` returns `reason` only as a predefined category (`publicHoldReason`, otherwise "On hold"), and the route comment says what is disclosed, title fallback included. This pass:
- **The wording HLD-7 left to this package:** the route adds `reasonWithheld` (true when the stored reason was operator text) and the page renders such a reason as "Not shown online — read it on the printed tag" instead of a "Reason: On hold" that is not a reason. `PUBLIC_HOLD_REASON_FALLBACK` is unchanged.
- **One rule for every hold a public surface names:** `/api/verify` (`holdReasons`), `/api/verify-package` (per-sheet `holdReasons`) and `/api/verify-hold`'s other active holds (`otherHoldReasons`) all publish categories only.
- **HLD-7's page residual:** the hold page shows "Held at Rev N — the document is now at Rev M" when the held and current revs differ (`heldRev`).
- Files: `app/api/verify-hold/route.ts`, `app/verify-hold/[holdId]/page.tsx`, `lib/verifyPresent.ts`.
- Tests: `lib/__tests__/verifyHold.test.ts` "VFY-6 — operator text never leaves; the page is told it was withheld"; `verifyPresent.test.ts` (the page's withheld line and the held-vs-current rev); `lib/__tests__/holds.test.ts` HLD-7 key set updated for the new fields (still no notes, no names).
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when (this pass).**
1. ✓ (HLD-7) A custom reason reaches an unauthenticated caller only as a generic category; the page says it is not shown online.
2. ✗ Not done — neither split nor closed: `document_holds.reason` is still one free-text column and the picker's "Other…" still writes it. The payload guarantee holds (no route publishes it), but the structural guarantee the criterion asks for is a schema / picker change in the holds fleet's files (`components/documents/HoldStrip.tsx`, a migration), not this package's.
3. ✓ (HLD-7) The route comment describes what is disclosed, including the title fallback.

**Scope / residual.** Stays OPEN for done-when 2 — the holds fleet: `reason_code` (constrained) + `reason_text` (never public), or close the "Other…" path.

---

<a id="vfy-7"></a>

## VFY-7 · /d/[number] is not punctuation-forgiving as documented, and silently redirects to a DIFFERENT drawing when the typed number is a substring of another

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/d/[number]/route.ts:19-36`, `app/d/[number]/route.ts:24-25`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed against the file's own header claim at :4-5 ('punctuation- and case-forgiving, same normalization as search'). Additional unclaimed exposure: the supabaseAdmin query at :27-32 is not scoped to any org, so the substring fallback can redirect to a document belonging to a different tenant.

**Mechanism.** Line 20 computes `norm` (lowercased, punctuation stripped) but the database query at :30 uses `raw` — `.ilike("document_number", `%${raw.replace(/[%_]/g, "")}%`)` — with punctuation intact. `norm` is only used at :35 as a tie-break among rows the punctuation-sensitive query already returned. So the comment at :24-25, 'Candidates by loose substring, then the exact normalized match wins (same punctuation-forgiving identity search uses)', describes behaviour that is not implemented: a user who types the number with different separators gets zero candidates and falls through. Separately, :36's fallback `?? (rows ?? [])[0]` redirects to the newest-updated row of a mere substring match when no exact normalized match is present in the window, and `.limit(25)` at :32 means a genuine exact match can be excluded from the window entirely by 25 more-recently-updated partial matches. There is no disambiguation page: the route always 307s to a single document.

**Failure scenario.** A technician reads '2002-D-10001' off a title block and types yourdomain/d/2002 D 10001 (or 2002_D_10001, or 2002.D.10001). The ilike pattern becomes %2002 D 10001% / %2002D10001% — no row matches, and he is dumped on /documents?q=... behind a login wall for a number the system holds. Worse case: he types the short form /d/10001. The ilike matches 2002-D-10001, 2003-P-100012 and SPEC-10001-A; the exact-normalized find fails (norm '10001' matches none of them exactly); the fallback redirects to whichever was updated most recently. He lands on a different drawing, deep-linked with ?doc=<id>, with no indication that the number he typed was not the number he got.

**Evidence.**

```
app/d/[number]/route.ts:20 — `const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");`  |  :30 — `.ilike("document_number", `%${raw.replace(/[%_]/g, "")}%`)` — `raw`, not `norm`  |  :34-36 — `.find((r) => (r.document_number ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "") === norm) ?? (rows ?? [])[0] as { id: string; library_id: string } | undefined;`  |  :24-25 comment — 'Candidates by loose substring, then the exact normalized match wins (same punctuation-forgiving identity search uses); newest update first.'
```

**Chain reaction.** The same `?? rows[0]` fallback is the enumeration primitive already reported as DACL-3 in audit-reports/intelligence/06-document-acl-leaks.md:92-106 (unauthenticated, service-role, not org-scoped, hands out real document and library UUIDs that then feed /api/verify). This finding is the document-control half of the same three lines: even for a fully authorized user typing their own drawing number, the route can resolve to the wrong document — including another tenant's, since there is no org filter, in which case RLS then shows them an empty page for a drawing that exists in their own library.

> **Verifier correction.** HIGH is too strong. The route's own header comment at :6-7 is accurate — 'The target page enforces auth + RLS as always — this route only translates a number into a location; it reveals nothing' — so the failure mode is landing an authenticated user on the wrong document in the viewer, where the document number and title are displayed, not disclosing anything. Worth noting the finding missed the sharper problem on the same lines: the query runs through supabaseAdmin (:10, :26) with no org_id filter, so `rows[0]` can be another org's document id/library_id before RLS stops the target page.

**Done when.**

- [ ] The candidate query matches on a normalized column or expression (e.g. a generated normalized document_number with an index) so the punctuation-forgiving promise in the comment is actually what runs
- [ ] The `?? rows[0]` fallback is removed: zero exact normalized matches means the disambiguation/search page, never a silent redirect to a partial match
- [ ] More than one exact normalized match renders a chooser instead of picking by updated_at
- [ ] The query is scoped to the caller's org (which also closes the cross-tenant half of DACL-3)

**Partial (2026-10-01, public-surfaces Round F).** Record-only — no code in this package (`app/(protected)/documents/page.tsx` and `lib/search.ts` are not PS-VERIFY's files). Verified at `3a3203d`: roles-and-permissions `EGRESS-2` (commit `67e6bdd`) rebuilt `/d/[number]` to do no database work — it bounds the input and forwards the raw number to `/documents?d=` (`app/d/[number]/route.ts:20-31`) — and the protected documents page resolves it CLIENT-SIDE under the caller's RLS with `searchDocuments({ orgId: activeOrgId, query: raw, limit: 25 })` and an exact normalized match, else a pre-filled search (`app/(protected)/documents/page.tsx:93-120`).

**Done-when (this pass).**
1. ◐ The candidate query is the app's own org-scoped search (`lib/search.ts` `searchDocuments`: full-text, then an ILIKE fallback on the raw string) — no normalized column or expression, so a number typed with different separators can still miss and land on the search page (no wrong target; the "punctuation-forgiving" promise is only as good as the search).
2. ✓ No `?? rows[0]` fallback: zero exact normalized matches → the search page, never a redirect to a partial match.
3. ✗ Two exact normalized matches → `rows.find(…)` silently takes the first (newest-updated); there is no chooser.
4. ✓ Org-scoped: `activeOrgId` + RLS; the route holds no service-role client (`lib/__tests__/shortLinkRoute.test.ts`).

**Scope / residual.** Stays OPEN for done-when 1 and 3 — the client-side resolver in `app/(protected)/documents/page.tsx` (with `lib/search.ts` for a normalized candidate match). No package in the current fleet plans owns that change; the integrator assigns it.

---

<a id="vfy-8"></a>

## VFY-8 · A CLOSED work package still scans green "PACK IS CURRENT" — the verdict ignores packageStatus and closed_at entirely

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-package/route.ts:65-76`, `app/verify-package/[packageId]/page.tsx:57-59,89-101`, `app/(protected)/packages/page.tsx:130-147`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The verdict-ignores-closure part is true, but 'ignores packageStatus and closed_at entirely' is not: page.tsx:97 appends `{result.closed ? " (This package has been closed.)" : ""}` to the sentence directly under the headline, so closure IS disclosed on the same screen. The green banner is also literally accurate — every sheet still is the current revision. That mitigation drops this to LOW.

**Mechanism.** `allFresh: sheets.length > 0 && staleCount === 0` (route.ts:73) is a pure revision comparison. packageStatus and closed are computed (:70-71) and returned, but the page's background colour and headline read only allFresh (`result?.allFresh ? "bg-emerald-600" : "bg-red-600"` at page.tsx:58; headline at :89-91). The closed state is demoted to a parenthetical appended to the sub-line: `{result.closed ? " (This package has been closed.)" : ""}` (page.tsx:100). Closing a package is described in the app as stopping the tripwire: 'A closed package stops watching its drawings and disappears from this list' (packages/page.tsx:133) and 'no longer watching its drawings' (:141). The public verdict does not stop.

**Failure scenario.** A turnaround job finishes and the package is closed. Months later the folder resurfaces in a shop drawer and someone scans the cover under 'SCAN BEFORE STARTING WORK'. The pins were never touched after closure, so staleCount is 0 and the phone fills with emerald 'PACK IS CURRENT — Every sheet in this pack is still the current revision', with the closure mentioned in eight words of small type at the end of a sentence. Because closure stops the rev-up notification (notifyPackagesOfRevUp targets OPEN/EXECUTING packages only, lib/workPackages.ts:246-249), the green is also the least trustworthy green in the system: nobody has been watching these drawings since the package closed.

**Evidence.**

```
app/api/verify-package/route.ts:73 — `allFresh: sheets.length > 0 && staleCount === 0,`  |  app/verify-package/[packageId]/page.tsx:58 — `loading || error ? "bg-slate-900" : result?.allFresh ? "bg-emerald-600" : "bg-red-600"`  |  app/verify-package/[packageId]/page.tsx:100 — `{result.closed ? " (This package has been closed.)" : ""}`  |  app/(protected)/packages/page.tsx:133 — `message: "A closed package stops watching its drawings and disappears from this list. Its record is kept."`
```

> **Verifier correction.** Trim the 'demoted to a parenthetical' framing — the closed state is disclosed, just not in the verdict: page.tsx:97 appends `{result.closed ? " (This package has been closed.)" : ""}` to the same bold sub-line directly under the headline, in the same white-on-colour type as the rest of the verdict copy, not buried in the card. Also note the verdict is not stale-blind for closed packs: pins are frozen at close, so any member that advanced afterwards still reads red. The genuine gap is a closed pack whose sheets happen not to have moved reading an unqualified PACK IS CURRENT.

**Done when.**

- [ ] A closed package produces its own verdict state (amber/grey 'PACKAGE CLOSED — this pack is retired, do not work from it') that is not green regardless of pin freshness
- [ ] packageStatus and closed drive the headline and background, not a trailing parenthetical
- [ ] The verdict acknowledges that a closed package's pins are no longer monitored, so freshness is not evidence

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: `allFresh: !snapshotMissing && sheets.length > 0 && staleCount === 0` (`app/api/verify-package/route.ts:116`) ignored `closed_at` / `status`, and the page's colour read only `allFresh` — closure was a trailing parenthetical.
- `/api/verify-package` computes `closed = !!closed_at || status === "closed"` and returns verdict `closed` ahead of every freshness verdict (only an unreadable print record outranks it). The page paints it slate — "PACKAGE CLOSED — DO NOT WORK FROM IT" — with "This work package has been closed. Its pins stopped being monitored when it closed, so freshness here proves nothing." and the advice "A closed package is retired: its drawings are no longer watched, so its sheet list is not evidence that anything is current…".
- Files: `app/api/verify-package/route.ts`, `lib/verifyPresent.ts`, `app/verify-package/[packageId]/page.tsx`.
- Tests: `verifyPackageSnapshot.test.ts` "VFY-8 / VFY-11 — closed and empty packs have their own verdicts" (`closed_at` set; `status` alone); `verifyPresent.test.ts` "VFY-8".
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ A closed package has its own non-green verdict regardless of pin freshness.
2. ✓ `closed` drives the headline and the background.
3. ✓ The verdict says a closed package's pins are no longer monitored, so freshness is not evidence.

**Scope / residual.** None.

---

<a id="vfy-9"></a>

## VFY-9 · A never-issued DRAFT scans GREEN "CURRENT" — /api/verify has no concept of "issued", only of "not superseded"

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:89-90,103-106`, `app/verify/[docId]/page.tsx:99-110`, `lib/downloads.ts:52-68`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the only retirement test is Superseded/Archived, so a document whose status is Draft (or 'In Review', or 'Void' — all offered in components/documents/MetadataEditor.tsx:9 and BulkEditModal.tsx:32) with current_version_id set returns isCurrent:true, and app/verify/[docId]/page.tsx:99 renders 'CURRENT' on emerald with 'This print matches the current revision.' The narrated scenario is slightly off — a submit-for-review draft lands in pending_version_id, not current_version_id (lib/revisions.ts:1550, app/api/intake/upload/route.ts:330), so that particular version scans RED — but the template-filing path above produces exactly the claimed Draft-scans-green state, and Void scanning green is the same hole.

**Mechanism.** isCurrent is a pure deny-list: `!docRetired && (!versionId || versionId === d.current_version_id)` (route.ts:90). documents.status DEFAULT is 'Draft' (supabase/schema.sql, documents table). Any status outside {Superseded, Archived} — Draft, In Review, Void, Locked, or NULL — passes as green. The same repo already has the correct answer in a shared helper: viewerStatusBadge returns `{ label: "Draft — not issued", tone: "caution" }` for Draft and reserves 'Controlled' for Issued/Locked (downloads.ts:55-60). The public page then converts isCurrent:true into the strongest possible affirmative statement.

**Failure scenario.** An engineer downloads an in-progress Draft revision for markup. Because he does not hold the checkout, determineControlState returns 'uncontrolled' and the print is stamped 'UNCONTROLLED — FOR REVIEW ONLY' with a verify QR (downloads.ts:229-240). The paper reaches a contractor. He scans it, because the QR is the authority he was told to trust, and the phone fills with green: 'CURRENT — This print matches the current revision.' A drawing that has never been through review or approval has just been certified as current by the document-control system to an unauthenticated field user. docStatus is present in the JSON but the page only ever reads it in the not-current branch (page.tsx:106-110), so 'Draft' never appears on screen.

**Evidence.**

```
app/api/verify/route.ts:89-90 — `const docRetired = d.status === "Superseded" || d.status === "Archived"; const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  |  lib/downloads.ts:55-60 — `case "Issued": case "Locked": return { label: doc.rev ? `Controlled · Rev ${doc.rev}` : "Controlled", tone: "controlled" }; case "Draft": return { label: "Draft — not issued", tone: "caution" };`  |  app/verify/[docId]/page.tsx:100-102 — headline `{result.notYetEffective ? "NOT YET IN EFFECT" : result.isCurrent ? "CURRENT" : "DO NOT USE"}` with no Draft branch.
```

> **Verifier correction.** Overstated as HIGH. The paper that carries this QR is not silent about its status: the QR is only stamped on the uncontrolled branch (lib/downloads.ts:227-238 and :270-278 — determineControlState at :30-37 returns "controlled" only for the checkout holder, and the controlled branch is a pass-through with no stamp at all), so any print bearing this QR already carries the "UNCONTROLLED — FOR REVIEW ONLY" watermark and the footer "Rev X at time of issue — verify current revision before use" (buildFooterNotice, :81-89). The green sub-line at page.tsx:105 also says only "This print matches the current revision", which is literally true of a Draft. The defect is the missing not-issued branch, not a claim of controlled status.

**Done when.**

- [ ] isCurrent is an allow-list over the issued statuses (Issued, Locked) rather than a deny-list over Superseded/Archived
- [ ] A Draft or In Review document produces a distinct non-green verdict ('NOT ISSUED — this is not an approved revision'), not the red superseded copy and not green
- [ ] docStatus is surfaced on the page in every branch, so the field can see what state the document is actually in

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: DIST-2 had given Draft its own verdict, but the deny-list fall-through (`else verdict = "current"`) still let "In Review", NULL or any unknown status read green, and the page showed `docStatus` in no branch.
- The allow-list (`VFY-1`): anything outside Issued / Locked reads `draft` ("DRAFT — NOT ISSUED") or `not_issued` ("NOT ISSUED — DO NOT USE … not an issued, controlled revision (In Review)") — distinct from the red superseded copy, never green.
- The facts card shows "Document status: <docStatus>" ("Not recorded" when empty; "· on hold" when held) in every branch.
- Files: `app/api/verify/route.ts`, `lib/verifyVerdict.ts`, `lib/verifyPresent.ts`, `app/verify/[docId]/page.tsx`.
- Tests: `verifyRouteVerdict.test.ts` "VFY-1 / VFY-9 …"; `verifyPresent.test.ts` (the not-issued blurb names the status; the page's status line).
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).
- **Third review fix pass (2026-10-01): a status nothing recognises is not called "unapproved".** The editors offer "IFC" (`components/documents/BulkEditModal.tsx` `STATUS_OPTIONS`, `MetadataStagingModal.tsx` `DEFAULT_STATUS_OPTIONS`), which `DocumentStatus`, the pack print gate and this allow-list all reject — so IFC paper, which could scan green on `3a3203d`, read red "NOT ISSUED — DO NOT USE … This is not an approved revision". The verdict stays `not_issued` (never green), but a non-empty status outside the vocabulary (`isRecognisedStatus`, `lib/verifyVerdict.ts`: Issued, Locked, the not-current set, Draft, In Review) now reads red "STATUS NOT RECOGNISED — This document's status (IFC) is not one the system recognises as issued, so this scan cannot confirm the print. Check with Document Control." Draft, In Review and an empty status keep done-when 2's wording. Settling the vocabulary itself is opened as `VFY-20` (owner: document-control), and `20261134`'s inventory now counts the documents whose paper turns red (no status / In Review / IFC / any other). Tests: `verifyPresent.test.ts` "a status the vocabulary does not know (IFC, a free value) is red but NEUTRAL …"; `verifyDoor.test.ts` "the deploy-impact inventory …".
- **Integration fix pass (2026-10-01): the pack page says it too.** As landed, the third pass changed `/verify` only: on the pack page a printed IFC sheet still read `not_issued` — "NOT ISSUED" (`lib/verifyPresent.ts` `sheetLabel`, `:291` at `9bf6744`) — and a package member left out for that status was listed "not issued", while `DEC-65` §1 says such a status is called "not recognised". Now `/api/verify-package` sets the sheet state `status_unrecognised` where `documentStanding` is `not_issued` and `isRecognisedStatus` is false (the same test `/verify` uses), and the row reads "STATUS NOT RECOGNISED"; a missing member with such a status is `notPrintable` `status_unrecognised` ("status not recognised"). The pack verdict and its colour are unchanged: the sheet still counts in `staleCount` and `notIssuedCount` (red; "PACK HAS UNISSUED SHEETS" when that is all), and the missing member is still amber `incomplete`. In Review and an empty status keep "NOT ISSUED". Files: `app/api/verify-package/route.ts`, `lib/verifyPresent.ts`. Tests: `verifyPresent.test.ts` "integration fix — a sheet whose status the vocabulary does not know reads 'STATUS NOT RECOGNISED' …"; `verifyPackageSnapshot.test.ts` "integration fix — a status the vocabulary does not know (%j) is 'status_unrecognised' on the pack page too …" (IFC, a free value, " Issued") and "… a package member left out for an unrecognised status is listed 'status not recognised' …".

**Done-when.**
1. ✓ `isCurrent` is an allow-list over Issued / Locked.
2. ✓ Draft and In Review produce distinct non-green "not issued" verdicts.
3. ✓ `docStatus` is on the page in every branch.

**Scope / residual.** None.

---

<a id="vfy-10"></a>

## VFY-10 · A released HOLD card scans green "this tag can come down" while other holds on the same document are still active — the endpoint has document_id in hand and never asks

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-hold/route.ts:28-32,54`, `app/verify-hold/[holdId]/page.tsx:92-95`, `supabase/migrations/20260612_phase5_holds.sql:20-24`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — the endpoint has document_id in hand and never asks about sibling holds, and multiple concurrent holds are an explicit design goal. But the card is printed per hold (lib/physicalBridge.ts:150-171 stamps one `reason` and one holdId per card) and its own footer at :168 says 'A released hold shows GREEN when scanned — then this tag comes down', so 'this tag can come down' is literally true for that tag; the other hold's card is still hanging and still scans red. Missing-context enhancement rather than a wrong verdict — LOW.

**Mechanism.** `active: !h.released_at` (route.ts:54) is derived from the single hold row addressed by the URL. The route already loads `document_id` (route.ts:29) and already makes a second query against documents (route.ts:37-41) — it simply never queries document_holds for siblings. The holds migration states the opposite as the normal case: 'document_holds is a per-document log, NOT a single-column flag. Multiple holds can be open on the same document simultaneously (typical: "Awaiting Engineering" AND "Missing Vendor Data")' (20260612_phase5_holds.sql:20-24), and the partial unique index is on (document_id, reason) WHERE released_at IS NULL — explicitly permitting many concurrent holds per document. Each hold gets its own printed card (printHoldCard takes a single holdId, physicalBridge.ts:164), so a document with two holds has two red tags, and releasing one turns that tag's QR green.

**Failure scenario.** A vessel drawing carries two holds: 'Field Verification Needed' and 'Missing Vendor Data'. Two red HOLD cards hang on the equipment. Engineering releases the field-verification hold. Someone scans that card and gets full-screen emerald, 'RELEASED — This hold has been released — this tag can come down.' They take the tag down. The vendor-data hold is still open and its card may already have been lost, been rained on, or never printed. The publish guard in the database still refuses to advance the drawing (20260713_document_publish_guard.sql:70-79 raises on any unreleased hold), so the field's physical signal and the database's enforcement now disagree, and the visible evidence says the document is clear.

**Evidence.**

```
app/api/verify-hold/route.ts:54 — `active: !h.released_at,`  |  app/api/verify-hold/route.ts:29 — `.select("id, document_id, reason, notes, opened_by_name, opened_at, released_at, released_by_name, released_reason")` — document_id is fetched and used only to label the doc  |  app/verify-hold/[holdId]/page.tsx:93-95 — `{result.active ? "Do not advance this document or the work it covers." : "This hold has been released — this tag can come down."}`  |  supabase/migrations/20260612_phase5_holds.sql:22-24 — 'Multiple holds can be open on the same document simultaneously (typical: "Awaiting Engineering" AND "Missing Vendor Data").'
```

> **Verifier correction.** Severity dropped to MEDIUM because the released copy is tag-scoped, not document-scoped: app/verify-hold/[holdId]/page.tsx:87 reads "This hold has been released — this tag can come down", which is a true statement about that one tag, and the sibling hold still has its own printed card with its own QR that scans red. The asymmetry is real (the ACTIVE branch at :86 speaks about the document — "Do not advance this document or the work it covers") and worth fixing, but the finding's implied consequence — a worker concluding the document is unheld — is an inference about what someone reads, not something observable from the repo, and the second red tag physically remains in the field.

**Done when.**

- [ ] /api/verify-hold runs a second query for other rows on document_id WHERE released_at IS NULL and returns an otherActiveHolds count (and their reasons)
- [ ] The page renders amber, not green, when this hold is released but siblings remain — with copy along the lines of 'this hold is released, but N other holds are still active on this document; leave the equipment tagged'
- [ ] The green 'this tag can come down' copy is reachable only when zero holds are active on the document

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY — one fix with `PHYS-10`. Reproduced on `3a3203d`: `active: !h.released_at` from the single row (`app/api/verify-hold/route.ts:66`), no sibling read, and green "this tag can come down" on any released card.
- `/api/verify-hold` reads every unreleased hold on the document (filtered by id in code, so the count can never include this hold) and returns `otherActiveHolds` (null when unreadable), `otherHoldReasons` (categories) and a verdict: `active` / `released_others_active` / `released_others_unknown` / `released`.
- The page (`presentHoldVerdict`, `lib/verifyPresent.ts`): green "RELEASED — … no other hold is active on this document — this tag can come down" ONLY for `released`; amber "RELEASED — DOCUMENT STILL ON HOLD — This hold is released, but N other holds are still active on this document (…). Do not advance it, and leave the equipment tagged until every hold is released." when siblings remain; amber "RELEASED — CHECK OTHER HOLDS" when they could not be read; a missing or unknown verdict is never green.
- The printed card says the same (`lib/physicalBridge.ts` `HOLD_CARD_SCAN_LINES`, `PHYS-10` done-when 3).
- **Review fix pass (2026-10-01).** "No other hold" now includes the document's LEGAL hold (`documents.legal_hold`, read with the label, error checked): it counts as one more hold in `otherActiveHolds` with no category, so a released card on a legally held document is amber, never green — the same answer `/api/verify` gives for that document (`VFY-5` done-when 3). An unreadable or vanished document is `released_others_unknown`. `presentHoldVerdict` never prints "0 other holds" (a count it does not have reads "another hold is still active"). Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).
- **Second review fix pass (2026-10-01): the verdict is reachable before `20261073`.** The hold read selected `held_rev_label` (migration `20261073`, document-control wave 1 — not yet confirmed live, DEC-30) with no fallback, and its comment said the column "reads as undefined" before the migration; in fact PostgREST refuses the whole select (undefined_column, `42703`), so every hold-card scan on such a database was a 503 and the sibling / legal-hold verdict never reached the field. The route now retries the read without the column on exactly that error (`isUndefinedColumnError`, `lib/verifyVerdict.ts` — the helper the effective-date reads use) and checks the retry; `heldRev` is then `null` (unknown); any other error is still a 503. Tests: `verifyHold.test.ts` "VFY-10 / PHYS-10 review fix — the verdict reaches the field on a database without 20261073" (42703 → retry without the column → `released_others_active` / `released`, `heldRev` null; a failing retry → 503 + `error` row; the route source) and "the hold read itself failing is a 503" (a non-42703 error is never retried). Verified (second fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (268 files / 5131 passed, 7 expected-fail); run against the first fix pass's code, 21 of the new / changed assertions fail (DEC-29).
- Files: `app/api/verify-hold/route.ts`, `app/verify-hold/[holdId]/page.tsx`, `lib/verifyPresent.ts`, `lib/physicalBridge.ts`.
- Tests: `lib/__tests__/verifyHold.test.ts` "VFY-10 / PHYS-10 — green only when no hold at all remains on the document" (sibling counted and named; nothing else → `released`; an active hold never counts itself; sibling read failure → `released_others_unknown`; hold read failure → 503); `verifyPresent.test.ts` "presentHoldVerdict …" ("this tag can come down" only in `released`); `verifyDoor.test.ts` "VFY-10 / PHYS-10 — the hold card says what the scan answers" (each line fits left of the QR at 9pt, measured with pdf-lib's Helvetica metrics).
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ The route returns the other active holds' count and categories.
2. ✓ Released-with-siblings renders amber with "leave the equipment tagged".
3. ✓ "This tag can come down" is reachable only when zero holds are active on the document — no other document_holds row and no legal hold (the legal-hold half by the review fix pass).

**Scope / residual.** None.

---

<a id="vfy-11"></a>

## VFY-11 · An empty work package scans full-screen red "PACK IS STALE — 0 of 0 sheets changed since this pack was printed"

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-package/route.ts:73`, `app/verify-package/[packageId]/page.tsx:89-101,116-118`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The '0 of 0' red screen is real and reads as nonsense. Severity is overstated: the failure direction is fail-closed (stop work), and the same page prints an accurate corrective line inside the card — page.tsx:118-120 `{result.sheets.length === 0 && (<div ...>This package has no sheets.</div>)}` — so the crew is not told a stale sheet exists that they must go find. Copy/verdict-taxonomy defect, LOW.

**Mechanism.** `allFresh: sheets.length > 0 && staleCount === 0` (route.ts:73) is false for an empty package because of the length guard, not because anything is stale. The page has no zero-sheet branch on the verdict path: it renders the red background, the X icon, the headline 'PACK IS STALE', and the templated sub-line `${result.staleCount} of ${result.sheetCount} sheet${result.sheetCount === 1 ? "" : "s"} changed since this pack was printed — get the new sheets before starting work.` (page.tsx:95-98) with both numbers zero. It also renders the 'Do not work from the outdated sheets' block, gated only on `!result.allFresh` (:120-125). The empty state that does exist, 'This package has no sheets.' (:116-118), is a small grey line inside the card underneath all of that.

**Failure scenario.** A cover sheet is printed for a package whose documents were later all removed, or a QR is scanned for a package assembled but never populated. The crew gets the identical full-screen red STOP they would get for a genuinely superseded pack, telling them zero of zero sheets changed and instructing them to obtain new sheets that do not exist. The two states — 'this pack is dangerous' and 'this pack is empty' — are visually indistinguishable at arm's length, which is precisely the distance the page is designed for.

**Evidence.**

```
app/api/verify-package/route.ts:73 — `allFresh: sheets.length > 0 && staleCount === 0,`  |  app/verify-package/[packageId]/page.tsx:95-98 — `: `${result.staleCount} of ${result.sheetCount} sheet${result.sheetCount === 1 ? "" : "s"} changed since this pack was printed — get the new sheets before starting work.`}`  |  app/verify-package/[packageId]/page.tsx:116-118 — `{result.sheets.length === 0 && (<div className="text-xs text-slate-500">This package has no sheets.</div>)}`
```

**Done when.**

- [ ] sheetCount === 0 yields a distinct verdict state ('NO SHEETS IN THIS PACK — cannot verify') with its own colour and headline
- [ ] The '0 of 0 sheets changed' sentence is unreachable
- [ ] The red STOP treatment is reserved for a package with at least one sheet that is actually stale or retired

**Partial (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: an empty package failed `sheets.length > 0` and rendered red "PACK IS STALE — 0 of 0 sheets changed since this pack was printed".
- Verdict `empty` for a print with no sheets or a legacy package with no members — slate "NO SHEETS IN THIS PACK — This package records no sheets, so there is nothing to verify." It precedes `stale`, and the stale sentence prints a count only when it is non-zero.
- **Review fix pass (2026-10-01).** The red stale sentence no longer calls a not-issued sheet "changed or withdrawn since this pack was printed": `notIssuedCount` is counted apart ("N of M sheets are not an issued, controlled revision"; headline "PACK HAS UNISSUED SHEETS" when that is all that is wrong) — see `VFY-1`. Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).
- **Third review fix pass (2026-10-01).** A package sheet the print gate can never print because its current revision has no file or its file is not a PDF is amber `incomplete`, no longer red (`VFY-2`'s third pass) — and done-when 3 below is restated for what red actually covers now, rather than marked as met word for word.
- **Integration fix pass (2026-10-01): back to OPEN.** The record said RESOLVED while its done-when 3 read ◐ and its residual read "None" — two claims that contradict each other. Done-when 3 as written is not met: red is not reserved for a stale or retired sheet. `DEC-65` §1 records the broadening, but it is a provisional decision this package minted and nobody has ratified, so per DEC-29 it cannot turn ◐ into ✓ on its own; and part of the gap is a red the decision does not justify — a package sheet dropped at print that the route cannot classify (`VFY-19`). Status OPEN, this section a Partial. Also from that pass: a package sheet missing from the pack under a legal hold only now reads red `notInPack` (the print gate does not refuse a legal hold — `VFY-2`'s integration fix), so done-when 3's restatement no longer lists the legal hold among the ambers.
- Files: `app/api/verify-package/route.ts`, `lib/verifyPresent.ts`, `app/verify-package/[packageId]/page.tsx`.
- Tests: `verifyPackageSnapshot.test.ts` "an empty print and an empty legacy package are 'empty' — never the red '0 of 0' stale"; `verifyPresent.test.ts` "VFY-11".
- Reproduced / verified: the new route tests were run against the base routes (the three route files stashed): 55 of 67 failed; all pass after. `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ Zero sheets → its own verdict, colour and headline.
2. ✓ The "0 of 0 sheets changed" sentence is unreachable.
3. ◐ Met in substance, broadened by a provisional, unratified decision (`DEC-65` §1) — not as written. As written, red would fire only when a printed sheet is actually stale or retired. As landed, red is `stale` or `held`, and `stale` also covers a printed sheet that is not an issued revision, has been removed from the package or can no longer be read, and — with every printed sheet fresh — a package sheet a re-print WOULD carry that is not in this pack (`notInPack`: in force, no `document_holds` row, a PDF on file — a legal hold alone does not stop a re-print carrying it). Each red names a concrete sheet the crew must not work from or must get; none is the "0 of 0" nonsense this finding is about. Every sheet the print gate can never print — not issued or status not recognised, withdrawn, under a `document_holds` hold or hold state unknown, unreadable, no current file, not a PDF — is amber `incomplete`, never red (the second review fix pass for the status / hold refusals; the third for no file / not a PDF, which the second pass still sent to red — `VFY-2`). Remaining gap: a sheet dropped at print by a fetch failure or an unparseable PDF reads red until a re-print carries it, and a corrupt "PDF" never would — `VFY-19`.

**Scope / residual.** Stays OPEN for done-when 3 (◐). The remaining gap: a pack whose every printed sheet is good still reads red when a package sheet was dropped at print by a fetch failure or an unparseable "PDF" — the snapshot does not record the builder's skips, so the route reads that sheet as one a re-print would carry (`notInPack`), and a corrupt "PDF" never clears on a re-print. That is `VFY-19` (owner: document-control P8 FIELD — record the skipped sheets and reasons in `work_package_prints`; the route half follows). The rest of the gap is the broadening `DEC-65` §1 records (red also for a held, not issued, removed or unreadable printed sheet and for a printable sheet missing from the pack). Closes when `VFY-19` lands AND the renumbered `DEC-65` §1 is ratified as changing this done-when.

---

<a id="vfy-12"></a>

## VFY-12 · None of the four public endpoints is rate limited or leaves any record that a scan happened — while /api/auth/signup, the one other unauthenticated route, has both

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:22-31`, `app/api/verify-hold/route.ts:17-25`, `app/api/verify-package/route.ts:21-29`, `app/api/verify-ticket/route.ts:38-49`, `app/api/auth/signup/route.ts:6-33`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. The enumeration premise also checks out: app/d/[number]/route.ts is unauthenticated, queries with `supabaseAdmin` (service role, RLS bypassed) on a cross-tenant `ilike` over document_number (:26-32) and redirects with `dest.searchParams.set("doc", match.id)` (:45) — a free document-number-to-UUID oracle feeding /api/verify.

**Mechanism.** Three differently-shaped searches agree. (a) Reading all four routes end to end: each validates a UUID, opens a service-role client, queries, and returns — no throttle, no counter, no insert. (b) `grep -rn 'import' app/d app/api/verify*` returns only next/server, @supabase/supabase-js and lib/supabaseAdmin — these routes cannot reach a rate limiter or an audit logger because they import neither. (c) `grep -rn 'audit|logEvent|recordIntent|insert(' app/api/verify* app/d` returns ZERO MATCHES. The repo does have the pattern: signup counts attempts per x-forwarded-for IP against signup_attempts with a documented fail-open (`if (error) return false; // table absent / transient — fail open`, signup/route.ts:27), for the stated reason 'cap attempts per source IP per hour so nobody can loop it to enumerate accounts' (:6-8).

**Failure scenario.** Two consequences. (1) An attacker who has obtained one document UUID — the DACL-3 chain via /d/[number] supplies them at will — can drive /api/verify at full speed to walk a tenant's register, and nothing throttles it or records it; the operator has no signal an enumeration occurred and no log to hand a PSM auditor afterwards. (2) In the ordinary case, a contractor who scans a superseded print and gets red DO NOT USE generates no record at all. For an OSHA/PSM-regulated document-control system, 'this print was verified as superseded at 07:14 on 12 March and work proceeded anyway' is exactly the evidence that matters after an incident, and the system that showed the warning keeps nothing.

**Evidence.**

```
grep -rn 'audit|logEvent|recordIntent|insert(' app/api/verify app/api/verify-hold app/api/verify-package app/api/verify-ticket app/d → ZERO MATCHES  |  grep -rn 'import' over the same directories → only `next/server`, `@supabase/supabase-js`, `@/lib/supabaseAdmin`  |  app/api/auth/signup/route.ts:6-8 — 'Public, unauthenticated endpoint — cap attempts per source IP per hour so nobody can loop it to enumerate accounts or burn trial orgs.'  |  app/api/auth/signup/route.ts:19-28 — the working per-IP counter this could reuse.
```

> **Verifier correction.** Keep at MEDIUM but narrow the stated risk: the enumeration threat the signup limiter exists to stop does not transfer here, because all four endpoints are keyed on 128-bit UUIDs (guessing is infeasible) and return no file, URL, or person. What is actually missing is (i) request-volume protection on four unauthenticated handlers that each open a service-role client and hit the database, and (ii) any record that a field scan occurred, which for a PSM audit trail is arguably the larger loss.

**Done when.**

- [ ] Each verify endpoint applies a per-IP cap using the signup_attempts pattern (fail-open on a missing table), sized for real field use — a crew scanning a pack, not a script
- [ ] Every scan writes a row (endpoint, target id, verdict, ip, timestamp) so verification is evidence and enumeration is visible
- [ ] The retention/export tables account for the new scan table
- [ ] No new vercel.json cron entry is introduced — a third entry fails deployment on this plan (app/api/cron/maintenance/route.ts:286-291); any pruning rides the existing maintenance route

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: none of the four routes imported anything beyond `next/server`, `@supabase/supabase-js` and (verify-hold) `lib/holds`; no counter, no insert.
- `lib/verifyRateLimit.ts` (new): `checkVerifyRate` counts the caller's `verify_scans` rows in the last hour (the `signup_attempts` / `intake_attempts` pattern; `clientIp` reused from `lib/intakeRateLimit.ts`). Default **1200 per IP per hour** (`VERIFY_MAX_PER_IP_HOUR` overrides) — sized for a crew behind one plant NAT address re-checking a pack, not a script. FAILS OPEN on a read error or a missing table, and never limits an unknown IP. A capped scan gets 429 + `Retry-After: 300` and a fail-safe message ("treat the paper as unverified …") that the pages show on their "Can't verify" screen; it writes no row, so one address adds at most the cap per hour.
- `lib/verifyScanLog.ts` (new): `recordVerifyScan` writes one row per answered scan — `endpoint`, `target_id` (the UUID the QR carried; null for a malformed code), the `verdict` shown (or `invalid` / `unknown` / `error`), `ip`, `user_agent`; bounded lengths; checked (`{ error }`) but never blocking; the missing table is logged once per runtime as the deploy order. All four routes: cap → validate → read → record → answer — invalid and unknown codes are recorded too, so an enumeration is visible.
- Migration `20261134_ps_roundF_verify_scans.sql`: `verify_scans` (RLS on, NO policies, anon / authenticated table grants revoked; indexes `(ip, created_at)`, `(target_id, created_at)`, `(created_at)`) and `prune_verify_scans()` — 90 days, SECURITY INVOKER (no definer rights, so DRLS-16's NULL-uid shape cannot arise), `SET search_path = public`, EXECUTE revoked from PUBLIC / anon / authenticated, granted to `service_role`. One paste: a TEMP before-apply inventory (counts only: table / function / policies already present), `BEGIN … COMMIT`, one final `SELECT (check, ok, n)`. Not widening; re-creates nothing.
- The ONE prune step on the existing maintenance cron (step 4d; no-op until the function exists; no new `vercel.json` entry); a `lib/schemaExpectations.ts` row; `lib/exportTables.ts` `EXPORT_EXCLUDED_TABLES.verify_scans` with its reason (the export-coverage tripwire requires one for every CREATE TABLE — a one-row edit outside the plan's file list, declared to the integrator).
- Files: `lib/verifyRateLimit.ts`, `lib/verifyScanLog.ts`, the four `app/api/verify*/route.ts`, `supabase/migrations/20261134_ps_roundF_verify_scans.sql`, `app/api/cron/maintenance/route.ts`, `lib/schemaExpectations.ts`, `lib/exportTables.ts`.
- Tests: `lib/__tests__/verifyRateLimit.test.ts` (cap, window query, fail-open, unknown IP, no-store answers, row shape, once-per-runtime deploy-order log, never throws); `verifyRouteVerdict.test.ts` "VFY-12 / VFY-13 …" (row from `x-forwarded-for` / `user-agent`; invalid and unknown recorded; 429 at the cap with no row; fail-open; 503 on a read error); scan rows in `verifyPackageSnapshot.test.ts` and `verifyHold.test.ts`; `lib/__tests__/verifyDoor.test.ts` "VFY-12 — migration 20261134 …" (one-paste shape, columns, RLS / no policy / revokes, prune invoker + pinned + grants, the prosrc probe's quoting, nothing earlier re-created, one cron step, schema and export rows). The `dcHotfixAnonExecute`, `searchPathPin`, `migrationSourceOfTruth`, `exportCoverage` and `schemaExpectations` suites pass with the new file.
- **Review fix pass (2026-10-01): the row names the paper.** The first pass kept only `target_id` (the document / package UUID), so two papers of one document were indistinguishable and "this print was verified as superseded" could not say which print. `verify_scans.printed_ref UUID` (nullable) now carries the printing the QR names — `/api/verify`'s `?v=` version id, `/api/verify-package`'s `?print=` print id — through `VerifyScanInput.printedRef` / `verifyScanRow` (UUID-or-null, like the target); the migration's column probe counts eight columns. Tests: `verifyRateLimit.test.ts` (row shape, non-UUID ref → null), `verifyRouteVerdict.test.ts` "the row names WHICH revision's paper was scanned (?v=) …", `verifyPackageSnapshot.test.ts` "VFY-12: the scan row names WHICH printing was scanned (?print=) …", `verifyDoor.test.ts` "VFY-12 evidence: printed_ref …". Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).
- **Second review fix pass (2026-10-01).** (a) The before-apply inventory was `CREATE TEMP TABLE IF NOT EXISTS`, so a second paste in the same SQL-editor session reported the FIRST paste's counts as if taken before this one; it is now `DROP TABLE IF EXISTS pg_temp._ps_f34_before;` then a plain `CREATE TEMP TABLE` (the 20261130–33 shape), and an inventory row says whether `verify_scans.printed_ref` was already there. `ALTER TABLE verify_scans ADD COLUMN IF NOT EXISTS printed_ref UUID;` follows the `CREATE TABLE IF NOT EXISTS`, so a table an earlier draft created without the column gains it and the paste really is idempotent. (b) `/api/verify-ticket` never checked its tickets read's error: an outage answered 404 "Unknown ticket" and wrote verdict `unknown` — an outage reading as an invalid code in this evidence. It now answers 503 "Verification unavailable — try again" with an `error` row, like the other three routes (the verdict, drafting-flow's, is untouched). Tests: `verifyDoor.test.ts` "a second paste never reports the first paste's inventory …", "a verify_scans table an earlier draft created without printed_ref gains it …", "the read's error is checked …"; `lib/__tests__/verifyTicketRead.test.ts` (new: a read error → 503 + `error` row; a missing ticket → 404 + `unknown`; a readable ticket's verdict recorded as shown). Verified (second fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (268 files / 5131 passed, 7 expected-fail); run against the first fix pass's code, 21 of the new / changed assertions fail (DEC-29).
- Pending migration: `supabase/migrations/20261134_ps_roundF_verify_scans.sql` (not applied). Until it is pasted every scan is still answered; nothing is recorded or capped, and the routes log the deploy order once per runtime.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ Each verify endpoint applies a per-IP cap in the signup_attempts pattern, fail-open on a missing table, sized for field use.
2. ✓ Every answered scan writes a row (endpoint, target id, verdict, ip, timestamp — and user agent, per the 2026-09-17 default; and, since the review fix pass, the printing the QR names).
3. ✓ The export coverage excludes the table with a reason, schema health expects it, and the 90-day prune is its retention.
4. ✓ No new `vercel.json` cron entry — the prune rides the existing maintenance route.

**Scope / residual.** The rows carry no org (derivable from the target) and are readable by the service role only — there is no in-app viewer; an operator reads them in SQL. A hold card names no printing (its hold id IS the paper), and a ticket traveler's printed revision is a label (`?r=`), not a UUID, so their rows carry `printed_ref` NULL. The code half is RESOLVED; the record is live only once `20261134` is pasted (DEC-30). Third review fix pass (2026-10-01): the same paste's before-apply inventory also carries four deploy-impact counts — documents with a current revision whose status is empty, "In Review", "IFC" or any other value outside the vocabulary, whose paper turns red under the allow-list (`VFY-9`, `VFY-20`); aggregate counts only, unchanged by the paste (`verifyDoor.test.ts` "the deploy-impact inventory …").

---

<a id="vfy-13"></a>

## VFY-13 · The public verify pages are indexable and carry no robots directive, and the four verdict endpoints send no cache directive of their own

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/layout.tsx:20-40`, `app/verify/[docId]/page.tsx`, `app/verify-package/[packageId]/page.tsx`, `app/api/verify/route.ts:96-108`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both assertions are literally true. Impact is smaller than MEDIUM: all four verify pages are client components that fetch their data from /api/verify* after hydration, so the HTML a crawler is served contains no document number, title or rev — only the URL, which by hypothesis the leaker already had; and package.json pins `"next": "^16.1.0"`, where a route handler reading `req.nextUrl.searchParams` is dynamic and is served uncached with a no-store default, so the missing hand-written Cache-Control carries little practical risk.

**Mechanism.** There is no app/robots.ts, no public/robots.txt (public/ contains only icon-192.png, icon-512.png, icon.svg, sw.js), and the root metadata block (layout.tsx:20-40) sets title, description, keywords, openGraph and appleWebApp but no `robots` field — so nothing marks /verify/*, /verify-package/*, /verify-hold/* or /verify-ticket/* noindex. These pages render document numbers, document titles, work-package names, the full sheet list of a package, hold reasons and plant unit numbers. Separately, none of the four route handlers sets Cache-Control on its NextResponse.json; they rely entirely on the framework's default for dynamic handlers.

**Failure scenario.** A verify URL escapes into anything a crawler reads — an email thread indexed by a vendor portal, a support ticket, a QR-decoder site that logs and republishes decoded URLs, a contractor pasting the link into a public forum asking why his print is red. The page is then eligible for indexing under the plant's own domain, with the document number and title in the crawled body. A search for a drawing number returns a public page confirming it exists, what it is called, and what revision it is at. This is the disclosure surface that audit-reports/intelligence/06-document-acl-leaks.md:240-252 covers from the direct-request side, extended by the fact that nothing tells a crawler to stay away.

**Evidence.**

```
`ls public` → icon-192.png, icon-512.png, icon.svg, sw.js — no robots.txt.  |  `find app -maxdepth 2 -name 'robots*' -o -maxdepth 2 -name 'sitemap*'` → no output.  |  app/layout.tsx:20-40 — the Metadata object contains title, description, applicationName, authors, creator, publisher, keywords, appleWebApp, formatDetection, openGraph; no `robots` key.  |  Verdict fields rendered publicly: app/verify/[docId]/page.tsx:118-121 (docNumber, title), app/verify-package/[packageId]/page.tsx:105-115 (package name and every sheet label), app/verify-hold/[holdId]/page.tsx:100-113 (docLabel, docRev, reason).
```

> **Verifier correction.** SUSPECTED is the correct label and should stay. Discovery is the unproven link: all four surfaces are UUID-addressed, no sitemap exists, and nothing in the app links to them, so a crawler has no path in unless a URL is shared or leaked — meaning the exposure depends on a step nobody can observe from the repo. Note the cache half is also weaker than stated: these are dynamic route handlers reading searchParams, which Next does not cache by default, so the practical gap is the missing explicit no-store on a field-safety answer rather than an actual cached-verdict risk.

**Done when.**

- [ ] The four verify page segments export metadata with robots: { index: false, follow: false }, or an app/robots.ts disallows /verify, /verify-hold, /verify-package, /verify-ticket and /d
- [ ] The four API routes set an explicit Cache-Control: no-store rather than relying on framework defaults, so no intermediary caches a revision verdict
- [ ] A check confirms none of these paths appears in any generated sitemap

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: no `app/robots.ts`, no robots metadata on any verify segment, and no `dynamic` export or Cache-Control on any of the four routes.
- All four routes `export const dynamic = "force-dynamic"` and answer only through `verifyJson` (`lib/verifyRateLimit.ts`) — `Cache-Control: no-store` on every answer, errors and 429 included (this is also public-surfaces `OFF-1` done-when 3); the three pages fetch with `cache: "no-store"`.
- `app/verify/layout.tsx`, `app/verify-package/layout.tsx`, `app/verify-hold/layout.tsx`, `app/verify-ticket/layout.tsx` (new): `robots: { index: false, follow: false, nocache: true }`.
- `app/robots.ts` (new): disallows `/verify/`, `/verify-hold/`, `/verify-package/`, `/verify-ticket/`, `/d/`, `/api/verify`.
- Tests: `verifyDoor.test.ts` "VFY-13 …" (each route's `dynamic`, no bare `NextResponse.json`, the cap and the scan wired; the four layouts' metadata; the robots disallow list; no sitemap lists these paths); `Cache-Control` asserted in the three route suites.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ Both: the four segments carry robots noindex/nofollow, and `app/robots.ts` disallows the scan surfaces and `/d`.
2. ✓ The four API routes send an explicit `Cache-Control: no-store`.
3. ✓ No sitemap exists; the test fails if one lists these paths.

**Scope / residual.** The verification label stays SUSPECTED (discovery of a leaked URL is unobservable from the repo). The service worker's own cache — `OFF-1` done-when 1, 2 and 4 — is PKG-1 SW-OFFLINE's.

---

<a id="vfy-14"></a>

## VFY-14 · The verify routes over-select the exact fields they promise not to disclose, one careless spread away from publishing them

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/api/verify-hold/route.ts:29,35`, `app/api/verify/route.ts:36,56`, `app/api/verify-ticket/route.ts:51`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Nothing is disclosed today — every route hand-builds its JSON, and the `h as Record<string, unknown>` cast at verify-hold:34 is the only place a spread would be easy. The claim is true for verify-hold but over-generalized to 'the verify routes', and it describes a hypothetical future refactor rather than a present defect, so LOW (defensive-coding hardening) rather than MEDIUM.

**Mechanism.** /api/verify-hold selects `notes, opened_by_name, released_by_name, released_reason` (:29) — the four columns its own comment at :48-53 says must never reach a scanner — returns none of them, and then widens the row's type to `const h = hold as Record<string, unknown>` (:35), which is precisely the shape that makes `...h` compile silently. /api/verify selects `superseded_at` on the document (:36) and `superseded_at` on the printed version (:56) and uses neither; the version-level one is the signal that would catch a printed version that was superseded out from under a rolled-back current_version_id. /api/verify-ticket selects `revision_count` (:51) and never reads it, which is why a ticket sitting in REVISION_REQ after an issued Rev 1 — revision_count already incremented, deliverable_rev still '1' (lib/ticketTransitions.ts:253-256) — verifies as green LATEST ISSUE.

**Failure scenario.** Someone adds a field to the hold response — 'the field asked for the expected release date' — and writes `return NextResponse.json({ ...h, active: !h.released_at, ... })` because h is already a Record<string, unknown> and the select already contains everything. opened_by_name, released_by_name, released_reason and the operator's notes ship to the open internet in one line, past a code review that sees a one-field change. Nothing in the type system objects, because the guarantee lives only in a prose comment and in the discipline of hand-listing the response keys.

**Evidence.**

```
app/api/verify-hold/route.ts:29 — `.select("id, document_id, reason, notes, opened_by_name, opened_at, released_at, released_by_name, released_reason")` against :48-53 — 'a photographed hold card must not disclose staff names or free-text operator notes'  |  app/api/verify-hold/route.ts:35 — `const h = hold as Record<string, unknown>;`  |  app/api/verify/route.ts:36 and :56 — `superseded_at` selected twice, referenced nowhere in the response at :96-108  |  app/api/verify-ticket/route.ts:51 — `revision_count` selected, referenced nowhere in the verdict at :62-93.
```

**Chain reaction.** The unread revision_count is the same class of defect as the already-CONFIRMED ticket finding (audit-reports/roles-and-permissions/06-request-workflow.md:109 and WF-21 at :954-964: the verdict is computed from deliverable_rev and never reads ticket status) — the route fetches the fields that would make it correct and ignores them.

> **Verifier correction.** Downgraded to SUSPECTED: no spread operator exists in any of these handlers — every response is an explicit object literal — so this is latent hygiene, not an observable leak, and the finding's 'one careless spread away' is a hypothetical. The bundled verify-ticket sub-claim is also wrong as diagnosed. lib/ticketTransitions.ts:254-258 (engineer_request_revision) bumps revision_count and leaves deliverable_rev at '1', so verify-ticket returns verdict 'current' — but that verdict is defensible, since Rev 1 genuinely IS the latest issued deliverable; the endpoint's 'revision_in_progress' state (:80-81) is keyed on a letter rev appearing, i.e. once a draft is submitted. The gap is that REVISION_REQ before resubmission is invisible, not that a superseded print reads green.

**Done when.**

- [ ] Each verify route selects only the columns it actually returns, so the public contract is enforced by the query rather than by a comment
- [ ] The row is typed with an explicit interface rather than Record<string, unknown>, so a spread cannot compile
- [ ] revision_count is either used in the ticket verdict or dropped from the select

*Cross-area note (2026-09-30, intelligence Round G): handed over from intelligence `DACL-8` (and `DACL-3` criterion 3) — no verify route checks visibility. The default carried with it: for a private or hidden document answer "current / superseded" without the number or title (fail-safe, less disclosure). DACL-8 also asks `/api/verify` to require the version id or a per-print token. No VFY finding covers the private / hidden refusal and PS-VERIFY's plan does not list it yet; the integrator adds it (or public-surfaces opens a VFY finding).*

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY. Reproduced on `3a3203d`: `/api/verify` selected `superseded_at` on the document (`:37`) and the printed version (`:76`) and used neither; `/api/verify-hold` widened its row to `Record<string, unknown>` (`:42`); `/api/verify-ticket` selected `revision_count` (`:75`) and never read it. (The hold route's notes / names were already out of its select — P5 `HLD-7`.)
- `/api/verify` selects `id, document_number, title, name, rev, status, current_version_id, legal_hold`, the printed version's `revision_label, created_at, record_id` and the holds' `reason` — each row an explicit interface.
- `/api/verify-hold`: `HoldRow` / `DocLabelRow` / `SiblingRow` interfaces — no `Record<string, unknown>`, so a `...hold` spread cannot compile a column into the response.
- `/api/verify-package`: typed rows for every read.
- `/api/verify-ticket`: `revision_count` dropped from the select and the row type; its verdict (drafting-flow's) is untouched.
- Tests: `verifyRouteVerdict.test.ts` "VFY-14 — the route selects only what it uses"; `verifyHold.test.ts` "VFY-14 …"; `verifyDoor.test.ts` "VFY-14 — verify-ticket selects only what it reads"; `lib/__tests__/sweepRoundE_A.test.ts`'s verify-ticket verdict tests pass unchanged.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ Each route selects only what its verdict or its response uses (`record_id`, `status`, `legal_hold`, `current_version_id` are read for the verdict and never returned).
2. ✓ Rows are explicit interfaces.
3. ✓ `revision_count` is dropped from the ticket select.

**Scope / residual.** The cross-area note above (intelligence `DACL-8`: no verify route checks visibility) is opened as `VFY-16`; it is not in this package's plan.

---

<a id="vfy-15"></a>

## VFY-15 · Effective dates are decided in ONE deployment-wide facility zone — a deployment whose orgs run plants in different zones has no per-org calendar, so "NOT YET IN EFFECT" can lift early for one org's field scans

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/effectiveDate.ts` (`effectiveDateTimeZone`, `effectiveTodayISO`, `effectiveStatusFor`, `scanEffectiveDates`), `app/api/verify/route.ts` (the `effectiveStatusFor` call)
- **Independently verified:** — opened 2026-10-01 by public-surfaces Round F (PS-VERIFY) from `VFY-4` done-when 2 ("the org's configured plant timezone"), per DEC-31; verified against the branch, not yet challenged by a second party.

**Mechanism.** Document-control P3 LIFECYCLE (`REV-9`, DEC-63 §4) made one calendar decide "in effect" everywhere — the badge, the suppression watermark, the daily scan and, since PS-VERIFY, `/api/verify`: `effectiveDateTimeZone()` reads `NEXT_PUBLIC_FACILITY_TIME_ZONE` (one IANA zone per DEPLOYMENT), else UTC-12. There is no org or library zone column, and nothing passes an org to the resolver. A deployment that serves more than one org can name only one zone, so every other org's effective dates are decided in a calendar that is not its plant's.

**Failure scenario.** One deployment hosts a Houston org and a Perth org and is configured `America/Chicago`. A Perth procedure is made effective 2 March for a training on 1 March. The Perth crew scans the print at 09:00 on 2 March local (19:00 on 1 March in Chicago): the verify page still says "NOT YET IN EFFECT" — late, the safe side. The mirror case is the unsafe one: a deployment configured for Perth serving a Houston org lifts the banner on a Houston procedure effective 2 March at 10:00 on 1 March Houston time — fourteen hours early. (With no zone configured the fallback is UTC-12, which is never early anywhere — only late.)

**Evidence.**

```
lib/effectiveDate.ts — effectiveDateTimeZone(): const raw = (process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE ?? "").trim(); … return raw;  (no org argument)
app/api/verify/route.ts — else if (effectiveStatusFor(effectiveDate) === "pending") verdict = "not_yet_effective";
DEC-63 §4 Reversal (4): "An org / library zone setting replaces the deployment variable."
```

**Done when.**

- [ ] An org (or library) time-zone setting exists, and the resolver takes the document's org and prefers that setting over the deployment variable (DEC-63 §4, reversal 4 — "changes `effectiveDateTimeZone()` and nothing else")
- [ ] `/api/verify`, the badge, the suppression watermark and the daily scan pass the document's org to the resolver
- [ ] A test pins two orgs in different zones deciding the same effective date differently at the same instant

**Owner.** Unassigned — a settings column plus a resolver signature change across the four callers (document-control P3's module); not built in PS-VERIFY (DEC-31).
- **Assigned:** admin-and-org P8 (org-admin surfaces — its file set holds the org settings page, where a per-org time-zone setting lives; the resolver change in `lib/effectiveDate.ts` follows it) — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).

---

<a id="vfy-16"></a>

## VFY-16 · The public verify endpoints answer for a private or hidden document with its number and title — no verify route reads `documents.visibility` (intelligence `DACL-8` / `DACL-3` criterion 3, handed over)

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts` (the `documents` select and the `docNumber` / `title` response fields), `app/api/verify-package/route.ts` (each sheet's `label`), `app/api/verify-hold/route.ts` (`docLabel`)
- **Independently verified:** — opened 2026-10-01 by public-surfaces Round F (PS-VERIFY) so the intelligence handover on `VFY-14` is a finding rather than a note (DEC-31: not in PS-VERIFY's plan, not built here); re-read against the branch, not yet challenged by a second party.

**Mechanism.** The three document-bearing verify routes select by UUID with the service role and never read `documents.visibility` (or the ACL index). `/api/verify` returns `docNumber` and `title`, `/api/verify-package` labels every sheet `document_number || title || name`, `/api/verify-hold` returns `docLabel` with the same fallback. The UUID is the only authorization — by design for a field scan (`PHYS-4`, WONTFIX) — but a private or hidden document's title is then disclosed to whoever holds its UUID, which intelligence `DACL-8` asks to stop.

**Failure scenario.** A hidden document (an incident investigation drawing) appears in a work pack that leaves site on a contractor's traveler. The cover's print QR lists the sheet's number and title to anyone who scans it.

**Evidence.**

```
app/api/verify/route.ts — .select("id, document_number, title, name, rev, status, current_version_id, legal_hold") … docNumber: d.document_number || d.name || null, title: d.title || null
app/api/verify-package/route.ts — label: labelOf(s.document_id, s.label)  →  document_number || title || name || the snapshot label
app/api/verify-hold/route.ts — docLabel = String(d.document_number || d.title || d.name || "")
grep -n "visibility" app/api/verify*/route.ts → no match
```

**Done when.**

- [ ] For a private or hidden document the verify routes answer the verdict without the number or title (the default `DACL-8` carried: fail-safe, less disclosure) — `/api/verify`, each pack sheet, and the hold's document label
- [ ] A test pins it on all three routes, including an unreadable visibility (treated as hidden)
- [ ] `DACL-8` criterion 1 and `DACL-3` criterion 3 are closed by pointer

**Owner.** Unassigned — the integrator assigns it (the verify routes are PS-VERIFY's files this round; this pass did not take it because the plan does not list it).
- **Assigned:** intelligence I-12 DOCUMENT ACL BOUNDARY (the document-ACL visibility limb: one read predicate, applied to the three verify routes once PS-VERIFY has merged — I-12 runs last) — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).

---

<a id="vfy-17"></a>

## VFY-17 · The pack print gate admits a legacy EMPTY-status document that the verify allow-list refuses — a just-printed pack can never scan green

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/docPack.ts` (`filterPackDocs` — `if (status && status !== "Issued" && status !== "Locked")`), `lib/verifyVerdict.ts` (`documentStanding` — an empty status is `not_issued`), `app/api/verify-package/route.ts` (the per-sheet state)
- **Independently verified:** — opened 2026-10-01 by public-surfaces Round F (PS-VERIFY) from the review of `VFY-1` (its residual), per DEC-31; verified against the branch, not yet challenged by a second party.

**Mechanism.** Document-control `PKG-4`'s gate refuses every status outside Issued / Locked — but only when a status is present: `if (status && …)` lets an empty / NULL status through as "pre-status legacy data", so the sheet is printed and recorded in the print snapshot. `VFY-1`'s allow-list (`documentStanding`) reads the same empty status as `not_issued`, never in force. The two gates disagree for exactly those rows.

**Failure scenario.** A package holds one legacy sheet whose status was never set. The pack prints cleanly — the sheet is admitted, the cover lists it — and the crew scans the cover a minute later: red "PACK HAS UNISSUED SHEETS — 1 of N sheets is not an issued, controlled revision" (the wording the review fix pass gave it; before that it read "changed or withdrawn since this pack was printed"). Fail-safe, but the pack can never read green, and the printer was never told why.

**Evidence.**

```
lib/docPack.ts — const status = String(d.status ?? ""); if (status && status !== "Issued" && status !== "Locked") { skipped.push(…); continue; }
lib/verifyVerdict.ts — if (IN_FORCE_STATUSES.has(s)) return "in_force"; return "not_issued";   (s = status ?? "")
```

**Done when.**

- [ ] `filterPackDocs` refuses an empty / NULL status with a reason the printer sees ("no status — not an issued, controlled revision"), so the print gate and the verify allow-list agree
- [ ] A test pins an empty-status document refused at print and `not_issued` at verify

**Owner.** Document-control P8 FIELD (`lib/docPack.ts` is its file; PS-VERIFY may not edit it this round).

**Resolution (2026-10-01, document-control Round F wave 2).** Document-control P8 FIELD (`lib/docPack.ts`). Reproduced at `55e281d`: `filterPackDocs` refused a status only `if (status && status !== "Issued" && status !== "Locked")`, so an empty or NULL status passed the print gate (the base test "tolerates a legacy row with no status at all" pinned it), while `documentStanding` read the same row as `not_issued`.
- **The print gate IS the verify allow-list.** `filterPackDocs` decides "in force" with `documentStanding` (`lib/verifyVerdict.ts`) — Issued / Locked only, retirement from `NOT_CURRENT_STATUSES` — with no status list of its own.
  - An empty / NULL / blank status is refused with "no status — not an issued, controlled revision" (code `not_issued`), which the printer sees in the toast and which the print snapshot records as left out (`VFY-19`).
  - A withdrawn status is refused with code `withdrawn`.
  - "IFC", "In Review" or any other value is still refused with its own name, as before (`VFY-20` stays open on the vocabulary).
- Tests:
  - public-surfaces `lib/__tests__/verifyPackageSnapshot.test.ts` "VFY-17 — the pack print gate and the verify allow-list agree on an EMPTY status": `""` / `null` / `undefined` are refused at print and `not_issued` at verify, Issued passes both, and the gate carries no parallel status literal.
  - `lib/__tests__/docPackFilter.test.ts`: the base "tolerates a legacy row" test is inverted to "refuses a legacy row with no status at all".
  - `dcRoundFField.test.ts` "VFY-17 — the builder refuses an empty-status sheet".

**Done-when.**
1. ✓ `filterPackDocs` refuses an empty / NULL status with a reason the printer sees, so the print gate and the verify allow-list agree.
2. ✓ A test pins an empty-status document refused at print and `not_issued` at verify.

**Scope / residual.** None for this finding. A legacy empty-status sheet is now left out of every pack until its status is set; the toast and the scan say why.

---

<a id="vfy-18"></a>

## VFY-18 · A print whose snapshot insert fails still ships, with a bare-package cover QR that can never read green — and the packages page reports success

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/workPackages.ts` (`recordPackagePrint` — returns null on any insert error), `app/(protected)/packages/page.tsx` (`buildCoverAfter` passes `printId` null to `buildPackageCover`), `app/api/verify-package/route.ts` (a QR with no print id is `unconfirmed_print`)
- **Independently verified:** — opened 2026-10-01 by public-surfaces Round F (PS-VERIFY) from the review of `VFY-2` (its residual), per DEC-31; verified against the branch, not yet challenged by a second party.

**Mechanism.** `recordPackagePrint` is best-effort: `if (error) return null;` and a thrown error also returns null. The packages page's comment says so ("on failure the print proceeds with the legacy package-level QR") and builds the cover with `printId` null. Since `VFY-2`'s fail-safe default (`DEC-65` §2), a cover QR with no print id is grey "CAN'T CONFIRM WHICH PRINTING" on every scan — so a pack printed TODAY reads like a pre-PKG-2 legacy pack, while the printer saw a success toast. (As opened, the cover also told the crew "Green = this pack is current"; since `VFY-2`'s integration fix pass its legend says "GREY = the scan cannot confirm this pack — check with Document Control before work", so the grey answer is at least the one the paper names.)

**Failure scenario.** A transient insert error (or a `work_package_prints` RLS refusal) during "Print pack". The PDF downloads, the toast says success, the crew gets the folder. Every scan of its cover is grey; the crew calls Document Control, who see nothing wrong with the package.

**Evidence.**

```
lib/workPackages.ts — const { data, error } = await supabase.from("work_package_prints").insert({…}).select("id").single(); if (error) return null;
app/(protected)/packages/page.tsx — const printId = await recordPackagePrint({…}); return buildPackageCover({ packageId: pkg.id, printId, … });
app/api/verify-package/route.ts — else if (!printConfirmed) verdict = "unconfirmed_print";     // VFY-2 legacy QR
```

**Done when.**

- [ ] When `recordPackagePrint` returns null, the print either stops before the PDF is produced (the PKG-6 "gate before any side-effect" order) or completes with a WARNING that names the consequence ("this pack's cover cannot be verified — re-print it"), never a plain success
- [ ] A test pins the null-snapshot path

**Owner.** Document-control P8 FIELD (`lib/workPackages.ts` and the packages page are its files; PS-VERIFY may not edit them this round).

**Resolution (2026-10-01, document-control Round F wave 2).** Document-control P8 FIELD (`lib/workPackages.ts`, the packages page). Reproduced at `55e281d`: `recordPackagePrint` answered `null` on an insert error or a throw, and the page built the cover with `printId` null, so the pack shipped with a bare-package QR (grey "CAN'T CONFIRM WHICH PRINTING" on every scan) under a success toast.
- **The print stops.** `recordPackagePrint` is a checked write. A refused or failed insert, or one that returns no id, throws `PackagePrintNotRecordedError`: "The pack was NOT printed: its print record could not be written (…), so its cover QR could never be verified in the field. Nothing was downloaded and no pins moved — try again …".
  - It is thrown from the cover step (`buildCoverAfter`), which runs before the PDF is saved. So no PDF is produced, no download is triggered, no `download_audits` row is written and no pin moves (PKG-6's order).
  - The page's catch shows it as "Couldn't print the pack".
  - The pre-migration "return null" tolerance is gone: `work_package_prints` has been live since `20261028` (applied 2026-08-24).
- Tests: `lib/__tests__/dcRoundFField.test.ts` "VFY-18 — a print whose snapshot cannot be written stops before anything is downloaded": a refused insert throws, while a written one returns its id; thrown from the cover step, it leaves no download, no record and no pins; the page no longer calls the snapshot best-effort.

**Done-when.**
1. ✓ When the snapshot cannot be written, the print stops before the PDF is produced (the first branch), never a plain success.
2. ✓ A test pins the null-snapshot path.

**Scope / residual.** None for this finding. Document-control `PKG-6`'s recorded residual ("`recordPackagePrint` stays best-effort") no longer holds.

---

<a id="vfy-19"></a>

## VFY-19 · The print snapshot does not record which package sheets the print gate LEFT OUT, so the pack verdict cannot tell "left out at print" from "added since printing"

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/packages/page.tsx` (`handlePrintPack` → `recordPackagePrint({ sheets: includedSheets … })` — `assessment.skipped` and `result.skipped` reach only the toast), `lib/workPackages.ts` (`recordPackagePrint`; `addDocumentToPackage` stamps `added_at: new Date().toISOString()`), `lib/docPack.ts` (`filterPackDocs` / `assessPackDocs` / the builder's "no current file" and fetch-failure skips), `app/api/verify-package/route.ts` (`notInPack` / `notPrintable`)
- **Independently verified:** — opened 2026-10-01 by public-surfaces Round F (PS-VERIFY, second review fix pass) from the review of `VFY-2` done-when 4, per DEC-31; verified against the branch, not yet challenged by a second party.

**Mechanism.** A print snapshot (`work_package_prints.sheets`, PKG-2) lists only the sheets that rode into the PDF. The sheets the PKG-4 gate refused (not Issued / Locked, held, an unreadable hold state) and the ones the builder dropped (no current file, a fetch that failed) are shown to the printer in the toast and then forgotten. When the cover is scanned, `/api/verify-package` sees a package sheet that is not on the paper and cannot know whether it was left out at print or added afterwards. The second review fix pass of `VFY-2` stopped the route guessing: it splits those sheets by what is true NOW — `notPrintable` (cannot be printed now: amber `incomplete`) and `notInPack` (could be printed now: red, "in the package but not in this pack") — and never says "added since printing". `work_package_documents.added_at` cannot settle it either: it is stamped by the adding browser's clock, while `printed_at` is the database's. Since `VFY-2`'s third review fix pass the route also classifies, from what is true now, a current revision with no file (`no_file`) and a file that is not a PDF (`not_pdf`) — both amber. What it still cannot see is a fetch that failed at print and a file that looks like a PDF but pdf-lib could not parse: both read red `notInPack`, and a corrupt "PDF" stays red across every re-print.

**Failure scenario.** A sheet is Issued and in the package when the pack is printed, but its file fetch fails; the toast lists it as left out and the crew gets the folder without it. On the scan the route can say only "in the package but not in this pack" — it cannot add "it was left out of this printing because its file could not be fetched", which is what the printer saw and what Document Control needs to act on. Conversely, a sheet added an hour after printing reads the same — the crew is never told it is NEW.

**Evidence.**

```
app/(protected)/packages/page.tsx — recordPackagePrint({ …, sheets: includedSheets.map((s) => ({ documentId, versionId, revLabel, label })) })   // skipped sheets are not passed
app/(protected)/packages/page.tsx — const leftOut = [...assessment.skipped, ...result.skipped];   // shown in the toast only
lib/workPackages.ts — added_at: new Date().toISOString(),   // client clock
app/api/verify-package/route.ts — const offPaperIds = printConfirmed && !snapshotMissing ? [...inPackage].filter((id) => !onPaper.has(id)) : [];
```

**Done when.**

- [ ] The print snapshot records the sheets left out of that printing with their reason (e.g. a `skipped: [{documentId, label, reason}]` array on `work_package_prints`, or a sibling column), written by the same `recordPackagePrint` call from `assessment.skipped` and the builder's skips
- [ ] `/api/verify-package` reads it: a missing sheet that the snapshot lists as skipped is reported as "left out of this printing — <reason>", and only a missing sheet that is NOT listed and joined after `printed_at` (a database-stamped `added_at`, or the snapshot's own member list) is reported as "added to the package since printing"
- [ ] A test pins the three cases: skipped at print, added since, and a pre-change snapshot (no skipped list) which keeps the present-tense split

**Owner.** Document-control P8 FIELD (`lib/workPackages.ts`, `lib/docPack.ts` and the packages page are its files; the route half is a few lines in `app/api/verify-package/route.ts` once the snapshot carries the list — whoever owns the verify routes that round).

**Resolution (2026-10-01, document-control Round F wave 2).** Document-control P8 FIELD. The record shape is coordinated with `/api/verify-package`; the route half is a narrow edit to PS-VERIFY's merged files. Reproduced at `55e281d`: the page passed only `includedSheets` to `recordPackagePrint`. `assessment.skipped` and the builder's skips reached the toast and nothing else, so the route could not tell "left out at print" from "added since".
- **The record — no migration.** The print snapshot's existing `sheets` JSONB (`work_package_prints.sheets`, `20261028`) now carries:
  - every printed sheet with `printed: true`;
  - every package sheet that print LEFT OUT with `printed: false`, a code and the reason the printer saw (`leftOutReason`, never published), plus the revision the builder tried when it got that far. The codes (`lib/packLeftOut.ts`): `not_issued` / `withdrawn` / `on_hold` / `hold_unknown` / `unreadable` / `ack_required` / `no_file` / `fetch_failed` / `unreadable_pdf`.
  - `printSnapshotSheets` (`lib/workPackages.ts`) builds it, and `recordPackagePrint` takes `leftOut`. The page passes the gate's refusals and the builder's own (`buildCoverAfter` now receives the builder's skips; `mergeLeftOut` dedupes by document).
  - A snapshot written before this change has no `printed` key anywhere — the marker that tells the two apart.
- **The route** (`app/api/verify-package/route.ts`, the narrowest edit):
  - It reads `printed: false` entries as left out, never as paper.
  - From a marker snapshot, each package sheet missing from the paper also carries WHEN: `leftOutAtPrint: <code>` when the snapshot lists it, `addedSincePrint: true` when it does not. The snapshot's own entries are the package's membership as the printer saw it.
  - A file the print could not read as a PDF, which is still the current revision, is amber `not_pdf` (a re-print cannot carry it either) instead of red on every re-print.
  - An older snapshot keeps the present-tense split with neither field, and nothing says "added since".
  - Only the code is published, never the printer's free text (DEC-65's facts-only contract).
- **The page** (`app/verify-package/[packageId]/page.tsx`) appends, from `missingSheetWhen` (`lib/packLeftOut.ts`), "— left out of this printing — its file could not be fetched when printed" or "— added since this pack was printed". `lib/verifyPresent.ts`: the two optional fields are added to the `notInPack` / `notPrintable` types only; the verdicts and headlines are unchanged.
- Tests:
  - public-surfaces `lib/__tests__/verifyPackageSnapshot.test.ts` "VFY-19 — the snapshot records what the print LEFT OUT …" (six), covering the three cases the done-when names:
    - skipped at print: a fetch failure printable now is red with `leftOutAtPrint`; a hold that still holds is amber with the reason and the when; an unreadable PDF still current is amber `not_pdf`, and red once a new revision lands;
    - added since: printable is red, not printable is amber, both `addedSincePrint`;
    - a pre-change snapshot: no when-fields, no "added".
    - Also the page's words, and that the free text is never published.
  - The PS-VERIFY pin "the page never says 'added … since printing'" is re-pointed at the route's gated fields.
  - `dcRoundFField.test.ts` "VFY-19 — the snapshot records the sheets the print left out, with a code" (the snapshot shape, `recordPackagePrint` writes it, `mergeLeftOut`, the page's wiring).
- **Fix pass (review findings).** `unreadable_pdf` was the builder's catch-all for anything after the fetch, so a `copyPages` failure or a tablet running out of memory merging a large but VALID PDF was recorded as "could not be read as a PDF" — and the route then downgraded that still-current sheet from red to amber `not_pdf` ("a re-print would leave it out too"), which a desktop re-print would not. `lib/docPack.ts` now tags `unreadable_pdf` only when pdf-lib could not load the file or the loaded file is encrypted (the stamper's refusal); any later failure is the new code `build_failed` ("its file could not be added to the pack when printed", `lib/packLeftOut.ts`), which the route leaves red in `notInPack`. No route change: only `unreadable_pdf` earns the amber rule. Tests: `dcRoundFField.test.ts` (an encrypted file is `unreadable_pdf`; an out-of-memory `copyPages` is `build_failed`), `verifyPackageSnapshot.test.ts` ("a sheet the print could not ADD … stays RED"), and the PS-STAMP pin in `stampingRotation.test.ts` re-pointed at the classification.
- **Fix pass 2 (review findings).** The first fix pass's claim that "a tablet running out of memory … is `build_failed`" held only for `copyPages`. pdf-lib parses the whole file inside `PDFDocument.load`, which is where a large valid scan most likely runs out of memory. A throw there left the parsed file unset, and "not loaded" was read as "could not be read as a PDF", so the sheet was tagged `unreadable_pdf` and a still-current sheet turned amber. Now `packBuildFailureCode(e, { loaded, encrypted })` (pure, `lib/docPack.ts`) decides the code:
  - `unreadable_pdf` only when pdf-lib refused the file at load with its OWN parse / format error, or the file loaded encrypted. pdf-lib's error classes compile to plain `Error` (no working `instanceof`, checked against the installed pdf-lib), so the test is the message every one of them carries: "Failed to parse …", "No PDF header found", "Parser stalled", "Expected next byte …", "Did not find expected keyword …".
  - `build_failed` for an out-of-memory failure at ANY stage, load included (`isOutOfMemoryError`: a `RangeError`, or an allocation / out-of-memory message), and for anything else. Red, the safe verdict: a re-print may carry the sheet.
  - The new `too_large` code (document-control `PKG-12`: a sheet over a field pack's budget on its own, now left out instead of refusing the pack) reads red through the route's existing split. The route gains no rule for it. *(Reversed at fix pass 3: red told the crew to ask for a re-printed pack that every re-print leaves the sheet out of — see below.)*
  - Tests:
    - `dcRoundFField.test.ts`: an out-of-memory `load` is `build_failed`; the `packBuildFailureCode` table covers every pdf-lib parse message, `RangeError`, an out-of-memory message, an unknown `TypeError`, and encrypted with and without out-of-memory.
    - `verifyPackageSnapshot.test.ts`: the REAL pdf-lib's refusal of a non-PDF classifies as `unreadable_pdf`; an out-of-memory load classifies as `build_failed`, and that still-current sheet reads RED at the verify door; a `too_large` sheet reads red.
  - **Scope, for the integrator.** P8's brief said not to touch the verify routes. P8's edit to `app/api/verify-package/route.ts` is narrow: it reads the `printed: false` entries, adds the WHEN fields, and adds ONE verdict change. A still-current sheet the print recorded as `unreadable_pdf` is amber `not_pdf`, not red. That rule now fires only on pdf-lib's own parse refusal or an encrypted file, never on a device running out of memory. It is a PS-VERIFY verdict all the same, and the integrator should confirm it with the PS-VERIFY owner before merge. Without that confirmation, removing the one `atPrint?.code === "unreadable_pdf"` line returns such a sheet to red; nothing else depends on it. *(Fix pass 3 adds a second rule to the same request — below.)*
- **Fix pass 3 (review findings).**
  - **A `too_large` sheet, still current, is amber — not a permanent red.** Since document-control `PKG-12`'s second fix pass a sheet over a field pack's budget on its own (a 180 MB vendor data book, a 1,200-page manual) is left out of every print as `too_large`. At the verify door it is Issued, unheld and a PDF, so it landed in `notInPack` and the pack read red "PACK IS MISSING SHEETS … ask for a re-printed pack" for good: every re-print leaves it out again. That broke the route's own rule for a sheet a re-print would also leave out, and the cover's printed legend (red = "a package sheet a re-print would carry"). The route now mirrors the `unreadable_pdf` rule: when the snapshot recorded `too_large` for the revision that is still current (`sameRevision`), the sheet is `notPrintable` with the new `NotPrintableReason` `too_large` (`lib/verifyPresent.ts` `notPrintableText`: "too large for a field pack — get it separately"); an otherwise current pack reads amber "PACK INCOMPLETE", never green. After a new revision (which may fit a pack), or from an entry that names no revision, it is red as before.
  - **The comment that contradicted the page is corrected.** `lib/verifyPresent.ts`'s "stale" branch said the snapshot does not record what the print left out, so nothing says "added since printing" — false since this finding's first pass. It now describes the when-fields (`leftOutAtPrint` / `addedSincePrint`) and where the page words them (`missingSheetWhen`).
  - **One sign-off request, two rules.** Both amber rules — `unreadable_pdf` → `not_pdf` and `too_large` → `too_large`, each only while the revision the print tried is still current — are P8's verdict changes in PS-VERIFY's route, outside the brief's "do not touch the verify routes" and authorised only by this finding's owner line. **For the PS-VERIFY owner's sign-off before merge**, through the integrator. Without it, delete the two `sameRevision` lines (`app/api/verify-package/route.ts`): `unreadable_pdf` sheets return to red; `too_large` sheets return to the permanent red described above, and document-control `PKG-12` would then need another answer for them.
  - The print reads the package's members fresh by package id before it gates (document-control `PKG-7` fix pass 3), so "the snapshot's own member list" below is the package at the click, not at the page's load.
  - Tests (`verifyPackageSnapshot.test.ts` "VFY-19 — …"): the `too_large` case is flipped — amber `too_large` with the "get it separately" words and no re-print instruction, red after a new revision, red when the entry names no revision.

**Done-when.**
1. ✓ The print snapshot records the sheets left out of that printing with their reason (in the snapshot's own `sheets` array, `printed: false`, rather than a sibling column — no migration), written by the same `recordPackagePrint` call from `assessment.skipped` and the builder's skips.
2. ✓ `/api/verify-package` reads it. A missing sheet the snapshot lists as skipped is reported "left out of this printing — <reason>". A missing sheet it does not list is reported "added to the package since printing", judged against the snapshot's own member list.
3. ✓ A test pins the three cases: skipped at print, added since, and a pre-change snapshot that keeps the present-tense split.

**Scope / residual.** The two amber rules for a still-current left-out sheet — `unreadable_pdf` → `not_pdf` (fix pass 2) and `too_large` → `too_large` (fix pass 3) — are verdict changes in PS-VERIFY's route, awaiting the PS-VERIFY owner's sign-off through the integrator; the revert is the two `sameRevision` lines. "The snapshot's own member list" is the package membership the print read at the click (fix pass 3; it was the page's earlier load). A sheet added in another tab in the seconds between that read and the snapshot's write reads "added since this pack was printed". That direction is never wrong about the paper — the sheet is not in it.

---

<a id="vfy-20"></a>

## VFY-20 · The document editors offer status "IFC", which `DocumentStatus`, the pack print gate and the verify allow-list all reject — IFC paper scans red and IFC sheets never print into a pack

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** document-control P12 WAVE-2 RESIDUALS (BulkEditModal.tsx is in its files) — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `components/documents/BulkEditModal.tsx:32` (`STATUS_OPTIONS` — "Draft", "In Review", "Issued", "IFC", "Superseded", "Archived"), `components/documents/MetadataStagingModal.tsx:68` (`DEFAULT_STATUS_OPTIONS` — the same with "IFC"), `types/schema.ts:658` (`DocumentStatus` — no "IFC", no "In Review"), `lib/docPack.ts` (`filterPackDocs` — refuses any status outside Issued / Locked), `lib/verifyVerdict.ts` (`IN_FORCE_STATUSES` — Issued / Locked only), `components/documents/LifecycleBoard.tsx` (an "IFC" column derived from `issueType` / Issued, not from the status)
- **Independently verified:** — opened 2026-10-01 by public-surfaces Round F (PS-VERIFY, third review fix pass) from the review of `VFY-1` / `VFY-9`, per DEC-31; verified against the branch, not yet challenged by a second party.

**Mechanism.** Two editors let a user set a document's status to "IFC" (Issued For Construction). Nothing downstream accepts it as issued: `DocumentStatus` does not list it, document-control `PKG-4`'s print gate refuses it (`status && status !== "Issued" && status !== "Locked"`), and `VFY-1`'s allow-list reads it `not_issued`. Before Round F the verify deny-list let it through, so a current IFC print scanned green; since `VFY-1` / `VFY-9` it scans red. The third review fix pass gave such a status neutral copy on `/verify` — "STATUS NOT RECOGNISED — … check with Document Control" (`isRecognisedStatus`) — instead of "not an approved revision", and the integration fix pass gave the pack page the same words (the sheet row "STATUS NOT RECOGNISED", a missing member "status not recognised" — `VFY-9`), but the vocabulary itself is unsettled: a user who picks IFC means "issued", and every gate says "not issued". ("In Review" is offered and absent from `DocumentStatus` too; it is read, correctly, as not yet issued.)

**Failure scenario.** A document controller bulk-sets a construction set to "IFC". The crew's sheets, printed with a `?v=` QR, scanned green last week; after the PS-VERIFY deploy every scan is red "STATUS NOT RECOGNISED". The packages page will not print any of them into a field pack ("ifc — not an in-force controlled revision"). The fail-safe direction, but the plant is told its construction set is not usable while the controller believes it issued it. How many documents this touches is counted by migration `20261134`'s inventory row "documents with a current revision and status IFC".

**Evidence.**

```
components/documents/BulkEditModal.tsx:32 — const STATUS_OPTIONS = ["Draft", "In Review", "Issued", "IFC", "Superseded", "Archived"];
components/documents/MetadataStagingModal.tsx:68 — const DEFAULT_STATUS_OPTIONS = ["Draft", "In Review", "Issued", "IFC", "Superseded"];
types/schema.ts:658 — export type DocumentStatus = "Draft" | "Issued" | "Superseded" | "Void" | "Archived" | "Locked";
lib/docPack.ts — if (status && status !== "Issued" && status !== "Locked") { skipped.push(…) }
lib/verifyVerdict.ts — export const IN_FORCE_STATUSES: ReadonlySet<string> = new Set(["Issued", "Locked"]);
```

**Done when.**

- [ ] Document control decides the vocabulary (a DEC): EITHER the editors stop offering "IFC" (and existing IFC rows are moved to a vocabulary status — the `20261134` inventory gives the count), OR "IFC" is added together to `DocumentStatus`, the print gate (`filterPackDocs`) and `IN_FORCE_STATUSES` — never to one of them alone
- [ ] A test pins that every status an editor offers is either in force at both the print gate and the verify allow-list, or refused by both
- [ ] The same decision says whether "In Review" belongs in `DocumentStatus`

**Owner.** Document-control (the editors and `types/schema.ts`; the print gate is P8 FIELD's file; `IN_FORCE_STATUSES` is the verify routes' owner's, one line once the DEC lands).

---
