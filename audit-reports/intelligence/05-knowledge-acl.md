# 05 · The knowledge ACL boundary

**11 findings** — 2 CRITICAL · 3 HIGH · 6 MEDIUM.

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
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260911_knowledge_ai.sql:146-150`, `lib/knowledge.ts:504-527`, `lib/knowledge.ts:529-546`, `app/(protected)/knowledge/[id]/page.tsx:1410-1415`, `app/(protected)/knowledge/[id]/page.tsx:1690-1720`, `app/api/knowledge/ask/route.ts:1632-1650`, `app/api/knowledge/ask/route.ts:1739-1744`

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

---

<a id="kacl-2"></a>

## KACL-2 · The orchestrator reads every indexed document in the org with no ACL check at all — its own file header says this is a data leak

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/orchestrator/route.ts:40-66`, `lib/orchestrator/tools.ts:1-19`, `lib/orchestrator/tools.ts:85-116`, `lib/orchestrator/tools.ts:119-168`, `supabase/migrations/20260929_mention_engine.sql:99-131`

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

---

<a id="kacl-3"></a>

## KACL-3 · A HIDDEN document is treated MORE permissively than a normal one: 'discover' alone makes its full text AI-readable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeAccess.ts:54-78`, `lib/acl.ts:139-154`, `lib/acl.ts:207-214`, `lib/permissions.ts:108-132`

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
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260911_knowledge_ai.sql:124-128`, `supabase/migrations/20260917_knowledge_sources.sql:69-82`, `lib/knowledge.ts:323-347`, `lib/knowledgeSourceSync.ts:47-52`

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

---

<a id="kacl-8"></a>

## KACL-8 · Site Codebook legend sheets are injected into every answer without passing through the per-asker ACL filter

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/knowledge/ask/route.ts:149-155`, `app/api/knowledge/ask/route.ts:1362-1385`, `app/(protected)/admin/codebook/page.tsx:468-477`, `lib/codebookServer.ts:31`

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

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/aiBoundary.ts:21-60`, `lib/schemaExpectations.ts:121`, `supabase/migrations/20260807_link_proposals.sql:159-161`, `app/api/knowledge/ask/route.ts:400-411`

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

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/knowledgeAccess.ts:57-78`, `lib/permissions.ts:113-131`, `lib/acl.ts:189`

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
