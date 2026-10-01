# 90 · Gap register — build specs

**10 capabilities the Projects/Project-Controls surface needs and does not have.**

Numbered from **401** so they never collide with `roles-and-permissions`
(`GAP-1`…`GAP-15`), `drafting-flow` (`GAP-101`…`GAP-114`), `notifications`
(`GAP-201`…`GAP-207`) or `intelligence` (`GAP-301`…`GAP-312`).

---

## ⚠ How this register differs from the others

**It was derived from the findings, not from a design run.** The other four
registers came out of dedicated design agents that read the owner's intent and
proposed capabilities. This area was audited first, before that pattern existed,
and its 133 findings are overwhelmingly *defects to repair* rather than
*capabilities to build*.

So the specs below are the **capabilities those defects imply** — the cases where
fixing the finding means building something that does not exist, rather than
correcting something that does. Each names its source findings.

**Consequences for how you use it:**

- Every spec **inherits the verification status of its source findings**. Per this
  area's own README, every `CRITICAL` and `HIGH` was verified first-hand at the
  time of the audit against commit `6a14d7d`. That was several sessions ago —
  **re-read the cited code before building** (`DEC-29`).
- Where a finding is a straight repair with no missing capability, it stays a
  finding and is **not** duplicated here. The findings remain the primary record.
- `11-upload-door-controls.md` was already a design note. `GAP-401` supersedes it
  as a spec; the note stays as the reasoning behind it.

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-401](#gap-401) | The unauthenticated upload door as a real boundary | **BUILD** | M | — |
| [GAP-402](#gap-402) | A write that cannot silently fail | **BUILD_NARROW** | S | — |
| [GAP-403](#gap-403) | Stable row identity for schedule re-import | **BUILD** | M | — |
| [GAP-404](#gap-404) | Evidence that actually evidences | **BUILD** | M | `GAP-402` |
| [GAP-405](#gap-405) | Gates with teeth — no blank-reason bypass | **BUILD_NARROW** | S | `GAP-402` |
| [GAP-406](#gap-406) | The award as a transaction, with a repair path | **BUILD** | M | `GAP-402` |
| [GAP-407](#gap-407) | One number, one source, on the bid tab | **BUILD_NARROW** | S | — |
| [GAP-408](#gap-408) | The timeline sees the controls program | **BUILD** | M | — |
| [GAP-409](#gap-409) | The registry at scale — pagination and caching | **BUILD_NARROW** | S | — |
| [GAP-410](#gap-410) | An accessibility baseline for safety surfaces | **BUILD** | M | — |

---

<a id="gap-401"></a>
## GAP-401 · The unauthenticated upload door as a real boundary

**Verdict: BUILD** · Effort: **M** · Sources: `SEC-1`, `SEC-4`, `SEC-5`–`SEC-8`, `11-upload-door-controls.md`

### Why it is a capability and not a fix

`SEC-1` — an unauthenticated upload link can put **executing JavaScript on the
app's own origin**. `SEC-4` — the external door runs as **service role**, so every
database-level document-control guard is skipped.

Those are not two bugs to patch. Together they say the external door has no
boundary: it is a hole with a token in front of it. What has to exist is a
**contract for untrusted content** that every external entry point goes through.

### Scope

**In:** content-type and magic-byte validation; a serving origin that is not the
app's; size and rate limits per token; a token model with entropy, expiry and
revocation; and — the structural one — **the door stops using the service role**
and instead assumes a constrained identity that the DB guards still apply to.

**Out:** redesigning the intake workflow. This is the boundary, not the flow.

### Do not

- **Do not fix `SEC-1` with an extension allowlist.** Filenames are attacker-controlled.
  Validate content and serve from an origin where execution cannot hurt you.
- **Do not keep the service role and add application-layer checks.** That is the
  defect: the guards exist in the database and the door routes around them. An
  application check is a second implementation that will drift.
- **Do not treat the token as authentication.** It is a capability URL — it can be
  forwarded, logged and shoulder-read.

### Acceptance

1. An uploaded HTML/SVG/JS file cannot execute on the app's origin. A test uploads
   one and asserts the response headers and origin.
2. Every DB-level document-control guard applies to content entering by this door.
3. Tokens expire, can be revoked, and revocation is effective immediately.
4. Rate limits are enforced server-side and fail **open** on a limiter error —
   matching `app/api/auth/signup/route.ts:19-33`, the house pattern.

**Related:** the new `document-control` area's intake lens covers the promote
pipeline this door feeds. Read both.

---

<a id="gap-402"></a>
## GAP-402 · A write that cannot silently fail

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `SAF-3`, `UX-1`, and the same class in three other areas

### The pattern, found four times across five audits

- `SAF-3` — **a write denied by row-level security reports success and writes an
  audit row claiming it happened.**
- `UX-1` — **five of the wizard's six writes fail silently, and four fields are
  lost permanently.**
- `PERS-7` / `EVID-6` (drafting-flow) — `logAuditAction` cannot detect a failed
  audit write.
- Six client-side ticket writes never check the returned error.

One root: **`supabase-js` resolves with `{ error }` rather than throwing**, so an
unchecked call reads as success.

### Scope

**In:** one checked-write helper that every mutation path uses, which surfaces the
error, and a lint rule or test that fails when a raw `.insert`/`.update`/`.delete`
result is discarded.

**Out:** rewriting every call site by hand in one change (`DEC-31`). Ship the
helper and the guard, convert the safety-critical paths, and open a finding for
the remainder.

### Do not

- **Do not write the audit row before the write it describes succeeds.** `SAF-3`
  is worse than a lost write: it is a **false record**.
- **Do not catch and toast.** A lost safety write needs to block, not to inform.

### Acceptance

1. An RLS-denied write surfaces as a failure everywhere, and writes no audit row.
2. A test forces a denial on a PSSR/closeout path and asserts nothing is recorded.
3. A raw discarded write result fails the build or the lint step.

---

<a id="gap-403"></a>
## GAP-403 · Stable row identity for schedule re-import

**Verdict: BUILD** · Effort: **M** · Sources: `SCH-2`, `SCH-3`, `SCH-1`, `SCH-6`

### The need

`SCH-3` — **CSV re-import matches rows by position**, so inserting one row
scrambles every row after it. `SCH-2` — re-importing the weekly schedule **wipes
progress the crew logged in the app**.

A weekly re-import is the normal case, not an edge case. Positional matching means
the normal case corrupts data.

### Scope

**In:** a stable external identity per task (the source system's id where one
exists, otherwise a deterministic key), a merge that distinguishes
*added / removed / changed / unchanged*, and preservation of app-side state —
progress, notes, attachments — across import.

Plus `SCH-1`: date parsing must not silently rewrite day/month as month/day. The
comment claims a guard the code lacks; make the code true or the comment go.

**Out:** a full two-way sync.

### Do not

- **Do not auto-apply the merge.** Show the diff. A re-import that silently
  deletes tasks is the same class of harm as `SCH-2`.
- **Do not infer identity from the task name.** Names get edited.
- **Do not treat "row missing from the new file" as "task deleted."** It may be a
  filtered export.

### Acceptance

1. Inserting a row at the top of the source file leaves every other row's identity
   and progress intact. A test pins exactly this.
2. Re-import presents a reviewable diff before writing.
3. An ambiguous date is rejected with a named column, never guessed.

**Partial (2026-10-01, projects Round G — record reconcile, J13).** Built by projects Round G package J6a SCHEDULE-IMPORT (merge `e48ab68`; `SCH-1`, `SCH-2` and `SCH-3` RESOLVED) and verified against HEAD `4dd0df7`. Acceptance 3 holds only in part, so this spec is not marked built.
1. ✓ Inserting a row at the top of the source file leaves every other row's identity and progress intact, and a test pins exactly this. A keyless row is keyed on its content, never its position (`lib/scheduleParsers.ts`, PT `SCH-3`). `lib/milestones.ts` `importMilestonesFromParsed` keeps progress recorded in the app. Tests: `scheduleImportWriters.test.ts` "SCH-3 · a row inserted at the top leaves every other row's identity AND progress intact (GAP-403 acceptance 1)" (:322), exit 0 (64 passed); `scheduleParsers.test.ts` "SCH-3 · row identity is content, not position" (:520), exit 0 (52 passed).
2. ✓ Re-import presents a reviewable diff before writing. A dry run builds the `ImportPlan` (added, changed, unchanged, not in the file, progress at risk), and `components/projects/ScheduleImportModal.tsx` shows a "Review changes" step before "Import N changes". An import never deletes. Tests: `scheduleImportModalReview.test.ts` (:91, :144), exit 0 (5 passed).
3. Partly. **Never guessed — ✓.** A file whose slash dates could be read in either order withholds every row (`lib/scheduleParsers.ts:341-349`: `needsDateConvention`, `rows: []`) until the user picks day/month or month/day on a radio with no default (`ScheduleImportModal.tsx:461-470`). A date that is impossible under the chosen order skips its row, and the skip is counted (`scheduleParsers.ts:1203`). Test: `scheduleParsers.test.ts` "SCH-1 · day/month is decided once from the whole file, never per row" (:210). **"With a named column" — not met.** The prompt names a sample value ("Every slash date (e.g. 06/01/2026) …", `scheduleParsers.ts:342-344` and the modal at :464). The skip warning says "a start or finish date could not be read" (:1203). Neither message names the header of the column the date came from. Owed: carry the start / finish column's header into both messages, or rule that the file-level prompt meets this criterion.

On the "Do not infer identity from the task name" rule: a keyless row's content key includes its name, and legacy position rows are adopted once by a name that is unique on both sides (PT `SCH-3`, which records the duplication residual). This spec's Scope allows a deterministic key where the source has no id; a file with a real id column is keyed on that column.

---

<a id="gap-404"></a>
## GAP-404 · Evidence that actually evidences

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-402` · Sources: `SAF-1`, `SAF-2`

### The need

`SAF-1` — **a contractor's self-typed filename can turn a PSSR item green.**
`SAF-2` — **the AI can mark thirty of forty PSSR items not-applicable behind one
count-only confirmation.**

This is a pre-startup safety review in a PSM plant. A green item has to mean
something a person is willing to sign.

### Scope

**In:** an evidence contract per checklist item — what kind of artifact satisfies
it, and what the system verified about that artifact (it exists, it is attached to
this project, it is of the declared type). A filename is a label, not evidence.

And for bulk AI action: **per-item review, not a count.** A confirmation that says
"30 items" without naming them is not consent.

**Out:** removing AI assistance. Proposing is fine. Asserting is not.

### Do not

- **Do not accept a name as proof of a thing.** `SAF-1` in one sentence.
- **Do not let a bulk confirmation cover items the user has not seen.** If thirty
  items are being changed, thirty items get shown.
- **Do not render an AI-marked item identically to a human-verified one** — the
  same discipline `GAP-303` sets for the intelligence layer.

### Acceptance

1. An item cannot go green on a string alone.
2. A bulk AI action requires per-item review; a test asserts a count-only path
   cannot write.
3. Every satisfied item records who or what satisfied it, and how.

**Status: BUILT (2026-10-01, projects Round G — record reconcile, J13).** Built by projects Round G package J2 QUALITY (merge `798ca2f`; `SAF-1`, `SAF-2`, `QUAL-1`, `QUAL-2`, `QUAL-6` and `QUAL-13` resolved; `DEC-52`). Verified against HEAD `4dd0df7`.
1. ✓ An item cannot go green on a string alone. The evidence register admits only documents at `Issued` or `Locked` with a current version, outside `NOT_CURRENT_STATUSES`, and, for a document that came through the intake door, only once its CURRENT version is approved (`lib/checklists.ts:125`, `:667-755`). A sweep green must carry a citation that the DATABASE resolves to one of three rows: an admitted document, an accepted turnover item or a human-completed MI checklist. That is `checklist_auto_citation_ok` (`supabase/migrations/20261091_prj_roundG_quality_rails.sql:792`), enforced by `checklist_items_decision_rail` (:820-969); these are the only definitions. A person's green needs the person's own reason (the same rail). Tests: `checklists.test.ts` "an unreviewed Draft with a matching title does NOT enter the register; …" (:476) and "an external (intake) submission counts only once its version is approved" (:490), exit 0 (39 passed); `qualityRailsMigration.test.ts` "a sweep green's citation must RESOLVE to its row …" (:511), exit 0 (40 passed).
2. ✓ A bulk AI action requires per-item review, and a test asserts a count-only path cannot write. `applyAssessment` writes only `confirmedItemIds` (`lib/checklists.ts:453-472`). `AssessmentReview` (`components/projects/QualityTab.tsx:698`) lists every proposal, unticked by default. Test: `checklists.test.ts` "a count-only call (no confirmed ids) writes NOTHING and audits nothing" (:139).
3. ✓ Every satisfied item records who or what satisfied it, and how.
   - A person's write is stamped by the database with the caller's uid and sign-in name (`20261091:936-937`: `updated_by := auth.uid()`, `quality_actor_name`), and it carries the person's reason.
   - A machine write has `updated_by` NULL and one of two sentinel names. It is bounded to that machine's own columns and carries its citation (`evidence[].source` / `documentId`) (:871-931).
   - See `DEC-52` item 6.

Inside the register the match is still a title match. `DEC-52` item 1 records it as a labelled MACHINE green that cannot be cited (a completion holding one is `'auto'`), and names the stricter "suggested until verified" form as its reversal. Binding by equipment tag (`document_assets`) is a follow-on, not built.

---

<a id="gap-405"></a>
## GAP-405 · Gates with teeth

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-402` · Sources: `SAF-4`

**Every route to a green closeout gate accepts a blank reason on one keypress.**

The gate exists; it just does not hold. This is the same shape as the
minor-correction bypass in the drafting flow: a control that renders and does not
constrain.

### Do not

- **Do not add a second confirmation dialog.** Two dialogs someone clicks through
  is one dialog. Require the substance — a typed reason, minimum length, the same
  bar `lib/checkinOutcomes.ts` already sets: *"no canned text, no
  get-out-of-jail-free cards."*
- **Do not make it a client-side check.**

### Acceptance

1. A blank or whitespace reason is rejected server-side on every closeout route.
2. The reason is recorded, attributed and visible on the closeout record.
3. A test enumerates every route to a green gate and asserts each rejects blank.

**Status: BUILT (2026-10-01, projects Round G — record reconcile, J13).** Built by projects Round G package J2 QUALITY (merge `798ca2f`; `SAF-4` resolved; `DEC-52` item 4). Verified against HEAD `4dd0df7`. The routes to a green closeout gate are SAF-4's three controls (checklist N/A, turnover waive, punch void) and every other checklist decision a person makes.
1. ✓ A blank or whitespace reason is rejected server-side on every route to a green gate. The rails live in `supabase/migrations/20261091_prj_roundG_quality_rails.sql`, the only definitions:
   - `quality_reason_ok` (:308): at least 10 characters after Unicode whitespace and zero-width characters are stripped, and no canned text;
   - `turnover_items_decision_rail` (:647-700): a waive, a reject and any reopen each need their OWN new reason;
   - `punch_items_void_rail` (:702-750): a void needs a reason;
   - `checklist_items_decision_rail` (:820-969): satisfied, N/A and item reopen each need a reason.

   The lib mirrors the bar (`lib/checklistEngine.ts:138`, `:161` `reasonProblem`), and the prompt cannot settle on a blank (`appPrompt({ required, minLength })`, `components/projects/QualityTab.tsx:105`). Pending migration: `20261091` (DEC-30). Until it is applied, the client data layer's check is the only one.
2. ✓ The reason is recorded, attributed and visible on the record. It is stored in `review_note`, `closure_note` or `manual_note`. The database stamps the reviewer, closer or actor from `auth.uid()` and `quality_actor_name`, never from the client, and appends every turnover decision to `turnover_review_events`. The Quality tab shows it on the item: `components/projects/QualityTab.tsx:809-811` (checklist), `:1156-1159` (turnover), `:1357-1374` (punch). The printed report carries counts, not the reasons.
3. ✓ Tests enumerate every route to a green gate and assert that each rejects a blank. They are split by table rather than kept in one file:
   - `checklists.test.ts` "refuses a blank, short or canned reason on N/A, satisfied and reopen — nothing written, nothing audited" (:214);
   - `turnover.test.ts` "reject and waive refuse a blank, whitespace, short or canned reason …" (:87), "only an accepted or waived item can be reopened, and only with a real reason" (:150), and "void refuses a blank or canned reason; nothing written" (:231);
   - `qualityRailsMigration.test.ts`: the turnover, punch and checklist rails (:418, :438, :449-536) and `quality_reason_ok` (:397).

   Exit 0 for each file (39, 23 and 40 passed).

Outside this spec, because it is not a route to a green gate: completing the PROJECT over red gates takes an optional reason ("Reason (optional)", `app/(protected)/projects/[id]/page.tsx:779`; `lib/projects.ts:537` records `reason || null`). The gates stay red, and their state is recorded in `PROJECT_COMPLETED` and printed (PT `SAF-14`). This area's README lists that override as sound (`README.md:189`).

---

<a id="gap-406"></a>
## GAP-406 · The award as a transaction, with a repair path

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-402` · Sources: `MON-1`

**A failed award leaves the document permanently awarded with no commitment, and
nothing can repair it.**

Two capabilities: the award becomes atomic, **and** there is a way back from the
records already in that state. The second matters more — the first prevents new
damage, the second addresses damage already done.

### Do not

- **Do not build only the transaction.** Existing broken rows stay broken and
  invisible.
- **Do not repair by deleting.** An award that half-happened is a financial event;
  reversing it is an event too, with an actor and a reason.

### Acceptance

1. A failure at any step leaves no partial award.
2. A query identifies existing awarded-without-commitment documents.
3. Repair is an auditable action, not a silent correction.

---

<a id="gap-407"></a>
## GAP-407 · One number, one source, on the bid tab

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `BID-1`, `BID-2`, `BID-3`, `BID-4`

**The table scores the AI's total; the Award button posts the human's corrected
total.** Two numbers, one screen, and the decision is made on the one that is not
being shown.

`BID-2` compounds it: **there is no way to open the quote you are being asked to
award.**

### Scope

**In:** a single authoritative total per bid, with the AI-parsed value and any
human correction both visible and distinguishable; and a link from every bid row
to the source document.

**Out:** re-scoring. `BID-3` and `BID-4` are scoring-logic defects — fix them as
findings once the number is unambiguous.

### Do not

- **Do not hide the AI's original value once corrected.** The correction is the
  record (`GAP-303`, same principle).
- **Do not let a bid be awardable without its source being openable.**

### Acceptance

1. One total drives both the score and the award; a test asserts they cannot differ.
2. AI-parsed and human-corrected are visually distinct.
3. Every bid row opens its quote.

**Status: BUILT (2026-10-01, projects Round G — record reconcile, J13).** Built by projects Round G package J4 BIDTAB (merge `0a8cc63`; `BID-1`, `BID-2`, `BID-3` and `BID-4` resolved). Verified against HEAD `4dd0df7`.
1. ✓ One total drives both the score and the award, and a test asserts they cannot differ. Every bid-table entry goes through `withHumanTotal` (`lib/bidTab.ts:536`, applied by `bidFromRow` at `components/projects/cost/QuotesPanel.tsx:1058`). So the Price column, the value score's normalisation and the award confirm (`award`, :580) all read the row's `total_amount`, which is the figure `lib/costDocs.awardQuote` re-reads and posts (`postableTotal`). Test: `quotesPanel.test.ts` "display and award agree after setManualTotal: the row's total overlays the extraction and re-normalises the field" (:43), exit 0 (13 passed).
2. ✓ AI-parsed and human-corrected totals are visually distinct. A corrected row reads "corrected · AI read $X" in amber, and the AI's figure is kept as `extractedTotal` (`QuotesPanel.tsx:822-824`). The award confirm also says that the total was corrected by hand (:628).
3. ✓ Every bid row opens its quote. `OpenPdfButton` (:977) sits on read rows, typed-total rows, the not-yet-read strip and the invoice list (:312, :341, :436, :726, :777) and uses the existing presigned path. A row with no file says "no file".

---

<a id="gap-408"></a>
## GAP-408 · The timeline sees the controls program

**Verdict: BUILD** · Effort: **M** · Sources: `SAF-6`

**The project timeline cannot see the controls program at all.** Change orders,
checklists, turnover, punch, cost events — none of it appears on the one surface
meant to show what happened to a project.

For a PSM project record, a timeline missing the compliance program is the wrong
timeline.

### Do not

- **Do not put everything on it.** A timeline showing every cost row is unusable.
  Decide per event type whether it is a *milestone* or *noise*, and record the
  decision.
- **Do not build a second event store.** These events already exist as rows.

### Acceptance

1. Change orders, checklist completions, turnover and punch closure appear.
2. Each links to its record.
3. The event vocabulary is one list, extended deliberately.

**Partial (2026-10-01, projects Round G — record reconcile, J13).** Mostly built by projects Round G package J8 PROJECT-MODEL as `SAF-6` (merge `a388d22`) and verified against HEAD `4dd0df7`. Acceptance 2 does not hold, so this spec is not marked built.
1. ✓ Change orders, checklist completions, turnover and punch closure appear. `lib/timeline.ts` `getProjectTimeline` reads the project-scoped audit rows (:711-712) and the cost documents' audit rows (:745) through the vocabulary. Test: `timeline.test.ts` "an award, an approved change order, a turnover acceptance and a checklist ruling all appear; noise and mirrored rows do not" (:98), exit 0 (10 passed).
2. ✗ **Each links to its record: not built.** The Activity tab renders a controls event (`components/documents/TimelineFeed.tsx:139-187`, `TimelineRow`) as a summary line with a time, an actor and a kind tag, and nothing to click. The event does not carry its record as its resource either: a project-scoped row's `resource_id` is the project (`lib/timeline.ts:711-712`), and a cost row's is the cost document. Owed: a per-action link on the controls vocabulary's milestone events, rendered by the Activity tab. The link should go to the change order, checklist, turnover item or punch item, or at least to its tab (`?tab=costs` / `?tab=quality`).
3. ✓ The event vocabulary is one list, extended deliberately: `PROJECT_EVENT_VOCABULARY` (`lib/timeline.ts:407`), with every action classified as milestone, noise or mirrored. An unclassified action is shown (:477). Test: `timeline.test.ts` "the vocabulary is ONE map; an unclassified action is SHOWN, never silently dropped" (:131), exit 0.

---

<a id="gap-409"></a>
## GAP-409 · The registry at scale

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `PERF-1`, `PERF-2`

**The companies registry fires over eleven hundred queries per page view**, with
no cache and no pagination. **Exporting all projects is 360 sequential round
trips** behind a button that gives no feedback.

Both are the N+1 pattern. The capability is pagination plus batched fetch plus
progress on anything long-running.

### Do not

- **Do not fix this with a client-side cache.** It moves the cost, and stale
  company data drives award decisions.
- **Do not leave the export unbatched and just add a spinner.**

### Acceptance

1. Registry page load issues a bounded number of queries independent of row count.
2. Export batches, reports progress, and is cancellable.
3. A test asserts the query count does not grow with the number of companies.

**Status: BUILT (2026-10-01, projects Round G — record reconcile, J13).** Built by two projects Round G packages: J4 BIDTAB built the registry (PT `PERF-1`'s first two done-whens, merge `0a8cc63`), and J8 PROJECT-MODEL built the export (PT `PERF-2`, merge `a388d22`). Verified against HEAD `4dd0df7`.
1. ✓ Registry page load issues a bounded number of queries, independent of row count. `/companies` reads one page on the server (`lib/companies.ts:128` `listCompaniesPage`), capped at `COMPANY_PAGE_SIZE` = 50 rows (:92; the page passes it at `app/(protected)/companies/page.tsx:86`). It then gathers that page's evidence in one batched pass (`gatherCompanyProfiles`, `lib/companies.ts:414`; called once per load at `page.tsx:92`). The batching lives in the gather's chunk loop: each table is read by `batched` / `batchedRead` (:375-388), one `.in()` read per chunk of `IN_CHUNK` = 200 ids (:338-343; the milestone read uses chunks of 80 project ids, `MILESTONE_PROJECT_CHUNK`, :407). Each chunk is paged in `GATHER_PAGE_ROWS` = 1,000-row windows, PostgREST's cap, until a short page (`readChunk`, :349, :360-369). The milestone read's company-name filter is split into slices of at most 50 names and about 2,400 characters (`orFilterChunks`, :392-402). The page's refresh callback (`page.tsx:83-99`) drops a stale gather's result through a cancel token, which the effect's cleanup sets on unmount or re-run (:101-107, the token at :106). The query count is therefore not constant. It grows only with id chunks, name-filter slices and 1,000-row windows, never per company. One company and a full page of 50 both cost 11 queries. 150 companies cost 13 (the name filter splits into three slices), and 150 companies with two parties each cost 18 (300 party ids are two chunks, so the five party-keyed reads run twice). Because the page is capped at 50, a page view stays at 11 unless one page's evidence runs past an id chunk or a 1,000-row window.
2. ✓ Export batches, reports progress, and is cancellable. `lib/projectExport.ts` reads in batches of `EXPORT_PROJECT_BATCH` = 100 (:32), reports progress per batch (:47, :99) and checks an `AbortSignal` between batches (:49). The Export All button is disabled while a run is in flight and shows "Exporting n/N…" with Cancel (`app/(protected)/projects/page.tsx:131-136`). Tests: `projectExport.test.ts` "3 projects and 99 projects cost the same number of reads …" (:92), "progress is reported and a cancel stops the export before anything is built" (:115), and "the Export All button cannot start a second run and shows progress with a cancel" (:158), exit 0 (12 passed).
3. ✓ A test asserts that the query count does not grow with the number of companies: `companiesRegistry.test.ts` "a full page of companies costs the same query count as one, and even 150 stay far under 200" (:104). It asserts 11 queries for 1 company and 11 for 50 (a page), 13 for 150, and 18 for 150 with two parties each, all under 200. "The gather never issues a per-company query …" (:150) asserts no single-company filter and one batched `.in()` per table. Exit 0 (18 passed).

PT `PERF-1` stays OPEN on one item only: "Back does not re-run it". That item is held for the user to rule on (`audit-reports/fleet-plans/projects-joint.json`, `userHeld.PERF-1`). Meeting it would take the client-side cache this spec forbids ("Do not fix this with a client-side cache … stale company data drives award decisions"). Today, Back re-runs one gather of about 11 queries for the visible page. Nothing is owed under this spec.

---

<a id="gap-410"></a>
## GAP-410 · An accessibility baseline for safety surfaces

**Verdict: BUILD** · Effort: **M** · Sources: `A11Y-1`, `A11Y-2`, `A11Y-3`

**File pickers are unreachable by keyboard, including on the public vendor
portal.** **Checklist item status is conveyed entirely by an eight-pixel coloured
dot — on the PSSR surface.** **Milestone row tints make the row unreadable in dark
mode.**

The middle one is the serious one. Colour-only status on a pre-startup safety
review fails for roughly one in twelve men, and PSSR items are read under time
pressure by whoever is on shift.

### Scope

**In:** keyboard reachability for every control including the public portal; status
conveyed by shape or text as well as colour on every compliance surface; and a
contrast pass on both themes.

**Out:** a full WCAG programme. This is the safety-surface baseline.

### Do not

- **Do not add a tooltip and call the dot fixed.** A tooltip is not available to a
  keyboard user mid-walkdown, and it is not available at a glance.
- **Do not fix dark mode by disabling the tint.** The tint carries meaning; give it
  a legible form.

### Acceptance

1. Every control on the public portal is keyboard-reachable and focus-visible.
2. No compliance surface conveys status by colour alone. A test asserts the
   accessible name of a status cell includes its state.
3. Both themes pass contrast on the milestone and checklist surfaces.

---

## What deliberately did NOT become a gap

Recorded so nobody looks for a spec that should not exist.

| Finding | Why it stays a finding |
|---|---|
| `SEC-2` private projects not private | A repair to existing RLS, not a new capability. |
| `SEC-3` review guarantee self-destructs | A defect in an existing guard. |
| `SAF-5` auto-supersede is a raw column write | Route it through the existing post-publish pipeline — the pipeline already exists. |
| `MON-2` S-curve planned line starts wrong | Arithmetic. |
| `SCH-4`, `SCH-5`, `SCH-7` | Cycle handling, three contradictory overdue rules, a missing optimistic lock — all repairs to code that exists. |
| `UX-*` truth-in-interface findings | Copy and render fixes. Numerous, cheap, and not capabilities. |
