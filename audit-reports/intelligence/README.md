# Intelligence layer — audit area

Read-only audit of the Intelligence layer end to end — knowledge ingestion, ask
and retrieval, embeddings, AI governance, the org graph, link proposals, the Site
Codebook, the equipment Bridge, operating areas, process flows, drawing
intelligence and the orchestrator — **plus the document section's permission
boundary**, which was asked about directly.

**81 agents across two workflows.** Twenty audit lenses each put through
adversarial refutation, five intent lenses, eight design lenses, six "what does he
need that he did not ask for" lenses, fourteen critiques and three syntheses.

**No application code, test, or migration was modified at any point.**

---

## ⚠ Before you touch anything

1. **Read [`../README.md`](../README.md)** — the resolution protocol — and
   [`../DECISIONS.md`](../DECISIONS.md).
2. **Read [`99-fix-sequencing.md`](./99-fix-sequencing.md).** This area has
   **three redo-pairs** — three places where building B before A means undoing B.
   One of them is a two-line migration that everything else depends on.
3. **Read the top of [`90-gap-register.md`](./90-gap-register.md)** before
   designing anything. Thirty agents converged on one sentence and it reframes
   most of what looks like a missing feature.

---

## The one idea

> **Every screen in this app works out something true about the plant and then
> throws it away on the way out the door.**

When the app ingests a P&ID it decodes which operating unit the drawing belongs to
using your own numbering standard; reads the title block and knows it is looking
at SHT 4; finds the equipment tags and knows which page each was on; creates the
missing assets filed under the right unit and type. **All of that happens today,
correctly, in one function.** Then in the last twenty lines it writes a
comma-joined list of tag strings into one JSONB key on one document and discards
the rest.

The proof, in one line:

```tsx
// app/(protected)/assets/[tag]/page.tsx:51-56
.contains("asset_tags", [{ tag }])
```

**The asset hub never reads `document_assets`.** So after a sweep that worked
perfectly, the vessel's own page says it appears on no drawings.

It is not a missing brain. It is a missing memory.

---

## Findings

**258 findings** — 13 CRITICAL, 71 HIGH, 174 MEDIUM — plus **12 gap specs**.

| # | Report | n | Focus |
|---|---|---|---|
| 01 | [Ingestion](./01-ingestion.md) | 12 | PDF → chunks, and what is lost on the way |
| 02 | [Ask & retrieval](./02-ask-and-retrieval.md) | 11 | Ranking, grounding, citation verification, the injection surface |
| 03 | [Semantic layer](./03-semantic-layer.md) | 13 | Coverage, drift, chunks that never embed |
| 04 | [AI governance](./04-ai-governance.md) | 14 | Keys, allowlist, metering, calls that bypass governance |
| 05 | [**Knowledge ACL**](./05-knowledge-acl.md) | 11 | **Your leak question, half one** |
| 06 | [**Document ACL leaks**](./06-document-acl-leaks.md) | 12 | **Your leak question, half two** |
| 07 | [Graph model](./07-graph-model.md) | 14 | Every edge, every cap, what is not modelled |
| 08 | [**Graph pivots**](./08-graph-pivots.md) | 14 | **Your pivot complaint**, traced to the render layer |
| 09 | [Link proposals](./09-link-proposals.md) | 13 | Candidate generation, false positives, who may accept |
| 10 | [Codebook](./10-codebook.md) | 10 | The decoder everything else depends on |
| 11 | [**The Bridge**](./11-the-bridge.md) | 14 | **Your equipment question**, step by step |
| 12 | [Operating areas](./12-operating-areas.md) | 11 | Whether giving an area a drawing fills it |
| 13 | [**Process flows**](./13-process-flows.md) | 14 | **Your PFD question** |
| 14 | [Drawing intelligence](./14-drawing-intelligence.md) | 13 | Extraction, OPC refs, tracing, revision staleness |
| 15 | [Orchestrator](./15-orchestrator.md) | 11 | The highest-privilege AI surface |
| 16 | [Persistence & RLS](./16-persistence-rls.md) | 12 | Table by table |
| 17 | [Hub UX](./17-hub-ux.md) | 12 | What a new org sees; whether the numbers are real |
| 18 | [Lifecycle](./18-lifecycle.md) | 13 | Export, restore, delete, orphans |
| 19 | [Wiring](./19-wiring.md) | 10 | De-facto links, dead FKs, one-directional joins |
| 20 | [Prompts](./20-prompts.md) | 12 | Every prompt read as a contract |
| 21 | [Edges & invariants](./21-edges-and-invariants.md) | 12 | ⚠ **unverified** — the critic, plus what is sound |
| 90 | [**Gap register**](./90-gap-register.md) | 12 specs | `GAP-301`+ |
| 99 | [**Execution order**](./99-fix-sequencing.md) | — | Binding. Three redo-pairs |

**`01`–`20` were adversarially verified** — 273 raw findings, **246 survived**,
27 refuted and dropped. Several severities were lowered by that pass and the
lowered value is what is recorded. **`21` was not verified** and says so in-file.

Each report opens with a **substrate table** — what already exists, works, or is
load-bearing. That is deliberately as prominent as the defects, because in this
layer most of what looks absent is half-built.

---

## Direct answers

### "Does the document section create role and permission leaks?"

Two reports, [`05`](./05-knowledge-acl.md) and [`06`](./06-document-acl-leaks.md),
because the question has two halves and the sharper one is the knowledge boundary:
when a controlled document is mirrored into a knowledge library and indexed, does
its ACL still hold **at query time**, or only at link time? Work those in severity
order; they gate nothing else, so a second agent can take them in parallel.

### "Is the graph comprehensive enough? The sections are labelled weird."

The labels are a symptom; the cause is that **the four lenses are node-type
subtraction presets** (`graph/page.tsx:428-433`). "Process" does not mean a
process view — it means *everything except paper*. That is why it does not fit.
And asset nodes are labelled `"Equipment"` (`:46`) while a lens is also called
"Equipment ↔ Docs", so the word means two things on one screen.

[`07`](./07-graph-model.md) answers comprehensiveness structurally — every entity
classified IN / COULD-BE / SHOULD-NOT-BE, with the question each missing edge
would answer.

### "I can't do extreme pivot views — crude unit, all this goes here."

**Three reasons, and the third is the one that matters.**

1. There is no scope dimension. `GraphSettings` has type filters, colour groups
   matched against node **labels**, and node-centric BFS. No containment.
2. `orgGraph.ts:114` SELECTs `unit_code, unit_id` for every asset and
   `GraphNode` (`:37-44`) is `{id, type, label, sub, href, degree}` — **the unit
   is loaded and dropped one loop later.**
3. **`unit:<uuid>` and `cbunit:<code>` are two unconnected nodes.** `:190-194` and
   `:197-203`, adjacent loops, no edge. Two independent searches confirmed nothing
   anywhere joins a codebook code to a `units` row. **Your crude unit is genuinely
   two dots**, and focusing one can never show the other's drawings.

`GAP-305` before `GAP-306`, or the pivot scopes to half a unit convincingly.

### "If I upload a PFD can it read it well enough to link flow to flow?"

Yes, and it is properly grounded — the model may only connect assets already in
the registry plus codebook units, so a hallucinated vessel cannot enter the
topology. **But it cannot create equipment**, it is capped at `MAX_PAGES = 6`, and
its authority is hardcoded to `["Admin","DocCtrl"]` — a facility-vocabulary
violation under `DEC-35`. [`13`](./13-process-flows.md).

### "Does a PFD / P&ID / master Excel list populate equipment in the operating areas?"

**Partly, through one door, and the result is not wired to anything that would
show you.**

- The Bridge is gated: `if (!kdoc?.source_document_id) return null`
  (`equipmentBridgeServer.ts:56`). A P&ID uploaded to a knowledge library indexes,
  is askable, appears in the census — **and builds nothing.**
- `if (!targetKey) throw` at `:190-193` sits **above** the discovery block at
  `:197-234`. **No mapped column means zero assets created**, though discovery has
  nothing to do with the column.
- `lib/xlsxData.ts parseWorkbook` **is in production** — wired only to templates.
  The asset importer is paste-only CSV with `CANONICAL_FIELDS = [tag,
  description, location, type]` — **no unit, no code.** Your master list lands
  undecodeable, which is the one thing the codebook exists to prevent.

### "See what equipment goes to what sheet, and tag per sheet"

**The sheet address is already extracted and one predicate throws it away.**
Per-page title-block identity is written at ingest as `kind: 'self'`, formatted
`"<DWG>-SH<n>"` (`knowledgeIngest.ts:281-292`). The Bridge reads the same table
one predicate too narrow — `.eq("kind", "equipment")` at `:64` — excluding the
sheet identity sitting on the same pages.

Tag→sheet resolution is **also already computed**, inline in the chat answer route
(`ask/route.ts:991-995`), and thrown away when the answer scrolls off.

`GAP-301`. Effort **S**. It costs zero additional model calls.

### "How smart, how wired, how helpful can we make this?"

See the top of the gap register. The honest answer is that the intelligence is
mostly there and the **memory** is not — and that the ceiling is set by provenance
discipline, not by model capability. In a PSM-regulated system the most valuable
thing this layer can do is be *checkable*, and the second most valuable is to stop
throwing away what it already knows.

---

## What you did not ask for, that survived a critic

Every one of these had to be traceable to your own words or to a mechanical fact
about your workflow, or it was cut. Full specs in the gap register.

| | Why it is invisible from where you sit |
|---|---|
| **The coverage report** (`GAP-308`) | You are picturing the import as an event that works or does not. What follows is a mostly-right 400-row register whose wrongness is invisible. |
| **Notice when a tag *leaves* a sheet** (`GAP-309`) | The Bridge only ever adds. Every sweep you have run made the registry bigger, so the loss is invisible by construction. |
| **Which revision a derived fact was read from** (`GAP-303`) | Revision control is the part of the app you trust most. It would not occur to you that the layer sitting on top of it does not participate in it. |
| **Verification is a queue with one person in it** | You are the admin *and* the QA/QC, so it does not feel like a queue. By your own principle — waiting on a person is failure — it is one. |
| **Your decoder also generates and judges** (`GAP-305`, `GAP-310`) | You called it a decoder, so you think of it as a thing that reads. It can also propose the next legal tag and rule that a tag is illegal. |
| **Tag lookup in ⌘K** (`GAP-311`) | You asked about the Intelligence tab, so you reason about intelligence as a place. The palette is not in that tab and looks like search. |
| **The drafting request has no equipment field** (`GAP-312`) | You audited the Intelligence tab. The request form is Document Control furniture you built early and stopped seeing — yet it is where the wait is born. |

---

## Method & limits

- **81 agents.** Audit lenses were adversarially refuted; design proposals went
  through a product critic empowered to `CUT`, and eight were cut. The
  intent-phase findings fed forward into the design phase so designers built on
  decoded jobs rather than re-reading the prompt cold.
- A **coherence check** ran over the surviving proposals against your binding
  constraints and caught two real violations — a proposed keyword lexicon that
  would have been the first facility vocabulary ever admitted to `lib/`, and a
  "cheap" graph fix that infers an edge at render time and would have failed a
  guard test another agent proposed in the same run. Both are recorded in the
  sequencing file's `Do not` table.
- **No live database, no browser, and no AI provider.** Deterministic parsers,
  RLS policies and call graphs are read from code and are exact. **Nothing about
  model output quality was observed** — every such claim is `SUSPECTED`.
- The table-chunking finding in [`01`](./01-ingestion.md) was demonstrated by
  transcribing the functions and executing them on both the production and test
  paths. Strong evidence, but not the running system — re-run it before changing
  the chunker, because the fix touches every chunk boundary in the corpus.
