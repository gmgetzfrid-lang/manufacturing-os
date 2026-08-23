# 01 · The Viewer window

**5 findings** — 1 CRITICAL · 2 HIGH · 2 MEDIUM.

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
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/layout.tsx:35-51`, `components/providers/RoleContext.tsx:65-68`, `components/providers/RoleContext.tsx:83-90`, `components/providers/RoleContext.tsx:238-241`
- **Re-verified:** hardening pass — **SURVIVES** — **but see the independence caveat.** Re-checked against source: `layout.tsx:35-51` branches on `loading`, then `"none"`, then `"error"`, then renders; there is no `"resolving"` branch. `RoleContext.tsx:65` seeds `activeRole` to `"Viewer"` and `:88`/`:241` clear `loading` on timers without touching `membershipState`. **This area was written by the same session that is verifying it**, so this is a re-read rather than an independent challenge — the weakest verification in the corpus. Treat it as `author`-grade until someone else reads it. `roles-and-permissions/WF-5` was found to depend on it during this pass, which is corroboration from a different direction.

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

- [ ] `ProtectedContent` renders the spinner (or a dedicated "still working this out" state) whenever `uid && membershipState === "resolving"`, regardless of `loading`
- [ ] `activeRole` is not a real `Role` until resolution completes — see `SESS-5`
- [ ] a test mounts the provider with a membership query that never resolves, advances timers past 8 seconds, and asserts the admin shell is **not** rendered and no `Viewer` role is published to consumers
- [ ] the watchdogs keep force-clearing `loading` — that behaviour is correct and stops the spinner hanging; only the layout's interpretation changes

---

<a id="sess-2"></a>

## SESS-2 · Both spinner watchdogs are shorter than the cold-start budget the same file documents, and shorter than the retry ladder it runs

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:83-90`, `components/providers/RoleContext.tsx:169-178`, `components/providers/RoleContext.tsx:238-241`, `components/providers/RoleContext.tsx:308-322`
- **Re-verified:** hardening pass — **SURVIVES**. Re-confirmed the four values in one file: watchdog `6000` (`:88`), boot timeout `8000` (`:241`), `SIGNED_IN` resolve budget `15000` (`:320`), retry backoff `600 * (i + 1)` (`:176`). The path that runs the same function on the same cold connection gets half the budget the file argues for.

**Independence caveat.** This area was written and verified by the same session, so this is a re-read rather than an independent challenge — the weakest grade in the corpus. Treat as `author`-grade until someone else reads it (`DEC-41`).

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

- [ ] the boot path and the `SIGNED_IN` path use one shared budget constant, justified once
- [ ] that budget is at or above the 15 s the file already argues for, since it is a safety net rather than a normal-case constraint
- [ ] `SESS-1` is fixed first — with the `resolving` branch in place, a longer budget costs a longer honest spinner instead of a longer wrong render, which is the whole point of doing them in this order

---

<a id="sess-3"></a>

## SESS-3 · A resolve that exhausts its retries lands on the error screen, but a resolve that is merely slow lands on a Viewer app — the two failure modes are inverted in severity

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:179-187`, `components/providers/RoleContext.tsx:238-241`, `app/(protected)/layout.tsx:50`
- **Re-verified:** hardening pass — **SURVIVES**. The error path sets `setActiveRole("Viewer")` and `setMembershipState("error")` together (`:184-185`), which is why the placeholder is harmless there and unguarded during `resolving`.

**Independence caveat.** This area was written and verified by the same session, so this is a re-read rather than an independent challenge — the weakest grade in the corpus. Treat as `author`-grade until someone else reads it (`DEC-41`).

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

- [ ] the `resolving`-past-budget state reaches a screen that says what the error screen says — access unchanged, still loading, retry available
- [ ] `console.warn` at `:86` and `:181` is joined by something the user can see; a warning in a console nobody has open is not a signal

---

<a id="sess-4"></a>

## SESS-4 · The Microsoft path pays the cold-start twice and starts it later, which is why the symptom clusters on SSO sign-ins

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/page.tsx:72-86`, `app/page.tsx:147-150`, `app/page.tsx:156-159`, `app/page.tsx:177`, `components/providers/RoleContext.tsx:244-254`
- **Re-verified:** hardening pass — **SURVIVES**. Two membership round trips per sign-in — `app/page.tsx:72-78` then `RoleContext.tsx:145-150` — and on the SSO path both land on a session one request old.

**Independence caveat.** This area was written and verified by the same session, so this is a re-read rather than an independent challenge — the weakest grade in the corpus. Treat as `author`-grade until someone else reads it (`DEC-41`).

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

- [ ] the login page's routing decision and the provider's resolution share one result rather than issuing two round trips — pass the resolved membership through, or let the provider own the decision and have the login page route unconditionally
- [ ] `SESS-1` is fixed regardless; deduplicating the query shortens the window but does not close it

---

<a id="sess-5"></a>

## SESS-5 · `activeRole` has no "unknown" value, so a placeholder is indistinguishable from a real answer at every consumer

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:65-66`, `components/providers/RoleContext.tsx:19-40`, `components/providers/RoleContext.tsx:363-378`
- **Re-verified:** hardening pass — **SURVIVES**. `useState<Role>("Viewer")` and `useState<Role[]>([])` (`:65-66`) are both legitimate member values, so the context cannot express "not known yet" through the two fields consumers actually read.

**Independence caveat.** This area was written and verified by the same session, so this is a re-read rather than an independent challenge — the weakest grade in the corpus. Treat as `author`-grade until someone else reads it (`DEC-41`).

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

- [ ] `activeRole` is `Role | null` (or the context exposes a discriminated union where the role is only present in the resolved case), so an unchecked read fails to compile rather than reading `"Viewer"`
- [ ] `hasRole` / `hasAnyRole` return `false` during `resolving` **and** callers can tell that apart from a genuine `false` — today both are `false` for opposite reasons
- [ ] the change is made after `SESS-1`, since fixing the layout removes the only path on which consumers currently observe the placeholder

---
