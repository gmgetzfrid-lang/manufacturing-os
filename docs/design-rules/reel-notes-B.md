<!-- Per-reel notes, batch B. Source for docs/design-rules.md, which holds the merged, settled rules. -->
# Rulebook, batch B: 7 reels

All seven are by "UX Patterns · Design + Motion" (@designmotionhq), dark UIs with one teal/mint/gold accent, posted Oct 16 to Nov 20, 2026. Six of them end with an ad for the creator's paid Claude Code plugin "UX Engine" (/ux-audit, /restyle, /ux-design, /ux-review, $79). I ignored the ad claims except one useful statistic (noted under Deq_kvJBI3g).

How I read them: caption, transcript, contact sheet, the 12 to 16 batch frames, plus full-resolution frames I cut every 2 to 3 s and read side by side. My frames are in

"Our app" below = Manufacturing OS: Documents (libraries, drawings, check-in/out, viewer), Drafting requests, Projects/turnarounds (Plan, Shift reports, steps, costs, hours), Operating areas (units, equipment, tags), Intelligence/Ask, Transmittals, Admin, Settings/notifications. Used on desktops and on phones in the unit.

---

### DejRN2Oh3p0: Five rules for a folder tree you can read four levels deep (@designmotionhq, 55 s, Oct 16 2026)
What it shows: A code-editor file explorer ("EXPLORER · orbit-app") opened four levels deep (`src / app / billing / invoices` > InvoiceRow.tsx; chips "guides: 4 · depth: 4 · InvoiceRow.tsx"). It gives five numbered rules. Each puts a struck-through wrong version next to the fix: indent + guides, rotating chevron, arrow keys, lazy children, spring-loaded folders. Post text: "Four folders deep and still not lost. Five tree rules."
Best frames: rulebook-frames/DejRN2Oh3p0/t9.jpg (8 px vs 16 px + guides), p2.jpg (rotate vs icon swap), p4.jpg (arrow keys), p5.jpg (skeleton children vs "tree locked"), p10.jpg (spring-load timer 33 ms → 233 ms, chained), p7.jpg (insertion line), p8.jpg ("moved").

RULES:
- R: Every nesting level is indented by the same fixed step, 16 px. The "8px, no guides" version is struck out. Why: at four levels you can't count small gaps ("A step per level, a line per folder"). Applies in our app to: every nested list: library/folder trees, Operating areas (unit > system > equipment > tag), project WBS (phase > area > step), nested comments/markups, permission trees, grouped sidebar. Check: in DevTools, measure the x position of the label at depth 1, 2, 3 and 4. Each step must be the same 16 px, and no level may use a different step.
- R: A thin (1 px, neutral) vertical guide line drops from every open folder and runs the full height of its children. The guide of the branch that holds the selected item turns accent. Why: "Four levels down, you follow the line instead of counting gaps." Applies in our app to: the same trees. Check: open four levels and select a leaf. Exactly one guide (its parent's) is accent and all others are neutral. Each guide lines up under its parent's chevron.
- R: To open or close, rotate ONE chevron 90° (right → down) with `.chevron { transition: rotate 180ms }` / `rotate(90deg)`. Never swap two icons: `<ChevronRight /> : <ChevronDown />` is struck out with "icon swap: two glyphs, the eye jumps". The folder icon doesn't change either (the same outline folder whether open or closed). Why: "The icon never swaps, so the eye stays put" / "same glyph, eye stays put". Applies in our app to: tree nodes, accordions, collapsible sidebar groups (Work / Admin), expandable table rows, "show more" sections, collapsible filter panels. Check: grep for conditional ChevronRight/ChevronDown (or ChevronUp/ChevronDown) pairs and Folder/FolderOpen pairs. Every disclosure should be one icon with a rotate class and a 150 to 200 ms transition, with no motion under prefers-reduced-motion.
- R: The whole tree works from the keyboard ("The whole tree, no mouse", "mouse: not needed"). → opens a closed folder, ← closes an open one, ↑/↓ move between visible rows, the focused row gets a full-width accent outline, and the markup is `role="tree"` + `aria-expanded`. The standard WAI-ARIA tree pattern adds more, partly shown in the reel (focus jumps from "billing" up to "app"): → on an open folder moves to its first child, ← on a closed folder or a file moves to its parent, Home/End go to the first/last row, Enter opens the item, typing a letter jumps to the next match, and the whole tree is ONE Tab stop (roving tabindex). Why: "so you never reach for the mouse." Applies in our app to: document/drawing trees, the equipment hierarchy, any navigator list. Desktop engineers work from the keyboard. Check: Tab once into the tree, then open, close, move and open a file using only the arrow keys and Enter. A screen reader announces "expanded/collapsed, level N".
- R: A large folder fetches its children only when it is opened. While it loads, 3 skeleton rows (icon block + text bar, varied widths) hold the place under that folder, and the folder row shows a "fetching" chip. Everything else stays clickable ("still usable"). Never put one spinner over the whole panel ("tree locked · One spinner over the whole panel · every click waits for 1,284 items", struck). Why: "Skeleton rows hold their place underneath, while the rest of the tree stays usable." Applies in our app to: libraries with thousands of drawings, unit equipment lists, revision histories, large project step lists, any lazy sub-list. Check: throttle the network to Slow 3G, open a big folder, and at once click a different folder. It must open. There is no full-panel overlay.
- R: Spring-loaded folders: while dragging, hover a closed folder and wait ("hover a closed folder → wait 600ms → drop deeper"), and it opens. This chains: "components" opens, then "components/invoices" opens under it. A circular timer fills around the chevron with a ms readout (33 ms … 233 ms). Leaving before 600 ms cancels. Why: "After a short pause, it springs open, so the file drops deeper without letting go." Applies in our app to: moving drawings/documents between folders and libraries, moving steps between phases, regrouping equipment. Check: drag a file over a closed folder and hold. It opens at about 0.6 s. Move off sooner and nothing opens.
- R (shown on screen, standard drag-and-drop practice): Drag feedback must show where the item came from, what will happen and where it will land. The source row stays in place, dimmed. The drag ghost names the item and the operation ("InvoiceRow.tsx · move"). An accent insertion line (dot at its left end, indented to the target depth) shows the exact drop spot. After the drop, the item is highlighted at its new place with a short "moved" chip. Applies in our app to: every drag (file into folder, reorder steps, assign work to a crew, reorder slides). Check: during any drag you can see the dimmed source, the operation and the insertion line. After the drop the new position is highlighted.
- R (standard I added, not in the reel): every drag has a way to do the same thing without dragging, such as a "Move to…" menu item or keyboard cut/paste (WCAG 2.2 SC 2.5.7 Dragging Movements). Why: dragging is unreliable on phones and impossible from the keyboard. Applies in our app to: the same drags. Check: every draggable item has a menu action that does the same thing.

IDEAS:
- I: A mono breadcrumb above the tree with the current segment in accent ("src / app / billing / invoices"), plus a depth chip. Where it could serve us: document viewer header (Library / Unit 20 / P&IDs / drawing no.), equipment page (Unit / system / tag).
- I: A size chip on a closed folder ("node_modules · 1,284 items") so people know what they are opening. Where it could serve us: libraries, folders, units, phases ("235 steps").
- I: On expand, a short connector draws from the chevron down into the guide line, tying children to their parent. Where it could serve us: any tree expand animation (reduced-motion off).
- I: A status chip on the node during async work ("fetching" → "loaded"). Where it could serve us: folder sync, OCR/indexing state of a library or folder.
- I: Hover/selected row tint that differs from the keyboard focus outline (focus ≠ selection). Where it could serve us: trees and tables.
Not for us: nothing.

---

### Del2E8Ah8bi: Five fixes for a chart that lies (@designmotionhq, 53 s, Oct 17 2026)
What it shows: A dark analytics dashboard, "Pulseboard" (tabs Overview / Revenue / Customers). The opener compares two bars, 925 vs 1,000. With "y from 900 · truncated axis" the badge reads "+300%". With "y from 0 · honest axis" it reads "+12%". Then come five fixes, tracked by a 5-dot checklist (zero · accent · labels · table · notes) whose dots tick green. Post text: "Your dashboard chart is lying. Five fixes, zero new data."
Best frames: rulebook-frames/Del2E8Ah8bi/p1.jpg (+300% vs +12%), p2.jpg/p3.jpg ("W8 / W3 4x" vs "1.08x"), p4.jpg (rainbow vs Pro teal), p5.jpg/p6.jpg (legend trips vs direct labels, 12 lines), p7.jpg ("readable up to 5", "or small multiples"), p11.jpg (sortable table), p9.jpg (annotation, "Answered on the chart").

RULES:
- R: Bar (and area) charts start at zero. Why: "The sign-up bars start at 90, so a small gain looks three times bigger. Bars compare length, so the axis goes to zero and the gap shrinks." With the axis at 90 the measured W8/W3 badge reads "4x"; at zero it reads "1.08x". Applies in our app to: every bar/column chart: cost by phase, hours by crew, documents per library, requests per week, overdue counts. Check: every bar chart's value axis minimum is 0 (grep chart configs for domain/min/`dataMin`), and the baseline is labeled 0.
- R: Line charts may skip zero only if the chart says so (footnote chip "line charts: may skip zero, label it", e.g. "y from 900"). Applies in our app to: zoomed trend lines (pressure, temperature, % complete S-curves). Check: any line chart whose axis doesn't start at 0 shows a visible "y from X" note or axis break.
- R: The headline change is computed from the values and is never an impression created by the axis ("+300%" on a truncated axis vs "+12%" honest). When two bars are compared, show the measured ratio ("W8 / W3 1.08x"). Applies in our app to: KPI deltas above charts, "vs plan / vs baseline" figures. Check: recompute every displayed delta from its underlying numbers.
- R: One accent colour goes on the series that matters. Every other series is neutral gray and thinner ("Five plans, five colors" tagged "rainbow" → "Pro teal, the rest grey"). Why: "Five plans get five bright colors, so nothing stands out. You make the pro plan teal and the rest gray, so the eye lands there." Applies in our app to: planned vs actual (actual = accent, plan = gray), this unit vs the others, our crew vs contractors. Check: each chart has at most one saturated hue, plus red only where it carries a real alarm/overdue meaning.
- R: Name each line at its right end, in the line's own colour (the accent label in bold), with no legend box ("Every line costs a trip", chip "trips: 5" → "Name the line where it ends", "trips: 0"). Why: "With a legend box, every line costs a trip down and back." Applies in our app to: every line chart with up to 5 series. Check: no legend under or beside line charts, and the end labels don't overlap (nudge them apart).
- R: Past 5 series, stop drawing lines ("12 lines, 0 answers", tag "12 series", chip "readable up to 5"). Switch to a sortable table (Customer, Usage, a sparkline "Trend" column, Change) or to small multiples (one mini chart per item; offered on screen as "or small multiples"). Why: "Twelve customers on one chart become spaghetti nobody can follow." Applies in our app to: hours per contractor, cost per work order, progress per crew, documents per unit, AI usage per user. Check: no chart renders more than 5 series.
- R (shown in the table): the sorted column is marked (accent header + ↓ arrow), numbers sit in tabular/mono figures right-aligned, and changes are signed ("+41%", "-9%"). Applies in our app to: every data table. Check: `aria-sort` on the sorted header, numeric columns `text-right` + tabular-nums, and every change has a sign.
- R: Put the reason for a spike on the chart itself. The peak bar turns accent, and a short callout with a leader line sits on it ("Launch day, Product Hunt"). Why: "Sign-ups spike on Tuesday and the team starts guessing why. A short note on the peak says launch day, so nobody has to ask." The comment thread ("why the jump on Tuesday?", "bot traffic maybe?", "tracking bug again?", "Comments · 3 open") becomes "Comments · 0 open · Answered on the chart · 0 questions". Applies in our app to: shift-report and progress charts (discovery on E-101, weather hold, permit delay), cost jumps (change order), document spikes (bulk upload), intelligence usage. Check: chart components accept annotations, and known events in the data appear on their point.
- R (shown on every chart; standard): every chart states what it measures, the unit and the scope in a subtitle, and shows its time window as a visible control. Examples: "Weekly signups · All plans · per week · [Last 8 weeks]", "Revenue by plan · MRR in $k · [Last 12 months]", "Usage by customer · 12 customers · API calls", "Daily signups · Week 41 · all sources · [This week]". Applies in our app to: every chart and KPI strip. Check: each chart has a title, a unit/scope line and a period.
- R (shown; standard): a change in a rate is given in percentage points, a change in a count in percent: KPI tiles "Signups 1,000 +8%", "Activation 41% +2 pts", "Trials 312 +5%". Applies in our app to: % complete, schedule adherence, on-time %, first-pass approval %. Check: any delta on a % metric is written "pts" (or "pp").

IDEAS:
- I: Put a value label on the one highlighted bar only (450 / 412), not on every bar. Where it could serve us: the overdue or hours-late peak.
- I: When a series is the accent, its legend/filter chip turns accent too (the "Pro" chip lights up), linking filter and line. Where it could serve us: chart filters on project dashboards.
- I: Keep the discussion with the chart: a comment count under it that drops to "0 open · answered on the chart". Where it could serve us: shift report charts, turnaround daily meeting dashboard.
- I: A sparkline per table row. Where it could serve us: projects list (progress trend), libraries (upload trend), crews (hours trend).
- I: A checklist of labeled dots that turn into ticks ("zero · accent · labels · table · notes"). Where it could serve us: project close-out, setup checklists, review gates.
Not for us: nothing.

---

### Deq_kvJBI3g: Your dashboard breaks on a phone: five spots at 375 px (@designmotionhq, 57 s, Oct 19 2026)
What it shows: A dark programme-portfolio app (Portfolio, Change requests, Billing) in an iPhone frame at 375 px. The opener flags "page 786px / screen 375px". Five fixes: tables → cards, big numbers on one line, 16 px inputs with the right keyboard, 44 px targets on touch only, and safe area under a fixed bottom bar. The ad card shows the useful statistic: "At 375px, 8 app screens x 3 runs · Inputs that zoom on iOS: UX Engine 2.3 0% · Claude alone 53%". Post text: "Your app fits the laptop. On a 375px phone, five things break."
Best frames: rulebook-frames/Deq_kvJBI3g/p1.jpg (786 vs 375), p3.jpg (table vs cards), p5.jpg (48 px wraps vs 30 px one line), p6.jpg/p7.jpg (14 px zoom vs 16 px + numeric keypad), p8.jpg/p9.jpg (28 px missed vs 44 px on coarse only), p10.jpg/p11.jpg (bar hides last row vs safe area).

RULES:
- R: Check every screen at 375 px ("Checking every screen at 375px"). The page is never wider than the screen; the opener flags "page 786px / screen 375px". Why: anything past the edge hides behind a sideways swipe. Applies in our app to: every route, including admin pages, viewer chrome, project tabs and wizards. Check: DevTools 375×812, and on each route `document.documentElement.scrollWidth <= window.innerWidth`. Only explicit inner scrollers (a drawing, a wide Gantt) may scroll sideways, and they must look scrollable.
- R: Under 640 px, each table row becomes a card ("Under 640px: cards", chip "< 640px : cards"). Never "6 columns in 375px", where status and deadline hide behind a swipe. Card anatomy: line 1 is the mono ID · short code ("CR-0142 · HEL") with the status pill top-right; line 2 is the bold title; then come 2 or 3 label/value rows, label left in muted text and value right-aligned ("Needed by · 5 Oct · overdue" in red with the word, "Cost · +€18,000", "Approver · Amara Okafor"). Why: "Your table keeps every column on a phone, so status and deadline hide behind a swipe." Applies in our app to: Drafting requests, Projects, library/document tables, Transmittals, Admin users, equipment lists, shift step lists. Check: at 375 px every list shows ID, status, due date and owner without horizontal scroll.
- R: Big figures stay on one line: `.kpi-value { white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 30px; /* max ~30px */ }` on phones. At 48 px "+€5.3M" wrapped and left the "+" alone ("+ alone", "48px · wraps" vs "30px · one line"). The sign, currency, number and suffix never split. Why: "In a narrow card, a big figure wraps, so its plus sign lands alone. Keep amounts on one line and shrink big figures on phones." Applies in our app to: hero/KPI stats (hours late, 235/235 steps, overdue counts, costs, budgets) and totals in tables. Check: at 375 px no KPI value wraps, and the KPI classes have nowrap + tabular-nums + a phone size cap.
- R: Every field uses 16 px text on phones ("Under 16px, iOS zooms in"; "font-size: 14px" flagged; "✓ 16px : no zoom"). Why: "When input text is under 16 pixels, Safari zooms the page as you tap." Applies in our app to: EVERY input, select, textarea and contenteditable: search boxes, table filters, inline cell editors, date/time pickers, the Ask/chat box, comment boxes, sign-in, signature name fields. Check: on iPhone Safari (or the Xcode simulator) tap each field type. The page must not zoom, and the computed font-size is ≥ 16 px under the phone/touch media query.
- R: Each field gets the right keyboard, autofill and Enter key ("16px, and the right keyboard"): `inputmode="numeric"` (the card number opens a number pad), `autocomplete="cc-number"`, `enterkeyhint="next"`. Why: "Use 16 on phones with the right keyboard per field." Applies in our app to: hours/quantities (`decimal`), tag and drawing numbers, phone, email, one-time code, search (`enterkeyhint="search"`), and the last field of a form (`enterkeyhint="done"`/`"send"`). Check: grep inputs for inputMode/autoComplete/enterKeyHint. On a phone, each numeric field opens a number pad and Enter moves to the next field.
- R: Touch targets are at least 44 px on touch screens only: `@media (pointer: coarse) { min-height: 44px }` ("Thumbs miss 28px buttons", "28px : missed"; Touch · pointer: coarse "min 44px"). A mouse (`pointer: fine`) keeps the dense layout ("stays dense"). Why: "A thumb misses small buttons, so touch screens get 44 pixel targets. A mouse keeps the dense layout because the rule only applies to touch." Applies in our app to: buttons, icon buttons, row "…" menus, tabs, chips, checkboxes, pagination, toolbar icons in viewers. Check: with a coarse-pointer emulator, every control's hit area is at least 44 px; on desktop nothing changes size.
- R: A fixed bottom bar pads itself with the safe area (`padding-bottom: env(safe-area-inset-bottom)`), and the scroll content gets bottom padding at least as tall as the bar ("Safe area, and room below"), so the last row can scroll clear of it ("The bar hides your last row", `position: fixed; bottom: 0;` flagged). Why: "A fixed bottom bar slides under the home indicator so it covers your last row." Applies in our app to: bulk-action bars ("2 selected · Approve selected"), sticky Save/Submit bars, mobile tab bar, shift-report submit. Check: on an iPhone, scroll to the end. The last card is fully above the bar and the buttons sit above the home indicator. Note: env(safe-area-inset-*) is 0 unless the page opts in with `viewport-fit=cover`. app/layout.tsx's `viewport` export has no `viewportFit` today, although components (e.g. components/ui/PageHero.tsx) already use env(safe-area-inset-bottom). Test in Safari and in the installed PWA.

IDEAS:
- I: A sticky bulk-action bar with a count ("2 selected · Approve selected"), and a check badge on each selected card. Where it could serve us: drafting requests, document approvals, step sign-off.
- I: A list summary line "12 waiting · 1 past needed-by" with only the overdue part in red. Where it could serve us: headers of requests, projects and document check-outs.
- I: KPI tiles always carry context under the number: "2 of 6 programmes", "2 on track", "net on €199.7M budgeted", "past the needed-by date". Where it could serve us: Home/project stat tiles ("43.5 h late vs plan", "1 of 235 steps open").
- I: Format the value while typing ("4242 4242 42") and scroll the focused field above the keyboard. Where it could serve us: long tag, drawing and PO numbers on phones.
- I: A problem banner names the object and its state: "Visa ending 4242 · expired 09/26". Where it could serve us: expired training/certificates, superseded revisions, expiring permits.
- I: A filter select at the top of the phone list ("All programmes") instead of a filter row. Where it could serve us: requests by unit, projects by site.
- I (evidence, not design): the ad's own test says 53% of inputs written by Claude without the plugin zoomed on iOS. Enforce 16 px globally in CSS, not form by form.
Not for us: nothing.

---

### DewJMeuBL_s: Permission prompt mistakes: you get one real shot at Allow (@designmotionhq, 54 s, Oct 21 2026)
What it shows: A dark habit/medication app, "Streakly", on an iPhone, with five mistakes and a counter ("mistake 1/5 · fix: ask after / own card first / say the gain / link to Settings / one at a time"). Post text: "Your app gets one real shot at Allow."
Best frames: rulebook-frames/DewJMeuBL_s/p2.jpg + p3.jpg (Welcome "ask here? no" vs Saved "ask here"), p4.jpg (your card vs system dialog, "still available"), p6.jpg/p7.jpg ("says nothing" vs "says the gain", "✓ Reminders on"), p8.jpg/p9.jpg (dead end vs "Open Settings >", "1 tap to Settings"), p10.jpg ("3 asks, 0 context" vs "1 ask, right after Scan", "Opening camera").

RULES:
- R: Never ask for a permission at first launch ("1 · Welcome · ask here? no"). Ask right after the user does the thing that needs it ("3 · Saved · ask here", just after saving "Drink water · 8:00 PM · every day"). Why: "On first launch, you have no reason to allow anything yet. Ask right after you set your first reminder, when the feature needs it." Applies in our app to: browser push notifications, camera (nameplate/drawing photos), geolocation (unit location, field check-in), microphone (voice notes), the PWA install prompt, persistent storage/offline. Check: in a fresh browser profile no page triggers a prompt on load. Grep `Notification.requestPermission`, `getUserMedia`, `geolocation`, `beforeinstallprompt`, `navigator.storage.persist`; each must run only inside the click handler of its feature.
- R: Show your own card first (a soft ask), and call the system prompt only after a yes on that card. Why: "Show your own card first, because a no there costs nothing. On Apple phones, a no on the system dialog means the app can never ask again" (screen: "system prompt: still available" vs "system prompt: used" with a lock). Browsers also block sites after repeated dismissals. Applies in our app to: the same. Check: the system API is only called from the card's "Turn on" handler, and "Not now" never calls it.
- R: The ask names the concrete gain, with specifics: "Get a reminder at 8 pm · Drink water, every evening", not "We'd like to send you notifications · Stay up to date" (tagged "says nothing"). The buttons are "Not now" (soft; no "Never", no guilt) and "Turn on" (the result, not "Allow"). Why: "A vague line about notifications gives you no reason to tap allow, so you dismiss it." Applies in our app to: every opt-in (email digests, push, location, camera, AI features). Check: each prompt says what the user gets and when, and its buttons are "Not now" / a verb naming the result.
- R (shown): confirm the result in place. After "Turn on", the card's button becomes "✓ Reminders on". Applies in our app to: any opt-in or toggle made from an inline card. Check: after accepting, the same spot shows the new state; no silent success.
- R: When a permission is off or denied, the feature stays visible but disabled, with the reason and a one-tap fix. The "Drink water 8:00 PM" row keeps its grayed toggle, the line "Notifications are off" and "Open Settings >", which lands on the app's own notification settings ("1 tap to Settings"). Never an empty page ("Notifications are off. You won't get reminders." tagged "no way back"). Why: "If you refused, the reminder toggle stays visible, but disabled. A link next to it opens settings, so the feature is never a dead end." Applies in our app to: anything blocked by a permission, role, missing configuration (no AI key), offline state, library access or email being off. Check: deny each permission and remove each prerequisite. The feature still shows, says why, and offers the one action that fixes it (or names who can).
- R: One request at a time, each tied to the tap that needs it. The camera prompt comes only after tapping "Scan" ("1 ask, right after Scan"), never bell + location + camera at launch ("3 asks, 0 context, 3 denied"). Why: "The camera prompt waits until you tap scan. Each request comes alone, right after you ask for the feature." Applies in our app to: the same. Check: no flow shows two permission prompts back to back.
- R (shown; standard feedback rule): give instant feedback at the control for a slow action. After tapping Scan, an inline spinner and "Opening camera" appear right under the button. Applies in our app to: opening the camera, starting uploads, generating a transmittal/PDF, running an Ask query, syncing. Check: every action that takes more than about 300 ms shows inline progress at the control within about 100 ms.

IDEAS:
- I: The notification itself carries progress: "Drink water · 8:00 PM · Glass 6 of 8, keep the streak." Where it could serve us: "Shift report due 06:00 · 3 of 5 sections done", "KE-DDRT-26-0004 picked up by drafter".
- I: Say what the camera is for, right above the button: "Fill it in from the box" + [Scan], and the scan fills "Vitalex 500 · 30 tablets". Where it could serve us: "Fill it in from the nameplate" on equipment forms, scan a drawing title block or a permit.
- I: The soft-ask card sits inline at the bottom of the current screen (thumb reach), not in a modal. Where it could serve us: notification opt-in after the first drafting request.
- I: Treat the one-shot system prompt as a budget, spent once at the best moment.
Not for us: nothing. It's a phone habit app, but the rules apply as they are to our PWA.

---

### Df-drL4jt7Z: The perfect proportions: one ratio (1.618) for spacing, layout and type (@designmotionhq, 60 s, Nov 20 2026)
What it shows: Near-black with a gold accent and burned-in captions. A BEFORE/AFTER wireframe card; a golden rectangle (494 px / 306 px, then 188/118) with a spiral and tags "seashells", "galaxies". Then three panels. "SECRET 01 SPACING SCALE, Multiply by 1.618": 8 base, 13 small, 21 medium, 34 large, 55 x-large, with RANDOM 12/7/20/5 px vs GOLDEN 8/13/21/13 px. "SECRET 02 LAYOUT PROPORTIONS, Split at the golden ratio": 61.8% CONTENT / 38.2% ACTIONS. "SECRET 03 TYPE SCALE, Each step multiplied by 1.618": 16 BODY / 26 SUBHEADING / 42 HEADING / 68 DISPLAY. The voice-over claims "Your brain is literally wired to find it beautiful", "This is why Apple product pages feel so effortless" and "Stripe, Linear, Airbnb. They all use this exact scale". These are unverified marketing; I don't believe those products use 16/26/42/68.
Best frames: rulebook-frames/Df-drL4jt7Z/p5.jpg (random vs golden gaps), p7.jpg (61.8/38.2), p9.jpg (type scale).

RULES:
- R: Every gap comes from one spacing scale whose steps are clearly different (reel: 8 / 13 / 21 / 34 / 55, each ×1.618), with no one-off values (RANDOM: 12, 7, 20, 5 px). Why: "Every gap follows this natural scale. Random padding becomes rhythm." Applies in our app to: all padding, margins, gaps and section spacing. The rule is "one scale"; our 4 px grid tokens can be that scale. Check: grep arbitrary spacing (`p-[`, `gap-[`, `m[trblxy]?-[`, `space-y-[`) and count the distinct spacing values in use. Every value should map to a token.
- R (shown in the GOLDEN card; Gestalt proximity): gaps inside a group are a smaller step than gaps between groups (8 px title → subtitle, 13 px between sibling cards, 21 px between sections). Applies in our app to: label → field vs field → field, inside a card vs card → card, section header → content vs section → section. Check: on any screen the within-group gap is a smaller token than the between-group gap, never equal.
- R: Every font size comes from one type scale with few, clearly different steps (reel: 16 body, 26 subheading, 42 heading, 68 display). Body text is 16 px. Applies in our app to: all text. Check: count the distinct font sizes in code (Tailwind `text-*` and `text-[..px]`) and aim for 6 tokens or fewer.

IDEAS:
- I: A 61.8 / 38.2 split puts content on the wide side and actions on the narrow side. The narrow column holds a nav list (active item = accent dot + accent text + faint tinted background; inactive items have gray dots) with the primary button ("Upgrade") pinned to its bottom. Where it could serve us: on desktop, document detail (preview 62 / metadata + actions + history 38), drafting-request detail, shift page (report 62 / actions 38).
- I: Font weight rises with size (regular body → semibold subheading → bold heading/display). Where it could serve us: type tokens.
- I: The AFTER card has more outer padding, and its gray button becomes one full-width accent primary at the bottom. Where it could serve us: cards and dialogs.
- I: Use a big ratio (~1.6) for the large jumps (body → page title → hero number) and a gentle ~1.2 step for the small UI sizes a dense tool needs (12/13/14/16). Where it could serve us: type tokens.
Not for us: the literal 68 px "display" and 42 px heading sizes on working screens. They conflict with a dense engineering tool and with Deq_kvJBI3g's phone rule (cap big figures at ~30 px), so keep them for rare marketing/hero pages. The 13/21 px steps are also off our 4 px grid: adopt the principle (one scale), not the numbers.

---

### Df4WVGIBO2k: The perfect text input: six rules (@designmotionhq, 62 s, Nov 18 2026)
What it shows: A dark background, teal accent, a "0/6 … 6/6" counter, and code captions (red = wrong, teal = right). The opener is a field with only a placeholder "Email", captioned "label: none", "border: 1.3:1". Six rules follow, then the ad. Post text: "The component your users touch most is probably the one that looks cheapest. Six rules for an input field, with the numbers: visible label, 44px and 16px, a real focus ring, a 3:1 border, errors after blur, the right keyboard."
Best frames: rulebook-frames/Df4WVGIBO2k/p1.jpg (label: none, 1.3:1), p3.jpg/p4.jpg (44/16 vs 14 px zoom), p5.jpg/p6.jpg (shade-only vs 2 px ring + 2 px offset), p7.jpg (#3F3F46 1.9:1 vs #71717A 4.1:1), p8.jpg/p9.jpg (typing no error → "Enter a valid email"), p10.jpg (type="email" keyboard).

RULES:
- R: Every field has a visible label outside (above) it, tied to the field (`<label for="email">Email</label>`). The placeholder is not a label: "A placeholder disappears the moment you type, so it is not a label" (typing "name@" shows "hint gone"; the outside label shows "label stays"). The placeholder only shows an example value ("name@example.com"). Applies in our app to: all forms (new drafting request, shift report fields, project wizard, admin invite, company contacts, settings) and inline table editors. A search box with an icon may show no visible label, but it still needs an accessible name (`aria-label`); a placeholder alone is not enough. Check: axe/Lighthouse "form elements must have labels" reports 0 issues, and no input's only text is its placeholder.
- R: Fields are 44 px tall with 16 px text ("height: 44px", "font-size: 16px"). "Below 16, Safari on iPhone zooms the whole page on focus" ("font-size: 14px" flagged, "14px: zoom"). Applies in our app to: every field on phones/touch; desktop may stay denser (see Deq_kvJBI3g). Check: the same as the 16 px check above, plus field height ≥ 44 px under the coarse pointer.
- R: Focus shows a 2 px ring in the accent colour with a 2 px gap (`outline: 2px solid teal; outline-offset: 2px;`, "2px ring, 2px offset"). A border that only changes shade (`:focus { border-color: #71717A }`, "border: shade only") is not enough. Why: "A border that only changes shade is easy to miss." Applies in our app to: every focusable control. Check: Tab through each page and every focused control shows the ring; grep `focus:outline-none` / `outline: none` without a replacement ring.
- R: At rest, the field border has at least 3:1 contrast against its background ("WCAG 1.4.11: 3:1 minimum"). On the near-black surface, #3F3F46 is 1.9:1 and fails; #71717A is 4.1:1 and passes. The opener's field is 1.3:1. Why: "A field you can't see won't get clicked." Applies in our app to: input/select/textarea borders, checkbox and radio outlines, toggle tracks, segmented controls, in the light AND dark themes. Check: measure the border token against each surface token it sits on, in both themes.
- R: Validate on blur, never while typing. While typing "name@exa", the field keeps its accent focus ring ("typing: no error"). After the user leaves it, the border turns red and "(!) Enter a valid email" appears under the field with an icon, linked with `aria-describedby="email-error"` (`onBlur={validate}`). The message says how to fix it ("Enter a valid email", not "Invalid"), and colour is not the only signal (icon + text + border). Why: "The border turns red only after the user leaves the field, never while typing." Applies in our app to: every validated field. Check: type a partial value and nothing turns red; Tab away and you get red border + icon + message; a screen reader reads the message when the field is focused.
- R: Set the right `type` and `autocomplete` ("like email or one-time code"). `type="email" autocomplete="email"` adds the @ and . keys, unlike `type="text"`. Why: "The keyboard and autofill do half the work." Applies in our app to: email, tel, url, `one-time-code` (2FA), name, organization, `current-password`/`new-password`, and numbers (`inputmode`). Check: grep fields by purpose. On a phone each opens its keyboard, and password managers fill sign-in.

IDEAS:
- I: Run these six rules as an automated audit (the creator sells it as "/ux-audit"). A test could flag inputs with no label, text under 16 px, no focus ring, a border under 3:1, validation on change, or a missing type/autocomplete. Where it could serve us: a CI check over all forms.
- I: A standard error wording pattern, "Enter a valid …" (an imperative that says the fix). Where it could serve us: all form errors ("Enter a tag like P-2001").
Not for us: nothing.

---

### Df9fWE8hcgI: Your third color looks cheap: 60/30/10, count the accent, tint the grays, blur test (@designmotionhq, 56 s, Nov 20 2026)
What it shows: Dark UIs with a teal accent, steps "1/5 … 5/5". The opener shows swatches #14B8A6 teal + #3F3F46 gray + an orange ("Shrink it."). Then: the "Pulseboard" dashboard with a 60/30/10 bar; the "Ledgerly" finance card going from 40/30/30 to 60/30/10; the "Night Drive" music player going from 7 accent elements to 2; the "Streakly" card at #18181B (0% tint) vs #16201F (4% teal); and a Settings screen blurred, "confetti" vs three flat zones. Post text: "Two colors that match. Then a third one shows up at the same size, and the whole screen looks cheap. The fix is a ratio, a count and a blur test."
Best frames: rulebook-frames/Df9fWE8hcgI/p3.jpg (60/30/10, New report turns teal), p4.jpg/p5.jpg (40/30/30 → 60/30/10), p7.jpg (7 → 2 accents), p8.jpg (#18181B vs #16201F), p10.jpg/p14.jpg (confetti settings vs three zones).
Correction to the earlier notes: the untinted gray on screen is #18181B, not #181818.

RULES:
- R: Colour by area, 60 / 30 / 10: about 60% neutral background, 30% secondary surface (cards, sidebar), 10% accent. "That 10 is for the one action on the screen" ("Ten is for one action": "+ New report" goes from gray to solid teal). Applies in our app to: every page (page background, sidebar/nav, cards/tables, the one primary button). Check: blur a screenshot (see the last rule). The accent area is small and sits on the main action.
- R: No third colour at the same weight. "Two colors that match can turn cheap when a third gets the same weight" (Ledgerly: orange header + teal cards = 40/30/30). "Shrink the third to 10% or drop it." The orange survives only as the small "↗ +2.4%" pill. Applies in our app to: coloured header bands, coloured stat tiles, a coloured nav next to coloured buttons. Check: a screen with two or more saturated hues that each cover a large area fails.
- R: Count your accent: "If the primary color sits on more than three elements per screen, nothing stands out anymore" ("Count your accent. Three max."). In the example, 7 drops to 2: the title, heart, shuffle, previous and next go neutral, and the progress bar and play button stay accent. Applies in our app to: nav active states, links, icons, badges, buttons, progress bars, count bubbles. Check: count the elements in the accent hue per screen; there should be 3 or fewer.
- R (shown in the blur test; standard): secondary and destructive buttons are neutral, never a second saturated fill next to the primary. Before: a pink "Reset" + a blue "Save changes" = "confetti"; after: a gray ghost "Reset" + one teal "Save". Titles go neutral too ("Settings" in blue, "Night Drive" in teal → text colour), as do list icons and decorations (red/purple/blue/orange/green icon tiles, an orange count badge, a pink "New" pill, a rainbow storage bar, a red "on" toggle). Applies in our app to: dialog and form footers (Cancel/Reset/Delete vs Save), settings lists, page titles, nav icons. Check: each dialog or footer has exactly one filled accent button, and page titles are in the text colour.
- R: Tint the grays about 4% toward the accent hue: "Mix about 4% of the accent hue into the neutral so the screen feels warm or cool on purpose" (#18181B "0% tint" → #16201F "4% teal", chips "warm"/"cool"). Applies in our app to: the page background, surfaces, borders and muted text in both themes. Check: the neutral tokens are defined as a color-mix with the brand hue (or as hand-picked tinted values), and components use no raw #000/#111/#808080-style grays.
- R: Blur test: "Blur the screen and you should see three flat zones. 60, 30, 10. Not confetti." Applies in our app to: every main page, as a review step. Check: screenshot each main page, apply about 20 px of Gaussian blur, and look. You should see 3 zones or fewer, with one small accent zone.

IDEAS:
- I: A draggable before/after divider for comparing tint choices. Where it could serve us: workspace brand-colour settings (if admins can set one), design reviews.
- I: The third colour can live on as a tiny signal (a delta pill) instead of a large fill. Where it could serve us: keep status colours (red overdue, amber at-risk) signal-sized (pills, dots, text), never big fills.
Not for us: nothing. One nuance: status colours (red/amber/green) carry meaning and sit outside the 10% accent budget, but they must stay small.

---

## What the earlier notes missed or got wrong (my reels only)
- Deq_kvJBI3g: they did not state the hard rule "no screen wider than 375 px" (`scrollWidth`) or "check every screen at 375 px"; they only described the red line. Also missed: the explicit "Thumbs miss 28px buttons" number; that env(safe-area-inset-bottom) needs `viewport-fit=cover`, which app/layout.tsx doesn't set; KPI context lines ("of 6 programmes", "net on €199.7M budgeted"); formatting the value while typing and scrolling the focused field above the keyboard; the 53% statistic, which argues for a global CSS rule.
- Del2E8Ah8bi: missed that every chart names its unit, scope and time window ("MRR in $k", "per week", "Last 12 months"); rate changes in percentage points ("41% +2 pts"); the "or small multiples" alternative and the "readable up to 5" chip; the opener's "+300%" vs "+12%" (they recorded "+64%", a mid-animation frame) and so the rule that the headline delta must be computed from the values.
- DejRN2Oh3p0: missed the drop insertion line, the chained spring-loading (folder inside folder), the "move" operation on the ghost, the folder glyph not swapping, the full WAI-ARIA keyboard model (← to parent, one Tab stop), and the need for a non-drag alternative (WCAG 2.5.7).
- DewJMeuBL_s: missed the button wording rule ("Not now" / "Turn on"), confirming the result in place ("✓ Reminders on"), the inline "Opening camera" progress, and notifications that carry progress ("Glass 6 of 8").
- Df4WVGIBO2k: the error copy must say the fix and must not rely on colour (icon + text). The earlier notes also said "placeholder-only is fine for these search boxes". That is wrong for accessibility: an icon search still needs an accessible name (aria-label).
- Df9fWE8hcgI: missed that secondary/destructive buttons are neutral ghost buttons (pink Reset → gray), and that titles and list icons go neutral. The tint hex is #18181B, not #181818.
- Df-drL4jt7Z: missed that within-group gaps are smaller than between-group gaps, the weight scale, and the primary action pinned at the bottom of the narrow column.

---

## ALL RULES FROM MY REELS
1. Each nesting level indents by one fixed 16 px step. [DejRN2Oh3p0]
2. A 1 px guide line runs from every open node; the active branch's guide is accent. [DejRN2Oh3p0]
3. Disclosure = one chevron rotated 90° in ~180 ms; never swap chevron or folder icons. [DejRN2Oh3p0]
4. Trees are fully keyboard operable (→ open / first child, ← close / parent, ↑↓, Home/End, Enter, type-ahead), one Tab stop, visible row focus, role="tree" + aria-expanded. [DejRN2Oh3p0]
5. Load large branches only on open: skeleton rows in place, a "fetching" chip on the node, the rest stays usable; never a panel-wide spinner. [DejRN2Oh3p0]
6. When dragging, hovering a closed folder ~600 ms opens it (chained), with a visible timer; leaving cancels. [DejRN2Oh3p0]
7. Drag feedback: dimmed source, ghost with name + operation, insertion line at the target depth, highlight + "moved" after the drop. [DejRN2Oh3p0]
8. Every drag has a non-drag alternative such as "Move to…" (WCAG 2.5.7; standard I added). [DejRN2Oh3p0]
9. Bar and area charts start at 0. [Del2E8Ah8bi]
10. A line chart may skip zero only if it says so on the chart. [Del2E8Ah8bi]
11. Headline deltas are computed from the values (measured ratio shown), never inflated by the axis. [Del2E8Ah8bi]
12. One accent series per chart; all others neutral gray and thinner; one accent per screen in general. [Del2E8Ah8bi, Df9fWE8hcgI]
13. Label lines at their end in their own colour; no legend box. [Del2E8Ah8bi]
14. More than 5 series → sortable table (with sparkline + change) or small multiples, never spaghetti. [Del2E8Ah8bi]
15. Tables: the sorted column is marked (accent + arrow, aria-sort); numbers right-aligned in tabular figures; changes signed. [Del2E8Ah8bi, Deq_kvJBI3g]
16. Put the reason for a spike or dip on the chart (accent point + short callout). [Del2E8Ah8bi]
17. Every chart shows title + unit/scope + a visible time window. [Del2E8Ah8bi]
18. Changes in a rate are given in percentage points ("+2 pts"), changes in a count in %. [Del2E8Ah8bi]
19. Check every screen at 375 px; the page is never wider than the viewport. [Deq_kvJBI3g]
20. Under 640 px, table rows become cards (mono ID · code + status top line, bold title, 2–3 label/value rows, overdue in red with the word). [Deq_kvJBI3g]
21. Big figures never wrap: nowrap + tabular-nums, capped at ~30 px on phones; the sign stays with the number. [Deq_kvJBI3g]
22. Every input/select/textarea/contenteditable uses 16 px text on phones/touch (otherwise iOS Safari zooms). [Deq_kvJBI3g, Df4WVGIBO2k]
23. Every field sets the right type / inputmode / autocomplete / enterkeyhint. [Deq_kvJBI3g, Df4WVGIBO2k]
24. Touch targets and fields are at least 44 px under pointer: coarse; the mouse keeps the dense layout. [Deq_kvJBI3g, Df4WVGIBO2k]
25. Fixed bottom bars pad with env(safe-area-inset-bottom) (requires viewport-fit=cover), and content gets room below so the last row clears the bar. [Deq_kvJBI3g]
26. Never ask for a permission at launch; ask right after the action that needs it. [DewJMeuBL_s]
27. Show your own soft-ask card first; call the one-shot system prompt only after a yes. [DewJMeuBL_s]
28. The ask names the concrete gain (what, when); buttons "Not now" / "Turn on". [DewJMeuBL_s]
29. Confirm the result in place ("✓ Reminders on"). [DewJMeuBL_s]
30. A blocked or denied feature stays visible but disabled, with the reason + a one-tap fix; never a dead end. [DewJMeuBL_s]
31. One permission request at a time, tied to the tap that needs it. [DewJMeuBL_s]
32. Slow actions show instant inline progress at the control ("Opening camera"). [DewJMeuBL_s]
33. A visible label outside every field, programmatically tied; the placeholder only shows an example; icon-only search still needs aria-label. [Df4WVGIBO2k]
34. Focus = a 2 px accent ring with a 2 px offset on every control; never a shade-only border change. [Df4WVGIBO2k]
35. The resting field border has ≥ 3:1 contrast with its background (WCAG 1.4.11), in both themes. [Df4WVGIBO2k]
36. Validate on blur, never while typing; the error sits under the field with an icon, says the fix ("Enter a valid email") and is linked by aria-describedby. [Df4WVGIBO2k]
37. Every gap comes from one spacing scale; no one-off values. [Df-drL4jt7Z]
38. Within-group gaps are smaller than between-group gaps. [Df-drL4jt7Z]
39. Every font size comes from one type scale with few, clearly different steps; body 16 px. [Df-drL4jt7Z]
40. Colour by area 60/30/10; the 10% accent marks the one main action. [Df9fWE8hcgI]
41. No third colour at equal weight; shrink it to a small signal or drop it. [Df9fWE8hcgI]
42. The accent appears on at most 3 elements per screen. [Df9fWE8hcgI]
43. Secondary/destructive buttons, titles and list icons are neutral; one filled accent button per dialog or footer. [Df9fWE8hcgI]
44. Tint neutrals ~4% toward the accent hue (#18181B → #16201F). [Df9fWE8hcgI]
45. Blur-test each main screen: three flat zones, not confetti. [Df9fWE8hcgI]

## ALL IDEAS FROM MY REELS
1. A mono breadcrumb path with the current segment in accent above trees and viewers. [DejRN2Oh3p0]
2. A size chip on closed folders/groups ("1,284 items", "235 steps"). [DejRN2Oh3p0]
3. On expand, a connector that draws from the chevron into the guide line. [DejRN2Oh3p0]
4. A node status chip during async work ("fetching" → "loaded"). [DejRN2Oh3p0]
5. Selection tint distinct from the keyboard focus outline. [DejRN2Oh3p0]
6. A value label on the one highlighted bar only. [Del2E8Ah8bi]
7. The legend/filter chip of the accent series turns accent too. [Del2E8Ah8bi]
8. Chart-attached comments that close when the chart answers them ("Answered on the chart"). [Del2E8Ah8bi]
9. A sparkline per table row. [Del2E8Ah8bi]
10. A labeled-dot checklist whose dots tick into checks, for multi-step processes. [Del2E8Ah8bi]
11. A sticky bulk-action bar with a count ("2 selected · Approve selected") and check badges on selected cards. [Deq_kvJBI3g]
12. A list summary line with only the urgent part in red ("12 waiting · 1 past needed-by"). [Deq_kvJBI3g]
13. KPI tiles that always carry context under the number ("2 of 6 programmes", "net on €199.7M budgeted"). [Deq_kvJBI3g]
14. Format long IDs while typing; keep the focused field above the keyboard. [Deq_kvJBI3g]
15. A problem banner that names the object + state ("Visa ending 4242 · expired 09/26"). [Deq_kvJBI3g]
16. A filter select at the top of phone lists ("All programmes"). [Deq_kvJBI3g]
17. Notifications that carry progress ("Glass 6 of 8, keep the streak"). [DewJMeuBL_s]
18. Camera-to-form: "Fill it in from the box" + Scan (→ nameplate, title block, permit). [DewJMeuBL_s]
19. Soft-ask cards inline at the bottom of the screen, not modals. [DewJMeuBL_s]
20. Treat the one-shot system prompt as a budget. [DewJMeuBL_s]
21. A 61.8/38.2 desktop split: content wide, actions/nav narrow, primary pinned to the bottom of the narrow column; active nav = accent dot + text + faint tint. [Df-drL4jt7Z]
22. Font weight rises with size. [Df-drL4jt7Z]
23. A big ratio (~1.6) for large type jumps, ~1.2 for dense UI sizes. [Df-drL4jt7Z]
24. Generous outer padding + one full-width accent primary at the bottom of cards/dialogs. [Df-drL4jt7Z]
25. An automated "six input rules" audit in CI (label, 16 px, ring, 3:1, blur validation, type/autocomplete). [Df4WVGIBO2k]
26. A standard imperative error wording ("Enter a valid …"). [Df4WVGIBO2k]
27. A before/after divider for comparing tints/themes. [Df9fWE8hcgI]
28. Status colours kept signal-sized (pills, dots, text), never large fills. [Df9fWE8hcgI]
