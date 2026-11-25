# Design rules

The rules every screen of Manufacturing OS follows. They come from the 31 design reels the owner sent, read frame by frame (on-screen text, captions and speech), plus the standards those reels lean on (Apple and WCAG). Per-reel notes, with what each reel shows, are in `docs/design-rules/` (reel-notes-A to D).

## How to read this

- **RULE**: must hold on every screen, not only on the kind of screen the reel filmed. A login reel's field rule is a rule for every field in the app. Breaking a rule is a bug. Each rule has a **Check**: how to prove it holds.
- **IDEA**: a good pattern to use where it fits. Optional.
- **Not for us**: rejected, with the reason.
- **Settled**: where reels disagree, the decision is written once and applies everywhere.
- Reel IDs (like `Deq_kvJBI3g`) are Instagram post codes: instagram.com/reel/ID.

Our tokens live in `app/globals.css`. Type: 12 / 14 / 16 / 20 / 26 / 42 px (caption, body, reading, section, title, hero). Radius: 6 / 8 / 12 px (chip, control, panel). Controls: 40 px tall, 44 on touch screens.

---

## 1. Fields

**F1. Every field is 16 px on phones and touch screens.** Inputs, selects, text areas and rich-text boxes, on pages and in dialogs, upright and sideways. Why: iPhone Safari zooms the whole page when you tap a field under 16 px. Check: crawl every page on a phone, upright and sideways; every visible field computes 16 px or more. (Deq_kvJBI3g, Df4WVGIBO2k, DW87CGQDKbY)

**F2. A visible label above every field, lined up with its left edge.** It stays while typing and never floats or moves. The placeholder is only an example, never the name. A search box with only an icon still needs a name for screen readers (aria-label). Check: no field without a label or aria-label; no label centered over a left-aligned field. (DdxddtWBsl_, C5Ih77VOcm2, Df4WVGIBO2k, DauPSfKIycn, DeefFnvTwrm)

**F3. Rules, formats and units stay visible under the field** ("At least 8 characters", "Tag like P-2001", "psig"), not only in the placeholder, which disappears at the first key. Check: no format or unit that exists only as placeholder text. (DdxddtWBsl_)

**F4. The field edge is 3:1 against its background, in both themes.** No underline-only or fill-only fields. Check: measure `--color-border-control` against surface and page. (C5Ih77VOcm2, Df4WVGIBO2k, DfFL1glpnYi)

**F5. Focus is a 2 px accent ring with a 2 px gap, on every focusable control.** Focus never changes the border width or moves anything. Check: tab through a page; every stop shows the ring. (DdxddtWBsl_, Deh4XHEqzX_, Df4WVGIBO2k, Ddg450QpmE2)

**F6. Every field state is designed:** rest, hover, focus, filled, error, disabled or read-only; composers also multi-line, uploading and working. Filled goes back to neutral: no green check on every valid field. (Deh4XHEqzX_, Ddg450QpmE2, DeefFnvTwrm)

**F7. Every field sets the right type, inputmode, autocomplete and enterkeyhint** (email, tel, numeric, one-time-code, current-password, new-password, search, send). Paste is never blocked; password managers always work. (Deq_kvJBI3g, Df4WVGIBO2k, DeefFnvTwrm, DfaHwqVu06h)

**F8. Every password or secret field has a Show button.** With Show there is no "Confirm password" field. "Forgot password?" sits on the password row. Check: every `type="password"` uses `PasswordInput`. (Ddg450QpmE2, DeefFnvTwrm, DfFL1glpnYi, DdxddtWBsl_)

**F9. Mark "(optional)" on the few optional fields;** don't star every required one. (DauPSfKIycn)

**F10. Multi-line boxes grow with the text up to a limit;** the toolbar and send button stay put. (Deh4XHEqzX_)

**F11. Attachments upload inside the box** with name, size and progress per file; no extra dialog. (Deh4XHEqzX_)

**F12. Fill in what we already know.** The lookup field comes first, suggestions show under it, a pick fills the rest (still editable). Reuse earlier answers. (Del7XTgsuwI, De1Swx4hE8W)

**F13. Code entry:** one box per digit, focus on the first, moves on by itself, paste fills all, Backspace steps back, `one-time-code`. `app/share` CodeBoxes is the model. (DeefFnvTwrm)

**F14. Consent, acknowledgement and sign-off boxes are never ticked in advance.** The confirm button stays off until the person ticks. "Keep me signed in" is a clear choice on a full-size row and starts off on shared PCs. Check: no `defaultChecked` or `useState(true)` on an acknowledgement. (C5Ih77VOcm2, DdxddtWBsl_, Ddg450QpmE2)

## 2. Errors and checking input

**V1. When to show an error.** First when the person leaves the field or presses the button, never while they are still typing the first time. After that, check on every key and clear the error the moment it is right. Settled: one reel checks while typing, another on leaving the field; this rule is both, in order. (Df4WVGIBO2k, Ddg450QpmE2, DgDnREtkizp)

**V2. The submit button stays pressable.** Pressing it with gaps marks every missing field at once and moves focus to the first. A button may be off only when what is missing is obvious (code boxes), and then it says why in words. (Ddg450QpmE2, DeefFnvTwrm, DgDnREtkizp)

**V3. The message says how to fix it and matches the real problem.** "Enter a tag like P-2001", not "Invalid format". Empty, wrong format and duplicate get different words. (Df4WVGIBO2k, Ddg450QpmE2, DgDnREtkizp)

**V4. Error = red edge + icon + message under the field,** tied to the field (aria-describedby). Never color alone. `FieldError` in `components/ui/Field.tsx`. (Ddg450QpmE2, Df4WVGIBO2k, Dd8tUtdhVYZ)

**V5. Errors keep everything the person typed.** (DdxNRopKTZo)

**V6. Errors appearing or clearing never shove the page;** the line is reserved or eases open, and the submit button stays under the thumb. (Ddg450QpmE2)

**V7. A green check only after a value is really checked or saved.** (DgDnREtkizp)

## 3. Buttons and actions

**A1. One solid accent button per screen and per dialog.** Everything else is outline, plain or a link. Several "create" actions share it as "New ▾". (DdxddtWBsl_, DdxNRopKTZo, DfMkz9JB-xC, Dd-o8qwRHYh, Df9fWE8hcgI)

**A2. Destructive actions never look like the main action.** Delete, Reset and Cancel are neutral; deleting asks first and names the thing. (DdxNRopKTZo, Df9fWE8hcgI)

**A3. Actions on an item live in one ⋯ menu,** not a row of icons on every row or card. (DfMkz9JB-xC)

**A4. Every icon has a word.** Bottom tabs and menu items show the word. A toolbar icon on desktop has a tooltip and an aria-label; tooltips alone don't work on touch. (DfreUkyBNQg, DfMkz9JB-xC)

**A5. The same action is not offered twice on one screen.** (Dd-o8qwRHYh)

**A6. Show the 3 to 5 tools people use daily;** the rest go behind More, one tap away, grouped by job. Every extra equal choice slows the decision (Hick's law). (DfreUkyBNQg)

**A7. Button words are verbs that say what happens:** "Issue Rev C", "Turn on", "Not now". Never OK, Yes or Submit on a decision. (DewJMeuBL_s, Del7XTgsuwI)

## 4. Feedback

**FB1. Every tap answers within 100 ms** with a pressed look (darker, or 0.98 scale). Rows and icon buttons too. (DdxddtWBsl_, Ddg450QpmE2, DfFL1glpnYi)

**FB2. Work and result show inside the button, same spot, same size:** "Saving" with a spinner, then "✓ Saved" for about half a second. Working words end in -ing; done words are past tense (Locking, Locked). (DdxddtWBsl_, DeefFnvTwrm, Ddg450QpmE2)

**FB3. While a request runs:** no second press, fields frozen, conflicting links and buttons off. (DeefFnvTwrm, DdxddtWBsl_)

**FB4. A running job turns its button into Stop or Cancel in the same place.** (Deh4XHEqzX_)

**FB5. Success shows on the thing acted on** (row "Issued ✓", report header "Locked ✓"), not only in a toast. (DeefFnvTwrm, DewJMeuBL_s)

**FB6. A slow action shows progress at the control at once** ("Opening camera", "Reading 3 of 12 sheets"). (DewJMeuBL_s)

**FB7. Quick personal actions update at once;** record actions wait for the server. Star, follow, mark read and tick a step show instantly and undo themselves if saving fails. Approve, sign, issue, check out and transmit wait for the server (audit trail). (DcmoHfNJDWO)

**FB8. A copy says what was copied** ("Copied DWG-2001-A"). (DfMkz9JB-xC)

## 5. Touch and phone

**T1. Tap targets are at least 44 px on touch screens** (`pointer: coarse`); a mouse keeps the compact size. Nothing anywhere is under 24 px. Why: thumbs miss 28 px buttons. Check: crawl on a phone for controls under 44 px. (DdxddtWBsl_, Deq_kvJBI3g, Df4WVGIBO2k)

**T2. Every screen works at 375 px wide;** the page is never wider than the screen. Check: `scrollWidth` equals the window width on every page. (Deq_kvJBI3g)

**T3. Under 640 px, wide tables become cards:** ID and status on top, bold title, 2 or 3 label and value rows; overdue in red with the word. (Deq_kvJBI3g)

**T4. The main action sits where the thumb is.** Fixed bottom bars leave room for the iPhone home bar, and the page leaves room so the last row is never under a bar or floating button. (De1Swx4hE8W, Deq_kvJBI3g)

**T5. A one-field step focuses itself with the right keypad;** the main button stays visible above the keyboard. (DfaHwqVu06h)

**T6. A sideways-scrolling row shows part of the next item,** so it is clear there is more. (Del7XTgsuwI)

**T7. Big numbers never wrap:** no line break, even-width digits, the sign stays with the number. (Deq_kvJBI3g)

**T8. Phone bottom sheets show a grab bar and close by swiping down.** (DcmoHfNJDWO, DfaHwqVu06h)

**T9. Installed on a phone there is no browser bar,** so every screen below the top has its own ← back, nothing blocks the swipe-from-left-edge back, and lists refresh by pulling down. (DcmoHfNJDWO)

## 6. Type

**TY1. One family from the product's world:** Barlow (industrial signage), self-hosted, `font-display: swap`. Never the default system font. (DfPJo9UBJ7D)

**TY2. Font sizes only from the scale, nothing in between:** 12 / 14 / 16 / 20 / 26 / 42. Each kind of information stays on its own step. Settled: the reels show four-size scales; we keep six because dense tables need a caption step and pages need a hero number. Check: no `text-[Npx]` or `text-xs/sm/base/lg` in components. (DfmTDE1B6uX, DfPJo9UBJ7D, DW87CGQDKbY, Df-drL4jt7Z)

**TY3. No text under 12 px.** Check: crawl finds no visible text under 12 px. (C5Ih77VOcm2)

**TY4. Reading text and every field are 16 px on phones.** (DW87CGQDKbY, Df-drL4jt7Z)

**TY5. The title is the largest and heaviest;** the subtitle is quiet; the eye goes title, then content, then action. On a hero, one thing is huge and the rest small; skip the middle sizes. (DdxddtWBsl_, Dd-o8qwRHYh)

**TY6. Monospace only on strings people copy** (IDs, document numbers, tags). Names and messages stay in the text font. (DfMkz9JB-xC)

**TY7. Weight rises with size.** Settled: two reels say two weights; a dense work app needs one more step, so we use 400 text, 500 labels and controls, 600 headings, 700 hero numbers, and no others. (DfPJo9UBJ7D, Df-drL4jt7Z, DdxNRopKTZo)

**TY8. Legal and consent lines in sentence case at a readable size,** never tiny capitals. (DauPSfKIycn, DfaHwqVu06h)

## 7. Color

**C1. One accent, and it means only "you can act here" or "you are here":** the main button, links, the focus ring, the current tab or menu item. Never status, titles, icons or decoration. (Dc-4jNbtyJg, DdxNRopKTZo, Dd-o8qwRHYh, Df9fWE8hcgI, DfIaULMIRC-)

**C2. The accent covers a small area** (about 10% of the screen: 60 base, 30 surface, 10 accent). No third color at equal weight. (Df9fWE8hcgI, DfIaULMIRC-)

**C3. Every text level passes 4.5:1 in both themes,** hints and placeholders included; edges and icons that carry meaning 3:1. Bright accents fail as text on white (2.3 to 2.6:1): use dark text on bright fills. Check: measure every text token against every surface it sits on. (DdxddtWBsl_, C5Ih77VOcm2, DfIaULMIRC-, DdxNRopKTZo)

**C4. Light and dark swap role tokens, including the button and its text;** button text passes 4.5:1 in both. (DfmTDE1B6uX)

**C5. Colors come only from our role tokens** (page, surface, text, muted, faint, accent, on-accent, state-*), never the framework palette or a hex typed into a component. (DdxNRopKTZo, DfmTDE1B6uX)

**C6. No decorative gradients, no colored icon tiles beside numbers or titles, no icons or avatars that carry no information.** Settled: a faint light-to-dark change on the sign-in card is allowed; a hue gradient never. (Dc-4jNbtyJg, DdxNRopKTZo, DdxddtWBsl_)

**C7. Color is never the only signal.** Status has a word or icon; color swatches and color-coded items carry a word. (Dd8tUtdhVYZ, Dd-o8qwRHYh, Ddg450QpmE2)

## 8. Status, counts and badges

**S1. Status is a small colored dot plus one word in text color.** Color never fills a card, row or pill in a long list: 20 items with one error look calm, and the error stands out. (DfMkz9JB-xC, Df9fWE8hcgI, Dc-4jNbtyJg)

**S2. One status vocabulary with fixed colors everywhere:** green done, amber in progress, red act now. (DfMkz9JB-xC) Settled: on a dense timeline, done steps go one quiet gray so late and open work stands out (the owner's "done things recede"); a status word or dot elsewhere keeps green for done.

**S3. A red number means something waits on this person's decision;** a dot means status. Never both on one row. Plain totals are gray text. (Df5UFrADYCN)

**S4. Counts stop at 99+.** The badge sits on the icon's corner and grows to the left; the icon never moves. Where a number doesn't fit, a dot. (Df5UFrADYCN, DgC6ruhT2NZ)

**S5. One badge component and one set of badge rules everywhere.** (Df5UFrADYCN)

**S6. Opening clears the badge;** read rows go quiet with a ✓. (Df5UFrADYCN)

**S7. Counts never flash 0 while refreshing.** (Df5UFrADYCN)

## 9. Numbers, tables and charts

**N1. Every number and chart says its unit, scope and time window** ("Hours · per shift · last 14 days"); every change names what it is compared with ("vs last week"). (Dc-4jNbtyJg, DdxNRopKTZo, Del2E8Ah8bi)

**N2. A change in a percentage is in points** ("41%, +2 pts"); a change in a count is in %. (Dc-4jNbtyJg, Del2E8Ah8bi)

**N3. Plus and minus signs only on changes,** never on totals. (DdxNRopKTZo)

**N4. Changes are colored by meaning (good or bad) or kept neutral,** never green just because they are positive. (Dc-4jNbtyJg)

**N5. Number columns use even-width digits, aligned right.** The sorted column is marked (arrow, aria-sort). (Dc-4jNbtyJg, Del2E8Ah8bi)

**N6. One key number per hero, big; the rest small.** Never a row of identical stat cards. Hero numbers rounded to what the decision needs; exact values in tables. (Dc-4jNbtyJg, DdxNRopKTZo, Dd-o8qwRHYh)

**N7. Bars and areas start at 0;** a line may skip 0 only if the chart says so. A headline change is worked out from the values, never made bigger by the axis. (Del2E8Ah8bi)

**N8. One accent series per chart,** others gray and thinner, labeled at their line ends (no legend box). More than 5 series: a table or small charts side by side. (Del2E8Ah8bi)

**N9. Charts are labeled** (axes, units or values) with no gradient fills. (DdxNRopKTZo, Dc-4jNbtyJg)

**N10. Tables show only the columns that matter.** (DdxNRopKTZo)

**N11. No filler:** no placeholder copy, made-up numbers or "Good morning, Name" template greetings. (Dc-4jNbtyJg, DfPJo9UBJ7D)

**N12. Each item shows what changed last** (what, who, when), not a vanity number. (DfMkz9JB-xC)

## 10. Lists, search and navigation

**L1. A filtered list says "N of M" with a one-tap Clear.** In document control a hidden filter makes a drawing look missing. (Dd8tUtdhVYZ)

**L2. The sort control names the current order in words** ("Newest first"). (Dd8tUtdhVYZ)

**L3. Coming back to a list restores scroll, filters, sort and selection.** (DcmoHfNJDWO)

**L4. Long lists load the next batch before the bottom.** (DcmoHfNJDWO)

**L5. Search, filter and sort are hidden on an empty list.** (De1Swx4hE8W)

**L6. Long names cut off on one line with "…",** the full name on hover; counts stay visible. (DgC6ruhT2NZ)

**L7. Put things where people's other tools put them** (Outlook, Excel, Explorer on desktop; big phone apps on phones). Settings lives in the account menu, never the bottom bar. At most 5 bottom tabs on a phone. (DcmoHfNJDWO)

**L8. X closes a whole flow; ← goes back one screen.** Tapping the current tab or menu item returns to its top. (DcmoHfNJDWO)

**L9. Notifications and shared links open the exact item** (document, revision, page, comment), even after the sign-in step. (DcmoHfNJDWO)

**L10. The collapsed side menu keeps** the current-item marker, badges (as dots) and the account; every icon has a tooltip. Search sits at the top with its shortcut printed. (DgC6ruhT2NZ)

**L11. Trees:** a fixed indent per level, a chevron that turns (the icon doesn't swap), full keyboard (arrows, Home, End, type-ahead), one Tab stop, `role="tree"`. Big branches load in place with skeleton rows. (DejRN2Oh3p0)

**L12. Every drag has a way to do it without dragging** ("Move to…"). While dragging: the source dimmed, a ghost with the name, an insertion line, the result shown after the drop. (DejRN2Oh3p0)

## 11. Loading, empty and saving

**E1. Never a blank screen.** Every data view has a loading state (skeleton in the shape of what is coming), an empty state and an error state. (DdxNRopKTZo, DcmoHfNJDWO)

**E2. An empty state says what will appear here,** with an example, and offers one create button. Never just "No data". (De1Swx4hE8W)

**E3. Drafts save themselves:** Back or refresh loses nothing. Drafts belong to the signed-in person and are cleared at sign-out (plant PCs are shared). (DcmoHfNJDWO, DgDnREtkizp)

**E4. A blocked feature stays visible but off,** with the reason and a one-tap fix. Never a dead end. (DewJMeuBL_s)

## 12. Dialogs, confirms and warnings

**D1. A confirm reads "<Verb> <n> <things>?", then the consequence ("You can't undo this."), then a "<Verb>" button.** Never OK or Yes, never the browser's own box. Check: no `window.confirm` in the app. (Del7XTgsuwI, DdxNRopKTZo)

**D2. The page behind a blocking dialog is dimmed** so only the dialog reads. (Del7XTgsuwI)

**D3. Warnings sit in the content next to what they are about:** sentence case, no "!", the item named, a fix button right there. No bright banners across the top. (Del7XTgsuwI)

**D4. Shadows only on things that float** (menus, popovers, dialogs, toasts); panels on a page use a thin border. Settled: the sign-in card floats over the drawing, so it may cast one. (Dc-4jNbtyJg, DdxddtWBsl_, DfmTDE1B6uX)

## 13. Steps and wizards

**W1. Long forms split into named steps by topic** (about 3 fields each), one progress style plus "Step n of N": done ✓, current accent, later ones gray. (DgDnREtkizp, Del7XTgsuwI)

**W2. Every step change saves;** Back and refresh keep the data and the step. (DgDnREtkizp, De1Swx4hE8W)

**W3. Back on the left and Next on the right, same place on every step;** Skip fixed in one corner with "n of N". (DgDnREtkizp, De1Swx4hE8W)

**W4. The last step reviews every answer with an Edit link back.** (DgDnREtkizp)

**W5. The next step repeats the key input with a way back to change it** ("We sent a code to x · Change"). Anything that expires shows a countdown and a way to recover ("Resend code"). (DeefFnvTwrm)

**W6. Say how long it takes** ("6 steps, about 3 min"). (DfaHwqVu06h)

**W7. Between steps something stays still** (card, stepper) and only the content changes. Forward comes in from the right; Back leaves to the right; side-by-side flows replace each other instead of stacking. (DeefFnvTwrm, DfFL1glpnYi)

**W8. At most one question before the person gets value.** First run is a checklist on the real home page with progress, not a tour; at most one tip at a time. (De1Swx4hE8W)

## 14. Motion

**M1. Taps answer within 100 ms; interface motion ends within 300 ms.** Decoration (the sign-in drawing) may run longer, but nothing waits on it. (DdxddtWBsl_, Dd8tUtdhVYZ, DeefFnvTwrm)

**M2. No entrance animation or splash delays the first usable field.** (DauPSfKIycn, Ddg450QpmE2, DfFL1glpnYi, DfaHwqVu06h)

**M3. Motion is optional:** without support it is an instant swap, nothing waits on it, and reduced motion is respected. (Dd8tUtdhVYZ)

**M4. View-transition names are unique on a page;** a duplicate cancels the whole transition. (Dd8tUtdhVYZ)

**M5. Sheets and dialogs grow from the button that opened them and shrink back into it;** with reduced motion, a fade. (DfaHwqVu06h, Dd8tUtdhVYZ)

## 15. Spacing and shape

**SP1. Every gap comes from the 4 px scale** (4, 8, 12, 16, 24, 32, 48); no one-off values. Settled: the golden 8 / 13 / 21 / 34 set is off the grid and not used. (DW87CGQDKbY, DdxddtWBsl_, DfmTDE1B6uX, Df-drL4jt7Z)

**SP2. Gaps inside a group are smaller than gaps between groups.** (DW87CGQDKbY, Df-drL4jt7Z)

**SP3. One radius family by size** (6 small parts, 8 controls, 12 panels). Nested corners: outer = inner + padding; the inner corner is never rounder. (Dc-4jNbtyJg, DdxddtWBsl_, DfmTDE1B6uX)

**SP4. Two-column pages: content on the wide side, controls on the narrow side.** (DW87CGQDKbY)

**SP5. On phones, a desktop side panel stacks above as a short band;** fields and their order stay the same. (C5Ih77VOcm2)

## 16. Permissions, sign-in and trust

**P1. Ask for camera, photos, notifications or location only when the person starts the thing that needs it.** Our own short card first ("Not now" / "Turn on"), then the system prompt; confirm in place ("✓ Notifications on"). One ask at a time. (DewJMeuBL_s, DcmoHfNJDWO)

**P2. After sign-in, land on the work and where the person left off.** (Ddg450QpmE2)

**P3. Passwords only on our own pages;** never block password managers. (DauPSfKIycn, DeefFnvTwrm)

**P4. Pages before sign-in show sample data only,** never real plant data. (DeefFnvTwrm)

## 17. How we work

**PR1. This file and `app/globals.css` are the design system;** they must agree. (DdxNRopKTZo, DfmTDE1B6uX)

**PR2. Fix interface problems worst first.** (DdxNRopKTZo)

**PR3. Check every change at 375 px wide, on a touch screen, and sideways.** (Deq_kvJBI3g, C5Ih77VOcm2)

**PR4. Decide what shows by what people actually use,** not by what was built. (DfreUkyBNQg)

---

## 18. Calm and focused (not boring)

From two posts the owner sent: `DfW8B7oIFoJ` (a buy box rebuilt in four fixes: color, spacing, text sizes, shorter text, with every link and button kept) and `Dft07xmDJkm` (fixing boring design: contrast for focus, a lead color, a simple layout, not playing it safe, room to breathe).

**B1. One focal point per screen.** The one thing the screen is for (the answer, the key number, the list to act on) is the biggest and heaviest; everything else steps back. Two things at the same weight means one of them gets smaller. Check: squint at the screenshot; one thing stands out. (Dft07xmDJkm, DfW8B7oIFoJ)

**B2. Nothing else pulls the eye.** Besides the one accent button, the current tab or menu item and links, color appears only where something needs the person (a status dot, a red count, a real warning). No colored labels, headings or notes for decoration. (DfW8B7oIFoJ: "everything pulls your eye", one button stands out)

**B3. Space splits the groups; each group stays tight.** Groups are 24 to 32 px apart; things inside a group 4 to 8 px. A short list (up to about 8 rows) or a list of facts has no line under every row: space does the job. Long tables keep their row lines. No box inside a box. Check: no ruled line between rows of a short list. (DfW8B7oIFoJ, Dft07xmDJkm)

**B4. Three text sizes per screen,** plus the hero number when the screen has one: a title size, one reading size and one detail size. The text people read (sentences, row titles in lists and cards) is 16 px; dense tables use 14 px for their cells; details (dates, who, counts) one size smaller. Skip the in-between sizes. (DfW8B7oIFoJ: five sizes become three, body text bigger)

**B5. Same information, fewer words.** Cut what repeats; label on the left, value on the right; where a reason or a source is useful but not needed to act, it moves behind a "Why?" tip (`HelpTooltip`). Who did something shows as a small avatar, not their email on every line. Check: no sentence on a row repeats on every row. (DfW8B7oIFoJ: "Fastest delivery" became "Paid fast delivery")

**B6. Every link and button stays.** Calmer never means fewer functions: an action moves (into a menu, behind a tip) but is never dropped. (DfW8B7oIFoJ)

**B7. Zeros that aren't the news stay quiet.** A row of "0 0 0" says nothing; say it once in words ("Nothing filed yet"). A zero that is the news (no overdue steps on a running job) stays. (Dft07xmDJkm)

**B8. Histories read as a timeline:** newest first, grouped by day, a dot and a word for what happened, who as an avatar. `components/ui/Timeline.tsx`. (Dft07xmDJkm)

**B9. A form that isn't the screen's main job opens from one button** ("Add a job"), instead of sitting open under every list. (Dft07xmDJkm)

**B10. Real pictures where the data has them** (equipment photos, document thumbnails), never stock art or decoration (C6). (Dft07xmDJkm)

## 19. Fewer choices (Hick's law)

From two reels the owner sent: `Derh6MRlvot` (Hick's law: the more choices, the longer people take to decide, and that's when they leave; five rules) and `DgI9usSyEJG` (a sign-in page cut down: no tabs, the single sign-on buttons first, the email form turned into a button, no filler text, real artwork, everything moved down within thumb reach, privacy and terms at the bottom, a "Last used" badge).

**H1. Every screen has one obvious main action.** (Derh6MRlvot)

**H2. The main button looks more important than everything around it.** (Derh6MRlvot; A1)

**H3. Advanced options stay hidden until someone needs them** (behind More, a ⋯ menu or a "Show" fold). (Derh6MRlvot)

**H4. Never two buttons that look equally important.** One leads; the others are quieter. On sign-in, Microsoft leads and "Continue with email" is a quiet button that opens the form; the door this device used last leads instead and says "Last used". (Derh6MRlvot, DgI9usSyEJG)

**H5. An option that isn't relevant yet isn't shown yet.** A project with no schedule keeps Shift, Work, Reports and Close-out under More until the schedule is in. (Derh6MRlvot)

## Ideas (optional, use where they fit)

Layout and hierarchy
- Context panel narrow, task wide (about 40/60) on detail pages. (C5Ih77VOcm2, DW87CGQDKbY, Df-drL4jt7Z)
- Main action pinned to the bottom of the narrow column on wide screens. (Df-drL4jt7Z)
- A count beside every list title. (Dd8tUtdhVYZ, De1Swx4hE8W)
- A list summary line with only the urgent part in red ("12 waiting · 1 past needed-by"). (Deq_kvJBI3g)
- Number tiles always carry context under the number ("2 of 6 units", "on $1.2M budget"). (Deq_kvJBI3g)
- A spec line in small caps over a title ("PUMP · CENTRIFUGAL | 150 GPM"); a tiny label over a value ("DUE / Nov 30"). (Dd-o8qwRHYh)
- The consequence inside the main button ("Issue Rev C · notifies 6 people"). (Dd-o8qwRHYh)
- Dot leaders to right-aligned times in schedules and procedures; hold points and permit conditions styled apart from steps. (Dd-o8qwRHYh)
- A "Next up" card on Home: label, item, person, time, status. A day list with an overflow line ("3 more after 10:30"). (DfPJo9UBJ7D)
- Always-visible page name or breadcrumb, since an installed app has no address bar. (DgC6ruhT2NZ)
- A mono breadcrumb above trees and viewers with the current part in accent. (DejRN2Oh3p0)
- Nav ordered by the work cycle; a "Your turnarounds" group with open counts. (DgC6ruhT2NZ)

Numbers and charts
- A sparkline beside the hero number instead of a badge. (Dc-4jNbtyJg)
- 7d / 30d / 90d presets on time charts. (Dc-4jNbtyJg)
- The reason for a spike written on the chart (one accent point and a short note). (Del2E8Ah8bi)
- A value label on the one highlighted bar only. (Del2E8Ah8bi)
- A sparkline per table row. (Del2E8Ah8bi)
- A number that changes rolls to its new value (CountUp). (Df5UFrADYCN)

Lists and actions
- A sticky bulk bar with a count ("2 selected · Approve selected"). (Deq_kvJBI3g)
- "/" focuses a list's search, with the hint printed in the box. (DfMkz9JB-xC)
- Relative times with the exact timestamp on hover (audit). (DfMkz9JB-xC)
- ⋯ shows on hover on desktop, always on touch. (DfMkz9JB-xC)
- Keyboard shortcuts printed beside actions. (DfreUkyBNQg)
- Rows slide to their new place on sort, filter and delete. (Dd8tUtdhVYZ)
- Size chips on closed folders ("1,284 items"); a status chip while a folder loads. (DejRN2Oh3p0)
- Read rows muted with a ✓, unread bright with a dot; tint the one row that has a badge. (Df5UFrADYCN)
- Edit-mode header "Cancel · Editing · Done" for markup. (DfreUkyBNQg)
- Rare tools as a 4-per-row grid in a bottom sheet with a grab bar. (DfreUkyBNQg)

Forms and flows
- Starter suggestions above an empty Ask box, with plant examples. (Deh4XHEqzX_)
- Scope chips inside the composer ("This project" / "All libraries"). (Deh4XHEqzX_)
- A mic for dictating field notes. (Deh4XHEqzX_)
- Format long IDs while typing; keep the focused field above the keyboard. (Deq_kvJBI3g)
- A leading icon in email, tag, document-number and date fields. (DauPSfKIycn, DgDnREtkizp)
- A segmented switch that swaps a two-mode form in place (Report / Meeting, Upload / Link). (Ddg450QpmE2)
- Several inputs end in one success mark ("12 files uploaded ✓"). (DeefFnvTwrm)
- Scan to fill: a nameplate, title block or permit photo fills the form. (DewJMeuBL_s)
- A one-line hint after about 10 seconds of no input on a step. (DeefFnvTwrm)
- "You can change it later." under first-run choices. (De1Swx4hE8W)
- A checklist task opens as a bottom sheet over the list ("task 2 of 3"). (De1Swx4hE8W)

Motion
- The tapped row grows into the page header. (Dd8tUtdhVYZ)
- A dialog grows from its button and returns to it. (Dd8tUtdhVYZ, DfaHwqVu06h)
- Things enter from the side they belong to (drawers, inline add rows). (DauPSfKIycn)
- Actions appear in reading order about 100 ms apart. (DfFL1glpnYi)
- Sliding current-item marker in the side menu. (DgC6ruhT2NZ)

Color and brand
- Brand expression only at the door (sign-in, shared and verify pages); work screens stay neutral. (C5Ih77VOcm2)
- Pick an accent far from the base hues. (DfIaULMIRC-)
- Neutrals tinted about 4% toward the brand hue. (Df9fWE8hcgI)
- A faint top-lit surface (lightness only) on dialogs and the sign-in card. (DdxddtWBsl_)
- Only the finished state tinted ("Done"); other states neutral. (DfmTDE1B6uX)
- Take the type cue from a physical object of the trade (nameplates, title blocks, plant signs). (DfPJo9UBJ7D)

Reviewing
- Blur test: squint at a screen; it should read as three calm areas, not confetti. (Df9fWE8hcgI)
- Eye-path test: number the three things to see first and check the weights. (DdxddtWBsl_)
- Write a screen's decisions (main action, columns, states) before building it. (DdxNRopKTZo, DfMkz9JB-xC)
- Show a measured before and after for each change ("keys typed 30 → 7"). (Del7XTgsuwI)
- Review screens on a real phone, one hand, outdoors, with gloves. (C5Ih77VOcm2)
- Change familiar navigation gradually, with a "what moved" note. (DcmoHfNJDWO)
- Touch targets of 56 px for the main field-work buttons (44 is the floor). (DdxddtWBsl_)
- About 70% dim behind blocking dialogs. (Del7XTgsuwI)

## Not for us

- Mascots, characters, avatar faces, lightning and bubble effects: they make a work tool look like a game. (DauPSfKIycn, DeefFnvTwrm, Ddg450QpmE2, DfaHwqVu06h)
- Splash screens of 3 to 7 seconds, "wait for the form" animations, a swipe-up gate before sign-in: they delay the work. (DauPSfKIycn, Ddg450QpmE2, DfFL1glpnYi, DfaHwqVu06h)
- Facebook, Google and Apple sign-in: accounts are paid workspace seats, not social logins. (DfFL1glpnYi, Ddg450QpmE2)
- Glass, starfield and gradient side menus, dock-style magnifying icons, "Go Pro" upsell cards. (DgC6ruhT2NZ)
- Huge overlapping display type on data screens, and removing persistent navigation. Kept for the sign-in page only. (Dd-o8qwRHYh)
- Optimistic updates on controlled records (approve, sign, issue, transmit): the audit trail needs the server's answer first. (DcmoHfNJDWO)
- Drafts in plain browser storage shared by everyone on a plant PC. (DgDnREtkizp)
- The golden spacing set 8 / 13 / 21 / 34: off the 4 px grid. (DW87CGQDKbY)
- Theme changes that take 600 ms: over the 300 ms limit. (Dd8tUtdhVYZ)

## Where the app stands (checked Nov 24, 2026)

Checked on every page of the app (35 screens, test data) on a phone 375 px wide and turned sideways:
- F1: every field is 16 px, upright and sideways. Passes.
- T2: no page is wider than the screen. Passes.
- TY3: no text under 12 px. Passes.
- F2: every field and control has a name. Passes.
- T1: every tap target is 44 px on touch (down from 192 under 44, then 42). The crawl's only two left are hidden file inputs whose visible button is the target. The Costs sub-tabs (budget cards, invoice and change-order menus) were crawled too: none under 44.
- C3 / F4: text tokens pass 4.5:1 and the field edge passes 3:1 in both themes and for any workspace color (tested in `lib/__tests__/brandColors.test.ts`).
- D1: no browser confirm boxes are left (`window.confirm` only remains as the fallback inside `DialogProvider`).
- F8: every password and key field has a Show button.

Known gaps, not yet fixed:
- None from this check.
- Fixed since the last check: status colors on the dark document viewer (`--on-dark-*`, C5), timeline and calendar bar colors (`--shift-*`, `--viz-cat-*`, C5, C3), and add rows with only a screen-reader name (costs, quality and materials now add through `InlineAddRow`, with a visible name over each box; intake's form has a visible name on each field, F2).
