# Next update: what we agreed to fix

Collected Nov 24, 2026 from the owner's review of the project pages and reports. Rules referenced are in `docs/design-rules.md`.

**Status (Nov 24, 2026, preview build):** built and checked on test data (type check, lint, 3,100+ tests, production build, phone crawl of 35 screens at 375 px). Each item says **Done** or **Open**. The open ones are listed again at the end.

## 1. The screen must never contradict itself
- **Done.** Shift email and printout header said "ON TRACK" while the line under it said the phase finished 43.5 h late. A phase past its planned finish now reads behind, everywhere (`lib/phaseStanding.ts`).
- **Done.** Project header, Work tab and project list now tell one story: a running phase past its planned finish reads "past its planned finish, N steps left", with the forecast and how late against the original plan.
- **Done.** Hours over 24 also read as days ("791.4 h late (33 days)").
- **Done.** Close-out says "No invoices in yet" instead of a green "Left $1,260,000".

## 2. Project pages: stop the hunting
- **Done.** Full header on Plan only; one line on the other tabs (name, status, key number, small stepper).
- **Done.** Shift tab: controls merged; section links stay on screen while scrolling.
- **Done.** Shift tab: an empty section is one line ("Nothing added this shift.").
- **Done.** Shift tab: short section titles ("Done · 0"); times go in the row.
- **Done.** Shift tab: "Where we stand" leads with Past due.
- **Done.** Shift tab: pencil and trash on attendees only after "Edit attendees".
- **Done.** Work tab: open and late work first, finished groups folded ("112 of 113 done"); done rows one quiet gray.
- **Done.** Work orders: which phase is shown is in sight above the list ("Showing: All phases · Phase 1 · Phase 2", each with its step count), and tapping one changes it. Same on the schedule tabs and Costs.
- **Done.** Plan tab: to-do rows first; the rest fold ("12 set · Show").
- **Done.** Project list: no zero stats, owner names not emails, "N steps left · late" beside a 90% or fuller bar.
- **Not an app issue.** The round button floating over report text on the phone was the Next.js development indicator; it does not appear in the live app.

## 3. Shift email and printout (what management reads)
- **Done.** Order: status sentence, done, next shift, problems and follow-ups, safety, people. A one-line head count up top; the names at the end.
- **Done.** The section choice is saved per project; one "Sections" link changes it.
- **Done.** Short labels ("Done", "Next shift"); times in the row.
- **Done.** One status sentence with the key number.
- **Done.** One card leads the email, both formats (from the posts the owner sent): what and when small, the project, the key number big with the verdict and one sentence, then the numbers in one row, each a small label over its value (Complete, Plan by now, Gap, Steps done, On site), wrapping on a phone. The phase line under it drops what the verdict already says. Where we stand is no longer said twice.
- **Done.** The shift table reads as grouped lists: each row's name with its count ("Plan · 1"), each crew with its count, the equipment as a tag before the step, items numbered in the email itself (the preview used to drop the numbers), note times in their own column, the head count with numbers on the right and a total. Safety is one tinted line with its mark (no incidents, not entered, or each incident); the Shift tab says it the same way.
- **Done.** Detailed format checked on screen: empty hours one after another are one row ("12:00 PM to 5:00"), time and WO columns take only the width they need, good or bad lines are tinted callouts.
- **Done.** The Word file's header has the key number big and "On site" with the other numbers.
- **Open (kept on purpose).** The plant's own shift table has no "Next shift" row; it is the plant's form, so it was left as is.
- **Open.** On a phone the Detailed format's 8-column "Shift after" table is wider than the screen (474 px at 375); the required format fits.

## 4. Printed reports
- **Done.** "Where the time went" sits right under the opening tiles of the close-out report.
- **Done.** Phase report: three or more shifts in a row that say the same are one line ("Sun, Nov 1 to Mon, Nov 9: no change, 18 shifts").
- **Open.** Other tables with identical rows (the 8 "Completed at Redman" rows in the close-out report) are not merged yet.
- **Done.** Long notes get a full-width line under their row.

## 5. Charts the owner could not read
- **Done.** Budget lines: each row's track is that line's own budget, filled with committed and spent; the line's size is a number.
- **Done.** Where the late hours went: each cause is written on its own bar's row; the bar's title comes from the job it was written on (the E-17 bar no longer carries E-12's title).
- **Done.** As-built schedule reads like P6 or Microsoft Project: a table of work orders in schedule order (shutdown first, start-up last; "Most late first" is a choice), with actual start, planned finish, actual finish, late by and shifts waited, and the bars to the right. Each phase is its own block with its own planned finish line; plan gray, actual solid, the part past its own plan in red, waits hatched.
- **Done.** Suggested schedule is the same kind of table: activity, hours, start, finish, with the bars to the right; one table per phase on that phase's own days; a work order's bar is a summary line from start to finish with its worked shifts on it; the crew colors are named. The phase picked under "Showing" is the one shown.
- **Done.** The list of reports folds away on the two schedule reports, so the table has the full width ("All reports" brings it back).
- These were built straight into the app (the owner asked for everything at once), not shown as mock-ups first.

## 6. Suggested schedule for next time: replay first, add people last
- **Done.** The Suggested view opens with "Same people, same work, better sequence" (`lib/asBuiltReplay.ts`): this year replayed on what really happened, the same crews at the most steps they really worked at once, only the links the work needed, waits with a recorded reason kept, waits with nothing logged taken out. Each move says what was ready, when, and the hours it saves.
- **Done.** One-off delays as a what-if, one line per work order, each with what was written: waits, trips off site, and steps that ran past their planned shifts after a leak, failure or shortfall was written on the work order. Tick one to see the finish without it, and the finish against the plan.
  - On the test data for Phase 1: with the same crews nothing could have been pulled in. Taking out E-12 (the seal rings: 20 of 24 ordered, re-used ones leaked on the hydro) brings the finish in 25 h, to 8.5 h late against the planned finish instead of 33.5 h.
- **Done.** A step left open (work logged, never marked done) no longer stops the replay: it stays as it ran and is named. Phase 1 has one: "Set Blinds; Verify LOTO".
- **Done.** Added people or time come after, under "If it still misses the target", with how far sequencing alone got.
- **Fixed.** With two phases, each start-up now waits only on its own phase's work, and "out first thing once the unit is down" uses its own phase's shutdown. Before, Transmix-1's start-up was put on Day 23, after Phase 2's work, and two Phase 1 valves waited for Transmix-2's shutdown.
- **Done.** What the replay can't know is listed (waits with no reason, crews with no head count, steps with no times).

## 7. Materials: add a line like a spreadsheet, two owners
- **Done.** A row always waits at the bottom of the register: item, quantity, work order, need-by. Enter saves it; rows pasted from Excel are added at once.
- **Done.** Everything else is edited on the line. The phase comes from the work order.
- **Done.** Two owners: warehouse (gets it in and checks it) and crew (makes sure it is used). The row is flagged when either is missing.
- **Done.** The crew owner marks it used, so done means done on the job.
- **Done.** Off-site repair is the same kind of row, with "Needed back by" and "Return date".
- **Needs the owner:** run `supabase/migrations/20261125_materials_two_owners.sql` (adds the crew owner and the "used" status).
- **Needs the owner:** upload the simplified turnaround execution and management book, so the steps and words match it exactly.

## 8. Rules still open (from docs/design-rules.md status)
- 42 tap targets under 44 px on touch (down from 192); none under 24 px is a real target.
- Fixed: status colors on the dark document viewer; timeline and calendar bar colors; add rows with only a screen-reader name.

## Still open, in one list (checked Nov 24, 2026)
- **Database steps not run yet** (checked read-only against the live database): the materials table itself (20261119; until it exists, material lines are kept in the project's settings and the daily reminders can't see them), its two owners (20261125), its verify-by date (20261126), and the subscription rule in the database (20261124; today the block is on screen and on the server only). All four, in order: `supabase/RUN_PENDING_2026-11-24.sql`.
- Materials: the verify-by lead time is a default of 14 days, not the turnaround book's number (the book isn't in the app). Reminders go to the bell only, not email, and only to owners who are on the project.
- Printed reports other than the shift update (work orders, close-out, phase report) haven't had the type-scale pass: the work-orders print still uses tiny uppercase headers. The shift update's Detailed format is wider than a phone screen (its 8-column "Shift after" table).
- Of the six posts sent Nov 24, only DUr4dCgCLiA and the first slide of DY1Q6_CpsV8 could be opened here; the other four need an Instagram sign-in. Their ideas are not in yet.
- Review slides: their charts haven't been checked for the "biggest bar fills the width" problem fixed on screen.
- Close-out report: identical rows (the 8 "Completed at Redman") are not merged.
- 42 tap targets under 44 px (rule T1); budget table as cards on the phone (T3); a "⋯" menu on invoice and change-order rows (A3); the cost chart example still a plain bar list; the project's "Ask" box above the tabs; the shift picker on its own row under 768 px.
- The plant's shift table has no "Next shift" row (kept on purpose: it is the plant's form).
