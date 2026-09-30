# 05 · Charts & the printed RFQ

Degenerate chart inputs, and the document you hand to a vendor.

**8 findings** — 0 CRITICAL, 0 HIGH, 8 MEDIUM (severities as recorded after verification; `CHART-6` opened 2026-09-30).

> Figures marked **measured** are program output: the pure chart logic was
> executed with adversarial inputs, and real `.docx` bytes were generated and
> validated with a strict XML parser. Line numbers drift — **match on the
> quoted code.** See [`../README.md`](../README.md) for the protocol.

---

## CHART-1 · The S-curve has no lower bound on its scale, so negative values draw outside the canvas

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness
- **Locations:**
  - `components/ui/ChartKit.tsx:35-41` — `max = Math.max(1, ...)`, no floor
  - `py(v) = PAD_T + (1 - v/max) * 184` — the projection
- **Re-verified:** hardening pass — **SURVIVES**. `const max = Math.max(1, …)` bounds only the top (`ChartKit.tsx:35-38`), and `py(v) = PAD_T + (1 - v / max) * (VB_H - PAD_T - PAD_B)` (`:41`) maps any negative `v` below the plot area. There is no `min` term anywhere in the scale.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The unbounded scale is real and the geometry does leave the viewBox. Downgraded because an outer <svg> viewport clips overflow by default, so the failure mode is a line that vanishes below the axis rather than ink painted over surrounding UI, no displayed number is wrong (the per-point <title> at ChartKit.tsx:93 and the legend totals at :103-107 still read correctly), and it requires cumulative credits to exceed cumulative actuals at a sample point.

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

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS. `components/ui/ChartKit.tsx` `sCurveScale()` (:58) builds the S-curve's domain from `min(0, data)` and `max(1, data, budget)`, widened to clean tick values (1 / 2 / 2.5 / 5 × 10ⁿ, about four intervals), and `py` projects across `[lo, hi]` — so a cumulative line that a credit takes below zero, or a lone negative adjustment on a zero budget, draws inside the plot. A zero baseline (`data-mark="zero"`) is drawn whenever `lo < 0`; the spent area closes on it. Reproduced at the base commit: `const max = Math.max(1, …)` and `py = PAD_T + (1 − v / max) · 184`, no `min` term.
- Tests: `lib/__tests__/chartKit.test.ts` — "the audit's measured rows render entirely inside the viewBox, with a zero line" (both measured rows: $200k budget with a −$40k credit then +$150k, and budget 0 with one −$5,000 adjustment; every path vertex, circle, rect and line y lies in [0, 220], and the −$5,000 line sits inside the plot band), "a scale with nothing below zero keeps its zero floor and draws no zero line", "the domain includes negative values and clean ticks that bracket them". All three failed at the base (no `sCurveScale`, no zero line).

**Done-when.**
1. ✓ A series containing negative values renders entirely inside the viewBox.
2. ✓ A zero baseline is drawn when any value is negative.
3. ✓ A test asserts every projected `y` falls within the viewBox for a negative-value fixture.

**Scope / residual.** None. The per-point `<title>` and legend figures were already right and are unchanged.

---

## CHART-2 · Spent and Committed are drawn in near-identical colours, differentiated by nothing else

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (measured contrast)
- **Blast radius:** accessibility / correctness
- **Locations:**
  - `components/ui/ChartKit.tsx:72` — Spent, `var(--color-accent)`
  - `components/ui/ChartKit.tsx:79` — Committed, `vizCat(1)` → `--viz-cat-2`
  - `app/globals.css:31-34` — `--color-accent` is a user-overridable brand token
  - `components/dashboard/viz.tsx:11` — the house rule this breaks
- **Re-verified:** hardening pass — **SURVIVES**. `stroke={vizCat(1)}` at `:72` and `stroke="var(--color-accent)"` at `:79`, both solid strokes at 2 and 2.5px — no dash pattern, no marker, no direct label. Hue is the only channel carrying the distinction.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The pairing is genuinely poor: I computed ΔE00 ≈ 11.9 (light, #ea580c vs #b45309) and ≈ 11.4 (dark, #ea580c vs #d97706), both below the ≥12 adjacent-pair threshold the file's own comment at globals.css:56-60 claims to enforce — and --color-accent is a white-label token that can land anywhere. But 'differentiated by nothing else' is false: the Spent line carries a 0.08-opacity filled area (ChartKit.tsx:69-70), a heavier stroke (2.5 vs 2) and a larger endpoint dot (:87 r=3.5 vs :88 r=3), the legend at :100-114 labels both by name with values, and every point's <title> (:93) names both series. Same-hue-family, not near-identical.

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

**Partial (2026-09-30, projects Round G).** Joint J5 CHARTS; decision `DEC-55` rule 1, which this package proposed and the owner has not yet ratified (see done-when 3). The code is complete. `components/ui/ChartKit.tsx`: Spent is `vizCat(0)` (`--viz-cat-1`) and Committed `vizCat(1)` (`--viz-cat-2`) — both from the validated categorical scale; the white-label `--color-accent` no longer draws either series (`SPENT` / `COMMITTED`, :34-35). Shape carries identity as well as hue: Spent is a solid 2.5px line with a 10% area wash and a round end marker (r 4, 2px surface ring); Committed is a dash-dot line (`8 3 2 3`) with a square end marker; Planned keeps its even `5 4` dash. The legend keys are drawn with each series' own stroke, dash and marker (`LegendKey`), so the legend repeats the shape, not just a colour swatch.
- Palette check (the dataviz six-checks validator, run on the pair): light `#2563eb` / `#b45309` on `#ffffff` — lightness band, chroma floor, CVD separation ΔE 31.3 (protan; tritan 27.3), normal-vision ΔE 34.6 and ≥ 3:1 against the surface all PASS; dark `#3b82f6` / `#d97706` on `#111827` — ΔE 30.2 (tritan 28.7), normal-vision 34.2, all PASS (ΔE is OKLab × 100).
- Found while fixing (same palette line, `components/dashboard/viz.tsx:11`): `vizCat` assembled the variable name at runtime (`var(--viz-cat-` + slot + `)`), and Tailwind v4 emits a theme variable only when a source file names it literally. `app/globals.css` was compiled through `@tailwindcss/postcss` 4.1.17 over the whole tree. At the base, the LIGHT values of slots 3–6 are absent: only their `.dark` values are emitted. Slots 1 and 2 survive only because an audit report quotes their names, and the local `.next` build of the base shows the same. So a light-theme Donut or SegmentBar painted slots 3–6 with an undefined colour. `vizCat` now reads a literal six-entry table (`VIZ_CAT`, clamped, never cycled; the fourth review fix pass maps NaN to the first slot, where it had returned undefined). The same compile on this branch emits all six light values.
- Tests: `lib/__tests__/chartKit.test.ts` — "both hues are categorical slots 1 and 2, never the white-label accent; the lines and markers differ in shape" (strokes, dash patterns, circle vs square markers, the legend keys), "the two slots clear 3:1 against their own surface in both themes (the palette's validated steps)" (read from `app/globals.css`), "every categorical slot is spelled literally, so the stylesheet build emits its light value". Failed at the base (Spent was `var(--color-accent)`, no dash on Committed, `vizCat(-1)` gave `var(--viz-cat-0)`).
- Second review fix pass: the Costs tab's own bars now wear the same pair, so a series keeps its colour across the tab. The Budget burn bar drew Spent with the brand gradient and Committed as `--color-accent` at 25%, so the orange bar above the chart read as Spent while the amber dash-dot line in it is Committed. `components/projects/CostsTab.tsx` now draws the burn bar's Spent in `vizCat(0)` and its Committed ghost in `vizCat(1)` at 40% opacity, and each account row's Spent bar in `vizCat(0)`. Over budget, both Spent bars still turn rose. Tests: `lib/__tests__/costsTabFirstLoad.test.ts` "the budget burn bar and each account's bar draw Spent in slot 1 and Committed in slot 2 — never the brand accent or gradient" (it also checks the S-curve below uses the same two slots) and "over budget, Spent turns rose on both bars (the alarm wins over the series colour)". Both failed on the previous head (`b2eddd9`).

**Done-when.**
1. ✓ The two series differ by shape as well as hue.
2. ✓ Both colours come from the validated categorical scale.
3. ✗ Not met as worded. `DEC-55` rule 1 proposes to replace it, and **that change to an audit done-when awaits the owner's ratification**. The two validated steps are 1.03:1 (light) and 1.15:1 (dark) in luminance against each other. A categorical palette is validated inside one lightness band so that no series out-shouts another, and no pair within the palette's validated lightness band is 3:1 apart. Outside the band such a pair does exist: on white, an amber near luminance 0.28 and a navy near 0.045 clear 3:1 against each other and against the surface. One of those lines then out-shouts the other, which is exactly what the band prevents. What the criterion was protecting is met by other means. Identity no longer rests on colour: the lines and markers differ in shape and the legend names each series. The hues themselves are far apart: ΔE 34.6 for normal vision and ΔE ≥ 30 under simulated colour-vision deficiency. Each mark clears 3:1 against its own surface in both themes.

**Scope / residual.** OPEN for done-when 3 only. If the owner ratifies `DEC-55` rule 1, the integrator flips the Status to RESOLVED with no code change. If the owner keeps the 3:1 criterion, the fix is a pair from outside the validated band, which needs the palette re-validated; this package does not make that change. The planned line's `--color-text-faint` stroke is 2.6:1 on white. It is unchanged: the dashed planned line is one of the README's "verified sound" items, and the dash carries its identity. The other `vizCat` consumers (dashboard widgets, Donut, SegmentBar) are unchanged in code. They now receive a defined light-theme colour for slots 3–6. **Pointer for the Costs tab's owner:** the stat strip's icon chips (`StatCard` tones: Committed `sky`, Spent `violet`) are decoration beside a text label, not series marks, and are unchanged. If the tiles are ever to carry series colour, they take slots 1 and 2 as above.

---

## CHART-3 · The planned crew curve is mathematically incapable of varying

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness / decision-quality
- **Locations:**
  - `lib/costSeries.ts:152-157` — `perWeek = input.laborHours / weeks`
  - `components/projects/cost/CostCharts.tsx:126-127` — the render
- **Re-verified:** hardening pass — **SURVIVES**, arithmetically. `perWeek = input.laborHours / weeks` then `headcount = Math.round((perWeek / 40) * 10) / 10` inside the loop (`costSeries.ts:152-157`) — the value does not depend on `w`, so every bar is identical by construction.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The claim is literally correct: the series cannot ramp, peak or demobilize, and the only input is a single scalar (CostsTab.tsx:93 sums the awarded quote's line hours). Not even a partial final week is modelled. Downgraded to MEDIUM because nothing false is asserted — the panel label discloses its provenance ('from the awarded bid's hours', CostCharts.tsx:125) and a flat average is an honest, if useless, rendering of the one number available; this is a missing-feature/altitude problem, not a wrong computation.

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

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS; option 1 (make it honest), `DEC-55` rule 2 — the brief's default. `lib/costSeries.ts` `plannedCrewAverage()` (:238) replaces `plannedManpowerSeries`: it returns the ONE number the input holds — `laborHours ÷ weeks ÷ 40` over the schedule span (fractional weeks, so a partial last week counts as part) — with the days and weeks it used, or null when there is nothing to average. No variation is invented. `components/projects/cost/CostCharts.tsx` `CrewStat` renders it as a stat titled "Planned average crew (from the awarded bid's hours)": "≈ 3.9 people" and the inputs ("1,980 labor hours over 90 days (12.9 weeks) ÷ 40 hours per person-week. The bid states hours, not when they are worked, so this is an average across the schedule — not a crew curve."). Below 0.05 it reads "Under 0.1 people". The glossary gains a "Planned average crew" entry. The crew figure takes the same schedule span as the S-curve and the forecast (`MON-2`).
- Tests: `lib/__tests__/projectControls.test.ts` "CHART-3: the planned crew is one average at 40h per person-week — no invented curve" (800 h over 4 weeks → 5; the audit's 1,980 h over 90 days → 3.85; 40 h over a year → a small positive number, not zero; empty inputs → null); `lib/__tests__/costChartsRender.test.ts` "renders the average and its inputs as text — no bars, no 'Daily activity'" and "tiny hours read as a small number, never a row of zero stubs". Reproduced at the base: `perWeek = laborHours / weeks` inside the loop gave thirteen identical 3.8 bars.

**Done-when.**
1. ✓ The flat curve is replaced by a stat.
2. ✓ A tiny-hours input does not render a row of zero-height stubs ("Under 0.1 people").

**Scope / residual.** Option 2 (a crew curve shaped by the schedule) stays a feature for when the schedule carries resource loading. A bid's line-item hours alone cannot place hours in weeks.

---

## CHART-4 · The one hardcoded colour in the chart kit fails contrast in light mode, and it is applied to text

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured contrast)
- **Blast radius:** accessibility
- **Locations:**
  - `components/ui/ChartKit.tsx:170` — `return "#d97706"; // amber-600 — reads in both themes`
  - `components/ui/ChartKit.tsx:203` — applied as `style={{ color }}` to an 8px uppercase label
  - `app/globals.css:49` — `--state-held: #d97706` already exists for this meaning
  - Blast radius beyond Costs: `components/projects/ProjectCoach.tsx:77`, `app/(protected)/companies/[id]/page.tsx:97`, `app/(protected)/companies/page.tsx:172`
- **Re-verified:** hardening pass — **SURVIVES**, and the code comment is the claim being refuted. `return "#d97706"; // amber-600 — reads in both themes` (`ChartKit.tsx:170`) is applied as `style={{ color }}` to an 8px uppercase label (`:203`). Amber-600 on a light ground is roughly 3.1:1, under the 4.5:1 small-text threshold.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — the inline comment 'reads in both themes' is only half true: on the dark surface #111827 the same color gives ~5.4:1, but in light mode every score in the 50-69 band paints its label at 3.19:1. Cited call sites are slightly off by line (the real ScoreDial usages are ProjectCoach.tsx:77, companies/page.tsx:172, companies/[id]/page.tsx:97, and the text applications are ProjectCoach.tsx:62 / companies/[id]/page.tsx:240), but every one of them renders the failing label. MEDIUM is right.

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

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS; `DEC-55` rule 5. `components/ui/ChartKit.tsx` `scoreBandColor()` (:395) returns theme tokens only — the 50–69 "watch" band is `var(--state-held)` instead of the literal `#d97706`. `app/globals.css`: `--state-held` (:49, used nowhere else in the app) is amber-700 `#b45309` on light (5.02:1 on white, 4.80 on `--color-surface-2`, 4.58 on the canvas). The `.dark` block gains its own step, amber-600 `#d97706` (:121; 5.57:1 on `#111827`). So the band colour reads as TEXT in both themes, not only as an arc. `ScoreDial`'s band word now wears a text token (`text-[var(--color-text-muted)]`, 4.76:1 light / 6.92:1 dark), and the arc carries the band's colour — the house rule "text wears text tokens, never series colour".
- Tests: `lib/__tests__/chartKit.test.ts` — "ChartKit.tsx carries no hex colour and every band resolves to a theme token", "--state-held clears 4.5:1 as text on every light surface and on the dark one" (contrast computed from the values in `app/globals.css`), "the dial's band word wears a text token; the arc carries the band colour". All three failed at the base.

**Done-when.**
1. ✓ No literal hex remains in `ChartKit.tsx`.
2. ✓ The band label clears AA in both themes (a text token).
3. Partly. ✓ in the 50–69 band this finding measured. The three `ScoreDial` call sites (`ProjectCoach.tsx`, `companies/page.tsx`, `companies/[id]/page.tsx`) render the word in a text token and the arc in the band token. The two sites that paint `scoreBandColor` as text, `ProjectCoach.tsx:85` and `companies/[id]/page.tsx:285`, now get 5.0:1 / 5.6:1 in the 50–69 band. The bar fills are unaffected. ✗ in the 70–84 band at those two text sites: they paint the white-label `--color-accent` as text, 3.6:1 on white in the default theme, under the 4.5:1 an 11px label needs ("78 · Good"). That remainder is not this finding's defect (the literal hex), and the two files belong to other packages.

**Scope / residual.** The status is RESOLVED because the literal-hex defect is closed and the consumer contrast that remains, done-when 3's 70–84 case, is carried in full by **`CHART-6`** (OPEN, opened below, with its own row in the progress table). Done-when 3 is not met until `CHART-6` is resolved.

---

## CHART-5 · The today marker is unlabeled, has no legend entry, and can be four weeks off

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** ux / correctness
- **Locations:**
  - `components/ui/ChartKit.tsx:53-55` — `todayIdx = points.findIndex(p => p.date >= todayIso)`
  - `components/ui/ChartKit.tsx:82-85` — the marker, drawn in a faint text token
  - `components/ui/ChartKit.tsx:64-67` — the gridlines, which carry no value labels
- **Re-verified:** hardening pass — **SURVIVES**. `todayIdx = points.findIndex((p) => p.date >= todayIso)` (`:53-55`) snaps to the first bucket at or after today, so the marker's error is the bucket width; and the line is drawn with no label and no legend entry (`:82-85`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. All three sub-claims hold. Unlabeled and legend-less is unambiguous; worse, the marker wears the same --color-text-faint dashed styling as the Planned line at :76-77, so it reads as a stray plan artifact. The 'four weeks off' figure needs a ~3-year span (28 days × 39 intervals ≈ 1092 days) — reachable for a long capital project though not for a turnaround. Also note :82's `todayIdx > 0` silently suppresses the marker when today lands on the first sample.

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

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS. `components/ui/ChartKit.tsx`: the S-curve's samples are evenly spaced in time from the first point's date to the last, so `sCurveTodayX()` (:78) interpolates today's x on that same axis. It no longer snaps to the first sample on or after today, which on a three-year job was up to 28 days off. The marker is drawn whenever today is inside the span, including on the first sample; the old `todayIdx > 0` suppressed that case. It is a solid `--color-text-muted` hairline, no longer the planned line's faint dash family. It carries a `<title>` ("Today — Mar 10"), an in-plot "Today" label and a legend entry. Every gridline sits at a clean value and is labelled (compact money from `CostCharts`' `compactMoney`, e.g. "$100K"). A budget reference line (`data-mark="budget"`) is drawn and labelled whenever the budget is above zero, schedule or not. It reads "Revised budget" when approved change orders move it, the same revised figure the planned line and the forecast use (`DEC-50` rule 2). It also appears in the legend and the chart's `aria-label`. In-plot labels are drawn last with a surface halo, so no line crosses them.
- Review fix pass. With no money in the data at all (a schedule, blank budgets, nothing posted), `sCurveScale()` labels only the zero gridline. The floor of 1 still gives the scale a height, but it no longer shows up as an invented "$1" gridline (`DEC-55`: draw only what the data holds). The Costs tab shows an explanation in that state instead of a flat chart (`REL-11`). Early in the span, the "Today" label no longer sits on the top gridline label's baseline, where the later, haloed "$300K" covered it. `sCurveTodayLabel()` drops the label just inside the plot beside the marker whenever the marker is within 56 units of the left edge, and keeps it centred above the plot otherwise.
- Second review fix pass. That fixed room was sized for "$300K", but the axis labels come from `Intl` in the viewer's locale. A de-DE viewer sees "3.000 Tsd. $" and a CAD project shows "CA$1.5M", so a longer top label still covered a centred "Today" at x ≈ 64–72. The room is now taken from the label actually drawn on the top gridline: `SCurveChart` passes the drawn top label to `sCurveTodayLabel()`, which sizes it with `sCurveLabelWidth()`. A chart with no money has no label at the top: its only label, $0, sits at the bottom. This pass's estimate (about 0.62 em a glyph, a full em for CJK) and its 2-unit gap proved short; the third pass below replaces both.
- Third review fix pass. The 0.62-em estimate was not an upper bound for capital-heavy labels: "CA$3M" is 31.7 units and "MX$3M" 33.1 in DejaVu Sans at 9 units (32.3 and 33.7 in Inter), where it gave 28.0 for both. The gap also left out the haloes, and the 14-unit half-width of "Today" was under DejaVu Sans Bold's 15.35. So at the threshold the later, haloed top label could still paint over the start of "Today". `components/ui/ChartKit.tsx` `sCurveLabelWidth()` (:108) is now a per-glyph upper bound: a full em for m, w, M, W, % and @ and for anything from U+0370 on (other scripts, the ₩ and ₹ signs, CJK), 0.8 em for the other capitals and the rest of Latin-1 and Latin Extended (no-break spaces, £, ¥), 0.65 em for digits, lowercase, "$" and punctuation. **Measured** in this pass from the fonts' advance-width tables (read with fontTools; the script is scratch work, not in the repo): against every compact currency label `Intl` writes for 37 locales × 21 currencies (5,259 labels), in Inter (the app's face, `@fontsource/inter` 5.3.0) and in DejaVu Sans, Liberation Sans and FreeSans, the estimate is never below the real advance; the smallest margin is 0.2 units. The test pins the review's two labels and "Today" with those fonts' advance widths. `TODAY_HALF_W` is 16 (Inter Bold "Today" is 27.8 units, DejaVu Sans Bold 30.7). The centred label must clear the top label's end by `TODAY_LABEL_GAP`, 2 units plus both haloes (3), or it drops inside the plot.
- Tests: `lib/__tests__/chartKit.test.ts` — "the marker is interpolated from today's date, not snapped to the next 28-day sample" (3-year span, 40 samples: x equals the date-interpolated position; the old snap is > 1 unit away; the label, `<title>` and legend entry exist), "today on the first sample is still drawn; outside the span it is not", "every gridline carries its value", "a budget line is drawn and labelled whenever there is a budget — schedule or not", "the verified-sound accessibility is kept: role=img with a value-bearing label, a text legend, a dashed planned line", "a chart with no money in it labels only the zero gridline — never an invented '$1'", "early in the span the Today label drops inside the plot, clear of the top gridline's label", "the room the Today label needs is the top label actually drawn — a long locale label cannot cover it" (second review fix pass; the same marker position is centred beside "$3M" and dropped inside beside "3.000 Tsd. $", and every rendered position either clears the label or sits a line below it, now by the 16-unit half-width and the 5-unit gap), "capital-heavy labels: the estimate is never below the real advance ('CA$3M', 'MX$3M')" and "at the threshold, the real 'Today' clears the real top label and both haloes" (third review fix pass; both carry the Inter and DejaVu Sans advance widths of their glyphs, and at the first marker position that keeps "Today" centred beside "CA$3M", "MX$3M" or "$3M", the real "Today" in either bold face starts past the real label plus both haloes); `lib/__tests__/costChartsRender.test.ts` "the S-curve draws the budget it plans against — the revised budget when a change order is approved". Failed at the base (no `sCurveTodayX`, no budget line, unlabelled gridlines). The two review-fix cases failed on the package's first head (`d226bb3`); the long-label case failed on `b2eddd9`; the two capital-heavy cases failed on `d061f8e`.

**Done-when.**
1. ✓ The today marker sits at today's true position.
2. ✓ It is labelled and appears in the legend.
3. ✓ Gridlines carry values, and a budget line is drawn whenever a budget exists.

**Scope / residual.** The S-curve's `role="img"`, value-bearing label, text legend and dashed planned line — the README's "verified sound" items — are kept and pinned by test. The top label's width is an estimate, not a measurement of the face the viewer's browser renders. It is an upper bound for the four fonts and the 5,259 labels it was checked against. A face wider than those (a user stylesheet, an unusual system fallback) could still exceed it. Measuring the drawn label after mount (`getComputedTextLength()`) would close that, and is not done.

---

## CHART-6 · Two consumers paint the score band's colour as text, and the 70–84 band is the white-label accent

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (measured contrast)
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/ProjectCoach.tsx:85` — `style={{ color: scoreBandColor(health.score) }}` on the 11px "score · band" header label
  - `app/(protected)/companies/[id]/page.tsx:285` — the same on the "NN% coverage" label
  - `components/ui/ChartKit.tsx` `scoreBandColor` — the 70–84 band returns `var(--color-accent)`
- **Independently verified:** — (`author`: opened by projects Round G package J5 on 2026-09-30, split from `CHART-4` under `DEC-31`)

**Mechanism.** `scoreBandColor` is a MARK colour — the dial arc, a bar fill. Two consumers also paint it as text. `CHART-4` made the 50–69 band a token that reads as text in both themes. The 70–84 band paints `--color-accent`, the brand token an org can set to anything. The default orange-600 `#ea580c` is 3.56:1 on white, under the 4.5:1 an 11px label needs.

**Failure scenario.** A project scoring 78 shows "78 · Good" in the health header at 3.6:1 in light mode. A white-label org with a pale brand colour pushes it lower.

**Done when.**
- Neither consumer paints a band colour on text: the figure wears a text token, and the band is carried by a mark beside it (a dot, the arc) or by the band word.
- A test pins that no consumer passes `scoreBandColor` to a text `color`.

---

## RFQ-1 · A control character pasted from Word or Excel produces a corrupt RFQ document

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured with a strict expat parser)
- **Blast radius:** correctness / vendor-facing
- **Locations:**
  - `lib/rfqDocx.ts:31-32` — `esc()`, which handles only `& < > "`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `esc` handles `&`, `<`, `>` and `"` only (`rfqDocx.ts:31-32`). Control characters below U+0020 are illegal in OOXML text nodes and pass straight through.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The code defect is real and unguarded, but the claimed trigger is not established, which is what carries the HIGH. Every field reaching RfqInput is org-typed text read back from the DB (QuotesPanel.tsx:580-590 — projects.name/purpose, orgs.name, the link's companyName/rfqGroup, turnover_items.name); nothing on that path ingests machine output. Browsers deliver text/plain from Word/Excel as CR/LF and normalize to \n in a textarea, so U+000B does not in fact ride along on a paste — the report's own measurement injected the byte directly, not through the UI. Impact is a regenerable local download that fails loudly at open time: no stored corruption, no compliance or security consequence. MEDIUM.

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

**Resolution (2026-09-29, projects Round G).** `lib/rfqDocx.ts` `cleanXmlText()` runs inside `esc()` — the one function every field passes through: VT (0x0B) and FF (0x0C) become line breaks, CR/CRLF are normalised, every other C0 byte, DEL, U+FFFE/FFFF and lone surrogates are dropped; metacharacters are escaped after. `buildRfqDocumentXml()` is exported so the main part can be strict-parsed. Tests (`lib/__tests__/rfqDocx.test.ts`, jsdom's strict XML `DOMParser`): a Shift+Enter purpose parses and yields a `<w:br/>`; a fuzz over every C0 byte in every field and in turnover items asserts well-formedness.

**Done-when.**
- A `purpose` containing a Shift+Enter break produces a document that strict-parses — ✓.
- A fuzz test over the C0 range asserts every output is well-formed — ✓.

**Scope / residual.** None.

---

## RFQ-2 · Newlines are emitted raw, flattening the scope section of the RFQ

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED that no `<w:br/>` conversion occurs; the exact Word rendering is SUSPECTED
- **Blast radius:** vendor-facing quality
- **Locations:**
  - `lib/rfqDocx.ts:42` — text emitted directly into `<w:t>`
  - `lib/rfqDocx.ts:123-126` — the filename sanitizer
  - `lib/rfqDocx.ts:51` — the due-date rendering
- **Re-verified:** hardening pass — **SURVIVES**. `<w:t xml:space="preserve">${esc(text)}</w:t>` (`rfqDocx.ts:42`) — `esc` does not translate `\n` into `<w:br/>`, and OOXML ignores raw newlines inside a run, so a multi-line scope collapses to one line.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Main claim confirmed — a multi-paragraph scope collapses into a single run under "1. Scope of work", and the filename sanitizer does strip non-Latin names to empty. One sub-bullet is dead: the due-date defect at :51 is unreachable, because the sole call site passes `dueDate: null` (components/projects/cost/QuotesPanel.tsx:588), so `new Date(i.dueDate + "T00:00:00").toLocaleDateString()` never runs. MEDIUM still right.

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

**Resolution (2026-09-29, projects Round G).** Paragraph runs split on `\n` and emit `<w:br/>` between segments; the scope purpose becomes one paragraph per blank-line-separated block (`paragraphs()`). Filenames use `fileSlug()`: ASCII word characters kept, and a name with none falls back to `company-<hash>` / `scope-<hash>` so two non-Latin vendors never collide and nothing strips to empty (`rfqFileName()`). The due date renders as `formatDueDate()`: ISO plus the month spelled out ("2026-09-01 (1 September 2026)"). Tests: `rfqDocx.test.ts` (three paragraphs, one break, no raw newline in any `<w:t>`; distinct non-empty filenames; the date string and the absence of `9/1/2026` / `1/9/2026`).

**Done-when.**
- A multi-paragraph purpose renders as multiple lines in Word — ✓ (multiple `<w:p>` and `<w:br/>`; Word rendering itself not opened here — the structure is what OOXML defines for it).
- A non-Latin company name yields a distinct, non-empty filename — ✓.
- The due date is unambiguous to any reader — ✓.

**Scope / residual.** The sole call site still passes `dueDate: null`; the formatter is exercised by test.

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
| CHART-1 | MEDIUM | RESOLVED |
| CHART-2 | MEDIUM | OPEN |
| CHART-3 | MEDIUM | RESOLVED |
| CHART-4 | MEDIUM | RESOLVED |
| CHART-5 | MEDIUM | RESOLVED |
| CHART-6 | MEDIUM | OPEN |
| RFQ-1 | MEDIUM | RESOLVED |
| RFQ-2 | MEDIUM | RESOLVED |
