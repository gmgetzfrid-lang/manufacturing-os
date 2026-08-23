# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 14
findings are worked against. Judgment calls shared with the other areas are
settled in [`../DECISIONS.md`](../DECISIONS.md).

---

## Before anything: run the query

`IDENT-1` carries three SQL queries. **Run them first.** They cost thirty seconds
and they decide how much of this area is live versus latent:

- **No duplicate auth users** → your two sign-in methods are linked onto one
  identity. `IDENT-*` becomes hardening against a future regression, and the
  Viewer symptom is `SESS-1` alone. Fix `01`, ship, done.
- **Duplicate auth users exist** → you have two accounts, and `02` and `03`
  are describing what is happening to you now. `IDENT-1`'s reconciliation has to
  happen before the unique index can be added at all.

Do not order the rest of this work before you know which world you are in.

---

## The one thing to understand first

**Three independent defects produce one symptom.** Fixing any one of them will
reduce how often you see it and will not eliminate it, which is the trap:

| Defect | What it contributes |
|---|---|
| `SESS-1` | The app renders as Viewer whenever the answer is late |
| `ORGSEL-1` | An arbitrary workspace — possibly one where you *are* a Viewer |
| `IDENT-1` | A second identity whose membership genuinely differs |

They stack. A late resolution (`SESS-1`) on a second identity (`IDENT-1`) whose
candidate workspace is stale (`IDENT-4`) hits the unordered fallback
(`ORGSEL-1`). That is one event to you and four causes in the code, and it is why
it has resisted diagnosis: no single change makes it reproducible or makes it
stop.

---

## Phase 0 — Stop the symptom. Small, safe, no dependencies.

**`SESS-1` is the whole of Phase 0 and it is a few lines.**

Add the missing branch to `app/(protected)/layout.tsx`:

```
if (uid && membershipState === "resolving") → the spinner (or a "still working
this out" state), regardless of `loading`
```

This is not a workaround. The provider already computes the correct four-state
answer and documents the contract in its own docblock (`RoleContext.tsx:34-39`);
the layout consumes three of the four states. Phase 0 is making the consumer
match the model that is already there.

⚠ **Do not "fix" this by lengthening the watchdogs instead.** The watchdogs exist
so the spinner can never hang forever, and that is correct behaviour. Lengthening
them without `SESS-1` just makes the wrong render arrive later. Do `SESS-1`
first; `SESS-2` then becomes safe, because a longer budget costs an honest
spinner rather than a longer lie.

**Ship this before the rest of the area.** It is the item that stops you being
handed a Viewer app, and it does not depend on the identity question resolving
either way.

---

## Phase 1 — Stop manufacturing duplicates

In order. Each one closes a door that the next finding's fix assumes is closed.

1. **`IDENT-3`** — normalise every email comparison. This is the *manufacturing
   step*: case-sensitive `eq` on identity is what mints the second account.
   Until it is closed, reconciling existing duplicates just creates room for new
   ones.
2. **`IDENT-5`** — the signup guard fails open in three independent ways. Same
   pass as `IDENT-3`; they touch adjacent lines.
3. **`IDENT-2`** — Team Management must refuse a collision rather than guess
   which identity gets the role. Copy the pattern from
   `app/(protected)/projects/[id]/page.tsx:870-872`, which already does this
   correctly and is the only call site that does.

Only then:

4. **`IDENT-1`'s constraints** — reconcile existing duplicates, then add the
   `lower(email)` unique index on `users` and the partial unique index on
   `org_members (org_id, lower(email)) WHERE status = 'active'`. **The index will
   fail to create while duplicates exist**, which is the correct order of
   operations, not an obstacle.

---

## Phase 2 — Stop the arbitrary picks

5. **`ORGSEL-1`** — order the fallback query and stop persisting an unexamined
   choice as the new default. Decide the ordering rule deliberately: highest-ranked
   role then oldest membership is the obvious candidate, and it has the property
   you want — when in doubt, land the person where they are most capable, not
   least.
6. **`ORGSEL-2`** — the login page's copy of the same query, plus its discarded
   error. Fold into `SESS-4`'s deduplication rather than fixing twice.
7. **`IDENT-4`** — scope or clear `manufacturingos.activeOrgId` on sign-out.
   After `ORGSEL-1` this is no longer load-bearing, which is why it is here and
   not in Phase 1.

---

## Phase 3 — The honest-signal work

8. **`SESS-2`** — one shared budget constant, at or above the 15 s the file
   already argues for. Safe only after `SESS-1`.
9. **`SESS-3`** — the slow path gets the message the failed path already has.
   The words are already written at `layout.tsx:121-122`; they just need to reach
   the other state.
10. **`SESS-4`** — deduplicate the two membership round trips.
11. **`ORGSEL-4`** — say so when the workspace changes underneath someone.
12. **`SESS-5`** — make `activeRole` unrepresentable as a placeholder. Last,
    deliberately: it touches every consumer of `useRole()`, and after `SESS-1`
    nothing observes the placeholder any more, so this is defence against the
    next surface rather than a fix for the current one.

**`ORGSEL-3` is not in this ladder.** It is a separate, independent data-loss bug
that happens to live in the same route as `IDENT-2` — fix it in whichever pass
touches `app/api/admin/create-user/route.ts` first. It is `HIGH` on its own merits
and has nothing to do with the Viewer symptom.

---

## Do not do these

| Tempting | Why not |
|---|---|
| Remove the watchdogs so the spinner waits for the real answer | They exist because the spinner hung forever. Removing them trades an intermittent wrong render for an indefinite hang, which is worse. Fix the consumer, keep the watchdogs. |
| Default `activeRole` to `Admin` so a slow load fails open | Fails the other way and is worse in a PSM system. The answer is not a different placeholder, it is no placeholder — `SESS-5`. |
| Disable the Microsoft login while investigating | The correlation is real but SSO is not the cause; it is the slowest path to the same race. You would lose the feature and keep the bug on cold password loads. |
| Add a unique index on `users.email` first | It will fail while duplicates exist, and if you force it by deleting rows you delete one of your own identities and its `org_members` rows cascade. Reconcile first — `IDENT-1`. |
| Merge duplicate identities by deleting the spare `auth.users` row | `users.id` is `ON DELETE CASCADE` from `auth.users` (`schema.sql:10`). Deleting an identity deletes its profile and cascades onward. Reassign `org_members.uid` and every other `uid`-keyed row first, deliberately, with a record of what moved. |
| Trust `org_members.email` to identify a person | It is a denormalised copy written at insert (`create-user:141`) and never re-synced. `uid` is the only identity the database enforces. |
| Fix `ORGSEL-1` by having the fallback pick the *newest* membership | Newest is as arbitrary as first for this purpose and biases toward whichever workspace someone most recently added you to — typically the least privileged. Rank by role. |

---

## Verification you cannot skip

**Everything in `01` and `03`, and the code-shape half of `02`, was read directly
from source and is exact** — these are render conditions, query construction and
schema DDL, all deterministic and all cited by line.

**One thing was not observed and cannot be, from this repository:** whether your
Supabase project links the Azure identity to the password identity. That is a
project setting. Every `IDENT-*` finding is written to be correct either way, but
their *severity in your installation* is set by the query in `IDENT-1`. Run it
before you plan the work.

**Nothing here was reproduced against a running app**, per the standing constraint
that no application code, test, or migration was modified. The Viewer window in
`SESS-1` is a timing-dependent render path; it is proven by construction from the
four cited lines, but the honest reproduction is a browser with the membership
query throttled past six seconds. That test is worth writing before the fix, not
after — it is the one that tells you whether you have found *your* bug or only *a*
bug.
