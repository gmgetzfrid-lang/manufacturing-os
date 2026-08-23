# 03 · Embeddings & the semantic layer

**13 findings** — 3 HIGH · 10 MEDIUM.

Coverage, drift, and what happens to a chunk that never embeds.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Positional integrity of the embedding response is enforced hard — count mismatch, out-of-range index, non-array embedding, and wrong dimension each throw rather than storing a vector against the wrong passage | `lib/ai/embeddings.ts:172-194` | This is the one failure in the whole layer that would be permanent and undetectable. The check is correct and its rationale is written down at lines 126-131. Do not weaken it while fixing anything else here. |
| Resumability by construction: `embedding IS NULL` is the queue, every committed batch is permanent, and both drivers share one time-bounded slice function that never throws | `lib/knowledgeEmbedCore.ts:36-125` | This is why a 60-second platform kill cannot corrupt a build. Any claim/lock added for the concurrency finding must preserve the property that an abandoned invocation loses nothing. |
| Fusion by rank (RRF), never by score — a ts_rank and a cosine similarity are never arithmetically mixed | `lib/hybridRank.ts, supabase/migrations/20260930_semantic_layer.sql:15-19, app/api/knowledge/ask/route.ts:510-548` | Correct and unit-tested (lib/__tests__/hybridRank.test.ts). It also means the system already degrades sanely when one retriever returns nothing — `if (meaning.length === 0) return diversify(keyword)` at ask/route.ts:543. |
| Both RPCs are SECURITY INVOKER with `REVOKE ALL … FROM public, anon` and EXECUTE granted only to authenticated | `supabase/migrations/20260930_semantic_layer.sql:96-98, 119-120, 139-140; 20261007_rag_hardening.sql:100-103` | The semantic layer does not bypass RLS. The migration states the reason explicitly at 20260930:73-75. Preserve this if the functions are rewritten for ef_search or per-library model resolution. |
| Coverage was made fast and then given statement-timeout headroom — two partial/composite indexes plus `SET statement_timeout = '25s'` | `supabase/migrations/20261011_semantic_coverage_fast.sql:17-22, 20261014_coverage_timeout_headroom.sql:14-26` | Coverage polling during an active build is exactly when it is most likely to time out, and that was diagnosed and fixed properly. Any change to the coverage query must keep both index shapes usable. |
| The reset path exists, is correctly reasoned, and is the only correct way to invalidate vectors after a chunking or model change | `app/api/knowledge/embed/route.ts:97-126` | The mixed-model findings above are gaps in DETECTION and WARNING, not in the remedy — the remedy is already built and controller-gated. The fix is to route users to it, not to build a new one. |
| SemanticIndexPanel never renders nothing, states partial coverage in plain language, and explains the zero-passages case (SHX/scan libraries) with the exact next step | `components/knowledge/SemanticIndexPanel.tsx:132-168, 257-265` | This is the honest surface the rest of the system should be wired into. The `retrieval` dead-signal fix should reuse this copy rather than invent new wording. |
| The two-cron limit is enforced by a test, and the drain deliberately rides the daily maintenance cron because a third vercel.json cron entry broke every deployment | `vercel.json, lib/knowledgeEmbedDrain.ts:10-15, app/api/cron/maintenance/route.ts:287-291, lib/__tests__/vercelConfig.test.ts` | The starvation finding must NOT be fixed by adding a cron. Increase the daily budget, rotate the `.limit(6)` window, or lean harder on the nudge — the deployment constraint is real and documented twice. |
| The embeddings key is correctly modelled as separate from the chat key, one-directionally, with tests naming the exact regression | `lib/ai/embeddings.ts:238-258, lib/__tests__/embeddings.test.ts:32-60` | A Claude user with a Voyage key works, and an Anthropic chat key is never mistaken for an embeddings key. The provider-switch finding is about the CORPUS's provider not being recorded — this connection logic itself is sound. |


---


<a id="sem-1"></a>

## SEM-1 · A library embedded under two models silently loses half its corpus, and which half is nondeterministic

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:463-468`, `app/api/knowledge/ask/route.ts:482-489`, `lib/knowledgeEmbedCore.ts:56-60`, `lib/knowledgeEmbedCore.ts:113-115`, `components/knowledge/AiSettingsModal.tsx:284-311`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Mechanically correct: a mixed-stamp library is filtered to one stamp per ask and which stamp wins is unordered, so it can differ between asks. Lowered to MEDIUM because it needs an admin to change the saved embedding model mid-build, keyword retrieval is unaffected (the fuse at :512+ still runs), and both the reset comment (embed/route.ts:97-107) and the Rebuild dialog (SemanticIndexPanel.tsx:113-116, 'Do it after ingestion or the embedding model changes') name the exact remedy.

**Mechanism.** `embedLibrarySlice` selects work with `.is("embedding", null)` (knowledgeEmbedCore.ts:59) and stamps each row with `embedding_model: connection.model` (line 114). Nothing invalidates existing vectors when the connection's model changes — `AiSettingsModal.save()` (line 284-311) writes the new model with no warning and no reset. So changing voyage-3.5-lite → voyage-3.5 and pressing Build again leaves the library holding two disjoint vector sets under two model stamps. At ask time the route picks the corpus model from ONE arbitrary row: `.from("knowledge_chunks").select("embedding_model").eq(...).not("embedding","is",null).not("embedding_model","is",null).limit(1).maybeSingle()` (ask/route.ts:463-467) — `.limit(1)` with NO `.order()`. That single value becomes `p_model` for every `semantic_search` call (line 488), and the RPC filters `AND (p_model IS NULL OR c.embedding_model = p_model)` (20261007_rag_hardening.sql:95). Whichever model that unordered row happened to carry wins; every vector under the other stamp is filtered out of retrieval. Postgres may return a different row after a vacuum, an update, or a plan change, so the same question can silently search different halves of the library on different days. Nothing anywhere computes `SELECT DISTINCT embedding_model` or reports that a library is mixed — confirmed by grepping `embedding_model`/`embeddingModel` repo-wide (18 sites, none of them a distinct/group-by).

**Failure scenario.** An admin sets up with voyage-3.5-lite, builds 60% of a 20,000-passage library, then upgrades the saved model to voyage-3.5 and presses Build to finish. The remaining 8,000 chunks embed under the new stamp. An engineer asks 'what holds the pump down'. `.limit(1)` returns a voyage-3.5-lite row, so `p_model='voyage-3.5-lite'` and the 8,000 newest passages — including the anchor-bolt standard that was just ingested — are excluded from every nearest-neighbour list. The panel reads 100% coverage. The answer cites nothing from those documents and gives no indication anything was withheld.

**Evidence.**

```
app/api/knowledge/ask/route.ts:463-468 — `const { data: stamped } = await supabaseAdmin.from("knowledge_chunks").select("embedding_model")… .limit(1).maybeSingle(); const corpusModel = (stamped?.embedding_model as string | null) ?? embedding.model;`. The migration itself names the hazard it does not prevent: '20260930_semantic_layer.sql:52 — "Which model produced it. Without this, a re-embed can't tell what's stale, and mixed-model vectors in one index return quietly wrong neighbours."' The column exists; nothing reads it to detect the mixture.
```

> **Verifier correction.** Two overstatements. (a) A partial mitigation exists and the finding omits it: components/knowledge/SemanticIndexPanel.tsx:203-206 renders a Rebuild control whose confirm text (lines 113-116) explicitly says 'Do it after ingestion or the embedding model changes, so older documents are indexed the same way as new ones', and app/api/knowledge/embed/route.ts:104-118 implements the reset. It is guidance, not enforcement — nothing blocks the model change or detects the mixture — so the finding stands, but 'no warning' is only true of the settings modal, not of the product. (b) 'the same question can silently search different halves on different days' is inference about Postgres row-return order, which cannot be observed from the repo; the CONFIRMED part is that ONE arbitrary unordered row decides the whole corpus filter.

**Done when.**

- [ ] Coverage reporting distinguishes vectors by `embedding_model` and the panel says out loud when a library holds more than one
- [ ] Saving a different embedding model or provider warns that existing vectors become unusable and offers the reset
- [ ] Either `p_model` selection is deterministic (majority stamp, or the library's recorded build model) or a mixed library refuses semantic search until rebuilt
- [ ] A test builds a two-stamp library and asserts retrieval does not silently drop one stamp

---

<a id="sem-2"></a>

## SEM-2 · Embedding spend is invisible to the monthly cap — every cap check in the embed path reads a number that excludes embeddings

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/ai/usageServer.ts:57-67`, `lib/ai/usageServer.ts:106-127`, `app/api/knowledge/embed/route.ts:139-149`, `app/api/knowledge/embed/route.ts:178-183`, `lib/knowledgeEmbedDrain.ts:88-95`, `lib/knowledgeEmbedDrain.ts:123-128`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right, and understated: the same op filter also hides flowRead, drawingLocate and knowledgeVision, and getMonthUsageByUser:70-76 carries it too, so the controllers' team view never shows this spend either — directly contradicting the comment at usageServer.ts:109-111 ('bills as knowledgeVision so the spend is visible as its own line but shares the same cap'). No DB view or trigger aggregates ai_usage_events; these helpers are the whole ledger.

**Mechanism.** `recordAskUsage` writes the metering row with `op: input.op ?? "knowledgeAsk"` (usageServer.ts:114). The embed route and the drain both pass `op: "knowledgeEmbed"`. But `getMonthUsage` — the ONLY function that computes month-to-date spend — filters `.eq("op", "knowledgeAsk")` (usageServer.ts:63). So embedding rows are written and then never read by the cap. Both cap gates in the embed path (`if (capUsd > 0 && monthSoFar.spentUsd >= capUsd)` at embed/route.ts:143, and the identical check at knowledgeEmbedDrain.ts:92) therefore compare the embedding job against a total that contains zero embedding spend. The same hole swallows five other ops that are all written and none of which are counted: `knowledgeVision` (lib/knowledgeIngest.ts:590, app/api/knowledge/ingest/route.ts:140), `orchestrator` (app/api/orchestrator/route.ts:148), `graphShape` (app/api/graph/shape/route.ts:179), `drawingLocate` (app/api/knowledge/locate/route.ts:219), and everything routed through `lib/ai/governedCall.ts:87`. The code's own comment on the `op` parameter asserts the opposite: "vision indexing bills as knowledgeVision so the spend is visible as its own line but SHARES THE SAME CAP" (usageServer.ts:109-111). It does not share the cap. `getMonthUsageByUser` — the controllers' team view — carries the identical filter at usageServer.ts:75, so the admin surface is blind too.

**Failure scenario.** A DocCtrl user with a $10 cap presses Rebuild index on a 250,000-passage library. Each pass calls `getMonthUsage`, which returns only their chat-ask spend (say $0.40), so the gate at embed/route.ts:143 never trips. The drain then continues the same build on the daily maintenance cron and on every page-load nudge, re-checking the same blind number each time. The Voyage/OpenAI invoice arrives with hundreds of dollars of embedding charges the app's ledger page reports as $0.40 of AI spend. Nothing in the product ever stopped it, and nothing in the product can show it.

**Evidence.**

```
lib/ai/usageServer.ts:57-67 — `.from("ai_usage_events").select(...).eq("org_id", orgId).eq("user_id", userId).eq("op", "knowledgeAsk").gte("created_at", monthStartIso())` versus lib/knowledgeEmbedDrain.ts:123-127 — `await recordAskUsage({ orgId: lib.org_id, userId, provider: connection.provider, model: connection.model, usage, ok: true, op: "knowledgeEmbed" })`. Two differently-shaped searches (`grep -rn 'op: "'` over lib/ and app/api/, and `grep -rn 'knowledgeAsk'` repo-wide) return exactly three `knowledgeAsk` sites — two of them the filters above, one the default in the writer — and seven distinct non-ask op values being written.
```

> **Verifier correction.** The finding UNDERSTATES the scope: `grep -rn 'op: "'` over lib/ and app/ returns eleven distinct non-ask ops that are written and never counted, not five — add codebookImport (app/api/codebook/import/route.ts:118,158), qualityManualReview (app/api/companies/quality-manual/route.ts:74), checklistSegment/checklistAssess (app/api/projects/checklist/route.ts:83,164), flowRead (app/api/flows/read/route.ts:133) and templateDraft (app/api/templates/generate/route.ts:287,297) and skillAssist (app/api/links/skill-assist/route.ts:65,105) to the list. Severity corrected CRITICAL→HIGH only because the escaping spend lands on the member's own BYO provider key (the provider's own credit limit is the backstop) and nothing about safety, RLS, or document integrity is touched — this is a governance control that silently does not govern, not a data or platform-billing loss.

**Done when.**

- [ ] `getMonthUsage` and `getMonthUsageByUser` no longer filter on `op`, or filter on an explicit set that includes knowledgeEmbed, knowledgeVision, orchestrator, graphShape and drawingLocate
- [ ] A cap-exceeded state reached purely by embedding spend blocks the next `/api/knowledge/embed` build pass and the drain's per-library gate
- [ ] The admin spend view shows embedding and vision spend as their own lines inside the same monthly total
- [ ] A test asserts that a knowledgeEmbed usage row moves the number `getMonthUsage` returns

---

<a id="sem-3"></a>

## SEM-3 · Switching embedding provider makes semantic search return nothing, forever, silently — and the removal dialog promises the opposite

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:468-478`, `app/api/knowledge/ask/route.ts:505-507`, `lib/ai/embeddings.ts:102-104`, `lib/ai/embeddings.ts:205-215`, `components/knowledge/AiSettingsModal.tsx:331-338`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The core claim holds — after a provider switch, semantic search returns zero permanently with no error surfaced, and the dialog copy is true only for re-adding the SAME provider. One sub-claim in the summary is false: the mismatched call is rejected by the provider (404 → embeddings.ts:103) before any embedding is billed, so asks do not 'pay for a Voyage query embedding'. Lowered to MEDIUM: keyword retrieval is untouched and the existing Rebuild button (SemanticIndexPanel.tsx:203) fully repairs it once someone knows.

**Mechanism.** `corpusModel` is the model NAME read off the corpus, but the provider used to embed the query is `embedding.provider` — the user's CURRENT connection: `await embedQuery(embedding.provider, corpusModel, embedding.apiKey, t)` (ask/route.ts:477). The two are independent fields. If the corpus was embedded with OpenAI and the user later saves a Voyage key (or vice versa), the call becomes `embedQuery("voyage", "text-embedding-3-small", voyageKey, …)`. Voyage 404s; `friendly()` turns that into a precise, actionable `AiCallError` — "Voyage AI doesn't recognise that embedding model" (embeddings.ts:102-104) — and that message is then thrown away by `catch { return []; }` at ask/route.ts:505-507, whose comment reads 'degrade to keyword, never fail the ask'. Semantic retrieval is dead for that library on every subsequent question, with no error, no log surfaced to a user, and no change in the coverage bar (the vectors are all still there and still counted). The AiSettingsModal removal confirmation states the reverse as a promise: 'Vectors already built stay in place and start working again as soon as you add a key back' (AiSettingsModal.tsx:335-336). If the key added back is a different provider's, they do not start working again.

**Failure scenario.** A workspace starts on an OpenAI chat key (which `embeddingConnectionFrom` auto-reuses for embeddings, embeddings.ts:254-256) and builds a full index under text-embedding-3-small. They later move to Claude and, following the app's own guidance, add a Voyage key. Every ask now pays for a Voyage query embedding that 404s, catches to `[]`, and falls back to keyword-only. `semanticUsed` is false, so even the internal signal says keyword — but no UI reads it (see the dead-signal finding). The library shows 100% meaning coverage on the panel while meaning search has not run since the key change.

**Evidence.**

```
app/api/knowledge/ask/route.ts:475-478 — `for (const t of texts.slice(0, 3)) { literals.push(toVectorLiteral(await embedQuery(embedding.provider, corpusModel, embedding.apiKey, t))); }` — provider from the live connection, model from the corpus. Contrast lib/ai/embeddings.ts:205-207, whose own contract comment says: 'Must use the SAME provider and model as the corpus — a query embedded elsewhere finds neighbours in a space the documents don't live in, and returns confident nonsense rather than nothing.'
```

**Done when.**

- [ ] `ai_connections` or the library records the PROVIDER that built the corpus, and the query is embedded with that provider (or semantic search reports unavailable rather than empty)
- [ ] A provider change surfaces a blocking notice that the existing index is unusable until rebuilt
- [ ] The `catch` at ask/route.ts:505 distinguishes 'no embedding key' (normal) from 'the provider rejected the corpus model' (a reportable fault) and surfaces the latter on the answer
- [ ] The removal-confirmation copy stops promising vectors resume working with any key

---

<a id="sem-4"></a>

## SEM-4 · A single un-embeddable chunk stops the build permanently — no failure tracking, no ordering, no skip

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeEmbedCore.ts:55-60`, `lib/knowledgeEmbedCore.ts:98-106`, `lib/knowledgeEmbedCore.ts:110-121`, `lib/knowledge.ts:902-914`, `lib/knowledgeEmbedDrain.ts:113`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence: there is no attempts/failed column, no per-passage retry, no skip list, and no ORDER BY, so the next Build re-fetches the same unembedded rows under the same predicate and fails at the same point. Only the 429 path is treated as recoverable (:100), and only the client shrinks its batch, and only for rate limits.

**Mechanism.** The batch fetch has no ORDER BY and no offset: `.is("embedding", null).limit(batchSize)` (line 59-60). There is no per-chunk failure column anywhere on knowledge_chunks — the only columns ever added are `section` (20260914) and `tsv` (20261007), confirmed by grepping `ADD COLUMN` against knowledge_chunks across all migrations, and by grepping for `embed_error|embed_attempts|attempts`. When a batch throws anything that is neither a 429 nor a timeout, `lastError` is set and the loop `break`s (line 104-105). The next invocation — browser loop, page nudge, or cron — issues the identical unordered query and, absent concurrent writes, gets back the identical rows including the poison one. `buildSemanticIndex` stops on `last.error` (lib/knowledge.ts:903) and the drain stops on `slice.error` (line 113), so nothing spins, but nothing progresses either: the library is pinned at whatever coverage it reached, and the user sees only the provider's raw message with no indication that one passage is the blocker or which one. The same shape covers the write-back path: a single `r.error` on any of the eight parallel UPDATEs sets `lastError` and abandons the rest of the batch's already-purchased vectors (lines 116-118).

**Failure scenario.** One chunk comes out of a vision-read page as content the provider rejects with a 400 (a lone control character surviving `sanitize`, or a table row that exceeds a per-text token limit despite the 24,000-char clamp at embeddings.ts:62). The build stops at, say, 61%. The controller presses Build again; the same 64 rows are fetched, the same 400 comes back, the same generic 'Embedding failed.' (line 104) or provider text appears. There is no way from the UI to learn which passage, no way to skip it, and no way to finish the index. The library stays permanently partial — and per the dead-signal finding, every ask over it still reports hybrid.

**Evidence.**

```
lib/knowledgeEmbedCore.ts:98-105 — `catch (e) { if (e instanceof AiCallError && e.status === 429) { rateLimited = true; break; } const name = (e as { name?: string })?.name ?? ""; if (name === "TimeoutError" || name === "AbortError") break; lastError = e instanceof AiCallError ? e.message : "Embedding failed."; break; }` — three exits, no per-chunk state written in any of them.
```

**Done when.**

- [ ] A failure count / last-error column on knowledge_chunks lets the selector skip a chunk after N attempts
- [ ] On a non-429 batch failure, the batch is bisected or retried per-chunk so one bad passage cannot block the rest
- [ ] The build surfaces 'N passages could not be embedded' with the document and page, and still reports the library done for the remainder
- [ ] Already-purchased vectors in a batch are all written even if one UPDATE errors

---

<a id="sem-5"></a>

## SEM-5 · Coverage and retrieval disagree about which chunks count — money is spent embedding passages semantic_search will never return

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261014_coverage_timeout_headroom.sql:20-25`, `supabase/migrations/20261007_rag_hardening.sql:91-95`, `lib/knowledgeEmbedCore.ts:56-60`, `lib/knowledgeIngest.ts:582`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct: chunks of an errored document are counted in total and embedded, are paid for on the user's key, and are then excluded from every semantic_search result. Nothing resets status='error' automatically — only a manual re-ingest (drawing/route.ts:371 sets 'stale') puts those chunks back in retrieval range.

**Mechanism.** `semantic_coverage` counts every chunk in the library — `SELECT COUNT(*) FROM knowledge_chunks WHERE org_id = p_org_id AND (p_library_id IS NULL OR library_id = p_library_id)` — with no join to `knowledge_documents` and no status predicate (20261014:20-25, and identically in 20261011 and 20260930). `semantic_search` DOES filter, via `JOIN knowledge_documents d ON d.id = c.document_id … AND d.status IN ('ready','indexing')` (20261007:90-93). `embedLibrarySlice` also has no status filter (knowledgeEmbedCore.ts:57-59), so it embeds chunks belonging to documents in any status, including the `status: "error"` a failed ingest writes (knowledgeIngest.ts:582). The denominator, the numerator, the work queue and the retrievable set are three different populations. Money is spent on the difference, and coverage percentages are reported against a total that retrieval does not use.

**Failure scenario.** A bulk ingest of 300 drawings partially fails: 40 documents end at status 'error' with their partial chunk sets already inserted. Those chunks are counted in `total`, embedded on the user's key by the build, counted in `embedded` — and then excluded from every `semantic_search` result by the status join. The admin pays for vectors that can never be retrieved, and the coverage bar reports a percentage over a corpus that is 13% larger than the one being searched. Marked SUSPECTED because whether a failed ingest leaves chunks behind depends on the ingest transaction boundary, which the repo does not settle.

**Evidence.**

```
20261014_coverage_timeout_headroom.sql:21-25 (no join, no status) against 20261007_rag_hardening.sql:89-93 — `FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE c.org_id = p_org_id AND (p_library_id IS NULL OR c.library_id = p_library_id) AND d.status IN ('ready', 'indexing')`.
```

**Done when.**

- [ ] `semantic_coverage` and `embedLibrarySlice` apply the same document-status predicate as `semantic_search`
- [ ] Chunks belonging to non-retrievable documents are either cleaned up or excluded from the embed queue
- [ ] Coverage percentage is defined against the retrievable population and the definition is stated on the panel

---

<a id="sem-6"></a>

## SEM-6 · Linked reference libraries contribute zero semantic results whenever their corpus model differs from the asked library's

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:394-397`, `app/api/knowledge/ask/route.ts:463-467`, `app/api/knowledge/ask/route.ts:480-489`, `supabase/migrations/20261007_rag_hardening.sql:95`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — one library's stamp is imposed on all of them, so a linked reference library on any other embedding model contributes exactly zero semantic hits while still appearing to be fully indexed in its own panel. Nothing detects or reports the mismatch.

**Mechanism.** `searchLibraries` is the asked library plus every linked library (ask/route.ts:394-397). `corpusModel` is read from a single chunk of the ASKED library only — the query at line 465 is `.eq("org_id", orgId).eq("library_id", libraryId)`, hardcoded to the primary. That one value is then applied as `p_model` to the fan-out over EVERY library, including the reference tier: `for (const lib of searchLibraries) for (const literal of literals) jobs.push({ lib, literal })` … `p_model: corpusModel` (lines 481-488). Each library is built independently by whoever pressed Build on it, at whatever model the saved connection held that day, so different libraries routinely carry different stamps. Any linked library whose stamp differs is filtered to zero rows by `AND (p_model IS NULL OR c.embedding_model = p_model)`, and the loop that consumes the results discards empty results without comment (`if (error || !Array.isArray(data)) continue;`, line 492).

**Failure scenario.** The governing library (site engineering practices) was built last month under voyage-3.5-lite. A linked reference library of vendor manuals was built this week after the admin bumped the saved model to voyage-3.5. An engineer asks a meaning-shaped question whose answer lives in a vendor manual. The vendor library returns zero semantic rows; only its keyword hits survive fusion. The answer is materially worse and the response still reports `retrieval: "hybrid"` because the primary library did return vectors.

**Evidence.**

```
app/api/knowledge/ask/route.ts:465 — `.eq("org_id", orgId).eq("library_id", libraryId)` (the asked library, not the loop variable `lib`), versus line 484-488 — `p_org_id: orgId, p_library_id: lib.id, p_embedding: literal, p_limit: …, p_model: corpusModel`.
```

> **Verifier correction.** Severity corrected HIGH→MEDIUM because a mitigating path covers most of the loss: linked libraries are still searched by KEYWORD on every ask — runSearches fans out over the same searchLibraries array (ask/route.ts:398-436) with no model filter at all — so a stamp-mismatched reference library still contributes passages, it just loses its meaning-based half. The finding's 'contribute zero semantic results' is accurate; 'contribute nothing' would not be.

**Done when.**

- [ ] `p_model` is resolved per library rather than once from the primary
- [ ] A library whose stamp cannot be matched is reported (count of libraries that contributed no semantic rows) rather than silently skipped
- [ ] A test with two libraries on two model stamps asserts both contribute semantic results or the mismatch is surfaced

---

<a id="sem-7"></a>

## SEM-7 · No lock or claim anywhere in the embed path — concurrent drains re-embed the same passages and multiply spend on a third party's key

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/knowledge.ts:822-833`, `app/(protected)/knowledge/[id]/page.tsx:1151-1154`, `app/api/cron/embed-drain/route.ts:27-46`, `lib/knowledgeEmbedCore.ts:56-60`, `lib/knowledgeEmbedDrain.ts:51-56`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence across the whole path — the same unembedded rows can be selected, sent, and billed by the browser build and by one drain per member who opens the library page, all charged to the stamp owner's key (drain.ts:62-63, 123-127). The duplicate writes are idempotent, so the damage is spend, not corruption.

**Mechanism.** The work queue is a predicate, not a claim: `embedLibrarySlice` selects `.is("embedding", null).limit(batchSize)` (knowledgeEmbedCore.ts:57-60) and does not mark, lock, or reserve those rows. Nothing in the repo takes an advisory lock or a SKIP LOCKED claim on this path (searched `advisory_lock`, `pg_try_advisory`, `for update skip locked`, `claim` across lib/, app/api/ and supabase/migrations — the only claim machinery is lib/costDocs.ts's compare-and-swap, unrelated). Meanwhile `nudgeEmbedDrain()` is fired from a bare `useEffect(…, [])` on EVERY mount of the knowledge library page (page.tsx:1152-1153), and `/api/cron/embed-drain` accepts any signed-in member's bearer, scoping to all of their orgs (route.ts:36-42) with `maxDuration = 300` and no rate limit, no idempotency key, and no in-flight check. Two or ten concurrent invocations therefore each SELECT the same NULL-embedding rows, each pay the provider for the same passages, and each UPDATE the same ids. The panel's browser build loop (`buildSemanticIndex`, lib/knowledge.ts:900-917) runs against the same predicate on the same page that just fired the nudge, so the duplication is the default path, not an edge case.

**Failure scenario.** An admin opens the knowledge library page and presses Build. The mount effect has already dispatched a 300-second server-side drain for the same library. Both loops SELECT the same 64 unembedded chunks, both send them to Voyage, both write the same vectors. Every passage is billed twice. Add three teammates navigating between libraries — each mount spawns another drain against the same backlog — and the same index is paid for five times, all charged to the single user whose id sits in `ai_features.embedBuild`. Then the route's own consistency guard misfires: `after.embedded < stats.embedded + embedded` (embed/route.ts:193) is exactly what concurrent double-counting produces, so the build stops with 'Wrote N vector(s) but the library's count only shows M — writes are not landing. Tell your admin: verify library_id/org_id on knowledge_chunks' — a diagnosis pointing at the wrong thing entirely.

**Evidence.**

```
app/(protected)/knowledge/[id]/page.tsx:1151-1153 — `useEffect(() => { void import("@/lib/knowledge").then((m) => m.nudgeEmbedDrain()); }, []);` with no guard; app/api/cron/embed-drain/route.ts:34-43 — any user bearer is accepted and `scopeOrgIds` is set to every org they belong to; lib/knowledgeEmbedCore.ts:57-60 — `.eq("org_id", orgId).eq("library_id", libraryId).is("embedding", null).limit(batchSize)` with no claim and no ORDER BY.
```

> **Verifier correction.** Two corrections. (a) 'the duplication is the default path, not an edge case' is not supported: the drain only touches libraries carrying an ai_features.embedBuild stamp (knowledgeEmbedDrain.ts:54), which only a controller's manual build creates, so the browser loop and a drain collide only when a build is already in flight or was left unfinished. (b) The blast radius is bounded: embedLibrarySlice re-issues its `.is("embedding", null)` query at the top of every batch iteration (line 56), so once a competing writer commits, subsequent batches skip those rows — the duplicate spend is per-in-flight-batch, not per-library. Verification corrected to SUSPECTED because whether two runs actually overlap, and by how much, depends on live timing that cannot be observed from the repo; the missing-claim mechanism itself is confirmed.

**Done when.**

- [ ] A per-library claim (advisory lock, or a `SELECT … FOR UPDATE SKIP LOCKED` RPC, or an in-flight marker with a lease) makes two concurrent drains disjoint or makes the second a no-op
- [ ] `nudgeEmbedDrain` is debounced per user/session so navigation does not fan out 300-second invocations
- [ ] `/api/cron/embed-drain` rate-limits user-bearer triggers
- [ ] The 'writes are not landing' guard tolerates concurrent progress instead of reporting a wrong root cause

---

<a id="sem-8"></a>

## SEM-8 · Nothing re-arms the index after ingestion — coverage silently decays from 100% every time a document is added

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeEmbedCore.ts:136-149`, `app/api/knowledge/embed/route.ts:150-154`, `app/api/knowledge/embed/route.ts:199-201`, `lib/knowledgeEmbedDrain.ts:60-70`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The automation gap is real — ingesting documents never re-arms the drain, so new chunks stay keyword-only until someone presses Build again. 'Silently' is the part that does not hold: SemanticIndexPanel.tsx:171-173 and 226-229 recompute from live coverage and display '<covered> of <total> passages carry meaning vectors (70%)', the green check disappears, and the control reverts from 'Rebuild index' to 'Build index (~N¢)' (:197-211) — that is the panel telling the truth, not concealing it.

**Mechanism.** `setEmbedBuildMarker(libraryId, userId)` — the stamp the drain requires — has exactly ONE caller that passes a user id: app/api/knowledge/embed/route.ts:154, reached only when a controller manually POSTs a build. Confirmed by `grep -rn 'setEmbedBuildMarker|embedBuild'` (all 11 hits are the definition, the drain's reads/clears, and that one setter) and by `grep -rni 'embed'` over lib/knowledgeIngest.ts, lib/knowledgeSourceSync.ts and app/api/knowledge/ingest/route.ts, which returns nothing. The route then CLEARS the stamp the moment the library reaches zero remaining (line 201: `if (remaining === 0 && !lastError) await setEmbedBuildMarker(libraryId, null)`), and the drain clears it too (line 130). So a completed library is a disarmed library. Every subsequent ingest — a manual upload, a bulk wizard run, or the automatic doc-control mirror in knowledgeSourceSync — inserts chunks with `embedding IS NULL` that no process will ever pick up, because the only thing that looks for them requires a stamp that only a human button press creates.

**Failure scenario.** A plant finishes its index at 100%, the panel shows the green check and switches the button to 'Rebuild index'. Over the next quarter, doc control mirrors 400 new and revised drawings and standards into the library. Coverage decays to ~70%. Meaning search covers the OLDEST material and none of the newest — the exact inversion of what an engineer would assume. Nothing notifies anyone; the only place the number is visible is a panel on a settings surface that only controllers can see, and only if they scroll to it.

**Evidence.**

```
lib/knowledgeEmbedCore.ts:138-145 — the only writer: `export async function setEmbedBuildMarker(libraryId: string, userId: string | null)` … `if (userId) feats.embedBuild = { userId, at: new Date().toISOString() }; else delete feats.embedBuild;`. Its sole userId-passing call site is app/api/knowledge/embed/route.ts:154, whose comment reads 'Consent marker for the background drain: starting a build records WHO is paying' — the consent model is sound; the gap is that ingestion never asks for renewed consent either.
```

> **Verifier correction.** 'Silently' is overstated and severity drops accordingly. SemanticIndexPanel reads live coverage from semantic_coverage on every mount (SemanticIndexPanel.tsx:53-65) and renders the bar plus a Build-index button to controllers whenever `remaining > 0` — so the decay is visible to anyone who opens the library page, which is the same page the documents were uploaded on. The real defect is that nothing AUTOMATIC re-arms it: the drain is a no-op without a stamp only a human button press can create.

**Done when.**

- [ ] Ingestion (and the source-sync mirror) either re-arms the stamp under a standing per-library consent, or raises a visible 'N new passages need vectors' state
- [ ] The library page shows drift from 100% prominently, not only inside the build panel
- [ ] Non-controllers can at least see that the library's meaning index is behind its documents
- [ ] A test asserts that adding chunks to a completed library produces a visible not-covered state

---

<a id="sem-9"></a>

## SEM-9 · One global HNSW index, four post-filters and no ef_search — filtered semantic search can return far fewer rows than asked, or none

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260930_semantic_layer.sql:65-66`, `supabase/migrations/20261007_rag_hardening.sql:89-97`, `app/api/knowledge/ask/route.ts:482-489`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: filters are applied after the HNSW walk and nothing raises ef_search off its default 40, so a small tenant inside a large multi-tenant table can get a handful of rows or zero for a 12-row request. One mitigation the finding does not cite: 20261011_semantic_coverage_fast.sql:17 adds `knowledge_chunks_org_lib_idx (org_id, library_id)`, so for a very selective library the planner may pick an exact index-scan+sort plan instead — the recall loss is plan-dependent, not guaranteed. MEDIUM stands.

**Mechanism.** `CREATE INDEX … ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)` (20260930:65-66) is a single graph over every chunk of every library of every org in the database, with no `m`/`ef_construction` tuning and — confirmed by a repo-wide search for `ef_search` returning zero hits in .ts, .tsx and .sql — no `hnsw.ef_search` set anywhere. `semantic_search` then applies four predicates that the index cannot use: `c.org_id = p_org_id`, `c.library_id = p_library_id`, `d.status IN ('ready','indexing')` (a join condition), and `c.embedding_model = p_model` (20261007:91-95). pgvector's HNSW scan walks the graph to the default `ef_search = 40` candidates and the filters are applied to what comes back. As the table grows across orgs and libraries, the fraction of those candidates belonging to the requested library falls, so a `p_limit` of 12 can be satisfied by 3 rows, or 0, even when hundreds of good matches exist in that library. The failure is invisible: the route treats a short result exactly like a genuinely thin one (`for (const { lib, r } of results) { const { data, error } = r; if (error || !Array.isArray(data)) continue; …}`, ask/route.ts:490-492).

**Failure scenario.** A multi-tenant deployment reaches a few million chunks. A small workspace with a 3,000-passage library asks a meaning question. The HNSW walk returns 40 global nearest neighbours, 39 of which belong to other orgs and are discarded by `org_id`. One row survives. The fusion at ask/route.ts:543-547 receives a one-item meaning list, RRF barely moves the ordering, and the answer is effectively keyword-only — while `semanticUsed` is true and the response reports 'hybrid'. Nothing degrades gracefully; it degrades invisibly, and it degrades worse the more customers the platform has.

**Evidence.**

```
supabase/migrations/20260930_semantic_layer.sql:61-66 — the index's own rationale is about maintenance ('needs no training step and no rebuild as rows arrive'), not about filtered recall: `CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);`. The four post-filters are at 20261007_rag_hardening.sql:91-95. SUSPECTED rather than CONFIRMED because the magnitude depends on live table size and data distribution, which cannot be observed from the repo.
```

**Done when.**

- [ ] `hnsw.ef_search` is raised for the search path (a `SET LOCAL` inside the function, sized against p_limit), or the query uses an iterative-scan strategy
- [ ] Partitioning or a partial-index-per-org strategy is evaluated so the filters are not purely post-hoc
- [ ] `semantic_search` reports when it returned fewer than p_limit rows so short results are distinguishable from thin corpora
- [ ] A recall check on a representative corpus asserts filtered results match an exact-scan baseline

---

<a id="sem-10"></a>

## SEM-10 · Query-side embedding tokens are never metered — contradicting the module's own stated contract

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/ai/embeddings.ts:20-21`, `lib/ai/embeddings.ts:208-215`, `app/api/knowledge/ask/route.ts:265-280`, `app/api/knowledge/ask/route.ts:475-478`, `app/api/knowledge/ask/route.ts:701-704`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is exactly as claimed — up to 5 query embeddings per ask (3 at :476 `texts.slice(0,3)` plus 2 at :703 `plan.queries.slice(0,2)`) are billed by the provider and never metered. But the magnitude is negligible: a query is tens of tokens, so 10,000 query embeddings on voyage-3.5-lite is a fraction of a cent — it cannot meaningfully distort the ledger or the cap. It is a broken documented contract, not a billing problem; LOW.

**Mechanism.** `embedQuery` calls `embedPassages` and returns only `vectors[0]`, discarding the `usage` the provider reported (embeddings.ts:211-214). In the ask route, the metering accumulator is fed exclusively by the chat wrapper: `const call = async (input) => { const out = await callAiModel(…); askUsage.inputTokens += out.usage.inputTokens; askUsage.outputTokens += out.usage.outputTokens; return out; }` (lines 273-278), and `meter()` writes one row from `askUsage` (line 280). `runSemantic` embeds up to three query texts in round 1 (line 475: `texts.slice(0, 3)`) and is called again with up to two refine queries in round 2 (line 703: `runSemantic(plan.queries.slice(0, 2))`), fanned out across every library — none of that touches `askUsage` and none of it produces an `ai_usage_events` row. The file's own header states the opposite contract: 'Runs on the member's own key and is metered like every other AI call' (embeddings.ts:20-21).

**Failure scenario.** A workspace runs 2,000 asks a month. Each spends up to five query embeddings against the member's Voyage/OpenAI key. Ten thousand billable calls appear on the provider invoice and zero appear in the app's usage ledger, which is the artifact an admin uses to reconcile the bill and to decide caps. On top of the cap-op hole, this means the retrieval half of the AI spend is entirely off-book — including asks over a library that was just reset to 0%, where every one of those query embeddings is purchased to search an empty index.

**Evidence.**

```
lib/ai/embeddings.ts:208-215 — `export async function embedQuery(…): Promise<number[]> { const { vectors } = await embedPassages({ provider, model, apiKey, passages: [query], kind: "query", signal }); return vectors[0]; }` — `usage` is destructured away. app/api/knowledge/ask/route.ts:265-266 states the intended invariant: 'Every model call in this ask (query gen, refine, probes, answer) adds its exact provider-reported tokens here; one metering row per ask.'
```

> **Verifier correction.** Worth stating so nobody over-prioritises it: the unmetered amount is tiny — at most five short query strings per ask, a few hundred tokens — so the defect is a violated stated invariant and a small systematic under-count, not meaningful escaped spend. The large hole is finding 1.

**Done when.**

- [ ] `embedQuery` returns usage and `runSemantic` folds it into a metered total
- [ ] Query-embedding spend appears in `ai_usage_events` (its own op is fine, provided the cap reads it)
- [ ] Asks over a library with zero embedded chunks skip the query embedding entirely rather than buying a vector that can match nothing
- [ ] A test asserts an ask produces a metering row covering its embedding calls

---

<a id="sem-11"></a>

## SEM-11 · Six stuck libraries permanently starve the drain: `.limit(6)`, no ordering, and markers that are never cleared on cap-reached or error

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/knowledgeEmbedDrain.ts:51-56`, `lib/knowledgeEmbedDrain.ts:88-95`, `lib/knowledgeEmbedDrain.ts:113`, `lib/knowledgeEmbedDrain.ts:120-121`, `app/api/cron/maintenance/route.ts:292-294`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All three cited defects are real, and the finding's own scenario is the one where the mitigation doesn't help: the page-load nudge (knowledge/[id]/page.tsx:1153 → embed-drain/route.ts:41-43) scopes to the caller's own orgs, so an org whose owner closed the tab depends on the daily cron, which is exactly the global unordered `.limit(6)` path. Note for completeness that the nudge does rescue any org where a member opens the app and that org holds fewer than 6 marked libraries.

**Mechanism.** The drain's work list is `.from("knowledge_libraries").select("id, org_id, ai_features").not("ai_features->embedBuild", "is", null).limit(6)` — no `.order()`, so PostgREST returns whatever Postgres yields, in practice a stable heap order. Two exits leave the marker in place: the monthly-cap gate `drained.push({… note: "monthly cap reached" }); continue;` (lines 92-95) and the slice-error gate `if (slice.error) { drained.push(…); break; }` (line 113). Both skip the `setEmbedBuildMarker(lib.id, null)` that the other exits perform (lines 68, 83, 130). A library that hits its owner's cap therefore keeps its stamp for the rest of the month and keeps occupying one of six slots on every single run. Six such libraries and the seventh — a healthy build with a funded key — is never selected again by any drain, from any nudge or cron, until someone manually clears a stamp in the database. The daily backstop is small anyway: `drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 100_000 })` (maintenance/route.ts:293) is 100 seconds per day for the whole platform, and the inner loop refuses to start a slice with under 20 seconds left (line 104).

**Failure scenario.** Three workspaces start large builds; their owners are at their (chat-only, see the cap finding) caps or hold expired keys that 400 rather than 401. Three more stall on a provider error. All six retain `ai_features.embedBuild`. A seventh workspace starts a build, closes the tab, and relies on the documented background continuation. Its stamp is set but its row never appears in any `.limit(6)` result. Its index sits at whatever percentage the browser reached, indefinitely, while the panel says 'Partly built' and the drain reports six libraries drained on every run.

**Evidence.**

```
lib/knowledgeEmbedDrain.ts:51-55 — `.not("ai_features->embedBuild", "is", null).limit(6)` with no ordering clause; lines 92-95 — `if (capUsd > 0 && month.spentUsd >= capUsd) { drained.push({ libraryId: lib.id, embedded: 0, remaining: remainingBefore, note: "monthly cap reached" }); continue; }` — no marker clear. Contrast line 83, where the no-key exit does clear it.
```

> **Verifier correction.** The finding's central evidence claim is FACTUALLY WRONG and must not be acted on. 'Both skip the setEmbedBuildMarker(lib.id, null)' is false for the slice-error gate: line 113's `break` exits the INNER `for(;;)` slice loop that starts at line 102, not the outer per-library `for...of` — control falls straight through to lines 123-133, where line 130 `if (remainingAfter === 0) await setEmbedBuildMarker(lib.id, null);` runs exactly as on the success path. The marker persists after an error only when the library is genuinely unfinished, which is correct. The cap-reached `continue` (lines 92-95) does skip line 130, but that is the module's stated design, not a defect: the header comment at lines 4-8 says 'The stamp clears when the library reaches 100% (or when the key disappears)', and clearing it on a cap hit would ABANDON a paid-for build that should resume when the cap resets on the 1st. Verification corrected to SUSPECTED because the starvation outcome depends on Postgres's row-return order for an unordered filtered scan, which is not observable from the repo. Note also the nudge path passes scopeOrgIds (route.ts:41), so cross-org starvation can only bite the platform cron.

**Done when.**

- [ ] The library query orders by least-recently-attempted (a `lastDrainAt` on the marker) so the window rotates
- [ ] Cap-reached and repeated-error libraries either release the marker or record a backoff timestamp the query skips
- [ ] Drain results distinguish 'advanced', 'blocked (reason)', and 'starved — never selected' so the state is diagnosable
- [ ] A stuck-marker library surfaces somewhere an admin sees it

---

<a id="sem-12"></a>

## SEM-12 · The one signal that tells an asker retrieval was keyword-only is computed and never rendered — partial coverage degrades answers with zero indication

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:268-272`, `app/api/knowledge/ask/route.ts:568`, `app/api/knowledge/ask/route.ts:1774`, `lib/knowledge.ts:122-126`, `components/knowledge/SemanticIndexPanel.tsx:257-265`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves: the flag is a boolean over `semantic.length > 0`, so 3% coverage still reports "hybrid", and no component anywhere renders the field. The route's own comment convicts it.

**Mechanism.** The route sets `semanticUsed = semantic.length > 0` (line 568) and returns `retrieval: semanticUsed ? "hybrid" : "keyword"` (line 1774). `AskAnswer.retrieval` is declared in lib/knowledge.ts:126. No component reads it. Confirmed with three differently-shaped searches: `grep -rn 'retrieval' components/` (only a comment inside SemanticIndexPanel), `grep -rn '\.retrieval\b'` repo-wide (zero hits outside node_modules), and `grep -rn 'hybrid'` across components/app/lib (only the route, the type, and an unrelated `hybridAuthStorage` in lib/supabase.ts). The signal is also binary and coarse even if it were rendered: a library with 12 of 40,000 passages embedded returns `"hybrid"` exactly like a fully-built one. The only honest coverage surface in the product is `SemanticIndexPanel` (lines 257-265, which does say 'Partly built — questions already use both, and the remaining passages are keyword-only until this finishes'), and it lives on the library settings area, not on the ask surface, and its Build/Rebuild controls only render `isController`. A rank-and-file engineer asking questions has no path to that information at all.

**Failure scenario.** A DocCtrl user starts a build on a 40,000-passage PSM library, gets rate-limited on the Voyage free tier, closes the tab at 3% coverage. The stamp stays, so `retrieval` reports `"hybrid"` for every subsequent ask because the 1,200 embedded chunks return something. An engineer asks 'do we have anything about pipe supports' — the exact question the semantic layer exists to answer, per 20260930_semantic_layer.sql:11-15 — and the standard titled 'hanger and support details' is in the 97% that has no vector. The answer is 'nothing found in this library.' Nothing on screen distinguishes that from 'the plant has no such standard.' In a PSM/OSHA context that is a false negative on a regulated document with no audit trail explaining why.

**Evidence.**

```
lib/knowledge.ts:122-126 states the intended contract in its own doc comment — "How the passages were found. … It's stated so an answer can never IMPLY a meaning-based search that didn't run." — for a field with no consumers. app/api/knowledge/ask/route.ts:268-271 repeats it: 'Reported to the caller so the UI can say "keyword only" instead of implying a semantic search that never happened — an answer quietly missing its best source, with no way for the reader to know why, is the worst failure this route has.'
```

> **Verifier correction.** The finding's closing claim is FALSE and drives the severity down. SemanticIndexPanel is rendered on the SAME page as the ask box — app/(protected)/knowledge/[id]/page.tsx:1962 renders it under `{activeOrgId && (...)}` with no controller gate, while the ask input is at line 1671 of that same component — and its coverage bar plus the exact text 'Partly built — questions already use both, and the remaining passages are keyword-only until this finishes' (SemanticIndexPanel.tsx:257-265) renders for EVERY member; `isController` gates only the Build/Rebuild buttons (line 192). So a rank-and-file engineer does have a path to library-level coverage, on the same screen. What is genuinely missing is the PER-ANSWER signal. Also a cite error: `semanticUsed = semantic.length > 0` is at ask/route.ts:573, not 568.

**Done when.**

- [ ] The answer surface renders retrieval mode, and renders it for non-controllers too
- [ ] `retrieval` carries coverage (embedded/total for the libraries actually searched), not just a boolean, so 3% and 100% are distinguishable
- [ ] An answer produced over a library below some coverage threshold shows an explicit 'meaning search covers N% of this library' note next to the sources strip
- [ ] A test asserts the ask response's retrieval/coverage fields reach a rendered element

---

<a id="sem-13"></a>

## SEM-13 · Two different, both-wrong prices for the same rebuild: the panel quotes 1¢/1k flat, the ledger charges Voyage at 10× the real rate

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `components/knowledge/SemanticIndexPanel.tsx:32-35`, `components/knowledge/SemanticIndexPanel.tsx:174-175`, `components/knowledge/SemanticIndexPanel.tsx:109-118`, `lib/ai/pricing.ts:84-91`, `app/api/knowledge/embed/route.ts:213`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both numbers confirmed and they disagree by ~7× on the same job (250k passages: 250¢ quoted vs ~$18 ledgered at 0.20/M). This is not cosmetic: the same inflated figure is what getMonthUsage/getCapUsd compare against, so a voyage build consumes a member's monthly cap ~10× faster than the real spend and can be halted by the cap path at knowledgeEmbedDrain.ts:92.

**Mechanism.** The user-facing estimate is model-independent: `const CENTS_PER_1K_PASSAGES = 1` (panel line 35), used for both `estCents` and `fullCents` (lines 174-175) and quoted verbatim inside the rebuild confirmation ('re-embeds every passage on your key — roughly ${fullCents}¢', lines 113-115). It does not consult the saved model. Meanwhile the ledger uses `estimateCostUsd(embedding.model, usage)` (embed/route.ts:213) against `["voyage-", 0.20, 0]` (pricing.ts:91) — a single prefix covering all three Voyage models the picker offers. Chunks target ~1400 chars (lib/knowledgeText.ts:96), so 1,000 passages is roughly 360k tokens: the ledger records ~7.25¢ where the panel promised 1¢. In the other direction, `text-embedding-3-large` at $0.13/M (pricing.ts:85) and `voyage-3-large` cost roughly 4-6× the panel's flat 1¢/1k, so the panel understates for exactly the models a quality-conscious admin would pick. The panel's own comment claims the opposite guarantee — 'deliberately rounded UP so nobody is surprised by their provider's invoice' — and pricing.ts:86-90 openly admits the Voyage figure 'was not read off Voyage's published price list'.

**Failure scenario.** An admin on voyage-3.5-lite reads 'Rebuild index (~250¢)' for a 250,000-passage library, accepts, and the in-app spend ledger reports about $18 for the same job — a 7× surprise on a number the product itself quoted as the cost. An admin who chose voyage-3-large for quality reads the same 250¢ and pays their provider several times that. Neither number is the provider's, and the two disagree with each other.

**Evidence.**

```
components/knowledge/SemanticIndexPanel.tsx:32-35 — `/** Rough, deliberately rounded UP so nobody is surprised by their provider's invoice. … */ const CENTS_PER_1K_PASSAGES = 1;` versus lib/ai/pricing.ts:86-91 — `// Voyage rates are DELIBERATELY CONSERVATIVE PLACEHOLDERS — this figure was not read off Voyage's published price list … ["voyage-", 0.20, 0]`.
```

> **Verifier correction.** Two corrections. (a) '10× the real rate' rests on Voyage's published price list, which is external knowledge no one verified here — no provider was called and no price list is in the repo. Restate as: the ledger's Voyage rate is a SELF-DECLARED conservative placeholder (pricing.ts:86-90) that disagrees with the panel's flat estimate by roughly 7×, and the code says which direction it errs. (b) The cite embed/route.ts:213 is not the ledger write — line 213 is `spentThisRun: estimateCostUsd(embedding.model, usage)` in the JSON response; the ledger row's cost is computed by the same function inside recordAskUsage at lib/ai/usageServer.ts:120. Same function, different call site.

**Done when.**

- [ ] The panel's estimate is computed from the connection's model via `modelPricePerMTok` and the library's actual character volume, not a flat constant
- [ ] Per-model Voyage rates replace the single `voyage-` prefix (3.5-lite, 3.5 and 3-large differ by roughly an order of magnitude)
- [ ] The quoted pre-build estimate and the post-build ledger figure are produced by the same function
- [ ] A test asserts the two agree within a stated tolerance for each offered model

---
