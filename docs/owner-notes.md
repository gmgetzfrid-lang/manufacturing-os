# What the owner has taught us

Read this before any work on Manufacturing OS. Every line here is something the owner (a refinery engineer who plans turnarounds) had to say more than once. Repeating one of these mistakes costs his trust; he should never have to say it again.

When he corrects something new, add it here in the same session (one line, plain words, with the date), and commit it with the fix.

Also read: `docs/design-rules.md` (rules are musts, ideas are optional) and `docs/next-update.md` (what's open).

---

## 1. Finish the whole thing (his most repeated complaint)

1. **Do every item he asked, not one of them.** Before starting, list each ask in his message. Before saying done, check each one off. (Nov 20, Nov 24: "I keep telling you things and you only do one of them.")
2. **A principle goes everywhere, not just the screen in the example.** "All nooks and crannies of the app": every page, tab, dialog, side panel, empty state, email, print, slide, phone. (Nov 20, Nov 23, Nov 24)
3. **No hidden leftovers.** After a change, find every other place it touches (grep the code for the component, the words, the pattern) and fix those too, without being asked. (Nov 25: "There's always something hidden that you didn't do.")
4. **Don't stop at a partial job and tell him what's left for him.** Finish it. If something truly can't be done here (a database change, a setting only he can reach), say exactly what and give him the ready-to-paste step. (Nov 20, Nov 24)
5. **Never call it done when it isn't.** Say plainly what was checked on screen, what was only type-checked, and what's left. (Ongoing: "this system can not lie.")

## 2. Look at it as a user, not a list of comments

6. **Step back and use the app for its purpose** (planning and running a turnaround) before showing anything. Ask: what does the person do before this screen and after it? What would a 50-year project manager say? (Nov 24: "Are you just blindly listening to my comments and never step back and look at the app for its intent?"; Nov 25)
7. **Every screen says what to do next.** No dead ends after an upload; the life cycle leads (scope, packages, schedule, RFQ, award, rates, live cost, close-out). (Nov 25)
8. **Think the system through end to end.** When one part changes (work orders, packages, schedule), everything tied to it follows: remove, edit, re-import, sync, discrepancies. (Nov 25: "have you thought this all the way through?")
9. **Ask up front instead of walking everyone through every step.** Don't assume a path and add steps for it; ask how they want to start and follow that (e.g. new project: from a schedule, a work order list, or empty). (Nov 25)
10. **Don't spread things out.** Fewer steps, fewer pages, fewer dialogs. Compress. (Nov 25: "you tend to spread things out for no reason and add steps and add pages.")

## 3. Ideas vs. literal

11. **Posts and videos are ideas, not templates.** Take the principle and the category and apply it everywhere it fits; don't copy the example, and don't skip it because our app doesn't have that exact thing. Sort what's a rule from what's an idea. (Nov 20, Nov 24, Nov 25)
12. **Don't steal one idea; combine them with our own thinking** to fit this app. (Nov 24, the sign-in)
13. **Even when given ideas, the rules still hold.** Make good decisions. (Nov 25)

## 4. Design: what he hates

14. **Flat and boring.** Use color to draw the eye: two main colors and an accent, from the workspace's logo, used where they mean something. About 20% more depth than "same color everywhere". (Nov 20, Nov 24)
15. **Use the colors correctly, not differently.** Same scheme, with depth: no hard flat full-height slabs; small pieces of color that each mean something (a red count, a green "online" dot). (Nov 25)
16. **AI slop.** Generic logos (a triangle in a circle), corny literal touches (writing the word "drawing" on a drawing), slammed-together features. Everything must be thought through and have a reason. (Nov 24, Nov 25)
17. **Random things.** No element without a clear job for most people (the "+ New" button and the "Recent projects" block were random). (Nov 25)
18. **Duplication.** Don't add something that repeats a feature that already exists (an "Ask the library" box when Intelligence and a dashboard widget do it). Breaking a feature out differently is fine only if it replaces the other copy or adds a real new use. (Nov 25)
19. **Clashing controls.** One way to do a thing: one open/close for the side menu, in one spot. (Nov 25)
20. **Walls of text, and buttons that look like text.** Pages are scanned, not read like a Word document. Buttons look like buttons. (Nov 20)
21. **Cramped cards and wasted space.** No card around something for no reason; no box in a box. (Nov 20)
22. **Hidden main things.** What's used most is out in the open; what's used rarely can go behind More. Never the other way around (his "trending flaw"). (Nov 23)
23. **Huge forms.** Adding a line should feel like adding a row in a spreadsheet. Ask only what the app runs on. (Nov 24)
24. **Losing function when restyling.** A restyle never drops a button or a feature (the equipment column's pills with photo and carousel buttons). (Nov 20)
25. **Sideways scrolling and random scroll bars.** Columns wrap down; nothing scrolls sideways; no stray scroll bars. (Nov 20)
26. **Having to scroll for little information.** A short screen fits one phone screen; everything lines up on one left edge. (Nov 25, the phone sign-in)
27. **Noise.** Anything that doesn't help him act goes (the DATE/REV row on the sign-in). (Nov 25)

## 5. Showing data

28. **Scan first, dig if needed.** The key number or sentence up top; detail below or one tap away. Users scan, they don't study like an exam. (Nov 24)
29. **Cause, effect, fix.** Reviews and charts say what happened, why (what was waiting on what), and what to do about it, from the data, not hard-coded and not questions. (Nov 23, Nov 24)
30. **Charts readable at a glance**, with words; if he can't read it, it's wrong. (Nov 24)
31. **The view follows where you are**: a graph shows the current folder or phase; which phase or filter is shown is always in sight. (Nov 20, Nov 24)
32. **Defaults are "mine"**: your projects first, all projects as an option. (Nov 20)
33. **Search finds what was asked** (searching X-31 shows X-31). (Nov 20)
34. **Emails survive pasting into Outlook** (inline styles; nothing lost). (Nov 24)

## 6. The trade (turnaround planning)

35. **Real planning starts from a work order list (Infor EAM) or a schedule**, grows and changes format; intake must be flexible. Then packages per work order, bill of materials to the master, RFQ, award, contractor rates, live cost; plus scope of work and AFE/budget (crane, scaffold, hydroblasting, pigging, extra contractors). Follow the turnaround execution management and planning book. (Nov 24)
36. **Crews can't appear mid-job.** People not on site at the start can't be sourced in days, especially on a one-week job. Suggested schedules fix sequence and logistics first; adding people or time is the last resort. (Nov 23, Nov 24)
37. **Materials have owners** (the warehouse person and a turnaround crew person) so it actually gets done. (Nov 24)
38. **The AI must be right and show its proof.** A confident wrong answer about his standards is the worst outcome; it must read tables and figures, and the "why" must be about the question. (Nov 24)

## 7. Accounts and access

39. **No one makes their own profile.** Only through the paid sign-up, then the admin adds people; emails never collide. Nobody gets demoted or sent to "no workspace" by a refresh. (Nov 23)
40. **Links to outsiders are controlled but need no login** (expiring, revocable, logged). (Nov 23)
41. **Using the app needs a subscription.** (Nov 24)
42. **Admin and non-admin menus differ**: admin pages are only for Admin and Document Control. (Nov 25)

## 8. How to talk to him

43. **Short, plain words, no walls of text.** No em dashes. Times in AM/PM. (Ongoing)
44. **Do what the message asks, in the mode it asks.** "Just talk to me / give me ideas / feedback only" means change nothing. "Tell me your plan first" means plan, then wait. "Build it" means build. (Nov 24, Nov 25)
45. **Don't pile questions on him.** Make the call and show it. When a visual redesign keeps missing, show a mock-up and let him mark it up. (Nov 25)
46. **Production only on "push".** The preview branch is `claude/answer-first-layout`; production is `master`.
47. **Speed matters**: screens should load in well under a second. (Nov 24)

---

## Before you say "done" (every time)

1. **His asks:** re-read his message; every item is done, or you say why not.
2. **Everywhere it applies:** grep the code for the component, the words and the pattern; list every screen, tab, dialog, email, print and slide it touches. Fix them all.
3. **Every state:** desktop, phone (375 px), the collapsed side menu, dark mode, a light-menu workspace; Admin, a regular member, a viewer or contractor; empty, loading, error, long names, lots of data.
4. **Before and after:** walk the job end to end as a user (what comes before this screen, what comes after). Nothing contradicts anything else in the app.
5. **The rules** in `docs/design-rules.md` that it touches.
6. **Look at it:** screenshot it and look like he would. Fix what's off before showing him.
7. **Checks:** type check, lint, tests.
8. **Say it straight:** what's verified on screen, what's only type-checked, what's left.

---

## Mistakes log (newest first; add one line each time he corrects something)

- Nov 25: New project made everyone go list, scope, shifts, check, then later "import the schedule". Fixed: ask how to start (schedule, list, empty); a schedule's work orders are the scope.
- Nov 25: Side menu went through four rejected versions (random "+ New", "Recent projects", hiding tools under More, "Checked out to you", "Jump back in", an "Ask the library" box that duplicated Intelligence). What worked: a mock-up first, then build. Kept: Work / Site / Tools, the admin toolbar, running work moved out of the corner cards, On now.
- Nov 25: Phone sign-in needed scrolling and had a 4 px misalignment. Fixed: fits one screen, one left edge.
- Nov 25: Side menu edge tab and the phone's menu button clashed. Fixed: one toggle in one spot.
- Nov 24: Suggested schedule added crews mid-job. Fixed: crews fixed from day 1; sequence first.
- Nov 24: Materials form was huge. Rule: rows like a spreadsheet; owners on each item.
- Nov 20: Restyle dropped the equipment column's photo buttons and made it scroll sideways. Rule: never lose function; wrap down.
