# 10 · Accessibility, mobile & dark mode

The plant floor is a tablet in daylight, in gloves. Roughly 7,000 lines of new
code contain **one** `aria-label`, **one** `role="img"`, and **zero**
`aria-live`, `htmlFor`, `aria-pressed` and `role="dialog"`.

Almost every finding here is a place where the new code re-implemented something
the app had already solved. Most fixes are substitutions, not new engineering.

**13 findings** — 3 CRITICAL, 7 HIGH, 3 MEDIUM.

> Contrast figures are computed WCAG 2.x relative-luminance ratios against the
> declared tokens, not measured screenshots. Line numbers drift — **match on the
> quoted code.** See [`../README.md`](../README.md) for the protocol.

---

## A11Y-1 · File pickers are unreachable by keyboard, including on the public vendor portal

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** accessibility / legal
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:478` — `<input type="file" className="hidden" …>`
  - `app/submit/[token]/page.tsx:173, 245, 274` — the same, on the **public, unauthenticated** portal
  - `app/(protected)/plot-plans/page.tsx:166` — the working pattern already in the repo: `className="sr-only"`
- **Re-verified:** hardening pass — **SURVIVES**. Every file input on both surfaces carries `className="hidden"` — `QuotesPanel.tsx:478` and `app/submit/[token]/page.tsx:173, 245, 274` — and a grep for `sr-only` on the public portal returns **0**. `display: none` removes an element from the tab order, so on the vendor portal there is no keyboard path to submit at all.

**Mechanism.** `hidden` compiles to `display: none`, which removes the element
from the tab order entirely. The wrapping `<label>` is not focusable and carries
no `role` or `tabindex`.

**Failure scenario.** A keyboard-only user **cannot upload a quote PDF, cannot
submit a drawing, and cannot upload redlines.** On `/submit/[token]` that is the
entire purpose of the page — and that page is public and unauthenticated, making
it the highest-exposure accessibility surface in the product.

**Remediation.** Replace `className="hidden"` with `className="sr-only"` at all
four sites. The input stays visually hidden and remains focusable, and the label
association keeps working. (This is a wider pre-existing pattern in the app —
about 20 sites — but the new code propagated the broken variant rather than the
working one, so fix these four and consider a sweep.)

**Done when.**
- Every file picker in the Projects area and the submit portal is reachable by Tab and activatable by Enter or Space.
- The submit portal is completable end to end with a keyboard alone.

---

## A11Y-2 · Checklist item status is conveyed entirely by an eight-pixel coloured dot, on the PSSR surface

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** accessibility / safety
- **Locations:**
  - `components/projects/QualityTab.tsx:488-497` — `StatusDot`: `<span className={\`… w-2 h-2 rounded-full …\`} title={m.t} />`
  - `components/projects/QualityTab.tsx:686` — the punch dot, which has **no `title` at all**
  - `app/(protected)/companies/[id]/page.tsx:313` — the rubric dot, also no title
  - `components/projects/QualityTab.tsx:439-485` — the row, which renders item text, AI rationale, manual note and evidence chips, and never the status
  - `components/dashboard/viz.tsx` — the house rule this breaks: "identity never colour-alone"
- **Re-verified:** hardening pass — **SURVIVES**. `StatusDot` is `<span className="w-2 h-2 rounded-full …" title={m.t} />` (`QualityTab.tsx:488-497`) — colour plus a `title`, with no text, no `aria-label` and no `role`. `title` is not reliably announced and is unreachable without a pointer.

**Mechanism.** `satisfied` / `needs_evidence` / `open` / `na` are distinguished
only by hue in an 8×8 px dot with no text, no glyph, no `aria-label` and no
`role`.

**Failure scenario.** A screen-reader user cannot tell a proven item from one
nobody has looked at. Emerald against amber is the canonical
deutan/protan confusion pair. The tooltip gives touch users nothing. And this
sits inside the safety-critical PSSR/MI/QA-QC surface.

The **punch dot is worse**: four states, no tooltip, and **done versus void** is
distinguishable by nothing but hue — which matters because voiding means "this
was never a real snag." (`line-through` + reduced opacity does separate closed
from open, and "— overdue" is appended as text, both good.)

The **rubric dot** drives a score that lands on a contractor's permanent record.

**Remediation.** Give each dot a text label beside it (or a distinct glyph:
check / clock / dash / slash) plus an `aria-label`, and add a visible legend to
the checklist card. Three components, one pattern.

**Done when.**
- Every status is readable as text or a distinguishable glyph, not hue alone.
- A screen reader announces the status of each checklist, punch and rubric row.
- The checklist card carries a legend.

---

## A11Y-3 · Milestone row tints make the row unreadable in dark mode

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (computed contrast)
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/ScheduleTab.tsx:528-532` — the tints, hardcoded light-mode values with no `dark:` variant
  - `components/projects/ScheduleTab.tsx:545` — the milestone name
  - `components/projects/ScheduleTab.tsx:558` — the date / duration / responsible-party line
  - `components/projects/ScheduleTab.tsx:578, 582` — the overdue and slip text
- **Re-verified:** hardening pass — **SURVIVES**. The tints at `ScheduleTab.tsx:527-532` are `bg-emerald-50/50`, `bg-red-50/50`, `bg-amber-50/50` with **no `dark:` variant**, while the row's text is `text-[var(--color-text)]`, which flips light in dark mode. Light text on a light tint.

**Mechanism.**

```
effStatus === "completed" ? "border-emerald-300 bg-emerald-50/50" :
effStatus === "missed"    ? "border-red-300 bg-red-50/50" :
effStatus === "blocked"   ? "border-amber-300 bg-amber-50/50" :
effStatus === "on_hold"   ? "border-amber-300 bg-amber-50/40" :
overdue                   ? "border-red-300 bg-red-50/40" : …
```

`bg-red-50/50` over `--color-surface` (#111827) composites to ≈`#87858c` — a
mid-grey slab. Against it:

| Element | Contrast |
|---|---|
| Milestone name, 14px bold (`--color-text` #f1f5f9) | **3.32 : 1** |
| Date / duration / responsible-party line (`--color-text-muted` #94a3b8) | **1.42 : 1** |
| Overdue / slip text (`text-red-700`) | **1.78 : 1** |
| Completed (emerald) variant | **1.39 : 1** |

**Failure scenario.** Every completed, missed, blocked, on-hold and overdue
milestone — precisely the rows a field user needs — becomes unreadable in dark
mode. This is the single worst rendering defect found.

**Remediation.** Replace the hardcoded tints with theme-aware token pairs, using
the low-alpha-over-surface recipe the rest of the codebase uses
(`bg-red-500/[0.08]` with `border-red-500/50`), which composites correctly on
both grounds.

**Done when.**
- Every milestone row's text clears 4.5:1 in both themes.
- No hardcoded `-50`/`-300` tint remains in the row renderer.

---

## A11Y-4 · Five modals with no dialog role, no focus trap, no Escape and no backdrop dismissal

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/ProjectWizard.tsx:213` — close button at `:225`, no `aria-label`
  - `app/(protected)/projects/[id]/page.tsx:562` — lessons-learned, **no close button at all**
  - `app/(protected)/projects/[id]/page.tsx:609` — transition confirm, **no close button at all**
  - `app/(protected)/companies/page.tsx:286` — close at `:294`, no `aria-label`
  - `app/(protected)/companies/[id]/page.tsx:500` — close at `:504`, no `aria-label`
  - `components/ui/Modal.tsx` — the canonical shell all five should compose: portal, `role="dialog"`, `aria-modal`, Escape, backdrop click, labelled close
  - Same-folder siblings that already do it right: `MovePreviewSheet.tsx:87`, `ExecutionGuide.tsx:69`, `ScheduleCalendarTileView.tsx:430`, `EditProjectModal.tsx:52`

**Mechanism.** All five hand-roll a `fixed inset-0` shell and inherit none of
the base modal's behaviour. None locks body scroll, so the page behind keeps
scrolling under the overlay.

**Failure scenario.** A screen-reader user tabbing into the open wizard walks
straight out the bottom into the projects grid behind it, with no announcement
that a dialog opened and no way back except reverse-tabbing the whole page.
Closing returns focus to `<body>`, not to the button that opened it. And two of
the five have **no dismissal affordance other than a footer button** — on a
phone, if that footer scrolls out of view (the transition confirm can carry four
gate lines plus a textarea), there is no exit.

**Remediation.** Compose `components/ui/Modal.tsx` in all five. That is the
whole fix — it supplies the role, the trap, Escape, backdrop dismissal, the
portal and the labelled close button.

*Note: the `bg-slate-900/60` backdrops are **correct** — the dark bridge does not
match the escaped opacity class, so they stay a 60% scrim in both themes,
matching `Modal.tsx`. Do not "fix" those.*

**Done when.**
- All five compose the shared `Modal`.
- Escape and backdrop click close each one.
- Focus is trapped while open and restored on close.

---

## A11Y-5 · The wizard's lookalike `Field` breaks label association, so every wizard input is unlabeled

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/ProjectWizard.tsx:456-463` — the local `Field`
  - `components/ui/Field.tsx:50-57` — the shared one, which wraps its children in the `<label>`

**Mechanism.**

```jsx
function Field({ label, children }) {
  return (
    <div>
      <label className="…">{label}</label>   {/* no htmlFor */}
      <div className="mt-1">{children}</div> {/* input is a SIBLING, not a child */}
    </div>
  );
}
```

**Failure scenario.** A screen reader announces "edit text, blank" for Name,
Description, MOC reference, Target completion, Purpose, Goals and Success
criteria. The required-field asterisks (`UX-15`) are not in the accessibility
tree either, for the same reason.

**Remediation.** Import the shared `Field`, or wrap the children inside the
`<label>`. Two lines.

**Done when.**
- Every wizard input has an accessible name matching its visible label.

---

## A11Y-6 · No error anywhere in the Projects area is announced to assistive technology

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (zero `aria-live` / `role="alert"` / `role="status"` in any audited file)
- **Blast radius:** accessibility
- **Locations:**
  - Validation errors rendered into a plain `<div>`: `ProjectWizard.tsx:418`, `projects/[id]/page.tsx:665, 936`, `CostsTab.tsx:119, 516, 587`, `ChangeOrdersPanel.tsx:262`, `QualityTab.tsx:81`, `companies/page.tsx:319`, `companies/[id]/page.tsx:538`, `ScheduleTab.tsx:221, 733`, `submit/[token]/page.tsx:182, 251`
  - `components/projects/ProjectWizard.tsx:124-125` — `finish()` jumps back to step 0 and sets an error **without moving focus**
  - `components/projects/IntakePanel.tsx:292` — one banner carrying both success and failure with identical styling (see `UX-7`)
  - Silent confirmations: `QuotesPanel.tsx:630` ("Copied!"), `IntakePanel.tsx:352`

**Failure scenario.** A screen-reader user gets no feedback at all when an
action fails. In the wizard's case they are additionally left focused on a
control that no longer exists.

**Remediation.** Add `role="alert"` (assertive) to error banners and
`role="status"` (polite) to success and copy confirmations. Move focus to the
banner when an error lands, and to the offending field where there is one.

**Done when.**
- Every error and success message is announced.
- A wizard validation failure moves focus to the field that failed.

---

## A11Y-7 · The selected filter pill is invisible in dark mode, and carries no state for assistive technology

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (computed contrast)
- **Blast radius:** accessibility
- **Locations:**
  - `app/(protected)/projects/page.tsx:130` and `app/(protected)/companies/page.tsx:97` — `bg-slate-900 text-white`
  - `app/globals.css:218` — the dark bridge remapping `bg-slate-900` to `#020617`
  - Toggle groups with no `aria-pressed` / `aria-current` / radiogroup semantics: `projects/page.tsx:125-141`, `companies/page.tsx:94-100`, `ProjectWizard.tsx:251, 272-273`, `CostsTab.tsx:440`, `ScheduleTab.tsx:240-252`, `submit/[token]/page.tsx:223-224`
  - `app/(protected)/projects/[id]/page.tsx:418-448, 709-720` — seven tabs with no `role="tablist"` / `tab` / `tabpanel`, no `aria-selected`

**Mechanism.** In dark mode the selected pill's background measures **1.05 : 1**
against the unselected pills' surface and **1.07 : 1** against the canvas. Its
text is `#ffffff` against the others' `#f1f5f9` — indistinguishable. The only
remaining cue is that *unselected* pills have a border.

**Failure scenario.** Combined with the missing `aria-pressed`, **which status
filter is active is unknowable in dark mode for everyone** — sighted or not.

**Remediation.** Use the accent token for the selected pill rather than a slate
that the dark bridge collapses. Add `aria-pressed` to all seven toggle groups
and proper tab semantics to the tab strip.

**Done when.**
- The selected filter is visually obvious in both themes.
- A screen reader reports which filter and which tab is active.

---

## A11Y-8 · Accept and Reject are nineteen-pixel targets four pixels apart, and Accept has no confirmation

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (computed from the Tailwind box)
- **Blast radius:** accessibility / safety
- **Locations:**
  - `components/projects/QualityTab.tsx:571, 574, 577, 580` — Received / Accept / Reject / Waive, `gap-1`
  - Roughly twenty other sub-24px controls, worst first: `ProjectWizard.tsx:229` (stepper segments, **~6px**, six of them focusable, and the current step is enabled-but-inert with no `aria-current`), `IntakePanel.tsx:373` (**~12px**), `QuotesPanel.tsx:160, 249` (**~13px**, bare text buttons), `QualityTab.tsx:699` (**~16×20px**, destructive punch void), `QuotesPanel.tsx:397, 420, 441` / `ChangeOrdersPanel.tsx:180, 184` / `QualityTab.tsx:470, 474, 478, 697` / `CostsTab.tsx:393` (**~19px**), `ProjectWizard.tsx:362, 382, 406` and `ScheduleTab.tsx:610` (**~22px**, destructive), `QuotesPanel.tsx:415` / `ChangeOrdersPanel.tsx:173` (**~24px** selects)
  - `app/globals.css:298-303` — the existing `@media (pointer: coarse)` rule that enlarges checkboxes and radios, and nothing else
- **Related:** `SAF-4` (Waive needs no reason)

**Mechanism.** WCAG 2.2 SC 2.5.8 asks for 24×24 px; a gloved hand needs 44.
These four decisions land on a contractor's permanent record, and **Reject and
Waive prompt while Accept fires immediately**.

**Failure scenario.** A mis-tap on a tablet is an acceptance nobody made, with
no confirmation to catch it.

**Remediation.** Raise the whole cluster to at least 32px with an 8px gap under
`(pointer: coarse)` — the media query already exists, extend it to inline
buttons. Add a confirm to Accept, matching its siblings. Make the wizard stepper
segments taller (or non-focusable, with a separate labelled step control) and
give the current step `aria-current="step"`.

**Done when.**
- No decision control in the Quality tab is under 24px, or under 44px on a coarse pointer.
- Accept has the same confirmation weight as Reject.
- The stepper is either a real control or not in the tab order.

---

## A11Y-9 · Company dimension bars overflow their card on a phone

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (computed)
- **Blast radius:** mobile
- **Locations:**
  - `app/(protected)/companies/page.tsx:196-202` — `w-24` label + `w-24` bar + `w-7` number + 3× `gap-2`, all `shrink-0`
  - `app/(protected)/companies/[id]/page.tsx:127-133` — `w-28` + `w-32` + `w-8` + gaps, and the detail span here has **no `truncate`**
  - Neither card sets `overflow-hidden`

**Mechanism.** List card: **244 px irreducible** against 219 available at 375px
(the `truncate` detail collapses to zero, but the fixed elements still overflow
by ~25px). Profile header: **296 px irreducible** against ~175 available —
roughly **120 px of horizontal overflow**, and nothing there can shrink.

**Remediation.** Drop the fixed widths below `sm:`, letting the label and bar
flex, and stack the label above the bar on narrow screens. Add `min-w-0` and
`overflow-hidden` to the containers.

**Done when.**
- Neither card overflows at 375px.
- The page body never scrolls horizontally.

---

## A11Y-10 · The wizard's repeater rows leave about thirty pixels for the name field on a phone

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (computed)
- **Blast radius:** mobile
- **Locations:**
  - `components/projects/ProjectWizard.tsx:352-363` — budget row: `flex-1` name + select + `w-32` amount + remove, `gap-2`
  - `components/projects/ProjectWizard.tsx:396-407` — team row, worse
  - `components/projects/ProjectWizard.tsx:376-383` — milestone row
  - `components/projects/ProjectWizard.tsx:259` — `grid grid-cols-2 gap-3` with no responsive collapse
  - `app/(protected)/companies/page.tsx:297, 309` and `app/(protected)/companies/[id]/page.tsx:507, 517, 528` — `grid-cols-2` / `grid-cols-3` with no `sm:` prefix
  - `app/submit/[token]/page.tsx:228, 233` — the correct pattern, in the same pull request: `grid-cols-1 sm:grid-cols-2`
  - `app/(protected)/projects/[id]/page.tsx:283-415` — up to **10 direct flex children** with `justify-between` + `flex-wrap`, so wrapped lines get ragged gaps and destructive **Delete** ends up beside benign **Report**
  - `app/(protected)/projects/[id]/page.tsx:268, 455` and `app/(protected)/companies/[id]/page.tsx:88` — hardcoded `px-6` instead of `PageShell`'s `px-4 sm:px-6 lg:px-8`
  - `components/projects/CostsTab.tsx:127, 301` — stat values `truncate` with **no `title`**, so a clipped `$1,234,567` is unrecoverable by any means

**Mechanism.** Inside the wizard modal at 375px there are 295 usable pixels. The
budget row's amount field (128), kind select (~90), remove button (~22) and gaps
(24) consume 264 — leaving roughly **31 px** for the budget-line name. None of
these rows wrap or restack. The three-across contact grid gives each input
**~92 px**, so "Contact name" / "Email" / "Phone" are all truncated and typing
an email in 92px is punitive.

**Remediation.** Restack the repeater rows vertically below `sm:`. Add `sm:`
prefixes to the five non-responsive grids — the submit portal in the same PR
shows the pattern. Group the header actions into labelled clusters (status /
export / danger) instead of ten peers. Use `PageShell`'s padding. Add `title`
to the truncating stat values.

**Done when.**
- Every form field at 375px is wide enough to type in.
- No grid stays multi-column on a phone.
- A truncated money value is recoverable (tooltip or wrap).

---

## A11Y-11 · The crew-size chart announces itself as "Daily activity" and exposes no values

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/cost/CostCharts.tsx:90, 126` — reuses `MiniBars` for "Planned crew size by week"
  - `components/dashboard/viz.tsx:104` — `MiniBars` hardcodes `role="img" aria-label="Daily activity"` and exposes no override
  - The weekly headcounts live only in `title` attributes on plain `<div>`s
- **Related:** `CHART-3` (the curve is flat anyway)

**Mechanism.** A screen reader hears a chart called *Daily activity* with zero
values.

**Failure scenario.** This is the **one place in the new work where information
is conveyed as a chart with no text equivalent anywhere on the page.** Every
other chart pairs its visual with real text.

**Remediation.** Add an `aria-label` prop to `MiniBars` and pass a value-bearing
label. If `CHART-3` is resolved by replacing the chart with a stat, this
disappears with it — resolve that one first.

**Done when.**
- The chart's accessible name describes what it shows.
- The headcount values are available as text.

---

## A11Y-12 · Decision-critical knowledge is hover-only, at roughly sixty-five sites

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** accessibility / rookie-readability
- **Locations (ranked by what the user loses):**
  - `components/projects/QualityTab.tsx:496` — the **entire meaning of the checklist status dots**, with no legend anywhere (see `A11Y-2`)
  - `components/projects/QualityTab.tsx:375, 380` — **what the two AI buttons do**, including that one bulk-rewrites compliance statuses
  - `components/projects/CostsTab.tsx:440` — **Commitment vs Actual vs Adjustment**, the three most confusable words in cost control
  - `components/projects/cost/QuotesPanel.tsx:323 vs 328` — **excludes vs silent gap**, the distinction that explains why the low bid is low and decides the award
  - `components/projects/cost/QuotesPanel.tsx:299` — that undisclosed manpower **scores at the field's floor** (a ~30-point penalty, invisible)
  - `components/projects/cost/ChangeOrdersPanel.tsx:160` — that **reason codes score both sides**
  - `components/projects/cost/QuotesPanel.tsx:262-265` — the column definitions and the **value-score formula** (visible as text only when `econ.length > 1`)
  - `components/projects/cost/QuotesPanel.tsx:410` — the fix for "needs a budget line" (see `UX-13`)
  - `components/projects/CostsTab.tsx:235, 348, 512` — the earned-value formula
  - `components/projects/QualityTab.tsx:459` — machine-found vs human-attached evidence, identical otherwise
  - `components/projects/QualityTab.tsx:699` — "Void — not a real snag", the entire label for a destructive action
  - `components/projects/ScheduleTab.tsx:727` — what milestone **weight** means
  - `app/(protected)/companies/[id]/page.tsx:522` — that "do not use" flags the company, inside a `<select>`, unreachable by keyboard
  - `components/ui/HelpTooltip.tsx` — the right pattern (click-to-toggle, Escape, click-away), used twice
  - `components/projects/CostsTab.tsx:277` — the comment reading "Plain-language glossary — visible, not a hover Easter egg", above a glossary that defaults collapsed at the page bottom

**Mechanism.** `title` on a non-focusable element is invisible on touch, to the
keyboard, and to screen readers.

**Remediation.** Convert the top six to visible text or click-tooltips — the
checklist legend, the two AI button explanations, the
Commitment/Actual/Adjustment hints, and the excludes-vs-silent-gap distinction.
Open the cost glossary by default on first visit. `HelpTooltip` already exists;
this is mostly substitution.

**Done when.**
- No decision-critical explanation is reachable only by hover.
- The checklist card has a visible status legend.

---

## A11Y-13 · Contrast failures and missing dark variants

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (computed)
- **Blast radius:** accessibility

**Mechanism and locations, worst first:**

- **`text-amber-600` on white = 3.19 : 1** — `IntakePanel.tsx:299`, at
  `text-base font-black` (16px, so 4.5:1 applies). This is **the count of
  submissions awaiting review** — the most action-triggering number on the tab —
  and it fails in the *default* theme.
- **`amber-700` on `amber-500/15` = 4.47 : 1** — `ChartKit.tsx:286`,
  `ChangeOrdersPanel.tsx:89`, `QualityTab.tsx:657`. Fails AA at 9–10px. The file
  is inconsistent with itself: `CostsTab.tsx:160` correctly uses `amber-800`.
- **`text-rose-700` with no `dark:` variant = 2.81–2.82 : 1** —
  `CostsTab.tsx:516, 587`, `ChangeOrdersPanel.tsx:262`. All three are **form
  validation errors**, and the same files use `dark:text-rose-300` correctly
  elsewhere (`CostsTab.tsx:120, 230`).
- **`text-red-600` with no `dark:` variant = 3.67 : 1** —
  `projects/[id]/page.tsx:307, 665, 936`.
- **Light-on-dark error panels** (`bg-red-50 border-red-200 text-red-700`) —
  `projects/page.tsx:161`, `projects/[id]/page.tsx:254`,
  `companies/[id]/page.tsx:77`, `ScheduleTab.tsx:221, 733`. Text contrast inside
  is fine; the panel is a glaring white-pink slab in a dark UI, and inconsistent
  with the token recipe used at `projects/[id]:274` and `CostsTab:120`.
- **`ActionButton` red/emerald variants** — `projects/[id]/page.tsx:698, 700`:
  **Delete**, **Cancel** and **Complete** render as light chips in dark mode.
- **`hover:bg-slate-50/60` is not bridged** — `projects/[id]/page.tsx:767`. The
  bridge covers `bg-slate-50\/60` and bare `hover:bg-slate-50`, but not this
  combination, so hovering a checkout row in dark mode flashes a near-white band.
  (Contrast: `ScheduleTab.tsx:390`'s bare `bg-slate-50/60` *is* bridged.)
- **`text-emerald-700 bg-emerald-50`** — `ScheduleTab.tsx:289, 598`
  (Set-baseline, Done): light chips in dark mode. And
  `projects/[id]/page.tsx:756` — the "Currently checked out" heading measures
  **1.60 : 1** in dark.
- **Missing `[color-scheme:dark]`** — `ScheduleTab.tsx:724` is the one date input
  without it (seven others have it), and it also lacks a surface background, so
  in dark mode it renders a white native field with a light calendar popup
  inside a dark form.
- **`text-slate-300` decorative icons** fall outside the bridge (which maps
  400/500 and 600–950) — `projects/page.tsx:237, 266`,
  `projects/[id]/page.tsx:726`, `ScheduleTab.tsx:577`, `companies/page.tsx:120`.
  Harmless; renders brighter than intended.
- **`app/submit/[token]/page.tsx:155, 182, 196, 199, 212, 251, 293-296`** —
  status chips and result messages with no dark variants (emerald 3.26:1, rose
  2.84:1, amber 3.53:1). *Mitigated:* the theme pre-paint only adds `.dark` when
  the viewer has explicitly chosen it, which a first-time vendor has not — so in
  practice this bites internal users previewing the portal.

**Remediation.** Standardize on `amber-800`/`amber-900` for light-mode amber
text. Add the missing `dark:` variants at the eleven sites listed. Convert the
five light error panels to the token recipe. Add `hover:` to the dark bridge's
slate-50 coverage or replace the class. Add `[color-scheme:dark]` and a surface
background to the one date input.

**Done when.**
- Every text/background pair in the Projects area clears 4.5:1 in both themes.
- No error panel renders light-on-dark.
- All date inputs match the theme.

---

## Verified sound — do not "fix" these

- **`SCurveChart` is exemplary** (`ChartKit.tsx:61-62`): real `role="img"` with a
  value-bearing label, a legend restating every series with its number, the
  planned line **dashed** so identity survives grayscale, grid in
  `--viz-track`, text in text tokens. Best-in-file.
- **`BarList`** carries label, value, sublabel and the over-budget flag as text —
  no ARIA needed.
- **All five company dimensions and all four coach health parts** render score
  *and* narrative detail as real text beside the bar. Nothing is chart-only
  there.
- **`ExampleFrame` marks stand-in data with a visible watermark *and* a text
  badge** — not colour alone. (Its contrast is a separate finding, `REL-10`.)
- **No click-only handlers on non-interactive elements** anywhere in the audited
  files — every action is a real `<button>` or `<Link>`, so all inherit the
  global focus-visible outline.
- **Member row actions** use `opacity-60 sm:opacity-0 group-hover:opacity-100`
  (`projects/[id]:979, 993`) — visible at rest on touch, revealed on hover on
  desktop, and revealed by `:focus-within`. Exactly right.
- **Destructive actions route through `appConfirm`/`appPrompt`**, which render
  inside the proper `Modal` — so the confirmation dialogs are more accessible
  than the modals that spawn them.
- **The bid table scrolls inside its own `overflow-x-auto` container**
  (`QuotesPanel.tsx:256`) rather than blowing out the viewport; the seven-tab
  strip scrolls horizontally; every card grid collapses to one column.
- **The vendor submit portal is genuinely mobile-first** — responsive shell
  padding, collapsing form grids, full-width 40px primary buttons, `min-h-dvh`.
  Its problems are keyboard (`A11Y-1`) and contrast, not layout.
- **Date inputs handle `color-scheme` correctly** at seven of eight sites.
- **Enter-to-submit** is wired on the goal input, turnover add, punch add and
  company event; the member responsibility field also handles **Escape** — the
  only Escape handler in the new code.
- **`prefers-reduced-motion` is honored globally**, covering every entrance
  animation in the new components.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| A11Y-1 | CRITICAL | OPEN |
| A11Y-2 | CRITICAL | OPEN |
| A11Y-3 | CRITICAL | OPEN |
| A11Y-4 | HIGH | OPEN |
| A11Y-5 | HIGH | OPEN |
| A11Y-6 | HIGH | OPEN |
| A11Y-7 | HIGH | OPEN |
| A11Y-8 | HIGH | OPEN |
| A11Y-9 | HIGH | OPEN |
| A11Y-10 | HIGH | OPEN |
| A11Y-11 | MEDIUM | OPEN |
| A11Y-12 | MEDIUM | OPEN |
| A11Y-13 | MEDIUM | OPEN |
