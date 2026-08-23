# 03 · Which workspace, which role

**4 findings** — 2 HIGH · 2 MEDIUM.

Once the app knows who you are, two more choices remain: which workspace to open
you into, and which roles to credit you with. Both have a path that picks
arbitrarily.

### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The dedicated role editor writes the whole collection and derives the headline from it | `app/(protected)/admin/users/page.tsx:133-137` | `update({ roles: cleaned, role: headline })` is the correct shape: the additive collection is authoritative, the single `role` column is a mirror kept for the RLS policies that read it. `ORGSEL-3` is that a *second* write path does not follow this rule — not that the model is wrong. |
| The additive role model itself, and its stated reason for mirroring `role` | `lib/roleCapabilities.ts:1-15,70-79` | Explicitly designed so one person can hold several hats and the union of capabilities applies — *"their effective permissions are the UNION of what each role grants"*. This is the mechanism behind being both the drafting manager and the QA/QC, and it is sound. |
| `normalizeRoles` tolerates the pre-migration single-`role` shape | `lib/roleCapabilities.ts:125-137` | A row written before the `roles` column existed still resolves correctly, because `push(legacyRole)` folds the headline back in. Migration safety that is easy to break later — keep it. |
| The self-heal branch exists at all | `components/providers/RoleContext.tsx:152-165` | Its purpose is right and stated: a stale device workspace, revoked access or a fresh phone should not be a dead end. `ORGSEL-1` is about how it *chooses*, not about whether it should exist. |

---

<a id="orgsel-1"></a>

## ORGSEL-1 · The workspace self-heal takes the first row of an unordered query, so a member of more than one org lands in an arbitrary one — and can land in a different one on each sign-in

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:152-165`, `components/providers/RoleContext.tsx:189-215`

**Mechanism.** When the candidate workspace yields no active membership, the
resolver falls back to "their first active membership anywhere":

```ts
const { data, error } = await supabase
  .from("org_members").select("*")
  .eq("uid", userId).eq("status", "active")
  .limit(1).maybeSingle();
```

There is **no `ORDER BY`**. `LIMIT 1` without an ordering does not mean "the
oldest" or "the primary" — it means whichever row the executor reaches first,
which is a function of the plan, the index chosen, and where the row physically
sits in the heap. An `UPDATE` to an unrelated column can move a row and change
the answer. Two migrations add indexes over exactly these columns
(`20260630_perf_indexes.sql:21-22`, `20260701_perf_indexes.sql:15-16`), so a plan
flip between an index scan and a sequential scan is not hypothetical — it is what
those indexes are for.

Whatever row comes back becomes both the workspace and the role: `:189-190` sets
`activeOrgId` from `mem.org_id`, `:200-213` derives the role collection and
headline from that same row, and `:215` **persists the choice** —
`void persistOrgId(orgId, userId)` writes it to `localStorage` and to
`users.default_org_id`. So an arbitrary pick is not transient; it becomes the new
default and the next session inherits it.

`limit(1)` also means `maybeSingle()` can never see the collision, so nothing
anywhere notices that a choice was made among several.

**Failure scenario.** You hold Admin in your own workspace and Viewer in a
customer's or a demo workspace. Your device's stored workspace key is stale or
belongs to your other identity (`IDENT-4`), so step 2 finds nothing and the
self-heal runs. It returns the Viewer membership. You are now signed into that
workspace as a Viewer, it has been written to `users.default_org_id`, and the
workspace switcher is the only way back — if the current role can even see it.
Because the ordering can differ between runs, doing exactly the same thing an
hour later may put you somewhere else, which is precisely the "random" quality
you are describing.

**Evidence.**

```
components/providers/RoleContext.tsx:155-165
  if (!mem || mem.status !== "active") {
    const { data, error } = await supabase
      .from("org_members").select("*")
      .eq("uid", userId).eq("status", "active")
      .limit(1).maybeSingle();          ← no .order()
    if (error) throw new Error(error.message);
    if (data) { mem = data as Record<string, unknown>; orgId = mem.org_id as string; }
  }

components/providers/RoleContext.tsx:215
  if (active) void persistOrgId(orgId, userId);   ← the arbitrary pick becomes the default
```

**Chain reaction.** This composes badly with `SESS-1`. If the self-heal is still
running when a watchdog clears the spinner, you get the Viewer window; when it
lands, you may *also* be moved to a different workspace. From the outside those
are one event — "it randomly logged me in as a viewer" — with two independent
causes, which is why it will not reproduce reliably against either fix alone.

**Done when.**

- [ ] the fallback query is deterministically ordered — a documented rule such as `ORDER BY` the member's highest-ranked role, then `created_at`, so the most capable membership wins rather than an accident of storage
- [ ] the query selects more than one row so the code can tell a single membership from a choice among several
- [ ] a choice among several is **not** silently persisted to `users.default_org_id`; either ask, or persist only when there was exactly one candidate
- [ ] a test seeds one `uid` with an Admin membership and a Viewer membership and asserts the same workspace is chosen across repeated resolutions

---

<a id="orgsel-2"></a>

## ORGSEL-2 · The login page makes the same unordered pick a second time, so the routing decision and the resolver's decision can disagree

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/page.tsx:72-86`, `components/providers/RoleContext.tsx:155-165`

**Mechanism.** `routeAuthedUser` runs its own copy of the same query — same
table, same filters, same `limit(1)`, same absent ordering:

```ts
const { data: membership } = await supabase
  .from("org_members").select("org_id")
  .eq("uid", uid).eq("status", "active").limit(1).maybeSingle();
if (membership?.org_id) router.replace("/dashboard"); else setView("no-workspace");
```

It only uses the result as a boolean, which is why the arbitrariness is less
damaging here than in `ORGSEL-1`. But it is a **second, independent** unordered
pick against the same rows, moments apart, and the two are not required to agree.
It also discards its `error` (`:72` destructures only `data`), so a failed lookup
is rendered as "no workspace" — the hard-stop screen — for someone who has one.
That is the same fail-toward-less-access shape as `SESS-3`, on a screen that tells
the user their account was never admitted.

**Failure scenario.** A transient error on this query sends an Admin to
`NotAMemberScreen`, which tells them no workspace has admitted this account and
offers "Sign out & switch account" — advice that, if followed, clears the very
state that would have recovered them.

**Evidence.**

```
app/page.tsx:72-78
  const { data: membership } = await supabase        ← `error` discarded
    .from("org_members").select("org_id")
    .eq("uid", uid).eq("status", "active").limit(1).maybeSingle();
```

Contrast `RoleContext.tsx:148,160`, which throws on `error` specifically so the
retry loop can tell the two apart. The provider learned this lesson; the login
page did not.

**Done when.**

- [ ] the login page distinguishes "lookup failed" from "no membership" and retries rather than showing the hard stop
- [ ] the routing decision and the provider's resolution derive from one query — see `SESS-4`, which wants the same deduplication for a different reason

---

<a id="orgsel-3"></a>

## ORGSEL-3 · Re-adding an existing member through "Add member" overwrites their additive role collection with a single role, silently deleting every other hat they hold

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/create-user/route.ts:127-135`, `app/(protected)/admin/users/page.tsx:133-137`, `lib/roleCapabilities.ts:1-15`

**Mechanism.** The route documents that "Add member" doubles as a role change on
the re-add path (`:118-122`), and implements it as:

```ts
.from("org_members")
.update({ role, roles: [role], status: "active", display_name: displayName ?? null })
```

`roles: [role]` is an **assignment, not a merge**. A member holding
`["DraftingSupervisor", "DocCtrl"]` who is re-added as `DocCtrl` comes out
holding `["DocCtrl"]`. The union of capabilities that
`lib/roleCapabilities.ts:76-83` computes is now over a smaller set, so
`assign_drafters` and `route_requests` — the capabilities that only
`DraftingSupervisor` grants (`:52`) — are gone. `primaryRole` recomputes a lower
headline, which is mirrored into `org_members.role`, which is the column the RLS
policies read (`supabase/schema.sql:1044,1052`). So the loss reaches the database
boundary, not just the UI.

Nothing warns. The guard immediately above it (`:123-125`) protects an existing
**Admin** from being altered by a non-Admin, and protects nothing else — a
DraftingSupervisor + DocCtrl stack has no equivalent protection, and the
same-role re-add that causes the loss does not look like a demotion to the code.

The dedicated role editor at `admin/users/page.tsx:133-137` does this correctly,
writing the full cleaned collection. Two write paths, one rule, one of them
following it.

**Failure scenario.** This is the configuration you described — one person
holding both the drafting-manager hat and the QA/QC hat, which the additive model
exists to support. An admin uses "Add member" to correct a display name or
reactivate a suspended account, picks the role they think of that person by, and
the second hat is deleted. The next drafting request routes past them because
`route_requests` no longer resolves to anyone. Nothing in the UI says a role was
removed; the member list simply shows one role where there were two.

**Evidence.**

```
app/api/admin/create-user/route.ts:130
  .update({ role, roles: [role], status: "active", display_name: displayName ?? null })

app/(protected)/admin/users/page.tsx:137          ← the correct path, same table
  .update({ roles: cleaned, role: headline })
```

**Chain reaction.** The independence rules in the drafting flow depend on who
holds which hat (`DEC-37` — *one person, many hats; independence is per-slot*).
Silently shrinking a collection changes who may sign what, and because `role` is
mirrored for RLS, it changes it at the database. A signature slot that was
satisfiable yesterday is not today, with no record of the change beyond whatever
the audit log captured of a "re-add".

**Done when.**

- [ ] the re-add path **merges** into the existing collection, or refuses and directs the caller to the role editor
- [ ] any write that shrinks a member's collection is explicit, confirmed, and written to the audit log as a role removal
- [ ] `:161`'s follow-up `update({ roles: [role] })` on the insert path is checked against the same rule — it is correct for a genuinely new member and wrong if it can ever reach an existing one
- [ ] a test gives a member two roles, re-adds them with one, and asserts both survive

---

<a id="orgsel-4"></a>

## ORGSEL-4 · A relocation to a different workspace is indistinguishable from a normal sign-in — nothing tells the user their workspace changed

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:152-165`, `components/providers/RoleContext.tsx:189-195`, `components/providers/RoleContext.tsx:215`

**Mechanism.** The self-heal changes `activeOrgId` (`:190`), rewrites
`localStorage` (`:193`) and upserts `users.default_org_id` (`:215`) without
emitting anything a person or a log could observe. The comment at `:152-154`
frames it as recovering from *"stale device workspace, revoked access, fresh
phone"* — all cases where a silent recovery is the right call, because the
previous workspace is genuinely unavailable.

The same branch also fires when the previous workspace is perfectly available and
the *identity* is the thing that changed (`IDENT-4`), and in that case a silent
relocation is the wrong call: the user has not lost access to anything, they are
simply being moved somewhere else without being told.

There is no server-side record either. This is a client-side state change; it
produces no row in the audit log, so a later question of the form "why was this
person in that workspace on Tuesday" has no answer.

**Failure scenario.** You report that the app "logged me into the wrong place as a
viewer". There is nothing to look at: no audit row, no error, and
`users.default_org_id` now reads as though you chose it. The only trace is a
`console.warn` on a different code path.

**Evidence.**

```
components/providers/RoleContext.tsx:189-195
  const { orgId, mem } = resolved;
  _setActiveOrgId(orgId);
  if (orgId) { try { … localStorage.setItem(LS_ORG_KEY, orgId); } catch {} }
```

No toast, no audit write, no comparison against the candidate the resolution
started from.

**Done when.**

- [ ] when the resolved workspace differs from the candidate the resolution started with, the user is told which workspace they are in and offered the switcher
- [ ] the relocation is recorded — at minimum client-side telemetry, ideally an audit row — so the question can be answered afterwards
- [ ] the silent path is kept for the cases it was written for: no candidate at all, or a candidate whose membership is genuinely gone

---
