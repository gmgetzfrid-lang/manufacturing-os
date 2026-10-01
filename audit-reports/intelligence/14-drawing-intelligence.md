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

**Scope / residual.** The record is now keyed per library as well (DWG-6, `20261124`), and an unrevised sheet is not re-audited (DWG-13); a sheet whose revision is unknown (`""`) always is. Recording needs `20261124`: without it the route answers 424 and writes nothing (Pending migration, under DWG-6).

**Review fix pass (2026-10-01, intelligence Round G).** "The lens never trusts a half-read sheet" did not hold for an ACCEPTED partial index: a controller's accepted document is `ready`, so it counted as indexed and could be recorded `passed` with pages AI vision never read. Now `recordAudit` files a finding for every sheet whose `vision_failed_pages` is not empty ("Page(s) 5, 6 were never read by AI vision (partial index accepted) — nothing on them was audited"), through the new `unreadPages` input of `verdictsForSheets` (`lib/drawingAuditLog.ts`). Such a sheet is `flagged`, never `passed` and never `broken_connectors`. Tests: `lib/__tests__/drawingAuditLog.test.ts` "unread pages keep a sheet from passing (an accepted partial index)", `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "an accepted partial index is never recorded passed: the unread pages are a finding (fix pass)". Both fail against the round's first commit.

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
- **No verdict about a set the library does not hold.** A gap ("isn't in the set") is judged only inside a series the library holds (`seriesHeldBySet`). A sheet that is the only one of its series in the library (`sheetsAloneInTheirSeries`) is still recorded for what is its own — its connectors and boxes — while references into its series are out of the set's scope (`missingWithinHeldSeries`), and the record names the series not judged (`audit_details.set.seriesNotJudged`). (Corrected in the review fix pass below: the first rule dropped such sheets whole.)
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
- ✓ The upsert refuses to lower severity: the RANK comparison runs against the existing row, and a stored `broken_connectors` or `flagged` is never replaced by `skipped`. One qualification (review fix pass, with DWG-13): under an UNKNOWN revision (`""`) the latest non-`skipped` verdict replaces the row (`mayReplaceStored`), because nothing can tell that row's drawing from the one that replaced it; `skipped` still never replaces a verdict.
- ✓ `audit_details` records the library and the sheet list the verdict was computed against, and the series it did not judge.
- ✓ In the form the review fix pass settled: no verdict ABOUT a series — a gap — is ever recorded from a library that does not hold that series (the finding's failure scenario: Tank Farm now files no "isn't in the set" against 025-PID). The sheet itself is recorded for what is its own. The criterion's literal "not recorded at all" also dropped a lone sheet's own defects (a connector naming no drawing) and every verdict of a single-sheet or one-sheet-per-series library, which the base recorded; that was the over-reach the review found.

**Final key, for I-04.** `UNIQUE (org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT`. `log_audit_completion` (`lib/orchestrator/tools.ts`) must upsert with `onConflict: "org_id,library_id,sheet_number,revision_code"` and `library_id` NULL (org-wide), and should apply `RANK` / `wouldLowerSeverity` before writing. Until it does, once `20261124` is applied that one tool's upsert names a key that no longer exists, and PostgREST refuses it (42P10). The tool returns that error; it does not write elsewhere. Apply `20261124` after the merge that moves it (the migration's header says so).

**Pending migration:** `20261124_intel_roundG_drawing_audit_scope.sql`. Until it is applied the route records nothing: it answers 424, naming the migration. The pre-apply inventory counts the verdicts on a sheet mirrored into more than one library, which are the ambiguous ones. Decision: `DEC-59` item 2.

**Review fix pass (2026-10-01, intelligence Round G).** `sheetsAloneInTheirSeries` dropped whole verdicts that the base recorded: a single-sheet library, a library holding one sheet per series, and a combined PDF declaring `025-PID-0101/0102/0103` with no SHEET field (only several `-SHn` forms exempted a document). The suppression covered every finding, including a connector that names `NONE`, a defect of the sheet itself. Now:
- **A document holds a series of its own** when it declares two or more numbers of one series, whichever form (`sheetsAloneInTheirSeries` counts distinct identities per series within the document; the `-SHn` rule is one case of it).
- **A sheet alone in its series is recorded.** `recordAudit` no longer skips it. Its `missingInSeries` findings are limited to the series the library holds (`seriesHeldBySet` / `missingWithinHeldSeries` in `lib/drawingAuditLog.ts`), so a reference into its own series is out of scope, exactly like one into another unit. Its broken, unreturned, one-way, unreadable and unread-page findings stand. The response and `audit_details.set.seriesNotJudged` name the series whose gaps were not judged; the panel says so.

Tests: `lib/__tests__/drawingAuditLog.test.ts` "a combined PDF declaring several numbers of one series holds that series itself (fix pass)", "a single-sheet library, and one sheet per series, are alone — and recorded for what is their own", "gaps are judged only inside a series the library holds", and "verdictRows — the series not judged are on the record"; `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "Crude Unit records 0104 passed; Tank Farm judges no gap in a series it holds one sheet of …" (0104 recorded `passed` in Tank Farm with no missing reference and `seriesNotJudged: ["025-PID"]`; Crude Unit's row untouched), "a lone sheet's own defect is still recorded: a connector that names no drawing is broken in any set (fix pass)", and "a single combined PDF, and a single-sheet library, are recorded". Each fails against the round's first commit.

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
- **Vision stays opt-in.** Nothing routes a page to AI vision automatically (decision default, `DEC-59` item 1).
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

**Scope / residual.** Already-indexed dense sheets gain their tags at their next re-index (a rebuild, or a rev-up). The letter-case signal will miss a drawing lettered in mixed case past 2,000 characters with no title block. Such a sheet is shown as "Prose" and keeps the old behaviour.

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
- ✓ `recordAudit` loads prior verdicts for the library's sheets and runs them through `sheetsNeedingAudit` before recomputing. An unrevised sheet is never re-audited where "unrevised" can be established — a known revision; a sheet under an unknown revision is audited every time.
- ✓ The response distinguishes "recorded" from "already recorded at this revision".
- ✓ The refine loop calls `buildRelocateUser` when the close-up returns no sighting, instead of silently keeping a point it just failed to confirm.
- ✓ No function stays unwired: `sheetsNeedingAudit` and `buildRelocateUser` both have production callers now.

**Scope / residual.** The orchestrator's `check_audit_history` reads by `(org_id, sheet_number)` and now sees one row per library. That is I-04's tool; the final key is under DWG-6.

**Review fix pass (2026-10-01, intelligence Round G).** Two corrections.
- **An unknown revision is never "unrevised".** `recordAudit` files `revision ""` for every library-only sheet (and a mirror with no label on either side). `sheetsNeedingAudit` treated a prior `""` row as done for good, so a library-only PDF recorded `flagged` ("References 025-PID-0107, which isn't in the set") kept that verdict after 0107 was uploaded or the PDF replaced — every later record answered "already recorded at this revision", and the panel promised it would not need auditing "until revised", which can never happen. Now a `""` row never counts as done (`sheetsNeedingAudit`), and the latest non-`skipped` verdict replaces it (`mayReplaceStored` in `lib/drawingAuditLog.ts`, used by the route in place of the bare `wouldLowerSeverity` check); `skipped` still never erases a verdict, and a known revision's verdict is still never lowered. The panel's line now says a sheet whose revision is not known is audited every time. A real revision for library-only sheets (the title block's REV, read at ingest) would let them be keyed too; that is a further change, not made here.
- **The caching claim, restated** (bullet above): a refuted point is never cached; an unchecked coarse point is cached as an approximate estimate. The route header and `lib/drawingLocate.ts` say the same.

Tests: `lib/__tests__/drawingAuditLog.test.ts` "never treats a verdict under an UNKNOWN revision as done — 'unrevised' can't be established (fix pass)" and "mayReplaceStored — the latest verdict, never a lower one at a known revision"; `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a sheet whose revision is unknown is re-audited every time, and its row takes the latest verdict (fix pass)" (flagged → passed once the set is widened, one row; a sheet that cannot be read keeps its verdict, reported under `keptStored`) and "a point no close-up checked (past REFINE_MAX) is cached as the coarse estimate it is — approximate, rejectable". The `""` tests fail against the round's first commit. The DWG-13 route tests now mirror every Crude Unit sheet with a revision, so "a second record writes nothing" exercises the known-revision rule it states.

---
