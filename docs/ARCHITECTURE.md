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

## Defensive input layer

Two primitives in `components/ui/` + `lib/`:

- `lib/inputValidation.ts:translatePostgresError(err, ctx)` — converts
  raw Postgres error codes (23505 unique-violation, 23503 FK, 23502
  not-null, 23514 check, 42501 permission, 42P01 missing table) into
  plain-language `FriendlyError` objects with a heading and an
  actionable next-step message. The only place in the codebase that
  knows what those codes mean.
- `components/ui/DuplicateAwareInput.tsx` — debounced (300ms)
  live duplicate-check on a single column. Spinner while checking,
  green check when available, amber warning + "Edit existing" deep-
  link when duplicate. Reports state via `onDuplicateChange` so
  forms can disable Submit when a conflict is detected.

Applied:
- Asset Registry tag (`assets.tag_normalized`, scoped to `org_id`)
- Operational Scope code field (`plants.code` scoped to `org_id`,
  `units.code` scoped to `plant_id`, `systems.code` scoped to
  `unit_id`)
- **Document number on SplitWizard targets and MergeWizard "create
  new" target** (`documents.document_number` scoped to `library_id`).
  Backed by partial UNIQUE index added in migration 20260618 —
  excludes Archived/Superseded so retired numbers can be reused.
- Friendly-error translation wraps every `catch` that previously
  surfaced raw Postgres messages, including the document upload path

Design intent: prevent the 23505 typo problem **before** submit, and
when a conflict still slips through, render a translated message
instead of database internals. Adding the same primitives to project/
milestone/document creation is straightforward — every form that
mutates a unique-constrained column should use them.

## Contextual guidance (Phase 10)

Two lightweight primitives in `components/ui/`:

- `HelpTooltip` — small `?` icon next to a confusing label. Click
  opens a popover with plain-language explanation. Click-outside or
  ESC closes. Used for terms like MOC, SPI, scope FKs, ghost
  milestones, hold reasons.
- `FirstRunHint` — dismissible blue banner at the top of an
  unfamiliar surface. Stores a `first_run_hint:<key>` flag in
  localStorage. Once dismissed, never returns — per the directive&apos;s
  &ldquo;don&apos;t interrupt experienced users&rdquo; rule.

Applied surfaces (current as of Phase 10 close-out):

| Surface | Treatment |
|---|---|
| `ModifyDocumentRouter` | `FirstRunHint` re: reversibility |
| `SplitWizard`, `MergeWizard` | `FirstRunHint` re: undo; MOC + carry-over `HelpTooltip`s |
| `HoldStrip` | "What is a hold" + per-reason `HelpTooltip`s |
| `ScheduleTab` | Intro hint; EV / SPI / Ghost tooltips |
| Whiteboard page | Intro hint re: click semantics |
| `VersionHistoryPanel` header | Compare / Revert / Backfill explained |
| `HistoryDrawer` header | Timeline / Revision History / Checkout Log / Audit Log distinctions |
| `CheckoutsPage` header | Project vs ad-hoc vs collaborative-session |
| `InspectorPanel` | Rev label + Status enum explained |
| Project page tabs | Documents / Activity / Schedule / Members |
| `/admin/holds`, `/admin/scope`, `/admin/assets` | Empty states teach the concept |

Surfaces deliberately left alone (would be over-doing it): admin
analytics / billing / users / data-export — UI labels are
already self-evident; tooltips would interrupt experienced users.

## Notes / Operational Memory (Phase 9 — manual)

One table: `notes`. Free-text `body` with optional scope FKs
(`document_id`, `project_id`, `asset_id`) so a note can attach to any
combination of those. RLS by org-member-all.

**Tasks are extracted from markdown checkbox syntax at read time**,
never denormalized into a separate table:

```
- [ ] open task
- [x] completed task
```

`lib/notes.ts` exposes `extractTasks(note)` and `toggleTaskInBody(body,
lineIndex)` — toggling a task rewrites the markdown in the body. The
body is the source of truth; no trigger-maintained mirror.

UI: `QuickNoteComposer` — the contextual capture box on asset pages,
project pages, and the document inspector. Notes live where the work
lives; there is no standalone notes page. (The former /scratchpad page,
its inbox strip, dashboard widget, task-reminder watcher, and browser
push reminders were removed in the 2026-08 cleanup — they formed a
separate personal-productivity system that pulled focus from the
document-control core.)

**No AI dependency.** Notes are plain data. The only AI in the
platform is the governed Knowledge Libraries stack (see below):
per-user keys, recorded agreements, metered usage. The former
`lib/ai` provider seam (mock/Gemini providers, CopilotRail,
draft-with-AI buttons) was removed in the same cleanup — its mock
fallback presented deterministic heuristics as AI output, which is
worse than no feature.

## Turnaround whiteboard (Phase 8)

`assets.whiteboard_state` column carries one of five operational
states for each equipment item:

| State | Tone | Meaning |
|---|---|---|
| `pending` | slate | Not yet started. Default for new assets. |
| `drafting` | blue | Documents being authored / redlined. |
| `executing` | amber | Work happening in the field. |
| `completed` | emerald | Done; sign-off captured. |
| `blocked` | red | Progress blocked. Out of the click-to-advance cycle. |

`lib/whiteboard.ts`:
- `listEquipmentForWhiteboard({orgId, plantId?, unitId?, systemId?, state?, search?})` — the board's primary read
- `getStateCounts(scope)` — sidebar metric
- `setEquipmentState({asset, newState, reason?, actor})` — flips the column + fires `EQUIPMENT_STATE_CHANGED` audit event (resource_type='asset' to avoid bleeding into document timelines)
- `nextState(current)` — the click-to-advance lookup
- `ADVANCEABLE_STATES` excludes `blocked` (side branch picked deliberately)

Indexed by `(org_id, whiteboard_state) WHERE archived = false` so
the board's "all active equipment in this state" query is a single
ordered range scan.

**Plot-plan / P&ID overlay** (the directive's other Phase 8 verb)
is deferred. The column model supports it — you'd add a separate
`equipment_positions` table keyed on a plot-plan image asset id —
but the grid view ships first to nail the operational verbs (state
visibility + one-click change).

## Document lifecycle workflows

A single entry point — **"Modify Document…"** in the InspectorPanel
(`components/documents/lifecycle/ModifyDocumentRouter.tsx`) — branches
to every lifecycle workflow. Power users can still hit the
individual modals directly via the existing buttons; the router is
the curated unified surface.

Branches:

| Action | Modal | Description |
|---|---|---|
| Update revision | `RevUpModal` (existing) | Single forward rev-up |
| Split document | `SplitWizard` (new, 3 steps) | 1 → N new docs; per-target asset distribution + carry-over toggles |
| Merge documents | `MergeWizard` (new, 3 steps) | N sources → 1 target (new or extend existing); tag union with dedupe |
| Renumber | `RenumberModal` (new) | Change document_number with audit; revisions preserved |
| Backfill rev | `BackfillVersionModal` (existing) | Historical rev that does NOT advance current |
| Retire (no replacement) | `ArchiveConfirmModal` (existing) | Mark Archived |
| Retire with replacement | `SupersedeModal` (existing) | Link to pre-existing replacement docs |
| Set-level rev-up | `SetRevUpModal` (new) | Batch rev-up of every active sheet in a set |

### Selective reversal ("undo")

Every transformative lifecycle op (Split, Merge, Renumber) is
reversible from the document's timeline. Click the **Reverse** button
next to the audit event → confirmation modal → compensating action.

**Compensating actions, not hard deletes.** Reversing a split does
*not* delete the new docs — it marks them Superseded with reason
"reverted_split" and restores the source to Issued. This preserves:

- Audit immutability (a PSM audit can reconstruct what happened)
- Derivative work done on the new docs before the reversal
- The `document_supersessions` lineage (the join rows ARE removed
  from the table but the original audit row retains the relationship)

**Scoped to one operation.** Each `reverse*` function takes a
specific audit-event id as its anchor. The audit's `details` carries
the exact doc IDs that were touched, so undoing one split cannot
accidentally undo a different operation done on the same docs later.

| Operation | Reverses by | Lib function | Audit event |
|---|---|---|---|
| Split | Audit event id of `DOC_SPLIT` on source | `reverseSplit` | `DOC_SPLIT_REVERSED` |
| Merge | Audit event id of `DOC_MERGED` on any source | `reverseMerge` | `DOC_MERGE_REVERSED` |
| Renumber | Audit event id of `DOC_RENUMBERED` | `reverseRenumber` | `DOC_RENUMBER_REVERSED` |

**Derivative-work warnings.** Before committing, each `reverse*` runs
a quick query for audit events that happened on the affected docs
*after* the original operation (check-outs, rev-ups, downloads,
hold-opens). The confirmation modal surfaces these as warnings — the
user can still proceed, but they know what's about to be parked.

Beyond a forward rev-up, four operations transform document identity:

| Operation | `lib/documentLifecycle.ts` fn | Source state | Audit on source | Audit on target(s) |
|---|---|---|---|---|
| Split (1 → N) | `splitDocument` | Superseded | `DOC_SPLIT` | `CREATED_FROM_SPLIT` |
| Merge (N → 1) | `mergeDocuments` | Superseded (each) | `DOC_MERGED` (each) | `CREATED_FROM_MERGE` |
| Renumber | `renumberDocument` | Active (number changes) | `DOC_RENUMBERED` | — |
| Set-level rev-up | `setLevelRevUp` | Active (N rev-ups) | `REV_UP` per sheet | — |
| | | | `SET_REV_UP` on the set | |

All four use the existing `document_supersessions` join table (no
new schema). Each operation explicitly handles side effects:

- **asset_tags**: caller passes per-target distribution (split) or
  union (merge). We never guess.
- **active holds**: optional carry-over with origin note added to
  the copy. Defaults true.
- **project_documents**: optional carry-over of membership rows.
  Defaults true.
- **scope FKs (plant/unit/system)**: copied from source by default;
  merge inherits only if every source agrees.
- **document_sets.sheet_count**: not auto-recomputed — the existing
  SetManager UI is the authority.

Deliberately not handled by these ops:
- **PDF cross-references inside other drawings** — content-internal
  callouts ("see Sheet 3") can't be auto-rewritten. The UI surfaces
  "N other docs reference this number" as a warning before commit.
- **Revision history continuity** — new docs start fresh at the
  caller's chosen rev label. The source's full history stays under
  Superseded status, linked via `document_supersessions`.

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

## Publish contract, intent layer & signal ladder (2026-07 redesign)

Design doc: `docs/CHECKOUT_REDESIGN_PROPOSAL.md` (v2), findings in
`docs/CHECKOUT_SYSTEM_REVIEW.md`. Three subsystems:

### Publish contract (`publish_revision` RPC, migration 20260823)

Every content publish (rev-up / revert) runs through one transactional
Postgres function, serialized per-document by `SELECT … FOR UPDATE`:

- The caller declares `expected_base` — the revision the work was built
  on. Resolution order in `lib/revisions.ts`: active checkout session →
  freshest live edit intent → the RevUpModal's explicit "Based on
  revision" picker.
- Stale base ⇒ **nothing is written**; the RPC returns `stale_base` and
  the modal switches to the conflict screen (visual diff via
  `RevisionDiffModal`, message-the-author via the activity thread, or
  publish-as-branch).
- "Publish anyway" = **branch**: the version row is written with
  `is_branch = true`, never promoted, and an open `revision_branches`
  row is created — debt that is resolved (`merged`/`withdrawn` + note),
  never dismissed. Queue surfaced in `DocControlQueue` on /coordination's Document-flow view.
- Partial unique index `document_versions_active_label_uniq` makes
  duplicate active labels impossible even if all else fails.
- Pre-migration environments degrade to the legacy 3-step client path
  (flagged via `resetPublishRpcFlag` pattern, same as episodes).

### Intent layer (`document_intents`, migration 20260824, `lib/intents.ts`)

Ambient "who is working on what, from which revision", captured
fire-and-forget at every touchpoint: viewer open (`view`), download/print
(`reference`, or `edit` when the actor holds the checkout), checkout
(`edit`, pinned), ticket entering DRAFTING (`edit`, via the
workflow-action route), source pull (`edit`). Rows decay via
`expires_at` (pruned by the maintenance cron) — signal, not audit.
`base_version_id` feeds the publish contract and the edit×edit overlap
advisories (`EditOverlapBanner`; views never trigger overlaps).

### Signal ladder (interruption budget)

| Rung | What | Where |
|---|---|---|
| Ambient | lock banner in FullScreenViewer/SecureDocViewer; rev-at-issue + active-change warning stamped on uncontrolled copies | zero-click |
| Advisory | edit×edit overlap banners (library page + /checkouts), manual "send heads-up" (in-app only) | dismissible |
| Interrupt | stale-base conflict modal; `checkout_released` (force-release / auto-expiry), `doc_superseded`, `branch_open/resolved` via `emit()` (in-app + email) | rare, personal |

Stale checkouts escalate: 7d holder nudge (existing) → 14d DocCtrl
queue + notification (maintenance cron, deduped per session id).
Provenance (`session`/`declared`/`unverified`) is a property of the
revision — unverified ones land in the DocCtrl queue for one-click
verification; there are no per-user scoreboards by design.

One-click **Quick hold** (`quickHold` in `lib/checkoutEpisodes.ts`, ⚡
button in `CheckoutStatusCell`) is the friction-free checkout tier:
auto-expires end of day, upgradeable to the full purpose+reason flow.

Source custody: RevUpModal accepts the native DWG/zip alongside the PDF
(`document_versions.source_file_key`); InspectorPanel's "Get CAD source"
pulls it and records an edit intent pinned to that revision.

### Closed-loop utilities (2026-07, second wave)

| Utility | Mechanism |
|---|---|
| **QR print verification** | Every uncontrolled copy is stamped with a QR (`lib/stamping.ts` + `qrcode` dep) linking to the public, unauthenticated `/verify/[docId]?v=` page (`app/api/verify` — service role, revision-status facts only, UUID-gated). A phone scan answers "is this paper current?" with a full-screen green/red verdict. |
| **Where-used impact** | `lib/impact.ts` + `ImpactPanel` in the inspector: sibling docs via shared `document_assets` (mid-change first), open tickets raised from the doc, active holds, projects, open branches. |
| **Stale-copy recall** | `lib/staleCopies.ts` joins `download_audits` against `current_version_id`. Per-doc `DistributionRecall` in the inspector ("3 of 5 outdated" + one-click recall via `doc_superseded`); personal list in My Desk. The formerly write-only download log now closes the loop. |
| **My Desk** | `MyDeskPanel` on /inbox right rail: my checkouts (clock + one-click release), my stale copies, my unresolved branches. |
| **Protection record** | `ProtectionRecord` on /coordination's Document-flow view: 90-day counts of `REV_CONFLICT_BLOCKED` (logged by `revUpDocument` on every stale-base stop), branches opened/reconciled, auto-releases, flagged publishes. |

### Field-execution layer (2026-07, third wave — migration 20260825)

| Utility | Mechanism |
|---|---|
| **Work packages** | `/packages` (+ Documents→Packages tab): a job's document set with revisions pinned at assembly (`work_packages` + `work_package_documents`). Freshness computed at read time (pin vs `current_version_id`); publishing a member doc notifies every open package's owner via `notifyPackagesOfRevUp` (wired into `revUpDocument`). "Refresh pins" re-pins after review. A tripwire, never a lock. |
| **Acknowledged distribution** | `distribution_acks` (one row per version×recipient). Controllers request confirmations from picked members (`DistributionAcks` in the inspector); recipients get an unmissable "I have this revision" bar; progress reads "8 of 12 confirmed" with one-click reminder. |
| **Doc packs** | Asset hub "Print doc pack" (`lib/docPack.ts`): merges the current revision of every drawing on the tag into one stamped PDF — per-document footer + verify-QR on every sheet, download-audited and intent-captured per document. |
| **Title-block ingest** | `lib/titleBlock.ts` / `titleBlockHeuristics.ts`: the upload staging modal now reads page-1 PDF text and fills drawing numbers + revisions the filename didn't carry (confidence-gated; user edits always win). |

### User identity / avatars (2026-07 — migration 20260826)

One avatar contract app-wide, enforced by `components/ui/UserAvatar.tsx`:
photo if the person uploaded one (`users.avatar_path`, resolved to a
signed URL like the org logo), else initials from their display name
("Grant Getzfrid" → GG), else the email local part ("grant.getzfrid" →
GG) — never a role letter. `lib/userProfiles.ts` batches + caches
profile reads (`users_shared_org_select` policy lets members of a
shared org see each other's name/avatar; writes remain self-only).
Upload/remove lives on /profile. Do NOT hand-roll initials again —
use UserAvatar.

The Sidebar was cleaned in the same pass: dead nested-group machinery
deleted, the header contract rewritten to match reality, `TOOL_ALIASES`
now DERIVED from the ViewTabs `*_VIEWS` arrays (one source of truth for
tool highlighting), and the duplicate
org-wide badge dropped (the header bell owns the total).

### QR / physical-bridge suite (2026-07, fourth wave — no migration)

`components/ui/QrBadge.tsx` (screen QRs) + `lib/physicalBridge.ts`
(printable PDFs: pdf-lib + qrcode). Frictionless rule: every artifact is
one click from data the app already has; every scan lands on a live
answer.

| Artifact / surface | Scan lands on |
|---|---|
| Equipment QR labels (asset hub single; admin registry bulk sheet, Avery 5163) | `/assets/[tag]` — drawings, holds, doc pack, **Report a problem** (pre-filled ticket via existing `?title=&description=` params) |
| Hold cards (HoldStrip "Card" button, red half-letter tag) | `/verify-hold/[holdId]` — public red HOLD ACTIVE / green RELEASED verdict (`/api/verify-hold`, service-role, minimal facts, UUID-gated) |
| Package cover sheets ("Print pack" on /packages: cover + merged stamped current revs; pins auto-refresh to match the paper) | `/packages?pkg=` — highlighted live FRESH/STALE card |
| Ticket travelers (/requests/[id] "Traveler" one-pager) | `/requests/[id]` live status |
| Continue-on-phone (viewer toolbar "Phone" popover) | the same document URL on the phone |
| Share-link QR (ShareLinkModal per-link toggle) | the public `/share/[token]` page |

### Implementation-hardening pass (2026-07, migration 20260828)

The full-system audit ("is each feature actually applied end-to-end?")
drove a hardening pass:

- **Compliance clocks run server-side**: the six scans (review cycles,
  read-&-understood, pre-publish review, effective dates, retention,
  access recerts) + a distribution-ack nag run from
  `/api/cron/maintenance` under the service role per org (via
  `__setServerSupabaseClient`), with per-scan error reporting — no longer
  a browser effect gated on a controller's tab.
- **One post-publish pipeline** (`lib/postPublish.ts`): every path that
  changes the current revision (rev-up, revert, review-finalize) runs the
  same stale-copy signals, package alerts, and compliance clocks; the
  last reviewer signature auto-finalizes; set rev-ups honor the review
  gate; `docRowToDocumentRecord` maps all governance fields; `hardGate`
  actually blocks downloads pending acknowledgment.
- **Copy leaks sealed**: share links resolve via service-role
  `/api/share/resolve` and download stamped; ticket prints are stamped +
  audited; book/markup/print-all carry verify QRs; audits resolve
  `version_id`; travelers + package covers scan to public verify pages
  (`/verify-package/[id]` is new); `/api/verify` honors effective dates
  (amber NOT YET IN EFFECT).
- **Integrity SQL (20260828)**: publish_revision v2 separates
  p_override_lock from p_force (overrides never jump holds; owner
  overrides work); own-row-only signing RLS; package-pin UPDATE policy.
- **Races closed**: submitForReview CAS on pending pointer; ticket
  workflow/comment CAS on last_modified; auto-release only touches
  active sessions; restore aborts after a parent-table failure; backups
  HEAD-verify after upload.
- **UX**: onboarding checklist on the dashboard; review-submit feedback +
  auto-publish notice; empty-roster and no-engineer rescues; single-door
  inspector actions; register pill dedup; viewer/contractor nav gating;
  per-library rev-up form memory; force-close/package confirms;
  notification pagination + typed deep-link fallback; dead /workspace
  route removed.

### Ticket deliverable revisions + verify (2026-07, migration 20260827)

The drafting portal now tracks deliverable revisions autonomously, like
document control's rev chain. Scheme: first submit-for-review = **Rev 1A**
(letters advance on each resubmission in the same cycle: 1B, 1C…); on
approval the letter drops → **Rev 1**; a revision request opens the next
cycle → 2A → issued 2. Nobody types a rev — `computeTransition`
(`lib/ticketTransitions.ts`: `draftRevLabel`/`issuedRevLabel`) assigns them
from the workflow events. Columns `tickets.deliverable_rev` (display) and
`tickets.draft_iteration` (letter counter, reset per cycle);
`revision_count` remains the cycle counter. The workflow-action route
strips both columns and retries once on PGRST204/42703 so pre-migration
deployments never block a transition.

**Minor-correction fast approve** (`approve_minor_correction`): the
"you mislabeled this / fix this typo — and it's approved" path. Available
at PENDING_REVIEW to every requester tier (including viewer-tier
requesters who normally must route to an engineer) and to
engineers/management, and at PENDING_FINAL_APPROVAL to the signing
engineer. Requires the correction note (it lands as a comment routed to
the drafter), issues the rev immediately, moves the ticket to PENDING_IFC
— no extra review round.

**Deliverable QR verify**: every ticket-attachment download is stamped
with a QR to public `/verify-ticket/[ticketId]?r=<rev>`
(`/api/verify-ticket`, service-role, UUID-gated, revision facts only —
same contract as `/verify`). Verdicts: green **LATEST ISSUE**; amber
**REVISION UNDERWAY** (printed rev is the latest issue but a newer cycle
is in drafting/review — the PM-forgot-to-forward-the-new-one scenario) or
**REVIEW DRAFT** (a letter rev was never an issued deliverable); red **DO
NOT USE** (a newer rev has been issued). The ticket header shows a rev
chip (amber letter drafts, emerald issued), and the Final Issued
Deliverables panel carries the issued rev badge.

UI rebalance shipped with the same wave: checkout modal defaults to
purpose+reason only (project/timing behind an Options fold; Mode is derived
from purpose, no longer asked); one-click "Release my checkout" in the
status-cell popover + labeled Quick-hold pill; popover shows auto-release
countdowns and passive "recently pulled by" context; unreconciled-branch
banner in the inspector; authors get a private `provenance_flag`
notification when a publish lands unverified; check-in copy is honest about
markups not traveling with the revision-request ticket.

## Project intake — the external door (2026-07)

A contracted engineering company with **no site access** submits drawings
through a tokenized portal; the org keeps a single source of truth.

- **Schema** (`20260902`, `20260903`): `project_intake_links` (40-char
  token, company stamp, `allow_auto_supersede`, expiry/revoke,
  `assigned_doc_ids UUID[]`), `projects.intake_library_id/-collection_id`
  (where submissions land), `document_versions.intake_link_id` (own-work
  provenance chain), and the `provenance` CHECK widened to admit
  `'external'`.
- **Portal** `/submit/<token>` (public, token-gated): register of documents
  the link authored ∪ documents assigned to it; new-document and
  revision-of-ours submission; "Redlines requested" items for open
  collision tickets. Upload-only by design — no downloads of org content,
  no deletes.
- **Routes** `/api/intake/resolve` + `/api/intake/upload` run on the
  service role gated purely by token possession + revoke/expiry checks.
  Upload scope: a link may only revise documents it authored (proven via
  `intake_link_id` on the version chain) or was assigned. Trusted links
  auto-supersede **their own** documents only; assigned org-authored
  documents ALWAYS route through review (`pending_version_id` →
  `finalizeReviewedRevision({requireRosterComplete:false})` from the
  project's Intake tab). Every submission lands as a version with
  `provenance='external'` and the company as `created_by_name`.
- **Transition-in** (`lib/transitionIn.ts`, `TransitionInPanel`): sheets
  still in the intake folder are scanned against the register — equipment
  tags (`extractCandidateTags` → asset registry), same-number hard
  collisions, and overlap documents sharing tagged equipment. Clean sheets
  bulk-adopt into a real library (optional renumber, matched assets linked
  into `document_assets`, `project_documents` association kept, audit
  `TRANSITION_IN`); provenance history is never rewritten.
- **Collision → drafting** (`flagCollisionToDrafting`): a conflict becomes
  a `Revision` ticket in the assignment queue pre-loaded with both sides
  (`metadata.intake_collision`), audited `INTAKE_COLLISION_FLAGGED`. If
  the sheet came through a link, the portal shows "Redlines requested" and
  the company's markup uploads attach to the ticket as `REDLINE_*`
  Reference attachments (`INTAKE_REDLINE` audit) — the drafter's
  revision banner already surfaces `REDLINE_` files.
- Audit actions: `INTAKE_SUBMISSION`, `INTAKE_AUTO_SUPERSEDE`,
  `INTAKE_ASSIGNMENT_CHANGED`, `TRANSITION_IN`,
  `INTAKE_COLLISION_FLAGGED`, `INTAKE_REDLINE`.

## Cost control (2026-07)

The audit found four orphan tables and no system; this is the system.

- **Model**: `project_parties` (contractors/vendors, contract values) →
  `cost_accounts` (budget lines, optional `wbs_milestone_id` pin) →
  `cost_entries` (commitment / actual / adjustment; never deleted —
  voided with `status='void'`). Hardened by `20260908` (value-set CHECKs
  NOT VALID, per-project unique codes, rollup indexes, entries→documents
  FK); writes are controller-only (RLS, `20260906`); every mutation
  audits a `COST_*` action.
- **Rollup** (`lib/costs.ts:computeCostRollup`, pure + unit-tested):
  per-account committed/actual/adjustments/spent/remaining/over-budget;
  project totals; **earned value** = budget × pinned milestone's % and
  **CPI** = EV / AC over pinned accounts — the partner
  `computeScheduleMetrics`' SPI never had.
- **UI**: project → Costs tab (`components/projects/CostsTab.tsx`):
  stat strip (budget/committed/spent/remaining + CPI), animated burn bar
  (spent solid, committed ghost), account rows with burn bars and
  over-budget flags, expandable entries with post/void, milestone
  pinning, party management, mixed-currency warning. Admin/DocCtrl
  write; members read.

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

**Implication for system-emitted events:** any system-emitted audit event
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
  documentLifecycle.ts            ← split / merge / renumber / set-rev-up lifecycle ops
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
