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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:102-107`, `lib/knowledgeIngest.ts:431-446`, `lib/knowledgeSourceSync.ts:242-260`, `app/api/knowledge/ingest/route.ts:124-134`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: there is no optimistic-concurrency guard anywhere on the commit path — the only status check is route.ts:67 `if (doc.status === "ready")`, which a sync-to-'stale' row passes. Note the cron cannot race itself (maintenance/route.ts awaits sync before the drain), so the window needs a browser-driven ingest or an overlapping invocation; the mirror-image variant is equally live — if the sync lands first, the batch indexes pages 51+ of the NEW file and marks it 'ready' with pages 1-50 never indexed.

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

**Resolution (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) against the pre-fix engine. A row re-pointed at Rev 4 between the batch's download and its commit was stamped `status: 'ready', pages_indexed: 1`, with Rev 3's chunks under it. What landed, in `lib/knowledgeIngest.ts` `ingestKnowledgeDocBatch`:

- **Compare-and-set at commit.** The final UPDATE is conditional on everything the batch read: `.eq("ingest_claimed_by", driver).eq("file_key", …).eq("source_version_id", …).eq("pages_indexed", from)`, with `.select("id")`. Zero rows means the row moved: re-pointed, deleted, or the claim was lost. The batch then deletes exactly the chunk and entity rows it inserted (by id), never touches the row, and returns `superseded: true`. The row keeps saying what it says (`stale`, `pages_indexed: 0`, the new `source_rev`) and stays queued for the correct re-index.
- **One lease for both writers.** The rev-up refresh in `lib/knowledgeSourceSync.ts` now goes through `resetKnowledgeIndex` (ING-3), which takes the SAME claim. When a batch holds it, still writing the OLD revision, the refresh does not wait and does not defer (`supersedeBusy`): it re-points the row at once, with its own compare-and-set on the file and version the row named, and deletes the old index. That batch's commit then misses (the file, the version and `pages_indexed` all moved) and it withdraws what it wrote. So the superseded revision is never completed to `ready`, and it is not served until the library's next rotation turn. A same-file reset through `resetKnowledgeIndex` (a library re-index; the drawing rebuild once I-07 moves onto it) cannot be seen by the compare-and-set of a batch that started at page 0, so it reports that document `busy` and waits its turn. The mirror-image variant the verifier added (the sync lands first, and the batch indexes pages 51+ of the new file as if 1–50 were done) is closed the same way: the commit compares `pages_indexed`.
- **A rev-up resets only the revision it read.** Review fix pass 2. The sync passes the version it read into the reset (`resetKnowledgeIndex(…, { expect: () => ({ source_version_id }) })`). The reset checks it against the row before deleting anything, and the row's UPDATE compares it again on BOTH paths, claimed or superseding. Without it, a second sync that had read the mirror while it still named Rev 3 (the publish-triggered sync and the cron's, say) re-reset the row the first sync had already moved to Rev 4. Two cases were probed. Under Rev 4's own first batch, whose compare-and-set still matched (`pages_indexed` was 0 either way), the row ended `ready` with every chunk gone. Between Rev 4's batches, it re-reset a partly re-indexed revision and re-billed its vision pages. Now such a row is reported `busy`: the sync counts it `deferred` and leaves it exactly as it is.
- **Every writer that records something about a batch compares against what the batch read.** Review fix pass 2. A rev-up may re-point a row under someone else's claim, so an UPDATE filtered on `id` alone can land on the new revision. Four writers did that. Each is now a compare-and-set:
  - **A failed batch** throws `IngestBatchError`, carrying the file, version and resume point it read. The route's and the cron drain's one failure write, `markIngestFailed`, compares all three (and, since review fix pass 3, the failure count it increments; ING-8). A batch a rev-up superseded mid-flight therefore never stamps `error` on the re-pointed revision; before, the drain's and the route's `.eq('id')` writes did. The failed batch also withdraws the rows it inserted, so none of the old file's rows stay under the new revision.
  - **The non-PDF refusal** (`refuseNonPdf`) compares its delete (an upload) or its `error` mark (a mirror) against the file the check looked at (`notPdfRead`). A row re-pointed since is not refused.
  - **accept-partial** (`app/api/knowledge/ingest/route.ts`) compares its UPDATE on the row as claimed: `file_key`, `source_version_id` and `pages_indexed`. A rev-up that lands under it wins, and the answer is 409. Before, the acceptance of Rev 3's unread pages stamped Rev 4 `ready` with nothing indexed, which took it out of every queue.
  - The pre-20261122 `vision_pages` top-up compares `file_key`.
- **A refresh that did not land comes round first.** If a refresh fails before the row moves, or another sync re-pointed the row first, the library's `last_synced_at` is set to NULL (never synced), which the cron's rotation reaches first (ILIFE-13).
- **A withdrawal that fails is said, not dropped.** Review fix pass 3. `withdraw()` used to ignore the errors of its deletes. Now each delete is checked and tried once more, and whatever still fails is reported: the batch throws, naming the rows it could not withdraw, and both callers report it (the route's 502, the drain's `errors`). On a re-pointed row the failure write misses, as it should. What is left is then cleared by whichever writer comes next:
  - **Under the claim**, the next batch of a re-pointed row starts a new index generation, and that generation's first batch clears the whole derived index. The rows cannot land after it, because the superseded batch holds the claim until it has finished. On a row that did not move, the next batch clears the same range again before it writes.
  - **Unclaimed** (before `20261122`), no batch does a full clear. So a row found re-pointed at another file is re-queued through `resetKnowledgeIndex`, which deletes every derived row and reads the new file from its first page. Since review fix pass 4, the re-queue passes the row it checked as `expect` (the file, the version and `pages_indexed`). An unclaimed batch of the new file that committed after the check therefore keeps its pages; the reset reports the row `busy` and leaves it.

Tests:
- `lib/__tests__/ingestLock.test.ts`: "a rev-up that lands mid-batch: the batch withdraws its rows and the row keeps saying 'stale'"; "a rev-up that lands while a batch writes the OLD revision re-points the row at once; the batch's commit misses and withdraws" (the whole refresh runs just before the batch's commit); "a same-file reset … waits its turn"; "a deleted row mid-batch is superseded, not an error"; "the cron drain: a Rev 3 batch superseded mid-flight hits a real failure — the Rev 4 row stays queued, not 'error', with none of Rev 3's rows"; "a real failure on the row the batch read is recorded on that document, with the message — and retried, not parked"; "a mirror re-pointed at a new revision after its file was checked is not refused…"; and, from review fix pass 3, "claimed: a superseded batch whose withdrawal fails reports it (and retries each delete once); the re-pointed row is never errored" and "unclaimed (pre-20261122): a row re-pointed at a new file whose withdrawal failed is re-queued for a full re-index"; from review fix pass 4, "unclaimed (pre-20261122): a new-file batch that commits between the check and the re-queue keeps its pages".
- `lib/__tests__/sourceSync.test.ts`: "ING-1: a rev-up that finds a batch writing the old revision re-points the row at once — Rev 3 never reaches 'ready'"; "a purge that fails before the row moves leaves the old version, and the library comes round FIRST next run"; "ING-1: a second sync that read Rev 3 lands under Rev 4's first batch — it resets nothing, and the batch's pages stay"; "ING-1: the same stale sync after Rev 4 was re-indexed (no batch running) leaves it alone — nothing re-reset, nothing re-billed". Both reproduce the reviewer's probes: without `expect`, both fail.
- `lib/__tests__/ingestRoute.test.ts`: "the route: a Rev 3 batch superseded mid-flight that then fails answers 502 — and the Rev 4 row is not marked 'error'"; "accept-partial: a rev-up that re-points the row under the acceptance wins — Rev 4 is never 'ready' with nothing indexed".

Each new guard was mutation-checked: with the guard removed, its test fails.

**Done-when.**
- ✓ The batch's final UPDATE is conditional on the `file_key` and `source_version_id` it read, and on the claim and the starting `pages_indexed`. A zero-row result means "superseded, discard this batch".
- ✓ Chunks, and the entity rows, inserted by a superseded batch are removed, by id. Another writer's rows are never touched.
- ✓ The sync refresh and the ingest batch share the claim introduced for ING-2 (`claimIngestLease`, called by both `ingestKnowledgeDocBatch` and `resetKnowledgeIndex`). A rev-up that finds the claim held supersedes the batch rather than waiting behind it. It does so only while the row still names the revision the sync read, and no writer that records a batch's outcome can land on a revision the rev-up moved to.

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql`. Without it the batch runs unclaimed and its commit compares `file_key` and `source_version_id` only. That still catches this finding's rev-up case. The legacy re-queue after a failed withdrawal leaves one race open. Its `expect` sees a batch of the new file that has committed, but not one still writing: that batch's commit compares only the file and the version. A re-queue that lands between such a batch's inserts and its commit deletes its chunks, and the batch then commits `pages_indexed` over nothing. The race needs a failed withdrawal (two failed deletes in a row) and a concurrent unclaimed batch. The claim in `20261122` closes it. The drawing rebuild in `app/api/knowledge/drawing/route.ts` is I-07's file. It still resets rows without the claim until I-07 moves it onto `resetKnowledgeIndex` (the plan says it will). Until then, a rebuild that lands under a first batch (`pages_indexed` 0 → 0, same file) is the one interleaving the compare-and-set cannot see. Decision: `DEC-58`.

**Pending build (DEC-29 item 4).** On this branch, `npx tsc --noEmit`, `npx eslint --max-warnings=0` on every changed file, and the full `npx vitest run` pass. `next build` was not run: the fleet's standing rule leaves it to the integrator, who runs it before merging and records it in the round section. This status stands on that build. If the build fails, the finding returns to OPEN.

**Handoff landed (2026-10-01, intelligence Round G, I-07).** The drawing rebuild in `app/api/knowledge/drawing/route.ts` now goes through `resetKnowledgeIndex`, taking each document's ingest claim. A document a batch holds is reported `busy` and left alone, never reset under it. The one interleaving the residual above named (a rebuild landing under a first batch, `pages_indexed` 0 → 0, same file) is closed by the claim. Test: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "… leaves a document another driver holds alone".

---

<a id="ing-2"></a>

## ING-2 · No server-side ingest lock: three independent drivers can process the same page range, and the loser hard-errors the whole document

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledge.ts:385-408`, `components/providers/KnowledgeIndexIndicator.tsx:78-108`, `lib/knowledgeIngest.ts:536-541`, `lib/knowledgeIngest.ts:341-343`, `lib/knowledgeIngest.ts:365-389`, `supabase/migrations/20260920_per_user_keys_real_limits.sql:39-40`, `app/api/knowledge/ingest/route.ts:179-185`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed in full, including the quoted failure mode. Three drivers exist (app-shell indicator, library page loop, cron drain) and nothing server-side arbitrates between them; the losing writer's error is written onto the document row, not just its own response.

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

**Resolution (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) by driving the pre-fix engine over a real PDF against an in-memory database: another writer's row landing in the page range between the batch's clear and its insert made it throw `chunk insert failed: duplicate key value violates unique constraint…`, which the route writes onto the document as `status: 'error'`. What landed, in `lib/knowledgeIngest.ts`:

- **The claim.** `claimIngestLease(documentId, driver)` is one conditional UPDATE — `SET ingest_claimed_by = <driver>, ingest_claimed_at = now WHERE id = … AND (ingest_claimed_at IS NULL OR ingest_claimed_at < now − INGEST_LEASE_TTL_MS)` — returning the whole row. Postgres re-evaluates the WHERE on the row it locks, so of two racing drivers exactly one wins. `ingestKnowledgeDocBatch` claims before it downloads anything and works from the row as claimed (the caller's copy may be a batch old). The claim lasts ONE batch: the commit releases it in the same UPDATE, `finally` releases it on any other exit, and the five-minute TTL frees a document whose invocation the platform killed. The self-imposed deadline and the per-batch commit (the substrate property the finding asked to preserve) are unchanged.
- **The loser.** A batch that finds the claim held returns `busy: true` and does no work. `app/api/knowledge/ingest/route.ts` waits for it — it looks again every 1.5 s while a batch still fits its 45 s budget — and otherwise answers 200 `{ busy: true }` with the row's progress. Nothing is marked `error`. Since review fix pass 3 the answer also carries `retryAfterMs`: at most how long until the claim is free. A live batch lets go sooner. A claim left by an invocation the platform killed stands for the whole five-minute TTL.
- **The drain.** `drainKnowledgeIngestQueue` selects only rows whose claim is free or expired (`or(ingest_claimed_at.is.null, ingest_claimed_at.lt.<cutoff>)`) and moves on from a `busy` or `superseded` result.
- **Contention is not failure.** A duplicate key (23505) or a vanished document row (23503) on a chunk or entity insert throws `IngestSuperseded` inside the batch. The batch deletes exactly the rows it inserted (ids from `.insert(...).select("id")`) and returns `superseded: true`.
- The route's controller gate now reads the role collection through `memberHoldsAny` (ADD-1).

Tests: `lib/__tests__/ingestLock.test.ts` ("two drivers racing one document: exactly one works…", "the claim is atomic, frees itself after the TTL…", "a batch that finds the claim held does no work at all", "the drain skips a row someone holds the claim on", "the drain takes a stale claim over…", "a duplicate key is contention, not failure…", "unclaimed (pre-20261122) drivers racing…"), and `lib/__tests__/ingestRoute.test.ts` ("a POST that finds the claim held waits for it, then does the batch").

**Done-when.**
- ✓ The document is claimed server-side before any work by a conditional UPDATE that succeeds only when the claim is free or expired. The benign answer is `busy`, and the route waits for the claim first.
- ✓ `drainKnowledgeIngestQueue` skips rows whose claim is held.
- ✓ A 23505 during the chunk insert means someone else already wrote this range. The batch withdraws its own rows and reports `superseded`. It is no longer a fatal error.

**Scope / residual.** Pending migration: `supabase/migrations/20261122_intel_roundG_ingest_integrity.sql` (the `ingest_claimed_by` / `ingest_claimed_at` columns). Until it is applied, the claim UPDATE's missing-column error selects the legacy, unclaimed path. Two drivers can then still both do the work, but neither errors the document (test "unclaimed (pre-20261122) drivers racing"). The paste's pre-apply inventory (DEC-30) counts the claim's backfill population, the documents in `indexing`, split by age: created in the last day (likely live), or over a day ago (no recent progress likely). The row carries no progress timestamp, so age is the only proxy. All of them start unclaimed, so the next driver resumes them. The per-tab `activeIngests` set in `lib/knowledge.ts` (I-02's file) is untouched. It is now redundant but harmless.

**Handoff to I-02: `ingestLoop` in `lib/knowledge.ts` must not count a `busy` answer as a stalled round** (found in review fix pass 3). After an invocation is killed mid-batch, its claim stands for up to five minutes. Every POST then waits about 28 s and answers `busy` with `pagesIndexed` unchanged. After three such rounds (about 90 s, well inside the TTL), `ingestLoop` throws "Indexing stalled … turn off AI vision … then rebuild". That advice is wrong: the document resumes by itself once the claim lapses, and a rebuild re-bills every vision page. Before this branch, a killed invocation simply re-POSTed and resumed. The loop should wait out `retryAfterMs` on a `busy` answer and not count it toward the stall. The same package's `visionRetryAttempts` handoff is under ING-6.

The cron's side of the same risk is reduced here. `syncAllKnowledgeSources` defaulted to a 45 s budget, and the cron runs the drain (40 s) right after it, inside the 60 s kill window its own comment cites. The sync now defaults to 15 s (`KNOWLEDGE_SYNC_BUDGET_MS`, ILIFE-13), so the drain is not pushed past the kill, where it would lose its batch and leave its claim standing. Decision: `DEC-58`.

**Pending build (DEC-29 item 4).** On this branch, `npx tsc --noEmit`, `npx eslint --max-warnings=0` on every changed file, and the full `npx vitest run` pass. `next build` was not run: the fleet's standing rule leaves it to the integrator, who runs it before merging and records it in the round section. This status stands on that build. If the build fails, the finding returns to OPEN.

---

<a id="ing-3"></a>

## ING-3 · Rev-up refresh deletes chunks but never knowledge_page_entities — tags from superseded revisions survive and feed the census, the Bridge, and asset discovery

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeSourceSync.ts:242-260`, `lib/knowledgeIngest.ts:399-402`, `lib/equipmentBridgeServer.ts:66`, `app/api/knowledge/ask/route.ts:945-954`, `app/api/knowledge/ask/route.ts:1055-1057`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigation: the only path that clears orphaned entities is the manual rebuild button, and its comment ('this time') is itself an acknowledgement that the sync path does not. Stale tags from deleted sheets feed a census the prompt instructs the model to trust as exact.

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

**Resolution (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) against the pre-fix code. After a rev-up refresh, all of the old revision's page entities, its machine mentions, its cached line trace and `vision_pages` survived, with only the chunks gone. A re-ingest of a shorter revision left the entity rows past its last page. What landed:

- **One reset.** `resetKnowledgeIndex(documentIds, { rowUpdate, purgeLineTraces })` in `lib/knowledgeIngest.ts` is the one reset of a document's derived index. It is exported under that stable name for I-07's drawing rebuild, and I-11's GAP-309 builds on it. Under the document's ingest claim, and each step checked, it deletes:
  - `knowledge_chunks` (and with them their embeddings);
  - `knowledge_page_entities`, every kind;
  - the MACHINE-derived `entity_mentions` (`is_explicit = false`; a person's pin survives);
  - on a rev-up, the cached `knowledge_line_traces`. Their migration comment assumed a new revision gets a new row, and it does not.

  The ORDER is what makes an interrupted reset safe. On a rev-up, the cached traces go first, while the row still names the old file. A failure there leaves everything as it was, and the next pass repeats the whole reset. Next, THE ROW is queued (`stale`, every counter zeroed, re-pointed on a rev-up), BEFORE any chunk or entity is deleted. An interrupted reset therefore leaves a queued row, never a `ready` row whose chunks are gone (which Ask would silently return nothing for). A delete that fails after that is reported, and it is not lost. The first batch of the new index generation, under the claim, clears EVERY chunk and page entity of the document before writing, not just its own page range. The mention pass replaces the machine mentions when the document reaches `ready`.
- **The refresh uses it.** The rev-up REFRESH branch of `syncKnowledgeLibrarySources` calls it with the new `file_key` / version / rev. Every failure is reported in the sync's errors, as `chunkErr` was.
- **Mentions come back.** The reset drops the machine mentions, so `ingestKnowledgeDocBatch` rebuilds them (`rebuildDocumentMentions`, the route's old 8-second-capped mention pass, moved into the lib) wherever a batch takes the document to `ready`. That covers the cron drain too, not only the interactive route. An accepted partial index rebuilds them as well.
- **Pruning.** Every main-pass ingest batch deletes chunks and entities with `page > pageCount`.
- **Existing residue.** `20261122` §7 deletes the page entities and chunks already sitting past their document's page count. They are counted in the pre-apply inventory.

Tests:
- `lib/__tests__/sourceSync.test.ts`: "chunks, page entities, machine mentions and cached traces go; a person's pin stays; the row restarts"; "rev N has fewer sheets than rev N-1: after the re-read no entity survives past the new page count"; "the row is queued BEFORE the index is deleted: a purge that fails part-way never leaves a 'ready' row without its chunks"; "a purge that fails before the row moves leaves the old version…"; "a cron-drained rev-up gets its document↔equipment mentions back when the re-index reaches 'ready'".
- `lib/__tests__/ingestLock.test.ts`: "a revision with fewer sheets keeps nothing past its last page"; "a new index generation's first batch clears everything the last one left — even past its own page range".

**Done-when.**
- ✓ The refresh branch deletes `knowledge_page_entities` for the document alongside `knowledge_chunks`. It also deletes machine mentions and, on a rev-up, cached traces.
- ✓ A re-ingest of a document whose page count shrank prunes entity rows (and chunks) with `page > page_count`.
- ✓ A test covers "rev N has fewer sheets than rev N-1" and asserts no entity row survives past the new page count.

**Scope / residual.** The code needs no migration. `20261122` §7 cleans residue already in the database (pending apply). If a reset is interrupted after the row is queued, the old rows it had not yet deleted stay until the re-index's first batch. The document is `stale`, so Ask does not retrieve it, but the entity readers do not filter on status. Some old-revision tags cannot be found in SQL: a re-ingest that completed before this landed may have left them on pages the new file still has, because entity rows carry no revision. The next rev-up or rebuild clears them, and the inventory counts the stale-mirror population. Rows the Bridge already derived from superseded tags (`documents.asset_tags`, `document_assets`) are I-11's GAP-309 delta, which consumes this reset. They are not purged here. Decision: `DEC-58`.

**Pending build (DEC-29 item 4).** On this branch, `npx tsc --noEmit`, `npx eslint --max-warnings=0` on every changed file, and the full `npx vitest run` pass. `next build` was not run: the fleet's standing rule leaves it to the integrator, who runs it before merging and records it in the round section. This status stands on that build. If the build fails, the finding returns to OPEN.

---

<a id="ing-4"></a>

## ING-4 · Tables are never atomic: splitTables/chunkPageText's whole table path is unreachable from ingestion

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeText.ts:305`, `lib/knowledgeText.ts:53-86`, `lib/knowledgeText.ts:88-127`, `lib/knowledgeIngest.ts:316-328`, `lib/knowledgeVision.ts:49-51`, `lib/__tests__/knowledgeText.test.ts:312-345`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The code claim is exactly right and decisive. Severity lowered because the finding missed a live guard: the safety net splitTables' own comment claims to have retired ('the answer prompt then had to carry a standing disclaimer … needs no disclaimer') is STILL in the prompt — app/api/knowledge/ask/route.ts:1501-1502 requires a '**Check:**' line 'whenever a value comes from a table, because PDF table extraction jumbles numbers'. Answers built on jumbled tables are therefore still flagged to the reader, making this a serious quality regression rather than an unguarded wrong-value path.

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

**Partial (2026-09-30, intelligence Round G).** Code complete, pending activation: chunker 2 is built and tested, but no library uses it until `20261122` is applied and a controller runs the re-index. Today the only way to run it is the API; the button is I-02's. Per 99, the demonstration was re-run against a real ingested document shape before the chunker was touched. A PDF written with pdf-lib was read back through unpdf's text layer, with ingestion's own line rebuild, and run through `splitPageIntoSections` → `chunkPageText`. The re-run found:

- **The finding holds.** The production path (the space join) yields one flattened chunk: `…TABLE 3 - BOLT TORQUE Size Torque Notes 1/2" 45 ft-lb dry 3/4" 100 ft-lb dry…`.
- **The proposed one-line fix was not enough.** With the lines kept, the text-layer table was STILL not detected. `isTableLine`'s pattern `\S\s{2,}\S+\s{2,}\S` needs the middle cell to be a single token, and `1/2"   45 ft-lb   dry` has a space in it. The existing unit test "column-aligned text-layer tables are detected too" had been passing on the prose path, never as a table.
- **The repo's two real P&ID fixtures have no tables.** Both chunkers yield the same words for them.

What landed, per the decision (`DEC-58`), is chunker 2 in `lib/knowledgeText.ts`:

- `splitPageIntoSections(lines, carry, { keepLines })` joins a segment's lines with `"\n"`.
- `pageLinesFromTextItems(items, { columnGaps })` MEASURES the gap between text items. A gap wider than one font-size is a column (three spaces); whitespace-only items are dropped; missing geometry falls back to one space. A table row and word-per-item prose no longer look alike.
- `isTableLine` counts three or more cells split on runs of 2+ spaces. That accepts every row the old pattern accepted, plus multi-word cells.
- `chunkPageText` is unchanged.

Chunker 1 stays byte-for-byte what it was. The inline line rebuild moved into `pageLinesFromTextItems`, and a test pins it to the old loop. It is still every library's default.

A library moves only by an explicit action: `POST /api/knowledge/ingest { action: "reindex", libraryId, chunker: 2 }` in `app/api/knowledge/ingest/route.ts`, which calls `reindexLibraryChunks` in `lib/knowledgeIngest.ts`.

- It is controller-only (the role collection decides).
- **A dry run comes first.** `dryRun: true` changes nothing. It answers `{ documents, toReset, visionPagesToReread }`: the documents a run would reset, and the AI-vision pages they would read (and bill) again. That is the number to confirm before anything is deleted.
- **The intent is recorded before anything is reset.** A real run writes `KNOWLEDGE_LIBRARY_REINDEXED` (chunker, `toReset`, `visionPagesToReread`) first, as a checked write. A run that cannot be recorded changes nothing. Only then is the library's choice recorded, and then its documents are reset through `resetKnowledgeIndex`.
- **It is bounded and resumable.** Documents are reset one at a time until the invocation's deadline. The answer says `remaining`: run it again to continue. A document already on the chosen chunker, or with nothing indexed yet (its first batch takes the library's choice), is skipped. A re-run therefore never resets, or re-bills, a document twice. A document mid-batch is reported `busy`, and the next run picks it up.
- **An interrupted reset is safe.** The reset queues each row before it deletes anything (ING-3), so a kill mid-document leaves that document re-queued, not `ready` with no chunks.

`knowledge_libraries.chunk_version` records the library's choice. `knowledge_documents.chunk_version` stamps the chunker a document started with, so its chunk boundaries never mix.

**A failed library read never picks the chunker** (review fix pass 3). A document's first batch reads its library's `chunk_version`. That read used to fall back to chunker 1 on ANY error. On a chunker-2 library, a transient error therefore stamped the document chunker 1, and the next re-index reset it and re-billed its vision pages, against the "never twice" rule above. Now only a database without the column (`isMissingColumn`) falls back to chunker 1. Any other error stops the batch before anything is written, and the batch is retried like any failed batch (ING-8). Test: `lib/__tests__/ingestLock.test.ts` "a failed library read never picks the chunker: the batch stops (and is retried) rather than stamping chunker 1".

Tests:
- `lib/__tests__/knowledgeText.test.ts`: "re-run on a REAL extracted PDF…", "the repo's real P&ID fixtures: chunker 2 invents no table and loses no word", "a vision-transcribed table…", "keepLines…", "a text-layer row with multi-word cells is a table line…", "the FIGURE 5-1 span table now really is its own chunk", and the `pageLinesFromTextItems` block.
- `lib/__tests__/ingestLock.test.ts`: "a vision-read table is ONE chunk…", "chunker 1 … is unchanged", "a document keeps the chunker it started with…".
- `lib/__tests__/ingestRoute.test.ts`: the reindex block ("a dry run says what the re-index would reset and re-bill — before anything is changed", "the intent is audited first, then every document resets" — including a re-run that resets nothing, "a run that cannot record its intent changes nothing", "… the next run picks it up", "bounded by a deadline…").

**Done-when.** Each criterion holds under chunker 2 only. The default ingestion path (chunker 1) is deliberately unchanged, per the decision: every chunk boundary moves, and so does every vision bill.
- ✓ (chunker 2) `splitPageIntoSections` keeps line structure, so `splitTables` sees real rows.
- ✓ (chunker 2) Tests assert on the FULL ingest path over real PDFs (pdf-lib → unpdf → the production line rebuild → `splitPageIntoSections` → `chunkPageText`), and through `ingestKnowledgeDocBatch`.
- ✓ (chunker 2) A vision-transcribed table with ` | ` separators comes out of the ingest path as ONE chunk with `\n` between its rows. This is asserted as a pure function and through the engine.
- ✗ Not yet active anywhere. No library reaches chunker 2 until `20261122` is pasted and a controller runs the re-index.

**Scope / residual.**
- Pending migration: `20261122_intel_roundG_ingest_integrity.sql` (the two `chunk_version` columns). Without it the action answers 424 naming the migration, and every library stays on chunker 1.
- The "Re-index with table-aware chunking" button on the knowledge library page (`app/(protected)/knowledge/[id]/page.tsx`) is I-02's file. It is handed over with the API contract above: a dry run to show `visionPagesToReread`, then the run, repeated while `remaining` > 0 and the last run reset something. Until it lands, the action is reachable through the API only. The button's copy should also say what the dry run does not count. Every document it resets is `stale` with its chunks gone, so the library drops out of Ask until each one is re-indexed. For a vision library on the daily cron, that can take days.
- OPEN until `20261122` is applied and the I-02 button ships.
- The meaning index re-embeds the new chunks through its own pipeline. Re-arming it after ingestion is I-02's SEM-8.
- The answer prompt's table-value "Check:" line (`app/api/knowledge/ask/route.ts`, I-03) is left as is, because chunker 1 libraries still need it.

---

<a id="ing-5"></a>

## ING-5 · 'anchor' is a fifth entity kind written on every page, but ENTITY_KINDS documents itself as complete and omits it — and the guard test exempts the writer

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:301-313`, `lib/knowledgeEntityKinds.ts:25-33`, `lib/__tests__/entityKindGuard.test.ts:26-33`, `lib/knowledgeIngest.ts:417-425`, `app/api/knowledge/ask/route.ts:1296-1299`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct on every point. Lowered to LOW because there is no live consequence: 20260925_entity_kinds.sql drops the kind CHECK entirely so 'anchor' inserts succeed, and every bulk reader already names its kinds in the QUERY (ask/route.ts:952 `.in("kind", TAG_ENTITY_KINDS ...)`, equipmentBridgeServer.ts:69 `.eq("kind","equipment")`), so anchor rows never compete for a row cap. The only consumer of anchors, ask/route.ts:1298, filters `.eq("kind", "anchor")`. This is a documentation/latent-hazard defect, not a current defect.

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

**Resolution (2026-10-01, intelligence Round G, I-07).** Verified against HEAD first (DEC-29): `lib/knowledgeIngest.ts` writes five entity kinds (`equipment`, `ref`, `opc`, `self`, `anchor`), `ENTITY_KINDS` declared four, and the guard exempted the writer by file. What landed:

- **The inventory is complete.** `lib/knowledgeEntityKinds.ts`: `ENTITY_KINDS` now includes `"anchor"`, and the module's table of kinds describes it: on every page, prose included, so the most numerous kind in a standards library. `TAG_ENTITY_KINDS` states that `anchor` is excluded and why. A caption's address is not a tag, and in a bulk read it would swamp the drawing kinds under the row cap; its one reader asks for it by name.
- **The guard holds the inventory to the writer, both ways.** `lib/__tests__/entityKindGuard.test.ts` collects every entity `kind:` literal `lib/knowledgeIngest.ts` pushes (`page: p, kind: "…"`, so the lease's own `kind:` union is left out). It asserts that each one is declared, AND that each declared kind is one the ingest writes. A kind can no longer be written undeclared, or declared ahead of its writer. DWG-2's `'line'` kind will have to be declared when its ingest call lands.
- **The guard is per read.** The file exemption for the writer is gone with the rest (DWG-12): every statement in every file is checked, and writes are recognised as writes.
- **CORE_KINDS re-decided: kept, and pinned.** The fallback fires only on a database that never applied `20260925`, whose column CHECK admits exactly `('equipment', 'ref')`. `CORE_KINDS` must equal that list, or the fallback insert fails again. A test pins `CORE_KINDS` to `20260921`'s CHECK, and pins `20260925`'s `DROP CONSTRAINT`.

Tests: `lib/__tests__/entityKindGuard.test.ts`, block "the entity-kind inventory is the ingest's, both ways (ING-5)":
- "every kind the ingest writes is declared in ENTITY_KINDS";
- "every declared kind is one the ingest writes — nothing declared ahead of its writer";
- "anchor is declared but kept out of the tag kinds every census reads";
- "the CHECK fallback keeps exactly the kinds the pre-20260925 CHECK admits (CORE_KINDS re-decided)".

**Done-when.**
- ✓ `ENTITY_KINDS` includes `"anchor"`, and `TAG_ENTITY_KINDS` explicitly states it is excluded and why.
- ✓ The guard test asserts that every `kind: "…"` literal written in the ingest insert appears in `ENTITY_KINDS`, and the reverse.
- ✓ The CHECK-constraint fallback's `CORE_KINDS` choice is re-decided: kept as exactly the pre-`20260925` CHECK's list, for the reason above, and pinned. `lib/knowledgeIngest.ts` is not edited.

**Scope / residual.** None.

---

<a id="ing-6"></a>

## ING-6 · A vision call that fails on a provider error is committed as an empty page and the document still reaches 'ready' — no counter, no flag, no error

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:186-197`, `lib/knowledgeIngest.ts:180-185`, `lib/knowledgeIngest.ts:315`, `lib/knowledgeIngest.ts:431-437`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. One wording correction: a counter DOES exist — `emptyPages` is returned at knowledgeIngest.ts:470 — but grep shows `emptyPages` appears nowhere else in lib/, app/ or components/, so it is never persisted, never displayed and never gates 'ready'. The document reaches ready with error: null and no record of which sheets the provider dropped.

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

**Partial (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) against the pre-fix engine. A vision call that failed with a provider error (`provider 529 overloaded`) left the page textless, and the document reached `status: 'ready', error: null`. Following the decision's default (DEC-58), `lib/knowledgeIngest.ts` `ingestKnowledgeDocBatch` now handles the failure like this:

- **The failed read is recorded.** The page keeps whatever its text layer holds, and its number goes onto `knowledge_documents.vision_failed_pages` with the provider's message (`visionError`).
- **The document is held.** It does not reach `ready` while any failed page remains.
- **The page is retried on the next pass.** Once the main pass is through, a batch re-reads only the failed pages (forced vision, the page's section recovered from the chunk before it, its chunks and entities rewritten) and removes each one it reads.
- **A retry that cannot run, or fails again, is said, and it never errors the document.** Ask retrieves only documents in `ready` or `indexing`, so marking a partly-read document `error` would drop ALL of it from answers. Instead the batch returns `visionRetryBlocked` and "parks" the row, under its compare-and-set, releasing the claim in the same UPDATE. The document keeps its whole index and stays `indexing`. `error` carries the plain message (`visionRetryMessage`: which pages, why, what to do, and that the rest is searchable meanwhile). `knowledge_documents.vision_retry_after` (new in `20261122`) records when the pages are next tried:
  - **No AI key** (a keyless controller's tab, the cron without a sponsored key): stamped now. This is decided before anything is downloaded. It holds no driver back, but it files the document behind every document with real work in the cron's queue. The drain orders `vision_retry_after` NULLS FIRST, so waiting documents can never fill its 20-row head. **Corrected in review fix pass 5:** that holds only while each park moves the stamp. Fix pass 4's keyless skip (below) never re-stamped, so a parked document kept the stamp of its first park for good. The drain's queue (oldest stamp first, 20 rows, no org filter) then took the same twenty parked documents every night, and a lapsed failed batch (ING-8) behind them, in any org, was never retried (the reviewer's probe P2). Now the skip applies only while the stamp is under half an hour old (`VISION_RETRY_BACKOFF_MS`); an older stamp is written again, to now. Parked documents rotate behind, and the failure comes up on the next run. **Corrected again in review fix pass 6.** Two parts of that were not true:
    - **Rows the drain skipped untouched.** In a library marked "read every page with vision" with no sponsored key, the drain skipped the row with `continue` and never claimed, stamped or moved it. A mirror carries no uploader (`created_by` is never set by the sync), so it has no sponsor, ever. Never stamped, such rows sort first (NULLS FIRST): twenty of them, in any org, took the whole twenty-row head every night, and no lapsed failure or parked document was retried by the nightly run (the reviewer's probe D1). Now the drain files such a row behind what lapsed before now (`fileBehind` in `drainKnowledgeIngestQueue`): its `vision_retry_after` moves to the run's time, as a compare-and-set on the stamp as read, on a row no one holds the claim on. A stamp still in the future (a back-off in force) already files it behind now and is never shortened. A stamp that cannot be written is reported in the run's `errors`.
    - **"On the next run."** With more than twenty rows stamped before the failure lapsed, it is not the next run. The real bound: the drain takes at most twenty rows a run, across every org, never-stamped work first and then the oldest stamp. Every row it meets but cannot work on is re-stamped to the run's time. So with N queued rows stamped before the failure lapsed, the failure comes up on run ⌊N / 20⌋ + 1 after it lapsed: the second for twenty (probe P2), the third for forty (the reviewer's probe D2, now a test). It comes later still when never-stamped work comes first (a document the drain works on but does not finish commits a NULL stamp and comes first again), or when a run's page budget or time ends before its twentieth row. An open controller tab in its org retries it within minutes regardless.
  - **Every waiting page refused again this round** (a provider still rate-limiting): a back-off of `VISION_RETRY_BACKOFF_MS` (30 minutes). No driver, with a key or without, asks the provider again before then; each finds the back-off and does nothing. The back-off is a floor: the pages are tried on the next indexing pass after it, which is an open controller tab or the nightly maintenance run. Since review fix pass 4, the message says so instead of "in about 30 minutes" (see ING-8). What a "round" is, see the next point.

  The route answers a parked document with 409 and the message, so a library-page loop stops on a parked document with the real reason instead of "stalled". The drain moves on. A successful retry clears both `error` and `vision_retry_after`. A park that read nothing (no key, or no page left to try this round) keeps a failed batch's count (ING-8, review fix pass 4). Its stamp is then the vision retry's, not the failed batch's. Since review fix pass 5 it is reported (`visionRetryBlocked`, not `failureRetryBlocked`) and held as one, and a person's `retryNow` does not skip it (ING-8). A keyless driver that finds its own reason already on the row, with its stamp passed but under half an hour old, writes nothing but the claim and its release (review fix pass 4; the age limit is review fix pass 5). The message offers only what a person can do from the app today: "…ask an admin to accept the partial index". There is no acceptance button yet (I-02's page), so the first wording ("Or accept the partial index") offered an action the UI lacked. Changed in review fix pass 2. Since review fix pass 5 the provider's message is cut to fit the row's 500 characters (surrogate-safe, marked "…"), so the cadence and the way out that follow it always survive.
- **The retry queue rotates, so no page is starved** (review fix pass 3). The retry pass used to walk `vision_failed_pages` in page order within its four-page budget, and back off as soon as all four of its tries failed. The reviewer's probe showed what followed: with eight failed pages, of which 1–4 fail every time (`400 image exceeds 5 MB maximum`) and 5–8 would read, every pass tried 1–4 and backed off. Pages 5–8 were never tried, and the row kept telling the user all eight were "tried again automatically". Now:
  - `vision_failed_pages` is a queue, least recently tried first. A page whose retry fails again goes to the back.
  - `vision_retry_tried` (new in `20261122`) holds the pages that failed again since the last back-off: the current round. The pass tries only pages not yet tried this round.
  - It backs off only once every waiting page has had its try. If the batch that completes the round read some pages, its commit records them and starts the back-off in the same UPDATE.
  - Until then, a batch whose tries all failed commits the rotated queue and moves on. The next batch, with no back-off, tries the pages behind. The cron drain counts those tries as work (`visionRetryAttempts`), so it walks a whole round in one run.

  In the probe's case, the first batch tries 1–4 and rotates them to the back, and the second reads 5–8 and backs off for 1–4. After the back-off, 1–4 are tried again. Only pages 1–4 stay listed.
- **The explicit exit.** `POST /api/knowledge/ingest { documentId, action: "accept-partial" }` is controller-only. It makes the document `ready` with the unread pages still listed. Review fix pass 2 tightened it in three ways:
  - **The claim.** It takes the document's ingest claim, like every writer: while a retry batch holds the claim it answers 409, and the acceptance and the claim's release are one UPDATE. A batch commit never writes back a `vision_partial_accepted` it read (only a new generation clears it), so no batch in flight can undo an audited acceptance.
  - **Audit first.** It is audited FIRST, as a checked write (`KNOWLEDGE_DOC_PARTIAL_ACCEPTED`, with the page list and the file and version it is about). An acceptance that cannot be recorded changes nothing.
  - **Compare-and-set.** Its UPDATE compares the row's file, version and resume point, so a rev-up that re-points the row under it wins (409; ING-1).
  - **Once.** Added in review fix pass 3. An acceptance of a document already accepted, or already `ready`, answers 409 after taking the claim. A double click or a client's retry no longer writes a second audit row or runs the Bridge again.

  An accepted document feeds the equipment Bridge and gets its mentions rebuilt, exactly as one the engine completed (`onDocumentReady`). Before, the Bridge was not fired, so an accepted drawing never reached the registry without a manual sweep.
- **The API contract, and where it falls short.** `pagesIndexed` stays the resume point. The failure-adjusted count is the new `pagesReadable`. **Corrected in review fix pass 2.** The first record said this kept the clients' stall detectors whole, and it does not for a SUCCESSFUL retry. A retry batch re-reads failed pages without moving the resume point, so `pagesIndexed` answers the page count every time, while `visionFailedPages` falls by up to four a batch. The library page's loop (`ingestLoop` in `lib/knowledge.ts`, I-02's file) counts only a rise in `pagesIndexed` as progress, and gives up after three rounds without one. With more than about twelve failed pages, it throws "Indexing stalled at page N of N … Turn off 'Index every page with AI vision' … then rebuild" while the retries are succeeding. That advice is wrong, and a rebuild re-bills every vision page. **Handoff to I-02:** `ingestLoop` must count a fall in `visionFailedPages.length`, or a rise in `pagesReadable`, as progress. The cron drain had the same blind spot and is fixed here. It counts a retry batch's re-read pages as progress, and keeps going while its budget and deadline allow; before, it stopped after one batch, which meant four pages a day for a document waiting on forty.

A transcript under 60 characters (the model saw nothing legible) is counted as a read, empty page (`empty_pages`, ING-11), not a failure, because re-reading it changes nothing.

Tests:
- `lib/__tests__/ingestLock.test.ts` ING-6 block:
  - "records the page, holds 'ready', retries it on the next pass, then completes";
  - "a retry pass in which every page fails again backs off and says so — the document stays 'indexing' and retrievable" (with the back-off holding, then running out and completing);
  - "a keyless driver (a controller's tab without a key) leaves the document 'indexing' and retrievable, with the reason on the row";
  - "a keyless driver that finds its own reason already on the row gives the claim back and writes nothing else" (review fix pass 4);
  - "a keyless park whose stamp is half an hour old or more is written again, to now: its place in the cron's queue moves behind fresh work" (review fix pass 5);
  - "twenty keyless-parked documents never keep the nightly drain from a lapsed failed batch: it is retried on the next run" (review fix pass 5, the reviewer's probe P2: the first run re-stamps the twenty, the second completes the failed document);
  - "twenty unsponsored documents in a read-every-page library never keep the nightly drain from a lapsed failed batch" (review fix pass 6, the reviewer's probe D1: twenty never-stamped mirrors with no uploader; the first run files them behind, the second completes the failure; a row there whose back-off is in force keeps it, untouched);
  - "the bound on the nightly retry: a lapsed failure behind N rows stamped before it lapsed comes up on run ⌊N / 20⌋ + 1" (review fix pass 6, the reviewer's probe D2: forty parked rows, the failure completes on the third run, not the second);
  - "the cron drain without a sponsored key does the same — never 'error', never billed";
  - "documents waiting on a vision retry can never hold the head of the cron's queue";
  - "the cron drain keeps going while vision retries succeed: a retry batch's re-read pages are its progress" (20 failed pages, read back in one drain run; it fails if the drain counts only the resume point);
  - "pages that fail every time never starve the ones behind them: the queue rotates, and it backs off only after every page's try" (the reviewer's probe: 1–4 fail every time, 5–8 are read, only 1–4 stay listed);
  - "the cron drain walks a whole round in one run: the pages behind the failing ones are read, and only those that fail stay listed";
  - "the parked message offers only what the app can do today";
  - "an accepted partial index is 'ready' with the unread pages still listed".
- `lib/__tests__/ingestRoute.test.ts`:
  - "a keyless controller's POST on a document awaiting a vision retry: 409 with the reason; the document stays 'indexing' and searchable";
  - "accept-partial takes the claim: refused while a retry batch holds it…";
  - "accept-partial on a document already accepted is refused: no second audit row, no second Bridge pass" (review fix pass 3);
  - "an accepted partial index is not undone by a batch that runs afterwards; its mentions are rebuilt and it feeds the Bridge";
  - "an acceptance that cannot be audited changes nothing";
  - "accept-partial: a rev-up that re-points the row under the acceptance wins…" (ING-1);
  - "accept-partial: …", "accept-partial refuses…", "a member without a controller role…";
  - "the response says how many pages AI vision could not read";
  - "on a database without 20261122 the note does not promise a retry: the page was indexed with its text layer only" (review fix pass 3).

**Done-when.**
- ✓ Failed pages are recorded per document (`vision_failed_pages`). They are surfaced on the ingest response's `visionSkipReason` ("N pages could not be read by AI vision (…) — retried automatically…"), which the app-shell indicator renders directly under "N pages read by AI vision". Showing it permanently on the library's document list is `app/(protected)/knowledge/[id]/page.tsx`, I-02's file; the column is on every row it already reads.
- ✓ The pages are re-queued, not committed as read. The document does not reach `ready` while any remain, except by an explicit, audited acceptance. It is never pushed out of retrieval meanwhile: a retry that cannot run, or fails again, leaves it `indexing` with the reason on the row, never `error`. Every waiting page gets its try: the queue rotates, and a pass backs off only after a whole round (review fix pass 3; before it, pages behind four persistent failures were never retried).
- ✗ Not done here. The DRAWING FACTS prompt block is in `app/api/knowledge/ask/route.ts` (I-03 is its sole owner). The count it needs is `knowledge_documents.vision_failed_pages`.

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql` (`vision_failed_pages`, `vision_retry_tried`, `vision_retry_after`, `vision_partial_accepted`). Without it the unclaimed path cannot record a failure: the page is committed textless as before. The response now says so. The batch result carries `legacy: true`, and the route's note reads "indexed with the text layer only: this database cannot hold them for a retry…". Before review fix pass 3 it promised a retry and a held `ready` that the legacy path does not give. OPEN until I-03 states the unread count in DRAWING FACTS.

Handoffs, since none of these files is this package's:
- **I-02, `app/(protected)/knowledge/[id]/page.tsx`.** The "accept the partial index" exit is reachable through the API only. Its button, and showing `error` on a document that is still `indexing`, belong on this page. It shows `error` only for status `error` today. Its Resume button (`resumeIndex`) is also to pass `retryNow: true` through `ingestKnowledgeDocument` (ING-8), so a person's click skips a failed batch's back-off; the page's automatic loop must not.
- **I-02, `lib/knowledge.ts` `ingestLoop`.** The stall detector must count a successful vision retry as progress; see "The API contract" above. Until then, the library page's resume can throw a false "stalled" on a document with more than about twelve failed pages while the retries succeed. It must also count `visionRetryAttempts > 0` as activity: a batch whose tries all failed moves neither `pagesIndexed` nor `visionFailedPages`, but it rotated the queue, and the next batch tries other pages. The `busy` handoff (under ING-2) is the same loop.
- **`components/providers/KnowledgeIndexIndicator.tsx`: owner named here as I-02**, the knowledge-UI package; it is in no package's file list. A parked document (failed pages that cannot be retried now, or are backing off) stays `indexing`, and so does one whose failed batch is backing off (ING-8). The app-shell indicator polls every `indexing` row every 120 s in every controller tab. It calls `setHidden(false)` and shows "Indexing <doc>", then "Knowledge indexing caught up — 0 documents indexed", over and over, even after the user dismisses it. Each poll is a POST that costs about eight queries and answers 409. Its queue should leave out rows with `vision_retry_after` set or `error` non-null, and it should re-show the card only when a batch made progress. It must never pass `retryNow` (ING-8), which is for a person's Resume.
- **I-07, `app/api/knowledge/drawing/route.ts`.** The drawing lens shows a parked document's sheets as "indexing" for as long as the document is parked. It should say which sheets wait on AI vision, and why, from `vision_failed_pages` and `error`.

**Handoff landed (2026-10-01, intelligence Round G, I-07).** The drawing-lens limb is done. In `app/api/knowledge/drawing/route.ts`, a parked document (`vision_retry_after` set, or a non-null `error` on a document that is not `error`) is shown as `indexing`, never as a finished sheet, and is not counted ready. Each such sheet carries `waiting: { pages (from vision_failed_pages), reason (error), retryAfter }`, and the panel shows "⏳ page(s) … wait on AI vision — <reason>". An ACCEPTED partial index is finished: its unread pages are listed (`acceptedUnread`), not shown as waiting. Its audit verdict is `skipped` while it waits. Test: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a parked document is indexing, with the pages it waits on and why — never ready". No status change: ING-6 stays OPEN for I-03's DRAWING FACTS limb.

---

<a id="ing-7"></a>

## ING-7 · Chunk boundaries are page-scoped: a provision spanning a page break is never in one chunk, and the 160-char overlap does not cross pages

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:123`, `lib/knowledgeIngest.ts:316-328`, `lib/knowledgeText.ts:140-161`, `lib/knowledgeIngest.ts:119`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. True by construction, and slightly understated — chunking is per SECTION SEGMENT within a page (knowledgeIngest.ts:316-321), so a provision straddling a section heading is split too. I searched for a mitigation and found none: the ask route has no neighbouring-page expansion, the orchestrator has no read-page tool, and the per-document cap of 3 in fuseTier (ask/route.ts:526-533) actively reduces the chance both sides of a page break are retrieved together.

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

**Partial (2026-09-30, intelligence Round G).** Code complete, pending activation (as ING-4): the carry is part of chunker 2, which no library uses until `20261122` is applied and a controller re-indexes it. Reproduced with the finding's own example: under chunker 1, the provision "Preheat shall be maintained at not less than 175F for P-No. 5 materials over 1/2 in. nominal thickness, except …", split across a page break, appears intact in no chunk. What landed is part of chunker 2 (see ING-4 and `DEC-58`; opt-in per library, never automatic):

- **`pageTail` (`lib/knowledgeText.ts`).** It finds the unfinished sentence at the foot of a page: the words after the last stop that is followed by a capital, so the standards' abbreviations ("P-No. 5", "1/2 in.") do not cut it short. It is empty when the page ends on a sentence end, and capped at 400 characters, surrogate-safe.
- **The carry (`ingestKnowledgeDocBatch`).** Like `last_section`, the tail is carried into the first chunk of the next page when that page continues the same section. It is marked `[cont. from p. N]` so a reader checking page N+1 can see which words came from page N.
- **Across batches.** Across a batch boundary the tail is read back from the last chunk stored for the previous page. A chunk with a line break is a table and carries nothing.
- **Short heads survive.** A short continuation at the top of a page used to be dropped by `chunkProse`'s 40-character floor. It now travels with its beginning.
- **Prose only.** A drawing sheet has no sentence to finish. Its foot is a title block or a tag list, and carrying that onto the next sheet would put sheet N's tags on sheet N+1. A review probe showed a transcript's whole title block and tag list coming back as the "tail". So:
  - `pageTail` returns nothing for a page with no sentence end anywhere, for a tail with no lowercase word (a label run such as `V-101 SUCTION DRUM P-201A CHARGE PUMP`), and for a tail that already holds a carried marker. A carry is never stacked onto the next page.
  - The engine carries neither out of nor into a sheet-like page: one that declared a title block (a `self` entity, text layer or vision transcript alike), or a sparse page dense with tags. Across a batch boundary, a stored page with a `self` entity carries nothing.
  - The page's own tail is taken before any carry is prepended to it.

Tests:
- `lib/__tests__/ingestLock.test.ts`:
  - "a sentence straddling a page break appears intact in one chunk under chunker 2 — and in none under chunker 1";
  - "the carried sentence crosses a batch boundary too (read back from the stored last chunk of page 50)";
  - "a drawing set carries nothing from sheet to sheet under chunker 2 (vision transcripts and text-layer sheets alike)". This covers a sheet whose foot is a lowercase note, and it fails if the sheet gate is removed;
  - "a carry is never carried on…".
- `lib/__tests__/knowledgeText.test.ts`: the ING-7 block, including the finding's sentence, and "carries prose only: a page with no sentence end, a label run, or a carry is never carried".

**Done-when.** Both criteria hold under chunker 2 only.
- ✓ (chunker 2) Ingestion carries a tail of the previous prose page's text into the first chunk of the next page, the same way `last_section` is carried, including across batch boundaries.
- ✓ (chunker 2) A test asserts that a sentence straddling a page break appears intact in at least one chunk.
- ✗ Not yet active anywhere (see ING-4).

**Scope / residual.** Activation, the pending migration and the UI button are ING-4's. Neighbour-chunk expansion at retrieval time was not built; it was not asked for. A carried tail places up to 400 characters of page N's prose in a chunk cited as page N+1, and the marker says so. The mention indexer (`lib/mentionIndexer.ts`, I-08's file) reads chunks page by page. A tag named inside a carried prose sentence is therefore also counted on page N+1. The handoff: strip the `[cont. from p. N] …` line (`hasCarriedMarker` in `lib/knowledgeText.ts`) before matching. Drawing sheets never carry, so their tag lists are unaffected. OPEN until ING-4 is activated.

---

<a id="ing-8"></a>

## ING-8 · Entity insert breaks on the first error AFTER deleting the page range — a transient failure permanently blanks the tag layer while pages_indexed still advances to 'ready'

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:399-429`, `lib/knowledgeIngest.ts:427`, `lib/knowledgeIngest.ts:431-446`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the `break` is written for one cause (missing table) but catches every cause, including a statement timeout, after the destructive delete has already run. Chunks for the same pages are committed independently at :340-343, so the document ends up indexed and 'ready' with a permanently blank tag layer for the tail of the batch, and nothing re-runs those pages short of the manual rebuild in app/api/knowledge/drawing/route.ts:365-372.

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

**Resolution (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) against the pre-fix engine. A non-timeout error on the entity insert (`connection reset by peer`) broke the loop after the range delete, and the batch still committed `status: 'ready'` with no tags. What landed, in `lib/knowledgeIngest.ts` `ingestKnowledgeDocBatch` `insertEntities`, is a failure ladder modelled on the chunk path:

- The position-column fallback (pre-20260924) and the pre-20260925 CHECK fallback are kept.
- A genuinely missing table (42P01 / PGRST205) is the only cause that skips the tag layer.
- A statement timeout halves the batch and retries.
- A duplicate key or a vanished row is contention (ING-2).
- Anything else throws `entity insert failed: …` BEFORE the commit, so `pages_indexed` does not move. The batch withdraws the rows it had inserted (review fix pass 2), so nothing of a failed batch stays.

The range clear before the insert is checked the same way (DWG-1).

**What happens to the document after the throw: an automatic, bounded retry** (review fix pass 3). Review fix pass 2 recorded the failure as `status: 'error'`, and the reviewer showed what that did. A transient failure, such as a connection reset on the first entity insert of a batch, took a document that was being indexed, with its earlier pages searchable, out of Ask and out of every automatic queue. Every page already indexed vanished from answers until a person noticed. The base code had committed that batch, blank tags and all, and the document stayed searchable. The finding asks for the batch to be retried, not parked for a person. So both callers, the interactive route and the cron drain, still record the failure through `markIngestFailed`, which now works like this:

- **Under the bound, the failure is retried automatically.** `INGEST_FAILURE_MAX_ATTEMPTS` is 3. The row keeps a queued status. A document with pages indexed stays `indexing`, so those pages stay in Ask. One with nothing indexed yet stays `pending` or `stale`. The row records:
  - `error`: the cause, which attempt this was, and when it is tried again;
  - `ingest_failures`: the count, a new column in `20261122`;
  - a back-off in `vision_retry_after`: 10 minutes after the first failure, 30 after the second (`ingestFailureBackoffMs`).

  Every driver honours the back-off before it downloads anything (`failureBackoffUntil`). The engine returns `failureRetryBlocked`, the route answers 409 with the reason, and the drain moves on.

  **The back-off is a floor, not a schedule.** Corrected in review fix pass 4. Nothing runs on a timer. The retry comes on the next indexing pass after the back-off:
  - within minutes while an Admin or Doc Control member has the app open (the app-shell indicator polls every two minutes);
  - otherwise from the maintenance cron's drain, which runs once a day (`vercel.json`, `0 3 * * *`).

  So a failure no one is watching is next tried the following night, and its third attempt comes about two days after the first. The message now says so: "… — attempt 1 of 3. Indexing is tried again automatically on the next indexing pass (while an Admin or Doc Control member has the app open, or the nightly maintenance run), no sooner than about 10 minutes from now." Before, the message promised "in about 10 minutes", and this record promised that a transient failure heals "the same hour, on the cron". The vision-retry message (ING-6) is worded the same way.

  **Corrected in review fix pass 5: the nightly half.** Fix pass 4's keyless skip (ING-6) broke it. A keyless-parked document kept the stamp of its first park for good. The drain's queue (oldest stamp first, 20 rows, every org) then took the same twenty parked documents every night, and a lapsed failure behind them was never retried (the reviewer's probe P2). Now the skip applies only while the stamp is under half an hour old, and an older one is written again, to now. The parked rows rotate behind, and the failure comes up on the next run (test).

  **Corrected again in review fix pass 6.** That still failed in two ways (ING-6 has the detail):
  - the drain skipped rows in a "read every page with vision" library with no sponsored key without moving them. Mirrors never have a sponsor, so twenty never-stamped ones, in any org, held the head for good (the reviewer's probe D1). The drain now files each such row behind what lapsed before now (`fileBehind`), and never shortens a back-off in force;
  - "the next run" holds only while fewer than twenty rows were stamped before the failure lapsed. The real bound: the failure comes up on run ⌊N / 20⌋ + 1 after it lapsed, for N queued rows across all orgs stamped before that, and later when never-stamped work comes first or a run's page budget or time ends early. So each of the three attempts can take that many nightly runs when no controller has the app open (probe D2, now a test).

  **The message keeps its promise when the cause is long** (review fix pass 5). The attempt count and the cadence are about 265 characters, written after the cause, and the row's `error` holds 500. Fix pass 4 cut the whole message at 500. A cause over about 235 characters lost the cadence, and a longer one lost "attempt N of 3" too, for example a cause carrying a withdrawal note. Now the cause is cut to fit (surrogate-safe, marked "…"), never what follows it. The at-bound message keeps its "re-run it once the cause is fixed" the same way.

  **Corrected in review fix pass 6: every message is cut surrogate-safe.** The record above said so, but three messages still went through a raw `.slice(0, 500)`: the failure written whole for a damaged PDF (permanent) and on a database without `20261122` (legacy), and a mirrored file's non-PDF refusal (`refuseNonPdf`, ING-9). A cut through an astral pair leaves a lone surrogate, which Postgres refuses in the JSON body. The failure write would then error (`marked: false`), the document would keep its queued status with no record, and every driver would retry it, re-downloading the file each time, without bound. All three now use `fitCause` / `truncateSafe`, as do the park and the round back-off's writes (their messages fit already; the cut is the same function either way).
- **Only a batch that did work clears the count.** Review fix pass 4. The reviewer showed that the bound was not a real one. Three writes that did no work set `ingest_failures` back to 0, and two of them also erased the failure's message and restarted the back-off:
  - the commit of a batch that stopped for time or budget before its first page. This is common: the cron drain files lapsed back-offs behind fresh work, so they get the tail of its window, where a vision page (25 s reserve) cannot start;
  - the park by a driver without an AI key, at the vision-retry stage;
  - the park when no failed page is left to try this round.

  The probe used a persistent chunk-insert failure, with attempts alternating between a controller with a key and a tab without one. It re-billed the vision page six times and never reached `error`. Now the commit clears the count, the failure's `error` and its back-off only when the batch did work: it read a page, tried a vision retry, or finished the document (`touched || done || attempted > 0`). Otherwise those three columns stay out of its UPDATE. A park writes `ingest_failures: 0` only when its retry pass tried pages. Both probes are now tests.
- **A person can re-run it at once.** Review fix pass 4. At the base, a failed document could be re-run immediately. The back-off refused a controller's Resume with 409 for up to 30 minutes, because the route cannot tell a click from the automatic loops.
  - `POST /api/knowledge/ingest { documentId, retryNow: true }` skips the back-off.
  - It is controller-only, like the rest of the route.
  - It is audited before anything runs (`KNOWLEDGE_DOC_RETRY_NOW`, with the file, the count, when the back-off lapses and the last error). A re-run that cannot be recorded runs nothing.
  - It is recorded only when a back-off is in force. Otherwise it is an ordinary batch. Since review fix pass 6 it is also recorded only once the engine performs it (below).

  **Corrected in review fix pass 5: in either stage.** One column, `vision_retry_after`, holds both back-offs. The engine let a re-run past the failed batch's gate, but the vision-retry gate right after it read the same stamp. So a re-run of a document whose failed batch was a vision-retry batch was audited by the route, then refused with 409, with no vision call (the reviewer's probes P1 and R1). This record and DEC-58 claimed the re-run for every back-off, but only the main-pass case was tested. Now:
  - the vision-retry gate does not hold a re-run whose stamp is the failed batch's (`retryNow` and `failureBackoffUntil`), so the retry is performed;
  - `failureBackoffUntil` holds only while the row carries the message written for its count ("— attempt N of 3."), not merely some message. A park that read nothing keeps the count but writes the vision retry's reason and round back-off over the failure's. That stamp used to be reported as the failed batch's (`failureRetryBlocked`, carrying the vision message), and a `retryNow` on it was audited and then refused. It is now reported and held as the vision retry's. `retryNow` does not apply to it: nothing is recorded, and the answer is the 409 with its reason;
  - so the route records a re-run only for a back-off the engine then lets it past.

  **Corrected in review fix pass 6: recorded only when it is performed.** The route still wrote `KNOWLEDGE_DOC_RETRY_NOW` before it called the engine, so two re-runs were recorded and then not run (the reviewer's probe K1):
  - **a controller with no usable key** (no AI connection, or the monthly cap reached) at the vision-retry stage. The engine let the re-run past both gates, found no vision context, and parked it. The answer was 409, and the park wrote the keyless message over the failure's cause and moved its back-off to now, for every automatic driver;
  - **a re-run that only met `busy`.** The audit came before the busy-wait loop, so each click was recorded whether or not a batch ran.

  Now the engine records the re-run itself, through the route's callback (`ingestKnowledgeDocBatch(…, { retryNow, onRetryNow })`). It is called once: under the claim, past both gates, with a vision context in hand when the pages waiting are AI vision's, and before anything is downloaded. A record that fails, or throws, gives the claim back and runs nothing. The engine returns `retryNowError`, and the route answers 500 "The re-run could not be recorded, so nothing was run". A re-run with no key that can read the waiting pages is refused before anything is written: `failureRetryBlocked`, with the reason (`visionRetryMessage(pages, null)`: retrying needs an AI key with budget left) and the failure's `failureRetryAfter`. The route answers 409 with that reason and its `visionSkipReason` (no key, or the cap). The failure's cause, count and back-off stay on the row. The route no longer reads the back-off itself: the engine decides from the row as claimed.

  A separate column for the failed batch's back-off would end the aliasing; `20261122` is still unapplied. It would also change every reader of `vision_retry_after`, including the filter handed to I-02, so it was left out (DEC-31).

  The engine takes it as `ingestKnowledgeDocBatch(…, { retryNow })`. **Handoff to I-02:** the library page's Resume (`resumeIndex` in `app/(protected)/knowledge/[id]/page.tsx`, through `ingestKnowledgeDocument` in `lib/knowledge.ts`) is to pass `retryNow: true`. The page's automatic loop and the app-shell indicator never do. Until Resume passes it, Resume inside a back-off answers the 409 with the reason and when the retry comes.
- **At the bound, the document is `error`, for a person.** On the third failure in a row, the message says "indexing failed 3 times in a row; re-run it once the cause is fixed". The back-off is cleared, so a person's re-run is never held back. A person's re-run is one more attempt: if it fails again, the document goes straight back to `error`.

  **This takes the whole document out of Ask until someone re-runs it.** For a persistent failure on one batch of an 800-page document, that is all 800 indexed pages. The reviewer pointed out that this is the outcome DEC-58 item 3 avoids for a vision retry. It is recorded as an accepted risk in DEC-58 item 3, for now. The alternative would keep the queued status, stop the automatic retries, and wait for a person's `retryNow`. It needs two things from the library page (I-02's):
  - showing a failure on an `indexing` row (it shows `error` only for status `error`);
  - a Resume that passes `retryNow`.

  Until both land, such a document would read "Indexing 800 / 1000 pages…" indefinitely, with no visible cause and no way to re-run it. An `error` row shows its message, and Resume re-runs it. Revisit once I-02 lands both.
- **No retry for a damaged PDF.** A file that carries the PDF header but that pdf.js cannot open (`IngestBatchError.permanent`) goes straight to `error`, as ING-9 describes. Retrying cannot mend it.
- **The bound is on re-billing.** The throw comes after the page loop. Each retry reads the batch's vision pages again, up to its four-page budget. So a failure that recurs with no work in between costs at most three batches' worth. The count restarts only after a batch that made progress, and a document has finitely many pages to progress through. The back-off also stops the app-shell indicator (every open tab, every two minutes) and the library page from hot-retrying a failure.
- **Every write stays a compare-and-set.** The write compares what the batch read: the file, the version, the resume point, and now the failure count. It still lands only on the row the batch read (ING-1), and two failures cannot count as one.
- **Before `20261122` there is nowhere to count.** The row carries no count, so a failure is `error` as before. The response's 502 carries `retryAfter` when a retry is scheduled.

Tests: `lib/__tests__/ingestLock.test.ts`:
- "a statement timeout halves and retries; every tag lands and the batch commits";
- "any other failure throws: pages_indexed does not advance and the document is not 'ready'";
- "only a genuinely missing table skips the tag layer";
- "a failed range clear stops the batch before pages_indexed moves";
- "a real failure on the row the batch read is recorded on that document, with the message — and retried, not parked" (its chunks withdrawn);
- review fix pass 3:
  - "a transient entity failure leaves the document retrievable, and a later drain run completes it" (the reviewer's probe);
  - "the interactive driver honours the back-off too…";
  - "a failure that keeps failing is retried a bounded number of times, then the document is 'error' for a person";
  - "a committed batch clears an earlier failure's count";
- review fix pass 4:
  - "a batch that stops for time before its first page did nothing: the failure's count, message and back-off stay, and the next failure is the third" (the reviewer's probe C);
  - "a driver without a key parking the document between failed retry batches never resets the count: the third failure is 'error', after three vision reads" (probe A);
  - "a retry pass with no page left to try this round parks without clearing a failed batch's count";
  - "a person's explicit re-run (retryNow) skips the back-off; no automatic driver does";
  - "a failure record another writer cleared holds nothing back: the drawing rebuild's own reset nulls the message, and the rebuilt index runs" (probe B);
  - ING-6's "a keyless driver that finds its own reason already on the row gives the claim back and writes nothing else".
- review fix pass 5:
  - "a person's re-run of a failed vision-retry batch (retryNow) performs the retry: the failure's back-off shares the vision column and holds it at neither gate" (the reviewer's probe P1);
  - "a retry pass with no page left to try this round parks without clearing a failed batch's count", extended: its stamp is reported as the vision retry's, and `retryNow` does not skip it;
  - "a long cause never pushes the attempt count or the cadence out of the stored message" (with a cut that falls inside a surrogate pair, the at-bound message, and the vision-retry message);
  - ING-6's "twenty keyless-parked documents never keep the nightly drain from a lapsed failed batch: it is retried on the next run" (probe P2) and "a keyless park whose stamp is half an hour old or more is written again, to now…".
- review fix pass 6:
  - "a person's re-run with no key that can read the waiting pages is refused and writes nothing: the failure's record stays, and nothing is recorded" (the reviewer's probe K1, at the engine);
  - "a re-run is recorded only when it is performed: never while another driver holds the claim, and a record that fails runs nothing";
  - "a long cause never pushes the attempt count or the cadence out of the stored message", extended: a pair across the cut at 500 in the permanent (damaged PDF) and legacy failure messages and in a mirrored file's non-PDF refusal is cut whole;
  - ING-6's "twenty unsponsored documents in a read-every-page library never keep the nightly drain from a lapsed failed batch" (probe D1) and "the bound on the nightly retry: a lapsed failure behind N rows stamped before it lapsed comes up on run ⌊N / 20⌋ + 1" (probe D2).

`lib/__tests__/ingestRoute.test.ts` has these:
- "a transient failure answers 502 with when it is retried; the document stays 'indexing' and searchable" (then 409 inside the back-off);
- "a damaged file that does carry the PDF header is an indexing failure…" (straight to `error`, no `retryAfter`);
- review fix pass 4:
  - "inside the back-off the indicator's plain POST waits; Resume's retryNow runs the batch at once, audited first";
  - "a re-run that cannot be recorded runs nothing";
  - "with no back-off in force it is an ordinary batch — nothing is recorded — and it stays a controller's action".
- review fix pass 5:
  - "a failed vision-retry batch: Resume's retryNow performs the retry, audited first — never recorded and then refused" (the reviewer's probe R1);
  - "a vision retry's own back-off is not a failed batch's: retryNow records nothing and answers 409 with the vision reason".
- review fix pass 6:
  - "a controller with no usable key re-running a failed vision-retry batch: 409 with the reason, nothing recorded, and the failure's record stays on the row" (probe K1: no AI connection, then a key at its monthly cap);
  - "a re-run that meets `busy` is not recorded while it waits: only the batch that takes the claim records it, then runs".

Each was mutation-checked. Removing any of these makes its test fail:
- the retry, the back-off check, the permanent flag;
- the did-work rule at the commit, the count kept by a park that read nothing, the keyless park's skip;
- the message condition on the back-off, `retryNow` in the engine and in the route, the route's audit refusal;
- (review fix pass 5) the keyless skip's age limit, the vision-retry gate's `retryNow` exception, the attempt match in `failureBackoffUntil`, and fitting the cause in the failure, at-bound and vision-retry messages;
- (review fix pass 6) the keyless re-run's refusal (it parked again), the record moved back to the claim (before the gates), the route's old pre-call audit, the drain's `fileBehind` on a skipped row, its guard on a back-off in force, and the surrogate-safe cut in the permanent, legacy and refusal messages.

**Done-when.**
- ✓ Only a missing table (42P01 / "does not exist" / PostgREST's PGRST205) skips the tag layer. A timeout bisects and retries like `insertChunks`. A persistent failure throws, so the batch is never committed as complete. The batch is then retried automatically on the next indexing pass after a back-off, until the third failure in a row, and the document keeps its status meanwhile, so an `indexing` document stays retrievable. Only then does it become `error`, for a person. Pass 2 left the retry to a person; pass 3 made it automatic. Review fix pass 4 made "in a row" hold. Before it, a batch that did nothing, or a keyless park, cleared the count, so a persistent failure could be retried and re-billed without end. Review fix pass 5 made the nightly half hold again: fix pass 4's keyless skip froze parked documents' stamps, so with twenty or more of them anywhere a lapsed failure was never selected by the drain (probe P2). Review fix pass 6 closed the other rows that held the head unmoved: those in a "read every page" library with no sponsored key, which every mirror there is (probe D1). Every row the drain meets but cannot work on now moves behind what lapsed before it. "On the next run" was overstated, too. The nightly half holds within a stated bound: a lapsed failure comes up on run ⌊N / 20⌋ + 1 after it lapsed, for N queued rows across all orgs stamped before it lapsed, later if never-stamped work comes first or a run's budget or time ends early (probe D2). Within minutes while a controller in its org has the app open.
- ✓ A batch that could not write its entities does not advance `pages_indexed`: the throw comes before the commit.

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql` (`ingest_failures`). Without it a failed batch is `error` at once, needing a person, because there is nowhere to count attempts. The ladder itself needs no migration. A failure that recurs with no work in between costs at most three batches' worth of vision pages before a person decides. Without an open controller tab, those three attempts take about two days at best (the cron is nightly), and longer behind a deep queue: each attempt waits out the bound stated above (review fix pass 6). On a database without `20261122` the drain has no stamp to move, so a row it skips keeps its upload-order place, as at the base; a failure there is `error` at once and out of the queue. A failed batch's range clear has already run, so the pages it was rewriting hold neither old nor new rows until a retry commits. In the main pass those pages lie past `pages_indexed`. In a vision-retry batch they are the failed pages, whose text layer held little or nothing. At the bound the document is `error` and out of Ask until someone re-runs it: an accepted risk (DEC-58 item 3), see above.

**The app-shell indicator** (`components/providers/KnowledgeIndexIndicator.tsx`, owner named I-02). Corrected in review fix pass 4. This record said the indicator "finds the back-off and does nothing, which costs nothing". That is not what the unedited indicator does. Every two minutes, in every controller tab, for each document in a back-off or parked for vision:
- it calls `setHidden(false)`, so a card the user dismissed comes back;
- it POSTs `/api/knowledge/ingest`, which answers 409. That costs about eight queries: auth, member, library, AI connection, usage, cap and instructions, plus the claim and its release;
- for a controller without a key, on a document parked for vision, the engine's park rewrote the row on every poll, and that write was one of the resets above.

Now the keyless park skips its UPDATE when the row already carries the same message and a stamp that has passed, so only the claim and its release touch the row (test above). Since review fix pass 5 the skip also needs the stamp to be under half an hour old. An older one is written again, at most once per half hour per document, so the cron's queue keeps rotating (ING-6). The card re-show and the per-poll query cost remain. They are in the I-02 handoff under ING-6: leave out rows with `vision_retry_after` in the future or `error` non-null, and re-show the card only when a batch made progress. For a document parked for vision this goes on until someone accepts the partial index, which has no button yet. The integrator may gate the merge on that filter.

**The drawing rebuild** (`app/api/knowledge/drawing/route.ts`, I-07's file). It resets `status`, `pages_indexed`, `page_count` and `error`, but not `ingest_failures` or `vision_retry_after`.
- A failure back-off no longer outlives it. The back-off holds only while the row carries the failure's message (`failureBackoffUntil`), and the rebuild nulls that message (probe B, now a test). Before, a rebuilt document in a back-off answered `failureRetryBlocked`, with a generic message, for up to 30 minutes.
- The count does outlive it. A rebuilt document that had failed twice goes to `error` on its first failure, and one at the bound reads "failed 4 times in a row".

**Handoff to I-07** (also under ING-12 and in DEC-58): the rebuild must zero `ingest_failures` and `vision_retry_after`. `resetKnowledgeIndex` already does; moving the rebuild onto it closes this.

**Pending build (DEC-29 item 4).** On this branch, `npx tsc --noEmit`, `npx eslint --max-warnings=0` on every changed file, and the full `npx vitest run` pass. `next build` was not run: the fleet's standing rule leaves it to the integrator, who runs it before merging and records it in the round section. This status stands on that build. If the build fails, the finding returns to OPEN.


**Integration (2026-10-01, at the I-06 merge).** The final review's four minors, handled at merge. (1) The re-run record: `ingestKnowledgeDocBatch` now treats any `onRetryNow` answer other than `null` — an empty string included — as a refusal ("the record failed"), so a record that returns `''` no longer lets an unrecorded re-run through; the route always passes `onRetryNow`, and a caller that omits it (the engine's own tests) runs the re-run unrecorded — the comment at the call now says exactly that. Test: `lib/__tests__/ingestLock.test.ts` "a re-run is recorded only when it is performed …" gains the empty-answer case. (2) The failure message no longer promises the nightly run for documents the drain never works on: it reads "or the nightly maintenance run where the library can be indexed unattended" (`NEXT_INDEXING_PASS`); the long-cause test is rebalanced for the longer copy (same surrogate-pair cut). (3) `DEC-58`'s acceptance line carried the drain bound one run early; it now states run ⌊N / 20⌋ + 1, as this record and probe D2 do. (4) **Residual, not fixed:** no test exercises `fileBehind`'s guards in the drain (`lib/knowledgeIngest.ts` — the compare-and-set on `file_key` and the stamp as read, the claim-free `.or()` filter, the legacy `hasStamp` early return). The code is as the review read it; a test that drives the drain over a claimed row and a pre-20261122 row is owed — carried here, with `ING-6`'s owner. The integrator's `next build` gate that the "Pending build" lines in this report wait on is run at this merge, before the push.

**Handoff landed (2026-10-01, intelligence Round G, I-07).** The drawing rebuild now calls `resetKnowledgeIndex`, so it zeroes `ingest_failures` and `vision_retry_after` and takes the document's claim (see ING-12's Resolution; test "zeroes every counter under the claim …" in `lib/__tests__/intelRoundGDrawingRoutes.test.ts`). The residual named above is closed. A rebuilt document starts its failure count at zero.

---

<a id="ing-9"></a>

## ING-9 · Non-PDF rejection for direct uploads is client-side only; the server accepts any bytes and reports the unpdf failure as a generic indexing error

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/knowledge/[id]/page.tsx:1519-1521`, `app/(protected)/knowledge/[id]/page.tsx:1866`, `lib/knowledge.ts:356-361`, `app/api/knowledge/ingest/route.ts:39-134`, `lib/knowledgeIngest.ts:105-107`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The absence claim holds — no server-side format validation exists on any leg of the path. Lowered to LOW: the outcome is a clean terminal state (route.ts:181-183 writes status 'error' with the unpdf message prefixed 'Indexing failed:'), the action is Admin/DocCtrl-only, and nothing is corrupted — the cost is one orphaned R2 object and an unhelpful error string, not data loss or a security boundary.

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

**Resolution (2026-09-30, intelligence Round G).** Confirmed first by reading, as the finding did: nothing on the server looked at the bytes before `getDocumentProxy`. What landed is in the engine, so it covers BOTH drivers that can meet the file first: the interactive route, and the cron drain for an upload whose tab closed before its first POST. On a document's first batch (`pages_indexed = 0`), `ingestKnowledgeDocBatch` reads the first KB of the stored object under the claim with a ranged GET (`sniffStoredFile`). It classifies the bytes with `sniffBytes`. The classes are `%PDF-` in the first 1,024 bytes; the ZIP container of .xlsx/.docx or the OLE container of .xls/.doc; PNG/JPEG/TIFF; text; unknown.

- **Another format's signature** (office, image) returns `notPdf` before the file is downloaded or pdf.js sees it.
- **No header in the first KB is not proof** (review fix pass 2). pdf.js opens a PDF whose header comes later: a scanner's or a mail gateway's preamble, which it tolerates. This was verified here: a PDF behind a 2,460-byte preamble opens and reads. Before, such a file, which had indexed, would have been classed `text` and deleted. Now a `text` or `unknown` head goes on to pdf.js. It is refused, with the same message, only if pdf.js cannot open it either. A damaged file that does carry the header is an indexing failure, not a refusal, and nothing is deleted. It is marked `error` at once (502), without the automatic retries a transient failure gets (ING-8, review fix pass 3), because no retry can mend it.

The caller then applies the one refusal, `refuseNonPdf` (`lib/knowledgeIngest.ts`). The route calls it with the controller's id and the drain with none. When the file is not a PDF:

- **An upload** is a row with no source whose key is under `orgs/<org>/knowledge/`. `KNOWLEDGE_DOC_REJECTED` is audited FIRST, as a checked write naming the file (review fix pass 2). A refusal that cannot be recorded deletes nothing, and the upload is kept. Then its row is deleted, then its R2 object, and the answer is 415 with a plain message (`notPdfMessage`), for example: *Only PDF files can be indexed — "equipment-list.pdf" is not a PDF (it looks like an Excel or Word file). To load an equipment list, open Operating areas and use Import CSV — it takes .xlsx, .xls and .csv.* The importer (`components/assets/AssetCsvImportModal.tsx`) now takes spreadsheets.
- **A mirrored controlled file** is marked `error` with the same message. Its object is never deleted, because it belongs to doc control.
- Both writes compare against the file the check looked at (ING-1). A row re-pointed at a new revision since is not refused.

Tests: `lib/__tests__/ingestRoute.test.ts` ING-9 block:
- "classifies by leading bytes";
- "a renamed spreadsheet upload is refused with the importer named, and leaves nothing behind";
- "a mirrored controlled file is marked with the message, never deleted";
- "a real PDF passes the sniff and indexes";
- "a PDF behind a long preamble (no header in its first KB) is still a PDF: pdf.js opens it, and it indexes";
- "a CSV renamed .pdf (no header, and pdf.js cannot open it) is refused once pdf.js has tried — nothing left behind";
- "a damaged file that does carry the PDF header is an indexing failure, not a refusal";
- "a refusal that cannot be audited deletes nothing".

Also `lib/__tests__/ingestLock.test.ts`: "ING-9 — the cron drain refuses a non-PDF exactly as the route does" (the upload's row and object removed and audited with no user, the importer named; a mirror marked, never deleted; a mirror re-pointed after its file was checked is not refused).

**Done-when.**
- ✓ The leading bytes are checked before the file is downloaded or parsed, and the answer is "Only PDF files can be indexed…" in plain language. There is one divergence from the criterion's wording, because the code wins. A missing `%PDF` in the first KB is not treated as proof of a non-PDF, since pdf.js tolerates a late header. Such a file is refused only once pdf.js has also failed to open it. A positive non-PDF signature is refused before any download.
- ✓ A non-PDF upload leaves neither an R2 object nor an errored row behind, whichever driver meets it first: the route or the cron drain. A mirror's object is doc control's and is not an upload.
- ✓ The error for a spreadsheet names the right destination (Operating areas → Import CSV) instead of a pdf.js internal message.

**Scope / residual.** No migration. The browser-side `.pdf` check on the knowledge page is unchanged; that file is I-02's.

**Pending build (DEC-29 item 4).** On this branch, `npx tsc --noEmit`, `npx eslint --max-warnings=0` on every changed file, and the full `npx vitest run` pass. `next build` was not run: the fleet's standing rule leaves it to the integrator, who runs it before merging and records it in the round section. This status stands on that build. If the build fails, the finding returns to OPEN.

---

<a id="ing-10"></a>

## ING-10 · The 'TRUST these for counts and totals' drawing-facts slab is a hard 20,000-row cap with no overflow detection

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:945-956`, `app/api/knowledge/ask/route.ts:1055-1068`, `lib/orchestrator/tools.ts:371-376`, `lib/knowledgeEntityKinds.ts:11-20`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified: repo-wide grep for 20000/20_000 shows the only truncation flag in this path is `truncated: byTag.size > MAX_ROWS` (MAX_ROWS=400), which is about the clickable table, not the 20k row cap; the drawingFacts prose has no equivalent. app/api/knowledge/drawing/route.ts:184 and 281 share the same pattern. The claim of absence holds.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ingest/route.ts:11-12`, `lib/knowledgeIngest.ts:55-56`, `lib/knowledgeIngest.ts:111`, `lib/knowledgeIngest.ts:329`, `lib/knowledgeIngest.ts:470`, `lib/knowledge.ts:428-445`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed: no consumer, and `let emptyPages = 0` at line 111 is inside ingestKnowledgeDocBatch so the number is per-batch, never accumulated on the document row. The one UI string that resembles the promise — app/(protected)/knowledge/[id]/page.tsx:1894 "page(s) had no text layer — read by AI vision" — is gated on `visionPages > 0`, so in the no-AI-key scenario it renders nothing.

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

**Resolution (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) against the pre-fix engine: a batch with a textless page returned `emptyPages: 1`, and the row kept nothing. What landed:

- **The count is kept on the row.** `knowledge_documents.empty_pages` (migration `20261122`) accumulates at every committed batch, inside the same compare-and-set commit as the other counters.
- **It follows retries.** A vision retry that finds text on a formerly empty page takes it back out of the count, and the reverse.
- **It resets with the index.** `resetKnowledgeIndex` zeroes it, and every batch that starts at page 0 restarts it, whatever reset path put the row there.
- **The response carries the total.** Every ingest response carries the running `emptyPagesTotal`. The route header now says what the route actually does: the count lives on the row and rides every response. It no longer promises UI copy nobody renders.

Tests: `lib/__tests__/ingestLock.test.ts` ("empty pages accumulate across batches on the row", "ING-12: a re-index restarts every counter at page 0…", "records the page, holds 'ready', retries it…"), and `lib/__tests__/ingestRoute.test.ts` ("a real PDF passes the sniff and indexes" — `emptyPagesTotal`).

**Done-when.**
- ✓ `emptyPages` is accumulated onto the `knowledge_documents` row, like `vision_pages`, and reset by the same reset paths.
- ✓ The criterion's second branch holds: the route header's promise is replaced by what is true (the row column plus `emptyPagesTotal` on every response).

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql`. Documents indexed before it report 0 until their next re-index. Rendering "N of M pages had no extractable text" on the library's document list is `app/(protected)/knowledge/[id]/page.tsx`, I-02's file; the column is on every row that page already selects.

**Pending build (DEC-29 item 4).** On this branch, `npx tsc --noEmit`, `npx eslint --max-warnings=0` on every changed file, and the full `npx vitest run` pass. `next build` was not run: the fleet's standing rule leaves it to the integrator, who runs it before merging and records it in the round section. This status stands on that build. If the build fails, the finding returns to OPEN.

---

<a id="ing-12"></a>

## ING-12 · vision_pages is monotonic forever — rebuild and rev-up reset every other counter but not this one, so the per-sheet 'read by AI vision' verdict is永 sticky and the count inflates

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeIngest.ts:458-467`, `app/api/knowledge/drawing/route.ts:371`, `lib/knowledgeSourceSync.ts:248-260`, `app/api/knowledge/drawing/route.ts:290-297`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide grep: `pages_indexed: 0` appears in exactly those two reset sites and neither touches vision_pages; no other code path writes the column. A rebuild that produces zero tags and zero chars still reports verdict 'vision' once status returns to 'ready'.

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

**Partial (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) against the pre-fix sync: after a rev-up refresh the mirror still read `vision_pages: 3`. What landed:

- **The reset zeroes it.** `resetKnowledgeIndex` (`lib/knowledgeIngest.ts`) sets `vision_pages: 0` along with `empty_pages`, the vision retry queue and a partial acceptance. The sync refresh uses it.
- **A new generation starts from zero.** `ingestKnowledgeDocBatch` treats a batch that starts at page 0 as the start of a new index generation and restarts every counter there. That covers the drawing rebuild's current block in `app/api/knowledge/drawing/route.ts` (I-07's file), which resets the row without touching `vision_pages`: the rebuild's first re-read batch zeroes it. On a database without `20261122`, the legacy path does the same.
- **The count rides the commit.** Under the claim, `vision_pages` is written in the compare-and-set commit, not in a separate read-modify-write.

Tests: `lib/__tests__/sourceSync.test.ts` ("chunks, page entities, machine mentions and cached traces go…" asserts `vision_pages: 0`, "the shared reset without a file change…"), and `lib/__tests__/ingestLock.test.ts` ("ING-12: a re-index restarts every counter at page 0 — even after the drawing rebuild's own reset, which does not zero them", which uses the exact fields that route writes today).

**Done-when.**
- Half done. ✓ The sourceSync refresh writes `vision_pages: 0`. ✗ The drawing rebuild's reset (`app/api/knowledge/drawing/route.ts`, I-07's file) still does not write it. Its count is zeroed only when the re-read's first batch commits. The rebuild writes the zero itself once I-07 moves it onto `resetKnowledgeIndex`.
- ✓ The counter is scoped to the current index generation. A rebuild with no key that reads nothing ends at `vision_pages: 0`, so the per-sheet verdict can no longer report the previous run's "vision".

**Scope / residual.** No migration is needed: `vision_pages` exists since `20260922`. Values already inflated in the database stay until each document's next re-index; the `20261122` inventory counts documents whose `vision_pages` exceeds their page count. The same handoff to I-07 covers the two columns `20261122` adds for ING-8. The rebuild must also zero `ingest_failures` and `vision_retry_after`, which `resetKnowledgeIndex` does. Until then a rebuilt document keeps its failure count: one that had failed twice goes to `error` on its first failure, and one at the bound reads "failed 4 times in a row". A failure back-off no longer outlives the rebuild, because the rebuild nulls `error` and the back-off holds only while the row carries the failure's message (see ING-8). OPEN until I-07's rebuild calls `resetKnowledgeIndex`.

**Resolution (2026-10-01, intelligence Round G, I-07).** The missing half landed. The drawing rebuild (`app/api/knowledge/drawing/route.ts`, POST `action: "rebuild"`) no longer resets rows itself. It calls `resetKnowledgeIndex` per document, under that document's ingest claim, so the row is written with `RESET_ROW`'s zeros: `vision_pages: 0`, empty pages, the vision retry queue, `ingest_failures` and `vision_retry_after` (ING-8). Then chunks, page entities and machine mentions go, each checked.
- **Busy documents.** A document another driver is indexing is left alone and reported (`busy`).
- **Large libraries.** A large library is reset in id order within a time budget and continued by cursor, so no document is reset (and re-billed) twice. The Drawing intelligence panel follows the cursor. The library page's "Re-index all" did not (review fix pass below). Since I-07's second review fix pass the route keeps that caller's place, so each press continues where the last stopped.
- **Failures.** Failures are reported, never a silent success — by the panel, and by the route to a caller that cannot show them (review fix pass below).

Test: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "zeroes every counter under the claim, clears chunks and entities, and leaves a document another driver holds alone", with `vision_pages` 7 → 0, `ingest_failures` 2 → 0 and `vision_retry_after` → null. It also covers "a continuation cursor never resets the same document twice". It fails against the base route.

**Done-when.**
- ✓ Both reset paths (drawing rebuild, sourceSync refresh) set `vision_pages: 0`. Both are `resetKnowledgeIndex`.
- ✓ The counter is scoped to the current index generation (I-06, above).

**Scope / residual.** Values already inflated stay until each document's next re-index (I-06's note above).

**Review fix pass (2026-10-01, intelligence Round G, I-07).** The resolution above claimed the cursor and the failure reporting for every caller, and the implementer's note called `rebuildDrawingIndex` (`lib/knowledge.ts`) unused. It is not: the library page's general "Re-index all" button (`app/(protected)/knowledge/[id]/page.tsx`) calls it without a cursor, ignores `remaining`, `busy` and `errors`, and toasts "N document(s) queued" — on a library past what one call can reset, or with documents an indexer holds, a partial reset read as complete. Both files are I-02's (the knowledge UI), so they were not edited here.
- **Handed to I-02.** `rebuildDrawingIndex` must loop on `cursor` until `remaining` is 0, and surface `busy` and `errors`, as `rebuildAll` in `components/knowledge/DrawingIntelPanel.tsx` does; its return type gains those fields.
- **Until then, the route refuses to be read as done.** `POST /api/knowledge/drawing { action: "rebuild" }` from a caller that sends no `cursor` key at all (the panel always sends one, `null` on its first call) answers 409 with `partial: true` and a message `apiPost` throws as the error toast — "Re-index is not complete: N of M document(s) were queued; K were being indexed right then and were left alone (…); R were not reached in time …" — whenever documents were left unreached, busy, or failed. A complete reset still answers 200.
- **A spent budget no longer crashes.** When the document listing alone outlasted the budget, `all[next - 1]` read `undefined` and the call answered 500; it now returns the cursor it was given.
- **The panel's own ceiling is said.** Its follow loop stops after 50 calls; any documents still `remaining` are now shown ("press Rebuild index again to continue").

Tests: `lib/__tests__/intelRoundGDrawingRoutes.test.ts` "a caller that sends no cursor (the library page's Re-index all) can never read a partial reset as done (fix pass)" and "a budget spent before the first reset answers the cursor it was given, not a crash (fix pass)"; both fail against the round's first commit. The existing rebuild test now sends the panel's shape (`cursor: null`).


**Review fix pass 2 (2026-10-01, intelligence Round G, I-07).** The first fix pass made a cursorless call answer 409 when documents were left unreached. It did not make such a call progress. Every press of the library page's "Re-index all" sent no cursor and restarted at the first document. A library larger than one 40-second budget could never finish: each press re-reset, and re-billed, the same head documents. The 409 pointed to the Drawing intelligence panel, but that panel renders only for libraries marked as drawing sets (`aiFeatures.drawingIntel`). A large prose or standards library therefore had no complete re-index path until I-02 lands.
- **The route keeps the place.** `rebuild()` in `app/api/knowledge/drawing/route.ts` reads `knowledge_libraries.ai_features.rebuildCursor` for a call that sends no `cursor` key. That is `{ cursor, at }`, written by that caller's last partial call. If it is younger than `REBUILD_RESUME_WINDOW_MS` (6 hours), the call resumes after it. The call writes the new place while documents remain, and clears it once a press takes the last document. The response carries `resumedFrom`. The 409 now says "Press the button again (within 6 hours) to continue from where this call stopped; no document is reset twice". If the place cannot be saved, it says the next press starts from the first document.
- **What the mark touches.** The library row is read again right before the write, and only that key changes. A Library AI setup saved meanwhile is kept, apart from a one-round-trip race. `LibraryAiModal` writes a fresh features object, so a save can only erase the mark; it can never restore a stale one. An erased mark restarts at the head, which costs extra resets and never skips a document. A mark older than the window is ignored. Calls that send a cursor key (the panel) neither read nor write the mark.
- **The panel keeps what earlier rounds did.** `rebuildAll` in `components/knowledge/DrawingIntelPanel.tsx` threw on any failed round, losing the totals of the rounds that had already queued documents. Now it returns those totals with the error. The toast says "The rebuild stopped part-way (…) — N document(s) already queued are re-indexing", and the page refreshes whenever anything was queued.
- **Hand-off to I-06.** `lib/knowledgeIngest.ts` (I-06's file) still says, at the header and at `RESET_ROW` / `resetKnowledgeIndex`, that the drawing rebuild "today resets without the claim". That has been false since this package moved the rebuild onto `resetKnowledgeIndex`. I-06 should drop those two sentences. The file was not edited here.

I-02's loop in `rebuildDrawingIndex` (above) is still the better shape: one press, the whole library, with `busy` and errors shown. Until it lands, presses complete the re-index.

Tests:
- `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "ING-12 — the library page's Re-index all continues where it stopped":
  - eight documents, one round of six per press: the second press resets only the last two and clears the place, and the library's decoder is kept;
  - a place older than the window is ignored;
  - the panel's calls never read or write the place.
- `lib/__tests__/drawingIntelPanelRebuild.test.ts` (rendered): a failed second round and a network failure each keep the first round's six documents in the toast and refresh the page; a failed first round with nothing queued is only the error.

Each behavioural case fails against the first fix pass.

**Review fix pass 3 (2026-10-01, intelligence Round G, I-07).** Two gaps remain on the library page, and its files are I-02's (`app/(protected)/knowledge/[id]/page.tsx`, `lib/knowledge.ts`).
- **The reset documents disappear until a poll.** A cursorless press that resets documents and then answers 409 (`partial: true`) has already deleted their chunks. The page throws on the 409 and calls `refresh()` only on success. Its auto-indexer is keyed on its `docs` state, so it does not see the queued documents. They stay listed as ready with no chunks until the app-shell indicator's two-minute poll or a reload, and Ask over them returns nothing meanwhile.
  - **Handed to I-02:** every caller of `rebuildDrawingIndex` must `refresh()` whenever the response carries `partial` (or `docs > 0`), on the error path too. The single-press cursor loop, owed since the first fix pass, would close this as well.
- **A resumed press said nothing.** A press that continued from the kept place answered 200 with only this press's count ("2 document(s) queued"). It did not say that it continued, or that the documents earlier presses queued were not reset again, so a Library AI setting saved between presses never reached them a second time.
  - `rebuild()` now adds a `notice` to such a press: "Continued from where the last press stopped: N document(s) queued by this press; the documents earlier presses queued were not reset again." When nothing was left, it says "earlier presses had already queued every document". A press that starts from the first document carries no notice.
  - A Library AI save through `LibraryAiModal` erases the mark (above), so the next press after such a save starts again from the first document.
  - **Handed to I-02:** the page shows `notice` in its toast.

Test: `lib/__tests__/intelRoundGDrawingRoutes.test.ts`, block "ING-12 — the library page's Re-index all continues where it stopped". The resumed press carries the notice; a press from the top carries none. It fails against fix pass 2 (`4e549d0`).
---
