# 09 · Link proposals & connection skills

**13 findings** — 4 HIGH · 9 MEDIUM.

Candidate generation, false positives, and who may accept.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Candidate generation is genuinely bounded by shared keys, not pairwise — documents only meet through a shared tag, drawing ref, or alias, and it is tested with a 200-document/200-distinct-tag case asserting zero pairs | `lib/linkProposalLogic.ts:6-8, 126-157; lib/__tests__/linkProposalLogic.test.ts:153-157` | This is the single design decision that keeps the engine from dying at scale (the file's own comment: "1,500 documents is 1.1M pairs, which is how these systems die"). Every fix above must preserve it; do not replace it with an embedding-similarity sweep that reintroduces O(n²). |
| The ambiguity ladder in proposeOpcContinuity is correct and well tested: one owner → provable, two → strong with the count in the evidence detail, three or more → silence | `lib/linkProposalLogic.ts:71-99; lib/__tests__/linkProposalLogic.test.ts:25-63` | This is the reasoning a PSM auditor would want to see, and it already exists. The auto-apply write is broken, not the decision — fix the write, leave the ladder alone. |
| Alias load-bearing detection: a pair is credited to the 'alias' proposer only when NO shared tag matched canonically on both sides, so review sees when a human-taught nickname is the sole reason two documents met | `lib/linkProposalLogic.ts:137-157; lib/__tests__/linkProposalLogic.test.ts:125-151` | Subtle and correct — it distinguishes "these share equipment" from "these share equipment because someone told us 'the north furnace' means F-101". That distinction is exactly what a reviewer needs and it would be easy to lose in a refactor. |
| flagLostEvidence never flags on missing data — a document that has not been re-extracted is treated as unknown, not as changed, and the link is marked rather than deleted | `lib/linkProposerServer.ts:481-516 (see :502-505)` | The correct failure posture for a regulated system: it degrades to silence rather than to a false claim, and it never destroys a human-visible link. This is the pattern the stale-proposal handling should have copied and did not. |
| Reasoning Skills correctly scope private packs to their author, with a test asserting a teammate's private skill never enters the prompt | `lib/answerSkillsServer.ts:29-32; lib/__tests__/linkProposalLogic.test.ts:304-318` | It is the working reference implementation of the visibility rule that Connection Skills are missing (finding 6) — the fix has a proven shape to copy inside this same codebase. |
| Approving a proposal writes the same row shape a manual pin writes, plus provenance columns — same table, same kind, same label/sort_order — so the applied web is one homogeneous thing | `lib/linkProposals.ts:111-125 vs lib/relatedResources.ts:65-76` | There is no shadow 'AI links' table to reconcile. The provenance columns (origin/proposer/evidence/approved_by) ride on top rather than forking the model — worth protecting when fixing the direction asymmetry. |
| The graph filters ghost (proposed) edges against nodes that already came through RLS, so it does not leak proposals for documents the viewer cannot see | `app/(protected)/graph/page.tsx:176-178 — `proposals.filter((e) => ids.has(e.a) && ids.has(e.b))`` | Proves the visibility rule is understood in the codebase and is enforceable at the render layer; it isolates finding 5 to direct table reads rather than making it a systemic design gap. |
| The 'why nothing was found' diagnostic maps each empty input to the concrete next step that would feed it, so a silent run explains itself instead of looking broken | `app/(protected)/admin/proposed-links/page.tsx:53-80, 194-213; lib/linkProposerServer.ts:33-45` | Unusually good operator empathy and the right place to extend for the truncation problem (finding 9) — it needs ceilings added alongside zeroes, not a rewrite. |
| compileSkillPatterns fails soft: a bad pattern is collected as an error string and reported, never thrown mid-run, and patterns that match empty text are rejected outright | `lib/linkProposalLogic.ts:254-272; lib/__tests__/linkProposalLogic.test.ts:214-219` | The error-collection structure is exactly where a complexity/backtracking guard belongs (finding 4) — the plumbing to report a rejected pattern to the author already exists and is already wired to the Studio's live tester. |


---


<a id="lnk-1"></a>

## LNK-1 · 'stale' and 'dismissed' share one permanent blacklist: publishing a new revision retires pending proposals and then blocks them from ever being re-proposed — the exact opposite of the stated contract

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposerServer.ts:375-385`, `lib/linkProposals.ts:181-194`, `lib/postPublish.ts:129-134`, `app/(protected)/admin/proposed-links/page.tsx:280-283`, `lib/linkProposalLogic.ts:402-412`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and nothing anywhere reverses it: grep over the repo shows proposed_links.status is only ever written to 'stale' (linkProposals.ts:186, linkProposerServer.ts:463) or decided by a human, never back to 'pending'. The upsert at linkProposerServer.ts:423-425 would refresh the row, but filterDrafts removes the draft before it can reach the queue, so the publish that was supposed to re-open the pair is exactly what seals it.

**Mechanism.** At publish time, `staleProposalsForDocument` flips every pending proposal touching the document whose `source_rev` differs from the new rev to `status:'stale'` (linkProposals.ts:185-190), fired from postPublish.ts:132. Its docstring says the evidence "was read off text that is no longer current" — i.e. re-derive it from the new revision.
But the proposer's dismissal memory does not distinguish stale from dismissed:

  for (const r of priors) {
    if (r.status === "pending") continue; // refreshed below, not blocked
    decided.add(`${r.document_id}|${r.target_document_id}`);
  }                                        // linkProposerServer.ts:380-383

'approved', 'dismissed' AND 'stale' all land in `decided`, and `filterDrafts` drops any draft whose pair is in `decided` (linkProposalLogic.ts:408-411). There is no re-open path: nothing anywhere sets a stale row back to 'pending' (see the full writer list for proposed_links — only listProposals/count/update-approve/update-dismiss/update-stale/select). The `proposed_links_pair_idx` upsert at :425 would happily flip it back to pending, but `filterDrafts` removes the draft before it ever reaches the write.

**Failure scenario.** Sheet 44-PID-012 rev 3 is published. The engine queues "Both reference 6 of the same equipment items" linking it to the datasheet — tier strong, source_rev '3'. Before anyone reviews it, drafting publishes rev 4 (a title-block correction that changed nothing about the equipment). postPublish stales the proposal. Extraction re-runs on rev 4 and finds the same six tags. The next "Find connections" recomputes the identical draft, `decided` contains `44pid012|datasheet` because of the stale row, `filterDrafts` drops it. That pair can never be proposed again by any skill, for the life of the org — and no human ever saw it. Meanwhile the review page tells the operator the opposite: "Dismissed pairs are remembered — the system won't propose them again *unless a new revision brings new evidence*" (proposed-links/page.tsx:282). A new revision is precisely what guarantees it never comes back.

**Evidence.**

```
lib/linkProposerServer.ts:381 — `if (r.status === "pending") continue;` is the ONLY status carve-out; :382 `decided.add(...)` catches 'stale'. lib/linkProposals.ts:187-189 — `.update({ status: "stale" }) … .eq("status", "pending").not("source_rev", "is", null)`. The engine's own comment at :364-365 claims the set is about "already decided (including dismissals — a rejected pair must never come back to nag)" — staleness is not a rejection and was never meant to be in that set.
```

> **Verifier correction.** Downgrade CRITICAL→HIGH: the consequence is silent loss of re-derivable link proposals on the highest-churn documents, not a security or record-integrity failure. Everything else in the finding is exact.

**Done when.**

- [ ] `decided` is built from `status IN ('approved','dismissed')` only; 'stale' rows are excluded so re-extraction can re-derive them
- [ ] The queue upsert on a pair that has a stale row flips it back to 'pending' with the new source_rev (the (pair,proposer) unique index already supports this)
- [ ] A test: queue a proposal at rev 3, stale it, re-run the proposer with the same inputs at rev 4, assert the pair is pending again
- [ ] The review page's "unless a new revision brings new evidence" line is either true or removed

**Resolution (2026-09-30, intelligence Round G).** Reproduced as a test first (queue at rev 3 → stale → the same facts at rev 4 were blocked for good). The engine's block-set (`lib/linkProposerServer.ts`) is built from a targeted read of the candidate pairs: `approved` settles the pair, `dismissed` blocks only the skill that produced it (`LNK-8`), `pending` is already queued (`LNK-12`), and `stale` is none of these — the revision it was read from was superseded, so the next run re-derives it and the upsert on `proposed_links_pair_idx` flips the row back to `pending` with the new `source_rev` (one row, refreshed in place). Publish-time staling now runs on the service role: `lib/postPublish.ts` calls `requestProposalInvalidation` → `POST /api/links/invalidate` (new), or runs `invalidateProposalsForRevision` in-process when a server caller passes `serviceClient`; a sweep that did not run is logged. The route reads the document under the caller's own RLS (404 when they cannot see it), requires an active member who could have published it or already writes proposals — the proposal-writer tier (`proposed_links_write`, by the held collection), a publish grant on its library (`user_can_publish_on_library`) or its effective owner (`user_is_effective_owner`) — and compares against the document's CURRENT revision read server-side, never a client value. The sweep compares a proposal's `source_rev` only with the revision of the document its evidence was READ from: the proposers record it (`evidence.sourceDocumentId` — the sheet carrying the off-page connector, the text a custom skill matched), a proposal whose evidence came from the other endpoint is left for that document's own publish, and a proposal written before the source was recorded is retired only when its revision matches neither endpoint's current one. The review page's line is rewritten to what holds. Decision recorded in `DEC-55` (stale re-enters; dismissed stays blocked for that skill). Fix pass 2: a PENDING proposal is refreshed in place when what the reviewer reads has moved on — its revision, the document its evidence was read from, the evidence line or its page (`dropAlreadyQueued`; the engine's prior read now carries `source_rev` and `evidence`) — so a row written before the proposers recorded the source gains `evidence.sourceDocumentId` on the next run that re-derives it, and a revision the sweep did not reach (a server-side publisher without `serviceClient`) is corrected by the next run instead of staying pending with old evidence. The route reads the proposal-writer tier from `ADMIN_SURFACES` (`adminSurface("proposed-links").writes`, DEC-35 — no role list at the call site), pinned by test to the array `proposed_links_write` admits in `20261046`. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("LNK-1 / LNK-11", "LNK-1 — the sweep retires only proposals whose evidence came from the published document", "/api/links/invalidate — who may trigger the sweep …", "fix pass 2 — LNK-1 / LNK-12: a queued proposal is refreshed when what the reviewer reads moved on" — a legacy row gains the source and the current revision, then rests; "fix pass 2 — DEC-35: the sweep route reads the proposal-writer tier from ADMIN_SURFACES"). Fix pass 3, after the second review: a refresh of an `inferred` row already pending for its (pair, skill) takes no room under the 150-row ceiling — `planBatch` now takes `known.pending` and charges only NEW inferred rows against `inferredRoom` (a refresh still counts against the batch; a pending strong row that turns inferred is a new guess and waits) — so a full queue no longer holds a changed reading as "waiting for room" (*corrected:* fix pass 2's "corrected by the next run instead of staying pending with old evidence" did not hold for inferred rows once the queue held 150). Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("fix pass 3 — LNK-1 / LNK-10: refreshing an inferred row already pending takes no room in a full queue" — the pure rule and end to end). `/api/links/propose` no longer carries a role list: it gates on the controller tier as `isControllerRole` defines it, by the held collection (DEC-35), and the review page's "Find connections" control is the same tier (`isSkillController`); the page's decide set stays the one SURF-9's census pins to `ADMIN_SURFACES`. Tests: `linkProposalsRoundG.test.ts` ("fix pass 3 — DEC-35: the propose route carries no role list …" — a Manager and a suspended Admin are refused, an additive DocCtrl runs).

*Corrected in the fix pass (2026-09-30, intelligence Round G).* The first pass said the route "can only ever retire proposals that really are stale". It could not: it compared every pending proposal touching the document with THIS document's revision, although `source_rev` is the revision of whichever endpoint the evidence was read from — re-issuing sheet B retired sheet A's still-current off-page reference to B — and any member who could read the document could trigger it. Both are fixed as described above.

**Done-when.**
1. ✓ `decided` is built from `approved` (pair) and `dismissed` (pair, skill) only; `stale` rows are excluded and re-derived.
2. ✓ The queue upsert on a pair with a stale row flips it back to `pending` with the new `source_rev`.
3. ✓ Test: queue at rev 3, stale it, re-run with the same inputs at rev 4 → pending again, from rev 4, one row.
4. ✓ The review page's line now says what is true ("the same skill won't propose that pair again … When a document is revised, its waiting proposals are re-checked against the new revision").

**Scope / residual.** None. (A server-side publisher that does not pass `serviceClient` logs that the sweep did not run; the next run re-derives and refreshes what it would have retired; the intake route belongs to another package.) A pending proposal written before the proposers recorded the source document is judged by the both-endpoints rule until a run re-derives it — the next "Find connections" that reaches the pair rewrites it with the source (fix pass 2; *corrected:* the fix pass said "until the next run refreshes it", but the engine never rewrote a pending row whose tier and confidence were unchanged). A legacy row no run re-derives any more (its evidence is gone from the text) keeps the both-endpoints rule.

---

<a id="lnk-2"></a>

## LNK-2 · Every input the engine reads is silently truncated by an unordered LIMIT — including the 800-row knowledge_documents cap that bounds three of the four skills, and the 20,000-row priors cap that lets dismissed pairs come back

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposerServer.ts:189-198`, `lib/linkProposerServer.ts:152-170`, `lib/linkProposerServer.ts:236-268`, `lib/linkProposerServer.ts:366-383`, `lib/linkProposerServer.ts:296-318`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both named failures verified exactly as described, including the misleading `scanned` figure and the `inputs.mirroredDocs` (:197) that quietly records the 800. One over-generalization in the title: not EVERY input is unordered — the co-citation read at :333-339 does `.order("created_at", { ascending: false }).limit(400)`, so its truncation is at least deterministic.

**Mechanism.** Nine reads take a `.limit(...)` with no `.order()` and no check for saturation, so which slice you get is arbitrary Postgres order and changes between runs:
  • knowledge_documents `.limit(BATCH * 2)` = 800 (:194) — `mirrorRows`/`sourceByKdoc` is the ONLY bridge from knowledge docs to controlled documents, so it bounds off-page continuity (:201-231), every custom skill (:296-318, which iterates `mirrorRows`), and co-citation (:346-348, which resolves citations through `sourceByKdoc`). An org with 801+ indexed documents loses the tail of all three, permanently and invisibly.
  • documents `.limit(5000)` (:158, :162)
  • document_assets `.limit(20000)` (:240)
  • asset_aliases `.limit(5000)` (:261)
  • document_related_resources `.limit(20000)` (:370) — the `linked` set
  • proposed_links `.limit(20000)` (:379) — the `decided` set
None emits a note when it saturates, and `ProposerInputs`/`diagnose()` (proposed-links/page.tsx:56-80) only ever explain ZEROES, never ceilings — so "the inputs look healthy" (:209) is printed for an org that is silently reading 800 of its 4,000 drawings.

**Failure scenario.** Two failures. (1) A plant with 3,000 indexed drawings runs discovery. 800 arbitrary knowledge_documents are read; connectors on the other 2,200 sheets are invisible. The run reports "Scanned 3000 documents" (which counts `docRows`, :439, not mirrors) with `mirroredDocs: 800` buried in `inputs`, and diagnose() stays silent because 800 ≠ 0. The operator concludes the continuity map is complete. (2) Once proposed_links exceeds 20,000 rows — trivially reached, since a single 40-document equipment tag can queue 780 inferred pairs — the `decided` set is built from an arbitrary 20,000 of them. Dismissed pairs outside that window are no longer blocked and get re-proposed. The page's headline promise ("a dismissed pair is remembered — the engine never nags twice", proposed-links/page.tsx:14) breaks exactly when the queue is big enough for it to matter.

**Evidence.**

```
lib/linkProposerServer.ts:194 `.limit(BATCH * 2)` with BATCH=400 at :28, feeding `sourceByKdoc` at :196 which gates :216 (`if (!sourceDoc || !allowed.has(sourceDoc)) continue`), :307 (`const src = sourceByKdoc.get(c.document_id); if (!src …) continue`) and :346 (`const src = sourceByKdoc.get(kd)`). :379 `.eq("org_id", orgId).limit(20000)` on proposed_links with no order. app/(protected)/admin/proposed-links/page.tsx:56-80 — `diagnose()` tests only `=== 0`.
```

> **Verifier correction.** Downgrade one detail: "None emits a note when it saturates" is overbroad — the chunk-scan path DOES, at linkProposerServer.ts:315-317 (`Custom skills scanned the first ${CHUNK_SCAN_CAP} indexed pages this pass.`). The nine bulleted caps do not. Also flag the tiers honestly: the 800-row knowledge_documents cap is the one that realistically binds in a plant library and is the sharp end of this finding; the 5000/20000 caps and the priors-cap-lets-dismissals-return consequence are plausible-at-scale but not observable from the repo. HIGH survives on the 800 cap alone.

**Done when.**

- [ ] Each read either pages to completion or emits a note when it returns exactly its limit ("read the first 800 of N indexed documents — run again to continue")
- [ ] The `decided` and `linked` sets are computed by targeted query on the candidate pairs rather than a bulk-load-and-truncate
- [ ] `ProposerInputs` carries a saturated flag per input and the review page surfaces ceilings alongside zeroes

**Resolution (2026-09-30, intelligence Round G).** `lib/linkProposerServer.ts` `readPaged` reads every input in stable id order to completion, walking on past PostgREST's max-rows (which truncates without an error) and stopping at an empty window, up to a stated ceiling (50,000 documents / mirrors / aliases / system links, 200,000 equipment links / extracted references); a ceiling reached adds a note and names the input in `inputs.saturated`. That covers documents, knowledge mirrors (the 800-row slice that bounded three skills is gone), the drawing entities per mirror chunk (silently cut at max-rows before), document_assets, aliases, the custom-skill text scan and the evidence audit. The `linked` and `decided` sets are no longer bulk loads: they are read by targeted query on the candidate documents (`document_related_resources` by either endpoint; `proposed_links` by the pair's first id — pairs are stored smallest-id-first) to completion, and a failed read stops the pass before anything is written (a run error: no dismissed pair can come back). Answered-together says when it read only its latest-400 window. The review page lists every ceiling next to the zeroes and never prints "healthy" over one. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("LNK-2 — inputs page past max-rows; decisions are read by targeted query", "a failed decisions read writes nothing"). Fix pass 3, after the second review (*corrected:* done-when 1 was overstated — the engine's rulebook read was still an unordered `.limit(200)` with no ceiling note that read members' private drafts too, the answer pipeline's reasoning-skill read the same, and the asset-tag and answered-questions reads dropped their errors): `loadRules` reads only the rows the engine uses — every built-in and every org-wide custom skill — in id order through `readPaged`, to completion or a stated 5,000-row ceiling (`READ_CAP.rules`, `saturated: 'rules'`, worded on the review page). Members' private drafts never run, so they are counted (a head count, for the run's note) instead of read, and can no longer crowd a built-in out of the window. A built-in still absent after a failed seed is read again once (a concurrent seeder's 23505); one still missing is unknown and does not run, with an ERROR on the run (`LNK-7`). `loadAnswerSkillsBlock` reads only the org-wide packs and the asker's own (`.or(visibility.eq.org,created_by.eq.<asker>)`), built-ins first, in pages to a 5,000-row ceiling, so colleagues' private packs no longer push built-ins and the asker's own packs out of the prompt or trigger a failed re-seed. A failed `assets` tag read and a failed `knowledge_questions` read each add a note. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("fix pass 3 — LNK-2 / LNK-7: the engine reads the rules it runs, to completion …" — 250 private drafts stored ahead of a switched-off built-in, a refused seed, a concurrent seeder, the two read-error notes), `lib/__tests__/skillsAuthority.test.ts` ("LNK-2: the answer block reads the org-wide packs and the asker's own …").

**Done-when.**
1. ✓ Each read pages to completion or reports the ceiling it reached. (*Corrected in fix pass 3:* the rulebook read and the reasoning-skill read did not; they do now, and the two reads that dropped their errors report them.)
2. ✓ `decided` / `linked` are computed by targeted query on the candidate pairs.
3. ✓ `ProposerInputs.saturated` carries the saturated inputs and the review page surfaces ceilings alongside zeroes.

**Scope / residual.** The custom-skill text scan still reads the first 2,400 indexed pages per pass (said in a note and in `saturated`); there is no cursor that carries it across passes.

---

<a id="lnk-3"></a>

## LNK-3 · The provable auto-apply upsert targets a PARTIAL unique index PostgREST cannot infer — "provable connections apply themselves" almost certainly never writes a row, and the error is swallowed into a note

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `lib/linkProposerServer.ts:391-408`, `supabase/migrations/20260807_link_proposals.sql:111-113`, `lib/linkProposerServer.ts:86-101`, `lib/linkRules.ts:64-70`, `lib/answerSkillsServer.ts:66-70`, `lib/linkProposerServer.ts:423-427`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide grep of supabase/migrations for document_related_resources unique constraints returns exactly one hit — the partial index — and the base table (20260806_intelligence_layer.sql:68-84) declares no UNIQUE, so there is no non-partial arbiter for PostgREST to infer and the DO NOTHING raises 42P10. proposeOpcContinuity:82-88 does emit tier 'provable'/confidence 1 and splitByAutoApply:420 routes it to autoApply, so the path is reachable; the only correction is that the note IS rendered to the admin (proposed-links/page.tsx:189), just alongside autoApplied:0 — 'swallowed' is slightly strong, the failure itself is real. Approval by a human uses a plain .insert with 23505 handling (linkProposals.ts:111-127) and is unaffected.

**Mechanism.** Auto-apply writes with `.upsert(rows, { onConflict: "document_id,target_document_id", ignoreDuplicates: true })` (linkProposerServer.ts:405). The only unique index on that column pair is PARTIAL:

  CREATE UNIQUE INDEX IF NOT EXISTS document_related_resources_doc_target_idx
    ON document_related_resources (document_id, target_document_id)
    WHERE target_document_id IS NOT NULL;   -- 20260807:111-113

Postgres can only infer a partial unique index for ON CONFLICT when the statement repeats the index predicate; PostgREST's `on_conflict` parameter emits a bare column list and no predicate, so the server raises 42P10 ("no unique or exclusion constraint matching the ON CONFLICT specification"). This codebase already knows this — it says so three separate times in comments about the *identical* situation on other partial indexes: "the unique (org_id, builtin_key) index is PARTIAL, which ON CONFLICT can't infer through the API… an upsert here fails wholesale" (linkRules.ts:66-68, linkProposerServer.ts:88-90, answerSkillsServer.ts:67-69), and in those three places it deliberately downgrades to a plain `.insert()`. The auto-apply path was never given the same treatment. By contrast the queue write 19 lines below targets `proposed_links_pair_idx`, which is NOT partial (20260807:68-69), so that upsert works — the two calls sit next to each other and only one of them can succeed.
The failure is then hidden: `if (error) notes.push(`Auto-apply skipped: ${error.message}`); else autoApplied = rows.length;` (:406-407). `autoApplied` stays 0, the run still returns 200, and the note lands in a small grey list under the summary bar.

**Failure scenario.** An org uploads a P&ID set. Extraction stores off-page connectors. An Admin clicks "Find connections". `proposeOpcContinuity` correctly produces provable drafts (one OPC ref → exactly one owning sheet, tier 'provable', confidence 1). `splitByAutoApply` routes them to `autoApply`. The upsert returns 42P10. Every provable draft is dropped on the floor — it is not queued either, because `splitByAutoApply` (linkProposalLogic.ts:416-423) sends provable drafts ONLY to `autoApply`, never to `queue`. The header renders "Scanned 1,340 documents · 0 provable connections applied · 87 queued for review" and the diagnose() block does not fire (because `proposed > 0`), so the operator sees a plausible-looking run. The sheet-to-sheet continuity map — the single most valuable deterministic edge in a P&ID set, and the thing the whole 'provable' tier exists for — is silently absent from the graph forever.

**Evidence.**

```
lib/linkProposerServer.ts:403-407 — `.upsert(rows, { onConflict: "document_id,target_document_id", ignoreDuplicates: true }); if (error) notes.push(\`Auto-apply skipped: ${error.message}\`); else autoApplied = rows.length;`  vs the same file's own warning at :88-90: "Plain insert: the unique (org_id, builtin_key) index is PARTIAL, which ON CONFLICT can't infer through the API."  Marked SUSPECTED only because I cannot run the database; the mechanism, the partial index, and the codebase's own three-times-repeated diagnosis of the identical pattern are all in the repo.
```

> **Verifier correction.** Downgrade CRITICAL→HIGH. The blast radius is one feature (provable OPC links never materialize) with a note printed; it is not a security, data-corruption or safety failure. Keep SUSPECTED: Postgres ON CONFLICT arbiter inference over a partial index is well-documented as requiring the predicate, and PostgREST's on_conflict emits a bare column list, but nobody ran the database.

**Done when.**

- [ ] Auto-apply uses a plain `.insert()` that tolerates 23505 per row (the shape approveProposal already uses at lib/linkProposals.ts:111-127), or the migration adds a non-partial unique constraint the API can infer
- [ ] A failed auto-apply is a loud error on the run result, not a note in a list — `autoApplied: 0` with a non-empty note must render as a red banner
- [ ] A test inserts a provable OPC draft twice and asserts exactly one document_related_resources row with origin='system' exists afterwards

**Resolution (2026-09-30, intelligence Round G).** Both limbs. `20261126` replaces the partial `document_related_resources_doc_target_idx` with a PLAIN unique index `document_related_resources_doc_target_uniq (document_id, target_document_id)` — URL rows (NULL target) stay unconstrained, since NULLs are distinct — and the auto-apply write targets exactly it (`onConflict: "document_id,target_document_id"`, `ignoreDuplicates`, counting the rows actually written). If the batch fails (42P10 on a database without the index, or anything else) each row is inserted on its own: 23505 means already linked; any other failure queues the draft as a provable proposal for a person (it no longer vanishes) and the run carries an ERROR, rendered as a red banner on the review page. The row is carried by the lower document number (`LNK-13`). Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("a provable draft run twice leaves exactly one system link …", "a provable draft that cannot be applied is an ERROR and falls back to the review queue").

**Pending migration:** `supabase/migrations/20261126_intel_roundG_link_conflict_targets.sql` (DEC-30: the inventory — `document_related_resources` rows with NULL `target_document_id`, pairs linked both ways, `origin` values outside the declared set, duplicate mention keys, `proposed_links` rows in status `stale` and pending, and the pending rows from a connection skill that is private (retired to `stale`; fix pass 3) — is captured before the DDL; the plain mention indexes and the VALIDATE of the origin CHECK happen only in the world where nothing violates them, and the final rows say which world was taken).

**Done-when.**
1. ✓ The migration adds a non-partial unique index the API infers, and the writer tolerates 23505 row by row when a batch cannot be written.
2. ✓ A failed auto-apply is an error on the run result (red banner), not a note.
3. ✓ A test applies a provable OPC draft twice and finds exactly one `origin='system'` row (against the in-memory stand-in; the 42P10 itself is Postgres behaviour and stays unobserved here).

**Scope / residual.** None.

---

<a id="lnk-4"></a>

## LNK-4 · proposed_links is readable by every active member with no document-visibility condition — the "hide proposals whose endpoints you can't read" rule is client-side JavaScript only

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260807_link_proposals.sql:78-81`, `lib/linkProposals.ts:71-96`, `lib/linkProposals.ts:153-173`, `lib/linkProposals.ts:197-206`, `lib/acl.ts:1-8`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The asymmetry is confirmed by 20260708_acl_rls_enforcement.sql:85-87, which puts a RESTRICTIVE `documents_acl_select ... USING (node_visible(visibility, acl_index, org_id))` on documents — so document rows ARE ACL-scoped while proposed_links is not, and the leaked evidence JSONB carries exactly the sensitive payload (drawing numbers in `Off-page connector … continues onto <ref>`, `tags` arrays from proposeSharedEquipment:173-181). listPendingPairs (:197-206) reads the same table with no filter at all.

**Mechanism.** The SELECT policy is org-membership only:

  CREATE POLICY proposed_links_read ON proposed_links FOR SELECT
    USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = proposed_links.org_id
                   AND m.uid = auth.uid() AND m.status = 'active'));   -- :79-81

Every row carries an `evidence` JSONB rendered verbatim to reviewers — drawing numbers ("Off-page connector 44-098 continues onto 44-PID-013", linkProposalLogic.ts:91), up to 12 equipment tags (`tags: tagList.slice(0, 12)`, :180), matched identifier text ("Text references \"WO-48122\"", :314), and a verbatim 140-character slice of a colleague's question (:376). The mitigation is written in application code, and it is explicit about what it is compensating for:

  // A proposal whose endpoints this person can't read shouldn't be shown at
  // all — RLS hides the documents, so hide the proposal with them.
  return rows.filter((r) => r.doc && r.target);        // linkProposals.ts:93-95

That filter runs in the browser AFTER `select("*")` has already returned the full rows to the client. This app has a real per-node ACL layer with allow/deny, inheritance and hidden nodes (lib/acl.ts:1-8), so "documents you cannot read" is a live concept here, not hypothetical.

**Failure scenario.** A contractor on an active seat, scoped by ACL to one project folder, opens devtools (or any HTTP client with their own JWT) and runs `supabase.from('proposed_links').select('*')`. They get every discovered connection in the org: the document-number pairs, the equipment tags on drawings they are denied, the identifiers a custom skill matched, and the text of questions colleagues asked. The `/admin/proposed-links` page shows them nothing — which is exactly why nobody notices. Note the graph does this correctly by contrast: ghost edges are filtered against nodes that came through RLS (`proposals.filter((e) => ids.has(e.a) && ids.has(e.b))`, graph/page.tsx:176-178), so the leak is specific to direct table reads.

**Evidence.**

```
supabase/migrations/20260807_link_proposals.sql:79-81 (quoted above) — no join to documents, no ACL predicate. lib/linkProposals.ts:72 `.from("proposed_links").select("*")` then :95 `return rows.filter((r) => r.doc && r.target);`. Same shape at :155-172 and :201-205 (`listPendingPairs`, limit 4000, no filter at all — safe only because its consumer re-filters).
```

**Done when.**

- [ ] proposed_links_read adds a condition that both endpoints are visible to auth.uid() under the same predicate documents uses (a SECURITY DEFINER helper mirroring the documents policy)
- [ ] A test signs in as a member denied one endpoint and asserts a raw `select('*')` on proposed_links returns zero rows for that pair
- [ ] asset_aliases_read (:142-144, same org-only shape) is reviewed under the same question

**Resolution (2026-09-30, intelligence Round G).** `20261126` adds `proposed_links_read_endpoints`, a RESTRICTIVE SELECT policy: `EXISTS (SELECT 1 FROM documents d WHERE d.id = proposed_links.document_id) AND EXISTS (… target_document_id)`. The subqueries run under the caller's own `documents` RLS (`documents_acl_select`), so a proposal is readable only by someone who can read both documents — the documents predicate itself, not a copy of it. It is RESTRICTIVE because `proposed_links_write` is FOR ALL: its USING would otherwise grant SELECT on every row to the writer tier. The engine and the publish sweep run on the service role and are unaffected; `listPendingPairs` / `listProposals` are now scoped by the database. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("LNK-4: a RESTRICTIVE select policy requires both endpoints readable …").

**Pending migration:** `supabase/migrations/20261126_intel_roundG_link_conflict_targets.sql` (DEC-30: the inventory — `document_related_resources` rows with NULL `target_document_id`, pairs linked both ways, `origin` values outside the declared set, duplicate mention keys, `proposed_links` rows in status `stale` and pending, and the pending rows from a connection skill that is private (retired to `stale`; fix pass 3) — is captured before the DDL; the plain mention indexes and the VALIDATE of the origin CHECK happen only in the world where nothing violates them, and the final rows say which world was taken).

**Done-when.**
1. ✓ The read condition requires both endpoints visible to `auth.uid()` under the documents policy (the documents RLS itself through the subqueries, rather than a SECURITY DEFINER re-implementation that could drift).
2. ✓ as a shape test plus the live probe in `20261126`'s result set; there is no database here to sign in as a denied member.
3. ✓ Reviewed: `asset_aliases_read` stays member-wide. An alias is a registry fact (a nickname of an asset); the registry itself is member-readable (`20261128` keeps registry reads with members), and an alias row carries no document identity or evidence.

**Scope / residual.** None.

---

<a id="lnk-5"></a>

## LNK-5 · "Private" Connection Skills are not private: the proposer ignores visibility entirely, and the skill's name is copied into org-readable evidence — while the reasoning-skill twin does filter correctly

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposerServer.ts:138-140`, `lib/linkProposalLogic.ts:307-321`, `supabase/migrations/20261015_connection_skills.sql:11-14,46-50`, `lib/answerSkillsServer.ts:29-32`, `components/intelligence/SkillStudio.tsx:258-269`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The impact framing is wrong: the migration's own header (20261015_connection_skills.sql:12-14) DEFINES private as "the author's experiment; it still runs, but its findings NEVER auto-apply and only reach the normal review queue" — which is exactly what the code does (custom skills top out at 'strong', linkProposalLogic.ts:311), and SkillStudio.tsx:268 tells the connection-skill author "Either way its findings only ever QUEUE for review". So this is the declared contract, not a violated one; the residual defect is only that the shared Studio control labels it "Just me" with a Lock icon and that the skill's name rides into org-visible evidence.

**Mechanism.** `customRules` selects on `!r.builtin_key && r.kind === "reference" && r.enabled && patterns.length > 0` (linkProposerServer.ts:138-140). `visibility` is never read. The rule then runs org-wide against every mirrored document and writes proposals whose evidence carries the skill's own name:

  evidence: { summary: `Text references “${matched}”`,
              detail: `Found by the “${rule.name}” skill.`, …, rule: rule.name }   // :313-319

and `proposerLabel` renders `evidence.rule` on the review card (linkProposals.ts:58, proposed-links/page.tsx:257). proposed_links is org-readable (previous finding), and link_rules' own SELECT policy correctly hides private rows (`visibility = 'org' OR created_by = auth.uid()`, migration :49) — so the row is hidden but its name and output are not.
The reasoning-skill counterpart gets this right and proves the asymmetry is an oversight, not a design: `rows.filter((r) => r.enabled && (r.visibility === "org" || (askerId !== null && r.created_by === askerId)))` (answerSkillsServer.ts:30-31), with a test asserting a teammate's private skill never appears (linkProposalLogic.test.ts:304-318).

**Failure scenario.** A member drafts a private skill to experiment with a numbering convention — the Studio tells them "Just me" and the migration promises "the author's experiment". It runs against the whole org's corpus on the next Admin pass and floods the shared review queue with rows labelled with the skill's name. Every member sees the experiment, its name, and the identifiers it matched; the author believed it was scoped to them. Worse for the DoS finding above: a private skill is a fully live, org-wide execution path with no reviewer.

**Evidence.**

```
lib/linkProposerServer.ts:139 — `!r.builtin_key && r.kind === "reference" && r.enabled && (r.config?.patterns?.length ?? 0) > 0` (no `visibility`). supabase/migrations/20261015_connection_skills.sql:12-14 — "'private' — the author's experiment; it still runs, but its findings NEVER auto-apply and only reach the normal review queue" — the stated contract is 'runs but does not auto-apply', which the code satisfies, but the UI at SkillStudio.tsx:262 says "Just me" and the shelf badge says "Private" (skills/page.tsx:130), which the code does not satisfy.
```

> **Verifier correction.** The headline is refuted by the repo's own stated contract and must be rewritten. The migration header at 20261015:11-14 explicitly specifies `'private' — the author's experiment; it still runs, but its findings NEVER auto-apply and only reach the normal review queue` — running org-wide IS the design, and the code satisfies it (custom skills are pinned to strong/inferred at linkProposalLogic.ts:311-312 and can never reach splitByAutoApply's provable branch). The UI is also less misleading than claimed: the helper text directly under the Just-me toggle, SkillStudio.tsx:266-269, reads "Either way its findings only ever QUEUE for review — custom skills never apply links by themselves" for the connection kind, and reserves "private rides only yours" for the reasoning kind. What actually survives is a narrow, undocumented leak: a private skill's NAME is copied into proposed_links.evidence, which is org-readable (finding 5), so every member sees the name of a rule RLS is hiding from them. That is MEDIUM, not HIGH, and the answer-skills asymmetry is explained by a different mechanism (prompt injection into the asker's own answer), not proven to be an oversight.

**Done when.**

- [ ] `customRules` is filtered to `visibility === 'org'`, or private-skill findings are written with a visibility marker and proposed_links_read scopes them to the author
- [ ] The Studio's "Just me" copy states plainly what private means for a connection skill (runs org-wide, findings visible to reviewers) if that stays the behaviour
- [ ] A test mirrors linkProposalLogic.test.ts:304-318 for connection skills: a teammate's private skill produces no drafts for another member's run

**Resolution (2026-09-30, intelligence Round G).** Decision (`DEC-55`): a private Connection Skill is its author's draft — the Studio's live tester runs it, the engine does not. `runLinkProposers` runs only enabled, org-wide custom skills; a private one never reads the org's corpus, so its name never reaches `proposed_links.evidence`, and the run says how many private skills it skipped. Org-wide is the controller tier (`20261125`), so the skills that do run are ones a controller shared. The Studio's copy for each sharing choice states this ("A draft: the tester above runs it; the engine does not run it until it is shared org-wide"). Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("a private connection skill never runs over the org's corpus (and its name reaches no evidence)"). Fix pass 3, after the second review (*corrected:* this resolution said a private skill's name "never reaches `proposed_links.evidence`" with no residual, but proposals a private skill queued before this round — including skills `20261125` took back to private — were still pending with its name in their evidence, shown to every reviewer who can read both documents): `20261126` counts those pending rows in its pre-apply inventory, retires them to `stale` inside the transaction (not dismissed: if a controller shares the skill, the next run re-derives them) and probes after apply that none is left pending. Verified on a local PostgreSQL 16 (a pending row from a private rule retired; the org-wide rule's and a built-in's left pending; a second run clean). Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("fix pass 3 — LNK-5: proposals a private skill queued before this round leave the review queue (20261126)").

**Pending migration:** `supabase/migrations/20261125_intel_roundG_skills_authority.sql` (DEC-30: the pre-apply inventory — built-ins carrying a member uid, org-wide custom skills whose author is not an active controller, packs without APPLIES WHEN or over 4,000 characters, connection skills over the pattern limits, non-controller members, custom skills whose byline is not their author's member address (re-signed; fix pass 3), and the private custom skills that become readable by controllers (the one read this file widens, with the one decision it admits — approving or declining a member's share request) — is captured into a TEMP TABLE before the DDL and printed in the one result set, with after rows counting the share requests and the custom connection skills that hold a pattern the bounded subset refuses (and the org-wide ones left with none); the probes verify every policy, trigger and pin after apply). *Corrected in fix pass 2:* this paragraph used to say "until it is applied, the app half holds". It did not: every skill create named `share_requested` and every publish and re-enable named `share_requested` / `disabled_reason`, columns only this file adds, so before it is applied PostgREST refused them (PGRST204) and nobody could create, publish or re-enable a skill; a controller's built-in seed was refused by the old insert policy and showed an error banner. What holds before it is applied, since fix pass 2: creating a private skill, publishing, unsharing and switching skills (re-enabling included) work — the client names a 20261125 column only for a share request, and the guard stamps the rest after apply; a share request cannot be recorded (a new skill saves as its author's private skill and the Studio says so; the request control is not offered on a row without the column; asking on an existing skill says the feature needs this file); a controller's refused built-in seed is left to the service-role seeders (the engine, the answer pipeline) without an error; the engine switches a hung skill off without `disabled_reason`; private connection skills do not run; the Studio offers org-wide publishing to controllers only. What does NOT hold until it is applied: the database still admits a direct PostgREST write by any member — publishing org-wide, a member managing a built-in it seeded earlier, an unvalidated `config` — so the authority and pattern claims above are true only once the file is applied.

**Done-when.**
1. ✓ `customRules` is filtered to `visibility === 'org'`.
2. ✓ The Studio states plainly what private means for a connection skill.
3. ✓ A teammate's private skill produces no drafts in a run; what one queued before this round leaves the review queue (`20261126`, fix pass 3).

**Scope / residual.** The retired rows keep their evidence text, the skill's name included, readable as before only by members who can read both documents (`LNK-4`); nothing new is written from a private skill. (*Corrected in fix pass 3:* this said "None".)

---

<a id="lnk-6"></a>

## LNK-6 · Any active member — including a Viewer — can author a regex that the server then runs unbounded over the document corpus: catastrophic backtracking hangs the propose function, and `config` can be PATCHed directly, bypassing the only validation

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261015_connection_skills.sql:54-65`, `lib/linkProposalLogic.ts:254-272`, `lib/linkProposalLogic.ts:280-330`, `lib/linkProposerServer.ts:138-140`, `lib/linkProposerServer.ts:294-326`, `lib/linkRules.ts:93-109`, `app/api/links/propose/route.ts:19,32-39`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed end to end: createLinkRule's validation (linkRules.ts:93-94) is a client-side library call, so a direct PATCH of link_rules.config bypasses it entirely, and there is no pattern-count cap anywhere. The only gate on execution is app/api/links/propose/route.ts:37 (Admin/DocCtrl), so the Viewer plants and an Admin detonates; maxDuration=60 (route.ts:19) bounds the platform kill, not the hang.

**Mechanism.** Three gaps compose:
(a) AUTHORSHIP IS UNGATED. `link_rules_insert` requires only active membership: `EXISTS (SELECT 1 FROM org_members m WHERE … m.status = 'active') AND created_by = auth.uid()` (migration :55-59). The comment justifies it — "it can only ever QUEUE proposals" — but queueing is not the risk; execution is.
(b) THE COMPILER HAS NO BACKTRACKING GUARD. `compileSkillPatterns` rejects exactly four things: blank, `length > 200`, uncompilable, and `re.test("")` (linkProposalLogic.ts:259-270). `\b(a+)+b\b` is 12 characters, compiles, and does not match empty. There is also no cap on the NUMBER of patterns — `createLinkRule` (linkRules.ts:95-96) only requires ≥1, and the engine loops every regex over every occurrence (linkProposalLogic.ts:288). `MAX_MATCHES_PER_TEXT = 20` bounds successful matches, not the time a single failing `exec()` takes.
(c) VALIDATION IS BYPASSABLE ANYWAY. `link_rules_update` allows `created_by = auth.uid()` (migration :63-65) on the whole row including `config` JSONB. `createLinkRule`'s `compileSkillPatterns` check (linkRules.ts:93-94) is client-side; a direct PostgREST PATCH sets any config it likes. The engine's own `compileSkillPatterns` at :321 is the only server-side gate, and per (b) it does not stop this.
Execution path: the member's row satisfies `!r.builtin_key && r.kind === "reference" && r.enabled && patterns.length > 0` (linkProposerServer.ts:138-140) — note visibility is NOT checked — so it runs on the next Admin-triggered pass, against up to CHUNK_SCAN_CAP = 2,400 knowledge_chunks (:30, :296-318) inside a `runtime = "nodejs"`, `maxDuration = 60` route (propose/route.ts:18-19), on the single-threaded event loop.

**Failure scenario.** A contractor with a Viewer seat opens the Skill Studio, clicks "Start blank", and saves a skill with pattern `(\w+\s?)+$` — or PATCHes `config` to 200 such patterns. Nothing happens until an Admin clicks "Find connections". The first knowledge_chunk of prose (chunks are page-sized, often 1–2 kB) sends V8's regex engine into exponential backtracking. The function pins a CPU and is killed at 60 s. The client's loop retries — up to 12 times, each a fresh 60-second CPU burn. Link discovery is dead for the org until someone finds and disables the row, and there is no UI that shows which skill was running when the run died: the timeout kills the request before `notes` is ever returned.

**Evidence.**

```
lib/linkProposalLogic.ts:262-266 — `if (p.length > 200) { … } try { const re = new RegExp(p, "gi"); if (re.test("")) { … } regexes.push(new RegExp(p, "gi")); }` — no complexity analysis, no timeout, no pattern-count cap. supabase/migrations/20261015_connection_skills.sql:55-59 — insert policy requires only `m.status = 'active'`. lib/linkProposerServer.ts:139 — `!r.builtin_key && r.kind === "reference" && r.enabled && (r.config?.patterns?.length ?? 0) > 0` — no visibility check, no author-role check. The same unguarded compiler runs synchronously in the browser on every keystroke via `useMemo` at components/intelligence/SkillStudio.tsx:56-59, so the author also hangs their own tab.
```

> **Verifier correction.** Downgrade HIGH→MEDIUM and drop limb (c) entirely. (c) is moot: a direct PATCH of `config` gains nothing, because the engine re-runs the IDENTICAL `compileSkillPatterns` at linkProposerServer.ts:321 before executing, applying the same >200-char and empty-match rejections `createLinkRule` applies. The finding concedes this and then still lists it as a composing gap. Also note execution requires an Admin/DocCtrl to trigger /api/links/propose (route.ts:37 gates to ["Admin","DocCtrl"]) and the damage ceiling is one 60s serverless invocation plus the author's own tab, not persistent org-wide denial.

**Done when.**

- [ ] Custom-skill regexes execute under a hard wall-clock budget per skill and per run (worker/`vm` with a deadline, or a linear-time engine like RE2), so one pattern cannot consume the request
- [ ] `compileSkillPatterns` caps pattern count (e.g. 8) and rejects nested unbounded quantifiers, and that check runs SERVER-side on every read of `config`, not only in `createLinkRule`
- [ ] `link_rules_insert` and the `config` column are restricted to the roles that can already run the engine, or `config` is made write-only through a validating API route
- [ ] `customRules` filters on `visibility = 'org' OR created_by = <the run's actor>`, matching what buildAnswerSkillsBlock already does for reasoning skills

**Resolution (2026-09-30, intelligence Round G).** Decision (`DEC-55`): patterns stay inside a bounded subset, validated wherever they are written or run, and the engine runs them under a hard wall-clock deadline it enforces by terminating a worker thread. The subset — `lib/linkProposalLogic.ts` `patternSafetyIssue` — refuses backreferences, lookarounds / named groups / inline flags, a repeated group holding a repeat, an alternation or another group (the exponential class), an unbounded repeat of `.`, two unbounded repeats with nothing but optional atoms between them (the polynomial class: `\d+-?\d+`, `\w+\s?\w+`, `\d+(-|)\d+`, `(\d+)-?(\d+)`, `(ab)+(ab)+` …), more than 2 unbounded repeats and repeat bounds above 100; a repeat bounded above 10 counts as unbounded for those rules (`\d{0,100}\d{0,100}…`, `[A-Z0-9]{1,100}[A-Z0-9]{1,100}…`). `compileSkillPatterns` applies it before compiling and caps a skill at 8 patterns — the Studio's live tester, `createLinkRule`, the skill-assist route and the engine all use it. The database applies the same rules on the same normalised text (`20261125` `skill_pattern_issue`, called by the BEFORE trigger `link_rules_guard` on every person's write of `config`), so a direct PATCH cannot bypass them; the two implementations were compared over 20,003 generated patterns on a local PostgreSQL 16 with no divergence. The subset is a FILTER, not a proof of linear time — `\w+a\w+X` stays inside it and runs for seconds on a long run of letters — so the bound on a run is the deadline: `lib/customSkillRunner.ts` `workerSkillMatcher` runs a skill's patterns in a worker thread; the worker reads its own clock between matches (50 ms per indexed text — a page — `SKILL_DOC_BUDGET_MS`), and the request thread terminates the worker when one text has run for more than 1 s (`SKILL_DOC_HARD_MS` — a single exec that never returns) or the skill's share of the run's 15 s custom-skill budget is spent (`CUSTOM_RUN_BUDGET_MS`, enforced inside a skill, not only between skills). `/api/links/propose` hands the matcher to `runLinkProposers`; without one no member-authored pattern runs (the engine module is also reachable from browser bundles, so it never imports the node-only runner). A skill whose match never returns (the worker terminated at the 1 s ceiling) is switched off by the engine (`enabled = false`, `disabled_reason` — "one match ran for … ms on one page of indexed text without finishing and was stopped" — shown on the card and cleared by the guard when a person switches it back on; before `20261125` the engine switches it off without the reason), the run says so, and its partial output is not queued. Fix pass 2, after the review: (a) the 50 ms budget is per TEXT, not summed over a document's pages — the sum switched a correct skill off for scanning a long manual (eight identifier patterns over a 1,200-page manual took 32–76 ms in all); a text that passes it skips the rest of that document for that skill this pass, keeps the skill on, and the run names the skill and the slowest page; only a termination switches a skill off. (b) Each skill runs under a fair share of what is left of the 15 s (what is left divided by the skills still to run), so a heavy first skill no longer keeps every later skill from running pass after pass; a skill whose share runs out keeps what it found and the run says how many pages it read — no promise of a next time (*corrected:* the fix pass said "the rest runs next time"; every pass restarts the same skills from the first page). (c) Patterns written before the subset: the skill card names a pattern the engine refuses (`refusedSkillPatterns`, from `compileSkillPatterns`), `20261125`'s after rows count the custom skills holding one and the org-wide switched-on skills left with none, and `link_rules_guard` re-checks the patterns when a skill is published (a legacy private skill can no longer be approved past the subset). (d) The skill-assist drafting prompt states the subset (bounded repeats, at most 2 unbounded, never side by side, no nested repeats or lookarounds), so drafts are not all filtered out. Authorship: a member's skill is a private draft the engine does not run (`LNK-5`). Tests: `lib/__tests__/customSkillRunner.test.ts` (a subset-accepted pattern that never returns is terminated at the per-text ceiling and named; the run budget stops a skill mid-way; a soft overrun keeps the worker; the worker's matches make the in-thread drafts), `lib/__tests__/linkProposalsRoundG.test.ts` ("LNK-6 — the bounded pattern subset …", "fix pass: repeats separated only by optional atoms are side by side …", "the database function carries the same normalisation and rules", "an overrunning skill is switched off with the reason …" — end to end through the real worker), `lib/__tests__/skillsAuthority.test.ts` ("LNK-6: a connection skill outside the bounded subset is refused before the insert"). Fix pass 2 tests: `customSkillRunner.test.ts` ("one slow page skips its document; the other documents still run", "the budget is per text — a long manual of fast pages trips nothing", "the in-thread run's budget is per text too"), `linkProposalsRoundG.test.ts` ("a soft overrun (one slow page) skips that document for the skill, keeps the skill on and says so", "every skill gets a fair share of what is left …", "skills the run's budget never reached are named as not run this pass", "(pre-20261125): a skill the engine must switch off is switched off even without the disabled_reason column", "the drafting prompt states the bounded subset"), `skillsAuthority.test.ts` ("publishing a connection skill re-checks its patterns", "probes pin the rules after apply; the inventory counts the legacy patterns the subset refuses", "the card names a pattern the engine refuses …"); the guard re-check and the after rows were run on a local PostgreSQL 16 (an approval of a private `\d+-?\d+` skill is refused 23514; three legacy skills counted, one left with no runnable pattern). Fix pass 3, after the second review (*corrected:* "only a terminated match switches a skill off" did not hold — the 1 s ceiling was measured on the request thread's timer from when that thread last processed a worker message, so a stall of the request thread's event loop over 1 s (another request on the same process, a large JSON parse, a GC pause; Node runs expired timers before it delivers queued port messages) read as a match that never returned, and the engine switched a correct org-wide skill off, persistently, with a false reason): the stuck decision is the worker's own state now. The worker writes the text it is on and when it started it into a `SharedArrayBuffer` (on `process.hrtime`, the process-wide monotonic clock) and posts its results on a dedicated `MessageChannel` port; the watchdog first drains every result already sent (`receiveMessageOnPort`), then terminates only when the worker itself has been on one text for the ceiling; a watchdog that fires a full ceiling late (a host stall) gives the worker one more ceiling before judging it. Tests: `lib/__tests__/customSkillRunner.test.ts` ("fix pass 3: a 1.5 s stall of the request thread mid-run (setImmediate / setTimeout) is not a hang — nothing is terminated and every page is found" — 2,400 pages, two identifier patterns; the setImmediate case fails against the fix-pass-2 runner — "a real hang during a host stall is still stopped — after one more ceiling, at the text it hangs on", "the stuck decision reads the worker's own progress and drains the results port first").

*Corrected in the fix pass (2026-09-30, intelligence Round G).* The first pass called the subset "backtracking-safe", said "the subset is what bounds one match", read the clock only between matches on the request thread and checked the 15 s budget only between skills, and marked done-when 1 done. The review ran four subset-accepted patterns whose single exec took 5–135 s; such a skill would have hung `/api/links/propose` past its 60 s limit before the engine could switch it off. The subset is tightened (both implementations) and the deadline now lives outside V8's backtracker, as above.

**Pending migration:** `supabase/migrations/20261125_intel_roundG_skills_authority.sql` (DEC-30: the pre-apply inventory — built-ins carrying a member uid, org-wide custom skills whose author is not an active controller, packs without APPLIES WHEN or over 4,000 characters, connection skills over the pattern limits, non-controller members, custom skills whose byline is not their author's member address (re-signed; fix pass 3), and the private custom skills that become readable by controllers (the one read this file widens, with the one decision it admits — approving or declining a member's share request) — is captured into a TEMP TABLE before the DDL and printed in the one result set, with after rows counting the share requests and the custom connection skills that hold a pattern the bounded subset refuses (and the org-wide ones left with none); the probes verify every policy, trigger and pin after apply). *Corrected in fix pass 2:* this paragraph used to say "until it is applied, the app half holds". It did not: every skill create named `share_requested` and every publish and re-enable named `share_requested` / `disabled_reason`, columns only this file adds, so before it is applied PostgREST refused them (PGRST204) and nobody could create, publish or re-enable a skill; a controller's built-in seed was refused by the old insert policy and showed an error banner. What holds before it is applied, since fix pass 2: creating a private skill, publishing, unsharing and switching skills (re-enabling included) work — the client names a 20261125 column only for a share request, and the guard stamps the rest after apply; a share request cannot be recorded (a new skill saves as its author's private skill and the Studio says so; the request control is not offered on a row without the column; asking on an existing skill says the feature needs this file); a controller's refused built-in seed is left to the service-role seeders (the engine, the answer pipeline) without an error; the engine switches a hung skill off without `disabled_reason`; private connection skills do not run; the Studio offers org-wide publishing to controllers only. What does NOT hold until it is applied: the database still admits a direct PostgREST write by any member — publishing org-wide, a member managing a built-in it seeded earlier, an unvalidated `config` — so the authority and pattern claims above are true only once the file is applied.

**Done-when.**
1. ✓ Custom-skill regexes run in a worker thread under a hard wall-clock limit per text (1 s, the worker is terminated) and per run (15 s for all custom skills, shared fairly and enforced inside a skill), with a 50 ms per-text budget read between matches — one pattern cannot consume the request (`lib/customSkillRunner.ts`). (Not met by the first pass; see the correction above. Fix pass 2: the budget is per text, a soft overrun skips the document and only a termination switches the skill off — "offending skill disabled with a note" now names the skill that hangs, not one that read a long manual. *Corrected in fix pass 3:* the 1 s ceiling was read on the request thread's clock, so a request-thread stall read as a hang and switched a correct skill off; it is now the worker's own time on the text, after its queued results are drained.)
2. ✓ The pattern count is capped at 8 and nested unbounded quantifiers are refused — and repeats separated only by optional atoms, and repeats bounded above 10 — server-side on every read of `config` (the engine compiles through the same check) and at the database on every write.
3. ✓ `config` is validated at the database on every person's write, and org-wide authorship (the only skills the engine runs) is the controller tier.
4. ✓ Stricter than asked: `customRules` runs org-wide skills only.

**Scope / residual.** None in the engine. The Studio's live tester still runs the author's patterns in the author's own tab on the sample text they typed (the subset refuses the known shapes first); the engine never runs a pattern on the request thread. Each pass scans the custom-skill text from its first page (no cursor across passes — `LNK-2`'s residual): a skill whose fair share runs out reads the same first pages every pass, and the run says how many.

---

<a id="lnk-7"></a>

## LNK-7 · Built-in Connection Skills become owned by whichever member's browser seeded them first, and RLS lets that owner disable or delete the org's core detectors — the UI hides the delete button but the database does not

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkRules.ts:57-82`, `supabase/migrations/20261015_connection_skills.sql:62-70`, `lib/linkProposerServer.ts:86-111`, `components/intelligence/ConnectionSkillsPanel.tsx:50-58`, `app/(protected)/intelligence/skills/page.tsx:302-347`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The functional impact checks out: disabling opc_continuity really does stop discovery, because linkProposerServer.ts:201 gates the whole entity fetch on `builtinEnabled("opc_continuity")`. One detail is worse than the finding says, not better — `mayManage = canManageOrg || mine` (skills/page.tsx:305-306) means the seeding Viewer is shown the On/Off toggle in the UI too, so no API client is even needed to disable a core detector.

**Mechanism.** `seedBuiltinRules(orgId, userId)` runs from the browser on page load for ANY member who opens the skills page or the review page (skills/page.tsx:68-79, ConnectionSkillsPanel.tsx:50-58 — neither is role-gated), and stamps `created_by: input.userId` on every seeded built-in (linkRules.ts:79). The update and delete policies are:

  CREATE POLICY link_rules_update ON link_rules FOR UPDATE USING (
    is_org_controller(org_id) OR created_by = auth.uid()) …          -- :63-65
  CREATE POLICY link_rules_delete ON link_rules FOR DELETE USING (
    is_org_controller(org_id) OR created_by = auth.uid());            -- :68-70

So the seeding member owns all three built-ins forever. The client UI partially masks this — `cardControls` renders flip/delete only `if (!opts.builtin && opts.mayManage)` (skills/page.tsx:145) — but `toggleButton` is rendered whenever `mayManage = canManageOrg || mine` (skills/page.tsx:306, 323), so the on/off switch IS exposed to them, and delete is one PostgREST call away regardless. Ownership is also non-deterministic: the server-side seeder in `loadRules` writes NO `created_by` at all (linkProposerServer.ts:92-101), leaving it NULL and controller-only — so whether the built-ins are owned or unowned depends on whether a member's browser or an Admin's proposer run touched the org first.

**Failure scenario.** A new Viewer clicks into Intelligence → Skills on their first day. Their browser seeds the three built-ins with `created_by = <their uid>`. Six weeks later they toggle "Drawing cross-reference continuity" off to see what it does — or delete it via the API. Off-page connector discovery stops org-wide. An Admin looking at the shelf sees the skill missing or greyed with the byline "by a teammate" (skills/page.tsx:143) and no record of who or when; link_rules has no audit trail and no updated_by. In a PSM context the continuity map between P&ID sheets quietly stops growing and nothing announces it.

**Evidence.**

```
lib/linkRules.ts:79 — `created_by: userId,` inside the built-in seed insert; lib/linkRules.ts:57 signature `seedBuiltinRules(orgId: string, userId: string)`; called unguarded at app/(protected)/intelligence/skills/page.tsx:73 and components/intelligence/ConnectionSkillsPanel.tsx:55. supabase/migrations/20261015_connection_skills.sql:63-70 (quoted). Contrast lib/linkProposerServer.ts:92-101 which omits created_by entirely.
```

> **Verifier correction.** Downgrade HIGH→MEDIUM. The DELETE half is largely self-healing — a deleted built-in is re-seeded on the next skills-page load (linkRules.ts:63-64) or the next proposer run (linkProposerServer.ts:86-102), which is why the seeders are written as idempotent gap-fillers. The durable harm is the toggle: `enabled: false` persists (loadRules only seeds MISSING keys, never re-enables), so a non-controller member can silently switch off the org's core detectors and the proposer will honor it via `builtinEnabled()` at :136-137. Scope the finding to that.

**Done when.**

- [ ] Built-in rows are seeded with `created_by = NULL` (or a sentinel) so only `is_org_controller` can touch them
- [ ] link_rules_update/delete exclude rows where `builtin_key IS NOT NULL` unless is_org_controller(org_id)
- [ ] Seeding moves server-side (it already exists in loadRules) rather than firing from every member's page load
- [ ] Toggling or deleting a skill writes an audit event naming the actor and the skill

**Resolution (2026-09-30, intelligence Round G).** See `HUB-2` for the shared fix (`DEC-55`). For Connection Skills specifically: `seedBuiltinRules(orgId)` writes no author and runs only for a controller, once, in the one Connection Skills list; `loadRules` (the engine, service role) seeds with `created_by: null`; `20261125` releases member-owned built-ins and makes every built-in controller-managed — `link_rules_update` admits a built-in only for `is_org_controller` and only without an author, `link_rules_delete` never admits a built-in (every seeder restores a missing one; switch it off instead). Every person's toggle or delete of a skill writes `SKILL_UPDATED` / `SKILL_DELETED` to `audit_logs` naming the actor and the skill (`skills_audit`). Fix pass 2: the engine fails CLOSED on its rulebook — when the `link_rules` read fails for any reason but a missing table, whether a controller switched a built-in off is unknown, so no detector runs that pass and the run carries an ERROR (it used to run every built-in "with defaults", including ones switched off); a missing table (the migration never ran) still runs the defaults, with the note. Tests: `lib/__tests__/skillsAuthority.test.ts` ("LNK-7: the engine seeds built-ins with no author", "HUB-2 / LNK-7 …"), `lib/__tests__/linkProposalsRoundG.test.ts` ("fix pass 2 — LNK-7 / HUB-2: a rulebook that cannot be read runs no detector (fail closed)"). Fix pass 3: a built-in the rulebook does not hold after a failed seed is unknown — it does not run, and the run carries an ERROR — where it used to run by default; and members' private drafts can no longer crowd a built-in a controller switched off out of the rulebook read (`LNK-2`).

**Pending migration:** `supabase/migrations/20261125_intel_roundG_skills_authority.sql` (DEC-30: the pre-apply inventory — built-ins carrying a member uid, org-wide custom skills whose author is not an active controller, packs without APPLIES WHEN or over 4,000 characters, connection skills over the pattern limits, non-controller members, custom skills whose byline is not their author's member address (re-signed; fix pass 3), and the private custom skills that become readable by controllers (the one read this file widens, with the one decision it admits — approving or declining a member's share request) — is captured into a TEMP TABLE before the DDL and printed in the one result set, with after rows counting the share requests and the custom connection skills that hold a pattern the bounded subset refuses (and the org-wide ones left with none); the probes verify every policy, trigger and pin after apply). *Corrected in fix pass 2:* this paragraph used to say "until it is applied, the app half holds". It did not: every skill create named `share_requested` and every publish and re-enable named `share_requested` / `disabled_reason`, columns only this file adds, so before it is applied PostgREST refused them (PGRST204) and nobody could create, publish or re-enable a skill; a controller's built-in seed was refused by the old insert policy and showed an error banner. What holds before it is applied, since fix pass 2: creating a private skill, publishing, unsharing and switching skills (re-enabling included) work — the client names a 20261125 column only for a share request, and the guard stamps the rest after apply; a share request cannot be recorded (a new skill saves as its author's private skill and the Studio says so; the request control is not offered on a row without the column; asking on an existing skill says the feature needs this file); a controller's refused built-in seed is left to the service-role seeders (the engine, the answer pipeline) without an error; the engine switches a hung skill off without `disabled_reason`; private connection skills do not run; the Studio offers org-wide publishing to controllers only. What does NOT hold until it is applied: the database still admits a direct PostgREST write by any member — publishing org-wide, a member managing a built-in it seeded earlier, an unvalidated `config` — so the authority and pattern claims above are true only once the file is applied.

**Done-when.**
1. ✓ Built-in rows are seeded with `created_by = NULL`, so only `is_org_controller` touches them.
2. ✓ `link_rules_update` / `_delete` exclude built-in rows unless the caller is a controller (delete: always excluded).
3. ✓ Client seeding is controller-only and in one place; the engine's server-side seeding remains.
4. ✓ Toggling or deleting a skill writes an audit event naming the actor and the skill.

**Scope / residual.** None.

---

<a id="lnk-8"></a>

## LNK-8 · Dismissing one skill's proposal permanently silences every other skill for that pair — the block-set is keyed on the pair while the uniqueness contract is keyed on (pair, proposer)

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposerServer.ts:380-383`, `lib/linkProposalLogic.ts:404-412`, `supabase/migrations/20260807_link_proposals.sql:66-69`, `lib/linkProposalLogic.ts:388-400`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both facts are right, but the severity assumes an accident where the code documents an intent: 20260807_link_proposals.sql:66-67 says "Dismissals stay as rows so the engine never nags twice about the same pair", and the proposer repeats it at :378-379 ("a rejected pair must never come back to nag"). It is also mostly moot in practice — mergeDrafts (linkProposalLogic.ts:388-399) already collapses every pair to a single strongest draft before filtering, so two skills can never have live proposals for one pair anyway; the third index column is vestigial rather than a violated contract.

**Mechanism.** The table's unique index is `(document_id, target_document_id, proposer)` (migration :68-69) — deliberately three columns, so different skills can each hold an opinion about the same pair. But `mergeDrafts` collapses to one draft per PAIR before anything is written (`key = ${d.documentId}|${d.targetDocumentId}`, :392), and `decided` is likewise keyed on the pair alone (`decided.add(\`${r.document_id}|${r.target_document_id}\`)`, :382). So the three-column index can never actually hold two rows for a pair from the engine, and a single dismissal blocks all future skills.

**Failure scenario.** The Shared-equipment skill queues "Both reference E-101" (inferred, one tag, confidence 0.47). A reviewer clicks "Not related" — correctly: sharing one vessel does not make a safety datasheet related to a scaffolding permit. Months later the org authors a custom skill for its permit numbering, and the permit genuinely cites that datasheet by number — a strong, resolvable cross-reference. `filterDrafts` drops it because the pair is in `decided`. The reviewer rejected a weak equipment coincidence and, without knowing it, rejected a hard document reference that did not exist yet. There is no surface anywhere that shows a dismissed pair or lets it be reopened (listProposals defaults to `status: 'pending'`, linkProposals.ts:75, and no caller passes anything else).

**Evidence.**

```
supabase/migrations/20260807_link_proposals.sql:68-69 — `CREATE UNIQUE INDEX … proposed_links_pair_idx ON proposed_links (document_id, target_document_id, proposer);` vs lib/linkProposerServer.ts:382 `decided.add(\`${r.document_id}|${r.target_document_id}\`);` (two columns) and lib/linkProposalLogic.ts:392 `const key = \`${d.documentId}|${d.targetDocumentId}\`;`
```

> **Verifier correction.** Reframe: the pair-level block is the code's STATED intent, not a violated contract — linkProposerServer.ts:364-365 says "already decided (including dismissals — a rejected pair must never come back to nag)", and "these two documents are not related" is arguably a fact about the pair, not about the detector. The sharper, genuinely unintended consequence you should lead with instead: filterDrafts runs at :385 BEFORE splitByAutoApply at :387, so dismissing one weak `inferred` shared-equipment proposal also permanently suppresses a later PROVABLE off-page-connector auto-apply for the same pair — arithmetic evidence silenced by an opinion about different evidence. MEDIUM stands.

**Done when.**

- [ ] A dismissal blocks only the (pair, proposer) that produced it, or the dismissal UI asks "not related at all" vs "not this reason" and stores the distinction
- [ ] A dismissed-proposals view exists so a decision can be revisited (listProposals already accepts a status option that nothing uses)
- [ ] A test: dismiss a 'tag' proposal for a|b, then run a custom skill that finds a|b, and assert it queues

**Resolution (2026-09-30, intelligence Round G).** The block-set is keyed like the unique index: a dismissal blocks the `(pair, proposer)` that produced it; an approval settles the pair. `filterDrafts` now runs BEFORE `mergeDrafts`, so a dismissed opinion cannot win the merge and hide another skill's evidence — including the verifier's case, a later provable off-page reference after a dismissed shared-equipment guess, which now applies. The review page gains a "Dismissed" view, and `reopenProposal` (checked write) puts a dismissed proposal back in the queue. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("a dismissal blocks only its own skill's opinion, and is applied BEFORE the merge", "a dismissed inferred opinion does not silence a later provable reference", "dismissing the shared-equipment opinion leaves the work-order reference free to queue", "a dismissal can be reopened …").

**Done-when.**
1. ✓ A dismissal blocks only the (pair, proposer) that produced it.
2. ✓ A dismissed-proposals view exists, and a decision can be revisited.
3. ✓ Test: dismiss a `tag` proposal for a|b, run a custom skill that finds a|b, and it queues.

**Scope / residual.** None.

---

<a id="lnk-9"></a>

## LNK-9 · GraphShapeWizard writes an undeclared provenance value that the Related panel renders as "approved" — a link nobody reviewed is badged as having come through the proposal queue

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/graph/GraphShapeWizard.tsx:130-142`, `components/documents/RelatedPanel.tsx:173-183`, `lib/relatedResources.ts:19-24`, `supabase/migrations/20260807_link_proposals.sql:95-96`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mislabel is exactly as claimed — 'user' falls through the `!== "human"` test and lands in the else branch, so it badges "approved" with the tooltip "Approved from a proposal" and no approver name. Downgrading because the impact is confined to a display chip: the row itself is honest (proposer:"answer", created_by/created_by_name set, evidence.rule "Shaped from an answer"), and a human did accept it in the wizard, so nothing fabricated an unreviewed link — it is a one-token provenance-label bug.

**Mechanism.** The wizard inserts directly into document_related_resources with `origin: "user"` and `proposer: "answer"` (GraphShapeWizard.tsx:136-137). The declared domain is three values — `origin?: "human" | "system" | "proposed"` (relatedResources.ts:22) — and the column has a DEFAULT but no CHECK constraint (migration :96), so "user" is accepted. The renderer buckets by equality with a two-way fallthrough:

  {r.origin && r.origin !== "human" && ( … title={[
     r.origin === "system" ? "Applied automatically — provable connection"
                          : "Approved from a proposal", … ]}
     <Sparkles/> {r.origin === "system" ? "auto" : "approved"} )}   // RelatedPanel.tsx:173-182

"user" is neither "human" nor "system", so it falls into the else branch on both lines.

**Failure scenario.** An Admin shapes the graph from an AI answer and accepts a suggested document↔document link. It is written with origin 'user'. On the document's Related panel it renders a sparkle chip reading "approved" with the tooltip "Approved from a proposal" — and `approved_by_name` is null so no name appears to contradict it. In a PSM audit, "approved from a proposal" asserts a review step that never occurred; the link was created directly from a model's suggestion with no queue, no tier, and no second party. The evidence blob even carries `rule: "Shaped from an answer"` and a slice of the originating question (:138), which reads like proposal evidence.

**Evidence.**

```
components/graph/GraphShapeWizard.tsx:136-138 — `origin: "user", proposer: "answer", evidence: { summary: r.label, detail: evidenceDetail(r), rule: "Shaped from an answer" },`. components/documents/RelatedPanel.tsx:176,182 — `r.origin === "system" ? "Applied automatically — provable connection" : "Approved from a proposal"` and `{r.origin === "system" ? "auto" : "approved"}`. lib/relatedResources.ts:22 — `origin?: "human" | "system" | "proposed";`
```

**Done when.**

- [ ] The origin column gets a CHECK constraint over the exact set the renderer understands, and 'shaped' (or similar) is added as a first-class value with its own badge and tooltip
- [ ] RelatedPanel renders an explicit unknown-origin fallback instead of defaulting to "approved"
- [ ] Existing rows with origin='user' are backfilled to the correct value

**Resolution (2026-09-30, intelligence Round G).** The provenance set is declared once: `lib/relatedResources.ts` `LINK_ORIGINS = human | system | proposed | shaped`, where `'shaped'` is a link a person accepted while shaping the graph from an AI answer. `GraphShapeWizard` writes `'shaped'`; `originBadge` gives each value its chip and tooltip ("from answer — not reviewed in the proposal queue"), and a value the app does not know renders as unknown ("origin?"), never "approved"; the wizard's legacy `'user'` renders as `'shaped'` too, so links made before `20261126` is applied do not read as unknown in the meantime. `20261126` backfills `'user'` to `'shaped'`, adds a BEFORE trigger that normalises `'user'` (so a backup taken earlier restores whole), and adds `CHECK (origin IN (…the four…))` NOT VALID — binding every new row — VALIDATEd when no row outside the set remains (the inventory counts any). Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("provenance renders from the declared set; an unknown value is never 'approved'", "LNK-9: the origin normaliser, the backfill and the two-world CHECK").

**Pending migration:** `supabase/migrations/20261126_intel_roundG_link_conflict_targets.sql` (DEC-30: the inventory — `document_related_resources` rows with NULL `target_document_id`, pairs linked both ways, `origin` values outside the declared set, duplicate mention keys, `proposed_links` rows in status `stale` and pending, and the pending rows from a connection skill that is private (retired to `stale`; fix pass 3) — is captured before the DDL; the plain mention indexes and the VALIDATE of the origin CHECK happen only in the world where nothing violates them, and the final rows say which world was taken).

**Done-when.**
1. ✓ The origin column has a CHECK over exactly the set the renderer understands, and `'shaped'` is a first-class value with its own badge and tooltip.
2. ✓ The Related panel renders an explicit unknown-origin fallback.
3. ✓ Existing `'user'` rows are backfilled to `'shaped'`.

**Scope / residual.** None.

---

<a id="lnk-10"></a>

## LNK-10 · Shared-equipment queues one 'inferred' proposal for every document pair sharing a single tag — up to 780 rows from one tag — with no minimum, no per-tier cap, and no ranking before the 400-row slice

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposalLogic.ts:114,143,159-184`, `lib/linkProposerServer.ts:386-387`, `lib/linkProposalLogic.ts:388-400`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every element checks out, including the arithmetic (35 documents → 595 pairs). filterDrafts (linkProposalLogic.ts:404-412) removes only already-linked/already-decided pairs and does no ranking, and the only ordering in the system is display-side (linkProposals.ts:75-76), applied after the unranked 400 have already been chosen.

**Mechanism.** `MAX_TAG_FANOUT = 40` (:114) is the only brake: a tag on ≤40 documents produces every pairwise combination — C(40,2) = 780 — and `shared >= 3 ? "strong" : "inferred"` (:166) means a single shared tag still queues at confidence 0.47. There is no floor (`shared >= 2` is never required) and no cap on how many inferred rows one run may add. `capped = fresh.slice(0, BATCH)` (linkProposerServer.ts:386) takes the head of a Map-insertion-ordered list — never sorted by tier or confidence — so what survives the cut is decided by iteration order, not by strength.

**Failure scenario.** A refinery vessel V-201 legitimately appears on a P&ID, a PFD, a datasheet, an ITP, an inspection report, two MOCs, an isometric set and a work procedure — say 35 documents, all correctly bridged. The Shared-equipment skill emits 595 'inferred' proposals, each reading "Both reference V-201", each requiring a human click. Multiply across a few hundred tagged assets. The review queue becomes unusable, and — because approving is the only way to clear a pair from `decided` without permanently blacklisting it — reviewers either abandon the queue or mass-dismiss, which under the pair-keyed block-set (previous finding) permanently poisons those pairs against every future skill. The genuinely valuable proposals (strong, multi-tag, cross-reference) are buried in the same undifferentiated list; the page sorts by `tier` ascending then confidence (linkProposals.ts:75-76), and 'inferred' < 'provable' < 'strong' alphabetically, so INFERRED sorts FIRST.

**Evidence.**

```
lib/linkProposalLogic.ts:166-167 — `const tier: ProposalTier = shared >= 3 ? "strong" : "inferred"; const confidence = Math.min(0.9, 0.35 + shared * 0.12);` with no lower bound on `shared`. :143 `if (docs.size < 2 || docs.size > MAX_TAG_FANOUT) continue;` — 2..40 documents all pair up. lib/linkProposals.ts:75-76 — `.order("tier", { ascending: true }).order("confidence", { ascending: false })` — a TEXT column ordered alphabetically puts 'inferred' above 'provable' and 'strong'.
```

**Done when.**

- [ ] Single-shared-tag pairs are either not queued or are collapsed into one "N documents share V-201" review card that can be decided in one action
- [ ] `fresh` is sorted by tier rank then confidence before the BATCH slice, so the strongest findings survive the cap
- [ ] The queue's ordering uses the tier RANK (provable > strong > inferred), not alphabetical text ordering
- [ ] A per-run ceiling on 'inferred' rows keeps a single sweep from burying the queue

**Resolution (2026-09-30, intelligence Round G).** Four changes in `lib/linkProposalLogic.ts` / `lib/linkProposerServer.ts` / `lib/linkProposals.ts`. (1) Shared equipment proposes a pair only when it shares at least two registry items (`MIN_SHARED_TAGS`); a single shared item already shows each document to the other under "Found automatically" (the same bridge), so it no longer costs a review click — a vessel on 35 documents was 595 of them. (2) `rankDrafts` orders by tier rank, then confidence, then pair before the slice. (3) The queue orders by tier RANK: `listProposals` reads provable, then strong, then inferred. (4) The queue holds at most 150 `inferred` proposals at a time (`MAX_PENDING_INFERRED`); a run adds guesses only while there is room and counts the rest as held (`heldInferred`, with a note), without keeping the loop running. The ceiling fails closed: when the pending-inferred count cannot be read, the pass admits no new guesses and says why (fix pass). Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("ranks by tier strength …", "with the inferred room used up, new inferred proposals wait …", "listProposals returns provable, then strong, then inferred"), `lib/__tests__/linkProposalLogic.test.ts` (updated for the two-item floor). Fix pass 3: a refresh of an inferred row already pending takes no room under the ceiling (`LNK-1`).

**Done-when.**
1. ✓ Single-shared-tag pairs are not queued.
2. ✓ `fresh` is sorted by tier rank then confidence before the BATCH slice.
3. ✓ The queue orders by tier rank, not the text.
4. ✓ A ceiling on queued `inferred` rows keeps a sweep from burying the queue.

**Scope / residual.** The built-in skill's description row in existing orgs keeps its old wording until re-seeded (seeding fills missing built-ins only); the behaviour is the code's.

---

<a id="lnk-11"></a>

## LNK-11 · The 'semantic' proposer is advertised in the label table but never emitted, and the server-side revision-invalidation function has no callers

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposals.ts:47-53`, `lib/linkProposalLogic.ts:20`, `lib/linkProposerServer.ts:457-472`, `lib/postPublish.ts:129-134`, `lib/linkProposals.ts:181-194`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both absence claims verified by repo-wide search, so the finding is factually airtight — but it describes dead code and a stale label, which is LOW, not MEDIUM. Worth noting the finding actually understates one consequence it stumbled on: because postPublish routes through the client function, the UPDATE runs under the publisher's RLS and proposed_links_write (20260807:84-90) restricts writes to Admin/DocCtrl/Manager/Supervisor, so a publish by any other role silently stales nothing and returns 0 (linkProposals.ts:192).

**Mechanism.** Two pieces of scaffolding that read as working features. (a) `PROPOSER_LABELS` maps `semantic: "Similar content"` (linkProposals.ts:51) and the type union includes it (:11, linkProposalLogic.ts:20), but no code path ever sets `proposer: "semantic"` — the four emitters are 'opc' (:86), 'alias'|'tag' (:171), `rule:${id}` (:310) and 'co_citation' (:371). The migration is honest about this ("'semantic' (embedding similarity, reserved)", 20260807:32-33); the label table is not. The org HAS an embeddings layer (lib/ai/embeddings.ts, the semantic-layer migration), so this is a real, buildable gap presented as an existing capability. (b) `invalidateProposalsForRevision` — the org-scoped, service-role, correctly-`.eq("org_id")`-filtered version of the stale sweep — is exported and never imported; the only live caller is the browser-side `staleProposalsForDocument` (postPublish.ts:132), which omits the org filter and runs under proposed_links_write RLS (Admin/DocCtrl/Manager/Supervisor). A publisher outside those four roles silently updates zero rows — the function returns 0 on error with no signal (linkProposals.ts:192).

**Failure scenario.** An operator scanning the review page's proposer labels sees "Similar content" listed as one of the engine's detectors and reasonably concludes semantic similarity is contributing to the graph. It contributes nothing, and no diagnose() line mentions it (proposed-links/page.tsx:56-80 covers refs, registry, mirrors, questions and custom skills — never semantic). Separately, the stale sweep's behaviour depends on the publisher's role in a way nobody can observe: for an Engineer-role publisher it is a silent no-op, which — given the stale-blacklist finding above — is accidentally the SAFER outcome, so the bug is currently masking a worse one.

**Evidence.**

```
lib/linkProposals.ts:51 — `semantic: "Similar content",` in PROPOSER_LABELS. Searched three ways for an emitter: `grep -rn '"semantic"'` across ts/tsx (2 hits, both type unions); `grep -rn "proposer" lib components app` (every assignment site listed — opc, alias/tag, rule:, co_citation, and GraphShapeWizard's "answer"); `grep -rni "proposer: *[\"'\`]semantic"` (0 hits). For the dead function: `grep -rn "invalidateProposalsForRevision\|staleProposalsForDocument"` (definition + the one postPublish call to the OTHER function) and `grep -rn "from(\"proposed_links\")"` (10 hits, all accounted for).
```

> **Verifier correction.** Strengthen (b) rather than soften it. I verified the premise the finding only asserted: publishing is NOT restricted to the four roles in proposed_links_write. supabase/migrations/20260812_per_library_publish_authority.sql grants publish to any user/role/team holding the library ACL 'publish' action, and 20260816_owner_publish_access.sql additionally allows a document's effective owner. Such a publisher (e.g. a granted Drafting Supervisor or Engineer owner) hits an RLS-filtered UPDATE that matches zero rows and returns no error, so linkProposals.ts:192-193 returns 0 and postPublish's `.catch(() => {})` at :134 swallows even that — pending proposals for the superseded revision are never retired at all on those publish paths. MEDIUM stands.

**Done when.**

- [ ] Either an embedding-similarity proposer is implemented (the embeddings layer exists) or `semantic` is removed from PROPOSER_LABELS and the type union so the UI stops naming a detector that does not run
- [ ] postPublish calls the server-side `invalidateProposalsForRevision` through an API route with the service role, so the sweep does not depend on the publisher's role, and its result is logged
- [ ] `staleProposalsForDocument` either gains an org filter or is deleted

**Resolution (2026-09-30, intelligence Round G).** Decision (`DEC-55`): no detector is named until one emits. `semantic` is removed from `PROPOSER_LABELS` and from both `ProposerKind` unions. The publish-time sweep goes through the service role: `postPublish` → `requestProposalInvalidation` → `POST /api/links/invalidate` (see `LNK-1`: a caller who could publish the document, and only proposals whose evidence came from it) → `invalidateProposalsForRevision`, which is org-scoped, returns its error, and whose outcome is logged by the caller; a server caller can pass `serviceClient` to run it in-process. `staleProposalsForDocument` (RLS-bound, no org filter, a silent 0 for most publishers) is deleted. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("no label names a detector that does not run", "the publish pipeline sweeps on the service role …", "/api/links/invalidate …").

**Done-when.**
1. ✓ `semantic` is removed from `PROPOSER_LABELS` and the type unions.
2. ✓ `postPublish` calls `invalidateProposalsForRevision` through an API route with the service role, and the result is logged (a count when proposals were retired, a warning when the sweep did not run).
3. ✓ `staleProposalsForDocument` is deleted.

**Scope / residual.** None.

---

<a id="lnk-12"></a>

## LNK-12 · The 12-pass "bounded slices" driver is a treadmill: pending proposals are excluded from the block-set, so every pass recomputes the identical first 400 drafts, re-writes the same rows, and reports 12× the real count — while drafts 401+ never reach the queue

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposerServer.ts:375-386`, `lib/linkProposerServer.ts:410-428`, `lib/linkProposerServer.ts:438-447`, `app/(protected)/admin/proposed-links/page.tsx:105-131`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: nothing in the loop can shrink `fresh`, because the queued rows stay 'pending' and the auto-applied ones would only shrink it via `linked`, which LNK-3's 42P10 prevents in the first place. Drafts 401+ are unreachable until a human decides the first 400.

**Mechanism.** `fresh = filterDrafts(drafts, { linked, decided })`; `capped = fresh.slice(0, BATCH)` with BATCH=400; `more: fresh.length > capped.length` (:386, :444). The rows just written are status 'pending', and pending is explicitly skipped when building `decided` (:381, comment: "refreshed below, not blocked"). So on pass 2 the engine reads the same documents, recomputes the same drafts through the same deterministic Map-insertion order, and `fresh` is byte-identical to pass 1. `capped` is again the same first 400. The queue upsert uses `ignoreDuplicates: false`, so it UPDATEs those 400 rows in place and `proposed = rows.length` (:427) reports 400 again regardless of what actually changed. `more` is still true. The UI loops until `pass < 12` (proposed-links/page.tsx:107) and accumulates `proposed: (last?.proposed ?? 0) + (json.proposed ?? 0)` (:121).

**Failure scenario.** A 1,500-document library yields 3,000 fresh drafts. The Admin clicks "Find connections". Twelve full server passes run — each re-reading up to 5,000 documents, 20,000 document_assets rows, 20,000 existing links, 20,000 priors, and (if any custom skill exists) 2,400 knowledge_chunks — to rewrite the same 400 rows twelve times. The banner reads "Scanned 1500 documents · 0 provable connections applied · 4800 queued for review" while the queue actually holds 400. The remaining 2,600 discovered connections are unreachable until a human manually decides all 400, and the operator has no way to know that, because the number they were shown says the work is done.

**Evidence.**

```
lib/linkProposerServer.ts:381 `if (r.status === "pending") continue;` + :386 `const capped = fresh.slice(0, BATCH);` + :444 `more: fresh.length > capped.length` + :427 `proposed = rows.length` (attempted rows, not written rows). app/(protected)/admin/proposed-links/page.tsx:107 `for (let pass = 0; pass < 12; pass++)` and :121 `proposed: (last?.proposed ?? 0) + (json.proposed ?? 0)`.
```

> **Verifier correction.** Downgrade HIGH→MEDIUM and soften two claims. (a) It only triggers when fresh.length > 400 — below that `more` is false and the loop breaks at :128 on the first pass. (b) "drafts 401+ never reach the queue" is not permanent: once the first 400 are approved or dismissed they enter `decided` and the window advances on the next run, so it is a throughput ceiling, not a dead zone. (c) "the same first 400" depends on Map-insertion order derived from unordered DB reads (see finding 9), so byte-identity across passes is not guaranteed — but the count inflation (up to 12× on the summary bar at page.tsx:182) and the 11 wasted full re-scans are certain.

**Done when.**

- [ ] Slicing advances: either pending pairs are added to a per-run seen-set, or the run pages by a stable cursor (created_at / document id) instead of always taking the head of a recomputed list
- [ ] `proposed` counts rows actually inserted or changed, not `rows.length`
- [ ] `more: false` once a pass produces no NEW pair, so the client loop terminates on the first idempotent pass
- [ ] A test drives two consecutive runs over inputs producing 500 drafts and asserts run 2 queues the remaining 100, not the same 400

**Resolution (2026-09-30, intelligence Round G).** Pending proposals are in the block-set: a draft identical to the one already queued for its (pair, skill) is not new work (`dropAlreadyQueued`; a changed tier or confidence is, and is refreshed — and, since fix pass 2, a changed revision, source document, evidence line or page, `LNK-1`). Each pass therefore takes the next slice, `planBatch` sets `more` only while drafts that fit remain, and `proposed` counts the rows the upsert actually returned (inserted, re-opened or changed). The review page sums those real numbers, shows how many passes ran and whether more remain, and the loop stops on the first pass with nothing new. A pass that carries an error (a failed queue write, a provable link that could not be applied) returns `more: false`, so the driver does not repeat the same failing write twelve times (fix pass; "a queue write that fails returns more: false"). Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("two runs over 528 strong drafts queue 400, then the remaining 128; `proposed` is rows written" — a third run queues 0).

**Done-when.**
1. ✓ Slicing advances: pending pairs are in the block-set.
2. ✓ `proposed` counts rows actually inserted or changed.
3. ✓ `more` is false once a pass produces no new pair.
4. ✓ Test: two consecutive runs over more than 400 drafts — the second queues the remainder, not the same 400 (528 → 400 + 128).

**Scope / residual.** None.

---

<a id="lnk-13"></a>

## LNK-13 · Which of the two documents carries the approved link is decided by UUID sort order, so an approved connection appears in one document's Related panel and only as a backlink on the other

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/linkProposalLogic.ts:39-43`, `lib/linkProposals.ts:108-127`, `lib/relatedResources.ts:33-36`, `lib/relatedResources.ts:100-109`, `components/documents/RelatedPanel.tsx:173-183`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The asymmetry is real and is decided by UUID ordering, so roughly half of approved links render with the provenance chip and half do not. RelatedPanel.tsx:173-183 renders the "approved" badge and evidence tooltip only from the listRelatedResources rows, confirming the backlink side loses exactly the evidence the feature exists to show.

**Mechanism.** `orderPair` normalizes endpoints smallest-id-first so A→B and B→A cannot both exist (linkProposalLogic.ts:41-43) — correct for dedup. `approveProposal` then inserts `document_id: p.document_id, target_document_id: p.target_document_id` verbatim (linkProposals.ts:113-114), so `document_id` is whichever UUID sorts lower. But the reading side is directional: `listRelatedResources` filters `.eq("document_id", documentId)` (relatedResources.ts:36); the reverse direction is only reachable through `listBacklinks`, a separate query with a different render and a 25-row cap (:103-105). A manually-added link, by contrast, is created from the document the user is standing on, so its direction carries intent.

**Failure scenario.** A reviewer approves "44-PID-012 ↔ Pump datasheet PD-4471". Whether an engineer opening PD-4471 sees a Related pin with its evidence chip and "approved" badge, or merely a backlink entry in a different section without the evidence, depends on a random UUID comparison. Half of all approved connections land on the 'wrong' document from the user's point of view, and the asymmetry is invisible and unfixable from the UI. Secondary: if someone manually pins B→A while a proposal for the pair is already queued, approving it later inserts A→B — the partial unique index is on the ordered columns as stored, so both rows survive and the same relationship is listed twice with two different origins.

**Evidence.**

```
lib/linkProposalLogic.ts:41-43 `return a < b ? [a, b] : [b, a];` — lexicographic UUID compare. lib/linkProposals.ts:113-114 — inserts the pair as ordered. lib/relatedResources.ts:36 `.eq("document_id", documentId)` — one direction only. lib/relatedResources.ts:104-105 — `.eq("target_document_id", documentId).limit(25)` is the separate backlink path.
```

> **Verifier correction.** Soften the impact. The reverse direction is NOT missing from the inspector — components/documents/RelatedPanel.tsx:65 calls listBacklinks and renders the result as a "Linked from" section at :290-303, so the connection is visible from both documents. What the backlink side actually loses is the provenance badge, the evidence tooltip and the unpin control (all of which live only in the curated block at :173-183), plus it is capped at 25; and because auto-applied rows set no created_by, the backlink shows no "pinned by" attribution either. MEDIUM is right for that reduced claim.

**Done when.**

- [ ] Either approval writes both directions (and the panel dedups), or the Related panel unions outbound and inbound rows into one list so an approved link reads identically from both documents
- [ ] The engine's `linked` check and the unique index stay pair-normalized regardless, so dedup is preserved
- [ ] A test approves a proposal and asserts both endpoint documents render it in the same panel with the same evidence

**Resolution (2026-09-30, intelligence Round G).** Decision (`DEC-55`): the lower document number carries the row (`carrierOrder` — natural order, falling back to the id order), for auto-applied links and approvals alike; both documents render it. `approveProposal` first checks the pair in EITHER direction and writes nothing when it is already linked (the proposal still resolves); otherwise it inserts with the carrier order. `listRelatedResources` returns the links a document carries AND the document links carried by the other end (`direction: 'in'`), one entry per other document, so the Related panel shows an approved link identically from both documents — provenance chip, evidence tooltip and unpin control — and "Linked from" no longer repeats one of them. A link CARRIED by a document the viewer cannot read is not listed (its evidence and its unpin belong to that document — as `listBacklinks` never listed it); a link this document carries to a document the viewer cannot read says "restricted document", not "missing document" (fix pass). The engine's `linked` check stays pair-normalised (`orderPair`) and `proposed_links` stays pair-ordered. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("approval writes the row once, carried by the lower number, and both panels list it with its evidence", "a pair already linked the other way is not written twice …"), and the carrier unit test.

**Done-when.**
1. ✓ The Related panel unions outbound and inbound rows into one list, so an approved link reads identically from both documents.
2. ✓ The `linked` check and the proposal index stay pair-normalised; an approval never writes the reverse of an existing link.
3. ✓ Test: approve a proposal; both documents list it with the same evidence.

**Scope / residual.** Rows written before this round keep the direction they were written in; both panels render them either way.

---
