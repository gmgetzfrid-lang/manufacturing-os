# 03 · The physical bridge — QR, labels, stamps, print

**13 findings** — 2 CRITICAL · 7 HIGH · 4 MEDIUM.

What a printed page asserts, and whether it can be wrong.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| lib/publicOrigin.ts — a single documented helper for every URL that leaves the app, with the preview-deploy rationale written out in the header | `lib/publicOrigin.ts:1-22` | It is the right abstraction and 9+ call sites use it correctly (physicalBridge, docPack, downloads, share/file, three viewers, RelatedPanel). Every finding about origins is about call sites that skipped it or an env contract around it, never about the helper's design. Do not replace it — route the stragglers through it. |
| The four public scan-landing pages share one deliberate design language: mobile-first, zero login, one full-viewport verdict, facts second, explicit fail-safe copy on error | `app/verify/[docId]/page.tsx:63-153, app/verify-hold/[holdId]/page.tsx:52-127, app/verify-package/[packageId]/page.tsx:58-143, app/verify-ticket/[ticketId]/page.tsx:97-180` | The error branches already fail safe in the right direction — "Treat the hold as ACTIVE until Document Control confirms otherwise" (verify-hold:68) and "contact Document Control before using the print" (verify:79). New verdicts (on-hold, draft, void) should be added as new states in this same structure rather than as a redesign. |
| The unauthenticated verify APIs enforce a strict UUID regex before touching the DB and return facts only — no files, no URLs, no people; verify-hold explicitly withholds staff names and operator notes | `app/api/verify/route.ts:20-30, app/api/verify-hold/route.ts:48-52` | The minimal-exposure contract is thought through and consistently applied across all four routes. The /d/[number] leak breaks the premise these routes rest on, so the fix belongs in /d, not in loosening or tightening these payloads. |
| lib/stampLayout.ts — placement math split out as pure functions with unit tests, so the QR and footer provably fit and avoid the drawing's own content | `lib/stampLayout.ts:1-200, lib/__tests__/stampLayout.test.ts` | The measured-not-guessed approach is sound and the fallback path (FALLBACK_INK, stampLayout.ts:150-154) degrades to the historical placements rather than failing. The rotation finding is a coordinate-space gap in the caller, not a flaw in this module. |
| lib/documentGuards.ts turns holds and locks from advisory into enforced preconditions on the publish path, with a pure decision function and a defense-in-depth Postgres trigger | `lib/documentGuards.ts:1-19, lib/documentGuards.ts:109-121` | The authoritative hold-state lookup and the 'holds are controller-tier, an override-with-reason must never jump a safety hold' distinction already exist. The verify and print paths should consume this same state rather than inventing a second notion of 'blocked'. |
| lib/workPackages.ts refreshWorkPackage checks every write and throws with the exact remediation when zero rows match | `lib/workPackages.ts:206-228` | This is the codebase's own worked example of the unchecked-write defect being found and fixed — including naming migration 20260828 in the error text. It is the pattern the download_audits writers should follow. |
| physicalBridge's four generators are single-call, zero-configuration, and route every QR through one origin() indirection | `lib/physicalBridge.ts:15-17, lib/physicalBridge.ts:49-53` | Because all four share one origin() function, an origin fix lands everywhere at once. The equipment-label target fix is a one-line path change in the same file the traveler and pack-cover migrations already happened in. |
| VersionHistoryPanel forces the uncontrolled stamp on every historical-revision download by cloning the doc with checkedOutBy cleared | `components/documents/VersionHistoryPanel.tsx:126-152` | It is the correct precedent — 'previous revisions are never the authoritative drawing, so any copy of them must be marked' — and the fix for the unstamped markup export is to apply the same reasoning there. |


---


<a id="phys-1"></a>

## PHYS-1 · A document under an active HOLD verifies GREEN "CURRENT" on the public scan page — the hold, the stop-work signal the system exists to carry, is invisible to every field scan

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:34-38`, `app/api/verify/route.ts:89-90`, `app/verify/[docId]/page.tsx:64-65`, `app/verify/[docId]/page.tsx:98-100`, `app/api/verify-package/route.ts:56`, `app/api/verify-package/route.ts:61`, `lib/documentGuards.ts:1-7`, `lib/downloads.ts:227-240`

**Mechanism.** /api/verify selects only `id, document_number, title, name, rev, status, current_version_id, superseded_at` from `documents` (34-38). Its verdict is `const docRetired = d.status === "Superseded" || d.status === "Archived"; const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);` (89-90). It never queries `document_holds`. The page renders `result?.isCurrent ? "bg-emerald-600" : "bg-red-600"` with the headline "CURRENT" (page.tsx:65,99). /api/verify-package is the same shape (line 56 checks only Superseded/Archived; line 61 computes `fresh` from pin-vs-current only). Two differently-shaped greps confirm it: grepping `document_holds|activeHold|onHold|on_hold` across app/api/verify*, app/verify, lib/stamping.ts, lib/downloads.ts, lib/docPack.ts and lib/physicalBridge.ts returns nothing, and grepping for files containing "holds" under app/api and the verify routes returns only app/api/verify-hold/route.ts. Meanwhile lib/documentGuards.ts:1-7 states the product position outright: holds were "advisory" and are now enforced — but only on the PUBLISH path. Nothing on the download, stamp, or verify path knows a hold exists. The same gap swallows `status === "Draft"` and `status === "Void"`: neither is in the `docRetired` set, so an unissued draft and a voided drawing both return isCurrent=true and paint green.

**Failure scenario.** Document Control opens a "Field Verification Needed" hold on P&ID 2002-D-10001 after a near-miss. Prints of Rev 4 are already in the field. An operator scans the QR stamped on his copy: Rev 4 is still `current_version_id` and status is still "Issued", so the phone fills with a green CURRENT screen and the words "This print matches the current revision." The hold — the entire reason work was supposed to stop — is not mentioned. The same drawing scanned from a work-package cover sheet reports PACK IS CURRENT.

**Evidence.**

```
verify/route.ts:89-90 `const docRetired = d.status === "Superseded" || d.status === "Archived";\n  const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`; verify-package/route.ts:56 `const retired = d?.status === "Superseded" || d?.status === "Archived";`; documentGuards.ts:4-7 `// ... historically locks and holds were advisory: nothing stopped you from publishing a new revision of a document that was checked out by someone else, or one that was on an active hold.`
```

**Chain reaction.** The same blindness runs through the print path: lib/downloads.ts buildFooterNotice (80-88) warns about a foreign CHECKOUT but never about a hold, and lib/docPack.ts:92-103 does the same. Fixing this in /api/verify alone still leaves paper that goes out with no hold mark; the hold state needs to reach both the stamp at issue time and the verify verdict. Adding the hold lookup to /api/verify and /api/verify-package is one query each against document_holds (indexed: document_holds_active_doc_idx) and needs a distinct verdict — a held document is neither "current" nor "superseded".

**Done when.**

- [ ] /api/verify joins document_holds WHERE released_at IS NULL and returns a distinct on-hold verdict that the page renders as red/amber, never green
- [ ] /api/verify-package marks any member sheet under an active hold as not-fresh with its own label
- [ ] documents with status Draft or Void get their own non-green verdict rather than falling into isCurrent=true
- [ ] lib/downloads.ts buildFooterNotice adds a hold line when the document has an active hold at issue time

---

<a id="phys-2"></a>

## PHYS-2 · Printing an older ticket deliverable stamps it with the ticket's CURRENT revision and encodes that rev in the QR — the scan then certifies a superseded print as "LATEST ISSUE" in green

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:1391`, `app/(protected)/requests/[id]/page.tsx:569`, `app/(protected)/requests/[id]/page.tsx:577-578`, `app/(protected)/requests/[id]/page.tsx:637`, `app/(protected)/requests/[id]/page.tsx:649-650`, `app/(protected)/requests/[id]/page.tsx:1008-1011`, `app/(protected)/requests/[id]/page.tsx:1360`, `app/api/verify-ticket/route.ts:78-83`

**Mechanism.** FileViewerModal receives `deliverableRev={ticket?.deliverableRev}` (page.tsx:1391) — the ticket row's single live `deliverable_rev` column — not the revision of the attachment actually open. Attachments accumulate on the ticket forever: `attachments: [...currentAttachments, newAttachment]` (1008-1011) and `finalFiles = ticket.attachments?.filter(a => a.type === 'Final')` (1360) lists every Final deliverable ever produced, across every revision cycle. Both print (569) and download (637) build `verifyUrl = ${publicOrigin()}/verify-ticket/${ticketRowId}?r=${deliverableRev}` and the footer `"${ticketId} deliverable Rev ${deliverableRev} at time of printing"` from that same live value. So opening the Rev-1 Final on a ticket now at Rev 2 produces a sheet whose footer says "Rev 2" and whose QR encodes `?r=2`. /api/verify-ticket then compares printedRev 2 against latestIssued 2 and returns verdict `current` (route.ts:82-83), which the landing page renders as a full-screen emerald "LATEST ISSUE — This copy is the latest issued revision of this deliverable."

**Failure scenario.** A drafting ticket issues Rev 1 of a tie-in isometric, then Rev 2 after a line-class change. A PM opens the ticket, clicks the Rev 1 Final attachment (still listed under Final files), and prints it for a fitter. The footer reads "deliverable Rev 2 at time of printing" and the QR resolves to a green LATEST ISSUE screen. The fitter scans, gets green, and welds to the superseded isometric — with the app's own verification screen as his authority.

**Evidence.**

```
page.tsx:1391 `deliverableRev={ticket?.deliverableRev}`; page.tsx:1360 `const finalFiles = ticket.attachments?.filter(a => a.type === 'Final') || [];`; page.tsx:569 `? \`${publicOrigin()}/verify-ticket/${ticketRowId}${deliverableRev ? `?r=${encodeURIComponent(deliverableRev)}` : ""}\``; verify-ticket/route.ts:82-83 `} else if (latestIssued && printedRev === latestIssued) { verdict = "current";`
```

**Chain reaction.** The FileViewerModal props (page.tsx:510,524) carry only a scalar `deliverableRev`, so every consumer of that modal inherits the bug; the fix must derive the rev from the attachment being viewed (per-attachment rev metadata), not from the ticket. The traveler at page.tsx:1538 legitimately uses `ticket.deliverableRev` — do not change that one. Related but distinct: audit-reports/drafting-flow 13-edges-and-invariants EDGE-9 already covers /api/verify-ticket's missing cancelled-ticket verdict; this is a different input, not a re-report.

**Done when.**

- [ ] The rev encoded in the QR and printed in the footer comes from the attachment being viewed, not from tickets.deliverable_rev
- [ ] An attachment with no recorded rev produces NO `?r=` param (so /api/verify-ticket returns `unknown`, not a green `current`)
- [ ] A test opens a historical Final attachment on a ticket at a later rev and asserts the built verifyUrl does not contain the ticket's current rev

---

<a id="phys-3"></a>

## PHYS-3 · "Print doc pack" reports "all current, all stamped" while packing Superseded, Void and Draft documents and every document under an active hold — the hold state is displayed on the same page and never reaches the paper

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/assets/[tag]/page.tsx:52-56`, `app/(protected)/assets/[tag]/page.tsx:75`, `app/(protected)/assets/[tag]/page.tsx:94`, `app/(protected)/assets/[tag]/page.tsx:139-142`, `lib/docPack.ts:51-54`, `lib/docPack.ts:100-106`, `lib/docPack.ts:3-7`

**Mechanism.** The asset page loads its document list filtering only `.neq("status", "Archived")` (52-56) — Superseded, Void and Draft all stay in `docs`. "Print doc pack" passes `documentIds: docs.map((d) => d.id)` straight to buildAndDownloadDocPack, which re-selects by id with no status predicate at all (docPack.ts:51-54) and stamps every one with `watermarkText: "UNCONTROLLED — FIELD PACK"` and `footerNotice: \`${label} Rev ${d.rev} at time of issue — verify current revision before use.\`` (100-106). Nothing in the stamp names the document's status. The page then reports success as "Pack ready — N drawings, all current, all stamped." (139-142) and the module header calls itself "every current-revision drawing for that asset" (docPack.ts:3-7). Holds are worse: the same page already queries them — `.from("document_holds").select("document_id").in("document_id", ids).is("released_at", null)` (75) — and renders a rose "hold" chip per document and an "On hold" stat tile (94). That data is computed, displayed, and then dropped: docPack.ts never receives it and the printed sheet carries no hold mark.

**Failure scenario.** A pump has six tagged drawings; one was voided last month and two are under "Field Verification Needed" holds — all three visible on screen with status pills and hold chips. A supervisor clicks Print doc pack, gets a single merged PDF, and reads "Pack ready — 6 drawings, all current, all stamped." He walks the pack to the field. Three of the six sheets should never have left the building, and no sheet in the pack says so. (The per-sheet verify QR would flag the voided one only if scanned — and per the hold finding above, the held ones scan green.)

**Evidence.**

```
assets/[tag]/page.tsx:56 `.neq("status", "Archived")`; assets/[tag]/page.tsx:139-141 `result.skipped.length === 0\n                          ? \`Pack ready — ${result.included} drawing${...}, all current, all stamped.\``; docPack.ts:52-54 `.from("documents")\n    .select("id, org_id, document_number, title, name, rev, library_id, current_version_id, checked_out_by, checked_out_by_name, checkout_note")\n    .in("id", input.documentIds);`
```

**Chain reaction.** docPack already selects `checked_out_by` and stamps an "ACTIVE CHANGE IN PROGRESS" line for it (docPack.ts:92-94, 102-103) — the pattern for carrying a document-state warning onto the sheet exists and just needs status and holds added to the same select and the same footer. This is also the pack path used by work packages (packages/page.tsx:170-177 passes a cover into the same function), so fixing it here fixes both. Note the work-package cover sheet has a parallel problem: it prints `docs: fresh.docs.map(d => ({ label: d.docLabel, rev: d.currentRev ?? d.pinnedRevLabel }))` under the heading "CONTENTS — revisions as printed" (physicalBridge.ts:262), i.e. current rev, not the pinned rev, so the cover's own contents list can disagree with what /verify-package computes from the pins.

**Done when.**

- [ ] buildAndDownloadDocPack selects status and active-hold state and either skips non-issued/held documents or stamps an explicit status/hold line on their sheets
- [ ] The success toast's wording matches what was actually packed (it cannot say "all current" when a retired or held sheet was included)
- [ ] The work-package cover's CONTENTS list prints the pinned rev that /verify-package will compare against

---

<a id="phys-4"></a>

## PHYS-4 · /d/[number] resolves any document number against ALL orgs with the service-role client and redirects with the document UUID — destroying the "unguessable UUID" premise that /api/verify's unauthenticated exposure rests on

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/d/[number]/route.ts:5-7`, `app/d/[number]/route.ts:26-32`, `app/d/[number]/route.ts:34-46`, `lib/supabaseAdmin.ts:3-8`, `app/api/verify/route.ts:4-10`, `app/api/verify/route.ts:96-108`, `components/documents/RelatedPanel.tsx:111-113`

**Mechanism.** The route runs `supabaseAdmin.from("documents").select("id, library_id, document_number, updated_at").ilike("document_number", \`%${raw...}%\`)` (26-32) with no `org_id` filter and no session check. supabaseAdmin is the SERVICE ROLE client (supabaseAdmin.ts:3-8), which bypasses RLS entirely. The route is at app/d/ — outside the (protected) route group — and there is no middleware.ts anywhere in the repo. It then redirects to `/documents/${match.library_id}?doc=${match.id}` (44-46). The redirect Location header is returned to an unauthenticated caller, so `curl -sI https://host/d/2002-D-10001` yields the document UUID and library UUID of whichever tenant owns that number. The header comment claims "it reveals nothing" (5-7) — it reveals two UUIDs plus the existence of the number. /api/verify justifies being unauthenticated on precisely the opposite assumption: "Both IDs are unguessable UUIDs that only appear ON a printed copy the org itself issued" (verify/route.ts:4-10). Feed the leaked doc UUID to `/api/verify?doc=<uuid>` with no `v` and it returns document_number, title, current rev, issue date, effective date and status (96-108) for a document in an org the caller has no relationship with. Drawing numbers are systematic (`2002-D-10001`), so the space is enumerable, and RelatedPanel.tsx:111-113 publishes the pattern as a copyable short link.

**Failure scenario.** A competitor or a former contractor enumerates `/d/2002-D-1000{1..9999}` against the production host with no account. Each hit returns a 307 whose Location carries the document UUID; each UUID feeds /api/verify and yields the drawing number, title, current revision, and status. The result is a cross-tenant drawing register — exactly what a PSM document-control system is supposed to keep inside the org — extracted with two unauthenticated GETs per drawing.

**Evidence.**

```
d/[number]/route.ts:26-30 `const { data: rows } = await supabaseAdmin\n    .from("documents")\n    .select("id, library_id, document_number, updated_at")\n    .filter("document_number", "not.is", null)\n    .ilike("document_number", \`%${raw.replace(/[%_]/g, "")}%\`)`; d/[number]/route.ts:6-7 `// The target page enforces auth + RLS as always — this route only translates a number into a location; it reveals nothing.`; verify/route.ts:6-7 `//   * Both IDs are unguessable UUIDs that only appear ON a printed copy the org itself issued.`
```

**Chain reaction.** The `?? (rows ?? [])[0]` fallback at line 36 makes it worse: when no exact normalized match exists, it redirects to the FIRST loose substring hit ordered by updated_at — so a partial number leaks a UUID for a document that isn't even the one asked for, and a member of org A typing their own number can be silently sent to org B's document. Fixing this requires a session + org scope on the lookup, which also fixes the wrong-tenant redirect. Do NOT fix it by tightening /api/verify's UUID handling alone — the leak is the short-link route.

**Done when.**

- [ ] /d/[number] resolves the caller's session and scopes the query to that user's org ids (or redirects to sign-in when there is no session), instead of using the service-role client unscoped
- [ ] The `(rows ?? [])[0]` loose fallback is removed or confined to the caller's own org
- [ ] An unauthenticated GET to /d/<any real number> returns a redirect to sign-in, not a Location containing a document UUID

---

<a id="phys-5"></a>

## PHYS-5 · A marked-up PDF exported by the checkout holder ships with no watermark, no footer, and no verify QR — redlines that are explicitly "not part of the controlled revision" leave the app looking like a controlled drawing

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/viewers/FullScreenViewer.tsx:961-966`, `components/viewers/FullScreenViewer.tsx:1005-1020`, `components/viewers/FullScreenViewer.tsx:1024-1027`, `components/viewers/FullScreenViewer.tsx:985-1000`, `lib/downloads.ts:30-37`

**Mechanism.** downloadWithMarkup bakes every Fabric annotation layer into the page as an embedded PNG drawn over the full page area (985-1000), then gates the stamp on checkout state: `const stampNow = liveState !== "controlled"` (966) where `liveState = determineControlState(docRecord, currentUserId)` returns "controlled" exactly when `doc.checkedOutBy === userId` (downloads.ts:35). `if (stampNow) { await applyStampToPdfDoc(...); suffix = "_markup_UNCONTROLLED"; }` (1006-1019) — when the exporter holds the checkout the whole block is skipped and `suffix` stays `"_markup"` (1005). The resulting file (1024) is the original drawing with hand-drawn redlines burned in, no diagonal watermark, no "UNCONTROLLED COPY" footer, no scan-to-verify QR, and a filename like `2002-D-10001_Rev4_markup.pdf`. The stamp text that would have been applied says it in as many words: "WITH MARKUPS at time of export — markups are not part of the controlled revision" (1014). That sentence appears on the page only in the case where it is least needed and is absent in the case where the paper carries the most non-authoritative ink.

**Failure scenario.** A drafter checks out a piping iso, redlines a field change over it, exports, and emails/prints the PDF for the fitter. The sheet has fresh red linework on it and nothing anywhere saying the markups are not the issued revision, no watermark, and no QR to scan. It is visually indistinguishable from an issued drawing with approved as-built markups. The fitter builds the redline.

**Evidence.**

```
FullScreenViewer.tsx:966 `const stampNow = liveState !== "controlled";`; :1005-1006 `let suffix = "_markup";\n      if (stampNow) {`; :1014 `footerNotice: \`${docNumber || title || "Document"} Rev ${rev ?? "?"} WITH MARKUPS at time of export — markups are not part of the controlled revision.\``; downloads.ts:35 `if (doc.checkedOutBy && doc.checkedOutBy === userId) return "controlled";`
```

**Chain reaction.** components/documents/VersionHistoryPanel.tsx:150-152 already established the correct precedent for exactly this class of copy — it clones the doc with `checkedOutBy: undefined` to force the uncontrolled stamp on any non-authoritative copy, with the comment "any copy of them must be marked." The markup export needs the same treatment: the controlled-copy exemption is for the UNMODIFIED master, and a markup export is by definition not the master. Note the audit row at :1035-1041 records `state: liveState` = "controlled", so the distribution ledger also records this unmarked redline as a controlled copy.

> **Verifier correction.** Reframe as: the markup export inherits the controlled-copy exemption from lib/downloads.ts:30-37 unchanged, which is defensible for a clean PDF but not for one with redlines burned in — the "markups are not part of the controlled revision" notice is the one thing that should be unconditional. Not a gate bypass; a wrong rule reused. HIGH, not CRITICAL.

**Done when.**

- [ ] downloadWithMarkup always stamps, regardless of checkout state (markups are never the controlled master)
- [ ] The exported filename always carries a markup/uncontrolled suffix
- [ ] logDownloadAudit for a markup export records state "uncontrolled"

---

<a id="phys-6"></a>

## PHYS-6 · Downloading an older revision from Version History stamps the footer and names the file with the document's CURRENT rev — the paper asserts a revision it does not contain

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/downloads.ts:80-88`, `lib/downloads.ts:71-76`, `lib/downloads.ts:228-240`, `components/documents/VersionHistoryPanel.tsx:150-159`, `lib/downloads.ts:95-102`

**Mechanism.** VersionHistoryPanel passes the correct `versionId: v.id` and clones the doc with `checkedOutBy: undefined` to force the uncontrolled stamp (150-159), and `buildVerifyUrl` honours it — `const version = ctx.versionId ?? ctx.doc.currentVersionId` (downloads.ts:99), so the QR correctly encodes the OLD version and the scan will read DO NOT USE. But the two other assertions on the same sheet read `ctx.doc.rev`, which is the DOCUMENT's current revision label, not the version's: `buildFooterNotice` emits `\`Rev ${doc.rev ?? "?"} at time of issue — verify current revision before use.\`` (82) and `defaultFilename` builds `${stem}_Rev${doc.rev}_UNCONTROLLED.pdf` (71-76). `DocumentVersion.revisionLabel` — the rev the bytes actually are — is available on `v` at the call site and is never used. The result is a printed sheet of Rev 2 whose footer says "Rev 5 at time of issue" saved as `2002-D-10001_Rev5_UNCONTROLLED.pdf`, whose QR says DO NOT USE.

**Failure scenario.** An engineer pulls Rev 2 from history for a root-cause investigation while the drawing is at Rev 5. The file lands on his desktop named `..._Rev5_UNCONTROLLED.pdf`. He forwards it, or prints it; anyone reading the footer sees "Rev 5 at time of issue". The only thing contradicting it is the QR, which requires a phone and a decision to scan. The stamp — the thing that exists so paper does not lie — is the part that lies.

**Evidence.**

```
downloads.ts:82 `parts.push(\`Rev ${doc.rev ?? "?"} at time of issue — verify current revision before use.\`);`; downloads.ts:74 `const rev = doc.rev ? \`_Rev${doc.rev}\` : "";`; VersionHistoryPanel.tsx:153-155 `await downloadDocumentPdf({\n        doc: docForDownload,\n        versionId: v.id,`
```

**Chain reaction.** buildFooterNotice and defaultFilename take the whole DocumentRecord and never see ctx.versionId; the fix is to give both the resolved revision label for the version being delivered (DownloadContext already carries versionId, so it can carry versionRevLabel too). The same doc.rev is also used in the checkout warning at downloads.ts:83-86, so a history pull of an old rev inherits a checkout warning about the CURRENT rev's holder.

**Done when.**

- [ ] DownloadContext carries the revision label of the delivered version and buildFooterNotice/defaultFilename use it
- [ ] A history download of rev N on a document at rev M (M>N) produces a footer and filename naming rev N
- [ ] The footer distinguishes "this print is Rev N" from "the current revision is Rev M" rather than printing one number

---

<a id="phys-7"></a>

## PHYS-7 · Equipment QR labels point at /assets/[tag], a route inside the (protected) group — the sticker on the pump advertises "SCAN: drawings · holds · report a problem" and lands an account-less scan on the signed-in app shell with nothing in it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/physicalBridge.ts:84`, `lib/physicalBridge.ts:99`, `lib/physicalBridge.ts:6-7`, `lib/physicalBridge.ts:219-220`, `lib/physicalBridge.ts:272-274`, `app/(protected)/assets/[tag]/page.tsx:1`, `app/(protected)/layout.tsx:27-51`

**Mechanism.** `drawLabel` builds `const url = \`${origin()}/assets/${encodeURIComponent(asset.tag)}\`` (84) and prints the caption "SCAN: drawings · holds · report a problem" beneath it (99). The target file is app/(protected)/assets/[tag]/page.tsx — inside the (protected) route group, whose layout is a client component driven by RoleContext: it renders an "Authenticating..." spinner while loading, a hard-stop NotAMemberScreen for a session with no membership, and otherwise the full signed-in shell whose data reads are RLS-scoped to org members (layout.tsx:27-51). There is no middleware.ts in the repo, so nothing intercepts earlier. The module's own history proves the authors already know this is wrong for a field QR — twice: the traveler comment says "PUBLIC verify page — the person holding the folder in the field has no account; sending them to the protected app was a login wall" (219-220), and the pack cover says "the old /packages target was a login wall under the words 'SCAN BEFORE STARTING WORK'" (272-274). Both were migrated to public /verify-* pages. The equipment label — the highest-volume physical artifact, one sticker per tag, printed 10 to a sheet — was not.

**Failure scenario.** A contractor at a pump sees the QR sticker promising drawings, holds, and a way to report a problem. He scans it and gets a spinner, then a signed-out app chrome with no documents — no drawings, no indication the equipment is on hold, and no report-a-problem link (which is itself a protected /requests/new deep link, page.tsx:172-176). The label's three promises are all unreachable to exactly the audience the label is stuck to a pump for.

**Evidence.**

```
physicalBridge.ts:84 `const url = \`${origin()}/assets/${encodeURIComponent(asset.tag)}\`;`; physicalBridge.ts:99 `page.drawText("SCAN: drawings · holds · report a problem", ...)`; physicalBridge.ts:219-220 `// PUBLIC verify page — the person holding the folder in the field has no\n  // account; sending them to the protected app was a login wall.`
```

**Chain reaction.** Labels are physical and permanent — a wrong target is not a redeploy away, it is a re-print and a re-stick across every tag in the plant. Whatever public landing is built must keep the same /assets/[tag] path shape (or the existing stickers stay dead), which argues for making /assets/[tag] a public shell that shows tag + hold state + a scan-to-report affordance and gates only the drawing bytes behind auth. Note the protected page already computes the two facts a field scan needs — `heldCount` and per-doc hold chips (page.tsx:94, 218) — so the data exists; it is only behind the wall.

**Done when.**

- [ ] Scanning an equipment label with no session lands on a page that names the tag and states whether any document on it is under an active hold
- [ ] The label's caption only promises what the unauthenticated landing actually delivers
- [ ] The path shape survives, or the change is accompanied by a re-print plan for existing stickers

---

<a id="phys-8"></a>

## PHYS-8 · Every share-link and drafting-portal download writes download_audits rows containing columns that do not exist in the schema, and no caller checks the result — the distribution record for external and drafting copies is silently never written

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:789-799`, `app/api/share/file/route.ts:129-141`, `app/(protected)/requests/[id]/page.tsx:592-600`, `app/(protected)/requests/[id]/page.tsx:673-684`, `lib/downloads.ts:131-145`, `lib/staleCopies.ts:39-47`

**Mechanism.** download_audits is defined once, at supabase/schema.sql:789-799, with exactly nine columns: id, org_id, document_id, version_id, user_id, user_email, created_at, expires_at, watermark_policy_id. Two differently-shaped searches confirm nothing adds more — `grep -rn download_audits supabase/` returns only the CREATE TABLE, the ENABLE RLS, and the policy; `grep -rn 'ALTER TABLE.*download_audits'` returns nothing. Yet app/api/share/file/route.ts:130-140 inserts `source: stamped ? "share_link" : "share_link_unstamped"`, and requests/[id]/page.tsx:593-599 and :674-683 insert `ticket_id, attachment_id, attachment_type, filename, watermark_text, source` — six columns that do not exist — while omitting document_id and version_id entirely. PostgREST rejects an unknown column with PGRST204. Every one of these call sites swallows it: the share route wraps the await in `try { } catch { /* pre-migration column drift — never block the share */ }` (129-141) but supabase-js RESOLVES with `{error}` rather than throwing, so the catch never runs; the requests page uses `.then(() => {}, () => {})`; lib/downloads.ts:131-145 has the same shape, with a console.error in a catch that cannot fire. So the two paths that most need a distribution record — the copy that went to an outsider, and the deliverable that went out unstamped after a stamping failure — record nothing at all, silently.

**Failure scenario.** An incident review asks who holds prints of the drawing involved. download_audits contains only the internal viewer pulls; the share-link download to the outside contractor and every drafting-portal print are absent, because each insert was rejected on an unknown column and the rejection was discarded. lib/staleCopies.ts:39-47 reads this table to build the recall list, so those holders are also invisible to the one-click recall nudge. Nothing in logs or UI ever indicated a failure.

**Evidence.**

```
schema.sql:789-799 (nine columns, no `source`, no `ticket_id`); share/file/route.ts:139 `source: stamped ? "share_link" : "share_link_unstamped",`; share/file/route.ts:141 `} catch { /* pre-migration column drift — never block the share */ }`; requests/[id]/page.tsx:594-599 `org_id: orgId, ticket_id: ticketId ?? null, attachment_id: file.id,\n        attachment_type: file.type, filename: file.name, user_id: userId,`
```

**Chain reaction.** Two defects compound: the missing columns AND the unchecked-write pattern the earlier audits established (audit-reports/notifications, drafting-flow — supabase-js resolves with {error}, so an unchecked write reads as success). Adding the columns without checking results leaves the next drift equally silent; checking results without adding the columns turns every share download into a hard failure. Both are needed. Note also that even with columns added, the drafting rows set no document_id/version_id, so staleCopies.ts:45 (`.not("version_id", "is", null)`) would still skip them — the recall path needs the version id, not just a filename.

**Done when.**

- [ ] A migration adds the columns these inserts write (source, and the ticket/attachment columns) or the inserts are rewritten to the existing schema
- [ ] Every download_audits insert destructures and checks `{ error }` and surfaces or logs a real failure
- [ ] Drafting-portal audit rows carry document_id and version_id so staleCopies can see them
- [ ] A test asserts a share-link download produces exactly one download_audits row

---

<a id="phys-9"></a>

## PHYS-9 · The drafting download watermark asserts "CONTROLLED COPY" while the footer stamped on the same page by the same call says "UNCONTROLLED COPY" — and nothing registers, numbers, or recalls the copy it claims is controlled

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:647`, `app/(protected)/requests/[id]/page.tsx:575`, `lib/stamping.ts:211`, `lib/stamping.ts:56-64`, `lib/downloads.ts:30-37`, `lib/downloads.ts:222-226`

**Mechanism.** `performDownload` passes `watermarkText: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY"` (647). `handlePrint`, for the identical file, passes `"UNCONTROLLED COPY"` (575). Inside the stamper, `buildStampText` puts watermarkText into the diagonal run (stamping.ts:56-64) but `drawFooter` builds its main line from a hardcoded constant that ignores it entirely: `const mainText = \`UNCONTROLLED COPY • Downloaded: ${formatDate(opts.timestamp)} • Do Not Distribute\`` (stamping.ts:211). So the downloaded deliverable carries a diagonal watermark reading CONTROLLED COPY and a footer on every single page reading UNCONTROLLED COPY. Separately, "controlled copy" is a load-bearing term of art: in this codebase a controlled copy is defined as the raw, unstamped pass-through given only to the active checkout holder (downloads.ts:30-37, 222-226). Nothing in the drafting download path registers a copy number, records a holder for recall, or sets an expiry the way a controlled copy demands — it just writes the string onto the page.

**Failure scenario.** A PM downloads an issued deliverable and hands the print to a contractor. The contractor sees CONTROLLED COPY across the sheet and files it as the authoritative drawing that Document Control will replace when it changes — while the footer on the same page says UNCONTROLLED. Whichever he believes, no recall list contains him: the copy was never registered as controlled, and (see the download_audits findings) the audit insert for this pull fails silently.

**Evidence.**

```
requests/[id]/page.tsx:647 `watermarkText: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY",`; requests/[id]/page.tsx:575 `watermarkText: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "UNCONTROLLED COPY",`; stamping.ts:211 `const mainText = \`UNCONTROLLED COPY • Downloaded: ${formatDate(opts.timestamp)} • Do Not Distribute\`;`
```

**Chain reaction.** The hardcoded footer at stamping.ts:211 silently overrides every caller's intent, so it also masks the divergence rather than surfacing it — a caller passing any watermarkText gets the same footer. Either the footer should derive from watermarkText (making the contradiction a visible bug at every call site) or StampOptions should carry an explicit control-state enum that drives both marks together. Also note formatDate returns "" for an undefined timestamp (stamping.ts:52-53), producing a footer reading "Downloaded:  • Do Not Distribute".

**Done when.**

- [ ] The drafting download and print paths agree on one control state for the same file
- [ ] The footer main line derives from the same control state as the watermark rather than being hardcoded
- [ ] No print path emits the string "CONTROLLED COPY" unless a registered controlled-copy record exists for that pull

---

<a id="phys-10"></a>

## PHYS-10 · A hold card scans GREEN "RELEASED — this tag can come down" when its own hold is released, even while other holds are still active on the same document — the multi-hold design is explicit and the verify page has no knowledge of siblings

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/api/verify-hold/route.ts:27-32`, `app/api/verify-hold/route.ts:53-61`, `app/verify-hold/[holdId]/page.tsx:53-54`, `app/verify-hold/[holdId]/page.tsx:81-88`, `lib/holds.ts:11-14`, `lib/physicalBridge.ts:150`, `lib/physicalBridge.ts:170-172`
- **Also surfaced independently as** [`VFY-10`](./01-verify-endpoints.md#vfy-10) — two lenses found this separately. Fix once.

**Mechanism.** lib/holds.ts:11-14 states the design: "Multiple holds can be active on the same document simultaneously (e.g. 'Awaiting Engineering' + 'Missing Vendor Data' at once)." Each active hold gets its own printed red card (HoldStrip's ActiveHoldRow renders a per-hold Print button). /api/verify-hold fetches exactly one row by id (27-32) and returns `active: !h.released_at` (54) — it never asks whether the document carries any other unreleased hold. The landing page paints the whole viewport `result?.active ? "bg-red-600" : "bg-emerald-600"` and prints "RELEASED / This hold has been released — this tag can come down" (53-54, 81-88). The printed card reinforces it in bold across the top — "HOLD — DO NOT ADVANCE" (physicalBridge.ts:150) — and at the bottom instructs "A released hold shows GREEN when scanned — then this tag comes down" (170-172). So releasing one of two holds turns one physical tag green and instructs the field to remove it, while the document remains blocked.

**Failure scenario.** A vessel drawing carries two holds: "Missing Vendor Data" and "Field Verification Needed". Two red cards hang on the equipment. Vendor data arrives; Document Control releases that hold. A field lead scans the vendor card, gets a full-screen green RELEASED with "this tag can come down", removes it — and by the same logic assumes the second card, which he does not scan, is the stale duplicate. The equipment now reads as clear while a field-verification hold is still open on the drawing.

**Evidence.**

```
verify-hold/route.ts:54 `active: !h.released_at,`; verify-hold/[holdId]/page.tsx:86-87 `: "This hold has been released — this tag can come down."`; holds.ts:11-13 `// Multiple holds can be active on the same document simultaneously\n// (e.g. "Awaiting Engineering" + "Missing Vendor Data" at once).`
```

**Chain reaction.** The route already loads `h.document_id` and does a second query against `documents` (route.ts:37-41), so counting sibling active holds is one more indexed query (document_holds_active_doc_idx exists per migration 20260612). The green screen must become conditional: this hold released BUT the document still has N active holds → amber, not green, and the card must not instruct removal. The same reasoning applies to the printed card's bottom line at physicalBridge.ts:170-172, which is the instruction the field actually follows.

> **Verifier correction.** Drop "instructs the field to remove it while the document remains blocked" — per-hold cards mean removing that tag is correct. The surviving defect is that /api/verify-hold returns no sibling-hold context, so a GREEN scan gives no signal that the document itself is still held. MEDIUM/SUSPECTED.

**Done when.**

- [ ] /api/verify-hold returns the count of other active holds on the same document
- [ ] The landing page shows a non-green verdict when this hold is released but siblings remain, and does not say "this tag can come down"
- [ ] The printed card's instruction text matches the conditional verdict

---

<a id="phys-11"></a>

## PHYS-11 · NEXT_PUBLIC_SITE_URL — the single variable every printed QR depends on — is documented as optional with a VERCEL_URL fallback that publicOrigin() does not have; unset, server-side stamps ship a footer telling the reader to scan a QR that was never drawn

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `.env.example:43-46`, `lib/publicOrigin.ts:17-22`, `app/layout.tsx:16-18`, `app/api/share/file/route.ts:113-116`, `lib/docPack.ts:101-106`, `lib/downloads.ts:95-102`, `lib/physicalBridge.ts:49-53`

**Mechanism.** publicOrigin() reads only NEXT_PUBLIC_SITE_URL, then falls back to window.location.origin, then to the empty string (publicOrigin.ts:17-22). .env.example files it under "Misc (optional)" and says "Public origin used when building absolute links server-side (falls back to VERCEL_URL on Vercel deployments)" (43-46). That fallback does not exist in publicOrigin — two greps (`NEXT_PUBLIC_SITE_URL` across the tree, and `VERCEL_URL` across all .ts/.tsx) show VERCEL_URL appears in exactly one place, app/layout.tsx:16-18, for OG metadata only. Consequences split by environment: (a) SERVER-SIDE with the var unset, publicOrigin() returns "", so app/api/share/file/route.ts:114 evaluates `versionId && publicOrigin()` to falsy, verifyUrl is undefined, applyStampToPdfDoc skips the QR entirely (stamping.ts:246) — and the footer stamped on every page still reads "...at time of download — scan the QR to confirm it is still current" (route.ts:113). The externally shared copy instructs the outsider to scan a code that is not on the paper. (b) CLIENT-SIDE, it silently falls back to window.location.origin — precisely the failure publicOrigin's own header comment says it exists to prevent: "window.location.origin is wrong whenever the person generating the print is on a preview/branch deploy — Vercel gates those behind its own login, so the scan dead-ends on a Vercel auth screen." Every label, hold card, traveler and pack cover printed from a preview deploy (physicalBridge.ts:49-53 routes all four through publicOrigin) carries a QR pointing at the gated preview host.

**Failure scenario.** A plant deploys without setting NEXT_PUBLIC_SITE_URL — reasonable, since .env.example lists it under optional and promises a Vercel fallback. Document Control shares an issued drawing with an outside inspector via a share link. The server stamps it, drops the QR because publicOrigin() returned "", and delivers a PDF whose footer says "scan the QR to confirm it is still current." The inspector looks for a QR, finds none, and either assumes the copy is fine or calls to ask — and there is no logged signal that anything went wrong.

**Evidence.**

```
.env.example:43-46 `# ─── Misc (optional) ──────────────────────────────────────────\n# Public origin used when building absolute links server-side (falls back\n# to VERCEL_URL on Vercel deployments).\nNEXT_PUBLIC_SITE_URL=`; publicOrigin.ts:18-22 `const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\\/+$/, "");\n  if (configured) return configured;\n  if (typeof window !== "undefined") return window.location.origin;\n  return "";`; share/file/route.ts:113-116 `footerNotice: ...\`scan the QR to confirm it is still current.\`,\n      verifyUrl: versionId && publicOrigin() ? ... : undefined,`
```

**Chain reaction.** This is the same class the earlier audits flagged twice (audit-reports/notifications NEDGE-11, audit-reports/drafting-flow EDGE-9) — the helper exists and the environment contract around it does not hold. Fixing publicOrigin to add the VERCEL_URL fallback its documentation already promises repairs server-side link building everywhere at once (share stamps, and the email producers those audits flagged). Independently, any stamp path that drops the QR must also drop the footer sentence that references it, or the paper contradicts itself.

> **Verifier correction.** Split the claim: the .env.example promise of a VERCEL_URL fallback that does not exist in publicOrigin() is CONFIRMED documentation drift; the two runtime consequences (silent QR-less footer server-side, preview-host QRs client-side) are SUSPECTED — they require the var to be unset, which the repo cannot show. MEDIUM.

**Done when.**

- [ ] publicOrigin() implements the VERCEL_URL fallback .env.example already documents, or .env.example stops claiming it
- [ ] NEXT_PUBLIC_SITE_URL moves out of the "optional" section and is described as required for the physical bridge
- [ ] When verifyUrl is undefined, the footer notice does not instruct the reader to scan a QR
- [ ] A server-side stamp with no resolvable public origin logs a warning rather than silently shipping a QR-less controlled-looking copy

---

<a id="phys-12"></a>

## PHYS-12 · The stamper computes QR and footer placement from pdf.js's rotation-aware viewport but draws using pdf-lib's unrotated MediaBox — on a /Rotate 90 sheet the verify QR lands in the wrong corner (often on the title block) and the watermark is fitted to swapped dimensions

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/stamping.ts:116-140`, `lib/stamping.ts:260-262`, `lib/stamping.ts:154-160`, `lib/stampLayout.ts:169-199`, `lib/stampLayout.ts:5-11`

**Mechanism.** analyzePageInk rasterizes each page via `page.getViewport({ scale: RASTER_WIDTH / base.width })` (118-119) and measures ink in four corner boxes and two bands against that canvas (130-140). pdf.js viewports APPLY the page's /Rotate entry, so `W`/`H` and the corner labels are in DISPLAY space. The drawing side then reads `const { width, height } = page.getSize()` (262) and `drawWatermark` reads it again (156) — pdf-lib's getSize returns MediaBox dimensions and does NOT apply /Rotate. Two greps (`getRotation|setRotation|/Rotate` over the stamping files, then `getRotation` over the whole tree) find no rotation handling anywhere in the repo. On a page with /Rotate 90 the two spaces disagree: pageW and pageH are transposed relative to what was measured, so placeQr's clamped plate (stampLayout.ts:187-188) is computed against the wrong extents, and the corner chosen as emptiest in display space is not the corner the plate lands in on the MediaBox. drawWatermark's fitRotatedTextSize is likewise fed transposed pageW/pageH (160).

**Failure scenario.** A D-size piping isometric is stored with /Rotate 90 (common for drawings produced landscape from a portrait MediaBox). The ink analysis correctly identifies the top-left as empty and the bottom-right as the title block. placeQr is told "tl" but computes plateX/plateY against the transposed page, and the white plate plus SCAN TO VERIFY caption print over the title block — obscuring the revision block on the very sheet whose point is revision verification, or landing partly off the printed area.

**Evidence.**

```
stamping.ts:118-119 `const base = page.getViewport({ scale: 1 });\n        const viewport = page.getViewport({ scale: RASTER_WIDTH / base.width });`; stamping.ts:262 `const { width, height } = page.getSize();`; stampLayout.ts:5-11 `// Why this exists: the first stamping pass used fixed coordinates and fixed // font sizes. Real drawings punished it — ... and the always-bottom-right QR sat // on top of title blocks.`
```

**Chain reaction.** stampLayout.ts's own header names "the always-bottom-right QR sat on top of title blocks" as the bug this module was built to fix; on rotated sheets the fix does not apply, so the original symptom returns on exactly the large-format engineering drawings the analysis was added for. Marked SUSPECTED because the visual outcome depends on the specific /Rotate value and MediaBox of real files, which cannot be observed from the repo — but the coordinate-space mismatch is unambiguous in the code, and the unit tests (lib/__tests__/stampLayout.test.ts) exercise only the pure math, never rotation.

**Done when.**

- [ ] applyStampToPdfDoc reads page.getRotation() and maps the analysis result and the placement coordinates into the same space
- [ ] A stamped page with /Rotate 90 places the QR in the corner the analysis chose, on-page
- [ ] A fixture test covers a rotated-page PDF end to end

---

<a id="phys-13"></a>

## PHYS-13 · Two QR generators bypass publicOrigin() and encode window.location.origin — including the share-link QR handed to external parties

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/viewers/FullScreenViewer.tsx:1268`, `components/viewers/FullScreenViewer.tsx:63`, `components/viewers/FullScreenViewer.tsx:1015-1016`, `components/documents/ShareLinkModal.tsx:81`, `components/documents/ShareLinkModal.tsx:209`, `lib/publicOrigin.ts:8-12`

**Mechanism.** Grepping `QrBadge` across the tree finds exactly three files (the component plus two call sites). Both call sites build their value from window.location.origin rather than publicOrigin(). FullScreenViewer's "continue on phone" QR: `value={\`${window.location.origin}/documents/${docRecord.libraryId}?doc=${docRecord.id}\`}` (1268) — in a file that imports publicOrigin at line 63 and uses it correctly three lines of code away for the markup stamp (1015-1016). ShareLinkModal: `const baseUrl = typeof window !== "undefined" ? \`${window.location.origin}/share/\` : "/share/"` (81), whose product is rendered as `<QrBadge value={url} size={140} caption="Scan to open this share link" />` (209). publicOrigin.ts:8-12 names this exact anti-pattern and its consequence.

**Failure scenario.** Document Control is testing on a Vercel preview deploy and generates a share link for an outside inspector, showing him the QR on screen or printing the modal. The encoded host is the preview deployment, which Vercel gates behind its own login. The inspector scans and lands on a Vercel auth screen — the share token is valid, the document is fine, and the bridge is dead. The same holds for the phone QR: an engineer scans to carry the drawing to the unit and gets an auth wall at the pump.

**Evidence.**

```
FullScreenViewer.tsx:1268 `value={\`${window.location.origin}/documents/${docRecord.libraryId}?doc=${docRecord.id}\`}`; ShareLinkModal.tsx:81 `const baseUrl = typeof window !== "undefined" ? \`${window.location.origin}/share/\` : "/share/";`; publicOrigin.ts:8-12 `// point at the PUBLIC production domain. \`window.location.origin\` is wrong // whenever the person generating the print is on a preview/branch deploy —`
```

**Chain reaction.** The ShareLinkModal baseUrl is also the string copied to the clipboard and pasted into emails, so the same wrong origin escapes by a second route. Distinct from audit-reports/notifications NEDGE-11, which covers lib/transmittals.ts transmittalPortalUrl — same anti-pattern, three different files. A lint rule banning `window.location.origin` outside publicOrigin.ts would close the class.

> **Verifier correction.** Narrow to ShareLinkModal.tsx:81/:209. The FullScreenViewer phone QR targets a login-required in-app route for the same viewer in the same session, which is the case publicOrigin() was not written for; it is at most an inconsistency, not a field-scan failure.

**Done when.**

- [ ] Both QrBadge call sites build their value from publicOrigin()
- [ ] ShareLinkModal's copied link and its QR use the same publicOrigin-derived base
- [ ] No file outside lib/publicOrigin.ts reads window.location.origin to build a URL that leaves the app

---
