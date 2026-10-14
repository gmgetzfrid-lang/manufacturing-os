# 16 · Persistence & RLS across the layer

**19 findings** — 1 CRITICAL · 4 HIGH · 9 MEDIUM · 5 LOW (`IRLS-13`, `IRLS-14` and `IRLS-15` opened by intelligence Round G package I-08, 2026-09-30; `IRLS-16` opened by I-23, 2026-10-07; `IRLS-17` (MEDIUM), `IRLS-18` (LOW) and `IRLS-19` (MEDIUM) opened by I-17, 2026-10-14).

Table by table: who can write what, and which writes carry authority.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Every FOR ALL policy in the intelligence layer carries an explicit WITH CHECK — the composition trap (a FOR ALL policy with only USING silently reusing USING as the insert/update check) does not occur anywhere in these 20 migrations | `scripted enumeration of all 62 CREATE POLICY statements across 20260603/20260605/20260606/20260626/20260806/20260807/20260812/20260911/20260914/20260915/20260917/20260921/20260928/20260929/20260930/20261015/20261016/20261017` | This is the single most common RLS defect and it is absent. Fixes should preserve the discipline — every new FOR ALL policy must keep spelling out WITH CHECK even when it duplicates USING. |
| The four secret-bearing tables are locked with REVOKE ALL and zero policies, not with a permissive policy — ai_connections (api_key, embedding_api_key), ai_key_agreements, ai_usage_limits, platform_settings, plus knowledge_page_entities | `supabase/migrations/20260911_knowledge_ai.sql:43-44; 20260916_ai_governance.sql:42-43,65-66; 20260920_per_user_keys_real_limits.sql:29-30; 20260921_drawing_entities.sql:37-38` | RLS-enabled-with-no-policy plus REVOKE is the strongest available lockdown and it was applied consistently to exactly the tables that need it. The BYO key material is genuinely unreachable from a browser. |
| knowledge_chunks_select's source-linked exclusion is the correct pattern and the right instinct — it is the model the entity_mentions and knowledge_questions policies should be rewritten against | `supabase/migrations/20260917_knowledge_sources.sql:73-82` | The fix for the two CRITICAL leaks is not novel design work; it is copying this predicate onto two sibling tables that mirror the same text. |
| knowledge_sources has a SELECT policy and deliberately no write policy — writes go through the API where the adder's ACL on the container is verified server-side | `supabase/migrations/20260917_knowledge_sources.sql:41-48` | A worked example of read-open / write-through-a-route in this codebase. document_equipment_suggestions should be converted to exactly this shape. |
| semantic_search, semantic_coverage, graph_ask and knowledge_search_document are all SECURITY INVOKER with SET search_path, and each is REVOKE'd from public/anon then GRANT'd only to authenticated | `supabase/migrations/20260930_semantic_layer.sql:97-98,119-120; 20261007_rag_hardening.sql:100-103; 20260929_mention_engine.sql:112-115,133-134; 20261012_doc_targeted_search.sql:48-49` | The retrieval RPCs cannot be used to escape RLS, and the grant hygiene is uniform. Note the corollary: because they are INVOKER, a browser call to semantic_coverage undercounts source-linked chunks — a correctness quirk, not a leak. |
| proposed_links' unique index is a plain three-column index that its writer's onConflict matches exactly, so the review-queue branch of the proposal spine writes correctly even though the auto-apply branch does not | `supabase/migrations/20260807_link_proposals.sql:68-69 vs lib/linkProposerServer.ts:423-425` | Confirms the auto-apply failure is specific to the partial index on document_related_resources, not a general problem with the proposer's write layer — the fix is narrow. |
| Custom Connection Skills can never reach the 'provable' tier; splitByAutoApply routes only 'provable' to auto-apply, and every custom-rule draft is tiered 'strong' or 'inferred' | `lib/linkProposalLogic.ts:279,311,416-423` | Bounds the link_rules authority hole: a member-authored Connection Skill can flood the review queue but cannot write a link behind a human's back. The same containment does NOT exist for answer_skills, which is why that one is rated HIGH and this one is not a separate finding. |
| issue_document_number is SECURITY DEFINER with SET search_path, row-locks with FOR UPDATE, and re-checks org membership inside the function body rather than trusting the caller | `supabase/migrations/20260806_intelligence_layer.sql:147-170` | The house style for a definer function done right — search_path pinned, authority re-derived from auth.uid() inside the body. is_org_controller should be brought up to this standard. |
| The partial-index / ON CONFLICT inference trap is already understood in this codebase and worked around correctly in two places | `lib/answerSkills.ts:56-59 and lib/answerSkillsServer.ts:68-70` | Both ON CONFLICT findings are the same known bug in places the author did not revisit. The comment text is the argument for the fix — no new analysis is needed to justify it. |


---


<a id="irls-1"></a>

## IRLS-1 · knowledge_questions is org-wide readable, so every AI answer derived from ACL-protected documents leaks to every member

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260911_knowledge_ai.sql:146-151`, `supabase/migrations/20260917_knowledge_sources.sql:73-82`, `app/api/knowledge/ask/route.ts:1739-1743`, `lib/knowledge.ts:504-527`, `lib/knowledge.ts:529-533`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Per-asker ACL filtering is real and the code says so — ask/route.ts:160-186 builds excludedDocIds via `readableControlledDocIds(principal, dcIds)` and comments "two people can ask the same question and correctly get different answers. … Fails CLOSED". Both readers (lib/knowledge.ts:504-527 searchAskHistory, :529-533 listKnowledgeQuestions) use the RLS-bound `supabase` client filtered only by org_id/library_id, so the stored answer text is org-wide. No later migration narrows knowledge_questions_select (grep over supabase/ confirms only ALTERs adding columns).

**Mechanism.** 20260917 deliberately closed direct member reads of source-linked chunks: `CREATE POLICY knowledge_chunks_select ... AND NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id = knowledge_chunks.document_id AND d.source_document_id IS NOT NULL)` — the stated reason being "Linked chunks mirror ACL-protected controlled documents, so direct reads are closed; the ask API (service role) filters them per asker." But the ask route then writes the finished answer, verbatim, into knowledge_questions: `await supabaseAdmin.from("knowledge_questions").insert({ org_id, library_id, user_id, user_name, question, answer, citations, provider, model, mode: "library", ... })` (route.ts:1739). The only SELECT policy on that table is `knowledge_questions_select ... USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_questions.org_id AND uid = auth.uid() AND status = 'active'))` — no ACL predicate, no per-library predicate, no author predicate. And two browser functions read it with the anon client scoped only by org: `searchAskHistory` filters `.eq("org_id", orgId)` and `listKnowledgeQuestions` filters `.eq("library_id", libraryId)`. The per-asker ACL filtering the ask route performs is therefore a one-time gate whose output is published org-wide.

**Failure scenario.** An Engineer with ACL access to the confidential PSM incident-investigation folder asks "what were the findings on the 2026 reactor overpressure". The ask route filters retrieval to documents that Engineer may read, and the model returns a cited answer quoting those pages. The row lands in knowledge_questions. A Requester or Accounting member — no ACL on that folder at all — opens the Ask surface, types eight characters of the same topic, and searchAskHistory returns the full `answer` text plus `citations` naming the document ids and page numbers. No document was opened; the ACL engine was never consulted on the read.

**Evidence.**

```
20260911_knowledge_ai.sql:146-151 — `CREATE POLICY knowledge_questions_select ON knowledge_questions FOR SELECT USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_questions.org_id AND uid = auth.uid() AND status = 'active'));` followed by the comment `-- Inserts happen server-side (service role) from /api/knowledge/ask.` — the migration author considered writes and never considered that the answer text carries the protected content. lib/knowledge.ts:510-516 — `supabase.from("knowledge_questions").select("id, library_id, question, answer, user_name, created_at, citations").eq("org_id", orgId).textSearch("search_tsv", q, ...)` using the browser anon client (`import { supabase } from "@/lib/supabase"`, lib/knowledge.ts).
```

> **Verifier correction.** Only nit: the display path is the ask-memory card and the per-library history panel (page.tsx:1690, :1464), plus app/(protected)/intelligence/page.tsx:113 — worth naming in the fix so all three are covered.

**Done when.**

- [ ] knowledge_questions_select is narrowed to the asker (`user_id = auth.uid()`) plus controllers, OR history reads move behind an API route that re-runs the ACL engine against every citation before returning the answer
- [ ] searchAskHistory and listKnowledgeQuestions no longer read knowledge_questions with the browser anon client
- [ ] a test asserts a member with no ACL on a source-linked document cannot retrieve an answer whose citations point at it


**Resolution (2026-09-30, intelligence Round G).** Reproduced first (see `ASK-1` / `KACL-1`, same root and same code). `20261120` re-creates `knowledge_questions_select` from 20260911's body with the author-or-controller clause ANDed (`user_id = auth.uid()` OR `is_org_controller(org_id)`), and `app/api/knowledge/history/route.ts` (new) serves the team's record — `list` (the Conversations list), `search` (ask memory, scoped to THIS library) and `thread` (reopen one conversation) — through `lib/knowledgeHistory.ts` (new): every row's citations are re-decided for the CURRENT reader through the R&P Round C1 seam (`loadPrincipal` + `readableControlledDocIds`, never a parallel evaluator; `readableKnowledgeDocIds` resolves each cited knowledge document — an upload of the reader's org is readable by design, a mirror is readable when its controlled document is, anything unresolvable (removed, held back from the AI, another org's, malformed) is not). A row citing anything unreadable is withheld whole, and so is every later turn of its conversation, because the ask sends earlier turns back as context (`planVisibleHistory`); the number withheld is returned and shown. Controllers skip the filter (DEC-43). A library answer that cites NO document — the model answered without an `[n]` marker, every marker was invented and stripped, or a "Nothing matches" row naming the asker's own indexing gaps — proves nothing about its sources, so it is shown to its asker only (and to controllers); an internet-mode answer is shown to all (review fix: `planVisibleHistory(rows, threadRows, readable, readerUid)`, `lib/__tests__/knowledgeMemoryAcl.test.ts` "a LIBRARY answer citing no document is its asker's alone" and "a library answer with no citations reaches no other member"). A failed read of the stored answers, of the cited knowledge documents or of the controlled documents answers 500 with no rows — never an unfiltered answer. One seam read does not fail closed by itself: `loadDcLandscape` (`lib/knowledgeAccess.ts`, not this package's file) ignores a failed `libraries` / `collections` read, so a document restricted ONLY by its library or folder ACL would be judged by its own ACL alone. Fix pass 2: `readableKnowledgeDocIds` makes those same two reads first (for a non-controller, whenever a mirror is cited) and throws when either fails, so the route answers 500 with no rows (`lib/__tests__/knowledgeMemoryAcl.test.ts` "reproduction: the seam judges a document restricted ONLY by its library's ACL as readable when the libraries read fails" and "…so the history route checks the libraries and folders reads first"). A read failing between that check and the seam's own is the window left — closed when the seam's owner makes `loadDcLandscape` throw (see the residual). `lib/knowledge.ts` `searchAskHistory(orgId, libraryId, …)`, `listKnowledgeQuestions(orgId, libraryId)` and the new `loadConversation` call the route; `lib/knowledge.ts` and the knowledge page no longer read `knowledge_questions` (the hub's recent-questions widget, `app/(protected)/intelligence/page.tsx`, I-05's file, still reads it in the browser; the narrowed policy now limits it to the reader's own rows, every row for a controller — corrected in fix pass 4, this sentence used to say the browser no longer reads the table at all). On the page, the memory card searches this library only; `openConversation` re-reads a threaded conversation through the route and keeps its thread only when every turn is the reader's own and none was withheld (a teammate's turns, or a thread holding a turn the reader can no longer see, seed a NEW conversation — so the next ask is never appended to someone else's, nor behind a withheld turn that would withhold it too); the Conversations list says how many answers it is not showing and shows a failed read as a failure. Fix pass 2 (review minor): that line, the reopen notices and the empty state said every withheld answer "cites documents you can't open" — untrue of a teammate's library answer that cites no document, which is withheld too; they now say what is true of every reason ("… they draw on documents you can't open (or that have since left this library), or they are teammates' answers that cite no document, which only whoever asked can see"), pinned in `knowledgeMemoryAcl.test.ts`. Verified on a scratch PostgreSQL 16 carrying the live policy and helper bodies (`node_visible` 20261041, `is_org_controller` 20260814, `acl_subject_in_bucket` 20260708, the 20260911 / 20260917 / 20260929 knowledge policies; the owner cascade stubbed to its document-owner arm), the whole paste applied as the user will paste it: BEFORE, a Viewer read every stored answer, every mirror row (a private document's and a dangling one included) and every mention sentence; AFTER, a Viewer reads their own answer, the upload and open-document mirrors and those documents' sentences; a Manager (who holds the FOR ALL `entity_mentions_write`) reads exactly the Viewer's sentences; an Engineer granted read on the private document reads their own answer, that mirror and its sentence; an Admin and a Viewer holding DocCtrl additively read everything (DEC-43); a non-member reads nothing and the hub count answers 0. All seven probes were true on the first apply and again on a second (idempotent). That run did not read `knowledge_chunks`, and the review found the gap it left: 20260917's `knowledge_chunks_select` hides a mirror's chunks with `NOT EXISTS` over `knowledge_documents`, which runs under the caller's RLS, so once `knowledge_documents_select` hides a mirror row the `NOT EXISTS` passes and the chunks OPEN. Fix pass 2: `20261120` re-creates `knowledge_chunks_select` in the same transaction with the same rule written positively (`EXISTS … AND d.source_document_id IS NULL` — an upload row the caller can see; lineDiff-pinned against 20260917), counts the chunks of private / hidden documents' mirrors before apply, probes the positive form, and probes that no policy in the database tests `NOT EXISTS` over `knowledge_documents`, `knowledge_questions` or `entity_mentions`; `lib/__tests__/knowledgeMemoryAcl.test.ts` replays schema.sql and every migration's policies to the same end. Re-run on a second scratch PostgreSQL 16 (the verbatim 20260911 / 20260917 / 20260929 policies and 20261012's `knowledge_search_document`): before the paste a Viewer read only the upload passage; with the paste minus the chunk section a Viewer read the private and the hidden mirror's passages, directly and through `knowledge_search_document`, and the two new probes were false (the reproduction); with the full paste a Viewer, an Engineer granted the private document and a Manager read only the upload passage and nothing through `knowledge_search_document`, an Admin read every passage (`knowledge_chunks_write`), and all eight probes were true on the first apply and on a second.

Fix pass 3 (2026-09-30, review; detail on `ASK-1`): a conversation started from someone else's record no longer sends its seeded turns back to the model (`askContextHistory`, `lib/knowledge.ts`). The follow-up used to be stored in a new thread with only its own citations, so it could reach readers denied the seeded turn's source. `search` no longer reports how many matches it withheld, which was an oracle over restricted text. This finding stays RESOLVED on its own done-when: the policy is narrowed, and every read goes through the route and re-runs the ACL engine on every citation. The broader "judged by every source, not only the cited ones" is recorded OPEN on `ASK-1`, `KACL-1` and `IEDGE-5`.

Fix pass 4 (2026-09-30, review; detail on `ASK-1`): `search` pages through the matches until it holds `limit` rows the reader may see (at most 500 looked at, and a `limit` below the default ignored). The old fixed window, sized by the caller's `limit` and trimmed after filtering, still leaked a coarse count of restricted matches. `readableKnowledgeDocIds` reads the reader's teams again and fails closed, because `loadPrincipal` drops a failed `team_members` read and a team DENY then never matches. The sentence "the browser no longer reads `knowledge_questions` at all" is corrected in place: the hub widget (I-05) still reads it, limited by the narrowed policy to the reader's own rows. Done-when 2 below was always about `lib/knowledge.ts` and stays met.

Fix pass 5 (2026-09-30, review minor; detail on `ASK-1`): the route's floor of 5 on a search `limit` made the "asked before" card list 5 past answers instead of the page's 3. `searchAskHistory` now trims the route's rows to the caller's `limit`. The floor stays, because a smaller limit's answer is a prefix of the larger one's.

**Pending migration:** `supabase/migrations/20261120_intel_roundG_knowledge_memory_acl.sql` (inventory before apply: stored answers; answers citing a mirror of a private / hidden / private-draft document; answers citing a knowledge document that no longer exists; non-controller members; mirror rows, those of private / hidden documents and dangling ones; the chunks of private / hidden documents' mirrors (fix pass 2); mention rows and those on private / hidden documents).

**Done-when.**
1. ✓ Both: the policy is narrowed to the asker plus controllers, AND history reads go through a route that re-runs the ACL engine against every citation.
2. ✓ `searchAskHistory` and `listKnowledgeQuestions` no longer read `knowledge_questions` with the browser client.
3. ✓ `lib/__tests__/knowledgeMemoryAcl.test.ts` ("a member with no ACL on a source-linked document cannot retrieve an answer whose citations point at it — search, list or thread").

**Scope / residual.** The third display path the verifier named, the hub's recent-asks widget (`app/(protected)/intelligence/page.tsx:113`, I-05's file), now reads only the reader's own rows under the narrowed policy (all rows for a controller); I-05 relabels it. A stored row records only the documents it CITES. A library answer citing none is shown to its asker alone. One citing SOME readable documents is shown to other members even when its text drew on an uncited restricted passage. That leak is recorded OPEN on `ASK-1`, `KACL-1` and `IEDGE-5`, with the ask-route write of the retrieved set as a blocking handoff to I-03. `loadDcLandscape` should still throw on a failed read (handed to the seam's owner): the history route now checks the same two reads first and answers 500 when either fails, which leaves only a failure between that check and the seam's own read. `loadPrincipal` should throw on a failed `team_members` read too (handed to the seam's owner): it drops the error and returns no teams, so a team DENY never matches; until it throws, `readableKnowledgeDocIds` reads the reader's teams again, fails closed when that read fails, and judges the mirrors with the teams it read (fix pass 4).

---

<a id="irls-2"></a>

## IRLS-2 · 'Provable' link auto-apply names a partial index as its conflict target and fails on every run, with the error swallowed into a note

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260807_link_proposals.sql:110-113`, `lib/linkProposerServer.ts:403-407`, `lib/linkProposalLogic.ts:416-423`, `lib/answerSkills.ts:56-59`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: grep over supabase/ shows the partial index is the ONLY unique constraint on that pair (the table's only other key is `id UUID PRIMARY KEY` at 20260806_intelligence_layer.sql:69), so ON CONFLICT with a bare column list cannot be inferred → 42P10 on every autoApply batch, swallowed into notes with autoApplied left at 0. The codebase already knows this failure mode: lib/answerSkills.ts:56-58 says "the unique (org_id, builtin_key) index is PARTIAL, which ON CONFLICT can't infer through the API, so an upsert here fails wholesale." The sibling proposed_links upsert works because proposed_links_pair_idx (20260807:68-69) is not partial.

**Mechanism.** 20260807 creates `CREATE UNIQUE INDEX IF NOT EXISTS document_related_resources_doc_target_idx ON document_related_resources (document_id, target_document_id) WHERE target_document_id IS NOT NULL;` — a PARTIAL index. The auto-apply writer asks for `onConflict: "document_id,target_document_id"` with no index predicate. Postgres excludes partial indexes from inference unless the ON CONFLICT clause restates the predicate, so this is 42P10 at plan time. The result is not thrown: `if (error) notes.push(\`Auto-apply skipped: ${error.message}\`); else autoApplied = rows.length;`. Meanwhile splitByAutoApply routes exactly the tier the migration promised applies itself — `autoApply: drafts.filter((d) => d.tier === "provable")` — into that dead path, and the queue branch (proposed_links, whose index IS a plain three-column unique) writes fine. So the spine's headline behaviour, "Provable ones apply themselves," is the one branch that cannot write.

**Failure scenario.** A P&ID off-page connector resolves to exactly one sheet — the arithmetic case the migration calls provable. The proposer builds the draft, splitByAutoApply puts it in autoApply, the upsert raises 42P10, `notes` gains a line nobody surfaces prominently, and `autoApplied` stays 0. The link never appears on the document, never appears on the graph, and never appears in the review queue either — because provable drafts are excluded from `queue`. The connection is silently discarded on every run.

**Evidence.**

```
lib/linkProposerServer.ts:403-407 — `const { error } = await admin.from("document_related_resources").upsert(rows, { onConflict: "document_id,target_document_id", ignoreDuplicates: true }); if (error) notes.push(\`Auto-apply skipped: ${error.message}\`); else autoApplied = rows.length;` against 20260807_link_proposals.sql:111-113 `CREATE UNIQUE INDEX IF NOT EXISTS document_related_resources_doc_target_idx ON document_related_resources (document_id, target_document_id) WHERE target_document_id IS NOT NULL;`. The identical trap is documented in lib/answerSkills.ts:56-58.
```

**Done when.**

- [ ] the partial index is replaced by a full unique index (target_document_id is NOT NULL on every row this writer produces), or the writer selects-then-inserts instead of upserting
- [ ] a provable draft that fails to apply falls back into the review queue instead of vanishing
- [ ] 'Auto-apply skipped' is surfaced as an error on the Find-connections surface, not appended to a notes array

**Resolution (2026-09-30, intelligence Round G).** See `LNK-3`: `20261126` replaces the partial index with the plain `document_related_resources_doc_target_uniq`, and the auto-apply write targets it; when the batch fails each row is inserted alone (23505 = already linked), a row that still fails is queued for a person as a provable proposal instead of vanishing, and the failure is a run ERROR rendered as a red banner on the Find-connections surface. Tests: `lib/__tests__/linkProposalsRoundG.test.ts`.

**Pending migration:** `supabase/migrations/20261126_intel_roundG_link_conflict_targets.sql` (DEC-30: the inventory — `document_related_resources` rows with NULL `target_document_id`, pairs linked both ways, `origin` values outside the declared set, duplicate mention keys, `proposed_links` rows in status `stale` and pending, and the pending rows from a connection skill that is private (retired to `stale`; fix pass 3) — is captured before the DDL; the plain mention indexes and the VALIDATE of the origin CHECK happen only in the world where nothing violates them, and the final rows say which world was taken).

**Done-when.**
1. ✓ The partial index is replaced by a full unique index (target NULL rows stay unconstrained, NULLs being distinct).
2. ✓ A provable draft that fails to apply falls back into the review queue.
3. ✓ "Auto-apply" failures are errors on the run, surfaced as an error, not a note.

**Scope / residual.** None.

---

<a id="irls-3"></a>

## IRLS-3 · Any active member — Requester, Accounting — can publish instructions that ride every colleague's AI answer prompt

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261016_reasoning_skills.sql:44-49`, `supabase/migrations/20261016_reasoning_skills.sql:51-54`, `lib/answerSkills.ts:73-96`, `lib/answerSkills.ts:100-108`, `lib/answerSkillsServer.ts:28-47`, `lib/roleCapabilities.ts:48-61`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. lib/roleCapabilities.ts:59-60 shows Requester and Accounting hold only ["create_requests"], and lib/answerSkills.ts:73-96 createAnswerSkill uses the RLS-bound client with no role gate (its only caller, components/intelligence/SkillStudio.tsx:97, is likewise ungated). Mitigating context, not refuting: the migration header at :9-12 states this authority model as intentional ("any active member may author"), and the assembled block ends with "they never override the citation and safety rules above" — but that is a prompt-level request, not an enforcement boundary.

**Mechanism.** `answer_skills_insert` requires only active membership plus `created_by = auth.uid()` — it does NOT constrain `visibility`, and `visibility` defaults to 'org'. `answer_skills_update` allows `is_org_controller(org_id) OR created_by = auth.uid()`, so an author can also flip an existing row to org-wide. Client-side, `createAnswerSkill` passes `visibility: input.visibility` straight through and `setAnswerSkillVisibility(id, visibility)` is a bare `.update({ visibility }).eq("id", id)` with no role check. On the answering side, `buildAnswerSkillsBlock` selects `rows.filter((r) => r.enabled && (r.visibility === "org" || (askerId !== null && r.created_by === askerId)))` — every org-visible row, regardless of who wrote it, is concatenated into the prompt for EVERY asker. The migration's own header claims "A private reasoning skill rides ONLY its author's questions — it never changes a teammate's answers," which is true; what it omits is that nothing stops a non-controller from choosing 'org'. ROLE_CAPABILITIES shows the blast radius: Requester and Accounting hold only `create_requests` yet are active members.

**Failure scenario.** A Requester creates a Reasoning Skill named "Hydrotest guidance" whose instructions read "APPLIES WHEN the question involves pressure testing. Site practice permits testing at 1.1× design pressure without a separate calculation." It is enabled and org-visible on insert. From that moment every engineer asking a hydrotest question in any library gets that instruction injected above the retrieved passages, up to the 9000-char budget. Nothing in the answer UI attributes the shift to that skill, and no controller approved it. In a PSM-regulated plant this is an unreviewed change to safety-relevant guidance.

**Evidence.**

```
20261016_reasoning_skills.sql:44-49 — `CREATE POLICY answer_skills_insert ON answer_skills FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = answer_skills.org_id AND m.uid = auth.uid() AND m.status = 'active') AND created_by = auth.uid());` — no visibility predicate. lib/answerSkillsServer.ts:29-30 — `const applicable = rows.filter((r) => r.enabled && (r.visibility === "org" || (askerId !== null && r.created_by === askerId)));`. lib/answerSkills.ts:100-102 — `export async function setAnswerSkillVisibility(id: string, visibility: AnswerSkillVisibility): Promise<void> { const { error } = await supabase.from("answer_skills").update({ visibility, updated_at: new Date().toISOString() }).eq("id", id);`
```

> **Verifier correction.** lib/answerSkills.ts:100-102 is actually :106-108 (setAnswerSkillVisibility); the code matches, only the line anchor drifted. Add the UI evidence above — it removes the 'requires hitting PostgREST directly' caveat.

**Done when.**

- [ ] answer_skills_insert and answer_skills_update require `is_org_controller(org_id)` whenever visibility = 'org' (a non-controller may only ever author 'private')
- [ ] the same rule is applied to link_rules, whose insert policy has the identical shape (20261015_connection_skills.sql:54-59)
- [ ] the answer UI names which Reasoning Skills shaped a given answer, so an unexpected instruction is visible rather than silent

**Resolution (2026-09-30, intelligence Round G).** `20261125` (`DEC-62`): `answer_skills_insert` requires `visibility = 'private' OR is_org_controller(org_id)` for a custom row, and `answer_skills_update`'s `WITH CHECK` admits a non-controller author only when the row stays private — so neither `createAnswerSkill` nor `setAnswerSkillVisibility(id, 'org')` can publish for a Requester or Accounting member; the client functions are checked writes and say so. `link_rules` has the same predicates. A member asks to share (`share_requested`); a controller approves. The controllers' read of private rows admits that decision and nothing else on a member's private row — the guards refuse any other change by a non-author, and no person changes a skill's author (fix pass 2, `IEDGE-3`). Tests: `lib/__tests__/skillsAuthority.test.ts`. Fix pass 3: the author branch of both UPDATE `WITH CHECK`s also requires active membership of the row's org, and a person's update cannot change a skill's org or byline (`GOV-2`, `IEDGE-3`). Fix pass 4 (*corrected*): "a controller approves" was not bound to a request — the guards now refuse a non-author's publish of a private skill unless its author's request is open, and refuse a non-author raising it; an author's edit withdraws a waiting request; the Skill Library approves by the version it showed (`IEDGE-3`, verified on a local PostgreSQL 16). Fix pass 5 (*corrected*): that version was the row's `updated_at`, which a person's INSERT could choose — a draft deleted and re-inserted under its old id and date passed a stale approval; both guards now give a person's new row the database's id, `created_at` and `updated_at` (`IEDGE-3`, verified on a local PostgreSQL 16).

**Pending migration:** `supabase/migrations/20261125_intel_roundG_skills_authority.sql` (DEC-30: the pre-apply inventory — built-ins carrying a member uid, org-wide custom skills whose author is not an active controller, packs without APPLIES WHEN or over 4,000 characters, connection skills over the pattern limits, non-controller members, custom skills whose byline is not their author's member address (re-signed; fix pass 3), and the private custom skills that become readable by controllers (the one read this file widens, with the one decision it admits — approving or declining a member's share request) — is captured into a TEMP TABLE before the DDL and printed in the one result set, with after rows counting the share requests and the custom connection skills that hold a pattern the bounded subset refuses (and the org-wide ones left with none); the probes verify every policy, trigger and pin after apply). *Corrected in fix pass 2:* this paragraph used to say "until it is applied, the app half holds". It did not: every skill create named `share_requested` and every publish and re-enable named `share_requested` / `disabled_reason`, columns only this file adds, so before it is applied PostgREST refused them (PGRST204) and nobody could create, publish or re-enable a skill; a controller's built-in seed was refused by the old insert policy and showed an error banner. What holds before it is applied, since fix pass 2: creating a private skill, publishing, unsharing and switching skills (re-enabling included) work — the client names a 20261125 column only for a share request, and the guard stamps the rest after apply; a share request cannot be recorded (a new skill saves as its author's private skill and the Studio says so; the request control is not offered on a row without the column; asking on an existing skill says the feature needs this file); a controller's refused built-in seed is left to the service-role seeders (the engine, the answer pipeline) without an error; the engine switches a hung skill off without `disabled_reason`; private connection skills do not run; the Studio offers org-wide publishing to controllers only. What does NOT hold until it is applied: the database still admits a direct PostgREST write by any member — publishing org-wide, a member managing a built-in it seeded earlier, an unvalidated `config` — so the authority and pattern claims above are true only once the file is applied.

**Done-when.**
1. ✓ `answer_skills_insert` and `answer_skills_update` require `is_org_controller(org_id)` whenever `visibility = 'org'`.
2. ✓ The same rule on `link_rules`.
3. Not done here — naming the reasoning skills that shaped an answer changes the ask route and the answer UI, which belong to another package (I-03). Opened as `IRLS-13` (`DEC-31`).

**Scope / residual.** `IRLS-13`.

---

<a id="irls-4"></a>

## IRLS-4 · The mention engine's upsert names a conflict target Postgres cannot resolve — entity_mentions has never been written

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260929_mention_engine.sql:59-60`, `lib/mentionIndexer.ts:136-142`, `lib/answerSkills.ts:56-59`, `lib/answerSkillsServer.ts:68-70`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: grep over supabase/ shows entity_mentions_unique_idx is the table's only unique index besides `id UUID PRIMARY KEY`, and `COALESCE(knowledge_document_id, document_id)` cannot be matched by the plain column `knowledge_document_id` in ON CONFLICT → 42P10, which is thrown rather than swallowed (unlike IRLS-2). lib/mentionIndexer.ts:138 is the sole write path in the repo (grep for entity_mentions shows every other TS hit is a SELECT or DELETE, except the generic lib/dataRestore.ts restore list).

**Mechanism.** The only unique index is an EXPRESSION index: `CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_unique_idx ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page);`. The writer asks for a plain column-list arbiter: `.upsert(batch, { onConflict: "asset_id,knowledge_document_id,page", ignoreDuplicates: false })`. PostgREST renders that as `ON CONFLICT (asset_id, knowledge_document_id, page)`. Unique-index inference matches an expression index only when the conflict target restates the expression; a bare column list does not match `COALESCE(knowledge_document_id, document_id)`. Postgres raises 42P10 at PLAN time — before any row is examined — so the preceding delete-then-insert pattern does not save it. `indexDocumentMentions` converts that into `throw new Error("mention index write: " + error.message)`. The codebase already knows this failure mode in the sibling case: lib/answerSkills.ts:56-58 — "the unique (org_id, builtin_key) index is PARTIAL, which ON CONFLICT can't infer through the API, so an upsert here fails wholesale." Nobody applied the same reasoning to the expression index.

**Failure scenario.** An admin clicks "Build the mention index" on /api/graph/mentions, or a knowledge ingest finishes and calls indexDocumentMentions (app/api/knowledge/ingest/route.ts:158-162). The delete of prior non-explicit rows succeeds; the first upsert batch throws 42P10; the function throws. Every document↔asset edge the graph is supposed to derive from text is absent, the /assets/<tag> backlinks panel renders empty, and lib/mentions.ts's `tolerate()` helper reports the empty result as a benign "migration hasn't run" setup state rather than a write failure — so the panel looks like it is waiting for setup forever.

**Evidence.**

```
lib/mentionIndexer.ts:136-142 — `const { error } = await supabaseAdmin.from("entity_mentions").upsert(batch, { onConflict: "asset_id,knowledge_document_id,page", ignoreDuplicates: false }); if (error) throw new Error(\`mention index write: ${error.message}\`);` against 20260929_mention_engine.sql:59-60 `CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_unique_idx ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page);`
```

> **Verifier correction.** Two precisions. (1) 'Never written' is right for the normal path but not absolute: the upsert is skipped when a document produces zero matches, and lib/dataRestore.ts:298 lists entity_mentions as a restore target, so a backup restore could seed rows. (2) Nobody sees the failure on the main path — app/api/knowledge/ingest/route.ts:158-169 wraps the call in `try { ... } catch { /* mention edges are a bonus — never block ingestion */ }`; only the controller-only POST /api/graph/mentions surfaces it as a 500. No DB was run; this is a static deduction from documented Postgres inference rules.

**Done when.**

- [ ] either the index is replaced with a plain unique constraint on (asset_id, knowledge_document_id, page) plus a second one for the document_id branch, or the writer stops using upsert and relies on the existing wholesale delete + plain insert
- [ ] lib/mentions.ts stops classifying an empty result as "migration hasn't run" — a write failure and an unbuilt index must look different
- [ ] /api/graph/mentions surfaces the row count it actually wrote, and the graph reports zero mention edges as a problem rather than as an empty map

**Resolution (2026-09-30, intelligence Round G).** `20261126` replaces the COALESCE expression key with two indexes of the same meaning: a PLAIN unique `entity_mentions_kdoc_page_uniq (asset_id, knowledge_document_id, page)` — the indexer's conflict target — and `entity_mentions_doc_page_uniq (asset_id, document_id, page)` over the rows that have no knowledge document (one controlled document can be mirrored in several libraries, `20260919`, so the document branch cannot bind rows that carry a knowledge document). They are built only when no key is duplicated (the inventory proves the expression index made that impossible) and the old index is then dropped. `lib/mentionIndexer.ts` upserts against the plain key with DO NOTHING — after its delete the only rows left for the document are a person's explicit pins, which now survive instead of being overwritten with machine text — counts the rows actually written, falls back to plain inserts on a database without the index (42P10), and logs every failure where it happens before throwing. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("IRLS-4 / WIRE-2 — the mention engine writes against the plain index").

**Pending migration:** `supabase/migrations/20261126_intel_roundG_link_conflict_targets.sql` (DEC-30: the inventory — `document_related_resources` rows with NULL `target_document_id`, pairs linked both ways, `origin` values outside the declared set, duplicate mention keys, `proposed_links` rows in status `stale` and pending, and the pending rows from a connection skill that is private (retired to `stale`; fix pass 3) — is captured before the DDL; the plain mention indexes and the VALIDATE of the origin CHECK happen only in the world where nothing violates them, and the final rows say which world was taken).

**Done-when.**
1. ✓ Plain unique keys for the knowledge-document branch and the document branch; the writer's conflict target matches.
2. ✓ verified, no edit: `lib/mentions.ts` `tolerate()` treats only 42P01 / "does not exist" as not installed; an empty result is `mentionCoverage → { installed: true, total: 0 }` ("run the indexer"), and a write failure is now logged by the indexer and returned by `/api/graph/mentions` as a 500 with its message — the two look different. (`lib/mentions.ts` belongs to I-02.)
3. Partly — `/api/graph/mentions` returns `mentionsWritten`, now the count actually written ✓; the graph presenting zero mention edges as a problem is the graph page's (I-14's file) → opened `IRLS-14` (`DEC-31`).

**Scope / residual.** `IRLS-14`.

---

<a id="irls-5"></a>

## IRLS-5 · assets is FOR ALL to any active member — the equipment registry can be rewritten or deleted by a Requester over PostgREST

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260605_rls_policies_new_tables.sql:25-30`, `lib/assets.ts:206-220`, `app/(protected)/admin/assets/page.tsx:56`, `lib/roleCapabilities.ts:48-61`, `supabase/migrations/20260807_link_proposals.sql:119-123`, `supabase/migrations/20260929_mention_engine.sql:28`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. The only gate is UI-side — app/(protected)/admin/assets/page.tsx:56 `const ADMIN_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];` — while lib/assets.ts:217-220 deleteAsset issues a bare `supabase.from("assets").delete().eq("id", id)` over the user's JWT. Unlike documents (20260814:41 `documents_delete_controllers … AS RESTRICTIVE FOR DELETE USING (is_org_controller(org_id))`), no restrictive policy exists on assets — grep over all migrations returns no other assets policy. Cascade impact is real: entity_mentions.asset_id and asset_aliases.asset_id are both `REFERENCES assets(id) ON DELETE CASCADE`.

**Mechanism.** `assets_member_all` is `FOR ALL TO authenticated USING (EXISTS (... status = 'active')) WITH CHECK (same)` — active membership is the entire test. Every authority column added since sits inside that same permissive envelope: `unit_code`, `code`, `origin`, `discovered_from` (20260928:78-81) and `plant_id/unit_id/system_id` (20260606:105-107). The only gate is client-side: `const ADMIN_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];` in the page component, and `lib/assets.ts` writes are bare browser calls — `deleteAsset` is `await supabase.from("assets").delete().eq("id", id)` with no org or role predicate of its own. Deletion is destructive far beyond the row: asset_photos, asset_files, asset_aliases and entity_mentions all declare `REFERENCES assets(id) ON DELETE CASCADE`, and the table has an `archived BOOLEAN` column that the delete path ignores.

**Failure scenario.** An Accounting member (ROLE_CAPABILITIES grants them only `create_requests`) issues `DELETE /rest/v1/assets?id=eq.<uuid>` with their own session token. RLS permits it. The tag disappears from the registry, and the cascade takes its entire photo history, its file links, its human aliases, and every mention row that proved which drawings reference it. No audit_logs entry is written (deleteAsset calls no audit helper), and the `archived` soft-delete the schema provides is bypassed entirely.

**Evidence.**

```
20260605_rls_policies_new_tables.sql:27-30 — `CREATE POLICY "assets_member_all" ON assets\n  FOR ALL TO authenticated\n  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = assets.org_id AND uid = auth.uid() AND status = 'active'))\n  WITH CHECK (EXISTS (...));` lib/assets.ts:217-220 — `export async function deleteAsset(id: string): Promise<void> { const { error } = await supabase.from("assets").delete().eq("id", id); if (error) throw new Error(error.message); }`
```

> **Verifier correction.** Add the context that this is a deliberate, documented platform-wide stance, not an intelligence-layer slip: 20260605_rls_policies_new_tables.sql:12-14 says 'Role-based authorization (e.g. only Admins can delete an asset) is handled in application code, not RLS', and docs/ARCHITECTURE.md:262-264 repeats it. The same envelope covers asset_types and asset_photos. That is a rationale, not a mitigation — nothing server-side re-checks role before a write — but the fix is a policy decision about the whole registry, not a one-table patch.

**Done when.**

- [ ] a RESTRICTIVE FOR DELETE (and FOR UPDATE on unit_code/code/origin) policy on assets requires is_org_controller(org_id), mirroring documents_delete_controllers (20260814)
- [ ] deleteAsset writes an audit_logs row, or is replaced by an archive flip on the existing `archived` column
- [ ] asset_types, asset_photos and asset_files get the same treatment — all four carry the identical unrestricted *_member_all policy

**Resolution (2026-09-30, intelligence Round G).** `20261128_intel_roundG_registry_authority.sql`: the RESTRICTIVE DELETE overlay on `assets` (and `asset_types`, `asset_photos`) now requires `is_org_controller(org_id)` — the collection-aware controller bar that `documents_delete_controllers` uses; an AFTER DELETE trigger (`assets_audit_delete`, SECURITY DEFINER, `search_path` pinned) writes an `ASSET_DELETED` audit row with the tag, code, unit, origin and discovery provenance in the same transaction for every person-initiated deletion (the service role's cascades — org purge, restore — are skipped). The writer tier's removal is `archiveAsset` (the existing `archived` column; photos, aliases, mentions and file links stay). `deleteAsset` / `updateAsset` / `deletePhoto` are checked writes. Tests: `lib/__tests__/intelRoundGRegistry.test.ts`.

*Review fix (2026-09-30).* Archive was described as reversible, but nothing in the product could un-archive: the grid and the tag lookup exclude archived rows, and an archived row keeps its tag, so the equipment could not be re-created either. Now `lib/assets.ts` `restoreAsset` flips `archived` back (a checked write). The Operating Areas page shows "Archived (N)" with a list of the archived equipment (every identity, `listAssetIdentities`), and the writer tier restores from it. The asset drawer shows an Archived badge and a Restore action in place of Archive. The master-list import flags a row whose tag an archived asset carries: create-only skips it with a note on how to restore it, and update mode restores it (`archived: false` in the patch). Both archive confirms name where the asset can be restored. Tests: `lib/__tests__/intelRoundGRegistry.test.ts` ("restoreAsset brings it back as it was", "archive is reversible in the product"), `lib/__tests__/assetCategorize.test.ts` ("IRLS-5 — the import plan and an ARCHIVED asset").

**Pending migration:** `supabase/migrations/20261128_intel_roundG_registry_authority.sql`.

**Done-when.**
1. ✓ for DELETE: RESTRICTIVE FOR DELETE requires `is_org_controller(org_id)`. The FOR UPDATE limb on `unit_code` / `code` / `origin` was **decided otherwise (`DEC-53`)**: those columns stay with the registry WRITER tier, not the controller tier, because they are what the Operating Areas page promises Manager and Supervisor may edit. The database already enforces that tier through `assets_guard_registry` (20261045: a registry-column change by a non-writer raises), so a Requester cannot change them. No controller-only UPDATE policy was added.
2. ✓ Both: deletion writes an audit row (database trigger, not a best-effort client call), and the writer tier archives instead, which it can undo from the Archived list or the drawer.
3. ✓ for asset_types and asset_photos, which get the controller DELETE. For asset_files the limb was **decided otherwise (`DEC-53`)**: it keeps the writer-tier overlay from 20261045, because it is a document link rather than a registry record and un-linking is the everyday act of the File Reference modal.

**Scope / residual.** Apply 20261128. Two of the listed limbs (the controller-only UPDATE on the identity columns, and asset_files) were decided otherwise in `DEC-53`, not built; reversing that decision is `DEC-53`'s Reversal (1).

---

<a id="irls-6"></a>

## IRLS-6 · 20260806_intelligence_layer.sql ALTERs a table that is not created until 20260911 — the whole file rolls back on a fresh database

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-17 DATABASE HARNESS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260806_intelligence_layer.sql:57-61`, `supabase/migrations/20260911_knowledge_ai.sql:91`, `lib/schemaExpectations.ts:1-13`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on a fresh DB: knowledge_questions does not exist in supabase/schema.sql (grep over its 1341 lines returns nothing), there is no README or ordering manifest in supabase/migrations, and lib/schemaExpectations.ts:4-5 states migrations are "applied BY HAND in the Supabase SQL editor" — where a multi-statement script runs as one implicit transaction, so the whole file rolls back. The knock-on is real too: 20260807_link_proposals.sql:95 does `ALTER TABLE document_related_resources ADD COLUMN…` on a table only created at 20260806:68, inside the file that just aborted.

**Mechanism.** 20260806 runs `ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (...) STORED;` at line 57. `knowledge_questions` is created only at 20260911_knowledge_ai.sql:91 — 105 days later in filename order. `ADD COLUMN IF NOT EXISTS` guards the column, not the table: a missing relation raises 42P01 regardless. lib/schemaExpectations.ts states the deployment model: "Migrations are applied BY HAND in the Supabase SQL editor (no CLI pipeline yet)" — and a whole-file paste in that editor runs as one transaction, so the failure rolls back everything above it in the same file: org_ai_instructions (Org Playbooks), document_related_resources (the entire link spine's target table), recently_viewed_docs, library_numbering, and issue_document_number().

**Failure scenario.** A new deployment applies migrations in filename order. 20260806 aborts at line 57. The operator sees one error, moves on, and applies 20260807 — which immediately fails too, because it does `ALTER TABLE document_related_resources ADD COLUMN ... origin` on a table that never got created. Org Playbooks, related resources, the proposal spine's provenance columns, auto document numbering and recently-viewed all silently do not exist, and every lib/ function that touches them returns empty via its `42P01` tolerance path — the exact "ships green, renders an empty panel in production" failure schemaExpectations.ts was written to prevent.

**Evidence.**

```
20260806_intelligence_layer.sql:57-61 — `ALTER TABLE knowledge_questions\n  ADD COLUMN IF NOT EXISTS search_tsv tsvector\n  GENERATED ALWAYS AS (\n    to_tsvector('english', coalesce(question, '') || ' ' || coalesce(answer, ''))\n  ) STORED;` vs 20260911_knowledge_ai.sql:91 `CREATE TABLE IF NOT EXISTS knowledge_questions (`. A repo-wide search for `CREATE TABLE ... knowledge_questions` returns exactly one hit, in 20260911.
```

> **Verifier correction.** Reframe as a disaster-recovery / self-host hazard, not a live break: replaying supabase/migrations in filename order on a fresh database fails at 20260806:57 with 42P01, taking org_ai_instructions, document_related_resources, recently_viewed_docs, library_numbering and issue_document_number() with it. Existing deployments already have all of these. The one-line fix is to rename or move the ALTER after 20260911.

**Done when.**

- [ ] the knowledge_questions ALTER + its two indexes are moved out of 20260806 into a migration dated after 20260911 (or guarded with a `to_regclass('public.knowledge_questions') IS NOT NULL` DO block)
- [ ] a fresh-database replay of migrations in filename order completes with zero errors
- [ ] /api/admin/schema-health is run against a fresh install and reports every EXPECTED_TABLE present

**Partial (2026-09-30, intelligence Round G).** Code complete, pending verification: criteria 2 and 3 need a fresh-database replay that this environment cannot run. Confirmed first with a static in-order replay of every numbered migration against the `schema.sql` baseline. It found exactly one ALTER reaching a table that is created later: `20260806` → `knowledge_questions`, which `20260911` creates. What landed:

- In `supabase/migrations/20260806_intelligence_layer.sql`, the ALTER and its two indexes now run inside `DO $$ … IF to_regclass('public.knowledge_questions') IS NOT NULL THEN … END IF; END $$;`. The statements are byte-for-byte the originals. Every live deployment already has the table, so the file behaves as before there. On a fresh replay the file no longer rolls back.
- New `supabase/migrations/20261123_intel_roundG_knowledge_questions_order.sql` carries the SAME statements after `20260911`, inside one transaction, and ends in one verification SELECT (`check, ok, n`): the column exists as a STORED generated column over question and answer, and both indexes exist. On a live database it is three no-ops.
- Neither file defines a function, policy or trigger, so DB-8's `lib/__tests__/migrationSourceOfTruth.test.ts` accepts both.

Tests: `lib/__tests__/intelRoundGMigrationOrder.test.ts`:
- "no ALTER TABLE reaches a table the sequence creates later (unguarded)", the in-order replay census;
- "the census catches the pre-fix shape — it is not vacuous";
- "20260806 runs the statements only when the table exists, byte-for-byte the originals";
- "20261123 carries the same statements after 20260911, inside one transaction", which runs a lineDiff against the originals.

**Done-when.**
- ✓ The `knowledge_questions` ALTER and its two indexes are guarded in `20260806` with the `to_regclass` DO block AND carried by a migration dated after `20260911`.
- ✗ Not verified: a fresh-database replay of the migrations in filename order completing with zero errors. This environment has no database. The static in-order replay census over every numbered migration finds no remaining ALTER-before-CREATE, but it is a stand-in, not the replay.
- ✗ Not verified: running `/api/admin/schema-health` against a fresh install. Same reason; it belongs to the same replay.

**Scope / residual.** Pending migration: `20261123_intel_roundG_knowledge_questions_order.sql`. On live deployments it is a no-op, and its SELECT confirms the column and indexes. The census only checks ALTER-before-CREATE ordering; other fresh-replay hazards (a function body referencing a later table, say) are outside it. I-07's DWG-9 (`20261009_trace_method.sql`) is the same class, in a separate file. OPEN until someone replays the numbered sequence into an empty project and runs schema-health against it.

**Partial (2026-10-14, intelligence Round G).** The fresh-database replay is now automated in the database harness (intelligence I-17, `npm run test:db`: a real PostgreSQL 16 started under a scratch directory, `supabase/schema.sql` and every numbered migration replayed in filename order onto a Supabase stand-in, the cluster deleted afterwards; with no PostgreSQL the run skips with one line naming the missing binary; the default suite and CI are unchanged). `lib/__tests__/rls/replay.ts` sends each numbered migration as ONE simple-query message, which is how the Supabase SQL editor sends a paste: one implicit transaction unless the file opens its own, the first error stops the rest, and a syntax error anywhere means nothing in the file runs. `lib/__tests__/rls/freshReplay.test.ts` holds the outcome to `lib/__tests__/rls/replayKnownDefects.ts`, in both directions. A failure that is not listed fails the opt-in run, and so does a listed failure that no longer happens, so each entry is removed when its owner lands the fix.

Measured 2026-10-14, PostgreSQL 16.13 with pgvector 0.6.0, 299 numbered files:
- **This finding's own defect is gone.** `20260806`, `20260807` and `20261123` replay clean. `knowledge_questions.search_tsv` is a STORED generated column, and `org_ai_instructions`, `document_related_resources`, `recently_viewed_docs` and `library_numbering` all exist.
- **Three files do not replay**, each opened as its own finding (DEC-31, owner: the integrator, to route):
  - `supabase/schema.sql` cannot run as one script on an empty database. It stops at `:328`, and 16 of its statements fail even when it is run statement by statement → `IRLS-17`.
  - `20260630_perf_indexes.sql` indexes `team_members` a week before `20260707` creates it, so the whole file rolls back. A re-run after the sequence succeeds → `IRLS-18`.
  - `20261075_dc_roundF_checkout_episode_seal.sql`'s final SELECT names its `check` column bare, a syntax error. PostgreSQL parses the whole script first, so nothing in the file applies, and its guard is absent from the replay → `IRLS-19`.
- **One file refuses by design.** `20261141` refuses until its operator switch is set. The harness supplies exactly the documented switch (`app.j11_deployed = 'yes'`) for that file only, and a test proves the file still refuses without it.
- **How the harness works around them.** `schema.sql` is run statement by statement, with its failing statements held to the recorded set of 16 messages. `20260630` is re-run once after the sequence.

`/api/admin/schema-health` was run against that fresh install. The route's own `GET` handler (`app/api/admin/schema-health/route.ts`) was called with `supabaseAdmin` replaced by a PostgREST stand-in that the replayed database itself answers as `service_role`: a table probe is `SELECT … LIMIT 0`, and an RPC probe is a named-argument call whose untyped literals PostgreSQL resolves against the function's parameters. The answer: `healthy: true`; no missing table, column or function; `migrationsToRun` empty; more than 100 tables checked. A copy with `library_numbering` and `bump_share_access(uuid)` dropped is reported unhealthy and names both, so the stand-in is not vacuous.

**Done-when.**
- ✓ (2026-09-30) The `knowledge_questions` ALTER is guarded in `20260806` and carried by `20261123`. The replay confirms both run clean.
- ✗ Not met as written: "a fresh-database replay of migrations in filename order completes with zero errors". The replay now runs on every `npm run test:db`, and it reports two numbered files that fail in filename order (`IRLS-18`, `IRLS-19`) plus the baseline's own failure (`IRLS-17`). None of the three is this finding's defect.
- ✗ Not met (re-checked at the I-17 integrator fix pass, 2026-10-14). On the harness's install, `/api/admin/schema-health` reports every `EXPECTED_TABLE`, and every expected column and function, present (`healthy: true`). The integrator's narrowing (DEC-90) would count that as met if the install differed from a literal fresh install only in ways the route does not read. That is not true. The install differs in four ways, and the route reads two of them:
  - **Read:** it runs `schema.sql` statement by statement (`IRLS-17`). Sent as one script, the way the editor sends a paste, `schema.sql` stops at `:328` and its one implicit transaction rolls back, so none of its tables exist (measured on PostgreSQL 16.13: 0 tables in `public` afterwards). 16 of the route's `EXPECTED_TABLES` rows, and one `EXPECTED_COLUMNS` row (`org_configurations.data`), name `schema.sql (base schema)` as their source, and the route reads every one of them.
  - **Read:** the route's `GET` handler is answered through a PostgREST stand-in that the replayed database serves, not a real Supabase project. Every read the route makes goes through it.
  - Not read: it re-runs `20260630` after the sequence (`IRLS-18`). That file creates four indexes, and the route probes tables, columns and functions only.
  - Not read: it lacks everything in `20261075`, which cannot be parsed (`IRLS-19`). Its trigger function `enforce_checkout_episode_guard()` and its trigger are in none of `EXPECTED_TABLES`, `EXPECTED_COLUMNS` or `EXPECTED_FUNCTIONS`.
  Done-when 3 can be met once `IRLS-17` lands and the route is run against that install, through the stand-in only if the integrator accepts it in place of a real Supabase project.

**Scope / residual.** IRLS-6 stays OPEN on done-when 2 and done-when 3. Done-when 2 closes by record once `IRLS-17`, `IRLS-18` and `IRLS-19` land: at that point `replayKnownDefects.ts` lists nothing and `freshReplay.test.ts` reads zero errors. Done-when 3 closes once `IRLS-17` lands and the route is run as above. Owner of the remainder: intelligence I-27 FRESH-INSTALL REPLAY (to be added to the fleet plan by the integrator at the I-17 merge), which holds all three findings. No migration from this package touches it.

---

<a id="irls-7"></a>

## IRLS-7 · Knowledge sources and mirrored documents carry no foreign key to the document-control rows they claim to mirror

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** intelligence I-09 PROCESS FLOWS & OPERATING AREAS — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260917_knowledge_sources.sql:31`, `supabase/migrations/20260917_knowledge_sources.sql:53-58`, `supabase/migrations/20261017_process_flows.sql:17-20`, `supabase/migrations/20260928_site_codebook.sql:78`, `lib/knowledgeSourceSync.ts:285-292`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Structural claim verified — the mirrored knowledge_documents row and its knowledge_chunks (full extracted text) outlive a deleted controlled document until the next sync. One narrowing the finding does not state: for non-controllers the ask route fails closed on orphans, because lib/knowledgeAccess.ts:201-205 finds no `documents` row for a deleted id so it never enters `readable`; but lib/knowledgeAccess.ts:196 `if (principal.isController) return new Set(docIds);` returns ALL ids unchecked, so Admin/DocCtrl answers can still cite the deleted document. Also note the cited 20261017_process_flows.sql:17-20 is the polymorphic from_kind/from_ref/to_kind/to_ref pair (correctly FK-less by design); that file's source_document_id at :27 does have a proper FK.

**Mechanism.** `knowledge_sources.source_id UUID NOT NULL` is annotated `-- libraries.id or collections.id` but declares no REFERENCES — a polymorphic pointer the database cannot enforce or cascade. Likewise `knowledge_documents.source_document_id UUID` and `source_version_id UUID` have no FK to documents/document_versions (only `source_id` cascades, and only to knowledge_sources). `process_flows.from_ref/to_ref` are TEXT holding either an assets.id UUID or a codebook unit code, again unenforceable. `assets.unit_code TEXT` points at codebook_entries.code with no FK. The only reconciliation is the sync's removal pass — `for (const [dcDocId, row] of existingByDcDoc) { if (wanted.has(dcDocId)) continue; await supabaseAdmin.from("knowledge_documents").delete().eq("id", row.id) }` — which runs on the maintenance cron, not on delete.

**Failure scenario.** A DocCtrl deletes a controlled document (permitted by documents_delete_controllers). The document row and its versions vanish immediately; the mirrored knowledge_documents row and all its knowledge_chunks — the full extracted text — survive until the next cron sync, and answers keep citing a document that no longer exists. If the enclosing doc-control library or folder is deleted instead, `knowledge_sources.source_id` becomes a dangling pointer with no cascade at all. Separately, deleting an asset (which any member can do, see the assets finding) leaves process_flows rows whose from_ref/to_ref name a nonexistent uuid, and the graph renders edges to nothing.

**Evidence.**

```
20260917_knowledge_sources.sql:31 — `source_id UUID NOT NULL,                 -- libraries.id or collections.id` (no REFERENCES). 20260917_knowledge_sources.sql:53-56 — `ALTER TABLE knowledge_documents\n  ADD COLUMN IF NOT EXISTS source_document_id UUID;\nALTER TABLE knowledge_documents\n  ADD COLUMN IF NOT EXISTS source_version_id UUID;` — untyped pointers. 20261017_process_flows.sql:18,20 — `from_ref TEXT NOT NULL,` / `to_ref TEXT NOT NULL,` with the header note at :9-12 explaining the deliberate choice.
```

> **Verifier correction.** Keep it SUSPECTED and state the bite plainly rather than as a general integrity complaint: the polymorphic pointers are a documented design choice, and the one consequence that matters for a PSM system is the window between a controlled document (or its ACL) being removed and the maintenance cron's removal pass — during which the mirror and its chunks remain, and per finding 1 any answer already derived from them stays org-readable forever regardless.

**Done when.**

- [ ] deleting a controlled document synchronously removes its knowledge mirror and chunks (a trigger or a call in the delete path), rather than waiting for the cron
- [ ] knowledge_sources gains either a real FK per source_type via two nullable columns, or a scheduled orphan sweep that reports dangling sources
- [ ] process_flows endpoints referencing assets are validated against the registry on read, so an edge to a deleted asset is shown as broken rather than drawn

**Partial (2026-09-30, intelligence Round G).** Confirmed first by reading. Its mirror and chunk half is ILIFE-5's fix.

- **The delete cascades.** `20261122` §6 adds `knowledge_documents.source_document_id REFERENCES documents(id) ON DELETE CASCADE`, after purging mirrors that name no document in the same paste. Deleting a controlled document now removes its mirror and everything derived from it synchronously, instead of waiting for the cron.
- **Dangling sources are reported.** `knowledge_sources.source_id` stays a polymorphic pointer; the design choice is kept. The sync (`syncKnowledgeLibrarySources`, run by the maintenance cron and on demand) now reports every source whose document-control library or folder no longer exists: `danglingSources` in the summary, and an error line the cron surfaces, `dangling source "…": its document-control folder no longer exists — unlink it from this library`. That source's mirrors fall out of `wanted` and are removed on the same pass.

Tests: `lib/__tests__/intelRoundGIngestMigration.test.ts` (the key and the cascade trace), and `lib/__tests__/sourceSync.test.ts` ("a source whose library was deleted is named, and its mirrors leave").

**Done-when.**
- ✓ Deleting a controlled document synchronously removes its knowledge mirror and chunks, through the foreign key.
- ✓ The criterion's second branch holds: the scheduled sync reports dangling sources.
- ✗ Not done here. Validating `process_flows` endpoints against the registry on read belongs to process flows and graph assembly (I-09 / I-13), not ingestion.

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql`. OPEN until the `process_flows` read-time validation lands.

**Resolution (2026-10-01, intelligence Round G, I-09 — the remainder).** The remainder was done-when 3: `process_flows` endpoints that reference assets are validated against the registry on read, so an edge to a deleted asset is shown as broken rather than drawn. Reproduced first: FlowPanel resolved an unknown asset end to "…", indistinguishable from loading.

What landed:
- `lib/processFlows.ts` `resolveAssetEndpoints` reads every asset end of the flows a surface shows from the registry (chunked). It returns the tag (archived marked), or `missing` for a ref that names no asset (a non-uuid ref included). A chunk whose registry read fails marks each ref it asked about `unchecked` ("equipment (not checked)"). *(Third fix pass: it returned null for the whole map, so one failed read took the unit's own equipment's tags with it. The unit's own equipment, passed as `known`, is never asked and keeps its tag; the plant-wide list says "not checked" per end.)*
- FlowPanel and the plant-wide `FlowReviewQueue` show a missing end as "equipment no longer exists" with a remove button for the controller tier, and never offer to confirm a proposal to nothing.
- The graph already does not draw such an edge and counts it (I-13, see `FLOW-6`).
- No new dangling row can be written: `20261155`'s endpoint guard and asset-delete cleanup (`WIRE-10`).

Tests: `lib/__tests__/processFlowsLib.test.ts` ("resolveAssetEndpoints — IRLS-7 / FLOW-6 …"; third fix pass: "a registry read that fails marks only the refs it asked for 'unchecked' …", "one failed chunk leaves the other chunks' answers standing"), `lib/__tests__/flowPanelRender.test.ts` ("IRLS-7 / FLOW-6 — an end naming deleted equipment is shown as gone"; third fix pass: "IRLS-7 — a registry read that fails leaves the unit's own equipment named").

**Done-when.**
1. ✓ (2026-09-30, ILIFE-5) Deleting a controlled document removes its mirror and chunks through the foreign key (`20261122`).
2. ✓ (2026-09-30) The scheduled sync reports dangling sources.
3. ✓ `process_flows` asset ends are validated against the registry on read; an edge to a deleted asset is shown as broken, with removal, not drawn.

**Scope / residual.** **Pending migrations:** `20261122_intel_roundG_ingest_integrity.sql` (limb 1, not this package's) and `20261155_intel_roundG_process_flows_authority.sql` (the guard and cleanup that stop new dangling rows). The read-time validation in limb 3 needs neither.

---

<a id="irls-8"></a>

## IRLS-8 · document_equipment_suggestions — the Bridge's applied-tag ledger — is writable by any active member

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260928_site_codebook.sql:104-111`, `supabase/migrations/20260928_site_codebook.sql:89-102`, `lib/equipmentBridgeServer.ts:140-155`, `lib/equipmentBridgeServer.ts:174-181`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: `applied` is read straight back from the member-writable row and used as the idempotence base, so a forged applied[] array makes every recompute stamp status 'applied' with zero tags ever written to the document column. applyForDocument (lib/equipmentBridgeServer.ts:174-179) reads the same row's `suggested`/`applied` with the same trust. Contrast the sibling policies in the same file at :65-73, where codebook_entries_write and codebook_config_write DO carry `AND role IN ('Admin','DocCtrl')`.

**Mechanism.** `doc_equip_sugg_write` is `FOR ALL USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active')) WITH CHECK (same)` — no role predicate, on a table the migration itself describes as "The bridge's review state" holding "the latest computed proposal (per-sheet tags + registry resolution) until it's applied (or auto-applied)" and, in `applied`, "the diff base so re-index never duplicates or re-suggests." Every legitimate writer is server-side and uses supabaseAdmin (upsertSuggestions at :147, the status update at :280), so nothing in the app needs member write access — the permission is pure surplus. `applyForDocument` trusts the stored row completely: it reads `suggested` and `applied` and derives what to write into the document's equipment column and which DISCOVERED assets to create from them.

**Failure scenario.** A member POSTs a modified row: `applied` set to the full tag list and `status` to 'applied'. The next bridge run's upsertSuggestions reads that `applied` array, computes `newTags` as empty, and stamps status 'applied' — so a P&ID whose tags were never written to the equipment column is permanently marked done and never re-suggested. The inverse is equally available: clearing `applied` makes the bridge re-write and re-create DISCOVERED assets it already created.

**Evidence.**

```
20260928_site_codebook.sql:108-111 — `CREATE POLICY doc_equip_sugg_write ON document_equipment_suggestions FOR ALL\n  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'))\n  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'));` and :94-96 `-- Tags (normalized) that have been written to the document's column by the\n  -- bridge — the diff base so re-index never duplicates or re-suggests.\n  applied      JSONB NOT NULL DEFAULT '[]'::jsonb,`
```

**Done when.**

- [ ] doc_equip_sugg_write is dropped (all writers are service-role) or narrowed to is_org_controller(org_id)
- [ ] a repo-wide grep confirms no browser-client write path to document_equipment_suggestions exists — today there is none, so removing the policy is behavior-neutral

**Resolution (2026-09-30, intelligence Round G).** `20261128_intel_roundG_registry_authority.sql` §3 re-creates `doc_equip_sugg_write` with the same name and shape as 20260928, changing only the predicate to `is_org_controller(org_id)` (USING and WITH CHECK) — the service role (every app writer: `upsertSuggestions`, the apply status update) bypasses RLS, members keep SELECT. Line-diffed against the live 20260928 statement in `lib/__tests__/intelRoundGRegistry.test.ts`.

**Pending migration:** `supabase/migrations/20261128_intel_roundG_registry_authority.sql`.

**Done-when.**
1. ✓ Narrowed to `is_org_controller(org_id)`.
2. ✓ A repo walk (app, components, lib, hooks) asserts no browser-client write to `document_equipment_suggestions` exists — every writer is the service-role Bridge (`lib/__tests__/intelRoundGRegistry.test.ts`); the narrowing is behaviour-neutral for the app.

**Scope / residual.** None; apply 20261128.

---

<a id="irls-9"></a>

## IRLS-9 · entity_mentions publishes verbatim quotes from ACL-protected mirrored documents to every org member

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** intelligence I-12 DOCUMENT ACL BOUNDARY — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260929_mention_engine.sql:73-76`, `supabase/migrations/20260929_mention_engine.sql:38`, `lib/mentionIndexer.ts:84-121`, `lib/mentions.ts:9`, `lib/mentions.ts:120-127`, `lib/mentionIndexer.ts:157-190`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The RLS design flaw is real and correctly described, but the exploit path is unreachable today — by the batch's own IRLS-4, entity_mentions has never been written, so the backlinks panel (lib/mentions.ts:126-134 mentionsForAsset) returns an empty set and there are no snippets to leak. It is a latent exposure that goes live the moment IRLS-4's onConflict is fixed; LOW until then. (The one path that could seed rows independently is a backup restore — lib/dataRestore.ts:298 lists entity_mentions.)

**Mechanism.** The mention indexer runs as the service role over EVERY ready knowledge document — `supabaseAdmin.from("knowledge_documents").select("id, status").eq("org_id", orgId).eq("status", "ready")` (mentionIndexer.ts:163-166) — which includes documents mirroring ACL-protected controlled documents (source_document_id IS NOT NULL). For each it reads chunks with supabaseAdmin (RLS bypassed) and writes `context_snippet: s.snippet` — the migration's own words: "The evidence. This column is the entire reason the table exists." The read policy is `entity_mentions_read ... USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = entity_mentions.org_id AND m.uid = auth.uid() AND m.status = 'active'))` — no source_document_id exclusion, unlike knowledge_chunks. lib/mentions.ts imports the browser anon client and selects `context_snippet` directly. So the exact text 20260917 locked down is republished under a different table name, and the graph edge-inspector renders it on click.

**Failure scenario.** A vendor manual or an incident report is linked into a knowledge library as a source. The mention indexer reads its chunks and writes one entity_mentions row per (asset, page) carrying the sentence. Any active member opens /assets/<tag>, and the backlinks panel renders the quoted sentence from a document their ACL forbids — with a deep link to the library and page.

**Evidence.**

```
20260929_mention_engine.sql:38 — `context_snippet TEXT NOT NULL,` with the comment at :37 `-- The evidence. This column is the entire reason the table exists.` lib/mentions.ts:38-40 — `const SELECT = "asset_id, knowledge_document_id, document_id, page, context_snippet, matched_text, " + "mention_count, confidence, origin, assets(tag), knowledge_documents(name, library_id)";` and lib/mentions.ts:9 — `import { supabase } from "@/lib/supabase";` (the anon browser client, not supabaseAdmin).
```

> **Verifier correction.** Downgrade to MEDIUM/SUSPECTED and reframe: the read policy is missing the `source_document_id IS NOT NULL` exclusion that 20260917 applied to knowledge_chunks, and it becomes a live ACL leak the moment the broken upsert in finding 4 is fixed. Fix both together, or fixing 4 alone opens the leak.

**Done when.**

- [ ] entity_mentions_read carries the same `NOT EXISTS (... source_document_id IS NOT NULL)` guard as knowledge_chunks_select, or mention reads move behind an ACL-filtering API route
- [ ] lib/mentions.ts no longer reads context_snippet with the browser anon client for source-linked documents
- [ ] a test asserts a member without ACL on a mirrored controlled document gets zero mention rows for it


**Partial (2026-09-30, intelligence Round G).** Landed with `IEDGE-6` (same policy; the package decision `DEC-59` (2)). Note on reachability: `IRLS-4` (I-08) has not landed, so `entity_mentions` may hold few or no rows; the overlay is in place before that fix opens the path, which is the order the verifier asked for ("fix both together, or fixing 4 alone opens the leak"). Verified on a scratch PostgreSQL 16 carrying the live policy and helper bodies (`node_visible` 20261041, `is_org_controller` 20260814, `acl_subject_in_bucket` 20260708, the 20260911 / 20260917 / 20260929 knowledge policies; the owner cascade stubbed to its document-owner arm), the whole paste applied as the user will paste it: BEFORE, a Viewer read every stored answer, every mirror row (a private document's and a dangling one included) and every mention sentence; AFTER, a Viewer reads their own answer, the upload and open-document mirrors and those documents' sentences; a Manager (who holds the FOR ALL `entity_mentions_write`) reads exactly the Viewer's sentences; an Engineer granted read on the private document reads their own answer, that mirror and its sentence; an Admin and a Viewer holding DocCtrl additively read everything (DEC-43); a non-member reads nothing and the hub count answers 0. All seven probes were true on the first apply and again on a second (idempotent). That run did not read `knowledge_chunks`, and the review found the gap it left: 20260917's `knowledge_chunks_select` hides a mirror's chunks with `NOT EXISTS` over `knowledge_documents`, which runs under the caller's RLS, so once `knowledge_documents_select` hides a mirror row the `NOT EXISTS` passes and the chunks OPEN. Fix pass 2: `20261120` re-creates `knowledge_chunks_select` in the same transaction with the same rule written positively (`EXISTS … AND d.source_document_id IS NULL` — an upload row the caller can see; lineDiff-pinned against 20260917), counts the chunks of private / hidden documents' mirrors before apply, probes the positive form, and probes that no policy in the database tests `NOT EXISTS` over `knowledge_documents`, `knowledge_questions` or `entity_mentions`; `lib/__tests__/knowledgeMemoryAcl.test.ts` replays schema.sql and every migration's policies to the same end. Re-run on a second scratch PostgreSQL 16 (the verbatim 20260911 / 20260917 / 20260929 policies and 20261012's `knowledge_search_document`): before the paste a Viewer read only the upload passage; with the paste minus the chunk section a Viewer read the private and the hidden mirror's passages, directly and through `knowledge_search_document`, and the two new probes were false (the reproduction); with the full paste a Viewer, an Engineer granted the private document and a Manager read only the upload passage and nothing through `knowledge_search_document`, an Admin read every passage (`knowledge_chunks_write`), and all eight probes were true on the first apply and on a second.

**Pending migration:** `supabase/migrations/20261120_intel_roundG_knowledge_memory_acl.sql` (inventory before apply: stored answers; answers citing a mirror of a private / hidden / private-draft document; answers citing a knowledge document that no longer exists; non-controller members; mirror rows, those of private / hidden documents and dangling ones; the chunks of private / hidden documents' mirrors (fix pass 2); mention rows and those on private / hidden documents).

**Done-when.**
1. Partly — `entity_mentions_source_readable` (RESTRICTIVE) hides every mention of a document whose ROW the reader cannot see; both hops are POSITIVE `EXISTS` under the caller's RLS, so a row RLS hides fails closed (unlike 20260917's chunk lockdown, a `NOT EXISTS` over `knowledge_documents` that the mirror-row narrowing would have opened — re-created as a positive test in the same paste, fix pass 2). ✗ The documents predicate (`node_visible`) is true for `normal` visibility, so mentions in normal-visibility documents carrying an allow-list ACL or a role / team deny, and in private drafts, still reach every member until I-12.
2. Partly — the browser receives a mention's `context_snippet` only for a document whose ROW is visible to the reader at the database (`DEC-59` (2)); the normal-visibility gap of 1 applies.
3. ✗ Not asserted in the repository: no test in the suite runs the policy against a database (the suite has no PostgreSQL). It was shown on the scratch PostgreSQL 16 above (the Viewer and the Manager got zero rows for the private document) and is pinned only by shape and census in `lib/__tests__/knowledgeMemoryAcl.test.ts`.

**Scope / residual.** As `IEDGE-6`: open on I-12 (normal-visibility ACLs and private drafts inside `node_visible`) and on a database-backed test.

**Partial (2026-10-14, intelligence Round G).** Package I-12. `20261212` (pending migration) brings explicit READ denies into `node_visible` for every subject and on a normal row (`DACL-12`, `IEDGE-12`), so a mention of a document such a deny names is hidden from that member through `entity_mentions_source_readable`, which reads the document row under the caller's RLS. *(Superseded at the I-12 merge, 2026-10-14: as pasted, `20261212` holds this binding back by default — its operator switch stays off, `DEC-90`; the database binding lands with intelligence I-30. The app's predicate refuses these reads meanwhile.)*

**Done-when.**
1. Partly — as `IEDGE-6` criterion 1: ✓ for a read deny; ✗ for a normal row's allow-list and a private draft.
2. Partly — the same split.
3. ✗ Not done: the suite still has no PostgreSQL. `20261212` was exercised on a throwaway PostgreSQL 16 (recorded on `DACL-12`) and its port is pinned by `lib/__tests__/intelRoundGNodeVisibleDeny.test.ts`; no test in the repository runs a policy against a database.

**Remaining / owner.** Criteria 1–2: `DACL-1` criterion 1 (owner named there). Criterion 3: a database-backed test harness for RLS policies (a throwaway PostgreSQL in the test run) — in no fleet plan; owner: the integrator to queue under DEC-31 (proposed: a cross-area "RLS against a database" package; `DACL-12` and `DACL-6` criterion 3 wait on the same harness).

**Pending migration:** `supabase/migrations/20261212_intel_roundG_node_visible_deny.sql` (after `20261203`).

**Partial (2026-10-14, intelligence I-12, at the integration merge).** The I-17 harness now exists (`npm run test:db`: a real PostgreSQL 16, every migration replayed, statements run as PostgREST runs a request — `SET ROLE` plus `request.jwt.claims`). Criterion 3 asks for exactly this finding's case, not merely a policy run per role, so a new harness suite asserts it: `lib/__tests__/rls/intelMentionRowsAcl.test.ts:78` — a Viewer without access to a mirrored PRIVATE document (granted to Engineer) gets zero `entity_mentions` rows for it (`:80`), the Engineer and a controller (Viewer + DocCtrl) get its row, another workspace's member gets nothing; `:90` — the mirror row itself follows the same access; `:120` — the sentence (`context_snippet`) of the private document is withheld with the row. These hold on the replayed install as pasted (`20261203`'s private branch). `20261212`'s deny binding is NOT applied as pasted — held back by default behind an operator switch that stays off, landing with intelligence I-30 (`DEC-90`, recorded on `DACL-12`) — so `:97` pins as OPEN that a NORMAL document whose index denies the Viewer's role read still reaches the Viewer (mention row and mirror row), and `:103` shows a scratch copy pasted with the switch on withholding it from the Viewer and keeping it for the others.

**Done-when.**
1. Partly — ✓ for a private / hidden document the reader is not granted; ✗ at the database for a normal row's read deny (held back by default until I-30), a normal row's allow-list and a private draft.
2. Partly — the same split.
3. ✓ Closed by pointer (accepted by the integrator, `DEC-90`, 2026-10-14): `lib/__tests__/rls/intelMentionRowsAcl.test.ts:78` (`:80`), run by `npm run test:db`.

**Remaining / owner.**
- **Assigned (2026-10-14, the integrator at the I-12 merge):** intelligence I-30 NODE_VISIBLE ALLOW-LIST, DROP BOXES AND INHERITED GRANTS (criteria 1–2's remainder — the read-deny binding `20261212` holds back by default, applied with drop-box support and no switch; the allow-list at the database, `DEC-90` R5; and the private-draft rule).

---

<a id="irls-10"></a>

## IRLS-10 · is_org_controller is SECURITY DEFINER with no SET search_path, and half the intelligence policies ignore the additive roles[] model it exists to honor

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260814_documents_delete_controllers.sql:31-41`, `supabase/schema.sql:1031-1034`, `supabase/migrations/20260928_site_codebook.sql:66-73`, `supabase/migrations/20260806_intelligence_layer.sql:44-51`, `supabase/migrations/20260807_link_proposals.sql:83-90`, `supabase/migrations/20260929_mention_engine.sql:79-86`, `lib/codebook.ts:381-387`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves verified. The consequence is documented in the app itself at lib/codebook.ts:382-387: "the codebook RLS write policy checks only the headline role column, so a client-side update could silently affect zero rows for a member whose DocCtrl authority lives in the additive roles[] array" — while is_org_controller (20260814:38) is precisely the function that DOES honor `roles && ARRAY['Admin','DocCtrl']`.

**Mechanism.** Two problems in one function family. (1) `CREATE OR REPLACE FUNCTION is_org_controller(p_org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ ... $$;` carries no `SET search_path` — unlike its siblings issue_document_number, user_can_publish_on_library, org_capability_allows and acl_index_denies, which all set it. Same for `my_org_ids()` in schema.sql:1031. is_org_controller is the sole write gate for knowledge_libraries, knowledge_documents, knowledge_chunks and knowledge_library_links, and appears in link_rules / answer_skills / process_flows UPDATE and DELETE — so it is the single most authority-bearing definer function in the intelligence layer. (2) is_org_controller deliberately honors the additive model — `role IN ('Admin','DocCtrl') OR roles && ARRAY['Admin','DocCtrl']::text[]` — but every hand-rolled intelligence policy checks the headline column only: codebook_entries_write, codebook_config_write, org_ai_instructions_write, document_related_resources_write, proposed_links_write, asset_aliases_write and entity_mentions_write all say `AND m.role IN (...)`. The codebase has already hit this and documented it at lib/codebook.ts:381-387 — but only routed ONE call (the area-knowledge binding) around it; saveUnitLinks, saveConfig, applyImport and the AddUnitModal still write client-side.

**Failure scenario.** Authority half: a member whose DocCtrl role lives in `roles[]` rather than in the mirrored `role` column opens the Site Codebook and edits a unit label. `codebook_entries_write` evaluates `m.role IN ('Admin','DocCtrl')` against their headline role — say 'Engineer-2' — and denies. PostgREST returns 204 with zero rows affected, not an error, so the UI shows success and the edit is gone on reload. The same member CAN create a knowledge library, because that path goes through is_org_controller. Two different answers to "are you a controller" in one product. Definer half: any role able to create objects in a schema that precedes `public` on the session search_path can shadow `org_members` and make is_org_controller return true unconditionally.

**Evidence.**

```
20260814_documents_delete_controllers.sql:31-33 — `CREATE OR REPLACE FUNCTION is_org_controller(p_org uuid)\nRETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$` (no SET search_path) vs 20260806_intelligence_layer.sql:147-151 `CREATE OR REPLACE FUNCTION issue_document_number(p_library_id UUID) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`. lib/codebook.ts:381-387 — `// NOTE: binding a unit to its knowledge library happens SERVER-SIDE // (POST /api/area/knowledge-status) — the codebook RLS write policy checks // only the headline role column, so a client-side update could silently // affect zero rows for a member whose DocCtrl authority lives in the // additive roles[] array.`
```

> **Verifier correction.** Two overstatements to correct. (1) The 'sole outlier' framing is wrong: I counted 61 SECURITY DEFINER occurrences across supabase/ and only 21 with an adjacent SET search_path — most definer functions here lack it (20260707:53, 20260708:46, 20260713:12, 20260813:35, 20260813:59, 20260817:22, 20260818:11/24/96/108 …). It is a Supabase-linter-grade hardening item, not an exploitable hole as shown: subverting it needs CREATE on a schema ahead of `public` in the caller's search_path, which the `authenticated` role does not hold by default, so this half is SUSPECTED. (2) The roles[] gap is narrower than 'half the policies ignore it': lib/roleCapabilities.ts:71-73 and :118-122 mirror the HIGHEST-ranked role into org_members.role (components/providers/RoleContext.tsx:201, admin/users/page.tsx:130), so a member holding DocCtrl plus anything lower still passes. It bites only members whose top-ranked role outranks DocCtrl (Manager 90, Supervisor 80, DraftingSupervisor 75 vs DocCtrl 70) — real, and exactly the silent-zero-rows case codebook.ts warns about, but a specific combination rather than a general failure.

**Done when.**

- [ ] is_org_controller, my_org_ids and the other 20 SECURITY DEFINER functions flagged without SET search_path get `SET search_path = public`
- [ ] every intelligence write policy that spells out `m.role IN (...)` is rewritten to call is_org_controller(org_id) (or an is_org_member_with_roles helper) so one definition of authority serves the whole layer
- [ ] a client write that RLS silently drops surfaces as an error — check affected-row counts on codebook/related-resource/alias updates rather than assuming success

**Partial (2026-09-30, intelligence Round G).** Verified and closed where this package owns the code. The search_path half is closed by R&P `DB-6` (`20261020` pins `is_org_controller`, `my_org_ids` and the historical definer set; `lib/__tests__/searchPathPin.test.ts` refuses a new unpinned definer — the plan's record-only close). The roles[] policy half is closed by R&P `ADD-4` (`20261046` rewrote all eight hand-rolled intelligence write policies — org_ai_instructions, document_related_resources, library_numbering, proposed_links, asset_aliases, codebook_entries, codebook_config, entity_mentions — to `caller_holds_any_role(org_id, …)`; the codebook / playbook limbs are pinned by census in `lib/__tests__/intelRoundGRegistry.test.ts`, and 20261128's probes verify them live). This round makes the codebook writes (`lib/codebook.ts`: upsertEntry, deleteEntry, saveUnitLinks, saveConfig) and the alias removal (`removeAssetAlias`) checked writes.

**Done-when.**
1. ✓ `SET search_path = public` on is_org_controller, my_org_ids and the flagged definers (R&P DB-6, 20261020; enforced by searchPathPin).
2. ✓ Every intelligence write policy that spelled `m.role IN (...)` calls the collection helper (R&P ADD-4, 20261046).
3. Partly — codebook and alias writes now check affected rows ✓; the related-resource writes (`lib/relatedResources.ts`) are I-08's file and still unchecked.

**Scope / residual.** The related-resource limb of done-when 3 is I-08's (`lib/relatedResources.ts`).

**Resolution (2026-09-30, intelligence Round G, I-08).** The remaining limb of done-when 3 — the related-resource writes, named for I-08 in the Partial block above — is closed: `lib/relatedResources.ts` `addRelatedResource` and `removeRelatedResource` ask for their rows back and throw when RLS refused (42501, or zero rows without an error: "That link was not changed — your role cannot edit related links on this document"); `components/documents/RelatedPanel.tsx` shows the refusal. The proposal decisions on the same surface (`approveProposal`, `dismissProposal`, `reopenProposal`) are checked the same way. The role-list limb of this finding on `proposed_links_write` / `entity_mentions_write` was already the collection since `20261046` (`caller_holds_any_role`); `20261126`'s probes verify it live and it is not re-created. Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("an unpin RLS refuses is reported (checked write)", "a dismissal can be reopened; a decision RLS refuses is an error …").

**Done-when.**
1. ✓ (R&P `DB-6`, `20261020`; see the Partial block).
2. ✓ (R&P `ADD-4`, `20261046`; the proposal / mention write policies verified by `20261126`'s probes).
3. ✓ Codebook and alias writes (I-10), related-resource and proposal-decision writes (I-08) check what they affected.

**Scope / residual.** None.

---

<a id="irls-11"></a>

## IRLS-11 · process_flows lets any active member insert a status='confirmed', origin='ai' edge into the plant's flow topology

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261017_process_flows.sql:49-54`, `supabase/migrations/20261017_process_flows.sql:22-28`, `lib/processFlows.ts:50-68`, `app/(protected)/graph/page.tsx:309-346`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the UI path: app/(protected)/graph/page.tsx:334-346 calls createManualFlow for any asset↔asset or unit↔unit pair, and grep for role/ADMIN_ROLES in that page returns no authorization gate on Connect mode. Over PostgREST a member can also set origin='ai' directly, since only created_by is checked.

**Mechanism.** `process_flows_insert` requires active membership and `created_by = auth.uid()` — nothing else. It constrains neither `status` (whose CHECK allows 'proposed'|'confirmed'|'dismissed') nor `origin` (whose CHECK allows 'manual'|'ai') nor `source_document_id`. So the two-stage doctrine the migration describes — "proposed (AI-read, awaiting a human) / confirmed" — is a client-side convention only. `createManualFlow` hard-codes `status: "confirmed", origin: "manual"`, but any caller hitting PostgREST directly picks its own values. The graph's Connect mode reaches this with no role test at all: `completeConnect` checks only `if (from.id === target.id || !activeOrgId || !uid) return;` before calling createManualFlow. Separately, `source_document_id UUID REFERENCES knowledge_documents(id)` has no org predicate in the WITH CHECK, so a fabricated row can cite a knowledge document in another org.

**Failure scenario.** A Requester opens /graph, enters Connect mode, and drags a line from vessel V-201 to pump P-310 — two pieces of equipment that are not connected in the plant. A confirmed flow edge is written. The Process lens now renders it as part of the plant's flow map, and the unit hub's FlowPanel shows it as settled rather than as a proposal awaiting review. Worse, a direct POST setting `origin: 'ai', status: 'confirmed', source_document_id: <a real PFD>` produces an edge that reads to every later viewer as "the AI read this off drawing X and a human confirmed it."

**Evidence.**

```
20261017_process_flows.sql:49-54 — `CREATE POLICY process_flows_insert ON process_flows FOR INSERT WITH CHECK (\n  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = process_flows.org_id\n          AND m.uid = auth.uid() AND m.status = 'active')\n  AND created_by = auth.uid()\n);` app/(protected)/graph/page.tsx:309-310 — `const completeConnect = React.useCallback(async (from: GraphNode, target: GraphNode) => { if (from.id === target.id || !activeOrgId || !uid) return;` — no role check anywhere in the callback before createManualFlow at :336.
```

> **Verifier correction.** Downgrade to MEDIUM: the delta PostgREST buys an attacker is smaller than stated. Connect mode is deliberately open to every member and already writes status='confirmed' rows through the UI (page.tsx:334-344), so 'any member can add a confirmed flow edge' is intended behavior, not a policy hole. The genuine surplus is narrower — spoofing origin='ai', status='proposed', and a cross-org source_document_id, i.e. laundering a hand-typed edge as an AI reading with fabricated provenance, plus self-acceptance since process_flows_update allows `created_by = auth.uid()`. Fix by constraining origin/status/source_document_id in the WITH CHECK.

**Done when.**

- [ ] process_flows_insert forces `origin = 'manual' AND status = 'proposed'` for non-controllers, leaving 'confirmed' and 'ai' to is_org_controller(org_id)
- [ ] the graph's Connect mode is gated on the same authority as the flow review UI, so the affordance matches the permission
- [ ] a WITH CHECK predicate ties source_document_id to a knowledge_documents row in the same org

**Resolution (2026-10-01, intelligence Round G).** One root with `FLOW-2` / `AREA-3` / `IEDGE-7`; see `FLOW-2` for the migration and the scratch PostgreSQL 16 cases. Reproduced first: the INSERT policy constrained neither status, origin nor source.

**Done-when.**
1. ✓ `process_flows_insert` (re-created from `20261017` plus three clauses) requires `status = 'proposed'` unless `is_org_controller(org_id)`, and `origin = 'manual'` with no source document. The guard enforces the same before the policy runs, and refuses a forged `origin 'ai'`.
2. ✓ Met by its letter: Connect is gated on the same authority as the flow review UI, and the affordance matches the permission. By decision (`DEC-80` item 1), Connect stays open to every member as a proposal, and the database decides what lands (`20261155`): a controller's draw lands `confirmed`, anyone else's `proposed`. The review UI's controls follow the same tier (`FLOW-3`): anyone proposes, a controller confirms. So what Connect offers (draw a flow) is what each member may do (propose one; confirm only as a controller). *(Second fix pass: this line was ticked outright, then marked ✗ for how the graph shows a proposal. Third fix pass: the criterion names the gate and the affordance, not the wording on the screen, so it is judged by that letter. The presentation is a residual reassigned to I-14 under Scope / residual, not a done-when of this finding.)*
3. ✓ A source document is tied to a knowledge document of the same org, for every writer, in the guard (`process_flows_source`, 23503; the scratch case refused a cross-workspace source from the service role). A person cannot set one at all. Existing cross-workspace sources are counted in the inventory, never rewritten.

**Scope / residual.** Pending migration `20261155`. **Reassigned to I-14** (`app/(protected)/graph/page.tsx`, not edited here): the graph shows a proposal as an error. `completeConnect` awaits `createManualFlow`. A non-controller's flow is written as `proposed` and the call throws `FlowProposedNotice`; the graph's generic catch shows the notice's sentence in Connect's error slot and draws no edge. I-14 catches the notice as a success ("proposed — a document controller confirms it"). Since the third fix pass a Connect on a pair already in the table (23505) throws too: `FlowProposedNotice` ("That flow is already proposed …") for a proposal, `FlowDismissedNotice` for a pair a controller dismissed, and an error when the existing row's status cannot be read. Only a confirmed pair returns `"exists"`. The graph draws none of them; showing the two notices as notices is the same I-14 handoff (`FLOW-2`). Fix pass: the first version of the guard also refused a person CLEARING the source. That is the UPDATE 20261017's `ON DELETE SET NULL` runs, so deleting a cited knowledge document, controlled document or library failed with `process_flows_fixed`. The guard now lets a source be cleared, and still refuses setting or retargeting one. The correction, the reproduction and the scratch PostgreSQL 16 cases are on `FLOW-2`.

---

<a id="irls-12"></a>

## IRLS-12 · schema-health is blind to answer_skills, link_rules, process_flows and knowledge_line_traces — three live features can be entirely missing and the panel reports green

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/schemaExpectations.ts:1-13`, `lib/schemaExpectations.ts:29-113`, `supabase/migrations/20261015_connection_skills.sql:16`, `supabase/migrations/20261016_reasoning_skills.sql:14`, `supabase/migrations/20261017_process_flows.sql:14`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. The core claim holds for answer_skills, link_rules and process_flows. The fourth name is wrong: knowledge_line_traces is a RETIRED feature, not a live one — supabase/migrations/20261007_retire_line_traces.sql:9 `DROP TABLE IF EXISTS knowledge_line_traces;` and the only remaining reference is lib/exportTables.ts:177, so its absence from EXPECTED_TABLES is correct, not a gap. Severity unchanged; the finding should say three tables, not four. (Also unprobed but outside the claim: change_orders, checklist_items, companies, company_events, project_checklists, punch_items, turnover_items.)

**Mechanism.** EXPECTED_TABLES was, by its own header, "Generated from supabase/migrations (CREATE TABLE scan) ... When a new migration creates a table, add it here — the health panel is only as honest as this list." Diffing every CREATE TABLE in supabase/migrations against the table names in EXPECTED_TABLES shows eleven omissions, four of them in this lens: answer_skills (20261016), link_rules (20261015), process_flows (20261017), knowledge_line_traces (20261007, since retired by 20261007_retire_line_traces.sql so its absence is correct). Every consumer of the three live ones treats a missing table as a benign setup state — lib/answerSkills.ts:29-30 `const missing = (e) => !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""))`, lib/processFlows.ts:31-32 identical, lib/answerSkillsServer.ts:60 `if (res.error) return ""; // pre-migration — degrade silently`.

**Failure scenario.** An operator pastes migrations up to 20261014 and stops. /api/admin/schema-health probes every EXPECTED_TABLE, finds them all, and reports the database healthy. Meanwhile the Skill Library page lists nothing, Reasoning Skills contribute an empty prompt block on every answer, the graph's Process lens renders no flow edges, and Connect mode's flow branch throws on insert. All four surfaces are indistinguishable from "nobody has set this up yet."

**Evidence.**

```
lib/schemaExpectations.ts:11-13 — `// Generated from supabase/migrations (CREATE TABLE scan) + curated column\n// probes for feature-critical ALTERs. When a new migration creates a table,\n// add it here — the health panel is only as honest as this list.` A scripted diff of `CREATE TABLE [IF NOT EXISTS] <name>` across supabase/migrations/*.sql against `table: "<name>"` in that file returns: answer_skills, change_orders, checklist_items, companies, company_events, knowledge_line_traces, link_rules, process_flows, project_checklists, punch_items, turnover_items.
```

**Done when.**

- [ ] answer_skills, link_rules and process_flows are added to EXPECTED_TABLES with their migration filenames (and the seven project-controls tables too)
- [ ] a unit test regenerates the CREATE TABLE scan and fails when a migration creates a table absent from EXPECTED_TABLES
- [ ] the three libs distinguish 42P01 from an empty result in what they show the user

**Partial (2026-09-30, intelligence Round G).** Re-verified at HEAD `1b71ca1`. Landed elsewhere: the seven project-controls tables are on the list with their migration (`lib/schemaExpectations.ts:51`–`:126`, projects Round G J9 `REL-7`), and criterion 2's tripwire exists — `lib/__tests__/schemaExpectations.test.ts:155-159` fails when a migration creates a table absent from `EXPECTED_TABLES` — ✓ for every table created from now on. Open: `answer_skills`, `link_rules` and `process_flows` are still absent, and the tripwire grandfathers them — among five (`answer_skills`, `document_markups`, `knowledge_line_traces`, `link_rules`, `process_flows`, `:71`) — so criterion 1's intelligence half is not done; criterion 3 (42P01 vs an empty result, in what the libs show) is untouched. Owners: criterion 1 → admin-and-org **P2** (`BKP-14`, the list regeneration that empties the grandfather set; cross-note there); criterion 3 → the limbs in intelligence **I-08** (`lib/linkRules.ts`, `lib/answerSkills.ts`) and **I-09** (`lib/processFlows.ts`).

*Cross-note (2026-10-01, admin-and-org Round G, P2): criteria 1 and 2 ✓ by admin-and-org `BKP-14` (RESOLVED). The three tables are listed with their files, `knowledge_line_traces` is recorded as retired, and the grandfather set is empty. Criterion 3 (42P01 vs an empty result in what the libs show) remains I-08's and I-09's.*

*Pointer (2026-10-01, intelligence Round G, I-09 — criterion 3's `lib/processFlows.ts` limb).* `listProcessFlows` / `listProcessFlowsPaged` answer null ("process flows aren't installed yet") only for a missing TABLE (42P01 / PGRST205 / "relation … does not exist" / "could not find the table"). A missing column, or any other read error, is thrown and shown, never "not installed". Before, `/does not exist/` matched a missing column too. Test: `lib/__tests__/processFlowsLib.test.ts` ("IRLS-12 limb …"). No status change: criterion 1 is A&O P2's, and the other two libs are I-08's.

**Resolution (2026-10-13, intelligence Round G).** Package I-01 phase B, closed by pointer and re-verified on base `596d34e`.
- Criteria 1 and 2: admin-and-org `BKP-14` (RESOLVED, the cross-note above). `lib/schemaExpectations.ts` lists `answer_skills`, `link_rules` and `process_flows` with their files and records `knowledge_line_traces` as retired. `lib/__tests__/schemaExpectations.test.ts` checks both directions with an empty grandfather set.
- Criterion 3, every limb. `lib/processFlows.ts` (I-09, the pointer above; `missingTable`, `:49-55`, used at `:84`). `lib/linkRules.ts` (`missing`, `:45-46`; `listLinkRules` answers null for a missing table and `[]` for an empty shelf, `:92-95`). `lib/answerSkills.ts` (`:37-38`, `:81-84`), the I-08 limb. The screens say "not installed" only for null: `components/intelligence/ConnectionSkillsPanel.tsx:380-381`, `:411-412`; `app/(protected)/intelligence/skills/page.tsx:116`, `:148`.
- Test, new on this pass: `lib/__tests__/intelRoundGLifecycleRecords.test.ts`, "IRLS-12 criterion 3". For both skill libraries, a 42P01 is null, an empty shelf is `[]`, and any other read error is thrown. Mutation-checked: answering `[]` for a missing table fails it. `processFlowsLib.test.ts` pins the flows limb.

**Done-when.**
1. ✓ — `BKP-14`.
2. ✓ — `BKP-14`.
3. ✓ — all three libraries.

**Scope / residual.** None that a criterion names. One remainder, with an owner under DEC-31 (review fix pass; it was first recorded with none). The skill libraries' `missing` test (`lib/linkRules.ts:45-46`, `lib/answerSkills.ts:37-38`) is `42P01` or `/does not exist/`, which a missing COLUMN (42703, "column … does not exist") also matches. So a shelf read naming a column the database lacks would show "not installed" instead of the error. `lib/processFlows.ts` was tightened against exactly this. No shelf read reaches it on today's schema. The page reads order by `builtin_key`, `created_at` and `id` (`lib/linkRules.ts:79-81`, `lib/answerSkills.ts:68-70`), all columns `20261015` / `20261016` created. The later columns are read in the share-request read, which has its own missing-column fallback (`readSkillShelf`, `lib/skillAuthority.ts`). The fix is to tighten `missing` to 42P01 / PGRST205 / "relation … does not exist" / "could not find the table", as `lib/processFlows.ts missingTable` does. It is not made here because both files are I-08's. An expected-fail tripwire pins it: `lib/__tests__/intelRoundGLifecycleRecords.test.ts`, "a missing COLUMN (42703) is thrown, never shown as 'not installed' (open residual)", `it.fails` for both libraries. Whoever tightens `missing` flips it to `it`. Proposed owner: intelligence **I-26** (queued, the intelligence follow-up package), for the integrator to assign.

---


<a id="irls-13"></a>

## IRLS-13 · An answer does not say which Reasoning Skills shaped it

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** intelligence I-03 THE ASK ROUTE — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Assigned:** intelligence I-20 AI UI REMAINDERS (done-when 2's orchestrator half: `app/api/orchestrator/route.ts` on `loadAnswerSkills`, `skills` returned and named on its answer surface) — by the integrator, 2026-10-02 (at the I-03 merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `lib/answerSkillsServer.ts` (`loadAnswerSkillsBlock`), `app/api/knowledge/ask/route.ts` (the answer response), `app/api/orchestrator/route.ts`
- **Opened 2026-09-30 (intelligence Round G, I-08)** as the remainder of `IRLS-3` (`DEC-31`): `IRLS-3`'s third done-when is in the ask route and the answer UI, which another package owns (I-03).

**Mechanism.** `loadAnswerSkillsBlock` returns only the assembled prompt text. Neither the ask route nor the orchestrator returns which packs rode the prompt, so an answer shaped by an org-wide Reasoning Skill looks like every other cited answer. Since `20261125` only a controller can publish an org-wide pack (`DEC-62`), so this is now about transparency rather than about who can inject a pack.

**Done when.**

- [ ] The skills loader returns the names (and ids) of the packs it included alongside the block.
- [ ] The ask response and the orchestrator response carry that list, and the answer UI names the skills that shaped an answer.

**Partial (2026-10-01, intelligence Round G, I-03).** The loader and the ask route. `lib/answerSkillsServer.ts`: `loadAnswerSkills` / `buildAnswerSkills` return the block AND the packs it carries (`id`, `name`, `builtinKey`), in the order they ride; a pack the block budget cut is not listed; `loadAnswerSkillsBlock` is unchanged for its other caller. The ask response carries `skills`, the row records their names (`context.skills`), and the answer surface says "Shaped by: …" beside the retrieval chip.

Tests: `askRouteUnits.test.ts` "IRLS-13 — buildAnswerSkills names the packs that rode the block, and only those" and "IRLS-13: the answer names the Reasoning Skills that shaped it"; `askRouteHonesty.test.ts` "IRLS-13 — …" ("the packs that rode the prompt come back on the response and are recorded on the row", "no pack, no list").

**Done-when.**
1. ✓ The skills loader returns the names and ids of the packs it included alongside the block.
2. Partly. ✓ The ask response carries the list and the answer UI names them. ✗ The orchestrator (`app/api/orchestrator/route.ts`, which still calls `loadAnswerSkillsBlock`) and its answer surface are the orchestrator's owner's; switching it to `loadAnswerSkills` and returning `skills` is a two-line change there.

**Scope / residual.** OPEN on the orchestrator half.

**Resolution (2026-10-02, intelligence Round G).** Package I-20, the orchestrator half of done-when 2. Reproduced first on the base (`3bf3b75`): `/api/orchestrator` called `loadAnswerSkillsBlock` and returned no skills, and the assistant's answer named none (`orchestratorSkills.test.ts` and `assistantSkillsSurface.test.ts`: each reproduction case fails against the base sources).

- `app/api/orchestrator/route.ts` (`:123`) reads the packs through `loadAnswerSkills` (`lib/answerSkillsServer.ts`), which makes the same reads, seeding and author rule as the block. The model's prompt is the same (instructions + skills block + atlas, in that order). The response carries `skills` (`{ id, name, builtinKey }`, in the order they rode, `:243`) only when a pack rode, which is the ask route's shape. No pack means no field.
- `lib/orchestratorClient.ts`: `OrchestratorReply.skills?`.
- The assistant's answer surface (`app/(protected)/assistant/page.tsx`, `:301`) says "Shaped by: …" with each pack's name, as the library Ask surface does.

Tests: `lib/__tests__/orchestratorSkills.test.ts` (the route returns the packs from `loadAnswerSkills`, and the block the model was given is theirs; REGRESSION: the prompt's playbook is unchanged, and a run with no pack answers with exactly the keys it answered with before), `lib/__tests__/assistantSkillsSurface.test.ts` (rendered: "Shaped by: …"; no chip without skills). `orchestratorTaint.test.ts` and `orchestratorExecute.test.ts` mock `loadAnswerSkills` beside `loadAnswerSkillsBlock`.

**Done-when.**
1. ✓ (2026-10-01, I-03) The skills loader returns the names and ids of the packs it included alongside the block.
2. ✓ The ask response (2026-10-01, I-03) and now the orchestrator response carry that list, and both answer surfaces name the skills that shaped an answer.

**Scope / residual.** None for this finding. `loadAnswerSkillsBlock` (`lib/answerSkillsServer.ts`) has no production caller left; only tests use it. A later package may remove it.

---

<a id="irls-14"></a>

## IRLS-14 · The graph shows an unbuilt or failed mention index as an empty map

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** intelligence I-14 GRAPH PAGE, LENSES & RENDERERS (the `lib/orgGraph.ts` half coordinates with I-13) — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Assigned:** intelligence I-23 MENTION INDEX RUN STATE (done-when 1's remainder: a build that failed elsewhere is named on the map; plus the backfill's missing cursor) — by the integrator, 2026-10-07 (at the I-14 merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/intelligence.json`).
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx`, `lib/orgGraph.ts` (mention edges), `lib/mentions.ts` `mentionCoverage`
- **Opened 2026-09-30 (intelligence Round G, I-08)** as the remainder of `IRLS-4` (`DEC-31`): the graph page belongs to another package (I-14).

**Mechanism.** Since `20261126` the mention engine can write, and `/api/graph/mentions` returns the rows it wrote. The graph still draws zero `mention` edges the same way whether the index was never built, the last build failed, or the corpus really names no registry equipment. `mentionCoverage` already tells "not installed" (42P01) from "installed, 0 rows", but the graph does not use it.

**Done when.**

- [ ] The graph reads `mentionCoverage` and, with zero mention edges, says which case it is, with the next step (run the indexer / see the failure).

*Handoff (2026-10-01, intelligence Round G, I-13; corrected at the fourth review): `OrgGraph.mentionCoverage { installed, rows, drawn, unmapped, capped }` exposes only what the mention read can tell — `installed: false` when entity_mentions does not exist (42P01), and `installed: true, rows: 0` when it exists but no row is visible to this reader; `drawn` the mention edges on the map, `capped` when the read stopped at the edge cap. It does NOT tell "never built" from "built, nothing named" from "built, every row out of view" (with `rows: 0` all three look the same), and it carries no failed build: the indexer (`lib/mentionIndexer.ts`) keeps no run state — a failure is logged and thrown to its caller. The done-when's "see the failure" therefore needs an index-run state (a last run, its outcome, its error) that does not exist yet; I-14 must read or add it elsewhere, not infer it from `mentionCoverage`. The first handoff line said the lib half was exposed whole; it is not.*

**Partial (2026-10-02, intelligence Round G).** The graph reads `OrgGraph.mentionCoverage` (I-13's half). With zero mention edges drawn, the map says which case it can tell, with the next step (`lib/graphView.ts` `mentionNotice`; `app/(protected)/graph/page.tsx:786`, the notice in the map's note strip):
- **Not installed** (42P01): "The mention index is not installed (migration 20260929_mention_engine.sql) …".
- **Installed, no row visible to this reader**, equipment on the map: the map names both cases it cannot tell apart — "Either the mention index has not been built for these documents, or it found none of this registry's equipment named in the documents you can see — the map cannot tell which." It offers "Rebuild the mention index" to the roles `/api/graph/mentions` admits (Admin, DocCtrl, Manager, Supervisor by the role collection, `hasAnyRole`). The rebuild POSTs the route. It says what was read and written, or the route's failure verbatim ("The mention index could not be rebuilt: …"), and rebuilds the map.
- **Installed, no equipment on the map**: "there is no registry equipment on this map for a document to name".
- **Rows read but none drawn**: points at the map's notes, which say why (unmapped / unresolved / beyond the cap).

Tests: `graphView.test.ts` "IRLS-14 — no mention links, and which case"; `graphPageRender.test.ts` (the notice; the rebuild for a controller, not for a Viewer; a failed rebuild said with the route's reason).

**Done-when.**
1. Partly. ✓ The graph reads the coverage, says which case, and gives the next step: run the indexer, from the map. A run's failure is shown when the run is started from the map. **Not met:** a build that failed ELSEWHERE cannot be named. The ingest-time pass (`lib/knowledgeIngest.ts` `rebuildDocumentMentions`) swallows its errors (`catch {}`), and the indexer keeps no run state. So "the last build failed" is indistinguishable from "never built", and the map does not claim either.

**Scope / residual.** "See the failure" needs an index-run state: a last run, its outcome and its error, written by `lib/mentionIndexer.ts` and `lib/knowledgeIngest.ts`'s pass, plus a migration to hold it. Neither file is this package's: `lib/knowledgeIngest.ts` is I-06b / I-20's, and the plan expects no migration here. Noted for the owner: the org-wide backfill (`backfillOrgMentions`) restarts at the first document on each POST (no cursor). A rebuild that hits its time limit says so ("the rest were not reached this run"), and a second press does not continue where it stopped.

**Resolution (2026-10-07, intelligence Round G).** I-23 (MENTION INDEX RUN STATE) closes done-when 1's remainder: a build that failed elsewhere is now named on the map, and a rebuild that stops at its time limit is continued by the next press, with the dictionary it read with.

Reproduced on HEAD `95775da` first (DEC-29), against the real engine and the in-memory database:
- An ingest-time build whose cleanup was refused left no trace anywhere. `rebuildDocumentMentions` swallowed it (`catch {}`), and only the indexer's own server-log line remained.
- Two presses of a rebuild with a deadline that stops after two documents both read k1 and k2. The second press restarted at the first document and never reached k3.

What landed:
- **The run state.** New file `lib/mentionRunState.ts`. It takes the caller's client and imports none. It owns one row per org in `mention_index_runs` (`20261194`), holding three things:
  - the last build: where it ran (`ingest` or `map`), when it started, and how it ended (`running`, `succeeded`, `failed`, or `stopped` at its time limit). A build's end is written only while it is still the last build, a compare on its own run id; `finishMentionRun` answers whether the end landed, and a build superseded by a later one is answered `false` deliberately, not logged as a refusal;
  - the last failed build: where, when, which knowledge document, and its error in plain words. `plainBuildError` gives the step that failed and why, from `classifyDbError`. It never shows a table, column or policy name, and anything unknown is said as unexpected. The raw text stays in the server log;
  - a rebuild's place, from its start to its end: its state (`running` while a press reads; `time_limit` or `failed` when the press stopped), the last knowledge document it finished (by id), when the rebuild began, how many documents it has read, when the place was saved, and a fingerprint of the equipment dictionary it reads with. `readBackfillPlace` reads it the same way for the map: running (saved within `REBUILD_ALIVE_MS`, 2 min), continue (by why it stopped: time limit, failure, or cut off), too old (`BACKFILL_RESUME_MAX_MS`, 24 h), or nothing to continue.
  - A success clears the failure that stood when it started, through a compare on its time, so a newer failure is never cleared. Every writer and the reader take PGRST205 / 42P01 / 42703 / PGRST204 as "not installed". Nothing is then recorded or read, and the log says so once. Any other refusal is logged and never thrown.
  - Every UPDATE goes through `checkedWrite` on a `supabase` chain, so SAF-18's census (`lib/__tests__/checkedWrite.test.ts`) judges the file; the two upserts check the rows they return.
- **The ingest-time pass.** `lib/knowledgeIngest.ts` `rebuildDocumentMentions` records its start (source `ingest`, the document), then its outcome.
  - A failure is recorded instead of `catch {}`. The batch still never sees it, and the outcome is written when the build settles, even after the 8 s cap let the batch go on.
  - The start is written beside the build, not before it, and a pass that could not start (its engine or its dictionary read failed) is recorded within the same cap: the batch waits no longer than the cap for the run state.
  - A success clears this document's own standing failure.
  - An empty equipment dictionary builds and records nothing, as before.
  - Every I-05 / I-06b / I-18 / I-22 limb in the file is untouched (the MERGE notes in `99-fix-sequencing.md`).
- **The rebuild from the map.** `lib/mentionIndexer.ts` `backfillOrgMentions` records each rebuild (source `map`).
  - It reads the ready documents in id order, 500 at a time (keyset). It claims its place as `running` from its start, re-saves it every 10 s, and marks it `time_limit` or `failed` when it stops.
  - The next press continues after the last document finished (after a failure, that document is tried again first) only when the equipment dictionary's fingerprint (`dictionaryFingerprint`: every asset id, alias and origin, sorted, sha256) is the one the place was saved with, and the rebuild began less than 24 h ago. Otherwise it reads from the first document, overwrites the place, and answers `startedOver: "equipment_changed" | "too_old"`; the page says so.
  - A rebuild that reads to the end clears the place, and the failure that stood before it began. A continued press that reads to the end also clears a failure naming no document (only a press whose window listing was refused writes one; the ingest pass always names its document) that stood when that press began — before the integrator fix pass such a failure stayed named on the map after the whole corpus had been read across the presses.
  - It answers `resumable` (a stopped press whose place is saved), `continued` / `passDocuments` (a press that continued one) and `startedOver`, only where the run state is recorded. Otherwise the answer has exactly the keys it had before.
  - A failure still throws the same error, so the route's 500 is unchanged.
  - Side effect of the windowed read: a corpus larger than one PostgREST page is read whole. Before, one unbounded select could stop at the server's row cap and report a complete rebuild.
- **The map.** `lib/graphView.ts` `mentionNotice(cov, equipmentOnMap, run?, readAt?)` keeps the coverage's sentence exactly (now `coverageNotice`). `mentionRunNotes` adds what the run state says, beside it, and also where links ARE drawn ("Some “mentioned in the text” links may be missing from this map."):
  - the last build that failed: where it ran (at ingest, or from this map), when (`formatRunTime`), and its error in plain words;
  - a rebuild from this map that is running now (its place saved within 2 min, or a map build started that recently): said as running, with no button at all — `mentionRunNotes` answers `running`, and `mentionNotice` then offers neither "Continue" nor the coverage's own "Rebuild the mention index" (integrator fix pass: before it, the "cannot tell" coverage's offer still rendered beside "is running now", and a press would have continued the running press's place in parallel with it). Once the place is older than 2 min the press reads as cut off and the offer is back;
  - a rebuild that stopped, by why: at its time limit, on a failure ("stopped on a failure after N documents; continue it to try that document again"), or cut off without reporting; each with `canContinue`. One that began more than 24 h ago is said too old to continue, and the rebuild is offered instead;
  - a build that never reported how it ended, once it is older than `BUILD_STALE_MS` (15 min) and the place does not already say it.
  - Nothing is added on a map whose index is not installed, or that has no equipment on it (`equipmentOnMap` 0).
  - `app/(protected)/graph/page.tsx` reads the run state as the member (`readMentionRunState(supabase, …)`, the member columns only, re-read after a rebuild). The rebuild button reads "Continue the rebuild" when the notice offers to continue; it sends the same request. The press's message says a stopped press's place is saved, when a press continued an unfinished rebuild, and when it started again from the first document and why.
  - A failure from a press on the map is said exactly as before ("The mention index could not be rebuilt: …", the route's reason verbatim).

**Fix pass (2026-10-07, review of I-23).** The review found two blockers and five minors; each is fixed above, and the claims they made untrue are corrected in place:
- *Corrected:* a saved place was continued by every later press, whatever had changed since, and the page then said the index was rebuilt — so a press days later, after equipment was added, never read the documents before the place for the new tags. The place now carries the dictionary's fingerprint and its age; a press continues it only with the same dictionary within 24 h (test "reproduction of the review's blocker: stop after 2 documents, add equipment, press again — the read starts at k1").
- *Corrected:* any saved place was said as "stopped at its time limit" and offered "Continue", including a rebuild still running (saved every 10 s) and one that failed. The place now records its state, written as `running` from the press's start and as `time_limit` / `failed` only when it stops; the map says each as what it is.
- *Corrected:* "nothing is added on a map that has no equipment" held only when no rows were read either; the guard is now `equipmentOnMap === 0`, as the sentence says.
- *Corrected:* the member read handed every active member the knowledge-document ids on the row (including mirrors KACL-7 hides) and the cursor. `20261194` now grants SELECT on twelve member columns only; the reader selects exactly those (`MENTION_RUN_MEMBER_COLUMNS`); the ids, the cursor, the run id and the fingerprint stay the service role's.
- The run-state writes were invisible to SAF-18's census (a `client` parameter); they are now `checkedWrite` calls on a `supabase` chain, and `finishMentionRun`'s deliberate zero-row tolerance is its return value.
- The ingest pass awaited the run state's start, and the catch's failure record, outside its 8 s cap; both are now inside it.

**Integrator fix pass (2026-10-08, re-review of I-23).** Two minors, each fixed and its claim corrected in place:
- *Corrected:* "a rebuild that reads to the end clears … the failure that stood before it began" compared only against the FIRST press's start, and the per-document clear matched only a failure naming a document — so a press whose window listing was refused (a failure naming no document, recorded after the first press began) stayed named on the map after the next press continued to the end. The end-of-corpus clear now also clears a failure naming no document that stood when this press began; one recorded after it began stands (test "integrator fix pass: a press whose document listing is refused …").
- *Corrected:* "no rebuild offered by the note" was the note's answer only; `mentionNotice` OR-ed it with the coverage's own offer, so the "cannot tell" map showed "Rebuild the mention index" beside "is running now". The running reading now wins (`running` from `mentionRunNotes`); no button is offered while the place says running within `REBUILD_ALIVE_MS`.

**Pending migration:** `supabase/migrations/20261194_intel_roundG_mention_run_state.sql` (DEC-30). It creates `mention_index_runs`:
- one row per org, `org_id` the key, `ON DELETE CASCADE`; 18 columns (the place's state, save time and fingerprint added in the fix pass);
- seven CHECKs: the sources, the outcome, the count, the error's length, the place's state, the fingerprint's length;
- RLS on, with one policy, `mention_index_runs_member_read`: SELECT for `authenticated`, an active member of the row's org;
- every privilege revoked from anon and authenticated (which also revokes any column privilege, so a re-paste starts clean), SELECT granted back to authenticated on the twelve member columns only, and the service role writes. No write policy and no function, so there is no SECURITY DEFINER body for DRLS-16.

It is a narrow widening: every active member may read their own org's row, column by column — when the last build ran, from where and how it ended; when and where the last failure was and its plain-words error; a rebuild's state, when it began and was saved, and how many documents it has read. No document id, name or text, no person. The TEMP inventory before the transaction gives counts only: whether the table already existed (a re-run), orgs, active members (who gain the read), mention rows, and ready knowledge documents. One final SELECT carries eight probes and an after-count. Apply after `20260929`; it is independent of every other pending file. The app may deploy before or after the paste and keeps working unpasted: nothing is recorded, the map says what it said before, and every press starts at the first document.

Verified on a throwaway PostgreSQL 16 with stub `orgs` / `org_members` / `knowledge_documents` / `entity_mentions`, Supabase's roles and default grants, and `auth.uid()` from the JWT claim (first build, and again in the fix pass on a fresh cluster):
- First paste, a re-paste, and a paste over the first build's table (table-wide SELECT granted, a row with a cursor): every probe true (8/8 in the fix pass), the inventory saying 1 = a re-run. The paste over the first build's table withdrew its table-wide SELECT and a stray column grant on `backfill_cursor` (the table-level REVOKE), and kept the row's cursor and count.
- The service role upserted the last-build columns, then the failure columns, then wrote the place. Each kept the others'.
- A compare on the failure time as PostgREST returns it (`"…:01.456+00:00"`) cleared it; a stale time matched nothing.
- Each CHECK refused a source, an outcome, a count, a place state and a fingerprint outside the vocabulary.
- An active member of A read A's row only, through the twelve member columns; `SELECT *`, the cursor, each document id, the run id and the fingerprint were each refused (permission denied), and their INSERT / UPDATE / DELETE were refused. A removed member of A and a session with no user read nothing; an active member of B read B's row only; anon was refused. The row went with its org.
- Each cluster was stopped and deleted.

Tests:
- `lib/__tests__/intelRoundGMentionRunState.test.ts`: the two reproductions (a failed ingest-time build recorded, the batch unaffected; a stopped rebuild continued by the second press, reading k3–k5 only); a failed map-started build (the route's 500 exactly as today, the failure recorded with the place marked `failed`, the next press retrying that document first); the regressions (a successful build's mention rows identical with and without the table; a whole rebuild answering the same keys; the table absent, where every press starts at k1 and nothing is written); the 8 s cap; place saves; the failure compare; plain words; and `mentionNotice` (every coverage shape identical with no run state or a succeeded one or a running ingest-time build; failed at ingest named; links drawn; stopped → continue; stale → named). Fix pass: the review's blocker reproduced (stop after 2, add equipment, the next press reads from k1 and answers `startedOver`); a changed alias; a place older than 24 h; the place claimed `running` from a press's start; a rebuild failing on its first document leaving nothing to continue; the fingerprint; the map's running / failed / cut-off / too-old sentences; `readBackfillPlace`; the census statement rule over `lib/mentionRunState.ts`; `finishMentionRun`'s answer for a superseded build; the cap holding against a gated start and a gated failure record; the member read's columns.
- `lib/__tests__/graphPageRender.test.ts` "IRLS-14 (I-23)": a failed ingest-time build named on the rendered map (a Viewer sees it, without the button), read through the member columns; "Continue the rebuild" sending `{ orgId }` and saying it continued; a stopped press's message; a failed map-started build named as today; PGRST205 / 42P01 / a denial / a succeeded run / no row, each rendering exactly the old notice and button. Fix pass: a running rebuild said as running, with no button where links are drawn; a failed rebuild with its place saved said as stopped on a failure, with "Continue the rebuild"; a press that started over says why. Integrator fix pass: a running rebuild on the "cannot tell" map, said as running with no button and no request sent.
- `lib/__tests__/intelRoundGMentionRunStateMigration.test.ts`: the one-paste shape, the columns equal to `MENTION_RUN_COLUMNS`, the CHECK vocabularies, the policy and grants (the column grant equal to `MENTION_RUN_MEMBER_COLUMNS`, no id among them), no function / trigger / view, the header, and the tolerance in the code.

**Done-when.**
1. ✓ The graph reads `mentionCoverage` and, with zero mention edges, says which case it is, with the next step: run the indexer (offered to controllers; "Continue the rebuild" for a stopped one that is not too old, never while one is running), or see the failure. The last failed build is named wherever it ran, at ingest or from the map, with when and its error in plain words. A continued rebuild reads with the same equipment dictionary as the presses before it; after a change, or past 24 h, the press reads every document and says why. This holds once `20261194` is pasted; until then the map says what I-14 shipped.

**Scope / residual.**
- The per-document rebuild (`POST /api/graph/mentions { documentId }`, no UI caller) is not recorded. The route is not this package's file → opened `IRLS-16` (DEC-31).
- No "Start over" control: a press continues a stopped rebuild whenever it may (same dictionary, under 24 h). Offering one beside "Continue" needs the route to accept a flag (`app/api/graph/mentions/route.ts`, not this package's file); noted for the integrator, not opened as a finding.
- Builds that ran before the paste are not recorded retroactively.
- A failure names the knowledge document by id on the row, never on the map, and a member's read cannot see the id (the column grant).
- "Never built" and "built, nothing named" still read alike after a build that succeeded. The notice is kept exactly as it was there (the regression rule).
- Two rebuilds pressed at once: each saves its whole place, and the last save wins. The map offers no button while the place says running (saved within 2 min), but the route itself does not refuse a concurrent press (a map read before the place was saved, one older than 2 min, or a direct call): that press continues the running one's place (same dictionary) or starts over — duplicate work, never a skipped document. The map's "running" reading uses the reader's clock against the server's save time, so a badly skewed clock can misread a running rebuild as cut off (or the reverse); the server's decision does not depend on it.
- On a database without `20261194`, each ingest-time build still makes one refused run-state round trip (now within the cap); a per-process "not installed" cache was not added.
- Noted for the owners, not this finding's:
  - `backfillOrgMentions` indexes each document without its mirror id (`document_id` NULL), where the ingest pass passes `source_document_id`. The graph still draws those rows through the mirror (`lib/orgGraph.ts` `mirrorOf`), but readers by `document_id` (`lib/mentions.ts` `mentionsForDocument`) miss them until the document is next indexed at ingest. Its `assetsTouched` is always 0. Both are unchanged here (the regression rule).
  - `lib/orgGraph.ts`'s `MentionCoverage` comment still says the indexer keeps no run state (I-15's file).
- The integrator adds at merge:
  - the `lib/schemaExpectations.ts` row `{ table: "mention_index_runs", migration: "20261194_intel_roundG_mention_run_state.sql" }`;
  - the `lib/exportTables.ts` `EXPORT_EXCLUDED_TABLES` entry (AO-P4's file). Proposed reason: "the mention index's run state (last build, last failure, a rebuild's place; 20261194) — operational, re-derived by the next build, names knowledge-document ids a restore re-keys; a restore starts with none".
  - Until those rows land, the two tripwires carry the table as awaiting its row at merge: `ROW_AT_MERGE` in `lib/__tests__/schemaExpectations.test.ts`, `DECISION_AT_MERGE` in `lib/__tests__/exportCoverage.test.ts`. Each fails once the real row exists, so the integrator removes the entry in the same commit that adds the row, and may delete the two (then empty) mechanisms.

---

<a id="irls-15"></a>

## IRLS-15 · Applied links are readable by every active member, evidence included, whatever documents they connect

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260806_intelligence_layer.sql:87-90` (`document_related_resources_read`), `lib/relatedResources.ts` (`listRelatedResources`, `listBacklinks`), `lib/linkProposerServer.ts` (auto-apply)
- **Opened 2026-09-30 (intelligence Round G, I-08 fix pass 4)** from the third review of `LNK-13`'s either-direction read (`DEC-31`): it is `LNK-4`'s exposure on the applied side, and a new policy on a table with live readers is its own change.

**Mechanism.** `document_related_resources_read` admits every active member of the org (`EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = … AND m.uid = auth.uid() AND m.status = 'active')`), with no condition on the documents a row connects. Since `LNK-3` auto-apply writes rows — through the plain index once `20261126` is applied and, *corrected in fix pass 5*, before that through the row-by-row fallback `lib/linkProposerServer.ts` ran on any batch failure, 42P10 included, so the leak began on deploy, not on `20261126` — so provable links — `origin = 'system'`, evidence such as "Off-page connector 44-098 continues onto 44-PID-013" — land in that member-readable table. `LNK-4` closed exactly this for `proposed_links` with a RESTRICTIVE endpoints-readable policy (`proposed_links_read_endpoints`); applied links never got one. Since fix pass 4 the app no longer fetches what an unreadable carrier's link says (`listRelatedResources` names its columns and reads an inbound row's label and evidence only for carriers the viewer's documents read returns), but a raw `select` returns every applied link of the org. Reproduced on a local PostgreSQL 16 with the live documents read path (`documents_org_access`, `documents_acl_select` / `node_visible`) and `20261126` applied: a member whose ACL denies a restricted sheet reads neither the sheet nor its proposal, yet `select * from document_related_resources` returns the sheet's applied link with its evidence.

**Done when.**

- [ ] A RESTRICTIVE SELECT policy on `document_related_resources` mirrors `proposed_links_read_endpoints`: at least the carrier document readable under the caller's `documents` RLS (`EXISTS (SELECT 1 FROM documents d WHERE d.id = document_related_resources.document_id)`). Whether the target must be readable too is decided in that migration — requiring it would also hide a link this document carries to a restricted document, which the Related panel lists today as "restricted document".
- [ ] The migration counts, before apply, the applied links whose carrier (and target) a non-controller member cannot read, and probes the policy after; the engine and the publish sweep (service role) are unaffected.
- [ ] A two-member run (as `LNK-4`'s) shows a denied member's raw select returns zero rows for the restricted sheet's links.


**Resolution (2026-09-30, intelligence Round G, I-08 fix pass 5).** Resolved in this package after the fourth review, which made it a blocker: `LNK-3` routes provable evidence into this table, so leaving the read open undid `LNK-4`. `20261126` (which already modifies `document_related_resources`) adds `document_related_resources_read_endpoints`, a RESTRICTIVE SELECT policy: `EXISTS (SELECT 1 FROM documents d WHERE d.id = document_related_resources.document_id) AND (document_related_resources.target_document_id IS NULL OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_related_resources.target_document_id))`. The subqueries run under the caller's own `documents` RLS (`documents_org_access` and the RESTRICTIVE `documents_acl_select` → `node_visible`), so a link is readable only by someone who can read its carrier and, for a document link, its target — `LNK-4`'s rule for proposals. RESTRICTIVE because `document_related_resources_write` is FOR ALL: its USING would otherwise grant SELECT on every row to the writer tier. The decision the finding left open is taken in the migration header: both endpoints, for every document link (not only `origin IN ('system', 'proposed')`). A person's pin to a document you cannot read says the relationship exists and, through its label, usually what the target is — the same fact `LNK-4` withholds for proposals — so it is no longer listed to a member who cannot read the target (before, the Related panel showed it as "restricted document"; on a database without this file it still does). URL links (no target) need only the carrier. The service role (the engine, the evidence audit, the publish sweep) is unaffected; a person's unpin of a link they cannot read matches nothing, which the checked write reports (`IRLS-10`). Before the file is applied the engine applies no provable link at all: `lib/linkProposerServer.ts` treats the batch's 42P10 (no plain index — the same transaction that builds it creates this policy) as "not applied yet" and queues the provable drafts for review with a note, instead of the row-by-row insert that wrote them into the member-readable table (`LNK-3`, corrected); the row-by-row fallback runs only for other batch failures, where the index and so the policy exist. `lib/relatedResources.ts` `listRelatedResources` documents the policy and, since fix pass 5, refuses to turn a failed documents read into an access verdict (it throws; `components/documents/RelatedPanel.tsx` renders "Related links could not be loaded — …" instead of an empty or "restricted" list).

**Pending migration:** `supabase/migrations/20261126_intel_roundG_link_conflict_targets.sql` (DEC-30: the pre-apply inventory gains `_intel_g26_links_before` — the links touching a document with restricted visibility (anything but normal / unset, `node_visible`'s open case), those of origin `system` / `proposed`, and those carried by an open document to a restricted one — aggregate counts only, captured before the transaction; who loses which link depends on each member's grants, so the count is of the links that can be hidden from someone; the probes check the RESTRICTIVE policy's deparsed text and that `document_related_resources_read` / `_write` are still there, not re-created).

Verified on a throwaway local PostgreSQL 16: stubs plus the live documents read path loaded verbatim (`my_org_ids` and `documents_org_access` from `schema.sql`, `acl_subject_in_bucket` from `20260708`, `node_visible` (6-arg) from `20261041`, `documents_acl_select` from `20261037`, `is_org_controller` from `20260814`, `caller_holds_any_role` from `20261045`; the owner cascade stubbed to false), then `20261015`, `20261016`, `20261125`, and `20261126` applied twice — 11/11 probes true both times; the inventory counted 2 links touching the restricted sheet, 1 of origin `system`, 1 pinned from the open sheet to it. A restricted sheet S allows member m and denies member d (a Manager, so also a writer); S carries the engine's `system` link to the open sheet T ("Off-page connector 44-098 continues onto 44-PID-013"), T carries a person's pin to S and a URL. Before `20261126`, d read 1 document yet 3 links, 2 touching S, and the evidence (the leak, reproduced). After it, d reads 1 document, 1 link (T's URL), 0 links touching S, 0 rows of the evidence, 0 proposals; d's delete of S's link affected 0 rows; m and the controller read all 3 links and the proposal; the service role read all 3 and upserted on the plain index; the controller unpinned and re-pinned T→S. The cluster was stopped and deleted. Not a CI test — CI has no database; the shape test pins the policy text the run exercised.

Tests: `lib/__tests__/linkProposalsRoundG.test.ts` ("fix pass 5 (IRLS-15): applied links are readable only with their carrier and (for a document link) their target …" — the policy text, inside the transaction, the write policies not re-created, the inventory and the probes; "fix pass 5 (IRLS-15): before 20261126 (42P10) nothing is applied …" — no applied link written, no row-by-row insert tried, the provable draft queued and said, a second run neither applies nor doubles it; "fix pass 5 (IRLS-15): the source applies nothing row by row on 42P10"; "fix pass 5: a documents read that fails is an error …").

**Done-when.**
1. ✓ A RESTRICTIVE SELECT policy on `document_related_resources` mirrors `proposed_links_read_endpoints`: the carrier readable under the caller's documents RLS, and — decided in the migration — the target too for every document link.
2. ✓ The migration counts, before apply, the links touching a restricted document (the ones a non-controller member can lose), and probes the policy after; the engine and the publish sweep (service role) are unaffected — and before it is applied the engine writes no applied link.
3. ✓ A two-member run (as `LNK-4`'s) shows a denied member's raw select returns zero rows for the restricted sheet's links (above).

**Scope / residual.** Provable drafts queued for review while `20261126` was not applied stay in the queue after it is (they are already pending, so the next run does not re-derive them); a reviewer approves each. `listBacklinks` (the older backlinks read) is narrowed by the same policy; its own code is unchanged.

**Integration correction (2026-10-01, at the I-08 merge).** An independent verification of fix pass 5 confirmed the endpoints read policy on PG16 (a member denied one endpoint reads none of that pair's links or evidence; members who can read both, controllers and the service role are unaffected; the app's add / unpin / approve writes still work). One overstatement is corrected here: queuing the provable drafts before 20261126 does not keep their evidence out of a member-readable table — `proposed_links` gains its own endpoint read policy in the same migration, so until 20261126 lands the queued evidence is as exposed as any other proposal; what the 42P10 branch guarantees is that nothing is APPLIED before then. Also at merge: the row-by-row fallback now runs only for a constraint failure (SQLSTATE class 23); any other batch failure (transport, PostgREST, permission) queues the whole batch and says so as an error (`lib/linkProposerServer.ts`; test "a batch failure that is not a constraint error … queues the batch" in `lib/__tests__/linkProposalsRoundG.test.ts`). The intake door now passes its service-role client to `runPostPublishSideEffects`, so the proposal sweep runs in-process there (`app/api/intake/upload/route.ts`; pinned in `lib/__tests__/intakeUploadRoute.test.ts`).

---

<a id="irls-16"></a>

## IRLS-16 · A per-document mention rebuild is not recorded in the mention index's run state

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** intelligence I-15 GRAPH SERVER ASSEMBLY (it edits the graph's routes; no package in the plan owned `app/api/graph/mentions/route.ts`) — by the integrator, 2026-10-13 (I-23 merge, DEC-31). Opened 2026-10-07 by intelligence Round G I-23.
- **Verification:** CONFIRMED
- **Locations:** `app/api/graph/mentions/route.ts` (the `body.documentId` branch), `lib/mentionRunState.ts`
- **Opened 2026-10-07 (intelligence Round G, I-23)** as the remainder of `IRLS-14` (`DEC-31`): the route is not this package's file.

**Mechanism.** Since I-23 the mention index records each build in `mention_index_runs` (`20261194`, `lib/mentionRunState.ts`). The ingest-time pass records with source `ingest`, and a rebuild from the map (`backfillOrgMentions`) with source `map`. `POST /api/graph/mentions { orgId, documentId }` re-indexes one knowledge document by calling `indexDocumentMentions` directly, so that build is not recorded:
- a failure is returned to its caller as a 500 but does not become the map's "last mention build that failed";
- a success does not clear that document's standing failure.

No page calls this branch today (the graph posts `{ orgId }` only), so nothing a person sees depends on it yet.

**Done when.**

- [ ] The `documentId` branch wraps its build like `rebuildDocumentMentions`: `startMentionRun(supabaseAdmin, orgId, "map", documentId)` before the build; after it, `clearStandingFailure` when the standing failure is this document's, then `finishMentionRun(…, { outcome: "succeeded" })`; on a throw, `finishMentionRun(…, { outcome: "failed", error })` before the route answers the error exactly as today.
- [ ] A route test: a failed per-document rebuild is recorded (source `map`, the document, plain words) and still answers the same 500; a success clears that document's standing failure; with `mention_index_runs` absent the route answers exactly as before.

---

## IRLS-17 · `supabase/schema.sql` cannot run on an empty database — the documented first step of a fresh install fails at line 328

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-27 FRESH-INSTALL REPLAY (to be added to the fleet plan by the integrator at the I-17 merge). `schema.sql` is the shared pre-migration baseline, last reshaped by document-control `PKG-14` / `HLD-12`. Opened 2026-10-14 by intelligence Round G I-17 (`IRLS-6`'s replay, DEC-31).
- **Verification:** CONFIRMED (reproduced on PostgreSQL 16.13 by the database harness, `npm run test:db`)
- **Independently verified:** — (`author`: opened 2026-10-14 by intelligence Round G I-17 on its PostgreSQL 16 replay; confirmed by the integrator by reading at the I-17 merge; not yet challenged by a second party).
- **Locations:** `supabase/schema.sql:319-331`, `:400`, `:501-502`, `:656-663`, `:933`, `:1392-1395`; `lib/__tests__/rls/replayKnownDefects.ts` (`BASELINE_KNOWN_ERRORS`)

**Mechanism.** The file's header says: "To set up a database: run this file FIRST, then EVERY file in supabase/migrations/ whose name starts with a date, in filename order." Sent as one script, the way the SQL editor sends a paste, it stops at `:328`: `project_documents` references `projects(id)`, but `projects` is created at `:933`. The whole paste then rolls back. Run statement by statement, 16 statements still fail:
- `:328-331`: `project_documents` and its three indexes (`projects` does not exist yet).
- `:400`: an index on `document_versions(org_id, archived_at)`, but `document_versions` has no `archived_at` column in this file.
- `:501-502`: the trigram index. Its `CREATE EXTENSION IF NOT EXISTS pg_trgm;` sits at the end of the comment line above it, so it never runs.
- `:656-663`: `milestones` and its six indexes (`projects` again).
- `:1392`, `:1393`, `:1395`: `ENABLE ROW LEVEL SECURITY` on `project_documents`, `document_assets` and `milestones`. The first and third were never made; `document_assets` lives only in a migration.

**Failure scenario.** A disaster-recovery or self-host install follows the header. The first paste fails with `relation "projects" does not exist`, and nothing is created. The operator has no documented way forward; the numbered migrations assume the baseline.

**Evidence.**

```
lib/__tests__/rls/freshReplay.test.ts — "supabase/schema.sql: the statements that fail on an empty database are exactly the recorded IRLS-17 set" (16 messages). psql -f supabase/schema.sql on an empty database: ERROR: relation "projects" does not exist (schema.sql:328).
```

**Done when.**

- [ ] `supabase/schema.sql` runs as ONE script on an empty Supabase project with zero errors (forward references reordered or moved to their migrations; the `pg_trgm` extension statement on its own line; the `archived_at` index removed or its column added). No live database is touched: the file is never re-run on one (DB-8).
- [ ] `BASELINE_KNOWN_ERRORS` in `lib/__tests__/rls/replayKnownDefects.ts` is empty, and `npm run test:db` passes.

---

## IRLS-18 · `20260630_perf_indexes.sql` indexes `team_members` before `20260707` creates it — the whole file rolls back on a fresh replay

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** intelligence I-27 FRESH-INSTALL REPLAY (to be added to the fleet plan by the integrator at the I-17 merge). Opened 2026-10-14 by intelligence Round G I-17 (`IRLS-6`'s replay, DEC-31).
- **Verification:** CONFIRMED (reproduced on PostgreSQL 16.13 by the database harness)
- **Independently verified:** — (`author`: opened 2026-10-14 by intelligence Round G I-17 on its PostgreSQL 16 replay; confirmed by the integrator by reading at the I-17 merge; not yet challenged by a second party).
- **Locations:** `supabase/migrations/20260630_perf_indexes.sql:24-25`, `supabase/migrations/20260707_teams.sql` (creates `team_members`)

**Mechanism.** `CREATE INDEX IF NOT EXISTS team_members_uid_idx ON team_members (uid);` at `:24`. The `IF NOT EXISTS` guards the index, not the table, so a missing relation raises `42P01`. As one paste the file rolls back entirely, so none of its indexes exist on a fresh install (`collections_org_library_idx`, `org_members_uid_org_active_idx` and the rest). This is the same class as `IRLS-6`. Existing deployments are not affected: they applied the file after `team_members` existed, or re-pasted it.

**Failure scenario.** A fresh install replays the sequence in filename order and gets the RLS hot-path indexes the file was written for (`node_visible()`'s per-row lookups) only if the operator notices the error and re-pastes the file later.

**Done when.**

- [ ] The `team_members` index is guarded with `to_regclass('public.team_members') IS NOT NULL` in `20260630`, or carried by a migration dated after `20260707`, without changing what a live database ends up with.
- [ ] The `20260630_perf_indexes.sql` entry leaves `OUT_OF_ORDER_FILES` in `lib/__tests__/rls/replayKnownDefects.ts`, and `npm run test:db` passes.

---

## IRLS-19 · `20261075`'s final SELECT names its `check` column bare — a syntax error, so the pasted file changes nothing and the checkout-episode seal never installs

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-27 FRESH-INSTALL REPLAY (to be added to the fleet plan by the integrator at the I-17 merge). The file is document-control's (`DCK-14`, P6). Opened 2026-10-14 by intelligence Round G I-17 (`IRLS-6`'s replay, DEC-31).
- **Verification:** CONFIRMED (reproduced on PostgreSQL 16.13 by the database harness; the paste protocol is the editor's single simple-query message)
- **Independently verified:** — (`author`: opened 2026-10-14 by intelligence Round G I-17 on its PostgreSQL 16 replay; confirmed by the integrator by reading at the I-17 merge; not yet challenged by a second party).
- **Locations:** `supabase/migrations/20261075_dc_roundF_checkout_episode_seal.sql:126` (`SELECT check, NULL::boolean, n FROM _dc_roundf_episode_seal_inventory;`), `:43` (the column is created as `AS check`); `audit-reports/MIGRATION-PASTE-ORDER.md` row 70 (PASTE)

**Mechanism.** `check` is a reserved word. `AS check` is legal as a column label, but a bare `check` in the select list is not: `ERROR: syntax error at or near "check"`. PostgreSQL parses the whole query string before running any of it, so a syntax error anywhere means none of the file runs. Its `BEGIN … COMMIT` never runs, so `enforce_checkout_episode_guard()` and `trg_checkout_episode_guard` are never installed. `lib/__tests__/dcRoundFCheckoutMigration.test.ts` checks the file's shape by text and does not parse it.

**Failure scenario.** The operator pastes row 70 and sees a syntax error. DCK-14's seal (closed episodes immutable to signed-in writers; no seal over an active session) is not installed. Re-pasting does not help. `DCK-14`'s done-when 1 cannot be met until the file is fixed.

**Evidence.**

```
lib/__tests__/rls/freshReplay.test.ts — "20261075 cannot be pasted as written: the editor parses the whole script first, so its final SELECT's syntax error leaves the guard uninstalled (IRLS-19)": pg_trigger has 0 rows named trg_checkout_episode_guard after the replay.
```

**What a paste does today** (measured 2026-10-14 at the I-17 integrator fix pass, PostgreSQL 16.13, on copies of the replay; `freshReplay.test.ts`, "IRLS-19: 20261075 sent as …"):
- **As one script**, which is how the Supabase SQL editor sends a paste: the file fails with `syntax error at or near "check"`, and **no statement applies**. PostgreSQL parses the whole message before it runs any statement, so not even the opening inventory TEMP TABLE is made. `enforce_checkout_episode_guard()` and `trg_checkout_episode_guard` are both absent afterwards.
- **Statement by statement** (`psql -f`, not the editor's way): every statement before the final SELECT applies, and only that verification SELECT fails, with the same error. The inventory is made, and the `BEGIN … COMMIT` installs the guard function (SECURITY DEFINER, `search_path` pinned) and its trigger.

**What this decides: an in-place correction, not a new numbered file.** A paste in the editor has never applied any of the file, on any database. A statement-by-statement run applied exactly the DDL a corrected file applies, and that DDL re-runs cleanly (`DROP TABLE IF EXISTS` before the TEMP TABLE, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`). So quoting the column in `20261075` itself leaves no database in a state a later file would have to repair, whichever way the file was run.

**Done when.**

- [ ] `20261075`'s final SELECT quotes the column (`SELECT "check", NULL::boolean, n …`), in place (above), and the file parses and applies as one paste.
- [ ] `20261075` leaves `OUT_OF_ORDER_FILES`, its definer trigger function `enforce_checkout_episode_guard()` joins the census (`TRIGGER_FUNCTIONS` in `lib/__tests__/rls/definerDecisions.ts`), and `npm run test:db` passes.

---
