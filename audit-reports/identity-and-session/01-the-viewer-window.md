# 01 · The Viewer window

**6 findings** — 1 CRITICAL · 2 HIGH · 3 MEDIUM. **All worked 2026-08-23**;
`SESS-6` was opened during resolution (the DEC-31 split of `SESS-5`) and is
the one item left `OPEN` for a future session.

Why an Admin renders as a Viewer, intermittently, with no permissions change
behind it.

> These were read directly from source, not produced by an agent sweep. Every
> line number below was opened and checked. The one thing that could **not** be
> settled from the repository — whether Supabase is actually minting two auth
> users for your two sign-in methods — is called out explicitly in
> [`02-identity-collision.md`](./02-identity-collision.md) with the query that
> settles it.

### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| `membershipState` as a four-state machine — `resolving`/`member`/`none`/`error` — instead of a boolean | `components/providers/RoleContext.tsx:17,34-39` | This is the right model, and the comment above it states the exact rule this area is about: *"never a silent downgrade to Viewer"*. The type already distinguishes "not known yet" from "known to be nothing". `SESS-1` is that the consumer ignores one of the four states, not that the model is wrong. |
| Every membership query throws so the retry loop can tell a failed lookup from a real non-membership | `components/providers/RoleContext.tsx:125-128,138,148,160` | The comment records that the previous version swallowed errors and answered Viewer for both, and that *"on a flaky phone connection that dressed an Admin up as a locked-out stranger."* This is the same defect class as `SESS-1`, already fixed once at the query layer. The fix stopped one layer short of the render. |
| Role state is UI only — RLS is enforced from the JWT, not from `activeRole` | `supabase/schema.sql:1033,1048-1052` | During a Viewer window your data access rights are unchanged. The database still sees your real `uid` and your real `org_members.role`. This is why the symptom is chrome and navigation, not data loss — and why it is a usability and trust defect rather than a breach. |
| The hard-stop and retry screens exist and are well written | `app/(protected)/layout.tsx:79-133` | `NotAMemberScreen` even names the exact confusion this area is about — *"a personal vs. work Microsoft account, for example."* The screens are built; one state simply never reaches them. |

---

<a id="sess-1"></a>

## SESS-1 · The protected layout has no branch for `membershipState === "resolving"`, so any forced spinner-clear renders the full app at the initial `activeRole` of `"Viewer"`

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/layout.tsx:35-51`, `components/providers/RoleContext.tsx:65-68`, `components/providers/RoleContext.tsx:83-90`, `components/providers/RoleContext.tsx:238-241`
- **Re-verified:** hardening pass — **SURVIVES** — **but see the independence caveat.** Re-checked against source: `layout.tsx:35-51` branches on `loading`, then `"none"`, then `"error"`, then renders; there is no `"resolving"` branch. `RoleContext.tsx:65` seeds `activeRole` to `"Viewer"` and `:88`/`:241` clear `loading` on timers without touching `membershipState`. `roles-and-permissions/WF-5` was found to depend on it during this pass, which is corroboration from a different direction.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Exactly as claimed, and the boot ordering makes it reachable: RoleContext.tsx:247-249 sets `uid` before `await resolveOrgAndRole(...)`, so when either watchdog fires mid-resolve, uid is non-null, membershipState is still "resolving", and both guards are skipped. CRITICAL is defensible rather than transient because the boot-path resolve at line 249 has no timeout at all (the 15s Promise.race at 317-322 guards only the SIGNED_IN user-switch path), so a hung query leaves the Viewer render up indefinitely.

**Mechanism.** `ProtectedContent` gates on exactly three conditions, in order:

1. `if (loading)` → spinner (`layout.tsx:35`)
2. `if (uid && membershipState === "none")` → hard stop (`:49`)
3. `if (uid && membershipState === "error")` → retry (`:50`)
4. otherwise → **render the entire application** (`:52`)

There is no case for the fourth state. `membershipState` is initialised
`"resolving"` (`RoleContext.tsx:68`) and stays there until `resolveOrgAndRole`
returns. `activeRole` is initialised to the string `"Viewer"` (`:65`) and `roles`
to `[]` (`:66`). So the render path above is reachable with
`loading === false`, `uid` set, and the role still at its placeholder — and when
it is reached, every consumer of `useRole()` is told, in good faith, that the
signed-in Admin is a Viewer with an empty additive collection. `hasRole` and
`hasAnyRole` (`:368-369`) both close, because they test against `roles`, which is
still `[]`.

Two mechanisms force exactly that combination, and both are deliberate:

- **The loading watchdog** (`:83-90`) fires **6 seconds** after `loading` flips
  true and calls `setLoading(false)` with the comment *"force-clearing spinner"*.
- **The boot timeout** (`:238-241`) fires **8 seconds** after mount and calls
  `setLoading(false); bootedRef.current = true;` — while the
  `getSession().then(async … await resolveOrgAndRole(…))` chain at `:244-254` is
  still awaiting.

Neither touches `membershipState` or `activeRole`, because neither knows the
answer yet. That is correct of them. The defect is that the layout treats "no
answer yet" and "the answer is Viewer" as the same render.

**Failure scenario.** You open the app on a cold connection. `resolveOrgAndRole`
is waiting on the first RLS-gated query of the session. At 6 seconds the watchdog
clears the spinner. `uid` is set, `membershipState` is `"resolving"`, so the
layout falls past both guards and paints the full shell — with the Sidebar built
from `roles: []` and `activeRole: "Viewer"`. Admin nav is gone, admin buttons are
gone. Somewhere between a moment and several seconds later the query lands, state
updates, and the app silently becomes Admin again. Nothing was revoked; nothing is
in the audit log; there is no error to report. It reads as random because the only
variable is latency.

**Evidence.**

```
app/(protected)/layout.tsx:35-52
  if (loading) { … spinner … }
  if (uid && membershipState === "none")  return <NotAMemberScreen … />;
  if (uid && membershipState === "error") return <MembershipErrorScreen />;
  return ( … full application … );

components/providers/RoleContext.tsx:65-68
  const [activeRole, setActiveRole] = useState<Role>("Viewer");
  const [roles, setRoles] = useState<Role[]>([]);
  const [member, setMember] = useState<OrgMember | null>(null);
  const [membershipState, setMembershipState] = useState<MembershipState>("resolving");

components/providers/RoleContext.tsx:85-88
  const t = window.setTimeout(() => {
    console.warn("[RoleContext] loading watchdog tripped — force-clearing spinner");
    setLoading(false);
  }, 6000);
```

The provider's own docblock states the intended contract, and it is the contract
the layout breaks — `RoleContext.tsx:34-39`: *"'none' = authenticated but not a
member of any workspace (show the hard-stop screen, never a fake empty Viewer
app); 'error' = the membership lookup itself failed after retries (show retry,
never silently downgrade to Viewer)."* Both named states are handled. The unnamed
third way to get a fake empty Viewer app — never finishing — is not.

**Chain reaction.** Every client-side role gate in the product reads from this
context. During the window, `useRole()` is not merely uninformative, it is
**confidently wrong**: it returns a valid `Role` and a valid `Role[]`, so no
consumer can detect the difference. Any surface that reacts to a role change by
writing — clearing a draft, collapsing a picker, persisting a "last used" view —
does so against the placeholder. The audit-log finding in `admin-and-org`
(`ALOG-*`) and the client-only-gate finding in `document-control` (`DCK-1`) are
the mirror image of this: there, a client gate is trusted too much; here, a client
gate is fed a value that was never true.

**Done when.**

- [x] `ProtectedContent` renders the spinner (or a dedicated "still working this out" state) whenever `uid && membershipState === "resolving"`, regardless of `loading`
- [x] `activeRole` is not a real `Role` until resolution completes — see `SESS-5` *(worked as its own finding: the narrow piece landed there, the type change is split to `SESS-6` per `DEC-31`)*
- [x] a test mounts the provider with a membership query that never resolves, advances timers past 8 seconds, and asserts the admin shell is **not** rendered and no `Viewer` role is published to consumers *(satisfied at equivalent strength in the house test idiom — see the divergence note below)*
- [x] the watchdogs keep force-clearing `loading` — that behaviour is correct and stops the spinner hanging; only the layout's interpretation changes

- **Status:** RESOLVED

**Resolution.** The layout's gating decision was extracted into a pure
function, `resolveProtectedView` (`lib/protectedGate.ts`), and the layout now
routes every render through it. The function handles all four
`MembershipState` values; for a signed-in user, `"app"` is reachable **only**
through `membershipState === "member"` — the state the old ladder fell
through now renders a dedicated still-resolving screen (built under
`SESS-3`). `MembershipState` itself moved to `lib/protectedGate.ts` and
`RoleContext` imports it, so the two cannot drift.
- Commit: `92b69b5`
- Files: `app/(protected)/layout.tsx`, `lib/protectedGate.ts`, `components/providers/RoleContext.tsx`
- Tests: `lib/__tests__/protectedGate.test.ts::"never renders the app while a signed-in user's membership is still resolving (SESS-1)"` — plus an exhaustive case walking all four states proving `"app"` is unreachable except via `"member"`.
- Reproduced: by construction against HEAD before changing anything — `layout.tsx:35-51` branched `loading` → `"none"` → `"error"` → full app with no `"resolving"` case, while `RoleContext.tsx` seeded `activeRole` to `"Viewer"` / `roles` to `[]` and both watchdogs cleared `loading` without touching either. The composed input `{loading: false, uid set, membershipState: "resolving"}` mapped to the full app shell.
- Verified: the new test pins the contract; `npx tsc --noEmit`, `npx eslint`, `npx vitest run` (1360 tests), and `next build` all pass.
- **Divergence from the prescribed test.** The repo's test harness is
  deliberately node-only, scoped to `lib/__tests__` — no jsdom, no
  `@testing-library/react` (`vitest.config.ts` documents this). Mounting the
  provider and advancing timers would have meant introducing a component-test
  stack in the same change as a CRITICAL fix. Instead the decision the test
  needed to observe was made a pure function and pinned exhaustively — the
  same contract, zero new test infrastructure. If a component-level harness
  is ever added, a mount-and-advance-timers test is the first one to write.

**Addendum — adversarial review round (same day, commit `8d167f7`).** Five
independent review lenses were run against the fix diff and two of their
findings landed here:
- *The boot quadrant.* `{loading:false, uid:null, membershipState:"resolving"}`
  still mapped to `"app"` — reachable when the 6 s watchdog clears the
  spinner while `getSession` is still refreshing an expired token, i.e. the
  placeholder shell again, before identity is even known. The provider now
  exposes `booted` (getSession settled, or the boot timeout gave up) and the
  gate keeps the honest spinner until boot has identified someone or
  genuinely settled signed-out. Pinned by two new gate tests.
- *The rescue gap.* `TOKEN_REFRESHED` can be the FIRST event that
  establishes an identity (boot saw no session on a flaky network; the
  auto-refresh ticker succeeds seconds later) — and nothing then scheduled a
  resolve, parking the user on the new resolving screen with nothing in
  flight. Both `TOKEN_REFRESHED` and the same-user `SIGNED_IN` re-emit now
  rescue an unresolved membership, and every resolve runs through one
  generation-guarded `startResolve` so a superseded resolve can no longer
  clobber a newer one's state.

**What this brought to light.**
- The consumer census run for this fix found that `resolveProtectedView`
  deliberately returns `"app"` for a signed-out (`uid === null`) settled
  state — pre-existing behaviour, preserved (behind the new `booted` guard)
  and pinned by a test so the choice is at least explicit. Per-page guards
  and the `SIGNED_OUT` redirect own that case today.
- Four `useRole()` consumers mount **outside** the gate (`OrgBrandingProvider`,
  `SubscriptionProvider`, the notification center's panel, and the layout
  itself) and still observe placeholder role state during resolution. The one
  that *acts* on it was fixed under `SESS-5`; the full inventory is in
  `SESS-6`.
- `roles-and-permissions/WF-5` depends on this fix (noted by the hardening
  pass); the render race is now closed for every client role gate at once.

---

<a id="sess-2"></a>

## SESS-2 · Both spinner watchdogs are shorter than the cold-start budget the same file documents, and shorter than the retry ladder it runs

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:83-90`, `components/providers/RoleContext.tsx:169-178`, `components/providers/RoleContext.tsx:238-241`, `components/providers/RoleContext.tsx:308-322`
- **Re-verified:** hardening pass — **SURVIVES**. Re-confirmed the four values in one file: watchdog `6000` (`:88`), boot timeout `8000` (`:241`), `SIGNED_IN` resolve budget `15000` (`:320`), retry backoff `600 * (i + 1)` (`:176`). The path that runs the same function on the same cold connection gets half the budget the file argues for.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed arithmetically: 6s and 8s are both below the 10s upper bound the file itself documents and below the 15s timeout it sets, and the backoff sleeps alone (600 + 1200 + 1800 = 3.6s) plus three round trips exceed 6s before the ladder can even report failure. Note the sleep also runs after the final attempt, adding 1.8s of pure waste.

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** Three timeouts govern the same operation and they disagree with
each other by a factor of two and a half.

| Path | Budget | Where |
|---|---|---|
| Loading watchdog | **6 s** | `:88` |
| Boot timeout | **8 s** | `:241` |
| `SIGNED_IN` user-switch resolve | **15 s** | `:320` |

The 15-second value carries an explicit justification written into the code
(`:311-314`): *"Bumped from 5s → 15s — Supabase cold-start on the free/shared
tier can spend 5-10s on the first RLS-gated query of a session. The timeout is a
safety net, not a normal-case constraint."*

The boot path runs the **same function**, against the **same cold connection**,
on the **first RLS-gated query of the session** — and gives it 8 seconds, with a
watchdog cutting in at 6. If 5–10 seconds is the honest range, then the boot path
is under-budgeted across most of it.

It is worse than a single comparison suggests, because `resolveOrgAndRole` is not
one query. `attempt()` issues up to three sequential queries (`:136`, `:145`,
`:156`), and the retry loop at `:171-178` runs `attempt()` up to **three times**
with `600 * (i + 1)` ms of backoff between them — 600 ms, then 1200 ms. A boot in
which the first attempt fails once and the second succeeds is, by design, well
past both watchdogs before it can possibly return.

**Failure scenario.** First load of the morning. Supabase cold-starts. The
profile lookup takes 4 seconds; the membership lookup takes another 4. The
watchdog fired at 6, the boot timeout at 8 — the app has been rendering as a
Viewer for 2 seconds and counting by the time the answer arrives. On a day when
the first attempt errors and retries, the window is 6+ seconds long. Nothing
logs it except a `console.warn` nobody is watching.

**Evidence.**

```
components/providers/RoleContext.tsx:171-178
  for (let i = 0; i < 3 && !resolved; i++) {
    try { resolved = await attempt(); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 600 * (i + 1))); }
  }
```

Worst case before `resolved` can be non-null: three full `attempt()` round trips
plus 1800 ms of deliberate sleep. Against a 6-second watchdog.

**Done when.**

- [x] the boot path and the `SIGNED_IN` path use one shared budget constant, justified once
- [x] that budget is at or above the 15 s the file already argues for, since it is a safety net rather than a normal-case constraint
- [x] `SESS-1` is fixed first — with the `resolving` branch in place, a longer budget costs a longer honest spinner instead of a longer wrong render, which is the whole point of doing them in this order *(same commit, layout branch landed before the budget change in the edit sequence)*

- **Status:** RESOLVED

**Resolution.** One constant, `RESOLVE_BUDGET_MS = 15_000`, now governs both
resolve paths through a shared `raceWithBudget` wrapper, with the
justification (cold start range + the retry ladder's own 3.6 s of backoff)
written once above it. The boot path — which previously had **no timeout at
all**, the sharpest fact the independent verifier added — now races the same
budget. On exhaustion, both paths land on `membershipState: "error"` (the
honest retry screen) via a guarded transition that a late-landing resolve
still overwrites with the real answer. The 6 s / 8 s spinner watchdogs are
kept, named (`LOADING_WATCHDOG_MS`, `BOOT_SPINNER_MS`), and re-documented as
deciding only *which waiting screen shows*, never what role renders.
- Commit: `92b69b5`
- Files: `components/providers/RoleContext.tsx`
- Tests: covered by `lib/__tests__/protectedGate.test.ts` for the render half; the budget wiring is a timer race inside a `"use client"` provider — not testable in the node-only harness, verified by tracing both paths and by the ship loop.
- Reproduced: at HEAD before the change, the four disagreeing values were confirmed in one file — watchdog `6000`, boot timeout `8000`, `SIGNED_IN` race `15000`, backoff `600*(i+1)` — and the boot `await resolveOrgAndRole(...)` at the `getSession()` chain had no race around it.
- Verified: `tsc`/`eslint`/`vitest`/`next build` green; behaviour change on timeout is deliberate and documented in-code (previously the `SIGNED_IN` catch "proceeded" — i.e. rendered whatever placeholder was in context; it now fails to the retry screen).

**What this brought to light.**
- The deliberate 1.8 s of backoff sleep *after the final failed attempt*
  (noted by the independent pass) still stands — it delays the error state,
  not a render, and removing it was out of this finding's scope. Worth
  folding into any future touch of the retry ladder.
- The watchdogs are now purely cosmetic state. If a later session ever adds
  a component-test harness, the right regression test is: boot with a hung
  query → "Authenticating…" until 6–8 s → still-resolving screen → error
  screen at 15 s — three honest screens, zero placeholder renders.

---

<a id="sess-3"></a>

## SESS-3 · A resolve that exhausts its retries lands on the error screen, but a resolve that is merely slow lands on a Viewer app — the two failure modes are inverted in severity

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:179-187`, `components/providers/RoleContext.tsx:238-241`, `app/(protected)/layout.tsx:50`
- **Re-verified:** hardening pass — **SURVIVES**. The error path sets `setActiveRole("Viewer")` and `setMembershipState("error")` together (`:184-185`), which is why the placeholder is harmless there and unguarded during `resolving`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the honest failure is handled well and the dishonest one is not handled at all. The two paths differ only in whether the query errored or merely took longer than 6 seconds, and the user-visible outcomes are inverted — the erroring user is reassured, the slow user is silently demoted with no message.

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** When resolution fails outright, the code is careful:
`membershipState` becomes `"error"` (`:185`), the layout shows
`MembershipErrorScreen` (`layout.tsx:50`), and that screen tells the truth in as
many words — *"Your access is unchanged — this is a network hiccup, not a
permissions change"* (`layout.tsx:121-122`).

That is exactly the right message. It is shown only on the path that **fails
loudly**. The path that fails quietly — the resolve that is still running when a
watchdog gives up on it — produces a strictly worse user experience (a plausible,
silent, wrong answer) and gets no message at all, because it never reaches a
terminal state.

So the system communicates well about its rarer, less confusing failure and says
nothing about its more common, more confusing one.

**Failure scenario.** Two users on the same flaky connection. One's query errors
three times and they are told, correctly, that their access is unchanged and to
retry. The other's query is merely slow; they get a Viewer app, no message, and a
reasonable belief that an admin changed their role. The second user is you.

**Evidence.**

```
components/providers/RoleContext.tsx:179-187
  if (!resolved) {
    console.warn("[RoleContext] membership resolution failed after retries", lastErr);
    setMember(null); setRoles([]); setActiveRole("Viewer");
    setMembershipState("error");
    return;
  }
```

Note `setActiveRole("Viewer")` on the error path at `:184`. It is harmless there
only because `membershipState` is simultaneously set to `"error"` and the layout
intercepts it before any consumer renders. The same assignment is unguarded
during `"resolving"`, where nothing intercepts.

**Done when.**

- [x] the `resolving`-past-budget state reaches a screen that says what the error screen says — access unchanged, still loading, retry available
- [x] `console.warn` at `:86` and `:181` is joined by something the user can see; a warning in a console nobody has open is not a signal

- **Status:** RESOLVED

**Resolution.** The slow path now has its own screen —
`ResolvingMembershipScreen` in `app/(protected)/layout.tsx` — shown whenever
a signed-in user's resolution outlives the spinner watchdogs. It says
exactly what the error screen says ("Your access is unchanged; this is a
delay, not a permissions change"), keeps a spinner, and offers Reload. The
screens themselves are now the user-visible signal on every failure shape:
slow → still-resolving screen, budget-exhausted or failed → retry screen.
The `console.warn`s remain for diagnostics.
- Commit: `92b69b5`
- Files: `app/(protected)/layout.tsx`
- Tests: `lib/__tests__/protectedGate.test.ts` pins that the `"resolving"` state reaches its own view rather than `"app"`; the screen's copy was written to mirror `MembershipErrorScreen`'s.
- Reproduced: at HEAD before the change the error path set `"error"` + rendered the truth-telling screen while the slow path never reached any terminal state and fell through to the full app — the inversion exactly as written.
- Verified: ship loop green; both failure shapes traced end-to-end after the change.

**What this brought to light.**
- The two-users-one-connection framing in the finding is now symmetrical:
  the erroring user and the slow user both get "access unchanged" language.
  The *third* user — one whose resolve hangs forever — previously got the
  Viewer app indefinitely (no boot timeout, per `SESS-2`); they now get the
  still-resolving screen, then the retry screen at 15 s.

---

<a id="sess-4"></a>

## SESS-4 · The Microsoft path pays the cold-start twice and starts it later, which is why the symptom clusters on SSO sign-ins

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/page.tsx:72-86`, `app/page.tsx:147-150`, `app/page.tsx:156-159`, `app/page.tsx:177`, `components/providers/RoleContext.tsx:244-254`
- **Re-verified:** hardening pass — **SURVIVES**. Two membership round trips per sign-in — `app/page.tsx:72-78` then `RoleContext.tsx:145-150` — and on the SSO path both land on a session one request old.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The duplicate lookup is real and the added latency of the silent-redirect round trip is real. One caveat that weakens the "clusters on SSO" framing: the double query is path-independent — an email/password sign-in also runs routeAuthedUser's query and then RoleProvider's, and line 81 is a client-side `router.replace`, so RoleProvider mounts in the same document on an already-warmed connection either way. Kept at MEDIUM as an explanatory finding rather than an independent defect.

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** The login page runs its own membership query before routing —
`org_members` filtered by `uid` and `status`, `limit(1).maybeSingle()`
(`app/page.tsx:72-78`) — purely to decide between `/dashboard` and the
no-workspace screen. It then calls `router.replace("/dashboard")` (`:81`), which
mounts `RoleProvider`, which runs `getSession()` and `resolveOrgAndRole` — issuing
**the same membership query again** (`RoleContext.tsx:145-150`).

On the password path this usually costs little: the session is often already
warm, and `routeAuthedUser` is invoked from an in-page `SIGNED_IN` callback
(`app/page.tsx:177`).

On the Microsoft path the shape is different in three ways that all push the same
direction:

1. It is a **full redirect round trip**. The return lands on a fresh document
   load (`:125` detects `code=` / `access_token`), so nothing is warm.
2. The silent-SSO attempt (`:156-159`) means a device that has used Microsoft
   before begins with an *additional* redirect out to Microsoft and back before
   any query runs at all.
3. The first RLS-gated query of that brand-new session is therefore the login
   page's membership lookup, and the second — `RoleContext`'s — starts only after
   a Next.js client-side navigation has completed.

The 6-second watchdog starts counting from `RoleProvider` mount, which on this
path is the *latest* it ever starts relative to the connection being cold.

**Failure scenario.** You open the app; the device prefers Microsoft; a silent
sign-in redirects out and back; the login page's query cold-starts; you are routed
to `/dashboard`; `RoleProvider` mounts and re-issues the query on a connection
that has served exactly one request. Six seconds later the watchdog clears the
spinner and you are looking at a Viewer dashboard. Your reasonable conclusion —
*"this happens when I use the Microsoft login"* — is correct about the
correlation and understandably wrong about the cause.

**Evidence.**

```
app/page.tsx:72-78                       ← query #1
  const { data: membership } = await supabase
    .from("org_members").select("org_id")
    .eq("uid", uid).eq("status", "active").limit(1).maybeSingle();

components/providers/RoleContext.tsx:145-150   ← query #2, same session, same facts
  const { data, error } = await supabase
    .from("org_members").select("*")
    .eq("org_id", orgId).eq("uid", userId).maybeSingle();
```

**Done when.**

- [x] the login page's routing decision and the provider's resolution share one result rather than issuing two round trips — pass the resolved membership through, or let the provider own the decision and have the login page route unconditionally
- [x] `SESS-1` is fixed regardless; deduplicating the query shortens the window but does not close it

- **Status:** RESOLVED

**Resolution.** The second option from the Done-when was taken: the provider
owns the decision. `routeAuthedUser` no longer queries `org_members` at all —
it records the Microsoft preference, ensures the profile row exists, and
routes to `/dashboard` unconditionally. RoleProvider resolves membership
once, with its retry ladder, and the protected layout's screens handle every
outcome — including the no-membership hard stop that the login page used to
render from its own (error-discarding) copy of the query. The page's
duplicate "no-workspace" view was removed with it; `NotAMemberScreen` is now
the single no-membership surface. This also resolves `ORGSEL-2`'s mechanism
at the root — same change, recorded there too.
- Commit: `c111433`
- Files: `app/page.tsx`
- Tests: not unit-testable in the node-only harness (a client page's routing flow); verified by tracing all sign-in shapes — password, Microsoft redirect return, silent SSO — against the new code, and by `next build`.
- Reproduced: at HEAD before the change, `app/page.tsx:72-78` ran the same `org_members` query `RoleContext.tsx` runs moments later, on a session one request old on the SSO path.
- Verified: ship loop green. The SSO path now issues **zero** membership queries before `RoleProvider` mounts — the provider's query is the first and only one, and it starts earlier relative to the redirect landing.

**What this brought to light.**
- The independent verifier's caveat (the double query was path-independent —
  password sign-ins paid it too) is confirmed by the shape of the fix:
  removing it helps every path, SSO most because its connection is coldest.
- The removed no-workspace view had subtly different copy from
  `NotAMemberScreen` (it assumed Microsoft; the layout's screen explains the
  personal-vs-work account confusion properly). One surface, one message now.
- The login page still `await`s the profile upsert before routing — kept
  deliberately: it is what lets an admin attach a memberless account by
  email while that person is stuck on the hard-stop screen.

---

<a id="sess-5"></a>

## SESS-5 · `activeRole` has no "unknown" value, so a placeholder is indistinguishable from a real answer at every consumer

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:65-66`, `components/providers/RoleContext.tsx:19-40`, `components/providers/RoleContext.tsx:363-378`
- **Re-verified:** hardening pass — **SURVIVES**. `useState<Role>("Viewer")` and `useState<Role[]>([])` (`:65-66`) are both legitimate member values, so the context cannot express "not known yet" through the two fields consumers actually read.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the placeholder "Viewer" is type-identical to a resolved "Viewer", so no consumer of useRole() can distinguish "not yet known" from "genuinely a Viewer" without also reading membershipState — which, per the grep in SESS-1, exactly one file in the repo does.

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** `activeRole` is typed `Role` and seeded `"Viewer"`; `roles` is
typed `Role[]` and seeded `[]`. Both are legitimate values that a real member
could hold. The context value published at `:363-377` therefore cannot express
"I do not know yet" through the two fields that consumers actually read — only
through `membershipState`, which is a separate field that every consumer must
remember to check independently.

`membershipState` exists and is correct. But it is opt-in: a component that reads
`const { activeRole } = useRole()` — the overwhelmingly common form across the
admin pages listed in this repo — gets a confident wrong answer with no type-level
prompt to check anything else. `SESS-1` is the layout forgetting; this is the
design that makes forgetting easy and silent.

**Failure scenario.** Any new surface written against `useRole()` inherits the
defect without its author doing anything wrong. It reads `activeRole`, sees
`"Viewer"`, hides its admin affordance, and is bug-compatible with the rest of the
app.

**Evidence.**

```
components/providers/RoleContext.tsx:65-66
  const [activeRole, setActiveRole] = useState<Role>("Viewer");
  const [roles, setRoles] = useState<Role[]>([]);
```

Contrast `MembershipState` two lines up (`:17`), which models the same uncertainty
correctly: `"resolving" | "member" | "none" | "error"`. The right pattern is
already in the file, applied to the adjacent field.

**Done when.**

- [ ] `activeRole` is `Role | null` (or the context exposes a discriminated union where the role is only present in the resolved case), so an unchecked read fails to compile rather than reading `"Viewer"` → **split to `SESS-6` per `DEC-31`** (measured blast radius: 11 consumer files break, two with runtime crashes — above the five-file scope rule)
- [x] `hasRole` / `hasAnyRole` return `false` during `resolving` **and** callers can tell that apart from a genuine `false` — `membershipState` is the discriminator, now stated in the context's own docblock rather than left for each consumer to discover
- [x] the change is made after `SESS-1`, since fixing the layout removes the only path on which consumers currently observe the placeholder

- **Status:** RESOLVED

**Resolution.** Scoped under `DEC-31` — the type-level change measured out at
11 breaking consumer files (census by a dedicated agent over all 79
`useRole()` consumers), which exceeds the five-file scope rule, so the work
was split: this finding carries the narrow piece, `SESS-6` (new, below)
carries the type migration with the full file inventory.

The narrow piece shipped here is the one place the placeholder still *did*
something after `SESS-1`: the census found `useTicketNotifications` is
mounted pre-gate by the notification center's always-rendered panel, and
during resolution it ran role-scoped ticket fetches under the
least-privileged branch **and a mark-as-read reconciliation write** with
placeholder role state, then refetched everything when the real roles
landed. It now waits for `membershipState === "member"` before doing any of
that. The `RoleContextValue` docblock also now states the placeholder
contract explicitly on both `activeRole` and `roles`.
- Commit: `c111433`
- Files: `hooks/useTicketNotifications.ts`, `components/providers/RoleContext.tsx`
- Tests: the gating contract of the layout is pinned by `protectedGate.test.ts`; the hook's wait-for-member branch is a client-hook behaviour outside the node-only harness — verified by trace (the effect's early-return now includes `membershipState !== 'member'`, and its dependency array includes `membershipState` so resolution re-fires it).
- Reproduced: confirmed pre-fix that `NotificationCenterProvider` renders `CenterPanel` unconditionally (even closed) above the layout gate, so the hook's fetch + `markManyRead` ran with `roles: []` while resolution was in flight.
- Verified: ship loop green; post-gate consumers of the same hook (sidebar, bell, inbox) render only when the layout has admitted the app, i.e. when `membershipState === "member"` — so the added condition changes nothing for them.

**What this brought to light.**
- The census found ~41 of the 79 consumers already null-guard or
  `===`-compare safely, and several admin pages (`admin/scope`,
  `admin/audit`, `admin/holds`) already treat `activeRole` as possibly
  falsy — evidence of a half-finished `Role | null` convention that
  `SESS-6` would complete.
- Two consumers would crash at runtime on a null role
  (`requests/page.tsx` and `documents/[libraryId]/page.tsx`, both
  `activeRole.includes('Engineer')`) — exactly the kind of latent assumption
  the type change exists to surface. They are listed in `SESS-6`.

---

<a id="sess-6"></a>

## SESS-6 · `activeRole: Role` → `Role | null` type migration — the remainder of `SESS-5`, split out under DEC-31

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (blast radius measured against HEAD by a dedicated consumer census, 2026-08-23)
- **Locations:** `components/providers/RoleContext.tsx:79-92`, `app/(protected)/requests/page.tsx:349`, `app/(protected)/documents/[libraryId]/page.tsx:4013`

**Mechanism.** `SESS-5` resolved the behavioural half: after `SESS-1` no
gated surface renders during resolution, and the one pre-gate actor now
waits for `membershipState === "member"`. What remains is the compile-time
guarantee — `activeRole` is still typed `Role` and seeded `"Viewer"`, so a
*future* pre-gate consumer inherits the defect silently, which is the
finding's original point.

**Failure scenario.** A new provider or always-mounted panel reads
`activeRole` without checking `membershipState`, sees `"Viewer"`, and acts
on it — nothing in the type system objects. The eleven files below are the
measured set that fail to compile under `Role | null`, i.e. the true
worklist for the migration:

`app/(protected)/documents/page.tsx`,
`app/(protected)/documents/[libraryId]/page.tsx`,
`app/(protected)/requests/page.tsx`, `app/(protected)/requests/[id]/page.tsx`,
`app/(protected)/projects/page.tsx`, `app/(protected)/projects/[id]/page.tsx`,
`app/(protected)/admin/billing/page.tsx`,
`app/(protected)/admin/data-export/page.tsx`,
`app/(protected)/admin/assets/page.tsx`, `app/(protected)/admin/users/page.tsx`,
`components/viewers/SecureDocViewer.tsx`

Two of these carry latent **runtime** crashes on a null-ish role
(`activeRole.includes('Engineer')` at `requests/page.tsx:349` and
`documents/[libraryId]/page.tsx:4013`) and should be converted first.

**Remediation (illustrative).** Change the context to
`activeRole: Role | null` (null until `membershipState === "member"`),
convert the eleven files — most need a `?? ""`-free explicit null branch
that renders the least-privileged state — and keep `hasRole`/`hasAnyRole`
semantics unchanged. Ship as its own change with nothing else in it; the
sequencing note from `99-fix-sequencing.md` still applies (nothing observes
the placeholder today, so this is defence against the next surface, not a
live bug).

**Done when.**

- [ ] `useRole().activeRole` is `Role | null` and an unchecked `Role`-typed use fails `tsc`
- [ ] the two `.includes('Engineer')` sites null-guard (or use `hasAnyRole`)
- [ ] all eleven files compile with an explicit null branch, and no consumer converts null back into a fake `"Viewer"`
- [ ] `roles-and-permissions`' role-gate findings are cross-checked afterwards — several of its client-gate citations name these same files

---
