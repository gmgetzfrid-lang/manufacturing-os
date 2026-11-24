# Next update: what we agreed to fix

Collected Nov 24, 2026 from the owner's review of the project pages and reports. Nothing here is built yet. Rules referenced are in `docs/design-rules.md`.

## 1. The screen must never contradict itself (do first)
- Shift email and printout header says "ON TRACK" while the line under it says the phase finished 43.5 h late.
- Project header: "Phase 1 is 99% done, forecast Dec 3, 791.4 h late"; the Work tab says Phase 1 "on track"; the project list says it ended 9 days ago. One story everywhere.
- Hours over 24 read as days too ("791 h" means nothing; "33 days" does).
- Close-out "Spent $0, Left $1,260,000" in green when no invoices are in: say "No invoices in yet".

## 2. Project pages: stop the hunting
- Project header (title, stats, phase stepper) takes about 400 px on every tab and the whole first phone screen. Full header on Plan only; one line on the other tabs (name, status, key number, small stepper).
- Shift tab: 5 rows of controls before content; merge to 2, section links stay on screen while scrolling.
- Shift tab: empty sections (Done 0, Waiting, Next, Discovery) each take about 100 px; fold into one line.
- Shift tab: section titles repeat the full date ("Done - Day shift Thu, Nov 19 6:00 AM-6:00 PM"); use "Done · 0".
- Shift tab: "Where we stand" shows 4 equal numbers; the one that needs action (Past due) is the big one.
- Shift tab: pencil and trash on every attendee chip; show them only in "Edit attendees".
- Work tab: opens at the job's first day with 235 rows expanded, mostly done. Default to open and late work first, finished groups folded ("112 of 113 done"), timeline starting at today.
- Work tab: names cut at about 15 characters; widen. Done rows carry 4 "done" signals; one quiet gray.
- Plan tab: 14 setup rows, 12 of them "Set". To-do rows first; fold the rest ("12 set · Show").
- Project list: hide zero stats, show owner names not emails, pair the 99% bar with "1 step left · late".
- Phone: the round account button floats over report text (rule T4).

## 3. Shift email and printout (what management reads)
- Order: status sentence, done, next shift, problems and follow-ups, safety, people. Today the attendee list (32 names on the Nov 19 day shift) fills the first screen; put a one-line head count up top in the form "<n> on site: <crew> <n>, <crew> <n>..." and the names at the end.
- 21 checkboxes to set before each send: save the choice per project, one "Sections" link to change it.
- Short labels ("Done", "Next shift"); times go in the row.
- One status sentence with the key number, smaller tiles; drop bars that repeat 100%.

## 4. Printed reports
- Lead with the answer: "Where the time went" (late by, causes) right under the opening tiles of the close-out report.
- Collapse repeated rows: 8 identical "Completed at Redman" rows into one with a count; about 20 identical "past plan, 99.7%" shift rows in the phase report into one line or a single plan-versus-actual chart.
- Long notes get a full-width line under their row, not a narrow column.

## 5. Charts the owner could not read
- **Budget lines** (Costs): each bar is scaled to the biggest line ($720,000), so the longest pale bar looks like "100% used" when nothing is spent. Fix: each row's track is that line's own budget, filled with committed and spent; line size shown as a number.
- **Where the late hours went** (post-event review): bars and causes are tied only by color; three similar grays; the palest bar is nearly invisible; numbers shown twice. Fix: each cause written on its own bar's row ("E-12 · 24 h · material shortfall set the finish"). Also check the E-17 bar, whose finding is titled "E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2".
- **As-built schedule**: colors mean crews but the legend does not say so; 50 shift columns squeezed so most steps are dots; the red line is the whole job's finish, not each phase's; no row says how late it was; plan line is a faint 4 px gray; rows in planned-start order. Fix: one row per work order with planned finish, actual finish, late by and waits; one bar (plan gray, actual solid, the part past its own plan in red, waits hatched); most late first; each phase its own block with its own finish line and fitted dates; crew colors only when a row is opened.
- Build a mock-up of all three on the real project data and show the owner before changing the app.

## 6. Suggested schedule for next time: replay first, add people last
The owner's principle: first see how the job could have been run better on what really happened, by timing and sequencing (logistics and execution). Add time or people only as a last resort.

What it does today (lib/nextPlan.ts, lib/nextPlanLessons.ts):
- Each activity gets its **planned** hours (shorter only if it was done in fewer shifts); work found by inspection is left out and shown as a risk; missed scope is put in from the start.
- Each crew is held for the whole job at the size of its first shifts (CREW_RULE); work over that waits.
- When the result misses this year's planned finish, it pulls the finish in with, in order of what saves most: start sooner, add nights, add another crew for the whole job; more time only when none of them closes the gap.
- It has no step that asks "with the same people and the same work, how should it have been sequenced?" So the first levers it reaches for are more people and more shifts.

What it should do, in this order:
1. **Replay as built.** The real hours each step took, the discovery and added work at the time it was really found (not before), the same crews at the head counts recorded each shift, the same shutdown and start-up.
2. **Better run, same resources.** Re-sequence only: start ready work as soon as a crew from that company is free, move a crew off a work order that sat with nothing logged onto ready work, keep only the links the work really needed. Show the new finish and each move with the hours it saves, written from the record in the form "<step> was ready at <time> and sat <n> shifts while <crew> was on <other work>; starting it then saves <n> h".
3. **One-off events as a what-if.** A switch to take out a one-off delay (the owner names the leak) to show what the finish would have been without it. The post-event review's own split puts 24 of Phase 1's 33.5 late hours on "a material shortfall on E-12"; if that is the leak, about 9.5 h would remain by that split. The replay checks it properly, because taking one delay out can let another path set the finish.
4. **Only then, the gap to the target**: the smallest added people or time that closes what is left, each with its hours saved and its cost.
5. Say plainly what the replay cannot know (a wait with no reason logged, a crew move nobody recorded).

## 7. Rules still open (from docs/design-rules.md status)
- 91 tap targets under 44 px on touch, starting with the "All" and "Ask" tabs (under 24 px).
- Status colors on the dark document viewer; timeline and calendar bar colors need chart tokens.
- Compact inline add rows with only a screen-reader name.
