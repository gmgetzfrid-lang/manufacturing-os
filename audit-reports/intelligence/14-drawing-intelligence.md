# 14 · Drawing intelligence

**13 findings** — 6 HIGH · 7 MEDIUM.

Tag extraction, OPC references, pipe tracing, and revision staleness.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The ACL model on drawing reads is genuinely fail-closed, and it is applied consistently across all four read paths — the census loader, the locate lookup, the 'where else is this tag' search, and the audit recompute. Every one of them resolves controlled-document readability and drops on exception rather than on success. | `app/api/knowledge/drawing/route.ts:72-83; app/api/knowledge/locate/route.ts:69-77; app/api/knowledge/locate/route.ts:131-147` | This is the hardest part of an intelligence layer over a document-control system to get right, and it is right. Every fix in this report should preserve the shape: `catch { docs = docs.filter((d) => !d.source_document_id); }` and `catch { readable = new Set(); }`. Do not refactor these into a shared helper that can throw past the boundary. |
| The in-scope / out-of-scope distinction in auditDrawingRefs is the single best judgement call in this subsystem. It refuses to call a connector into an un-loaded unit 'broken', groups those by series so the ask is 'load these', and reserves findings for the two things that are actually actionable. | `lib/drawingText.ts:390-421, 500-514` | An audit that cries wolf about battery-limit connectors is an audit nobody runs twice. The reasoning is documented in the type's own comments ('Calling it broken is worse than saying nothing — it manufactures alarm about drawings that are probably perfect'). Whatever is done about the OPC starvation must not reach this by loosening it. |
| resolveDoc refuses to guess. An exact match wins; otherwise a UNIQUE same-series sheet with a matching number; ambiguity returns 'multi' (present, but no single link) or null — never an invented connection. And `exact` tracks a Set of owners rather than last-write-wins, because every sheet of a set carries the set's base number. | `lib/drawingText.ts:446-475` | This is where a cross-sheet audit normally goes wrong, and it is handled deliberately. auditOpcBoxes applies the same rule (`if (!owners \|\| owners.size !== 1) continue;`, drawingText.ts:725). Preserve both. |
| pageNeedsVision's thin-page reasoning — a page under 1200 characters that yielded only one tag is a TrueType title block on an SHX drawing, not a working text layer — with the failure written out in full in the code. | `lib/drawingText.ts:609-636` | It is a correct, specific, hard-won diagnosis of the single most common real-world drawing-PDF pathology, and the constants (TEXTLESS_PAGE_MAX_CHARS=60, MIN_TAGS_THIN_PAGE=3) are reasoned rather than arbitrary. The 2000-character SPARSE_PAGE_MAX_CHARS gate should be brought UP to this standard, not this brought down. |
| The per-sheet fact table: characters extracted, tags found, vision pages, declared title-block number, unread page list, and a verdict per sheet (vision / text / text-no-tags / empty / error), sorted naturally. | `app/api/knowledge/drawing/route.ts:267-325; components/knowledge/DrawingIntelPanel.tsx:380-412` | This turns 'the library isn't working' from an argument into a lookup, and the gapPages field specifically diagnoses an interrupted vision rebuild — a failure that otherwise surfaces far away as an unexplained missing tag. It is the right instrument; it just needs the row caps behind it to stop lying. |
| lib/pidTrace.ts is a clean, fully-tested pure BFS, and its single caller labels its own basis honestly: 'Derived from equipment appearing together on the same drawing page... This is sheet-level connectivity, not valve-by-valve line tracing.' The maxHops exhaustion case is reported as distinct from 'not connected'. | `lib/pidTrace.ts:104-180; lib/orchestrator/tools.ts:296-312` | The pixel line-tracer was retired for being unreliable (20261007_retire_line_traces.sql), and what replaced it does not pretend otherwise. This is the honesty standard the position layer currently fails to meet — pidTrace says what it is; pos_source:'text' does not. |
| lib/__tests__/entityKindGuard.test.ts — a repo-walking tripwire that forces every bulk read of knowledge_page_entities to name its kinds, with each exemption written out as prose and a self-test that the guard still catches an unfiltered read. | `lib/__tests__/entityKindGuard.test.ts:1-80` | The right mechanism for a hazard that produces no error, only a quieter number. It needs its exemptions re-keyed per-read (see the finding), and the same pattern extended to row-cap saturation — but the pattern itself is worth copying, not replacing. |
| The layered insert fallbacks in ingest: a schema mismatch on nx/ny/pos_source retries without those columns; a CHECK violation on kind retries with core kinds only; a statement timeout halves the batch. Each carries the incident that caused it. | `lib/knowledgeIngest.ts:403-428, 352-390` | These encode real production failures (the kind CHECK once wiped a tag index and wrote nothing back — that is why 20260925 exists). The one thing to change is the `if (entityRows.length > 0)` guard wrapping the DELETE, not the fallbacks themselves. |


---


<a id="dwg-1"></a>

## DWG-1 · A rev-up leaves the entire old-revision tag index in place, and the audit then files a verdict under the NEW revision code

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeSourceSync.ts:239-263`, `lib/knowledgeIngest.ts:399-429`, `app/api/knowledge/drawing/route.ts:414-433`, `app/api/knowledge/drawing/route.ts:368`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The chain holds end to end. The stale index also defeats the 'skipped' safety valve: route.ts:434 `indexed: d.status === "ready" && withEntities.has(d.id)` is satisfied by the surviving Rev-C rows plus the `status: done ? "ready" : "indexing"` write at knowledgeIngest.ts:432, so drawingAuditLog.ts:101-104 files `passed`/`flagged` rather than `skipped` — under Rev D.

**Mechanism.** On rev-up the sync deliberately keeps the `knowledge_documents` row ("The knowledge doc id is stable so past citations keep linking", knowledgeSourceSync.ts:241) and deletes ONLY `knowledge_chunks` (line 242-243). It never touches `knowledge_page_entities`. Because the row survives, the `ON DELETE CASCADE` on `knowledge_page_entities.document_id` never fires either.

Two differently-shaped searches confirm there is no other cleanup: a grep for `knowledge_page_entities` combined with delete/cascade across all .ts and .sql returns exactly ONE production delete — `app/api/knowledge/drawing/route.ts:368`, the manual admin-only "Rebuild index" — plus the page-range delete inside ingest.

That ingest delete is the trap. knowledgeIngest.ts:399 wraps BOTH the delete and the insert in `if (entityRows.length > 0)`. So a re-ingest that extracts nothing (SHX sheets with no AI key, vision budget exhausted, a provider error, `isDrawingLikePage` refusing the page) never clears anything, and the whole previous revision's equipment tags, refs, self-declarations and cached vision positions remain as the current revision's index. Even a successful re-ingest only clears `gte(from+1).lte(reached)` — a new revision with FEWER pages leaves the old revision's entities on the trailing pages forever.

Then `recordAudit` files the verdict against `documents.rev` — the CURRENT controlled revision (route.ts:417-419, 431) — while `knowledge_documents.source_rev`, which records the revision that was actually indexed (set at knowledgeSourceSync.ts:259), sits unused.

**Failure scenario.** P&ID 025-PID-0104 is at Rev C, indexed, audited clean. Engineering publishes Rev D, which deletes V-1402 and re-routes a connector. Sync fires: chunks dropped, status 'stale', entities untouched. The re-index runs on a day the org's AI key is missing, so every SHX page produces zero entities, `entityRows.length === 0`, and the delete is skipped. Doc Control opens Drawing intelligence, sees the census (Rev C's tags), and clicks "Record audit". `drawing_audit_logs` gets a row: sheet_number 025-PID-0104, revision_code "D", status "passed" — a permanent PSM record certifying that Rev D's connectors were checked, computed entirely from Rev C's extraction. `check_audit_history` (lib/orchestrator/tools.ts:258-285) then tells the next engineer "Already audited at this revision. Skip it unless the drawing has been revised since."

**Evidence.**

```
lib/knowledgeSourceSync.ts:242-243 — `const { error: chunkErr } = await supabaseAdmin.from("knowledge_chunks").delete().eq("document_id", existing.id as string);` (no equivalent for knowledge_page_entities)
lib/knowledgeIngest.ts:399-402 — `if (entityRows.length > 0) { await supabaseAdmin.from("knowledge_page_entities").delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", reached).then(() => undefined, () => undefined);`
app/api/knowledge/drawing/route.ts:417-419 — `.from("documents").select("id, rev").eq("org_id", orgId).in("id", mirrored);`
app/api/knowledge/drawing/route.ts:431 — `revision: d.source_document_id ? (revById.get(d.source_document_id) ?? "") : "",`
lib/knowledgeSourceSync.ts:259 — `source_rev: version.revision_label,` (the honest value, never read by the audit)
```

> **Verifier correction.** The claim that source_rev 'sits unused' is FALSE and should be dropped: knowledge_documents.source_rev is read at lib/knowledge.ts:337 (`sourceRev: (r.source_rev as string | null) ?? null`) and consumed by lib/linkProposerServer.ts:420 (`source_rev: d.sourceRev ?? null`). It is unused BY THE AUDIT, which is the real point. Severity lowered to HIGH: in the normal path (a re-ingest that does extract something) the overlapping page range IS cleared, so the stale-index case needs a second condition — no AI key on SHX sheets, exhausted vision budget, provider error, or a shorter revision.

**Done when.**

- [ ] knowledgeSourceSync's refresh branch deletes `knowledge_page_entities` for the document alongside `knowledge_chunks`, and treats a failure there the same way it treats `chunkErr` (skip the refresh, report it)
- [ ] The entity delete in knowledgeIngest moves OUTSIDE the `entityRows.length > 0` guard, and stops swallowing its own error
- [ ] `recordAudit` reads the revision from `knowledge_documents.source_rev` (what was indexed), not `documents.rev` (what is current), and refuses to record when the two disagree
- [ ] A sheet whose `source_version_id` differs from the controlled doc's `current_version_id` is reported as 'skipped' with a reason, never 'passed'

**Partial (2026-09-30, intelligence Round G).** Criteria 1 and 2 landed with ING-3, and both were reproduced first against the pre-fix code. A re-read that extracted nothing left both old entity rows and still stamped the document `ready`.

- **The refresh.** `lib/knowledgeSourceSync.ts` drops the document's page entities, machine mentions and cached traces through `resetKnowledgeIndex` (`lib/knowledgeIngest.ts`). Every failed purge is reported in the sync's errors, as `chunkErr` was, and none is lost:
  - A trace purge that fails runs before the row moves. The refresh is skipped, the row keeps the old version, and the library is marked never-synced, so the next run repeats it first.
  - A chunk, entity or mention purge that fails runs after the row is queued at the new revision (ING-3's order, so an interrupted reset never leaves a `ready` row with no chunks). The re-index's first batch clears every chunk and entity row of the document before it writes.
- **The ingest.** In `ingestKnowledgeDocBatch` the entity range clear moved OUTSIDE the `entityRows.length > 0` guard and no longer swallows its own error. A missing table skips the tag layer; any other failure stops the batch before `pages_indexed` moves.

Tests: `lib/__tests__/ingestLock.test.ts` ("a re-read that extracts nothing still clears the range's old entities", "a failed range clear stops the batch before pages_indexed moves", "a new index generation's first batch clears everything the last one left…"), and `lib/__tests__/sourceSync.test.ts` ("the row is queued BEFORE the index is deleted…", "a purge that fails before the row moves leaves the old version…").

**Done-when.**
- ✓ The refresh deletes `knowledge_page_entities` alongside `knowledge_chunks`. A failure is reported like `chunkErr`, and the entities it leaves are cleared by the re-index's first batch.
- ✓ The entity delete runs outside the `entityRows.length > 0` guard and its error is checked.
- ✗ Not done here. `recordAudit` should read the revision from `knowledge_documents.source_rev` and refuse to record when that disagrees with the current revision. That code is in `app/api/knowledge/drawing/route.ts` and `lib/drawingAuditLog.ts`, which are I-07's files (DWG-6 / DWG-13 key the verdict by revision).
- ✗ Not done here. A sheet whose `source_version_id` differs from the controlled document's `current_version_id` is not yet reported as `skipped`. That is the same file, handed to I-07.

**Scope / residual.** With criteria 1 and 2 in place, a rev-up no longer leaves Rev C's tags under Rev D. The audit therefore reads the current revision's extraction, or none if the sheet is still re-indexing. But the revision it FILES is still `documents.rev`. OPEN until I-07 lands criteria 3 and 4.

**Resolution (2026-10-01, intelligence Round G).** Criteria 3 and 4, handed over by I-06's Partial above, landed with I-07 in `app/api/knowledge/drawing/route.ts` `recordAudit`. With criteria 1 and 2 from I-06, all four hold.

- **The revision filed is the one indexed.** For a mirror, the route reads `knowledge_documents.source_version_id` and `source_rev`, and the controlled document's `current_version_id` and `rev`. It files `source_rev`, falling back to `documents.rev` only when the mirror carries no label.
- **An older index is skipped, with the reason.** When the mirror's `source_version_id` is not the controlled document's `current_version_id`, nothing is written for that sheet. The response lists it under `notRecorded` with `status: 'skipped'` and the reason ("the index was read from an earlier version (C) than the controlled document's current one (D) — re-index it first").
- **Disagreeing labels are refused.** When the indexed label and the controlled `rev` disagree (case and surrounding space aside), the sheet is refused in the same way.
- **The lens never trusts a half-read sheet.** A sheet that is not `ready`, or is parked on a vision retry or a failed batch's back-off (DEC-58), is `indexed: false`, so its verdict is `skipped`, never `passed`.

Reproduced first (DEC-29): against the base route, the test below files the verdict under the current `rev` and lists nothing as skipped.

Tests: `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-1 (criteria 3 and 4, handed over by I-06)": "a mirror indexed from an older version is reported skipped with the reason and NOT recorded" and "an indexed label that disagrees with the controlled document's is refused; a match files source_rev".

**Done-when.**
- ✓ The refresh deletes `knowledge_page_entities` alongside `knowledge_chunks` (I-06, above).
- ✓ The ingest entity delete runs outside the guard and is checked (I-06, above).
- ✓ `recordAudit` reads the revision from `knowledge_documents.source_rev` and refuses to record when it disagrees with the controlled document's.
- ✓ A sheet whose `source_version_id` differs from the controlled document's `current_version_id` is reported `skipped` with a reason, never `passed`, and nothing is written for it.

**Scope / residual.** The record is now keyed per library as well (DWG-6, `20261124`), and an unrevised sheet is not re-audited (DWG-13); a sheet whose revision is unknown (`""`) always is. Recording no longer waits for `20261124` (corrected in the second review fix pass): without it the route records on the org-wide key that database has, never lowering a verdict another library recorded (see DWG-6; review fix pass 3 corrected "never lowering a stored verdict", since the library's own unknown-revision row takes its latest verdict, as on the scoped key).

**Review fix pass (2026-10-01, intelligence Round G).** "The lens never trusts a half-read sheet" did not hold for an ACCEPTED partial index: a controller's accepted document is `ready`, so it counted as indexed and could be recorded `passed` with pages AI vision never read. Now `recordAudit` files a finding for every sheet whose `vision_failed_pages` is not empty ("Page(s) 5, 6 were never read by AI vision (partial index accepted) — nothing on them was audited"), through the new `unreadPages` input of `verdictsForSheets` (`lib/drawingAuditLog.ts`). Such a sheet is `flagged`, never `passed` and never `broken_connectors`. Tests: `lib/__tests__/drawingAuditLog.test.ts` "unread pages keep a sheet from passing (an accepted partial index)", `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "an accepted partial index is never recorded passed: the unread pages are a finding (fix pass)". Both fail against the round's first commit.

**Review fix pass 4 (2026-10-01, intelligence Round G).** The finding above said "(partial index accepted)" for every sheet with `vision_failed_pages`, including a sheet parked waiting on AI vision that nobody accepted. That false text went onto its recorded `skipped` row and into the response. Each `unreadPages` entry now carries why its pages are unread (`why`, read by `verdictsForSheets` in `lib/drawingAuditLog.ts`). It says "partial index accepted" only for a `ready`, unparked document with `vision_partial_accepted`, "waiting on AI vision" for a parked one, and "its indexing failed" for a failed one. Tests:
- `lib/__tests__/drawingAuditLog.test.ts` "says whose decision left them unread: 'accepted' only for an accepted partial index".
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a box on a parked neighbour's unread page is unpaired …". It asserts that 0105's `skipped` row and its response findings say "waiting on AI vision", never "accepted".

Both fail against fix pass 3 (`f41a1a8`).

---

<a id="dwg-2"></a>

## DWG-2 · Every pipe line number on a P&ID mints a phantom piece of equipment — and the vision prompt explicitly asks the model to transcribe them

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/drawingText.ts:63-85`, `lib/knowledgeVision.ts:36-37`, `lib/equipmentBridgeServer.ts:65-78`, `lib/equipmentBridgeServer.ts:200-222`, `components/knowledge/DrawingIntelPanel.tsx:132`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Searched drawingText.ts / knowledgeIngest.ts / equipmentBridgeServer.ts for any line-number recognizer or suppression and found none (the sole 'line number' mention, drawingText.ts:617, is about SHX geometry). Downstream the phantoms become real asset rows: equipmentBridgeServer.ts:200-216 inserts them with `origin: "drawing"` unless `bridge?.createAssets === false`, under the DrawingIntelPanel.tsx:132 caption "counts you can trust, not AI guesses".

**Mechanism.** `EQUIPMENT_RE = /\b([A-Z]{1,3})[-–](\d{1,5})([A-Z]{1,2})?\b/g` with one false-positive guard: skip when a digit-dash precedes the prefix (drawingText.ts:81), which catches drawing numbers like `2002-D-2001`. There is no guard for the OTHER thing on a P&ID shaped exactly like a tag: the pipe line number, `<size>"-<service>-<number>-<spec>`.

I executed the extractor's exact logic against real line-number formats:

    '6"-P-1024-A1A'        -> ["P-1024"]      (categorized "Pumps")
    '2"-CWS-101-B2'        -> ["CWS-101"]     (unknown prefix)
    '10"-HC-15003-A1A-HC'  -> ["HC-15003"]
    'FROM 8"-P-2201-C1'    -> ["P-2201"]
    'LINE 12"-S-4410-D1'   -> ["S-4410"]      ("Separators / Strainers")

The inch mark (`"`) is not a digit, so line 81's guard never fires.

This is not incidental: VISION_SYSTEM at knowledgeVision.ts:36-37 instructs the model to transcribe "every equipment tag, line number, valve tag, instrument bubble (V-3, P-101A, PSV-2001, 6\"-P-1024-A1A) exactly as written" — the exact poison string, requested by name. And drawingText.test.ts:357 asserts `parseOpcBoxes("6\"-P-1024-A1A TO V-3")` returns `[]`, so the authors had that string in hand and guarded the OPC parser against it while leaving the equipment parser open.

**Failure scenario.** A vision-indexed P&ID with 60 line numbers and 12 real vessels produces ~72 'equipment' entities. The census reports 72 distinct tags under a panel that says "Computed from every sheet's extracted tags — counts you can trust, not AI guesses" (DrawingIntelPanel.tsx:132). The CSV register exports the phantoms as equipment with categories. Then the Bridge picks them up — `equipmentBridgeServer.ts:65-70` reads exactly `kind = 'equipment'` — decodes a unit from the drawing number, and with `createAssets` defaulting on (`if (bridge?.createAssets !== false)`, line 200) writes them into the equipment registry as DISCOVERED assets with `origin: 'drawing'` and `discovered_from: { documentId, pages }`. The plant's equipment registry — a PSM-relevant record — fills with pumps that are pipe runs. `splitTag(norm)` at line 74 is the only filter, and `P-1024` is a perfectly well-formed tag, so it passes.

**Evidence.**

```
lib/drawingText.ts:63 — `const EQUIPMENT_RE = /\b([A-Z]{1,3})[-–](\d{1,5})([A-Z]{1,2})?\b/g;`
lib/drawingText.ts:80-81 — `const at = m.index ?? 0; if (at >= 2 && /[-–]/.test(upper[at - 1]) && /\d/.test(upper[at - 2])) continue;`
lib/knowledgeVision.ts:36-37 — `"- every equipment tag, line number, valve tag, instrument bubble (V-3, P-101A, PSV-2001, " + "6\"-P-1024-A1A) exactly as written;"`
lib/equipmentBridgeServer.ts:66-70 — `.from("knowledge_page_entities").select("tag, page, kind").eq("document_id", kdoc.id).eq("kind", "equipment").limit(4000);`
lib/equipmentBridgeServer.ts:200 — `if (bridge?.createAssets !== false) {`
lib/__tests__/drawingText.test.ts:357 — `expect(parseOpcBoxes("6\"-P-1024-A1A TO V-3")).toEqual([]);`
Executed: node script reproducing extractEquipmentTags' exact logic over the nine cases above.
```

> **Verifier correction.** Overstated on the asset-minting half. applyForDocument throws at equipmentBridgeServer.ts:186-188 unless `bridge.targetColumnKey` is mapped, and it is only reached from the review UI or from the `bridge?.autoApply && bridge.targetColumnKey` branch at :126. So phantom ASSETS are CONFIRMED only for auto-apply libraries; elsewhere a human sees them as assetStatus:'new' first. What is unconditional — and still HIGH — is pollution of the equipment census, the CSV register, unknownPrefixes ('CWS', 'HC' become 'teach me your decoder' noise) and the bridge suggestion list.

**Done when.**

- [ ] `extractEquipmentTags` rejects a match preceded by an inch mark or a size fraction — the same shape of guard as line 81, extended to `"`, `''`, `IN`, and `<digit>/<digit>"`
- [ ] A line number is classified as its own entity kind ('line') rather than discarded, so `6"-P-1024-A1A` becomes useful data instead of a phantom pump
- [ ] Tests pin every case in the executed list, plus the positive cases (`V-3`, `P-101A`) that must keep matching
- [ ] The Bridge does not create registry assets from a tag whose only evidence is a line-number-shaped occurrence

**Partial (2026-10-01, intelligence Round G).** Reproduced first (DEC-29) by running the base extractor over the finding's list: `6"-P-1024-A1A` gave `["P-1024"]`, and so on for every case. What landed:

- **The guard.** `extractEquipmentTags` (`lib/drawingText.ts`) skips a match that is part of a pipe line number (`isLineNumberContext`). A line size is a whole number, a fraction, or a whole-and-fraction (`6`, `3/4`, `1-1/2`, `1 1/2`, `.75`) followed by an inch mark (`"`, `''`, `”`, `″`) or `IN`/`INCH`. The size makes the token a line number when it is GLUED to it by a dash (`6"-P-1024`, `6 IN-P-1024`), or, when only a space (or nothing) stands between, when the token goes on to carry a line spec segment (`6" P-1024-A1A`). `LINE NO.` / `LINE #` always introduces a line; a bare `LINE` word does only with the spec segment after it. A metric size (`150-P-1024`, `DN150-P-1024`) ends in a digit-dash and was already caught by the drawing-number guard. (Corrected in the review fix pass below: the guard first rejected every tag after any size.)
- **One grammar.** `extractLineNumbers` returns whole line numbers, normalised (`6"-P-1024-A1A`), by the SAME size grammar. The guard and the line grammar therefore cannot disagree about what a line number is.
- **The prompt.** `VISION_SYSTEM` (`lib/knowledgeVision.ts`) no longer lists `6"-P-1024-A1A` among the "equipment tag, line number, valve tag, instrument bubble" examples. It asks for every line number on its own line, labelled `LINE`, and says a line number is never an equipment tag.

Tests:
- `lib/__tests__/drawingText.test.ts`, block "DWG-2 — a pipe line number is never equipment", five cases. They cover every executed case, every size form, the `LINE` label, the positives (`V-3`, `P-101A`, a tag next to a line number, a tag after a dimension that is not a line size) and `extractLineNumbers`.
- `lib/__tests__/intelRoundGDrawing.test.ts` "yields equipment tags and a title-block identity past 2,000 characters — and no phantom pumps from line numbers". This one runs the real ingest over a real PDF: 40 line numbers `6"-P-10xx-A1A` and no `P-10xx` equipment row. It fails against the base extractor.

**Done-when.**
- ✓ `extractEquipmentTags` rejects a match preceded by an inch mark or a size fraction (`"`, `''`, `IN`, `<digit>/<digit>"`, and `”`/`″`/`INCH`) when the size is a line number's — glued to the tag by a dash, or followed by a line spec — with the same shape of guard as the digit-dash one. A valve or instrument written with the size of its line (`2" PSV-2001`) is not rejected: the criterion's own target is the line number, and those are real tags.
- ✗ **Not done here.** A line number is not yet stored as its own entity kind `'line'`. That needs a call in `lib/knowledgeIngest.ts` (the ingest owner's file, I-06's design, not this package's), in the two per-line loops beside `extractEquipmentTags`. `extractLineNumbers` is the export for it, the grammar is pinned by test, and the extractor already keeps line numbers out of the equipment count. When that call lands, `ENTITY_KINDS` must gain `'line'`: `lib/__tests__/entityKindGuard.test.ts` now holds the kind inventory to the ingest both ways (ING-5), so it fails until it does. The decision's default (DEC-59, item 4) still stands: extract them as `'line'`, never drop them.
- ✓ Tests pin every case in the executed list, plus the positive cases.
- ✓ The Bridge creates no registry asset from a line-number occurrence. The Bridge reads `kind = 'equipment'` only (`lib/equipmentBridgeServer.ts`), and no equipment row is written for a line number any more, on the text-layer path or the vision path.

**Scope / residual.** Equipment rows already minted from line numbers stay until each document's next re-index. `20261124`'s inventory counts them ("equipment rows whose evidence line reads as a pipe line number"), by the same two joints. OPEN until the ingest owner writes `'line'` rows.

**Review fix pass (2026-10-01, intelligence Round G).** The first guard over-reached. `LINE_SIZE_BEFORE_RE` allowed whitespace and made the dash optional, so every tag written after an inch size was dropped: `2" PSV-2001`, `4" FCV-101`, `6" SDV-1001`, `3"x4" PSV-101`, `1-1/2" PSV-12`, `3/4" TW-12`, `2"PSV-2001`, `NPS 2 IN PSV-101`, `2" V-1 DRAIN`, and the bare-`LINE` guard dropped `SUCTION LINE P-101A`. The base extracted all of them, so the census, the CSV register and the Bridge silently lost PSM-critical valves. Now:
- **The joint decides.** A size counts as a line number's only when the dash is glued to it (`LINE_SIZE_DASH_BEFORE_RE`), or when a space-separated size is followed by a token that carries a line spec segment of two or more characters (`LINE_SIZE_SPACE_BEFORE_RE` + `LINE_SPEC_AFTER_RE`; `PSV-2001-A`, a one-letter suffix, stays a tag). The `LINE` label is held to `LINE NO.` / `LINE #`, or a bare `LINE` with the spec segment after it.
- **Still one grammar.** `extractLineNumbers` uses the same two joints (`LINE_NUMBER_RE`), so whatever it calls a line, `extractEquipmentTags` never counts, and the reverse.
- **The inventory agrees.** `20261124`'s phantom-row count uses the same two joints. A test runs the SQL regex and the extractor over the same lines and asserts they agree.

Tests: `lib/__tests__/drawingText.test.ts` "a valve or instrument written with the size of its line is still a tag (fix pass)" (all twelve cases above, each also absent from `extractLineNumbers`) and the `LINE` label cases; `lib/__tests__/intelRoundGDrawingMigration.test.ts` "the DWG-2 phantom count uses the extractor's own line grammar — a size-annotated valve is not a phantom (fix pass)". The first fails against the round's first commit. Every case in the finding's list still yields no tag.

---

<a id="dwg-3"></a>

## DWG-3 · Text-layer tag positions ignore /Rotate, CropBox origin and /UserUnit — and are the ones the viewer draws as EXACT

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:236-240`, `components/knowledge/CitedPageViewer.tsx:504-512`, `node_modules/pdfjs-dist/build/pdf.mjs:14431-14447`, `node_modules/pdfjs-dist/build/pdf.mjs:1238,1277-1292`, `fixtures/PID-Legend.pdf`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Core defect confirmed on a fixture that ships in this repo. Two caveats on the framing, neither fatal: (a) /UserUnit is immaterial here — pdf.js ignores it on both sides, and since nx/ny are ratios any uniform scale cancels, so only /Rotate and a non-zero CropBox origin actually shift the mark; (b) the node_modules/pdfjs-dist/build/pdf.mjs line citations cannot be checked in this tree — dependencies are not installed and pdfjs-dist is not a declared dependency (package.json pulls it transitively via `unpdf`).

**Mechanism.** Ingest normalizes every text-layer tag with:

    const view = page.getViewport({ scale: 1 });
    const norm = (x, y) => ({ nx: clamp01(x / view.width), ny: clamp01(1 - y / view.height) });
    ... const x = item.transform?.[4] ?? null; const y = item.transform?.[5] ?? null;

`item.transform[4],[5]` are in UNROTATED PDF user space. `getViewport` is not: pdf.mjs:14433 defaults `rotation = this.rotate`, and PageViewport (pdf.mjs:1277-1292) swaps width/height for 90/270 (`width = (viewBox[3]-viewBox[1]) * scale`), point-reflects for 180 (rotateA=-1), multiplies by `/UserUnit` (pdf.mjs:1238 `scale *= userUnit`), and offsets by the viewBox origin. None of that is applied. `clamp01` then hides the overflow by pinning wrong values to 0 or 1 instead of failing.

The library already ships the correct call — `viewport.convertToViewportPoint(x, y)` (pdf.mjs:1321) — and it is not used.

The result is stored with `pos_source: nx === null ? null : "text"` (knowledgeIngest.ts:251,258), and CitedPageViewer.tsx:504 computes `const approx = m.source !== "text"`, so the text path gets the TIGHT yellow swipe (`w-14 h-4`, no dashed tolerance box) while only vision gets the honest "~" and the dashed box. The one path presented as measured is the one that can be silently, systematically wrong.

**Failure scenario.** Arithmetic on a fixture that ships in this repo. `fixtures/PID-Legend.pdf`: `/Rotate 180`, view [0,0,1224,792], viewport 1224x792, text items at x 72..837, y 709..767 (measured by running unpdf against it).

- Ingest stores: nx = 72/1224 = 0.059, ny = 1 - 767/792 = 0.032 → UPPER-LEFT.
- Correct: rotation 180 gives transform [-1,0,0,1,1224,0], so the viewport point is (1224-72, 767) = (1152, 767) → nx = 0.941, ny = 0.968 → LOWER-RIGHT.

Every marker on that sheet lands in the exact opposite corner, drawn as the confident yellow "this text" swipe. On a 34-inch E-size sheet that is three feet of paper in the wrong direction, with no caveat on screen. For 90/270 sheets (landscape AutoCAD plots) the axes are swapped as well as scaled, so tags pile against the clamped edges.

**Evidence.**

```
lib/knowledgeIngest.ts:236-240 — `const view = page.getViewport({ scale: 1 }); const norm = (x, y) => x === null || y === null || !view.width || !view.height ? { nx: null, ny: null } : { nx: clamp01(x / view.width), ny: clamp01(1 - y / view.height) };`
node_modules/pdfjs-dist/build/pdf.mjs:14431-14433 — `getViewport({ scale, rotation = this.rotate, ...`
node_modules/pdfjs-dist/build/pdf.mjs:1279-1284 — `if (rotateA === 0) { ... width = (viewBox[3] - viewBox[1]) * scale; height = (viewBox[2] - viewBox[0]) * scale; }`
components/knowledge/CitedPageViewer.tsx:504 — `const approx = m.source !== "text";`
components/knowledge/CitedPageViewer.tsx:512 — `style={{ left: `${m.nx * 100}%`, top: `${m.ny * 100}%` }}`
Measured: `page.rotate=180 view=[0,0,1224,792] vp=1224x792 chars=209 items=21 / x range 72..837 y range 709..767`
```

> **Verifier correction.** Two citation nits: the `const approx = m.source !== "text";` line is CitedPageViewer.tsx:508, not :504 (:512 is exact). Severity lowered to HIGH: this misplaces a helper overlay on a sheet the engineer is looking at, it does not corrupt a controlled record or leak access; and the error is only gross on rotated/offset-viewBox/UserUnit pages (rotate=0, origin-0, userUnit=1 sheets — e.g. the other fixture, measured rotate=0 — land approximately right, off only by the baseline-origin-vs-center offset).

**Done when.**

- [ ] `norm()` routes through `viewport.convertToViewportPoint(x, y)` and divides by `viewport.width/height`, so rotation, viewBox origin and userUnit are all handled by the library that owns them
- [ ] A test renders each of /Rotate 0, 90, 180, 270 with a known glyph position and asserts nx/ny land in the correct quadrant
- [ ] `clamp01` is replaced by a reject-and-null (a coordinate outside 0..1 is a bug signal, not a value to pin to an edge)
- [ ] Existing `pos_source='text'` rows on rotated pages are invalidated rather than left in place, since they are cached wrong answers

**Pointer (2026-09-30, intelligence Round G, I-06): the ingest half.** The fleet plan gives this finding to I-07, and I-06 records the ingest half here. No status change: DWG-3 stays OPEN for I-07.
- **Where it is.** The normalisation the finding quotes is `norm()` in `lib/knowledgeIngest.ts` `ingestKnowledgeDocBatch`, in the drawing-entity block of `readPage`. It is now at lines 1236-1240; at the base it was 236-240. I-06 did not change it. The `getViewport({ scale: 1 })` divide, `clamp01` and the stored `pos_source: 'text'` are exactly as described above, and I-06's engine changes (the claim, the retry queue, the failure retry) do not touch that block.
- **Where the plan fixes it.** In the plan, I-07 corrects the marks in `components/knowledge/CitedPageViewer.tsx`, computing from page metadata (/Rotate, the CropBox origin). Stored `nx`/`ny` then stay in the page's unrotated user space, and the viewer applies the transform. Criterion 2 (a quadrant test per rotation) belongs with that code.
- **What the viewer cannot recover.** `norm()` divides by the ROTATED viewport's size. On a 90/270 page that is the unrotated height for x and width for y, so on a landscape sheet a stored value past 1 was clamped to the edge. So was a value pushed below 0 by a CropBox origin. Those marks are lost, not merely transformed. A viewer-side transform recovers every mark on a 0/180 page with a zero origin, but not every mark on a 90/270 page or a page with an offset origin. Those need ingest's divisor fixed and the documents re-indexed.
- **If ingest is changed instead** (criterion 1, `viewport.convertToViewportPoint`): the change is confined to `norm()` and the two `nx`/`ny` pushes below it, and criterion 3 (reject and null rather than `clamp01`) goes with it. Rows already stored on rotated pages would then be wrong by construction (criterion 4). The way to re-derive them is to re-index those documents through `resetKnowledgeIndex` (DEC-58), which drops every page entity and re-reads from page 1. Note that this re-bills their AI-vision pages. The two fixes must not both apply, or the viewer would rotate coordinates that ingest had already rotated.

**Partial (2026-10-01, intelligence Round G).** The viewer half, as the fleet plan placed it. Reproduced first (DEC-29) on real PDFs through the real ingest. On a `/Rotate 180` sheet the stored `nx`/`ny` of a lower-left glyph point at the upper-left; on 90/270 the axes are swapped. The test asserts the raw stored value is off by more than 0.1 on every rotated page.

What landed:
- **The mapping.** `textMarkPosition(nx, ny, geometry)` (`lib/drawingLocate.ts`) mirrors pdf.js's `PageViewport` transform at scale 1. The geometry is `/Rotate`, the view box (CropBox) and `/UserUnit`. The function recovers the user-space point ingest saw (ingest's divisor WAS that viewport's size) and maps it to where pdf.js draws it.
- **The viewer uses it.** `components/knowledge/CitedPageViewer.tsx` captures the page's geometry from react-pdf's `onLoadSuccess` and draws every `pos_source = 'text'` mark through `textMarkPosition`. A mark that cannot be placed is not drawn, and the viewer says how many were left out ("cut off when it was indexed … not drawn rather than drawn in the wrong spot").
- **Plain pages are untouched.** On a page at rotation 0 with a zero origin and unit 1, a mark maps to itself exactly, so every mark that was right stays right.
- **No double rotation.** The contract is written at the function: it applies to `pos_source 'text'` only. An ingest that stores viewport fractions directly must use a different `pos_source`.

Tests: `lib/__tests__/intelRoundGDrawing.test.ts`, block "DWG-3":
- one case per `/Rotate` 0, 90, 180 and 270: the stored mark maps onto pdf.js's own `viewport.convertToViewportPoint` point to six decimals, in the expected quadrant;
- a CropBox not at the origin, and `/UserUnit 2` on a 90° page, both honoured;
- a value ingest's clamp pinned to an edge on a rotated page is refused.

`lib/__tests__/drawingLocate.test.ts` covers the plain-page identity, the PID-Legend arithmetic (72/1224 → 0.941, 0.968) and refusals.

**Done-when.**
- ✗ **Not done here**, by the plan. Ingest's `norm()` (`lib/knowledgeIngest.ts`, I-06's file) still divides by the rotated viewport. The viewer applies `convertToViewportPoint`'s transform at display instead, proven equal to it for all four rotations, a CropBox offset and a UserUnit. Fixing ingest itself is the ingest owner's change. It must write a new `pos_source`, and its old rows must be re-derived through `resetKnowledgeIndex`, which re-bills vision pages (see I-06's pointer above).
- ✓ A test renders each of `/Rotate` 0, 90, 180 and 270 with a known glyph position and asserts the mark lands in the correct quadrant, on pdf.js's own point.
- ✗ **Not done at ingest.** `clamp01` stays in ingest. At display, a value pinned to 0 or 1 on a page that is not plain is refused (null, not drawn), which is the reject-and-null the criterion asks for, on the viewer side.
- ✗ **Not done.** Existing `pos_source = 'text'` rows on rotated pages are not invalidated in the database: rotation is not stored per page, so SQL cannot find them. The viewer places every recoverable one correctly and refuses the rest. Re-deriving the refused ones needs ingest's divisor fixed and the documents re-indexed.

**Scope / residual.** On a 90/270 page, or a page whose CropBox origin is offset, marks whose true position fell outside ingest's rotated divisor were clamped at ingest and are lost. The viewer recovers every mark on a 0/180 page with a zero origin, and every unclamped mark elsewhere. OPEN until the ingest half lands (owner: the ingest file's owner, I-06's design).

---

<a id="dwg-4"></a>

## DWG-4 · The entire off-page-connector layer is fed by a token the vision prompt never asks for, so the audit's top-severity verdict cannot fire

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/drawingText.ts:285-298`, `lib/knowledgeVision.ts:33-53`, `lib/knowledgeIngest.ts:272-280`, `lib/drawingText.ts:697-748`, `app/api/knowledge/drawing/route.ts:253-258`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The claim is exactly right, and the smoking gun is the stale comment at drawingText.ts:288-289 describing a prompt contract that knowledgeVision.ts does not implement. The panel's reassuring "0 connector(s) with no drawing number" (drawing/route.ts:253-258) is therefore a report on an empty set, not a clean one.

**Mechanism.** `parseOpcBoxes` matches only the literal token OPC: `const OPC_BOX_RE = /\bOPC[\s#.:-]*(\d{1,4})\b/g;`. Its header states the contract explicitly: "The vision prompt asks for 'OPC <n>: …' lines, so transcripts carry them machine-readably" (drawingText.ts:289-290).

The vision prompt does not. Two differently-shaped searches — `grep -n "OPC" lib/knowledgeVision.ts` (case-sensitive) and `grep -ni "opc" lib/knowledgeVision.ts` — both return NONE. `grep -n "connector"` returns exactly one line, knowledgeVision.ts:38, which asks for "every off-page connector / continuation reference with its drawing number AND sheet number when one is shown, plus the direction or service it names (e.g. 'TO 025-PID-0107', 'CONT ON DWG 21-D-1105 SH 3')". No box number. No OPC label. No format the parser can match.

And `kind:"opc"` is written in exactly one place (knowledgeIngest.ts:276), fed exclusively by `parseOpcBoxes`. Real P&IDs print a pennant with a drawing number in it, not the three letters O-P-C, so the text-layer path produces nothing either.

Everything downstream is therefore structurally starved: `auditOpcBoxes` (drawingText.ts:697), `opcBoxCount` / `opcUnreturned` / `opcNoRef` in the panel, and — most seriously — `broken_connectors`, the highest-severity status in `drawing_audit_logs`, which is reachable ONLY from `findings.connectorsWithNoTarget` and `findings.unreturnedConnectors` (drawingAuditLog.ts:83-88), both sourced from `opc.noRef` / `opc.unreturned`.

**Failure scenario.** An engineer runs the drawing audit over a full unit's P&IDs specifically to find dangling off-page connectors. Every sheet comes back `passed` or `flagged` — never `broken_connectors` — and the panel shows "0 connector(s) with no drawing number". That reads as "the set is clean on connectors". It actually means the connector check has no input. The ask route reinforces the illusion by telling the model "BROKEN connectors — an OPC with NO drawing number is broken by definition" (app/api/knowledge/ask/route.ts:1095), describing a finding class the pipeline cannot produce.

**Evidence.**

```
lib/drawingText.ts:291 — `const OPC_BOX_RE = /\bOPC[\s#.:-]*(\d{1,4})\b/g;`
lib/drawingText.ts:289-290 — `// "OPC <n>: …" lines, so transcripts carry them machine-readably.`
lib/knowledgeVision.ts:38-40 — `"- every off-page connector / continuation reference with its drawing number AND sheet number " + "when one is shown, plus the direction or service it names (e.g. 'TO 025-PID-0107', 'CONT ON " + "DWG 21-D-1105 SH 3');"`
lib/drawingAuditLog.ts:83-88 — the only writers of `broken`: `for (const c of findings.connectorsWithNoTarget) push(broken, ...)` / `for (const c of findings.unreturnedConnectors) push(broken, ...)`
Searches: `grep -n "OPC" lib/knowledgeVision.ts` → NONE; `grep -ni "opc" lib/knowledgeVision.ts` → NONE
```

> **Verifier correction.** Extend, don't shrink: the starvation also reaches lib/linkProposerServer.ts:206-226, whose OPC-continuity link proposer reads `.in("kind", ["opc", "ref"])` and branches on `e.kind === "opc"` for the box number — so the 'Drawing cross-reference' proposer (linkProposals.ts:48) is starved by the same gap, not just the audit.

**Done when.**

- [ ] VISION_SYSTEM emits a labeled, parseable connector line — e.g. `OPC <box>: <direction> <service> -> <drawing no> SH <n>` — matching OPC_BOX_RE, with an example in the prompt
- [ ] A fixture transcript in lib/__tests__ round-trips prompt-shaped output through parseOpcBoxes + auditOpcBoxes and asserts a non-empty boxCount
- [ ] The text-layer path gets its own connector extraction (pennant text / 'CONT ON' phrasing) rather than depending on a token drawings do not print
- [ ] Until a connector can actually be read, the panel says 'connector pairing needs vision indexing' instead of showing a reassuring zero

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29). The base `parseOpcBoxes` returns `[]` for every connector phrasing the base prompt asked for (`TO 025-PID-0107`, `CONT ON DWG 21-D-1105 SH 3`). A real-ingest run of a vision transcript wrote no `opc` row. What landed:

- **One contract, owned by the parser.** `lib/drawingText.ts` declares the connector line: `OPC_LINE_FORMAT` = `OPC <box number>: DWG <destination drawing number> SH <sheet> — <TO|FROM> <service or equipment>`, with `OPC_LINE_EXAMPLE` = `OPC 14: DWG 2002-D-2001 SH 4 — TO V-1402 CRUDE OVERHEAD`, and `OPC_NO_DRAWING` = `NONE` for a connector that shows no drawing number. (The `DWG` label and the positional read were added in the review fix pass below.)
- **The prompt is built from it.** `VISION_SYSTEM` (`lib/knowledgeVision.ts`) imports those constants and asks for every off-page connector on its own line in exactly that form, destination drawing first. The prompt and its parser can no longer drift apart. The parser's old header comment described a prompt that did not exist; it is rewritten to say this.
- **The lens says when pairing has no input.** When no box number was read from a drawing set, `app/api/knowledge/drawing/route.ts` answers `opcPairing: "no-boxes"` with a suggestion: "Connector box pairing has no input here: box numbers are read only from AI-vision transcripts … Connectors are still audited through their drawing references". `components/knowledge/DrawingIntelPanel.tsx` shows "Connector box pairing has no input here" in place of an empty, reassuring result. (Reworded in the review fix pass: the first wording told every text-layer set to turn on every-page vision.)

Tests:
- `lib/__tests__/drawingText.test.ts`, block "DWG-4 — the connector line contract between the vision prompt and the parser":
  - the prompt's own example parses to box 14 and `2002-D-2001-SH4`;
  - a prompt-shaped transcript round-trips through `parseOpcBoxes` and `auditOpcBoxes` with `boxCount` 4, one unreturned box and one `NONE` connector reported broken;
  - the text layer's connectors extract as references and pair one-way;
  - the prompt imports the parser's constants.
- `lib/__tests__/intelRoundGDrawing.test.ts` "a labelled connector before the fenced title block … OPC lines land as connector rows": the real ingest writes `opc` rows 14 and 15 whose line carries `2002-D-2001 SH 4`. It fails against the base code.
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "box pairing with no box numbers says it has no input instead of showing a clean zero".

**Done-when.**
- ✓ `VISION_SYSTEM` emits a labelled, parseable connector line matching `OPC_BOX_RE`, with an example in the prompt.
- ✓ A fixture transcript round-trips prompt-shaped output through `parseOpcBoxes` and `auditOpcBoxes` and asserts a non-empty `boxCount` (4).
- ✗ **Not done — by decision (DEC-59, item 5).** No new text-layer connector extraction was built. What the text layer has is what it had at the base: `extractDrawingRefs` reads continuation phrasing and pennant drawing numbers (`CONT ON DWG 025-PID-0107`, `025-PID-0108 SH 2`) as `ref` rows, and the reference audit pairs them (one-way between loaded sheets, missing within a held series). This round's first record ticked the criterion on that existing layer, which overstated it. What the text layer cannot give is a BOX NUMBER, so box-to-box pairing stays fed by vision transcripts, and the lens says so (next criterion). Widening the box token to words a text layer might print (CONN, CONNECTOR) was rejected: every false box with no drawing number would mint a top-severity `broken_connectors` record.
- ✓ Until a connector can actually be read, the panel says box pairing has no input — box numbers come only from AI-vision transcripts — instead of showing a reassuring zero.

**Scope / residual.** Sheets indexed before this carry no `opc` rows until they are re-read with AI vision ("Rebuild index" with the library's vision option). DWG-8's truncation trap, which this contract makes live, is neutralised in the same change (see DWG-8). Text-layer connectors keep being audited through their references only (criterion 3, DEC-59 item 5).

**Review fix pass (2026-10-01, intelligence Round G).** The first contract made the top-severity verdict reachable, and also made it FALSE for most numbering schemes. It asked for the bare destination right after the colon (`OPC 7: 025-M-0107 SH 2 — …`), while `auditOpcBoxes` still called a connector broken when `extractDrawingRefs` read nothing from its line. That grammar reads the loose `NNN-X-NNNN` shape only after a context word, and never reads plain numeric or other shapes. `025-M-0107`, `21-A-1105`, `100-E-001`, `025-P-1001`, `4410-01-001`, `123456`, `D-2001` and `M-101` all came out as "names no destination drawing", which `Record audit` files as `broken_connectors`: a permanent PSM verdict, never re-audited at that revision. Now:
- **The destination is labelled.** `OPC_LINE_FORMAT` is `OPC <box number>: DWG <destination drawing number> SH <sheet> — …`, and `VISION_SYSTEM` asks for the number "exactly as written" after the word DWG, leaving out `SH <sheet>` when none is shown. The label gives the reference layer its strong context: a loose-shaped number on a connector line now lands as a `ref` row too (pinned through the real ingest: `OPC 16: DWG 025-M-0107 SH 2` writes ref `025-M-0107-SH2`).
- **The destination is read by position.** `parseOpcLine` (`lib/drawingText.ts`) reads a contract line's destination field (between `DWG` and `SH` or the dash) whatever its shape. `auditOpcBoxes` pairs boxes on that field, normalised and sheet-addressed when a sheet is named (`opcDestinationForms`), as well as on whatever `extractDrawingRefs` reads.
- **The no-boxes notice is a fact, not a purchase order.** The first suggestion told every set without box rows — every text-layer set — to turn on "index every page as an image" and rebuild, re-billing every page of a TrueType set to gain box pairing while its connectors were already audited through their references (against DEC-59 item 1 and the 99 do-not on vision-reading the whole set). It now states that pairing has no input and why. Only a set with sheets already read by AI vision is told that a rebuild re-reads those sheets with box numbers, and that it bills those pages again.
- **Broken means what the contract says.** A connector is `noRef` only when its field reads `NONE` or is empty, and nothing else on its line names a drawing. A field that holds something not shaped like a drawing number (`SEE NOTE 3`, `ILLEGIBLE`) is `unknown`, never broken. A line outside the contract with no readable reference is `unknown` when anything on it could still be a drawing number (three or more digits in a row once the box, equipment tags and a sheet number are set aside), and broken only when nothing could. A row with no stored line is `unknown`.

Tests: `lib/__tests__/drawingText.test.ts`, the DWG-4 block: "a destination in any numbering scheme is a destination — never 'names no drawing'" (the nine shapes above), "the DWG label gives the reference layer its context", "pairs by the positional destination, whatever its shape", "broken means what the contract says: the field reads NONE, or is empty", "a destination present but not shaped like a drawing number is unknown, never broken", "a line outside the contract: unknown when something on it could still be a drawing number, broken only when nothing could"; `lib/__tests__/intelRoundGDrawing.test.ts` (the real ingest writes the loose-shaped connector as a reference, and its stored lines audit with only the `NONE` box broken). Each new `drawingText` case fails against the round's first commit. The notice: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "box pairing with no box numbers says it has no input instead of showing a clean zero" (and never mentions every-page vision) and "a set already read by AI vision before the connector contract is told a rebuild re-reads its boxes — and re-bills".


**Review fix pass 2 (2026-10-01, intelligence Round G).** The first fix pass said "broken means what the contract says". Two paths still filed a correctly drafted connector as `broken_connectors`, both made live by switching the prompt on:
- **A target with no box numbers read.** A connector into a sheet with no `opc` rows at all was filed `unreturned`. That covers every connector into a text-layer sheet (a text layer prints a pennant, never the box token) and into a sheet vision-read before this contract. Mixed libraries are normal, so this fired routinely. `auditOpcBoxes` (`lib/drawingText.ts`) now judges `unreturned` only when the target's box numbers WERE read. Otherwise the connector goes to a new `unpaired` bucket: the pairing could not be checked. That is absence of evidence (DWG-8's principle). `verdictsForSheets` (`lib/drawingAuditLog.ts`) files it as `unpairedConnectors` ("Connector 14 continues to SH4.pdf, whose box numbers were never read — the pairing was not checked"). The sheet is `flagged`, never `broken_connectors`. The lens lists these separately (`opcUnpaired`, "not counted as broken"), and the panel has its own list.
- **A sheet-only connector.** "CONT ON SHEET 4" within one drawing was transcribed `OPC 14: DWG NONE SH 4`, as the first prompt told the model, and filed "names no destination drawing". `parseOpcLine` now reads a connector that names only a sheet as `sameDrawing`. That covers the new `SAME` token (`OPC_SAME_DRAWING`), and also `NONE` or an empty field followed by `SH n`. `auditOpcBoxes` pairs it against `<declared base>-SH<n>` of the source's own title block (`declaredSheetIdentity`), so it is never `noRef`. If the source declared no number, the connector is `unpaired`. `none` and `empty` now mean "no drawing number AND no sheet". `SAME` with no sheet is `unknown`.
- **The prompt.** `VISION_SYSTEM` (`lib/knowledgeVision.ts`) asks for `DWG SAME SH <n>` when the connector shows only a sheet, and for `NONE` only when it shows neither. It also says what to do with a pennant that shows no box number: write no OPC line, never make a number up, and transcribe it as `CONT ON DWG <number> SH <n>`. The reference audit reads that line (one-way, missing within a held series), so box pairing never sees an invented box.

Broken is now exactly: a connector that shows neither a drawing number nor a sheet, or a box whose continuation sheet's boxes were read and do not include it. (Corrected in review fix pass 3: this did not yet hold. A contract line was also paired against drawing numbers in its service tail; see below.)

Tests:
- `lib/__tests__/drawingText.test.ts`:
  - "a connector into a sheet with NO box numbers read is unpaired — never unreturned, never broken";
  - "a connector naming only a sheet continues within its own drawing — paired there, never broken" (`SAME`, `NONE SH 4` and an empty field with a sheet; paired, unreturned or unpaired by the target's boxes; an undeclared source is unpaired; `SAME` with no sheet is unknown);
  - "the prompt says how to write a sheet-only connector, and never to invent a box number".
  - The three tests that pinned the false positive (the round-trip's SH5 with no boxes, the positional pairing, and a readable reference outside the contract) now give the target box rows for `unreturned` and assert `unpaired` without them.
- `lib/__tests__/drawingAuditLog.test.ts` "DWG-4 — a box nobody could pair keeps a sheet from passing, never makes it broken".
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "the lens lists it as not paired, and the record files the source flagged — never broken_connectors";
  - "a sheet-only connector (DWG SAME SH n) pairs inside its own drawing — a missing box there is the broken one".

Each fails against the first fix pass (`2f2a3a7`).

Residual. A same-drawing connector to a sheet the library does not hold yields no `ref` row, so it is not reported as a missing sheet. Its box is not paired either, because nothing is there to pair it with.

**Review fix pass 3 (2026-10-01, intelligence Round G).** Fix pass 2's sentence above ("broken is now exactly …") overstated it. For a line in the contract's shape, `auditOpcBoxes` paired on the positional destination AND on every number `extractDrawingRefs` read anywhere on the line, including the `— <TO|FROM> <service>` tail. Example: `OPC 14: DWG 025-PID-0105 — FROM 025-PID-0101 HEADER` was paired against 0101 as well. If 0101's boxes were read and did not include 14, the line was `unreturned` against a sheet it never named, and the record filed `broken_connectors`, the top severity, never lowered at that revision. Before this package no OPC lines were produced, so turning the contract on made this reachable for the first time. Now:
- **Paired by position only.** In `lib/drawingText.ts`, a line `parseOpcLine` reads in the contract's shape is paired only on `opcDestinationForms` (plus `<declared base>-SH<n>` for a same-drawing connector). The grammar reads a line outside the contract whole, as before.
- **A tail with no dash.** `OPC_SEPARATOR_RE` also ends the destination field at a spaced `TO` / `FROM` word. A tail written without its dash (`OPC 14: DWG 025-PID-0105 FROM 025-PID-0101 HEADER`) no longer puts the service's number into the field.
- **`NONE` with a number in the tail.** `OPC 15: DWG NONE — CONT ON DWG 025-PID-0107` is `unknown`, never broken, and never paired against 0107. The first fix pass kept it out of `noRef` by pairing it there.
- **What a verdict depends on.** `auditOpcBoxes` returns `targetsByDoc`: the documents each source's boxes were paired against. DWG-13 uses it, below.

Broken is now exactly what fix pass 2 said: a connector that shows neither a drawing number nor a sheet (and no drawing number anywhere on its line), or a box missing from the sheet its destination field names, where that sheet's box numbers were read. (Corrected in review fix pass 4: this did not hold for a sheet that was only partly read. That covers a sheet parked waiting on AI vision, an accepted partial index, and a failed document. A box on one of its unread pages was filed `unreturned`; see below.)

Tests (`lib/__tests__/drawingText.test.ts`):
- "a drawing number in the service tail is never the destination: no false unreturned against it". This is the reviewer's probe (A's box 14 to 0105, service FROM 0101, 0105 has box 14, 0101 only box 3), with the dash, without it, and with `--`. There is no unreturned, unpaired or broken entry; `targetsByDoc` names 0105 only; and a box missing on 0105 is still caught.
- "broken means what the contract says" now asserts `NONE` with a tail number is unknown and paired nowhere.

Both fail against fix pass 2 (`4e549d0`).

**Review fix pass 4 (2026-10-01, intelligence Round G).** Fix pass 3's sentence above held only for a destination read whole. `auditOpcBoxes` asked only whether the destination had ANY box rows. So a neighbour that was parked waiting on AI vision, had an accepted partial index, or had failed with part of its index, counted as fully read. A box standing on one of its unread pages was then filed `unreturned`, and the record filed `broken_connectors`, the top severity. A verdict at a known revision is never lowered (`RANK`), so that false verdict stayed. The reviewer reproduced it through the route:
- 0105 is parked with page 2 unread. Box 14 is on page 2; box 7 is on page 1.
- 0104's `OPC 14: DWG 025-PID-0105 SH 1` was filed `broken_connectors` at C.
- The retry read box 14, and the verdict still stayed `broken_connectors`.

Now:
- **A sheet not read whole is no evidence.** `notReadWhole(docs)` in `app/api/knowledge/drawing/route.ts` collects three kinds of document, each with why:
  - every document with `vision_failed_pages` ("page(s) 2 never read");
  - every failed one ("its indexing failed");
  - every one not finished indexing.

  The lens and the record both pass it to `auditOpcBoxes` (a new `incomplete` argument, `lib/drawingText.ts`). A box missing from what was read of such a target is `unpaired`, with `unread` saying why, and never `unreturned`. A box found on what was read pairs as before. The verdict says so: "Connector 14 continues to 025-PID-0105.pdf, which was not read whole (page(s) 2 never read) — the box is not on what was read of it, so the pairing was not checked". The lens returns the reason with the box, and the panel shows it.
- **References get the same rule** (see DWG-13): a reference back, or a sheet of that drawing, not found on such a sheet is unchecked, never one-way and never a gap.
- **Re-judged when the page is read.** The target stays in the source's verdict basis (`targetsByDoc`), so the source is re-audited once the retry reads the page. A `flagged` filed for an unchecked pairing is true when filed. Like any unpaired box, it is never lowered at that revision.

Broken is now exactly: a connector that shows neither a drawing number nor a sheet (and no drawing number anywhere on its line), or a box missing from the sheet its destination field names, where that sheet was read whole (ready, no page left unread) and its box numbers were read. (Corrected in review fix pass 5: this did not hold either. Box numbers were pooled per DOCUMENT, so "its box numbers were read" was true of a combined PDF as soon as any one of its pages had a box row, including a page that is not the sheet named; see below.)

Tests:
- `lib/__tests__/drawingText.test.ts` "a box not on what was read of a sheet not read whole is unpaired with the reason — never unreturned".
- `lib/__tests__/drawingAuditLog.test.ts` "a box not on what was read of its target is unpaired with the reason; the sheet is flagged, never broken".
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-4 / DWG-13 — a neighbour not read whole is no evidence of what it lacks":
  - the reviewer's parked-neighbour probe through the lens and the record (after the retry, the stored `flagged` is kept, never `broken_connectors`);
  - the accepted-partial variant.

Each fails against fix pass 3 (`f41a1a8`).

**Review fix pass 5 (2026-10-01, intelligence Round G).** Fix pass 4's sentence above held only for a document of one sheet. `auditOpcBoxes` kept box numbers in one set per DOCUMENT and filed `unreturned` whenever that set existed and lacked the box. Box numbers come only from pages AI vision read (DEC-59 item 5: a text layer prints a pennant, not a box token), and ingest decides vision page by page (`pageNeedsVision`). So in a combined PDF only some pages' boxes are ever read, and the document still counted as read whole. At the base `unreturned` could not fire (no `opc` rows existed, DWG-4), so this package made it live: a regression. The reviewer reproduced it through the route:
- Doc a (025-PID-0104) carries `OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402`.
- Doc b is a ready two-page combined PDF. Page 1 declares 025-PID-0105 / 025-PID-0105-SH1 from a TrueType text layer, so it was not vision-read and has no `opc` rows. Page 2 (025-PID-0106) is SHX, vision-read, with `OPC 3`.
- The lens listed box 14 as unreturned, and the record filed 025-PID-0104 `broken_connectors` ("Connector 14 continues to combined.pdf, which has no matching box"), never lowered at that revision. The same happened when a keyless or over-cap driver indexed the thin pages text-only (DWG-7, below).

Now:
- **Paired per sheet.** `auditOpcBoxes` (`lib/drawingText.ts`) takes a new `selfPages` argument: by document, by declared number, the pages its title block declares it on. The route builds it from the roll-up's `pages` for kind `self` (`indexMaps` in `app/api/knowledge/drawing/route.ts`). Box numbers are kept by document AND page. A destination resolves to the page(s) whose self rows declare the matched number, and the box pairs only there.
- **`unreturned` only when the sheet named was read.** That needs the document read whole, box numbers read on every page that is the sheet named, and none of them this box. Otherwise the connector is `unpaired`, and its new `why` says which page:
  - "page 1 of it is the sheet named, and no box numbers were read there";
  - "box 14 stands on page 3 of it, whose drawing number was not read, and that page may be the sheet named". A box found on a page that declares no number is never filed `unreturned` against the page that does;
  - "which of its pages is the sheet named is not known", when a caller passes no pages. Without them nothing is ever `unreturned`.

  A box found on a page that declares ANOTHER sheet is not on the sheet named. When the sheet named was read with its boxes, that connector is still `unreturned`.
- **The verdict says so.** `verdictsForSheets` (`lib/drawingAuditLog.ts`) files it as "Connector 14 continues to combined.pdf: page 1 of it is the sheet named, and no box numbers were read there — the pairing was not checked; check the box on that sheet". The sheet is `flagged`, and the flag is settled, not provisional: the document IS read whole. The lens returns `why` with the box, and the panel shows it.
- **The basis follows the page.** `indexFingerprint` now digests a self row's pages too. If a declared number moves to another page, the sheet a box pairs on has changed, so the verdict is re-judged.

Broken is now exactly: a connector that shows neither a drawing number nor a sheet (and no drawing number anywhere on its line), or a box missing from the sheet its destination field names, where the document holding that sheet was read whole and box numbers were read on that sheet's own page(s). (Corrected in review fix pass 6: this did not hold for a connector that names no sheet. A page whose title block was not read, and on which no box numbers were read, declares nothing, so it was never counted as part of the drawing named; see below.)

Tests:
- `lib/__tests__/drawingText.test.ts` "a box pairs on the SHEET its connector names: a combined PDF's text-layer page is never box-complete because another page was vision-read". It runs the reviewer's probe, then: paired on page 1; `unreturned` when page 1 has its boxes and 14 stands on 0106's page; `unpaired` when 14 stands on an undeclared page; a bare number declared on two pages; and no pages given. The existing pairing tests now pass the pages.
- `lib/__tests__/drawingAuditLog.test.ts`: "files the page-level reason, flagged — never broken"; "indexFingerprint changes when a declared number moves to another page".
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-4 — a box pairs on the SHEET its connector names, never on another page's boxes":
  - the reviewer's combined-PDF probe through the lens and the record (`flagged`, never `broken_connectors`, no `provisional`);
  - page 1 vision-read without box 14 is `broken_connectors`; with 14 it is `passed`.
  - The two parked-neighbour tests now put 0105's page-2 title block beside its box 14, and their connector names the drawing.
- `lib/__tests__/drawingIntelPanelRebuild.test.ts` (rendered): "an unpaired box on a page whose box numbers were never read says which page".

Each new case fails against fix pass 4 (`b41bdca`), except the route's positive control ("page 1 vision-read … `broken_connectors`; with 14 … `passed`"), which passes there too.

Residual. A connector into another page of its OWN combined PDF is still not paired (`target === source`), as before.

**Review fix pass 6 (2026-10-01, intelligence Round G).** Two more paths filed a connector settled when the evidence was missing.

**1. A page with neither a title block nor box numbers read.** Fix pass 5's safety valve covered only an undeclared page that HAS the box. The reviewer's probe F, run on `auditOpcBoxes` directly:
- 0105 is a two-page PDF of one drawing. Page 1 was read by AI vision: it declares 0105 / 0105-SH1 and has box 7.
- Page 2 (sheet 2, SHX) was indexed text-only, for example by a keyless or over-cap driver (the DWG-7 residual). It has no self row and no box rows.
- 0104 carries `OPC 14: DWG 025-PID-0105 — TO V-1402`, which names no sheet. Only page 1 declares 0105, and it has boxes but no 14, so box 14 was `unreturned`. 0104 recorded `broken_connectors`, never lowered at a known revision.

Now `auditOpcBoxes` (`lib/drawingText.ts`) takes `context.pageCounts`; the route passes each document's `page_count`. A connector that names no sheet names the whole drawing. Before filing `unreturned`, it checks for a page of the destination that declares no number AND had no box numbers read. If there is one, the connector is `unpaired` with "page 2 of it declares no drawing number and no box numbers were read there — it may be the sheet named". A connector that names a sheet declared on another page is not affected, because that page is the sheet named. Without page counts, only the declared pages are known; the route always passes them.

**2. A destination whose document was reset by a rebuild.** `resetKnowledgeIndex` clears a document's self rows, so mid-rebuild no document declares the connector's destination. `auditOpcBoxes` skipped such a connector silently: it was neither unpaired nor provisional, so the sheet was filed a SETTLED `passed`. With fix pass 4's 409 gone, this happened on every rebuild. The reviewer's probes through the route:
- C: an unrevised (`""`) `broken_connectors` was overwritten with `passed`.
- D: a first record at C, taken mid-rebuild, filed `passed`, settled.

Now `auditOpcBoxes` takes `context.inProgress`: the documents still being read, parked or in flight (route `stillBeingRead`). Suppose no document declares any form of the destination, and one of those documents may hold it. For a destination in the set's scope (its own series or its drawing's), any of them may; for one outside it, only a document whose number is not read yet. The connector is then `unpaired`, with `maybeInIds` and "no sheet in the set declares it yet, and it may be in 025-PID-0105.pdf (not finished indexing), not read whole yet". The record maps those ids to `waitsOn`. The verdict is therefore provisional, and it waits over a settled row (DWG-13). (Corrected in review fix pass 7: this covered only a destination still being read. When the reset destination's re-index FAILED, no document was being read, so the connector was still dropped and the source filed a settled `passed`. A parked document also counted as being read, so it could hold any destination. See below. Corrected again in review fix pass 8: holding none outside the settled rule, a parked document let a connector into its unread page be dropped. It may hold any destination in the set's scope again, and its verdict waits; see review fix pass 8 below.)

Broken is now exactly: a connector that shows neither a drawing number nor a sheet (and no drawing number anywhere on its line), or a box missing from the sheet its destination field names. That needs three things: the document holding that sheet was read whole; box numbers were read on that sheet's own page(s); and, when the connector names no sheet, no page of that document is both undeclared and without box numbers read.

Tests:
- `lib/__tests__/drawingText.test.ts`:
  - "a connector naming no sheet is never unreturned while a page of its destination declares no number and had no box numbers read". This is probe F. It also checks that page 2's boxes read without 14 is `unreturned`, that a one-page document is `unreturned`, and that a connector naming SH 1 is `unreturned`.
  - "a connector whose destination no document declares, while a document still being read may hold it, is unpaired and names it".
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-13 / DWG-4 — what a document still being read may hold is never filed settled …":
  - probe F through the lens and the record (`flagged`, settled, never `broken_connectors`);
  - probes C and D (the unrevised `broken_connectors` is kept and waits; the first record at C is provisional, then `broken_connectors` once 0105 is read without box 14).

Each fails against fix pass 5 (`2c1e254`).

Residual. Take a document mid-rebuild whose filename carries an unrelated number, and which is the only holder of the destination's series. While it has declared nothing, the destination is outside the set's scope, so the connector is dropped as before; the reference audit calls it out of scope. The set digest names the document, so the sheet is judged again once the document is read. Until then, under an unknown revision, the latest settled verdict stands in the row. (Corrected in review fix pass 7: "stands in the row" meant it was WRITTEN over the row, so a recorded `broken_connectors` was lowered until the document finished. Since review fix pass 7 a lower verdict under an unknown revision waits while any document is in flight; see DWG-13.)

**Review fix pass 7 (2026-10-01, intelligence Round G).** Fix pass 6 closed the reviewer's probe C only for a destination still being read. Two more paths dropped a connector and filed its sheet a settled `passed`, a third widened too far, and the fix itself was slow.

**1. A destination whose re-index failed (the reviewer's probe "failed", major).** A rebuild resets 0105, and its re-index then fails: status `error`, self rows cleared. A failed document is not being read, so `holdersOf` found no holder, and the connector was dropped. 0104 was filed a settled `passed`. Under `""` that overwrote a verified `broken_connectors`, and at C a first record filed `passed`. The reference audit could not catch it either: `025-PID-0105-SH1` no longer resolves, so it is filed out of scope.

Now `auditOpcBoxes` (`lib/drawingText.ts`) takes `context.forNow`: every document not read whole only for now, whether in flight, parked or failed. One not in flight may hold an undeclared destination by the settled rule, `mayHoldBySettledRule`, which `auditDrawingRefs` now shares:
- its own drawing, read from its filename when a failure cleared its title block;
- a series it declares two drawings of;
- any destination in the set's scope, when its number was never read.

The route maps those ids with `waitsOn(ids)` over `forNow`, so the connector waits on the failed document, labelled "(its indexing failed — re-index it)". That makes it a finding about that document: the box may stand on it. Holders named for the destination's drawing come first.

**2. A sheet no title block declares (the reviewer's minor).** Take `OPC 14: DWG 025-PID-0105 SH 2` into a 0105 whose page 2 was indexed text-only. No self row declares `025-PID-0105-SH2`, so the connector had no owner and was dropped, and the source was filed a settled `passed`. Now a sheet-addressed form with no owner, of a drawing that exactly one other document declares, is paired against that document. The exception is a sheet known not to be in it: the document was read whole, every page declares a number, and it declares sheets of that drawing, none of them this one. The sheet's page is not known, so the connector is never `unreturned`. It is `unpaired`, with either "no page of it declares sheet 2, so which of its pages is the sheet named is not known", or `unread` when the document is not read whole. Two documents declaring the drawing is never guessed between. The source's own document is never paired this way, as before. (Corrected in review fix pass 8: this guess skipped the documents that may hold the sheet. Take per-sheet PDFs of 0105 where SH1's title block read only the base number. While SH2's own PDF was reset by a rebuild, or its re-index failed, SH1 was the sole declarer, so the connector was filed a SETTLED `unpaired` against SH1, the wrong document. A known revision's `passed` became `flagged` for good. The guess now stands only when no other document not read whole for now may hold the sheet; see below.)

**3. A parked document no longer holds any destination.** See DWG-13 item 5: only a document in flight may. A parked document whose title block was read holds its own drawing, or a series it declares two drawings of. (Corrected in review fix pass 8. Held by the settled rule only, a connector into a parked document's unread page under another number of the set's series was dropped, and an unrevised `broken_connectors` was overwritten with a settled `passed`. Also, "in flight" was not what the route implemented: a document still mid-read whose batch had queued a page for AI vision was treated as parked. A parked document now holds any destination in the set's scope as well; see below.)

**4. Cost (major).** `holdersOf` re-checked the set's scope for every candidate of every connector. The reviewer measured 11.5 s for 600 sheets mid-rebuild and 28 s for 1,000, on GET and on record-audit; the route's limit is 60 s. Now the following are each computed once:
- the scope;
- each candidate's facts;
- whether a form is in scope, memoised;
- the holders of each destination, memoised.

The same probe now takes 0.15 s and 0.2 s. The `why` names four holders and counts the rest. The lens returns at most six `maybeInIds` per connector or missing sheet.

Broken is unchanged from fix pass 6.

Tests:
- `lib/__tests__/drawingText.test.ts`:
  - "a connector into a destination whose title block a failed re-index cleared is unpaired and names that document". It covers probe "failed" at the lib. A failed document named for another drawing does not hold it. An unnumbered one holds a destination in scope, never one in another unit. The holder named for the destination comes first, and the rest are counted.
  - "a connector naming a sheet no title block declares, of a drawing one document declares, is unpaired — never dropped". It covers the reviewer's case, a document not read whole (`unread`), a sheet known absent (no finding) and two declarers (not guessed).
  - "pairing a large library mid-rebuild stays fast": 600 sheets, 300 in flight, 10 connectors each, under 1 s.
  - "pairs by the positional destination …": its last case, a document declaring only the bare number, now expects `unpaired` with the new `why`. Before this pass it expected the connector dropped.
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "… (review fix pass 7)":
  - probe "failed" at `""` and at C: the row waits untouched, labelled "re-index it", and the lens shows the unpaired box;
  - a first record at C while the destination is failed: provisional, never a settled `passed`.

Each fails against fix pass 6 (`85e1648`).

Residual:
- A connector into another page of its own combined PDF is not paired, as before.
- A connector into an undeclared sheet of a drawing that two documents declare is not guessed.
- Take a failed document whose filename names an unrelated series, and whose title block the failure cleared. It holds nothing, so a connector into its old number is dropped. No document is in flight, so under `""` that settled verdict is written. (Since review fix pass 8: unless a document is still being read, in flight or parked.)
- The reference audit's twin is unchanged. A sheet-addressed reference to a sheet no title block declares, of a drawing whose only declaration is its bare number, is filed out of scope. The connector carrying the same destination is now `unpaired`.

**Review fix pass 8 (2026-10-01, intelligence Round G).** Fix pass 7's items 2 and 3 above, and its "a reset destination waits", did not hold in three cases. The reviewer reproduced each through the route.

**1. A destination mid-read with a page already queued (probe midread-opc, blocker).** Each ingest batch commits the pages it queued for AI vision (`vision_failed_pages`) as it goes, with status `indexing`, no error and no retry time. Fix pass 7's `inFlightOf` counted any document with a queued page and a title-block row as parked. So a combined PDF reset by a rebuild, six pages into twenty with page 3 queued, held only by the settled rule. A connector into 030-PID-0203 on its page 15 was dropped, nothing was in flight, and an unrevised `broken_connectors` was overwritten with a settled `passed`. Now `inFlightOf` (`app/api/knowledge/drawing/route.ts`) counts a document as parked only when its main pass is through (`pages_indexed` at `page_count`, `mainPassThrough`), it is parked (`isParked`), and its unread pages are listed. Everything else still being read is in flight: queued, stale, or mid-read, with or without a queued page. `notReadWhole` labels a mid-read document "not finished indexing, page(s) 3 queued for AI vision". Fix pass 7 said "page(s) 3 never read", but pages 7 to 20 were unread too.

**2. A parked destination page (probe parked-opc, blocker).** 0104's box 14 was `broken_connectors` against 025-PID-0108, page 2 of 025-PID-0107.pdf. That PDF was re-indexed and parked on page 2 under the monthly cap. By the settled rule it held only 0107, so the connector was dropped and `passed` was written over the row. Now `auditOpcBoxes` (`lib/drawingText.ts`) takes `context.reading`, the documents still being read (in flight or parked; the route passes `stillBeingRead`). A parked one holds any destination in the set's scope as well as what it holds by the settled rule. The connector is `unpaired`, "…it may be in 025-PID-0107.pdf (page(s) 2 never read), not read whole yet", and waits on it. A failed document still holds by the settled rule only. A destination outside the set's scope is not held by a numbered parked document. Under `""` the guard below covers that case (DWG-13 item 4 of this pass).

**3. An undeclared sheet whose own PDF is reset or failed (probes undecl-reset and undecl-failed, blocker).** See the correction to fix pass 7's item 2 above. Now, when no document declares any form of the destination, `auditOpcBoxes` first asks which documents not read whole for now may hold it (`holdersOf`), leaving out the drawing's sole declarer it would guess. If any may, the connector is `unpaired` against them, with `maybeInIds`, and the record waits on them. The guess against the sole declarer is dropped: the lens names SH2.pdf ("not finished indexing", or "its indexing failed — re-index it" on the record), not SH1.pdf. Only when nothing else may hold the sheet does the guess stand, settled, as fix pass 7 filed it.

Broken is unchanged from fix pass 6.

Tests:
- `lib/__tests__/drawingText.test.ts`:
  - "a parked document may hold any destination in the set's scope: a connector into its unread page is unpaired and names it". It also checks that a failed document holds by the settled rule only, and that a numbered parked document does not hold a destination in another unit.
  - "a sheet no title block declares is guessed into its drawing's sole declarer only when no other document not read whole may hold it". It covers SH2 reset and SH2 failed (unpaired against SH2, no `toId`, no target), nothing else may hold it (the guess against SH1, settled), and the sole declarer itself not read whole (the guess, with `unread`).
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-13 / DWG-4 — a document mid-read, a parked one, or a reset or failed per-sheet sibling … (review fix pass 8)":
  - probes midread-opc and parked-opc: the unrevised `broken_connectors` waits untouched, the lens lists the box unpaired, and it is `broken_connectors` again once the destination is read without box 14;
  - probes undecl-reset and undecl-failed at rev C: the lens points at SH2, the row stays `passed` while SH2 is not read whole, and then it is `passed` with nothing kept;
  - "with no other document that may hold it, the undeclared sheet is still paired against its drawing's sole declarer — unpaired, settled" (a positive control: fix pass 7 passes it too).

Each fails against fix pass 7 (`c0656fa`) except the positive control.

Residual (this replaces fix pass 7's list):
- A connector into another page of its own combined PDF is not paired, as before.
- A connector into an undeclared sheet of a drawing that two documents declare is not guessed.
- A connector into a destination outside the set's scope that only a parked document's unread page declares is dropped, as an out-of-scope connector is. At a known revision dropping never raises a verdict. Under `""` a lower verdict waits while that document is parked (DWG-13).
- Take a failed document whose filename names an unrelated series, and whose title block the failure cleared. It holds nothing, so a connector into its old number is dropped. If no document is being read, under `""` that settled verdict is written.
- The reference audit's twin is unchanged. A sheet-addressed reference to a sheet no title block declares, of a drawing whose only declaration is its bare number, is filed out of scope. The connector carrying the same destination is `unpaired`.

**Review fix pass 9 (2026-10-01, intelligence Round G).** Item 2 above made a connector into a parked document's possible destination wait on it. That verdict did not resolve when the parked document stopped waiting without being read: a controller accepted its partial index, or its indexing failed. The row stayed `flagged` at rev C, "already recorded" for good, where the computation was `passed` (the reviewer's probes accept, accept2 and failed). The fix is DWG-13's review fix pass 9 item 1: a provisional row is never "already recorded", and the set's basis names each incomplete document's kind. Pairing is unchanged. A parked document whose number was never read still holds any destination for a connector, and the connector waits on it (only the reference audit changed for such a document; DWG-13 item 2 of that pass).
---

<a id="dwg-5"></a>

## DWG-5 · The locate route's refine passes spend up to 8 extra vision calls per request that are never metered and never counted against the monthly cap

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/locate/route.ts:216-220`, `app/api/knowledge/locate/route.ts:236-268`, `lib/ai/usageServer.ts:112-127`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the mutation on lines 267-268 is dead weight — the ai_usage_events row was written and awaited before it happens. The cap check (:185-194 `if (cap > 0 && spent.spentUsd >= cap)`) reads getMonthUsage, which is fed by those under-counted rows, so the governance layer sees roughly 1/9th of the real spend. Each refine image (outW 1400) is comparable in size to the coarse 1800px render, so the under-count is close to the order of magnitude claimed.

**Mechanism.** `recordAskUsage` is awaited at locate/route.ts:216 with `usage: out.usage`. It reads the fields synchronously and inserts immediately (`input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, est_cost_usd: estimateCostUsd(model, usage)`, usageServer.ts:118-122).

The refine loop then runs AFTER that write and mutates the same object:

    out.usage.inputTokens += fine.usage.inputTokens;
    out.usage.outputTokens += fine.usage.outputTokens;

(locate/route.ts:267-268). Nothing re-records. The row in `ai_usage_events` is already written with the coarse pass's numbers only.

The loop is `REFINE_MAX = 4` tags × `CROP_DIVISORS = [3, 9]` = up to 8 additional `callAiModel` invocations, each carrying a fresh 1400px-wide PNG crop — comparable input-token cost to the coarse call that WAS billed. So the request can spend roughly 9× what it reports.

The cap check at line 185-194 (`getMonthUsage` / `getCapUsd`) reads the same table, so the under-reporting compounds: the user's spend appears ~1/9 of actual, and the cap that is supposed to stop runaway vision spend never trips on schedule.

**Failure scenario.** A user with a $20/month cap opens twenty vision-read sheets and clicks tags. Each locate request bills one coarse call and silently makes up to eight more. `ai_usage_events` shows ~$2 spent; the provider bill shows ~$18. The user's own key is charged, the cap does not fire, and the governance layer the whole BYO-key design rests on ("metered as its own op, and stops at their monthly cap", lib/knowledgeVision.ts:19-20) reports a number that is wrong by most of an order of magnitude.

**Evidence.**

```
app/api/knowledge/locate/route.ts:216-220 — `await recordAskUsage({ orgId, userId: user.id, provider, model: ..., usage: out.usage, ok: true, op: "drawingLocate" });`
app/api/knowledge/locate/route.ts:267-268 — `out.usage.inputTokens += fine.usage.inputTokens;` / `out.usage.outputTokens += fine.usage.outputTokens;`
app/api/knowledge/locate/route.ts:236-237 — `const REFINE_MAX = 4; const CROP_DIVISORS = [3, 9];`
lib/ai/usageServer.ts:118-122 — `input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, est_cost_usd: estimateCostUsd(model, usage),`
lib/ai/usageServer.ts:122 — `const { error } = await supabaseAdmin.from("ai_usage_events").insert(full);`
```

> **Verifier correction.** The '~9×' magnitude is wrong. Each refine crop is rendered at outW=1400 (:249) against a coarse page rendered at width 1800 (:202) with aspect preserved, so a crop costs roughly 0.6× the coarse image in vision tokens — 8 refines ≈ 5-6× the billed amount, not 9×. It is also usually fewer than 8: the loop breaks at `Date.now() - startedAt > LOCATE_BUDGET_MS - 8_000` (:244) inside a 40s budget that the render plus coarse call has already eaten into, and breaks permanently for a tag whose crop returns no sighting (:273).

**Done when.**

- [ ] `recordAskUsage` is called after the refine loop finishes, or each refine call records its own event
- [ ] A test asserts that N model calls in one locate request produce usage totals covering all N
- [ ] The cap check is re-consulted (or the loop is bounded by remaining budget) before starting refine passes, not only before the coarse pass

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29). Against the base route, one locate request with a coarse pass and four close-ups wrote ONE metering row carrying the coarse pass's tokens only. The test below fails there: 1,000 input tokens recorded, against 5,000 spent. What landed in `app/api/knowledge/locate/route.ts`:

- **Every call metered, once.** Every model call one request makes goes through one helper (`ask`), which adds the call's usage to a running total. That covers the coarse pass, each close-up, and the new relocate round (DWG-13). A thrown call adds whatever usage it carries. ONE `recordAskUsage` row (`op: drawingLocate`) is written in a `finally` after the last call, with the summed usage. `ok` is false when the request failed. Nothing spent goes unrecorded, even when a later step throws.
- **The cap is re-consulted before every extra call.** `overCap(spent)` adds the estimated cost of what this request has spent so far to the month's spend, and refining (or relocating) stops once that reaches the cap.
- **The month's spend counts every op**, not only knowledge questions (`monthSpendAllOps`: asks, vision indexing, locate, everything; read to exhaustion). A ledger that cannot be read refuses the call rather than assume $0. This is a LOCAL gate, the HLD-1 pattern: `lib/ai/aiGates` (I-05) is the one helper and unifies it, and I-05's GOV-1 makes `getMonthUsage` count every op for every route.

Tests: `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-5 / GOV-8":
- "one coarse pass + four close-ups = five calls, one metering row covering all five, written after the last call";
- "the cap is re-consulted before each extra call: a coarse pass that reaches it stops the refining";
- "a refine call that throws still counts the usage it carries; the coarse point is kept";
- "a user over this month's cap — counting every op, not only asks — sends nothing";
- "an unreadable ledger refuses rather than assume $0 …".

**Done-when.**
- ✓ `recordAskUsage` is called after the refine loop finishes, once, with every call's usage summed.
- ✓ A test asserts that N model calls in one locate request produce usage totals covering all N (5 calls → 5,000 input / 250 output tokens, recorded after the last call).
- ✓ The cap is re-consulted before each refine pass (and the relocate round), not only before the coarse pass.

**Scope / residual.** None in this route. Until I-05's GOV-1 lands, `drawingLocate` rows still do not count toward the cap the OTHER routes enforce, because `getMonthUsage` filters `op = 'knowledgeAsk'`. This route's own gate counts them.

---

<a id="dwg-6"></a>

## DWG-6 · drawing_audit_logs is keyed org-wide but computed library-scoped, and the upsert overwrites unconditionally — a narrower library's verdict destroys a wider one's

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260929_mention_engine.sql:140-153`, `app/api/knowledge/drawing/route.ts:386-392`, `app/api/knowledge/drawing/route.ts:443-456`, `lib/drawingAuditLog.ts:140-149`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every leg: the key is org-wide, the computation is library-wide-scoped, the upsert is unconditional, and the mirror uniqueness index explicitly permits one controlled sheet in many libraries (so both audits carry the same `rev`, hence the same key). The RANK dedup at route.ts:445-451 protects only within one batch, never against the stored row. lib/orchestrator/tools.ts:268-270 reads the record back by `(org_id, sheet_number)` alone, so the corrupted verdict is what the orchestrator reports as history.

**Mechanism.** The unique key is `(org_id, sheet_number, revision_code)` — no library_id, no document_id. But the verdict is computed from `loadVisibleEntities(orgId, userId, libraryId)` (route.ts:387), and the audit's entire meaning depends on library scope: `auditDrawingRefs` decides `missingInSeries` vs `outOfScope` by whether a series is present IN THAT LIBRARY (`const inScope = scopeAll.some((s) => seriesMatch(s, series));`, drawingText.ts:501). `oneWay` likewise only exists between two sheets both loaded in that library.

The write is `upsert(..., { onConflict: "org_id,sheet_number,revision_code" })` with no severity guard. The RANK map at route.ts:445-451 dedupes only WITHIN one request; across requests the later write simply replaces the earlier one.

Three compounding collisions:
1. Same sheet mirrored into two libraries (a plant-wide library and a unit library — the normal setup) → whichever is audited last wins, and the narrower one manufactures `missingInSeries` findings against a set that was complete.
2. `revision_code` is `""` for every library-only PDF (route.ts:431), so all unmirrored sheets sharing a `sheet_number` collapse into one row.
3. `status` is not ranked across writes, so a `skipped` (route.ts:432: `indexed: d.status === "ready" && withEntities.has(d.id)` — false during any re-index) overwrites a recorded `broken_connectors` or `passed`.

The verdict rows carry `knowledgeDocumentId` inside `audit_details` (drawingAuditLog.ts:147), so the losing library's identity is destroyed too, not merely shadowed.

**Failure scenario.** 025-PID-0104 lives in "Crude Unit P&IDs" (all 40 sheets of the 025-PID series) and is also mirrored into "Tank Farm Reference" (5 sheets, none of them 025-PID-0107). Doc Control audits Crude Unit: `passed`. A week later someone audits Tank Farm Reference. There, 025-PID-0107 is not loaded, so `inScope` is false for its series only if the series is absent entirely — but 025-PID-0104 itself IS present, so `scopeAll` contains `025-PID` and the reference to 0107 lands in `missingInSeries`. The upsert replaces the `passed` row with `flagged: References 025-PID-0107, which isn't in the set`. The regulated record now says a complete drawing set has a gap that does not exist, and the earlier clean verdict is gone — not superseded, deleted.

**Evidence.**

```
supabase/migrations/20260929_mention_engine.sql:150-151 — `CREATE UNIQUE INDEX IF NOT EXISTS drawing_audit_logs_sheet_rev_idx ON drawing_audit_logs (org_id, sheet_number, revision_code);`
app/api/knowledge/drawing/route.ts:454-456 — `.from("drawing_audit_logs").upsert(verdictRows(orgId, deduped, userId), { onConflict: "org_id,sheet_number,revision_code" });`
app/api/knowledge/drawing/route.ts:387 — `const { docs, entities, error } = await loadVisibleEntities(orgId, userId, libraryId);`
lib/drawingText.ts:501 — `const inScope = scopeAll.some((s) => seriesMatch(s, series));`
app/api/knowledge/drawing/route.ts:445 — `const RANK: Record<string, number> = { skipped: 0, passed: 1, flagged: 2, broken_connectors: 3 };` (applied only to `verdicts` within this request, never against what is already stored)
```

> **Verifier correction.** Add a third writer that compounds it: lib/orchestrator/tools.ts:544 (`log_audit_completion`) upserts into the same table on the same `onConflict: "org_id,sheet_number,revision_code"` with a model-supplied status and no severity guard at all — an agent can overwrite a recorded broken_connectors with 'passed' from a different surface entirely.

**Done when.**

- [ ] The unique key includes the scope the verdict was computed in (library_id, or the knowledge document id) so two libraries cannot overwrite each other
- [ ] The upsert refuses to lower severity: a stored `broken_connectors`/`flagged` is never replaced by `skipped` (do the RANK comparison against the existing row, not just within the batch)
- [ ] `audit_details` records the library and the sheet list the verdict was computed against, so a reader can tell what 'the set' meant
- [ ] A verdict computed over a library that does not contain the sheet's own series is not recorded at all

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29). Against the base route, recording a narrower library (`Tank Farm`, holding 025-PID-0104 alone from the 025-PID series) after a complete one (`Crude Unit`) replaced Crude Unit's `passed` row for 0104. The test below fails there. What landed:

- **The key carries the set (`20261124`).** `drawing_audit_logs.library_id` is new. The key becomes `UNIQUE (org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT`, and the org-wide `drawing_audit_logs_sheet_rev_idx` is dropped.
  - Existing rows take the library of the knowledge document in `audit_details.knowledgeDocumentId` where it still resolves. The rest stay org-wide (library_id NULL), still unique among themselves.
  - There is no foreign key: a verdict outlives its library, and a deleted library must neither delete the history nor collide it into the org-wide key.
  - The route upserts on `org_id,library_id,sheet_number,revision_code`.
- **Never lowered.** `RANK` and `wouldLowerSeverity` (`lib/drawingAuditLog.ts`, exported for every writer, the orchestrator's `log_audit_completion` included) are checked against the STORED row for this library, not just within the batch. A computed verdict that would lower a stored one is not written; it is reported under `keptStored`. With DWG-13, a stored non-`skipped` verdict at this revision is not even recomputed.
- **The set is on the record.** `audit_details` carries `libraryId` and `set` (every sheet number in the library when the verdict was computed: the count always, the list up to 500 with `truncated` past that). `audited_at` is written on every write.
- **No verdict about a set the library does not hold.** A gap ("isn't in the set") is judged only inside a series the library holds (`seriesHeldBySet`). A sheet that is the only one of its series in the library (`sheetsAloneInTheirSeries`) is still recorded for what is its own — its connectors and boxes — while references into its series are out of the set's scope (`missingWithinHeldSeries`), and the record names the series not judged (`audit_details.set.seriesNotJudged`). (Corrected in the review fix pass below: the first rule dropped such sheets whole. Replaced in review fix pass 2: a series is held only when the library carries two or more different numbers of it; `sheetsAloneInTheirSeries` is gone.)
- **No verdict from a partial read.** If the entity index could not be read whole (DWG-11), the route answers 409 and records nothing.

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "Crude Unit records 0104 passed; Tank Farm judges no gap in a series it holds one sheet of, and Crude Unit's verdict survives";
  - "when both libraries hold the series, each keeps its own row for the same sheet and revision";
  - "a 'skipped' verdict is re-audited once the sheet can be read — re-stamped, never lowered";
  - "on a database without library_id nothing is recorded and the route names the migration".
- `lib/__tests__/drawingAuditLog.test.ts`: "RANK — a stored verdict is never lowered", "sheetsAloneInTheirSeries — a verdict needs the set it judges", and the `verdictRows` cases for library, set and `audited_at`.
- `lib/__tests__/intelRoundGDrawingMigration.test.ts`: the key, the backfill, the dropped index and the route's `onConflict`.

**Done-when.**
- ✓ The unique key includes the scope the verdict was computed in (`library_id`), so two libraries cannot overwrite each other.
- ✓ The upsert refuses to lower severity: the RANK comparison runs against the existing row, and a stored `broken_connectors` or `flagged` is never replaced by `skipped`. One qualification (review fix pass, with DWG-13): under an UNKNOWN revision (`""`) the latest non-`skipped` verdict replaces the row (`mayReplaceStored`), because nothing can tell that row's drawing from the one that replaced it; `skipped` still never replaces a verdict. That exception covers only the library's OWN row. Before review fix pass 3 it also let another library's computation replace a `""` row on the pre-`20261124` org-wide key.
- ✓ `audit_details` records the library and the sheet list the verdict was computed against, and the series it did not judge.
- ✓ In the form the review fix pass settled: no verdict ABOUT a series — a gap — is ever recorded from a library that does not hold that series (the finding's failure scenario: Tank Farm now files no "isn't in the set" against 025-PID). The sheet itself is recorded for what is its own. The criterion's literal "not recorded at all" also dropped a lone sheet's own defects (a connector naming no drawing) and every verdict of a single-sheet or one-sheet-per-series library, which the base recorded; that was the over-reach the review found. (The first fix pass ticked this while a library holding ONE multi-sheet drawing of 025-PID — per-sheet PDFs, or one combined PDF of its sheets — still counted 025-PID as held and filed the gap. That overstated it. It holds since review fix pass 2, below.)

**Final key, for I-04.** `UNIQUE (org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT`. `log_audit_completion` (`lib/orchestrator/tools.ts`) must upsert with `onConflict: "org_id,library_id,sheet_number,revision_code"` and `library_id` NULL (org-wide), and should apply `RANK` / `wouldLowerSeverity` before writing. Until it does, once `20261124` is applied that one tool's upsert names a key that no longer exists, and PostgREST refuses it (42P10). The tool returns that error; it does not write elsewhere. Apply `20261124` after the merge that moves it (the migration's header says so).

**Pending migration:** `20261124_intel_roundG_drawing_audit_scope.sql`. Until it is applied the route records on the org-wide key that database has (review fix pass 2, below). The first record said it answered 424 and wrote nothing, which closed a write path the base had. The pre-apply inventory counts the verdicts on a sheet mirrored into more than one library, which are the ambiguous ones. Decision: `DEC-59` item 2.

**Review fix pass (2026-10-01, intelligence Round G).** `sheetsAloneInTheirSeries` dropped whole verdicts that the base recorded: a single-sheet library, a library holding one sheet per series, and a combined PDF declaring `025-PID-0101/0102/0103` with no SHEET field (only several `-SHn` forms exempted a document). The suppression covered every finding, including a connector that names `NONE`, a defect of the sheet itself. Now:
- **A document holds a series of its own** when it declares two or more numbers of one series, whichever form (`sheetsAloneInTheirSeries` counts distinct identities per series within the document; the `-SHn` rule is one case of it).
- **A sheet alone in its series is recorded.** `recordAudit` no longer skips it. Its `missingInSeries` findings are limited to the series the library holds (`seriesHeldBySet` / `missingWithinHeldSeries` in `lib/drawingAuditLog.ts`), so a reference into its own series is out of scope, exactly like one into another unit. Its broken, unreturned, one-way, unreadable and unread-page findings stand. The response and `audit_details.set.seriesNotJudged` name the series whose gaps were not judged; the panel says so.

Tests: `lib/__tests__/drawingAuditLog.test.ts` "a combined PDF declaring several numbers of one series holds that series itself (fix pass)", "a single-sheet library, and one sheet per series, are alone — and recorded for what is their own", "gaps are judged only inside a series the library holds", and "verdictRows — the series not judged are on the record"; `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "Crude Unit records 0104 passed; Tank Farm judges no gap in a series it holds one sheet of …" (0104 recorded `passed` in Tank Farm with no missing reference and `seriesNotJudged: ["025-PID"]`; Crude Unit's row untouched), "a lone sheet's own defect is still recorded: a connector that names no drawing is broken in any set (fix pass)", and "a single combined PDF, and a single-sheet library, are recorded". Each fails against the round's first commit.


**Review fix pass 2 (2026-10-01, intelligence Round G).** Three corrections.
- **One drawing never holds its parent series.** `seriesHeldBySet` added every series of a document that was not alone. Per-sheet documents of one drawing share its number (`025-PID-0104`), so they were "not alone". A library holding one multi-sheet drawing therefore counted the whole `025-PID` series as held and filed "References 025-PID-0107, which isn't in the set". Now a series is held only when two or more DIFFERENT numbers of it exist in the library, counted across all documents (`seriesHeldBySet(identities)` in `lib/drawingAuditLog.ts`). A combined PDF declaring `025-PID-0101/0102/0103` holds `025-PID`. Two sheets of `025-PID-0104`, as per-sheet PDFs or one combined PDF, hold that drawing's sheets and never `025-PID`. A missing sheet of a drawing whose parent series is held is in scope (`025-PID-0105-SH2` in a Crude Unit set). `seriesNotJudged` names the root series of every number outside a held series. `sheetsAloneInTheirSeries` is deleted; nothing else called it.
- **Recording before `20261124`.** The route answered 424 until the migration was applied, and the migration waits on I-04. That closed a write path the base had for that whole window. Now, when `drawing_audit_logs.library_id` does not exist, `recordAudit` reads prior verdicts org-wide and upserts on the old key (`org_id,sheet_number,revision_code`), with `library_id` left out of the rows and kept in `audit_details`. It applies the same `mayReplaceStored` guard, so a stored verdict on the shared key is never lowered (the base overwrote it). (Corrected in review fix pass 3: that held only at a known revision. A `""` row from another library was replaced; it no longer is, see below.) The response carries `legacyKey: true` and a notice naming the migration. With `20261124` applied, the scoped key is used as before.
- **The set list is stored once per run.** `verdictRows` copied up to 500 sheet numbers into every row, so a 600-sheet library sent one upsert of about 5 MB. Now every row carries `set.count` and `set.digest` (a digest of the sorted list). The first row of the run alone carries `set.sheets`. A reader finds the list on the row with the same `audited_at` and digest.

Tests:
- `lib/__tests__/drawingAuditLog.test.ts`, block "seriesHeldBySet — a gap is judged only in a series the library holds":
  - "ONE multi-sheet drawing holds its sheets, never its parent series — per-sheet PDFs or one combined PDF";
  - "a set of single-sheet drawings holds the series, and a sheet of any of its drawings is in scope";
  - the lone-sheet, combined-PDF, single-sheet and one-per-series cases, rewritten on the new rule.
- `lib/__tests__/drawingAuditLog.test.ts` "stores the set list ONCE per run: every row its count and digest, the first row the list".
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "Tank Farm holding 025-PID-0104 as per-sheet PDFs files no gap against 025-PID";
  - "on a database without library_id: the org-wide key, never lowered, and the route says so" (replaces "nothing is recorded and the route names the migration").
- `lib/__tests__/intelRoundGDrawingMigration.test.ts`: the route names the old key exactly once, in the `legacyKey` branch that drops `library_id`.

Each fails against the first fix pass (`2f2a3a7`).

**Review fix pass 3 (2026-10-01, intelligence Round G).** Two corrections.
- **On the org-wide key, another library's verdict is never lowered.** `mayReplaceStored` lets any non-`skipped` verdict replace a row under an unknown revision (`""`). On the scoped key that row is the library's own. On the pre-`20261124` org-wide key it may be another library's. Library B's computation therefore replaced library A's `broken_connectors` with `passed`, while the notice said "never lowered". Now, in `legacyKey` mode, `recordAudit` (`app/api/knowledge/drawing/route.ts`) treats a row whose `audit_details.libraryId` is not this library as foreign. That includes a row that names no library, such as the base's or the orchestrator's. A foreign row is never lowered, whatever its revision (`wouldLowerSeverity`), and is reported under `keptStored`. The library's own `""` row still takes its latest verdict, as on the scoped key. The notice now says "a verdict another library recorded is never lowered by this one".
- **The lens judges gaps by the record's rule.** The GET pushed `audit.missingInSeries` unfiltered ("…from a series you DID load are referenced but absent … gaps in the set"), while the record judges a gap only inside a held series. The GET now computes the held series from the same identities (`seriesHeldBySet`). It filters `audit.missingInSeries` through `missingWithinHeldSeries` before the suggestion and in the response, and returns `seriesNotJudged`. `components/knowledge/DrawingIntelPanel.tsx` names those series on the lens: "Gaps are not judged in 025-PID — this library holds no more than one drawing number of that series". The record's copy, which said "holds only one sheet of", uses the same words. Under the held-by-distinct-numbers rule, a library can hold many sheets of one drawing and still not hold the series.

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "library B's computation never replaces library A's row on the org-wide key; A's own row still takes its latest verdict";
  - "a reference into a series the library does not hold is no gap on screen either; the series is named" (Crude Unit shows 0107 as a gap; Tank Farm shows none, names `025-PID`, and matches its record).
- `lib/__tests__/drawingIntelPanelRebuild.test.ts` (rendered): "the lens names the series whose gaps it does not judge", and the record's copy.

Each fails against fix pass 2 (`4e549d0`).

**Review fix pass 5 (2026-10-01, intelligence Round G).** A missing sheet was filed only against the first six referencing sheets in alphabetical order. `auditDrawingRefs` cut `referencedBy` to six for display, and the record used that list to decide who gets the finding. With eight sheets citing a missing 025-PID-0199, the seventh and eighth were recorded `passed` and stamped covered. The cut was there at the base; fix pass 4's `missingUnread` copied it. Now `auditDrawingRefs` (`lib/drawingText.ts`) also returns `referencedByAll` for `missingInSeries` and `missingUnread`. The record files the finding against every one of them. Only the lens keeps the cut list, and it never ships the whole one. Tests: `lib/__tests__/drawingText.test.ts` "a missing sheet names every referencing sheet for the record — six for display"; `lib/__tests__/drawingAuditLog.test.ts` "eight referencers, eight flagged"; `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "eight sheets reference 025-PID-0199: all eight are flagged — the lens lists six, the record files eight". The route test fails against fix pass 4 (`b41bdca`).

**Review fix pass 9 (2026-10-01, intelligence Round G).** The series not judged named prose documents. The route counted `sheetIdentities`, whose fallback, when a sheet declares nothing and its filename holds no drawing number, is the filename itself. With 040-TK-0001/0002 beside "Pump Manual.pdf" and "Spec Section 15000.pdf", the lens returned `seriesNotJudged: ["PUMP", "SPEC-SECTION"]` and the panel said "Gaps are not judged in PUMP, SPEC-SECTION — this library holds no more than one drawing number of each of those series". With a parked "Scan_0001.pdf", every recorded row carried `set.seriesNotJudged: ["SCAN_0001.PDF"]`. Two documents named "Pump …" would even have made `PUMP` a held series. This had been in the branch since the first review fix pass (`8ab0582`). Now `sheetDrawingNumbers` (`lib/drawingText.ts`) gives a sheet's REAL drawing numbers: what its title block declared, else what the drawing-number grammar reads in its filename, and nothing otherwise. `sheetIdentities` is that plus the fallback, unchanged for resolving references and for the set digest. The route passes `sheetDrawingNumbers` to `seriesHeldBySet` and `seriesNotJudged`, in the lens (GET) and in `recordAudit`, so both judge the same series. A drawing number in a filename still counts ("030-PID-0201.pdf" alone is named `030-PID`).

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "the reviewer's probe notjudged: a prose document's filename names no series 'not judged' — on the lens or on the record";
- `lib/__tests__/drawingAuditLog.test.ts` "a prose document's filename is no drawing number: it names no series, held or not judged";
- `lib/__tests__/drawingText.test.ts` "a sheet's drawing numbers never include its filename standing in for one".

Each fails against fix pass 8 (`c7272ca`).

Residual: a sheet whose title block declared nothing, under a filename the drawing-number grammar does not read (the grammar does not read `040-TK-0001.pdf` as a drawing number), counts toward no series. Its title block, once read, does.
---

<a id="dwg-7"></a>

## DWG-7 · A P&ID with a real, working text layer produces zero entities once the page exceeds 2000 characters — and vision is not offered as a fallback

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `lib/drawingText.ts:19-25`, `lib/knowledgeIngest.ts:231`, `lib/drawingText.ts:609-636`, `lib/knowledgeIngest.ts:268`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All four consequences follow mechanically: >2000 chars means no equipment, no ref, no opc and no 'self' rows, so the census, the reference audit, the CSV register and the equipment bridge are all empty, while chunking/search still succeed. The only vision path for such a page is the manual library-wide `forceAllPages` toggle — nothing automatic, and the drawing route's suggestion for this exact state (route.ts:199-205) tells the user it is 'normal for prose documents' rather than offering vision.

**Mechanism.** Entity extraction on the non-vision path is gated by `isDrawingLikePage`:

    export const SPARSE_PAGE_MAX_CHARS = 2000;
    return pageText.trim().length > 0 && pageText.length <= SPARSE_PAGE_MAX_CHARS;

A dense E-size P&ID exported with TrueType fonts — the GOOD case, the one that needs no AI at all — carries every tag, every line number, every note and the revision history in its text layer. Several thousand characters is ordinary. Past 2000 the page is classified as prose and `knowledgeIngest.ts:231` skips extraction entirely; line 268 skips title-block and OPC extraction with it, so the sheet never even declares its own drawing number.

The vision safety net does not catch it either. `pageNeedsVision` returns false for any page over 1200 characters that yielded at least one tag (`if (tagsFound >= (thin ? MIN_TAGS_THIN_PAGE : 1)) return false;` then `if (!thin) return false;`), and `tagsFromText` is computed from the raw text regardless of the sparse gate (knowledgeIngest.ts:153). So the page is simultaneously too dense to extract from and too tag-rich to be re-read.

Marked SUSPECTED because both shipped fixtures are ~180-character SHX title-block-only sheets (measured: `2002-D 2001_SHT09_R39_12-31-24.pdf` → chars=176, items=17), so the dense-text-layer case has no fixture in the repo and its frequency cannot be observed from here.

**Failure scenario.** A site whose CAD standard uses TrueType uploads a full P&ID set. Every sheet indexes 'ready', chunks fine, and is fully searchable as prose — but the equipment census is empty, the reference audit is empty, no sheet declares its number, the CSV register is blank, and the Bridge populates nothing. The panel's diagnostic classifies each sheet as `text-no-tags` (route.ts:296) and the suggestion says "These documents have text but no drawing tags were extracted — normal for prose documents" (route.ts:200-201). The one suggestion offered is 'Rebuild index', which re-runs the same gate and changes nothing. The best-quality input in the system produces the worst result, and the diagnostic tells the user their P&IDs are prose.

**Evidence.**

```
lib/drawingText.ts:19 — `export const SPARSE_PAGE_MAX_CHARS = 2000;`
lib/drawingText.ts:23-25 — `return pageText.trim().length > 0 && pageText.length <= SPARSE_PAGE_MAX_CHARS;`
lib/knowledgeIngest.ts:231 — `} else if (isDrawingLikePage(pageText)) {`
lib/knowledgeIngest.ts:268 — `if (visionRead || isDrawingLikePage(pageText)) {`
lib/drawingText.ts:631-632 — `if (tagsFound >= (thin ? MIN_TAGS_THIN_PAGE : 1)) return false;` / `if (!thin) return false;`
app/api/knowledge/drawing/route.ts:200-204 — `"These documents have text but no drawing tags were extracted — normal for prose documents. "`
Measured on the repo fixture: `p1 rotate=0 view=[0,0,1224,792] chars=176 items=17`
```

> **Verifier correction.** 'Vision is not offered as a fallback' is overstated. knowledgeIngest.ts:153 is `if (vision?.forceAllPages || pageNeedsVision(...))` — the library's 'Index every page with AI vision' switch does force it, and drawing/route.ts:210-213 even tells the user to turn it on. The accurate claim is that nothing routes a dense-text-layer drawing to vision AUTOMATICALLY, and that the per-sheet verdict for it is 'text-no-tags' (:296) whose suggestion text (:201) explains it away as 'normal for prose documents' — which is the actively misleading part.

**Done when.**

- [ ] The drawing/prose decision uses drawing-shaped SIGNALS (tag density, sentence-ender ratio, item count vs character count) rather than a bare character ceiling — the same reasoning `pageNeedsVision` already applies at line 634
- [ ] A dense text-layer P&ID fixture is added and asserted to yield equipment tags and a title-block 'self' entity
- [ ] The `text-no-tags` diagnostic distinguishes 'this looks like a drawing we refused to parse' from 'this is prose', and says which
- [ ] Whatever ceiling remains is a named constant with a recorded rationale, not a round number

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29). A 2,683-character TrueType P&ID page made the base `isDrawingLikePage` return false. Through the real ingest, a real PDF of such a page wrote no equipment row and no title-block identity; the test below fails against the base code. What landed:

- **Signals decide, not a ceiling.** `isDrawingLikePage` (`lib/drawingText.ts`) keeps the sparse fast path: at or under `SPARSE_PAGE_MAX_CHARS` (2,000) a page is a drawing, as every sparse sheet always was. A denser page is a drawing when its letters are capitals AND it reads as a drawing:
  - **capitals:** `drawingSignals().lowercaseRatio` ≤ `DRAWING_MAX_LOWERCASE_RATIO`, 0.35. Drawings are lettered in capitals; prose is mostly lower case;
  - **a tag list:** `DENSE_DRAWING_MIN_TAGS_PER_KCHAR`, 4 equipment tags and drawing references per 1,000 characters; or
  - **a title block:** its own title block declares a drawing number (BR-12).

  Sentence enders are deliberately not a signal, because a drawing's numbered notes end in full stops. Ingest calls `isDrawingLikePage` for extraction, for the title block and for the chunker's carry, so the fix reaches all three without a change to `lib/knowledgeIngest.ts`.
- **Vision stays opt-in.** Nothing routes a page to AI vision automatically (decision default, `DEC-59` item 1). (Corrected in review fix pass 4: no DENSE text-layer page is routed to AI vision. As at the base, `pageNeedsVision` routes a thin page with no tags, and a near-empty one, page by page when the uploader has a key saved; see below. Corrected again in review fix pass 5: not the uploader's key. Interactive indexing uses the key of the controller driving it (`app/api/knowledge/ingest/route.ts` reads `ai_connections` for the caller); only the nightly drain uses the uploader's sponsored key.)
- **The lens says which.** For a `text-no-tags` sheet, `app/api/knowledge/drawing/route.ts` answers `looksLike: "drawing"` or `"prose"`. It says drawing when the sheet has a title block, a drawing reference, or capital lettering, measured in the database by `knowledge_doc_text_stats()` (`20261124`) or over the chunks read whole. The advice now differs. "These documents have text but no drawing tags were extracted — normal for prose documents" is gone. A drawing gets "look like DRAWINGS … most likely SHX line-work … turn on 'Text doesn't extract from these files — index every page as an image'"; prose gets "read as prose — no drawing tags are expected". The panel shows "Drawing, no tags" or "Prose".

Tests:
- `lib/__tests__/drawingText.test.ts`, block "DWG-7 / BR-12": the dense fixture is a drawing by its signals, yields tags and a title-block identity, and no line numbers; dense prose that names equipment stays prose; dense capitals without tags stay out unless the sheet's border declares it a drawing; the sparse fast path is unchanged.
- `lib/__tests__/intelRoundGDrawing.test.ts` "yields equipment tags and a title-block identity past 2,000 characters — and no phantom pumps from line numbers" (the real ingest over a real PDF).
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "text with no tags says drawing (capitals, a title block) or prose — and the advice differs".

**Done-when.**
- ✓ The drawing/prose decision uses drawing-shaped signals (tag density, a title block, letter case) rather than a bare character ceiling.
- ✓ A dense text-layer P&ID fixture is added and asserted to yield equipment tags and a title-block `self` entity, through the real ingest.
- ✓ The `text-no-tags` diagnostic says whether the sheet looks like a drawing we got no tags from, or like prose.
- ✓ The remaining ceiling (`SPARSE_PAGE_MAX_CHARS`, now a fast path) and both thresholds are named constants with their rationale recorded at the declaration.

**Scope / residual.** Already-indexed dense sheets gain their tags at their next re-index (a rebuild, or a rev-up). The letter-case signal will miss ANY drawing lettered in mixed case past 2,000 characters, title block or not: `isDrawingLikePage` refuses a page more than 35 % lower case before it looks for a title block. Such a sheet is shown as "Prose" and keeps the old behaviour. (Corrected in review fix pass 2. This line first said "with no title block", which understated it. Letting a title block override the case test was rejected: a specification citing "Drawing No. 123-A-456" would then be read as a drawing.)


**Review fix pass 2 (2026-10-01, intelligence Round G).** The "Drawing, no tags" advice told every sheet that looked like a drawing to turn on library-wide every-page vision. That included a legend, cover or drawing-index sheet in a healthy TrueType set, which has references but no equipment. `forceAllPages` reads and bills every page of every document in the library, which DEC-59 item 1 and the 99 do-not rule out as a default. Now the route marks a sheet `shxLike` only when it looks like an SHX export: capital lettering, thin text (at most `THIN_PAGE_MAX_CHARS`, 1,200, per page, now exported from `lib/drawingText.ts`), no drawing references, and no more declared drawing numbers than pages. Only such sheets get the advice. It now says plainly that the switch reads every page of every document and bills each one, and to turn it on only if most of the library is like these sheets. A drawing sheet whose text layer gave references is never advised. Before `20261124` the letter case is not measured (DWG-11), so no sheet is `shxLike` and no advice is given on a guess. The panel's footnote says the same.

Tests: `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
- "text with no tags says drawing … or prose — and the advice differs" (now asserts `shxLike` and the billing sentence);
- "a drawing sheet whose text layer gave references (a legend, an index) is never told to vision-read the library".

The second fails against the first fix pass.

**Review fix pass 3 (2026-10-01, intelligence Round G).** Fix pass 2's SHX criterion did not hold for the sheet it was written for. `shxLike` required `!refsByDoc.has(d.id)`. On a sparse text-layer page, ingest runs `extractDrawingRefs` over every text item, so a TrueType title block's own number (`025-PID-0104`) is always written as a `ref` row beside its `self` row. The canonical SHX sheet was therefore never `shxLike` and got no advice. The route test passed only because its fixture left out that `ref` row. Separately, the advice sent users straight to the library-wide every-page switch. A thin page with no tags is already routed to per-page vision (`pageNeedsVision`) on any rebuild with a key saved, which is the cheaper remedy, and the advice never mentioned it. (Corrected in review fix pass 4: usually, not always. A thin page whose text reads like sentences is passed over; see below.) Now:
- **Only other drawings count.** `shxLike` counts only references whose base is not one of the sheet's own declared numbers (`otherRefs`, ignoring `-SHn`).
- **The keyed rebuild first.** The advice says "Hit 'Rebuild index' with your AI key saved: a page like that is read by AI vision during indexing, page by page, and each page read bills to your key."
- **The every-page switch, only after that.** It is offered, with its billing said plainly, only when some document in the library was read by AI vision (a key has evidently been used here) and these sheets are still unread: "if a rebuild with your key saved still leaves these sheets unread …". That is a proxy. Nothing stored says whether the sheet's own last rebuild had a key.
- **The panel's footnote** says the same, in that order.

Tests: `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
- "text with no tags says drawing … or prose — and the advice differs" now seeds the `ref` row ingest writes. It asserts `shxLike`, and the keyed-rebuild advice without the every-page switch.
- "the library-wide every-page switch is offered only once a keyed rebuild has evidently left SHX sheets unread".

Both fail against fix pass 2 (`4e549d0`).

**Review fix pass 4 (2026-10-01, intelligence Round G).** Fix pass 3's advice told the user, as fact, that a keyed rebuild reads "a page like that" with AI vision. It also dropped the library-wide switch unless some document already had `vision_pages > 0`. The trouble is that `pageNeedsVision` and `shxLike` use different tests:
- `pageNeedsVision` passes over a thin page with more than two sentence enders. An SHX title block's `DRAWING NO. … REV. … DWG. … CHK'D.` has four, and numbered notes add more.
- `shxLike` has no sentence test.

So in a library made entirely of such sheets, no page was ever vision-read. The switch, the only remedy, was never offered, and the same advice came back after every rebuild. Fix pass 3's claim ("already routed … on any rebuild with a key saved") is corrected above. Now:
- **Usually, not always.** The advice says a page with almost no text and no tags is "usually read by AI vision during indexing", and that "a page whose title block or notes read like sentences can be passed over".
- **The switch is always named after it.** It is phrased conditionally: "If a rebuild with your key saved still leaves these sheets unread, the remaining switch is library-wide …". Its billing is said plainly: it "reads EVERY page of EVERY document in this library … and bills each page to your key. Turn it on only if most of this library is like these sheets". Fix pass 2 offered it the same way. It still goes only to `shxLike` sheets, so a sheet whose text layer gave references is never advised. The `visionReadHere` gate is gone.
- **The panel's footnote** says "usually", and why.

Tests (`lib/__tests__/intelRoundGDrawingRoutes.test.ts`):
- "an all-SHX library whose title blocks read like sentences: no page is vision-read on a rebuild, and the every-page switch is still offered". It runs the reviewer's title block through the route, and asserts that `pageNeedsVision` is false on it.
- "text with no tags says drawing … or prose — and the advice differs" now asserts "usually" and the conditional switch.

Both fail against fix pass 3 (`f41a1a8`).

**Review fix pass 5 (2026-10-01, intelligence Round G).** Records only. Fix pass 4 said `pageNeedsVision` routes a page to vision "when the document's uploader has a key saved", in the correction above and in DEC-59 item 1. That key is the one in use only for the nightly drain (`loadSponsorVision`, the uploader's sponsored key). Interactive indexing uses the key of the controller driving it: `app/api/knowledge/ingest/route.ts` reads `ai_connections` for the caller. Both records now say so.

Residual, handed to I-06 (`lib/knowledgeIngest.ts`). A page that `pageNeedsVision` routes to vision but that has no vision context is indexed text-only, and nothing records it as unread. That happens with no key (a keyless co-controller's open tab claiming a batch), or when the monthly cap is reached. The branch at `lib/knowledgeIngest.ts:1295-1340` writes nothing to `vision_failed_pages` when `vision` is undefined, so the document becomes `ready` and the lens and the record treat it as read whole.
- For connector BOXES this no longer matters. They are paired per sheet (DWG-4, review fix pass 5), so a page with no box numbers is `unpaired` whatever the reason. (Corrected in review fix pass 6: that held only for a page that declares the sheet named. A page indexed text-only has no title-block row either, so it declared nothing and was ignored, and a connector naming the drawing was filed `unreturned`. Since review fix pass 6, a page that declares no number and had no box numbers read keeps a connector that names no sheet `unpaired`. A connector that names a sheet declared on another page is still paired there; see DWG-4. Since review fix pass 7, a connector naming a sheet that no page of its drawing declares is `unpaired` too, unless every page of that document declares a number.)
- For REFERENCES it still matters. A reference back that stood only in that page's line-work is not found, and the reference is filed one-way (settled `flagged`).

The fix is ingest's: track such a page as unread, for example in `vision_failed_pages` with its reason, so `notReadWhole` sees it.
---

<a id="dwg-8"></a>

## DWG-8 · A connector's evidence line is truncated to 160 characters before the audit reads it, which can manufacture a 'broken by definition' finding

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/knowledgeIngest.ts:276`, `lib/drawingText.ts:739-746`, `app/api/knowledge/drawing/route.ts:253-258`, `components/knowledge/DrawingIntelPanel.tsx:344`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The truncation-before-analysis is real and the false 'broken by definition' verdict follows directly. Stronger than the finding states for text-layer sheets: knowledgeIngest.ts:129-134 only closes a line on `item.hasEOL`, so a CAD page with no EOL flags collapses to ONE line and every opc row on it keeps only the page's first 160 characters. Caveat worth recording: knowledgeVision.ts's VISION_SYSTEM never actually asks for `OPC <n>:` lines (contradicting drawingText.ts:289), so today opc rows only arise from literal 'OPC' text on the sheet — the defect is real but its blast radius depends on that.

**Mechanism.** `kind:'opc'` rows store `raw: truncateSafe(line, 160)` (knowledgeIngest.ts:276). `auditOpcBoxes` then decides the most severe finding in the system from that truncated string:

    const noRef = opcRows.filter((o) => !o.raw || extractDrawingRefs(o.raw).length === 0)

A connector line on a real sheet is long — box number, direction, stream/service description, destination equipment, drawing number, sheet number. The drawing number is typically at the END. If the line exceeds 160 characters the reference is cut off, `extractDrawingRefs` finds nothing, and the connector is classified as carrying no destination at all.

The route then reports it as "connector(s) carry NO drawing number at all — broken by definition: nothing tells the reader where to continue" (route.ts:254-257), the panel headlines it "connector(s) with no drawing number — broken" (DrawingIntelPanel.tsx:344), and `verdictsForSheets` turns it into the top-severity permanent verdict `broken_connectors` (drawingAuditLog.ts:83-85).

Marked SUSPECTED rather than CONFIRMED because it is currently masked by the finding above: `parseOpcBoxes` requires a literal 'OPC' token the vision prompt never produces, so almost no opc rows exist. Fix that prompt and this becomes live immediately.

**Failure scenario.** Once the vision prompt emits a proper connector line — e.g. `OPC 14: TO CRUDE COLUMN OVERHEAD ACCUMULATOR V-1402 VIA 12"-P-14022-A1A, CONTINUED ON DRAWING 2002-D-2001 SHEET 4 OF 12` (163 characters) — the tail is cut, no ref is found, and a perfectly drafted connector is recorded in the PSM audit log as broken. The evidence shown to the reviewer is the same truncated line, so the finding looks self-consistent and is very hard to dispute from the UI.

**Evidence.**

```
lib/knowledgeIngest.ts:276 — `page: p, kind: "opc", tag: box, raw: truncateSafe(line, 160), x: null, y: null,`
lib/drawingText.ts:739-740 — `const noRef = opcRows.filter((o) => !o.raw || extractDrawingRefs(o.raw).length === 0)`
lib/drawingText.ts:734 — `line: o.raw.slice(0, 120),` (the reviewer sees an even shorter slice)
app/api/knowledge/drawing/route.ts:254-257 — `` `${opcNoRef.length} off-page connector(s) carry NO drawing number at all — broken by ` + "definition: nothing tells the reader where to continue..." ``
lib/drawingAuditLog.ts:84 — `push(broken, c.sheet, `Connector ${c.box} names no destination drawing`);`
```

> **Verifier correction.** Keep it explicitly ranked BELOW finding 3 and contingent on it: with no 'OPC' token in VISION_SYSTEM, essentially no opc rows exist, so today this cannot fire at all. It is a latent trap in a code path to be enabled, not a live defect — and whoever fixes the prompt must fix the truncation in the same change.

**Done when.**

- [ ] The drawing reference is extracted from the FULL line at ingest and stored in its own column, so the audit never depends on a display-truncated string
- [ ] `raw` is kept for display only and the truncation length is raised or the ref-bearing tail preserved
- [ ] A 'no destination' verdict is not written when the source line was truncated — absence of evidence is recorded as unknown, not as broken
- [ ] A test feeds a >160-character connector line through ingest-shaped truncation and asserts the audit does not report noRef

**Partial (2026-10-01, intelligence Round G).** DWG-4's prompt contract makes this live, so the trap is closed in the same change. Reproduced first (DEC-29): a 182-character connector line, cut the way ingest cuts it (`truncateSafe(line, 160)`), loses its drawing number, and the base `auditOpcBoxes` reports it under `noRef`, which is broken by definition.

What landed:
- **A cut line is UNKNOWN.** `auditOpcBoxes` (`lib/drawingText.ts`) sorts a connector with no readable destination two ways. If its stored line is at the storage cut (`OPC_RAW_STORED_MAX`, 160, pinned by test to the ingest's own `truncateSafe(line, 160)`), it goes to a new `unknown` bucket. Only a COMPLETE line with no drawing number stays `noRef`.
- **Unknown is never broken.** `verdictsForSheets` (`lib/drawingAuditLog.ts`) records an unknown connector as `unreadableConnectors`: "its destination could not be read … check it on the sheet". It keeps the sheet from `passed` (the sheet is `flagged`) and never makes it `broken_connectors`.
- **Shown as unknown.** The lens lists such connectors separately ("not counted as broken"), with the whole stored line. The reviewer used to see a 120-character slice of the evidence.
- **The destination comes first.** DWG-4's contract asks the model for `OPC <box>: DWG <destination drawing number> SH <sheet> — …`, so a vision line's drawing number sits in its first few dozen characters and the cut cannot reach it.

Tests:
- `lib/__tests__/drawingText.test.ts`, block "DWG-8 — a cut evidence line is unknown, never broken": a >160-character connector line fed through ingest's own cut reports no `noRef` and one `unknown`; a complete short line with `NONE` is still broken; the cut is pinned to `lib/knowledgeIngest.ts`.
- `lib/__tests__/drawingAuditLog.test.ts` "DWG-8 — an unreadable connector keeps a sheet from passing, never makes it broken".

**Done-when.**
- ✗ **Not done.** The drawing reference is not extracted from the full line at ingest into its own column. That is a change in `lib/knowledgeIngest.ts` (the ingest owner's file), plus a new column on `knowledge_page_entities`. The purpose of the criterion, an audit that never decides "broken" from a cut string, is met by criterion 3 below, without that column.
- Half done. ✓ For vision transcripts the ref-bearing part of the line comes FIRST (the prompt contract), so the cut cannot reach it. ✗ `raw` is still both evidence and display, cut at 160, for a text-layer line that happens to print the letters OPC.
- ✓ A "no destination" verdict is not written when the source line may have been cut: it is recorded as unknown (`flagged`, "could not be read"), never as broken.
- ✓ A test feeds a >160-character connector line through ingest-shaped truncation and asserts the audit does not report `noRef`.

**Scope / residual.** OPEN until the ingest owner stores the full line's reference, or a longer cut, for `opc` rows.

**Review fix pass (2026-10-01, intelligence Round G).** With DWG-4's corrected contract, `unknown` also takes a connector whose destination is present but not shaped like a drawing number, a line outside the contract that still holds a number-like run, and a row with no stored line — absence of evidence each time, never broken. A contract line's destination sits right after `OPC <n>: DWG`, so for it the cut cannot matter: a contract line well past 160 characters, cut the way ingest cuts it, still reads its destination — neither broken nor unknown (test "a contract line keeps its destination at the head, so the storage cut can never take it"). The criteria's status is unchanged.


**Review fix pass 2 (2026-10-01, intelligence Round G).** Criterion 3's principle — absence of evidence is recorded as unknown, never as broken — did not hold for box pairing. A connector into a sheet with NO box numbers read (a text layer, or a sheet read before the contract) was filed `unreturned`, which is `broken_connectors`. The connector's destination was read; what was missing was any evidence on the target's side. That is now the `unpaired` bucket (see DWG-4's second fix pass): `flagged`, never broken, named on the record as `unpairedConnectors`. The criteria's status is unchanged; criterion 3's principle now holds for box pairing as well as for a cut line.
---

<a id="dwg-9"></a>

## DWG-9 · Migration 20261009_trace_method.sql ALTERs a table that 20261007_retire_line_traces.sql has already dropped — a fresh in-order apply fails

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261007_line_traces.sql:19`, `supabase/migrations/20261007_retire_line_traces.sql:9`, `supabase/migrations/20261009_trace_method.sql:16-21`, `lib/exportTables.ts:176-177`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide grep confirms no later migration recreates knowledge_line_traces (only the three files above mention it), and supabase/schema.sql — the documented 'run this to set up your database' file — contains none of the post-base tables (no line_traces, drawing_audit_logs or process_flows), so a fresh environment must apply the migrations in filename order and will hard-fail at 20261009. `IF NOT EXISTS` on the columns gives no protection; the missing relation is the error.

**Mechanism.** In filename order the three files run: `20261007_line_traces.sql` (CREATE TABLE knowledge_line_traces) → `20261007_retire_line_traces.sql` (`DROP TABLE IF EXISTS knowledge_line_traces;`, sorts after because 'l' < 'r') → `20261009_trace_method.sql` (`ALTER TABLE knowledge_line_traces ADD COLUMN IF NOT EXISTS method TEXT, ...`).

`ADD COLUMN IF NOT EXISTS` guards the COLUMN, not the TABLE. Against a dropped table the statement raises 42P01 (relation does not exist). The file's own header even says "Idempotent. Apply after 20261007" — which is precisely the ordering that breaks it.

The retirement was the later decision (the trace feature is gone: no `app/api/knowledge/trace/`, no `lib/pipeTrace.ts`, no `lib/drawingTrace.ts`), so 20261009 is a leftover from the feature it outlived.

Secondary rot from the same retirement: `lib/exportTables.ts:176-177` still lists `knowledge_line_traces` in `EXPORT_EXCLUDED_TABLES`, whose comment says "the coverage tripwire enforces the decision" — an exclusion entry for a table that no longer exists in the schema.

**Failure scenario.** Anyone provisioning a new environment (a fresh Supabase project, a restore, a self-host) applies the migrations in order and gets a hard error at 20261009. Because the drawing features degrade silently on missing tables (the 424 'needs migration 20260921' paths), the operator's instinct is to skip the failing file and continue — which works, but leaves no signal that the ledger is inconsistent, and the next person cannot tell an intentional skip from an interrupted apply.

**Evidence.**

```
supabase/migrations/20261007_retire_line_traces.sql:9 — `DROP TABLE IF EXISTS knowledge_line_traces;`
supabase/migrations/20261009_trace_method.sql:16-17 — `ALTER TABLE knowledge_line_traces\n  ADD COLUMN IF NOT EXISTS method TEXT,`
supabase/migrations/20261009_trace_method.sql:14 — `-- Idempotent. Apply after 20261007.`
`ls supabase/migrations | sort` → `20261007_line_traces.sql`, `20261007_rag_hardening.sql`, `20261007_retire_line_traces.sql`, `20261008_...`, `20261009_folder_order.sql`, `20261009_trace_method.sql`
lib/exportTables.ts:176-177 — `knowledge_line_traces: "cached AI line traces over drawing sheets — regenerated on demand from the drawings themselves; no authored data lives here",`
```

> **Verifier correction.** Two qualifications. (a) Blast radius is smaller than 'a fresh in-order apply fails' implies: .github/workflows/ci.yml runs only tsc/eslint/vitest/next build and explicitly states 'Migration discipline (manual until a supabase CLI pipeline is set up) … apply migrations in the Supabase SQL editor', and supabase/schema.sql is the bootstrap path — so this bites only someone replaying the migrations folder in filename order. (b) The 'secondary rot' sub-claim is WRONG: lib/exportTables.ts:176-177 must keep that entry, because lib/__tests__/exportCoverage.test.ts:29-42 discovers tables by regexing CREATE TABLE across schema.sql AND every migration file, so the retired table still counts as 'created' and would fail the tripwire as unaccounted-for if the exclusion were removed.

**Done when.**

- [ ] 20261009_trace_method.sql is deleted (the table it targets is gone) or wrapped in a `DO $$ ... IF to_regclass('knowledge_line_traces') IS NOT NULL ...` guard
- [ ] `knowledge_line_traces` is removed from EXPORT_EXCLUDED_TABLES and the coverage tripwire passes without it
- [ ] A test or CI step applies the migration directory in order against an empty database and fails loudly on any error

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29) by a static in-order replay of the numbered sequence. It reports `20261009_trace_method.sql ALTERs knowledge_line_traces, dropped by 20261007_retire_line_traces.sql`, exactly the 42P01 a fresh apply hits.

**What landed.** `supabase/migrations/20261009_trace_method.sql` now runs its ALTER inside `DO $$ … IF to_regclass('public.knowledge_line_traces') IS NOT NULL THEN … END IF; $$`. The statement itself is unchanged, line for line. The file is unchanged on a database that applied it before the retirement, and a no-op on every database after it. It defines no function, policy or trigger (DB-8). The guard is the same shape I-06 used for IRLS-6, so both replays read it.

Tests: `lib/__tests__/intelRoundGDrawingMigration.test.ts`, block "DWG-9":
- "the whole numbered sequence replays clean in filename order" (no ALTER TABLE reaches a table an earlier statement dropped and nothing re-created, unless guarded);
- "the matcher catches the pre-fix 20261009";
- "the guarded ALTER is the original statement, line for line, and defines nothing (DB-8)";
- "the export exclusion for the retired table stays".

I-06's `intelRoundGMigrationOrder.test.ts` replay (ALTER before CREATE) passes too.

**Done-when.**
- ✓ `20261009_trace_method.sql` is wrapped in a `DO $$ … IF to_regclass('public.knowledge_line_traces') IS NOT NULL …` guard.
- — Not applicable, refuted by the verifier's correction (b). `knowledge_line_traces` stays in `EXPORT_EXCLUDED_TABLES`: `lib/__tests__/exportCoverage.test.ts` discovers tables from every `CREATE TABLE` in the migrations, `20261007_line_traces.sql` still creates it, and removing the entry would fail the tripwire as an unaccounted table. Pinned by test. (`lib/exportTables.ts` is not this package's file, and is not edited.)
- ✓ A test replays the migration directory in order and fails loudly on this error class. It is a static replay, not a live apply: CI has no database (`.github/workflows/ci.yml`: migrations are applied by hand in the SQL editor). I-06's replay covers ALTER-before-CREATE, and this one covers ALTER-after-DROP, so between them a fresh in-order apply's two known 42P01 classes are caught before merge.

**Scope / residual.** A live apply of the whole directory against an empty Postgres in CI would catch every error class. That needs a database in CI, which the repo does not have.

---

<a id="dwg-10"></a>

## DWG-10 · The audit's primary key — the sheet number — is picked non-deterministically and disagrees with the number shown on screen

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/api/knowledge/drawing/route.ts:430`, `app/api/knowledge/drawing/route.ts:299`, `app/api/knowledge/drawing/route.ts:88-95`, `app/api/knowledge/drawing/route.ts:395-400`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Two different selection rules on the same array: the audit key takes element [0] raw (which can be a `-SHn` variant, since knowledgeIngest.ts:288-289 writes both `drawingNumber` and `drawingNumber-SHn` as 'self'), while the on-screen `declared` strips `-SHn` and picks the shortest. With no ORDER BY beyond document_id, a re-index that changes physical row order changes the key, and the unique index on (org, sheet_number, revision) then files the second run as a separate row rather than an update.

**Mechanism.** Ingest writes TWO 'self' entities per title block: the bare drawing number and `<number>-SH<n>` (knowledgeIngest.ts:291-292), and does so on every drawing-like page — so a multi-sheet PDF accumulates several.

The entity query orders by `document_id` only (`.order("document_id", { ascending: true })`, route.ts:94). Within one document Postgres may return the 'self' rows in any order. `selfByDoc` is built by simple push (route.ts:396-400), so `selfByDoc.get(d.id)?.[0]` is whatever came back first.

`recordAudit` uses exactly that as the permanent key:

    sheetNumber: selfByDoc.get(d.id)?.[0] ?? d.name,

Meanwhile the GET that the operator is looking at computes a DIFFERENT identity — the shortest tag with no `-SHn` suffix:

    const base = selfTags.filter((t) => !/-SH\d+$/.test(t)).sort((a, b) => a.length - b.length)[0] ?? null;

So the panel shows `025-PID-0101` while the record may be filed under `025-PID-0101-SH3`.

**Failure scenario.** A three-sheet PDF is audited on Monday and the query returns `025-PID-0101` first: row keyed `025-PID-0101@C`. It is audited again after a re-index and the planner returns `025-PID-0101-SH2` first: a SECOND row appears, keyed `025-PID-0101-SH2@C`. Neither overwrites the other, both are 'the audit for this sheet', and `check_audit_history` (orchestrator/tools.ts:268: `.eq("sheet_number", String(args.sheet_number))`) finds whichever the asker happens to type. The operator, meanwhile, has only ever seen `025-PID-0101` on screen.

**Evidence.**

```
app/api/knowledge/drawing/route.ts:430 — `sheetNumber: selfByDoc.get(d.id)?.[0] ?? d.name,`
app/api/knowledge/drawing/route.ts:299 — `const base = selfTags.filter((t) => !/-SH\d+$/.test(t)).sort((a, b) => a.length - b.length)[0] ?? null;`
app/api/knowledge/drawing/route.ts:94 — `.order("document_id", { ascending: true })`
lib/knowledgeIngest.ts:291-292 — `self(tb.drawingNumber); if (tb.sheetNumber) self(`${tb.drawingNumber}-SH${tb.sheetNumber}`);`
```

> **Verifier correction.** Downgraded to SUSPECTED because the claimed consequence is not observable from the repo and is unlikely in the common case: entityRows push `self(tb.drawingNumber)` BEFORE `self("…-SH"+n)` for every page, so in insertion order element [0] is the bare number — the same value :299 selects. A mismatch requires either Postgres returning the -SHn row first (possible under an index scan, unverified) or a single knowledge document whose pages declare different drawing numbers. The defect worth reporting is the unpinned ordering behind a permanent key plus two divergent identity computations, not an observed wrong filing.

**Done when.**

- [ ] Both the GET readout and recordAudit derive `sheetNumber` from ONE shared pure function, tested
- [ ] That function is deterministic given a set of self tags (e.g. shortest non-SH tag, ties broken lexicographically), independent of row order
- [ ] The entity query carries a stable secondary sort so repeated runs see the same order
- [ ] The number recorded in drawing_audit_logs is the number the panel displays for that sheet

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29). With a `-SH1` self row stored first, the base route recorded `025-PID-0104-SH1` while the lens showed `025-PID-0104`; the test below fails there. What landed:

- **One identity function.** `declaredSheetIdentity(selfTags)` (`lib/drawingText.ts`) returns the shortest declared number without a `-SHn` suffix, with ties broken in code-unit order (the same on every server, whatever its locale). It falls back to the shared base number when only sheet-addressed forms were declared. Row order can never change it.
- **Both readers use it.** The census GET builds the per-sheet `declared` from it, and `recordAudit` files `sheetNumber` from it (`app/api/knowledge/drawing/route.ts`).
- **Stable order.** Every entity read carries a stable order: the roll-up `ORDER BY document_id, kind, tag`; the raw fallback by document, page, kind, tag, then id.

Tests:
- `lib/__tests__/drawingText.test.ts`, block "DWG-10": the same answer for every permutation of the tags, ties, sheet-only forms, and empty input.
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a sheet-addressed self row coming back first changes neither": the lens and the record agree.

**Done-when.**
- ✓ Both the GET readout and `recordAudit` derive `sheetNumber` from one shared pure function, tested.
- ✓ That function is deterministic given a set of self tags: shortest non-SH tag, ties broken in code-unit order.
- ✓ The entity query carries a stable secondary sort.
- ✓ The number recorded in `drawing_audit_logs` is the number the panel displays for that sheet (the panel's tooltip now says so).

**Scope / residual.** Rows already recorded under a `-SHn` key stay as they are. The next record writes the base number, and the old row is history under its own key.

**Review fix pass 4 (2026-10-01, intelligence Round G).** Some sheets were recorded while not ready, before they had declared a number: the title block was on a page not yet read, because the sheet was being re-indexed, parked, or failed. Such a sheet was filed `skipped` under its FILENAME. That left a key the sheet does not have in `drawing_audit_logs`. The key was never re-recorded or removed, and it is not the number the lens shows once the sheet is read. `recordAudit` (`app/api/knowledge/drawing/route.ts`) now reports such a sheet under `notRecorded` with one of two reasons:
- "it is still waiting to finish indexing — its drawing number is not read yet";
- "its indexing failed before its drawing number was read — re-index it".

A sheet being indexed cannot be recorded at all now (DWG-13). A ready sheet that declares no number is still filed under its filename, as at the base, because that is the name the lens shows for it.

Not done:
- A sheet with a prior row is not filed under that row's key. It would be `skipped`, which never replaces a verdict.
- The set list (`audit_details.set.sheets`) still names such a sheet by its filename, the only name it has.

Test: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a sheet that is not ready and declares no drawing number is reported, never filed under its filename". It fails against fix pass 3 (`f41a1a8`).

---

<a id="dwg-11"></a>

## DWG-11 · The census that the UI promises is exact is read under row caps that truncate whole sheets out of the count

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/api/knowledge/drawing/route.ts:88-95`, `app/api/knowledge/drawing/route.ts:180-186`, `app/api/knowledge/drawing/route.ts:278-285`, `components/knowledge/DrawingIntelPanel.tsx:132`, `lib/knowledgeEntityKinds.ts:14-24`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The cap, the absence of any detection, and the exactness promise are all as described. The ordering makes it worse than a random shortfall: `.order("document_id")` means the cut lands on whole trailing documents in each 50-doc slice, so entire sheets vanish from the census and audit. Note knowledgeEntityKinds.ts:34 makes TAG_ENTITY_KINDS = all four kinds, so the `.in("kind", ...)` filter narrows nothing today — every kind competes for the same 50 000.

**Mechanism.** `loadVisibleEntities` pages documents 50 at a time and caps each slice at `.limit(50000)` with `.order("document_id", { ascending: true })`. On a real drawing set — a vision-read P&ID yields hundreds of entities per page — 50 sheets can exceed 50 000 rows. Because the order is by document_id, truncation does not thin the sample evenly: it drops the TRAILING documents of the slice entirely. Those sheets then have zero tags, zero refs, no 'self' declaration, and a full `gapPages` list.

The same shape appears twice more with `.limit(20000)`: the `docsWithText` probe (route.ts:180-186), whose truncation makes readable sheets look textless and triggers the 'these are scans, pay for vision' suggestion; and the per-doc character count (route.ts:278-285), whose truncation drives the per-sheet verdict toward `empty`.

The file lib/knowledgeEntityKinds.ts:14-24 documents this exact hazard for the KIND dimension — "it competes for the same row cap, and whichever rows Postgres happens to return first decide what the census says. Nothing errors. The number just quietly gets smaller, in the one place the UI promises it is exact" — and lib/__tests__/entityKindGuard.test.ts enforces the kind filter. Nothing enforces the row-count dimension, which is the same failure with a different cause.

SUSPECTED: the per-sheet entity volume of a real drawing set is not observable from the repo.

**Failure scenario.** A 200-sheet unit P&ID library is indexed with vision. The fourth 50-document slice exceeds 50 000 rows; sheets 190-200 are cut. The panel reports a census and a reference audit that omit eleven sheets, under the caption "Computed from every sheet's extracted tags — counts you can trust, not AI guesses". Those eleven sheets show ⚠ 'N page(s) unread' (route.ts:307-312), which points the operator at 'rebuild the index and let it finish' — a rebuild that will produce the identical truncated result. The reference audit additionally reports the missing sheets' series as gaps, because they are absent from `scopeAll`.

**Evidence.**

```
app/api/knowledge/drawing/route.ts:92-95 — `.in("document_id", docIds.slice(i, i + 50)).in("kind", TAG_ENTITY_KINDS as unknown as string[]).order("document_id", { ascending: true }).limit(50000);`
app/api/knowledge/drawing/route.ts:183-184 — `.in("document_id", readyIds.slice(i, i + 50)).limit(20000);`
app/api/knowledge/drawing/route.ts:280-281 — `.select("document_id, content").in("document_id", ids.slice(i, i + 50)).limit(20000);`
components/knowledge/DrawingIntelPanel.tsx:132 — `"Computed from every sheet's extracted tags — counts you can trust, not AI guesses."`
lib/knowledgeEntityKinds.ts:18-22 — `// A bulk read with no kind filter is therefore a live hazard ... the census silently shrinks. Nothing throws.`
```

> **Verifier correction.** None beyond the finding's own SUSPECTED label, which is correct — per-sheet entity volume on a real vision-read drawing set is not observable from this repo.

**Done when.**

- [ ] Every capped read detects saturation (rows returned == limit) and either continues with a cursor or surfaces the truncation instead of returning a smaller number silently
- [ ] The census is computed by a database aggregate rather than by shipping every row to the route
- [ ] Per-document reads are batched small enough that a single document can never be partially represented
- [ ] The 'counts you can trust' caption is only shown when no read saturated

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29), and worse than SUSPECTED. PostgREST caps every response at its max-rows (1,000 by default) without an error, so the base `.limit(50000)` returned at most 1,000 rows per 50-sheet slice. Against the base route, 60 sheets × 25 tags behind a 1,000-row cap produced a census of 1,212 of 1,500 occurrences, with 11 whole sheets at zero tags. What landed in `app/api/knowledge/drawing/route.ts`:

- **Every read pages to exhaustion** (`readAllPages`), as `lib/assets.ts` AREA-9 does. The first window takes an exact count; each next window starts where the rows actually returned end, so the read is complete whatever max-rows is set to. That covers the documents, the entity roll-up, connector rows, chunk statistics, prior verdicts and the rebuild's document list.
- **The database counts.** `drawing_entity_rollup(uuid[])` (`20261124`) returns one row per sheet, kind and tag with the occurrences, first page and pages. Rows shipped drop from one per occurrence to one per distinct tag. `knowledge_doc_text_stats(uuid[])` replaces shipping every chunk's content for the character counts.
  - On a database without `20261124` the route rolls the raw rows up itself, through `rollUpEntities`, the same roll-up pinned against the SQL. It reads them whole first.
  - The census, the register and the per-sheet readout take counted rows (`buildEquipmentCensus` / `equipmentRegisterCsv` accept a `count`).
- **Past the ceiling, honest.** A read stops at `KNOWLEDGE_INDEX_MAX_ROWS` (default 100,000) at a whole document: the document the stop lands in is dropped entirely and never counted in part. The route then answers `truncated: true` with the sheets `notCounted`, and a PARTIAL suggestion. The audit refuses to record (409), and the CSV export refuses rather than hand out a partial register.
- **The caption is earned.** The panel's "counts you can trust, not AI guesses" shows only when nothing was cut. Otherwise it reads "PARTIAL — N sheet(s) could not be counted".

Tests: `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-11":
- "raw-row path (before 20261124): every sheet is counted past the 1,000-row response cap";
- "aggregate path: the database's roll-up gives the same census";
- "past the ceiling the read stops at a whole document, says PARTIAL, and the audit refuses to record".

Also `lib/__tests__/drawingText.test.ts` "DWG-11 — the roll-up the census is computed from", and `lib/__tests__/intelRoundGDrawingMigration.test.ts`: the SQL roll-up reads `TAG_ENTITY_KINDS` and returns `rollUpEntities`' columns.

**Done-when.**
- ✓ Every capped read detects the cap and continues window by window to the end. Past the ceiling it surfaces the truncation instead of returning a smaller number silently.
- ✓ The census is computed by a database aggregate (`drawing_entity_rollup`, pending `20261124`) rather than by shipping every row to the route. Before the migration, the route reads the rows whole and rolls them up itself, saying which path it took (`indexSource`).
- ✓ A single document can never be partially represented: reads page to exhaustion, and a stop drops the document it lands in.
- ✓ The "counts you can trust" caption is only shown when no read was cut.

**Pending migration:** `20261124_intel_roundG_drawing_audit_scope.sql` (the two functions). Without it the census is still whole, read as raw rows, and slower on a large library. Decision: none needed.

**Review fix pass (2026-10-01, intelligence Round G).** The text-statistics read (`loadTextStats`, the raw-chunk path before `20261124`) stopped at the ceiling without saying which documents it had not read, so the sheets past the cut showed 0 characters: "Nothing read", counted as textless, and the lens advised paying for AI vision beside its own PARTIAL notice. Now `loadTextStats` stops at a whole document like the entity read and returns the documents it did not reach. They join `notCounted`, get the verdict `not-counted` (shown "Not counted"), and are left out of the textless count and its vision suggestion. Test: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a sheet past the text-stats read is not counted — never 'Nothing read', never sent to vision (fix pass)", which fails against the round's first commit.


**Review fix pass 2 (2026-10-01, intelligence Round G).** Before `20261124`, `loadTextStats` read the full `content` of every chunk in the library on every census GET, for every library, prose included. The base read at most 1,000 rows per slice, and only `document_id` for its textless probe. A 1,000-document standards library would ship about 100 MB through 1,000-row pages inside a 60-second function, and the window is long because `20261124` waits on I-04. Now the pre-migration path selects `document_id` only. It still pages to exhaustion and stops at a whole document, so the per-document chunk counts, and with them the textless count, stay exact. Characters and letter case wait for `knowledge_doc_text_stats()`:
- the route answers `textStats: "counts"` and `chars: null` per sheet, and the panel shows "—" with a note naming the migration;
- a sheet with chunks but no tags is "text-no-tags" by its chunk count;
- without a title block or a reference, it is `looksLike: "unknown"` (shown "Text, no tags"), never guessed to be prose or a drawing;
- no SHX advice is given on an unmeasured sheet (DWG-7).

Test: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "before 20261124 the text statistics COUNT chunks and never ship their content". It asserts that every chunk read selects only `document_id`, and that the readout is measured once the function exists. It fails against the first fix pass.
---

<a id="dwg-12"></a>

## DWG-12 · The entityKindGuard exemption for the locate route no longer describes what that route does — it now contains a library-wide unfiltered slab read

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/__tests__/entityKindGuard.test.ts:28-30`, `app/api/knowledge/locate/route.ts:117-122`, `app/api/knowledge/locate/route.ts:80-83`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The exemption text is stale and the harm is reachable: with no kind filter the hits include kind='ref' rows (a neighbouring sheet's number appearing in an off-page connector note) and kind='opc'/'self' rows, and the scorer at :141-148 ranks only by same-document then page, so a mere reference can win. CitedPageViewer.tsx:449-455 then renders that as `{e.tag} is on {documentName} — jump`. Fair correction to the wording: the read IS bounded to ≤12 tag values (MAX_TAGS at locate/route.ts:35), so 'unfiltered slab' overstates it; the missing kind filter and the stale exemption are the substance and both hold.

**Mechanism.** The guard test exempts the locate route in writing:

    "app/api/knowledge/locate/route.ts": "narrowed to one document+page+tag list — bounded by the caller's tags, never a slab"

That was true of the first read (route.ts:80-83, `.eq("document_id").eq("page").in("tag")`). A second read has since been added for the 'where else is this tag' feature:

    .from("knowledge_page_entities").select("document_id, page, tag")
      .eq("library_id", doc.library_id as string).in("tag", missingHere).limit(1000);

That is library-wide, capped at 1000, and names no kind — exactly the shape the guard exists to catch. The exemption's stated reason ('never a slab') is now false, and because the exemption is keyed by FILE the guard cannot see the new read at all.

Concretely: `tag` is shared across kinds. A drawing number is written as `kind:'self'` on the sheet that owns it and as `kind:'ref'` on every sheet that points at it — potentially hundreds of rows for one popular number. Ask 'where is 025-PID-0107' and the 1000-row budget fills with `ref` occurrences, and the `best` selection (route.ts:139-149, lowest page wins) can hand back a sheet that merely mentions the number instead of the sheet that IS it.

**Failure scenario.** An engineer viewing 025-PID-0104 types a neighbouring sheet's number into the find box. The route reports 'it's on <some sheet that references it>' and jumps them there — where the number appears only in an off-page connector note. The navigation feature whose entire justification is "'V-3 is on 025-PID-0103' is navigation" (route.ts:106-109) sends them to the wrong sheet, confidently.

**Evidence.**

```
lib/__tests__/entityKindGuard.test.ts:28-30 — `"app/api/knowledge/locate/route.ts": "narrowed to one document+page+tag list — bounded by the caller's tags, never a slab",`
app/api/knowledge/locate/route.ts:118-122 — `.from("knowledge_page_entities").select("document_id, page, tag").eq("library_id", doc.library_id as string).in("tag", missingHere).limit(1000);`
app/api/knowledge/locate/route.ts:141-142 — `const score = (h) => (h.document_id === documentId ? 0 : 1_000_000) + h.page;`
lib/knowledgeEntityKinds.ts:34 — `export const TAG_ENTITY_KINDS: readonly EntityKind[] = ["equipment", "ref", "opc", "self"];`
```

> **Verifier correction.** Split the verification. The exemption-drift is CONFIRMED. The concrete harm ('hands back a sheet that merely mentions the number') is SUSPECTED: `missingHere` is capped at MAX_TAGS=12 (:36,54), so the read is bounded on one axis, and it only bites when a caller asks about a drawing NUMBER rather than an equipment tag — reachable via the viewer's free-text find box, but not observable from the repo.

**Done when.**

- [ ] The `elsewhere` query names its kinds — `.in("kind", ["equipment"])` for tag navigation, or `.eq("kind","self")` when the caller typed a drawing number
- [ ] The guard's EXEMPT entries are keyed per-read (or the guard re-checks every occurrence in an exempted file) so a newly added slab read in an exempted file is still caught
- [ ] The exemption text is corrected to describe the reads that actually remain

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29). Against the base route, asking where `025-PID-0106` is, from a sheet that does not carry it, answered with the sheet that merely CITES it (a `ref`) and with the sheet that IS it; the test below fails there. What landed:

- **The read names its kinds.** The `elsewhere` read in `app/api/knowledge/locate/route.ts` asks for `.in("kind", ELSEWHERE_KINDS)` = `equipment` (where a tag occurs) and `self` (the sheet whose title block declares a drawing number), with a stable order. A `ref` or `opc` row is never an answer.
- **Exemptions per read.** `lib/__tests__/entityKindGuard.test.ts` checks every statement in every file. An exemption now names a file AND a snippet of the one statement it covers, and must still match exactly one statement. It is empty today, because every bulk read names its kinds.
- **A read with no limit counts.** A read with no `.limit()` is capped by max-rows all the same, so it counts as bulk unless it is narrowed to one document's page. Writes are never treated as reads.

Tests: `lib/__tests__/entityKindGuard.test.ts`:
- "an exemption covers ONE read: a new slab read in the same file is still caught (DWG-12)", replaying the locate route's history;
- "the locate route's 'where else' read names its kinds";
- "every exemption still matches exactly one read";
- the matcher self-tests, including the no-limit and narrowed-page cases.

`lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a drawing number cited on another sheet (a ref) jumps to the sheet that declares it".

**Done-when.**
- ✓ The `elsewhere` query names its kinds: `equipment` for tag navigation and `self` for a typed drawing number, in one read.
- ✓ The guard's exemptions are keyed per read, and every statement in every file is checked.
- ✓ The exemption text is corrected: the locate route's file-level exemption is gone, because both its reads now pass the guard on their own terms (one names its kinds, the other is narrowed to one document's page).

**Scope / residual.** None.

---

<a id="dwg-13"></a>

## DWG-13 · The route's own contract — 'an unrevised sheet is never re-audited' — is not implemented; sheetsNeedingAudit and buildRelocateUser are dead code

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/drawing/route.ts:10-15`, `app/api/knowledge/drawing/route.ts:386-456`, `lib/drawingAuditLog.ts:118-137`, `lib/drawingLocate.ts:99-115`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both dead-code claims verified by full-repo grep, and the route genuinely recomputes and rewrites all verdicts on every click. A partial mitigation the finding misses: lib/orchestrator/tools.ts:258-285 implements the skip-if-already-audited idea for the AI tool path (`check_audit_history`), so the CONCEPT exists — just not on the route whose header comment claims it. Also note verdictRows omits audited_at, so a rewrite silently keeps the original timestamp on top of the new status.

**Mechanism.** The route header states: "POST { ... action:'record-audit' } → recompute the audit and COMMIT a verdict per sheet to drawing_audit_logs, keyed by (sheet, revision) so an unrevised sheet is never re-audited" (route.ts:10-15). `recordAudit` never reads `drawing_audit_logs` before writing — it recomputes every sheet in the library and upserts all of them. The key does not prevent re-auditing; it only causes overwriting.

`sheetsNeedingAudit` exists, is carefully documented ('skipped never counts as done, because it means we couldn't read the sheet, not that we cleared it'), and is unit-tested across five cases — and has zero production callers. Two differently-shaped searches confirm: a bare-identifier grep across all .ts/.tsx returns only lib/drawingAuditLog.ts:127 (the definition) and the test file; a quoted-string/snake_case grep returns only the test's describe block.

Same pattern in the locate path: `buildRelocateUser` (drawingLocate.ts:102) implements the retry that says 'there is NO pipe line-work near there, so that was almost certainly the equipment summary row' — the exact false-positive LOCATE_SYSTEM warns about at drawingLocate.ts:36-40. A case-insensitive grep for 'relocate' across the repo hits only collections/move (unrelated), serverRetention (unrelated), and the definition. The locate route's refine loop never calls it; on a bad coarse point it just `break`s and keeps the wrong position (locate/route.ts:273).

**Failure scenario.** Doc Control clicks 'Record audit' on a 200-sheet library each week as a routine control. Every click recomputes and rewrites all 200 verdicts — burning the work the record was supposed to eliminate, and, worse, re-deriving verdicts from whatever the index currently holds (see the rev-up finding) and overwriting last week's verdicts with them. Separately, when the vision model points at the equipment summary row along the top of a sheet instead of the drawn vessel, the correction round that was written to catch it never runs, and the wrong position is cached forever (locate/route.ts:282-288).

**Evidence.**

```
app/api/knowledge/drawing/route.ts:13-15 — `//   keyed by (sheet, revision) so an unrevised sheet is never re-audited`
lib/drawingAuditLog.ts:127 — `export function sheetsNeedingAudit(` — searches: `grep -rn "sheetsNeedingAudit" --include=*.ts --include=*.tsx .` → definition + test only; `grep -rn '"sheetsNeedingAudit"\|sheets_needing' -r --include=*.ts .` → test only
lib/drawingLocate.ts:102 — `export function buildRelocateUser(` — search: `grep -rni "buildRelocateUser|relocate" --include=*.ts --include=*.tsx .` → definition only (plus two unrelated 'relocated' comments)
app/api/knowledge/locate/route.ts:273 — `if (!fp) break;` (keeps the coarse point; no relocate round)
```

> **Verifier correction.** One partial mitigation on a different surface, worth naming so a fixer doesn't duplicate it: lib/orchestrator/tools.ts:258-285 exposes `check_audit_history`, whose description tells the model 'Call this BEFORE auditing anything — re-auditing an unrevised sheet is wasted work.' That covers the agent path only; the route's own contract remains unimplemented, and the tool is a model-discretion prompt, not an enforcement.

**Done when.**

- [ ] `recordAudit` loads prior verdicts for the library's sheets and runs them through `sheetsNeedingAudit` before recomputing, or the route header is corrected to say what it actually does
- [ ] The response distinguishes 'recorded' from 'already recorded at this revision' so the operator sees the work being skipped
- [ ] The refine loop calls `buildRelocateUser` when the close-up returns no sighting, instead of silently keeping a point it just failed to confirm
- [ ] Any function that stays unwired is deleted, not left documented and tested as if it were live

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29). Against the base route a second "Record audit" re-wrote every verdict, and a close-up that did not see the tag kept (and cached) the coarse point. The tests below fail there. What landed:

- **`sheetsNeedingAudit` is wired.** `recordAudit` (`app/api/knowledge/drawing/route.ts`) loads this library's prior verdicts and runs the sheets through it before writing. A sheet recorded at the revision in front of it with anything but `skipped` is not re-audited and not rewritten. `skipped` never counts as done, and neither does a verdict under an unknown revision (`""`; review fix pass below).
- **The response says what was skipped.** It distinguishes `recorded` from `alreadyRecorded` (sheet, revision, stored status) and from `notRecorded` (with the reason). The panel shows all three. The route header now describes what the route does.
- **The time is written every time.** `verdictRows` writes `audited_at` on every write, so a `skipped` row later re-recorded carries when it was decided.
- **`buildRelocateUser` is wired.** In `app/api/knowledge/locate/route.ts`, a FIRST close-up that does not see the tag refutes the coarse point. One relocate round asks again on the whole page, told where the wrong answer was. Its prompt (`lib/drawingLocate.ts`) now says what was actually observed: "a close-up of that spot does NOT show the tag … If you cannot see it, omit it". The old prompt claimed "no pipe line-work near there".
  - A relocated point is cached as an estimate. If the round finds nothing, or returns the same spot, the tag is reported not visible and nothing is cached.
  - A close-up that fails on a provider error keeps the coarser point: it neither confirms nor refutes it.
  - What is never cached is a point a close-up REFUTED. A point no close-up checked — a tag past the first four (`REFINE_MAX`), or one the loop never reached because time, the cap, a provider error or the canvas stopped it — keeps its coarse point and is cached as the estimate it is: approximate, labelled so, rejectable (PR-10). (This round's first record said "a point no round confirmed is never cached", which overstated it; corrected in the review fix pass.)

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "a second record writes nothing and lists every sheet as already recorded at its revision";
  - "a 'skipped' verdict is re-audited once the sheet can be read — re-stamped, never lowered";
  - "a close-up that does not see the tag triggers buildRelocateUser; the relocated point is cached as an estimate";
  - "when the relocate round finds nothing either, the tag is not visible and nothing is cached".
- `lib/__tests__/drawingLocate.test.ts` "buildRelocateUser — the relocate round says what was actually observed".

**Done-when.**
- ✓ `recordAudit` loads prior verdicts for the library's sheets and runs them through `sheetsNeedingAudit` before recomputing. An unrevised sheet is never re-audited where "unrevised" can be established: a known revision, and a stored row that covered this sheet from the index it holds now (review fix pass 2). Since review fix pass 3 the row must also have been computed from the indexes the sheets it points at hold now, against the same set. A sheet under an unknown revision is audited every time. Review fix pass 4 refused to record anything while a sheet of the library was being indexed (409). Since review fix pass 5 nothing is refused: a verdict that waits on a sheet not read whole yet is provisional, and it never overwrites a settled one. (That did not hold until review fix pass 6. A gap that a document mid-index had yet to read, and a connector into a document reset by a rebuild, were filed settled; and under an unknown revision a provisional verdict overwrote a settled row. See below. Nor did it hold after review fix pass 6. Under an unknown revision a provisional verdict still lowered a provisional row that had settled `broken_connectors`. A sibling sheet's settled `passed` overwrote the shared row while the sheet with the broken box was parked or reset. A gap was dropped while the document that made its series held was reset. See review fix pass 7 below. Nor did it hold after review fix pass 7, corrected in review fix pass 8. A document still mid-read with a page already queued for AI vision, a parked document's unread page, and a per-sheet PDF reset or failed while its drawing's other PDF declared the bare number each let a settled verdict be filed for good at a known revision, or lowered under an unknown one. See review fix pass 8 below. Nor did it fully hold after review fix pass 8, corrected in review fix pass 9. A provisional verdict filed at a known revision was judged again only when the label or index of the document it waited on changed. A parked document whose partial index a controller then accepted, or whose indexing then failed, keeps the same "page(s) N never read", so the row was "already recorded" for good: `flagged`, where the settled computation was `passed`. A provisional row is now judged again on every record until it settles. See review fix pass 9 below.)
- ✓ The response distinguishes "recorded" from "already recorded at this revision".
- ✓ The refine loop calls `buildRelocateUser` when the close-up returns no sighting, instead of silently keeping a point it just failed to confirm.
- ✓ No function stays unwired: `sheetsNeedingAudit` and `buildRelocateUser` both have production callers now.

**Scope / residual.** The orchestrator's `check_audit_history` reads by `(org_id, sheet_number)` and now sees one row per library. That is I-04's tool; the final key is under DWG-6.

**Review fix pass (2026-10-01, intelligence Round G).** Two corrections.
- **An unknown revision is never "unrevised".** `recordAudit` files `revision ""` for every library-only sheet (and a mirror with no label on either side). `sheetsNeedingAudit` treated a prior `""` row as done for good, so a library-only PDF recorded `flagged` ("References 025-PID-0107, which isn't in the set") kept that verdict after 0107 was uploaded or the PDF replaced — every later record answered "already recorded at this revision", and the panel promised it would not need auditing "until revised", which can never happen. Now a `""` row never counts as done (`sheetsNeedingAudit`), and the latest non-`skipped` verdict replaces it (`mayReplaceStored` in `lib/drawingAuditLog.ts`, used by the route in place of the bare `wouldLowerSeverity` check); `skipped` still never erases a verdict, and a known revision's verdict is still never lowered. The panel's line now says a sheet whose revision is not known is audited every time. A real revision for library-only sheets (the title block's REV, read at ingest) would let them be keyed too; that is a further change, not made here.
- **The caching claim, restated** (bullet above): a refuted point is never cached; an unchecked coarse point is cached as an approximate estimate. The route header and `lib/drawingLocate.ts` say the same.

Tests: `lib/__tests__/drawingAuditLog.test.ts` "never treats a verdict under an UNKNOWN revision as done — 'unrevised' can't be established (fix pass)" and "mayReplaceStored — the latest verdict, never a lower one at a known revision"; `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a sheet whose revision is unknown is re-audited every time, and its row takes the latest verdict (fix pass)" (flagged → passed once the set is widened, one row; a sheet that cannot be read keeps its verdict, reported under `keptStored`) and "a point no close-up checked (past REFINE_MAX) is cached as the coarse estimate it is — approximate, rejectable". The `""` tests fail against the round's first commit. The DWG-13 route tests now mirror every Crude Unit sheet with a revision, so "a second record writes nothing" exercises the known-revision rule it states.


**Review fix pass 2 (2026-10-01, intelligence Round G).** "Skipped never counts as done" and "unrevised is never re-audited" both read the record by KEY. Two gaps followed.
- **Sibling sheets.** Every per-sheet document of a multi-sheet drawing is filed under the drawing's number. Once any one was recorded non-`skipped` at a revision, every sibling was "already recorded". That included a sibling skipped in that run (`bestByKey` kept the sibling's `passed`) and one added later.
- **A rebuild.** A verdict computed from an older index stayed final after a rebuild, the one the route itself tells users to pay for. A sheet recorded `passed` before its boxes were transcribed kept `passed` after the re-read transcribed `OPC 15: DWG NONE`.

Now each row records what it covered. `audit_details.coverage` maps each knowledge document merged into the row, if it was read (`skipped` covers nothing), to the fingerprint of the index it was computed from. `indexFingerprint` in `lib/drawingAuditLog.ts` digests the document's roll-up rows, connector lines and unread pages, independent of row order.

`sheetsNeedingAudit(sheets, prior, fingerprints)` counts a key as done only when every current document filed under it is on the row's coverage with an unchanged fingerprint. A key that is not done is recomputed from all its documents, still never lowered (`mayReplaceStored`). A row with no coverage (written before this, or by another writer) is audited once more. A rebuild that extracts the same rows changes nothing. One that changes them re-audits that sheet at the same revision.

The `sheetsNeedingAudit` comment named a nonexistent `unknownRevisionReplaceable`; it now names `mayReplaceStored`.

Tests:
- `lib/__tests__/drawingAuditLog.test.ts`:
  - "a row is done only for the documents it covered — a sibling sheet under the same number is not";
  - "a row is done only for the index it was computed from — a rebuild that changed it re-audits";
  - "a row with no coverage … is audited once more";
  - the `indexFingerprint` block.
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "a sibling's verdict never stands for a sheet that was skipped: once SH2 is read, the shared row is re-audited" (`passed` covering SH1 → `broken_connectors` covering both → done);
  - "a rebuild that changed a sheet's index re-audits it at the same revision: the new NONE box is recorded broken".

Each fails against the first fix pass. Residual: a stored verdict that a recomputation would lower stays, reported under `keptStored`, and its row is recomputed on each record until a recomputation is at least as severe.

**Review fix pass 3 (2026-10-01, intelligence Round G).** Fix pass 2's coverage fingerprinted only each sheet's OWN index. A verdict also depends on other sheets:
- whether the sheet a box continues on had its box numbers read, and includes this box;
- whether a referenced sheet references back;
- whether a referenced sheet is loaded, and whether the library holds its series.

So when only a neighbour changed, the verdict stayed frozen, and "already recorded" stood. For example, 0104 was recorded `flagged` because 0105's box numbers were never read. 0105 was then rev-upped and vision-read with boxes {7, 9}. The lens listed box 14 as unreturned, but the record still said `flagged`. The same happened when 0104 was `passed` against an older 0105 that still carried box 14. Now:
- **The basis.** Each coverage entry is `verdictBasis(own, neighbours, set)` (`lib/drawingAuditLog.ts`). It holds the document's `indexFingerprint`; the fingerprint of every document its connectors pair against (`auditOpcBoxes(...).targetsByDoc`) and its references resolve to (`drawingRefTargets`, which shares the reference audit's resolver in `lib/drawingText.ts`); and a digest of every number the library's sheets answer to. It is written as `<own>+<neighbourhood digest>`.
- **What re-audits.** `sheetsNeedingAudit` compares the whole basis. A change in a sheet a verdict depends on re-audits it at the same revision, and so does a change in the set (a sheet added that makes a series held, or that fills a gap). Each is still never lowered (`mayReplaceStored`).
- **While anything is being indexed.** A half-built neighbour must never re-decide a verdict: it would file "unpaired" or a gap that is not there, and the raised verdict could not be lowered again. So when any sheet of the library is being indexed (not ready, not in error, not parked), only each sheet's own index is compared (`basisIndexPart`, the `indexOnly` option). The response lists those sheets (`indexingNow`), and the panel says to record again once indexing finishes. (Corrected in review fix pass 4: this did not hold. It chose which sheets are re-audited, not what they are judged against; see below.)
- **Old rows.** A row written before this (a bare fingerprint) is audited once more, never lowered.

Tests:
- `lib/__tests__/drawingAuditLog.test.ts`, block "verdictBasis — a verdict stands only while its neighbours and its set are what it was computed from" (the basis, and `sheetsNeedingAudit` with and without `indexOnly`).
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-13 — a verdict that depends on a neighbour is re-judged when the neighbour changes":
  - the reviewer's two scenarios: flagged → `broken_connectors` after 0105's rev-up and re-read; passed → `broken_connectors` after 0105 dropped box 14 at the same revision;
  - a sheet added that makes 025-PID held re-judges Tank Farm's 0104 as `flagged`;
  - while 0105 is being indexed nothing is re-decided by it, and it is re-judged once 0105 is ready.
- "a rebuild that changed a sheet's index re-audits it" now expects 0104 and 0106, which point at 0105, to be re-judged too.

Each fails against fix pass 2 (`4e549d0`).

Residual:
- A sheet parked waiting on AI vision counts as settled: its index is whole apart from the pages it waits on, and it does not change until the retry runs. (Corrected in review fix pass 4: it is not settled. A parked sheet is not read whole, and what is not found on it is unchecked; see below.)
- The neighbours are the sheets a verdict resolved to. A number that names a whole multi-sheet set links to no single sheet, so its sheets' contents are not part of the basis. Their membership is, through the set digest.

**Review fix pass 4 (2026-10-01, intelligence Round G).** Two claims above did not hold. They share one root. A verdict at a known revision is never lowered (`RANK` / `mayReplaceStored`), so any verdict computed from incomplete neighbour data becomes permanent. The base rewrote verdicts on every record, so the same errors used to be transient.

**"Nothing is re-decided while a sheet is being indexed."** The `indexOnly` guard decided only WHICH sheets were re-audited. A sheet re-audited for another reason was still judged against a neighbour being indexed. The other reasons are its own index changing, the sheet being new, or a sibling under its key changing. The reviewer reproduced it through the route:
1. 0104 is `passed` at C.
2. A library-wide rebuild resets 0105 (`stale`, entities cleared) after 0104 was re-read with one extra row.
3. "Record audit" files 0104 `flagged` ("References 025-PID-0105.pdf, which never references back"), plus a junk `025-PID-0105.pdf@A skipped` row.
4. 0105 finishes with identical rows, and the `flagged` stays.

Comparing neighbours cannot fix this either: a sheet being indexed has lost its self rows, so references to it no longer resolve. Now:
- **Nothing is recorded while any sheet of the library is being indexed** (queued or mid-read: not ready, not failed, not parked). `recordAudit` answers 409 with `indexingNow` and the message "N sheet(s) are being indexed right now (…) — nothing was recorded: a verdict judged against a half-built index would be filed for good. Record the audit once indexing finishes." `apiPost` throws it, and the panel shows it as the error toast. (Replaced in review fix pass 5. That blocked the whole library behind any one document in flight, and it did nothing for a parked or failed neighbour, which is just as transient; see below.)
- **Removed:** the `indexOnly` option, `basisIndexPart`, the response's `indexingNow` on success, and the panel's "no verdict was re-decided" line.

**"A sheet parked waiting on AI vision counts as settled."** It is not read whole: its unread pages may hold the box, or the reference back, that a sheet pointing at it needs. `notReadWhole` (route) collects, with why, every document with `vision_failed_pages` (parked, accepted partial, failed run), every failed one, and every one not finished. It is passed to `auditDrawingRefs` as a new `incomplete` argument (`lib/drawingText.ts`):
- a reference back not found on such a target is `oneWayUnread`, never `oneWay`;
- a missing sheet that such a document may hold is `missingUnread`, never a gap. That is a sheet of the document's own drawing, or any sheet when the document's own number was never read.

`verdictsForSheets` files both as `uncheckedReferences`, for example "References 025-PID-0105.pdf, which was not read whole (page(s) 2 never read) — whether it references back was not checked". They are `flagged`, the same severity as one-way or missing, with a true text. The lens returns them in `audit` and adds a suggestion naming the sheets. Boxes get the same rule; see DWG-4.

**Re-judged when it is read whole.** A target that a verdict pairs or resolves to is already in its basis. A document that a missing sheet "may be in" is not, so the set digest now also names the documents not read whole, with why. When one of them is read whole, every sheet is re-judged, and verdicts that come out the same are re-stamped.

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "while a sheet is being indexed nothing is recorded (409, naming it) — a sheet re-audited for its own change is never judged against the half-built one". This is the reviewer's half-built probe through the route, and it replaces fix pass 3's "while a sheet is being indexed, no verdict is re-decided …". The record answers 409 and writes nothing. Once 0105 finishes, 0104 is `passed` and no row exists under 0105's filename.
  - Block "DWG-4 / DWG-13 — a neighbour not read whole is no evidence of what it lacks":
    - the parked-neighbour probe;
    - the accepted-partial variant, with the reference back on the unread page;
    - "a sheet not found in what was read of the set is no gap while the sheet that may hold it is parked — and is judged once it is read whole".
  - Three tests that used a sheet mid-index to stand for "cannot be read right now" now use a failed or parked one.
  - "a 'skipped' verdict is re-audited once the sheet can be read" now expects all three sheets re-judged, because the set held a sheet not read whole.
- `lib/__tests__/drawingText.test.ts` "a reference back, or a sheet, not found on a sheet not read whole is unchecked — never one-way, never a gap".
- `lib/__tests__/drawingAuditLog.test.ts`: "a reference back, or a sheet, not found on a sheet not read whole is an unchecked reference". The `verdictBasis` block no longer tests `indexOnly`.
- `lib/__tests__/drawingIntelPanelRebuild.test.ts` "while a sheet is being indexed the record is refused: the route's message is the toast …".

All but the panel test fail against fix pass 3 (`f41a1a8`). The panel test pins the toast, which the old panel also showed for a refused call.

Residual:
- Suppose a `flagged` was filed for a check that needed a sheet not read whole. Once that sheet is read and the check passes, the `flagged` stays at that revision, with the reason it was filed: it is never lowered, like any unpaired box. It is reported under `keptStored`. (Corrected in review fix pass 5. This understated the defect, and "reported under `keptStored`" reached no user: the panel never showed `keptStored`. The same rule also let a parked neighbour overwrite a VERIFIED `passed` with `flagged` for good. A `flagged` of that kind is now provisional and heals; see below.)
- While any sheet of a library is being indexed, nothing in that library can be recorded. (No longer true since review fix pass 5.)
- An accepted partial index never changes, so a check that needed its unread pages stays unchecked.

**Review fix pass 5 (2026-10-01, intelligence Round G).** Fix pass 4's root-cause paragraph above names the defect: a verdict at a known revision is never lowered, so any verdict computed from incomplete neighbour data becomes permanent. Fix pass 4 then applied that reasoning only to documents in flight (the 409), and none of it to parked or failed ones, which are just as transient. The reviewer reproduced it through the route:
1. 0104 and 0105 carry box 14 both ways, and 0104 is recorded `passed` at C.
2. A rebuild re-reads 0105, and its page 2 (box 14, and the reference back) parks on a vision error. The record wrote 0104 `flagged` at C ("…not read whole (page(s) 2 never read) — the pairing was not checked").
3. The retry read page 2 and the index was identical to before. The record computed `passed`, but `keptStored` kept `flagged`.

From then on every record re-judged 0104 and kept it `flagged` at C until the drawing was revised. `check_audit_history` would report a clean sheet as "already audited" `flagged`. Now:
- **A provisional verdict.** A finding whose check needed a document that is not read whole only FOR NOW (parked on AI vision, failed, or still being indexed, as opposed to an accepted partial index, which never changes) waits on that document. The route computes these with `forNowIncomplete` (`app/api/knowledge/drawing/route.ts`) and passes `waitsOn` with each unchecked finding: an unpaired box with `unread`, `oneWayUnread`, and `missingUnread`. `verdictsForSheets` (`lib/drawingAuditLog.ts`) then marks the verdict `provisional`, with `waitingOn` (the documents, with why) and `settledStatus`. `settledStatus` is the verdict without those findings: what the sheet is known to be whatever they turn out to hold. `verdictRows` writes it to `audit_details.provisional`.
- **What a row settled is what is never lowered.** `replaceDecision(stored, next)` replaces `mayReplaceStored` in the route (which `mayReplaceStored` now wraps). It returns one of three outcomes:
  - `write`;
  - `keep` (it would lower what the row settled);
  - `wait`: the row and its coverage are left untouched, and the sheet is reported under `waitingOn`.

  How it decides:
  - A provisional verdict changes a settled row only when what IT settled is more severe, which is a real finding. Otherwise it waits. A parked neighbour never turns a verified `passed` into `flagged`.
  - A provisional verdict replaces a provisional row whenever it settles no less.
  - A settled verdict replaces a provisional row down to that row's settled status. So what was filed while a neighbour was unread heals once it is read.
  - Unknown revisions, and another library's row on the org-wide key, follow the old rules. (Corrected in review fix pass 6: under an unknown revision a provisional verdict overwrote a settled row, which lowered a verified `broken_connectors`. Over a settled row it now follows the provisional rule there too; see below. Corrected again in review fix pass 7: over a provisional `""` row the latest was still written, whatever that row had settled. The provisional rule now holds there too; see below.)
- **Merged per key** by `mergeVerdictsByKey` (moved from the route into `lib/drawingAuditLog.ts`): the severer verdict and every document it covers, provisional when any member is, settled at the severest settled status. (Corrected in review fix pass 7: take a member `skipped`, or not filed at all, because it was not read whole for now. It did not make the verdict provisional, so the other member's settled verdict was written over the shared row; see below.)
- **Nothing is refused while a sheet is being indexed.** The 409, `indexingNowOf` and `indexingNow` are gone (the reviewer's minor 4). A document in flight is not read whole (`notReadWhole`), so what is not found on it is unchecked and provisional. One gap remained. A sheet that a combined PDF, still being indexed, has not read yet was filed as a GAP, which is settled and never lowered once read: `mayHold` counted only the document's own drawing. Now a document not read whole may hold any sheet of a series it declares a number of (`auditDrawingRefs`, `lib/drawingText.ts`). The same applies to a parked combined PDF. (Corrected in review fix pass 6: that closed the path only for a series the document had already declared. A combined PDF of several series, or a document reset by a rebuild under an unrelated filename, still filed a settled gap. The series rule also let one accepted-partial single-drawing PDF silence every gap of its series for good. See below.)
- **Every referencer.** A missing sheet is filed against every sheet that references it, not the lens's first six (see DWG-6).
- **The panel says what was left as stored.** `components/knowledge/DrawingIntelPanel.tsx` renders `keptStored` ("025-PID-0104 rev C: kept flagged — computed passed now") and `waitingOn` ("… waiting on 025-PID-0105.pdf (page(s) 2 never read) — judged again once it is") in the "Audit recorded" block, and the toast counts both. Before this, the records said a kept verdict was "reported in keptStored", but only the JSON carried it.

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`:
  - "a verified passed is never raised by a neighbour that is only parked: it waits, and is passed again once the page is read". This is the reviewer's probe: `passed`@C, neighbour parked, record (the row and its `audited_at` untouched, `waitingOn` names 0104), retry, record (`passed`), and then done.
  - "a box on a parked neighbour's unread page …": the first record is now `provisional` (`settledStatus: "passed"`), and after the retry the row is `passed`. Fix pass 4 kept `flagged`.
  - "while a sheet is being indexed the record goes on …". It replaces fix pass 4's 409 test: 200, nothing settled overwritten, `waitingOn` 0104 and 0106, and 0105 is never filed under its filename.
  - "a combined PDF mid-index: a drawing of its series it has not read yet is no gap — provisional — and is settled once it is read".
- `lib/__tests__/drawingAuditLog.test.ts`, block "a finding that waits on a sheet not read whole FOR NOW is provisional — never settled": `verdictsForSheets`, the `replaceDecision` table, `storedProvisional`, `mergeVerdictsByKey`, `verdictRows`.
- `lib/__tests__/drawingText.test.ts` "a reference back, or a sheet, not found on a sheet not read whole …" now expects 025-PID-0199 to be unchecked (it may be on 0105's unread page), and a series 0105 declares nothing of to stay a gap.
- `lib/__tests__/drawingIntelPanelRebuild.test.ts` (rendered): "a stored verdict kept, or left waiting, is shown with what was computed now — and the toast counts both". "A refused record (a partial index) is the toast" replaces the 409 toast test.

Each fails against fix pass 4 (`b41bdca`), except "a refused record … is the toast": the old panel toasted a refused call too.

Residual:
- A `flagged` that waits on nothing transient is settled and still never lowered. That covers an unpaired box into a text-layer sheet that is later vision-read, and an unchecked check against an accepted partial index. The panel now shows it under "kept".
- A verdict computed while a connector's destination was still being indexed, with its self rows cleared, may be a premature `passed`: the connector resolves to no sheet. It can only be raised later, never stuck. The set digest names the document in flight, so every sheet is judged again once it is read. (Corrected in review fix pass 6: this understated it. Under an unknown revision the settled `passed` overwrote a recorded `broken_connectors`. At a known revision it stood until someone recorded again. Such a connector is now `unpaired` and provisional; see below and DWG-4.)
- `log_audit_completion` (I-04) writes no `provisional` marker and compares by status. A provisional row it meets is just a row at that status, which is never lower than what the row settled, so nothing is lost.
- A page skipped for lack of a key or for the cap is not tracked as unread (DWG-7, handed to I-06).

**Review fix pass 6 (2026-10-01, intelligence Round G).** Fix pass 5's done-when said a verdict that waits on a sheet not read whole yet "never overwrites a settled one". Its route test's header said "nothing it has yet to read is filed for good". Neither held. Four defects, and one widening that went too far:

**1. A settled gap mid-index (the reviewer's blocker, probe A).** `mayHold` let a document that is not read whole hold only sheets of a series it had already declared, or one its filename carried. The reviewer's library:
- 0104 (rev C) references 0105, and 0106 is also in the library.
- "Unit PIDs.pdf" is a combined PDF: 026-PID-0201 on page 1, 025-PID-0105 on page 2.
- 0104 is recorded `passed`@C.

"Unit PIDs.pdf" is then rebuilt, and has re-read only page 1. A record filed 0104 `flagged`@C ("References 025-PID-0105, which isn't in the set"), settled. When the PDF finished, the computed `passed` was kept below the stored `flagged`: a permanent false gap. A document reset by a rebuild whose filename carries an unrelated number did the same.

Now `auditDrawingRefs` takes `inProgress`: the documents still being read, parked or in flight (`stillBeingRead` in `app/api/knowledge/drawing/route.ts`). Such a document may hold ANY sheet the set is missing. So each missing sheet is `missingUnread`, waiting on that document, and provisional. The lens and the record pass the same set. (Corrected in review fix pass 7. "Parked" let a numbered single-drawing PDF parked under the monthly cap suspend every real gap in every series until next month. Only a document in flight may hold any sheet now. Also, the route then dropped a `missingUnread` outside the held series, and the document being read could be what made the series held. See below.)

**2. The series rule went too far (the reviewer's minor 6).** For a document that changes only when a person acts (an accepted partial index, or a failed document), fix pass 5 let any declared series count. So one accepted-partial single-drawing PDF, such as 025-PID-0107.pdf with page 2 unread, turned every gap in 025-PID into a permanent "unchecked". Such a document may now hold three things:
- a sheet of its own drawing;
- a drawing of a series it declares, but only when it declares two or more different drawings (a combined PDF);
- anything at all, when its number was never read.

The lens shows at most six documents that may hold a missing sheet, and the record still has every id (`maybeInIds`).

**3. A connector into a document reset by a rebuild (major, probes C and D).** See DWG-4. It is now `unpaired`, and it waits on the documents still being read that may hold it.

**4. Unknown revisions (minor, probe B).** `replaceDecision` (`lib/drawingAuditLog.ts`) wrote any non-skipped computation over a `""` row, provisional ones included. So a verdict waiting on a parked neighbour overwrote a verified `broken_connectors` with `flagged`. Now a provisional verdict over a settled row follows the known-revision rule under any revision: it writes only when what it settled is more severe, and otherwise it waits. Under `""`, a settled computation is still the latest verdict, and over a provisional `""` row the latest is written. (Corrected in review fix pass 7: "over a provisional `""` row the latest is written" lowered a row that had settled `broken_connectors`. A provisional verdict now never lowers what any row settled. While a document is in flight, a settled computation under `""` that would lower the row waits. See below.)

**5. A failed document (minor, probe E).** `forNowIncomplete` treats a failed document as transient. A failed document whose number was never read held every reference in the library. So every later gap waited over settled rows for as long as that document stayed failed, and a real gap was never recorded on a sheet already filed `passed`. But a failed document is read again only when a person re-indexes it (`markIngestFailed` stops retrying at the bound).
- **A missing sheet never waits on a failed document.** `stillBeingRead` excludes status `error`. A failed document may hold a missing sheet only by the settled rule (item 2), and the finding is a settled, unchecked `flagged`: "…it may be in scan_001.pdf (its indexing failed), not read whole".
- **A finding about the failed document ITSELF still waits on it.** That is a box, or a reference back, not found on it. A failed neighbour therefore never raises a verified `passed` for good. The finding is named "(its indexing failed — re-index it)", and the panel's waiting line shows it. (Corrected in review fix pass 7: this did not cover a connector into a document whose re-index failed after a rebuild cleared its title block. No document declared the destination, so the connector was dropped, and the source was filed a settled `passed`. See DWG-4.)

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-13 / DWG-4 — what a document still being read may hold is never filed settled, and a provisional verdict never overwrites a settled one under any revision":
  - probe A: `passed`; rebuild; the record waits and the row is untouched; the PDF finishes; `passed`, with nothing kept;
  - first recorded mid-rebuild: provisional, then `passed`;
  - probes B, C, D and E;
  - "a finding about a failed document itself still waits on it, and says to re-index it";
  - probe F (DWG-4).
- The describe title fix pass 5 gave the combined-PDF test said "nothing it has yet to read is filed for good". It now names what that test covers.
- `lib/__tests__/drawingText.test.ts` "a reference back, or a sheet, not found on a sheet not read whole …" now runs three cases:
  - still being read: 0199 and 040-TK-0009 are unchecked and waiting;
  - an accepted partial single drawing: both are gaps;
  - a settled combined PDF: 0199 is unchecked, and 040-TK-0009 is a gap.

  Fix pass 5's line "040-TK-0009 cannot be on it: a gap" encoded the hole, and it is gone.
- `lib/__tests__/drawingText.test.ts` "a document still being read may hold a sheet of a series it has not declared yet — or under a filename that names something else": probe A at the lib, the unrelated filename, and the six-name cap.
- `lib/__tests__/drawingAuditLog.test.ts`: the `replaceDecision` table's `""` rows.

Each fails against fix pass 5 (`2c1e254`).

Residual (this replaces fix pass 5's list):
- A `flagged` that waits on nothing transient is settled, and at a known revision it is never lowered. That covers an unpaired box into a text-layer page that is later read by vision, an unchecked check against an accepted partial index, and, since this pass, an unchecked gap that a failed document may hold. The panel shows these under "kept".
- A finding about a failed document itself waits on it until someone re-indexes or removes that document. Meanwhile the sheet's row stays as it was settled.
- While any document is still being read, every sheet the set is missing is unchecked (provisional), not a gap, so the lens counts no gap then. Each is judged once the document is read, because the set digest names it. (Corrected in review fix pass 7. That was false when the document being read was what made the series held: the finding was dropped, and a recorded `""` gap was overwritten with `passed`. It also counted a parked document as being read. See below.)
- A connector into a document reset by a rebuild, named for an unrelated series and the only holder of the destination's series: see DWG-4's residual.
- `log_audit_completion` (I-04) writes no `provisional` marker and compares by status. A provisional row it meets is just a row at that status, which is never lower than what the row settled, so nothing is lost.
- A page skipped for lack of a key or for the cap is not tracked as unread (DWG-7, handed to I-06).

**Review fix pass 7 (2026-10-01, intelligence Round G).** Fix pass 6's done-when said a provisional verdict "never overwrites a settled one … under any revision, unknown included". Its residual said "while any document is still being read, every sheet the set is missing is unchecked (provisional), not a gap". Neither held. And its "may hold ANY sheet" let a parked document suspend real gaps for as long as it stayed parked.

**1. A provisional verdict over a provisional unrevised row (the reviewer's probe provprov, major).** `replaceDecision` wrote any provisional verdict over a provisional `""` row (its `latestWins` branch). Such a row can have SETTLED `broken_connectors`. In the probe, 0104's box 14 was verified unreturned on 0105, while box 15 waited on a parked 0106. A rebuild then reset 0105, so box 14 waited too, and the computation settled `passed`. The row was overwritten with `flagged`, and its broken connector was gone. Now a provisional verdict never lowers what a row settled, under any revision, whether the row is provisional or settled. A settled computation still heals a provisional row down to what it settled.

**2. A sibling under the same key (the reviewer's probes sib and sib2, major).** Per-sheet PDFs of one drawing share its key. A member that is parked or in flight is `skipped`. A member reset by a rebuild has no number yet and is not filed (`notRecorded`). Either way its findings were not in the merged verdict, which was then the other sheet's settled `passed`. Under `""` that overwrote the shared `broken_connectors`, and coverage went from {s1, s2} to {s1}. Now:
- `mergeVerdictsByKey` takes `pendingOf`. A `skipped` member that is not read whole only for now makes the merged verdict provisional, waiting on it, and settled at what the other members settled.
- `awaitingFiled` (`lib/drawingAuditLog.ts`) does the same for a document the stored row covered, when this verdict does not cover it and it is not read whole for now. The route applies it before `replaceDecision`.
- A `skipped` verdict is left as it is; it never erases a verdict.

**3. The document that made a series held (the reviewer's probe held, major).** The route filtered `missingUnread` through the held series, counted from what is declared NOW. Take a reset document whose filename carries no number (`scan_b.pdf`). It declares nothing, so 025-PID stopped being held, and the unchecked 0199 and 0105 were dropped. A settled `passed` then overwrote the `""` gap. Now `missingUnreadInScope` keeps an unchecked missing sheet whatever the held series, while a document still being read may hold it. The lens and the record share it.

**4. Under an unknown revision, nothing is lowered while a document is in flight.** What a document in flight has yet to declare can take a finding out of the set's scope altogether. Examples are a series that only it held, under a filename naming another series (fix pass 6's DWG-4 residual), or a destination that only it declared. Now `replaceDecision` takes `inFlight`. Under `""`, while any document is in flight, a settled computation that would lower what the row settled waits, and the response names those documents. It is judged again once they are read, because the set digest names them. A settled computation that raises or matches the row is written, as before. With nothing in flight the latest is written, as before. A known revision is unchanged: never lowered. (Corrected in review fix pass 8: in flight only. A parked document's unread page can be the only declaration of a destination outside the set's scope, so the connector into it was dropped and the row lowered. The guard now covers every document still being read, in flight or parked; see below.)

**5. A parked document holds by the settled rule (the reviewer's minor, probe parked).** Fix pass 6 let every document still being read (`stillBeingRead`, parked or in flight) hold ANY missing sheet. Take a numbered single-drawing PDF, parked by the monthly cap until next month, or for good in a keyless library. It suspended every real gap in every series for as long as it stayed parked. Now only a document in flight may hold any sheet (`inFlightOf` in the route). In flight means one of these:
- queued, mid-read or stale;
- parked with no unread page known yet (a failed batch's back-off);
- parked with no title block read (reset, or never numbered).

A parked document whose number is declared, and whose unread pages are known, holds by the settled rule: its own drawing, or a series it declares two drawings of. What it holds still waits on it. Box pairing uses the same sets (DWG-4).

(Corrected in review fix pass 8. The definition above is not what `inFlightOf` implemented. It counted a document as parked once it had a page queued for AI vision and a title-block row. So a combined PDF still mid-read, whose first batch had queued page 3, held only by the settled rule, and a sheet on a page it had yet to reach was filed a SETTLED gap: at rev B never lowered once the PDF finished (probe midread-ref). It counted a parked scan numbered only by its filename as in flight, because it had no title-block row, so that scan still suspended every gap in every series (the reviewer's minor). And "what it holds still waits on it" left out what it did not hold by the settled rule. A gap on its unread page under another number was filed settled (probe parked2), and a connector into that page was dropped (probe parked-opc, DWG-4). See below.)

**6. Payload (major).** Every provisional row stored the full `waitingOn` list, and so did the response: mid-rebuild, that was every document in flight. The reviewer measured a 4.41 MB response and a 4.44 MB upsert at 600 sheets, which is the platform's response limit. Now the stored row and the response name at most six documents (`WAITING_NAMES_MAX`, `capWaitingOn`) and count the rest ("294 more document(s) not read whole"). The lens returns at most six `maybeInIds` per finding. On the same probe: a 0.66 MB response, and 0.68 MB of `audit_details`.

Tests:
- `lib/__tests__/drawingAuditLog.test.ts`:
  - the `replaceDecision` table's provisional `""` rows (probe provprov) and its `inFlight` rows;
  - "a sibling not read whole for now leaves the shared verdict provisional — skipped in the group, or covered by the stored row";
  - "verdictRows names at most six documents a verdict waits on, and counts the rest";
  - "an unchecked missing sheet a document still being read may hold is judged whatever the held series now".
- `lib/__tests__/drawingText.test.ts` "a parked document whose number is declared holds by the settled rule — only one in flight may hold any sheet". This pins the lib's rule. It is a positive control: what changed is which set the route passes.
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-13 / DWG-4 — no verdict is lowered under an unknown revision for what a document not read whole may yet hold, and a large library mid-rebuild stays fast and small (review fix pass 7)":
  - probes provprov, sib2, sib, held and parked;
  - the in-flight rule, on a reset combined PDF under an unrelated filename; with nothing in flight the latest is written;
  - 600 sheets mid-rebuild: the response and `audit_details` stay under 1 MB, with at most seven names; the time is bounded; the lens stays under 1 MB.

Each new route test fails against fix pass 6 (`85e1648`), and so does every new lib test except the positive control.

Residual (this replaces fix pass 6's list):
- A `flagged` that waits on nothing transient is settled, and at a known revision it is never lowered. That covers an unpaired box into a text-layer page that is later read by vision, an unchecked check against an accepted partial index, and an unchecked gap that a failed document may hold. The panel shows these under "kept".
- A finding about a failed document itself waits on it until someone re-indexes or removes that document. Since this pass that includes a connector into a destination that no document declares and that the failed document may be.
- Under an unknown revision, a lower verdict waits while any document is in flight. A corrected drawing's better verdict is therefore written once the rebuild finishes. A document parked with no title block read counts as in flight, so under a monthly cap that can be until next month. The response names what the verdict waits on. (Corrected in review fix pass 8: as implemented, every parked document with no title-block row counted as in flight, a scan numbered by its filename included. Since review fix pass 8 the guard covers every parked document anyway. See below.)
- A gap that a parked document may hold, by its own drawing or a series it declares two drawings of, waits on it while it is parked. (Corrected in review fix pass 8: a gap it did NOT hold that way was filed settled, and at a known revision it was never lowered once its unread page turned out to declare the sheet. Such a gap now waits on it too; see below.)
- At a known revision, take a first record while a document in flight is the only holder of a series, under an unrelated filename. References into that series are filed out of scope. The set digest names the document, so the sheet is judged again once it is read, and a gap then raises the verdict.
- `log_audit_completion` (I-04) writes no `provisional` marker and compares by status. A provisional row it meets is just a row at that status, which is never lower than what the row settled, so nothing is lost.
- A page skipped for lack of a key or for the cap is not tracked as unread (DWG-7, handed to I-06).

**Review fix pass 8 (2026-10-01, intelligence Round G).** Fix pass 7's notes said all seven reviewer issues were fixed and that no parked or reset neighbour overwrote a settled verdict. Its item 5 defined "in flight" in words the code did not implement. Three paths, each reproduced by the reviewer through the route and each handled correctly by fix pass 6, let a transient neighbour raise a known revision's `passed` for good, or lower an unrevised `broken_connectors`. All three were regressions from fix pass 7.

**1. A document mid-read with a page queued (probes midread-ref and midread-opc, blocker).** Each ingest batch commits the pages it queued for AI vision as it goes (`vision_failed_pages`, status `indexing`, no error, no retry time). `inFlightOf` (`app/api/knowledge/drawing/route.ts`) now reads that state. A document still being read is PARKED only when three things hold: its main pass is through (`mainPassThrough`: `pages_indexed` at `page_count`); it is parked (`isParked`: a vision retry time, or a failed batch's back-off); and its unread pages are listed. Everything else still being read is IN FLIGHT: queued, stale (reset by a rebuild), or mid-read, whether or not a batch has queued a page. A document in flight may hold any sheet, as before. So the combined PDF six pages into twenty holds 030-PID-0203, and 0201's reference into it is unchecked and waits (rev B: provisional, then `passed`). `notReadWhole` labels such a document "not finished indexing, page(s) 3 queued for AI vision"; fix pass 7 said "page(s) 3 never read", but pages 7 to 20 were unread too. Its connector side is DWG-4's fix pass 8 item 1.

**2. A parked document's unread page (probes parked2 and parked-opc, blocker).** A parked document still holds by the settled rule (`mayHoldBySettledRule`): its own drawing, a series it declares two drawings of, or anything when its number was read neither from a title block nor from its filename. What it holds that way is unchecked and waits on it, as before. (Corrected in review fix pass 9: in the reference audit, "anything when its number was never read" hid every real gap as unchecked while an unnumbered scan was parked. A parked document now holds a missing sheet by its number only; see review fix pass 9 item 2.) What it does NOT hold that way:
- **A gap is filed as a gap, and waits on it.** `auditDrawingRefs` (`lib/drawingText.ts`) takes `stillReading`, the documents still being read (the route passes `stillBeingRead`). A missing sheet that no document holds, while a document is parked, is a `missingInSeries` gap carrying `pendingIn` (the parked documents, named to six, the rest counted) and `pendingIds`. The record files "References 025-PID-0108, which isn't in the set" with `waitsOn` those documents (`verdictsForSheets` in `lib/drawingAuditLog.ts`). So the verdict is provisional and settles without the gap, and the gap heals once the page is read. A real gap is shown as a gap, never hidden as "unchecked", which was minor 6's complaint about fix pass 6. But it is not settled while a page that may declare it is unread. Probe parked2: `flagged` at B, provisional, `passed` once page 2 is read; fix pass 7 kept `flagged` for good. The lens returns `pendingIn` with the gap and never `pendingIds`. Its suggestion says the gaps are not settled yet, and the panel (`components/knowledge/DrawingIntelPanel.tsx`) adds "not settled yet: … still has pages waiting on AI vision" to the gap.
- **A connector into the set's scope waits on it.** See DWG-4, fix pass 8 item 2.
- **A failed document is unchanged.** A missing sheet never waits on it (DEC-59). An accepted partial index is unchanged too: neither is being read.

**3. The reviewer's minor: a scan numbered by its filename.** A one-page scan named 025-PID-0107.pdf, parked under the monthly cap with page 1 unread and no title-block row, counted as in flight under fix pass 7, so it held ANY sheet: a real 040-TK gap was shown only as unchecked until November. The rule chosen: whether a parked document is in flight depends only on its state (item 1), never on its number. A parked document whose number was read from its title block OR from its filename holds by the settled rule. One whose number was read from neither holds anything by that same rule (as before). (Corrected in review fix pass 9: not in the reference audit. There such a parked document hid every real gap in every series as unchecked, until next month under the cap. It now holds a missing sheet by its number only, and a gap it may hold is filed as a gap that waits on it; see review fix pass 9 item 2.) The scan is parked, not in flight. The 040-TK gap is filed as a gap and waits on it (item 2).

**4. Under an unknown revision, nothing is lowered while a document is still being read (blocker 3's minimum, kept as the backstop).** `replaceDecision`'s guard option is renamed `stillReading`, and the route passes `beingRead.size > 0`, covering every document in flight or parked. Fix pass 7 passed the in-flight set only. A parked document's unread page can be the only declaration of a destination outside the set's scope, or of the number that makes a series held. The connector or gap that depends on it is then dropped, which is no finding, and fix pass 7 wrote the lower verdict over the row. Now that verdict waits, and the response names the documents being read (to six). The cost, stated: under `""`, a corrected drawing's lower verdict waits while ANY document of the library is parked. Under a monthly cap that can be until next month. In a library with no key it lasts until someone re-reads that document or accepts its partial index (`isAcceptedPartial`: then it is no longer being read). A known revision is unchanged: never lowered.

**5. An undeclared sheet whose own PDF is reset or failed (probes undecl-reset and undecl-failed, blocker).** See DWG-4, fix pass 8 item 3. The connector waits on SH2. Rev C stays `passed` while SH2 is not read whole, and is `passed` again once it is read. Fix pass 7 wrote a settled `flagged` against SH1.pdf, kept for good.

What waits, and what is settled, now:
- Waits (provisional, never written over what a row settled, healed once read). (Corrected in review fix pass 9: healed once read, but not once the document it waited on stopped waiting without being read, its partial index accepted or its indexing failed. See review fix pass 9 below.)
  - a finding about a document in flight, parked or failed;
  - a sheet the set is missing that a document in flight may hold (any), or that a parked one holds by the settled rule (unchecked);
  - a gap while any document is parked;
  - a connector whose destination no document declares, in three cases: into the set's scope while a document is in flight or parked; anywhere while one whose number was never read is in flight or parked; or into what a failed document holds by the settled rule (in the set's scope when its number was never read);
  - an undeclared sheet that another document not read whole for now may hold;
  - a sibling under the same key not read whole for now.
- Settled:
  - a gap with no document being read;
  - a sheet the set is missing that only a failed document or an accepted partial index may hold (unchecked);
  - an undeclared sheet guessed into its drawing's sole declarer when nothing else may hold it;
  - every finding about a sheet's own index.

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-13 / DWG-4 — a document mid-read, a parked one, or a reset or failed per-sheet sibling never raises a known revision's verdict for good, nor lowers an unrevised one (review fix pass 8)":
  - probes midread-ref, midread-opc, parked2, parked-opc, undecl-reset, undecl-failed and scan;
  - "while a document is parked, a settled verdict that would lower an unrevised row waits — even one whose destination only its unread page declared (outside the set's scope)";
  - the sole-declarer positive control.
- The fix-pass-7 test "the reviewer's probe parked" is corrected. The gap is in the lens's `missingInSeries`, with `pendingIn`, and its suggestion says it is not settled. The record waits over the `passed` at B, and the gap settles `flagged` once page 2 is read without 0009. Fix pass 7's version expected a settled `flagged` at once.
- `lib/__tests__/drawingText.test.ts` "a gap a parked document does not hold by the settled rule is filed, but not settled: it names the parked documents".
- `lib/__tests__/drawingAuditLog.test.ts`:
  - "a gap a parked document may yet hold on a page it has not read is filed, and waits on it — settled without it";
  - the `replaceDecision` table's guard rows, now `stillReading`.
- `lib/__tests__/drawingIntelPanelRebuild.test.ts` (rendered) "a gap a parked document may yet hold is listed as a gap, and says it is not settled".

Fifteen of these fail against fix pass 7 (`c0656fa`): every new route probe, the corrected parked test, the three new lib tests, the new `verdictsForSheets` test, the panel test, and the `replaceDecision` table, whose guard option was renamed. The sole-declarer positive control passes there too. The reviewer's four probe files (midread, undecl, parkedopc, scan) were run again from `scratchpad/rev-i07-fp7` and now behave as fix pass 6 did, or better (scan); they are not committed.

Residual (this replaces fix pass 7's list):
- A `flagged` that waits on nothing transient is settled, and at a known revision it is never lowered. That covers an unpaired box into a text-layer page that is later read by vision, an unchecked check against an accepted partial index, and an unchecked gap that a failed document may hold. The panel shows these under "kept".
- A finding about a failed document itself waits on it until someone re-indexes or removes that document. That includes a connector into a destination that no document declares and that the failed document may be.
- A failed document whose title block the failure cleared, under a filename that names something else: a reference into its old number is a gap, settled (a missing sheet never waits on a failed document, DEC-59), and a connector into it is dropped (DWG-4).
- Under an unknown revision, a lower verdict waits while any document is still being read, in flight or parked. With a parked document that can be until next month under a cap, or until someone re-reads it or accepts its partial index. The response names what the verdict waits on.
- While any document is parked, every gap in the library is filed provisional, waiting on it. It is shown as a gap and settles once the parked pages are read.
- At a known revision, take a first record while a document in flight is the only holder of a series, under an unrelated filename. References into that series are filed out of scope. The set digest names the document, so the sheet is judged again once it is read, and a gap then raises the verdict.
- `log_audit_completion` (I-04) writes no `provisional` marker and compares by status. A provisional row it meets is just a row at that status, which is never lower than what the row settled, so nothing is lost.
- A page skipped for lack of a key or for the cap is not tracked as unread (DWG-7, handed to I-06).

**Review fix pass 9 (2026-10-01, intelligence Round G).** Fix pass 8 said a waiting verdict was "healed once read", and criterion 1's parenthetical said the guarantee now held. It did not say what happens when the document a verdict waits on stops waiting WITHOUT being read. The reviewer reproduced that through the route: a provisional row was never judged again, and since fix pass 8 that left a `flagged` at a known revision where the computation is `passed`. It was a regression from fix pass 8 (fix pass 7 recorded `passed` in the same scenario). The two minors are fixed too.

**1. A provisional row is never "already recorded" (probes accept, accept2, failed and accept-gap, blocker).** Here is the scenario.
- 025-PID-0104 (rev C) carries `OPC 14: DWG 025-PID-0108 SH 1`, and no sheet declares 0108.
- 030-PID-0201.pdf is parked under the cap: its main pass is through, and page 2 is unread.
- Since fix pass 8 a parked document may hold any destination in the set's scope. So the connector waits on that PDF, and rev C is filed `flagged`, provisional, settled `passed`.
- A controller then accepts the partial index (`acceptPartial`, `app/api/knowledge/ingest/route.ts`: status ready, accepted, its unread pages kept).
- `notReadWhole` labels a parked, an accepted-partial and a failed document alike ("page(s) 2 never read"). The set digest carried `id:label` only, and the document's own index was unchanged. So the basis was identical, and `sheetsNeedingAudit` answered the row "already recorded": flagged, still "waiting on" a document that no longer waits, for good.
- A fresh computation from the same state gives `passed`, because an accepted partial index holds no destination outside the settled rule. The lens showed no unpaired connector while the record said flagged.

The same collision left the row stuck when the parked document's indexing failed instead (until someone re-indexed it). It also left a stale provisional marker on every gap filed while a document was parked, once that document was accepted.

Two changes:
- **A provisional row is judged again on every record.** `sheetsNeedingAudit` (`lib/drawingAuditLog.ts`) never counts a row with a provisional marker as done. The route carries `provisional: storedProvisional(audit_details)` on its prior rows (`recordAudit`, `app/api/knowledge/drawing/route.ts`). `replaceDecision` keeps the re-judgement from lowering what the row settled: a settled computation at or above the settled floor replaces the row, and a provisional one replaces it when it settles no lower. Otherwise the row is left as it is. In the probe, the accepted state computes `passed`, settled, which replaces the provisional row; the same happens after a failure. A gap filed while another series' PDF was parked settles `flagged`, with no marker left, once that PDF's partial index is accepted.
- **The set's basis names each incomplete document's kind.** `recordAudit`'s set digest now carries `id:label:kind`, with kind accepted, failed, in flight or parked (`kindOf`). A verdict computed while a document was one kind is judged again once it is another, even when the label stays the same. An example is a document whose main pass is through with a page queued and the retry not yet run (in flight), then parked under the cap, then accepted: "page(s) 2 never read" throughout (the reviewer's retry-then-park probe). At a known revision this never lowers a settled row.

The cost: while a row is provisional it is written again on every record (with its `audited_at`) and is listed under `sheets`, or under `waitingOn`, never under `alreadyRecorded`.

How a provisional row resolves (the question fix pass 8's records left open). It resolves whichever way the document it waits on stops waiting:
- **Read whole.** As before.
- **Partial index accepted.** That document then never changes, so what waited on it is judged against what was read of it, and settles. A box or a reference back that may stand on its unread page is a settled unchecked `flagged`. A gap it does not hold is a settled gap. A connector into a destination it held only because it was parked no longer waits.
- **Indexing failed.** A missing sheet stops waiting on it (DEC-59). Where it holds the sheet by the settled rule, the sheet is a settled unchecked `flagged`; otherwise the sheet is a settled gap. A finding about the failed document itself keeps waiting on it, named "re-index it".

**2. A parked scan whose number was never read hides no gap (probe unnum, minor).** The library held 040-TK-0001 (rev B, referencing 040-TK-0009) and 040-TK-0002. Scan_0001.pdf was parked under the cap with page 1 unread and no title-block row. Fix pass 8's settled rule let that scan hold ANY missing sheet, because its number was read neither from its title block nor from its filename. So the real 040-TK-0009 gap showed as `missingUnread`: "could not be checked … NOT counted as one-way or missing". The record filed it under `uncheckedReferences`. Rename the scan 025-PID-0107.pdf and fix pass 8 showed the same gap as a gap with `pendingIn`. The rule was applied by the document's filename, not by its state.

Now `auditDrawingRefs` (`lib/drawingText.ts`) counts a parked document (still being read, not in flight) as a holder of a missing sheet only by the settled rule's positive clauses (`holdsByItsNumber`): its own drawing, or a combined PDF's series. Its number never being read no longer counts. A gap it might hold falls to `missingInSeries` with `pendingIn` / `pendingIds`, and the record files "References 040-TK-0009, which isn't in the set", waiting on the scan, as for a numbered parked PDF. Status and settlement are unchanged (provisional `flagged`, settled `passed`); only the gap is shown as a gap.

Three things are unchanged:
- A failed document, or an accepted partial index, whose number was never read still holds anything by the settled rule (a settled unchecked `flagged`).
- A document in flight still holds anything.
- For a connector, a parked document whose number was never read still holds any destination, and the connector waits on it (DWG-4).

**3. Series not judged named prose documents (probe notjudged, minor).** See DWG-6, review fix pass 9: `seriesHeldBySet` and `seriesNotJudged` count real drawing numbers only (`sheetDrawingNumbers`).

What waits, and what is settled, now. This replaces fix pass 8's list; this pass changes three things:
- A provisional row is judged again on every record; it no longer waits only for the document to be read.
- A gap waits while any document is parked, numbered or not.
- A parked document whose number was never read is a holder only for connectors.

What waits (provisional, never written over what a row settled):
  - a finding about a document in flight, parked or failed;
  - a sheet the set is missing that a document in flight may hold (any), or that a parked one holds by its number (its own drawing, a combined PDF's series: unchecked);
  - a gap while any document is parked;
  - a connector whose destination no document declares, in three cases:
    - into the set's scope while a document is in flight or parked;
    - anywhere while a document whose number was never read is in flight or parked;
    - into what a failed document holds by the settled rule (in the set's scope when its number was never read);
  - an undeclared sheet that another document not read whole for now may hold;
  - a sibling under the same key not read whole for now.

What is settled:
  - a gap with no document being read;
  - a sheet the set is missing that only a failed document or an accepted partial index may hold (unchecked);
  - an undeclared sheet guessed into its drawing's sole declarer when nothing else may hold it;
  - every finding about a sheet's own index.

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "DWG-13 / DWG-6 — a provisional verdict is judged again until it settles, whether the document it waits on is read, accepted or fails; a parked scan hides no gap; a prose document is no series (review fix pass 9)":
  - probe accept: rev C settles `passed`, not "already recorded", once the partial index is accepted. The lens shows no unpaired connector, and the next record leaves the row be.
  - probe failed: rev C settles `passed` once the parked document's indexing fails.
  - "a provisional row re-judged while it still waits is kept provisional, and never lowered below what it settled".
  - probe accept-gap: the gap settles `flagged` with no marker.
  - probe retry-then-park: the row is judged again on in flight → parked → accepted, then left be.
  - probe unnum: the lens's `missingInSeries` carries `pendingIn`; the record files the gap under `missingReferences`, provisional, and it settles `flagged` once the scan is read.
  - probe notjudged (DWG-6).
- `lib/__tests__/drawingAuditLog.test.ts`:
  - "a row written provisional is never done, whatever its coverage: it is judged again on every record";
  - "a prose document's filename is no drawing number" (DWG-6).
- `lib/__tests__/drawingText.test.ts`:
  - "a parked document whose number was never read holds no gap by that alone: the gap is filed, waiting on it — a failed or accepted one still holds it, settled";
  - "a sheet's drawing numbers never include its filename standing in for one" (DWG-6).

All eleven fail against fix pass 8 (`c7272ca`): the three changed sources swapped in, then restored byte-identical. With only the `kindOf` suffix removed from the set digest, the retry-then-park probe fails alone. The reviewer's five probe files in `scratchpad/rev-i07-fp8` (accept, accept2, failed, unnum, notjudged) now give `passed`, `passed`, `passed`, a gap with `pendingIn`, and `[]`; they are not committed.

Residual (this replaces fix pass 8's list):
- A `flagged` that waits on nothing transient is settled, and at a known revision it is never lowered. That covers an unpaired box into a text-layer page that is later read by vision, an unchecked check against an accepted partial index, and an unchecked gap that a failed document may hold. The panel shows these under "kept".
- At a known revision, take a provisional row whose re-judgement settles BELOW what the row settled (something settled changed, such as a sheet added that answers a gap). The row is kept, never lowered, and keeps its provisional marker. It is judged again, and listed under `keptStored`, on every record.
- A finding about a failed document itself waits on it until someone re-indexes or removes that document. That includes a connector into a destination that no document declares and that the failed document may be.
- A failed document whose title block the failure cleared, under a filename that names something else: a reference into its old number is a gap, settled (a missing sheet never waits on a failed document, DEC-59), and a connector into it is dropped (DWG-4).
- Under an unknown revision, a lower verdict waits while any document is still being read, in flight or parked. With a parked document that can be until next month under a cap, or until someone re-reads it or accepts its partial index. The response names what the verdict waits on.
- While any document is parked, every gap in the library is filed provisional, waiting on it. It is shown as a gap, and settles once the parked pages are read, the partial index is accepted, or the document fails.
- At a known revision, take a first record while a document in flight is the only holder of a series, under an unrelated filename. References into that series are filed out of scope. The set digest names the document, so the sheet is judged again once it is read, and a gap then raises the verdict.
- `log_audit_completion` (I-04) writes no `provisional` marker and compares by status. A provisional row it meets is just a row at that status, which is never lower than what the row settled, so nothing is lost.
- A page skipped for lack of a key or for the cap is not tracked as unread (DWG-7, handed to I-06).
---
