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

⛔ **MERGE GATE for I-05 — locate keeps its non-AI output when the cap
table cannot be read, and refuses a $0 lock before its first call** (`GOV-4`,
`GOV-3`; I-07's file, merged at `d466a59`). *Restated in I-05 fix pass 10:*
the gate as first written replaced a `Promise.all([getMonthUsage(...),
getCapUsd(...)])` that I-07 as merged no longer has, so it could not be
applied as written. On the integration branch,
`app/api/knowledge/locate/route.ts:303` reads, outside any try:

```ts
const [spentUsd, cap] = await Promise.all([monthSpendAllOps(orgId, user.id), getCapUsd(orgId, user.id)]);
```

`monthSpendAllOps` is locate's own ledger read. It answers null on a read
error, and the route already handles that null. With I-05 two things change
under it:

- (a) `getCapUsd` THROWS `AiUsageUnavailableError` (503) when the cap table
  cannot be read; at `052271b` it answered $10. Uncaught, the whole locate
  response is a 500. The text-layer `positions`, `notOnPage` and the
  library-wide `elsewhere` hits, which spend nothing, are lost.
- (b) A stored $0 cap is `LOCKED_CAP_USD`, the smallest positive number.
  `monthSpendAllOps` has no lock floor (I-05's `getMonthUsage` has one).
  For a locked member with no spend this month, `overCap(ZERO_USAGE)` =
  `cap > 0 && 0 >= 5e-324` is false, so the coarse pass, a paid page-vision
  call, is made. The per-call re-checks refuse after it. Until this lands,
  `GOV-3`'s "every gate refuses at $0 spent" does not hold for locate.

**When I-05 merges, if I-07 has not already landed this, the integrator
applies it in the same merge** (the locate route is otherwise I-07's):

```ts
import { isAiUsageUnavailable } from "@/lib/ai/gateError";
import { getCapUsd, capIsLocked, recordAskUsage, monthStartIso } from "@/lib/ai/usageServer";
// …replacing line 303's `const [spentUsd, cap] = await Promise.all([...]);`
let spentUsd: number | null;
let cap: number;
try {
  [spentUsd, cap] = await Promise.all([monthSpendAllOps(orgId, user.id), getCapUsd(orgId, user.id)]);
} catch (e) {
  // GOV-4: a cap table that cannot be read refuses the AI step, never the free answer.
  if (!isAiUsageUnavailable(e)) throw e;
  return NextResponse.json({
    positions: [...found.values()], notOnPage: trulyAbsent, elsewhere,
    skipped: `${(e as Error).message} The sheet still opens at the right page.`,
  });
}
// (the existing `if (spentUsd === null) { … }` stays as it is)
// GOV-3: a $0 cap locks. It is refused before the first call, at $0 spent too:
// monthSpendAllOps has no lock floor, so overCap alone admits it.
if (capIsLocked(cap)) {
  return NextResponse.json({
    positions: [...found.values()], notOnPage: trulyAbsent, elsewhere,
    skipped: "Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it — the sheet still opens at the right page.",
  });
}
```

(Replacing `monthSpendAllOps` with I-05's `getMonthUsage(...).spentUsd`,
which counts every op and carries the floor, would also close (b). It would
not close (a). It is I-07's call; either way (a) needs the catch.)

**I-07's test file changes with it.** `lib/__tests__/intelRoundGDrawingRoutes.test.ts`
mocks `@/lib/ai/usageServer` whole. Its mock gains
`capIsLocked: (c: number) => c <= Number.MIN_VALUE`. Its `getCapUsd`
default, `vi.fn(async () => 0)`, and the `beforeEach`'s
`mockResolvedValue(0)`, become a figure the scripted calls never reach,
such as `1000`. With I-05, `getCapUsd` never answers 0: 0 meant "no cap",
and it is now the lock. Tests, with I-07's route:

1. A vision-read sheet, a key on file and a signed agreement, with
   `getCapUsd` rejecting with `new GovernedCallError("AI usage can't be read
   right now, so AI calls are refused until it can (down).", 503,
   { usageUnavailable: true })` (from `@/lib/ai/gateError`, not mocked).
   Expect 200, with the text-layer `positions`, `notOnPage` and `elsewhere`
   intact, and `skipped` carrying "AI usage can't be read right now". There
   is no provider call and no metering row. Any other error still throws.
2. The same sheet with `getCapUsd` resolving `Number.MIN_VALUE` (a $0 cap)
   and no spend this month. Expect 200 with the free answer and `skipped`
   naming the $0 lock. `ai.calls` is empty and `recordAskUsage` is not
   called. Without the check, the coarse pass is made: one call.

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

**The Voyage "placeholder rate" label — I-02 / I-02b's limb** (`GOV-6`,
`SEM-13`; I-05 fix pass 5). `embeddingRateIsPlaceholder(model)`
(`lib/ai/embeddings.ts`, line 387 at I-05's head) returns true for EVERY
Voyage model, and `/api/knowledge/embed` sends it as `placeholderRate`
(line 144), so the meaning-index panel (`SemanticIndexPanel`) labels every
Voyage estimate "this provider's rate in the app is a conservative
placeholder". Since I-05, `lib/ai/pricing.ts` prices the three Voyage models
the app offers from Voyage's published list (the three named Voyage rows
above the family row), and the ledger charges exactly that. Limb:
`embeddingRateIsPlaceholder` returns false for a model one of those three
rows prices and true only for a Voyage model that falls through to the bare
`voyage-` family row. The tests flip with it: `lib/__tests__/embeddings.test.ts`
(line 297 asserts the lite model is a placeholder) expects false for the
three and true for an unlisted Voyage model, and `embedStatusShape.test.ts`'s
`placeholderRate: true` follows its model.

**GOV-11's interactive-ingest agreement limb — landed in I-05 (fix pass 5);
nothing to re-assign.** `app/api/knowledge/ingest/route.ts` (I-06's, merged)
now reads `ai_key_agreements` for the requester at `AGREEMENT_VERSION`
before it builds the `VisionContext`. Unsigned, or signed an older version,
skips vision only and says so; an unreadable record is never taken as
signed. The census lists the route INLINE, no longer PENDING. Whoever next
edits the route keeps the read (tests: `aiUsageOutageIngest.test.ts`
"GOV-11 — …", `aiGateCensus.test.ts`; `ingestRoute.test.ts`'s seed signs the
agreement). GOV-11 stays OPEN only for flows/read (I-09) and locate (I-07).
*Fix pass 6:* `ingestKnowledgeDocBatch` (`lib/knowledgeIngest.ts`, I-06's,
merged) takes `opts.noVisionReason`, and `visionRetryMessage` takes it as a
third argument. The interactive route passes it when vision was withheld for
the agreement or an unreadable ledger, so a document waiting on AI vision is
parked with that cause, never "Add one in AI settings" for a saved key.
Whoever next edits the engine or the route keeps it (test:
`aiUsageOutageIngest.test.ts`, "a document waiting on AI vision…").
*Fix pass 7* (the seventh review's major): `noVisionReason` now also HOLDS
a page that needs vision. The page is listed in `vision_failed_pages`, like
a provider failure (ING-6), and is never consumed text-only. Consumed, the
document reached 'ready' and nothing read the page once the member signed;
that was a regression from `052271b` for keyed members, and the
`2026-10-v3` re-sign put every member there at deploy.

- The route answers a read-every-page library with vision withheld for such
  a reason without running a batch: 428 with the agreement fields, or 409.
  It writes nothing to the row, so the drain's queue order is untouched.
- The drain's `loadSponsorVision` returns the uploader's `noVisionReason`
  and passes it. The drain holds pages the same way and names that cause on
  the row: the row no longer flips to "Add one in AI settings" on the next
  pass.

Whoever next edits the engine, the route or the drain keeps all three.
Tests: `aiUsageOutageIngest.test.ts`, "GOV-11 / GOV-4 — a page that needs
vision is never consumed text-only…".

**Limb for I-02 / I-02b** (the library page and
`components/providers/KnowledgeIndexIndicator.tsx`, through
`lib/knowledge.ts`'s ingest loop): the ingest route's 428 (read-every-page
library) and its retry-stage 409, for a member who has not signed, carry
`agreementRequired`, `agreementText` and `agreementVersion`, as the ask
route's 428 does. A client that prompts for the agreement on them, records
the acceptance and re-runs indexing closes the loop. Until then the
sentence sends the member to ask any question in Knowledge, which
prompts.

**`20261137` re-creates TWO functions** (I-05 fix pass 3): besides
`org_capability_allows_for` (one CASE row), `capability_policy_write_guard`
from `20261056` with `'ai.manage_caps'` added to its critical list
(`ai.manage_caps` is `critical: true`). A later package that re-creates the
guard starts from `20261137`'s body.

**MERGE notes — I-05's limbs in other packages' files** (I-05 fix pass 11;
the integrator confirms at I-05's merge that no running owner branch
conflicts with them). Each owner that next edits the file keeps the limb:

- `lib/knowledgeIngest.ts` (I-06's, merged; I-06b next). Keep the GOV-4
  catch in the drain's `loadSponsorVision`: an unreadable ledger withholds
  vision only, and the drain goes on. Keep `opts.noVisionReason` and its
  third argument to `visionRetryMessage`. Keep the vision-page hold
  (`visionHeld` → `vision_failed_pages`): a page that needs vision is never
  consumed text-only while the reason can be fixed. Keep the uploader's
  agreement read, which returns that reason.
- `app/api/knowledge/ingest/route.ts` (I-06's, merged; I-06b next). Keep:
  - the GOV-4 catch around `getMonthUsage` / `getCapUsd` (vision skipped,
    never a 500);
  - the GOV-11 read of `ai_key_agreements` at `AGREEMENT_VERSION`, where an
    unreadable record is never taken as signed;
  - `noVisionReason` passed to the batch;
  - a read-every-page library's 428 (agreement fields) or 409, written
    without touching the row.
- `lib/knowledge.ts` (I-02's, merged; I-02b). Keep the additive types:
  `AiUsageSummary` gains `locked` / `calls` / `byOp` / `canManageCaps`.
  Keep `aiUsageLockedReason`. Keep `setAiCap`, which returns the POST's
  answer (`AiCapSetResult`). AI settings types what POST adds beyond that
  (`selfCapUsd`, `selfCapSetByAnother`, `selfCapOwnLowering`, `unchanged`,
  and since fix pass 12 `pinnedAtDefault`) locally, as `CapSetView`, and
  what GET adds (`teamUnavailable`, fix pass 12) as `UsageView`; neither
  touches `lib/knowledge.ts`. The `ownVisionKeyProblem` MERGE GATE above
  still applies.
- `app/api/admin/purge/route.ts` (A&O P7's; N6 edits its status filters).
  Keep `cutoffFor`: the `ai_usage_events` cutoff is never later than
  `monthStartIso()`. Keep the relabelled target and the per-table cutoff in
  the preview and the `DATA_PURGE` row (`purgeLedgerFloor.test.ts`).

**GOV-10 → `GOV-15` at I-05's merge** (integrator's decision, 2026-10-01).
GOV-10 is recorded as a Partial, Status OPEN: the self-raise ban holds for
sequential requests. Races between two or more cap changes in flight are
`GOV-15`, "a cap change is one database transaction", which the integrator
opens with its own package. That package writes one SECURITY DEFINER
function, `search_path` pinned, with DRLS-16's revoke and grant. It locks
the default and override rows, then decides, writes and audits. It
REPLACES the route's app-side machinery: `capChangesSince`, `signedFigure`,
`holdOwnCapAt`, `recheckOwnCap`, the guarded writes, re-reads and
put-backs, and `writeId` / `limitRowId`. It does not extend them. Its
inputs are the residual under GOV-10's "What the race machinery leaves
open" and "Noted for `GOV-15`". One input is a rule to loosen, not
machinery to replace (I-05 fix pass 12): clearing one's OWN override is
refused outright while another holder exists, even when the clear changes
nothing or lowers the cap (an override of $50 another holder set, over a $5
default). At `052271b` that clear was allowed. It is refused only because
racing it against a default raise once deleted the hold the raise had just
written. Inside `GOV-15`'s transaction, allow a self-clear that is not a
raise: the default is read under the same lock. Since fix pass 12 a
self-clear that finds no override answers `unchanged` (200) instead of the
403. The same package (or `GOV-13`'s) moves `readMonthRows` off offset
paging: a keyset cursor on (`created_at`, `id`), or one server-side sum.
That also lifts the 100,000-row read ceiling. Since fix pass 12, a team
ledger past the ceiling leaves the usage GET up (the viewer's own meter and
the default's editor) and says the team view is unavailable
(`teamUnavailable`).

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
