<!-- Per-reel notes, batch C. Source for docs/design-rules.md, which holds the merged, settled rules. -->
# Rulebook, batch C (8 reels)

Reels: reels2/DfMkz9JB-xC, reels2/DfPJo9UBJ7D, reels2/DfmTDE1B6uX, reels2/DfreUkyBNQg, reels2/DgC6ruhT2NZ, reels2/DgDnREtkizp, reels/DcmoHfNJDWO, reels/Dd-o8qwRHYh.

Facts about our app I used for "Applies in our app to" (read-only look, nothing changed): it is an installable PWA with `display: "standalone"` (app/manifest.ts), so on iPhone there is no browser back button and no browser pull-to-refresh. On phones navigation is a hamburger drawer from TopBar (no bottom tab bar). Barlow woff2 files are self-hosted in app/fonts.

---

### DfMkz9JB-xC: Why Vercel's dashboard feels expensive: five quiet decisions (@designmotionhq, 58 s)
What it shows: A recreated Vercel project grid ("Northwind Labs", about 20 project cards) taken apart in five steps with a "decision 1/5" stepper: status as a dot and one word, each card says what shipped last, one solid button, mono only for copyable strings, per-card actions in one menu. The opening shows one card's status changing live from "● Building" (amber) to "● Ready" (green). It ends with an ad for the "UX Engine" Claude Code plugin, whose checklist sums up the reel: "dot status: dot + one word / last shipped: commit, branch, time / one primary: Add New... only / mono for copy: domain, hash / actions in menu: no icon rows".

RULES:
- R: Status is a small colored dot plus one word ("● Ready", "● Building", "● Error"). The word stays in normal text color and only the dot carries the color. Why: "Color never fills a card, so 20 projects still look calm." The same grid with green, amber and red filled cards is tagged "20 alarms · avoid". Applies in our app to: every status everywhere: document state (Draft, In review, Issued, Superseded, On hold), checkout state, drafting request stage, project and phase health, shift report state, Intelligence checks, notification rows, user presence. Check: open Documents, Drafting Requests and a project plan. No row, card, cell or pill should have a background or left border tinted by state. The status cell reads "● Word". Grep list and pill components for `bg-red-`, `bg-amber-`, `bg-green-`, `border-l-` used for state.
- R: Color never fills a container in a list of many items. Why: same reason. 20 items with 1 error must still look calm, and the one red dot must stand out. Applies in our app to: Documents table, register, Drafting Requests table, project cards, Home lists. Check: blur a screenshot of a 20+ row list. Only small colored points should be visible, no colored blocks.
- R: One small, fixed status vocabulary with a legend and fixed colors (green = ready/done, amber = in progress/waiting, red = error/act). Why: the reel shows a legend "● Ready ● Building ● Error" above the grid. Applies in our app to: all state words across modules. Check: one status map in code (word to color). The same state never has two names or two colors on different pages.
- R: Each item shows what changed last: what (commit message), where (branch), when (relative time). Do not show a vanity metric instead. Why: "You see what changed without opening anything, instead of a vanity chart." The "12.4k views this week" sparkline card is tagged "vanity chart: Says nothing about what changed". Applies in our app to: document rows ("Rev C issued · J. Ortiz · 2 h ago"), project cards (last shift report or last activity, who, when), equipment/tag pages (last drawing or work on the tag), drafting requests (last stage change), Home library tiles. Check: every list row and card has a "last event · actor · time" line. No view counts or decorative sparklines that don't lead to an action.
- R: Exactly one solid (filled) button per screen. Every other control is ghost or outline. Why: "so your eye finds the next action without hunting". On-screen counters: "1 primary", "solid 1 · ghost 4". Applies in our app to: every page header and toolbar, every dialog, every card. Check: screenshot audit. Count filled buttons per screen and per dialog: the answer must be 1 (0 is allowed on read-only pages).
- R: When a page has several "create" actions, they share the one solid button as a dropdown ("Add New... ▾" opens Project, Domain, Team). Do not show three solid buttons. Why: keeps the single-primary rule while still offering every way to create. Applies in our app to: Documents (upload document, new package, new transmittal), Projects (new project, new shift note), Requests. Check: each section header has one "New ▾" solid button and no other solid button.
- R: Monospace only on strings people copy (domains, commit hashes). Names and messages stay sans "so each card reads like a sentence". On screen: tiles "Aa sans: names, messages" vs "0x mono: strings you copy", with per-line labels sans/mono/sans/mono. Applies in our app to: document numbers (KE-DDRT-26-0003), tag numbers, revision IDs, transmittal and package numbers, SAP order/notification numbers, line numbers, file hashes, URLs. Never titles, descriptions, people's names or buttons. Check: grep `font-mono`. Every hit must be an ID-like string, and every ID-like string must be mono.
- R: Copyable strings are click-to-copy. A copy icon sits next to them, it turns into a check on click, and a small toast repeats the value ("✓ Copied a3f9c21"). Why: confirms that the right string was copied. Applies in our app to: all IDs listed above. Check: click a document number. The clipboard holds the exact string and a toast shows "Copied KE-DDRT-26-0003".
- R: Per-item actions (Visit, View Logs, Settings) wait in one "⋯" menu per card. There is no row of icon buttons on every card. Why: "so 20 cards never turn into a wall of icons". Counter "19 cards · 0 icons" vs a red "wall of icons · avoid" panel. Applies in our app to: document rows, request rows, project cards, member lists, file lists in packages and transmittals, notification rows. Check: no list row shows more than one icon button (the ⋯).
- R: Menu items carry an icon and a word (↗ Visit, ▤ View Logs, ⚙ Settings). Never icons alone. Applies in our app to: all dropdown and context menus. Check: open every ⋯ menu. Each item has a text label.

IDEAS:
- I: Status changes in place, live, without a reload (the opening card goes Building to Ready). Where it could serve us: OCR/indexing state of an uploaded document, upload and transmittal-send progress, AI answer generation, sync state of a shift report.
- I: Fixed card anatomy: letter avatar, bold name, muted mono domain, commit line with a commit icon, "main · 2m ago" muted, status at bottom left, time at bottom right. Where it could serve us: project cards, document cards on phones, package cards.
- I: The "⋯" button appears when you hover the card, and the card border brightens on hover. Where it could serve us: desktop lists. On touch devices hover does not exist, so the ⋯ must always be visible there.
- I: The hash gets a highlight on hover to signal that it can be copied. Where it could serve us: IDs in tables.
- I: A "/" key hint inside the search box ("Search Projects... /") means "press / to focus search". Where it could serve us: Documents, register and request list search boxes, next to the global ⌘K.
- I: Workspace switcher at top left ("Northwind Labs · Pro ⇕"). Where it could serve us: company or site switcher.
- I: A grid/list toggle as quiet ghost icons in the toolbar. Where it could serve us: Documents (table vs cards), Projects.
- I: Relative times ("2m ago", "1h ago", "1d ago") for recency. Where it could serve us: activity lines. Adaptation for us: controlled records also need the absolute date and time (show it on hover or in the detail view) for audit.
- I: "Screens first, then code": write down the screen's decisions as a checklist before building it. Where it could serve us: any new screen review.

---

### DfPJo9UBJ7D: Your app looks AI-made: blame the font (@designmotionhq, 54 s)
What it shows: "Typography · 4 decisions" applied to a bike-repair booking app, "Fernwood". 1) The default: three apps (Taskly, Invoicr, Fernwood) with the same "Good morning, <Name>" layout in `system-ui, sans-serif` are tagged "same stack × 3", boxed as "starter template", and labeled "read as template before the bookings". 2) A font from your world: the shop name in Lora "bank" (red "wrong world"), Montserrat "fintech", and Bricolage "workshop" (green "sturdy, warm"), with a hanging sign "BIKE REPAIR · EST. 2014" as the source. 3) Load it for real: `<link href="…Bricolage+Grotesque…&display=swap">` in index.html and a network row "bricolage-grotesque.woff2 · 200 · font". Then "Skip it, the fallback ships": "your machine ✓ (installed locally)" shows Bricolage while "visitor" gets "system-ui fallback", tagged "fallback in prod". 4) One family, two weights: "1 family · Bricolage", "Aa 400 / Aa 700", a ladder 40/700, 24/700, 18/400, 14/400, next to a red "3 fonts" card (Lora, Montserrat, Bricolage, Lora). End checklist: "font from the domain (workshop, not bank) / loaded with display=swap (every browser) / one family, two weights (400 · 700) / real type scale (14 · 18 · 24 · 40)".

RULES:
- R: Never ship the default `system-ui, sans-serif` stack as the product's face. Pick a typeface from the product's own world. Why: "Most generated apps ship the same default font stack… People recognize that template before they read a single booking." Also "a repair shop should not sound like a bank." Applies in our app to: all UI text. Our world is industrial and road signage, plant nameplates and drawing title blocks. Barlow (a road and industrial signage face) fits, so keep it. Check: DevTools, computed `font-family` on body and inputs is Barlow, not a system font. Also check inputs, buttons and selects, which often fall back to system fonts.
- R: Load the font for real, so every visitor's browser downloads the same file, and use `font-display: swap` (`&display=swap`). Why: "Skip that step and the fallback ships, while your own machine hides it because the font is installed." The checklist says display=swap = "every browser". Applies in our app to: every page, including login, signup, public share/verify/transmittal pages, the offline page and printed views. Check: DevTools Network, filter "Font": barlow-*.woff2 returns 200 on a fresh profile. `@font-face` has `font-display: swap`. No dependency on fonts.googleapis.com, which may be blocked on plant networks.
- R: Test type on a machine that does not have the font installed, never only on the dev box. Why: the reel's whole "your machine vs visitor" point. Applies in our app to: release checks. Check: open the app on a clean VM, a phone and a plant PC (or a browser with local fonts blocked), then compare against a screenshot.
- R: One family, two weights: 400 and 700. Build hierarchy from size and weight, not from more fonts or in-between weights. Why: the "3 fonts" card looks messy, and one family "gives each piece its own step". Applies in our app to: all UI text (plus mono for copyable IDs, per DfMkz9JB-xC). Check: count distinct `font-weight` values in the built CSS (target: 400 and 700) and distinct families (target: 1 sans + 1 mono).
- R: Use a real type scale where each piece of information gets its own step: 40/700 (place or subject), 24/700 (the next key item), 18/400 (secondary), 14/400 (meta, time). Why: "the shop name, the next repair and the time slot each get their own step on the scale." Applies in our app to: page heroes, cards, table rows (document number, title, action, date). Check: on any card, no two different roles sit within 2 px of each other in size.
- R: The "Good morning, <Name>" header on a stock layout is itself a template tell. If a greeting stays at all, it is small and the subject is big ("Good morning," small, "Northside Cycles" at 40/700). Why: it is the first thing the three cloned apps share. Applies in our app to: Home hero. Check: Home's largest text is the work item or site, not the greeting.

IDEAS:
- I: A "Next up" card: tiny uppercase eyebrow ("NEXT REPAIR"), bold item ("Tubeless setup · Gravel bike"), avatar + person, clock + time, status at right. Where it could serve us: Home "Next": next inspection, next shift handover, next document due, next turnaround milestone.
- I: A day list with a left column of times (11:15, 13:00, 15:30), a bold task · muted person, and status on the right. Instead of listing everything, a muted overflow line says "3 more after 10:30". Where it could serve us: shift plan, today's jobs, turnaround daily schedule.
- I: Find the font in a physical object from the product's world (the workshop sign). Where it could serve us: equipment nameplates, P&ID title blocks and plant signage for choosing the face and a condensed variant for tag numbers.
- I: The "glyph test": the reel highlights the letter "g" in "Good morning" to show which font is rendering. Where it could serve us: a quick visual QA check that Barlow loaded.

Not for us: the specific faces (Bricolage, Lora, Montserrat): our world is industrial signage, not a workshop, bank or fintech. The principle stands.

---

### DfmTDE1B6uX: Build a design system: five tokens, one screen (@designmotionhq, 56 s)
What it shows: A "Sprint review" card ("Ilsa Marrow, Kestrin, design lead / 12 tasks shipped, 3 in review" / rows Token audit (Done), Dark mode (In review), Icon set (Done) / teal "Share update" + "Later") starts as a gray wireframe. It is built with five tokens, marked by a pill "01 Color roles" to "05 Two shadows" and a 5-segment bar. Hand-typed values are shown being replaced: `padding: 13px;` becomes `padding: var(--space-4);` and `color: var(--teal-500);` becomes `color: var(--primary);`. Finally the card is pulled apart into labeled layers (Background `color.bg`, Surface `r 24, shadow-sm`, Text `type scale`, Components `primary, space 8`, Toast `shadow-lg`), and a Dark/Light toggle shows light mode.

RULES:
- R: Every value comes from a token, never typed by hand. Why: "Every value on it will come from a token, never typed by hand." The before state shows `padding: 13px`. Applies in our app to: all components and pages. Check: grep for Tailwind arbitrary values (`-[13px]`, `-[10px]`, `text-[11.5px]`), raw hex or rgb in component files, and inline `style={{ padding: … }}` numbers. Target: zero outside the theme file.
- R: Name colors by their job, not their hue. The roles are background, surface, text, muted, primary. Why: `var(--teal-500)` in a component is the before state, and `var(--primary)` is the after. Applies in our app to: all color usage. Check: components only reference role tokens. Hue scales (`blue-600`, `teal-500`) appear only in the theme definition.
- R: Every gap is a multiple of 4: 4, 8, 16, 24. Before, the gaps were 5, 19 and 13. Why: random spacing becomes rhythm. (Caveat: the reel's own animated labels end on 11 and 25, which are off-grid. That is a mistake in the video. Follow the spoken rule.) Applies in our app to: padding, margin and gap everywhere. Check: grep Tailwind spacing that yields 2, 6, 10 or 14 px (`*-0.5`, `*-1.5`, `*-2.5`, `*-3.5`) and arbitrary px values.
- R: Pick 4 type sizes and never use one in between. In the reel, 17/12/25/15 px becomes 20 (name), 13 (role), 28 (title), 16 (summary). Why: "Pick 4 sizes and never use one in between." Applies in our app to: all text. Check: count distinct font sizes in the built CSS. Target: 4 (plus at most one display size).
- R: Nested corners follow one rule: outer radius = inner radius + padding (24 = 8 + 16). Before, the outer radius was 10 and the inner 14, so the inner corner was rounder than the outer one. Why: concentric corners look like one object. Applies in our app to: any rounded element inside another (rows inside cards, inputs inside dialogs, chips inside pills, segmented controls, button groups, the active pill inside the sidebar, the "Open" button inside a "Needs you" card). Check: for each nested pair, outer = inner + gap between them, and never inner > outer.
- R: Exactly two shadow levels: small (`shadow-sm`) for cards, large (`shadow-lg`) for anything that floats (toast, menu, popover, dialog). Why: "Two levels, small for cards, large for anything that floats." Applies in our app to: all elevation. Check: grep shadow classes and custom box-shadows. Target: two tokens. Floating layers always use the large one, page cards never do.
- R: Light and dark mode come from swapping the color-role values, not from per-component overrides ("Swap the color roles and you get light mode for free"). Visible detail: the swap also changes the primary shade and the text on it. Dark mode has dark text on bright teal; light mode has white text on a deeper teal. So "primary" and "on-primary" are both roles. Applies in our app to: the theme system (ThemeMenu). Check: no `dark:` color classes in components. The button label on primary passes 4.5:1 contrast in both themes.

IDEAS:
- I: Build order for any new screen: gray wireframe, then color roles, spacing, type, radius, shadows. Where it could serve us: new screens and redesigns, and as a review checklist.
- I: Rows inside a card sit on a slightly lighter nested surface instead of each row having its own outline. The secondary action ("Later") is plain text next to the solid primary. Where it could serve us: "Needs you" lists, settings groups, dialog footers.
- I: Only the completed state gets a tint ("Done" in a primary tint); "In review" stays neutral gray. Where it could serve us: if pills are kept anywhere, only one state is colored. (The Vercel reel's dot + word is the stronger rule for lists.)
- I: A confirmation toast ("✓ Update shared") floats above the card with the large shadow after an action. Where it could serve us: after send, issue, save and share actions.
- I: An exploded-layer diagram as documentation of the token system. Where it could serve us: a design-tokens reference page for developers and AI helpers.

---

### DfreUkyBNQg: Hick's law: six fixes for a crowded toolbar (@designmotionhq, 72 s)
What it shows: A floating toolbar with 12 tiny, equal gray icons ("Find the crop tool. Found it yet?"). A "decision time" step chart rises at 1, 2, 4, 8 and 12 options ("Each doubling, one step slower"), then a stopwatch ("Twelve icons feel slow"). The fix is shown on a phone photo editor: "Keep four" (Crop, Adjust, Filters, Erase + "···"). "One accent": a transitional frame gives all four a teal circle, then only Crop keeps it ("The rest stay quiet"). "Label every icon" ("Glance, don't guess"). "Rare tools, one tap away": More opens a bottom sheet "More tools" with a grab handle. "Group by job. Edit, then adjust": small-caps headers EDIT (Rotate, Flip, Stickers, Text, Markup) and ADJUST (Light, Auto, Contrast). "One exception: experts. Shortcuts skip menus": ⌘ + R keycaps rotate the photo directly. The editor header reads "Cancel · EDIT · Done" with Done in teal. It ends with an ad for "/ux-audit" in "UX Engine" (with "/restyle: Kill the AI look").

RULES:
- R: Hick's law: the more equal choices you show, the longer people take to pick one, and decision time grows with every doubling of options. Show only the 3 to 5 tools people use daily ("Keep four"). Why: "12 icons feel slow before anyone taps." Applies in our app to: every toolbar, tab bar and action row: document viewer/markup toolbar, Documents view switcher (9 tabs), project tab bar (10 tabs + More), shift report toolbar, Intelligence tabs, editor toolbars, the top bar icon cluster. Check: count the equal-weight items visible in each bar. Target: 5 or fewer plus "More".
- R: Choose the visible tools from usage data: "Count what they tap, not what you shipped." Applies in our app to: the same bars. Check: analytics events exist on toolbar and tab clicks, and the visible set equals the top 3 to 5 by use (reviewed per release).
- R: One action gets the accent. The rest stay quiet so "the eye lands on the first try". The frame where all four are accented shows that accenting everything means nothing is accented. Applies in our app to: each toolbar and each screen (agrees with DfMkz9JB-xC "one solid button"). Check: count accent-colored controls per bar. Target: 1.
- R: Put a word under (or beside) every icon. Why: "A label turns a guess into a glance." Applies in our app to: toolbars, the bottom bar on phones, the top bar, section-header icon buttons, the collapsed sidebar (tooltip at minimum, but a visible word wherever there is room). Check: no icon-only button in a toolbar. On touch, tooltips don't exist, so the label must be visible.
- R: Rare tools go behind "More", one tap away, "never in the way". Applies in our app to: the same bars. Check: every hidden action is reachable in exactly one tap from More and is also found by ⌘K.
- R: Group what is behind More by job, with short headers (EDIT, then ADJUST). Why: "Two short groups read faster than one long row." Applies in our app to: More menus and overflow sheets (for example Records: Documents, Materials, Quality / Money and people: Costs, Members). Check: no overflow list longer than about 6 items without a group header.
- R: Give experts keyboard shortcuts that skip the menu entirely (⌘R rotates without opening More). Applies in our app to: top actions (new request, next/previous shift, issue, check out/in, markup tools, J/K through rows), shown in tooltips and in the ⌘K list. Check: each top-5 action has a shortcut, and the shortcut is printed next to its label somewhere.

IDEAS:
- I: Edit-mode header "Cancel · EDIT · Done": Cancel at left, the mode name in the middle, Done at right in the accent. Where it could serve us: drawing/PDF markup mode, inline editing of a register row, reordering a plan.
- I: Overflow tools as a 4-per-row grid of rounded tiles (icon + word) in a bottom sheet with a grab handle and a title. Where it could serve us: More on phones (project tabs, document actions).
- I: Selected tool = tinted circle + accent-colored label. Where it could serve us: the active markup tool in the drawing viewer.
- I: Put the tool bar at the bottom of the phone screen, within thumb reach, over the content. Where it could serve us: the drawing/photo viewer in the field.

---

### DgC6ruhT2NZ: Glassy Sidebar V10 (@code.xr, 5 s, music only)
What it shows: A React demo with no voice (the transcript line "Thanks for watching guys!" is a speech-to-text error on music). A collapsed pill rail: logo, search, Home, Measure, Analyze, Reduce (active: solid white circle plus a small white dot to its left), Report (orange dot on its corner), a divider, three project color squares (yellow active, with its own small dot marker), and at the bottom a crown inside a yellow usage ring and an "AP" avatar with a green presence dot. Hovering magnifies icons like a dock. Clicking the logo (its icon changes on hover to signal "expand") opens two joined parts. The left part has: header "Aurora / Climate workspace" with a "<" collapse button, "Search... ⌘K", nav pills (Home, Measure, Analyze ▾, Reduce, Report with an orange "3"), "PROJECTS +", project rows with color dot, name ("Fleet electrifica…" truncated) and a count (12, 8, 5), a "Go Pro 72% used · Upgrade" card, and a user row "Ava Patel / ava@aurora.app ⋯". The right part is a white rail: the active nav pill runs into it through curved inner corners. It holds a blue primary button that stays at the top on every page, page-specific actions below it (Home: +, refresh, share; Measure: +, upload, filter; Reduce: +, target, share), and the page name written vertically at the bottom ("HOME", "MEASURE", "REDUCE").

RULES:
- R: The collapsed sidebar keeps every signal: the icons, the active marker, badges, the active project marker, and the account. Why: collapsing must not hide where you are or what needs you. Applies in our app to: the desktop Sidebar collapsed state. Check: collapse it on Drafting Requests. The active icon is marked, the count badge shows (as a dot), and every icon has a tooltip and aria-label.
- R: A count badge becomes a dot when there is no room for the number (Report "3" expanded, orange dot collapsed). Applies in our app to: the collapsed sidebar, phone bottom bar, small icon buttons. Check: collapse the sidebar. Numbers become dots, and the icon does not shift.
- R: Long names truncate on one line with an ellipsis, and the count stays visible ("Fleet electrifica… 8"). Why: rows keep their height and the count column lines up. Applies in our app to: sidebar project list, table cells, breadcrumbs, tabs. Check: give a project an 80-character name. The row stays one line, the count stays aligned, and the full name shows on hover (title attribute).
- R: Search sits at the top of the navigation with its shortcut printed in the field ("Search... ⌘K"). Applies in our app to: Sidebar or TopBar search. Check: the ⌘K hint is visible, and the shortcut works from every page.
- R: Account and plan sit at the bottom, apart from navigation. The user row is avatar (with presence dot), name, email and a "⋯" menu. Applies in our app to: Sidebar footer. Check: no account or settings items are mixed into the main nav list.
- R: Collapse and expand is an explicit, visible control ("<" next to the workspace name). Applies in our app to: Sidebar. Check: there is a visible collapse button, its state persists between sessions, and it is reachable by keyboard.

IDEAS:
- I: The active nav item joins the content edge (same color as the content, curved inner corners), so the sidebar "points at" the page. Where it could serve us: Sidebar active state instead of a floating filled accent pill.
- I: A context action rail: page-specific quick actions next to the content, with the one primary action fixed in the same spot on every page and the rest changing per page. Where it could serve us: Documents (upload, filter), Project (add shift note, export), Requests (new, filter).
- I: The current page name written small at the edge of the content as an orientation marker. Where it could serve us: a page title or breadcrumb that is always visible, which matters in a standalone PWA without a URL bar.
- I: A "PROJECTS +" group in the sidebar: color dot, name, open-item count pill, active project highlighted. In the collapsed rail the projects become color squares with an active marker. Where it could serve us: "Your turnarounds" in the sidebar with items waiting on you.
- I: Nav ordered as the work cycle (Measure, Analyze, Reduce, Report: verbs in process order) and a chevron on items with children (Analyze ▾). Where it could serve us: order modules by the turnaround cycle (Plan, Execute/Shift, Work, Report, Close-out).
- I: Motion continuity: the white tab slides to the newly clicked item, and labels fade in staggered on expand. Where it could serve us: active indicator in tabs and sidebar (short, under ~200 ms, respecting reduced motion).
- I: Presence dot on the avatar (green = online). Where it could serve us: people lists and comment authors, when presence data exists.

Not for us: glassmorphism, the starfield and the blue-to-black gradient: they hurt contrast and legibility on long sessions and in glare in the field. Dock-style hover magnification: it makes click targets move and jostle their neighbors. A "Go Pro / Upgrade" upsell card in the work area: only show a usage meter if there is a real quota (storage, seats).

---

### DgDnREtkizp: The perfect multi-step form (@designmotionhq, 58 s)
What it shows: A dark UI with a pink accent. It opens with a 12-field "WALL" checkout form next to a "PATH" version ("PERSONAL · Step 1 · STEP 1 OF 4 · 25%": first name, email, phone, Next). There are five sections. 01 Chunking: "EFFORTLESS 3 fields", "FATIGUE 12 fields", "CHUNKED 4 × 3 fields", each with a "COGNITIVE LOAD" bar (low, about 95%, medium). 02 Progress: "CURRENTLY ON Step 2 / 4" shown three ways: linear bar ("STEP 2 OF 4"), numbered dots (done = filled with a check, current = filled with its number, future = gray outline), step labels (done = green "✓ PERSONAL", current = accent tag, future = gray). The bar reads 25 / 50 / 75 / 100% at steps 1 to 4. "Users need to feel the end is close." 03 Boundaries: four cards tagged PERSONAL, SHIPPING, PAYMENT, REVIEW with "Step n / 4". Fields have leading icons, the card number is masked "•••• •••• •••• 4242" and the CVC "•••". Review lists answers with a pencil each and "✓ Ready to submit". "Each step earns its own screen. Random splits feel arbitrary." 04 Validation: "INLINE · INSTANT" ("Validation runs as you type"; the email field gets a red border, a red (!) icon at the right, "Enter a valid email address" under it, "Next is blocked until valid", and Next dimmed) vs "FINAL · TOO LATE" (on step 1 the same bad email shows a green ✓; on step 4 it turns red with "Invalid format", a toast "Email invalid on step 1 · go back", and Submit dimmed). "Inline red beats final-screen rejection." 05 State: "Back + Refresh" chips, all fields keep their values with green checks, "DATA INTACT", caption `localStorage.wizardState = { step, fields }`. "Lose the form once, you lose the user forever."

RULES:
- R: Chunk long forms. About 3 fields is effortless, and 12 fields in a row trigger scroll fatigue. Why: "Chunking lowers cognitive load." Applies in our app to: New project wizard, new drafting request, shift report sections, permit/MOC-style forms, document upload metadata, company setup, user invites. Check: count the fields visible per step or section. A single screen of 10+ unrelated fields needs splitting or visible grouping.
- R: Split by context, not by count (Personal, Shipping, Payment, Review). Why: "Each step earns its own screen. Random splits feel arbitrary and slow." Applies in our app to: the same flows (for example Where: unit, area, tag / What: scope, files / When: dates / Review). Check: each step has a topic name, and no step mixes topics.
- R: Show where you are with one progress indicator: linear bar, numbered dots or step labels: "pick one". Also show "Step n of N". Done steps get a check, the current step the accent, future steps gray. Why: "Users need to feel the end is close." Applies in our app to: every wizard and multi-step flow (ProjectWizard StepPath, Split/Merge wizards, send/transmittal flow, close-out steps). Check: exactly one indicator style per flow, the same style across flows, and a visible "Step 2 of 4".
- R: Validate inside the step, not at the end ("Wrong email on step one shouldn't surface on step four"). Applies in our app to: all multi-step flows and long forms. Check: enter a bad value on step 1. The error appears on step 1, before Next.
- R: Block Next while the step is invalid, and say why in words right there ("Next is blocked until valid"). Do not just dim the button. Applies in our app to: wizard footers, "Mark complete", "Issue", "Submit". Check: every disabled primary button has visible text explaining what is missing.
- R: An error is a red border, a (!) icon in the field, and a message under the field that says how to fix it ("Enter a valid email address"), not just what is wrong ("Invalid format"). Applies in our app to: every input. Check: read every validation message. Each one names the field and the fix.
- R: Never show a success mark (green ✓) on a value that hasn't actually been validated. The "too late" form shows ✓ on "not-an-email", then rejects it three steps later. Why: a false check teaches people to distrust every check. Applies in our app to: input checks, upload "done" marks, "saved" indicators, sync states, connector checks. Check: a ✓ only appears after the real validation or server confirmation has succeeded.
- R: Save the state on every step change, so Back keeps the data and so does a page refresh ("DATA INTACT"). Why: "Lose the form once, you lose the user forever." Applies in our app to: all wizards and long forms (shift report, drafting request, project wizard, markups, comments). Check: fill step 2, refresh, press Back. Every value is still there, and you land on the same step. Adaptation for us: the reel stores the draft in `localStorage`. On shared plant PCs, key drafts to the signed-in user (server-side or user-scoped) and clear them on sign-out, so one person's draft never shows up for the next.
- R: End with a Review step that lists every answer with an edit (pencil) link back to its step, then a clear "Ready to submit". Applies in our app to: project creation, transmittals, issue/approve flows. Check: the last step before submit is a read-only summary with per-row Edit.
- R: Fixed footer: Back (ghost, ← arrow) at left and Next (solid accent, → arrow) at right, in the same place on every step. Applies in our app to: all wizards. Check: the buttons don't move or change style between steps.

IDEAS:
- I: Leading icons inside fields (person, mail, phone, pin, card). Where it could serve us: tag, unit, date and person fields in requests.
- I: Mask sensitive values and show only the end ("•••• 4242", "•••"). Where it could serve us: API keys and connector secrets in Setup, and partial account or phone numbers.
- I: A colored tag per step (PERSONAL pink, SHIPPING teal, PAYMENT amber, REVIEW green). Where it could serve us: only if the colors don't clash with status colors. Otherwise use neutral tags.
- I: Count the current step as progress (step 1 of 4 shows 25%), so the bar is never empty. Where it could serve us: wizard bars.
- I: A "cognitive load" meter as a design-review device. Where it could serve us: auditing long forms.

Conflict to settle: this reel validates "as you type". Another reel (text input, notes-1 #6) says to show errors after blur. Reconcile: show the first error on blur (or on Next), then re-check as the user types, so the error clears the moment it is fixed. Never flag red while someone is still typing a value for the first time.

---

### DcmoHfNJDWO: The 15 UX rules every app needs: Jakob's law (@agenticmatt, 67 s; rules 6 to 15 are in the caption)
What it shows: A talking head with overlays of the Instagram, TikTok and YouTube bottom bars (TikTok: Home, Friends, +, Inbox, Profile. YouTube: Home, Shorts, +, Subscriptions, You. All labeled). An NN/g card of Jakob Nielsen ("79 patents", the creator's unverified claim) and an infographic "JAKOB'S LAW of the internet user experience: Users spend most of their time on other sites, so they prefer your site to work the same way as the ones they already know". It shows familiar websites leading through "mental model transfer" to your website, with four benefits: lower learning curve, faster task completion, higher satisfaction, reduced support load. A "5 rules" countdown ("5. Five tabs max / 4. Home on far left, Profile on far right / 3. 'Create' in middle / 2. Swipe left = back / 1. Swipe down refreshes / Missing these ✗ hurts retention"). His own app "Prospect Ping" had bottom tabs Roster, Search, Alerts (red "16"), Settings, and he moved Settings to a gear at top right. A Snapchat logo for the 2018 redesign ("more than 1.2 million people signed a petition"). An iPhone Screen Time "Most Used" list ("examine the apps you spend the most time in"). Spoken: "If you put something in an unexpected place, now users have to learn your app and it hurts retention." "Bottom navigation should be reserved for your app's core actions."

RULES:
- R: Jakob's law: don't reinvent navigation. Put things where people's other apps put them. Why: "People spend almost all their time in other apps, so they expect your app to work the exact same way"; unexpected placement "hurts retention"; benefits listed: lower learning curve, faster tasks, higher satisfaction, reduced support load. Applies in our app to: everything. For refinery engineers the "other apps" are Outlook, Teams, Excel, Windows File Explorer, SharePoint, SAP and Bluebeam/Adobe on desktop, and the big phone apps in the field. Check: on desktop, tables sort by clicking a header, double-click opens, right-click gives a context menu, Esc closes, Enter confirms, Ctrl/⌘+S saves, Ctrl/⌘+F finds, Delete asks before deleting.
- R: At most 5 bottom tabs on phones. Applies in our app to: the phone layout (today a hamburger drawer hides all destinations). Check: on a 375 px screen the core destinations are one tap away in a bottom bar of 5 or fewer labeled tabs.
- R: Home on the far left, Profile (You) on the far right. Applies in our app to: the phone bottom bar. Check: tab order.
- R: If users create something, "Create" goes in the middle. Applies in our app to: phone bottom bar: new drafting request, new shift note or site photo. Check: the middle slot is the create action.
- R: Swiping from the left edge goes back. Never hijack that gesture. Applies in our app to: phone views. No left-edge drawer swipe, and horizontally scrolling tables or the PDF/drawing pan must not capture the edge. Check: on iPhone, swipe from the left edge on a document view to go back. Because our PWA runs standalone, iOS gives no browser back button, so every non-root screen also needs an in-app ← button.
- R: Pull down refreshes lists. Applies in our app to: Inbox, Activity, Documents, Requests and the shift report on phones. Standalone PWAs on iOS have no browser pull-to-refresh, so the app must provide it (or a visible refresh). Check: installed PWA on iPhone, pull down on a list and it reloads.
- R: Settings never gets a bottom tab. Settings goes top right or inside Profile. Bottom navigation is reserved for the app's core actions. Applies in our app to: the phone bottom bar, and on desktop settings sits with the account at the bottom of the sidebar, not among work modules. Check: no "Settings" in the bottom bar or the main nav list.
- R (6): An X closes a modal or a whole flow. A left arrow goes back one screen. Applies in our app to: dialogs, drawers, wizards, the document viewer, full-screen mobile views. Check: every wizard step shows ← (one step back) and X (leave the flow, with an "unsaved changes" guard). No ← that closes everything and no X that goes back one step.
- R (7): Never show a blank screen while content loads. Use a skeleton, spinner or progress bar. Applies in our app to: every route, table, document preview, PDF viewer, graph, search results, AI answers. Check: DevTools, throttle to Slow 3G and navigate every main route. Something meaningful shows within about 100 ms.
- R (8): When users leave a list and come back, keep their exact scroll position. Applies in our app to: Documents table and register, Inbox, Activity, search results, Drafting Requests, project lists, plus the filters, sort and selected row. Check: scroll to row 80, filter, open an item, go back. Same row, same filter, same sort.
- R (9): Tapping the tab you are already on returns to the top (or the root) of that tab. Applies in our app to: phone bottom bar, and on desktop clicking the active sidebar item goes to the section's root list (and scrolls to top if already there). Check: from a document detail, click "Documents" in the sidebar. It goes to the list, and a second click scrolls to top.
- R (10): Load the next batch before users reach the bottom. Applies in our app to: long lists and tables (prefetch the next page, or virtualize). Check: fling-scroll a 2,000-row register. There is no visible "loading…" stall at the bottom.
- R (11): Small personal actions (like, follow, save) update immediately, then sync in the background. Applies in our app to: star/pin/watch a document, mark notification read, tick checklist items, reactions, view preferences: with rollback and an error toast if the sync fails. Check: click star with the network offline. It toggles at once, then reverts with a message. Exception for us: approvals, signatures, issuing a revision, check-out/check-in and transmittals must wait for server confirmation (controlled records and audit trail), with a pending state.
- R (12): Save drafts and unfinished input automatically, so going back doesn't erase them. Applies in our app to: shift report, drafting request, comments, markups, the Ask box, all wizards. Check: type, navigate away, come back. The text is still there and a "Draft saved" state is visible.
- R (13): Ask for notifications, photos, camera or location only when the user tries the related feature. Applies in our app to: PWA push permission (ask when they turn on alerts for a request), camera (when they tap "Add photo" or "Scan tag"), location (when they open a plot plan "near me"). Check: fresh install, first launch. No permission prompt appears until the feature is used.
- R (14): Quick actions open in a bottom sheet on phones, and swiping down dismisses it. Applies in our app to: row ⋯ menus, filters, share, "More" on phones (desktop keeps dropdowns). Check: on a phone, ⋯ opens a sheet with a grab handle, and a downward swipe closes it.
- R (15): Notifications and shared links open the exact content they reference, not the home screen. Applies in our app to: email/Teams notifications, @mentions, share links, transmittal and verify links, QR codes on equipment tags. Each opens the exact document, revision, page or comment, and survives the sign-in redirect. Check: sign out, open a shared link, sign in. You land on that item, not Home.

IDEAS:
- I: Look at what your users actually spend their day in (the reel shows iPhone Screen Time "Most Used") and copy those conventions. Where it could serve us: interview or observe planners and engineers: Outlook, Teams, Excel and SAP habits on desktop.
- I: Don't redesign familiar parts abruptly (Snapchat 2018: 1.2 million people petitioned to undo the redesign). Where it could serve us: when moving core nav or renaming modules, roll out gradually, keep redirects from old locations, and say what moved.
- I: An "Alerts" tab with a red count badge ("16"). Where it could serve us: "Your turn" or Inbox on the phone bottom bar.

Not for us: the social mechanics themselves (likes, follows, feeds): the principles above carry over, the features don't.

---

### Dd-o8qwRHYh: If your app feels flat: three planes, one signal color, skip the middle sizes (@ayoships, 24 s)
What it shows: (The out/transcript.txt is missing. The speech below is from the earlier pass and matches the burned-in captions "feels / in / type / subject / That / feel / can't / pick / One / tap / else / paper / default / sizes / huge / tiny / between / AI / try".) "If your app feels flat, design in three planes: big type in the back, your subject in the middle, and the buttons on top. That overlap is what makes the screen feel deep. If people can't tell what to tap, you need to pick a signal color: one color that only ever means 'tap this', and everything else is just ink and paper. And if your app still looks default, skip the middle sizes: make one thing huge, everything else tiny, and nothing in between. Share this video with your AI or developer so they can try it in your app." There are three before/after phone screens:
1) Headphones. Before: white page, product in a gray box, "Aura Studio $249", stars, description, unlabeled color dots, blue full-width "Add to cart". After: green page, a small spec eyebrow "OVER-EAR · WIRELESS" at left and "40 H · -32 DB" at right, huge "AURA" behind the headphones, a tiny "PRICE" label over "$249", color swatches labeled "SAGE · ONYX · OAT", a dark bar "Add to bag | Free returns", and a cart icon with a count.
2) Church. Before: "Grace Church / Welcome home", "Next service: Sunday, Oct 4 · 10:00 AM", order of service with times, two equal blue buttons "Watch live" and "Give", plus a bottom tab bar Home, Sermons, Give, Profile (Give appears twice). After: cream "paper" with serif type: "GRACE CHURCH · Est. 1924", an arched window photo, a huge "4" with "OCTOBER · SUNDAY / Morning gathering, 10:00", "AFTERWARDS: Stay for coffee in the hall." in red italic, a big "The Lord is my Shepherd", "PSALM 23 · PASTOR JAMES HALE", order of service with dot leaders running to right-aligned times and red italic cues under items ("All stand", "Please be seated"), and a bottom row with the red italic link "Plan a visit →", "● WATCH LIVE" and "GIVE" in small caps. The tab bar is gone.
3) Coach. Before: centered avatar, "Maya Ross / Strength & running coach", three equal stats "120 Clients · 8 Years · 4.9 Rating", About, blue "Book a session". After: huge blue "MAYA ROSS" behind her photo, one stat "8+ YEARS COACHING", "TRAIN FOR THE LIFE YOU WANT TO KEEP LIVING.", and a black bar "Book a session · from $60 · ↗" (blue arrow square).

RULES:
- R: One signal color that only ever means "tap this". Everything else is ink and paper (neutrals). Why: "If people can't tell what to tap…". Applies in our app to: the whole app: one action color, used only on interactive things, and different from the status colors. Check: take any screenshot, and every element in the signal color must be clickable. Note that the reel's own church "after" also uses its red for non-tappable cues ("AFTERWARDS", "All stand"), which breaks the rule. Don't copy that.
- R: Skip the middle sizes: one thing huge, everything else tiny, nothing in between. Why: "if your app still looks default". Applies in our app to: page heroes, cards, detail headers (the document number or project name huge, the rest small). Check: per screen, one dominant size, the rest within the small sizes, and nothing in the middle band.
- R: One primary action per screen. The "before" church had two equal blue buttons (Watch live, Give), and the "after" keeps one signal link with the others as small text. Applies in our app to: every screen (agrees with DfMkz9JB-xC and DfreUkyBNQg). Check: a screenshot never has two equally loud action buttons.
- R: Show one key number, not a row of equal stats (120 / 8 / 4.9 becomes "8+ YEARS COACHING"). Applies in our app to: page hero stat strips (Home, project header). Pick the one figure that matters now. Check: each hero has one large number, and the others are small or moved.
- R: Don't offer the same action twice on one screen ("Give" as a button and as a tab). Applies in our app to: headers vs toolbars vs row menus (for example "New request" in the top bar and the page header). Check: an action appears in at most one prominent place per screen (⌘K excluded).
- R: Color choices are labeled with words, not color alone (swatches "SAGE · ONYX · OAT"). Why: names make the choice readable, and color alone fails for color-blind users (WCAG 1.4.1). Applies in our app to: project color pickers, map/plot-plan legends, chart legends, status dots (the word is always there). Check: every color-coded thing has a text label nearby.

IDEAS:
- I: Three planes: huge type behind, the subject in the middle, buttons overlapping on top. Where it could serve us: sign-in screen, project cover/hero, about page, empty states, printed cover sheets. Not on data screens.
- I: A spec eyebrow in small caps above the subject ("OVER-EAR · WIRELESS | 40 H · -32 DB"). Where it could serve us: equipment and tag headers ("PUMP · CENTRIFUGAL | 150 GPM · 450 °F"), document headers ("P&ID · UNIT 20 | REV C · ISSUED").
- I: A tiny label over a value ("PRICE / $249"). Where it could serve us: key fields in detail headers (DUE / Nov 30, OWNER / J. Ortiz).
- I: Reassurance or consequence text inside the primary bar ("Add to bag | Free returns", "Book a session | from $60"). Where it could serve us: "Issue Rev C | notifies 6 people", "Submit | goes to J. Ortiz for review", "Check out | locks for others".
- I: Dot leaders from an item to its time, with times right-aligned. Where it could serve us: shift schedules, the turnaround daily plan, procedure steps with times, run sheets.
- I: Cues styled differently from content (italic cue lines under items: "All stand", "Please be seated"). Where it could serve us: hold points, cautions and permit conditions under procedure steps (in a caution style, not in the action color).
- I: A big date numeral for the next event ("4 / OCTOBER · SUNDAY / Morning gathering, 10:00"). Where it could serve us: next shift, turnaround start, next due date on Home.
- I: A "● WATCH LIVE" live dot. Where it could serve us: running jobs, live shift, a document being edited by someone now.
- I: "Share this video with your AI or developer." Where it could serve us: keep this rulebook where the AI helper reads it.

Not for us: huge decorative type overlapping photos on working screens: it costs legibility and density in an engineering tool. The cream-paper serif church style as-is. Removing the tab bar entirely (church "after"): we need persistent navigation.

---

## ALL RULES FROM MY REELS (deduplicated)

Status and color
1. Status = small colored dot + one word. The word stays in text color, and only the dot is colored. (DfMkz9JB-xC)
2. Color never fills a card, row or pill in a list of many items. 20 items with one error must look calm. (DfMkz9JB-xC)
3. One fixed status vocabulary with fixed colors (green done, amber in progress, red act), the same everywhere. (DfMkz9JB-xC)
4. One signal color that only means "tap this". Everything else is neutral ink and paper, and the signal color is never used for status or decoration. (Dd-o8qwRHYh; reinforced by DfreUkyBNQg "one accent")
5. Color-coded things always carry a word label too (swatches named, legends labeled). (Dd-o8qwRHYh)

Actions and choices
6. Exactly one solid button per screen and per dialog. Everything else is ghost or outline. (DfMkz9JB-xC, Dd-o8qwRHYh)
7. Several create actions share the one solid button as a dropdown ("New ▾"). (DfMkz9JB-xC)
8. Per-item actions live in one "⋯" menu, never a row of icons on every card or row. (DfMkz9JB-xC)
9. Every icon has a word: toolbar icons, bottom-bar tabs and menu items. Tooltips alone are not enough on touch. (DfreUkyBNQg, DfMkz9JB-xC)
10. Show only the 3 to 5 tools or tabs used daily. Hick's law: each doubling of equal choices adds decision time, and 12 icons feel slow. (DfreUkyBNQg)
11. Pick the visible tools from usage data ("count what they tap, not what you shipped"). (DfreUkyBNQg)
12. Rare tools go behind More, one tap away, grouped by job with short headers. (DfreUkyBNQg)
13. Experts get keyboard shortcuts that skip menus, printed next to the action. (DfreUkyBNQg)
14. Don't offer the same action twice on one screen. (Dd-o8qwRHYh)

Content
15. Each item shows what changed last (what, where, when), not a vanity metric or chart. (DfMkz9JB-xC)
16. One key number per hero, not a row of equal stats. (Dd-o8qwRHYh)
17. Monospace only on strings people copy (IDs, hashes, URLs). Names, titles and messages stay sans. (DfMkz9JB-xC)
18. Copyable strings are click-to-copy, and the toast repeats the copied value ("Copied a3f9c21"). (DfMkz9JB-xC)

Type
19. Don't ship the default system-ui stack. Use a face from the product's world (for us: industrial signage, so Barlow). (DfPJo9UBJ7D)
20. Load the font for real (self-hosted woff2, `font-display: swap`) and test it on a machine without the font installed. (DfPJo9UBJ7D)
21. One family, two weights (400 and 700), plus mono only for copyable IDs. (DfPJo9UBJ7D)
22. Four type sizes, never one in between (reels show 14/18/24/40 and 13/16/20/28), with each kind of information on its own step. (DfmTDE1B6uX, DfPJo9UBJ7D)
23. Skip the middle sizes: one thing huge, the rest small. (Dd-o8qwRHYh)
24. "Good morning, <Name>" on a stock layout is a template tell. If kept, it is small and the subject is big. (DfPJo9UBJ7D)

Tokens
25. Every value comes from a token. No hand-typed px, hex or hue names in components. (DfmTDE1B6uX)
26. Colors are named by role (background, surface, text, muted, primary, on-primary), not by hue. (DfmTDE1B6uX)
27. All spacing is a multiple of 4 (4, 8, 16, 24). (DfmTDE1B6uX)
28. Nested radius: outer = inner + padding (24 = 8 + 16). The inner corner is never rounder than the outer. (DfmTDE1B6uX)
29. Two shadows only: small for cards, large for anything that floats (toast, menu, popover, dialog). (DfmTDE1B6uX)
30. Light/dark is a swap of role values, including primary and on-primary, with no per-component overrides. Text on primary passes 4.5:1 in both themes. (DfmTDE1B6uX)

Navigation
31. Jakob's law: put things where users' other apps put them (for us: Outlook, Excel, Explorer and SAP conventions on desktop, and big-app conventions on phones). Don't invent navigation. (DcmoHfNJDWO)
32. Phones: at most 5 bottom tabs, Home far left, Profile far right, Create in the middle. (DcmoHfNJDWO)
33. Settings never in the bottom bar or main nav. It goes top right or in Profile/account. Bottom nav is for core actions only. (DcmoHfNJDWO)
34. Swipe from the left edge = back, so never hijack it. In our standalone PWA, every non-root screen also needs an in-app ← button. (DcmoHfNJDWO)
35. Pull down refreshes lists. Our standalone PWA must provide it itself. (DcmoHfNJDWO)
36. X closes the whole modal or flow. ← goes back one screen. (DcmoHfNJDWO)
37. Tapping the active tab or sidebar item returns to the root or top of that section. (DcmoHfNJDWO)
38. Notifications and shared links open the exact item (document, revision, page, comment), even through sign-in. (DcmoHfNJDWO)
39. Collapsed sidebar keeps active marker, badges (as dots), active project marker and account. Every icon has a tooltip. (DgC6ruhT2NZ)
40. A count badge becomes a dot where the number doesn't fit. (DgC6ruhT2NZ)
41. Long names truncate on one line with an ellipsis, counts stay visible, and the full name shows on hover. (DgC6ruhT2NZ)
42. Search at the top of navigation, with its shortcut printed (⌘K). Account and plan sit at the bottom, apart from nav. Collapse is an explicit control. (DgC6ruhT2NZ)

Loading and state
43. Never a blank screen while loading. Use a skeleton, spinner or progress bar. (DcmoHfNJDWO)
44. Coming back to a list restores the exact scroll position, filters, sort and selection. (DcmoHfNJDWO)
45. Load the next batch before the user reaches the bottom (prefetch or virtualize). (DcmoHfNJDWO)
46. Small personal actions (star, watch, mark read, tick) update instantly and sync in the background with rollback. Controlled-record actions (approve, sign, issue, check-out, transmit) wait for the server. (DcmoHfNJDWO)
47. Autosave drafts and unfinished input, so going back or refreshing loses nothing. On shared PCs, drafts are tied to the signed-in user and cleared on sign-out. (DcmoHfNJDWO, DgDnREtkizp)
48. Ask for notifications, camera, photos or location only when the user starts the feature that needs it. (DcmoHfNJDWO)
49. Phone quick actions open in a bottom sheet that swiping down dismisses. (DcmoHfNJDWO)

Forms and wizards
50. Chunk forms: about 3 fields per step. 12 in a row cause fatigue. (DgDnREtkizp)
51. Split steps by topic, not by count. Each step is named. (DgDnREtkizp)
52. One progress indicator per flow (bar, dots or labels, pick one) plus "Step n of N". Done = check, current = accent, future = gray. (DgDnREtkizp)
53. Validate inside the step, and block Next with a visible reason ("Next is blocked until valid"). (DgDnREtkizp)
54. An error is a red border, an icon in the field and a message under the field that says how to fix it ("Enter a valid email address", not "Invalid format"). Show it on blur or Next, then re-check live as the user types. (DgDnREtkizp)
55. Never show a success ✓ before the value is actually validated or saved. (DgDnREtkizp)
56. Save state on every step change, so Back and Refresh keep all data and the current step. (DgDnREtkizp)
57. Finish with a Review step that lists every answer with an Edit link back to its step. (DgDnREtkizp)
58. Wizard footer: Back (ghost ←) at left and Next (solid →) at right, fixed on every step. (DgDnREtkizp)

## ALL IDEAS FROM MY REELS

- Live in-place status change (Building to Ready) for indexing, uploads and sends. (DfMkz9JB-xC)
- Fixed card anatomy: avatar letter, bold name, mono ID, last-change line, status bottom-left, time bottom-right. (DfMkz9JB-xC)
- ⋯ appears on card hover on desktop, always visible on touch. Hover highlights the card border and copyable IDs. (DfMkz9JB-xC)
- "/" focuses a list's search box, with the hint printed in the box. (DfMkz9JB-xC)
- Company/site switcher at top left. Grid/list toggle as ghost icons. (DfMkz9JB-xC)
- Relative times with the absolute timestamp on hover (audit). (DfMkz9JB-xC)
- Write a screen's decisions as a checklist before building it ("screens first, then code"). (DfMkz9JB-xC, DfPJo9UBJ7D)
- A "Next up" card on Home: eyebrow, bold item, person, time, status. (DfPJo9UBJ7D)
- A day list with a time column and an overflow line ("3 more after 10:30"). (DfPJo9UBJ7D)
- Take the typeface cue from a physical object of the domain (nameplates, title blocks, plant signs). Use the "g" glyph test for font QA. (DfPJo9UBJ7D)
- Build new screens as a gray wireframe, then add tokens in order: color, spacing, type, radius, shadow. (DfmTDE1B6uX)
- Rows on a nested lighter surface instead of outlined rows. Secondary action as plain text beside the primary. (DfmTDE1B6uX)
- Only the finished state tinted ("Done"), other states neutral. (DfmTDE1B6uX)
- Confirmation toast floating with the large shadow after an action ("✓ Update shared"). (DfmTDE1B6uX)
- Exploded-layer diagram as token documentation. (DfmTDE1B6uX)
- Edit-mode header "Cancel · MODE · Done" for markup or inline editing. (DfreUkyBNQg)
- Overflow tools as a 4-per-row tile grid in a titled bottom sheet with a grab handle. (DfreUkyBNQg)
- Selected tool = tinted circle + accent label. Tool bar at the bottom of the phone screen for field viewers. (DfreUkyBNQg)
- Active nav item joined to the content edge so the sidebar points at the page. (DgC6ruhT2NZ)
- Context action rail: per-page quick actions, with the primary fixed in the same spot on every page. (DgC6ruhT2NZ)
- Always-visible page name or breadcrumb as orientation (important without a URL bar). (DgC6ruhT2NZ)
- "Your turnarounds" group in the sidebar with color dot, open count and active highlight. Color squares with marker when collapsed. (DgC6ruhT2NZ)
- Nav ordered by the work cycle, with a chevron on items with children. (DgC6ruhT2NZ)
- Sliding active indicator and staggered label fade on expand, short and respecting reduced motion. (DgC6ruhT2NZ)
- Presence dot on avatars where presence data exists. (DgC6ruhT2NZ)
- Leading icons in fields. Masked secrets ("•••• 4242"). (DgDnREtkizp)
- Per-step color tags (only if they don't clash with status colors). The current step counts toward progress (1 of 4 = 25%). (DgDnREtkizp)
- Cognitive-load meter as a form-review device. (DgDnREtkizp)
- Observe what users spend their day in (Screen Time / Outlook, Excel, SAP) and copy those conventions. (DcmoHfNJDWO)
- Change familiar navigation gradually, with redirects and a "what moved" note (Snapchat 2018 petition, 1.2 million signatures). (DcmoHfNJDWO)
- Alerts/Inbox tab with a red count badge. (DcmoHfNJDWO)
- Three planes (huge type behind, subject, overlapping buttons) for sign-in, project cover, about page, empty states and cover sheets only. (Dd-o8qwRHYh)
- Spec eyebrow in small caps ("PUMP · CENTRIFUGAL | 150 GPM · 450 °F"). Tiny label over value ("DUE / Nov 30"). (Dd-o8qwRHYh)
- Consequence text inside the primary bar ("Issue Rev C | notifies 6 people"). (Dd-o8qwRHYh)
- Dot leaders to right-aligned times in schedules and procedures. (Dd-o8qwRHYh)
- Cue/caution lines styled apart from content under steps (hold points, permit conditions). (Dd-o8qwRHYh)
- Big date numeral for the next event. "● LIVE" dot for running things. (Dd-o8qwRHYh)
- Keep this rulebook where the AI helper reads it ("share this with your AI or developer"). (Dd-o8qwRHYh)

## Conflicts and caveats noticed
- Type scale numbers differ between reels (14/18/24/40 vs 13/16/20/28). The shared rule is "4 sizes, nothing in between". Pick one set for the app.
- DfmTDE1B6uX's animated spacing labels end at 11 and 25 (off its own 4-grid). Follow the spoken 4/8/16/24.
- DgDnREtkizp validates "as you type". The text-input reel says "after blur". Reconciled in rule 54.
- Dd-o8qwRHYh's church "after" uses its signal red for non-tappable text, which breaks its own signal-color rule.
- DcmoHfNJDWO's "79 patents" and "Snapchat 1.2 million petition" are the creator's claims and unverified.

## Not for us (summary)
- Glass, starfield and gradient sidebar surfaces; dock-style hover magnification; upsell "Go Pro" cards (DgC6ruhT2NZ).
- Huge overlapping display type on data screens; removing persistent navigation (Dd-o8qwRHYh).
- Optimistic updates for controlled-record actions (DcmoHfNJDWO rule 11 applies only to small personal actions).
- `localStorage` drafts shared across users on plant PCs (DgDnREtkizp).
