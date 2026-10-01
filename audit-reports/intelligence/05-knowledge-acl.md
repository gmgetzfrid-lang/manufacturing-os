# 05 · The knowledge ACL boundary

**12 findings** — 2 CRITICAL · 4 HIGH · 4 MEDIUM · 2 LOW.

**Your leak question, half one.** When a controlled document is indexed, does its ACL still hold at query time?

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| lib/knowledgeAccess.ts is a genuine, single-source-of-truth ACL seam: it evaluates the real lib/acl engine over library → folder lineage → document, per request, and answers the owner's core question in the affirmative — retrieval re-checks the ACL at QUERY time, not at link time, so tightening a document's ACL takes effect on the very next question with no re-index. | `lib/knowledgeAccess.ts:190-217, called fresh on every ask at app/api/knowledge/ask/route.ts:174-182` | This is the correct architecture and must not be replaced by a cached or link-time model. Every finding above is a hole AROUND this function, not a flaw in the idea. |
| The 20260917 chunk lockdown: source-linked chunks are unreadable by the browser client, so the ask API really is the only door to mirrored content. | `supabase/migrations/20260917_knowledge_sources.sql:69-82` | Without this, every finding above would be moot — a member could just SELECT the chunks. It is the load-bearing wall; the document-row and history leaks are the windows left open beside it. |
| knowledge_page_entities is REVOKEd from anon and authenticated outright — the drawing/entity layer has no client door at all. | `supabase/migrations/20260921_drawing_entities.sql:37-38` | This is the strictest pattern in the codebase and the model the other knowledge tables should follow. |
| /api/knowledge/locate and /api/knowledge/drawing both fail CLOSED: a mirror whose controlled document the caller cannot read is never resolved, never suggested as 'it's on sheet X', and never contributes to the census or the CSV export. | `app/api/knowledge/locate/route.ts:69-77 and :143-149; app/api/knowledge/drawing/route.ts:72-83` | These are the correct implementations to copy into the orchestrator. locate.ts:74-76 (`catch { return bad("Not permitted", 403); }`) is the exact fail-closed shape the ask route's exclusion set is missing. |
| /api/knowledge/sources re-verifies every container against the CALLER server-side rather than trusting the picker. | `app/api/knowledge/sources/route.ts:198-201` | The comment 'the picker filter is convenience, THIS is law' is the right instinct and the right layering. |
| The AI carve-out PURGES on flip rather than waiting for a sync tick — the mirror, chunks, page entities and mentions all go immediately. | `app/api/knowledge/exclusion/route.ts:74-102` | Correct and load-bearing. It reports failure honestly (:87-93) instead of claiming success. Only the race against a concurrent sync, and the surviving knowledge_questions quotes, undermine it. |
| lib/aiBoundary.ts is a pure, tested, named-reason gate that every mirroring/picker door calls, so 'the AI can't see it' always has a reason a controller can act on. | `lib/aiBoundary.ts:52-74, tested in lib/__tests__/aiBoundary.test.ts` | The right abstraction, already built. Making the retrieval path call it too is a small change, not a new design. |
| lib/acl.ts's isActiveMember gate drops all ALLOW grants for a revoked member while preserving DENY rules, and loadPrincipal always passes isActiveMember: true only after confirming an active org_members row. | `lib/acl.ts:113-118; lib/knowledgeAccess.ts:31-46` | A stale rule naming a departed uid cannot grant knowledge access. This defence must survive any refactor of the principal loader. |


---


<a id="kacl-1"></a>

## KACL-1 · Ask history is org-member readable and replays verbatim quotes and document names from documents the reader cannot open

- **Severity:** CRITICAL
- **Status:** OPEN
- **Assigned:** intelligence I-03 THE ASK ROUTE — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260911_knowledge_ai.sql:146-150`, `lib/knowledge.ts:504-527`, `lib/knowledge.ts:529-546`, `app/(protected)/knowledge/[id]/page.tsx:1410-1415`, `app/(protected)/knowledge/[id]/page.tsx:1690-1720`, `app/api/knowledge/ask/route.ts:1632-1650`, `app/api/knowledge/ask/route.ts:1739-1744`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigating guard anywhere: the history row is readable by any active org member through the browser client under RLS, and it carries verbatim 1600-char quotes and document names from documents that member may be denied. The per-asker ACL filter (route.ts:157-187) runs only over live retrieval, never over replayed history.

**Mechanism.** The ask route stores each citation with the VERBATIM passage: `quote: truncateSafe(c.content, 1600)` plus `documentName`, `page`, `section` and `tags` (route.ts:1637-1648), and writes the whole array into knowledge_questions.citations along with the full answer text (route.ts:1739-1744). RLS on that table is membership-only and was never tightened — `CREATE POLICY knowledge_questions_select ON knowledge_questions FOR SELECT USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_questions.org_id AND uid = auth.uid() AND status = 'active'))` (20260911:147-150). Two searches (`rg -n "knowledge_questions" supabase/**` filtered for policy/rls/revoke/grant, and `rg -n "POLICY knowledge_questions" supabase/`) found no later policy. `lib/knowledge.ts` imports the BROWSER client (`import { supabase } from "@/lib/supabase";` at line 7), and both `searchAskHistory` (org-WIDE: `.eq("org_id", orgId)`, across every library, line 513) and `listKnowledgeQuestions` (`select("*")`, line 533) read it directly. Neither re-checks the reader against the source document's ACL. The knowledge page then renders `pa.answer` and `pa.citations` straight into the answer surface (page.tsx:1704-1712 → setAnswer(past)).

**Failure scenario.** An Admin asks "what is the design pressure on V-201?"; the answer cites the confidential vendor data sheet with a 1600-character verbatim quote. Tomorrow a Viewer who is denied read on that document types the same question. Before any AI call, `searchAskHistory(activeOrgId, q, 3)` fires (page.tsx:1411-1412), the memory card appears, they click "Show this answer — no AI call", and they get the Admin's answer complete with the quote, the document number, the section and the page. The whole per-asker ACL filter at route.ts:157-187 is bypassed because it never ran.

**Evidence.**

```
lib/knowledge.ts:510-516 — `const { data, error } = await supabase\n      .from("knowledge_questions")\n      .select("id, library_id, question, answer, user_name, created_at, citations")\n      .eq("org_id", orgId)\n      .textSearch("search_tsv", q, { type: "websearch", config: "english" })`. Compare route.ts:1643 — `quote: truncateSafe(c.content, 1600),`. Also note app/api/knowledge/exclusion/route.ts:74-102 purges knowledge_documents and entity_mentions when a doc is held back, but never touches knowledge_questions — so the quotes of a purged document remain readable forever.
```

**Chain reaction.** The same rows feed the ask route's PROVEN GROUND retrieval boost (route.ts:605-635) — which DOES filter excludedDocIds — and linkProposerServer.ts:334. Any fix must keep those working. Because citations carry documentId, the leak also hands the reader a working click target (see the byte-door finding).

> **Verifier correction.** Add one strengthening detail: the leak is worse than "search history" because the per-library History panel (listKnowledgeQuestions, page.tsx:1464) uses select("*") on the same membership-only table, so the citations array is exposed by two independent surfaces, not one. Also note the citations stored are precisely the passages the ORIGINAL asker's ACL allowed — so the higher-cleared a colleague, the richer the material any member can read back.

**Done when.**

- [ ] knowledge_questions is no longer directly readable by the browser client for rows whose citations reference source-linked documents; history is served by an API route that re-filters citations through readableControlledDocIds for the CURRENT reader
- [ ] searchAskHistory and listKnowledgeQuestions go through that route (or an RLS policy that joins knowledge_documents.source_document_id and evaluates the ACL)
- [ ] Excluding a document (POST /api/knowledge/exclusion) also strips its citations/quotes from stored knowledge_questions rows, or those rows are redacted at read time
- [ ] A test proves two members with different ACLs get different history for the same library


**Partial (2026-09-30, intelligence Round G).** Reproduced first (the 20260911 policy is membership-only; `lib/knowledge.ts` read the table with the browser client, `searchAskHistory` org-wide and `listKnowledgeQuestions` with `select("*")`). Worked with `ASK-1` (same code; the package decision `DEC-59` (1)): `20261120` narrows `knowledge_questions_select` to the asker and controllers, and `app/api/knowledge/history/route.ts` (new) serves the team's record — `list` (the Conversations list), `search` (ask memory, scoped to THIS library) and `thread` (reopen one conversation) — through `lib/knowledgeHistory.ts` (new): every row's citations are re-decided for the CURRENT reader through the R&P Round C1 seam (`loadPrincipal` + `readableControlledDocIds`, never a parallel evaluator; `readableKnowledgeDocIds` resolves each cited knowledge document — an upload of the reader's org is readable by design, a mirror is readable when its controlled document is, anything unresolvable (removed, held back from the AI, another org's, malformed) is not). A row citing anything unreadable is withheld whole, and so is every later turn of its conversation, because the ask sends earlier turns back as context (`planVisibleHistory`); the number withheld is returned and shown. Controllers skip the filter (DEC-43). A library answer that cites NO document — the model answered without an `[n]` marker, every marker was invented and stripped, or a "Nothing matches" row naming the asker's own indexing gaps — proves nothing about its sources, so it is shown to its asker only (and to controllers); an internet-mode answer is shown to all (review fix: `planVisibleHistory(rows, threadRows, readable, readerUid)`, `lib/__tests__/knowledgeMemoryAcl.test.ts` "a LIBRARY answer citing no document is its asker's alone" and "a library answer with no citations reaches no other member"). A failed read of the stored answers, of the cited knowledge documents or of the controlled documents answers 500 with no rows — never an unfiltered answer. One seam read does not fail closed by itself: `loadDcLandscape` (`lib/knowledgeAccess.ts`, not this package's file) ignores a failed `libraries` / `collections` read, so a document restricted ONLY by its library or folder ACL would be judged by its own ACL alone. Fix pass 2: `readableKnowledgeDocIds` makes those same two reads first (for a non-controller, whenever a mirror is cited) and throws when either fails, so the route answers 500 with no rows (`lib/__tests__/knowledgeMemoryAcl.test.ts` "reproduction: the seam judges a document restricted ONLY by its library's ACL as readable when the libraries read fails" and "…so the history route checks the libraries and folders reads first"). A read failing between that check and the seam's own is the window left — closed when the seam's owner makes `loadDcLandscape` throw (see the residual). `lib/knowledge.ts` `searchAskHistory(orgId, libraryId, …)`, `listKnowledgeQuestions(orgId, libraryId)` and the new `loadConversation` call the route; `lib/knowledge.ts` and the knowledge page no longer read `knowledge_questions` (the hub's recent-questions widget, `app/(protected)/intelligence/page.tsx`, I-05's file, still reads it in the browser; the narrowed policy now limits it to the reader's own rows, every row for a controller — corrected in fix pass 4, this sentence used to say the browser no longer reads the table at all). On the page, the memory card searches this library only; `openConversation` re-reads a threaded conversation through the route and keeps its thread only when every turn is the reader's own and none was withheld (a teammate's turns, or a thread holding a turn the reader can no longer see, seed a NEW conversation — so the next ask is never appended to someone else's, nor behind a withheld turn that would withhold it too); the Conversations list says how many answers it is not showing and shows a failed read as a failure. Fix pass 2 (review minor): that line, the reopen notices and the empty state said every withheld answer "cites documents you can't open" — untrue of a teammate's library answer that cites no document, which is withheld too; they now say what is true of every reason ("… they draw on documents you can't open (or that have since left this library), or they are teammates' answers that cite no document, which only whoever asked can see"), pinned in `knowledgeMemoryAcl.test.ts`. Verified on a scratch PostgreSQL 16 carrying the live policy and helper bodies (`node_visible` 20261041, `is_org_controller` 20260814, `acl_subject_in_bucket` 20260708, the 20260911 / 20260917 / 20260929 knowledge policies; the owner cascade stubbed to its document-owner arm), the whole paste applied as the user will paste it: BEFORE, a Viewer read every stored answer, every mirror row (a private document's and a dangling one included) and every mention sentence; AFTER, a Viewer reads their own answer, the upload and open-document mirrors and those documents' sentences; a Manager (who holds the FOR ALL `entity_mentions_write`) reads exactly the Viewer's sentences; an Engineer granted read on the private document reads their own answer, that mirror and its sentence; an Admin and a Viewer holding DocCtrl additively read everything (DEC-43); a non-member reads nothing and the hub count answers 0. All seven probes were true on the first apply and again on a second (idempotent). That run did not read `knowledge_chunks`, and the review found the gap it left: 20260917's `knowledge_chunks_select` hides a mirror's chunks with `NOT EXISTS` over `knowledge_documents`, which runs under the caller's RLS, so once `knowledge_documents_select` hides a mirror row the `NOT EXISTS` passes and the chunks OPEN. Fix pass 2: `20261120` re-creates `knowledge_chunks_select` in the same transaction with the same rule written positively (`EXISTS … AND d.source_document_id IS NULL` — an upload row the caller can see; lineDiff-pinned against 20260917), counts the chunks of private / hidden documents' mirrors before apply, probes the positive form, and probes that no policy in the database tests `NOT EXISTS` over `knowledge_documents`, `knowledge_questions` or `entity_mentions`; `lib/__tests__/knowledgeMemoryAcl.test.ts` replays schema.sql and every migration's policies to the same end. Re-run on a second scratch PostgreSQL 16 (the verbatim 20260911 / 20260917 / 20260929 policies and 20261012's `knowledge_search_document`): before the paste a Viewer read only the upload passage; with the paste minus the chunk section a Viewer read the private and the hidden mirror's passages, directly and through `knowledge_search_document`, and the two new probes were false (the reproduction); with the full paste a Viewer, an Engineer granted the private document and a Manager read only the upload passage and nothing through `knowledge_search_document`, an Admin read every passage (`knowledge_chunks_write`), and all eight probes were true on the first apply and on a second.

**Pending migration:** `supabase/migrations/20261120_intel_roundG_knowledge_memory_acl.sql` (inventory before apply: stored answers; answers citing a mirror of a private / hidden / private-draft document; answers citing a knowledge document that no longer exists; non-controller members; mirror rows, those of private / hidden documents and dangling ones; the chunks of private / hidden documents' mirrors (fix pass 2); mention rows and those on private / hidden documents).

**Fix pass 3 (2026-09-30, review) — why this is OPEN again.** Same code and same review as `ASK-1` (full detail there). (1) *Fixed:* a conversation started from someone else's record — reopening a teammate's thread, or one holding a withheld turn, and the memory card — got a new thread id, but the page still sent the seeded turns to the model as history. A follow-up that restated them was stored with only its own citations, so the thread rule could not withhold it from readers denied the seeded turn's source. Seeded turns are now shown, never sent: `seededTurns` on the page and `askContextHistory(thread, seededTurns)` (`lib/knowledge.ts`), persisted across a reload; test "a conversation seeded from the saved record is SHOWN, never sent back to the model". (2) *Fixed:* `search` no longer returns how many matches it withheld — that count, picked by the reader's own query over text they may not see, was an oracle ("a search never says how many MATCHES it withheld"). (3) *Not fixed — the reason this is OPEN:* a row records only what its answer CITES, so an answer citing SOME readable documents is shown to other members even when its text drew on uncited restricted passages or drawing facts. The rule as landed is "as restricted as its most restricted CITED source". BLOCKING handoff to I-03: the ask route records every knowledge document whose passages or facts reached the model, and `planVisibleHistory` withholds a teammate's row unless all of them are readable.

**Fix pass 4 (2026-09-30, review).** Same code and same review as `ASK-1`; full detail there. (1) *Fixed:* `search` no longer reads a candidate window sized by the caller's `limit` and trims it after filtering. That window answered differently for `limit: 1` and `limit: 25` whenever restricted matches filled the small one, which is a count of them in coarser form. It now pages through the matches newest first until it holds `limit` visible rows, the matches run out, or 500 have been looked at, and a `limit` below the default is ignored. (2) *Fixed:* `loadPrincipal` drops a failed `team_members` read, and a team DENY then never matches. `readableKnowledgeDocIds` reads the reader's teams again, fails closed when that read fails, and judges with the teams it read. (3) *Records:* "the browser no longer reads `knowledge_questions` at all" is corrected in place; the hub widget still reads it, under the narrowed policy.

**Done-when.**
1. ✓ The table is no longer readable by the browser client for anyone else's rows; history is served by `/api/knowledge/history`, which re-filters every row's citations through `readableControlledDocIds` for the current reader (the asker keeps their own rows and controllers all rows, by `DEC-59` / `DEC-43`).
2. ✓ `searchAskHistory` and `listKnowledgeQuestions` go through that route (and the new `loadConversation`); a test pins that no browser module reads `knowledge_questions`.
3. ✓ Redacted at read time: excluding a document purges its mirror (`/api/knowledge/exclusion`), so every stored row citing it no longer resolves and is withheld from every non-controller — and every later turn of its conversation. Rows are not rewritten.
4. ✓ `lib/__tests__/knowledgeMemoryAcl.test.ts` "two members with different ACLs get different history for the same library (KACL-1 done-when 4)", driven over the real `lib/knowledgeAccess`.

The four items are met for what a row records, its citations. It stays OPEN on what a row does not record (fix pass 3, item 3).

**Scope / residual.** The PROVEN GROUND boost (`ask/route.ts`) and `linkProposerServer.ts` read the table on the service role and are unaffected (the ask route already filters with `excludedDocIds`). A stored row records the documents it CITED; passages retrieved but not cited, and drawing facts, are not recorded. Until the ask route records them (I-03, BLOCKING for this finding), a library answer citing no document is shown to its asker alone, and one citing some is judged by those alone. `loadDcLandscape` should still throw on a failed read (handed to the seam's owner): the history route now checks the same two reads first and answers 500 when either fails, which leaves only a failure between that check and the seam's own read. `loadPrincipal` should throw on a failed `team_members` read too (handed to the seam's owner): it drops the error and returns no teams, so a team DENY never matches; until it throws, `readableKnowledgeDocIds` reads the reader's teams again, fails closed when that read fails, and judges the mirrors with the teams it read (fix pass 4).

---

<a id="kacl-2"></a>

## KACL-2 · The orchestrator reads every indexed document in the org with no ACL check at all — its own file header says this is a data leak

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/orchestrator/route.ts:40-66`, `lib/orchestrator/tools.ts:1-19`, `lib/orchestrator/tools.ts:85-116`, `lib/orchestrator/tools.ts:119-168`, `supabase/migrations/20260929_mention_engine.sql:99-131`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. app/api/orchestrator/route.ts:61-66 checks active membership and reads `role` only; the read tools never consult role, visibility, is_private or any ACL, so a Viewer denied read on a folder gets its passages back verbatim. Only ai_excluded is honored.

**Mechanism.** /api/orchestrator authorizes with active org membership and a personal AI key ONLY — `const { data: member } = await supabaseAdmin.from("org_members").select("uid, role")…; if (!member) return bad("Not a member of this workspace", 403);` (route.ts:62-67). It never calls loadPrincipal or readableControlledDocIds. Two differently-shaped greps over lib/orchestrator/ and app/api/orchestrator/ for `knowledgeAccess|readableControlled|loadPrincipal|acl` and case-insensitively for `acl|permission|visibility` returned only the words "permission(s)" in comments and a check_permissions tool name — zero ACL evaluation. The `search_documents` tool then runs `supabaseAdmin.rpc("graph_ask", …)` (tools.ts:133-136). graph_ask is `SECURITY INVOKER` over knowledge_chunks — safe when a user calls it, because RLS blocks source-linked chunks — but here it is called on the SERVICE ROLE, so RLS is bypassed and it returns `ts_headline(...)` snippets from EVERY chunk in the org (migration 20260929:117-130). The only filter applied afterwards is `documents.ai_excluded` (tools.ts:137-152). `find_document` (tools.ts:92-104) is the same: `.eq("org_id", ctx.orgId).eq("ai_excluded", false)` and nothing else, returning document_number, title, rev, status and an `open_url`. The file's own contract at tools.ts:9-13 reads: "1. NOTHING WIDENS ACCESS. Every handler is org-scoped and re-checks the caller. An orchestrator that can read more than the person driving it is a data leak with a friendly interface." The route header at route.ts:6-8 claims "Everything the knowledge ask route enforces, this enforces too." Both statements are false for the ACL.

**Failure scenario.** A Viewer is denied read on the "Legal Hold / Incident" folder by an ACL rule. They open the Intelligence assistant and ask "what does the incident report say about the flare knockout drum?". search_documents runs graph_ask on the service role, matches chunks belonging to the mirrored incident report, and hands the model 42-word ts_headline fragments of its text. The model writes them into the answer. find_document additionally returns the document number, title, rev and a working `/documents/{libraryId}?doc={id}` link. The exact same question asked through /api/knowledge/ask would have returned nothing, because that route computes excludedDocIds per asker.

**Evidence.**

```
tools.ts:97-101 — `.eq("org_id", ctx.orgId)\n      // PILLAR A. `ai_excluded` is the per-document carve-out a controller sets\n      // when a document must stay invisible to anything automated. It is\n      // honoured here explicitly because this code runs on the service-role\n      // key, where RLS would not stop us.\n      .eq("ai_excluded", false)` — the comment shows the author knew RLS was bypassed and patched exactly one of the two boundaries. tools.ts:137-139 repeats it for graph_ask: "graph_ask runs on the service role here, so the ai_excluded boundary … must be applied at this layer". No equivalent line exists for the document ACL.
```

**Chain reaction.** Fixing this means threading loadPrincipal + readableControlledDocIds through ToolContext, which also affects tracePidLines, checkAuditHistory and query_equipment_by_unit. graph_ask returns knowledge_document_id, so the mirror→source_document_id join the ai_excluded filter already builds (tools.ts:143-151) is the same join the ACL filter needs — build it once and reuse.

> **Verifier correction.** Two cosmetic corrections. (1) The tool is named `find_documents` and lives at lib/orchestrator/tools.ts:83-119 (const findDocuments), not `find_document` at :92-104; search_documents is :121-168, not :119-168; the route's membership check is route.ts:61-65, not :62-67. The quoted code is verbatim correct at all three sites. (2) The route header at route.ts:6-10 is weaker than the finding implies — its sentence is scoped by its own colon clause ("…because it spends the same money on the same key: per-user BYO key, the acceptable-use agreement, the monthly cap…, and one metering row"), i.e. it is claiming parity on GOVERNANCE, not on ACL. The accurate indictment is tools.ts:10-12 ("NOTHING WIDENS ACCESS. Every handler is org-scoped and re-checks the caller."), which is unambiguously false. Lead with that quote, not the route header.

**Done when.**

- [ ] ToolContext carries a KnowledgePrincipal loaded via lib/knowledgeAccess.loadPrincipal, and the route 403s when it is null
- [ ] find_document and search_documents resolve every candidate document id through readableControlledDocIds and drop non-readable rows before returning, failing closed on error
- [ ] A test proves a non-controller with an ACL deny on a folder gets zero passages and zero matches from both tools for a document inside it
- [ ] The claims in app/api/orchestrator/route.ts:6-8 and lib/orchestrator/tools.ts:9-13 are true, or the comments are corrected

**Partial (2026-09-30, intelligence Round G).** Planned as a record-only close on roles-and-permissions [`EGRESS-3`](../roles-and-permissions/10-content-egress.md) (Round C1, `20261048` live) — the same code [`IEDGE-2`](./21-edges-and-invariants.md) and [`ORCH-3`](./15-orchestrator.md) were closed on. Re-verified against HEAD `1b71ca1`: criteria 1 and 3 hold; criteria 2 and 4 hold at the tool layer but not inside the seam (`KACL-12`), so this stays OPEN. New test `lib/__tests__/intelRoundGRecords.test.ts` drives both tools through the REAL seam (`loadPrincipal`, `loadDcLandscape`, the library → folder → document chain, `lib/acl`) over an in-memory, filter-aware PostgREST stand-in — `sweepRoundC.test.ts` mocks `readableControlledDocIds`, so it could not show a FOLDER deny; this one does. Mutation checks (re-run on the fix pass): with the two filters taken out of `lib/orchestrator/tools.ts` (the pre-EGRESS-3 shape) 4 of its 10 KACL-2 cases fail, and with the `!principal ||` limb taken out of `app/api/orchestrator/route.ts:70` the principal-null case fails; restored, all pass. (The file's four `KACL-12` cases are `it.fails` reproductions of the seam limb this finding stays OPEN on — added on the package's fix pass 3; its two ILIFE-6 cases exercise `lib/storageOrphans.ts`, not this finding.)

**Done-when.**
1. ✓ `ToolContext.principal: KnowledgePrincipal` (`lib/orchestrator/tools.ts:27-38`), loaded by `loadPrincipal` in both routes (`app/api/orchestrator/route.ts:62-70`, `app/api/orchestrator/execute/route.ts:42-50`); the route answers 403 "Not a member of this workspace" when it is null (`route.ts:70`). Tests: "/api/orchestrator answers 403 for a suspended member and for a stranger, before any provider call", and "… for an ACTIVE member whose principal cannot be loaded, though its own member read finds them" — `loadPrincipal`'s `role, roles` read fails while the route's own `org_members` read succeeds, so only the `!principal` limb can refuse (the first test alone could not catch that limb's removal: the route's second read carries the same predicates).
2. ◐ `find_documents` drops every candidate the caller cannot read (`tools.ts:151-155`, through `readableIds` → `readableControlledDocIds`, `:84-90`) and `search_documents` drops every passage from a mirror of an unreadable document (`:204-213`, through `unreadableMirrors`, `:92-113`). Fail-closed holds when the seam THROWS (`:89`), when the mirror hop errors (`:112`) and when the seam's own `documents` row read errors (no rows → nothing readable) — tests "fails CLOSED …". It does **not** hold when a read inside the seam errors: `loadDcLandscape` (`lib/knowledgeAccess.ts:105-133`) coalesces a failed `libraries` or `collections` read to an empty map, so the chain is evaluated without the missing container ACL; and `loadPrincipal` (`:36-50`) coalesces a failed `team_members` read to no teams, so a TEAM deny stops applying. Reproduced against the same stand-in, and committed as the `KACL-12` block's `it.fails` cases in `intelRoundGRecords.test.ts` (each fails at HEAD on the leak): with `collections` erroring, the denied Viewer's `find_documents` returns the folder-denied document and `search_documents` its passage; with a folder ACL of [allow role Viewer read, deny team T-contract read] and the Viewer in T-contract, `find_documents` returns [STD-0007] while `team_members` reads and [INC-0042, STD-0007] (and the INC-0042 passage) when it errors. Opened as [`KACL-12`](#kacl-12).
3. ✓ A Viewer denied read on a FOLDER — by a deny rule naming their role, and by a folder restricted to a team they are not in — gets zero matches and zero passages from both tools for the document inside it, while a controller by the role collection (Requester + DocCtrl) sees both and an ACL-free fixture gives the Viewer both. Test: `intelRoundGRecords.test.ts` "KACL-2 … Done-when 2 and 3".
4. ◐ Both claims are true for what the tools read OUTSIDE the KACL-12 window, and `tools.ts:9-12` is false inside it — a failed `libraries` / `collections` / `team_members` read inside the seam widens what the tools return (criterion 2), so "NOTHING WIDENS ACCESS" does not hold then; the open part is that window. Outside it: `tools.ts:9-12` ("NOTHING WIDENS ACCESS … re-checks the caller") — every document-touching tool filters through the principal (pinned by `sweepRoundC.test.ts` "every document-touching tool asks readableIds"); `check_audit_history` and `query_equipment_by_unit` read registries every member may read at the database (`drawing_audit_logs_read`, `20260929_mention_engine.sql:156-157`; `assets_member_all`, `20260605_rls_policies_new_tables.sql:26-27`). `route.ts:6-10` claims governance parity (key, agreement, cap, meter — the verifier's reading), and the ACL now rides the same `readableControlledDocIds` seam the ask route uses; `check_permissions` says "RLS is NOT the gate" (`:299`).

**Remaining / owner.** Criterion 2's fail-closed limb, and with it criterion 4's open part (the tools' comment is true once the seam fails closed), which is [`KACL-12`](#kacl-12)'s fix in `lib/knowledgeAccess.ts` — owner I-12 (DOCUMENT ACL BOUNDARY; its files include the seam's read predicate; KACL-12 is not yet in I-12's plan — the integrator adds it). This closes by pointer only when KACL-12 is RESOLVED with **every** one of its Done-when holding — the container limb (`libraries` / `collections`, documents AND containers) AND the `team_members` limb (a team deny is never dropped) — and the four KACL-12 `it.fails` cases in `intelRoundGRecords.test.ts` have been flipped to `it` and pass. No plan package carries this pointer close yet: the integrator assigns it (with `IEDGE-2`'s) to I-12 beside KACL-12, or to I-01 phase B. The same treatment is applied to every record whose Done-when names this fail-closed limb: [`IEDGE-2`](./21-edges-and-invariants.md#iedge-2) (its criterion 2) is re-opened with a Partial; [`ORCH-3`](./15-orchestrator.md#orch-3), whose criteria ask for the filter but not its failure mode, stays RESOLVED with a note.

---

<a id="kacl-3"></a>

## KACL-3 · A HIDDEN document is treated MORE permissively than a normal one: 'discover' alone makes its full text AI-readable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeAccess.ts:54-78`, `lib/acl.ts:139-154`, `lib/acl.ts:207-214`, `lib/permissions.ts:108-132`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the inversion is actually wider than claimed: the `visibility` argument is the document's own column while `decision.visibility` comes from the merged chain, so a doc with visibility='hidden' but a chain whose acl.visibility is 'normal' hits lib/acl.ts:142-153, where `upload`, `editMetadata` or `publish` alone also satisfy isDiscoverable() and unlock full text.

**Mechanism.** chainReadable's hidden branch is an OR where every other branch is an AND: `if (decision) { if (visibility === "hidden") return decision.can("read") || decision.isDiscoverable(); return decision.can("read"); }` (knowledgeAccess.ts:72-76). `isDiscoverable()` for a hidden/private merged ACL returns `can("discover")` (acl.ts:140). So a subject granted discover-only on a hidden document — the exact grant that exists to allow blind drilling WITHOUT opening the file — passes chainReadable, and every chunk of that document becomes retrievable, quotable verbatim in an answer, and renderable as a page IMAGE by the deep-read path (ask route.ts:1267-1324). The intended semantic is spelled out three files away: `canBlindDrill(decision, required = ["discover", "read"])` requires BOTH (acl.ts:207-214). Worse case: if any ancestor in the chain resets visibility to normal (`if (nodeVisibility === "normal") visibility = "normal";`, acl.ts:190; and the inherit-break reset at acl.ts:181-184) while the document's own `visibility` COLUMN still reads "hidden", isDiscoverable() falls to the wide OR at acl.ts:142-153 — then a mere `upload`, `editMetadata` or `createFolder` grant makes the hidden document's text AI-readable.

**Failure scenario.** A hidden folder of HR/incident PDFs is filed under a library that a knowledge source watches. Contractors hold `discover` on it so they can see that a record exists when drilling. A contractor asks the library "summarise the 2026 flare incident". readableControlledDocIds → chainReadable → hidden branch → isDiscoverable() → can("discover") = true → the document is NOT in excludedDocIds → its chunks rank, are quoted verbatim in the answer, and up to MAX_DEEP_READ_PAGES of its page images are rendered and sent to the model, then cited back with documentName + page.

**Evidence.**

```
lib/knowledgeAccess.ts:54-57 — the doc comment states the opposite of the code: "Default-allow (matching the app's screens) EXCEPT hidden nodes, which need an explicit grant to surface." lib/acl.ts:139-141 — `const isDiscoverable = () => { if (visibility === "hidden" || visibility === "private") return can("discover");`
```

> **Verifier correction.** Split the verification. The primary claim (discover-only on a hidden node ⇒ full text + page images) is CONFIRMED. The "worse case" second half — an ancestor resetting merged visibility to normal (acl.ts:190) while the document's own visibility COLUMN still reads 'hidden', dropping isDiscoverable() into the wide OR at acl.ts:142-153 so a bare `upload`/`editMetadata`/`createFolder` grant suffices — is SUSPECTED, not confirmed: it requires documents.visibility='hidden' while documents.acl.visibility is normal/absent, and the only writer I found (PermissionDrawer.tsx:264-283) writes `acl: nextAcl` and `payload.visibility = visibility` in the same update, keeping them in sync. Present that half as a latent divergence, not as an exploitable path.

**Done when.**

- [ ] chainReadable's hidden branch requires read: `if (visibility === "hidden") return decision.can("read");` — or reuses canBlindDrill's both-of semantics
- [ ] A unit test in lib/__tests__ covers: hidden doc + discover-only grant ⇒ NOT in readableControlledDocIds; hidden doc + discover+read ⇒ in it
- [ ] The same hidden-branch logic is checked in every caller of chainReadable (containerReadable at knowledgeAccess.ts:138-152 has the identical construct)

---

<a id="kacl-4"></a>

## KACL-4 · The ask route's per-asker ACL exclusion set fails OPEN on any query error and is silently truncated by the PostgREST row cap

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:157-187`, `lib/storageOrphans.ts:90-99`, `lib/orgGraph.ts:74-92`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. The fail-open half is unconditional and needs no configuration to bite. The truncation half depends on the deployment's PostgREST max-rows setting, but the repo treats that cap as real everywhere else it reads a large table, and this security-critical query is the one place that neither pages nor reports truncation.

**Mechanism.** Two defects in the same 25 lines. (1) Fail-open on error: the guard is `if (!linkErr && linkedDocs && linkedDocs.length > 0) { … }` (route.ts:172). Any error at all — a transient PostgREST failure, a statement timeout on a large library, a schema-cache miss — leaves `excludedDocIds` as the empty Set initialised at line 163, and the entire ask then runs with NO ACL filtering: every `.filter((c) => !excludedDocIds.has(c.document_id))` (line 431), every `if (excludedDocIds.has(row.document_id)) continue;` (line 496) and every other exclusion check becomes a no-op. The header comment at lines 161-162 claims the opposite: "Fails CLOSED: if the readable set can't be computed, linked docs are excluded." Only the inner try/catch around loadPrincipal (lines 183-185) fails closed; the outer query error does not. (2) No pagination: the query has no `.limit()` and no `.range()`, so it is capped by the PostgREST default max-rows. This codebase demonstrably knows about that cap — lib/storageOrphans.ts:91 reads "Page through — .range in 1000-row windows so big tables don't truncate" and lib/orgGraph.ts:74-92 pages the same way. A knowledge library mirroring more than the cap silently drops the overflow mirrors from the exclusion set.

**Failure scenario.** A plant links its whole drawings library — 3,000 controlled PDFs — as a knowledge source. The `linkedDocs` query returns only the first N rows (default cap). Every mirror past that cut is absent from excludedDocIds, so restricted drawings beyond the cut are retrieved, quoted and cited for any asker. Separately: during a brief database hiccup the query errors, and for the duration every ask in the workspace runs with the ACL filter completely disabled — with no log line and no visible difference in the answer.

**Evidence.**

```
route.ts:163-187 — `let excludedDocIds = new Set<string>();\n  {\n    const allLibIds = [libraryId, ...linkedLibraries.map((l) => l.id)];\n    const { data: linkedDocs, error: linkErr } = await supabaseAdmin\n      .from("knowledge_documents")\n      .select("id, source_document_id")\n      .in("library_id", allLibIds)\n      .not("source_document_id", "is", null);\n    // linkErr (42703 on a pre-20260917 DB) = no source columns = no mirrors.\n    if (!linkErr && linkedDocs && linkedDocs.length > 0) {` — no limit, no range, and the error branch does nothing.
```

**Chain reaction.** `reachableDocs` (route.ts:591-599) is built from the same unpaginated pattern and feeds pull-by-name, whole-document mode, the graph hop and mentionedDocs — it derives its safety entirely from excludedDocIds, so both defects propagate into every one of those paths.

> **Verifier correction.** Split the verification. Sub-claim (1), the fail-open, is CONFIRMED and is the serious half — it converts every ACL check in a 1700-line route into a no-op on one transient error. Sub-claim (2), silent truncation by the PostgREST cap, is SUSPECTED: the cap is a deployment setting (db max-rows) that cannot be observed from this repository, and no supabase config file in the tree pins it. State it as "unbounded query, no pagination, relies on an unpinned server-side row cap" rather than as an established truncation.

**Done when.**

- [ ] A query error on the exclusion set aborts the ask (or excludes ALL source-linked mirrors), matching the comment at lines 161-162; only a genuine 42703 pre-migration code degrades to 'no mirrors'
- [ ] The linkedDocs and reachableDocs queries page with .range() until exhausted, the way lib/storageOrphans.ts:90-99 does
- [ ] A test with a library of more mirrors than the row cap proves a restricted mirror at the tail is still excluded

---

<a id="kacl-5"></a>

## KACL-5 · The byte door checks 'discover', not 'read'/'download', evaluates only the document's own ACL (no folder or library chain), and only for private/hidden documents — so an allow-list ACL never blocks a download

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/download-url/route.ts:55-115`, `app/api/storage/download-url/route.ts:76-89`, `app/api/storage/download-url/route.ts:95-111`, `supabase/migrations/20260911_knowledge_ai.sql:124-128`, `lib/knowledge.ts:341-347`, `app/(protected)/knowledge/[id]/page.tsx:1232-1261`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, with one nuance the finding omits: :91-111 does enforce explicit DOWNLOAD DENY entries through the chain-resolved acl_index. That closes deny-list ACLs only — an allow-list ACL produces no deny entries, so the claim's central scenario stands untouched, as does the fail-open `catch { }` at :113-115.

**Mechanism.** Three independent gaps in one function. (a) The guard only runs at all when `visibility === "private" || visibility === "hidden"` (line 71) — a normal-visibility document whose ACL grants read to one team and nobody else is never evaluated. (b) When it does run it calls `canDiscover(...)`, not a read/download check — and canDiscover for a hidden node returns `decision.can("discover")` (permissions.ts:127-129), so discover-only yields a presigned URL to the entire PDF. (c) The chain passed is one element: `aclChain: [doc.acl as AccessControl | undefined]` (line 84) — folder and library ACLs are simply absent, so an inherited deny is invisible. The only other filter is `acl_index.deny.*.download` (lines 95-111), which is a DENY-list read: an allow-list ACL (grant read to Team A, no explicit denies) produces no deny entries and the check passes for everyone. And the whole block is wrapped in `catch { /* fail open to the membership check above */ }` (line 113-115). Reachability: knowledge mirrors store the controlled file directly — `file_key: version.file_url` (knowledgeSourceSync.ts:231, 250) — and knowledge_documents SELECT is membership-only RLS (20260911:125-128), so `listKnowledgeDocuments` (`select("*")`, lib/knowledge.ts:342-344) hands the browser every mirror's fileKey. openCitation then resolves it (`fileKey: d.fileKey`, page.tsx:1251) and CitedPageViewer calls `getSignedUrlForPath(view.fileKey)` (CitedPageViewer.tsx:122) → /api/storage/download-url.

**Failure scenario.** A document is restricted by an allow-list rule on its folder (read granted to team "Process Engineering", visibility left normal). A Viewer opens the knowledge library, gets the file_key from the org-member-readable knowledge_documents row (or from a leaked history citation's documentId), and requests /api/storage/download-url?path=<file_key>. The document is normal-visibility so the private/hidden branch is skipped; acl_index carries no download DENY entries because the restriction was expressed as an allow-list; a presigned URL for the full controlled PDF is returned.

**Evidence.**

```
download-url/route.ts:76-88 — `const allowed = canDiscover({ principal: {…}, aclChain: [doc.acl as AccessControl | undefined], visibility });\n          if (!allowed) { return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 }); }` — one-element chain, and the action asked for is discover. The comment at line 91-94 claims "acl_index is chain-resolved, so inherited denies are covered" — true for acl_index (PermissionDrawer.tsx:274-275 `buildAclIndexFromChain(chain)`), but acl_index is consulted ONLY for the download action deny, never for read.
```

**Chain reaction.** This is the terminal door for every citation click, the knowledge viewer, thumbnails and the doc-control viewers, so tightening it will surface any place that today relies on the loose behaviour. Because it is the SAME key for the controlled document and its knowledge mirror, fixing it once closes the knowledge path too.

> **Verifier correction.** One clarification worth carrying: because the version lookup is `document_versions.file_url = path` (:57-62), the guard DOES fire for knowledge mirrors (their file_key IS the controlled version's file_url) — the finding is not that the guard is bypassed but that it asks the wrong three questions. Also note gap (a) is the widest of the three: it needs no hidden/private flag at all, only a document whose protection is expressed as an allow-list ACL under normal visibility, which is the ordinary case the PermissionDrawer produces.

**Done when.**

- [ ] The guard runs for EVERY org-prefixed key that resolves to a document, not only private/hidden ones
- [ ] It evaluates the full library → folder lineage → document chain (reuse lib/knowledgeAccess.folderChain / readableControlledDocIds rather than a second implementation) and requires read (and download where the action implies bytes), not discover
- [ ] The catch block fails CLOSED for documents that resolve to a record, and only fails open for keys with no document behind them
- [ ] knowledge_documents.file_key is no longer exposed to the browser for source-linked mirrors (either column-level RLS or the ask/locate routes become the only source of fileKey)

---

<a id="kacl-6"></a>

## KACL-6 · Any active org member can ask any knowledge library and any of its linked libraries — knowledge_libraries carries no ACL of its own

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:103-137`, `supabase/migrations/20260911_knowledge_ai.sql:47-56`, `supabase/migrations/20260911_knowledge_ai.sql:114-118`, `supabase/migrations/20260915_knowledge_links.sql:22-42`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. Upload-origin documents have source_document_id NULL, so they never enter the linkedDocs set at :166-170 and no exclusion can apply to them — a private data-room library really is fully answerable by any active member.

**Mechanism.** The ask route's only authorisation is active org membership (`if (!member) return bad("Not a member of this workspace", 403);`, route.ts:107) followed by loading the library by id + org (:110-112). knowledge_libraries has no acl/visibility columns (20260911:47-56) and its SELECT policy is membership-only (:115-118). libraryId comes from the request body and is never checked against anything the caller can see. Linked libraries are then pulled in wholesale (:123-132) and searched as REFERENCE tier. The mirrors inside are ACL-filtered per asker, and 20260917 keeps upload-origin chunks deliberately member-readable, so the exposure is scoped to upload-origin knowledge documents — but those are exactly the files a controller uploads directly to a knowledge library (code books, vendor manuals, legend sheets) with no doc-control ACL to inherit.

**Failure scenario.** A controller creates a private knowledge library for an M&A due-diligence data room and uploads PDFs to it directly (upload-origin, source_document_id NULL, so nothing excludes them). Any org member who can guess or enumerate the library id — knowledge_libraries SELECT is membership-only, so they can simply list them — POSTs to /api/knowledge/ask with that libraryId and gets fully cited, verbatim-quoted answers from the data room.

**Evidence.**

```
20260917_knowledge_sources.sql:19-21 — "Upload-origin chunks keep the old org-member read (same content as the PDF the member could already open)." That premise holds for a knowledge library mirroring doc control; it does not hold for a knowledge library used as a private shelf, and nothing in the product prevents that use.
```

**Chain reaction.** Giving knowledge_libraries an acl/visibility pair would also let the sources picker, the intelligence hub and the flows picker scope themselves, and would give the ask route a single first gate before any of the per-document work.

> **Verifier correction.** Reframe so the fix lands in the right place. The ask route is not the widening point for upload-origin content: knowledge_chunks_select (20260917:73-82) already grants every active member direct SELECT on any chunk whose document is NOT source-linked, so a member can read that same text without going near /api/knowledge/ask. And for source-linked mirrors the per-asker filter at :163-187 does apply. The finding is therefore properly stated as a schema gap — knowledge_libraries has no ACL of its own, so 'a private shelf' is not an expressible concept — rather than as a missing check in the route. Note also that this compounds finding 5: when that fail-open fires, this membership-only door is the only thing left.

**Done when.**

- [ ] knowledge_libraries carries acl + visibility evaluated by the same lib/acl engine, and the ask route rejects a library the caller cannot read before spending a token
- [ ] Linked reference libraries are checked against the ASKER too, not just the library that declared the link
- [ ] The product states plainly, in the library UI, that upload-origin documents are readable by every workspace member

---

<a id="kacl-7"></a>

## KACL-7 · Every mirrored controlled document's number and title is readable by any org member — the 20260917 lockdown closed chunks but left the document rows

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-12 DOCUMENT ACL BOUNDARY — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260911_knowledge_ai.sql:124-128`, `supabase/migrations/20260917_knowledge_sources.sql:69-82`, `lib/knowledge.ts:323-347`, `lib/knowledgeSourceSync.ts:47-52`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the 20260917 lockdown is chunk-only, so every mirror's document number, title, source_rev, page_count — and file_key, which is the same R2 key KACL-5 turns into bytes — stays readable by any active org member regardless of the controlled document's ACL.

**Mechanism.** Migration 20260917 explicitly locked down chunk reads for source-linked documents — `AND NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id = knowledge_chunks.document_id AND d.source_document_id IS NOT NULL)` (:77-81) — but knowledge_documents_select was left at membership-only (20260911:125-128) and no later migration changes it. The mirror's `name` is built as `${number} — ${title}` from the controlled document (knowledgeSourceSync.ts:47-52), and `listKnowledgeDocuments` does `select("*")` on the browser client (lib/knowledge.ts:342-344), returning name, file_key, source_document_id, source_rev, page_count and status for every mirror in the library regardless of the source document's ACL.

**Failure scenario.** A Viewer denied read on the "M&A / Turnaround 2027" folder opens the knowledge library that watches its parent library. The Documents list shows every mirrored file by document number and title — "TA-2027-001 — Coker Revamp Basis of Design" — plus its revision label and page count. They cannot read the chunks (RLS holds), but the existence, identity, revision and size of every restricted document is disclosed, which is exactly what a hidden/denied node is supposed to prevent.

**Evidence.**

```
20260917_knowledge_sources.sql:16-21 — "LOCKDOWN: chunks of SOURCE-LINKED documents are no longer readable by org members directly. Controlled documents carry per-node ACLs; the ask API is the only door to linked content." The document rows themselves were not part of that lockdown.
```

**Chain reaction.** This row is also what supplies fileKey to openCitation (page.tsx:1249-1258), so it is the bridge between the history-quote leak and the byte-door leak. Restricting it tightens all three.

> **Verifier correction.** State the compounding explicitly: the same select("*") is what makes finding 4 reachable, because mapDocument exposes `fileKey: r.file_key` and that key IS the controlled version's R2 object key (knowledgeSourceSync.ts:231, :250). So the row leak is not merely metadata — it is metadata plus the byte handle, gated only by the three-gap check in /api/storage/download-url. Rank the two together.

**Done when.**

- [ ] knowledge_documents SELECT for rows with source_document_id IS NOT NULL is gated by the source document's ACL (an RLS policy joining documents, or the list moves behind an API route that applies readableControlledDocIds)
- [ ] The knowledge library Documents list shows a non-readable mirror as absent, not as a named row
- [ ] file_key is not returned to the browser for source-linked mirrors


**Partial (2026-09-30, intelligence Round G).** Reproduced first: `knowledge_documents_select` (20260911:124-128) was membership-only and `listKnowledgeDocuments` selected `*`, so every mirror's name (`number — title`), revision, page count and `file_key` reached every member. `20261120` re-creates `knowledge_documents_select` as the 20260911 membership clause AND (`source_document_id IS NULL` OR `EXISTS (SELECT 1 FROM documents d WHERE d.id = knowledge_documents.source_document_id)`) — a POSITIVE EXISTS that runs under the CALLER's RLS, so it is the documents read decision itself (`documents_org_access` + the `documents_acl_select` node_visible overlay), and a document the caller cannot see hides its mirror (the package decision `DEC-59` (2)). It is NOT the shape of 20260917's chunk lockdown, which is a `NOT EXISTS` over `knowledge_documents` — and that difference is the review's blocker: hiding a mirror row turned 20260917's `NOT EXISTS` into a pass and opened the mirror's chunks to members. `20261120` therefore also re-creates `knowledge_chunks_select` (fix pass 2), in the same transaction, with the lockdown written positively — a member reads a chunk only when its document is an upload row they can see — so the mirror-row narrowing narrows the chunk read too, never the reverse (see the re-run below). Upload rows stay org-readable; controllers keep every row through `knowledge_documents_write` (FOR ALL, `is_org_controller`), dangling mirrors included. No app change: `listKnowledgeDocuments`, the library counts and every browser reader of the table inherit it. Verified on a scratch PostgreSQL 16 carrying the live policy and helper bodies (`node_visible` 20261041, `is_org_controller` 20260814, `acl_subject_in_bucket` 20260708, the 20260911 / 20260917 / 20260929 knowledge policies; the owner cascade stubbed to its document-owner arm), the whole paste applied as the user will paste it: BEFORE, a Viewer read every stored answer, every mirror row (a private document's and a dangling one included) and every mention sentence; AFTER, a Viewer reads their own answer, the upload and open-document mirrors and those documents' sentences; a Manager (who holds the FOR ALL `entity_mentions_write`) reads exactly the Viewer's sentences; an Engineer granted read on the private document reads their own answer, that mirror and its sentence; an Admin and a Viewer holding DocCtrl additively read everything (DEC-43); a non-member reads nothing and the hub count answers 0. All seven probes were true on the first apply and again on a second (idempotent). That run did not read `knowledge_chunks`, and the review found the gap it left: 20260917's `knowledge_chunks_select` hides a mirror's chunks with `NOT EXISTS` over `knowledge_documents`, which runs under the caller's RLS, so once `knowledge_documents_select` hides a mirror row the `NOT EXISTS` passes and the chunks OPEN. Fix pass 2: `20261120` re-creates `knowledge_chunks_select` in the same transaction with the same rule written positively (`EXISTS … AND d.source_document_id IS NULL` — an upload row the caller can see; lineDiff-pinned against 20260917), counts the chunks of private / hidden documents' mirrors before apply, probes the positive form, and probes that no policy in the database tests `NOT EXISTS` over `knowledge_documents`, `knowledge_questions` or `entity_mentions`; `lib/__tests__/knowledgeMemoryAcl.test.ts` replays schema.sql and every migration's policies to the same end. Re-run on a second scratch PostgreSQL 16 (the verbatim 20260911 / 20260917 / 20260929 policies and 20261012's `knowledge_search_document`): before the paste a Viewer read only the upload passage; with the paste minus the chunk section a Viewer read the private and the hidden mirror's passages, directly and through `knowledge_search_document`, and the two new probes were false (the reproduction); with the full paste a Viewer, an Engineer granted the private document and a Manager read only the upload passage and nothing through `knowledge_search_document`, an Admin read every passage (`knowledge_chunks_write`), and all eight probes were true on the first apply and on a second.

**Pending migration:** `supabase/migrations/20261120_intel_roundG_knowledge_memory_acl.sql` (inventory before apply: stored answers; answers citing a mirror of a private / hidden / private-draft document; answers citing a knowledge document that no longer exists; non-controller members; mirror rows, those of private / hidden documents and dangling ones; the chunks of private / hidden documents' mirrors (fix pass 2); mention rows and those on private / hidden documents).

**Done-when.**
1. Partly — a mirror row's SELECT is gated by its controlled document's ROW through an RLS policy joining `documents` (the done-when's first option). ✗ That predicate (`node_visible`) is true for every `normal`-visibility document, so a mirror of a normal-visibility document carrying an allow-list ACL or a role / team deny (`DACL-6` / `DACL-12`), or of a private draft (`is_private` / `scope`), still reaches every member until I-12 brings those rules into `node_visible`.
2. Partly — the Documents list shows a mirror whose controlled document's ROW the reader cannot see as absent, not as a named row (the list reads the table under RLS; verified on the scratch PostgreSQL 16 above); the normal-visibility gap of 1 applies here too.
3. ✗ Not done: `file_key` is still returned to the browser for source-linked mirrors — to every reader of the controlled document (the viewer opens the page with it; the bytes door re-decides every download, `KACL-5`, I-12), and, through the gap in 1, to members an app-only ACL denies. What landed: a member whose documents RLS hides the controlled document (private / hidden, no grant) no longer receives the mirror row or its `file_key` (`DEC-59` (2)).

**Scope / residual.** Stays OPEN on two dependencies: I-12 (allow-list ACLs, role / team denies and the private-draft rule inside `node_visible`) and the `file_key` residual (`KACL-5`, the bytes door). The mirror is exactly as visible as the controlled document's own ROW at the database. Restrictions the app enforces on a normal-visibility row — an allow-list ACL, a role / team deny (`DACL-6` / `DACL-12`), a private draft's creator-only rule — are enforced by the app and the history route but not by this policy; they tighten here automatically when I-12 brings them into `node_visible`, because the clause reads through the documents RLS rather than beside it.

---

<a id="kacl-8"></a>

## KACL-8 · Site Codebook legend sheets are injected into every answer without passing through the per-asker ACL filter

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:149-155`, `app/api/knowledge/ask/route.ts:1362-1385`, `app/(protected)/admin/codebook/page.tsx:468-477`, `lib/codebookServer.ts:31`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. The substance holds — a site-wide legend that mirrors a restricted controlled document is injected into every member's answers — but the title is wrong on mechanism: the per-asker filter IS applied at :1367; it is the exclusion SET that is scoped to the asked and linked libraries only. Severity stays MEDIUM (bounded to at most 3 legend docs, 6000 chars).

**Mechanism.** `excludedDocIds` is computed only over `allLibIds = [libraryId, ...linkedLibraries.map(l => l.id)]` (route.ts:165-169). `legendDocIds` merges the library's own attachments with `siteBook.legendDocIds` (route.ts:151-155), and the Site Codebook's legend picker searches knowledge_documents ORG-WIDE — `supabase.from("knowledge_documents").select("id, name").eq("org_id", orgId).ilike("name", …)` (admin/codebook/page.tsx:472-473) — across every knowledge library, not just this one. So a legend doc id can point at a mirror in a library that is not the asked library and not one of its links. That id is filtered only with `legendDocIds.filter((id) => !excludedDocIds.has(id))` (route.ts:1367) — a set that by construction contains nothing from other libraries. The chunk fetch that follows has no org filter, no library filter and no ACL evaluation: it selects up to 40 chunks by document id and pushes up to 6,000 characters into the answer system prompt as authoritative content.

**Failure scenario.** An Admin attaches a controlled P&ID legend/notes sheet that lives in the Engineering knowledge library as the site-wide legend. That sheet mirrors a controlled document restricted to engineering staff. Every member of the org, asking any library, now gets up to 6,000 characters of that sheet's text prepended to their prompt under the banner 'authoritative for symbols, line codes, and abbreviations', and the model is free to quote it in the answer.

**Evidence.**

```
route.ts:1369-1374 — `const { data: legendChunks } = await supabaseAdmin\n          .from("knowledge_chunks")\n          .select("document_id, page, content")\n          .in("document_id", usable)\n          .order("page", { ascending: true })\n          .limit(40);` — no .eq("org_id", orgId), no library scope, no ACL. The comment three lines above at route.ts:1364 claims "ACL applies; capped so a fat legend can't crowd out the actual passages" — only the cap is real.
```

> **Verifier correction.** Downgrade CRITICAL/HIGH framing to MEDIUM and drop one sub-claim. (1) "No .eq(\"org_id\", orgId)" is true but is not a cross-tenant vector: legendDocIds come from the org's own codebook config row and the library's own ai_features, so the ids are already org-scoped by provenance. The real defect is the missing ACL evaluation, not the missing org filter. (2) Exploitation requires an Admin to attach, as a legend sheet, a source-linked mirror sitting in a DIFFERENT knowledge library whose controlled document the asker cannot read — legend sheets are by nature symbol/abbreviation pages chosen deliberately for broad reference. Legend docs that live in the asked library or its links ARE correctly filtered by :1367. Report it as "the ACL filter has a hole exactly the width of the cross-library legend slot, and the comment says otherwise".

**Done when.**

- [ ] Legend doc ids are resolved to their source_document_id and run through readableControlledDocIds for the ASKER before any chunk is fetched, failing closed
- [ ] The legend chunk query is scoped with .eq("org_id", orgId)
- [ ] A legend document the asker cannot read contributes nothing and the answer does not silently degrade in a way that reveals its existence

---

<a id="kacl-9"></a>

## KACL-9 · There is no is_indexed gatekeeper — the column does not exist; the boundary is documents.ai_excluded, and the ask route's comment misnames it

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/aiBoundary.ts:21-60`, `lib/schemaExpectations.ts:121`, `supabase/migrations/20260807_link_proposals.sql:159-161`, `app/api/knowledge/ask/route.ts:400-411`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct on every point, but it is a documentation/terminology defect with no exploit path of its own: everything it says about retrieval not consulting ai_excluded is KACL-10's first half, and the naming point corrects a mental model rather than a control. Demote to LOW (or fold into KACL-10).

**Mechanism.** Two differently-shaped searches for the gatekeeper the owner asks about return nothing: `rg -n -i "is_?indexed"` over the whole tree (zero matches) and `rg -c "isIndexed" -i .` (zero matches). What exists instead is `documents.ai_excluded BOOLEAN NOT NULL DEFAULT FALSE` (20260807:159) plus lib/aiBoundary.ts, which names four block reasons: held_back (ai_excluded), out_of_scope (not inside a linked knowledge source), not_current (Superseded/Void/Archived) and no_file. What it ACTUALLY gates, traced end to end: mirroring at sync (knowledgeSourceSync.ts:164-168), the purge on flip (exclusion route), the orchestrator's two document tools (tools.ts:101, 137-152), the PFD picker (flows/browse/route.ts:112-117), the area status route (area/knowledge-status/route.ts:68-72) and the link proposer (linkProposerServer.ts:150-167). What it does NOT gate: retrieval in /api/knowledge/ask (zero references), stored ask history, or the graph. The comment at ask route.ts:405-408 says "AI-excluded documents are filtered HERE" about a filter that is testing the ACL set, not the flag — a reader auditing the boundary would conclude retrieval enforces it.

**Failure scenario.** An auditor or a future maintainer reads ask/route.ts:405-408, believes retrieval enforces the AI carve-out, and removes or weakens the sync-time/purge-time enforcement as redundant. Every held-back document becomes retrievable. Separately, anyone searching the codebase for the gatekeeper by the name the spec uses finds nothing and concludes the feature was never built.

**Evidence.**

```
lib/aiBoundary.ts:10-16 — "The four reasons a controlled document is NOT AI-readable: * held back — a controller set ai_excluded on this one file; * out of scope — it isn't in any linked knowledge source; * not current — Superseded, Void, or Archived; * no file — no current version to read." ask/route.ts:405-408 — "Over-fetch 3× the slot count: AI-excluded documents are filtered HERE, after the database already applied its LIMIT" — followed at :431 by `.filter((c) => !excludedDocIds.has(c.document_id))`, where excludedDocIds is the ACL set built at :163-187.
```

> **Verifier correction.** Demote this to a documentation-accuracy note and merge it into finding 7. It has no independent exploit path: everything it establishes about retrieval not consulting ai_excluded is finding 7's first half, and the naming point ("is_indexed" does not exist; the gatekeeper is ai_excluded) is a terminology correction for the owner's mental model, not a defect. Keeping it as a separate MEDIUM security finding inflates the count — report it as "the boundary is real but is named ai_excluded, and the ask route's comment at :404-408 misdescribes the ACL filter as the AI filter, which will mislead the next auditor."

**Done when.**

- [ ] The comment at ask/route.ts:405-408 says 'ACL-excluded' or the filter genuinely folds in ai_excluded
- [ ] docs/ARCHITECTURE.md:125 and lib/schemaExpectations.ts:121 are the single named description of the gatekeeper, and no code or doc refers to an is_indexed column
- [ ] aiReadability is the one function every AI door calls, with a test asserting each door calls it

---

<a id="kacl-10"></a>

## KACL-10 · ai_excluded is enforced nowhere in the retrieval path — only at sync and at flip-time purge, which race each other

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/exclusion/route.ts:59-102`, `lib/knowledgeSourceSync.ts:103-115`, `lib/knowledgeSourceSync.ts:159-171`, `app/api/knowledge/ask/route.ts:400-435`, `lib/aiBoundary.ts:52-60`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. The race and the missing retrieval-layer enforcement both hold for the knowledge ask path. "Enforced nowhere in the retrieval path" is over-broad, though: the orchestrator's retrieval DOES enforce it explicitly — lib/orchestrator/tools.ts:101 `.eq("ai_excluded", false)` and :144-160 map excluded controlled docs to mirrors and filter graph_ask passages. Severity stays MEDIUM.

**Mechanism.** Two searches confirm the retrieval path never consults the flag: `rg -c "ai_excluded" app/api/knowledge/ask/route.ts` exits non-zero (zero matches), and a case-insensitive `rg -in "exclu"` over the same file returns only excludedDocIds (the ACL set) and prose. The comment at route.ts:405-408 — "AI-excluded documents are filtered HERE, after the database already applied its LIMIT" — describes excludedDocIds, which is the ACL set, not documents.ai_excluded; the two are conflated. Enforcement therefore depends entirely on the mirror not existing: syncKnowledgeLibrarySources reads the excluded set once (knowledgeSourceSync.ts:108-115) then skips those docs when building `wanted` (via aiReadability at :164-168), and the exclusion route purges existing mirrors on flip (:77-94). Those two are not serialised: a sync pass that read `aiExcluded` BEFORE the flag write will, after the purge delete, re-insert the mirror (:268-284) with status 'pending', and the indexer will chunk it again. Nothing at query time would notice.

**Failure scenario.** A controller holds back a confidential incident report while the maintenance cron's sync pass is mid-flight for that library. The sync's aiExcluded snapshot predates the flag; the exclusion route sets the flag and deletes the mirror; the sync then re-inserts it. The controller sees 'purged: 1' and believes the boundary held. The document re-indexes and is retrievable and quotable by everyone whose ACL allows the source document, indefinitely, with no surface anywhere saying so.

**Evidence.**

```
exclusion/route.ts:5-11 — "The hole was TIMING. A document that had already been synced kept its mirror … until the next sync ran." The fix closed the forward window and left the reverse one. lib/knowledgeSourceSync.ts:113-114 — "Column absent (pre-migration): nothing is excluded" — an errored read of the excluded set also silently disables the carve-out for that whole sync pass.
```

**Chain reaction.** Because retrieval has no second line, every path that reads mirrors (ask, drawing census, locate, flows) inherits the same single point of failure. A retrieval-time check would also make the un-exclude path safe and let the purge become best-effort.

> **Verifier correction.** Promote the buried sub-finding to the headline: lib/knowledgeSourceSync.ts:109-115 reads the excluded set as `const { data, error } = …; if (!error) for (…) aiExcluded.add(r.id);` — on ANY error (not just a pre-migration 42703) the set is empty and every held-back document in the org is mirrored and indexed by that sync pass. That is an unconditional fail-open on a compliance boundary and needs no race to trigger, unlike the TOCTOU window, whose consequence is timing-dependent and therefore not observable from the repo.

**Done when.**

- [ ] The ask route (and drawing/locate) fold documents.ai_excluded into excludedDocIds at query time, so a held-back document is never retrievable even if a mirror exists
- [ ] The exclusion flip and syncKnowledgeLibrarySources cannot interleave (re-read the flag inside the insert loop, or re-run the purge after the sync, or take a per-library advisory lock)
- [ ] An errored ai_excluded read in knowledgeSourceSync fails closed for that pass rather than mirroring everything

---

<a id="kacl-11"></a>

## KACL-11 · chainReadable's no-ACL fallback lets a 'private'-visibility document through where the app's own canDiscover blocks it

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/knowledgeAccess.ts:57-78`, `lib/permissions.ts:113-131`, `lib/acl.ts:189`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The divergence is real and unmitigated: readableControlledDocIds/containerReadable are the only readers of the ACL chain that treat 'private' as readable-by-default, and lib/knowledgeSourceSync.ts mirrors source documents with no visibility/acl filter (grep for visibility|acl|is_private|scope in that file returns nothing), so such a doc would be indexed and quoted while RLS hides the row from the browser entirely. Severity lowered to LOW because I could not find any in-app writer that produces visibility='private' with acl NULL: PermissionDrawer.tsx:265-283 always writes acl and visibility in the same payload; document creation at app/(protected)/documents/[libraryId]/page.tsx:2448-2451 does set them independently (`visibility: library.defaultNewVisibility ?? "normal", acl: library.defaultNewAcl ?? null`) but nothing in the codebase ever sets default_new_visibility to anything but 'normal' (LibraryWizard.tsx:273; admin/libraries/page.tsx:107 only round-trips the stored value, with no UI control). The only path that can materialize the state is the blind restore importer (app/api/admin/restore/apply-table/route.ts:77-83 upserts caller-supplied rows verbatim, and 'documents' is in the importable contract, lib/exportTables.ts:44) or a direct DB write — i.e. latent defence-in-depth, not a demonstrated live leak.

**Mechanism.** When no node in the chain carries an ACL object, chainReadable returns `visibility !== "hidden"` (knowledgeAccess.ts:77) — "private" is not in the test, so a private-visibility document with a null acl is treated as readable. The app's equivalent is stricter: canDiscover returns `visibility !== "hidden" && visibility !== "private"` (permissions.ts:125). NodeVisibility genuinely carries "private" as a third state and acl.ts:189 handles it alongside hidden. Reachability requires documents.visibility = 'private' with documents.acl NULL — PermissionDrawer always writes both together (PermissionDrawer.tsx:264-282), so the reachable route is a data import, a restore (lib/dataRestore.ts), or a row created by a path that sets visibility without an acl; I did not trace one to completion, hence SUSPECTED.

**Failure scenario.** A restore or bulk import writes documents with visibility='private' and acl NULL (the drawer is not involved). Those documents are mirrored by a linked source, indexed, and then retrieved and quoted for every org member, because knowledge's fallback only excludes 'hidden'. The document screens hide them; the AI answers from them.

**Evidence.**

```
lib/knowledgeAccess.ts:77 — `return visibility !== "hidden";` versus lib/permissions.ts:125 — `if (!decision) return visibility !== "hidden" && visibility !== "private";`
```

**Chain reaction.** The same one-line divergence sits in containerReadable's path (knowledgeAccess.ts:147, 151), so a private-visibility LIBRARY or FOLDER with no acl is also offerable in the sources browse picker.

> **Verifier correction.** Add the two mitigations I found, and keep SUSPECTED (do not let a later agent promote this). (1) readableControlledDocIds:210 already drops private documents by a different column — `if ((doc.is_private || doc.scope === "private") && doc.created_by !== principal.uid) continue;` — so the private-DRAFT case, the likely intent of the state, is covered before chainReadable is ever reached. (2) I could not find any writer of visibility='private' on documents: two greps (`rg -n "is_private|scope: \"private\""` over app/lib/components, and a scan of every `visibility:` insert/update site) show is_private/scope are READ-only in app code, LibraryWizard.tsx:273 hardcodes defaultNewVisibility "normal", and PermissionDrawer.tsx:264-283 always writes acl and visibility together. Treat this as a one-line hardening (add `&& visibility !== "private"` at knowledgeAccess.ts:77), not as a live leak.

**Done when.**

- [ ] chainReadable's fallback matches canDiscover: `return visibility !== "hidden" && visibility !== "private";`
- [ ] A test covers visibility='private' + acl NULL for both readableControlledDocIds and containerReadable
- [ ] Whether any writer can produce visibility='private' with acl NULL is settled (grep lib/dataRestore.ts and the import paths); if none can, the divergence is still closed as defence in depth

---

<a id="kacl-12"></a>

## KACL-12 · The ACL seam fails OPEN when its own reads fail: a failed (or row-capped) libraries / collections read drops the folder and library ACLs, a failed team_members read drops the caller's teams and with them every team deny, and a denied document reads as open to every AI surface and to share serving

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeAccess.ts:96-137`, `lib/knowledgeAccess.ts:36-50`, `lib/knowledgeAccess.ts:247-276`, `lib/knowledgeAccess.ts:188-205`, `lib/knowledgeAccess.ts:91`, `lib/orchestrator/tools.ts:84-90`, `app/api/knowledge/ask/route.ts:177`, `lib/shareAuthorization.ts:23-40`, `lib/knowledgeSourceSync.ts:75`
- **Opened by:** intelligence Round G, package I-01 phase A (2026-09-30), while re-verifying `KACL-2`'s fail-closed criterion against HEAD `1b71ca1`; the `team_members` limb and the direct-caller consequences were added on the package's review the same day. Reproduced by executing the code against an in-memory stand-in (below). This report's banner ("Each finding survived an adversarial verification pass") predates the finding and does not apply to it: nobody independent has tried to refute it. The grade is carried in data by the `Re-verified` line below, which the index reads as `hardening-pass` (a re-read against source by the opening package) instead of the banner's `adversarial`; an independent pass is queued (`DEC-41`: a non-independent grade is work not yet done).
- **Re-verified:** hardening pass by the opening package's fix pass (2026-09-30, not independent) — **SURVIVES, widened**. Re-run against HEAD `1b71ca1`: both limbs reproduce as recorded, and the `libraries` limb also reaches `containerReadable` — with a library-level deny-read on role Viewer and `libraries` erroring, `containerReadable("folder", F)` answers true for a folder in that library while `containerReadable("library", L)` answers false (Mechanism, below; committed on fix pass 3 as the last `it.fails` in the KACL-12 block of `intelRoundGRecords.test.ts`). The package review had reproduced the same three results independently of the author, but was not a refutation pass.
- **Owner:** I-12 (DOCUMENT ACL BOUNDARY — its files include `lib/knowledgeAccess.ts`'s read predicate; this finding is not yet in its plan). One file for the leak; every caller of `readableControlledDocIds` inherits the fix, and the four direct `loadDcLandscape` callers named under Chain reaction need the incomplete-landscape answer.

**Mechanism.** Two reads inside the seam swallow their errors.

*Containers.* `readableControlledDocIds` (`lib/knowledgeAccess.ts:247-276`) evaluates each document's chain from `loadDcLandscape` (`:96-137`), which reads `libraries`, `collections` and `teams` in one `Promise.all` (`:105-109`) and never looks at the three `error`s — `for (const l of libsRes.data ?? [])` (`:111`), `for (const c of foldersRes.data ?? [])` (`:125`). A failed read yields an EMPTY map, not an error. The chain is then `[lib?.acl ?? null, ...(fc?.chain.slice(1) ?? []), doc.acl]` (`:269-270`): a folder absent from the map makes `folderChain` return `null`, a library absent leaves `lib` undefined, the missing ACLs vanish, and `chainReadable`'s no-ACL fallback answers `visibility !== "hidden"` (`:91`) — readable. Only the seam's own `documents` read fails closed (no rows → nothing readable). `containerReadable` fails closed on only half of this limb. A container missing from its map is unreadable (`:201`, `:205`), so with `collections` erroring the container lists show no folders. With `libraries` erroring and `collections` read, the folder IS in its map but its library is not, and `folderChain` builds `[lib?.acl ?? null, ...lineage]` (`:188-189`): the library ACL drops out, and a folder under a library-level deny reads as a readable container. The container lists then name folders of a library the caller is denied — the sources picker (`/api/knowledge/sources?action=browse`, `:63-64`), the add-source re-check (`:199`, which then links the folder as a source), `/api/flows/browse` (`:95`) and `/api/area/knowledge-status` (`:117`). A DOCUMENT list fails open on both halves, the flows browser's included (`/api/flows/browse:161` goes through `readableControlledDocIds`). The same shape applies to row caps: neither container read pages, so where PostgREST's `max-rows` is below an org's folder count, folders past the cap are absent and their documents lose their folder ACLs (this limb SUSPECTED — the cap is a deployment setting the repository does not pin, the caveat `KACL-4` carries).

*The caller's teams.* `loadPrincipal` (`:35-51`) reads `org_members` and `team_members` in one `Promise.all` and destructures `[{ data: member }, { data: teams }]` (`:36-40`); the `team_members` error is never looked at, and `teamIds: (teams ?? []).map(…)` (`:49`) builds a principal with NO teams. A team ALLOW then stops matching (narrower — fails closed), but a team DENY stops matching too (wider — fails open): a folder ACL of [allow role Viewer read, deny team T-contract read] reads as open to a Viewer in T-contract. This limb reaches every chain evaluated with that principal — `readableControlledDocIds` AND `containerReadable` (so on this limb the container lists are not safe either) — and the `managePermissions` check `/api/acl/rebuild` makes with `loadPrincipal`'s `teamIds` (`app/api/acl/rebuild/route.ts:76`).

**Failure scenario.** Document Control restricts the "Legal Hold / Incident" folder with a deny-read on role Viewer. During a statement timeout on the `collections` read, a Viewer asks the Assistant about the incident: `find_documents` returns INC-0042 with its open URL and `search_documents` returns "the flare knockout drum overfilled during the trip". The tools' own fail-closed catch (`lib/orchestrator/tools.ts:89`) never fires — the seam did not throw, it returned a wider set. In the same window `/api/knowledge/ask` builds its exclusion set from the same function (`route.ts:177`), and a share link minted by someone that folder denies re-checks its creator through it (`lib/shareAuthorization.ts:33`) and serves. The team limb is the same story told with a team: the folder allows Viewers but denies team "Contractors"; while `team_members` times out, a contractor Viewer's principal loads with no teams, the deny never matches, and the same answers come back.

**Evidence.**

```
lib/knowledgeAccess.ts:105-111 — `const [libsRes, foldersRes, teamsRes] = await Promise.all([ supabaseAdmin.from("libraries").select(…).eq("org_id", orgId), supabaseAdmin.from("collections").select("*").eq("org_id", orgId), … ]); … for (const l of libsRes.data ?? []) {` — no `.error` check anywhere in loadDcLandscape. lib/knowledgeAccess.ts:36-39 — `const [{ data: member }, { data: teams }] = await Promise.all([ supabaseAdmin.from("org_members").select("role, roles")…, supabaseAdmin.from("team_members").select("team_id").eq("uid", uid), ]);` and :49 `teamIds: (teams ?? []).map((t) => t.team_id as string),` — the team read's error is not even destructured. Reproduced 2026-09-30 with the stand-in from lib/__tests__/intelRoundGRecords.test.ts, and committed there on the package's fix pass 3 as the "KACL-12 (owner I-12)" block — four it.fails cases (collections error / folder deny, libraries error / library deny, team_members error / team deny, libraries error / containerReadable), each with a control showing the deny applies while every read answers; each fails at HEAD on the leak, and a scratch fix (loadDcLandscape throwing on a read error, loadPrincipal returning null on a team_members error) flipped all four: a Viewer under a folder deny gets [STD-0007] from find_documents; with `collections` erroring the same call returns [INC-0042, STD-0007] and search_documents returns the INC-0042 passage; a library-level deny with `libraries` erroring behaves the same. With the folder ACL [allow role Viewer read, deny team T-contract read] and the Viewer in T-contract: teamIds ["T-contract"] → find_documents [STD-0007], passages [STD-0007, Site note]; with `team_members` erroring, teamIds [] → [INC-0042, STD-0007] and passages [INC-0042, STD-0007, Site note].
```

**Chain reaction.** Every caller of `readableControlledDocIds`: the orchestrator's tools and answer chips (`lib/orchestrator/tools.ts`, `app/api/orchestrator/route.ts:218`), `/api/knowledge/ask` (`:177`), `/api/knowledge/drawing` (`:76`), `/api/knowledge/locate` (`:72`, `:135`), `/api/flows/browse` (`:161`), `/api/share/list` (`:56`) and share serving (`shareStillAuthorized`, `lib/shareServe.ts:157`); on the team limb, and on the `libraries` half of the container limb for folders, also every `containerReadable` decision (`/api/knowledge/sources` browse `:64` and add `:199`, `/api/flows/browse` `:95`, `/api/area/knowledge-status` `:117`). The direct callers of `loadDcLandscape` see a `collections` failure as a wrong answer, but a `libraries` failure as a leak of folder names (above; reproduced: library deny-read on role Viewer, `libraries` erroring → the folder is readable, the library is not). One of them also loses data today: `syncKnowledgeLibrarySources` (`lib/knowledgeSourceSync.ts:75`) with `collections` erroring gets `folderSubtree` = the root folder alone (`:128`) and no folder ids for a library source's null-`library_id` documents (`:143-157`), so documents in subfolders drop out of `wanted` and the REMOVE loop (`:286-293`) deletes their `knowledge_documents` mirrors — the next good sync has to re-ingest and re-embed them. `/api/knowledge/sources` (`:58`, `:187`), `/api/flows/browse` (`:51`) and `/api/area/knowledge-status` (`:58`) show, or refuse, on a partial landscape. None of those four catches: a loader that simply starts throwing turns each into an uncaught 500, and `syncAllKnowledgeSources` (`lib/knowledgeSourceSync.ts:299-319`) has no per-library catch, so one throw aborts every remaining library (the cron step's catch, `app/api/cron/maintenance/route.ts:280`, only records it). It undercuts the fail-closed criterion `IEDGE-2` was closed on and the one `KACL-2` still carries (both OPEN on it), and the "(fail closed)" in `ORCH-3`'s resolution. It is not `KACL-4` (the ask route's own mirror query) — both need fixing.

**Remediation (illustrative).** `readableControlledDocIds` loads its landscape strictly: any `libraries` / `collections` / `teams` read error throws, and both container reads page with a stable `.order("id")` and `.range()` until a short page. Most of its callers already catch and fail closed (`tools.ts:89`, `unreadableMirrors`, the orchestrator's chips, `shareStillAuthorized`, `/api/share/list`, the ask route's inner try, locate, drawing); `/api/flows/browse:161` does not, and answers 503. A document whose `collection_id` / `library_id` is missing from the loaded landscape is unreadable to a non-controller rather than evaluated without its container, and `containerReadable` treats a folder whose library is missing the same way. `loadPrincipal` returns null when `team_members` errors (its callers refuse a null principal), or throws to a caller that fails closed. The direct `loadDcLandscape` callers get the incomplete landscape as an explicit signal (a throw they catch, or a `complete` flag): `/api/knowledge/sources`, `/api/flows/browse` and `/api/area/knowledge-status` answer 503, and `syncKnowledgeLibrarySources` skips reconcile AND removal for that library and reports the error, with `syncAllKnowledgeSources` catching per library so one failure does not stop the rest.

**Done when.**

- [ ] A libraries or collections read error inside the seam makes every controlled document AND every container unreadable for that call (or throws to a caller that fails closed) — a chain is never evaluated with a container missing
- [ ] A team_members read error yields no principal (or throws to a caller that fails closed) — a team deny is never dropped
- [ ] A document whose folder or library is absent from the loaded landscape is unreadable to a non-controller, and so is a folder whose library is absent
- [ ] The container reads page until exhausted, so an org with more folders than the row cap keeps every folder ACL
- [ ] No direct caller of `loadDcLandscape` turns an incomplete landscape into an answer: `/api/knowledge/sources`, `/api/flows/browse` and `/api/area/knowledge-status` answer 503, and the knowledge-source sync neither reconciles nor removes a library's mirrors on a failed read (and one library's failure does not stop the others)
- [ ] Tests drive a folder-denied document through `readableControlledDocIds` with the container read failing, a team-denied one with `team_members` failing, and a folder under a library-level deny through `containerReadable` with `libraries` failing, and assert none is readable (the four KACL-12 `it.fails` cases in `lib/__tests__/intelRoundGRecords.test.ts`, flipped to `it`)

---
