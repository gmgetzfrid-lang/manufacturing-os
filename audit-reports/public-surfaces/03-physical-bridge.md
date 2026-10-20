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
- **Status:** RESOLVED
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

**Resolution (2026-10-13, drafting-flow Round G).** DF-P10 DELIVERABLE-PRINT (public-surfaces `PKG-5`, folded in — `PKG-5` is closed by DF-P10 except `PHYS-8` done-when 3 (the `staleCopies` ticket arm), carved out as `PHYS-17`, owned by drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS, its migration number allocated at that package's launch). Reproduced on `596d34e`: `FileViewerModal` received `deliverableRev={ticket?.deliverableRev}` (`app/(protected)/requests/[id]/page.tsx:1690`) and both the print (`:582-583`, footer `:591-593`) and the download (`:650-651`, footer `:663-665`) built `?r=<ticket's live label>`; `TicketAttachment` had no revision field (`types/schema.ts:1101-1110`).
- `types/schema.ts` — `TicketAttachment.rev?: string | null` (additive): the revision of THAT file; `null` = joined with no label yet; absent = recorded before per-file revisions.
- `lib/ticketTransitions.ts` (the server computes it; the route runs this function, and a client's own `rev` on a file it asks the route to append is never kept): `submit_draft` stamps the review label onto the Drafts it submits (`:321-328`); `submit_final` stamps the issued label in force onto the package (`:400`, `joiningFileRev`, `:150`); `attach_file` stamps a Final added at `PENDING_IFC` / `FINAL_DRAFT` with that label and any other file `null` (`:255`); a redline is `null` (`:232`); `approve_draft_ifc` / `approve_minor_correction` / `engineer_approve_final` stamp the new label onto the Finals waiting for it — `rev: null` only (`stampIssuedFinals`, `:160`; `:335`, `:345`, `:368`). A file recorded before this change (no key) is never stamped after the fact: nothing on the row says which cycle it belonged to. *Departure from the brief's wording, stated:* the brief said the issue cases stamp "the Final attachment(s) at issue"; in the workflow the issued package is uploaded AFTER the issue (`submit_final` is offered only at `PENDING_IFC`, `lib/workflow.ts:500-513`), so the package is stamped when it joins, and the issue cases stamp only Finals that joined earlier in the cycle.
- `lib/ticketDeliverableCopy.ts` (new) `ticketCopyPlan` — the QR is `lib/verifyTicketVerdict.ts` `ticketVerifyUrl(origin, ticketRowId, file.rev)`; a file with no revision gets no `?r=` and the footer "… no deliverable revision is recorded for this file, so which printing this is cannot be confirmed. Not a controlled document revision."
- **A file the page knows is superseded** (review fix pass 2). The first pass printed "KE-1 deliverable Rev 1 at time of printing" on a Rev 1 Final opened after Rev 2 issued — a false statement (Rev 2 was the deliverable then), and with no public origin the paper carried no QR to correct it. The footer now describes THE FILE ("This file is KE-1 deliverable Rev 1 — not a controlled document revision — scan the QR …"; a Draft says "review draft"). The page passes the ticket's live facts (`liveTicket` = status, `deliverable_rev`, history) into `ticketCopyPlan` as a WARNING input only — the QR keeps `file.rev`. `ticketCopyStanding(rev, live)`: an issued file older than the highest issued number (the row's issued label or the history's `issued Rev N` lines) is **superseded** — the footer leads "SUPERSEDED by Rev 2 at time of printing — this file is KE-1 deliverable Rev 1, not the current revision — …", and those words survive the stamper's no-QR strip; the last issue on a ticket being re-worked (the verify ladder's `revision_in_progress`) adds "a newer revision is in progress at time of printing". Either way the page asks first (`appConfirm`, danger tone: "This file is Rev 1, but KE-1 has since issued Rev 2. The copy will be stamped SUPERSEDED. Print it anyway?") on both the print and the download path.
- **Review fix pass 3.** (i) The history lines `ticketCopyStanding` reads are bounded: any org member may append a history entry in their own name (`20261166`'s `ticket_update_guard`), so an `issued Rev N` line above `revision_count + 1` is ignored — no approval can have written it — and the page passes `revisionCount` in `liveTicket`. Before this, an appended "note — issued Rev 9" made the page stamp the real current Final "SUPERSEDED by Rev 9" behind a danger confirm. *Overstated:* within `revision_count + 1` an appended line still counted — fixed in pass 4 below. (ii) The last issue of a ticket reopened before Round E, which kept its issued label at `PENDING_REVIEW` / `PENDING_FINAL_APPROVAL`, now gets the in-progress footer and confirmation (the verify ladder reads it `revision_in_progress`, drafting-flow `EDGE-2`).
- The page (FileViewerModal region only): the `deliverableRev` prop and its pass are gone; both paths stamp from `planFor(channel)`. The ticket traveler (`lib/physicalBridge.ts`) still uses `ticket.deliverableRev`, as this record's chain reaction says it should.
- **Review fix pass 4.** (i) The live label bounds the history too: `ticketCopyStanding` reads it through `lib/verifyTicketVerdict.ts` `issueOnRecord` — at most N − 1 under a review label N<letters>, N under an issued label N — so on a ticket at `2A` (`revision_count` 1) an appended "issued Rev 2" no longer stamps the real Rev 1 "SUPERSEDED by Rev 2" (it gets the in-progress footer, as the scan reads), and under an issued label the history cannot supersede the Final in force at all. (ii) A Final that joined in a REJECTED round is no longer stamped by a later issue: `attach_file` accepts type `Final` at any status through the API (`app/api/tickets/workflow-action/route.ts`'s type list only), and `stampIssuedFinals` stamped every Final with `rev: null`, so a Final attached at `DRAFTING` before `1A` was sent back took "Rev 2" when `2A` was approved, and its QR scanned green. `lib/ticketTransitions.ts` `joiningFileFields` now records, on a Final joining with `rev: null`, the cycle it joined in (`revCycle`: `revision_count` then; any client value replaced), and `stampIssuedFinals(files, label, cycle)` stamps only Finals of the cycle the issue closes (`revision_count` before the issue; a request for revision, a reject, `reject_final` and a reopen all bump it). A Final from a rejected round keeps `rev: null` and prints "cannot confirm" (no `?r=`). `types/schema.ts` `TicketAttachment.revCycle`. Tests: `ticketTransitions.test.ts` "a Final from a REJECTED round is never stamped by a later issue …", the helper and `attach_file` cases; `verifyTicketVerdict.test.ts` "trust boundary: the row's own label bounds the history …".
- **Review fix pass 5.** (i) A row with NO label is bounded at its `revision_count` (`issueBoundFromLabel(rev, revisionCount)`, through `issueOnRecord`): only `reopen_ticket` nulls a label and it bumps the count after the issue, so every real issue line on such a row has N ≤ `revision_count`. On a ticket reopened after a real Rev 1 (`revision_count` 1) an appended "issued Rev 2" no longer stamps the real Rev 1 "SUPERSEDED by Rev 2" — it gets the in-progress footer, as the scan reads (drafting-flow `EDGE-2`). (ii) A deliverable of a WITHDRAWN request is confirmed and stamped as such: `ticketCopyStanding` returns `{ kind: "withdrawn" }` when the verify ladder answers `withdrawn` for the file's issued rev (a `CANCELED` request — `cancel_request`, DEC-14 — or one closed on a review label with no issue), checked before superseded as the scan does. The page asks "This file is Rev 1, but the KE-1 request was withdrawn. The copy will be stamped WITHDRAWN. Print it anyway?" (no page change: the page already confirms on any `plan.confirmMessage`), and the footer reads "REQUEST WITHDRAWN at time of printing — this file is KE-1 deliverable Rev 1 — do not work from it — not a controlled document revision — scan the QR for the current status." (the words survive the no-QR strip). Before this a withdrawn request's Final was stamped with no confirmation and the plain "scan the QR to confirm it is still the latest" footer. Tests: `verifyTicketVerdict.test.ts` "a deliverable of a WITHDRAWN request (EDGE-2) …" and "trust boundary: a row with NO label bounds the history at revision_count …".
- **Review fix pass 6** (the integrator's rulings, DEC-90 fail-safe). (i) A `CLOSED` row with NO issued label answers "cannot confirm" again, as base did (`lib/verifyTicketVerdict.ts` `ticketVerdict`'s terminal branch): fix pass 5 had let a history line turn such a row green, and history lines are member-appendable while `revision_count` can be bumped without an issue. `ticketCopyStanding` follows: when the ladder answers `unknown` it returns no standing, so a `CLOSED` no-label row never stamps a file SUPERSEDED from its history (`lib/ticketDeliverableCopy.ts`). (ii) A `CLOSED` review label whose history has an issue line the label's bound sets aside (a forgery, or a real Rev 1 of a ticket reopened before Round E that kept label `1` and was force-closed on `1B`) answers "cannot confirm", never red "withdrawn" and never green; withdrawn stays only for a request with no issue anywhere (row or history). The deliverable of such a ticket prints with no WITHDRAWN or SUPERSEDED stamp and no confirmation. Regression pinned first: Rev 1 and Rev 2, issued through `computeTransition`, scan `current` at `PENDING_IFC`, `FINAL_DRAFT` and `CLOSED` with the label, with no standing and no confirmation on print or download (`verifyTicketVerdict.test.ts` "fix pass 6 — …").
- Tests: `lib/__tests__/verifyTicketVerdict.test.ts` "PHYS-2 — the QR and footer carry the printed FILE's revision" (a Rev 1 Final on a ticket at Rev 2 builds `?r=1`, never `r=2`, and that print scans `superseded`; a rev-less file builds no `?r=` and the endpoint answers `unknown`), the fix-pass-2 cases — Rev 1 Final with the ticket at Rev 2 → `standing` superseded by 2, the footer starts "SUPERSEDED by Rev 2" and never says "Rev 1 at time of", the QR still `?r=1`, a confirmation message, the no-QR strip keeps SUPERSEDED; superseded read from the history (reopened, closed on a review label); the last issue in rework (`REVISION_REQ` with the label, a review label on the row, reopened) → "a newer revision is in progress", agreeing with `ticketVerdict`; the latest issue, a Draft, a rev-less file and no live facts → no standing and no confirmation; fix pass 3: a forged history line above `revision_count + 1` never marks a file superseded; a pre-Round-E reopened row's last issue → in progress), and the page source pins (the plan gets `live: liveTicket`, with `revisionCount`; both paths `confirmStanding(plan)` before stamping); `lib/__tests__/ticketTransitions.test.ts` "PHYS-2 — per-file revision, stamped server-side" (each stamping case, forged client revs dropped, legacy files untouched, and the walk issue Rev 1 → close → reopen → Rev 2 keeping Rev 1's package at Rev 1).

**Done-when.**
1. ✓ The rev in the QR and the footer comes from the attachment being viewed (`file.rev`), never from `tickets.deliverable_rev`.
2. ✓ An attachment with no recorded rev produces no `?r=`; `/api/verify-ticket` then answers `unknown`, for a live ticket and for a `CLOSED` one alike; only a `CANCELED` request answers `withdrawn` for a QR with no `?r=` (also non-green, `EDGE-2`; `ticketVerdict` checks the missing revision before the terminal ladder).
3. ✓ A test opens a historical Final on a ticket at a later rev and asserts the verifyUrl does not carry the ticket's current rev (and, fix pass 2, that its stamp says SUPERSEDED by that rev).

**Scope / residual.** The SUPERSEDED / WITHDRAWN / in-progress words are what the page knew when it stamped (its loaded ticket); the QR stays the live answer. Prints of Finals recorded before this change (no `rev`) answer "cannot confirm", by design (the stated default: no `?r=`). Two files issued under the same label (a pre-Round-E reopen, drafting-flow `SM-5` / `LEAK-7`) still cannot be told apart by label; the QR does not yet carry the attachment's identity — that is `SM-5` done-when 3 (owner: drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS), not this finding. A NEW re-issue of a label can no longer happen: `SM-5` done-when 2's history check re-cycles it (this round; the re-cycle in place of the brief's refusal is ratified by the integrator). Trust boundary: history lines are member-appendable, so they count only at or below `revision_count + 1` AND the bound the live label proves (pass 4) — `revision_count` itself on a row with no label (pass 5). Under an issued label, a forged line cannot stamp the Final in force SUPERSEDED (the label bounds the history at its own number). Under a REVIEW label it still can, wherever the label's bound sits above the real last issue: Rev 1 issued at `revision_count` 0; `reject_final` → 1; `2A` submitted and rejected → 2; `3A` submitted; a member appends "issued Rev 2" (within the `3A` bound of 2) — the real Rev 1 scans `superseded` and its copy is stamped "SUPERSEDED by Rev 2" behind the confirmation. No code-only bound can tell that line from a real one (pinned as today's behaviour by `verifyTicketVerdict.test.ts` "issue 3 (recorded, not closed by code) …"). On a LIVE ticket with NO label whose `revision_count` is above its real last issue (cycles bumped without an issue — a reject or return before any issue, or after a reopen), a forged line at or below `revision_count` can likewise stamp a real Final "SUPERSEDED by Rev k" for a k never issued (fail-safe wording, behind the confirmation; the QR still answers live). A `CLOSED` row with no label answers "cannot confirm" and derives no standing from its history (fix pass 6). *Overstated* in pass 4's form of this sentence ("at or below `revision_count + 1`" on any row with no label): a code-only bound closed the reopened-straight-after-a-real-issue case, which pass 4 had left to the migration. The guard refusing a client-appended `issued Rev` entry closes both — the `ticket_update_guard` limb, owned by drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS (migration number allocated at its launch); drafting-flow `SM-5` states the verdict's share of the same residual. A Final from a rejected round prints "cannot confirm" rather than the next issue's label (pass 4), by design.

*Cross-note (2026-10-14, drafting-flow Round G, DF-P12 DELIVERABLE FOLLOW-UPS): the Scope line's two DF-P12 items have landed; the Status stays RESOLVED.* The QR now names the printed FILE (`?a=<attachment id>` — `lib/verifyTicketVerdict.ts` `ticketVerifyUrl`, passed by `ticketCopyPlan`), checked by `/api/verify-ticket` against the ticket's attachments (one file, carrying the printed revision) and recorded as the scan's `printed_ref`: two prints of one label are told apart, and a print of a label issued twice that carries no such identity answers "cannot confirm" (drafting-flow `SM-5` done-when 3, `LEAK-7` (b)). The guard limb (`20261221`, pending paste) makes "issued Rev N" history lines the workflow's only; for a ticket whose last issue is proven, a forged line can no longer supersede it on the scan or on a copy stamped by the server copy route (`app/api/tickets/copy`, which reads the index); the page's own standing reads as before the paste until it passes the index or uses that route (drafting-flow `EVID-16` done-when 2).

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
- **Status:** RESOLVED (2026-10-20, the integrator's ruling R3 at the DF-P12 merge, `DEC-90` — PASTE pending: `20261223` after `20261068`; until it is pasted a ticket copy is recorded without the ticket / file columns and the ticket arm answers "unavailable")
- **Assigned:** drafting-flow DF-P10 (= PKG-5, the drafting limb) and document-control P8 FIELD (the lib/downloads.ts limb) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Assigned:** drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS (done-when 3's drafting limb, carved out as [`PHYS-17`](#phys-17)) — by the integrator, 2026-10-13 (DF-P10 review fix pass 6, DEC-31).
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

**Partial (2026-10-13, drafting-flow Round G).** DF-P10 DELIVERABLE-PRINT — the drafting-portal limb (public-surfaces `PKG-5`, closed by DF-P10 except `PHYS-8` done-when 3 (the `staleCopies` ticket arm), carved out as `PHYS-17`, owned by drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS, its migration number allocated at that package's launch). Reproduced on `596d34e`: both inserts (`app/(protected)/requests/[id]/page.tsx:607-614` print, `:689-697` download) named `ticket_id`, `attachment_id`, `attachment_type`, `filename`, `watermark_text` — columns no migration adds (`20261068` added only `source`, `share_id`, `transmittal_id`) — and were fired with `void … .then(() => {}, () => {})`.
- `lib/ticketDeliverableCopy.ts` (new) `recordTicketCopy(client, logAudit, input)`: one `download_audits` row in the columns the table has — `org_id`, `user_id` (the caller, so `20261068`'s `download_audits_insert_own` admits it), `user_email`, `expires_at`, `source` (`drafting` / `drafting_print` — the values `20261068`'s column comment names — and `drafting_unstamped` / `drafting_print_unstamped` when the stamp failed: two NEW values the column comment does not name; the column has no CHECK and nothing reads them yet, so they are added to the column comment at DF-P12 DELIVERABLE FOLLOW-UPS' migration — owner drafting-flow DF-P12). Before `20261068` the `source` column is absent (`PGRST204` / `42703` naming it): the row is retried once in the table's original shape and the deploy order is logged — the pull is still recorded, without its channel. WHICH file left is written beside it on an `audit_logs` `DOWNLOAD` row on the ticket (`resource_type 'ticket'`; details: attachment id, type, file name, the file's `rev`, the printed watermark or "UNSTAMPED (stamping failed)", the channel, the expiry) through `logAuditAction`. Both writes are awaited and their `{ error }` read; the result is `{ recorded, error }`.
- The page awaits it on both paths, each time AFTER the copy has left (fix pass 2: the print iframe is created and appended first, then the record is awaited, as the download path records in `finally` after delivery — a slow or hung insert never delays the print); a refusal never blocks the copy and is said: "This print/download is not fully recorded: … Tell Document Control which file you took …".
- Tests: `verifyTicketVerdict.test.ts` "EVID-5 / PHYS-8 — the copy's record is awaited, checked and in the table's real columns" (the row's keys are exactly the five; the audit row names the file; the pre-`20261068` retry; a refused distribution row, a refused audit row and a thrown insert each report `recorded: false`); page pins (no `void` insert, no swallowed promise, none of the five non-existent columns).

**Done-when (this pass).**
1. ✓ The drafting inserts are rewritten to the existing schema (no migration).
2. ✓ for every insert this record names: the share route (P2/P1), `lib/downloads.ts` (document-control P8, `logDownloadAudit` returns `{ recorded }`) and now both drafting inserts check `{ error }` and surface a refusal.
3. ✗ Drafting rows carry no `document_id` / `version_id`: a ticket file is not a register version (it is "not a controlled document revision" — `HAND-3`), so there is no true value to write, and `lib/staleCopies.ts` cannot list a ticket copy. Its staleness is answered by the ticket QR (`/verify-ticket`, now per-file — `PHYS-2`).
4. ✓ (P2) The share-link test.

**Scope / residual.** Stays OPEN for done-when 3. **The remedy (no migration added — DF-P10's brief reserved none; owner drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS):** a follow-up to `20261068` adding `download_audits.ticket_id UUID` and `attachment_id TEXT` (plain columns, not foreign keys — the record outlives the ticket's archive shed, as `share_id` outlives its share), the `insert_own` policy unchanged, `recordTicketCopy` then writing them (with today's audit row kept), and `lib/staleCopies.ts` gaining a ticket arm keyed on `(ticket_id, attachment_id)` against the ticket's newer issued `rev`. Opened as [`PHYS-17`](#phys-17) (review fix pass 4, DEC-31), owner **drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS**, its migration number allocated at that package's launch (a DEC-30 one-paste, not widening; the app keeps working before it — `42703` / `PGRST204` on the two columns → today's row).

**Partial (2026-10-14, drafting-flow Round G).** DF-P12 DELIVERABLE FOLLOW-UPS — done-when 3's drafting limb, carved out as [`PHYS-17`](#phys-17), has landed: a ticket copy's row names the ticket and the file (`20261223`, pending paste) and `lib/staleCopies.ts` lists and recalls its holders (`getTicketCopyRecall`, `nudgeStaleTicketHolders`) — see `PHYS-17`'s Resolution.

**Done-when.**
1. ✓ (DF-P10; plus the ticket columns, `20261223`).
2. ✓ (DF-P10, unchanged; the new server copy route checks both writes and issues nothing on a refusal).
3. ✗ as written: drafting rows carry no `document_id` / `version_id` — a ticket file is no register version, so there is no true value to write (DF-P10's finding). The criterion's purpose ("so staleCopies can see them") holds through the remedy this record's own Scope line names (`ticket_id` / `attachment_id` and a ticket arm — `PHYS-17`). Closing it on that remedy departs from the wording, which needs the integrator's ruling under DEC-90 (the record's text allows it: "The remedy (no migration added — …; owner drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS)").
4. ✓ (P2).

**Scope / residual.** ~~For the integrator: rule done-when 3 superseded by `PHYS-17`'s remedy (then RESOLVED, pending `20261223`), or keep it OPEN.~~ Ruled (below). Nothing else is owed in code; the recall's callers are `PHYS-18` (owner: drafting-flow DF-P15 DELIVERABLE PAGE WIRING (allocated by the integrator at the DF-P12 merge)).

**Ruled by the integrator at the DF-P12 merge, 2026-10-20 (DEC-90).** (R3) Done-when 3 is RATIFIED as met by `PHYS-17`'s remedy. Its purpose — a drafting copy's row names what was copied, so the stale-copies ledger can see it — is met by `download_audits.ticket_id` / `attachment_id` and the `lib/staleCopies.ts` ticket arm (`PHYS-17`, `20261223`); a ticket file is not a register version, so `document_id` / `version_id` have no true value to carry. `PHYS-8` is RESOLVED with the area's PASTE-pending form: `20261223` after `20261068`.

**Done-when (as ruled).**
1. ✓ (DF-P10; plus the ticket columns, `20261223`).
2. ✓ (DF-P10; the server copy route checks both writes and issues nothing on a refusal).
3. ✓ by ruling R3 — the row names the ticket and the file (`PHYS-17`, pending `20261223`).
4. ✓ (P2).

---

<a id="phys-9"></a>

## PHYS-9 · The drafting download watermark asserts "CONTROLLED COPY" while the footer stamped on the same page by the same call says "UNCONTROLLED COPY" — and nothing registers, numbers, or recalls the copy it claims is controlled

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-13, drafting-flow Round G).** DF-P10 DELIVERABLE-PRINT — the drafting caller the Round F Partial handed on. Public-surfaces `PKG-5` is closed by DF-P10 except `PHYS-8` done-when 3 (the `staleCopies` ticket arm), carved out as `PHYS-17`, owned by drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS, its migration number allocated at that package's launch. Reproduced on `596d34e`: the download passed `watermarkText: … : "CONTROLLED COPY"` (`app/(protected)/requests/[id]/page.tsx:661`; the stamper's backstop printed it as "UNCONTROLLED COPY") and the print `"UNCONTROLLED COPY"` (`:589`) — two literals for one file.
- `lib/ticketDeliverableCopy.ts` (new) `ticketCopyControlState(file)` — a Draft is `"review"`, every other file `"uncontrolled"` (never "controlled", DEC-64 §5) — and `ticketCopyPlan(...).watermark = stampWatermark(undefined, controlState)`.
- The page: both paths pass `controlState: plan.controlState` and NO `watermarkText` (`page.tsx:611`, `:670`), so the stamper derives the watermark and the footer's main line from the one state; the record names `plan.watermark` — the stamper's rule, never a literal (the sequencing note's instruction). The import line drops `stampWatermark`.
- A Draft's watermark now reads "REVIEW ONLY — DO NOT DISTRIBUTE" (the state's text, an em dash) where the literal had "REVIEW ONLY - DO NOT DISTRIBUTE"; its footer leads "UNCONTROLLED COPY — REVIEW ONLY".
- Tests: `verifyTicketVerdict.test.ts` "PHYS-9 / HAND-3 — one control state per file …" (print and download agree for every type; the watermark is the state's; never "CONTROLLED COPY") and the page pins (no `watermarkText:`, no watermark literal); `psStampRoundF.test.ts`'s audit-row test re-pinned to the new shape.

**Done-when.**
1. ✓ The drafting download and print agree on one control state for the same file (one function, `ticketCopyControlState`).
2. ✓ The footer's main line derives from the same control state as the watermark (PS-STAMP's `stampMainLine`, now fed by the caller's state; no contradicting `watermarkText`).
3. ✓ No print path emits "CONTROLLED COPY": the stamper's backstop (Round F) plus no caller literal in the drafting paths (pinned).

**Scope / residual.** None for this finding. A registered, numbered, recallable controlled copy would be a new `controlState` member (DEC-64's reversal) — not built, as decided.

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
- **Status:** RESOLVED
- **Assigned:** projects-joint J10b (IntakePanel / QuotesPanel), identity-and-session IS-P1 (the library page) and notifications N6 (lib/notifications.ts ticketUrl) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Assigned:** intelligence I-15 GRAPH SERVER ASSEMBLY (the graph page's Copy link, added by I-14 after the last pass) — by the integrator, 2026-10-07 (IS-P1 merge, DEC-31; fleet plan `intelligence.json`). The library page's limb is done (IS-P1); `lib/notifications.ts` stays with notifications N6.
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

**Partial (2026-10-07, identity-and-session Round G).** Package **IS-P1** removed the library page's two readers (document-control `XEDGE-5`, now RESOLVED): `app/(protected)/documents/[libraryId]/page.tsx` builds both `/d/` copies on `publicOrigin()` (`:760`, `:3263`), and `window.location.origin` no longer appears in the page. Test: `lib/__tests__/isP1LibraryPage.test.ts` "XEDGE-5 / PHYS-13 —" (the Ctrl+C copy lifted and run with a configured site and a different page host).

**Partial (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON closed the `lib/notifications.ts` `ticketUrl` site (notifications `DELIV-5` done-when 2): it is now `${publicOrigin()}/requests/<id>` (`lib/notifications.ts:296`) and reads `window.location.origin` nowhere. Test: `lib/__tests__/emailRender.test.ts` "ticketUrl() is built on publicOrigin() (DELIV-5 dw2 / PHYS-13)".

**Done-when (this pass).**
1. ✓ Unchanged.
2. ✓ Unchanged.
3. ◐ The library page ✓ (IS-P1) and the `ticketUrl` site ✓ (notifications N6). Left, by `grep -rn "window.location.origin" app components lib hooks` at the integrator's merge of N6 (2026-10-07):
   - `app/(protected)/graph/page.tsx:675` — the graph's "Copy link" (`${window.location.origin}${pathname}?…`), added by intelligence I-14 (DEC-88 §3): a link to the protected `/graph` view handed to colleagues by copy. Owner: intelligence I-15 (the graph page's Copy link is in its plan entry).
   - Not outbound links, not assessed (as the last pass): `app/page.tsx:139` (the sign-in `redirectTo`), `components/viewers/SecureDocViewer.tsx:27` (a same-origin comparison).

**Scope / residual.** OPEN for done-when 3's tree-wide clause only: the graph page's Copy link (intelligence I-15). *Integrator at the N6 merge (2026-10-07): IS-P1 and N6 each closed their site in parallel; the two Partial blocks above are both kept, and this done-when is their union.*

**Resolution (2026-10-20, intelligence Round G).** I-15 GRAPH SERVER ASSEMBLY — the graph page's Copy link (assigned at the IS-P1 merge, 2026-10-07). Reproduced first (DEC-29): on `8224f80` `app/(protected)/graph/page.tsx:694` built the copied link as `${window.location.origin}${pathname}?…`. It is now `${publicOrigin()}${pathname}?…` (`lib/publicOrigin.ts`), as the library page's `/d/` copies are built, so a link pasted to a colleague from a preview deployment carries the configured public origin. Test: `lib/__tests__/graphPageRender.test.ts` "PHYS-13 graph limb — …" (with `NEXT_PUBLIC_SITE_URL` set, the copied link starts with it and never carries the page's host; the page reads `window.location.origin` nowhere).

**Done-when.**
1. ✓ Unchanged.
2. ✓ Unchanged.
3. ✓ By `grep -rn "window.location.origin" app components lib hooks` at this commit, outside `lib/publicOrigin.ts` (and a comment in `lib/physicalBridge.ts`) two readers remain, neither building a URL that leaves the app: `app/page.tsx:139`, the sign-in `redirectTo` — the browser must come back to the host it is signing in on, since a session belongs to its origin, so the page's own origin is the correct value there; and `components/viewers/SecureDocViewer.tsx:27`, a same-origin comparison. Both were set aside as not outbound by the earlier passes; this pass states why.

**Scope / residual.** None for this finding. `PHYS-11`'s residual (a Vercel deployment with system-env exposure off and nothing configured falls back to the page's host) is unchanged and stays on `PHYS-11`.

---

<a id="phys-14"></a>

## PHYS-14 · The sign-in page ignores `?next=` — an equipment-label scan sent to sign-in "carrying the tag" lands on /dashboard after signing in, the tag lost

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-02, identity-and-session Round G).** IS-P3. Reproduced against `f1ac550` first (DEC-29): `lib/__tests__/signInNextRendered.test.ts` renders the real sign-in page with Supabase and the router stubbed, and 8 of its cases failed on the base — a signed-in visitor opened at `assetSignInHref("FE-201")` (and at `assetSignInHref("P 101/A")`), the password sign-in, the Microsoft button's return (implicit `#access_token` and PKCE `?code=`), the silent `prompt=none` return, and the silent attempt that falls back to the form all landed on `/dashboard`, the tag lost. They pass now. The parameter is the one PS-VERIFY sends: name `next`, the path `/assets/<encodeURIComponent(tag)>` encoded once more in the query (`lib/assetSignIn.ts` `assetSignInHref`); no `proxy.ts` / `middleware.ts` redirects to sign-in, and no callback route exists — Microsoft returns to `/` itself.
- `lib/signInNext.ts` (new, pure — a Next page file cannot export it) holds the redirect decision:
  - `safeNextPath(raw)` returns the query's `next` unchanged ONLY when it is a same-origin relative path: it starts with a single `/` (not `//`, not `/\`); every layer of it — the value, then each byte-wise percent-decoding until it stops changing (at most five; a value still decoding is refused) — still starts with a single `/`, carries no backslash, no control character (a browser strips tab / CR / LF, so `/<TAB>/evil` would become `//evil`) and no scheme-shaped first segment (`/[a-z][a-z0-9+.-]*:` — `/javascript:`, `/https:` once decoded; a bare `javascript:`, `https:` or `data:` never starts with `/` at all). A colon further along — a tag `P:101` at `/assets/P%3A101`, a hash `#x:y` — is a path character and is kept. The URL parser must agree that each layer stays on the origin, and so must the normalised href the router keeps after parsing it. Next's app router keeps `pathname + search + hash` (`createHrefFromUrl`) with dot segments already removed and passes it to `history` / `location`, so `/..//evil.example`, `/.//evil.example`, `/assets/..//evil.example` and `/%2e%2e//evil.example`, each parsed to the pathname `//evil.example` (another host), are refused just as `//` is. The layer must also not be the sign-in page itself (`/`, `/?…`, `/#…`, `/.`, `/%2e`). Anything else is null.
  - `signInDestination(next)` is `safeNextPath(next) ?? SIGN_IN_DEFAULT_DESTINATION`, and that default is `/dashboard` — exactly today's destination.
  - The Microsoft carry: `stashSignInNext` writes a safe `next` (with its time) to the tab's sessionStorage just before the page leaves for the provider, or clears any earlier one when there is none; `takeStashedSignInNext` reads it once and always removes it, honours it only within `SIGN_IN_NEXT_STASH_TTL_MS` (10 minutes) and re-validates it; `resolveSignInNext(search)` is the page's one read on load — the URL's own `next` when it carries one (a hostile value never falls through to a stash), else the carried one, the stash consumed either way. Storage that throws or is missing never throws out; the default applies.
- `app/page.tsx` (the sign-in page): `nextRef` is read once per page load at the top of the load effect (`resolveSignInNext(params)`; a re-run of the effect keeps the first answer). Every success path goes through the decision: a session found on load and the `SIGNED_IN` route both end in `routeAuthedUser`'s `router.replace(signInDestination(nextRef.current))`; the password sign-in's `router.push(signInDestination(nextRef.current))`. `startMicrosoft` (the button and the silent attempt) calls `stashSignInNext(nextRef.current)` before `signInWithOAuth` and clears it when the flow cannot start. Every successful exit clears it too: `routeAuthedUser` (a session on load, `SIGNED_IN`) and the password success call `stashSignInNext(null)`. A carry left by a round trip abandoned with Back therefore cannot steer a later sign-in in the tab. *Overstated* — that held only while the same page stayed open: a NEW load of `/` with no `next` in that tab within the 10-minute TTL (a bookmark, a typed `/`, a sign-out's `location.replace("/")`) still read the carry as its own, because `resolveSignInNext` honoured it on any load. See the integrator fix below. `redirectTo` stays byte-identical (`${window.location.origin}/`), so the project's Redirect URLs allow-list, which this repository cannot see, sees the URL it always has. When a provider error is cleaned from the address, a safe `next` is kept (`/?next=…`), so a reload still returns to it. With no `next`, the address cleans to `/` as before.
- Tests:
  - `lib/__tests__/signInNext.test.ts` (90) pins the accepted paths (`/assets/FE-201`, `/assets/P%20101%2FA`, `/assets/50%25`, `/assets/A%231`, `/dashboard`, a query, a hash, a colon past the first segment `/assets/P%3A101` / `/assets/P:101` / `#x:y`, a URL in the query, dot segments and an inner `//` that stay on the origin) and the end-to-end round trip `assetSignInHref` → `URLSearchParams` → `safeNextPath` (the tag decodes back, `P:101` included). It pins the refusals, each falling back to `/dashboard`: absolute URLs (`https://`, `http://`, upper case, `https:/`, `https:`); protocol-relative (`//`, `///`, `////`), and protocol-relative reached by dot-segment normalisation (`/..//`, `/.//`, `/assets/..//`, `/a/b/../..//`, `/%2e%2e//`, `/%2E//…/x`, mixed case, double-encoded, `/..%2F%2F`, and the dot-segment form read off a real sign-in link); backslash tricks (`/\`, `\/`, `\\`, a backslash later); encoded and double- and triple-encoded slash / backslash / scheme / colon; a malformed escape hiding `%2F`; a value still decoding past the bound; tab / CR / LF / NUL / DEL, raw and encoded; `javascript:` in any case, behind a slash and encoded; `/https://` behind a slash; `data:`; `vbscript:`; and the sign-in page itself (`/`, `/?next=…`, `/#x`, `/.`, `/./`, `/..`, `/%2e`, `/%2E%2E`, `/%3F…`). An exhaustive walk of 30,940 paths, 6,333 accepted and 24,607 refused (depth 4 over dot, encoded-dot, slash, backslash, colon, query and hash tokens), asserts that whatever is accepted, the router's normalised href stays on the origin and off the sign-in page. It also covers the stash (once, TTL edges, future stamps refused, tampered values re-validated, throwing or missing storage) and `resolveSignInNext`'s precedence, plus source pins: no hard-coded `/dashboard` redirect is left in `app/page.tsx`, the three call sites use the decision, the carry is cleared on all three ways out, and `redirectTo` is unchanged.
  - `lib/__tests__/signInNextRendered.test.ts` (38, jsdom) renders the page. A signed-in visitor goes to the tag (`P:101` included), or to `/dashboard` with no `next` and for 15 hostile or self-pointing values, the dot-segment forms `/..//`, `/assets/..//` and `/%2e%2e//` among them. The password sign-in goes to the tag, or to `/dashboard` with no `next`, for hostile values (`/.//` among them), and nowhere on a failed sign-in. The Microsoft button and the silent attempt carry `next` across a fresh page load, with `redirectTo` unchanged. The carried `next` is honoured once and expires at 10 minutes, a flow that could not start carries nothing, a hostile `next` is never carried, and a silent attempt that needs interaction keeps `next` for the form and in the address. A carry the tab still holds is cleared by a successful sign-in (a `SIGNED_IN`, and a password success before its `SIGNED_IN`), so the next person to sign in on that tab lands on `/dashboard`.
- Review fix pass (same round): the first version checked only the parsed origin, so `/..//evil.example` (and the other dot-segment forms above) passed, and the router's canonical href became `//evil.example`. Its scheme test refused a colon anywhere, so a `P:101` tag fell back to `/dashboard`. Successful sign-ins did not clear a live carry. All three are fixed. The 16 new unit cases and 7 new rendered cases fail against the first version and pass now.
- Loop: `npx tsc --noEmit` 0; `npx eslint app/page.tsx lib/signInNext.ts lib/__tests__/signInNext.test.ts lib/__tests__/signInNextRendered.test.ts --max-warnings=0` 0; `npx vitest run` 0 (388 files; 7978 passed, 4 expected-fail). `next build` is the integrator's.

**Done-when.**
- ✓ The sign-in page honours `?next=` on every success path — a session found on load, password, Microsoft (the button and the silent attempt) — only as a same-origin relative path (a single leading `/`, not `//` or `/\`, and not a path the URL parser normalises to `//` such as `/..//evil.example`; no scheme-shaped first segment, no backslash or control character in any decoded layer; not the sign-in page itself), else `/dashboard`: `app/page.tsx` `routeAuthedUser` / `handleLogin` → `signInDestination`; rendered and unit tests above.
- ✓ `next` survives the Microsoft OAuth round trip: it is carried across the redirect in the tab's sessionStorage (written before `signInWithOAuth`, not in `redirectTo`, which stays unchanged for the allow-list) and read back on the return load (`resolveSignInNext`), once and within 10 minutes. Rendered: the implicit, PKCE and silent returns land on the tag.
- ✓ A test pins `/assets/<tag>` honoured and `//evil.example`, `https://…` and `/\evil` refused, with the dot-segment (`/..//evil.example`, `/.//evil.example`, `/assets/..//evil.example`, `/%2e%2e//evil.example`, `/%2E//evil.example/x`), encoded, backslash, control-character and `javascript:` variants (`lib/__tests__/signInNext.test.ts`, `signInNextRendered.test.ts`).

**Scope / residual.**
- REGRESSION held: a sign-in with no `next` lands on `/dashboard` by the same call as before (`replace` on load and `SIGNED_IN`, `push` after a password). An already-signed-in visitor is forwarded at once as before, to `/dashboard` unless a safe `next` is carried. *Overstated* — after a Microsoft round trip the provider never finished, the same tab's next load of the bare `/` within 10 minutes sent an already-signed-in visitor (`replace`), or the next person's password sign-in (`push`), to the carried tag instead of `/dashboard`. Holds since the integrator fix below. The Microsoft `redirectTo`, scopes and `prompt=none` are unchanged.
- Refused on purpose, falling back to `/dashboard`: a `next` whose first segment is scheme-shaped (`/javascript:…`, `/x:…`). No route of this app starts that way. An equipment tag containing a colon (`P:101`) sits past the first segment and returns to its tag (tested). A Microsoft round trip longer than 10 minutes also lands on `/dashboard`.
- The carry assumes the provider returns to the same tab (sessionStorage is per tab), as a browser OAuth redirect does. The silent-attempt guard (`SILENT_TRIED_KEY`) already relies on the same assumption.
- Not in this finding (DEC-31): RoleContext's sign-out redirect (`window.location.replace("/")`) and other protected pages carry no `next`; only the equipment label sends one. The button copy "Sign In to Dashboard" is unchanged. `PHYS-7` (this file) and document-control `HLD-13` still say in their residual lines that `PHYS-14` is open. Those records are left as they were dated; DEC-65 §4 carries the landed line.
- No migration.

**Integrator fix (2026-10-02, identity-and-session Round G, IS-P3).** The package's final adversarial review found one regression against the brief's REGRESSION rule. Reproduced first (DEC-29): rendered against `3aa9de7`, the two probes below landed on `/assets/P-101`.
- The defect: any load of `/` with no `next` in its address picked up a leftover Microsoft carry (sessionStorage, up to 10 minutes old), even when that load was not a return from the provider. `resolveSignInNext` read the stash into `nextRef` before `routeAuthedUser` or the password success could clear it. The probe: open `assetSignInHref("P-101")` with no session and click "Sign in with Microsoft" (the carry is written and the browser leaves); the provider never sends the tab back; the same tab loads the bare `/`. Already signed in, it went to `/assets/P-101` (`router.replace`); with no session, the next person's password sign-in went there too (`router.push`). Both should be `/dashboard`.
- The change, `lib/signInNext.ts`: `resolveSignInNext(search, store, { providerReturn, now? })` — `providerReturn` is required. The URL's own `next` still wins (safe, or null). Otherwise the carry is returned only when `providerReturn` is true. Either way it is consumed and removed, so a load that is not a return removes it without honouring it. `isProviderReturn(search, hash)` is the page's reading of a return: `?code=`, `#access_token`, or a non-empty `?error=`. That is the same `hasOAuthResponse || errorCode` the load effect branches on, so the silent `prompt=none` return and a provider error (whose cleanup keeps a safe `next` in the address) still carry `next`.
- The change, `app/page.tsx`: the load effect resolves `nextRef` with `providerReturn = atLoad || isProviderReturn(params, hash)`. `atLoad` is a reading of the address taken when the page module is evaluated, on the `/` path only, and only the first mount takes it (`takeProviderReturnAtLoad`). Why that is needed, read from auth-js 2.106.1: `lib/supabase.ts` constructs the client at module scope, and on `/` this page is its first importer. The client's auto-initialise (`detectSessionInUrl`) clears `#access_token` (`location.hash = ''`), or deletes a PKCE `?code=` (`replaceState`), in `_getSessionFromURL` only after its network request resolves; an `?error=` address is never stripped. The effect reads the address before any await, but it runs after hydration, so on a slow device it could find the response already stripped. Module evaluation runs in the same synchronous task as the client's construction, before any response can arrive. `getSession` does await the exchange, but the effect reads the address before calling it, so that wait does not order the two. This race is reasoned from the code and simulated in jsdom, not observed in a browser.
- Tests:
  - `lib/__tests__/signInNextRendered.test.ts` (44) adds 6 cases. The two probes ("a load that is not the provider's return discards the carry"): an already-signed-in visitor and a password sign-in at the bare `/` both land on `/dashboard`, the carry removed. Four cases re-evaluate the page module with `vi.resetModules()` ("the provider's return is read when the page module loads"): an implicit return with the hash cleared, and a PKCE return with `code` deleted, before the effect runs, each still land on the tag; a second mount in the same document at a bare `/` discards a new carry; and a module evaluated while the address is another route's (`/verify-ticket?code=…`) is not a return.
  - `lib/__tests__/signInNext.test.ts` (92) adds `resolveSignInNext("", store, { providerReturn: false })` → null with the stash removed, the same carry honoured with `providerReturn: true`, and `isProviderReturn`'s cases. The precedence case moves to the new signature, and the source pin now names the module-load reading and the effect's call.
  - Every earlier case still passes: the implicit, PKCE and silent returns, the provider error, hostile values, and the REGRESSION cases with no `next`.
- Negative controls, each reverted after: honouring the carry regardless of `providerReturn` fails the two probes and the unit case. The page passing `providerReturn: true` fails the two probes. Dropping the `?error=` branch fails the silent-error return and the `isProviderReturn` case. Without the module-load reading, both stripped returns fail. Not clearing it after the first mount, or taking it only when the effect sees no return, fails the second-mount case. Without the `/` path check, the other-route case fails.
- Unchanged: `redirectTo`, scopes, `prompt=none`, the silent-attempt guard, the default `/dashboard`, and `safeNextPath`. Status stays RESOLVED: every Done-when above still holds.
- Residual: an address of the return's shape opened in the same tab within the TTL — a hand-made `/?error=x`, or any query containing `code=` — is read as a return. It lands on the path that tab's own carry holds, which is still a validated same-origin path.

---


<a id="phys-15"></a>

## PHYS-15 · A document number or revision label with a character the stamp font cannot print fails every stamp path — the copy goes out unmarked, or not at all

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** public-surfaces PS-P7 STAMP TEXT ENCODING — by the integrator, 2026-10-07 (opened at the document-control P22 merge, DEC-31; fleet plan `public-surfaces.json`).
- **Verification:** CONFIRMED
- **Locations:** `lib/stamping.ts:356` (`StandardFonts.HelveticaBold`, WinAnsi), `drawFooter` / `drawWatermark` (the text encoded directly); callers that put a document number or revision label in the footer: `app/api/share/file/route.ts:134` (`shareFooterNotice`; its catch at `:139` releases the copy unstamped), `lib/downloads.ts:474`, `:516` (`buildFooterNotice`), `lib/docPack.ts:748`, `components/viewers/MultiDocViewer.tsx:771`, `components/assets/FileReferenceModal.tsx:170`; the transmittal portal (`portalStampText`, handled by P22 for that path only)
- **Independently verified:** — opened 2026-10-07 by the integrator from document-control P22's final review (DEC-31: P22 found the failure and recorded it only for the transmittal portal); read against the branch, not yet challenged by a second party.

**Mechanism.** The stamp embeds the standard Helvetica-Bold font, whose encoding is WinAnsi. `pdf-lib` refuses to encode a character outside it ("WinAnsi cannot encode …"). A document number or revision label pasted from Word often carries one — a Unicode hyphen (U+2010), a non-breaking hyphen, a Greek capital delta ("Δ1"), a curly quote. Every path that draws that text in a footer or watermark then throws. Each caller handles the throw its own way: the share download releases the copy unstamped (recorded only as unstamped), the controlled download and the pack fail on the same text, and P22's issue-time check now warns and never arms such an item — advising "change it to plain characters", which a published revision label (fixed) or a document number (a controlled renumber) often cannot follow.

**Failure scenario.** A drawing numbered "P‐101" (U+2010, pasted from Word) is shared by link. Every `/api/share/file` download leaves without its UNCONTROLLED marking; the in-app controlled download fails to stamp on the same text; the transmittal portal warns at issue and sends it unstamped. No path can ever stamp that document.

**Done when.**

- [ ] one helper maps stamp text to what the stamp font can print — every character the embedded WinAnsi Helvetica-Bold prints is drawn as typed (U+2013, U+2014, curly quotes and U+00A0 included); only a character the font cannot print is mapped (U+2010/2011/2012/2015/2043/2212 and the small/fullwidth hyphens → "-", primes/reversed quotes → straight quotes, U+0394/U+2206 → "Delta", compatibility forms → NFKC when printable, anything else → a visible "?"; a format character (General_Category Cf), which has no glyph, is removed and named on the copy), and nothing is dropped silently — and every caller above draws through it. *(Amended by the integrator under the user's delegation, 2026-10-08, `DEC-97`; the format-character clause is the same ruling's second part. As opened it read: "U+2010/U+2011/U+2012/U+2013/U+2014 → "-", curly quotes → straight, "Δ" → "Delta", other unprintable characters → a visible placeholder, never dropped silently — or the stamp embeds a Unicode-capable font".)*
- [ ] a number or label with such a character stamps on every path, and the stamped text is recorded with what was mapped
- [ ] regression: a number or label in plain characters stamps exactly as today (byte-identical text); P22's `stampFooterUnprintable` guard and issue-time warning are updated to the new rule (an item no longer unprintable is armed again)

**Resolution (2026-10-07, public-surfaces Round G).** Package PS-P7 STAMP TEXT ENCODING. Reproduced on `b154823` first (DEC-29), with the real stamp (`applyStampToPdfDoc`): `shareFooterNotice` for "P‐101" threw `WinAnsi cannot encode "‐" (0x2010)`; `buildFooterNotice` for rev "Δ1" threw on `"Δ" (0x0394)`; a pack footer "P‑101" on `"‑" (0x2011)`; a book watermark "P−101" on `"−" (0x2212)`; `portalStampText` with rev "P‐01" on U+2010; and a watermark whose user label was "Łukasz" on `"Ł" (0x0141)` — a display name, so every stamped download that person took failed the same way. An en dash and curly quotes stamped. `armCheckedItems` left an item with rev "Δ1" unarmed. The tests below fail on `b154823`: 24 of them across the five files (the code files reverted to `b154823`, the tests kept; that run's 25th failure was an unrelated 5 s timeout in `shareRoutes`' modal test). The two plain-text regression tests pass there, as they must.
- **One helper: `lib/stamping.ts` `stampText(text)`** (`:230`). It returns `{ text, mapped }`.
  - A character the font prints as typed is kept (`stampFontPrints`, `:165`: printable ASCII, Latin-1, and cp1252's 27 extras, among them the en and em dash, the curly quotes, the bullet, the ellipsis and €). A text made only of such characters comes back as the same string, so a stamp that printed before is drawn byte for byte as before.
  - Any other character, after composing a letter with its combining accent (NFC):
    - a format character (General_Category Cf — a zero-width space or joiner, a word joiner, a byte-order mark, a directional mark), which has no glyph, is removed from the drawn text and listed in `mapped` with `printedAs: ""` (`FORMAT_CHARACTER`, `:197`; the integrator fix pass below — at `f9cfe43` it was drawn as "?", or as a space for U+FEFF); the soft hyphen U+00AD, which WinAnsi prints, is drawn as typed like every printed character;
    - whitespace becomes a space, as the footer's word wrap already drew it (not noted);
    - U+2010, U+2011, U+2012, U+2015, U+2043, U+2212, U+FE58, U+FE63 and U+FF0D become "-"; U+2032, U+2035, U+201B and U+02BC become "'"; U+2033, U+2036 and U+201F become '"'; U+0394 and U+2206 become "Delta" (`PLAIN_FORM`, `:172`);
    - a compatibility form whose NFKC decomposition the font prints entirely (fullwidth digits, the "fi" ligature) becomes that decomposition;
    - anything else becomes the visible placeholder "?" (`STAMP_PLACEHOLDER`, `:186`).
  - Nothing is dropped silently. Every replacement and removal except whitespace is listed once in `mapped`, in the order met, as `{ char, codePoint: "U+2010", printedAs: "-" }` (a removal with `printedAs: ""`).
- **Every drawn text goes through it.** `applyStampToPdfDoc` (`:492`) maps the watermark, the footer's main line and the caller's notice (after the scan-instruction removal) once, before the page loop (`:534`–`:544`). `drawWatermark` and `drawFooter` draw only the mapped text (`:563`, `:567`–`:570`); "SCAN TO VERIFY" is ASCII. So every caller draws through the helper with no change of its own:
  - the share route (`shareFooterNotice`);
  - the in-app download and print (`lib/downloads.ts` `buildFooterNotice` / `copyWatermark`, through `downloadStampedPdf` / `stampPdf`);
  - the field pack (`lib/docPack.ts`), the book (`MultiDocViewer`) and the linked drawings (`FileReferenceModal`);
  - the transmittal portal and its issue-time check (`portalStampText`);
  - and two stamp callers the record does not list: the viewer's markup export (`FullScreenViewer`) and the drafting download (`requests/[id]/page.tsx`).

  The share route, `lib/downloads.ts`, `MultiDocViewer` and `FileReferenceModal` needed no edit and were not edited. `lib/docPack.ts` draws through the stamper as it is; the review fix below edits it only to keep the stamp's result for the print snapshot.
- **Recorded with what was mapped.**
  - On the copy: when the stamp replaced or removed a character, the footer ends with one more line in the notice's style, in characters the font prints (`stampTextNote`, `:267`): `Printed in plain characters: U+2010 as "-", U+0394 as "Delta".` — a removal reads `U+200B removed`. It names up to twelve, then "and N more". So the paper says its number is not exactly the one on record.
  - To the caller: `applyStampToPdfDoc` now resolves with `{ mapped }` (it resolved with nothing).
  - Where a stamp's text is already recorded:
    - the transmittal portal's `TRANSMITTAL_PORTAL_DOWNLOAD` trail row carries the `docNumber` and `rev` it stamped, and now `stampMapped` beside them when something was replaced (`app/api/transmittal/route.ts:633`);
    - a work package's print snapshot (`work_package_prints.sheets`) records each printed sheet's `label` and `revLabel`, the number and revision the pack's footer stamps, and now `stampMapped` on that sheet's entry when its stamp replaced something (review fix, below; the first pass missed this record).

    No new table, no migration. The other paths' records (`download_audits`, `document_share_accesses`) hold no stamp text; for those, the copy carries the note.
- **The portal stamps `portalStampText`** (`app/api/transmittal/route.ts:556`–`:563`). Its inline footer is replaced by P22's `portalStampText(...)`: the switch P22 left to notifications N8 or the integrator, assigned to this package by its brief. The options are unchanged, and P22's pin (the route's options equal `portalStampText`) still passes.
- **P22's guard and warning follow the new rule** (`lib/transmittals.ts`, `lib/transmittalStampCheck.ts`):
  - `armCheckedItems` (`lib/transmittals.ts:1086`) no longer refuses to arm an item whose own number or revision has a character the font cannot print as typed: the stamp prints it. Such an item is armed again on its check's `stampable` verdict, like any other. The arming still requires the check: no check, an `unchecked` verdict or a second non-stampable verdict leaves no mark.
  - The issue-time check stamps through the helper, so such a label is `stampable` and is no longer warned "change it to plain characters". Its `unprintable` branch stays for a stamp that still refuses a character (a defect; the code-point test below pins that there is none). It now names the character pdf-lib refused (`lib/transmittalStampCheck.ts:227`), since the label's other characters are drawn in their plain form and are not why it failed. `describeUnstampable`'s line for it is unchanged, so an answer from an older server still reads.
  - `stampFooterUnprintable` keeps its meaning, the characters the font cannot print as typed, which are now the characters the stamp replaces. It keeps its own copy of the WinAnsi set because `lib/transmittals.ts` is a browser module that must not pull in pdf-lib; a test pins the two sets equal.
- Tests:
  - `lib/__tests__/psP7StampText.test.ts` (new, 19; 21 after the integrator fix pass below):
    - **REGRESSION.** `psP7StampPlainHarness.ts` stamps ten cases, each caller's own text: the share link; the download, current and an older revision of a held document on a rotated sheet; the pack; the book; the linked drawings with no origin; the portal with and without a QR; a review copy with NBSP, €, … and • and a long wrapping notice; a watermark truncated with "…". It captures every draw call (text, position, size, rotation, colour, opacity) and the saved bytes' SHA-256. `psP7StampPlain.golden.json` was recorded by that harness on `b154823`, before any change. Today's stamp equals it call for call and byte for byte (the locale date fixed, so the record holds in any time zone). `stampText` returns the identical string for text the font prints.
    - The helper: each mapping above; the en and em dash and the curly quotes kept; whitespace; "Łukasz" → "?ukasz"; NFC; NFKC; an emoji → one "?".
    - Against pdf-lib: for every BMP code point and three astral ones, `stampText("A" + ch + "B")` encodes with Helvetica-Bold and drops nothing. `stampFontPrints` equals pdf-lib's WinAnsi coverage exactly, and `stampFooterUnprintable` names exactly the characters the stamp replaces.
    - The stamp: the failure scenario ("P‐101" at "Δ1", user label "Łukasz", two pages) draws "P-101 Rev Delta1" and "?ukasz", with the note as each page's last footer line and no unprintable character, and returns the three replacements in order. A notice that loses its scan instruction is mapped after the removal. A date with U+202F (some runtimes' locale string) stamps with no note. `stampPdf`, the browser paths' entry, stamps.
    - Every caller's text with a number "P‐101 “GA”" and a revision "Δ1–B" (U+2010, U+2013, Δ, curly quotes): share, download / print (current, and an older revision of a held document), pack, book, linked drawings and portal each stamp, keep the en dash and the curly quotes, print "P-101" and "Delta1", and carry the note. A source pin checks that each caller stamps through lib/stamping and embeds no font of its own.
  - `lib/__tests__/shareRoutes.test.ts` "PHYS-15 — …" runs the share ROUTE with the real pdf-lib and the real stamper. A document "P‐101" at "Δ1" leaves stamped and recorded `share_link` (on `b154823`: `share_link_unstamped`, unmarked). REGRESSION: a plain one stamps with nothing replaced. The file's pdf-lib mock now passes the real module through behind its fake `load`.
  - `lib/__tests__/transmittalPortalRoute.test.ts`: the P22 test that pinned a "Δ1" item unarmed and released unstamped is rewritten to the new rule. "P‐101" at "Δ1" is armed, and two downloads both deliver it stamped (real stamper), with no refusal and no issuer notice. The copy draws "P-101 Rev Delta1" and the note, and the trail row records `stampMapped`. REGRESSION: a plain item's trail row has exactly the keys it had.
  - `lib/__tests__/dcRoundFP15TransmittalStampCheck.test.ts`: the P22 test that pinned "Δ1", "P‐01" and "P‐103" `unloadable` is rewritten. All three are `stampable`, with no warning; the reviewer's reproduction now resolves with the replacement; a stamp that still refuses a character names the one pdf-lib refused. The code-point test gets a 60 s timeout (P22 recorded it timing out under load).
  - `lib/__tests__/dcRoundFP15TransmittalIssueWarn.test.ts`: the P22 test that pinned "Δ1" and "VDS‐7" never armed is rewritten. Both are armed, and "Rév B" is armed as before. The pure rule arms every label on a `stampable` check and none without one. P22's test of an older server's `unprintable` answer (warned; "Issue anyway" leaves the item unarmed) is unchanged and passes.
- Verified in the PS-P7 worktree (code at `e4be61e`):
  - `npx tsc --noEmit` 0. `npx eslint` on every touched code and test file, `--max-warnings=0`: 0.
  - Full `npx vitest run` exited 1: 453 files / 9970 tests, 9902 passed, 7 expected-fail, 61 failed in 28 files. The load average was 50–60 on 4 cores (other fleet packages running). Every failure is a timeout or a wall-clock assertion (for example "expected 10855 to be less than 5000", a worker deadline cutting a page count short). Only two of the 28 files import a module this package changed: `stampingRotation` (one test, a 5 s timeout) and `notificationWriteRails` (two source-scan tests, timeouts). Every suite this package touched passed in that run (`psP7StampText`, `shareRoutes`, `transmittalPortalRoute`, `dcRoundFP15TransmittalStampCheck`, `dcRoundFP15TransmittalIssueWarn`, `psStampRoundF`), as did three of the four censuses (`checkedWrite`, `notificationKinds`, `sessSixRoleNull`). The fourth, `notificationWriteRails`, is the one that timed out; run alone with `--testTimeout=120000`, the four censuses pass (173 tests, exit 0).
  - The 28 files re-run on their own, one file at a time with `--testTimeout=120000`: 28 passed (1287 tests, 1 expected-fail), exit 0.
  - `next build` was not run by the package; it is the integrator's gate before merge.
- **Review fix (2026-10-07): the first pass regressed a work package's print; the cover now draws through the helper, and the print snapshot records what was replaced.**
  - **The regression, stated plainly (DEC-29).** At `e4be61e` / `43cb45c` a `/packages` print holding one sheet whose number or revision label had such a character FAILED WHOLE, and left a print snapshot behind.
    - On `b154823` that sheet's stamp threw inside `lib/docPack.ts`'s per-sheet try. The sheet was left out and named ("Left out: P‐101 (WinAnsi cannot encode …)"), and the rest of the package printed under its cover.
    - Once the stamp printed it, the sheet rode on into `/packages`' `buildCoverAfter` (`app/(protected)/packages/page.tsx:204`–`:247`). That records the print snapshot first (`recordPackagePrint`, `:213`) and then draws the cover (`lib/physicalBridge.ts` `buildPackageCover`, `:235`) with the standard fonts. The cover's contents row threw `WinAnsi cannot encode "‐" (0x2010)`. Nothing downloaded and no pin moved, but a `work_package_prints` row listed paper that never existed. That is against DEC-70 §3: a print that fails records nothing.
    - The first pass recorded this as a LOW defect left for later (`PHYS-16`, "a `/packages` print with such a number still fails"). It was a regression this package introduced. The reviewer found it.
  - **The cover** (`lib/physicalBridge.ts` `buildPackageCover`, `:342`) maps every text it draws from data through `stampText` before it measures or draws it (`drawable`, `:358`–`:368`): the package name, the description, the by-line (owner, date printed, printer), each contents row's number and `Rev …`, and the continuation pages' header (`:409`). Text the fonts print comes back as the same string, so a plain cover is drawn exactly as before. When anything was replaced, the first page carries `stampTextNote`'s line under the by-line, 8 pt, amber, above the contents header (`coverNoteLines`, `:333`). The note runs to at most two lines; the longest note `stampTextNote` writes (twelve named, then "and N more") takes two. The cover's fixed captions and its legend are unchanged (`verifyDoor`'s pins hold).
  - **The print snapshot** (the reviewer's minor on done-when 2). `lib/docPack.ts` keeps `applyStampToPdfDoc`'s result (`:746`) and puts `stampMapped` on the sheet's `PackSheetRef` only when something was replaced (`:766`–`:767`). `/packages` passes it into that sheet's snapshot entry (`app/(protected)/packages/page.tsx:225`; the type is `PrintSnapshotSheet.stampMapped`, `lib/workPackages.ts:384`).
    - The entry keeps `label` and `revLabel` as on record ("P‐101", "Δ1"), and `stampMapped` says what the paper shows instead ("-", "Delta").
    - It is an additive JSON key in the existing `sheets` column. Nothing reads or guards the keys of `work_package_prints.sheets` beyond its own: `20261028` declares the column only, and `/api/verify-package` reads `documentId`, `versionId`, `revLabel`, `label`, `printed` and `leftOutCode` by name. A plain sheet's entry has exactly the keys it had. No migration. The asset hub's pack (no snapshot) is unaffected.
  - **Tests:** `lib/__tests__/psP7CoverText.test.ts` (new, 11).
    - **REGRESSION.** `psP7CoverPlainHarness.ts` builds four covers in characters the fonts print and captures every draw call, the page count and the saved bytes' SHA-256 (the document dates pinned). The four: one page with every field; 30 sheets with a continuation page and the legacy QR; 70 sheets on three pages with long text cut by `fit`; NBSP, €, •, …, ™, ‰, Å and Ø. `psP7CoverPlain.golden.json` was recorded with `lib/physicalBridge.ts` at its `b154823` content, and it replays green on an extract of `b154823` (`git archive`). Today's cover equals it call for call and byte for byte. A plain cover carries no note.
    - **The cover.** The fonts refuse U+2010 and Δ (the precondition). "P‐101" at "Δ1" among plain rows resolves and draws:
      - "2.  P-101 · p. 3" and "Rev Delta1", with the plain rows as typed;
      - "Owner: ?ukasz";
      - the note `Printed in plain characters: U+2010 as "-", U+0141 as "?", U+0394 as "Delta".` at y 628, above the contents header.

      Every character drawn is one the fonts print. A continuation page's header carries the name's plain form ("TA−2026" → "TA-2026"). The longest note takes two lines within the text width, and `coverNoteLines` cuts an over-long note to two lines ending in "…".
    - **End to end: the reviewer's scenario.** `buildAndDownloadDocPack` runs with `/packages`' `buildCoverAfter` (snapshot, then cover) on P-100, "P‐101" at "Δ1" and P-102. Everything is real except the database and the browser: pdf-lib, the stamper, the cover and `recordPackagePrint`. The result:
      - all three sheets are included and nothing is left out;
      - the snapshot is written, then the cover is built, then the download is triggered: a 4-page pack, cover on top;
      - the snapshot's "P‐101" entry carries `stampMapped` (U+2010 → "-", U+0394 → "Delta"), and the plain entries have exactly their old keys;
      - the distribution record names all three.

      Source pins: the page passes `stampMapped` into the snapshot entry, and docPack keeps it only when it is non-empty.
    - **Run against the first pass (`43cb45c`):** 7 of the 11 fail. The cover throws `WinAnsi cannot encode "‐" (0x2010)` (and U+2212, U+247D), `coverNoteLines` does not exist, and the pins fail. The four regression and precondition tests pass there, as they must. **On `b154823`:** the end-to-end scenario prints two of the three sheets, the third left out and named, as the reviewer found.
  - **Files outside the brief's list**, edited for this fix: `lib/physicalBridge.ts` (`buildPackageCover`, `coverNoteLines`); `lib/workPackages.ts` (`PrintSnapshotSheet.stampMapped`, a type only); `app/(protected)/packages/page.tsx` (one spread in the snapshot entry). None is on the brief's do-not-edit list, and no other fleet package edits them, except notifications N9 in `lib/workPackages.ts`, at `notifyPackagesOfRevUp`'s notice kind (`:689` here), far from this hunk.
  - Verified (review fix, in the PS-P7 worktree with the fix in place): `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every file this package touched (the fix's six and the first pass's ten); full `npx vitest run` exit 0: 454 files / 9981 tests, 9974 passed, 7 expected-fail, no failures, at a load average of about 8 on 4 cores (187 s). The cover record replayed green with `lib/physicalBridge.ts` at its `b154823` content swapped into this tree (the three regression tests pass there), and the three `PHYS-16` reproductions above were re-run against the fixed tree (each rejects as stated). Against the `43cb45c` versions of the four code files, `psP7CoverText` fails 7 of 11, as stated.
- **Integrator fix pass (2026-10-08): done-when 1 amended by the integrator under the user's delegation; a format character is removed and named.**
  - **The ruling.** The re-review left done-when 1 ticked "✓ except …": the parenthetical's U+2013 and U+2014 → "-" and curly quotes → straight, and the brief's U+00A0 → space, were deliberately not applied, recorded as the provisional `DEC-97` and awaiting a ruling. Done-when 1 amended by the integrator under the user's delegation, 2026-10-08: every character the embedded WinAnsi Helvetica-Bold prints is drawn as typed (U+2013, U+2014, curly quotes and U+00A0 included); only a character the font cannot print is mapped (U+2010/2011/2012/2015/2043/2212 and the small/fullwidth hyphens → "-", primes/reversed quotes → straight quotes, U+0394/U+2206 → "Delta", compatibility forms → NFKC when printable, anything else → a visible "?"), and nothing is dropped silently. The ground: industry practice — a stamp must print exactly what was typed wherever the font can print it, and a plain-text stamp must stay byte-identical; the font prints those characters; the stamper's own "—" is on every copy; done-when 3. The criterion's text above now reads as amended, the original kept beside it. `DEC-97` records the rule as a decision, no longer a provisional one.
  - **Format characters (the re-review's second minor).** At `f9cfe43` a zero-width format character (General_Category Cf: U+200B zero-width space, U+200C / U+200D, U+2060 word joiner, the directional marks) was drawn as "?" — "P[U+200B]101" pasted from a spreadsheet read "P?101" on paper — while U+FEFF, which JavaScript's `\s` matches, became a space. Two invisible characters, two treatments, and a glyph on paper the record does not visibly carry. Now every Cf character the font does not print is treated the same: `stampText` removes it from the drawn text and records it in `mapped` with `printedAs: ""` (`FORMAT_CHARACTER`, `lib/stamping.ts:197`; the branch at `:241`), and `stampTextNote` writes "U+200B removed" for such an entry (`:269`). "P[U+200B]101" draws "P101", and the copy's footer, the cover's note, the portal's `stampMapped` and the print snapshot's `stampMapped` name U+200B. Nothing is dropped silently: the removal is on the copy and in the record. The soft hyphen (U+00AD) is Cf but WinAnsi prints it, so it is drawn as typed like every printed character (done-when 1 as amended). `stampFooterUnprintable` (`lib/transmittals.ts`) is unchanged: it names every such character except U+FEFF, which `\s` makes "printable" there (the footer's wrap draws it as a space; P22's pin measures it through that wrap), while the stamp removes it; its docblock says so, and the pin below states that one difference. No runtime path calls it (`armCheckedItems` arms on the check alone).
  - Tests (`lib/__tests__/psP7StampText.test.ts`, 19 → 21): "P[U+200B]101" → "P101" with `mapped` naming U+200B; U+FEFF the same; U+200C, U+200D, U+2060, U+200E and U+202A each removed and named once, in the order met; the note reads "Printed in plain characters: U+200B removed." and, beside replacements, 'U+200B removed, U+2010 as "-", U+0394 as "Delta"'; U+00AD drawn as typed. The whole-BMP test now checks that a Cf character the font does not print is removed and named, that removal is the only way a character leaves the text, and that every other character takes up a place. The guard pin names U+FEFF as the only removed character `\s` counts as whitespace. Through the stamp: a watermark and a notice carrying "P[U+200B]101" draw "P101" in every mark, never "P?101" or "P 101", and the footer's note reads "Printed in plain characters: U+200B removed.". The plain-text record `psP7StampPlain.golden.json` is unchanged and replays green: no plain case carries a format character.
  - Verified in the PS-P7 worktree: `npx vitest run` on the six suites the integrator named plus every test that imports `lib/stamping.ts` or `lib/transmittals.ts` (20 files, `--maxWorkers=2 --testTimeout=120000`): 558 passed, exit 0. `npx eslint --max-warnings=0` on the four files changed: 0. `npx tsc --noEmit`: 0. `node audit-reports/build-index.mjs`: corpus integrity passes, once `public-surfaces/README.md`'s counts followed `PHYS-16` (opened at `43cb45c` without them: 65 findings, 27 LOW, 16 in this report).

**Done-when.**
1. ✓ As amended by the integrator under the user's delegation, 2026-10-08 (`DEC-97`). One helper, `stampText`, maps stamp text to what the stamp font can print, and every caller above draws through it, inside `applyStampToPdfDoc`, which every caller calls. Every character the embedded WinAnsi Helvetica-Bold prints is drawn as typed — U+2013, U+2014, the curly quotes and U+00A0 included (cp1252 0x96, 0x97, 0x91–0x94, 0xA0; pinned against pdf-lib code point by code point, and by P22's regression test, where "P–102" and "P-103 “GA”" stamp). Only a character the font cannot print is mapped: U+2010, U+2011, U+2012, U+2015, U+2043, U+2212 and the small and fullwidth hyphens (U+FE58, U+FE63, U+FF0D) → "-"; the primes and reversed quotes → straight quotes; U+0394 and U+2206 → "Delta"; a compatibility form → its NFKC decomposition when the font prints it; anything else → a visible "?". A format character (Cf), which has no glyph, is removed and named on the copy ("U+200B removed"). Nothing is dropped silently: every replacement and removal is in `mapped` and on the copy's note. Each is pinned against pdf-lib for every BMP code point.
2. ✓ A number or label with such a character stamps on every path the record names:
   - the share route (route-level, real stamper: stamped, `share_link`);
   - the in-app download and print, the pack, the book and the linked drawings (each caller's text through the real stamper);
   - the transmittal portal (route-level: armed, stamped on every download) and its issue-time check (`stampable`);
   - a work package's print from `/packages` (end to end, review fix). Every sheet stamps, the cover draws the number and revision in the same plain form with the same note, and the pack downloads. On `b154823` such a sheet was left out and named. At the first pass (`43cb45c`) the whole print failed at the cover and left a print snapshot behind: a regression, fixed in the review fix above.

   The stamped text is recorded with what was mapped:
   - on the copy itself: the note line, on every path, and on the pack's cover;
   - where the stamp's text is already recorded: on the portal's delivery trail (`stampMapped` beside `docNumber` and `rev`), and on the work package's print snapshot (`stampMapped` on that sheet's entry, beside its `label` and `revLabel`).

   `applyStampToPdfDoc` returns it to every caller. The physical bridge's other artifacts (the hold card, the equipment label, the drafting traveler) are not stamp paths: they draw with the standard fonts directly and fail on such a character, as they did on `b154823`. They are [`PHYS-16`](#phys-16) (DEC-31).
3. ✓ Regression: a number or label in plain characters stamps exactly as today. The draw calls and the saved bytes of every caller's plain-text stamp equal the record taken on `b154823` (`psP7StampPlain.golden.json`). P22's `stampFooterUnprintable` guard and issue-time warning follow the new rule: an item is no longer unprintable for its label (the stamp prints every character), so it is armed again on its check, the arming still requiring the check, and the check no longer warns over a label. The work-package cover, which now draws through the helper too, is byte-identical for plain text against its own record of the `b154823` cover (`psP7CoverPlain.golden.json`). The print snapshot of a pack whose sheets are all plain has exactly the keys it had (end-to-end test).

**Scope / residual.**
- Not changed: the font (pdf-lib's standard Helvetica-Bold; no new dependency); the stamp's layout, placement, QR and wording; any caller's text; the share route's, `lib/downloads.ts`'s, `MultiDocViewer`'s and `FileReferenceModal`'s code (they draw through the stamper as they are); `lib/docPack.ts` except to keep the stamp's result for the snapshot; what the database records for those paths (`download_audits` has no text column; no migration). The cover's layout is unchanged; it gains only the note, and only when something was replaced.
- A character with no plain form prints as "?": "Ж" in a number reads "P?101" on paper. The note gives its code point, and the verify QR, bound to the exact version, still identifies the document. A Unicode-capable embedded font would print it; none is a dependency today, so none is added. A format character (U+200B, U+2060, U+FEFF) has no glyph in any font: it is removed and named ("U+200B removed"), so the paper reads "P101" as the register does.
- `stampFooterUnprintable` (`lib/transmittals.ts`) duplicates `stampFontPrints`'s WinAnsi set, because a browser module must not import pdf-lib; a test pins the two equal.
- Transmittals: `TRX-15`'s P22 blocks describe the label guard this replaces; a cross-area note is appended there, its status unchanged. The route's stale header comment (`app/api/transmittal/route.ts:34`–`:36`) stays with notifications N9, P22's owner. The label case of the route's after-the-fact notice reason no longer arises, since a label never fails the stamp.
- [`PHYS-16`](#phys-16) (opened here, DEC-31): the physical bridge's other printed artifacts, the hold card, the equipment label and the drafting traveler. They still draw with the standard fonts directly and throw on such a character, as they did on `b154823`; PS-P7 does not change them. The cover, the one generator PS-P7's change put such text in front of, is fixed here (PHYS-16's Partial block).
- Unchanged, and not this package's: `/packages` writes the print snapshot BEFORE it draws the cover, because the cover's QR carries the snapshot's id (`app/(protected)/packages/page.tsx:213`, `:235`). So a cover that fails for any other reason (a field tablet out of memory, say) still leaves its snapshot behind with nothing downloaded, as on `b154823`. Raised for the integrator to route to document-control, the owner of `PKG-6` / `VFY-18`'s ordering: compensate the snapshot on a cover failure, or build the cover against a pre-allocated id.
- No migration.

---

<a id="phys-16"></a>

## PHYS-16 · The physical bridge's own printed artifacts — the hold card, the equipment label, the drafting traveler (and, as opened, the work-package cover) — draw text with the standard fonts directly, and a character WinAnsi cannot print fails the print

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** the integrator, to schedule as a public-surfaces follow-up package on `lib/physicalBridge.ts` alone (proposed: `PS-P7b`, the three generators below) — opened by public-surfaces Round G PS-P7, 2026-10-07 (DEC-31). Not a merge prerequisite of PS-P7: the three fail the same way on `b154823`, and PS-P7 does not change them. The cover, which PS-P7's change did put such text in front of, is fixed in PS-P7 (Partial below).
- **Assigned:** public-surfaces PS-P8 PHYSICAL BRIDGE TEXT — by the integrator, 2026-10-13 (launched at `6503ea7`).
- **Verification:** CONFIRMED. Reproduced after PS-P7's review fix (2026-10-07): `printHoldCard({ docLabel: "P‐101", docRev: "Δ1", … })` rejects `WinAnsi cannot encode "‐" (0x2010)`; `printEquipmentLabels([{ tag: "P-101", description: "Motor 5 kΩ" }])` rejects on `"Ω" (0x03a9)`; `printTicketTraveler({ ticketNumber: "KE‐0001", … })` rejects on U+2010. Each resolves with plain text. As opened, `buildPackageCover({ packageId, name, docs: [{ label: "P‐101", rev: "Δ1" }] })` rejected the same way on `b154823` and at `43cb45c`; it resolves since PS-P7's review fix.
- **Locations:** `lib/physicalBridge.ts:63` (`fit`, which measures with `widthOfTextAtSize` and throws first); `:99`–`:155` (`printEquipmentLabels`: the tag, description and location); `:179`–`:216` (`printHoldCard`: `docLabel`, `docRev`, the reason, the notes and the placed-by name); `:233`–`:270` (`printTicketTraveler`: the ticket number, title, status, people and deliverable revision). As opened, also `buildPackageCover` (now `:342`, drawing through `stampText` since PS-P7's review fix) and its caller `app/(protected)/packages/page.tsx` (`buildCoverAfter`).
- **Independently verified:** — opened 2026-10-07 by PS-P7 from its own reading and a scratch reproduction; not yet challenged by a second party.

**Mechanism.** `PHYS-15` routed every stamp's text through `lib/stamping.ts` `stampText`. The physical bridge's generators embed `StandardFonts.HelveticaBold` / `Helvetica` themselves and draw caller text directly, most of it through `fit`. The character that failed the stamp (a Unicode hyphen, a Greek delta, a name in Cyrillic) throws there. Since PS-P7's review fix the cover draws its data through `stampText`; the other three still do not.

**Failure scenario.** A drawing numbered "P‐101" (U+2010, pasted from Word), or at revision "Δ1", goes on hold. Its hold card cannot be printed: `printHoldCard` throws and nothing downloads, so the red tag the hold exists to hang is never made. An equipment label whose description carries "Ω", or a traveler for a ticket whose number or title carries such a character, fails the same way. (As opened, the scenario was a `/packages` print failing at its cover once PS-P7 stamped its sheets. That was a regression of PS-P7's first pass, and its review fix draws the cover through `stampText`.)

**Done when.**

- [ ] every text the four generators draw from data (not their fixed ASCII captions) goes through `stampText` — `fit` and the unfitted `drawText` calls with caller text — so such a number, label, name or description prints in characters the font prints and never throws
- [ ] where the text is a document's identity (the cover's contents, the hold card's document line), the artifact says what was replaced (for example with `stampTextNote`'s line)
- [ ] regression: an artifact whose text the font prints is drawn byte-identically, pinned by a record like `psP7StampPlain.golden.json`

**Partial (2026-10-07, public-surfaces Round G).** PS-P7's review fix resolved the cover, the one generator PS-P7's own change put such text in front of (`PHYS-15`'s Resolution, "Review fix"). `buildPackageCover` (`lib/physicalBridge.ts:342`) draws through `stampText`: the package name, the description, the by-line, each contents row's number and revision, and the continuation header. When anything was replaced, the first page carries `stampTextNote`'s line (`coverNoteLines`, `:333`). Tests: `lib/__tests__/psP7CoverText.test.ts`; its regression record `psP7CoverPlain.golden.json` was taken on the `b154823` cover.

Done-when, as it stands:
1. Not done for three of the four generators. The cover ✓. The equipment label (tag, description, location), the hold card (document label and revision, reason, notes, placed-by name) and the traveler (ticket number, title, status, requester, drafter, deliverable revision) still draw caller text directly, and throw.
2. Not done for the hold card's document line. The cover's contents ✓ (the note).
3. The cover ✓. The other three have no record yet.

**Owner of the remainder:** the integrator, as a public-surfaces follow-up on `lib/physicalBridge.ts` alone (proposed `PS-P7b`). The pattern to follow is `buildPackageCover`'s `drawable`: map once, up front, then draw, and add the note where the text is a document's identity. Severity stays LOW: these three failed the same way on `b154823`, and nothing in PS-P7 made them worse.

**Resolution (2026-10-13, public-surfaces Round G).** Package PS-P8 PHYSICAL BRIDGE TEXT, on base `6503ea7` (carrying PS-P7 and [`DEC-97`](../DECISIONS.md#dec-97)); one code file, no migration. Reproduced on `6503ea7`: with `lib/__tests__/psP8BridgeText.test.ts` in its 11-test form (`beeac89`) run against an exported `6503ea7` tree (by the re-review), the seven tests that print such text reject with `WinAnsi cannot encode "‐" (0x2010)` (or `"​" (0x200b)`, `"⑽" (0x247d)`); the source pin fails its regex assertion on the `6503ea7` source; the two regression replays and the precondition test pass. Re-run at the integrator's fix pass with the suite as it now stands (20 tests), same base file: 13 reject with `WinAnsi cannot encode` (U+2010, U+200B, U+247D or U+03A9) — the three hold-card, five label and two traveler fix tests and the label, hold-card and traveler cases of the every-field guard; the raw-field source pin fails (it flags 16 `fit(`/`drawText(` calls in the `6503ea7` source); the one-mapper pin fails (no `textMapper` there); five pass — the two regression tests, the precondition, the guard's cover case (the cover draws through `stampText` since PS-P7) and the pin's self-test.
- `lib/physicalBridge.ts` `textMapper()` (new, module-private): buildPackageCover's `drawable` lifted out unchanged — `stampText` per text, every replacement collected once in the order met — so the cover and the three generators share one mapper. `plainNoteLines(note, font, width, maxLines)` (new, module-private) is `coverNoteLines`'s body with the width and line count as parameters; `coverNoteLines` now calls it with `520, COVER_NOTE_LINES` (same output; the cover's record replays byte for byte).
- `printEquipmentLabels`: the tag, the description and the location are mapped once, up front, before anything is drawn. The QR still targets `equipmentLabelUrl(asset.tag)` — the tag on record — and the file name is still `safe(asset.tag)`. When anything on the label was replaced or removed (integrator ruling, below), the tag line ends in "*" (appended after the cut, so it always shows) and `LABEL_PLAIN_MARK` — "* plain characters — scan for exact tag", 5.5 pt amber, 94 pt wide — is drawn under the location line inside the text column (sticker: x 144, y 80; the column is x 144 to 244, the location at y 90, the caption's top line at y 28; the QR ends at x 136). A label whose text the fonts print draws neither.
- `printHoldCard`: the document line (`docLabel` and `  ·  Rev docRev`), `Reason: …`, the notes and the `Placed by … on <date>` line are mapped once, up front, before anything is drawn. When anything was replaced, the card carries `stampTextNote`'s line in amber at 8 pt under the placed-by line (x 32, y 194, a second line at y 185; at most `HOLD_NOTE_LINES` = 2, wrapped to `HOLD_CARD_TEXT_WIDTH`, the last cut with "…"), left of the QR plate (x 452) and above it (its top is y 190). The QR (`/verify-hold/<holdId>`) and the file name are built from the values on record.
- `printTicketTraveler`: the ticket number, the title and each row's value (status, `Rev <deliverableRev>`, requester, drafter, the opened date) are mapped once, up front. When anything on the page was replaced (the number, the title or any row value), the traveler carries the note, naming every replacement, in amber at 8 pt under the scan paragraph (x 52, y 456 / 447; at most `TRAVELER_NOTE_LINES` = 2, width 520). The QR (`/verify-ticket/<id>?r=<deliverableRev on record>`) and the file name are unchanged.
- The fixed captions (`LABEL_CAPTION_LINES`, `HOLD — DO NOT ADVANCE`, `HOLD_CARD_SCAN_LINES`, `DRAFTING TRAVELER`, the row keys, the scan paragraph) are not data and are drawn as before.
- Tests: `lib/__tests__/psP8BridgeText.test.ts` (20, after the integrator's fix pass; 11 as first written) with its harness `lib/__tests__/psP8BridgePlainHarness.ts` and the record `lib/__tests__/psP8BridgePlain.golden.json`, recorded by the harness with `lib/physicalBridge.ts` at its `6503ea7` content (ten cases: three single stickers — every field; a long tag, description and location cut with "…" in Latin-1 and cp1252; tag only — a 12-label bulk sheet over two pages, three hold cards — every field; no revision, notes or name; long text cut with "…" in Latin-1 and cp1252 — and three travelers likewise). Each case records every draw call (text, position, size, font, colour), the download's file name, the page count and the downloaded bytes' SHA-256 (dates pinned). With the fix, all ten replay identically. The fix tests: the hold card with `P‐101` at `Δ1`, a reason with `Ω` and placed by `Łukasz` downloads one page, draws `P-101  ·  Rev Delta1`, `Reason: Motor 5 k? rewind`, `Placed by ?ukasz on …`, keeps the printable en dash and curly quotes as typed, and carries `Printed in plain characters: U+2010 as "-", U+0394 as "Delta", U+03A9 as "?", U+0141 as "?".` at (32, 194); a format character in the number is removed and named (`U+200B removed`); the longest note takes two lines within the column, the last ending "…", above the QR's caption; the label `P‐101` / `Motor 5 kΩ` / `Bay Δ2` downloads and draws `P-101*`, `Motor 5 k?`, `Bay Delta2`, its QR targeting `/assets/P%E2%80%90101`; the marker's position, size and width (inside the 100 pt column, below the location, above the caption); a replacement in the description or a removal in the location also marks the label, and a label in printable text (en dash, curly quotes, em dash) is not marked; a long substituted tag is cut so it ends "…*" within the column; a bulk sheet with one such tag among plain ones draws every label, the plain ones as typed and unmarked, the substituted one with `TT-301*` and the marker in its own column; the traveler with `KE‐0001`, `Δ` in the title, revision `Δ1` and requester `Łukasz` draws the plain forms and the note at (52, 456), its QR keeping `?r=%CE%941`; its longest note takes two lines within 520; the every-field guard (integrator's fix pass): each of the four generators is given a character the fonts cannot print (`Ω‐` and a zero-width space) in every caller field — the label's tag, description and location (single sticker and bulk sheet); the hold card's document label, revision, reason, notes and placed-by name; the traveler's number, title, status, requester, drafter and deliverable revision; the cover's name, description, owner, printer and every sheet's number and revision over two pages; the ids, which reach only the QR, too — with every date rendered by `toLocaleDateString` in Arabic-Indic digits behind a right-to-left mark; each gives a PDF that loads, draws only characters `stampFontPrints` accepts, and draws each field's token, and each case's field list is checked against the input interface's keys read from the source, so a field added later without a case fails it. Removing `drawable` from one traveler row or from the label's location makes the guard fail (checked in scratch, then reverted). A source pin reads the arguments of every `fit(`/`drawText(` call by balanced parentheses and rejects any raw `input.`/`asset.`/`assets[` field in them — bare, in an expression or inside a template literal (`${input.…}`), a `.length` count excepted; it is shown to catch the shapes `6503ea7` used for the hold card's document line and reason, among ten. A pin that one `textMapper` serves all four generators. The PS-P7 suites (`psP7CoverText.test.ts`, whose cover record replays unchanged, and `psP7StampText.test.ts`) and `verifyDoor.test.ts` stay green.

- Verified in the PS-P8 worktree: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` on the four changed code and test files 0. Full `npx vitest run` exit 1 at a load average of about 28 (other fleets running): 511 files, 11330 tests, 12 failed in 11 files this package does not touch (10 hit the 5 s default timeout, 1 a wall-clock budget, 1 a timer race). Re-run with `--maxWorkers=2 --testTimeout=120000`, 10 of those 11 files pass. The eleventh, `drawingText.test.ts`'s wall-clock case (`expected 1150 to be less than 1000`), passes when run on its own, twice. None of the 11 imports `lib/physicalBridge.ts`.
- Review fix pass (same day): the source pin was widened to template literals (above); the comments in `printHoldCard` and `printTicketTraveler` and done-when 2 now say the note names every replacement on the page, not only the identity's (no behaviour change). `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` on the three changed code and test files 0; the PS-P8, PS-P7 and `verifyDoor` suites 80/80. Full `npx vitest run` exit 1 at a load average of about 31: 511 files, 11330 tests, 40 failed in 20 files this package does not touch (timeouts and wall-clock budgets; none imports `lib/physicalBridge.ts`). Those 20 files re-run with `--maxWorkers=2 --testTimeout=120000`: exit 0, 941 passed, 1 expected fail.
- Integrator's fix pass (2026-10-13): the label's marker (the ruling below); the every-field guard and the balanced-parenthesis raw-field pin (above); the traveler's comment names every replacement on the page; the reproduction sentence above states what was run. Behaviour changes only for a label that needed a substitution; the hold card, the traveler and the cover draw as before, and the regression record replays unchanged. `npx tsc --noEmit -p .` 0; `npx eslint --max-warnings=0` on the two changed code and test files 0; `psP8BridgeText` (20), `psP7CoverText`, `psP7StampText`, `verifyDoor` and `psStampRoundF` 128/128. Full `npx vitest run --maxWorkers=2` exit 0: 511 files, 11339 tests, 11329 passed, 10 expected fail, at a load average of about 10–17 (418 s). A first full run was stopped partway by the session's background time limit, with one failure seen so far, `notificationDispatchMembership.test.ts`'s source-scan case at 6.6 s (it does not import `lib/physicalBridge.ts`); the complete re-run above passed it.

**Done-when.**
- ✓ Every text the four generators draw from data goes through `stampText`: the cover since PS-P7; the label's tag, description and location; the hold card's document line, reason, notes and placed-by line; the traveler's number, title, status, revision, people and date. Such text prints in characters the fonts print and never throws. What keeps this true: the every-field guard gives each generator such a character in every caller field and asserts a PDF in printable characters (whatever path a field takes to the page, a local or an array included), and the source pin rejects a raw caller field in any `fit(`/`drawText(` argument; the pin reads the source's syntax only, and the guard covers the fields the input interfaces declare today.
- ✓ Where the text is a document's identity, the artifact says what was replaced: the cover's contents (PS-P7) and the hold card's document line (`stampTextNote`'s line under the placed-by line). The note names every replacement on the page, not only the identity's: on the hold card the document line, the reason, the notes and the placed-by line. The traveler carries the same note, naming every replacement on the page (its number, its title and the row values: status, revision, requester, drafter, date). The equipment label has no room for the note; it carries the marker instead (a "*" on the tag line and `LABEL_PLAIN_MARK`), by the integrator's ruling below.
- ✓ Regression: a label, hold card or traveler whose text the fonts print is drawn byte-identically — every draw call, the file name, the page count and the downloaded bytes — pinned by `psP8BridgePlain.golden.json` (recorded on `6503ea7`), as the cover is by `psP7CoverPlain.golden.json`.

**Integrator ruling (2026-10-13, under the user's delegation, the DEC-90 practice; recorded under [`DEC-97`](../DECISIONS.md#dec-97)).** An equipment label is read by people on the plant floor, and a tag printed with a substituted character must never look like the exact tag: "P‐101" (U+2010) and "P-101" would print the same sticker, and "Ω-1" and "Σ-1" both print "?-1". Failing safe, when (and only when) any of the label's tag, description or location needed a replacement or a removal, the label draws a compact visible marker: a trailing "*" on the tag line and one 5.5 pt line, "* plain characters — scan for exact tag", inside the label's text column, clear of the QR. A label whose text the fonts print is byte-identical to `6503ea7` (`psP8BridgePlain.golden.json` replays unchanged). The full `stampTextNote` line still does not fit a 100 pt column; the marker says the tag is not exact and points to the QR, which resolves the tag on record.

**Scope / residual.** The QR targets and download file names never used the printed form, so a scan and a saved file still name the record. Nothing else remains; no new finding.

---

<a id="phys-17"></a>

## PHYS-17 · `download_audits` has no ticket or attachment column, so a drafting-ticket copy can never be recalled — the stale-copies ledger has no ticket arm

- **Severity:** LOW
- **Status:** RESOLVED (2026-10-14, DF-P12 — PASTE pending: `20261223` after `20261068`; until it is pasted the ticket copy is recorded without the two columns and the ticket arm answers "unavailable")
- **Assigned:** drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS (the `download_audits.ticket_id` / `attachment_id` columns, `recordTicketCopy` writing them, and the `lib/staleCopies.ts` ticket arm), its migration number allocated at that package's launch — opened by drafting-flow Round G DF-P10's review fix pass 4, 2026-10-13, from `PHYS-8` done-when 3 (DEC-31).
- **Verification:** CONFIRMED on DF-P10's branch.
- **Locations:** `supabase/schema.sql` (`download_audits`), `supabase/migrations/20261068_dc_roundF_download_audits_record.sql` (adds only `source`, `share_id`, `transmittal_id`), `lib/ticketDeliverableCopy.ts` (`recordTicketCopy`), `lib/staleCopies.ts` (keyed on `document_id` / `version_id` only)
- **Independently verified:** — opened 2026-10-13 by DF-P10; not yet challenged by a second party.

**Mechanism.** DF-P10 writes the ticket copy's distribution row in the columns the table has (`PHYS-8` done-when 1, 2, 4) and names the file on an `audit_logs` DOWNLOAD row beside it, because the table has no ticket or attachment column. `lib/staleCopies.ts` reads holders by `document_id` / `version_id`, so a ticket copy (no document) is never in its answer.

**Failure scenario.** Rev 2 of a drafting ticket issues; three people printed Rev 1's package last week. Nothing lists them as holders of a superseded copy: the stale-copies nudge and the recall cover register documents only.

**Done when.**

- [ ] A `DEC-30` one-paste migration (not widening) adds `download_audits.ticket_id UUID` and `attachment_id TEXT` (plain columns, not foreign keys — the record outlives the ticket's archive shed, as `share_id` outlives its share), the `insert_own` policy unchanged
- [ ] `recordTicketCopy` writes them (the audit row kept), falling back to today's row on `42703` / `PGRST204` for the two columns
- [ ] `lib/staleCopies.ts` gains a ticket arm keyed on `(ticket_id, attachment_id)` against the ticket's newer issued `rev`, with a test

**Resolution (2026-10-14, drafting-flow Round G).** DF-P12 DELIVERABLE FOLLOW-UPS. Reproduced on `6f89d39`: `download_audits` has no ticket or attachment column (`supabase/schema.sql:797-807`; `20261068` adds `source`, `share_id`, `transmittal_id` only); `recordTicketCopy` wrote five columns (`lib/ticketDeliverableCopy.ts:221-227` on the base); `lib/staleCopies.ts` read holders by `document_id` / `version_id` only.
- `supabase/migrations/20261223_df_roundG_download_audits_ticket_copy.sql` — `ticket_id UUID` and `attachment_id TEXT`, plain nullable columns (no foreign key: the record outlives the ticket's archive shed), a partial index on `(ticket_id, created_at DESC)`, `download_audits_insert_own` unchanged (a member records only their own pull; the probes check the policy set), and the `source` comment restated with the four drafting channels (`drafting_unstamped` / `drafting_print_unstamped` added). Not a widening; refuses without `20261068`; DEC-30 one paste. *Review fix (same day):* `download_audits_select` lets every member of the org read every row, and a row naming a ticket carries the ticket's id — the public verify key (`/api/verify-ticket?t=<id>` answers its number, title and revision status). A new RESTRICTIVE `download_audits_ticket_read_scope` (FOR SELECT, TO authenticated: `ticket_id IS NULL OR EXISTS (SELECT 1 FROM tickets t WHERE t.id = download_audits.ticket_id)`, evaluated under the caller's own ticket policies) keeps a row naming a ticket from a member who cannot read that ticket (a Contractor-only member outside drafting-flow `AUTHZ-13`'s scope); a row naming no ticket is untouched, and a row whose ticket was deleted is the service role's to read. It narrows only; the probe reads the deparsed `qual`, and the inventory counts the rows naming a ticket (0 on a first paste) and the active Contractor-only members it narrows. The download_audits policy census (`lib/__tests__/downloadAudits.test.ts`) is re-pinned to the three policies.
- `recordTicketCopy` writes them (the audit row kept); `42703` / `PGRST204` naming either column → today's row (`isMissingTicketCopyColumn`), and before `20261068` the original shape as before.
- `lib/staleCopies.ts`, the ticket arm: `getTicketCopyRecall(ticket)` reads the ticket's copies (in its org, by `ticket_id`, the 365-day window, the 1,000-row cap with `capped`) and reads each copy as a scan of that file would answer now — `ticketVerdict` with the file's own revision and id (PHYS-2, drafting-flow `SM-5`): superseded, withdrawn or a review draft the ticket has moved past → outdated, current → current; a copy of the draft under review now (the ticket is live and its label is that draft's) is the reviewers' working copy — neither outdated nor nudged (review fix, same day: the first pass counted it outdated, so a recall mid-review would have told the reviewer to destroy the copy under review). An unreadable record (before `20261223`, or any failure) is a gap (`unavailable`), never "nobody holds a copy". `nudgeStaleTicketHolders` tells the outdated holders who have not re-taken the current file (the document arm's rule) with `doc_recalled` (the existing recall kind; resource `ticket`, linking to the request) and writes `DISTRIBUTION_RECALL` on the ticket's trail (who, when, which revisions they held); an unavailable record nudges nobody and says so on the trail.
- Tests: `lib/__tests__/dfRoundG_P12_deliverable.test.ts` "PHYS-17 — recordTicketCopy …" and "PHYS-17 / PHYS-8 dw3 — …" (including "a copy of the draft UNDER REVIEW now …"); on PostgreSQL 16, `lib/__tests__/rls/dfP12DeliverableRails.test.ts` "PHYS-17: …" (a member's own row naming the ticket and the file lands; one in another member's name is refused; UPDATE and DELETE touch nothing; the row outlives its ticket, readable by the service role only) and "PHYS-17 review fix: …" (a Contractor-only member reads the row of the ticket they work on and a document row, not another ticket's; other members read all three). `lib/__tests__/notificationWriteRails.test.ts` lists the new pass-through, and `lib/__tests__/requestAcksClock.test.ts`'s recall-category census counts the ticket arm's recall (a fourth `category: "recall"`).

**Done-when.**
- ✓ The `DEC-30` one-paste migration adds both columns, not foreign keys, `insert_own` unchanged (pending paste); the new ticket columns are read under the caller's ticket scope (the restrictive read policy above).
- ✓ `recordTicketCopy` writes them (the audit row kept), falling back to today's row on `42703` / `PGRST204` for the two columns.
- ✓ `lib/staleCopies.ts` has a ticket arm keyed on `(ticket_id, attachment_id)` against the ticket's newer issue, with tests.

**Pending migration:** `supabase/migrations/20261223_df_roundG_download_audits_ticket_copy.sql` (after `20261068`; either order with the DF-P12 deploy).

**Scope / residual.** Nothing calls the ticket arm yet — no recall control on the ticket page, no recall at a new issue → opened as [`PHYS-18`](#phys-18) (DEC-31).

---

<a id="phys-18"></a>

## PHYS-18 · The ticket copy recall exists but nothing calls it — the holders of a superseded ticket deliverable are never told

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P15 DELIVERABLE PAGE WIRING (allocated by the integrator at the DF-P12 merge) — the recall control on the ticket page and the recall at a new issue (with drafting-flow `EVID-16` done-when 2, `DCW-4`'s page offer and `SM-15`). Ruled by the integrator at the DF-P12 merge, 2026-10-20 (DEC-90); opened by drafting-flow Round G DF-P12, 2026-10-14 (DEC-31).
- **Verification:** CONFIRMED on DF-P12's branch.
- **Locations:** `lib/staleCopies.ts` (`getTicketCopyRecall`, `nudgeStaleTicketHolders` — no caller), `app/(protected)/requests/[id]/page.tsx`, `app/api/tickets/workflow-action/route.ts` (the issuing actions)
- **Independently verified:** — opened 2026-10-14 by DF-P12; not yet challenged by a second party.

**Mechanism.** `PHYS-17`'s ticket arm lists the members holding an outdated copy of a ticket's files and can recall them, as the document arm does. A document's recall runs on publish (`lib/postPublish.ts`, `source: "auto"`) and from the controller's panel; the ticket arm has neither — no control on the ticket page, and no call when an issuing action writes a newer label.

**Failure scenario.** Rev 2 of a drafting ticket issues; three people printed Rev 1's package (each copy now recorded by ticket and file); nobody is told their print is superseded unless they scan it.

**Done when.**

- [ ] The ticket page shows the holders (`getTicketCopyRecall`) to the people who may recall them (the requester, the drafter, a controller) with a "Recall outdated copies" control (`nudgeStaleTicketHolders`, `source: "manual"`), and says when the record could not be read (`unavailable`)
- [ ] An issuing transition (`approve_draft_ifc`, `approve_minor_correction`, `engineer_approve_final`) recalls the holders of the superseded issue (`source: "auto"`), best-effort after the transition lands
- [ ] Tests pin both callers

**Resolution (2026-10-20, drafting-flow Round G).** drafting-flow DF-P15 DELIVERABLE PAGE WIRING, as ruled (`DEC-90` ruling (3)). Reproduced on `0041bd8`: `getTicketCopyRecall` / `nudgeStaleTicketHolders` (`lib/staleCopies.ts`) had no caller — no control on the ticket page, nothing at an issue.
- **The recall control** — `components/requests/TicketCopyRecallPanel.tsx` (new), mounted in the ticket page's Final section (`app/(protected)/requests/[id]/page.tsx` :2974) for the requester, the assigned drafter and a controller (Admin / DocCtrl by the role collection, `hasAnyRole`) only (:1520), on a live ticket. It lists every member who took a copy of the ticket's files in the window, each copy as a scan of it would read now ("Rev 1 — superseded", "review draft", "current"), says how many are outdated, and "Recall outdated copies (N)" calls `nudgeStaleTicketHolders({ …, source: "manual" })` — every member holding an outdated copy who has not since taken the current one, the actor's own copy excluded — then re-reads. A record that cannot be read (before `20261223`, or a failed read) is said as a gap ("who holds one is unknown — not 'nobody'", with Try again), and recording a recall then tells nobody (the arm's `unavailable` rule); a capped list says holders may be missing; a failed recall is said, never shown as sent. The ticket the panel reads is memoized on the fields the verdict reads, so it re-reads only when the ticket moves.
- **The recall at an issue** — `app/api/tickets/workflow-action/route.ts` (:1292, `recallSupersededTicketCopies` :1457): after `approve_draft_ifc`, `approve_minor_correction` or `engineer_approve_final` writes a new issued label, the route schedules (`after()`, once the response is sent) the ticket arm with the ticket as the transition left it, bound to the service role for that request only (`lib/serverClientScope.ts` — `lib/staleCopies` writes its audit row and its notices through the shared client) and with `source: "auto"`. Best-effort: it never throws (a failure is logged), the issue has already landed and returned, and a transition that issues nothing schedules nothing.
- Tests: `lib/__tests__/dfRoundG_P15_routes.test.ts` "PHYS-18 — …" (`approve_draft_ifc` issues Rev 2; nothing recalled before the response; after it, the Rev 1 holder gets one `doc_recalled` bell row and the ticket's `DISTRIBUTION_RECALL` row carries `source: "auto"`, `latestIssuedRev: "2"`, the holder and the held rev; an unreadable record (42703, before `20261223`) is recorded `unavailable`, tells nobody and resolves; no holders → nothing; `submit_draft` schedules only the email drain); `lib/__tests__/dfRoundG_P15_pageClient.test.ts` "PHYS-18 — …" (the panel, rendered: the holders, the outdated count, the recall with `source: "manual"` excluding the actor's own copy, the re-read; the gap said and a recall recorded with nobody told; a failed recall said; no holders renders nothing; who sees it, pinned).

**Done-when.**
- ✓ The ticket page shows the holders (`getTicketCopyRecall`) to the requester, the drafter and a controller, with a "Recall outdated copies" control (`nudgeStaleTicketHolders`, `source: "manual"`), and says when the record could not be read (`unavailable`).
- ✓ An issuing transition (`approve_draft_ifc`, `approve_minor_correction`, `engineer_approve_final`) recalls the holders of the superseded issue (`source: "auto"`), best-effort after the transition lands.
- ✓ Tests pin both callers.

**Scope / residual.** The panel reads the ticket without `20261221`'s trust index (the page does not load `history_guarded_from`), so its verdicts read as before that paste — fail-safe; the route's issue-time recall passes the index when the row carries it. The holders shown are those the record names, i.e. copies taken since `20261223` is pasted (before it the record cannot be read by ticket, said). No owner needed.

---

<a id="phys-19"></a>

## PHYS-19 · The per-print sheet token covers only packs printed through `lib/docPack.ts`: a single download, a markup download, the two other "Print all" packs, a share copy and a transmittal copy still carry the document UUID in their verify QR, and the token table has no retention and no link to the cover's print

- **Severity:** LOW
- **Status:** OPEN — limbs 1, 2 and 4 closed at the PS-P9 merge (limb 1 built for the two "Print all" packs and WONTFIX for single copies; limb 2 ruled); limb 3 (the cover's print id) and the settled-print void assigned to PS-P10 (below).
- **Limb 1 WONTFIX reason (single copies):** Ruled by the integrator at the PS-P9 merge, 2026-10-20 (DEC-90): a single copy (a single download, the markup download, a share copy, a transmittal copy) is one sheet of one revision — its `?v=` QR already answers per-revision staleness, the document id it carries is a random, non-enumerable UUID, and `lib/verifyDisclosure` never names a restricted document; on `PHYS-4`'s analysis (a per-print token on a single sheet "moves the secret without shrinking it"), the per-print token adds value only for multi-sheet packs (partial and voided prints). The two other multi-sheet packs were routed through the token at the merge (below).
- **Assigned:** public-surfaces PS-P10 SHEET TOKEN PRINT LINK (limb 3 and residual (c) of `DACL-8`; assigned by the integrator at the PS-P9 merge, 2026-10-20, DEC-31). Opened by public-surfaces Round G PS-P9, 2026-10-20 (DEC-31), as the remainder of intelligence `DACL-8` criterion 2 outside the integrator's ruling (1) at the I-12 merge.
- **Verification:** CONFIRMED by reading the code on PS-P9's branch.
- **Locations:** `lib/downloads.ts:190-197` (`buildVerifyUrl`), `components/viewers/FullScreenViewer.tsx:1119` (the markup download), `components/assets/FileReferenceModal.tsx:172` (the linked drawings' "Print all", one merged stamped pack), `components/viewers/MultiDocViewer.tsx:774` (the collection book's "Print all", one merged stamped pack), `app/api/share/file/route.ts:124`, `app/api/transmittal/route.ts:683` (the portal copy), `lib/transmittalStampCheck.ts:210` (the issue-time stamp check); the token table's own remainders: `app/api/print-sheet-tokens/route.ts:74` (mint), `lib/docPack.ts:700` (the sheet tokens' print id) beside the cover's `work_package_prints` print id
- **Independently verified:** — opened 2026-10-20 by PS-P9; not yet challenged by a second party.

**Mechanism.** PS-P9 keys a pack's sheet QR to a per-print token the server mints at print time (`print_sheet_tokens`, `20261237`; `/verify/<token>`) — but only for packs printed through `lib/docPack.ts` `buildAndDownloadDocPack` (the work-package pack and the asset hub's pack). Every other stamping path still builds `/verify/<document UUID>?v=<version UUID>`:
- two more multi-sheet packs, each merging many stamped sheets into one PDF: the linked drawings' "Print every linked drawing as ONE stamped (uncontrolled) PDF" (`components/assets/FileReferenceModal.tsx:172`) and the collection book's "Print all" (`components/viewers/MultiDocViewer.tsx:774`);
- single copies: a single download (`lib/downloads.ts` `buildVerifyUrl`) and the markup download (`components/viewers/FullScreenViewer.tsx:1119`, which builds its own URL rather than calling `buildVerifyUrl`);
- an external share copy (`app/api/share/file`) and a transmittal copy (the portal copy, `app/api/transmittal`, and the issue-time stamp check that mirrors it).

Their verdicts are correct (`DEC-65`); what they print is the durable document UUID.

Two remainders of the token itself, recorded here so they have an owner (`DEC-31`):
- **Retention.** Nothing prunes `print_sheet_tokens` (unlike `verify_scans`' 90-day prune). PS-P9's fix pass bounded the growth rate — a soft per-member window: a mint that would take one member past 5,000 sheets an hour is refused, though concurrent requests can exceed it (`SHEET_TOKEN_MINT_WINDOW_MAX`, `lib/printSheetTokensServer.ts`; counted on the `(minted_by, minted_at)` index in `20261237`; over it the mint is 429 and the pack keeps today's QR) — but not the size. A prune is a product decision, not a cleanup: a pruned token's sheet answers "Unknown code" (never green, but no longer "current").
- **No link to the cover's print.** A work-package pack has two unrelated print ids: the cover QR's `?print=` (`work_package_prints`, `PKG-2`) and the sheet tokens' `print_id`, which the mint route draws separately. An incident review that starts from a sheet scan (`verify_scans.printed_ref` = the token's print id) cannot join it to the pack's print snapshot except by time and minter.

**Failure scenario.** A crew prints the linked drawings or a collection book with "Print all", or a contractor receives a single-sheet download or a transmittal copy; each sheet's QR carries the document's UUID, which `DACL-8`'s second criterion asked to replace with a per-print key. Nothing is disclosed for a restricted document (`lib/verifyDisclosure`, `VFY-16`), and a scan of it is never green without its printed version. Separately, `print_sheet_tokens` grows with every pack ever printed, and a sheet scan's print id does not lead to its pack's cover snapshot.

**Note — `PHYS-4`'s rejected alternative.** `PHYS-4` (WONTFIX) records that a per-print token for single sheets "would swap the document UUID for another bearer string on the same paper — it moves the secret without shrinking it". What a token adds is per-print evidence (the scan row names the print) and a void for a print that never left. Whether that is worth a mint on every download, share and transmittal copy is the integrator's to decide. The two "Print all" packs are a closer case: they are multi-sheet packs like `buildAndDownloadDocPack`'s, and routing them through `mintSheetTokens` / `settleSheetTokens` (with the same fallback to today's QR) needs no migration.

**Done when.**

- [ ] Either each of these paths — the two "Print all" packs, the single and markup downloads, the share copy and the transmittal copy — stamps a server-minted per-print token (as `lib/docPack.ts` does, falling back to today's QR when it cannot be minted), or the integrator rules the document + version QR sufficient for them and that limb closes WONTFIX on that ruling
- [ ] `print_sheet_tokens` has a retention rule (a prune, with what a pruned sheet's scan then answers), or the integrator rules unbounded retention acceptable under the per-member mint window
- [ ] A work-package pack's sheet tokens can be joined to its cover's print (`work_package_prints`): the mint takes the cover's print id, or the settle stores it on the token rows (a nullable column) — or the integrator rules the time-and-minter join sufficient
- [ ] Every QR printed before keeps being answered exactly as today

**Resolution (2026-10-20, public-surfaces Round G, at the PS-P9 merge).** Ruled by the integrator at the PS-P9 merge, 2026-10-20 (DEC-90):
- **The two other "Print all" packs — built.** The linked drawings' "Print all" (`components/assets/FileReferenceModal.tsx` `printAll`) and the collection book's "Print all" (`components/viewers/MultiDocViewer.tsx` `assembleStampedBook`, for both its print and its download) now go through `mintSheetTokens` / `settleSheetTokens` exactly as `lib/docPack.ts` `buildAndDownloadDocPack` does, with no migration: one mint before the first sheet is stamped (only when the sheets carry a QR at all; the book mints for its one workspace — a book spanning two workspaces keeps today's QR); each minted sheet's QR is `<origin>/verify/<token>` through the one shared rule `lib/printSheetTokens.ts` `packSheetVerifyUrl` (docPack stamps by it too); every other sheet — and every sheet when the table is absent or the mint fails — carries today's `/verify/<document>?v=<version>` QR and the print is never refused; once the pack has left (the print tab open, the download clicked) and its `download_audits` record is written, the print is settled with exactly the sheets in the PDF (fired, never awaited); a pack that never left (the print tab blocked, a failure) voids its whole print. Pinned as rendered: `lib/__tests__/psP9PrintAllTokens.test.ts` (14 — token QRs, the mint before the first stamp, the settle after the record, a stamp failure voided, the tab blocked voided, a hanging settle holding nothing back, and the REGRESSION cases: no token minted → today's QR on every sheet, nothing settled, printed / downloaded and recorded as before; no public origin → no mint and no QR). Against the pre-merge components 9 of the 14 fail; the 5 regression cases pass on both.
- **Single copies — WONTFIX** (the Status line above): a single download (`lib/downloads.ts` `buildVerifyUrl`), the markup download (`FullScreenViewer.tsx`), a share copy and a transmittal copy keep the document + version QR, unchanged.
- **The mint window — soft.** The per-member window is a soft window (a read, then the insert — concurrent requests by one member can exceed it), described so everywhere; it bounds an ordinary member's rate, not the table's size.
- **Retention — unbounded, ruled acceptable** (the integrator, at the merge, DEC-90). A sheet token is the verification key of a sheet that stays in the field as long as its document does; a prune would turn a valid sheet's scan from "current" / "superseded" into "Unknown code" — a controlled-copy check that quietly stops working. The rows are small (a hash and four ids), append-only evidence, never client-readable; they leave with their document or version (`ON DELETE CASCADE`, `20261237`), so the table's retention follows the register's own retention and disposal (`lib/retention.ts`); the soft per-member mint window bounds an ordinary member's rate. Revisit only if the table's size becomes an operating cost — then as a retention rule tied to the document's disposal, never an age-based prune.
- **The cover's print id — a deterministic link, assigned to PS-P10** (the integrator, at the merge, DEC-90). A time-and-minter join is a heuristic that two packs printed seconds apart by one member defeat; an audit trail should link by key. PS-P10: a work-package pack's mint carries the cover's `work_package_prints` id (checked server-side: same org, same caller, the pack being printed) and the token rows store it (a nullable column, migration 20261239 if `print_id` cannot carry it without loosening its meaning); a pack without a cover keeps a token print id of its own; every QR printed before is answered as today. PS-P10 also takes `DACL-8` residual (c): a controller can void a settled print (recall a printed pack) — the guard already allows a void after a settle.

**Done when (as ruled).**
1. ✓ The two "Print all" packs stamp a server-minted per-print token, falling back to today's QR; the single and markup downloads, the share copy and the transmittal copy — WONTFIX by the integrator's ruling (DEC-90).
2. ✓ by ruling — unbounded retention accepted under DEC-90 (above): tokens leave with their document or version; no age-based prune.
3. — Assigned to PS-P10 (a deterministic link to the cover's `work_package_prints` id).
4. ✓ Every QR printed before is answered exactly as today (the `?v=`, doc-only and `?print=` paths unchanged; pinned in `psP9SheetTokens.test.ts`), and every pack prints and downloads as today when no token is minted (pinned in `psP9DocPackTokens.test.ts` and `psP9PrintAllTokens.test.ts`).

