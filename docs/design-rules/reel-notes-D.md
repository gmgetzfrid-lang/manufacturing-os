<!-- Per-reel notes, batch D. Source for docs/design-rules.md, which holds the merged, settled rules. -->
# Rulebook, batch D (8 reels)

Reels: `reels/` Del7XTgsuwI, Df5UFrADYCN, DfIaULMIRC-; `reels3/` (the five sign-in reels, music only, so every rule here comes from the frames) DauPSfKIycn, Ddg450QpmE2, DeefFnvTwrm, DfFL1glpnYi, DfaHwqVu06h.


Tags: **[new]** = not in the earlier notes (ux-reels-notes.md, reels2/notes-1..3.md). **[earlier]** = already there; kept because this pass adds numbers, details or places in the app. App file names below come from a read-only look at the repo (no edits, app not run).

---

### Del7XTgsuwI: Six more UX laws, proven on screen (@motion_ui_interface, 97 s, "UX laws in action, part 4")
What it shows: Six laws, each as a "✕ bad vs ✓ good" pair of phone cards on a dark navy grid, with a measured number under each card, a "WHY IT WORKS" line, a blue "RULE" chip and a source line (Gestalt closure; Gestalt figure-ground; Benway & Lane 1998; Parkinson 1955; Palmer & Rock 1994; Iyengar & Lepper 2000). A 6-segment progress bar at the top shows which law you're on. It ends with a summary table: "Twenty-four laws. Four parts."
Best frames: rulebook-frames/Del7XTgsuwI/t15.jpg, t30.jpg, t47.jpg, t60.jpg, pk_strip.jpg, t76.jpg, t91.jpg, t96.jpg.

RULES:
- R: **Never end a sideways row exactly at the edge. Let the next item show cut off.** The reel: "✕ Cards fit exactly: 0% of the next card shows" vs "✓ Next card peeks: 32%", which is "0px vs 48px of card 3". Why: "The eye completes shapes that are cut off. A clipped card reads as part of a row that keeps going." Two cards that fit exactly "look like the whole set". Applies in our app to: every row that scrolls sideways at phone width: tab strips, filter chips, stat or KPI card rows, kanban columns, attachment and photo strips, template pickers, wide tables on a phone. Check: at 375 px, scroll to the start of each sideways row. The last visible item should be cut, with about 40 to 60 px (about a third) showing. If items fit exactly or end on a gap, change the item width or the padding. [earlier; the 48 px and "card 3" measure are new]
- R: **Dim the page behind anything that needs a decision.** The reel: "✕ No backdrop" leaves the page text at 17.4:1 contrast. "✓ 70% backdrop" brings it to 2.5:1 ("WCAG contrast of the page's own text"). The page stays faintly visible, not hidden. Why: "The eye splits every screen into front and back. Dimming the back leaves one thing to look at." Applies in our app to: components/ui/Modal.tsx (one backdrop for every dialog), confirm dialogs, phone bottom sheets, full-screen viewers. Check: Modal.tsx uses `bg-[var(--color-ink)]/55`. Open a dialog over the Documents table and measure body text through the backdrop. Aim for about 2.5:1, no more than 3:1. If it's higher, move toward 70%. Menus and popovers that don't block the page don't need a backdrop. [earlier; "70%" and "page's own text" as the measure are new]
- R: **Confirm text names the count, the object and the consequence. The button repeats the verb.** Shown on screen: "Delete 3 photos?" / "You can't undo this." / [Cancel] [Delete]. Why: people read the button, not the paragraph, and the second line is the only warning they get. Applies in our app to: delete a document, remove a user, revoke a share link, unlock a locked report, supersede a revision, void a signature. Check: find confirm dialogs that say "Are you sure?", "OK" or "Yes". Each should read "<Verb> <n> <things>?", then the consequence, then a "<Verb>" button. [new]
- R: **Don't make important things look like ads. Put the warning in the content, next to the thing it's about.** The reel: "✕ Styled like an ad" got "0 looks at the card-expiry notice". It was ALL CAPS "CARD EXPIRES FRIDAY!", a striped or gradient box, a decorative star icon and "Tap to update now ›", placed at the top above the balance. "✓ Styled like content" got "2 looks". It was a normal list row under the balance: a ⚠ icon, "Card ending 4421 / Expires Friday" and an inline "Update" button. Source: Benway & Lane 1998 ("gaze path is a model"). Why: "People learn to skip anything that looks like an ad. Bright boxes at the top get filtered out first." Applies in our app to: overdue transmittals, "PSSR not uploaded", MOC pending, expiring temp passwords or certificates, offline and sync warnings, AI suggestions, the "1 thing needs you" hero lines. Check: each warning (a) sits beside or under the object it's about, (b) uses the same row style as the content around it, (c) uses sentence case with no "!", (d) names the item (tag or document number and the date), and (e) has a verb button that fixes it ("Upload PSSR", "Renew"). Look for full-width colored bands at the top of pages. [earlier; the 5 specifics are new]
- R: **Fill in what you already know. Put the field that can look up the rest first.** The reel: typing street, city and postcode takes "30 keys". Postcode lookup takes "7 keys": the postcode field comes first, with a "📍 Find" action inside it. Typing "NW1 6XE" shows two matches ("221B Baker Street, London", "221 Baker Street, London"). One tap fills Street and City, which stay editable. "Continue" stays dimmed until the address is complete, then turns white. Parkinson's law (1955). Why: "A task swells to fill the time it is given. Every key you save is time it can't take." Applies in our app to: tag number → equipment description, unit, P&ID and service; document number → title, discipline, current revision; user email → name and company; unit → area and supervisor. Shift report: date = today, shift from the clock, crew and supervisor from the last report. New request: requester = me, unit from the current project. Transmittal: recipients from the project's distribution list. Check: count the keys needed for a typical new drafting request on P-2001. Anything the app already knows (user, project, unit, date, shift, last value used) should be filled in or one tap away. [earlier; "lookup first, picks stay editable, Continue lights up when complete" are new]
- R: **Join the steps of a flow with one line, and color the line up to the current step.** The reel: four separate dashed circles read as "4 groups the eye sees". The same circles on one line read as "1 group". Done steps show a check. The current step has a bright ring around its number and a bold label. Later steps are faint. The line is solid up to the current step and faint after it. Palmer & Rock 1994. Why: "Things joined by a line read as one group. The line also shows the order to read them in." Applies in our app to: components/ui/StepPath.tsx (already draws the line, colored up to the current step), project close-out steps, document lifecycle (Draft → Check → Approve → Issue), drafting request status, MOC workflow, revision history, turnaround phases. Check: any status sequence drawn as loose chips or badges with no line should reuse StepPath. [earlier; the done / current / future styling is new]
- R: **Show about 6 options up front, not 24.** The reel: "24 options": "3% of shoppers bought". "6 options": "30%". Iyengar & Lepper 2000 jam study. Why: "Every extra option is one more comparison. Past a point, people stop comparing and leave." Also shown: the 6 options get bigger tiles. The chosen one gets an accent border and a check badge in its corner, and the button confirms in place ("✓ Added to cart"). With nothing chosen, the button is dimmed. Applies in our app to: Add widget, template pickers (document, transmittal, report), "New…" type menus, export formats, filter panels, "..." menus, AI suggested actions. Check: count the options each picker shows at once. Above about 6 or 7, show the 6 most used (for this user or site), then "More…" or a search, and preselect the usual one. [earlier; the selected-state and in-place confirmation are new]

IDEAS:
- I: Back each design rule with a measured number shown side by side (0% vs 32%, 17.4:1 vs 2.5:1, 30 vs 7 keys). Where it could serve us: design reviews and PR descriptions ("keys to log a shift entry: 41 → 12").
- I: Count keys and taps for the 5 most common tasks and track them. Where it could serve us: shift report entry, new request, document lookup.
- I: Format for our own rulebook: a "✕ / ✓" pair, a one-line "Why it works" and a RULE chip, indexed like the reel's 24-law table.

Not for us: nothing. The fintech, shop and photo-app examples all translate.

---

### Df5UFrADYCN: The perfect notification badge (@designmotionhq, 52 s)
What it shows: Dark grid with a teal accent. Seven sections ("Cap the count", "Pin it to the corner", "Two signals, not one", "One signal per row", "Open it, clear it", "Count up, never blink", "Badge the decision, not everything"), each with a legend chip ("reflows / locked", "anchored / drifts", "clears / lingers", "rolls / blinks", "noise / signal"). It opens with "ONE RULE, EVERY SURFACE": mail (3), bell (9) and chat (12) icons with the same badge.
Best frames: rulebook-frames/Df5UFrADYCN/g_a.jpg, t07.jpg, t12.jpg, t18.jpg, t24.jpg, g_open.jpg, g_count.jpg.

The app already follows most of this in components/notifications/NotificationBell.tsx (its header comment quotes these rules). The job is to apply the same rules to every other count.

RULES:
- R: **Cap counts at 99+.** "15 · uncapped: the pill grows without limit" (reflows) vs "99+ · capped: width is bounded, layout holds" (locked). Applies in our app to: the bell, sidebar nav counts, tab counts, Inbox, kanban column headers, filter chips. Check: set a count to 100, 1,000 and 12,345 in each spot. It shows 99+ and nothing moves. Every count should go through `badgeText()` (lib/badge). [earlier]
- R: **Pin the badge to the icon's top-right corner so it grows left, and give it a 2 px ring in the page color.** "icon fixed · grows left" vs "icon slid 48px" (the badge was in the layout flow). Why: "One digit or three, the icon never moves under it." Applies in our app to: every icon or nav item with a count. Check: change a count from 1 to 348. The icon and label don't move. The bell's header version already has `ring-2 ring-[var(--color-canvas)]`. Check the collapsed-sidebar and list versions. [earlier; the ring is new]
- R: **A count and a status are different things with different rules.** The reel's table: a count (red, "a number you clear") answers "how many", means "act now" and changes "on each new item". A status (green dot, "a condition, no number") answers "which state", means "nothing" to do and changes "on presence". "A count is not a status · different signals, different rules." Applies in our app to: PresenceIndicator (who's viewing), online and sync state, "new" markers, unread counts. Check: status dots never carry a number and are never red. Counts are never green. [earlier]
- R: **Dot or number, never both on the same row.** "Deploy Bot: ● 3 → which one?" is tagged "noise". "Both answers the same question twice: dot + 3 → pick one." Applies in our app to: notification rows, document rows with unread comments, request rows. Check: rows showing both → keep one. [earlier]
- R: **Clear the badge the moment the view is opened, and show that it cleared.** Read rows turn muted and their dot becomes a ✓. The header shows "✓ cleared". The bad version still shows "12" after opening, tagged "still 12?". Why: "A badge that never clears trains people to ignore it." Applies in our app to: bell, Inbox, comment threads, "new revision" markers, chat. Check: open each badged view. The badge drops at once, with no reload. [earlier; the muted read rows with ✓ and the "cleared" header are new]
- R: **Counts only go up on screen, with a roll; they never flash to 0.** "clean 3 › 4 › 5 › 6" vs "buggy 5 › 0 › 6 › 0 › 7". "Counts only climb · a reset to zero reads as a broken badge." Applies in our app to: any live count (realtime updates or refetch). While refetching, keep showing the last value. Check: slow the network, trigger a refetch, and watch every count. Nothing should show 0 while loading. [earlier; the "rolls up" animation is new]
- R: **Badge only what needs a decision.** "✕ Badge everything" (Messages 4, Mentions 9, Product updates 2, Promotions 17, System 1 = 5 badges) vs "✓ Only what needs you" (Mentions 3 = 1 badge, and that row is tinted). "Badge everything and nothing stands out · signal needs silence." Applies in our app to: sidebar sections, tabs, project cards. Plain totals ("1,204 documents") are gray text, not red badges. Check: list every red badge. Each must count things waiting on this user's decision. [earlier]
- R: **One badge component and one set of rules on every surface.** "ONE RULE, EVERY SURFACE." Check: one badge class (`ui-badge`) everywhere. No hand-made red circles in pages. [new]

IDEAS:
- I: Make a changing number roll up like an odometer (components/ui/CountUp.tsx exists). Where it could serve us: bell count, hero numbers, progress %.
- I: Read rows go muted with a trailing ✓; unread rows stay bright with a dot. Where it could serve us: NotificationCenter, NeedsTable, comment lists.
- I: Tint the one row that carries the badge. Where it could serve us: sidebar item with pending decisions.

Not for us: nothing.

---

### DfIaULMIRC-: One color that stands out (@niki.aroca, 19 s, talking head)
What it shows: Three landing pages, each first shown with two colors and then with a third "surprise" accent. Swatch cards show the names and hex codes. Two of the nine hex labels are copy-paste mistakes in the reel; the bracketed values are sampled from the frame.
- Editeaze (video app): Charcoal Black #21232E, Royal Blue #105BFF, + Tangerine Orange #FE8500. The orange is on the "Get started" button, the "CC" button in the phone mockup and the photo frames.
- "Visualize your mind in motion": Marshmallow White #F0F0F0, Galactic Violet (labeled #105BFF, actually about #5630F7), + Bubblegum Pink (labeled #FE8500, actually about #F355D0). The pink is on the "Start Reading Your Mind" button and in the headline gradient.
- Globlyn ("Hire Top Global Talent Without Borders"): Aqua Jade #74FFED, Midnight Abyss #171F44, + Baby Pink #FE81D1. The pink is on the "Start Hiring Today" button and the dots and lines on the globe.
Best frames: rulebook-frames/DfIaULMIRC-/swatches.jpg, swatches2.jpg, pages.jpg.

RULES:
- R: **The accent covers a small area and lands on the action.** In all three pages it's the main button plus 2 or 3 tiny details. The two base colors carry everything else. Why: "You don't need more colors, you just need one color that surprises people." Applies in our app to: the action color: primary buttons, links, the focus ring, the selected tab. Check: count the accent spots per screen (blur test). Anything accent-colored that isn't clickable or selected is misuse. [earlier]
- R: **Pick the accent far from the base hues.** Blue base → orange. Navy and aqua → pink. White and violet → hot pink. The surprise comes from the change in hue, not from adding colors. (This is the pattern across all three examples; the reel doesn't say it out loud.) Applies in our app to: choosing the single action color against the app's neutral and navy canvas. [new]
- R: **Bright accents fail as text on white, so check before using one for links or labels.** Measured from the reel's hex codes: #FE8500 on white is 2.45:1. #FE81D1 on white is 2.26:1. #F355D0 on #F0F0F0 is 2.62:1. White text on #FE8500 is 2.45:1. All are below 4.5:1 for text, and the pinks are below 3:1 even for shapes. The same accents on the dark bases pass: #FE8500 on #21232E is 6.37:1, and #FE81D1 on #171F44 is 7.05:1. Applies in our app to: links, small accent text, state tags, button labels on accent fills. Check: accent text against the canvas ≥ 4.5:1, button label against the accent fill ≥ 4.5:1, accent shapes ≥ 3:1. Use dark text on a bright fill, or a darker shade of the accent for text links. [new]
- R: **Don't trust hex codes in inspiration posts. Sample them.** Two of the nine labels here are wrong. [new]

IDEAS:
- I: One "surprise" accent on a two-color base. Where it could serve us: the sign-in screen and /about. For example, a flare orange against steel and navy. In the working app the accent must only ever mean "you can act here".
- I: Repeat the accent in 2 or 3 tiny details on the same page (a dot, a line) to tie the page together. Where it could serve us: marketing and sign-in only.

Not for us: gradient hero art and huge condensed display type ("TRANSFORM YOUR CONTENT", "VISUALIZE YOUR MIND IN MOTION"). That is landing-page styling and doesn't suit a dense work tool. It is OK on /about.

---

### DauPSfKIycn: Animated login form, built in Visme (@_code_and_chill_, 8 s, music only)
What it shows: A 3D cartoon man drags a blue pole across a pale blue-gray page, captioned "Wait for Login Form!". He stands the pole up, and the form unrolls from it left to right like a blind (about 3.6 to 4.5 s). The embed code shows below: `<div class="visme_d" data-domain="forms" data-form-id="190176">` plus `visme forms-embed.js`. The form: "Welcome back", "Email *" (envelope icon, placeholder "you@example.com"), "Password *" (already shows dots), a full-width blue "Log In", "Never submit passwords through Visme forms. Report malicious form", "BY CLICKING ON THE BUTTON YOU ACCEPT OUR PRIVACY POLICY" (tiny capitals) and a "Powered by Visme Forms" chip.
Best frames: rulebook-frames/DauPSfKIycn/unfold2.jpg (the unroll), unfold.jpg, form.jpg.

RULES (mostly from what it gets wrong):
- R: **No entry animation may delay the first usable field.** Here the form doesn't exist for about 4.5 s. Rule: a page or dialog accepts typing at once. Any reveal is ≤ 300 ms and never blocks focus. Applies in our app to: sign-in, every page load, dialogs, wizards. Check: on a phone over 4G, time from navigation until the email field accepts a key. Dialog open animations don't delay focus. [new]
- R: **Credential fields only on our own pages, never in an embedded third-party form.** The form builder warns about itself: "Never submit passwords through Visme forms." Applies in our app to: sign-in, set password, signup/finish, the signature ceremony password, data export, change password, the AI settings key. Check: no iframe or embed hosts any password or key field. [new]
- R: **Labels line up with the field's left edge.** Here "Email *" and "Password *" are centered over left-aligned fields under a left-aligned title, so the eye zigzags. Applies in our app to: every form (components/ui/Field.tsx). Check: labels share the field's left edge everywhere, including dialogs and the shift report. [new]
- R: **Legal and consent text in sentence case at readable size (about 12 to 13 px or more on a phone), never tiny capitals.** Applies in our app to: signup, data-portability, terms acceptance, the signature ceremony statement. Check: no all-caps sentences, and the size meets the body minimum. [new]
- R: **Mark the few optional fields "(optional)" instead of putting "*" on every field.** Here every field is starred. The app already does "(optional)" on company phone. Applies in our app to: all forms. Check: forms where every label has "*". [new]

IDEAS:
- I: Things enter from where they come from. The form unrolls from the edge it's attached to, in reading direction. Where it could serve us: a side drawer slides from its edge, an inline "Add row" grows from the button that made it, a details panel expands from the row.
- I: A leading icon for the field type (envelope) plus an example placeholder ("you@example.com"). Where it could serve us: email, tag, document number and date fields.

Not for us: the mascot animation and "Wait for Login Form!". It's playful and makes people wait, which conflicts with a tool used under time pressure.

---

### Ddg450QpmE2: "This Login Form is TOO Smooth" (DailyFlutterUI, Flutter on an iPhone 17 Pro Max simulator, 31 s, music)
What it shows: A splash where the logo is drawn as line art with construction points, then filled, then "DailyFlutterUI / A daily dose of beautiful Flutter UI.", then zooms and fades (about 7 s in all). Then the sign-in screen. A dark header with animated lightning, the logo, "Welcome back." (serif italic) and "Pick up where you left off: your kits are waiting." A white bottom card slides up, starting dimmed. It holds a segmented "Sign In | Sign Up" switch, "Email address" and "Password" (gray filled fields, mail and lock icons, eye-slash toggle), "☑ Keep me signed in" (checked) and "Forgot Password?" on one row, a blue "Sign in", "OR CONTINUE WITH", Google and Apple buttons, and "New to DailyFlutterUI? Create an account".
The user presses Sign in with both fields empty, types the email, types the password, and presses again. A spinner, then a check, then a "Beautiful UI. Ready to build." screen ("Get Started", "17 complete kits · 200+ screens · source included"), then home ("Featured kits": stacked swipeable cards, filter chips, bottom nav).
Field states seen: **rest**: light gray fill, no border, gray icon and placeholder. **Error**: red 1 px border, pale red fill, red icon, red placeholder, and under the field a red "!" dot with the message. **Focused**: blue border, pale blue fill, blue icon. **Filled and not focused**: back to neutral gray.
Best frames: rulebook-frames/Ddg450QpmE2/zoom_states.jpg (rest/pressed, both errors, focus, spinner, check, pressed), grid_01.jpg (the error → typing → cleared sequence), grid_02.jpg (password, loading, success, next screen).

RULES:
- R: **Submit can always be pressed. Pressing it with missing input marks every missing field at once, each with its own message.** Sign in stays enabled while the fields are empty. One press shows "Enter your email address." and "Enter your password." together. Why: people see every problem in one go, while a disabled button explains nothing. Applies in our app to: the submit of every form: New request, New project, Edit project, invite user, Companies, shift report Save and Lock, transmittal Send, Set password, Start a workspace. Check: press submit on an empty form. Every required field shows its own message, focus moves to the first one (a standard; add it), and the button never just stays dead. [new]
- R: **After a failed submit, check again on every keystroke and clear each error the moment the value is valid.** This is "reward early, punish late". The password error vanished at the first character typed. The email stayed red through "da", "daily…" and "dailyflutterui@gmail." and cleared at "…gmail.com" (the field turned blue). Together with the earlier rule (a first error only shows after leaving the field), this gives the full timing: first check on blur or submit, then live re-checks until it's valid. Applies in our app to: every validated field (Field.tsx says "after the person leaves the field, never while they type", which covers the first error only). Check: cause an error, then type a valid value. The red clears without leaving the field. [new]
- R: **The message says what to do and matches the actual problem.** Messages are short instructions with a period: "Enter your email address." The flaw: the same message stayed while a half address was typed. It should change to the real problem ("Enter the whole address, like name@company.com"). Applies in our app to: all validation messages. Check: empty, malformed and duplicate values give three different messages. [new]
- R: **The error state uses at least three cues, not color alone:** border, a fill tint, the icon turning red, and a message with an icon. Applies in our app to: the Field.tsx error state (today a red border via aria-invalid and a message with CircleAlert, which meets this). Check: in a grayscale screenshot the errored field is still obvious. [new]
- R: **Error messages must not shove the layout around.** The card is anchored to the bottom. When the two messages appeared it grew upward by about two lines and moved the title. As they cleared, it shrank back. Rule: animate height changes (about 200 ms) or keep a helper-text line reserved. A message must never move the submit button away from where the thumb is. Applies in our app to: all forms, phone bottom sheets, dialogs. Check: at phone width, cause and clear errors and watch the submit button's position. [new]
- R: **Pressed, loading and success all happen inside the button, in the same spot.** Pressed: a darker blue and a slight shrink (about 480 → 470 px wide, ~0.98 scale). Loading: the button collapses into a circle with a spinner (about 1 to 1.5 s). Success: the circle shows a ✓ (about 0.5 s), then the next screen. Applies in our app to: every save, send, lock, issue and submit button (components/ui/Button.tsx already has `loading` and `done`). Check: tap each async button. A pressed state within 100 ms, the spinner in place, a ✓ with a past-tense word, a second tap ignored, then close or navigate. [earlier; the measured shrink and timings are new]
- R: **Every password field has a show/hide (eye) toggle.** It appears in this reel, in DeefFnvTwrm and in DfFL1glpnYi. Why: people on phones and with gloves mistype, and the toggle is what lets you drop the "confirm" field. Applies in our app to: the 14 `type="password"` inputs in 7 files: app/page.tsx (sign-in), app/set-password, app/signup/finish, components/admin/ChangePassword.tsx, components/signatures/SignatureCeremony.tsx, admin/data-export, components/knowledge/AiSettingsModal.tsx. **None of them has a toggle today.** Check: each gets an eye button inside the field with aria-label "Show password" / "Hide password" and aria-pressed. [new]
- R: **"Forgot password?" sits right next to the password field.** Here it's on the "Keep me signed in" row, in DeefFnvTwrm it's on the password label row, and in DfFL1glpnYi it's right-aligned under the field. Why: you offer the way out where the failure happens. Applies in our app to: sign-in. Today the help is a sentence in the footer ("Forgot your password? Ask them to reset it."). Check: put a short "Forgot password?" link on the password label row that opens that explanation, and also show it inside the "wrong password" error. [new]
- R: **"Keep me signed in" is an explicit choice next to the submit, and its row is a full touch target.** It's pre-checked here. For us the right default depends on the device: shared control-room PCs vs personal phones. The app's label "Keep me signed in on this device" is right. Check: the label row is at least 44 px tall on touch (today `min-h-8`, 32 px, with a 16 px box). [new]

IDEAS:
- I: A segmented switch at the top of one card that swaps the form in place ("Sign In | Sign Up"). Where it could serve us: two-mode forms (Report / Meeting on the shift report, Upload / Link for documents).
- I: A subtitle that promises continuity: "Pick up where you left off: your kits are waiting." Where it could serve us: the sign-in subtitle with the workspace and the last place ("Pick up Unit 200 turnaround where you left off"). Then actually land there after sign-in. In this reel a marketing "Get Started" screen sat between sign-in and the work. Don't do that.
- I: The home deck shows stacked cards with the next ones peeking, and the 4th filter chip is cut off at the edge (closure again). Where it could serve us: phone views of project cards and filters.

Not for us: a 7-second splash with the logo being drawn, the animated lightning background, a serif italic display title. They are decoration that delays the work.

---

### DeefFnvTwrm: Login and OTP animation (@code.xr / Arastoo, React + CSS + framer-motion, 9 s, music)
What it shows: A desktop card split in two.
- Left: a peach-orange gradient panel with product cards made to look real: "Total balance $48,290.50 ▲12.4% This month", "Payout sent · To Nova Studio $860.50" (which changes to "Bright Foods $2,315.00", then "Lumen Labs $540.00"), "98.6% Success rate" and "Instant settlement". Headline "You can easily / Effortlessly manage your payments and payouts in one place." A purple smiley orb mascot.
- Right: an orange asterisk mark and "Welcome back", with the subtitle "Access your payments, payouts and reports anytime, anywhere - and keep everything flowing in one place." Then "Your email" (label above, with the browser's password-manager key icon in the field), "Password" with "Forgot password?" at the right of the label row and an eye toggle, a black "Log in" with a soft shadow, "or continue with" and Google / GitHub / Apple icon buttons, and "Don't have an account? Sign up" (orange).

The flow:
1. Log in → the button shows a spinner and "Logging in".
2. The login content blurs and fades out while the asterisk stays.
3. "Check your email" fades in: "We sent a 4-digit code to **test@gmail.com**. Enter it below to continue." There are 4 boxes (the first focused with a caret), "Code expires in **0:45**" counting down, a faint "Resend code", a gray (disabled) "Verify & continue" and "Wrong email? Go back".
4. The digits advance box to box (4 5 4 5). At the 4th digit the button turns black.
5. Click → "Verifying" with a spinner. The boxes glow orange and "Go back" dims.
6. The boxes collapse into one green square, the button turns green with "✓ Verified", and the heading and text fade.

Best frames: rulebook-frames/DeefFnvTwrm/ui_full.jpg, zoom_otp.jpg (Logging in, empty code, complete code, Verifying ×2, Verified), grid_00..02.jpg.

RULES:
- R: **While working, the button label changes to the -ing form of its verb; when done, it changes to the past tense.** "Log in" → "Logging in". "Verify & continue" → "Verifying" → "✓ Verified" (in green). Why: the button you're watching tells you what's happening and that it worked. Applies in our app to: every async button. Save → Saving → Saved. Send → Sending → Sent. Lock report → Locking → Locked. Issue package → Issuing → Issued. Upload → Uploading 40% → Uploaded. Sign-in already says "Signing in" and "Signed in". Check: find Buttons that get `loading` but keep the same words, and give each its two extra words. [new]
- R: **While a request is in flight, freeze everything that could conflict with it.** The fields, the "Wrong email? Go back" link (dimmed during "Verifying") and the alternate sign-in buttons. A second submit can't happen. Applies in our app to: every submit. Back in a wizard while it saves. Closing a dialog mid-save (Modal.tsx has `dismissable={false}` for this). Pressing Enter again. Check: while a save is running, try to type, press Back, close the dialog and press Enter. Nothing gets through. On sign-in today only the Microsoft button is disabled during password sign-in, and the fields stay editable. [new]
- R: **Moving between steps keeps an anchor still.** The asterisk mark and the card frame stay put. Only the step's content swaps: the old step blurs and fades out in about 0.25 s, and the new one fades in top to bottom. Why: people keep their place, and it reads as the same flow. Applies in our app to: every multi-step flow. ProjectWizard, the document Split and Merge wizards, signup → finish, set password → signed in, the signature ceremony steps, share-link code → document. Check: when stepping forward, the header, stepper and buttons don't jump and the swap finishes in ≤ 300 to 400 ms. [new]
- R: **The next step repeats what the user gave, and offers a way back to change it.** "We sent a 4-digit code to **test@gmail.com**" + "Wrong email? Go back". Applies in our app to: any step that depends on the last answer. "Invite sent to **j.lee@kern.com** · Change". Transmittal: "Sending to **6 people at Kern Energy** · Edit list". Reset: "We sent a link to …". Wizard review steps. Check: each confirmation or next step shows the key input in bold and has a link back to change it. [new]
- R: **Anything that expires shows a live countdown and what to do when it runs out.** "Code expires in 0:45", ticking 0:45 → 0:42, plus "Resend code" (faint until it's allowed). Applies in our app to: share-link codes, session expiry, temporary passwords (components/admin/TempPasswordNotice.tsx), signature re-authentication windows, edit locks, time-boxed approvals. Check: each one shows the time left and the recovery action. [new]
- R: **Code entry: one box per digit, the first focused, typing moves to the next box, and the button turns on only when the code is complete.** Gray "Verify & continue" turns black at the 4th digit. Add the standards: pasting fills every box, Backspace steps back, `autocomplete="one-time-code"` and `inputmode="numeric"`. Applies in our app to: app/share/[token]/page.tsx `CodeBoxes`, which already does all of this, opens on the 6th digit and says "Type all six digits to open it." Check: keep it as the model for any future code entry (email change, 2-step sign-in). [new]
- R: **A disabled submit is OK only when what's missing is visible and obvious (4 empty boxes). Otherwise keep it pressable and explain on press** (see Ddg450QpmE2). Even when disabled, say why in a line of text. Applies in our app to: all forms and wizards (ProjectWizard Basics today disables Next silently, per earlier notes). [earlier, refined]
- R: **Show success on the thing you acted on, then move on.** The 4 boxes merge into one green tile and the button turns green "✓ Verified". Applies in our app to: Lock report (the report header changes to "Locked ✓"), Issue IFC (the package row reads "Issued"), signing (the signature block shows the stamp), uploads (the row shows the file). Check: after each action, the object itself shows the new state, not only a toast. [new]
- R: **Don't block password managers.** The key icon in the email field shows the browser recognized the sign-in form. Use `autocomplete="username"` or `"email"`, `"current-password"` and `"new-password"`, and never disable paste. Applies in our app to: all credential fields (set-password, signup/finish and ChangePassword already use `new-password`). Check: Chrome and iOS offer to save and fill on sign-in, and offer to generate on set-password. [new]

IDEAS:
- I: The brand panel shows the product itself, with believable example data that changes (the "Payout sent" card cycles through three payees). Where it could serve us: the desktop sign-in left panel could hold a small Manufacturing OS scene with made-up sample data, such as a turnaround progress card, "IFC Rev C issued to Kern Energy" and a shift report line. On a phone it becomes a top band (earlier note 20).
- I: A hint appears near the stuck spot when the user pauses (the "Enter your OTP" speech bubble over the code step). Where it could serve us: after about 10 s with no input on a step, one gray line ("The code is in the email from Manufacturing OS, check Junk too"). No mascot.
- I: Several inputs merge into one success mark (4 boxes → one green tile). Where it could serve us: a multi-file upload finishing as one "12 files uploaded ✓" row.
- I: Social sign-in as same-size icon buttons in one row. Where it could serve us: if more company providers are added (Microsoft, Google Workspace).

Not for us: the mascot with expressions and the decorative peach gradient. Also, the "live" data on a page shown before sign-in must be clearly made up. Never put real plant or project data on an unauthenticated page.

---

### DfFL1glpnYi: "Beautiful Login Page in Flutter" (DailyFlutterUI, 13 s, music)
What it shows:
- A splash: a teal circle grows, the "P" mark draws itself and the "Fruzzdigital" wordmark is revealed left to right. Then a plant photo fades in at the top and the logo moves up into its place. The buttons appear one after another: a black "Login", an outlined "Register" and a teal link "Continue as a guest".
- Tapping Login shows a ripple from the tap point. The login screen slides in from the right: a back button (rounded square), "Welcome back! Glad to see you, Again!", "Enter your email", "Enter your password" (eye), "Forgot Password?" right-aligned under it, a black "Login", "Or Login with" with Facebook / Google / Apple boxes, and "Don't have an account? Register Now".
- Back (the back button turns gray while pressed) slides the screen out to the right and shows the welcome screen again.
- Register: "Hello! Register to get started" with Username, Email, Password (eye), Confirm password (eye), "Register", "Or Register with" and "Already have an account? Login Now". That link goes to Login, replacing Register.

Best frames: rulebook-frames/DfFL1glpnYi/zoom_press.jpg (ripple, login, slide-out, welcome), grid_00..02.jpg.

RULES:
- R: **Movement direction means something and never changes.** Forward: the new screen slides in from the right and the old one shifts left beneath it. Back: the current screen slides out to the right (about 0.3 s; one 4 fps frame caught it mid-slide). Applies in our app to: phone navigation (list → detail → back), wizard Next and Back (Next moves content left, Back moves it right), drawers. Check: on a phone, open a document and go back. The motion matches, and Back never animates like Forward. [new]
- R: **Every press shows a response where you pressed, within about 100 ms.** A ripple on Login, a gray fill on the back button while held. Applies in our app to: all buttons, list rows, tabs and icon buttons (the app's `ui-press` class). Check: on a phone, press and hold one of each kind of control. There's a visible pressed state, including table rows and icon-only buttons. [earlier, as "press scale"; the press on rows and icon buttons is new]
- R: **Switching between sibling flows replaces the screen instead of stacking it.** "Login Now" on Register goes to Login. Back from there goes to the welcome screen, not back to Register. Applies in our app to: Sign in ↔ Start a workspace, Report ↔ Meeting, tab switches (use router.replace, not push). Check: go Sign in → Start a workspace → Sign in, then press the browser Back. You land on something sensible, not a loop. [new]
- R: **An entry screen has one primary, one secondary and one tertiary action.** A filled "Login", an outlined "Register" and a text link "Continue as a guest". Applies in our app to: empty states, dialogs, page heroes. [earlier]
- R: **No "Confirm password" field when the password field has a show/hide toggle.** This Register form has both. (A widely used standard.) Applies in our app to: app/set-password (`np` and `np2`), app/signup/finish (two new-password inputs) and components/admin/ChangePassword.tsx ("again"). All three have a confirm field and no toggle. Check: replace the confirm field with the eye toggle plus a live rules hint ("At least 12 characters ✓"). [new]
- R: These placeholder-only fields ("Enter your email") and gray fill-only fields with no border break two earlier rules: keep the label above, and give the field edge 3:1 contrast. A light gray fill on white is about 1.1:1. [earlier, reinforced]

IDEAS:
- I: Entry actions appear one after another in reading order (primary, then secondary, then link, about 100 ms apart). Where it could serve us: buttons in empty states and dialogs as they open (keep it short; skip it with reduced motion).
- I: The splash logo becomes the header logo (one element moves into place, no blank frame). Where it could serve us: the PWA launch → app shell (the sidebar logo).
- I: "Continue as a guest" → for us, open a shared document without an account (share links), or a read-only view for control-room screens.
- I: A site photo + logo + three doors as the phone welcome screen. Where it could serve us: the first launch of the installed PWA.

Not for us: Facebook, Google and Apple sign-in. A company workspace app uses company sign-on (Microsoft) and accounts created by an admin. Also not for us: the ~3 s splash before the buttons.

---

### DfaHwqVu06h: "Interactive login screen made in Flutter" (@zain_dev_, 11 s, music, a real phone held in hand)
What it shows: A fintech app called "Aura".
- Start: an orange gradient with blurred content, and at the bottom a glowing blue arc with a ⌃ knob and "Swipe up to get started". Dragging the knob up makes the content less blurred as you go. Let go too early and it springs back down. Drag far enough and a big bubble grows and bursts to show the welcome screen.
- Welcome: "WELCOME TO / Aura, where money meets lifestyle / Your money, your rhythm. Seamless banking that flows with your lifestyle". Dozens of floating avatar bubbles that you can drag (with physics) surround a center bubble whose label cycles RECEIVE → SWAP → SEND. Below: a white "Sign in" pill, a dark "Sign up" pill and "By using our platform, you agree to our terms. Please read them to understand your rights."
- Tapping Sign up: a frosted panel grows out of the Sign up button into a full sheet. It has a grabber and a back chevron, "Create Your Aura" and "Your lifestyle banking experience starts in less than a minute." The phone field has a 🇺🇸 "+1" prefix, the placeholder "Enter Phone", and the caret already in it, with the numeric phone keypad open. A "Use email" link and a "Continue" pill sit right above the keypad. On dismiss, the sheet shrinks back into the button.

Best frames: rulebook-frames/DfaHwqVu06h/zoom_sheet.jpg (welcome, the sheet growing from the button, the sheet with keypad ×2), zoom_swipe.jpg (the drag, the snap back, the reveal), grid_00..02.jpg.

RULES:
- R: **A sheet or dialog grows out of the button that opened it and shrinks back into it on close.** Why: you see where it came from and where it went. Applies in our app to: Modal opened from its button, Add widget, "New request" → form sheet, row → detail on a phone. Earlier note 17 asked for "dialogs grow from their button"; this reel shows it done on a phone sheet, including the close. Check: open and close dialogs from their buttons. With reduced motion, it's a plain fade. [earlier, confirmed]
- R: **When a step has one field, focus it and open the right keyboard straight away.** The phone sheet opens with the caret in "Enter Phone" and the phone keypad up (`type="tel"`). Applies in our app to: code entry, search overlays, rename dialogs, quick-add by tag number, single-field sheets. Don't do it on long pages (the keyboard would cover the content) or on dialogs that start with a choice. Check: each single-field sheet or dialog focuses its field with the right `inputmode`. [new]
- R: **The main button sits just above the keyboard, so nobody has to close the keyboard to continue.** "Continue" is directly above the keypad. Applies in our app to: every phone form and sheet (New request, shift report entries, comment boxes, set password). Use a bottom action bar that follows the visual viewport (`interactive-widget=resizes-content` or visualViewport). The repo has no keyboard or visual-viewport handling today. Check: on an iPhone, focus the last field of New request and of a shift entry. Save must be visible without closing the keyboard. [new]
- R: **Phone fields: country code as its own part of the field, digits only, phone keypad.** "🇺🇸 +1 | Enter Phone". Applies in our app to: company and contact phones (app/(protected)/companies/page.tsx has `type="tel" inputMode="tel" autoComplete="tel"`; companies/[id]/page.tsx has `type="tel"` without autoComplete), user profile, contractor contacts. Check: every phone field has `type="tel"`, `autocomplete="tel"` and shows or accepts the country code. [new]
- R: **Offer the other way to identify yourself right at the decision point.** "Use email" sits directly above Continue. Applies in our app to: sign-in ("Sign in with Microsoft" / "or with a password", which the app has), document search by number or title, equipment lookup by tag or location. [new]
- R: **Say how long it takes.** "starts in less than a minute." Applies in our app to: Start a workspace, setup, New project ("about 3 minutes, 6 steps"), bulk export ("about 2 min for 1,200 files"). Check: every flow longer than one screen gives a time or step count up front. [new]
- R: **A drag follows the finger, shows its effect as you go, and can be cancelled by letting go early.** The blur clears in step with the drag distance, and releasing before the threshold springs everything back. Applies in our app to: drag-to-dismiss sheets, swipe actions on rows, kanban drags, any "slide to confirm". Check: start each drag, let go halfway, and confirm that everything returns and nothing was saved. [new]
- R: **The terms line is a plain sentence, readable, under the buttons.** "By using our platform, you agree to our terms." Compare DauPSfKIycn's tiny capitals. [new]

IDEAS:
- I: A word that cycles to show what the product does (RECEIVE / SWAP / SEND in the center bubble). Where it could serve us: the sign-in panel cycling "Draft · Check · Issue" or "Plan · Execute · Close out".
- I: A grabber bar on phone sheets, so people know they can swipe them down. Where it could serve us: every phone bottom sheet.

Not for us: a swipe-up gate before you can even see Sign in. It's one more gesture before work, people won't discover it, and it's awkward with gloves. Also not for us: physics bubbles with faces and the gradient fintech look.

---

## The five sign-in reels together: one interaction spec for every form in the app

These are the general rules the login reels show, grouped. The sign-in screen is only where they were filmed. Each one applies to every form, every multi-step flow and every submit button in Manufacturing OS.

**1. Field states (every input, select and textarea; components/ui/Field.tsx)**
- Six states, each visibly different: rest, hover, focus, filled, error, disabled or read-only (Ddg450QpmE2, DeefFnvTwrm).
- Error = border + tint + icon + message with an icon. Never color alone (Ddg450QpmE2).
- Focus is obvious on a phone in sunlight: the app-wide 2 px ring, optionally with a light accent tint (Ddg450QpmE2).
- Filled but not focused goes back to neutral. No green check on every valid field (Ddg450QpmE2 shows none).
- Labels sit above and line up with the field's left edge (DauPSfKIycn shows the wrong way). The placeholder is an example (DeefFnvTwrm).
- Password fields: an eye toggle in every one, and no confirm field (Ddg450QpmE2, DeefFnvTwrm, DfFL1glpnYi).

**2. Validation timing (every form)**
- First error: when the user leaves the field, or when they press submit (earlier notes and Ddg450QpmE2).
- Submit with missing input marks all missing fields at once and focuses the first (Ddg450QpmE2).
- After that: re-check on every keystroke and clear the error the instant the value is valid (Ddg450QpmE2).
- The message matches the actual problem and says what to do (Ddg450QpmE2).
- Messages appearing or clearing animate the height or use a reserved line. They never move the submit button (Ddg450QpmE2).
- Disabled submit only when what's missing is obvious, like code boxes, and even then say why (DeefFnvTwrm; app/share CodeBoxes does).

**3. Submit feedback (every async button; components/ui/Button.tsx)**
- Pressed within 100 ms: darker plus about 0.98 scale, or a ripple at the finger (Ddg450QpmE2, DfFL1glpnYi).
- Loading in the same spot: a spinner, and the label changes to the -ing form ("Logging in", "Verifying") (DeefFnvTwrm, Ddg450QpmE2).
- Success: ✓ and the past tense ("Verified"), held about 0.5 s, then move on (DeefFnvTwrm, Ddg450QpmE2).
- During flight: no second submit, fields locked, and conflicting links ("Go back") and alternate buttons disabled (DeefFnvTwrm).
- Success also shows on the object acted on, not only on the button (DeefFnvTwrm).

**4. Moving between steps (every wizard and multi-step flow)**
- An anchor stays still (logo, card, stepper). Only the step content swaps, ≤ 300 to 400 ms (DeefFnvTwrm).
- The next step repeats the key input and links back to change it (DeefFnvTwrm).
- Anything with a deadline shows a countdown and a recovery action (DeefFnvTwrm).
- Forward comes in from the right, Back leaves to the right, and sibling flows replace rather than stack (DfFL1glpnYi).
- Sheets grow from their button and shrink back into it (DfaHwqVu06h).
- Nothing delays the first usable field (DauPSfKIycn, Ddg450QpmE2, DfFL1glpnYi and DfaHwqVu06h all do, which is why it's a rule).
- After sign-in, land on the work, and on where the user left off (Ddg450QpmE2's subtitle promises it; its extra screen breaks it).

**5. Keyboard and phone behavior (every phone form and sheet)**
- One-field steps auto-focus with the right keypad: `tel`, `numeric`, `email` (DfaHwqVu06h, DeefFnvTwrm).
- The primary button stays visible above the keyboard (DfaHwqVu06h).
- Phone fields have a country-code prefix and `type="tel"` (DfaHwqVu06h).
- Autofill and password managers work: the right `autocomplete` values, paste allowed (DeefFnvTwrm).
- Code boxes: `one-time-code`, paste fills them all, Backspace steps back (DeefFnvTwrm, plus the standard).
- The alternative identifier sits at the decision point ("Use email") (DfaHwqVu06h).
- Drags follow the finger and cancel cleanly (DfaHwqVu06h).
- "Keep me signed in" has a full-size touch row, and its default depends on the device (Ddg450QpmE2).

---

## ALL RULES FROM MY REELS
(deduplicated; [new] = not in the earlier notes)

Layout and attention
1. Sideways rows never end exactly at the edge; about a third (about 48 px) of the next item shows. (Del7XTgsuwI)
2. Dim the page behind any blocking dialog or sheet: about 70% backdrop, page text down to about 2.5:1 (from 17.4:1). Measure Modal.tsx's /55. (Del7XTgsuwI)
3. [new] Confirm dialogs: "<Verb> <n> <things>?" + the consequence ("You can't undo this.") + a "<Verb>" button, never OK or Yes. (Del7XTgsuwI)
4. Warnings are content rows beside their object: sentence case, no "!", the named item, an inline verb button. No bright banners at the top (0 vs 2 looks). (Del7XTgsuwI)
5. Fill in what you know. The lookup field goes first, suggestions show under it, a pick fills the rest (still editable). Count the keys (30 → 7). (Del7XTgsuwI)
6. Steps of a flow are joined by one line: done ✓, current ringed and bold, future faint, the line filled up to the current step. (Del7XTgsuwI)
7. Show about 6 options up front, not 24 (3% vs 30%). The pick gets a border and a ✓, and the button confirms in place. (Del7XTgsuwI)

Counts and badges
8. Cap counts at 99+. (Df5UFrADYCN)
9. The badge is pinned to the icon's corner and grows left; the icon never moves. [new] 2 px ring in the page color. (Df5UFrADYCN)
10. A red number is a count you must act on; a green dot is a status. Never mix them, and never both on one row. (Df5UFrADYCN)
11. Clear on open. [new] Read rows go muted with a ✓, and the header confirms "cleared". (Df5UFrADYCN)
12. Counts only go up on screen; never flash 0 while refetching. (Df5UFrADYCN)
13. Badge only decisions that wait on this user; plain totals are gray text. (Df5UFrADYCN)
14. [new] One badge component and one set of rules on every surface. (Df5UFrADYCN)

Color
15. The accent covers a small area and lands on the action (button plus 2 or 3 details). (DfIaULMIRC-)
16. [new] Pick the accent far from the base hues (blue → orange; navy and aqua → pink). (DfIaULMIRC-)
17. [new] Bright accents fail as text on white (2.26 to 2.62:1). Text ≥ 4.5:1, shapes ≥ 3:1. Use dark text on bright fills. (DfIaULMIRC-)
18. [new] Sample hex codes from images; inspiration labels are wrong (2 of 9 here). (DfIaULMIRC-)

Fields
19. [new] Labels line up with the field's left edge; never centered over left-aligned fields. (DauPSfKIycn)
20. [new] Mark "(optional)" on the few optional fields, not "*" on all of them. (DauPSfKIycn)
21. [new] Error state = border + tint + icon + message with an icon, not color alone. (Ddg450QpmE2)
22. [new] Every password field has a show/hide toggle; the app's 14 password inputs in 7 files have none. (Ddg450QpmE2, DeefFnvTwrm, DfFL1glpnYi)
23. [new] No "Confirm password" field once there's a toggle (set-password, signup/finish, ChangePassword). (DfFL1glpnYi)
24. [new] "Forgot password?" sits on the password row, not in the footer. (Ddg450QpmE2, DeefFnvTwrm, DfFL1glpnYi)
25. [new] Never block password managers: the right `autocomplete` values, paste allowed. (DeefFnvTwrm)
26. Labels above, the placeholder as an example, a 3:1 field edge. Fill-only gray fields (about 1.1:1) fail. (DfFL1glpnYi, Ddg450QpmE2, reinforcing earlier notes)

Validation timing
27. [new] Submit stays pressable. Pressing it with gaps marks every missing field at once and focuses the first. (Ddg450QpmE2)
28. [new] After an error, re-check on every keystroke and clear the instant it's valid ("reward early, punish late"). (Ddg450QpmE2)
29. [new] The message matches the actual problem (empty vs malformed vs duplicate) and says what to do. (Ddg450QpmE2)
30. [new] Errors appearing or clearing never shove the layout. Animate the height (~200 ms) or reserve the line, and keep the submit under the thumb. (Ddg450QpmE2)
31. A disabled submit only when what's missing is obvious, and say why. (DeefFnvTwrm; refines earlier notes)

Submit feedback
32. Pressed state within 100 ms, at the finger: darker plus about 0.98 scale, or a ripple. This applies to rows and icon buttons too. (Ddg450QpmE2, DfFL1glpnYi)
33. Loading and success happen inside the button, in the same spot: spinner about 1 to 1.5 s, ✓ held about 0.5 s, then move on. (Ddg450QpmE2, DeefFnvTwrm)
34. [new] The label changes to the -ing form while working and the past tense when done: Logging in / Verifying / ✓ Verified; Saving / Saved; Locking / Locked. (DeefFnvTwrm)
35. [new] While in flight, freeze the fields and any conflicting links or buttons ("Go back"); no second submit. (DeefFnvTwrm)
36. [new] Success also shows on the object acted on (merged boxes → one green tile; report header "Locked ✓"). (DeefFnvTwrm)

Steps and navigation
37. [new] Step changes keep an anchor still (logo, card, stepper); only the content swaps, ≤ 300 to 400 ms. (DeefFnvTwrm)
38. [new] The next step repeats the key input in bold and links back to change it ("Wrong email? Go back"). (DeefFnvTwrm)
39. [new] Anything that expires shows a live countdown and its recovery ("Code expires in 0:45", "Resend code"). (DeefFnvTwrm)
40. [new] Code entry: one box per digit, auto-focus, auto-advance, paste fills them all, Backspace steps back, `one-time-code`; enabled only when complete. (DeefFnvTwrm; app/share CodeBoxes is the model)
41. [new] Forward slides in from the right and Back slides out to the right, always. (DfFL1glpnYi)
42. [new] Sibling flows (Sign in ↔ Start a workspace, Report ↔ Meeting) replace instead of stacking history. (DfFL1glpnYi)
43. One primary, one secondary, one tertiary on an entry screen. (DfFL1glpnYi; earlier notes)
44. A sheet or dialog grows from its button and shrinks back into it; with reduced motion, a fade. (DfaHwqVu06h; earlier note 17)
45. [new] No entry animation or splash delays the first usable field; reveals ≤ 300 ms. (DauPSfKIycn, Ddg450QpmE2, DfFL1glpnYi, DfaHwqVu06h)
46. [new] After sign-in, land on the work and where the user left off, not on an intro screen. (Ddg450QpmE2)
47. [new] Drags follow the finger, show progress as you go, and spring back if released before the threshold. (DfaHwqVu06h)

Keyboard and phone
48. [new] A one-field step auto-focuses with the right keypad (`tel`, `numeric`, `email`). (DfaHwqVu06h)
49. [new] The primary button stays visible above the on-screen keyboard; the repo has no visual-viewport handling yet. (DfaHwqVu06h)
50. [new] Phone fields: a country-code prefix, `type="tel"`, `autocomplete="tel"`. (DfaHwqVu06h)
51. [new] The alternative identifier sits at the decision point ("Use email" above Continue). (DfaHwqVu06h)
52. [new] Say how long a flow takes ("in less than a minute", "6 steps, about 3 min"). (DfaHwqVu06h)
53. [new] "Keep me signed in": an explicit choice, a ≥ 44 px row, its default depends on the device. (Ddg450QpmE2)

Trust and copy
54. [new] Credential fields only on our own pages, never in an embedded third-party form. (DauPSfKIycn)
55. [new] Legal and consent lines in sentence case, readable size, never tiny capitals. (DauPSfKIycn, DfaHwqVu06h)
56. [new] Pre-sign-in pages show made-up sample data only, never real plant or project data. (DeefFnvTwrm)

## ALL IDEAS FROM MY REELS
1. Show a measured before/after number for each design rule in reviews and PRs ("keys typed 30 → 7"). (Del7XTgsuwI)
2. Track keys and taps for the 5 most common tasks. (Del7XTgsuwI)
3. Write our own rulebook as "✕ / ✓" + "Why it works" + RULE chip, indexed like the 24-law table. (Del7XTgsuwI)
4. Odometer roll for changing numbers (CountUp.tsx). (Df5UFrADYCN)
5. Read rows muted with a ✓; unread bright with a dot. (Df5UFrADYCN)
6. Tint the one row that carries a badge. (Df5UFrADYCN)
7. One "surprise" accent (e.g. flare orange on steel and navy) for sign-in and /about only. (DfIaULMIRC-)
8. Repeat the accent in 2 or 3 tiny details on marketing pages. (DfIaULMIRC-)
9. Things enter from their origin edge in reading direction (drawers, inline add rows, expanding panels). (DauPSfKIycn)
10. A leading type icon plus an example placeholder in email, tag, document number and date fields. (DauPSfKIycn)
11. A segmented switch that swaps a two-mode form in place (Report / Meeting, Upload / Link). (Ddg450QpmE2)
12. A sign-in subtitle that promises continuity ("Pick up Unit 200 turnaround where you left off"). (Ddg450QpmE2)
13. Stacked cards with the next ones peeking, and the last filter chip cut off, on phone views. (Ddg450QpmE2)
14. The brand panel shows the product with cycling sample data (turnaround card, "IFC Rev C issued", a shift line). (DeefFnvTwrm)
15. A one-line hint appears after about 10 s of no input on a step (no mascot). (DeefFnvTwrm)
16. Several inputs merge into one success mark ("12 files uploaded ✓"). (DeefFnvTwrm)
17. Same-size company sign-in buttons in one row if more providers are added. (DeefFnvTwrm)
18. Staggered entrance of actions in reading order (~100 ms apart). (DfFL1glpnYi)
19. The splash logo becomes the app-shell logo (shared element, no blank frame). (DfFL1glpnYi)
20. "Continue as a guest" → open a share link without an account, or a read-only control-room view. (DfFL1glpnYi)
21. Site photo + logo + three doors as the PWA's first-launch screen. (DfFL1glpnYi)
22. A cycling verb on the sign-in panel ("Draft · Check · Issue"). (DfaHwqVu06h)
23. A grabber bar on every phone bottom sheet. (DfaHwqVu06h)

Not for us (all reels): mascots and characters (DauPSfKIycn, DeefFnvTwrm); splashes of 3 to 7 s and "wait for the form" animations (DauPSfKIycn, Ddg450QpmE2, DfFL1glpnYi); a swipe-up gate before sign-in (DfaHwqVu06h); lightning, bubble physics and avatar faces (Ddg450QpmE2, DfaHwqVu06h); Facebook, Google and Apple sign-in (DfFL1glpnYi, Ddg450QpmE2); gradient landing-page heroes and giant condensed type outside /about (DfIaULMIRC-). Each one either delays the work or makes the tool look like a consumer app.
