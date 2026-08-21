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

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** financial / decision-quality
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:195-203` — `parsed` and `econ`, built from the stored extraction
  - `components/projects/cost/QuotesPanel.tsx:298` — the Price column
  - `components/projects/cost/QuotesPanel.tsx:213` — the client-side award total, which *does* prefer the human number
  - `lib/costDocs.ts:226` — `const total = fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total`
  - `lib/costDocs.ts:323-334` — `setManualTotal`, which writes only `total_amount`
- **Related:** `BID-2`, `BID-9`, `MON-3`

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

---

## BID-2 · There is no way to open the quote you are being asked to award

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality / governance
- **Locations:** `components/projects/cost/QuotesPanel.tsx` (whole file — a grep for `fileUrl` / `file_url` across `components/projects/cost/` returns zero hits)
- **Related:** `BID-1`

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

---

## BID-3 · The scorer punishes the exact honesty your own RFQ letter promises to reward

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** decision-quality / vendor incentives
- **Locations:**
  - `lib/bidTab.ts:168` — `const gaps = e.missingScope.length + e.exclusionCount;`
  - `lib/rfqDocx.ts:65` — the promise made to bidders in writing

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

---

## BID-4 · Silent-gap detection produces false accusations against any two bids that word the same work differently

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** decision-quality
- **Locations:**
  - `lib/bidTab.ts:82-99` — `scopeUnion` and the mention test
  - `lib/bidTab.ts:107-112` — positional head-word selection
- **Related:** `BID-5`

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

---

## BID-5 · The shipped example data contains a factually false red flag

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** trust / demo quality
- **Locations:**
  - `lib/exampleProject.ts` — `buildExampleCostData()`
  - `lib/bidTab.ts:86-98` — the two-long-word rule that causes it
  - `lib/__tests__/projectControls.test.ts:52` — the test this violates
- **Related:** `BID-3`, `BID-4`

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

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** decision-quality / governance
- **Locations:**
  - `lib/bidTab.ts:184` — `for (const s of scored) s.best = s.score === top && top > 0;`
  - `components/projects/cost/QuotesPanel.tsx:292-294` — the badge
  - `components/projects/cost/QuotesPanel.tsx:367` — the explanatory footer, gated on `econ.length > 1`

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

---

## BID-7 · Every price in the bid table is rendered as US dollars regardless of the quote's currency

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness / financial
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:298` — `fmtMoney(e.total)`, no currency
  - `components/projects/cost/QuotesPanel.tsx:300` — `$ / hr`, same
  - `components/projects/cost/QuotesPanel.tsx:218` — the award confirmation, same
  - `components/projects/cost/QuotesPanel.tsx:154, 351` — the manual-bid rows, which **do** pass `doc.currency`
  - `lib/costs.ts:352` — `fmtMoney` defaults to `"USD"`
  - `components/projects/CostsTab.tsx:159-164` — the rollup's mixed-currency warning, with no equivalent here

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

---

## BID-8 · Bids with a typed total are excluded from the comparison and rendered in a separate list below it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:209-212` — `manualBids`
  - `components/projects/cost/QuotesPanel.tsx:346-366` — the separate list

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

---

## BID-9 · There is no way to correct a wrong AI total once a quote has been read

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / dead end
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:74-87` — `typeTotal`
  - `components/projects/cost/QuotesPanel.tsx:249` — offered only for `status === "draft"`
  - `components/projects/cost/QuotesPanel.tsx:156-161` — and for draft invoices
  - `components/projects/cost/QuotesPanel.tsx:309-316` — the parsed row, which has neither
- **Related:** `BID-1`

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

---

## BID-10 · The RFQ group is free text with no normalization, and a case difference silently splits a bid field

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness / process
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:485` — the input, with a `<datalist>` that suggests but does not constrain
  - `lib/costDocs.ts:157` — `d.rfqGroup?.trim()` as the grouping key
  - `lib/costDocs.ts:250-251` — the rival-declining filter
- **Related:** `MON-10`

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

---

## BID-11 · Quote validity dates and vendor notes are captured and never shown

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality
- **Locations:**
  - `lib/bidTab.ts` — `validateParsedQuote` preserves `validUntil` and `notes`
  - `app/api/projects/cost-docs/route.ts` — the prompt explicitly asks for both
  - `components/projects/cost/QuotesPanel.tsx` (table) — renders neither

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

---

## BID-12 · Known-company matching is exact string equality against whatever the AI read off the letterhead

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** governance
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:275` — `companies.find(c => c.name.toLowerCase() === e.vendorName.toLowerCase())`
  - `components/projects/cost/QuotesPanel.tsx:50-52` — `listCompanies(...).catch(() => setCompanies([]))`
  - `lib/bidTab.ts:30, 42, 131` — `companyId` declared and propagated, never populated
- **Related:** `MON-7`, `MON-12`

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

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| BID-1 | CRITICAL | OPEN |
| BID-2 | CRITICAL | OPEN |
| BID-3 | CRITICAL | OPEN |
| BID-4 | CRITICAL | OPEN |
| BID-5 | HIGH | OPEN |
| BID-6 | HIGH | OPEN |
| BID-7 | HIGH | OPEN |
| BID-8 | HIGH | OPEN |
| BID-9 | HIGH | OPEN |
| BID-10 | MEDIUM | OPEN |
| BID-11 | MEDIUM | OPEN |
| BID-12 | MEDIUM | OPEN |
