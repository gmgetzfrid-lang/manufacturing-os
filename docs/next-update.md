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
- **Open (kept on purpose).** The plant's own shift table has no "Next shift" row; it is the plant's form, so it was left as is. The Word file's header has no head count or key number yet.

## 4. Printed reports
- **Done.** "Where the time went" sits right under the opening tiles of the close-out report.
- **Done.** Phase report: three or more shifts in a row that say the same are one line ("Sun, Nov 1 to Mon, Nov 9: no change, 18 shifts").
- **Open.** Other tables with identical rows (the 8 "Completed at Redman" rows in the close-out report) are not merged yet.
- **Done.** Long notes get a full-width line under their row.

## 5. Charts the owner could not read
- **Done.** Budget lines: each row's track is that line's own budget, filled with committed and spent; the line's size is a number.
- **Done.** Where the late hours went: each cause is written on its own bar's row; the bar's title comes from the job it was written on (the E-17 bar no longer carries E-12's title).
- **Done.** As-built schedule: one row per work order, most late first, each phase its own block with its own planned finish line; plan gray, actual solid, the part past its own plan in red, waits hatched; the legend says what each color means.
- These were built straight into the app (the owner asked for everything at once), not shown as mock-ups first.

## 6. Suggested schedule for next time: replay first, add people last
- **Done.** The Suggested view opens with "Same people, same work, better sequence" (`lib/asBuiltReplay.ts`): this year replayed on what really happened, the same crews at the most steps they really worked at once, only the links the work needed, waits with a recorded reason kept, waits with nothing logged taken out. Each move says what was ready, when, and the hours it saves.
- **Done.** One-off delays as a what-if, one line per work order, each with what was written: waits, trips off site, and steps that ran past their planned shifts after a leak, failure or shortfall was written on the work order. Tick one to see the finish without it, and the finish against the plan.
  - On the test data for Phase 1: with the same crews nothing could have been pulled in. Taking out E-12 (the seal rings: 20 of 24 ordered, re-used ones leaked on the hydro) brings the finish in 25 h, to 8.5 h late against the planned finish instead of 33.5 h.
- **Done.** A step left open (work logged, never marked done) no longer stops the replay: it stays as it ran and is named. Phase 1 has one: "Set Blinds; Verify LOTO".
- **Done.** Added people or time come after, under "If it still misses the target", with how far sequencing alone got.
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

## Still open, in one list
- 42 tap targets under 44 px (rule T1).
- Budget table as cards on the phone (T3); a "⋯" menu on invoice and change-order rows (A3).
- The cost chart example still uses a plain bar list.
- The project's "Ask" box sits above the tabs.
- Close-out report: identical rows (the 8 "Completed at Redman") are not merged.
- On screens under 768 px the shift picker takes its own row.
- The plant's shift table has no "Next shift" row (kept); the Word header has no head count or key number.
- Waiting on the owner: the materials SQL, and the book.
