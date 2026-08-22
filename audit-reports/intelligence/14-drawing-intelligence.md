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
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeSourceSync.ts:239-263`, `lib/knowledgeIngest.ts:399-429`, `app/api/knowledge/drawing/route.ts:414-433`, `app/api/knowledge/drawing/route.ts:368`

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

---

<a id="dwg-2"></a>

## DWG-2 · Every pipe line number on a P&ID mints a phantom piece of equipment — and the vision prompt explicitly asks the model to transcribe them

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/drawingText.ts:63-85`, `lib/knowledgeVision.ts:36-37`, `lib/equipmentBridgeServer.ts:65-78`, `lib/equipmentBridgeServer.ts:200-222`, `components/knowledge/DrawingIntelPanel.tsx:132`

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

---

<a id="dwg-3"></a>

## DWG-3 · Text-layer tag positions ignore /Rotate, CropBox origin and /UserUnit — and are the ones the viewer draws as EXACT

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:236-240`, `components/knowledge/CitedPageViewer.tsx:504-512`, `node_modules/pdfjs-dist/build/pdf.mjs:14431-14447`, `node_modules/pdfjs-dist/build/pdf.mjs:1238,1277-1292`, `fixtures/PID-Legend.pdf`

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

---

<a id="dwg-4"></a>

## DWG-4 · The entire off-page-connector layer is fed by a token the vision prompt never asks for, so the audit's top-severity verdict cannot fire

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/drawingText.ts:285-298`, `lib/knowledgeVision.ts:33-53`, `lib/knowledgeIngest.ts:272-280`, `lib/drawingText.ts:697-748`, `app/api/knowledge/drawing/route.ts:253-258`

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

---

<a id="dwg-5"></a>

## DWG-5 · The locate route's refine passes spend up to 8 extra vision calls per request that are never metered and never counted against the monthly cap

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/locate/route.ts:216-220`, `app/api/knowledge/locate/route.ts:236-268`, `lib/ai/usageServer.ts:112-127`

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

---

<a id="dwg-6"></a>

## DWG-6 · drawing_audit_logs is keyed org-wide but computed library-scoped, and the upsert overwrites unconditionally — a narrower library's verdict destroys a wider one's

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260929_mention_engine.sql:140-153`, `app/api/knowledge/drawing/route.ts:386-392`, `app/api/knowledge/drawing/route.ts:443-456`, `lib/drawingAuditLog.ts:140-149`

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

---

<a id="dwg-7"></a>

## DWG-7 · A P&ID with a real, working text layer produces zero entities once the page exceeds 2000 characters — and vision is not offered as a fallback

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/drawingText.ts:19-25`, `lib/knowledgeIngest.ts:231`, `lib/drawingText.ts:609-636`, `lib/knowledgeIngest.ts:268`

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

---

<a id="dwg-8"></a>

## DWG-8 · A connector's evidence line is truncated to 160 characters before the audit reads it, which can manufacture a 'broken by definition' finding

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/knowledgeIngest.ts:276`, `lib/drawingText.ts:739-746`, `app/api/knowledge/drawing/route.ts:253-258`, `components/knowledge/DrawingIntelPanel.tsx:344`

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

---

<a id="dwg-9"></a>

## DWG-9 · Migration 20261009_trace_method.sql ALTERs a table that 20261007_retire_line_traces.sql has already dropped — a fresh in-order apply fails

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261007_line_traces.sql:19`, `supabase/migrations/20261007_retire_line_traces.sql:9`, `supabase/migrations/20261009_trace_method.sql:16-21`, `lib/exportTables.ts:176-177`

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

---

<a id="dwg-10"></a>

## DWG-10 · The audit's primary key — the sheet number — is picked non-deterministically and disagrees with the number shown on screen

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/api/knowledge/drawing/route.ts:430`, `app/api/knowledge/drawing/route.ts:299`, `app/api/knowledge/drawing/route.ts:88-95`, `app/api/knowledge/drawing/route.ts:395-400`

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

---

<a id="dwg-11"></a>

## DWG-11 · The census that the UI promises is exact is read under row caps that truncate whole sheets out of the count

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/api/knowledge/drawing/route.ts:88-95`, `app/api/knowledge/drawing/route.ts:180-186`, `app/api/knowledge/drawing/route.ts:278-285`, `components/knowledge/DrawingIntelPanel.tsx:132`, `lib/knowledgeEntityKinds.ts:14-24`

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

---

<a id="dwg-12"></a>

## DWG-12 · The entityKindGuard exemption for the locate route no longer describes what that route does — it now contains a library-wide unfiltered slab read

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/__tests__/entityKindGuard.test.ts:28-30`, `app/api/knowledge/locate/route.ts:117-122`, `app/api/knowledge/locate/route.ts:80-83`

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

---

<a id="dwg-13"></a>

## DWG-13 · The route's own contract — 'an unrevised sheet is never re-audited' — is not implemented; sheetsNeedingAudit and buildRelocateUser are dead code

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/drawing/route.ts:10-15`, `app/api/knowledge/drawing/route.ts:386-456`, `lib/drawingAuditLog.ts:118-137`, `lib/drawingLocate.ts:99-115`

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

---
