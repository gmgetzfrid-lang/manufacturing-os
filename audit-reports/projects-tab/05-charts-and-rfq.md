# 05 · Charts & the printed RFQ

Degenerate chart inputs, and the document you hand to a vendor.

**7 findings** — 0 CRITICAL, 4 HIGH, 3 MEDIUM.

> Figures marked **measured** are program output: the pure chart logic was
> executed with adversarial inputs, and real `.docx` bytes were generated and
> validated with a strict XML parser. Line numbers drift — **match on the
> quoted code.** See [`../README.md`](../README.md) for the protocol.

---

## CHART-1 · The S-curve has no lower bound on its scale, so negative values draw outside the canvas

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness
- **Locations:**
  - `components/ui/ChartKit.tsx:35-41` — `max = Math.max(1, ...)`, no floor
  - `py(v) = PAD_T + (1 - v/max) * 184` — the projection
- **Re-verified:** hardening pass — **SURVIVES**. `const max = Math.max(1, …)` bounds only the top (`ChartKit.tsx:35-38`), and `py(v) = PAD_T + (1 - v / max) * (VB_H - PAD_T - PAD_B)` (`:41`) maps any negative `v` below the plot area. There is no `min` term anywhere in the scale.

**Mechanism.** The maximum is clamped; the minimum is not. So `v < 0` produces
`y > 196` (the plot floor), and `y > 220` leaves the 220-unit viewBox entirely.
Negative values became reachable when credit change orders started posting as
signed commitments.

**Measured:**

| input | computed max y | plot floor | viewBox |
|---|---|---|---|
| $200k budget, −$40k credit then +$150k | **232.8** | 196 | 220 |
| budget 0, single −$5,000 adjustment | **920,196** | 196 | 220 |

Row 1: the committed line dives through the x-axis date labels (y≈212) and off
the bottom edge. Row 2 (where `max` clamps to 1): every mark is ~920,000 units
below the canvas — the chart renders as an **empty box** with a legend
confidently reading "Spent −$5,000". No NaN, no crash, no clue.

**Remediation.** Compute `min` alongside `max`, floor it at 0 for the normal
case, and let it go negative when the data does — then project across
`[min, max]` rather than `[0, max]`. Draw a zero line whenever `min < 0`.

**Done when.**
- A series containing negative values renders entirely inside the viewBox.
- A zero baseline is drawn when any value is negative.
- A test asserts every projected `y` falls within the viewBox for a negative-value fixture.

---

## CHART-2 · Spent and Committed are drawn in near-identical colours, differentiated by nothing else

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured contrast)
- **Blast radius:** accessibility / correctness
- **Locations:**
  - `components/ui/ChartKit.tsx:72` — Spent, `var(--color-accent)`
  - `components/ui/ChartKit.tsx:79` — Committed, `vizCat(1)` → `--viz-cat-2`
  - `app/globals.css:31-34` — `--color-accent` is a user-overridable brand token
  - `components/dashboard/viz.tsx:11` — the house rule this breaks
- **Re-verified:** hardening pass — **SURVIVES**. `stroke={vizCat(1)}` at `:72` and `stroke="var(--color-accent)"` at `:79`, both solid strokes at 2 and 2.5px — no dash pattern, no marker, no direct label. Hue is the only channel carrying the distinction.

**Mechanism.** Measured contrast **between the two marks**:

| theme | spent | committed | mark-vs-mark |
|---|---|---|---|
| light | `#ea580c` | `#b45309` | **1.41 : 1** |
| dark | `#ea580c` | `#d97706` | **1.11 : 1** |

Both are solid strokes (2.5px and 2px) with round endpoint dots. Only the
*planned* line is dashed. The stated house rule is "identity never
colour-alone" — this fails it in the strongest way: the two series are not
merely undifferentiated by shape, they are not differentiated by colour either.

`--color-accent` is also a white-label token an org can set to anything,
including exactly `--viz-cat-2`.

**Remediation.** Take both series from the categorical scale (`--viz-cat-1` and
`--viz-cat-2`, which are validated against each other), and add a shape
difference — e.g. Committed gets a distinct dash pattern or marker. Do not use
the brand accent for one of two adjacent series in the same chart.

**Done when.**
- The two series differ by shape as well as hue.
- Both colours come from the validated categorical scale.
- Contrast between the marks clears 3:1 in both themes.

---

## CHART-3 · The planned crew curve is mathematically incapable of varying

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness / decision-quality
- **Locations:**
  - `lib/costSeries.ts:152-157` — `perWeek = input.laborHours / weeks`
  - `components/projects/cost/CostCharts.tsx:126-127` — the render
- **Re-verified:** hardening pass — **SURVIVES**, arithmetically. `perWeek = input.laborHours / weeks` then `headcount = Math.round((perWeek / 40) * 10) / 10` inside the loop (`costSeries.ts:152-157`) — the value does not depend on `w`, so every bar is identical by construction.

**Mechanism.** Weekly headcount is total hours divided by week count — a
constant. Since `MiniBars` normalizes to the maximum, every bar renders at full
height.

**Measured:** 1,980 hours over 90 days →
`[3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8]` — a **solid
block, presented as a curve**. It encodes exactly one number
(hours ÷ weeks ÷ 40) using thirteen bars. With small hour counts it degenerates
the other way: 40 hours over a year rounds every bucket to zero, giving
thirteen 3px stubs at 0.22 opacity.

**Failure scenario.** The panel is titled "Planned crew size by week" and is
meant to be the curve a superintendent argues manpower from. It cannot show a
ramp, a peak, or a demobilization, because there is no shape in the data.

**Remediation.** Either:
1. **Make it honest.** Replace the chart with the single number it actually
   contains — "≈3.8 people sustained across 13 weeks" — plus the inputs. A
   truthful stat beats a fake curve.
2. **Make it real.** Distribute hours across the schedule using the milestone
   weights or durations that already exist, so the curve reflects the plan. Then
   the chart earns its space.

Option 1 is a small change and immediately more truthful; option 2 is the
feature the label promises.

**Done when.**
- Either the flat curve is replaced by a stat, or the distribution reflects the schedule.
- A tiny-hours input does not render a row of zero-height stubs.

---

## CHART-4 · The one hardcoded colour in the chart kit fails contrast in light mode, and it is applied to text

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (measured contrast)
- **Blast radius:** accessibility
- **Locations:**
  - `components/ui/ChartKit.tsx:170` — `return "#d97706"; // amber-600 — reads in both themes`
  - `components/ui/ChartKit.tsx:203` — applied as `style={{ color }}` to an 8px uppercase label
  - `app/globals.css:49` — `--state-held: #d97706` already exists for this meaning
  - Blast radius beyond Costs: `components/projects/ProjectCoach.tsx:77`, `app/(protected)/companies/[id]/page.tsx:97`, `app/(protected)/companies/page.tsx:172`
- **Re-verified:** hardening pass — **SURVIVES**, and the code comment is the claim being refuted. `return "#d97706"; // amber-600 — reads in both themes` (`ChartKit.tsx:170`) is applied as `style={{ color }}` to an 8px uppercase label (`:203`). Amber-600 on a light ground is roughly 3.1:1, under the 4.5:1 small-text threshold.

**Mechanism.** The stylesheet ships two separately validated ambers —
`--viz-cat-2: #b45309` (light) and `#d97706` (dark) — with a comment explaining
the dark one is never an automatic flip of the light one. `scoreBandColor`
hardcodes the dark value with a comment claiming it reads in both.

**Measured:**

| theme | surface | contrast | verdict |
|---|---|---|---|
| light | `#ffffff` | **3.18 : 1** | **fails AA** for the 8px label |
| dark | `#111827` | 5.57 : 1 | passes |

It is also applied to *text*, which violates the house rule that "text always
wears text tokens, never series colour."

**Remediation.** Return a CSS variable rather than a hex, and let the theme
resolve it. For the band *label*, use a text token and carry the band identity
in the dial arc instead — which is where colour belongs.

**Done when.**
- No literal hex remains in `ChartKit.tsx`.
- The band label clears AA in both themes.
- The four consumers render correctly in both themes.

---

## CHART-5 · The today marker is unlabeled, has no legend entry, and can be four weeks off

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** ux / correctness
- **Locations:**
  - `components/ui/ChartKit.tsx:53-55` — `todayIdx = points.findIndex(p => p.date >= todayIso)`
  - `components/ui/ChartKit.tsx:82-85` — the marker, drawn in a faint text token
  - `components/ui/ChartKit.tsx:64-67` — the gridlines, which carry no value labels
- **Re-verified:** hardening pass — **SURVIVES**. `todayIdx = points.findIndex((p) => p.date >= todayIso)` (`:53-55`) snaps to the first bucket at or after today, so the marker's error is the bucket width; and the line is drawn with no label and no legend entry (`:82-85`).

**Mechanism.** The marker snaps to the nearest of forty samples, and samples are
`span/39`. **Measured** on a three-year job: 40 points at **28-day** spacing, so
the marker can sit almost a month from today. It is drawn dashed in
`var(--color-text-faint)` — the same family as the planned line — with no
`<title>`, no text label and no legend entry.

Related, same component: the curve has **no y-axis labels** (four gridlines with
no values) and **no budget reference line** — when there is no schedule,
`hasPlan` is false, the dashed planned line is omitted, and the chart contains
no budget context at all.

**Remediation.** Interpolate the marker's x position from the actual date rather
than snapping to a sample. Add a `<title>` and a legend entry. Add value labels
to the gridlines, and draw a budget reference line whenever `budget > 0`
regardless of whether a schedule span exists.

**Done when.**
- The today marker sits at today's true position.
- It is labelled and appears in the legend.
- Gridlines carry values and a budget line is drawn when a budget exists.

---

## RFQ-1 · A control character pasted from Word or Excel produces a corrupt RFQ document

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured with a strict expat parser)
- **Blast radius:** correctness / vendor-facing
- **Locations:**
  - `lib/rfqDocx.ts:31-32` — `esc()`, which handles only `& < > "`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `esc` handles `&`, `<`, `>` and `"` only (`rfqDocx.ts:31-32`). Control characters below U+0020 are illegal in OOXML text nodes and pass straight through.

**Mechanism.** XML 1.0 forbids the C0 control range (`0x00-0x08`, `0x0B`,
`0x0C`, `0x0E-0x1F`). `esc()` does not strip them.

**Measured**, strict parser:

```
clean              word/document.xml  strict-OK
VT(0x0B)/FF(0x0C)  word/document.xml  STRICT FAIL: not well-formed (invalid token): line 3, column 276
NUL(0x00)          word/document.xml  STRICT FAIL: not well-formed (invalid token): line 3, column 699
```

**Realistic trigger.** `0x0B` is what **Word inserts for a Shift+Enter line
break** and what Excel puts in multi-line cells — it rides along on any
copy-paste from either. `0x0C` is standard in text extracted from PDFs. The
`purpose` field is precisely where someone pastes a scope paragraph.
`projectName`, `companyName`, `rfqGroup`, `sowLabel` and every `turnoverItems[]`
entry take the same unfiltered path.

**Failure scenario.** Word refuses the file — *"The file cannot be opened
because there are problems with the contents"* — with no client-side error, no
warning, and no clue which field caused it.

**Remediation.** In `esc()`, strip or replace the forbidden C0 range (map `0x0B`
and `0x0C` to a line break, drop the rest) before escaping the metacharacters.
Do it in the one function so every field is covered.

**Done when.**
- A `purpose` containing a Shift+Enter break produces a document that strict-parses.
- A fuzz test over the C0 range asserts every output is well-formed.

---

## RFQ-2 · Newlines are emitted raw, flattening the scope section of the RFQ

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED that no `<w:br/>` conversion occurs; the exact Word rendering is SUSPECTED
- **Blast radius:** vendor-facing quality
- **Locations:**
  - `lib/rfqDocx.ts:42` — text emitted directly into `<w:t>`
  - `lib/rfqDocx.ts:123-126` — the filename sanitizer
  - `lib/rfqDocx.ts:51` — the due-date rendering
- **Re-verified:** hardening pass — **SURVIVES**. `<w:t xml:space="preserve">${esc(text)}</w:t>` (`rfqDocx.ts:42`) — `esc` does not translate `\n` into `<w:br/>`, and OOXML ignores raw newlines inside a run, so a multi-line scope collapses to one line.

**Mechanism.** OOXML expresses a line break as `<w:br/>`; a literal newline
inside `<w:t>` is just whitespace. Output looks like:

```xml
<w:t xml:space="preserve">Replace piping.
Second paragraph.
Third.</w:t>
```

Well-formed, but a multi-paragraph `purpose` collapses into one undifferentiated
run in **"1. Scope of work"** — the section that governs what bidders price.

Two smaller defects in the same file:
- **Filename.** `.replace(/[^\w\- ]+/g, "")` strips all non-ASCII word
  characters. **Measured:** `companyName: "株式会社"`, `rfqGroup: "«scope»"` →
  `RFQ-scope-.docx` — trailing hyphen, company identity gone. Two RFQs to two
  different non-Latin-named vendors collide on one filename.
- **Due date.** `new Date(dueDate + "T00:00:00").toLocaleDateString()` renders in
  the *generator's* locale. A US controller sends "9/1/2026" to a European
  bidder who reads it as 9 January.

**Remediation.** Split on `\n` and emit `<w:br/>` between segments (or emit
separate paragraphs, which is better for a scope list). Transliterate or
percent-fall-back the filename rather than stripping to nothing. Render the due
date as an ISO date or a spelled month.

**Done when.**
- A multi-paragraph purpose renders as multiple lines in Word.
- A non-Latin company name yields a distinct, non-empty filename.
- The due date is unambiguous to any reader.

---

## Verified sound — do not "fix" these

Recorded so a later pass does not mistake them for gaps.

- **Escaping is correct for the realistic hostile set.** `Ross & Sons <Unit 300>
  "Turnaround"`, `A & B Engineering`, URLs with `&`, turnover items with `&` and
  `<>` — all five document parts strict-parse clean. Apostrophes are correctly
  left unescaped in text content. Emoji and lone surrogates survive.
- **The OOXML structure is valid.** `numbering.xml` is correctly wired
  (content-type override, relationship, `numId 1` → `abstractNumId 0`), the
  `CT_Lvl` child order matches the schema sequence, `<w:pPr>` precedes runs,
  `<w:b/>` precedes `<w:sz/>`, `[Content_Types].xml` is the first zip entry, and
  STORE compression is valid OPC. Missing `styles.xml` and `docProps/*` are
  optional per ECMA-376.
- **`scoreBids` with all-zero totals** yields 0, not `NaN` —
  `Math.min()` → `Infinity` is guarded at `lib/bidTab.ts:162`, with a regression
  test.
- **`Donut` early-returns on `total === 0`**; `ScoreDial` clamps to `[0,1]` and
  handles `null`; `computeForecast` returns honest nulls; `buildCostSeries`
  never emits `NaN` dates; entries dated past schedule end do reach the terminal
  totals.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| CHART-1 | HIGH | OPEN |
| CHART-2 | HIGH | OPEN |
| CHART-3 | HIGH | OPEN |
| CHART-4 | MEDIUM | OPEN |
| CHART-5 | MEDIUM | OPEN |
| RFQ-1 | HIGH | OPEN |
| RFQ-2 | MEDIUM | OPEN |
