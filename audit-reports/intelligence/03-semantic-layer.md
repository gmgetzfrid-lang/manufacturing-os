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
- **Assigned:** intelligence I-03 THE ASK ROUTE (the residual: the ask route reads its corpus model from one row — move it onto `resolveCorpusModel`) — by the integrator, 2026-10-01 (at the I-05 merge: the earlier assignment to I-05 was wrong — its branch does not touch the ask route; fleet plan `audit-reports/fleet-plans/`).
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


**Partial (2026-09-30, intelligence Round G).** Reproduced first: nothing detected a mixed library and the ask route took the corpus model from one unordered row. Landed: `20261121` `semantic_coverage_detail` reports vectors per model over the whole library; `lib/ai/embeddings.ts` `resolveCorpusModel` reads them deterministically (single / mixed / empty — never "whichever row came back first"); the panel says out loud when a library holds more than one model and that meaning search is off for it until rebuilt; `semantic_search` returns nothing for a library holding any model other than `p_model` (a mixed library is refused whatever stamp the route picks); the build refuses, before anything is spent, to add a second model's vectors (`buildModelConflict` in the embed route — 409 with both ways out — and in the drain — an hourly re-checked hold), so a mixed library can no longer be created; the Rebuild dialog says vectors are never reused across models. Review fix: the claim itself carries the driver's model (`embed_claim_batch(…, p_model)`, 20261121) and hands out nothing while the library holds a vector under any other model, so a driver on another connection cannot start a second vector space once a rebuild's first vector has landed; a build that meets it names the conflict (not a stale schema cache) and the drain holds it (`embedDrain.test.ts` "SEM-1 — the claim hands out nothing…", `embedStatusShape.test.ts` "the claim hands out nothing because another model's vectors landed first"); a Rebuild also ends another member's background consent first (`SEM-8`), so no drain on another model is left running against it. The package decision `DEC-59` (3). The SQL was run on a scratch PostgreSQL 16 with a stand-in `vector` type (a domain over `float8[]` and a cosine operator — pgvector is not installed in this environment, so the HNSW settings themselves are not exercised there): coverage counted 40 retrievable passages of 48 (an errored document's excluded); two back-to-back claims were disjoint and never touched the errored document's chunks; a passage at 3 attempts was skipped and the fewest-attempts passages came first; `authenticated` was refused EXECUTE on the claim; `semantic_search` returned nothing for a two-model library and for a wrong model, never an errored document's vector, and reported `eligible`; all seven probes were true on the first apply and again on a second (idempotent). After the review fixes the paste was re-run the same way: all nine probes true on the first apply and on a second; the marker writer set, patched and cleared the `embedBuild` key alone and changed nothing on a stale expectation or on a library with no marker; the toggles save kept the marker, dropped a forged `embedBuild` and was refused by RLS for a Viewer; the claim handed out nothing under another model; `leased` left out refused-out passages. After fix pass 2 (the `embed_retry_after` column and `waiting` count, the two covering coverage indexes) the paste was re-run once more on a scratch PostgreSQL 16 over the 20261014 `semantic_coverage`: all nine probes true on the first apply and on a second; two passages recorded as refused counted `waiting` 2 beside `leased` 2 and were not offered by the next claim until their wait expired; a clear under a stale expectation returned false (and one under the current expectation true, the toggles kept); both coverage counts planned as index-only scans of `knowledge_chunks_org_lib_doc_idx` / `knowledge_chunks_org_lib_doc_embedded_idx`.

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (inventory before apply: chunks and vectors; libraries holding more than one model; vectors whose model differs from the build payer's saved model, in total and per library; build markers, those older than 7 days and those naming no active member; chunks and vectors of documents not ready / indexing; after apply: the pgvector version and whether the iterative scan was enabled; the last row runs the recall check).

**Done-when.**
1. ✓ Coverage distinguishes vectors by `embedding_model` and the panel names a mixed library.
2. ✗ Not at save time. Saving a different model in AI settings (`components/knowledge/AiSettingsModal.tsx` → `/api/ai/connection`, I-05's files) still does not warn. The warning arrives before any mixture can exist: the panel shows the conflict to a controller as soon as the saved model differs from the index, the build refuses with the Rebuild offer, and the drain holds. Handed to I-05: the save-time confirm.
3. ✓ A mixed library refuses semantic search until rebuilt (deterministic whatever stamp the route reads).
4. ✓ `lib/__tests__/embeddings.test.ts` (a two-stamp corpus resolves as mixed, in any key order), `embedStatusShape.test.ts` (the status and the 409), and the scratch PostgreSQL 16 run (the search refuses a two-model library).

**Scope / residual.** The ask route still reads its corpus model from one row (`ask/route.ts:463-468`, I-03); with 20261121 applied that no longer decides which half is searched.

**Partial (2026-10-01, intelligence Round G, I-03).** The ask route's remainder. Reproduced first (DEC-29): with the base route (`4dd0df7`) swapped back in, 53 of the 92 cases in the new `lib/__tests__/askRouteAcl.test.ts`, `askRouteHonesty.test.ts` and `askRouteUnits.test.ts` fail — every case named below as a reproduction among them — and the REGRESSION pin (an org under its cap, agreement signed, key saved: the same answer, citations, memory row and one metering row) passes on both.

- **The route reads the corpus model whole.** Each searched library's corpus model comes from `semantic_coverage_detail` through `loadEmbedDetail` → `resolveCorpusModel` (single / mixed / empty), never from one row; a mixed library is not searched and the answer says why. A database before `20261121` (no coverage detail) reads its stamp from one row as before — with `20261121`'s refusal it no longer decides which half is searched.

Tests: `askRouteHonesty.test.ts` "SEM-6 / SEM-1 reproduction → fix: a linked library on another model is searched in ITS vector space …".

The save-time confirm this package first added to `EmbeddingKeyEditor` (`components/knowledge/AiSettingsModal.tsx`) was withdrawn in its fix pass: that file is not this package's (the fleet plan gives the AI-settings modal to I-20, and the save-time confirm was handed to I-05 on 2026-09-30, above), and a parallel package edits it. Its test file (`embeddingSwitchWarning.test.ts`) went with it. Only `SEM-3`'s removal-dialog copy, which `SEM-3`'s remainder names, stays on this branch.

**Done-when.**
1. ✓ (2026-09-30) Coverage per model; the panel names a mixed library.
2. ✗ Not done. Saving a different embedding model or provider in AI settings still neither warns nor offers the reset; the panel, the build's 409 and the drain hold (2026-09-30) remain the only notice. Handed to I-20 (the AI-settings modal's owner in the fleet plan): a confirm at save time that says existing vectors stop answering and OFFERS the reset (names the libraries, or links each library's Rebuild).
3. ✓ (2026-09-30) A mixed library refuses semantic search until rebuilt; the ask route now resolves the model deterministically too.
4. ✓ (2026-09-30) The two-stamp tests.

**Scope / residual.** OPEN on done-when 2 (I-20).

---

<a id="sem-2"></a>

## SEM-2 · Embedding spend is invisible to the monthly cap — every cap check in the embed path reads a number that excludes embeddings

- **Severity:** HIGH
- **Status:** RESOLVED
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


**Resolution (2026-10-01, intelligence Round G).** Fixed at its root by GOV-1: every op counts in `getMonthUsage` and `getMonthUsageByUser`. Both embed-path gates — `/api/knowledge/embed` and the drain's per-library gate — read `getMonthUsage`, so a cap reached purely by embedding spend refuses the next build pass and holds the drain, with no edit to I-02's files. The usage response breaks spend out per op (`byOp`). The meter shows "Where it went", with the meaning index and vision indexing as their own lines inside one total, and the team table shows each member's breakdown on hover. Tests: `aiUsage.test.ts` ("a knowledgeEmbed row alone moves the number getMonthUsage returns, and can trip the cap", including the gates' legacy shape), `aiUsageRoute.test.ts`, `aiSettingsUsagePanel.test.ts`.

**Done-when.**
1. ✓ Neither rollup filters on `op`.
2. ✓ A cap reached by embedding spend alone blocks the next embed pass and the drain's gate.
3. ✓ The spend view shows embedding and vision as their own lines inside the monthly total.
4. ✓ Test: a knowledgeEmbed row moves the number `getMonthUsage` returns.

**Scope / residual.** None for this finding.

---

<a id="sem-3"></a>

## SEM-3 · Switching embedding provider makes semantic search return nothing, forever, silently — and the removal dialog promises the opposite

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** intelligence I-03 THE ASK ROUTE and I-05 AI GOVERNANCE — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
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


**Partial (2026-09-30, intelligence Round G).** Reproduced first (query embedded with the CURRENT connection's provider and the corpus's model; the catch at `ask/route.ts:505` returns []; the removal dialog promises vectors resume with any key). Landed: the corpus's provider is recorded by its model stamp and read by `embeddingProviderForModel`; `planQueryEmbedding(corpus, connection)` (`lib/ai/embeddings.ts`) is the shared answer to "how must a question be embedded to search this corpus": the corpus's own model on the corpus's own provider, or a reportable reason (`provider_mismatch`, `mixed`, `no_vectors`, `no_key`, `unknown_model`) instead of an empty result. A provider or model change now surfaces a blocking notice: the panel shows a controller the conflict ("This library's meaning index was built with text-embedding-3-small; your embeddings setting is voyage-3.5-lite … Use Rebuild index … or set your embedding model back"), Build is replaced by Rebuild, the build route refuses with 409 before anything is spent, and the drain holds. The Rebuild dialog says vectors are never reused across models. The package decision `DEC-59` (3).

**Done-when.**
1. Partly — the corpus's provider is recorded (its model stamp) and `planQueryEmbedding` says which provider must embed the query or reports it unavailable; ✗ the ask route (I-03's file) does not call it yet.
2. ✓ A provider change surfaces a blocking notice (panel + 409 + drain hold).
3. ✗ The catch at `ask/route.ts:505` is I-03's file — handed over with `planQueryEmbedding`'s reasons to report on the answer.
4. ✗ The removal-confirmation copy is in `components/knowledge/AiSettingsModal.tsx` (I-05's file) — handed to I-05: it should say vectors work again only with a key for the provider that built them.

**Scope / residual.** Handed: I-03 (route limb), I-05 (dialog copy).

**Resolution (2026-10-01, intelligence Round G, I-03).** The route limb and the dialog copy. Reproduced first (DEC-29): with the base route (`4dd0df7`) swapped back in, 53 of the 92 cases in the new `lib/__tests__/askRouteAcl.test.ts`, `askRouteHonesty.test.ts` and `askRouteUnits.test.ts` fail — every case named below as a reproduction among them — and the REGRESSION pin (an org under its cap, agreement signed, key saved: the same answer, citations, memory row and one metering row) passes on both.

- The ask route plans every searched library's query embedding with `planQueryEmbedding(corpus, connection)`: the corpus's own model on the corpus's own provider, or a reason. A library built by another provider is never sent the wrong provider's model; it is reported on the answer (`meaningSearch.notes`, e.g. "Vendor manuals: The meaning index was built with ‹model› (OpenAI); your embeddings key is Voyage AI …") and shown above the sources.
- The empty catch is gone: a provider that refuses the corpus's model (or the key) is a reportable fault, said on the answer ("‹library›: meaning search could not run — ‹the provider's message›"), and keyword search goes on. No embeddings key is the normal state: no note, and no library's index is even read.
- The removal dialog no longer promises the vectors work again with any key: "Vectors already built stay in place, but they work again only with a key for the provider that built them — a key for another provider cannot search them until the library's index is rebuilt with it."

Tests: `askRouteHonesty.test.ts` "SEM-3: a library built by another provider is reported on the answer (not an empty catch), and its model is never sent to the wrong provider", "SEM-3: a provider that refuses the corpus's model is said on the answer — keyword search goes on"; `askRouteUnits.test.ts` "SEM-3: removing the embeddings key never promises …" and "SEM-3 / ASK-11: a library meaning search could not cover … are said".

**Done-when.**
1. ✓ The corpus's provider is recorded (its model stamp) and the query is embedded with it, or meaning search reports unavailable rather than empty.
2. ✓ (2026-09-30) A provider change surfaces a blocking notice (the panel, the build's 409, the drain hold). A save-time confirm is `SEM-1` done-when 2's (I-20).
3. ✓ The catch distinguishes "no embedding key" (normal, silent) from a provider refusal (reported on the answer).
4. ✓ The removal-confirmation copy is corrected.

**Scope / residual.** None in this finding. `components/knowledge/AiSettingsModal.tsx` is also in I-20's file list, and this message is I-03's only change to it, so the merge must keep both. The known overlap is recorded in `99-fix-sequencing.md` (I-03 fix pass 2).

---

<a id="sem-4"></a>

## SEM-4 · A single un-embeddable chunk stops the build permanently — no failure tracking, no ordering, no skip

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-09-30, intelligence Round G).** Reproduced first, in a driven test: over the pre-20261121 queue one refused passage stopped the slice with the provider's 400 and the next three runs fetched the same batch and made no progress (`lib/__tests__/embedDrain.test.ts` "reproduction: the unclaimed queue…"). `20261121` adds `knowledge_chunks.embed_attempts` (NOT NULL DEFAULT 0) and `embed_error`; the queue (`embed_claim_batch`, `SEM-7`) orders fewest attempts first, then document / page, and skips a passage at `EMBED_MAX_ATTEMPTS` (3). `lib/knowledgeEmbedCore.ts` `embedLibrarySlice`: when the provider refuses the INPUT (400 / 413 / 422 — `lib/ai/embeddings.ts` now carries the provider's own status on the error, `isPassageRefusal`) the batch is split in halves until the refused passage stands alone (at most 16 provider calls per batch); that passage gets an attempt and its reason; every other passage embeds. A refusal of the key, the model or the provider (401 / 403 / 404 / 5xx / network) blames no passage — no attempt recorded, leases given back, the slice stops with the provider's words. Fix pass 2 (review major): the first pass also blamed nobody for "a batch in which nothing embedded", so two or more refused passages that made up a whole batch — the unembedded tail, or one bad document of a batch or more (the claim orders it first) — were never charged, never reached the limit, kept the library below done and, through the drain's error path, walked a standing consent into release after `MAX_ERROR_RUNS` runs. Now a passage refused ALONE is charged once the provider is known to accept the request: a sibling of the same batch embedded, or — when none did — a one-line canary (same provider, model and parameters, `embedLibrarySlice`'s `canary`) embeds. A canary refused too means the request is at fault: nobody is blamed and the slice stops with the provider's words and that diagnosis. The call cap ends only its batch (the passages isolated so far are charged, the rest go back to the queue) and the slice claims the next. A refused passage gives its lease back and waits `REFUSAL_RETRY_SECONDS` (120 s, `embed_retry_after`, 20261121) before any driver is offered it again — attempts accrue across runs, never in a tight loop, and a waiting passage is reported as `waiting`, never as a run embedding it (`SEM-7`). Tests (`embedDrain.test.ts`): "two refused passages that make up a WHOLE batch are still charged" (both reach `EMBED_MAX_ATTEMPTS`, the library reports done with failed = 2), "the drain over the same two" (never an error run; the standing consent is kept; the library ends "current"), "a refused document LONGER than one batch" (70 refused passages each reach the limit; the other 10 embed), "a batch the provider refuses whole AND a one-line canary refused too is the request". Every vector already paid for is written: the write-back continues past a failed row and reports the first error. `semantic_coverage_detail` reports `failed` separately from `remaining`, so refused passages never hold the library below done; the status lists up to five with document and page (`failedSamples`) — to controllers only (review fix: a mirror's name is its controlled document's number and title, read here on the service role, so every other reader gets the count; `embedStatusShape.test.ts` "refused passages' names go to controllers only"); the panel says "N passages could not be embedded", lists them, and offers controllers "Try them again" (`action: "retry-failed"`); Rebuild resets the counters. The SQL was run on a scratch PostgreSQL 16 with a stand-in `vector` type (a domain over `float8[]` and a cosine operator — pgvector is not installed in this environment, so the HNSW settings themselves are not exercised there): coverage counted 40 retrievable passages of 48 (an errored document's excluded); two back-to-back claims were disjoint and never touched the errored document's chunks; a passage at 3 attempts was skipped and the fewest-attempts passages came first; `authenticated` was refused EXECUTE on the claim; `semantic_search` returned nothing for a two-model library and for a wrong model, never an errored document's vector, and reported `eligible`; all seven probes were true on the first apply and again on a second (idempotent). After the review fixes the paste was re-run the same way: all nine probes true on the first apply and on a second; the marker writer set, patched and cleared the `embedBuild` key alone and changed nothing on a stale expectation or on a library with no marker; the toggles save kept the marker, dropped a forged `embedBuild` and was refused by RLS for a Viewer; the claim handed out nothing under another model; `leased` left out refused-out passages. After fix pass 2 (the `embed_retry_after` column and `waiting` count, the two covering coverage indexes) the paste was re-run once more on a scratch PostgreSQL 16 over the 20261014 `semantic_coverage`: all nine probes true on the first apply and on a second; two passages recorded as refused counted `waiting` 2 beside `leased` 2 and were not offered by the next claim until their wait expired; a clear under a stale expectation returned false (and one under the current expectation true, the toggles kept); both coverage counts planned as index-only scans of `knowledge_chunks_org_lib_doc_idx` / `knowledge_chunks_org_lib_doc_embedded_idx`.

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (inventory before apply: chunks and vectors; libraries holding more than one model; vectors whose model differs from the build payer's saved model, in total and per library; build markers, those older than 7 days and those naming no active member; chunks and vectors of documents not ready / indexing; after apply: the pgvector version and whether the iterative scan was enabled; the last row runs the recall check).

**Done-when.**
1. ✓ `embed_attempts` / `embed_error` on `knowledge_chunks`; the claim skips a passage after `EMBED_MAX_ATTEMPTS`.
2. ✓ A non-429 refusal of the input is bisected until the passage stands alone and charged once the request is known good (a sibling or the canary embedded); bad passages — one, several making up a whole batch, or a document longer than a batch — no longer block the rest ("the claim path splits the batch…", "two refused passages that make up a WHOLE batch…", "a refused document LONGER than one batch").
3. ✓ The build and the panel say "N passages could not be embedded" with document and page (to controllers; the count to everyone), and report the library done for the remainder (`embedStatusShape.test.ts` "SEM-4: refused passages are counted apart from remaining…"; `embedDrain.test.ts` "two refused passages…": `remaining: 0, failed: 2`). While a refused passage waits for its next try, the build says so ("…refused by the embeddings provider and will be retried…") and the drain reports "retrying", not "busy".
4. ✓ Every purchased vector is written even when one UPDATE fails ("a write that fails does not abandon the other vectors already paid for").

**Scope / residual.** Before 20261121 is applied the slice runs the original queue unchanged (reported as `queue: "legacy"`).

---

<a id="sem-5"></a>

## SEM-5 · Coverage and retrieval disagree about which chunks count — money is spent embedding passages semantic_search will never return

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-09-30, intelligence Round G).** Reproduced first: `semantic_coverage` (20261014) counted every chunk; `semantic_search` (20261007) joins `knowledge_documents` and keeps `status IN ('ready','indexing')`; `embedLibrarySlice` embedded chunks of any status. `20261121` re-creates `semantic_coverage` from 20261014 with lines added only — both counts keep `document_id IN (the org's documents that are ready or indexing)` (lineDiff pinned in `lib/__tests__/embedDrain.test.ts`) — and the embed queue (`embed_claim_batch`) applies the same predicate, so the denominator, the numerator, the work queue and the retrievable set are one population. `semantic_coverage_detail` uses it too. The panel states the definition: "Counted over the passages of documents that are indexed and searchable — the same passages meaning search can return." The SQL was run on a scratch PostgreSQL 16 with a stand-in `vector` type (a domain over `float8[]` and a cosine operator — pgvector is not installed in this environment, so the HNSW settings themselves are not exercised there): coverage counted 40 retrievable passages of 48 (an errored document's excluded); two back-to-back claims were disjoint and never touched the errored document's chunks; a passage at 3 attempts was skipped and the fewest-attempts passages came first; `authenticated` was refused EXECUTE on the claim; `semantic_search` returned nothing for a two-model library and for a wrong model, never an errored document's vector, and reported `eligible`; all seven probes were true on the first apply and again on a second (idempotent). After the review fixes the paste was re-run the same way: all nine probes true on the first apply and on a second; the marker writer set, patched and cleared the `embedBuild` key alone and changed nothing on a stale expectation or on a library with no marker; the toggles save kept the marker, dropped a forged `embedBuild` and was refused by RLS for a Viewer; the claim handed out nothing under another model; `leased` left out refused-out passages. After fix pass 2 (the `embed_retry_after` column and `waiting` count, the two covering coverage indexes) the paste was re-run once more on a scratch PostgreSQL 16 over the 20261014 `semantic_coverage`: all nine probes true on the first apply and on a second; two passages recorded as refused counted `waiting` 2 beside `leased` 2 and were not offered by the next claim until their wait expired; a clear under a stale expectation returned false (and one under the current expectation true, the toggles kept); both coverage counts planned as index-only scans of `knowledge_chunks_org_lib_doc_idx` / `knowledge_chunks_org_lib_doc_embedded_idx`.

Fix pass 2 (review minor): the retrievable-document filter reads `document_id`, which neither 20261011 count index carries, so both counts lost the index-only scans 20261011 / 20261014 added to keep the panel's poll inside its timeout during a rebuild — and the embed route answered any coverage failure (a timeout included) with 424 "needs migration 20260930". `20261121` adds `knowledge_chunks_org_lib_doc_idx (org_id, library_id, document_id)` and the same `WHERE embedding IS NOT NULL` (probed; scratch PostgreSQL 16: both counts plan as index-only scans), and the route tells a missing function (PGRST202 / 42883 → 424) from any other failure (503 "Couldn't read the meaning index's coverage just now … try again in a moment", which the panel shows as a status failure, not a migration) — `embedStatusShape.test.ts` "a failed coverage read is not a missing migration", `embedDrain.test.ts` "coverage stays index-only". The 20261011 pair is now redundant and is left in place.

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (inventory before apply: chunks and vectors; libraries holding more than one model; vectors whose model differs from the build payer's saved model, in total and per library; build markers, those older than 7 days and those naming no active member; chunks and vectors of documents not ready / indexing; after apply: the pgvector version and whether the iterative scan was enabled; the last row runs the recall check).

**Done-when.**
1. ✓ `semantic_coverage` and the embed queue apply the same document-status predicate as `semantic_search`.
2. ✓ Chunks of non-retrievable documents are excluded from the embed queue ("chunks of a document that is not ready / indexing are never claimed or paid for"); nothing is deleted (a re-ingest brings them back into range).
3. ✓ Coverage is defined against the retrievable population and the panel says so (`knowledgePageCopy.test.ts`).

**Scope / residual.** Vectors already paid for on errored documents stay (the inventory counts them); a re-ingest makes them retrievable again or replaces them.

---

<a id="sem-6"></a>

## SEM-6 · Linked reference libraries contribute zero semantic results whenever their corpus model differs from the asked library's

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** intelligence I-03 THE ASK ROUTE — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
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


**Partial (2026-09-30, intelligence Round G).** The resolution is the ask route's (`ask/route.ts:463-489`, I-03's file, which no other package edits). Landed for it: `resolveCorpusModel` + `planQueryEmbedding` (`lib/ai/embeddings.ts`, the shared helper the plan names) resolve each library's corpus model and the provider that must embed the query, per library; `semantic_coverage_detail` (20261121) gives each library's per-model vector counts in one read; `semantic_search` refuses a library holding another model and reports `eligible`. Tested per library: two libraries on two stamps each get their own plan (`lib/__tests__/embeddings.test.ts`).

**Done-when.**
1. ✗ `p_model` is still resolved once from the primary in the route — handed to I-03: resolve per searched library with `planQueryEmbedding(resolveCorpusModel(detail.models), connection)` and embed the query once per distinct (provider, model).
2. ✗ Reporting libraries that contributed no semantic rows is a route response change — handed to I-03 (the plan's reason is the report).
3. Partly — the helper's per-library test exists; the end-to-end route test is I-03's.

**Scope / residual.** Handed to I-03 with the helper.

**Resolution (2026-10-01, intelligence Round G, I-03).** Reproduced first (DEC-29): with the base route (`4dd0df7`) swapped back in, 53 of the 92 cases in the new `lib/__tests__/askRouteAcl.test.ts`, `askRouteHonesty.test.ts` and `askRouteUnits.test.ts` fail — every case named below as a reproduction among them — and the REGRESSION pin (an org under its cap, agreement signed, key saved: the same answer, citations, memory row and one metering row) passes on both. The ask route plans each searched library — linked ones included — on its own: `resolveCorpusModel` over its `semantic_coverage_detail`, then `planQueryEmbedding` for the provider and model that must embed the query. Libraries are grouped by (provider, model) and the query is embedded once per group; each library is searched with its own `p_model`. The response says how many libraries were searched by meaning and how many contributed rows (`meaningSearch: { libraries, searched, contributed, notes }`), with a note naming any library whose index exists but could not be searched.

Tests: `askRouteHonesty.test.ts` "SEM-6 / SEM-1 reproduction → fix: a linked library on another model is searched in ITS vector space — each library's own model, one embedding per model" (both libraries contribute; two embedding calls, one per model); the SEM-3 cases for a library that cannot be matched.

**Done-when.**
1. ✓ `p_model` is resolved per library.
2. ✓ Libraries that contributed no semantic rows are counted, and the ones that could not be searched are named.
3. ✓ Two libraries on two stamps both contribute, or the mismatch is surfaced.

**Scope / residual.** A linked library whose provider differs from the asker's embeddings key can only be reported, not searched (one key per member).

---

<a id="sem-7"></a>

## SEM-7 · No lock or claim anywhere in the embed path — concurrent drains re-embed the same passages and multiply spend on a third party's key

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-09-30, intelligence Round G).** Reproduced first, in a driven test: two overlapping slices over the unclaimed queue sent every passage to the provider twice (`embedDrain.test.ts` "reproduction: the unclaimed queue sends the same passages twice"). `20261121` adds `embed_claim_batch()` — `FOR UPDATE SKIP LOCKED` plus a 120-second lease (`embed_claimed_until`), service role only — and `embedLibrarySlice` takes every batch through it, so the browser build, every drain and the daily cron take DISJOINT passages ("two overlapping slices embed every passage exactly once"); an abandoned lease simply expires, so the resumability invariant holds. The write-back is conditional (`.is("embedding", null).select("id")`) and counts only rows it changed. The page-load nudge is debounced per tab (10 minutes, `lib/knowledge.ts` `nudgeEmbedDrain`, signature and fire-and-forget behaviour unchanged). A user-bearer trigger of `/api/cron/embed-drain` passes `minIntervalMs` (2 minutes): a library drained that recently is skipped ("recent"), so a burst of nudges costs one drain; the CRON_SECRET path and the maintenance cron call are unchanged. The "writes are not landing" guard now runs only for the pre-20261121 queue — the claim confirms each row it wrote, and concurrent progress by another driver only raises the count. The browser build waits (bounded) when every remaining passage is leased by another run instead of calling that stuck. Review fix: `semantic_coverage_detail.leased` counts only passages still claimable (`embed_attempts < p_max_attempts`), so a refused-out passage that keeps its lease no longer reads as "busy" — the drain no longer skips a library with claimable passages, and the build no longer waits on a background build that does not exist (scratch PostgreSQL 16: two claimed passages plus two refused-out ones still leased → `leased` 2). Fix pass 2: a passage refused once or twice still kept its lease and counted as `leased`, so a library whose last passages were refused read as "busy" and the panel said a background build was embedding them. A refusal now gives the lease back and sets `embed_retry_after` (20261121; the claim skips a passage before it), `semantic_coverage_detail` reports those passages as `waiting` — its return type changed, so the function is dropped first — the drain records "retrying" with the reason (never "busy"), the route's stale-schema-cache diagnosis counts them, and the browser build stops at once and says the passages were refused and will be retried (`embedDrain.test.ts` "the last passage refused once … 'retrying'", `embedStatusShape.test.ts` "SEM-4 — refused passages wait"). Scratch PostgreSQL 16 (stand-in `vector`): a claim of four, two recorded as refused → `leased` 2, `waiting` 2; the next claim offered neither waiting passage; after the wait expired both were claimed again. The SQL was run on a scratch PostgreSQL 16 with a stand-in `vector` type (a domain over `float8[]` and a cosine operator — pgvector is not installed in this environment, so the HNSW settings themselves are not exercised there): coverage counted 40 retrievable passages of 48 (an errored document's excluded); two back-to-back claims were disjoint and never touched the errored document's chunks; a passage at 3 attempts was skipped and the fewest-attempts passages came first; `authenticated` was refused EXECUTE on the claim; `semantic_search` returned nothing for a two-model library and for a wrong model, never an errored document's vector, and reported `eligible`; all seven probes were true on the first apply and again on a second (idempotent). After the review fixes the paste was re-run the same way: all nine probes true on the first apply and on a second; the marker writer set, patched and cleared the `embedBuild` key alone and changed nothing on a stale expectation or on a library with no marker; the toggles save kept the marker, dropped a forged `embedBuild` and was refused by RLS for a Viewer; the claim handed out nothing under another model; `leased` left out refused-out passages. After fix pass 2 (the `embed_retry_after` column and `waiting` count, the two covering coverage indexes) the paste was re-run once more on a scratch PostgreSQL 16 over the 20261014 `semantic_coverage`: all nine probes true on the first apply and on a second; two passages recorded as refused counted `waiting` 2 beside `leased` 2 and were not offered by the next claim until their wait expired; a clear under a stale expectation returned false (and one under the current expectation true, the toggles kept); both coverage counts planned as index-only scans of `knowledge_chunks_org_lib_doc_idx` / `knowledge_chunks_org_lib_doc_embedded_idx`.

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (inventory before apply: chunks and vectors; libraries holding more than one model; vectors whose model differs from the build payer's saved model, in total and per library; build markers, those older than 7 days and those naming no active member; chunks and vectors of documents not ready / indexing; after apply: the pgvector version and whether the iterative scan was enabled; the last row runs the recall check). Fix pass 3 (review minors):
- *A Rebuild did not revoke leases already handed out.* The write-back was conditional only on `embedding IS NULL`, so a batch in flight when a reset cleared every vector and lease wrote its old-model vectors into the rebuilt library. The rebuilder's build then met a model conflict and had to rebuild again. `embed_claim_batch` now returns its lease instant (`embed_claimed_until`; the 6-argument signature is dropped first because the return type changed, and the probe checks the result column). Every write a slice makes to a claimed passage is held to that instant: the vector (`heldBy` in `writeBack`), the refusal (`recordRefusal`, which charges nobody when voided) and the give-back (`release`, which never clears another driver's lease). A reset, which nulls every lease, and a newer claim by another driver both void a write still in flight. Tests in `embedDrain.test.ts`: "reproduction → fix: a Rebuild that clears every vector and lease while a batch is in flight — the batch's old-model vectors are NOT written into the rebuilt library", "a newer claim by another driver … voids this slice's write", "a refusal recorded after a Rebuild cleared the lease charges nobody". Each fails against the old write-back.
- *The stale-cache diagnosis relied on the read before the claim.* When another driver claimed the tail between the route's first read and its own claim, the build told a controller to run `NOTIFY pgrst`. The route now skips that diagnosis when every passage left is leased or waiting, either before the claim or after it (`heldElsewhere(detailBefore)` / `heldElsewhere(detailAfter)`). The response carries `busy`, and the build loop waits on it. Test in `embedStatusShape.test.ts`: "reproduction → fix: another driver claims the tail … never 'run NOTIFY pgrst'"; a genuinely empty claim still names the cache.

Scratch PostgreSQL 16 (fix pass 3, stand-in `vector` with text I/O, deleted afterwards): the paste over the previous draft of this file, with its old claim still installed, applied with all nine probes true, and so did a second apply. Without the new `DROP` of the 6-argument claim it fails with "cannot change return type of existing function". The claim returned one lease instant for its batch, in the future. After a reset, the write held to that instant changed 0 rows. The rebuilder's claim on another model took all four passages and its held write changed 4. The old lease's write still changed 0.

**Done-when.**
1. ✓ A claim with a lease makes concurrent drains disjoint.
2. ✓ `nudgeEmbedDrain` is debounced per tab session.
3. ✓ by replacement, not as written. The user-bearer triggers themselves are not rate-limited: each one still runs and reads the marker list. A per-library throttle replaces the rate limit (`USER_TRIGGER_MIN_INTERVAL_MS`): a library drained in the last 2 minutes is skipped, so a burst of triggers costs at most one drain per library, and two that still overlap stay disjoint through the claim. That bounds the spend, which is the finding's harm. It does not bound request volume (fix pass 5 wording; the code is unchanged).
4. ✓ The guard no longer misreports concurrent progress.

**Scope / residual.** The throttle is keyed on the library's last drain rather than on the user (the server keeps no per-user state); what it bounds is the spend, which is the finding's harm. Every user nudge still reads the marker list before the per-library throttle applies, so done-when 3 is met per library, not per user, and request volume is not bounded. This wording was made exact in fix pass 4.

---

<a id="sem-8"></a>

## SEM-8 · Nothing re-arms the index after ingestion — coverage silently decays from 100% every time a document is added

- **Severity:** LOW
- **Status:** RESOLVED
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


**Resolution (2026-09-30, intelligence Round G).** Reproduced first: the only stamp setter was the manual build; the route and the drain cleared the stamp at 100%; ingestion never re-armed it. Ingestion is I-06's code, so the re-arm lives on the consent side: a controller can tick "Keep this index current as documents are added" (`action: "keep-current"`, `lib/knowledge.ts` `setKeepIndexCurrent`) — a STANDING consent on the stamp (`standing: true`), on the caller's own key and monthly cap, after the agreement gate. A standing stamp survives 100% (the route marks `completedAt`; the drain reports "current") and every later run embeds passages added by ingestion or the source-sync mirror with no button pressed; unticking withdraws it. For everyone, the drift is on the page where questions are asked: `meaningIndexDrift` renders "Meaning search covers 71% of this library — 12 passages don't carry a meaning vector yet and are found by keyword only" by the Ask box (no role gate), from the panel's live status — neutral words (review fix), because the same shortfall follows passages added since a build and a first build stopped part-way. Review fixes to the consent: (a) saving Library AI setup no longer erases the standing consent that shares its JSON column — `knowledge_library_save_ai_features` (20261121, invoker, the caller's RLS decides) replaces every toggle EXCEPT `embedBuild` in one statement and `saveLibraryAiFeatures` calls it (before 20261121 it reads the marker and carries it over; a save that changed no row is an error, never a silent success); every marker write goes through `embed_build_marker_write` (20261121, service role), which touches the `embedBuild` key alone, so a drain never reverts a toggle saved while it ran. (b) A Rebuild clears ANOTHER member's consent — standing or a plain build — before the vectors are cleared, and the Rebuild dialog says so first, so a standing consent never pays for a full rebuild someone else started; the payer's running drain stops before its next batch (`SEM-11`). The caller's own consent is kept. Tests: `embedDrain.test.ts` ("passages added later are embedded by the next run on the same consent"), `embedStatusShape.test.ts` ("SEM-8: adding chunks to a completed library produces a visible not-covered state"), `knowledgePageCopy.test.ts`.

Fix pass 2 (review minor): the Rebuild's clear of another member's consent is conditional on the consent it read, but the marker writer reported success whenever the call did not error — also when it matched nothing because the other member had renewed their consent in between — so the route said `backgroundCleared: true`, cleared every vector, and the renewed consent re-embedded the whole library on their key. `writeMarker` now returns whether a row changed (`embed_build_marker_write`'s boolean; the pre-20261121 fallback likewise), `clearEmbedBuildMarkerIf` exposes it, and the reset reads the marker again and retries the clear once when it matched nothing; a consent still moving refuses the Rebuild with 409 before any vector is touched, a marker it cannot read refuses it with 500, and `backgroundCleared` is reported only when a row changed (`embedStatusShape.test.ts` "a Rebuild whose clear matched nothing … reads it again and clears THAT one", "a consent that keeps moving refuses the Rebuild (409) BEFORE any vector is cleared", "reproduction: the marker writer said 'success' for a conditional clear that changed nothing").

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (the two marker-safe writers, `embed_build_marker_write` and `knowledge_library_save_ai_features`). Fix pass 3 (review minors):
- *"A plain build never replaces another member's standing consent" was a read followed by an unconditional write.* A standing consent recorded between the two was overwritten. `setEmbedBuildMarker` now makes its write conditional on the marker it read. If it read no marker, it passes `NO_MARKER`, and `embed_build_marker_write` treats `''` as expecting none (`COALESCE(stored, '') = expected`, in the whole-blob fallback too). A write that no longer applies re-reads once and applies the same standing rule; a consent that keeps moving is reported, never silently lost.
- *"Stop it" and "keep current" off reported success when their conditional clear matched nothing.* The toast said "Background build stopped" while a consent recorded in between kept spending. Both now use checked writes (`clearEmbedBuildMarkerIf`, and the new `patchEmbedBuildMarkerIf`) and answer 409 (`released: false, changed: true` / `changed: true`) when nothing was applied. The panel shows that as an error.

Tests in `embedStatusShape.test.ts` "review fix pass 3 — a consent write that did not land is never reported as done" (seven cases, each failing against the old code). Scratch PostgreSQL 16: `embed_build_marker_write(…, '', NULL)` set a marker on a library with none (true), refused on a library holding one (false), and still applied under a matching expectation.

Fix pass 4 (2026-09-30, review):
- *Major: an unreadable marker was reported as "nothing to stop" or "withdrawn".* The route's `readMarker` dropped the read error, so a failed read looked like "no marker". "Stop it" then answered 200 `{ released: false }` and "keep current" off answered 200 `{ standing: false }`. The panel's `act` showed a success toast for any answer ("Background build stopped." / "No longer kept current in the background.") while the consent kept spending. Release and keep-current now read through `readEmbedBuildMarker` and answer 500 when the read fails (`{ standing: null }` on keep-current); `readMarker` remains only for the status display and the finished build's tidy-up, where a failed read writes nothing. The panel's toast is now what the route answered: `releaseOutcome`, `keepCurrentOutcome(out, asked)` and `retryOutcome` (`lib/knowledge.ts`). `{ released: false }` is an "info" toast ("nothing was stopped"), never "stopped". A consent flag other than the one asked for is an error. "Try them again" with nothing requeued says so. Tests: `embedStatusShape.test.ts` "review fix pass 4 — an unreadable consent is never reported stopped or withdrawn (DEC-59 (5))". Its two reproductions fail against the old route.
- *Minor (the GOV-14 limb): any controller could forge the consent with a direct PostgREST write.* `knowledge_libraries_write` is FOR ALL `is_org_controller`, so an Admin or Doc Control could PATCH `ai_features.embedBuild` to name any active member with `standing: true`. The drain would then spend that member's key and cap on every run, and a standing consent survives 100%. `20261121` now adds `trg_knowledge_libraries_embed_build_guard` (BEFORE INSERT OR UPDATE OF `ai_features`, `knowledge_libraries_embed_build_guard()`, invoker, `search_path` pinned). It refuses any change to the `embedBuild` key — set, edited, removed, or carried in on a new row — unless `auth.role()` is `service_role` (the embed route and the drain, through `embed_build_marker_write`). A session with no request role (the SQL editor) is let through. `knowledge_library_save_ai_features` keeps the stored marker byte for byte, so saving Library AI setup never trips it. The paste gains a probe and two inventory rows: standing consents that exist before apply, which cannot be told apart from a forged one; and other BEFORE INSERT / UPDATE triggers on the table. Scratch PostgreSQL 16, with the section applied twice (probe true both times): a controller's forge on a library without a marker, an edit of the payer, a removal by PATCH, and an INSERT carrying a marker were all refused (`insufficient_privilege`). The toggles save kept the marker. A toggles-only PATCH on a library without a marker, a plain INSERT and an `ai_instructions` update all went through. A Viewer's save changed nothing. The service role's set / patch / clear all applied. `embed_build_marker_write` stayed unexecutable by `authenticated`. The SQL editor's repair went through. Shape test: `embedDrain.test.ts` "review fix pass 4 (SEM-8 / GOV-14 limb): only the service role changes the consent marker". `GOV-14` itself is I-05's record and is not edited here. This closes its "a controller hand-edits the consent" limb at the database; the drain's uuid / active-member check landed earlier (`SEM-11`).

**Done-when.**
1. ✓ A standing per-library consent keeps the stamp armed, so ingestion's new passages are picked up by the next drain; without it, the not-covered state is visible (2).
2. ✓ The drift is shown on the library page by the Ask box, not only inside the panel.
3. ✓ Non-controllers see the drift line and the panel's bar.
4. ✓ A test adds chunks to a completed library and asserts the not-covered state and its words. The standing consent survives a Library AI save and a Rebuild by another member ends it without a cent on its key: `embedStatusShape.test.ts` ("SEM-8 — saving Library AI setup never erases the standing consent", "a Rebuild ends ANOTHER member's standing consent first — the drain then spends nothing on their key"), `embedDrain.test.ts` ("the drain never writes the whole ai_features blob…").

**Scope / residual.** The stamp is JSON on `knowledge_libraries.ai_features`; before 20261121 is applied its writers fall back to the old whole-column write (the save still carries the marker over), and the drain's claim and detail reads fall back likewise. `components/knowledge/LibraryAiModal.tsx` is unchanged — the protection is in `saveLibraryAiFeatures`. Standing consents recorded before `20261121` is applied cannot be told from one a controller wrote directly; the paste counts them so they can be read before relying on them (fix pass 4).

---

<a id="sem-9"></a>

## SEM-9 · One global HNSW index, four post-filters and no ef_search — filtered semantic search can return far fewer rows than asked, or none

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** the user — paste 20261121 and send back its recall row; no code is owed until then — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
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


**Partial (2026-09-30, intelligence Round G).** (Fix pass 2: this was recorded RESOLVED while done-when 4 was only reported, not asserted; it stays OPEN until the recall row below is read back.) SUSPECTED, and the magnitude is not observable here (no pgvector, no production-sized table); the mechanism is pgvector's documented behaviour — HNSW walks `ef_search` (default 40) candidates BEFORE the WHERE filters — and nothing in the repo raised it (grep: no `ef_search`). `20261121` re-creates `semantic_search` from 20261007 with lines added only (lineDiff pinned in `embedDrain.test.ts`): `SET hnsw.ef_search = 200`, and — chosen by a DO block from `pg_extension`, because an older pgvector reserves the `hnsw.` prefix without it and would refuse the paste — `SET hnsw.iterative_scan = strict_order` on pgvector 0.8 or later, which keeps scanning until the filters are satisfied, in exact distance order. A new result column `eligible` reports how many vectors the org / library / model filters admit, so a short result can be told from a thin corpus. The function is dropped and re-created (the return type changed) and its grants re-stated — to `authenticated` and, explicitly, to `service_role`, the ask route's role (review fix: a drop takes the old grants with it and default privileges depend on the role that runs the paste; the paste now probes service_role's EXECUTE on `semantic_search`, `semantic_coverage_detail` and `semantic_coverage`). The paste's last row is a recall check: on the largest single-model library, one of its own vectors as the query, top 12 from the new search against an exact scan of the same filtered population (`ORDER BY (embedding <=> q) + 0` keeps the planner off the index). The SQL was run on a scratch PostgreSQL 16 with a stand-in `vector` type (a domain over `float8[]` and a cosine operator — pgvector is not installed in this environment, so the HNSW settings themselves are not exercised there): coverage counted 40 retrievable passages of 48 (an errored document's excluded); two back-to-back claims were disjoint and never touched the errored document's chunks; a passage at 3 attempts was skipped and the fewest-attempts passages came first; `authenticated` was refused EXECUTE on the claim; `semantic_search` returned nothing for a two-model library and for a wrong model, never an errored document's vector, and reported `eligible`; all seven probes were true on the first apply and again on a second (idempotent). After the review fixes the paste was re-run the same way: all nine probes true on the first apply and on a second; the marker writer set, patched and cleared the `embedBuild` key alone and changed nothing on a stale expectation or on a library with no marker; the toggles save kept the marker, dropped a forged `embedBuild` and was refused by RLS for a Viewer; the claim handed out nothing under another model; `leased` left out refused-out passages. After fix pass 2 (the `embed_retry_after` column and `waiting` count, the two covering coverage indexes) the paste was re-run once more on a scratch PostgreSQL 16 over the 20261014 `semantic_coverage`: all nine probes true on the first apply and on a second; two passages recorded as refused counted `waiting` 2 beside `leased` 2 and were not offered by the next claim until their wait expired; a clear under a stale expectation returned false (and one under the current expectation true, the toggles kept); both coverage counts planned as index-only scans of `knowledge_chunks_org_lib_doc_idx` / `knowledge_chunks_org_lib_doc_embedded_idx`.

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (inventory before apply: chunks and vectors; libraries holding more than one model; vectors whose model differs from the build payer's saved model, in total and per library; build markers, those older than 7 days and those naming no active member; chunks and vectors of documents not ready / indexing; after apply: the pgvector version and whether the iterative scan was enabled; the last row runs the recall check). Fix pass 3 (review minor): `eligible` counted the library's vectors filtered by `org_id`, which no index on the model column carries, on every call. For one library it is now counted by `library_id` alone (`CASE WHEN p_library_id IS NOT NULL …`). A library belongs to one org, and a row is only returned for a library of `p_org_id`. The org-wide count runs only when no library is given. On a scratch PostgreSQL 16 with 200,000 vectors, the old predicate under a generic plan (how a non-inlined SQL function plans) was a parallel sequential scan of the whole table (3,432 buffers). The new library branch is an index-only scan of `knowledge_chunks_library_model_idx` (84 buffers), and the org branch is never executed. The counts were unchanged: 4 for the library, 4 org-wide, and no rows for another org's library. The lineDiff in `embedDrain.test.ts` pins the new lines and asserts no `org_id` in the library branch.

**Done-when.**
1. ✓ `hnsw.ef_search` raised on the search path (a function-level SET), and the iterative scan where pgvector supports it.
2. ✓ Evaluated and not done: a per-model partial HNSW index cannot be matched against `p_model` (a parameter of a non-inlined function); partitioning per org is a table rewrite outside this finding's scope — recorded in the migration header.
3. ✓ `semantic_search` reports `eligible`. Reading it on the answer is the ask route's (I-03).
4. ✗ Not done — reported, not asserted: the paste's last row reports recall@12 of the new search against an exact scan, from ONE self-query of the largest single-model library (ok NULL; "n/a" before any library has vectors). No probe fails on a low recall, and it cannot be run here (no pgvector). The stated threshold: recall@12 of 0.90 or better on that row closes this finding; below 0.90 (or "n/a" once vectors exist) it stays open for a per-library index or partitioning.

**Scope / residual.** Stays OPEN on done-when 4: whether recall was actually short in production — and whether the settings above fixed it — is only known from the paste's recall row, read back after `20261121` is applied (threshold 0.90). Done-when 1–3 landed.

---

<a id="sem-10"></a>

## SEM-10 · Query-side embedding tokens are never metered — contradicting the module's own stated contract

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G, I-03).** Reproduced first (DEC-29): with the base route (`4dd0df7`) swapped back in, 53 of the 92 cases in the new `lib/__tests__/askRouteAcl.test.ts`, `askRouteHonesty.test.ts` and `askRouteUnits.test.ts` fail — every case named below as a reproduction among them — and the REGRESSION pin (an org under its cap, agreement signed, key saved: the same answer, citations, memory row and one metering row) passes on both. Query embeddings are metered like every other call: the route embeds through `embedPassages({ kind: "query" })`, which returns the provider's usage, behind `assertAiGates({ op: "knowledgeEmbed", key: "embedding" })` (the embeddings allowlist, the agreement, the cap). Each embedding call reserves its worst case first and settles its real tokens into one `ai_usage_events` row per embedding model per ask (`op: knowledgeEmbed`); the one monthly cap reads every op (`DEC-73` item 1), and the response's `budget` includes it. A library with no stamped vector buys no query embedding, and without an embeddings key no library's index is read at all.

Tests: `askRouteHonesty.test.ts` "SEM-10: query embeddings are metered (their own line, the one cap reads it); a library with no vectors buys none", and "GOV-6 limb: an embeddings key on a provider off the allowlist is never spent".

**Done-when.**
1. ✓ The query embedding returns usage and the route folds it into a metered total.
2. ✓ Query-embedding spend appears in `ai_usage_events` (its own op, read by the cap).
3. ✓ An ask over a library with zero embedded chunks skips the query embedding.
4. ✓ A test asserts the metering row covering the embedding calls.

**Scope / residual.** None.

---

<a id="sem-11"></a>

## SEM-11 · Six stuck libraries permanently starve the drain: `.limit(6)`, no ordering, and markers that are never cleared on cap-reached or error

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-09-30, intelligence Round G).** Reproduced first: the drain read `.not("ai_features->embedBuild","is",null).limit(6)` with no order, and a capped library kept its slot every run (the verifier's correction stands: the slice-error exit did reach the clear — it was the cap exit that held a slot). `lib/knowledgeEmbedDrain.ts` now reads EVERY marked library (paged, ordered by id) and works them least-recently-drained first (`lastDrainAt` on the stamp, `orderDrainQueue`). A library that cannot proceed records why and when to look again instead of holding a slot: the monthly cap until the 1st of next month (NOT released — that would abandon a paid-for build, as the verifier noted), a provider / key error with a backoff doubling from 15 minutes (capped at a day) and a release after `MAX_ERROR_RUNS` (5) failed runs, a model conflict or an unsigned agreement for an hour; a consent it could not verify (the membership read failed) is skipped for that run with no hold written and asked again on the next — never released. Each run reports every library as advanced / complete / current / blocked / released / busy / recent / starved (the budget ended before it). The panel shows a stuck build to an admin: whose key pays, when it last ran, what it waits for and until when, with "Stop it" (`action: "release"`, the payer or a controller). Tests: `embedDrain.test.ts` ("six capped libraries hold with a date and the seventh is drained in the same run", backoff and release, starved, recent, busy), `embedStatusShape.test.ts` ("SEM-11: the background build's state"). The SQL was run on a scratch PostgreSQL 16 with a stand-in `vector` type (a domain over `float8[]` and a cosine operator — pgvector is not installed in this environment, so the HNSW settings themselves are not exercised there): coverage counted 40 retrievable passages of 48 (an errored document's excluded); two back-to-back claims were disjoint and never touched the errored document's chunks; a passage at 3 attempts was skipped and the fewest-attempts passages came first; `authenticated` was refused EXECUTE on the claim; `semantic_search` returned nothing for a two-model library and for a wrong model, never an errored document's vector, and reported `eligible`; all seven probes were true on the first apply and again on a second (idempotent). After the review fixes the paste was re-run the same way: all nine probes true on the first apply and on a second; the marker writer set, patched and cleared the `embedBuild` key alone and changed nothing on a stale expectation or on a library with no marker; the toggles save kept the marker, dropped a forged `embedBuild` and was refused by RLS for a Viewer; the claim handed out nothing under another model; `leased` left out refused-out passages. After fix pass 2 (the `embed_retry_after` column and `waiting` count, the two covering coverage indexes) the paste was re-run once more on a scratch PostgreSQL 16 over the 20261014 `semantic_coverage`: all nine probes true on the first apply and on a second; two passages recorded as refused counted `waiting` 2 beside `leased` 2 and were not offered by the next claim until their wait expired; a clear under a stale expectation returned false (and one under the current expectation true, the toggles kept); both coverage counts planned as index-only scans of `knowledge_chunks_org_lib_doc_idx` / `knowledge_chunks_org_lib_doc_embedded_idx`. Review fixes: a count the drain could not read is unknown, never 0 — `unembeddedCount` answers null when both reads fail and the drain then holds off with the stamp kept (it used to release a plain stamp as "complete", before and after a slice); every write to a stamp is conditional on the stamp the run read (`embed_build_marker_write`'s `p_expect_user` / `p_expect_at`, 20261121), so a run never books its hold against, or clears, a consent recorded after it looked; the consent is re-read before every batch (`embedLibrarySlice`'s `beforeBatch`), so a Stop or another member's Rebuild ends a running drain after the batch in flight; a model conflict that appears mid-run is held with the run's own count. Tests: `embedDrain.test.ts` ("DEC-59 (5) — a count the drain could not read is unknown, never 0", "SEM-8 / SEM-11 — the consent is re-read before every batch").

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (inventory before apply: chunks and vectors; libraries holding more than one model; vectors whose model differs from the build payer's saved model, in total and per library; build markers, those older than 7 days and those naming no active member; chunks and vectors of documents not ready / indexing; after apply: the pgvector version and whether the iterative scan was enabled; the last row runs the recall check).

**Done-when.**
1. ✓ Least-recently-attempted first (`lastDrainAt`), over every marker — no window.
2. ✓ Cap-reached and failing libraries record a backoff the queue skips; repeated failure releases the stamp.
3. ✓ Results distinguish advanced, blocked (with the reason), starved and the rest.
4. ✓ A stuck-marker library surfaces on the panel with its reason and a Stop control. Fix pass 4: Stop answers 500 when it cannot read the marker, and the panel shows "stopped" only for `{ released: true }` (detail on `SEM-8`).

**Scope / residual.** The drain still rides the daily maintenance cron plus page nudges — no `vercel.json` entry (99 Do-not; `lib/__tests__/vercelConfig.test.ts`).

---

<a id="sem-12"></a>

## SEM-12 · The one signal that tells an asker retrieval was keyword-only is computed and never rendered — partial coverage degrades answers with zero indication

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** intelligence I-03 THE ASK ROUTE — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
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


**Partial (2026-09-30, intelligence Round G).** Reproduced first (no component read `retrieval`). The page now renders it on every library answer, for every reader: `lib/knowledge.ts` `describeRetrieval(retrieval, coverage)` reads the answer's flag WITH the meaning index's coverage — the route's own figure first (`retrievalCoverage`, typed and rendered when the route sends it), otherwise the asked library's live coverage from the panel — so "hybrid" over a 3% index reads "Meaning search covers 3% of this library — passages without a meaning vector were found by keyword only" while a full index reads plainly, and "Keyword search only" says meaning search did not run and why. The chip sits in the answer card's footer (`data-retrieval`), the note directly above the sources strip (`data-retrieval-note`); neither is gated on a role. A replayed answer carries no flag and shows no chip (its "Replayed from your team's record" banner already says it was not searched now).

**Done-when.**
1. ✓ The answer surface renders the retrieval mode, for non-controllers too.
2. Partly — 3% and 100% are distinguishable on the answer for the ASKED library (its live coverage); ✗ the per-answer figure over every library actually searched, linked ones included, has to come from the ask route (I-03's file): the type (`retrievalCoverage: { embedded, total }`) and the renderer are ready and preferred when present.
3. ✓ Below 95% coverage the answer shows "meaning search covers N% of this library" next to the sources strip.
4. ✓ as far as the suite goes: `lib/__tests__/knowledgePageCopy.test.ts` pins the chip and note to the rendered elements and asserts the wording at 3%, 94%, 95% and 100% (the suite has no DOM renderer).

**Scope / residual.** Handed to I-03: send `retrievalCoverage` for the libraries searched.

**Resolution (2026-10-01, intelligence Round G, I-03).** The route half. Reproduced first (DEC-29): with the base route (`4dd0df7`) swapped back in, 53 of the 92 cases in the new `lib/__tests__/askRouteAcl.test.ts`, `askRouteHonesty.test.ts` and `askRouteUnits.test.ts` fail — every case named below as a reproduction among them — and the REGRESSION pin (an org under its cap, agreement signed, key saved: the same answer, citations, memory row and one metering row) passes on both. The ask response carries `retrievalCoverage: { embedded, total }` summed over EVERY library searched (linked ones included) whenever the database can say it for each (`semantic_coverage_detail`, `20261121`), and the page's `describeRetrieval` already prefers it. *Overstated until fix pass 4 (review minor):* the route read each library's coverage only for an asker with an allowed embeddings key, so a keyword-only asker got `coverage: null` for every library and no `retrievalCoverage` even on a fully migrated database — the page then fell back to the asked library's live coverage and left the linked ones out. Now `loadEmbedDetail` is read for every searched library whatever the key (a database count, no provider call); the plan stays `no_key`, nothing is embedded, and the keyword-only answer's note covers every library searched. Fix pass 5 (review minor): that read (`semantic_coverage_detail`, an aggregate over every chunk of the library with a 25 s statement timeout) was awaited for every keyword-only asker before round 1 searched anything, though nothing before the response uses its count. For a `no_key` plan it now starts without being awaited, runs alongside the searches, and is awaited only when the response is built (a failure reads as no coverage). A key holder still reads it before planning, because `SEM-1` needs the corpus model. `retrieval` itself now means a meaning-found passage is in the final pool (`ASK-10`).

Tests: `askRouteHonesty.test.ts` (the SEM-6 case asserts `retrievalCoverage` `{ embedded: 2, total: 2 }` over two libraries; the SEM-10 case `{ embedded: 0, total: 3 }`; fix pass 4: "SEM-12 reproduction → fix (fix pass 4): an asker with NO embeddings key still gets the meaning index's coverage over every library searched — linked ones included — and nothing is embedded", `{ embedded: 2, total: 4 }` over two libraries, which fails against fix pass 3's route, `f93fe4e`; fix pass 5: "SEM-12 reproduction → fix (fix pass 5): without an embeddings key the coverage read is off the critical path — round 1's keyword search never waits for it, and the response still carries it" (a slow coverage read answers after the first keyword search; it answered before with `b787168`), and its control "with an embeddings key the coverage is read BEFORE planning (SEM-1 needs the corpus model), as before"); `knowledgePageCopy.test.ts` (the renderer, unchanged).

**Done-when.**
1. ✓ (2026-09-30) Rendered for every reader.
2. ✓ The per-answer coverage over every library actually searched comes from the route — for every asker, with or without an embeddings key (fix pass 4; until then only for askers with one).
3. ✓ (2026-09-30) The "covers N%" note below 95%.
4. ✓ (2026-09-30) The rendered elements.

**Scope / residual.** A database before `20261121` sends no `retrievalCoverage`; the page then uses the asked library's live coverage, as before.

---

<a id="sem-13"></a>

## SEM-13 · Two different, both-wrong prices for the same rebuild: the panel quotes 1¢/1k flat, the ledger charges Voyage at 10× the real rate

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Partial (2026-09-30, intelligence Round G).** SUSPECTED; reproduced as far as the repo goes: the panel quoted `CENTS_PER_1K_PASSAGES = 1` for every model while the ledger bills `estimateCostUsd(model, usage)` from `lib/ai/pricing` — the two disagree by model (for 1,000 passages of ~1,400 characters the ledger rate is ~0.7¢ on text-embedding-3-small, ~4.8¢ on text-embedding-3-large and ~7.3¢ on the Voyage placeholder, against the flat 1¢). The flat constant is gone. The embed status returns `estimate: { model, remainingUsd, fullUsd, placeholderRate }`, computed by `estimateEmbeddingCostUsd` (`lib/ai/embeddings.ts`) — `estimateCostUsd`, the SAME function the ledger uses — over the library's real character volume (`semantic_coverage_detail.remaining_chars` / `total_chars`, 20261121) for the model the caller would build with; the panel shows it on Build and Rebuild ("~8¢", "~$18.25", "under 1¢") and marks Voyage figures "estimate — this provider's rate in the app is a conservative placeholder". The package decision `DEC-59` (4).

**Pending migration:** `supabase/migrations/20261121_intel_roundG_semantic_layer.sql` (inventory before apply: chunks and vectors; libraries holding more than one model; vectors whose model differs from the build payer's saved model, in total and per library; build markers, those older than 7 days and those naming no active member; chunks and vectors of documents not ready / indexing; after apply: the pgvector version and whether the iterative scan was enabled; the last row runs the recall check).

**Done-when.**
1. ✓ The estimate is computed from the connection's model through the ledger's price table and the library's actual character volume.
2. ✓ *Recorded by the integrator at the I-05 merge (2026-10-01):* I-05 (`GOV-6`, `DEC-73` item 4) priced the three Voyage models the picker offers from Voyage's published list (`lib/ai/pricing.ts`: `voyage-3.5-lite` 0.02, `voyage-3.5` 0.06, `voyage-3-large` 0.18 per million tokens; any other Voyage model falls to the conservative `voyage-` family row), pinned in `aiPricing.test.ts`. The panel's "conservative placeholder" label followed in the same merge: `embeddingRateIsPlaceholder` (`lib/ai/embeddings.ts`) is true only for a Voyage model that falls to the family row (`matchedPricePrefix`, `lib/ai/pricing.ts`), so the three named models are quoted as the estimates they are, at their real rate. Tests: `embeddings.test.ts` and `embedStatusShape.test.ts` ("SEM-13 …"); both fail against the old label.
3. ✓ The quoted estimate and the ledger's figure come from one function (`estimateCostUsd`).
4. ✓ `lib/__tests__/embeddings.test.ts`: for every offered model the estimate equals `estimateCostUsd` at the estimated tokens (exact), and the stated tolerance of the 4-characters-a-token estimate against a provider's own count is within 30% for ordinary prose.

**Scope / residual.** None. RESOLVED at the I-05 merge (2026-10-01): every done-when holds.

---
