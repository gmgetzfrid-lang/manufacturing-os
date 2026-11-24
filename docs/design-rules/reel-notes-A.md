<!-- Per-reel notes, batch A. Source for docs/design-rules.md, which holds the merged, settled rules. -->
# Rulebook, batch A (8 reels)

Reels: C5Ih77VOcm2, DW87CGQDKbY, Dc-4jNbtyJg, Dd8tUtdhVYZ, DdxNRopKTZo, DdxddtWBsl_, De1Swx4hE8W, Deh4XHEqzX_.

How to read the tags in brackets after each rule:
- [said] = spoken in the reel or written in its caption.
- [on screen] = written or shown on screen but not spoken.
- [standard] = a widely accepted standard (WCAG, platform guidelines) that the reel's example follows or breaks. When the reel breaks it, the line says so.


---

### C5Ih77VOcm2: Split sign-up page, desktop and phone (@websitebrainy repost, design by @sabaresh_uxui; photo post, 5 images, no video)
What it shows: A "Spacer" sign-up concept made in Adobe XD. On desktop, one rounded card is split about 42/58 (the brand panel measures 382 of 915 px). The left side is a blue gradient brand panel with "Welcome to", a rocket logo, lorem ipsum and tiny "CREATOR HERE | DESIGNER HERE" links, edged with a wavy cloud. The right side is a white form, "Create your account", with Name / E-mail Address / Password. Each field has a bold label above, a light placeholder ("Enter your name") and an underline-only input. Below them are a pre-ticked "By Signing Agree with Terms & Policy" and two pill buttons, a filled "Sign up" and an outlined "Sign In". On the phone there are two screens: a full-blue splash, then the form with the brand panel shrunk to a top band. Images 4 and 5 show the design on a phone held in one hand next to a laptop.
RULES:
- R: Put a visible label above every field; the placeholder only shows an example or format [on screen; standard]. Why: the label is still there while you type. Applies in our app to: every form field (sign-in, New request, New project, shift notes, equipment, admin). Check: type one character into every field of every form; the field's name must still be readable.
- R: Never pre-tick a consent, acknowledgement or attestation checkbox [standard; the post breaks it: "By Signing Agree with Terms & Policy" is ticked by default]. Why: a box nobody ticked is not consent. For us, a sign-off nobody actively made is not a sign-off. Applies in our app to: signatures and approvals (components/signatures), "I have reviewed this drawing", Lock report, issue/IFC confirmations, transmittal acknowledgements, terms at signup. Check: `grep -rn "defaultChecked\|checked={true}" app components` (none today), and in state code look for `useState(true)` behind any attestation. Then open every sign-off dialog fresh: all boxes are empty, and the confirming button stays disabled until the person ticks.
- R: An input's boundary needs at least 3:1 contrast against its background; don't use underline-only, faint fields [standard WCAG 1.4.11; the post breaks it: its light-blue underline measures about 1.9:1 on white]. Why: people have to see where to tap. Applies in our app to: all inputs, selects, search boxes and textareas, in both themes. Check: sample each field's border color against the surface in DevTools; it must be 3:1 or more. Also look at it on a phone outdoors.
- R: Placeholder, helper and legal text must still reach 4.5:1 [standard; the post breaks it: placeholder about 1.7:1, consent line about 2.2:1]. Applies in our app to: placeholders, hints, timestamps, footers, captions. Check: run axe or the Lighthouse contrast audit on sign-in and each form, in both themes.
- R: On the phone, a desktop side-by-side layout stacks into one column. The side panel becomes a short band above, and the form keeps the same fields in the same order [on screen]. Applies in our app to: sign-in, signup, set-password, and every detail page with a side panel (document detail, drafting request detail, project page). Check: resize from 1280 to 375 px. Nothing is hidden or reordered, and there is no horizontal scroll.
- R: No text below about 12 px. The post's lorem ipsum and footer links come out around 9 to 10 px [standard; the post breaks it]. Applies in our app to: meta text, chips, table footers. Check: `grep -rn "text-\[9px\]\|text-\[10px\]\|text-\[11px\]" app components`.
IDEAS:
- I: Keep brand expression for the door, not the workspace. The sign-in page can carry a brand panel (logo, workspace name, one true sentence about the site, maybe a plant photo); the work screens stay neutral. Where it could serve us: sign-in, signup, set-password, offline page, public share/verify/transmittal pages.
- I: Give the context panel the narrow side and the task the wide side (about 40/60 here, close to the golden 38/62). Where it could serve us: auth pages; document detail (preview wide, metadata narrow).
- I: Make the form title name the task in plain words ("Create your account"). Where it could serve us: dialog titles like "Request a drawing change" or "Lock this shift report".
- I: Ask for only three things at signup (name, email, password) and collect the rest later. Where it could serve us: invite acceptance and set-password.
- I: Review each design in context: on a phone held in one hand and on a laptop (as images 4 and 5 do). Where it could serve us: a QA habit of checking each screen on a real phone, outdoors, with gloves.
Not for us (only if truly so):
- The phone splash screen ("Welcome to Spacer") before the form: it puts a dead screen between a field worker and the work.
- The gradient panel, wavy cloud divider and lorem ipsum: pure decoration, and it conflicts with the no-gradients rule (Dc-4jNbtyJg).
- Two equal pill buttons, "Sign up" and "Sign In": they conflict with DdxddtWBsl_ (one primary; the other path is a link).
- The grammar of "By Signing Agree with": copy must be correct, plain English.

---

### DW87CGQDKbY: The golden ratio for spacing, layout and type (UX Patterns · Design + Motion, @designmotionhq, 48 s)
What it shows: A golden rectangle (494 px + 306 px, "1.618 THE GOLDEN RATIO"). "SECRET 01 SPACING SCALE, Multiply by 1.618" shows bars for 8 base, 13 small, 21 medium, 34 large and 55 x-large. Then the same card appears as "RANDOM" (gaps 12/7/20/5 px, all gray) and as "GOLDEN" (gaps 8/13/21/13 px, gold chips and a gold primary button). "SECRET 02 LAYOUT PROPORTIONS, Split at the golden ratio" shows 61.8% CONTENT (title, cards, tabs, text) and 38.2% ACTIONS (nav list with the active "Dashboard" in gold with a dot, Analytics, Settings, Profile, and a gold "Upgrade" button at the bottom). "SECRET 03 TYPE SCALE, Each step multiplied by 1.618" shows 16px BODY, 26px SUBHEADING, 42px HEADING and 68px DISPLAY, with the weight rising as the size goes up. The reel also says Stripe, Linear and Airbnb use "this exact scale"; that is not shown or proven.
RULES:
- R: Take every gap from one spacing scale; no one-off values [said: "random padding becomes rhythm"; on screen: random 12/7/20/5 vs scale 8/13/21/13]. Applies in our app to: every padding, margin and gap. Check: `grep -rnE "(p|m|gap|space)[trblxy]?-\[[0-9.]+px\]" app components` finds the one-offs. In DevTools, every gap on a page should be a token value.
- R: Gaps inside a group are smaller than gaps between groups (13 inside the card, 21 between cards) [on screen; standard Gestalt proximity]. Applies in our app to: label to field, field to field, section to section, card contents vs the gap between cards. Check: measure on one form and one dashboard. Label to its field < field to the next label < section to section.
- R: Take type sizes from one scale with few, clearly different steps (four: 16/26/42/68). Each step also steps up the weight [said; on screen]. Applies in our app to: all text. Check: in the console on any page, list the distinct font sizes: `new Set([...document.querySelectorAll('*')].map(e=>getComputedStyle(e).fontSize))`. Aim for 6 or fewer.
- R: Body text is 16 px [said: "body text at 16"]. Applies in our app to: reading text and every input on phones (this matches the iPhone zoom rule from another reel). Dense desktop tables may use 14 px as a deliberate, named exception. Check: at 375 px width, the computed font-size of paragraphs and of every input, select and textarea is 16px or more.
- R: In a two-column layout, the content gets the wide side and the controls the narrow side [said]. Applies in our app to: document detail, drafting request detail, project page, equipment page. Check: on desktop, the preview or work column is wider than the status/actions column.
- R: Use the accent only on interactive or "you are here" elements (the active nav item and the primary button); everything else stays neutral [on screen]. Applies in our app to: nav, buttons, links, focus. Check: list every use of the accent token. Each one must be an action, a link, focus or the current selection.
IDEAS:
- I: The golden spacing scale 8/13/21/34/55 as named tokens (base, small, medium, large, x-large). Where it could serve us: only as inspiration. 13 and 21 are off the 4/8 grid that DdxddtWBsl_ and DdxNRopKTZo use, so pick one system. Recommended: 4/8 grid (4, 8, 12, 16, 24, 32, 56).
- I: A 61.8/38.2 split for detail pages. Where it could serve us: document detail (drawing preview 62%, then revision, status, check-out and send 38%); drafting request (scope and comments vs status and actions); project page (schedule vs crew and actions).
- I: Name tokens by role ("small", "large"), not by pixel. Where it could serve us: globals.css.
- I: Use a gentler type ratio for a dense app (about 1.2 to 1.25: 12/14/16/20/24/32). Keep a 42 to 68 px "display" size for at most one hero number or sentence per page. Where it could serve us: hero bands, the project header.
Not for us (only if truly so):
- 42 and 68 px headings on work screens: too big for registers and tables on a laptop.
- Cropping drawing previews to golden-ratio boxes: a drawing keeps its own sheet proportions (ISO A-series is 1:1.414).
- Citing "Stripe, Linear, Airbnb use this exact scale" as a reason: unverified.

---

### Dc-4jNbtyJg: "Your dashboard looks AI-made": five tells, five fixes (@designmotionhq, 82 s)
What it shows: "DE-AI YOUR UI · 01". The starting dashboard has a purple-to-blue gradient header with "Dashboard", "Search anything", a bell, a "JR" avatar and a purple "Upgrade" button, then "Welcome back, Jordan 👋". Below that are four identical 402×160 KPI cards (Revenue $48,250, Active users 2,340, Conversion 3.8%, Churn 1.2%). Each card has a colored icon tile and the same green "↗ +12.5%" pill, including Churn, where a rise is bad. A "Daily revenue" line with a gradient fill has 7d/30d/90d presets. "Recent transactions" has initials avatars, dates, amounts and Paid/Pending/Refunded pills. The reel fixes it in five steps, each with an on-screen headline:
1. "Gradients with nothing to say." to "One flat accent".
2. "Four colors, four numbers." to "The number is the hero".
3. "Same size, same weight." to "One primary. Three secondary.": Revenue becomes a big card with a "Subscriptions $41,900 / One-time $6,350" breakdown, and the other three stack small on the right.
4. "When everything floats." to "Shadow only on what floats": the radius goes 16 to 8 on the search input, 16 to 12 on cards and 16 to 6 on badges. Only the "…" menu (Export / Filter / Share) keeps a shadow.
5. "Welcome back, Jordan." to "Numbers with a shape": the heading becomes "Revenue · Aug 1 to Aug 31, 2026". The hero shows "+12.5% vs Jul" with a teal sparkline. The secondary deltas become "+3.1%", "+0.4 pt" and "-0.2 pt" in plain gray. Amounts are right-aligned along one edge (shown with a dashed guide).

It ends with an ad for the /ux-design, /ux-audit, /ux-review and /restyle commands.
RULES:
- R: No decorative gradients. Use one flat accent, only where color means something [said: "A generated UI paints gradients where it has nothing to say. One flat accent, now color means something."]. Applies in our app to: hero bands, page headers, buttons, chart fills, avatars. Check: `grep -rn "gradient" app components app/globals.css`. Each remaining gradient needs a reason that is not decoration.
- R: No colored icon tiles next to numbers or titles [said: "Four colors for four numbers is decoration, not information"]. Applies in our app to: KPI tiles, section headers, list rows, settings cards. Check: take a screenshot and count the hues. Any hue not tied to a status or an action fails.
- R: Make one primary metric big and the rest small; never N identical cards [said: "A dashboard with no hierarchy is a spreadsheet with padding. One primary metric, big. Three secondary, small."]. Applies in our app to: Home hero stats, project header stats, Drafting Requests summary, admin analytics. Check: on each screen, exactly one figure uses the top size, and the others are half its size or less.
- R: Corners get tighter as parts get smaller (on screen: cards 12, inputs 8, badges 6, down from 16 on everything) [said: "tighter radius on smaller parts"]. Applies in our app to: every component. Check: `grep -rnoE "rounded(-[a-z0-9]+)?" components app | sort | uniq -c`. That should collapse to about 3 radius tokens chosen by size.
- R: Separate surfaces with hairline borders, and put a drop shadow only on things that open above the page (menus, popovers, dialogs) [said: "When every card floats, nothing does… shadow only on what opens above the page."]. Applies in our app to: cards, inputs, badges, charts (no shadow); menus, popovers, dialogs, toasts (shadow). Check: `grep -rn "shadow" components app`. Every hit should be a floating layer.
- R: No placeholder copy. No greeting or emoji heading; the heading names what is shown and for when [said: "Name the period"; on screen: "Revenue · Aug 1 to Aug 31, 2026"]. Applies in our app to: Home, dashboards, reports, exports, emailed summaries. Check: `grep -rnE "Welcome back|Good (morning|afternoon|evening)|👋" app components`. Every metric or chart title also shows its period.
- R: Every change states its baseline ("+12.5% vs Jul", not "from last month") [on screen]. Applies in our app to: progress vs plan, hours late, backlog changes. Check: every delta on screen ends with "vs <named period or plan>".
- R: A change in a percentage metric is written in percentage points ("+0.4 pt", "-0.2 pt"). A relative % is only for counts and amounts ("+3.1%") [on screen]. Applies in our app to: % complete, schedule adherence, on-time %, pass rates. Check: find every delta shown next to a % value; its unit must be "pt".
- R: Never show fake or identical numbers. Four "+12.5%" pills is "placeholder copy and numbers with no shape" [said]. Applies in our app to: demo or seed data, skeletons, empty states. Check: no hard-coded deltas in components; a seeded workspace shows varied, real values.
- R: Don't color a change green just because it is positive. The "before" shows a green "+12.5%" on Churn, and the fix makes every delta neutral gray [on screen; standard]. Applies in our app to: hours late, overdue counts, open punch items, rework. Check: for each delta, ask "is up good?". Color only by good or bad meaning, or keep it neutral.
- R: Numbers use tabular digits and line up right-aligned in columns [said: "tabular digits"; on screen: dashed alignment guide]. Applies in our app to: amounts, hours, counts and dates in every table. Check: numeric cells compute `font-variant-numeric: tabular-nums` and `text-align: right`.
- R: Charts drop gradient area fills. Use a neutral line with hairline gridlines, and keep the accent for one series at most [on screen]. Applies in our app to: progress, S-curves, throughput charts. Check: no `linearGradient` fills in chart code.
- R: Status pills stay neutral unless they ask for action (Paid, Pending and Refunded are all gray) [on screen]. Applies in our app to: document status, request stage, project status. Check: a register screenshot shows color only on rows that need someone.
IDEAS:
- I: The primary metric card carries its own breakdown (Revenue, then Subscriptions / One-time under a hairline). Where it could serve us: hours late broken down by discipline or crew; documents split into controlled and open.
- I: Layout of one wide card spanning two rows plus three compact rows, with each delta right-aligned. Where it could serve us: the project header (Steps done, Hours late, Left to close).
- I: An accent sparkline next to the hero number instead of a delta badge ("numbers with a shape"). Where it could serve us: progress vs plan; drafting backlog over 30 days.
- I: 7d / 30d / 90d presets on time charts. Where it could serve us: request throughput, documents issued, shift KPIs.
- I: A "…" overflow menu for table-level actions (Export / Filter / Share); it is the only thing with a shadow. Where it could serve us: register tables.
- I: Use the five tells as a screen audit (gradient, icon tiles, equal cards, radius plus shadow everywhere, placeholder copy). Where it could serve us: the UI review checklist.
Not for us (only if truly so): none. The example is fintech, but every point applies to an engineering dashboard.

---

### Dd8tUtdhVYZ: View transitions: four morphs, one CSS property (@designmotionhq, 85 s)
What it shows: A travel app ("Driftwood") with code under each demo.
1. Card to page: `.card img, .page header { view-transition-name: hero; }` plus `document.startViewTransition(() => showPage())`. Chips show width, top and corner radius being interpolated (1080 px / 64 px / 0 px for the header vs 398 px / 197 px / 14 px for the card); caption "same name = morph".
2. List: "Saved trips · 5 guides", with "Sort by date" and "Hide visited" buttons. Each `li { view-transition-name: var(--trip) }`. After the filter the header reads "3 of 5 guides" and "each row slides · 0 animation code". After the sort, the button label reads "Newest first". With two rows named trip-3, the screen shows "duplicate name · skipped" and `// InvalidStateError: duplicate name trip-3`.
3. Theme: `::view-transition-new(root) { animation: reveal 600ms }` with `clip-path: circle(0 at var(--x) var(--y))` from the click point (--x 851px, --y 36px).
4. Modal: "× from nowhere" vs "grows from the button". The code is `btn.style.viewTransitionName="share"; startViewTransition(() => { btn…="none"; dialog…="share"; dialog.showModal(); })`.
5. Real page loads: `@view-transition { navigation: auto; }` on both trips.html and lisbon.html; "no framework", "same morph". Support chips: "Chrome 126+ supported", "Safari 18.2+ supported", "No support · instant swap", "nothing breaks".

Rows show "✓ Visited" as an icon plus a word.
RULES:
- R: A view-transition-name must be unique on the page at the moment of capture. Two elements with the same name throw InvalidStateError and the whole transition is skipped [said: "Two items with the same name and the whole transition is skipped"; on screen: the error text]. Applies in our app to: any row named by document, request or tag number. The same document can appear twice on one page (in "Needs you" and in a library list). Check: sort and filter every list with DevTools open; no InvalidStateError. Build names from a list scope plus the ID (`row-${listId}-${id}`).
- R: Hand a name over; don't copy it. When a dialog grows from its button, the button drops the name ("none") in the same update that the dialog takes it [on screen code]. Applies in our app to: dialogs opened from buttons. Check: code review of every shared name.
- R: Animation is optional. Without support the change is an instant swap, and nothing waits on the animation [said: "Without support, you get an instant swap. Nothing breaks."]. Applies in our app to: every route, tab and list change. Check: in Firefox (or with the API stubbed out), every navigation still works with no console error.
- R: Respect prefers-reduced-motion [standard WCAG 2.3.3; the reel does not mention it]. Applies in our app to: all morphs, slides and wipes. Check: turn on the OS "Reduce motion"; changes become instant. lib/viewTransition.ts already does this; keep it. Also keep its other rule: names are set only while a transition runs (html.vt-on), because a permanent name creates a stacking layer and pushed un-portaled dialogs under the top bar.
- R: When a filter hides items, the list says so: "3 of 5 guides" [on screen; standard "visibility of system status"]. Why it matters here: in document control, a hidden filter can make a drawing look missing. Applies in our app to: Documents, Drafting Requests ("Show closed", "Anyone", "Any stage"), Projects tabs, Equipment. Check: apply any filter. The header shows "N of M" and one click clears the filters.
- R: A sort control says the current order in words ("Sort by date" becomes "Newest first") [on screen]. Applies in our app to: every sortable list and table header. Check: after sorting, the label or `aria-sort` names the order.
- R: Status is shown with an icon and a word, never color alone ("✓ Visited") [on screen; standard WCAG 1.4.1]. Applies in our app to: all statuses. Check: take a grayscale screenshot; every status is still readable.
IDEAS:
- I: The thing you tapped becomes the thing you get: the card or row morphs into the page header. Where it could serve us: project row to project header; document row to document detail header (number, revision, status); equipment tag to equipment page.
- I: Rows slide to their new place on sort, filter and delete, with one unique name per row. Where it could serve us: Drafting Requests, Documents, Projects status tabs, punch lists.
- I: A dialog grows out of its trigger and shrinks back into it. Where it could serve us: New request, Email / Print, Lock report, Share / transmittal.
- I: The theme spreads as a circle from the toggle (600 ms in the reel). Where it could serve us: the top-bar theme button, kept at 300 ms or less (see DdxddtWBsl_), or skipped.
- I: Cross-document transitions (`@view-transition { navigation: auto }`) for pages served as separate documents. Where it could serve us: public share, verify and transmittal pages.
- I: A count next to the list title ("Saved trips 5 guides"). Where it could serve us: every register title.
Not for us (only if truly so): a 600 ms theme wipe: it breaks the "done within 300 ms" rule from DdxddtWBsl_. Shorten it or keep the instant switch.

---

### DdxNRopKTZo: UX Engine: "You ask Claude for a dashboard, you got everyone's dashboard" (@designmotionhq, 41 s, an ad)
What it shows:
- "00 DEFAULTS" is the generic AI dashboard. An "Acme" sidebar lists 7 items, each with a purple square icon. Four equal KPI cards show "$45,231.89 +20.1% from last month", "+2,350 Subscriptions +180.1% from last month", "+12,234 Sales +19%…" and "+573 Active Now +201 since last hour", each with a gradient icon. A purple gradient bar chart has no axis labels. "Recent Sales · You made 265 sales this month." uses identical gradient avatars.
- "01 THE ENGINE" lists eight skills: INTENT DISCOVERY, INFORMATION HIERARCHY, STATE COMPLETENESS, FORM UX, FEEDBACK & AFFORDANCE, UX AUDITOR, DESIGN SYSTEM, VISUAL CHARACTER.
- "/ux-design billing page" is a wireframe annotated "1 ONE PRIMARY ACTION" (Upgrade plan) and "2 3 COLUMNS, NOT 9", with Loading / Empty / Error boxes.
- "/ux-audit dashboard.tsx" pins tags on the dashboard: P2 FRAMEWORK PALETTE, P0 4 KPIs SAME WEIGHT, P1 LOW CONTRAST NAV, P2 GENERIC AVATARS, P1 CHART WITHOUT LABELS, P0 NO EMPTY STATE. Its "WORST FIRST" list is: P0 Four KPIs, one weight; P0 No empty state; P1 Chart has no labels.
- "/ux-review" on a BillingTable.tsx diff leaves three notes: "No loading state while invoices load.", "No empty state when there are no invoices." and "Delete looks as primary as Save. Demote it and confirm."
- "/restyle dashboard" (TYPE / COLOR / SPACE / FINISH) gives an overline "REVENUE, SEPTEMBER", "$45,231" huge, "+20.1% vs August", a plain row "2,350 Subscriptions · 12,234 Sales · 573 Active now", a hairline, one teal line and text-only nav with a bar on the active item. DESIGN.md: "type Host Grotesk 800 / 400; color ink + one teal accent; space 8pt grid, 56 between groups; finish hairlines, no gradients".
- "WITH VS WITHOUT": Tables that show only what matters; Errors that keep what you typed; Colors from your own design tokens.
RULES:
- R: Every data view has designed loading, empty and error states before it ships [on screen: P0 "No empty state", "No loading state while invoices load"]. Applies in our app to: every list, table, chart, panel and widget. Check: throttle to Slow 3G, use an empty workspace and force a 500 from the API. You should see skeleton rows, an empty state with one action, and a plain-words error with Retry (never a raw database message).
- R: A destructive action never looks like the primary one. Demote it and confirm it [on screen: "Delete looks as primary as Save. Demote it and confirm."]. Applies in our app to: Delete, Start over, Remove member, Void or supersede, Unlock report, Discard draft. Check: list every destructive button. None uses the primary style, and each confirm names the object ("Delete request KE-DDRT-26-0003?").
- R: Errors keep what the user typed [on screen]. Applies in our app to: every form, especially long shift notes and request scopes, and also on session expiry and network loss. Check: submit with the network off or with an invalid field; every value is still there, and reloading restores the draft.
- R: Colors come only from your own design tokens, never from the framework's default palette [on screen: "P2 framework palette"; "Colors from your own design tokens"]. Applies in our app to: all components. Check: `grep -rnE "(text|bg|border)-(blue|purple|indigo|violet|pink|green|red|yellow)-[0-9]{2,3}" components app` and raw `#hex` outside the token file.
- R: Tables show only the columns that matter ("3 COLUMNS, NOT 9") [on screen]. Applies in our app to: Drafting Requests, Documents, Equipment and user lists, especially on the phone. Check: count the visible columns at 375 px and 1280 px. Each one must earn its place; the rest go into the detail view or a column picker.
- R: Charts carry labels: axes, units or direct values ("P1 chart without labels") [on screen]. Applies in our app to: every chart. Check: every chart has a labeled axis with units, or labels on the values.
- R: Navigation text meets contrast ("P1 low contrast nav") [on screen; standard 4.5:1]. Applies in our app to: sidebar items that are not active, tab labels, in both themes. Check: run axe on the sidebar.
- R: A plus or minus sign goes only on a change, never on a total. The defaults print counts as "+2,350", "+12,234" and "+573"; the restyle prints "2,350 Subscriptions" [on screen]. Applies in our app to: counts, quantities, hours. Check: review the number formatters; `signDisplay` or a "+" prefix appears only on deltas.
- R: Round hero numbers to the precision the decision needs ("$45,231.89" becomes "$45,231"). Exact values belong in tables [on screen]. Applies in our app to: hero hours, costs, percentages. Check: no cents or extra decimals in any hero figure.
- R: No generic avatars or icons that carry no information ("P2 generic avatars"; identical gradient circles) [on screen]. Applies in our app to: people lists, crew lists, comments. Check: each avatar is a real photo or initials, or it is removed.
- R: Every metric names its period ("REVENUE, SEPTEMBER", "+20.1% vs August") [on screen]. Same as Dc-4jNbtyJg.
- R: Spacing sits on an 8 pt grid with 56 px between groups [on screen, DESIGN.md]. Applies in our app to: page sections. Check: gaps between sections measure 56 (or the chosen group token).
- R: Fix UI problems worst first, ranked by severity (P0 / P1 / P2) [on screen: "WORST FIRST"]. Applies in our app to: our UI review and backlog. Check: UI issues carry a severity, and P0s (equal-weight KPIs, missing states) are fixed before polish.
- R: Write the design system down in one short file (type, color, space, finish) and build every screen from it [said: "/restyle gives it a character and writes it down"]. Applies in our app to: a DESIGN.md (or the docs folder) that matches the tokens in app/globals.css. Check: the document exists, and its values equal the token values.
IDEAS:
- I: Use the eight skills as a review rubric for every new screen: what the user came to do (intent), hierarchy, all states present, form UX, feedback and affordance, audit, design-system fit, visual character. Where it could serve us: the PR or UI review checklist.
- I: "Screens first, then code": plan each screen with numbered decisions (one primary action, which columns, which states) before writing it. Where it could serve us: new pages and features.
- I: Review UI in the diff with inline comments (missing loading state, Delete styled like Save). Where it could serve us: the code-review step.
- I: Restyled metric block: a small mono overline label with the period, one huge number, then a plain row of secondary numbers with no cards. Where it could serve us: hero bands, the project header.
- I: Two weights only (800 for the hero, 400 for the rest). Where it could serve us: type tokens.
- I: The active nav item gets a 2 px accent bar and brighter text; no icon squares on every item. Where it could serve us: the sidebar.
- I: Drop chatty subtitles ("You made 265 sales this month.") unless they carry the point. Where it could serve us: section subtitles.
Not for us (only if truly so): buying the $79 plugin is outside the brief; its checklists are copied above.

---

### DdxddtWBsl_: Same login form, six decisions (@motion_ui_interface, 121 s)
What it shows: An "Aurora" login card ("Welcome back / Sign in to continue to Aurora.") improved in six upgrades. Each upgrade has a BEFORE/AFTER pill, callout chips and a "WHY IT WORKS" line.
- 01 Hierarchy, "One thing to do.": title 40px weight 800, subtitle 22px "quiet". "Sign in" is "primary · the only loud button", and "Create account" becomes a link ("was a second button": "New here? Create account"). An EYE PATH goes 1 title, 2 fields, 3 button.
- 02 Spacing, "Room to tap.": fields are 56px ("thumb-sized") and the button is 56px ("same height"). Gaps are 32 at the top, 16 between fields and 32 before the button; "every gap is a multiple of 8". The "before" had 40 px fields.
- 03 Labels, "Labels stay. Hints help.": ABOVE "above, 16px"; INSIDE "never a label"; LABEL "stays while typing"; HINT "an example" (you@company.com); HINT "the rule up front" (placeholder "At least 8 characters").
- 04 Color & focus, "Show them where they are.": #FFFFFF title 17:1, #93A1BA subtitle 6.6:1, #5E6B84 hints, #38BDF8 "×1 · button + links", FOCUS RING 2px #38BDF8.
- 05 Depth & corners, "Lift it off the page.": 24 card radius, 12 on fields and button, a 1px hairline border, a surface lighter at the top (light from above), and a shadow "y 24 · blur 60 · falls down".
- 06 Motion, "Every tap answers.": focus ring 150ms; label stays while typing; press scale 120ms; done is spinner to check ("Signed in ✓"); an EASE-OUT 200MS curve.

Caption: "Feedback in 100ms, done in 300". The password field has "Show". "Remember me" is ticked in every version.
RULES:
- R: One primary action per screen; everything else is a link [said: "The rule, one primary action, the rest are links." Why: "When two buttons shout equally, the user stops to compare instead of tapping."]. Applies in our app to: every page, dialog and toolbar (Shift report toolbar, Home hero, document detail, New request). Check: on each screen, count the filled or accent buttons; there should be one.
- R: The title is the largest and heaviest text (40 px / 800 here) and the subtitle is quiet (22 px), so the eye goes title, then fields, then button [said; on screen]. Applies in our app to: forms, dialogs, page heads. Check: squint or blur a screenshot; the first three things you see are the title, the inputs and the primary button.
- R: On touch layouts, fields and buttons are 56 px tall, and the button is the same height as the fields. 40 px "are hard to tap" [said]. Applies in our app to: all inputs, selects and buttons in the phone layout (gloved field use). Check: at 375 px, the computed height is 56 or more (never below 44).
- R: Form spacing follows an 8 px grid: 16 between fields, 32 before the primary button, 32 inside the card edge [said]. Applies in our app to: every form. Check: measure with the DevTools ruler.
- R: Put a label above every field; the placeholder is an example, never the name; the label stays while typing [said: "A placeholder disappears the moment you type and the question disappears with it… The placeholder is a hint, never the name."]. Applies in our app to: every form field. Search boxes need at least an aria-label plus a visible icon. Check: `grep -rn "placeholder=" app components`. Each hit has a `<label htmlFor>` or is a search box with an aria-label.
- R: Show rules and formats (password rules, tag formats, units, date formats) as helper text that stays visible, not only in the placeholder. The reel's own "At least 8 characters" placeholder vanishes on the first keystroke, which is the flaw its upgrade 3 is about [derived from the reel's own reason]. Applies in our app to: set-password, signup finish, tag fields ("P-2001"), pressure/temperature units, dates. Check: type one character; the rule is still on screen.
- R: Use three text tiers (title, secondary, hint) and one accent, used only for the action and links [said: "Pure white everywhere is noise. Three text tiers… One accent saved for the button and the links."]. Applies in our app to: all screens. Check: there are tokens for ink, muted and faint, and the accent token appears only on interactive elements.
- R: Every text tier passes 4.5:1. The reel's hint tier #5E6B84 measures about 3.2 to 3.4:1 on its card and fails, while the title (17:1) and subtitle (6.6:1) pass [standard WCAG 1.4.3; the reel's own value fails]. Applies in our app to: faint text, placeholders, timestamps, "last updated", captions. Check: run axe in both themes; the faint token must be 4.5:1 or better on every surface it sits on.
- R: Every focusable control shows a 2 px focus ring in the accent, every time it has focus [said: "a two pixel focus ring so the user always knows which field is listening"]. Applies in our app to: inputs, buttons, links, tabs, rows, menu items. Check: Tab through every page. `grep -rn "outline-none" components app` hits must each have a `focus-visible:ring` replacement.
- R: Use one radius family, inner smaller than outer (24 on the card, 12 on fields and buttons) [said: "Now every corner agrees."]. Applies in our app to: everything (combine with Dc-4jNbtyJg: 12 / 8 / 6 by size). Check: the radius tokens map to component sizes.
- R: Depth comes from a 1 px hairline border, a surface slightly lighter at the top and one soft downward shadow (y 24, blur 60) [said]. Applies in our app to: standalone surfaces such as the sign-in card and dialogs, not every card (see Dc-4jNbtyJg). Check: there is one shadow token for floating surfaces.
- R: Every tap answers. Feedback starts within 100 ms (focus ring fades in within 150 ms, press scale 120 ms, ease-out about 200 ms) and is done within 300 ms [said: "Every tap gets an answer. Feedback in 100 milliseconds, done within 300."]. Applies in our app to: all buttons, toggles, focus and submits. Check: `grep -rnE "duration-(500|700|1000)|transition.*[5-9][0-9]{2}ms" components app app/globals.css`, and record clicks in the DevTools Performance panel.
- R: Show submit progress inside the button: it compresses on press, shows a spinner, then a check and short result text ("Signed in ✓"). The button keeps its size [said]. Applies in our app to: Lock report, Send transmittal, Issue, Save, Ask. Check: with network throttling, click submit. The spinner appears in place, the width doesn't jump, a double click doesn't submit twice, and success shows in the button.
- R: The label stays put while typing; no floating labels that move [said: "Type and the label stays put."]. Check: no float-label pattern in the input components.
- R: Password fields have a Show toggle [on screen in every version; standard]. Applies in our app to: sign-in (app/page.tsx), set-password, signup/finish, and admin secret fields (admin/data-export). Check: each `type="password"` has a Show/Hide button with `aria-pressed`.
- R: On shared devices, "Remember me" or staying signed in defaults to off. The reel ticks it by default [derived, security practice]. Why: control-room PCs and crew tablets are shared. Applies in our app to: sign-in, session length. Check: a fresh sign-in on a new browser does not persist the session unless the person chose it.
IDEAS:
- I: Write a one-line "WHY IT WORKS" next to each design decision. Where it could serve us: DESIGN.md entries.
- I: Eye-path test: number the three things a person should see in order, then check the visual weight matches. Where it could serve us: reviewing each page head.
- I: Put "Forgot password?" on the same row as "Remember me", right-aligned. Where it could serve us: sign-in.
- I: A surface lit from above (top 1 to 2 % lighter). Where it could serve us: dialogs and the sign-in card only. Keep it a lightness change, not a hue gradient.
- I: Six-segment progress bar plus BEFORE/AFTER pills as a way to present design changes. Where it could serve us: design review decks.
Not for us (only if truly so): the colored glow halos around the primary button and focused field: decorative, and invisible in bright outdoor light; keep a solid 2 px ring.

---

### De1Swx4hE8W: Every tour gets skipped: build the first run instead (@designmotionhq, 55 s)
What it shows: The "Pennywise" budget app, in five pieces.
- "Every tour gets skipped." (3 screens · 0 read)
- Piece 1, "One question, then the app.": a Welcome screen with Skip, then "What are you saving for?" (A trip / Rent / Emergency fund), "You can change it later." and Continue. "Every extra question costs you." strikes out "Role?", "Company size?" and "How did you hear about us?" next to an "activation" line falling to "quit · no budget".
- Piece 2, "Open on a checklist at 1/3." and "Already started, so they go on.": a "Get started" ring at 1/3, "3 steps · about 2 min", "Create account" ticked and struck through, then "Add your first budget" (accent outline) and "Set a savings goal". "Your goal: A trip" with "Set your trip budget". Tapping a task opens a bottom sheet, "task 2 of 3 · Add your first budget", prefilled "Trip to Lisbon" and "€1,200".
- Piece 3, "An empty state with one button.": "✗ blank list" (title, Search box, "No data yet") vs "✓ one button" ("Budgets · 0 budgets", wallet icon, "Budgets show up here", "Plan a trip, rent or a rainy day fund.", "+ Create your first budget").
- Piece 4, "One tip, near the thumb." and "Past three tips, nobody reads.": the bad version is "Tip 3 of 5 · Swipe to see more · Next" (3 tips · 0 read; 5 tips · 0 read; "tour ended"). The good version is "Add an expense here · 1 tip · Got it", pointing at the + button in the "thumb zone".
- Piece 5, "Skip, same corner, every step." and "Come back, progress kept.": "1 of 3" at top left, Skip at top right labeled "fixed step 1/3", dots, Next.
- End, "Screens first, then code.": one question (before value), checklist one done (1 of 3 ticked), empty state with a button (no blank list), one coach mark (near the thumb), skip that remembers (progress kept).
RULES:
- R: Ask at most one question before the person sees value. Every extra question costs activation [said: "If it also asks your role, you quit before you see a budget."]. Applies in our app to: first sign-in, new workspace, the New project wizard, New request. Check: count the screens and required fields before the first useful screen; one question at most.
- R: Use the answer right away: prefill and personalise ("A trip" becomes "Set your trip budget" and "Trip to Lisbon") [on screen]. Applies in our app to: project type, unit and discipline answers prefilling later forms. Check: an onboarding answer shows up as a default in the next form.
- R: First run is a short checklist on the real home screen, with progress, a count and a time estimate ("1/3", "3 steps · about 2 min"). The first item is already done [said]. Applies in our app to: new workspace (add a library, upload drawings, invite the team) and new project setup. Check: a new workspace opens on a checklist showing 1/N, not on zeros and dashes.
- R: An empty list says what will appear there, gives a one-line example and offers exactly one button that creates the first item. Never "No data yet" [said: "Your empty home shows one button instead of a blank list."]. Applies in our app to: every register, list, table and widget when empty. Check: walk an empty workspace, and `grep -rniE "no data|nothing here|no results yet" app components`.
- R: Hide search, filter and sort on an empty list. The "blank list" offers a Search box with nothing to search [on screen]. Applies in our app to: empty Documents, Requests, Equipment, Projects. Check: in each empty state, the search, filter and group-by controls are hidden.
- R: Show at most one coach mark at a time, on the control the person needs next and within thumb reach. No multi-step tours [said: "Past three tooltips, people stop reading and tap through until it ends."]. Applies in our app to: first-use hints in Split/Merge, Ask, Lock report. Check: `grep -rnE "Tip [0-9]+ of|step [0-9]+ of [0-9]+" components`; at most one hint is visible at once, anchored to its control.
- R: Skip stays in the same corner on every step, and the step count is visible ("1 of 3") [said]. Applies in our app to: any wizard or onboarding. Check: step through; the Skip button doesn't move.
- R: Progress persists. Leave and come back, and the checklist or wizard resumes where you stopped [said: "When you come back, the checklist still remembers where you stopped."]. Applies in our app to: onboarding, the New project wizard, Split/Merge, long forms. Check: close the tab half way through, reopen it, and the same step and values are there.
- R: On the phone, the primary action sits in the thumb zone (bottom third) [on screen]. Applies in our app to: phone layouts for crews (add note, add photo, mark step done). Check: on a 375×812 viewport, the primary action is in the bottom third and reachable with one hand.
- R: A floating button never covers content. The reel's own frames show the + overlapping the budget card [derived; the reel's own flaw]. Applies in our app to: any floating action button or sticky bar. Check: scroll to the end of each list on the phone; the last row is fully visible above the button.
IDEAS:
- I: Mark a done checklist item with a check and strikethrough, and give the next one an accent outline. Where it could serve us: project setup and close-out checklists.
- I: A checklist task opens as a bottom sheet ("task 2 of 3") over the checklist, so context is kept. Where it could serve us: the setup checklist on phones.
- I: "You can change it later." under a first-run choice, to lower hesitation. Where it could serve us: workspace or project type questions.
- I: Show the count beside a title even at zero ("Budgets · 0 budgets"). Where it could serve us: register titles.
- I: A coach mark labeled "1 tip" with a "Got it" dismiss, shown once. Where it could serve us: replacing the dismissible top banners.
Not for us (only if truly so): the full-screen welcome carousel with an illustration ("Welcome to Pennywise", piggy bank): the reel itself argues against it, and a professional tool should open on the work. The "Good morning Jonah" greeting conflicts with Dc-4jNbtyJg.

---

### Deh4XHEqzX_: Why an AI input feels premium: five states, one component (@designmotionhq, 36 s)
What it shows: A dark chat composer. Suggestion chips sit above it ("Draft an email", "Summarize a PDF", "Plan a s…"), with the placeholder "Ask anything". Inside is a toolbar with "+", a "• Atlas 2 ⌄" model chip and a globe "Search" chip, plus a mic and a round send button that is dim gray while the box is empty. Five numbered captions:
- 01 "Focus ring, not a border swap": a soft teal ring appears outside, and the border doesn't move.
- 02 "Send wakes up with content": solid teal after the first letter.
- 03 "Grows with the text, toolbar stays put".
- 04 "Uploads in place, no modal": a "Q3-report.pdf · Uploading 12%" chip with a progress ring turns into "2.4 MB", next to an image thumbnail chip, inside the box above the text.
- 05 "Send becomes Stop": a square stop icon with a spinning ring.

An exploded view labels the layers: Attachments (uploads in place), Text field (grows upward), Toolbar (never moves), Container (focus ring). The closing line is "Premium lives in the states."
RULES:
- R: Design every state of an input: rest, focus, has content, multi-line, uploading, working/streaming (and add disabled and error) [said: "every single state is designed. Premium lives in the states."]. Applies in our app to: every input component, especially Ask, comments, shift notes and search. Check: keep one test page (or story) per input component showing all states.
- R: Focus is a ring outside the border. The border width and the layout never change ("The border doesn't jump") [said]. Applies in our app to: all inputs, selects, textareas and search. Check: compare `getBoundingClientRect()` of the field and its neighbours before and after focus; nothing moves.
- R: The submit button stays in place but looks quiet (disabled) while the input is empty, and turns into the solid accent action with the first character [said: "Type a single letter and the send button wakes up"; on screen: dim send while empty]. Applies in our app to: Ask, comments, notes, New request (until the required fields are filled). Check: empty means `aria-disabled` with a reason; after one character, the button is enabled; no layout shift.
- R: A multi-line input grows with the text (upward when docked at the bottom) up to a max height, then scrolls; the toolbar row never moves [said]. Applies in our app to: Ask composer, shift notes, comments, request scope. Check: type five lines; the toolbar stays put and the page doesn't jump.
- R: Attachments upload inside the field with name, size and per-file progress, without a modal [said: "Drop a file in and it uploads right there. No modal."]. Applies in our app to: comments, shift notes, chat, request attachments, field photos. Check: drop a PDF. A chip with percent progress appears in place, and it can be cancelled or removed.
- R: While the job runs, the submit button becomes Stop in the same place [said]. Applies in our app to: AI answers and long jobs (re-reading drawings, bulk check-out, sending transmittals). Check: start a long job. A Stop/Cancel is in the same spot as the button that started it, and it works.
IDEAS:
- I: Starter suggestion chips above an empty Ask box. Where it could serve us: "Find the P&ID for E-101", "What's overdue in TA-26?", "Summarize last night's shift".
- I: Settings that change the next request live in the toolbar as chips (model, Search on/off). Where it could serve us: scope chips such as "This project" / "All libraries" in Ask and search.
- I: A mic button for dictation. Where it could serve us: shift notes and punch items typed by gloved hands in the field.
- I: Think of a component as layers with one job each (container, attachments, text, toolbar). Where it could serve us: specs for the composer and the note editor.
Not for us (only if truly so): none.

---

## Conflicts between my reels (pick one, apply everywhere)
- Spacing: golden 8/13/21/34/55 (DW87CGQDKbY) vs 8 pt grid with 16 / 32 / 56 (DdxddtWBsl_, DdxNRopKTZo). Use the 4/8 grid; two reels state it, and 13 and 21 fall off it.
- Secondary action: an outlined button the same size as the primary (C5Ih77VOcm2) vs a link (DdxddtWBsl_). Use a link; it is the reel that states a rule and gives the reason.
- Shadows: a lifted login card (DdxddtWBsl_) vs "shadow only on what floats" (Dc-4jNbtyJg). Work-screen cards get no shadow; floating layers and the one standalone card on an empty page (sign-in) may.
- Motion length: a 600 ms theme wipe (Dd8tUtdhVYZ) vs "done within 300" (DdxddtWBsl_). Use 300 ms or less.
- Radius: 24 / 12 (DdxddtWBsl_) vs 12 / 8 / 6 (Dc-4jNbtyJg). Both say "one family, smaller parts tighter". Choose one set of three by size.
- A "lighter at top" surface (DdxddtWBsl_) vs "no gradients" (Dc-4jNbtyJg, DdxNRopKTZo). Allow at most a faint lightness change on dialogs and the auth card, never a hue gradient.

## ALL RULES FROM MY REELS
Forms and inputs
1. A visible label above every field that stays while typing; the placeholder is only an example, never the name. (DdxddtWBsl_, C5Ih77VOcm2)
2. Rules, formats and units (password rules, tag format, units) shown as helper text that stays visible, not only in the placeholder. (DdxddtWBsl_)
3. Labels never float or move while typing. (DdxddtWBsl_)
4. On touch, fields and buttons are 56 px tall (never below 44), and buttons match the field height; 40 px is too small. (DdxddtWBsl_)
5. Form spacing on the 8 px grid: 16 between fields, 32 before the primary button, 32 inside the card edge. (DdxddtWBsl_)
6. A 2 px focus ring in the accent on every focusable control, always visible when focused. (DdxddtWBsl_)
7. Focus is a ring outside the border; focusing never changes the border width or the layout. (Deh4XHEqzX_)
8. Input boundaries have at least 3:1 contrast; no faint underline-only fields. (C5Ih77VOcm2)
9. Every password field has a Show toggle. (DdxddtWBsl_)
10. Consent, acknowledgement and attestation boxes are never pre-ticked; sign-offs need an active tick. (C5Ih77VOcm2)
11. "Remember me" / staying signed in defaults to off (shared devices). (DdxddtWBsl_)
12. Errors keep everything the user typed. (DdxNRopKTZo)
13. Submit stays in place, quiet and disabled until there is content or the required fields are filled, then it becomes the one solid action. (Deh4XHEqzX_)
14. Multi-line inputs grow with the text up to a max, and the toolbar never moves. (Deh4XHEqzX_)
15. Attachments upload inside the field with name, size and per-file progress; no modal. (Deh4XHEqzX_)
16. A running job turns its submit button into Stop/Cancel in the same place. (Deh4XHEqzX_)
17. Every input component has every state designed: rest, focus, filled, multi-line, uploading, working, disabled, error. (Deh4XHEqzX_)

Hierarchy and actions
18. One primary action per screen; everything else is a link or sits in a menu. (DdxddtWBsl_, DdxNRopKTZo)
19. Destructive actions never look primary; they are demoted and confirmed, and the confirm names the object. (DdxNRopKTZo)
20. The title is the largest and heaviest text, the subtitle is quiet, and the eye path runs title, then fields or content, then action. (DdxddtWBsl_)
21. One primary metric is big and the rest are small; never N identical cards. (Dc-4jNbtyJg, DdxNRopKTZo)
22. In two-column layouts, content takes the wide side and controls the narrow side. (DW87CGQDKbY)

Color, contrast and surfaces
23. No decorative gradients; one flat accent, used only on actions, links, focus and the current selection. (Dc-4jNbtyJg, DdxNRopKTZo, DdxddtWBsl_, DW87CGQDKbY)
24. No colored icon tiles beside numbers or titles. (Dc-4jNbtyJg)
25. Three text tiers, and every tier (including hints and placeholders) passes 4.5:1. The reel's own hint is about 3.2:1 and the sign-up post's placeholder about 1.7:1; both fail. (DdxddtWBsl_, C5Ih77VOcm2)
26. Colors only from your own tokens, never the framework palette. (DdxNRopKTZo)
27. Navigation text passes contrast. (DdxNRopKTZo)
28. Status is shown with an icon or word plus color, never color alone. (Dd8tUtdhVYZ)
29. Status pills are neutral unless they ask for action. (Dc-4jNbtyJg)
30. Hairline borders separate surfaces; shadows only on layers that float above the page. (Dc-4jNbtyJg, DdxddtWBsl_)
31. One radius family; smaller parts get tighter corners (e.g., 12 / 8 / 6 or 24 / 12). (Dc-4jNbtyJg, DdxddtWBsl_)
32. No generic avatars or icons that carry no information. (DdxNRopKTZo)

Spacing and type
33. Every gap comes from one spacing scale; no one-off values. (DW87CGQDKbY, DdxddtWBsl_, DdxNRopKTZo)
34. Gaps inside a group are smaller than gaps between groups, with about 56 px between groups. (DW87CGQDKbY, DdxNRopKTZo)
35. Few type sizes from one scale, each step clearly different. (DW87CGQDKbY)
36. Body text and every input on phones are 16 px. (DW87CGQDKbY)
37. No text below about 12 px. (C5Ih77VOcm2)

Numbers, charts, tables
38. Every metric and chart names its period, and every delta names its baseline ("vs Jul"). (Dc-4jNbtyJg, DdxNRopKTZo)
39. A change in a percentage is written in percentage points ("+0.4 pt"). (Dc-4jNbtyJg)
40. Plus and minus signs go only on changes, never on totals. (DdxNRopKTZo)
41. Deltas are colored by good or bad meaning, or kept neutral, never green just because they are positive. (Dc-4jNbtyJg)
42. Tabular digits, right-aligned, in numeric columns. (Dc-4jNbtyJg)
43. No placeholder copy (greetings, emoji) and no fake or identical numbers. (Dc-4jNbtyJg)
44. Hero numbers rounded to the precision the decision needs; exact values in tables. (DdxNRopKTZo)
45. Charts are labeled (axes, units or values) and have no gradient fills. (DdxNRopKTZo, Dc-4jNbtyJg)
46. Tables show only the columns that matter ("3 columns, not 9"). (DdxNRopKTZo)
47. A filtered list says "N of M" and offers a one-click clear. (Dd8tUtdhVYZ)
48. A sort control names the current order in words. (Dd8tUtdhVYZ)

States and feedback
49. Every data view has designed loading, empty and error states. (DdxNRopKTZo)
50. An empty state says what will appear, gives an example line and offers one create button; never "No data yet". (De1Swx4hE8W)
51. Search, filter and sort are hidden on an empty list. (De1Swx4hE8W)
52. Every tap answers within 100 ms (focus ring ≤150 ms, press 120 ms, ease-out) and is done within 300 ms. (DdxddtWBsl_)
53. Submit progress and result appear in the button: press, spinner, check plus a short result text, without a size change and without double submit. (DdxddtWBsl_)

First run and phone ergonomics
54. At most one question before value, and the answer is reused right away. (De1Swx4hE8W)
55. First run is a checklist on the real home with progress, a count and a time estimate, starting at 1/N. (De1Swx4hE8W)
56. At most one coach mark at a time, anchored to the next control, near the thumb; no tours. (De1Swx4hE8W)
57. Skip stays fixed in the same corner on every step, with "n of N" visible. (De1Swx4hE8W)
58. Progress persists: leave and come back to the same step and values. (De1Swx4hE8W)
59. On phones the primary action is in the thumb zone, and floating buttons never cover the last row. (De1Swx4hE8W)
60. On phones, a desktop side panel stacks above as a short band; fields and order stay unchanged. (C5Ih77VOcm2)

Motion
61. View-transition names are unique on the page and handed over, never duplicated (a duplicate skips the whole transition). (Dd8tUtdhVYZ)
62. Animation is optional: an instant swap without support, nothing waits on it, and prefers-reduced-motion is respected. (Dd8tUtdhVYZ)

Process
63. The design system is written down (type, color, space, finish) and matches the tokens; screens are built from it. (DdxNRopKTZo)
64. UI problems are fixed worst first, by severity (P0 / P1 / P2). (DdxNRopKTZo)

## ALL IDEAS FROM MY REELS
1. Keep brand expression for the door (sign-in, share and verify pages); work screens stay neutral. (C5Ih77VOcm2)
2. Context panel narrow, task wide (about 40/60 or 38/62) on auth and detail pages. (C5Ih77VOcm2, DW87CGQDKbY)
3. Form and dialog titles name the task in plain words. (C5Ih77VOcm2)
4. Minimal signup or invite (three fields) and collect the rest later. (C5Ih77VOcm2)
5. Review every screen on a real phone in one hand, outdoors, with gloves. (C5Ih77VOcm2)
6. Golden spacing 8/13/21/34/55 as inspiration only; tokens named by role. (DW87CGQDKbY)
7. A 61.8/38.2 split for document, request, project and equipment detail pages. (DW87CGQDKbY)
8. A gentler type ratio (about 1.2 to 1.25) for dense screens, with one display size for the single hero number. (DW87CGQDKbY)
9. The primary metric card carries its own breakdown. (Dc-4jNbtyJg)
10. One wide hero card plus three compact rows with right-aligned deltas. (Dc-4jNbtyJg)
11. An accent sparkline beside the hero number instead of a badge. (Dc-4jNbtyJg)
12. 7d / 30d / 90d presets on time charts. (Dc-4jNbtyJg)
13. A "…" overflow menu for table-level actions, the only thing with a shadow. (Dc-4jNbtyJg)
14. The five AI tells as a screen audit. (Dc-4jNbtyJg)
15. The tapped row or card morphs into the page header. (Dd8tUtdhVYZ)
16. Rows slide to new places on sort, filter and delete. (Dd8tUtdhVYZ)
17. A dialog grows from its trigger and returns to it. (Dd8tUtdhVYZ)
18. The theme spreads as a circle from the toggle, kept to 300 ms or less. (Dd8tUtdhVYZ)
19. Cross-document transitions for separate public pages. (Dd8tUtdhVYZ)
20. A count beside every list title. (Dd8tUtdhVYZ, De1Swx4hE8W)
21. The eight-skill review rubric (intent, hierarchy, states, form UX, feedback, audit, design system, character). (DdxNRopKTZo)
22. "Screens first, then code": numbered decisions (primary action, columns, states) before building. (DdxNRopKTZo, De1Swx4hE8W)
23. UX notes inline in code review. (DdxNRopKTZo)
24. A metric block made of a mono overline with the period, one huge number and a plain secondary row with no cards. (DdxNRopKTZo)
25. Two type weights only (800 / 400). (DdxNRopKTZo)
26. The active nav item gets a 2 px accent bar; no icon squares. (DdxNRopKTZo)
27. Drop chatty subtitles. (DdxNRopKTZo)
28. A one-line "why it works" next to each design decision in DESIGN.md. (DdxddtWBsl_)
29. Eye-path test: number the three things to see and check the weights. (DdxddtWBsl_)
30. "Forgot password?" on the "Remember me" row. (DdxddtWBsl_)
31. A surface lit from above (lightness only) for dialogs and the auth card. (DdxddtWBsl_)
32. Done checklist items get a check and strikethrough; the next item gets an accent outline. (De1Swx4hE8W)
33. A checklist task opens as a bottom sheet over the list ("task 2 of 3"). (De1Swx4hE8W)
34. Prefill forms from earlier answers. (De1Swx4hE8W)
35. "You can change it later." under first-run choices. (De1Swx4hE8W)
36. A one-time coach mark labeled "1 tip" with "Got it", instead of top banners. (De1Swx4hE8W)
37. Starter suggestion chips above an empty Ask box, with domain examples. (Deh4XHEqzX_)
38. Scope or setting chips inside the composer toolbar ("This project" / "All libraries"). (Deh4XHEqzX_)
39. A mic for dictating field notes. (Deh4XHEqzX_)
40. Specify components as layers with one job each (container, attachments, text, toolbar). (Deh4XHEqzX_)
