# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 258
findings and 12 gap specs are worked against. Judgment calls shared with the
other areas are settled in [`../DECISIONS.md`](../DECISIONS.md).

---

## The redo-pairs — the whole value of this sequence

Three pairs. Building the second before the first means undoing it.

### PAIR 1 · `GAP-302` before anything writes Bridge output

Three separate design proposals wanted to union the Bridge's tags into
`documents.asset_tags`. Do that and you will undo it, for three verified reasons:

1. The trigger `DELETE`s and re-derives all `jsonb_sync` rows on **every**
   `asset_tags` edit (`20260609_phase1_normalization.sql:90-113`), so a
   sheet payload hung there is destroyed by the next unrelated touch.
2. `elem->>'tag'` is the only field the trigger reads. Nothing else survives.
3. `AssetTag` is `{tag; type?; category?}` — no source field — so a
   vision-asserted tag renders identically to a drafter-typed one.

Widening the CHECK to `('jsonb_sync','manual','drawing')` and adding
`sheet_label`/`pages` is two lines and makes the honest version cost the same as
the dishonest one.

### PAIR 2 · `GAP-305` before `GAP-306`

The scope pivot cannot work while `unit:<uuid>` and `cbunit:<code>` are two
unconnected nodes. Build the filter first and it will scope to half a unit,
convincingly, which is worse than not having it.

### PAIR 3 · `GAP-301` before `GAP-304`

If the Bridge starts writing relations before the sheet address is a stored fact,
every row it writes has to be rewritten to carry one. `GAP-301` is `S`.

---

## Phase 0 — Free, and each unblocks something

| Item | Why now |
|---|---|
| **`GAP-302`** | Two-line migration. Everything downstream depends on it and nothing depends on it. |
| **`GAP-301`** | The sheet address is already extracted; one predicate excludes it. |
| **`GAP-310`** | Four tag grammars have already silently killed the alias feature in ⌘K and on the old-tag URL path. Migrate the column and flip the readers **in one commit**. |
| **`BR-*` — the `targetKey` throw above the discovery block** | `equipmentBridgeServer.ts:190-193` sits above `:197-234`, so no mapped column means zero assets created. The ordering *is* the bug. |
| **`BR-*` — the silent strip-and-retry** | `:219-224` drops `unit_code, code, origin, discovered_from` on error and `:226-230` falls through to `createdAssets: 0` with no signal. |

---

## Phase 1 — The security answer

Work `05-knowledge-acl.md` and `06-document-acl-leaks.md` in severity order. These
answer the owner's direct question and they gate nothing else, so they can run in
parallel with Phase 0 by a second agent.

⚠ **The ingest lock (`ING-*`) belongs here despite not being a security finding.**
There is no server-side ingest lock — three independent drivers can process the
same page range, and the loser hard-errors the whole document. It fires hardest
right after a rev-up, because rev-up marks documents `stale`, which is the same
queue. It also double-bills vision pages.

---

## Phase 2 — The memory

In order. This is the through-line made concrete.

1. **`GAP-303`** — provenance. Before the relation exists, not after: retrofitting
   a source column onto rows already written means a backfill that cannot recover
   what it did not record.
2. **`GAP-304`** — the Bridge writes a relation. **Keep the metadata write**; the
   drawing row's chips render from it. Make the relation authoritative.
3. **`GAP-305`** — one unit identity, and `documents.unit_code` as a real column.
4. **`GAP-309`** — revision truth. Ships with `GAP-303`'s revision field; skipping
   it means the relation starts accumulating false records immediately.

---

## Phase 3 — The doors and the ledger

5. **`GAP-307`** — any door. Move the `source_document_id` gate; wire
   `lib/xlsxData.ts` to the asset importer; add unit and code to
   `CANONICAL_FIELDS`.
6. **`GAP-308`** — the coverage report.

---

## Phase 4 — The pivot

7. **`GAP-306`** — `lib/scope.ts`.

⚠ **Argue the place before the filter.** The operating area may be the better
first delivery: the same scope resolved once, presented as somewhere you stand
rather than something you configure. His sentence — *"crude unit, all this goes
here"* — describes a place at least as much as a filter. Decide deliberately.

---

## Phase 5 — The daily surfaces

8. **`GAP-311`** — tag lookup in ⌘K. Cheapest item with the highest daily use.
9. **`GAP-312`** — the equipment field on the drafting request. **Ship with
   `GAP-110`/`GAP-111`** from the drafting-flow area or the form gets edited twice.

Then the remaining findings in severity order.

⚠ **Deploy order — intelligence Round G I-05 (AI governance; `DEC-44` (I-05)).**
A stored $0 cap LOCKS the moment the app deploys (`GOV-3`) — the app half does
not wait for `20261137` — where $0 used to mean "no cap". **Before the app
deploys**, run this read-only query in the Supabase SQL editor (it changes
nothing; it is `20261137`'s two $0 inventory counts):

```sql
SELECT 'per-person AI caps stored as $0 (they LOCK once the app deploys)' AS check, COUNT(*)::text AS n
  FROM ai_usage_limits WHERE user_id IS NOT NULL AND monthly_cap_usd = 0
UNION ALL
SELECT 'workspace-default AI caps stored as $0 (every member on the default is locked)', COUNT(*)::text
  FROM ai_usage_limits WHERE user_id IS NULL AND monthly_cap_usd = 0;
```

A non-zero count is a workspace that meant "unlimited": set a real figure
first (AI settings, or an UPDATE of that row), then deploy. `20261137` itself
may be pasted before or after the app.

**Owners still to map the ledger refusal** (`GOV-4`): during a ledger outage,
`getMonthUsage` / `getCapUsd` throw a 503 `GovernedCallError`. The ingest
route, the ingest drain and the codebook import catch it (I-05). The ask
(I-03), orchestrator (I-04) and embed (I-02's, merged) routes still answer an
unhandled 500. They refuse their AI work either way, but the sentence is lost.
Each maps `GovernedCallError` onto its response as it adopts `assertAiGates`.

⛔ **MERGE GATE for I-05 — locate keeps its non-AI output during a ledger
outage** (`GOV-4`; I-07's file, I-07 runs in parallel). `app/api/knowledge/locate/route.ts`
is NOT refused either way. When its AI step is refused (no key, cap reached)
it still answers the text-layer `positions`, `notOnPage` and the
library-wide `elsewhere` hits with a `skipped` sentence; with I-05 an
unreadable ledger throws at its
`Promise.all([getMonthUsage(...), getCapUsd(...)])` (line 185 at I-05's head)
and the whole response is a 500 — the positions already found and the
"V-3 is on 025-PID-0103" navigation are lost. **When I-05 merges, if I-07 has
not already landed this, the integrator applies it in the same merge** (the
locate route is otherwise I-07's):

```ts
import { isAiUsageUnavailable } from "@/lib/ai/gateError";
import type { MonthUsage } from "@/lib/ai/usageServer";
// …replacing `const [spent, cap] = await Promise.all([...]);`
let spent: MonthUsage, cap: number;
try {
  [spent, cap] = await Promise.all([getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id)]);
} catch (e) {
  if (!isAiUsageUnavailable(e)) throw e;
  return NextResponse.json({
    positions: [...found.values()], notOnPage: trulyAbsent, elsewhere,
    skipped: `${(e as Error).message} The sheet still opens at the right page.`,
  });
}
```

Test (with it): a vision-read sheet, a key on file, and `ai_usage_events`
answering a read error → 200 with the text-layer `positions`, `notOnPage`
and `elsewhere` intact and `skipped` carrying the "AI usage can't be read
right now" sentence; no provider call. Any other error still throws.

**The current month of the AI spend ledger is never purged — coordinated
limb in A&O's file** (`GOV-4` / `GOV-10`, I-05 fix pass 3).
`app/api/admin/purge/route.ts` (A&O P7's; the notifications fleet's N6 edits
its status filters) listed `ai_usage_events` as "pure telemetry" with a 7-day
floor, so an Admin or Doc Controller at their cap could purge the month's
rows older than a week and be admitted again. I-05 added `cutoffFor`: the
cutoff for `ai_usage_events` is `min(cutoff, monthStartIso())` (count and
delete), the target is relabelled "AI spend ledger (past months)", and the
preview and the `DATA_PURGE` row carry each table's cutoff
(`lib/__tests__/purgeLedgerFloor.test.ts`). **A&O P7 and N6 rebase on it and
keep it**: whatever else changes in the route, a current-month ledger row is
never purge-eligible.

**Embeddings allowlist at spend — I-02 / I-02b's limb** (`GOV-6`). The
embeddings allowlist (`ALLOWED_EMBEDDING_PROVIDERS`) is enforced at save and
at test (`/api/ai/connection`), and by `assertAiGates({ key: "embedding" })`
— which no index-time spend calls yet. `/api/knowledge/embed`, the embed
drain and the ask route's query embedding read the key through
`embeddingConnectionFrom` with no allowlist (the client only calls Voyage's
or OpenAI's endpoint, so no third vendor is reached today). Limb: run
`assertAiGates({ key: "embedding" })` in the embed route and the drain as
they adopt the gate stack, or have `embeddingConnectionFrom` return null for
a provider off `ALLOWED_EMBEDDING_PROVIDERS`; test a stored
`embedding_provider` off the list is never spent.

**The lock's copy on the older routes — I-03 / I-04 / I-02 / I-07 limbs**
(`GOV-3`). A $0 cap is a lock that does not reset, but the ask, orchestrator
and embed routes print "Monthly AI budget reached — $0.00 of your $0.00 cap.
It resets on the 1st" for a locked member, and locate "Monthly AI budget
reached ($0.00 of $0.00)". Each owner branches on `capIsLocked(cap)` (or a
refusal's `details.locked`) and says "Your monthly AI cap is set to $0, so AI
is locked for you until someone who manages AI caps raises it" — never the
reset — as `/api/templates/generate` does (I-05).

⛔ **MERGE GATE for I-05 / I-02b — a $0 cap is a refusal to every reader of
`/api/ai/usage`** (`GOV-3`; I-02b's code, I-02b runs in parallel). Since
I-05, `GET /api/ai/usage` answers `capUsd: 0, locked: true` for a LOCKED
member; 0 no longer means "no cap". I-02b's new `ownVisionKeyProblem`
(`lib/knowledge.ts`) does `const cap = Number(usage.capUsd) || 0; if (cap > 0
&& spent >= cap) …`, so for a locked member it answers null ("no problem").
The table-aware re-index then runs without its warning, the ingest route
refuses vision ("Monthly AI budget reached ($0.00 of $0.00)"), and scan and
CAD pages are indexed text-only. I-05 added `locked` (with `calls`, `byOp`
and `canManageCaps`) to `AiUsageSummary` and the helper
`aiUsageLockedReason(usage)` beside `getAiUsage`. **Whichever of I-05 and
I-02b merges second, the integrator applies this in the same merge**,
inside `ownVisionKeyProblem`, right after `const usage = await
getAiUsage(orgId);`:

```ts
  // GOV-3 (I-05): a $0 cap is a LOCK (`locked: true`, capUsd 0), never "no cap".
  const locked = aiUsageLockedReason(usage);
  if (locked) return locked;
```

The test flips with it. In I-02b's `lib/__tests__/ingestLoopClient.test.ts`,
"a monthly budget reached is a problem; a cap of 0 is not (the route reads
it as no cap)" asserts the opposite and becomes "…; a cap of 0 is the LOCK
(GOV-3)". Both `{ ...usage(0, 0), locked: true }` and `usage(50, 0)` now
expect `"your monthly AI cap is set to $0, so AI is locked for you until
someone who manages AI caps raises it"`. The page test in
`knowledgePageIngestUi.test.ts` already shows that any `ownVisionKeyProblem`
answer refuses the re-index before anything is reset. Every other reader of
`/api/ai/usage` follows the same rule: `usage.locked === true` (equivalently
`capUsd` 0) is a refusal, never "no cap". Today the only other reader is AI
settings, which already does.

**`20261137` re-creates TWO functions** (I-05 fix pass 3): besides
`org_capability_allows_for` (one CASE row), `capability_policy_write_guard`
from `20261056` with `'ai.manage_caps'` added to its critical list
(`ai.manage_caps` is `critical: true`). A later package that re-creates the
guard starts from `20261137`'s body.

---

## Do not do these

Drawn from 45 surviving `TRAP_TO_AVOID` proposals.

| Tempting | Why not |
|---|---|
| Union the Bridge's tags into `documents.asset_tags` | The trigger eats them. `GAP-302`. |
| Make the sheet a node type, or a document row per sheet | Put it on the **relation**. A sheet node multiplies the graph and answers nothing extra. |
| Infer the unit edge at graph-assembly time | Violates `orgGraph.ts:4-5` — *"each edge is a row somewhere"* — and would fail the guard test another agent proposed in the same run. Write the decode. |
| Raise `MAX_PAGES` and vision-read the whole drawing set | **The tag→sheet map he asked for costs zero model calls.** It is already extracted. |
| Build the scope filter before the two unit identities are reconciled | It will scope to half a unit, convincingly. |
| Add a service-class keyword lexicon (`'150# steam'→utility`) in `lib/` | Would be the **first facility vocabulary ever admitted to application code**, in the product whose owner said baking in conventions boxes him into names other facilities do not use. Ship the column; let the codebook or a confirmed assertion fill it. |
| Auto-accept AI proposals above a confidence threshold | A number is not a source. `GAP-303`. |
| Let AI-derived data drive a hold, an MOC, or a compliance artifact | Hard rule. A human assertion goes in between. |
| Add a cron entry to `vercel.json` | A third entry fails every deployment on this plan (`app/api/cron/maintenance/route.ts:286-291`). Everything rides `maintenance`. |
| Write a second container-chain walk | `lib/docClass.ts:49-58` already does document → folder → library. |
| Name a graph lens after what it hides | That is the naming defect. "Process" means "everything except paper". |

---

## Verification you cannot skip

**No live database, no browser, no AI provider.** Deterministic parsers, RLS
policies and call graphs are read from code and are exact. **Nothing about model
output quality was observed** — every such claim is marked `SUSPECTED` and must be
reproduced against a real provider before it is acted on.

Per `DEC-29`, reproduce before fixing. Two specifically:

- **`21-edges-and-invariants.md` has since been verified by hand** — both
  `CRITICAL`s and the RLS-shaped `HIGH`s confirmed; the rest marked. Its record
  is at the top of the file. **`IEDGE-1` and `IEDGE-2` belong in Phase 1** with
  the other ACL work: `graph/ask` and every orchestrator read tool run the corpus
  search on the **service role**, so the ACL enforcement both files document in
  their own comments never happens.
- **The table-chunking finding in `01-ingestion.md`** was demonstrated by
  transcribing the functions and executing them on both paths. That is strong
  evidence but it is not the running system: **re-run it against a real ingested
  document before changing the chunker**, because the fix touches every chunk
  boundary in the corpus and would require a full re-index.
