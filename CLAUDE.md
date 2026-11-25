# Notes for Claude

**First, read `docs/owner-notes.md`.** It is everything the owner has had to correct more than once. Don't repeat any of it. When he corrects something new, add a line there in the same session and commit it with the fix.

**Before saying anything is done, run the "Before you say done" checklist** at the bottom of `docs/owner-notes.md`: every ask in his message, every place in the app the change touches (grep for it), every state (phone, collapsed menu, dark mode, admin and non-admin, empty and full), the job end to end as a user, then screenshots. Say plainly what was checked on screen and what wasn't.

Any change to screens, components or styles follows `docs/design-rules.md`: rules are musts on every screen, ideas are optional. Check a UI change against the rules it touches before calling it done (fields 16 px and 44 px tall on touch screens, 375 px wide, one accent button, confirms that name the action, no text under 12 px).

Production is `master`, pushed only when the owner says "push". The preview branch is `claude/answer-first-layout`.
