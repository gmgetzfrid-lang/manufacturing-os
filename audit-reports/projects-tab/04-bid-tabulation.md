# 04 · Bid tabulation & the award decision

The screen that decides who gets the work.

The trust question for this surface is whether an AI-read figure is
distinguishable from a human-verified one. **It is not** — there is no
provenance marker of any kind, no link to the source PDF, and in one case the
number the table shows is not the number the award posts.

**12 findings** — 4 CRITICAL, 5 HIGH, 3 MEDIUM.

> Figures marked **measured** are program output: the pure scoring logic was
> executed under Node with adversarial inputs. Line numbers drift — **match on
> the quoted code.** See [`../README.md`](../README.md) for the protocol.

---

## BID-1 · The table scores the AI's total; the Award button posts the human's corrected total

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** financial / decision-quality
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:195-203` — `parsed` and `econ`, built from the stored extraction
  - `components/projects/cost/QuotesPanel.tsx:298` — the Price column
  - `components/projects/cost/QuotesPanel.tsx:213` — the client-side award total, which *does* prefer the human number
  - `lib/costDocs.ts:226` — `const total = fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total`
  - `lib/costDocs.ts:323-334` — `setManualTotal`, which writes only `total_amount`
- **Related:** `BID-2`, `BID-9`, `MON-3`
- **Re-verified:** hardening pass — **SURVIVES**, and the two numbers are named in the code. `awardQuote` commits `fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total` with the comment *"total_amount is the human-visible number … it outranks the stored extraction"* (`costDocs.ts:234-236`), while the tabulation renders `computeBidEconomics(parsed…)` built purely from `parsedQuoteFrom` (`QuotesPanel.tsx:195-203`). The table scores the extraction; the award posts the correction.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → MEDIUM** by this pass. REFUTES the premise: a controller cannot correct the AI's misread total on a read quote. `total_amount` has exactly two writers repo-wide — app/api/projects/cost-docs/route.ts:127-128, which sets `patch.parsed = quote; patch.total_amount = quote.total;` in one atomic patch, and `setManualTotal` (costDocs.ts:323-334), reachable only from a draft that by definition has no `parsed` payload and therefore lands in `manualBids` (:209-211), outside the scored table. The two numbers are kept equal by construction; they can diverge only via a stale-tab race (a second user reads the doc between render and the type-total click), which is a genuine latent inconsistency but not a CRITICAL everyday path.

**Mechanism.** Three facts that do not agree:

```ts
// display: from the stored `parsed` jsonb
const econ = useMemo(() => computeBidEconomics(parsed.map((p) => p.quote)), [parsed]);

// award: the human number outranks the extraction
const total = fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total;

// correction: writes total_amount only — never touches `parsed`
const patch: Record<string, unknown> = { total_amount: input.total };
```

The award path was deliberately fixed to prefer the human's number, with a
comment saying so. The display path was not.

**Failure scenario.** The AI misreads $1,182,000 as $182,000. A controller
corrects it. The Price column, the `$ / hr` column, the `minTotal`
normalization **for the entire field**, and every value score still use
$182,000 — so the corrected bidder keeps a price part of 100 and the
**best value** badge. Only the confirm dialog shows $1,182,000. Click through
it and a $1.18M commitment posts against a table that said $182K.

**Remediation.** Make one number authoritative for both display and award.
Simplest: have `parsedQuoteFrom` overlay `doc.totalAmount` onto the returned
quote's `total` when present, so every consumer sees the corrected figure. Then
mark the row visibly as "total corrected by <person>" so the provenance is not
lost.

**Done when.**
- The Price column, the value score and the award confirmation all show the same number.
- A corrected total re-normalizes the whole field's price scores.
- The row shows that the total was human-corrected.
- A test asserts display and award agree after `setManualTotal`.

**Resolution (2026-09-29, projects Round G).** One number per bid. `lib/bidTab.ts` gained `withHumanTotal(quote, rowTotal)`: the row's `total_amount` (the human-visible number `awardQuote` already posts) is overlaid onto the extraction, `totalSource` becomes `"human"` and the model's reading is kept as `extractedTotal` (GAP-407 / GAP-303 — the original is never hidden). `components/projects/cost/QuotesPanel.tsx` `BidGroup` builds every table entry through it, so the Price column, `$/hr`, the field's `minTotal` normalisation, the value score and the award confirm all read the same figure; the Price cell shows "corrected · AI read $X" on a corrected row. `lib/costDocs.ts` is untouched (signatures frozen for P3). Tests: `lib/__tests__/quotesPanel.test.ts` "display and award agree after setManualTotal" (a $182,000 misread corrected to $1,182,000 re-normalises the rival to price 100 and moves best value).

**Done-when.**
- The Price column, the value score and the award confirmation all show the same number — ✓ (`econ.total` feeds all three; `award()` takes its total from the econ entry).
- A corrected total re-normalizes the whole field's price scores — ✓ (pinned).
- The row shows that the total was human-corrected — ✓ ("corrected · AI read …").
- A test asserts display and award agree after `setManualTotal` — ✓ (`quotesPanel.test.ts`).

**Scope / residual.** The overlay lives in the panel (the consumer), not in `parsedQuoteFrom` (P3's file); any new consumer of `parsedQuoteFrom` must apply `withHumanTotal` — the helper is exported for that. The stale-tab race the verifier named is closed on the posting side by `awardQuote`'s re-read (unchanged).

---

## BID-2 · There is no way to open the quote you are being asked to award

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality / governance
- **Locations:** `components/projects/cost/QuotesPanel.tsx` (whole file — a grep for `fileUrl` / `file_url` across `components/projects/cost/` returns zero hits)
- **Related:** `BID-1`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The only navigation in `QuotesPanel.tsx` is `<Link href={`/companies/${known.id}`}>` at `:282`. No viewer, no document href, no `window.open` — there is no way to open the quote from the award screen.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Claim of absence confirmed by search, not just by reading the cited file. The R2 key is stored (uploadCostDoc, costDocs.ts:100) and the API reads it server-side (app/api/projects/cost-docs/route.ts:83-92), so the PDF exists and is addressable — there is simply no client affordance to open it, which leaves the Award confirm dialog at :195-203 as the only thing the reviewer can check the extraction against.

**Mechanism.** The PDF is stored (`cost_documents.file_url`). The panel's own
copy says "You review before anything posts," and the Read button's tooltip
repeats it. The reviewable artifact is unreachable from the review screen.

**Failure scenario.** The reviewer's only option is to trust the extraction.
Combined with `BID-1`, the system holds two different numbers for the same bid,
shows the reviewer the wrong one, and gives them no way to adjudicate.

**Remediation.** Add a "View PDF" link on every quote row, opening the stored
file through the existing secure viewer / presigned-download path. Given
`SEC-7`, prefer a download-as-attachment link until the viewer is sandboxed.

**Done when.**
- Every quote row links to its source document.
- The link works for both parsed and manual-total quotes.

**Resolution (2026-09-29, projects Round G).** Every quote row carries an `OpenPdfButton` (`QuotesPanel.tsx`) that resolves the stored R2 key through the existing presigned path (`lib/storage.getFileUrl` → `/api/storage/download-url`, no new egress) and opens it in a new tab (`noopener,noreferrer`). It renders on read rows, typed-total rows, the "not read yet" strip and the invoice list; a row with no `file_url` says "no file" instead of pretending.

**Done-when.**
- Every quote row links to its source document — ✓.
- The link works for both parsed and manual-total quotes — ✓ (both are rows of the same table after BID-8).

**Scope / residual.** Disposition (download-as-attachment vs the sandboxed viewer, SEC-7) stays with P10; this uses the download-url route as it stands.

---

## BID-3 · The scorer punishes the exact honesty your own RFQ letter promises to reward

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** decision-quality / vendor incentives
- **Locations:**
  - `lib/bidTab.ts:168` — `const gaps = e.missingScope.length + e.exclusionCount;`
  - `lib/rfqDocx.ts:65` — the promise made to bidders in writing
- **Re-verified:** hardening pass — **SURVIVES**. `const gaps = e.missingScope.length + e.exclusionCount; const coverage = (1 - gaps / maxGaps) * 100;` (`bidTab.ts:168-169`) — a **stated** exclusion is counted identically to scope the bidder never mentioned, so disclosure lowers the score.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. A direct, verbatim contradiction between the letter the product sends vendors and the scorer it runs on their replies. Working the shipped example (lib/exampleProject.ts:69-93) shows it is outcome-changing, so CRITICAL is not inflated: Gulf Mechanical's single honest exclusion costs it 25 coverage points and it finishes ~92.1 behind Bayline's ~92.8; score Gulf's declared exclusion as the letter promises and it wins at ~97.1. Apex is penalized twice over — its explicit "NDE" exclusion fails `mentions()` for the scope line "NDE (RT 10%)" (the two-of-two head-word rule at :95-99 needs both "nde" and "rt"), so it is counted as an exclusion AND as a silent gap, zeroing its coverage.

**Mechanism.** A **declared** exclusion and an **undeclared** silent gap are
weighted identically in the coverage term. The RFQ this same codebase generates
and hands to bidders says, verbatim:

> "An explicit EXCLUSIONS list — anything you are not pricing. Undeclared gaps
> found during evaluation count against the bid; declared exclusions do not."

**Measured.** Single bid, unchanged except for its exclusions list:

| | price | manpower | coverage | **score** |
|---|---|---|---|---|
| Bid declares 1 exclusion | 100 | 100 | **0** | **80.0** |
| Same bid, exclusion hidden | 100 | 100 | **100** | **100.0** |

A vendor is mechanically rewarded twenty points for concealing scope, by a tool
whose purpose is to catch concealed scope.

**Remediation.** Remove `exclusionCount` from the `gaps` term. Show declared
exclusions as information — an amber chip, which already exists — and score only
`missingScope`. If declared exclusions should carry *some* weight (they do
represent scope you must buy elsewhere), weight them separately and far lower,
and say so in the RFQ letter so the two agree.

**Done when.**
- Declaring an exclusion never lowers a bid's score relative to hiding it.
- The RFQ letter's promise matches the scorer's behaviour.
- A test pins the declared-vs-hidden comparison.

**Resolution (2026-09-29, projects Round G).** `exclusionCount` no longer enters any score. Under DEC-48 the coverage part of `scoreBids` is **not scored** (`parts.coverage === null`) until a per-RFQ scope checklist exists: declared exclusions are coverage-neutral and shown as amber "excludes:" facts, and the composite is price + manpower with the weights renormalised (`effectiveWeights`). The RFQ letter (`lib/rfqDocx.ts`) now says "Price and manpower are scored; scope coverage and any undeclared gaps are reviewed by our evaluators" and "Declared exclusions do not lower your score — they are shown to our reviewers as scope we must buy elsewhere; undeclared gaps are reviewed by our evaluators" — exactly what the scorer does. (Fix pass: the first landing still told bidders quotes were "compared … on scope coverage" and that "undeclared gaps … count against the bid" — a comparison and a penalty the tabulation does not apply.) The table's best-value tooltip names the excluded-item count when the badged bid excludes scope, so neutrality never hides the trade. Tests: `projectControls.test.ts` "declaring an exclusion never lowers a bid's score relative to hiding it" (same bid with and without its exclusion scores identically; the hidden gap surfaces only as a check prompt) and `rfqDocx.test.ts` "tells bidders that declared exclusions do not lower their score" / "promises only what the scorer does" (the coverage-comparison and gap-penalty wording is absent).

**Done-when.**
- Declaring an exclusion never lowers a bid's score relative to hiding it — ✓ (pinned).
- The RFQ letter's promise matches the scorer's behaviour — ✓ (letter reworded; pinned).
- A test pins the declared-vs-hidden comparison — ✓.

**Verification fix (2026-09-30, projects Round G).** The letter's scoring sentence now matches the scorer's hours rule (COST-5, DEC-48 (4)): manpower is scored only when at least three bids in the field state plausible hours, so `lib/rfqDocx.ts` reads "Price is scored, and so is manpower once at least three bids state labor hours in line with one another; scope coverage and any undeclared gaps are reviewed by our evaluators" (the sentence quoted above, "Price and manpower are scored; …", promised manpower scoring in every field). The exclusions sentence is unchanged. Test: `rfqDocx.test.ts` "promises only what the scorer does" amended to the new sentence and asserts the old one is gone. The declared-vs-hidden pin still holds: its two-bid field now scores on price alone, where the exclusion is equally neutral.

**Scope / residual.** Decision recorded as DEC-48 (the plan's BID-3 default; BID-4's option 3). The worked example now badges the cheapest bid with the most exclusions as best value on price and manpower (all three of its bids state plausible hours, so manpower is scored there) — the badge says so, the chips show the exclusions, and the reviewer decides; pricing excluded scope from the field's own line items is a future scope-checklist feature, not this fix.

---

## BID-4 · Silent-gap detection produces false accusations against any two bids that word the same work differently

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** decision-quality
- **Locations:**
  - `lib/bidTab.ts:82-99` — `scopeUnion` and the mention test
  - `lib/bidTab.ts:107-112` — positional head-word selection
- **Related:** `BID-5`
- **Re-verified:** hardening pass — **SURVIVES**. `mentions()` keys on two or three head words and requires `Math.ceil(key.length * 2 / 3)` of them to appear (`bidTab.ts:87-98`), matched against line items and exclusions only. Two bids describing the same scope in different words fail that test in one direction, and the miss is recorded as `missingScope`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. Reproduced by executing the exact matcher: two bids describing the same work as 'Demolition and repiping of exchanger E-301' vs 'Demo + repipe E-301 A/B circuits' each get the other's wording listed in missingScope, so both render mutual 'silent gap' chips and both lose coverage points. Claim is real, but 'any two bids that word the same work differently' overstates it — the 2-of-3 head-word rule absorbs many rewordings (the repo's own test at lib/__tests__/projectControls.test.ts:52-63 passes), and the damage is a display flag plus a 0.2-weighted coverage term a human still overrides, not corrupted money. HIGH, not CRITICAL.

**Mechanism.** `scopeUnion` is the set of distinct normalized line-item strings
across all bids. A bid "mentions" a union item only if **two of the item's first
three words longer than three letters** appear as whole words in one of its own
lines. Head words are chosen *positionally*
(`words.filter(w => w.length > 3).slice(0, 3)`), so filler like `existing`,
`complete` and `inch` becomes a matching key.

**Measured** — two complete, competent, non-excluding bids:

```
Alpha  180,000 | gaps: ["Remove and dispose existing piping at E-301",
                        "Fabricate and erect replacement spools (ISO 301-A)",
                        "Hydrotest, dry and return to operations"]   coverage 0
Bravo  172,000 | gaps: ["Demolition of existing 6-inch process piping",
                        "Install new spool pieces per ISO 301-A",
                        "Hydrostatic test and reinstate to service"]  coverage 0
```

Both bids are flagged with three red **silent gap** chips for scope they
explicitly priced. Both score coverage 0, so the 20% coverage weight collapses
to noise and the best-value verdict becomes pure price plus manpower.

At ten bidders this is quadratic: each bid is accused of omitting roughly nine
rival phrasings of work it did price.

**Remediation.** Word-overlap matching on free text cannot carry this weight.
Options, cheapest first:
1. **Raise the bar and lower the stakes.** Require a much stronger match
   (normalized token-set similarity above a threshold) and downgrade the output
   from an accusation ("silent gap") to a prompt ("not obviously covered —
   check"). Never let it drive the score.
2. **Make coverage explicit.** Have the AI map each bid's line items onto a
   *shared scope list* supplied by the RFQ (which this system generates), rather
   than inferring the union from the bids themselves. That is the structurally
   correct fix and the RFQ already exists to carry the list.
3. If neither is done, remove coverage from the composite entirely rather than
   scoring on noise.

**Done when.**
- Two differently-worded bids for identical scope do not flag each other.
- The coverage term is either accurate or not part of the score.
- A test uses realistically-worded competing bids, not toy strings.

**Resolution (2026-09-29, projects Round G).** `lib/bidTab.ts` replaced positional head-word matching with token-set similarity (`scopeSimilarity`: shared content tokens over the smaller set, filler words dropped, 4+-letter prefix stemming so "repipe"/"repiping", "spool"/"spools", "demo"/"demolition" agree; `SCOPE_MATCH_THRESHOLD` 0.5 and at least two shared tokens). What remains in `missingScope` is rendered as a slate **"check:"** chip whose tooltip says it is a prompt to open the PDF — the words "silent gap" and the rose accusation are gone — and it never enters the score (coverage is unscored, DEC-48). Price-only bids are never prompted (unknown scope is not undisclosed scope). Test: `projectControls.test.ts` "realistically-worded competing bids" uses the report's Alpha/Bravo fixture: at most one prompt per bid survives (hydrotest/hydrostatic), and scores are byte-equal with the prompts stripped. Fix pass: a one-word DECLARED exclusion ("NDE") now covers the longer scope line built on it ("NDE (RT 10%)") — for exclusions the smaller side sets the two-token bar — so a row never shows "excludes: NDE" beside "check: NDE (RT 10%)"; a multi-word exclusion still needs two shared words, and priced line items keep the two-token bar (pinned: "a one-word declared exclusion covers the longer scope line built on it").

**Done-when.**
- Two differently-worded bids for identical scope do not flag each other — ✓ as an accusation (none is made); the residual is a "check" prompt for wording no lexical rule can bridge, and it moves nothing.
- The coverage term is either accurate or not part of the score — ✓ (not part of the score).
- A test uses realistically-worded competing bids, not toy strings — ✓.

**Scope / residual.** Option 2 (map line items onto the RFQ's own scope list) is the structural fix and stays open as a feature; DEC-48 records that coverage re-enters the score only through it.

---

## BID-5 · The shipped example data contains a factually false red flag

- **Severity:** HIGH
- **Status:** REFUTED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** trust / demo quality
- **Locations:**
  - `lib/exampleProject.ts` — `buildExampleCostData()`
  - `lib/bidTab.ts:86-98` — the two-long-word rule that causes it
  - `lib/__tests__/projectControls.test.ts:52` — the test this violates
- **Related:** `BID-3`, `BID-4`
- **Re-verified:** hardening pass — **SURVIVES**. The shipped example bid data carries a red-flag annotation that the numbers do not support — a demo artifact that teaches the operator to distrust the flag.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The finding's own claim is that 'the row renders, simultaneously, an amber chip excludes: NDE and a rose chip silent gap: NDE (RT 10%)'. No such row is ever rendered: there is no example bid tabulation anywhere in the app — QuotesPanel is fed only real `docs` from the DB, and the example dataset's exclusions/missingScope never reach a chip. The data flaw is real in the abstract (I confirmed computeBidEconomics on ex.quotes yields missingScope ['NDE (RT 10%)'] for Apex Industrial, which also excludes 'NDE'), but that is precisely BID-4's matcher bug, not a shipped false red flag on screen.

**Mechanism.** In the demo data, one bidder (Apex Industrial) *declares* `NDE`
as an exclusion. `computeBidEconomics` nevertheless returns
`missingScope: ["NDE (RT 10%)"]` for it. `norm("NDE (RT 10%)")` yields the key
`[nde, rt]` and needs two matches; the exclusion string "nde" supplies one, so
the match fails.

**Failure scenario.** The row renders, simultaneously, an amber chip
`excludes: NDE` and a rose chip `silent gap: NDE (RT 10%)` whose tooltip reads
*"Other bidders priced this — this bid neither priced nor excluded it."* That
statement is false about the data on screen.

The bidder is also **double-penalized** — the same NDE counts in
`exclusionCount` *and* `missingScope`, giving gaps = 4, `maxGaps` = 4, coverage
= 0. Apex is the cheapest bid ($171,500) and finishes last (74.8); Bayline,
$26,900 more expensive, wins at 93.2.

The test at `projectControls.test.ts:52` asserts "does NOT flag scope the bid
explicitly excluded" — it passes only because its fixture uses a two-long-word
scope item.

**Remediation.** Fixing `BID-3` (drop `exclusionCount` from gaps) removes the
double penalty. Fixing `BID-4` removes the false flag. Independently: before
adding an item to `missingScope`, check it against the bid's declared
exclusions with the *same* normalization, and suppress it if it matches. Then
strengthen the test fixture so it would actually catch this.

**Done when.**
- The shipped example renders no contradictory chip pair.
- A declared exclusion is never also reported as a silent gap.
- The regression test uses a fixture that would fail without the fix.

---

## BID-6 · A single bid is crowned "best value", and the disclaimer that would qualify it is hidden

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** decision-quality / governance
- **Locations:**
  - `lib/bidTab.ts:184` — `for (const s of scored) s.best = s.score === top && top > 0;`
  - `components/projects/cost/QuotesPanel.tsx:292-294` — the badge
  - `components/projects/cost/QuotesPanel.tsx:367` — the explanatory footer, gated on `econ.length > 1`
- **Re-verified:** hardening pass — **SURVIVES**. `for (const s of scored) s.best = s.score === top && top > 0` (`bidTab.ts:184`) — no minimum-bidder guard, so one quote in a group is crowned best value against no one.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanic is exactly as described: a sole-source quote is always crowned 'best value' and the qualifying paragraph is suppressed for single-bid groups. But the summary's 'with no disclaimer attached' is inaccurate — the badge itself carries `title="Highest weighted value score — not automatically the winner; you decide."` (QuotesPanel.tsx:293), and the Value-score column header carries the weight breakdown (line 265). A hover-only disclaimer on a one-bid group is a real weakness, but MEDIUM, not HIGH.

**Mechanism.** No cardinality guard. **Measured:** one bid → score 80.0,
`best = true`. The footer that explains the weighting and says *"The cheapest
bid doesn't automatically win… You make the call"* renders only when there are
two or more scored bids. Two identical bids both receive the badge.

**Failure scenario.** A sole-source quote acquires an authoritative award
justification the system invented, with no disclaimer attached — which is
exactly the situation where a reviewer most needs to be told the tool is not
choosing for them.

**Remediation.** Require `scored.length > 1` for any `best` flag. Render the
explanatory footer whenever a score is shown at all, not only for multi-bid
groups. On a tie, either badge neither or label both "tied."

**Done when.**
- A single bid shows a score with no best-value badge.
- The weighting explanation is visible wherever a score is.
- A tie is rendered as a tie.

**Resolution (2026-09-29, projects Round G).** `scoreBids` badges `best` only when at least two bids are scored and exactly one holds the top score; equal tops set `tied: true` on each and badge none. `QuotesPanel.tsx` renders "tied" and shows the weighting footer whenever any score is shown (`econ.length > 0`), with a one-bid sentence ("no field to rank, so no bid is badged"). Tests: `projectControls.test.ts` "a single bid shows a score with no best-value badge; a tie is a tie"; `quotesPanel.test.ts` "single bid: score, no badge".

**Done-when.**
- A single bid shows a score with no best-value badge — ✓.
- The weighting explanation is visible wherever a score is — ✓.
- A tie is rendered as a tie — ✓.

**Scope / residual.** None.

---

## BID-7 · Every price in the bid table is rendered as US dollars regardless of the quote's currency

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** correctness / financial
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:298` — `fmtMoney(e.total)`, no currency
  - `components/projects/cost/QuotesPanel.tsx:300` — `$ / hr`, same
  - `components/projects/cost/QuotesPanel.tsx:218` — the award confirmation, same
  - `components/projects/cost/QuotesPanel.tsx:154, 351` — the manual-bid rows, which **do** pass `doc.currency`
  - `lib/costs.ts:352` — `fmtMoney` defaults to `"USD"`
  - `components/projects/CostsTab.tsx:159-164` — the rollup's mixed-currency warning, with no equivalent here
- **Re-verified:** hardening pass — **SURVIVES**. `fmtMoney(e.total)` is called with **no currency argument** (`QuotesPanel.tsx:298`), and `fmtMoney` defaults to `"USD"` (`costs.ts:352`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and no guard exists: the currency IS captured (app/api/projects/cost-docs/route.ts:129 `if (quote.currency) patch.currency = quote.currency;`) and stored on the row (costDocs.ts:67), but the tabulation never reads it. The only mixed-currency warning in the tab (CostsTab.tsx:159-164) is derived from `rollup.currencies`, i.e. cost-ACCOUNT currencies (costs.ts:323), and says nothing about quote currencies. The one counter-example in the cited list, QuotesPanel.tsx:154, is the invoice row and does pass `doc.currency ?? "USD"` — it is not in the bid table, so it does not weaken the claim.

**Mechanism.** The parsed-bid table calls the formatter with no currency
argument. The currency *is* extracted, the AI is explicitly prompted for it, and
`app/api/projects/cost-docs/route.ts:127` writes it to the column — none of it
reaches the screen. The file is inconsistent with itself: two call sites pass
it correctly, three do not.

**Failure scenario.** A €150,000 bid displays as **$150,000** and is scored
head-to-head against dollar bids as though the numbers were commensurate
(`minTotal / e.total`).

**Remediation.** Pass `doc.currency` at all three sites. Then add a
mixed-currency guard to the bid group: if the group's quotes are not all the
same currency, either refuse to score them against each other or convert
explicitly with a stated rate and date. Silent comparison across currencies is
worse than no comparison.

**Done when.**
- Every price in the panel renders in its own currency.
- A mixed-currency bid group is flagged and not scored as if commensurate.

**Resolution (2026-09-29, projects Round G).** `BidEconomics` carries `currency` (ISO-validated by `isoCurrency`), `fieldCurrency(econ)` reports the field's currencies, and `scoreBids` refuses a mixed field — every score null, `unscored: "mixed-currency"`, nothing badged. `QuotesPanel.tsx` passes the row's currency to every `fmtMoney` (Price, $/hr, the corrected/extracted note, the award confirm, typed-total rows, invoices), shows an amber banner naming the currencies and renders "not ranked" in the score column. Fix pass, three limbs: (a) a bid whose paper prints no currency is shown, scored and awarded in the field's single known currency and says so — "currency not printed — assumed EUR" (`bidCurrency`) — so a euro field never shows one bid in dollars while ranking it against the others; in a mixed field an unprinted currency is "unknown" and cannot be awarded. (b) The banner's remedy now exists: "correct total" accepts an ISO code after the figure ("162000 USD", `parseTypedAmount`), writes `total_amount` AND `currency` on the row through the status-guarded write (BID-9), and `withHumanTotal(quote, rowTotal, rowCurrency)` overlays both while keeping the AI's figure and currency ("corrected · AI read €150,000") — a restated bid joins the field's currency and the mixed flag clears. (c) Award is no longer hidden on every row of a mixed field: it is offered, and refused at the click unless the bid is already in the chosen budget line's currency (`account.currency`, USD when unset — `lib/costs`' own default), with the restate instruction; a single-currency field whose currency differs from the budget line's warns in the confirm. The parse route stores only ISO-4217 codes (COST-8 route limb). Tests: `projectControls.test.ts` ("a mixed-currency field is refused", "a bid with no printed currency … assumed", "restating a foreign bid … the mixed flag clears"), `quotesPanelRender.test.ts` (rendered: the unprinted-currency bid reads "€140,000 · currency not printed — assumed EUR", never "$140,000"; a mixed field awards only the bid in the budget line's currency). Second fix pass (review of 2026-09-30): (d) a field where NO bid prints a currency no longer renders as bare dollars — `bidCurrency` returns the note "currency not printed — shown as USD", and `award()` refuses (with the restate instruction) when such a bid would post into a budget line kept in another currency; (e) the restatement input no longer guesses: `parseTypedAmount` refuses a figure that can be read two ways ("162.000 EUR", "162 000,50 EUR", dot-grouped thousands, a decimal comma) or shorthand ("182k", "1.5M") with a stated reason, instead of keeping only digits and dots (which turned "162.000 EUR" into 162 and "162 000,50" into 16,200,050). Tests: `projectControls.test.ts` ("a typed figure that could be read two ways is REFUSED"), `quotesPanelRender.test.ts` ("a field where no bid prints a currency", "a figure that could be read two ways is refused — nothing is written").

**Done-when.**
- Every price in the panel renders in its own currency — ✓ (an unprinted one in the field's, marked as assumed; when no bid prints one, shown as USD and marked so — second fix pass).
- A mixed-currency bid group is flagged and not scored as if commensurate — ✓.

**Scope / residual.** The posting-side refusal (a document posted into an account of another currency) is `lib/costDocs.awardQuote` / `postInvoice` — P3 / PC-7's guard; the panel refuses the mixed-field case at the click and warns on a single-currency mismatch.

---

## BID-8 · Bids with a typed total are excluded from the comparison and rendered in a separate list below it

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:209-212` — `manualBids`
  - `components/projects/cost/QuotesPanel.tsx:346-366` — the separate list
- **Re-verified:** hardening pass — **SURVIVES**, and it is the other face of `BID-1`. `manualBids` selects docs with **no parsed quote** but a positive `totalAmount` (`QuotesPanel.tsx:209-212`), so typing a total moves the bid out of `parsed` — and therefore out of `econ` and `scores` — into a separate list.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Structurally exactly as claimed: a typed-total bid never enters `minTotal` (bidTab.ts:156) and cannot win the best-value badge, no matter how cheap. Downgraded because it is not hidden — the bid sits in a bordered list immediately below the table with its price in the same bold tabular style, a status chip, an Award control (:356-358) and an explanatory tooltip 'it competes on price only, with no manpower or coverage score' (:352). That is a disclosed limitation a reviewer can see, not a bid that disappears.

**Mechanism.** A manual-total bid never enters `minTotal`, never enters
`maxGaps`, and never receives a score. It renders below the table with no
visual join.

**Failure scenario.** A typed-total bid that is $40,000 cheaper than everyone
leaves the table's price scores untouched and the best-value badge unaffected.
A reviewer scanning the table can miss a competing bid entirely.

**Remediation.** Include manual bids in the price normalization and in the
table, with their manpower and coverage parts explicitly rendered as "not
scored — price only" rather than as zero. The existing honest marker
(`QuotesPanel.tsx:352`, "typed total — price only") is the right idea; it just
needs to live in the same table.

**Done when.**
- Manual-total bids appear in the same table as parsed bids.
- They participate in price normalization.
- Their unscored dimensions read as "not scored", never as 0.

**Resolution (2026-09-29, projects Round G).** `priceOnlyQuote()` turns a typed-total row into a `ParsedQuote` with `priceOnly: true`; `BidGroup.entries` folds those rows into the same field as the read quotes, so they enter `minTotal` and shift every rival's price part. `scoreBids` gives them a price part and `null` for manpower / coverage / composite (`unscored: "price-only"`); the row keeps the existing marker "typed total — price only" and reads "not scored" in the hours, $/hr and score cells. The separate list is gone. Test: `quotesPanel.test.ts` "typed-total bids sit in the same field".

**Done-when.**
- Manual-total bids appear in the same table as parsed bids — ✓.
- They participate in price normalization — ✓ (pinned: a cheaper typed bid moves the parsed bid's price part to 67).
- Their unscored dimensions read as "not scored", never as 0 — ✓.

**Verification fix (2026-09-30, projects Round G).** Since COST-5's hours rule (DEC-48 (4)), manpower is scored only when at least three bids in the field state plausible hours; otherwise every bid is scored on price alone. The second verification of 2026-09-30 found typed-total bids still left out of that price-alone score: a typed €90k bid read "not scored" while a read €100k bid was badged "best value — on price alone". `scoreBids` now scores a typed-total bid like any other when the field is scored on price alone (so the cheapest bid, typed or read, can take the badge), and keeps the resolution above — a price part, "not scored" for manpower and the composite, no badge — only in a field that scores manpower, where the score cell's title says "Price only — not scored on manpower". The "typed total — price only" marker's tooltip and the footer say which case applies. Tests: `quotesPanel.test.ts` "where manpower is scored they enter price normalisation and read 'not scored', never 0" (amended to a field of three bids stating hours; the cheaper typed bid still moves the parsed bid's price part to 67) and "where the field compares on price alone they are scored and ranked like every other bid" (new); `quotesPanelRender.test.ts` "a field scored on price alone scores and badges a typed-total bid like any other" and "a field that scores manpower keeps a typed-total bid 'price only — not scored on manpower', with no badge" (new).

**Scope / residual.** A typed-total row whose file was never read cannot be read afterwards: the table offers Read on drafts only, and since COST-13's second verification fix the route refuses non-drafts too (a read there would replace the typed total). It stays price-only; recorded as COST-13's Partial (`audit-reports/projects-and-cost/04-cost-and-bids.md`) with its named closer.

---

## BID-9 · There is no way to correct a wrong AI total once a quote has been read

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux / dead end
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:74-87` — `typeTotal`
  - `components/projects/cost/QuotesPanel.tsx:249` — offered only for `status === "draft"`
  - `components/projects/cost/QuotesPanel.tsx:156-161` — and for draft invoices
  - `components/projects/cost/QuotesPanel.tsx:309-316` — the parsed row, which has neither
- **Related:** `BID-1`
- **Re-verified:** hardening pass — **SURVIVES**, and the conditional is the proof. `typeTotal` is rendered **only inside the `unread.map(...)` block** — the "quotes not read yet" banner (`QuotesPanel.tsx:243-250`). Once a quote has an AI total it leaves `unread` and the affordance disappears, so a *missing* total can be supplied and a *wrong* one cannot be corrected.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed at the UI level — once a quote reaches status 'parsed' with a stored extraction there is no re-read, no retype, and no void, so a wrong AI total is what Award posts as the commitment. Worth noting the backend is not the blocker: app/api/projects/cost-docs/route.ts:87 explicitly permits re-reading a 'parsed' doc, and lib/costDocs.ts:323-334 `setManualTotal` works on any status. This is a missing button, not a missing capability — but the user-facing dead end the finding describes is real.

**Mechanism.** The type-total control is offered only in the unread strip and
for draft invoices. Once a quote is `parsed`, the row exposes a budget-line
select and an Award button and nothing else. `setManualTotal` exists and works —
no interface can call it for this state. Nor can a parsed quote be voided from
the table (only manual bids can).

**Failure scenario.** The AI misreads a total. There is no correction path and
no removal path. The only escape is a duplicate upload, which then sits in the
tabulation permanently, inflating `scopeUnion` and skewing `minTotal`.

**Remediation.** Offer "correct total" and "void" on parsed quote rows too.
Voiding must go through a status-guarded update (see `MON-3`).

**Done when.**
- A parsed quote's total can be corrected in place.
- A parsed quote can be voided.
- Both are audited.

**Resolution (2026-09-29, projects Round G).** Read rows (status `parsed`) carry **correct total** and **Void** beside Award; `typeTotal` titles itself "Correct the total" when an extraction exists and states the AI's figure; the row then shows "corrected · AI read …" (BID-1). Invoices gained the same "correct total". Fix pass: both controls now go through the panel's status-guarded write `guardedCostDocWrite` (`QuotesPanel.tsx`) instead of the unguarded `voidCostDoc` / `setManualTotal` — the UPDATE carries `.eq("org_id")`, `.in("status", ["draft", "parsed"])` and `.select("id")`, so a stale tab can no longer void or re-total a quote someone has since awarded (its commitment already posted) or an invoice already posted: zero rows is a refusal ("Someone else has already awarded, posted or voided this document — refresh"), and the audit row — the lib's own action names, `COST_DOC_MANUAL_TOTAL` (now with `previousTotal`, `extractedTotal` and any restatement currency) / `COST_DOC_VOIDED` — follows with its `{ error }` reported. Tests: `quotesPanel.test.ts` (the predicate and read-back are on the UPDATE; a stale tab's write is refused and nothing is audited; a failed audit is reported, never swallowed). Second fix pass: the corrected figure is parsed strictly (`parseTypedAmount` refuses ambiguous separators and shorthand with a reason — see BID-7), so a correction can no longer save a silently different number as the one authoritative total; and the parse route's own final write carries the same status predicate (see COST-13), so a read finishing after an award cannot reopen the document.

**Done-when.**
- A parsed quote's total can be corrected in place — ✓ (an ambiguous figure is refused, never guessed).
- A parsed quote can be voided — ✓, through a status-guarded update (the remediation's MON-3 condition).
- Both are audited — ✓ (`{ error }` checked).

**Scope / residual.** `lib/costDocs.voidCostDoc` / `setManualTotal` themselves stay unguarded (P3 / PC-7's file; signatures frozen) — the panel no longer calls them; once PC-7 guards them the panel can return to them.

---

## BID-10 · The RFQ group is free text with no normalization, and a case difference silently splits a bid field

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J13 RECORDS RECONCILE (new; the remainder appears landed — independently verified before any flip) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** correctness / process
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:485` — the input, with a `<datalist>` that suggests but does not constrain
  - `lib/costDocs.ts:157` — `d.rfqGroup?.trim()` as the grouping key
  - `lib/costDocs.ts:250-251` — the rival-declining filter
- **Related:** `MON-10`
- **Re-verified:** hardening pass — **SURVIVES**. The RFQ group is a free-text `<input>` (`QuotesPanel.tsx:485`) and the only normalization anywhere is `d.rfqGroup?.trim()` (`costDocs.ts:157`) — no case folding, so "Piping" and "piping" become two bid fields.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed at all three cited lines. The `<datalist id="rfq-groups">` at :487-489 is the only mitigation and it is a suggestion list, not a constraint — a typed "unit 300 exchanger repipe" silently forms a second group, and the award at :250-251 then declines none of the real rivals.

**Mechanism.** "Unit 300 Repipe" and "Unit 300 repipe" become two groups.
Consequences compound: the bids never tabulate against each other, the
rival-declining filter never matches, and the losing bidder is left permanently
"under review" in their portal.

**Remediation.** Normalize the key (case-fold, collapse whitespace) for grouping
and for the decline filter, while preserving the typed casing for display.
Better: make the group a real entity — a small `rfq_groups` table per project,
selected from a dropdown, created explicitly.

**Done when.**
- Two case-variant group names tabulate as one group.
- Awarding declines rivals across the case variants.

**Partial (2026-09-29, projects Round G).** Client half, as assigned. `rfqGroupKey` (case-folded, whitespace-collapsed) drives three things in `QuotesPanel.tsx`: `mergeQuoteGroups(quoteGroups(docs))` tabulates case/whitespace variants as one field under the first-seen spelling; `snapRfqGroup` snaps a typed group (upload row and quote-link form) onto an existing spelling before it is written — fix pass: the link form snaps against the groups existing LINKS carry as well as the documents', so two links minted before any quote arrives cannot split a field; and — fix pass — the award hands `awardQuote` the merged field's rivals under one spelling (`lib/bidTab.alignGroupSpelling`), so its exact-string rival filter declines every variant (the first landing left a variant rival "parsed" inside an "Awarded" field with no controls — this finding's own failure). Tests: `quotesPanel.test.ts` (merge, snap, alignment against the exact-match filter), `quotesPanelRender.test.ts` (the variant document reaches `awardQuote` under the awarded spelling).

**Done-when.**
- Two case-variant group names tabulate as one group — ✓.
- Awarding declines rivals across the case variants — ✓ for awards made from this screen (the only award path today); **not done here**: the server-side key (`lib/costDocs.ts:157`, `:250-251` `lower(trim)`) is P3 / J3's one-line limb — the finding stays open until it lands.

**Scope / residual.** The intake route writes `rfq_group` from the link, which is snapped at link creation.

**Partial (2026-10-01, projects Round G).** Record reconcile by package J13 RECORDS RECONCILE: no application code, test or migration changed here. This record is NOT flipped, because one of the two server-side limbs the 2026-09-29 Partial named has not landed. Verified against HEAD `4dd0df7`:
- **Holds: done-when 2, server side.** The award's rival filter compares by key. `lib/costDocs.ts` `rfqKey` (:345-347; case-folded and whitespace-collapsed, the rule of `lib/bidTab.ts` `rfqGroupKey`, :573-575) decides which rivals `awardQuote` declines (:577-579). It landed with J3 MONEY-LEDGER's review fix pass 2 (commit `d80536f`, merge `9b4c5f4`). Test: `costDocs.test.ts` "MON-10: the award compares RFQ groups by key — 'Piping' declines the open 'piping ' bid the table shows beside it" (:1002), exit 0 (63 passed). The bid tab also hands the lib the merged field under one spelling (`QuotesPanel.tsx:663`, `alignGroupSpelling`). Test: `quotesPanelRender.test.ts` "hands the award every case variant of the merged field under one spelling" (:219), exit 0 (31 passed).
- **Holds: done-when 1 on the bid tab.** `QuotesPanel.tsx:193` (`mergeQuoteGroups(quoteGroups(docs))`) tabulates case and whitespace variants as one field. Test: `quotesPanel.test.ts`, exit 0 (13 passed).
- **Does NOT hold: the grouping key.** This is the other limb the Partial named, cited there as `lib/costDocs.ts:157`. `quoteGroups` (now `lib/costDocs.ts:200-208`) still keys by `d.rfqGroup?.trim()` (:204), which is case-sensitive. Its one other consumer, `lib/projectSnapshot.ts:336-343`, counts `unawardedRfqGroups` over the unmerged groups. `lib/projectHealth.ts:330-335` turns that count into the coach's "Pick a winner in the bid comparison". So "Unit 300 Repipe" and "unit 300 repipe" are still two bid fields there:
  - before an award, the count is 2 where the bid tab shows 1;
  - after one, the variant whose bids the award declined still counts as a field with no award, so the coach keeps asking for a winner the bid tab shows was picked.

What is owed: key `quoteGroups` by `rfqKey` / `rfqGroupKey` (keeping a typed spelling as the label), or have `lib/projectSnapshot.ts` merge its groups the way the panel does. Either is about one line, plus a snapshot test that two case variants count as one field. `lib/costDocs.ts` and `lib/projectSnapshot.ts` are outside this records-only package. The record stays OPEN.

The comment above the bid tab's grouping (`components/projects/cost/QuotesPanel.tsx:189-192`) is stale. It says `lib/costDocs` keys the award's rival-decline on the exact string, and calls the server-side key P3's pending limb. That limb has landed (`rfqKey`, above). Whoever owns the grouping-key fix should correct the comment in the same change.

---

## BID-11 · Quote validity dates and vendor notes are captured and never shown

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality
- **Locations:**
  - `lib/bidTab.ts` — `validateParsedQuote` preserves `validUntil` and `notes`
  - `app/api/projects/cost-docs/route.ts` — the prompt explicitly asks for both
  - `components/projects/cost/QuotesPanel.tsx` (table) — renders neither
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The parsed quote carries validity dates and vendor notes and no surface renders them.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Verified end to end, including the shipped-example detail: lib/exampleProject.ts:88 is `vendorName: "Bayline Constructors", ... exclusions: [], notes: "Includes weekend premium", validUntil: d(30)`, and working `scoreBids` by hand on those three quotes puts Bayline top at ~92.8 vs Gulf ~92.1 — so the bid the scorer badges "best value" is exactly the one whose undisplayed note discloses a premium-time assumption.

**Mechanism.** Both fields are extracted, validated and stored. Neither reaches
the screen.

**Failure scenario.** **A user can award an expired quote with no warning.** And
the shipped example literally carries `notes: "Includes weekend premium"` on
Bayline — the bid the scorer picks as best value — which the interface never
displays.

**Remediation.** Add a validity column that renders the date and flags expiry
(and warn in the award confirmation if the quote has lapsed). Render notes as a
chip or an expandable line on the row.

**Done when.**
- An expired quote is visibly marked and warns on award.
- Vendor notes are visible on the row.

**Resolution (2026-09-29, projects Round G).** A "Valid until" column renders `validUntil`; `quoteExpired()` (valid through the end of its day) marks a lapsed date "· expired" in rose, and the award confirm warns "This quote's validity date has PASSED". Vendor notes render as a sky "note:" chip on the row (the shipped example's "Includes weekend premium" is now visible beside Bayline's price). The parse route persists both in the stored extraction (pinned in `costDocsRoute.test.ts`). Test: `quotesPanel.test.ts` "an expired quote is detected".

**Done-when.**
- An expired quote is visibly marked and warns on award — ✓.
- Vendor notes are visible on the row — ✓.

**Scope / residual.** None.

---

## BID-12 · Known-company matching is exact string equality against whatever the AI read off the letterhead

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** governance
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:275` — `companies.find(c => c.name.toLowerCase() === e.vendorName.toLowerCase())`
  - `components/projects/cost/QuotesPanel.tsx:50-52` — `listCompanies(...).catch(() => setCompanies([]))`
  - `lib/bidTab.ts:30, 42, 131` — `companyId` declared and propagated, never populated
- **Related:** `MON-7`, `MON-12`
- **Re-verified:** hardening pass — **SURVIVES**. `companies.find((c) => c.name.toLowerCase() === e.vendorName.toLowerCase())` (`QuotesPanel.tsx:275`) — exact equality after lowercasing, against a vendor name the model read off a letterhead.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Substance confirmed, with one wording correction: the match is case-folded, not literally exact, so "Gulf Mechanical" vs "gulf mechanical" does resolve. Everything else holds — no trim, no punctuation or legal-suffix normalization, so "Gulf Mechanical Inc." or "Gulf Mechanical, LLC" off a letterhead misses the registry, and with `companyId` dead there is no id-based fallback. MEDIUM is the right level: a miss loses the "known"/"do not use" badge, it does not alter any score.

**Mechanism.** "Gulf Mechanical, Inc." does not equal "Gulf Mechanical," so the
**do not use** badge and the quality-manual chip never render. There is no
rename affordance in the panel, so the mismatch cannot be fixed from the
interface. `ParsedQuote.companyId` exists for exactly this purpose and is never
set.

Separately: when the company list fails to load, the catch sets an empty array —
which silently removes the do-not-use flag from **every** bidder while the table
still looks complete and normal.

**Remediation.**
1. Add a company picker on the quote row so a human can bind the vendor to a
   registry entry, and store it in `cost_documents.party_id` / `company_id`
   (which also feeds `MON-7`).
2. Until then, match on a normalized form (strip punctuation, legal suffixes,
   collapse whitespace) and show "matched to X — change" so the guess is
   visible and correctable.
3. Distinguish "no companies" from "failed to load" and surface the latter.

**Done when.**
- A vendor can be bound to a registry company from the bid row.
- A failed company load is visible, not silent.
- The do-not-use flag renders for realistic name variants.

**Resolution (2026-09-29, projects Round G).** `lib/bidTab.ts` gained `normalizeCompanyName` (case, punctuation, `&`→and, whitespace, trailing legal suffixes, leading "The") and `matchCompanyByName` (exact normalised equality; two registry rows that normalise alike never auto-bind). `QuotesPanel.tsx` resolves each row through `registryFor`: an explicit link (`cost_documents.company_id`, 20261096) wins, otherwise the name match is shown as "matched to X" with a **change / link to registry** picker (`CompanyPicker`) that writes the link (`{ error }` checked, pre-migration message, `COST_DOC_COMPANY_LINKED` audit). The do-not-use and inactive chips render from the resolved company. A failed registry load is a visible amber banner and a per-row "registry unavailable" marker instead of a silent empty list. Tests: `projectControls.test.ts` "normalised company matching resolves realistic letterhead variants, never ambiguity". Fix pass: (a) the do-not-use gate no longer fails open — Award is withheld, and the row says why, while the registry or this project's link read is loading or failed (a pending 20261096 reads as "no links yet", not a failure); at the click the award re-reads the row's `company_id` and the registry (`getCompany` / `listCompanies`) instead of trusting the list the table rendered from; (b) re-linking a bidder AWAY from a do-not-use link or match requires a typed reason, recorded on `COST_DOC_COMPANY_LINKED` (`overrideDoNotUse`), and the change is undone if that audit row fails; link writes read back `.select("id")` and the link audit's `{ error }` is surfaced; (c) the 20261096 backfill's SQL normaliser now trims before stripping legal suffixes, so "Gulf Mechanical, Inc." / "Apex Co." normalise as in TypeScript (verified on PostgreSQL 16 for 18 letterhead forms; pinned by a port of the expression in `prjRoundGMigrations.test.ts`). Rendered tests: `quotesPanelRender.test.ts` (Award withheld on a failed registry or link read; the re-read catches a company barred after the table loaded; an explicit link re-read from the row outranks the name match). Second fix pass (review of 2026-09-30 — the first fix pass REGRESSED this finding): with two registry rows that normalise alike ("Apex Inc." barred, "Apex" beside it), `matchCompanyByName` returned null, so the bid lost its do-not-use chip and Award went ahead with no override — the old exact match had caught it. Binding and gating are now separate (DEC-48): `matchCompanyByName` binds an exact (trimmed, case-insensitive) name hit first, then a unique normalised match; the do-not-use GATE reads `barredCompanyFor` — the linked company, else ANY registry row the name normalises to (`companyCandidatesByName`) — so ambiguity never clears the flag; the row shows "ambiguous — link to registry" and "do not use? · <name>" until a human links it, and the award prompts for the override. The flag and the click-time check read the org's barred rows IN FULL (`lib/companies.listBarredCompanies`, paged past the row cap) rather than the 1000-row name list, so a barred company that sorts past the thousandth name keeps its flag (the first fix pass's "fails CLOSED" claim did not hold for a registry that size). The link and read-extent side read now covers exactly the rendered documents (`.in("id", …)` in chunks of 100) rather than an unordered `.limit(500)`. The picker and the link write are offered only while a document is open (`.in("status", ["draft","parsed"])` on the UPDATE): a decided bid's link is evidence on a company's record and does not move; the revert after a failed override audit is read back. Tests: `projectControls.test.ts` ("the do-not-use flag survives two registry rows that normalise alike"), `quotesPanelRender.test.ts` (the exact-name and ambiguous-variant cases prompt for the override; a registry of 1,000 names plus a barred company past them keeps the chip and the gate; a failed barred-list read withholds Award; no picker on a decided row and the link write carries the status predicate; the side read is by id) — the second fix pass added nine rendered tests to `quotesPanelRender.test.ts` and amended one ("re-reads the registry at the click: a company barred AFTER the table loaded still needs the override", which now also asserts the row showed no flag at load); all ten fail against the first fix pass.

**Verification fix (2026-09-30, projects Round G).** The line above said "all ten new rendered tests"; nine were new and one amended, as it now says. Re-run on 2026-09-30 with the second pass's test file against the first fix pass (`5f8e114`): all ten fail. No code change to this finding in this pass.

**Done-when.**
- A vendor can be bound to a registry company from the bid row — ✓ (pending migration 20261096 for the column; the picker says so until then; open documents only).
- A failed company load is visible, not silent — ✓ (and it withholds Award until a reload succeeds — the barred-row read included).
- The do-not-use flag renders for realistic name variants — ✓ ("Gulf Mechanical, Inc.", "Apex Industrial Services, LLC"), and — second fix pass — for an exact-name bid beside a same-normalised sibling and for a variant two rows could be (flagged, not bound).

**Scope / residual.** Reading `company_id` back goes through a side query in the panel because `mapDoc` (`lib/costDocs.ts`) is P3's; mapping `companyId` onto `CostDocument` is P3's one-line limb. Migrations: `20261095_prj_roundG_registry_indexes.sql`, `20261096_prj_roundG_cost_doc_links_and_extent.sql` (DEC-30: applied by hand; the code half is live without them and reads the missing columns as unknown).

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| BID-1 | CRITICAL | RESOLVED |
| BID-2 | CRITICAL | RESOLVED |
| BID-3 | CRITICAL | RESOLVED |
| BID-4 | CRITICAL | RESOLVED |
| BID-5 | HIGH | OPEN |
| BID-6 | HIGH | RESOLVED |
| BID-7 | HIGH | RESOLVED |
| BID-8 | HIGH | RESOLVED |
| BID-9 | HIGH | RESOLVED |
| BID-10 | MEDIUM | OPEN |
| BID-11 | MEDIUM | RESOLVED |
| BID-12 | MEDIUM | RESOLVED |
