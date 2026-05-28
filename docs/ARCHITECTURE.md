# Manufacturing OS — Architecture Reference

> This document is the persistent output of the Phase 0 stabilization
> audit. It captures: how data flows today, which fields/tables are
> canonical, which are deprecated mirrors, and the known weak points
> that future phases need to be aware of.
>
> Updated only when the architecture itself changes. If a section is
> stale, fix the architecture or fix this document — never both, and
> never neither.

## Stack

- **App framework:** Next.js 16 (App Router) + React 19, TypeScript strict
- **Database:** Supabase (Postgres 15+, RLS enforced)
- **Object storage:** Cloudflare R2 (S3 protocol via `@aws-sdk/client-s3`)
- **PDF rendering:** `react-pdf` 10 (pdfjs 5.x) + `pdf-lib` (stamping) + `fabric` (markup overlays)
- **Auth:** Supabase auth (JWT)
- **Billing:** Stripe (subscription-tier orgs)
- **Deploy:** Vercel (one daily cron for data-export scheduler)

No AI/LLM dependency is installed. No vendor lock-in for search (Postgres `tsvector`).

## Operational entity graph (post-Phase 1)

```
Org
├── OrgMember (role-based access)
├── Plant ── Unit ── System            ← Phase 1, scope hierarchy
├── Library ── Collection ── Document ── DocumentVersion (immutable chain)
│                          ├── Set (DocumentSet — groups sheets)
│                          ├── AssetTag[] (JSONB on document)  ──┐
│                          └── plant/unit/system FKs (nullable)  │
├── Asset (canonical equipment record, by tag_normalized) ◄──────┘
│   └── AssetPhoto (3-state lifecycle: current/needs_verification/superseded)
├── Project ── ProjectMember ── ProjectActivity
│   └── CheckoutSession (optional project_id, mode, lockId, auto-expire)
├── Ticket (drafting workflow: NEW → DRAFTING → … → CLOSED)
│   └── attachments/comments/history (all JSONB on the row)
└── audit_logs (free-form action/resource/details, org-scoped)
```

Phase 0 audit confirmed: **no Hold, Task, or Scheduling entity yet** — those are Phases 5/7.

## Canonical sources of truth

When two places carry the same fact, this table is the tie-breaker.

| Concept | Canonical | Deprecated mirror | Why mirror exists |
|---|---|---|---|
| Current revision label | `documents.rev` | `documents.revision` (column), `DocumentRecord.revision` (TS) | Column kept for back-compat with older client code that may still write both. No live read of `.revision` found in audit. |
| Per-document revision history | `document_versions` rows (immutable, FK to `documents`) | `documents.revision_history` (JSONB array on the document) | JSONB written from `lib/services/DocumentControl.ts:supersedeSheet`. No live read found. Treat JSONB as legacy; do not add new readers. |
| Equipment / tagged asset | `assets` row keyed by `(org_id, tag_normalized)` | `documents.asset_tags` (JSONB array of `{tag,type,category}`) | JSONB is denormalized cache for grids/exports. Canonical lookup is via `lib/assets.getAssetByTag`. |
| Document↔asset membership | `document_assets` join table (one row per (doc, asset)) | `documents.asset_tags` JSONB | Join table is auto-maintained by trigger from the JSONB (and from `assets` INSERT). The JSONB remains the user-facing write surface. Manual links allowed via `source='manual'`. |
| Project↔document membership | `project_documents` join table | (nothing previously) | Auto-populated by trigger on `checkout_sessions.project_id`. `last_seen_at` advances on each touch so "active docs in project X" is a cheap query. |
| Scope (Plant/Unit/System) on a document | `documents.plant_id` / `unit_id` / `system_id` FKs | None today | Phase 1 added; backfill is per-document via admin UI. |
| Audit trail | `audit_logs` table | Various per-table flag columns (e.g. `documents.archived_at`, `document_versions.released_at`) | Flag columns are operational state; `audit_logs` is the immutable journal. Both legitimate; not duplicates. |

## Row-shape contract (Postgres ⇄ TypeScript)

Postgres rows come back snake_case; TS interfaces (`DocumentRecord`, `Asset`,
`DocumentVersion`, etc.) are camelCase. There is no ORM doing this for us.

**Canonical mapper:** `lib/documentRows.ts` (`docRowToDocumentRecord`).
Use it for every new `from("documents").select("*")` call site.

**Legacy inline mappers (pending future consolidation, do NOT add more):**
- `app/(protected)/documents/[libraryId]/page.tsx` (`fromDocRow`, ~L524)
- `app/(protected)/documents/[libraryId]/SetManager.tsx` (`fromDocRow`, ~L107)

`lib/revisions.ts` carries `rowToVersion` for `document_versions` — already
canonical; keep using it.

## Search surface (Phase 2)

All search runs against Postgres `tsvector` columns + GIN indexes —
no external dependency. Indexes are maintained by `BEFORE INSERT/UPDATE`
triggers so callers don't have to think about them.

| Surface | Column | Trigger inputs | Lib function |
|---|---|---|---|
| Documents | `documents.search_tsv` | title, document_number, name, rev, status, tags[], asset_tags JSONB, metadata JSONB | `searchDocuments` |
| Assets | `assets.search_tsv` | tag, tag_normalized, description, location | `searchAssets` |
| Revisions | `document_versions.search_tsv` | revision_label, change_log, moc_reference, source_file_name, issue/change type, signoff names | `searchRevisions` |
| Tickets | `tickets.search_tsv` | ticket_id, title, requester_name, request_type, unit, status, description, drafter/engineer names, search_keywords[] | `searchTickets` |
| Document relationships | (no tsvector) | supersession chain + Phase 1 scope FKs | `findRelatedDocuments` |
| Holds | (no tsvector — structured query, not text) | reason + open/release state + opened_at | `searchHolds` |

**Project-linked filter.** `searchDocuments({ projectId })` joins
through `project_documents` (Phase 1 normalization) in a two-step
read — first resolve doc IDs, then narrow the documents query.
Two round-trips but predictable performance; the alternative
(supabase-js foreign-key embed) doesn't compose with `.textSearch`.

**Synonym extension.** All triggers call `to_tsvector('english', …)`.
To add refinery-specific synonyms ("exchanger" ⇄ "HE", "vessel" ⇄
"vsl"):

1. Create a Postgres synonym dictionary (or `CREATE TEXT SEARCH
   DICTIONARY`).
2. Create a custom config that maps `asciiword` through the synonym
   dict before `english_stem`.
3. Swap `'english'` for the new config name in the trigger functions
   and re-touch each table's watched columns to rebuild `search_tsv`.

We deliberately do NOT ship a default synonym dict — refineries have
site-specific vocabulary and a generic one would create silent
search drift.

## ACL & access enforcement

Two layers, both required for a write to succeed:

1. **Postgres RLS** gates rows by org membership. Pattern: `EXISTS (SELECT 1
   FROM org_members WHERE org_id = <table>.org_id AND uid = auth.uid() AND
   status = 'active')`. This prevents cross-tenant data access only.

2. **Application ACL** (`lib/acl.ts`, `lib/permissions.ts`) enforces granular
   per-row permissions using `AccessControl` JSONB + materialized
   `aclIndex` buckets. Deny rules override allow rules.

Role-based authorization (e.g. "only Admin can delete a Plant") lives in
app code, not RLS — by deliberate choice (`20260605_rls_policies_new_tables.sql`
comment).

## Scheduling layer (Phase 7)

`milestones` table with planned/actual dates and a weight, optionally
scoped to a project or document. The directive forbids building
Primavera, so the schema deliberately excludes:

- dependency edges between milestones (no DAG)
- resource assignments
- working-time calendars
- critical-path flags
- cost (so EVM here is time-only: SPI without CPI)

**Earned-value rollup** is computed client-side via
`lib/milestones.ts:computeScheduleMetrics`:

| Metric | Formula |
|---|---|
| `plannedValue` | Σ weight of milestones with `planned_at ≤ now` |
| `earnedValue`  | Σ weight of milestones with `status='completed'` and `actual_at ≤ now` |
| `spi`          | `earnedValue / plannedValue` (1.0 = on schedule) |
| `forecastEndAt`| If SPI < 1, stretches remaining duration by 1/SPI |

**Ghost overlay.** Imported P6/MS Project rows live in the same
table with `source` ∈ `{p6, msproject, csv}`. Re-import dedupe by
`(org_id, source, external_ref)` partial unique index. **One-way
only** — no bidirectional sync (directive explicit).

**Audit + timeline.** Mutations write `MILESTONE_CREATED /
UPDATED / COMPLETED / MISSED / BLOCKED / DELETED` events through
`lib/audit.ts:logMilestoneEvent`. They use `resourceType='document'`
when the milestone has a document_id (so they show in the document
timeline) or `'project'` when only the project is set. The Phase 3
timeline picks them up automatically via `getDocumentTimeline` /
`getProjectTimeline`.

## Scope consolidation (Phase 6)

`lib/consolidation.ts:findCheckoutOverlaps` detects two overlap kinds
across the org's active checkouts, using the Phase 1 join tables:

| Kind | Source | Signal |
|---|---|---|
| `asset` | `document_assets` — two active checkouts whose documents both reference the same canonical asset | "Both drafting against E-204" |
| `scope` | `documents.system_id` / `unit_id` — two active checkouts on docs with the same tightest scope FK | "Both editing in the Overhead System" |

Deliberately NOT included:
- Same-document overlaps — already handled by `CheckoutSession.lockId` + `activeCollaborators` (the collaborative-session pattern).
- Same-project overlaps — already shown by the grouped view on `/checkouts`.
- Plant-level scope — too broad to be useful signal.

Surfaced on `/checkouts` as a collapsible amber-toned "Coordination
signals" panel above the queue. Each overlap card lists the involved
checkouts with deep-links into the document libraries. Per the
directive, this is **operational intelligence, not automation** —
nothing here auto-merges, auto-releases, or auto-assigns. The signal
is for the human to act on.

## Viewer landscape (Phase 4)

Three distinct viewers, each optimized for one job. They don't share
a base class because their constraints diverge:

| Viewer | Purpose | Rendering | Constraints |
|---|---|---|---|
| `SecureDocViewer` | "View-only" lockdown (no print, no save, no copy) | iframe pointing at a blob URL | Cannot draw on top — pixel access is denied by the iframe boundary. This is by design (security), so the diff feature does NOT extend this viewer. |
| `FullScreenViewer` | Main drawing inspection + markup + download/print | react-pdf canvas with fabric overlay | Pixel-accessible. Hosts the Compare-with-previous-revision diff button (Phase 4). |
| `MultiDocViewer` | Side-by-side review across multiple documents | react-pdf canvases | Future Phase 4 enhancement: per-pane diff against each doc's previous rev. Not wired today. |
| `PdfRevisionDiff` | The diff renderer itself | Off-screen canvases + pixel composite into a display canvas | Single-page-at-a-time with paging nav. Drawings with very different aspect ratios produce noisy diffs — that's real signal (layout changed), not a bug. |

**Two integration points for the diff today:**
- `VersionHistoryPanel` (in the doc inspector) — Compare button on each non-current revision row → diff vs current
- `FullScreenViewer` (main drawing view) — Compare button in the toolbar → diff vs the immediately previous revision (via `supersedes_version_id`, falling back to chronological order)

**No CAD/DWG parsing** — explicitly out of scope. PDFs only.

## Timeline read surface (Phase 3)

Unified historical reads live in `lib/timeline.ts`. The shape is one
type — `TimelineEvent` — with a `kind` discriminator
(`audit | version | project_activity`) and a source-prefixed id
(`audit:<uuid>` / `version:<uuid>` / `activity:<uuid>`) so consumers
can dedupe or link back.

| Function | Sources merged | Scope context |
|---|---|---|
| `getDocumentTimeline` | `audit_logs` (where resource = the doc) + `document_versions` | Plant/Unit/System names resolved once per call, attached to every event |
| `getProjectTimeline` | `project_activity` + `audit_logs` and `document_versions` for documents linked via `project_documents` | Per-event scope not populated; the project itself implies scope |
| `getRevisionChain` | `document_versions` walked in release order, with supersedes/revert pointers preserved | n/a — chain visualization only |
| Holds | `document_holds` rows merged into `getDocumentTimeline` and `getProjectTimeline` as `kind: "hold"` events (HOLD_OPENED / HOLD_RELEASED with duration). HOLD_* audit_logs rows are deduped against the hold rows so the timeline shows the event once with richer detail. | scope inherited from the doc's plant/unit/system |

**Performance.** `audit_logs(resource_type, resource_id, timestamp DESC)`
composite index (`20260611_phase3_timeline_index.sql`) makes the
hot `getDocumentTimeline` read a single ordered range scan instead
of a filter+sort.

**Dedup policy.** Audit and version rows are deliberately NOT deduped
against each other — they carry different facts (actor + reason vs.
file payload + signoffs). Renderers can group by timestamp cluster
if they want a single visual entry.

**Immutability.** All reads. No timeline call writes to audit_logs,
document_versions, or project_activity.

## Audit logging flow

- `lib/audit.ts` is the only entry point: `logAuditAction`, `logFileView`,
  `logFileDownload`, `logCheckoutEvent`, `logRevisionEvent`.
- 37 call sites across app/lib/components.
- Client-side writes use the regular Supabase client with the user's JWT;
  the `audit_logs_insert` RLS policy `WITH CHECK (user_id = auth.uid())`
  validates the actor.
- Server-side writes (Stripe webhook, data-export API routes) use the
  service-role key, which bypasses RLS — `user_id` is recorded but not
  enforced.

**Implication for Phase 9 (AI scratchpad):** any system-emitted audit event
that originates from a non-user context must use the service-role path,
because it can't satisfy the user_id-equality RLS check.

## Storage paths

`lib/storage.ts` is the only writer. Pattern:

```
orgs/<orgId>/libraries/<libraryId>/[<folderPath>/]<filename>
```

Rev-up uploads append `__rev<label>__<epoch>.<ext>` to avoid collision —
the previous file remains readable. See `lib/revisions.ts` and
`scripts/copy-pdfjs-worker.mjs` for the pdfjs worker copy.

## Known weak points (Phase 0 findings)

These are intentionally not fixed in Phase 0 (the directive forbids
"massive refactor"). Each is recorded here so subsequent phases can
plan around them.

1. **Dual `rev`/`revision` fields on documents.** Both written, neither
   reliably read together. `rev` is canonical (see table above).
   Resolution: leave the column, mark TS field `@deprecated`, drop in a
   later targeted refactor.

2. **JSONB `revision_history` on documents duplicates `document_versions`.**
   Written from `lib/services/DocumentControl.ts:supersedeSheet`. No
   reader found. Resolution: stop new writes in a follow-up; do not
   read from it.

3. **JSONB `asset_tags` on documents duplicates the `assets` table for
   tag membership.** This duplication is intentional — the JSONB is a
   denormalized cache for grids/exports and the trigger-maintained
   `documents.search_tsv` (Phase 2) flattens it. Canonical lookup is
   still via `assets`. Document, don't fix.

4. **Inline row mappers** (`fromDocRow`) repeated in two files. Canonical
   `lib/documentRows.ts` added; legacy sites left in place. Migrate
   on touch.

5. **`scripts/copy-pdfjs-worker.mjs` falls back to CDN silently** if
   `pdfjs-dist` isn't present at the expected path. Build still
   succeeds. Acceptable for now; a noisy warning in prod would be
   nicer but is not in scope.

6. **`audit_logs_resource_id_idx` is single-column.** Queries that
   filter on `(resource_type, resource_id)` (which is everything in
   `lib/timeline.ts`) only use the partial-key match. A composite
   index `(resource_type, resource_id, timestamp DESC)` would help.
   Not added in Phase 0 — schema changes are deferred to the phase
   that produces real timeline load.

## File-layout map

```
app/
  (protected)/        ← Authenticated routes (RLS-enforced)
    admin/            ← Admin tools (libraries, users, billing, etc.)
    documents/        ← Library + per-library document grids
    projects/         ← Project list + detail
    requests/         ← Drafting tickets
    workspace/        ← Personal queue / dashboard variant
  api/                ← Server routes (service-role keyed)
    admin/, auth/, data-export/, notifications/, storage/, stripe/
components/
  assets/             ← Equipment-tag + photo UI
  documents/          ← Document inspector / wizards / modals / version history
  drafting/           ← AdvancedRedlineEditor (markup surface)
  viewers/            ← FullScreenViewer, SecureDocViewer, MultiDocViewer, PdfRevisionDiff
  navigation/, permissions/, projects/, providers/, requests/, subscription/, ui/
lib/
  acl.ts, permissions.ts          ← granular ACL
  audit.ts                        ← single audit entry point
  consolidation.ts                ← Phase 6 checkout-overlap detection
  documentRows.ts                 ← canonical Postgres-row → DocumentRecord
  holds.ts                        ← Phase 5 document holds CRUD + metrics
  milestones.ts                   ← Phase 7 milestone CRUD + earned-value rollup + ghost import
  operationalGraph.ts             ← Phase 1 plants/units/systems CRUD + join-table reads
  revisions.ts                    ← rev-up / revert / supersede / archive
  search.ts                       ← Phase 2 tsvector reads + Phase 5 hold-state search
  timeline.ts                     ← Phase 3 unified history read (incl. Phase 5 holds)
  services/DocumentControl.ts     ← supersede-sheet workflow
  storage.ts, r2.ts, downloads.ts ← file uploads + presigned download
  projects.ts, assets.ts, collections.ts, libraryCollections.ts
  notifications.ts, markupRequests.ts, exportRunner.ts, dataExport.ts
  workflow.ts                     ← ticket state machine
supabase/
  schema.sql                      ← cumulative create-from-scratch reference
  migrations/                     ← dated, header-commented, additive
types/
  schema.ts                       ← all shared TS interfaces
```

## Deploy invariants

The directive requires every commit to leave the app:

- buildable, testable, deployable
- runnable locally and in Vercel
- tolerant of missing optional env vars

Concrete consequences observed in code:

- `next.config.ts` is empty (no fragile webpack tweaks).
- `vercel.json` wires one daily cron at `/api/data-export/run-scheduled`.
- `scripts/copy-pdfjs-worker.mjs` is idempotent and falls back to a CDN
  if `pdfjs-dist` isn't present at build time.
- Stripe webhook returns 503 if `STRIPE_WEBHOOK_SECRET` is missing
  rather than crashing.
- No top-level imports throw on missing env vars in lib/ (verified by
  Phase 0 audit).

Any new feature that breaks one of these invariants should be reverted
or feature-flagged.
