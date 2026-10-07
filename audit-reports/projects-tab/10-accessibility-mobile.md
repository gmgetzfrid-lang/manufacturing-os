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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** accessibility / legal
- **Locations:**
  - `components/projects/cost/QuotesPanel.tsx:478` — `<input type="file" className="hidden" …>`
  - `app/submit/[token]/page.tsx:173, 245, 274` — the same, on the **public, unauthenticated** portal
  - `app/(protected)/plot-plans/page.tsx:166` — the working pattern already in the repo: `className="sr-only"`
- **Re-verified:** hardening pass — **SURVIVES**. Every file input on both surfaces carries `className="hidden"` — `QuotesPanel.tsx:478` and `app/submit/[token]/page.tsx:173, 245, 274` — and a grep for `sr-only` on the public portal returns **0**. `display: none` removes an element from the tab order, so on the vendor portal there is no keyboard path to submit at all.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Scope correction, not a severity correction: the plot-plans citation is refuted (sr-only inputs stay in the tab order, so redline/background upload there IS keyboard-reachable), while the QuotesPanel and the public unauthenticated /submit/[token] pickers — including the redlines picker at :274 — are genuinely unreachable, which sustains CRITICAL on its own.

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

**Resolution (2026-10-01, projects Round G).** `app/submit/[token]/page.tsx`: the drawing, document and redlines file inputs are `sr-only` (visually hidden, still in the tab order — the plot-plans pattern) inside labels that show keyboard focus (`focus-within:ring-2` on the accent ring), so Tab reaches each picker and Enter / Space opens it; the redlines input is named ("Upload redlines for {title}") and disabled while a send is in flight. The "What are you submitting?" toggle is a labelled button group with `aria-pressed`, and a send's result lands in a live region that is always mounted (`PortalMessage`: an error is `role="alert"`, a success `role="status"`, both with dark variants). `components/projects/cost/QuotesPanel.tsx`: the quote picker is `sr-only` the same way. Tests: `a11yProjects.test.ts` "A11Y-1 —" — a census that no `type="file"` input on a Projects surface or the portal is `hidden` and each sits in a label that shows focus; the rendered portal with every picker focusable and named (drawing form, quote form, each redlines request); the pressed toggle and the announced result.

**Done-when.**
- ✓ Every file picker in the Projects area and the submit portal is reachable by Tab and activatable by Enter or Space (census + rendered portal).
- ✓ The submit portal is completable with a keyboard alone: mode toggle, text fields, the picker and Send are all tab stops in order, and the result is announced.

**Scope / residual.** The ~20 other `hidden` file inputs elsewhere in the app (the finding's "wider pattern") are outside the Projects area and were not touched (DEC-31).

---

## A11Y-2 · Checklist item status is conveyed entirely by an eight-pixel coloured dot, on the PSSR surface

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** accessibility / safety
- **Locations:**
  - `components/projects/QualityTab.tsx:488-497` — `StatusDot`: `<span className={\`… w-2 h-2 rounded-full …\`} title={m.t} />`
  - `components/projects/QualityTab.tsx:686` — the punch dot, which has **no `title` at all**
  - `app/(protected)/companies/[id]/page.tsx:313` — the rubric dot, also no title
  - `components/projects/QualityTab.tsx:439-485` — the row, which renders item text, AI rationale, manual note and evidence chips, and never the status
  - `components/dashboard/viz.tsx` — the house rule this breaks: "identity never colour-alone"
- **Re-verified:** hardening pass — **SURVIVES**. `StatusDot` is `<span className="w-2 h-2 rounded-full …" title={m.t} />` (`QualityTab.tsx:488-497`) — colour plus a `title`, with no text, no `aria-label` and no `role`. `title` is not reliably announced and is unreachable without a pointer.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. Verified: an 8px `w-2 h-2` dot carrying `title` on a non-focusable, role-less span is the only status carrier, QualityTab contains zero aria/role/sr-only, and the cited counterexample components/dashboard/viz.tsx:104,185 does use `role="img" aria-label`, so the codebase knows the pattern. Severity corrected down because the state is not entirely absent from the accessible surface — the presence/absence of the evidence chips (:456-465), the `Assessment:` rationale text (:445-449), and the status-dependent action buttons (:466-483) give a screen-reader user indirect signal — and because A11Y-2 is a perception defect, not one that moves money or record state.

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

**Resolution (2026-10-01, projects Round G).** New `components/projects/StatusMark.tsx`: each status has its own glyph inside a ringed mark (checklist: Satisfied ✓ / Needs evidence clock / Open dash / Not applicable slash; punch: Open / Overdue / Done ✓ / Void slash — done and void now differ by glyph and word; rubric: Covered ✓ / Gap ✕), a visually-hidden "Status: {word}." the screen reader reads with the row, the word in the mark's title, and colour as a third carrier only. `StatusLegend` renders the same table as a visible key. `QualityTab.tsx` uses the marks on every checklist item and punch row (the 8 px `StatusDot` is gone) with a legend on the checklist card and on the punch list; `companies/[id]/page.tsx` uses them on the rubric rows with a legend (the timeline's decorative event dot is `aria-hidden`). Tests: `a11yProjects.test.ts` "A11Y-2 —" (every state has a distinct glyph and word; the rendered mark's accessible text names its state; done vs void differ by glyph and word; the legend lists every state; no bare colour dot is left on the checklist, punch or rubric rows).

**Done-when.**
- ✓ Every status is readable as a word and a distinguishable glyph, not hue alone.
- ✓ A screen reader announces the status of each checklist, punch and rubric row ("Status: Needs evidence.").
- ✓ The checklist card carries a legend (and so do the punch list and the rubric).

**Scope / residual.** None.

---

## A11Y-3 · Milestone row tints make the row unreadable in dark mode

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED (computed contrast)
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/ScheduleTab.tsx:528-532` — the tints, hardcoded light-mode values with no `dark:` variant
  - `components/projects/ScheduleTab.tsx:545` — the milestone name
  - `components/projects/ScheduleTab.tsx:558` — the date / duration / responsible-party line
  - `components/projects/ScheduleTab.tsx:578, 582` — the overdue and slip text
- **Re-verified:** hardening pass — **SURVIVES**. The tints at `ScheduleTab.tsx:527-532` are `bg-emerald-50/50`, `bg-red-50/50`, `bg-amber-50/50` with **no `dark:` variant**, while the row's text is `text-[var(--color-text)]`, which flips light in dark mode. Light text on a light tint.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The claim holds and the guard I went looking for is documented as deliberately absent. In `.dark` the row keeps a light tint (emerald-50 #ecfdf5 at 50% over canvas #0b1120 composites to roughly #7c8a8a) while the text on it flips to `--color-text` #f1f5f9 (~3.3:1) and the secondary date line at :559 to `--color-text-muted` #94a3b8 (~1.4:1); the hardcoded `text-red-700`/`text-emerald-700` at :578-582 land at ~1.4:1 on that same composite. Unreadable is accurate for the muted line.

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

**Resolution (2026-09-30, projects Round G).** `components/projects/ScheduleTab.tsx` `MilestoneRow`: the light-mode tints are replaced with the codebase's theme-safe recipe — low-alpha status colour over the surface with a half-alpha border (`bg-emerald-500/[0.08] border-emerald-500/50`, rose for missed / overdue, amber for blocked / on hold) — and the coloured text on the row gets its dark variant (`text-rose-700 dark:text-rose-300`, emerald likewise). Text that sits on the tint uses `text-slate-600` (#475569, which `app/globals.css` maps to #cbd5e1 under `.dark`) instead of `--color-text-muted`: the muted token (#64748b) measures 4.29–4.48 : 1 on any light tint. The Done button, the delete button's hover, the "vs plan" chip and the status chips use the same recipe. Test: `scheduleEngineUi.test.ts` "A11Y-3 ·" — no `-50` / `-300` tint (and no light-palette `bg-` / `border-` step) remains anywhere in the row renderer, and every tint the renderer uses × every text colour on it (text, secondary, rose, emerald) × both themes clears 4.5 : 1, computed by the WCAG formula over the composited background (lowest: 4.72 light — emerald-700 on the Done button's hover tint — and 7.27 dark; the audit's measured 1.39–3.32 : 1 in dark mode are gone).

**Done-when.** 1 ✓ (computed; Tailwind's v3 sRGB steps — v4's oklch steps render within a few units). 2 ✓.

**Scope / residual.** The source badge and WBS chip sit on their own `--color-surface-2` chips and were not changed.

---

## A11Y-4 · Five modals with no dialog role, no focus trap, no Escape and no backdrop dismissal

- **Severity:** HIGH
- **Status:** RESOLVED
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
- **Re-verified:** hardening pass — **SURVIVES**. Each modal root is a bare `<div className="fixed inset-0 z-[200] …">` (`ProjectWizard.tsx:213`, `projects/[id]/page.tsx:562`) — no `role="dialog"`, no `aria-modal`, no focus trap, no Escape handler, no backdrop click.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by repo-wide search: no focus-trap/inert utility exists anywhere (`grep -rn "focus-trap\|useFocusTrap\|trapFocus\|inert"` hits only components/marketing/TourTabs.tsx), and none of the five files registers a keydown listener. Even Modal.tsx itself, the shell they should be using, has no focus trap and no focus restore — so adopting it would fix role/Escape/backdrop but not the tab-out or return-focus half of the finding.

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

**Resolution (2026-10-01, projects Round G).** `components/ui/Modal.tsx` (shared by the whole app — every importer checked) gains the trap and the restore, with Escape / backdrop / non-dismissable behaviour unchanged for a single modal: opening moves focus into the dialog (an `autoFocus` inside keeps it; otherwise the panel itself takes focus — the shell never picks the first field for the caller); Tab and Shift+Tab wrap only at the edges, and focus that escaped to the page behind is brought back; a module-level stack makes only the topmost modal trap and answer Escape, so a confirm opened from a dialog closes alone (an intended change to the shared shell, recorded in DEC-76 item 5: with nested modals each open dismissable `Modal` used to answer the same Escape, so one key closed all of them); Escape already handled inside (an open `HelpTooltip` in front — see the review fix) does not close the dialog; on close focus returns to the opener — captured at render, before `autoFocus` moves — only when the dialog really closed, focus was lost with it, and the opener is still connected; a closed modal traps nothing. `ModalHeader`'s title names the dialog (`aria-labelledby`), and callers can pass `ariaLabel` / `ariaLabelledBy`. The five hand-rolled shells now compose it: the project wizard (`ProjectWizard.tsx` — not dismissable while a write is in flight), the lessons-learned editor and the status-transition confirm (`projects/[id]/page.tsx`, each with a labelled close and a scrolling middle), Add company (`companies/page.tsx`) and Edit company (`companies/[id]/page.tsx`). A dismissal of a form someone has typed into asks before discarding it. Tests: `modalFocus.test.ts` (18) — the trap (entry, wrap at both edges, escaped focus pulled back, a form inside the trap still submits on Enter), single-modal dismissal unchanged (Escape and backdrop close a dismissable modal; a non-dismissable one ignores both and still traps; an open tooltip takes the first Escape), restore (to the opener; never to an opener that unmounted; focus the consumer moved on close is left alone), nesting (`DialogProvider`'s confirm over a dialog closes alone and focus returns into the dialog; `appConfirm` / `appPrompt` unchanged), and each of the five modals rendered as a named dialog.

**Done-when.**
- ✓ All five compose the shared `Modal`.
- ✓ Escape and backdrop click close each one (asking first when typed input would be lost; the wizard not while a write runs).
- ✓ Focus is trapped while open and restored on close.

**Scope / residual.** The mechanism also notes that no modal locks body scroll. The shared `Modal` never did, and adding it changes every consumer in the app; it was not part of the done-when and was left alone (REGRESSION FIRST).

**Review fix (2026-10-01, projects Round G).** (1) **The exit stays on screen.** The shared panel is `max-h-[90vh]` with its overflow hidden, so a composed dialog whose middle does not scroll clips its own footer: the lessons-learned editor's textarea block was not a scroll container, and on a short viewport (a landscape phone, ~337 px of panel) or after the textarea was dragged taller, "Save to project" was cut off with nothing to scroll — the failure scenario above, back for the Save path. Each of the five now has the same recipe: the region between header and footer scrolls (`overflow-y-auto min-h-0`) and the header and footer never shrink (`shrink-0`) — the lessons-learned editor, the transition confirm, the wizard and both company dialogs. (2) **Every way out asks first.** The lessons-learned editor's header X and Cancel discarded edits without the confirm Escape and the backdrop ask for; they now go through the same `discardLessons`, as do the Add / Edit company dialogs' X and Cancel (`dismiss`) and the wizard's header X (`dismissWizard`, which keeps the partial-failure confirm). (3) **Escape belongs to what is in front.** `components/ui/HelpTooltip.tsx` marks Escape handled only when focus is inside the note, or the note sits in the topmost open dialog (or no dialog is open); a note left open on the page behind a dialog closes quietly and lets the dialog have the same Escape (a keyboard user who opened "What each export contains" and then Tab-Enter'd "Lessons learned" needed two Escapes). The note also closes when focus moves to another element, so it is not left open behind a dialog that takes focus. Tests: `modalFocus.test.ts` (23, +5) — every composed modal's middle is a scroll container with a fixed header and footer (the five on the source, the wizard's panel rendered); the header X and Cancel ask before discarding (the wizard and Add company rendered, the lessons editor on the source); a note behind a dialog does not swallow the dialog's Escape; with no dialog open the note still takes Escape, and focus moving away closes it.

- Done-when after the fix: ✓ all five compose `Modal`; ✓ Escape and the backdrop close each (and the X / Cancel ask as they do); ✓ focus trapped and restored — and the Save / Confirm footer stays reachable on a short viewport.

**Second review fix (2026-10-01, projects Round G).** (1) **The status-transition confirm asks too.** The review fix above said every dismissal of a typed-into form asks before discarding, but the project page's status-transition confirm closed on Escape, a backdrop click, the header X or Cancel and silently cleared its reason — a cancellation's reason is mandatory, so a misclick lost it. All four exits now go through `discardTransition` (`app/(protected)/projects/[id]/page.tsx`): no reason typed → it closes at once; a reason typed → "Discard your reason?" first; never while the transition runs. (2) **The shared trap leaves alone what another handler owns** (`components/ui/Modal.tsx`). A Tab a control inside the dialog already handled (`defaultPrevented` — a textarea that inserts a mention on Tab, as `MentionableTextarea` does, placed last) is no longer yanked to the first field; a Tab while focus sits in an overlay the modal does not own (another `role="dialog"` / `aria-modal`, a portaled listbox or menu opened above it) is that overlay's. (3) **Escape honours "handled" only from inside the panel.** An Escape a control inside the panel handled is theirs (the open `HelpTooltip` keeps working); one handled only by a page-level handler outside the panel no longer stops the topmost modal cancelling — the keys are now read on `document`, after a control's own handler and before any `window` handler, so a hand-rolled overlay under an `appConfirm` that preventDefaults Escape can no longer leave the confirm on screen with Confirm focused. The topmost-only rule is DEC-76 item 5, marked there for the integrator's ratification (the brief asked for unchanged Escape and nested-modal behaviour). Tests: `modalFocus.test.ts` (27, +4: a Tab-handling textarea last in the panel keeps focus while an unhandled Tab still wraps; focus in a listbox or an `aria-modal` dialog above the modal keeps its own Tab while focus escaped to the page behind is still brought back; a page-level `window` Escape handler cannot stop the cancel while a control inside the panel can; the listener sits on `document` — the four fail on the previous `Modal`), and the transition confirm's four exits and `discardTransition` pinned on the source (the page needs the whole project to render).

*Third review fix (2026-10-01, projects Round G) — what the integrator ratifies.* The Escape change to the shared `components/ui/Modal.tsx` (DEC-76 item 5) is a deliberate deviation from the brief's "keep Escape / nested-modal behaviour identical", and it is **RATIFIED by the integrator at merge (2026-10-01)** — no consumer before J10 nests a `Modal`, so every existing screen keeps its Escape behaviour (`DEC-76` item 5). What it changes, exactly: (a) with nested `Modal`s only the topmost answers Escape (before, each open `Modal` registered its own `window` listener and one Escape closed them all); (b) an Escape a control INSIDE the panel already handled (`defaultPrevented`) no longer closes even a single modal; (c) the listener sits on `document`, not `window`. Before J10 only two consumers imported `Modal` — `DialogProvider`'s `DialogHost` (confirm / prompt / alert) and the plot-plans page's "New plot plan" — and **neither nested a `Modal`** (the plot-plans dialog reports failures by toast, not by a dialog over itself) **nor held a control that handles Escape**, so for them one Escape still closes the open dialog; (a) and (b) matter only to J10's own nested flows (each dialog's discard confirm, the status-transition confirm). If it is not ratified: Escape goes back to every open `Modal` on `window` while topmost-only stays for the focus trap, and each J10 discard confirm then needs a re-entry guard (the parent's `onClose` ignores Escape while its own confirm is open). The single-modal sentence in the resolution above ("Escape / backdrop / non-dismissable behaviour unchanged for a single modal") is exact only with (b) excepted.

- Done-when after the second fix: ✓ all five compose `Modal`; ✓ Escape and the backdrop close each, and every way out of each of the five asks before discarding typed input — the transition confirm's reason included; ✓ focus trapped and restored, without taking a key another handler already owns.

*Integrator fix pass (final review minors, 2026-10-01):* Nothing changed here. The final review's optional item — a rendered behaviour test for the project page's lessons-learned or status-transition dialog (Escape with typed text opens the discard confirm; "no" keeps the dialog) — was not added: both dialogs are inline in `app/(protected)/projects/[id]/page.tsx`, which no test renders (it needs the whole project), and extracting them would edit a page another package edits later. They stay pinned on the source in `modalFocus.test.ts`. DEC-76 item 5 is still NOT ratified.

---

## A11Y-5 · The wizard's lookalike `Field` breaks label association, so every wizard input is unlabeled

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/ProjectWizard.tsx:456-463` — the local `Field`
  - `components/ui/Field.tsx:50-57` — the shared one, which wraps its children in the `<label>`
- **Re-verified:** hardening pass — **SURVIVES**, and the correct implementation is in the same codebase. The wizard's local `Field` renders `<label>{label}</label>` as a **sibling** of the control with no `htmlFor` (`ProjectWizard.tsx:456-463`), while the shared `components/ui/Field.tsx:50-54` **wraps** the control inside the `<label>`. Same name, opposite semantics.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The association defect is real and the wizard's local `Field` genuinely shadows the correct one. Severity corrected because the headline "every wizard input is unlabeled" overstates it: Name (:240), Description (:245), MOC reference (:261), Purpose (:284), Goals (:299) and Success criteria (:308) all carry `placeholder` text, which the accessible-name computation uses as a fallback, so they announce their placeholder rather than "blank". Only Job size (:248), Target completion (:265) and Visibility (:270) — a date input and two selects, where placeholder cannot apply — are truly nameless.

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

**Resolution (2026-09-29, projects Round G).** The wizard's lookalike `Field` is deleted; `components/projects/ProjectWizard.tsx` imports the shared `Field` from `components/ui/Field.tsx`, which wraps the control inside its `<label>` — Name, Description, MOC reference, Target completion (the date input the pass singled out), Purpose, Success criteria. The three controls that are not a single input — Job size (a button group), Visibility (a button group) and Goals (a list editor with an input and a button) — cannot legally sit inside a `<label>`, so they use a local `Group` (`role="group"` + `aria-labelledby` on the visible label); the Goals input carries `aria-label="Add a goal"`. Every repeated-row control (budget line name / cost type / amount, milestone name / date, company name / kind / trade), every icon-only button (remove row, remove goal, remove SOW, close) and the SOW search box now has an explicit accessible name matching or extending its visible label. The failure and error strips are `role="alert"`. Verified by reading (component; not in the vitest include) — the shared `Field`'s label-wrapping is pinned at `components/ui/Field.tsx:50-54`. Reproduced: `ProjectWizard.tsx:456-463` at `8276cad` rendered `<label>` as a sibling with no `htmlFor`.

**Done-when.**
- Every wizard input has an accessible name matching its visible label — ✓.

**Scope / residual.** `EditProjectModal.tsx` (same package) got the same treatment for its new fields. The `UX-15` asterisks ("Name *") are now inside the label and therefore announced.

---

## A11Y-6 · No error anywhere in the Projects area is announced to assistive technology

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED (zero `aria-live` / `role="alert"` / `role="status"` in any audited file)
- **Blast radius:** accessibility
- **Locations:**
  - Validation errors rendered into a plain `<div>`: `ProjectWizard.tsx:418`, `projects/[id]/page.tsx:665, 936`, `CostsTab.tsx:119, 516, 587`, `ChangeOrdersPanel.tsx:262`, `QualityTab.tsx:81`, `companies/page.tsx:319`, `companies/[id]/page.tsx:538`, `ScheduleTab.tsx:221, 733`, `submit/[token]/page.tsx:182, 251`
  - `components/projects/ProjectWizard.tsx:124-125` — `finish()` jumps back to step 0 and sets an error **without moving focus**
  - `components/projects/IntakePanel.tsx:292` — one banner carrying both success and failure with identical styling (see `UX-7`)
  - Silent confirmations: `QuotesPanel.tsx:630` ("Copied!"), `IntakePanel.tsx:352`
- **Re-verified:** hardening pass — **SURVIVES**. `{actionError && <div className="mt-2 text-xs text-red-600">{actionError}</div>}` (`projects/[id]/page.tsx:665`) and the equivalent at `companies/page.tsx:319` — no `role="alert"`, no `aria-live`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The claim of absence is confirmed by repo-wide search, not just at the cited lines. The wizard sub-claim also holds: ProjectWizard.tsx:124-125 calls `setStep(0)` alongside `setError(...)`, unmounting the step the user was focused on with nothing announced.

**Failure scenario.** A screen-reader user gets no feedback at all when an
action fails. In the wizard's case they are additionally left focused on a
control that no longer exists.

**Remediation.** Add `role="alert"` (assertive) to error banners and
`role="status"` (polite) to success and copy confirmations. Move focus to the
banner when an error lands, and to the offending field where there is one.

**Done when.**
- Every error and success message is announced.
- A wizard validation failure moves focus to the field that failed.

**Resolution (2026-10-01, projects Round G).** Every error and confirmation the finding cites is announced, and so is every other message on the Projects, Companies and portal surfaces: errors are `role="alert"`, successes and notes `role="status"` or a polite live region that stays mounted — the wizard's banner, the project page's action error, transition and member errors, the Costs tab's form errors, the change-order form, the Quality tab's notices (`Notice`: alert or status by tone), the companies pages, the Schedule tab, the portal (`PortalMessage`), the intake panel (UX-7), the quotes panel's "link copied" (an `sr-only` status), the execution board's undo toasts (`UndoToastHost`: a polite region that stays mounted, a warning assertive, a labelled Dismiss) and its duration / baseline dialog errors, the transition-in list's result line, and the project document card's error. The wizard moves focus on a refusal: to the field that failed (name, description, or the budget amount that is not a number — `pendingFocus` after the step renders) or, with no single field, to the announced banner (focusable, `tabIndex={-1}`). Tests: `a11yProjects.test.ts` "A11Y-6 / UX-7 —" (an area census that every file setting a message renders an alert or a live region; the toast region rendered; the intake tone; the cited sites), `modalFocus.test.ts` "A11Y-6: a wizard refusal moves focus to the failed field … or … to the announced banner".

**Third review fix (2026-10-01, projects Round G) — a correction.** The resolution above said every other message on the Projects surfaces was announced; it was not, and its census could not see it: the census passed a whole FILE once any `role="alert"` sat in it, and read only `set(Err|Error|Notice|Msg)`. Silent until now, each a plain `div`: the task edit's save error (`TaskDetailPanel.tsx`, also a light-only `bg-rose-50` slab) and its dependency editor's error, the rebase result and its error list (`RebaseScheduleModal.tsx`), the import result — "Imported with errors / cancelled / successfully" and its errors (`ScheduleImportModal.tsx`) — and, found by the new census, the stale-checkout release error (`StaleCheckoutBanner.tsx`) and the project page's timeline load error. Now the two task-panel errors, the release error and the timeline error are `role="alert"`; the rebase and import results sit in a polite live region that stays mounted, the result itself `role="alert"` when anything failed (or the import was cancelled) and `role="status"` when it all went; every one is in the token recipe (rose / emerald text on a `500/[0.08]` tint with a dark variant — no light-only slab). Tests: `a11yProjects.test.ts` "A11Y-6 / UX-7 —" (+2): a census **per render site** — every `{x && <…>}` / `{x ? <…>}` render of a message or RESULT state (setters ending Err / Error / Errors / Notice / Msg / Message / Result / Warning / Problem) must be an alert, a status or a live region itself, open an announcing component (`Notice`, `LoadFailed`, `PortalMessage`), or sit inside one (a brace-aware scan of the elements open at the site); one state is excluded by name with its reason (the import modal's `parseResult` — the parsed file, whose questions are form controls); mutation-checked on synthetic sources, and against the previous code it flags all six sites above; and the six sites pinned.

**Done-when.**
- ✓ Every error and success message is announced — since the third fix true per render site (it was not: six sites were silent, see the correction above).
- ✓ A wizard validation failure moves focus to the field that failed.

**Scope / residual.** None in the Projects area. Server routes' JSON errors are shown through the same announced banners.

---

## A11Y-7 · The selected filter pill is invisible in dark mode, and carries no state for assistive technology

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (computed contrast)
- **Blast radius:** accessibility
- **Locations:**
  - `app/(protected)/projects/page.tsx:130` and `app/(protected)/companies/page.tsx:97` — `bg-slate-900 text-white`
  - `app/globals.css:218` — the dark bridge remapping `bg-slate-900` to `#020617`
  - Toggle groups with no `aria-pressed` / `aria-current` / radiogroup semantics: `projects/page.tsx:125-141`, `companies/page.tsx:94-100`, `ProjectWizard.tsx:251, 272-273`, `CostsTab.tsx:440`, `ScheduleTab.tsx:240-252`, `submit/[token]/page.tsx:223-224`
  - `app/(protected)/projects/[id]/page.tsx:418-448, 709-720` — seven tabs with no `role="tablist"` / `tab` / `tabpanel`, no `aria-selected`
- **Re-verified:** hardening pass — **SURVIVES**. The selected pill is `bg-slate-900 text-white` (`projects/page.tsx:130`, `companies/page.tsx:97`) with no `dark:` variant — against a near-slate-900 dark canvas it disappears — and carries no `aria-pressed` or `aria-current`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The dark-mode contrast failure and the missing aria-pressed are both real, but "invisible" overstates it and "unknowable ... for everyone" is false: `text-white` is not remapped by the bridge, so the selected pill's label stays fully legible, and on the projects page the count badge `bg-white/20 text-white` (:137) is also unmapped and reads as a visibly lighter pip on the active tab whenever a count is non-zero. The defect is that selected and unselected become near-indistinguishable, not that the control disappears.

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

**Resolution (2026-10-01, projects Round G).** The selected status pill (`projects/page.tsx`) and kind pill (`companies/page.tsx`) are the accent ring on the accent tint with text-token text — legible in both themes, never a slate the dark bridge collapses (computed ≥ 4.5 : 1; an accent fill with white text measured 3.56 : 1 and was rejected) — and every toggle group the finding names says which option is pressed (`role="group"` + `aria-pressed`): the projects and companies filters, the wizard's job size and visibility, the Costs entry type, the Schedule tab's view and ghost toggles, the schedule filter bar's status / group / shift chips, and the portal's submission type. The project page's seven tabs are a `role="tablist"` of `role="tab"` buttons with `aria-selected` / `aria-controls`, and the content is the `role="tabpanel"` they control. Tests: `a11yProjects.test.ts` "A11Y-7 —" (computed contrast of the selected pill in both themes; `aria-pressed` on every named group; the tablist / tab / tabpanel), `modalFocus.test.ts` (the rendered pills report pressed).

**Done-when.**
- ✓ The selected filter is visually obvious in both themes.
- ✓ A screen reader reports which filter and which tab is active.

**Scope / residual.** None.

---

## A11Y-8 · Accept and Reject are nineteen-pixel targets four pixels apart, and Accept has no confirmation

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED (computed from the Tailwind box)
- **Blast radius:** accessibility / safety
- **Locations:**
  - `components/projects/QualityTab.tsx:571, 574, 577, 580` — Received / Accept / Reject / Waive, `gap-1`
  - Roughly twenty other sub-24px controls, worst first: `ProjectWizard.tsx:229` (stepper segments, **~6px**, six of them focusable, and the current step is enabled-but-inert with no `aria-current`), `IntakePanel.tsx:373` (**~12px**), `QuotesPanel.tsx:160, 249` (**~13px**, bare text buttons), `QualityTab.tsx:699` (**~16×20px**, destructive punch void), `QuotesPanel.tsx:397, 420, 441` / `ChangeOrdersPanel.tsx:180, 184` / `QualityTab.tsx:470, 474, 478, 697` / `CostsTab.tsx:393` (**~19px**), `ProjectWizard.tsx:362, 382, 406` and `ScheduleTab.tsx:610` (**~22px**, destructive), `QuotesPanel.tsx:415` / `ChangeOrdersPanel.tsx:173` (**~24px** selects)
  - `app/globals.css:298-303` — the existing `@media (pointer: coarse)` rule that enlarges checkboxes and radios, and nothing else
- **Related:** `SAF-4` (Waive needs no reason)
- **Re-verified:** hardening pass — **SURVIVES**, and the app's own coarse-pointer rule proves the gap. The Accept/Reject controls are `px-1.5 py-0.5 text-[10px]` buttons (`QualityTab.tsx:571`), while `globals.css:298-303` raises minimum sizes for `input[type=checkbox]` and `input[type=radio]` only — buttons are not covered.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Verified, and the consequence is worse than stated: once `status === "accepted"` none of the four button conditions at :570-581 match, so no Undo/Reopen control renders — a mis-tapped acceptance on a QA/QC turnover item is unrecoverable through the UI, not merely unconfirmed.

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

**Resolution (2026-10-01, projects Round G).** `QualityTab.tsx`: every decision control — Received / Accept / Reject / Waive / Reopen on turnover, the checklist item decisions (✓ Satisfied, ✓ Verify, N/A, ✓ Confirm N/A, Reject) and the punch Done / Void — carries one target floor set on the control itself (`DECISION_TARGET`: `min-h-6 min-w-6`, and on a coarse pointer `min-h-11 min-w-11` with wider padding — Tailwind's `pointer-coarse:` variant, so no bare-element rule was added to `globals.css`), in clusters spaced 8 px that wrap. Accept carries Reject's weight: it fires nothing on the click — it opens the reviewed-document pick and then the e-signature ceremony (QUAL-4 / DEC-66) before anything is written, which is the brief's default ("Accept opens the same reason dialog as Reject") met by a heavier existing confirmation (DEC-76 item 4). The wizard's stepper is out of the tab order (`tabIndex={-1}` — still clickable) and marks the current step `aria-current="step"`; Back / Next are the keyboard path. Tests: `a11yProjects.test.ts` "A11Y-8 —" (the floor; every named button carries it; 8 px clusters; Accept → document pick → ceremony; the stepper).

**Review fix (2026-10-01, projects Round G) — a correction.** Done-when 1 was ticked while three Quality-tab decision controls carried no floor: "Accept without naming a document" in the turnover document pick — the acceptance path itself, a 10 px underlined text button about 15 px tall — "Mark complete" (the checklist sign-off), and "Apply N ticked" in the AI review panel. Now every button in those three places carries `DECISION_TARGET`, in clusters spaced 8 px (`gap-2`): the document pick's results, "Accept without naming a document" and its Cancel; the checklist's decision cluster ("Which items apply to this job?", "Check evidence we already hold", "Mark complete"); the review panel's "Tick every in-scope proposal", "Clear", "Apply N ticked" and Cancel. The new contractor control on each turnover / punch row (MON-7) carries it too. Tests: `a11yProjects.test.ts` "A11Y-8 —" (+1: a census of EVERY `<button` in the document pick, the checklist's decision cluster and the review panel — counted, so a button added there without the floor fails — and the 8 px clusters; the decision-cluster count now includes the seed cluster).

**Third review fix (2026-10-01, projects Round G) — a correction.** Done-when 1 was ticked again while five Quality-tab buttons that WRITE had no coarse-pointer floor: **Seed required contents** (writes the required package, about 24 px), **Save checklist** and **Read it** (`h-8`, 32 px), and the turnover and punch **Add** buttons (`h-8`). Each now carries `DECISION_TARGET`, and so does the new **Assign** button (MON-7's decided-item naming). "Decision control" now means, and the census checks, every button whose click starts a write — read, save, seed, add, assess, sweep, review, waive, reopen, override, close, sign, accept, apply, pick, skip, assign. Tests: `qualityTabContractorAssign.test.ts` "A11Y-8 (J10 third fix)" (rendered: Seed, both Add buttons and Assign carry the 24 / 44 px floor; a counted source census over every `<button` in `QualityTab.tsx` whose `onClick` starts a write — 24 or more, none without the floor, the five named ones among them; it fails on the previous tab).

**Done-when.**
- ✓ No decision control in the Quality tab is under 24 px, or under 44 px on a coarse pointer — since the review fix, including the document pick, the checklist sign-off and the review panel; since the third fix every button that writes (Seed, Save checklist, Read it, both Add buttons, Assign), by a census over every write button in the tab.
- ✓ Accept has the same confirmation weight as Reject (heavier: a document pick and a signature).
- ✓ The stepper is not in the tab order (and marks the current step).

**Scope / residual.** The ~20 other sub-24 px controls the finding lists OUTSIDE the Quality tab (intake panel, quotes panel, change-order panel, Costs tab) are not part of the done-when and were not resized — opened as `A11Y-14` (DEC-31).

---

## A11Y-9 · Company dimension bars overflow their card on a phone

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (computed)
- **Blast radius:** mobile
- **Locations:**
  - `app/(protected)/companies/page.tsx:196-202` — `w-24` label + `w-24` bar + `w-7` number + 3× `gap-2`, all `shrink-0`
  - `app/(protected)/companies/[id]/page.tsx:127-133` — `w-28` + `w-32` + `w-8` + gaps, and the detail span here has **no `truncate`**
  - Neither card sets `overflow-hidden`
- **Re-verified:** hardening pass — **SURVIVES**. The row is `w-24 shrink-0` label + `w-24 shrink-0` track + `w-7 shrink-0` value (`companies/page.tsx:196-202`), and `w-28`/`w-32`/`w-8` on the detail page (`companies/[id]/page.tsx:127-133`) — over 220px of non-shrinking content inside a phone-width card.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The arithmetic confirms overflow at any common phone width (on a 390px viewport the list card leaves roughly 234px for a 244px minimum). Severity corrected because this is a clipped/spilling row in a scorecard — the numbers are still rendered and the page still functions — which sits below the workflow-breaking bar the other HIGH findings in this batch clear.

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

**Resolution (2026-09-29, projects Round G).** Both dimension rows drop their fixed widths below `sm:`: the label is `w-full sm:w-24` / `sm:w-28` (stacks above the bar on a phone), the track is `flex-1 sm:flex-none sm:w-24` / `sm:w-32` with `min-w-10`, the number keeps its `w-7` / `w-8`, and the detail wraps (`basis-full sm:basis-auto`, `truncate` on the list card, `break-words` on the profile). The list card and the profile header card carry `min-w-0 overflow-hidden`; the profile page gutter is `px-4 sm:px-6`. Pinned by source in `companiesRegistry.test.ts`.

**Done-when.**
- Neither card overflows at 375px — ✓ by construction: the only non-shrinking content on a row is the 28–32 px number; everything else flexes or wraps. Not measured in a browser (no browser in this loop).
- The page body never scrolls horizontally — ✓ by construction (`overflow-hidden` on the cards, `min-w-0` down the flex chain); same caveat.

**Scope / residual.** The hand-rolled modal (A11Y-4) stays with P11.

---

## A11Y-10 · The wizard's repeater rows leave about thirty pixels for the name field on a phone

- **Severity:** MEDIUM
- **Status:** RESOLVED
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
- **Re-verified:** hardening pass — **SURVIVES**. Both repeater rows put a `flex-1` name input beside a `<select>`, a `w-32` input and a delete button in one flex row (`ProjectWizard.tsx:352-363` and `:396-407`); on a 360px viewport the flexible field is what absorbs the shortfall.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The rows really are unusable on a phone, but the stated mechanism is wrong: flex and grid items default to `min-width:auto`, and an `<input>`'s automatic minimum is its intrinsic (size-attribute) width — roughly 170px at text-sm — so the name field does NOT collapse to ~30px. The row overflows its container instead; the wizard body at ProjectWizard.tsx:236 is `max-h-[60vh] overflow-y-auto`, and because one axis is non-visible the other computes to `auto`, leaving a horizontally scrollable (ugly, discoverable-by-accident) row rather than an unfillable field. Real but degraded to MEDIUM.

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

**Resolution (2026-10-01, projects Round G).** `ProjectWizard.tsx`: the budget, task and contractor repeater rows restack below `sm:` (`flex-wrap sm:flex-nowrap`; the name field takes the full row on a phone, `w-full sm:w-auto sm:flex-1 min-w-0`, with the select / amount / remove on the line below), and the MOC / date grid is `grid-cols-1 sm:grid-cols-2`. The companies pages' contact and profile grids are `grid-cols-1 sm:grid-cols-2|3`. The Costs tab's stat value wraps (`break-words`) instead of truncating, so a long money figure is never clipped. The project page's header and body use `px-4 sm:px-6`. Tests: `a11yProjects.test.ts` "A11Y-10 —" (no unprefixed `grid-cols-2|3` in the wizard or the companies pages; the three repeater rows restack; the stat value wraps), `modalFocus.test.ts` (the Add-company dialog's grids collapse on a phone).

**Done-when.**
- ✓ Every form field at 375 px is wide enough to type in (the name field owns a full row; nothing shares it with three controls).
- ✓ No grid stays multi-column on a phone (the cited grids).
- ✓ A truncated money value is recoverable — it no longer truncates; it wraps.

**Scope / residual.** The remediation's "group the header actions into labelled clusters" was not done: it is not a done-when item and the project page header is IS-P1's next (edits there were kept local). The page's one remaining `px-6` is the activity feed's inner padding.

---

## A11Y-11 · The crew-size chart announces itself as "Daily activity" and exposes no values

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** accessibility
- **Locations:**
  - `components/projects/cost/CostCharts.tsx:90, 126` — reuses `MiniBars` for "Planned crew size by week"
  - `components/dashboard/viz.tsx:104` — `MiniBars` hardcodes `role="img" aria-label="Daily activity"` and exposes no override
  - The weekly headcounts live only in `title` attributes on plain `<div>`s
- **Related:** `CHART-3` (the curve is flat anyway)
- **Re-verified:** hardening pass — **SURVIVES**. `MiniBars` hardcodes `role="img" aria-label="Daily activity"` (`components/dashboard/viz.tsx:104`) and is reused for crew size (`CostCharts.tsx:90`). The label is wrong and no per-bar value is exposed.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on both halves — wrong accessible name and zero exposed values. Minor caveat on the 'no text equivalent anywhere on the page' claim: the same Costs tab renders QuotesPanel's bid table, which has a numeric 'Peak crew' column (QuotesPanel.tsx:264), so the peak is available in text; the per-week distribution the chart shows is not.

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

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS. Resolved with `CHART-3`, as the remediation ordered: the crew chart is replaced by a stat. `components/projects/cost/CostCharts.tsx` `CrewStat` is text. Its section label reads "Planned average crew (from the awarded bid's hours)". The value reads "≈ 3.9 people", and the inputs read "1,980 labor hours over 90 days (12.9 weeks) ÷ 40 hours per person-week …". A screen reader gets the figure and how it was reached, and there is no `role="img"` named "Daily activity" on the Costs tab. `components/dashboard/viz.tsx` `MiniBars` also gains an `ariaLabel` prop, so any later reuse can say what its bars show. The default stays "Daily activity" for the dashboard's daily-activity widgets, which is what they show.
- Tests: `lib/__tests__/costChartsRender.test.ts` "renders the average and its inputs as text — no bars, no 'Daily activity'"; `lib/__tests__/chartKit.test.ts` "callers can say what the bars show; the dashboard default is unchanged".

**Done-when.**
1. ✓ The accessible name describes what is shown. There is no chart now: the section's text names it.
2. ✓ The headcount value is available as text, with its inputs.

**Scope / residual.** None.

---

## A11Y-12 · Decision-critical knowledge is hover-only, at roughly sixty-five sites

- **Severity:** MEDIUM
- **Status:** RESOLVED
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
- **Re-verified:** hardening pass — **SURVIVES**, with the count made exact: **100** `title=` attributes across `components/projects/`, `app/(protected)/projects/` and `app/(protected)/companies/` — more than the ~65 claimed. Includes decision-critical text such as the checklist status dot (`QualityTab.tsx:496`) and the AI-assessment explanation (`:375`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — title tooltips never fire on keyboard focus and are unreachable on touch, and the QualityTab status dot is the worst case: color-only plus a title on a non-interactive span, so its meaning is available to no one but a hovering mouse user. Count of ~65 decision-critical sites is consistent with the 86 raw `title=` occurrences in that directory.

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

**Resolution (2026-10-01, projects Round G).** Every decision-critical site the finding ranks now explains itself in text or in a disclosure, never in a `title` alone: the checklist status meaning is the visible legend (A11Y-2); the two AI buttons' explanations (and the sweep's) are `HelpTooltip` disclosures beside the buttons; Commitment / Actual / Adjustment's meaning is visible text under the entry-type toggle; the earned-value formula is visible text in the budget line's detail; reason codes "score both sides" is a visible line on the change-order form; the bid table's value-score formula, the silent-hours penalty and "exclusions never lower a score; check prompts are for you to verify" are visible text under the table (J4) and defined in the glossary (UX-15); "needs a budget line" offers its fix in place (UX-13); machine-found vs human-attached evidence chips say "Sweep" / "Attached"; the destructive punch Void is named ("Void … — not a real snag (a reason is required)") and its meaning is in the punch legend; task weight is visible text on the add form; the company status select has a visible, `aria-describedby` explanation of "do not use" / "inactive". `HelpTooltip` itself is now a real disclosure (named trigger via `label`, `aria-expanded` / `aria-controls`, visible focus, Escape closes it without closing an enclosing dialog). The cost glossary opens on a viewer's first visit (remembered per browser; storage blocked → it opens). Tests: `a11yProjects.test.ts` "A11Y-12 —" (the disclosure's semantics and Escape; existing callers keep their name; the cited sites explain in text or a disclosure; the glossary opens on the first visit only).

**Done-when.**
- ✓ No decision-critical explanation is reachable only by hover — every site the finding ranks.
- ✓ The checklist card has a visible status legend.

**Scope / residual.** About a hundred `title=` attributes remain across the area; those left restate visible text or name an icon button. A census of every one of them was not done.

---

## A11Y-13 · Contrast failures and missing dark variants

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J14 PROJECTS FOLLOW-UPS (`ProjectCoach.tsx:101`'s dark variant, then the ratchet's `RECORDED_RESIDUAL` empties; the light tint slabs the record lists, re-counted at HEAD) — by the integrator, 2026-10-02 (at the J10b merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (computed)
- **Blast radius:** accessibility
- **Re-verified:** hardening pass — **SURVIVES**. `text-red-600` on a cancelled banner (`projects/[id]/page.tsx:307`) and `bg-red-50 border-red-200 text-red-700` on the error card (`projects/page.tsx:161`), neither with a `dark:` variant.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed as a dark-mode failure rather than a light-mode one: #dc2626 (red-600) on #111827 is ~3.3:1, well under the 4.5:1 AA floor for the text-xs error strings, and the hardcoded red-50/emerald-50 chips keep light backgrounds inside a dark shell. MEDIUM is the right level — the light-mode pairings (red-700 on red-50, red-600 on white) do pass.

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

**Partial (2026-10-01, projects Round G).** Every cited pair is fixed, and the date inputs area-wide: amber text on light is the 800 step with its 300 dark variant (the awaiting-review count, the ExampleFrame badge, the change-order and checklist chips — `amber-700` on `amber-500/15` was 4.47 : 1); every cited `rose-700` / `red-600` form or action error carries its dark variant; the five light error panels (`projects/page.tsx`, the project page's load error, `companies/[id]/page.tsx`, the Schedule tab's two) are the token recipe (rose text on `rose-500/[0.08]`, half-alpha border); the project page's `ActionButton` red / emerald variants, status badge and chips, the "Currently checked out" heading and the checkout row hover use the token recipe; the Schedule tab's Set-baseline and Done chips likewise; the `slate-300` icons use the faint token; the portal's chips and messages have dark variants; every date / time input on the Projects surfaces follows the theme (the cited Schedule one, the rebase dialog's date and time, and the task detail panel's start / finish). Tests: `a11yProjects.test.ts` "A11Y-13 —" (each pair's contrast computed by the WCAG formula over the composited background in both themes, Tailwind v3 sRGB steps; the error panels; the action buttons and chips; a census of every date / time input).

**Done-when.**
- ✗ Every text / background pair in the Projects area clears 4.5 : 1 in both themes — the cited pairs do; 35 light tint slabs (`bg-{hue}-50|100` with no dark variant) remain in uncited schedule-engine files: `ScheduleImportModal.tsx` (9), `TaskDetailPanel.tsx` (7), `ExecutionReportView.tsx` (5), `StaleCheckoutBanner.tsx` (3), `MovePreviewSheet.tsx`, `RebaseScheduleModal.tsx`, `ScheduleFilterBar.tsx`, `ExecutionView.tsx` (2 each), `ExecutionGuide.tsx`, `SchedulePulse.tsx`, `ScheduleProgress.tsx` (1 each). This record stays OPEN for them.
- ✓ No error panel renders light-on-dark (every error panel in the area — the execution board's two dialog errors included — is the token recipe).
- ✓ All date inputs match the theme.

**Scope / residual.** The 35 slabs above (the schedule engine's own surfaces); the next pass converts them with the same recipe and extends the census. The uncited `-600` text pairs with no `dark:` variant are listed in the final-review note below.


*Review fix (2026-10-01, projects Round G).* Two dimmed rows on the checklist surface were missed: an N/A checklist row (`opacity-50`) and a closed punch row (`opacity-55`) took their text — the muted rationale line most of all — under 4.5 : 1 in both themes. They are now set back by their status mark, the muted text token and (punch) a strike with the done / voided label, never whole-row opacity (`components/projects/QualityTab.tsx`); `a11yProjects.test.ts` computes the old composite (< 4.5) and the muted token at full strength (≥ 4.5 in light and dark) and pins both rows. The finding stays OPEN for the 35 uncited schedule-engine slabs above.

*Third review fix (2026-10-01, projects Round G).* Six of the 35 slabs above went with A11Y-6's announced sites, to the token recipe: the task panel's save error (`TaskDetailPanel.tsx`, 1), the rebase result (`RebaseScheduleModal.tsx`, rose / emerald, 2), the import result (`ScheduleImportModal.tsx`, rose / emerald, 2) and the stale-checkout release error (`StaleCheckoutBanner.tsx`, 1) — 29 remain in the files listed, and the finding stays OPEN for them.

*Integrator fix pass (final review minors, 2026-10-01).* The task panel's announced delete error (`TaskDetailPanel.tsx:445`) now wears the area's token recipe, `text-rose-700 dark:text-rose-300` (it was `text-rose-600`, under 4.5 : 1 on the dark footer). The residual above understated what remains: besides the 29 light tint slabs, the area holds uncited `text-{rose,red,amber,emerald}-600` pairs whose class string carries no `dark:` text variant — 61 sites in 21 files (`components/projects`, `app/(protected)/projects`, `app/(protected)/companies`, `app/submit`; none is `red-600`). None is changed here, and the finding stays OPEN for them:
- **Text** (23 — 4.5 : 1, or 3 : 1 for the 2xl / 3xl figures): `TaskDetailPanel.tsx:442` (the "Delete task" label, with a `hover:bg-rose-50` slab), `:619` (the edit form's field note, rose error / amber advice); `ExecutionReportView.tsx:93, 104, 211, 216, 284, 285, 286` (10 — % complete, ahead / behind, finish drift, slipped / pulled in, blocked / hold / late); `ExecutionView.tsx:1146, 1162`; `ScheduleProgress.tsx:93` (the SPI figure, 3); `ScheduleCalendarTileView.tsx:380` (today's date); `TransitionInPanel.tsx:201, 202, 263`; `CostsTab.tsx:347` (a line's negative remaining).
- **Icons** (22 — non-text, SC 1.4.11's 3 : 1): `CostsTab.tsx:397, 398` (stat-card icon chips); `EditProjectModal.tsx:287`; `ExecutionReportView.tsx:158, 247, 346` (346: the health icons, 3); `ExecutionView.tsx:861`; `IntakePanel.tsx:525`; `ProjectCoach.tsx:101`; `ProjectWizard.tsx:337, 456`; `ScheduleImportModal.tsx:824, 825`; `ScheduleProgress.tsx:97` (2); `StaleCheckoutBanner.tsx:127` (the dismiss X, with a `hover:bg-amber-100` slab), `:137`; `TabErrorBoundary.tsx:51`; `app/(protected)/companies/error.tsx:17` (its tile has a dark background variant, its icon colour none); `app/submit/[token]/page.tsx:295`.
- **Hover-only** (16 — `hover:text-rose-600` on a faint or muted control, no dark hover variant): `CostsTab.tsx:180, 618`; `EditProjectModal.tsx:266, 289`; `IntakePanel.tsx:598`; `ProjectDocumentsCard.tsx:236`; `ProjectWizard.tsx:430, 458, 500, 525, 549`; `QualityTab.tsx:387, 441`; `cost/ChangeOrdersPanel.tsx:252`; `cost/QuotesPanel.tsx:1215`; `app/(protected)/companies/[id]/page.tsx:325`.

Tests: `a11y13FinalReview.test.ts` (4: the delete error rendered from a refused delete, in the recipe, with the old pair under 4.5 : 1 on the dark footer and the new one over it in both themes; a ratchet census over this list — per file, no more such sites than listed — mutation-checked).

**Partial (2026-10-01, projects Round G).** Package J10b UI REMAINDERS cleared the final review's ratchet down to its one site outside this package. Each change is on its own element; no global stylesheet rule was added.
- **Text.** Rose and emerald text uses the 700 step with a 300 dark twin, and amber uses 800 / 300.
  - `TaskDetailPanel.tsx`: the "Delete task" label, whose hover slab is now `hover:bg-rose-500/10` with `dark:hover:text-rose-200`, and the field note.
  - `ExecutionReportView.tsx`: the ten figures.
  - `ExecutionView.tsx`.
  - `ScheduleProgress.tsx`: the SPI figure.
  - `ScheduleCalendarTileView.tsx`: today's date.
  - `TransitionInPanel.tsx`.
  - `CostsTab.tsx`: a line's negative remaining.
- **Icons** (SC 1.4.11). The 600 step stays on light, and `dark:text-{hue}-400` is added.
  - `CostsTab.tsx`: the stat-card chips.
  - `EditProjectModal.tsx`, `ExecutionReportView.tsx`, `ExecutionView.tsx`, `IntakePanel.tsx`, `ProjectWizard.tsx`, `ScheduleImportModal.tsx`, `ScheduleProgress.tsx`, `TabErrorBoundary.tsx`, `app/(protected)/companies/error.tsx` and `app/submit/[token]/page.tsx`.
  - `StaleCheckoutBanner.tsx`: the dismiss X also gets `dark:hover:text-amber-200 dark:hover:bg-amber-500/15`.
- **Hover-only.** `dark:hover:text-rose-300` sits beside every `hover:text-rose-600` in `CostsTab.tsx`, `EditProjectModal.tsx`, `IntakePanel.tsx`, `ProjectDocumentsCard.tsx`, `ProjectWizard.tsx`, `QualityTab.tsx`, `cost/ChangeOrdersPanel.tsx`, `cost/QuotesPanel.tsx` and `app/(protected)/companies/[id]/page.tsx`.
- Tests: `lib/__tests__/a11y13FinalReview.test.ts`.
  - The ratchet's recorded residual is now `{ "components/projects/ProjectCoach.tsx": 1 }`: 60 of the 61 sites are gone. The census is still mutation-checked.
  - A new "A11Y-13 (J10b) —" block computes each recipe on the area's light and dark surfaces by the WCAG formula, over Tailwind v3 sRGB steps. Text must reach 4.5 : 1 (3 : 1 for the large figures), icons 3 : 1, and the hover twins their floor.
  - The block also pins that no global stylesheet rule was added for these hues.

**Done-when.**
- ✗ Every text / background pair in the Projects area clears 4.5 : 1 in both themes.
  - Of the 61 uncited `-600` pairs, one is left: `components/projects/ProjectCoach.tsx:101`, an icon in projects-joint J12's file this round.
  - The light tint slabs listed above remain: the schedule engine's `bg-{hue}-50|100` with no dark variant, 29 at the last count. They were not in this package's brief. This package changed only two hover slabs, on elements it was already editing: the "Delete task" label's (now `hover:bg-rose-500/10`) and the stale-checkout dismiss's (it gained a dark twin).
- ✓ No error panel renders light-on-dark (unchanged).
- ✓ All date inputs match the theme (unchanged).

**Scope / residual.** OPEN for two things:
- `ProjectCoach.tsx:101`: J12 can add `dark:text-{hue}-400` beside the 600 icon. When that lands, the ratchet's `RECORDED_RESIDUAL` drops to `{}`.
- The light tint slabs.

**Resolution (2026-10-07, projects Round G).** Package projects-joint J14 PROJECTS FOLLOW-UPS closed both residual items. Each change is on its own element; no global stylesheet rule was added.
- `ProjectCoach.tsx`: the not-migrated icon keeps its 600 step on light and wears `dark:text-amber-400` (3 : 1 for an icon). The final review's ratchet `RECORDED_RESIDUAL` is now `{}`.
- The light tint slabs, re-counted at J14's base: 47 `bg-{hue}-50|100` slabs with no dark background variant, plus 6 translucent `bg-{hue}-50/NN`, all in the schedule engine's surfaces, the status chips and the calendar tiles. Every one now uses the token recipe: a `{hue}-500` tint at 8 % (`bg-{hue}-500/[0.08]`, the 50 slab) or 15 % (`bg-{hue}-500/15`, the 100 chip), and a half-alpha border (`-500/40|50`). The slab reads as a tint on both themes, so it needs no separate dark background.
- The coloured text on those slabs: 76 sites of `text-{hue}-700|800|900` had no dark twin. Each gains one: 700 / 800 with `dark:text-{hue}-300`, 900 with `dark:text-{hue}-200`. The faded slab text (`700/80`, `800/70`, `900/90`) is a full step.
- Files:
  - `ExecutionView.tsx`, `ExecutionGuide.tsx`, `ExecutionReportView.tsx`, `TaskDetailPanel.tsx`, `MovePreviewSheet.tsx` and `RebaseScheduleModal.tsx`.
  - `ScheduleImportModal.tsx`, `SchedulePulse.tsx`, `ScheduleFilterBar.tsx`, `ScheduleProgress.tsx` and `ScheduleCalendarTileView.tsx`.
  - `StatusControl.tsx`, `ProgressControl.tsx` and `StaleCheckoutBanner.tsx`.
- Tests: `lib/__tests__/a11y13FinalReview.test.ts`.
  - The ratchet's residual is `{}` and its census is still mutation-checked.
  - "A11Y-13 (J14) —" adds two censuses over the whole Projects area, each pinned at zero: no `bg-{hue}-50|100` without a dark background variant, translucent ones included; no `text-{hue}-700|800|900` without its dark twin.
  - Both censuses are mutation-checked: a bare slab, a translucent slab, a darkless text and a darkless hover each fail, and the recipe passes.
  - The recipe's contrast is computed per hue in both themes by the WCAG formula, over Tailwind v3's sRGB steps and the area's light and dark surfaces. Text must reach 4.5 : 1: 700 on the 8 % slab, 800 and 900 on the 15 % chip, and the dark twins on both. The test found amber-700 on the 15 % chip at 4.47 : 1, so that pair is not used; amber text on a chip is 800.

**Done-when.**
1. ✓ Every text / background pair in the Projects area clears 4.5 : 1 in both themes, for every pair the record names and every pair the two censuses can see (the coloured-text and tint-slab shapes). Computed from the recipe; no browser audit tool was run over rendered pages.
2. ✓ No error panel renders light-on-dark (unchanged).
3. ✓ All date inputs match the theme (unchanged).

**Scope / residual.** None for this finding. A new light slab or darkless text anywhere in the area fails the censuses.
- Ship loop (`DEC-29` item 4), J14 fix pass: `tsc --noEmit` exits 0, and `eslint` on the 47 changed `.ts` / `.tsx` files exits 0. Every assertion of the full `vitest` run passes. On this host (load average about 20) the run's exit code was 1 twice, each time only from 5 s default timeouts, in files this package does not touch: `dcRoundFOwnerStamp`, `notificationWriteRails`, `notificationDispatchMembership` and `dependencies`. Those four pass when run on their own with `--testTimeout=60000` (exit 0). The full `next build` was not run here: the fleet's standing rule leaves it to the integrator at merge, so this resolution stands on that build passing.

---

## A11Y-14 · Decision controls outside the Quality tab are still under 24 px

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J10b UI REMAINDERS (the decision controls under 24 px outside the Quality tab: intake panel, quotes panel, change-order panel, Costs tab) — by the integrator, 2026-10-01 (at the J10 merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CARRIED — the sites `A11Y-8` measured; not re-measured
- **Blast radius:** accessibility / mobile
- **Locations** (as `A11Y-8` listed them; line numbers have moved):
  - `components/projects/IntakePanel.tsx:373` — **~12 px**
  - `components/projects/cost/QuotesPanel.tsx:160, 249` — **~13 px**, bare text buttons
  - `components/projects/cost/QuotesPanel.tsx:397, 420, 441`, `components/projects/cost/ChangeOrdersPanel.tsx:180, 184`, `components/projects/CostsTab.tsx:393` — **~19 px**
- **Independently verified:** — (opened by projects Round G package J10 on 2026-10-01, split from `A11Y-8` under `DEC-31`: `A11Y-8`'s done-when covered the Quality tab, which now carries the floor)

**Mechanism.** WCAG 2.2 SC 2.5.8 asks for 24×24 px; a gloved hand needs 44. The intake approvals, the bid table's actions and the change-order decisions are the same kind of control as the Quality tab's — they move a document into the register or money onto a budget line — and keep the sub-24 px boxes `A11Y-8` measured.

**Failure scenario.** A mis-tap on a tablet approves the wrong intake sheet or decides the wrong change order.

**Remediation.** Lift the Quality tab's `DECISION_TARGET` (`min-h-6 min-w-6`, `pointer-coarse:min-h-11 pointer-coarse:min-w-11`) into a shared constant and apply it to every decision control in the listed files, in clusters spaced 8 px.

**Done when.**
- No decision control in the Projects area is under 24 px, or under 44 px on a coarse pointer.
- A census test pins it, as `a11yProjects.test.ts` "A11Y-8 —" does for the Quality tab.

**Resolution (2026-10-01, projects Round G).** Package J10b UI REMAINDERS lifted the Quality tab's floor into one shared constant: `components/projects/decisionTarget.ts` `DECISION_TARGET` (`min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3`). `QualityTab.tsx` imports it, and its local copy is removed. The constant is set on the control itself, never through a bare element rule, on every button whose click starts a write in these files:
- `components/projects/IntakePanel.tsx`: approve, reject, copy link, reissue, revoke, assign documents, unassign, assign pick and create link.
- `components/projects/cost/QuotesPanel.tsx`: type or correct a total, Award, Decline (in the bid table and, since the `MON-10` fix pass, in the "not read yet" strip), post invoice, void, create, submit, RFQ, quote-link copy, reissue and revoke.
- `components/projects/cost/ChangeOrdersPanel.tsx`: approve, reject, reverse and propose.
- `components/projects/CostsTab.tsx`: ledger repair, CO repair, void entry, post, create, link and add.
- The new closeout Retry (`components/projects/CloseoutGatesPending.tsx`, `QUAL-8`).

Clusters of decisions are spaced 8 px (`gap-2` / `ml-2`), up from 4-6 px.
- Tests: `lib/__tests__/j10bDecisionTargets.test.ts` (8).
  - One shared constant: the Quality tab and the four surfaces import it, none keeps a local copy, and `app/globals.css` has no bare `button` rule.
  - Per file, an inverted census. Every `<button>` in the file must carry `${DECISION_TARGET}` unless its whole `onClick` is on an explicit, anchored list of read-only handlers: the disclosure toggles (`setShowLinks`, `setOpen`, `setShowForm`, `setShowNewAccount`, `setShowParties`, `setOpenAccount`), the entry type picker (`setType`), the banner dismiss (`setErr(null)`), the read retry (`refresh`), a form's `onCancel`, the company and party pickers' open and cancel (`setEditing`, `setLinking`), and the bid row's PDF opener. A button with no `onClick` counts as a decision. The deciders are counted against a floor, and named controls must be among them. A new write button under any handler name, added without the floor, therefore fails. So does a write appended to a read-only handler. *Review fix:* the first pass matched writers against a list of known handler names, so a writer named anything else (`archive`, say) went uncounted. The record's earlier sentence, "names writers by their handler, so a new writer added without the floor fails", overstated that census.
  - The read-only list carries no dead entry: each entry matches a button in the four files.
  - A synthetic `archive` button with no floor is caught, a write appended to a read-only toggle leaves the list, and a submit button with no `onClick` is a decision.
  - The clusters' spacing.

  `lib/__tests__/a11yProjects.test.ts`' DECISION_TARGET pin now reads the shared module.

**Review fix (2026-10-02, projects Round G).** The final review found two more Projects files whose buttons start a write with no floor, so the first done-when's tick was not true as written. Both now carry `${DECISION_TARGET}`, with every handler, label and disabled state unchanged:
- `components/projects/ProjectDocumentsCard.tsx` (the Documents tab): Attach document, which opens the attach search (`:151`); each attach pick (`:185`); and detach, "Remove from the register" (`:232`). The detach was 22 px, `p-1` around a 14 px icon. It is now also `inline-flex items-center justify-center`, so the icon stays centred in the larger box. The detach sits beside the row's Open link with `gap-3` (12 px), which is unchanged.
- `components/projects/TransitionInPanel.tsx` (inside the Intake tab's `IntakePanel`): Adopt N clean (`:229`), Adopt (`:325`) and Flag to drafting (`:336`). Adopt and Flag to drafting share a `gap-2` cluster. Adopt N clean sits in the `gap-2` destination row.
- Tests: `lib/__tests__/j10bDecisionTargets.test.ts` (now 10). Both files are added to the census. The read-only list gains one entry, the transition-in sheet's disclosure (`setOpen(expanded ? null : c.docId)`); the Re-scan was already covered by the read-retry entry. The spacing test pins both `gap-2` containers. Negative controls: before the component change, the census failed for both files (3 bare buttons each, and no shared import); with the change in place, removing the floor from the detach alone fails the `ProjectDocumentsCard.tsx` census.

**Done-when.**
- ✓ No decision control in the Projects area is under 24 px, or under 44 px on a coarse pointer. This covers the four surfaces this finding names here, `ProjectDocumentsCard.tsx` and `TransitionInPanel.tsx` (review fix, 2026-10-02), and the Quality tab (`A11Y-8`).
- ✓ A census test pins it, as `a11yProjects.test.ts` "A11Y-8 —" does for the Quality tab.

**Scope / residual.** A "decision control" is read as a button that starts a write, as the finding's mechanism describes. Read-only toggles and navigation links keep their sizes. The finding's Locations and Assigned line name these four surfaces outside the Quality tab, and all four are done. The census also covers `ProjectDocumentsCard.tsx` and `TransitionInPanel.tsx` (review fix). Other Projects files are outside this finding's Locations and were not brought under the floor here. Their write buttons still carry no `DECISION_TARGET`: for example the Members tab's save responsibility, make owner and remove (`app/(protected)/projects/[id]/page.tsx:1172`, `:1187`, `:1193`), `StatusControl.tsx:186`, `ProgressControl.tsx:72`, `StaleCheckoutBanner.tsx:153` and `EditProjectModal.tsx:319`. The tick above holds for the surfaces it names, not for these. They are opened as `A11Y-15` (DEC-31; integrator, at the J10b merge).

---

## A11Y-15 · Write buttons outside A11Y-14's surfaces still carry no decision floor

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** projects-joint J14 PROJECTS FOLLOW-UPS (bring the listed write buttons under the shared `DECISION_TARGET` and add them to the census) — by the integrator, 2026-10-02 (at the J10b merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** READ — each site was read at the J10b merge; sizes are from the class strings, not measured
- **Blast radius:** accessibility / mobile
- **Locations:**
  - `app/(protected)/projects/[id]/page.tsx:1172` (Members tab, save responsibility; `px-1.5`, 11 px text, no vertical padding), `:1187` (make owner; `px-1.5 py-1`) and `:1193` (remove member)
  - `components/projects/StatusControl.tsx:186` (confirm a status change with a reason)
  - `components/projects/ProgressControl.tsx:72` (the quick-percent buttons)
  - `components/projects/StaleCheckoutBanner.tsx:153` (release a stale checkout)
  - `components/projects/EditProjectModal.tsx:319` (Save changes; `py-1.5` around 12 px text)
- **Independently verified:** — (opened by the integrator on 2026-10-02 at the J10b merge, split from `A11Y-14` under `DEC-31`: `A11Y-14`'s Locations named four surfaces, and its Scope / residual names these sites as outside its tick)

**Mechanism.** `A11Y-14` lifted the Quality tab's 24 px / 44 px floor into `components/projects/decisionTarget.ts` and applied it to every write button in the files it named, plus `ProjectDocumentsCard.tsx` and `TransitionInPanel.tsx`. Write buttons elsewhere in the Projects area were outside its Locations and keep their small boxes. They change a member's role or ownership, a project's status or progress, a checkout, or the project's identity. These are the same kind of control.

**Failure scenario.** On a tablet, a mis-tap on the Members tab hits "make owner" instead of the row's other action, or a quick-percent button records the wrong progress.

**Remediation.** Apply `${DECISION_TARGET}` to each listed button, with every handler, label and disabled state unchanged. Space clusters 8 px. Add the files to the inverted census in `lib/__tests__/j10bDecisionTargets.test.ts`, and extend its read-only list only for genuinely read-only handlers (Back, Cancel, Close).

**Done when.**
- Every button that starts a write in the listed files carries `DECISION_TARGET`.
- The census in `j10bDecisionTargets.test.ts` (or a successor) covers these files, so a new write button there without the floor fails.

**Resolution (2026-10-07, projects Round G).** Package projects-joint J14 PROJECTS FOLLOW-UPS brought every listed write button under the shared floor (`${DECISION_TARGET}`: 24 px, and 44 px on a coarse pointer). Every handler, label and disabled state is unchanged.
- `app/(protected)/projects/[id]/page.tsx`, the Members tab: Add member, Save (a responsibility), Make owner and Remove. The row's action cluster and the responsibility editor are spaced 8 px (`gap-2`). Only the `MembersTab` function is edited, because the page is identity-and-session IS-P1's this wave (its `activeRole` site).
- `StatusControl.tsx`: each item of the status menu and the reason confirm. The reason cluster is `gap-2`.
- `ProgressControl.tsx`: the quick-percent buttons. Their row is `flex-wrap gap-2`, so the 224 px popover holds four 44 px targets a row and the fifth wraps.
- `StaleCheckoutBanner.tsx`: Release. `EditProjectModal.tsx`: Save changes.
- Tests: `lib/__tests__/j10bDecisionTargets.test.ts` "A11Y-15 (J14) —".
  - It is an inverted census over the four component files whole and the page's `MembersTab`. Every `<button>` must carry the floor unless its whole click is on the read-only list (`READ_ONLY_15`): a menu opener, a Back, a dismiss, a close, the edit form's own field controls, and opening a responsibility's editor.
  - Each file must hold at least its listed write buttons, found by handler. Each read-only entry must be used (no dead exemption), and a write added to a read-only handler takes it off the list.
  - It also pins the 8 px clusters and the unchanged handlers and disabled states.

**Done-when.**
1. ✓ Every button that starts a write in the listed files carries `DECISION_TARGET`: the four component files whole, and every site the Locations name in the project page. The page's other write buttons were outside this finding's Locations. They are split, as `A11Y-14` split this one, to `A11Y-16` (opened below, `DEC-31`). Its owner is only proposed (projects-joint J15 CHECKED-WRITE SWEEP); the integrator confirms or re-assigns it at the J14 merge.
2. ✓ The census covers these files, so a new write button there without the floor fails.

**Scope / residual.** The project page outside its Members tab: `A11Y-16` (owner proposed, awaiting the integrator's confirmation).
- Ship loop (`DEC-29` item 4), J14 fix pass: `tsc --noEmit` exits 0, and `eslint` on the 47 changed `.ts` / `.tsx` files exits 0. Every assertion of the full `vitest` run passes. On this host (load average about 20) the run's exit code was 1 twice, each time only from 5 s default timeouts, in files this package does not touch: `dcRoundFOwnerStamp`, `notificationWriteRails`, `notificationDispatchMembership` and `dependencies`. Those four pass when run on their own with `--testTimeout=60000` (exit 0). The full `next build` was not run here: the fleet's standing rule leaves it to the integrator at merge, so this resolution stands on that build passing.

---

## A11Y-16 · The project page's own write buttons, outside its Members tab, still carry no decision floor

*Numbered A11Y-16 on this branch (opened by projects-joint J14 PROJECTS FOLLOW-UPS as `A11Y-15`'s remainder, per `DEC-31`). If the number collides at merge the integrator renumbers.*

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** projects-joint J15 CHECKED-WRITE SWEEP. It runs last and per file, after identity-and-session IS-P1's edit of `app/(protected)/projects/[id]/page.tsx` has merged, and its pass over that page's write handlers is where these class strings ride. Proposed by projects-joint J14 PROJECTS FOLLOW-UPS, 2026-10-07, in its review's fix pass (DEC-31). The integrator confirms or re-assigns at the J14 merge.
- **Assigned:** projects-joint J15 CHECKED-WRITE SWEEP (its per-file pass over the project page) — by the integrator, 2026-10-07 (J14 merge; fleet plan `projects-joint.json`).
- **Verification:** READ (each site read at J14's HEAD; sizes from the class strings, not measured)
- **Blast radius:** accessibility / mobile
- **Locations:** (all in `app/(protected)/projects/[id]/page.tsx`)
  - `ActionButton` (the component at `:883`, `px-3 py-1.5` around 12 px text, about 28 px tall). It is used for the lifecycle changes (Pause, Complete, Cancel, Resume, Archive, Reopen, Delete) and for the header's Export CSV, Edit, Evidence pack, Report and Lessons learned. Pause, Complete, Cancel, Resume and Archive open the transition confirm. Reopen opens a prompt for its reason (`handleReopen`, `:285`, confirm label "Reopen"). Delete always confirms (`handleDelete`, `:306`): a project with cost or quality records gets a confirm and then a typed reason from an Admin, and a refusal for anyone else; a project without them gets a "Delete" confirm. *Corrected (J14 last review, 2026-10-07, `DEC-29`):* this line first said that Delete and Reopen act directly. Neither does.
  - The lessons-learned editor's "Save to project" (`:762`), beside its Cancel (`:760`).
  - The status transition's confirm (`:855`), beside its Cancel (`:854`, read-only).
  - The Activity tab's comment Post (`:1023`).
- **Related:** `A11Y-15` (whose Done-when 1 split these off), `A11Y-14`, `components/projects/decisionTarget.ts`
- **Independently verified:** — (`author`: opened by projects-joint J14 from `A11Y-15`'s census, per `DEC-31`; not yet challenged)

**Mechanism.** `A11Y-15`'s Locations named only the Members tab's sites in the project page. Its census therefore reads the page's `MembersTab` function, not the page as a whole. The rest of the page's write buttons keep their small boxes.

**Failure scenario.** On a tablet, a mis-tap on the project header hits Complete or Delete instead of a neighbouring action. Every lifecycle action opens a confirm or a prompt, so the mis-tap writes nothing by itself: it opens the wrong dialog, and the user must notice that before confirming it. The lessons editor's "Save to project" (`:762`) writes at once and sits next to its Cancel. That Cancel asks before discarding edited text, so a mis-tap meant for Cancel saves the draft instead. *Corrected (J14 last review, 2026-10-07, `DEC-29`):* this paragraph first said that Delete and Reopen act directly, and that Cancel discards the draft.

**Remediation.** Put `${DECISION_TARGET}` in `ActionButton`'s class string (which covers every use) and on the lessons, transition-confirm and comment buttons. Space their clusters 8 px. Extend `A11Y-15`'s inverted census in `lib/__tests__/j10bDecisionTargets.test.ts` from `MembersTab` to the whole page, keeping the read-only list for genuinely read-only handlers (Back, the tab buttons, dismiss, Cancel).

**Done when.**
- Every button that starts a write in `app/(protected)/projects/[id]/page.tsx` carries `DECISION_TARGET`.
- The census reads the whole page, so a new write button there without the floor fails.

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
| A11Y-5 | HIGH | RESOLVED |
| A11Y-6 | HIGH | OPEN |
| A11Y-7 | HIGH | OPEN |
| A11Y-8 | HIGH | OPEN |
| A11Y-9 | HIGH | RESOLVED |
| A11Y-10 | HIGH | OPEN |
| A11Y-11 | MEDIUM | RESOLVED |
| A11Y-12 | MEDIUM | OPEN |
| A11Y-13 | MEDIUM | RESOLVED |
| A11Y-14 | MEDIUM | RESOLVED |
| A11Y-15 | LOW | RESOLVED |
| A11Y-16 | LOW | OPEN |
