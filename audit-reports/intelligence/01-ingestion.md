# 01 · Ingestion — from PDF to chunks

**12 findings** — 4 HIGH · 8 MEDIUM.

What the pipeline does to a page, and what it loses on the way.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Resumable-by-design batching with an explicit self-imposed deadline. Every write happens after the page loop, and the loop stops itself at deadlineMs (knowledgeIngest.ts:124) with VISION_PAGE_RESERVE_MS (line 71) of headroom before starting a vision page, so a killed invocation is prevented rather than recovered from. | `lib/knowledgeIngest.ts:89-98, 124, 158, 175; app/api/knowledge/ingest/route.ts:33` | This is the load-bearing property that makes 900-page ingestion work on a 60s function. Any fix for the concurrency finding must preserve it — a lease must be released or short-TTL'd, not held for the life of a document. |
| sanitizeStorageText + surrogate-safe slicing (alignEnd/alignStart/truncateSafe), applied at extraction AND again as a last line of defence on every insert. | `lib/knowledgeText.ts:17-31, 129-169; lib/knowledgeIngest.ts:141, 360-364` | Hard-won, reproduction-driven, and correct. It defends a real production failure ('invalid input syntax for type json' killing whole rebuilds) at two layers. Do not simplify it away while fixing the chunk-boundary issues. |
| pageNeedsVision's tags-found heuristic — a thin page with fewer than MIN_TAGS_THIN_PAGE tags and no prose signal is treated as unreadable even when it yields hundreds of characters. | `lib/drawingText.ts:589-636` | This is the single most consequential correctness decision in the pipeline: it is what separates 'AutoCAD SHX drawing whose only real text is the title block' from 'genuinely readable sheet'. Its rationale (lines 613-629) should be preserved verbatim in any refactor. |
| The vision transcription prompt is a precise, machine-readable contract: exact-alphanumerics rule, labelled DRAWING NO / SHEET / REV title-block lines read from the border's own fields, ' \| ' column separators, caption directly above the first row, and [illegible] rather than guessing. | `lib/knowledgeVision.ts:32-54` | The title-block half of this contract is consumed correctly (extractTitleBlock → kind 'self'), and it is what makes the reference audit trustworthy. The table half is currently discarded downstream — fixing the chunking finding makes an already-correct prompt pay off with no prompt changes. |
| Idempotent page-range rewrite for both chunks and entities (delete the range, then rewrite), backed by the unique index on (document_id, page, seq). | `lib/knowledgeIngest.ts:336-343, 396-402; supabase/migrations/20260920_per_user_keys_real_limits.sql:33-40` | The right shape — the belt-and-suspenders comment is accurate. The gap is that nothing coordinates WHO is rewriting a range, not that the rewrite is wrong. |
| Bounded chunk sub-batches with bisect-on-statement-timeout and per-row retry on encoding rejects. | `lib/knowledgeIngest.ts:352-393` | A well-engineered failure ladder built from real production incidents. It is the model the entity insert path (finding 8) should be brought up to. |
| lib/knowledgeEntityKinds.ts + lib/__tests__/entityKindGuard.test.ts — a repo-grepping guard that forces every bulk read of a multi-kind table to name its kinds, with each exemption written out in prose and a self-test proving the matcher actually catches an offender. | `lib/knowledgeEntityKinds.ts:1-33; lib/__tests__/entityKindGuard.test.ts:26-33, 68-95` | Exactly the right instinct, and it works for the risk it targets. It needs two extensions (cover the writer, cover the row cap), not replacement. |
| aiReadability as the single gate on the door into the knowledge side — held-back, superseded, archived and fileless documents all end at one call, and the per-document ai_excluded carve-out is enforced there. | `lib/knowledgeSourceSync.ts:103-171 (esp. 161-168)` | The AI boundary is genuinely single-doored on the mirror path, which is what makes the ACL story defensible. Any new ingestion entry point must go through the same gate. |
| loadSponsorVision reproduces the full interactive governance stack for background work: allowlisted provider, recorded agreement at the current AGREEMENT_VERSION, monthly cap, metered as its own op, billed to the uploader — and refuses to consume a visionAllPages library text-only when no sponsored key exists. | `lib/knowledgeIngest.ts:479-529, 552-559` | 'Never quietly bill someone' and 'never permanently index drawings as empty pages' are both enforced, in a background path where it would have been easy to skip either. |
| Two ingest doors, one engine. The client loop and the maintenance cron both call ingestKnowledgeDocBatch, and progress lives entirely on the knowledge_documents row. | `lib/knowledgeIngest.ts:1-12, 531-595; components/providers/KnowledgeIndexIndicator.tsx:1-24` | There is no second implementation to keep in sync — which means the lock, the empty-page counter, and the entity-retry ladder each need to be added in exactly one place. |


---


<a id="ing-1"></a>

## ING-1 · An in-flight ingest can commit superseded-revision chunks onto a document the sync just re-pointed at a new file

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:102-107`, `lib/knowledgeIngest.ts:431-446`, `lib/knowledgeSourceSync.ts:242-260`, `app/api/knowledge/ingest/route.ts:124-134`

**Mechanism.** `ingestKnowledgeDocBatch` downloads the PDF once at line 102 using the `doc.file_key` captured when the request started, then at line 439 writes `page_count / pages_indexed / status / error / last_section` back with an unconditional `.eq("id", doc.id)` — no compare-and-set on file_key, source_version_id, or the pages_indexed it started from. Meanwhile `syncKnowledgeLibrarySources` (running on the cron, or fired from the sources API immediately after a link/publish) can, between those two moments, delete all the document's chunks and set `file_key` to the NEW revision's object with `pages_indexed: 0, status: 'stale'`. The in-flight batch then inserts chunks extracted from the OLD file, deletes the (already-empty) page range, and stamps `pages_indexed: reached, status: 'ready'` — over a row that now advertises the new `source_version_id` and `source_rev`.

**Failure scenario.** Rev 4 of a P&ID is published at 03:00:12 while the maintenance cron's ingest drain is mid-batch on Rev 3 of the same mirror. The sync's refresh lands first; the batch's commit lands second. The knowledge document row now reads source_rev='4', status='ready', pages_indexed=50 — and every chunk under it is Rev 3 text. Answers cite 'Rev 4' and quote superseded content, with nothing anywhere marking the document as suspect.

**Evidence.**

```
knowledgeIngest.ts:102-103 `const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key }));` — key captured at entry. knowledgeIngest.ts:439-440 `await supabaseAdmin.from("knowledge_documents").update(docUpdate).eq("id", doc.id);` with `docUpdate` containing `status: done ? "ready" : "indexing"`. knowledgeSourceSync.ts:248-260 updates `file_key`, `source_version_id`, `pages_indexed: 0`, `status: "stale"` on the same row with no coordination.
```

**Chain reaction.** Compounds the previous finding: the entity rows from the old revision also survive, so both the text layer and the tag layer end up describing Rev 3 under a row labelled Rev 4.

> **Verifier correction.** Timing-dependent like #2: the code path is fully traced but the interleaving cannot be observed from the repo. Note the blast radius is worse than the finding states — the same unconditional write also resets `error: null` and can flip a freshly-staled row to `status: "ready"`, which removes it from the cron's re-ingest selector entirely, so the superseded index is not merely written, it stops being queued for correction.

**Done when.**

- [ ] The batch's final UPDATE is conditional on the file_key (and/or source_version_id) it actually read — e.g. `.eq("file_key", doc.file_key)` — and a zero-row result is treated as 'superseded, discard this batch'
- [ ] Chunks inserted by a superseded batch are removed, or the insert itself is gated on the same condition
- [ ] The sync refresh and the ingest batch share the lease introduced for the concurrency finding above

---

<a id="ing-2"></a>

## ING-2 · No server-side ingest lock: three independent drivers can process the same page range, and the loser hard-errors the whole document

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledge.ts:385-408`, `components/providers/KnowledgeIndexIndicator.tsx:78-108`, `lib/knowledgeIngest.ts:536-541`, `lib/knowledgeIngest.ts:341-343`, `lib/knowledgeIngest.ts:365-389`, `supabase/migrations/20260920_per_user_keys_real_limits.sql:39-40`, `app/api/knowledge/ingest/route.ts:179-185`

**Mechanism.** The only mutual exclusion is `const activeIngests = new Set<string>()` at lib/knowledge.ts:388 — a module-level Set, whose own comment says 'One driver per document per tab'. It does not exist across tabs or on the server. Three drivers contend: (a) the library page's own loop; (b) `KnowledgeIndexIndicator`, mounted in the protected layout and running in EVERY open tab, which polls `.in("status", ["pending","stale","indexing"])` (line 82) and takes `queue[0]`; (c) `drainKnowledgeIngestQueue`, whose selector at knowledgeIngest.ts:539 is the same `.in("status", ["pending","stale","indexing"])` — and 'indexing' is precisely the state an interactive ingest leaves the row in between batches (knowledgeIngest.ts:435). All read the same `pages_indexed`, compute the same page range, then race: `delete().gte(page, from+1).lte(page, reached)` (line 342) followed by chunked inserts (line 365). Interleaved as A-delete, B-delete, A-insert, B-insert, B violates the unique index `knowledge_chunks_doc_page_seq_idx ON knowledge_chunks (document_id, page, seq)`. The insert error handling recovers from statement-timeout (line 371) and from JSON/encoding rejects (line 382) — the duplicate-key message matches neither, so line 389 throws `chunk insert failed: duplicate key value violates unique constraint…`, and the route's catch at route.ts:181 writes `status: "error"`.

**Failure scenario.** A controller has the app open on their desktop and their laptop. A 900-page standard is queued. Both KnowledgeIndexIndicators pick it up (neither can see the other's activeIngests). Within a minute the document flips to status 'error' with 'Indexing failed: chunk insert failed: duplicate key value violates unique constraint "knowledge_chunks_doc_page_seq_idx"'. Worse on a drawing library: both invocations render and transcribe the same 4 pages with vision first, so the user is billed twice for pages that are then thrown away by the error.

**Evidence.**

```
lib/knowledge.ts:388 `const activeIngests = new Set<string>();` with the comment at 385-387 'One driver per document per tab. Two loops POSTing the same document race each other over the same page range'. knowledgeIngest.ts:539 `.in("status", ["pending", "stale", "indexing"])`. Grep for lock/lease/claim/advisory/'for update'/inflight across lib/knowledgeIngest.ts, app/api/knowledge/ingest/route.ts and lib/knowledge.ts returned zero hits on any locking construct.
```

**Chain reaction.** Every rev-up marks documents 'stale', which is the same queue — so this fires hardest right after a publish, when re-indexing correctness matters most.

> **Verifier correction.** The GUARANTEED outcome is duplicated work (two invocations re-extracting and re-inserting the same 50 pages). The hard error requires a specific interleaving (A.delete → B.delete → A.insert → B.insert); the benign ordering (A completes before B deletes) produces no error. So 'the loser hard-errors the whole document' is one interleaving, not the certain one — treat the error outcome as SUSPECTED and the wasted-work/lock-absence as CONFIRMED.

**Done when.**

- [ ] The ingest route claims the document server-side before doing work (e.g. a conditional UPDATE that only succeeds when the row's lease is free/expired, or a Postgres advisory lock keyed on document_id) and returns a benign 'already indexing' response otherwise
- [ ] drainKnowledgeIngestQueue skips documents whose lease is held rather than picking up any row in status 'indexing'
- [ ] insertChunks treats 23505 as 'someone else already wrote this range' rather than a fatal error

---

<a id="ing-3"></a>

## ING-3 · Rev-up refresh deletes chunks but never knowledge_page_entities — tags from superseded revisions survive and feed the census, the Bridge, and asset discovery

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeSourceSync.ts:242-260`, `lib/knowledgeIngest.ts:399-402`, `lib/equipmentBridgeServer.ts:66`, `app/api/knowledge/ask/route.ts:945-954`, `app/api/knowledge/ask/route.ts:1055-1057`

**Mechanism.** On a REFRESH (a controlled document published a new revision), knowledgeSourceSync.ts:242-243 deletes `knowledge_chunks` for the whole document, then resets `pages_indexed: 0, page_count: null, last_section: null, status: 'stale'` (lines 248-260). `knowledge_page_entities` is never touched — a full read of the file plus a repo-wide grep of the table name shows no delete/update of it anywhere in knowledgeSourceSync.ts. Re-ingestion only clears entities for the page range it actually reaches: `delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", reached)` (knowledgeIngest.ts:400-401). So any page number that existed in the OLD revision but is not reached in the NEW one keeps its old rows — permanently. That happens whenever the new PDF has fewer pages (a 20-sheet set reissued as 12), and transiently whenever re-ingest stalls, errors, or runs out of vision budget partway. The only full-entity wipe is the manual 'Rebuild index' button (app/api/knowledge/drawing/route.ts:368), which nobody is prompted to press after a rev-up.

**Failure scenario.** 025-PID-0101 Rev 3 has 20 sheets; sheets 13-20 are deleted in Rev 4, which has 12. Sync refreshes the mirror; chunks are dropped and re-indexed from the 12-sheet file. The equipment/ref/self/opc rows for pages 13-20 of Rev 3 remain. From then on: the census in DRAWING FACTS counts equipment that no longer exists on any drawing; equipmentBridgeServer's gather (`.eq("kind", "equipment")`, line 66) reconciles those phantom tags and creates DISCOVERED assets for deleted equipment; the reference audit pairs OPCs against sheets that were removed; and /api/knowledge/locate will point a user at page 17 of a 12-page PDF.

**Evidence.**

```
lib/knowledgeSourceSync.ts:242-247 deletes only `.from("knowledge_chunks")`; the subsequent update at 248-260 lists `pages_indexed, page_count, last_section, error` but no entity cleanup. Repo-wide grep `knowledge_page_entities` (non-migration) lists knowledgeSourceSync.ts nowhere. knowledgeIngest.ts:401 bounds the delete with `.lte("page", reached)` where `reached = lastCompletedPage` (line 334).
```

**Chain reaction.** This is the direct failure mode behind the owner's question 6 — 'show which equipment is on which sheet' silently keeps equipment on sheets that no longer exist, and auto-creates registry assets from them.

> **Verifier correction.** Add the strongest case, which the finding underplays: between the refresh write (`pages_indexed: 0`, chunks gone) and the completion of re-ingest — hours or days for a large drawing set behind a daily cron and a 4-page-per-batch vision budget — the ENTIRE old revision's entity set is live with zero corresponding chunks, so the census, the Bridge, and asset discovery are reading the superseded revision in full, not just its tail pages.

**Done when.**

- [ ] The refresh branch deletes knowledge_page_entities for the document alongside knowledge_chunks
- [ ] Re-ingest of a document whose page_count shrank prunes entity rows with page > page_count
- [ ] A test covers 'rev N has fewer sheets than rev N-1' and asserts no entity rows survive past the new page count

---

<a id="ing-4"></a>

## ING-4 · Tables are never atomic: splitTables/chunkPageText's whole table path is unreachable from ingestion

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeText.ts:305`, `lib/knowledgeText.ts:53-86`, `lib/knowledgeText.ts:88-127`, `lib/knowledgeIngest.ts:316-328`, `lib/knowledgeVision.ts:49-51`, `lib/__tests__/knowledgeText.test.ts:312-345`

**Mechanism.** Ingestion's only call is `chunkPageText(seg.text)` where `seg` comes from `splitPageIntoSections(lines, section)`. That function flushes with `const text = buf.join(" ").trim();` (knowledgeText.ts:305) — a SPACE, not a newline. `buf` holds per-line strings that can never themselves contain a newline (pdf.js `item.str` has none; the vision path builds `lines` by `transcript.split("\n")` at knowledgeIngest.ts:181). So `seg.text` is guaranteed newline-free. `chunkPageText` then calls `splitTables(raw)` which starts `const lines = raw.split("\n")` → an array of length 1. The table-block test at knowledgeText.ts:69 is `if (end - i >= 3)`, and with one line `end - i` can never exceed 1. `parts.some(p => p.kind === "table")` is therefore always false, and every page falls through to `chunkProse(raw)`, whose first statement is `const text = raw.replace(/\s+/g, " ").trim()`. Every table on every page is whitespace-collapsed into exactly the 'undelimited number soup' that knowledgeText.ts:44-49 says this machinery was written to eliminate. The vision prompt's contract — knowledgeVision.ts:49-51, 'keeping columns aligned with ' | ' separators… caption on its own line DIRECTLY above its first row' — is honoured by the model and then destroyed one function later. The unit tests pass because they call `chunkPageText` directly on a `\n`-joined string (knowledgeText.test.ts:314 `chunkPageText(`${prose}\n${TABLE}\n${prose}`)`), a shape production never produces.

**Failure scenario.** An engineer asks 'what is the bolt torque for a 3/4" flange in this service?'. The B31.3-style table was transcribed correctly by vision as `TABLE 3 — BOLT TORQUE` / `Size | Torque | Notes` / `1/2" | 45 ft-lb | dry` / `3/4" | 100 ft-lb | dry` / …. Ingestion stores one chunk reading `…TABLE 3 — BOLT TORQUE Size | Torque | Notes 1/2" | 45 ft-lb | dry 3/4" | 100 ft-lb | dry 1" | 175 ft-lb | dry…` with all row boundaries gone. Row-to-row alignment is now a guess for the answering model, on a PSM-regulated torque value.

**Evidence.**

```
Executed a verbatim type-stripped transcription of splitPageIntoSections/splitTables/chunkPageText/chunkProse on the two paths. PRODUCTION PATH: `segment has newline? false`; `splitTables kinds: [ 'prose' ]`; single chunk = `"The following torques apply… TABLE 3 — BOLT TORQUE Size | Torque | Notes 1/2\" | 45 ft-lb | dry 3/4\" | 100 ft-lb | dry 1\" | 175 ft-lb | dry 1.5\" | 300 ft-lb | lubricated Torques shall be applied…"`. TEST PATH (same lines joined with \n): `splitTables kinds: [ 'prose', 'table', 'prose' ]` and the table survives as its own chunk with `\n` between rows. Repo-wide grep confirms `chunkPageText` has exactly one non-test caller: lib/knowledgeIngest.ts:321.
```

**Chain reaction.** Everything downstream that promises table fidelity is affected: the deep-read image pass (lib/knowledgePageRender.ts) exists partly to compensate, the answer prompt's removed 'PDF table extraction jumbles numbers' disclaimer is no longer true, and every equipment-list / stress-table / torque-table answer is reading soup.

> **Verifier correction.** Downgraded CRITICAL→HIGH and narrowed the damage claim. The 'undelimited number soup' characterization holds only for TEXT-LAYER tables, whose column alignment is runs of spaces that `\s+`→' ' destroys. For VISION-transcribed tables the ' | ' separators the prompt mandates (knowledgeVision.ts:49-51) survive the collapse verbatim — the finding's own reproduced production output shows them intact (`Size | Torque | Notes 1/2" | 45 ft-lb | dry`). What is lost on the vision path is row boundaries, table atomicity, and the caption↔rows binding (an oversized table now splits mid-row at the 1400-char target with no re-heading). Real regression of a built-and-tested feature, but no data loss and no security impact, and the answer-quality consequence is unverifiable without running a model.

**Done when.**

- [ ] splitPageIntoSections joins its buffer with "\n" (or ingestion passes the raw line array through to chunkPageText) so splitTables sees real lines
- [ ] A test asserts on the FULL ingest path (lines[] → splitPageIntoSections → chunkPageText), not on chunkPageText with a hand-made newline string
- [ ] A vision-transcribed table with ' | ' separators comes out of the ingest path as one chunk containing '\n' between rows

---

<a id="ing-5"></a>

## ING-5 · 'anchor' is a fifth entity kind written on every page, but ENTITY_KINDS documents itself as complete and omits it — and the guard test exempts the writer

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:301-313`, `lib/knowledgeEntityKinds.ts:25-33`, `lib/__tests__/entityKindGuard.test.ts:26-33`, `lib/knowledgeIngest.ts:417-425`, `app/api/knowledge/ask/route.ts:1296-1299`

**Mechanism.** knowledgeIngest.ts:307-312 pushes `kind: "anchor"` rows for every caption line on EVERY page (the loop at 301 sits outside the drawing-like guard, so a prose standard generates thousands). lib/knowledgeEntityKinds.ts:26 declares `export const ENTITY_KINDS = ["equipment", "ref", "opc", "self"] as const;` under the comment 'Every kind ingestion currently writes' — anchor is missing, and `TAG_ENTITY_KINDS` (line 33) is likewise spelled out 'so a future kind has to be considered rather than inherited'. lib/__tests__/entityKindGuard.test.ts EXEMPTs `lib/knowledgeIngest.ts` with the reason 'writes rows (insert/delete), never bulk-reads them' — so the one file that introduced the undocumented kind is the one file the guard does not look at. Two concrete consequences today: (1) the pre-20260925 CHECK fallback at knowledgeIngest.ts:417-425 filters survivors to `CORE_KINDS = {equipment, ref}`, silently discarding anchor along with self and opc on any DB that hasn't run 20260925; (2) the registry that a maintainer reads to decide what a new bulk read must filter is wrong.

**Failure scenario.** A maintainer adds a sixth kind (say 'note' or 'linelabel'), consults ENTITY_KINDS to see what exists, adds it to both arrays, and ships. The next bulk reader written against TAG_ENTITY_KINDS now pulls anchor-adjacent volume it never accounted for — or, more likely, someone writes a new kind the way anchor was written (straight into the insert, nowhere else) and the guard test passes because the writer is exempt.

**Evidence.**

```
lib/knowledgeIngest.ts:309 `page: p, kind: "anchor", tag: `${kindWord} ${cap[2].toUpperCase()}`,`. lib/knowledgeEntityKinds.ts:25-26 `/** Every kind ingestion currently writes. */ export const ENTITY_KINDS = ["equipment", "ref", "opc", "self"] as const;`. lib/__tests__/entityKindGuard.test.ts:31 `"lib/knowledgeIngest.ts": "writes rows (insert/delete), never bulk-reads them",`. The only anchor reader is app/api/knowledge/ask/route.ts:1298 `.eq("kind", "anchor")` (confirmed by grep of `'anchor'|"anchor"|ANCHOR` across .ts/.tsx/.sql).
```

> **Verifier correction.** Both stated consequences are weaker than claimed, so this is registry/documentation drift rather than an operational defect. (1) The CHECK hazard is dead: supabase/migrations/20260925_entity_kinds.sql:15-16 does `DROP CONSTRAINT IF EXISTS knowledge_page_entities_kind_check` — it drops the constraint outright rather than widening it, so on any current DB anchor rows insert cleanly and the CORE_KINDS fallback never fires for them. (2) The cap hazard the module warns about does not materialize: every bulk read names its kinds (ask/route.ts:952, drawing/route.ts:93, orchestrator/tools.ts:374 all pass TAG_ENTITY_KINDS), so anchor rows cannot compete for the 20,000-row cap. What remains true is that a maintainer reading ENTITY_KINDS gets a false inventory, and the guard structurally cannot catch the file that introduces new kinds.

**Done when.**

- [ ] ENTITY_KINDS includes "anchor" and TAG_ENTITY_KINDS explicitly states it is excluded and why
- [ ] The guard test also asserts that every `kind: "…"` literal written in the ingest insert appears in ENTITY_KINDS
- [ ] The CHECK-constraint fallback's CORE_KINDS choice is re-decided now that four non-core kinds exist

---

<a id="ing-6"></a>

## ING-6 · A vision call that fails on a provider error is committed as an empty page and the document still reaches 'ready' — no counter, no flag, no error

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:186-197`, `lib/knowledgeIngest.ts:180-185`, `lib/knowledgeIngest.ts:315`, `lib/knowledgeIngest.ts:431-437`

**Mechanism.** Inside the vision block, a non-timeout throw is swallowed: `catch (e) { if (isTimeoutError(e)) { stoppedForTime = true; break; } visionLeft--; }` (lines 186-197). Execution then continues to line 315 `lastCompletedPage = p`, the page is chunked from its (empty) text layer, `emptyPages++` fires at line 329, and `pages_indexed` advances. Separately, a transcript shorter than `TEXTLESS_PAGE_MAX_CHARS` (60) is discarded at line 180 — budget spent, `visionPages` not incremented, page left textless — also silently. Nothing on the document row distinguishes 'this page had no text and we successfully read it' from 'this page had no text and the read failed'. When `reached >= pageCount` the row is stamped `status: "ready", error: null` (lines 431-437).

**Failure scenario.** A 300-sheet P&ID set is indexed. The provider 500s or rate-limits on 40 of the sheets. Those 40 sheets end up with zero chunks and zero tags; the document is marked 'ready' with error: null; vision_pages says 260. An engineer asks 'how many pumps are in this unit' and gets a confident count computed from 260 of 300 sheets, presented under the prompt line 'TRUST these for counts and totals'.

**Evidence.**

```
knowledgeIngest.ts:195-196 `// Provider hiccup: leave the page textless rather than fail the whole document; a later pass can retry it.` followed by `visionLeft--;` — there is no 'later pass': the page range is committed and pages_indexed moves past it. Line 180 `if (transcript.length >= TEXTLESS_PAGE_MAX_CHARS) { … }` with no else branch. Line 436 `status: done ? "ready" : "indexing", error: null`.
```

**Chain reaction.** Pairs with the sticky vision_pages counter: the two together make a partially-read drawing set look fully read from every surface.

> **Verifier correction.** 'No counter, no flag' is right for the document row, but the consequence is not wholly invisible: app/api/knowledge/drawing/route.ts:305-312 computes `gapPages` (pages the entity index has nothing for) and its own comment names this exact fingerprint — 'the fingerprint of an interrupted vision rebuild'. That surface exists only in the drawing-intelligence lens and still cannot distinguish a failed read from a genuinely blank page, so the finding stands, but the discoverability claim is overstated.

**Done when.**

- [ ] Failed / rejected vision pages are recorded per document (a counter column or a per-page marker) and surfaced next to 'N pages read by AI vision'
- [ ] Those pages are re-queued rather than committed as read — e.g. a document with failed vision pages does not reach 'ready' silently
- [ ] The DRAWING FACTS prompt block states how many pages were unreadable when the number is non-zero

---

<a id="ing-7"></a>

## ING-7 · Chunk boundaries are page-scoped: a provision spanning a page break is never in one chunk, and the 160-char overlap does not cross pages

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:123`, `lib/knowledgeIngest.ts:316-328`, `lib/knowledgeText.ts:140-161`, `lib/knowledgeIngest.ts:119`

**Mechanism.** Chunking happens strictly inside the per-page loop (`for (let p = from + 1; p <= to; p++)` at line 123; `rows.push({ … page: p, seq: seq++ … })` at 323-326). `chunkProse`'s overlap (`start = alignStart(text, Math.max(end - overlap, start + 1))`, knowledgeText.ts:158) is applied only within one segment of one page. The pipeline deliberately carries the SECTION heading across pages (`last_section` on the document row, line 119) but not the TEXT. So a clause that begins in the last 200 characters of page 12 and completes in the first 300 of page 13 is split across two rows with zero overlap, and neither row contains the whole rule. `chunkProse` also drops anything under 40 characters (`if (text.length < 40) return []`, knowledgeText.ts:142), so a short tail at the top of a page can be discarded outright.

**Failure scenario.** A B31.3-style requirement — 'Preheat shall be maintained at not less than 175°F for P-No. 5 materials over 1/2 in. nominal thickness, except…' — breaks across a page boundary. Retrieval scores page 12's chunk (the condition) and never surfaces page 13's chunk (the exception). The answer quotes a requirement without its exception and cites it correctly, which is the worst combination in a PSM context: wrong, and provably sourced.

**Evidence.**

```
lib/knowledgeIngest.ts:123 opens the page loop; lines 316-328 build and push chunk rows inside it; line 330 closes it. lib/knowledgeText.ts:96 `export function chunkPageText(raw: string, target = 1400, overlap = 160)` — `raw` is one page's segment text. lib/knowledgeText.ts:142 `if (text.length < 40) return [];`.
```

**Chain reaction.** Sections already carry across pages, so the retrieved chunk is labelled with the right section while missing half the provision — which makes the citation look more trustworthy, not less.

> **Verifier correction.** One real mitigation the finding misses, which narrows it rather than killing it: WHOLE-DOCUMENT MODE at app/api/knowledge/ask/route.ts:818-850 replaces a named document's scattered snippets with every chunk `.order("page").order("seq")` when the document is ≤130 chunks and fits a 170k-char budget, which reunites a page-straddling provision in the prompt — but only for at most two explicitly NAMED small documents per ask. For ordinary snippet retrieval there is no neighbour or adjacent-chunk expansion anywhere in the route (greps for neighbor/adjacent/surrounding hit only the graph-hop and prompt prose). Whether this actually loses an answer is model-dependent and therefore unverifiable here; the structural gap is not.

**Done when.**

- [ ] Ingestion carries a tail of the previous page's text into the first chunk of the next page (the same way last_section is carried), or chunks over a rolling multi-page buffer
- [ ] A test asserts that a sentence straddling a page break appears intact in at least one chunk

---

<a id="ing-8"></a>

## ING-8 · Entity insert breaks on the first error AFTER deleting the page range — a transient failure permanently blanks the tag layer while pages_indexed still advances to 'ready'

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:399-429`, `lib/knowledgeIngest.ts:427`, `lib/knowledgeIngest.ts:431-446`

**Mechanism.** The entity write first clears the range: `delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", reached)` (lines 400-401). It then inserts in slices of 500 with two schema fallbacks, and ends each iteration with `if (error) break; // missing table — drawing features just stay empty` (line 427). The comment scopes the break to a missing table, but the condition is `any error` — a statement timeout, a connection reset, a PostgREST parse failure, anything. When it fires, the remaining slices are dropped, the range's previous entity rows are already gone, and control falls through to lines 431-446 which advance `pages_indexed` and can set `status: "ready", error: null`. There is no chunk-style bisect-on-timeout or per-row retry here, unlike insertChunks (lines 371-388).

**Failure scenario.** A 50-page batch of vision-transcribed P&IDs produces ~9,000 entity rows in 18 slices. Slice 7 hits a statement timeout under concurrent load. Slices 7-18 are dropped, pages ~20-50 of that batch keep no tags at all, the batch's chunks are committed, pages_indexed advances, and the document eventually reads 'ready'. The equipment census for those sheets is silently zero, and the reference audit reports them as sheets with no outgoing references — indistinguishable from a genuinely tag-free drawing.

**Evidence.**

```
lib/knowledgeIngest.ts:427 `if (error) break; // missing table — drawing features just stay empty`. Contrast lib/knowledgeIngest.ts:371-376, where the chunk path halves the batch on a statement timeout, and 382-388, where it retries per row on encoding rejects. The entity path has neither.
```

**Chain reaction.** Whatever is lost here is lost until someone presses 'Rebuild index' — the page-range delete/rewrite only re-runs for pages the ingest loop revisits, which it never does once pages_indexed is past them.

> **Verifier correction.** Bound the blast radius: only the current batch's page range is blanked (`from+1 .. reached`), and app/api/knowledge/drawing/route.ts:305-312 will show those pages as `gapPages`. Also note the pre-20260925 CHECK fallback at 417-425 can legitimately set `error = null` and continue, so the break is reached only on an error that survives both fallbacks.

**Done when.**

- [ ] Only a genuinely missing table (42P01 / 'does not exist') breaks the loop; other errors bisect and retry like insertChunks, and a persistent failure throws so the batch is retried rather than committed as complete
- [ ] A batch that could not write its entities does not advance pages_indexed for the affected pages

---

<a id="ing-9"></a>

## ING-9 · Non-PDF rejection for direct uploads is client-side only; the server accepts any bytes and reports the unpdf failure as a generic indexing error

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/knowledge/[id]/page.tsx:1519-1521`, `app/(protected)/knowledge/[id]/page.tsx:1866`, `lib/knowledge.ts:356-361`, `app/api/knowledge/ingest/route.ts:39-134`, `lib/knowledgeIngest.ts:105-107`

**Mechanism.** The only type gate on the direct-upload path is in the browser: `accept=".pdf,application/pdf"` on the file input (page.tsx:1866) and `if (!/\.pdf$/i.test(file.name)) { showToast(…); continue; }` (page.tsx:1520). `addKnowledgeDocument` then uploads with `contentType: input.file.type || "application/pdf"` (lib/knowledge.ts:359) — defaulting an unknown type to PDF — and inserts the row. `/api/knowledge/ingest` performs auth and role checks and goes straight to `ingestKnowledgeDocBatch`; grep for `%PDF|magic|content_type|file_type` across the route and the engine returns nothing. `getDocumentProxy(bytes)` (knowledgeIngest.ts:106) throws on non-PDF bytes, the route's catch writes `status: "error"` and returns 502 `Indexing failed: <pdf.js internal message>`. The mirrored path is fine — knowledgeSourceSync.ts:54-57 has a real `isPdf` check.

**Failure scenario.** A controller renames `equipment-list.xlsx` to `equipment-list.pdf` (or drags a file whose browser-reported MIME is empty) to get a master equipment list into a knowledge library — exactly the workflow the owner describes in question 5. The upload succeeds, the row is created, R2 holds a bogus object forever (see the previous finding), and the only feedback is 'Indexing failed: Invalid PDF structure.' Nothing tells them PDF is the only accepted format, and nothing routes them to the CSV importer that actually exists (components/assets/AssetCsvImportModal.tsx).

**Evidence.**

```
app/(protected)/knowledge/[id]/page.tsx:1520 `if (!/\.pdf$/i.test(file.name)) {`. lib/knowledge.ts:359 `contentType: input.file.type || "application/pdf",`. grep `%PDF|magic|content_type|file_type` over app/api/knowledge/ingest/route.ts and lib/knowledgeIngest.ts → zero hits. Contrast lib/knowledgeSourceSync.ts:54-57 `const isPdf = (fileUrl, fileType) => { if ((fileType ?? "").toLowerCase().includes("pdf")) return true; return (fileUrl ?? "").toLowerCase().endsWith(".pdf"); };`
```

> **Verifier correction.** Severity is overstated as a defect class: this is error-message quality, not integrity or security. The path is Admin/DocCtrl-only (route.ts:63-64 and the `isController` guard on the upload button at page.tsx:1864), the failure is contained and self-reporting, and nothing downstream consumes the bad bytes. The concrete residue is a row parked at status 'error' plus an R2 object that the orphan sweeper will not reclaim while that row exists.

**Done when.**

- [ ] The ingest route checks the leading bytes for %PDF (or the stored file_type) before downloading/parsing, and returns a plain-language 'only PDF files can be indexed' error
- [ ] A non-PDF upload does not leave an R2 object and an errored row behind
- [ ] The error surfaced when a spreadsheet is uploaded names the right destination (the asset CSV importer) rather than a pdf.js internal message

---

<a id="ing-10"></a>

## ING-10 · The 'TRUST these for counts and totals' drawing-facts slab is a hard 20,000-row cap with no overflow detection

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:945-956`, `app/api/knowledge/ask/route.ts:1055-1068`, `lib/orchestrator/tools.ts:371-376`, `lib/knowledgeEntityKinds.ts:11-20`

**Mechanism.** The census slab is a single query across the asked library plus every linked library, filtered to TAG_ENTITY_KINDS and capped `.limit(20000)` (line 954). The result feeds `buildEquipmentCensus` and `auditDrawingRefs`, whose outputs are injected into the prompt at line 1056 as 'DRAWING FACTS — computed deterministically from EVERY sheet's extracted tags. TRUST these for counts and totals'. Nothing compares `entRows.length` against the limit, so hitting the cap is indistinguishable from a complete read. `.order("document_id")` makes the truncation deterministic but arbitrary — the alphabetically-last documents simply vanish from the census. lib/orchestrator/tools.ts:371-376 has the identical org-wide 20,000 cap. lib/knowledgeEntityKinds.ts:11-20 describes exactly this hazard ('whichever rows Postgres happens to return first decide what the census says… the number just quietly gets smaller, in the one place the UI promises it is exact') but treats it as a kind-filter problem only, not a cap problem.

**Failure scenario.** A refinery unit's P&ID library — 300 vision-read sheets averaging ~80 entities each — exceeds 20,000 rows. Every question that touches counts silently answers from a prefix of the library, with the prompt telling the model these numbers are the whole picture. 'How many relief valves are in this unit' returns a number that is wrong and stated as authoritative, and the sheets it dropped are always the same ones.

**Evidence.**

```
app/api/knowledge/ask/route.ts:954 `.limit(20000);` immediately followed at 955 by `const ents = ((entRows ?? []) as Array<…>).filter(…)` with no length check. app/api/knowledge/ask/route.ts:1056-1057 `"DRAWING FACTS — computed deterministically from EVERY sheet's extracted tags. TRUST " + "these for counts and totals (the passages above are excerpts, never the whole picture):\n"`.
```

**Chain reaction.** Compounds the stale-entity finding: the census is simultaneously over-counting deleted equipment and under-counting live sheets, in a block the prompt marks as ground truth.

> **Verifier correction.** Two accuracy notes. The prompt says 'computed deterministically from EVERY sheet's extracted tags' — that word EVERY is the specific falsehood at overflow, worth quoting as the contract breach. And app/api/knowledge/drawing/route.ts:87-96 shows the safer shape already exists in this codebase (50-document slices, each capped at 50000 and accumulated), so the fix has an in-repo precedent.

**Done when.**

- [ ] The slab is paginated (like the drawing route's 50-doc slices at app/api/knowledge/drawing/route.ts:85-99) or the count is computed in SQL
- [ ] When the cap is hit, DRAWING FACTS says so instead of claiming EVERY sheet — or the block is withheld entirely

---

<a id="ing-11"></a>

## ING-11 · emptyPages is computed and returned on every batch but has zero consumers — the route's own documented promise is unimplemented, and it is per-batch anyway

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ingest/route.ts:11-12`, `lib/knowledgeIngest.ts:55-56`, `lib/knowledgeIngest.ts:111`, `lib/knowledgeIngest.ts:329`, `lib/knowledgeIngest.ts:470`, `lib/knowledge.ts:428-445`

**Mechanism.** `emptyPages` is incremented per page (line 329), returned in `IngestBatchResult` (line 470), and spread into the route's JSON response (route.ts:172-178). The client's `ingestLoop` destructures only `done, pageCount, pagesIndexed, visionPages, visionSkipReason` (lib/knowledge.ts:428-431) and never reads it; two differently-shaped greps (`emptyPages` across .ts/.tsx, and case-insensitive `empty_pages|emptypages|extractable text`) find no consumer, no column, and no UI. It is also reset to 0 at the top of every batch (line 111) and never accumulated onto the document row, so even wiring it up would report only the last 50 pages.

**Failure scenario.** A 900-page scanned standard is indexed without an AI key. Every page yields nothing. The UI reports 'indexed, 900 pages' and status 'ready'. The number the route header says exists — '34 of 900 pages had no extractable text' — is computed on the server, serialised over the wire, and thrown away by the client on every single round trip.

**Evidence.**

```
app/api/knowledge/ingest/route.ts:11-12: `// Scanned (image-only) pages yield no text; we count them so the UI can say` / `// "34 of 900 pages had no extractable text" instead of pretending.` grep `emptyPages` (repo, .ts/.tsx, node_modules excluded) → only lib/knowledgeIngest.ts:56, 111, 329, 470. grep -i `empty_pages|emptypages|extractable text` → no additional consumer; the only 'extractable text' hits are prose in the ask prompt and the codebook import route.
```

**Chain reaction.** This is the honest-reporting hole the vision-failure finding above sits in: with no empty-page count anywhere, 'ready' is the only signal a user gets.

> **Verifier correction.** Overstated in one respect: the route comment's promise is partially served elsewhere, just not per-page. app/api/knowledge/drawing/route.ts:188 computes `textlessCount` (ready documents with zero chunks) and surfaces it in a suggestion at 190-197, and the library page reports '{visionPages} page(s) had no text layer' at app/(protected)/knowledge/[id]/page.tsx:1894. So this is dead code with no user-visible consequence — the lowest-value item in the set, kept only because the field is genuinely unreferenced.

**Done when.**

- [ ] emptyPages is accumulated onto the knowledge_documents row (like vision_pages) and reset by the same reset paths
- [ ] The library document list shows 'N of M pages had no extractable text' for any document where it is non-zero, or the promise is deleted from the route header

---

<a id="ing-12"></a>

## ING-12 · vision_pages is monotonic forever — rebuild and rev-up reset every other counter but not this one, so the per-sheet 'read by AI vision' verdict is永 sticky and the count inflates

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:458-467`, `app/api/knowledge/drawing/route.ts:371`, `lib/knowledgeSourceSync.ts:248-260`, `app/api/knowledge/drawing/route.ts:290-297`

**Mechanism.** The only write to `vision_pages` is a read-modify-write increment: `.update({ vision_pages: Number(cur?.vision_pages ?? 0) + visionPages })` (knowledgeIngest.ts:463-464). Neither reset path clears it. The rebuild handler sets `{ status: "stale", pages_indexed: 0, page_count: null, last_section: null, error: null }` (drawing/route.ts:371) — vision_pages absent. The sync refresh sets `{ status: "stale", error: null, pages_indexed: 0, page_count: null, last_section: null, … }` (knowledgeSourceSync.ts:250-259) — vision_pages absent. A repo-wide grep for `vision_pages` shows exactly one writer (the increment) and read-only consumers. The per-sheet verdict then reads `visionPages > 0 ? "vision"` (drawing/route.ts:294) BEFORE the tags/chars checks, so a stale non-zero value wins.

**Failure scenario.** A drawing library is indexed once with a valid AI key: 40 pages read by vision. Someone later hits 'Rebuild index' with no key saved (or after the monthly cap is hit). Every sheet re-indexes text-only and comes back empty — but the sheet card still says verdict 'vision' ('AI read it — SHX/scan handled'), and the library shows 40 vision pages that were never re-read. The one screen built to tell an engineer whether a sheet was actually readable reports the previous run's success.

**Evidence.**

```
knowledgeIngest.ts:461-466 is the sole writer. drawing/route.ts:371 `.update({ status: "stale", pages_indexed: 0, page_count: null, last_section: null, error: null })`. drawing/route.ts:290-297 `const visionPages = Number(d.vision_pages ?? 0); const verdict = … : visionPages > 0 ? "vision" … `.
```

**Chain reaction.** Feeds the textless-suggestion copy at drawing/route.ts:190-198, which will stop telling the user to rebuild with a key precisely when they need to.

> **Verifier correction.** The title's stray character ('永 sticky') is a typo. Scope note: the inflated count also feeds app/api/knowledge/locate/route.ts:65, not only the per-sheet verdict, so the staleness is visible in more than one surface.

**Done when.**

- [ ] Both reset paths (drawing rebuild, sourceSync refresh) set vision_pages: 0
- [ ] The sheet verdict derives from the current index state (chunks/tags present) rather than a cumulative counter, or the counter is scoped to the current index generation

---
