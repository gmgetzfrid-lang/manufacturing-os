# 03 · The physical bridge — QR, labels, stamps, print

**14 findings** — 2 CRITICAL · 7 HIGH · 4 MEDIUM, plus `PHYS-14` (MEDIUM) opened by public-surfaces Round F (PS-VERIFY), 2026-10-01.

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

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** document-control P8 FIELD (running; reconciled at its merge) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:34-38`, `app/api/verify/route.ts:89-90`, `app/verify/[docId]/page.tsx:64-65`, `app/verify/[docId]/page.tsx:98-100`, `app/api/verify-package/route.ts:56`, `app/api/verify-package/route.ts:61`, `lib/documentGuards.ts:1-7`, `lib/downloads.ts:227-240`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The mechanical claim is correct — a held document scans GREEN. But 'invisible to every field scan' is false, and CRITICAL rests on a premise the codebase contradicts: holds are defined in-repo as blocks on ADVANCING a document, not on using a print (lib/documentGuards.ts:105-107 'Any active hold blocks the operation (the hold exists precisely to stop the document from advancing)'; components/ui/IsoGuidance.tsx:112-118 'no new revisions, no IFC release'), and the physical carrier for a hold is its own tag — lib/physicalBridge.ts:150 draws 'HOLD — DO NOT ADVANCE' and :164 stamps a `/verify-hold/{holdId}` QR served by app/api/verify-hold/route.ts. Real gap, HIGH not CRITICAL.

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

**Partial (2026-10-01, public-surfaces Round F).** PS-VERIFY. Verified at `3a3203d`: done-when 1 and 3 landed at document-control `DIST-2` (2026-08-24) — `/api/verify` reads `legal_hold` and unreleased `document_holds` and returns a distinct `held` verdict (red "ON HOLD — STOP WORK", fail-safe on a read error), and Void / Draft have their own verdicts. This pass:
- **Done-when 2:** `/api/verify-package` reads holds ONCE for every printed sheet and marks a held sheet `held` with its own label ("ON HOLD · <category>"), never fresh; the pack reads `held` ("PACK ON HOLD — STOP WORK"); an unreadable hold state holds every sheet (`VFY-5`, document-control `HLD-3`).
- **The rest of done-when 3:** the shared allow-list (`lib/verifyVerdict.ts`, `VFY-1`) makes every status outside Issued / Locked non-green on both routes; `/api/verify` now also names the hold categories (`VFY-5`).
- Files: `app/api/verify-package/route.ts`, `app/api/verify/route.ts`, `lib/verifyVerdict.ts`, `lib/verifyPresent.ts`, `app/verify-package/[packageId]/page.tsx`. Tests: `lib/__tests__/verifyPackageSnapshot.test.ts` "HLD-3 / PHYS-1 / VFY-5 …"; `lib/__tests__/verifyRouteVerdict.test.ts`.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when (this pass).**
1. ✓ (DIST-2; categories added here, `VFY-5`)
2. ✓ A held member sheet is not-fresh with its own label.
3. ✓ (DIST-2 + the `VFY-1` allow-list)
4. ✗ Not done here — the hold line in `lib/downloads.ts` `buildFooterNotice` is document-control P8 FIELD's (the `HLD-1` download / footer limb); PS-VERIFY owns `lib/downloads.ts` only at `buildVerifyUrl`.

**Scope / residual.** Stays OPEN for done-when 4 → document-control P8 FIELD.


**Resolution (2026-10-01, document-control Round F wave 2 — reconciled by the integrator at the P8 merge).** Done-when 4 landed with P8 FIELD's `HLD-1` download / footer limb. `lib/downloads.ts` `buildFooterNotice(ctx, hold)` adds `holdFooterLine(hold)`. The line reads "ON HOLD at time of issue (<reasons>) — work from this document is stopped until Document Control releases the hold", or "HOLD STATUS UNKNOWN at time of issue …" when the hold state cannot be read. Both copy paths (`downloadDocumentPdf` / `printDocumentPdf`) read the hold at issue time (`readCopyHoldState`) and pass it to the footer and to `copyWatermark` ("ON HOLD — DO NOT USE"). Tests: `lib/__tests__/dcRoundFField.test.ts` ("ON HOLD at time of issue (Client Review)", the deduplicated reasons, no line for an unheld document). Done-when 1–3 landed earlier (Partial above).

**Done-when.**
- [x] 1 — `DIST-2` + `VFY-5` (above).
- [x] 2 — PS-VERIFY (above).
- [x] 3 — `DIST-2` + the `VFY-1` allow-list (above).
- [x] 4 — `buildFooterNotice` adds the hold line at issue time (P8 FIELD).

**Scope / residual.** None for this finding. The copy paths are client-side, as the verifier noted for `HLD-1`, whose own record keeps its remaining limbs.
---

<a id="phys-2"></a>

## PHYS-2 · Printing an older ticket deliverable stamps it with the ticket's CURRENT revision and encodes that rev in the QR — the scan then certifies a superseded print as "LATEST ISSUE" in green

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:1391`, `app/(protected)/requests/[id]/page.tsx:569`, `app/(protected)/requests/[id]/page.tsx:577-578`, `app/(protected)/requests/[id]/page.tsx:637`, `app/(protected)/requests/[id]/page.tsx:649-650`, `app/(protected)/requests/[id]/page.tsx:1008-1011`, `app/(protected)/requests/[id]/page.tsx:1360`, `app/api/verify-ticket/route.ts:78-83`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and there is no defence available: types/schema.ts:1038-1047 `interface TicketAttachment` carries no rev field at all, so the modal has nothing per-file to stamp with, and nothing in lib/ticketTransitions.ts removes or re-types prior Final attachments when deliverable_rev advances (:214-251 only write the new label). Printing a superseded Final produces paper and a QR that both certify the current rev. CRITICAL stands.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/assets/[tag]/page.tsx:52-56`, `app/(protected)/assets/[tag]/page.tsx:75`, `app/(protected)/assets/[tag]/page.tsx:94`, `app/(protected)/assets/[tag]/page.tsx:139-142`, `lib/docPack.ts:51-54`, `lib/docPack.ts:100-106`, `lib/docPack.ts:3-7`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every leg. The QR does partly self-correct a Superseded sheet (app/api/verify/route.ts:89), but a VOID sheet is not in that route's docRetired list, so a voided drawing in the pack scans green — the paper claim 'all current' is unqualified and unchecked. HIGH stands.

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

**Resolution (2026-10-01, public-surfaces Round F).** Record-only — closed by document-control `PKG-4`, `PKG-6` and Phase 7b; verified at `3a3203d`:
- `lib/docPack.ts` `filterPackDocs` refuses Draft / Superseded / Void / Archived and every actively held sheet, failing CLOSED on an errored hold read, with the reason in `skipped`; `assessPackDocs` runs the same gate before any side-effect.
- The asset page says "all current, all stamped" only when nothing was skipped and otherwise names every sheet left out and why (`app/(protected)/assets/[tag]/page.tsx`); the packages page lists the left-out sheets the same way.
- The work-package cover is built from the sheets actually in the merged PDF (`buildCoverAfter(includedSheets)`), each with the revision recorded in the immutable print snapshot — the version `/api/verify-package` compares against (PKG-6: snapshot = cover = paper; PKG-2 replaced the live pin as the comparison).

**Done-when.**
1. ✓ Non-issued and held documents are skipped with a reason (PKG-4).
2. ✓ The success copy matches what was packed (PKG-4 / 7b).
3. ✓ The cover prints the revision the QR verifies against (PKG-6 / PKG-2) — and, since this pass, every sheet (document-control `PKG-12` cover limb).

**Scope / residual.** None.

---

<a id="phys-4"></a>

## PHYS-4 · /d/[number] resolves any document number against ALL orgs with the service-role client and redirects with the document UUID — destroying the "unguessable UUID" premise that /api/verify's unauthenticated exposure rests on

- **Severity:** HIGH
- **Status:** WONTFIX
- **Verification:** CONFIRMED
- **Locations:** `app/d/[number]/route.ts:14-32`, `lib/supabaseAdmin.ts:3-8`, `app/api/verify/route.ts:4-10`, `app/api/verify/route.ts:96-108`, `components/documents/RelatedPanel.tsx:111-113`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and slightly worse than described: the `?? (rows ?? [])[0]` fallback at :36 means even a non-matching 2-character substring returns some real document's UUID, and app/api/verify/route.ts:34-38/:96-108 then returns number, title, current rev and status for any UUID with no org scoping. HIGH stands.

> **Cross-area update (2026-08-24).** The `/d/[number]` half of this — the
> service-role, cross-tenant document-number→UUID oracle — was **closed** under
> `roles-and-permissions/EGRESS-2` (commit `67e6bdd`): the route no longer holds
> a service-role client or queries `documents`; it forwards to the protected
> page, which resolves client-side under the caller's RLS. The prose below
> quotes the *old* route (pre-fix) and its line numbers no longer resolve. **The
> remaining half is unfixed and owned here:** `/api/verify` returns document
> metadata for any UUID with no org scoping (`verify/route.ts:96-108`). PHYS-4
> stays OPEN for that; the leaked-UUID entry point it depended on is gone.

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

**Resolution (2026-10-01, public-surfaces Round F) — WONTFIX for the residual, by design.** The `/d/[number]` half — the cross-tenant number → UUID oracle — was RESOLVED by roles-and-permissions `EGRESS-2` (commit `67e6bdd`): the route does no lookup and holds no service-role client (verified; `lib/__tests__/shortLinkRoute.test.ts`). The residual this record kept open — `/api/verify` returns document metadata for any document UUID with no org scoping — is the design of an unauthenticated field verify endpoint, not a defect to remove:
- **Cost of fixing it as written.** There is no org to scope by: the scanner has no session by design (a contractor at a pump). "Scope to the caller's org" means a login wall on every printed QR — the lesson `lib/physicalBridge.ts` records twice (traveler, pack cover) — or a second secret on paper that already carries an unguessable 128-bit UUID.
- **What bounds it now.** The leaked-UUID entry point is gone (EGRESS-2); every answered scan is recorded with its client IP and target, and an address is capped at 1200 scans an hour, so a walk of a register is visible and slow (`VFY-12`); a document-only QR no longer answers green (`VFY-3`); the payload is revision-status metadata only — no file, URL or person (`VFY-14`).
- **Rejected alternative.** An org check on the verify routes — impossible without a session. A per-print token for single sheets (intelligence `DACL-8` criterion 2) would swap the document UUID for another bearer string on the same paper — it moves the secret without shrinking it.
- **What would change the answer.** UUIDs leaking outside printed copies again (a new oracle), or a requirement that private / hidden documents' titles stay off the verify pages — that limb is opened as `VFY-16` (the `DACL-8` handover).

**Done-when.**
1. ✓ (EGRESS-2) `/d/[number]` no longer queries anything; it forwards to the protected documents page, which resolves under the caller's RLS.
2. ✓ (EGRESS-2) No loose fallback; an exact normalized match or the search page.
3. ◐ An unauthenticated GET returns a Location of `/documents?d=<number>` — never a document UUID ✓; it is not a redirect to sign-in (the protected layout does not itself bounce a no-session visit — an identity-and-session question outside this finding).

**Scope / residual.** WONTFIX covers only the unauthenticated, org-unscoped metadata answer of `/api/verify`. The visibility limb is `VFY-16` (OPEN).

---

<a id="phys-5"></a>

## PHYS-5 · A marked-up PDF exported by the checkout holder ships with no watermark, no footer, and no verify QR — redlines that are explicitly "not part of the controlled revision" leave the app looking like a controlled drawing

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/viewers/FullScreenViewer.tsx:961-966`, `components/viewers/FullScreenViewer.tsx:1005-1020`, `components/viewers/FullScreenViewer.tsx:1024-1027`, `components/viewers/FullScreenViewer.tsx:985-1000`, `lib/downloads.ts:30-37`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by the code's own words: the footer text it skips is the one asserting the markups are not the controlled revision. The 'controlled copy = raw PDF' rule is deliberate for a clean issue, but a redlined sheet is by definition not the controlled revision, so applying that rule here produces an unmarked drawing carrying non-issued linework. HIGH stands.

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

**Resolution (2026-10-01, public-surfaces Round F).** Reproduced against `c23611b`: `components/viewers/FullScreenViewer.tsx` `downloadWithMarkup` computed `const stampNow = liveState !== "controlled"` and, for the checkout holder, skipped `applyStampToPdfDoc` entirely (`suffix` stayed `"_markup"`, the audit call passed `state: liveState` = `"controlled"` and `expiresAt: null`). Now:
- `downloadWithMarkup` stamps unconditionally — the "UNCONTROLLED — FOR REVIEW ONLY" watermark, the "… WITH MARKUPS at time of export — markups are not part of the controlled revision." footer and the `/verify` QR (bound to the served version when the public origin resolves) — for every exporter, the checkout holder included. The `stampNow` gate and its `determineControlState` call are gone; the controlled-copy exemption stays where it belongs, on the unmodified master (`lib/downloads.ts`).
- The file is always `<number>_Rev<rev>_markup_UNCONTROLLED.pdf`.
- `logDownloadAudit` is called with `state: "uncontrolled"` and the 24-hour expiry an uncontrolled copy carries.
- `requestMarkupDownload` lets the holder skip only the "you don't have this checked out" modal, never the stamp.
- The bake now goes through the shared, rotation-aware `bakeMarkupIntoDoc` (`lib/markupExport.ts`, `PHYS-12`).
- Files: `components/viewers/FullScreenViewer.tsx`.
- Tests: `lib/__tests__/psStampRoundF.test.ts` — "PHYS-5 — a marked-up export is always stamped and recorded uncontrolled" (four tests: no checkout gate and the stamp call unconditional; the `_markup_UNCONTROLLED` suffix; `state: "uncontrolled"` with `expiresAt`; the holder skips only the modal). All four fail on the base and pass after.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4636 tests: 4629 passed, 7 expected-fail). Re-run after the review fix pass: `tsc` 0, `eslint` 0, full `vitest` green (258 files / 4639 tests: 4632 passed, 7 expected-fail).

**Done-when.**
1. ✓ `downloadWithMarkup` always stamps, regardless of checkout state.
2. ✓ The exported filename always carries the `_markup_UNCONTROLLED` suffix.
3. ✓ `logDownloadAudit` for a markup export is called with state `"uncontrolled"` and the uncontrolled expiry. (`logDownloadAudit` is `lib/downloads.ts`, P8's; the `download_audits` row has no state column, and the always-set `expires_at` is what marks the row as an uncontrolled copy.)

**Scope / residual.**
- The viewer is a client component, so it is pinned by source tests: vitest runs `lib/__tests__` in node and there is no component harness.
- This closes the defect in `FullScreenViewer` only. The same defect still reaches paper through the book viewer. `components/viewers/MultiDocViewer.tsx` `runDocAction` bakes the markups with `bakeMarkupIntoPdf` and hands the result to `downloadDocumentPdf`. For the checkout holder of the current version, that takes the controlled pass-through (`lib/downloads.ts`). The redlined PDF leaves unstamped, with no markup suffix, and is audited with `expires_at` null.
- That limb is not this finding's file. It is tracked as document-control `PKG-10` done-when 3 ("a baked-markup download is never treated as a controlled copy"), owned by document-control P8. Until it lands, "every modified copy is uncontrolled" holds for the `FullScreenViewer` export, not tree-wide. *Corrected in the review fix pass:* the first write-up said "Nothing else is left".

---

<a id="phys-6"></a>

## PHYS-6 · Downloading an older revision from Version History stamps the footer and names the file with the document's CURRENT rev — the paper asserts a revision it does not contain

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/downloads.ts:80-88`, `lib/downloads.ts:71-76`, `lib/downloads.ts:228-240`, `components/documents/VersionHistoryPanel.tsx:150-159`, `lib/downloads.ts:95-102`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly as claimed, including the internal contradiction the finding relies on: the same stamped page asserts the current rev in text and the printed rev in the QR. HIGH stands.

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

**Resolution (2026-10-01, public-surfaces Round F).** Record-only — closed by document-control `REV-1` (2026-08-24); verified at `3a3203d`: `DownloadContext` carries `versionRev` / `versionIsCurrent`; `servedRev(ctx)` names the SERVED version in `defaultFilename` (`…_Rev2_UNCONTROLLED.pdf`) and `buildFooterNotice`; `VersionHistoryPanel` passes `versionRev: v.revisionLabel` and `versionIsCurrent`. A history pull of Rev 2 on a Rev 5 document is stamped "SUPERSEDED REVISION — Rev 2. This is NOT the current revision; do not use for construction. Scan to verify." Tests: `lib/__tests__/downloadsRevLabel.test.ts` (the footer names the served rev and SUPERSEDED, never the current one; the QR carries the served version).

**Done-when.**
1. ✓ `DownloadContext` carries the delivered version's label; the footer and filename use it.
2. ✓ A history download of Rev N on a document at Rev M names Rev N.
3. ✓ in substance — the footer distinguishes "this print is Rev N" from the current revision ("NOT the current revision") rather than printing one number as if it were both; it does not print the current label M, which would itself go stale on the paper. The QR answers the live current revision ("DO NOT USE — This print is Rev 2 — the current revision is Rev 5").

**Scope / residual.** None.

---

<a id="phys-7"></a>

## PHYS-7 · Equipment QR labels point at /assets/[tag], a route inside the (protected) group — the sticker on the pump advertises "SCAN: drawings · holds · report a problem" and lands an account-less scan on the signed-in app shell with nothing in it

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/physicalBridge.ts:84`, `lib/physicalBridge.ts:99`, `lib/physicalBridge.ts:6-7`, `lib/physicalBridge.ts:219-220`, `lib/physicalBridge.ts:272-274`, `app/(protected)/assets/[tag]/page.tsx:1`, `app/(protected)/layout.tsx:27-51`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Factually correct: the sticker's URL is inside the protected group, nothing redirects an account-less scan to a login, and the page spins forever because refresh() early-returns without clearing its initial loading=true. Severity lowered to MEDIUM — this is a dead-end for account-less scans only (signed-in staff get the real page), it discloses nothing and, unlike PHYS-10, shows no misleading information; the label also never promises 'no login needed' the way the package cover (physicalBridge.ts:279) does.

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

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY — one fix with document-control `HLD-13`, under option (b) (the user-informed default, 2026-09-17; recorded as `DEC-65`). Reproduced on `3a3203d`: `drawLabel` built `${origin()}/assets/<tag>` with the one-line caption "SCAN: drawings · holds · report a problem" (drawn unfitted — about 160pt into the single sticker's 100pt text column), and the protected asset page's `refresh()` returned early without an org, leaving its spinner up, so a no-session scan sat on an empty app shell.
- **Option (b):** keep `/assets/<tag>` — every sticker in the plant stays valid, no re-print — and make the page honest about being a staff page.
- `lib/physicalBridge.ts`: `equipmentLabelUrl(tag)` (the path shape, pinned by test) and `LABEL_CAPTION_LINES` — "SCAN — STAFF SIGN-IN" / "drawings · holds ·" / "report a problem" — each fitted to the label's text column (measured at 7pt with pdf-lib's Helvetica metrics in the test).
- `app/(protected)/assets/[tag]/page.tsx`: once the session boot has settled with no user (`booted && !loading && !uid`), the page shows "Equipment <tag> — Drawings, holds and problem reports for this equipment are for signed-in staff — Sign in to continue" and `router.replace("/?next=/assets/<tag>")` — sign-in, with the tag in `next`.
- **Review fix pass (2026-10-01): redirect only on a DEFINITIVE no-session.** RoleContext's `booted` also turns true when its 8 s boot watchdog (`BOOT_SPINNER_MS`) gives up while `getSession` is still refreshing a token, so on a slow plant network a signed-in user was sent to sign-in — where `app/page.tsx` routed them to `/dashboard`, the tag lost. The page now confirms with `getSession` itself (`watchForNoSession`, new `lib/assetSignIn.ts`, with `assetSignInHref(tag)`): it redirects only when the answer resolves with no session and no error; while pending it keeps its spinner; an errored read ("unknown") shows the sign-in link without navigating away; a late answer after cleanup is ignored. Tests: `verifyDoor.test.ts` "PHYS-7 — watchForNoSession: booted can flip while getSession is still pending" (pending → nothing, then a session → no redirect; resolved null → `none`; errored / rejected → `unknown`; cancelled → nothing) and the page-source pin. Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).
- Files: `lib/physicalBridge.ts`, `lib/assetSignIn.ts`, `app/(protected)/assets/[tag]/page.tsx`. Tests: `lib/__tests__/verifyDoor.test.ts` "PHYS-7 / HLD-13 (option b) — the equipment label", "PHYS-7 — watchForNoSession …".
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. Not done as written, by decision (b): a no-session scan lands on the sign-in page with the tag in `next`, not on a public page naming the tag and its hold state. The public minimal-facts tag page was option (a); the default chose (b). The sign-in page does not yet honour `next`, so the round trip does not return to the tag — that remainder is `PHYS-14` (DEC-31).
2. ✓ The caption promises only what the landing delivers — staff sign-in.
3. ✓ The path shape survives; no re-print.

**Scope / residual.** The sign-in page (`app/page.tsx`) does not yet read `next`, so after signing in a person lands on `/dashboard`, not back on the tag — opened as `PHYS-14` (unowned; `app/page.tsx` is in no current package's file list). Overriding the default to option (a) means a public tag page under the `/verify*` contract (DEC-65, reversal).

---

<a id="phys-8"></a>

## PHYS-8 · Every share-link and drafting-portal download writes download_audits rows containing columns that do not exist in the schema, and no caller checks the result — the distribution record for external and drafting copies is silently never written

- **Severity:** HIGH
- **Status:** OPEN
- **Assigned:** drafting-flow DF-P10 (= PKG-5, the drafting limb) and document-control P8 FIELD (the lib/downloads.ts limb) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:789-799`, `app/api/share/file/route.ts:129-141`, `app/(protected)/requests/[id]/page.tsx:592-600`, `app/(protected)/requests/[id]/page.tsx:673-684`, `lib/downloads.ts:131-145`, `lib/staleCopies.ts:39-47`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves: the columns exist nowhere in the schema or any migration, and every one of these callers discards the outcome (supabase-js returns `{error}` rather than throwing, so the try/catch at share/file:141 is not even reached). The paths that DO write valid rows — lib/downloads.ts:132-141, lib/docPack.ts:114-122, components/viewers/MultiDocViewer.tsx:737-747 — use only real columns, which is exactly why the distribution record contains internal pulls and nothing else.

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

**Partial (2026-09-29, document-control Round F wave 2).** **The share-link limb is resolved** (document-control `DIST-7` / `EGR-3`, public-surfaces `SHR-5` — one fix): `20261068` (P2 EGRESS) added `source`, `share_id`, `transmittal_id` and made `user_id` nullable behind an attribution CHECK; `app/api/share/file/route.ts` writes exactly that shape (`user_id: null`, `share_id`, `source`, the served `version_id`), checks `{ error }`, logs a refusal and refuses the download `503 unrecorded` before any byte leaves (a refusal that is the unapplied `20261068` itself is retried once in the pre-20261068 shape and logged as the deploy order — `DIST-7`). `lib/__tests__/shareRoutes.test.ts` asserts exactly one `download_audits` row per share download and that a refused write refuses the download (criterion 4 ✓).

**The drafting-portal limb is NOT resolved here** — `app/(protected)/requests/[id]/page.tsx:592-600` / `:673-684` (inserts naming `ticket_id`, `attachment_id`, `attachment_type`, `filename`, `watermark_text` and no `document_id` / `version_id`) and `lib/downloads.ts:131-145` are owned by public-surfaces `PKG-5 DRAFTING-DELIVERABLE-PRINT` (with the drafting-flow fleet) and document-control P8 (`DIST-9` limb) respectively, not this package's files. `20261068` deliberately added only the channel / attribution columns, not the ticket / attachment ones — PKG-5 decides whether to rewrite those inserts onto the existing schema (the DEC-44 shape: `document_id` + `version_id` + `source: "drafting"`) so `staleCopies` can see them.

**Done-when (this pass).**
1. ◐ `source` (+ `share_id` / `transmittal_id`) added by migration; the ticket / attachment columns are not — PKG-5 rewrites those inserts or adds them.
2. ◐ The share route's insert checks `{ error }` and fails closed; the requests-page and `lib/downloads.ts` inserts are PKG-5's / P8's.
3. ✗ Drafting-portal rows carrying `document_id` / `version_id` — PKG-5.
4. ✓ A test asserts a share-link download produces exactly one `download_audits` row (and none when refused).

**Scope / residual.** Stays OPEN for the drafting limb (PKG-5 / P8). Pending migration: `supabase/migrations/20261068_dc_roundF_download_audits_record.sql` (P2 — not applied).

---

<a id="phys-9"></a>

## PHYS-9 · The drafting download watermark asserts "CONTROLLED COPY" while the footer stamped on the same page by the same call says "UNCONTROLLED COPY" — and nothing registers, numbers, or recalls the copy it claims is controlled

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:647`, `app/(protected)/requests/[id]/page.tsx:575`, `lib/stamping.ts:211`, `lib/stamping.ts:56-64`, `lib/downloads.ts:30-37`, `lib/downloads.ts:222-226`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both marks land on the same page from the same call — the footer literal at stamping.ts:211 is unconditional. The document path never has this problem because lib/downloads.ts:30-36 gives a controlled copy as an unstamped pass-through and only ever stamps "UNCONTROLLED — FOR REVIEW ONLY" (:236); 'CONTROLLED COPY' as a watermark exists only on this drafting-portal branch. The registration half is right too: the audit row for this very download (:675-684) names columns that do not exist (see PHYS-8), so nothing records the copy at all.

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

**Partial (2026-10-01, public-surfaces Round F).** The stamping substrate landed. The caller half is drafting-flow DF-P10 (public-surfaces `PKG-5`): `app/(protected)/requests/[id]/page.tsx` is that package's file, so the finding stays OPEN. This package changes only that file's audit-row watermark (second review fix pass, below).
- `lib/stamping.ts`: `StampOptions.controlState?: StampControlState` (`"uncontrolled" | "review"`, default `"uncontrolled"`). There is deliberately no `"controlled"` member, because a stamped copy is never the controlled copy (the controlled copy is the unstamped pass-through to the checkout holder). The footer's main line is now DERIVED: `stampMainLine(controlState, timestamp)` gives "UNCONTROLLED COPY • Downloaded: <when> • Do Not Distribute" or "UNCONTROLLED COPY — REVIEW ONLY • …". It replaces the hardcoded literal at the old `stamping.ts:211`, and with no timestamp the empty "Downloaded:" segment (this finding's chain reaction) is left out. When a caller passes `controlState` and no `watermarkText`, the same state supplies the watermark ("UNCONTROLLED COPY" / "REVIEW ONLY — DO NOT DISTRIBUTE"), so the two marks come from one value. Every existing caller passes a `watermarkText`, and the default main line is the old one. Their words are therefore unchanged, with one exception: the drafting download's "CONTROLLED COPY" watermark, covered by the backstop below.
- `lib/stamping.ts` (added in the review fix pass): a watermark backstop. `stampWatermark(watermarkText, controlState)` prints a caller's watermark as given, unless it claims a controlled copy (`claimsControlledCopy`: the words "controlled copy" without "un", any case). In that case the control state's own watermark is printed ("UNCONTROLLED COPY" by default), and `applyStampToPdfDoc` logs a `[stamping] watermarkText "…" claims a controlled copy …` warning. The drafting download's `"CONTROLLED COPY"` (`requests/[id]/page.tsx:661`) therefore now prints as "UNCONTROLLED COPY", the same watermark `handlePrint` passes for that file. A caller's free-text `footerNotice` is still printed as given; no caller writes the claim there.
- Tests: `lib/__tests__/psStampRoundF.test.ts`, "PHYS-9 substrate — StampOptions.controlState drives the footer's main line":
  - the default line equals the old literal;
  - review copies;
  - no timestamp;
  - no state can print "CONTROLLED COPY" without "UN-";
  - a claiming watermark is replaced and every other watermark is kept;
  - end to end, a `"CONTROLLED COPY"` watermark prints as "UNCONTROLLED COPY" with the warning;
  - `controlState: "review"` with no `watermarkText` gives an agreeing watermark and footer end to end;
  - the literal is gone.
- The audit row (added in the second review fix pass). The backstop made the drafting download's distribution record disagree with its paper: `download_audits.watermark_text` still recorded "CONTROLLED COPY" (`requests/[id]/page.tsx:694`) for a copy that now reads "UNCONTROLLED COPY". Before this package the row matched the printed watermark. The first write-up named the literal but not that this package created the divergence. Fixed with a one-line change in DF-P10's file, listed as outside the plan: the insert records `stampWatermark(<the same literal the stamp is given>, undefined)`, the watermark the stamper actually prints ("UNCONTROLLED COPY" for an issued file, "REVIEW ONLY - DO NOT DISTRIBUTE" for a draft, as before). The import line gains `stampWatermark`. Nothing else in that file changed.
  - Test: "the drafting download's audit row records the watermark actually printed, not the literal the caller passed" (`psStampRoundF.test.ts`). It pins that the stamp and the audit take the same expression and that the audit passes it through `stampWatermark`.
- Verified after the review fix pass: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4639 tests: 4632 passed, 7 expected-fail). Re-run after the second review fix pass: `tsc` 0, `eslint` 0, full `vitest` green (258 files / 4653 tests: 4646 passed, 7 expected-fail).

**Done-when (this pass).**
1. ◐ The printed marks now agree: for an issued file the download and the print both stamp "UNCONTROLLED COPY" in the watermark and in the footer, and the download's audit row records the watermark printed. The caller still writes two different literals rather than one control state (DF-P10's file).
2. ◐ The footer's main line derives from an explicit control state ✓. The drafting caller still has to pass `controlState` and stop passing a contradicting `watermarkText` (DF-P10).
3. ✓ for every print that goes through the stamper: neither the footer's main line nor the watermark can carry "CONTROLLED COPY", whatever the caller passes. `requests/[id]/page.tsx:661` still passes the literal, and the stamper prints "UNCONTROLLED COPY" in its place (the stated default, "UNCONTROLLED COPY everywhere"). Only a caller's free-text `footerNotice` is not checked.

**Scope / residual.** Closer: drafting-flow DF-P10 (`PKG-5` DELIVERABLE-PRINT). It should pass `controlState: file.type === "Draft" ? "review" : "uncontrolled"` on both paths and drop the `watermarkText` literals. The audit row already records the printed watermark; when DF-P10 drops the literals, it records the state's watermark the same way (`stampWatermark(undefined, state)`).

---

<a id="phys-10"></a>

## PHYS-10 · A hold card scans GREEN "RELEASED — this tag can come down" when its own hold is released, even while other holds are still active on the same document — the multi-hold design is explicit and the verify page has no knowledge of siblings

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/api/verify-hold/route.ts:27-32`, `app/api/verify-hold/route.ts:53-61`, `app/verify-hold/[holdId]/page.tsx:53-54`, `app/verify-hold/[holdId]/page.tsx:81-88`, `lib/holds.ts:11-14`, `lib/physicalBridge.ts:150`, `lib/physicalBridge.ts:170-172`
- **Also surfaced independently as** [`VFY-10`](./01-verify-endpoints.md#vfy-10) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — no guard anywhere adds sibling awareness; the endpoint never touches document_id except to fetch the label. The one mitigation is that each hold gets its own card, so the second card still scans red; the failure is that the green card instructs removal of a tag while the document is demonstrably still held. MEDIUM is fair.

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

**Resolution (2026-10-01, public-surfaces Round F).** PS-VERIFY — fixed once with `VFY-10` (see that record for the route and page). `/api/verify-hold` returns the document's other active holds (count and categories) and a verdict; the page is green ONLY when this hold is released and no other hold is active, amber "RELEASED — DOCUMENT STILL ON HOLD … leave the equipment tagged" when siblings remain (or "CHECK OTHER HOLDS" when they could not be read), and never says "this tag can come down" otherwise. The printed card's instruction now matches: `lib/physicalBridge.ts` `HOLD_CARD_SCAN_LINES` — "GREEN when scanned = no hold remains on this document — this tag comes down." / "AMBER = this hold is released but another is still active — leave the equipment tagged." (each line fitted left of the QR).
- **Review fix pass (2026-10-01).** "No hold remains" now includes the document's legal hold: `/api/verify-hold` reads `documents.legal_hold` with the label and counts it among the other holds (unnamed), so a released card on a legally held document is amber — the same answer `/api/verify` gives — and an unreadable document is "CHECK OTHER HOLDS" (see `VFY-10`). Verified (fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5110 passed, 7 expected-fail); run against the first-pass code, 22 of the new / changed assertions fail (DEC-29).
- **Second review fix pass (2026-10-01).** The card's verdict now reaches the field on a database without `20261073`: the hold read named `held_rev_label` with no fallback, and PostgREST refuses such a select (`42703`), so every hold-card scan there was a 503. The route retries without the column on exactly that error (`isUndefinedColumnError`) and checks the retry; the held-at rev is then unknown (see `VFY-10`; tests in `verifyHold.test.ts` "VFY-10 / PHYS-10 review fix — the verdict reaches the field on a database without 20261073"). Verified (second fix pass): `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (268 files / 5131 passed, 7 expected-fail); run against the first fix pass's code, 21 of the new / changed assertions fail (DEC-29).
- Files: `app/api/verify-hold/route.ts`, `app/verify-hold/[holdId]/page.tsx`, `lib/verifyPresent.ts`, `lib/physicalBridge.ts`. Tests: `lib/__tests__/verifyHold.test.ts`, `lib/__tests__/verifyPresent.test.ts`, `lib/__tests__/verifyDoor.test.ts` "VFY-10 / PHYS-10 — the hold card says what the scan answers".
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ The route returns the count of other active holds on the document.
2. ✓ Released-with-siblings is non-green and does not say "this tag can come down".
3. ✓ The printed card's instruction matches the conditional verdict.

**Scope / residual.** None.

---

<a id="phys-11"></a>

## PHYS-11 · NEXT_PUBLIC_SITE_URL — the single variable every printed QR depends on — is documented as optional with a VERCEL_URL fallback that publicOrigin() does not have; unset, server-side stamps ship a footer telling the reader to scan a QR that was never drawn

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `.env.example:43-46`, `lib/publicOrigin.ts:17-22`, `app/layout.tsx:16-18`, `app/api/share/file/route.ts:113-116`, `lib/docPack.ts:101-106`, `lib/downloads.ts:95-102`, `lib/physicalBridge.ts:49-53`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct on every leg: the documentation promises a fallback the function does not implement, and the server-side stamp keeps the 'scan the QR' sentence after the QR has been suppressed. The client-side generators cited (lib/downloads.ts:95-102, lib/docPack.ts:101-106, lib/physicalBridge.ts:49-53) do survive an unset var via the window.location.origin branch — the damage is confined to server-rendered stamps, which is what the finding claims.

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

**Resolution (2026-10-01, public-surfaces Round F).** Reproduced against `c23611b`: `.env.example:43-46` filed `NEXT_PUBLIC_SITE_URL` under "Misc (optional)" and promised a `VERCEL_URL` fallback. `lib/publicOrigin.ts:17-22` had no fallback at all, so a server returned `""`. `lib/stamping.ts:246` skipped the QR with no `else` and no log, and any caller's "scan the QR" sentence still printed (`requests/[id]/page.tsx:592,664` always; `lib/downloads.ts:111` "Scan to verify."). Now:
- `lib/publicOrigin.ts` follows one documented order:
  1. `NEXT_PUBLIC_SITE_URL`.
  2. Vercel's production domain: `VERCEL_PROJECT_PRODUCTION_URL` on the server (set on every Vercel deployment, previews included, while the project exposes its system environment variables — the default; not verified here with exposure off), its `NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL` twin in a browser, with https added. Never `VERCEL_URL`, the deployment's own host, which on a preview is the login-gated hostname this helper exists to keep off paper.
  3. In a browser only, the page's own origin.
  4. `""`, meaning no link. Only a server with nothing configured reaches it. The server routes that build outbound links treat it as no link: the share and transmittal stamps drop the QR and the instruction to scan it, and the transmittal email refuses.
  `configuredPublicOrigin()` stops after step 2 and never answers with the page's host.
  *Corrected in the review fix pass.* The first write-up also refused a `*.vercel.app` page host at step 3 (`isVercelDeploymentHost`), so a browser on such a host with nothing configured got `""`. Three browser callers do not treat `""` as "no link". `components/documents/ShareLinkModal.tsx` copied a `/share/<token>` link and QR. `components/documents/RelatedPanel.tsx` copied `/d/<number>`. `lib/physicalBridge.ts` printed labels, hold cards, travelers and pack covers whose QR encoded a relative path. The refusal is removed, so a browser always gets an absolute origin. The first write-up's claim that every caller treats `""` as "no link" was false for those three and is withdrawn.
- `lib/stamping.ts`: a stamp with no `verifyUrl` logs `[stamping] no verifyUrl — this copy carries no verify QR and no instruction to scan one …`. When no QR is on the page (no URL, or a QR that failed to generate), `withoutScanInstruction` removes the instruction before the footer is drawn: the sentence, or the clause after an em dash. It prints "Confirm the current revision before use." in its place. This backs up every caller; the share route (P1) and the transmittal portal (P7) already word their footer on the URL.
- `.env.example`: `NEXT_PUBLIC_SITE_URL` has its own section, "Public origin (REQUIRED for the physical bridge)". It says what is built on it, that it should be set in every environment including previews, which fallback is actually implemented (`VERCEL_PROJECT_PRODUCTION_URL`, never `VERCEL_URL`), that a browser reads that domain only when Vercel exposes its system variables and otherwise uses its own address, and what happens with neither.
- Files: `lib/publicOrigin.ts`, `lib/stamping.ts`, `.env.example`.
- Tests: `lib/__tests__/psStampRoundF.test.ts`:
  - "PHYS-11 — publicOrigin(): configured, else production, else (browser) the page, never VERCEL_URL" covers:
    - the server production fallback, and `VERCEL_URL` never used;
    - `""` on a server with nothing set;
    - a browser with nothing configured getting its own absolute origin on any host, `*.vercel.app` and localhost included, so no caller builds a relative URL;
    - no host refusal left in the helper;
    - the exposed production domain on a preview host;
    - `configuredPublicOrigin` never using the page's host;
    - the `.env.example` pins.
  - "PHYS-11 / SHR-11 — the stamp never tells a reader to scan a QR it does not carry" covers the em-dash clause, the "Scan to verify." sentence, the share and transmittal wording, byte-identity without an instruction (including a "SCAN-001" document number), and end to end: no `verifyUrl` logs the warning with no caption and no instruction; a failed QR drops the instruction; with a QR, all of it stays.
  Every one of these fails on the base, except the browser page-origin case: that is the base's own behaviour, kept on purpose.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4636 tests: 4629 passed, 7 expected-fail). For a caller with a verify URL, a word-for-word comparison against the base stamper showed the same watermark, footer and caption words. Re-run after the review fix pass: `tsc` 0, `eslint` 0, full `vitest` green (258 files / 4639 tests: 4632 passed, 7 expected-fail).

**Done-when.**
1. ✓ `publicOrigin()` implements a server fallback and `.env.example` documents exactly that one. It is Vercel's production domain, deliberately not the `VERCEL_URL` the old comment named, because that is a preview's own host.
2. ✓ `NEXT_PUBLIC_SITE_URL` is out of "Misc (optional)" and described as required for the physical bridge.
3. ✓ When `verifyUrl` is undefined, or the QR could not be generated, no footer instructs the reader to scan a QR, whichever caller built the notice.
4. ✓ A stamp with no verify URL logs a warning, on the server and in the browser.

**Scope / residual.**
- The browser half (b), preview-host QRs, is closed wherever Vercel exposes its system environment variables (the default for Next.js projects): the browser reads the production domain at step 2, before the page's own host.
- It stays open in one case: a Vercel deployment with that exposure turned off and nothing configured. There a browser on a preview host falls back to that host at step 3, as it did on the base, so labels, stamps and share links made there can dead-end on Vercel's login. Setting `NEXT_PUBLIC_SITE_URL` closes it. Refusing the page host instead is safe only once every browser caller refuses on `""` (`lib/physicalBridge.ts`, PS-VERIFY's; `ShareLinkModal`, `RelatedPanel`). Until then a refusal turns a possibly gated link into a relative one that never works. No hand-off is needed while the helper keeps the page origin.
- The URL builders that still bypass `publicOrigin()` (IntakePanel, QuotesPanel, the library page's `/d/` copy, `lib/notifications.ts` `ticketUrl`) belong to their owners (`XEDGE-5` dw1, notifications `DELIV-5`).
- *Second review fix pass.* The variable `.env.example` marks required could not reach a self-hosted Docker image: `.dockerignore` excludes `.env`, and `NEXT_PUBLIC_*` values are inlined at build time, but the `Dockerfile` and `docker-compose.yml` passed only the Supabase variables and `NEXT_PUBLIC_APP_URL` (which no code reads). Both now pass `NEXT_PUBLIC_SITE_URL` as a build argument, compose also passes it at runtime, and `docs/SELF_HOST_DOCKER.md` lists it as required. `.env.example` says so and states the transmittal behaviour below. These files are outside the plan.
- `lib/publicOrigin.ts` also gains `recipientOrigin()` and `isUnreachableRecipientHost()` for the transmittal portal link (`TRX-14`). `publicOrigin()` itself is unchanged and still refuses no host.
- Not verified here: whether Vercel still gives the server `VERCEL_PROJECT_PRODUCTION_URL` when the project's system-variable exposure is off. If it does not, such a server falls back to `""`, as a self-hosted server with nothing configured does.
- See DEC-64 (public-surfaces PS-STAMP).

---

<a id="phys-12"></a>

## PHYS-12 · The stamper computes QR and footer placement from pdf.js's rotation-aware viewport but draws using pdf-lib's unrotated MediaBox — on a /Rotate 90 sheet the verify QR lands in the wrong corner (often on the title block) and the watermark is fitted to swapped dimensions

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `lib/stamping.ts:116-140`, `lib/stamping.ts:260-262`, `lib/stamping.ts:154-160`, `lib/stampLayout.ts:169-199`, `lib/stampLayout.ts:5-11`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: nothing in the codebase reads or compensates for page rotation, so on a /Rotate 90 sheet the corner chosen from the rotated raster is applied to transposed MediaBox coordinates and the watermark is fitted to swapped page dimensions. Note it is broader than stated — even with no ink analysis (the server path, which passes no sourceBytes and so uses FALLBACK_INK 'br'), the stamp is still drawn in unrotated space and appears sideways on the printed sheet.

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

**Resolution (2026-10-01, public-surfaces Round F).** Reproduced against `c23611b` with a fixture. A 612×792 page set to `/Rotate 90`, analysed by the real `analyzePageInk` (a fake pdf.js whose viewport has the displayed sides, as the real one does, and a fake canvas dark everywhere but one displayed corner), drew its QR in the wrong displayed corner, rotated 270° on the printed sheet. The same happened at `/Rotate 180` and `270`. Now:
- `lib/stampLayout.ts` adds `normalizeRotation`, `displaySize` and `displayToUser`, the pure mapping from the page as DISPLAYED (after `/Rotate`, the space pdf.js measures) into the unrotated user space pdf-lib draws in.
- `lib/stamping.ts` `applyStampToPdfDoc` reads `page.getRotation()` and builds one `DisplayFrame` per page: display width/height plus `at(x, y, angle)`, which maps an anchor and advances its angle by the rotation. The watermark fit and centring, footer wrapping and band, QR plate, image and caption are all laid out in display space and drawn through `frame.at()`, so the QR lands in the corner the analysis chose, on-page and upright. The footer reads left to right on the printed sheet, and the watermark is −30° on, centred on and fitted to the displayed page.
- `lib/markupExport.ts` `bakeMarkupIntoDoc` sizes the markup raster to the displayed page and lays it back at `displayToUser(0, 0)` with `rotate: degrees(rotation)` (the `DC PKG-13` limb). `bakeMarkupIntoPdf` wraps it, and the viewer's markup export uses it instead of its private unrotated copy.
- For a measured page (the browser paths) with a verify URL, a timestamp and a watermark that claims no controlled copy, unrotated output is byte-identical to the base stamper (compared on letter, B and D sheets; re-checked on the branch as shipped in the second review fix pass, with the saved PDF bytes compared for the QR measured into the bottom-right and the top-left). Other unrotated output changed on purpose elsewhere in this package:
  - the blind (server) placement, under `SHR-8`: QR top-left, footer along the top;
  - the footer's main line with no timestamp, under `PHYS-9`;
  - the scan instruction on a page with no QR, under `PHYS-11`;
  - a watermark that claims "CONTROLLED COPY", under `PHYS-9`.
  *Corrected in the second review fix pass:* the first write-up said unrotated output was byte-identical, with no qualification. That held for the rotation commit on its own, not for the branch as shipped.
- Files: `lib/stampLayout.ts`, `lib/stamping.ts`, `lib/markupExport.ts`, `components/viewers/FullScreenViewer.tsx`.
- Tests: `lib/__tests__/stampingRotation.test.ts` checks every mark through an independent rotation-matrix mapping:
  - `/Rotate` 0, 90, 180 and 270, each with the empty corner at tl and at br: the QR is in that displayed quadrant, upright and on-page, inside its plate; the caption is in the plate; the footer is upright, on-page, on the free band and clear of the plate; the watermark is at 330°, centred and fitted.
  - A mixed-rotation set.
  - The server (no-DOM) fallback in display space.
  - The markup bake at every rotation covers the displayed page exactly, upright.
  - `lib/__tests__/stampLayout.test.ts` covers the rotation helpers.
  The non-zero rotations all fail on the base.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4636 tests: 4629 passed, 7 expected-fail). Re-run after the second review fix pass: `tsc` 0, `eslint` 0, full `vitest` green (258 files / 4653 tests: 4646 passed, 7 expected-fail).

**Done-when.**
1. ✓ `applyStampToPdfDoc` reads `page.getRotation()` and maps the analysis result and the placement coordinates into the same (display) space.
2. ✓ A stamped page with `/Rotate 90` places the QR in the corner the analysis chose, on-page (and at 180 and 270).
3. ✓ A fixture test covers a rotated-page PDF end to end (pdf-lib document → real ink analysis → stamp → drawn geometry).

**Scope / residual.** This is the same defect as document-control `PKG-13`, recorded there by pointer, including its markup-bake and encryption limbs. The MediaBox origin and a CropBox smaller than the MediaBox are still not compensated: the stamp draws from (0, 0) of the MediaBox as it did before. That is a separate, pre-existing gap, not this finding.

---

<a id="phys-13"></a>

## PHYS-13 · Two QR generators bypass publicOrigin() and encode window.location.origin — including the share-link QR handed to external parties

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J10b (IntakePanel / QuotesPanel), identity-and-session IS-P1 (the library page) and notifications N6 (lib/notifications.ts ticketUrl) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `components/viewers/FullScreenViewer.tsx:1268`, `components/viewers/FullScreenViewer.tsx:63`, `components/viewers/FullScreenViewer.tsx:1015-1016`, `components/documents/ShareLinkModal.tsx:81`, `components/documents/ShareLinkModal.tsx:209`, `lib/publicOrigin.ts:8-12`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both call sites confirmed, and the file-local inconsistency in FullScreenViewer (publicOrigin at :1016, window.location.origin at :1268) makes it plainly an oversight rather than a deliberate exception. The share-link QR is the one that reaches an external party, so the preview-deploy dead-end is real; the /documents QR at :1268 targets a protected route the scanner must log into anyway, which limits the blast radius of that half.

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

**Partial (2026-09-29, document-control Round F wave 2).** The share-link half (the one the verifier kept) landed; the `FullScreenViewer.tsx` phone QR did not, so the finding stays OPEN for done-when 1 and 3. `components/documents/ShareLinkModal.tsx:154-159` builds the base of every copied link and of the QR from `publicOrigin()` (``const origin = publicOrigin(); const baseUrl = origin ? `${origin}/share/` : "/share/";``) — the same string feeds the read-only input, the Copy button, the Open link and `<QrBadge value={url}>`, so the clipboard and the QR can never disagree and neither carries a preview-deploy host when `NEXT_PUBLIC_SITE_URL` is set. `window.location.origin` no longer appears in the modal, the landing page or `lib/documentShares.ts` (pinned by test). The `FullScreenViewer.tsx:1268` phone QR is left as the verifier narrowed it (an in-app, login-required route for the same viewer in the same session — an inconsistency, not a field failure); that file is PS-STAMP's this wave (`QrBadge (~1291) from publicOrigin()` is in its file list, although `PHYS-13` is not in its finding list).
- Files: `components/documents/ShareLinkModal.tsx`
- Tests: `lib/__tests__/shareRoutes.test.ts` — "the modal offers no never-expires option, caps at 90, builds the link and QR on publicOrigin …" (`not.toMatch(/window\.location\.origin/)`, the `publicOrigin` import and the `baseUrl` line), "no file outside lib/publicOrigin.ts under the share surface reads window.location.origin (PHYS-13)".
- Reproduced: base `ShareLinkModal.tsx:86` ``const baseUrl = typeof window !== "undefined" ? `${window.location.origin}/share/` : "/share/";`` feeding `:235` `<QrBadge value={url} …>`.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (194 files / 2595 tests, re-run after the second review fix pass).

**Done-when.**
1. ◐ Not fully done — the ShareLinkModal `QrBadge` builds from `publicOrigin()` ✓; the FullScreenViewer phone QR still reads `window.location.origin` (PS-STAMP's file; the verifier's narrowing makes it an inconsistency, not a field failure).
2. ✓ The copied link and the QR share one `publicOrigin`-derived base.
3. ◐ Not fully done — under the share surface no file reads `window.location.origin` (pinned); `FullScreenViewer.tsx:1268` remains.

**Scope / residual.** Done-when 1 and 3 keep this finding OPEN. Owner: public-surfaces PS-STAMP, whose file list already carries the `FullScreenViewer.tsx` `QrBadge (~1291) from publicOrigin()` change; when that lands, the integrator (or PS-STAMP) closes `PHYS-13` against it.

**Partial (2026-10-01, public-surfaces Round F).** The `FullScreenViewer.tsx` phone QR is now built on `publicOrigin()`. The tree-wide done-when 3 still names files outside this package, so the finding stays OPEN.
- `components/viewers/FullScreenViewer.tsx`: the "Continue on phone" `<QrBadge>` value is `${publicOrigin()}/documents/<library>?doc=<id>`. It is rendered only after the click, so on the client. As a guard, an empty origin shows "No public site URL is configured (NEXT_PUBLIC_SITE_URL), so there is no link a phone could open." instead of encoding a relative URL. A browser always gets an origin, so the guard does not fire today. `window.location.origin` no longer appears in the viewer.
- Neither QrBadge call site can encode a preview host when `NEXT_PUBLIC_SITE_URL` is set or Vercel exposes its production domain to the browser. In a Vercel deployment with that exposure off and nothing configured, both still encode the page's own host; that is `PHYS-11`'s residual. *Corrected in the review fix pass:* the first write-up said `publicOrigin()` never returns a `*.vercel.app` host. That refusal was withdrawn (see `PHYS-11`).
- Tests: `lib/__tests__/psStampRoundF.test.ts` — "PHYS-13 — FullScreenViewer's phone QR is built on publicOrigin()".

**Done-when (this pass).**
1. ✓ Both QrBadge call sites build their value from `publicOrigin()`: ShareLinkModal (P1) and FullScreenViewer (here).
2. ✓ Unchanged from P1.
3. ◐ Not fully done. `components/projects/IntakePanel.tsx:424`, `components/projects/cost/QuotesPanel.tsx:1255,1285` (the `/submit` links), `app/(protected)/documents/[libraryId]/page.tsx:755,3091` (the `/d/` copies) and `lib/notifications.ts:209` (`ticketUrl`) still read `window.location.origin` for links that leave the app. Those files belong to other packages: `XEDGE-5` dw1's owners and notifications `DELIV-5`.

**Scope / residual.** Both QR generators this finding is about are fixed, and its verifier's narrowing is met. It stays OPEN only for done-when 3's tree-wide clause, owned by the packages named above.

**Partial (2026-10-01, projects Round G).** Package J10b UI REMAINDERS removed `window.location.origin` from the projects' outbound links. The Intake tab's and the Costs tab's `/submit` link builders now use `publicOrigin()`: `components/projects/IntakePanel.tsx` and `components/projects/cost/QuotesPanel.tsx` (see document-control `XEDGE-5`). Tests: `lib/__tests__/j10bIntakeLinksOrigin.test.ts` "XEDGE-5 / PHYS-13 —", with rendered copies and a census that no file under `components/projects` reads `window.location.origin`.

**Done-when (this pass).**
1. ✓ Unchanged.
2. ✓ Unchanged.
3. ◐ The projects sites ✓. Left, by grep at this commit:
   - `app/(protected)/documents/[libraryId]/page.tsx:755, 3159`: the `/d/` copies (IS-P1).
   - `lib/notifications.ts:274`: `ticketUrl` (notifications N6, `DELIV-5`).

   Two other readers build no outbound share link and are not assessed here: `app/page.tsx:103`, the sign-in `redirectTo`, and `components/viewers/SecureDocViewer.tsx:27`, a same-origin comparison.

**Scope / residual.** OPEN for those two files' owners.

---

<a id="phys-14"></a>

## PHYS-14 · The sign-in page ignores `?next=` — an equipment-label scan sent to sign-in "carrying the tag" lands on /dashboard after signing in, the tag lost

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** identity-and-session IS-P3 (the sign-in page) — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `app/page.tsx` (`routeAuthedUser` → `router.replace("/dashboard")`; the password sign-in's `router.push('/dashboard')`), `app/(protected)/assets/[tag]/page.tsx` (sends a no-session scan to `/?next=/assets/<tag>`), `lib/assetSignIn.ts` (`assetSignInHref`)
- **Independently verified:** — opened 2026-10-01 by public-surfaces Round F (PS-VERIFY) from the review of `PHYS-7` / document-control `HLD-13` (option (b), `DEC-65` §4), per DEC-31; verified against the branch, not yet challenged by a second party.

**Mechanism.** Under option (b) the equipment label stays a staff entry point and a no-session scan is sent to `/?next=/assets/<tag>`. The sign-in page never reads `next`: an already-signed-in session found on load goes through `routeAuthedUser`, which ends `router.replace("/dashboard")`, and an email / password sign-in ends `router.push('/dashboard')`. The tag carried in the URL does nothing.

**Failure scenario.** A contractor with an account scans the sticker on pump P-101, is sent to sign-in, signs in — and lands on the dashboard, not on the pump's drawings and holds. To get back he must find the asset by hand, at the pump, on a phone.

**Evidence.**

```
app/page.tsx — routeAuthedUser: … router.replace("/dashboard");
app/page.tsx — handleLogin: … } else { router.push('/dashboard'); }
app/(protected)/assets/[tag]/page.tsx — if (answer === "none") router.replace(signInHref);   // signInHref = /?next=%2Fassets%2F<tag>
```

**Done when.**

- [ ] The sign-in page honours `?next=` on every success path (a session found on load, password, Microsoft) — but only a SAME-ORIGIN relative path (starts with a single `/`, not `//`, no scheme), else `/dashboard` (no open redirect)
- [ ] `next` survives the Microsoft OAuth round trip (carried through the redirect and read back on return)
- [ ] A test pins `/assets/<tag>` honoured and `//evil.example`, `https://…` and `/\evil` refused

**Owner.** Unassigned — `app/page.tsx` is in no current package's file list; the integrator assigns it. Until it lands, `PHYS-7` / `HLD-13`'s redirect still ends the empty shell, but does not return to the tag.

---
