# 08 · Reliability & failure modes

What the user sees when something breaks, what nothing is testing, and the
states that are declared but unreachable.

**11 findings** — 0 CRITICAL, 7 HIGH, 4 MEDIUM.

> Line numbers drift — **match on the quoted code.** See
> [`../README.md`](../README.md) for the protocol.

---

## The failure-mode matrix

Read this before working any individual finding — it is the shape of the whole
report.

| Condition | Costs tab | Quality tab | Coach / closeout gates | `/companies` | `/submit/<token>` |
|---|---|---|---|---|---|
| **Migration 20261013 not applied** | degrades quietly | **blank panel**, then **raw** `relation … does not exist` on first write | silently all-zeros | **raw** error in a red banner | quote branch unreachable — correct |
| **No AI key / unsigned / over cap** | clean, dismissible | clean, dismissible | n/a | **whole page blanked** (`UX-9`) | n/a |
| **R2 unavailable** | **raw** AWS SDK message | same | n/a | **misattributed** as "file may be corrupt" | "File storage failed — try again." — correct |
| **Policy denies a write** | **raw** RLS message | **raw** | gates read "No turnover requirements set" | **raw** + blanked | n/a |
| **Offline mid-action** | **wedged row** (`MON-1`) + raw `TypeError` | **blank** | silently zeros | raw + blanked | error shown — correct |
| **Malformed AI JSON** | 502, plain copy — correct | correct | n/a | correct | n/a |
| **Unrenderable PDF** | 415 pre-check + honest 502 — correct | no pre-check: burns the round trip first | n/a | same | n/a |
| **Supabase 500** | **raw** | **blank** on reads, **raw** on writes | silent zeros | **raw** + blanked | "Something went wrong" — correct |

---

## REL-1 · The companies registry spins forever if the org never resolves, with no error boundary to catch it

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** availability
- **Locations:**
  - `app/(protected)/companies/page.tsx:46` — `if (!activeOrgId) return;` with `loading` starting `true`
  - `components/providers/RoleContext.tsx:58` — `activeOrgId` starts null
  - `components/providers/RoleContext.tsx:315-325` — 15s timeout logs "role resolve timed out — proceeding" and continues **with the id still null**
  - `app/(protected)/companies/` — **no `error.tsx`, no `loading.tsx`** (14 other routes have one)
  - `app/(protected)/projects/page.tsx:64` — the same pattern, but documented
- **Re-verified:** hardening pass — **SURVIVES**. `refresh` returns early when `activeOrgId` is null (`companies/page.tsx:46-48`) and `setLoading(false)` sits inside the try that follows, so an org that never resolves leaves the page on its spinner. Directly downstream of `identity-and-session/SESS-1`, which is one way `activeOrgId` stays null.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Both halves check out — the terminal spinner and the full-app flash on cold navigation to /companies (the app/(protected)/projects/page.tsx:64 guard `if (!activeOrgId || !uid) return;` is the same pattern, but that route does have its own loading.tsx). One correction to the wording: an error boundary does exist and covers this route (app/(protected)/error.tsx), it just cannot catch a hang. Downgraded to MEDIUM because the hang requires the org to never resolve (RoleContext's watchdog at :83-90 and its 15s resolveOrgAndRole race make that an edge case), leaving the loading-shell flash as the routinely-hit half.

**Mechanism.** The refresh returns early when the org id is null and never
clears `loading`. The role resolver's timeout does not supply a fallback id.

**Failure scenario.** "Loading the registry…" forever — no error, no retry, no
timeout. And because the route has no `loading.tsx`, the nearest ancestor is
`app/loading.tsx`, which renders **outside** the protected shell — so a cold
navigation flashes the entire application away, sidebar included.

**Remediation.** Give the page a resolved/failed/loading tri-state rather than a
boolean; when the role resolver times out, render an explicit "couldn't
determine your organization — retry" state. Add `error.tsx` and `loading.tsx`
to `app/(protected)/companies/`, modelled on the projects route's.

**Done when.**
- A null org id produces an actionable error, not an infinite spinner.
- `/companies` has its own in-shell loading skeleton and error boundary.

**Resolution (2026-09-29, projects Round G).** `app/(protected)/companies/page.tsx` keeps a tri-state (`"loading" | "ready" | "failed"`) instead of a boolean, and derives an org-failure state from `useRole()`: when `activeOrgId` is null and the resolver's `loading` is false, the page renders "Couldn't determine your organization — … Retry, or sign in again" (naming the membership-lookup failure when `membershipState === "error"`) with a Retry button; nothing waits on an id that will not arrive. `app/(protected)/companies/loading.tsx` (in-shell `RouteLoader`) and `error.tsx` (reset + escape link, inside the shell) were added. `RoleContext` was not edited (IS-P1 / PKG-1's). Pinned in `companiesRegistry.test.ts` (source pins + boundary files exist). Fix pass: in the org-failure state Retry now reloads the app shell — the only way this page can re-run the resolver (`RoleContext` exposes no re-resolve and is not this package's file); the first landing's Retry bumped the list's reload key and `refresh()` returned at once with no org, a no-op. Rendered tests (`companiesPagesRender.test.ts`, jsdom + a mocked `useRole`): a null org renders the membership-failure message and Retry, no spinner and no list read, and Retry reloads; with an org, a failed list read renders the error and Retry re-reads the list.

**Done-when.**
- A null org id produces an actionable error, not an infinite spinner — ✓ (its Retry acts).
- `/companies` has its own in-shell loading skeleton and error boundary — ✓.

**Scope / residual.** The resolver's own 15 s timeout behaviour (SESS-1) is identity-and-session's.

---

## REL-2 · A broken Costs tab is pixel-identical to a brand-new one

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** diagnosability / trust
- **Locations:**
  - `lib/costs.ts:159-161, 204-208, 122-124` and `lib/costDocs.ts:86-91` — `{ data }` only, cannot throw
  - `components/projects/CostsTab.tsx:60-82` — the try/catch that therefore never fires
  - `components/projects/CostsTab.tsx:65` — the `.catch(() => [])` labelled "pre-migration tolerance", which is dead code
  - `lib/costDocs.ts:106-128` — `uploadCostDoc` uploads to R2 *before* inserting
- **Related:** `UX-10`, `REL-10`
- **Re-verified:** hardening pass — **SURVIVES**. `const { data } = await supabase…` with the error discarded, returning `[]` — `costs.ts:159-161`, `costDocs.ts:86-91`, and **8** such sites across the four projects libraries. A failed read is pixel-identical to an empty project.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Right as written, and the line that settles it is the missing `error` in each destructure. An RLS denial or a pre-migration schema returns `{ data: null, error: {...} }`, which becomes `[]`, which makes rollup.budget 0 and entries empty — pixel-identical to a fresh project, and (via CostCharts.tsx:45) it also flips the charts into watermarked EXAMPLE mode. HIGH is correct: the user is shown confidently wrong financial state with no error anywhere.

**Mechanism.** Because the list functions swallow errors one layer down, the
tab's own error handling is unreachable and the "tolerance" catch is dead.

**Failure scenario.** A project with 8 accounts, 40 entries and 3 awarded quotes
renders four `$0` tiles, no burn bar, every empty state — **and, because the
rollup is zero and there are no entries, watermarked EXAMPLE charts showing a
healthy $305,000 job** (`REL-10`). The user's only feedback is an invitation to
start over. If they take it, the upload posts the file to R2 (orphaning it) and
then surfaces a raw Postgres string.

**Remediation.** Fix at the source (`UX-10`): return errors from the list
functions. Then the tab's existing try/catch works, and the dead "tolerance"
catch can be removed or made real. Separately, insert the row before uploading
the bytes, or clean up the orphan on insert failure.

**Done when.**
- A failed read renders a failure state, not an empty state.
- A failed insert does not leave an orphaned R2 object.

**Resolution (2026-09-29, projects Round G).** Joint J3 MONEY-LEDGER. The list readers throw on a failed read and the tab renders the failure: `lib/costs.ts` `listParties` / `listAccounts` / `listEntries` and `lib/costDocs.ts` `listCostDocs` destructure `{ data, error }` and throw `Couldn't load <thing>: <message>`; `components/projects/CostsTab.tsx` `refresh` drops the dead `.catch(() => [])` "pre-migration tolerance", also throws on a milestones read error, loads change orders and the ledger orphans in the same `Promise.all`, and the existing `try/catch` now sets the banner — so a broken tab shows the rose failure banner instead of four `$0` tiles and EXAMPLE charts. `lib/projectSnapshot.ts` / `lib/projectReport.ts` already wrap these readers in `safe(…, [])` (unchanged). `uploadCostDoc`: a failed row insert after the R2 upload now calls `deleteFile(key)` (best effort) so the object is not orphaned.
- Tests: `lib/__tests__/costDocs.test.ts` — "a failed read THROWS instead of returning an empty list" (`listAccounts`, `listCostDocs`), "a failed insert after the upload removes the orphaned object".
- Reproduced at the base commit: `const { data } = await …` at all four sites.

**Done-when.**
1. ✓ A failed read renders a failure state, not an empty state.
2. ✓ A failed insert does not leave an orphaned R2 object (best-effort delete; the orphan collector ILIFE-1 / BKP-2 remains the backstop).

**Scope / residual.** The `{ data }`-only reads in `lib/companies.ts`, `lib/checklists.ts` and `lib/turnover.ts` (the "8 sites") belong to J4 / J2 and are not touched here; `UX-10` / `REL-10` are PT's component-wide packages.

**Verification fix (2026-09-30, projects Round G).** The resolution above says `lib/projectSnapshot.ts` / `lib/projectReport.ts` "already wrap these readers in `safe(…, [])` (unchanged)". The snapshot's wrapper names the read. The report's `safe()` did not: it turned this finding's throw back into an empty ledger one layer up, so a refused `cost_accounts` read printed "Budget $0.00" with nothing said. `lib/projectReport.ts` now names every failed read it can observe in `readFailures`: cost accounts, cost entries, change orders, milestones, punch items, companies on the job and the completion record. A table migration 20261013 has not created yet (`change_orders` or `punch_items` answering `42P01` / `PGRST205`) is not counted as a failure: no row can exist, so it reads as empty, the same state the snapshot names in `notMigrated` (`MISSING_TABLE_CODES`, `lib/projectSnapshot.ts`). A failed cost read replaces the Money section with "Could not read <reads> — the money figures are left out, not printed as zero." (`:271`). A failed milestones read prints "Could not read the milestones", not "No schedule loaded" (`:314`). The punch row and the companies section say "Could not read", and the footer lists what was not read (`:346`). The lessons-learned draft says the cost outcome could not be read (`:374`) and names every other unread part, so "Clean job on the record…" is never written over a read it could not make. The snapshot already named a refused cost read (`call`, `lib/projectSnapshot.ts:188`); its stale comment saying the list functions still swallow errors is corrected, and its test now injects the failure at the table. Tests: `lib/__tests__/projectReport.test.ts` "a refused cost_accounts read: no $0.00 Budget row — the Money section says it could not be read", "a refused change_orders read blanks the Money section too…", "a refused milestones read says so instead of 'No schedule loaded'…" and "a refused punch read is not 'Clear'…" (all fail on `9b4c5f4`), plus "a database migration 20261013 has not reached … is not a failed read — the money prints"; `lib/__tests__/projectSnapshot.test.ts` "refused cost accounts: named in readFailures…" (`readFailures` is `['cost accounts']`, Cost scored null). Residual: `listChecklists` / `listChecklistItems` (`lib/checklists.ts`) and `listTurnoverItems` (`lib/turnover.ts`) still return `[]` on a refused read, so the report's checklist and turnover rows cannot name those failures (closer: J2, per the scope note above).

**Verification fix (2026-09-30, projects Round G).** Found by the second review of joint J5 CHARTS and fixed there, in `components/projects/CostsTab.tsx`, which that package already edits (this finding's own done-when 1, `DEC-31`). Done-when 1 was not met on a failed FIRST load. The loaders throw, but the tab's state keeps its initial empty arrays, so under the banner the tab drew exactly the new-project empty state this finding rules out: Budget / Committed / Spent / Available $0.00, "No cost accounts yet … Create the first one above." (an invitation to re-create budget lines that may already exist), "No quotes yet" and zero contractors. Until J5's first fix pass (`REL-10`) it also drew the EXAMPLE charts. The tab now keeps a `loaded` flag that only a successful `refresh()` sets. Until then it renders the banner and one stated failure panel (`data-empty="cost-data"`: "This project's cost data couldn't be read. Nothing is shown rather than an empty ledger …", with a Try again button), and nothing that draws from the read: no stat strip, burn bar, picture, quotes, change orders, accounts or parties. A later failed refresh keeps the last good read on screen under the banner, as before.
- Tests: `lib/__tests__/costsTabFirstLoad.test.ts` — "the first read rejects: the banner and one stated failure panel with a retry — no example, no $0 tiles, no invitation to start over" (no money figure anywhere, no "No cost accounts yet", no New account button, neither panel drawn; Try again then draws the real tab), and "a failed refresh AFTER a good read keeps the last good figures on screen, under the banner". The first test failed on the previous head (`b2eddd9`), where the tab printed "$0.00".
- Done-when 1, re-checked: ✓, now including a failed first load. Done-when 2 is unchanged.

---

## REL-3 · Raw Postgres error strings reach plant users at roughly twenty-two sites

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `lib/checklists.ts:127, 138, 204, 226`
  - `lib/turnover.ts:158, 179, 207, 275`
  - `lib/costDocs.ts:109, 128, 187, 316, 331`
  - `lib/changeOrders.ts:69, 111, 158`
  - `lib/companies.ts:85, 92, 124, 137, 183, 212`
  - Good precedents: `lib/companies.ts:134-136` (23505 → human copy), `components/projects/cost/QuotesPanel.tsx:545` (migration hint)
- **Re-verified:** hardening pass — **SURVIVES**, with the count made exact: **56** references to `error.message` / `error?.message` across the projects libraries — more than the ~22 claimed, though not every one reaches a user-facing surface. `checklists.ts:127` is representative.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The claim and its count hold — the cited lines total 22 and every one of them forwards a Postgres message straight to a plant user, with the single 23505 case at companies.ts:134-136 proving the codebase knows how to do better. Downgraded to MEDIUM: the impact is confusing UX plus minor schema disclosure (table and policy names), not lost or wrong data, and no privileged information beyond object names escapes.

**Mechanism.** Every write path returns `error.message` verbatim.

**Failure scenario.** What a superintendent sees when a policy denies a write,
or when a migration has not been applied, is a sentence about relations and
row-level security policies.

**Remediation.** Add a small `humanizeDbError(error)` helper mapping the common
codes — `42P01` (missing table → "needs migration N"), `42703` (missing
column, same), `23505` (duplicate), `23503` (foreign key), and the RLS message
(→ "you don't have permission to do that here") — and route all twenty-two
sites through it, falling back to a generic message plus a logged detail.

**Done when.**
- No raw Postgres string reaches a user in the Projects or Companies area.
- The underlying detail is still logged for diagnosis.

**Resolution (2026-10-01, projects Round G).** New `lib/userFacingError.ts` — the one translator (DEC-76 item 2). A fixed table maps raw driver text to a plain sentence: a missing relation / column / function or a schema-cache miss (`42P01`, `42703`, `42883`, `PGRST202/204/205`) → "This needs the latest database migration applied"; an RLS refusal or a missing grant → "You don't have permission to do this"; a unique / foreign-key / not-null / check violation, bad input, a lock or serialisation failure, a statement timeout, an unreachable or timed-out gateway (`PGRST000-003`), a single-row miss (`PGRST116`), an expired session (`PGRST30x`), a dropped connection — each its own sentence, worded for a write ("— nothing was changed") or, through `userFacingReadError`, for a read. A message written for users passes through untouched: a database rail's own `RAISE` under `42501` / `23514` / `23505` / `23503` / `P0001` and the libraries' own sentences (the template decides, never the code alone — the 23505 precedent in `lib/companies.ts` and the migration hint in `QuotesPanel.tsx` are kept). Any other driver error becomes "Something went wrong on the server — try again…", naming no table, column or policy. Whenever the text is replaced, the raw `{code, message, details, hint}` goes to `console.error` with a context label. Routed through it: every cited site (`lib/checklists.ts`, `lib/turnover.ts`, `lib/costDocs.ts`, `lib/changeOrders.ts`, `lib/companies.ts`) and the rest of the Projects / Companies data layer — `lib/costs.ts`, `lib/milestones.ts` (the schedule engine), `lib/projects.ts` (lifecycle, members, checkout release on close), `lib/timeline.ts`, `lib/transitionIn.ts`, `lib/intakeLinks.ts`, `lib/projectExport.ts`, `lib/projectReport.ts` — and the component sites that read the database directly (`QuotesPanel`, `IntakePanel`, `CostsTab`, `ChangeOrdersPanel`, `ProjectWizard`'s refusals, `EditProjectModal`, `ProjectDocumentsCard`). `lib/checkedWrite.ts`'s `describeWriteError` keeps its own sentences and now maps the rest through the translator (a raw `23505` used to reach the screen). Code that must read the driver text to decide (schema step-down, missing-RPC / missing-table probes) reads the raw error before translating. Tests: `userFacingError.test.ts` (31: each template → its sentence with no internals in it and the raw detail logged; rails and library sentences pass through unlogged; `describeWriteError`; the libraries end to end; a source census of the thirteen libraries — no `error.message` reaches a caller except through the translator), and the tests that pinned raw driver text now pin the sentence (`checkedWrite`, `costDocs`, `qualitySignoff`, `turnover`, `checkoutRoundF`, `projectExport`, `projects`, `scheduleEngineWriters`, `scheduleImportWriters`).

**Review fix (2026-10-01, projects Round G).** The first pass translated the data layer, but its census read libraries only and two screens still showed the driver's text. (1) `components/projects/EditProjectModal.tsx` — the second write's refusal ("Name, description, MOC, target date and visibility were saved, but purpose / goals / Summary of Work were not: …") interpolated `extErr.message`; it now carries `userFacingError(extErr)`. (2) `components/projects/StaleCheckoutBanner.tsx`, mounted on /projects — `lib/checkoutEpisodes` (Document Control's; not edited) throws `error.message` unmodified, so a refused release is translated at the Projects call site. (3) New `userFacingCaughtError` (`lib/userFacingError.ts`) for a screen that shows whatever a library threw: a library outside the translated set may wrap driver text inside its own sentence ("The new revision is published, but the prior revision could not be marked superseded: <driver text>" — `lib/reviewControl`), and translating the whole would drop what DID happen and claim nothing changed — so the lead-in is kept, only the driver fragment is replaced (a parenthesised fragment in place, with the library's next sentence kept), a lead-in or tail that would name a table, column or policy is dropped, a bare driver message becomes its sentence, and a sentence passes through unlogged. Every caught error a Projects / Companies screen or the vendor portal shows now goes through it — `components/projects/**`, `app/(protected)/projects/**`, `app/(protected)/companies/**`, `app/submit/[token]` (among them the intake panel's approve / reject / assign, which call `lib/reviewControl` and `lib/docClass`; the quotes panel's PDF open, `lib/storage`; the undo toast; every load and action banner) — and so does every catch in the thirteen libraries that hands a callee's text back (`partyLinkCheck`, the revert paths in `costDocs` / `changeOrders`, the sign-off check and ceremony in `checklists`, the evidence sweep, the schedule import rows, the project activity row and the closeout-gate snapshot, the collision flag in `transitionIn`, the turnover seed). (4) `ChangeOrdersPanel` decides "pre-migration: stay quiet" on the code `listChangeOrders` carries (42P01 / PGRST205): the regex over the message stopped matching once the message was translated, and the Costs tab showed a load error where it used to show nothing. (5) `setManualTotal`'s refused UPDATE is worded as a write ("You don't have permission to do this — nothing was changed.") and logged under its own name, not `declineQuote`. Tests: `userFacingError.test.ts` (38, +7) — the caught-error translator (a partial success keeps its lead-in; a parenthesised fragment and the sentence after it; a schema-cache preamble dropped; a bare driver message; a sentence unlogged; a lead-in that leaks dropped); the library census now refuses a caught Error's text anywhere but a console line, a presence test or a structured hand-off to a translating caller; a **screen census** over every file in `components/projects/**`, the Projects / Companies pages and the portal (mutation-checked: a raw `(e as Error).message` or `<err>.message` fails it); the two cited leaks pinned. `changeOrdersPanelRender.test.ts` — rendered through the REAL `listChangeOrders`: 42P01 and PGRST205 stay quiet, a refusal reads as a sentence. `costDocs.test.ts` — the write wording. Pins that held raw driver text on a screen now hold the sentence (`companiesPagesRender`, `scheduleEngineUi` — and a second failed Undo keeps the action's own words, `useUndoableActions` `baseMessage` — `projects`, `scheduleEngineMigration`, `checkoutRoundF`).

**Second review fix (2026-10-01, projects Round G) — a correction.** The review fix above kept a library's lead-in so that a partial success would not "claim nothing changed", and its report said a partial success is never worded "nothing was changed". That was false: every write sentence ends "— nothing was changed", and both `userFacingCaughtError` (which kept the lead-in but appended the full sentence) and 27 translator calls in the libraries and screens put it straight after a lead-in reporting a write that LANDED — "The new revision is published, but the prior revision could not be marked superseded: You don't have permission to do this — nothing was changed.", "CO-003 was approved and its money posted, but the link to its cost entry could not be saved (… nothing was changed.)", "Name, description, MOC, target date and visibility were saved, but … were not: … nothing was changed." A reader of "nothing was changed" after an approval, an award, a closeout or a publish can conclude the action failed and do it again. What landed: (1) `lib/userFacingError.ts` has an embedded form — `userFacingError(err, { embed: true })` gives the REASON alone ("You don't have permission to do this.") for a sentence placed after a lead-in that says what happened; `userFacingCaughtError` uses it whenever it keeps a lead-in (a bare driver message still gets the full sentence). (2) Every site that puts a translated reason after a landed write uses it: `lib/costDocs.ts` ("Awarded, but N of M competing bids could not be marked not-selected"), `lib/changeOrders.ts` (the approved-and-posted link warning; the voided-entry unwind), `lib/projects.ts` (the activity row every "X was attached / removed / The project is <status>, but …" message carries; the checkouts not released on close; "Ownership moved, but …" twice; the schedule rows of a deleted project), `lib/milestones.ts` (the reschedule's breadcrumbs / audit row; the delete's sub-task move and link removal), `lib/intakeLinks.ts` (revoked / re-issued, audit failed), `components/projects/EditProjectModal.tsx`, `IntakePanel.tsx` (link created / revoked / submission rejected, audit or sign-off close failed) and `cost/QuotesPanel.tsx` (every "…, but its audit / override record failed", and `guardedCostDocWrite`'s audit warning behind "The total was saved / Voided, but …"). (3) The READ table now words every kind as a load — no read sentence says "nothing was changed" (a malformed id filter on a load reads "A value in the request isn't in the expected format."); `lib/projects.ts`'s paged reads (`readAllPages`), `lib/turnover.ts`'s three list reads and `lib/checklists.ts`'s list / item / sign-off-authority reads (all formerly through `describeWriteError`) are worded as reads. Tests: `userFacingError.test.ts` (+6: one driver sample per kind, typed so a new kind cannot be skipped, each classified as itself; every kind read-worded with no "nothing was changed"; every kind's embedded reason likewise; a **census** — seven landed-write lead-ins (published / approved / saved / created / moved / Awarded / The project is) × every kind × the colon and the parenthesised form through `userFacingCaughtError`, none holding "nothing was changed" and each keeping its lead-in where the fragment is found; a **source census** over the thirteen libraries and the screens that build these messages — every translator call on a line reporting a landed write ("…, but …") uses the embedded reason (mutation-checked); the sub-clause sites pinned). `costDocs.test.ts` (+2: an RLS-refused rival decline and an RLS-refused change-order link, through the real libraries — the warning keeps "Awarded, but" / "was approved and its money posted, but" and never says "nothing was changed"). Pins that encoded the contradiction now hold the reason alone (`userFacingError` — the partial-success, parenthesised and saved-but cases and the `EditProjectModal` source pin; `projects` — the activity row; `checkoutRoundF` — "NOT released: You don't have permission to do this."; `scheduleImportWriters` — the reschedule's "audit: You don't have permission to do this.", shown as "Moved, but audit: …").

**Third review fix (2026-10-01, projects Round G) — a reason inside the caller's sentence.** Translator output placed INSIDE parentheses kept its own full stop and, for a write, its "— nothing was changed" tail, so a refusal read twice or garbled: "Could not delete “Pour slab” (You don't have permission to do this — nothing was changed.) — nothing was changed.", "…for loops (The database took too long to answer — try again.). Nothing was grouped.", "(…try again in a moment.) — it stays open." — and two tests pinned the "….)" form. `lib/userFacingError.ts` gains `clause: true` (the reason alone — the embedded form, or the read wording for a read — with no closing full stop; `userFacingCaughtError` honours it too) and `asClause` (a finished sentence made a clause, for text a library already translated). Every parenthesised site in the area uses one or the other: `lib/milestones.ts` (the delete RPC and fallback refusals, the sub-task / dependent reads, the loop check, the move pre-read, the delete follow-ups), `lib/checklists.ts` and `lib/turnover.ts` (the sign-off authority read), `lib/changeOrders.ts` (the decider check, the link and void follow-ups, the put-back), `lib/costDocs.ts` (the rival decline, the registry check, the stuck-money message), `components/projects/cost/QuotesPanel.tsx` (the override audit refusals — two of them used the WRITE form, saying "nothing was changed" inside the parentheses), `QualityTab.tsx`'s sign-off notices, and three in JSX text — the change-orders load failure (`ChangeOrdersPanel.tsx`), the Edit-project field-read failure (`EditProjectModal.tsx`) and the Costs tab's registry-read failure (`CostsTab.tsx`). Tests: `userFacingError.test.ts` (+3: the clause form for every kind — no full stop, no "nothing was changed", read-worded for a read, a rail's sentence and a caught error's lead-in kept; a mutation-checked source census that every translator call AND every already-translated `…error` placed inside parentheses — `(${…})` in a template, `({…})` in JSX text — in the area's libraries and screens is a clause; the cited sites pinned), `scheduleEngineWriters.test.ts` (a refused delete RPC reads "Could not delete “Phase 1” (You don't have permission to do this) — nothing was changed." — "nothing was changed" once, no "….)"; the loop check's pin), `qualitySignoff.test.ts`, `costDocs.test.ts`, `scheduleImportWriters.test.ts` and `changeOrdersPanelRender.test.ts` (their "….)" pins replaced by the one-sentence form).

**Done-when.**
- ✓ No raw Postgres string reaches a user in the Projects or Companies area — the data-layer census and, since the review fix, a screen census over every Projects / Companies component and page and the vendor portal (a caught error is translated where it is shown, so another area's library that hands back driver text is covered at the call site).
- ✓ The underlying detail is still logged for diagnosis (`console.error`, every replacement).
- ✓ (third fix) A reason placed inside the caller's own sentence reads as one sentence — no "….)", never the caller's tail twice (clause census).

**Scope / residual.** Server routes' JSON error bodies (the AI and intake routes) are J12's server remainder; on the Projects screens they now pass through the same translator, so a driver template inside one is replaced, while a route's own sentence is shown as written. The rule stays "the template decides, never the code alone": a code-less message that matches no known template is shown as written (a coded driver error with an unknown template becomes the "unexpected" line). `lib/checkoutEpisodes`, `lib/reviewControl`, `lib/docClass` and `lib/storage` (other areas' libraries) are not edited — their text is translated at the Projects call sites. `lib/projectWizardWrites.ts` returns the raw text to the wizard, which translates it (`wizardWriteError`) before showing it.

---

## REL-4 · Every database row enters the application as an unchecked cast

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J10b UI REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** correctness / availability
- **Locations:**
  - 178 type assertions across the 15 new libraries (companies 46, costDocs 23, changeOrders 22, checklists 21, projectSnapshot 18, turnover 17)
  - The dangerous shape — union cast on a raw string, 12 sites: `lib/costDocs.ts:69`, `lib/checklists.ts:63`, `lib/turnover.ts:97`, and others
  - `supabase/migrations/20260819_orphan_tables_backfill.sql:184, 193` — `cost_documents.status` and `kind` are plain `text NOT NULL`, no CHECK
  - `lib/changeOrders.ts:54`, `lib/costDocs.ts:68` — `Number(...)` with no finite guard
  - `lib/checklists.ts:80` — `Array.isArray(r.evidence)` checks array-ness, not element shape
  - `lib/companies.ts:75` — `qualityManualGaps` cast with no check at all
- **Related:** `MON-8`
- **Re-verified:** hardening pass — **SURVIVES**. `(r.status as CostDocStatus) ?? "draft"` (`costDocs.ts:69`) — `as` performs no validation and `??` catches only null, so any unexpected string enters the domain model intact. This is the input that makes `MON-8` throw.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The absence claim holds up on a repo-wide search: nothing validates a DB row anywhere — the `validate*` helpers that do exist (validateParsedQuote, validateSegmentedItems, validateRubricFindings) guard AI output, not database reads. There is even a concrete crash path: lib/costDocs.ts:181 does `COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()`, which throws on any status outside the union. MEDIUM rather than HIGH, though: reaching it requires a row written outside these code paths, since the app's own writers only emit union values.

**Mechanism.** Rows are mapped field-by-field from `Record<string, unknown>`
with no runtime validation. `?? "default"` catches null and nothing else.

**Where an unmapped value lands.** One path **throws and hangs a button**
(`MON-8`). Five render as **blank chips** — turnover status, checklist kind,
cost-doc status, company kind, CO reason (only `StatusDot` defends with
`?? map.open`). Two produce **NaN**, which flows into `summarizeChangeOrders`,
`computeCostRollup`, the Donut, and `fmtMoney(NaN)` — which `Intl` renders as
the literal string **"$NaN"** with no throw and no guard.

**Remediation.** Three layers, cheapest first:
1. Add `CHECK` constraints to `cost_documents.status` and `.kind` so unmapped
   values cannot exist.
2. Make every label lookup total: `LABEL[x] ?? x`.
3. Guard every `Number(...)` with `Number.isFinite`, defaulting to 0, and have
   `fmtMoney` render an em-dash rather than "$NaN" for a non-finite input.

A schema-validation layer (zod at the row-mapping boundary) is the durable fix,
but the three above remove the user-visible damage for far less work.

**Done when.**
- No label lookup can return `undefined`.
- `fmtMoney(NaN)` never renders "$NaN".
- The database rejects an unmapped status or kind.

**Partial (2026-09-29, projects Round G — the money tables + `fmtMoney`; the quality-table CHECKs are P2/J2's migration).** Joint J3 MONEY-LEDGER. (1) Migration `20261093` adds `cost_documents_status_check` and `cost_documents_kind_check` (NOT VALID; inventory of rows outside either set before apply). (2) Label lookups on the money surfaces are total: `costDocStatusLabel(status)` in `lib/costDocs.ts` (used by every status message and the data-health line), `CO_REASON_LABEL[co.reasonCode] ?? co.reasonCode` in `ChangeOrdersPanel.tsx`. (3) `lib/costs.ts` `num()` guards every `Number(…)` in `mapParty` / `mapAccount` / `mapEntry` with `Number.isFinite` (0 otherwise); `lib/changeOrders.ts` `rowToCo` and `lib/costDocs.ts` `mapDoc` guard `amount` / `total_amount` the same way; `fmtMoney` renders an em-dash for a non-finite input.
- Tests: `lib/__tests__/costs.test.ts` "never renders $NaN"; `lib/__tests__/costDocs.test.ts` "a non-numeric amount enters the model as 0…"; `lib/__tests__/moneyRailsMigration.test.ts` pins both CHECKs.
- Pending migration: `20261093_prj_roundG_money_rails.sql`.

**Done-when.**
1. ✓ for the money surfaces (cost-doc status, CO reason); the turnover-status / checklist-kind / company-kind lookups are J2's / J4's files.
2. ✓ `fmtMoney(NaN)` never renders "$NaN".
3. ✓ The database rejects an unmapped cost-document status or kind (once `20261093` is applied); the quality tables are J2's migration.

**Scope / residual.** OPEN for the other areas' lookups and CHECKs. A zod row-validation layer is not attempted (DEC-31).

**Partial (2026-10-01, projects Round G).** Package J10b UI REMAINDERS made every label lookup in its files total. Each is `LABEL[x] ?? x`, so an unmapped value renders as itself instead of as a blank chip.
- `components/projects/QualityTab.tsx`: `CHECKLIST_KIND_LABEL[checklist.kind] ?? checklist.kind` and `TURNOVER_STATUS_LABEL[status] ?? status`.
- `app/(protected)/companies/page.tsx`: `COMPANY_KIND_LABEL[c.kind] ?? c.kind`.
- `app/(protected)/companies/[id]/page.tsx`: `COMPANY_KIND_LABEL[company.kind] ?? company.kind` and `EVENT_KIND_LABEL[e.kind] ?? e.kind`.
- `components/projects/cost/QuotesPanel.tsx`: the bid table's status chip reads through `costDocStatusLabel(status)` (J3's total helper) instead of `COST_DOC_STATUS_LABEL[status]`.
- `components/projects/cost/ChangeOrdersPanel.tsx`: the reason donut uses `CO_REASON_LABEL[r.reason] ?? r.reason`.
- The other bare indexings in these files are `<option>` lists that iterate the label map's own keys, so they are total by construction.
- Tests: `lib/__tests__/j10bLabelsFormattersLinks.test.ts`:
  - "the Quality tab: an unmapped checklist kind and turnover status show their raw value" (rendered)
  - "census: every lookup the remainder named — and the bid tab's status chip and the change-order donut — falls back to the value itself"

**Done-when.**
1. ◐ Every lookup in the Projects and Companies surfaces is total except two in `lib/projectReport.ts`:
   - `:289` `CO_REASON_LABEL[x.reason]`, the closeout report's change-order line.
   - `:400` `CO_REASON_LABEL[r.reason]`, with `why[r.reason]`, in the coach text.

   That file is projects-joint J12's this round and is not edited here.
2. ✓ `fmtMoney(NaN)` never renders "$NaN" (J3).
3. ✓ The database rejects an unmapped value on every table the finding names:
   - `cost_documents.status` and `.kind`: `20261093` (J3).
   - Company kind and status, change-order reason and status, checklist kind and status, turnover status and punch status: CHECKs inline in the `CREATE TABLE`s of `20261013_project_controls_program.sql` (`:72, :74, :124-125, :144, :146, :180, :197`).
   - `companies.status`: also guarded by `20261095` for a table created before that file.

   No migration was needed.

**Scope / residual.** OPEN only for the two `lib/projectReport.ts` lookups in J12's file. The fix is `CO_REASON_LABEL[x] ?? x` at both sites and a fallback for `why[r.reason]` at `:400`. A zod row-validation layer is not attempted (DEC-31).

---

## REL-5 · One tab crashing unmounts the entire project page

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** availability
- **Locations:**
  - `app/(protected)/projects/[id]/page.tsx` — no per-tab boundary
  - `app/(protected)/error.tsx` — the only boundary, at segment level (well written; keeps the sidebar)
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The project page defines no error boundary, so a throw in any tab unmounts the whole route rather than the panel that failed.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The structural claim is right: no per-tab boundary, so one tab's crash takes the entire project page, and 'Try again' rebuilds the same crashing tab because the tab lives in the URL. The summary overstates the consequence: app/(protected)/error.tsx renders inside app/(protected)/layout.tsx — its own header comment says 'lands here — INSIDE the layout — so the sidebar and navigation stay alive' — so Sidebar and TopBar survive and Schedule is reachable by navigating back with ?tab=schedule. MEDIUM: this is missing defense-in-depth, and it only bites once some other bug throws.

**Mechanism.** An unhandled render exception anywhere in `CostsTab`,
`QualityTab` or `ScheduleTab` takes the header, the tab bar, the coach and the
status controls with it.

**Failure scenario.** The user is left with "Try again", which re-renders the
same crashing tree, and "Dashboard". There is no way to escape to a working tab
— so a bug in Costs makes Schedule unreachable too.

**Remediation.** Wrap each tab's content in a small error boundary that renders
"this tab couldn't load — [retry]" while leaving the rest of the page intact.
About fifteen lines.

**Done when.**
- A thrown error in one tab leaves the other six usable.

**Resolution (2026-09-30, projects Round G).** Reproduced by absence: no `ErrorBoundary` existed in the repo; a throw in any tab unmounted the page to `app/(protected)/error.tsx`. New `components/projects/TabErrorBoundary.tsx` (a class boundary: fallback "The Costs tab couldn't load — the rest of the project page still works", a Retry, and `resetKey` so moving to another tab clears it). `app/(protected)/projects/[id]/page.tsx` renders every tab's content inside one boundary keyed on the tab, and the coach inside its own — the header, status strip and tab bar sit outside both.
- Commit: `9363ebb`
- Tests: `projectPageRoundG.test.ts` (jsdom) "the crashing tab renders its fallback; everything outside the boundary stays mounted", "moving to another tab clears the error (resetKey); Retry re-renders the tab", "the project page wraps the tab content and the coach in boundaries keyed on the tab" (all seven tabs inside it).

**Done-when.**
- A thrown error in one tab leaves the other six usable — ✓.

**Scope / residual.** None.

---

## REL-6 · Nothing tests any data layer, any new route's authorization, or any policy

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** projects-joint J13 RECORDS RECONCILE (new; the remainder appears landed — independently verified before any flip) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** regression risk
- **Locations:**
  - `lib/__tests__/projectControls.test.ts` — 17 tests, all pure functions
  - Untested: `costDocs`, `changeOrders`, `checklists`, `turnover`, `companies`, `projectSnapshot`, `projectReport`, `docFileServer` — none imported by any test
  - `app/api/projects/cost-docs/route.ts:68-72` (controller **or** project owner), `app/api/projects/checklist/route.ts:67` (any active member), `app/api/companies/quality-manual/route.ts:46` (Admin/DocCtrl only) — three different authority models, none pinned
  - `lib/__tests__/apiRouteAuth.test.ts` — **the harness already exists**
  - `vitest.config.ts` — `include: ["lib/__tests__/**/*.test.ts"]`, `environment: "node"`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `lib/__tests__/projectControls.test.ts` covers pure computation; no test exercises a data-layer function, a route's authorization, or an RLS policy in this area.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Every part of the absence claim survives a repo-wide search: no data-layer module is imported by any test, the three new AI routes are absent from the only route-auth suite, and no policy or migration is exercised anywhere. HIGH is fair — the untested surface is exactly where REL-2 (dropped errors) and REL-3 (raw messages) live, which is why those defects could ship green.

**Mechanism.** The 17 new tests are good and cover the pure engines thoroughly,
including seven well-chosen regression pins. They do not touch anything that
talks to the database, and there are no policy tests of any kind in the
repository — so the new `SECURITY DEFINER` helper and twelve new policies ship
unverified.

`apiRouteAuth.test.ts` is precisely the missing pattern — a hoisted mock state,
a chainable Proxy mock of `@/lib/supabaseAdmin`, `POST(new NextRequest(...))`,
asserting 401/403/400/200. Its header states the motive: *"CI previously ran
zero tests above lib/, so a broken auth check on a route shipped green."*

**Remediation, in priority order.**
1. **The four routes' authorization**, in the existing harness — no config
   change needed. No token → 401; non-member → 403; member-not-owner-not-
   controller on cost-docs → 403; non-Admin on quality-manual → 403; plain
   member on checklist → 200. **Cheapest large win in the audit.**
2. `awardQuote` where the post fails *and* the revert fails (`MON-1`).
3. `voidCostDoc` against an awarded doc (`MON-3`).
4. `gatherCompanyProfile` with a fully-populated fixture — would have caught
   `MON-7` in one assertion.
5. `gatherProjectSnapshot` with one query erroring — assert it is
   distinguishable from an empty project, so the closeout gates cannot lie.
6. `computeChecklistProgress` / `computeTurnoverProgress` / `seedsForJobKind` —
   pure, ~20 lines of tests, and they feed the gates and the report.
7. `applyAssessment` never overwrites a manual note — the product's central
   promise, currently unpinned.

**Done when.**
- All four routes have authorization tests.
- The money paths have failure-mode tests.
- `gatherProjectSnapshot`'s error case is distinguishable from empty, and tested.

**Partial (2026-09-30, projects Round G).** The route limb — the finding's priority 1. `lib/__tests__/apiRouteAuth.test.ts` now covers the four project-controls routes in the existing harness (hoisted state and the Proxy chain over `supabaseAdmin`, plus per-call `.maybeSingle()` and RPC overrides and mocks for the page renderer, the governed model call and R2): `/api/projects/cost-docs` (controller or project owner — no token and a bad token 401, non-member 403, a foreign project 404, a Manager who is neither owner nor controller 403 before the cost row is read, the owner and an additively-held DocCtrl admitted); `/api/projects/checklist` (any active member — 401, a non-member and a suspended member 403, a foreign project 404, a plain member 200, and the `SEC-10` ACL cases); `/api/companies/quality-manual` (controllers only — 401, a non-member 403, a Manager 403, an additive DocCtrl admitted, the `SEC-10` / `DEC-43` cases); `/api/intake/upload` (the token is the credential — a malformed token 400 before any lookup, an unknown token 404, a revoked or expired link 410, a live link passing on to the payload check, and nothing stored on any refusal). The cost-docs and intake routes are not edited (P3's and P1's). Reproduced: at `3ae0b06` none of the four routes appeared in any test.

**Done-when.**
- All four routes have authorization tests — ✓.
- The money paths have failure-mode tests — not done here: P3 MONEY-LEDGER's (`MON-1` award post-then-revert failure, `MON-3` void of an awarded document), not merged at this base.
- `gatherProjectSnapshot`'s error case is distinguishable from empty, and tested — ✓ by pointer: package J7 (`PERF-3`, report 09) — `lib/__tests__/projectSnapshot.test.ts` "names the table it could not read instead of presenting zeros as the truth" and the read-failure cases after it.

**Scope / residual.** Stays OPEN until P3's money-path failure tests land. Remediation items 4 (`gatherCompanyProfile` fixture) and 6-7 (checklist / turnover progress, `applyAssessment`) belong to the packages that own those libraries (P9, P2).

**Resolution (2026-10-01, projects Round G).** Record reconcile by package J13 RECORDS RECONCILE: no application code, test or migration changed here. The limb the 2026-09-30 Partial left open was the money paths' failure-mode tests, which were P3's. They landed with joint package J3 MONEY-LEDGER (commit `ff3c1a8` and its fix passes; merge `9b4c5f4`, merged after J9's `2a2ae73` wrote the Partial). The record was never flipped. Verified against HEAD `4dd0df7`, each test file run at HEAD.

**Done-when.**
- ✓ All four routes have authorization tests: `lib/__tests__/apiRouteAuth.test.ts` covers `/api/projects/checklist` (:481), `/api/companies/quality-manual` (:826), `/api/projects/cost-docs` (:913) and `/api/intake/upload` (:966). Exit 0 (61 passed).
- ✓ The money paths have failure-mode tests, in `lib/__tests__/costDocs.test.ts` (exit 0, 63 passed):
  - remediation item 2 (an award whose post fails and whose revert fails): "MON-1: post failure + revert failure is reported as STUCK with the document id, never silence" (:325);
  - remediation item 3 (a void against an awarded document): "voiding a document whose stored status is awarded is refused even when the snapshot says parsed" (:177) and "a void that loses the race (zero rows matched) is reported…" (:186);
  - "COST-11: a failed rival-decline is a PARTIAL outcome…" (:346);
  - "COST-11: post failure + revert failure names the CO as stuck; a saved-link failure is a warning on success" (:532);
  - "SAF-3: a zero-row void (RLS-filtered) returns the permission-or-changed error and writes NO audit row" (:1028);
  - "MON-12: a failed company lookup REFUSES the award instead of passing it" (:957).
- ✓ `gatherProjectSnapshot`'s error case is distinguishable from empty, and tested: `lib/__tests__/projectSnapshot.test.ts` "names the table it could not read instead of presenting zeros as the truth" (:170). Exit 0 (36 passed). Package J7, `PERF-3`.

**Scope / residual.** Remediation items 4 and 6-7 were never done-whens. *Corrected by the integrator at the J13 merge (final review):* this said they were "covered now anyway"; that holds for item 4 and item 7, and for one third of item 6:
- item 4, a populated `gatherCompanyProfile` fixture: `companiesRegistry.test.ts`, 18 passed;
- item 7, `applyAssessment` never overwrites a manual note: `checklists.test.ts` "…a human-decided one is left alone" (:148);
- item 6: only `computeTurnoverProgress` is tested (`turnover.test.ts` "reports accepted and waived separately; pct still counts both as met", :193). `computeChecklistProgress` (`lib/checklists.ts:945`) and `seedsForJobKind` (`lib/turnover.ts:141`) still have no test.

The money and quality rails carry migration shape tests (`moneyRailsMigration.test.ts`, `qualityRailsMigration.test.ts`). No test runs a live Postgres, which is this area's stated limit.

---

## REL-7 · The schema-health panel reports green when this feature's migration is missing

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** diagnosability
- **Locations:**
  - `lib/schemaExpectations.ts:29+` — `EXPECTED_TABLES` / `EXPECTED_COLUMNS`
  - Its own header: *"When a new migration creates a table, add it here — the health panel is only as honest as this list."*
- **Re-verified:** hardening pass — **SURVIVES**. `EXPECTED_TABLES` is a hand-maintained literal (`schemaExpectations.ts:29`), so a table this feature's migration adds is absent from the expectation set and its absence reads as green.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence and by a repo-wide search: nothing else feeds the health probe, so a database missing 20261013 reports healthy:true. The silent-empty half is also real — lib/checklists.ts:96 `const { data } = await supabase.from("project_checklists")...` discards the error and returns [], and lib/companies.ts:246-252 wraps every 20261013 table in `safe(...)`.

**Mechanism.** Migration `20261013` creates `change_orders`, `companies`,
`company_events`, `project_checklists`, `checklist_items`, `turnover_items`,
`punch_items`, and adds `cost_documents.rfq_group`,
`cost_documents.intake_link_id`, `project_intake_links.purpose`,
`project_intake_links.rfq_group`, `cost_entries.created_by_name`. **None of them
appear in the expectations list** (verified by grep: `change_orders: 0`,
`companies: 0`, `company_events: 0`).

**Failure scenario.** Migrations are applied by hand. `20261013` is skipped,
`/api/admin/schema-health` reports green, and the Costs and Quality tabs render
as empty, cheerful, apparently-working screens (`REL-2`).

**Remediation.** Add the seven tables and five columns. Then consider a tripwire
test — the export-coverage test already diffs table lists against
`CREATE TABLE` statements in `supabase/`; an equivalent for
`schemaExpectations.ts` would make this class of omission impossible.

**Done when.**
- Schema health reports red when `20261013` is unapplied.
- A tripwire prevents the next migration from being forgotten.

**Resolution (2026-09-30, projects Round G).** `lib/schemaExpectations.ts` `EXPECTED_TABLES` gains the seven tables `20261013_project_controls_program.sql` creates — `change_orders`, `checklist_items`, `companies`, `company_events`, `project_checklists`, `punch_items`, `turnover_items` — and `EXPECTED_COLUMNS` the five feature columns it adds to older tables — `cost_documents.rfq_group`, `cost_documents.intake_link_id`, `project_intake_links.purpose`, `project_intake_links.rfq_group`, `cost_entries.created_by_name` — each naming `20261013`, so `/api/admin/schema-health` lists it as the file to run. The file's header names the tripwire. Tests (`lib/__tests__/schemaExpectations.test.ts`): the rows exist and each column probe matches an `ADD COLUMN` really in `20261013`; against the real route, "unapplied: the seven tables and five columns are missing, healthy is false, and 20261013 is the file to run" and "applied: healthy"; the tripwire "no created table is missing from EXPECTED_TABLES" scans every `CREATE TABLE` in `supabase/migrations` (comments stripped, TEMP tables excluded; 97 tables). Reproduced first: against `3ae0b06` 4 of the 8 cases failed — the route reported the unapplied database healthy.

**Done-when.**
- Schema health reports red when `20261013` is unapplied — ✓ (pinned against the real route with the missing-relation / missing-column errors Postgres returns; not observed against a live database).
- A tripwire prevents the next migration from being forgotten — ✓: a migration that creates a table with no row fails the suite and names the table and file.

**Scope / residual.** Five tables were already unlisted when the tripwire landed — `answer_skills`, `document_markups`, `knowledge_line_traces`, `link_rules`, `process_flows` — and are grandfathered by name (each must be a real created table, so the exemption cannot hide a typo, and nothing may join it). Listing them is the regeneration owned by admin-and-org `BKP-14` / intelligence `ILIFE-12`. The silent-empty readers are `REL-2`'s. **Merge note (the tripwire turns red on three in-flight branches).** Each of these creates a table with no `EXPECTED_TABLES` row and does not edit `lib/schemaExpectations.ts`: `document_share_accesses` (`fleet/DC-P1-share`, `20261081_dc_roundF_share_access_log.sql`), `turnover_review_events` (`fleet/J2-quality`, `20261091_prj_roundG_quality_rails.sql`) and `milestone_baseline_history` (`fleet/J6a-schedule-import`, `20261099_prj_roundG_baseline_authority.sql`). Whichever merges after this package adds its row with the merge — `{ table: "<name>", migration: "<that file>" }`, the shape the 20261013 rows use — never a `GRANDFATHERED` entry (the exemption is closed).

---

## REL-8 · A retried intake submission double-creates the record, the notification and the counter

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:104, 121` — no dedupe key
  - `lib/companies.ts:304` — `submissionCount`, which the inflated counter feeds
- **Re-verified:** hardening pass — **SURVIVES**. The intake path inserts notifications (`intake/upload/route.ts:104`) and increments `submission_count` (`companies.ts:304`) with no idempotency key, so a client retry after a partial failure doubles both.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. No idempotency and no DB-level dedupe on the quote path or the new-document path, so a retried POST duplicates row + notification + counter. One partial mitigation the finding does not mention: a retried REVISION submission is caught by the pending-review guard at :257 (`if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored)) return bad(... 409)`), so only quotes and brand-new documents actually double-create. MEDIUM stands.

**Mechanism.** No idempotency key. A retried POST creates a second
`cost_documents` row and a second notification, and double-increments
`bump_intake_use`.

**Remediation.** Accept a client-generated idempotency key (or hash the file
bytes plus link plus filename) and return the original result on a repeat within
a window.

**Done when.**
- A retried upload of the same file returns the original record rather than creating a second.

**Resolution (2026-09-30, projects Round G).** A retried upload returns the original record. The door hashes the bytes (SHA-256) and, before storing anything, looks for a submission from the same link with the same hash in the last 24 hours that is still awaiting a decision (an in-review version — for a revision, on the same document — or a trusted publish; a draft quote): if found it answers 200 with the ORIGINAL ids and `duplicate: true`, stores nothing, notifies nobody and does not bump the counter. The database backstop (migration `20261105`): partial UNIQUE indexes on `(intake_link_id, file_hash)` over in-review versions and draft quotes, so two racing retries cannot both insert — the loser answers with the winner's record. A resubmission after a rejection is a new decision and is taken. Tests — `lib/__tests__/intakeUploadRoute.test.ts` "the same bytes resubmitted while the first is in review return the first record — nothing stored, nobody notified again", "a quote retried while still a draft returns the original quote".

**Fix pass (2026-09-30, projects Round G — J1 review).** The first landing treated any 'in_review' row with the same bytes as the original — including one the door itself had WITHDRAWN (a lost pointer race; only `superseded_at` was stamped) — so a contractor told "your submission was not taken — try again" got "This file was already received" with nothing in review, and the in-flight index (keyed without `superseded_at`) would have made that permanent; and the index and the winner lookup had no document in them, so the same PDF sent as a revision of document B while in review on document A answered with A's ids. Now (`app/api/intake/upload/route.ts`): the pre-check and the index see only LIVE rows (`superseded_at IS NULL`); `classifyPrior` accepts a hit as the original only when its document still points at it AND it is the record this request would have made (the same document, or — for a new-document upload — a new document still in its first review); the same bytes live on another submission are refused before storage with a sentence (`same_file_in_review`), never that document's ids; the door's own withdrawal resolves the row 'superseded' (`INTK-4`). The index stays keyed on (link, file hash) — deliberately without the document: a retried NEW-document upload creates a different document row, so a document-keyed index could not see the double-create this finding is about. A request that loses the race (the in-flight index, or a numbered new document's number held by its own original) answers with the original and removes the document and the stored object it made — no empty document in the intake folder. `20261105` re-creates the index over live rows (dropping any earlier draft of it) and converts intake rows withdrawn the older way to 'superseded'; its probe reads ok in the "duplicates kept the index from being made" world too. Tests — "a WITHDRAWN earlier row (superseded_at stamped) is not 'already received' — the resend is taken", "the door's own lost pointer race RESOLVES the new version ('superseded'), so the contractor's resend of the same file is taken", "the same bytes LIVE on another document answer with a sentence — never that document's ids — and nothing is stored", "a retry that lost the in-flight index answers with the original — and removes the document and the object it made", "a numbered new document whose retry raced its original answers with the original, never 'number already in use'"; `lib/__tests__/intakeDoorMigration.test.ts` (the live-row index, the conversion, the conditional probe).

**Done-when.**
- [x] A retried upload of the same file returns the original record rather than creating a second — ✓ (the LIVE original of the same record; fix pass above).

**Scope / residual.** Pending migration: `20261105` (the race backstop, and `cost_documents.file_hash` — until it is applied a retried QUOTE is not detected; document retries are, `file_hash` exists on versions). The same file cannot be in review on two documents from one link at once (refused with a sentence). A numbered new document whose original has not yet written its version (a window of milliseconds) still reads "number already in use" to the racing retry. A true orphan (in review, nothing points at it, nothing withdrew it) blocks a resend of its bytes until a controller resolves it — the maintenance cron's health line counts those.

---

## REL-9 · Six states are declared, accepted by the data layer, and reachable from no interface

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J10b UI REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (each by grep)
- **Blast radius:** dead-end / feature-gap
- **Locations:**
  - `lib/checklists.ts:216` — `status: 'void'` accepted; only caller passes `"complete"` (`QualityTab.tsx:337`); `QualityTab.tsx:124, 135` filter `!== "void"` — also dead
  - `lib/changeOrders.ts:192` — `status: 'void'` accepted; `ChangeOrdersPanel.tsx:178-186` renders only Approve/Reject, so `CHANGE_ORDER_VOIDED` can never be emitted
  - `lib/costDocs.ts:20` — `kind: "po"`, no creator; and `cost_documents.kind` has no CHECK
  - `lib/companies.ts:24` — `status: 'inactive'` changes nothing anywhere
  - `lib/changeOrders.ts:186` — `posted_entry_id` written, read by nothing
  - `components/projects/ProjectWizard.tsx:147` — `setup_state` written, read by nothing
  - `lib/checklists.ts:188` — `addEvidence` has no callers; `documentId`/`href` never populated, and `QualityTab.tsx:458` renders evidence as a `<span>`, so even a populated href would be inert
  - `lib/checklists.ts:284, 292` — `equipmentTags` gathered by a 1000-row query on every sweep, read by no rule
  - `app/(protected)/companies/[id]/page.tsx:405` — `HistoryPanels` takes `scorecard` then `void scorecard;`
  - `lib/projectHealth.ts:57, 145` — `trend` is the literal type `"steady"` and is never rendered
- **Re-verified:** hardening pass — **SURVIVES**. `status: "open" | "complete" | "void"` is accepted by the data layer (`checklists.ts:216`) and `CHANGE_ORDER_VOIDED` is a declared outcome (`changeOrders.ts:192`) — states the API honours and no interface can reach.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The two load-bearing claims are correct, each confirmed by repo-wide grep: no interface can void a checklist (the only project_checklists delete is the createChecklist rollback at checklists.ts:137) and no interface can unwind an approved CO. One bullet is loose: company `status: 'inactive'` IS reachable — app/(protected)/companies/[id]/page.tsx:524 `<option value="inactive">` and it renders as a badge at companies/page.tsx:189 — so it is a state with no behavioral effect, not an unreachable one. Doesn't change the severity.

**Mechanism.** Each is a capability that exists in the data layer and cannot be
reached.

**Failure scenario.** The two that bite users: **a checklist created by mistake
can never be voided or deleted**, and **approving a change order is
irreversible from the interface** — to unwind it you must hunt the entry down
in the accounts panel and void it, after which the change-order row still reads
`approved` while its money is gone. That last one is worse because
`posted_entry_id` exists specifically to make the unwind exact, with a comment
saying so, and nothing reads it.

**Remediation.** Decide per item: wire it up or delete it. Priorities — add a
void action for checklists; add a void action for change orders that reads
`posted_entry_id` and voids exactly that entry; drop `kind: "po"`,
`status: 'inactive'`, `trend`, and the unused `equipmentTags` query (which is
also pure cost, per report `09`).

**Done when.**
- A mistaken checklist can be voided.
- An approved change order can be unwound in one action that voids exactly its entry.
- The remaining dead declarations are removed.

*Landed 2026-09-29 (projects Round G, J4 limb): `companies.status = 'inactive'` now has one visible effect: the bid tab shows an "inactive" chip beside a bidder resolved to an inactive registry row (`QuotesPanel.tsx`), and 20261095 guards the status CHECK. Whether `inactive` should filter or block closes in P3.*

**Partial (2026-09-29, projects Round G — the change-order unwind and the dead cost states; the checklist void is P2/J2's, companies `inactive` is P9's).** Joint J3 MONEY-LEDGER (projects-and-cost pair `COST-9`). `lib/changeOrders.ts`: `ChangeOrder` maps `postedEntryId` (and `createdBy` / `decidedBy` / `selfDecided`); `unwindChangeOrder({ co, note, actorId })` reverses an approved CO in one action — voids EXACTLY `posted_entry_id` through `lib/costs.voidEntry`, then claims the CO approved → void, and records `CHANGE_ORDER_VOIDED` with `reversedEntryId` (the outcome that could never be emitted). *(As first shipped it claimed the CO first and put it back when the entry void failed; that order and its put-back were replaced in the verification fixes below — the current flow is the second and third passes.)* `components/projects/cost/ChangeOrdersPanel.tsx` renders "Reverse" on approved rows (reason prompt; the parent's rollup refreshes). A CO with no linked entry is refused and pointed at the "Ledger needs attention" line. `posted_entry_id` is now read by the unwind, the orphans query and the Costs tab's entry-row source label. `CostEntry.sourceDocumentId` is populated by award / post (`COST-9`).
- Review fix pass 2: at the base the only unwind was voiding the CO's entry by hand on the Costs tab, which left the CO "approved"; the first cut's Reverse then failed on exactly those rows (`voidEntry` matched zero rows on an already-void entry and the CO was put back) and nothing listed them. Now `unwindChangeOrder` re-reads the entry on a zero-row void and, when it is already `void`, completes — the CO goes void and `CHANGE_ORDER_VOIDED` records `alreadyVoided: true` (no second void, no second audit row on the entry). Such approvals stop revising the budget (`COST-4`), are listed under "Ledger needs attention", and `repairChangeOrder` links or reverses them (`COST-11` dw3). A reversal's note names the reverser and the date ("Reversed by bob on 2026-09-30: …") while `decided_by` keeps the approver, and the CO row reads "approved by <approver> on <date> · reversed" instead of crediting the approver with the void.
- Tests: `lib/__tests__/costDocs.test.ts` — "the unwind voids EXACTLY posted_entry_id, marks the CO void and records the entry id" (now also pins the reverser's note and the approver kept), "an unwind with no linked entry is refused …; a failed void changes nothing" (as first shipped: "… a failed void puts the CO back"), "Reverse on an approved CO whose entry is ALREADY void voids the CO (alreadyVoided) instead of putting it back".
- **Verification fix (2026-09-30, projects Round G).** An independent verification pass found Reverse on a CO whose entry is already void skipped the look-alike check `repairChangeOrder`'s reverse enforces — a CO whose entry was voided and its money re-posted by hand (a posted, unlinked commitment carrying the CO number on its line) could be voided while that money stayed on the ledger with no change order behind it. `lib/changeOrders.ts` `unwindChangeOrder` now reads the linked entry BEFORE the claim: already void → the same `lookalikeEntries` check, refused while such a commitment remains ("… link it under "Ledger needs attention" … or void it by hand first"); missing → refused before anything is written, pointing at "Ledger needs attention". Tests: "REL-9 (verification fix): Reverse on an already-void entry applies the repair's look-alike check …"; "an unwind with no linked entry is refused …" pins the missing-entry refusal.
- **Verification fix, second pass (2026-09-30, projects Round G).** The claim-first unwind needed a void → approved put-back when the entry void failed, and the `20261094` branch that admitted it was exploitable (a CO inserted with a preset link could be withdrawn and "put back" to approved — `COST-6`). `unwindChangeOrder` now moves the money FIRST: it voids exactly `posted_entry_id` (a failed void changes nothing — the CO stays approved, and the error says so), then claims the CO approved → void with the compare-and-swap. There is no put-back, and void is terminal at the database for signed-in callers (the CO in `20261094`, the entry in `20261093`). If the CO claim fails after the entry was voided, the error says so and the CO — approved, its entry void — no longer revises the budget and is listed under "Ledger needs attention", where Reverse finishes it (`alreadyVoided`); a concurrent reversal that won is named ("Someone else just reversed CO-…"). An entry found void when the void was attempted (a concurrent unwind or a hand void) gets the look-alike check too, before the CO is claimed. Tests: "an unwind with no linked entry is refused …; a failed void changes nothing", "second verification fix: the unwind voids the entry BEFORE the CO — a CO claim that then fails is said out loud and leaves a listed orphan …".
- **Verification fix, third pass (2026-09-30, projects Round G).** The money-first claim matched only `status = 'approved'`: between the entry void and the claim a second user could repair-link the CO to a posted look-alike (the guard allows repointing away from a void entry), and the claim still voided the CO — void over a posted entry that `cost_ledger_orphans` does not list. The claim now also carries `.eq("posted_entry_id", entryId)` (the link it voided); on zero rows the lib re-reads and says whether someone else reversed it or it was re-linked ("… was re-linked to another cost entry while it was being reversed — its old entry is void, and it stays approved on the new one"). Test: "third verification fix: the unwind's claim is pinned to the link it voided …"; the second-pass test's title no longer claims "never a void CO over posted money" (a posted look-alike the unwind was not asked about can still remain beside a reversed CO).

**Done-when.**
1. ✗ NOT DONE HERE — a mistaken checklist's void is J2's (`lib/checklists.ts` / QualityTab).
2. ✓ An approved change order can be unwound in one action that voids exactly its entry — including one whose entry was already voided by hand.
3. ✗ Partly — `posted_entry_id` is no longer dead. `kind: "po"` is RETAINED (the `20261093` CHECK admits it so a restored row cannot violate it; there is still no creator) and `companies.status: 'inactive'` gained behaviour in `MON-12` instead of being removed; `trend`, `equipmentTags`, `HistoryPanels`' `scorecard`, `setup_state` and `addEvidence` are other packages' files.

**Scope / residual.** OPEN for J2's checklist void and the remaining dead declarations outside the money files.

**Partial (2026-10-01, projects Round G).** Package J10b UI REMAINDERS landed the checklist void and removed one dead declaration.
- **The checklist void.** `components/projects/QualityTab.tsx` `ChecklistCard` offers "Void checklist" on an open or completed checklist, to the controller tier only.
  - The tier is `isControllerPrincipal({ role: activeRole, roles })` (`lib/permissions.ts`). It mirrors `is_org_controller`, Admin or DocCtrl held as the active role or in `roles[]`, which is the tier the database rail `project_checklists_signoff_rail` (`20261136`, QUAL-15) admits a void from.
  - The dialog says what voiding does. For a signed-off checklist it also says the sign-off leaves the closeout count with it.
  - It asks for a reason, required at the record's bar (`REASON_MIN_LENGTH`, an `appPrompt` with the danger tone). `project_checklists` has no reason column and no `voided_by`: `20261136` stamps only `status_changed_at`. So the void's `CHECKLIST_STATUS` audit row is its only record of who voided it and why, and closeout names the voider from that row (`lib/projectSnapshot.ts`).
  - Confirming writes `void` through `lib/checklists.setChecklistStatus`, the checked write. *Review fix:* for a void, that function's audit insert is now CHECKED (`auditChecked`). The reason goes on the row (`details.reason`, trimmed, and absent when blank). A failed insert, whether refused or thrown, comes back as `auditError` on the void that landed, where the first pass dropped it silently (`audit()` swallows every failure). The tab then says so in the Checklists section's notice, which outlives the card: "The checklist "…" was voided, but its audit record failed (…) — the void is not recorded under your name, so closeout cannot say who voided it or why." The other statuses' audit rows keep their old shape.
  - A refusal shows the rail's sentence on the card, and nothing else changes.
  - On success the tab re-reads, so the card leaves the list and the `!== "void"` filters are no longer dead, and the page is told (`afterWrite`, `PERF-4`).
  - The project owner, a sign-off grantee and every other role see no control, and the rail would refuse them anyway. DEC-35 holds: the tab names no role literal.
- **The dead `scorecard` prop.** In `app/(protected)/companies/[id]/page.tsx`, `HistoryPanels` no longer takes the `scorecard` it discarded. `void scorecard;` is gone, and the dial above is the scorecard's only reader on the page.
- Tests: `lib/__tests__/j10bChecklistVoid.test.ts`.
  - Rendered: a controller (DocCtrl in `roles[]` beside a headline Engineer role) voids an open checklist. The test checks the prompt's wording and its required reason at `REASON_MIN_LENGTH`, the lib write carrying the trimmed reason, the card leaving and the page being told.
  - Rendered: the void lands but its audit row fails. The section's alert names the failure after the card has left the list, and the page is still told.
  - Rendered: a completed checklist's prompt, and that cancelling it writes nothing.
  - Rendered: a refusal shown on the card.
  - Rendered: no control for no role, Engineer, Manager + Supervisor, or Viewer.
  - Source: the client gate pinned against `isControllerPrincipal`, the 20261136 rail and the controller predicate.
  - Source: `HistoryPanels`' signature.

  In `lib/__tests__/qualitySignoff.test.ts`, "tab calls setChecklistStatus …" now counts the complete call and the void call (with its reason), and still finds no reopen. Two lib tests run against the in-memory database:
  - A void's audit row carries the reason. An RLS refusal of the audit insert comes back as `auditError` ("You don't have permission to do this."), while the checklist is still void. A reopen's result is unchanged.
  - A blank reason records no `reason` key.

**Done-when.**
1. ✓ A mistaken checklist can be voided, by the tier the database lets void it.
2. ✓ An approved change order can be unwound in one action (J3, 2026-09-29/30).
3. ◐ The remaining dead declarations. ✓ `HistoryPanels`' `scorecard` is removed. These remain, none of them in this package's file list:
   - `equipmentTags` (`lib/checklists.ts:753`): gathered for the sweep and read by no rule.
   - `trend` (`lib/projectHealth.ts`): J12's file this round.
   - `setup_state` (`lib/projectWizardWrites.ts:126`): written, with no reader found by grep.
   - `addEvidence` (`lib/checklists.ts` `updateChecklistItem`): a patch field with no interface caller.
   - `kind: "po"`: retained under J3's CHECK decision.

**Scope / residual.** OPEN for the dead declarations above, which belong to the owners of those files. `lib/checklists.ts` is outside this package's file list. Its edit is confined to `setChecklistStatus`'s void audit plus one new private helper, and it is reported as `filesOutsidePlan`. Notifications N8 adds `emit()` calls to the same file, so the integrator should expect a merge. The comment on the `20261136` rail ("no product path reopens or voids a checklist") is now stale on voids. That file is a migration, so the integrator notes it rather than editing it.

---

## REL-10 · Example charts can appear on a project that has real data, and the watermark is effectively invisible

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** trust
- **Locations:**
  - `components/projects/cost/CostCharts.tsx:45` — `hasRealData = rollup.budget > 0 || entries.some(e => e.status !== "void")`
  - `components/projects/CostsTab.tsx:484` — a blank budget is stored as 0
  - `components/ui/ChartKit.tsx:280-284` — the watermark, `opacity-[0.07]`, `aria-hidden`
  - `components/ui/ChartKit.tsx:285-288` — the amber chip, the only durable signal
  - `components/projects/cost/CostCharts.tsx:86` — `ForecastSentence`, unmarked
- **Related:** `REL-2`
- **Re-verified:** hardening pass — **SURVIVES**. `hasRealData = rollup.budget > 0 || entries.some((e) => e.status !== "void")` (`CostCharts.tsx:45`) is an OR, so a project with a budget and no entries — or entries and no budget — can satisfy one branch while other panels still render example series.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. A 7%-opacity rotated word is below the threshold of a screenshot or a print, and every real signal ('Example data' chip, dashed border) is at the frame's top edge, so cropping to the forecast box or the S-curve yields something visually identical to live numbers. The 'project that has real data' path is real but indirect: it needs rollup.budget to compute to 0 with every entry voided — or, more plausibly, the silent-failure path in REL-2, which turns accounts/entries into empty arrays.

**Mechanism.** Two live routes back into example mode: voiding every entry on
budget-less accounts, and — more likely — **creating a chart of accounts before
setting budgets**, which is the natural order. It does not persist past the
first real entry, which is correct.

The watermark is the page's text colour at 7% opacity (≈1.08:1 contrast) and is
`aria-hidden`. Everything below the chip is unmarked, including the most
quotable element on the screen: a full-width green panel reading *"At this
performance you'll finish around $287,736 — $17,264 under budget."* The S-curve
legend prints bold real-looking figures. The bar list prints
`01-100 Piping subcontract $121,300 · of $190,000 budget`.

**Failure scenario.** A superintendent screenshots the region below the chip —
by cropping, or by capturing just the forecast box — and sends it to a VP. It is
indistinguishable from a real forecast.

**Remediation.**
1. Mark every figure inside `ExampleFrame`, not just the frame: prefix the
   forecast sentence with "Example — ", and add the word to the legend and the
   bar sublabels.
2. Make `hasRealData` count accounts as well as budget, so a chart of accounts
   with zero budgets does not read as an empty project.
3. Raise the watermark's contrast and repeat it, or replace it with a
   diagonal banner that survives a crop.

**Done when.**
- No dollar figure inside the example frame is unmarked.
- A project with accounts but no budgets does not show example data.

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS; `DEC-55` rule 3 (the brief's default). `components/projects/cost/CostCharts.tsx:136`: `hasRealData = rollup.accounts.length > 0 || entries.length > 0`. The example renders ONLY for a project with no accounts AND no entries. A chart of accounts whose budgets are still blank, the natural order of setup, gets its own sparse real picture: the explanation panel and the burn list (`REL-11`). So does a ledger whose every entry was voided. Every figure inside the example is marked in its own element. The forecast sentence reads "Example — At this performance …". The S-curve legend values, budget label and per-point tooltips carry "(example)" / "Example —". Its `aria-label` begins "Example cost curve, not this project's numbers". Each burn-list value and sublabel says "(example)", and the crew stat reads "≈ 3.9 people (example)". The watermark sits inside the figure: `SCurveChart`'s `example` flag draws "EXAMPLE" twice across the plot at 13% ink, so no crop of the chart loses it. `BarList` takes the same flag. The frame's own watermark is raised from 7% to 12%. The example also formats in the project's currency formatter (`fmt`), not a literal "USD".
- Review fix pass: a failed FIRST load. `accounts` and `entries` start as empty arrays in `components/projects/CostsTab.tsx`, so when the first read failed, the charts took the tab for an empty project and drew the example under the error banner. The note "No budget lines or entries yet … Add a budget line below and it goes live" appeared on a project that may hold millions. The tab now keeps a `loaded` flag that only a successful `refresh()` sets. Until that happens it does not render `CostCharts`. The second review fix pass extended the same gate to every section that draws from the read: the tab renders the banner and one stated failure panel (`data-empty="cost-data"`, with a Try again button), recorded as `REL-2`'s Verification fix. A later failed refresh keeps the last good read on screen, as before. This is a further edit to `CostsTab.tsx`, outside this package's plan (see `MON-2`).
- Tests: `lib/__tests__/costsTabFirstLoad.test.ts` (new) — "the first read rejects: the banner and one stated failure panel with a retry — no example, no $0 tiles, no invitation to start over" (no watermark, no "example" anywhere on the tab; Try again then draws the real burn list) and "a successful first read of an empty project still shows the example (the one place it belongs)". The first failed on the package's first head (`d226bb3`). `lib/__tests__/costChartsRender.test.ts` — "a project with no accounts and no entries sees the example; every money figure says so". It walks every text node carrying a money figure. Each one inside the chart's SVG sits on a canvas with two in-plot watermarks, and each one outside carries "example" in its own element or row. The forecast starts "Example —" and the crew says "(example)". "a chart of accounts with blank budgets is a real project — no example numbers"; "a ledger whose every entry was voided is a real project too"; `lib/__tests__/chartKit.test.ts` "the S-curve repeats its watermark inside the plot and every legend figure says example", "BarList marks each value when it draws example data". Reproduced at the base: `hasRealData = rollup.budget > 0 || entries.some(…)`, and the forecast sentence, legend and bar figures were unmarked.

**Done-when.**
1. ✓ No dollar figure inside the example frame is unmarked. Legend, labels, tooltips, sentence, bars and crew carry the word. The S-curve's compact axis ticks sit on a canvas that carries the in-plot watermark twice.
2. ✓ A project with accounts but no budgets does not show example data.

**Scope / residual.** The first version of this block said that because `REL-2`'s loaders now throw, a failed load could no longer bring the example back. That was wrong for the FIRST load: the loaders throw, but the state keeps its initial empty arrays. The `loaded` flag above closes that case for the charts. The first fix pass left the rest of the tab showing that empty initial state under the banner ($0.00 tiles, "No cost accounts yet … Create the first one above"), tracked only as a pointer here. The second review fix pass closed it with the same flag, and it is recorded where it belongs, as `REL-2`'s Verification fix.

---

## REL-11 · The example promises four charts; the real interface can draw at most two

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux / expectation
- **Locations:**
  - `components/projects/cost/CostCharts.tsx:89-99` — the example branch, containing `BarList`
  - `components/ui/ChartKit.tsx:134` — `BarList`'s **only** call site in the entire app
  - `components/projects/cost/CostCharts.tsx:123-129` — the real branch
  - `components/projects/cost/CostCharts.tsx:84, 95` — example hardcodes `"USD"`
  - `components/projects/cost/CostCharts.tsx:107` — `return null` when there is a budget but no schedule and no entries
  - `components/projects/cost/CostCharts.tsx:115-119` — the missing-planned-line hint, gated on the wrong condition
- **Re-verified:** hardening pass — **SURVIVES**. The example block renders four labelled panels (`CostCharts.tsx:89-94`), while the live path can produce at most two — the crew curve needs awarded labor hours and the burn-by-line needs entries.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — 'Burn by budget line' (ChartKit.tsx:134 BarList) is drawn only for stand-in data and can never appear for a project's own numbers, so the preview advertises a view the product does not have. The arithmetic in the title is loose (the example frame renders three charts plus the forecast sentence; the real path renders two charts plus the sentence), but the substantive defect is exactly as stated. MEDIUM stands.

**Mechanism.** "Burn by budget line" — arguably the most decision-useful cost
view — appears only inside the example branch. The crew curve additionally
requires an awarded quote **with parsed labour hours** *and* both schedule
endpoints.

Two adjacent defects in the same component:
- **The most common early state renders literally nothing.** With a budget but
  no schedule and no entries, `buildCostSeries` returns `[]` and the forecast
  returns null, so line 107 returns null — the chart region becomes a silent gap
  where four example visuals were a moment ago. The wizard's canonical first act
  is "add a budget", so this is the state right after onboarding.
- **The hint uses the wrong condition.** It renders on `!scheduleStart`, but the
  planned line is omitted when `hasPlan` is false — i.e.
  `budget <= 0 || !planStart || !planEnd`. **Measured:** budget 0 with a full
  schedule → planned line omitted, **no hint**.

**Remediation.** Render `BarList` for real data — it needs only accounts and
entries, both of which exist. Give the empty-chart state real copy ("add
milestones to see the spend curve") instead of returning null. Fix the hint's
condition to match `hasPlan`. Use the project currency in the example.

**Done when.**
- Burn-by-budget-line renders for real projects.
- A budget-only project sees an explanation rather than a blank region.
- The missing-planned-line hint fires whenever the line is missing.

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS; `DEC-55` rule 4 (the brief's default). `components/projects/cost/CostCharts.tsx`: the real picture and the example draw through one layout, `CostPictures`, so the example can only show what the real interface draws.
- Burn by budget line renders for real projects. `BarList` gets the rollup's accounts. Each row shows the line's spent, "X committed · of Y budget" against the revised budget, and the accounts table's "over budget" flag whenever the line is over budget on exposure (`DEC-50` rule 1). It draws up to `BURN_LINES_SHOWN` (8) lines, then says how many it shows, in what order, and that every line is in the accounts table below. Its currency, scale, order and flag are as corrected by the third and fourth review fix passes below.
- The budget-only state no longer returns null. With no dates the S-curve slot shows an explanation (`data-empty="spend-curve"`): "No spend curve yet — it needs dates. Add or import milestones to draw the planned pace against your budget, or post a commitment or an actual to start the spent line." The burn list still renders below it.
- The missing-planned-line hint fires whenever the line is absent (no planned value in the series), not only when `scheduleStart` is empty. It names why: no budget, no schedule dates, or both.
- The opposite empty state gets its own explanation (review fix pass). With a schedule, blank budgets and nothing posted, which is the state right after a schedule import, the series is all zeros. The Costs tab used to draw flat lines on a "$0 / $1" axis. It now shows `data-empty="spend-curve"` `data-reason="no-money"`: "No spend curve yet — there's no money to plot. Set a budget on a budget line to draw the planned pace across the schedule, or post a commitment or an actual to start the spent line." The dates-missing panel carries `data-reason="no-dates"`.
- The example uses the project's currency formatter instead of the hardcoded "USD", and it shows nothing the real interface cannot: the S-curve, the forecast, the planned average crew (`CHART-3`) and the burn list.
- Third review fix pass: currency and scale. As first landed, the list formatted every line in the project's first currency, while the accounts table below formats each line in its own. A CAD line with CA$45,000 spent read "$45,000" in the list and "CA$45,000" in the table. The list also scaled every bar to the biggest spender. So Scaffolding, $45k of $42k and over budget, drew shorter than Piping, $50k of $190k, in the same colour as the account bars below, which scale each line to its own budget. A line with nothing spent drew a 2% stub.
  - `components/projects/cost/CostCharts.tsx` `burnItem()` (:104) formats each row's spent, committed and budget with `fmtMoney` in the line's own currency, the table's own rule. (As this pass landed it, a line with no currency fell back to the project's first currency; the fourth pass reads it as USD, below.) `BarList` (`components/ui/ChartKit.tsx`) takes that text as `valueLabel`.
  - Each bar is the line's spent against its own revised budget (`of`), capped at the track, with committed as a paler `vizCat(1)` bar behind it (`ghost`). That is the account row's scale. Over budget on exposure, the bar takes the alarm colour (`--viz-down`), as the account bar turns rose.
  - `barPct()` draws no bar for a zero or negative value, or for a line with no budget, whose sublabel says "no budget set". As this pass landed it, any positive value drew at least 2%; the fourth pass drops that floor for a bar scaled to its own budget, below.
  - The order was spent ÷ the line's own budget (`byBurn`), then lines with no budget. A share of a line's own budget compares across currencies, so neither the bar lengths nor the order compare raw CAD, USD or JPY amounts. The fourth pass puts the alarms first, below.
  - The list states its scale beneath it, and adds "Each line is in its own currency." when the project has more than one.
  - The example draws through the same `burnItem()` and order. Its Piping line, $194,800 committed against a $190,000 budget, is over budget on exposure and draws the alarm colour, as the real view would. This pass flagged it "over-committed"; the fourth pass uses the table's word, "over budget".
- Fourth review fix pass: the alarms first, and one reading per line. The third pass ordered the list on spent ÷ budget alone and put every no-budget line last, then cut it at 8. The review's probe: nine lines at $50,000 of $100,000, a line with $250,000 committed on a $100,000 budget and nothing invoiced (over budget on exposure, `DEC-50` rule 1's early-job alarm), and a line with $400,000 spent on no budget. The list showed eight $50,000 lines and neither alarm. Projects usually have 10–60 cost accounts, so the cut is the normal case. The review also found three places where the list and the table read the same line differently.
  - Order. `byBurn()` (:91) sorts on `burnTier()` (:76): (0) over budget on exposure, furthest over first; (1) money on a line with no budget, which is infinitely through a budget of nothing, in the table's order; (2) every other line with a budget, furthest through it first on `max(spent, exposure) ÷ budget`, then on spent ÷ budget; (3) lines with no budget and no money. `BurnLine` carries the rollup's `exposure`; the example's single-party lines use `max(spent, committed)`. So no line that is merely further along can push an alarm off the list. If more than 8 lines are in alarm, the footer (`data-burn-cut`) counts the ones that did not fit: "Showing 8 of N: lines over budget first, then lines with money but no budget, then the lines furthest through their budgets. K more lines are over budget or unbudgeted and didn't fit. Every line is in the accounts table below."
  - Flag. `burnItem()` flags "over budget" whenever the line is over budget on exposure, the same test and the same word as the accounts table's row flag (`CostsTab.tsx`, `r.overBudget`). "over-committed" is gone. A line over on commitments alone still shows it in its sublabel: "$250,000 committed · of $100,000 budget".
  - Scale. `barPct(value, whole, floor = 0)` (`components/ui/ChartKit.tsx`) takes the floor as an argument. `BarList` keeps 2% only for a bar scaled to the list's largest value; a bar scaled to its own whole (`of`) is the plain share. The accounts table's row bar now takes its width from the same `barPct(r.spent, r.revisedBudget)`, so a line 1% through its budget draws 1% in both places.
  - Currency. `accountCurrency()` (`CostCharts.tsx:60`) is `(account.currency ?? "USD").toUpperCase()`, the rule `computeCostRollup` uses for `currencies` (`lib/costs.ts`) and so for the mixed-currency banner. The burn list, the accounts table's row and `AccountDetail` all use it. A legacy line with a NULL currency on a project whose first line is CAD now prints in $ in the list, the row and the detail, and the banner counts it as USD.
- Tests: `lib/__tests__/costChartsRender.test.ts` — "burn by budget line renders for a real project, the lines furthest through their budgets first", "more lines than the list shows point at the accounts table", "a budget-only project (no schedule, no entries) gets an explanation, not a blank region", "the missing-planned-line hint fires whenever the line is missing, and names why". That last one includes the audit's measured case: budget 0 with a full schedule leaves the line omitted and the hint present. All four failed at the base. "blank budgets and a schedule with nothing posted: an explanation, not flat lines on a '$1' axis" (review fix pass) failed on `d226bb3`. Third review fix pass, all failed on `d061f8e`:
  - `costChartsRender.test.ts`: "each bar is the line's spent against its OWN budget — the account bars' scale — with committed behind it"; "a line with nothing spent, or no budget to measure against, draws no stub"; "each line is in its OWN currency, as the accounts table formats it — never the project's first currency" (USD, CAD and JPY lines; the ¥5,000,000 line draws half its own budget).
  - `costsTabFirstLoad.test.ts`: "the burn list and the accounts table agree on every line: the same currency, the same scale" (the whole tab, mounted: each line's money text and bar width match between list and table).
  - `chartKit.test.ts`: "BarList draws nothing for nothing: no stub for a zero value or a zero whole", and the `valueLabel` case of "BarList marks each value when it draws example data".
  Fourth review fix pass, all failed on `0cfb99b`:
  - `costChartsRender.test.ts`: "the cut never drops an alarm: an over-committed line and an unbudgeted line with spend lead the list" (the review's eleven-line probe); "alarms beyond the cut are counted under the list, never dropped silently" (ten over-budget lines, two counted); "a legacy line with no currency is USD, as the rollup counts it — never the project's first currency"; and the reworded footer in "more lines than the list shows point at the accounts table".
  - `costsTabFirstLoad.test.ts`: "the burn list and the accounts table agree on every line: the same currency, the same scale, the same flag". The mounted tab now also has a CAD first line, a NULL-currency line, a line 1% through its budget, and a line over budget on exposure alone ($60,000 invoiced by one party, an $80,000 commitment to another, on $100,000). Money text, bar width and the flag word match for every line, and the banner reads "CAD, USD".
  - `chartKit.test.ts`: `barPct`'s floor argument and `BarList`'s 1% own-budget bar, in "BarList draws nothing for nothing …".

**Done-when.**
1. ✓ Burn-by-budget-line renders for real projects.
2. ✓ A budget-only project sees an explanation rather than a blank region.
3. ✓ The missing-planned-line hint fires whenever the line is missing.

**Scope / residual.** None in this component. The crew figure still needs an awarded quote with stated hours and a schedule span. Without them it is simply absent, and the example no longer promises a crew curve the real data cannot draw. On a mixed-currency project the list is now right line by line. The summed tiles and burn bar above it remain raw sums under the tab's existing mixed-currency banner, which is not this finding. The list still shows at most 8 lines. When more than 8 are in alarm, it shows the first 8 in that order (over-budget lines furthest over first, then unbudgeted lines carrying money in table order) and counts the rest under the list; the accounts table lists them all.


**Residual (2026-09-30, projects Round G — final review, not fixed).** A burn row can be flagged "over budget" while no number in the row is: the flag trips on exposure (spent plus open commitments), but the row shows spent, gross committed and budget (`components/projects/cost/CostCharts.tsx` ~:104). The row's title explains exposure, but the visible figures do not add up to the flag. Showing the exposure figure on flagged rows is left for the J10 surface sweep.

---

## Verified sound — do not "fix" these

- **Idempotency on the money paths is genuinely good.** `awardQuote` /
  `postInvoice` compare-and-swap before money moves and re-read for fresh
  totals; `decideChangeOrder` checks the row count and explicitly notes that
  PostgREST reports a zero-match update as success; `seedTurnoverItems`
  name-dedupes; `saveCompany` maps 23505 to human copy. Double-clicking Award,
  Post or Approve cannot double-post.
- **AI failure copy is well written at the route layer** — 412/428/402 with
  actionable messages, 502 for malformed JSON, 415 with "ask the vendor for a
  PDF", "the file may be corrupt or password-protected". The honesty is written;
  it is the plumbing that loses it (`UX-8`, `UX-9`).
- **Export/restore parity is enforced by a tripwire test** and all seven new
  tables were added to both lists in FK-safe order. *Caveat: the tripwire matches
  `CREATE TABLE`, so the eight new `ALTER TABLE … ADD COLUMN` statements are
  outside its reach — which is how `REL-7` happened.*

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| REL-1 | HIGH | RESOLVED |
| REL-2 | HIGH | RESOLVED |
| REL-3 | HIGH | OPEN |
| REL-4 | HIGH | OPEN |
| REL-5 | HIGH | RESOLVED |
| REL-6 | HIGH | RESOLVED |
| REL-7 | HIGH | RESOLVED |
| REL-8 | MEDIUM | RESOLVED |
| REL-9 | MEDIUM | OPEN |
| REL-10 | MEDIUM | RESOLVED |
| REL-11 | MEDIUM | RESOLVED |
